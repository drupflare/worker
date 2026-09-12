/**
 * Rewrites the packed `cache_container` row so the pack and the database agree on the dependency
 * set.
 *
 * `DrupalKernel::getContainerCacheKey()` folds `DrupalInstalled::VERSIONS_HASH` into the cid, so any
 * composer change in `drupal-src` moves it -- including `composer require --dev drupal/<module>`,
 * which is how the contrib lane gets its fixture. The pack is rebuilt from that tree and carries the
 * new hash; `assets/drupal/site.sqlite` arrives from the CDN carrying the old one. The first
 * `$kernel->boot()` on every site then MISSES and rebuilds a 482 KB container, which is 1,024 ms
 * against 86 and ~3.7x the heap image.
 *
 * THE ROW CANNOT BE RETARGETED BY EDITING THE CID. The compiled container embeds the absolute root
 * it was built against -- 27 occurrences of the build machine's path in a natively-baked row -- so a
 * row baked under `php` on Darwin is wrong for the runtime no matter what its key says. It has to
 * come from a boot where the root IS `/drupal`, which means a boot through the interpreter.
 *
 * So this drives the documented capture rather than asking for it: `wrangler dev --local`, migrate a
 * throwaway site, read the row the boot rebuilt, write it back. Run `bun run assets:sql` afterwards
 * to re-chunk the database the Durable Object replays.
 */

import { Database } from 'bun:sqlite';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { markHydrating } from './hydrating.js';
import { PACK_BIN, packVersionsHash } from './pack-hash.js';

const ROOT = resolve(import.meta.dirname, '..');
const SQLITE = resolve(ROOT, 'assets', 'drupal', 'site.sqlite');
const CHUNKS = resolve(ROOT, 'assets', 'drupal-sql', 'manifest.json');
const PORT = Number(process.env.CONTAINER_BAKE_PORT ?? 8799);
const SITE = 'container-bake';

/**
 * Chunks the database when nothing has yet, because `/migrate` replays the CHUNKS rather than the
 * file.
 *
 * `build-local.ts` runs `sql` after `container`, and `assets:container` chunks only once
 * `bake-container` has returned -- so on a clean checkout there is no `assets/drupal-sql/` here at
 * all. Measured 2026-09-12: `/migrate` answered 200 in 54 ms having replayed nothing, `/fill` drained
 * `{"filled":null,"remaining":0}`, and the read came back `400` because no `cache_container` existed.
 * Every dev machine carries the chunks from an earlier build, which is why only CI saw it.
 *
 * The stale row inside them is not a problem and is the point: the boot misses on it and rebuilds the
 * container this script exists to capture.
 */
function ensureChunks(): void {
	if (existsSync(CHUNKS)) return;
	console.log('no assets/drupal-sql yet; chunking so the object has a migration to replay');
	execFileSync(
		'node',
		['scripts/pack-sql.ts', 'assets/drupal/site.sqlite', 'assets/drupal-sql'],
		{
			cwd: ROOT,
			stdio: 'inherit'
		}
	);
}

/**
 * Whether a cid came from the RUNTIME rather than from a native bake.
 *
 * THE HASH ALONE IS NOT ENOUGH, and checking only the hash shipped a broken row. `install-site-db.php`
 * bakes on the build machine, so the database it produces already carries a `cache_container` row
 * with the right `VERSIONS_HASH` and the wrong everything else -- `Darwin` and an absolute
 * `sites/build/services.yml`. The early exit below read the hash, matched, and left it in place.
 *
 * `getContainerCacheKey()` folds the OS and the services.yml paths in beside the hash, so both are
 * readable from the cid and neither needs the row opened.
 */
function runtimeShaped(cid: string): boolean {
	return cid.includes(':Linux:') && cid.includes('/drupal/sites/default/services.yml');
}

function currentCid(): string | null {
	const db = new Database(SQLITE);
	const row = db.query('SELECT cid FROM cache_container').get() as { cid: string } | null;
	db.close();
	return row?.cid ?? null;
}

/**
 * Waits for `wrangler dev --local` to bind, which on a cold runner is not quick.
 *
 * 120 s WAS NOT ENOUGH IN CI and the failure read as a hang. A cold miniflare compiles the 13.4 MB
 * interpreter before it answers anything, and a shared runner with no warm cache does that a good
 * deal slower than a laptop -- the browser lane failed here on 2026-09-11 while `wrangler` had
 * printed its banner and was still starting. Raised to 300 s, which is bounded by the job timeout
 * rather than by this number.
 *
 * The message now says how long it actually waited and repeats wrangler's own output, because
 * "nothing answered" names neither the cause nor the thing to look at next.
 */
async function waitForPort(
	proc: { killed: boolean },
	url: string,
	log: () => string = () => ''
): Promise<void> {
	const started = Date.now();
	for (let i = 0; i < 600; i++) {
		if (proc.killed) throw new Error('wrangler exited before it served');
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
			if (res.status > 0) return;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	const tail = log().split('\n').slice(-25).join('\n');
	throw new Error(
		`nothing answered ${url} within ${Math.round((Date.now() - started) / 1000)}s.\n` +
			`wrangler said:\n${tail || '(nothing captured)'}`
	);
}

type CapturedRow = {
	cid: string;
	expire: number;
	created: number;
	serialized: number;
	tags: string;
	checksum: string;
	hexdata: string;
};

async function capture(base: string, wanted: string): Promise<CapturedRow> {
	const host = { Host: `${SITE}.localhost` };

	const migrated = await fetch(`${base}/migrate?all=1&prefill=0`, { headers: host });
	const migrateBody = await migrated.text();
	if (!migrated.ok) throw new Error(`migrate answered ${migrated.status}: ${migrateBody}`);

	// a real render is what boots the kernel, and it takes both calls: the serve QUEUES `/` and
	// answers 503 warming, the fill drains that queue and renders inline. `/fill` alone returns in
	// milliseconds having booted nothing, and the row read after it is just the migrated one
	const queued = await fetch(`${base}/serve?path=/&edge=0`, { headers: host });
	if (queued.status !== 503 && !queued.ok) {
		throw new Error(`serve answered ${queued.status}: ${await queued.text()}`);
	}
	const filled = await fetch(`${base}/fill`, { headers: host });
	const fillBody = await filled.text();
	if (!filled.ok) throw new Error(`fill answered ${filled.status}: ${fillBody}`);
	console.log(`fill: ${fillBody.slice(0, 200)}`);
	// a fill that renders nothing boots no kernel, so the read below finds no container and answers
	// 400 -- which names sqlite rather than the empty queue that caused it
	if ((JSON.parse(fillBody) as { filled?: unknown }).filled === null) {
		throw new Error(
			`the serve queued nothing, so no render booted a kernel: ${fillBody}. ` +
				'The object has no site to render; check that assets/drupal-sql carries a migration.'
		);
	}

	const meta = (await sql(
		base,
		host,
		'SELECT cid, expire, created, serialized, tags, checksum ' + 'FROM cache_container'
	)) as Omit<CapturedRow, 'hexdata'>[];
	console.log(
		`the boot left ${meta.length} container row(s): ${meta.map((r) => r.cid).join(', ')}`
	);

	// the stale row survives alongside the rebuilt one, so pick by hash rather than by count
	const match = meta.find((r) => r.cid.includes(wanted));
	if (!match) {
		throw new Error(
			`no row carries the pack's ${wanted}. The pack and the running tree disagree; ` +
				'rebuild the pack before baking the row.'
		);
	}

	// hex(data) SEPARATELY and in slices: a 482 KB container hexes to ~964 KB, and asking for it
	// alongside the metadata dropped the connection outright
	const size = (
		await sql(
			base,
			host,
			`SELECT length(data) AS n FROM cache_container WHERE cid = ${quote(match.cid)}`
		)
	)[0] as { n: number };
	const total = Number(size.n);
	const SLICE = 65_536;
	let hexdata = '';
	for (let off = 0; off < total; off += SLICE) {
		const part = (
			await sql(
				base,
				host,
				`SELECT hex(substr(data, ${off + 1}, ${SLICE})) AS h FROM cache_container ` +
					`WHERE cid = ${quote(match.cid)}`
			)
		)[0] as { h: string };
		hexdata += part.h;
	}
	if (hexdata.length !== total * 2) {
		throw new Error(`read ${hexdata.length / 2} bytes of a ${total}-byte container`);
	}
	return { ...match, hexdata };
}

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

async function sql(
	base: string,
	host: Record<string, string>,
	q: string
): Promise<Record<string, unknown>[]> {
	let last = '';
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const res = await fetch(`${base}/sql?q=${encodeURIComponent(q)}`, { headers: host });
			const body = await res.text();
			if (res.ok)
				return (JSON.parse(body) as { rows?: Record<string, unknown>[] }).rows ?? [];
			last = `${res.status}: ${body.slice(0, 300)}`;
		} catch (err) {
			last = String(err);
		}
		await new Promise((r) => setTimeout(r, 1_000));
	}
	throw new Error(`sql failed after 4 attempts -- ${last}`);
}

async function main(): Promise<void> {
	if (!existsSync(SQLITE)) throw new Error(`${SQLITE} is not on disk`);
	if (!existsSync(PACK_BIN)) throw new Error(`${PACK_BIN} is not on disk; build the pack first`);

	const wanted = packVersionsHash();
	const before = currentCid();
	if (before !== null && runtimeShaped(before) && before.includes(wanted)) {
		console.log(`container row already keyed to ${wanted}; nothing to do`);
		return;
	}
	ensureChunks();
	console.log(`pack wants ${wanted}; the database carries ${before ?? '(no row)'}`);

	/*
	 * Four things about this line, each of which was wrong first.
	 *
	 * The CANONICAL config, not `wrangler.bench.jsonc`: bench aliases the brotli seam, whose
	 * `.interp/php8.5.wasm.br` lags the glue and aborts the boot with `ASM_CONSTS[e] is not a
	 * function`. The INSTALLED wrangler, not bunx's, which resolves from the registry when the name
	 * is not already cached. `--var` rather than the process environment, because wrangler forwards
	 * neither into the worker's `env` -- `/migrate` is an owner route and answered
	 * `401 owner token required` on CI while passing on any machine that has a `.dev.vars`. And
	 * `markHydrating`, or the build command re-enters the build that is running this.
	 */
	const env = { ...process.env };
	markHydrating(env);
	const proc = spawn(
		'./node_modules/.bin/wrangler',
		['dev', '--local', '--port', String(PORT), '--var', 'PW_DIAGNOSTICS:1'],
		{ cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env }
	);
	// echoed as it arrives, not only from the catch below: a SIGTERM never reaches a catch, so the
	// output that names the reason for the kill is exactly what a buffered log loses
	let log = '';
	const tee = (d: Buffer) => {
		log += d.toString();
		process.stderr.write(d);
	};
	proc.stdout?.on('data', tee);
	proc.stderr?.on('data', tee);

	const base = `http://127.0.0.1:${PORT}`;
	try {
		await waitForPort(proc, base, () => log);
		const row = await capture(base, wanted);

		// the runtime's own root, not the build machine's; a Darwin/absolute-path row is the bug
		if (!row.cid.includes('/drupal/sites/default/services.yml')) {
			throw new Error(`the boot produced cid ${row.cid}, which is not rooted at /drupal`);
		}

		const data = Buffer.from(row.hexdata, 'hex');
		if (data.length < 100_000) {
			throw new Error(
				`the captured container is ${data.length} bytes, which is not a container`
			);
		}

		const db = new Database(SQLITE);
		db.run('DELETE FROM cache_container');
		db.run(
			`INSERT INTO cache_container (cid, data, expire, created, serialized, tags, checksum)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[row.cid, data, row.expire, row.created, row.serialized, row.tags, row.checksum]
		);
		const after = db
			.query('SELECT cid, length(data) AS bytes, expire FROM cache_container')
			.all();
		db.close();

		console.log('wrote:', JSON.stringify(after));
		console.log('run `bun run assets:sql` to re-chunk the database');
	} catch (err) {
		console.error(log.slice(-4_000));
		throw err;
	} finally {
		proc.kill('SIGTERM');
	}
}

// guarded, so `container-cid.spec.ts` can import the pack reader without spawning wrangler
if (import.meta.main) await main();
