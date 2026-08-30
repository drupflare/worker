import { describe, expect, it } from 'vitest';
import { renderPage } from '../../src/drupal/site-php';
import { classifyState, replicaMayOriginate } from '../../src/ops/state-inventory';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Gate 1: every piece of persistent state a replica could meet has exactly one status.
 *
 * EXECUTABLE RATHER THAN A DOCUMENT, and the difference is the point: this walks a REAL provisioned
 * site and classifies what is actually there, so state introduced by a core upgrade or a contrib
 * module appears here as `UNKNOWN` rather than as silence. `UNKNOWN` routes to the primary at
 * runtime, so an unclassified key costs a failover and never a divergence -- but it still has to be
 * seen, which is what the assertion below is for.
 *
 * The classification is at `(table, collection, name)` because a table is not an effect. Measured:
 * `key_value` holds `update_fetch_task:*` (a disposable queue) and `state:system.private_key` (the
 * key Drupal signs CSRF tokens with) in the same table.
 */

const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Repl-Pass-4412';
const ORIGIN = 'https://do.local';

type Payload = Record<string, unknown>;

async function siteWithState(site: ServeDo): Promise<void> {
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	await site.fetch(
		new Request('https://do.local/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ adminPass: PASS, siteName: 'Inventory' }),
			headers: { 'content-type': 'application/json' }
		})
	);
	const login = (await site.runJson(
		renderPage('/user/login', [], false, {
			method: 'POST',
			body: `name=admin&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`,
			contentType: 'application/x-www-form-urlencoded',
			cookie: '',
			origin: ORIGIN
		})
	)) as Payload;
	const lines = Array.isArray(login['setCookie']) ? (login['setCookie'] as string[]) : [];
	const cookie = (lines.find((l) => /^S?SESS/.test(l)) ?? '').split(';')[0] ?? '';
	// drive the paths that populate the update machinery and the router, so the surface is the one
	// a live site has rather than the one an installer leaves behind
	for (const path of ['/', '/user/1', '/admin/content', '/admin/reports/status']) {
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
}

describe('every piece of persistent state has exactly one status', () => {
	it(
		'classifies every key_value collection a real site carries',
		async () => {
			const unknown = await inObject(freshSite(), async (site: ServeDo) => {
				await siteWithState(site);
				const rows = site.sql
					.exec('SELECT collection, name FROM key_value')
					.toArray()
					.concat(
						site.sql.exec('SELECT collection, name FROM key_value_expire').toArray()
					);
				const seen = new Set<string>();
				for (const row of rows) {
					const collection = String(row.collection);
					const name = String(row.name);
					if (classifyState('key_value', collection, name) === 'UNKNOWN') {
						// the COLLECTION is the unit worth reporting; a uuid key space would otherwise
						// print hundreds of rows that all need the same verdict
						seen.add(collection === 'state' ? `state:${name}` : collection);
					}
				}
				return [...seen].sort();
			});

			expect(
				unknown,
				`unclassified key_value collections: ${JSON.stringify(unknown)}`
			).toEqual([]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'classifies every table a real site carries',
		async () => {
			const unknown = await inObject(freshSite(), async (site: ServeDo) => {
				await siteWithState(site);
				return site.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
					)
					.toArray()
					.map((r) => String(r.name))
					.filter((t) => t !== 'key_value' && t !== 'key_value_expire')
					.filter((t) => classifyState(t) === 'UNKNOWN');
			});

			expect(unknown, `unclassified tables: ${JSON.stringify(unknown)}`).toEqual([]);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * The two secrets, by name, because they are the failure this whole gate exists to prevent.
	 *
	 * Both are minted LAZILY on first use, which is what makes them dangerous rather than merely
	 * authoritative: a replica reaching the code path before replication has delivered the value
	 * will create one, and nothing errors. `system.private_key` signs CSRF tokens;
	 * `system.cron_key` is the token in the cron URL.
	 */
	it(
		'holds both lazily-minted secrets as state a replica may never originate',
		async () => {
			const present = await inObject(freshSite(), async (site: ServeDo) => {
				await siteWithState(site);
				return site.sql
					.exec("SELECT name FROM key_value WHERE collection = 'state'")
					.toArray()
					.map((r) => String(r.name));
			});

			for (const key of ['system.private_key', 'system.cron_key']) {
				expect(present, `${key} is not in the state collection`).toContain(key);
				expect(classifyState('key_value', 'state', key)).toBe('AUTHORITATIVE');
				expect(replicaMayOriginate(classifyState('key_value', 'state', key))).toBe(false);
			}
		},
		REQUEST_TIMEOUT
	);
});
