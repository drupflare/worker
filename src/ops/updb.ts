/**
 * `updb` sliced across Durable Object invocations: the plan, the cursor, and the
 * contract that makes a half-applied update impossible to produce silently.
 *
 * **The problem, in measured numbers.**
 *
 * A security release ships database updates. Applying them means every pending
 * `hook_update_N()`, every pending `hook_post_update_NAME()`, and
 * `drupal_flush_all_caches()` twice. Measured in this project (TECHNICAL_REPORT.md
 * "Module installation"): the install-class workload is **1,344.7 ms of CPU and a
 * 78.5 MB peak**, of which `drupal_flush_all_caches()` alone is **282.9 ms in wasm
 * / 268.8 ms native, and the 78.5 MB peak is its**.
 *
 * The free plan gives **10 ms of CPU per invocation** -- for Durable Objects too,
 * and explicitly including alarm invocations -- and **100,000 rows written per day**,
 * which is the meter that actually binds. So `drupal_flush_all_caches()` is 28x one
 * invocation's entire budget in a single synchronous call, and the whole workload is
 * 134x.
 *
 * Four platform facts constrain every possible answer, all measured here:
 *
 *   1. `ctx.storage.sql` is synchronous and only reachable from inside the DO.
 *      There is no async seam to suspend at mid-update.
 *   2. The object HIBERNATES after ~10 s idle and DISCARDS in-memory state,
 *      including the interpreter, the mounted tree and the booted kernel.
 *      Confirmed directly: `x-cfw-php-booted` flipped 1 -> 0 between two curls
 *      seconds apart, and the JSPI park probe found a parked stack survives 6 s
 *      and is gone at 10 s.
 *   3. Neither clock works. In-PHP `microtime()` returns 0 on the edge, and
 *      `Date.now()` is frozen during synchronous execution -- 16 assembly renders
 *      reported wallMs 0 while tail charged them 27-120 ms. **So no loop in this
 *      file may be driven by a clock.** The cost meter here is rows and statements
 *      off the cursor, which our own bridge increments per statement.
 *   4. A render cannot be interrupted once started: a `setTimeout(1)` raced
 *      against a 119 ms render LOST, because the timer cannot fire until the wasm
 *      call returns. Every budget decision is therefore a PRE-check, never a race.
 *
 * **The avenues, costed, and which one this file is.**
 *
 * **(a) One `hook_update_N` per invocation, cursor in DO storage.** Necessary
 * skeleton, not sufficient on its own: it splits the TOTAL across invocations but
 * enlarges none of them, exactly as the 20-hop measurement showed (142 ms of CPU
 * for one request, no single hop over 10 ms). A single hook, or a single
 * `drupal_flush_all_caches()`, still does not fit. **Adopted, plus (c).**
 *
 * **(b) A warm window held by an outbound WebSocket.** A socket holds the object
 * alive for a documented 15 minutes, and each inbound message resets the 10 ms
 * budget. Costed: 15 minutes of resident object is 0.25 h against the 28.2
 * active-hours/day the 13,000 GB-s free duration allowance buys -- **0.9% of a day**,
 * so duration is not the objection. **Rejected as the default anyway**, because the
 * alarm chain already achieves the same thing for less: re-arming at +1 ms puts the
 * next unit ~1 ms of wall clock later, which is three orders of magnitude inside the
 * 6-10 s eviction window, and costs 1 row written per re-arm instead of a held
 * connection and a 15-minute ceiling. Kept as the escape hatch for the one case the
 * alarm chain cannot cover: alarm delivery is documented best-effort, so a stalled
 * chain needs an outside poke, and a socket is that poke.
 *
 * **(c) Split the indivisible-looking step until each piece is bounded.**
 * `drupal_flush_all_caches()` is not one operation, it is eleven, and core names
 * them (common.inc:408-475). `UPDB_FLUSH_STEPS` in src/updb-php.js runs them as
 * eleven units in core's own order. This is the only avenue that attacks the
 * single largest cost rather than relocating it. **Adopted.**
 *
 * **(d) Batch by measured cost rather than by count.** Adopted in a weak form,
 * because of fact 3 above: there is no clock, so "cost" can only
 * mean rows written and statements executed, and neither is CPU --
 * `drupal_flush_all_caches()` is 282.9 ms across very few statements. So batching
 * can amortise the re-arm row but cannot protect the CPU cap. `maxBeats` defaults to
 * **1**, every unit records the rows and statements it actually cost so a future
 * round has real per-unit data, and the docblock on `updbStep()` says plainly that
 * raising it above 1 is a paid-plan setting.
 *
 * **(e) Run against a COPY of the database and swap atomically.** **Rejected**, and
 * recorded so nobody re-derives it. Three findings kill it:
 *   - Rows written is the binding meter, and a copy costs one written row per row
 *     copied. The packed standard site is 1,342 rows, so copying THAT is 1.3% of a
 *     day -- affordable. A small real site with content is 50k-200k rows, so one
 *     copy is 50-200% of the daily allowance, and it fails by exhausting a meter
 *     shared with the serving path.
 *   - Size is not even the deciding objection. To run updates against the copy,
 *     Drupal has to ADDRESS the copy, which means a table prefix, and the driver
 *     **refuses prefixes** (DRIVER-NOTES.md). Copy-and-swap is therefore new driver
 *     work, not new SQL.
 *   - The swap needs `ALTER TABLE ... RENAME`, and DDL mid-flight dirties
 *     `sqlite_master`, which turns every later read in a transaction into a
 *     speculative replay -- the O(W x R) cost this project has already observed
 *     wedging the local runtime badly enough that unrelated sites stopped
 *     responding.
 *   Replaced by (f) plus (g), which buy the same guarantee for a bounded price.
 *
 * **(f) A maintenance-mode gate.** Adopted, and it is the FIRST unit, not a wrapper:
 * `maint_on` is seq 0 so the fence is durable before anything -- including the
 * planning step, which writes (`_update_fix_missing_schema()` sets schema versions).
 * `maint_off` is the last unit and restores the PRE-RUN value rather than forcing
 * FALSE, which is what `DbUpdateController::batchFinished()` does through the
 * session; here it comes out of the run row, so it survives an eviction a session
 * would not.
 *
 * **(g) Bounded snapshots plus an export for rollback.** Adopted. `snapshot` (seq 1)
 * copies the update system's own bookkeeping -- `key_value`, `key_value_expire`,
 * `config`, `cachetags` -- with a row ceiling that refuses rather than quietly
 * spending the day's writes. **Limitation:** that restores
 * "which updates ran" and the config they changed, NOT what a hook did to
 * `node_field_data`. Whole-site rollback is the R2 export, which
 * `exportDatabase()`/`/export` already produces, and `requireExport` makes it a
 * precondition of starting.
 *
 * **The choice, and what it costs.**
 *
 * A maintenance-fenced, JS-prechecked, TWO-BEAT alarm chain: one claim beat and one
 * run beat per unit, plan and cursor in `ctx.storage.sql`, the flush split eleven
 * ways, bookkeeping snapshotted, and **HALT rather than retry as the default
 * response to anything unexpected.**
 *
 * Cost for a typical SA-CORE point release (0-3 `hook_update_N`, 0-2 post-updates),
 * derived from the plan shape, not measured on the edge:
 *
 *   | | count |
 *   | --- | --- |
 *   | units: maint_on + snapshot + plan + 3 updates + 11 flush + 2 post + 11 flush + maint_off | 31 |
 *   | DO invocations, at 2 beats per unit | 62 |
 *   | rows written: ~2 bookkeeping + 1 setAlarm per beat | ~190 |
 *   | fraction of the 100,000/day request allowance | 0.06% |
 *   | fraction of the 100,000/day row allowance | 0.19% |
 *
 * So the chain itself is free. **The cost that is NOT free: boot.**
 * A cold interpreter is 3,754 ms of cpuTime on the edge in one indivisible
 * synchronous stretch -- 375x the free cap -- and no cursor design cuts that up.
 * Therefore:
 *
 *   - On paid, this runs today, and its value is the never-half-applies contract
 *     rather than the CPU split.
 *   - On free, every unit in this design fits 10 ms **provided the object is already
 *     warm**, which is what the keep-warm alarm and (b) exist for. A chain that
 *     starts cold cannot boot, so `updbStep()` refuses on a cold interpreter with
 *     `reason: "cold-interpreter"` rather than burning an invocation that will be
 *     killed. That refusal is bounded by `maxColdWaits` and then halts, so the halt
 *     reason names the real blocker instead of a mystery stall.
 *   - The lever that removes the last obstacle is a `-sJSPI` php-wasm build, which
 *     is measured to work on deployed infrastructure for the slicing half but has no
 *     binary yet. With it, boot becomes sliceable and the free-plan cold path opens.
 *     Nothing in this file assumes it.
 *
 * **The resumability contract.**
 *
 * **Why two beats, and the thing that cannot be done at all.** A crash detector needs
 * a marker that survives the crash. DO SQLite commits its implicit transaction at the
 * END OF EACH EVENT -- measured here: a `BEGIN` in one `fetch()` was already committed
 * before the `ROLLBACK` arrived in the next. So a marker written in the same event
 * that enters PHP is worthless: it dies with the event it was meant to outlive. The
 * claim must therefore commit in its OWN event, before the run event starts. That is
 * the two-beat rhythm, and it is why the cost table above says 62 invocations.
 *
 * It is NOT sufficient, for a reason that is not obvious:
 * **whatever state the run beat READS is also the state a killed run beat LEAVES.**
 * Renaming it, pre-committing it, or moving the claim into the previous unit's commit
 * all preserve that symmetry exactly. Within a store whose only durability boundary
 * is "the event completed", a kill mid-event is undetectable from storage alone. The
 * detector has to come from outside the event.
 *
 * So the detector here is **a single-use in-memory token**. The claim beat commits
 * `attempts + 1` and then issues a token naming (run, seq, attempts). The run beat
 * consumes the token before entering PHP. A beat that finds the unit `claimed` with
 * no matching token knows a run was owed and cannot prove it did not happen, and
 * **halts**.
 *
 * That is fail-closed, and it has one false positive: if the object is
 * evicted between the claim beat and the run beat, the token goes with the
 * interpreter and a unit that never ran is reported unverifiable. The chain re-arms
 * at +1 ms specifically to make that window ~1 ms against a 6-10 s eviction timer,
 * and a false positive costs an operator one decision while the alternative costs a
 * half-applied schema. **The way to turn the false positive into a certainty is a
 * Tail Worker reading the `exceededCpu` / `exceededMemory` outcome for the killed
 * invocation** -- the only mechanism on this platform that observes a kill from
 * outside it. That is a named follow-up, not something this file pretends to have.
 *
 * **What is written, per beat.**
 *
 *   claim beat: `cfw_updb_unit.state = 'claimed'`, `attempts = attempts + 1`,
 *   `claimed_at`. Nothing else. No PHP is entered, so this beat cannot be killed by
 *   CPU.
 *
 *   run beat, on a completed unit: in ONE `transactionSync` -- `state = 'done'`,
 *   `finished`, `message`, `rows`, `statements`, `ended_at`; `cfw_updb_run.cursor_seq
 *   = seq + 1`, `abort_list`, accumulated meters, `updated_at`. The bookkeeping
 *   triple is atomic by construction rather than by trusting the event model.
 *
 *   run beat, on a partial unit (`finished < 1`): `state` goes back to `'pending'`,
 *   `passes = passes + 1`, `sandbox` updated, cursor unchanged. Back to `pending`,
 *   which is what keeps "state is `claimed` at claim time" an unambiguous crash
 *   signal.
 *
 * **What happens when the object is evicted between two update hooks.** Nothing is
 * lost and nothing is guessed. Every completed unit is `done` in durable SQL, the
 * cursor points at the next one, the site is still fenced because maintenance mode
 * is state in the database rather than memory, and the sandbox of a half-finished
 * hook is base64 `serialize()` in the unit row -- which is core's own contract, since
 * the batch API serializes the same array into the `batch` table between HTTP
 * requests. The next alarm re-boots the interpreter and resumes at the cursor. The
 * only thing eviction costs is the boot.
 *
 * **What happens when an invocation is KILLED mid-hook** (exceededCpu,
 * exceededMemory, isolate death). Its writes never commit, so the unit is still
 * `claimed` from the claim beat's commit -- and the token it would have consumed is
 * either consumed already or gone with the isolate. Either way the next beat finds
 * `claimed` with no valid token and **halts the run**: phase `halted`, reason
 * `unit-unverifiable`, maintenance mode left ON, cursor left pointing at the unit
 * that died. No retry, no advance, nothing silent.
 *
 * That default answers a question this platform cannot yet
 * answer: whether a killed event's partial writes are discarded. The commit
 * direction is measured; **the kill direction is NOT measured here and cannot be
 * without a deploy.** If it turns out writes are discarded, re-running a killed unit
 * is safe and `retryPolicy: "core"` becomes provably correct -- it already matches
 * core, whose batch API re-runs an operation from its last persisted sandbox after a
 * fatal. Until someone measures it, the default halts, because a fenced site with a
 * precise cursor is strictly better than a site that silently re-ran half of
 * `system_update_11201`.
 *
 * **Preconditions, checked in JS before PHP is entered at all.** This is what makes
 * a refusal cost ~0 ms instead of a 3,754 ms boot:
 *
 *   - the run's `code_id` still matches. On this platform the PHP tree is a
 *     versioned asset pack, so a deploy can swap the code under a live cursor --
 *     a hazard a traditional host running update.php in one process does not have.
 *   - maintenance mode is still ON, read straight out of `key_value` (collection
 *     `state`, name `system.maintenance_mode`). Exempt for the two `maint_*` units.
 *   - for an `update` unit with `expect_schema`, the module's installed version in
 *     `key_value` (collection `system.schema`) equals it exactly. A mismatch means a
 *     previous unit did not land, or something outside this run moved it.
 *   - for a `post_update` unit, the function name does NOT already appear in
 *     `key_value` (collection `post_update`, name `existing_updates`).
 *   - the unit at the cursor is in a state the beat expects. Anything else is
 *     `cursor-desync` and halts.
 *
 * Every one of those reads is 1-2 statements of plain SQL. Where a value cannot be
 * parsed the answer is `null` and the gate REFUSES -- unknown beats incorrect, which
 * is why the serialized-scalar reader below returns null rather than a guess.
 *
 * **Wiring** (src/site-do.js is not edited by this file):
 *
 *   import { updbStep, updbPrepare, updbStatus, updbAlarmDelayMs, updbOptions } from "./updb.js";
 *
 *   // in alarm(), alongside the existing fill batch
 *   const step = await updbStep(
 *     { sql: this.sql, runJson: (code) => this.runJson(code), phpReady: () => !!this.php,
 *       txn: (fn) => this.ctx.storage.transactionSync(fn), nowMs: () => this.nowMs() },
 *     updbOptions(this.env),
 *   );
 *   await this.ctx.storage.setAlarm(this.nowMs() + updbAlarmDelayMs(step, updbOptions(this.env)));
 *
 * The step function owns no transport, no alarm and no env of its own, exactly like
 * `cronStep()`, so the same chain runs off an alarm, off a WebSocket message, or off
 * one HTTP poke per beat in a test.
 */

import { UPDB_FLUSH_STEPS, UPDB_VERIFY, updbPlan, updbUnit } from '../drupal/updb-php';

export { UPDB_FLUSH_STEPS, UPDB_VERIFY };

/** The cursor `exec()` hands back, narrowed to what this file reads off one. */
export interface UpdbCursor {
	toArray(): Record<string, unknown>[];
	rowsWritten?: number;
	rowsRead?: number;
}

/** `ctx.storage.sql`, or the same exec()/cursor shape. `databaseSize` is recorded, never guessed. */
export interface UpdbSql {
	exec(text: string, ...params: unknown[]): UpdbCursor;
	databaseSize?: number;
}

/** One run-permission token: valid for exactly the run, seq and attempt that issued it. */
export interface UpdbToken {
	runId: string;
	seq: number;
	attempts: number;
	issuedAt: number;
}

/** The single-use token slot. In memory only; its disappearance IS the signal. */
export interface TokenHolder {
	get: () => UpdbToken | null;
	set: (t: UpdbToken) => void;
	clear: () => void;
}

/** What `serializedScalar()` decoded, or nothing. */
export interface SerializedScalar {
	kind: 'int' | 'bool' | 'string' | 'float' | 'null';
	value: unknown;
}

/** One unit as the plan builder emits it, before it becomes a `cfw_updb_unit` row. */
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

/** The `cfw_updb_run` row, decoded. */
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

/** The `cfw_updb_unit` row, decoded. */
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
 * A PHP fragment's JSON reply, or the snapshot report, as one beat produced it.
 *
 * `Record<string, any>` and not `unknown`, with the trade named: the shape
 * genuinely depends on which of eleven units ran, every read below is already guarded by a
 * `typeof` or `Array.isArray` test, and `unknown` would turn each of those twelve guarded reads
 * into a cast without making any of them safer.
 */
export type UpdbUnitResult = Record<string, any>;

/**
 * One beat's result. `ok` and `beat` are the only invariants -- everything else depends on
 * which branch ran, so the rest are optional rather than a union of thirteen literals. That
 * is the accurate contract: a caller has to check before reading, and declaring them optional
 * is what makes the check possible instead of forcing a cast.
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

/** The knobs `updbOptions()` reads from env; all arrive from wrangler as strings. */
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

/** Everything `updbPrepare()`, `updbStep()` and the two operator calls accept. */
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

/** The transport, clock and meters a beat runs on; it owns none of them. */
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

/** the bookkeeping this run may restore. NOT the content tables; see the docblock. */
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
 * Phases after which a NEW run may be prepared.
 *
 * `halted` is absent. A halted run means an invocation died somewhere
 * this design cannot reason about, and starting a second cursor over the same schema
 * is the exact failure the whole file exists to prevent. Clearing it is an operator
 * decision: `updbRollback()` to undo the bookkeeping, or `updbAbandon()` to accept the
 * state as-is and say so on the record.
 */
const RESTARTABLE_PHASES = ['complete', 'rolled_back', 'abandoned'];

/** a missing table is a real answer here, not an error to swallow */
const MISSING_TABLE = /no such table/i;

/**
 * The run-permission tokens, one holder per Durable Object instance.
 *
 * Keyed on the `sql` object because that IS the per-instance identity available
 * here: `ctx.storage.sql` is one object per DO instance, and one isolate can host
 * several instances of the same class. A module-level Map would let two objects
 * share a token; a WeakMap on `sql` cannot.
 *
 * In memory only. This is the only piece of state in the whole design that
 * must NOT be durable: its disappearance is the signal. A token that survived an
 * eviction would also survive the kill it exists to detect.
 *
 * `deps.tokens` overrides it, which is how the gate tests simulate an eviction --
 * clear the holder, and the next beat sees exactly what a resumed object sees.
 */
const TOKENS = new WeakMap<object, TokenHolder>();

function tokenHolder(deps: UpdbDeps): TokenHolder {
	if (deps.tokens && typeof deps.tokens.get === 'function') return deps.tokens;
	let holder = TOKENS.get(deps.sql);
	if (!holder) {
		let value: UpdbToken | null = null;
		holder = {
			get: () => value,
			set: (v: UpdbToken) => {
				value = v;
			},
			clear: () => {
				value = null;
			}
		};
		TOKENS.set(deps.sql, holder);
	}
	return holder;
}

/** a token is valid only for the exact run, seq and attempt that issued it */
function tokenMatches(token: UpdbToken | null | undefined, run: UpdbRun, unit: UpdbUnit): boolean {
	return (
		token !== null &&
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
		// the `byteLength` test above is the duck check; workerd hands back a real view
		return new TextDecoder().decode(value as ArrayBufferView);
	}
	return value === null || value === undefined ? '' : String(value);
}

/**
 * Parses a WHOLE PHP-serialized scalar, which is what a `key_value.value` holds.
 *
 * Not a general unserializer and not `serializedInt()`
 * from src/cron.js: that one finds a key INSIDE a serialized array (config blobs),
 * this one decodes the entire cell (`i:11201;`, `b:1;`, `s:3:"abc";`). Both exist
 * because Drupal stores config as an array and state as a bare scalar.
 *
 * Returns null for anything it does not recognise, including a serialized array or
 * object, so every caller's gate refuses rather than coercing. That is the rule this
 * project has paid for eight times: unknown beats incorrect.
 */
export function serializedScalar(blob: unknown): SerializedScalar | null {
	const text = asText(blob).trim();
	if (text.length === 0) return null;
	if (text === 'N;') return { kind: 'null', value: null };
	let m = /^i:(-?\d+);$/.exec(text);
	if (m) return { kind: 'int', value: Number(m[1]) };
	m = /^b:([01]);$/.exec(text);
	if (m) return { kind: 'bool', value: m[1] === '1' };
	m = /^d:(-?(?:\d+\.?\d*|INF|NAN));$/.exec(text);
	if (m) return { kind: 'float', value: Number(m[1]) };
	m = /^s:(\d+):"([\s\S]*)";$/.exec(text);
	if (m) {
		// the length prefix is BYTES; a mismatch means the cell is not what it claims
		const bytes = new TextEncoder().encode(m[2]).length;
		if (bytes !== Number(m[1])) return null;
		return { kind: 'string', value: m[2] };
	}
	return null;
}

/** the serialized form Drupal's state store expects for a boolean */
export function serializeBool(value: unknown): string {
	return value ? 'b:1;' : 'b:0;';
}

/**
 * The installed schema version for one module, straight out of `key_value`.
 *
 * `UpdateHookRegistry` reads exactly this row (`core.services.yml:1979` wires it to
 * `@keyvalue`, and `KeyValueFactory::get('system.schema')` resolves to
 * `DatabaseStorage` on the `key_value` table with `collection = 'system.schema'`).
 * Reading it in JS is what lets a precondition refuse without booting PHP.
 *
 * @returns null for absent, unparseable, or non-integer
 */
export function readSchemaVersion(sql: UpdbSql, module: unknown): number | null {
	try {
		const row = sql
			.exec(
				'SELECT value FROM key_value WHERE collection = ? AND name = ?',
				'system.schema',
				String(module)
			)
			.toArray()[0];
		if (row === undefined) return null;
		const parsed = serializedScalar(row.value);
		return parsed && parsed.kind === 'int' ? (parsed.value as number) : null;
	} catch {
		return null;
	}
}

/**
 * Maintenance mode, read the same way.
 *
 * `State::set()` writes through to `key_value` immediately (State.php:97-113 calls
 * `$this->keyValueStore->set()` before touching its cache), so this sees a value PHP
 * set in the previous beat without going near `cache_bootstrap`.
 *
 * @returns null when absent or unparseable, which the gate refuses
 */
export function readMaintenanceMode(sql: UpdbSql): boolean | null {
	try {
		const row = sql
			.exec(
				'SELECT value FROM key_value WHERE collection = ? AND name = ?',
				'state',
				'system.maintenance_mode'
			)
			.toArray()[0];
		if (row === undefined) return false;
		const parsed = serializedScalar(row.value);
		if (!parsed) return null;
		if (parsed.kind === 'bool') return parsed.value as boolean;
		if (parsed.kind === 'int') return parsed.value !== 0;
		if (parsed.kind === 'null') return false;
		return null;
	} catch {
		return null;
	}
}

/**
 * Whether a post-update function is already recorded as run.
 *
 * `UpdateRegistry::getPendingUpdateFunctions()` diffs the available functions
 * against `$this->keyValue->get('existing_updates', [])`, and that key value lives
 * in `key_value` under `collection = 'post_update'`. The blob is a serialized ARRAY,
 * so rather than unserialize it this looks for the exact element bytes
 * `s:<len>:"<fn>";`. The length prefix is what stops a shorter name matching inside
 * a longer one.
 *
 * @returns null when the blob is present but not a serialized array
 */
export function postUpdateRegistered(sql: UpdbSql, fn: unknown): boolean | null {
	const name = String(fn);
	// the byte length must equal the character length for the needle to be right
	if (new TextEncoder().encode(name).length !== name.length) return null;
	try {
		const row = sql
			.exec(
				'SELECT value FROM key_value WHERE collection = ? AND name = ?',
				'post_update',
				'existing_updates'
			)
			.toArray()[0];
		if (row === undefined) return false;
		const text = asText(row.value);
		if (!/^a:\d+:\{/.test(text)) return null;
		return text.includes(`s:${name.length}:"${name}";`);
	} catch (e: any) {
		if (MISSING_TABLE.test(String(e?.message ?? e))) return false;
		return null;
	}
}

/**
 * A deterministic content hash for a plan.
 *
 * FNV-1a, 32 bits, hex. `crypto.subtle` is async and this is called from
 * synchronous storage code, and the job is change DETECTION rather than a security
 * boundary -- stated so nobody later reads it as one.
 */
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
 * Turns what PHP enumerated into the ordered unit list.
 *
 * Kept in JS, and pure, so the ordering rules are gate-testable without an
 * interpreter. The order is `DbUpdateController::triggerBatch()`'s, not an
 * improvement on it:
 *
 *   1. every allowed `hook_update_N` in dependency order;
 *   2. **only if post-updates are pending**, a full cache flush, then each
 *      `hook_post_update_NAME` in the registry's own sorted order;
 *   3. a final full cache flush, unconditionally -- `batchFinished()` flushes even
 *      when there was nothing to do;
 *   4. `maint_off`.
 *
 * Each "full cache flush" expands to `UPDB_FLUSH_STEPS`, eleven bounded units, when
 * `flushSplit` is true (the default). With `flushSplit: false` it is one unit that
 * calls `drupal_flush_all_caches()` -- **which cannot fit a free-plan invocation,
 * measured at 282.9 ms in wasm**, so that setting requires `allowUnbounded` as well
 * and exists for paid plans only.
 *
 * @param plan the JSON `updbPlan()` printed
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
				'flushSplit: false calls drupal_flush_all_caches() in one unit, measured at 282.9 ms in wasm against a 10 ms free-plan invocation cap. Pass allowUnbounded: true to accept that this run needs a paid plan.'
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
 * The plan and the cursor, in the Durable Object's own SQL.
 *
 * NOT `ctx.storage.put()`, for the same reason `cfw_meta` is not: a cursor read has
 * to be possible from synchronous, PHP-facing code, and `put()` is async. And not a
 * single JSON blob either, because a unit carries a serialized sandbox that can be
 * large and must be updated without rewriting the whole plan.
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
		const v = JSON.parse(asText(text)) as T;
		return v === null || v === undefined ? fallback : v;
	} catch {
		return fallback;
	}
}

/** the live run, or null. Terminal runs are returned too; the caller decides. */
export function readRun(sql: UpdbSql): UpdbRun | null {
	ensureUpdbTables(sql);
	const row = sql
		.exec('SELECT * FROM cfw_updb_run ORDER BY started_at DESC, id DESC LIMIT 1')
		.toArray()[0];
	if (row === undefined) return null;
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

/** one unit, or null */
export function readUnit(sql: UpdbSql, runId: unknown, seq: unknown): UpdbUnit | null {
	const row = sql
		.exec(
			'SELECT * FROM cfw_updb_unit WHERE run_id = ? AND seq = ?',
			String(runId),
			Number(seq)
		)
		.toArray()[0];
	if (row === undefined) return null;
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
		u.fn === undefined || u.fn === null ? null : String(u.fn),
		u.module === undefined || u.module === null ? null : String(u.module),
		Number.isFinite(u.number) ? Number(u.number) : null,
		u.step === undefined || u.step === null ? null : String(u.step),
		JSON.stringify(Array.isArray(u.depMap) ? u.depMap : []),
		Number.isFinite(u.expectSchema) ? Number(u.expectSchema) : null,
		Number.isFinite(u.seedSchema) ? Number(u.seedSchema) : null,
		u.maintTarget === true ? 1 : 0
	);
}

function touchRun(sql: UpdbSql, runId: string, now: number): void {
	sql.exec('UPDATE cfw_updb_run SET updated_at = ? WHERE id = ?', Number(now), String(runId));
}

/** `databaseSize` if the binding exposes it, else null. Never guessed. */
function databaseSize(sql: UpdbSql): number | null {
	const n = Number(sql?.databaseSize);
	return Number.isFinite(n) ? n : null;
}

/**
 * Copies the bookkeeping tables, refusing rather than quietly spending the day.
 *
 * `CREATE TABLE ... AS SELECT` loses primary keys and indexes, which is fine because
 * a snapshot table is only ever read back with `SELECT *` and restored INTO the
 * original table, which keeps its own schema.
 *
 * The ceiling exists because rows written is the binding meter: at 100,000/day, a
 * 20,000-row snapshot is a fifth of a day and anything larger is not a backup
 * strategy, it is an outage. A table that is over the ceiling is NAMED in the
 * refusal.
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
			const c = Number(sql.exec(`SELECT COUNT(*) AS c FROM ${t}`).toArray()[0]?.c ?? 0);
			counts[t] = c;
			total += c;
		} catch (e: any) {
			if (MISSING_TABLE.test(String(e?.message ?? e))) {
				missing.push(t);
				continue;
			}
			return { ok: false, error: String(e?.message ?? e) };
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

/**
 * Puts the bookkeeping back.
 *
 * Wrapped in the caller's `transactionSync` when one is available, because a
 * half-restored `key_value` is worse than an unrestored one.
 */
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
			} catch (e: any) {
				if (MISSING_TABLE.test(String(e?.message ?? e))) {
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
	} catch (e: any) {
		return { ok: false, error: String(e?.message ?? e), restored, skipped };
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
 * Starts a run: the fence, the snapshot and the plan, as the first three units.
 *
 * Refuses when a run is already live, because two cursors over one schema is the
 * one failure this whole file exists to prevent.
 *
 * `maint_was` is read here, in JS, BEFORE any PHP runs -- so the value restored at
 * the end is the value that was true before the fence went up, and it is durable
 * rather than session state.
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
	if (maintWas === null) {
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
		databaseSize(sql),
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

	// seq 0 fences the site BEFORE seq 2 plans, because planning writes:
	// _update_fix_missing_schema() sets schema versions for any module missing one.
	insertUnit(sql, id, 0, { kind: 'maint_on', fn: 'maint_on' });
	insertUnit(sql, id, 1, { kind: 'snapshot', fn: 'snapshot' });
	insertUnit(sql, id, 2, { kind: 'plan', fn: 'plan' });

	return { ok: true, run: readRun(sql), units: 3 };
}

/**
 * The precondition gate. JS only, no interpreter, 1-3 statements.
 *
 * Every check here is one this project can afford to run before a boot, which is the
 * entire point: a refusal costs ~0 ms instead of 3,754 ms of cpuTime spent booting
 * to discover the run should not proceed.
 */
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

	// the code under the cursor may have been redeployed; the pack is versioned, so
	// this is a real hazard here and not one a single-process update.php has
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
		if (maint === null) {
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
		if (installed === null) {
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
		if (already === null) {
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

/** stops the run, loudly and durably. Maintenance mode stays ON. */
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
 * Undoes what the snapshot covers, and says what it does not.
 *
 * Only legal from `halted`. Leaves maintenance mode ON, because restoring the
 * bookkeeping puts the site back to "updates pending" against a tree that is now the
 * NEW code -- which is precisely the state the fence exists for. The operator either
 * redeploys the old pack or fixes the cause and starts a new run.
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
 * Accepts a halted run as-is, on the record, so a new run may be prepared.
 *
 * The counterpart to `updbRollback()`, and NOT automatic: it is the
 * operator saying "I have looked, and the schema is where I want it". It records the
 * reason so the next person can see that a decision was made rather than a state
 * being silently reused.
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
 * Does ONE beat and hands back whether the caller should re-arm.
 *
 * Two beats per unit -- `claim` then `run` -- and the docblock at the top of this
 * file explains why that is not one: a crash marker written in the same event that
 * enters PHP dies with the event it was supposed to outlive, because DO SQLite
 * commits its implicit transaction at the end of each event.
 *
 * `maxBeats` above 1 is a PAID-PLAN setting. On free it must stay 1, for two
 * reasons: nothing in this file bounds a single unit's CPU (there is no clock to
 * bound it with), and batching collapses the per-unit crash granularity that the
 * claim beat buys.
 *
 * The beat's own shape is `UpdbBeat`, declared at the top of this file.
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

	// ---------- the claim beat ----------
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
		// issued AFTER the write, so a claim beat that itself dies leaves no token to
		// authorise a run it never committed
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

	// ---------- a claim whose run beat cannot be accounted for ----------
	// Reaching here with no matching token means one of: the run beat already consumed
	// its token and was then killed (exceededCpu, exceededMemory, isolate death); or
	// the object was evicted between the two beats. Neither can be told apart from the
	// other, and neither can be told apart from "the hook ran halfway and its writes
	// may or may not have landed", so this fails closed.
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
		// retryPolicy "core": re-claim rather than run, so attempts keeps counting and
		// maxAttempts can still stop an unbounded retry loop
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
	// single use: consumed BEFORE the interpreter is entered, so a kill inside PHP
	// leaves no token behind even if the object survives
	tokens.clear();

	// ---------- the run beat ----------
	// re-check the two live preconditions: cheap, and it means a refusal is covered
	// whichever beat notices it
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
		// Boot is 3,754 ms of cpuTime on the edge in ONE synchronous stretch, 375x the
		// free cap, and no cursor splits it. Spending an invocation on a boot that will
		// be killed accomplishes nothing, so wait for traffic or the keep-warm alarm to
		// bring the interpreter back -- bounded, then halt naming the real blocker.
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
		// The token was consumed above, before this bail-out, so it has to be re-issued
		// or the NEXT beat would read "claimed with no token" and halt the run as
		// unverifiable -- turning a cold interpreter into a fake kill. Caught by the gate
		// test, which is exactly the sort of ordering bug a mock cannot find.
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
			// no `ok: true`: `snap.ok` is already true here -- the refusal returned above -- and the
			// spread would overwrite it anyway
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
			} catch (e: any) {
				const h = updbHalt(sql, run, 'plan-refused', String(e?.message ?? e), now);
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
	} catch (e: any) {
		thrown = String(e?.message ?? e);
	}

	const after = deps.meters ? deps.meters() : null;
	const rows = before && after ? Number(after.rowsWritten) - Number(before.rowsWritten) : 0;
	const statements = before && after ? Number(after.statements) - Number(before.statements) : 0;

	if (thrown !== null) {
		// A throw is loud and its writes have already happened, so halt in this same
		// event rather than leaving the next claim beat to infer it. A real KILL writes
		// nothing at all and is caught by the claim beat instead; both end halted.
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

	// an aborted unit: recorded, then halted by default. `onAbort: "continue"`
	// reproduces core, which runs the rest of the batch and lets update_do_one() skip
	// whatever depended on the failure.
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

	// a partial pass: the hook asked to be re-entered. Back to `pending` so that
	// "claimed at claim time" stays an unambiguous crash signal.
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

/**
 * Runs beats until the chain says stop.
 *
 * `maxBeats` defaults to 1 and must stay 1 on the free plan; see `updbStep()`.
 */
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
 * When the next alarm should fire.
 *
 * +1 ms while the chain has work, matching `cronAlarmDelayMs()` and the fill chain
 * in src/site-do.js: a fresh invocation is a fresh CPU budget, and re-arming
 * immediately also keeps the object resident, which is what stops a hibernation
 * discarding the interpreter between two update hooks.
 *
 * A cold beat waits longer -- there is nothing this chain can do to boot
 * an interpreter inside 10 ms, so it backs off and lets traffic or the keep-warm
 * alarm do it.
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
