import { describe, expect, it } from 'vitest';
import { CASES, report, type Arm } from '../../scripts/measure/abi-speed.js';

/** the reporting arithmetic; taking the baseline by NAME makes the self-control unable to fail */

const summary = (median: number) => ({
	n: 25,
	min: median * 0.98,
	max: median * 1.05,
	median,
	spread: median * 0.07
});

function arm(label: string, factor: number, overrides: Record<string, number> = {}): Arm {
	return {
		abi: 'wasm32',
		label,
		wasm: `.interp/${label}.wasm`,
		glue: `.interp/${label}.mjs`,
		step: 0.08,
		bytes: 12_218_393,
		intSize: 4,
		version: '8.5.2',
		compile: summary(12 * factor),
		boot: summary(11 * factor),
		cases: Object.fromEntries(
			CASES.map((c) => [c.name, summary(100 * (overrides[c.name] ?? factor))])
		)
	};
}

describe('the ABI speed report', () => {
	it('takes the FIRST arm as the baseline, not the one named wasm32', () => {
		const out = report([arm('long64', 1), arm('wasm32', 2)]);
		// the second arm is twice as slow as the first, so the ratio column reads 2x
		expect(out).toContain('| wasm32 / long64 |');
		expect(out).toContain('**2.000x**');
	});

	it('reports 1.000x for an arm against an identical arm', () => {
		const out = report([arm('wasm32#1', 1), arm('wasm32#2', 1)]);
		expect(out).toContain('**1.000x**');
	});

	it('blends by geometric mean, so one long case cannot carry the headline', () => {
		// one case 4x slower: an average of medians would be dragged by whichever case is longest
		const slowOne = arm('long64', 1, { sort: 4 });
		const out = report([arm('wasm32', 1), slowOne]);
		const expected = Math.exp(Math.log(4) / CASES.length);
		expect(out).toContain(`**${expected.toFixed(3)}x**`);
		expect(out).toContain('| sort |');
		expect(out).toContain('4.000x');
	});

	it('names every case and its mechanism, so no ratio is printed bare', () => {
		const out = report([arm('wasm32', 1), arm('long64', 1)]);
		for (const c of CASES) {
			expect(out).toContain(`| ${c.name} | ${c.probes} |`);
		}
		expect(out).toContain('| compile |');
		expect(out).toContain('| boot |');
	});

	it('carries n and the engine, so a figure cannot be quoted without its provenance', () => {
		const out = report([arm('wasm32', 1), arm('long64', 1)]);
		expect(out).toMatch(/n=25 interleaved rounds/);
		expect(out).toMatch(/median with \(min-max\)/);
		expect(out).toMatch(/not an edge cpuTime/);
	});
});

describe('the cases themselves', () => {
	it('masks every integer accumulator, so the 4-byte arm cannot fall into float', () => {
		for (const c of CASES.filter((x) => /\$s \+/.test(x.php) || /\$s =/.test(x.php))) {
			if (c.name === 'floatmath' || c.name === 'strings' || c.name === 'preg') continue;
			expect(c.php + (c.setup ?? ''), c.name).toContain('0x3fffffff');
		}
	});

	it('declares functions and classes in setup rather than in the timed body', () => {
		for (const c of CASES) {
			expect(c.php, c.name).not.toMatch(/\b(function|class)\s+\w/);
		}
	});
});
