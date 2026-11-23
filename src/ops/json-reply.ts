/** how many candidate objects are tried before the output is called unparseable */
const CANDIDATES = 20;

/**
 * What a harness prints right before its reply when PHP ended in `exit()`; mirrors
 * `cfw_reply_arm()` in `src/site/php/exit-reply.php`.
 */
export const EXIT_REPLY_MARK = '\x1ecfw-reply\x1e';

/**
 * Clears the reply a harness armed. A run that ends in a fatal never prints it, and a later
 * fragment that exits would print one request's reply into another's answer.
 */
export const EXIT_REPLY_DISARM = '<?php unset($GLOBALS["__cfw_reply"]);';

const utf8 = new TextEncoder();

/**
 * The reply of a run that ended in `exit()`: the object after the mark, with everything PHP
 * printed before the mark as the body when the reply carries an empty `html` (a render that
 * finished sends its own).
 */
function parseExitReply(printed: string, json: string): Record<string, unknown> | undefined {
	try {
		const reply = JSON.parse(json);
		if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return undefined;
		if (reply.html === '') {
			reply.html = printed;
			reply.bytes = utf8.encode(printed).length;
		}
		return reply;
	} catch {
		return undefined;
	}
}

/**
 * The JSON object a PHP fragment printed after any notices. A deprecation such as `{closure}` or
 * a log line such as `%date{M j}` carries a brace, so each `{` that could open an object is tried
 * in turn until the rest parses; one that cannot (`{` then a letter) is skipped without counting.
 *
 * A reply that follows {@link EXIT_REPLY_MARK} is read from the mark, since the page PHP printed
 * before an `exit()` can hold any number of braces.
 */
export function parseJsonReply(raw: string): Record<string, unknown> {
	const mark = raw.lastIndexOf(EXIT_REPLY_MARK);
	if (mark >= 0) {
		const exited = parseExitReply(raw.slice(0, mark), raw.slice(mark + EXIT_REPLY_MARK.length));
		if (exited) return exited;
	}
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
 * Whether the run that printed `reply` ended in `exit()` or `die()` on an interpreter that is dead
 * afterwards.
 *
 * The pinned interpreter survives an exit and the harnesses answer from a shutdown function, so
 * this only fires for a build without the exit fix (a stale pin). Only a return code of 0 with no
 * JSON qualifies: a fatal returns 1 or 2 and the instance survives. A probe settles it, since a
 * harness that finished but printed nothing parseable is alive too.
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
