import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	aggregate,
	findLibraryFiles,
	readLibraries,
	rebaseCssUrls
} from '../../scripts/pack-aggregates';

/**
 * Aggregating outside PHP, which is the only place the source files exist.
 *
 * `css.preprocess` ON is worth 3.2 ms a render and about 5,400 bytes off every stored page row, and
 * it is unshippable in Drupal here for a reason that is not about aggregation: 0 of 12 sampled CSS
 * files are readable in MEMFS, so Drupal's own aggregate route answers 69 bytes -- the licence
 * header alone -- and the page it produces has no CSS at all.
 *
 * DRIVEN OVER A FIXTURE rather than `drupal-src`, because a clean checkout does not have that tree
 * and a spec that skips on a developer machine is a spec nobody runs.
 */

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), 'cfw-agg-'));
	mkdirSync(join(root, 'css'), { recursive: true });
	mkdirSync(join(root, 'js'), { recursive: true });
	writeFileSync(join(root, 'css', 'a.css'), 'a{color:red}');
	writeFileSync(join(root, 'css', 'b.css'), 'b{color:blue}');
	writeFileSync(join(root, 'js', 'a.js'), 'window.a=1');
	writeFileSync(
		join(root, 'olivero.libraries.yml'),
		[
			'global-styling:',
			'  css:',
			'    base:',
			'      css/a.css: {}',
			'    theme:',
			'      css/b.css: { weight: 1 }',
			'  js:',
			'    js/a.js: {}',
			'',
			'# a comment line',
			'messages:',
			'  css:',
			'    component:',
			'      css/missing.css: {}',
			''
		].join('\n')
	);
	return root;
}

describe('reading the library definitions', () => {
	const root = fixture();

	it('finds the files', () => {
		expect(findLibraryFiles(root)).toHaveLength(1);
	});

	it('names a library the way Drupal does', () => {
		const { libraries } = readLibraries(root);
		expect(libraries.map((l) => l.id)).toEqual(['olivero/global-styling', 'olivero/messages']);
	});

	it('keeps declaration order, which is what makes the cascade correct', () => {
		const { libraries } = readLibraries(root);
		const styling = libraries.find((l) => l.id === 'olivero/global-styling');
		expect(styling?.css.map((p) => p.split('/').pop())).toEqual(['a.css', 'b.css']);
		expect(styling?.js.map((p) => p.split('/').pop())).toEqual(['a.js']);
	});

	it('skips the css group headers rather than treating them as files', () => {
		// `base:` and `theme:` are grouping keys with no extension; reading them as paths is how a
		// hand parser silently produces an aggregate of nothing
		const { libraries } = readLibraries(root);
		for (const library of libraries) {
			for (const path of [...library.css, ...library.js]) {
				expect(path, path).toMatch(/\.(css|js)$/);
			}
		}
	});

	it('reports nothing unparseable on a well-formed file', () => {
		expect(readLibraries(root).skipped).toBe(0);
	});
});

describe('the aggregate itself', () => {
	const root = fixture();
	const { libraries } = readLibraries(root);
	const styling = libraries.find((l) => l.id === 'olivero/global-styling');

	it('concatenates in order and names itself by content', () => {
		const out = aggregate(styling?.css ?? [], 'css');
		expect(out.body).toContain('a{color:red}');
		expect(out.body).toContain('b{color:blue}');
		expect(out.body.indexOf('a{color:red}')).toBeLessThan(out.body.indexOf('b{color:blue}'));
		expect(out.name).toMatch(/^[0-9a-f]{16}\.css$/);
	});

	it('mints a new name when a source changes, so the old URL stays addressable', () => {
		const first = aggregate(styling?.css ?? [], 'css').name;
		writeFileSync(join(root, 'css', 'b.css'), 'b{color:green}');
		expect(aggregate(styling?.css ?? [], 'css').name).not.toBe(first);
	});

	/**
	 * A LIBRARY WHOSE FILES ARE ALL MISSING PRODUCES NOTHING, AND SAYS SO.
	 *
	 * That is exactly the failure the last attempt shipped: the aggregate route answered 69 bytes
	 * and the page rendered with no CSS, which looked faster and was broken. Counting the misses is
	 * what makes it visible before it reaches a browser.
	 */
	it('counts a missing source instead of failing or hiding it', () => {
		const messages = libraries.find((l) => l.id === 'olivero/messages');
		const out = aggregate(messages?.css ?? [], 'css');
		expect(out.sources).toBe(1);
		expect(out.missing).toBe(1);
		expect(out.bytes).toBe(0);
	});

	it('separates a js aggregate with a semicolon, so one file cannot swallow the next', () => {
		const out = aggregate(styling?.js ?? [], 'js');
		expect(out.body).toContain('window.a=1');
		expect(out.body.trimEnd().endsWith(';')).toBe(true);
	});
});

/**
 * Relative `url()` targets, which move when the file does.
 *
 * An aggregate is served from `/agg/`, so `url(../../fonts/x.woff2)` written against
 * `/core/themes/olivero/css/base/fonts.css` resolved to `/fonts/x.woff2` and 404ed. It was 270
 * targets across 408 CSS aggregates on the built set: every icon, spinner, required-field marker
 * and webfont on a site running the lever.
 */
describe('rebasing a stylesheet url', () => {
	const at = '/core/themes/olivero/css/base/fonts.css';

	it('resolves a relative target against the source file, not the aggregate', () => {
		expect(rebaseCssUrls(`@font-face{src:url(../../fonts/m.woff2)}`, at)).toBe(
			`@font-face{src:url(/core/themes/olivero/fonts/m.woff2)}`
		);
		expect(rebaseCssUrls(`a{background:url("./icon.svg")}`, at)).toBe(
			`a{background:url("/core/themes/olivero/css/base/icon.svg")}`
		);
	});

	it('keeps the quote style it found, because css cares and a swap is a silent edit', () => {
		expect(rebaseCssUrls(`a{background:url('../i.png')}`, at)).toContain(
			`url('/core/themes/olivero/css/i.png')`
		);
	});

	it('leaves alone every target the move cannot break', () => {
		for (const target of [
			'/core/misc/x.png',
			'https://example.invalid/x.png',
			'//example.invalid/x.png',
			'data:image/svg+xml,%3csvg%3e%3c/svg%3e',
			'#clip'
		]) {
			const css = `a{background:url("${target}")}`;
			expect(rebaseCssUrls(css, at), target).toBe(css);
		}
	});

	it('carries a query and a fragment through, which is how a font format hint survives', () => {
		expect(rebaseCssUrls(`a{src:url(../f.svg?v=2#glyph)}`, at)).toContain(
			`url(/core/themes/olivero/css/f.svg?v=2#glyph)`
		);
	});

	/** THE CONTROL: without a docroot the concatenation is unchanged, which is the shipped defect */
	it('rebases only when the aggregate is told where the docroot is', () => {
		const root = fixture();
		mkdirSync(join(root, 'core', 'themes', 't', 'css'), { recursive: true });
		const file = join(root, 'core', 'themes', 't', 'css', 'c.css');
		writeFileSync(file, 'a{background:url(../images/c.png)}');

		expect(aggregate([file], 'css', root).body).toContain('url(/core/themes/t/images/c.png)');
		expect(aggregate([file], 'css').body).toContain('url(../images/c.png)');
	});
});
