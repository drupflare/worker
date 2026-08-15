import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { isSafePayloadPath, readManifest, verifyExtracted } from '../../scripts/hydrate.ts';
import { FREE_CEILING } from '../../scripts/measure/bundle-size.ts';
import {
	assertCoversAssetsIgnore,
	buildManifest,
	ceilingVerdict,
	expandPlan,
	interpreterFiles,
	negatedPaths,
	parseWranglerGzipBytes,
	payloadName,
	payloadPlan,
	scanSeededCredentials,
	shippedPaths
} from '../../scripts/release-payload.ts';

/**
 * The release payload is a contract between two machines, and every part of it that can be wrong
 * silently is checked here.
 *
 * `assets/` is gitignored and no workflow builds it, so a spec that needed the real packs would
 * either skip in CI or fail there. These assertions are split accordingly: the DECLARATIONS
 * (`.assetsignore`, `wrangler.jsonc`, the binary seam) are tracked files and are asserted against the
 * real repository unconditionally, and everything that needs bytes on disk runs over a fixture tree.
 *
 * The failure this exists for is a SHORT PAYLOAD -- a release that hydrates cleanly, deploys, and is
 * missing one of the four assets the runtime fetches, which surfaces as a 404 inside the Durable
 * Object at boot rather than as a build error.
 *
 * Node lane: it reads the filesystem and imports a build script.
 */

const temps: string[] = [];
function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), 'payload-spec-'));
	temps.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** a checkout shaped like this repo: a config, a seam, an ignore file and the four shipped assets */
function checkout(seam: string, ignore?: string): string {
	const root = fixture();
	mkdirSync(join(root, 'src/runtime'), { recursive: true });
	mkdirSync(join(root, 'assets/drupal'), { recursive: true });
	mkdirSync(join(root, 'assets/drupal-pf'), { recursive: true });
	mkdirSync(join(root, 'assets/drupal-sql'), { recursive: true });
	mkdirSync(join(root, '.interp'), { recursive: true });

	writeFileSync(
		join(root, 'wrangler.jsonc'),
		'{\n\t// a comment, because the real file has them\n' +
			'\t"alias": { "./runtime/php-binary.js": "./src/runtime/php-binary-85.ts" }\n}\n'
	);
	writeFileSync(join(root, 'src/runtime/php-binary-85.ts'), seam);
	writeFileSync(
		join(root, 'assets/.assetsignore'),
		ignore ??
			[
				'/*',
				'!/driver.json',
				'!/prefill.json',
				'!/drupal-pf/',
				'/drupal-pf/*',
				'!/drupal-pf/core.pf.json',
				'!/drupal-pf/core.pf.bin',
				'!/drupal-sql/'
			].join('\n')
	);
	writeFileSync(join(root, 'assets/drupal/twig-bake.json'), '{"prefix":"x"}');
	writeFileSync(join(root, 'assets/driver.json'), '{"a":"b"}');
	writeFileSync(join(root, 'assets/prefill.json'), '{}');
	writeFileSync(join(root, 'assets/drupal-pf/core.pf.json'), '[]');
	writeFileSync(join(root, 'assets/drupal-pf/core.pf.bin'), 'binary');
	writeFileSync(join(root, 'assets/drupal-sql/manifest.json'), '{"chunks":1}');
	writeFileSync(join(root, 'assets/drupal-sql/0000.json'), '[]');
	writeFileSync(join(root, '.interp/php8.5-worker.mjs'), 'export default 1;');
	writeFileSync(join(root, '.interp/php8.5.wasm.zst'), 'zst');
	writeFileSync(join(root, '.interp/zstddec.wasm'), 'wasm');
	return root;
}

const SEAM_85 = [
	"import { wasmModuleFromZstd } from '@drupflare/cartridge/inflate';",
	"import PHPFactory from '../../.interp/php8.5-worker.mjs';",
	"import blob from '../../.interp/php8.5.wasm.zst';",
	"import decoder from '../../.interp/zstddec.wasm';",
	'export { PHPFactory, blob, decoder, wasmModuleFromZstd };'
].join('\n');

describe('the shipping set is derived from .assetsignore, not from what looks useful', () => {
	it('reads every negation out of the real ignore file', () => {
		const source = ['# a comment', '/*', '', '!/driver.json', '!/drupal-sql/'].join('\n');
		expect(negatedPaths(source)).toEqual(['/driver.json', '/drupal-sql/']);
	});

	it('does not count a directory whose contents are re-ignored as shipped', () => {
		// `!/dir/` + `/dir/*` reaches INTO a directory; it does not ship 13 MB of it
		const source = ['/*', '!/drupal-pf/', '/drupal-pf/*', '!/drupal-pf/core.pf.bin'].join('\n');
		expect(shippedPaths(source)).toEqual(['/drupal-pf/core.pf.bin']);
	});

	it('does count a directory whose contents are not re-ignored', () => {
		expect(shippedPaths(['/*', '!/drupal-sql/'].join('\n'))).toEqual(['/drupal-sql']);
	});

	it('agrees with the REAL assets/.assetsignore', () => {
		// the drift guard: this file is tracked, so it can be asserted in CI without a build
		expect(() => payloadPlan(process.cwd())).not.toThrow();
	});

	it('fails when a file ships to the edge and is not in the payload', () => {
		const ignore = [
			'/*',
			'!/driver.json',
			'!/prefill.json',
			'!/drupal-pf/',
			'/drupal-pf/*',
			'!/drupal-pf/core.pf.json',
			'!/drupal-pf/core.pf.bin',
			'!/drupal-sql/',
			'!/newthing.json'
		].join('\n');
		expect(() => assertCoversAssetsIgnore(ignore)).toThrow(/newthing\.json ships to the edge/);
	});

	it('fails when the payload carries something the edge never serves', () => {
		expect(() => assertCoversAssetsIgnore(['/*', '!/driver.json'].join('\n'))).toThrow(
			/is in the payload and is not served/
		);
	});
});

describe('the interpreter comes from the alias, because the seam has already moved once', () => {
	it('resolves every .interp import of the aliased seam', () => {
		expect(interpreterFiles(checkout(SEAM_85))).toEqual([
			'.interp/php8.5-worker.mjs',
			'.interp/php8.5.wasm.zst',
			'.interp/zstddec.wasm'
		]);
	});

	it('refuses a seam that imports from vendor/, which one machine has', () => {
		const seam = [
			"import PHPFactory from '../../vendor/static-o2/php8.3-worker.mjs';",
			"import blob from '../../.interp/php8.3-worker.mjs.wasm.zst';"
		].join('\n');
		expect(() => interpreterFiles(checkout(seam))).toThrow(/vendor\//);
	});

	it('refuses a config with no php-binary alias at all', () => {
		const root = checkout(SEAM_85);
		writeFileSync(join(root, 'wrangler.jsonc'), '{ "alias": {} }');
		expect(() => interpreterFiles(root)).toThrow(/no php-binary alias/);
	});

	it('agrees with the REAL wrangler.jsonc, so the canonical config is carriable', () => {
		expect(interpreterFiles(process.cwd()).length).toBeGreaterThan(0);
	});
});

describe('expanding the plan to files', () => {
	it('walks a directory entry and keeps single files', () => {
		const root = checkout(SEAM_85);
		const files = expandPlan(root, payloadPlan(root));
		expect(files).toContain('assets/driver.json');
		expect(files).toContain('assets/drupal-sql/0000.json');
		expect(files).toContain('assets/drupal-sql/manifest.json');
		expect(files).toContain('.interp/zstddec.wasm');
		expect(files.length).toBe(10);
	});

	it('carries the build records the gate reads and the edge never serves', () => {
		const root = checkout(SEAM_85);
		expect(expandPlan(root, payloadPlan(root))).toContain('assets/drupal/twig-bake.json');
	});

	it('refuses to call a served file a build record', () => {
		const root = checkout(SEAM_85, ['/*', '!/drupal/twig-bake.json'].join('\n'));
		expect(() => payloadPlan(root)).toThrow(/disagree|build record/);
	});

	it('names the producer of anything missing rather than shipping short', () => {
		const root = checkout(SEAM_85);
		rmSync(join(root, 'assets/drupal-pf/core.pf.bin'));
		expect(() => expandPlan(root, payloadPlan(root))).toThrow(/bun run assets:pack/);
	});

	it('names the producer of a missing interpreter too', () => {
		const root = checkout(SEAM_85);
		rmSync(join(root, '.interp/php8.5.wasm.zst'));
		expect(() => expandPlan(root, payloadPlan(root))).toThrow(/bun run build:wasm/);
	});
});

describe('the manifest is what pins the bytes', () => {
	it('records a sha256 and a size per file, and the totals add up', () => {
		const root = checkout(SEAM_85);
		const plan = payloadPlan(root);
		const manifest = buildManifest(
			root,
			'1.2.3',
			'abc1234',
			expandPlan(root, plan),
			plan.interpreter
		);

		expect(manifest.release).toBe('1.2.3');
		expect(manifest.totals.files).toBe(manifest.files.length);
		expect(manifest.totals.bytes).toBe(manifest.files.reduce((n, f) => n + f.bytes, 0));
		for (const file of manifest.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
		// driver.json is '{"a":"b"}'
		expect(manifest.files.find((f) => f.path === 'assets/driver.json')!.bytes).toBe(9);
	});

	it('carries no timestamp, so the same inputs describe the same payload', () => {
		const root = checkout(SEAM_85);
		const plan = payloadPlan(root);
		const once = buildManifest(root, '1', 'a', expandPlan(root, plan), plan.interpreter);
		const twice = buildManifest(root, '1', 'a', expandPlan(root, plan), plan.interpreter);
		expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
	});

	it('names the tarball by convention, so hydrate needs no index', () => {
		expect(payloadName('1.0.0')).toBe('drupflare-worker-1.0.0.tar.gz');
	});
});

/**
 * A real bcrypt string, 60 characters. Shortening it is what the earlier fixture did, and it passed
 * against a pattern that only checked the first 8 characters of the digest.
 */
const BCRYPT = '$2y$12$sPGjxCwWWyT.hC9s.A5gHOiLAdvgEc57cNw5i7M5auuPlyHWklg.S';

/** Writes a per-file pack the way `pack-perfile.ts` does: raw-deflated members, an offset index. */
function packFixture(root: string, members: Record<string, string>): void {
	const dir = join(root, 'assets/drupal-pf');
	mkdirSync(dir, { recursive: true });
	const index: Record<string, unknown> = {};
	const parts: Uint8Array[] = [];
	let offset = 0;
	let i = 0;
	for (const [path, body] of Object.entries(members)) {
		const raw = new TextEncoder().encode(body);
		const deflated = new Uint8Array(deflateRawSync(raw, { level: 9 }));
		const verbatim = deflated.length >= raw.length;
		const payload = verbatim ? raw : deflated;
		index[String(i++)] = {
			p: path,
			o: offset,
			c: payload.length,
			l: raw.length,
			...(verbatim ? { s: 1 } : {})
		};
		parts.push(payload);
		offset += payload.length;
	}
	const blob = new Uint8Array(offset);
	let at = 0;
	for (const part of parts) {
		blob.set(part, at);
		at += part.length;
	}
	writeFileSync(join(dir, 'core.pf.json'), JSON.stringify(index));
	writeFileSync(join(dir, 'core.pf.bin'), blob);
}

describe('a payload must not publish a credential every deployed site would share', () => {
	it('finds a bcrypt hash in a shipped chunk', () => {
		const root = fixture();
		mkdirSync(join(root, 'assets/drupal-sql'), { recursive: true });
		writeFileSync(
			join(root, 'assets/drupal-sql/0064.json'),
			`[["INSERT INTO users_field_data",["${BCRYPT}"]]]`
		);
		expect(scanSeededCredentials(root, ['assets/drupal-sql/0064.json'])).toEqual([
			{ path: 'assets/drupal-sql/0064.json', kind: 'bcrypt password hash' }
		]);
	});

	it('finds the serialized system.private_key state row', () => {
		const root = fixture();
		mkdirSync(join(root, 'assets'), { recursive: true });
		writeFileSync(
			join(root, 'assets/x.json'),
			'["state","system.private_key","s:74:\\"kOcfN8OweNsxq6Zuam1tAGhbZSC7WWO46r39mKRCeFvt\\";"]'
		);
		expect(scanSeededCredentials(root, ['assets/x.json'])[0]!.kind).toBe('system.private_key');
	});

	it('READS INTO a per-file pack, and names the member that carried the secret', () => {
		// the blind spot this replaced: the scanner skipped anything that was not `.json`, so it
		// never opened core.pf.bin -- where settings.php and its hash_salt actually live -- and
		// reported the payload clean while it published a real salt. The old spec asserted that
		// skip as if it were the desired behaviour
		const root = fixture();
		packFixture(root, {
			'sites/default/settings.php': `<?php\n$settings['hash_salt'] = 'sekritsekritsekrit';\n`,
			'core/lib/Drupal/Core/Foo.php': '<?php\n// nothing here\n'
		});
		expect(scanSeededCredentials(root, ['assets/drupal-pf/core.pf.bin'])).toEqual([
			{ path: 'assets/drupal-pf/core.pf.bin:sites/default/settings.php', kind: 'hash salt' }
		]);
	});

	it('passes a pack whose salt has been scrubbed to an empty literal', () => {
		const root = fixture();
		packFixture(root, {
			'sites/default/settings.php': `<?php\n$settings['hash_salt'] = '';\n`
		});
		expect(scanSeededCredentials(root, ['assets/drupal-pf/core.pf.bin'])).toEqual([]);
	});

	it('does not fire on the IDENTIFIERS core itself contains', () => {
		// measured over the real 11,444-member pack: bare `hash_salt` hits 11 files and bare
		// `system.private_key` hits PrivateKey.php. A scanner that fires on every release is the
		// same as no scanner, so every pattern matches a VALUE
		const root = fixture();
		packFixture(root, {
			'core/lib/Drupal/Core/PrivateKey.php':
				"<?php\nreturn $this->state->get('system.private_key');\n",
			'sites/default/default.settings.php':
				"<?php\n# $settings['hash_salt'] = file_get_contents('/home/example/salt.txt');\n"
		});
		expect(scanSeededCredentials(root, ['assets/drupal-pf/core.pf.bin'])).toEqual([]);
	});

	it('is quiet about a clean chunk, and never scans the pf INDEX for content', () => {
		const root = fixture();
		mkdirSync(join(root, 'assets/drupal-pf'), { recursive: true });
		writeFileSync(join(root, 'assets/clean.json'), '[["INSERT INTO node",["hello"]]]');
		// the index carries paths and offsets; a path that merely looks like a secret is not one
		writeFileSync(join(root, 'assets/drupal-pf/core.pf.json'), `{"0":{"p":"${BCRYPT}"}}`);
		expect(
			scanSeededCredentials(root, ['assets/clean.json', 'assets/drupal-pf/core.pf.json'])
		).toEqual([]);
	});
});

describe('wrangler prints KiB and the ceiling is bytes, which is a 1,024x mistake waiting', () => {
	it('converts the figure this project actually measured', () => {
		// the real dry-run line for the shipping 8.5 bundle
		expect(parseWranglerGzipBytes('Total Upload: 3707.69 KiB / gzip: 2808.67 KiB')).toBe(
			2_876_078
		);
	});

	it('handles MiB, which a bigger bundle would print', () => {
		expect(parseWranglerGzipBytes('gzip: 2.5 MiB')).toBe(2_621_440);
	});

	it('returns undefined rather than guessing when the line is absent', () => {
		expect(parseWranglerGzipBytes('--dry-run: exiting now.')).toBeUndefined();
	});

	it('scores against the 3 MiB free ceiling', () => {
		expect(ceilingVerdict(2_876_078)).toEqual({ fits: true, headroom: 269_650 });
		expect(ceilingVerdict(FREE_CEILING)).toEqual({ fits: true, headroom: 0 });
		expect(ceilingVerdict(FREE_CEILING + 1)).toEqual({ fits: false, headroom: -1 });
	});
});

describe('hydrating refuses anything that could write outside the payload roots', () => {
	it('rejects traversal, absolute paths and unrelated directories', () => {
		expect(isSafePayloadPath('assets/driver.json')).toBe(true);
		expect(isSafePayloadPath('.interp/zstddec.wasm')).toBe(true);
		expect(isSafePayloadPath('vendor/static-o2/php8.3-worker.mjs')).toBe(false);
		expect(isSafePayloadPath('../vendor/x')).toBe(false);
		expect(isSafePayloadPath('assets/../../vendor/x')).toBe(false);
		expect(isSafePayloadPath('/etc/passwd')).toBe(false);
		expect(isSafePayloadPath('src/site.ts')).toBe(false);
	});

	it('rejects a manifest naming a path outside the roots', () => {
		const root = fixture();
		writeFileSync(
			join(root, 'manifest.json'),
			JSON.stringify({ version: 1, files: [{ path: 'vendor/x', bytes: 1, sha256: 'a' }] })
		);
		expect(() => readManifest(join(root, 'manifest.json'))).toThrow(/outside/);
	});

	it('rejects a manifest from a future payload format', () => {
		const root = fixture();
		writeFileSync(join(root, 'manifest.json'), JSON.stringify({ version: 2, files: [] }));
		expect(() => readManifest(join(root, 'manifest.json'))).toThrow(/version 2/);
	});
});

describe('verifying an extraction against its manifest', () => {
	it('passes on an intact payload', () => {
		const root = checkout(SEAM_85);
		const plan = payloadPlan(root);
		const manifest = buildManifest(root, '1', 'a', expandPlan(root, plan), plan.interpreter);
		expect(verifyExtracted(root, manifest)).toEqual([]);
	});

	it('reports a missing file, a wrong size and a wrong digest separately', () => {
		const root = checkout(SEAM_85);
		const plan = payloadPlan(root);
		const manifest = buildManifest(root, '1', 'a', expandPlan(root, plan), plan.interpreter);

		rmSync(join(root, 'assets/prefill.json'));
		writeFileSync(join(root, 'assets/driver.json'), '{"a":"b"} plus more');
		const tampered = manifest.files.map((f) =>
			f.path === '.interp/zstddec.wasm' ? { ...f, sha256: 'f'.repeat(64) } : f
		);

		const problems = verifyExtracted(root, { ...manifest, files: tampered });
		expect(problems).toHaveLength(3);
		expect(problems.join('\n')).toMatch(/prefill\.json is missing/);
		expect(problems.join('\n')).toMatch(/driver\.json is 19 bytes/);
		expect(problems.join('\n')).toMatch(/zstddec\.wasm sha256/);
	});
});
