import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	type ServeDo,
	driveAlarms,
	freshSite,
	inObject,
	markProvisioned,
	pageFor,
	provisionedSite,
	queuePath,
	seedPage,
	serveDirect,
	statsOf,
	stubRender
} from '../helpers/serve-do';

/**
 * First run: what a site does before it has a database.
 *
 * Two contracts are pinned here and they pull against each other, which is why they share a file:
 *
 *   1. A PAGE REQUEST PROVISIONS. Nothing else can, so this one must.
 *   2. AN ALARM NOBODY ASKED DOES NOT. The first attempt at (1) started a migration on any alarm
 *      with no cursor; measured, that hijacked 37 assertions across 8 files -- the object migrated
 *      and never reached the quarantine check, the HTTP-queue drain or the deferred-POST drain, so
 *      a spec asserting any of those got a migration report instead. The durable marker is what
 *      separates them, and the tests below fail if it is dropped in either direction.
 *
 * Artifact-free: the manifest check and the migrator are both replaced, so this runs on
 * a clean checkout with no packed chunks. What it asserts is the DECISION, which is host logic;
 * whether a real chunk replays is `serve-migration.spec.ts`, which is artifact-gated.
 */

/**
 * The fake the decision tests drive, so no packed chunk is needed to observe a step.
 *
 * `done` stays false in every use: a finished step calls `prefillServingTable()`, which is a real
 * render and belongs to the artifact-gated lane. What is under test here is whether the step is
 * REACHED, which is host logic and needs no database.
 *
 * @returns the calls the migrator received, captured rather than counted on the instance
 */
function stubMigrator(site: ServeDo): number[] {
	const steps: number[] = [];
	site.hasMigrationManifest = async () => true;
	site._migrator = {
		step: async () => {
			steps.push(steps.length + 1);
			return {
				ok: true,
				done: false,
				chunk: steps.length,
				chunks: 9,
				applied: 1,
				statements: 5,
				rowsWritten: 5
			};
		}
	};
	return steps;
}

describe('a site that has never migrated asks to be built', () => {
	it('answers the first-run placeholder rather than a MISS', async () => {
		const stub = freshSite();
		const first = await inObject(stub, (site) => serveDirect(site, '/'));

		expect(first.status).toBe(503);
		expect(first.migrate).toBe('starting');
		expect(first.header('x-cfw-migrate-state')).toBe('queued');
		// distinguishable from the cold-MISS placeholder, which is the confusion that started this
		expect(first.cache).not.toBe('MISS');
		expect(first.cacheControl).toBe('no-store');
		expect(first.retryAfter).toBe('2');
	});

	it('records the request durably, because the alarm that acts is a later invocation', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			const before = site.provisionRequested();
			await serveDirect(site, '/');
			return { before, after: site.provisionRequested() };
		});
		expect(out.before).toBe(false);
		expect(out.after).toBe(true);
	});

	it('survives an eviction, or the request that asked and the alarm that acts never meet', async () => {
		// THE REASON IT IS A ROW AND NOT A FIELD. An in-memory flag is discarded on eviction, and
		// an object evicted between the placeholder and its own alarm would go back to answering
		// the placeholder forever -- the exact bug, reintroduced one layer down
		const stub = freshSite();
		await inObject(stub, (site) => serveDirect(site, '/'));
		await evictDurableObject(stub);
		const after = await inObject(stub, (site) => site.provisionRequested());
		expect(after).toBe(true);
	});

	it('pulls the alarm in to the next tick rather than the keep-warm interval', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			await serveDirect(site, '/');
			return { alarmAt: await site.ctx.storage.getAlarm(), now: Date.now() };
		});
		expect(out.alarmAt).not.toBeNull();
		expect(Number(out.alarmAt) - out.now).toBeLessThan(1000);
	});

	it('asks once, however many visitors arrive', async () => {
		const stub = freshSite();
		const rows = await inObject(stub, async (site) => {
			for (const path of ['/', '/node', '/']) await serveDirect(site, path);
			return site.sql
				.exec(`SELECT COUNT(*) AS n FROM cfw_meta WHERE k = 'provision_requested'`)
				.toArray()
				.map((r) => Number(r.n))[0];
		});
		expect(rows).toBe(1);
	});

	it('renders nothing and queues nothing for a page it has no database for', async () => {
		// the queue is filled by the alarm chain AFTER the database exists; queuing here would
		// spend three strikes on every path a visitor touched during setup and drop them all
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			const calls = stubRender(site, ({ path }) => pageFor(path));
			const first = await serveDirect(site, '/');
			return { first, calls, stats: await statsOf(site) };
		});
		expect(out.first.migrate).toBe('starting');
		// the interpreter is present and still unused: the refusal is the state, not a cold object
		expect(out.calls).toHaveLength(0);
		expect(out.stats.queue).toHaveLength(0);
		expect(out.stats.cached).toHaveLength(0);
	});

	it('gives a browser the auto-refreshing page and everything else the one-word body', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			const plain = await site.fetch(new Request('https://do.local/__serve?path=%2F'));
			const browser = await site.fetch(
				new Request('https://do.local/__serve?path=%2F', {
					headers: { accept: 'text/html,application/xhtml+xml' }
				})
			);
			return { plain: await plain.text(), browser: await browser.text() };
		});
		expect(out.plain).toBe('migrating\n');
		expect(out.browser).toContain('<meta http-equiv="refresh"');
		expect(out.browser).toContain('Setting up');
	});
});

describe('the marker is what separates a provisioning alarm from an ordinary one', () => {
	it('an alarm nobody asked for does not even look for a manifest', async () => {
		// THE 37-TEST REGRESSION, pinned. Without the marker check this fetched the manifest and
		// started replaying chunks on any alarm with no cursor, so every spec whose alarm asserts
		// something else -- quarantine, the HTTP-queue drain, deferred POSTs -- got a migration
		// report instead of its own outcome
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			let checked = 0;
			site.hasMigrationManifest = async () => {
				checked++;
				return true;
			};
			const step = await site.migrateStepIfPending();
			return { checked, step };
		});
		expect(out.checked).toBe(0);
		expect(out.step).toBeNull();
	});

	it('an alarm on a site a visitor asked for does', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			let checked = 0;
			site.hasMigrationManifest = async () => {
				checked++;
				return false;
			};
			await site.requestProvision();
			const step = await site.migrateStepIfPending();
			return { checked, step };
		});
		expect(out.checked).toBe(1);
		// false manifest, so still null -- a deploy that ships no chunks must not throw and stop
		// the chain from re-arming
		expect(out.step).toBeNull();
	});

	it('steps the migration once the marker and a manifest are both there', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			const steps = stubMigrator(site);
			await site.requestProvision();
			return { step: await site.migrateStepIfPending(), steps };
		});
		expect(out.step).not.toBeNull();
		expect(out.step).toHaveProperty('migrate');
		expect(out.steps).toHaveLength(1);
	});

	it('a page request alone is enough to make the alarm chain start building', async () => {
		const stub = freshSite();
		let steps: number[] = [];
		const first = await inObject(stub, (site) => {
			steps = stubMigrator(site);
			return serveDirect(site, '/');
		});
		expect(first.migrate).toBe('starting');
		expect(steps).toHaveLength(0);

		// driven rather than fired once: an alarm armed at +1 ms routinely lands before the next
		// line of a spec does, so `runDurableObjectAlarm()` answering false cannot be read as
		// "nothing happened". See driveAlarms()
		await driveAlarms(stub, () => steps.length > 0, 5);
		expect(steps.length).toBeGreaterThan(0);
	});

	it('stops asking once the cursor is done, so a built site pays nothing for the check', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			let checked = 0;
			site.hasMigrationManifest = async () => {
				checked++;
				return true;
			};
			const serve = await serveDirect(site, '/');
			return { checked, serve, step: await site.migrateStepIfPending() };
		});
		expect(out.serve.cache).toBe('MISS');
		expect(out.serve.migrate).toBeNull();
		expect(out.step).toBeNull();
		expect(out.checked).toBe(0);
	});
});

describe('the fixture the serve specs rely on is not vacuous', () => {
	// CONTROL: if markProvisioned() silently wrote nothing, every ported serve assertion would be
	// reading the first-run placeholder again and this whole file would prove nothing
	it('markProvisioned takes the object out of the never-migrated state', async () => {
		const out = await inObject(freshSite(), (site) => {
			const before = site.neverMigrated();
			markProvisioned(site);
			return { before, after: site.neverMigrated() };
		});
		expect(out.before).toBe(true);
		expect(out.after).toBe(false);
	});

	it('and a provisioned site serves a MISS rather than the first-run placeholder', async () => {
		const cold = await inObject(await provisionedSite(), (site) => serveDirect(site, '/'));
		expect(cold.cache).toBe('MISS');
		expect(cold.body).toContain('warming');
	});
});

describe('a stored page answers even before the site is provisioned', () => {
	it('takes the storage lane, because a page row IS content', async () => {
		// NOT AN OVERSIGHT, and worth pinning: the fast lane checks `migratePartial()` -- a
		// half-finished migration, where the database underneath is actively being rewritten -- and
		// not `neverMigrated()`. A row in `cfw_page` was put there by something that
		// had a database. Reordering the two checks would take `serve-lanes.spec.ts` down with it
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			await serveDirect(site, '/');
			seedPage(site, '/', '<title>restored</title>');
			return serveDirect(site, '/', '&edge=0');
		});
		expect(out.status).toBe(200);
		expect(out.lane).toBe('storage');
		expect(out.body).toContain('restored');
	});

	it('but a half-migrated site refuses even a stored page', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			await serveDirect(site, '/');
			seedPage(site, '/', '<title>mid-restore</title>');
			markProvisioned(site);
			site.sql.exec(`UPDATE cfw_migrate SET state = 'running', chunk = 3, chunks = 9`);
			return serveDirect(site, '/', '&edge=0');
		});
		expect(out.status).toBe(503);
		expect(out.header('x-cfw-migrate-state')).toBe('running');
	});
});

describe('provisioning does not disturb the alarm chain it shares', () => {
	it('an ordinary fill alarm still fills, on a site that asked to be provisioned', async () => {
		// the two live on the same chain, so a provisioning request must not starve the queue
		const stub = await provisionedSite();
		await inObject(stub, async (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			await site.requestProvision();
			queuePath(site, '/a');
		});
		await driveAlarms(stub, (site) => site.queueDepth() === 0);
		const stats = await inObject(stub, (site) => statsOf(site));
		expect(stats.cached.map((r) => r.path)).toEqual(['/a']);
	});
});
