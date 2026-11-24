import { describe, expect, it } from 'vitest';
import {
	DRUPAL_PAGE,
	PACK,
	WORDPRESS_PAGE,
	coldPagesAtRowsReadBound,
	ladderRunCost,
	sitesAtStorage,
	stagingShareOfWrites,
	usdForColdPages,
	usdStoragePerMonth,
	usdToStage,
	wordpressFreeRenderLoss
} from '../../../scripts/measure/pack-storage-price';

describe('pack storage price', () => {
	it('fits 380 pack copies in the free storage ceiling', () => {
		expect(sitesAtStorage(PACK.storedBytes)).toBe(380);
	});

	it('charges staging as 0.4% of the free daily write bound per object', () => {
		expect(stagingShareOfWrites(1)).toBeCloseTo(0.00403, 5);
		expect(stagingShareOfWrites(25)).toBeCloseTo(25 * 0.00403, 4);
	});

	it('reaches the free read bound sooner with the pack rows than without them', () => {
		const { coldRows, packRows } = DRUPAL_PAGE.front;
		expect(coldPagesAtRowsReadBound(coldRows)).toBe(2195);
		expect(coldPagesAtRowsReadBound(coldRows - packRows)).toBeGreaterThan(
			coldPagesAtRowsReadBound(coldRows)
		);
	});

	it('halves the WordPress renders a free day allows, since every request mounts', () => {
		const { coldRows, packRows } = WORDPRESS_PAGE.search;
		expect(coldPagesAtRowsReadBound(coldRows)).toBe(14_124);
		expect(coldPagesAtRowsReadBound(coldRows - packRows)).toBe(26_455);
	});

	it('puts the free WordPress loss at 46.6%, the reason the pack stays resident there', () => {
		expect(wordpressFreeRenderLoss(WORDPRESS_PAGE.search)).toBeCloseTo(0.466, 3);
	});

	it('prices rows at the list rate', () => {
		expect(usdToStage()).toBeCloseTo(0.000403, 6);
		expect(usdStoragePerMonth()).toBeCloseTo(0.00263, 5);
		expect(usdForColdPages(10_000, 218)).toBeCloseTo(0.00218, 5);
	});

	it('counts a ladder as one request per rung plus the recycle and the prep', () => {
		const run = ladderRunCost({
			headroomMiB: 216,
			ladders: 12,
			prepRequestsPerLadder: 6,
			secondsPerCall: 0.5
		});
		expect(run.requests).toBe((54 + 1 + 1 + 6) * 12);
		expect(run.gbS).toBeCloseTo(run.requests * 0.5 * 0.128, 6);
		expect(run.usd).toBeGreaterThan(0);
	});
});
