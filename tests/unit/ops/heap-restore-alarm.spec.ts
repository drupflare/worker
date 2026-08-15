import { describe, expect, it } from 'vitest';
import {
	FAILURE_BACKOFF_FLOOR_MS,
	HeapRestoreIncomplete,
	alarmRearmDelayMs,
	classifyAlarmOutcome,
	heapRestoreChunkBudget,
	restoreAlarmDecision
} from '../../../src/site-do';
import { freshSite, inObject } from '../../helpers/serve-do';

/**
 * The fourth alarm chain: a heap restore split across invocations.
 *
 * It sits with the other three (cron, updb, migrate) because it shares their failure mode. The
 * migration chain re-armed at +1 ms on a step that ERRORED, and since migration runs inside the
 * reentrancy gate, every gated request queued behind an endless stream of alarm entries and never
 * ran -- starvation presenting as a deadlock, on a `/migrate` that hung past 90 s. That decision was
 * an inline ternary with no test. This one is a named function with one, and the halt branch below
 * is the reason.
 */

describe('the restore alarm decision, whose halt branch is the anti-starvation guard', () => {
	it('continues while the cursor is advancing', () => {
		const d = restoreAlarmDecision(2, {
			snapshotId: 1,
			nextChunk: 4,
			totalChunks: 9,
			bytesWritten: 10,
			firings: 2
		});
		expect(d.action).toBe('continue');
		expect(d.delayMs).toBe(1);
	});

	it('HALTS a cursor that did not move rather than re-arming it forever', () => {
		// the regression test for the failure the migration chain actually shipped. Progress is
		// guaranteed on every path known today; this asserts the object gives up instead of spinning
		// if one is ever wrong about that
		const d = restoreAlarmDecision(4, {
			snapshotId: 1,
			nextChunk: 4,
			totalChunks: 9,
			bytesWritten: 10,
			firings: 7
		});
		expect(d.action).toBe('halt');
		expect(d.delayMs).toBe(0);
	});

	it('halts a cursor that went BACKWARDS, not only one that stood still', () => {
		const d = restoreAlarmDecision(6, {
			snapshotId: 1,
			nextChunk: 3,
			totalChunks: 9,
			bytesWritten: 10,
			firings: 7
		});
		expect(d.action).toBe('halt');
	});

	it('re-arms once more when the restore closed, so the blocked lanes get their own firing', () => {
		// while the cursor is open ensurePhp() throws, so migration, updb and fill can each do nothing
		// but raise. The firing that finishes the restore is what unblocks them
		const d = restoreAlarmDecision(8, null);
		expect(d.action).toBe('unblocked');
		expect(d.delayMs).toBe(1);
	});
});

describe('the per-invocation chunk budget', () => {
	it('is undefined when unset, which applies the whole snapshot in one memcpy', () => {
		// every recorded restore measurement (14-18 ms for 22.4 MB) was taken this way, so unset must
		// keep meaning "all of it" rather than silently becoming a chunk count
		expect(heapRestoreChunkBudget(undefined)).toBeUndefined();
		expect(heapRestoreChunkBudget({} as never)).toBeUndefined();
		expect(heapRestoreChunkBudget({ HEAP_RESTORE_CHUNKS: '' } as never)).toBeUndefined();
	});

	it('reads a positive count and floors it', () => {
		expect(heapRestoreChunkBudget({ HEAP_RESTORE_CHUNKS: '2' } as never)).toBe(2);
		expect(heapRestoreChunkBudget({ HEAP_RESTORE_CHUNKS: '3.7' } as never)).toBe(3);
	});

	it('treats junk and non-positive values as unset rather than as zero', () => {
		// a 0 budget would apply no chunks per firing, which is the stall the halt branch catches --
		// better to never construct it
		expect(heapRestoreChunkBudget({ HEAP_RESTORE_CHUNKS: '0' } as never)).toBeUndefined();
		expect(heapRestoreChunkBudget({ HEAP_RESTORE_CHUNKS: '-4' } as never)).toBeUndefined();
		expect(heapRestoreChunkBudget({ HEAP_RESTORE_CHUNKS: 'lots' } as never)).toBeUndefined();
	});
});

describe('HeapRestoreIncomplete, the refusal that keeps PHP off a half-written heap', () => {
	const cursor = {
		snapshotId: 3,
		nextChunk: 5,
		totalChunks: 11,
		bytesWritten: 4096,
		firings: 5
	};

	it('names the progress in its message, because a silent refusal is a hang to diagnose', () => {
		const e = new HeapRestoreIncomplete(cursor);
		expect(e.name).toBe('HeapRestoreIncomplete');
		expect(e.message).toContain('5/11');
		expect(e.message).toContain('cannot execute PHP');
	});

	it('carries the cursor so a caller can report it without re-reading the object', () => {
		expect(new HeapRestoreIncomplete(cursor).cursor).toEqual(cursor);
	});

	it('is an Error, so an unprepared caller fails loudly rather than rendering', () => {
		// this is the whole reason it is a throw and not a boolean: ensurePhp() has roughly a dozen
		// call sites, and a flag only protects the ones that remember to read it. LAZY_MOUNT spent its
		// entire life unreachable behind exactly that kind of unchecked condition
		expect(new HeapRestoreIncomplete(cursor)).toBeInstanceOf(Error);
	});
});

describe('the vrzno handle table is read off the binary by shape, not by hope', () => {
	/** the members `handleIndex()` requires, and nothing wider */
	function fakeTargets() {
		const byInteger = new Map<number, object>();
		return {
			byObject: new WeakMap<object, number>(),
			byInteger,
			id: 0,
			add(o: object) {
				const id = ++this.id;
				byInteger.set(id, o);
				this.byObject.set(o, id);
				return id;
			},
			get: (id: number) => byInteger.get(id),
			getId: (o: object) => undefined as number | undefined,
			has: (o: object) => undefined as number | undefined,
			hasId: (id: number) => byInteger.get(id),
			remove: (id: number) => void byInteger.delete(id)
		};
	}

	it('accepts a table carrying an iterable byInteger, a byObject and a numeric id', async () => {
		const stub = freshSite();
		const found = await inObject(stub, (site) =>
			site.handleIndex({ targets: fakeTargets() } as never)
		);
		expect(found).not.toBeNull();
	});

	it('refuses a binary with no table rather than restoring against nothing', async () => {
		const stub = freshSite();
		const out = await inObject(stub, (site) => ({
			absent: site.handleIndex({} as never),
			// a plausible-looking object that is missing the iterator is still not a handle table
			halfShaped: site.handleIndex({
				targets: { byObject: { set() {} }, byInteger: { set() {} }, id: 0 }
			} as never)
		}));
		expect(out.absent).toBeNull();
		expect(out.halfShaped).toBeNull();
	});

	it('pins every handle the interpreter mints, because the table holds WeakRefs', async () => {
		// MEASURED on the edge: without this the entry for handle 2 (`cfwSqlExec`) was collected
		// before the snapshot, so the capture stored one handle and the restored heap asked for a
		// dead id -- `misses: [2]` from /heap?op=trace, and `TypeError: target is not a function`
		const stub = freshSite();
		const out = await inObject(stub, (site) => {
			const binary = { targets: fakeTargets() } as never;
			site.pinHandles(binary);
			const table = site.handleIndex(binary);
			const first = table?.add?.({ a: 1 });
			const second = table?.add?.({ b: 2 });
			return { first, second, pinned: site.pinnedHandles?.size ?? 0, id: table?.id };
		});
		expect(out.first).toBe(1);
		expect(out.second).toBe(2);
		expect(out.pinned).toBe(2);
		// and the counter still tracks, so a later add cannot alias a restored handle
		expect(out.id).toBe(2);
	});

	it('is a no-op on a binary with no table, rather than a throw at boot', async () => {
		const stub = freshSite();
		expect(await inObject(stub, (site) => site.pinHandles({} as never))).toBe(0);
	});
});

describe('the alarm re-arm delay comes from the OUTCOME, not from the queue', () => {
	/**
	 * The structural fix for a bug that shipped three times: migration re-armed at +1 ms on a step
	 * that errored, and the fill head re-armed at +1 ms on a render that threw -- **196 firings in
	 * 14 seconds, every one reporting `outcome: ok`**. Both were non-null returns read as work done.
	 *
	 * Fixing them case by case left the shape intact. These assertions pin the shape: a failure
	 * cannot produce a fast delay through ANY combination of inputs, so the fourth instance cannot
	 * be written.
	 */
	it('never re-arms a failure fast, at any failure count, with the queue full', () => {
		for (let failures = 0; failures < 10; failures++) {
			const delay = alarmRearmDelayMs('failure', { queueNonEmpty: true, failures });
			expect(delay, `failures=${failures}`).toBeGreaterThanOrEqual(FAILURE_BACKOFF_FLOOR_MS);
		}
	});

	it('backs a failure off exponentially and then caps it', () => {
		const first = alarmRearmDelayMs('failure', { failures: 0 });
		const later = alarmRearmDelayMs('failure', { failures: 3 });
		expect(later).toBeGreaterThan(first);
		// capped, or a long outage pushes the next attempt past any useful horizon
		expect(alarmRearmDelayMs('failure', { failures: 999 })).toBeLessThanOrEqual(60_000);
	});

	it('lets a non-empty queue speed up progress but NOT rescue a failure', () => {
		// the exact coupling that produced the 196 firings: the queue stayed non-empty because the
		// failing row was never struck, and the delay was read off the queue instead of the outcome
		expect(alarmRearmDelayMs('progress', { queueNonEmpty: true })).toBe(1);
		expect(alarmRearmDelayMs('failure', { queueNonEmpty: true })).toBeGreaterThanOrEqual(
			FAILURE_BACKOFF_FLOOR_MS
		);
	});

	it('sends a progressing chain with an empty queue to the keep-warm tick', () => {
		expect(alarmRearmDelayMs('progress', { queueNonEmpty: false })).toBe(240_000);
		expect(alarmRearmDelayMs('idle', { queueNonEmpty: true })).toBe(240_000);
	});

	it('lets a transient refusal re-arm fast, because something else drives its progress', () => {
		// HeapRestoreIncomplete: the restore branch at the top of alarm() owns the chain and every
		// firing advances the cursor, so backing off here would stall a restore that is working
		expect(alarmRearmDelayMs('transient', { queueNonEmpty: false })).toBe(1);
	});
});

describe('classifying an outcome, where all three historical bugs lived', () => {
	it('reads a NON-NULL error return as a failure, which is the bug all three times', () => {
		expect(classifyAlarmOutcome({ ok: false })).toBe('failure');
		expect(classifyAlarmOutcome({ error: 'boom' })).toBe('failure');
		expect(classifyAlarmOutcome({ error: 'boom', threw: true })).toBe('failure');
		expect(classifyAlarmOutcome({ failed: '/some/path' })).toBe('failure');
	});

	it('does not mistake an idle lane for progress', () => {
		expect(classifyAlarmOutcome(null)).toBe('idle');
		expect(classifyAlarmOutcome(undefined)).toBe('idle');
		expect(classifyAlarmOutcome({ skipped: 'migration incomplete' })).toBe('idle');
		// `filled: null` is the fill lane saying the queue was empty
		expect(classifyAlarmOutcome({ filled: null })).toBe('idle');
	});

	it('reads real work as progress', () => {
		expect(classifyAlarmOutcome({ filled: '/', remaining: 2 })).toBe('progress');
		expect(classifyAlarmOutcome({ migrate: { ok: true } })).toBe('progress');
	});

	it('treats a restore-pending refusal as transient rather than as a failure', () => {
		expect(
			classifyAlarmOutcome({
				error: 'heap restore incomplete',
				threw: true,
				restorePending: true
			})
		).toBe('transient');
	});

	it('is as bad as the worst member of a batch', () => {
		// one failing page in five must not get a fast retry paid for by the four that worked
		expect(classifyAlarmOutcome([{ filled: '/a' }, { filled: '/b' }, { error: 'x' }])).toBe(
			'failure'
		);
		expect(classifyAlarmOutcome([{ filled: '/a' }, { filled: null }])).toBe('progress');
		expect(classifyAlarmOutcome([{ filled: null }, null])).toBe('idle');
		expect(classifyAlarmOutcome([])).toBe('idle');
	});
});
