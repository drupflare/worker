import { describe, expect, it } from 'vitest';
import { renderPage } from '../../src/drupal/site-php';
import { writeCursor, type StoredCursor } from '../../src/ops/cron';
import { DEFAULT_CRON_BUDGET, driveCron } from '../../src/ops/cron-drive';
import { freshSite, inObject, queuePath, type ServeDo } from '../helpers/serve-do';

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

/** `INITIAL_MEMORY`: where a booted interpreter starts and where provisioning must leave one */
const BOOTED_IDLE = 96 * MIB;

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
