import { drainMirrors, type MirrorBucket } from '../../db/file-store';
import { drainPageMirrors } from '../../ops/page-mirror';
import type { SitePhpDurableObject } from '../../site-do';
import { errorMessage } from '../../util/errors';
import { mirrorLimit } from '../levers';
import type { PageRow } from '../types';
import type { AlarmContext } from './context';

/**
 * The R2 file and page mirrors. A page answered from an R2 custom domain costs no Worker request,
 * and Worker requests bind the serving ceiling. No bucket bound is the free default, not an error.
 */
export function mirrorsPhase({ site }: AlarmContext): Promise<void> | undefined {
	const bucket = site.mirrorBucket();
	const r2Left = bucket ? site.r2Allowance().left : 0;
	// a spent R2 budget stops both mirrors; everything still serves from the object
	if (bucket && r2Left === 0) {
		site.lastMirrorDrain = { at: Date.now(), value: { budgetSpent: site.r2Allowance() } };
	}
	if (bucket && r2Left > 0) return drainBoth(site, bucket, r2Left);
	return undefined;
}

async function drainBoth(
	site: SitePhpDurableObject,
	bucket: MirrorBucket,
	start: number
): Promise<void> {
	let r2Left = start;
	try {
		const drained = await drainMirrors(site.sql, bucket, {
			limit: Math.min(mirrorLimit(site.env), r2Left),
			site: site.siteName()
		});
		const spent =
			drained.mirrored + drained.deleted + drained.failed + drained.droppedAfterStrikes;
		site.chargeR2(spent);
		r2Left -= spent;
		if (drained.mirrored + drained.deleted + drained.refused > 0) {
			site.lastMirrorDrain = { at: Date.now(), value: drained };
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
