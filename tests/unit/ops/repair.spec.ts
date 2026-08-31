import { describe, expect, it } from 'vitest';
import {
	CLEAN_STATE,
	QUARANTINE_STRIKES,
	ROLLBACK_DWELL_MS,
	RUNGS,
	isQuarantined,
	parseState,
	recordOutcome,
	release,
	serialiseState,
	shouldRollback,
	type RepairState
} from '../../../src/ops/repair';

/**
 * Quarantine and rollback, the ladder's top two rungs. The ladder has declared them all along and
 * nothing executed them, because a rollback with no restore point is not a rollback -- `/export` produced a dump nothing could replay until
 * `src/db/import-sql.ts`.
 *
 * Almost every assertion here is a REFUSAL, which is the design rather than caution. Rollback discards
 * everything written since the restore point, so the failure that matters is not "it declined to repair"
 * but "it reverted a user's content because of one bad render". Quarantine keeps the site SERVING, so
 * there is never urgency to escalate past it.
 */

const fail = (code: string) => ({ ok: false, code });
const pass = { ok: true };

/** drives n consecutive failures of one code */
function strike(state: RepairState, code: string, times: number, at = 1000): RepairState {
	let s = state;
	for (let i = 0; i < times; i++) s = recordOutcome(s, fail(code), at + i);
	return s;
}

describe('the ladder mirrors the PHP module', () => {
	it('has the same six rungs in the same order', () => {
		expect(RUNGS).toEqual([
			'observe',
			'reset',
			'reconstruct',
			'reconfigure',
			'quarantine',
			'rollback'
		]);
	});
});

describe('quarantine needs repeated failures of the SAME code', () => {
	it('escalates after the strike threshold', () => {
		const s = strike(CLEAN_STATE, 'boom', QUARANTINE_STRIKES);
		expect(s.rung).toBe('quarantine');
		expect(s.quarantinedAt).not.toBeNull();
		expect(isQuarantined(s)).toBe(true);
	});

	it('does NOT escalate one strike short', () => {
		const s = strike(CLEAN_STATE, 'boom', QUARANTINE_STRIKES - 1);
		expect(s.rung).toBe('observe');
		expect(isQuarantined(s)).toBe(false);
	});

	it('RESETS the count when the failure code changes', () => {
		// two unrelated faults are not evidence of one durable condition, and summing them quarantines a
		// site for having two different bad days
		let s = strike(CLEAN_STATE, 'alpha', QUARANTINE_STRIKES - 1);
		s = recordOutcome(s, fail('beta'), 2000);
		expect(s.strikes).toBe(1);
		expect(s.rung).toBe('observe');
	});

	it('treats a missing code as its own code rather than as a wildcard', () => {
		let s = recordOutcome(CLEAN_STATE, { ok: false }, 1);
		s = recordOutcome(s, { ok: false }, 2);
		expect(s.code).toBe('unknown');
		expect(s.strikes).toBe(2);
	});

	it('clears strikes on a pass but does NOT leave quarantine', () => {
		// one good render says nothing about the condition that caused the quarantine, so release is a
		// separate explicit act
		let s = strike(CLEAN_STATE, 'boom', QUARANTINE_STRIKES);
		s = recordOutcome(s, pass, 5000);
		expect(s.strikes).toBe(0);
		expect(s.rung).toBe('quarantine');
	});

	it('is released explicitly, never automatically', () => {
		const s = release(strike(CLEAN_STATE, 'boom', QUARANTINE_STRIKES), 9000);
		expect(s.rung).toBe('observe');
		expect(s.quarantinedAt).toBeNull();
		expect(isQuarantined(s)).toBe(false);
	});
});

describe('rollback refuses far more often than it fires', () => {
	const point = { id: 7, statements: 300 };
	// quarantined long enough, built the way production builds it rather than by looping a counter
	const held = (ms: number) => {
		const state = strike(CLEAN_STATE, 'boom', QUARANTINE_STRIKES, 1_000);
		// from the state's OWN stamp: quarantinedAt lands on the strike that quarantines, not the first
		return { state, now: (state.quarantinedAt ?? 0) + ms };
	};

	it('refuses when not quarantined at all', () => {
		const d = shouldRollback(CLEAN_STATE, point, 0);
		expect(d.rollback).toBe(false);
		expect(d.reason).toContain('not quarantined');
	});

	it('refuses a site quarantined less than the dwell', () => {
		const { state, now } = held(ROLLBACK_DWELL_MS - 1);
		const d = shouldRollback(state, point, now);
		expect(d.rollback).toBe(false);
		// the reason names how far along it is, so an operator can see how close it is
		expect(d.reason).toContain('quarantined');
	});

	it('REFUSES when no restore point exists, and says why that is better', () => {
		const { state, now } = held(ROLLBACK_DWELL_MS);
		const d = shouldRollback(state, null, now);
		expect(d.rollback).toBe(false);
		expect(d.reason).toContain('no restore point');
		expect(d.reason).toContain('strictly better');
	});

	it('refuses an EMPTY restore point, which would replay nothing', () => {
		const { state, now } = held(ROLLBACK_DWELL_MS);
		expect(shouldRollback(state, { id: 3, statements: 0 }, now).rollback).toBe(false);
	});

	it('fires with quarantine, the full dwell and a real restore point', () => {
		const { state, now } = held(ROLLBACK_DWELL_MS);
		const d = shouldRollback(state, point, now);
		expect(d.rollback).toBe(true);
		expect(d.reason).toContain('restore point 7');
		expect(d.reason).toContain('300 statements');
	});

	it('IS REACHABLE from a sequence production can actually produce', () => {
		// the assertion this file was missing: it drove `recordOutcome` to 10 in a loop, which
		// `alarm()` cannot do -- strikes freeze at QUARANTINE_STRIKES once quarantined
		let s = CLEAN_STATE;
		for (let i = 0; i < QUARANTINE_STRIKES; i++) s = recordOutcome(s, fail('boom'), 1_000);
		expect(s.rung).toBe('quarantine');
		expect(s.strikes).toBe(QUARANTINE_STRIKES);
		// nothing increments strikes from here, and the decision must still become true on time alone
		expect(shouldRollback(s, point, 1_000).rollback).toBe(false);
		expect(shouldRollback(s, point, 1_000 + ROLLBACK_DWELL_MS).rollback).toBe(true);
	});

	it('treats a quarantined state with no timestamp as just-quarantined', () => {
		// rolling back an upgraded state on its first alarm is the worst reading of a missing field
		const legacy = { ...CLEAN_STATE, rung: 'quarantine' as const, strikes: QUARANTINE_STRIKES };
		const d = shouldRollback(legacy, point, 10 ** 12);
		expect(d.rollback).toBe(false);
		expect(d.reason).toContain('no timestamp');
	});
});

describe('state survives a round trip and a corrupt row', () => {
	it('round-trips', () => {
		const s = strike(CLEAN_STATE, 'boom', QUARANTINE_STRIKES);
		expect(parseState(serialiseState(s))).toEqual(s);
	});

	it('defaults to CLEAN on junk, so a corrupt row cannot quarantine a healthy site', () => {
		for (const raw of [null, undefined, '', 'not json', '{"rung":"nonsense"}']) {
			expect(parseState(raw).rung, String(raw)).toBe('observe');
			expect(isQuarantined(parseState(raw))).toBe(false);
		}
	});

	it('clamps a negative strike count rather than trusting it', () => {
		expect(parseState('{"rung":"observe","strikes":-5}').strikes).toBe(0);
	});
});
