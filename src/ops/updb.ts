/**
 * `updb` sliced across Durable Object invocations: the plan, the cursor and the contract that
 * makes a half-applied update impossible to produce silently.
 *
 * No clock works here (`microtime()` reads 0, `Date.now()` is frozen in a synchronous run), so
 * no loop is clock-driven and every budget decision is a pre-check. The object hibernates after
 * ~10 s idle and drops the interpreter. `drupal_flush_all_caches()` (282.9 ms) is split into the
 * eleven units core names (`UPDB_FLUSH_STEPS`).
 *
 * The chain is maintenance-fenced and two-beat: a claim beat commits in its own event, then a run
 * beat enters PHP, because DO SQLite commits at each event's end and a marker written in the
 * event that enters PHP dies with it. `snapshot` copies only update bookkeeping, so whole-site
 * rollback is the R2 export (`requireExport` can demand it). Copy-and-swap was rejected: a
 * written row per row, no table prefixes in the driver, and DDL dirties `sqlite_master`.
 *
 * Crash detection is a single-use in-memory token. A unit found `claimed` with no token halts
 * the run (`unit-unverifiable`, maintenance left on): fail closed, with one false positive if
 * the object is evicted between beats. Whether a killed event's writes are discarded is
 * unmeasured, so `retryPolicy: "core"` is opt-in. A cold interpreter is refused
 * (`cold-interpreter`, bounded by `maxColdWaits`) only for a caller passing `phpReady`.
 *
 * Preconditions are checked in JS before PHP, so a refusal costs ~0 ms: the run's `code_id` (a
 * deploy can swap the pack under a live cursor), maintenance still on, `expect_schema`, a
 * post-update not already recorded, and the cursor unit's state. An unparseable value reads
 * `null` and refuses (unknown beats incorrect).
 * @module
 */

import { UPDB_FLUSH_STEPS, UPDB_VERIFY, updbPlan, updbUnit } from '../drupal/updb-php';
import { errorMessage } from '../util/errors';
import { firstRow } from '../util/sql';

export { UPDB_FLUSH_STEPS, UPDB_VERIFY };

/** the cursor `exec()` hands back, narrowed to what this file reads off one */
export interface UpdbCursor {
	toArray(): Record<string, unknown>[];
	rowsWritten?: number;
	rowsRead?: number;
}

/** `ctx.storage.sql`, or the same exec()/cursor shape; `databaseSize` is recorded, never guessed */
export interface UpdbSql {
	exec(text: string, ...params: unknown[]): UpdbCursor;
	databaseSize?: number;
}

/** one run-permission token, valid for exactly the run, seq and attempt that issued it */
export interface UpdbToken {
	runId: string;
	seq: number;
	attempts: number;
	issuedAt: number;
}

/** the single-use token slot; in memory only, as its disappearance is the signal */
export interface TokenHolder {
	get: () => UpdbToken | undefined;
	set: (t: UpdbToken) => void;
	clear: () => void;
}

/** what `serializedScalar()` decoded */
export interface SerializedScalar {
	kind: 'int' | 'bool' | 'string' | 'float' | 'null';
	value: unknown;
}

/** one unit as the plan builder emits it, before it becomes a `cfw_updb_unit` row */
export interface PlanUnit {
	kind: string;
	fn?: string;
	module?: string;
	number?: number;
	step?: string;
	depMap?: string[];
	expectSchema?: number | null;
	seedSchema?: number | null;
	maintTarget?: boolean;
	unbounded?: boolean;
}

/** the `cfw_updb_run` row, decoded */
export interface UpdbRun {
	id: string;
	schemaVersion: number;
	phase: string;
	cursorSeq: number;
	maxSeq: number;
	planned: boolean;
	codeId: string | null;
	planHash: string | null;
	maintWas: boolean;
	abortList: string[];
	snapshot: Record<string, unknown> | null;
	exportKey: string | null;
	haltReason: string | null;
	haltDetail: string | null;
	coldWaits: number;
	rowsWritten: number;
	statements: number;
	dbSizeBefore: number | null;
	options: Record<string, unknown>;
	startedAt: number;
	updatedAt: number;
}

/** the `cfw_updb_unit` row, decoded */
export interface UpdbUnit {
	runId: string;
	seq: number;
	kind: string;
	fn: string | null;
	module: string | null;
	number: number | null;
	step: string | null;
	depMap: string[];
	expectSchema: number | null;
	seedSchema: number | null;
	maintTarget: boolean;
	state: string;
	attempts: number;
	passes: number;
	finished: number;
	sandbox: string | null;
	message: string | null;
	error: string | null;
	rowsWritten: number;
	statements: number;
	claimedAt: number | null;
	endedAt: number | null;
}

/**
 * A PHP fragment's JSON reply, or the snapshot report. `any`, not `unknown`: the shape depends
 * on which unit ran and each read is already guarded, so `unknown` would only add casts.
 */
export type UpdbUnitResult = Record<string, any>;

/**
 * One beat's result. Only `ok` and `beat` are invariant; the rest depend on the branch that ran,
 * so they are optional and a caller checks before reading.
 */
export interface UpdbBeat {
	ok: boolean;
	/** which beat ran: claim, verify, apply, flush and so on */
	beat: string;
	/** whether the run owes another beat */
	more?: boolean;
	/** whether PHP was actually entered */
	ran?: boolean;
	/** refused because the interpreter was not warm */
	cold?: boolean;
	/** the unit did some but not all of its work */
	partial?: boolean;
	/** the unit's sequence number */
	seq?: number;
	/** the update function under way */
	fn?: string | null;
	/** the unit's kind */
	kind?: string;
	runId?: string;
	/** the run's phase after this beat */
	phase?: string;
	/** why it halted or skipped */
	reason?: string | null;
	detail?: string | null;
	attempts?: number;
	coldWaits?: number;
	/** whether a claim was re-issued after an unverifiable one */
	reclaimed?: boolean;
	/** 1 when the unit completed, from the row's own column */
	finished?: number;
	/** how many times this unit has been attempted */
	passes?: number;
	/** abort keys this unit added */
	aborted?: string[];
	/** how many units the plan appended */
	appended?: number;
	/** the rows and statements this beat cost */
	meters?: { rows: number; statements: number };
	/** the unit's own reply */
	result?: UpdbUnitResult | null;
	/** the plan fragment's JSON, on the two halts that carry it */
	plan?: UpdbUnitResult | null;
}

/** the knobs `updbOptions()` reads from env; all arrive from wrangler as strings */
export interface UpdbEnv {
	UPDB_FLUSH_SPLIT?: string;
	UPDB_ALLOW_UNBOUNDED?: string;
	UPDB_SNAPSHOT_MAX_ROWS?: string | number;
	UPDB_RETRY_POLICY?: string;
	UPDB_ON_ABORT?: string;
	UPDB_MAX_ATTEMPTS?: string | number;
	UPDB_MAX_PASSES?: string | number;
	UPDB_MAX_COLD_WAITS?: string | number;
	UPDB_MAX_BEATS?: string | number;
	UPDB_CHECK_REQUIREMENTS?: string;
	KEEP_WARM_MS?: string | number;
}

/** everything `updbPrepare()`, `updbStep()` and the two operator calls accept */
export interface UpdbOptions {
	requireExport?: boolean;
	exportKey?: string | null;
	flushSplit?: boolean;
	allowUnbounded?: boolean;
	snapshotMaxRows?: number;
	retryPolicy?: string;
	onAbort?: string;
	maxAttempts?: number;
	maxPasses?: number;
	maxColdWaits?: number;
	maxBeats?: number;
	checkRequirements?: boolean;
	maxRows?: number;
	nowMs?: number;
	codeId?: string;
	snapshotTables?: string[];
	tables?: string[];
	reason?: string;
	idleMs?: number;
	chainMs?: number;
	coldMs?: number;
}

/** the transport, clock and meters a beat runs on; it owns none of them */
export interface UpdbDeps {
	sql: UpdbSql;
	runJson: (code: string) => Promise<Record<string, unknown>>;
	phpReady?: () => boolean;
	txn?: (fn: () => void) => void;
	nowMs?: () => number;
	meters?: () => { rowsWritten: number; statements: number };
	tokens?: TokenHolder;
}

/** bumped when the row shape changes; a run from an older shape is refused, not migrated */
export const UPDB_SCHEMA_VERSION = 1;

/** the bookkeeping a run may restore; not the content tables */
export const UPDB_SNAPSHOT_TABLES = ['key_value', 'key_value_expire', 'config', 'cachetags'];

/** phases a run can be in; only `running` and `planning` do work */
export const UPDB_PHASES = [
	'planning',
	'running',
	'complete',
	'halted',
	'rolled_back',
	'abandoned'
];

/** phases in which `updbStep()` does nothing and writes nothing */
const TERMINAL_PHASES = ['complete', 'halted', 'rolled_back', 'abandoned'];

/**
 * Phases after which a new run may be prepared; `halted` is absent (a second cursor over one
 * schema is the failure prevented), so an operator uses `updbRollback()` or `updbAbandon()`.
 */
const RESTARTABLE_PHASES = ['complete', 'rolled_back', 'abandoned'];

/** a missing table is a real answer here, not an error to swallow */
const MISSING_TABLE = /no such table/i;

/**
 * The run-permission tokens, one holder per instance keyed on `sql` (an isolate hosts several).
 * In memory only: a token surviving an eviction would survive the kill it detects.
 */
const TOKENS = new WeakMap<object, TokenHolder>();

/** the token holder for this instance, creating it on first use */
function tokenHolder(deps: UpdbDeps): TokenHolder {
	if (deps.tokens && typeof deps.tokens.get === 'function') return deps.tokens;
	let holder = TOKENS.get(deps.sql);
	if (!holder) {
		let value: UpdbToken | undefined;
		holder = {
			get: () => value,
			set: (v: UpdbToken) => {
				value = v;
			},
			clear: () => {
				value = undefined;
			}
		};
		TOKENS.set(deps.sql, holder);
	}
	return holder;
}

/** a token is valid only for the exact run, seq and attempt that issued it */
function tokenMatches(token: UpdbToken | undefined, run: UpdbRun, unit: UpdbUnit): boolean {
	return (
		token !== undefined &&
		token.runId === run.id &&
		Number(token.seq) === Number(unit.seq) &&
		Number(token.attempts) === Number(unit.attempts)
	);
}

/** workerd hands TEXT back as a string, but a real BLOB comes back binary */
function asText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
	if (value && typeof value === 'object' && 'byteLength' in value) {
		return new TextDecoder().decode(value as ArrayBufferView);
	}
	return value === null || value === undefined ? '' : String(value);
}

/**
 * Parses a whole PHP-serialized scalar (`i:11201;`, `b:1;`, `s:3:"abc";`), which is what a
 * `key_value.value` holds. Undefined for anything else, arrays included, so every gate refuses.
 */
export function serializedScalar(blob: unknown): SerializedScalar | undefined {
	const text = asText(blob).trim();
	if (text.length === 0) return undefined;
	if (text === 'N;') return { kind: 'null', value: null };
	let m = /^i:(-?\d+);$/.exec(text);
	if (m) return { kind: 'int', value: Number(m[1]) };
	m = /^b:([01]);$/.exec(text);
	if (m) return { kind: 'bool', value: m[1] === '1' };
	m = /^d:(-?(?:\d+\.?\d*|INF|NAN));$/.exec(text);
	if (m) return { kind: 'float', value: Number(m[1]) };
	m = /^s:(\d+):"([\s\S]*)";$/.exec(text);
	if (m) {
		// the length prefix counts bytes; a mismatch means the cell is not what it claims
		const bytes = new TextEncoder().encode(m[2]).length;
		if (bytes !== Number(m[1])) return undefined;
		return { kind: 'string', value: m[2] };
	}
	return undefined;
}

/** the serialized form Drupal's state store expects for a boolean */
export function serializeBool(value: unknown): string {
	return value ? 'b:1;' : 'b:0;';
}

/**
 * The installed schema version for one module, read from `key_value` (`system.schema`) so a
 * precondition refuses without booting PHP; undefined for absent, unparseable or non-integer.
 */
export function readSchemaVersion(sql: UpdbSql, module: unknown): number | undefined {
	try {
		const row = firstRow(
			sql.exec(
				'SELECT value FROM key_value WHERE collection = ? AND name = ?',
				'system.schema',
				String(module)
			)
		);
		if (row === undefined) return undefined;
		const parsed = serializedScalar(row.value);
		return parsed && parsed.kind === 'int' ? (parsed.value as number) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Maintenance mode, read from `key_value` (`State::set()` writes through before its cache).
 * Undefined when unparseable, which the gate refuses; absent is off.
 */
export function readMaintenanceMode(sql: UpdbSql): boolean | undefined {
	try {
		const row = firstRow(
			sql.exec(
				'SELECT value FROM key_value WHERE collection = ? AND name = ?',
				'state',
				'system.maintenance_mode'
			)
		);
		if (row === undefined) return false;
		const parsed = serializedScalar(row.value);
		if (!parsed) return undefined;
		if (parsed.kind === 'bool') return parsed.value as boolean;
		if (parsed.kind === 'int') return parsed.value !== 0;
		if (parsed.kind === 'null') return false;
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether a post-update function is already recorded as run (`key_value`, `post_update`); matches
 * the bytes `s:<len>:"<fn>";`, so a short name cannot match inside a longer one.
 */
export function postUpdateRegistered(sql: UpdbSql, fn: unknown): boolean | undefined {
	const name = String(fn);
	// the byte length must equal the character length for the needle to be right
	if (new TextEncoder().encode(name).length !== name.length) return undefined;
	try {
		const row = firstRow(
			sql.exec(
				'SELECT value FROM key_value WHERE collection = ? AND name = ?',
				'post_update',
				'existing_updates'
			)
		);
		if (row === undefined) return false;
		const text = asText(row.value);
		if (!/^a:\d+:\{/.test(text)) return undefined;
		return text.includes(`s:${name.length}:"${name}";`);
	} catch (e) {
		if (MISSING_TABLE.test(errorMessage(e))) return false;
		return undefined;
	}
}

/** a deterministic plan hash (FNV-1a, 32 bit, hex; `crypto.subtle` is async); detection only */
export function planHash(units: unknown): string {
	const canonical = JSON.stringify(
		(Array.isArray(units) ? units : []).map((u) => [
			u.kind ?? '',
			u.fn ?? '',
			u.module ?? '',
			u.number ?? '',
			u.step ?? '',
			u.expectSchema ?? '',
			u.seedSchema ?? ''
		])
	);
	let h = 0x811c9dc5;
	for (let i = 0; i < canonical.length; i++) {
		h ^= canonical.charCodeAt(i) & 0xff;
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/**
 * Turns the JSON `updbPlan()` printed into the ordered unit list, in `triggerBatch()`'s order;
 * `flushSplit: false` needs `allowUnbounded` (one 282.9 ms unit).
 */
export function buildPlanUnits(
	plan: UpdbUnitResult,
	options: { flushSplit?: boolean; allowUnbounded?: boolean; maintTarget?: boolean } = {}
): PlanUnit[] {
	const flushSplit = options.flushSplit !== false;
	const allowUnbounded = options.allowUnbounded === true;
	const units: PlanUnit[] = [];

	const flushBlock = (label: string) => {
		if (flushSplit) {
			for (const step of UPDB_FLUSH_STEPS) {
				units.push({ kind: 'flush', step, fn: `flush:${label}:${step}` });
			}
			return;
		}
		if (!allowUnbounded) {
			throw new Error(
				'flushSplit: false calls drupal_flush_all_caches() in one unit, measured at 282.9 ms in wasm. Pass allowUnbounded: true to run it whole rather than as eleven steps.'
			);
		}
		units.push({
			kind: 'flush',
			step: 'all',
			fn: `flush:${label}:all`,
			unbounded: true
		});
	};

	for (const u of Array.isArray(plan?.updates) ? plan.updates : []) {
		units.push({
			kind: 'update',
			fn: String(u.fn),
			module: String(u.module),
			number: Number(u.number),
			depMap: Array.isArray(u.depMap) ? u.depMap.map(String) : [],
			expectSchema: Number.isFinite(u.expectSchema) ? Number(u.expectSchema) : null,
			seedSchema: Number.isFinite(u.seedSchema) ? Number(u.seedSchema) : null
		});
	}

	const post = (Array.isArray(plan?.postUpdates) ? plan.postUpdates : []).map(String);
	if (post.length > 0) {
		flushBlock('pre-post');
		for (const fn of post) units.push({ kind: 'post_update', fn });
	}
	flushBlock('final');
	units.push({
		kind: 'maint_off',
		fn: 'maint_off',
		maintTarget: options.maintTarget === true
	});
	return units;
}

/**
 * Creates the plan and cursor tables in the object's SQL: not `put()` (async, and cursor reads
 * come from synchronous code) nor one JSON blob (a unit's large sandbox updates alone).
 */
export function ensureUpdbTables(sql: UpdbSql): boolean {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_updb_run (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      phase TEXT NOT NULL,
      cursor_seq INTEGER NOT NULL DEFAULT 0,
      max_seq INTEGER NOT NULL DEFAULT 0,
      planned INTEGER NOT NULL DEFAULT 0,
      code_id TEXT,
      plan_hash TEXT,
      maint_was INTEGER NOT NULL DEFAULT 0,
      abort_list TEXT NOT NULL DEFAULT '[]',
      snapshot TEXT,
      export_key TEXT,
      halt_reason TEXT,
      halt_detail TEXT,
      cold_waits INTEGER NOT NULL DEFAULT 0,
      rows_written INTEGER NOT NULL DEFAULT 0,
      statements INTEGER NOT NULL DEFAULT 0,
      db_size_before INTEGER,
      options TEXT NOT NULL DEFAULT '{}',
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`
	);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_updb_unit (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      fn TEXT,
      module TEXT,
      number INTEGER,
      step TEXT,
      dep_map TEXT NOT NULL DEFAULT '[]',
      expect_schema INTEGER,
      seed_schema INTEGER,
      maint_target INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      passes INTEGER NOT NULL DEFAULT 0,
      finished REAL NOT NULL DEFAULT 0,
      sandbox TEXT,
      message TEXT,
      error TEXT,
      rows_written INTEGER NOT NULL DEFAULT 0,
      statements INTEGER NOT NULL DEFAULT 0,
      claimed_at INTEGER,
      ended_at INTEGER,
      PRIMARY KEY (run_id, seq)
    )`
	);
	return true;
}

function jsonOr<T>(text: unknown, fallback: T): T {
	try {
		const v: T | null = JSON.parse(asText(text)) as T | null;
		return v === null || v === undefined ? fallback : v;
	} catch {
		return fallback;
	}
}

/** the live run, or undefined; terminal runs are returned too and the caller decides */
export function readRun(sql: UpdbSql): UpdbRun | undefined {
	ensureUpdbTables(sql);
	const row = firstRow(
		sql.exec('SELECT * FROM cfw_updb_run ORDER BY started_at DESC, id DESC LIMIT 1')
	);
	if (row === undefined) return undefined;
	return {
		id: String(row.id),
		schemaVersion: Number(row.schema_version),
		phase: String(row.phase),
		cursorSeq: Number(row.cursor_seq),
		maxSeq: Number(row.max_seq),
		planned: Number(row.planned) === 1,
		codeId: row.code_id === null ? null : String(row.code_id),
		planHash: row.plan_hash === null ? null : String(row.plan_hash),
		maintWas: Number(row.maint_was) === 1,
		abortList: jsonOr(row.abort_list, []),
		snapshot: row.snapshot === null ? null : jsonOr(row.snapshot, null),
		exportKey: row.export_key === null ? null : String(row.export_key),
		haltReason: row.halt_reason === null ? null : String(row.halt_reason),
		haltDetail: row.halt_detail === null ? null : String(row.halt_detail),
		coldWaits: Number(row.cold_waits),
		rowsWritten: Number(row.rows_written),
		statements: Number(row.statements),
		dbSizeBefore: row.db_size_before === null ? null : Number(row.db_size_before),
		options: jsonOr(row.options, {}),
		startedAt: Number(row.started_at),
		updatedAt: Number(row.updated_at)
	};
}

/** one unit, or undefined */
export function readUnit(sql: UpdbSql, runId: unknown, seq: unknown): UpdbUnit | undefined {
	const row = firstRow(
		sql.exec(
			'SELECT * FROM cfw_updb_unit WHERE run_id = ? AND seq = ?',
			String(runId),
			Number(seq)
		)
	);
	if (row === undefined) return undefined;
	return {
		runId: String(row.run_id),
		seq: Number(row.seq),
		kind: String(row.kind),
		fn: row.fn === null ? null : String(row.fn),
		module: row.module === null ? null : String(row.module),
		number: row.number === null ? null : Number(row.number),
		step: row.step === null ? null : String(row.step),
		depMap: jsonOr(row.dep_map, []),
		expectSchema: row.expect_schema === null ? null : Number(row.expect_schema),
		seedSchema: row.seed_schema === null ? null : Number(row.seed_schema),
		maintTarget: Number(row.maint_target) === 1,
		state: String(row.state),
		attempts: Number(row.attempts),
		passes: Number(row.passes),
		finished: Number(row.finished),
		sandbox: row.sandbox === null ? null : asText(row.sandbox),
		message: row.message === null ? null : String(row.message),
		error: row.error === null ? null : String(row.error),
		rowsWritten: Number(row.rows_written),
		statements: Number(row.statements),
		claimedAt: row.claimed_at === null ? null : Number(row.claimed_at),
		endedAt: row.ended_at === null ? null : Number(row.ended_at)
	};
}

function insertUnit(sql: UpdbSql, runId: string, seq: number, u: PlanUnit): void {
	sql.exec(
		`INSERT INTO cfw_updb_unit
       (run_id, seq, kind, fn, module, number, step, dep_map, expect_schema, seed_schema, maint_target, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
		String(runId),
		Number(seq),
		String(u.kind),
		u.fn === undefined ? null : String(u.fn),
		u.module === undefined ? null : String(u.module),
		Number.isFinite(u.number) ? Number(u.number) : null,
		u.step === undefined ? null : String(u.step),
		JSON.stringify(Array.isArray(u.depMap) ? u.depMap : []),
		Number.isFinite(u.expectSchema) ? Number(u.expectSchema) : null,
		Number.isFinite(u.seedSchema) ? Number(u.seedSchema) : null,
		u.maintTarget === true ? 1 : 0
	);
}

function touchRun(sql: UpdbSql, runId: string, now: number): void {
	sql.exec('UPDATE cfw_updb_run SET updated_at = ? WHERE id = ?', Number(now), String(runId));
}

/** `databaseSize` if the binding exposes it, else undefined; never guessed */
function databaseSize(sql: UpdbSql): number | undefined {
	const n = Number(sql?.databaseSize);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * Copies the bookkeeping tables (`CREATE TABLE ... AS SELECT`), refusing past a 20,000-row
 * ceiling, a fifth of the 100,000 rows/day meter; the refusal names the largest table.
 */
export function snapshotTables(sql: UpdbSql, options: UpdbOptions = {}) {
	const tables = Array.isArray(options.tables) ? options.tables : UPDB_SNAPSHOT_TABLES;
	const maxRows = Number.isFinite(options.maxRows) ? Number(options.maxRows) : 20000;
	const counts: Record<string, number> = {};
	const missing: string[] = [];
	let total = 0;
	for (const t of tables) {
		if (!/^[a-z_][a-z0-9_]*$/.test(t)) {
			return { ok: false, error: `refusing unsafe table name: ${t}` };
		}
		try {
			const c = Number(firstRow(sql.exec(`SELECT COUNT(*) AS c FROM ${t}`))?.c ?? 0);
			counts[t] = c;
			total += c;
		} catch (e) {
			if (MISSING_TABLE.test(errorMessage(e))) {
				missing.push(t);
				continue;
			}
			return { ok: false, error: errorMessage(e) };
		}
	}
	if (total > maxRows) {
		const worst = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
		return {
			ok: false,
			error: `snapshot would copy ${total} rows against a ${maxRows} ceiling (largest: ${worst?.[0]} at ${worst?.[1]}); rows written is the binding free-plan meter at 100,000/day`,
			counts,
			total
		};
	}
	let rowsWritten = 0;
	let statements = 0;
	for (const t of tables) {
		if (missing.includes(t)) continue;
		const snap = `cfw_updb_snap_${t}`;
		statements += 2;
		sql.exec(`DROP TABLE IF EXISTS ${snap}`);
		const cur = sql.exec(`CREATE TABLE ${snap} AS SELECT * FROM ${t}`);
		rowsWritten += Number(cur.rowsWritten ?? 0);
	}
	return { ok: true, counts, missing, total, rowsWritten, statements };
}

/** puts the bookkeeping back inside the caller's `transactionSync` (a half restore is worse) */
export function restoreSnapshot(
	sql: UpdbSql,
	options: UpdbOptions & { txn?: (fn: () => void) => void } = {}
) {
	const tables = Array.isArray(options.tables) ? options.tables : UPDB_SNAPSHOT_TABLES;
	const restored: string[] = [];
	const skipped: string[] = [];
	let rowsWritten = 0;
	let statements = 0;
	const body = () => {
		for (const t of tables) {
			if (!/^[a-z_][a-z0-9_]*$/.test(t)) continue;
			const snap = `cfw_updb_snap_${t}`;
			try {
				statements += 2;
				const del = sql.exec(`DELETE FROM ${t}`);
				rowsWritten += Number(del.rowsWritten ?? 0);
				const ins = sql.exec(`INSERT INTO ${t} SELECT * FROM ${snap}`);
				rowsWritten += Number(ins.rowsWritten ?? 0);
				restored.push(t);
			} catch (e) {
				if (MISSING_TABLE.test(errorMessage(e))) {
					skipped.push(t);
					continue;
				}
				throw e;
			}
		}
	};
	try {
		if (typeof options.txn === 'function') options.txn(body);
		else body();
	} catch (e) {
		return { ok: false, error: errorMessage(e), restored, skipped };
	}
	return { ok: true, restored, skipped, rowsWritten, statements };
}

/** drops the snapshot copies once a run is known good */
export function dropSnapshot(sql: UpdbSql, options: UpdbOptions = {}) {
	const tables = Array.isArray(options.tables) ? options.tables : UPDB_SNAPSHOT_TABLES;
	let statements = 0;
	for (const t of tables) {
		if (!/^[a-z_][a-z0-9_]*$/.test(t)) continue;
		statements++;
		sql.exec(`DROP TABLE IF EXISTS cfw_updb_snap_${t}`);
	}
	return { ok: true, statements };
}

/**
 * Starts a run (fence, snapshot, plan as the first three units); refuses while one is live.
 * `maint_was` is read in JS before any PHP runs, so the restored value predates the fence.
 */
export function updbPrepare(deps: UpdbDeps, options: UpdbOptions = {}) {
	const sql = deps.sql;
	ensureUpdbTables(sql);
	const now = deps.nowMs ? deps.nowMs() : Date.now();

	const existing = readRun(sql);
	if (existing && !RESTARTABLE_PHASES.includes(existing.phase)) {
		return {
			ok: false,
			reason: existing.phase === 'halted' ? 'previous-run-halted' : 'run-already-live',
			detail:
				existing.phase === 'halted'
					? `run ${existing.id} halted at seq ${existing.cursorSeq} with reason "${existing.haltReason}". A second cursor over the same schema is not allowed: roll it back, or abandon it explicitly.`
					: `run ${existing.id} is in phase ${existing.phase} at seq ${existing.cursorSeq}; finish it, or halt and roll it back first`,
			run: existing
		};
	}

	if (options.requireExport === true && !options.exportKey) {
		return {
			ok: false,
			reason: 'export-required',
			detail: 'requireExport is set and no exportKey was given. The snapshot restores update bookkeeping only; whole-site rollback is the R2 export from /export.'
		};
	}

	const maintWas = readMaintenanceMode(sql);
	if (maintWas === undefined) {
		return {
			ok: false,
			reason: 'maintenance-unreadable',
			detail: 'system.maintenance_mode is present in key_value but did not parse as a PHP-serialized scalar, so the value to restore at the end is unknown'
		};
	}

	const id = `r${now.toString(36)}`;
	sql.exec(
		`INSERT INTO cfw_updb_run
       (id, schema_version, phase, cursor_seq, max_seq, planned, maint_was, export_key,
        db_size_before, options, started_at, updated_at)
     VALUES (?, ?, 'planning', 0, 2, 0, ?, ?, ?, ?, ?, ?)`,
		id,
		UPDB_SCHEMA_VERSION,
		maintWas ? 1 : 0,
		options.exportKey ? String(options.exportKey) : null,
		databaseSize(sql) ?? null,
		JSON.stringify({
			flushSplit: options.flushSplit !== false,
			allowUnbounded: options.allowUnbounded === true,
			snapshotMaxRows: Number.isFinite(options.snapshotMaxRows)
				? Number(options.snapshotMaxRows)
				: 20000,
			retryPolicy: options.retryPolicy === 'core' ? 'core' : 'halt',
			onAbort: options.onAbort === 'continue' ? 'continue' : 'halt',
			maxAttempts: Number.isFinite(options.maxAttempts) ? Number(options.maxAttempts) : 3,
			maxPasses: Number.isFinite(options.maxPasses) ? Number(options.maxPasses) : 200,
			maxColdWaits: Number.isFinite(options.maxColdWaits) ? Number(options.maxColdWaits) : 30,
			checkRequirements: options.checkRequirements !== false
		}),
		now,
		now
	);

	// seq 0 fences before seq 2 plans, because planning writes (`_update_fix_missing_schema()`)
	insertUnit(sql, id, 0, { kind: 'maint_on', fn: 'maint_on' });
	insertUnit(sql, id, 1, { kind: 'snapshot', fn: 'snapshot' });
	insertUnit(sql, id, 2, { kind: 'plan', fn: 'plan' });

	return { ok: true, run: readRun(sql) ?? null, units: 3 };
}

/** the precondition gate: JS only, 1-3 statements, so a refusal skips a 3,754 ms boot */
export function updbPrecheck(
	sql: UpdbSql,
	run: UpdbRun,
	unit: UpdbUnit,
	options: UpdbOptions = {}
): { ok: boolean; reason?: string; detail?: string } {
	if (run.schemaVersion !== UPDB_SCHEMA_VERSION) {
		return {
			ok: false,
			reason: 'schema-version',
			detail: `run was written by updb schema ${run.schemaVersion}, this build is ${UPDB_SCHEMA_VERSION}`
		};
	}

	// a redeploy can swap the versioned pack under the cursor
	if (run.codeId && options.codeId && run.codeId !== options.codeId) {
		return {
			ok: false,
			reason: 'code-changed',
			detail: `plan was built against code ${run.codeId}, the tree is now ${options.codeId}`
		};
	}

	// the fence. maint_on has not raised it yet and maint_off is lowering it
	if (unit.kind !== 'maint_on' && unit.kind !== 'maint_off') {
		const maint = readMaintenanceMode(sql);
		if (maint === undefined) {
			return {
				ok: false,
				reason: 'maintenance-unreadable',
				detail: 'system.maintenance_mode did not parse, so the fence cannot be confirmed'
			};
		}
		if (maint !== true) {
			return {
				ok: false,
				reason: 'maintenance-off',
				detail: 'maintenance mode is off mid-run, so a request could observe a half-updated schema'
			};
		}
	}

	if (unit.kind === 'update' && unit.expectSchema !== null) {
		const installed = readSchemaVersion(sql, unit.module);
		if (installed === undefined) {
			return {
				ok: false,
				reason: 'schema-unreadable',
				detail: `no parseable system.schema row for ${unit.module}`
			};
		}
		if (installed !== unit.expectSchema) {
			return {
				ok: false,
				reason: 'schema-mismatch',
				detail: `${unit.module} is at schema ${installed}, the plan expects ${unit.expectSchema} before ${unit.fn}`
			};
		}
	}

	if (unit.kind === 'post_update') {
		const already = postUpdateRegistered(sql, unit.fn);
		if (already === undefined) {
			return {
				ok: false,
				reason: 'post-update-registry-unreadable',
				detail: 'key_value post_update/existing_updates is present but is not a serialized array'
			};
		}
		if (already === true) {
			return {
				ok: false,
				reason: 'post-update-already-run',
				detail: `${unit.fn} is already recorded in existing_updates`
			};
		}
	}

	const maxPasses = Number(run.options?.maxPasses ?? 200);
	if (unit.passes >= maxPasses) {
		return {
			ok: false,
			reason: 'max-passes',
			detail: `${unit.fn} has taken ${unit.passes} passes without reporting finished >= 1`
		};
	}

	return { ok: true };
}

/** stops the run, loudly and durably; maintenance mode stays on */
export function updbHalt(
	sql: UpdbSql,
	run: UpdbRun,
	reason: string | undefined,
	detail?: string | null,
	now = Date.now()
): { phase: string; reason: string; detail: string | null } {
	sql.exec(
		"UPDATE cfw_updb_run SET phase = 'halted', halt_reason = ?, halt_detail = ?, updated_at = ? WHERE id = ?",
		String(reason),
		detail === undefined || detail === null ? null : String(detail).slice(0, 900),
		Number(now),
		String(run.id)
	);
	return { phase: 'halted', reason: String(reason), detail: detail ?? null };
}

/**
 * Undoes what the snapshot covers (not content tables); only legal from `halted`. Maintenance
 * mode stays on: the bookkeeping now reads "updates pending" against the new code.
 */
export function updbRollback(deps: UpdbDeps, options: UpdbOptions = {}) {
	const sql = deps.sql;
	const now = deps.nowMs ? deps.nowMs() : Date.now();
	const run = readRun(sql);
	if (!run) return { ok: false, reason: 'no-run' };
	if (run.phase !== 'halted') {
		return {
			ok: false,
			reason: 'not-halted',
			detail: `rollback is only legal from a halted run; this one is ${run.phase}`
		};
	}
	if (!run.snapshot || run.snapshot.ok !== true) {
		return {
			ok: false,
			reason: 'no-snapshot',
			detail: 'this run has no usable bookkeeping snapshot, so there is nothing to restore. The whole-site path is the R2 export.'
		};
	}
	const restored = restoreSnapshot(sql, {
		tables: options.tables,
		txn: deps.txn
	});
	if (!restored.ok) {
		return { ok: false, reason: 'restore-failed', detail: restored.error };
	}
	sql.exec(
		"UPDATE cfw_updb_run SET phase = 'rolled_back', updated_at = ? WHERE id = ?",
		now,
		run.id
	);
	return {
		ok: true,
		restored: restored.restored,
		skipped: restored.skipped,
		rowsWritten: restored.rowsWritten,
		covers: 'update bookkeeping (key_value, config, cachetags) only',
		doesNotCover:
			"anything a hook_update_N wrote to content or field tables; that is the R2 export's job",
		maintenanceMode: 'left ON: the site is not proven good'
	};
}

/**
 * Accepts a halted run as-is so a new run may be prepared; never automatic, and it records the
 * operator's reason so a decision, not a silently reused state, is on the record.
 */
export function updbAbandon(deps: UpdbDeps, options: UpdbOptions = {}) {
	const sql = deps.sql;
	const now = deps.nowMs ? deps.nowMs() : Date.now();
	const run = readRun(sql);
	if (!run) return { ok: false, reason: 'no-run' };
	if (run.phase !== 'halted') {
		return {
			ok: false,
			reason: 'not-halted',
			detail: `abandon is only legal from a halted run; this one is ${run.phase}`
		};
	}
	if (typeof options.reason !== 'string' || options.reason.trim().length === 0) {
		return {
			ok: false,
			reason: 'reason-required',
			detail: 'abandoning a halted update run requires a written reason, because the next reader has to know a human decided this'
		};
	}
	sql.exec(
		"UPDATE cfw_updb_run SET phase = 'abandoned', halt_detail = ?, updated_at = ? WHERE id = ?",
		`${run.haltDetail ?? ''} | ABANDONED: ${options.reason}`.slice(0, 900),
		now,
		run.id
	);
	return {
		ok: true,
		phase: 'abandoned',
		was: run.haltReason,
		reason: options.reason
	};
}

/**
 * Does one beat (`claim` then `run` per unit) and reports whether to re-arm. `maxBeats` above 1 is
 * paid-only: no clock bounds a unit's CPU, and batching collapses the crash granularity.
 */
export async function updbStep(deps: UpdbDeps, options: UpdbOptions = {}): Promise<UpdbBeat> {
	const sql = deps.sql;
	ensureUpdbTables(sql);
	const now = deps.nowMs ? deps.nowMs() : Date.now();
	const tokens = tokenHolder(deps);
	const run = readRun(sql);

	if (!run) {
		return {
			ok: true,
			beat: 'none',
			ran: false,
			more: false,
			reason: 'no-run'
		};
	}
	if (TERMINAL_PHASES.includes(run.phase)) {
		// idempotent by construction: a terminal run writes nothing, ever again
		return {
			ok: run.phase !== 'halted',
			beat: 'none',
			ran: false,
			more: false,
			runId: run.id,
			phase: run.phase,
			reason: run.phase === 'halted' ? (run.haltReason ?? 'halted') : run.phase,
			detail: run.haltDetail ?? null
		};
	}

	if (run.cursorSeq > run.maxSeq) {
		sql.exec(
			"UPDATE cfw_updb_run SET phase = 'complete', updated_at = ? WHERE id = ?",
			now,
			run.id
		);
		return {
			ok: true,
			beat: 'none',
			ran: false,
			more: false,
			runId: run.id,
			phase: 'complete',
			reason: 'complete'
		};
	}

	const unit = readUnit(sql, run.id, run.cursorSeq);
	if (!unit) {
		const h = updbHalt(
			sql,
			run,
			'cursor-desync',
			`no unit at seq ${run.cursorSeq} of ${run.maxSeq}`,
			now
		);
		return {
			ok: false,
			beat: 'none',
			ran: false,
			more: false,
			runId: run.id,
			...h
		};
	}
	if (unit.state === 'done' || unit.state === 'aborted' || unit.state === 'skipped') {
		const h = updbHalt(
			sql,
			run,
			'cursor-desync',
			`unit ${unit.seq} (${unit.fn}) is ${unit.state} but the cursor still points at it`,
			now
		);
		return {
			ok: false,
			beat: 'none',
			ran: false,
			more: false,
			runId: run.id,
			...h
		};
	}

	// the claim beat
	if (unit.state === 'pending') {
		const pre = updbPrecheck(sql, run, unit, options);
		if (!pre.ok) {
			const h = updbHalt(sql, run, pre.reason, pre.detail, now);
			return {
				ok: false,
				beat: 'claim',
				ran: false,
				more: false,
				runId: run.id,
				seq: unit.seq,
				kind: unit.kind,
				fn: unit.fn,
				...h
			};
		}
		sql.exec(
			"UPDATE cfw_updb_unit SET state = 'claimed', attempts = attempts + 1, claimed_at = ? WHERE run_id = ? AND seq = ?",
			now,
			run.id,
			unit.seq
		);
		touchRun(sql, run.id, now);
		// issued after the write, so a claim beat that dies leaves no token for an uncommitted run
		tokens.set({
			runId: run.id,
			seq: unit.seq,
			attempts: unit.attempts + 1,
			issuedAt: now
		});
		return {
			ok: true,
			beat: 'claim',
			ran: false,
			more: true,
			runId: run.id,
			phase: run.phase,
			seq: unit.seq,
			kind: unit.kind,
			fn: unit.fn,
			attempts: unit.attempts + 1,
			reason: null
		};
	}

	// a claim with no matching token: the run beat was killed after consuming it, or the object
	// was evicted between beats; storage cannot tell which, so this fails closed
	const token = tokens.get();
	if (!tokenMatches(token, run, unit)) {
		const policy = String(run.options?.retryPolicy ?? 'halt');
		if (policy !== 'core') {
			const h = updbHalt(
				sql,
				run,
				'unit-unverifiable',
				`unit ${unit.seq} (${unit.fn}) is claimed at attempt ${unit.attempts} with ${unit.passes} committed passes, and this instance holds no run token for it. Either the invocation that entered the interpreter died, or the object was evicted between beats -- and those are indistinguishable from storage alone, because whatever state a run beat reads is also the state a killed run beat leaves. retryPolicy is "halt": whether a killed event's partial writes are discarded is UNMEASURED on this platform, so re-running is not assumed safe. Roll back, or set retryPolicy "core" to accept core's own batch semantics (its batch API re-runs an operation from its last persisted sandbox after a fatal).`,
				now
			);
			return {
				ok: false,
				beat: 'run',
				ran: false,
				more: false,
				runId: run.id,
				seq: unit.seq,
				kind: unit.kind,
				fn: unit.fn,
				attempts: unit.attempts,
				passes: unit.passes,
				...h
			};
		}
		// retryPolicy "core": re-claim rather than run, so `maxAttempts` still bounds the loop
		const maxAttempts = Number(run.options?.maxAttempts ?? 3);
		if (unit.attempts >= maxAttempts) {
			const h = updbHalt(
				sql,
				run,
				'max-attempts',
				`unit ${unit.seq} (${unit.fn}) has been claimed ${unit.attempts} times without committing; retryPolicy "core" gives up at ${maxAttempts}`,
				now
			);
			return {
				ok: false,
				beat: 'run',
				ran: false,
				more: false,
				runId: run.id,
				seq: unit.seq,
				kind: unit.kind,
				fn: unit.fn,
				...h
			};
		}
		sql.exec(
			'UPDATE cfw_updb_unit SET attempts = attempts + 1, claimed_at = ? WHERE run_id = ? AND seq = ?',
			now,
			run.id,
			unit.seq
		);
		touchRun(sql, run.id, now);
		tokens.set({
			runId: run.id,
			seq: unit.seq,
			attempts: unit.attempts + 1,
			issuedAt: now
		});
		return {
			ok: true,
			beat: 'claim',
			ran: false,
			more: true,
			reclaimed: true,
			runId: run.id,
			phase: run.phase,
			seq: unit.seq,
			kind: unit.kind,
			fn: unit.fn,
			attempts: unit.attempts + 1,
			reason: 'reclaimed-after-unverifiable'
		};
	}
	// single use: consumed before the interpreter is entered, so a kill inside PHP leaves no token
	tokens.clear();

	// the run beat; re-check the live preconditions so either beat can refuse
	const pre = updbPrecheck(sql, run, unit, options);
	if (!pre.ok) {
		const h = updbHalt(sql, run, pre.reason, pre.detail, now);
		return {
			ok: false,
			beat: 'run',
			ran: false,
			more: false,
			runId: run.id,
			seq: unit.seq,
			kind: unit.kind,
			fn: unit.fn,
			...h
		};
	}

	const needsPhp = unit.kind !== 'snapshot';
	if (needsPhp && deps.phpReady && deps.phpReady() !== true) {
		// a boot is 3,754 ms of cpuTime in one synchronous stretch no cursor splits, so wait for
		// traffic or the keep-warm alarm (bounded, then halt naming the blocker)
		const waits = run.coldWaits + 1;
		const maxColdWaits = Number(run.options?.maxColdWaits ?? 30);
		if (waits > maxColdWaits) {
			const h = updbHalt(
				sql,
				run,
				'cold-interpreter',
				`the interpreter has been cold for ${waits} beats. Boot is 3,754 ms of cpuTime on the edge in one indivisible synchronous call, so a free-plan invocation cannot pay it; the chain needs an already-warm object, or a -sJSPI build that can slice the boot.`,
				now
			);
			return {
				ok: false,
				beat: 'run',
				ran: false,
				more: false,
				runId: run.id,
				seq: unit.seq,
				kind: unit.kind,
				fn: unit.fn,
				...h
			};
		}
		sql.exec(
			'UPDATE cfw_updb_run SET cold_waits = ?, updated_at = ? WHERE id = ?',
			waits,
			now,
			run.id
		);
		// re-issue the consumed token, or the next beat halts the run as unverifiable (a fake kill)
		tokens.set({
			runId: run.id,
			seq: unit.seq,
			attempts: unit.attempts,
			issuedAt: now
		});
		return {
			ok: true,
			beat: 'run',
			ran: false,
			more: true,
			cold: true,
			coldWaits: waits,
			runId: run.id,
			phase: run.phase,
			seq: unit.seq,
			kind: unit.kind,
			fn: unit.fn,
			reason: 'cold-interpreter'
		};
	}

	const before = deps.meters ? deps.meters() : null;
	let result: UpdbUnitResult | null = null;
	let thrown: string | null = null;
	let appended = 0;

	try {
		if (unit.kind === 'snapshot') {
			const snap = snapshotTables(sql, {
				maxRows: Number(run.options?.snapshotMaxRows ?? 20000),
				tables: options.snapshotTables
			});
			sql.exec(
				'UPDATE cfw_updb_run SET snapshot = ?, updated_at = ? WHERE id = ?',
				JSON.stringify(snap),
				now,
				run.id
			);
			if (!snap.ok) {
				const h = updbHalt(sql, run, 'snapshot-refused', snap.error, now);
				return {
					ok: false,
					beat: 'run',
					ran: true,
					more: false,
					runId: run.id,
					seq: unit.seq,
					kind: unit.kind,
					fn: unit.fn,
					...h
				};
			}
			// no `ok: true`: `snap.ok` is already true here and the spread would overwrite it
			result = { finished: 1, ...snap };
		} else if (unit.kind === 'plan') {
			result = await deps.runJson(updbPlan(run.options?.checkRequirements !== false));
			if (result?.ok !== true) {
				const h = updbHalt(
					sql,
					run,
					'plan-failed',
					String(
						result?.error ??
							result?.postUpdateError ??
							'the plan fragment did not report ok'
					),
					now
				);
				return {
					ok: false,
					beat: 'run',
					ran: true,
					more: false,
					runId: run.id,
					seq: unit.seq,
					kind: unit.kind,
					fn: unit.fn,
					plan: result,
					...h
				};
			}
			const errors = result.requirementErrors ?? {};
			if (Object.keys(errors).length > 0) {
				const h = updbHalt(
					sql,
					run,
					'requirements-error',
					`core reports requirement errors: ${JSON.stringify(errors).slice(0, 600)}`,
					now
				);
				return {
					ok: false,
					beat: 'run',
					ran: true,
					more: false,
					runId: run.id,
					seq: unit.seq,
					kind: unit.kind,
					fn: unit.fn,
					plan: result,
					...h
				};
			}
			let planned;
			try {
				planned = buildPlanUnits(result, {
					flushSplit: run.options?.flushSplit !== false,
					allowUnbounded: run.options?.allowUnbounded === true,
					maintTarget: run.maintWas
				});
			} catch (e) {
				const h = updbHalt(sql, run, 'plan-refused', errorMessage(e), now);
				return {
					ok: false,
					beat: 'run',
					ran: true,
					more: false,
					runId: run.id,
					seq: unit.seq,
					kind: unit.kind,
					fn: unit.fn,
					...h
				};
			}
			const body = () => {
				let seq = unit.seq + 1;
				for (const u of planned) {
					insertUnit(sql, run.id, seq, u);
					seq++;
				}
				sql.exec(
					`UPDATE cfw_updb_run SET phase = 'running', planned = 1, max_seq = ?,
             code_id = ?, plan_hash = ?, updated_at = ? WHERE id = ?`,
					seq - 1,
					String(result!.codeId ?? ''),
					planHash(planned),
					now,
					run.id
				);
			};
			if (typeof deps.txn === 'function') deps.txn(body);
			else body();
			appended = planned.length;
			result.finished = 1;
			result.appended = appended;
		} else {
			result = await deps.runJson(
				updbUnit({
					seq: unit.seq,
					kind: unit.kind,
					fn: unit.fn,
					module: unit.module,
					number: unit.number,
					step: unit.step,
					depMap: unit.depMap,
					seedSchema: unit.seedSchema,
					sandbox: unit.sandbox,
					abortList: run.abortList,
					maintTarget: unit.maintTarget
				})
			);
		}
	} catch (e) {
		thrown = errorMessage(e);
	}

	const after = deps.meters ? deps.meters() : null;
	const rows = before && after ? Number(after.rowsWritten) - Number(before.rowsWritten) : 0;
	const statements = before && after ? Number(after.statements) - Number(before.statements) : 0;

	if (thrown !== null) {
		// a throw's writes already happened, so halt in this event (a real kill writes nothing and
		// the claim beat catches it)
		sql.exec(
			'UPDATE cfw_updb_unit SET error = ?, rows_written = ?, statements = ? WHERE run_id = ? AND seq = ?',
			thrown.slice(0, 900),
			rows,
			statements,
			run.id,
			unit.seq
		);
		const h = updbHalt(sql, run, 'unit-error', thrown, now);
		return {
			ok: false,
			beat: 'run',
			ran: true,
			more: false,
			runId: run.id,
			seq: unit.seq,
			kind: unit.kind,
			fn: unit.fn,
			...h
		};
	}

	const refused = typeof result?.refused === 'string' ? result!.refused : null;
	if (refused !== null) {
		sql.exec(
			'UPDATE cfw_updb_unit SET error = ?, rows_written = ?, statements = ? WHERE run_id = ? AND seq = ?',
			String(result!.error ?? refused).slice(0, 900),
			rows,
			statements,
			run.id,
			unit.seq
		);
		const h = updbHalt(sql, run, refused, String(result!.error ?? refused), now);
		return {
			ok: false,
			beat: 'run',
			ran: true,
			more: false,
			runId: run.id,
			seq: unit.seq,
			kind: unit.kind,
			fn: unit.fn,
			...h
		};
	}

	const aborts = Array.isArray(result?.abort) ? result!.abort.map(String) : [];
	const newAborts = aborts.filter((a: string) => !run.abortList.includes(a));
	const finished = Number.isFinite(Number(result?.finished)) ? Number(result!.finished) : 0;
	const message =
		typeof result?.message === 'string'
			? result!.message.slice(0, 400)
			: result?.escaped
				? String(result!.escaped).slice(0, 400)
				: null;
	const sandbox = typeof result?.sandbox === 'string' ? result!.sandbox : null;

	// an aborted unit is recorded, then halted by default (`onAbort: "continue"` matches core,
	// which skips whatever depended on the failure)
	if (aborts.length > 0 || result?.ok !== true) {
		const mergedAborts = [...run.abortList, ...newAborts];
		const body = () => {
			sql.exec(
				`UPDATE cfw_updb_unit SET state = 'aborted', finished = ?, message = ?, error = ?,
           sandbox = ?, rows_written = ?, statements = ?, ended_at = ?
         WHERE run_id = ? AND seq = ?`,
				finished,
				message,
				String(result?.error ?? result?.abortMessage ?? result?.escaped ?? 'aborted').slice(
					0,
					900
				),
				sandbox,
				rows,
				statements,
				now,
				run.id,
				unit.seq
			);
			sql.exec(
				`UPDATE cfw_updb_run SET abort_list = ?, rows_written = rows_written + ?,
           statements = statements + ?, cursor_seq = ?, updated_at = ? WHERE id = ?`,
				JSON.stringify(mergedAborts),
				rows,
				statements,
				unit.seq + 1,
				now,
				run.id
			);
		};
		if (typeof deps.txn === 'function') deps.txn(body);
		else body();

		if (String(run.options?.onAbort ?? 'halt') !== 'continue') {
			const h = updbHalt(
				sql,
				run,
				'unit-aborted',
				`${unit.fn} aborted: ${String(result?.abortMessage ?? result?.error ?? result?.escaped ?? 'no message')}`.slice(
					0,
					900
				),
				now
			);
			return {
				ok: false,
				beat: 'run',
				ran: true,
				more: false,
				runId: run.id,
				seq: unit.seq,
				kind: unit.kind,
				fn: unit.fn,
				aborted: newAborts,
				result,
				...h
			};
		}
		return {
			ok: false,
			beat: 'run',
			ran: true,
			more: unit.seq + 1 <= run.maxSeq,
			runId: run.id,
			phase: run.phase,
			seq: unit.seq,
			kind: unit.kind,
			fn: unit.fn,
			aborted: newAborts,
			reason: 'unit-aborted',
			result,
			meters: { rows, statements }
		};
	}

	// a partial pass goes back to `pending`, so "claimed at claim time" stays a crash signal
	if (finished < 1) {
		const body = () => {
			sql.exec(
				`UPDATE cfw_updb_unit SET state = 'pending', passes = passes + 1, finished = ?,
           message = ?, sandbox = ?, rows_written = rows_written + ?,
           statements = statements + ? WHERE run_id = ? AND seq = ?`,
				finished,
				message,
				sandbox,
				rows,
				statements,
				run.id,
				unit.seq
			);
			sql.exec(
				`UPDATE cfw_updb_run SET rows_written = rows_written + ?, statements = statements + ?,
           cold_waits = 0, updated_at = ? WHERE id = ?`,
				rows,
				statements,
				now,
				run.id
			);
		};
		if (typeof deps.txn === 'function') deps.txn(body);
		else body();
		return {
			ok: true,
			beat: 'run',
			ran: true,
			more: true,
			partial: true,
			runId: run.id,
			phase: run.phase,
			seq: unit.seq,
			kind: unit.kind,
			fn: unit.fn,
			finished,
			passes: unit.passes + 1,
			result,
			meters: { rows, statements },
			reason: null
		};
	}

	// done: the result, the cursor advance and the meters in one atomic write
	const nextSeq = unit.seq + 1;
	const bodyDone = () => {
		sql.exec(
			`UPDATE cfw_updb_unit SET state = 'done', passes = passes + 1, finished = ?,
         message = ?, sandbox = ?, rows_written = rows_written + ?,
         statements = statements + ?, ended_at = ? WHERE run_id = ? AND seq = ?`,
			finished,
			message,
			sandbox,
			rows,
			statements,
			now,
			run.id,
			unit.seq
		);
		sql.exec(
			`UPDATE cfw_updb_run SET cursor_seq = ?, rows_written = rows_written + ?,
         statements = statements + ?, cold_waits = 0, updated_at = ?,
         phase = CASE WHEN ? > max_seq THEN 'complete' ELSE phase END WHERE id = ?`,
			nextSeq,
			rows,
			statements,
			now,
			nextSeq,
			run.id
		);
	};
	if (typeof deps.txn === 'function') deps.txn(bodyDone);
	else bodyDone();

	const maxSeq = unit.kind === 'plan' ? unit.seq + appended : run.maxSeq;
	const more = nextSeq <= maxSeq;
	return {
		ok: true,
		beat: 'run',
		ran: true,
		more,
		runId: run.id,
		phase: more ? 'running' : 'complete',
		seq: unit.seq,
		kind: unit.kind,
		fn: unit.fn,
		finished,
		appended: unit.kind === 'plan' ? appended : undefined,
		result,
		meters: { rows, statements },
		reason: null
	};
}

/** runs beats until the chain says stop; `maxBeats` stays 1 on free (see `updbStep()`) */
export async function updbDrain(
	deps: UpdbDeps,
	options: UpdbOptions = {}
): Promise<{ beats: UpdbBeat[]; last: UpdbBeat | null }> {
	const maxBeats = Number.isFinite(options.maxBeats) ? Number(options.maxBeats) : 1;
	const beats: UpdbBeat[] = [];
	for (let i = 0; i < Math.max(1, maxBeats); i++) {
		const step = await updbStep(deps, options);
		beats.push(step);
		if (!step.more) break;
	}
	return { beats, last: beats[beats.length - 1] ?? null };
}

/**
 * When the next alarm should fire: +1 ms while the chain has work (a fresh CPU budget, and it
 * keeps the object resident); a cold beat backs off and lets traffic or keep-warm boot it.
 */
export function updbAlarmDelayMs(
	step?: { cold?: boolean; more?: boolean } | null,
	options: UpdbOptions = {}
): number {
	if (step?.cold === true) return options.coldMs ?? 5000;
	if (step?.more) return options.chainMs ?? 1;
	return options.idleMs ?? 240000;
}

/** everything a diagnostics route needs, in one read-only call */
export function updbStatus(sql: UpdbSql) {
	ensureUpdbTables(sql);
	const run = readRun(sql);
	if (!run) return { run: null, units: [] };
	const units = sql
		.exec(
			`SELECT seq, kind, fn, module, number, step, state, attempts, passes, finished,
              rows_written, statements, message, error
         FROM cfw_updb_unit WHERE run_id = ? ORDER BY seq`,
			run.id
		)
		.toArray();
	const byState: Record<string, number> = {};
	for (const u of units) {
		const s = String(u.state);
		byState[s] = (byState[s] ?? 0) + 1;
	}
	return {
		run,
		units,
		byState,
		at: units.find((u) => Number(u.seq) === run.cursorSeq) ?? null,
		remaining: Math.max(0, run.maxSeq - run.cursorSeq + 1)
	};
}

/** every knob, read from env in one call, matching cronOptions() */
export function updbOptions(env?: UpdbEnv | null): UpdbOptions {
	return {
		flushSplit: env?.UPDB_FLUSH_SPLIT !== '0',
		allowUnbounded: env?.UPDB_ALLOW_UNBOUNDED === '1',
		snapshotMaxRows: numOr(env?.UPDB_SNAPSHOT_MAX_ROWS, 20000),
		retryPolicy: env?.UPDB_RETRY_POLICY === 'core' ? 'core' : 'halt',
		onAbort: env?.UPDB_ON_ABORT === 'continue' ? 'continue' : 'halt',
		maxAttempts: numOr(env?.UPDB_MAX_ATTEMPTS, 3),
		maxPasses: numOr(env?.UPDB_MAX_PASSES, 200),
		maxColdWaits: numOr(env?.UPDB_MAX_COLD_WAITS, 30),
		maxBeats: numOr(env?.UPDB_MAX_BEATS, 1),
		checkRequirements: env?.UPDB_CHECK_REQUIREMENTS !== '0',
		idleMs: numOr(env?.KEEP_WARM_MS, 240000)
	};
}

function numOr(raw: unknown, fallback: number): number {
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
