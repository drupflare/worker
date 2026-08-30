import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composerAutoloadFiles, sdcSiblings } from '../../scripts/pack-completion.ts';

/**
 * The pack's skip lists drop `.css` and `.js` on the reasoning that PHP never opens them. That is
 * true of every library declared in a `*.libraries.yml`, where Drupal only ever builds a URL, and
 * FALSE of a single-directory component, where `ComponentPluginManager::findAsset()` stat-s the
 * file to decide whether the component's generated library gets a stylesheet at all.
 *
 * The failure is silent in both directions: the component still renders, and the asset layer still
 * serves the file to anyone who asks for it. Nothing asks. Every toolbar button on every admin page
 * fell back to `2px outset` UA chrome because `admin-reset-styles.css` reverts the theme inside
 * `[data-drupal-admin-styles]` and the CSS that re-dresses it was never linked.
 *
 * Node lane: the tree check reads `drupal-src`.
 */

const ROOT = new URL('../../drupal-src/', import.meta.url).pathname;
const has = (p: string) => existsSync(join(ROOT, p));

describe('finding what a single-directory component owns', () => {
	it('takes the stylesheet and the script that sit beside a manifest', () => {
		const exists = new Set(['ui/card/card.css', 'ui/card/card.js']);
		expect(sdcSiblings(['ui/card/card.component.yml'], (p) => exists.has(p))).toEqual([
			'ui/card/card.css',
			'ui/card/card.js'
		]);
	});

	it('takes only what is there, because most components ship no script', () => {
		const exists = new Set(['ui/card/card.css']);
		expect(sdcSiblings(['ui/card/card.component.yml'], (p) => exists.has(p))).toEqual([
			'ui/card/card.css'
		]);
	});

	it('matches on the stem, not on any file in the directory', () => {
		// `toolbar-button/other.css` is not the component's asset and SDC would never look for it
		const exists = new Set(['nav/toolbar-button/other.css']);
		expect(
			sdcSiblings(['nav/toolbar-button/toolbar-button.component.yml'], (p) => exists.has(p))
		).toEqual([]);
	});

	it('ignores every path that is not a manifest', () => {
		expect(sdcSiblings(['ui/card/card.twig', 'ui/card/card.css'], () => true)).toEqual([]);
	});

	it('does not walk off a manifest with no directory above it', () => {
		expect(sdcSiblings(['card.component.yml'], () => true)).toEqual([]);
	});

	it('reports each asset once when a manifest is listed twice', () => {
		const twice = ['ui/card/card.component.yml', 'ui/card/card.component.yml'];
		expect(sdcSiblings(twice, () => true)).toEqual(['ui/card/card.css', 'ui/card/card.js']);
	});
});

describe.skipIf(!existsSync(ROOT))('against the tree that is packed', () => {
	/**
	 * The specific file whose absence was measured. `toolbar-button` is the component every admin
	 * page renders dozens of, so it is the one that made the toolbar look broken.
	 */
	it('finds the admin toolbar button stylesheet', () => {
		const found = sdcSiblings(
			['core/modules/navigation/components/toolbar-button/toolbar-button.component.yml'],
			has
		);
		expect(found).toContain(
			'core/modules/navigation/components/toolbar-button/toolbar-button.css'
		);
	});

	it('claims nothing for a manifest the tree does not have', () => {
		expect(
			sdcSiblings(['core/modules/navigation/components/gone/gone.component.yml'], has)
		).toEqual([]);
	});
});

/**
 * The other half of the same problem: a file set pinned before a dependency existed cannot contain
 * that dependency's bootstrap, and composer requires every `files` entry before resolving a single
 * class -- so the miss is a fatal on every request rather than on one code path.
 */
describe('reading composer files autoload', () => {
	const SOURCE = `<?php
$vendorDir = dirname(__DIR__);
$baseDir = dirname($vendorDir);

return array(
    '6e3fae29' => $vendorDir . '/symfony/deprecation-contracts/function.php',
    'a4a119a5' => $vendorDir . '/halaxa/json-machine/src/functions.php',
    '667aeda7' => $baseDir . '/core/includes/bootstrap.inc',
);
`;

	it('resolves a vendor entry under vendor/', () => {
		expect(composerAutoloadFiles(SOURCE)).toContain(
			'vendor/symfony/deprecation-contracts/function.php'
		);
	});

	it('resolves a base entry relative to the tree root', () => {
		expect(composerAutoloadFiles(SOURCE)).toContain('core/includes/bootstrap.inc');
	});

	it('finds every entry and sorts them', () => {
		const found = composerAutoloadFiles(SOURCE);
		expect(found).toEqual([...found].sort());
		expect(found).toHaveLength(3);
	});

	it('reads nothing out of a file with no entries', () => {
		expect(composerAutoloadFiles('<?php return array();')).toEqual([]);
	});
});

describe.skipIf(!existsSync(join(ROOT, 'vendor/composer/autoload_files.php')))(
	'against the autoloader that is packed',
	() => {
		/**
		 * The regression itself. `halaxa/json-machine` and `league/csv` were in `autoload_files.php`
		 * and in neither pack, so a rebuilt pack died with `Failed opening required` on every render
		 * before a single line of Drupal ran.
		 */
		it('every files entry exists in the tree', () => {
			const source = readFileSync(join(ROOT, 'vendor/composer/autoload_files.php'), 'utf8');
			const required = composerAutoloadFiles(source);
			expect(required.length).toBeGreaterThan(0);
			expect(required.filter((p) => !has(p))).toEqual([]);
		});
	}
);
