import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZLIB_FIX } from '../../src/drupal/zlib-fix';

/**
 * The zlib shim end to end: the real PHP fragment, over the real fflate host, checked
 * against the real extension.
 *
 * This file exists separately because `tests/unit/drupal/zlib-fix.spec.ts` runs in workerd,
 * where there is no PHP, so everything it can say about the PHP half is about its text.
 * The interesting failures are all semantic: an interpolated `$level` inside a
 * double-quoted message, a container mapped to the wrong fflate function, `max_length`
 * truncating where zlib fails. None of those are visible in a string.
 *
 * How it runs: two exact text substitutions on the fragment, both asserted before use:
 * the extension guard becomes `if (true)` so the body declares on a host that HAS zlib,
 * and the six colliding function names gain a `cfwz_` prefix so they can sit beside the
 * internal ones. The declarations they replace are untouched, so the fragment under test
 * is the shipped fragment. The host is a persistent `bun` process speaking one JSON line
 * per call, importing the SAME `zlibHostCall` the Durable Object installs -- so fflate is
 * really doing the work rather than being modelled.
 *
 * What is not asserted: byte equality with `gzencode()`. fflate and zlib are different
 * encoders and their output differs at every level; the property that matters is that
 * zlib reads what fflate wrote, which is asserted in both directions below.
 */

const ROOT = new URL('../../', import.meta.url).pathname;

/** the guard that keeps the fragment inert, and the substitution that switches it on */
const GUARD = "if (!extension_loaded('zlib') && !function_exists('cfw_zlib_installed')) {";

/** the six names that collide with the internal functions */
const COLLIDING = [
	'gzencode',
	'gzdecode',
	'gzcompress',
	'gzuncompress',
	'gzdeflate',
	'gzinflate'
] as const;

function have(bin: string, args: string[]): boolean {
	try {
		execFileSync(bin, args, { stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
}

/**
 * The bun binary, as an absolute path.
 *
 * `process.execPath` is NOT it: this project runs in vitest, and the `node` project runs
 * under node even when the suite was started with `bunx`. Node cannot load the host
 * script -- it is TypeScript, and it imports a `.ts` module through a `.js` specifier,
 * which is this repo's convention precisely because bun resolves it and node does not.
 */
function bunBinary(): string | null {
	try {
		return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim() || null;
	} catch {
		return null;
	}
}

const php = have('php', ['--version']);
const phpZlib =
	php &&
	execFileSync('php', ['-r', 'echo extension_loaded("zlib") ? "1" : "0";'], {
		encoding: 'utf8'
	}).trim() === '1';
const bun = bunBinary();
const runnable = php && phpZlib && bun !== null;

/**
 * The fragment, rewritten so it can be exercised beside the real extension.
 *
 * Throws rather than silently producing something untestable: a substitution that stopped
 * matching would otherwise leave a suite that runs against nothing and still passes.
 */
function drivableFragment(): string {
	if (!ZLIB_FIX.includes(GUARD)) {
		throw new Error('ZLIB_FIX no longer opens with the extension guard this rewrites');
	}
	let php = ZLIB_FIX.replace(GUARD, 'if (true) {');
	for (const name of COLLIDING) {
		const decl = `function ${name}(`;
		if (!php.includes(decl)) throw new Error(`ZLIB_FIX no longer declares ${name}()`);
		php = php.replace(decl, `function cfwz_${name}(`);
	}
	return php;
}

/** the host half, as a line server, importing the code the Durable Object installs */
const HOST_JS = `
import { zlibHostCall } from ${JSON.stringify(join(ROOT, 'src/drupal/zlib-fix.ts'))};

for await (const line of console) {
	if (line.trim() === '') continue;
	let out;
	try {
		out = zlibHostCall(JSON.parse(line));
	} catch (e) {
		out = { ok: false, error: String(e?.message ?? e) };
	}
	console.log(JSON.stringify(out));
}
`;

/**
 * The PHP driver: a stub `vrzno_env()` over the line server, then the assertions.
 *
 * `vrzno_env` is declared here rather than mocked, because that is exactly how the real
 * one is reached -- the fragment calls `function_exists('vrzno_env')` and then invokes
 * what it returns, and a closure satisfies that with no extension involved.
 */
function driver(fragment: string, hostPath: string, bunPath: string): string {
	return `<?php
$descriptors = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
$proc = proc_open([${JSON.stringify(bunPath)}, ${JSON.stringify(hostPath)}], $descriptors, $pipes);
if (!is_resource($proc)) { fwrite(STDERR, "could not start the host\\n"); exit(2); }

function vrzno_env($name) {
	global $pipes;
	if ($name !== 'cfwZlib') { return null; }
	return function ($json) use ($pipes) {
		fwrite($pipes[0], $json . "\\n");
		fflush($pipes[0]);
		$line = fgets($pipes[1]);
		return $line === false ? '' : rtrim($line, "\\n");
	};
}

${fragment}

$pass = 0;
$fail = 0;
$checks = [];
function ok($label, $condition, $detail = '') {
	global $pass, $fail, $checks;
	if ($condition) { $pass++; } else { $fail++; }
	$checks[] = ['label' => $label, 'ok' => (bool) $condition, 'detail' => (string) $detail];
}

$sample = str_repeat('body{color:red}', 40);
$binary = "\\x00\\xff\\xfe\\x80A\\x00";

// the fragment declared at all, which the guard rewrite is there to allow
ok('the fragment declared its functions', function_exists('cfwz_gzencode') && function_exists('cfwz_gzinflate'));
ok('and reported itself installed', function_exists('cfw_zlib_installed') && cfw_zlib_installed() === true);

// EACH CONTAINER, read back by the REAL extension. This is the assertion that a wrong
// fflate mapping fails: gzuncompress on gzip bytes is an error, not a different answer.
$gz = cfwz_gzencode($sample, 9, FORCE_GZIP);
ok('gzencode produced gzip magic', is_string($gz) && substr($gz, 0, 2) === "\\x1f\\x8b", is_string($gz) ? bin2hex(substr($gz, 0, 2)) : gettype($gz));
ok('native gzdecode reads what the shim wrote', gzdecode($gz) === $sample);
ok('and it is smaller than the input', is_string($gz) && strlen($gz) < strlen($sample), (string) strlen((string) $gz));

$zl = cfwz_gzcompress($sample, 9);
ok('native gzuncompress reads shim gzcompress', gzuncompress($zl) === $sample);
$rw = cfwz_gzdeflate($sample, 9);
ok('native gzinflate reads shim gzdeflate', gzinflate($rw) === $sample);

// and the other direction: the shim reads what the extension wrote
ok('shim gzdecode reads native gzencode', cfwz_gzdecode(gzencode($sample, 9, FORCE_GZIP)) === $sample);
ok('shim gzuncompress reads native gzcompress', cfwz_gzuncompress(gzcompress($sample, 9)) === $sample);
ok('shim gzinflate reads native gzdeflate', cfwz_gzinflate(gzdeflate($sample, 9)) === $sample);

// the containers stay distinct, so no two of the six are wired to the same fflate call
ok('shim gzuncompress refuses gzip bytes', @cfwz_gzuncompress($gz) === false);
ok('shim gzdecode refuses zlib bytes', @cfwz_gzdecode($zl) === false);
ok('shim gzinflate refuses gzip bytes', @cfwz_gzinflate($gz) === false);

// FORCE_DEFLATE on gzencode is a ZLIB container, which is the one encoding subtlety here
ok('shim gzencode(FORCE_DEFLATE) is readable as zlib', gzuncompress(cfwz_gzencode($sample, 9, FORCE_DEFLATE)) === $sample);
ok('and native agrees that is what FORCE_DEFLATE means', gzencode($sample, 9, FORCE_DEFLATE) === gzcompress($sample, 9));

// binary that is not valid UTF-8, which is why the bridge is base64 rather than a raw string
ok('binary survives the bridge intact', cfwz_gzdecode(cfwz_gzencode($binary, 9)) === $binary, bin2hex((string) cfwz_gzdecode(cfwz_gzencode($binary, 9))));
ok('and the empty string round-trips', cfwz_gzdecode(cfwz_gzencode('', 9)) === '');

// levels
ok('level 0 still produces a readable stream', gzdecode(cfwz_gzencode($sample, 0)) === $sample);
ok('level 0 is larger than level 9', strlen(cfwz_gzencode($sample, 0)) > strlen(cfwz_gzencode($sample, 9)));
ok('the default level is accepted', gzdecode(cfwz_gzencode($sample)) === $sample);

// mtime 0, so a regenerated asset is byte-reproducible
$a = cfwz_gzencode($sample, 9);
$b = cfwz_gzencode($sample, 9);
ok('gzencode is reproducible for identical input', $a === $b);
ok('and its mtime field is zero, as zlib writes it', substr($a, 4, 4) === "\\x00\\x00\\x00\\x00", bin2hex(substr($a, 4, 4)));

// FAILURE SEMANTICS, against the extension rather than against documentation
ok('garbage into gzuncompress is FALSE here', @cfwz_gzuncompress('not compressed at all') === false);
ok('and FALSE there too', @gzuncompress('not compressed at all') === false);
ok('garbage into gzdecode is FALSE here', @cfwz_gzdecode('not compressed at all') === false);
ok('garbage into gzinflate is FALSE here', @cfwz_gzinflate('not compressed at all') === false);

// max_length is a CAP, not a truncation: zlib fails the inflate when its buffer is short
ok('a short max_length is FALSE here', @cfwz_gzuncompress($zl, 5) === false);
ok('and FALSE there', @gzuncompress(gzcompress($sample, 9), 5) === false);
ok('a max_length at the exact length succeeds', cfwz_gzuncompress($zl, strlen($sample)) === $sample);
ok('and 0 means no cap', cfwz_gzuncompress($zl, 0) === $sample);

// the diagnostic, which UrlHelper suppresses with @ and which an unsuppressed caller sees
$seen = null;
set_error_handler(function ($no, $str) use (&$seen) { $seen = $str; return true; });
cfwz_gzuncompress('not compressed at all');
restore_error_handler();
ok('a failure raises the diagnostic zlib raises', $seen === 'gzuncompress(): data error', (string) $seen);

// ValueError wording, quoted from the extension in this same process
function message($fn) { try { $fn(); return 'no throw'; } catch (\\Throwable $e) { return get_class($e) . ': ' . $e->getMessage(); } }
ok(
	'an out-of-range level throws what the extension throws',
	message(fn() => cfwz_gzencode('x', 99)) === message(fn() => gzencode('x', 99)),
	message(fn() => cfwz_gzencode('x', 99)) . ' / ' . message(fn() => gzencode('x', 99))
);
ok(
	'and so does a negative one below -1',
	message(fn() => cfwz_gzcompress('x', -2)) === message(fn() => gzcompress('x', -2)),
	message(fn() => cfwz_gzcompress('x', -2)) . ' / ' . message(fn() => gzcompress('x', -2))
);
ok(
	'an unknown encoding throws what the extension throws',
	message(fn() => cfwz_gzencode('x', 9, 123)) === message(fn() => gzencode('x', 9, 123)),
	message(fn() => cfwz_gzencode('x', 9, 123)) . ' / ' . message(fn() => gzencode('x', 9, 123))
);

// the constants, which the fragment must not clobber where they already exist
ok('FORCE_GZIP is 31', FORCE_GZIP === 31);
ok('FORCE_DEFLATE is 15', FORCE_DEFLATE === 15);
ok('ZLIB_ENCODING_RAW is -15', ZLIB_ENCODING_RAW === -15);

// AssetDumper's exact call, which is the only zlib call on the render path
$css = str_repeat('.a{b:c}', 200);
$dumped = cfwz_gzencode($css, 9, FORCE_GZIP);
ok("AssetDumper's gzencode(\\$data, 9, FORCE_GZIP) produces a readable .gz", gzdecode($dumped) === $css);

// UrlHelper's pair, over its own base64 wrapper
$payload = json_encode(['f' => ['a' => 1, 'b' => 2]]);
$packed = str_replace(['+', '/', '='], ['-', '_', ''], base64_encode(cfwz_gzcompress($payload)));
$unpacked = @cfwz_gzuncompress(base64_decode(str_replace(['-', '_'], ['+', '/'], $packed)));
ok("UrlHelper's compress/uncompress pair round-trips", $unpacked === $payload, (string) $unpacked);

fclose($pipes[0]);
proc_close($proc);
echo json_encode(['passed' => $pass, 'failed' => $fail, 'checks' => $checks]);
`;
}

if (!runnable && process.env.CI) {
	throw new Error(
		'php with ext-zlib and bun are both required: this is the only gate that runs the zlib ' +
			'shim as PHP, and a skip in CI is indistinguishable from a pass'
	);
}

describe.skipIf(!runnable)('the zlib shim, as PHP, over fflate, against ext-zlib', () => {
	const dir = mkdtempSync(join(tmpdir(), 'cfw-zlib-'));
	const hostPath = join(dir, 'host.mjs');
	const driverPath = join(dir, 'driver.php');
	writeFileSync(hostPath, HOST_JS);
	writeFileSync(driverPath, driver(drivableFragment(), hostPath, String(bun)));

	// display_errors=stderr keeps a diagnostic off stdout, which carries the JSON result. PHP CLI
	// prints warnings to stdout by default and the first suppressed-in-Drupal warning corrupted it
	const raw = execFileSync(
		'php',
		['-d', 'error_reporting=E_ALL', '-d', 'display_errors=stderr', driverPath],
		{ encoding: 'utf8', timeout: 25_000 }
	);
	rmSync(dir, { recursive: true, force: true });
	const result = JSON.parse(raw) as {
		passed: number;
		failed: number;
		checks: Array<{ label: string; ok: boolean; detail: string }>;
	};

	it('ran a real fragment against a real host', () => {
		// a driver that started and asserted nothing would report 0 failed
		expect(result.passed + result.failed).toBeGreaterThan(30);
	});

	it.each(result.checks.map((c) => [c.label, c] as [string, typeof c]))('%s', (_label, check) => {
		expect(check.ok, check.detail).toBe(true);
	});

	it('had no failures at all', () => {
		expect(result.failed, JSON.stringify(result.checks.filter((c) => !c.ok))).toBe(0);
	});
});
