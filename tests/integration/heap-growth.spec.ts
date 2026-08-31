import { describe, expect, it } from 'vitest';
import { renderPage } from '../../src/drupal/site-php';
import { freshSite, inObject, queuePath, type ServeDo } from '../helpers/serve-do';

/**
 * WHERE the heap grows, and how much of the peak is allocator over-reservation.
 *
 * `linear-memory.spec.ts` pins the shipping arm. This file is the one a LADDER run drives:
 * `scripts/measure/growth-ladder.ts` re-runs it against a glue variant emitted at a different
 * `MEMORY_GROWTH_GEOMETRIC_STEP`, so every assertion here has to hold at ANY step. Anything that
 * depends on 0.20 belongs in the other file.
 *
 * THE OPEN QUESTION THIS ANSWERS. The peak is `INITIAL_MEMORY` grown once, which BOUNDS live demand
 * at `100,663,296 < demand <= 120,848,384` and reveals it nowhere in that 19.25 MiB interval. The two
 * ends imply opposite strategies -- 20 MiB of over-reservation is an allocator problem, 2 MiB is a
 * PHP live-state problem -- so the interval had to be collapsed before anything could be proposed.
 * At a step of 0 the geometric candidate collapses to `oldSize` and the new size becomes
 * `align(requestedSize, 64 KiB)`, so the peak IS demand, to a page.
 *
 * THE PROFILE LINE IS THE OUTPUT. Each run prints one `[heap-profile]` record; the ladder driver
 * reads them across arms and does the cross-arm arithmetic, because "a smaller step must not produce
 * a larger peak" is a relationship between runs and cannot be asserted inside one.
 *
 * COUNTS AND BYTES ONLY, never milliseconds -- RULE 0. Growth overhead is real and it is a CPU cost,
 * so it is NOT scored here; a local clock cannot see it and an edge one would need a
 * deploy per arm.
 */

const MIB = 1_048_576;
const PAGE = 65_536;
const AUTH_PASS = 'cfw-Growth-Pass-8821';

/** the Durable Object isolate limit; a platform figure rather than a budget chosen here */
const ISOLATE_LIMIT = 128 * MIB;

type Profile = {
	bootedIdle: number;
	afterFirstRender: number;
	afterSecondRender: number;
};

async function heapOf(site: ServeDo): Promise<number> {
	const res = await site.fetch(new Request('https://do.local/__heap?op=status'));
	const body = (await res.json()) as Record<string, unknown>;
	return Number(body.linearMemoryBytes ?? 0);
}

async function render(site: ServeDo): Promise<void> {
	queuePath(site, '/', { arm: false });
	await site.fetch(new Request('https://do.local/__fill'));
}

async function profile(): Promise<Profile> {
	const reading = await inObject(freshSite(), async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		// `/__php` boots the interpreter and does nothing else, so this is the idle heap
		await site.fetch(new Request('https://do.local/__php'));
		const bootedIdle = await heapOf(site);
		await render(site);
		const afterFirstRender = await heapOf(site);
		// a SECOND render on the same warm object: if the peak is a first-render transient this
		// does not move, and that distinguishes a one-off staging cost from a per-render one
		await render(site);
		return { bootedIdle, afterFirstRender, afterSecondRender: await heapOf(site) };
	});

	console.log(`[heap-profile] ${JSON.stringify(reading)}`);
	return reading;
}

/**
 * The INSTALL, which is a different workload and the one that peaks highest.
 *
 * RULE 0c's second question. A ceiling computed from a render has not scored an install, and the
 * install is where a growth-step change would fail first if it were going to -- so a step that is
 * only ever measured against a front-page render is a step that was never measured.
 */
async function installProfile(): Promise<number> {
	const peak = await inObject(freshSite(), async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		await site.fetch(
			new Request('https://do.local/__firstrun', {
				method: 'POST',
				body: JSON.stringify({ adminPass: AUTH_PASS, siteName: 'Growth' }),
				headers: { 'content-type': 'application/json' }
			})
		);
		await render(site);
		return heapOf(site);
	});

	console.log(`[heap-profile-install] ${JSON.stringify({ peak })}`);
	return peak;
}

/**
 * The AUTHENTICATED render, which is the third workload and the one nobody had scored.
 *
 * Same RULE 0c question as the install, asked again: a step chosen against an anonymous render and
 * an install has still not been scored against the workload P7 exists to serve. A logged-in render
 * carries a session, a user entity, an account menu and BigPipe's whole delivery path, none of
 * which an anonymous fill allocates.
 */
async function authProfile(): Promise<number> {
	const peak = await inObject(freshSite(), async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		await site.fetch(
			new Request('https://do.local/__firstrun', {
				method: 'POST',
				body: JSON.stringify({ adminPass: AUTH_PASS, siteName: 'Growth' }),
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
		const jar = (lines.find((l) => /^S?SESS/.test(l))?.split(';')[0] ?? '').trim();
		// twice, because the peak has to be the workload's rather than the first render's staging
		for (let i = 0; i < 2; i++) {
			await site.runJson(
				renderPage('/', ['dynamic_page_cache', 'render'], false, { cookie: jar })
			);
		}
		return heapOf(site);
	});

	console.log(`[heap-profile-auth] ${JSON.stringify({ peak })}`);
	return peak;
}

describe('the heap-growth profile, at whatever step the lane was given', () => {
	it('stays under the isolate limit through the first render', async () => {
		const heap = await profile();
		expect(heap.bootedIdle).toBeGreaterThan(0);
		// >= rather than >: with `OPCACHE_MODE=off` an anonymous render completes inside
		// `INITIAL_MEMORY` on every arm, so a strict inequality here would fail the whole ladder
		// for the reason the ladder exists to report
		expect(heap.afterFirstRender).toBeGreaterThanOrEqual(heap.bootedIdle);
		expect(heap.afterFirstRender).toBeLessThanOrEqual(ISOLATE_LIMIT);
		expect(heap.bootedIdle % PAGE, 'wasm pages are 64 KiB').toBe(0);
		expect(heap.afterFirstRender % PAGE).toBe(0);
	}, 900_000);

	it('does not grow again for a SECOND render, so the peak is reached once', async () => {
		const heap = await profile();
		// the render's demand is satisfied from the free list the first render left behind.
		// If this ever fails the peak is a function of traffic rather than of the workload,
		// which would make every capacity figure in the model a lower bound
		expect(heap.afterSecondRender).toBe(heap.afterFirstRender);
	}, 900_000);

	it('survives an INSTALL, which peaks higher than a render, without exceeding the limit', async () => {
		const peak = await installProfile();
		expect(peak).toBeGreaterThan(0);
		expect(peak).toBeLessThanOrEqual(ISOLATE_LIMIT);
		expect(peak % PAGE).toBe(0);
	}, 900_000);

	it('survives an AUTHENTICATED render, the third workload, without exceeding the limit', async () => {
		const peak = await authProfile();
		expect(peak).toBeGreaterThan(0);
		expect(peak).toBeLessThanOrEqual(ISOLATE_LIMIT);
		expect(peak % PAGE).toBe(0);
	}, 900_000);
});
