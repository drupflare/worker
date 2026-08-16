import { SELF, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { MIGRATE_TABLE, type SqlLike, ensureMigrateTable } from '../../src/db/migrate-sql';

/**
 * The harness the ported serve-chain specs drive: a REAL `SitePhpDurableObject`, with the PHP
 * interpreter -- and only the interpreter -- replaced.
 *
 * Shared rather than copied into each of the seven spec files, for the reason
 * `drupal-schema.ts` gives: a harness duplicated seven times drifts until the suites are
 * testing different things.
 *
 * What is real here: `ctx.storage.sql`, `ctx.storage.setAlarm`/`getAlarm`, the alarm handler,
 * `caches.default`, the FIFO gate, the Worker in front of the object, and the packed migration
 * chunks out of the ASSETS binding. WHAT IS NOT: `php._run()`. There is no wasm interpreter in
 * this lane, so `runJson()` is stubbed -- see `stubRender()` for what that costs.
 *
 * Not a `.spec.ts`, so vitest does not collect it, and `tests/**` is excluded from coverage.
 */

/** the `ctx.storage.sql` surface, same shape `drupal-schema.ts` declares */
export type Sql = {
	exec: (
		text: string,
		...params: unknown[]
	) => { toArray(): Record<string, unknown>[]; rowsWritten: number; rowsRead: number };
};

/** what `renderPage()`'s PHP prints, which is what `fillOne()` consumes */
export type RenderResult = {
	html?: string;
	status?: number;
	contentType?: string;
	renderMs?: number;
	bytes?: number;
	pageCache?: string;
	dynamicCache?: string;
	destructed?: unknown;
	error?: string;
};

/** one entry into the stubbed interpreter, read back out of the emitted PHP fragment */
export type RenderCall = { path: string; bins: string[]; destruct: string; code: string };

/** what `fillOne()` hands back; the two outcomes share only `filled` and `remaining` */
export type FillOutcome = {
	filled: string | null;
	remaining: number;
	failed?: string;
	error?: string;
	attempts?: number;
	bytes?: number;
	renderMs?: number;
	pageCache?: string;
	dynamicCache?: string;
};

export type BumpResult = {
	generation: number;
	reason: string;
	purgedPages: number;
	requeued: number;
	droppedFromRequeue: number;
};

/**
 * The subset of the Durable Object a spec drives.
 *
 * Written out rather than inferred, and it is a platform limit rather than a preference:
 * `runInDurableObject` types its callback argument off `DurableObjectStub<O>`, and
 * `DurableObjectNamespace<T>` requires `T` to carry `[__DURABLE_OBJECT_BRAND]`. A plain JS
 * class does not, so `DurableObjectNamespace<SitePhpDurableObject>` fails to typecheck
 * ("Property '[__DURABLE_OBJECT_BRAND]' is missing") and the instance arrives as
 * `DurableObject`, on which none of these members exist. `cron-chain.spec.ts` and
 * `updb.spec.ts` narrow the same way for the same reason.
 */
export type ServeDo = {
	ctx: {
		storage: {
			sql: Sql;
			getAlarm: () => Promise<number | null>;
			setAlarm: (at: number) => Promise<void>;
		};
	};
	sql: Sql;
	env: Record<string, unknown>;
	php: unknown;
	runJson: (code: string) => Promise<Record<string, unknown>>;
	fetch: (request: Request) => Promise<Response>;
	execSql: (sql: string, params?: unknown) => unknown;
	alarm: () => Promise<unknown>;
	armFillAlarm: () => void;
	ensureServeTables: () => void;
	ensureHttpTables: () => void;
	queueDepth: () => number;
	generation: () => number;
	metaGet: (key: string, fallback?: string | null) => string | null;
	/** first-run provisioning: the state check, the durable marker, and what acts on it */
	neverMigrated: () => boolean;
	provisionRequested: () => boolean;
	requestProvision: () => Promise<void>;
	hasMigrationManifest: () => Promise<boolean>;
	migrateStepIfPending: () => Promise<Record<string, unknown> | null>;
	/** the memoised migrator, replaceable so a provisioning spec needs no packed chunks */
	_migrator?: unknown;
	/** the daily rows meter: the accumulator, its flush, and the read that does not write */
	rowsSinceFlush?: number;
	flushDailyRows: (nowMs?: number) => number;
	dailyRows: (nowMs?: number) => number;
	bumpGeneration: (reason?: string) => BumpResult;
	fillOne: (
		targetPath?: string | null,
		bins?: string[],
		destruct?: boolean | string
	) => Promise<FillOutcome>;
	strikeFillHead: (error: string) => number | null;
	handleIndex: (binary: never) => { id: number; add?: (o: object) => number } | null;
	pinHandles: (binary: never) => number;
	pinnedHandles?: Set<object>;
	queueHttp: (url: string, method?: string, body?: string) => void;
	httpCacheGet: (
		url: string,
		method?: string,
		body?: string
	) => { status: number; headers: Record<string, string>; body: string } | null;
	countOrNull: (table: string) => number | null;
	drainHttpQueue: (limit?: number) => Promise<{
		drained: Record<string, unknown>[];
		remaining: number;
	}>;
	serveTablesReady?: boolean;
	lastRenderMs?: number;
	/** wall time of a fill that also booted; diagnostics only, never an estimate */
	lastBootInclusiveMs?: number;
	renderClockUnmeasurable?: boolean;
	heapRestore?: Record<string, unknown> | null;
};

/** every `x-cfw-*` header the original suite's `serve()` read, plus the body */
export type ServeProbe = {
	status: number;
	cache: string | null;
	doCache: string | null;
	edge: string | null;
	edgePut: string | null;
	deny: string | null;
	generation: number;
	inline: string | null;
	renderClock: string | null;
	budgetMs: number;
	estimateMs: number;
	missMs: number;
	hitMs: number;
	renderMs: number;
	phpBooted: string | null;
	lane: string | null;
	gateActive: string | null;
	gateQueued: string | null;
	queueDepth: number;
	migrate: string | null;
	retryAfter: string | null;
	cacheControl: string | null;
	contentType: string | null;
	body: string;
	/** anything the named fields above do not cover */
	header: (name: string) => string | null;
};

/** the `/__serve-stats` body, as far as these specs read it */
export type ServeStats = {
	cached: { path: string; status: number; bytes: number; render_ms: number }[];
	queue: { path: string; attempts: number; last_error: string | null }[];
	alarmFirings: number;
	generation: number;
	bumps: number;
	lastBump: string | null;
	serveRequests: number;
	storageLaneServes: number;
	phpLaneEntries: number;
	gate: {
		maxConcurrent: number;
		active: number;
		queued: number;
		completed: number;
		order: string[];
	};
	semaphoreHeld: number | null;
	httpQueue: number | null;
	lastHttpDrain: { drained?: Record<string, unknown>[]; remaining?: number } | null;
	asyncifyCalls: number;
	phpBooted: boolean;
	migrate: { chunk: number; chunks: number; state: string } | null;
	lastAlarmOutcome: unknown;
	rowsWritten: number;
	lastGc: Record<string, unknown> | null;
};

/**
 * An object of its own, NEVER PROVISIONED: no database, no cursor, nothing to render from.
 *
 * That second half used to be invisible, because an object in this state answered `warming` on
 * every request forever and a cold-MISS assertion could not tell the two apart. It can now --
 * `/__serve` asks for provisioning and returns the `migrating` placeholder -- so a spec asserting a
 * cold MISS wants {@link provisionedSite}, and only a spec asserting FIRST-RUN behaviour wants this.
 */
export function freshSite() {
	return env.SITE.get(env.SITE.newUniqueId());
}

/**
 * Stamps the migration cursor `done`, which is the state every provisioned site is in.
 *
 * The CURSOR and not the in-memory `migrated` flag, and the difference is load-bearing: the flag is
 * discarded on eviction, so a spec that evicts would silently drop back to the never-provisioned
 * branch and assert against the wrong placeholder. `ensureMigrateTable()` rather than a copy of the
 * DDL, so a schema change cannot leave the fixture writing to a table shaped like last month's.
 */
export function markProvisioned(site: ServeDo, generation = 'test-fixture'): void {
	ensureMigrateTable(site.sql as SqlLike);
	site.sql.exec(
		`INSERT INTO ${MIGRATE_TABLE} (id, generation, chunk, chunks, statements, rows_written,
			state, error, started_at, updated_at)
		 VALUES (1, ?, 0, 0, 0, 0, 'done', NULL, 0, 0)
		 ON CONFLICT(id) DO UPDATE SET state = 'done'`,
		generation
	);
}

/**
 * A fresh object that has already been provisioned: no warm state, but a database to render from.
 *
 * This is what "a cold object" means everywhere except the first-run specs -- cold is about the
 * INTERPRETER and the page cache, not about whether the site exists.
 */
export async function provisionedSite(): Promise<DurableObjectStub> {
	const stub = freshSite();
	await inObject(stub, (site) => markProvisioned(site));
	return stub;
}

/** the object the Worker in front reaches for `?site=<name>`, which is how the two lanes meet */
export function namedSite(name: string) {
	return env.SITE.get(env.SITE.idFromName(name));
}

/**
 * The same object, provisioned.
 *
 * The Worker-side counterpart of {@link provisionedSite}: a spec that drives `/serve` through the
 * front end and expects a MISS needs the object to have a database, or the first request is the
 * first-run placeholder and carries no `x-cfw-cache` at all.
 */
export async function provisionedNamedSite(name: string): Promise<DurableObjectStub> {
	const stub = namedSite(name);
	await inObject(stub, (site) => markProvisioned(site));
	return stub;
}

/** runs `fn` against the real instance, narrowed to the surface above */
export function inObject<T>(
	stub: DurableObjectStub,
	fn: (site: ServeDo) => T | Promise<T>
): Promise<T> {
	return runInDurableObject(stub, (instance) => fn(instance as unknown as ServeDo));
}

/**
 * Replaces the interpreter with a function of the path.
 *
 * `php` is set to a non-null marker because that is precisely what the module tests: a MISS
 * refuses to render inline when `this.php` is null (`x-cfw-inline: cold`) and estimates 4,000 ms
 * for a boot it cannot wait out. Nothing here calls into the marker.
 *
 * What this cannot cover, stated where it is done rather than in a report: anything whose
 * failure mode is inside Drupal. The original asserted a real `<title>` in the body and that two
 * paths return different bytes, which caught `PageCache` memoizing its cid across paths. A stub
 * keyed on the path agrees with the JS half by construction, so that particular defect is out of
 * reach here and stays with the deployed e2e lane.
 *
 * @returns the calls made, decoded out of the PHP fragment the module emitted
 */
export function stubRender(
	site: ServeDo,
	render: (call: RenderCall) => RenderResult | Promise<RenderResult>
): RenderCall[] {
	const calls: RenderCall[] = [];
	site.php = { stubbed: true };
	site.runJson = async (code) => {
		const call = decodeRenderCall(code);
		calls.push(call);
		return (await render(call)) as Record<string, unknown>;
	};
	return calls;
}

/** the default stub: one small page per path, reporting a render cost the host cannot measure */
export function pageFor(path: string, renderMs = 42): RenderResult {
	const html = `<html><head><title>${path}</title></head><body>page ${path}</body></html>`;
	return {
		html,
		status: 200,
		contentType: 'text/html; charset=utf-8',
		renderMs,
		bytes: html.length,
		pageCache: 'MISS',
		dynamicCache: 'MISS'
	};
}

/**
 * Reads the path, the bins and the destruct argument back out of the emitted fragment.
 *
 * Matching the fragment rather than intercepting `fillOne()` is the same
 * trick `cron-chain.spec.ts` uses: it proves the module put the caller's path and bins into the
 * PHP it emitted. The path arrives JSON-stringified twice on the way in -- once for the payload,
 * once to make it a PHP string literal -- so what lands in the source is
 * `json_decode("\"/user/login\"")`.
 */
export function decodeRenderCall(code: string): RenderCall {
	const path = /json_decode\("\\"(.*?)\\""\)/.exec(code)?.[1] ?? '';
	const rawBins = /json_decode\("(\[.*?\])", true\)/.exec(code)?.[1] ?? '[]';
	let bins: string[] = [];
	try {
		bins = JSON.parse(rawBins.replace(/\\"/g, '"')) as string[];
	} catch {
		bins = [];
	}
	const destruct = /cfw_serve\(\$path, (.+?)\);/.exec(code)?.[1] ?? '';
	return { path, bins, destruct, code };
}

/** one `/__serve` against the object, bypassing the Worker and its edge cache */
export async function serveDirect(site: ServeDo, path: string, query = ''): Promise<ServeProbe> {
	const res = await site.fetch(
		new Request(`https://do.local/__serve?path=${encodeURIComponent(path)}${query}`)
	);
	return probe(res);
}

/** one `/serve` through the Worker, so the edge tier and the generation pointer are involved */
export async function serveThroughWorker(
	siteName: string,
	path: string,
	query = ''
): Promise<ServeProbe> {
	const res = await SELF.fetch(
		`https://cfw.local/serve?site=${siteName}&path=${encodeURIComponent(path)}${query}`
	);
	return probe(res);
}

/** the header bag the original suite's `serve()` built, kept field for field */
export async function probe(res: Response): Promise<ServeProbe> {
	const num = (name: string, fallback = -1) => {
		const raw = res.headers.get(name);
		return raw === null ? fallback : Number(raw);
	};
	return {
		status: res.status,
		cache: res.headers.get('x-cfw-cache'),
		doCache: res.headers.get('x-cfw-do-cache'),
		edge: res.headers.get('x-cfw-edge'),
		edgePut: res.headers.get('x-cfw-edge-put'),
		deny: res.headers.get('x-cfw-deny'),
		generation: num('x-cfw-generation'),
		inline: res.headers.get('x-cfw-inline'),
		renderClock: res.headers.get('x-cfw-render-clock'),
		budgetMs: num('x-cfw-inline-budget-ms'),
		estimateMs: num('x-cfw-inline-estimate-ms'),
		missMs: num('x-cfw-miss-ms'),
		hitMs: num('x-cfw-hit-ms'),
		renderMs: num('x-cfw-render-ms'),
		phpBooted: res.headers.get('x-cfw-php-booted'),
		lane: res.headers.get('x-cfw-lane'),
		gateActive: res.headers.get('x-cfw-gate-active'),
		gateQueued: res.headers.get('x-cfw-gate-queued'),
		queueDepth: num('x-cfw-queue-depth'),
		migrate: res.headers.get('x-cfw-migrate'),
		retryAfter: res.headers.get('retry-after'),
		cacheControl: res.headers.get('cache-control'),
		contentType: res.headers.get('content-type'),
		body: await res.text(),
		header: (name) => res.headers.get(name)
	};
}

export async function statsOf(site: ServeDo): Promise<ServeStats> {
	const res = await site.fetch(new Request('https://do.local/__serve-stats'));
	return (await res.json()) as ServeStats;
}

/** a stored page, inserted as data rather than rendered; the row IS the page cache */
export function seedPage(site: ServeDo, path: string, html: string, renderMs = 120) {
	site.ensureServeTables();
	site.sql.exec(
		`INSERT INTO cfw_page (path, status, content_type, html, rendered_at, render_ms)
		 VALUES (?, 200, 'text/html; charset=utf-8', ?, ?, ?)
		 ON CONFLICT(path) DO UPDATE SET html = excluded.html, render_ms = excluded.render_ms`,
		path,
		html,
		Date.now(),
		renderMs
	);
}

/**
 * Queues a path the way the module does: the row, then the object's own `armFillAlarm()`.
 *
 * Arming through the module rather than calling `setAlarm()` here matters -- an earlier
 * draft inserted the row only, nothing woke the chain, and three assertions passed for the wrong
 * reason because the polling request rendered the page inline instead.
 *
 * `arm: false` is for the specs where something OTHER than the alarm is the driver under test: an
 * alarm chain racing a warm window fills the paths the window was supposed to fill, and the
 * window's bound assertions then read an already-empty queue.
 */
export function queuePath(site: ServeDo, path: string, { arm = true }: { arm?: boolean } = {}) {
	site.ensureServeTables();
	site.sql.exec(
		'INSERT INTO cfw_fill_queue (path, queued_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING',
		path,
		Date.now()
	);
	if (arm) site.armFillAlarm();
}

/** `Date.now()` cannot be advanced here, so a render that must be timeable awaits a real tick */
export const tick = (ms = 2) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the alarm handler until the object reports the chain settled.
 *
 * Replaces the original suite's `waitForHit()`, which polled `/serve` for up to 20 s. Here the
 * handler is invoked directly, so a chain that took seconds of wall clock takes milliseconds.
 *
 * The loop asks the OBJECT whether it is settled rather than trusting the return value, because
 * `runDurableObjectAlarm()` answers false in two different situations: nothing was scheduled, and
 * the runtime already fired what was scheduled. An alarm armed at +1 ms routinely lands before
 * the next line of a spec does, so "false" cannot be read as "nothing happened".
 *
 * @returns how many firings this driver performed itself
 */
export async function driveAlarms(
	stub: DurableObjectStub,
	settled: (site: ServeDo) => boolean | Promise<boolean>,
	tries = 25
): Promise<number> {
	let firings = 0;
	for (let i = 0; i < tries; i++) {
		if (await inObject(stub, settled)) return firings;
		if (await runDurableObjectAlarm(stub)) firings++;
		else await tick(5);
	}
	return firings;
}
