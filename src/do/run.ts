import { EXIT_ERROR, EXIT_REPLY_DISARM, endedInExit, parseJsonReply } from '../ops/json-reply';
import { errorMessage } from '../util/errors';
import { GrowthRefused, isExitOne } from './growth/cap';
import { recordGrowthRefusal } from './growth/log';
import { effectBase } from './growth/retry';
import type { RunHost } from './host';
import { backgroundPhpHold, fillSettleMs } from './levers';
import { canRunSlice, runSlice, sliceRollbackEnabled } from './slice';
import type { Payload } from './types';

/** the end of the young-interpreter hold on background PHP, or undefined when there is none */
export function backgroundHold(host: RunHost): number | undefined {
	if (!host.php?.binary) return undefined;
	return backgroundPhpHold(host.phpBootedAt, host.nowMs(), fillSettleMs(host.env));
}

/** whether an error is a wasm trap; read by name too, since the pool is another realm */
function isTrap(e: unknown): boolean {
	return e instanceof WebAssembly.RuntimeError || (e as Error)?.name === 'RuntimeError';
}

/**
 * Runs a PHP fragment and returns everything it wrote.
 *
 * A wasm trap (`RuntimeError` out of the interpreter) leaves a half-finished Zend state, so the
 * interpreter is dropped. The error still propagates; a 503 would read as warming and hide a
 * fault. A governed run rolls the trap's writes back with the slice.
 *
 * A grow the cap refused ends the run in `exit(1)`; the interpreter is dropped and a
 * {@link GrowthRefused} replaces the exit, which `fetchRequest()` answers. The tag bridge judges
 * the run's writes at the drop, as it does for a trap.
 *
 * A governed run is one slice inside `transactionSync`, so a refusal rolls its writes back. With
 * `GROWTH_ROLLBACK=0`, or on an exempt phase, the run goes through `_run()` and the statements it
 * had already executed stay, since the bridge runs each on its own.
 */
export async function run(
	host: RunHost,
	code: string,
	after?: (out: string) => void
): Promise<string> {
	const inst = await host.ensurePhp();
	// the effects ledger starts once the request's interpreter is up, so boot crossings are not its
	host.effectBase ??= effectBase(host);
	const memo = inst.binary.lookupMemo;
	memo?.clear();
	host.out.length = 0;
	host.lastRet = undefined;
	inst.mysql?.beginRun();
	const refusalsBefore = host.growthRefusals ?? 0;
	const rowsBefore = host.rowsSinceFlush ?? 0;
	const refused = (e: unknown) => (host.growthRefusals ?? 0) > refusalsBefore && isExitOne(e);
	// a run with a checkpoint hook is always a slice: the hook has to commit with the run
	const sliced =
		(after !== undefined ||
			(host.growthCap !== undefined &&
				(host.growthExempt ?? 0) === 0 &&
				sliceRollbackEnabled(host.env))) &&
		canRunSlice(inst, host.storage);
	const slice = { rolledBack: false };
	const forwardBefore = host.forwardBuffer?.length ? [...host.forwardBuffer] : undefined;
	let committed = false;
	try {
		const ret = sliced
			? runSlice(
					inst,
					host.storage,
					code,
					(e) => isTrap(e) || refused(e),
					after && (() => after(host.out.join('')))
				).ret
			: await inst.php._run(code);
		committed = true;
		// an interpreter that cannot run a slice still gets its checkpoint, written after the run
		if (after && !sliced) after(host.out.join(''));
		// rows a committed slice wrote, so a later refusal in the same request can say what stays
		if (sliced) {
			host.sliceWrites = (host.sliceWrites ?? 0) + (host.rowsSinceFlush ?? 0) - rowsBefore;
		}
		host.lastRet = typeof ret === 'number' ? ret : undefined;
		// a fatal skips the harness's reply and leaves it armed; the disarm is a run of its own and
		// not a prefix, because a parked chain resumes in later runs that still need the reply
		if (host.lastRet !== undefined && host.lastRet !== 0) {
			const kept = host.lastRet;
			await inst.php._run(EXIT_REPLY_DISARM);
			host.lastRet = kept;
		}
	} catch (e) {
		if (isTrap(e)) {
			if (sliced && !committed) host.forwardBuffer = forwardBefore;
			host.trappedRuns = (host.trappedRuns ?? 0) + 1;
			host.lastTrap = { at: host.nowMs(), message: errorMessage(e) };
			host.dropInterpreter();
		} else if (refused(e)) {
			// an exit(1) with no refusal during the run is the script's own and passes through
			slice.rolledBack = sliced;
			// writes a pool lane owes its primary are part of what the rollback undid
			if (sliced) host.forwardBuffer = forwardBefore;
			host.governedRuns = (host.governedRuns ?? 0) + 1;
			const refusal = host.lastGrowthRefusal;
			if (refusal) host.lastGoverned = { at: host.nowMs(), ...refusal };
			host.dropInterpreter();
			// after the rollback, so the row is not part of what was undone
			try {
				recordGrowthRefusal(host, refusal, slice.rolledBack);
			} catch (logError) {
				host.noteError('growth-log', logError);
			}
			throw new GrowthRefused(refusal, e, slice.rolledBack);
		}
		throw e;
	} finally {
		memo?.clear();
	}
	return host.out.join('');
}

/** runs a fragment and parses the JSON object it printed */
export async function runJson(host: RunHost, code: string): Promise<Payload> {
	return host.settleReply(parseJsonReply(await host.run(code)));
}

/**
 * Counts an `exit()` the harness answered, and answers one it could not, for a reply that carries
 * no JSON.
 *
 * The pinned interpreter survives an exit and a harness prints its reply from a shutdown function
 * (`phpExit`), so that reply goes through as it is. Only an interpreter built without the exit fix
 * is dead afterwards: it runs nothing and prints nothing, so every later request would answer
 * empty until something recycled it. Its request fails and the instance is dropped.
 */
export async function settleReply(host: RunHost, reply: Payload): Promise<Payload> {
	if (reply['phpExit'] === true) {
		host.exitedRuns = (host.exitedRuns ?? 0) + 1;
		host.lastExit = { at: host.nowMs(), partial: String(reply['html'] ?? '').slice(0, 200) };
		return reply;
	}
	if (!(await endedInExit(host.lastRet, reply, (code) => host.run(code)))) return reply;
	const partial = String(reply['raw'] ?? '').slice(0, 200);
	host.exitedRuns = (host.exitedRuns ?? 0) + 1;
	host.lastExit = { at: host.nowMs(), partial };
	host.dropInterpreter();
	// the render path logs `raw` and answers with `error` alone
	return { error: EXIT_ERROR, exited: true, ...(partial ? { raw: partial } : {}) };
}
