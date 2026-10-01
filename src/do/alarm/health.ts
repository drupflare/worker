import { cronOptions, gcPass } from '../../ops/cron';
import { gcHealthLedger } from '../../ops/supervisor';
import { errorMessage } from '../../util/errors';
import type { AlarmContext } from './context';

/**
 * The health layer and garbage collection: after the fills (findings describe work done) and
 * before the re-arm (a site that just quarantined must not schedule a fill).
 */
export function healthPhase({ site, outcomes }: AlarmContext): undefined {
	const findings = site.supervise(outcomes);
	if (findings.length > 0) {
		site.lastAlarmOutcome = { outcomes, findings };
	}
	// interval-gated: GC spends the same row meter the fills do, and a visitor outranks it
	if (site.shouldRunGc()) {
		try {
			site.lastGc = gcPass(site.sql, cronOptions(site.env));
			site.lastGc.healthRowsTrimmed = gcHealthLedger(site.sql);
			site.lastGcAt = Date.now();
		} catch (e) {
			site.lastGc = { error: errorMessage(e) };
		}
	}
	return undefined;
}
