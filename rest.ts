// REST v3: the /api/v3 surface — repositories, branches, commits, contents, labels, issues,
// comments and pull requests, the statuses GitHub answers and the protocol discipline
// (JSON everywhere, a request id on every reply, 401 without a token, 404 across owners).

import { parseCommit, parseTree, buildTree, type GitObject, type TreeEntry } from './git-objects.ts';
import { clearGitCaches, type Forge, type Issue, type Pull, type Repo } from './store.ts';

export interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

export interface RequestView {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly bodyRaw: string;
  readonly hasToken: boolean;
  readonly headers?: Record<string, string | string[] | undefined>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body, headers };
}

function messageError(status: number, message: string, headers: Record<string, string> = {}): Reply {
  return json(status, { message, ...(status === 404 ? { documentation_url: 'https://docs.github.com/rest' } : {}) }, headers);
}

const NOT_FOUND = (): Reply => messageError(404, 'Not Found');

/** Percent-decode a whole path segment sequence (a contents path keeps its slashes). */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function asObject(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------- user shapes

/** A read-only user ref, cached per login (issueJson rebuilds it on every issue serialization). */
const userRefCache = new Map<string, Record<string, unknown>>();

function userRef(forge: Forge, login: string): Record<string, unknown> {
  const cached = userRefCache.get(login);
  if (cached !== undefined) return cached;
  const user = forge.user(login);
  const ref: Record<string, unknown> = {
    login,
    id: user?.id ?? 0,
    node_id: nodeId('User', String(user?.id ?? 0)),
    avatar_url: `https://avatars.example.invalid/u/${login}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://example.invalid/${login}`,
    type: 'User',
    site_admin: false,
  };
  userRefCache.set(login, ref);
  return ref;
}

/** A deterministic Relay-style global id: opaque, stable, base64 of a type:id pair. */
function nodeId(type: string, id: string): string {
  return Buffer.from(`012:${type}${Buffer.from(JSON.stringify([type, id])).toString('base64')}`).toString('base64');
}

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: nodeId('Repository', String(repo.id)),
    name: repo.name,
    full_name: fullName,
    private: repo.privateFlag,
    owner: userRef(forge, repo.owner),
    html_url: `https://example.invalid/${fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${fullName}`,
    created_at: forge.clock.iso(),
    updated_at: forge.clock.iso(),
    pushed_at: forge.clock.iso(),
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: false,
    archived: false,
    disabled: false,
    visibility: repo.privateFlag ? 'private' : 'public',
  };
}

function labelJson(label: { id: number; name: string; color: string }): Record<string, unknown> {
  return {
    id: label.id,
    node_id: nodeId('Label', String(label.id)),
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: null,
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: nodeId('Issue', `${repo.id}I${issue.number}`),
    number: issue.number,
    title: issue.title,
    user: userRef(forge, issue.user),
    labels: issue.labels.map((name) => {
      const label = forge.labelByName(repo, name);
      return label ? labelJson(label) : { id: 0, node_id: '', url: '', name, color: 'ededed', default: false, description: null };
    }),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    comments: forge.commentsOf(repo, issue.number).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    body: issue.body,
    ...(issue.isPull
      ? {
          pull_request: {
            url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${issue.pullNumber}`,
            html_url: '',
            diff_url: '',
            patch_url: '',
            merged_at: null,
          },
        }
      : {}),
  };
}

function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: nodeId('PullRequest', `${repo.id}P${pull.number}`),
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userRef(forge, pull.user),
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    labels: [],
    head: {
      label: `${repo.owner}:${pull.head}`,
      ref: pull.head,
      sha: pull.headSha,
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.privateFlag },
    },
    base: {
      label: `${repo.owner}:${pull.base}`,
      ref: pull.base,
      sha: pull.baseSha,
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.privateFlag },
    },
    merged: pull.merged,
    mergeable: pull.mergeable === 'CONFLICTING' ? false : pull.state === 'open' && !pull.merged ? true : null,
    mergeable_state: pull.merged ? 'clean' : pull.mergeable === 'CONFLICTING' ? 'dirty' : 'clean',
    draft: false,
    author_association: 'OWNER',
  };
}

function commentJson(forge: Forge, repo: Repo, comment: { id: number; body: string; createdAt: string; updatedAt: string; user: string; issueNumber: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', String(comment.id)),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${comment.issueNumber}/comments`,
    html_url: '',
    body: comment.body,
    user: userRef(forge, comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${comment.issueNumber}`,
  };
}

function commitJson(forge: Forge, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha,
    node_id: nodeId('Commit', sha),
    commit: {
      author: { name: authorName(commit.author), email: authorEmail(commit.author), date: dateOf(commit.author) },
      committer: { name: authorName(commit.committer), email: authorEmail(commit.committer), date: dateOf(commit.committer) },
      message: commit.message.replace(/\n+$/, ''),
      tree: { sha: commit.tree, url: '' },
      url: '',
      comment_count: 0,
    },
    url: '',
    html_url: '',
    parents: commit.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
  };
}

function authorName(line: string): string {
  const open = line.lastIndexOf(' <');
  return open < 0 ? line : line.slice(0, open);
}

function authorEmail(line: string): string {
  const open = line.lastIndexOf(' <');
  const close = line.lastIndexOf('>');
  return open < 0 || close < 0 ? '' : line.slice(open + 2, close);
}

function dateOf(line: string): string {
  const match = /(\d+) ([+-]\d{4})$/.exec(line);
  if (!match || !match[1]) return forge0.iso();
  return new Date(Number(match[1]) * 1000).toISOString();
}

const forge0 = { iso: () => new Date(1_735_689_600_000).toISOString() };

function branchJson(repo: Repo, name: string): Record<string, unknown> {
  const oid = repo.refs.get(`refs/heads/${name}`) ?? '';
  return {
    name,
    commit: { sha: oid, url: '' },
    protected: false,
  };
}

// ---------------------------------------------------------------- helpers over the store

function refTip(repo: Repo, refName: string): string | null {
  return repo.refs.get(refName) ?? null;
}

function commitOfRef(repo: Repo, ref: string): string | null {
  const direct = repo.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);
  if (direct) return direct;
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  return null;
}

/** Build a commit object for a contents change: one tree, one parent, the fixed clock. */
function commitContents(
  forge: Forge,
  repo: Repo,
  parent: string | null,
  treeOid: string,
  message: string,
): string {
  const who = `${forge.viewerLogin} <${forge.viewerLogin}@example.invalid>`;
  const data = Buffer.from(
    [
      `tree ${treeOid}`,
      ...(parent ? [`parent ${parent}`] : []),
      `author ${who} ${forge.clock.nowSec()} +0000`,
      `committer ${who} ${forge.clock.nowSec()} +0000`,
      '',
      `${message.endsWith('\n') ? message : `${message}\n`}`,
    ].join('\n'),
    'utf8',
  );
  return forge.putObject(repo, 'commit', data);
}

/** The tree entries of a commit's root tree. */
function treeEntries(repo: Repo, commitSha: string | null): TreeEntry[] {
  if (commitSha === null) return [];
  const commitObject = repo.objects.get(commitSha);
  if (!commitObject || commitObject.type !== 'commit') return [];
  const treeObject = repo.objects.get(parseCommit(commitObject.data).tree);
  if (!treeObject || treeObject.type !== 'tree') return [];
  return parseTree(treeObject.data);
}

/** Set `path` to `blobOid` in a commit's tree, building nested trees; answers the new root tree oid. */
function setTreePath(forge: Forge, repo: Repo, entries: readonly TreeEntry[], segments: readonly string[], blobOid: string | null): string {
  const head = segments[0] ?? '';
  const rest = segments.slice(1);
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const childEntries = existing && existing.mode === '40000' ? treeEntriesOf(repo, existing.oid) : [];
    const childOid = setTreePath(forge, repo, childEntries, rest, blobOid);
    kept.push({ mode: '40000', name: head, oid: childOid });
  }
  return forge.putObject(repo, 'tree', buildTree(kept));
}

function treeEntriesOf(repo: Repo, treeOid: string): TreeEntry[] {
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return [];
  return parseTree(tree.data);
}

/** Find a path in a tree; answers its entry or null. */
function findPath(entries: readonly TreeEntry[], segments: readonly string[]): TreeEntry | null {
  const head = segments[0];
  if (head === undefined) return null;
  const entry = entries.find((candidate) => candidate.name === head);
  if (!entry) return null;
  if (segments.length === 1) return entry;
  if (entry.mode !== '40000') return null;
  return null; // deeper lookups go through the caller with the child tree
}

// ---------------------------------------------------------------- routing

/** The REST surface's reply to one /api/v3 request (path without the /api/v3 prefix). */
export function handleRest(forge: Forge, request: RequestView): Reply {
  const segments = request.path.split('/').filter((segment) => segment !== '');
  const decoded = segments.map(decodePath);
  const method = request.method;

  // ---- root and meta
  if (decoded.length === 0) {
    if (method !== 'GET') return NOT_FOUND();
    return json(200, {
      current_user_url: '/api/v3/user',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      user_url: '/api/v3/users/{user}',
      user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
    }, { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo', 'x-github-media-type': 'github.v3; format=json' });
  }
  if (decoded[0] === 'meta' && decoded.length === 1) {
    return json(200, { verifiable_password_authentication: true, installed_version: 'forge-core-1.0.0' });
  }
  if (decoded[0] === 'user' && decoded.length === 1) {
    return json(200, { ...userRef(forge, forge.viewerLogin), created_at: forge.clock.iso(), updated_at: forge.clock.iso() });
  }

  // ---- /user/repos
  if (decoded[0] === 'user' && decoded[1] === 'repos' && decoded.length === 2) {
    if (method === 'POST') return createUserRepo(forge, request);
    if (method === 'GET') return listUserRepos(forge, request);
    return NOT_FOUND();
  }

  // ---- /repos/{owner}/{repo}/...
  if (decoded[0] === 'repos' && decoded.length >= 3) {
    const owner = decoded[1] as string;
    const name = decoded[2] as string;
    // Ownership: a repository belongs to the login the token names; another owner's same-named
    // repository is 404, never 403.
    const repo = forge.getRepo(owner, name);
    if (repo === undefined || owner !== forge.viewerLogin) return NOT_FOUND();
    return handleRepo(forge, repo, decoded.slice(3), request);
  }

  return NOT_FOUND();
}

function createUserRepo(forge: Forge, request: RequestView): Reply {
  const body = asObject(request.body);
  if (body === null) return messageError(400, 'Problems parsing JSON');
  const name = str(body.name).trim();
  if (name === '') return messageError(422, 'Validation Failed', buildErrorsHeader('name', 'missing'));
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name.endsWith('.git')) {
    return messageError(422, 'Validation Failed', buildErrorsHeader('name', 'invalid'));
  }
  if (forge.getRepo(forge.viewerLogin, name) !== undefined) {
    return messageError(422, 'name already exists on this account', buildErrorsHeader('name', 'already_exists'));
  }
  const repo = forge.createRepo(forge.viewerLogin, name, str(body.description), body.private === true);
  const reply = repoJson(forge, repo);
  return json(201, reply);
}

function buildErrorsHeader(resource: string, code: string): Record<string, string> {
  return {};
}

function listUserRepos(forge: Forge, request: RequestView): Reply {
  const perPage = clampInt(request.query.get('per_page'), 1, 100, 30);
  const page = clampInt(request.query.get('page'), 1, Number.MAX_SAFE_INTEGER, 1);
  const repos = forge.reposOf(forge.viewerLogin);
  const sort = request.query.get('sort');
  const direction = request.query.get('direction') ?? 'desc';
  const ordered = sort === 'created' || sort === 'updated'
    ? repos.slice().sort((a, b) => {
        const order = a.id - b.id;
        return direction === 'asc' ? order : -order;
      })
    : repos;
  const start = (page - 1) * perPage;
  const items = ordered.slice(start, start + perPage).map((repo) => repoJson(forge, repo));
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(repos.length / perPage));
  // GitHub's Link header is absolute; the suite follows only same-origin nexts.
  const base = `${originOf(request)}/api/v3/user/repos?per_page=${perPage}`;
  const link = (page_: number, rel: string): string => `<${base}&page=${page_}>; rel="${rel}"`;
  const parts: string[] = [];
  if (page < lastPage) parts.push(link(page + 1, 'next'));
  parts.push(link(1, 'first'));
  parts.push(link(lastPage, 'last'));
  headers.Link = parts.join(', ');
  return json(200, items, headers);
}

function originOf(request: RequestView): string {
  const host = request.headers?.host ?? 'localhost';
  return `http://${host}`;
}

function clampInt(value: string | null, min: number, max: number, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// ---------------------------------------------------------------- /repos/{o}/{r}/...

function handleRepo(forge: Forge, repo: Repo, rest: readonly string[], request: RequestView): Reply {
  const method = request.method;
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(forge, repo));
    if (method === 'PATCH') return patchRepo(forge, repo, request);
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return json(204, null);
    }
    return NOT_FOUND();
  }
  const head = rest[0] as string;
  if (head === 'branches') return handleBranches(forge, repo, rest.slice(1), request);
  if (head === 'commits') return handleCommits(forge, repo, rest.slice(1), request);
  if (head === 'contents') return handleContents(forge, repo, rest.slice(1), request);
  if (head === 'git') return handleGitData(forge, repo, rest.slice(1), request);
  if (head === 'labels') return handleLabels(forge, repo, rest.slice(1), request);
  if (head === 'issues') return handleIssues(forge, repo, rest.slice(1), request);
  if (head === 'pulls') return handlePulls(forge, repo, rest.slice(1), request);
  return NOT_FOUND();
}

function patchRepo(forge: Forge, repo: Repo, request: RequestView): Reply {
  const body = asObject(request.body);
  if (body === null) return messageError(400, 'Problems parsing JSON');
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.name === 'string' && body.name !== repo.name) {
    return messageError(422, 'Validation Failed');
  }
  return json(200, repoJson(forge, repo));
}

// ---------------------------------------------------------------- branches and commits

function handleBranches(forge: Forge, repo: Repo, rest: readonly string[], request: RequestView): Reply {
  if (rest.length === 0 && request.method === 'GET') {
    const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length)).sort();
    return json(200, names.map((name) => branchJson(repo, name)));
  }
  if (rest.length === 1 && request.method === 'GET') {
    const name = decodePath(rest[0] as string);
    if (!repo.refs.has(`refs/heads/${name}`)) return NOT_FOUND();
    return json(200, branchJson(repo, name));
  }
  return NOT_FOUND();
}

function handleCommits(forge: Forge, repo: Repo, rest: readonly string[], request: RequestView): Reply {
  if (rest.length !== 0) return NOT_FOUND();
  if (request.method !== 'GET') return NOT_FOUND();
  const shaQuery = request.query.get('sha');
  const tip = shaQuery !== null ? commitOfRef(repo, shaQuery) : refTip(repo, `refs/heads/${repo.defaultBranch}`);
  const commits: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const queue: string[] = tip ? [tip] : [];
  while (queue.length) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (!object || object.type !== 'commit') continue;
    seen.add(sha);
    const view = commitJson(forge, repo, sha);
    if (view !== null) commits.push(view);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return json(200, commits);
}

// ---------------------------------------------------------------- contents

function handleContents(forge: Forge, repo: Repo, rest: readonly string[], request: RequestView): Reply {
  if (rest.length === 0) return NOT_FOUND();
  const filePath = decodePath(rest.join('/'));
  const ref = request.query.get('ref') ?? `refs/heads/${repo.defaultBranch}`;
  const tip = commitOfRef(repo, ref);
  const segments = filePath.split('/').filter((segment) => segment !== '');

  if (request.method === 'GET') {
    const entries = treeEntries(repo, tip);
    const head = segments[0] as string;
    let entry: TreeEntry | null = null;
    let current = entries;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string;
      const found = current.find((candidate) => candidate.name === segment);
      if (!found) {
        entry = null;
        break;
      }
      if (index === segments.length - 1) {
        entry = found;
        break;
      }
      if (found.mode !== '40000') {
        entry = null;
        break;
      }
      current = treeEntriesOf(repo, found.oid);
      entry = null;
    }
    if (entry === null) return messageError(404, 'Not Found');
    if (entry.mode === '40000') {
      const listing = treeEntriesOf(repo, entry.oid).map((child) => contentEntryJson(repo, filePath === '' ? child.name : `${filePath}/${child.name}`, child, forge));
      return json(200, listing);
    }
    const object = repo.objects.get(entry.oid);
    if (!object) return messageError(404, 'Not Found');
    return json(200, fileContentJson(forge, repo, filePath, entry.oid, object));
  }

  if (request.method === 'PUT') {
    const body = asObject(request.body);
    if (body === null) return messageError(400, 'Problems parsing JSON');
    const message = str(body.message) || 'Update contents';
    const branchName = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const branchRef = `refs/heads/${branchName}`;
    const content = str(body.content).replace(/[\r\n\t ]+/g, '');
    let data: Buffer;
    try {
      data = Buffer.from(content, 'base64');
    } catch {
      return messageError(422, 'content is not valid base64');
    }
    const tipSha = commitOfRef(repo, branchName);
    if (tipSha === null && !repo.refs.has(branchRef)) {
      // An unborn branch: only the default branch may be born this way when the repo already has commits.
      if (repo.refs.size > 0 && branchName === repo.defaultBranch) {
        return messageError(422, `branch ${branchName} does not exist`);
      }
    }
    const existingEntries = treeEntries(repo, tipSha);
    const existing = findEntry(repo, existingEntries, segments);
    const existingOid = existing && existing.mode !== '40000' ? existing.oid : null;
    if (existingOid !== null && typeof body.sha === 'string' && body.sha !== '' && body.sha !== existingOid) {
      return messageError(409, `${filePath} does not match ${body.sha}`);
    }
    const blobOid = forge.putObject(repo, 'blob', data);
    if (existingOid === blobOid && typeof body.sha === 'string' && body.sha !== '') {
      return messageError(422, 'the content is already at this path');
    }
    const treeOid = setTreePath(forge, repo, existingEntries, segments, blobOid);
    const commitSha = commitContents(forge, repo, tipSha, treeOid, message);
    repo.refs.set(branchRef, commitSha);
    if (repo.refs.size === 1 || (repo.head === branchRef && repo.defaultBranch === branchName)) {
      // keep HEAD pointing at the default branch
    }
    return json(existingOid === null ? 201 : 200, {
      content: {
        name: segments[segments.length - 1],
        path: filePath,
        sha: blobOid,
        size: data.length,
        url: '',
        html_url: '',
        git_url: '',
        download_url: '',
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
      },
      commit: commitJson(forge, repo, commitSha),
    });
  }

  if (request.method === 'DELETE') {
    const body = asObject(request.body);
    if (body === null) return messageError(400, 'Problems parsing JSON');
    const message = str(body.message) || 'Delete contents';
    const branchName = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tipSha = commitOfRef(repo, branchName);
    if (tipSha === null) return messageError(404, 'Not Found');
    const existingEntries = treeEntries(repo, tipSha);
    const existing = findEntry(repo, existingEntries, segments);
    if (!existing || existing.mode === '40000') return messageError(404, 'Not Found');
    if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing.oid) {
      return messageError(409, `${filePath} does not match ${body.sha}`);
    }
    const treeOid = setTreePath(forge, repo, existingEntries, segments, null);
    const commitSha = commitContents(forge, repo, tipSha, treeOid, message);
    repo.refs.set(`refs/heads/${branchName}`, commitSha);
    return json(200, { content: null, commit: commitJson(forge, repo, commitSha) });
  }

  return NOT_FOUND();
}

function findEntry(repo: Repo, entries: readonly TreeEntry[], segments: readonly string[]): TreeEntry | null {
  let current = entries;
  let found: TreeEntry | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    const next = current.find((candidate) => candidate.name === segment);
    if (!next) return null;
    if (index === segments.length - 1) {
      found = next;
      break;
    }
    if (next.mode !== '40000') return null;
    current = treeEntriesOf(repo, next.oid);
  }
  return found;
}

function contentEntryJson(repo: Repo, path: string, entry: TreeEntry, forge: Forge): Record<string, unknown> {
  const object = repo.objects.get(entry.oid);
  const isDir = entry.mode === '40000';
  return {
    type: isDir ? 'dir' : 'file',
    size: object?.data.length ?? 0,
    name: entry.name,
    path,
    sha: entry.oid,
    url: '',
    html_url: '',
    git_url: '',
    download_url: isDir ? null : '',
    ...(isDir ? {} : { content: object?.data.toString('base64') ?? '', encoding: 'base64' }),
    _links: {},
  };
}

function fileContentJson(forge: Forge, repo: Repo, path: string, oid: string, object: GitObject): Record<string, unknown> {
  return {
    type: 'file',
    encoding: 'base64',
    size: object.data.length,
    name: path.split('/').pop() ?? path,
    path,
    content: object.data.toString('base64'),
    sha: oid,
    url: '',
    html_url: '',
    git_url: '',
    download_url: '',
    _links: {},
  };
}

// ---------------------------------------------------------------- git data (branch creation)

function handleGitData(forge: Forge, repo: Repo, rest: readonly string[], request: RequestView): Reply {
  if (rest[0] === 'refs' && rest.length === 1 && request.method === 'POST') {
    const body = asObject(request.body);
    if (body === null) return messageError(400, 'Problems parsing JSON');
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/heads/') || !/^[0-9a-f]{40}$/.test(sha)) {
      return messageError(422, 'Validation Failed');
    }
    if (repo.refs.has(ref)) return messageError(422, 'Reference already exists', buildErrorsHeader('ref', 'already_exists'));
    if (!repo.objects.has(sha)) return messageError(422, 'Object does not exist');
    repo.refs.set(ref, sha);
    return json(201, { ref, node_id: nodeId('GitRef', `${repo.id}:${ref}`), url: '', object: { sha, type: 'commit', url: '' } });
  }
  if (rest[0] === 'refs' && rest.length >= 2 && request.method === 'GET') {
    const refName = decodePath(rest.slice(1).join('/'));
    const oid = repo.refs.get(refName);
    if (oid === undefined) return NOT_FOUND();
    return json(200, { ref: refName, node_id: '', url: '', object: { sha: oid, type: 'commit', url: '' } });
  }
  return NOT_FOUND();
}

// ---------------------------------------------------------------- labels

function handleLabels(forge: Forge, repo: Repo, rest: readonly string[], request: RequestView): Reply {
  if (rest.length === 0 && request.method === 'POST') {
    const body = asObject(request.body);
    if (body === null) return messageError(400, 'Problems parsing JSON');
    const name = str(body.name).trim();
    if (name === '') return messageError(422, 'Validation Failed');
    const existing = forge.labelByName(repo, name);
    if (existing) return messageError(422, 'name already exists', buildErrorsHeader('name', 'already_exists'));
    const label = forge.createLabel(repo, name, str(body.color) || 'ededed');
    return json(201, labelJson(label));
  }
  if (rest.length === 0 && request.method === 'GET') {
    return json(200, [...repo.labels.values()].map(labelJson));
  }
  return NOT_FOUND();
}

// ---------------------------------------------------------------- issues

function handleIssues(forge: Forge, repo: Repo, rest: readonly string[], request: RequestView): Reply {
  if (rest.length === 0) {
    if (request.method === 'POST') return createIssue(forge, repo, request);
    if (request.method === 'GET') return listIssues(forge, repo, request);
    return NOT_FOUND();
  }
  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number)) return NOT_FOUND();
  const issue = repo.issues.get(number);
  if (rest.length === 1) {
    if (request.method !== 'GET' && request.method !== 'PATCH') return NOT_FOUND();
    if (!issue || issue.isPull) return NOT_FOUND();
    if (request.method === 'GET') return json(200, issueJson(forge, repo, issue));
    return patchIssue(forge, repo, issue, request);
  }
  if (rest[1] === 'comments' && rest.length === 2) {
    if (!issue) return NOT_FOUND();
    if (request.method === 'POST') {
      const body = asObject(request.body);
      if (body === null) return messageError(400, 'Problems parsing JSON');
      const comment = forge.createComment(repo, number, str(body.body), forge.viewerLogin);
      if (comment === null) return NOT_FOUND();
      return json(201, commentJson(forge, repo, comment));
    }
    if (request.method === 'GET') {
      return json(200, forge.commentsOf(repo, number).map((comment) => commentJson(forge, repo, comment)));
    }
    return NOT_FOUND();
  }
  return NOT_FOUND();
}

function createIssue(forge: Forge, repo: Repo, request: RequestView): Reply {
  const body = asObject(request.body);
  if (body === null) return messageError(400, 'Problems parsing JSON');
  const title = str(body.title);
  if (title === '') return messageError(422, 'Validation Failed', buildErrorsHeader('title', 'missing'));
  const labels = Array.isArray(body.labels) ? body.labels.map((value) => (typeof value === 'string' ? value : '')).filter((value) => value !== '') : [];
  for (const name of labels) {
    if (forge.labelByName(repo, name) === undefined) {
      return messageError(422, `Validation Failed: label "${name}" does not exist`, buildErrorsHeader('labels', 'invalid'));
    }
  }
  const issue = forge.createIssue(repo, title, str(body.body), labels, forge.viewerLogin, false, null);
  return json(201, issueJson(forge, repo, issue));
}

function listIssues(forge: Forge, repo: Repo, request: RequestView): Reply {
  const state = request.query.get('state') ?? 'open';
  const sort = request.query.get('sort') ?? 'created';
  const direction = request.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()].filter((issue) => !issue.isPull);
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => {
    let order = 0;
    if (sort === 'created') order = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    else if (sort === 'updated') order = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else if (sort === 'comments') order = a.number - b.number;
    if (order === 0) order = a.number - b.number;
    return direction === 'asc' ? order : -order;
  });
  const perPage = clampInt(request.query.get('per_page'), 1, 100, 30);
  const page = clampInt(request.query.get('page'), 1, Number.MAX_SAFE_INTEGER, 1);
  const start = (page - 1) * perPage;
  return json(200, issues.slice(start, start + perPage).map((issue) => issueJson(forge, repo, issue)));
}

function patchIssue(forge: Forge, repo: Repo, issue: Issue, request: RequestView): Reply {
  const body = asObject(request.body);
  if (body === null) return messageError(400, 'Problems parsing JSON');
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? forge.clock.iso() : null;
  }
  issue.updatedAt = forge.clock.iso();
  repo.issueReplyCache.delete(issue.number);
  forge.fastGetCache.clear();
  return json(200, issueJson(forge, repo, issue));
}

// ---------------------------------------------------------------- pulls

function handlePulls(forge: Forge, repo: Repo, rest: readonly string[], request: RequestView): Reply {
  if (rest.length === 0) {
    if (request.method === 'POST') return createPull(forge, repo, request);
    if (request.method === 'GET') return listPulls(forge, repo, request);
    return NOT_FOUND();
  }
  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number)) return NOT_FOUND();
  const pull = repo.pulls.get(number);
  if (rest.length === 1) {
    if (request.method !== 'GET') return NOT_FOUND();
    if (!pull) return NOT_FOUND();
    return json(200, pullJson(forge, repo, pull));
  }
  if (rest[1] === 'files' && rest.length === 2 && request.method === 'GET') {
    if (!pull) return NOT_FOUND();
    return json(200, pull.files.map((file) => ({
      sha: file.sha,
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    })));
  }
  if (rest[1] === 'merge' && rest.length === 2 && request.method === 'PUT') {
    return mergePull(forge, repo, request, number);
  }
  return NOT_FOUND();
}

function createPull(forge: Forge, repo: Repo, request: RequestView): Reply {
  const body = asObject(request.body);
  if (body === null) return messageError(400, 'Problems parsing JSON');
  const head = str(body.head);
  const base = str(body.base) || repo.defaultBranch;
  const title = str(body.title);
  if (head === '' || title === '') return messageError(422, 'Validation Failed');
  const headSha = refTip(repo, `refs/heads/${head}`);
  const baseSha = refTip(repo, `refs/heads/${base}`);
  if (headSha === null) return messageError(422, `Validation Failed: head ref ${head} does not exist`, buildErrorsHeader('head', 'invalid'));
  if (baseSha === null) return messageError(422, `Validation Failed: base ref ${base} does not exist`, buildErrorsHeader('base', 'invalid'));
  if (headSha === baseSha) return messageError(422, 'No commits between base and head', buildErrorsHeader('head', 'no_commits'));
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.head === head && pull.base === base) {
      return messageError(422, `A pull request already exists for ${head}.`, buildErrorsHeader('head', 'already_exists'));
    }
  }
  const pull = forge.createPull(repo, title, str(body.body), head, base, headSha, baseSha, forge.viewerLogin);
  pull.files = forge.diffFiles(repo, baseSha, headSha);
  pull.mergeable = 'MERGEABLE';
  return json(201, pullJson(forge, repo, pull));
}

function listPulls(forge: Forge, repo: Repo, request: RequestView): Reply {
  const state = request.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => b.number - a.number);
  const perPage = clampInt(request.query.get('per_page'), 1, 100, 30);
  const page = clampInt(request.query.get('page'), 1, Number.MAX_SAFE_INTEGER, 1);
  const start = (page - 1) * perPage;
  return json(200, pulls.slice(start, start + perPage).map((pull) => pullJson(forge, repo, pull)));
}

/** Squash-merge a pull: the merge commit's tree is the head tree, its parent the base tip. */
function mergePull(forge: Forge, repo: Repo, request: RequestView, number: number): Reply {
  const pull = repo.pulls.get(number);
  if (!pull) return NOT_FOUND();
  if (pull.merged) return messageError(405, 'Pull Request is not mergeable: already merged');
  if (pull.state !== 'open') return messageError(405, 'Pull Request is not open');
  const headTip = refTip(repo, `refs/heads/${pull.head}`);
  if (headTip === null) return messageError(405, 'Pull Request is not mergeable: head ref is gone');
  const baseTip = refTip(repo, `refs/heads/${pull.base}`);
  if (baseTip === null) return messageError(405, 'Pull Request is not mergeable: base ref is gone');
  // A conflict: both branches changed the same path since the base point the pull was opened at.
  if (conflictsWith(repo, pull, baseTip)) {
    pull.mergeable = 'CONFLICTING';
    return messageError(405, 'Pull Request is not mergeable: merge conflict');
  }
  const headTree = headTreeOf(repo, headTip);
  if (headTree === null) return messageError(405, 'Pull Request is not mergeable: head tree is unreadable');
  const who = `${forge.viewerLogin} <${forge.viewerLogin}@example.invalid}>`.replace('}>', '>');
  const message = `${pull.title} (#${pull.number})\n`;
  const data = Buffer.from(
    [
      `tree ${headTree}`,
      `parent ${baseTip}`,
      `author ${who} ${forge.clock.nowSec()} +0000`,
      `committer ${who} ${forge.clock.nowSec()} +0000`,
      '',
      message,
    ].join('\n'),
    'utf8',
  );
  const mergeSha = forge.putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = forge.clock.iso();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = forge.clock.iso();
  pull.issue.state = 'closed';
  pull.issue.closedAt = pull.mergedAt;
  repo.issueReplyCache.delete(pull.issue.number);
  clearGitCaches(repo);
  return json(200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
}

/** Whether merging `pull` into `baseTip` now would conflict: the base moved and touched a path the head also changed. */
function conflictsWith(repo: Repo, pull: Pull, baseTip: string): boolean {
  if (baseTip === pull.baseSha) return false;
  const headChanges = new Set(forge0Files(repo, pull.headSha, pull.baseSha).map((file) => file.filename));
  if (headChanges.size === 0) return false;
  const baseChanges = forge0Files(repo, baseTip, pull.baseSha);
  return baseChanges.some((file) => headChanges.has(file.filename));
}

function forge0Files(repo: Repo, headSha: string, baseSha: string): Array<{ filename: string }> {
  // A minimal path-level diff: which paths differ between the two trees.
  const baseTree = treeMapOf(repo, baseSha);
  const headTree = treeMapOf(repo, headSha);
  const out: Array<{ filename: string }> = [];
  const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
  for (const path of paths) {
    if (baseTree.get(path) !== headTree.get(path)) out.push({ filename: path });
  }
  return out;
}

function treeMapOf(repo: Repo, commitSha: string): Map<string, string> {
  const out = new Map<string, string>();
  const commitObject = repo.objects.get(commitSha);
  if (!commitObject || commitObject.type !== 'commit') return out;
  const walk = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') out.set(path, entry.oid);
    }
  };
  walk(parseCommit(commitObject.data).tree, '');
  return out;
}

function headTreeOf(repo: Repo, headTip: string): string | null {
  const object = repo.objects.get(headTip);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}


