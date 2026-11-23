import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { cronUnits } from '../../src/ops/cron';
import { DEFAULT_CRON_BUDGET, firingIdempotent, lostFiringCursor } from '../../src/ops/cron-drive';
import {
	forgetRows,
	openOutbox,
	OUTBOX_POLICIES,
	PermanentError,
	reenqueueReported,
	REPORTED_HINT,
	REPORTED_KEEP,
	reportedRows,
	trimReported,
	type OutboxLane
} from '../../src/ops/outbox';
import { crashSql } from '../helpers/crash-sql';

/**
 * What the worker's outside effects owe the platform's reset: a resend kind sends again with the
 * same key, a report kind never runs again, and a permanent error ends the row.
 *
 * `crashSql` drops every write since the last flush, which is what a killed event does. The effect
 * here stands for the far end: it counts every raw send and a receiver that drops a repeated key,
 * so "exactly once" is read off what the receiver kept.
 */

class Reset extends Error {}

function world(lane: OutboxLane) {
	const db = new DatabaseSync(':memory:');
	const crash = crashSql(db);
	let now = 1_000_000;
	const sends: string[] = [];
	const received = new Set<string>();
	const throwFrom: { permanent?: boolean } = {};
	let flushes = 0;
	// the event dies at this flush, with everything since the last one rolled back
	let killAt = 0;
	const flush = async () => {
		flushes++;
		if (flushes === killAt) {
			crash.reset();
			throw new Reset('the object was reset');
		}
		await crash.flush();
	};
	const effect = ({ key }: { key: string }) => {
		sends.push(key);
		if (throwFrom.permanent) throw new PermanentError('no such recipient');
		received.add(key);
	};
	return {
		crash,
		sends,
		received,
		throwFrom,
		advance: (ms: number) => (now += ms),
		killAtFlush: (n: number) => {
			flushes = 0;
			killAt = n;
		},
		open: () => openOutbox(crash.sql, lane, effect, { flush, now: () => now })
	};
}

const rowOf = (w: ReturnType<typeof world>, id: string) =>
	w
		.open()
		.results()
		.find((r) => r.id === id);

// the flushes of one enqueue-then-drain: the enqueue, the claim, the completion
const COMPLETION = 3;
const CLAIM = 2;

describe('a resend kind survives a reset between the effect and its completion', () => {
	it.each([['mail'], ['http'], ['redis-idempotent'], ['cron-idempotent']] as const)(
		'%s sends again with the same key and the receiver keeps one',
		async (kind) => {
			const w = world('http');
			const first = w.open();
			w.killAtFlush(COMPLETION);
			await first.enqueue([{ id: 'k-1', kind, args: 'x' }]);
			await expect(first.drain()).rejects.toBeInstanceOf(Reset);
			expect(w.sends).toEqual(['k-1']);
			// the completion was lost: a successor finds the row running
			expect(rowOf(w, 'k-1')).toMatchObject({ state: 'running', attempt: 1 });

			w.advance(20_000);
			w.killAtFlush(0);
			const report = await w.open().drain();
			expect(report.done).toBe(1);
			// two raw sends, one key, one delivery
			expect(w.sends).toEqual(['k-1', 'k-1']);
			expect(w.received.size).toBe(1);
			expect(rowOf(w, 'k-1')).toMatchObject({ state: 'done', attempt: 2 });
		}
	);

	it('a reset before the claim is flushed loses the claim and nothing ran', async () => {
		const w = world('http');
		const first = w.open();
		w.killAtFlush(CLAIM);
		await first.enqueue([{ id: 'k-1', kind: 'http', args: 'x' }]);
		await expect(first.drain()).rejects.toBeInstanceOf(Reset);
		expect(w.sends).toEqual([]);
		expect(rowOf(w, 'k-1')).toMatchObject({ state: 'queued', attempt: 0 });

		w.killAtFlush(0);
		await w.open().drain();
		expect(w.sends).toEqual(['k-1']);
	});
});

describe('a report kind never runs again after a reset', () => {
	it.each([['redis'], ['cron'], ['an-unlisted-kind']] as const)(
		'%s ends failed with the policy named and its effect does not repeat',
		async (kind) => {
			const w = world('http');
			const first = w.open();
			w.killAtFlush(COMPLETION);
			await first.enqueue([{ id: 'k-1', kind, args: 'INCR counter' }]);
			await expect(first.drain()).rejects.toBeInstanceOf(Reset);
			expect(w.sends).toEqual(['k-1']);

			w.advance(20_000);
			w.killAtFlush(0);
			const report = await w.open().drain();
			expect(report.reported).toBe(1);
			expect(report.done).toBe(0);
			// still one send: the successor did not run the effect
			expect(w.sends).toEqual(['k-1']);
			const row = rowOf(w, 'k-1')!;
			expect(row.state).toBe('failed');
			expect(row.error).toContain('policy report');
			expect(w.open().results()).toHaveLength(1);

			// and no number of later drains runs it
			w.advance(60_000);
			await w.open().drain();
			expect(w.sends).toEqual(['k-1']);
		}
	);

	it('lists the reported row with what the operator does next, then re-enqueues it under a new id', async () => {
		const w = world('http');
		const first = w.open();
		w.killAtFlush(COMPLETION);
		await first.enqueue([{ id: 'http-k1-1', kind: 'redis', args: '["INCR","n"]' }]);
		await expect(first.drain()).rejects.toBeInstanceOf(Reset);
		w.advance(20_000);
		w.killAtFlush(0);
		await w.open().drain();

		const listed = reportedRows(w.crash.sql);
		expect(listed).toEqual([
			{
				lane: 'http',
				id: 'http-k1-1',
				kind: 'redis',
				error: expect.stringContaining('policy report'),
				hint: REPORTED_HINT
			}
		]);
		expect(REPORTED_HINT).toContain('check the receiver before re-enqueueing');

		const outbox = w.open();
		expect(await reenqueueReported(outbox, w.crash.sql, 'http', 'http-k1-1', 'http-k1-2')).toBe(
			true
		);
		// the old row is gone and the new one is queued with the same kind and args
		expect(outbox.results().map((r) => [r.id, r.state, r.kind, r.args])).toEqual([
			['http-k1-2', 'queued', 'redis', '["INCR","n"]']
		]);
		expect(reportedRows(w.crash.sql)).toEqual([]);
		// a row that is not reported, or a new id that exists, is refused
		expect(await reenqueueReported(outbox, w.crash.sql, 'http', 'http-k1-2', 'x')).toBe(false);
		expect(await reenqueueReported(outbox, w.crash.sql, 'http', 'nope', 'y')).toBe(false);
	});

	it('keeps only the newest reported rows of a lane', async () => {
		const w = world('http');
		const outbox = w.open();
		const total = REPORTED_KEEP + 3;
		await outbox.enqueue(
			Array.from({ length: total }, (_, n) => ({
				id: `r-${String(n).padStart(3, '0')}`,
				kind: 'redis',
				args: 'x'
			}))
		);
		// claim every row, then let the leases lapse so each is reported
		outbox.table.claim(1_000_000, 15_000, total);
		w.advance(20_000);
		await w.open().drain();
		expect(reportedRows(w.crash.sql)).toHaveLength(total);
		trimReported(w.crash.sql, 'http');
		const left = reportedRows(w.crash.sql).map((r) => r.id);
		expect(left).toHaveLength(REPORTED_KEEP);
		expect(left[0]).toBe('r-003');
	});

	it('reads no lane whose table does not exist yet', () => {
		const w = world('http');
		expect(reportedRows(w.crash.sql)).toEqual([]);
	});
});

describe('a permanent error ends the row failed', () => {
	it('runs the effect once and never again', async () => {
		const w = world('mail');
		w.throwFrom.permanent = true;
		const outbox = w.open();
		await outbox.enqueue([{ id: 'm-1', kind: 'mail', args: 'nobody' }]);
		const report = await outbox.drain();
		expect(report).toMatchObject({ done: 0, failed: 1, retried: 0 });
		expect(rowOf(w, 'm-1')).toMatchObject({
			state: 'failed',
			attempt: 1,
			error: 'no such recipient'
		});

		w.advance(60_000);
		await w.open().drain();
		expect(w.sends).toEqual(['m-1']);
	});

	it('forgets finished rows and leaves open ones', async () => {
		const w = world('mail');
		const outbox = w.open();
		await outbox.enqueue([
			{ id: 'a', kind: 'mail', args: '' },
			{ id: 'b', kind: 'mail', args: '' }
		]);
		await outbox.drain();
		forgetRows(w.crash.sql, 'mail', ['a']);
		expect(outbox.results().map((r) => r.id)).toEqual(['b']);
		forgetRows(w.crash.sql, 'mail', []);
		expect(outbox.results()).toHaveLength(1);
	});
});

describe('the cron lock', () => {
	const options = { hooks: ['search'] };
	const units = cronUnits(options);
	const last = units.length - 1;
	const cursorAt = (i: number) => ({ v: 1, i, round: 0, queueRepeats: 0, rowsWritten: 0 });

	it('marks a firing idempotent only when it reaches SQL passes alone', () => {
		// the tail of the round is the stamp pass; the head runs into a hook
		expect(units[last]?.kind).toBe('sql');
		expect(firingIdempotent(cursorAt(last), options)).toBe(true);
		expect(firingIdempotent(undefined, options)).toBe(false);
		// a budget that stops before the first PHP unit never reaches it
		const firstPhp = units.findIndex((u) => u.kind === 'php');
		expect(firstPhp).toBeGreaterThan(0);
		expect(
			firingIdempotent(cursorAt(0), options, { ...DEFAULT_CRON_BUDGET, maxUnits: firstPhp })
		).toBe(true);
		expect(
			firingIdempotent(cursorAt(0), options, {
				...DEFAULT_CRON_BUDGET,
				maxUnits: firstPhp + 1
			})
		).toBe(false);
	});

	it('moves a lost firing past the last PHP unit it may have run', () => {
		const budget = DEFAULT_CRON_BUDGET;
		const reach = Math.min(units.length, budget.maxUnits);
		let phpAt = -1;
		for (let at = 0; at < reach; at++) if (units[at]?.kind === 'php') phpAt = at;
		expect(phpAt).toBeGreaterThan(-1);
		const moved = lostFiringCursor(cursorAt(0), options, budget);
		expect(moved.i).toBe(phpAt + 1 >= units.length ? 0 : phpAt + 1);
		expect('wrapped' in moved).toBe(false);
		// an idempotent firing has nothing to skip
		expect(lostFiringCursor(cursorAt(last), options).i).toBe(last);
	});

	it('replays an idempotent firing and reports the rest, by the kind the claim gave it', async () => {
		for (const [kind, replays] of [
			['cron-idempotent', true],
			['cron', false]
		] as const) {
			const w = world('cron');
			const first = w.open();
			w.killAtFlush(COMPLETION);
			await first.enqueue([{ id: 'cron-1', kind, args: '{}' }]);
			await expect(first.drain()).rejects.toBeInstanceOf(Reset);
			w.advance(20_000);
			w.killAtFlush(0);
			const report = await w.open().drain();
			expect(w.sends.length, kind).toBe(replays ? 2 : 1);
			expect(report.reported, kind).toBe(replays ? 0 : 1);
		}
	});
});

describe('the policy table', () => {
	it('names a replay policy for every kind a lane enqueues', () => {
		expect(OUTBOX_POLICIES).toEqual({
			mail: 'resend',
			http: 'resend',
			redis: 'report',
			'redis-idempotent': 'resend',
			cron: 'report',
			'cron-idempotent': 'resend'
		});
	});
});
