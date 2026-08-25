import { inflateZlib } from './inflate-raw.js';

/**
 * Git's smart HTTP protocol, which is the transport every remote speaks.
 *
 * The provider adapters in `git-provider.ts` are a convenience over three APIs; this is the floor
 * underneath them, so a self-hosted Gitea, a bare repository behind nginx or a mirror all work.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// #region pkt-line

/** one pkt-line: four hex length digits covering themselves, then the payload */
export function pktLine(payload: string): Uint8Array {
	const body = encoder.encode(payload);
	const head = encoder.encode((body.length + 4).toString(16).padStart(4, '0'));
	const out = new Uint8Array(head.length + body.length);
	out.set(head);
	out.set(body, head.length);
	return out;
}

/** the flush packet, which ends a section */
export const FLUSH = encoder.encode('0000');

export interface PktLine {
	/** null for a flush (0000) or delimiter (0001) packet */
	text: string | null;
	kind: 'data' | 'flush' | 'delim';
}

/** reads pkt-lines from `start` until a stop, returning where the framing ended */
export function readPktLines(
	src: Uint8Array,
	start = 0,
	stop?: (line: PktLine) => boolean
): { lines: PktLine[]; end: number } {
	const lines: PktLine[] = [];
	let at = start;
	while (at + 4 <= src.length) {
		const header = decoder.decode(src.subarray(at, at + 4));
		if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
		const length = parseInt(header, 16);
		if (length === 0) {
			at += 4;
			lines.push({ text: null, kind: 'flush' });
			if (stop?.({ text: null, kind: 'flush' })) return { lines, end: at };
			continue;
		}
		if (length === 1) {
			at += 4;
			lines.push({ text: null, kind: 'delim' });
			continue;
		}
		if (length < 4 || at + length > src.length) break;
		const line: PktLine = {
			text: decoder.decode(src.subarray(at + 4, at + length)),
			kind: 'data'
		};
		at += length;
		lines.push(line);
		if (stop?.(line)) return { lines, end: at };
	}
	return { lines, end: at };
}

// #endregion

// #region ref discovery

export interface Advertisement {
	/** ref name to sha, `HEAD` included when the server advertises it */
	refs: Map<string, string>;
	capabilities: string[];
	/** what `HEAD` points at, from the `symref=` capability */
	defaultBranch: string | null;
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * Parses `GET /info/refs?service=git-upload-pack`.
 *
 * Tolerates the `# service=` banner being present or absent -- a dumb-HTTP mirror omits it, and the
 * refs after it are the same either way.
 */
export function parseAdvertisement(body: Uint8Array): Advertisement {
	const refs = new Map<string, string>();
	let capabilities: string[] = [];
	let defaultBranch: string | null = null;

	for (const line of readPktLines(body).lines) {
		if (line.text === null) continue;
		const text = line.text.replace(/\n$/, '');
		if (text.startsWith('#')) continue;
		if (text.startsWith('version ')) continue;

		const [refPart = '', capPart] = text.split('\0');
		if (capPart !== undefined && capabilities.length === 0) {
			capabilities = capPart.split(' ').filter((c) => c !== '');
			for (const cap of capabilities) {
				if (cap.startsWith('symref=HEAD:refs/heads/')) {
					defaultBranch = cap.slice('symref=HEAD:refs/heads/'.length);
				}
			}
		}
		const space = refPart.indexOf(' ');
		if (space !== 40) continue;
		const sha = refPart.slice(0, 40);
		const name = refPart.slice(41);
		// a peeled tag: `refs/tags/v1^{}` is the commit the tag points at, which is what we want
		if (SHA.test(sha) && name !== '') refs.set(name, sha);
	}
	return { refs, capabilities, defaultBranch };
}

/** the sha one branch is at, tolerating a caller who passed a full ref or a bare name */
export function refSha(ad: Advertisement, branch: string): string | null {
	return (
		ad.refs.get(branch) ??
		ad.refs.get(`refs/heads/${branch}`) ??
		ad.refs.get(`refs/tags/${branch}^{}`) ??
		ad.refs.get(`refs/tags/${branch}`) ??
		(SHA.test(branch) ? branch : null)
	);
}

/** branch names, without the `refs/heads/` prefix */
export function branchNames(ad: Advertisement): string[] {
	return [...ad.refs.keys()]
		.filter((r) => r.startsWith('refs/heads/'))
		.map((r) => r.slice('refs/heads/'.length))
		.sort();
}

/** open pull/merge request head refs, which every provider publishes under its own namespace */
export function requestRefs(ad: Advertisement): { id: string; ref: string; sha: string }[] {
	const out: { id: string; ref: string; sha: string }[] = [];
	for (const [ref, sha] of ad.refs) {
		const match =
			/^refs\/pull\/(\d+)\/head$/.exec(ref) ??
			/^refs\/merge-requests\/(\d+)\/head$/.exec(ref);
		if (match) out.push({ id: match[1] as string, ref, sha });
	}
	return out.sort((a, b) => Number(b.id) - Number(a.id));
}

// #endregion

// #region fetching

/**
 * The `POST /git-upload-pack` body for a shallow single-commit fetch.
 *
 * `side-band-64k` is deliberately NOT requested: without it the server writes the packfile as raw
 * bytes after the NAK instead of framing it, which removes a demux stage and cannot be sent anyway.
 */
export function uploadPackRequest(want: string, depth = 1): Uint8Array {
	const caps = 'ofs-delta no-progress agent=drupflare/1';
	const parts = [pktLine(`want ${want} ${caps}\n`)];
	if (depth > 0) parts.push(pktLine(`deepen ${depth}\n`));
	parts.push(FLUSH, pktLine('done\n'));

	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** skips the shallow/NAK preamble and returns where the packfile begins */
export function packOffset(body: Uint8Array): number {
	const magic = (at: number) =>
		body[at] === 0x50 &&
		body[at + 1] === 0x41 &&
		body[at + 2] === 0x43 &&
		body[at + 3] === 0x4b;
	if (magic(0)) return 0;

	let at = 0;
	while (at + 4 <= body.length) {
		if (magic(at)) return at;
		const { lines, end } = readPktLines(body, at, () => true);
		if (end === at) break;
		at = end;
		const text = lines[lines.length - 1]?.text ?? null;
		if (text !== null && /^(NAK|ACK)/.test(text) && magic(at)) return at;
	}
	throw new Error('git: no packfile in the upload-pack response');
}

// #endregion

// #region packfile

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const TYPE_NAME: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface GitObject {
	type: GitObjectType;
	data: Uint8Array;
}

interface RawEntry {
	offset: number;
	kind: number;
	payload: Uint8Array;
	baseOffset?: number;
	baseSha?: string;
}

function readSize(src: Uint8Array, at: number): { kind: number; size: number; next: number } {
	let byte = src[at++] as number;
	const kind = (byte >> 4) & 0b111;
	let size = byte & 0b1111;
	let shift = 4;
	while ((byte & 0x80) !== 0) {
		byte = src[at++] as number;
		size |= (byte & 0x7f) << shift;
		shift += 7;
	}
	return { kind, size, next: at };
}

/** the delta base offset encoding, which is not the same varint as everything else in a packfile */
function readOffset(src: Uint8Array, at: number): { value: number; next: number } {
	let byte = src[at++] as number;
	let value = byte & 0x7f;
	while ((byte & 0x80) !== 0) {
		byte = src[at++] as number;
		value = ((value + 1) << 7) | (byte & 0x7f);
	}
	return { value, next: at };
}

/** the little-endian 7-bit varint a delta header uses for its two sizes */
function readVarint(src: Uint8Array, at: number): { value: number; next: number } {
	let value = 0;
	let shift = 0;
	for (;;) {
		const byte = src[at++] as number;
		value |= (byte & 0x7f) << shift;
		shift += 7;
		if ((byte & 0x80) === 0) return { value, next: at };
	}
}

/** applies one delta against its base, per the copy/insert instruction stream */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
	const src = readVarint(delta, 0);
	if (src.value !== base.length) throw new Error('git: delta base size does not match');
	const target = readVarint(delta, src.next);
	const out = new Uint8Array(target.value);

	let at = target.next;
	let written = 0;
	while (at < delta.length) {
		const op = delta[at++] as number;
		if ((op & 0x80) !== 0) {
			let offset = 0;
			let size = 0;
			if (op & 0x01) offset |= delta[at++] as number;
			if (op & 0x02) offset |= (delta[at++] as number) << 8;
			if (op & 0x04) offset |= (delta[at++] as number) << 16;
			if (op & 0x08) offset |= (delta[at++] as number) << 24;
			if (op & 0x10) size |= delta[at++] as number;
			if (op & 0x20) size |= (delta[at++] as number) << 8;
			if (op & 0x40) size |= (delta[at++] as number) << 16;
			if (size === 0) size = 0x10000;
			out.set(base.subarray(offset, offset + size), written);
			written += size;
		} else if (op !== 0) {
			out.set(delta.subarray(at, at + op), written);
			written += op;
			at += op;
		} else {
			throw new Error('git: reserved delta opcode');
		}
	}
	if (written !== out.length) throw new Error('git: delta produced the wrong length');
	return out;
}

const HEX = (buf: ArrayBuffer): string =>
	[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** hex of a slice, without the buffer copy `.buffer.slice()` would need */
function hexOf(src: Uint8Array, from: number, length: number): string {
	let out = '';
	for (let i = 0; i < length; i++) out += (src[from + i] as number).toString(16).padStart(2, '0');
	return out;
}

/** git's object id: sha1 over `"<type> <len>\0"` and the content */
export async function objectSha(type: GitObjectType, data: Uint8Array): Promise<string> {
	const header = encoder.encode(`${type} ${data.length}\0`);
	const full = new Uint8Array(header.length + data.length);
	full.set(header);
	full.set(data, header.length);
	return HEX(await crypto.subtle.digest('SHA-1', full));
}

export interface Packfile {
	/** every object, keyed by its sha */
	objects: Map<string, GitObject>;
	count: number;
}

/**
 * Reads a packfile into an object map, resolving both delta forms.
 *
 * Deltas are resolved to a fixpoint rather than in one pass because a `ref-delta` may name a base
 * that appears later in the stream.
 */
export async function parsePackfile(pack: Uint8Array, at = 0): Promise<Packfile> {
	if (decoder.decode(pack.subarray(at, at + 4)) !== 'PACK') {
		throw new Error('git: not a packfile');
	}
	const view = new DataView(pack.buffer, pack.byteOffset);
	const version = view.getUint32(at + 4);
	if (version !== 2 && version !== 3) throw new Error(`git: packfile version ${version}`);
	const count = view.getUint32(at + 8);

	const raw: RawEntry[] = [];
	let cursor = at + 12;
	for (let i = 0; i < count; i++) {
		const offset = cursor;
		const head = readSize(pack, cursor);
		cursor = head.next;

		let baseOffset: number | undefined;
		let baseSha: string | undefined;
		if (head.kind === 6) {
			const rel = readOffset(pack, cursor);
			baseOffset = offset - rel.value;
			cursor = rel.next;
		} else if (head.kind === 7) {
			baseSha = hexOf(pack, cursor, 20);
			cursor += 20;
		}

		const inflated = inflateZlib(pack, cursor, head.size);
		cursor += inflated.consumed;
		raw.push({
			offset,
			kind: head.kind,
			payload: inflated.data,
			...(baseOffset === undefined ? {} : { baseOffset }),
			...(baseSha === undefined ? {} : { baseSha })
		});
	}

	const objects = new Map<string, GitObject>();
	const byOffset = new Map<number, GitObject>();
	let pending = raw.filter((entry) => {
		const name = TYPE_NAME[entry.kind];
		if (name === undefined) return true;
		byOffset.set(entry.offset, { type: name, data: entry.payload });
		return false;
	});
	for (const [, object] of byOffset)
		objects.set(await objectSha(object.type, object.data), object);

	while (pending.length > 0) {
		const next: RawEntry[] = [];
		for (const entry of pending) {
			const base =
				entry.baseOffset !== undefined
					? byOffset.get(entry.baseOffset)
					: objects.get(entry.baseSha ?? '');
			if (base === undefined) {
				next.push(entry);
				continue;
			}
			const resolved: GitObject = {
				type: base.type,
				data: applyDelta(base.data, entry.payload)
			};
			byOffset.set(entry.offset, resolved);
			objects.set(await objectSha(resolved.type, resolved.data), resolved);
		}
		if (next.length === pending.length) throw new Error('git: a delta base is missing');
		pending = next;
	}

	return { objects, count };
}

// #endregion

// #region walking a commit

/** the tree sha out of a commit object */
export function commitTree(commit: Uint8Array): string | null {
	const match = /^tree ([0-9a-f]{40})$/m.exec(decoder.decode(commit.subarray(0, 512)));
	return match?.[1] ?? null;
}

export interface TreeEntry {
	mode: string;
	name: string;
	sha: string;
}

/** one tree object; entries are `<mode> <name>\0<20 raw sha bytes>` with no separator */
export function parseTree(tree: Uint8Array): TreeEntry[] {
	const entries: TreeEntry[] = [];
	let at = 0;
	while (at < tree.length) {
		let space = at;
		while (space < tree.length && tree[space] !== 0x20) space++;
		let nul = space;
		while (nul < tree.length && tree[nul] !== 0x00) nul++;
		if (nul + 21 > tree.length) break;
		entries.push({
			mode: decoder.decode(tree.subarray(at, space)),
			name: decoder.decode(tree.subarray(space + 1, nul)),
			sha: hexOf(tree, nul + 1, 20)
		});
		at = nul + 21;
	}
	return entries;
}

export interface WorkingFile {
	path: string;
	bytes: Uint8Array;
	/** `100755` for an executable, which Drupal never needs but a diff should still notice */
	mode: string;
}

/**
 * Flattens a commit into the files it contains.
 *
 * Submodules (`160000`) and symlinks (`120000`) are skipped: neither has content in this pack, and a
 * symlink target written as a regular file is a silently wrong tree.
 */
export function readWorkingTree(pack: Packfile, commitSha: string): WorkingFile[] {
	const commit = pack.objects.get(commitSha);
	if (commit === undefined) throw new Error(`git: ${commitSha.slice(0, 12)} is not in the pack`);
	const rootSha = commit.type === 'commit' ? commitTree(commit.data) : commitSha;
	if (rootSha === null) throw new Error('git: the commit names no tree');

	const files: WorkingFile[] = [];
	const walk = (sha: string, prefix: string): void => {
		const tree = pack.objects.get(sha);
		if (tree === undefined || tree.type !== 'tree') return;
		for (const entry of parseTree(tree.data)) {
			const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (entry.mode === '40000' || entry.mode === '040000') {
				walk(entry.sha, path);
				continue;
			}
			if (entry.mode !== '100644' && entry.mode !== '100755') continue;
			const blob = pack.objects.get(entry.sha);
			if (blob !== undefined) files.push({ path, bytes: blob.data, mode: entry.mode });
		}
	};
	walk(rootSha, '');
	return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

// #endregion

// #region the two HTTP calls

export interface SmartRemote {
	/** the clone URL, with or without `.git` */
	url: string;
	/** Basic auth, which is what every provider accepts over HTTPS for a PAT */
	username?: string;
	token?: string;
}

function smartHeaders(remote: SmartRemote, extra: Record<string, string> = {}): Headers {
	const headers = new Headers({ 'user-agent': 'git/2.40.0 drupflare', ...extra });
	if (remote.token) {
		const user = remote.username && remote.username !== '' ? remote.username : 'x-access-token';
		headers.set('authorization', `Basic ${btoa(`${user}:${remote.token}`)}`);
	}
	return headers;
}

/** the base URL git talks to, which is the clone URL with any trailing slash and `.git` normalised */
export function smartBase(url: string): string {
	const trimmed = url.trim().replace(/\/+$/, '');
	return trimmed.endsWith('.git') ? trimmed : `${trimmed}.git`;
}

/** the poll: a few hundred bytes, and no packfile when nothing moved */
export async function discoverRefs(
	remote: SmartRemote,
	fetchImpl: typeof fetch = fetch
): Promise<Advertisement> {
	const url = `${smartBase(remote.url)}/info/refs?service=git-upload-pack`;
	const res = await fetchImpl(url, { headers: smartHeaders(remote) });
	if (!res.ok) throw new Error(`git: ref discovery answered ${res.status}`);
	return parseAdvertisement(new Uint8Array(await res.arrayBuffer()));
}

/** the fetch: one commit deep, one branch, and the working tree it carries */
export async function fetchCommit(
	remote: SmartRemote,
	sha: string,
	fetchImpl: typeof fetch = fetch,
	depth = 1
): Promise<WorkingFile[]> {
	const res = await fetchImpl(`${smartBase(remote.url)}/git-upload-pack`, {
		method: 'POST',
		headers: smartHeaders(remote, {
			'content-type': 'application/x-git-upload-pack-request',
			accept: 'application/x-git-upload-pack-result'
		}),
		body: uploadPackRequest(sha, depth)
	});
	if (!res.ok) throw new Error(`git: upload-pack answered ${res.status}`);
	const body = new Uint8Array(await res.arrayBuffer());
	const pack = await parsePackfile(body, packOffset(body));
	return readWorkingTree(pack, sha);
}

// #endregion
