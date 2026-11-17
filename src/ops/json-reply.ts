/** how many candidate objects are tried before the output is called unparseable */
const CANDIDATES = 20;

/**
 * The JSON object a PHP fragment printed after any notices. A deprecation such as `{closure}` or
 * a log line such as `%date{M j}` carries a brace, so each `{` that could open an object is tried
 * in turn until the rest parses; one that cannot (`{` then a letter) is skipped without counting.
 */
export function parseJsonReply(raw: string): Record<string, unknown> {
	let failure: unknown;
	let tried = 0;
	for (const open of raw.matchAll(/\{\s*["}]/g)) {
		if (tried++ >= CANDIDATES) break;
		try {
			return JSON.parse(raw.slice(open.index));
		} catch (e) {
			failure ??= e;
		}
	}
	if (tried === 0) return { error: 'no JSON in output', raw: raw.slice(0, 2000) };
	return {
		error: `unparseable: ${(failure as Error | undefined)?.message ?? failure}`,
		raw: raw.slice(0, 2000)
	};
}

/** what a live interpreter prints for the probe in {@link endedInExit}; a dead one prints nothing */
const ALIVE_ANSWER = 'cfw-alive';

/** the error a request gets when its PHP ended in `exit()` */
export const EXIT_ERROR =
	'the request ended with exit() before the harness answered; the interpreter was dropped';

/** whether a reply is one `parseJsonReply` built because the output held no usable object */
function isMissingReply(reply: Record<string, unknown>): boolean {
	const error = reply['error'];
	return (
		typeof reply['raw'] === 'string' &&
		typeof error === 'string' &&
		(error === 'no JSON in output' || error.startsWith('unparseable: '))
	);
}

/**
 * Whether the run that printed `reply` ended in `exit()` or `die()`, which leaves an interpreter
 * that executes nothing from then on.
 *
 * Only a return code of 0 with no JSON qualifies: a fatal returns 1 or 2 and the instance survives.
 * A probe settles it, since a harness that finished but printed nothing parseable is alive too.
 */
export async function endedInExit(
	ret: number | undefined,
	reply: Record<string, unknown>,
	run: (code: string) => Promise<string>
): Promise<boolean> {
	if (ret !== 0 || !isMissingReply(reply)) return false;
	try {
		return !(await run(`<?php echo '${ALIVE_ANSWER}';`)).includes(ALIVE_ANSWER);
	} catch {
		// a probe that throws has no interpreter to keep
		return true;
	}
}
