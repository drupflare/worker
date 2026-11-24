import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../src/drupal/php/site';
import {
	DEFAULT_KAPPA_MS,
	MAX_AHEAD_MS,
	PhpClock,
	clockKappa,
	clockMode,
	installClock
} from '../../src/runtime/virtual-clock';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What PHP's wall clock actually reads inside workerd, and what a caller does to it next.
 *
 * A SECURITY FIX WAS SCHEDULED ON A PREMISE NOBODY HAD MEASURED. RULE 0 records that in-PHP
 * `microtime()` "returns 0 on the edge", and every reading behind that sentence is a DELTA --
 * `steadySeqMs: [0]`, `wallMs: 0`, `/clock`'s own `busyMicrotimeMs`. Workers freeze `Date.now()`
 * between I/O boundaries; frozen is not zero, and the report says so itself two sections away. The
 * ABSOLUTE had never been read out of PHP anywhere, and it is a real epoch.
 *
 * WHAT IS REALLY BROKEN IS THE INT WIDTH, AND IT IS NOT THE CLOCK. `PHP_INT_SIZE` is 4 here, so
 * `(int) (microtime(true) * 1000)` and `(int) round(microtime(true) * 1e6)` -- the two idioms
 * a real module uses -- both overflow and wrap. Measured, the cast is modular rather
 * than saturating: 1787454172276.0 casts to 747777140, exactly `mod 2^32` into a signed range.
 * That reorders the fix: a `cfwNow` host bridge returning `Date.now()` would hand PHP the same
 * float `microtime()` already gives it and change nothing. A 64-bit `zend_long` is what
 * closes it.
 *
 * The two consequences, each the opposite of what was written down:
 *
 *   - a re-authentication window comparing two wrapped millisecond stamps is CORRECT, because both
 *     wrap identically and the difference survives; at a wrap boundary the older stamp is larger,
 *     the age goes negative and an `age >= 0` guard fails CLOSED. Not permanently open.
 *   - a journal refusing a non-positive microsecond stamp is broken for roughly HALF of every
 *     2^32-microsecond cycle -- ~35.8 minutes in every 71.6 -- because that is when the wrap lands
 *     in the negative half. "It never works" and "it works half the time, unpredictably" need
 *     different fixes.
 *
 * WHAT IS STILL TRUE is the freeze, and it is the hazard that actually cost this project 32
 * seconds of billed CPU: a deadline computed and then tested inside ONE invocation never passes,
 * which is why `Lock::wait()` spun for its full 30 s and why `CfwLockBackend` grants instead.
 *
 * A LOCAL READING IS NOT AN EDGE READING and this file does not claim to be one -- miniflare's
 * clock advances where a deployed one does not. What it pins is the clock SOURCE and the int
 * width, neither of which the platform changes: PHP's time comes through the emscripten glue's
 * `_emscripten_date_now = () => Date.now()`, so a frozen edge reading is the same value, held
 * still. `/clock` on `src/probes/min.ts` reports `absoluteS` and `jsAbsoluteMs` for the deployed
 * reading.
 */

type Clock = Record<string, unknown>;

const readClock = (code: string) =>
	inObject(freshSite(), async (site: ServeDo) => site.runJson(code)) as Promise<Clock>;

describe("PHP's wall clock", () => {
	it('is a real epoch, not zero, and agrees with the isolate', async () => {
		const before = Date.now();
		const out = await readClock(
			`<?php echo json_encode([
					'micro' => microtime(true),
					'time' => time(),
					'reqTime' => $_SERVER['REQUEST_TIME'] ?? null,
				]);`
		);
		const after = Date.now();

		// 1.7e9 is 2023-11; anything below it is a clock that did not start at the epoch it
		// claims. The bounds are what stop a frozen-at-boot reading passing as current
		expect(Number(out.micro) * 1000).toBeGreaterThanOrEqual(before - 60_000);
		expect(Number(out.micro) * 1000).toBeLessThanOrEqual(after + 60_000);
		expect(Number(out.time)).toBe(Math.floor(Number(out.micro)));
		expect(Number(out.reqTime)).toBeGreaterThan(1.7e9);
	}, 900_000);

	it('is 64-bit, so an epoch-millisecond cast no longer wraps', async () => {
		const out = await readClock(
			`<?php $m = microtime(true); echo json_encode([
					'intSize' => PHP_INT_SIZE,
					'intMax' => (string) PHP_INT_MAX,
					'reauthMs' => (int) ($m * 1000),
					'journalUs' => (int) round($m * 1e6),
					'fixedCast' => (int) 1787454172276.0,
					'y2038' => (int) 2147483648,
				]);`
		);

		expect(Number(out.intSize)).toBe(8);
		expect(String(out.intMax)).toBe('9223372036854775807');
		// the two module idioms that used to land inside a 32-bit int and look like timestamps.
		// Both now exceed it, which is what makes them storable rather than silently wrong
		expect(Number(out.reauthMs)).toBeGreaterThan(2147483647);
		expect(Number(out.journalUs)).toBeGreaterThan(2147483647);
		// the cast this build used to make MODULAR: 1787454172276 mod 2^32 was 747777140
		expect(Number(out.fixedCast)).toBe(1787454172276);
		expect(Number(out.y2038)).toBe(2147483648);
	}, 900_000);

	it('reports 0 for memory_get_usage, which is a BUILD property and not an edge one', async () => {
		// grouped with `microtime()` in the report as "also reads 0 on the edge". It reads 0
		// HERE, in a lane where the clock demonstrably works, so the two have nothing to do
		// with each other and only one of them is about the platform
		const out = await readClock(
			`<?php echo json_encode([
					'usage' => memory_get_usage(),
					'peak' => memory_get_peak_usage(true),
					'limit' => ini_get('memory_limit'),
				]);`
		);
		expect(Number(out.usage)).toBe(0);
		expect(Number(out.peak)).toBe(0);
		// while the ini entry the same build reports IS meaningful, which is the contrast
		expect(String(out.limit)).toMatch(/^\d+M$/);
	}, 900_000);
});

/**
 * A clock that moves while PHP works, behind `VIRTUAL_CLOCK`.
 *
 * Deployed, `Date.now()` and `performance.now()` hold still across one synchronous `_run()`, so
 * Batch API's one-second yield and the queue loop in `Cron::processQueue()` never fire. A local
 * workerd advances the clock (the first test above reads 773 to 1,168 ms over a busy loop), so the
 * local control arms use `frozen` to reproduce the platform and `simulated` to put the virtual
 * clock over it. Which one a deployed worker matches is the deployed reading's to confirm.
 */
type ClockSource = { now: number };

const frozenSource = (start = 1_700_000_000_000) => {
	const src: ClockSource = { now: start };
	return { src, date: () => src.now, perf: () => src.now - 1_699_000_000_000 };
};

describe('the clock PHP reads', () => {
	it('advances with host calls while the platform clock holds still, and never goes back', () => {
		const p = frozenSource();
		const clock = new PhpClock({
			mode: 'virtual',
			kappaMs: 0.5,
			dateNow: p.date,
			perfNow: p.perf
		});
		const first = clock.date();
		for (let i = 0; i < 100; i++) clock.count();
		const later = clock.date();
		expect(later - first).toBeCloseTo(50, 1);
		// no calls in between, so only the per-read step moves it, and it never repeats
		const a = clock.date();
		const b = clock.date();
		expect(b).toBeGreaterThan(a);
		// the monotonic clock follows the same work
		expect(clock.perf() - p.perf()).toBeGreaterThanOrEqual(50);
	});

	it('is capped at the platform clock plus the maximum lead', () => {
		const p = frozenSource();
		const clock = new PhpClock({
			mode: 'virtual',
			kappaMs: 1,
			dateNow: p.date,
			perfNow: p.perf
		});
		for (let i = 0; i < 200_000; i++) clock.count();
		expect(clock.date() - p.src.now).toBe(MAX_AHEAD_MS);
		expect(clock.aheadMs).toBe(MAX_AHEAD_MS);
		// at the cap it holds, rather than wrapping or running away
		expect(clock.date()).toBe(p.src.now + MAX_AHEAD_MS);
	});

	it('takes the platform clock when it is ahead, and starts each run from it', () => {
		const p = frozenSource();
		const clock = new PhpClock({
			mode: 'virtual',
			kappaMs: 1,
			dateNow: p.date,
			perfNow: p.perf
		});
		p.src.now += 5_000;
		expect(clock.date()).toBe(p.src.now);
		// a run that worked 10 s ahead, then a platform clock that moves past it on I/O
		for (let i = 0; i < 10_000; i++) clock.count();
		const end = clock.date();
		p.src.now += 60_000;
		clock.resync();
		expect(clock.calls).toBe(0);
		expect(clock.total).toBe(10_000);
		expect(clock.date()).toBeCloseTo(p.src.now, 2);
		expect(end).toBeGreaterThan(p.src.now - 60_000);
	});

	it('does not carry one run lead into the next, so a second run sees its own work', () => {
		const p = frozenSource();
		const clock = new PhpClock({
			mode: 'virtual',
			kappaMs: 1,
			dateNow: p.date,
			perfNow: p.perf
		});
		for (let i = 0; i < 15_000; i++) clock.count();
		expect(clock.date() - p.src.now).toBeCloseTo(15_000, 0);
		clock.resync();
		const start = clock.date();
		expect(start - p.src.now).toBeLessThan(1);
		for (let i = 0; i < 1_000; i++) clock.count();
		expect(clock.date() - start).toBeCloseTo(1_000, 0);
	});

	it('holds still in the frozen arm and over a frozen platform in the simulated one', () => {
		const p = frozenSource();
		const frozen = new PhpClock({ mode: 'frozen', dateNow: p.date, perfNow: p.perf });
		for (let i = 0; i < 1_000; i++) frozen.count();
		expect(frozen.date()).toBe(p.src.now);
		const sim = new PhpClock({
			mode: 'simulated',
			kappaMs: 1,
			dateNow: p.date,
			perfNow: p.perf
		});
		p.src.now += 123;
		for (let i = 0; i < 1_000; i++) sim.count();
		// the base is the value at run start, whatever the platform did since
		expect(sim.date() - (p.src.now - 123)).toBeCloseTo(1_000, 0);
	});

	it('reads VIRTUAL_CLOCK and the calibration var, unset is on and anything unknown is off', () => {
		expect(['0', 'no', 'off', 'x'].map((v) => clockMode(v))).toEqual(Array(4).fill('off'));
		expect(['', undefined, '1', 'true', 'ON', 'virtual'].map((v) => clockMode(v))).toEqual(
			Array(6).fill('virtual')
		);
		expect(clockMode('frozen')).toBe('frozen');
		expect(clockMode('simulated')).toBe('simulated');
		expect(clockKappa(undefined)).toBe(DEFAULT_KAPPA_MS);
		expect(clockKappa('-1')).toBe(DEFAULT_KAPPA_MS);
		expect(clockKappa('0.25')).toBe(0.25);
	});

	it('replaces the time imports, counts host calls, and leaves the rest alone', () => {
		const p = frozenSource();
		const clock = new PhpClock({
			mode: 'simulated',
			kappaMs: 1,
			dateNow: p.date,
			perfNow: p.perf
		});
		const seen: unknown[][] = [];
		const table: Record<string, unknown> = {
			emscripten_date_now: () => -1,
			emscripten_get_now: () => -1,
			emscripten_asm_const_int: (...a: unknown[]) => (seen.push(a), 7),
			__syscall_openat: () => 3,
			fd_read: () => 0,
			_abort_js: () => 'untouched',
			invoke_vii: () => 'untouched'
		};
		const abort = table._abort_js;
		installClock({ env: table, wasi_snapshot_preview1: table } as WebAssembly.Imports, clock);
		expect((table.emscripten_asm_const_int as (...a: unknown[]) => unknown)(1, 2)).toBe(7);
		expect(seen).toEqual([[1, 2]]);
		(table.__syscall_openat as () => number)();
		(table.fd_read as () => number)();
		// counted once although `env` and the wasi namespace are the same object
		expect(clock.calls).toBe(3);
		expect((table.emscripten_date_now as () => number)()).toBeCloseTo(p.src.now + 3, 0);
		expect((table.emscripten_get_now as () => number)()).toBeGreaterThan(p.perf());
		expect(table._abort_js).toBe(abort);
		// and a glue without the import is refused rather than left on the platform clock
		expect(() =>
			installClock({ env: { _abort_js: abort } } as WebAssembly.Imports, clock)
		).toThrow(/emscripten_date_now/);
		expect(String((table.invoke_vii as () => string)())).toBe('untouched');
	});
});

type Interp = ServeDo & {
	php?: { php: { clock?: PhpClock } };
};

/** a fresh object with the given vars set before the interpreter boots */
const withVars = <T>(vars: Record<string, string>, fn: (site: Interp) => Promise<T>) =>
	inObject(freshSite(), async (site: ServeDo) => {
		// the vars object is shared by every object in the file, so each run names both and puts them back
		const env = site.env as Record<string, string | undefined>;
		const before = {
			VIRTUAL_CLOCK: env.VIRTUAL_CLOCK,
			VIRTUAL_CLOCK_KAPPA_MS: env.VIRTUAL_CLOCK_KAPPA_MS
		};
		Object.assign(env, { VIRTUAL_CLOCK: '', VIRTUAL_CLOCK_KAPPA_MS: '' }, vars);
		try {
			return await fn(site as Interp);
		} finally {
			Object.assign(env, before);
		}
	});

/** the uniqid() shape: poll the microsecond clock until it changes, with a bound so a spin ends */
const POLL = `<?php
$g0 = gettimeofday(true); $n = 0;
do { $g = gettimeofday(true); $n++; } while ($g == $g0 && $n < 1000);
$m0 = microtime(true); $t0 = time(); $h0 = hrtime(true);
for ($i = 0; $i < 300000; $i++) { $a = microtime(true); $b = time(); $c = hrtime(true); }
echo json_encode(['poll' => $n, 'dm' => microtime(true) - $m0, 'dt' => time() - $t0, 'dh' => (hrtime(true) - $h0) / 1e6]);`;

describe('the clock PHP reads, in the interpreter', () => {
	it('is held still by the frozen arm, which is how the platform reads one run', async () => {
		const out = (await withVars({ VIRTUAL_CLOCK: 'frozen' }, (site) =>
			site.runJson(POLL)
		)) as Record<string, number>;
		console.log(`[clock] frozen ${JSON.stringify(out)}`);
		// 900,000 reads and a poll that never sees a new microsecond
		expect(out.dm).toBe(0);
		expect(out.dt).toBe(0);
		expect(out.dh).toBe(0);
		expect(out.poll).toBe(1000);
	}, 900_000);

	it('finishes a poll for the next microsecond on its first read when simulated', async () => {
		const out = (await withVars({ VIRTUAL_CLOCK: 'simulated' }, (site) =>
			site.runJson(POLL)
		)) as Record<string, number>;
		console.log(`[clock] simulated ${JSON.stringify(out)}`);
		expect(out.poll).toBe(1);
		// 600,000 epoch reads and 300,000 monotonic reads at one microsecond each
		expect(out.dm).toBeGreaterThan(0.55);
		expect(out.dm).toBeLessThan(0.7);
		expect(out.dh).toBeGreaterThan(250);
		expect(out.dh).toBeLessThan(350);
		expect(out.dt).toBeGreaterThanOrEqual(0);
	}, 900_000);

	it('installs nothing when VIRTUAL_CLOCK is off, which is the control', async () => {
		const out = await withVars({ VIRTUAL_CLOCK: '0' }, async (site) => {
			const d0 = Date.now();
			const run = (await site.runJson(POLL)) as Record<string, number>;
			return { run, hasClock: site.php?.php.clock !== undefined, tsMs: Date.now() - d0 };
		});
		console.log(`[clock] off ${JSON.stringify(out)}`);
		expect(out.hasClock).toBe(false);
		// the local platform clock moves, so the loop reads real time; the poll is not asserted
		// because that clock ticks in whole milliseconds and 1,000 reads can fit inside one
		expect(out.run.dh).toBeGreaterThan(0);
	}, 900_000);

	it('stops at the cap, and the worker TypeScript clock is untouched', async () => {
		const out = await withVars(
			{ VIRTUAL_CLOCK: 'simulated', VIRTUAL_CLOCK_KAPPA_MS: '1' },
			async (site) => {
				const d0 = Date.now();
				const p0 = performance.now();
				const run = (await site.runJson(`<?php
$m0 = microtime(true);
for ($i = 0; $i < 90000; $i++) { clearstatcache(); file_exists('/nope'); }
echo json_encode(['dm' => microtime(true) - $m0]);`)) as Record<string, number>;
				return { run, tsMs: Date.now() - d0, perfMs: performance.now() - p0 };
			}
		);
		console.log(`[clock] cap ${JSON.stringify(out)}`);
		// 90,000 calls at 1 ms would be 90 s; the lead stops at 60 s
		expect(out.run.dm).toBeGreaterThan(59.9);
		expect(out.run.dm).toBeLessThanOrEqual(60.01);
		// the isolate's own clocks saw the real, short run
		expect(out.tsMs).toBeLessThan(30_000);
		expect(out.perfMs).toBeLessThan(30_000);
	}, 900_000);

	it('starts every run from the platform clock and counts its calls from zero', async () => {
		const out = await withVars({ VIRTUAL_CLOCK: 'simulated' }, async (site) => {
			await site.runJson('<?php echo json_encode(1);');
			const clock = site.php?.php.clock as PhpClock;
			const t0 = clock.total;
			await site.runJson(
				`<?php for ($i = 0; $i < 500; $i++) { file_exists('/nope'); } echo json_encode(1);`
			);
			const worked = clock.total - t0;
			await site.runJson('<?php echo json_encode(1);');
			return { worked, afterIdleRun: clock.calls };
		});
		expect(out.worked).toBeGreaterThanOrEqual(500);
		expect(out.afterIdleRun).toBeLessThan(50);
	}, 900_000);
});

const ITEMS = 2400;

/** core's own `Cron::processQueue()` over a real database queue, with a worker that burns host calls */
const QUEUE = String.raw`
$queue = \Drupal::queue('cfw_clock_probe', true);
$queue->createQueue();
for ($i = 0; $i < ${ITEMS}; $i++) { $queue->createItem(['i' => $i]); }
$worker = new class implements \Drupal\Core\Queue\QueueWorkerInterface {
  public int $done = 0;
  public function getPluginId() { return 'cfw_clock_probe'; }
  public function getPluginDefinition() { return ['cron' => ['time' => 15]]; }
  public function processItem($data) { for ($k = 0; $k < 400; $k++) { clearstatcache(); file_exists('/drupal/index.php'); } $this->done++; }
};
$cron = \Drupal::service('cron');
$m = new ReflectionMethod($cron, 'processQueue');
$v0 = microtime(true);
$m->invoke($cron, $queue, $worker);
$out['queue'] = ['processed' => $worker->done, 'left' => (int) $queue->numberOfItems(), 'seconds' => microtime(true) - $v0];
$queue->deleteQueue();
`;

/** core's own `_batch_process()` over 200 operations of 2,500 host calls each */
const BATCH = String.raw`
require_once \Drupal::root() . '/core/includes/form.inc';
require_once \Drupal::root() . '/core/includes/batch.inc';
function cfw_clock_op(&$context) { for ($k = 0; $k < 2500; $k++) { clearstatcache(); file_exists('/drupal/index.php'); } $context['results'][] = 1; }
$ops = [];
for ($i = 0; $i < 200; $i++) { $ops[] = ['cfw_clock_op', []]; }
batch_set(['operations' => $ops, 'title' => 'clock']);
$batch = &batch_get();
$batch += ['current_set' => 0, 'progressive' => true, 'id' => 'cfwclock' . mt_rand()];
_batch_populate_queue($batch, 0);
$v0 = microtime(true);
_batch_process();
$set = _batch_current_set();
$out['batch'] = ['ran' => 200 - (int) ($set['count'] ?? 0), 'seconds' => microtime(true) - $v0];
`;

/** the places that read the clock, set and read back in one request, with no waiting on the clock */
const SAFETY = String.raw`
$c = \Drupal::cache('default');
$mem = \Drupal::cache('menu');
$c->set('cfw_clock_ttl', 'v', time() + 3600);
$c->set('cfw_clock_perm', 'v', \Drupal\Core\Cache\Cache::PERMANENT);
$mem->set('cfw_clock_ttl', 'v', time() + 3600);
$lock = \Drupal::lock();
$out['lock'] = [$lock->acquire('cfw_clock_l', 30), $lock->lockMayBeAvailable('cfw_clock_l')];
$lock->release('cfw_clock_l');
$out['lockReleased'] = $lock->lockMayBeAvailable('cfw_clock_l');
\Drupal::state()->set('system.cron_last', time());
$out['cron'] = ['stamp' => (int) \Drupal::state()->get('system.cron_last'), 'now' => time(), 'request' => (int) \Drupal::time()->getRequestTime()];
$out['classes'] = [get_class($c), get_class($mem), get_class($lock)];
$out['sameRun'] = [$c->get('cfw_clock_ttl') ? 'hit' : 'miss', $c->get('cfw_clock_perm') ? 'hit' : 'miss', $mem->get('cfw_clock_ttl') ? 'hit' : 'miss'];
`;

/** four seconds of work on the clock, which only a clock that moves can end */
const SPIN = String.raw`
$c = \Drupal::cache('default');
$mem = \Drupal::cache('menu');
$c->set('cfw_clock_short', 'v', time() + 2);
$mem->set('cfw_clock_short', 'v', time() + 2);
$v0 = microtime(true);
while (microtime(true) - $v0 < 4) { for ($k = 0; $k < 500; $k++) { file_exists('/nope'); } }
$out['afterWork'] = [$c->get('cfw_clock_short') ? 'hit' : 'miss', $mem->get('cfw_clock_short') ? 'hit' : 'miss'];
`;

const PREAMBLE = String.raw`
\Drupal::moduleHandler()->loadAll();
if (\Drupal::getContainer()->has('drupflare.request_resetter')) { \Drupal::service('drupflare.request_resetter')->reset(); }
$req = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
$req->server->set('SERVER_SOFTWARE', 'Cloudflare Workers');
$req->server->set('REQUEST_TIME', time());
\Drupal::service('request_stack')->push($req);
`;

type Bound = {
	queue: { processed: number; left: number; seconds: number };
	batch: { ran: number; seconds: number };
	safety: Record<string, unknown>;
};

/** the three probes on one provisioned site under one clock arm */
async function bounds(mode: string, spin = false): Promise<Bound> {
	return withVars({ VIRTUAL_CLOCK: mode }, async (site) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		const op = async (body: string) =>
			(await site.runJson(drupalOp(PREAMBLE + body))) as Record<string, any>;
		const q = await op(QUEUE);
		const b = await op(BATCH);
		const s = await op(SAFETY);
		// it waits on the clock, so a frozen one would never end it
		if (spin) s.spin = (await op(SPIN)).afterWork;
		return { queue: q.queue, batch: b.batch, safety: s };
	});
}

describe("Drupal's own time bounds", () => {
	it('never fire on a frozen clock: the queue drains and the batch runs to the operation cap', async () => {
		const out = await bounds('frozen');
		console.log(`[bounds] frozen ${JSON.stringify(out)}`);
		expect(out.queue.processed).toBe(ITEMS);
		expect(out.queue.left).toBe(0);
		expect(out.queue.seconds).toBe(0);
		// `cfw_batch_yield()` ends a progressive request at 20 operations
		expect(out.batch.ran).toBe(20);
	}, 900_000);

	it('fire on the virtual clock: the queue stops near its 15 s lease and the batch yields near 1 s', async () => {
		const out = await bounds('simulated');
		console.log(`[bounds] simulated ${JSON.stringify(out)}`);
		expect(out.queue.processed).toBeGreaterThan(0);
		expect(out.queue.processed).toBeLessThan(ITEMS);
		expect(out.queue.left).toBe(ITEMS - out.queue.processed);
		// `time()` is whole seconds, so the loop ends between 14 and 15 s past its start, plus one item
		expect(out.queue.seconds).toBeGreaterThanOrEqual(14);
		expect(out.queue.seconds).toBeLessThan(15.5);
		// a few operations of about 0.3 s each, against the 20-operation cap above
		expect(out.batch.ran).toBeGreaterThanOrEqual(3);
		expect(out.batch.ran).toBeLessThan(20);
		expect(out.batch.seconds).toBeGreaterThan(1);
		expect(out.batch.seconds).toBeLessThan(2);
	}, 900_000);

	it('runs the same probes on the platform clock with the feature off, which is the control', async () => {
		const out = await bounds('0');
		console.log(`[bounds] off ${JSON.stringify(out)}`);
		// a local workerd advances its clock, but 2,400 short items finish well inside 15 s of it
		expect(out.queue.processed).toBe(ITEMS);
		expect(out.batch.ran).toBe(20);
	}, 900_000);

	it('leaves cache TTLs, locks and the cron stamp behaving as a real clock would', async () => {
		const frozen = (await bounds('frozen')).safety as Record<string, any>;
		const out = (await bounds('simulated', true)).safety as Record<string, any>;
		console.log(`[bounds] safety frozen ${JSON.stringify(frozen)}`);
		console.log(`[bounds] safety simulated ${JSON.stringify(out)}`);
		// the same answers as the clock that never moves, for everything that is not a time value
		for (const key of ['sameRun', 'lock', 'lockReleased', 'classes']) {
			expect(out[key], key).toEqual(frozen[key]);
		}
		expect(out.sameRun).toEqual(['hit', 'hit', 'hit']);
		// the stamp is a request-scale time, and cron's own stamp is the request time
		expect(Math.abs(out.cron.stamp - out.cron.now)).toBeLessThanOrEqual(1);
		expect(out.cron.now - out.cron.request).toBeLessThanOrEqual(MAX_AHEAD_MS / 1000);
		expect(out.cron.stamp - frozen.cron.stamp).toBeLessThan(120);
		// four seconds of work later: the database bin compares against the request time, so a 2 s
		// entry is still there; the memory bin compares against the clock, so it is gone, as it
		// would be on a platform whose clock moved
		expect(out.spin).toEqual(['hit', 'miss']);
	}, 900_000);
});
