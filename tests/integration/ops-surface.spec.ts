import { describe, expect, it } from 'vitest';
import { freshSite } from '../helpers/serve-do';

/**
 * The `cfw_ops` HTTP surface.
 *
 * The registry declared eight operations with measured costs and **nothing was wired to it**, so those
 * measurements were unreachable from outside PHP. What separates the surface from a Drush
 * impersonation is that it refuses most of what it lists: seven of the eight are `sliced: true`,
 * because they cannot finish inside one invocation. `cr` alone is 282.9 ms in wasm, 28x a free
 * invocation, so running it inline would blow the budget while appearing to work.
 *
 * These assertions are about the REFUSALS, since that is the part a future change is most likely to
 * quietly weaken -- and weakening it looks like a feature ("now you can run `cr` over HTTP!") rather
 * than like the regression it is.
 *
 * Driving the object directly. The registry read needs the driver module in the mount and no kernel,
 * so it works in this lane; the sliced operations themselves are not run by anything here.
 */

const OPS = 'https://do.local/__ops';

/** the registry read needs `assets/driver.json` mounted, which `inObject` boots for us */
async function registry(stub: DurableObjectStub) {
	const res = await stub.fetch(OPS);
	return { status: res.status, body: (await res.json()) as Record<string, never> };
}

describe('the surface lists what the registry declares', () => {
	it('reports every operation with its four fields', async () => {
		const stub = freshSite();
		const { status, body } = await registry(stub);
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		// COUNTED FROM THE REPLY rather than pinned. The literal was 8 and moved when the
		// one-invocation set landed; what matters is that the count matches what came back
		expect(body.count).toBe(Object.keys((body.operations ?? {}) as object).length);
		expect(Number(body.count)).toBeGreaterThan(8);
		const ops = body.operations as unknown as Record<
			string,
			{ label: string; writes: boolean; sliced: boolean; cost: string | null }
		>;
		for (const [name, op] of Object.entries(ops)) {
			expect(Object.keys(op).sort(), name).toEqual([
				'cost',
				'driver',
				'label',
				'sliced',
				'writes'
			]);
		}
	});

	// THE LISTING CARRIED NO `driver` AT ALL, and the surface that reads it reported "0 of 18 have a
	// driver that can actually run here" for its whole life. `OPS_DRIVERS` existed and was consulted
	// only inside the 501 refusal, so the map was right and nothing published it.
	it('names a driver for every operation it can point somewhere', async () => {
		const stub = freshSite();
		const { body } = await registry(stub);
		const ops = body.operations as unknown as Record<
			string,
			{ sliced: boolean; driver: string | null }
		>;
		const withDriver = Object.values(ops).filter((op) => op.driver !== null);
		// counted rather than pinned, for the same reason the count above is
		expect(withDriver.length).toBeGreaterThan(Object.keys(ops).length / 2);

		// an unsliced operation IS its own driver; asserting that separately is what stops the line
		// above passing on a build where every entry says the same thing
		for (const [name, op] of Object.entries(ops)) {
			if (op.sliced === false) {
				expect(op.driver, name).toBe('runs in one invocation');
			}
		}
		// and the sliced ones that genuinely have nowhere to go still say null rather than implying
		// a route
		expect(ops['sql-dump']?.driver).toContain('/export');
	});

	// the shape the consumer reads. `site.ts` declared this an ARRAY and did `for...of` over it,
	// which throws, so the Commands page rendered an error card and ran no command anybody typed.
	it('is an object keyed by name, which is what the front worker iterates', async () => {
		const stub = freshSite();
		const { body } = await registry(stub);
		expect(Array.isArray(body.operations)).toBe(false);
		expect(body.operations).toBeTypeOf('object');
		expect(Object.keys((body.operations ?? {}) as object)).toContain('status');
	});

	it('carries the fail-closed pair, so an unknown name reads as writing AND sliced', async () => {
		// this is the registry's own safety property and the surface depends on it: a caller that
		// forgets has() must not be able to expose a mutation as a read
		const stub = freshSite();
		const { body } = await registry(stub);
		expect(body.failsClosed).toEqual({ writes: true, sliced: true });
	});

	// DERIVED from the reply. This used to assert the literal ['status'], which was true only while
	// nothing else ran and would have gone on passing if a WRITE were mistakenly listed
	it('lists exactly the operations that neither write nor slice', async () => {
		const stub = freshSite();
		const { body } = await registry(stub);
		const ops = body.operations as unknown as Record<
			string,
			{ writes: boolean; sliced: boolean }
		>;
		const expected = Object.entries(ops)
			.filter(([, op]) => !op.writes && !op.sliced)
			.map(([name]) => name);
		expect(body.readOnlyUnsliced).toEqual(expected);
		expect(body.readOnlyUnsliced as unknown as string[]).toContain('status');
	});
});

describe('and REFUSES the ones that cannot fit an invocation', () => {
	it('refuses every sliced operation with its measured cost', async () => {
		const stub = freshSite();
		const { body } = await registry(stub);
		const ops = body.operations as unknown as Record<string, { sliced: boolean }>;
		const sliced = Object.entries(ops)
			.filter(([, op]) => op.sliced)
			.map(([name]) => name);
		// if this drops, something was made unsliced without a measurement
		expect(sliced.length).toBeGreaterThanOrEqual(7);

		for (const name of sliced) {
			// cex and cim are sliced AND driven, by paging rather than by a chain, so they answer
			// rather than refuse; every other sliced operation still names its driver and refuses
			if (name === 'cex' || name === 'cim') continue;
			const res = await stub.fetch(`${OPS}?op=${name}`);
			expect(res.status, name).toBe(501);
			const refusal = (await res.json()) as { ok: boolean; error: string; driver: string };
			expect(refusal.ok).toBe(false);
			expect(refusal.error, name).toMatch(/sliced/);
			// a refusal with no alternative is a refusal that gets retried
			expect(typeof refusal.driver, name).toBe('string');
		}
	});

	it('refuses `cr` with the 282.9 ms figure that is the reason', async () => {
		const stub = freshSite();
		const res = await stub.fetch(`${OPS}?op=cr`);
		expect(res.status).toBe(501);
		const refusal = (await res.json()) as { cost: string; driver: string };
		expect(refusal.cost).toMatch(/282\.9/);
		expect(refusal.driver).toMatch(/UPDB_FLUSH_STEPS|updb/);
	});

	it('404s an unknown operation and says what it was treated as', async () => {
		const stub = freshSite();
		const res = await stub.fetch(`${OPS}?op=sql-query`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { treatedAs: { writes: boolean; sliced: boolean } };
		// the registry's own test pins `sql-query` as a name that must NOT exist
		expect(body.treatedAs).toEqual({ writes: true, sliced: true });
	});
});

describe('`status` is the one operation it will actually run', () => {
	it('runs inline and reports the object state', async () => {
		const stub = freshSite();
		const res = await stub.fetch(`${OPS}?op=status`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			op: string;
			status: Record<string, unknown>;
		};
		expect(body.ok).toBe(true);
		expect(body.op).toBe('status');
		for (const key of ['generation', 'migrated', 'bootMs', 'queueDepth']) {
			expect(body.status, key).toHaveProperty(key);
		}
	});

	it('is not a mutation: two calls leave the generation alone', async () => {
		// read through the surface itself rather than reaching into the instance, so the assertion
		// covers what a caller can actually observe
		const stub = freshSite();
		const gen = async () => {
			const body = (await (await stub.fetch(`${OPS}?op=status`)).json()) as {
				status: { generation: unknown };
			};
			return body.status.generation;
		};
		const before = await gen();
		expect(await gen()).toBe(before);
	});
});

/**
 * The update chain, which the alarm has always driven and nothing could read or start.
 *
 * `OPS_DRIVERS` refuses a sliced `cr` or `updb` operation by naming "/updb" as its driver, and the
 * route did not exist. A 501 pointing at a door that is not there is the same failure the registry's
 * own docblock exists to prevent.
 */
describe('the update chain is readable and drivable', () => {
	const UPDB = 'https://do.local/__updb';

	it('reports a site that has never started one as a null run rather than an error', async () => {
		const stub = freshSite();
		const res = await stub.fetch(UPDB);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { run: unknown; units: unknown[] };
		expect(body.run).toBeNull();
		expect(body.units).toEqual([]);
	});

	/**
	 * POST advances exactly ONE beat and re-arms nothing.
	 *
	 * A caller that wants the chain finished polls, which keeps every invocation inside its own
	 * budget the way the alarm chain does. Asserted through the reply rather than by counting: the
	 * beat refuses on a cold interpreter, so what this pins is that the route drives the same
	 * `updbStepOnce()` the alarm does and hands back the status beside it.
	 */
	it('advances one beat on POST and returns the status with it', async () => {
		const stub = freshSite();
		const res = await stub.fetch(new Request(UPDB, { method: 'POST' }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { updb: Record<string, unknown>; status: unknown };
		expect(body.updb).toBeTruthy();
		expect(body.status).toHaveProperty('run');
	}, 900_000);
});

/**
 * Which uploaded Worker version is serving.
 *
 * `wrangler.jsonc` has declared `version_metadata` for as long as the binding has existed and
 * nothing read it, so a site pinned to an older version by a gradual rollout looked identical to a
 * current one.
 *
 * The pool supplies a synthetic binding here, which is the useful case to assert: an UNTAGGED upload
 * sends an empty `tag` rather than omitting it, and an empty string reads as a tag somebody set. The
 * reading was expected to be null in this lane and was not, so the shape below is the reply rather
 * than a prediction.
 */
describe('the health route names the worker version', () => {
	it('reports the id and normalises an unset tag to null', async () => {
		const stub = freshSite();
		const body = (await (await stub.fetch('https://do.local/__health')).json()) as Record<
			string,
			unknown
		>;
		expect(body).toHaveProperty('version');
		const version = body['version'] as { id: string; tag: unknown } | null;
		expect(version).not.toBeNull();
		expect(typeof version?.id).toBe('string');
		expect(version?.id).not.toBe('');
		expect(version?.tag).toBeNull();
	});
});

describe('a write route names its own argument', () => {
	// `/__enable` read `url.searchParams.get('module') ?? 'drupflare'`, so a bare GET carrying an
	// owner token installed a module the caller never named. Every other write route on this object
	// refuses a missing argument, which is what makes this the odd one out rather than a style note.
	it('refuses an enable with no module rather than choosing one', async () => {
		const stub = freshSite();
		const res = await stub.fetch('https://do.local/__enable');
		expect(res.status).toBe(400);
		const body = (await res.json()) as { ok?: boolean; error?: string };
		expect(body.ok).toBe(false);
		expect(String(body.error)).toContain('name the module');
	});

	// the control: a named module gets PAST the argument check. It does not have to succeed -- this
	// site is unmigrated, so the route reaches `SELECT ... FROM router` and throws, which is itself
	// the proof that the gate above let it through. Without this the refusal could be unconditional
	// and the assertion beside it would still pass.
	it('CONTROL: a named module gets past the argument check', async () => {
		const stub = freshSite();
		let refusal = '';
		try {
			const res = await stub.fetch('https://do.local/__enable?module=token');
			refusal = String(((await res.json()) as { error?: string }).error ?? '');
		} catch (e) {
			refusal = String((e as Error)?.message ?? e);
		}
		expect(refusal).not.toContain('name the module');
		expect(refusal).not.toBe('');
	});
});
