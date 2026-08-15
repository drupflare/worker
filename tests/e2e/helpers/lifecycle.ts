import { createHash } from 'node:crypto';

/**
 * The Drupal lifecycle, as stages, against whatever transport the caller supplies.
 *
 * Transport-agnostic. The
 * stages below are the same whether they are driven over HTTP against `wrangler dev` or over
 * `SELF.fetch()` inside `@cloudflare/vitest-pool-workers` -- and the pool-workers lane was
 * measured to boot the REAL wasm interpreter and complete a REAL Drupal render in 766 ms, which
 * `tests/helpers/serve-do.ts` says is impossible ("There is no wasm interpreter in this lane").
 * That claim is a description of what that harness chooses to do, not a limit. So the driver is
 * written once and bound twice rather than forked.
 *
 * Every stage returns the numbers a caller asserts on rather than a boolean. "It returned 200" is
 * not an assertion about a Drupal lifecycle: a cache hit and a cache miss produce identical bytes,
 * so a stage that cannot report row counts, statement counts and whether the interpreter booted
 * cannot tell the two apart.
 */

/** one request against the site under test; the caller owns the origin and the site name */
export type Transport = (path: string, init?: RequestInit) => Promise<Response>;

/** the `/serve-stats` migration cursor, which is the durable answer to "is this site migrated" */
export type MigrateCursor = {
	generation: string;
	chunk: number;
	chunks: number;
	statements: number;
	rowsWritten: number;
	state: 'running' | 'done' | string;
	error: string | null;
} | null;

export type MigrateReply = {
	ok: boolean;
	done: boolean | null;
	chunk: number | null;
	chunks: number | null;
	engine?: string;
	statements?: number;
	rowsWritten?: number;
	queryCount: number;
	databaseSize: number;
	skipped?: boolean | string;
	prefilled?: number;
	prefilledPaths?: string[];
	prefillNote?: string;
};

export type ServeStats = {
	cached: {
		path: string;
		status: number;
		bytes: number;
		render_ms: number;
		rendered_at: number;
	}[];
	queue: { path: string; attempts: number; last_error: string | null }[];
	migrate: MigrateCursor;
	phpBooted: boolean;
	rowsWritten: number;
	generation: number;
	bumps: number;
	serveRequests: number;
};

export type AssembleReply = {
	filled: string | null;
	bytes?: number;
	renderMs?: number;
	pageCache?: string;
	dynamicCache?: string;
	hostStatements: number;
	rowsWritten: number;
	phpBooted: boolean;
	error?: string;
	failed?: string;
};

/** a `/serve` response, reduced to the fields an assertion reads */
export type ServeProbe = {
	status: number;
	cache: string | null;
	edge: string | null;
	generation: string | null;
	phpBooted: string | null;
	renderMs: string | null;
	lane: string | null;
	retryAfter: string | null;
	body: string;
	/** UTF-8 byte length, which is NOT what `length(html)` in sqlite counts -- see `charLength` */
	byteLength: number;
	/** UTF-16 code-unit length; this is the number `/serve-stats` reports as `bytes` */
	charLength: number;
	sha1: string;
};

/**
 * A site name nothing else has used.
 *
 * The Worker maps `?site=<name>` onto `idFromName(name)`, so a name is a durable identity: reusing
 * one across runs inherits the previous run's migration cursor, its page rows and its generation,
 * and every cold-path assertion then passes or fails for the wrong reason. A fresh name per run is
 * half of teardown; deleting the persist directory is the other half.
 */
export function newSiteName(prefix = 'lc'): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** binds a transport to one origin and one site name */
export function transportFor(endpoint: string, site: string): Transport {
	const base = endpoint.replace(/\/+$/, '');
	return (path, init) => {
		const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
		if (!url.searchParams.has('site')) url.searchParams.set('site', site);
		return fetch(url, { signal: AbortSignal.timeout(120_000), ...init });
	};
}

const json = async <T>(res: Response): Promise<T> => {
	const text = await res.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`not JSON (${res.status}): ${text.slice(0, 300)}`);
	}
};

export const stats = (t: Transport): Promise<ServeStats> =>
	t('/serve-stats').then((r) => json<ServeStats>(r));

/**
 * Stage 1: provision.
 *
 * A site exists as soon as something addresses its object, so "provisioned" means the object
 * answered and holds nothing yet. The cursor being NULL rather than a zero cursor is the assertion
 * that matters: `src/site-do.ts` treats a null cursor as "never started a migration" and a zero
 * cursor as "half migrated", and conflating them would take a whole fleet offline.
 */
export async function provision(t: Transport): Promise<ServeStats> {
	return stats(t);
}

/**
 * Stage 2: migrate to completion.
 *
 * `?all=1` by default, which is a retreat from driving the chunks one at a time.
 * Migration self-drives over its own alarm chain, so the number of `/migrate` calls a run needs is
 * a race with the runtime's alarm scheduling: measured at 1 call on an idle machine and at more
 * than 40 -- chunk 78 of 79 -- with three other workers competing for the same host. A lifecycle
 * run must not fail for that reason, and the chunking contract is already covered exhaustively in
 * the gate lane by `tests/integration/serve-migration.spec.ts`.
 *
 * The poll loop stays anyway: `all=1` returning a PARTIAL pass is a legal answer the route can give
 * (the chunked engine reports `ok: true` with `done: false`), and treating that as migrated would
 * let a render run against a quarter of a database.
 *
 * @returns the last reply and the durable cursor, because the reply alone cannot prove completion:
 *   the route's skip form reports `done: true` for a cursor it never looked at again.
 */
export async function migrate(
	t: Transport,
	{ tries = 60, query = '?all=1' } = {}
): Promise<{ last: MigrateReply; cursor: MigrateCursor; calls: number }> {
	let last: MigrateReply | null = null;
	for (let i = 1; i <= tries; i++) {
		last = await json<MigrateReply>(await t(`/migrate${query}`));
		if (last.done === true) {
			return { last, cursor: (await stats(t)).migrate, calls: i };
		}
		if (last.ok === false) break;
	}
	throw new Error(`migration did not finish in ${tries} calls: ${JSON.stringify(last)}`);
}

/**
 * Stage 3: seed the serving table from the CI-rendered pages.
 *
 * `force=1` is what makes this idempotent rather than a replay: it gets past the route's
 * already-migrated short-circuit, the migrator itself then answers `skipped: 'already migrated'`,
 * and the prefill block still runs because the result is `done`. So a site whose migration
 * finished on the ALARM chain -- which never reaches the route, and therefore never prefills -- can
 * be brought to the state the route would have left it in without re-applying 79 chunks.
 */
export async function prefill(t: Transport): Promise<MigrateReply> {
	return json<MigrateReply>(await t('/migrate?force=1&prefill=1'));
}

/**
 * Stage 4: first-run configuration.
 *
 * POST with a JSON body, never a query string: `/firstrun` REFUSES `?pass=` outright, because the
 * request line is printed by `wrangler tail`, stored by observability and logged by every
 * intermediary, and setting the admin password is this route's entire job.
 */
export async function firstRun(
	t: Transport,
	body: Record<string, string>
): Promise<Record<string, unknown>> {
	return json(
		await t('/firstrun', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	);
}

/** whether first-run configuration has happened, without performing it */
export function firstRunState(t: Transport): Promise<{ configured: boolean; firstRunAt: number }> {
	return t('/firstrun').then((r) => json(r));
}

/**
 * Stage 5: one REAL render, with the interpreter and Drupal both involved.
 *
 * `/assemble` rather than `/serve`, and the difference matters. `/serve` answers from
 * `cfw_page` whenever a row exists, and prefill is ON by default on the free plan, so the front
 * page is a HIT on its first ever request with no PHP at all -- byte-identical to a render. This
 * route deletes the row first and empties the named bins, so a MISS is forced, and it reports
 * `phpBooted`, `hostStatements` and `rowsWritten`, which is what tells a render from a cache hit.
 */
export async function assemble(t: Transport, path = '/', bins = 'page'): Promise<AssembleReply> {
	const q = `?path=${encodeURIComponent(path)}&bins=${encodeURIComponent(bins)}`;
	return json<AssembleReply>(await t(`/assemble${q}`));
}

/** one `/serve` through the front end; `edge=0` keeps `caches.default` out of the answer */
export async function serve(t: Transport, path = '/', query = '&edge=0'): Promise<ServeProbe> {
	const res = await t(`/serve?path=${encodeURIComponent(path)}${query}`);
	const buf = new Uint8Array(await res.arrayBuffer());
	const body = new TextDecoder().decode(buf);
	return {
		status: res.status,
		cache: res.headers.get('x-cfw-cache'),
		edge: res.headers.get('x-cfw-edge'),
		generation: res.headers.get('x-cfw-generation'),
		phpBooted: res.headers.get('x-cfw-php-booted'),
		renderMs: res.headers.get('x-cfw-render-ms'),
		lane: res.headers.get('x-cfw-lane'),
		retryAfter: res.headers.get('retry-after'),
		body,
		byteLength: buf.byteLength,
		charLength: body.length,
		sha1: createHash('sha1').update(buf).digest('hex')
	};
}

/** Stage 6: invalidate through Drupal's own `Cache::invalidateTags()`, not by calling bump */
export async function invalidate(
	t: Transport,
	tags = 'rendered'
): Promise<{ ok: boolean; generationBefore: number; generationAfter: number }> {
	return json(await t(`/invalidate?tags=${encodeURIComponent(tags)}`));
}

/** the whole database as replayable SQL; `body=0` reports the shape without moving megabytes */
export async function exportDb(
	t: Transport
): Promise<{ ok: boolean; statements: number; bytes: number; tables: Record<string, unknown> }> {
	return json(await t('/export'));
}

/** the operations surface: the registry, or one operation by name */
export async function ops(t: Transport, op?: string): Promise<Record<string, unknown>> {
	return json(await t(op ? `/ops?op=${encodeURIComponent(op)}` : '/ops'));
}
