import { fanoutDecision, ROWS_PER_TAGGED_PAGE, ROWS_PER_UNTAGGED_PAGE } from '../ops/fanout';
import { pageKvEnabled } from '../ops/page-store';
import { routeFamilies } from '../ops/thermal';
import type { SitePhpDurableObject } from '../site-do';
import { firstRow } from '../util/sql';
import { prefillOnSave, prefillOnSaveLimit, saveDebounceMs } from './levers';
import { FILL_QUEUE_MAX } from './limits';
import { purgeShellsFor } from './shell';
import type { Row } from './types';

/**
 * The stored pages that depend on any of `tags`, or undefined when the index cannot answer.
 *
 * Undefined is not an empty set: an unindexed tag may mean no page depends on it or that the site
 * served before the index existed. A missed scoped purge shows visibly wrong content, worse than
 * an extra fill, so undefined sends the caller to a wholesale purge.
 */
export function pathsForTags(
	site: SitePhpDurableObject,
	tags: readonly string[]
): string[] | undefined {
	if (tags.length === 0) return undefined;
	const wanted = new Set(tags);
	const rows = site.sql
		.exec<Row<{ path: string; tags: string | null }>>('SELECT path, tags FROM cfw_page')
		.toArray();
	const paths: string[] = [];
	for (const row of rows) {
		// one page with no recorded tags makes the whole answer unsafe
		if (row.tags === null || row.tags === undefined) return undefined;
		let held: string[];
		try {
			const parsed: unknown = JSON.parse(String(row.tags));
			if (!Array.isArray(parsed)) return undefined;
			held = parsed.map((t) => String(t));
		} catch {
			return undefined;
		}
		if (held.some((t) => wanted.has(t))) paths.push(String(row.path));
	}
	return paths;
}

/**
 * Invalidates only the pages that depend on `tags`, or everything when {@link pathsForTags}
 * cannot tell. A wholesale purge re-queues `PREFILL_ON_SAVE` paths per save (50 saves/day is ~99%
 * of free's fill budget); a node save's real set is 3 to 10 pages.
 */
export function purgeForTags(
	site: SitePhpDurableObject,
	tags: readonly string[],
	reason = 'cachetags',
	{ bump = true } = {}
) {
	const paths = site.pathsForTags(tags);
	site.ensureServeTables();
	// the only caller that may apply shell purging: `purgeShellsForTags()` drops a shell for any
	// unaccounted tag, so it is correct only on a complete set (here, not at the `cachetags` bump)
	const shells = purgeShellsFor(site, tags, paths === undefined);
	if (paths === undefined) {
		const out = bump
			? site.bumpGeneration(reason)
			: purgeScopedPaths(
					site,
					site.sql
						.exec<Row<{ path: string }>>('SELECT path FROM cfw_page')
						.toArray()
						.map((r) => String(r.path)),
					true,
					// most of what this re-queues does not depend on the tags and just reassembles
					ROWS_PER_UNTAGGED_PAGE
				);
		return {
			...out,
			scoped: false,
			tags: tags.length,
			purged: Number(out.purgedPages ?? 0),
			shells
		};
	}
	const out = bump
		? site.bumpGeneration(reason, { scopedTo: paths })
		: // each depends on an invalidated tag, so each is a real re-render
			purgeScopedPaths(site, paths, true, ROWS_PER_TAGGED_PAGE);
	return { ...out, scoped: true, tags: tags.length, purged: paths.length, shells };
}

/**
 * Deletes exactly these pages and re-queues them, without touching the generation.
 *
 * The generation already moved with the `cachetags` write; moving it again would leave the front
 * worker one behind for its trust window.
 */
export function purgeScopedPaths(
	site: SitePhpDurableObject,
	paths: readonly string[],
	arm = true,
	rowsPerPage: number = ROWS_PER_TAGGED_PAGE
) {
	site.ensureServeTables();
	let purgedPages = 0;
	for (const path of paths) {
		site.sql.exec('DELETE FROM cfw_page WHERE path = ?', path);
		purgedPages++;
	}
	// prewarm the family, not just the URLs: the page cache is keyed on the URL but what is cold is
	// the interpreter, so one representative per family covers the rest
	const families = routeFamilies(paths);
	// fanout picks eager or lazy (lazy needs the `PAGE_KV` stale tier); weighted by rows, since a
	// page costs 2 with a surviving `dynamic_page_cache` entry and 9 without
	const decision = fanoutDecision(
		paths.length,
		prefillOnSaveLimit(site.env),
		pageKvEnabled(site.env as never),
		rowsPerPage
	);
	let requeued = 0;
	if (prefillOnSave(site.env)) {
		for (const path of paths.slice(0, decision.requeue)) {
			site.sql.exec(
				'INSERT INTO cfw_fill_queue (path, queued_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING',
				path,
				site.nowMs()
			);
			requeued++;
		}
		// a family representative is queued even when lazy: one path buys the boot for the family
		for (const path of families) {
			if (site.queueDepth() >= FILL_QUEUE_MAX) break;
			site.sql.exec(
				'INSERT INTO cfw_fill_queue (path, queued_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING',
				path,
				site.nowMs()
			);
		}
		if (requeued > 0 && arm && decision.armNow) site.armFillAlarm(saveDebounceMs(site.env));
	}
	// `bumpCoalesced` latches for the incarnation and `bumpGeneration()` owns it; resetting it here
	// would let one save bump twice
	return {
		purgedPages,
		requeued,
		policy: decision.policy,
		reason: decision.reason,
		generation: site.generation()
	};
}

/**
 * Invalidates the whole site by bumping the counter, which orphans the edge entries.
 *
 * @param arm - false requeues without waking the chain; a long write needs that, since
 *   `armFillAlarm()` schedules at +1 ms and a fill would start mid-write
 */
export function bumpGeneration(
	site: SitePhpDurableObject,
	reason = 'manual',
	{
		arm = true,
		invalidatedTags,
		scopedTo
	}: { arm?: boolean; invalidatedTags?: string[]; scopedTo?: string[] } = {}
) {
	site.ensureServeTables();
	const next = site.generation() + 1;

	// save-triggered prefill: read the paths before they are marked, and re-queue them so the next
	// visitor gets a HIT
	const doomed =
		scopedTo === undefined
			? site.sql
					.exec<Row<{ path: string }>>(
						'SELECT path FROM cfw_page ORDER BY rendered_at DESC LIMIT ?',
						prefillOnSaveLimit(site.env) + 1
					)
					.toArray()
					.map((r) => String(r.path))
			: scopedTo;
	const limit = prefillOnSaveLimit(site.env);
	const requeue = doomed.slice(0, limit);
	// a site with more cached pages than the cap loses the tail (the cap protects the rows meter)
	const droppedFromRequeue = Math.max(0, doomed.length - requeue.length);

	// superseded, not deleted (an empty `cfw_page` 503s every visitor); staleness derives from the
	// tag checksum, so only unchecksummed rows are marked, and only on `cachetags`
	const now = site.nowMs();
	const derivable = reason === 'cachetags';
	const wholesale = derivable
		? 'UPDATE cfw_page SET stale_at = ? WHERE stale_at IS NULL AND tag_checksum IS NULL'
		: 'UPDATE cfw_page SET stale_at = ? WHERE stale_at IS NULL';
	const scoped = derivable
		? 'UPDATE cfw_page SET stale_at = ? WHERE path = ? AND stale_at IS NULL AND tag_checksum IS NULL'
		: 'UPDATE cfw_page SET stale_at = ? WHERE path = ? AND stale_at IS NULL';
	let purgedPages: number;
	if (scopedTo === undefined) {
		purgedPages = Number(
			firstRow(site.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_page'))?.c ??
				0
		);
		site.sql.exec(wholesale, now);
	} else {
		purgedPages = 0;
		for (const path of scopedTo) {
			site.sql.exec(scoped, now, path);
			purgedPages++;
		}
	}
	// without `cachetags` Drupal is not told, so a refill would re-store identical HTML
	const purgedDynamic = reason === 'cachetags' ? 0 : site.purgeDynamicPageCache();
	// a `cachetags` bump fires before the tag set is whole; `flushTagPurge()` purges shells once it
	// is (`drainPendingTags()` at boot if the invocation dies); other reasons delete wholesale
	const purgedShells =
		reason === 'cachetags'
			? 0
			: Number(
					firstRow(
						site.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_shell')
					)?.c ?? 0
				);
	if (purgedShells > 0) {
		site.sql.exec('DELETE FROM cfw_shell');
		site.sql.exec('DELETE FROM cfw_shell_verified');
	}
	// plans likewise wait for the whole tag set: `stalePlans()` flags at the write and
	// `settlePlans()` judges at the end; other reasons take the wholesale delete
	void invalidatedTags;
	const purgedPlans = reason === 'cachetags' ? 0 : site.purgePlansFor();
	// content moved, so a path that could not be shelled may be now
	site.shellSeedFailed.clear();
	site.metaSet('generation', next);
	site.metaSet('last_bump', `${next}:${reason}:${site.nowMs()}`);
	site.bumps = (site.bumps ?? 0) + 1;

	let requeued = 0;
	if (prefillOnSave(site.env)) {
		for (const path of requeue) {
			site.sql.exec(
				'INSERT INTO cfw_fill_queue (path, queued_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING',
				path,
				site.nowMs()
			);
			requeued++;
		}
		// a bump is not otherwise a wake-up for the chain
		if (requeued > 0 && arm) site.armFillAlarm(saveDebounceMs(site.env));
	}

	return {
		generation: next,
		reason,
		purgedPages,
		purgedShells,
		purgedPlans,
		purgedDynamic,
		requeued,
		droppedFromRequeue
	};
}
