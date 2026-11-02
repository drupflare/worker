import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BROTLI_FIX, brotliHostCall, type BrotliReply } from '../../src/site/shims/brotli-fix';
import {
	storedZstdFrame,
	ZSTD_FIX,
	zstdHostCall,
	type ZstdReply
} from '../../src/site/shims/zstd-fix';

/**
 * The brotli and zstd shims against the native tools.
 *
 * Three oracles, none of them the shim itself: the `brotli` and `zstd` command-line binaries for
 * the host half, and the native ext-brotli and ext-zstd of the local PHP for the PHP half. The
 * PHP half runs in a real PHP process with each shim function renamed beside its native twin,
 * the same substitution `zlib-php.spec.ts` makes, so one run asks both the same question.
 *
 * Compressed bytes are not compared. Different encoders produce different frames; what has to
 * hold is that each side reads the other's output.
 */

const ROOT = new URL('../../', import.meta.url).pathname;

function have(bin: string, args: string[]): boolean {
	try {
		execFileSync(bin, args, { stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
}

/** whether the local PHP carries the named extension, the oracle the PHP half needs */
function phpHas(name: string): boolean {
	try {
		return (
			execFileSync('php', ['-r', `echo extension_loaded('${name}') ? '1' : '0';`], {
				encoding: 'utf8'
			}).trim() === '1'
		);
	} catch {
		return false;
	}
}

function bunBinary(): string | null {
	try {
		return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim() || null;
	} catch {
		return null;
	}
}

const brotliCli = have('brotli', ['--version']);
const zstdCli = have('zstd', ['--version']);
const bun = bunBinary();
const phpRunnable =
	have('php', ['--version']) && phpHas('brotli') && phpHas('zstd') && bun !== null;

if (!brotliCli) console.log('[codec-shims] brotli CLI absent; host differential skipped');
if (!zstdCli) console.log('[codec-shims] zstd CLI absent; host differential skipped');
if (!phpRunnable) {
	console.log('[codec-shims] php with ext-brotli and ext-zstd, or bun, absent; PHP half skipped');
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const unb64 = (text: string): Buffer => Buffer.from(text, 'base64');

/** the bytes a successful reply carries, or the reply's own error as a thrown message */
function payload(reply: BrotliReply | ZstdReply): Buffer {
	if (!reply.ok) throw new Error(reply.error);
	return unb64(reply.b64);
}

const TEXT = Buffer.from('body{color:red}a{b:c}'.repeat(400) + 'tail');

const CORPUS: Array<[string, Buffer]> = [
	['empty input', Buffer.alloc(0)],
	['one byte', Buffer.from('x')],
	['4000 bytes of text', TEXT.subarray(0, 4000)],
	['one 16 KiB frame', TEXT.subarray(0, 16384)],
	['1 MiB of random bytes', randomBytes(1024 * 1024)]
];

/** the level a corpus entry compresses at: quality 11 on the small ones, 4 on the megabyte */
const brotliLevel = (plain: Buffer): number => (plain.length > 65536 ? 4 : 11);

function cli(bin: string, args: string[], input: Buffer, extra: string[] = []): Buffer {
	return execFileSync(bin, [...args, ...extra], {
		input,
		maxBuffer: 64 * 1024 * 1024
	});
}

describe.skipIf(!brotliCli)('brotli host call against the brotli CLI', () => {
	it.each(CORPUS)('the shim compresses %s and the CLI reads it', (_name, plain) => {
		const frame = payload(
			brotliHostCall({ op: 'compress', b64: b64(plain), level: brotliLevel(plain), mode: 0 })
		);
		expect(b64(cli('brotli', ['-d', '-c'], frame))).toBe(b64(plain));
	});

	it.each(CORPUS)('the CLI compresses %s and the shim reads it', (_name, plain) => {
		const frame = cli('brotli', ['-c', '-q', '5'], plain);
		const back = payload(brotliHostCall({ op: 'uncompress', b64: b64(frame) }));
		expect(b64(back)).toBe(b64(plain));
	});

	it('refuses a preset dictionary rather than dropping it', () => {
		const reply = brotliHostCall({
			op: 'compress',
			b64: b64(Buffer.from('abcabc')),
			level: 5,
			mode: 0,
			dict: b64(Buffer.from('abc'))
		});
		expect(reply.ok).toBe(false);
		expect(reply.ok ? '' : reply.error).toMatch(/dictionar/);
	});

	it('refuses a quality outside 0..11, as the native ext does', () => {
		for (const level of [-1, 12]) {
			const reply = brotliHostCall({ op: 'compress', b64: b64(TEXT), level, mode: 0 });
			expect(reply.ok, `level ${level}`).toBe(false);
		}
	});

	it('refuses a mode that is not GENERIC, TEXT or FONT', () => {
		const reply = brotliHostCall({ op: 'compress', b64: b64(TEXT), level: 5, mode: 5 });
		expect(reply.ok).toBe(false);
	});

	it('refuses bytes that are not a brotli stream', () => {
		const reply = brotliHostCall({
			op: 'uncompress',
			b64: b64(Buffer.from('not brotli at all'))
		});
		expect(reply.ok).toBe(false);
	});
});

describe.skipIf(!brotliCli)('brotli sizes the workerd probe measured', () => {
	const sizes: Array<[string, number, number[]]> = [
		['4096 random bytes', 4096, [0, 4, 11]],
		['16384 random bytes', 16384, [0, 4, 11]],
		['65536 random bytes', 65536, [0, 4, 11]],
		['1 MiB of random bytes', 1 << 20, [0, 4]],
		['4 MiB of random bytes', 4 << 20, [0, 4]]
	];
	for (const [name, n, qualities] of sizes) {
		for (const level of qualities) {
			it(`the shim and the CLI agree on ${name} at quality ${level}`, () => {
				const plain = randomBytes(n);
				const frame = payload(
					brotliHostCall({ op: 'compress', b64: b64(plain), level, mode: 0 })
				);
				expect(b64(cli('brotli', ['-d', '-c'], frame))).toBe(b64(plain));
				const native = cli('brotli', ['-c', '-q', String(level)], plain);
				const back = payload(brotliHostCall({ op: 'uncompress', b64: b64(native) }));
				expect(b64(back)).toBe(b64(plain));
			});
		}
	}
});

const ZSTD_DICT = Buffer.from('body{color:red}a{b:c}'.repeat(40));
const ZSTD_DICT_PLAIN = Buffer.concat([ZSTD_DICT.subarray(0, 900), Buffer.from('tail')]);

describe.skipIf(!zstdCli)('stored zstd frames against the zstd CLI', () => {
	it.each([0, 1, 65536, 131073, 1024 * 1024])('the CLI reads a stored frame of %i bytes', (n) => {
		const plain = randomBytes(n);
		const back = cli('zstd', ['-d', '-c'], Buffer.from(storedZstdFrame(plain)));
		expect(b64(back)).toBe(b64(plain));
	});

	it('the shim reads a stored frame', () => {
		const plain = randomBytes(65536);
		const reply = zstdHostCall({ op: 'uncompress', b64: b64(storedZstdFrame(plain)) });
		expect(b64(payload(reply))).toBe(b64(plain));
	});
});

describe.skipIf(!zstdCli)('zstd host call against the zstd CLI', () => {
	let dir = '';
	let dictPath = '';

	it('writes its dictionary file', () => {
		dir = mkdtempSync(join(tmpdir(), 'cfw-zstd-dict-'));
		dictPath = join(dir, 'dict.bin');
		writeFileSync(dictPath, ZSTD_DICT);
		expect(dictPath).toContain('dict.bin');
	});

	it.each(CORPUS)('the shim compresses %s and the CLI reads it', (_name, plain) => {
		const frame = payload(zstdHostCall({ op: 'compress', b64: b64(plain), level: 3 }));
		expect(b64(cli('zstd', ['-d', '-c'], frame))).toBe(b64(plain));
	});

	it.each(CORPUS)('the CLI compresses %s and the shim reads it', (_name, plain) => {
		const frame = cli('zstd', ['-q', '-c', '-19'], plain);
		const back = payload(zstdHostCall({ op: 'uncompress', b64: b64(frame) }));
		expect(b64(back)).toBe(b64(plain));
	});

	it('the shim compresses with a dictionary and the CLI reads it', () => {
		const frame = payload(
			zstdHostCall({
				op: 'compress',
				b64: b64(ZSTD_DICT_PLAIN),
				level: 3,
				dict: b64(ZSTD_DICT)
			})
		);
		expect(b64(cli('zstd', ['-d', '-c', '-D', dictPath], frame))).toBe(b64(ZSTD_DICT_PLAIN));
	});

	it('the CLI compresses with a dictionary and the shim reads it', () => {
		const frame = cli('zstd', ['-q', '-c', '-3', '-D', dictPath], ZSTD_DICT_PLAIN);
		const back = payload(
			zstdHostCall({ op: 'uncompress', b64: b64(frame), dict: b64(ZSTD_DICT) })
		);
		expect(b64(back)).toBe(b64(ZSTD_DICT_PLAIN));
	});

	it('refuses a wrong dictionary, which the CLI also refuses', () => {
		const frame = cli('zstd', ['-q', '-c', '-3', '-D', dictPath], ZSTD_DICT_PLAIN);
		const reply = zstdHostCall({
			op: 'uncompress',
			b64: b64(frame),
			dict: b64(Buffer.from('a different dictionary'))
		});
		expect(reply.ok).toBe(false);
	});

	it('refuses a level above 22', () => {
		const reply = zstdHostCall({ op: 'compress', b64: b64(TEXT), level: 23 });
		expect(reply.ok).toBe(false);
	});

	it('refuses bytes that are not a zstd frame', () => {
		const reply = zstdHostCall({ op: 'uncompress', b64: b64(Buffer.from('not zstd at all')) });
		expect(reply.ok).toBe(false);
	});

	afterAll(() => {
		if (dir !== '') rmSync(dir, { recursive: true, force: true });
	});
});

/** the fragment with its functions renamed beside the native ones, and its guard opened */
function drivable(fragment: string, prefix: string, names: readonly string[], guard: string) {
	if (!fragment.includes(guard)) throw new Error(`fragment no longer opens with: ${guard}`);
	let php = fragment.replace(guard, "if (function_exists('vrzno_env')) {");
	for (const name of names) {
		const decl = `function ${name}(`;
		if (!php.includes(decl)) throw new Error(`fragment no longer declares ${name}()`);
		php = php.replace(decl, `function ${prefix}${name}(`);
	}
	return php;
}

const BROTLI_NAMES = ['brotli_compress', 'brotli_uncompress'] as const;
const ZSTD_NAMES = [
	'zstd_compress',
	'zstd_uncompress',
	'zstd_decompress',
	'zstd_compress_dict',
	'zstd_uncompress_dict'
] as const;

/** a host line server over one exported call, importing the same code the Durable Object installs */
function hostScript(modulePath: string, exportName: string): string {
	return `
import { ${exportName} } from ${JSON.stringify(modulePath)};

for await (const line of console) {
	if (line.trim() === '') continue;
	let out;
	try {
		out = ${exportName}(JSON.parse(line));
	} catch (e) {
		out = { ok: false, error: String(e?.message ?? e) };
	}
	console.log(JSON.stringify(out));
}
`;
}

function driver(
	brotliFragment: string,
	zstdFragment: string,
	brotliHost: string,
	zstdHost: string,
	bunPath: string
): string {
	return `<?php
function cfw_spawn($bun, $host) {
	$p = proc_open([$bun, $host], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
	if (!is_resource($p)) { fwrite(STDERR, "could not start $host\\n"); exit(2); }
	$GLOBALS['__t_procs'][] = $p;
	return $pipes;
}
$GLOBALS['__t_pipes'] = [
	'cfwBrotli' => cfw_spawn(${JSON.stringify(bunPath)}, ${JSON.stringify(brotliHost)}),
	'cfwZstd' => cfw_spawn(${JSON.stringify(bunPath)}, ${JSON.stringify(zstdHost)}),
];
function vrzno_env($name) {
	if (!isset($GLOBALS['__t_pipes'][$name])) { return null; }
	$pipes = $GLOBALS['__t_pipes'][$name];
	return function ($json) use ($pipes) {
		fwrite($pipes[0], $json . "\\n");
		fflush($pipes[0]);
		$line = fgets($pipes[1]);
		return $line === false ? '' : rtrim($line, "\\n");
	};
}

${brotliFragment}
${zstdFragment}

$checks = [];
$warnings = 0;
set_error_handler(function () use (&$warnings) { $warnings++; return true; });
function ok($label, $cond, $detail = '') {
	global $checks;
	$checks[] = ['label' => $label, 'ok' => (bool) $cond, 'detail' => (string) $detail];
}

$plain = str_repeat('body{color:red}a{b:c}', 400) . 'tail';
$binary = "\\x00\\xff\\xfe\\x80A\\x00";
$dict = str_repeat('body{color:red}a{b:c}', 40);
$dictPlain = substr($dict, 0, 900) . 'tail';

// the fragments declare what the native extension declares, with the same values
foreach (['BROTLI_GENERIC', 'BROTLI_TEXT', 'BROTLI_FONT', 'BROTLI_COMPRESS_LEVEL_MAX', 'BROTLI_COMPRESS_LEVEL_DEFAULT'] as $c) {
	ok("native defines $c", defined($c), $c);
}
ok('brotli_compress is native and the shim stays inert', function_exists('brotli_compress') && (new ReflectionFunction('brotli_compress'))->isInternal());

// brotli: shim against native, both directions
$shimB = cfwb_brotli_compress($plain, 11, BROTLI_GENERIC, null);
ok('shim brotli output is readable by native', is_string($shimB) && brotli_uncompress($shimB) === $plain);
$nativeB = brotli_compress($plain, 11);
ok('native brotli output is readable by shim', is_string($nativeB) && cfwb_brotli_uncompress($nativeB) === $plain);
ok('shim reads binary bytes', cfwb_brotli_uncompress(cfwb_brotli_compress($binary, 5, BROTLI_GENERIC)) === $binary);
ok('shim TEXT mode round-trips through native', brotli_uncompress(cfwb_brotli_compress($plain, 5, BROTLI_TEXT)) === $plain);
ok('shim empty input round-trips', cfwb_brotli_uncompress(cfwb_brotli_compress('')) === '');

// brotli: the same refusals as native
$w0 = $warnings;
ok('quality 12 is refused by both', cfwb_brotli_compress('x', 12) === false && brotli_compress('x', 12) === false);
ok('mode 5 is refused by both', cfwb_brotli_compress('x', 5, 5) === false && brotli_compress('x', 5, 5) === false);
ok('garbage is refused by both', cfwb_brotli_uncompress('not brotli at all') === false && brotli_uncompress('not brotli at all') === false);
ok('refusals raise a warning', $warnings > $w0, (string) ($warnings - $w0));

// brotli: a dictionary native accepts and the shim must refuse, not drop
ok('native brotli takes a dictionary', is_string(brotli_compress($dictPlain, 5, 0, $dict)));
ok('shim refuses a brotli dictionary', cfwb_brotli_compress($dictPlain, 5, 0, $dict) === false);

// zstd: shim against native, both directions
$shimZ = cfwz_zstd_compress($plain, 3);
ok('shim zstd output is readable by native', is_string($shimZ) && zstd_uncompress($shimZ) === $plain);
$nativeZ = zstd_compress($plain, 3);
ok('native zstd output is readable by shim', is_string($nativeZ) && cfwz_zstd_uncompress($nativeZ) === $plain);
ok('zstd_decompress alias reads native output', cfwz_zstd_decompress($nativeZ) === $plain);
ok('shim zstd reads binary bytes', cfwz_zstd_uncompress(cfwz_zstd_compress($binary)) === $binary);

// zstd: dictionaries, both directions, through the 3-argument form and the _dict pair
$shimD = cfwz_zstd_compress($dictPlain, 3, $dict);
ok('shim zstd dictionary frame is readable by native', is_string($shimD) && zstd_uncompress($shimD, $dict) === $dictPlain);
$nativeD = zstd_compress($dictPlain, 3, $dict);
ok('native zstd dictionary frame is readable by shim', is_string($nativeD) && cfwz_zstd_uncompress($nativeD, $dict) === $dictPlain);
ok('the _dict pair round-trips', cfwz_zstd_uncompress_dict(cfwz_zstd_compress_dict($dictPlain, $dict, 5), $dict) === $dictPlain);
ok('native reads the shim _dict pair', zstd_uncompress_dict(cfwz_zstd_compress_dict($dictPlain, $dict, 5), $dict) === $dictPlain);

// zstd: refusals, compared to native rather than to an assumed answer
$wz0 = $warnings;
ok('level 23 is refused by both', cfwz_zstd_compress('x', 23) === false && zstd_compress('x', 23) === false);
ok('garbage is refused by both', cfwz_zstd_uncompress('not zstd at all') === false && zstd_uncompress('not zstd at all') === false);
$wrongShim = cfwz_zstd_uncompress($shimD, 'a different dictionary');
$wrongNative = zstd_uncompress($shimD, 'a different dictionary');
ok('a wrong dictionary answers the same as native', ($wrongShim === false) === ($wrongNative === false), var_export($wrongShim, true) . ' / ' . var_export($wrongNative, true));
ok('zstd refusals raise a warning', $warnings > $wz0, (string) ($warnings - $wz0));

restore_error_handler();
echo json_encode(['checks' => $checks]);
`;
}

describe.skipIf(!phpRunnable)('the PHP fragments against the native extensions', () => {
	it('answers every check the same way the native ext does', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cfw-codec-php-'));
		try {
			const brotliFragment = drivable(
				BROTLI_FIX,
				'cfwb_',
				BROTLI_NAMES,
				"if (!function_exists('brotli_compress') && function_exists('vrzno_env')) {"
			);
			const zstdFragment = drivable(
				ZSTD_FIX,
				'cfwz_',
				ZSTD_NAMES,
				"if (!function_exists('zstd_compress') && function_exists('vrzno_env')) {"
			);
			const brotliHost = join(dir, 'brotli-host.ts');
			const zstdHost = join(dir, 'zstd-host.ts');
			writeFileSync(
				brotliHost,
				hostScript(join(ROOT, 'src/site/shims/brotli-fix.ts'), 'brotliHostCall')
			);
			writeFileSync(
				zstdHost,
				hostScript(join(ROOT, 'src/site/shims/zstd-fix.ts'), 'zstdHostCall')
			);
			const script = join(dir, 'driver.php');
			writeFileSync(script, driver(brotliFragment, zstdFragment, brotliHost, zstdHost, bun!));
			const out = execFileSync('php', [script], { encoding: 'utf8', timeout: 120_000 });
			const { checks } = JSON.parse(out.slice(out.indexOf('{"checks"'))) as {
				checks: Array<{ label: string; ok: boolean; detail: string }>;
			};
			expect(checks.length).toBeGreaterThanOrEqual(25);
			const failed = checks.filter((c) => !c.ok).map((c) => `${c.label} [${c.detail}]`);
			expect(failed).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 180_000);
});
