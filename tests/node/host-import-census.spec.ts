import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	CENSUS_FILE,
	CLASSES,
	drift,
	hostFunctions,
	loadCensus,
	rebuild,
	serialize,
	SHIPPING_WASM,
	TUNED_WASM,
	tunedExtras,
	wasmImports
} from '../../scripts/import-census';
import { CROSSING_NAMES } from '../../src/ops/crossings';

/**
 * The host surface PHP can reach, as a committed list instead of a search.
 *
 * `docs/security.md` says what a compromised PHP can touch and the module's import table is where
 * that is decided, so a new import, or one nobody classified, fails here by name. Regenerate the
 * file for a new interpreter with `bun scripts/import-census.ts --write`, then classify what it
 * marks `unclassified`.
 *
 * SKIPPED WITHOUT THE INTERPRETER: `.interp/` is a build artifact a clean checkout does not have.
 */

const have = existsSync(resolve(process.cwd(), SHIPPING_WASM));
const census = loadCensus();

/** a module with no code that imports one function from `env`, built here so no artifact is needed */
function moduleImporting(name: string): Uint8Array {
	const text = (s: string) => [s.length, ...[...s].map((c) => c.charCodeAt(0))];
	const entry = [...text('env'), ...text(name), 0x00, 0x00];
	return Uint8Array.from([
		...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
		// type section: one type, () -> ()
		...[0x01, 0x04, 0x01, 0x60, 0x00, 0x00],
		// import section: one function import
		...[0x02, entry.length + 1, 0x01, ...entry]
	]);
}

describe('the drift check names what changed', () => {
	it('reads the imports of a module as module.name:kind', () => {
		expect(wasmImports(moduleImporting('cfwNew'))).toEqual(['env.cfwNew:function']);
	});

	it('fails an import the module gained and the file does not carry', () => {
		const onFile = { 'env.known:function': { class: 'compute' as const } };
		const d = drift(onFile, ['env.cfwNew:function', 'env.known:function']);
		expect(d.added).toEqual(['env.cfwNew:function']);
	});

	it('fails an entry removed from the file, and one the module dropped', () => {
		const onFile = {
			'env.a:function': { class: 'compute' as const },
			'env.b:function': { class: 'io' as const }
		};
		expect(
			drift({ 'env.a:function': onFile['env.a:function'] }, Object.keys(onFile)).added
		).toEqual(['env.b:function']);
		expect(drift(onFile, ['env.a:function']).removed).toEqual(['env.b:function']);
	});

	it('fails an entry with no classification, however it is spelled', () => {
		const d = drift(
			{
				'env.a:function': { class: 'unclassified' },
				'env.b:function': { class: 'safe' as never },
				'env.c:function': { class: 'hard' }
			},
			['env.a:function', 'env.b:function', 'env.c:function']
		);
		expect(d.unclassified).toEqual(['env.a:function', 'env.b:function']);
	});

	it('keeps a classification across a rebuild and marks only the new name', () => {
		const previous = {
			wasm: { 'env.a:function': { class: 'io' as const, note: 'kept' } },
			host: {}
		};
		const next = rebuild(previous, ['env.a:function', 'env.cfwNew:function'], []);
		expect(next.wasm['env.a:function']).toEqual({ class: 'io', note: 'kept' });
		expect(next.wasm['env.cfwNew:function']).toEqual({ class: 'unclassified' });
		expect(rebuild(previous, [], []).wasm).toEqual({});
	});
});

describe('the committed census', () => {
	it('classifies every entry with a known class', () => {
		for (const side of [census.wasm, census.host]) {
			expect(drift(side, Object.keys(side)).unclassified).toEqual([]);
			for (const entry of Object.values(side)) {
				expect(CLASSES as readonly string[]).toContain(entry.class);
			}
		}
	});

	it.skipIf(!have)('matches every import of the shipping module, by name', () => {
		const measured = wasmImports(readFileSync(resolve(process.cwd(), SHIPPING_WASM)));
		const d = drift(census.wasm, measured);
		expect(d.added, `imports not in ${CENSUS_FILE}`).toEqual([]);
		expect(d.removed, `entries in ${CENSUS_FILE} the module no longer imports`).toEqual([]);
		expect(Object.keys(census.wasm)).toHaveLength(measured.length);
	});

	it.skipIf(!have || !existsSync(resolve(process.cwd(), TUNED_WASM)))(
		'adds only the imported memory in the tuned copy the object instantiates',
		() => {
			const shipping = wasmImports(readFileSync(resolve(process.cwd(), SHIPPING_WASM)));
			const tuned = wasmImports(readFileSync(resolve(process.cwd(), TUNED_WASM)));
			expect(tunedExtras(shipping, tuned)).toEqual(['env.memory:memory']);
			expect(tunedExtras(tuned, shipping)).toEqual([]);
		}
	);

	it('matches every cfw host function the object installs, by name', () => {
		const names = [...new Set(hostFunctions().map((h) => h.name))];
		const d = drift(census.host, names);
		expect(d.added, `host functions not in ${CENSUS_FILE}`).toEqual([]);
		expect(d.removed, `entries in ${CENSUS_FILE} nothing installs`).toEqual([]);
	});

	it.skipIf(!have)('is what --write would regenerate, byte for byte', () => {
		const measured = wasmImports(readFileSync(resolve(process.cwd(), SHIPPING_WASM)));
		const names = [...new Set(hostFunctions().map((h) => h.name))];
		expect(serialize(rebuild(census, measured, names))).toBe(
			readFileSync(resolve(process.cwd(), CENSUS_FILE), 'utf8')
		);
	});

	it('finds every capability the crossing tally wraps, so the scan is not missing a family', () => {
		const names = new Set(hostFunctions().map((h) => h.name));
		for (const name of CROSSING_NAMES) expect(names, name).toContain(name);
	});
});

describe('what a host function can name', () => {
	const functions = hostFunctions();
	const naming = (token: RegExp) =>
		[...new Set(functions.filter((f) => token.test(f.source)).map((f) => f.name))].sort();

	it('names neither the SITE namespace nor the fleet database', () => {
		expect(naming(/\bSITE\b/)).toEqual([]);
		expect(naming(/\bFLEET_DB\b/)).toEqual([]);
	});

	// `cfwSettings` reaches the lever store on purpose; `docs/security.md` says it does
	it('reaches CONFIG_KV through cfwSettings alone', () => {
		expect(naming(/\bCONFIG_KV\b/)).toEqual(['cfwSettings']);
	});

	it('sees a planted host function that names one, through a computed key and a cast', () => {
		const root = mkdtempSync(join(tmpdir(), 'cfw-census-'));
		try {
			mkdirSync(join(root, 'src'));
			writeFileSync(
				join(root, 'src/planted.ts'),
				[
					"const BRIDGE = 'cfwViaConst';",
					'binary[BRIDGE] = (json: string) => site.env.SITE.get(json);',
					"(binary as unknown as Record<string, unknown>)['cfwViaCast'] = () => env.FLEET_DB;",
					'node.cfwDirty = true;'
				].join('\n')
			);
			const planted = hostFunctions(root);
			expect(planted.map((f) => f.name)).toEqual(['cfwViaCast', 'cfwViaConst']);
			expect(planted.filter((f) => /\bSITE\b/.test(f.source)).map((f) => f.name)).toEqual([
				'cfwViaConst'
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
