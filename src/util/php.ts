import { renderTemplate } from './template';

/**
 * A PHP single-quoted string literal. PHP interpolates `$var` and `{$expr}` inside double quotes,
 * which `JSON.stringify` does not escape, so a value from outside never goes into PHP that way.
 */
export function phpSingle(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * A PHP double-quoted string literal of a string, for the templates that already sit in a double
 * quoted context. `JSON.stringify` escapes the quote and the backslash but not `$`, and PHP runs
 * `${expr}` and `{$expr}` inside double quotes, so the `$` is escaped here.
 */
export function phpDouble(value: string): string {
	return JSON.stringify(value).replace(/\$/g, '\\$');
}

/** a PHP list of single-quoted strings */
export function phpSingleList(values: readonly string[]): string {
	return `[${values.map(phpSingle).join(', ')}]`;
}

/** Drupal's machine name for a module: lowercase letters, digits and underscores, 50 at most */
export function isModuleName(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 50 && /^[a-z][a-z0-9_]*$/.test(value);
}

/**
 * Wraps PHP declarations in an `if` block, so they bind at run time. Keep the `function_exists`
 * or `class_exists` half of a guard: a fragment can run twice and a redeclare is fatal.
 */
export function phpWhen(condition: string, code: string): string {
	return `if (${condition}) {\n${code}\n}`;
}

const USE_LINE = /^use [A-Za-z_][A-Za-z0-9_\\]*(?: as [A-Za-z_][A-Za-z0-9_]*)?;[ \t]*\n/gm;
const OPEN_TAG = /^<\?php[ \t]*\n?/;

/**
 * Moves every `use Name;` line at column 0 into one deduplicated block at the top (after the
 * `<?php` tag when present). A `use` cannot sit inside the `if` of {@link phpWhen} or a `try`, and
 * a duplicate import is fatal. Closure `use (&$x)` and trait `use` do not move.
 */
export function hoistUses(text: string): string {
	const found: string[] = [];
	const body = text.replace(USE_LINE, (line) => {
		if (!found.includes(line)) found.push(line);
		return '';
	});
	if (found.length === 0) return text;
	const tag = OPEN_TAG.exec(body)?.[0] ?? '';
	const rest = body.slice(tag.length);
	return `${tag}${tag.endsWith('\n') || tag === '' ? '' : '\n'}${found.join('')}${rest}`;
}

/** a whole script: the open tag, then `code` with every `use` line lifted to the top */
export function phpScript(code: string): string {
	return hoistUses(`<?php\n${code}`);
}

/** a whole script from an asset: its tokens filled from `vars`, then as {@link phpScript} */
export function phpRender(template: string, vars: Readonly<Record<string, string>>): string {
	return phpScript(renderTemplate(template, vars));
}
