import { describe, expect, it } from 'vitest';
import { routeTable } from '../../../src/site';
import { SURFACE_PREFIX } from '../../../src/ui/admin';

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

/**
 * Every route reaches something, asserted over the WHOLE table rather than over a named list.
 *
 * The dispatcher ends `inner.pathname = DO_ROUTE[url.pathname] as string`, and a route with no entry
 * therefore sends the literal `undefined` to the object. That has shipped twice: `/setup/cf` and
 * `/setup/mail` were documented as live and were rewritten to `/serve`, and `/fleet` answered 404 to
 * every caller including `scripts/security-update.mjs --fleet=`. Both were found by a human using
 * the route, because every assertion covering this names the routes it checks -- so a route added
 * tomorrow is covered by none of them.
 */
const WORKER_ANSWERED = new Set(['/fillwindow', '/fleet']);

describe('the route table forwards everything it claims to own', () => {
	it('gives every route either a DO_ROUTE entry or a Worker-side answer', () => {
		const table = routeTable();
		const unreachable = [...table.all].filter(
			(p) =>
				typeof table.doRoute[p] !== 'string' &&
				!WORKER_ANSWERED.has(p) &&
				!p.startsWith(SURFACE_PREFIX)
		);
		expect(
			unreachable,
			'these routes rewrite to `undefined` at the object; add a DO_ROUTE entry or answer them ' +
				'in the Worker'
		).toEqual([]);
	});

	it('names no DO_ROUTE target that is not a route, so the table cannot rot the other way', () => {
		const table = routeTable();
		const orphans = Object.keys(table.doRoute).filter((p) => !table.all.has(p));
		expect(orphans, 'a DO_ROUTE entry for a path `ROUTES` does not carry is dead').toEqual([]);
	});

	it('routes every entry to a `__`-prefixed inner path', () => {
		// the object refuses an inner path that is not double-underscored, so a typo here is a 404
		// that reads as a missing feature
		const bad = Object.entries(routeTable().doRoute).filter(
			([, inner]) => !inner.startsWith('/__')
		);
		expect(bad).toEqual([]);
	});

	it('keeps the Worker-answered set honest, so an entry cannot hide a missing route', () => {
		// the control: each exemption above is a claim that the Worker answers the path itself, and
		// a stale one is how an exemption list becomes a way to silence this check
		const table = routeTable();
		for (const path of WORKER_ANSWERED) {
			expect(table.all.has(path), `${path} is exempted but is not a route`).toBe(true);
			expect(
				table.doRoute[path],
				`${path} has a DO_ROUTE entry now; drop the exemption`
			).toBeUndefined();
		}
	});
});
