import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	ANACHRON_MOUNT,
	batchBlobs,
	buildBundle,
	deliverAnachron,
	RETURN_TYPES_OFF,
	RIG_SETTINGS_SOURCE,
	sha256,
	stageModule
} from '../../scripts/e2e/anachron-deliver';

/**
 * What the site receives decides whether anachron is loaded before anything that needs it, so the
 * bundle's paths, its autoload order and the three calls that carry it are pinned here.
 */

const checkout = (files: Record<string, string>, version = '0.1.0') => {
	const dir = mkdtempSync(join(tmpdir(), 'cfw-anachron-'));
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
	for (const [path, source] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), source);
	}
	return dir;
};

const FULL = {
	'src/Php/polyfills.php': '<?php // p',
	'src/Drupal/constants.php': '<?php // c',
	'src/Drupal/functions.php': '<?php // f',
	'src/Drupal/bootstrap.php': '<?php // b',
	'src/Drupal/Access/Check.php': '<?php // a',
	'src/Drupal/Access/check.services.yml': 'services: {}',
	'src/templates/page.html.twig': '{{ x }}',
	'src/Drupal/data.json': '{}',
	'src/Drupal/notes.md': 'skipped',
	'src/Drupal/image.png': 'skipped',
	'README.md': 'outside src',
	'tests/Unit/Skipped.php': '<?php // not under src'
};

describe('the anachron bundle', () => {
	it('mounts every php, yml, twig and json file under src, and nothing else', () => {
		const { files } = buildBundle(checkout(FULL));
		expect(files.map((f) => f.path)).toEqual([
			`${ANACHRON_MOUNT}/rig-settings.php`,
			`${ANACHRON_MOUNT}/src/Drupal/Access/Check.php`,
			`${ANACHRON_MOUNT}/src/Drupal/Access/check.services.yml`,
			`${ANACHRON_MOUNT}/src/Drupal/bootstrap.php`,
			`${ANACHRON_MOUNT}/src/Drupal/constants.php`,
			`${ANACHRON_MOUNT}/src/Drupal/data.json`,
			`${ANACHRON_MOUNT}/src/Drupal/functions.php`,
			`${ANACHRON_MOUNT}/src/Php/polyfills.php`,
			`${ANACHRON_MOUNT}/src/templates/page.html.twig`
		]);
	});

	it('carries the rig settings file with exactly the one flag', () => {
		const rig = buildBundle(checkout(FULL)).files.find((f) =>
			f.path.endsWith('rig-settings.php')
		);
		expect(rig?.source).toBe(RIG_SETTINGS_SOURCE);
		expect(rig?.source).toBe(
			"<?php\n$GLOBALS['conf']['anachron_ignore_core_requirement'] = true;\n$GLOBALS['conf']['anachron_legacy_field_access'] = true;\n"
		);
		expect(rig?.bytes).toBe(Buffer.byteLength(RIG_SETTINGS_SOURCE));
	});

	it('requires the rig settings first, then the library files in dependency order', () => {
		const { declaration } = buildBundle(checkout(FULL));
		expect(declaration).toMatchObject({
			name: 'drupflare/anachron',
			version: '0.1.0',
			mount: ANACHRON_MOUNT,
			autoload: {
				'psr-4': { 'Drupflare\\Anachron\\': 'src/' },
				files: [
					'rig-settings.php',
					'src/Php/polyfills.php',
					'src/Drupal/constants.php',
					'src/Drupal/functions.php',
					'src/Drupal/bootstrap.php'
				]
			}
		});
	});

	it('drops a listed file the checkout lacks, and refuses a checkout with no bootstrap', () => {
		const without: Record<string, string> = { ...FULL };
		delete without['src/Php/polyfills.php'];
		expect(buildBundle(checkout(without)).declaration.autoload.files).toEqual([
			'rig-settings.php',
			'src/Drupal/constants.php',
			'src/Drupal/functions.php',
			'src/Drupal/bootstrap.php'
		]);
		delete without['src/Drupal/bootstrap.php'];
		expect(() => buildBundle(checkout(without))).toThrow(/bootstrap\.php is missing/);
	});

	it('sorts by path so the same checkout is the same revision', () => {
		const reversed = Object.fromEntries(Object.entries(FULL).reverse());
		const a = buildBundle(checkout(FULL)).files.map((f) => f.path);
		const b = buildBundle(checkout(reversed)).files.map((f) => f.path);
		expect(b).toEqual(a);
		expect(a).toEqual([...a].sort());
	});

	it('takes the version from package.json and refuses a checkout without one', () => {
		expect(buildBundle(checkout(FULL, '2.3.4')).declaration.version).toMatch(/^2\.3\.4(\+|$)/);
		const dir = checkout(FULL);
		writeFileSync(join(dir, 'package.json'), '{}');
		expect(() => buildBundle(dir)).toThrow(/has no version/);
	});

	it('counts bytes as UTF-8, which is what the plan declares', () => {
		const { files } = buildBundle(checkout({ ...FULL, 'src/Drupal/Wide.php': '<?php // é€' }));
		const wide = files.find((f) => f.path.endsWith('Wide.php'));
		expect(wide?.bytes).toBe(Buffer.byteLength('<?php // é€', 'utf8'));
		expect(wide!.bytes).toBeGreaterThan(wide!.source.length);
	});
});

describe('hashing and batching', () => {
	it('hashes the way the site does', () => {
		expect(sha256('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});

	it('splits blobs under the budget, measured on the encoded entry', () => {
		const blob = (n: number) => ({ hash: String(n), source: '"'.repeat(100) });
		const encoded = Buffer.byteLength(JSON.stringify(blob(1))) + 1;
		const batches = batchBlobs([1, 2, 3, 4, 5].map(blob), encoded * 2);
		expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
		expect(batchBlobs([], 10)).toEqual([]);
	});

	it('gives a blob over the whole budget a request of its own', () => {
		const big = { hash: 'big', source: 'x'.repeat(500) };
		const small = { hash: 'small', source: 'y' };
		expect(batchBlobs([small, big, small], 100).map((b) => b.length)).toEqual([1, 1, 1]);
	});
});

describe('delivering to a site', () => {
	type Call = { action: string; query: URLSearchParams; headers: Headers; body: any };

	const site = (replies: Record<string, { status: number; body: unknown }>) => {
		const calls: Call[] = [];
		const fetcher = (async (input: URL | string, init?: RequestInit) => {
			const url = new URL(String(input));
			const action = url.searchParams.get('action') ?? '';
			calls.push({
				action,
				query: url.searchParams,
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body))
			});
			const reply = replies[action] ?? { status: 200, body: { ok: true } };
			return new Response(
				typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body),
				{ status: reply.status }
			);
		}) as unknown as typeof fetch;
		return { calls, fetcher };
	};

	it('plans, sends only the wanted blobs, then commits the files with the declaration', async () => {
		const dir = checkout(FULL);
		const bundle = buildBundle(dir);
		const wanted = sha256(bundle.files[1]!.source);
		const { calls, fetcher } = site({
			plan: { status: 200, body: { ok: true, want: [wanted] } },
			commit: { status: 200, body: { ok: true, rev: 'abc123' } }
		});
		const got = await deliverAnachron('http://localhost:8840', 'pw-diagnostics', dir, fetcher);
		expect(got).toEqual({ ok: true, rev: 'abc123' });
		expect(calls.map((c) => c.action)).toEqual(['plan', 'blobs', 'commit']);
		for (const c of calls) {
			expect(c.query.get('package')).toBe('anachron');
			expect(c.headers.get('authorization')).toBe('Bearer pw-diagnostics');
		}
		expect(calls[0]!.body.files).toHaveLength(bundle.files.length);
		expect(calls[0]!.body.files[0]).toEqual({
			path: bundle.files[0]!.path,
			hash: sha256(bundle.files[0]!.source),
			bytes: bundle.files[0]!.bytes
		});
		expect(calls[1]!.body.blobs).toEqual([{ hash: wanted, source: bundle.files[1]!.source }]);
		expect(calls[2]!.body.files.map((f: { path: string }) => f.path)).toEqual(
			bundle.files.map((f) => f.path)
		);
		expect(calls[2]!.body.autoload).toEqual([bundle.declaration]);
		expect(calls[2]!.query.get('label')).toBe('anachron 0.1.0');
	});

	it('sends no blob request when the site already holds every file', async () => {
		const { calls, fetcher } = site({
			plan: { status: 200, body: { ok: true, want: [] } },
			commit: { status: 200, body: { ok: true, rev: 'r' } }
		});
		await deliverAnachron('http://localhost:8840', 't', checkout(FULL), fetcher);
		expect(calls.map((c) => c.action)).toEqual(['plan', 'commit']);
	});

	it('reports a commit the kernel refused, without claiming a revision', async () => {
		const { fetcher } = site({
			plan: { status: 200, body: { ok: true, want: [] } },
			commit: { status: 409, body: { ok: false, error: 'rolled back: boom' } }
		});
		const got = await deliverAnachron('http://localhost:8840', 't', checkout(FULL), fetcher);
		expect(got.ok).toBe(false);
		expect(got.error).toBe('commit answered 409: rolled back: boom');
		expect(got.rev).toBeUndefined();
	});

	it('reports a plan the site answered with text, and a checkout it cannot read', async () => {
		const { fetcher } = site({ plan: { status: 500, body: 'Internal Server Error' } });
		const got = await deliverAnachron('http://localhost:8840', 't', checkout(FULL), fetcher);
		expect(got).toEqual({ ok: false, error: 'plan answered 500: Internal Server Error' });
		const missing = await deliverAnachron(
			'http://localhost:8840',
			't',
			'/nonexistent',
			fetcher
		);
		expect(missing.ok).toBe(false);
		expect(missing.error).toMatch(/bootstrap\.php is missing/);
	});
});

describe('staging a module for upload', () => {
	const REWRITER = `<?php
$from = $argv[1];
$to = $argv[2];
mkdir($to);
$code = file_get_contents($from . '/a.php');
file_put_contents($to . '/a.php', str_replace('count()', 'count(): int', $code));
echo json_encode(['changed' => ['a.php'], 'refusals' => [['file' => 'b.php', 'class' => 'B', 'method' => 'count', 'line' => 3, 'reason' => 'x']]]);
`;
	const SYNTAX = `<?php
$to = $argv[2];
mkdir($to, 0777, true);
$code = file_get_contents($argv[1] . '/a.php');
file_put_contents($to . '/a.php', str_replace('$s{0}', '$s[0]', $code));
echo json_encode(['changed' => str_contains($code, '$s{0}') ? ['a.php'] : []]);
`;
	const module = (source = '<?php function count() {}') => {
		const dir = join(mkdtempSync(join(tmpdir(), 'cfw-mod-')), 'strawberryfield');
		mkdirSync(dir);
		writeFileSync(join(dir, 'a.php'), source);
		return dir;
	};

	it('uploads a rewritten copy named like the module and leaves the source alone', () => {
		const anachron = checkout({
			'bin/rewrite-return-types.php': REWRITER,
			'bin/rewrite-syntax.php': SYNTAX
		});
		const source = module();
		const staged = stageModule(anachron, source, {});
		expect(staged.dir).not.toBe(source);
		expect(basename(staged.dir)).toBe('strawberryfield');
		expect(readFileSync(join(staged.dir, 'a.php'), 'utf8')).toBe(
			'<?php function count(): int {}'
		);
		expect(readFileSync(join(source, 'a.php'), 'utf8')).toBe('<?php function count() {}');
		expect(staged.changed).toEqual(['a.php']);
		expect(staged.syntax).toEqual([]);
		expect(staged.refusals).toEqual([
			{ file: 'b.php', class: 'B', method: 'count', line: 3, reason: 'x' }
		]);
		staged.cleanup();
		expect(existsSync(staged.dir)).toBe(false);
	});

	it('returns the module itself when the rewrite is switched off', () => {
		const source = module();
		const staged = stageModule('/nonexistent', source, {
			ANACHRON_RETURN_TYPES: RETURN_TYPES_OFF
		});
		expect(staged).toMatchObject({ dir: source, changed: [], syntax: [], refusals: [] });
	});

	it('refuses a checkout with no rewriter, a failing rewriter and a silent one', () => {
		expect(() => stageModule('/nonexistent', module(), {})).toThrow(
			/rewrite-return-types\.php is missing/
		);
		const failing = checkout({
			'bin/rewrite-return-types.php': '<?php fwrite(STDERR, "bad"); exit(2);'
		});
		expect(() => stageModule(failing, module(), {})).toThrow(/exited 2: bad/);
		const silent = checkout({ 'bin/rewrite-return-types.php': '<?php echo "not json";' });
		const noSyntax = checkout({ 'bin/rewrite-return-types.php': REWRITER });
		expect(() => stageModule(noSyntax, module(), {})).toThrow(/rewrite-syntax\.php is missing/);
		expect(() => stageModule(silent, module(), {})).toThrow(/printed no report: not json/);
	});

	it('uploads the syntax rewrite of a module that uses a curly string offset', () => {
		const anachron = checkout({
			'bin/rewrite-return-types.php': REWRITER,
			'bin/rewrite-syntax.php': SYNTAX
		});
		const staged = stageModule(anachron, module('<?php count(); $s{0};'), {});
		expect(readFileSync(join(staged.dir, 'a.php'), 'utf8')).toBe('<?php count(): int; $s[0];');
		expect(staged.syntax).toEqual(['a.php']);
		staged.cleanup();
	});

	it('refuses a module whose request time sits where PHP evaluates it early', () => {
		const refusing = `<?php
mkdir($argv[2], 0777, true);
echo json_encode(['changed' => [], 'refused' => [['file' => 'a.php', 'line' => 7, 'reason' => 'a parameter default']]]);
`;
		const anachron = checkout({
			'bin/rewrite-return-types.php': REWRITER,
			'bin/rewrite-syntax.php': refusing
		});
		expect(() => stageModule(anachron, module(), {})).toThrow(
			/a\.php:7 \(a parameter default\)/
		);
	});
});
