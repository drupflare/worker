export interface SourceFile {
	/** repo-relative, so a failure names the file */
	file: string;
	text: string;
}

export const joinSources = (files: readonly SourceFile[]): string =>
	files.map((f) => f.text).join('\n');

/**
 * The body of a method or function by name, or '' when there is none.
 *
 * A method moved out of the class leaves a one-line delegator under the same name, so every
 * declaration is collected and the longest body wins: that is the one doing the work, wherever it
 * lives. A body ends at the first closing brace in its own column, which is how the original
 * per-spec regexes read it.
 */
export function bodyOf(source: string, name: string): string {
	const head = new RegExp(
		`^(\\t?)(?:export\\s+)?(?:(?:private|protected|override|static)\\s+)*(?:async\\s+)?(?:function\\s+)?${name}\\(`,
		'gm'
	);
	let best = '';
	for (const m of source.matchAll(head)) {
		const end = source.indexOf(`\n${m[1]}}`, m.index);
		const body = end < 0 ? '' : source.slice(m.index, end + 2 + m[1]!.length);
		if (body.length > best.length) best = body;
	}
	return best;
}
