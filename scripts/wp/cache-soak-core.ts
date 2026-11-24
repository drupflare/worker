import { createHash } from 'node:crypto';
import { classifyPath } from '../../src/wordpress/store-rule';

/** a seeded generator, so one seed always draws the same operations */
export function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** every tier that replays a stored page */
export const STORE_TIERS = ['HIT', 'EDGE', 'MEM', 'KV', 'AGED'];

/** the kinds of operation the soak draws, with their weights */
export const OPERATIONS = [
	{ kind: 'read', weight: 46 },
	{ kind: 'tracking', weight: 4 },
	{ kind: 'conditional', weight: 6 },
	{ kind: 'head', weight: 3 },
	{ kind: 'refused', weight: 8 },
	{ kind: 'auth-read', weight: 6 },
	{ kind: 'ajax', weight: 3 },
	{ kind: 'rest-read', weight: 3 },
	{ kind: 'write', weight: 21 }
] as const;

/** the editorial writes, each of which must purge what it changes (or, for two, nothing) */
export const WRITES = [
	'publish',
	'edit',
	'trash',
	'comment-approve',
	'term-edit',
	'option-change',
	'theme-switch',
	'menu-edit',
	'draft-save',
	'comment-hold'
] as const;

export type Operation = (typeof OPERATIONS)[number]['kind'];
export type Write = (typeof WRITES)[number];

/** draws an index by weight */
export function pick<T extends { weight: number }>(items: readonly T[], roll: number): T {
	const total = items.reduce((sum, i) => sum + i.weight, 0);
	let at = roll * total;
	for (const item of items) {
		at -= item.weight;
		if (at < 0) return item;
	}
	return items[items.length - 1]!;
}

/** one post as the soak believes the site holds it */
export type PostState = {
	id: number;
	title: string;
	route: string;
	status: 'publish' | 'trash' | 'draft' | 'private';
	category: number;
	comments: string[];
	/** a sticky post leads the first page of the front page, whatever its date */
	sticky?: boolean;
};

/** a published post behind a password, which WordPress lists with a `Protected:` prefix */
export type LockedPost = { id: number; title: string };

/** the site as the soak believes it is after the last confirmed write */
export type Model = {
	blogname: string;
	theme: string;
	/** whether the theme's path shows in the page, which depends on the theme */
	themeShows: boolean;
	posts: PostState[];
	/** published posts behind a password: they take a slot on the front page like any other */
	locked?: LockedPost[];
	categories: Map<number, { name: string; slug: string }>;
	secrets: string[];
	/** titles that must never appear on an anonymous page again */
	gone: string[];
	/** the newest approved comment, which the comment feed must list */
	lastComment?: string;
};

/** the title-shaped tokens a page shows, which is what two renders of one page must agree on */
export const tokensOf = (body: string): string =>
	[...new Set(body.match(/Tk[0-9a-z]{8}/g) ?? [])].sort().join(',');

/**
 * The posts an anonymous front page lists, as WordPress lists them: sticky posts first, then every
 * published post by date, newest first, a password post included. Ids rise with the date here, as
 * each post is created a second after the last.
 */
export function frontPage(model: Model, size = 3): { id: number; title: string }[] {
	const listed: { id: number; title: string; sticky: boolean }[] = [
		...model.posts
			.filter((p) => p.status === 'publish')
			.map((p) => ({ id: p.id, title: p.title, sticky: p.sticky === true })),
		...(model.locked ?? []).map((p) => ({ ...p, sticky: false }))
	];
	return listed
		.sort((a, b) => Number(b.sticky) - Number(a.sticky) || b.id - a.id)
		.slice(0, size)
		.map(({ id, title }) => ({ id, title }));
}

/** what an anonymous read of a route must show */
export type Expectation = { status: number; present: string[]; absent: string[]; feed: boolean };

/** the expectation for a route, from the model alone */
export function expectation(model: Model, route: string): Expectation {
	const feed = route.endsWith('/feed/');
	const present: string[] = [];
	const absent = [...model.gone];
	for (const p of model.posts) {
		if (p.status !== 'publish') absent.push(p.title);
	}
	present.push(model.blogname);
	if (route === '/') present.push(...frontPage(model).map((p) => p.title));
	const post = model.posts.find((p) => p.route === route);
	if (post !== undefined) {
		if (post.status !== 'publish') return { status: 404, present: [], absent, feed: false };
		present.push(post.title, ...post.comments);
		const cat = model.categories.get(post.category);
		if (cat !== undefined) present.push(cat.name);
	}
	if (route === '/comments/feed/' && model.lastComment !== undefined) {
		present.push(model.lastComment);
	}
	const catRoute = [...model.categories.values()].find((c) => route === `/category/${c.slug}/`);
	if (catRoute !== undefined) present.push(catRoute.name);
	return { status: 200, present, absent, feed };
}

/** what one answer says about the property under test */
export type Seen = {
	status: number;
	body: string;
	headers: Record<string, string>;
};

/** the problems an anonymous answer has against an expectation; empty means it is right */
export function judgeAnswer(model: Model, route: string, seen: Seen): string[] {
	const want = expectation(model, route);
	const found: string[] = [];
	if (seen.status !== want.status) found.push(`status ${seen.status}, wanted ${want.status}`);
	if (seen.status === 200) {
		for (const text of want.present) {
			if (!seen.body.includes(text)) found.push(`missing ${text}`);
		}
		if (model.themeShows && !want.feed && !seen.body.includes(`/themes/${model.theme}/`)) {
			found.push(`theme ${model.theme} not shown`);
		}
	}
	for (const text of want.absent) {
		if (seen.body.includes(text)) found.push(`still shows ${text}`);
	}
	for (const secret of model.secrets) {
		if (seen.body.includes(secret)) found.push(`leaks ${secret.slice(0, 12)}`);
	}
	return found;
}

/** a response header the way every tier answers it */
export const tierOf = (headers: Record<string, string>): string => headers['x-cfw-cache'] ?? '';

/** the problems with an answer to a request that carried an identity or was refused by the rule */
export function judgePrivate(kind: 'auth' | 'refused', seen: Seen): string[] {
	const found: string[] = [];
	if (STORE_TIERS.includes(tierOf(seen.headers))) {
		found.push(`${kind} answer came from the store tier ${tierOf(seen.headers)}`);
	}
	return found;
}

/** the problems with an answer that is not a 200: no store tier may have served it */
export function judgeError(seen: Seen): string[] {
	if (seen.status === 200) return [];
	return STORE_TIERS.includes(tierOf(seen.headers))
		? [`a ${seen.status} came from the store tier ${tierOf(seen.headers)}`]
		: [];
}

/** one stored row as the audit reads it */
export type StoredRow = {
	path: string;
	status: number;
	rendered_at: number;
	stale_at: number | null;
	bytes: number;
};

/** the most stored rows the soak's routes and their normalised variants may produce */
export const MAX_ROWS = 60;

/** the problems with the store: a bad status, a path the rule refuses, too many rows, a secret */
export function judgeStore(rows: StoredRow[], leaks: Record<string, string[]>): string[] {
	const found: string[] = [];
	for (const row of rows) {
		if (row.status !== 200) found.push(`row ${row.path} has status ${row.status}`);
		const verdict = classifyPath(row.path);
		if (verdict.refusal !== undefined) {
			found.push(`row ${row.path} is a path the rule refuses: ${verdict.refusal}`);
		}
	}
	if (rows.length > MAX_ROWS) found.push(`${rows.length} rows, over the ${MAX_ROWS} bound`);
	for (const [secret, paths] of Object.entries(leaks)) {
		if (paths.length > 0)
			found.push(`secret ${secret.slice(0, 12)} is stored in ${paths.join(', ')}`);
	}
	return found;
}

/** a digest of a body, so two runs can be compared without keeping the pages */
export const digest = (text: string): string =>
	createHash('sha256').update(text).digest('hex').slice(0, 16);

/** the figures two runs of one seed must share, which excludes anything the clock decides */
export type Stable = {
	seed: number;
	operations: number;
	byKind: Record<string, number>;
	writesByKind: Record<string, number>;
	logDigest: string;
	violations: string[];
	storedPaths: string[];
};

/** the counters of the object's tag purge that a write can move */
export type PurgeCounters = {
	generation: number;
	announced: number;
	wholesale: number;
	floorPurges: number;
	/** pages the last scoped purge removed, with the generation it ran at */
	lastScoped?: { generation: number; purged: number };
};

/**
 * The problems with a write that must leave every stored page alone, judged at the purge: a row
 * that was stored before and is gone or newly marked stale straight after the write, a wholesale or
 * floor purge, or a scoped purge that removed pages. A row the object re-rendered afterwards is
 * not a purge, so a refill of an earlier write's pages never reads as one.
 */
export function judgeQuietWrite(
	before: StoredRow[],
	after: StoredRow[],
	c0: PurgeCounters,
	c1: PurgeCounters
): string[] {
	const found: string[] = [];
	const now = new Map(after.map((r) => [r.path, r]));
	for (const row of before) {
		const next = now.get(row.path);
		if (next === undefined) found.push(`removed ${row.path}`);
		else if (row.stale_at === null && next.stale_at !== null) found.push(`marked ${row.path}`);
	}
	if (c1.wholesale > c0.wholesale) found.push('wholesale purge');
	if (c1.floorPurges > c0.floorPurges) found.push('floor purge');
	if (
		c1.lastScoped !== undefined &&
		c1.lastScoped.generation > c0.generation &&
		c1.lastScoped.purged > 0
	) {
		found.push(`scoped purge of ${c1.lastScoped.purged} pages`);
	}
	return found;
}

/** a text with every dated permalink prefix (year, month, day archives) reduced to one token */
export function undated(text: string): string {
	return text.replace(/\/\d{4}(?:\/\d{2}){0,2}\//g, '/DATE/');
}

/** whether two runs of one seed agree on every figure the clock does not decide */
export function sameStable(a: Stable, b: Stable): boolean {
	const figures = ({ violations: _violations, storedPaths, ...rest }: Stable) =>
		JSON.stringify({ ...rest, storedPaths: storedPaths.map(undated) });
	return figures(a) === figures(b);
}

/** the write-to-fresh bound in ms: one render per route plus one slid-in fill, 3 s each, and 2 s of slack */
export function contractMsFor(routes: number): number {
	return 3000 * (routes + 1) + 2000;
}

/** the violation text for a confirm that ran over its bound, or undefined when it did not */
export function judgeContract(
	kind: string,
	worstMs: number,
	routes: number,
	overrideMs?: number,
	storedRows?: number
): string | undefined {
	const flat = overrideMs !== undefined && Number.isFinite(overrideMs);
	const renders = Math.max(routes, storedRows ?? 0);
	const bound = flat ? overrideMs : contractMsFor(renders);
	if (worstMs <= bound) return undefined;
	const n = (v: number) => v.toLocaleString('en-US');
	const what =
		renders > routes
			? `${routes} routes read behind ${renders} stored rows`
			: `${routes} routes`;
	return flat
		? `${kind} took ${n(worstMs)} ms for ${what}, over the ${n(bound)} ms flat override`
		: `${kind} took ${n(worstMs)} ms for ${what}, over the ${n(bound)} ms bound`;
}

const TRANSPORT_RETRYABLE = /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|timed out/;

/**
 * Whether a failed request may be sent again. A refused connect never carried the request, so any
 * method is safe; the other failures may have reached the server, so only a read is.
 */
export function retryableTransport(message: string, idempotent: boolean): boolean {
	if (/ECONNREFUSED/.test(message)) return true;
	return idempotent && TRANSPORT_RETRYABLE.test(message);
}

/** the median and extremes of a list of numbers, or undefined when it is empty */
export function spread(
	values: number[]
): { n: number; min: number; p50: number; p90: number; max: number } | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
	return {
		n: sorted.length,
		min: sorted[0]!,
		p50: at(0.5),
		p90: at(0.9),
		max: sorted[sorted.length - 1]!
	};
}

// #region the deployed target
/** where a run points and what it may do there */
export type Target =
	| { deployed: false }
	| {
			deployed: true;
			origin: string;
			host: string;
			port: number;
			secure: boolean;
			rowsStop: number;
	  };

/** a target read from the arguments, or the reason it is refused; a reason never carries a token */
export type TargetRead = { ok: true; target: Target } | { ok: false; error: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** reads `--deployed`, `SOAK_ORIGIN` and `SOAK_ROWS_STOP`; a token never passes through here */
export function readTarget(argv: string[], env: Record<string, string | undefined>): TargetRead {
	const deployed = argv.includes('--deployed');
	const origin = env.SOAK_ORIGIN ?? '';
	if (!deployed) {
		return origin === ''
			? { ok: true, target: { deployed: false } }
			: { ok: false, error: 'SOAK_ORIGIN is set without --deployed' };
	}
	if (argv.includes('--determinism')) {
		return { ok: false, error: '--determinism runs the seed twice and needs a local rig' };
	}
	if (origin === '') return { ok: false, error: '--deployed needs SOAK_ORIGIN' };
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return { ok: false, error: 'SOAK_ORIGIN is not a URL' };
	}
	const secure = url.protocol === 'https:';
	if (!secure && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
		return { ok: false, error: 'SOAK_ORIGIN must be https://, or http:// on localhost' };
	}
	if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '') {
		return { ok: false, error: 'SOAK_ORIGIN is an origin: no credentials, path or query' };
	}
	const stop = env.SOAK_ROWS_STOP ?? '';
	if (!/^[1-9][0-9]*$/.test(stop)) {
		return { ok: false, error: '--deployed needs SOAK_ROWS_STOP, a whole number of rows' };
	}
	return {
		ok: true,
		target: {
			deployed: true,
			origin: url.origin,
			host: url.hostname,
			port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
			secure,
			rowsStop: Number(stop)
		}
	};
}

/** whether the run goes on at a poll of the object's rows-written counter, and what to say if not */
export function rowsGuard(
	rowsToday: number,
	stop: number,
	operations: number
): { stop: boolean; message: string } {
	const n = (v: number) => v.toLocaleString('en-US');
	return rowsToday > stop
		? {
				stop: true,
				message: `rows guard: rowsToday ${n(rowsToday)} passed SOAK_ROWS_STOP ${n(stop)} after ${n(operations)} operations; the run stopped`
			}
		: { stop: false, message: '' };
}

/** the owner routes a deployed run calls, each with what it stands in for on a local rig */
export const OWNER_ROUTES_USED = [
	{ route: '/serve-stats', method: 'GET', standsInFor: '/serve-stats' },
	{ route: '/db-console', method: 'POST', standsInFor: '/sql reads' },
	{ route: '/recycle', method: 'POST', standsInFor: 'killing and restarting the process' }
] as const;

/** a piece of the run that did not happen, with the reason */
export type Skipped = { arm: string; skipped: true; reason: string };

/** the record of a skipped piece */
export const skipped = (arm: string, reason: string): Skipped => ({ arm, skipped: true, reason });

/** the pieces a deployed run cannot do with an owner token alone */
export const DEPLOYED_SKIPS = {
	plantedRow: skipped(
		'planted-row controls',
		'they write a row, /sql is open only with PW_DIAGNOSTICS and /db-console rolls a write back'
	),
	processRestart: skipped(
		'process restart',
		'a deployed object has no process to kill; /recycle replaces its interpreter instead'
	)
} as const;
// #endregion
