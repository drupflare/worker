import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../src/drupal/site-php';
import { dailyLimit, READ_ONLY_AT, REDUCE_AT } from '../../src/ops/degrade';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What an operator setting a site up costs on the meter that binds regeneration.
 *
 * Recorded and never reproduced: five module installs plus two heap images on one site wrote 104,451
 * rows in a day and put the site read-only at 104% of quota, with nothing on any admin page saying
 * so. It is the workload an operator actually performs -- nobody installs one module -- and it is the
 * one workload the free-envelope model never scored, because the model prices SERVING and
 * REGENERATION and an install is neither.
 *
 * Rows are exact, so this needs no spread: `dailyRows()` is the object's own UTC-day counter and it
 * is read without flushing. What has an n is the per-step attribution, which is what says where to
 * aim.
 *
 * **AND THE SECOND HALF IS THE ONE THAT MATTERS.** A number an operator cannot see is not a warning.
 * `serveStatsSync()` has carried the allowance, the percentage and the status for both daily meters
 * all along; the only surface reading them was the hosting product's Limits page, behind an owner
 * token a site administrator does not have, and `StatusController` rendered the raw count with no
 * allowance beside it. `Requirements::dailyQuotaRows()` puts both meters on
 * `/admin/reports/status`, which is the page an operator opens when something is wrong.
 */

const TIMEOUT = 900_000;

/** the modules a setup session installs; four contrib from the shipping pack plus one core */
const MODULES = ['token', 'ctools', 'pathauto', 'admin_toolbar', 'contact'] as const;

const IMAGES = 2;

type Payload = Record<string, unknown>;

/** the status report, read at a request boundary the way `cfw_serve()` builds one */
const REPORT = drupalOp(String.raw`
\Drupal::moduleHandler()->loadAll();
\Drupal::service('drupflare.request_resetter')->reset();
$req = \Symfony\Component\HttpFoundation\Request::create('/admin/reports/status', 'GET');
$req->server->set('SERVER_SOFTWARE', 'Cloudflare Workers');
$req->server->set('REQUEST_TIME', time());
\Drupal::service('request_stack')->push($req);
$rows = [];
foreach (\Drupal::service('system.manager')->listRequirements() as $key => $row) {
  $severity = $row['severity'] ?? 0;
  if (is_object($severity)) { $severity = (int) ($severity->value ?? 0); }
  // a row's value is a TranslatableMarkup rather than a string, so is_scalar() drops every one of
  // them and an assertion on the text reads as an empty row
  $value = $row['value'] ?? null;
  $printable = is_scalar($value) || (is_object($value) && method_exists($value, '__toString'));
  $rows[$key] = ['severity' => (int) $severity, 'value' => $printable ? (string) $value : ''];
}
$out['report'] = $rows;
$out['ok'] = true;`);

type Report = { report: Record<string, { severity: number; value: string }> };

const readReport = async (site: ServeDo): Promise<Report> => {
	const out = (await site.runJson(REPORT)) as Payload;
	expect(
		out.ok,
		`the status report could not be built: ${JSON.stringify(out).slice(0, 500)}`
	).toBe(true);
	return out as unknown as Report;
};

/** the row this file exists to put there; keyed off the meter id `THRESHOLDS` uses */
const ROWS_QUOTA = 'drupflare_quota_rows_written';
const DO_QUOTA = 'drupflare_quota_do_requests';

describe('a setup session against the daily row meter', () => {
	it(
		'prices five module installs and two heap images, and puts them on the status report',
		async () => {
			const stub = freshSite();
			const out = await inObject(stub, async (site: ServeDo) => {
				const steps: { step: string; rows: number; at: number }[] = [];
				const mark = (step: string, before: number) => {
					const at = site.dailyRows();
					steps.push({ step, rows: at - before, at });
					return at;
				};

				let at = site.dailyRows();
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				at = mark('migrate', at);
				const first = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ adminPass: 'cfw-Qa-9912-pass', siteName: 'Qa' })
					})
				);
				expect(first.status, await first.clone().text()).toBe(200);
				at = mark('firstrun', at);
				const provisioned = at;

				const installs: Payload[] = [];
				for (const module of MODULES) {
					installs.push(
						(await (
							await site.fetch(
								new Request(`https://do.local/__enable?module=${module}`)
							)
						).json()) as Payload
					);
					at = mark(`install:${module}`, at);
				}

				for (let i = 0; i < IMAGES; i++) {
					// `fresh=1` refuses to image a restored heap, which is what makes each of these
					// a real read of a booted interpreter rather than a copy of the last image
					const res = await site.fetch(
						new Request('https://do.local/__heap?op=snapshot&fresh=1', {
							headers: { 'x-cfw-owner': 'test' }
						})
					);
					expect(res.status, await res.clone().text()).toBe(200);
					at = mark(`heap-image:${i + 1}`, at);
				}

				const report = await readReport(site);

				// THE OTHER DIRECTION, and it is what says the row tracks the meter rather than
				// existing. The counter is forced past the read-only fraction and the report is read
				// again; a row that cannot change severity is decoration
				const today = new Date(site.nowMs()).toISOString().slice(0, 10);
				const limit = dailyLimit('rows-written', site.env as never);
				site.metaSet(`rows_written_${today}`, Math.ceil(limit * READ_ONLY_AT) + 1);
				const saturated = await readReport(site);
				const saturatedRows = site.dailyRows();

				return {
					steps,
					provisioned,
					installs: installs.map((i) => ({
						module: i.module,
						ok: i.ok,
						charged: i.rowsWritten
					})),
					total: at,
					limit,
					report,
					saturated,
					saturatedRows
				};
			});

			const sessionOnly = out.total - out.provisioned;
			const ranked = [...out.steps].sort((a, b) => b.rows - a.rows);
			console.log(
				`[qa-session] ${JSON.stringify(
					{
						limit: out.limit,
						rowsAfterProvisioning: out.provisioned,
						rowsTotal: out.total,
						rowsForTheSessionAlone: sessionOnly,
						percentOfDailyQuota: Number(((out.total / out.limit) * 100).toFixed(1)),
						biggest: ranked.slice(0, 4),
						steps: out.steps,
						quotaRow: out.report.report[ROWS_QUOTA],
						quotaRowSaturated: out.saturated.report[ROWS_QUOTA],
						doQuotaRow: out.report.report[DO_QUOTA]
					},
					null,
					1
				)}`
			);

			for (const install of out.installs) {
				expect(install.ok, JSON.stringify(install)).toBe(true);
			}
			// every step charged something, or a zero reads as a saving rather than as a step that
			// did not run
			for (const step of out.steps) {
				expect(step.rows, `${step.step} charged no rows`).toBeGreaterThan(0);
			}
			expect(out.limit).toBe(100_000);

			// THE ROW EXISTS, on the page an operator opens, for both daily meters
			expect(
				out.report.report[ROWS_QUOTA],
				'nothing on the status report reports the daily row quota'
			).toBeDefined();
			expect(out.report.report[DO_QUOTA]).toBeDefined();
			// and it names the allowance, not only the count an operator cannot score
			expect(out.report.report[ROWS_QUOTA]?.value).toContain(out.limit.toLocaleString());
			expect(out.report.report[ROWS_QUOTA]?.value).toContain('%');

			// AND IT TRACKS THE METER. Under the reduce fraction it is not something to act on;
			// past the read-only fraction it is an error, which is what an operator has to see
			// BEFORE the site stops writing rather than after
			expect(out.total / out.limit).toBeLessThan(REDUCE_AT);
			expect(
				out.report.report[ROWS_QUOTA]?.severity,
				'a healthy meter read as a problem'
			).toBe(0);
			expect(out.saturatedRows / out.limit).toBeGreaterThanOrEqual(READ_ONLY_AT);
			expect(
				out.saturated.report[ROWS_QUOTA]?.severity,
				'a saturated meter did not raise an error on the status report'
			).toBe(2);
		},
		TIMEOUT
	);
});
