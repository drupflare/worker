/**
 * Differential test for the LIKE BINARY -> GLOB translation.
 *
 * Drupal maps 'LIKE BINARY' to SQLite's GLOB operator and then *redefines* glob
 * with a PHP callback so it behaves as case-sensitive LIKE:
 *
 *   sqlFunctionLikeBinary($pattern, $subject):
 *     $pattern = str_replace(['%','_'], ['.*?','.'], preg_quote($pattern,'/'));
 *     return preg_match('/^'.$pattern.'$/', $subject);
 *
 * Durable Object SQLite cannot register that callback, so LIKE BINARY would fall
 * through to the BUILTIN GLOB -- whose pattern language differs in both
 * directions and fails silently:
 *
 *   %  and _   are literals under GLOB but wildcards under LIKE
 *   *, ?, [..] are wildcards under GLOB but literals under LIKE
 *
 * So a search for a literal "*" matches everything, a "%" wildcard matches
 * nothing, and a "[" in user input silently changes query semantics. Nothing
 * errors. This is the highest-priority correctness item in the port.
 *
 * The translation is mechanical; the risk is in the edges, so this generates
 * random pattern/subject pairs over an alphabet loaded with the dangerous
 * characters and asserts the two paths agree exactly.
 */

/** LIKE pattern -> GLOB pattern. Mirrors likeToGlob() in the PHP harness. */
export function likeToGlob(pattern: string): string {
	let out = '';
	for (const ch of pattern) {
		if (ch === '%') out += '*';
		else if (ch === '_') out += '?';
		// GLOB metacharacters must become literals; SQLite has no GLOB ESCAPE,
		// so a single-character class is the only way to quote them
		else if (ch === '*' || ch === '?' || ch === '[') out += `[${ch}]`;
		else out += ch;
	}
	return out;
}

/** The alphabet is deliberately hostile: every metacharacter of both languages. */
export const ALPHABET = [...'ab%_*?[]\\^-.'];

export function generateCases(count: number, seed = 1): [string, string][] {
	// deterministic LCG so a failing run is reproducible
	let s = seed >>> 0;
	const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	const pick = () => ALPHABET[Math.floor(rnd() * ALPHABET.length)];
	const str = (max: number) => {
		const n = Math.floor(rnd() * max);
		let r = '';
		for (let i = 0; i < n; i++) r += pick();
		return r;
	};

	const cases: [string, string][] = [];
	for (let i = 0; i < count; i++) cases.push([str(5), str(5)]);
	return cases;
}
