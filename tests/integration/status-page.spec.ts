import { describe, expect, it } from 'vitest';
import { claimSite, loginJar, render } from '../helpers/drupal-forms';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The runtime status page, rendered for real.
 *
 * Every value cell was blank on a deployed site: `table()` handed each cell a bare render array,
 * and Drupal reads an array cell without `data` as ATTRIBUTES, so the markup was
 * `<td #plain_text="Yes"></td>`. Nothing had rendered the page, so the dash fix for absent values
 * shipped into cells that could not show anything either.
 */

const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Status-3309-pass';
const ORIGIN = 'https://do.local';

describe('the runtime status page', () => {
	it(
		'shows a value in every row',
		async () => {
			const html = await inObject(freshSite(), async (site: ServeDo) => {
				await claimSite(site, PASS, 'Status');
				site.sql.exec('DELETE FROM cache_container');
				const cookie = await loginJar(site, 'admin', PASS, ORIGIN);
				const page = await render(site, '/admin/config/drupflare/status', {
					cookie,
					origin: ORIGIN
				});
				return String(page['html'] ?? '');
			});
			const cell = (label: string) =>
				new RegExp(`<td>${label}</td>\\s*<td[^>]*>([^<]*)</td>`).exec(html)?.[1]?.trim();
			expect(cell('Interpreter booted'), 'the page did not render the row at all').toMatch(
				/^(Yes|No)$/
			);
			// no cell may carry a render array's keys as attributes
			expect(html).not.toMatch(/<td #/);
			// a translated fallback prints as words, not as a JSON string
			expect(cell('Mail transport')).toBe('none configured');
			expect(cell('Shell candidates')).toMatch(/^\d+ safe, \d+ unsafe$/);
			// a primary has no lane stage
			expect(cell('Role')).toBe('primary');
			expect(cell('Stage')).toBe('&mdash;');
		},
		REQUEST_TIMEOUT
	);
});
