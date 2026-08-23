import { describe, expect, it } from 'vitest';
import { DEFAULT_MIX, envelope, FREE_QUOTAS } from '../../scripts/measure/free-envelope';
import {
	batchableShare,
	CROSSING_NAMES,
	rpcMigrationCost,
	type CrossingTally
} from '../../src/ops/crossings';
import { freshSite, inObject, queuePath, type ServeDo } from '../helpers/serve-do';

/**
 * How many times one render crosses from PHP into the host, and which capability it crosses for.
 *
 * P36. The docs say an RPC method call on a Durable Object stub is its own RPC session and is
 * BILLED AS A DO REQUEST. This project reaches the object through `stub.fetch()`, so one request is
 * one billed request today -- but the bridge INSIDE the object had never been counted, and that
 * number has to exist before any RPC migration, or the migration converts a free inner call into a
 * charged one without anybody noticing.
 *
 * A CROSSING IS NOT A DO REQUEST TODAY. `cfwSqlExec` and friends are wasm imports resolving to
 * JavaScript in the same isolate. This measures a refactor risk, not a live meter, and the numbers
 * below should be read that way.
 *
 * The measurement is real: it drives a full render on the shipping interpreter, so it needs the
 * pack and lives in `ARTIFACT_SPECS`.
 */

type Stats = {
	crossings: CrossingTally | null;
	crossingsTotal: number;
	crossingCapabilities: string[];
};

async function renderAndCount(): Promise<{ cold: Stats; warm: Stats }> {
	// `freshSite()`, NOT `provisionedSite()`: the latter stamps the migration cursor `done` without
	// replaying anything, so `/__migrate` skips and the render aborts with "the site is not
	// installed yet" -- 8 crossings of a render that never happened
	return inObject(freshSite(), async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		// `/__fill` rather than `/__serve`, and the difference is the measurement: an anonymous GET
		// on a COLD object refuses to boot inline on the free profile, so `/__serve` would return a
		// MISS having never entered PHP and the tally would be empty for the wrong reason
		queuePath(site, '/', { arm: false });
		await site.fetch(new Request('https://do.local/__fill'));
		const cold = (await (
			await site.fetch(new Request('https://do.local/__serve-stats'))
		).json()) as Stats;
		// a SECOND fill on the same object, so the pair separates the once-per-object boot from
		// what a render actually crosses for. Reporting only the first would charge the kernel
		// build to every render
		queuePath(site, '/user/login', { arm: false });
		await site.fetch(new Request('https://do.local/__fill'));
		const warm = (await (
			await site.fetch(new Request('https://do.local/__serve-stats'))
		).json()) as Stats;
		return { cold, warm };
	});
}

describe('the PHP-to-host bridge, counted', () => {
	it('wraps every capability the host installed, so a 0 means "not called"', async () => {
		const { cold } = await renderAndCount();
		// the boolean `cfwCanSuspend` must NOT be here: wrapping it would hand PHP a callable
		// where the service provider expects a flag, which reads true and installs a handler
		// that cannot work on this build
		expect(cold.crossingCapabilities).not.toContain('cfwCanSuspend');
		expect(cold.crossingCapabilities).toEqual([...CROSSING_NAMES]);
	}, 900_000);

	it('crosses for the DATABASE and for nothing else at all', async () => {
		const { cold, warm } = await renderAndCount();
		// MEASURED, n=1 per arm on ONE object so the pair is comparable: a cold first fill of
		// `/` crossed 233 times and a warm second fill of `/user/login` crossed 48, every one
		// of them `cfwSqlExec`. Asserted as bounds rather than as equalities, because the
		// counts move with the pack while the SHAPE is the finding
		expect(Object.keys(cold.crossings!.byName)).toEqual(['cfwSqlExec']);
		expect(Object.keys(warm.crossings!.byName)).toEqual(['cfwSqlExec']);
		// boot dominates the first fill, which is why reporting only it would be wrong
		expect(cold.crossings!.total).toBeGreaterThan(warm.crossings!.total * 2);
		expect(warm.crossings!.total).toBeLessThan(150);
	}, 900_000);

	it('has NOTHING a batching change could coalesce, which retires the idea', async () => {
		const { warm } = await renderAndCount();
		const share = batchableShare(warm.crossings!);
		// every crossing is `cfwSqlExec`, and Drupal's read path is read-decide-read: the next
		// statement's text depends on the previous reply. The write half already has its
		// batched form -- `cfwSqlTxn`, which the buffered TransactionManager replays through --
		// and it reads 0 here because a page RENDER opens no transaction, which is correct
		// rather than a defect. So the coalescing lever this item asked about does not exist
		expect(share.batchable).toBe(0);
		expect(share.fraction).toBe(0);
	}, 900_000);

	it('sizes the RPC exposure, and the one-for-one billing behind it is MEASURED', async () => {
		const { warm } = await renderAndCount();
		const cost = rpcMigrationCost(warm.crossings!.total);
		// A CROSSING IS NOT A BILLED DO REQUEST TODAY, and an RPC call WOULD BE. Both halves
		// were measured on a deployed worker rather than read off the docs: 7 RPC method calls
		// billed 7 requests, 11 `stub.fetch()` calls billed 11, and 13 loops INSIDE one
		// invocation billed 1. `Host::call()` is the third shape
		expect(cost.measured).toBe(true);
		expect(cost.today).toBe(3);

		// so the guard is real: re-expressing the bridge as RPC would put the DO meter ahead of
		// rows as the binding one for regeneration
		const today = envelope(DEFAULT_MIX, { windowed: true });
		const overRpc = FREE_QUOTAS.doRequestsPerDay / cost.overRpc;
		expect(today.regenerationBoundBy).toBe('rows');
		expect(overRpc).toBeLessThan(today.regenerationsPerDay);
	}, 900_000);

	it('leaves 48 SQL calls per warm render as an optimisation target in its own right', async () => {
		const { warm } = await renderAndCount();
		// THE QUESTION THE CROSSING COUNT ACTUALLY OPENS, and it is not about RPC: why does a
		// warm render need this many statements at all? Batching is dead (`batchableShare` is
		// 0) and that closes ONE mechanism; it does not close "reduce the SQL a render does",
		// which is a different lever with its own instruments -- `rowsRead` per statement,
		// repeated identical queries, and Drupal cache misses
		expect(warm.crossings!.byName.cfwSqlExec).toBeGreaterThan(0);
		// a bound rather than a target: this fails if a change makes a warm render markedly
		// chattier, which is the regression worth catching while the lever is unexplored
		expect(warm.crossings!.byName.cfwSqlExec).toBeLessThan(150);
	}, 900_000);
});
