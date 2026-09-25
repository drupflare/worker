import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { DRIVER_DIGEST } from '../src/ops/driver-digest.ts';
import { SHIPPED_LOCK_VERSIONS } from '../src/ops/shipped-lock.ts';
import { opcacheSourceKey } from '../src/runtime/opcache.ts';
import { withWrangler } from './bake-container.ts';
import { layerPath, serialiseOpcachePack, systemIdOf } from './opcache-layer.ts';

/**
 * Bakes the opcache file cache the `pack` arm reads, on the interpreter that ships.
 *
 *   bun scripts/bake-opcache.ts
 *
 * A local `wrangler dev` runs in the `file` arm, which writes one `.bin` per compiled script under
 * `/tmp/<system id>/`; a claimed site renders the paths a cold visitor meets, and `/opcache` reads
 * the cache back out. It is packed in the per-file format `core.pf` uses, so the lazy mount can take
 * it as a second layer, and `src/ops/opcache-pack.ts` records the system id the mount links to.
 *
 * Nothing under `sites/` is packed. `settings.php` compiles with the bake site's `hash_salt` in it,
 * and this pack is served as a public asset.
 *
 * Not a build step: `pack` is opt-in (`src/runtime/opcache.ts` has the deployed A/B), so nothing runs
 * this by default and the descriptor stays null. Re-run it after any driver or composer change; the
 * mount refuses a layer whose recorded sources no longer match.
 */

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'assets', 'drupal-opc');
const DESCRIPTOR = resolve(ROOT, 'src', 'ops', 'opcache-pack.ts');
const SITE = `opcache-bake-${Date.now().toString(36)}`;
const HOST = { Host: `${SITE}.localhost` };

/** what a cold visitor and a cold editor reach first, one path per render */
const PATHS = ['/', '/user/login', '/user/password', '/node', '/filter/tips', '/rss.xml'] as const;

async function capture(base: string): Promise<Map<string, Uint8Array>> {
	const migrated = await fetch(`${base}/migrate?all=1&prefill=0`, { headers: HOST });
	if (!migrated.ok)
		throw new Error(`migrate answered ${migrated.status}: ${await migrated.text()}`);
	const claimed = await fetch(`${base}/firstrun`, {
		method: 'POST',
		headers: { ...HOST, 'content-type': 'application/json' },
		body: JSON.stringify({ adminPass: 'cfw-Bake-Opcache-5501', siteName: 'Bake' })
	});
	if (!claimed.ok)
		throw new Error(`firstrun answered ${claimed.status}: ${await claimed.text()}`);
	for (const path of PATHS) {
		const served = await fetch(`${base}/serve?path=${encodeURIComponent(path)}&edge=0`, {
			headers: HOST
		});
		await served.text();
		await (await fetch(`${base}/fill`, { headers: HOST })).text();
	}
	const listed = (await (await fetch(`${base}/opcache?op=list`, { headers: HOST })).json()) as {
		mode: string;
		files: { path: string; bytes: number }[];
	};
	if (listed.mode !== 'file') throw new Error(`the bake ran in the ${listed.mode} arm, not file`);
	const out = new Map<string, Uint8Array>();
	for (const { path } of listed.files) {
		const into = layerPath(path);
		if (into === null) continue;
		const res = await fetch(`${base}/opcache?op=read&path=${encodeURIComponent(path)}`, {
			headers: HOST
		});
		if (!res.ok) throw new Error(`reading ${path} answered ${res.status}`);
		out.set(into, new Uint8Array(await res.arrayBuffer()));
	}
	return out;
}

async function main(): Promise<void> {
	const state = await mkdtemp(join(tmpdir(), 'opcache-bake-'));
	let files: Map<string, Uint8Array>;
	try {
		files = await withWrangler(state, capture, ['OPCACHE_MODE:file']);
	} finally {
		await rm(state, { recursive: true, force: true });
	}
	if (files.size === 0) throw new Error('the bake captured no cache files');

	const index: { p: string; o: number; c: number; l: number; m: number; s?: number }[] = [];
	const parts: Uint8Array[] = [];
	let offset = 0;
	let raw = 0;
	for (const [p, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const deflated = deflateRawSync(bytes, { level: 9 });
		const stored = deflated.length >= bytes.length;
		const payload = stored ? bytes : deflated;
		index.push({
			p,
			o: offset,
			c: payload.length,
			l: bytes.length,
			m: 0,
			...(stored ? { s: 1 } : {})
		});
		parts.push(payload);
		offset += payload.length;
		raw += bytes.length;
	}
	await mkdir(OUT, { recursive: true });
	await writeFile(join(OUT, 'core.pf.bin'), Buffer.concat(parts));
	await writeFile(join(OUT, 'core.pf.json'), JSON.stringify(index));
	const systemId = systemIdOf(index.map((e) => e.p));
	await writeFile(
		DESCRIPTOR,
		serialiseOpcachePack({
			systemId,
			files: index.length,
			bytes: offset,
			source: opcacheSourceKey(DRIVER_DIGEST, SHIPPED_LOCK_VERSIONS)
		})
	);
	console.log(
		JSON.stringify({ systemId, files: index.length, rawBytes: raw, packedBytes: offset })
	);
}

if (import.meta.main) await main();
