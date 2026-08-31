/**
 * Replaces the packed `cache_container` row with one the shipping tree can actually read.
 *
 * THE ROW THE PACK SHIPPED WAS KEYED TO A DIFFERENT DEPENDENCY SET. Drupal builds the container
 * cache key from `DrupalInstalled::VERSIONS_HASH` (`DrupalKernel::getContainerCacheKey()`), a hash
 * of every installed package version. The packed cid carried `dbbbce4907a2ede9` and this tree
 * computes `d87c6ada93448a4f`, so the first `$kernel->boot()` on every site MISSED and rebuilt a
 * 482 KB container. Measured in the gate lane on a local wall clock: `kernelBootMs` 1,024 on the
 * miss against 28 with a row that matches.
 *
 * The row is SHAREABLE, which is what makes shipping one legitimate. Measured: two sites with
 * different hash salts and different pinned origins build a byte-identical row -- same cid, same
 * 482,116 bytes, same SHA-256. Nothing site-specific is compiled into it.
 *
 * SURGICAL, per the standing rule: `assets/drupal/site.sqlite` is hand-trimmed and nothing in this
 * repo reproduces it, so `bun run assets:pack` would balloon it toward the 14.4 MB build input and
 * discard the trim. This reads one row out of a booted site and writes one row in.
 *
 * The source is a real boot through `cfw_do_sqlite`, captured from `wrangler dev --local`:
 *
 *   bunx wrangler dev -c wrangler.bench.jsonc --local --port 8799 --var PW_DIAGNOSTICS:1
 *   curl -sG http://127.0.0.1:8799/migrate --data-urlencode 'site=x' --data-urlencode 'all=1'
 *   curl -sG http://127.0.0.1:8799/fill --data-urlencode 'site=x'
 *   curl -sG http://127.0.0.1:8799/sql --data-urlencode 'site=x' --data-urlencode \
 *     "q=SELECT cid, expire, created, serialized, tags, checksum, hex(data) AS hexdata \
 *        FROM cache_container WHERE cid NOT LIKE '%dbbbce%'" -o row.json
 *
 * Then `bun run assets:sql` to re-emit the migration chunks the JS engine replays.
 */

import { Database } from 'bun:sqlite';

const [rowPath, dbPath] = process.argv.slice(2);
if (!rowPath || !dbPath) {
	throw new Error('usage: bun scripts/fix-container-cid.ts <row.json> <site.sqlite>');
}

type Row = {
	cid: string;
	expire: number;
	created: number;
	serialized: number;
	tags: string;
	checksum: string;
	hexdata: string;
};

const payload = JSON.parse(await Bun.file(rowPath).text()) as { rows: Row[] };
const row = payload.rows?.[0];
if (!row?.cid || !row.hexdata) throw new Error(`${rowPath} carries no container row`);

// the cid has to be the one THIS tree computes, or the row is the same bug with a new hash
const installed = await Bun.file(
	new URL('../drupal-src/vendor/drupal/DrupalInstalled.php', import.meta.url)
).text();
const hash = /VERSIONS_HASH\s*=\s*'([0-9a-f]+)'/.exec(installed)?.[1];
if (!hash) throw new Error('could not read VERSIONS_HASH from drupal-src');
if (!row.cid.includes(hash)) {
	throw new Error(`row cid ${row.cid} does not carry this tree's VERSIONS_HASH ${hash}`);
}

const data = Buffer.from(row.hexdata, 'hex');
const db = new Database(dbPath);
const before = db.query('SELECT cid, length(data) AS bytes FROM cache_container').all();

db.run('DELETE FROM cache_container');
db.run(
	`INSERT INTO cache_container (cid, data, expire, created, serialized, tags, checksum)
	 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	[row.cid, data, row.expire, row.created, row.serialized, row.tags, row.checksum]
);

const after = db.query('SELECT cid, length(data) AS bytes, expire FROM cache_container').all();
db.close();

console.log('before:', before);
console.log('after: ', after);
console.log(`VERSIONS_HASH in drupal-src: ${hash}`);
