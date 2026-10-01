import { MB_ASCII_PHP, MB_FIX_PHP, MB_SANITIZE_PHP } from '../site/generated/assets';
import { hoistUses, phpWhen } from '../util/php';
import { UNICODE_TABLES } from './unicode-tables';

/**
 * Closes the mb_substr() content-loss bug in PHP, without a rebuild.
 *
 * Without mbstring, Symfony's polyfill returns `''` for any string with invalid UTF-8 (iconv
 * returns false), where native PHP substitutes '?'. Real iconv fails the same way, so compiling it
 * in would not help. This defines the affected mb_* functions before the polyfill bootstraps, so
 * its `function_exists()` guards skip; each replaces invalid UTF-8 with '?' and delegates to the
 * polyfill. `mb_check_encoding()` and `mb_detect_encoding()` are left alone: sanitising first would
 * make the former answer true for invalid input.
 *
 * Inert on a build carrying mbstring (the shipping long64 build does); the guard is the contract.
 * Exported alone so a gate test can drive it against native mbstring as the oracle.
 */
export const MB_SANITIZE = `\n${phpWhen("!function_exists('cfw_mb_sanitize')", MB_SANITIZE_PHP)}\n`;

/**
 * The corrections that need no host call and no generated table, separate from the wrappers so
 * `scripts/measure/mb-parity.ts` can price each on its own.
 *
 * The ASCII fast path skips iconv for the common all-ASCII inputs (machine names, langcodes,
 * header names); `strtolower()` is a safe substitute only because it is ASCII-only since PHP 8.2.
 * The final-sigma post-pass lowercases a word-final capital sigma to U+03C2, which the polyfill's
 * flat table cannot express (it is contextual: a letter precedes it and none follows).
 */
export const MB_ASCII = MB_ASCII_PHP;

/**
 * The wrappers; each is defined only if the real extension is absent.
 */
export const MB_FIX = hoistUses(
	`\n${MB_SANITIZE}\n${MB_ASCII}\n${UNICODE_TABLES}\n${phpWhen(
		"!extension_loaded('mbstring') && !function_exists('cfw_mb_installed')",
		MB_FIX_PHP
	)}\n`
);
