import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cronHookList, runCronHook, runCronQueue } from '../../src/drupal/cron-php';
import {
	BOOT_KERNEL,
	BOOT_PHASES,
	bootPhaseFragment,
	CAPABILITY_CHECK,
	DRIVER_LIVE_SUITE,
	drupalRequest,
	exportDatabase,
	firstRunConfig,
	invalidateTags,
	MB_CHECK,
	MIGRATE_DB,
	OPS_REGISTRY,
	PROBE_RUNTIME,
	renderPage,
	saveNode
} from '../../src/drupal/site-php';
import { UPDB_VERIFY, updbPlan, updbUnit } from '../../src/drupal/updb-php';
import { ZLIB_FIX } from '../../src/drupal/zlib-fix';

/** repo root, so the text guard below reads the real sources rather than a copy */
const ROOT = new URL('../..', import.meta.url).pathname;

/**
 * Every PHP fragment this project generates, run through `php -l`.
 *
 * These three modules are mostly `String.raw` blocks holding PHP source, and the failure mode is
 * specific: an edit that breaks the PHP without breaking the JavaScript. It has happened twice
 * here already, both times a backtick inside a PHP comment terminating the template literal
 * early -- once in `site-php` and once in `updb-php`. Nothing in the workers lane can catch that,
 * because a truncated fragment is still a perfectly good string.
 *
 * `php -l` is the cheapest real check that exists for it, so it lives in the `node` project where
 * a PHP binary is reachable. It is a syntax gate, not a behaviour gate -- it proves the fragment
 * is parseable PHP, not that it does the right thing.
 *
 * The `renderPage` string case earns its place twice over: `destruct` is
 * `boolean | string` (false, true, or a comma-separated service-id allowlist to bisect with), and
 * that branch was annotated `boolean` during the TypeScript conversion, which made the string
 * path `never` and meant it had never been checked by anything at all.
 */

const php = (() => {
	try {
		execFileSync('php', ['--version'], { stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
})();

const dir = php ? mkdtempSync(join(tmpdir(), 'cfw-php-lint-')) : '';

/** `php -l` on a fragment, returning its complaint rather than throwing */
function lint(name: string, source: string): string {
	const file = join(dir, `${name}.php`);
	writeFileSync(file, source);
	try {
		execFileSync('php', ['-l', file], { stdio: 'pipe' });
		return '';
	} catch (e) {
		const err = e as { stdout?: Buffer; stderr?: Buffer };
		return String(err.stdout ?? '') + String(err.stderr ?? '');
	}
}

const FRAGMENTS: Array<[string, string]> = [
	['PROBE_RUNTIME', PROBE_RUNTIME],
	['MB_CHECK', MB_CHECK],
	['MIGRATE_DB', MIGRATE_DB],
	['DRIVER_LIVE_SUITE', DRIVER_LIVE_SUITE],
	['CAPABILITY_CHECK', CAPABILITY_CHECK],
	['UPDB_VERIFY', UPDB_VERIFY],
	['drupalRequest', drupalRequest('/', 2, ['page'], true)],
	['renderPage_false', renderPage('/', ['page'], false)],
	['renderPage_true', renderPage('/', ['page'], true)],
	// the branch that was `never` until the conversion widened the type
	['renderPage_allowlist', renderPage('/', ['page'], 'some_service,other_service')],
	['invalidateTags', invalidateTags(['rendered', 'node:1'])],
	['exportDatabase', exportDatabase(5)],
	['firstRunConfig', firstRunConfig({ siteName: 'S', adminName: 'a', timezone: 'UTC' })],
	['saveNode', saveNode({ type: 'page', title: 'T', body: 'B' })],
	['updbPlan', updbPlan(true)],
	[
		'updbUnit_fn',
		updbUnit({ seq: 1, kind: 'update', fn: 'foo_update_1', module: 'foo', number: 1 })
	],
	['updbUnit_step', updbUnit({ seq: 2, kind: 'flush', step: 'router' })],
	// nulls are the documented absent-value for these fields, not undefined
	['updbUnit_nulls', updbUnit({ seq: 3, kind: 'x', fn: null, module: null, step: null })],
	// BOOT_KERNEL was absent from this list while being the fragment the whole snapshot path runs
	['BOOT_KERNEL', BOOT_KERNEL],
	['OPS_REGISTRY', OPS_REGISTRY],
	// one entry per boot phase; a broken fragment here would only surface as a parse error on a
	// deployed worker, which costs a deploy to discover
	...BOOT_PHASES.map(
		(phase) => [`bootPhase_${phase}`, bootPhaseFragment(phase)] as [string, string]
	),
	['cronHookList', cronHookList()],
	['runCronHook', runCronHook('system')],
	['runCronQueue', runCronQueue('my_queue', 3)],
	// prefixed with the tag the way `src/site-do.ts` runs it, since it is a bare fragment. It is
	// worth linting where MB_FIX is not: MB_FIX's body is inside an eval(), so `php -l` sees a
	// string literal, whereas this one is plain PHP and a parse error in it is really caught here
	['ZLIB_FIX', `<?php ${ZLIB_FIX}`]
];

// A MISSING PHP BINARY MUST NOT SILENTLY PASS THIS FILE. A local developer without php should not
// see red, but a CI run that skipped the only syntax gate for ~30 PHP fragments is
// indistinguishable from one that passed -- the same rule this project already wrote down about
// `check:sync` and then broke twice.
if (!php && process.env.CI) {
	throw new Error(
		'php is not on PATH and CI is set: the PHP fragment syntax gate would silently skip. ' +
			'Install php in the workflow or narrow deliberately what CI claims to cover.'
	);
}

describe.skipIf(!php)('every generated PHP fragment is parseable PHP', () => {
	it.each(FRAGMENTS)('%s', (name, source) => {
		expect(lint(name, source)).toBe('');
	});

	it('opens each fragment with a PHP tag, so `php -l` is really parsing PHP', () => {
		// php -l on a file with no <?php tag reports no errors, because it is valid inline HTML;
		// without this the suite above could pass on 21 empty strings
		for (const [name, source] of FRAGMENTS) {
			expect(source.length, name).toBeGreaterThan(50);
			expect(source.trimStart().startsWith('<?php'), name).toBe(true);
		}
	});

	it('catches a broken fragment, so the gate is not vacuous', () => {
		// the negative control: this is what a backtick-truncated String.raw block looks like
		expect(lint('control', '<?php function broken( {')).not.toBe('');
	});
});

describe('no backtick may appear inside a String.raw PHP block', () => {
	/**
	 * The guard `php -l` cannot be.
	 *
	 * A backtick in a PHP comment ends the template literal early, and `php -l` does NOT catch it:
	 * the TRUNCATED fragment is usually still valid PHP, so the syntax gate above passes and the
	 * defect ships. It has happened four times -- `site-php`, `updb-php`, and twice in one session
	 * in `files-php` and `enable-php`, the second written minutes after I put a warning comment
	 * about the trap into the first.
	 *
	 * The fourth broke the JAVASCRIPT rather than only the PHP, so `tsc` caught it -- luck, not
	 * design, since it depends on whether the remaining text happens to parse as TypeScript.
	 *
	 * This checks COMMENT LINES ONLY, and `backtickedComments()` below records why the two wider
	 * rules I tried first were both wrong. It is a lint on writing habit rather than a structural
	 * proof, which is the strongest thing available without parsing TypeScript.
	 */
	const SOURCES = [
		'src/drupal/site-php.ts',
		'src/drupal/cron-php.ts',
		'src/drupal/updb-php.ts',
		'src/drupal/files-php.ts',
		'src/drupal/enable-php.ts',
		'src/drupal/mb-fix.ts'
	];

	/**
	 * Comment lines carrying a backtick.
	 *
	 * The rule is narrow, after two wider ones were wrong. The first version tracked
	 * "inside a raw block" with a flag and flagged `site-php.ts:704`, which is `? String.raw\`` --
	 * a LEGITIMATE nested literal inside a `${...}` interpolation. My second keyed on the
	 * backtick's position and flagged every block opening, because the opening delimiter is
	 * `String.raw\`<?php` and text does follow it. It also flagged an ordinary TS template literal
	 * (`RangeError(\`unknown boot phase: ${phase}\`)`), which is correct code.
	 *
	 * That is the real lesson: a stray backtick and a real delimiter are textually identical, so no
	 * position rule can separate them without parsing TypeScript. What CAN be separated is the
	 * place the defect actually occurs. All four occurrences -- `site-php`, `updb-php`, and twice in
	 * one session in `files-php` and `enable-php` -- were a backticked identifier inside a `//`
	 * comment written in PHP style. So the check is exactly that, and it is worth having because a
	 * comment never needs a backtick: single quotes read the same and cannot end a literal.
	 *
	 * A TS-level `//` comment with a backtick would be a false positive here. There are none today,
	 * and the fix if one appears is to quote it rather than to loosen this.
	 */
	function backtickedComments(source: string): string[] {
		const offences: string[] = [];
		for (const [index, line] of source.split('\n').entries()) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('//') && !trimmed.startsWith('#')) continue;
			if (trimmed.includes('`')) offences.push(`${index + 1}: ${trimmed}`);
		}
		return offences;
	}

	it.each(SOURCES)('%s has no backticked comment', (relative) => {
		const source = readFileSync(join(ROOT, relative), 'utf8');
		expect(backtickedComments(source)).toEqual([]);
	});

	it('the detector actually fires, so a green result means something', () => {
		// without this, the six assertions above would pass on any input -- including a detector
		// that always returns []. Which is not hypothetical here: two earlier versions of this
		// check were wrong in opposite directions, one silent and one flagging correct code.
		const backtick = String.fromCharCode(96);

		// the shape that shipped four times
		expect(backtickedComments(`// see ${backtick}update${backtick} for why`)).toHaveLength(1);
		expect(
			backtickedComments(`  # php hash comment with ${backtick}x${backtick}`)
		).toHaveLength(1);

		// every legal shape must stay silent, or the guard gets deleted for crying wolf
		expect(backtickedComments(`/** uses ${backtick}Foo${backtick} */`)).toEqual([]);
		expect(backtickedComments(` * a doc line with ${backtick}Bar${backtick}`)).toEqual([]);
		expect(backtickedComments(`\t\t? String.raw${backtick}`)).toEqual([]);
		expect(backtickedComments(`export const A = String.raw${backtick}<?php`)).toEqual([]);
		// an ordinary TS template literal, which version two of this check wrongly flagged
		expect(
			backtickedComments(`throw new RangeError(${backtick}bad \${x}${backtick});`)
		).toEqual([]);
		expect(backtickedComments('// a plain comment with no backtick')).toEqual([]);
	});
});

describe('every PHP-carrying module still parses as TypeScript', () => {
	const dir = join(ROOT, 'src/drupal');
	const modules = readdirSync(dir)
		.filter((f) => f.endsWith('.ts'))
		.filter((f) => readFileSync(join(dir, f), 'utf8').includes('String.raw'));

	it('found the modules to check, so this cannot pass by checking nothing', () => {
		expect(modules.length).toBeGreaterThanOrEqual(5);
	});

	it.each(modules)('%s imports', async (file) => {
		const mod = await import(`../../src/drupal/${file}`);
		expect(Object.keys(mod).length).toBeGreaterThan(0);
	});
});
