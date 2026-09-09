/**
 * Where the page mirror's CDN absorption comes from, and why zero is a MEASUREMENT here.
 *
 *   bun scripts/measure/cdn-absorption.ts [--requests=333333] [--class-b=] [--paths=250]
 *                                         [--generations=4] [--ttl=7200] [--caches=1,10,50]
 *
 * `optimalOffWorker()` in `free-envelope.ts` takes `cdnAbsorption` and defaults it to 0 with the note
 * that it is the one number nobody has measured. Two of the three things behind it turn out to be
 * observable without production traffic, and the third is arithmetic once they are:
 *
 *  1. WHAT THE MIRROR EMITS. Driven here through the shipping `drainPageMirrors()`, so the key and
 *     the response metadata are read rather than assumed.
 *  2. WHAT CLOUDFLARE DOES WITH THAT. Documented and quoted below, including the plan availability
 *     of everything that would change it.
 *  3. THE CEILING those two impose on any traffic pattern, which is what bounds the model.
 *
 * What still needs production traffic is the ACTUAL ratio, and nothing here pretends otherwise:
 * absorption is `1 - classB / hostnameRequests`, both counters live on a deployed zone, and
 * {@link absorptionFromCounters} computes it the moment an operator supplies them.
 */

import { drainPageMirrors, pageMirrorKey, type PageMirrorSql } from '../../src/ops/page-mirror.js';
import { DEFAULT_MIX, optimalOffWorker, type TrafficMix } from './free-envelope.js';

/**
 * Extensions Cloudflare's CDN caches with no rule configured, transcribed from the docs table.
 *
 * "Cloudflare only caches based on file extension and not by MIME type. The Cloudflare CDN does not
 * cache HTML or JSON by default." -- https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
 *
 * `robots.txt` is also cached by default and is not an extension, so it is absent from this set.
 */
export const DEFAULT_CACHED_EXTENSIONS = new Set(
	(
		'7z apk avi avif bin bmp bz2 class css csv dmg doc ' +
		'docx ejs eot eps exe flac gif gz ico iso jar jpeg ' +
		'jpg js mid midi mkv mp3 mp4 ogg otf pdf pict pls ' +
		'png ppt pptx ps rar svg svgz swf tar tif tiff ttf ' +
		'webm webp woff woff2 xls xlsx zip zst'
	)
		.trim()
		.split(' ')
);

/** Seconds Cloudflare caches a 200 for when the origin sends no `cache-control`; from the same page. */
export const DEFAULT_EDGE_TTL_SECONDS = 120 * 60;

/** whether the CDN would consider this key eligible for cache with no Cache Rule in place */
export function keyIsDefaultCacheable(key: string): boolean {
	const leaf = key.slice(key.lastIndexOf('/') + 1);
	const dot = leaf.lastIndexOf('.');
	return dot > 0 && DEFAULT_CACHED_EXTENSIONS.has(leaf.slice(dot + 1).toLowerCase());
}

/** what one drain put in front of the CDN, per object */
export type MirrorEmission = {
	key: string;
	contentType: string;
	/** the `Cache-Control` the origin sends, which is what decides the edge TTL */
	cacheControl: string | null;
	defaultCacheable: boolean;
};

/** the smallest thing `drainPageMirrors()` will talk to, so the shipping drain can be driven here */
function recordingSql(paths: readonly string[]): PageMirrorSql {
	const rows = new Map(paths.map((p, i) => [p, { path: p, generation: 7, attempts: 0, at: i }]));
	return {
		exec(query: string, ...bindings: unknown[]) {
			const q = query.replace(/\s+/g, ' ').trim();
			if (q.startsWith('SELECT path, generation, attempts')) {
				const out = [...rows.values()].sort((a, b) => a.at - b.at);
				return { toArray: () => out as unknown as Record<string, unknown>[] };
			}
			if (q.startsWith('DELETE')) rows.delete(String(bindings[0]));
			return { toArray: () => [] };
		}
	};
}

/**
 * Drives the shipping drain and reads back what it handed R2.
 *
 * Through `drainPageMirrors()` rather than through `pageMirrorKey()` alone, because the key is only
 * half of it: the `httpMetadata` decides the edge TTL, and only the drain sets that.
 */
export async function measureMirrorEmission(
	paths: readonly string[] = ['/', '/about', '/blog/first-post', '/news/']
): Promise<MirrorEmission[]> {
	const seen: MirrorEmission[] = [];
	const bucket = {
		async put(key: string, _body: unknown, opts?: { httpMetadata?: Record<string, unknown> }) {
			const meta = opts?.httpMetadata ?? {};
			seen.push({
				key,
				contentType: String(meta.contentType ?? ''),
				cacheControl: meta.cacheControl === undefined ? null : String(meta.cacheControl),
				defaultCacheable: keyIsDefaultCacheable(key)
			});
		}
	};
	await drainPageMirrors(
		recordingSql(paths),
		bucket as never,
		(path) => ({
			path,
			html: '<!DOCTYPE html><p>x</p>',
			status: 200,
			contentType: 'text/html'
		}),
		{ limit: paths.length, site: 'measure' }
	);
	return seen;
}

export type ObservedAbsorption = {
	absorption: number;
	hostnameRequests: number;
	classBOperations: number;
	/** true when the counters cannot both be right; a bucket cannot serve more reads than requests */
	inconsistent: boolean;
};

/**
 * THE DEFINITION, from the two counters a deployed zone keeps.
 *
 * `hostnameRequests` is the request count for the bucket's custom domain in zone analytics;
 * `classBOperations` is that bucket's Class B count over the SAME window. Anything the CDN answered
 * never became an operation, so the difference is the absorption. Both are per-window and the window
 * has to match, which is the one way to get this arithmetic wrong.
 */
export function absorptionFromCounters(
	hostnameRequests: number,
	classBOperations: number
): ObservedAbsorption {
	const requests = Math.max(0, hostnameRequests);
	const classB = Math.max(0, classBOperations);
	return {
		absorption: requests === 0 ? 0 : Math.max(0, Math.min(1, 1 - classB / requests)),
		hostnameRequests: requests,
		classBOperations: classB,
		inconsistent: classB > requests
	};
}

export type AbsorptionCeiling = {
	absorption: number;
	/** requests that must reach R2 however the traffic is distributed */
	originFetchesPerDay: number;
	/** how long one key is addressable before an invalidation mints a new one */
	keyLifetimeSeconds: number;
	/** re-fetches one cache makes within a key's lifetime because the edge TTL expired first */
	refreshesPerKeyLifetime: number;
};

/**
 * The best absorption a traffic pattern can reach, from the key structure rather than from a guess.
 *
 * Every (key, cache) pair costs at least one origin fetch, and `pageMirrorKey()` puts the GENERATION
 * in the key, so an invalidation replaces the whole key set and every cache pays again. That is the
 * trade the mirror makes on purpose: a bump costs no Class A deletes and no purge calls, and it
 * costs absorption instead.
 *
 * @param independentCaches how many caches must each fetch a key for themselves. ONE with Tiered
 *   Cache on, which is free on every plan and automatic for an R2-backed zone; without it, one per
 *   colo the traffic reaches. It is the operator's number, not a measurement, which is why the CLI
 *   sweeps it rather than picking one.
 */
export function absorptionCeiling(opts: {
	requestsPerDay: number;
	distinctPaths: number;
	generationsPerDay: number;
	edgeTtlSeconds?: number;
	independentCaches: number;
}): AbsorptionCeiling {
	const ttl = Math.max(1, opts.edgeTtlSeconds ?? DEFAULT_EDGE_TTL_SECONDS);
	const generations = Math.max(1, opts.generationsPerDay);
	const keyLifetimeSeconds = 86_400 / generations;
	const refreshesPerKeyLifetime = Math.max(1, Math.ceil(keyLifetimeSeconds / ttl));
	const originFetchesPerDay =
		Math.max(0, opts.distinctPaths) *
		generations *
		Math.max(1, opts.independentCaches) *
		refreshesPerKeyLifetime;
	const requests = Math.max(0, opts.requestsPerDay);
	return {
		absorption:
			requests === 0 ? 0 : Math.max(0, Math.min(1, 1 - originFetchesPerDay / requests)),
		originFetchesPerDay,
		keyLifetimeSeconds,
		refreshesPerKeyLifetime
	};
}

/**
 * The `cdnAbsorption` to hand `envelope()` and `optimalOffWorker()`, and where it came from.
 *
 * Precedence is observed, then the emission, then the ceiling, most-specific-wins the way
 * `envelope()` resolves its own warmth options. Zero is not a placeholder: with the shipping
 * emission it is the answer.
 *
 * COUNTERS BEAT THE INFERENCE, and getting that backwards is the trap. Whether a zone carries a
 * Cache Rule is invisible from here, so a site that HAS one would be told its absorption is zero by
 * a function reading only what the origin sends.
 */
export function absorptionForModel(input: {
	emission: readonly MirrorEmission[];
	observed?: ObservedAbsorption | null;
	ceiling?: AbsorptionCeiling | null;
}): { absorption: number; source: 'observed' | 'ceiling' | 'not-cacheable' } {
	if (input.observed) return { absorption: input.observed.absorption, source: 'observed' };
	// a key the CDN will not consider eligible can never be absorbed, whatever the traffic looks like
	const eligible =
		input.emission.length === 0 ||
		input.emission.some((e) => e.defaultCacheable || e.cacheControl !== null);
	if (!eligible) return { absorption: 0, source: 'not-cacheable' };
	if (input.ceiling) return { absorption: input.ceiling.absorption, source: 'ceiling' };
	return { absorption: 0, source: 'not-cacheable' };
}

if (import.meta.main) {
	const arg = (name: string): string | undefined =>
		process.argv.find((a: string) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
	const num = (name: string, fallback: number): number => Number(arg(name) ?? fallback);

	const requests = num('requests', 333_333);
	const paths = num('paths', 250);
	const generations = num('generations', 4);
	const ttl = num('ttl', DEFAULT_EDGE_TTL_SECONDS);
	const caches = (arg('caches') ?? '1,10,50').split(',').map(Number).filter(Number.isFinite);
	const classB = arg('class-b') === undefined ? null : Number(arg('class-b'));

	const emission = await measureMirrorEmission();
	console.log('=== what the mirror puts in front of the CDN (measured) ===');
	console.log(
		`objects           ${emission.length}, n=${emission.length}, no spread: ` +
			`every one is the same shape`
	);
	for (const e of emission) {
		console.log(
			`  ${e.key}  content-type=${e.contentType}  cache-control=${e.cacheControl ?? 'ABSENT'}` +
				`  default-cacheable=${e.defaultCacheable}`
		);
	}
	console.log(`key from          pageMirrorKey(site, generation, path)`);
	console.log(
		`example unmirrored ${pageMirrorKey('measure', 8, '/never-drained')} (the generation is in the key)`
	);

	const cacheable = emission.filter((e) => e.defaultCacheable).length;
	console.log('\n=== what Cloudflare does with it (documented) ===');
	console.log(
		`default-cached    ${cacheable}/${emission.length}. The CDN caches by EXTENSION and does ` +
			`not cache HTML by default, so a mirrored page answers cf-cache-status: DYNAMIC`
	);
	console.log(
		`default edge TTL  ${DEFAULT_EDGE_TTL_SECONDS} s for a 200 with no cache-control, which is ` +
			`what the drain sends`
	);
	console.log(
		`to change it      a Cache Rule with "Eligible for cache: Yes" on the bucket hostname. ` +
			`Cache Rules are on the free plan (10 of them); so is Tiered Cache with Smart Topology`
	);

	console.log('\n=== the ceiling those impose (derived) ===');
	console.log(
		`inputs            ${requests.toLocaleString()} requests/day, ${paths} distinct paths, ` +
			`${generations} generations/day, ${ttl} s edge TTL`
	);
	const ceilings = caches.map((c) => ({
		caches: c,
		ceiling: absorptionCeiling({
			requestsPerDay: requests,
			distinctPaths: paths,
			generationsPerDay: generations,
			edgeTtlSeconds: ttl,
			independentCaches: c
		})
	}));
	for (const { caches: c, ceiling } of ceilings) {
		console.log(
			`  caches=${String(c).padStart(3)}  ceiling ${(ceiling.absorption * 100).toFixed(1)}%  ` +
				`(${ceiling.originFetchesPerDay.toLocaleString()} origin fetches/day, key lives ` +
				`${Math.round(ceiling.keyLifetimeSeconds)} s, ${ceiling.refreshesPerKeyLifetime} refresh(es))`
		);
	}

	const observed = classB === null ? null : absorptionFromCounters(requests, classB);
	if (observed) {
		console.log('\n=== observed (operator counters) ===');
		console.log(
			`absorption        ${(observed.absorption * 100).toFixed(1)}% from ` +
				`${observed.classBOperations.toLocaleString()} Class B against ` +
				`${observed.hostnameRequests.toLocaleString()} hostname requests` +
				(observed.inconsistent ? '  [INCONSISTENT: more reads than requests]' : '')
		);
	} else {
		console.log('\n=== observed (operator counters) ===');
		console.log(
			`absorption        NOT AVAILABLE. It needs two counters from a deployed zone over the ` +
				`SAME window:\n` +
				`                  - requests for the bucket's custom domain (zone analytics)\n` +
				`                  - that bucket's Class B operation count (R2 metrics)\n` +
				`                  then re-run with --requests=<first> --class-b=<second>`
		);
	}

	const mix: TrafficMix = DEFAULT_MIX;
	console.log('\n=== fed to optimalOffWorker() ===');
	const chosen = absorptionForModel({
		emission,
		observed,
		ceiling: ceilings[0]?.ceiling ?? null
	});
	console.log(`using             ${(chosen.absorption * 100).toFixed(1)}% (${chosen.source})`);
	const arms: Array<[string, number]> = [
		['shipping (no Cache Rule)', 0],
		...ceilings.map(({ caches: c, ceiling }): [string, number] => [
			`ceiling at caches=${c}`,
			ceiling.absorption
		])
	];
	if (observed) arms.push(['observed', observed.absorption]);
	for (const [label, absorption] of arms) {
		const out = optimalOffWorker(mix, { cdnAbsorption: absorption });
		console.log(
			`  ${label.padEnd(26)} share ${(out.share * 100).toFixed(1)}%  ` +
				`${out.viewsPerDay.toLocaleString()} views/day  bound by ${out.boundBy}`
		);
	}
}
