import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { UPDB_VERIFY, updbPlan, updbUnit } from '../../../src/drupal/updb-php';
import {
	UPDB_FLUSH_STEPS,
	UPDB_SCHEMA_VERSION,
	UPDB_SNAPSHOT_TABLES,
	buildPlanUnits,
	dropSnapshot,
	ensureUpdbTables,
	planHash,
	postUpdateRegistered,
	readMaintenanceMode,
	readRun,
	readSchemaVersion,
	readUnit,
	restoreSnapshot,
	serializeBool,
	serializedScalar,
	snapshotTables,
	updbAbandon,
	updbAlarmDelayMs,
	updbDrain,
	updbHalt,
	updbOptions,
	updbPrepare,
	updbRollback,
	updbStatus,
	updbStep
} from '../../../src/ops/updb';

/**
 * Ported from `scripts/test-updb.mjs` (364 hand-rolled assertions), and as with
 * `cron-gc.spec.ts` the point of the port is the FIXTURE.
 *
 * The original drove a hand-written `fakeSql` over plain arrays: a tiny SQL engine that
 * pattern-matched every statement shape `src/ops/updb.js` emits and threw on anything else.
 * It was a good mock, and it was still a mock of the platform. This project has paid for that
 * exact bargain: the PHP driver's fixture ran on local PDO, whose bound-parameter limit is
 * 32,766 against the host's 100, so a whole class of "statement too wide" defect passed every
 * test and could only fail in production.
 *
 * Here every statement executes against the REAL `ctx.storage.sql` inside a real Durable
 * Object, the real `ctx.storage.transactionSync` wraps the atomic triples, `databaseSize` is
 * the engine's own, and `rowsWritten` is the host's meter rather than a factor invented by an
 * `indexFactor` option. A statement the host would refuse fails here.
 *
 * WHAT CHANGED, stated plainly, since nothing else was allowed to:
 *
 *   - `dbSizeBefore` asserts the engine's `databaseSize` rather than the fake's 6,475,776.
 *   - `JSON.stringify(sql.state.rows)` becomes `worldOf(sql)`, which dumps every row of every
 *     table out of the real database.
 *   - "a snapshot table exists" reads `sqlite_master` instead of a JS object key.
 *   - the abort list reaching later units was asserted against the fake's statement LOG; here
 *     it is asserted against the PHP payload the later unit is actually handed, which is what
 *     the log line stood in for.
 *   - the fake's "throws on a statement I was not taught" control is now the engine's own
 *     refusal; `the fixture can fail` keeps it as an explicit assertion.
 *
 * The four claims the design owes, and where each lives:
 *
 *   1. the cursor advances                          -> `the two-beat rhythm`
 *   2. a resumed slice does not repeat work         -> `a resumed slice`
 *   3. an interrupted slice leaves no partial state -> `the kill`
 *   4. the terminal state is idempotent            -> `terminal idempotence`
 *
 * The most valuable block is `the chain cannot half-apply silently`: for every way a unit can
 * fail it asserts the run ends in a phase that is durable, named, still fenced by maintenance
 * mode, and pointing at the unit that failed.
 */

// #region the real Durable Object, and a real Drupal-shaped schema

/**
 * The `ctx.storage.sql` surface `src/ops/updb.js` consumes.
 *
 * Written out rather than left loose because the module is untyped JS, so a value off it
 * infers as `{}`. `databaseSize` is here because `updbPrepare()` records it and refuses to
 * guess it.
 */
type Sql = {
	databaseSize: number;
	exec: (
		text: string,
		...params: unknown[]
	) => { toArray(): Record<string, unknown>[]; rowsWritten: number; rowsRead: number };
};

type Site = { sql: Sql; txn: (fn: () => void) => void };

/** the subset of Drupal's schema updb reads, gates on, and snapshots */
const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS key_value (
		collection VARCHAR(128) NOT NULL, name VARCHAR(128) NOT NULL, value BLOB NOT NULL,
		PRIMARY KEY (collection, name))`,
	`CREATE TABLE IF NOT EXISTS key_value_expire (
		collection VARCHAR(128) NOT NULL, name VARCHAR(128) NOT NULL, value BLOB NOT NULL,
		expire INTEGER NOT NULL DEFAULT 2147483647, PRIMARY KEY (collection, name))`,
	'CREATE INDEX IF NOT EXISTS key_value_expire_all ON key_value_expire (expire)',
	`CREATE TABLE IF NOT EXISTS config (
		collection VARCHAR(255) NOT NULL DEFAULT '', name VARCHAR(255) NOT NULL, data BLOB,
		PRIMARY KEY (collection, name))`,
	`CREATE TABLE IF NOT EXISTS cachetags (
		tag VARCHAR(255) NOT NULL PRIMARY KEY, invalidations INTEGER NOT NULL DEFAULT 0)`
];

const SITE_TABLES = ['key_value', 'key_value_expire', 'config', 'cachetags'];

/** the clock the original drove; every id and timestamp below derives from it */
const START_MS = 1_800_000_000_000;

/** runs `fn` with the real ctx.storage.sql and the real transactionSync of a real DO */
async function withSite<T>(fn: (site: Site) => T | Promise<T>): Promise<T> {
	const id = env.SITE.newUniqueId();
	const stub = env.SITE.get(id);
	// the callback's `instance` is typed as the DO class, which this spec does not import; the
	// only things needed off it are the sql handle and transactionSync
	return runInDurableObject(stub, async (instance) => {
		const ctx = (
			instance as unknown as {
				ctx: { storage: { sql: Sql; transactionSync: (fn: () => void) => void } };
			}
		).ctx;
		return fn({ sql: ctx.storage.sql, txn: (body) => ctx.storage.transactionSync(body) });
	});
}

/** a site with maintenance mode off, module `system` at schema 11100, no post-updates */
function seedSite(sql: Sql, opts: { configRows?: number } = {}) {
	for (const ddl of SCHEMA) sql.exec(ddl);
	for (const t of SITE_TABLES) sql.exec(`DELETE FROM ${t}`);
	kvSet(sql, 'state', 'system.maintenance_mode', 'b:0;');
	kvSet(sql, 'system.schema', 'system', 'i:11100;');
	kvSet(sql, 'post_update', 'existing_updates', 'a:0:{}');
	sql.exec("INSERT INTO config (collection, name, data) VALUES ('', 'system.site', 'a:0:{}')");
	sql.exec("INSERT INTO cachetags (tag, invalidations) VALUES ('rendered', 1)");
	if (opts.configRows) {
		// one statement rather than 25,000 execs: a recursive CTE is how the engine bulk-loads
		sql.exec(
			`INSERT INTO config (collection, name, data)
			 WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < ?)
			 SELECT '', 'c' || x, 'a:0:{}' FROM seq`,
			opts.configRows
		);
	}
	// created here rather than inside updbPrepare() so the databaseSize a test reads before
	// preparing is the same one prepare records
	ensureUpdbTables(sql);
}

function kvSet(sql: Sql, collection: string, name: string, value: string) {
	sql.exec(
		`INSERT INTO key_value (collection, name, value) VALUES (?, ?, ?)
		 ON CONFLICT (collection, name) DO UPDATE SET value = excluded.value`,
		collection,
		name,
		value
	);
}

function countOf(sql: Sql, table: string): number {
	return Number(sql.exec(`SELECT COUNT(*) AS c FROM ${table}`).toArray()[0]?.c ?? 0);
}

function tableNames(sql: Sql): string[] {
	return sql
		.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.toArray()
		.map((r) => String(r.name));
}

/** the whole database as a comparable string; the port of `JSON.stringify(sql.state.rows)` */
function worldOf(sql: Sql): string {
	const out: Record<string, string[]> = {};
	for (const t of tableNames(sql)) {
		if (!SITE_TABLES.includes(t) && !t.startsWith('cfw_updb_')) continue;
		out[t] = sql
			.exec(`SELECT * FROM ${t}`)
			.toArray()
			.map((r) => JSON.stringify(r))
			.sort();
	}
	return JSON.stringify(out);
}

function kvWorld(sql: Sql): string {
	return JSON.stringify(
		sql
			.exec('SELECT collection, name, value FROM key_value ORDER BY collection, name')
			.toArray()
	);
}

// #endregion

// #region the shapes the untyped modules hand back

type Run = {
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
	snapshot: { ok?: boolean } | null;
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
};

type Unit = {
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
};

/**
 * The local view of a beat.
 *
 * `ran` and `more` are OPTIONAL here, matching the `UpdbBeat` typedef that
 * `src/ops/updb.js` now declares: only `ok` and `beat` are invariants, and every other field
 * depends on which branch ran. Declaring them required was the less accurate of the two, and it
 * is what forced a cast at the `beat()` helper.
 */
type Beat = {
	ok: boolean;
	beat: string;
	ran?: boolean;
	more?: boolean;
	reason?: string | null;
	phase?: string;
	seq?: number;
	kind?: string;
	fn?: string | null;
	attempts?: number;
	passes?: number;
	finished?: number;
	partial?: boolean;
	cold?: boolean;
	coldWaits?: number;
	reclaimed?: boolean;
	detail?: string | null;
};

type Prep = { ok: boolean; reason?: string; detail?: string; units?: number; run: Run };

type PlanUnit = {
	kind: string;
	fn: string;
	module?: string;
	number?: number;
	step?: string;
	depMap?: string[];
	expectSchema?: number | null;
	seedSchema?: number | null;
	maintTarget?: boolean;
	unbounded?: boolean;
};

type Status = {
	run: Run | null;
	units: Record<string, unknown>[];
	byState?: Record<string, number>;
	at?: Record<string, unknown> | null;
	remaining?: number;
};

type Snap = {
	ok: boolean;
	error?: string;
	counts?: Record<string, number>;
	missing?: string[];
	total?: number;
	rowsWritten?: number;
};

type Restore = { ok: boolean; error?: string; restored: string[]; skipped: string[] };

type Rollback = {
	ok: boolean;
	reason?: string;
	covers?: string;
	doesNotCover?: string;
	maintenanceMode?: string;
};

type Abandon = { ok: boolean; reason?: string; was?: string | null };

type Token = { runId: string; seq: number; attempts: number; issuedAt: number };
type Holder = {
	get: () => Token | null;
	set: (t: Token) => void;
	clear: () => void;
	peek: () => Token | null;
};

type Meters = { rowsWritten: number; statements: number };
type Respond = (code: string, meters: Meters) => Promise<Record<string, unknown>>;

type Deps = {
	sql: Sql;
	tokens: Holder;
	runJson: (code: string) => Promise<Record<string, unknown>>;
	phpReady: () => boolean;
	txn: (fn: () => void) => void;
	nowMs: () => number;
	meters: () => Meters;
};

const runOf = (sql: Sql) => readRun(sql) as unknown as Run;
const unitOf = (sql: Sql, runId: string, seq: number) =>
	readUnit(sql, runId, seq) as unknown as Unit;
const statusOf = (sql: Sql) => updbStatus(sql) as unknown as Status;
const prepare = (deps: Deps, options: object = {}) => updbPrepare(deps, options) as unknown as Prep;
// no cast: src/ops/updb.js now declares an `UpdbBeat` @returns, so the real type flows through.
// The other helpers below still need one until their functions get the same treatment.
const beat = async (deps: Deps, options: object = {}) => updbStep(deps, options);

// #endregion

// #region the scripted PHP side

/** a token holder the spec owns, so an eviction is simulated by handing over a fresh one */
function holder(): Holder {
	let v: Token | null = null;
	return {
		get: () => v,
		set: (x) => {
			v = x;
		},
		clear: () => {
			v = null;
		},
		peek: () => v
	};
}

/** the plan PHP would print for one pending update and one pending post-update */
function samplePlan(over: Record<string, unknown> = {}) {
	return {
		ok: true,
		codeId: 'abc123',
		drupalVersion: '11.4.5',
		severity: 0,
		requirementErrors: {},
		requirementWarnings: {},
		warnings: {},
		disallowed: {},
		startingUpdates: { system: 11101 },
		updates: [
			{
				kind: 'update',
				fn: 'system_update_11101',
				module: 'system',
				number: 11101,
				depMap: [],
				seedSchema: 11100,
				expectSchema: null
			}
		],
		postUpdates: ['system_post_update_thing'],
		installedVersions: { system: 11100 },
		counts: { updates: 1, postUpdates: 1 },
		...over
	};
}

/**
 * Reads a field out of the emitted fragment's embedded payload.
 *
 * The payload is JSON.stringify()'d TWICE on the way in -- once to make the payload, once to
 * make it a PHP string literal -- so what lands in the source is `{\"kind\":\"maint_on\"}`.
 * Matching the unescaped form silently finds nothing, which showed up as every unit reporting
 * kind "" and the run halting with unit-error. Both forms are accepted.
 */
function payloadField(code: string, key: string, pattern: string): string | null {
	const m = new RegExp(`\\\\?"${key}\\\\?":${pattern}`).exec(code);
	return m ? (m[1] ?? null) : null;
}

const kindOf = (code: string) => payloadField(code, 'kind', '\\\\?"([a-z_]+)\\\\?"') ?? '';

/** the standard scripted PHP side: plan, then everything succeeds */
function happyRespond(planOver: Record<string, unknown> = {}): Respond {
	return async (code, meters) => {
		meters.statements += 3;
		if (code.includes('update_get_update_list()')) return samplePlan(planOver);
		const kind = kindOf(code);
		if (kind === 'maint_on')
			return { ok: true, kind, finished: 1, maintenanceMode: 1, wanted: 1 };
		if (kind === 'maint_off')
			return { ok: true, kind, finished: 1, maintenanceMode: 0, wanted: 0 };
		if (kind === 'update') {
			meters.rowsWritten += 4;
			return {
				ok: true,
				kind,
				finished: 1,
				abort: [],
				success: true,
				message: 'index added',
				installedBefore: 11100,
				installedAfter: 11101,
				sandbox: 'YTowOnt9'
			};
		}
		if (kind === 'post_update') {
			meters.rowsWritten += 2;
			return { ok: true, kind, finished: 1, abort: [], success: true, sandbox: 'YTowOnt9' };
		}
		if (kind === 'flush') {
			meters.rowsWritten += 1;
			return { ok: true, kind, finished: 1, flushed: ['x'] };
		}
		throw new Error(`the scripted PHP side has no case for kind ${JSON.stringify(kind)}`);
	};
}

/** PHP's side effects on key_value, applied by the spec so the JS gate sees them */
function applyEffect(sql: Sql, kind: string, extra: { number?: number; fn?: string | null }) {
	if (kind === 'maint_on') kvSet(sql, 'state', 'system.maintenance_mode', 'b:1;');
	if (kind === 'maint_off') kvSet(sql, 'state', 'system.maintenance_mode', 'b:0;');
	if (kind === 'update') kvSet(sql, 'system.schema', 'system', `i:${extra.number};`);
	if (kind === 'post_update') {
		const fn = String(extra.fn);
		kvSet(sql, 'post_update', 'existing_updates', `a:1:{i:0;s:${fn.length}:"${fn}";}`);
	}
}

type Hook = (arg: {
	code: string;
	meters: Meters;
	kind: string;
	fn: string | null;
	number: number;
}) => Promise<Record<string, unknown> | undefined>;

/**
 * The realistic driver: it also applies the side effects PHP would have.
 *
 * Those mutations matter. Without them the JS precondition gate would correctly refuse at the
 * first unit, so a harness that skipped them would be testing nothing.
 */
function effectfulRespond(
	sql: Sql,
	planOver: Record<string, unknown> = {},
	hooks: Record<string, Hook> = {}
): Respond {
	const base = happyRespond(planOver);
	return async (code, meters) => {
		if (code.includes('update_get_update_list()')) return base(code, meters);
		const kind = kindOf(code);
		const fn = payloadField(code, 'fn', '\\\\?"([A-Za-z0-9_]*)\\\\?"');
		const number = Number(payloadField(code, 'number', '(\\d+)') ?? 0);
		const hook = hooks[kind];
		if (hook) {
			const custom = await hook({ code, meters, kind, fn, number });
			if (custom !== undefined) return custom;
		}
		const r = await base(code, meters);
		applyEffect(sql, kind, { number, fn });
		return r;
	};
}

function driver(
	site: Site,
	respond: Respond,
	opts: { tokens?: Holder; phpReady?: () => boolean; txn?: (fn: () => void) => void } = {}
) {
	const tokens = opts.tokens ?? holder();
	let clock = START_MS;
	const meters: Meters = { rowsWritten: 0, statements: 0 };
	const deps: Deps = {
		sql: site.sql,
		tokens,
		runJson: (code) => respond(code, meters),
		phpReady: opts.phpReady ?? (() => true),
		txn: opts.txn ?? site.txn,
		nowMs: () => (clock += 1),
		meters: () => ({ ...meters })
	};
	return { deps, tokens, meters };
}

/** runs beats to a stop, the way an alarm chain would */
async function chainTo(deps: Deps, limit = 200): Promise<Beat[]> {
	const beats: Beat[] = [];
	for (let i = 0; i < limit; i++) {
		const step = await beat(deps);
		beats.push(step);
		if (!step.more) break;
	}
	return beats;
}

// #endregion

describe('serializedScalar: unknown must beat incorrect', () => {
	it.each([
		['an int cell', 'i:11201;', 11201],
		['a negative int, sign kept', 'i:-1;', -1],
		['b:1; is true', 'b:1;', true],
		['b:0; is false', 'b:0;', false],
		['a string cell', 's:3:"abc";', 'abc'],
		['a float cell', 'd:1.5;', 1.5]
	])('parses %s', (_label, blob, want) => {
		expect(serializedScalar(blob)?.value).toBe(want);
	});

	it('reports N; as the null kind rather than as absent', () => {
		expect(serializedScalar('N;')?.kind).toBe('null');
	});

	it.each([
		['a serialized ARRAY, rather than half-reading it', 'a:1:{s:1:"a";i:1;}'],
		['an object', 'O:8:"stdClass":0:{}'],
		['a bare integer with no envelope', '11201'],
		['an empty cell', ''],
		['a truncated int', 'i:11201'],
		['a string whose byte length disagrees with its prefix', 's:2:"abc";']
	])('refuses %s', (_label, blob) => {
		expect(serializedScalar(blob)).toBeNull();
	});

	// the prefix is BYTES, so a two-byte one-character string is correct, not corrupt.
	// the escape rather than the literal character, to keep this file ASCII
	it('measures a multibyte string in bytes, not characters', () => {
		expect(serializedScalar('s:2:"\u00e9";')?.value).toBe('\u00e9');
	});

	it('decodes an ArrayBuffer cell, which is what a real BLOB comes back as', () => {
		expect(serializedScalar(new TextEncoder().encode('i:7;').buffer)?.value).toBe(7);
	});

	it.each([
		['true', true],
		['false', false]
	])('serializeBool round-trips %s', (_label, value) => {
		expect(serializedScalar(serializeBool(value))?.value).toBe(value);
	});
});

describe('the JS-only precondition reads, against the real engine', () => {
	it('reads a schema version out of key_value, and null for an absent module', async () => {
		const [system, missing] = await withSite(({ sql }) => {
			seedSite(sql);
			return [readSchemaVersion(sql, 'system'), readSchemaVersion(sql, 'nope')];
		});
		expect(system).toBe(11100);
		// an absent module is null, NOT 0: 0 is a real schema version
		expect(missing).toBeNull();
	});

	it('reads maintenance mode off a seeded site', async () => {
		expect(await withSite(({ sql }) => (seedSite(sql), readMaintenanceMode(sql)))).toBe(false);
	});

	it('says a post-update absent from existing_updates has not run', async () => {
		const got = await withSite(({ sql }) => {
			seedSite(sql);
			return postUpdateRegistered(sql, 'system_post_update_thing');
		});
		expect(got).toBe(false);
	});

	it('matches on the exact serialized element, prefix included', async () => {
		const out = await withSite(({ sql }) => {
			seedSite(sql);
			const at = (blob: string, fn: string) => {
				kvSet(sql, 'post_update', 'existing_updates', blob);
				return postUpdateRegistered(sql, fn);
			};
			return {
				// s:25 in front of a 24-byte name is not this function
				badPrefix: at(
					'a:1:{i:0;s:25:"system_post_update_thing";}',
					'system_post_update_thing'
				),
				exact: at('a:1:{i:0;s:24:"system_post_update_thing";}', 'system_post_update_thing'),
				shorter: at(
					'a:1:{i:0;s:24:"system_post_update_thing";}',
					'system_post_update_thin'
				),
				notAnArray: at('i:1;', 'system_post_update_thing')
			};
		});
		expect(out.badPrefix).toBe(false);
		expect(out.exact).toBe(true);
		expect(out.shorter).toBe(false);
		// a non-array registry blob is null so the gate refuses instead of guessing
		expect(out.notAnArray).toBeNull();
	});

	// CONTROL: a substring search without the length prefix WOULD match the shorter name, so
	// the prefix assertions above are not vacuous
	it('control: a naive substring test does match the shorter name', () => {
		expect(
			'a:1:{i:0;s:24:"system_post_update_thing";}'.includes('system_post_update_thin')
		).toBe(true);
	});

	it('reads maintenance as null when there is no key_value table at all', async () => {
		// an unmigrated site has no key_value; reading that as "off" would let the gate think
		// the fence was down and refuse for the wrong reason
		const got = await withSite(({ sql }) => readMaintenanceMode(sql));
		expect(got).toBeNull();
	});

	it("reads an absent ROW as off, which is Drupal's own default", async () => {
		const got = await withSite(({ sql }) => {
			for (const ddl of SCHEMA) sql.exec(ddl);
			return readMaintenanceMode(sql);
		});
		expect(got).toBe(false);
	});
});

describe("buildPlanUnits: core's order, expressed as data", () => {
	const units = buildPlanUnits(samplePlan()) as unknown as PlanUnit[];
	const kinds = units.map((u) => u.kind);

	it('leads with the update', () => {
		expect(kinds[0]).toBe('update');
	});

	it('then eleven flush steps before the post-updates', () => {
		expect(kinds.slice(1, 12).join(',')).toBe(UPDB_FLUSH_STEPS.map(() => 'flush').join(','));
	});

	it('then the post-update, then eleven more flush steps', () => {
		expect(kinds[12]).toBe('post_update');
		expect(kinds.slice(13, 24).every((k) => k === 'flush')).toBe(true);
	});

	it('ends at maint_off, 25 units in all', () => {
		expect(kinds[kinds.length - 1]).toBe('maint_off');
		// 1 update + 11 flush + 1 post + 11 flush + maint_off
		expect(units).toHaveLength(25);
	});

	it("keeps core's flush order unchanged", () => {
		expect(
			units
				.slice(1, 12)
				.map((u) => u.step)
				.join(',')
		).toBe(UPDB_FLUSH_STEPS.join(','));
	});

	it('puts router last and purge_tags before bins, as core requires', () => {
		expect(UPDB_FLUSH_STEPS[10]).toBe('router');
		expect(UPDB_FLUSH_STEPS.indexOf('purge_tags') < UPDB_FLUSH_STEPS.indexOf('bins')).toBe(
			true
		);
	});

	it('emits one flush block when nothing is pending after the updates', () => {
		const noPost = buildPlanUnits(samplePlan({ postUpdates: [] })) as unknown as PlanUnit[];
		expect(noPost.filter((u) => u.kind === 'flush')).toHaveLength(11);
		// but the final flush still happens, exactly as batchFinished() does
		expect(noPost.filter((u) => u.kind === 'flush').length > 0).toBe(true);
	});

	it('still flushes and unfences on an empty plan', () => {
		const empty = buildPlanUnits({ updates: [], postUpdates: [] }) as unknown as PlanUnit[];
		expect(empty).toHaveLength(12);
		expect(empty[empty.length - 1]?.kind).toBe('maint_off');
	});

	// the unbounded refusal is the constraint that governs the whole design
	it('refuses flushSplit: false without allowUnbounded, quoting the measured cost', () => {
		expect(() => buildPlanUnits(samplePlan(), { flushSplit: false })).toThrow(/282\.9 ms/);
	});

	it('collapses to one flush unit per block once unbounded is accepted', () => {
		const unbounded = buildPlanUnits(samplePlan(), {
			flushSplit: false,
			allowUnbounded: true
		}) as unknown as PlanUnit[];
		expect(unbounded.filter((u) => u.kind === 'flush')).toHaveLength(2);
		expect(unbounded.find((u) => u.kind === 'flush')?.unbounded).toBe(true);
	});

	// maintTarget carries the PRE-RUN value rather than a hardcoded false
	it.each([
		['restores the pre-run value when it was already on', true],
		['clears it when it was off', false]
	])('maint_off %s', (_label, maintTarget) => {
		const built = buildPlanUnits(samplePlan(), { maintTarget }) as unknown as PlanUnit[];
		expect(built[built.length - 1]?.maintTarget).toBe(maintTarget);
	});

	const multi = buildPlanUnits(
		samplePlan({
			updates: [
				{
					fn: 'system_update_11101',
					module: 'system',
					number: 11101,
					depMap: [],
					seedSchema: 11100,
					expectSchema: null
				},
				{
					fn: 'system_update_11201',
					module: 'system',
					number: 11201,
					depMap: [],
					seedSchema: null,
					expectSchema: 11101
				}
			]
		})
	) as unknown as PlanUnit[];

	// core sets number-1 for the first update of a module only
	it('seeds the first update of a module and only that one', () => {
		expect(multi[0]?.seedSchema).toBe(11100);
		expect(multi[1]?.seedSchema).toBeNull();
	});

	it("makes the second update expect the first's number, not number-1", () => {
		expect(multi[1]?.expectSchema).toBe(11101);
	});

	it('hashes a plan stably, and differently when the plan differs', () => {
		expect(planHash(units)).toBe(planHash(buildPlanUnits(samplePlan())));
		expect(planHash(units) === planHash(multi)).toBe(false);
	});
});

describe('updbPrepare: the fence goes up before the plan, because planning writes', () => {
	it('records the pre-run state and inserts the three preamble units', async () => {
		const out = await withSite((site) => {
			seedSite(site.sql);
			const sizeBefore = site.sql.databaseSize;
			const d = driver(site, happyRespond());
			const prep = prepare(d.deps);
			return {
				prep,
				sizeBefore,
				u0: unitOf(site.sql, prep.run.id, 0).kind,
				u1: unitOf(site.sql, prep.run.id, 1).kind,
				u2: unitOf(site.sql, prep.run.id, 2).kind
			};
		});
		expect(out.prep.ok).toBe(true);
		expect(out.prep.run.maintWas).toBe(false);
		expect(out.prep.run.phase).toBe('planning');
		expect(out.prep.units).toBe(3);
		expect(out.u0).toBe('maint_on');
		// the snapshot is BEFORE the plan, because _update_fix_missing_schema() writes
		expect(out.u1).toBe('snapshot');
		expect(out.u2).toBe('plan');
		// the engine's own databaseSize, not a number the fixture invented
		expect(out.prep.run.dbSizeBefore).toBe(out.sizeBefore);
		expect(out.prep.run.schemaVersion).toBe(UPDB_SCHEMA_VERSION);
	});

	it('refuses a second prepare while one is live, and names why', async () => {
		const second = await withSite((site) => {
			seedSite(site.sql);
			const d = driver(site, happyRespond());
			prepare(d.deps);
			return prepare(d.deps);
		});
		expect(second.ok).toBe(false);
		expect(second.reason).toBe('run-already-live');
	});

	it('honours requireExport, and accepts it once a key is given', async () => {
		const out = await withSite((site) => {
			seedSite(site.sql);
			const d = driver(site, happyRespond());
			const refused = prepare(d.deps, { requireExport: true });
			const accepted = prepare(d.deps, {
				requireExport: true,
				exportKey: 'r2://backup/x.sql'
			});
			return { refused, accepted };
		});
		expect(out.refused.ok).toBe(false);
		expect(out.refused.reason).toBe('export-required');
		expect(out.accepted.ok).toBe(true);
	});

	it('refuses the whole run when the maintenance value does not parse', async () => {
		const bad = await withSite((site) => {
			seedSite(site.sql);
			// an array where a scalar belongs: the value to restore at the end is unknown
			kvSet(site.sql, 'state', 'system.maintenance_mode', 'a:0:{}');
			return prepare(driver(site, happyRespond()).deps);
		});
		expect(bad.ok).toBe(false);
		expect(bad.reason).toBe('maintenance-unreadable');
	});
});

describe('the two-beat rhythm, and the cursor advancing', () => {
	it('claims in one beat and runs in the next, then advances', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const respond = effectfulRespond(sql);
			const d = driver(site, respond);
			const prep = prepare(d.deps);
			const runId = prep.run.id;

			const b1 = await beat(d.deps);
			const afterClaim = {
				state: unitOf(sql, runId, 0).state,
				attempts: unitOf(sql, runId, 0).attempts,
				cursor: runOf(sql).cursorSeq,
				token: d.tokens.peek()
			};
			const b2 = await beat(d.deps);
			const afterRun = {
				state: unitOf(sql, runId, 0).state,
				cursor: runOf(sql).cursorSeq,
				token: d.tokens.peek(),
				maint: readMaintenanceMode(sql)
			};

			const rest = await chainTo(d.deps);
			const run = runOf(sql);
			const status = statusOf(sql);
			return {
				b1,
				b2,
				afterClaim,
				afterRun,
				run,
				status,
				beats: 2 + rest.length,
				maintAtEnd: readMaintenanceMode(sql)
			};
		});

		expect(out.b1.beat).toBe('claim');
		expect(out.b1.ran).toBe(false);
		expect(out.b1.seq).toBe(0);
		expect(out.afterClaim.state).toBe('claimed');
		expect(out.afterClaim.attempts).toBe(1);
		// the claim beat commits the claim and NOTHING else
		expect(out.afterClaim.cursor).toBe(0);
		expect(out.afterClaim.token).not.toBeNull();

		expect(out.b2.beat).toBe('run');
		expect(out.b2.ran).toBe(true);
		expect(out.afterRun.state).toBe('done');
		expect(out.afterRun.cursor).toBe(1);
		// single use: consumed before the interpreter was entered
		expect(out.afterRun.token).toBeNull();
		expect(out.afterRun.maint).toBe(true);

		expect(out.run.phase).toBe('complete');
		expect(out.run.cursorSeq).toBe(out.run.maxSeq + 1);
		// 3 preamble units plus the 25 the plan appended
		expect(out.run.maxSeq + 1).toBe(28);
		expect(out.status.byState?.done).toBe(28);
		expect(out.status.byState?.claimed).toBeUndefined();
		expect(out.maintAtEnd).toBe(false);
		expect(typeof out.run.planHash).toBe('string');
		expect(out.run.codeId).toBe('abc123');
		// the two-beat cost, which is what the design pays for its guarantee: no wasted
		// terminal beat either
		expect(out.beats).toBe(28 * 2);
	});
});

describe('a resumed slice does not repeat work', () => {
	it('picks up at the cursor and commits exactly one pass per unit', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const respond = effectfulRespond(sql);
			const d = driver(site, respond);
			prepare(d.deps);

			// fence, snapshot and plan, then stop mid-chain
			for (let i = 0; i < 6; i++) await beat(d.deps);
			const mid = runOf(sql);
			const doneBefore = statusOf(sql).byState?.done;
			const kvBefore = kvWorld(sql);

			// EVICTION: a fresh instance, so a fresh token holder and no interpreter. Everything
			// else is exactly the durable state the object comes back to.
			const d2 = driver(site, respond, { tokens: holder() });
			const resumed = await beat(d2.deps);
			const afterClaim = {
				done: statusOf(sql).byState?.done,
				kv: kvWorld(sql)
			};

			await chainTo(d2.deps);
			const units = statusOf(sql).units;
			return {
				mid,
				resumed,
				doneBefore,
				kvBefore,
				afterClaim,
				phase: runOf(sql).phase,
				passes: units.filter((u) => Number(u.passes) !== 1),
				attempts: units.filter((u) => Number(u.attempts) !== 1)
			};
		});

		expect(out.mid.cursorSeq).toBeGreaterThanOrEqual(3);
		expect(out.resumed.beat).toBe('claim');
		// the unit the cursor points at, not the one that already ran
		expect(out.resumed.seq).toBe(out.mid.cursorSeq);
		expect(out.afterClaim.done).toBe(out.doneBefore);
		// and the claim beat wrote nothing to Drupal's own tables
		expect(out.afterClaim.kv).toBe(out.kvBefore);

		expect(out.phase).toBe('complete');
		expect(out.passes).toEqual([]);
		expect(out.attempts).toEqual([]);
	});
});

describe('eviction between two units is free', () => {
	// the distinction that matters: an eviction observed at a CLAIM boundary is a no-op,
	// because nothing was owed. The same eviction with a claim outstanding is `the kill`.
	it('resumes cleanly with the cursor untouched and no halt', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const respond = effectfulRespond(sql);
			const d = driver(site, respond);
			prepare(d.deps);
			await beat(d.deps); // claim 0
			await beat(d.deps); // run 0
			const cursor = runOf(sql).cursorSeq;

			const fresh = driver(site, respond, { tokens: holder() });
			const step = await beat(fresh.deps);
			return { step, cursor, run: runOf(sql) };
		});
		expect(out.step.beat).toBe('claim');
		expect(out.run.phase === 'halted').toBe(false);
		expect(out.run.cursorSeq).toBe(out.cursor);
	});
});

describe('the kill: an interrupted slice leaves no partial state', () => {
	it('halts, names the reason, and moves nothing', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const respond = effectfulRespond(sql);
			const d = driver(site, respond);
			const runId = prepare(d.deps).run.id;

			await beat(d.deps); // claim 0
			const claimed = unitOf(sql, runId, 0).state;

			// THE KILL. An invocation terminated by exceededCpu commits nothing and takes the
			// isolate's memory with it. Modelled exactly: the token holder is replaced, and no
			// unit write happened.
			const killed = driver(site, respond, { tokens: holder() });
			const after = await beat(killed.deps);
			const run = runOf(sql);
			const unit = unitOf(sql, runId, 0);
			const maint = readMaintenanceMode(sql);

			// and the halt is sticky: further beats do nothing at all
			const before = worldOf(sql);
			const again = await beat(killed.deps);
			return { claimed, after, run, unit, maint, again, before, world: worldOf(sql) };
		});

		expect(out.claimed).toBe('claimed');
		expect(out.after.ran).toBe(false);
		expect(out.run.phase).toBe('halted');
		expect(out.run.haltReason).toBe('unit-unverifiable');
		// the reason has to explain why storage alone cannot tell the two apart
		expect(String(out.run.haltDetail)).toContain('indistinguishable from storage alone');
		expect(out.run.cursorSeq).toBe(0);
		expect(out.unit.state).toBe('claimed');
		expect(out.unit.passes).toBe(0);
		// the unit that died IS maint_on, so the fence never went up; the site is untouched
		expect(out.maint).toBe(false);

		expect(out.again.ran).toBe(false);
		expect(out.again.reason).toBe('unit-unverifiable');
		expect(out.world).toBe(out.before);
	});

	it('leaves the site fenced when the kill lands mid-chain', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const respond = effectfulRespond(sql);
			const d = driver(site, respond);
			prepare(d.deps);
			// fence, snapshot, plan, then claim the first real update
			for (let i = 0; i < 7; i++) await beat(d.deps);
			const midMaint = readMaintenanceMode(sql);
			const cursor = runOf(sql).cursorSeq;

			const killed = driver(site, respond, { tokens: holder() });
			// make sure there is a claim outstanding
			let guard = 0;
			while (
				unitOf(sql, runOf(sql).id, runOf(sql).cursorSeq).state !== 'claimed' &&
				guard++ < 4
			) {
				await beat(d.deps);
			}
			const step = await beat(killed.deps);
			return { midMaint, cursor, step, run: runOf(sql), maint: readMaintenanceMode(sql) };
		});
		expect(out.midMaint).toBe(true);
		expect(out.run.phase).toBe('halted');
		// no request observes the intermediate schema
		expect(out.maint).toBe(true);
		expect(out.run.cursorSeq).toBe(out.cursor);
		expect(out.step.more).toBe(false);
	});
});

describe('retryPolicy "core" re-claims instead of halting, and still has a ceiling', () => {
	it('bumps attempts once, then stops at maxAttempts', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const respond = effectfulRespond(sql);
			const d = driver(site, respond);
			const runId = prepare(d.deps, { retryPolicy: 'core', maxAttempts: 2 }).run.id;
			await beat(d.deps); // claim, attempts 1

			const evicted = driver(site, respond, { tokens: holder() });
			const r1 = await beat(evicted.deps);
			const firstRetry = {
				attempts: unitOf(sql, runId, 0).attempts,
				halted: runOf(sql).phase === 'halted'
			};

			const evicted2 = driver(site, respond, { tokens: holder() });
			const r2 = await beat(evicted2.deps);
			return { r1, firstRetry, r2, run: runOf(sql) };
		});
		expect(out.r1.reclaimed).toBe(true);
		expect(out.firstRetry.attempts).toBe(2);
		expect(out.firstRetry.halted).toBe(false);
		expect(out.run.phase).toBe('halted');
		expect(out.run.haltReason).toBe('max-attempts');
		// so retrying cannot loop forever
		expect(out.r2.more).toBe(false);
	});
});

describe('a unit that reports finished < 1 is re-entered with its sandbox', () => {
	it('keeps the cursor still, stores the sandbox, and hands it back', async () => {
		const seen: (string | null)[] = [];
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			let updateCalls = 0;
			const respond = effectfulRespond(
				sql,
				{},
				{
					update: async ({ code }) => {
						updateCalls++;
						seen.push(payloadField(code, 'sandbox', '\\\\?"([A-Za-z0-9+/=]*)\\\\?"'));
						if (updateCalls === 1) {
							return {
								ok: true,
								kind: 'update',
								finished: 0.5,
								abort: [],
								sandbox: 'cGFzczE='
							};
						}
						return {
							ok: true,
							kind: 'update',
							finished: 1,
							abort: [],
							sandbox: 'cGFzczI=',
							installedAfter: 11101
						};
					}
				}
			);
			const d = driver(site, respond);
			const runId = prepare(d.deps).run.id;

			// reach the update unit: 3 preamble units at 2 beats each
			for (let i = 0; i < 6; i++) await beat(d.deps);
			const updateSeq = runOf(sql).cursorSeq;
			const atUpdate = unitOf(sql, runId, updateSeq).kind;

			await beat(d.deps); // claim
			const partial = await beat(d.deps); // run, pass 1
			const afterPartial = unitOf(sql, runId, updateSeq);
			const cursorAfterPartial = runOf(sql).cursorSeq;

			// the partial unit survives an eviction between passes, which is what `pending`
			// rather than `claimed` buys
			const resumed = driver(site, respond, { tokens: holder() });
			const reclaim = await beat(resumed.deps);
			const done = await beat(resumed.deps); // run, pass 2
			return {
				atUpdate,
				updateSeq,
				partial,
				afterPartial,
				cursorAfterPartial,
				reclaim,
				resumedHalted: runOf(sql).phase === 'halted',
				done,
				finalUnit: unitOf(sql, runId, updateSeq),
				finalCursor: runOf(sql).cursorSeq,
				updateCalls
			};
		});

		expect(out.atUpdate).toBe('update');
		expect(out.partial.partial).toBe(true);
		expect(out.partial.more).toBe(true);
		expect(out.cursorAfterPartial).toBe(out.updateSeq);
		// back to pending, not claimed, so "claimed at claim time" stays a crash signal
		expect(out.afterPartial.state).toBe('pending');
		expect(out.afterPartial.passes).toBe(1);
		expect(out.afterPartial.sandbox).toBe('cGFzczE=');

		expect(out.reclaim.beat).toBe('claim');
		expect(out.resumedHalted).toBe(false);
		expect(out.finalUnit.attempts).toBe(2);
		expect(out.done.finished).toBe(1);
		expect(out.finalUnit.state).toBe('done');
		expect(out.finalCursor).toBe(out.updateSeq + 1);
		expect(out.finalUnit.passes).toBe(2);
		expect(out.updateCalls).toBe(2);

		expect(seen[0]).toBeNull();
		// pass 2 is handed the stored sandbox back
		expect(seen[1]).toBe('cGFzczE=');
	});
});

describe('a partial pass that never finishes is stopped by maxPasses', () => {
	it('halts rather than chaining forever', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const respond = effectfulRespond(
				sql,
				{},
				{
					update: async () => ({
						ok: true,
						kind: 'update',
						finished: 0.1,
						abort: [],
						sandbox: 'eA=='
					})
				}
			);
			const d = driver(site, respond);
			prepare(d.deps, { maxPasses: 3 });
			const beats = await chainTo(d.deps, 60);
			return { run: runOf(sql), last: beats[beats.length - 1] };
		});
		expect(out.run.phase).toBe('halted');
		expect(out.run.haltReason).toBe('max-passes');
		expect(out.last?.more).toBe(false);
	});
});

describe('preconditions refuse before PHP is entered', () => {
	it('halts on a schema mismatch, naming both versions, at zero further PHP cost', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			let phpCalls = 0;
			const respond = effectfulRespond(sql, {
				updates: [
					{
						fn: 'system_update_11201',
						module: 'system',
						number: 11201,
						depMap: [],
						seedSchema: null,
						expectSchema: 11101
					}
				],
				postUpdates: []
			});
			const counted: Respond = async (code, meters) => {
				phpCalls++;
				return respond(code, meters);
			};
			const d = driver(site, counted);
			prepare(d.deps);
			await chainTo(d.deps, 40);
			const before = phpCalls;
			await beat(d.deps);
			return { run: runOf(sql), before, after: phpCalls };
		});
		expect(out.run.phase).toBe('halted');
		expect(out.run.haltReason).toBe('schema-mismatch');
		expect(String(out.run.haltDetail)).toContain('11100');
		expect(String(out.run.haltDetail)).toContain('11101');
		expect(out.after).toBe(out.before);
	});

	it('refuses to continue unfenced when something outside the run lowers the fence', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const d = driver(site, effectfulRespond(sql));
			prepare(d.deps);
			for (let i = 0; i < 6; i++) await beat(d.deps);
			kvSet(sql, 'state', 'system.maintenance_mode', 'b:0;');
			const step = await beat(d.deps);
			return { run: runOf(sql), step };
		});
		expect(out.run.phase).toBe('halted');
		expect(out.run.haltReason).toBe('maintenance-off');
		expect(out.step.more).toBe(false);
	});

	it('halts rather than running a post-update that is already recorded', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const respond = effectfulRespond(sql, { updates: [] });
			const d = driver(site, respond);
			prepare(d.deps);
			for (let i = 0; i < 6; i++) await beat(d.deps);
			const fn = 'system_post_update_thing';
			kvSet(sql, 'post_update', 'existing_updates', `a:1:{i:0;s:${fn.length}:"${fn}";}`);
			await chainTo(d.deps, 60);
			return runOf(sql);
		});
		expect(out.phase).toBe('halted');
		expect(out.haltReason).toBe('post-update-already-run');
	});

	it('halts when the code under the cursor was redeployed', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const d = driver(site, effectfulRespond(sql));
			prepare(d.deps);
			for (let i = 0; i < 6; i++) await beat(d.deps);
			// a hazard a single-process update.php cannot suffer
			const step = await beat(d.deps, { codeId: 'different' });
			return { run: runOf(sql), step };
		});
		expect(out.run.phase).toBe('halted');
		expect(out.run.haltReason).toBe('code-changed');
		expect(out.step.more).toBe(false);
	});

	it("carries PHP's own refusal as the halt reason", async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const respond = effectfulRespond(
				sql,
				{},
				{
					update: async () => ({
						ok: false,
						kind: 'update',
						refused: 'missing-function',
						error: 'system_update_11101 is not defined'
					})
				}
			);
			const d = driver(site, respond);
			prepare(d.deps);
			await chainTo(d.deps, 40);
			return { run: runOf(sql), at: statusOf(sql).at };
		});
		expect(out.run.phase).toBe('halted');
		expect(out.run.haltReason).toBe('missing-function');
		expect(String(out.at?.state)).toBe('claimed');
	});

	it("stops on core's own requirement errors", async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const respond = effectfulRespond(sql, {
				requirementErrors: { 'php extension': 'pdo_sqlite is missing' }
			});
			const d = driver(site, respond);
			prepare(d.deps);
			await chainTo(d.deps, 20);
			return runOf(sql);
		});
		expect(out.phase).toBe('halted');
		expect(out.haltReason).toBe('requirements-error');
	});

	it('halts on an abort by default, recording the function and staying fenced', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const respond = effectfulRespond(
				sql,
				{},
				{
					update: async () => ({
						ok: false,
						kind: 'update',
						finished: 0,
						abort: ['system_update_11101'],
						abortMessage: 'SQLSTATE[HY000]: table already exists'
					})
				}
			);
			const d = driver(site, respond);
			prepare(d.deps);
			await chainTo(d.deps, 40);
			return {
				run: runOf(sql),
				unit: statusOf(sql).units.find((u) => u.kind === 'update'),
				maint: readMaintenanceMode(sql)
			};
		});
		expect(out.run.phase).toBe('halted');
		expect(out.run.haltReason).toBe('unit-aborted');
		expect(out.run.abortList[0]).toBe('system_update_11101');
		expect(String(out.unit?.state)).toBe('aborted');
		expect(out.maint).toBe(true);
	});

	it('onAbort "continue" reproduces core and carries the abort list forward', async () => {
		const later: string[] = [];
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const respond = effectfulRespond(
				sql,
				{},
				{
					update: async () => ({
						ok: false,
						kind: 'update',
						finished: 0,
						abort: ['system_update_11101'],
						abortMessage: 'boom'
					})
				}
			);
			// record what later units are handed, which is where the abort list has to appear
			const recorded: Respond = async (code, meters) => {
				if (code.includes('system_update_11101') && kindOf(code) !== 'update')
					later.push(code);
				return respond(code, meters);
			};
			const d = driver(site, recorded);
			prepare(d.deps, { onAbort: 'continue' });
			await chainTo(d.deps, 80);
			return runOf(sql);
		});
		expect(out.phase).toBe('complete');
		expect(out.abortList[0]).toBe('system_update_11101');
		// the fragment for a LATER unit names the aborted function, so core can skip dependents
		expect(later.length).toBeGreaterThan(0);
	});

	it('halts on a throw crossing the bridge, recording the message', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const respond = effectfulRespond(
				sql,
				{},
				{
					update: async () => {
						throw new Error('ReferenceError: Asyncify is not defined');
					}
				}
			);
			const d = driver(site, respond);
			prepare(d.deps);
			await chainTo(d.deps, 40);
			return runOf(sql);
		});
		expect(out.phase).toBe('halted');
		expect(out.haltReason).toBe('unit-error');
		// the class site-do.js had to fix at the bridge
		expect(String(out.haltDetail)).toContain('Asyncify');
	});
});

describe("the cold interpreter, which is the free tier's real blocker", () => {
	it('refuses, backs off, counts the wait durably, and then halts', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const d = driver(site, effectfulRespond(sql), { phpReady: () => false });
			prepare(d.deps, { maxColdWaits: 2 });
			const claim = await beat(d.deps);
			const cold1 = await beat(d.deps);
			const waits = runOf(sql).coldWaits;
			await beat(d.deps);
			const cold3 = await beat(d.deps);
			return { claim, cold1, waits, cold3, run: runOf(sql) };
		});
		// the claim beat needs no interpreter, so it still runs cold
		expect(out.claim.beat).toBe('claim');
		expect(out.cold1.cold).toBe(true);
		expect(out.cold1.reason).toBe('cold-interpreter');
		expect(out.cold1.more).toBe(true);
		expect(out.waits).toBe(1);
		// a cold beat backs off instead of chaining at +1 ms
		expect(updbAlarmDelayMs(out.cold1)).toBe(5000);
		expect(out.run.phase).toBe('halted');
		expect(out.run.haltReason).toBe('cold-interpreter');
		expect(String(out.run.haltDetail)).toContain('3,754 ms');
		expect(out.cold3.more).toBe(false);
	});

	it('runs a snapshot unit with no interpreter at all, which is why it is JS-only', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const d = driver(
				site,
				async () => {
					throw new Error('PHP must not be entered for a snapshot unit');
				},
				{ phpReady: () => false }
			);
			const runId = prepare(d.deps).run.id;
			await beat(d.deps); // claim maint_on
			// maint_on DOES need PHP, so force the cursor past it the way a run beat would --
			// INCLUDING the fence it would have raised, or the gate correctly refuses the next
			// unit for maintenance-off. The claim being asserted is only that `snapshot` itself
			// needs no interpreter.
			sql.exec("UPDATE cfw_updb_unit SET state = 'done' WHERE run_id = ? AND seq = 0", runId);
			sql.exec('UPDATE cfw_updb_run SET cursor_seq = 1 WHERE id = ?', runId);
			kvSet(sql, 'state', 'system.maintenance_mode', 'b:1;');
			await beat(d.deps); // claim snapshot
			const snap = await beat(d.deps); // run snapshot, cold
			return { snap, cursor: runOf(sql).cursorSeq };
		});
		expect(out.snap.ran).toBe(true);
		expect(out.cursor).toBe(2);
	});
});

describe('the snapshot: bounded, and it refuses rather than spending the day', () => {
	it('copies every bookkeeping table it found', async () => {
		const out = await withSite(({ sql }) => {
			seedSite(sql);
			const snap = snapshotTables(sql, {}) as unknown as Snap;
			return { snap, names: tableNames(sql) };
		});
		expect(out.snap.ok).toBe(true);
		expect(out.snap.counts?.key_value).toBe(3);
		expect(Number(out.snap.rowsWritten)).toBeGreaterThan(0);
		expect(UPDB_SNAPSHOT_TABLES.every((t) => out.names.includes(`cfw_updb_snap_${t}`))).toBe(
			true
		);
	});

	it('refuses an oversized snapshot, naming the table and the meter', async () => {
		const out = await withSite(({ sql }) => {
			seedSite(sql, { configRows: 25000 });
			const refused = snapshotTables(sql, { maxRows: 20000 }) as unknown as Snap;
			return { refused, names: tableNames(sql) };
		});
		expect(out.refused.ok).toBe(false);
		expect(String(out.refused.error)).toContain('config');
		expect(String(out.refused.error)).toContain('100,000/day');
		expect(out.names.includes('cfw_updb_snap_config')).toBe(false);
	});

	it('skips a bookkeeping table that does not exist yet', async () => {
		const out = await withSite(({ sql }) => {
			seedSite(sql);
			// cachetags is created lazily, so a site that never invalidated a tag has none
			sql.exec('DROP TABLE cachetags');
			const p = snapshotTables(sql, {}) as unknown as Snap;
			return { p, names: tableNames(sql) };
		});
		expect(out.p.ok).toBe(true);
		expect(out.p.missing).toContain('cachetags');
		expect(out.names.includes('cfw_updb_snap_key_value')).toBe(true);
	});

	it('restores what it copied, and drops the copies on request', async () => {
		const out = await withSite(({ sql }) => {
			seedSite(sql);
			snapshotTables(sql, {});
			kvSet(sql, 'system.schema', 'system', 'i:99999;');
			sql.exec("INSERT INTO config (collection, name, data) VALUES ('', 'junk', 'a:0:{}')");
			const rest = restoreSnapshot(sql, {}) as unknown as Restore;
			const dropped = dropSnapshot(sql, {}) as unknown as { ok: boolean };
			return {
				rest,
				schema: readSchemaVersion(sql, 'system'),
				configRows: countOf(sql, 'config'),
				dropped,
				names: tableNames(sql)
			};
		});
		expect(out.rest.ok).toBe(true);
		expect(out.schema).toBe(11100);
		expect(out.configRows).toBe(1);
		expect(out.dropped.ok).toBe(true);
		expect(UPDB_SNAPSHOT_TABLES.some((t) => out.names.includes(`cfw_updb_snap_${t}`))).toBe(
			false
		);
	});

	it('skips a missing snapshot table rather than throwing the transaction away', async () => {
		const out = await withSite(({ sql }) => {
			seedSite(sql);
			snapshotTables(sql, {});
			sql.exec('DROP TABLE cfw_updb_snap_config');
			let rolledBack = false;
			const r3 = restoreSnapshot(sql, {
				tables: ['key_value', 'config'],
				txn: (fn: () => void) => {
					try {
						fn();
					} catch (e) {
						rolledBack = true;
						throw e;
					}
				}
			}) as unknown as Restore;
			return { r3, rolledBack };
		});
		expect(out.r3.ok).toBe(true);
		expect(out.rolledBack).toBe(false);
		expect(out.r3.restored).toContain('key_value');
	});
});

describe('rollback is only legal from halted, and says what it does not cover', () => {
	it('refuses a live run, restores from a halted one, and refuses a second time', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const d = driver(site, effectfulRespond(sql));
			prepare(d.deps);
			// fence and snapshot: 2 units at 2 beats each
			for (let i = 0; i < 4; i++) await beat(d.deps);
			const live = updbRollback(d.deps, {}) as unknown as Rollback;

			kvSet(sql, 'system.schema', 'system', 'i:11101;');
			updbHalt(sql, runOf(sql), 'unit-unverifiable', 'for the test', START_MS + 99);
			const rb = updbRollback(d.deps, {}) as unknown as Rollback;
			return {
				live,
				rb,
				schema: readSchemaVersion(sql, 'system'),
				phase: runOf(sql).phase,
				second: updbRollback(d.deps, {}) as unknown as Rollback
			};
		});
		expect(out.live.reason).toBe('not-halted');
		expect(out.rb.ok).toBe(true);
		expect(out.schema).toBe(11100);
		expect(out.phase).toBe('rolled_back');
		expect(
			String(out.rb.doesNotCover).includes('content') &&
				String(out.rb.covers).includes('bookkeeping')
		).toBe(true);
		// maintenance mode is left ON: the site is not proven good
		expect(String(out.rb.maintenanceMode).includes('left ON')).toBe(true);
		expect(out.second.reason).toBe('not-halted');
	});

	it('refuses rather than faking a rollback with no snapshot', async () => {
		const out = await withSite((site) => {
			seedSite(site.sql);
			const d = driver(site, happyRespond());
			prepare(d.deps);
			updbHalt(site.sql, runOf(site.sql), 'x', 'y', START_MS);
			return updbRollback(d.deps, {}) as unknown as Rollback;
		});
		expect(out.reason).toBe('no-snapshot');
	});
});

describe('terminal idempotence', () => {
	it('a completed run writes nothing, ever again', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const d = driver(site, effectfulRespond(sql));
			prepare(d.deps);
			await chainTo(d.deps);
			const phase = runOf(sql).phase;

			const world = worldOf(sql);
			const a = await beat(d.deps);
			const b = await beat(d.deps);
			const c = (await updbDrain(d.deps, { maxBeats: 5 })) as unknown as { beats: Beat[] };
			return { phase, a, b, c, world, after: worldOf(sql) };
		});
		expect(out.phase).toBe('complete');
		expect(out.a.ran).toBe(false);
		expect(out.a.reason).toBe('complete');
		expect(out.b.ran).toBe(false);
		expect(out.c.beats).toHaveLength(1);
		expect(out.after).toBe(out.world);
		expect(out.a.more).toBe(false);
		// so the alarm chain goes idle
		expect(updbAlarmDelayMs(out.a)).toBe(240000);
	});

	it('a halted run is equally inert, and does NOT clear itself', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const d = driver(site, effectfulRespond(sql));
			prepare(d.deps);
			updbHalt(sql, runOf(sql), 'unit-aborted', 'for the test', START_MS);
			const world = worldOf(sql);
			await beat(d.deps);
			await beat(d.deps);
			const third = await beat(d.deps);
			// starting a second cursor over the same schema is the failure this file prevents,
			// so it takes an operator decision
			const blocked = prepare(d.deps);
			return { world, after: worldOf(sql), third, blocked };
		});
		expect(out.after).toBe(out.world);
		expect(out.third.ok).toBe(false);
		expect(out.blocked.ok).toBe(false);
		expect(out.blocked.reason).toBe('previous-run-halted');
		// naming the halt reason, so the operator knows what to look at
		expect(String(out.blocked.detail)).toContain('unit-aborted');
	});

	it('abandon demands a reason, records it, and unblocks the next run', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const d = driver(site, effectfulRespond(sql));
			prepare(d.deps);
			updbHalt(sql, runOf(sql), 'unit-aborted', 'for the test', START_MS);
			const noReason = updbAbandon(d.deps, {}) as unknown as Abandon;
			const abandoned = updbAbandon(d.deps, {
				reason: 'schema verified by hand'
			}) as unknown as Abandon;
			const run = runOf(sql);
			const inert = await beat(d.deps);
			return { noReason, abandoned, run, inert, next: prepare(d.deps) };
		});
		expect(out.noReason.reason).toBe('reason-required');
		expect(out.abandoned.ok).toBe(true);
		expect(out.abandoned.was).toBe('unit-aborted');
		expect(out.run.phase).toBe('abandoned');
		expect(String(out.run.haltDetail)).toContain('ABANDONED: schema verified by hand');
		expect(out.inert.ran).toBe(false);
		expect(out.next.ok).toBe(true);
	});
});

describe('cursor desync is a halt, not a guess', () => {
	it.each([
		[
			'a done unit under the cursor',
			(sql: Sql, runId: string) =>
				sql.exec(
					"UPDATE cfw_updb_unit SET state = 'done' WHERE run_id = ? AND seq = 0",
					runId
				)
		],
		[
			'a missing unit under the cursor',
			(sql: Sql, runId: string) =>
				sql.exec('DELETE FROM cfw_updb_unit WHERE run_id = ? AND seq = 0', runId)
		]
	])('halts on %s', async (_label, corrupt) => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const d = driver(site, effectfulRespond(sql));
			const runId = prepare(d.deps).run.id;
			// corrupt the bookkeeping the way a partial commit would
			corrupt(sql, runId);
			const step = await beat(d.deps);
			return { run: runOf(sql), step };
		});
		expect(out.run.phase).toBe('halted');
		expect(out.run.haltReason).toBe('cursor-desync');
		// rather than skipping ahead
		expect(out.step.more).toBe(false);
	});
});

describe('the alarm cadence, matching src/ops/cron', () => {
	it.each([
		['a chain with work re-arms at +1 ms', { more: true }, {}, 1],
		['a finished chain goes idle', { more: false }, {}, 240000],
		['a cold beat backs off', { cold: true, more: true }, {}, 5000],
		['overrides are honoured', { more: true }, { chainMs: 7 }, 7]
	])('%s', (_label, step, options, want) => {
		expect(updbAlarmDelayMs(step, options)).toBe(want);
	});
});

describe('env plumbing, matching cronOptions()', () => {
	const defaults = updbOptions({});

	it.each([
		['flushSplit defaults on', 'flushSplit', true],
		['unbounded defaults off', 'allowUnbounded', false],
		['retryPolicy defaults to halt', 'retryPolicy', 'halt'],
		['onAbort defaults to halt', 'onAbort', 'halt'],
		['maxBeats defaults to ONE, which is the free-plan requirement', 'maxBeats', 1],
		['the snapshot ceiling defaults to 20000', 'snapshotMaxRows', 20000],
		['requirements are checked by default', 'checkRequirements', true]
	])('%s', (_label, key, want) => {
		expect(defaults[key as keyof typeof defaults]).toBe(want);
	});

	const overridden = updbOptions({
		UPDB_FLUSH_SPLIT: '0',
		UPDB_ALLOW_UNBOUNDED: '1',
		UPDB_RETRY_POLICY: 'core',
		UPDB_ON_ABORT: 'continue',
		UPDB_MAX_BEATS: '4',
		UPDB_SNAPSHOT_MAX_ROWS: '500',
		UPDB_CHECK_REQUIREMENTS: '0',
		UPDB_MAX_ATTEMPTS: '9'
	});

	it.each([
		['flushSplit', false],
		['allowUnbounded', true],
		['retryPolicy', 'core'],
		['onAbort', 'continue'],
		['maxBeats', 4],
		['snapshotMaxRows', 500],
		['checkRequirements', false],
		['maxAttempts', 9]
	])('%s is overridable', (key, want) => {
		expect(overridden[key as keyof typeof overridden]).toBe(want);
	});

	it('falls back on a nonsense number rather than producing 0 or NaN', () => {
		expect(updbOptions({ UPDB_MAX_BEATS: '-3' }).maxBeats).toBe(1);
	});
});

describe('drain, and why its default is 1', () => {
	it('runs one beat by default, more on a paid budget, and stops when told', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const d = driver(site, effectfulRespond(sql));
			prepare(d.deps);
			const one = (await updbDrain(d.deps, {})) as unknown as { beats: Beat[] };
			const many = (await updbDrain(d.deps, { maxBeats: 4 })) as unknown as { beats: Beat[] };
			return { one, many };
		});
		expect(out.one.beats).toHaveLength(1);
		expect(out.many.beats).toHaveLength(4);
	});

	it('stops early when the chain says stop', async () => {
		const out = await withSite(async (site) => {
			seedSite(site.sql);
			// no run at all, so the first beat reports more: false
			const d = driver(site, happyRespond());
			return (await updbDrain(d.deps, { maxBeats: 9 })) as unknown as { beats: Beat[] };
		});
		expect(out.beats).toHaveLength(1);
	});
});

/**
 * The PHP fragments are `String.raw` templates, and two mistakes in them break the BUNDLE
 * rather than a test: a backtick terminates the template literal, and `${` interpolates. That
 * has happened twice here, once in `updb-php.js` where a PHP comment containing a backtick
 * produced `Expected ";" but found "semaphore"` at build time.
 */
describe('PHP fragments: the mistakes that break the bundle', () => {
	// String.fromCharCode(96) rather than a literal, so this file cannot break the same way it
	// is asserting against
	const BACKTICK = String.fromCharCode(96);
	const fragments: Record<string, string> = {
		'updbPlan()': updbPlan(true),
		'updbPlan(false)': updbPlan(false),
		UPDB_VERIFY,
		'updbUnit(update)': updbUnit({
			seq: 3,
			kind: 'update',
			module: 'system',
			number: 11101,
			depMap: ['system_update_11102'],
			seedSchema: 11100
		}),
		'updbUnit(post_update)': updbUnit({
			seq: 4,
			kind: 'post_update',
			fn: 'system_post_update_x'
		}),
		'updbUnit(flush)': updbUnit({ seq: 5, kind: 'flush', step: 'router' }),
		'updbUnit(maint_on)': updbUnit({ seq: 0, kind: 'maint_on' })
	};
	const names = Object.keys(fragments);

	it.each(names)('%s contains no backtick', (name) => {
		expect(fragments[name]).not.toContain(BACKTICK);
	});

	it.each(names)('%s opens with <?php', (name) => {
		expect(fragments[name]!.trimStart().startsWith('<?php')).toBe(true);
	});

	it.each(names)('%s prints exactly one json_encode', (name) => {
		expect((fragments[name]!.match(/echo json_encode\(/g) ?? []).length).toBe(1);
	});

	// eval'd through pib_run, so a top-level `use` is a parse error
	it.each(names)('%s has no top-level use statement', (name) => {
		expect(/^use\s+\\?[A-Z]/m.test(fragments[name]!)).toBe(false);
	});

	it.each(names)('%s catches Throwable at the top level', (name) => {
		expect(fragments[name]).toContain('catch (\\Throwable $e)');
	});

	describe('the update runner, which a previous round got wrong', () => {
		const unit = fragments['updbUnit(update)']!;

		it.each([
			['install.inc', 'core/includes/install.inc'],
			['update.inc', 'core/includes/update.inc'],
			// common.inc carries SAVED_UPDATED and drupal_flush_all_caches
			['common.inc', 'core/includes/common.inc'],
			// discovery is get_defined_functions(), so this runs on every unit
			['drupal_load_updates() every time', 'drupal_load_updates()'],
			// _batch_process seeds finished to 1
			['finished seeded to 1', "'finished' => 1"],
			[
				'update_do_one with the dependency map',
				"update_do_one($module, $number, array_values($u['depMap']), $context)"
			],
			['the sandbox serialized to base64', 'base64_encode($serialized)'],
			['the installed version before', 'installedBefore'],
			['the installed version after', 'installedAfter'],
			// the REAL service id
			['update.update_hook_registry', 'update.update_hook_registry']
		])('requires %s', (_label, needle) => {
			expect(unit).toContain(needle);
		});

		it('wraps update_do_one in catch(Throwable), because core catches only Exception', () => {
			expect(/try \{\s*update_do_one/.test(unit.replace(/\n/g, ' '))).toBe(true);
		});
	});

	describe('the post-update runner', () => {
		const post = fragments['updbUnit(post_update)']!;

		it('uses update.post_update_registry', () => {
			expect(post).toContain('update.post_update_registry');
		});

		it('does NOT name a PostUpdateRegistry class, which does not exist in core', () => {
			expect(post).not.toContain('PostUpdateRegistry');
		});

		it("loads the extension's post_update file before function_exists", () => {
			expect(post).toContain('getUpdateFunctions($extension)');
		});

		it('calls update_invoke_post_update', () => {
			expect(post).toContain('update_invoke_post_update($fn, $context)');
		});
	});

	describe('the plan', () => {
		const plan = fragments['updbPlan()']!;

		it.each([
			['update_get_update_list', 'update_get_update_list()'],
			['update_resolve_dependencies', 'update_resolve_dependencies($start)'],
			['reverse_paths for the dependency map', 'reverse_paths'],
			// core seeds number-1 for the first update of a module
			['number - 1 seeding', '$number - 1'],
			['the update function names hashed into codeId', "$out['codeId'] = sha1("],
			['the RequirementSeverity enum', 'RequirementSeverity::Error']
		])('uses %s', (_label, needle) => {
			expect(plan).toContain(needle);
		});

		it('compiles checkRequirements in, and out again when disabled', () => {
			expect(plan.includes('if (true) {')).toBe(true);
			expect(fragments['updbPlan(false)']!.includes('if (false) {')).toBe(true);
		});
	});

	describe('the flush unit', () => {
		const flush = fragments['updbUnit(flush)']!;

		it('refuses unless the unit says unbounded, quoting the measured cost', () => {
			expect(flush).toContain("$u['unbounded'] !== true");
			expect(flush).toContain('282.9 ms');
		});

		it.each(UPDB_FLUSH_STEPS)('implements step %s', (step) => {
			expect(flush).toContain(`$step === '${step}'`);
		});

		it('documents the router rebuild as indivisible', () => {
			expect(flush).toContain('INDIVISIBLE');
		});
	});

	// the payload is JSON-escaped rather than interpolated, which is the injection seam
	describe('the payload is escaped, not interpolated', () => {
		it('filters an unknown step out rather than interpolating it', () => {
			const nasty = updbUnit({ seq: 1, kind: 'flush', step: "router'; DROP TABLE x; --" });
			expect(nasty).not.toContain('DROP TABLE');
		});

		it('drops a malformed dependency name and keeps the good one', () => {
			const nastyDep = updbUnit({
				seq: 1,
				kind: 'update',
				module: 'm',
				number: 1,
				depMap: ['ok_fn', "bad fn'; --"]
			});
			expect(nastyDep).not.toContain('bad fn');
			expect(nastyDep).toContain('ok_fn');
		});
	});
});

describe('the trade the caller has to see', () => {
	// the plan shape a typical SA-CORE point release produces, priced in the two meters that
	// actually bind on the free plan
	const units = buildPlanUnits(samplePlan()).length + 3;
	const beats = units * 2;
	// one bookkeeping write plus one setAlarm
	const rows = beats * 2;

	it("costs under 0.2% of a day's DO requests", () => {
		expect(beats / 100000).toBeLessThan(0.002);
	});

	it("and under 0.5% of a day's row writes", () => {
		expect(rows / 100000).toBeLessThan(0.005);
	});
});

/**
 * The one that matters. Every way a unit can fail, driven end to end, asserting the same four
 * properties each time: the run stops, the phase is durable and named, the site is still
 * fenced, and no unit is both un-run and marked done.
 */
describe('the chain cannot half-apply silently', () => {
	const cases: [string, Record<string, Hook>][] = [
		[
			'a PHP refusal',
			{ update: async () => ({ ok: false, refused: 'missing-function', error: 'gone' }) }
		],
		[
			'an abort',
			{
				update: async () => ({
					ok: false,
					finished: 0,
					abort: ['system_update_11101'],
					abortMessage: 'boom'
				})
			}
		],
		[
			'a bridge throw',
			{
				update: async () => {
					throw new Error('bridge died');
				}
			}
		],
		['a result with no ok flag at all', { update: async () => ({ finished: 1 }) }]
	];

	it.each(cases)('%s cannot half-apply', async (_label, hooks) => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const d = driver(site, effectfulRespond(sql, {}, hooks));
			prepare(d.deps);
			const beats = await chainTo(d.deps, 60);
			const status = statusOf(sql);
			return {
				last: beats[beats.length - 1],
				run: runOf(sql),
				maint: readMaintenanceMode(sql),
				reachedMaintOff: status.units.some(
					(u) => u.kind === 'maint_off' && String(u.state) === 'done'
				),
				phantomDone: status.units.some(
					(u) => String(u.state) === 'done' && Number(u.passes) < 1
				)
			};
		});
		expect(out.last?.more).toBe(false);
		expect(out.run.phase).toBe('halted');
		expect(typeof out.run.haltReason === 'string' && out.run.haltReason.length > 0).toBe(true);
		expect(out.maint).toBe(true);
		expect(out.reachedMaintOff).toBe(false);
		expect(out.phantomDone).toBe(false);
	});

	// the kill case, which is the one with no PHP-side signal at all
	it('a KILLED invocation cannot half-apply', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const respond = effectfulRespond(sql);
			const d = driver(site, respond);
			prepare(d.deps);
			for (let i = 0; i < 7; i++) await beat(d.deps);
			const cursorAt = runOf(sql).cursorSeq;
			const killed = driver(site, respond, { tokens: holder() });
			const step = await beat(killed.deps);
			return { step, cursorAt, run: runOf(sql), maint: readMaintenanceMode(sql) };
		});
		expect(out.step.more).toBe(false);
		expect(out.run.phase).toBe('halted');
		expect(out.maint).toBe(true);
		expect(out.run.cursorSeq).toBe(out.cursorAt);
		expect(out.run.haltReason).toBe('unit-unverifiable');
	});

	// CONTROL: without this, everything above would be asserting that a chain which never
	// works cannot half-apply
	it('control: the happy path really does reach the end', async () => {
		const out = await withSite(async (site) => {
			const sql = site.sql;
			seedSite(sql);
			const d = driver(site, effectfulRespond(sql));
			prepare(d.deps);
			await chainTo(d.deps);
			return {
				run: runOf(sql),
				maint: readMaintenanceMode(sql),
				ranMaintOff: statusOf(sql).units.some(
					(u) => u.kind === 'maint_off' && String(u.state) === 'done'
				)
			};
		});
		expect(out.run.phase).toBe('complete');
		expect(out.maint).toBe(false);
		expect(out.ranMaintOff).toBe(true);
	});
});

/**
 * The fixture's own controls.
 *
 * The original's `fakeSql` threw on any statement it had not been taught, which is what stopped
 * an unmodelled write passing silently. Here that property belongs to the engine, so it is
 * asserted rather than assumed -- otherwise the port would have quietly dropped the one control
 * that proved the fixture could fail.
 */
describe('the fixture can fail', () => {
	it('refuses a statement against a table that does not exist', async () => {
		const err = await withSite(({ sql }) => {
			seedSite(sql);
			try {
				sql.exec('UPDATE cfw_updb_nope SET x = 1');
				return null;
			} catch (e) {
				return String((e as Error).message);
			}
		});
		expect(err).toMatch(/no such table/i);
	});

	it('reports the engine own rowsWritten, so the meters are the host', async () => {
		const written = await withSite(({ sql }) => {
			seedSite(sql);
			return sql.exec("INSERT INTO cachetags (tag, invalidations) VALUES ('block_view', 1)")
				.rowsWritten;
		});
		// one row plus whatever the primary key index costs; the number is the host's
		expect(written).toBeGreaterThanOrEqual(1);
	});
});
