/** how many opening braces are tried before the output is called unparseable */
const CANDIDATES = 20;

/**
 * The JSON object a PHP fragment printed, when notices came out ahead of it.
 *
 * A deprecation such as `{closure}` carries a brace of its own, so the first `{` in the output is not
 * always where the reply starts; each one is tried in turn until the rest of the output parses.
 */
export function parseJsonReply(raw: string): Record<string, unknown> {
	let start = raw.indexOf('{');
	if (start < 0) return { error: 'no JSON in output', raw: raw.slice(0, 2000) };
	let failure: unknown;
	for (let tried = 0; start >= 0 && tried < CANDIDATES; tried++) {
		try {
			return JSON.parse(raw.slice(start));
		} catch (e) {
			failure ??= e;
		}
		start = raw.indexOf('{', start + 1);
	}
	return {
		error: `unparseable: ${(failure as Error | undefined)?.message ?? failure}`,
		raw: raw.slice(0, 2000)
	};
}
