import type { SiteEnv } from '../env';
import { hasDeploymentEnv } from '../ops/deployment-env';
import type { Payload } from './types';

/** where a chunked heap restore has got to, for the live heap only */
export type HeapRestoreCursor = {
	snapshotId: number;
	nextChunk: number;
	totalChunks: number;
	bytesWritten: number;
	firings: number;
};

/**
 * Thrown while a chunked restore is still in flight, so no caller runs PHP on a half-written heap.
 * An error rather than a flag because `ensurePhp()` has a dozen call sites that could forget one.
 */
export class HeapRestoreIncomplete extends Error {
	/** where the restore stopped */
	readonly cursor: HeapRestoreCursor;
	constructor(cursor: HeapRestoreCursor) {
		super(
			`heap restore incomplete: ${cursor.nextChunk}/${cursor.totalChunks} chunks applied ` +
				`over ${cursor.firings} firing(s); this object cannot execute PHP yet`
		);
		this.name = 'HeapRestoreIncomplete';
		this.cursor = cursor;
	}
}

/**
 * How many 2 MiB chunks one invocation may apply, or `undefined` for all of them (a memcpy of
 * 22.4 MB measured 14-18 ms).
 */
export function heapRestoreChunkBudget(env?: SiteEnv): number | undefined {
	const raw = Number(env?.HEAP_RESTORE_CHUNKS ?? 0);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

/**
 * Whether a boot restores a stored heap instead of booting the kernel; on unless
 * `HEAP_SNAPSHOT=0`. Measured 2,310-3,578 ms off each install for 31,784,960 bytes a site (n=8).
 */
export function heapSnapshotEnabled(env?: SiteEnv): boolean {
	// an image carries the environment PHP booted with; settings.php would not run to replace it
	return env?.HEAP_SNAPSHOT !== '0' && !hasDeploymentEnv(env);
}

/**
 * What an alarm lane achieved, as opposed to what it returned. The re-arm delay depends only on
 * this, so a non-null return or a non-empty queue cannot alone reach the fast path.
 */
export type AlarmClass = 'progress' | 'transient' | 'idle' | 'failure';

/**
 * The floor on a failure's re-arm delay; the alarm holds the gate, so a fast failure chain starves
 * every queued request and looks like a deadlock.
 */
export const FAILURE_BACKOFF_FLOOR_MS = 1_000;

/**
 * Classifies one lane's outcome, or a batch of them; a batch is as bad as its worst member, so
 * one failing page backs the chain off.
 */
export function classifyAlarmOutcome(
	outcome: Payload | Array<Payload | undefined> | undefined
): AlarmClass {
	if (Array.isArray(outcome)) {
		const classes = outcome.map((o) => classifyAlarmOutcome(o));
		if (classes.includes('failure')) return 'failure';
		if (classes.includes('progress')) return 'progress';
		if (classes.includes('transient')) return 'transient';
		return 'idle';
	}
	if (!outcome) return 'idle';

	// a refusal with its own alarm chain driving progress, so a fast re-arm is safe
	if (outcome.restorePending === true || outcome.transient === true) return 'transient';

	// failure shapes that are non-null and so once read as success
	if (outcome.ok === false) return 'failure';
	if (outcome.error !== undefined) return 'failure';
	if (outcome.threw === true) return 'failure';
	if (outcome.failed !== undefined && outcome.failed !== null) return 'failure';

	if (outcome.skipped !== undefined) return 'idle';
	// `filled: null` means nothing to do
	if ('filled' in outcome && outcome.filled === null) return 'idle';
	return 'progress';
}

/**
 * How long until the next firing, from the classification. `queueNonEmpty` only speeds up a chain
 * already making progress; a failing row that is never struck keeps the queue non-empty.
 */
export function alarmRearmDelayMs(
	cls: AlarmClass,
	opts: { queueNonEmpty?: boolean; idleMs?: number; fastMs?: number; failures?: number } = {}
): number {
	const idleMs = opts.idleMs ?? 240_000;
	const fastMs = opts.fastMs ?? 1;
	switch (cls) {
		case 'failure': {
			// capped exponential, floored so failure 0 still backs off
			const failures = Math.max(0, opts.failures ?? 0);
			return Math.min(60_000, FAILURE_BACKOFF_FLOOR_MS * Math.pow(2, Math.min(failures, 6)));
		}
		case 'transient':
			return fastMs;
		case 'progress':
			return opts.queueNonEmpty === false ? idleMs : fastMs;
		case 'idle':
		default:
			return idleMs;
	}
}

/**
 * What the alarm chain should do after one slice of a chunked restore; a stalled cursor halts
 * rather than spinning at 1 ms and starving the gate.
 *
 * @param before the cursor position at the start of the firing
 * @param after the cursor after it, or undefined when the restore finished or was abandoned
 */
export function restoreAlarmDecision(
	before: number,
	after: HeapRestoreCursor | undefined
): { action: 'continue' | 'unblocked' | 'halt'; delayMs: number } {
	// stall test first: testing "open" first would re-arm a stuck cursor forever
	if (after && after.nextChunk <= before) return { action: 'halt', delayMs: 0 };
	if (after) return { action: 'continue', delayMs: 1 };
	// closed: migration/updb/fill get their own firing, not what is left of this one
	return { action: 'unblocked', delayMs: 1 };
}

/**
 * How long to wait before the next migration alarm. Takes the step result itself, not the
 * `{ migrate: out }` wrapper, whose missing `done` made the idle branch unreachable.
 *
 * @param out a migrator step result, or the `{ ok: false }` shape the catch path returns
 * @param failures consecutive failures, for the capped backoff
 */
export function migrateAlarmDelayMs(
	out?: { done?: boolean; ok?: boolean },
	failures = 0,
	options: { idleMs?: number; chainMs?: number; maxBackoffMs?: number } = {}
): number {
	// failure first: a step can be done and not ok, and must back off rather than idle
	if (out?.ok === false) {
		return Math.min(options.maxBackoffMs ?? 30000, 1000 * Math.min(Math.max(failures, 1), 30));
	}
	if (out?.done) return options.idleMs ?? 240000;
	return options.chainMs ?? 1;
}
