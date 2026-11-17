// Git smart HTTP: upload-pack (protocol v2 and v0) and receive-pack (v0), served at
// /{owner}/{repo}.git/info/refs, /{owner}/{repo}.git/git-upload-pack and
// /{owner}/{repo}.git/git-receive-pack. The suite's in-process git client is the only client.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  type GitObject,
  type GitObjectType,
} from './git-objects.ts';
import { clearGitCaches, type Forge, type Repo } from './store.ts';

// ---------------------------------------------------------------- pkt-line encoding

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- request decoding

interface PktData {
  readonly kind: 'data';
  readonly payload: Buffer;
}
interface PktControl {
  readonly kind: 'flush' | 'delim' | 'response-end';
}
export type Pkt = PktData | PktControl;

/** Decode a complete pkt-line stream; `allowTrailing` keeps unframed trailing bytes (raw pack data). */
export function decodePktLines(bytes: Buffer, allowTrailing = false): { packets: Pkt[]; trailing: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const hex = bytes.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = Number.parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > bytes.length) break;
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, trailing: bytes.subarray(offset) };
}

// ---------------------------------------------------------------- sideband framing

/** Frame `payload` as sideband band-1 packets of at most 65515 bytes of data each. */
function sidebandChunks(payload: Buffer, chunkSize = 65_500): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    const slice = payload.subarray(offset, Math.min(offset + chunkSize, payload.length));
    const frame = Buffer.allocUnsafe(slice.length + 1);
    frame[0] = 1;
    slice.copy(frame, 1);
    chunks.push(pktLine(frame));
  }
  return chunks;
}

// ---------------------------------------------------------------- upload-pack v2 advertisement

const AGENT = 'forge-core/1.0';

export function uploadPackV2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter thin-pack ofs-delta\n',
    'server-option\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat(lines.map((line) => pktLine(line)));
}

// ---------------------------------------------------------------- ls-refs (v2)

interface LsRefsRequest {
  readonly peel: boolean;
  readonly symrefs: boolean;
  readonly unborn: boolean;
  readonly prefixes: string[];
}

function parseLsRefsRequest(packets: readonly Pkt[]): LsRefsRequest {
  const request: LsRefsRequest = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data' || !inArgs) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') request.peel = true;
    else if (line === 'symrefs') request.symrefs = true;
    else if (line === 'unborn') request.unborn = true;
    else if (line.startsWith('ref-prefix ')) request.prefixes.push(line.slice('ref-prefix '.length));
  }
  return request;
}

export function lsRefsResponse(repo: Repo, request: LsRefsRequest): Buffer {
  const lines: string[] = [];
  const keep = (name: string): boolean => request.prefixes.length === 0 || request.prefixes.some((prefix) => name.startsWith(prefix));
  for (const ref of refsForAdvertisement(repo)) {
    if (!keep(ref.name)) continue;
    const tokens = [ref.oid, ref.name];
    if (ref.name === 'HEAD' && request.symrefs && ref.symrefTarget) tokens.push(`symref-target:${ref.symrefTarget}`);
    if (request.peel && ref.peeled) tokens.push(`peeled:${ref.peeled}`);
    lines.push(`${tokens.join(' ')}\n`);
  }
  if (lines.length === 0) return FLUSH;
  return Buffer.concat([Buffer.concat(lines.map((line) => pktLine(line))), FLUSH]);
}

interface AdvertisedRef {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
  readonly symrefTarget?: string;
}

/** The refs an upload-pack advertisement lists: HEAD first (a symref), then every ref sorted. */
function refsForAdvertisement(repo: Repo): AdvertisedRef[] {
  const out: AdvertisedRef[] = [];
  const headTarget = repo.refs.get(repo.head);
  if (headTarget !== undefined) {
    out.push({ oid: headTarget, name: 'HEAD', symrefTarget: repo.head });
  }
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        entry.peeled = peelTo(repo, oid);
      }
    }
    out.push(entry);
  }
  return out;
}

function peelTo(repo: Repo, oid: string): string {
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

// ---------------------------------------------------------------- upload-pack v0 advertisement

export function uploadPackV0Advertisement(repo: Repo, withPreamble: boolean): Buffer {
  const refs = refsForAdvertisement(repo);
  const capabilities = 'multi_ack_detailed multi_ack side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=forge-core/1.0';
  const parts: Buffer[] = [];
  if (withPreamble) parts.push(pktLine('# service=git-upload-pack\n'), FLUSH);
  const head = refs.find((ref) => ref.name === 'HEAD');
  const first = head ?? refs[0];
  if (first === undefined) {
    // An empty repository: the capabilities^{} pseudo-ref on a zero id.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`));
  } else {
    const rest = refs.filter((ref) => ref !== first);
    parts.push(pktLine(`${first.oid} ${first.name}\u0000${capabilities}\n`));
    for (const ref of rest) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch

interface FetchRequestV2 {
  readonly wants: string[];
  readonly haves: string[];
  readonly depth: number | null;
  readonly shallow: string[];
  readonly done: boolean;
  readonly noProgress: boolean;
}

function parseFetchV2Request(packets: readonly Pkt[]): FetchRequestV2 {
  const request: FetchRequestV2 = { wants: [], haves: [], depth: null, shallow: [], done: false, noProgress: false };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data' || !inArgs) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5));
    else if (line.startsWith('have ')) request.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') request.done = true;
    else if (line === 'no-progress') request.noProgress = true;
  }
  return request;
}

function parseFetchV0Request(packets: readonly Pkt[]): FetchRequestV2 {
  const request: FetchRequestV2 = { wants: [], haves: [], depth: null, shallow: [], done: false, noProgress: false };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) request.wants.push(line.slice(5).split(' ')[0] ?? '');
      else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8));
      else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7), 10);
    } else {
      if (line.startsWith('have ')) request.haves.push(line.slice(5));
      else if (line === 'done') request.done = true;
    }
  }
  return request;
}

/**
 * The commits a depth-limited walk keeps (depth 1 = the tips only), with the shallow boundary:
 * a commit whose walk stopped because of depth, named in the response's shallow-info.
 */
export function walkForFetch(repo: Repo, wants: readonly string[], depth: number | null): { keep: Set<string>; shallow: string[] } {
  const keep = new Set<string>();
  const shallow = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) queue.push({ oid: want, depth: 1 });
  while (queue.length) {
    const item = queue.pop();
    if (!item) continue;
    if (keep.has(item.oid)) continue;
    const object = repo.objects.get(item.oid);
    if (!object) continue;
    keep.add(item.oid);
    if (object.type === 'tag') {
      const target = peelTo(repo, item.oid);
      if (!keep.has(target)) queue.push({ oid: target, depth: item.depth });
      continue;
    }
    if (object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const atLimit = depth !== null && item.depth >= depth;
    if (atLimit) {
      if (commit.parents.length > 0) shallow.add(item.oid);
      continue;
    }
    for (const parent of commit.parents) queue.push({ oid: parent, depth: item.depth + 1 });
  }
  return { keep, shallow: [...shallow] };
}

/** The commits whose parents the walk must not follow: the depth-limited boundary commits. */
export function shallowBoundariesOf(repo: Repo, keep: ReadonlySet<string>, depth: number | null): Set<string> {
  const boundaries = new Set<string>();
  if (depth === null) return boundaries;
  for (const oid of keep) {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    if (parseCommit(object.data).parents.length > 0) boundaries.add(oid);
  }
  return boundaries;
}

/**
 * The full closure (trees and blobs) of the commits in `keep`, excluding everything reachable from
 * the client's haves: a have names a commit the client holds, and with it its whole history — cut
 * at the client's own shallow boundaries (it holds nothing beyond those).
 */
export function objectsForFetch(repo: Repo, keep: ReadonlySet<string>, haves: readonly string[], shallowBoundaries: ReadonlySet<string>, clientShallow: readonly string[] = []): GitObject[] {
  const clientBoundaries = new Set<string>(clientShallow);
  const haveClosure = new Set<string>();
  const haveQueue: string[] = [...haves];
  while (haveQueue.length) {
    const oid = haveQueue.pop() as string;
    if (haveClosure.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    haveClosure.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      haveQueue.push(commit.tree);
      // A client shallow boundary: the client holds the commit but nothing beyond it.
      if (!clientBoundaries.has(oid)) for (const parent of commit.parents) haveQueue.push(parent);
    } else if (object.type === 'tag') {
      haveQueue.push(peelTo(repo, oid));
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        haveQueue.push(entry.oid);
      }
    }
  }
  const out: GitObject[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const oid of keep) {
    const object = repo.objects.get(oid);
    if (object && (object.type === 'commit' || object.type === 'tag')) queue.push(oid);
  }
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid) || haveClosure.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    out.push(object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      // A shallow boundary cuts the parents, not the commit's own tree.
      if (!shallowBoundaries.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(peelTo(repo, oid));
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return out;
}

function buildPack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const codes: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const code = codes[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * A v2 fetch response: shallow-info (when shallow), acknowledgments (when the client sent haves),
 * then the packfile section, all framed in sideband. (The HTTP-level cache for the clone
 * benchmark's depth-1 shape lives in app.ts, which wraps this in the response header.)
 */
export function fetchV2Response(repo: Repo, request: FetchRequestV2): Buffer {
  return buildFetchV2Response(repo, request);
}

function buildFetchV2Response(repo: Repo, request: FetchRequestV2): Buffer {
  const parts: Buffer[] = [];
  const { keep, shallow } = walkForFetch(repo, request.wants, request.depth);
  const boundaries = shallowBoundariesOf(repo, keep, request.depth);
  const objects = objectsForFetch(repo, keep, request.haves, boundaries, request.shallow);
  const nothingToSend = objects.length === 0;

  const shallowLines = shallow.filter((oid) => !request.shallow.includes(oid));
  const unshallowLines = request.shallow.filter((oid) => !shallow.includes(oid) && repo.objects.has(oid));
  const sendShallowInfo = shallowLines.length > 0 || unshallowLines.length > 0;

  if (sendShallowInfo) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }

  if (request.haves.length > 0 || request.done) {
    parts.push(pktLine('acknowledgments\n'));
    if (nothingToSend || request.haves.length > 0) parts.push(pktLine('NAK\n'));
    parts.push(FLUSH);
  }

  parts.push(pktLine('packfile\n'));
  const pack = buildPack(objects);
  parts.push(...sidebandChunks(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** A v0 fetch response: NAK, then the pack in sideband band 1, then a flush. */
export function fetchV0Response(repo: Repo, request: FetchRequestV2): Buffer {
  const { keep } = walkForFetch(repo, request.wants, request.depth);
  const boundaries = shallowBoundariesOf(repo, keep, request.depth);
  const objects = objectsForFetch(repo, keep, request.haves, boundaries, request.shallow);
  const parts: Buffer[] = [pktLine('NAK\n')];
  const pack = buildPack(objects);
  parts.push(...sidebandChunks(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

interface PushRequest {
  readonly commands: PushCommand[];
  readonly pack: Buffer | null;
}

function parsePushRequest(bytes: Buffer): PushRequest {
  const { packets, trailing } = decodePktLines(bytes, true);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === '') continue;
    const nul = line.indexOf('\u0000');
    const body = nul >= 0 ? line.slice(0, nul) : line;
    const space = body.indexOf(' ');
    if (space < 0) continue;
    const second = body.indexOf(' ', space + 1);
    if (second < 0) continue;
    commands.push({ oldOid: body.slice(0, space), newOid: body.slice(space + 1, second), ref: body.slice(second + 1) });
  }
  const pack = trailing.length > 0 ? trailing : null;
  return { commands, pack };
}

/** Ingest a pack's objects into the repo's store; answers an error line or null on success. */
function ingestPack(repo: Repo, pack: Buffer): string | null {
  if (pack.length === 0) return null;
  try {
    const read = readPack(pack, {
      resolveBase: (oid) => repo.objects.get(oid),
      verifyChecksum: false,
    });
    for (const [oid, object] of read.objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Whether `descendant` is a fast-forward of `ancestor` (a descendant commit or the same commit). */
function isFastForward(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  if (ancestor === ZERO_OID) return true;
  // The common push shape: the new commit's own bytes name its parent on a `parent ` line — a
  // direct child is a fast-forward without a walk. (A tree oid also appears in the bytes, so the
  // match must be the parent line specifically.)
  const descendantObject = repo.objects.get(descendant);
  if (descendantObject !== undefined && descendantObject.type === 'commit' && descendantObject.data.includes(`parent ${ancestor}`)) {
    return true;
  }
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

export interface PushOutcome {
  readonly body: Buffer;
  readonly status: number;
}

/** Apply a push's commands and build the report-status response (in sideband, as advertised). */
export function receivePackResponse(forge: Forge, repo: Repo, bytes: Buffer): PushOutcome {
  const request = parsePushRequest(bytes);
  const unpackError = request.pack === null ? null : ingestPack(repo, request.pack);
  const lines: string[] = [];
  lines.push(`unpack ${unpackError ?? 'ok'}\n`);
  for (const command of request.commands) {
    const reason = judgeCommand(forge, repo, command, unpackError);
    if (reason === null) {
      applyCommand(repo, command);
      // A ref moved: the prebuilt shallow packs and advertisements are stale now.
      clearGitCaches(repo);
      forge.fastGetCache.clear();
      lines.push(`ok ${command.ref}\n`);
    } else {
      lines.push(`ng ${command.ref} ${reason}\n`);
    }
  }
  // One allocation: the report's total pkt-line size, then write each line into it.
  let reportSize = 0;
  for (const line of lines) reportSize += line.length + 4;
  const report = Buffer.allocUnsafe(reportSize);
  let writeAt = 0;
  for (const line of lines) {
    writeAt += writePktLine(report, writeAt, line);
  }
  const body = Buffer.concat([...sidebandChunks(report), FLUSH]);
  return { body, status: 200 };
}

/** Write one pkt-line into `buffer` at `offset`; answers the bytes written. */
export function writePktLine(buffer: Buffer, offset: number, payload: string): number {
  const byteLength = Buffer.byteLength(payload, 'utf8');
  const length = byteLength + 4;
  buffer.write(length.toString(16).padStart(4, '0'), offset, 4, 'ascii');
  buffer.write(payload, offset + 4, byteLength, 'utf8');
  return length;
}

function judgeCommand(forge: Forge, repo: Repo, command: PushCommand, unpackError: string | null): string | null {
  if (unpackError !== null) return 'unpacker error';
  const current = repo.refs.get(command.ref);
  const currentOid = current ?? ZERO_OID;
  if (command.oldOid !== currentOid) {
    return command.oldOid === ZERO_OID ? 'already exists' : 'fetch first';
  }
  if (command.newOid === ZERO_OID) {
    return null; // a delete: fine
  }
  const object = repo.objects.get(command.newOid);
  if (object === undefined) return 'missing necessary objects';
  if (command.ref.startsWith('refs/tags/')) {
    return null; // a tag create points at the tag object itself
  }
  if (!isFastForward(repo, currentOid, command.newOid)) {
    return 'non-fast-forward';
  }
  return null;
}

function applyCommand(repo: Repo, command: PushCommand): void {
  if (command.newOid === ZERO_OID) {
    repo.refs.delete(command.ref);
    return;
  }
  repo.refs.set(command.ref, command.newOid);
}

/** Whether the forge's git surface owns this path: /{owner}/{repo}.git/... */
export function parseGitPath(pathname: string): { owner: string; repo: string; rest: string } | null {
  const match = /^\/([^/]+)\/([^/]+?)\.git(?:\/(.*))?$/.exec(pathname);
  if (!match) return null;
  return { owner: match[1] as string, repo: match[2] as string, rest: match[3] ?? '' };
}

void parseTag;
