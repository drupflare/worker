import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINT, e2eGate } from './helpers/endpoint';
import {
	assemble,
	exportDb,
	firstRun,
	firstRunState,
	invalidate,
	migrate,
	newSiteName,
	ops,
	prefill,
	provision,
	serve,
	stats,
	transportFor,
	type ServeStats,
	type Transport
} from './helpers/lifecycle';
import { firstDifference, maskNonces } from './helpers/twice';

/**
 * ONE Drupal lifecycle, driven end to end against a running worker: provision, migrate, prefill,
 * render, configure, invalidate, export, teardown.
 *
 * The gap this closes: every other lane asserts one stage in isolation, and nothing had ever driven
 * install -> setup -> use -> teardown as a single flow, so no assertion existed about the ORDER --
 * which is where this stack's defects live. Two found by writing this file:
 *
 *   - migration finishing on its own ALARM chain leaves the site with NO prefilled pages, because
 *     the prefill block lives in the `/__migrate` route handler (src/site-do.ts:3557) and an alarm
 *     never reaches a route. So the self-driving path -- the default, and the only one a deployed
 *     site takes -- ends with `/` answering 503 while every route-driven test sees a HIT.
 *   - `/ops?op=status` reports `migrated` off the in-memory flag (src/site-do.ts:3001), which
 *     hibernation discards, while the migrate route right below it documents that the CURSOR is the
 *     answer. A site migrated by the alarm chain reports `migrated: false` forever.
 *
 * A RENDER ALONE PROVES ALMOST NOTHING, so no stage here asserts only bytes. A cache hit and a
 * cache miss produce identical output -- measured: a live wasm render of `/` is byte-for-byte the
 * packed prefill artifact, 17,686 bytes and sha1 9e0ffe64f622 -- so each stage also asserts row
 * counts, statement counts, the cursor state, or whether the interpreter booted.
 *
 * The stages run in declaration order and share one site, because a lifecycle IS the order. An
 * early failure therefore cascades; read the first failure, not the last.
 *
 *   bun run test:e2e:lifecycle          # boots its own worker on a scratch persist dir
 *   bun run dev && bun run test:e2e     # or against a worker you already have
 */

const skip = await e2eGate();

/**
 * The packed front page, read from the artifact rather than from a previous render.
 *
 * `assets/prefill.json` is what CI rendered with NATIVE php, keyed by path. Reading it here is what
 * lets step 5 compare a live render against the artifact directly instead of against a digest that
 * two per-site nonces make unreachable.
 */
async function packedHome(): Promise<string> {
	const { readFile } = await import('node:fs/promises');
	const { fileURLToPath } = await import('node:url');
	const here = fileURLToPath(import.meta.url);
	const root = here.slice(0, here.indexOf('/tests/e2e/'));
	const raw = await readFile(`${root}/assets/prefill.json`, 'utf8');
	const packed = JSON.parse(raw) as Record<string, { html: string }>;
	const home = packed['/']?.html;
	if (typeof home !== 'string') throw new Error('assets/prefill.json has no "/" entry');
	return home;
}

/** the front page, as the packed `assets/prefill.json` holds it and as a live render reproduces it */
const HOME_SHA1 = '9e0ffe64f622cd30ac04c81b1fa8083472955843';
const HOME_BYTES = 17686;

/** the site name the pack ships with; firstrun is what changes it, and it changes the bytes too */
const PACK_SITE_NAME = 'CFW Bench';

const site = newSiteName('lifecycle');
let t: Transport;
/** carried between stages, because a lifecycle assertion is usually a comparison across two of them */
const seen: { provisioned?: ServeStats } = {};

beforeAll(() => {
	t = transportFor(ENDPOINT, site);
});

describe.skipIf(skip)(`the Drupal lifecycle at ${ENDPOINT} (site ${site})`, () => {
	it('1. provisions an empty site whose cursor is null rather than zero', async () => {
		const s = await provision(t);
		seen.provisioned = s;
		// null and a zero cursor are DIFFERENT states: `src/site-do.ts` reads null as "never started
		// a migration" and a zero cursor as "half migrated", and a half-migrated site refuses to
		// serve. Conflating them would take every pre-chunked-engine deploy offline
		expect(s.migrate).toBeNull();
		expect(s.cached).toEqual([]);
		expect(s.queue).toEqual([]);
		// addressing a fresh object must not cost a ~4 s synchronous interpreter boot
		expect(s.phpBooted).toBe(false);
		expect(s.serveRequests).toBe(0);
	});

	it('2. migrates to completion with no interpreter and no PHP statement', async () => {
		const { last, cursor } = await migrate(t);
		expect(last.done).toBe(true);
		expect(cursor?.state).toBe('done');
		// the cursor is what a hibernated object answers from; the reply is not
		expect(cursor?.chunk).toBe(cursor?.chunks);
		expect(Number(cursor?.chunks)).toBeGreaterThan(1);
		// pack-dependent, so a floor rather than an equality -- but a floor an empty replay fails
		expect(Number(cursor?.statements)).toBeGreaterThan(1000);
		expect(Number(cursor?.rowsWritten)).toBeGreaterThan(4000);
		// the whole reason the JS chunked engine exists: replaying the pack enters no interpreter
		expect(last.queryCount).toBe(0);
		expect((await stats(t)).phpBooted).toBe(false);
	});

	it('3. seeds the serving table from the packed pages, idempotently', async () => {
		const out = await prefill(t);
		// force=1 gets past the route's short-circuit; the migrator still refuses to replay, so this
		// is a repair rather than a second migration
		expect(out.skipped).toBe('already migrated');
		expect(out.done).toBe(true);
		expect(Number(out.prefilled)).toBeGreaterThan(0);
		expect(out.prefilledPaths).toContain('/');
		const s = await stats(t);
		expect(s.cached.map((r) => r.path)).toContain('/');
		// setup must not bump the generation: replaying the pack writes the packed cachetags rows,
		// and treating that as a content change would invalidate the pages it just published
		expect(s.generation).toBe(seen.provisioned?.generation ?? 1);
	});

	it('4. serves the front page from storage with zero interpreter, at the pinned bytes', async () => {
		const r = await serve(t, '/');
		expect(r.status).toBe(200);
		expect(r.cache).toBe('HIT');
		expect(r.lane).toBe('storage');
		// the assertion the byte count alone cannot make: nothing rendered this
		expect(r.phpBooted).toBe('0');
		expect(r.byteLength).toBe(HOME_BYTES);
		expect(r.sha1).toBe(HOME_SHA1);
		expect(r.body).toContain(`<title>Welcome! | ${PACK_SITE_NAME}</title>`);
		expect(r.body).toContain('</html>');
	});

	it('4b. reports stored length in CHARACTERS, which is not the byte count', async () => {
		const r = await serve(t, '/');
		const row = (await stats(t)).cached.find((c) => c.path === '/');
		// `SELECT length(html)` counts characters, and the front page carries four U+2019, so the
		// row reads 17,678 against 17,686 bytes on the wire. An assertion equating the two is wrong
		// by the number of multi-byte characters, which is why this is pinned rather than left to a
		// later reader to rediscover
		expect(row?.bytes).toBe(r.charLength);
		expect(r.charLength).toBeLessThan(r.byteLength);
	});

	it('5. renders the front page for real, reproducing the packed bytes but for two per-site nonces', async () => {
		const out = await assemble(t, '/');
		expect(out.filled).toBe('/');
		// the four fields that separate a render from a cache hit
		expect(out.phpBooted).toBe(true);
		expect(out.pageCache).toBe('MISS');
		expect(out.dynamicCache).toBe('MISS');
		expect(out.hostStatements).toBeGreaterThan(0);
		expect(out.rowsWritten).toBeGreaterThan(0);

		const r = await serve(t, '/');
		expect(r.status).toBe(200);
		// the length is exact: both nonces are fixed width, so a length change is real content
		expect(r.byteLength).toBe(HOME_BYTES);

		// and the document matches the artifact rendered by NATIVE php in CI
		// (scripts/drupal/prefill-cache.php) once the per-site nonces are masked. Two different
		// PHP builds, identical output.
		const packed = await packedHome();
		const masked = maskNonces({ first: r.body, second: packed });
		expect(firstDifference(masked.first, masked.second)).toBeNull();

		// the packed artifact is still pinned by digest, so a change to the PACK is still caught;
		// what is no longer asserted is that a live render can reproduce it
		expect(createHash('sha1').update(Buffer.from(packed, 'utf8')).digest('hex')).toBe(
			HOME_SHA1
		);
	});

	it('6. routes a second path to its own render rather than re-serving the first', async () => {
		const login = await assemble(t, '/user/login');
		expect(login.filled).toBe('/user/login');
		expect(login.phpBooted).toBe(true);
		const home = await serve(t, '/');
		const other = await serve(t, '/user/login');
		expect(other.status).toBe(200);
		// PageCache memoizes its cid on the middleware instance, and the interpreter persists between
		// requests, so a persistent kernel once mapped six different URLs onto the first request's
		// page and returned byte-identical output for all of them
		expect(other.sha1).not.toBe(home.sha1);
		expect(other.byteLength).not.toBe(home.byteLength);
		expect(other.body).toContain('</html>');
	});

	it('7. configures the site on first run, and the new name reaches the rendered page', async () => {
		expect((await firstRunState(t)).configured).toBe(false);
		const before = (await stats(t)).generation;
		const applied = await firstRun(t, {
			siteName: 'Lifecycle E2E',
			adminMail: 'admin@example.invalid',
			adminPass: `pw-${Math.random().toString(36).slice(2, 12)}`,
			timezone: 'UTC'
		});
		expect(applied.ok).toBe(true);
		expect(applied.applied as string[]).toContain('system.site.name');
		expect(applied.applied as string[]).toContain('uid1.pass');

		const s = await stats(t);
		// config changed, so every cached page is stale: the generation MUST move or the edge keeps
		// serving the old site name
		expect(s.generation).toBeGreaterThan(before);
		expect((await firstRunState(t)).configured).toBe(true);

		const r = await serve(t, '/');
		expect(r.status).toBe(200);
		// the end-to-end proof: a config write reached Drupal, invalidated the page and re-rendered
		expect(r.body).toContain('<title>Welcome! | Lifecycle E2E</title>');
		// and therefore is no longer the packed artifact
		expect(r.sha1).not.toBe(HOME_SHA1);
	});

	it('7b. refuses a second first run, and refuses a password in a query string', async () => {
		const second = await firstRun(t, { siteName: 'Should Not Apply' });
		expect(second.ok).toBe(false);
		expect(second.error).toBe('already configured');
		const res = await t('/firstrun?pass=hunter2');
		expect(res.status).toBe(400);
		const body = (await res.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toContain('query string');
	});

	it('8. invalidates through Drupal, with nothing bumping the generation directly', async () => {
		const out = await invalidate(t, 'rendered');
		expect(out.ok).toBe(true);
		// the whole automatic seam: Drupal wrote `cachetags`, the host saw the write cross execSql()
		// and bumped. Nothing in the request path called bumpGeneration()
		expect(out.generationAfter).toBe(out.generationBefore + 1);
	});

	it('9. exports itself as replayable SQL, because a site that cannot leave is not a product', async () => {
		const out = await exportDb(t);
		expect(out.ok).toBe(true);
		expect(out.statements).toBeGreaterThan(1000);
		expect(out.bytes).toBeGreaterThan(1_000_000);
		// the tables a Drupal site cannot be without; a truncated dump would still report ok
		expect(Object.keys(out.tables)).toContain('router');
		expect(Object.keys(out.tables)).toContain('users_field_data');
	});

	it('10. answers the operations surface, and refuses what it cannot slice', async () => {
		const registry = await ops(t);
		expect(registry.ok).toBe(true);
		expect(registry.count).toBe(8);

		const status = await ops(t, 'status');
		expect(status.ok).toBe(true);

		// `en` -- install a module -- is DECLARED and refused. 501 with the driver named, because a
		// refusal without an alternative just gets retried. Nothing in this repo can enable a module
		// through Drupal's installer; see the report accompanying this file
		const refused = await t('/ops?op=en');
		expect(refused.status).toBe(501);
		const body = (await refused.json()) as { ok: boolean; driver: string; cost: string };
		expect(body.ok).toBe(false);
		expect(body.driver).toContain('Workflow');
		expect(body.cost).toContain('1,344.7 ms');

		// fails closed: an unknown name must read as writing and sliced, never as a read
		const unknown = await t('/ops?op=not-a-command');
		expect(unknown.status).toBe(404);
		const failsClosed = (await unknown.json()) as {
			treatedAs: { writes: boolean; sliced: boolean };
		};
		expect(failsClosed.treatedAs).toEqual({ writes: true, sliced: true });
	});

	it('11. tears down to a site that shares nothing with the one just used', async () => {
		// the durable half of teardown: `?site=<name>` is `idFromName(name)`, so a run that reused a
		// name would inherit the previous run's cursor, page rows and generation, and every cold-path
		// assertion above would pass for the wrong reason. The persist directory is the other half
		// and belongs to the runner, not to a spec
		const fresh = transportFor(ENDPOINT, newSiteName('lifecycle-teardown'));
		const s = await provision(fresh);
		expect(s.migrate).toBeNull();
		expect(s.cached).toEqual([]);
		expect(s.serveRequests).toBe(0);
		// and the site under test is still where stage 8 left it
		expect((await stats(t)).migrate?.state).toBe('done');
	});
});

describe.skipIf(skip)('the lifecycle gate itself', () => {
	it('is only running because a worker answered', async () => {
		expect(skip).toBe(false);
	});
});
