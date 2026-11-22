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

/** whether two runs of one seed agree on every figure the clock does not decide */
export function sameStable(a: Stable, b: Stable): boolean {
	const figures = ({ violations: _violations, ...rest }: Stable) => JSON.stringify(rest);
	return figures(a) === figures(b);
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
