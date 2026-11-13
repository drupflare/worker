import { purgeExpiredUploads } from '../../db/restore-parts';
import type { AlarmContext } from './context';

/**
 * Removes paged-restore uploads past their expiry, so a client that never came back does not leave
 * its parts in the object. One count read decides; a site with no upload table costs the failed
 * read and nothing else.
 */
export function restorePartsPhase({ site }: AlarmContext): undefined {
	const open = site.countOrNull(
		'cfw_restore_upload',
		`expires_at <= ${Math.floor(site.nowMs())}`
	);
	if (open !== null && open > 0) purgeExpiredUploads(site.sql, site.storage, site.nowMs());
	return undefined;
}
