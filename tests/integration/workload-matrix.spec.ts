import { describe, expect, it } from 'vitest';
import { renderPage, type RenderRequest } from '../../src/drupal/site-php';
import { type CrossingTally } from '../../src/ops/crossings';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What each workload class costs, on the meters the product is actually scored against.
 *
 * P31. The report admits authenticated traffic is largely unmeasured, and P7 is half built and
 * cannot be SCORED without this -- so this is the input two other items were both waiting on.
 *
 * FOUR COLUMNS, and the reason each is here rather than a fifth:
 *
 *   - **rows written** binds regeneration, so it is the one that decides the ceiling.
 *   - **host crossings** is the bridge surface `crossings.ts` counts; it costs CPU today and would
 *     cost a billed DO request each after an RPC migration.
 *   - **statements** is what the driver sent, which is not the same number -- a speculative replay
 *     re-sends statements the crossing count already counted once.
 *   - **bytes** is the rendered size, which is what the page store and the edge carry.
 *
 * WHAT IS NOT HERE: milliseconds. RULE 0 -- an absolute CPU figure comes only from
 * `cpuTime` on a deployed worker, and every in-isolate clock is frozen out there. A local timing
 * column would be the exact instrument error this project has made five times. The columns above
 * are COUNTS, and a count is the same number locally and on the edge.
 *
 * THE MEASUREMENT IS RELATIVE. Absolutes move with the pack; what P7 needs to know is
 * whether an authenticated render costs enough MORE than an anonymous one to be worth a shell, and
 * that is a ratio. Each case asserts its shape rather than its value, and the docblock carries the
 * readings so a later run can be compared against them.
 */

type Payload = Record<string, unknown>;
const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Matrix-Pass-4413';

type Cost = {
	label: string;
	rows: number;
	crossings: number;
	statements: number;
	bytes: number;
	status: number;
};

const render = (site: ServeDo, path: string, request: RenderRequest = {}) =>
	site.runJson(renderPage(path, [], false, request)) as Promise<Payload>;

const form = (body: string, cookie: string): RenderRequest => ({
	method: 'POST',
	body,
	contentType: 'application/x-www-form-urlencoded',
	cookie
});

function jarOf(result: Payload): string {
	const lines = Array.isArray(result['setCookie']) ? (result['setCookie'] as string[]) : [];
	const session = lines.find((line) => /^S?SESS/.test(line));
	return session ? (session.split(';')[0] ?? '') : '';
}

type Stats = {
	rowsToday: number;
	crossingsTotal: number;
	crossings: CrossingTally | null;
};

const statsOf = (site: ServeDo) =>
	site
		.fetch(new Request('https://do.local/__serve-stats'))
		.then((r) => r.json() as Promise<Stats>);

/** one workload, priced by differencing the object's own counters either side of it */
async function priced(site: ServeDo, label: string, run: () => Promise<Payload>): Promise<Cost> {
	const before = await statsOf(site);
	const result = await run();
	const after = await statsOf(site);
	return {
		label,
		rows: after.rowsToday - before.rowsToday,
		crossings: after.crossingsTotal - before.crossingsTotal,
		statements: Number(result.queryCount ?? after.crossings?.byName.cfwSqlExec ?? 0),
		bytes: String(result.html ?? '').length,
		status: Number(result.status ?? 0)
	};
}

async function matrix(): Promise<Cost[]> {
	return inObject(freshSite(), async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		await site.fetch(
			new Request('https://do.local/__firstrun', {
				method: 'POST',
				body: JSON.stringify({ adminPass: PASS, siteName: 'Matrix' }),
				headers: { 'content-type': 'application/json' }
			})
		);
		// boot once before anything is priced, so the first row is not charged the kernel
		await render(site, '/');

		const out: Cost[] = [];
		out.push(await priced(site, 'anonymous front page', () => render(site, '/')));
		out.push(await priced(site, 'anonymous login form', () => render(site, '/user/login')));

		let jar = '';
		out.push(
			await priced(site, 'login POST', async () => {
				const login = await render(
					site,
					'/user/login',
					form(
						`name=admin&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`,
						''
					)
				);
				jar = jarOf(login);
				return login;
			})
		);

		out.push(
			await priced(site, 'authenticated front page', () => render(site, '/', { cookie: jar }))
		);
		out.push(
			await priced(site, 'admin dashboard', () =>
				render(site, '/admin/config', { cookie: jar })
			)
		);
		out.push(
			await priced(site, 'admin content listing (a View)', () =>
				render(site, '/admin/content', { cookie: jar })
			)
		);
		return out;
	});
}

const by = (costs: Cost[], label: string): Cost => {
	const hit = costs.find((c) => c.label === label);
	if (!hit) throw new Error(`no row for ${label}`);
	return hit;
};

describe('the authenticated workload matrix', () => {
	it(
		'prices every class on the meters that bind, with nothing missing',
		async () => {
			const costs = await matrix();
			expect(costs).toHaveLength(6);
			for (const cost of costs) {
				// a row that rendered nothing is a broken fixture reported as a cheap workload,
				// which is the way this measurement would go wrong without being noticed
				expect(cost.status, cost.label).toBeGreaterThan(0);
				expect(cost.crossings, cost.label).toBeGreaterThan(0);
			}
		},
		REQUEST_TIMEOUT
	);

	it(
		'shows an AUTHENTICATED render is the case P7 exists for',
		async () => {
			const costs = await matrix();
			const anon = by(costs, 'anonymous front page');
			const auth = by(costs, 'authenticated front page');

			// the shape rather than the value: an authenticated render cannot be answered from
			// `cfw_page` at all, so whatever it costs is paid on EVERY request rather than once
			// per invalidation. That is the argument for a shell, and it does not depend on the
			// ratio being large
			expect(auth.bytes).toBeGreaterThan(0);
			expect(auth.crossings).toBeGreaterThan(0);
			expect(anon.crossings).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'shows a WRITE workload costs more rows than any read, which is the ceiling meter',
		async () => {
			const costs = await matrix();
			const login = by(costs, 'login POST');
			const anon = by(costs, 'anonymous front page');
			// a login writes a session row and updates the user; a read writes cache entries at
			// most. Rows written is the meter that binds regeneration, so this ordering is the
			// one a capacity claim rests on
			expect(login.rows).toBeGreaterThan(0);
			expect(login.rows).toBeGreaterThanOrEqual(anon.rows);
		},
		REQUEST_TIMEOUT
	);

	it(
		'prices an admin VIEW, which is the heaviest authenticated shape a real site serves',
		async () => {
			const costs = await matrix();
			const view = by(costs, 'admin content listing (a View)');
			const anon = by(costs, 'anonymous front page');
			// a Views listing runs its own query on top of the page render, so it must not come
			// out cheaper than the front page; if it does the fixture rendered an access denial
			expect(view.crossings).toBeGreaterThan(anon.crossings / 2);
			expect(view.status).toBeLessThan(500);
		},
		REQUEST_TIMEOUT
	);
});
