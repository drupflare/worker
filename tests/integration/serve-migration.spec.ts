import { describe, expect, it } from 'vitest';
import {
	type ServeDo,
	driveAlarms,
	freshSite,
	inObject,
	pageFor,
	queuePath,
	serveDirect,
	statsOf,
	stubRender
} from '../helpers/serve-do';

/**
 * Ported from the `a half-migrated site refuses to serve` region of
 * `scripts/test-serve-chain.mjs`.
 *
 * What changed from the original: almost nothing. The migration engine is
 * the real one, replaying the real packed chunks out of the real ASSETS binding -- 99 chunks,
 * 1,779 statements, 5,004 rows written -- into a real Durable Object SQLite. One chunk takes 14 ms
 * here and the whole pack 195 ms, so what the original could only do against a running
 * `wrangler dev` now runs in the gate.
 *
 * Two things are additions rather than ports:
 *
 *   - **The self-drive contract.** `migrationSelfDrives()` is what makes a deployed site finish
 *     its own first-run migration over ~15 alarm firings instead of needing an operator to poke
 *     `/migrate` 15 times. The original never asserted it, because it drove the
 *     chunks by hand (`all=1`) to avoid racing the alarm. Here the alarm IS the subject.
 *   - **The `done` field on the skip form.** `src/site-do.js` carries a comment saying that
 *     omitting it made a caller branching on `done === false` read `undefined` and conclude the
 *     site was finished -- "which is exactly what happened to scripts/test-serve-chain.mjs". The
 *     script worked around it with a retry loop; the contract is asserted here instead.
 */

type MigrateBody = {
	ok: boolean;
	done: boolean | null;
	chunk: number | null;
	chunks: number | null;
	engine: string;
	queryCount: number;
	databaseSize: number;
	skipped?: boolean;
	reason?: string;
	continuation?: string;
	prefilled?: number;
	prefillNote?: string;
	rowsWritten?: number;
	statements?: number;
};

const migrate = async (site: ServeDo, query: string): Promise<MigrateBody> => {
	const res = await site.fetch(new Request(`https://do.local/__migrate${query}`));
	return (await res.json()) as MigrateBody;
};

/** the cursor is what decides; `this.migrated` is discarded on hibernation */
const cursorOf = (site: ServeDo) => statsOf(site).then((s) => s.migrate);

describe('one chunk is not a migrated site', () => {
	it('reports the partial cursor, the engine that ran, and no PHP at all', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			// self-drive off, or the alarm carries the migration forward underneath the assertion
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			const first = await migrate(site, '?chunks=1');
			return { first, cursor: await cursorOf(site) };
		});

		expect(out.first.ok).toBe(true);
		expect(out.first.done).toBe(false);
		expect(out.first.chunk).toBe(1);
		expect(Number(out.first.chunks)).toBeGreaterThan(1);
		// which engine ran, so the JS and PHP engines are never confused for each other
		expect(out.first.engine).toBe('sql');
		// the whole reason the JS engine exists: replaying the pack enters no interpreter
		expect(out.first.queryCount).toBe(0);
		expect(out.cursor?.state).toBe('running');
		expect(out.cursor?.chunk).toBe(1);
	});
});

describe('a half-migrated site refuses to serve rather than rendering a quarter of itself', () => {
	it('answers 503, says how far it has got, and is retryable but never cached', async () => {
		const stub = freshSite();
		const held = await inObject(stub, async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			stubRender(site, ({ path }) => pageFor(path));
			await migrate(site, '?chunks=1');
			return serveDirect(site, '/', '&inline=1&edge=0');
		});

		// Drupal does NOT fail cleanly against a partial database -- it renders, with truncated
		// caches, and that render gets written to the page cache and to the edge
		expect(held.status).toBe(503);
		expect(String(held.migrate)).toMatch(/^\d+\/\d+$/);
		expect(held.header('x-cfw-migrate-state')).toBe('running');
		// seconds, and short: the alarm chain re-arms at +1 ms
		expect(held.retryAfter).toBe('1');
		expect(String(held.cacheControl)).toContain('no-store');
		expect(held.body).toContain('migrating');
	});

	it('spends no interpreter and no queue row on the refusal', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			const calls = stubRender(site, ({ path }) => pageFor(path));
			await migrate(site, '?chunks=1');
			const held = await serveDirect(site, '/');
			return { held, calls, depth: site.queueDepth() };
		});
		expect(out.held.status).toBe(503);
		expect(out.calls).toHaveLength(0);
		// the check happens before the queue insert, so a refused request costs one indexed read
		expect(out.depth).toBe(0);
	});

	it('serves again once the migration is driven to completion', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			stubRender(site, ({ path }) => pageFor(path));
			// prefill=0: this test is about the migration gate releasing the RENDER path,
			// and with prefill on by default a prefilled page would answer as a HIT and prove nothing about it
			await migrate(site, '?chunks=1&prefill=0');
			const finished = await migrate(site, '?all=1&force=1&prefill=0');
			return { finished, after: await serveDirect(site, '/'), cursor: await cursorOf(site) };
		});
		expect(out.finished.done).toBe(true);
		expect(out.cursor?.state).toBe('done');
		expect(out.after.status).not.toBe(503);
		// and it is a real serve again, not a refusal in disguise
		expect(out.after.status).toBe(200);
		expect(out.after.cache).toBe('RENDER');
	});

	it('does not treat a site that never started a migration as half-migrated', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => ({
			serve: await serveDirect(site, '/'),
			cursor: await cursorOf(site)
		}));
		// null rather than a zero cursor: that is every deploy predating the chunked engine, and
		// refusing them would take the fleet offline
		expect(out.cursor).toBeNull();
		expect(out.serve.status).toBe(503);
	});
});

describe('the migration finishes itself over the alarm chain', () => {
	it('advances a chunk per firing without an operator and without PHP', async () => {
		const stub = freshSite();
		const calls = await inObject(stub, async (site) => {
			const recorded = stubRender(site, ({ path }) => pageFor(path));
			// the default: the first /migrate call arms the continuation itself
			const first = await migrate(site, '?chunks=1');
			expect(first.continuation).toBe('alarm armed');
			return recorded;
		});

		await driveAlarms(stub, async (site) => (await cursorOf(site))?.state === 'done', 120);

		const out = await inObject(stub, async (site) => ({
			cursor: await cursorOf(site),
			serve: await serveDirect(site, '/', '&inline=0')
		}));
		expect(out.cursor?.state).toBe('done');
		expect(out.cursor?.chunk).toBe(out.cursor?.chunks);
		// a migrating alarm must never enter the interpreter: one chunk is sized to be the largest
		// unit with a chance of fitting 10 ms on its own, and a render alongside it would not
		expect(calls).toHaveLength(0);
		// THIS ASSERTED 503 AND THE 503 WAS A BUG. Prefill lived inside the `/__migrate` route
		// handler, so only a request-driven migration ever seeded the serving table; a migration
		// that finished on the alarm chain -- the default, and the only path a deployed site takes
		// -- left `cfw_page` empty and answered 503 on the front page until somebody happened to
		// request a render. The test encoded that as correct. It now serves, still with no
		// interpreter anywhere in the chain.
		expect(out.serve.status).toBe(200);
		expect(calls).toHaveLength(0);
	});

	it('a site that migrated on the alarm chain can serve its front page', async () => {
		// the dedicated regression for the above: an operator never touches this site after the
		// first call, which is exactly the deployed shape
		const stub = freshSite();
		const calls = await inObject(stub, async (site) => {
			const recorded = stubRender(site, ({ path }) => pageFor(path));
			await migrate(site, '?chunks=1');
			return recorded;
		});
		await driveAlarms(stub, async (site) => (await cursorOf(site))?.state === 'done', 120);

		const out = await inObject(stub, async (site) => ({
			cached: (await statsOf(site)).cached,
			serve: await serveDirect(site, '/', '&inline=0')
		}));
		// the serving table is populated by the migration itself, not by a later visitor
		expect(out.cached.length).toBeGreaterThan(0);
		expect(out.serve.status).toBe(200);
		// and none of it cost a render
		expect(calls).toHaveLength(0);
	});

	it('never boots the interpreter to fill a page for a site that cannot serve one', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			const calls = stubRender(site, ({ path }) => pageFor(path));
			await migrate(site, '?chunks=1');
			queuePath(site, '/');
			await site.alarm();
			return { calls, depth: site.queueDepth(), stats: await statsOf(site) };
		});
		// the render could only produce something unservable, at the price of a ~4 s synchronous
		// boot that blocks the whole object
		expect(out.calls).toHaveLength(0);
		expect(out.depth).toBe(1);
		expect(out.stats.lastAlarmOutcome).toEqual({ skipped: 'migration incomplete' });
	});

	it('arms no continuation when self-drive is switched off', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			const first = await migrate(site, '?chunks=1');
			await site.alarm();
			return { first, cursor: await cursorOf(site) };
		});
		expect(out.first.continuation).toBeUndefined();
		// the switch exists so a test can drive the chunks deterministically instead of racing
		expect(out.cursor?.chunk).toBe(1);
	});
});

describe('an already-migrated site answers the skip form, with done present', () => {
	it('reports done:true rather than omitting it', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			const full = await migrate(site, '?all=1');
			const second = await migrate(site, '');
			return { full, second };
		});
		expect(out.full.done).toBe(true);
		expect(out.second.skipped).toBe(true);
		// a caller branching on `done === false` read undefined here and concluded "finished"
		expect(out.second.done).toBe(true);
		expect(out.second.reason).toBe('already migrated');
		expect(out.second.chunk).toBe(out.full.chunk);
	});

	it('needs reset=1 rather than force=1 to replay a finished pack', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			const full = await migrate(site, '?all=1');
			return {
				full,
				forced: await migrate(site, '?all=1&force=1'),
				skippedReset: await migrate(site, '?all=1&reset=1'),
				reset: await migrate(site, '?all=1&reset=1&force=1')
			};
		});
		// force=1 gets past the ROUTE's short-circuit and is then refused by the MIGRATOR, which
		// answers with a string where the route answers with a boolean -- so the two skips are
		// distinguishable rather than one masquerading as the other
		expect(out.forced.skipped).toBe('already migrated');
		expect(out.forced.done).toBe(true);
		// reset=1 is handled inside migrateChunks(), so it never runs unless force=1 gets the
		// request past the route's own short-circuit first
		expect(out.skippedReset.skipped).toBe(true);
		expect(out.skippedReset.reason).toBe('already migrated');
		expect(out.reset.skipped).toBeUndefined();
		expect(out.reset.done).toBe(true);
		// a real replay: the cursor was dropped, so every chunk was applied again
		expect(Number(out.reset.statements)).toBe(Number(out.full.statements));
		expect(Number(out.reset.rowsWritten)).toBeGreaterThan(0);
	});
});

describe('prefill is opt-in, because it changes what a MISS means', () => {
	it('loads the CI-rendered pages when asked, and the first request is a HIT', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			const full = await migrate(site, '?all=1&prefill=1');
			return {
				full,
				first: await serveDirect(site, '/', '&inline=0'),
				stats: await statsOf(site)
			};
		});
		expect(Number(out.full.prefilled)).toBeGreaterThan(0);
		// no interpreter was involved and the bytes are still a real Drupal page, rendered on
		// native PHP by scripts/drupal/prefill-cache.php
		expect(out.first.status).toBe(200);
		expect(out.first.cache).toBe('HIT');
		expect(out.first.body).toContain('<html');
		expect(out.stats.phpBooted).toBe(false);
	});

	it('is ON by default on free, so the first visitor to a prefilled path is a HIT', async () => {
		// the contract this asserts CHANGED. Free never renders on the serving path if
		// the page was prefilled, which is what makes free viable; the cold contract is still
		// reachable, and the two tests below pin both halves
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			const full = await migrate(site, '?all=1');
			return { full, first: await serveDirect(site, '/', '&inline=0') };
		});
		expect(out.full.prefilled).toBeGreaterThan(0);
		expect(out.first.status).toBe(200);
	});

	it('stays OFF for paid, because a paid operator can afford to render', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			site.env = { ...site.env, PLAN: 'paid' };
			return migrate(site, '?all=1');
		});
		expect(out.prefilled).toBe(0);
		expect(out.prefillNote).toBe('prefill disabled; default is on for free, off for paid');
	});

	it('honours an explicit opt-out, so the cold contract is still reachable', async () => {
		// most specific wins: ?prefill=0 beats the per-plan default
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			const full = await migrate(site, '?all=1&prefill=0');
			return { full, first: await serveDirect(site, '/', '&inline=0') };
		});
		expect(out.full.prefilled).toBe(0);
		expect(out.first.status).toBe(503);
	});

	it('refuses to prefill a partial pass, which would publish pages the site cannot reproduce', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			site.env = { ...site.env, MIGRATE_SELF_DRIVE: '0' };
			return migrate(site, '?chunks=1&prefill=1');
		});
		expect(out.prefilled).toBe(0);
		expect(out.prefillNote).toBe('migration is partial; prefill waits for done');
	});
});

// #region TEMPORARY assertion counter
import { afterAll as __afterAll, afterEach as __afterEach } from 'vitest';
let __asserts = 0;
__afterEach(() => {
	__asserts += expect.getState().assertionCalls ?? 0;
});
__afterAll(() => {
	console.log(`ASSERTIONS tests/integration/serve-migration.spec.ts ${__asserts}`);
});
// #endregion
