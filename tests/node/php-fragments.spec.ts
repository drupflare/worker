import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cronHookList, runCronHook, runCronQueue } from '../../src/drupal/cron-php';
import { CURL_FIX } from '../../src/drupal/curl-fix';
import { ICONV_FIX } from '../../src/drupal/iconv-fix';
import { MB_ASCII } from '../../src/drupal/mb-fix';
import { OPENSSL_FIX } from '../../src/drupal/openssl-fix';
import {
	abandonTransaction,
	BOOT_KERNEL,
	BOOT_PHASES,
	bootPhaseFragment,
	BOUNDARY_STATE,
	CAPABILITY_CHECK,
	createUser,
	DRIVER_LIVE_SUITE,
	drupalRequest,
	exportDatabase,
	firstRunConfig,
	GUZZLE_HANDLER_CHECK,
	invalidateTags,
	leakOutputBuffer,
	MB_CHECK,
	MIGRATE_DB,
	OPS_REGISTRY,
	PROBE_RUNTIME,
	renderPage,
	saveNode,
	WRITE_WORKLOADS,
	writeWorkload
} from '../../src/drupal/site-php';
import { SODIUM_FIX } from '../../src/drupal/sodium-fix';
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
	['GUZZLE_HANDLER_CHECK', GUZZLE_HANDLER_CHECK],
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
	// the static-state sweep's instruments; BOUNDARY_STATE carries a recursive closure and nested
	// reflection, which is exactly the shape a truncated raw block leaves still parseable
	['BOUNDARY_STATE', BOUNDARY_STATE],
	['abandonTransaction_scope', abandonTransaction('scope')],
	['abandonTransaction_global', abandonTransaction('global')],
	['leakOutputBuffer', leakOutputBuffer(2)],
	['createUser', createUser({ name: 'probe', pass: 'p', roles: ['content_editor'] })],
	// one per branch of the switch, since each arm is its own block of PHP and only the arm
	// that is emitted gets linted
	...WRITE_WORKLOADS.map(
		(op) => [`writeWorkload_${op}`, writeWorkload(op, { seq: 3, nid: 1 })] as [string, string]
	),
	['cronHookList', cronHookList()],
	['runCronHook', runCronHook('system')],
	['runCronQueue', runCronQueue('my_queue', 3)],
	// prefixed with the tag the way `src/site-do.ts` runs it, since it is a bare fragment. It is
	// worth linting where MB_FIX is not: MB_FIX's body is inside an eval(), so `php -l` sees a
	// string literal, whereas this one is plain PHP and a parse error in it is really caught here
	['ZLIB_FIX', `<?php ${ZLIB_FIX}`],
	// same reason as ZLIB_FIX: no eval(), so php -l sees the body. It carries a
	// backtick-free comment on purpose -- a backtick inside a String.raw block
	// truncates the template literal and this fragment hit that while being written
	['ICONV_FIX', `<?php ${ICONV_FIX}`],
	// same shape again: no eval(), so php -l reads the eight curl_* declarations and the
	// ~17 constants. It is the fragment that made CurlShim reachable at all
	['CURL_FIX', `<?php ${CURL_FIX}`],
	// openssl_sign takes its signature BY REFERENCE and openssl_verify returns a tri-state,
	// so a signature typo here is a silently wrong verdict rather than a parse error
	['OPENSSL_FIX', `<?php ${OPENSSL_FIX}`],
	// same shape again, and it is the only fragment declaring a CLASS conditionally
	// (SodiumException), which php -l checks here and nothing else would
	['SODIUM_FIX', `<?php ${SODIUM_FIX}`],
	// the half of MB_FIX that is NOT inside its eval(), and the only half php -l can
	// read. Both bodies carry regexes with backslash escapes, which is exactly the
	// shape that survives a botched unescaping as valid JS and broken PHP
	['MB_ASCII', `<?php ${MB_ASCII}`]
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

/**
 * A clock that reads 0 does not only misreport, it hangs.
 *
 * `microtime()` returns 0 inside this interpreter, and the expensive lesson was not a wrong figure
 * -- it was `DatabaseLockBackend`, which stores `microtime(TRUE) + $timeout` as an expiry and tests
 * it against `microtime(TRUE)`. With the clock at 0 no lock ever expires, `wait()` polls with
 * `usleep()`, there are no threads to yield to, and 30 seconds are billed as CPU. `CfwLockBackend`
 * in the `drupflare` sibling replaces it for exactly that reason.
 *
 * So the rule this guard enforces is narrow and mechanical: a fragment may READ the clock to
 * report elapsed time, and may not DERIVE A DEADLINE from it. The two are distinguishable in the
 * source -- a deadline adds to the clock, or compares against it in a loop -- which is what makes
 * this a gate test rather than a review checklist. An audit that lives in someone's head is the
 * thing that let the lock defect ship.
 */
describe('no PHP fragment derives a deadline from a clock that reads 0', () => {
	const dir = join(ROOT, 'src/drupal');
	const modules = readdirSync(dir).filter((f) => f.endsWith('.ts'));

	/** a deadline: the clock with something added to it, or the clock inside a loop condition */
	const DEADLINE = [
		/microtime\s*\([^)]*\)\s*[*/]?\s*[\d.]*\s*\+/,
		/\+\s*[\d.]+\s*[*/]?\s*[\d.]*\s*;?\s*\/\/\s*deadline/i,
		/while\s*\([^)]*microtime/,
		/usleep\s*\(/,
		/set_time_limit\s*\(/
	];

	/**
	 * Reading the clock to REPORT is fine and every fragment does it. Listed as shapes rather than
	 * as file names, so a new fragment inherits the allowance without being added here.
	 */
	const MEASUREMENT = [
		'$clock = function () { return microtime(true) * 1000; };',
		'$t0 = microtime(true) * 1000;',
		'microtime(true) * 1000 - $t0'
	];

	it('found the modules to scan, so this cannot pass by scanning nothing', () => {
		expect(modules.length).toBeGreaterThanOrEqual(5);
	});

	it.each(modules)('%s', (file) => {
		const source = readFileSync(join(dir, file), 'utf8');
		const offenders: string[] = [];
		for (const [index, line] of source.split('\n').entries()) {
			// a comment ABOUT the hazard is not the hazard, and this file is full of them
			const code = line.replace(/^\s*(\/\/|\*|#).*$/, '');
			if (MEASUREMENT.some((allowed) => code.includes(allowed))) continue;
			if (DEADLINE.some((re) => re.test(code)))
				offenders.push(`${file}:${index + 1} ${code.trim()}`);
		}
		expect(offenders, offenders.join('\n')).toEqual([]);
	});

	it('the detector fires, so a green result means something', () => {
		const fire = (code: string) => DEADLINE.some((re) => re.test(code));
		// the exact shape DatabaseLockBackend uses, which is what this exists to keep out
		expect(fire('$expire = microtime(TRUE) + $timeout;')).toBe(true);
		expect(fire('while (microtime(true) < $deadline) { }')).toBe(true);
		expect(fire('usleep(25000);')).toBe(true);
		expect(fire('set_time_limit(30);')).toBe(true);
		// and the reporting shapes every fragment uses must stay silent
		expect(fire('$clock = function () { return microtime(true) * 1000; };')).toBe(false);
		expect(fire("$out['renderMs'] = round($clock() - $t0, 2);")).toBe(false);
	});
});
