import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { dumpNativeApi } from '../../scripts/gen-sodium-api';
import { SODIUM_API } from '../../src/site/generated/sodium-api';
import { SODIUM_MANIFEST } from '../../src/site/generated/sodium-manifest';
import {
	EXTENSION_TABLE,
	SHIM_CLAIMS,
	covers,
	extensionTable,
	surfaceOf
} from '../../src/site/shims/extension-table';
import { EXTENSIONS_FIX, extensionTablePhp } from '../../src/site/shims/extensions-fix';
import {
	VERSION_CONSTANTS,
	manifestOf,
	runConformance,
	type Conformance
} from '../helpers/sodium-conformance';
import { nativePhp, shimReflection } from '../helpers/sodium-harness';

/**
 * The sodium stand-in against the native extension, and the rule that lets it answer
 * `extension_loaded('sodium')`.
 *
 * The rule is conditional: an extension may read loaded when a shim covers its WHOLE API and the
 * covering is held by this gate. `bun run gen:sodium-manifest` writes the manifest from the same
 * run, and the table is computed from it, so a true that the run does not support cannot be
 * committed. The differential half needs a native PHP 8.5 with the full ext-sodium inventory and
 * is skipped without one; the table half is pure and always runs.
 */

const native = nativePhp() !== undefined;

describe('the declared extension table', () => {
	const api = surfaceOf(SODIUM_API);

	it('answers true for sodium only because the manifest covers the whole API', () => {
		expect(covers(SODIUM_MANIFEST, api)).toBe(true);
		expect(Object.keys(EXTENSION_TABLE)).toEqual(['sodium']);
		expect(EXTENSION_TABLE['sodium']).toEqual(SODIUM_API.functions.map((f) => f.name));
	});

	it('cannot be true without a passing manifest', () => {
		const empty = { functions: [], constants: [], classes: [] };
		expect(extensionTable({ sodium: { api, manifest: empty } })).toEqual({});
	});

	it.each(api.functions)('turns false when the manifest loses %s', (name) => {
		const manifest = {
			...SODIUM_MANIFEST,
			functions: SODIUM_MANIFEST.functions.filter((f) => f !== name)
		};
		expect(extensionTable({ sodium: { api, manifest } })).toEqual({});
	});

	it('turns false when the manifest loses one constant or the class', () => {
		const first = api.constants[0]!;
		const noConstant = {
			...SODIUM_MANIFEST,
			constants: SODIUM_MANIFEST.constants.filter((c) => c !== first)
		};
		const noClass = { ...SODIUM_MANIFEST, classes: [] };
		expect(extensionTable({ sodium: { api, manifest: noConstant } })).toEqual({});
		expect(extensionTable({ sodium: { api, manifest: noClass } })).toEqual({});
	});

	it('leaves a partial shim false: gd, curl and the rest are never in the table', () => {
		const partial = {
			...SHIM_CLAIMS,
			gd: {
				api: {
					functions: ['imagecreatetruecolor', 'imagefilter'],
					constants: [],
					classes: []
				},
				manifest: { functions: ['imagecreatetruecolor'], constants: [], classes: [] }
			}
		};
		const table = extensionTable(partial);
		expect(table['gd']).toBeUndefined();
		expect(table['sodium']).toBeDefined();
		for (const name of ['gd', 'curl', 'openssl', 'exif', 'fileinfo', 'zip', 'xmlwriter']) {
			expect(EXTENSION_TABLE[name], name).toBeUndefined();
		}
	});

	it('writes the table into the fragment, and only for what is true', () => {
		expect(extensionTablePhp({})).toContain("$GLOBALS['__cfw_ext_shims'] = [];");
		expect(extensionTablePhp({ foo: ['foo_a'] })).toContain("'foo' => ['foo_a']");
		expect(EXTENSIONS_FIX).toContain(
			"'sodium' => ['sodium_crypto_aead_aes256gcm_is_available'"
		);
	});
});

describe('the stand-in functions, run on a real PHP', () => {
	const fragment = (table: Record<string, string[]>) =>
		`<?php ${EXTENSIONS_FIX.replace(/\$GLOBALS\['__cfw_ext_shims'\] = \[.*\];\n/, `${extensionTablePhp(table).split('\n')[0]}\n`)}`;

	function answers(table: Record<string, string[]>) {
		const code = `${fragment(table)}
echo json_encode([
	'foo' => extension_loaded('foo'),
	'upper' => extension_loaded('FOO'),
	'standard' => extension_loaded('standard'),
	'missing' => extension_loaded('no-such-ext'),
	'again' => extension_loaded('no-such-ext'),
	'listed' => in_array('foo', get_loaded_extensions(), true),
	'listedStandard' => in_array('standard', get_loaded_extensions(), true),
	'funcs' => get_extension_funcs('foo'),
	'stdFuncs' => in_array('strlen', get_extension_funcs('standard') ?: [], true) || in_array('array_map', get_extension_funcs('standard') ?: [], true),
	'noFuncs' => get_extension_funcs('no-such-ext'),
]);`;
		const names = ['extension_loaded', 'get_loaded_extensions', 'get_extension_funcs'];
		const run = spawnSync(
			'php',
			[
				'-n',
				'-d',
				`disable_functions=${names.join(',')}`,
				'-r',
				code.replace(/^<\?php /, '')
			],
			{ encoding: 'utf8' }
		);
		return JSON.parse(run.stdout);
	}

	it('answers from the table and from the build, case-insensitively', () => {
		expect(answers({ foo: ['foo_a', 'foo_b'] })).toEqual({
			foo: true,
			upper: true,
			standard: true,
			missing: false,
			again: false,
			listed: true,
			listedStandard: true,
			funcs: ['foo_a', 'foo_b'],
			stdFuncs: true,
			noFuncs: false
		});
	});

	it('answers false for an extension the table does not hold', () => {
		const out = answers({});
		expect(out.foo).toBe(false);
		expect(out.listed).toBe(false);
		expect(out.funcs).toBe(false);
	});
});

describe.skipIf(!native)('against native ext-sodium', () => {
	let result: Conformance;

	beforeAll(async () => {
		result = await runConformance();
	}, 300_000);

	it('agrees with the committed inventory, apart from the library version', () => {
		const live = dumpNativeApi()!;
		expect(live.functions).toEqual(SODIUM_API.functions);
		expect(live.classes).toEqual(SODIUM_API.classes);
		const rest = (c: Record<string, unknown>) =>
			Object.fromEntries(Object.entries(c).filter(([k]) => !VERSION_CONSTANTS.has(k)));
		expect(rest(live.constants)).toEqual(rest(SODIUM_API.constants));
	});

	it('passes every function on every case, and says how many ran', () => {
		const failing = Object.entries(result.functions)
			.filter(([, f]) => f.failures.length > 0)
			.map(([name, f]) => `${name}: ${f.failures[0]}`);
		expect(failing).toEqual([]);
		const unrun = Object.entries(result.functions).filter(([, f]) => f.cases === 0);
		expect(unrun.map(([name]) => name)).toEqual([]);
		expect(result.cases).toBeGreaterThan(10_000);
	});

	it('commits the manifest the run produces, so the table cannot drift from the gate', () => {
		expect(manifestOf(result)).toEqual({
			functions: [...SODIUM_MANIFEST.functions],
			constants: [...SODIUM_MANIFEST.constants],
			classes: [...SODIUM_MANIFEST.classes]
		});
	});

	it('declares each function with the names, by-reference marks and defaults the native one has', () => {
		const shim = shimReflection();
		for (const f of SODIUM_API.functions) {
			const got = shim[f.name]!.map((p) => ({
				name: p.name,
				...(p.ref ? { ref: true } : {}),
				...(p.sensitive ? { sensitive: true } : {}),
				...(p.opt ? { def: p.def } : {})
			}));
			const want = f.params.map((p) => ({
				name: p.name,
				...('ref' in p && p.ref ? { ref: true } : {}),
				...('sensitive' in p && p.sensitive ? { sensitive: true } : {}),
				...('def' in p ? { def: p.def } : {})
			}));
			expect(got, f.name).toEqual(want);
		}
	});
});
