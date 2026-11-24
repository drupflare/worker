import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
	controlNote,
	coreModuleNames,
	D7_INSTALL,
	d7Deliverable,
	d7Extensions,
	d7Notes,
	d7NoteText,
	d7Plan,
	dependentsOfShadowed,
	legacyRiskNote,
	orderByDependencies,
	rowAfterEnables,
	type Converted
} from '../../scripts/e2e/corpus-d7';
import {
	refusalFor,
	withAnachronOverride,
	type AnachronOverride,
	type Corpus
} from '../../scripts/e2e/corpus-lane';

const temp = () => mkdtempSync(join(tmpdir(), 'corpus-d7-'));

const converted = (name: string, type = 'module', dependencies: string[] = []): Converted => ({
	name,
	path: name,
	type,
	dependencies,
	dropped: []
});

describe('the build plan of a Drupal 7 checkout', () => {
	it('names the profile by the .profile that has an .info of the same name', () => {
		const dir = temp();
		for (const f of ['x.profile', 'x.info', 'drupal-org-core.make', 'drupal-org.make'])
			writeFileSync(join(dir, f), '');
		expect(d7Plan(dir)).toEqual({
			profile: 'x',
			coreMake: 'drupal-org-core.make',
			contribMake: 'drupal-org.make'
		});
	});

	it('refuses a checkout with no profile or without the make pair', () => {
		const bare = temp();
		writeFileSync(join(bare, 'a.info'), '');
		expect(() => d7Plan(bare)).toThrow(/no <name>.profile/);
		const half = temp();
		for (const f of ['a.profile', 'a.info', 'drupal-org.make'])
			writeFileSync(join(half, f), '');
		expect(() => d7Plan(half)).toThrow(/no drupal-org-core.make/);
	});
});

describe('what the install log says was left out', () => {
	const log = [
		'DOWNLOAD_ERROR: Unable to download tinymce from    [warning]',
		'http://example.test/tinymce.zip. -- build',
		'forced',
		'markitup patched with 1715642-adding.patch.        [ok]',
		'Unable to patch views with views-php7.patch.       [error]'
	].join('\n');

	it('lists the downloads that failed and the patches that did not apply', () => {
		expect(d7Notes(log)).toEqual({
			downloads: ['tinymce'],
			patches: ['views: views-php7.patch']
		});
	});

	it('reads a clean log as nothing left out and writes no sentence', () => {
		const notes = d7Notes('Beginning to build /clone/drupal-org.make. [ok]');
		expect(notes).toEqual({ downloads: [], patches: [] });
		expect(d7NoteText(notes)).toBeUndefined();
	});

	it('says how many were left out and names them', () => {
		expect(d7NoteText(d7Notes(log))).toBe(
			'not stock: 1 make downloads failed and were skipped (tinymce); 1 make patches did not apply (views: views-php7.patch)'
		);
	});
});

describe('the modules a Drupal 7 fixture delivers', () => {
	const extensions = {
		core: '7.82',
		modules: ['node', 'ctools', 'views', 'media', 'x', 'panopoly'],
		themes: []
	};
	const all = [
		converted('ctools'),
		converted('views'),
		converted('media'),
		converted('x'),
		converted('panopoly', 'profile')
	];

	it('leaves core modules to Drupal 11 and does not deliver the profile', () => {
		const got = d7Deliverable(extensions, all, 'panopoly');
		expect(got.core).toEqual(['node']);
		expect(got.modules).toEqual(['ctools', 'views', 'media', 'x']);
	});

	it('does not deliver a module that shares its name with a Drupal 11 core module', () => {
		const got = d7Deliverable(extensions, all, 'panopoly', new Set(['views', 'media']));
		expect(got.modules).toEqual(['ctools', 'x']);
		expect(got.shadowed).toEqual(['views', 'media']);
	});

	it('lists the delivered modules that need a shadowed one, through other delivered modules', () => {
		const deps = { a: ['views'], b: ['a'], c: ['ctools'], views: [] };
		expect(dependentsOfShadowed(['ctools', 'a', 'b', 'c'], ['views'], deps)).toEqual([
			'a',
			'b'
		]);
		expect(dependentsOfShadowed(['c'], [], deps)).toEqual([]);
	});

	it('reports an enabled extension that is not a module', () => {
		const got = d7Deliverable(
			{ ...extensions, modules: ['t'] },
			[converted('t', 'theme')],
			'panopoly'
		);
		expect(got.missing).toEqual(['t']);
	});

	it('orders dependencies first, ignores ones outside the list and survives a cycle', () => {
		const deps = { a: ['b', 'outside'], b: ['c'], c: [], d: ['e'], e: ['d'] };
		expect(orderByDependencies(['a', 'b', 'c'], deps)).toEqual(['c', 'b', 'a']);
		expect(orderByDependencies(['d', 'e'], deps)).toEqual(['e', 'd']);
	});
});

describe('the records of a native install', () => {
	it('reads the extension list the install left, and undefined for a missing or broken one', () => {
		const dir = temp();
		expect(d7Extensions(dir)).toBeUndefined();
		writeFileSync(join(dir, 'extensions.json'), 'not json');
		expect(d7Extensions(dir)).toBeUndefined();
		writeFileSync(
			join(dir, 'extensions.json'),
			JSON.stringify({ core: '7.82', modules: ['a'] })
		);
		expect(d7Extensions(dir)?.modules).toEqual(['a']);
	});

	it('writes the control as one sentence and says when it was not read', () => {
		expect(
			controlNote({
				front: { status: 200, bytes: 10, title: 'a' },
				admin: { status: 403, bytes: 5, title: 'b' }
			})
		).toBe('native control (Drupal 7 installer, MySQL): front 200, admin 403');
		expect(controlNote(undefined)).toMatch(/was not read/);
	});

	it('lists the core modules a tree ships', () => {
		const dir = temp();
		mkdirSync(join(dir, 'core', 'modules', 'views'), { recursive: true });
		mkdirSync(join(dir, 'core', 'modules', 'node'), { recursive: true });
		expect([...coreModuleNames(dir)].sort()).toEqual(['node', 'views']);
	});
});

describe('the corpus entries that install as Drupal 7', () => {
	const read = (f: string) => readFileSync(resolve(process.cwd(), f), 'utf8');
	const corpus = parse(read('config/corpus.yml')) as Corpus;
	const overrides = parse(read('config/corpus-anachron.yml')) as Record<string, AnachronOverride>;

	it('are Drupal 7 entries, refused without anachron and driven with it', () => {
		const ids = Object.entries(overrides)
			.filter(([, o]) => o.install === D7_INSTALL)
			.map(([id]) => id);
		expect(ids).toContain('panopoly');
		for (const id of ids) {
			const base = corpus.repos.find((r) => r.id === id)!;
			expect(base.core, id).toBe('7.x');
			expect(refusalFor(base), id).toMatch(/^needs upgrade:/);
			const merged = withAnachronOverride(base, overrides);
			expect(merged.install, id).toBe(D7_INSTALL);
			expect(refusalFor(merged, { anachron: true }), id).toBeNull();
		}
	});

	describe('legacyRiskNote', () => {
		it('says what was counted and that a count is not a finding', () => {
			expect(legacyRiskNote({ files: 3, counts: { eval: 2, extract: 1 } })).toBe(
				'legacy risk scan of 3 files, for review and not findings: 2 eval, 1 extract'
			);
			expect(legacyRiskNote({ files: 3, counts: {} })).toContain('nothing counted');
		});
	});

	describe('rowAfterEnables', () => {
		it('scores an enable-only row by the render that follows', () => {
			expect(rowAfterEnables(true, 200, 'ok', 'x')).toEqual({ state: 'inline', note: 'ok' });
			expect(rowAfterEnables(false, 500, 'ok', 'the site')).toEqual({
				state: 'unsupported',
				note: 'the site answered 500 afterwards'
			});
		});
	});
});
