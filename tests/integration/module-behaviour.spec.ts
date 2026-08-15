import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What a module DOES, not that its installer returned ok.
 *
 * `module-enable.spec.ts` establishes that an enable survives in this lane, which is the
 * precondition. This asserts behaviour: a thing the module is for actually happening.
 *
 * **An enable returning `ok: true` proves the installer ran and nothing else.** A support table
 * built on that is a table of installs wearing the word "verified", so every case here reaches past
 * the install to an observable effect -- a row in a table the module owns, a route it registers, a
 * value it transformed.
 *
 * Only the four contrib modules in the shipped pack can be reached at all: token, ctools, pathauto,
 * admin_toolbar. Everything else on the support table is `supported` by capability analysis with no
 * code on the filesystem to exercise, and no amount of test writing changes that until a catalog and
 * layer mount exist.
 */

type Payload = Record<string, unknown>;

const REQUEST_TIMEOUT = 600_000;

const call = (site: ServeDo, path: string) =>
	site.fetch(new Request(`https://do.local${path}`)).then((r) => r.json() as Promise<Payload>);

const migrate = (site: ServeDo, query = '?all=1&prefill=0') => call(site, `/__migrate${query}`);
const enable = (site: ServeDo, module: string) =>
	call(site, `/__enable?module=${encodeURIComponent(module)}`);
const sql = (site: ServeDo, query: string) => call(site, `/__sql?q=${encodeURIComponent(query)}`);
const saveNode = (site: ServeDo, title: string) =>
	call(site, `/__savenode?title=${encodeURIComponent(title)}&body=probe`);

const rows = (reply: Payload): Record<string, unknown>[] =>
	Array.isArray(reply['rows']) ? (reply['rows'] as Record<string, unknown>[]) : [];

describe('pathauto and token, together', () => {
	/**
	 * **PATHAUTO ENABLES AND CANNOT DO ANYTHING**, and that is the finding.
	 *
	 * Measured: after a successful enable, `SELECT name FROM config WHERE name LIKE
	 * 'pathauto.pattern.%'` returns ZERO rows, and saving a node produces no `path_alias` row.
	 * Pathauto applies patterns, a pattern is a config entity a site owner creates, and the shipped
	 * `site.sqlite` carries none -- so the module installs, reports `ok: true`, and silently does
	 * nothing.
	 *
	 * That is the same shape as the missing node types and the unwired cron: a capability present in
	 * the artifact with the configuration that activates it absent, failing by doing nothing rather
	 * than by erroring. It is why pathauto is `supported` and NOT `verified`: nothing about its
	 * behaviour has been observed, because none is reachable.
	 *
	 * Pinned as the current truth rather than skipped. The day a pattern ships this fails, which is
	 * the signal to write the real alias assertion -- the one that would verify pathauto and token
	 * together, since a pattern is a Token string and an alias carrying the node title proves both.
	 */
	it(
		'enables, but ships no pattern so it generates no alias',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				const enabled = await enable(site, 'pathauto');
				const patterns = await sql(
					site,
					"SELECT name FROM config WHERE name LIKE 'pathauto.pattern.%'"
				);
				const saved = await saveNode(site, 'Alias Probe Title');
				const aliases = await sql(site, 'SELECT path, alias FROM path_alias ORDER BY id');
				return { enabled, patterns, saved, aliases };
			});

			// the install itself is sound; this is not a broken module
			expect(out.enabled['ok']).toBe(true);
			expect(out.enabled['discoverable']).toBe(true);
			expect(out.saved['ok'], JSON.stringify(out.saved).slice(0, 400)).toBe(true);

			// and it has nothing to apply
			expect(rows(out.patterns)).toEqual([]);
			expect(rows(out.aliases)).toEqual([]);
		},
		REQUEST_TIMEOUT
	);
});

describe('admin_toolbar', () => {
	/**
	 * A module that registers routes is verified by its routes existing in the router table.
	 *
	 * Rendering the toolbar would need an authenticated session this lane cannot mint, so the
	 * observable effect chosen is the one the module definitely owns: its own route entries, written
	 * by the router rebuild the install triggers.
	 */
	it(
		'registers its own routes into the router table',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				const before = await sql(site, 'SELECT COUNT(*) AS c FROM router');
				const enabled = await enable(site, 'admin_toolbar');
				const after = await sql(site, 'SELECT COUNT(*) AS c FROM router');
				const own = await sql(
					site,
					"SELECT name FROM router WHERE name LIKE 'admin_toolbar%' ORDER BY name"
				);
				return { before, enabled, after, own };
			});

			expect(out.enabled['ok']).toBe(true);
			const ownRoutes = rows(out.own);
			console.log(
				`[admin_toolbar] routes ${rows(out.before)[0]?.['c']} -> ${rows(out.after)[0]?.['c']}, own=${ownRoutes.length}`
			);
			expect(
				ownRoutes.length,
				'admin_toolbar registered no routes of its own'
			).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);
});

describe('ctools', () => {
	/**
	 * ctools is a library module: it ships plugin base classes and has no user-visible behaviour of
	 * its own, so the honest observable is that it reaches `core.extension` and the site still
	 * functions afterwards.
	 *
	 * That is deliberately weaker than the other cases, and it is why ctools is recorded with what
	 * was actually exercised rather than a claim it "works".
	 */
	it(
		'installs into core.extension and leaves the site able to save content',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				const enabled = await enable(site, 'ctools');
				const saved = await saveNode(site, 'After ctools');
				return { enabled, saved };
			});

			expect(out.enabled['ok']).toBe(true);
			expect(Number(out.enabled['moduleCountAfter'])).toBeGreaterThan(
				Number(out.enabled['moduleCountBefore'])
			);
			expect(out.saved['ok'], JSON.stringify(out.saved).slice(0, 300)).toBe(true);
		},
		REQUEST_TIMEOUT
	);
});
