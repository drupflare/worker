import { describe, expect, it } from 'vitest';
import { CmsHasNoBootError, phasesFor, treeBootFor } from '../../../src/do/tree-boot';
import { bootDrupalTree } from '../../../src/drupal/boot';
import { bootWordpressTree } from '../../../src/wordpress/boot';

describe('treeBootFor', () => {
	it('answers the Drupal boot for drupal, an absent value and an empty one', () => {
		expect(treeBootFor('drupal')).toBe(bootDrupalTree);
		expect(treeBootFor(undefined)).toBe(bootDrupalTree);
		expect(treeBootFor('')).toBe(bootDrupalTree);
	});

	it('answers the WordPress boot for wordpress, and not the Drupal one', () => {
		expect(treeBootFor('wordpress')).toBe(bootWordpressTree);
		expect(treeBootFor('wordpress')).not.toBe(bootDrupalTree);
	});

	it('names the CMS and refuses it when it has no boot, instead of booting Drupal', () => {
		for (const cms of ['joomla', 'typo3']) {
			expect(() => treeBootFor(cms)).toThrow(CmsHasNoBootError);
			expect(() => treeBootFor(cms)).toThrow(`CMS=${cms} has no boot yet`);
		}
	});
});

describe('phasesFor', () => {
	it('keeps every Drupal alarm phase on for drupal, an absent value and an empty one', () => {
		const drupal = { reconcile: true, prefill: true, cron: 'drupal' };
		expect(phasesFor('drupal')).toEqual(drupal);
		expect(phasesFor(undefined)).toEqual(drupal);
		expect(phasesFor('')).toEqual(drupal);
	});

	it('runs no Drupal phase for WordPress and drives WordPress cron instead', () => {
		expect(phasesFor('wordpress')).toEqual({
			reconcile: false,
			prefill: false,
			cron: 'wordpress'
		});
	});

	it('runs nothing for a CMS the table lacks', () => {
		for (const cms of ['joomla', 'typo3']) {
			expect(phasesFor(cms)).toEqual({ reconcile: false, prefill: false, cron: 'none' });
		}
	});
});
