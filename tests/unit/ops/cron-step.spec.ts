import { describe, expect, it } from 'vitest';
import { cronHookList, runCronHook, runCronQueue } from '../../../src/drupal/cron-php';
import {
	advanceCursor,
	CRON_HOOKS,
	cronAlarmDelayMs,
	cronHooksFor,
	cronHooksFromList,
	cronUnits,
	HIBERNATION_IDLE_MS,
	idleRearmMs,
	keepWarmMs,
	KNOWN_CRON_HOOKS,
	queueBatchSize,
	readCursor,
	siteWarmEnabled,
	skippedCronHooks,
	warmIntervalMs,
	writeCursor
} from '../../../src/ops/cron';

describe('cronUnits: the chain and what it omits', () => {
	const units = cronUnits();
	const ids = units.map((u) => u.id);

	it('puts the three SQL GC units first, before anything can enter PHP', () => {
		expect(ids.slice(0, 3)).toEqual(['gc:watchdog', 'gc:cachedata', 'gc:expired']);
	});

	it.each([
		["file's cron runs", 'hook:file', true],
		["layout_builder's cron runs", 'hook:layout_builder', true],
		["update's cron runs, so something drains the fetch queue", 'hook:update', true],
		["announcements_feed's cron runs", 'hook:announcements_feed', true],
		["system's cron runs, so advisories are fetched", 'hook:system', true],
		["dblog's cron does NOT run", 'hook:dblog', false]
	])('%s', (_label, id, present) => {
		expect(ids.includes(id)).toBe(present);
	});

	it('closes the round with the queue and then cron_last', () => {
		expect(ids[ids.length - 2]).toBe('queue');
		expect(ids[ids.length - 1]).toBe('cron_last');
	});

	it('is twelve units: four pure SQL, eight that may enter PHP', () => {
		expect(units).toHaveLength(12);
		expect(units.filter((u) => u.kind === 'sql')).toHaveLength(4);
		// six hooks, the advisory scan and the queue; the queue only enters PHP when SQL says there
		// is work. `advisories` carries no module because the drupflare hook it would have been is
		// not in the container the pack ships
		expect(units.filter((u) => u.kind === 'php')).toHaveLength(8);
		expect(units.filter((u) => u.module)).toHaveLength(6);
		expect(units.map((u) => u.id)).toContain('advisories');
	});

	it('never runs a hook for a module the site does not have', () => {
		// `module` is optional on a unit, so the filter narrows it before the lookup
		const named = units.map((u) => u.module).filter((m): m is string => typeof m === 'string');
		expect(named.every((m) => KNOWN_CRON_HOOKS.includes(m))).toBe(true);
	});
});

describe('the skip policy carries its reasons', () => {
	const skipped = skippedCronHooks();

	it('skips one of the six implementations', () => {
		expect(Object.keys(skipped)).toHaveLength(1);
	});

	it('gives every skip a real reason rather than a flag', () => {
		expect(Object.values(skipped).every((v) => String(v).length > 10)).toBe(true);
	});

	// the three that used to be skipped for "outbound HTTPS; there is no socket". The wrapper and
	// CachedFetchHandler's deferral answer that now, and a site whose update hook never fires has
	// no update data and no security advisories at all
	it.each(['update', 'announcements_feed', 'system'])('%s is no longer skipped', (hook) => {
		expect(skipped[hook]).toBeUndefined();
	});

	it("dblog's reason names the SQL pass that replaced it", () => {
		expect(skipped.dblog).toMatch(/gc:watchdog/);
	});

	it('still honours an explicit skip from the caller', () => {
		const units = cronUnits({
			hookPolicy: { system: { run: false, reason: 'off for this site' } }
		});
		expect(units.some((u) => u.module === 'system')).toBe(false);
	});

	it('accounts for every known hook, so a new one cannot be silently dropped', () => {
		const accounted = new Set([
			...cronUnits()
				.filter((u) => u.module)
				.map((u) => u.module),
			...Object.keys(skippedCronHooks())
		]);
		for (const hook of KNOWN_CRON_HOOKS) expect(accounted.has(hook)).toBe(true);
	});

	it('CRON_HOOKS and KNOWN_CRON_HOOKS agree on the surface', () => {
		expect(Array.isArray(KNOWN_CRON_HOOKS)).toBe(true);
		expect(KNOWN_CRON_HOOKS.length).toBeGreaterThan(0);
		expect(typeof CRON_HOOKS).toBe('object');
	});

	it('schedules a discovered module that is not on the shipped list', () => {
		// the defect: `cronUnits()` fell back to KNOWN_CRON_HOOKS because nothing supplied a
		// discovered list, so a contrib `hook_cron` never ran
		expect(KNOWN_CRON_HOOKS).not.toContain('scheduler');
		const modules = cronUnits({ hooks: ['system', 'scheduler'] })
			.filter((u) => u.module)
			.map((u) => u.module);
		expect(modules).toContain('scheduler');
		// no policy entry means unreviewed, and unreviewed RUNS
		const scheduler = cronUnits({ hooks: ['scheduler'] }).find((u) => u.module === 'scheduler');
		expect(scheduler?.unreviewed).toBe(true);
	});
});

describe('discovering which hooks this site has', () => {
	it('reads the module names out of a cronHookList payload', () => {
		expect(cronHooksFromList({ ok: true, shapes: { system: [], scheduler: [] } })).toEqual([
			'scheduler',
			'system'
		]);
	});

	it.each([
		['a failed run', { ok: false, shapes: { system: [] } }],
		['no shapes', { ok: true }],
		['an empty site', { ok: true, shapes: {} }],
		['nothing at all', null]
	])('answers null for %s, so the caller keeps the list it has', (_label, payload) => {
		expect(cronHooksFromList(payload)).toBe(null);
	});

	it('uses the shipped list and asks for discovery when nothing is cached', () => {
		const out = cronHooksFor(null, 'abc');
		expect(out.hooks).toEqual(KNOWN_CRON_HOOKS);
		expect(out.stale).toBe(true);
	});

	it('uses the cache while the module set is unchanged', () => {
		const out = cronHooksFor({ at: 'abc', hooks: ['system', 'scheduler'] }, 'abc');
		expect(out.hooks).toEqual(['system', 'scheduler']);
		expect(out.stale).toBe(false);
	});

	it('keeps serving the cached list while asking for a fresh one', () => {
		// a module was enabled, so the cache is stale -- but it still describes the site better
		// than the shipped list does, and re-discovery costs a kernel boot
		const out = cronHooksFor({ at: 'abc', hooks: ['system', 'scheduler'] }, 'def');
		expect(out.hooks).toEqual(['system', 'scheduler']);
		expect(out.stale).toBe(true);
	});
});

describe('the cursor', () => {
	const n = cronUnits().length;

	it.each([
		['null becomes the start of the chain', null],
		['a garbage string becomes the start', '{{{'],
		['an array is not a cursor', [1, 2]],
		['an index past the end resets', { i: 99 }],
		['a negative index resets', { i: -1 }],
		['a float index resets', { i: 1.5 }]
	])('%s', (_label, stored) => {
		expect(readCursor(stored as never, n).i).toBe(0);
	});

	it('round-trips through writeCursor', () => {
		expect(readCursor(writeCursor(readCursor({ i: 3 }, n)), n).i).toBe(3);
	});

	it('keeps a valid round and resets a bad one', () => {
		expect(readCursor({ i: 1, round: 7 }, n).round).toBe(7);
		expect(readCursor({ i: 1, round: -3 }, n).round).toBe(0);
	});

	it('advances one unit at a time, wraps, and bumps the round on wrap', () => {
		// separate consts rather than reassigning one variable: `readCursor` returns a STORED
		// cursor, which has no `wrapped`, and `wrapped` exists only on what `advanceCursor`
		// returns. Reusing the variable narrows it to the stored shape and hides that
		const start = readCursor(null, 3);
		const first = advanceCursor(start, 3);
		expect(first.i).toBe(1);
		expect(first.wrapped).toBe(false);
		const second = advanceCursor(first, 3);
		expect(second.i).toBe(2);
		const third = advanceCursor(second, 3);
		expect(third.i).toBe(0);
		expect(third.wrapped).toBe(true);
		expect(third.round).toBe(1);
	});
});

describe('cronAlarmDelayMs', () => {
	it('chains fast while there is more of the round to do', () => {
		expect(cronAlarmDelayMs({ more: true }, { chainMs: 1 })).toBe(1);
	});

	it('falls back to the keep-warm interval when the round is finished', () => {
		expect(cronAlarmDelayMs({ more: false }, { idleMs: 240000 })).toBe(240000);
	});

	it('has defaults, so a caller that passes no options still gets a sane delay', () => {
		expect(typeof cronAlarmDelayMs({ more: true }, {})).toBe('number');
		expect(cronAlarmDelayMs({ more: false }, {})).toBeGreaterThan(0);
	});
});

describe('env plumbing for the step machine', () => {
	it('reads the queue batch size and the keep-warm interval', () => {
		expect(queueBatchSize({ CRON_QUEUE_BATCH_SIZE: '7' })).toBe(7);
		expect(keepWarmMs({ KEEP_WARM_MS: '5000' })).toBe(5000);
	});

	it('ignores nonsense rather than producing 0 or NaN', () => {
		expect(queueBatchSize({ CRON_QUEUE_BATCH_SIZE: 'abc' })).toBeGreaterThan(0);
		expect(keepWarmMs({ KEEP_WARM_MS: 'abc' })).toBeGreaterThan(0);
	});

	it('an absent env yields defaults', () => {
		expect(queueBatchSize(undefined)).toBeGreaterThan(0);
		expect(keepWarmMs(undefined)).toBeGreaterThan(0);
	});
});

/**
 * Measured on a deployed worker rather than reasoned about: an object holding a 32 MB allocation
 * and an id minted in its constructor kept ONE incarnation across 71 consecutive 8 s alarms, and
 * changed its id on every probe at 12, 20, 30 and 45 s with `alarmsSeen` never passing 1.
 */
describe('the warm re-arm has to beat the hibernation threshold', () => {
	it('holds the threshold at the measured 10 s', () => {
		expect(HIBERNATION_IDLE_MS).toBe(10_000);
	});

	it('is on by default, because at one site it is 10.8% of free and $0 on paid', () => {
		expect(siteWarmEnabled(undefined)).toBe(true);
		expect(siteWarmEnabled({ SITE_WARM: '1' })).toBe(true);
		expect(siteWarmEnabled({ SITE_WARM: '0' })).toBe(false);
	});

	it('an explicitly unwarmed site keeps the slow idle re-arm', () => {
		expect(idleRearmMs({ SITE_WARM: '0', KEEP_WARM_MS: '240000' })).toBe(240000);
	});

	it('a warmed site re-arms strictly under the threshold', () => {
		const ms = idleRearmMs({ SITE_WARM: '1' });
		expect(ms).toBeLessThan(HIBERNATION_IDLE_MS);
		expect(ms).toBe(8000);
	});

	// free's quotas are ACCOUNT-WIDE, so ten warm sites would spend 108% of the daily rows on
	// staying warm and leave nothing to regenerate with. A degraded site un-warms itself
	it('falls back to the slow re-arm when the quota ladder has no headroom', () => {
		expect(idleRearmMs({ SITE_WARM: '1', KEEP_WARM_MS: '240000' }, false)).toBe(240000);
	});

	// 12,000 was measured NOT to warm, so honouring it would spend an alarm per firing and keep
	// nothing resident -- the worst of both
	it('clamps a configured value that would not warm anything', () => {
		expect(warmIntervalMs({ WARM_INTERVAL_MS: '45000' })).toBeLessThan(HIBERNATION_IDLE_MS);
		expect(warmIntervalMs({ WARM_INTERVAL_MS: '12000' })).toBeLessThan(HIBERNATION_IDLE_MS);
	});

	it('ignores nonsense rather than producing 0 or NaN', () => {
		expect(warmIntervalMs({ WARM_INTERVAL_MS: 'abc' })).toBeGreaterThan(0);
	});
});

/**
 * The PHP fragments are `String.raw` templates, and two mistakes in them break the BUNDLE
 * rather than a test: a backtick terminates the template literal, and `${` interpolates.
 *
 * That has happened twice in this project -- once in `site-php.js` and once in `updb-php.js`,
 * where a PHP comment containing a backtick produced `Expected ";" but found "semaphore"` at
 * build time. These assertions move that failure from the bundler to the gate.
 */
describe('the PHP fragments cannot break the bundle', () => {
	// String.fromCharCode(96) rather than a literal, so this file cannot break the same way it
	// is asserting against
	const BACKTICK = String.fromCharCode(96);
	const fragments: Record<string, string> = {
		'runCronHook(file)': runCronHook('file'),
		'runCronHook(layout_builder)': runCronHook('layout_builder'),
		runCronQueue: runCronQueue('media_entity_thumbnail', 5),
		cronHookList: cronHookList()
	};

	it.each(Object.keys(fragments))('%s has no backtick anywhere', (name) => {
		expect(fragments[name]).not.toContain(BACKTICK);
	});

	it.each(Object.keys(fragments))('%s opens with the PHP tag', (name) => {
		expect(fragments[name]!.startsWith('<?php')).toBe(true);
	});

	it.each(Object.keys(fragments))('%s prints exactly one json_encode', (name) => {
		expect((fragments[name]!.match(/echo json_encode/g) ?? []).length).toBe(1);
	});

	it.each(Object.keys(fragments))('%s installs the Fiber shim', (name) => {
		expect(fragments[name]).toContain('PhpWasmSyncFiber');
	});

	it('boots the memoized kernel rather than a fresh one per hook', () => {
		expect(fragments['runCronHook(file)']).toContain('__pw_kernel');
	});

	it('goes through invokeAllWith, not invoke()', () => {
		expect(fragments['runCronHook(file)']).toContain("invokeAllWith('cron'");
	});

	it('never calls drupal_cron, which is what the unit list replaces', () => {
		for (const code of Object.values(fragments)) {
			expect(/drupal_cron|\bcron\(\)->run\b/.test(code)).toBe(false);
		}
	});

	it('takes no lock, because the Durable Object gate is the mutual exclusion', () => {
		expect(fragments['runCronHook(file)']).not.toContain('->acquire(');
	});

	/**
	 * CRON IS WHERE MAIL IS SENT, and `user_pass_reset_url()` builds an absolute link from the
	 * request. Booted against the default host, every link Drupal mails from cron points the
	 * recipient at their own machine -- so the origin has to reach these fragments the same way it
	 * reaches a render, even though cron has no request to read one from.
	 */
	it('boots against the origin it was given, in all three fragments', () => {
		const origin = 'https://mail-links.example';
		for (const code of [
			runCronHook('file', origin),
			runCronQueue('media_entity_thumbnail', 5, origin),
			cronHookList(origin)
		]) {
			expect(code).toContain('$origin = json_decode("\\"https://mail-links.example\\"");');
			// the superglobals AND the request the kernel boots from, or the two disagree
			expect(code).toContain("$_SERVER['SERVER_NAME'] = $__host;");
			expect(code).toContain("rtrim($origin, '/') . '/'");
			// the URL generator reads the request stack, and a cron fragment pushes none of its own
			expect(code).toContain('request_stack');
		}
	});

	// an absent origin has to stay a no-op, or every existing caller and probe moves with it
	it('leaves the host alone when no origin is supplied', () => {
		expect(fragments['runCronHook(file)']).toContain('$origin = json_decode("\\"\\"");');
	});

	it('caps the queue by item count rather than by wall clock', () => {
		expect(/\$i < \$max/.test(fragments.runCronQueue!)).toBe(true);
	});

	it("handles all four of core's requeue cases", () => {
		for (const s of [
			'DelayedRequeueException',
			'RequeueException',
			'SuspendQueueException',
			'releaseItem'
		]) {
			expect(fragments.runCronQueue).toContain(s);
		}
	});

	// a bad name must never reach the interpreter as SQL or PHP
	it.each(['Bad-Name', 'a b', '', '1module', 'file; echo 1', '../x'])(
		'refuses module name %j',
		(bad) => {
			expect(runCronHook(bad)).toContain('refused module name');
		}
	);

	it.each(['Bad Queue', '', 'A', "x'y"])('refuses queue name %j', (bad) => {
		expect(runCronQueue(bad)).toContain('refused queue name');
	});

	it('clamps an absurd item cap and falls back on a nonsense one', () => {
		expect(/\$max = (\d+);/.exec(runCronQueue('q', 9999))?.[1]).toBe('50');
		expect(/\$max = (\d+);/.exec(runCronQueue('q', -3))?.[1]).toBe('5');
	});
});
