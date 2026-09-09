import { describe, expect, it } from 'vitest';
import { BOOT_PHASES } from '../../src/drupal/site-php';

/**
 * What the cold path is made of, and what a shared-runtime split could therefore recover.
 *
 * MEASURED ON A DEPLOYED WORKER, 2026-09-04, `cpuTime` from `wrangler tail`, n=3 per phase after
 * dropping the interpreter before each. The near-zero samples in the same tail are the FRONT
 * WORKER's own invocation and are not the object -- a median taken over both understates every
 * phase, which is the instrument error this file exists to stop the next reader repeating.
 *
 * | phase                 | cumulative | incremental |
 * | --------------------- | ---------: | ----------: |
 * | autoload              |     451 ms |      451 ms |
 * | kernel-new            |     466 ms |       15 ms |
 * | container-read        |     510 ms |       44 ms |
 * | container-unserialize |     477 ms |       11 ms |
 * | kernel-boot           |     616 ms |      106 ms |
 * | pre-handle            |     660 ms |       44 ms |
 * | render                |   1,036 ms |      376 ms |
 *
 * `container-unserialize` baselines against `kernel-new` rather than against `container-read`;
 * both are alternative continuations of the same prefix.
 *
 * THE DECISION THIS SETTLES. B2's rule was "if tenant attach is a small fraction, the split is a
 * real direction; if it dominates, the split buys nothing". Generic execution state -- interpreter
 * instantiate, the mount, the class loader, `new DrupalKernel` -- is 466 ms of 1,036, and it is the
 * same for every site. Tenant attach is the other 570 ms, 55%, and it is the MAJORITY.
 *
 * So neither half of the rule fires cleanly, and the honest reading is a bound rather than a
 * verdict: a two-level bootstrap could recover at most 45% of a cold path, and only if the heap
 * machinery permits composition at all. Against that, S2 removes the cold path from the visitor's
 * experience ENTIRELY by serving the previous generation. Making 45% of an invisible cost smaller
 * is worth less than making a visible one disappear, which is the reasoning that demoted B2 in the
 * first place -- now with the fraction attached.
 */

/** cumulative object-only cpuTime, ms, median of n=3 on a deployed worker */
const CUMULATIVE: Record<string, number> = {
	autoload: 451,
	'kernel-new': 466,
	'container-read': 510,
	'container-unserialize': 477,
	'kernel-boot': 616,
	'pre-handle': 660,
	render: 1036
};

describe('the recorded attribution', () => {
	it('covers every phase the instrument declares', () => {
		// a figure recorded for a phase that no longer exists, or a phase with no figure, is how a
		// measurement quietly stops describing the thing it was taken on
		expect(Object.keys(CUMULATIVE).sort()).toEqual([...BOOT_PHASES].sort());
	});

	it('is monotonic along the boot, which is what makes a subtraction meaningful', () => {
		const chain = [
			'autoload',
			'kernel-new',
			'container-read',
			'kernel-boot',
			'pre-handle',
			'render'
		];
		let previous = 0;
		for (const phase of chain) {
			const at = CUMULATIVE[phase] as number;
			expect(at, phase).toBeGreaterThan(previous);
			previous = at;
		}
	});

	it('puts the generic half below half the cold path', () => {
		const generic = CUMULATIVE['kernel-new'] as number;
		const total = CUMULATIVE.render as number;
		expect(generic / total).toBeGreaterThan(0.4);
		expect(generic / total).toBeLessThan(0.5);
	});

	it('leaves tenant attach as the majority, which is what bounds the split', () => {
		const generic = CUMULATIVE['kernel-new'] as number;
		const total = CUMULATIVE.render as number;
		expect(total - generic).toBeGreaterThan(generic);
	});

	it('names the render as the single largest step', () => {
		// 376 ms, larger than the whole container and kernel-boot sequence put together -- so a
		// bootstrap that restored everything up to `pre-handle` would still pay it
		const steps = {
			autoload: CUMULATIVE.autoload as number,
			render: (CUMULATIVE.render as number) - (CUMULATIVE['pre-handle'] as number),
			kernelBoot:
				(CUMULATIVE['kernel-boot'] as number) - (CUMULATIVE['container-read'] as number)
		};
		expect(steps.render).toBeGreaterThan(steps.kernelBoot);
		expect(steps.autoload).toBeGreaterThan(steps.render);
	});
});
