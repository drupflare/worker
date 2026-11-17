import { EXIT_ERROR, endedInExit, parseJsonReply } from '../ops/json-reply';
import { errorMessage } from '../util/errors';
import type { RunHost } from './host';
import { backgroundPhpHold, fillSettleMs } from './levers';
import type { Payload } from './types';

/** the end of the young-interpreter hold on background PHP, or undefined when there is none */
export function backgroundHold(host: RunHost): number | undefined {
	if (!host.php?.binary) return undefined;
	return backgroundPhpHold(host.phpBootedAt, host.nowMs(), fillSettleMs(host.env));
}

/**
 * Runs a PHP fragment and returns everything it wrote.
 *
 * A wasm trap (`RuntimeError` out of `_run()`) leaves a half-finished Zend state, so the
 * interpreter is dropped. The error still propagates; a 503 would read as warming and hide a
 * fault.
 */
export async function run(host: RunHost, code: string): Promise<string> {
	const inst = await host.ensurePhp();
	host.out.length = 0;
	host.lastRet = undefined;
	inst.mysql?.beginRun();
	try {
		const ret = await inst.php._run(code);
		host.lastRet = typeof ret === 'number' ? ret : undefined;
	} catch (e) {
		// name rather than instanceof alone: the pool and the worker are different realms
		if (e instanceof WebAssembly.RuntimeError || (e as Error)?.name === 'RuntimeError') {
			host.trappedRuns = (host.trappedRuns ?? 0) + 1;
			host.lastTrap = { at: host.nowMs(), message: errorMessage(e) };
			host.dropInterpreter();
		}
		throw e;
	}
	return host.out.join('');
}

/** runs a fragment and parses the JSON object it printed */
export async function runJson(host: RunHost, code: string): Promise<Payload> {
	return host.settleReply(parseJsonReply(await host.run(code)));
}

/**
 * Answers an `exit()` for a reply that carries no JSON, and drops the interpreter it left behind.
 *
 * `exit()` returns 0 and leaves an instance that runs nothing and prints nothing, so every later
 * request would answer empty until something recycled it. Headers, cookies and shutdown functions
 * set before the exit are not recoverable from PHP, so the request fails rather than answering
 * without them.
 */
export async function settleReply(host: RunHost, reply: Payload): Promise<Payload> {
	if (!(await endedInExit(host.lastRet, reply, (code) => host.run(code)))) return reply;
	const partial = String(reply['raw'] ?? '').slice(0, 200);
	host.exitedRuns = (host.exitedRuns ?? 0) + 1;
	host.lastExit = { at: host.nowMs(), partial };
	host.dropInterpreter();
	// the render path logs `raw` and answers with `error` alone
	return { error: EXIT_ERROR, exited: true, ...(partial ? { raw: partial } : {}) };
}
