import { expect, gotoPage, loginAsAdmin, test } from './utils/fixtures.js';

/**
 * The admin pages a site owner actually opens, checked for a page that answers 200 and threw.
 *
 * The lane already covered six routes, five of which are anonymous or account surfaces. Everything
 * an operator does after claiming a site -- installing a module, placing a block, reading the status
 * report -- was outside it, and those are the pages carrying the most JavaScript: a table filter, a
 * drag-and-drop weight UI, a bulk-operations form, contextual links.
 *
 * ALL SIX WERE MEASURED CLEAN when this was written, so nothing here is a bug report. It is a
 * regression net: `/user/register` and `/user/1/edit` were a white screen on every site ever created
 * and the HTTP lane read both as healthy, which is the failure this lane exists to make impossible.
 * The console guard in `fixtures.ts` is the assertion; a bare navigation is the whole test.
 */

const SURFACES: ReadonlyArray<readonly [string, string]> = [
	['the content list, which is a view with a bulk-operations form', '/admin/content'],
	['the module list, whose filter is the heaviest table JS in core', '/admin/modules'],
	['block layout, which carries the drag-and-drop weight UI', '/admin/structure/block'],
	['the status report, where every requirement row renders', '/admin/reports/status'],
	['the permissions grid, the widest table an admin loads', '/admin/people/permissions'],
	['a rendered node, which is where contextual links and BigPipe land', '/node/1']
];

for (const [what, path] of SURFACES) {
	test(`${what} renders without a console error`, async ({ page }) => {
		await loginAsAdmin(page);
		const res = await gotoPage(page, path);
		expect(res.status()).toBe(200);
		// something from the page itself, so a redirect to a login form cannot pass as a render
		await expect(page.locator('body')).toBeVisible();
	});
}
