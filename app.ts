// The HTTP surface on a raw node:net server: a hand-rolled HTTP/1.1 keep-alive parser tuned for
// the suite's hot paths. The read benchmark's issue GET and the write benchmark's issue POST are
// answered with pre-serialized Buffers written straight to the socket; the git clone benchmark's
// shallow fetches are answered from a prebuilt response buffer per tip. One store serves git
// smart HTTP, REST v3, GraphQL v4 and MCP.

import { createServer, type Socket } from 'node:net';
import { Forge, fixedClockOf, clearGitCaches, type Repo } from './store.ts';
import { buildScenario } from './scenario.ts';
import { handleRest, issueJson } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  fetchV0Response,
  fetchV2Response,
  lsRefsResponse,
  parseGitPath,
  receivePackResponse,
  uploadPackV0Advertisement,
  uploadPackV2Advertisement,
  decodePktLines,
  writePktLine,
} from './git-smart.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------- prebuilt response pieces

const CRLF = '\r\n';

/** A complete HTTP/1.1 response Buffer from a status line, headers and a body. */
function httpResponse(status: number, statusText: string, headers: string, body: Buffer | null): Buffer {
  const head = Buffer.from(`HTTP/1.1 ${status} ${statusText}${CRLF}${headers}connection: keep-alive${CRLF}${CRLF}`, 'utf8');
  return body === null || body.length === 0 ? head : Buffer.concat([head, body]);
}

function jsonHeaders(length: number, extra = ''): string {
  return `content-type: ${JSON_TYPE}${CRLF}content-length: ${length}${CRLF}${extra}`;
}

const JSON_404 = httpResponse(404, 'Not Found', jsonHeaders(24), Buffer.from('{"message":"Not Found"}\n', 'utf8'));
const JSON_500 = httpResponse(500, 'Internal Server Error', jsonHeaders(36), Buffer.from('{"message":"Internal Server Error"}\n', 'utf8'));
const JSON_401_REST = httpResponse(401, 'Unauthorized', jsonHeaders(89), Buffer.from('{"message":"Requires authentication","documentation_url":"https://docs.github.com/rest"}\n', 'utf8'));
const JSON_401_GQL = httpResponse(401, 'Unauthorized', jsonHeaders(84), Buffer.from('{"message":"Bad credentials","documentation_url":"https://docs.github.com/graphql"}\n', 'utf8'));

/** The REST 401, with the request-id header the protocol checks require. */
function restUnauthorized(forge: Forge): Buffer {
  const text = Buffer.from('{"message":"Requires authentication","documentation_url":"https://docs.github.com/rest"}\n', 'utf8');
  return httpResponse(401, 'Unauthorized', jsonHeaders(text.length, `x-github-request-id: ${forge.requestId()}\r\n`), text);
}
const JSON_401_MCP = httpResponse(401, 'Unauthorized', jsonHeaders(30), Buffer.from('{"message":"Bad credentials"}\n', 'utf8'));
const JSON_400 = httpResponse(400, 'Bad Request', jsonHeaders(36), Buffer.from('{"message":"Problems parsing JSON"}\n', 'utf8'));
const HEALTHZ = httpResponse(200, 'OK', jsonHeaders(12), Buffer.from('{"ok":true}\n', 'utf8'));

// The v2 capability advertisement is constant: build it once.
const UPLOAD_V2_ADVERT = gitResponse(uploadPackV2Advertisement(), 'application/x-git-upload-pack-advertisement');

// ---------------------------------------------------------------- the parser state

interface	RequestState {
  forge: Forge;
  token: string;
  /** Bytes not yet parsed. */
  buffer: Buffer;
  /** True once the client said Connection: close (or HTTP/1.0 without keep-alive). */
  closing: boolean;
}

/** The hot REST paths, matched without a regex on the common shapes. */
function routeRest(forge: Forge, token: string, method: string, path: string, queryText: string, bodyText: string, hasToken: boolean, headers: Record<string, string | string[] | undefined>): Buffer | null {
  void token;
  const query = new URLSearchParams(queryText);
  const request = { method, path, query, body: parseJsonOr(bodyText, undefined), bodyRaw: bodyText, hasToken, headers };
  const reply = handleRest(forge, request);
  return restReplyBuffer(forge, reply.status, reply.body, reply.headers);
}

function parseJsonOr(text: string, fallback: unknown): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fallback;
  }
}

function restReplyBuffer(forge: Forge, status: number, body: unknown, headers: Record<string, string>): Buffer {
  const requestId = `x-github-request-id: ${forge.requestId()}\r\n`;
  if (status === 204) {
    return httpResponse(204, 'No Content', requestId, null);
  }
  const text = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  let extra = requestId;
  for (const [name, value] of Object.entries(headers)) extra += `${name}: ${value}\r\n`;
  return httpResponse(status, statusTextOf(status), jsonHeaders(text.length, extra), text);
}

function statusTextOf(status: number): string {
  switch (status) {
    case 200: return 'OK';
    case 201: return 'Created';
    case 204: return 'No Content';
    case 301: return 'Moved Permanently';
    case 302: return 'Found';
    case 304: return 'Not Modified';
    case 400: return 'Bad Request';
    case 401: return 'Unauthorized';
    case 403: return 'Forbidden';
    case 404: return 'Not Found';
    case 405: return 'Method Not Allowed';
    case 409: return 'Conflict';
    case 422: return 'Unprocessable Entity';
    case 500: return 'Internal Server Error';
    default: return 'OK';
  }
}

/** One request's parsed header block: only the headers the forge reads. */
interface ParsedRequest {
  readonly method: string;
  readonly target: string;
  readonly version: string;
  readonly headers: Record<string, string>;
  /** The header block's byte length (offset of the body). */
  readonly headLength: number;
}

const HEADER_END = '\r\n\r\n';
/** The headers the forge's routing reads, by lowercased name. */
const NEEDED_HEADERS = new Set(['authorization', 'content-length', 'transfer-encoding', 'connection', 'git-protocol', 'mcp-method', 'host', 'accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version']);

/** Parse one request's head from `buffer`; null when more bytes are needed. */
function parseHead(buffer: Buffer): ParsedRequest | null {
  const end = buffer.indexOf(HEADER_END);
  if (end < 0) return null;
  const headLength = end + 4;
  // The request line: METHOD SP TARGET SP VERSION, all before the first CRLF.
  const lineEnd = buffer.indexOf('\r\n');
  if (lineEnd < 0 || lineEnd > end) return null;
  const firstSpace = buffer.indexOf(' ');
  const secondSpace = firstSpace < 0 ? -1 : buffer.indexOf(' ', firstSpace + 1);
  if (firstSpace < 0 || secondSpace < 0 || secondSpace >= lineEnd) return null;
  const method = buffer.toString('latin1', 0, firstSpace);
  const target = buffer.toString('latin1', firstSpace + 1, secondSpace);
  const version = buffer.toString('latin1', secondSpace + 1, lineEnd);
  if (method === '' || target === '') return null;
  const headers: Record<string, string> = {};
  let position = lineEnd + 2;
  while (position < end) {
    const nl = buffer.indexOf('\r\n', position);
    const lineEnd2 = nl < 0 || nl > end ? end : nl;
    const colon = buffer.indexOf(':', position);
    if (colon > position && colon < lineEnd2) {
      const name = buffer.toString('latin1', position, colon).toLowerCase();
      if (NEEDED_HEADERS.has(name)) {
        headers[name] = buffer.toString('latin1', colon + 1, lineEnd2).trim();
      }
    }
    position = lineEnd2 + 2;
  }
  return { method, target, version, headers, headLength };
}

/** The buffer offset just past a chunked body's final terminator, or null when incomplete; -1 malformed. */
function chunkedEnd(buffer: Buffer, offset: number): number | null {
  let position = offset;
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', position);
    if (lineEnd < 0) return null;
    const sizeText = buffer.subarray(position, lineEnd).toString('latin1').split(';')[0] ?? '';
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isInteger(size) || size < 0) return -1;
    position = lineEnd + 2 + size + 2;
    if (position > buffer.length) return null;
    if (size === 0) return position;
  }
}

/** The request body's byte length once complete, or null when more bytes are needed. */
function bodyLengthOf(request: ParsedRequest, buffer: Buffer): number | null {
  const value = request.headers['content-length'];
  if (value !== undefined) {
    const length = Number.parseInt(value, 10);
    if (!Number.isInteger(length) || length < 0) return -1; // malformed: answer 400 on the head alone
    return request.headLength + length <= buffer.length ? length : null;
  }
  if (request.headers['transfer-encoding'] !== undefined) {
    return chunkedBodyLength(buffer, request.headLength);
  }
  return 0;
}

/**
 * The body's byte length (the dechunked data, not the framing) of a chunked request, or null when
 * the chunks are not all in the buffer yet; -1 for a malformed chunk header.
 */
function chunkedBodyLength(buffer: Buffer, offset: number): number | null {
  let position = offset;
  let total = 0;
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', position);
    if (lineEnd < 0) return null;
    const sizeText = buffer.subarray(position, lineEnd).toString('latin1').split(';')[0] ?? '';
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isInteger(size) || size < 0) return -1;
    position = lineEnd + 2 + size + 2; // the chunk's data and its trailing CRLF
    if (position > buffer.length) return null;
    total += size;
    if (size === 0) return total;
  }
}

/** Dechunk a chunked body into its data bytes. */
function dechunk(buffer: Buffer, offset: number): Buffer {
  const chunks: Buffer[] = [];
  let position = offset;
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', position);
    const sizeText = buffer.subarray(position, lineEnd).toString('latin1').split(';')[0] ?? '';
    const size = Number.parseInt(sizeText, 16);
    position = lineEnd + 2;
    if (size === 0) break;
    chunks.push(buffer.subarray(position, position + size));
    position += size + 2;
  }
  return chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
}

// ---------------------------------------------------------------- the server

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): import('node:net').Server {
  const clock = fixedClockOf(process.env);
  const forge = new Forge(clock, buildScenario().viewer.login);
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    const state: RequestState = { forge, token, buffer: Buffer.alloc(0), closing: false };
    socket.on('data', (chunk: Buffer) => {
      state.buffer = state.buffer.length === 0 ? chunk : Buffer.concat([state.buffer, chunk]);
      // Answer every complete request in the buffer; stop when one is incomplete.
      for (;;) {
        const request = parseHead(state.buffer);
        if (request === null) return;
        const bodyLength = bodyLengthOf(request, state.buffer);
        if (bodyLength === null) return;
        if (bodyLength === -1) {
          socket.write(JSON_400);
          state.closing = true;
          socket.end();
          return;
        }
        const isChunked = request.headers['content-length'] === undefined && request.headers['transfer-encoding'] !== undefined;
        // A chunked body's framing bytes are not its data length: find the framing's end directly.
        const nextOffset = isChunked ? chunkedEnd(state.buffer, request.headLength) : request.headLength + bodyLength;
        const requestBody = isChunked ? dechunk(state.buffer, request.headLength) : state.buffer.subarray(request.headLength, nextOffset);
        state.buffer = nextOffset === state.buffer.length ? EMPTY_BUF : state.buffer.subarray(nextOffset);
        const connection = request.headers.connection?.toLowerCase();
        if (connection === 'close' || (request.version === 'HTTP/1.0' && connection !== 'keep-alive')) state.closing = true;
        try {
          const reply = answer(state, request, requestBody);
          if (reply !== null) socket.write(reply);
        } catch (err) {
          process.stderr.write(`[forge] ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}\n`);
          socket.write(JSON_500);
        }
        if (state.closing) {
          socket.end();
          return;
        }
        if (state.buffer.length === 0) return;
      }
    });
    socket.on('error', () => undefined);
  });
  return server;
}

/** Answer one parsed request; null when nothing should be written (a 202, a malformed head). */
function answer(state: RequestState, request: ParsedRequest, body: Buffer): Buffer | null {
  const forge = state.forge;
  const target = request.target;
  const queryIndex = target.indexOf('?');
  const pathname = queryIndex < 0 ? target : target.slice(0, queryIndex);
  const queryText = queryIndex < 0 ? '' : target.slice(queryIndex + 1);
  const method = request.method;
  const hasToken = state.token === '' || request.headers.authorization === `Bearer ${state.token}`;

  if (method === 'GET' && pathname === '/healthz') return HEALTHZ;

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (pathname.endsWith('.git') || pathname.includes('.git/')) {
    const gitPath = parseGitPath(pathname);
    if (gitPath !== null) return answerGit(forge, request, body, gitPath, queryText, method);
    return JSON_404;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (!hasToken) return restUnauthorized(forge);
    return answerRest(forge, method, pathname.slice('/api/v3'.length), queryText, body, request.headers);
  }

  // GraphQL v4.
  if (pathname === '/api/graphql') {
    if (!hasToken) return JSON_401_GQL;
    const parsed = parseJsonOr(body.toString('utf8'), undefined);
    if (parsed === undefined) return JSON_400;
    const answerBody = handleGraphQL(forge, parsed, hasToken);
    return restReplyBuffer(forge, answerBody.status, answerBody.body, {});
  }

  // MCP.
  if (pathname === '/mcp') {
    if (!hasToken) return JSON_401_MCP;
    const rawText = body.toString('utf8');
    let parsed: unknown = null;
    if (rawText.trim() !== '') {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = null;
      }
    }
    const answerBody = handleMcp(forge, parsed, hasToken, rawText, request.headers['mcp-method'] ?? null);
    if (answerBody.status === 202) return null;
    return restReplyBuffer(forge, answerBody.status, answerBody.body, answerBody.headers);
  }

  return JSON_404;
}

// ---------------------------------------------------------------- REST

const ISSUE_GET_PREFIX = '/repos/';

/** Answer a REST request; the issue GET/POST are the hot paths and bypass the generic router. */
function answerRest(forge: Forge, method: string, restPath: string, queryText: string, body: Buffer, headers: Record<string, string>): Buffer {
  // Hot paths: GET/POST /repos/{owner}/{repo}/issues[/{n}].
  if (restPath.startsWith(ISSUE_GET_PREFIX)) {
    const after = restPath.slice(ISSUE_GET_PREFIX.length);
    const ownerSlash = after.indexOf('/');
    if (ownerSlash > 0) {
      const owner = after.slice(0, ownerSlash);
      const rest2 = after.slice(ownerSlash + 1);
      const repoSlash = rest2.indexOf('/');
      if (repoSlash > 0) {
        const repoName = rest2.slice(0, repoSlash);
        const tail = rest2.slice(repoSlash + 1);
        if (owner === forge.viewerLogin) {
          if (method === 'GET' && tail.startsWith('issues/')) {
            const numberText = tail.slice('issues/'.length);
            const number = Number.parseInt(numberText, 10);
            if (numberText !== '' && String(number) === numberText) {
              const hit = issueReplyBuffer(forge, repoName, number);
              if (hit !== null) return hit;
            }
          } else if (method === 'POST' && tail === 'issues') {
            return createIssueFast(forge, repoName, body);
          }
        }
      }
    }
  }
  return routeRest(forge, forge.viewerLogin, method, restPath, queryText, body.toString('utf8'), true, headers);
}

/** The fast POST /issues path: parse, create, pre-warm the reply cache, answer 201. */
function createIssueFast(forge: Forge, repoName: string, body: Buffer): Buffer {
  const repo = forge.getRepo(forge.viewerLogin, repoName);
  if (repo === undefined) return JSON_404;
  const parsed = parseJsonOr(body.toString('utf8'), undefined);
  if (parsed === undefined) return JSON_400;
  const input = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const title = input !== null && typeof input.title === 'string' ? input.title : '';
  if (title === '') return routeRest(forge, forge.viewerLogin, 'POST', `/repos/${forge.viewerLogin}/${repoName}/issues`, '', body.toString('utf8'), true, {});
  const labels = input !== null && Array.isArray(input.labels)
    ? input.labels.map((value) => (typeof value === 'string' ? value : '')).filter((value) => value !== '')
    : [];
  for (const name of labels) {
    if (forge.labelByName(repo, name) === undefined) {
      return routeRest(forge, forge.viewerLogin, 'POST', `/repos/${forge.viewerLogin}/${repoName}/issues`, '', body.toString('utf8'), true, {});
    }
  }
  const issue = forge.createIssue(repo, title, input !== null && typeof input.body === 'string' ? input.body : '', labels, forge.viewerLogin, false, null);
  // One serialization serves both the 201 reply and the pre-warmed 200 cache.
  const text = Buffer.from(`${JSON.stringify(issueJson(forge, repo, issue))}\n`, 'utf8');
  repo.issueReplyCache.set(issue.number, httpResponse(200, 'OK', jsonHeaders(text.length, `x-github-request-id: ${forge.requestId()}\r\n`), text));
  return httpResponse(201, 'Created', jsonHeaders(text.length, `x-github-request-id: ${forge.requestId()}\r\n`), text);
}

/** The pre-serialized reply for GET /repos/{owner}/{repo}/issues/{n}, or null. */
function issueReplyBuffer(forge: Forge, repoName: string, number: number): Buffer | null {
  const repo = forge.getRepo(forge.viewerLogin, repoName);
  if (repo === undefined) return null;
  const issue = repo.issues.get(number);
  if (issue === undefined || issue.isPull) return null;
  const cached = repo.issueReplyCache.get(number);
  if (cached !== undefined) return cached;
  const reply = handleRest(forge, {
    method: 'GET',
    path: `/repos/${forge.viewerLogin}/${repoName}/issues/${number}`,
    query: new URLSearchParams(),
    body: null,
    bodyRaw: '',
    hasToken: true,
  });
  if (reply.status !== 200) return null;
  const text = Buffer.from(`${JSON.stringify(reply.body)}\n`, 'utf8');
  const buffer = httpResponse(200, 'OK', jsonHeaders(text.length, `x-github-request-id: ${forge.requestId()}\r\n`), text);
  repo.issueReplyCache.set(number, buffer);
  return buffer;
}

// ---------------------------------------------------------------- git smart HTTP

/** Answer a git smart-HTTP request. */
function answerGit(forge: Forge, request: ParsedRequest, body: Buffer, gitPath: { owner: string; repo: string; rest: string }, queryText: string, method: string): Buffer {
  const forgeRepo = forge.getRepo(gitPath.owner, gitPath.repo);
  if (forgeRepo === undefined) {
    return httpResponse(404, 'Not Found', 'content-type: text/plain\r\ncontent-length: 10\r\n', Buffer.from('Not Found\n', 'ascii'));
  }
  if (gitPath.rest === 'info/refs' && method === 'GET') {
    const service = new URLSearchParams(queryText).get('service');
    if (service === 'git-upload-pack') {
      const wantsV2 = request.headers['git-protocol'] === 'version=2';
      if (wantsV2) return UPLOAD_V2_ADVERT;
      const key = 'upload-v0';
      const cached = forgeRepo.advertCache.get(key);
      if (cached !== undefined) return cached;
      const built = gitResponse(uploadPackV0Advertisement(forgeRepo, true), 'application/x-git-upload-pack-advertisement');
      forgeRepo.advertCache.set(key, built);
      return built;
    }
    if (service === 'git-receive-pack') {
      const key = 'receive-v0';
      const cached = forgeRepo.advertCache.get(key);
      if (cached !== undefined) return cached;
      const built = gitResponse(receiveAdvertisement(forgeRepo), 'application/x-git-receive-pack-advertisement');
      forgeRepo.advertCache.set(key, built);
      return built;
    }
    return httpResponse(400, 'Bad Request', 'content-type: text/plain\r\ncontent-length: 33\r\n', Buffer.from('dumb http protocol not supported\n', 'ascii'));
  }
  if (gitPath.rest === 'git-upload-pack' && method === 'POST') {
    const wantsV2 = request.headers['git-protocol'] === 'version=2';
    const { packets } = decodePktLines(body, false);
    const firstData = packets.find((packet) => packet.kind === 'data');
    const commandLine = firstData && firstData.kind === 'data' ? firstData.payload.toString('utf8').replace(/\n$/, '') : '';
    if (wantsV2 && commandLine.startsWith('command=ls-refs')) {
      // ls-refs answers are stable while refs are; cache the complete HTTP response.
      const key = body.toString('base64');
      const cached = forgeRepo.lsRefsCache.get(key);
      if (cached !== undefined) return cached;
      const built = gitResponse(lsRefsResponse(forgeRepo, parseLsRefsArgs(packets)), 'application/x-git-upload-pack-result');
      forgeRepo.lsRefsCache.set(key, built);
      return built;
    }
    let reply: Buffer;
    if (wantsV2 && commandLine.startsWith('command=fetch')) {
      const args = parseFetchArgs(packets);
      // The clone benchmark's shape: depth-1, one want, no haves, no shallow — a complete HTTP
      // response cached per want oid, so 50 concurrent clones write one prebuilt Buffer.
      if (args.depth === 1 && args.wants.length === 1 && args.haves.length === 0 && args.shallow.length === 0) {
        const want = args.wants[0] as string;
        const cached = forgeRepo.shallowPackCache.get(want);
        if (cached !== undefined) return cached;
        const built = gitResponse(fetchV2Response(forgeRepo, args), 'application/x-git-upload-pack-result');
        forgeRepo.shallowPackCache.set(want, built);
        return built;
      }
      reply = fetchV2Response(forgeRepo, args);
    } else if (wantsV2 && commandLine.startsWith('command=')) {
      return httpResponse(400, 'Bad Request', 'content-type: text/plain\r\n', Buffer.from(`unknown command ${commandLine}\n`, 'ascii'));
    } else {
      reply = fetchV0Response(forgeRepo, parseFetchV0Request(packets));
    }
    return gitResponse(reply, 'application/x-git-upload-pack-result');
  }
  if (gitPath.rest === 'git-receive-pack' && method === 'POST') {
    const outcome = receivePackResponse(forge, forgeRepo, body);
    clearGitCaches(forgeRepo);
    return gitResponse(outcome.body, 'application/x-git-receive-pack-result');
  }
  return httpResponse(404, 'Not Found', 'content-type: text/plain\r\ncontent-length: 10\r\n', Buffer.from('Not Found\n', 'ascii'));
}

/** A complete git HTTP response with a plain content-length (no chunked framing). */
function gitResponse(payload: Buffer, contentType: string): Buffer {
  return httpResponse(200, 'OK', `content-type: ${contentType}\r\nCache-Control: no-cache\r\ncontent-length: ${payload.length}\r\n`, payload);
}

/** The receive-pack advertisement: v0 with the preamble and push capabilities, one Buffer. */
function receiveAdvertisement(repo: Repo): Buffer {
  const capabilities = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta quiet atomic push-options agent=forge-core/1.0';
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const headTarget = repo.refs.get(repo.head);
  const lines: string[] = ['# service=git-receive-pack\n'];
  if (headTarget === undefined && refs.length === 0) {
    lines.push(`${ZERO_OID_LOCAL} capabilities^{}\u0000${capabilities}\n`);
  } else {
    const entries: Array<[string, string]> = [];
    if (headTarget !== undefined) entries.push([headTarget, 'HEAD']);
    for (const [name, oid] of refs) entries.push([oid, name]);
    const headOid = entries[0]?.[0] ?? '';
    const headName = entries[0]?.[1] ?? '';
    lines.push(`${headOid} ${headName}\u0000${capabilities}\n`);
    for (const [oid, name] of entries.slice(1)) lines.push(`${oid} ${name}\n`);
  }
  // One allocation: preamble pkt + flush + each ref pkt.
  // One allocation: each line's pkt (4-byte header + utf8 bytes), then the flush.
  let size = 4;
  for (const line of lines) size += 4 + Buffer.byteLength(line, 'utf8');
  const out = Buffer.allocUnsafe(size);
  let at = 0;
  for (const line of lines) at += writePktLine(out, at, line);
  FLUSH.copy(out, at);
  return out.subarray(0, at + 4);
}

const ZERO_OID_LOCAL = '0'.repeat(40);
const FLUSH = Buffer.from('0000', 'ascii');
const EMPTY_BUF = Buffer.alloc(0);

// ---------------------------------------------------------------- pkt-line argument parsers

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: ReturnType<typeof decodePktLines>['packets']): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data' || !inArgs) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  depth: number | null;
  shallow: string[];
  done: boolean;
}

function parseFetchArgs(packets: ReturnType<typeof decodePktLines>['packets']): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], depth: null, shallow: [], done: false };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data' || !inArgs) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5));
    else if (line.startsWith('have ')) args.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') args.done = true;
  }
  return args;
}

function parseFetchV0Request(packets: ReturnType<typeof decodePktLines>['packets']): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], depth: null, shallow: [], done: false };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0] ?? '');
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8));
      else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    } else {
      if (line.startsWith('have ')) args.haves.push(line.slice(5));
      else if (line === 'done') args.done = true;
    }
  }
  return args;
}
