import { createHash } from 'node:crypto';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SQLOutputValue } from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import { TextDecoder } from 'node:util';

/**
 * Turns the packed Drupal database into JSON chunks the Durable Object can replay
 * in JavaScript, with no PHP and no PDO involved.
 *
 *   node scripts/pack-sql.ts <site.sqlite> <out-dir> [--max-statements=N] [--max-bytes=N]
 *
 * `node`, not `bun`: this needs `node:sqlite`, which bun does not provide (it ships
 * `bun:sqlite` with a different API). Every other script here runs under bun.
 *
 * Format: a manifest plus numbered chunk files, each an object of statements with
 * positional params:
 *
 *   { "i": 0, "statements": [ { "s": "INSERT INTO ...", "p": [ ... ] }, ... ] }
 *
 * Params are JSON scalars, with two tagged forms for what JSON cannot carry:
 * `{"$b64": "..."}` for bytes that are not valid UTF-8, and `{"$i": "..."}` for
 * integers outside the IEEE-754 safe range. Everything else is a plain null, number
 * or string.
 *
 * Params rather than SQL text, for correctness rather than style.
 * `exportDatabase()` inlines values as SQL literals with only `'` doubled, so a
 * BLOB containing a raw newline or a NUL survives neither the literal nor a
 * line-delimited file. Bound params have no escaping problem to get wrong.
 *
 * Text rather than base64 where possible: a BLOB whose bytes are valid UTF-8 ships as a
 * string, smaller than base64 and closer to what Drupal's own writes land as. Base64 is
 * the fallback for genuinely binary values.
 *
 * ORDER. Table DDL, then every row, then indexes and triggers -- index maintenance per
 * insert is waste while the table fills from empty, and nothing reads until done.
 *
 * CHUNK SIZING is by cost, not statement count: one `cache_container` row is 500 KB and
 * one `key_value` row is 40 bytes, so each chunk closes on whichever limit trips first.
 */

/** One bound param in its JSON form, including the two tagged forms JSON cannot carry. */
type PackedParam = null | number | string | { $b64: string } | { $i: string };

const args = process.argv.slice(2);
const positional = args.filter((a: string) => !a.startsWith('--'));
const flag = (name: string, fallback: number): number => {
	const hit = args.find((a: string) => a.startsWith(`--${name}=`));
	return hit ? Number(hit.slice(name.length + 3)) : fallback;
};

const source = positional[0];
const outDir = positional[1];
if (!source || !outDir) {
	console.error(
		'usage: pack-sql.ts <site.sqlite> <out-dir> [--max-statements=N] [--max-bytes=N]'
	);
	process.exit(1);
}

const MAX_STATEMENTS = flag('max-statements', 200);
const MAX_BYTES = flag('max-bytes', 64 * 1024);

/**
 * Largest single value shipped as one statement.
 *
 * One row is not the smallest unit, which is what this file originally got wrong.
 * `cache_container` is 1.45 MB in three rows, and those three chunks measured 14, 17 and
 * 25 ms of edge cpuTime against the free plan's 10 ms ceiling -- the only three of 24 that
 * did not fit. "There is no smaller unit than a row" was written down as a limit and it is
 * false: SQLite can BUILD a value across statements with `col = col || ?`, so a 520 KB
 * value becomes an INSERT carrying the first slice plus N bounded appends.
 *
 * That removes the last indivisible unit from migration. Verify a claimed limit before
 * writing it down as one.
 */
const MAX_VALUE_BYTES = flag('max-value-bytes', 48 * 1024);

/**
 * DDL statements per chunk, capped separately and much lower.
 *
 * MEASURED: with only a statement cap of 200 and a byte cap of 64 KiB, all 177
 * `CREATE INDEX` statements landed in ONE chunk of about 11 KiB -- under both limits -- and
 * that chunk cost **32 ms of edge cpuTime**, the single worst invocation of 81 and the only
 * one over the free plan's 10 ms after value splitting.
 *
 * The cause is that **a byte budget does not bound DDL at all.** `CREATE INDEX foo ON
 * bar (baz)` is 40 bytes and builds an index over every row in the table; cost tracks the
 * table, not the statement. Sizing DDL by its text length is measuring the wrong thing.
 */
const MAX_DDL_STATEMENTS = flag('max-ddl-statements', 12);

// #region schema rewrite

/**
 * Drupal's sqlite driver registers a NOCASE_UTF8 collation at connect time, so a
 * database built by Drupal names a collation the host does not have. Reading the file
 * at all fails with "no such collation sequence" the moment a query touches an index
 * that uses it -- `SELECT COUNT(*) FROM users` was enough.
 *
 * Rewritten in a COPY, never in place: the source file is a build input. The schema
 * cookie has to move or sqlite keeps serving its cached parse of the old text.
 *
 * NOCASE is what the host accepts and what the driver already replays, so this matches
 * the live site rather than diverging from it. ASCII-only case folding is the
 * documented gap and it is not introduced here.
 */
async function openRewritten(path: string) {
	const tmp = join(
		await mkdtempish(),
		'pack-sql-' + createHash('sha1').update(path).digest('hex').slice(0, 8) + '.sqlite'
	);
	await copyFile(path, tmp);
	const db = new DatabaseSync(tmp);
	// node 24.19 turns SQLITE_DBCONFIG_DEFENSIVE on by default and 24.11 did not, so the
	// sqlite_master write below threw only on the runner: "table sqlite_master may not be modified"
	(db as { enableDefensive?: (on: boolean) => void }).enableDefensive?.(false);
	const before = db.prepare('PRAGMA schema_version').get()!.schema_version;
	const affected = db
		.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE sql LIKE '%NOCASE_UTF8%'")
		.get()!.n;
	db.exec('PRAGMA writable_schema=ON');
	db.exec(
		"UPDATE sqlite_master SET sql = replace(sql, 'NOCASE_UTF8', 'NOCASE') WHERE sql LIKE '%NOCASE_UTF8%'"
	);
	db.exec(`PRAGMA schema_version=${Number(before) + 1}`);
	db.exec('PRAGMA writable_schema=OFF');
	db.close();
	return { db: new DatabaseSync(tmp, { readOnly: true }), tmp, collationsRewritten: affected };
}

async function mkdtempish() {
	const dir = join(tmpdir(), 'cfw-pack-sql');
	await mkdir(dir, { recursive: true });
	return dir;
}

// #endregion

// #region value encoding

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

let lossyTextValues = 0;

/**
 * @returns the JSON form of one column value, plus how many bytes it costs to write.
 *
 * Driven by SQLite's own `typeof()` rather than by what the JS binding handed back,
 * because the storage class is the thing being preserved: a `blob` stays a blob and a
 * `text` stays text, so the replayed database has the same column types as the source
 * and not merely the same-looking contents.
 *
 * NEVER reads a text value as a JS string -- see the comment on `readRows()`. `bytes` is
 * always the raw byte form, and the UTF-8 decode here is what turns it back into the JS
 * string the binding will store as TEXT.
 */
function encodeValue(
	type: SQLOutputValue | undefined,
	native: SQLOutputValue | undefined,
	bytes: SQLOutputValue | undefined
): { json: PackedParam; bytes: number } {
	if (type === 'null' || native === null || native === undefined) return { json: null, bytes: 1 };
	if (type === 'integer') {
		if (typeof native === 'bigint') {
			// only the values a double cannot hold get the tagged form, so the common case
			// stays a bare JSON number
			if (
				native <= BigInt(Number.MAX_SAFE_INTEGER) &&
				native >= -BigInt(Number.MAX_SAFE_INTEGER)
			) {
				return { json: Number(native), bytes: 8 };
			}
			return { json: { $i: native.toString() }, bytes: 8 };
		}
		return { json: Number(native), bytes: 8 };
	}
	if (type === 'real') return { json: Number(native), bytes: 8 };
	if (type === 'blob') {
		// always base64, even when the bytes happen to be valid UTF-8: shipping them as a
		// string would rebind them as TEXT and silently change the column's storage class
		const raw = asBytes(bytes ?? native);
		return { json: { $b64: Buffer.from(raw).toString('base64') }, bytes: raw.length };
	}
	if (type === 'text') {
		const raw = asBytes(bytes ?? native);
		try {
			return { json: utf8Decoder.decode(raw), bytes: raw.length };
		} catch {
			// a TEXT column holding bytes that are not valid UTF-8 is pathological; base64
			// keeps the bytes at the cost of the storage class, and the count is reported
			lossyTextValues++;
			return { json: { $b64: Buffer.from(raw).toString('base64') }, bytes: raw.length };
		}
	}
	throw new Error(`unencodable column of SQLite type ${type}`);
}

function asBytes(v: unknown): Uint8Array {
	if (v instanceof Uint8Array) return v;
	if (Buffer.isBuffer(v)) return new Uint8Array(v as Uint8Array);
	if (typeof v === 'string') return new Uint8Array(Buffer.from(v, 'utf8'));
	throw new Error(`expected bytes, got ${typeof v}`);
}

/**
 * Reads every row of one table, asking SQLite for each column three ways.
 *
 * Not paranoia; a bug that shipped. `node:sqlite` returns a TEXT value as a
 * JS string TRUNCATED AT THE FIRST NUL BYTE. Drupal's `cache_data` holds a serialized
 * RouteCollection with NULs in it, so the row came back as 117 of its 1,697 bytes, the
 * pack contained the truncated form, and Drupal died in `RouteProvider::
 * getRouteCollectionForRequest()` with `InputBag::replace(): Argument #1 must be of type
 * array, null given` -- because `unserialize()` on the truncated string returns FALSE and
 * `FALSE['query']` is NULL.
 *
 * `CAST(c AS BLOB)` returns all the bytes. So the value is read as bytes and decoded here,
 * and `typeof(c)` is read alongside to keep the storage class.
 *
 * The wider lesson is RULE 0 in a new costume: the first version of the gate test compared
 * source against replay THROUGH THIS SAME TRUNCATING API, so both sides read 117 bytes and
 * the digests matched. An instrument shared by both sides of a comparison cannot see a bug
 * it also has.
 */
function readRows(db: DatabaseSync, table: string, names: string[]) {
	const quoted = (n: string) => `"${n.replace(/"/g, '""')}"`;
	const select = names
		.map(
			(n, i) =>
				`typeof(${quoted(n)}) AS t${i}, ${quoted(n)} AS v${i}, CAST(${quoted(n)} AS BLOB) AS b${i}`
		)
		.join(', ');
	const stmt = db.prepare(`SELECT ${select} FROM "${table.replace(/"/g, '""')}"`);
	// integers wider than a double must survive; encodeValue narrows the ones that fit
	stmt.setReadBigInts(true);
	return stmt.all();
}

// #endregion

const { db, tmp, collationsRewritten } = await openRewritten(resolve(source));

const master = db
	.prepare(
		`SELECT type, name, tbl_name, sql FROM sqlite_master
			 WHERE sql IS NOT NULL
			 ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name`
	)
	.all();

/**
 * Whether a cache bin should be stored as its primary-key B-tree rather than as a rowid table.
 *
 * A rowid table gives a `TEXT PRIMARY KEY` its own unique index, so one stored row is charged
 * twice on the meter that binds regeneration. Every bin `DatabaseBackend` creates keys on a TEXT
 * `cid`, and 13 of the 14 carry no secondary index at all, so that second charge IS the whole
 * index cost. Measured on a steady-state render: 8 charged rows -> 6, and the bins' index charge
 * 3 -> 0, with zero spread over three runs (`tests/integration/cache-bin-rowid.spec.ts`).
 *
 * Scoped to `cache_` deliberately. `router` at 3x and `key_value` at 2x pay the same autoindex and
 * are NOT converted here: neither is on the render path, both are on the install path, and nothing
 * has measured whether anything depends on their rowid ordering. A rule applied to 71 tables on the
 * strength of a measurement of 14 is the over-reach this file should not make.
 */
function wantsWithoutRowid(name: string, ddl: string): boolean {
	if (!name.startsWith('cache_')) return false;
	// WITHOUT ROWID requires a primary key and forbids AUTOINCREMENT outright
	if (!/PRIMARY\s+KEY/i.test(ddl) || /AUTOINCREMENT/i.test(ddl)) return false;
	// an INTEGER primary key already IS the rowid, so there is no separate index to save
	if (/\bINTEGER\s+PRIMARY\s+KEY\b/i.test(ddl)) return false;
	return !/\bWITHOUT\s+ROWID\b/i.test(ddl);
}

const tableDdl: { s: string; p: PackedParam[] }[] = [];
const laterDdl: { s: string; p: PackedParam[] }[] = [];
const tables: string[] = [];
const withoutRowidTables: string[] = [];
for (const o of master) {
	const name = String(o.name ?? '');
	// engine-owned objects refuse to be created, and miniflare adds its own bookkeeping
	if (!name || name.startsWith('sqlite_') || name.startsWith('__miniflare')) continue;
	const stmt = { s: String(o.sql).replace(/;+\s*$/, ''), p: [] };
	if (o.type === 'table') {
		if (wantsWithoutRowid(name, stmt.s)) {
			stmt.s += ' WITHOUT ROWID';
			withoutRowidTables.push(name);
		}
		tableDdl.push(stmt);
		tables.push(name);
	} else {
		laterDdl.push(stmt);
	}
}

/**
 * The packed database has NO sessions table. Drupal creates it lazily on the first
 * session write, and a pack built by browsing anonymously never writes one; nothing on
 * a read path notices, then the first entity save fails the whole transaction replay
 * with "no such table: sessions". MIGRATE_DB synthesised it at replay time, outside any
 * transaction, and doing it here instead means the shipped artifact is complete rather
 * than needing a repair step.
 */
const SESSIONS_DDL =
	"CREATE TABLE sessions (uid INTEGER NOT NULL DEFAULT 0, sid VARCHAR(128) NOT NULL PRIMARY KEY, hostname VARCHAR(128) NOT NULL DEFAULT '', timestamp INTEGER NOT NULL DEFAULT 0, session BLOB)";
let sessionsSynthesised = false;
if (!tables.includes('sessions')) {
	tableDdl.push({ s: SESSIONS_DDL, p: [] });
	laterDdl.push({ s: 'CREATE INDEX sessions_timestamp ON sessions (timestamp)', p: [] });
	laterDdl.push({ s: 'CREATE INDEX sessions_uid ON sessions (uid)', p: [] });
	sessionsSynthesised = true;
}

const inserts: { s: string; p: PackedParam[]; b: number }[] = [];
const perTable: Record<string, number> = {};
let totalRows = 0;
let payloadBytes = 0;
let base64Values = 0;
let bigintValues = 0;
let splitValues = 0;
let splitStatements = 0;
let perRowStatements = 0;
const unsplittableValues: string[] = [];

/**
 * Cuts a string into pieces of at most `maxBytes` UTF-8 bytes, never mid-codepoint.
 *
 * Sliced on code points rather than bytes because `col || ?` concatenates TEXT: half a
 * multi-byte character would be re-encoded as a replacement char and the value would come
 * back subtly wrong rather than obviously broken. The 4-byte worst case per code point
 * keeps the slice inside the budget without measuring every candidate cut.
 */
function sliceByChars(s: string, maxBytes: number): [string, ...string[]] {
	const perSlice = Math.max(1, Math.floor(maxBytes / 4));
	const out: string[] = [];
	for (const ch of chunkedCodePoints(s, perSlice)) out.push(ch);
	return out.length ? (out as [string, ...string[]]) : [''];
}

function* chunkedCodePoints(s: string, count: number): Generator<string> {
	let buf = '';
	let n = 0;
	for (const cp of s) {
		buf += cp;
		if (++n >= count) {
			yield buf;
			buf = '';
			n = 0;
		}
	}
	if (buf) yield buf;
}

for (const table of tables) {
	const cols = db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all();
	const names = cols.map((c) => String(c.name));
	if (!names.length) continue;
	const quoted = names.map((n) => `"${n.replace(/"/g, '""')}"`).join(', ');
	const marks = names.map(() => '?').join(', ');
	const insert = `INSERT INTO "${table.replace(/"/g, '""')}" (${quoted}) VALUES (${marks})`;

	// primary-key columns, needed to address a row for an append; a table without one
	// cannot have its oversized values split and is reported instead of split wrongly
	const pkNames = cols.filter((c) => Number(c.pk) > 0).map((c) => String(c.name));

	let n = 0;
	for (const row of readRows(db, table, names)) {
		const p: PackedParam[] = [];
		const sizes: number[] = [];
		let rowBytes = 0;
		for (let i = 0; i < names.length; i++) {
			const { json, bytes } = encodeValue(row[`t${i}`], row[`v${i}`], row[`b${i}`]);
			if (json && typeof json === 'object') {
				if ('$b64' in json) base64Values++;
				else if ('$i' in json) bigintValues++;
			}
			p.push(json);
			sizes.push(bytes);
			rowBytes += bytes;
		}

		// #region split an oversized value across statements

		const fat = sizes.findIndex(
			(b, i) =>
				b > MAX_VALUE_BYTES && typeof p[i] === 'string' && !pkNames.includes(names[i]!)
		);
		if (fat >= 0 && pkNames.length) {
			const whole = p[fat] as string;
			const slices = sliceByChars(whole, MAX_VALUE_BYTES);
			const head = [...p];
			head[fat] = slices[0];
			inserts.push({ s: insert, p: head, b: sizes[fat] === 0 ? 0 : slices[0].length });

			const where = pkNames.map((k) => `"${k.replace(/"/g, '""')}" = ?`).join(' AND ');
			const pkValues = pkNames.map((k) => p[names.indexOf(k)] as PackedParam);
			const col = `"${names[fat]!.replace(/"/g, '""')}"`;
			// `col = col || ?` builds the value in place, so each statement carries a bounded
			// slice and the row is only whole once the last append lands
			const append = `UPDATE "${table.replace(/"/g, '""')}" SET ${col} = ${col} || ? WHERE ${where}`;
			for (let s = 1; s < slices.length; s++) {
				inserts.push({ s: append, p: [slices[s]!, ...pkValues], b: slices[s]!.length });
			}
			splitValues++;
			splitStatements += slices.length - 1;
			payloadBytes += rowBytes;
			n++;
			perRowStatements += slices.length;
			continue;
		}
		if (fat >= 0) {
			// no primary key to address the row by: left whole, and counted so the invocation
			// that overruns is predictable rather than a surprise on the edge
			unsplittableValues.push(`${table}.${names[fat]} (${sizes[fat]} bytes, no primary key)`);
		}

		// #endregion

		inserts.push({ s: insert, p, b: rowBytes });
		payloadBytes += rowBytes;
		n++;
	}
	perTable[table] = n;
	totalRows += n;
}

db.close();
await rm(tmp, { force: true });

/** Pulls the table name back out of a CREATE TABLE statement, quoted or bare. */
function tableNameOf(ddl: string): string | null {
	const m =
		/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$]*))/i.exec(
			ddl
		);
	if (!m) return null;
	return (m[1] ?? m[2] ?? m[3] ?? m[4])!.replace(/""/g, '"');
}

// #region chunking

const ordered: { s: string; p: PackedParam[]; b?: number; ddl?: boolean }[] = [
	...tableDdl.map((s) => ({ ...s, b: s.s.length, ddl: true })),
	...inserts,
	...laterDdl.map((s) => ({ ...s, b: s.s.length, ddl: true }))
];

const chunks: { s: string; p: PackedParam[] }[][] = [];
let current: { s: string; p: PackedParam[] }[] = [];
let currentBytes = 0;
let currentDdl = 0;
for (const st of ordered) {
	const bytes = st.b ?? 0;
	const isDdl = st.ddl === true;
	// three budgets, because chunk cost has three unrelated drivers: statement count for
	// per-statement overhead, bytes for the data actually written, and a separate DDL cap
	// because index-build cost tracks the TABLE and not the statement's length
	const full =
		current.length >= MAX_STATEMENTS ||
		currentBytes + bytes > MAX_BYTES ||
		(isDdl && currentDdl >= MAX_DDL_STATEMENTS);
	if (current.length && full) {
		chunks.push(current);
		current = [];
		currentBytes = 0;
		currentDdl = 0;
	}
	current.push({ s: st.s, p: st.p });
	currentBytes += bytes;
	if (isDdl) currentDdl++;
}
if (current.length) chunks.push(current);

// #endregion

const outAbs = resolve(outDir);
await rm(outAbs, { recursive: true, force: true });
await mkdir(outAbs, { recursive: true });

const chunkMeta = [];
for (let i = 0; i < chunks.length; i++) {
	const file = `${String(i).padStart(4, '0')}.json`;
	const body = JSON.stringify({ i, statements: chunks[i] });
	await writeFile(join(outAbs, file), body);
	chunkMeta.push({
		i,
		file,
		statements: chunks[i]!.length,
		bytes: body.length,
		sha256: createHash('sha256').update(body).digest('hex').slice(0, 16)
	});
}

const manifest = {
	version: 1,
	source: resolve(source),
	sourceBytes: (await stat(resolve(source))).size,
	// every consumer checks this before replaying: a chunk set from a different pack
	// than the manifest is the failure mode that would present as a partial site
	generation: createHash('sha256').update(JSON.stringify(chunkMeta)).digest('hex').slice(0, 16),
	totals: {
		chunks: chunkMeta.length,
		statements: ordered.length,
		tableDdl: tableDdl.length,
		indexDdl: laterDdl.length,
		// statements that write row data: one per row plus one per append slice
		rowStatements: inserts.length,
		rows: totalRows,
		payloadBytes,
		chunkBytes: chunkMeta.reduce((a, c) => a + c.bytes, 0)
	},
	limits: { maxStatements: MAX_STATEMENTS, maxBytes: MAX_BYTES },
	// every table the chunk set CREATES, which is not the same list as `tables` below:
	// that one is a row-count map and so omits any table with no rows to copy, including
	// the synthesised `sessions`. A reset that drops only the row-bearing tables leaves
	// `sessions` behind and the next migration dies on "table sessions already exists" --
	// found by the gate test, not by reasoning
	creates: [...tableDdl.map((s) => tableNameOf(s.s)).filter(Boolean)],
	notes: {
		collationsRewritten,
		sessionsSynthesised,
		withoutRowidTables,
		base64Values,
		bigintValues,
		// a TEXT column holding bytes that are not valid UTF-8; nonzero means some value
		// crossed as base64 and lost its storage class
		lossyTextValues,
		// values too large to insert in one statement, rebuilt with `col = col || ?`
		splitValues,
		splitStatements,
		maxValueBytes: MAX_VALUE_BYTES,
		// oversized values with no primary key to address them: these stay whole and their
		// invocation will overrun, so they are named rather than discovered on the edge
		unsplittableValues
	},
	tables: perTable,
	chunks: chunkMeta
};
await writeFile(join(outAbs, 'manifest.json'), JSON.stringify(manifest, null, '\t'));

const biggest = [...chunkMeta].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
console.log(`source          ${resolve(source)}`);
console.log(`                ${manifest.sourceBytes.toLocaleString()} bytes on disk`);
console.log(
	`tables          ${tables.length}${sessionsSynthesised ? ' (+1 synthesised: sessions)' : ''}` +
		`, ${withoutRowidTables.length} WITHOUT ROWID`
);
console.log(`rows            ${totalRows.toLocaleString()}`);
console.log(
	`statements      ${ordered.length.toLocaleString()} (${tableDdl.length} table DDL, ${inserts.length} inserts, ${laterDdl.length} index DDL)`
);
console.log(
	`chunks          ${chunkMeta.length} at <=${MAX_STATEMENTS} statements / <=${(MAX_BYTES / 1024).toFixed(0)} KiB`
);
console.log(
	`chunk bytes     ${manifest.totals.chunkBytes.toLocaleString()} total, largest ${biggest[0]?.bytes.toLocaleString()}`
);
console.log(
	`vs .sqlite      ${(manifest.totals.chunkBytes - manifest.sourceBytes).toLocaleString()} bytes`
);
console.log(
	`encoding        ${base64Values} base64 values, ${bigintValues} wide integers, ${collationsRewritten} collations rewritten`
);
console.log(`generation      ${manifest.generation}`);
console.log(`out             ${outAbs}`);
console.log(
	`largest chunks  ${biggest.map((c) => `${c.file}:${(c.bytes / 1024).toFixed(0)}K/${c.statements}st`).join('  ')}`
);
