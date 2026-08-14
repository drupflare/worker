/** the ladder's rungs, mirroring `RepairLadder::RUNGS` in the PHP module */
export const RUNGS = [
	'observe',
	'reset',
	'reconstruct',
	'reconfigure',
	'quarantine',
	'rollback'
] as const;

export type Rung = (typeof RUNGS)[number];

/** consecutive same-code failures before quarantine; below this the lower rungs own the problem */
export const QUARANTINE_STRIKES = 3;

/**
 * Consecutive failures before a rollback is even considered, ON TOP of being quarantined.
 *
 * Deliberately much higher than the quarantine threshold: a quarantined site is still serving, so there
 * is no urgency, and the cost of being wrong is a user's content.
 */
export const ROLLBACK_STRIKES = 10;

export type RepairState = {
	rung: Rung;
	/** the failure code the strikes belong to; a different code resets the count */
	code: string | null;
	strikes: number;
	quarantinedAt: number | null;
	lastRollbackAt: number | null;
};

export const CLEAN_STATE: RepairState = {
	rung: 'observe',
	code: null,
	strikes: 0,
	quarantinedAt: null,
	lastRollbackAt: null
};

/**
 * Folds one outcome into the state.
 *
 * A DIFFERENT failure code resets the strike count rather than adding to it. Two unrelated faults are not
 * evidence of one durable condition, and summing them is how a site gets quarantined for having two
 * different bad days.
 */
export function recordOutcome(
	state: RepairState,
	outcome: { ok: boolean; code?: string | null },
	nowMs: number
): RepairState {
	if (outcome.ok) {
		// a clean pass clears the strikes but does NOT un-quarantine: leaving quarantine is a separate,
		// deliberate act, because one good render says nothing about the condition that caused it
		return { ...state, code: null, strikes: 0 };
	}
	const code = outcome.code ?? 'unknown';
	const strikes = state.code === code ? state.strikes + 1 : 1;
	const next: RepairState = { ...state, code, strikes };

	if (strikes >= QUARANTINE_STRIKES && state.rung !== 'rollback' && state.rung !== 'quarantine') {
		return { ...next, rung: 'quarantine', quarantinedAt: nowMs };
	}
	return next;
}

/** whether writes and the fill lane must stop */
export function isQuarantined(state: RepairState): boolean {
	return state.rung === 'quarantine' || state.rung === 'rollback';
}

export type RollbackDecision = {
	rollback: boolean;
	reason: string;
};

/**
 * Whether to roll back, and it says no for a named reason far more often than it says yes.
 *
 * Requires all three: quarantined already, `ROLLBACK_STRIKES` consecutive failures of the SAME code, and
 * a restore point that actually exists. The last one is not a formality -- rolling back to nothing would
 * leave a site with no database at all, which is strictly worse than the fault being repaired.
 */
export function shouldRollback(
	state: RepairState,
	restorePoint: { id: number; statements: number } | null
): RollbackDecision {
	if (!isQuarantined(state)) {
		return { rollback: false, reason: 'not quarantined; the lower rungs own this' };
	}
	if (state.strikes < ROLLBACK_STRIKES) {
		return {
			rollback: false,
			reason: `${state.strikes}/${ROLLBACK_STRIKES} consecutive failures of ${state.code}`
		};
	}
	if (!restorePoint) {
		// the important refusal: a quarantined site still serves, and a rollback to nothing does not
		return {
			rollback: false,
			reason: 'no restore point exists; staying quarantined is strictly better than reverting to nothing'
		};
	}
	if (restorePoint.statements <= 0) {
		return { rollback: false, reason: `restore point ${restorePoint.id} is empty` };
	}
	return {
		rollback: true,
		reason: `${state.strikes} consecutive failures of ${state.code}; replaying restore point ${restorePoint.id} (${restorePoint.statements} statements)`
	};
}

/** serialises for `cfw_meta`; a plain string because that column is TEXT */
export function serialiseState(state: RepairState): string {
	return JSON.stringify(state);
}

/**
 * Reads the state back, defaulting to clean on anything unexpected.
 *
 * A corrupt state row must not quarantine a healthy site, and it must not un-quarantine a sick one either
 * -- so the default is clean and the caller re-derives from live outcomes rather than trusting a partial
 * parse.
 */
export function parseState(raw: string | null | undefined): RepairState {
	if (!raw) return { ...CLEAN_STATE };
	try {
		const parsed = JSON.parse(raw) as Partial<RepairState>;
		const rung = RUNGS.includes(parsed.rung as Rung) ? (parsed.rung as Rung) : 'observe';
		return {
			rung,
			code: typeof parsed.code === 'string' ? parsed.code : null,
			strikes: Number.isFinite(parsed.strikes) ? Math.max(0, Number(parsed.strikes)) : 0,
			quarantinedAt: Number.isFinite(parsed.quarantinedAt)
				? Number(parsed.quarantinedAt)
				: null,
			lastRollbackAt: Number.isFinite(parsed.lastRollbackAt)
				? Number(parsed.lastRollbackAt)
				: null
		};
	} catch {
		return { ...CLEAN_STATE };
	}
}

/** clears quarantine after a successful repair; deliberate and explicit, never automatic */
export function release(state: RepairState, nowMs: number): RepairState {
	return {
		rung: 'observe',
		code: null,
		strikes: 0,
		quarantinedAt: null,
		lastRollbackAt: state.rung === 'rollback' ? nowMs : state.lastRollbackAt
	};
}
