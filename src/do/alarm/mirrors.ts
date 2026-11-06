import {
	drainHydrates,
	drainMirrors,
	evictMirrored,
	nextEvictionAt,
	queueBackfill,
	r2OpsSpent,
	reconcileForeign,
	type HydrateDrain,
	type MirrorBucket,
	type MirrorDrain
} from '../../db/file-store';
import { drainPageMirrors } from '../../ops/page-mirror';
import type { SitePhpDurableObject } from '../../site-do';
import { errorMessage } from '../../util/errors';
import { fileEvictAfterMs, mirrorLimit } from '../levers';
import type { PageRow } from '../types';
import type { AlarmContext } from './context';

/**
 * The R2 file and page mirrors. A page answered from an R2 custom domain costs no Worker request,
 * and Worker requests bind the serving ceiling. No bucket bound is the free default, not an error.
 * Under `FILE_STORE=r2` restores and evictions still run on a spent write budget: neither writes
 * to R2, and a file must stay readable and leave the object either way.
 */
export function mirrorsPhase({ site }: AlarmContext): Promise<void> | undefined {
	const bucket = site.mirrorBucket();
	const r2Left = bucket ? site.r2Allowance().left : 0;
	// a spent R2 budget stops both mirrors; everything still serves from the object
	if (bucket && r2Left === 0) {
		site.lastMirrorDrain = { at: Date.now(), value: { budgetSpent: site.r2Allowance() } };
	}
	if (bucket && (r2Left > 0 || site.fileStoreR2())) return drainBoth(site, bucket, r2Left);
	return undefined;
}

/** what one file-store pass did; the `FILE_STORE=r2` parts are absent otherwise */
export type FileOffload = {
	drained?: MirrorDrain;
	restored?: HydrateDrain;
	evicted?: { evicted: number; bytes: number };
	queuedBackfill?: number;
	/** files found under another site's prefix after a restore, and queued to be copied */
	foreign?: { resident: number; offloaded: number; refused: number };
};

/**
 * One pass over the file store: backfill once, restore, put, then evict. The write budget gates
 * only the puts; `left` is what remains of it.
 */
export async function offloadFiles(
	site: SitePhpDurableObject,
	bucket: MirrorBucket,
	opts: { limit: number; left: number }
): Promise<FileOffload> {
	const out: FileOffload = {};
	const store = site.fileStoreR2();
	// a restore clears the pinned name until the next request; keys under the literal fallback would
	// belong to no site, so R2 mode waits for the name
	if (store && site.siteName() === 'site') return out;
	const buckets = site.fileBuckets();
	const nowMs = site.nowMs();
	if (store) {
		const schemes = site.fileSchemes();
		const flag = `file_backfill:${schemes.join('+')}`;
		if (site.metaGet(flag) === null) {
			out.queuedBackfill = queueBackfill(site.sql, nowMs, schemes);
			site.metaSet(flag, nowMs);
		}
		// the rows came from whichever site last verified them; after a restore that is not this one.
		// `cfw_meta` carries the name through a dump, so a change of it is the trigger, and the scan
		// is skipped until the name has been learned from a request
		const own = site.siteName();
		if (own !== 'site' && site.metaGet('file_site') !== own) {
			out.foreign = reconcileForeign(
				site.sql,
				own,
				nowMs,
				schemes,
				await site.trustedFileSources()
			);
			site.metaSet('file_site', own);
		}
		out.restored = await drainHydrates(site.sql, buckets, {
			limit: opts.limit,
			site: own,
			nowMs,
			schemes,
			trust: () => site.trustedFileSources()
		});
	}
	if (opts.left > 0) {
		out.drained = await drainMirrors(site.sql, bucket, {
			limit: Math.min(opts.limit, opts.left),
			site: site.siteName(),
			...(store
				? {
						privateBucket: buckets.private,
						verify: true,
						trust: () => site.trustedFileSources()
					}
				: {})
		});
		site.chargeR2(r2OpsSpent(out.drained));
	}
	if (store) {
		const graceMs = fileEvictAfterMs(site.env);
		out.evicted = evictMirrored(site.sql, {
			nowMs: site.nowMs(),
			graceMs,
			limit: opts.limit,
			schemes: site.fileSchemes(),
			site: site.siteName()
		});
		// the grace window is longer than any alarm cadence, so name the moment it ends
		const due = nextEvictionAt(site.sql, graceMs, site.siteName());
		if (due !== undefined) site.armFillAlarm(Math.max(1_000, due - site.nowMs()));
	}
	return out;
}

async function drainBoth(
	site: SitePhpDurableObject,
	bucket: MirrorBucket,
	start: number
): Promise<void> {
	let r2Left = start;
	try {
		const offload = await offloadFiles(site, bucket, {
			limit: mirrorLimit(site.env),
			left: r2Left
		});
		const drained = offload.drained;
		if (drained) r2Left -= r2OpsSpent(drained);
		const moved =
			(drained?.mirrored ?? 0) +
			(drained?.deleted ?? 0) +
			(drained?.refused ?? 0) +
			(drained?.adopted ?? 0) +
			(offload.restored?.hydrated ?? 0) +
			(offload.evicted?.evicted ?? 0);
		if (moved > 0) {
			site.lastMirrorDrain = {
				at: Date.now(),
				value: drained && !site.fileStoreR2() ? drained : { ...offload }
			};
		}
	} catch (e) {
		site.lastMirrorDrain = { at: Date.now(), value: { error: errorMessage(e) } };
	}

	// ordered by view count, so a limited budget publishes the pages that move the most traffic
	if (r2Left > 0) {
		try {
			const pages = await drainPageMirrors(
				site.sql,
				bucket,
				(p) =>
					site.sql
						.exec<PageRow>(
							'SELECT status, content_type, html FROM cfw_page WHERE path = ?',
							p
						)
						.toArray()
						.map((r) => ({
							path: p,
							html: String(r.html),
							status: Number(r.status),
							contentType: String(r.content_type)
						}))[0],
				{
					limit: Math.min(mirrorLimit(site.env), r2Left),
					hits: site.pageHits,
					site: site.siteName()
				}
			);
			site.chargeR2(pages.mirrored + pages.failed);
			if (pages.mirrored + pages.failed + pages.refused > 0) {
				site.lastPageMirrorDrain = { at: Date.now(), value: pages };
			}
		} catch (e) {
			site.lastPageMirrorDrain = { at: Date.now(), value: { error: errorMessage(e) } };
		}
	}
}
