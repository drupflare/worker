import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { settingsOverride } from '../../src/do/settings';
import { cronHookList, runCronHook, runCronQueue } from '../../src/drupal/cron-php';
import { CURL_FIX } from '../../src/drupal/curl-fix';
import { FIBER_SHIM } from '../../src/drupal/fiber-shim';
import { ICONV_FIX } from '../../src/drupal/iconv-fix';
import { MB_ASCII, MB_FIX, MB_SANITIZE } from '../../src/drupal/mb-fix';
import { OPENSSL_FIX } from '../../src/drupal/openssl-fix';
import {
	abandonTransaction,
	BOOT_KERNEL,
	BOOT_PHASES,
	bootPhaseFragment,
	BOUNDARY_STATE,
	CAPABILITY_CHECK,
	claimWarmRun,
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
	packConsistencyRun,
	PROBE_RUNTIME,
	renderPage,
	saveNode,
	WRITE_WORKLOADS,
	writeWorkload
} from '../../src/drupal/site-php';
import { SODIUM_FIX } from '../../src/drupal/sodium-fix';
import { STANDIN_FIX } from '../../src/drupal/standin-fix';
import { tcpLive } from '../../src/drupal/tcp-php';
import { UNICODE_TABLES } from '../../src/drupal/unicode-tables';
import { UPDB_VERIFY, updbPlan, updbUnit } from '../../src/drupal/updb-php';
import { XMLWRITER_FIX } from '../../src/drupal/xmlwriter-fix';
import { ZLIB_FIX } from '../../src/drupal/zlib-fix';
import {
	DIAG_BRIDGE_PHP,
	DIAG_EXEC_COUNTERS_PHP,
	DIAG_EXTENSIONS_PHP,
	DIAG_NATIVE_FETCH_PHP
} from '../../src/site/generated/assets';
import { hoistUses, phpRender, phpScript, phpWhen } from '../../src/util/php';

/** repo root, so the file guards below read the real sources rather than a copy */
const ROOT = new URL('../..', import.meta.url).pathname;

/**
 * Every PHP fragment this project generates, run through `php -l`.
 *
 * The PHP lives in `src/site/php/**` and reaches the modules through `src/site/generated/assets.ts`,
 * so two things are linted: each file on its own, and each composition the modules build from them.
 * A file can parse while a composition does not (a token left in a statement position, two shims
 * declaring one name), and the reverse.
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
	['firstRunConfig migrated', firstRunConfig({ migrated: true })],
	['packConsistencyRun', packConsistencyRun()],
	['claimWarmRun', claimWarmRun()],
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
	// tcp-php was absent from this list for its whole life, so the one fragment that drives the
	// TCP tier through the module's own caller had never been linted at all
	['tcpLive_redis', tcpLive({ protocol: 'redis', args: ['GET', 'k'] })],
	['tcpLive_syslog', tcpLive({ protocol: 'syslog', message: 'a record' })],
	['tcpLive_defaults', tcpLive({ protocol: 'redis' })],
	['OPS_REGISTRY', OPS_REGISTRY],
	// one entry per boot phase; a broken fragment here would only surface as a parse error on a
	// deployed worker, which costs a deploy to discover
	...BOOT_PHASES.map(
		(phase) => [`bootPhase_${phase}`, bootPhaseFragment(phase)] as [string, string]
	),
	// the static-state sweep's instruments; BOUNDARY_STATE carries a recursive closure and nested
	// reflection
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
	// prefixed with the tag the way `src/site-do.ts` runs it, since it is a bare fragment
	['ZLIB_FIX', `<?php ${ZLIB_FIX}`],
	['ICONV_FIX', `<?php ${ICONV_FIX}`],
	// php -l reads the eight curl_* declarations and the ~17 constants. It is the fragment that
	// made CurlShim reachable at all
	['CURL_FIX', `<?php ${CURL_FIX}`],
	// openssl_sign takes its signature BY REFERENCE and openssl_verify returns a tri-state,
	// so a signature typo here is a silently wrong verdict rather than a parse error
	['OPENSSL_FIX', `<?php ${OPENSSL_FIX}`],
	// same shape again, and it is the only fragment declaring a CLASS conditionally
	// (SodiumException), which php -l checks here and nothing else would
	['SODIUM_FIX', `<?php ${SODIUM_FIX}`],
	// the biggest conditional class here; `xmlwriter-parity.spec.ts` proves it matches libxml and
	// this proves it parses
	['XMLWRITER_FIX', `<?php ${XMLWRITER_FIX}`],
	['STANDIN_FIX', `<?php ${STANDIN_FIX}`],
	// both carry regexes with backslash escapes, the shape that survives a botched unescaping
	['MB_ASCII', `<?php ${MB_ASCII}`],
	['MB_SANITIZE', `<?php ${MB_SANITIZE}`],
	// the wrappers declare every mb_* name, so this is the only way to lint them on a build that
	// carries mbstring: the `if` the composition wraps them in keeps the declarations conditional
	['MB_FIX', `<?php ${MB_FIX}`],
	// a table emitted by a script is exactly where a stray quote in a key lands, and php -l is what
	// catches it
	['UNICODE_TABLES', `<?php ${UNICODE_TABLES}`],
	// the text appended to settings.php, with every token filled; settings.php supplies the
	// variables it reads, so php -l is all that can run on it
	[
		'settingsOverride',
		`<?php${settingsOverride({
			origin: JSON.stringify('https://x.dev'),
			argon2: true,
			memoryBins: "['dynamic_page_cache']",
			memoryItems: 500,
			lane: 3,
			lanes: 8,
			packageAutoload: "$class_loader->addPsr4('Pkg\\\\', $app_root . '/libraries/pkg/');",
			deploymentEnv: "$settings['DRUPAL_ENV_X'] = 'a';"
		})}`
	],
	['DIAG_BRIDGE', phpScript(DIAG_BRIDGE_PHP)],
	['DIAG_EXTENSIONS', phpScript(DIAG_EXTENSIONS_PHP)],
	['DIAG_EXEC_COUNTERS', phpScript(DIAG_EXEC_COUNTERS_PHP)],
	[
		'DIAG_NATIVE_FETCH',
		phpRender(DIAG_NATIVE_FETCH_PHP, { TARGET: JSON.stringify('https://x/') })
	]
];

// A MISSING PHP BINARY MUST NOT SILENTLY PASS THIS FILE. A local developer without php should not
// see red, but a CI run that skipped the only syntax gate for ~30 PHP fragments is
// indistinguishable from one that passed -- the same rule this project already wrote down about
// `check:sync` and then broke twice.
if (!php && process.env.CI) {
	throw new Error(
		'php is not on PATH and CI is set: the PHP fragment syntax gate would silently skip. ' +
			'Install php in the workflow or narrow what CI claims to cover.'
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
		expect(lint('control', '<?php function broken( {')).not.toBe('');
	});
});

const PHP_DIR = join(ROOT, 'src/site/php');
const PHP_FILES = readdirSync(PHP_DIR, { recursive: true, encoding: 'utf8' })
	.filter((f) => f.endsWith('.php'))
	.sort();

/**
 * Files that declare a name an extension owns, so a top-level declaration is a compile error on a
 * build carrying that extension. They are linted inside the `if` the composition wraps them in.
 */
const WRAPPED = new Set(['mb/fix.php']);

describe.skipIf(!php)('every file under src/site/php is parseable PHP', () => {
	it('found the files, so this cannot pass by linting nothing', () => {
		expect(PHP_FILES.length).toBeGreaterThanOrEqual(40);
	});

	it.each(PHP_FILES)('%s', (file) => {
		const source = readFileSync(join(PHP_DIR, file), 'utf8');
		expect(source.startsWith('<?php\n'), `${file} must open with a <?php line`).toBe(true);
		const body = WRAPPED.has(file)
			? hoistUses(`<?php\n${phpWhen('true', source.slice('<?php\n'.length))}`)
			: source;
		expect(lint(file.replaceAll('/', '_'), body)).toBe('');
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
	/** a deadline: the clock with something added to it, or the clock inside a loop condition */
	const DEADLINE = [
		/microtime\s*\([^)]*\)\s*[*/]?\s*[\d.]*\s*\+/,
		/\+\s*[\d.]+\s*[*/]?\s*[\d.]*\s*;?\s*\/\/\s*deadline/i,
		/while\s*\([^)]*microtime/,
		// a call, not the degraded declaration standin-fix.php puts under the same name
		/(?<!function\s+)usleep\s*\(/,
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

	it('found the files to scan, so this cannot pass by scanning nothing', () => {
		expect(PHP_FILES.length).toBeGreaterThanOrEqual(40);
	});

	it.each(PHP_FILES)('%s', (file) => {
		const source = readFileSync(join(PHP_DIR, file), 'utf8');
		const offenders: string[] = [];
		for (const [index, line] of source.split('\n').entries()) {
			// a comment ABOUT the hazard is not the hazard, and these files are full of them
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

describe('the Fiber stand-in', () => {
	// whichever fragment runs first declares PhpWasmSyncFiber, so a fragment with its own copy left
	// the class without the static that Canvas's rewritten driver reads (varbase, 2026-09-29)
	it('is one definition, carrying the handler, in every fragment that declares it', () => {
		expect(FIBER_SHIM).toContain('public static $handler = null;');
		for (const fragment of [
			renderPage('/', []),
			runCronHook('system'),
			updbPlan(),
			updbUnit()
		]) {
			expect(fragment).toContain(FIBER_SHIM);
			expect(fragment.match(/class PhpWasmSyncFiber\b/g)?.length).toBe(
				fragment.split(FIBER_SHIM).length - 1
			);
		}
	});
});
