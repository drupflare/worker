const TOKEN = /^([ \t]*)\/\/ __CFW_([A-Z0-9_]+)__$|__CFW_([A-Z0-9_]+)__/gm;
const LEFTOVER = /__CFW_[A-Z0-9_]+__/;

/**
 * Fills the `__CFW_NAME__` tokens of a PHP or HTML asset from `vars`. A `// __CFW_NAME__` line is
 * replaced whole and keeps its indent; an inline token in place. Throws on a missing value or a
 * leftover token.
 */
export function renderTemplate(text: string, vars: Readonly<Record<string, string>>): string {
	const out = text.replace(
		TOKEN,
		(
			_match,
			indent: string | undefined,
			line: string | undefined,
			inline: string | undefined
		) => {
			const name = (line ?? inline) as string;
			const value = vars[name];
			if (value === undefined) throw new Error(`unresolved template token __CFW_${name}__`);
			return (indent ?? '') + value;
		}
	);
	const left = LEFTOVER.exec(out);
	if (left) throw new Error(`unresolved template token ${left[0]}`);
	return out;
}
