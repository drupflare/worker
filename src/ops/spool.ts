/**
 * The spool shadow trial: the mode levers, the paths spool owns, and the version vector the object
 * keeps for it.
 *
 * Shadow mode never serves a page from a device. It decorates eligible pages, answers `/.spool/*`
 * and `/spool-sw.js`, and lets the service worker record what it could have served. The vector is a
 * map from tag to the generation of its last change, held in memory: it writes no row.
 * @module
 */

/** the values `SPOOL_MODE` takes; `serve` is the v1.1 adapter and is not offered yet */
export const SPOOL_MODES = ['off', 'shadow'] as const;

/** one of {@link SPOOL_MODES} */
export type SpoolMode = (typeof SPOOL_MODES)[number];

/** the service worker script spool registers, served from the origin's root */
export const SPOOL_SW_PATH = '/spool-sw.js';

/** the prefix spool reserves for its own endpoints and the same-origin client script */
export const SPOOL_PREFIX = '/.spool/';

/** true for a path spool owns, whatever the mode */
export const isSpoolPath = (pathname: string): boolean =>
	pathname === SPOOL_SW_PATH || pathname.startsWith(SPOOL_PREFIX);

/** the object-internal route the front worker asks for the vector */
export const SPOOL_OBJECT_PATH = '/__spool';

/** the tag spool derives for a page with no tag header; must equal `pathTag` in `@drupflare/spool/proxy` */
export const pathTagFor = (path: string): string => `proxy:path:${path}`;

/** requests to spool's paths one address may make per window */
export const SPOOL_IP_LIMIT = 120;

/** requests to spool's paths one isolate accepts per window from every address together */
export const SPOOL_GLOBAL_LIMIT = 3_000;

/** the window both limits count over */
export const SPOOL_WINDOW_MS = 60_000;

const perAddress = new Map<string, { count: number; first: number }>();
let overall = { count: 0, first: 0 };

/** drops both budgets; tests use it */
export function resetSpoolBudget(): void {
	perAddress.clear();
	overall = { count: 0, first: 0 };
}

/**
 * Counts one request to a spool path against the address and the isolate, and says whether it may
 * run. In memory and per isolate, because a durable counter would spend a row per request, and
 * bounded because the key is attacker-supplied.
 */
export function spoolAllowed(address: string, nowMs: number): boolean {
	if (nowMs - overall.first >= SPOOL_WINDOW_MS) overall = { count: 0, first: nowMs };
	if (perAddress.size > 4096) perAddress.clear();
	let held = perAddress.get(address);
	if (!held || nowMs - held.first >= SPOOL_WINDOW_MS) {
		held = { count: 0, first: nowMs };
		perAddress.set(address, held);
	}
	held.count += 1;
	overall.count += 1;
	return held.count <= SPOOL_IP_LIMIT && overall.count <= SPOOL_GLOBAL_LIMIT;
}

/** the tags that changed after a cursor, each with the generation of its last change */
export type SpoolDiff = {
	cursor: number;
	changed: Record<string, number>;
	/** the holder's cursor is ahead of this vector or behind a change it cannot be told about */
	reset: boolean;
};

const MAX_TAGS = 10_000;

/**
 * Tag to the generation of its last change, with a floor under which nothing is known.
 *
 * The floor is the generation at which this instance started or a wholesale purge last ran. A
 * holder whose cursor is below it is told to reset, because the tags that changed in between were
 * either never recorded here or all changed at once. That is the conservative answer: a reset costs
 * a device its copies and never shows it a stale page.
 */
export class SpoolStamps {
	#floor: number;
	readonly #tags = new Map<string, number>();

	/** `boot` is the generation when this instance started */
	constructor(boot: number) {
		this.#floor = boot;
	}

	/** every tag changed, at `generation` */
	wholesale(generation: number): void {
		this.#floor = Math.max(this.#floor, generation);
		this.#tags.clear();
	}

	/** records a change to `tags` at `generation`; past the cap it degrades to a wholesale change */
	stamp(tags: Iterable<string>, generation: number): void {
		for (const tag of tags) this.#tags.set(tag, generation);
		if (this.#tags.size > MAX_TAGS) this.wholesale(generation);
	}

	/** how many tags are held, for the stats line */
	get size(): number {
		return this.#tags.size;
	}

	/** every tag changed after `from`, as of the object's current generation */
	diff(from: number, current: number): SpoolDiff {
		if (!Number.isSafeInteger(from) || from < 0 || from > current) {
			return { cursor: current, changed: {}, reset: true };
		}
		if (from < this.#floor) return { cursor: current, changed: {}, reset: true };
		const changed: Record<string, number> = {};
		for (const [tag, at] of this.#tags) if (at > from) changed[tag] = at;
		return { cursor: current, changed, reset: false };
	}
}
