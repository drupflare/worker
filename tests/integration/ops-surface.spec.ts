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
 * so it works in this lane; the sliced operations themselves are not run by anything here, which is
 * the whole point.
 */

const OPS = 'https://do.local/__ops';

/** the registry read needs `assets/driver.json` mounted, which `inObject` boots for us */
async function registry(stub: DurableObjectStub) {
	const res = await stub.fetch(OPS);
	return { status: res.status, body: (await res.json()) as Record<string, never> };
}

describe('the surface lists what the registry declares', () => {
	it('reports all eight operations with their four fields', async () => {
		const stub = freshSite();
		const { status, body } = await registry(stub);
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.count).toBe(8);
		const ops = body.operations as unknown as Record<
			string,
			{ label: string; writes: boolean; sliced: boolean; cost: string | null }
		>;
		for (const [name, op] of Object.entries(ops)) {
			expect(Object.keys(op).sort(), name).toEqual(['cost', 'label', 'sliced', 'writes']);
		}
	});

	it('carries the fail-closed pair, so an unknown name reads as writing AND sliced', async () => {
		// this is the registry's own safety property and the surface depends on it: a caller that
		// forgets has() must not be able to expose a mutation as a read
		const stub = freshSite();
		const { body } = await registry(stub);
		expect(body.failsClosed).toEqual({ writes: true, sliced: true });
	});

	it('names `status` as the only read-only unsliced operation', async () => {
		const stub = freshSite();
		const { body } = await registry(stub);
		expect(body.readOnlyUnsliced).toEqual(['status']);
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
		// seven of eight; if this drops, something was made unsliced without a measurement
		expect(sliced).toHaveLength(7);

		for (const name of sliced) {
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
