/**
 * What the update module found, read without booting a kernel.
 *
 * Rollout planning existed and detection did not, so a site could carry a known-insecure module
 * indefinitely with nothing saying so anywhere a fleet operator could see. The update module already
 * computes a status per project; this is the half that reads it.
 *
 * The record is JSON in a state row, written by the module's cron sweep. That shape is the whole
 * reason this file is short: `update_project_data` is a nested serialized PHP array, and decoding it
 * here would be a parser for however many shapes it takes. A JSON string is a serialized SCALAR,
 * which {@link serializedScalar} already handles with one regex, so the structure is understood in
 * the process that owns it and crosses as a string.
 */

import { serializedScalar } from './updb.js';

/** the state key the module writes; spelled the same as `AdvisoryScan::STATE_KEY` */
export const ADVISORY_STATE_KEY = 'drupflare.advisories';

/** the record shape this reader accepts; `AdvisoryScan::SCHEMA` */
export const ADVISORY_SCHEMA = 1;

export type AdvisoryEntry = {
	project: string;
	installed: string;
	recommended: string;
	/** why it is insecure; absent on a merely stale project */
	why?: string;
};

export type AdvisoryRecord = {
	schema: number;
	at: number;
	/** whether the scan had project data to read at all */
	checked: boolean;
	reason: string;
	insecure: AdvisoryEntry[];
	stale: AdvisoryEntry[];
};

export type AdvisoryVerdict = {
	/** the strongest thing that can be said, and `unknown` is a real answer here */
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
 * **Every unreadable case answers `unknown` rather than `current`.** A site that has never run the
 * sweep, one whose record is from a schema this does not know, and one whose update fetch is still
 * queued are all indistinguishable from a healthy site if the absence of advisories is reported as
 * their absence. That direction is how a security signal becomes noise: an operator who sees
 * `current` on a site nothing has checked has been told something false.
 *
 * @param blob - the raw `key_value.value` cell for `state` / `drupflare.advisories`.
 */
export function readAdvisories(blob: unknown): AdvisoryVerdict {
	const scalar = serializedScalar(blob);
	if (scalar === null || scalar.kind !== 'string') {
		return UNKNOWN('no advisory scan has been recorded for this site');
	}

	let record: AdvisoryRecord;
	try {
		record = JSON.parse(String(scalar.value)) as AdvisoryRecord;
	} catch {
		return UNKNOWN('the advisory record is not readable JSON');
	}
	if (record === null || typeof record !== 'object') {
		return UNKNOWN('the advisory record is not an object');
	}
	if (record.schema !== ADVISORY_SCHEMA) {
		// forward as well as backward: a NEWER record may carry a status this reader does not know
		// how to classify, and guessing at one is the false all-clear again
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
 * How old a scan may be before its answer stops meaning anything.
 *
 * An advisory is published against the world rather than against the site, so a record from before
 * the publication says nothing about it. Cron runs far more often than this; the bound exists for a
 * site whose chain has stopped.
 */
export const ADVISORY_STALE_AFTER_S = 7 * 24 * 60 * 60;

/**
 * Whether an advisory verdict should be acted on, given when it was taken.
 *
 * A verdict older than the bound is downgraded to `unknown` rather than trusted, for the same reason
 * an absent record is: "checked a fortnight ago and was clean" is not "clean".
 */
export function advisoryFreshness(
	verdict: AdvisoryVerdict,
	nowS: number
): { fresh: boolean; ageS: number } {
	if (verdict.at <= 0) return { fresh: false, ageS: Number.POSITIVE_INFINITY };
	const ageS = Math.max(0, Math.floor(nowS) - verdict.at);
	return { fresh: ageS <= ADVISORY_STALE_AFTER_S, ageS };
}
