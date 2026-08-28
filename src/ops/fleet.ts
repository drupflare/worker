/**
 * The fleet inventory: which sites exist, and what each one is running.
 *
 * WITHOUT IT, time-to-patch is not merely slow, it is UNMEASURABLE. "Every site is patched" is a
 * claim about a set nobody can enumerate, and a staged rollout at 10% has no denominator.
 *
 * THE WRITE BUDGET IS THE WHOLE DESIGN CONSTRAINT. D1 allows 100,000 rows written per day on free,
 * the same order as the Durable Object ceiling this project already treats as binding, so a report
 * per alarm would spend a fleet-wide meter to record that nothing changed. {@link shouldReport}
 * writes only when a site's IDENTITY moved or its last report went stale, which makes the steady
 * state one row per site per day.
 */

/** the minimal D1 surface, so the inventory is drivable over a stand-in */
export type FleetDb = {
	prepare(query: string): {
		bind(...values: unknown[]): {
			run(): Promise<unknown>;
			all<T = unknown>(): Promise<{ results: T[] }>;
		};
	};
};

/** what one site reports about itself */
export type FleetRow = {
	site: string;
	/** the migration pack it replayed, which is what a patch actually changes */
	packGeneration: string;
	/** the Drupal core version the pack carries */
	coreVersion: string;
	/** the Worker version serving it, which is the rollback unit */
	workerVersion: string;
	plan: 'free' | 'paid';
	lastSeenMs: number;
};

/** how long a site may go unreported before it reports again even with nothing changed */
export const FLEET_HEARTBEAT_MS = 24 * 60 * 60 * 1000;

export const FLEET_DDL = `CREATE TABLE IF NOT EXISTS cfw_fleet (
  site TEXT PRIMARY KEY,
  pack_generation TEXT NOT NULL,
  core_version TEXT NOT NULL,
  worker_version TEXT NOT NULL,
  plan TEXT NOT NULL,
  last_seen_ms INTEGER NOT NULL
)`;

/**
 * Whether a site should write its row.
 *
 * Pure, so the decision is testable without a database -- which matters because this predicate is
 * the entire write budget. An identity change reports immediately: a site that just replayed a new
 * pack is exactly the row a rollout is watching for.
 */
export function shouldReport(previous: FleetRow | null, current: FleetRow, nowMs: number): boolean {
	if (previous === null) return true;
	if (
		previous.packGeneration !== current.packGeneration ||
		previous.coreVersion !== current.coreVersion ||
		previous.workerVersion !== current.workerVersion ||
		previous.plan !== current.plan
	) {
		return true;
	}
	return nowMs - previous.lastSeenMs >= FLEET_HEARTBEAT_MS;
}

/** Creates the table. Idempotent, so every caller may run it. */
export async function ensureFleetTable(db: FleetDb): Promise<void> {
	await db.prepare(FLEET_DDL).bind().run();
}

/** Writes one site's row, replacing whatever was there. */
export async function reportSite(db: FleetDb, row: FleetRow): Promise<void> {
	await db
		.prepare(
			`INSERT INTO cfw_fleet (site, pack_generation, core_version, worker_version, plan, last_seen_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(site) DO UPDATE SET
         pack_generation = excluded.pack_generation,
         core_version = excluded.core_version,
         worker_version = excluded.worker_version,
         plan = excluded.plan,
         last_seen_ms = excluded.last_seen_ms`
		)
		.bind(
			row.site,
			row.packGeneration,
			row.coreVersion,
			row.workerVersion,
			row.plan,
			Math.floor(row.lastSeenMs)
		)
		.run();
}

/** @returns every site's row */
export async function listSites(db: FleetDb): Promise<FleetRow[]> {
	const { results } = await db
		.prepare(
			'SELECT site, pack_generation, core_version, worker_version, plan, last_seen_ms FROM cfw_fleet ORDER BY site'
		)
		.bind()
		.all<Record<string, unknown>>();
	return results.map((r) => ({
		site: String(r.site),
		packGeneration: String(r.pack_generation),
		coreVersion: String(r.core_version),
		workerVersion: String(r.worker_version),
		plan: String(r.plan) === 'paid' ? 'paid' : 'free',
		lastSeenMs: Number(r.last_seen_ms)
	}));
}

export type WarmTargets = {
	/** the sites the cron should open a window on */
	sites: string[];
	source: 'fleet' | 'configured' | 'none';
	/** configured names no site has ever reported; driving one CREATES an empty object */
	unknown: string[];
	/** reported once but not within the heartbeat, so warming them spends the meter on a guess */
	stale: string[];
};

/**
 * Which sites the cron warm window should drive.
 *
 * `idFromName()` CREATES the object it names, so a cron pointed at an unused name provisions a
 * phantom and reports success -- which is what `WINDOW_SITES` defaulting to `'default'` did. A
 * configured list is a FILTER only; a name the fleet has never seen comes back under `unknown`.
 *
 * @param fleet every reported row, or `null` when there is no D1 binding to read
 */
export function warmTargets(
	fleet: readonly FleetRow[] | null,
	configured: readonly string[],
	nowMs: number,
	staleMs: number = FLEET_HEARTBEAT_MS
): WarmTargets {
	// no inventory to check against, so the configured list is all there is and is taken on trust.
	// An empty one drives NOTHING, which is the point -- there is no safe name to guess.
	if (fleet === null) {
		return {
			sites: [...configured],
			source: configured.length ? 'configured' : 'none',
			unknown: [],
			stale: []
		};
	}
	const fresh = new Set<string>();
	const stale: string[] = [];
	for (const row of fleet) {
		if (nowMs - row.lastSeenMs < staleMs) fresh.add(row.site);
		else stale.push(row.site);
	}
	stale.sort();
	if (configured.length === 0) {
		const sites = [...fresh].sort();
		return { sites, source: sites.length ? 'fleet' : 'none', unknown: [], stale };
	}
	const seen = new Set(fleet.map((r) => r.site));
	const sites = configured.filter((s) => fresh.has(s));
	return {
		sites,
		source: sites.length ? 'configured' : 'none',
		unknown: configured.filter((s) => !seen.has(s)).sort(),
		stale: configured.filter((s) => seen.has(s) && !fresh.has(s)).sort()
	};
}

/** one version and how much of the fleet is on it */
export type VersionShare = { version: string; sites: number; fraction: number };

export type FleetSummary = {
	sites: number;
	byPackGeneration: VersionShare[];
	byCoreVersion: VersionShare[];
	/** sites whose last report is older than the heartbeat, so their state is not current */
	stale: string[];
};

/**
 * What a rollout needs to know before it starts and to know when it is finished.
 *
 * `stale` is reported separately rather than folded into the version counts, because a site that
 * has not checked in is NOT evidence that it is on the old version -- it is evidence of nothing,
 * and counting it either way would make "100% patched" a claim about sites nobody has heard from.
 */
export function fleetSummary(rows: FleetRow[], nowMs: number): FleetSummary {
	const total = rows.length;
	const share = (pick: (r: FleetRow) => string): VersionShare[] => {
		const counts = new Map<string, number>();
		for (const row of rows) counts.set(pick(row), (counts.get(pick(row)) ?? 0) + 1);
		return [...counts.entries()]
			.map(([version, sites]) => ({
				version,
				sites,
				fraction: total ? Number((sites / total).toFixed(4)) : 0
			}))
			.sort((a, b) => b.sites - a.sites || a.version.localeCompare(b.version));
	};
	return {
		sites: total,
		byPackGeneration: share((r) => r.packGeneration),
		byCoreVersion: share((r) => r.coreVersion),
		stale: rows
			.filter((r) => nowMs - r.lastSeenMs >= FLEET_HEARTBEAT_MS)
			.map((r) => r.site)
			.sort()
	};
}

/**
 * How far a rollout has got, as a fraction of the sites that have reported.
 *
 * @returns `null` when nothing has reported, rather than 0 -- "no sites are patched" and "there are
 *   no sites" are different answers and only one of them means something is wrong.
 */
export function rolloutProgress(
	rows: FleetRow[],
	targetPackGeneration: string
): { patched: number; total: number; fraction: number } | null {
	if (rows.length === 0) return null;
	const patched = rows.filter((r) => r.packGeneration === targetPackGeneration).length;
	return {
		patched,
		total: rows.length,
		fraction: Number((patched / rows.length).toFixed(4))
	};
}
