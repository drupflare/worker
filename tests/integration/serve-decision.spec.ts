import { describe, expect, it } from 'vitest';
import { FIRST_RUN_KEY } from '../../src/ops/setup-page';
import {
	asBrowser,
	inObject,
	probe,
	provisionedSite,
	seedPage,
	serveDirect,
	SESSION_COOKIE,
	type ServeDo
} from '../helpers/serve-do';

/**
 * WHICH REQUESTS MAY BE ANSWERED FROM `cfw_page`, asserted with no Drupal present.
 *
 * THE DEFECT THIS EXISTS FOR IS THE WORST ONE THIS PROJECT HAS SHIPPED. `/__serve` read `cfw_page`
 * before considering the method, so a POST to a cached path got the stored anonymous GET back with
 * a 200 and Drupal never ran. `/user/password` ships in `prefill.json`, so every password reset on
 * every site was silently swallowed from first boot. The e2e lane found it on its first run; the
 * gate never did.
 *
 * IT THEN STOPPED BEING GUARDED ON A CLEAN CHECKOUT. The fix made a non-GET fall THROUGH to the
 * gated lane instead of being answered from the cache, so the assertions that used to stop at the
 * cache now ended in a real render -- and `serve-chain`, `serve-lanes` and `degrade-serve` moved
 * into `ARTIFACT_SPECS`, where a checkout with no pack cannot run them.
 *
 * THE SEPARATION IS `inline=0`, AND IT NEEDED NO NEW SEAM. These assertions are about ROUTING --
 * which lane answered, and whether the cache was allowed to -- and the render only ever appeared
 * downstream of the answer. `inline=0` is an existing lever ("an explicit lever is honoured even
 * here; it is how a test forces a MISS"), taken AFTER the `cfw_page` read, so the read is still
 * exercised and the render is not. That makes this file gate-lane, hermetic and pack-free.
 *
 * A SEPARATE FILE RATHER THAN MORE CASES IN `serve-lanes.spec.ts`, and the reason is a lane
 * boundary rather than a feature split: those files legitimately need the pack for their other
 * half, and a case added there would inherit the exclusion this file exists to escape.
 *
 * FALSIFIED, NOT ASSUMED. `serve-lanes.spec.ts` used to assert `expect(out.cache).toBe('HIT')` for
 * exactly this POST, which pinned the defect in place -- so a test written from the current
 * implementation would agree with whatever the implementation does and prove nothing. This file was
 * checked by reintroducing the read-order defect (dropping the method and session terms from
 * `cacheable` in `src/site-do.ts`) with `assets/drupal-pf/` hidden, and requiring red. Same family
 * as [[regression-test-never-seen-fail]].
 *
 * EVERY REFUSAL IS PAIRED WITH THE HIT IT MUST NOT BREAK. "Not a HIT" is satisfied by a site that
 * cannot serve anything at all, so each case asserts the anonymous GET of the same seeded path in
 * the same object.
 */

const NO_RENDER = '&edge=0&inline=0';

/**
 * A claimed site with one page in `cfw_page`, plus the anonymous GET that must still hit it.
 *
 * `FIRST_RUN_KEY` is set because an unclaimed site answers an HTML NAVIGATION with the claim page,
 * which carries no `x-cfw-cache` at all -- so without it every "not a HIT" below would pass for
 * the wrong reason and its control would fail.
 */
async function seeded(site: ServeDo, path = '/') {
	await serveDirect(site, path);
	site.metaSet(FIRST_RUN_KEY, '1');
	seedPage(site, path, '<title>cached</title>');
	return serveDirect(site, path, NO_RENDER, asBrowser());
}

describe('a submission is never answered from the page cache', () => {
	it('refuses a POST to a path that IS cached, while the GET of it hits', async () => {
		const out = await inObject(await provisionedSite(), async (site: ServeDo) => {
			const anon = await seeded(site);
			const res = await site.fetch(
				new Request(`https://do.local/__serve?path=%2F${NO_RENDER}`, { method: 'POST' })
			);
			return { anon, post: await probe(res) };
		});

		expect(out.anon.cache, 'the control: the same path is cached').toBe('HIT');
		expect(out.post.cache).not.toBe('HIT');
		// the fast lane answers GET only, so a non-GET reaching the gated lane is the correct
		// routing; being ALLOWED there is what was wrong
		expect(out.post.lane).toBe('php-gate');
		// and it must not have quietly become a 200 by another route
		expect(out.post.status).toBe(503);
	});

	it('refuses every write method, not just the one the bug was found on', async () => {
		const out = await inObject(await provisionedSite(), async (site: ServeDo) => {
			const anon = await seeded(site);
			const methods = ['POST', 'PUT', 'PATCH', 'DELETE'];
			const answers: Record<string, string | null> = {};
			for (const method of methods) {
				const res = await site.fetch(
					new Request(`https://do.local/__serve?path=%2F${NO_RENDER}`, { method })
				);
				answers[method] = (await probe(res)).cache;
			}
			return { anon, answers };
		});

		expect(out.anon.cache).toBe('HIT');
		expect(Object.entries(out.answers).filter(([, cache]) => cache === 'HIT')).toEqual([]);
	});

	it('still answers HEAD from the cache, because HEAD writes nothing', async () => {
		const out = await inObject(await provisionedSite(), async (site: ServeDo) => {
			const anon = await seeded(site);
			const res = await site.fetch(
				new Request(`https://do.local/__serve?path=%2F&edge=0&lane=gate`, {
					method: 'HEAD'
				})
			);
			return { anon, head: await probe(res) };
		});

		expect(out.anon.cache).toBe('HIT');
		// `lane=gate` because the fast lane tests `method === 'GET'` exactly; the gated lane is
		// where the GET-or-HEAD decision lives and is what this case is about
		expect(out.head.cache).toBe('HIT');
	});
});

describe('a session is never answered from the page cache either', () => {
	it('refuses on the fast lane, where the row is an anonymous render', async () => {
		const out = await inObject(await provisionedSite(), async (site: ServeDo) => {
			const anon = await seeded(site);
			const auth = await serveDirect(site, '/', NO_RENDER, asBrowser(`${SESSION_COOKIE}=x`));
			return { anon, auth };
		});

		expect(out.anon.cache).toBe('HIT');
		expect(out.anon.lane).toBe('storage');
		expect(out.auth.cache).not.toBe('HIT');
	});

	it('refuses on the gated lane too, which is the half that used to be unenforced', async () => {
		const out = await inObject(await provisionedSite(), async (site: ServeDo) => {
			const anon = await seeded(site);
			const auth = await serveDirect(
				site,
				'/',
				`${NO_RENDER}&lane=gate`,
				asBrowser(`${SESSION_COOKIE}=x`)
			);
			return { anon, auth };
		});

		expect(out.anon.cache).toBe('HIT');
		expect(out.auth.lane).toBe('php-gate');
		expect(out.auth.cache).not.toBe('HIT');
	});

	it('does NOT refuse an ordinary cookie, or every visitor would miss', async () => {
		// the guard keys on a session-shaped name. Drupal sets `Drupal.toolbar.collapsed` and any
		// number of analytics cookies on anonymous visitors, and treating those as a session would
		// take the cache hit rate to zero without failing a single test
		const out = await inObject(await provisionedSite(), async (site: ServeDo) => {
			await seeded(site);
			return serveDirect(site, '/', NO_RENDER, asBrowser('Drupal.toolbar.collapsed=1'));
		});
		expect(out.cache).toBe('HIT');
	});
});

describe('an unclaimed site answers its owner rather than its front page', () => {
	it('withholds the cached page until the site is claimed', async () => {
		const out = await inObject(await provisionedSite(), async (site: ServeDo) => {
			await serveDirect(site, '/');
			seedPage(site, '/', '<title>cached</title>');
			const unclaimed = await serveDirect(site, '/', NO_RENDER, asBrowser());
			site.metaSet(FIRST_RUN_KEY, '1');
			return { unclaimed, claimed: await serveDirect(site, '/', NO_RENDER, asBrowser()) };
		});

		// ordered after the migration guards and the counter, so this is the setup page rather
		// than a warming placeholder
		expect(out.unclaimed.cache).not.toBe('HIT');
		expect(out.unclaimed.status).toBe(200);
		expect(out.claimed.cache).toBe('HIT');
	});
});
