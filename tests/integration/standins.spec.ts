import { describe, expect, it } from 'vitest';
import { BOOT_KERNEL, renderPage } from '../../src/drupal/site-php';
import { BATCH_YIELD_OPS, GD_CONSTANTS, GD_FUNCTIONS } from '../../src/drupal/standin-fix';
import { DRUPLICON_PNG_BASE64 } from '../fixtures/png';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The extension stand-ins and the declared degradations, inside a booted Drupal.
 *
 * Every class here lives in the drupflare module and every function is declared by
 * `STANDIN_FIX` at boot, so the half that can break is the wiring: the autoloader alias, the
 * `disable_functions` line that frees the built-in names, and the pack's patched `batch.inc`.
 * The sibling's health suite checks each class against the native extension.
 *
 * Needs the pack, so it is in `ARTIFACT_SPECS`.
 */

type Payload = Record<string, unknown>;
const TIMEOUT = 600_000;

const PROBE = String.raw`<?php
$out = ['ok' => false];
try {
  require_once DRUPAL_ROOT . '/core/includes/batch.inc';
  require_once DRUPAL_ROOT . '/core/includes/form.inc';
  if (!function_exists('cfw_test_batch_op')) {
    function cfw_test_batch_op($i, &$context) { $context['results'][] = $i; }
  }
  $ops = [];
  for ($i = 0; $i < 50; $i++) { $ops[] = ['cfw_test_batch_op', [$i]]; }
  batch_set(['title' => 'probe', 'operations' => $ops]);
  $batch = &batch_get();
  $batch += ['current_set' => 0, 'progressive' => true];
  $batch['id'] = \Drupal::service(\Drupal\Core\Batch\BatchStorageInterface::class)->getId();
  foreach (array_keys($batch['sets']) as $key) { _batch_populate_queue($batch, $key); }
  $first = _batch_process();
  $afterFirst = count(_batch_current_set()['results']);
  _batch_process();
  $out['batch'] = ['first' => $afterFirst, 'second' => count(_batch_current_set()['results']), 'percent' => $first[0]];

  $path = '/tmp/cfw-standin.zip';
  $zip = new \ZipArchive();
  $zip->open($path, \ZipArchive::CREATE | \ZipArchive::OVERWRITE);
  $zip->addFromString('a.txt', 'alpha');
  $closed = $zip->close();
  $read = new \ZipArchive();
  $opened = $read->open($path);
  $out['zipDebug'] = [$closed, $opened, @filesize($path), $read->numFiles, $read->status];
  $out['zip'] = ['class' => get_class($read), 'body' => $read->getFromName('a.txt'), 'loaded' => extension_loaded('zip')];

  $out['finfo'] = (new \finfo(FILEINFO_MIME_TYPE))->buffer("%PDF-1.7\n") . ' ' . mime_content_type($path);
  $out['translit'] = transliterator_transliterate('Any-Latin; Latin-ASCII', 'Ærøskøbing Straße');
  $out['exifMissing'] = @exif_read_data($path);

  $stack = (new \GuzzleHttp\Client())->getConfig('handler');
  $inner = (new \ReflectionProperty($stack, 'handler'))->getValue($stack);
  $out['guzzleDefault'] = is_object($inner) ? get_class($inner) : gettype($inner);

  $out['sleep'] = sleep(30);
  $out['exec'] = exec('echo hi', $o, $code);
  $out['execOut'] = $o;
  $out['execCode'] = $code;
  $out['execDeclared'] = function_exists('exec');
  $out['execUnknown'] = [exec('cat /etc/hostname', $o2, $code2), $code2];
  $out['procFamily'] = array_map('function_exists', ['pclose', 'proc_get_status', 'proc_close', 'proc_terminate']);
  $p = new \Symfony\Component\Process\Process(['echo', 'from', 'symfony']);
  $p->mustRun();
  $s = \Symfony\Component\Process\Process::fromShellCommandline('sha256sum');
  $s->setInput('abc');
  $s->mustRun();
  $f = new \Symfony\Component\Process\Process(['false']);
  try { $f->mustRun(); $failed = 'no exception'; } catch (\Symfony\Component\Process\Exception\ProcessFailedException $e) { $failed = 'threw ' . $f->getExitCode(); }
  $pipe = new \Symfony\Component\Process\Process(['sh', '-c', 'echo a | wc -c']);
  $pipe->run();
  $out['process'] = ['echo' => $p->getOutput(), 'sha' => $s->getOutput(), 'false' => $failed, 'pipe' => $pipe->getExitCode()];
  $out['gdDeclared'] = function_exists('imagecreatefromstring');
  $out['gdLoaded'] = extension_loaded('gd');
  $out['gdConstants'] = array_map(fn ($name) => defined($name) ? constant($name) : null, array_keys(\Drupal\drupflare\Shim\Gd::CONSTANTS));
  $out['gdConstantNames'] = array_keys(\Drupal\drupflare\Shim\Gd::CONSTANTS);
  $out['gdRouted'] = array_map('function_exists', ${JSON.stringify(GD_FUNCTIONS.map(([n]) => n))});
  $out['declared'] = array_keys(\Drupal\drupflare\Degradation::all());
  $out['ok'] = true;
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . substr($e->getMessage(), 0, 300);
}
echo json_encode($out);
`;

/** each wait is timed by the HOST, because the clock inside a PHP run does not move */
const SLEEPS = {
	parked: String.raw`<?php echo json_encode(['ok' => cfw_sleep_ms(150, 'probe parked sleep')]);`,
	overBudget: String.raw`<?php echo json_encode(['ok' => cfw_sleep_ms(150, 'probe over budget')]);`,
	underArrayMap: String.raw`<?php $r = array_map(fn($ms) => cfw_sleep_ms($ms, 'probe under array_map'), [150]); echo json_encode(['ok' => $r[0]]);`,
	guzzleDelay: String.raw`<?php
		$h = new \Drupal\drupflare\Http\ParkFetchHandler();
		$r = $h(new \GuzzleHttp\Psr7\Request('GET', 'https://delay.example.test/'), ['delay' => 150])->wait();
		echo json_encode(['ok' => $r->getStatusCode() === 200]);`,
	declared: String.raw`<?php echo json_encode(['declared' => array_keys(\Drupal\drupflare\Degradation::all())]);`
};

type Timed = { ok: unknown; ms: number };

async function probe(): Promise<Payload> {
	return inObject(freshSite(), async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		const booted = (await site.runJson(BOOT_KERNEL)) as Payload;
		if (booted?.['ok'] === false) throw new Error(`boot failed: ${JSON.stringify(booted)}`);
		const out = (await site.runJson(PROBE)) as Payload;
		const internals = site as unknown as {
			runJsonMaybeParked(code: string): Promise<Payload>;
			sleepBudget?: { remainingMs: number };
			parkFetchDep?: typeof fetch;
			parkState(): Promise<{ state: string }>;
		};
		out['park'] = (await internals.parkState()).state;
		internals.parkFetchDep = (async () => new Response('ok')) as unknown as typeof fetch;
		const timed = async (code: string, budget: number): Promise<Timed> => {
			internals.sleepBudget = { remainingMs: budget };
			const t0 = Date.now();
			const got = await internals.runJsonMaybeParked(code);
			return { ok: got['ok'], ms: Date.now() - t0 };
		};
		out['sleeps'] = {
			parked: await timed(SLEEPS.parked, 2000),
			overBudget: await timed(SLEEPS.overBudget, 0),
			underArrayMap: await timed(SLEEPS.underArrayMap, 2000),
			guzzleDelay: await timed(SLEEPS.guzzleDelay, 2000)
		};
		out['sleepDeclared'] = (await site.runJson(SLEEPS.declared))['declared'];
		out['execCounters'] = (
			(await (
				await site.fetch(new Request('https://do.local/__serve-stats?exec=1'))
			).json()) as Payload
		)['exec'];
		return out;
	});
}

let cached: Promise<Payload> | null = null;
const measured = () => (cached ??= probe());

describe('the stand-ins, in a booted site', () => {
	it(
		'yields a progressive batch on the operation count instead of running it to the end',
		async () => {
			const out = await measured();
			expect(out['error'], String(out['error'] ?? '')).toBeUndefined();
			const batch = out['batch'] as Record<string, number>;
			expect(batch.first).toBe(BATCH_YIELD_OPS);
			expect(batch.second).toBe(BATCH_YIELD_OPS * 2);
			expect(Number(batch.percent)).toBeLessThan(100);
		},
		TIMEOUT
	);

	it(
		'resolves ZipArchive, finfo and Transliterator to the module classes',
		async () => {
			const out = await measured();
			const zip = out['zip'] as Record<string, unknown>;
			expect(zip.loaded).toBe(false);
			expect(zip.class).toBe('Drupal\\drupflare\\Shim\\ZipArchive');
			expect(zip.body, JSON.stringify(out['zipDebug'])).toBe('alpha');
			expect(out['finfo']).toBe('application/pdf application/zip');
			expect(out['translit']).toBe('AEroskobing Strasse');
			expect(out['exifMissing']).toBe(false);
		},
		TIMEOUT
	);

	it(
		'gives a Guzzle client built with no handler the transport Drupal::httpClient() has',
		async () => {
			const out = await measured();
			expect(String(out['guzzleDefault'])).toMatch(
				/^Drupal\\drupflare\\Http\\(Park|Cached)?FetchHandler$/
			);
		},
		TIMEOUT
	);

	it(
		'waits through the park, and returns at once past the allowance or under an internal frame',
		async () => {
			const out = await measured();
			expect(out['park']).toBe('installed');
			const sleeps = out['sleeps'] as Record<string, Timed>;
			expect(sleeps.parked!.ok).toBe(true);
			expect(sleeps.parked!.ms).toBeGreaterThanOrEqual(140);
			expect(sleeps.overBudget!.ok).toBe(false);
			expect(sleeps.underArrayMap!.ok).toBe(false);
			expect(sleeps.guzzleDelay!.ok).toBe(true);
			expect(sleeps.guzzleDelay!.ms).toBeGreaterThanOrEqual(140);
			expect(out['sleepDeclared']).toEqual(
				expect.arrayContaining(['probe over budget', 'probe under array_map'])
			);
			expect(out['sleepDeclared']).not.toContain('probe parked sleep');
		},
		TIMEOUT
	);

	it(
		'routes exec, proc_open and the rest of the process family through the router',
		async () => {
			const out = await measured();
			expect(out['execDeclared']).toBe(true);
			expect(out['exec']).toBe('hi');
			expect(out['execOut']).toEqual(['hi']);
			expect(Number(out['execCode'])).toBe(0);
			// a program outside the table is still a failed launch, and is recorded
			expect(out['execUnknown']).toEqual([false, 127]);
			expect(out['declared']).toEqual(
				expect.arrayContaining(['sleep', 'exec cat', 'exec sh'])
			);
			expect(out['procFamily']).toEqual([true, true, true, true]);
			const process = out['process'] as Record<string, unknown>;
			expect(out['execCounters']).toMatchObject({
				'echo:ok': expect.any(Number),
				'cat:unknown': 1
			});
			expect(process['echo']).toBe('from symfony\n');
			expect(process['sha']).toMatch(/^ba7816bf8f01cfea/);
			expect(process['false']).toBe('threw 1');
			expect(Number(process['pipe'])).toBe(127);
		},
		TIMEOUT
	);

	it(
		'declares the routed gd functions and the gd constants, and leaves the extension absent',
		async () => {
			const out = await measured();
			expect(out['gdDeclared']).toBe(true);
			expect(out['gdLoaded']).toBe(false);
			expect(out['gdRouted']).toEqual(GD_FUNCTIONS.map(() => true));
			// the worker copies the constants because nothing can load a class before this runs
			expect(out['gdConstantNames']).toEqual(Object.keys(GD_CONSTANTS));
			expect(out['gdConstants']).toEqual(Object.values(GD_CONSTANTS));
		},
		TIMEOUT
	);

	it(
		'scales, crops and re-encodes an image through the park, with the real decoder',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				await site.runJson(BOOT_KERNEL);
				const internals = site as unknown as {
					runJsonMaybeParked(code: string): Promise<Payload>;
					parkState(): Promise<{ state: string }>;
				};
				await internals.parkState();
				const png = JSON.stringify(DRUPLICON_PNG_BASE64);
				return internals.runJsonMaybeParked(String.raw`<?php
$src = base64_decode(${png});
$img = imagecreatefromstring($src);
$out = ['size' => [imagesx($img), imagesy($img)], 'class' => get_class($img)];
$small = imagescale($img, 16);
ob_start();
$out['pngOk'] = imagepng($small);
$bytes = ob_get_clean();
$info = getimagesizefromstring($bytes);
$out['scaled'] = [$info[0], $info[1], $info['mime']];
$crop = imagecrop($img, ['x' => 4, 'y' => 4, 'width' => 20, 'height' => 10]);
ob_start();
imagejpeg($crop, null, 80);
$info = getimagesizefromstring(ob_get_clean());
$out['cropped'] = [$info[0], $info[1], $info['mime']];
$canvas = imagecreatetruecolor(30, 12);
$out['copy'] = imagecopyresampled($canvas, $img, 0, 0, 0, 0, 30, 12, imagesx($img), imagesy($img));
ob_start();
imagewebp($canvas, null, 70);
$info = getimagesizefromstring(ob_get_clean());
$out['canvas'] = [$info[0], $info[1], $info['mime']];
echo json_encode($out);`);
			});
			expect(out['size']).toEqual([88, 100]);
			expect(out['class']).toBe('Drupal\\drupflare\\Shim\\GdImage');
			expect(out['pngOk']).toBe(true);
			expect(out['scaled']).toEqual([16, 18, 'image/png']);
			expect(out['cropped']).toEqual([20, 10, 'image/jpeg']);
			expect(out['copy']).toBe(true);
			expect(out['canvas']).toEqual([30, 12, 'image/webp']);
		},
		TIMEOUT
	);

	it(
		'runs the callbacks a request queued for shutdown once its render succeeds',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				await site.runJson(BOOT_KERNEL);
				await site.runJson(String.raw`<?php
drupal_register_shutdown_function(function () { $GLOBALS['cfw_shutdown_ran'] = ($GLOBALS['cfw_shutdown_ran'] ?? 0) + 1; });
echo json_encode(['queued' => true]);`);
				const read = () =>
					site.runJson(
						String.raw`<?php echo json_encode(['ran' => $GLOBALS['cfw_shutdown_ran'] ?? 0]);`
					);
				const before = await read();
				const rendered = await site.runJson(renderPage('/', []));
				const after = await read();
				await site.runJson(renderPage('/', []));
				return { before, rendered, after, again: await read() };
			});
			expect(seen.before['ran']).toBe(0);
			expect(seen.rendered['error']).toBeUndefined();
			expect(seen.after['ran']).toBe(1);
			// the queue is emptied, so the next render does not repeat it
			expect(seen.again['ran']).toBe(1);
		},
		TIMEOUT
	);

	it(
		'answers uniqid on a clock that does not move, with a new id every call',
		async () => {
			// a deployed Worker freezes Date.now() for a whole synchronous run; the built-in uniqid
			// polls the clock until it moves, which spun a migrated site's claim to the CPU limit
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.runJson('<?php echo json_encode(true);');
				const real = Date.now;
				const frozen = real();
				let reads = 0;
				Date.now = () => {
					if (++reads > 100_000)
						throw new Error(`uniqid read the frozen clock ${reads} times`);
					return frozen;
				};
				try {
					const ids = String.raw`<?php echo json_encode(['ids' => [uniqid(), uniqid(), uniqid('cfw', true)]]);`;
					return {
						first: await site.runJson(ids),
						second: await site.runJson(ids),
						reads
					};
				} catch (e) {
					return { error: String((e as Error)?.message ?? e), reads };
				} finally {
					Date.now = real;
				}
			});
			expect(out.error, out.error).toBeUndefined();
			const ids = [out.first?.['ids'], out.second?.['ids']].flat() as string[];
			expect(new Set(ids).size, JSON.stringify(out)).toBe(6);
			expect(ids[0]).toMatch(/^[0-9a-f]{13}$/);
			expect(ids[2]).toMatch(/^cfw[0-9a-f]{13}\d\.\d{8}$/);
			// ordered like the built-in, including across runs on one interpreter
			expect(ids[1]! > ids[0]!).toBe(true);
			expect(ids[3]! > ids[1]!).toBe(true);
		},
		TIMEOUT
	);
});
