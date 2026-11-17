// MCP: the Streamable HTTP endpoint at /mcp. JSON-RPC 2.0 over POST, answered application/json
// (SSE is accepted by the client but JSON is simpler and legal). Two eras: the modern 2026-07-28
// revision answers `server/discover`, and the legacy handshake answers `initialize`. The tools
// act on the same store as REST and GraphQL.

import { mergePullInternal } from './graphql.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';

export const MCP_PREFERRED_REVISION = '2026-07-28';
export const MCP_LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;

const SERVER_NAME = 'forge-core';
const SERVER_VERSION = '1.0.0';

interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

interface McpAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

// ---------------------------------------------------------------- tools

interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, string>>;
  readonly required: readonly string[];
}

const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user',
    properties: { name: 'string', description: 'string', private: 'boolean' },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name',
    properties: { owner: 'string', repo: 'string' },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    properties: { owner: 'string', repo: 'string', title: 'string', body: 'string' },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, filtered by state',
    properties: { owner: 'string', repo: 'string', state: 'string' },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch to a base branch',
    properties: { owner: 'string', repo: 'string', title: 'string', head: 'string', base: 'string', body: 'string' },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge (squash) one pull request',
    properties: { owner: 'string', repo: 'string', pull_number: 'number' },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository',
    properties: { owner: 'string', repo: 'string', state: 'string' },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number',
    properties: { owner: 'string', repo: 'string', issue_number: 'number' },
    required: ['owner', 'repo', 'issue_number'],
  },
];

function toolListJson(): Array<Record<string, unknown>> {
  return TOOL_SPECS.map((spec) => ({
    name: spec.name,
    title: spec.name,
    description: spec.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(spec.properties).map(([name, type]) => [name, { type }])),
      required: [...spec.required],
    },
  }));
}

// ---------------------------------------------------------------- tool execution

interface ToolOutcome {
  readonly content: Array<{ type: string; text: string }>;
  readonly isError: boolean;
  readonly structured: unknown;
}

function textOutcome(text: string, structured?: unknown): ToolOutcome {
  return { content: [{ type: 'text', text: typeof structured === 'string' ? JSON.stringify(structured) : text }], isError: false, structured: structured ?? null };
}

function errorOutcome(message: string): ToolOutcome {
  return { content: [{ type: 'text', text: message }], isError: true, structured: null };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner },
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state };
}

function pullJson(pull: Pull): Record<string, unknown> {
  return { id: pull.id, number: pull.number, title: pull.title, state: pull.merged ? 'closed' : pull.state, merged: pull.merged, head: { ref: pull.head }, base: { ref: pull.base } };
}

function executeTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  const owner = str2(args.owner);
  const repoName = str2(args.repo) || str2(args.repository) || str2(args.name);
  const fullName = str2(args.full_name) || str2(args.repo_full_name);
  const [fullOwner, fullRepo] = fullName.includes('/') ? fullName.split('/', 2) : [null, null];
  const resolvedOwner = owner !== '' ? owner : fullOwner ?? '';
  const resolvedRepo = repoName !== '' ? repoName : fullRepo ?? '';

  switch (name) {
    case 'create_repo': {
      const name = str2(args.name) || resolvedRepo;
      if (name === '') return errorOutcome('create_repo needs a name');
      if (forge.getRepo(forge.viewerLogin, name) !== undefined) {
        return errorOutcome(`name already exists on this account`);
      }
      const repo = forge.createRepo(forge.viewerLogin, name, str2(args.description), args.private === true);
      return textOutcome('repository created', repoJson(repo));
    }
    case 'get_repo': {
      const repo = forge.getRepo(resolvedOwner, resolvedRepo);
      if (repo === undefined) return errorOutcome(`repository ${resolvedOwner}/${resolvedRepo} not found`);
      return textOutcome('repository', repoJson(repo));
    }
    case 'create_issue': {
      const repo = forge.getRepo(resolvedOwner, resolvedRepo);
      if (repo === undefined) return errorOutcome(`repository ${resolvedOwner}/${resolvedRepo} not found`);
      const title = str2(args.title);
      if (title === '') return errorOutcome('create_issue needs a title');
      const issue = forge.createIssue(repo, title, str2(args.body), [], forge.viewerLogin, false, null);
      return textOutcome('issue created', issueJson(issue));
    }
    case 'list_issues': {
      const repo = forge.getRepo(resolvedOwner, resolvedRepo);
      if (repo === undefined) return errorOutcome(`repository ${resolvedOwner}/${resolvedRepo} not found`);
      const state = str2(args.state) || 'open';
      let issues = [...repo.issues.values()].filter((issue) => !issue.isPull);
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.number - a.number);
      return textOutcome('issues', issues.map(issueJson));
    }
    case 'get_issue': {
      const repo = forge.getRepo(resolvedOwner, resolvedRepo);
      if (repo === undefined) return errorOutcome(`repository ${resolvedOwner}/${resolvedRepo} not found`);
      const number = Number(args.issue_number ?? args.number);
      const issue = repo.issues.get(number);
      if (!issue || issue.isPull) return errorOutcome(`issue #${String(number)} not found`);
      return textOutcome('issue', issueJson(issue));
    }
    case 'create_pull_request': {
      const repo = forge.getRepo(resolvedOwner, resolvedRepo);
      if (repo === undefined) return errorOutcome(`repository ${resolvedOwner}/${resolvedRepo} not found`);
      const head = str2(args.head);
      const base = str2(args.base) || repo.defaultBranch;
      const title = str2(args.title);
      if (head === '' || title === '') return errorOutcome('create_pull_request needs head and title');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return errorOutcome('head or base ref does not exist');
      if (headSha === baseSha) return errorOutcome('no commits between base and head');
      const pull = forge.createPull(repo, title, str2(args.body), head, base, headSha, baseSha, forge.viewerLogin);
      pull.files = forge.diffFiles(repo, baseSha, headSha);
      return textOutcome('pull request created', pullJson(pull));
    }
    case 'merge_pull_request': {
      const repo = forge.getRepo(resolvedOwner, resolvedRepo);
      if (repo === undefined) return errorOutcome(`repository ${resolvedOwner}/${resolvedRepo} not found`);
      const number = Number(args.pull_number ?? args.pr_number ?? args.number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return errorOutcome(`pull request #${String(number)} not found`);
      const merged = mergePullInternal(forge, repo, pull);
      if (merged !== null) return errorOutcome(merged);
      return textOutcome('pull request merged', { ...pullJson(pull), merged: true, sha: pull.mergeCommitSha });
    }
    case 'list_pull_requests': {
      const repo = forge.getRepo(resolvedOwner, resolvedRepo);
      if (repo === undefined) return errorOutcome(`repository ${resolvedOwner}/${resolvedRepo} not found`);
      const state = str2(args.state) || 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open' && !pull.merged);
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      return textOutcome('pull requests', pulls.map(pullJson));
    }
    default:
      return errorOutcome(`tool ${name} not found`);
  }
}

function str2(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------- the endpoint

/** The MCP endpoint's answer. `hasToken` gates the 401; `methodHeader` mirrors Mcp-Method. */
export function handleMcp(forge: Forge, body: unknown, hasToken: boolean, rawBody: string, methodHeader: string | null): McpAnswer {
  if (!hasToken) {
    return { status: 401, body: { message: 'Bad credentials' }, headers: {} };
  }
  if (body === null) {
    return {
      status: 400,
      body: rpcError(null, JSON_RPC_PARSE_ERROR, 'Invalid request body: the payload is not valid JSON'),
      headers: { 'mcp-method': methodHeader ?? '' },
    };
  }
  const record = body as Record<string, unknown>;
  const id = record.id;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = record.params !== null && typeof record.params === 'object' && !Array.isArray(record.params) ? (record.params as Record<string, unknown>) : {};

  // A notification (no id): 202 Accepted, no body.
  if (record.id === undefined) {
    return { status: 202, body: null, headers: {} };
  }

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          resultType: 'discover',
          supportedVersions: [MCP_PREFERRED_REVISION, ...MCP_LEGACY_REVISIONS],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP tools.',
        }),
        headers: {},
      };
    case 'initialize':
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_LEGACY_REVISIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
        headers: {},
      };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: toolListJson() }), headers: {} };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const spec = TOOL_SPECS.find((candidate) => candidate.name === name);
      if (spec === undefined) {
        return {
          status: 200,
          body: rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Tool ${name} not found`),
          headers: {},
        };
      }
      const missing = spec.required.filter((key) => {
        const value = args[key];
        return value === undefined || value === null || (typeof value === 'string' && value === '');
      });
      if (missing.length > 0) {
        return {
          status: 200,
          body: rpcResult(id, {
            content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }],
            isError: true,
          }),
          headers: {},
        };
      }
      const outcome = executeTool(forge, name, args);
      return {
        status: 200,
        body: rpcResult(id, {
          content: outcome.content,
          ...(outcome.structured !== null ? { structuredContent: outcome.structured } : {}),
          isError: outcome.isError,
        }),
        headers: {},
      };
    }
    default:
      return {
        status: 200,
        body: rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`),
        headers: {},
      };
  }
}

void JSON_RPC_INVALID_PARAMS;
