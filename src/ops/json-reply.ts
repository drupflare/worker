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
