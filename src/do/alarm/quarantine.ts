import { latestImport, storedImportLoader } from '../../db/import-sql';
import { chunksPerInvocation, SqlMigrator } from '../../db/migrate-sql';
import { isQuarantined, parseState, type RepairState, shouldRollback } from '../../ops/repair';
import type { SitePhpDurableObject } from '../../site-do';
import type { AlarmContext, AlarmEnd } from './context';

/**
 * A quarantined site stops writing and filling and keeps serving, so a fault shows visitors a
 * stale site instead of no site. Checked here because a check inside the fill lane pays its boot.
 */
export function quarantinePhase({ site }: AlarmContext): Promise<AlarmEnd> | undefined {
	const repair = parseState(site.metaGet('repair_state'));
	if (!isQuarantined(repair)) return undefined;
	return quarantineFiring(site, repair);
}

async function quarantineFiring(
	site: SitePhpDurableObject,
	repair: RepairState
): Promise<AlarmEnd> {
	const point = latestImport(site.sql);
	const decision = shouldRollback(repair, point, site.nowMs());
	if (decision.rollback && point) {
		const restore = new SqlMigrator({
			sql: site.sql,
			storage: site.storage,
			now: () => site.nowMs(),
			...storedImportLoader(site.sql, Number(point.id))
		});
		// the cursor this advances is the one /__serve reads, so the site stays 503 until it lands
		const out = await restore.step({ maxChunks: chunksPerInvocation(site.env) });
		site.lastAlarmOutcome = { rollback: decision, restore: out };
		site.alarmFirings = (site.alarmFirings ?? 0) + 1;
		site.alarmRearms = (site.alarmRearms ?? 0) + 1;
		await site.setAlarmAt(site.nowMs() + (out.done ? 60_000 : 1));
		return { outcome: site.lastAlarmOutcome };
	}
	site.lastAlarmOutcome = {
		skipped: 'quarantined',
		rung: repair.rung,
		code: repair.code,
		strikes: repair.strikes,
		rollback: decision
	};
	site.alarmFirings = (site.alarmFirings ?? 0) + 1;
	site.alarmRearms = (site.alarmRearms ?? 0) + 1;
	// nothing is urgent while the site still serves
	await site.setAlarmAt(site.nowMs() + 60_000);
	return { outcome: site.lastAlarmOutcome };
}
