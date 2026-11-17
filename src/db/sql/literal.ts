const ENCODER = new TextEncoder();

/**
 * Applies MySQL's backslash escapes, so the value in hand is the value in the column.
 *
 * Backslash-percent and backslash-underscore keep their backslash, as MySQL documents: they only
 * mean a literal wildcard inside a LIKE pattern and outside one they stay two characters.
 *
 * @param raw the text between the quotes
 * @param quote the quote character the literal used; its doubled form is one literal quote
 */
export function decodeMysqlString(raw: string, quote: string = "'"): string {
	const length = raw.length;
	let out = '';
	let i = 0;
	while (i < length) {
		let run = i;
		while (run < length && raw[run] !== '\\' && raw[run] !== quote) run++;
		if (run > i) {
			out += raw.slice(i, run);
			i = run;
			continue;
		}
		if (raw[i] === quote) {
			// a doubled quote is the quote character; a lone one is kept as written
			out += quote;
			i += i + 1 < length && raw[i + 1] === quote ? 2 : 1;
			continue;
		}
		if (i + 1 >= length) {
			out += '\\';
			break;
		}
		const escaped = raw[i + 1] as string;
		i += 2;
		switch (escaped) {
			case '0':
				out += '\0';
				break;
			case 'n':
				out += '\n';
				break;
			case 'r':
				out += '\r';
				break;
			case 't':
				out += '\t';
				break;
			case 'b':
				out += '\x08';
				break;
			case 'Z':
				out += '\x1a';
				break;
			case '%':
				out += '\\%';
				break;
			case '_':
				out += '\\_';
				break;
			default:
				out += escaped;
		}
	}
	return out;
}

/**
 * A SQLite literal for one decoded value.
 *
 * A value carrying a NUL becomes `CAST(x'..' AS TEXT)`, because SQLite's parser ends a string
 * literal at the NUL and the rest of the row becomes syntax.
 */
export function encodeSqliteString(value: string): string {
	if (value.includes('\0')) {
		let hex = '';
		for (const byte of ENCODER.encode(value)) hex += byte.toString(16).padStart(2, '0');
		return `CAST(x'${hex}' AS TEXT)`;
	}
	return `'${value.replaceAll("'", "''")}'`;
}

/** the decoded value of one quoted MySQL string token (quotes included) */
export function decodeStringToken(text: string): string {
	const quote = text[0] === 'N' || text[0] === 'n' ? (text[1] as string) : (text[0] as string);
	const start = text[0] === quote ? 1 : 2;
	return decodeMysqlString(text.slice(start, -1), quote);
}
