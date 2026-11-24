import type { SiteEnv } from '../env';
import type { SiteBinary } from './types';

/** the effects queued by the slice now running, or undefined outside one */
let active: (() => void)[] | undefined;

/**
 * Holds an effect until the slice that queued it commits, or runs it now outside a slice. A
 * rolled-back slice drops what it queued, so nothing leaves the object for work that never
 * happened. Only effects outside the database need this: rows roll back by themselves.
 */
export function deferEffect(effect: () => void): void {
	if (active) active.push(effect);
	else effect();
}

/** whether a slice is running; a spec reads it */
export function sliceRunning(): boolean {
	return active !== undefined;
}

/** `GROWTH_ROLLBACK=0` turns the slice transaction off; the governor then keeps partial writes */
export function sliceRollbackEnabled(env: SiteEnv | undefined): boolean {
	return String(env?.GROWTH_ROLLBACK ?? '') !== '0';
}

/** the part of an interpreter a slice needs */
export interface SliceInstance {
	php: { flush(): void; clock?: { resync(): void } };
	binary: SiteBinary;
}

/** the storage handle's transaction call, narrowed so a spec can stand in for it */
export interface SliceStorage {
	transactionSync<T>(fn: () => T): T;
}

/** whether this interpreter can run a slice synchronously: a real Module with `ccall` */
export function canRunSlice(inst: SliceInstance | undefined, storage: SliceStorage | undefined) {
	return (
		typeof inst?.binary?.ccall === 'function' && typeof storage?.transactionSync === 'function'
	);
}

/**
 * One `pib_run`, called straight through the Module. php-wasm's `_run` wraps this same call in a
 * promise, but the shipped glue's `ccall` ignores `async` (no Asyncify, no JSPI), so the call is
 * synchronous and can sit inside `transactionSync`. The source prefix is php-wasm's own.
 */
export function pibRun(inst: SliceInstance, code: string): unknown {
	const source = `${code}`;
	const wrapped = /^<\?php(?=[ \t\r\n]|$)/i.test(source)
		? `     ${source.slice(5)}`
		: `?>${source}`;
	inst.php.clock?.resync();
	return (
		inst.binary as unknown as {
			ccall(name: string, ret: string, types: string[], args: unknown[]): unknown;
		}
	).ccall('pib_run', 'number', ['string'], [wrapped]);
}

/**
 * Runs one PHP slice inside one `transactionSync`.
 *
 * `rollbackOn` names the errors that undo the slice (a refused grow); any other error commits what
 * the slice wrote and is rethrown afterwards, which is what an unwrapped run did. `after` runs
 * inside the transaction once the PHP returned, with the output flushed; throwing from it rolls
 * the slice back. Effects queued
 * with {@link deferEffect} fire after the commit in order, and are dropped on a rollback. The
 * interpreter's output is flushed either way.
 *
 * The guarantee is per slice: a refusal rolls back this slice only, never an earlier one that
 * returned (a park ends a slice).
 */
export function runSlice(
	inst: SliceInstance,
	storage: SliceStorage,
	code: string,
	rollbackOn: (e: unknown) => boolean,
	after?: () => void
): { ret: unknown } {
	const queued: (() => void)[] = [];
	const outer = active;
	active = queued;
	let ret: unknown;
	let kept: { error: unknown } | undefined;
	try {
		storage.transactionSync(() => {
			try {
				ret = pibRun(inst, code);
			} catch (e) {
				if (rollbackOn(e)) throw e;
				kept = { error: e };
				return;
			}
			// inside the transaction: a checkpoint written here commits with the step or not at all,
			// and a throw undoes the step
			if (after) {
				inst.php.flush();
				after();
			}
		});
	} catch (e) {
		queued.length = 0;
		throw e;
	} finally {
		active = outer;
		inst.php.flush();
	}
	for (const effect of queued) effect();
	if (kept) throw kept.error;
	return { ret };
}
