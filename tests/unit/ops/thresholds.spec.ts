import { describe, expect, it } from 'vitest';
import { FREE_QUOTAS } from '../../../scripts/measure/free-envelope';
import {
	THRESHOLDS,
	WARN_FRACTION,
	hardCaps,
	limitFor,
	projectImageTransforms,
	readMeter,
	thresholdReport
} from '../../../src/ops/thresholds';

/**
 * The meters, and the one that fails as a hard cap.
 *
 * The image cap is the reason this module exists: it is monthly, it stops working rather than
 * billing, and it is a function of the site's CONTENT rather than its traffic -- so it is knowable in
 * advance and nothing was computing it. The coordinator's example (10 styles over 2,000 images = 4x
 * over) is asserted directly, because that is the case a site owner actually hits.
 */

describe('the threshold table is pinned to the envelope script', () => {
	it.each([
		['image-transforms', 'imageTransformsPerMonth'],
		['worker-requests', 'workerRequestsPerDay'],
		['rows-written', 'rowsWrittenPerDay'],
		['do-requests', 'doRequestsPerDay'],
		['workflow-steps', 'workflowStepsPerDay'],
		['workflow-steps-instance', 'workflowStepsPerInstance']
	])('%s matches FREE_QUOTAS.%s', (id, quota) => {
		const t = THRESHOLDS.find((x) => x.id === id);
		expect(t).toBeDefined();
		expect(t?.free).toBe((FREE_QUOTAS as Record<string, number>)[quota]);
	});

	it('gives every meter a unique id, so a UI can key rows on it', () => {
		const ids = THRESHOLDS.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('the failure mode is recorded, because a bill and an outage are different', () => {
	it('names exactly one hard cap, and it is the image meter', () => {
		expect(hardCaps().map((t) => t.id)).toEqual(['image-transforms']);
	});

	it('is the only MONTHLY meter, so a bad day does not clear it', () => {
		const monthly = THRESHOLDS.filter((t) => t.period === 'month');
		expect(monthly.map((t) => t.id)).toEqual(['image-transforms']);
	});

	it('puts the silent failure first, ahead of the bigger numbers', () => {
		// ordered by how badly the failure surprises you, not by size
		expect(THRESHOLDS[0]?.id).toBe('image-transforms');
	});

	it('says the image cap does not reset until next month, in the over message', () => {
		const over = readMeter(THRESHOLDS[0]!, 20_000, { PLAN: 'free' });
		expect(over.status).toBe('over');
		expect(over.message).toContain('already stopped working');
		expect(over.message).toContain('next month');
	});

	it('does not claim a monthly reset for a daily meter', () => {
		const rows = THRESHOLDS.find((t) => t.id === 'rows-written')!;
		expect(readMeter(rows, 200_000, { PLAN: 'free' }).message).not.toContain('next month');
	});
});

describe('limitFor and readMeter', () => {
	it('reads the paid allowance on paid', () => {
		const steps = THRESHOLDS.find((t) => t.id === 'workflow-steps')!;
		expect(limitFor(steps, { PLAN: 'free' })).toBe(3_000);
		expect(limitFor(steps, { PLAN: 'paid' })).toBe(500_000);
	});

	it('reports a null paid allowance as unmetered rather than as zero', () => {
		const rows = THRESHOLDS.find((t) => t.id === 'rows-written')!;
		const r = readMeter(rows, 999_999, { PLAN: 'paid' });
		expect(r.status).toBe('unmetered');
		expect(r.fraction).toBeNull();
	});

	it('distinguishes "nothing measures this" from "this is zero"', () => {
		// collapsing them is how an unmeasured meter reads as a healthy one
		const rows = THRESHOLDS.find((t) => t.id === 'rows-written')!;
		expect(readMeter(rows, null, { PLAN: 'free' }).status).toBe('unknown');
		expect(readMeter(rows, 0, { PLAN: 'free' }).status).toBe('ok');
	});

	it('warns at 80% and goes over at 100%, not before', () => {
		const rows = THRESHOLDS.find((t) => t.id === 'rows-written')!;
		expect(readMeter(rows, 79_999, { PLAN: 'free' }).status).toBe('ok');
		expect(readMeter(rows, 80_000, { PLAN: 'free' }).status).toBe('warn');
		expect(readMeter(rows, 99_999, { PLAN: 'free' }).status).toBe('warn');
		expect(readMeter(rows, 100_000, { PLAN: 'free' }).status).toBe('over');
		expect(WARN_FRACTION).toBe(0.8);
	});
});

describe('projectImageTransforms: the multiplication nobody was doing', () => {
	it('reproduces the 10 styles over 2,000 images case at 4x over', () => {
		const p = projectImageTransforms({ images: 2_000, styles: 10 }, { PLAN: 'free' });
		expect(p.uniques).toBe(20_000);
		expect(p.limit).toBe(5_000);
		expect(p.status).toBe('over');
		expect(p.multiple).toBe(4);
		expect(p.overBy).toBe(15_000);
	});

	it('says out loud that images STOP being transformed, not that a bill arrives', () => {
		const p = projectImageTransforms({ images: 2_000, styles: 10 }, { PLAN: 'free' });
		expect(p.message).toContain('stop being transformed');
		expect(p.message).toContain('first of the month');
		expect(p.message).not.toMatch(/bill|charge|cost you/i);
	});

	it('answers what WOULD fit, in both directions', () => {
		const p = projectImageTransforms({ images: 2_000, styles: 10 }, { PLAN: 'free' });
		// 5,000 / 2,000 images = 2 styles; 5,000 / 10 styles = 500 images
		expect(p.stylesThatFit).toBe(2);
		expect(p.imagesThatFit).toBe(500);
		expect(p.remedies[0]).toContain('reduce to 2 style(s)');
	});

	it('gives remedies that actually reduce uniques rather than deferring the problem', () => {
		const p = projectImageTransforms({ images: 2_000, styles: 10 }, { PLAN: 'free' });
		expect(p.remedies.join(' ')).toContain('one unique per image');
		expect(p.remedies.join(' ')).toContain('R2');
	});

	it('says so plainly when not even one style fits', () => {
		const p = projectImageTransforms({ images: 10_000, styles: 3 }, { PLAN: 'free' });
		expect(p.stylesThatFit).toBe(0);
		expect(p.remedies[0]).toContain('even one style');
	});

	it('fits a small site without warning', () => {
		const p = projectImageTransforms({ images: 100, styles: 4 }, { PLAN: 'free' });
		expect(p.uniques).toBe(400);
		expect(p.status).toBe('ok');
		expect(p.remedies).toEqual([]);
	});

	it('warns before it breaks, which is what projecting buys', () => {
		// 4,500 of 5,000 is 90%: still working, and the last chance to act
		const p = projectImageTransforms({ images: 900, styles: 5 }, { PLAN: 'free' });
		expect(p.status).toBe('warn');
		expect(p.message).toContain('HARD CAP');
	});

	it('counts what is already spent this month, because the cap is not per-deploy', () => {
		const p = projectImageTransforms(
			{ images: 100, styles: 4, alreadyUsed: 4_800 },
			{ PLAN: 'free' }
		);
		expect(p.uniques).toBe(5_200);
		expect(p.status).toBe('over');
	});

	it('treats a style added LATER as re-spending every image', () => {
		// the meter is (image x parameter set), so one more style is one more unique per image
		const four = projectImageTransforms({ images: 1_000, styles: 4 }, { PLAN: 'free' });
		const five = projectImageTransforms({ images: 1_000, styles: 5 }, { PLAN: 'free' });
		expect(five.uniques - four.uniques).toBe(1_000);
		expect(four.status).toBe('warn');
		expect(five.status).toBe('over');
	});

	it('is unmetered on paid', () => {
		const p = projectImageTransforms({ images: 100_000, styles: 20 }, { PLAN: 'paid' });
		expect(p.status).toBe('unmetered');
		expect(p.remedies).toEqual([]);
	});

	it('handles a site with no images or no styles without dividing by zero', () => {
		expect(projectImageTransforms({ images: 0, styles: 10 }, { PLAN: 'free' }).uniques).toBe(0);
		expect(
			projectImageTransforms({ images: 0, styles: 10 }, { PLAN: 'free' }).stylesThatFit
		).toBeNull();
		expect(
			projectImageTransforms({ images: 500, styles: 0 }, { PLAN: 'free' }).imagesThatFit
		).toBeNull();
	});

	it('floors fractional input rather than projecting a fractional transformation', () => {
		expect(
			projectImageTransforms({ images: 10.9, styles: 2.9 }, { PLAN: 'free' }).uniques
		).toBe(20);
	});
});

describe('thresholdReport', () => {
	it('reports every meter, with the plan it was scored against', () => {
		const r = thresholdReport({}, { PLAN: 'free' });
		expect(r.plan).toBe('free');
		expect(r.readings).toHaveLength(THRESHOLDS.length);
		expect(r.hardCapCount).toBe(1);
	});

	it('marks everything unknown when nothing measures it, rather than healthy', () => {
		const r = thresholdReport({}, { PLAN: 'free' });
		expect(r.readings.every((x) => x.status === 'unknown')).toBe(true);
	});

	it('scores the meters it was given usage for', () => {
		const r = thresholdReport({ 'image-transforms': 20_000 }, { PLAN: 'free' });
		expect(r.readings.find((x) => x.threshold.id === 'image-transforms')?.status).toBe('over');
	});

	it('treats an absent plan as free', () => {
		expect(thresholdReport({}).plan).toBe('free');
	});
});

describe('a meter this site cannot count is not the same as one nobody wired', () => {
	it('names the REASON for worker-requests rather than saying "not yet"', () => {
		// "nothing measures this yet" invites someone to go and wire it, and what they would build
		// undercounts by exactly the traffic the edge cache absorbs -- a confident wrong number
		// about the meter that binds at 3M visits/month
		const wr = THRESHOLDS.find((t) => t.id === 'worker-requests')!;
		expect(wr.unmeasurable).toBeDefined();
		const reading = readMeter(wr, null, { PLAN: 'free' });
		expect(reading.status).toBe('unknown');
		expect(reading.message).toContain('edge cache');
		expect(reading.message).not.toBe('nothing measures this yet');
	});

	it('still says "not yet" for a meter that simply has no counter', () => {
		// the distinction only works if both cases survive; collapsing them either way loses it
		const wf = THRESHOLDS.find((t) => t.id === 'workflow-steps')!;
		expect(wf.unmeasurable).toBeUndefined();
		expect(readMeter(wf, null, { PLAN: 'free' }).message).toBe('nothing measures this yet');
	});

	it('never shows the reason once a real count arrives', () => {
		const wr = THRESHOLDS.find((t) => t.id === 'worker-requests')!;
		const reading = readMeter(wr, 50_000, { PLAN: 'free' });
		expect(reading.status).toBe('ok');
		expect(reading.message).not.toContain('edge cache');
	});

	it('scores the two meters that DO have counters now', () => {
		// do-requests and image-transforms were blank; a blank meter beside a measured one reads as
		// the healthy one, which is the failure this column exists to prevent
		const r = thresholdReport(
			{ 'do-requests': 90_000, 'image-transforms': 20_000 },
			{ PLAN: 'free' }
		);
		const byId = Object.fromEntries(r.readings.map((x) => [x.threshold.id, x]));
		expect(byId['do-requests']!.status).toBe('warn');
		expect(byId['image-transforms']!.status).toBe('over');
		// the hard cap says what "over" actually means, because it stops working rather than billing
		expect(byId['image-transforms']!.message).toContain('does not reset');
	});
});
