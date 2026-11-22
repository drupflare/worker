/**
 * What spool does to the request meter and the bill on a typical site, by site type.
 *
 *   bun scripts/economics/behavior.ts
 *   bun scripts/economics/behavior.ts --md
 *
 * Spool saves requests when a visitor reads several pages and the device holds some of them. How many
 * pages a visit reads comes from published benchmarks and the project owner's own analytics, each row
 * below with its source and how it was read. The visit and page-popularity models are fitted to those
 * rows and sampled with a fixed seed, so every table here is `derived (modelled)` and repeatable.
 * Request counts per visit come from {@link workerLoad}, the same form `spool.ts` fits to the
 * measured device matrix.
 */
import { FREE_QUOTAS } from '../measure/free-envelope';
import { account, PAID_BASE } from './bill';
import { f, n, pct, r } from './fmt';
import { CACHED_SERVE_TOTAL_MS, SPOOL_DEVICE, SPOOL_REQUESTS } from './measured';
import {
	billWithSpool,
	DECORATION_CPU_MS,
	freeViewsMonth,
	loadOff,
	marginalUsdPerRequest,
	workerLoad,
	type Requests
} from './spool';

// #region sources
/** how a figure was obtained: from a page read in full, from the owner's own analytics, or computed here */
export type Read = 'verified' | 'own analytics' | 'measured here';

/** one cited publication or data set */
export interface Source {
	name: string;
	year: string;
	url?: string;
}

/** every publication a figure below cites; a figure may only cite a key of this table */
export const SOURCES = {
	oho2023: {
		name: 'Oho, 2023 Google Analytics benchmarks for higher education websites, data 1 Jan to 1 Dec 2022',
		year: '2022',
		url: 'https://www.oho.com/blog/2023-google-analytics-benchmarks-higher-education-websites'
	},
	oho2022: {
		name: 'Oho, 2022 Google Analytics benchmarks for higher education websites, data 1 Jan to 1 Dec 2021',
		year: '2021',
		url: 'https://www.oho.com/blog/2022-google-analytics-benchmarks-higher-education-websites'
	},
	oho2018: {
		name: 'Oho, 2018 Google Analytics benchmarks for higher education, college and university websites, data 2017',
		year: '2017',
		url: 'https://www.oho.com/blog/2018-google-analytics-benchmarks-higher-education-college-and-university-websites'
	},
	wikipediaBrowse: {
		name: 'Piccardi, Gerlach, Arora and West, how readers browse Wikipedia, English Wikipedia, 1 to 28 March 2021',
		year: '2021',
		url: 'https://arxiv.org/html/2112.11848'
	},
	wikipediaRabbit: {
		name: 'Piccardi, Gerlach and West, going down the rabbit hole, English Wikipedia, March 2021',
		year: '2021',
		url: 'https://arxiv.org/html/2203.06932'
	},
	wikimediaTopics: {
		name: 'Wikimedia Research, how we read Wikipedia and reader navigation',
		year: 'not printed',
		url: 'https://meta.wikimedia.org/wiki/Research:How_we_read_Wikipedia_and_reader_navigation'
	},
	smartocto: {
		name: 'smartocto, metrics that matter in 2025, 343,167 articles from 231 brands, March to May 2025',
		year: '2025',
		url: 'https://smartocto.com/blog/metrics-that-matter-in-2025-useful-editorial-analytics-benchmarks/'
	},
	contentsquare: {
		name: 'Contentsquare, 2023 digital experience benchmark explorer, 2,942 websites',
		year: '2022',
		url: 'https://go.contentsquare.com/en/2023-digital-experience-benchmark-explorer'
	},
	hubspot: {
		name: 'HubSpot, 2025 web trends report, survey of 336 U.S. SEOs and marketers, self-reported',
		year: '2025',
		url: 'https://blog.hubspot.com/website/web-traffic-analytics-report'
	},
	chartbeat: {
		name: 'Chartbeat, increase return visits on news sites, more than 300 million first-time visits',
		year: 'not printed',
		url: 'https://chartbeat.com/resources/general/increase-return-visits-news-sites/'
	},
	pew: {
		name: 'Pew Research Center, return visitors on cellphones, Parse.ly corpus of about 71 million users',
		year: '2016',
		url: 'https://www.pewresearch.org/journalism/2016/05/05/5-on-cellphones-return-visitors-spend-more-time-with-articles-than-visitors-overall/markdown'
	},
	tauscher: {
		name: 'Tauscher and Greenberg, how people revisit web pages, CHI 1997, 23 subjects, about six weeks of logs',
		year: '1997',
		url: 'https://chi1997.acm.org/proceedings/paper/sg.html'
	},
	ownVisits: {
		name: "Cloudflare Web Analytics of the project owner's own sites, real browsers with the bot filter on, 30 days to 2026-11-21, sampled",
		year: '2026'
	},
	ownPages: {
		name: "Cloudflare HTML request analytics of the project owner's own sites, 30 days to 2026-11-21, sampled, bots separated by user agent",
		year: '2026'
	},
	sitemaps: {
		name: 'sitemap URL counts of a seeded sample of public US university home pages, CMS read from raw markup, 2026-11-21',
		year: '2026'
	}
} as const satisfies Record<string, Source>;

/** a key of {@link SOURCES} */
export type SourceKey = keyof typeof SOURCES;

/** one input value with where it came from and what it measures */
export interface Figure {
	value: number;
	source: SourceKey;
	read: Read;
	definition: string;
}
// #endregion

// #region archetypes
/** a share of visits that are a rabbit hole, and the mean views of one */
export interface Tail {
	share: Figure;
	mean: Figure;
}

/** one point of views a visit, with the single-page share a source gives for it */
export interface ViewsPoint extends Figure {
	singlePage?: Figure;
	tail?: Tail;
}

/** the behaviour of one kind of site, from figures that were read */
export interface Archetype {
	label: string;
	low: ViewsPoint;
	central: ViewsPoint;
	high: ViewsPoint;
	pages?: Figure;
	topShare?: Figure;
	topTenShare?: Figure;
	returns?: boolean;
}

const own = (value: number, definition: string): Figure => ({
	value,
	source: 'ownVisits',
	read: 'own analytics',
	definition
});

const ownPages = (value: number, definition: string): Figure => ({
	value,
	source: 'ownPages',
	read: 'own analytics',
	definition
});

const published = (
	value: number,
	source: SourceKey,
	definition: string,
	read: Read = 'verified'
): Figure => ({ value, source, read, definition });

const bounce = (value: number, source: SourceKey): Figure =>
	published(
		value,
		source,
		'bounce rate, average; single-page sessions with no interaction, so the single-page share is at least this'
	);

const SAMPLED_LOADS = 'page loads per visit, 30 days, sampled, a mean over visits';

/** the rabbit-hole sessions of English Wikipedia, 0.24% of navigation trees with a mean of 24 pageloads */
const RABBIT_HOLE: Tail = {
	share: published(
		0.0024,
		'wikipediaRabbit',
		'8.97 million of 3.7 billion navigation trees kept as rabbit-hole sessions'
	),
	mean: published(
		24,
		'wikipediaRabbit',
		'pageloads a rabbit-hole session, mean; the median is 18'
	)
};

/** the distinct pages and concentration of the owner's own sites, 30 days, humans by user agent */
export const OWN_SITES = [
	{ label: 'personal development site', pages: 405, top: 0.44, topTen: 0.62 },
	{ label: 'blog', pages: 99, top: 0.14, topTen: 0.36 },
	{ label: 'marketing and documentation zone', pages: 1045, top: 0.19, topTen: 0.26 },
	{ label: 'small app zone', pages: 77, top: 0.65, topTen: 0.86 }
] as const;

/** the archetypes that have at least one read figure for views a visit */
export const ARCHETYPES: readonly Archetype[] = [
	(() => {
		const point = own(
			400 / 250,
			`${SAMPLED_LOADS}; 400 loads over 250 visits, one personal site root`
		);
		return {
			label: 'personal or portfolio',
			low: point,
			central: point,
			high: point,
			pages: ownPages(405, 'distinct pages with a human view in 30 days, sampled'),
			topShare: ownPages(0.44, 'top page share of human views'),
			topTenShare: ownPages(0.62, 'top ten pages share of human views')
		};
	})(),
	(() => {
		const point = own(
			320 / 320,
			`${SAMPLED_LOADS}; 320 loads over 320 visits across two blog hosts`
		);
		return {
			label: 'blog',
			low: point,
			central: point,
			high: point,
			pages: ownPages(99, 'distinct pages with a human view in 30 days, sampled'),
			topShare: ownPages(0.14, 'top page share of human views'),
			topTenShare: ownPages(0.36, 'top ten pages share of human views')
		};
	})(),
	{
		label: 'documentation',
		low: own(
			50 / 40,
			`${SAMPLED_LOADS}; 50 loads over 40 visits, one project documentation host`
		),
		central: {
			...published(
				1.5,
				'wikipediaBrowse',
				'articles a navigation tree, arithmetic mean, desktop; a reference site, not developer documentation'
			),
			singlePage: published(
				0.73,
				'wikipediaBrowse',
				'share of sessions with one pageload, midpoint of 68% to 78% by aggregation method',
				'measured here'
			),
			tail: RABBIT_HOLE
		},
		high: published(
			4,
			'wikimediaTopics',
			'pageviews a session for the Culture.Arts topic, desktop only, average; the STEM.Technology topic is around 2'
		)
	},
	{
		label: 'marketing or brochure',
		low: own(
			130 / 130,
			`${SAMPLED_LOADS}; 130 loads over 130 visits, a small app's front page`
		),
		central: own(
			280 / 210,
			`${SAMPLED_LOADS}; 280 loads over 210 visits, pooled over two front pages`
		),
		high: own(
			150 / 80,
			`${SAMPLED_LOADS}; 150 loads over 80 visits, a project marketing front page`
		)
	},
	(() => {
		const point = published(
			1.92,
			'smartocto',
			'articles a reading session ("page depth"); the benchmark text says average and the methodology says median',
			'verified'
		);
		return { label: 'news', low: point, central: point, high: point, returns: true };
	})(),
	{
		label: 'higher education',
		low: {
			...published(2.3, 'oho2023', 'pages per session, average, 2022'),
			singlePage: bounce(0.5519, 'oho2023')
		},
		central: {
			...published(2.4, 'oho2022', 'pages per session, average, 2021'),
			singlePage: bounce(0.5569, 'oho2022')
		},
		high: {
			...published(2.74, 'oho2018', 'pages per session, average, 2017'),
			singlePage: bounce(0.51, 'oho2018')
		},
		pages: {
			value: 1116,
			source: 'sitemaps',
			read: 'measured here',
			definition:
				'median sitemap URLs a site, n=115, quartiles 500 and 2,159; 34 of 115 counts are lower bounds'
		}
	},
	{
		label: 'all-sites baseline',
		low: own(
			1760 / 1490,
			`${SAMPLED_LOADS}; 1,760 loads over 1,490 visits pooled over 19 of the owner's hosts, one developer's sites`
		),
		central: published(
			4.6,
			'contentsquare',
			'session depth in pages, all industries, 2,942 sites; mean or median not stated; 161 billion page views over 35 billion sessions agrees'
		),
		high: published(
			7,
			'hubspot',
			'page views a visit, average, a survey of 336 marketers answering from memory, not analytics'
		)
	}
];

/** the archetype labels with no figure that was read, and why */
export const NO_FIGURE: readonly { label: string; reason: string }[] = [
	{
		label: 'nonprofit',
		reason: 'the one source (a benchmark of 130 client sites) could not be read'
	},
	{ label: 'community', reason: 'no source with a pages-per-visit figure could be read' },
	{
		label: 'ecommerce',
		reason: 'the only figures are session lengths in events and session counts, not page views a visit'
	}
];

/** sitemap URL counts of the sampled university sites by CMS, shown where the sample has 5 or more sites */
export const SITE_SIZES = [
	{
		cms: 'WordPress',
		sites: 71,
		lowerBounds: 34,
		q1: 424.5,
		median: 900,
		q3: 1744.5,
		max: 19009
	},
	{ cms: 'Drupal', sites: 43, lowerBounds: 3, q1: 704, median: 1475, q3: 2914, max: 18933 }
] as const;
// #endregion

// #region return visits
/** a return share by pages read on the first visit, from a news benchmark */
export const RETURN_BY_FIRST_VISIT_PAGES: readonly { pages: number; share: Figure }[] = [
	{
		pages: 1,
		share: published(
			0.08,
			'chartbeat',
			'share of new visitors back within 7 days, one page on the first visit'
		)
	},
	{
		pages: 2,
		share: published(
			0.22,
			'chartbeat',
			'share of new visitors back within 7 days, two pages on the first visit'
		)
	},
	{
		pages: 5,
		share: published(
			0.28,
			'chartbeat',
			'share of new visitors back within 7 days, five pages on the first visit'
		)
	}
];

/** return facts read but not used as a number: context for what a return visit is */
export const RETURN_CONTEXT: readonly Figure[] = [
	published(0.14, 'chartbeat', 'benchmark return rate within 7 days, news and media'),
	published(0.03, 'pew', 'short-form readers who returned to a short-form article, cellphones'),
	published(0.04, 'pew', 'long-form readers who returned to a long-form article, cellphones'),
	published(0.81, 'pew', 'of returners to an article, the share who came back the same day'),
	published(0.58, 'tauscher', 'recurrence rate of 1990s browsing, SD 9%; not a modern figure')
];

/** a returning visitor makes one more visit; no source gives returns a returner makes */
export const RETURNS_PER_RETURNER = 1;

/** the chance a visit of `views` pages is followed by a return, interpolated over the three read points; flat past the last */
export function returnProbability(views: number): number {
	const pts = RETURN_BY_FIRST_VISIT_PAGES;
	const first = pts[0]!;
	const last = pts[pts.length - 1]!;
	if (views <= first.pages) return first.share.value;
	if (views >= last.pages) return last.share.value;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1]!;
		const b = pts[i]!;
		if (views === b.pages) return b.share.value;
		if (views < b.pages) {
			const t = (views - a.pages) / (b.pages - a.pages);
			return a.share.value + t * (b.share.value - a.share.value);
		}
	}
	return last.share.value;
}
// #endregion

// #region visit model
/** the shape of one site's visits: a mean, an optional single-page share and an optional rabbit-hole tail */
export interface Shape {
	mean: number;
	singlePage?: number;
	tail?: { share: number; mean: number };
}

/**
 * The probability of a visit of 1, 2, 3 and so on views. A share `singlePage` read one page (a
 * shifted geometric from one when none is given), a rabbit-hole tail has its own mean from two views
 * up, and the rest is a shifted geometric from two whose mean makes the whole match `mean`.
 */
export function visitPmf(shape: Shape): number[] {
	if (shape.mean < 1) throw new Error(`a visit reads at least one page, not ${shape.mean}`);
	if (shape.mean === 1) return [1];
	const p1 = shape.singlePage ?? 1 / shape.mean;
	const tail = shape.tail ?? { share: 0, mean: 2 };
	const body = 1 - p1 - tail.share;
	const bodyMean = (shape.mean - p1 - tail.share * tail.mean) / body;
	if (body <= 0 || bodyMean < 2 || tail.mean < 2) {
		throw new Error(`no visit has ${shape.mean} views a visit and ${p1} single-page visits`);
	}
	const qBody = 1 / (bodyMean - 1);
	const qTail = 1 / (tail.mean - 1);
	const reach = (q: number) => (q >= 1 ? 2 : 2 + Math.ceil(Math.log(1e-14) / Math.log(1 - q)));
	const top = Math.max(reach(qBody), tail.share > 0 ? reach(qTail) : 2);
	const pmf: number[] = [p1];
	for (let v = 2; v <= top; v++) {
		pmf.push(
			body * qBody * (1 - qBody) ** (v - 2) + tail.share * qTail * (1 - qTail) ** (v - 2)
		);
	}
	const sum = pmf.reduce((a, b) => a + b, 0);
	return pmf.map((p) => p / sum);
}

/** the mean of a pmf of visit lengths starting at one view */
export const pmfMean = (pmf: readonly number[]): number =>
	pmf.reduce((a, p, i) => a + p * (i + 1), 0);

/** the shape of a point's visits */
export function shapeOf(point: ViewsPoint): Shape {
	return {
		mean: point.value,
		...(point.singlePage ? { singlePage: point.singlePage.value } : {}),
		...(point.tail
			? { tail: { share: point.tail.share.value, mean: point.tail.mean.value } }
			: {})
	};
}
// #endregion

// #region popularity
/** the share of views each page gets, most popular first; sums to 1 */
export type Popularity = readonly number[];

/** a power law over `pages` ranks; exponent 0 is uniform */
export function zipfPopularity(pages: number, exponent: number): Popularity {
	const w = Array.from({ length: pages }, (_, i) => (i + 1) ** -exponent);
	const sum = w.reduce((a, b) => a + b, 0);
	return w.map((x) => x / sum);
}

/** every page equally likely, the control that removes concentration */
export const uniformPopularity = (pages: number): Popularity => zipfPopularity(pages, 0);

/** the exponent whose power law gives the top page `top` of all views; 0 when `top` is at or below uniform */
export function fitZipf(pages: number, top: number): number {
	if (top <= 1 / pages) return 0;
	let lo = 0;
	let hi = 12;
	for (let i = 0; i < 80; i++) {
		const mid = (lo + hi) / 2;
		if (zipfPopularity(pages, mid)[0]! < top) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

/** the top page and the next nine hold the measured shares and the rest share the remainder equally */
export function tieredPopularity(pages: number, top: number, topTen: number): Popularity {
	if (pages <= 10) return uniformPopularity(pages);
	const mid = (topTen - top) / 9;
	const rest = (1 - topTen) / (pages - 10);
	return Array.from({ length: pages }, (_, i) => (i === 0 ? top : i < 10 ? mid : rest));
}

/** the expected distinct pages among `views` independent draws */
export function expectedDistinct(pop: Popularity, views: number): number {
	let sum = 0;
	for (const p of pop) sum += 1 - (1 - p) ** views;
	return sum;
}

const median = (xs: number[]): number => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** the exponent fitted to each own site's top-page share */
export const OWN_EXPONENTS: readonly number[] = OWN_SITES.map((s) => fitZipf(s.pages, s.top));

/** the exponent used where a site type has no measured top-page share: the median of the own-site fits */
export const DEFAULT_EXPONENT: number = median([...OWN_EXPONENTS]);

/** the page count used where a site type has none measured: the median of the sizes read here */
export const DEFAULT_PAGES: number = median([...OWN_SITES.map((s) => s.pages), 1116]);

/** the popularity a site type is modelled with: fitted to its own top-page share, or the default */
export function popularityOf(a: Archetype): Popularity {
	const pages = a.pages?.value ?? DEFAULT_PAGES;
	const exponent = a.topShare ? fitZipf(pages, a.topShare.value) : DEFAULT_EXPONENT;
	return zipfPopularity(pages, exponent);
}
// #endregion

// #region simulation
/** a seed that fixes every sampled table */
export const SEED = 20261121;

/** visits a table samples per row */
export const VISITS = 200_000;

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function cumulative(xs: readonly number[]): Float64Array {
	const out = new Float64Array(xs.length);
	let acc = 0;
	xs.forEach((x, i) => {
		acc += x;
		out[i] = acc;
	});
	return out;
}

function pick(cdf: Float64Array, u: number): number {
	let lo = 0;
	let hi = cdf.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (cdf[mid]! < u) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** what one site type's visits do to the Worker, summed over a sample */
export interface Sim {
	visits: number;
	returnVisits: number;
	views: number;
	off: number;
	on: number;
	distinct: number;
	singlePage: number;
}

/** a site type at one point: its visit shape, page popularity and whether visitors return */
export interface Case {
	shape: Shape;
	popularity: Popularity;
	returns: boolean;
}

/** the case for one point of an archetype */
export function caseOf(a: Archetype, which: 'low' | 'central' | 'high'): Case {
	return { shape: shapeOf(a[which]), popularity: popularityOf(a), returns: a.returns === true };
}

/**
 * Samples visits with a fixed seed. Each draws its length from the visit model and its pages from the
 * popularity, and costs {@link workerLoad} with `distinct` the pages it drew. A return visit has the
 * worker already in control, so a page it reads costs one request, a fetch or a contact past the
 * freshness bound (`assumed`), and later views of it cost none.
 */
export function simulate(c: Case, k: Requests = SPOOL_REQUESTS, visits = VISITS, seed = SEED): Sim {
	const rand = mulberry32(seed);
	const lengths = cumulative(visitPmf(c.shape));
	const pages = cumulative(c.popularity);
	const returning: Requests = { ...k, documentsBeforeControl: 0 };
	const sim: Sim = {
		visits: 0,
		returnVisits: 0,
		views: 0,
		off: 0,
		on: 0,
		distinct: 0,
		singlePage: 0
	};
	const visit = (cost: Requests): number => {
		const views = pick(lengths, rand()) + 1;
		const seen = new Set<number>();
		for (let i = 0; i < views; i++) seen.add(pick(pages, rand()));
		const v = { views, distinct: seen.size };
		sim.visits++;
		sim.views += views;
		sim.distinct += seen.size;
		sim.off += loadOff(v).documents;
		sim.on += workerLoad(v, cost).documents;
		if (views === 1) sim.singlePage++;
		return views;
	};
	for (let i = 0; i < visits; i++) {
		const views = visit(k);
		if (c.returns && rand() < returnProbability(views)) {
			for (let j = 0; j < RETURNS_PER_RETURNER; j++) {
				visit(returning);
				sim.returnVisits++;
			}
		}
	}
	return sim;
}

/** the saving of visits that all read `views` pages, sampled; a control for the popularity alone */
export function fixedVisit(
	pop: Popularity,
	views: number,
	k: Requests = SPOOL_REQUESTS,
	visits = 20_000,
	seed = SEED
): { off: number; on: number; distinct: number } {
	const rand = mulberry32(seed);
	const pages = cumulative(pop);
	let on = 0;
	let distinct = 0;
	for (let i = 0; i < visits; i++) {
		const seen = new Set<number>();
		for (let j = 0; j < views; j++) seen.add(pick(pages, rand()));
		distinct += seen.size;
		on += workerLoad({ views, distinct: seen.size }, k).documents;
	}
	return { off: views, on: on / visits, distinct: distinct / visits };
}

/** Worker requests a view costs with spool on, against 1 with it off */
export const requestsPerView = (s: Sim): number => s.on / s.views;

/** the share of requests spool removes */
export const savedShare = (s: Sim): number => 1 - s.on / s.off;
// #endregion

// #region break even
/** the share of requests spool must remove before the decoration CPU stops costing more than it saves */
export function breakEvenSavedShare(cpuMs: number): number {
	const without = marginalUsdPerRequest(CACHED_SERVE_TOTAL_MS);
	const withSpool = marginalUsdPerRequest(CACHED_SERVE_TOTAL_MS + cpuMs);
	return 1 - without / withSpool;
}

/**
 * The views a visit must read before the expected requests with spool on fall below those with it
 * off by more than `minSaved`. Requests are taken at the expected distinct pages, which is an upper
 * bound on the expected requests; undefined when no visit up to 2,000 views gets there.
 */
export function breakEvenViews(
	pop: Popularity,
	minSaved = 0,
	k: Requests = SPOOL_REQUESTS
): number | undefined {
	const c = k.documentsBeforeControl;
	for (let v = 2; v <= 2000; v++) {
		const q = Math.min(v, c) + Math.min(Math.max(v - c, 0), expectedDistinct(pop, v));
		if ((v - q) / v > minSaved + 1e-9) return v;
	}
	return undefined;
}
// #endregion

// #region bills
/** the paid-plan upper estimate of decoration CPU, and the lower bound: the fetch-loop medians are equal */
export const DECORATION_CPU = {
	upperMs: DECORATION_CPU_MS,
	lowerMs: SPOOL_DEVICE.workerCpu.fetchLoopOn.median - SPOOL_DEVICE.workerCpu.fetchLoopOff.median
};

/** views a month the tables price */
export const TRAFFIC = [10_000, 100_000, 1_000_000, 10_000_000, 30_000_000, 100_000_000];

/** whether a difference in dollars is a bonus, a deficit or too small to show */
export type Verdict = 'BONUS' | 'DEFICIT' | 'even';

/** the verdict on `on` minus `off`; a bonus is a lower bill with spool on */
export function verdictOf(diff: number): Verdict {
	if (Math.abs(diff) < 0.005) return 'even';
	return diff < 0 ? 'BONUS' : 'DEFICIT';
}

/** the paid-plan bill for one site, which is the $5 base when every meter fits the free plan */
export const paidBill = (b: { total: number; free: boolean }): number =>
	b.free ? PAID_BASE : b.total;

/** one site's month at one traffic: whether the free plan carries it and the paid bills, spool off and on */
export interface Month {
	views: number;
	requestsOn: number;
	freeOff: boolean;
	freeOn: boolean;
	paidOff: number;
	paidOn: number;
	diff: number;
	verdict: Verdict;
}

/** one site's month, with spool pricing `perView` requests a view and `cpuMs` of decoration on each */
export function month(views: number, perView: number, cpuMs: number): Month {
	const off = account(1, views);
	const on = billWithSpool(1, views, { documentsPerView: perView, contactsPerView: 0 }, cpuMs);
	const diff = paidBill(on) - paidBill(off);
	return {
		views,
		requestsOn: views * perView,
		freeOff: off.free,
		freeOn: on.free,
		paidOff: paidBill(off),
		paidOn: paidBill(on),
		diff,
		verdict: verdictOf(diff)
	};
}

/** the most views a month at which the paid bills agree to the cent; undefined when they differ from the first step */
export function evenUpTo(perView: number, cpuMs: number): number | undefined {
	let last: number | undefined;
	for (let views = 10_000; views <= 1e10; views *= 1.02) {
		if (Math.abs(month(views, perView, cpuMs).diff) >= 0.005) return last;
		last = views;
	}
	return last;
}
// #endregion

// #region headlines
/** the archetypes whose behaviour weights a typical site; the baseline is a cross-industry reference and is left out */
export const WEIGHTED = ARCHETYPES.filter((a) => a.label !== 'all-sites baseline');

/** views a month the free plan's request cap carries at each point, averaged over the weighted archetypes with equal weights (`assumed`) */
export function typicalCapacity(which: 'low' | 'central' | 'high', visits = VISITS): number {
	const caps = WEIGHTED.map((a) =>
		freeViewsMonth(requestsPerView(simulate(caseOf(a, which), SPOOL_REQUESTS, visits)))
	);
	return caps.reduce((a, b) => a + b, 0) / caps.length;
}

/** the monthly free-plan floor, 100,000 requests a day over the model's month */
export const FLOOR_VIEWS_MONTH = freeViewsMonth(1);

/** the figures the website and the docs quote that scale with requests a view */
export const HEADLINES = [
	{ name: 'free plan, one-click deploy (the floor)', old: FLOOR_VIEWS_MONTH },
	{ name: 'free plan with the R2 page mirror, 77% mirror share', old: 432_900 * 30.44 },
	{ name: 'R2 mirror, no Cache Rule, 0% absorption', old: 336_700 * 30.44 },
	{ name: 'R2 mirror, Cache Rule on', old: 2_693_602 * 30.44 },
	{ name: 'assets arm, not built', old: 2_973_333 * 30.44 },
	{ name: 'spool line, 20 views a visit on 9 pages', old: 5_073_343 },
	{ name: 'spool line, 121 views a visit on 9 pages', old: 30_693_657 }
] as const;
// #endregion

// #region print
const MD = process.argv.includes('--md');

function table(title: string, headers: string[], rows: string[][]): void {
	if (MD) {
		console.log(`\n**${title}**\n`);
		console.log(`| ${headers.join(' | ')} |`);
		console.log(`| ${headers.map(() => '---').join(' | ')} |`);
		for (const row of rows) console.log(`| ${row.join(' | ')} |`);
		return;
	}
	const w = headers.map((h, i) => Math.max(h.length, ...rows.map((x) => (x[i] ?? '').length)));
	console.log(`\n${title}`);
	console.log(headers.map((h, i) => r(h, w[i]!)).join('  '));
	for (const row of rows) console.log(row.map((c, i) => r(c, w[i]!)).join('  '));
}

const usd = (x: number) => `$${x.toFixed(2)}`;
const cell = (m: Month) =>
	m.verdict === 'even' ? 'even' : `${m.verdict} ${usd(Math.abs(m.diff))}`;
const WHICH = ['low', 'central', 'high'] as const;

if (import.meta.main) {
	const sims = new Map<string, Sim>();
	const run = (a: Archetype, which: (typeof WHICH)[number]) => {
		const key = `${a.label}/${which}`;
		if (!sims.has(key)) sims.set(key, simulate(caseOf(a, which)));
		return sims.get(key)!;
	};

	table(
		'Behaviour inputs (views a visit)',
		['archetype', 'point', 'views', 'single-page', 'source', 'read', 'definition'],
		ARCHETYPES.flatMap((a) =>
			WHICH.filter((w, i) => i === 1 || a[w].value !== a.central.value).map((w) => [
				a.label,
				w,
				f(a[w].value, 2),
				a[w].singlePage ? pct(a[w].singlePage.value, 2) : 'implied by the fit',
				`${SOURCES[a[w].source].name} (${SOURCES[a[w].source].year})`,
				a[w].read,
				a[w].definition
			])
		)
	);
	console.log(
		`\nNo figure that was read: ${NO_FIGURE.map((x) => `${x.label} (${x.reason})`).join('; ')}`
	);

	table(
		'Distinct pages and concentration',
		['site', 'pages', 'top page', 'top ten', 'fitted exponent', 'power law top ten'],
		OWN_SITES.map((s, i) => [
			s.label,
			String(s.pages),
			pct(s.top, 0),
			pct(s.topTen, 0),
			f(OWN_EXPONENTS[i]!, 3),
			pct(
				zipfPopularity(s.pages, OWN_EXPONENTS[i]!)
					.slice(0, 10)
					.reduce((a, b) => a + b, 0),
				0
			)
		])
	);
	console.log(
		`\nDefault exponent ${f(DEFAULT_EXPONENT, 3)} (median of the fits, range ${f(
			Math.min(...OWN_EXPONENTS),
			2
		)} to ${f(Math.max(...OWN_EXPONENTS), 2)}) and default ${DEFAULT_PAGES} pages (median of the sizes read) are used where a site type has none measured.`
	);
	table(
		'Sitemap URLs by CMS, sampled university sites',
		['CMS', 'sites', 'lower-bound counts', 'quartile 1', 'median', 'quartile 3', 'max'],
		SITE_SIZES.map((s) => [
			s.cms,
			String(s.sites),
			String(s.lowerBounds),
			n(s.q1),
			n(s.median),
			n(s.q3),
			n(s.max)
		])
	);

	const saved = (a: Archetype, w: (typeof WHICH)[number]) => savedShare(run(a, w));
	table(
		`Table A: Worker requests a visit, spool off and on (c = ${SPOOL_REQUESTS.documentsBeforeControl}, every visitor on a worker)`,
		[
			'archetype',
			'point',
			'views a visit',
			'off',
			'on',
			'saved',
			'on at c = 2',
			'break even, views',
			'break even, dollars at 5 ms'
		],
		ARCHETYPES.flatMap((a) =>
			WHICH.filter((w, i) => i === 1 || a[w].value !== a.central.value).map((w) => {
				const s = run(a, w);
				const two = simulate(caseOf(a, w), {
					...SPOOL_REQUESTS,
					documentsBeforeControl: 2
				});
				const pop = popularityOf(a);
				const be = breakEvenViews(pop);
				const bd = breakEvenViews(pop, breakEvenSavedShare(DECORATION_CPU.upperMs));
				const one = a.low.value === a.high.value;
				return [
					a.label,
					one ? 'one figure' : w,
					f(s.views / s.visits, 2),
					f(s.off / s.visits, 3),
					f(s.on / s.visits, 3),
					pct(saved(a, w), 1),
					f(two.on / two.visits, 3),
					be === undefined ? 'never' : String(be),
					bd === undefined ? 'never' : String(bd)
				];
			})
		)
	);
	console.log(
		`\nSaved share needed to pay for decoration CPU on the paid plan: ${pct(
			breakEvenSavedShare(DECORATION_CPU.upperMs),
			1
		)} at ${DECORATION_CPU.upperMs} ms (upper estimate), ${pct(
			breakEvenSavedShare(DECORATION_CPU.lowerMs),
			1
		)} at ${DECORATION_CPU.lowerMs} ms (lower bound, fetch-loop medians equal).`
	);

	for (const a of ARCHETYPES) {
		const s = run(a, 'central');
		const pv = requestsPerView(s);
		table(
			`Table B: ${a.label}, central behaviour, ${f(s.views / s.visits, 2)} views a visit, ${f(pv, 3)} requests a view with spool on`,
			[
				'views a month',
				'requests on',
				'free plan off',
				'free plan on',
				'paid off',
				'paid on, 5 ms',
				'difference, 5 ms',
				'paid on, 0 ms',
				'difference, 0 ms'
			],
			TRAFFIC.map((views) => {
				const hi = month(views, pv, DECORATION_CPU.upperMs);
				const lo = month(views, pv, DECORATION_CPU.lowerMs);
				return [
					n(views),
					n(hi.requestsOn),
					hi.freeOff ? 'carries' : 'over',
					hi.freeOn ? 'carries' : 'over',
					usd(hi.paidOff),
					usd(hi.paidOn),
					cell(hi),
					usd(lo.paidOn),
					cell(lo)
				];
			})
		);
		console.log(
			`free plan carries ${n(FLOOR_VIEWS_MONTH)} views a month with spool off and ${n(
				freeViewsMonth(pv)
			)} on; paid bills agree to the cent up to ${n(evenUpTo(pv, DECORATION_CPU.upperMs) ?? 0)} views a month at 5 ms`
		);
	}

	for (const [ms, name] of [
		[DECORATION_CPU.upperMs, '5 ms'],
		[DECORATION_CPU.lowerMs, '0 ms']
	] as const) {
		table(
			`Table B at the low and high views a visit, paid plan, decoration CPU ${name}`,
			['archetype', 'point', ...TRAFFIC.map((v) => n(v))],
			ARCHETYPES.filter((a) => a.low.value !== a.high.value).flatMap((a) =>
				(['low', 'high'] as const).map((w) => [
					a.label,
					w,
					...TRAFFIC.map((v) => cell(month(v, requestsPerView(run(a, w)), ms)))
				])
			)
		);
	}

	const sweepViews = [5, 10, 20];
	const sizes = [10, 100, 1000, 10_000];
	for (const [name, mk] of [
		[
			`concentrated, exponent ${f(DEFAULT_EXPONENT, 2)}`,
			(p: number) => zipfPopularity(p, DEFAULT_EXPONENT)
		],
		['uniform (control)', uniformPopularity]
	] as const) {
		table(
			`Site size sweep, ${name}: requests saved and free-plan views a month, visits of a fixed length`,
			['distinct pages', ...sweepViews.map((v) => `${v} views`)],
			sizes.map((p) => [
				n(p),
				...sweepViews.map((v) => {
					const x = fixedVisit(mk(p), v);
					return `${pct(1 - x.on / x.off, 1)}, ${n(freeViewsMonth(x.on / x.off))}`;
				})
			])
		);
	}

	const weighted = (['low', 'central', 'high'] as const).map((w) => typicalCapacity(w));
	table(
		'Headlines that scale with requests a view (free plan, views a month)',
		['figure', 'old', 'low', 'central', 'high', 'website'],
		HEADLINES.map((h) => {
			const scale = weighted.map((c) => c / FLOOR_VIEWS_MONTH);
			const lineViews = h.name.includes('121 views') ? 121 : 20;
			const onSite = (pages: number) => {
				const x = fixedVisit(zipfPopularity(pages, DEFAULT_EXPONENT), lineViews);
				return freeViewsMonth(x.on / x.off);
			};
			const vals = h.name.startsWith('spool line')
				? [onSite(10_000), onSite(DEFAULT_PAGES), onSite(100)]
				: scale.map((s) => h.old * s);
			return [
				h.name,
				n(h.old),
				n(vals[0]!),
				n(vals[1]!),
				n(vals[2]!),
				vals[1]! > h.old ? 'RISES' : 'NOT'
			];
		})
	);
	console.log(
		`\nThe two spool lines are the same visit length on a site of 10,000, ${DEFAULT_PAGES} and 100 ` +
			`pages (low, central, high). The others scale by the weighted capacity: equal weights across ` +
			`${WEIGHTED.map((a) => a.label).join(', ')} (assumed; no weights are measured). ` +
			`Free-plan cap ${n(FREE_QUOTAS.workerRequestsPerDay)} Worker requests a day, model month 30.44 days.`
	);
}
// #endregion
