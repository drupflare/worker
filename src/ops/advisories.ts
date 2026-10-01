/**
 * What the update module found, read without booting a kernel.
 *
 * The record is JSON in a state row written by the module's cron sweep: `update_project_data` is
 * a nested serialized PHP array, but a JSON string is a serialized scalar that
 * {@link serializedScalar} reads with one regex, so the structure crosses as a string.
 * @module
 */
import { serializedScalar } from './updb';

/** the state key the module writes; spelled the same as `AdvisoryScan::STATE_KEY` */
export const ADVISORY_STATE_KEY = 'drupflare.advisories';

/** the record shape this reader accepts; `AdvisoryScan::SCHEMA` */
export const ADVISORY_SCHEMA = 1;

/** one project the scan flagged */
export type AdvisoryEntry = {
	project: string;
	installed: string;
	recommended: string;
	/** why it is insecure; absent on a merely stale project */
	why?: string;
};

/** what the module's cron sweep records */
export type AdvisoryRecord = {
	schema: number;
	at: number;
	/** whether the scan had project data to read at all */
	checked: boolean;
	reason: string;
	insecure: AdvisoryEntry[];
	stale: AdvisoryEntry[];
};

/** what an operator is told about a site's advisories */
export type AdvisoryVerdict = {
	/** the strongest thing that can be said (`unknown` is a real answer) */
	state: 'insecure' | 'stale' | 'current' | 'unknown';
	/** how many projects carry an advisory */
	insecure: number;
	stale: number;
	/** when the scan ran, epoch seconds; 0 when nothing has been recorded */
	at: number;
	/** one sentence an operator can act on */
	detail: string;
	projects: AdvisoryEntry[];
};

const UNKNOWN = (detail: string): AdvisoryVerdict => ({
	state: 'unknown',
	insecure: 0,
	stale: 0,
	at: 0,
	detail,
	projects: []
});

/**
 * Reads one site's advisory record.
 *
 * Every unreadable case (no sweep yet, an unknown schema, a fetch still queued) answers `unknown`,
 * never `current`: `current` on an unchecked site is false.
 *
 * @param blob - the raw `key_value.value` cell for `state` / `drupflare.advisories`.
 */
export function readAdvisories(blob: unknown): AdvisoryVerdict {
	const scalar = serializedScalar(blob);
	if (scalar === undefined || scalar.kind !== 'string') {
		return UNKNOWN('no advisory scan has been recorded for this site');
	}

	let record: AdvisoryRecord | null;
	try {
		record = JSON.parse(String(scalar.value)) as AdvisoryRecord | null;
	} catch {
		return UNKNOWN('the advisory record is not readable JSON');
	}
	if (record === null || typeof record !== 'object') {
		return UNKNOWN('the advisory record is not an object');
	}
	if (record.schema !== ADVISORY_SCHEMA) {
		// a newer record may carry a status this reader cannot classify (no guessing)
		return UNKNOWN(
			`the advisory record is schema ${record.schema}, and this reads ${ADVISORY_SCHEMA}`
		);
	}

	const at = Number.isFinite(record.at) ? Number(record.at) : 0;
	if (record.checked !== true) {
		return { ...UNKNOWN(record.reason || 'the scan had nothing to read'), at };
	}

	const insecure = Array.isArray(record.insecure) ? record.insecure : [];
	const stale = Array.isArray(record.stale) ? record.stale : [];

	if (insecure.length > 0) {
		return {
			state: 'insecure',
			insecure: insecure.length,
			stale: stale.length,
			at,
			detail: `${insecure.length} project(s) carry a security advisory: ${insecure
				.map((p) => `${p.project} ${p.installed} -> ${p.recommended}`)
				.join(', ')}`,
			projects: insecure
		};
	}
	if (stale.length > 0) {
		return {
			state: 'stale',
			insecure: 0,
			stale: stale.length,
			at,
			detail: `${stale.length} project(s) are behind, with no advisory attached`,
			projects: stale
		};
	}
	return {
		state: 'current',
		insecure: 0,
		stale: 0,
		at,
		detail: 'every project is current',
		projects: []
	};
}

/**
 * How old a scan may be before its answer stops meaning anything (an advisory is published against
 * the world, so an old record says nothing about it); the bound is for a stopped chain.
 */
export const ADVISORY_STALE_AFTER_S = 7 * 24 * 60 * 60;

/**
 * Whether an advisory verdict should be acted on, given when it was taken.
 *
 * A verdict older than the bound is downgraded to `unknown` ("clean a fortnight ago" is not clean).
 */
export function advisoryFreshness(
	verdict: AdvisoryVerdict,
	nowS: number
): { fresh: boolean; ageS: number } {
	if (verdict.at <= 0) return { fresh: false, ageS: Number.POSITIVE_INFINITY };
	const ageS = Math.max(0, Math.floor(nowS) - verdict.at);
	return { fresh: ageS <= ADVISORY_STALE_AFTER_S, ageS };
}
