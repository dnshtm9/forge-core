// The forge's in-memory store: users, repositories, git objects and refs, issues, comments, labels
// and pull requests. Every surface (git smart HTTP, REST v3, GraphQL v4, MCP) reads and writes this
// one state, so an object created over MCP reads back over REST and a branch pushed over git is a
// branch the REST commits route lists. All timestamps derive from the trial's fixed clock.

import { createHash } from 'node:crypto';
import { buildTree, hashObject, parseCommit, parseTree, type GitObject, type GitObjectType, type TreeEntry } from './git-objects.ts';
import { buildScenario, type Scenario, type ScenarioUser } from './scenario.ts';

void buildTree;
void createHash;

export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export interface Branch {
  readonly name: string;
  oid: string;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  privateFlag: boolean;
  defaultBranch: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  head: string;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  readonly labels: Map<string, Label>;
  readonly comments: Map<number, Comment>;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  /** Per-repo monotonic counter for deterministic request ids. */
  requestCounter: number;
  /** The issue numbers, in creation order (the GraphQL cursor order). */
  readonly issueOrder: number[];
  readonly pullOrder: number[];
  /** Pre-serialized `GET /issues/{n}` HTTP replies, keyed by issue number; invalidated on write. */
  readonly issueReplyCache: Map<number, Buffer>;
  /** Prebuilt depth-1 shallow packs keyed by `tipOid`; invalidated when the ref moves. */
  readonly shallowPackCache: Map<string, Buffer>;
  /** The ref tip the shallow pack cache was built from (one entry: the default branch's tip). */
  shallowPackTip: string | null;
  /** Prebuilt git advertisement / ls-refs response buffers, keyed by route; cleared on ref moves. */
  readonly advertCache: Map<string, Buffer>;
  readonly lsRefsCache: Map<string, Buffer>;
}

/** Clear every git-surface cache a ref move invalidates. */
export function clearGitCaches(repo: Repo): void {
  repo.shallowPackCache.clear();
  repo.shallowPackTip = null;
  repo.advertCache.clear();
  repo.lsRefsCache.clear();
}

/**
 * The read benchmark's zero-parse cache: a complete HTTP reply per raw request target
 * (`/api/v3/repos/{o}/{r}/issues/{n}`), cleared whenever anything in the forge mutates.
 */
export class FastGetCache {
  readonly map = new Map<string, Buffer>();

  get(target: string): Buffer | undefined {
    return this.map.get(target);
  }

  set(target: string, buffer: Buffer): void {
    this.map.set(target, buffer);
  }

  clear(): void {
    if (this.map.size > 0) this.map.clear();
  }
}

export interface Label {
  readonly id: number;
  readonly name: string;
  color: string;
}

export interface Comment {
  readonly id: number;
  readonly issueNumber: number;
  body: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly user: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  /** The id of the repository the issue belongs to (the global id encodes it). */
  readonly repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly labels: string[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly user: string;
  readonly isPull: boolean;
  /** The pull request number when `isPull` (GitHub models a PR as an issue with the same number). */
  readonly pullNumber: number | null;
}

export interface PullFile {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly sha: string;
  readonly blobOid: string;
  readonly previousBlobOid: string | null;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  /** The id of the repository the pull belongs to. */
  readonly repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly head: string;
  readonly base: string;
  headSha: string;
  baseSha: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly user: string;
  readonly files: PullFile[];
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /** The issue record sharing this PR's number (GitHub models PRs as issues). */
  issue: Issue;
}

export interface FixedClock {
  /** Seconds since the epoch, fixed for the trial. */
  nowSec(): number;
  iso(): string;
}

/** The trial's fixed clock: MAKEFUN_TRIAL_NOW when set, else a constant just after the scenario's epoch. */
export function fixedClockOf(env: Readonly<Record<string, string | undefined>>): FixedClock {
  const raw = env.MAKEFUN_TRIAL_NOW ?? '';
  let epochMs = 1_767_139_200_000; // 2026-01-01T00:00:00Z, a fixed fallback
  if (raw !== '') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) epochMs = parsed;
  }
  const iso = new Date(epochMs).toISOString();
  return {
    nowSec: () => Math.floor(epochMs / 1000),
    iso: () => iso,
  };
}

export interface AuthContext {
  /** The login the trial's bearer token names (the scenario's viewer). */
  readonly viewerLogin: string;
  readonly token: string;
}

/** The one store: built fresh per trial, holding everything the four surfaces share. */
export class Forge {
  readonly users = new Map<string, User>();
  readonly repos = new Map<string, Repo>();
  readonly clock: FixedClock;
  readonly viewerLogin: string;
  /** The zero-parse GET cache: complete HTTP replies per raw request target. */
  readonly fastGetCache = new FastGetCache();
  nextUserId: number;
  nextRepoId: number;
  nextLabelId: number;
  requestCounter = 0;
  private readonly scenario: Scenario;

  constructor(clock: FixedClock, viewerLogin: string) {
    this.clock = clock;
    this.viewerLogin = viewerLogin;
    this.scenario = buildScenario();
    for (const user of this.scenario.users) {
      this.users.set(user.login, { id: user.id, login: user.login, name: user.name, email: user.email });
    }
    this.nextUserId = 2000;
    this.nextRepoId = 10_000;
    this.nextLabelId = 500_000;
  }

  /** A request id: deterministic (a counter), unique, non-empty. */
  requestId(): string {
    this.requestCounter += 1;
    return String(100000 + this.requestCounter);
  }

  user(login: string): User | undefined {
    return this.users.get(login);
  }

  /** Whether `login` names a user this forge knows (the scenario's, or one created on the fly). */
  hasUser(login: string): boolean {
    return this.users.has(login);
  }

  ensureUser(login: string): User {
    const found = this.users.get(login);
    if (found) return found;
    const user: User = { id: this.nextUserId++, login, name: login, email: `${login}@example.invalid` };
    this.users.set(login, user);
    return user;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`.toLowerCase();
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, privateFlag: boolean): Repo {
    this.fastGetCache.clear();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      privateFlag,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      head: 'refs/heads/main',
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      comments: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      requestCounter: 0,
      issueOrder: [],
      pullOrder: [],
      issueReplyCache: new Map(),
      shallowPackCache: new Map(),
      shallowPackTip: null,
      advertCache: new Map(),
      lsRefsCache: new Map(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    this.fastGetCache.clear();
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** Repositories owned by `login`, in creation order. */
  reposOf(login: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === login);
  }

  // ---------------------------------------------------------------- object store

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Every object reachable from `roots`: commit -> tree + parents, tree -> entries, tag -> target. */
  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) if (/^[0-9a-f]{40}$/.test(root)) queue.push(root);
    while (queue.length) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        // parseTag lives in git-objects; a tag's target is on its `object` line.
        const text = object.data.toString('utf8');
        const match = /^object ([0-9a-f]{40})/m.exec(text);
        if (match && match[1]) queue.push(match[1]);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue;
          queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /** Peel a tag ref down to its commit (or whatever non-tag object it ends at). */
  peel(repo: Repo, oid: string): string {
    let current = oid;
    for (let depth = 0; depth < 10; depth += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tag') return current;
      const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (!match || !match[1]) return current;
      current = match[1];
    }
    return current;
  }

  // ---------------------------------------------------------------- refs

  moveRef(repo: Repo, ref: string, oid: string): void {
    if (oid === '0'.repeat(40)) repo.refs.delete(ref);
    else repo.refs.set(ref, oid);
  }

  sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labels: string[], user: string, isPull: boolean, pullNumber: number | null): Issue {
    this.fastGetCache.clear();
    const number = repo.nextIssueNumber++;
    const iso = this.clock.iso();
    const issue: Issue = {
      id: repo.id * 1000 + number,
      number,
      repoId: repo.id,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: iso,
      updatedAt: iso,
      closedAt: null,
      user,
      isPull,
      pullNumber,
    };
    repo.issues.set(number, issue);
    repo.issueOrder.push(number);
    return issue;
  }

  createComment(repo: Repo, issueNumber: number, body: string, user: string): Comment | null {
    this.fastGetCache.clear();
    const issue = repo.issues.get(issueNumber);
    if (!issue) return null;
    const comment: Comment = {
      id: repo.nextCommentId++,
      issueNumber,
      body,
      createdAt: this.clock.iso(),
      updatedAt: this.clock.iso(),
      user,
    };
    repo.comments.set(comment.id, comment);
    issue.updatedAt = this.clock.iso();
    repo.issueReplyCache.delete(issueNumber);
    return comment;
  }

  commentsOf(repo: Repo, issueNumber: number): Comment[] {
    return [...repo.comments.values()].filter((comment) => comment.issueNumber === issueNumber).sort((a, b) => a.id - b.id);
  }

  // ---------------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string): Label {
    this.fastGetCache.clear();
    const existing = [...repo.labels.values()].find((label) => label.name === name);
    if (existing) return existing;
    const label: Label = { id: this.nextLabelId++, name, color };
    repo.labels.set(String(label.id), label);
    return label;
  }

  labelByName(repo: Repo, name: string): Label | undefined {
    return [...repo.labels.values()].find((label) => label.name === name);
  }

  // ---------------------------------------------------------------- pulls

  createPull(repo: Repo, title: string, body: string, head: string, base: string, headSha: string, baseSha: string, user: string): Pull {
    this.fastGetCache.clear();
    const number = repo.nextPullNumber++;
    const iso = this.clock.iso();
    const issue = this.createIssue(repo, title, body, [], user, true, number);
    const pull: Pull = {
      id: repo.id * 10_000 + number,
      number,
      repoId: repo.id,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      headSha,
      baseSha,
      createdAt: iso,
      updatedAt: iso,
      user,
      files: [],
      mergeable: 'MERGEABLE',
      issue,
    };
    repo.pulls.set(number, pull);
    repo.pullOrder.push(number);
    return pull;
  }

  /** The changed files between a pull's head and base commits (a whole-tree diff, names and counts). */
  diffFiles(repo: Repo, baseSha: string, headSha: string): PullFile[] {
    const baseTree = this.treeOf(repo, baseSha);
    const headTree = this.treeOf(repo, headSha);
    const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
    const files: PullFile[] = [];
    for (const path of [...paths].sort()) {
      const before = baseTree.get(path);
      const after = headTree.get(path);
      if (before !== undefined && before === after) continue;
      const beforeBytes = before ? repo.objects.get(before)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
      const afterBytes = after ? repo.objects.get(after)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
      if (beforeBytes.equals(afterBytes)) continue;
      const beforeLines = before === undefined ? 0 : countLines(beforeBytes);
      const afterLines = after === undefined ? 0 : countLines(afterBytes);
      const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
      const additions = status === 'removed' ? 0 : afterLines;
      const deletions = status === 'added' ? 0 : beforeLines;
      files.push({
        filename: path,
        status,
        additions,
        deletions,
        changes: additions + deletions,
        sha: after ?? before ?? '',
        blobOid: after ?? '',
        previousBlobOid: before ?? null,
      });
    }
    return files;
  }

  /** The flat map of path -> blob oid a commit's tree holds (gitlinks skipped). */
  treeOf(repo: Repo, commitSha: string): Map<string, string> {
    const out = new Map<string, string>();
    const commit = repo.objects.get(commitSha);
    if (!commit || commit.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode === '160000') continue;
        else out.set(path, entry.oid);
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return out;
  }
}

function countLines(bytes: Buffer): number {
  let lines = 0;
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 0x0a) lines += 1;
  return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? lines + 1 : lines;
}

/** The scenario user the trial's bearer token names (the viewer), for the store's construction. */
export function viewerLoginOf(): string {
  const scenario: Scenario = buildScenario();
  return scenario.viewer.login;
}

export { buildScenario, type Scenario, type ScenarioUser };
export type { TreeEntry };
