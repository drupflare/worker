import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import probeSrc from '../../assets/probe/pw-probe.php?raw';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Attributes a wasm render to named buckets, on the SHIPPING interpreter, through the real
 * `fillOne()` path.
 *
 * The previous instrument for this was a throwaway. Rebuilt here because every lever in the
 * render-performance work has to be priced in wasm and not in native: the per-bucket
 * multipliers run from 2.9x to 20x, so a native ratio does not transfer.
 *
 * Two things this has to get right, both of which produce a confident wrong table when they
 * are wrong:
 *
 * - The probes must be installed BEFORE any service has been handed out. `/__firstrun` drops
 *   the interpreter when it finishes, so the first PHP after it is this fragment: it boots
 *   the kernel itself, installs the decorators, and reports the swap status per service. A
 *   `preexisting` anywhere means that bucket under-reports and the run says so.
 * - workerd's clock is 1 ms granular, so a bucket worth 0.3 ms per render reads 0 or 1. The
 *   buckets are accumulated over N renders without resetting; `totalMs` doubles as the tick
 *   count and is the precision of the row beside it.
 *
 * `DRUPFLARE_MEASURE=1 bunx vitest run --project=workers tests/integration/render-buckets.spec.ts`
 */

const TIMEOUT = 900_000;
const MEASURING = (env as { DRUPFLARE_MEASURE?: string }).DRUPFLARE_MEASURE === '1';
const N = 30;
const ROUTE = '/user/login';

const php = (body: string) => `<?php\n${body}\n`;

/** boots the kernel this fragment will keep, then decorates it */
// base64 rather than the json_decode() form the rest of this repo uses: the probe source is
// full of `$var`, and a PHP double-quoted literal interpolates those, so the fragment parsed
// as a syntax error rather than as a string
const INSTALL = php(`
$src = base64_decode('${Buffer.from(probeSrc, 'utf8').toString('base64')}');
file_put_contents('/drupal/pw-probe.php', $src);
chdir('/drupal');
$out = [];
if (!isset($GLOBALS['__pw_autoloader'])) {
  $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
}
$autoloader = $GLOBALS['__pw_autoloader'];
$out['kernelPreexisting'] = isset($GLOBALS['__pw_kernel']) ? 1 : 0;
if (!isset($GLOBALS['__pw_kernel'])) {
  $request = \\Symfony\\Component\\HttpFoundation\\Request::create('/', 'GET');
  $kernel = new \\Drupal\\Core\\DrupalKernel('prod', $autoloader);
  \\Drupal\\Core\\DrupalKernel::bootEnvironment();
  $sitePath = \\Drupal\\Core\\DrupalKernel::findSitePath($request);
  $kernel->setSitePath($sitePath);
  \\Drupal\\Core\\Site\\Settings::initialize('/drupal', $sitePath, $autoloader);
  $kernel->boot();
  $GLOBALS['__pw_kernel'] = $kernel;
}
require_once '/drupal/pw-probe.php';
// NO class_alias(Fiber::class, 'PhpWasmSyncFiber') here, which the native scripts do: this
// build has no working Fiber and aliasing the real one aborts the module with
// "missing function: getcontext". FIBER_SHIM in the render fragment supplies the real one
$out['probes'] = pw_install_probes();
$out['clock'] = pw_clock_granularity();
PwProf::$on = false;
PwProf::reset();
echo json_encode($out);
`);

const ARM_START = php(`
PwProf::reset();
PwProf::$on = true;
echo json_encode(['on' => 1]);
`);

const ARM_REPORT = php(`
PwProf::$on = false;
echo json_encode(PwProf::report());
`);

/**
 * What the JSON result boundary costs, which `renderMs` includes and nothing had priced.
 *
 * The render's HTML leaves PHP as `echo json_encode($out)`, arrives in JS as output events, is
 * joined and then `JSON.parse`d. That is three passes over ~18 KB plus the escape expansion.
 * The PHP half is measured here because it is the half inside `renderMs`; the JS half is
 * outside it and outside any clock this side can read.
 */
const JSON_COST = php(`
$html = str_repeat('<div class="x">a "quoted" & <escaped> run</div>', 400);
$out = ['html' => $html, 'status' => 200, 'bytes' => strlen($html)];
$n = 200;
$a = microtime(true);
for ($i = 0; $i < $n; $i++) { $enc = json_encode($out); }
$b = microtime(true);
$c = microtime(true);
for ($i = 0; $i < $n; $i++) { $len = strlen($out['html']); }
$d = microtime(true);
echo json_encode([
  'htmlBytes' => strlen($html),
  'encodedBytes' => strlen($enc),
  'n' => $n,
  'encodeMsPerCall' => round((($b - $a) - ($d - $c)) * 1000 / $n, 4),
]);
`);

/**
 * What one `microtime(TRUE)` costs here, which is the profiler's own unit of dilution.
 *
 * `PwProf` reads the clock twice per bucket entry and a render makes ~200 of them, so a clock
 * that is a host call rather than a register read shows up as most of the instrumented render.
 * Measured over a large loop, where the 1 ms granularity stops mattering.
 */
const CLOCK_COST = php(`
$n = 200000;
$a = microtime(true);
for ($i = 0; $i < $n; $i++) { microtime(true); }
$b = microtime(true);
$c = microtime(true);
for ($i = 0; $i < $n; $i++) { }
$d = microtime(true);
echo json_encode([
  'n' => $n,
  'loopWithCallMs' => round(($b - $a) * 1000, 3),
  'emptyLoopMs' => round(($d - $c) * 1000, 3),
  'perCallUs' => round((($b - $a) - ($d - $c)) * 1e6 / $n, 4),
]);
`);

type Report = {
	buckets: Record<string, { ms: number; calls: number }>;
	extra: Record<string, number>;
	sumMs: number;
	stackDepth: number;
};

describe.skipIf(!MEASURING)('where a wasm render spends its time, per bucket', () => {
	it(
		'attributes a full render and a dynamic-page-cache hit on the shipping interpreter',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const first = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							adminPass: 'cfw-Bucket-7741-pass',
							siteName: 'Bucket'
						})
					})
				);
				expect(first.status, await first.clone().text()).toBe(200);

				const install = await site.runJson(INSTALL);
				const clock = await site.runJson(CLOCK_COST);
				const jsonCost = await site.runJson(JSON_COST);
				const both = ['page', 'dynamic_page_cache'];

				// warm: templates compiled, statics filled, the render bin populated
				for (let i = 0; i < 3; i++) await site.fillOne(ROUTE, both);

				// the dilution, measured rather than assumed: the same renders with the decorators
				// in place and the profiler off, against the profiler on
				const renderMsOver = async (on: boolean) => {
					await site.runJson(
						php(`PwProf::$on = ${on ? 'true' : 'false'}; echo json_encode([1]);`)
					);
					const ms: number[] = [];
					for (let i = 0; i < N; i++) {
						const r = (await site.fillOne(ROUTE, both)) as unknown as Record<
							string,
							unknown
						>;
						ms.push(Number(r.renderMs ?? -1));
					}
					ms.sort((a, b) => a - b);
					return {
						min: ms[0],
						p25: ms[Math.floor(0.25 * (N - 1))],
						median: ms[Math.floor(0.5 * (N - 1))]
					};
				};
				const decoratedOff = await renderMsOver(false);
				const decoratedOn = await renderMsOver(true);

				const arm = async (bins: string[], warm: () => Promise<unknown>) => {
					await warm();
					await site.runJson(ARM_START);
					for (let i = 0; i < N; i++) {
						await warm();
						await site.fillOne(ROUTE, bins);
					}
					return (await site.runJson(ARM_REPORT)) as unknown as Report;
				};

				const noop = async () => {};
				const full = await arm(both, noop);
				// each dpc sample needs dynamic_page_cache repopulated first, and that render must
				// not be inside the accumulation, so the warm-up runs with the profiler off
				const dpc = await arm(['page'], async () => {
					await site.runJson(php('PwProf::$on = false; echo json_encode([1]);'));
					await site.fillOne(ROUTE, both);
					await site.runJson(php('PwProf::$on = true; echo json_encode([1]);'));
				});
				const last = (await site.fillOne(ROUTE, ['page'])) as unknown as Record<
					string,
					unknown
				>;
				return { install, clock, jsonCost, decoratedOff, decoratedOn, full, dpc, last };
			});

			if (!out.full?.buckets || !out.dpc?.buckets) {
				// eslint-disable-next-line no-console
				console.log(JSON.stringify(out, null, 2).slice(0, 4000));
			}
			// two clock reads per bucket entry, priced by the loop above, subtracted from the
			// bucket that made them. Without it a bucket is ranked by how many times it was
			// entered rather than by what it cost: `cache_contexts` enters ~117 times a render
			// and `assets.resolve` 3
			const perCallUs = Number((out.clock as { perCallUs?: number }).perCallUs ?? 0);
			const table = (r: Report) =>
				Object.fromEntries(
					Object.entries(r.buckets).map(([k, v]) => {
						const probeMs = (2 * v.calls * perCallUs) / 1000;
						return [
							k,
							{
								msPerRender: +(v.ms / N).toFixed(3),
								correctedMsPerRender: +((v.ms - probeMs) / N).toFixed(3),
								probeMsPerRender: +(probeMs / N).toFixed(3),
								totalMs: v.ms,
								calls: +(v.calls / N).toFixed(1)
							}
						];
					})
				);

			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						n: N,
						route: ROUTE,
						install: out.install,
						clock: out.clock,
						jsonCost: out.jsonCost,
						dilution: { decoratedOff: out.decoratedOff, decoratedOn: out.decoratedOn },
						full: {
							attributedMsPerRender: +(out.full.sumMs / N).toFixed(3),
							stackDepth: out.full.stackDepth,
							buckets: table(out.full),
							extra: out.full.extra
						},
						dpc: {
							attributedMsPerRender: +(out.dpc.sumMs / N).toFixed(3),
							stackDepth: out.dpc.stackDepth,
							buckets: table(out.dpc),
							extra: out.dpc.extra
						},
						lastDynamicCache: out.last.dynamicCache
					},
					null,
					2
				)
			);

			// a decorator that threw without unwinding makes every number untrustworthy
			expect(out.full.stackDepth).toBe(0);
			expect(out.dpc.stackDepth).toBe(0);
			// and a bucket table built on services that were already handed out under-reports
			const statuses = Object.values(
				(out.install as { probes?: Record<string, string> }).probes ?? {}
			);
			expect(statuses.length).toBeGreaterThan(0);
			expect(statuses.filter((s) => s === 'swapped').length).toBe(statuses.length);
		},
		TIMEOUT
	);
});

/**
 * The profiler itself, over one render and with nothing read off its clock.
 *
 * The attribution table is a timing and stays off the gate; whether the decorators still swap in
 * cleanly, still enter their buckets and still unwind is not. Both failures the docblock above
 * names -- a `preexisting` swap and a non-zero stack depth -- produce a table that looks complete
 * and is wrong, and neither needs the clock to detect.
 */
describe('the bucket profiler attributes a render', () => {
	it(
		'swaps every probe in, fills named buckets and unwinds',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const install = (await site.runJson(INSTALL)) as {
					probes?: Record<string, string>;
					kernelPreexisting?: number;
				};
				const both = ['page', 'dynamic_page_cache'];
				await site.fillOne(ROUTE, both);
				await site.runJson(ARM_START);
				await site.fillOne(ROUTE, both);
				const report = (await site.runJson(ARM_REPORT)) as unknown as Report;
				return { install, report };
			});

			// the probes have to have been installed before any service was handed out
			expect(out.install.kernelPreexisting).toBe(0);
			const statuses = Object.values(out.install.probes ?? {});
			expect(statuses.length).toBeGreaterThan(0);
			expect(statuses.filter((s) => s === 'swapped').length).toBe(statuses.length);

			// a decorator that threw without unwinding makes every number untrustworthy
			expect(out.report.stackDepth).toBe(0);
			// and the buckets have to have been ENTERED, which is the half a stack depth of 0 also
			// reports for a profiler that ran nothing at all
			const entered = Object.entries(out.report.buckets).filter(([, v]) => v.calls > 0);
			expect(entered.length, JSON.stringify(out.report.buckets)).toBeGreaterThan(0);
			for (const [name, v] of entered) {
				expect(Number.isFinite(v.ms), name).toBe(true);
				expect(v.ms, name).toBeGreaterThanOrEqual(0);
			}
		},
		TIMEOUT
	);
});
