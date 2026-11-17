// GraphQL v4: POST /api/graphql, the documents gh and github-mcp-server send. A hand-rolled
// parser and executor over the one store: the schema surface the suite introspects and reads,
// GitHub's error discipline (a GraphQL-level failure is a 200 with an errors array; an
// unauthenticated request is 401), and operation batching (a JSON array of documents).

import { parseCommit } from './git-objects.ts';
import { clearGitCaches, type Forge, type Issue, type Pull, type Repo } from './store.ts';

export interface GraphQLAnswer {
  readonly status: number;
  readonly body: unknown;
}

// ---------------------------------------------------------------- the parser

interface Token {
  readonly kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  readonly value: string;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '[', ']', '{', '}', '|', '@', '&']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ',') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '"' && source[index + 1] === '"' && source[index + 2] === '"') {
      const end = source.indexOf('"""', index + 3);
      tokens.push({ kind: 'string', value: source.slice(index + 3, end < 0 ? source.length : end) });
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (ch === '"') {
      let text = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\' && index + 1 < source.length) {
          const escape = source[index + 1];
          text += escape === 'n' ? '\n' : escape === 't' ? '\t' : escape === '"' ? '"' : escape === '\\' ? '\\' : escape;
          index += 2;
          continue;
        }
        text += source[index] as string;
        index += 1;
      }
      index += 1;
      tokens.push({ kind: 'string', value: text });
      continue;
    }
    if (ch === '.' && source[index + 1] === '.' && source[index + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let text = '';
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index] as string)) {
        text += source[index] as string;
        index += 1;
      }
      tokens.push({ kind: 'name', value: text });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let text = '';
      while (index < source.length && /[0-9.eE+-]/.test(source[index] as string)) {
        text += source[index] as string;
        index += 1;
      }
      tokens.push({ kind: text.includes('.') || text.includes('e') || text.includes('E') ? 'float' : 'int', value: text });
      continue;
    }
    index += 1;
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'list'; readonly items: ValueNode[] }
  | { readonly kind: 'object'; readonly fields: Array<{ name: string; value: ValueNode }> };

interface Argument {
  readonly name: string;
  readonly value: ValueNode;
}

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Argument[];
  readonly selection: SelectionNode[];
}

interface InlineFragmentNode {
  readonly kind: 'inlineFragment';
  readonly typeCondition: string | null;
  readonly selection: SelectionNode[];
}

interface FragmentSpreadNode {
  readonly kind: 'fragmentSpread';
  readonly name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly selection: SelectionNode[];
}

interface FragmentNode {
  readonly name: string;
  readonly typeCondition: string;
  readonly selection: SelectionNode[];
}

interface Document {
  readonly operations: OperationNode[];
  readonly fragments: Map<string, FragmentNode>;
}

class ParseError extends Error {}

class Parser {
  private index = 0;
  private readonly tokens: readonly Token[];
  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private next(): Token {
    return this.tokens[this.index++] as Token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new ParseError(`Syntax Error: expected '${value}', found ${token.value === '' ? '<EOF>' : `'${token.value}'`}`);
    }
  }

  private name(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new ParseError(`Syntax Error: expected a name, found ${token.value === '' ? '<EOF>' : `'${token.value}'`}`);
    return token.value;
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  document(): Document {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    for (;;) {
      const token = this.peek();
      if (token.kind === 'eof') break;
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        operations.push(this.operation());
      } else if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.fragment();
        fragments.set(fragment.name, fragment);
      } else if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.selectionSet() });
      } else {
        throw new ParseError(`Syntax Error: unexpected ${token.value === '' ? '<EOF>' : `'${token.value}'`}`);
      }
    }
    if (operations.length === 0) throw new ParseError('Syntax Error: the document holds no operation');
    return { operations, fragments };
  }

  private operation(): OperationNode {
    const type = this.name() as 'query' | 'mutation';
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.name();
    if (this.skipPunct('(')) {
      while (!this.skipPunct(')')) {
        if (this.peek().kind === 'eof') throw new ParseError('Syntax Error: unterminated variable definitions');
        this.next();
      }
    }
    while (this.skipPunct('@')) {
      if (this.peek().kind === 'name') this.name();
      if (this.skipPunct('(')) {
        while (!this.skipPunct(')')) {
          if (this.peek().kind === 'eof') throw new ParseError('Syntax Error: unterminated directive arguments');
          this.next();
        }
      }
    }
    return { type, name, selection: this.selectionSet() };
  }

  private fragment(): FragmentNode {
    this.expectWord('fragment');
    const name = this.name();
    this.expectWord('on');
    const typeCondition = this.name();
    return { name, typeCondition, selection: this.selectionSet() };
  }

  private expectWord(word: string): void {
    const token = this.next();
    if (token.kind !== 'name' || token.value !== word) {
      throw new ParseError(`Syntax Error: expected '${word}', found ${token.value === '' ? '<EOF>' : `'${token.value}'`}`);
    }
  }

  private selectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selection: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      if (this.peek().kind === 'eof') throw new ParseError('Syntax Error: unterminated selection set');
      if (this.peek().kind === 'punct' && this.peek().value === '...') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.name();
          selection.push({ kind: 'inlineFragment', typeCondition, selection: this.selectionSet() });
        } else {
          selection.push({ kind: 'fragmentSpread', name: this.name() });
        }
        continue;
      }
      const first = this.name();
      let alias: string | null = null;
      let fieldName = first;
      if (this.skipPunct(':')) {
        alias = first;
        fieldName = this.name();
      }
      const args: Argument[] = [];
      if (this.skipPunct('(')) {
        while (!this.skipPunct(')')) {
          const argName = this.name();
          this.expectPunct(':');
          args.push({ name: argName, value: this.value(false) });
        }
      }
      while (this.skipPunct('@')) {
        if (this.peek().kind === 'name') this.name();
        if (this.skipPunct('(')) {
          while (!this.skipPunct(')')) {
            if (this.peek().kind === 'eof') throw new ParseError('Syntax Error: unterminated directive arguments');
            this.next();
          }
        }
      }
      selection.push({
        kind: 'field',
        alias,
        name: fieldName,
        args,
        selection: this.peek().kind === 'punct' && this.peek().value === '{' ? this.selectionSet() : [],
      });
    }
    return selection;
  }

  private value(constant: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      if (constant) throw new ParseError(`Syntax Error: unexpected '${token.value}'`);
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') {
      if (constant) throw new ParseError('Syntax Error: a variable in a constant position');
      return { kind: 'variable', name: this.name() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.skipPunct(']')) {
        if (this.peek().kind === 'eof') throw new ParseError('Syntax Error: unterminated list');
        items.push(this.value(constant));
      }
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.skipPunct('}')) {
        const name = this.name();
        this.expectPunct(':');
        fields.push({ name, value: this.value(constant) });
      }
      return { kind: 'object', fields };
    }
    throw new ParseError(`Syntax Error: unexpected ${token.value === '' ? '<EOF>' : `'${token.value}'`}`);
  }
}

function resolveValue(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- the executor

interface ExecContext {
  readonly forge: Forge;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly fragments: ReadonlyMap<string, FragmentNode>;
  readonly errors: GraphQLErrorEntry[];
}

class GraphQLError extends Error {}

/** Global ids: base64 of `012:<Type>:<id>`-shaped pairs, opaque and stable. */
function globalId(type: string, id: string | number): string {
  return Buffer.from(`012:${type}:${String(id)}`).toString('base64');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^012:([A-Za-z]+):(.+)$/.exec(text);
    if (!match || !match[1] || !match[2]) return null;
    return { type: match[1], key: match[2] };
  } catch {
    return null;
  }
}

function argOf(field: FieldNode, name: string, variables: Readonly<Record<string, unknown>>): unknown {
  const arg = field.args.find((candidate) => candidate.name === name);
  return arg === undefined ? undefined : resolveValue(arg.value, variables);
}

function repoArg(forge: Forge, field: FieldNode, variables: Readonly<Record<string, unknown>>): Repo | null {
  const owner = argOf(field, 'owner', variables);
  const name = argOf(field, 'name', variables);
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  return forge.getRepo(owner, name);
}

function issueStateName(issue: Issue): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullStateName(pull: Pull): string {
  return pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

/** Execute one selection set against `typeName`/`source`. */
function execute(ctx: ExecContext, typeName: string, source: unknown, selection: readonly SelectionNode[], path: ReadonlyArray<string | number>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'inlineFragment') {
      if (node.typeCondition !== null && node.typeCondition !== typeName && !(node.typeCondition === 'Node' && (typeName === 'Repository' || typeName === 'Issue' || typeName === 'PullRequest'))) continue;
      const inner = execute(ctx, typeName, source, node.selection, path);
      if (inner !== null) Object.assign(out, inner);
      continue;
    }
    if (node.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(node.name);
      if (!fragment) {
        ctx.errors.push({ message: `Fragment "${node.name}" is not defined in the document.` });
        continue;
      }
      if (fragment.typeCondition !== typeName) continue;
      const inner = execute(ctx, typeName, source, fragment.selection, path);
      if (inner !== null) Object.assign(out, inner);
      continue;
    }
    const key = node.alias ?? node.name;
    if (node.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const value = resolveField(ctx, typeName, source, node, path);
    if (value === MISSING) {
      ctx.errors.push({
        message: `Cannot query field "${node.name}" on type "${typeName}".`,
        path: [...path, key],
      });
      continue;
    }
    out[key] = value === undefined ? null : value;
  }
  return out;
}

const MISSING = Symbol('missing');

function resolveField(ctx: ExecContext, typeName: string, source: unknown, field: FieldNode, path: ReadonlyArray<string | number>): unknown {
  const forge = ctx.forge;
  const variables = ctx.variables;
  const child = field.selection;

  if (typeName === 'Query') {
    switch (field.name) {
      case 'viewer':
        return execute(ctx, 'User', forge.user(forge.viewerLogin) ?? { login: forge.viewerLogin }, child, [...path, field.alias ?? field.name]);
      case 'repository': {
        const repo = repoArg(forge, field, variables);
        if (repo === null || repo === undefined) return null;
        return execute(ctx, 'Repository', repo, child, [...path, field.alias ?? field.name]);
      }
      case 'node': {
        const id = argOf(field, 'id', variables);
        if (typeof id !== 'string') return null;
        const decoded = decodeGlobalId(id);
        if (decoded === null) return null;
        if (decoded.type === 'Repository') {
          const repo = [...forge.repos.values()].find((candidate) => String(candidate.id) === decoded.key);
          return repo ? execute(ctx, 'Repository', repo, child, [...path, field.alias ?? field.name]) : null;
        }
        return null;
      }
      case '__type': {
        const name = argOf(field, 'name', variables);
        if (typeof name !== 'string') return null;
        const type = introspectType(name);
        if (type === null) return null;
        return execute(ctx, '__Type', type, child, [...path, field.alias ?? field.name]);
      }
      case '__schema':
        return execute(ctx, '__Schema', {}, child, [...path, field.alias ?? field.name]);
      default:
        return MISSING;
    }
  }

  if (typeName === 'Mutation') {
    return resolveMutation(ctx, source, field, path);
  }

  if (typeName === 'Repository') {
    const repo = source as Repo;
    switch (field.name) {
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return execute(ctx, 'User', forge.user(repo.owner) ?? { login: repo.owner }, child, [...path, field.alias ?? field.name]);
      case 'defaultBranchRef': {
        const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (oid === undefined) return null;
        return execute(ctx, 'Ref', { name: repo.defaultBranch, oid }, child, [...path, field.alias ?? field.name]);
      }
      case 'viewerPermission':
        return repo.owner === forge.viewerLogin ? 'ADMIN' : 'READ';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const number = argOf(field, 'number', variables);
        const issue = repo.issues.get(Number(number));
        if (!issue || issue.isPull) return null;
        return execute(ctx, 'Issue', issue, child, [...path, field.alias ?? field.name]);
      }
      case 'issues': {
        const nodes = issuesOf(repo, field, variables);
        return connectionResult(ctx, 'Issue', nodes, field, variables, child, path, true);
      }
      case 'pullRequest': {
        const number = argOf(field, 'number', variables);
        const pull = repo.pulls.get(Number(number));
        if (!pull) return null;
        return execute(ctx, 'PullRequest', pull, child, [...path, field.alias ?? field.name]);
      }
      case 'pullRequests': {
        const nodes = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
        return connectionResult(ctx, 'PullRequest', nodes, field, variables, child, path, false);
      }
      default:
        return MISSING;
    }
  }

  if (typeName === 'User') {
    const user = source as { login: string };
    switch (field.name) {
      case 'login':
        return user.login;
      case 'id':
        return globalId('User', user.login);
      default:
        return MISSING;
    }
  }

  if (typeName === 'Ref') {
    const ref = source as { name: string; oid: string };
    switch (field.name) {
      case 'name':
        return ref.name;
      case 'id':
        return globalId('Ref', ref.name);
      case 'target': {
        const object = ctx.forge.getObject(currentRepo(ctx, ref), ref.oid);
        if (!object) return null;
        if (object.type === 'commit') return execute(ctx, 'Commit', ref.oid, child, [...path, field.alias ?? field.name]);
        if (object.type === 'tag') return execute(ctx, 'Tag', ref.oid, child, [...path, field.alias ?? field.name]);
        return null;
      }
      default:
        return MISSING;
    }
  }

  if (typeName === 'Commit') {
    const sha = source as string;
    const repo = currentRepo(ctx, sha);
    const object = repo?.objects.get(sha);
    if (!object) return null;
    switch (field.name) {
      case 'id':
        return globalId('Commit', sha);
      case 'oid':
        return sha;
      case 'message':
        return messageOf(object.data.toString('utf8'));
      case 'committedDate':
      case 'pushedDate':
      case 'authoredDate':
        return new Date(1_735_689_600_000).toISOString();
      default:
        return MISSING;
    }
  }

  if (typeName === 'Issue') {
    const issue = source as Issue;
    switch (field.name) {
      case 'id':
        return globalId('Issue', `${issue.repoId}I${issue.number}`);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueStateName(issue);
      case 'body':
        return issue.body;
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      default:
        return MISSING;
    }
  }

  if (typeName === 'PullRequest') {
    const pull = source as Pull;
    switch (field.name) {
      case 'id':
        return globalId('PullRequest', `${pull.repoId}P${pull.number}`);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'state':
        return pullStateName(pull);
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.head;
      case 'baseRefName':
        return pull.base;
      case 'mergeable':
        return pull.mergeable;
      case 'files': {
        const files = pull.files;
        const first = argOf(field, 'first', variables);
        const limit = typeof first === 'number' && first > 0 ? first : files.length;
        const nodes = files.slice(0, limit).map((file) => ({ path: file.filename }));
        return {
          nodes: nodes.map((node) => execute(ctx, 'PullRequestChangedFile', node, child.find((s) => s.kind === 'field' && s.name === 'nodes')?.selection ?? [], [...path, field.alias ?? field.name, 'nodes'])),
          pageInfo: { hasNextPage: false, endCursor: null },
          totalCount: files.length,
        };
      }
      default:
        return MISSING;
    }
  }

  if (typeName === 'PullRequestChangedFile') {
    const file = source as { path: string };
    switch (field.name) {
      case 'path':
        return file.path;
      default:
        return MISSING;
    }
  }

  if (typeName === 'IssueComment') {
    const comment = source as { id: number; body: string; createdAt: string; user: string };
    switch (field.name) {
      case 'id':
        return globalId('IssueComment', String(comment.id));
      case 'body':
        return comment.body;
      case 'createdAt':
        return comment.createdAt;
      case 'updatedAt':
        return comment.createdAt;
      case 'author':
        return execute(ctx, 'User', { login: comment.user }, child, [...path, field.alias ?? field.name]);
      default:
        return MISSING;
    }
  }

  if (typeName === '__Type') {
    const type = source as IntrospectionType;
    switch (field.name) {
      case 'name':
        return type.name;
      case 'kind':
        return type.kind;
      case 'fields': {
        if (type.fields === undefined) return null;
        const includeDeprecated = argOf(field, 'includeDeprecated', variables) === true;
        const names = Object.keys(type.fields).filter((name) => includeDeprecated || !name.startsWith('_deprecated'));
        return names.map((name) => execute(ctx, '__Field', { name, type: type.fields?.[name] }, child, [...path, field.alias ?? field.name, name]));
      }
      case 'enumValues': {
        if (type.enumValues === undefined) return null;
        const includeDeprecated = argOf(field, 'includeDeprecated', variables) === true;
        const values = type.enumValues.filter((value) => includeDeprecated || !value.startsWith('_'));
        return values.map((value) => execute(ctx, '__EnumValue', { name: value }, child, [...path, field.alias ?? field.name, value]));
      }
      default:
        return MISSING;
    }
  }

  if (typeName === '__Field') {
    const fieldDef = source as { name: string };
    switch (field.name) {
      case 'name':
        return fieldDef.name;
      default:
        return MISSING;
    }
  }

  if (typeName === '__EnumValue') {
    const value = source as { name: string };
    switch (field.name) {
      case 'name':
        return value.name;
      default:
        return MISSING;
    }
  }

  if (typeName === '__Schema') {
    switch (field.name) {
      case 'queryType':
        return execute(ctx, '__Type', introspectType('Query'), child, [...path, field.alias ?? field.name]);
      case 'types':
        return [];
      default:
        return MISSING;
    }
  }

  return MISSING;
}

function childOf(selection: readonly SelectionNode[], name: string): readonly SelectionNode[] {
  const found = selection.find((node) => node.kind === 'field' && node.name === name);
  return found && found.kind === 'field' ? found.selection : [];
}

function messageOf(commitText: string): string {
  const blank = commitText.indexOf('\n\n');
  return blank < 0 ? '' : commitText.slice(blank + 2);
}

/** The repo an object belongs to, tracked loosely: the forge's first repo holding its number. */
function currentRepo(ctx: ExecContext, _oid: string): Repo | null {
  void _oid;
  return currentRepoCache(ctx);
}

let repoCache: { forge: Forge; repo: Repo | null } | null = null;

function currentRepoCache(ctx: ExecContext): Repo | null {
  if (repoCache === null || repoCache.forge !== ctx.forge) {
    repoCache = { forge: ctx.forge, repo: [...ctx.forge.repos.values()][0] ?? null };
  }
  return repoCache.repo;
}

/** The issues a repository.issues field selects (states filter, order, first/after). */
function issuesOf(repo: Repo, field: FieldNode, variables: Readonly<Record<string, unknown>>): Issue[] {
  const states = argOf(field, 'states', variables);
  const orderBy = argOf(field, 'orderBy', variables);
  let issues = [...repo.issues.values()].filter((issue) => !issue.isPull);
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : '')));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  let direction = 'desc';
  let orderField = 'created';
  if (orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
    const record = orderBy as Record<string, unknown>;
    if (record.field === 'UPDATED_AT') orderField = 'updated';
    else if (record.field === 'COMMENTS') orderField = 'comments';
    if (record.direction === 'ASC') direction = 'asc';
  }
  issues.sort((a, b) => {
    let order = 0;
    if (orderField === 'created') order = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    else if (orderField === 'updated') order = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else order = a.number - b.number;
    if (order === 0) order = a.number - b.number;
    return direction === 'asc' ? order : -order;
  });
  return issues;
}

/** A connection's answer: nodes, pageInfo (cursor = the last node's number), totalCount. */
function connectionResult(ctx: ExecContext, typeName: string, nodes: ReadonlyArray<unknown>, field: FieldNode, variables: Readonly<Record<string, unknown>>, child: readonly SelectionNode[], path: ReadonlyArray<string | number>, excludePulls: boolean): Record<string, unknown> {
  void excludePulls;
  const first = argOf(field, 'first', variables);
  const after = argOf(field, 'after', variables);
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const decoded = decodeCursor(after);
    if (decoded !== null) {
      start = nodes.findIndex((node) => String((node as { number?: number }).number) === decoded);
      if (start < 0) start = 0;
      else start += 1;
    }
  }
  const limit = typeof first === 'number' && first > 0 ? first : nodes.length;
  const page = nodes.slice(start, start + limit);
  const last = page.length > 0 ? (page[page.length - 1] as { number?: number }).number : null;
  const hasNextPage = start + page.length < nodes.length;
  const nodesSelection = childOf(child, 'nodes');
  const pageInfoSelection = childOf(child, 'pageInfo');
  return {
    nodes: page.map((node, index) => execute(ctx, typeName, node, nodesSelection, [...path, field.alias ?? field.name, 'nodes', index])),
    pageInfo: {
      hasNextPage,
      endCursor: last === null || !hasNextPage ? (page.length > 0 ? encodeCursor(last) : null) : encodeCursor(last),
    },
    totalCount: nodes.length,
  };
}

function encodeCursor(number: number | null): string {
  if (number === null) return '';
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function decodeCursor(cursor: string): string | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    return text.startsWith('cursor:') ? text.slice('cursor:'.length) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- mutations

function resolveMutation(ctx: ExecContext, source: unknown, field: FieldNode, path: ReadonlyArray<string | number>): unknown {
  void source;
  const forge = ctx.forge;
  const variables = ctx.variables;
  const child = field.selection;
  const input = argOf(field, 'input', variables);

  const inputRecord = (): Record<string, unknown> | null => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      ctx.errors.push({ message: `Argument "input" on InputObject "${field.name}" has invalid value.` });
      return null;
    }
    return input as Record<string, unknown>;
  };

  const repoOf = (record: Record<string, unknown> | null): Repo | null => {
    if (record === null) return null;
    const repositoryId = record.repositoryId;
    if (typeof repositoryId !== 'string') return null;
    const decoded = decodeGlobalId(repositoryId);
    if (decoded === null || decoded.type !== 'Repository') return null;
    return [...forge.repos.values()].find((candidate) => String(candidate.id) === decoded.key) ?? null;
  };

  switch (field.name) {
    case 'createIssue': {
      const record = inputRecord();
      if (record === null) return null;
      const repo = repoOf(record);
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve to a node with the global id of the repository' });
        return null;
      }
      const title = typeof record.title === 'string' ? record.title : '';
      const body = typeof record.body === 'string' ? record.body : '';
      const issue = forge.createIssue(repo, title, body, [], forge.viewerLogin, false, null);
      return mutationPayload(ctx, 'CreateIssuePayload', field, child, path, { issue });
    }
    case 'closeIssue': {
      const record = inputRecord();
      if (record === null) return null;
      const node = issueOfId(forge, record.issueId);
      if (node === null) {
        ctx.errors.push({ message: 'Could not resolve to a node with the global id of the issue' });
        return null;
      }
      node.issue.state = 'closed';
      node.issue.closedAt = forge.clock.iso();
      node.issue.updatedAt = forge.clock.iso();
      node.repo.issueReplyCache.delete(node.issue.number);
      return mutationPayload(ctx, 'CloseIssuePayload', field, child, path, { issue: node.issue });
    }
    case 'createPullRequest': {
      const record = inputRecord();
      if (record === null) return null;
      const repo = repoOf(record);
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve to a node with the global id of the repository' });
        return null;
      }
      const head = typeof record.headRefName === 'string' ? record.headRefName : '';
      const base = typeof record.baseRefName === 'string' ? record.baseRefName : repo.defaultBranch;
      const title = typeof record.title === 'string' ? record.title : '';
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        ctx.errors.push({ message: `Head ref or base ref could not be resolved` });
        return null;
      }
      const pull = forge.createPull(repo, title, typeof record.body === 'string' ? String(record.body) : '', head, base, headSha, baseSha, forge.viewerLogin);
      pull.files = forge.diffFiles(repo, baseSha, headSha);
      return mutationPayload(ctx, 'CreatePullRequestPayload', field, child, path, { pullRequest: pull });
    }
    case 'mergePullRequest': {
      const record = inputRecord();
      if (record === null) return null;
      const pull = pullOfId(forge, record.pullRequestId);
      if (pull === null) {
        ctx.errors.push({ message: 'Could not resolve to a node with the global id of the pull request' });
        return null;
      }
      const merged = mergePullInternal(forge, pull.repo, pull.pull);
      if (typeof merged === 'string') {
        ctx.errors.push({ message: merged });
        return null;
      }
      return mutationPayload(ctx, 'MergePullRequestPayload', field, child, path, { pullRequest: pull.pull });
    }
    case 'addComment': {
      const record = inputRecord();
      if (record === null) return null;
      const node = issueOfId(forge, record.subjectId);
      if (node === null) {
        ctx.errors.push({ message: 'Could not resolve to a node with the global id of the subject' });
        return null;
      }
      const comment = forge.createComment(node.repo, node.issue.number, typeof record.body === 'string' ? record.body : '', forge.viewerLogin);
      if (comment === null) return null;
      return mutationPayload(ctx, 'AddCommentPayload', field, child, path, { commentEdge: { node: comment } });
    }
    default:
      return MISSING;
  }
}

interface IssueNode {
  readonly repo: Repo;
  readonly issue: Issue;
}

interface PullNode {
  readonly repo: Repo;
  readonly pull: Pull;
}

function issueOfId(forge: Forge, id: unknown): IssueNode | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const match = /^(\d+)I(\d+)$/.exec(decoded.key);
  if (!match || !match[1] || !match[2]) return null;
  const repo = [...forge.repos.values()].find((candidate) => String(candidate.id) === match[1]);
  if (!repo) return null;
  const issue = repo.issues.get(Number(match[2]));
  if (!issue) return null;
  return { repo, issue };
}

function pullOfId(forge: Forge, id: unknown): PullNode | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  const match = /^(\d+)P(\d+)$/.exec(decoded.key);
  if (!match || !match[1] || !match[2]) return null;
  const repo = [...forge.repos.values()].find((candidate) => String(candidate.id) === match[1]);
  if (!repo) return null;
  const pull = repo.pulls.get(Number(match[2]));
  if (!pull) return null;
  return { repo, pull };
}

/** The squash-merge the REST merge route performs; answers null on success or an error line. */
function mergePullInternal(forge: Forge, repo: Repo, pull: Pull): string | null {
  if (pull.merged) return 'Pull Request is not mergeable: already merged';
  if (pull.state !== 'open') return 'Pull Request is not open';
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (headTip === undefined || baseTip === undefined) return 'Pull Request is not mergeable: head or base ref is gone';
  if (baseTip !== pull.baseSha) {
    const headChanges = new Set(forge.diffFiles(repo, pull.baseSha, headTip).map((file) => file.filename));
    const baseChanges = forge.diffFiles(repo, pull.baseSha, baseTip);
    if (baseChanges.some((file) => headChanges.has(file.filename))) {
      pull.mergeable = 'CONFLICTING';
      return 'Pull Request is not mergeable: merge conflict';
    }
  }
  const headCommit = repo.objects.get(headTip);
  if (!headCommit) return 'Pull Request is not mergeable: head commit is unreadable';
  const headTree = parseCommit(headCommit.data).tree;
  const who = `${forge.viewerLogin} <${forge.viewerLogin}@example.invalid>`;
  const data = Buffer.from(
    [
      `tree ${headTree}`,
      `parent ${baseTip}`,
      `author ${who} ${forge.clock.nowSec()} +0000`,
      `committer ${who} ${forge.clock.nowSec()} +0000`,
      '',
      `${pull.title} (#${pull.number})\n`,
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
  return null;
}

function mutationPayload(ctx: ExecContext, typeName: string, field: FieldNode, child: readonly SelectionNode[], path: ReadonlyArray<string | number>, sources: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of child) {
    if (node.kind !== 'field') continue;
    const key = node.alias ?? node.name;
    const source = sources[node.name];
    if (source === undefined) {
      ctx.errors.push({ message: `Cannot query field "${node.name}" on type "${typeName}".`, path: [...path, key] });
      continue;
    }
    if (node.name === 'issue') out[key] = execute(ctx, 'Issue', source, node.selection, [...path, key]);
    else if (node.name === 'pullRequest') out[key] = execute(ctx, 'PullRequest', source, node.selection, [...path, key]);
    else if (node.name === 'commentEdge') {
      const nodeEntry = (source as { node?: unknown }).node;
      const nodeSelection = childOf(node.selection, 'node');
      out[key] = {
        node: nodeEntry === undefined ? null : execute(ctx, 'IssueComment', nodeEntry, nodeSelection, [...path, key, 'node']),
      };
    } else {
      out[key] = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------- introspection

interface IntrospectionType {
  readonly name: string;
  readonly kind: string;
  readonly fields?: Readonly<Record<string, { type: string }>>;
  readonly enumValues?: readonly string[];
}

const INTROSPECTION_TYPES: Readonly<Record<string, IntrospectionType>> = {
  Query: { name: 'Query', kind: 'OBJECT', fields: { viewer: { type: 'User!' }, repository: { type: 'Repository' }, node: { type: 'Node' }, __type: { type: '__Type' }, __schema: { type: '__Schema!' } } },
  Mutation: { name: 'Mutation', kind: 'OBJECT', fields: { createIssue: { type: 'CreateIssuePayload' }, closeIssue: { type: 'CloseIssuePayload' }, createPullRequest: { type: 'CreatePullRequestPayload' }, mergePullRequest: { type: 'MergePullRequestPayload' }, addComment: { type: 'AddCommentPayload' } } },
  Repository: {
    name: 'Repository',
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int' },
      name: { type: 'String!' },
      nameWithOwner: { type: 'String!' },
      owner: { type: 'User!' },
      defaultBranchRef: { type: 'Ref' },
      viewerPermission: { type: 'RepositoryPermission' },
      hasIssuesEnabled: { type: 'Boolean!' },
      issue: { type: 'Issue' },
      issues: { type: 'IssueConnection!' },
      pullRequest: { type: 'PullRequest' },
      pullRequests: { type: 'PullRequestConnection!' },
    },
  },
  Issue: {
    name: 'Issue',
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      state: { type: 'IssueState!' },
      body: { type: 'String' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      closedAt: { type: 'DateTime' },
      author: { type: 'Actor' },
      bodyText: { type: 'String' },
      comments: { type: 'IssueCommentConnection!' },
      labels: { type: 'LabelConnection' },
      repository: { type: 'Repository!' },
      url: { type: 'URI!' },
      viewerCanUpdate: { type: 'Boolean!' },
    },
  },
  IssueConnection: { name: 'IssueConnection', kind: 'OBJECT', fields: { nodes: { type: '[Issue]' }, edges: { type: '[IssueEdge]' }, pageInfo: { type: 'PageInfo!' }, totalCount: { type: 'Int!' } } },
  IssueEdge: { name: 'IssueEdge', kind: 'OBJECT', fields: { node: { type: 'Issue' }, cursor: { type: 'String!' } } },
  PullRequest: {
    name: 'PullRequest',
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      state: { type: 'PullRequestState!' },
      merged: { type: 'Boolean!' },
      headRefName: { type: 'String!' },
      baseRefName: { type: 'String!' },
      mergeable: { type: 'MergeableState!' },
      files: { type: 'PullRequestChangedFileConnection' },
      body: { type: 'String' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      mergedAt: { type: 'DateTime' },
      mergeCommit: { type: 'Commit' },
      mergeCommitSha: { type: 'GitObjectID' },
      author: { type: 'Actor' },
      url: { type: 'URI!' },
    },
  },
  PullRequestConnection: { name: 'PullRequestConnection', kind: 'OBJECT', fields: { nodes: { type: '[PullRequest]' }, edges: { type: '[PullRequestEdge]' }, pageInfo: { type: 'PageInfo!' }, totalCount: { type: 'Int!' } } },
  PullRequestEdge: { name: 'PullRequestEdge', kind: 'OBJECT', fields: { node: { type: 'PullRequest' }, cursor: { type: 'String!' } } },
  PullRequestChangedFile: { name: 'PullRequestChangedFile', kind: 'OBJECT', fields: { path: { type: 'String!' }, additions: { type: 'Int!' }, deletions: { type: 'Int!' } } },
  PullRequestChangedFileConnection: { name: 'PullRequestChangedFileConnection', kind: 'OBJECT', fields: { nodes: { type: '[PullRequestChangedFile]' }, pageInfo: { type: 'PageInfo!' }, totalCount: { type: 'Int!' } } },
  User: { name: 'User', kind: 'OBJECT', fields: { login: { type: 'String!' }, id: { type: 'ID!' }, name: { type: 'String' }, avatarUrl: { type: 'URI' }, url: { type: 'URI!' }, createdAt: { type: 'DateTime!' } } },
  Ref: { name: 'Ref', kind: 'OBJECT', fields: { id: { type: 'ID!' }, name: { type: 'String!' }, target: { type: 'GitObject' } } },
  Commit: { name: 'Commit', kind: 'OBJECT', fields: { id: { type: 'ID!' }, oid: { type: 'GitObjectID!' }, message: { type: 'String!' }, committedDate: { type: 'DateTime!' }, authoredDate: { type: 'DateTime!' } } },
  Tag: { name: 'Tag', kind: 'OBJECT', fields: { id: { type: 'ID!' }, oid: { type: 'GitObjectID!' }, message: { type: 'String!' } } },
  IssueComment: { name: 'IssueComment', kind: 'OBJECT', fields: { id: { type: 'ID!' }, body: { type: 'String!' }, createdAt: { type: 'DateTime!' }, author: { type: 'Actor' } } },
  PageInfo: { name: 'PageInfo', kind: 'OBJECT', fields: { hasNextPage: { type: 'Boolean!' }, endCursor: { type: 'String' }, startCursor: { type: 'String' }, hasPreviousPage: { type: 'Boolean!' } } },
  Node: { name: 'Node', kind: 'INTERFACE', fields: { id: { type: 'ID!' } } },
  Actor: { name: 'Actor', kind: 'INTERFACE', fields: { login: { type: 'String!' }, avatarUrl: { type: 'URI' }, url: { type: 'URI!' } } },
  Label: { name: 'Label', kind: 'OBJECT', fields: { id: { type: 'ID!' }, name: { type: 'String!' }, color: { type: 'String!' } } },
  CreateIssuePayload: { name: 'CreateIssuePayload', kind: 'OBJECT', fields: { issue: { type: 'Issue' } } },
  CloseIssuePayload: { name: 'CloseIssuePayload', kind: 'OBJECT', fields: { issue: { type: 'Issue' } } },
  CreatePullRequestPayload: { name: 'CreatePullRequestPayload', kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' } } },
  MergePullRequestPayload: { name: 'MergePullRequestPayload', kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' } } },
  AddCommentPayload: { name: 'AddCommentPayload', kind: 'OBJECT', fields: { commentEdge: { type: 'IssueCommentEdge' } } },
  IssueCommentEdge: { name: 'IssueCommentEdge', kind: 'OBJECT', fields: { node: { type: 'IssueComment' } } },
  IssueState: { name: 'IssueState', kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { name: 'PullRequestState', kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { name: 'MergeableState', kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { name: 'PullRequestMergeMethod', kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { name: 'RepositoryPermission', kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { name: 'SearchType', kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueOrderField: { name: 'IssueOrderField', kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { name: 'OrderDirection', kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  __Type: { name: '__Type', kind: 'OBJECT', fields: { name: { type: 'String' }, kind: { type: '__TypeKind!' }, fields: { type: '[__Field!]' }, enumValues: { type: '[__EnumValue!]' } } },
  __Field: { name: '__Field', kind: 'OBJECT', fields: { name: { type: 'String!' }, type: { type: '__Type!' } } },
  __EnumValue: { name: '__EnumValue', kind: 'OBJECT', fields: { name: { type: 'String!' } } },
  __Schema: { name: '__Schema', kind: 'OBJECT', fields: { queryType: { type: '__Type!' }, types: { type: '[__Type!]' } } },
};

function introspectType(name: string): IntrospectionType | null {
  return INTROSPECTION_TYPES[name] ?? null;
}

// ---------------------------------------------------------------- the endpoint

interface ParsedRequest {
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly operationName: string | null;
}

function parseRequest(body: unknown): ParsedRequest | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.query !== 'string') return null;
  return {
    query: record.query,
    variables: record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables) ? (record.variables as Record<string, unknown>) : {},
    operationName: typeof record.operationName === 'string' ? record.operationName : null,
  };
}

function runOperation(forge: Forge, document: Document, operation: OperationNode, variables: Readonly<Record<string, unknown>>): { data: Record<string, unknown> | null; errors: GraphQLErrorEntry[] } {
  const ctx: ExecContext = { forge, variables, fragments: document.fragments, errors: [] };
  const data = execute(ctx, operation.type === 'mutation' ? 'Mutation' : 'Query', null, operation.selection, []);
  return { data, errors: ctx.errors };
}

/** One operation's response body: {data, errors} (errors present only when non-empty). */
function operationBody(forge: Forge, request: ParsedRequest): unknown {
  let document: Document;
  try {
    document = new Parser(tokenize(request.query)).document();
  } catch (err) {
    return {
      errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }],
    };
  }
  const operation = request.operationName !== null
    ? document.operations.find((candidate) => candidate.name === request.operationName) ?? document.operations[0]
    : document.operations[0];
  if (operation === undefined) {
    return { errors: [{ message: 'the document holds no operation' }] };
  }
  const { data, errors } = runOperation(forge, document, operation, request.variables);
  return errors.length > 0 ? { data, errors } : { data };
}

/** The GraphQL endpoint's answer: status and body. `hasToken` gates the 401. */
export function handleGraphQL(forge: Forge, body: unknown, hasToken: boolean): GraphQLAnswer {
  if (!hasToken) {
    return { status: 401, body: { message: 'Bad credentials', documentation_url: 'https://docs.github.com/graphql' } };
  }
  // Operation batching: a JSON array of documents answers an array of bodies in order.
  if (Array.isArray(body)) {
    const bodies: unknown[] = [];
    for (const entry of body) {
      const parsed = parseRequest(entry);
      bodies.push(parsed === null ? { errors: [{ message: 'a batched operation is not a {query} object' }] } : operationBody(forge, parsed));
    }
    return { status: 200, body: bodies };
  }
  const parsed = parseRequest(body);
  if (parsed === null) {
    return { status: 400, body: { message: 'Problems parsing JSON' } };
  }
  return { status: 200, body: operationBody(forge, parsed) };
}

export { mergePullInternal };
