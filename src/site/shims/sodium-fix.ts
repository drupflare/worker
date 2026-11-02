/**
 * The PHP half of the sodium stand-in: the constants, `SodiumException` and a wrapper for each
 * function of ext-sodium, over the host library in `sodium-lib.ts`.
 *
 * The rule for `extension_loaded('sodium')` is conditional. It answers true only when the
 * conformance manifest (`generated/sodium-manifest.ts`, written by the gate in
 * `tests/node/sodium-conformance.spec.ts`) covers every function, constant and class of the
 * native inventory (`generated/sodium-api.ts`); the table that decides is `extension-table.ts`.
 * This fragment guards on its own flag and on `function_exists`, never on that answer. A stub
 * extension entry in the engine is not used: one crashed the isolate (exit 139) when tried for
 * mbstring.
 *
 * @module
 */
import { renderTemplate } from '../../util/template';
import { SODIUM_FIX_PHP } from '../generated/assets';
import { SODIUM_API } from '../generated/sodium-api';

/** the functions the PHP half answers with no host call */
export const PHP_ONLY_FUNCTIONS: ReadonlySet<string> = new Set([
	'sodium_bin2hex',
	'sodium_hex2bin',
	'sodium_bin2base64',
	'sodium_base642bin',
	'sodium_pad',
	'sodium_unpad',
	'sodium_memzero',
	'sodium_memcmp',
	'sodium_compare',
	'sodium_increment',
	'sodium_add'
]);

const phpLiteral = (v: string | number | boolean | null): string =>
	typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : String(v);

/** the `define()` lines for every constant of the inventory */
export function sodiumConstantsPhp(): string {
	return Object.entries(SODIUM_API.constants)
		.map(
			([name, value]) =>
				`\t\tif (!defined('${name}')) { define('${name}', ${phpLiteral(value)}); }`
		)
		.join('\n');
}

type ApiFunction = (typeof SODIUM_API.functions)[number];

const hostFunctions = (): ApiFunction[] =>
	SODIUM_API.functions.filter((f) => !PHP_ONLY_FUNCTIONS.has(f.name));

/** the kind letters and names `cfw_sodium_go` coerces by: s string, i int, r by-reference state */
export function sodiumSignaturesPhp(): string {
	const rows = hostFunctions().map((f) => {
		const kinds = f.params
			.map((p) => ('ref' in p && p.ref ? 'r' : p.type === 'int' ? 'i' : 's'))
			.join('');
		return `\t\t\t'${f.name}' => ['${kinds}', '${f.params.map((p) => p.name).join(',')}']`;
	});
	return `\t\t$GLOBALS['__cfw_sodium_sig'] = [\n${rows.join(',\n')}\n\t\t];`;
}

/** one wrapper, declared only where the name is free */
function wrapperPhp(f: ApiFunction): string {
	const params = f.params.map((p) => {
		const attr = 'sensitive' in p && p.sensitive ? '#[\\SensitiveParameter] ' : '';
		const ref = 'ref' in p && p.ref ? '&' : '';
		const def = 'def' in p ? ` = ${phpLiteral(p.def as string | number)}` : '';
		return `${attr}${ref}$${p.name}${def}`;
	});
	const args = f.params.map((p) => ('ref' in p && p.ref ? '&' : '') + `$${p.name}`);
	return (
		`\t\tif (!function_exists('${f.name}')) {\n` +
		`\t\t\tfunction ${f.name}(${params.join(', ')})\n` +
		`\t\t\t{\n\t\t\t\treturn cfw_sodium_go(__FUNCTION__, [${args.join(', ')}]);\n\t\t\t}\n\t\t}`
	);
}

/** the wrappers for every function the host backs */
export function sodiumFunctionsPhp(): string {
	return hostFunctions().map(wrapperPhp).join('\n');
}

/**
 * The PHP half: the constants, `SodiumException`, and a wrapper for each function that calls the
 * host. It guards on its own flag and on `function_exists`, never on `extension_loaded('sodium')`,
 * whose answer is the stand-in's to give.
 */
export const SODIUM_FIX = renderTemplate(SODIUM_FIX_PHP, {
	SODIUM_CONSTANTS: sodiumConstantsPhp(),
	SODIUM_SIGNATURES: sodiumSignaturesPhp(),
	SODIUM_FUNCTIONS: sodiumFunctionsPhp()
});
