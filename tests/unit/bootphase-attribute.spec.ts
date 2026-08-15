import { describe, expect, it } from 'vitest';
import {
	attribute,
	median,
	parseTag,
	parseTsv,
	repeatSlope,
	summarise
} from '../../scripts/measure/bootphase-attribute';

/**
 * Checklist 3.3's arithmetic, which has two ways of being silently wrong.
 *
 * The phases are CUMULATIVE, so a phase cost is a difference of two absolutes -- and two of the
 * seven are BRANCHES rather than steps. `container-read` and `container-unserialize` run off
 * `kernel-new` and stop before `$kernel->boot()`, so subtracting each phase from the one printed
 * above it would charge the container read to the kernel boot and leave the kernel boot with no
 * cost at all. Every column still adds up when that happens, which is why it needs a test.
 *
 * The second failure mode is the tag parser: five of the eight phase names contain a dash, so a
 * split on the first dash returns `kernel` for `kernel-boot` and drops four phases on the floor.
 */

const SAMPLE_TSV = `
p1-boot-only-s0	500
p1-boot-only-s1	520
p1-boot-only-s2	510
p1-autoload-s0	600
p1-autoload-s1	620
p1-autoload-s2	610
p1-kernel-new-s0	700
p1-kernel-new-s1	710
p1-kernel-new-s2	690
p1-container-read-s0	760
p1-container-read-s1	740
p1-container-read-s2	750
p1-container-unserialize-s0	900
p1-container-unserialize-s1	910
p1-container-unserialize-s2	890
p1-kernel-boot-s0	1200
p1-kernel-boot-s1	1210
p1-kernel-boot-s2	1190
p1-pre-handle-s0	1300
p1-pre-handle-s1	1310
p1-pre-handle-s2	1290
p1-render-s0	2000
p1-render-s1	2010
p1-render-s2	1990
`;

describe('parseTag', () => {
	it('keeps the dash inside a phase name', () => {
		// the whole point: a first-dash split would call this phase `kernel`
		expect(parseTag('p1-kernel-boot-s0')).toEqual({ phase: 'kernel-boot', sample: 0 });
		expect(parseTag('p1-container-unserialize-s12')).toEqual({
			phase: 'container-unserialize',
			sample: 12
		});
		expect(parseTag('p1-boot-only-s3')).toEqual({ phase: 'boot-only', sample: 3 });
	});

	it('handles the two dash-free phase names too', () => {
		expect(parseTag('p1-autoload-s0')).toEqual({ phase: 'autoload', sample: 0 });
		expect(parseTag('p1-render-s9')).toEqual({ phase: 'render', sample: 9 });
	});

	it('returns null for a tag that is not from the driver', () => {
		expect(parseTag('nonsense')).toBeNull();
		expect(parseTag('p1-render-sX')).toBeNull();
	});
});

describe('parseTsv', () => {
	it('reads one sample per line and ignores comments and blanks', () => {
		const rows = parseTsv(SAMPLE_TSV);
		expect(rows).toHaveLength(24);
		expect(parseTsv('# a comment\n\n')).toHaveLength(0);
	});

	it('takes the LAST whitespace-separated field as cpuMs', () => {
		// the observability console emits tab-separated pairs; a space-padded paste must parse the
		// same, or a run gets silently dropped rather than rejected
		expect(parseTsv('p1-render-s0     1234')).toEqual([
			{ phase: 'render', sample: 0, cpuMs: 1234 }
		]);
	});

	it('drops a line whose cpu column is not a number rather than reading NaN', () => {
		expect(parseTsv('p1-render-s0\tn/a')).toHaveLength(0);
	});
});

describe('median', () => {
	it('is the middle value for odd counts and the mean of the middle two for even', () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 2, 3])).toBe(2.5);
	});
});

describe('summarise', () => {
	it('reports n, median, min and max per phase in reading order', () => {
		const stats = summarise(parseTsv(SAMPLE_TSV));
		expect(stats.map((s) => s.phase)).toEqual([
			'boot-only',
			'autoload',
			'kernel-new',
			'container-read',
			'container-unserialize',
			'kernel-boot',
			'pre-handle',
			'render'
		]);
		const kb = stats.find((s) => s.phase === 'kernel-boot');
		expect(kb).toMatchObject({ n: 3, median: 1200, min: 1190, max: 1210 });
	});

	it('omits a phase with no samples instead of inventing a zero', () => {
		const stats = summarise(parseTsv('p1-render-s0\t2000'));
		expect(stats).toHaveLength(1);
		expect(stats[0]?.phase).toBe('render');
	});

	it('throws on a phase name the subtraction map does not know', () => {
		expect(() => summarise([{ phase: 'made-up', sample: 0, cpuMs: 1 }])).toThrow(
			/unknown phase/
		);
	});
});

describe('attribute', () => {
	const rows = attribute(summarise(parseTsv(SAMPLE_TSV)));
	const byPhase = new Map(rows.map((r) => [r.phase, r]));

	it('leaves boot-only as the floor with no baseline', () => {
		expect(byPhase.get('boot-only')).toMatchObject({ baseline: null, costMs: null });
	});

	it('walks the serving path in order', () => {
		expect(byPhase.get('autoload')).toMatchObject({ baseline: 'boot-only', costMs: 100 });
		expect(byPhase.get('kernel-new')).toMatchObject({ baseline: 'autoload', costMs: 90 });
		expect(byPhase.get('kernel-boot')).toMatchObject({ baseline: 'kernel-new', costMs: 500 });
		expect(byPhase.get('pre-handle')).toMatchObject({ baseline: 'kernel-boot', costMs: 100 });
		expect(byPhase.get('render')).toMatchObject({ baseline: 'pre-handle', costMs: 700 });
	});

	it('baselines container-read against kernel-new, NOT against the phase above it', () => {
		// the branch property: the read never reaches $kernel->boot(), so its baseline is the
		// constructed kernel and nothing further along
		expect(byPhase.get('container-read')).toMatchObject({
			baseline: 'kernel-new',
			baselineMedian: 700,
			costMs: 50
		});
	});

	it('isolates unserialize from the read it is built on', () => {
		// container-unserialize is cumulative over container-read, so its baseline is the read and
		// the difference is the parse alone
		expect(byPhase.get('container-unserialize')).toMatchObject({
			baseline: 'container-read',
			baselineMedian: 750,
			costMs: 150
		});
	});

	it('does not let a container branch steal the kernel boot cost', () => {
		// the regression test for the wrong subtraction: charging kernel-boot against
		// container-unserialize would report 290 ms instead of 500 ms and hide 210 ms of real boot
		const kb = byPhase.get('kernel-boot');
		expect(kb?.baseline).not.toBe('container-unserialize');
		expect(kb?.costMs).toBe(500);
	});

	it('reports a min-based cost alongside the median-based one', () => {
		// the platform warm-up is one-sided, so min-min is the noise-stripped marginal cost. Two
		// estimators that disagree in SIGN mean the phase is below the noise floor
		expect(byPhase.get('render')).toMatchObject({
			cumulativeMin: 1990,
			baselineMin: 1290,
			costMinMs: 700
		});
		expect(byPhase.get('kernel-boot')?.costMinMs).toBe(500);
	});

	it('is robust to the input arriving out of order', () => {
		const shuffled = parseTsv(SAMPLE_TSV.split('\n').reverse().join('\n'));
		const again = new Map(attribute(summarise(shuffled)).map((r) => [r.phase, r.costMs]));
		expect(again.get('kernel-boot')).toBe(500);
		expect(again.get('render')).toBe(700);
	});
});

describe('repeatSlope', () => {
	const TSV = `
p4-repeat1-s0	1000
p4-repeat1-s1	1100
p4-repeat1-s2	1200
p4-repeat10-s0	2800
p4-repeat10-s1	2900
p4-repeat10-s2	3000
`;

	it('divides by the SPAN between the two counts, not by the high count', () => {
		// 1 -> 10 is nine EXTRA renders, so the slope is /9. Dividing by 10 understates a warm render
		// by 10% and by 1 overstates it ninefold
		const s = repeatSlope(parseTsv(TSV));
		expect(s).toMatchObject({ lowN: 1, highN: 10, lowMedian: 1100, highMedian: 2900 });
		expect(s.perRenderMedian).toBe(200);
		expect(s.perRenderMin).toBe(200);
	});

	it('uses the widest pair when more than two counts are present', () => {
		const s = repeatSlope(parseTsv(TSV + 'p4-repeat3-s0\t1400\n'));
		expect(s.lowN).toBe(1);
		expect(s.highN).toBe(10);
	});

	it('refuses a single repeat count rather than dividing by zero', () => {
		expect(() => repeatSlope(parseTsv('p4-repeat1-s0\t1000'))).toThrow(/two distinct/);
	});

	it('ignores boot-phase tags mixed into the same file', () => {
		const s = repeatSlope(parseTsv(TSV + 'p2-render-s0\t9999\n'));
		expect(s.perRenderMedian).toBe(200);
	});
});
