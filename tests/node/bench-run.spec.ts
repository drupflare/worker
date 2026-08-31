import { describe, expect, it } from 'vitest';
import { MIN_SAMPLES } from '../../scripts/measure/bench';
import {
	driveSamples,
	objectId,
	parseTaggedCpu,
	readingsFromManifest,
	renderServeReport,
	requestBudget,
	scenarioKey,
	SERVE_SCENARIOS,
	serveReadingFor,
	tagFor,
	warmObject
} from '../../scripts/measure/bench-run';

/**
 * The driving half of the deployed harness.
 *
 * The pure parts are tested here; the deploy and the teardown stay manual and live in
 * `BENCH_RUNBOOK`, because "verify the worker list returned to baseline" is not a step a script
 * should be trusted to have done on an account holding real production workers.
 *
 * The assertions that matter most are the two that encode why the FIRST version of this file could
 * not have produced a valid number: a tag has to be unique per invocation, and a tag the query did
 * not return is not a zero.
 */

const RUN = 'r1';
const scenario = SERVE_SCENARIOS[0]!;
const KEY = scenarioKey(scenario.path);

const fake = (impl: (url: string) => Response) => {
	const urls: string[] = [];
	const fn = (async (input: string | URL) => {
		const url = String(input);
		urls.push(url);
		return impl(url);
	}) as unknown as typeof fetch;
	return { fn, urls };
};

describe('identity, which is what makes a sample a sample', () => {
	it('gives each object a distinct id', () => {
		expect(objectId(RUN, 0)).not.toBe(objectId(RUN, 1));
	});

	/**
	 * ONE TAG PER INVOCATION, and this is the assertion the first version failed.
	 *
	 * `obs-cpu.ts` aggregates with `max` inside a group, so a tag shared by 30 requests reports the
	 * worst of them as though it were the cost. The Worker also caches `/serve` GETs in
	 * `caches.default` keyed by the full URL, so a repeated URL is answered at the edge and the
	 * invocation being measured never happens.
	 */
	it('never reuses a tag within a run', () => {
		const tags = new Set<string>();
		for (const s of SERVE_SCENARIOS) {
			for (let o = 0; o < 6; o++) {
				for (let i = 0; i < 30; i++) {
					tags.add(tagFor(RUN, scenarioKey(s.path), objectId(RUN, o), i));
				}
			}
		}
		expect(tags.size).toBe(180 * SERVE_SCENARIOS.length);
	});

	/**
	 * THE SCENARIO HAS TO BE IN THE TAG, and it was not on the first attempt.
	 *
	 * Both scenarios drove `r1.bench-r1-0.0`, and `obs-cpu.ts` aggregates a group with `max` -- so
	 * the front page and the login form would have been pooled and the dearer of the two reported as
	 * the cost of each. Caught by driving it, not by reading it.
	 */
	it('separates scenarios, so two paths cannot be pooled into one group', () => {
		const [a, b] = SERVE_SCENARIOS;
		expect(scenarioKey(a!.path)).not.toBe(scenarioKey(b!.path));
		expect(tagFor(RUN, scenarioKey(a!.path), 'o', 0)).not.toBe(
			tagFor(RUN, scenarioKey(b!.path), 'o', 0)
		);
	});

	it('reduces a path to something a query parameter carries intact', () => {
		expect(scenarioKey('/')).toBe('root');
		expect(scenarioKey('/user/login')).toBe('user-login');
		expect(scenarioKey('/node')).toBe('node');
	});

	it('keeps runs apart, so a re-run cannot join onto the previous one', () => {
		expect(tagFor('r1', 'k', 'o', 0)).not.toBe(tagFor('r2', 'k', 'o', 0));
	});
});

describe('driving one object', () => {
	/**
	 * `/serve` RATHER THAN `/`, and it is a correctness property rather than a shortcut.
	 *
	 * The visitor path resolves the site from the hostname with `allowParam: false`, so `?site=` on
	 * `/` is ignored by design -- every "object" in the run would have been the same object.
	 */
	it('addresses the public /serve route, carrying site, path and tag', async () => {
		const { fn, urls } = fake(() => new Response('ok'));
		const out = await driveSamples('https://x.dev', 'site-1', scenario, RUN, 4, fn);
		expect(out.requests).toBe(4);
		expect(out.tags).toHaveLength(4);
		expect(urls).toHaveLength(4);
		for (const u of urls) {
			expect(new URL(u).pathname).toBe('/serve');
			expect(u).toContain('site=site-1');
		}
		expect(new Set(urls).size).toBe(4);
	});

	/**
	 * WITHOUT `edge=0` THE OBJECT IS NEVER REACHED, measured on the deployed worker.
	 *
	 * The Worker's cache key is synthetic and carries no query, so a second request with a fresh tag
	 * came back `x-cfw-cache: EDGE` and the invocation being measured did not happen. A unique tag
	 * separates the samples; only this bypasses the tier above them.
	 */
	it('bypasses the Worker edge cache, or there is no invocation to measure', async () => {
		const { fn, urls } = fake(() => new Response('ok'));
		await driveSamples('https://x.dev', 's', scenario, RUN, 2, fn);
		for (const u of urls) expect(new URL(u).searchParams.get('edge')).toBe('0');
	});

	it('passes the scenario path through as ?path=, not as the pathname', async () => {
		const { fn, urls } = fake(() => new Response('ok'));
		await driveSamples('https://x.dev', 's', SERVE_SCENARIOS[1]!, RUN, 1, fn);
		expect(new URL(urls[0]!).searchParams.get('path')).toBe('/user/login');
	});

	it('counts a non-ok response as a failure and does not tag it as a sample', async () => {
		const { fn } = fake((url) => new Response('no', { status: url.includes('x') ? 503 : 200 }));
		const out = await driveSamples('https://x.dev', 's', scenario, RUN, 3, fn);
		expect(out.failures).toBe(3);
		expect(out.tags, 'a 503 warming response is not a measurement').toHaveLength(0);
		expect(out.statuses).toEqual([503, 503, 503]);
	});

	it('counts a thrown request as a failure instead of aborting the run', async () => {
		let calls = 0;
		const fn = (async () => {
			calls++;
			throw new Error('socket');
		}) as unknown as typeof fetch;
		const out = await driveSamples('https://x.dev', 's', scenario, RUN, 3, fn);
		expect(calls).toBe(3);
		expect(out.failures).toBe(3);
	});
});

describe('warming an object before measuring it', () => {
	const noSleep = async () => {};

	it('stops as soon as the object serves a 200', async () => {
		let n = 0;
		const fn = (async () =>
			new Response('ok', { status: ++n < 3 ? 503 : 200 })) as unknown as typeof fetch;
		const out = await warmObject(
			'https://x.dev',
			's',
			'/',
			{ attempts: 20, delayMs: 0, sleep: noSleep },
			fn
		);
		expect(out).toEqual({ ok: true, attempts: 3, lastStatus: 200 });
	});

	it('reports failure rather than letting a warming object be measured', async () => {
		const fn = (async () =>
			new Response('warming', { status: 503 })) as unknown as typeof fetch;
		const out = await warmObject(
			'https://x.dev',
			's',
			'/',
			{ attempts: 4, delayMs: 0, sleep: noSleep },
			fn
		);
		expect(out.ok).toBe(false);
		expect(out.lastStatus).toBe(503);
	});

	it('sends no tag, so a warm-up cannot be mistaken for a sample', async () => {
		const { fn, urls } = fake(() => new Response('ok'));
		await warmObject(
			'https://x.dev',
			's',
			'/',
			{ attempts: 1, delayMs: 0, sleep: noSleep },
			fn
		);
		expect(urls[0]).not.toContain('tag=');
	});
});

describe('turning driven tags into a reading', () => {
	const objects = Array.from({ length: MIN_SAMPLES + 1 }, (_, i) => objectId(RUN, i));

	const drivenFor = (n: number) => {
		const driven = new Map<string, readonly string[]>();
		for (const o of objects) {
			driven.set(
				o,
				Array.from({ length: n }, (_, i) => tagFor(RUN, KEY, o, i))
			);
		}
		return driven;
	};

	const cpuFor = (driven: ReadonlyMap<string, readonly string[]>, per: (o: string) => number) => {
		const cpu = new Map<string, number>();
		for (const [o, tags] of driven) for (const t of tags) cpu.set(t, per(o));
		return cpu;
	};

	it('pools every ingested invocation into the overall summary', () => {
		const driven = drivenFor(10);
		const r = serveReadingFor(
			scenario,
			driven,
			cpuFor(driven, () => 3)
		);
		expect(r.overall?.n).toBe(60);
		expect(r.overall?.median).toBe(3);
		expect(r.notIngested).toBe(0);
	});

	it('summarises each object separately, because the objects are the population that varies', () => {
		const driven = drivenFor(10);
		const cpu = cpuFor(driven, (o) => 1 + objects.indexOf(o));
		const r = serveReadingFor(scenario, driven, cpu);
		expect(r.perObject).toHaveLength(objects.length);
		expect(r.perObject.map((p) => p.summary.median)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(r.dispersion).toBeCloseTo(6, 6);
	});

	it('refuses an object that did not clear the floor on its own', () => {
		const driven = new Map<string, readonly string[]>([
			['a', [tagFor(RUN, KEY, 'a', 0), tagFor(RUN, KEY, 'a', 1)]]
		]);
		const r = serveReadingFor(
			scenario,
			driven,
			cpuFor(driven, () => 5)
		);
		expect(r.perObject, 'n=2 is below the floor').toHaveLength(0);
		expect(r.overall, 'and the pool is only 2 as well').toBeNull();
	});

	/**
	 * A MISSING TAG IS NOT A ZERO.
	 *
	 * Ingest lags ~4 minutes. Defaulting an absent tag to zero would read a query fired too early as
	 * a suspiciously cheap page, which is exactly the shape of wrong answer this harness refuses.
	 */
	it('drops a tag the query did not return and counts it as not-ingested', () => {
		const driven = drivenFor(10);
		const cpu = cpuFor(driven, () => 4);
		cpu.delete(tagFor(RUN, KEY, objects[0]!, 0));
		cpu.delete(tagFor(RUN, KEY, objects[0]!, 1));
		const r = serveReadingFor(scenario, driven, cpu);
		expect(r.notIngested).toBe(2);
		expect(r.overall?.n).toBe(58);
		expect(r.overall?.median, 'a dropped tag must not pull the median toward zero').toBe(4);
	});

	it('falls to unresolved rather than averaging what is left', () => {
		const driven = drivenFor(10);
		const r = serveReadingFor(scenario, driven, new Map<string, number>());
		expect(r.overall).toBeNull();
		expect(r.notIngested).toBe(60);
		expect(renderServeReport([r])).toContain('**unresolved**');
	});
});

describe('the report', () => {
	it('never emits a median without its n and spread', () => {
		const driven = new Map<string, readonly string[]>([
			['o1', Array.from({ length: 6 }, (_, i) => tagFor(RUN, KEY, 'o1', i))]
		]);
		const cpu = new Map<string, number>();
		for (const [i, t] of [...(driven.get('o1') as string[])].entries()) cpu.set(t, i + 1);
		const out = renderServeReport([serveReadingFor(scenario, driven, cpu)]);
		expect(out).toContain('| n | min | median | max | spread |');
		expect(out).toContain('**3.50 ms**');
		expect(out).toContain('1.00 ms');
		expect(out).toContain('6.00 ms');
	});

	it('states the emptied bins for every row, and says HIT when none were', () => {
		const out = renderServeReport(
			SERVE_SCENARIOS.map((s) => serveReadingFor(s, new Map(), new Map()))
		);
		for (const _ of SERVE_SCENARIOS) expect(out).toContain('none (cache HIT)');
	});
});

describe('joining the query back to what was driven', () => {
	it('parses the tag/cpuMs TSV obs-cpu prints, ignoring its comments', () => {
		const cpu = parseTaggedCpu('# no groups\na.b.c.0\t1.5\na.b.c.1\t2\n\nbroken-line\n');
		expect([...cpu.entries()]).toEqual([
			['a.b.c.0', 1.5],
			['a.b.c.1', 2]
		]);
	});

	/**
	 * The manifest is read rather than recomputed.
	 *
	 * A report that regenerates the tags it expects cannot tell "this request was never driven"
	 * from "it was driven and has not been ingested"; the first is a hole in the run and the second
	 * is a hole in the query, and they need different answers.
	 */
	it('reads the driven tags from the manifest, so a never-driven tag is not a missing one', () => {
		const manifest = {
			run: RUN,
			base: 'https://x.dev',
			startedAt: 1,
			endedAt: 2,
			scenarios: [
				{
					...scenario,
					driven: { o1: [tagFor(RUN, KEY, 'o1', 0), tagFor(RUN, KEY, 'o1', 1)] }
				}
			]
		};
		const cpu = new Map([[tagFor(RUN, KEY, 'o1', 0), 3]]);
		const [reading] = readingsFromManifest(manifest, cpu);
		expect(reading!.notIngested, 'one driven tag, absent from the query').toBe(1);
		expect(reading!.scenario.path).toBe(scenario.path);
	});
});

describe('pricing the run before it spends anything', () => {
	it('counts every measured request and every warm-up separately', () => {
		const budget = requestBudget([scenario], 3);
		expect(budget.measured).toBe(scenario.samples * 3);
		expect(budget.warmups).toBe(3);
	});

	it('prices the shipped default plan, which spends a real account quota', () => {
		const budget = requestBudget(SERVE_SCENARIOS, MIN_SAMPLES + 1);
		expect(budget.measured).toBe(360);
	});

	/**
	 * The serving path has no `bins` parameter, so every scenario here is a cache HIT.
	 *
	 * `[]` is legal and must be written; a non-empty list would be describing `/assemble`, which is
	 * a different route with a different gate.
	 */
	it('claims no emptied bin, because /__serve has no way to empty one', () => {
		for (const s of SERVE_SCENARIOS) expect(s.bins).toEqual([]);
		for (const s of SERVE_SCENARIOS) expect(s.samples).toBeGreaterThanOrEqual(MIN_SAMPLES);
	});
});
