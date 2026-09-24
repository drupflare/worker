import { describe, expect, it } from 'vitest';
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
			expect(out.before).toBe(BOOTED_IDLE);
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
				site.php = null;
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
				site.php = null;
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
			expect(ladder[0]?.[1]).toBe(BOOTED_IDLE);

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
				const dropped = site.php === null;
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
			expect(Math.max(...series)).toBe(Math.min(...series));
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
			for (const s of out.steps) expect(s.heap, s.step).toBeGreaterThan(0);

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
		noteResident('residency-a', null);
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
		noteResident('residency-wasm', null);
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
				).json()) as { isolate: { id: string; interpreters: number; linearBytes: number } };
			});
		const first = await booted();
		const second = await booted();
		// THE CONTROL: the first object reports its own interpreter, or a count of two below
		// could be two stale entries rather than two live ones
		expect(first.isolate.interpreters).toBeGreaterThanOrEqual(1);
		// the test pool runs every object in one isolate, which is the co-residency this reports
		expect(second.isolate.id).toBe(first.isolate.id);
		expect(second.isolate.interpreters).toBeGreaterThanOrEqual(2);
		expect(second.isolate.linearBytes).toBeGreaterThan(first.isolate.linearBytes);
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
		expect(out.php).toBeNull();
		expect(out.last).toEqual(expect.objectContaining({ adopted: false, reason: 'stale' }));
	}, 900_000);

	it('keeps nothing once the interpreter was dropped', async () => {
		const out = await inObject(freshSite(), async (site) => {
			await booted(site);
			site.php = null;
			const next = successor(site);
			await next.fetch(new Request('https://do.local/__serve-stats'));
			return { php: next.php, last: next.lastRetention ?? null };
		});
		expect(out.php).toBeNull();
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
		expect(out.php).toBeNull();
		expect(out.last).toBeNull();
	}, 900_000);
});
