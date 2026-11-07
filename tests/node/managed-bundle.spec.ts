import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	buildBundle,
	moduleContentType,
	readModules,
	readShippedAssets,
	uploadMetadata
} from '../../scripts/build-managed-bundle';
import { bundleTarballName, managedKeyBase } from '../../scripts/payload-cdn';
import { plan } from '../../scripts/publish-bundle';

const enc = (text: string) => new TextEncoder().encode(text);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const COMMIT = 'a'.repeat(40);

const input = () => ({
	releaseId: 'v9.9.9',
	workerCommit: COMMIT,
	mainModule: 'site.js',
	modules: new Map([
		['site.js', enc('export default {}')],
		['abc-php.wasm', enc('wasm')],
		['def-composer.lock', enc('{}')]
	]),
	metadata: enc('{"main_module":"site.js"}'),
	assets: new Map([
		['/robots.txt', enc('User-agent: *')],
		['/core/a.css', enc('a{}')],
		['/core/copy.css', enc('a{}')]
	])
});

function writeBundle(root: string) {
	const built = buildBundle(input());
	for (const [key, bytes] of built.files) {
		const path = join(root, key);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, bytes);
	}
	return built;
}

describe('the managed bundle layout the dashboard reads', () => {
	it('keys modules by name, assets by the first 32 hex of their sha-256, and lists both in order', () => {
		const { manifest, files } = buildBundle(input());
		expect(manifest.counts).toEqual({ modules: 3, assets: 3 });
		expect(manifest.modules.map((m) => m.name)).toEqual([
			'abc-php.wasm',
			'def-composer.lock',
			'site.js'
		]);
		expect(manifest.assets.map((a) => a.path)).toEqual([
			'/core/a.css',
			'/core/copy.css',
			'/robots.txt'
		]);
		for (const a of manifest.assets) expect(a.hash).toMatch(/^[0-9a-f]{32}$/);
		expect(files.has('releases/v9.9.9/manifest.json')).toBe(true);
		expect(files.has('releases/v9.9.9/metadata.json')).toBe(true);
		expect(files.has('releases/v9.9.9/modules/site.js')).toBe(true);
		const hash = manifest.assets[0]!.hash;
		expect(files.has(`releases/v9.9.9/assets/${hash}`)).toBe(true);
	});

	it('stores two paths with the same bytes as one object and still lists both paths', () => {
		const { manifest, files } = buildBundle(input());
		const [a, copy] = manifest.assets;
		expect(a!.hash).toBe(copy!.hash);
		const objects = [...files.keys()].filter((k) => k.includes('/assets/'));
		expect(objects).toHaveLength(2);
	});

	it('records the digest and size of each module and of the metadata', () => {
		const { manifest } = buildBundle(input());
		const site = manifest.modules.find((m) => m.name === 'site.js')!;
		expect(site.sha256).toBe(sha(enc('export default {}')));
		expect(site.size).toBe(enc('export default {}').byteLength);
		expect(site.contentType).toBe('application/javascript+module');
		expect(manifest.metadata).toEqual({
			sha256: sha(enc('{"main_module":"site.js"}')),
			size: enc('{"main_module":"site.js"}').byteLength
		});
	});

	it('refuses a missing main module, an unsafe release id and a short commit', () => {
		expect(() => buildBundle({ ...input(), mainModule: 'nope.js' })).toThrow(/not among/);
		expect(() => buildBundle({ ...input(), releaseId: '../x' })).toThrow(/release id/);
		expect(() => buildBundle({ ...input(), workerCommit: '61431ae4c9' })).toThrow(/40/);
	});

	it('maps file names to the content types the dashboard accepts', () => {
		expect(moduleContentType('site.js')).toBe('application/javascript+module');
		expect(moduleContentType('x-php8.5.tuned.wasm')).toBe('application/wasm');
		expect(moduleContentType('x-composer.lock')).toBe('text/plain');
		expect(moduleContentType('data.bin')).toBe('application/octet-stream');
		expect(moduleContentType('noext')).toBe('application/octet-stream');
	});
});

describe('reading what wrangler and the asset ignore file produce', () => {
	it('skips wrangler README and source maps', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bundle-mods-'));
		for (const name of ['site.js', 'site.js.map', 'README.md', 'x-a.wasm']) {
			writeFileSync(join(dir, name), 'x');
		}
		expect([...readModules(dir).keys()]).toEqual(['site.js', 'x-a.wasm']);
	});

	it('ships what .assetsignore un-ignores and nothing else under assets/', () => {
		const root = mkdtempSync(join(tmpdir(), 'bundle-assets-'));
		const put = (rel: string) => {
			const path = join(root, 'assets', rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, rel);
		};
		mkdirSync(join(root, 'assets'), { recursive: true });
		writeFileSync(join(root, 'assets/.assetsignore'), '/*\n\n!/robots.txt\n!/core\n');
		for (const rel of ['robots.txt', 'core/x/y.js', 'private.sqlite', 'other/z.js']) put(rel);
		expect([...readShippedAssets(root).keys()].sort()).toEqual(['/core/x/y.js', '/robots.txt']);
	});

	it('writes the upload metadata from the config the bundle is built for', () => {
		const text = new TextDecoder().decode(
			uploadMetadata(process.cwd(), 'wrangler.managed.jsonc', 'site.js')
		);
		const config = readFileSync('wrangler.managed.jsonc', 'utf8');
		const date = /"compatibility_date":\s*"([^"]+)"/.exec(config)![1];
		expect(JSON.parse(text)).toEqual({
			main_module: 'site.js',
			compatibility_date: date,
			compatibility_flags: ['nodejs_compat']
		});
	});
});

describe('the publisher checks the files before it sends one', () => {
	it('lists the manifest after every other single put, and one bulk entry per distinct asset', () => {
		const root = mkdtempSync(join(tmpdir(), 'bundle-plan-'));
		writeBundle(root);
		const { singles, assets } = plan(root, 'v9.9.9');
		expect(singles.at(-1)!.key).toBe(`${managedKeyBase('v9.9.9')}/manifest.json`);
		expect(singles.map((s) => s.key)).toContain(`${managedKeyBase('v9.9.9')}/metadata.json`);
		expect(assets).toHaveLength(2);
		for (const a of assets)
			expect(a.key.startsWith(`${managedKeyBase('v9.9.9')}/assets/`)).toBe(true);
	});

	it('refuses an asset whose bytes changed after the manifest was written', () => {
		const root = mkdtempSync(join(tmpdir(), 'bundle-tamper-'));
		const built = writeBundle(root);
		const hash = built.manifest.assets[0]!.hash;
		writeFileSync(join(root, `releases/v9.9.9/assets/${hash}`), 'b{}');
		expect(() => plan(root, 'v9.9.9')).toThrow(/does not match/);
	});

	it('refuses a manifest for another release', () => {
		const root = mkdtempSync(join(tmpdir(), 'bundle-id-'));
		writeBundle(root);
		mkdirSync(join(root, 'releases/v1.0.0'), { recursive: true });
		writeFileSync(
			join(root, 'releases/v1.0.0/manifest.json'),
			readFileSync(join(root, 'releases/v9.9.9/manifest.json'))
		);
		expect(() => plan(root, 'v1.0.0')).toThrow(/not v1.0.0/);
	});
});

describe('where a release bundle lives on the CDN', () => {
	it('sits under the payload prefix, apart from the backup set, and takes a tag with or without its v', () => {
		expect(managedKeyBase('v1.0.5')).toBe('payloads/managed/releases/v1.0.5');
		expect(managedKeyBase('1.0.5')).toBe('payloads/managed/releases/v1.0.5');
		expect(bundleTarballName('1.0.5')).toBe('drupflare-managed-bundle-1.0.5.tar.gz');
	});
});
