import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * How concurrent authenticated work behaves on one object, which is the workload this host loses.
 *
 * One site is one Durable Object is one thread, and `php._run()` is a single SYNCHRONOUS wasm call,
 * so the isolate is occupied for a whole render and nothing else can be processed meanwhile --
 * `serve-lanes.spec.ts` established that with `x-cfw-gate-active` reading 0 on every raced HIT.
 *
 * Measured idle: one render 31 ms, eight concurrent 193 ms, and the eight finish STAGGERED at
 * roughly 1x..8x the unit cost (slowest/fastest 7.72). That is total serialisation.
 *
 * **OFF BY DEFAULT, BECAUSE A WALL-CLOCK CONCURRENCY READING CANNOT BE A HERMETIC GATE TEST.**
 * Three assertion designs were tried and all three passed alone and failed inside the full gate:
 * on total time, on a separate n=1 baseline whose single sample read 141 ms against 30 ms idle, and
 * on the within-round stagger. The third failed for a reason worth keeping -- under contention the
 * eight requests read fastest 871 ms and slowest 990 ms, finishing TOGETHER after a long shared
 * wait rather than staggered, because the dominant term stops being per-request work. No threshold
 * fixes that; it is what the measurement is made of.
 *
 * So this runs on demand rather than in the gate: `DRUPFLARE_MEASURE=1 bunx vitest run
 * --project=workers tests/integration/authenticated-throughput.spec.ts`, on an idle machine.
 * RULE 0 still reserves absolute CPU figures for `cpuTime` on a deployed worker; this is relative.
 */

const TIMEOUT = 900_000;

/** the gate must stay deterministic, so a timing instrument is opt-in */
const MEASURING = (env as { DRUPFLARE_MEASURE?: string }).DRUPFLARE_MEASURE === '1';

type Round = {
	n: number;
	totalMs: number;
	perRequestMs: number;
	slowestMs: number;
	fastestMs: number;
	/** slowest/fastest WITHIN the round; ~n under serialisation, ~1 under parallelism */
	stagger: number;
};

async function provisioned(): Promise<DurableObjectStub> {
	const stub = freshSite();
	await inObject(stub, async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		const r = await site.fetch(
			new Request('https://do.local/__firstrun', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ adminPass: 'cfw-Conc-5512-pass', siteName: 'Conc' })
			})
		);
		expect(r.status, await r.clone().text()).toBe(200);
		// one warm render so the interpreter is booted and no arm pays the 1,398 ms boot
		await site.fillOne('/user/login');
	});
	return stub;
}

/** fires n requests at ONE object at once and reports how long the round took */
async function round(
	stub: DurableObjectStub,
	n: number,
	make: (i: number) => Request
): Promise<Round> {
	const started = Date.now();
	const times = await Promise.all(
		Array.from({ length: n }, async (_unused, i) => {
			const t0 = Date.now();
			const res = await stub.fetch(make(i));
			// drain the body, or the timing stops before the work does
			await res.arrayBuffer();
			return Date.now() - t0;
		})
	);
	const totalMs = Date.now() - started;
	const slowestMs = Math.max(...times);
	const fastestMs = Math.max(1, Math.min(...times));
	return {
		n,
		totalMs,
		perRequestMs: Math.round(totalMs / n),
		slowestMs,
		fastestMs,
		// WITHIN-ROUND, so machine load cancels: eight serialised requests finish staggered at
		// 1x..8x the unit cost, and eight parallel ones finish together
		stagger: +(slowestMs / fastestMs).toFixed(2)
	};
}

describe.skipIf(!MEASURING)('authenticated concurrency on one object', () => {
	it(
		'serialises renders, and the round grows with N rather than staying flat',
		async () => {
			const stub = await provisioned();
			// FULL renders (both bins), and n=8 rather than n=4. A first pass used `/__assemble`
			// with the page bin only and read 19 ms against 56 ms -- magnitudes where millisecond
			// resolution and the harness's own queueing dominate, and the HIT control scaled 3x
			// alongside it, which said so
			const bins = 'page,dynamic_page_cache';
			const renders: Round[] = [];
			for (const n of [1, 8]) {
				await inObject(stub, (site: ServeDo) => {
					site.sql.exec('DELETE FROM cfw_page');
				});
				renders.push(
					await round(
						stub,
						n,
						(i) =>
							new Request(
								`https://do.local/__assemble?path=/user/login&bins=${bins}&i=${i}`
							)
					)
				);
			}

			// THE CONTROL: cache HITs, which do no PHP work. If these scale with N too, the harness
			// is measuring its own queueing rather than the interpreter's, and it did on the first
			// pass -- so the control decides whether the render reading means anything
			await inObject(stub, (site: ServeDo) => site.fillOne('/user/login'));
			const hits: Round[] = [];
			for (const n of [1, 8]) {
				hits.push(
					await round(
						stub,
						n,
						() => new Request('https://do.local/__serve?path=/user/login&edge=0')
					)
				);
			}

			const many = renders[renders.length - 1] as Round;
			const hitMany = hits[hits.length - 1] as Round;
			console.log(
				`[auth-throughput] ${JSON.stringify({
					renders,
					hits,
					renderStagger: many.stagger,
					hitStagger: hitMany.stagger
				})}`
			);

			// every arm has to have done work; a zero would read as infinite throughput
			for (const r of renders) expect(r.totalMs).toBeGreaterThan(0);
			// THE CLAIM IS READ WITHIN ONE ROUND, because every cross-round form of it was flaky.
			// Eight serialised requests finish staggered at roughly 1x..8x the unit cost, so the
			// slowest is several times the fastest; eight PARALLEL requests all finish together and
			// the ratio collapses toward 1. Machine load scales both ends, so it cancels.
			//
			// Two earlier versions failed inside the full gate and passed alone: one asserted on
			// TOTAL time, and one compared against a separate n=1 round whose single sample took
			// 141 ms under contention against 30 ms idle. A one-sample baseline is not a baseline.
			expect(
				many.stagger,
				'the eight requests finished together, so they did not serialise'
			).toBeGreaterThan(3);
			// and the round is at least as long as its slowest member, which is the same fact
			expect(many.totalMs).toBeGreaterThanOrEqual(many.slowestMs);
			// the HIT lane is cheap per request, which is why anonymous traffic does not queue
			// visibly behind itself; asserted as an ORDER rather than a ratio
			expect(hitMany.perRequestMs).toBeLessThan(many.perRequestMs);
		},
		TIMEOUT
	);
});

/**
 * The round harness, over one small round and with no threshold on the clock.
 *
 * The stagger is a timing and stays off the gate for the reason the docblock above gives. What
 * `round()` DOES is not a timing: it has to fire n requests at one object concurrently, drain every
 * body, and report a round no shorter than its slowest member. A harness that answered n requests
 * with an error page would report a beautifully flat curve, and nothing checked the responses.
 */
describe('the concurrency harness', () => {
	it(
		'fires a whole round at one object and reports a self-consistent shape',
		async () => {
			const stub = await provisioned();
			const answered: number[] = [];
			const out = await round(stub, 2, (i) => {
				answered.push(i);
				return new Request(
					'https://do.local/__assemble?path=/user/login&bins=page,dynamic_page_cache&i=' +
						i
				);
			});

			expect(answered.length).toBe(2);
			expect(out.n).toBe(2);
			// the identity the round is read through; a total shorter than its slowest member would
			// mean a request was not waited for
			expect(out.totalMs).toBeGreaterThanOrEqual(out.slowestMs);
			expect(out.slowestMs).toBeGreaterThanOrEqual(out.fastestMs);
			expect(out.stagger).toBeGreaterThanOrEqual(1);
			expect(Number.isFinite(out.stagger)).toBe(true);

			// and the round's own request shape is served rather than refused, which no timing
			// would have shown
			const res = await stub.fetch(
				new Request(
					'https://do.local/__assemble?path=/user/login&bins=page,dynamic_page_cache&i=0'
				)
			);
			expect(res.status).toBe(200);
			// `/__assemble` answers with the fill's own report rather than the page, so the page is
			// read off `bytes`
			const body = (await res.json()) as { bytes?: number };
			expect(Number(body.bytes ?? 0)).toBeGreaterThan(2000);
		},
		TIMEOUT
	);
});
