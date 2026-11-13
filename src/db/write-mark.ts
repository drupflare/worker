import { classifyState } from '../ops/state-inventory';
import { columnSelect, encodeLiteral, ident, isRegenerable } from './export-sql';
import type { SqlLike, StorageLike } from './migrate-sql';

/**
 * Journal entries kept before the journal stops growing; the count keeps going past it.
 *
 * Bounded by the object's storage: the Limits page (Durable Objects) gives 10 GB per object on
 * Workers Paid and 1 GB on the Free plan. An entry is a table name, a key and two integers. Its
 * width is unmeasured, so 500,000 is a share of the Free limit chosen by assumption, not a fit.
 */
export const WRITE_JOURNAL_CAP = 500_000;

const MARK = 'cfw_mark';
const JOURNAL = 'cfw_wj';
const KEY_INDEX = 'cfw_wj_key';
const TRIGGER_PREFIX = 'cfw_wt_';

/** tables that carry no application state, on top of what `isRegenerable` and the inventory say */
const NEVER_TRACKED = new Set(['sequences', 'batch', 'key_value', 'key_value_expire']);

/**
 * Whether a write to this table counts as an application write.
 *
 * Counted unless known not to be: an allow-list would miss contrib tables (`comment_field_data`,
 * a webform's submissions) and let a move look undoable after a visitor posted. Excluded are the
 * regenerable tables the dump already leaves empty, the inventory's derived, local and side-effect
 * tables, `sequences` (re-seeded on the way back), `batch`, the two key-value tables and every
 * host table.
 */
export function isTracked(table: string): boolean {
	if (table === '' || table.startsWith('cfw_') || table.startsWith('sqlite_')) return false;
	if (table.startsWith('_cf_') || table.startsWith('__miniflare')) return false;
	if (isRegenerable(table) || NEVER_TRACKED.has(table)) return false;
	const status = classifyState(table);
	return status === 'AUTHORITATIVE' || status === 'UNKNOWN';
}

/** a table-level statement the capture has to react to */
export interface SchemaChange {
	verb: 'create' | 'drop' | 'alter';
	table: string;
}

const SCHEMA_STATEMENT =
	/^\s*(CREATE|DROP|ALTER)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["'`[]?([A-Za-z0-9_.]+)/i;

/** the table-level change a statement makes; undefined for everything else, cheaply */
export function schemaChange(text: string): SchemaChange | undefined {
	let i = 0;
	while (i < text.length && text.charCodeAt(i) <= 32) i++;
	const c = text.charCodeAt(i) | 32;
	if (c !== 99 && c !== 100 && c !== 97) return undefined;
	const m = SCHEMA_STATEMENT.exec(text);
	if (!m) return undefined;
	return { verb: (m[1] as string).toLowerCase() as SchemaChange['verb'], table: m[2] as string };
}

/** whether the object holds a mark, cached by the caller */
export interface MarkState {
	active?: boolean;
}

export interface MarkRow {
	mark: string;
	startedAt: number;
	writes: number;
	cap: number;
	broken: boolean;
}

export const MARK_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

const lit = (text: string) => `'${text.replace(/'/g, "''")}'`;

function markTablesExist(sql: SqlLike): boolean {
	return (
		sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", MARK).toArray()
			.length > 0
	);
}

/** the active mark, or undefined; reads without creating anything */
export function readMark(sql: SqlLike): MarkRow | undefined {
	if (!markTablesExist(sql)) return undefined;
	const row = sql
		.exec(`SELECT mark, started_at, writes, cap, broken FROM ${MARK} LIMIT 1`)
		.toArray()[0];
	if (!row) return undefined;
	return {
		mark: String(row.mark),
		startedAt: Number(row.started_at),
		writes: Number(row.writes),
		cap: Number(row.cap),
		broken: Number(row.broken) === 1
	};
}

/** how a mark reads: the journal holds `min(writes, cap)` entries, so past the cap it is short */
export function incompleteReason(row: MarkRow): 'journal_full' | 'capture_failed' | undefined {
	if (row.broken) return 'capture_failed';
	return row.writes > row.cap ? 'journal_full' : undefined;
}

interface KeyShape {
	columns: string[];
	keys: string[];
}

function keyShape(sql: SqlLike, table: string): KeyShape {
	const info = sql
		.exec('SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid', table)
		.toArray();
	const columns = info.map((r) => String(r.name));
	const pk = info.filter((r) => Number(r.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
	// a real or blob key cannot be rebuilt from `hex()`, so such a table is counted and not exported
	const usable = pk.every((r) => /INT|CHAR|CLOB|TEXT/i.test(String(r.type)));
	return { columns, keys: usable ? pk.map((r) => String(r.name)) : [] };
}

function keyExpr(ref: 'NEW' | 'OLD', keys: string[]): string {
	if (keys.length === 0) return "''";
	return keys
		.map((k) => `typeof(${ref}.${ident(k)}) || ':' || hex(${ref}.${ident(k)})`)
		.join(" || ',' || ");
}

function triggerDdl(table: string, keys: string[]): Record<string, string> {
	const t = ident(table);
	const bump = (where = '') => `UPDATE ${MARK} SET writes = writes + 1${where};`;
	const log = (ref: 'NEW' | 'OLD', guard = '') =>
		`INSERT INTO ${JOURNAL} (w, tbl, pk) SELECT writes, ${lit(table)}, ${keyExpr(ref, keys)} ` +
		`FROM ${MARK} WHERE writes <= cap${guard};`;
	const name = (k: string) => ident(`${TRIGGER_PREFIX}${table}_${k}`);
	const make = (k: string, event: string, ref: 'NEW' | 'OLD') =>
		`CREATE TRIGGER IF NOT EXISTS ${name(k)} AFTER ${event} ON ${t} BEGIN ${bump()} ${log(ref)} END`;
	// a key change is two events: the old key's row is gone, the new key's row is there
	const moved = keys.map((k) => `OLD.${ident(k)} IS NOT NEW.${ident(k)}`).join(' OR ');
	const update =
		keys.length === 0
			? make('u', 'UPDATE', 'NEW')
			: `CREATE TRIGGER IF NOT EXISTS ${name('u')} AFTER UPDATE ON ${t} BEGIN ` +
				`${bump()} ${log('NEW')} ${bump(` WHERE ${moved}`)} ${log('OLD', ` AND (${moved})`)} END`;
	return {
		[`${TRIGGER_PREFIX}${table}_i`]: make('i', 'INSERT', 'NEW'),
		[`${TRIGGER_PREFIX}${table}_u`]: update,
		[`${TRIGGER_PREFIX}${table}_d`]: make('d', 'DELETE', 'OLD')
	};
}

/**
 * Brings the triggers in line with the tables that exist: adds what a tracked table lacks and
 * drops what belongs to a table that is gone or no longer tracked. Idempotent.
 */
export function syncTriggers(sql: SqlLike): void {
	const master = sql
		.exec("SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table', 'trigger')")
		.toArray();
	const tables = new Set(master.filter((r) => r.type === 'table').map((r) => String(r.name)));
	const have = new Set<string>();
	for (const r of master) {
		if (r.type !== 'trigger' || !String(r.name).startsWith(TRIGGER_PREFIX)) continue;
		const owner = String(r.tbl_name);
		if (tables.has(owner) && isTracked(owner)) have.add(String(r.name));
		else sql.exec(`DROP TRIGGER IF EXISTS ${ident(String(r.name))}`);
	}
	for (const table of tables) {
		if (!isTracked(table)) continue;
		const names = [`i`, `u`, `d`].map((k) => `${TRIGGER_PREFIX}${table}_${k}`);
		if (names.every((n) => have.has(n))) continue;
		const { keys } = keyShape(sql, table);
		const ddl = triggerDdl(table, keys);
		for (const [n, text] of Object.entries(ddl)) {
			if (!have.has(n)) sql.exec(text);
		}
	}
}

function dropTriggersOf(sql: SqlLike, table: string): void {
	for (const k of ['i', 'u', 'd']) {
		sql.exec(`DROP TRIGGER IF EXISTS ${ident(`${TRIGGER_PREFIX}${table}_${k}`)}`);
	}
}

/** counts a table-level change as one write and journals it under the marker key `ddl` */
function noteDdl(sql: SqlLike, table: string): void {
	sql.exec(`UPDATE ${MARK} SET writes = writes + 1`);
	sql.exec(
		`INSERT INTO ${JOURNAL} (w, tbl, pk) SELECT writes, ?, 'ddl' FROM ${MARK} WHERE writes <= cap`,
		table
	);
}

/**
 * The calls the statement wrapper makes around a table-level statement.
 *
 * A trigger names the columns of its key, and SQLite refuses to drop or rename a column a trigger
 * mentions, so an `ALTER` removes the table's triggers first and the sync puts them back after,
 * whether or not the statement succeeded. A failure here must not fail the application's
 * statement, so it marks the capture broken instead, and a broken capture never reads as zero.
 */
export interface SchemaHook {
	before(change: SchemaChange): void;
	after(change: SchemaChange): void;
}

export function markSchemaHook(sql: () => SqlLike, state: MarkState): SchemaHook {
	const active = (): boolean => {
		state.active ??= readMark(sql()) !== undefined;
		return state.active;
	};
	const guard = (run: () => void) => {
		try {
			run();
		} catch {
			try {
				sql().exec(`UPDATE ${MARK} SET broken = 1, writes = writes + 1`);
			} catch {
				// the capture tables are gone as well; nothing is left to mark
			}
		}
	};
	return {
		before(change) {
			if (!isTracked(change.table) || change.verb === 'create' || !active()) return;
			guard(() => {
				noteDdl(sql(), change.table);
				if (change.verb === 'alter') dropTriggersOf(sql(), change.table);
			});
		},
		after(change) {
			if (change.verb === 'drop' || !active()) return;
			guard(() => {
				if (change.verb === 'create' && isTracked(change.table))
					noteDdl(sql(), change.table);
				syncTriggers(sql());
			});
		}
	};
}

export type StartResult =
	| { status: 'started' | 'existing' | 'replaced'; mark: MarkRow }
	| { status: 'conflict'; mark: MarkRow };

/**
 * Starts a mark. The same id again returns the mark as it stands and never resets the count; a
 * different id is refused unless `replace` is set, which empties the journal and the count.
 */
export function startMark(
	sql: SqlLike,
	storage: StorageLike,
	opts: { mark: string; now: number; replace?: boolean; cap?: number }
): StartResult {
	return storage.transactionSync(() => startMarkNow(sql, opts));
}

/**
 * The body of `startMark` for a caller that already holds a transaction, such as the last chunk of
 * a restore, so the mark opens in the same commit as the rows it must not count.
 */
export function startMarkNow(
	sql: SqlLike,
	opts: { mark: string; now: number; replace?: boolean; cap?: number }
): StartResult {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS ${MARK} (id INTEGER PRIMARY KEY CHECK (id = 1), ` +
			`mark TEXT NOT NULL, started_at INTEGER NOT NULL, writes INTEGER NOT NULL, ` +
			`cap INTEGER NOT NULL, broken INTEGER NOT NULL DEFAULT 0)`
	);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS ${JOURNAL} (id INTEGER PRIMARY KEY, w INTEGER NOT NULL, ` +
			`tbl TEXT NOT NULL, pk TEXT NOT NULL)`
	);
	const current = readMark(sql);
	if (current && current.mark === opts.mark) {
		syncTriggers(sql);
		return { status: 'existing', mark: current };
	}
	if (current && opts.replace !== true) return { status: 'conflict', mark: current };
	if (current) {
		sql.exec(`DELETE FROM ${JOURNAL}`);
		sql.exec(`DELETE FROM ${MARK}`);
	}
	sql.exec(
		`INSERT INTO ${MARK} (id, mark, started_at, writes, cap) VALUES (1, ?, ?, 0, ?)`,
		opts.mark,
		opts.now,
		opts.cap ?? WRITE_JOURNAL_CAP
	);
	syncTriggers(sql);
	return {
		status: current ? 'replaced' : 'started',
		mark: readMark(sql) as MarkRow
	};
}

/** ends the mark: triggers first, so no write can reach a table that is already gone */
export function endMark(sql: SqlLike, storage: StorageLike): void {
	storage.transactionSync(() => {
		const triggers = sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cfw\\_wt\\_%' ESCAPE '\\'"
			)
			.toArray();
		for (const t of triggers) sql.exec(`DROP TRIGGER IF EXISTS ${ident(String(t.name))}`);
		sql.exec(`DROP TABLE IF EXISTS ${JOURNAL}`);
		sql.exec(`DROP TABLE IF EXISTS ${MARK}`);
	});
}

// #region export

export type Dialect = 'mysql' | 'sqlite';

function mysqlIdent(name: string): string {
	return `\`${name.replace(/`/g, '``')}\``;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function bytesOf(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length >> 1);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** a value as a MySQL or MariaDB literal; `encodeLiteral` is the SQLite spelling of the same */
export function mysqlLiteral(type: string, hex: string, real: number | null): string {
	if (type === 'null') return 'NULL';
	if (type === 'real') {
		const n = Number(real);
		return Number.isFinite(n) ? String(n) : 'NULL';
	}
	if (type === 'integer') return strictUtf8.decode(bytesOf(hex));
	if (type === 'blob') return `x'${hex}'`;
	let text: string;
	try {
		text = strictUtf8.decode(bytesOf(hex));
	} catch {
		return `x'${hex}'`;
	}
	// a control character is spelled as bytes, since a dump line holds one statement
	if (/[\0-\x08\x0b-\x1f]/.test(text)) return `CONVERT(x'${hex}' USING utf8mb4)`;
	return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

const literalOf = (dialect: Dialect, type: string, hex: string, real: number | null) =>
	dialect === 'mysql' ? mysqlLiteral(type, hex, real) : encodeLiteral(type, hex, real);

const identOf = (dialect: Dialect, name: string) =>
	dialect === 'mysql' ? mysqlIdent(name) : ident(name);

interface Part {
	type: string;
	hex: string;
}

/** a journal key back into typed parts; undefined when it is a marker or not rebuildable */
function parseKey(pk: string): Part[] | undefined {
	const parts: Part[] = [];
	for (const piece of pk.split(',')) {
		const m = /^(null|integer|text|blob):([0-9A-F]*)$/.exec(piece);
		if (!m) return undefined;
		parts.push({ type: m[1] as string, hex: m[2] as string });
	}
	return parts;
}

export interface ChangeManifest {
	mark: string;
	startedAt: number;
	/** the write number this export is read at; the count and the body both stop here */
	through: number;
	/** the write number it starts after; zero for a read from the start of the mark */
	since: number;
	writes: number;
	cap: number;
	incomplete: boolean;
	reason?: 'journal_full' | 'capture_failed';
	/** distinct changed keys per table */
	keys: Record<string, number>;
	cannotCarry: string[];
}

function ensureKeyIndex(sql: SqlLike): void {
	sql.exec(`CREATE INDEX IF NOT EXISTS ${KEY_INDEX} ON ${JOURNAL} (tbl, pk, w, id)`);
}

/** what the export cannot hold, from the journal after `since` and up to `through` */
export function changeManifest(
	sql: SqlLike,
	through?: number,
	since = 0
): ChangeManifest | undefined {
	const row = readMark(sql);
	if (!row) return undefined;
	const upTo = Math.min(through ?? row.writes, row.writes);
	ensureKeyIndex(sql);
	const keys: Record<string, number> = {};
	const ddl: string[] = [];
	const unkeyed = new Set<string>();
	const groups = sql
		.exec(
			`SELECT tbl, pk FROM ${JOURNAL} WHERE w > ? AND w <= ? GROUP BY tbl, pk ORDER BY tbl, pk`,
			since,
			upTo
		)
		.toArray();
	for (const g of groups) {
		const tbl = String(g.tbl);
		const pk = String(g.pk);
		if (pk === 'ddl') ddl.push(tbl);
		else if (pk === '' || parseKey(pk)?.some((p) => p.type === 'real') !== false) {
			unkeyed.add(tbl);
		} else keys[tbl] = (keys[tbl] ?? 0) + 1;
	}
	const cannotCarry = ['sessions', 'settings and state kept in key-value storage'];
	if ((keys['file_managed'] ?? 0) > 0) {
		cannotCarry.push(`the bytes of ${keys['file_managed']} new, replaced or removed files`);
	}
	if (ddl.length > 0) cannotCarry.push(`structure changes to ${[...new Set(ddl)].join(', ')}`);
	for (const t of unkeyed) cannotCarry.push(`rows in ${t}, which has no key to export by`);
	const reason = incompleteReason(row);
	return {
		mark: row.mark,
		startedAt: row.startedAt,
		through: upTo,
		since,
		writes: row.writes,
		cap: row.cap,
		incomplete: reason !== undefined,
		...(reason ? { reason } : {}),
		keys,
		cannotCarry
	};
}

const RESTORE_MARK = 'cfw_restore_mark';

/**
 * Remembers the mark a restore opens when its last chunk lands, by the label the restore carries.
 * The table is restore-owned, so a dump replay neither carries it nor drops it.
 */
export function noteRestoreMark(sql: SqlLike, generation: string, mark: string): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS ${RESTORE_MARK} (generation TEXT PRIMARY KEY, mark TEXT NOT NULL)`
	);
	sql.exec(
		`INSERT INTO ${RESTORE_MARK} (generation, mark) VALUES (?, ?) ` +
			`ON CONFLICT(generation) DO UPDATE SET mark = excluded.mark`,
		generation,
		mark
	);
}

/** the mark noted for a restore label, or undefined; reads without creating anything */
export function readRestoreMark(sql: SqlLike, generation: string): string | undefined {
	const exists = sql
		.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", RESTORE_MARK)
		.toArray();
	if (exists.length === 0) return undefined;
	const row = sql
		.exec(`SELECT mark FROM ${RESTORE_MARK} WHERE generation = ?`, generation)
		.toArray()[0];
	return row ? String(row.mark) : undefined;
}

/**
 * Opens the mark a restore asked for, inside the transaction that applies its last chunk, so the
 * restore's own rows are written before the triggers exist and no request can run between the two.
 * A failure never fails the restore: it marks the capture broken, and a broken capture never reads
 * as zero. A different mark already running is left alone and the caller falls back to a start.
 */
export function openRestoreMark(
	sql: SqlLike,
	opts: { generation: string; mark: string; now: number }
): StartResult | undefined {
	let result: StartResult | undefined;
	try {
		result = startMarkNow(sql, { mark: opts.mark, now: opts.now });
	} catch {
		try {
			sql.exec(`UPDATE ${MARK} SET broken = 1, writes = writes + 1`);
		} catch {
			// no capture tables to mark; the caller finds no mark and starts one itself
		}
	}
	sql.exec(`DELETE FROM ${RESTORE_MARK} WHERE generation = ?`, opts.generation);
	return result;
}

/** drangler's re-seed of the id generator, so the first new row after the apply cannot collide */
export const RESEED =
	'UPDATE sequences SET value = (SELECT COALESCE(MAX(nid), 0) FROM node) + 1 WHERE value < (SELECT COALESCE(MAX(nid), 0) FROM node) + 1;';

/**
 * The changes as statements, one page of keys per step.
 *
 * Reads the journal after `since` (zero from the start) and up to `through`, and each key's row as
 * it is NOW: a present row becomes a `REPLACE INTO` carrying its current values, an absent one a
 * `DELETE`. So a row changed again after `through` appears once, with its newer values, and a row
 * first changed after `through` does not appear. Pages are separate steps, so a write may land
 * between two of them.
 */
export function* changeStatements(
	sql: SqlLike,
	opts: { through: number; since?: number; dialect: Dialect; keysPerPage?: number }
): Generator<string[], void, void> {
	const { through, dialect } = opts;
	const since = opts.since ?? 0;
	const per = opts.keysPerPage ?? 200;
	const info = new Map<string, KeyShape | null>();
	const shapeOf = (table: string): KeyShape | null => {
		if (!info.has(table)) {
			const s = keyShape(sql, table);
			info.set(table, s.columns.length > 0 ? s : null);
		}
		return info.get(table) as KeyShape | null;
	};
	const removed = new Set<string>();
	let statements = 0;
	yield [
		since === 0
			? `-- changes through write ${through}, ${dialect}`
			: `-- changes after write ${since} through write ${through}, ${dialect}`
	];
	let lastTbl: string | undefined;
	let lastPk = '';
	for (;;) {
		const page = sql
			.exec(
				`SELECT tbl, pk FROM ${JOURNAL} WHERE w > ? AND w <= ? AND ` +
					(lastTbl === undefined ? '1' : '(tbl > ? OR (tbl = ? AND pk > ?))') +
					` GROUP BY tbl, pk ORDER BY tbl, pk LIMIT ${per}`,
				...(lastTbl === undefined
					? [since, through]
					: [since, through, lastTbl, lastTbl, lastPk])
			)
			.toArray();
		if (page.length === 0) break;
		const out: string[] = [];
		for (const g of page) {
			const tbl = String(g.tbl);
			const pk = String(g.pk);
			lastTbl = tbl;
			lastPk = pk;
			const parts = pk === 'ddl' ? undefined : parseKey(pk);
			const shape = shapeOf(tbl);
			if (!parts || parts.some((p) => p.type === 'real') || !shape) {
				if (pk !== 'ddl' && pk !== '' && !shape) removed.add(tbl);
				continue;
			}
			if (shape.keys.length !== parts.length) continue;
			const where = shape.keys
				.map(
					(k, i) =>
						`${ident(k)} IS ${encodeLiteral((parts[i] as Part).type, (parts[i] as Part).hex, null)}`
				)
				.join(' AND ');
			let row: Record<string, unknown> | undefined;
			try {
				row = sql
					.exec(
						`SELECT ${columnSelect(shape.columns)} FROM ${ident(tbl)} WHERE ${where} LIMIT 1`
					)
					.toArray()[0];
			} catch {
				removed.add(tbl);
				continue;
			}
			if (row) {
				const values = shape.columns.map((_, i) =>
					literalOf(
						dialect,
						String(row?.[`t${i}`]),
						String(row?.[`h${i}`] ?? ''),
						row?.[`r${i}`] as number | null
					)
				);
				out.push(
					`REPLACE INTO ${identOf(dialect, tbl)} (${shape.columns.map((c) => identOf(dialect, c)).join(', ')}) VALUES (${values.join(', ')});`
				);
			} else {
				const del = shape.keys
					.map(
						(k, i) =>
							`${identOf(dialect, k)} = ${literalOf(dialect, (parts[i] as Part).type, (parts[i] as Part).hex, null)}`
					)
					.join(' AND ');
				out.push(`DELETE FROM ${identOf(dialect, tbl)} WHERE ${del};`);
			}
		}
		statements += out.length;
		if (out.length > 0) yield out;
	}
	const tail = [RESEED];
	for (const t of removed) tail.push(`-- ${t} was removed after it changed`);
	tail.push(`-- end, ${statements} statement${statements === 1 ? '' : 's'}`);
	yield tail;
}

// #endregion
