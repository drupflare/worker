import { describe, expect, it } from 'vitest';
import { routeTable } from '../../../src/site';

/**
 * Which routes an owner reaches with a per-site token rather than a deployment-wide boolean.
 *
 * `PW_DIAGNOSTICS=1` is one flag that simultaneously exposes `/sql` (arbitrary SQL against the site
 * database), `/restore` (a whole-database overwrite) and `/php`. Four ordinary maintenance actions
 * sat behind it, so purging your own page cache meant opening a remote shell to the internet first.
 *
 * The direction matters and is asserted both ways: an owner token is NARROWER than the flag, because
 * it is per site, and adding a route here must not remove the flag's existing reach for anything
 * that already worked.
 */

/** the four that moved: ordinary maintenance an owner should not need diagnostics for */
const MOVED = ['/armfill', '/invalidate', '/bump', '/migrate'] as const;

/** the two that are new, so there is no caller to keep working and no diagnostics fallback */
const OWNER_ONLY = ['/updb', '/modify'] as const;

describe('site maintenance is reachable with an owner token', () => {
	it.each(MOVED)('%s is an owner route', (path) => {
		expect(routeTable().owner.has(path)).toBe(true);
	});

	/** nothing that worked stops working; the token is an additional way in */
	it.each(MOVED)('%s still answers under PW_DIAGNOSTICS', (path) => {
		expect(routeTable().diagnostic.has(path)).toBe(true);
	});

	it.each(OWNER_ONLY)('%s is owner-only, with no diagnostics fallback', (path) => {
		expect(routeTable().owner.has(path)).toBe(true);
		expect(routeTable().diagnostic.has(path)).toBe(false);
	});

	/** a path absent from the union is rewritten to /serve and rendered as a page, silently */
	it.each([...MOVED, ...OWNER_ONLY])('%s is in the union and forwards to the object', (path) => {
		expect(routeTable().all.has(path)).toBe(true);
		expect(routeTable().doRoute[path], `${path} has no DO_ROUTE entry, so it is a 404`).toBe(
			`/__${path.slice(1)}`
		);
	});

	/** none of them is public, which is the assertion that makes the rest mean something */
	it.each([...MOVED, ...OWNER_ONLY])('%s is not public', (path) => {
		expect(routeTable().public.has(path)).toBe(false);
	});
});
