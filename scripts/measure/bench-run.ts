/**
 * Drives {@link ../measure/bench.ts} against a DEPLOYED worker, which is the only place RULE 0
 * permits an absolute CPU figure to come from.
 *
 * It drives `/serve`, the real serving path, rather than a bespoke probe route. The theme sweep used
 * a throwaway `/drupal?repeat=` that was torn down with its config, so the next measurement had
 * nothing to reuse.
 *
 * `bun scripts/measure/bench-run.ts --base=https://<worker>.<subdomain>.workers.dev [--dry]`
 *
 * SAFETY. This account holds real production workers. The script never deploys and never deletes:
 * it drives a worker you have already deployed and tells you what to tear down. Deploy and teardown
 * stay manual because {@link BENCH_RUNBOOK} step 7 -- verify the worker list returned to baseline --
 * is not something a script should be trusted to have done.
 *
 * ## Why this drives `/serve` and not `/`
 *
 * The visitor path resolves the site from the HOSTNAME and passes `allowParam: false`, so `?site=`
 * on `/` is ignored -- `customer-a.example/about?site=customer-b` must not serve
 * customer B's database. Every "object" would therefore have been the same object, and a paired
 * measurement across one object is not paired. `/serve` is a PUBLIC route that reads `?site=`, and
 * the only thing skipped by addressing it directly is the hostname lookup, which is Worker CPU and
 * not what `executionModel = durableObject` meters.
 *
 * ## Why this reports a distribution and not a slope
 *
 * `pairedSlope()` is right when N renders happen INSIDE one invocation (`/drupal?repeat=N`): cpuTime
 * then covers all N and the difference over the span cancels the boot. Driving N separate GETs makes
 * N invocations, and `obs-cpu.ts` groups by tag with `max` -- so a 5-vs-100 "slope" would divide the
 * worst single invocation of one arm by 95. The serving path bills PER INVOCATION, so the honest
 * reading is the per-invocation distribution: one unique tag per request, n = samples.
 */

import { MIN_SAMPLES, OBSERVABILITY_INGEST_LAG_MS, summarise, type Summary } from './bench';

/** a path driven on the real serving path, and what its cache state was */
export type ServeScenario = {
	name: string;
	path: string;
	/**
	 * Cache bins emptied before each measured request.
	 *
	 * On this path it is always `[]`, and that is a property of the path rather than a choice:
	 * `/__serve` answers from `cfw_page` or renders inline and has no `bins` parameter to honour.
	 * A scenario here claiming an emptied bin would be describing a route it is not driving.
	 */
	bins: string[];
	/** measured requests per object; each gets its own tag, so this is the per-object n */
	samples: number;
};

/**
 * What gets measured.
 *
 * Both are steady-state cache HITs, which is the unit the serving ceiling is denominated in: RULE 0b
 * puts that ceiling at 100,000 Worker requests/day, and every one of them costs a DO request whether
 * or not PHP runs. What that DO request costs in CPU had never been read off a deployed meter.
 */
export const SERVE_SCENARIOS: ServeScenario[] = [
	{ name: 'front page, cache HIT', path: '/', bins: [], samples: 30 },
	{ name: 'login form, cache HIT', path: '/user/login', bins: [], samples: 30 }
];

/** objects to spread the run across; RULE 0's floor applies per scenario, so this is the object n */
export const DEFAULT_OBJECTS = MIN_SAMPLES + 1;

/**
 * One object's identity in the URL.
 *
 * A distinct `site` gives a distinct Durable Object. Objects differ in marginal cost by 2.8x
 * (measured 2026-08-20), so a figure from one object is a figure about that object.
 */
export function objectId(run: string, index: number): string {
	return `bench-${run}-${index}`;
}

/**
 * The tag that joins one invocation back to what it measured.
 *
 * UNIQUE PER REQUEST, because `obs-cpu.ts` aggregates with `max` within a group: a tag shared by 30
 * requests reports the worst of them and calls it the cost.
 *
 * A unique tag is NOT what gets past the Worker's edge cache. That key is synthetic
 * (`pageKey(origin, ['page', generation, site, path])` in `src/site.ts`) and carries no query at
 * all, so a second request with a fresh tag was still answered `x-cfw-cache: EDGE` -- measured on
 * the deployed worker before the run. {@link EDGE_BYPASS} is what reaches the object.
 */
export function tagFor(run: string, scenario: string, object: string, index: number): string {
	return `${run}.${scenario}.${object}.${index}`;
}

/**
 * A scenario's key in a tag: its path, reduced to something a query parameter can carry.
 *
 * The scenario HAS to be in the tag. Without it both scenarios drove `r1.bench-r1-0.0`, and
 * `obs-cpu.ts` aggregates a group with `max` -- so the front page and the login form would have been
 * pooled and the more expensive one reported as both.
 */
export function scenarioKey(path: string): string {
	const slug = path.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
	return slug === '' ? 'root' : slug;
}

/**
 * The shipped edge-cache bypass, and the reason every URL here carries it.
 *
 * `edgeWanted` in `src/site.ts` is `serving && url.searchParams.get('edge') !== '0'`, so `edge=0`
 * sends the request past `caches.default` to the object. Without it the run measures how well one
 * colo caches, which is a real property and not the one being asked for: what a DO-served cache HIT
 * costs. It is a normal query parameter on a public route, not a diagnostic.
 */
export const EDGE_BYPASS = ['edge', '0'] as const;

export type DriveResult = {
	tags: string[];
	requests: number;
	failures: number;
	statuses: number[];
};

/**
 * Drives one object's samples: `count` sequential GETs, each with its own tag.
 *
 * Sequential rather than concurrent, and that is load-bearing. A Durable Object is single-threaded,
 * so overlapping requests report each other's wall time and have to be discarded as contended.
 * Firing them in parallel would measure the queue.
 */
export async function driveSamples(
	base: string,
	site: string,
	scenario: ServeScenario,
	run: string,
	count: number,
	fetcher: typeof fetch = fetch
): Promise<DriveResult> {
	const tags: string[] = [];
	const statuses: number[] = [];
	let failures = 0;
	const key = scenarioKey(scenario.path);
	for (let i = 0; i < count; i++) {
		const tag = tagFor(run, key, site, i);
		const url = new URL('/serve', base);
		url.searchParams.set('site', site);
		url.searchParams.set('path', scenario.path);
		url.searchParams.set(...EDGE_BYPASS);
		url.searchParams.set('tag', tag);
		try {
			const res = await fetcher(url.toString(), { headers: { 'cache-control': 'no-cache' } });
			statuses.push(res.status);
			if (res.ok) tags.push(tag);
			else failures++;
			// the body has to be drained or the connection is reused mid-response
			await res.text();
		} catch {
			statuses.push(0);
			failures++;
		}
	}
	return { tags, requests: count, failures, statuses };
}

/**
 * Polls one object until it serves a 200, because a fresh object is not measurable.
 *
 * A never-migrated object answers 503 `warming` and arms an alarm; the replay is chunked, so the
 * object serves nothing until the chain drains. These requests are UNTAGGED so the
 * warm-up cannot be mistaken for a sample.
 */
export async function warmObject(
	base: string,
	site: string,
	path: string,
	opts: { attempts: number; delayMs: number; sleep?: (ms: number) => Promise<void> },
	fetcher: typeof fetch = fetch
): Promise<{ ok: boolean; attempts: number; lastStatus: number }> {
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	let lastStatus = 0;
	for (let i = 1; i <= opts.attempts; i++) {
		const url = new URL('/serve', base);
		url.searchParams.set('site', site);
		url.searchParams.set('path', path);
		url.searchParams.set(...EDGE_BYPASS);
		try {
			const res = await fetcher(url.toString(), { headers: { 'cache-control': 'no-cache' } });
			lastStatus = res.status;
			await res.text();
			if (res.ok) return { ok: true, attempts: i, lastStatus };
		} catch {
			lastStatus = 0;
		}
		await sleep(opts.delayMs);
	}
	return { ok: false, attempts: opts.attempts, lastStatus };
}

/** cpuMs keyed by tag, as `obs-cpu.ts` returns it */
export type TaggedCpu = ReadonlyMap<string, number>;

export type ServeReading = {
	scenario: ServeScenario;
	/** every ingested invocation, pooled across objects */
	overall: Summary | null;
	/** one entry per object that cleared the floor on its own */
	perObject: { object: string; summary: Summary }[];
	/** max/min of the per-object medians; large means a single-object figure would mislead */
	dispersion: number | null;
	/** tags that were driven successfully but never came back from the query */
	notIngested: number;
};

/**
 * Turns driven tags into a reading.
 *
 * A tag missing from the query is DROPPED rather than defaulted, because observability ingest lags
 * and an absent tag means "not ingested yet", not "cost zero". Dropping can take a scenario below
 * the floor, which is the correct outcome: `summarise()` then refuses and the report says
 * `unresolved`.
 */
export function serveReadingFor(
	scenario: ServeScenario,
	driven: ReadonlyMap<string, readonly string[]>,
	cpu: TaggedCpu
): ServeReading {
	const pooled: number[] = [];
	const perObject: { object: string; summary: Summary }[] = [];
	let notIngested = 0;

	for (const [object, tags] of driven) {
		const values: number[] = [];
		for (const tag of tags) {
			const v = cpu.get(tag);
			if (v === undefined) {
				notIngested++;
				continue;
			}
			values.push(v);
		}
		pooled.push(...values);
		const summary = summarise(values);
		if (summary) perObject.push({ object, summary });
	}

	const medians = perObject.map((p) => p.summary.median).filter((v) => v > 0);
	const dispersion =
		medians.length >= MIN_SAMPLES ? Math.max(...medians) / Math.min(...medians) : null;

	return { scenario, overall: summarise(pooled), perObject, dispersion, notIngested };
}

const ms = (v: number) => `${v.toFixed(2)} ms`;

/**
 * The markdown report, and there is no code path here that emits a bare number.
 *
 * A scenario below {@link MIN_SAMPLES} renders as a refusal naming what it had, because "we could
 * not resolve it" is information and a median of three is not.
 */
export function renderServeReport(readings: readonly ServeReading[]): string {
	const lines = [
		'# Deployed measurement: per-invocation serving cost',
		'',
		`\`cpuTime\` from a deployed worker, \`executionModel = durableObject\`, one tag per invocation, n >= ${MIN_SAMPLES}.`,
		'',
		'| scenario | path | bins emptied | n | min | median | max | spread |',
		'| --- | --- | --- | --- | --- | --- | --- | --- |'
	];

	for (const r of readings) {
		const bins = r.scenario.bins.length > 0 ? r.scenario.bins.join(', ') : 'none (cache HIT)';
		if (!r.overall) {
			lines.push(
				`| ${r.scenario.name} | \`${r.scenario.path}\` | ${bins} | too few | - | **unresolved** | - | - |`
			);
			continue;
		}
		const s = r.overall;
		lines.push(
			`| ${r.scenario.name} | \`${r.scenario.path}\` | ${bins} | ${s.n} | ${ms(s.min)} | **${ms(s.median)}** | ${ms(s.max)} | ${ms(s.spread)} |`
		);
	}

	for (const r of readings) {
		if (r.perObject.length === 0) continue;
		lines.push('', `## ${r.scenario.name}, per object`, '');
		lines.push('| object | n | min | median | max |', '| --- | --- | --- | --- | --- |');
		for (const p of r.perObject) {
			lines.push(
				`| \`${p.object}\` | ${p.summary.n} | ${ms(p.summary.min)} | ${ms(p.summary.median)} | ${ms(p.summary.max)} |`
			);
		}
		if (r.dispersion !== null) {
			lines.push(
				'',
				`Objects disagree by **${r.dispersion.toFixed(2)}x** in median cost. RULE 0's bimodality is ` +
					'a per-object property, so a figure from one object is a figure about that object.'
			);
		}
	}

	const missing = readings.reduce((n, r) => n + r.notIngested, 0);
	if (missing > 0) {
		lines.push(
			'',
			`${missing} driven tags were absent from the query and were dropped rather than counted as ` +
				`zero. Ingest lags about ${OBSERVABILITY_INGEST_LAG_MS / 60_000} minutes.`
		);
	}

	return lines.join('\n');
}

/** how many requests a full run costs, so the quota spend is known BEFORE it is spent */
export function requestBudget(
	scenarios: readonly ServeScenario[],
	objects: number
): { measured: number; warmups: number; objects: number } {
	const perObject = scenarios.reduce((n, s) => n + s.samples, 0);
	return { measured: perObject * objects, warmups: objects, objects };
}

/** `tag<TAB>cpuMs`, which is what `obs-cpu.ts` prints */
export function parseTaggedCpu(tsv: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const line of tsv.split('\n')) {
		if (line.trim() === '' || line.startsWith('#')) continue;
		const [tag, value] = line.split('\t');
		const n = Number(value);
		if (!tag || !Number.isFinite(n)) continue;
		out.set(tag, n);
	}
	return out;
}

export type Manifest = {
	run: string;
	base: string;
	startedAt: number;
	endedAt: number;
	scenarios: (ServeScenario & { driven: Record<string, string[]> })[];
};

/** joins a manifest to a query result, so the report names the tags that were actually driven */
export function readingsFromManifest(manifest: Manifest, cpu: TaggedCpu): ServeReading[] {
	return manifest.scenarios.map((s) =>
		serveReadingFor(
			{ name: s.name, path: s.path, bins: s.bins, samples: s.samples },
			new Map(Object.entries(s.driven)),
			cpu
		)
	);
}

async function main(): Promise<void> {
	const args: string[] = process.argv.slice(2);
	const flag = (name: string) =>
		args.find((a: string) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

	const reportFrom = flag('report');
	if (reportFrom !== undefined) {
		const tsvPath = flag('tsv');
		if (tsvPath === undefined) throw new Error('--report needs --tsv=<obs-cpu output>');
		const manifest = JSON.parse(await Bun.file(reportFrom).text()) as Manifest;
		const cpu = parseTaggedCpu(await Bun.file(tsvPath).text());
		console.log(renderServeReport(readingsFromManifest(manifest, cpu)));
		return;
	}

	const scenarios = SERVE_SCENARIOS;
	const objects = Number(flag('objects') ?? DEFAULT_OBJECTS);
	const budget = requestBudget(scenarios, objects);

	const base = flag('base');
	if (args.includes('--dry') || base === undefined) {
		console.log(`scenarios   ${scenarios.length}`);
		console.log(`objects     ${objects} (floor is ${MIN_SAMPLES})`);
		console.log(`measured    ${budget.measured} tagged requests`);
		console.log(`warm-ups    ${budget.warmups} objects polled untagged first`);
		console.log(`ingest wait ${OBSERVABILITY_INGEST_LAG_MS / 1000}s before querying`);
		console.log('');
		for (const s of scenarios) {
			const bins = s.bins.length > 0 ? s.bins.join(', ') : 'none (cache HIT)';
			console.log(`  ${s.name.padEnd(26)} ${s.path.padEnd(14)} n=${s.samples} bins: ${bins}`);
		}
		if (base === undefined) console.log('\nno --base given, so nothing was driven');
		return;
	}

	const run = flag('run') ?? 'r1';
	const ids = Array.from({ length: objects }, (_, i) => objectId(run, i));
	const warmAttempts = Number(flag('warm-attempts') ?? 90);
	const warmDelayMs = Number(flag('warm-delay') ?? 2000);

	const startedAt = Date.now();
	console.error(`warming ${ids.length} objects against ${base}`);
	for (const site of ids) {
		const w = await warmObject(base, site, '/', {
			attempts: warmAttempts,
			delayMs: warmDelayMs
		});
		console.error(
			`  ${site}: ${w.ok ? 'ready' : 'NOT READY'} after ${w.attempts} (last ${w.lastStatus})`
		);
		if (!w.ok)
			throw new Error(`${site} never served a 200; measuring it would measure warming`);
	}

	const driven = new Map<string, Map<string, readonly string[]>>();
	for (const scenario of scenarios) {
		const perObject = new Map<string, readonly string[]>();
		for (const site of ids) {
			// one untagged priming request, so the FIRST tagged sample is a hit like the rest
			await warmObject(base, site, scenario.path, {
				attempts: warmAttempts,
				delayMs: warmDelayMs
			});
			const out = await driveSamples(base, site, scenario, run, scenario.samples);
			perObject.set(site, out.tags);
			console.error(
				`  ${scenario.path} ${site}: ${out.tags.length} ok, ${out.failures} failed`
			);
		}
		driven.set(scenario.name, perObject);
	}

	const manifest = flag('manifest');
	if (manifest !== undefined) {
		// the tags are written down rather than recomputed later: a report that regenerates the tags
		// it expects cannot tell "never driven" from "driven and not ingested"
		await Bun.write(
			manifest,
			JSON.stringify(
				{
					run,
					base,
					startedAt,
					endedAt: Date.now(),
					scenarios: scenarios.map((s) => ({
						...s,
						driven: Object.fromEntries(driven.get(s.name) ?? new Map())
					}))
				},
				null,
				2
			)
		);
		console.error(`manifest ${manifest}`);
	}

	console.error(
		`driven. wait ${OBSERVABILITY_INGEST_LAG_MS / 1000}s for ingest, then:\n` +
			`  bun scripts/measure/obs-cpu.ts --service <worker> --from ${startedAt} --to ${Date.now()}\n` +
			'and pass the tag->cpuMs map to serveReadingFor().'
	);

	// nothing is queried here: the query needs a time window the caller owns, and inventing one is
	// how a run silently reads an empty result as a measurement
	console.log(
		renderServeReport(
			scenarios.map((s) =>
				serveReadingFor(s, driven.get(s.name) ?? new Map(), new Map<string, number>())
			)
		)
	);
}

if (import.meta.main) {
	await main();
}
