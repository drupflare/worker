import { describe, expect, it } from 'vitest';
import { FREE_QUOTAS } from '../../../scripts/measure/free-envelope';
import {
	DAYS_PER_MONTH,
	ROWS_READ_METER,
	STORAGE_METER,
	attributeSpend,
	projectMonth,
	type SiteSpend,
	type SpendLine,
	type SpendReport
} from '../../../src/ops/cost-attribution';

/**
 * Why THIS site spent what it spent.
 *
 * The account-level answer already exists; what was missing is the split. Four dimensions draw on
 * the Durable Object request meter alone, so its total cannot say which of them to change.
 *
 * The distinction the whole module turns on: a dimension nothing counts is null, never 0. Three of
 * the four uncounted ones have a counter that covers the wrong window -- `alarmFirings` and
 * `phpLaneEntries` reset with the incarnation, `cfw_http_queue` is a depth whose rows are deleted as
 * they drain -- and scoring any of them against a daily allowance gives a wrong percentage that
 * reads as measured.
 */

const full: SiteSpend = {
	rowsToday: 40_000,
	doRequestsToday: 30_000,
	storage: 14_000_000,
	imageStyles: 4,
	managedImages: 100
};

const lineFor = (report: SpendReport, id: string): SpendLine => {
	const line = report.lines.find((l) => l.id === id);
	expect(line, `no line with id ${id}`).toBeDefined();
	return line as SpendLine;
};

describe('the local meters are pinned to the envelope script', () => {
	it('reads the same allowances the model does', () => {
		expect(ROWS_READ_METER.free).toBe(FREE_QUOTAS.rowsReadPerDay);
		expect(STORAGE_METER.free).toBe(FREE_QUOTAS.storageBytes);
	});

	it('projects a month over the same 30 days', () => {
		expect(DAYS_PER_MONTH).toBe(30);
	});

	it('gives every dimension a unique id, so a UI can key rows on it', () => {
		const ids = attributeSpend(full).lines.map((l) => l.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('puts the meter that stops working first, matching the threshold table', () => {
		expect(attributeSpend(full).lines[0]?.id).toBe('image-transforms');
	});
});

describe('a site with nothing spent', () => {
	const idle: SiteSpend = {
		rowsToday: 0,
		doRequestsToday: 0,
		storage: 0,
		imageStyles: 0,
		managedImages: 0
	};

	it('scores a real zero as ok rather than as unknown', () => {
		const report = attributeSpend(idle, { PLAN: 'free' });
		for (const id of ['rows-written', 'object-hops', 'stored-bytes', 'image-transforms']) {
			const line = lineFor(report, id);
			expect(line.quantity, id).toBe(0);
			expect(line.status, id).toBe('ok');
			expect(line.percentOfAllowance, id).toBe(0);
		}
	});

	it('still reports the dimensions nothing counts, so the table is not half a story', () => {
		const report = attributeSpend(idle, { PLAN: 'free' });
		expect(report.counted).toBe(5);
		expect(report.uncounted).toBe(5);
		expect(report.lines).toHaveLength(10);
	});

	it('charges no storage to a pool that does not exist', () => {
		// zero lanes is a measured zero: nothing is configured, so nothing holds a second copy
		const line = lineFor(attributeSpend(idle, { PLAN: 'free' }), 'replica-copies');
		expect(line.quantity).toBe(0);
		expect(line.source).toContain('REPLICA_COUNT is 0');
	});
});

describe('a dimension nothing counts is reported, never zeroed', () => {
	const report = attributeSpend(full, { PLAN: 'free' });

	it.each([
		['page-views', 'edge cache'],
		['renders', 'phpLaneEntries'],
		['warm-alarms', 'alarmFirings'],
		['outbound-fetches', 'cfw_http_queue'],
		['rows-read', 'read-only statements']
	])('%s is null and names why', (id, reason) => {
		const line = lineFor(report, id);
		expect(line.quantity).toBeNull();
		expect(line.status).toBe('unknown');
		expect(line.percentOfAllowance).toBeNull();
		expect(line.source).toContain(reason);
	});

	it('stays null on a fully populated payload, because the gap is structural', () => {
		// every counter this module can read is present here; the five that are still null are
		// missing a counter rather than missing an input
		expect(report.counted).toBe(5);
		expect(report.uncounted).toBe(5);
	});

	it('does not let serveRequests stand in for the Worker meter', () => {
		// it counts what reached the OBJECT; an edge-cache hit never enters an isolate that could
		// count it, so a figure built from it undercounts by exactly the traffic the cache absorbs
		expect(lineFor(report, 'page-views').source).toContain('lifetime total');
	});

	it('omits the image projection rather than guessing on an unmigrated site', () => {
		const line = lineFor(
			attributeSpend({ rowsToday: 5 }, { PLAN: 'free' }),
			'image-transforms'
		);
		expect(line.quantity).toBeNull();
		expect(line.source).toContain('verified zero');
	});

	it('treats a NaN counter as no counter at all', () => {
		const line = lineFor(attributeSpend({ rowsToday: Number.NaN }), 'rows-written');
		expect(line.quantity).toBeNull();
		expect(line.status).toBe('unknown');
	});
});

describe('several dimensions draw on one meter, which is the whole point', () => {
	it('routes four dimensions at the DO request meter', () => {
		const drawing = attributeSpend(full)
			.lines.filter((l) => l.meter === 'do-requests')
			.map((l) => l.id);
		expect(drawing).toEqual(['object-hops', 'renders', 'warm-alarms', 'outbound-fetches']);
	});

	it('routes the replica pool at the storage meter, in bytes rather than lanes', () => {
		// a lane count against a byte allowance is a percentage of nothing; the cost is the copy
		const report = attributeSpend(full, { PLAN: 'free', REPLICA_COUNT: '4' });
		const line = lineFor(report, 'replica-copies');
		expect(line.unit).toBe('bytes');
		expect(line.quantity).toBe(14_000_000 * 4);
		expect(line.meter).toBe(STORAGE_METER.id);
	});

	it('cannot price the pool when it cannot price one copy', () => {
		const report = attributeSpend({ imageStyles: 1, managedImages: 1 }, { REPLICA_COUNT: '4' });
		expect(lineFor(report, 'stored-bytes').quantity).toBeNull();
		expect(lineFor(report, 'replica-copies').quantity).toBeNull();
	});

	it('clamps a pool size the router would not honour', () => {
		// replicaCount() caps at 32, and a cost report must charge what the router actually routes to
		const report = attributeSpend(full, { REPLICA_COUNT: '900' });
		expect(lineFor(report, 'replica-copies').quantity).toBe(14_000_000 * 32);
	});
});

describe('over an allowance', () => {
	it('says the image cap stops working rather than bills', () => {
		const report = attributeSpend(
			{ ...full, imageStyles: 10, managedImages: 2_000 },
			{ PLAN: 'free' }
		);
		const line = lineFor(report, 'image-transforms');
		expect(line.quantity).toBe(20_000);
		expect(line.status).toBe('over');
		expect(line.percentOfAllowance).toBe(400);
		expect(line.consequence).toBe('stops working');
	});

	it('says a daily meter refuses requests while the site stays up', () => {
		const line = lineFor(
			attributeSpend({ rowsToday: 120_000 }, { PLAN: 'free' }),
			'rows-written'
		);
		expect(line.status).toBe('over');
		expect(line.consequence).toBe('requests are refused');
	});

	it('warns at 80% of the allowance and not before', () => {
		const at = (rows: number) =>
			lineFor(attributeSpend({ rowsToday: rows }, { PLAN: 'free' }), 'rows-written').status;
		expect(at(79_999)).toBe('ok');
		expect(at(80_000)).toBe('warn');
		expect(at(100_000)).toBe('over');
	});

	it('applies the same rule to the level meter', () => {
		const at = (bytes: number) =>
			lineFor(attributeSpend({ storage: bytes }, { PLAN: 'free' }), 'stored-bytes').status;
		expect(at(4_000_000_000)).toBe('warn');
		expect(at(5_000_000_000)).toBe('over');
		expect(at(100_000_000)).toBe('ok');
	});
});

describe('the free and paid plans do not fail the same way', () => {
	it('caps on free and bills on paid, for the same site', () => {
		const spend: SiteSpend = { rowsToday: 90_000, doRequestsToday: 90_000, storage: 4_000_000 };
		const free = lineFor(attributeSpend(spend, { PLAN: 'free' }), 'rows-written');
		const paid = lineFor(attributeSpend(spend, { PLAN: 'paid' }), 'rows-written');

		expect(free.allowance).toBe(FREE_QUOTAS.rowsWrittenPerDay);
		expect(free.status).toBe('warn');
		expect(free.consequence).toBe('requests are refused');

		expect(paid.allowance).toBeNull();
		expect(paid.status).toBe('unmetered');
		expect(paid.percentOfAllowance).toBeNull();
		expect(paid.consequence).toBe('bills');
	});

	it('resolves the plan on every line, not only the ones another test names', () => {
		// an env argument missed on one dimension scores a paid site against free's allowance, and
		// nothing but that dimension's own assertion would see it
		const paid = attributeSpend(full, { PLAN: 'paid', REPLICA_COUNT: '2' });
		expect(paid.lines.filter((l) => l.allowance !== null).map((l) => l.id)).toEqual([]);
		const free = attributeSpend(full, { PLAN: 'free', REPLICA_COUNT: '2' });
		expect(free.lines.filter((l) => l.allowance === null).map((l) => l.id)).toEqual([]);
	});

	it('keeps the quantity on paid, because unmetered is not uncounted', () => {
		const paid = lineFor(
			attributeSpend({ rowsToday: 90_000 }, { PLAN: 'paid' }),
			'rows-written'
		);
		expect(paid.quantity).toBe(90_000);
	});

	it('treats an absent or unrecognised plan as free', () => {
		expect(attributeSpend(full).plan).toBe('free');
		expect(attributeSpend(full, { PLAN: 'enterprise' }).plan).toBe('free');
		expect(lineFor(attributeSpend(full, { PLAN: '' }), 'stored-bytes').allowance).toBe(
			STORAGE_METER.free
		);
	});

	it('bills the level meter on paid too', () => {
		const line = lineFor(attributeSpend(full, { PLAN: 'paid' }), 'stored-bytes');
		expect(line.allowance).toBeNull();
		expect(line.consequence).toBe('bills');
	});
});

describe('no line carries a dollar figure', () => {
	it('reports the quantity and the percentage instead, with the reason', () => {
		const report = attributeSpend(full, { PLAN: 'paid' });
		expect(report.usd).toBeNull();
		expect(report.usdReason).toContain('no per-unit price');
		expect(
			report.lines.some((l) => Object.keys(l).some((k) => /usd|dollar|price/i.test(k)))
		).toBe(false);
	});
});

describe('the percentages agree with the allowances', () => {
	it('round-trips every scored line back to its quantity', () => {
		for (const plan of ['free', 'paid'] as const) {
			for (const line of attributeSpend(full, { PLAN: plan, REPLICA_COUNT: '2' }).lines) {
				if (line.quantity === null || line.allowance === null) {
					expect(line.percentOfAllowance, line.id).toBeNull();
					continue;
				}
				expect(line.percentOfAllowance, line.id).not.toBeNull();
				const back = ((line.percentOfAllowance as number) / 100) * line.allowance;
				expect(back, line.id).toBeCloseTo(line.quantity, 6);
			}
		}
	});
});

describe('the month projection', () => {
	it('multiplies today by the days in the month, and the allowance with it', () => {
		const line = projectMonth({ rowsToday: 2_000 }, 15).lines.find(
			(l) => l.id === 'rows-written'
		);
		expect(line?.perDay).toBe(2_000);
		expect(line?.month).toBe(2_000 * 30);
		expect(line?.allowance).toBe(FREE_QUOTAS.rowsWrittenPerDay * 30);
		expect(line?.basis).toBe('projected from today');
	});

	it('states the elapsed fraction rather than dividing by it', () => {
		// month-to-date over an elapsed fraction turns a few hours of day 1 into a month; the input
		// here is a daily counter, so the rate is what gets multiplied
		const early = projectMonth({ rowsToday: 2_000 }, 1);
		const late = projectMonth({ rowsToday: 2_000 }, 29);
		expect(early.elapsedFraction).toBeCloseTo(1 / 30, 6);
		expect(late.elapsedFraction).toBeCloseTo(29 / 30, 6);
		const monthOf = (p: typeof early) => p.lines.find((l) => l.id === 'rows-written')?.month;
		expect(monthOf(early)).toBe(monthOf(late));
	});

	it('flags day 1 instead of reporting a wild number', () => {
		const p = projectMonth({ rowsToday: 2_000 }, 1);
		expect(p.partialDay).toBe(true);
		expect(p.note).toContain('part of one day');
		expect(p.lines.every((l) => l.month === null || Number.isFinite(l.month))).toBe(true);
	});

	it('is not a partial day once a whole one has passed', () => {
		expect(projectMonth({ rowsToday: 2_000 }, 2).partialDay).toBe(false);
		expect(projectMonth({ rowsToday: 2_000 }, 2).note).toContain(
			'28 of 30 days are not observed'
		);
	});

	it.each([0, -5, 0.4, Number.NaN, Number.POSITIVE_INFINITY])(
		'clamps a day of %p into the month rather than dividing by it',
		(day) => {
			const p = projectMonth({ rowsToday: 2_000 }, day as number);
			expect(p.dayOfMonth).toBeGreaterThanOrEqual(1);
			expect(p.dayOfMonth).toBeLessThanOrEqual(p.daysInMonth);
			expect(Number.isFinite(p.elapsedFraction)).toBe(true);
			expect(p.elapsedFraction).toBeGreaterThan(0);
		}
	);

	it('clamps past the end of the month too', () => {
		expect(projectMonth({ rowsToday: 1 }, 44).dayOfMonth).toBe(30);
		expect(projectMonth({ rowsToday: 1 }, 44, null, 31).dayOfMonth).toBe(31);
	});

	it('never multiplies a figure that is already a whole month', () => {
		const line = projectMonth({ imageStyles: 4, managedImages: 100 }, 15).lines.find(
			(l) => l.id === 'image-transforms'
		);
		expect(line?.perDay).toBeNull();
		expect(line?.month).toBe(400);
		expect(line?.allowance).toBe(FREE_QUOTAS.imageTransformsPerMonth);
		expect(line?.basis).toBe('already a whole month');
	});

	it('never multiplies a level either, because storage is not a rate', () => {
		const line = projectMonth({ storage: 14_000_000 }, 15).lines.find(
			(l) => l.id === 'stored-bytes'
		);
		expect(line?.perDay).toBeNull();
		expect(line?.month).toBe(14_000_000);
		expect(line?.basis).toBe('a level, not a rate');
	});

	it('carries the uncounted dimensions through as uncounted', () => {
		const line = projectMonth(full, 15).lines.find((l) => l.id === 'warm-alarms');
		expect(line?.month).toBeNull();
		expect(line?.percentOfAllowance).toBeNull();
		expect(line?.basis).toBe('nothing counts it');
	});

	it('carries the plan through, so a paid month is unmetered rather than over', () => {
		const line = projectMonth({ rowsToday: 90_000 }, 15, { PLAN: 'paid' }).lines.find(
			(l) => l.id === 'rows-written'
		);
		expect(line?.allowance).toBeNull();
		expect(line?.status).toBe('unmetered');
	});

	it('leaves a daily meter at the same percentage, because its allowance resets too', () => {
		// the month multiplies the usage AND the allowance by 30, so the share does not move. A
		// projection that compared a month of rows against ONE day's allowance would read 30x over
		const day = lineFor(attributeSpend({ rowsToday: 4_000 }, { PLAN: 'free' }), 'rows-written');
		const month = projectMonth({ rowsToday: 4_000 }, 15).lines.find(
			(l) => l.id === 'rows-written'
		);
		expect(day.percentOfAllowance).toBe(4);
		expect(month?.percentOfAllowance).toBeCloseTo(4, 6);
		expect(month?.status).toBe(day.status);
	});
});
