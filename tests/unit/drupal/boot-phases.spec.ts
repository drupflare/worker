import { describe, expect, it } from 'vitest';
import { BOOT_PHASES, bootPhaseFragment } from '../../../src/drupal/site-php';

/**
 * The per-phase boot instrument.
 *
 * It exists because ~850 ms survives a container cache HIT with nothing attributed inside it, and it
 * cannot be split from within: on the edge `microtime()` and `Date.now()` both read 0, so the only
 * clock that reports anything is `cpuTime` in `wrangler tail`, which meters an INVOCATION. A phase
 * therefore needs an invocation of its own.
 *
 * `tests/node/php-fragments.spec.ts` runs each of these through `php -l`; this file asserts what is
 * IN them.
 */

/**
 * The fragment with its comments removed.
 *
 * The first version of the negative assertions below matched the WORD `$kernel->boot()` anywhere in
 * the source and went red on a comment that merely mentioned it -- an instrument reporting a defect
 * that was not there, which is the same class of mistake as an instrument missing one. These
 * assertions are about what the fragment EXECUTES, so the comments come out first.
 */
function codeOnly(source: string): string {
	return source
		.split('\n')
		.filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
		.join('\n');
}

describe('the boot phases are cumulative, which is what makes the subtraction mean anything', () => {
	it('every phase includes the autoload that precedes it', () => {
		for (const phase of BOOT_PHASES) {
			expect(bootPhaseFragment(phase), phase).toContain(
				"require_once '/drupal/autoload.php'"
			);
		}
	});

	it('every phase from kernel-new onward constructs the kernel', () => {
		for (const phase of BOOT_PHASES.slice(BOOT_PHASES.indexOf('kernel-new'))) {
			expect(bootPhaseFragment(phase), phase).toContain('new \\Drupal\\Core\\DrupalKernel');
		}
	});

	it('the autoload phase stops before constructing a kernel', () => {
		const src = codeOnly(bootPhaseFragment('autoload'));
		expect(src).not.toContain('new \\Drupal\\Core\\DrupalKernel');
		expect(src).not.toContain('$kernel->boot()');
	});

	it('kernel-new stops before booting', () => {
		expect(codeOnly(bootPhaseFragment('kernel-new'))).not.toContain('$kernel->boot()');
	});
});

describe('the container branches measure the boot WITHOUT letting it happen', () => {
	it('container-read selects the row and never boots', () => {
		const src = codeOnly(bootPhaseFragment('container-read'));
		// selecting `data` rather than LENGTH(data) matters: the question is what carrying half a
		// megabyte across the host bridge costs, and LENGTH() would answer it with an integer
		expect(src).toContain('SELECT cid, data FROM cache_container');
		expect(src).toContain('containerBytes');
		// booting here would warm whatever the read touched and make kernel-boot look cheaper
		expect(src).not.toContain('$kernel->boot()');
		expect(src).not.toContain('unserialize');
	});

	it('container-unserialize adds only the unserialize, so the difference isolates it', () => {
		const src = codeOnly(bootPhaseFragment('container-unserialize'));
		expect(src).toContain('SELECT cid, data FROM cache_container');
		expect(src).toContain('unserialize($blob)');
		expect(src).not.toContain('$kernel->boot()');
	});

	it('kernel-boot does NOT pre-read the row, or it would measure the read twice', () => {
		const src = codeOnly(bootPhaseFragment('kernel-boot'));
		expect(src).toContain('$kernel->boot()');
		expect(src).not.toContain('FROM cache_container');
	});
});

describe('the later phases', () => {
	it('pre-handle boots and then pre-handles', () => {
		const src = codeOnly(bootPhaseFragment('pre-handle'));
		expect(src).toContain('$kernel->boot()');
		expect(src).toContain('$kernel->preHandle($request)');
		expect(src).not.toContain('cfw_serve');
	});

	it('render is the only phase that pulls in the serve helper', () => {
		const src = bootPhaseFragment('render');
		expect(src).toContain('cfw_serve');
		expect(src).toContain('renderBytes');
		for (const phase of BOOT_PHASES.filter((p) => p !== 'render')) {
			expect(bootPhaseFragment(phase), phase).not.toContain("cfw_serve('/')");
		}
	});

	it('reports whether the object was already booted, because a warm one measures nothing', () => {
		// the failure this guards: BOOT_KERNEL memoises into $GLOBALS['__pw_kernel'], so a phase run
		// against a warm object returns a small plausible number instead of the cost of the phase
		for (const phase of BOOT_PHASES) {
			expect(bootPhaseFragment(phase), phase).toContain('alreadyBooted');
		}
	});
});

describe('an unknown phase is refused rather than silently producing a fragment', () => {
	it('throws, naming the phase', () => {
		expect(() => bootPhaseFragment('kernel-bot' as never)).toThrow(/unknown boot phase/);
	});

	it('has no duplicate phase names, which would break the index arithmetic', () => {
		expect(new Set(BOOT_PHASES).size).toBe(BOOT_PHASES.length);
	});
});
