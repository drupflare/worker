import { BASE_URL, SITE, expect, gotoPage, loginAsAdmin, test } from './utils/fixtures.js';

/**
 * The admin surface driven by ENUMERATION rather than by hand.
 *
 * THE RATIO IS THE FINDING. The browser lane covered 17 distinct site paths against a router
 * carrying 448 routes, 311 of them under `/admin` -- and every defect the last QA pass reported was
 * reachable from a browser and reachable by none of the suite. The pages someone happened to visit
 * are a sample, and the sample rate was 17 of 448. A list written by hand has the same problem one
 * page later, so this reads the router table the site actually has.
 *
 * WHAT IT REFUSES TO OPEN, and each exclusion is a property of the ROUTE rather than a page that
 * failed. A destructive route (`/delete`, `/uninstall`) changes the site under the rest of the
 * suite; a route with a parameter has no value to substitute; a non-GET route is not a page. The
 * count of what was excluded is asserted, so an exclusion that silently swallowed the whole list
 * fails rather than passing on nothing.
 */

const MAX_PAGES = Number(process.env.CFW_BROWSER_ADMIN_MAX ?? 25);

/**
 * OPT-IN, and the reason is measured rather than cautious.
 *
 * Opening 25 admin pages leaves the site with a full fill queue and a run of cache-tag
 * invalidations, and this file sorts first -- so the whole lane went from 15 passed to 8 failed with
 * every failure downstream of it. Both halves are true: those pages render, and driving them is not
 * hermetic. A sweep belongs in a run of its own.
 *
 *   CFW_BROWSER_ENUMERATE=1 bun run test:browser -- admin-enumerated
 */
const ENUMERATE = process.env.CFW_BROWSER_ENUMERATE === '1';

/** a route this must not open, by what it DOES rather than by having been seen to fail */
const DESTRUCTIVE =
	/\/(delete|uninstall|disable|reset|revert|cancel|flush|rebuild|clear|logout|purge)(\/|$)/;

type RouterRow = { path: string };

/**
 * Every admin path the site's own router carries, filtered to what a GET may open.
 *
 * Read through the diagnostic SQL route rather than from a fixture: a list compiled at build time
 * describes the pack, and what matters is the routes THIS site has after whatever was installed.
 */
async function adminPaths(): Promise<string[]> {
	// PAGED, because `/sql` answers `rows.slice(0, 50)`. Reading one page and calling it the router
	// is the same sampling error this file exists to remove, one layer down
	const collected: string[] = [];
	for (let offset = 0; offset < 1000; offset += 50) {
		const url = new URL('/sql', BASE_URL);
		url.searchParams.set('site', SITE);
		url.searchParams.set(
			'q',
			`SELECT path FROM router WHERE path LIKE '/admin%' ORDER BY path LIMIT 50 OFFSET ${offset}`
		);
		const res = await fetch(url);
		if (!res.ok) throw new Error(`/sql answered ${res.status}; is PW_DIAGNOSTICS on?`);
		const body = (await res.json()) as { rows?: RouterRow[] };
		const rows = Array.isArray(body.rows) ? body.rows : [];
		for (const row of rows) collected.push(String(row.path));
		if (rows.length < 50) break;
	}
	return (
		[...new Set(collected)]
			.filter((p) => p.startsWith('/admin'))
			// a `{parameter}` has no value to substitute, and guessing one reaches a different page
			.filter((p) => !p.includes('{'))
			.filter((p) => !DESTRUCTIVE.test(p))
			.sort()
	);
}

test.skip(!ENUMERATE, 'set CFW_BROWSER_ENUMERATE=1; this sweep is not hermetic');

test('the router carries the admin surface this lane samples from', async () => {
	const paths = await adminPaths();
	// the denominator, asserted so a broken query reads as a failure rather than as an empty pass
	expect(paths.length, 'no admin routes came back from the router table').toBeGreaterThan(50);
});

test('every enumerated admin page renders without a console error', async ({ page }) => {
	test.setTimeout(15 * 60_000);
	// RETRIED ONCE. The login POST answers 503 while the object is still warming, which is the
	// designed answer rather than a fault -- and this spec is the one that leaves it busy
	try {
		await loginAsAdmin(page);
	} catch {
		await loginAsAdmin(page);
	}

	const paths = await adminPaths();
	// bounded per run, and the bound is REPORTED: a silent top-N reads as "covered everything"
	const opening = paths.slice(0, MAX_PAGES);
	const skipped = paths.length - opening.length;
	if (skipped > 0) {
		console.log(
			`admin-enumerated: opened ${opening.length} of ${paths.length}; ` +
				`raise CFW_BROWSER_ADMIN_MAX to cover the rest`
		);
	}

	// COLLECTED AND REPORTED TOGETHER rather than failing on the first. One broken page tells you
	// one page is broken; the list tells you whether it is a page or the whole surface, and that is
	// the difference between a bug report and a diagnosis
	const broken: string[] = [];
	for (const path of opening) {
		try {
			await gotoPage(page, path, 60_000);
		} catch (e: unknown) {
			broken.push(`${path}: ${String((e as Error)?.message ?? e).split('\n')[0]}`);
		}
	}
	expect(broken, `${broken.length} of ${opening.length} admin pages did not render`).toEqual([]);
});
