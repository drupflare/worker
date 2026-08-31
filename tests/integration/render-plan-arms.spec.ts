import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import planSrc from '../../scripts/bench/pw-plan-replay.php?raw';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What compiling each render subsystem away is worth ON THE SHIPPING INTERPRETER.
 *
 * `pw-plan-replay.php` records one render's decorated calls, keyed by identity plus
 * occurrence, and replays them on later renders. An arm's saving is the ceiling for a
 * perfect compiled plan for that subsystem -- not an estimate of any implementation, and not
 * transferable from the native measurement, because the per-bucket wasm multipliers run from
 * 2.9x to 20x.
 *
 * `bytes` is the check that decides whether an arm means anything. Two arms reproduce the
 * page and three do not, and the ones that do not are the result rather than a bug: Drupal's
 * render pipeline passes bubbled `#attached` and cacheability back through the ARGUMENT, so
 * replaying a return value loses what the parent needed and the head comes out short.
 *
 * `DRUPFLARE_MEASURE=1 bunx vitest run --project=workers tests/integration/render-plan-arms.spec.ts`
 */

const TIMEOUT = 900_000;
const MEASURING = (env as { DRUPFLARE_MEASURE?: string }).DRUPFLARE_MEASURE === '1';
const N = 20;
const ROUTE = '/user/login';
const ON_DPC = (env as { DRUPFLARE_PLAN_ON_DPC?: string }).DRUPFLARE_PLAN_ON_DPC === '1';
const BUCKETS = ['assets', 'contexts', 'render_cache', 'theme', 'renderer', 'attach'] as const;

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const php = (body: string) => `<?php\n${body}\n`;

const INSTALL = php(`
file_put_contents('/drupal/pw-plan-replay.php', base64_decode('${b64(planSrc)}'));
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
require_once '/drupal/pw-plan-replay.php';
$out['install'] = pw_install_plan();
PlanReplay::reset();
echo json_encode($out);
`);

const setArm = (on: readonly string[], recording = false) =>
	php(`
PlanReplay::$on = ${on.length ? `array_fill_keys(${JSON.stringify(on).replace(/"/g, "'")}, true)` : '[]'};
PlanReplay::$missed = [];
PlanReplay::$recording = ${recording ? 'true' : 'false'};
echo json_encode(PlanReplay::stats());
`);

describe.skipIf(!MEASURING)('what a compiled render plan is worth in wasm, per subsystem', () => {
	it(
		'replays each recorded subsystem and reports its saving and whether the page survived',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const first = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ adminPass: 'cfw-Plan-4417-pass', siteName: 'Plan' })
					})
				);
				expect(first.status, await first.clone().text()).toBe(200);

				const install = await site.runJson(INSTALL);
				const both = ['page', 'dynamic_page_cache'];
				// ON TOP OF A DYNAMIC-PAGE-CACHE HIT when asked for, because that is the
				// combination nothing has measured: `dynamic_page_cache` already replays the
				// render array, so the question is what a plan adds to a request that is already
				// hitting it rather than what it adds to a fresh render
				const fill = async () => {
					if (ON_DPC) await site.fillOne(ROUTE, both);
					return (await site.fillOne(
						ROUTE,
						ON_DPC ? ['page'] : both
					)) as unknown as Record<string, unknown>;
				};

				for (let i = 0; i < 3; i++) await fill();

				// the recording pass
				await site.runJson(setArm([], true));
				await fill();
				const recorded = await site.runJson(setArm([]));

				const arms: Record<string, readonly string[]> = { base: [] };
				for (const b of BUCKETS) arms[b] = [b];
				// the pair that tests whether the BUBBLE is what a return-value plan was missing
				arms['theme+attach'] = ['theme', 'attach'];
				// every bucket that keeps the page intact: the compiled-plan ceiling with a
				// correct page. `renderer` is left out because replaying it does not produce one
				arms.plan = ['theme', 'attach', 'assets', 'contexts', 'render_cache'];
				arms.all = BUCKETS;
				const names = Object.keys(arms);

				const samples: Record<string, number[]> = {};
				const bytes: Record<string, number> = {};
				const missed: Record<string, unknown> = {};
				for (const k of names) samples[k] = [];

				for (let i = 0; i < N; i++) {
					const order = i % 2 === 0 ? names : [...names].reverse();
					for (const k of order) {
						await site.runJson(setArm(arms[k]!));
						const r = await fill();
						samples[k]!.push(Number(r.renderMs ?? -1));
						bytes[k] = Number(r.bytes ?? 0);
						const s = await site.runJson(setArm(arms[k]!));
						missed[k] = (s as { missed?: unknown }).missed;
					}
				}
				await site.runJson(setArm([]));
				return { install, recorded, samples, bytes, missed };
			});

			const stat = (ms: number[]) => {
				const s = [...ms].sort((a, b) => a - b);
				const q = (p: number) => s[Math.floor(p * (s.length - 1))];
				return { min: q(0)!, p25: q(0.25)!, median: q(0.5)! };
			};
			const base = stat(out.samples.base!);
			const rows = Object.fromEntries(
				Object.entries(out.samples).map(([k, v]) => {
					const s = stat(v);
					return [
						k,
						{
							...s,
							bytes: out.bytes[k],
							pageIntact: Math.abs(out.bytes[k]! - out.bytes.base!) <= 8,
							savingMin: base.min - s.min,
							savingP25: base.p25 - s.p25,
							savingMedian: base.median - s.median,
							missed: out.missed[k]
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
						onDpc: ON_DPC,
						install: out.install,
						recorded: out.recorded,
						arms: rows
					},
					null,
					2
				)
			);

			expect((out.install as { install?: Record<string, string> }).install).toBeTruthy();
			// the base arm must be the unmodified render, or every saving is measured against a
			// treatment
			expect(rows.base!.savingMin).toBe(0);
			expect(rows.base!.bytes).toBeGreaterThan(2000);
		},
		TIMEOUT
	);
});

/**
 * The replay instrument itself, over one arm and with no clock read.
 *
 * The saving per subsystem is a timing and stays off the gate. Whether `pw-plan-replay.php` still
 * installs its decorators, records a render's calls and replays them into an intact page is not a
 * timing, and it is the precondition every row of that table rests on -- an arm whose decorators
 * failed to install reports a saving of zero and reads as a subsystem not worth compiling.
 */
describe('the subsystem replay records and replays', () => {
	it(
		'installs the decorators, records one render and replays it into the same page',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const install = (await site.runJson(INSTALL)) as {
					install?: Record<string, string>;
				};
				const both = ['page', 'dynamic_page_cache'];
				const fill = async () =>
					(await site.fillOne(ROUTE, both)) as unknown as Record<string, unknown>;

				await fill();
				await site.runJson(setArm([], true));
				await fill();
				const recorded = (await site.runJson(setArm([]))) as {
					recorded?: Record<string, number>;
				};

				const base = await fill();
				// the pair that keeps the page intact; `renderer` is the one that does not, which is
				// why the measurement's `plan` arm leaves it out
				await site.runJson(setArm(['theme', 'attach']));
				const replayed = await fill();
				await site.runJson(setArm([]));

				return { install: install.install, recorded, base, replayed };
			});

			expect(out.install).toBeTruthy();
			// a decorator reported as already swapped is a bucket that under-reports, which is the
			// failure the measurement's own docblock names
			for (const [name, status] of Object.entries(out.install ?? {})) {
				expect(String(status), name).not.toContain('preexisting');
			}
			const recorded = out.recorded.recorded ?? {};
			// every bucket the arms below draw from has to have something recorded in it, or its
			// saving is the cost of replaying nothing
			for (const bucket of BUCKETS) {
				expect(Number(recorded[bucket] ?? 0), bucket).toBeGreaterThan(0);
			}
			expect(Number(out.base.bytes ?? 0)).toBeGreaterThan(2000);
			// replaying the recorded calls reproduces the page rather than a short one, which is
			// what makes an arm's saving a saving rather than a missing region
			expect(
				Math.abs(Number(out.replayed.bytes ?? 0) - Number(out.base.bytes ?? 0))
			).toBeLessThanOrEqual(8);
		},
		TIMEOUT
	);
});
