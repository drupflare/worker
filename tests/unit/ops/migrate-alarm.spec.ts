import { describe, expect, it } from 'vitest';
import { migrateAlarmDelayMs } from '../../../src/site-do';

/**
 * The migration alarm chain's delay decision, which was the only one of the three chains
 * (cron, updb, migrate) without a unit test -- and the only one that shipped a dead branch.
 *
 * The inline ternary in `alarm()` read `pending.done` while the caller passed `{ migrate: out }`,
 * so `done` was always `undefined`: the 240 s idle branch was unreachable and the firing that
 * finished a migration re-armed at 1 ms. The first assertion below is the regression test.
 */

describe('migrateAlarmDelayMs', () => {
	it('goes idle when the step reports done', () => {
		// pre-fix this returned 1: the caller read `.done` off the wrapper, not the step result
		expect(migrateAlarmDelayMs({ ok: true, done: true })).toBe(240000);
	});

	it('chains at 1 ms while there is more to do', () => {
		expect(migrateAlarmDelayMs({ ok: true, done: false })).toBe(1);
		expect(migrateAlarmDelayMs({ ok: true })).toBe(1);
	});

	it('backs off on failure instead of spinning', () => {
		// the 1 ms spin inside the reentrancy gate starved every gated request past 90 s once;
		// that is the failure this branch exists to prevent
		expect(migrateAlarmDelayMs({ ok: false }, 1)).toBe(1000);
		expect(migrateAlarmDelayMs({ ok: false }, 5)).toBe(5000);
	});

	it('caps the backoff', () => {
		expect(migrateAlarmDelayMs({ ok: false }, 30)).toBe(30000);
		expect(migrateAlarmDelayMs({ ok: false }, 3000)).toBe(30000);
	});

	it('treats a failure with no count yet as one failure, not zero delay', () => {
		// `this.migrateFailures` is incremented before the call, but a 0 would produce a 0 ms
		// alarm, which is the spin this is meant to avoid
		expect(migrateAlarmDelayMs({ ok: false })).toBe(1000);
		expect(migrateAlarmDelayMs({ ok: false }, 0)).toBe(1000);
	});

	it('prefers backing off over going idle when a step is both done and failed', () => {
		// a failed step must not buy itself four minutes of silence
		expect(migrateAlarmDelayMs({ ok: false, done: true }, 2)).toBe(2000);
	});

	it('chains on a null or absent step rather than going idle', () => {
		// the caller only reaches this with a non-null pending, but defaulting to the fast path
		// keeps a missing field from silently parking the chain for four minutes
		expect(migrateAlarmDelayMs(null)).toBe(1);
		expect(migrateAlarmDelayMs()).toBe(1);
	});

	it('honours overrides, so a test or a config can retune it', () => {
		expect(migrateAlarmDelayMs({ done: true }, 0, { idleMs: 60000 })).toBe(60000);
		expect(migrateAlarmDelayMs({ done: false }, 0, { chainMs: 5 })).toBe(5);
		expect(migrateAlarmDelayMs({ ok: false }, 99, { maxBackoffMs: 7000 })).toBe(7000);
	});
});
