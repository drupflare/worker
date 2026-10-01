/** the ladder's rungs, mirroring `RepairLadder::RUNGS` in the PHP module */
export const RUNGS = [
	'observe',
	'reset',
	'reconstruct',
	'reconfigure',
	'quarantine',
	'rollback'
] as const;

/** one rung of the repair ladder */
export type Rung = (typeof RUNGS)[number];

/** consecutive same-code failures before quarantine; below this the lower rungs own the problem */
export const QUARANTINE_STRIKES = 3;

/** dwell in time; strikes freeze at quarantine, so any strike threshold above it is unreachable */
export const ROLLBACK_DWELL_MS = 30 * 60_000;

/** where a site sits on the ladder and the strikes that put it there */
export type RepairState = {
	rung: Rung;
	/** the failure code the strikes belong to; a different code resets the count */
	code: string | null;
	strikes: number;
	quarantinedAt: number | null;
	lastRollbackAt: number | null;
};

/** the state of a site with no recorded failures */
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
 * A different failure code resets the strike count: two unrelated faults are not one durable
 * condition, and summing them would quarantine a site for two bad days.
 */
export function recordOutcome(
	state: RepairState,
	outcome: { ok: boolean; code?: string },
	nowMs: number
): RepairState {
	if (outcome.ok) {
		// a clean pass clears the strikes but does NOT un-quarantine: leaving quarantine is a
		// separate explicit act, because one good render says nothing about what caused the fault
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

/** whether to roll back, and the reason either way */
export type RollbackDecision = {
	rollback: boolean;
	reason: string;
};

/**
 * Whether to roll back; it usually says no, with a named reason.
 *
 * Requires quarantine, {@link ROLLBACK_DWELL_MS} of dwell and an existing restore point (reverting
 * to nothing is worse than the fault).
 */
export function shouldRollback(
	state: RepairState,
	restorePoint: { id: number; statements: number } | undefined,
	nowMs: number
): RollbackDecision {
	if (!isQuarantined(state)) {
		return { rollback: false, reason: 'not quarantined; the lower rungs own this' };
	}
	// a quarantined state with no timestamp predates this field; treat it as just-quarantined so
	// an upgrade cannot roll a site back on its first alarm
	const since = state.quarantinedAt;
	if (since === null) {
		return { rollback: false, reason: 'quarantined with no timestamp; waiting for the dwell' };
	}
	const held = nowMs - since;
	if (held < ROLLBACK_DWELL_MS) {
		return {
			rollback: false,
			reason: `quarantined ${Math.max(0, Math.round(held / 1000))}s of ${ROLLBACK_DWELL_MS / 1000}s for ${state.code}`
		};
	}
	if (!restorePoint) {
		// a quarantined site still serves; a rollback to nothing would not
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
		reason: `quarantined ${Math.round(held / 60_000)}m for ${state.code}; replaying restore point ${restorePoint.id} (${restorePoint.statements} statements)`
	};
}

/** serialises for `cfw_meta`; a plain string because that column is TEXT */
export function serialiseState(state: RepairState): string {
	return JSON.stringify(state);
}

/**
 * Reads the state back, defaulting to clean on anything unexpected, so a corrupt row neither
 * quarantines a healthy site nor un-quarantines a sick one; the caller re-derives from outcomes.
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

/** clears quarantine after a successful repair; explicit, never automatic */
export function release(state: RepairState, nowMs: number): RepairState {
	return {
		rung: 'observe',
		code: null,
		strikes: 0,
		quarantinedAt: null,
		lastRollbackAt: state.rung === 'rollback' ? nowMs : state.lastRollbackAt
	};
}
