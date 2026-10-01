import { encode } from '@drupflare/durabledb/codec';
import { describe, expect, it } from 'vitest';
import { SHIPPING_STEP } from '../../scripts/measure/growth-glue';
import { INITIAL_BYTES } from '../../scripts/measure/initial-pages';
import { renderPage } from '../../src/drupal/site-php';
import { writeCursor, type StoredCursor } from '../../src/ops/cron';
import { DEFAULT_CRON_BUDGET, driveCron } from '../../src/ops/cron-drive';
import {
	SitePhpDurableObject,
	isolateId,
	isolateResidency,
	noteResident,
	retainInterpreterEnabled
} from '../../src/site-do';
import { freshSite, inObject, queuePath, serveDirect, type ServeDo } from '../helpers/serve-do';

/**
 * Linear memory across ONE incarnation, and the drop that keeps it inside the isolate.
 *
 * A deployed free worker was reset twice with `Durable Object's isolate exceeded its memory limit`,
 * taking every in-flight request with it. `USE_ZEND_ALLOC=0` means PHP returns nothing between
 * requests, so demand inside one incarnation is CUMULATIVE and emscripten's geometric growth rounds
 * each rise up. Measured here, one object, MiB:
 *
 * | step                        | before | after |
 * | --------------------------- | -----: | ----: |
 * | migrated + firstrun         | 108.50 | 96.00 |
 * | first authenticated render  | 122.63 | 96.00 |
 * | second authenticated render | 138.63 | 108.50 |
 * | third, fourth               | 138.63 | 108.50 |
 *
 * 138.63 is 10.63 MiB PAST the 128 MiB limit, so provisioning a site and then viewing two pages on
 * it was over the ceiling by construction -- the first-run path of every new site.
 *
 * **THE FIX IS AT PROVISIONING, NOT AT THE CEILING.** A drop keyed on linear memory runs BETWEEN
 * invocations, and on a deployed paid worker the reset happened INSIDE one: the first authenticated
 * `/admin/content` on each of four freshly provisioned sites went from the install's 108.50 straight
 * past the limit in a single render, 4,661-4,936 ms of cpuTime. So `/__migrate` and `/__firstrun`
 * drop the interpreter when they finish, the way `/__enable` always has, and the serving incarnation
 * starts at `INITIAL_MEMORY`. `recycleIfOversized()` stays as the backstop for everything else.
 *
 * **CRON WAS THE FIRST HYPOTHESIS AND THE MEASUREMENT REFUTED IT.** Both resets landed on an alarm
 * whose logs were full of the update module's deferred fetches, which reads as a cause. A sweep of
 * 16 firings moves linear memory by nothing at all, on a cold heap and on a hot one, and the case
 * below keeps that control: without it the next reader re-derives the same wrong answer from the
 * same suggestive stack.
 *
 * Bounds and relationships, never equalities. The absolutes move with the pack and the growth step;
 * what must not move is that a provisioned object sheds its install before serving, and that a
 * serving object does not recycle on every request.
 */

const MIB = 1_048_576;

/** the Durable Object isolate limit; a platform figure rather than a budget chosen here */
const ISOLATE_LIMIT = 128 * MIB;

/**
 * `INITIAL_MEMORY`: where a booted interpreter starts and where provisioning must leave one.
 *
 * READ FROM THE BINARY'S OWN FIGURE rather than written here. This was `96 * MIB`, and tuning the
 * memory section to 80 turned two assertions red against an interpreter that was behaving exactly
 * as intended -- the same shape as the hardcoded `< 80 MB` heap assertion 8.5 failed at 96.
 */
const BOOTED_IDLE = INITIAL_BYTES;

/** the first rung of the growth ladder above a size, which is what one growth event lands on */
const rungAbove = (bytes: number): number =>
	Math.ceil((bytes * (1 + SHIPPING_STEP)) / 65_536) * 65_536;

const REQUEST_TIMEOUT = 900_000;
const AUTH_PASS = 'cfw-Recycle-Pass-4412';

const deps = (site: ServeDo) => ({
	sql: site.sql,
	runJson: (code: string) => site.runJson(code)
});

/** linear memory right now, read the way an operator reads it */
async function heap(site: ServeDo): Promise<number> {
	const res = await site.fetch(new Request('https://do.local/__heap?op=status'));
	const body = (await res.json()) as Record<string, unknown>;
	return Number(body.linearMemoryBytes ?? 0);
}

async function stats(site: ServeDo): Promise<Record<string, unknown>> {
	const res = await site.fetch(new Request('https://do.local/__serve-stats'));
	return (await res.json()) as Record<string, unknown>;
}

async function provision(site: ServeDo): Promise<string> {
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	await site.fetch(
		new Request('https://do.local/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ adminPass: AUTH_PASS, siteName: 'Recycle' }),
			headers: { 'content-type': 'application/json' }
		})
	);
	const login = (await site.runJson(
		renderPage('/user/login', [], false, {
			method: 'POST',
			body: `name=admin&pass=${encodeURIComponent(AUTH_PASS)}&form_id=user_login_form&op=Log+in`,
			contentType: 'application/x-www-form-urlencoded',
			cookie: ''
		})
	)) as Record<string, unknown>;
	const lines = Array.isArray(login['setCookie']) ? (login['setCookie'] as string[]) : [];
	// what provisioning leaves is a drop: the claim and the login above are install residue, and the
	// serving incarnation starts from a fresh boot. Dropped here rather than relied on, because the
	// login render itself grows a fresh interpreter by several rungs of the growth ladder
	site.php = undefined;
	return (lines.find((l) => /^S?SESS/.test(l))?.split(';')[0] ?? '').trim();
}

/**
 * The FIRST authenticated request out of a given entry state, which is the one that resets an object.
 *
 * Returns the reading taken immediately after one render, never after a warm cycle: a replica that
 * is only safe once it has served something is not safe, because its first request is a real user's.
 */
async function firstAuthenticatedRender(
	site: ServeDo,
	jar: string,
	path = '/admin/content'
): Promise<{ before: number; after: number; ok: boolean }> {
	const before = await heap(site);
	const rendered = (await site.runJson(renderPage(path, [], false, { cookie: jar }))) as Record<
		string,
		unknown
	>;
	return { before, after: await heap(site), ok: Number(rendered['status'] ?? 0) === 200 };
}

describe('a cold object is safe on its FIRST authenticated request', () => {
	it(
		'out of a freshly provisioned object',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				const jar = await provision(site);
				return firstAuthenticatedRender(site, jar);
			});

			// eslint-disable-next-line no-console
			console.log(
				`[first-render fresh] ${(out.before / MIB).toFixed(2)} -> ${(out.after / MIB).toFixed(2)} MiB`
			);
			expect(out.ok, 'the first authenticated render did not answer 200').toBe(true);
			// nothing is resident: what a claim leaves behind is a drop, not an interpreter
			expect(out.before).toBe(0);
			expect(out.after).toBeLessThan(ISOLATE_LIMIT);
			expect(ISOLATE_LIMIT - out.after).toBeGreaterThan(4 * MIB);
		},
		REQUEST_TIMEOUT
	);

	it(
		'out of a hibernated object, which is how a cold replica wakes',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				const jar = await provision(site);
				// serve something, then take the interpreter away. This models the JS-side effect of
				// hibernation -- storage survives, the resident interpreter does not -- rather than a
				// real eviction, which this harness cannot force. The distinction matters: it does
				// NOT model losing `this.migrated` and the other in-memory flags
				await site.runJson(renderPage('/', [], false, { cookie: jar }));
				site.php = undefined;
				return firstAuthenticatedRender(site, jar);
			});

			// eslint-disable-next-line no-console
			console.log(
				`[first-render hibernated] ${(out.before / MIB).toFixed(2)} -> ${(out.after / MIB).toFixed(2)} MiB`
			);
			expect(
				out.ok,
				'the first authenticated render after hibernation did not answer 200'
			).toBe(true);
			// PASSES WITHOUT THE PROVISIONING DROP TOO, and that is worth saying rather than leaving
			// for someone to discover: a hibernated object has already lost the install residue, so
			// this case pins the replica WAKE path against a future regression rather than reproducing
			// the defect. The fresh case above is the one that fails when the drop is removed.
			expect(out.after).toBeLessThan(ISOLATE_LIMIT);
			expect(ISOLATE_LIMIT - out.after).toBeGreaterThan(4 * MIB);
		},
		REQUEST_TIMEOUT
	);
});

/**
 * A host call must not leave its argument behind.
 *
 * vrzno asks `zend_is_callable_ex()` about every value it hands to JavaScript and never frees the
 * error string that call writes, which quotes the value. Every SQL statement crosses as a JSON
 * string, so each one stranded a copy, and with no request shutdown here nothing reclaimed it: an
 * authenticated admin render grew linear memory ~0.5 MiB until the recycle dropped the interpreter
 * every couple of dozen requests. `plugCallableLeak()` rewrites the glue so a string is never asked.
 */
describe('a warm interpreter under repeated host calls', () => {
	it(
		'keeps linear memory flat across 20,000 host calls carrying a 1 KiB argument',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__php'));
				const call = String.raw`<?php
$host = vrzno_env('cfwSqlExec');
$arg = json_encode(['sql' => 'SELECT 1 WHERE 1 <> ' . "'" . str_repeat('x', 1000) . "'", 'params' => []]);
$ok = 0;
for ($i = 0; $i < 20000; $i++) { $ok += strlen($host($arg)) > 0 ? 1 : 0; }
echo json_encode(['ok' => $ok]);
`;
				const before = await heap(site);
				await site.runJson(call);
				const reply = (await site.runJson(call)) as { ok?: number };
				return { before, after: await heap(site), ok: reply.ok ?? 0 };
			});
			expect(out.ok).toBe(20_000);
			// unplugged, each call strands its argument: the two batches read 80 -> 213 MiB
			expect(out.after - out.before).toBeLessThan(4 * MIB);
		},
		REQUEST_TIMEOUT
	);
});

/**
 * An authenticated request is never answered "warming", because nothing can warm it.
 *
 * The chain renders anonymously and does not queue a session's request, so a 503 telling a logged-in
 * visitor to retry for a fill promises work nobody is doing. `unfillable` carries `authenticated`,
 * which lifts both refusals the chain would otherwise make: the cold one and the over-budget one.
 * A real claimed site and a real session, because an unclaimed one answers its claim page first.
 */
describe('an authenticated request is never answered warming', () => {
	it(
		'renders inline over budget, where an anonymous request is diverted',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				const jar = await provision(site);
				// THE CONTROL: the budget really diverts, or the authenticated answer proves nothing
				const anonymous = await serveDirect(site, '/filter/tips', '&budget=1');
				const authenticated = await serveDirect(site, '/admin/content', '&budget=1', {
					headers: { cookie: jar }
				});
				return { anonymous, authenticated };
			});
			expect(out.anonymous.inline).toBe('over-budget');
			// rendered for the visitor, whatever Drupal then decides: the cookie name is derived
			// from the host and this login ran on a different one, so Drupal answers 403 -- which is
			// a render, and the property is only that a session is never told to wait for a fill
			expect(out.authenticated.status).not.toBe(503);
			expect(out.authenticated.cache).toBe('RENDER');
		},
		REQUEST_TIMEOUT
	);

	it(
		'boots for it on a cold object, whatever the plan profile says about booting',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				const jar = await provision(site);
				// what `/__migrate` and `/__firstrun` leave behind, and what an eviction leaves. Both plan
				// profiles boot inline today, so this passes without `authenticated` in `unfillable`; it
				// is what fails the day a profile stops booting
				site.php = undefined;
				return serveDirect(site, '/admin/content', '', { headers: { cookie: jar } });
			});
			expect(out.status).not.toBe(503);
			expect(out.cache).toBe('RENDER');
		},
		REQUEST_TIMEOUT
	);
});

describe('the interpreter recycle', () => {
	it(
		'sheds the install so authenticated renders stay inside the isolate',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				const jar = await provision(site);
				const ladder: Array<[string, number]> = [['provisioned', await heap(site)]];
				for (const path of ['/', '/admin/content', '/admin/people', '/admin/modules']) {
					await site.runJson(renderPage(path, [], false, { cookie: jar }));
					ladder.push([path, await heap(site)]);
				}
				return { ladder, booted: BOOTED_IDLE };
			});

			const ladder = out.ladder as Array<[string, number]>;
			// eslint-disable-next-line no-console
			console.log(
				`recycle ladder: ${ladder.map(([k, v]) => `${k}=${(v / MIB).toFixed(2)}`).join(' ')}`
			);

			// PROVISIONING LEFT NOTHING BEHIND, which is the fix rather than a consequence of it.
			// A claim rewrites config and rebuilds the container, and the 12.5 MiB it used to leave
			// resident is what put the first authenticated render past the limit inside ONE
			// invocation -- where no between-invocation recycle can reach it
			expect(ladder[0]?.[1]).toBeLessThanOrEqual(rungAbove(BOOTED_IDLE));

			const peak = Math.max(...ladder.map(([, v]) => v));
			expect(peak).toBeLessThan(ISOLATE_LIMIT);
			// a full growth rung of room at the peak, which is what makes the next allocation
			// survivable rather than the one that resets the object
			expect(ISOLATE_LIMIT - peak).toBeGreaterThan(4 * MIB);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * A MIXED chain, in one incarnation, with nothing dropped between the steps.
	 *
	 * Every other case here drives one kind of work. The reset that opened this file was not one
	 * workload's peak; it was the SUM of what an incarnation had done, and each single-workload
	 * measurement looked safe on its own. So this drives the sequence a real first day produces --
	 * provision, browse anonymously, sign in, work in admin, install a module, come back to an
	 * authenticated page -- and reads the heap after every step.
	 *
	 * The assertion is the PEAK across the whole chain, not any one step. A step that sheds is
	 * asserted to shed, because a shed that stops happening is how the peak returns.
	 */
	it(
		'stays inside the isolate across a mixed chain with nothing dropped between steps',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				const jar = await provision(site);
				const ladder: Array<[string, number]> = [['provisioned', await heap(site)]];
				const step = async (label: string, run: () => Promise<unknown>) => {
					await run();
					ladder.push([label, await heap(site)]);
				};

				for (const path of ['/', '/user/1', '/admin/content', '/admin/config']) {
					await step(path, () =>
						site.runJson(renderPage(path, [], false, { cookie: jar }))
					);
				}
				await step('cron', () =>
					driveCron(writeCursor({} as StoredCursor), deps(site), {}, DEFAULT_CRON_BUDGET)
				);
				await step('enable', () =>
					site.fetch(new Request('https://do.local/__enable?module=ctools'))
				);
				await step('after-enable auth', () =>
					site.runJson(renderPage('/admin/content', [], false, { cookie: jar }))
				);
				return { ladder };
			});

			const ladder = out.ladder as Array<[string, number]>;
			// eslint-disable-next-line no-console
			console.log(
				`mixed chain: ${ladder.map(([k, v]) => `${k}=${(v / MIB).toFixed(2)}`).join(' ')}`
			);

			const peak = Math.max(...ladder.map(([, v]) => v));
			expect(peak).toBeLessThan(ISOLATE_LIMIT);
			expect(ISOLATE_LIMIT - peak).toBeGreaterThan(4 * MIB);

			// an install drops the interpreter, so the reading straight after it is a booted one.
			// Without that the install's residue is still resident when the next render starts, which
			// is the shape that crossed the limit inside a single invocation
			const afterEnable = ladder.find(([k]) => k === 'enable')?.[1] ?? 0;
			expect(afterEnable).toBeLessThanOrEqual(BOOTED_IDLE);
		},
		REQUEST_TIMEOUT
	);

	it(
		'does not fire on an object that is only serving',
		async () => {
			const recycles = await inObject(freshSite(), async (site) => {
				const jar = await provision(site);
				// one render to spend the install's residue and take the single drop it earns
				await site.runJson(renderPage('/', [], false, { cookie: jar }));
				await heap(site);
				const before = Number((await stats(site)).recycles ?? 0);
				for (let i = 0; i < 6; i++) {
					await site.runJson(renderPage('/admin/content', [], false, { cookie: jar }));
					await heap(site);
				}
				const after = Number((await stats(site)).recycles ?? 0);
				return { before, after };
			});

			// a boot per page is the failure mode on the other side of this knob, and it would
			// otherwise show up only as latency nobody attributes
			expect(recycles.after).toBe(recycles.before);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * A trap is a FAULT, and every other drop here is about size.
	 *
	 * Found by `tests/e2e/leak.spec.ts` against the park's socket traps: `memory access out of
	 * bounds` through `invoke_iiii`, then three consecutive 500s. Nothing dropped the instance,
	 * so a VM that had trapped mid-execution stayed eligible to serve the next request with a
	 * half-finished Zend state in linear memory.
	 *
	 * The throw still propagates; what this pins is that the instance does not survive it.
	 */
	it(
		'drops the interpreter when the VM traps, which no size check can see',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await provision(site);
				const before = Number((await stats(site)).trappedRuns ?? 0);

				const inst = await site.ensurePhp();
				const real = inst.php._run.bind(inst.php);
				let thrown = '';
				inst.php._run = () => {
					throw new WebAssembly.RuntimeError('memory access out of bounds');
				};
				try {
					await site.run('<?php echo 1;');
				} catch (e) {
					thrown = String((e as Error)?.message ?? e);
				}
				const dropped = site.php === undefined;
				inst.php._run = real;

				const after = Number((await stats(site)).trappedRuns ?? 0);
				// the control: a clean run after the trap must work, or "dropped" proves nothing
				const recovered = await site.run('<?php echo "ok";');
				return { before, after, thrown, dropped, recovered };
			});

			expect(out.thrown, 'the trap must still reach the caller').toContain('out of bounds');
			expect(out.dropped, 'a trapped VM stayed eligible to serve').toBe(true);
			expect(out.after).toBe(out.before + 1);
			expect(out.recovered).toContain('ok');
		},
		REQUEST_TIMEOUT
	);

	/**
	 * The drop between invocations reads the WHOLE isolate, not only linear memory.
	 *
	 * `oversized()` has read both since the isolate threshold landed, and the fill batch used it,
	 * while `recycleIfOversized()` compared linear memory alone. So an incarnation could end with
	 * the isolate past its threshold and linear memory under its own, and the next invocation --
	 * an alarm, in the `drupflare-test` report of 2026-09-19 -- started over the limit.
	 */
	it(
		'drops on the isolate threshold when linear memory is still under its own',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await provision(site);
				await site.ensurePhp();
				const linear = await heap(site);
				// as if the heap had grown since its boot: one that has not cannot shrink by a drop
				(site as unknown as { bootLinear: number }).bootLinear = 0;
				site.env = { ...site.env, ISOLATE_ABOVE_BYTES: String(1024 * MIB) };
				const kept = site.recycleIfOversized('alarm');
				// linear memory stays under the default 112 MiB; only the isolate threshold moves
				site.env = { ...site.env, ISOLATE_ABOVE_BYTES: String(64 * MIB) };
				const dropped = site.recycleIfOversized('alarm');
				return {
					linear,
					kept,
					dropped,
					gone: site.php === undefined,
					last: site.lastRecycle
				};
			});

			expect(out.linear).toBeLessThan(112 * MIB);
			// the control: nothing is dropped while both thresholds are clear
			expect(out.kept).toBe(false);
			expect(out.dropped, 'the isolate threshold did not drop the interpreter').toBe(true);
			expect(out.gone).toBe(true);
			expect(out.last?.reason).toBe('alarm');
		},
		REQUEST_TIMEOUT
	);

	/**
	 * A boot that rebuilt the container ends its invocation with a drop, whatever the thresholds say.
	 *
	 * Reproduced on a deployed site after a driver-pack update, which empties `cache_container`: the
	 * rebuilding fill completed, then the next invocation (75 ms of CPU) was reset for the isolate's
	 * memory and a waiting visitor got a 1101. Linear memory and the isolate estimate both read clear.
	 */
	it(
		'drops an interpreter whose boot rebuilt the container, and keeps one that did not',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const jar = await provision(site);
				site.sql.exec('DELETE FROM cache_container');
				site.php = undefined;
				await site.runJson(renderPage('/', [], false, { cookie: jar }));
				const rebuilt = site.recycleIfOversized('request');
				const last = site.lastRecycle;
				// the control: the row is back, so the next boot is an ordinary one
				await site.runJson(renderPage('/', [], false, { cookie: jar }));
				const ordinary = site.recycleIfOversized('request');
				return { rebuilt, last, ordinary };
			});

			expect(out.rebuilt, 'a rebuilding boot kept its interpreter').toBe(true);
			expect(out.last?.rebuild).toBe(true);
			expect(out.ordinary).toBe(false);
		},
		REQUEST_TIMEOUT
	);

	it(
		'ends a fill batch early rather than accumulating across it',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await provision(site);
				for (const path of ['/', '/user/1', '/admin/content', '/admin/people']) {
					queuePath(site, path, { arm: false });
				}
				// a threshold below `INITIAL_MEMORY`, so the guard is true from the first page. The
				// alternative is driving a real 112 MiB heap inside a spec, which measures the pack
				// rather than the guard and moves every time the pack does
				site.env = {
					...site.env,
					RECYCLE_ABOVE_BYTES: String(64 * MIB),
					FILL_BATCH_SIZE: '25'
				};
				const queuedBefore = Number(site.queueDepth());
				await site.alarm();
				return { queuedBefore, queuedAfter: Number(site.queueDepth()) };
			});

			// the batch had four pages and a size of 25, so an unguarded run drains the queue; the
			// guard stops it after the first
			expect(out.queuedBefore).toBe(4);
			expect(out.queuedAfter).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'holds background PHP off a young interpreter and runs it once the interpreter has settled',
		async () => {
			const paths = ['/', '/user/password', '/user/register'];
			const sent: unknown[] = [];
			const out = await inObject(freshSite(), async (site) => {
				await provision(site);
				site.env = {
					...site.env,
					FILL_SETTLE_MS: '60000',
					SEND_EMAIL: { send: async (body: unknown) => void sent.push(body) }
				};
				const young = async () => {
					// a visitor's boot, which is the young isolate every deployed reset was on
					await site.runJson(renderPage('/user/login', [], false, { cookie: '' }));
					for (const path of paths) queuePath(site, path, { arm: false });
				};
				const settle = async () => {
					site.phpBootedAt = Number(site.phpBootedAt) - 60_000;
					// a claimed site owes a reconcile step first, and each step is a firing of its own
					const filled = () =>
						Number(
							(site as unknown as { pagesFilledByAlarms?: number })
								.pagesFilledByAlarms ?? 0
						);
					const before = filled();
					for (let i = 0; i < 8 && filled() === before; i++) await site.alarm();
					return filled() - before;
				};

				// right after the claim: the reconcile step waits as well as the fill
				await young();
				const bootedAt = Number(site.phpBootedAt);
				// and a mail committed now, which the hold on PHP must not keep from the drain
				const binary: Record<string, (json: string) => string> = {};
				site.installCapabilities(binary);
				binary.cfwMail!(
					JSON.stringify(
						encode({
							to: 'visitor@example.org',
							from: 'Site <site@example.com>',
							subject: 'Replacement login information',
							text: 'reset',
							html: null,
							headers: {}
						})
					)
				);
				await site.alarm();
				const first = {
					queued: Number(site.queueDepth()),
					held: JSON.stringify(
						(site as unknown as { lastAlarmOutcome: unknown }).lastAlarmOutcome
					),
					reconcile: JSON.stringify(
						(site as unknown as { lastReconcile: unknown }).lastReconcile
					),
					mailQueue: site.countOrNull('cfw_mail_queue'),
					mailSent: sent.length,
					armed: await site.storage.getAlarm()
				};
				const settled = await settle();

				// reconciled now, so a second young interpreter meets the fill batch's own hold
				await site.ctx.storage.deleteAlarm();
				await young();
				const queued = Number(site.queueDepth());
				await site.alarm();
				const second = { queued, whileYoung: Number(site.queueDepth()) };
				const drained = await settle();
				await site.ctx.storage.deleteAlarm();
				return {
					bootedAt,
					first,
					settled,
					second,
					drained,
					served: (await stats(site))['fillHold'] as { holds: number }
				};
			});

			// held, not dropped: every row survives and the chain re-arms for the end of the hold
			expect(out.first.queued, out.first.held).toBe(paths.length);
			expect(out.first.held).toContain('"held"');
			// the held step is the reconcile one, and the mail still left on that firing: returning at
			// the step kept every reset mail queued for the first minute after a boot
			expect(out.first.reconcile).toContain('"held"');
			expect(out.first.mailSent).toBe(1);
			expect(out.first.mailQueue).toBe(0);
			expect(out.first.armed).not.toBeNull();
			expect(Number(out.first.armed)).toBeLessThanOrEqual(out.bootedAt + 60_000);
			expect(out.settled).toBeGreaterThan(0);
			expect(out.second.whileYoung).toBe(out.second.queued);
			expect(out.served.holds).toBeGreaterThanOrEqual(1);
			expect(out.drained).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'cron does not grow the heap, on a cold interpreter or a hot one',
		async () => {
			const series = await inObject(freshSite(), async (site) => {
				const jar = await provision(site);
				await site.runJson(renderPage('/', [], false, { cookie: jar }));
				await heap(site);
				const readings: number[] = [];
				let cursor: unknown = undefined;
				// more firings than a round has units, so every hook runs and the ring wraps
				// twice: a leak costing one hook per round is invisible on a single pass
				for (let i = 0; i < 16; i++) {
					const driven = await driveCron(cursor, deps(site), {}, DEFAULT_CRON_BUDGET);
					cursor = writeCursor(driven.cursor as StoredCursor);
					readings.push(await heap(site));
				}
				return readings;
			});

			expect(series.length).toBe(16);
			expect(Math.min(...series)).toBeGreaterThan(0);
			// NO GROWTH PER ROUND, which is the leak this hunts. A hook's first run may still cross
			// one growth rung: on the rebuilt pack the heap sits just under one and steps once at
			// firing 5, then holds through the ring's second pass. A leak climbs past the first pass
			const secondPass = series.slice(8);
			expect(new Set(secondPass).size, JSON.stringify(series)).toBe(1);
			expect(secondPass[0], JSON.stringify(series)).toBe(series[7]);
		},
		REQUEST_TIMEOUT
	);
});

/**
 * The mixed chain, which is the workload the isolate limit is actually charged for.
 *
 * `USE_ZEND_ALLOC=0` means PHP returns nothing between requests, so demand inside one incarnation is
 * the SUM of what the object has done. Every figure in `TECHNICAL_REPORT.md`'s Memory section is a
 * single-workload peak and each one is correct; none of them is what the isolate meters. The
 * measured crossing was provisioning plus two authenticated renders -- 96.00 to 138.63 MiB, past the
 * 128 MiB limit -- which is the first-run path of every new site.
 *
 * The renders half is covered above. This is the rest of what a real site does in one incarnation:
 * an outbound HTTP drain, a file read, an image derivative and a module enable, with no drop between
 * them.
 */
describe('one incarnation doing more than rendering', () => {
	it(
		'holds the ceiling across outbound, file and image work in the same interpreter',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const jar = await provision(site);
				const steps: { step: string; heap: number }[] = [];
				const note = async (step: string) => {
					steps.push({ step, heap: await heap(site) });
				};

				await note('provisioned');
				await site.runJson(renderPage('/', [], false, {}));
				await note('anonymous render');
				await site.runJson(renderPage('/admin/content', [], false, { cookie: jar }));
				await note('authenticated render');

				// the outbound queue drain, which is the deferred-HTTP half of a cron round
				await site.fetch(new Request('https://do.local/__httpdrain'));
				await note('outbound drain');

				// a file read through the object, which is what a private:// derivative does first
				await site.fetch(
					new Request('https://do.local/__files?action=list&limit=5').clone()
				);
				await note('file listing');

				// a second authenticated page, because the crossing was the SECOND one
				await site.runJson(renderPage('/admin/people', [], false, { cookie: jar }));
				await note('second authenticated render');

				return { steps, recycles: Number((await stats(site)).recycles ?? 0) };
			});

			// printed, because the shape of the curve is the finding and a single peak is not
			console.log(
				`mixed chain: ${out.steps
					.map((s) => `${s.step}=${(s.heap / MIB).toFixed(2)}`)
					.join(' ')} MiB, recycles=${out.recycles}`
			);

			// the control: every step has to have been reached, or a short chain reads as a low peak
			expect(out.steps).toHaveLength(6);
			expect(out.steps[0]?.heap, 'provisioning leaves nothing resident').toBe(0);
			for (const s of out.steps.slice(1)) expect(s.heap, s.step).toBeGreaterThan(0);

			// THE ASSERTION. 128 MiB is the isolate limit and crossing it inside an invocation is a
			// message-less exception with no stack, not an error anything can catch
			const peak = Math.max(...out.steps.map((s) => s.heap));
			expect(peak, `mixed chain peaked at ${(peak / MIB).toFixed(2)} MiB`).toBeLessThan(
				128 * MIB
			);
		},
		REQUEST_TIMEOUT
	);
});

/**
 * The interpreters one isolate holds, which is what its 128 MiB is actually shared between.
 *
 * Module scope is per isolate and an isolate can host several live objects of this class, so the
 * limit is not per object. `/serve-stats` reports the whole isolate for that reason.
 */
describe('the interpreters an isolate holds', () => {
	const fake = (bytes: number) => ({ binary: { HEAPU8: new Uint8Array(bytes) } });

	it('counts each resident interpreter once and adds their linear memory', () => {
		const before = isolateResidency();
		const a = fake(1024);
		const b = fake(2048);
		noteResident('residency-a', a);
		noteResident('residency-b', b);
		// a second report for the same object replaces rather than adds
		noteResident('residency-a', a);
		const both = isolateResidency();
		expect(both.interpreters - before.interpreters).toBe(2);
		expect(both.linearBytes - before.linearBytes).toBe(3072);

		// a dropped interpreter leaves the registry at the end of that invocation
		noteResident('residency-a', undefined);
		noteResident('residency-b', undefined);
		const after = isolateResidency();
		expect(after.interpreters).toBe(before.interpreters);
		expect(after.linearBytes).toBe(before.linearBytes);
	});

	it('reads a build that exposes only wasmMemory', () => {
		const before = isolateResidency();
		const php = { binary: { wasmMemory: { buffer: new ArrayBuffer(4096) } } };
		noteResident('residency-wasm', php);
		expect(isolateResidency().linearBytes - before.linearBytes).toBe(4096);
		noteResident('residency-wasm', undefined);
	});

	it('keeps one id for the life of the isolate', () => {
		expect(isolateId()).toBe(isolateId());
		expect(isolateResidency().id).toBe(isolateId());
	});

	it("reports another object's interpreter on serve-stats when both share the isolate", async () => {
		const booted = async () =>
			inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				await site.fillOne('/user/login');
				await site.fetch(new Request('https://do.local/__serve?path=/'));
				return (await (
					await site.fetch(new Request('https://do.local/__serve-stats'))
				).json()) as {
					isolate: { id: string; interpreters: number; linearBytes: number };
					isolateBytes: { linear: number };
				};
			});
		const first = await booted();
		const second = await booted();
		// THE CONTROL: the first object reports its own interpreter, or a count of two below
		// could be two stale entries rather than two live ones
		expect(first.isolate.interpreters).toBeGreaterThanOrEqual(1);
		// the test pool runs every object in one isolate, which is the co-residency this reports
		expect(second.isolate.id).toBe(first.isolate.id);
		expect(second.isolate.interpreters).toBeGreaterThanOrEqual(2);
		// against its OWN linear memory, not the first reading: the pool also holds interpreters
		// earlier tests dropped, and collecting one between the two readings shrinks any raw sum
		expect(second.isolate.linearBytes).toBeGreaterThan(second.isolateBytes.linear);
	}, 900_000);
});

/**
 * An interpreter kept in module scope across the eviction of the instance that booted it.
 *
 * A second instance built on the same object state is what the platform does after an eviction, in
 * the same isolate. Both share one storage here, so a correct page proves nothing about the wiring;
 * which instance's `queryCount` moves does, because only the instance the SQL bridge reaches counts.
 */
describe('an interpreter kept across an eviction', () => {
	type Retaining = ServeDo & {
		queryCount: number;
		lastRetention?: { adopted: boolean; reason?: string };
		pendingCommits?: number;
		flushCommitSeq(): void;
	};
	const booted = async (site: ServeDo, retain = '1') => {
		site.env = { ...site.env, RETAIN_INTERPRETER: retain };
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		await site.fillOne('/user/login');
		// a GATED request, because the interpreter is kept at the end of one; a stored page is
		// answered by the storage lane before the gate and never reaches that point
		await site.fetch(new Request('https://do.local/__serve-stats'));
	};
	const successor = (site: ServeDo) =>
		new SitePhpDurableObject(site.ctx as never, site.env as never) as unknown as Retaining;

	it("is adopted by the next instance, and PHP's SQL reaches that instance", async () => {
		const out = await inObject(freshSite(), async (site) => {
			await booted(site);
			const old = site as Retaining;
			const next = successor(site);
			await next.fetch(new Request('https://do.local/__serve-stats'));
			const before = { old: old.queryCount, next: next.queryCount };
			// CfwSqlClient cached its bridge function when the OLD instance booted
			await next.fillOne('/user/password');
			return {
				same: next.php === old.php,
				adopted: next.lastRetention?.adopted,
				reason: next.lastRetention?.reason,
				oldMoved: old.queryCount - before.old,
				nextMoved: next.queryCount - before.next,
				stored: next.sql
					.exec("SELECT COUNT(*) AS n FROM cfw_page WHERE path = '/user/password'")
					.toArray()[0]?.['n']
			};
		});
		expect(out.adopted, `refused: ${out.reason}`).toBe(true);
		expect(out.same).toBe(true);
		expect(out.nextMoved).toBeGreaterThan(0);
		expect(out.oldMoved, 'the adopted interpreter still called the evicted instance').toBe(0);
		expect(Number(out.stored)).toBe(1);
	}, 900_000);

	it('reads an installed module file through the adopting instance, not the evicted one', async () => {
		const out = await inObject(freshSite(), async (site) => {
			site.ensureServeTables();
			site.sql.exec(
				'INSERT INTO cfw_module_file (path, package, version, source, installed_at) VALUES (?, ?, ?, ?, 0)',
				'modules/contrib/adopt_probe/src/Probe.php',
				'drupal/adopt_probe',
				'1.0.0',
				'<?php class CfwAdoptProbe { const OK = 1; }'
			);
			// the evicted instance's storage is gone on the platform; here the pool shares it, so
			// the old handle is made to refuse the way a dead one does
			const real = site.sql;
			let dead = false;
			site.sql = new Proxy(real, {
				get(target, prop) {
					if (dead) throw new Error('storage of an evicted instance');
					const v = Reflect.get(target, prop);
					return typeof v === 'function' ? v.bind(target) : v;
				}
			});
			await booted(site);
			const next = successor(site);
			await next.fetch(new Request('https://do.local/__serve-stats'));
			dead = true;
			// first opened after the adoption, so its row is read now
			const read = await next
				.runJson(
					`<?php require '/drupal/modules/contrib/adopt_probe/src/Probe.php'; echo json_encode(['ok' => CfwAdoptProbe::OK]);`
				)
				.catch((e: unknown) => ({ error: String(e) }));
			return { adopted: next.lastRetention?.adopted, read };
		});
		expect(out.adopted).toBe(true);
		expect(out.read).toEqual({ ok: 1 });
	}, 900_000);

	it('is refused when the object committed somewhere else in between', async () => {
		const out = await inObject(freshSite(), async (site) => {
			await booted(site);
			const old = site as Retaining;
			// the commit sequence moving after the interpreter was kept is what a write made in
			// another isolate looks like from here
			old.pendingCommits = 1;
			old.flushCommitSeq();
			const next = successor(site);
			await next.fetch(new Request('https://do.local/__serve-stats'));
			return { php: next.php, last: next.lastRetention };
		});
		expect(out.php).toBeUndefined();
		expect(out.last).toEqual(expect.objectContaining({ adopted: false, reason: 'stale' }));
	}, 900_000);

	it('keeps nothing once the interpreter was dropped', async () => {
		const out = await inObject(freshSite(), async (site) => {
			await booted(site);
			site.php = undefined;
			const next = successor(site);
			await next.fetch(new Request('https://do.local/__serve-stats'));
			return { php: next.php, last: next.lastRetention ?? null };
		});
		expect(out.php).toBeUndefined();
		expect(out.last).toBeNull();
	}, 900_000);

	it('keeps nothing with RETAIN_INTERPRETER=0, and is on without it', async () => {
		expect(retainInterpreterEnabled({} as never)).toBe(true);
		expect(retainInterpreterEnabled({ RETAIN_INTERPRETER: '0' } as never)).toBe(false);
		const out = await inObject(freshSite(), async (site) => {
			await booted(site, '0');
			const next = successor(site);
			await next.fetch(new Request('https://do.local/__serve-stats'));
			return { php: next.php, last: next.lastRetention ?? null };
		});
		expect(out.php).toBeUndefined();
		expect(out.last).toBeNull();
	}, 900_000);
});

describe('a boot after a drop instantiates into the dropped memory instead of beside it', () => {
	type Internals = {
		php?: { binary?: { wasmMemory?: WebAssembly.Memory } };
		ensurePhp(): Promise<unknown>;
		runJson(code: string): Promise<Record<string, unknown>>;
		oversized(): boolean;
		heapsReused?: number;
		env: Record<string, unknown>;
	};

	it(
		'reuses the memory, starts PHP fresh in it, and does not count its size as growth',
		async () => {
			const memoryOf = (s: Internals) => s.php?.binary?.wasmMemory;
			const out = await inObject(freshSite(), async (site) => {
				const s = site as unknown as Internals;
				await s.ensurePhp();
				const first = memoryOf(s);
				await s.runJson(
					`<?php $GLOBALS['cfw_reuse_marker'] = 1; echo json_encode(['ok' => true]);`
				);
				// the first boot may itself reuse a spare an earlier case in this isolate dropped
				const reusedBefore = s.heapsReused ?? 0;
				s.php = undefined;
				await s.ensurePhp();
				const second = memoryOf(s);
				const state = await s.runJson(
					`<?php echo json_encode(['carried' => isset($GLOBALS['cfw_reuse_marker'])]);`
				);
				// a threshold under the reused memory's size: before the boot-relative reading this
				// dropped the interpreter at the end of every invocation
				s.env = { ...s.env, RECYCLE_ABOVE_BYTES: String(32 * MIB) };
				return {
					imported: first instanceof WebAssembly.Memory,
					same: first !== undefined && first === second,
					carried: state.carried,
					reused: (s.heapsReused ?? 0) - reusedBefore,
					oversized: s.oversized()
				};
			});
			expect(out).toEqual({
				imported: true,
				same: true,
				carried: false,
				reused: 1,
				oversized: false
			});
		},
		REQUEST_TIMEOUT
	);

	it(
		'mounts the second boot from the pack the first one fetched, so no second blob is held',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				const s = site as unknown as Internals;
				const real = s.env['ASSETS'] as Fetcher;
				const fetched: string[] = [];
				s.env = {
					...s.env,
					ASSETS: {
						fetch: (input: RequestInfo | URL, init?: RequestInit) => {
							const url = input instanceof Request ? input.url : String(input);
							if (/core\.pf\.bin$/.test(url)) fetched.push(url);
							return real.fetch(input, init);
						}
					}
				};
				await s.ensurePhp();
				const first = await s.runJson(
					`<?php echo json_encode(['ok' => is_file('/drupal/index.php')]);`
				);
				s.php = undefined;
				await s.ensurePhp();
				const second = await s.runJson(
					`<?php echo json_encode(['ok' => strlen(file_get_contents('/drupal/core/lib/Drupal.php')) > 1000]);`
				);
				return { fetched: fetched.length, first: first.ok, second: second.ok };
			});
			// two before: each boot fetched its own 12 MB copy and the dropped one stayed until a GC
			expect(out).toEqual({ fetched: 1, first: true, second: true });
		},
		REQUEST_TIMEOUT
	);
});
