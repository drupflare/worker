import { describe, expect, it } from 'vitest';
import { emptyTally } from '../../src/db/write-tally';
import { renderPage, type RenderRequest } from '../../src/drupal/site-php';
import { authoritativeWrites, type AuthoritativeWrite } from '../../src/ops/replica';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * An authenticated GET has no authoritative side effects under this SAPI.
 *
 * THE PREMISE OF THE READ-REPLICA TOPOLOGY, and it is an accident of the SAPI rather than a
 * decision anybody made. Core attaches `UserRequestSubscriber` to `KernelEvents::TERMINATE` and
 * throttles the access-timestamp write by `session_write_interval` (180 s by default), so on a
 * stock host the write is periodic rather than per-request. Here it does not happen at all: this
 * SAPI never dispatches terminate. Nothing records that, nothing depends on it, and a
 * change that started dispatching terminate would move every authenticated request to the primary
 * and collapse the replica hit rate to zero WITHOUT failing anything else.
 *
 * So this spec is the premise's only guard. It is not a performance test and it does not measure
 * the replicas; it measures whether the thing they would rely on is still true.
 *
 * `authoritativeWrites()` decides what counts, and its allow-list is the load-bearing half: a table
 * is authoritative unless it is named replica-local, so a new table appears here as a failure
 * rather than as silence.
 */

const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Repl-Pass-4412';
const ORIGIN = 'https://do.local';

type Payload = Record<string, unknown>;

/** paths a logged-in admin reaches on a site with no content of its own */
const PATHS = [
	'/',
	'/user/1',
	'/admin/content',
	'/admin/people',
	'/admin/structure/types'
] as const;

/**
 * Measured separately because it is the ONE exception and has to be classified.
 *
 * The status report triggers the update-check machinery, which writes fetch-task rows. Those are a
 * QUEUE rather than user-facing state, so the interesting question is whether a replica can drop
 * the write instead of failing over -- the primary's cron performs the same fetch regardless.
 */
const STATUS_PATH = '/admin/reports/status';

const form = (body: string): RenderRequest => ({
	method: 'POST',
	body,
	contentType: 'application/x-www-form-urlencoded',
	cookie: ''
});

function jarOf(result: Payload): string {
	const lines = Array.isArray(result['setCookie']) ? (result['setCookie'] as string[]) : [];
	const session = lines.find((line) => /^S?SESS/.test(line));
	return session ? (session.split(';')[0] ?? '') : '';
}

async function adminSession(site: ServeDo): Promise<string> {
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	await site.fetch(
		new Request('https://do.local/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ adminPass: PASS, siteName: 'Replica' }),
			headers: { 'content-type': 'application/json' }
		})
	);
	return jarOf(
		(await site.runJson(
			renderPage('/user/login', [], false, {
				...form(
					`name=admin&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`
				),
				origin: ORIGIN
			})
		)) as Payload
	);
}

/** one authenticated GET, with the tally armed around it and nothing else running */
async function measure(
	site: ServeDo,
	path: string,
	cookie: string
): Promise<{ path: string; status: number; total: number; authoritative: AuthoritativeWrite[] }> {
	site.writeTally = emptyTally();
	const result = (await site.runJson(
		renderPage(path, [], false, {
			method: 'GET',
			body: '',
			contentType: '',
			cookie,
			origin: ORIGIN
		})
	)) as Payload;
	const tally = site.writeTally;
	site.writeTally = undefined;
	return {
		path,
		status: Number(result['status'] ?? 0),
		total: tally?.rowsWritten ?? 0,
		authoritative: authoritativeWrites(tally ?? emptyTally())
	};
}

describe('an authenticated GET has no authoritative side effects', () => {
	it(
		'writes only replica-local tables on every ordinary authenticated path',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				const cookie = await adminSession(site);
				// warmed first: the invariant is about a steady-state request, and a first render
				// populates caches whose rows would drown the reading without changing its verdict
				for (const path of PATHS) {
					await site.runJson(
						renderPage(path, [], false, {
							method: 'GET',
							body: '',
							contentType: '',
							cookie,
							origin: ORIGIN
						})
					);
				}
				const out = [];
				for (const path of PATHS) out.push(await measure(site, path, cookie));
				return { cookie, out };
			});

			expect(seen.cookie, 'the login produced no session cookie').not.toBe('');

			for (const row of seen.out) {
				expect(row.status, `${row.path} did not render`).toBe(200);
				// the assertion the topology rests on; the message names the table so a failure says
				// which write appeared rather than only that one did
				expect(
					row.authoritative,
					`${row.path} wrote authoritative state: ${JSON.stringify(row.authoritative)}`
				).toEqual([]);
			}

			// a render that wrote NOTHING would satisfy the assertion above without meaning anything,
			// so the control is that the tally saw the request at all
			expect(seen.out.some((row) => row.total > 0)).toBe(true);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * The absences are the finding, so they are asserted by name.
	 *
	 * Each of these is a per-request write on a stock host, and each would send every authenticated
	 * request to the primary. Naming them means a regression reports WHICH one came back.
	 */
	it(
		'writes no session, flood, watchdog or user-access row',
		async () => {
			const tables = await inObject(freshSite(), async (site: ServeDo) => {
				const cookie = await adminSession(site);
				await site.runJson(
					renderPage('/admin/content', [], false, {
						method: 'GET',
						body: '',
						contentType: '',
						cookie,
						origin: ORIGIN
					})
				);
				const row = await measure(site, '/admin/content', cookie);
				return row.authoritative.map((entry) => entry.table);
			});

			for (const table of ['sessions', 'flood', 'watchdog', 'users_field_data']) {
				expect(tables, `${table} is written on an authenticated GET`).not.toContain(table);
			}
		},
		REQUEST_TIMEOUT
	);

	/**
	 * The one stateful path, classified by EFFECT rather than routed to the primary by reflex.
	 *
	 * Naming the tables is not enough, and reading the collections is what showed it. The writes are:
	 *
	 * - `update_fetch_task:{drupal,ctools,token,pathauto,admin_toolbar}` and
	 *   `update:update_project_projects` -- the update and advisories fetch queue. Regenerable; the
	 *   primary's own `hook_cron` performs the same fetch on its own schedule.
	 * - `state:system.theme.files` -- a derived registry of theme files. Regenerable.
	 * - `cfw_http_queue` -- the outbound request that queue produces. 1 statement for 0 rows here,
	 *   because it was already queued. Dropping is safe HERE and NOT in general: the same table
	 *   carries deferred POSTs (reCAPTCHA siteverify is the canonical one) that must not be lost.
	 * - `watchdog` -- one dblog row for "Failed to retrieve security advisory data", which appears
	 *   only because a cold object cannot reach the network synchronously. `cfwLog` has already
	 *   mirrored the entry to `console.log`, which outlives the isolate where the row does not.
	 * - **`state:system.private_key` -- authoritative, and the reason this path cannot be
	 *   waved through.** Drupal mints it lazily on first use and keys CSRF tokens and other HMACs on
	 *   it. Two replicas each minting their own would issue tokens the others reject, so it must
	 *   arrive by replication or at seeding and may never be generated on a replica.
	 *
	 * TWO THINGS THIS PATH DISPROVES about the cheap classifications:
	 *
	 * - "does this route write" is the wrong question. `watchdog` appears on ANY authenticated GET
	 *   where Drupal logs, so the same route reads replica-safe on a warm object and unsafe on a
	 *   cold one -- measured, in exactly that order.
	 * - a table name is not an effect. `key_value` holds a disposable fetch queue and a private key
	 *   in the same table, so a per-table verdict is wrong in whichever direction it is set.
	 *
	 * Pinned as a SET rather than as counts: the row counts move with what has already been fetched,
	 * and it is a new table appearing that would matter.
	 */
	it(
		'confines the status report to regenerable tables',
		async () => {
			const row = await inObject(freshSite(), async (site: ServeDo) => {
				const cookie = await adminSession(site);
				await site.runJson(
					renderPage(STATUS_PATH, [], false, {
						method: 'GET',
						body: '',
						contentType: '',
						cookie,
						origin: ORIGIN
					})
				);
				return measure(site, STATUS_PATH, cookie);
			});

			expect(row.status).toBe(200);
			const regenerable = new Set([
				'key_value',
				'key_value_expire',
				'watchdog',
				'cfw_http_queue'
			]);
			const unexpected = row.authoritative.filter((entry) => !regenerable.has(entry.table));
			expect(
				unexpected,
				`the status report wrote a table that is not regenerable: ${JSON.stringify(unexpected)}`
			).toEqual([]);
			// the control: an empty reading would satisfy the filter above and mean nothing
			expect(row.authoritative.length).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);
});
