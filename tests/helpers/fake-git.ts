import { zlibSync } from 'fflate';

/**
 * A git server small enough to live in a test.
 *
 * `tests/node/git-smart.spec.ts` drives the client against the real `git upload-pack` binary, which
 * is the authority on the format. This exists so the workers lane -- which has no child processes --
 * can still exercise the object end to end over a byte-identical wire.
 */

const encoder = new TextEncoder();

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

const hex = (buf: ArrayBuffer): string =>
	[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha(type: string, data: Uint8Array): Promise<string> {
	const header = encoder.encode(`${type} ${data.length}\0`);
	return hex(await crypto.subtle.digest('SHA-1', concat([header, data])));
}

function fromHex(s: string): Uint8Array {
	const out = new Uint8Array(s.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** the packfile object header: three type bits then a little-endian 7-bit size */
function objectHeader(kind: number, size: number): Uint8Array {
	const bytes: number[] = [];
	let byte = (kind << 4) | (size & 0b1111);
	let rest = size >> 4;
	while (rest > 0) {
		bytes.push(byte | 0x80);
		byte = rest & 0x7f;
		rest >>= 7;
	}
	bytes.push(byte);
	return new Uint8Array(bytes);
}

interface Obj {
	kind: number;
	data: Uint8Array;
}

/** builds the nested tree objects one flat path map implies */
async function buildTrees(
	files: Record<string, string | Uint8Array>,
	objects: Map<string, Obj>
): Promise<string> {
	const blobs = new Map<string, string>();
	for (const [path, body] of Object.entries(files)) {
		const data = typeof body === 'string' ? encoder.encode(body) : body;
		const id = await sha('blob', data);
		objects.set(id, { kind: 3, data });
		blobs.set(path, id);
	}

	const write = async (prefix: string): Promise<string> => {
		const entries: { name: string; mode: string; id: string }[] = [];
		const subdirs = new Set<string>();
		for (const path of Object.keys(files)) {
			if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
			const rel = prefix === '' ? path : path.slice(prefix.length + 1);
			const slash = rel.indexOf('/');
			if (slash === -1) {
				entries.push({ name: rel, mode: '100644', id: blobs.get(path) as string });
			} else {
				subdirs.add(rel.slice(0, slash));
			}
		}
		for (const dir of subdirs) {
			entries.push({
				name: dir,
				mode: '40000',
				id: await write(prefix === '' ? dir : `${prefix}/${dir}`)
			});
		}
		// git sorts tree entries by name, with a directory sorting as if it ended in a slash
		entries.sort((a, b) => {
			const an = a.mode === '40000' ? `${a.name}/` : a.name;
			const bn = b.mode === '40000' ? `${b.name}/` : b.name;
			return an < bn ? -1 : an > bn ? 1 : 0;
		});
		const data = concat(
			entries.map((e) => concat([encoder.encode(`${e.mode} ${e.name}\0`), fromHex(e.id)]))
		);
		const id = await sha('tree', data);
		objects.set(id, { kind: 2, data });
		return id;
	};

	return write('');
}

export interface FakeCommit {
	sha: string;
	pack: Uint8Array;
}

/** one commit carrying exactly these files, as a packfile a client can read */
export async function fakeCommit(
	files: Record<string, string | Uint8Array>,
	message = 'commit'
): Promise<FakeCommit> {
	const objects = new Map<string, Obj>();
	const tree = await buildTrees(files, objects);
	const body = encoder.encode(
		`tree ${tree}\nauthor drupflare <t@example.invalid> 1700000000 +0000\n` +
			`committer drupflare <t@example.invalid> 1700000000 +0000\n\n${message}\n`
	);
	const commitSha = await sha('commit', body);
	objects.set(commitSha, { kind: 1, data: body });

	const header = new Uint8Array(12);
	header.set(encoder.encode('PACK'));
	new DataView(header.buffer).setUint32(4, 2);
	new DataView(header.buffer).setUint32(8, objects.size);
	// annotated to `concat()`'s own parameter type: `new Uint8Array()` infers the narrower
	// `Uint8Array<ArrayBuffer>`, which fflate's `Uint8Array<ArrayBufferLike>` does not satisfy
	const parts: Uint8Array[] = [header];
	for (const object of objects.values()) {
		parts.push(objectHeader(object.kind, object.data.length), zlibSync(object.data));
	}
	// the trailing checksum; the client does not verify it and git's own reader is the oracle
	parts.push(new Uint8Array(20));
	return { sha: commitSha, pack: concat(parts) };
}

function pkt(text: string): Uint8Array {
	const body = encoder.encode(text);
	return concat([encoder.encode((body.length + 4).toString(16).padStart(4, '0')), body]);
}

export interface FakeRepo {
	/** ref name to sha, `refs/heads/...` and `refs/pull/N/head` alike */
	refs: Record<string, string>;
	/** commit sha to the packfile that carries it */
	packs: Record<string, Uint8Array>;
	defaultBranch?: string;
}

/** the `GET /info/refs?service=git-upload-pack` body a real server writes */
export function advertisement(repo: FakeRepo): Uint8Array {
	const names = Object.keys(repo.refs);
	const caps = `\0multi_ack thin-pack side-band-64k ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch ?? 'main'} agent=git/2.40.0`;
	const parts = [pkt('# service=git-upload-pack\n'), encoder.encode('0000')];
	names.forEach((name, i) => {
		parts.push(pkt(`${repo.refs[name]} ${name}${i === 0 ? caps : ''}\n`));
	});
	parts.push(encoder.encode('0000'));
	return concat(parts);
}

/** the `POST /git-upload-pack` response: the shallow preamble, a NAK, then the packfile */
export function uploadPackResponse(pack: Uint8Array, shallow: string): Uint8Array {
	return concat([pkt(`shallow ${shallow}\n`), encoder.encode('0000'), pkt('NAK\n'), pack]);
}

/** what the client asked for, so a stub can answer the right commit */
export function wantedSha(body: unknown): string {
	const text = new TextDecoder().decode(
		body instanceof Uint8Array ? body : new Uint8Array(body as ArrayBuffer)
	);
	return /want ([0-9a-f]{40})/.exec(text)?.[1] ?? '';
}

/** a `fetch` that serves one repository and records every call it received */
export function gitFetch(
	repo: FakeRepo,
	opts: { onCall?: (url: string, init?: RequestInit) => Response | null } = {}
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const custom = opts.onCall?.(url, init);
		if (custom !== null && custom !== undefined) return custom;
		if (url.includes('/info/refs')) {
			return new Response(advertisement(repo), { status: 200 });
		}
		if (url.endsWith('/git-upload-pack')) {
			const want = wantedSha(init?.body);
			const pack = repo.packs[want];
			if (pack === undefined) return new Response('unknown want', { status: 404 });
			return new Response(uploadPackResponse(pack, want), { status: 200 });
		}
		return new Response(JSON.stringify({ message: 'not stubbed' }), { status: 404 });
	}) as unknown as typeof fetch;
}
