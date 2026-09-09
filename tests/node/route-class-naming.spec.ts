import { describe, expect, it } from 'vitest';
import {
	extractSlots,
	measureClass,
	type Entity
} from '../../scripts/measure/route-class-naming.js';
import { compilePlan } from '../../src/ops/render-plan.js';

/**
 * The instrument's own guard, not a guard on its verdict.
 *
 * What it measures needs `drupal-src`, the pack and a PHP binary, none of which a clean checkout
 * has, so the measurement itself cannot be a gate. The classifier is pure and is what would break
 * silently: a matcher that names a region it cannot reproduce reports a mechanism as viable when it
 * is not, and that is the error this whole exercise exists to avoid.
 */

const SHELL = [
	'<!DOCTYPE html><html><head><meta charset="utf-8" />',
	'<title>SITE_TITLE_LINE_THAT_IS_LONG_ENOUGH_TO_ANCHOR</title>',
	'<link rel="stylesheet" href="/core/themes/olivero/css/base.css" />',
	'</head><body><div class="layout-container-with-a-long-class-name">',
	'<nav class="primary-navigation-block-that-anchors-the-diff"></nav>'
].join('\n');

const FOOTER = [
	'</div>',
	'<footer class="site-footer-region-with-a-long-class-name">footer</footer>',
	'</body></html>'
].join('\n');

function page(title: string, extra = ''): string {
	return `${SHELL}\n<h1 class="node-title-heading-long-enough">${title}</h1>${extra}\n${FOOTER}`;
}

function ownRow(id: string, title: string, extra = ''): Entity {
	return {
		id,
		path: `/node/${id}`,
		html: page(title, extra),
		values: { __id: id, 'title.0.value': title }
	};
}

describe('route-class naming instrument', () => {
	it('extracts a third render slot values when the constants align', () => {
		const plan = compilePlan(page('Qq Alpha'), page('Ww Bravo'), '/node');
		const values = extractSlots(plan, page('Ee Charlie'));
		expect(values).not.toBeNull();
		expect(Object.values(values!).join('')).toContain('Charlie');
	});

	it('refuses a render whose constants do not align', () => {
		const plan = compilePlan(page('Qq Alpha'), page('Ww Bravo'), '/node');
		expect(extractSlots(plan, `${page('Ee Charlie')}<div>an extra block</div>`)).toBeNull();
	});

	it('serves a class whose every varying region is on the entity own row', () => {
		const r = measureClass('own row', [
			ownRow('1', 'Qq Alpha'),
			ownRow('2', 'Ww Bravo'),
			ownRow('3', 'Ee Charlie')
		]);
		expect(r.slots.filter((s) => s.klass === 'unknown')).toHaveLength(0);
		expect(r.served).toBe(3);
	});

	it('refuses a region borrowed from another entity row, and allows it only when denormalised', () => {
		// the value rendered is a value of the entity this one REFERENCES, which is what the node
		// canonical class turned out to be made of
		const withRef = (id: string, title: string, refLabel: string): Entity => ({
			...ownRow(
				id,
				title,
				`\n<a class="node-reference-link-long" href="/node/9">${refLabel}</a>`
			),
			values: { __id: id, 'title.0.value': title, '__ref.field_ref.0.label': refLabel }
		});
		const r = measureClass('borrowed', [
			withRef('1', 'Qq Alpha', 'Kestrel'),
			withRef('2', 'Ww Bravo', 'Lantern'),
			withRef('3', 'Ee Charlie', 'Mizzen')
		]);
		expect(r.slots.some((s) => s.klass === 'field_ref')).toBe(true);
		expect(r.served).toBe(0);
		expect(r.servedRelaxed).toBe(3);
	});

	it('names nothing when a region matches no value the entity can supply', () => {
		const opaque = (id: string, token: string): Entity => ({
			...ownRow(id, 'Qq Alpha'),
			html: page('Qq Alpha', `\n<span class="opaque-region-long-enough">${token}</span>`),
			values: { __id: id, 'title.0.value': 'Qq Alpha' }
		});
		const r = measureClass('opaque', [
			opaque('1', 'aaaa'),
			opaque('2', 'bbbb'),
			opaque('3', 'cccc')
		]);
		expect(r.slots.some((s) => s.klass === 'unknown')).toBe(true);
		expect(r.served).toBe(0);
	});

	it('separates per-request volatility from per-entity variation', () => {
		// without the control a per-request random id reads as a route-class failure and closes the
		// wrong mechanism
		const a = ownRow(
			'1',
			'Qq Alpha',
			'\n<span class="request-token-region-long">tok-AAAA</span>'
		);
		const b = ownRow(
			'2',
			'Ww Bravo',
			'\n<span class="request-token-region-long">tok-BBBB</span>'
		);
		const repeat = page(
			'Qq Alpha',
			'\n<span class="request-token-region-long">tok-CCCC</span>'
		);
		const r = measureClass('volatile', [a, b], repeat);
		expect(r.baselineRegions).toBeGreaterThan(0);
		expect(r.slots.some((s) => s.klass === 'volatile')).toBe(true);
		expect(r.served).toBe(0);
	});
});
