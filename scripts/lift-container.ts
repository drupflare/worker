import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Lifts the container definition a RUNTIME wrote, into the pack.
 *
 *   node scripts/lift-container.ts [--keep-unreadable]
 *
 * Run under NODE, not bun: it needs `node:sqlite`, which bun does not ship. `assets:sql` is run the
 * same way for the same reason.
 *
 * WHY A LIFT AND NOT A BUILD. `DrupalKernel::getContainerCacheKey()` folds in `PHP_OS`, the absolute
 * `container_yamls` paths, and a versions hash. A definition compiled on a developer machine is
 * therefore keyed `Darwin` plus a build path and **can never be read on the edge**. Rewriting those
 * two fields by hand was tried: the render came back byte-identical and the cache **still missed**,
 * because the versions hash differed as well. The object had quietly compiled its own and cached it
 * under a third key.
 *
 * So the runtime is the only authority. Boot it once, let it compile and cache, then take the row it
 * wrote: it is portable by construction (`app.root` was `/drupal` when it was dumped) and keyed
 * correctly by definition rather than by inference.
 *
 * This also deletes rows the runtime can never read. That is not tidiness: five such rows were
 * 2,408,361 bytes of the pack, and the three largest were the three "indivisible" 520 KB migration
 * chunks -- the worst invocations in the whole chain, spent installing definitions nothing could load.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const SITE_DB = join(ROOT, 'assets/drupal/site.sqlite');
const DO_DIR = join(ROOT, '.wrangler/state/v3/do/drupflare-SitePhpDurableObject');
const keepUnreadable = process.argv.includes('--keep-unreadable');

/** the most recently written Durable Object storage file, which is the object that just booted */
function newestObjectDb(): string {
	const files = readdirSync(DO_DIR)
		.filter((f) => f.endsWith('.sqlite'))
		.map((f) => join(DO_DIR, f));
	if (files.length === 0) {
		throw new Error(
			`no Durable Object storage under ${DO_DIR}. Boot a runtime first:\n` +
				'  bunx wrangler dev -c wrangler.jsonc --port 8801 --var PW_DIAGNOSTICS:1\n' +
				'  then drive /migrate to done and render /serve once'
		);
	}
	return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] as string;
}

const objectDb = newestObjectDb();
const src = new DatabaseSync(objectDb, { readOnly: true });

// a runtime-written row is the one keyed Linux with an absolute /drupal path; anything else came
// from a build machine
const rows = src
	.prepare(
		'SELECT cid, data, expire, created, serialized, tags, checksum FROM cache_container ' +
			"WHERE cid LIKE '%:Linux:%' AND cid LIKE '%\"/drupal/%' ORDER BY created DESC"
	)
	.all() as Array<Record<string, unknown>>;

if (rows.length === 0) {
	throw new Error(
		`no runtime-written container row in ${objectDb.split('/').pop()}. ` +
			'The object may not have booted PHP yet -- render /serve once, then retry.'
	);
}

const row = rows[0] as {
	cid: string;
	data: Uint8Array | string;
	expire: number;
	created: number;
	serialized: number;
	tags: string;
	checksum: string;
};
const bytes =
	typeof row.data === 'string' ? Buffer.from(row.data, 'binary') : Buffer.from(row.data);

// it must not reference the machine that built the pack; if it does, it was not runtime-produced
for (const marker of ['/Users/', '/private/tmp/', 'Darwin']) {
	if (bytes.includes(Buffer.from(marker))) {
		throw new Error(`the lifted row contains ${marker}; it is not portable, refusing`);
	}
}

const dst = new DatabaseSync(SITE_DB);
const before = dst
	.prepare('SELECT COUNT(*) AS n, SUM(LENGTH(data)) AS b FROM cache_container')
	.get() as {
	n: number;
	b: number;
};

const runtimeHash = row.cid.split(':')[2];
if (!keepUnreadable) {
	// every row whose versions hash differs from the runtime's, or which is keyed to a build OS, is
	// dead weight that also costs migration invocations to install
	dst.prepare('DELETE FROM cache_container WHERE cid NOT LIKE ?').run(`%${runtimeHash}%Linux%`);
}
dst.prepare(
	'INSERT OR REPLACE INTO cache_container (cid, data, expire, created, serialized, tags, checksum) ' +
		'VALUES (?, ?, ?, ?, ?, ?, ?)'
).run(row.cid, bytes, row.expire, row.created, row.serialized, row.tags, row.checksum);

const after = dst
	.prepare('SELECT COUNT(*) AS n, SUM(LENGTH(data)) AS b FROM cache_container')
	.get() as {
	n: number;
	b: number;
};
const readback = dst
	.prepare('SELECT LENGTH(data) AS n FROM cache_container WHERE cid = ?')
	.get(row.cid) as { n: number };

console.log(
	JSON.stringify(
		{
			source: objectDb.split('/').pop(),
			cid: row.cid,
			bytes: bytes.length,
			readbackMatches: readback.n === bytes.length,
			rows: { before: before.n, after: after.n },
			packBytes: { before: before.b, after: after.b, saved: before.b - after.b },
			next: 'bun run assets:sql, then verify with a FRESH boot: cache_container must be 1 row and the twig row count must not increase'
		},
		null,
		2
	)
);
