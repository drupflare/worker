import { describe, expect, it } from 'vitest';
import { assetTags, substituteAggregates, type AggregateIndex } from '../../../src/ops/aggregates';

/**
 * The substitution, and the rule that makes a wrong one impossible rather than unlikely.
 *
 * A library is replaced only when EVERY one of its files appears contiguously and in declaration
 * order. The alternative was measured once: the last attempt at aggregation here produced a page
 * with no CSS that looked 3.2 ms faster, which is the failure this file exists to make unreachable.
 */

const INDEX: AggregateIndex = {
	libraries: {
		'olivero/global': { css: 'aaaa.css', js: 'bbbb.js' },
		'core/drupal': { css: 'cccc.css' }
	},
	files: {
		'olivero/global': {
			css: ['/themes/olivero/css/base.css', '/themes/olivero/css/theme.css'],
			js: ['/themes/olivero/js/nav.js']
		},
		'core/drupal': { css: ['/core/misc/drupal.css'] }
	}
};

const link = (p: string) => `<link rel="stylesheet" media="all" href="${p}?v=11.4.5">`;
const script = (p: string) => `<script src="${p}?v=11.4.5"></script>`;

describe('finding the tags', () => {
	it('reads a stylesheet href without its cache-busting query', () => {
		const tags = assetTags(link('/a.css'), 'css');
		expect(tags).toHaveLength(1);
		expect(tags[0]?.path).toBe('/a.css');
	});

	it('reads a script src the same way', () => {
		expect(assetTags(script('/a.js'), 'js')[0]?.path).toBe('/a.js');
	});

	it('skips an inline script, which belongs to no library', () => {
		expect(assetTags('<script>window.x=1</script>', 'js')).toEqual([]);
	});

	it('skips an off-site asset rather than matching it loosely', () => {
		expect(assetTags(link('https://cdn.example/a.css'), 'css')).toEqual([]);
		expect(assetTags(script('//cdn.example/a.js'), 'js')).toEqual([]);
	});

	it('keeps document order, which is what a run depends on', () => {
		const html = link('/a.css') + link('/b.css') + link('/c.css');
		expect(assetTags(html, 'css').map((t) => t.path)).toEqual(['/a.css', '/b.css', '/c.css']);
	});
});

describe('replacing a complete run', () => {
	it('collapses a library to one tag', () => {
		const html = `<head>${link('/themes/olivero/css/base.css')}${link('/themes/olivero/css/theme.css')}</head>`;
		const out = substituteAggregates(html, INDEX);
		expect(out.replaced).toContain('olivero/global:css');
		expect(out.tagsRemoved).toBe(2);
		expect(out.html).toContain('/agg/aaaa.css');
		expect(out.html).not.toContain('base.css');
	});

	it('handles css and js in one pass', () => {
		const html =
			`<head>${link('/themes/olivero/css/base.css')}${link('/themes/olivero/css/theme.css')}</head>` +
			`<body>${script('/themes/olivero/js/nav.js')}</body>`;
		const out = substituteAggregates(html, INDEX);
		expect(out.replaced.sort()).toEqual(['olivero/global:css', 'olivero/global:js']);
		expect(out.html).toContain('/agg/aaaa.css');
		expect(out.html).toContain('/agg/bbbb.js');
	});

	it('replaces two libraries without disturbing each other', () => {
		const html =
			`<head>${link('/core/misc/drupal.css')}` +
			`${link('/themes/olivero/css/base.css')}${link('/themes/olivero/css/theme.css')}</head>`;
		const out = substituteAggregates(html, INDEX);
		expect(out.replaced.sort()).toEqual(['core/drupal:css', 'olivero/global:css']);
		expect(out.html).toContain('/agg/cccc.css');
		expect(out.html).toContain('/agg/aaaa.css');
		// the cascade order survives: core still precedes the theme
		expect(out.html.indexOf('cccc.css')).toBeLessThan(out.html.indexOf('aaaa.css'));
	});

	it('leaves a tag no library claims exactly where it was', () => {
		const html = `<head>${link('/modules/custom/x.css')}${link('/core/misc/drupal.css')}</head>`;
		const out = substituteAggregates(html, INDEX);
		expect(out.html).toContain('/modules/custom/x.css');
		expect(out.replaced).toEqual(['core/drupal:css']);
	});
});

describe('and refusing an incomplete one, which is the whole safety property', () => {
	it('leaves a library alone when one of its files is missing', () => {
		// a partial replacement drops the rules in the file that was not there, and the page looks
		// fine until someone opens it
		const html = `<head>${link('/themes/olivero/css/base.css')}</head>`;
		const out = substituteAggregates(html, INDEX);
		expect(out.replaced).toEqual([]);
		expect(out.tagsRemoved).toBe(0);
		expect(out.html).toBe(html);
	});

	it('leaves it alone when the files are out of order', () => {
		const html = `<head>${link('/themes/olivero/css/theme.css')}${link('/themes/olivero/css/base.css')}</head>`;
		expect(substituteAggregates(html, INDEX).replaced).toEqual([]);
	});

	it('leaves it alone when something interrupts the run', () => {
		const html =
			`<head>${link('/themes/olivero/css/base.css')}` +
			`${link('/modules/custom/x.css')}` +
			`${link('/themes/olivero/css/theme.css')}</head>`;
		expect(substituteAggregates(html, INDEX).replaced).toEqual([]);
	});

	it('changes nothing on a page with no assets at all', () => {
		const html = '<html><body>hello</body></html>';
		expect(substituteAggregates(html, INDEX)).toMatchObject({
			html,
			replaced: [],
			tagsRemoved: 0
		});
	});

	it('skips a library the build produced no aggregate for', () => {
		const partial: AggregateIndex = {
			libraries: {},
			files: { 'core/drupal': { css: ['/core/misc/drupal.css'] } }
		};
		const html = `<head>${link('/core/misc/drupal.css')}</head>`;
		expect(substituteAggregates(html, partial).replaced).toEqual([]);
	});

	it('never lets two libraries claim the same tag', () => {
		const overlapping: AggregateIndex = {
			libraries: { a: { css: 'a.css' }, b: { css: 'b.css' } },
			files: { a: { css: ['/x.css'] }, b: { css: ['/x.css'] } }
		};
		const out = substituteAggregates(`<head>${link('/x.css')}</head>`, overlapping);
		expect(out.replaced).toHaveLength(1);
		expect(out.tagsRemoved).toBe(1);
	});
});
