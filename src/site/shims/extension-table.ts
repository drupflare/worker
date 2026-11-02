import { SODIUM_API } from '../generated/sodium-api';
import { SODIUM_MANIFEST } from '../generated/sodium-manifest';

/** the names of an extension's API: its functions, constants and classes */
export type ApiSurface = {
	functions: readonly string[];
	constants: readonly string[];
	classes: readonly string[];
};

/** the built-ins the stand-in replaces, removed through `disable_functions` at boot */
export const EXTENSION_FUNCTIONS = [
	'extension_loaded',
	'get_loaded_extensions',
	'get_extension_funcs'
] as const;

/**
 * What `get_loaded_extensions()` can list. The built-in is disabled, so the list is a catalog of
 * names filtered by `ReflectionExtension`, in the order the shipping binary reports them first.
 */
export const EXTENSION_CATALOG: readonly string[] = [
	'Core',
	'date',
	'lexbor',
	'pcre',
	'zlib',
	'cfwpark',
	'ctype',
	'uri',
	'json',
	'filter',
	'hash',
	'SPL',
	'mbstring',
	'Zend OPcache',
	'session',
	'standard',
	'PDO',
	'pib',
	'random',
	'Reflection',
	'libxml',
	'SimpleXML',
	'tokenizer',
	'dom',
	'vrzno',
	'xml',
	'yaml',
	'bcmath',
	'bz2',
	'calendar',
	'curl',
	'exif',
	'fileinfo',
	'ftp',
	'gd',
	'gettext',
	'gmp',
	'iconv',
	'intl',
	'mysqli',
	'mysqlnd',
	'openssl',
	'pdo_mysql',
	'pdo_pgsql',
	'pdo_sqlite',
	'pgsql',
	'phar',
	'posix',
	'readline',
	'soap',
	'sockets',
	'sodium',
	'sqlite3',
	'xmlreader',
	'xmlwriter',
	'xsl',
	'zip',
	'apcu',
	'redis'
];

/** the shape of `SODIUM_API` the check reads */
export const surfaceOf = (api: {
	functions: readonly { name: string }[];
	constants: Readonly<Record<string, unknown>>;
	classes: readonly string[];
}): ApiSurface => ({
	functions: api.functions.map((f) => f.name),
	constants: Object.keys(api.constants),
	classes: api.classes
});

/** whether a conformance manifest covers every name of an API */
export function covers(manifest: ApiSurface, api: ApiSurface): boolean {
	const has = (have: readonly string[], want: readonly string[]) => {
		const set = new Set(have);
		return want.every((name) => set.has(name));
	};
	return (
		has(manifest.functions, api.functions) &&
		has(manifest.constants, api.constants) &&
		has(manifest.classes, api.classes)
	);
}

/** an extension a shim stands in for, with the API it must cover and the manifest that says it does */
export type ShimClaim = { api: ApiSurface; manifest: ApiSurface };

/** the extensions a shim claims to cover whole; a partial shim does not appear here */
export const SHIM_CLAIMS: Readonly<Record<string, ShimClaim>> = {
	sodium: { api: surfaceOf(SODIUM_API), manifest: SODIUM_MANIFEST }
};

/**
 * The declared table: an extension answers true only when its manifest covers its whole API, and
 * the value is the function list `get_extension_funcs()` gives. Everything else answers as the
 * build does, so `gd`, `curl` and the other partial shims stay false.
 */
export function extensionTable(claims: Readonly<Record<string, ShimClaim>> = SHIM_CLAIMS) {
	const table: Record<string, string[]> = {};
	for (const [name, claim] of Object.entries(claims)) {
		if (covers(claim.manifest, claim.api)) table[name] = [...claim.api.functions];
	}
	return table;
}

/** what the stand-in answers true for */
export const EXTENSION_TABLE: Readonly<Record<string, string[]>> = extensionTable();
