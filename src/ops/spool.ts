/**
 * Spool, the client-side replica: the paths it owns, the budget on them, and the version vector the
 * object keeps for it.
 *
 * The vector is a map from tag to the cursor of its last change, held in memory: it writes no row,
 * so a save costs the meter nothing for it. A restart loses it, and the answer to a device that
 * asks after one is to reset, which costs the device its copies and never shows it a stale page. A
 * cursor is `generation * 4096 + n`, where `n` counts the changes inside one generation, so every
 * change after a page was decorated has a higher cursor than that page carries.
 * @module
 */

/** the service worker script spool registers, served from the origin's root */
export const SPOOL_SW_PATH = '/spool-sw.js';

/** the prefix spool reserves for its own endpoints and the same-origin client script */
export const SPOOL_PREFIX = '/.spool/';

/** true for a path spool owns */
export const isSpoolPath = (pathname: string): boolean =>
	pathname === SPOOL_SW_PATH || pathname.startsWith(SPOOL_PREFIX);

/** the object-internal route the front worker asks for the vector */
export const SPOOL_OBJECT_PATH = '/__spool';

/** the tag spool derives for a page with no tag header; must equal `pathTag` in `@drupflare/spool/proxy` */
export const pathTagFor = (path: string): string => `proxy:path:${path}`;

/** changes one generation may record before the vector gives up and reports a wholesale change */
export const SPOOL_SLOTS = 4096;

/**
 * The cursor a page rendered at `generation` carries. Every change recorded at that generation has
 * a higher one, so a device holding this page is told about changes made after it was rendered, and
 * a vector that started at that generation counts it as its own floor.
 */
export const spoolCursorFloor = (generation: number): number => generation * SPOOL_SLOTS + 1;

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

/** the tags that changed after a cursor, each with the cursor of its last change */
export type SpoolDiff = {
	cursor: number;
	changed: Record<string, number>;
	/** the holder's cursor is ahead of this vector or behind a change it cannot be told about */
	reset: boolean;
};

/** tags a vector holds before it degrades to a wholesale change */
const MAX_TAGS = 2_000;

/**
 * Tag to the cursor of its last change, with a floor under which nothing is known.
 *
 * The floor is where this instance started, or where a wholesale change last landed. A holder whose
 * cursor is below it is told to reset, because the tags that changed in between were either never
 * recorded here or all changed at once. That is the conservative answer: a reset costs a device its
 * copies and never shows it a stale page.
 */
export class SpoolStamps {
	#floor: number;
	#generation: number;
	#count = 0;
	readonly #tags = new Map<string, number>();

	/**
	 * `boot` is the generation when this instance started. Nothing before it is known, so a holder
	 * of an older generation resets. A change recorded earlier at this generation, by an instance
	 * that restarted, is not known either; it falls inside the window between a save's first write
	 * and its flush, when the page cache itself may still hold the old page.
	 */
	constructor(boot: number) {
		this.#generation = boot;
		this.#floor = spoolCursorFloor(boot);
	}

	/** the next cursor inside `generation`; the last slot repeats rather than spill into the next generation */
	#next(generation: number): number {
		if (generation !== this.#generation) {
			this.#generation = generation;
			this.#count = 0;
		}
		this.#count = Math.min(this.#count + 1, SPOOL_SLOTS - 1);
		return spoolCursorFloor(generation) + this.#count;
	}

	/**
	 * Everything changed. With `advance` the change takes a cursor of its own, for a purge that moved
	 * no generation; without it the floor is the generation's own, for a bump that already did.
	 */
	wholesale(generation: number, advance = false): void {
		this.#floor = Math.max(
			this.#floor,
			advance ? this.#next(generation) : spoolCursorFloor(generation)
		);
		this.#tags.clear();
	}

	/** records a change to `tags` inside `generation`; past the cap it degrades to a wholesale change */
	stamp(tags: Iterable<string>, generation: number): void {
		const cursor = this.#next(generation);
		for (const tag of tags) this.#tags.set(tag, cursor);
		if (this.#tags.size > MAX_TAGS) this.wholesale(generation, true);
	}

	/** how many tags are held, for the stats line */
	get size(): number {
		return this.#tags.size;
	}

	/**
	 * The cursor at `generation`: the latest change inside it, or its floor when none was recorded.
	 * Never below the vector's own floor, or a holder told to reset would be told again at its next
	 * sync.
	 */
	cursor(generation: number): number {
		const base =
			generation === this.#generation
				? spoolCursorFloor(generation) + this.#count
				: spoolCursorFloor(generation);
		return Math.max(base, this.#floor);
	}

	/** every tag changed after `from`, as of the object's current generation */
	diff(from: number, generation: number): SpoolDiff {
		const current = this.cursor(generation);
		if (!Number.isSafeInteger(from) || from < 0 || from > current) {
			return { cursor: current, changed: {}, reset: true };
		}
		if (from < this.#floor) return { cursor: current, changed: {}, reset: true };
		const changed: Record<string, number> = {};
		for (const [tag, at] of this.#tags) if (at > from) changed[tag] = at;
		return { cursor: current, changed, reset: false };
	}
}
