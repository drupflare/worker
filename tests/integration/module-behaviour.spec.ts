import { describe, expect, it } from 'vitest';
import { BOOT_KERNEL } from '../../src/drupal/site-php';
import { SHIPPED_CAPABILITIES } from '../../src/ops/catalog';
import { moduleTable } from '../../src/ops/module-table';
import { SUSPEND_PROBE } from '../helpers/drupal-probes';
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
 * admin_toolbar. `scripts/pack-drupal.ts` puts `modules/contrib` behind `PACK_CONTRIB=1` and calls
 * the rest a QA fixture, so the other rows on the support table have no code on the filesystem for
 * this lane to exercise -- `SHIPPING_PACK_CONTRIB` in `src/ops/module-table.ts` is that boundary as
 * data, and `tests/node/module-table.spec.ts` checks it against the pack index rather than believing
 * this comment.
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

/** the node title the alias assertion slugifies, chosen so the two forms cannot be confused */
const TITLE = 'Pathauto Probe Title';

/**
 * The pattern the shipped site does not carry, created the way a site owner would.
 *
 * `canonical_entities:node` is the alias-type plugin pathauto derives per entity type, and no
 * `selection_criteria` means every bundle, which is what makes one pattern enough here.
 */
const CREATE_PATTERN = String.raw`<?php
$out = ['ok' => false];
try {
  // ConfigEntityBase::save() returns SAVED_NEW, which lives in common.inc and boot() never loads
  if (!defined('SAVED_NEW')) { require_once '/drupal/core/includes/common.inc'; }
  // a node save happens inside a request on a real site. BOOT_KERNEL leaves the stack empty, and
  // pathauto resolves the aliased route through router.request_context, which then gets null
  $request = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
  \Drupal::service('request_stack')->push($request);
  \Drupal::service('router.request_context')->fromRequest($request);
  // and preHandle()'s other half: boot() does not read .module files, so token's info hook reaches
  // image_style_options() -- procedural, in image.module -- and finds no such function
  \Drupal::moduleHandler()->loadAll();
  $storage = \Drupal::entityTypeManager()->getStorage('pathauto_pattern');
  $storage->create([
    'id' => 'probe_node',
    'label' => 'Probe node',
    'type' => 'canonical_entities:node',
    'pattern' => '/probe/[node:title]',
    'weight' => 0,
  ])->save();
  $out['ok'] = $storage->load('probe_node') !== NULL;
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
}
echo json_encode($out);
`;

/** one contrib-only token, one undeclared token as the control, one core token as the floor */
const REPLACE_TOKENS = String.raw`<?php
$out = ['ok' => false];
try {
  $token = \Drupal::token();
  $out['random'] = $token->replace('[random:hash:md5]');
  $out['unknown'] = $token->replace('[nosuchtype:nosuchtoken]');
  $out['core'] = $token->replace('[site:name]');
  $out['ok'] = true;
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
}
echo json_encode($out);
`;

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
	 * than by erroring.
	 *
	 * **IT IS NOT WHY PATHAUTO WAS UNVERIFIABLE, AND THAT READING COST A ROW.** This block used to
	 * conclude "no behaviour has been observed, because none is reachable" and stop. A pattern is a
	 * config entity a SITE OWNER creates, so the test can create one -- which is what the case below
	 * does, and what moved both pathauto and token to `verified`. Absent configuration is a fixture
	 * gap, not a platform limit; the two are worth telling apart before recording a verdict.
	 *
	 * This case stays as the precondition it always was: the shipped site ships no pattern. The day
	 * one does, this fails, and the case below is where the assertion already lives.
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

	/**
	 * Pathauto, given the one thing it was missing.
	 *
	 * The observable is the row pathauto exists to write: a `path_alias` whose alias is the pattern
	 * with `[node:title]` resolved. Two modules are proved by one row and neither claim leans on the
	 * other -- pathauto owns the fact that a row appeared at all, token owns the fact that what
	 * landed in it is the node's title rather than the literal bracket text.
	 */
	it(
		'generates the alias its pattern describes, once a pattern exists',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				const enabled = await enable(site, 'pathauto');
				// the enable drops the interpreter, so the container has to come back before any
				// PHP of ours can reach the storage handler pathauto just registered
				const booted = await site.runJson(BOOT_KERNEL);
				const pattern = await site.runJson(CREATE_PATTERN);
				const saved = await saveNode(site, TITLE);
				const aliases = await sql(site, 'SELECT path, alias FROM path_alias ORDER BY id');
				return { enabled, booted, pattern, saved, aliases };
			});

			expect(out.enabled['ok'], JSON.stringify(out.enabled).slice(0, 400)).toBe(true);
			expect(out.booted['ok'], 'the kernel did not come back after the enable').toBe(true);
			expect(out.pattern['ok'], JSON.stringify(out.pattern).slice(0, 400)).toBe(true);
			expect(out.saved['ok'], JSON.stringify(out.saved).slice(0, 400)).toBe(true);

			const alias = rows(out.aliases)[0];
			expect(rows(out.aliases).length, 'pathauto generated no alias').toBe(1);
			expect(alias?.['path']).toBe(`/node/${Number(out.saved['nid'])}`);
			// TOKEN'S HALF IS THE VALUE, NOT THE ABSENCE OF BRACKETS. A `not.toContain('[node:
			// title]')` was here and could never fail: pointed at `[node:nosuchtoken]` this run
			// writes NO row rather than a literal one, so the unresolved case is already caught
			// above and a literal-bracket assertion is dead weight. What token owns is that the
			// value is the slugified title
			expect(alias?.['alias']).toBe('/probe/pathauto-probe-title');
			console.log(
				`[behaviour] pathauto: ${Number(out.enabled['rowsWritten'])} charged rows, ` +
					`alias ${String(alias?.['alias'])}`
			);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * Token, on a token core does not have.
	 *
	 * `[site:name]` would have proved nothing: `system_tokens()` is core, so it resolves with the
	 * contrib module absent. `[random:hash:md5]` is declared by `token.tokens.inc` and by nothing
	 * else, so its resolution is the module answering.
	 */
	it(
		'resolves a token that only the contrib module declares',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				const enabled = await enable(site, 'token');
				const booted = await site.runJson(BOOT_KERNEL);
				const replaced = await site.runJson(REPLACE_TOKENS);
				return { enabled, booted, replaced };
			});

			expect(out.enabled['ok'], JSON.stringify(out.enabled).slice(0, 400)).toBe(true);
			expect(out.booted['ok']).toBe(true);
			expect(out.replaced['ok'], JSON.stringify(out.replaced).slice(0, 400)).toBe(true);
			expect(String(out.replaced['random']), 'the contrib token stayed literal').toMatch(
				/^[0-9a-f]{32}$/
			);
			// the control, and it is the one that makes the assertion above mean something: an
			// undeclared token comes back UNTOUCHED, so `replace()` is not simply blanking brackets
			expect(out.replaced['unknown']).toBe('[nosuchtype:nosuchtoken]');
			// core's own token still answers, so a total token failure reads differently from a
			// contrib-module-absent failure
			expect(String(out.replaced['core']).length).toBeGreaterThan(0);
			expect(out.replaced['core']).not.toContain('[site:name]');
			console.log(
				`[behaviour] token: ${Number(out.enabled['rowsWritten'])} charged rows, ` +
					`[random:hash:md5] -> ${String(out.replaced['random'])}`
			);
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
	 * That is weaker than the other cases, and it is why ctools is recorded with what
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

/**
 * The mechanism all four `blocked` rows rest on, measured instead of declared.
 *
 * `SHIPPED_CAPABILITIES.blockingOutbound` is a hand-written `false`, and it is what refuses
 * search_api_solr, smtp, redis and openid_connect. Nothing compared it to the binary: an interpreter
 * that gained Asyncify or JSPI would leave four rows wrong with every test still green. This reads
 * the same flag `DrupflareServiceProvider::runtimeCanSuspend()` reads, which is what actually
 * decides whether a blocking outbound call is possible.
 */
describe('what the blocked rows are blocked on', () => {
	it(
		'reports an interpreter that cannot suspend, which is why four rows are blocked',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				await site.runJson(BOOT_KERNEL);
				return site.runJson(SUSPEND_PROBE);
			});

			expect(out['ok'], JSON.stringify(out).slice(0, 400)).toBe(true);
			// the host sets the flag on every build, so `null` here means the probe missed rather
			// than that the build cannot suspend -- a distinction the table's four rows depend on
			expect(out['hasVrznoEnv'], 'no vrzno_env: this probe cannot see the flag').toBe(true);
			expect(out['canSuspend']).toBe(false);
			// **THE SYMBOL IS PRESENT AND MEANS NOTHING.** `function_exists('vrzno_await')` is TRUE
			// on the shipping 8.5 build -- the extension declares it; what ASYNCIFY=0 removed is
			// the `Asyncify` the glue calls, so reaching it throws a ReferenceError PHP cannot
			// catch. Pinned true so nobody re-derives suspendability from the symbol
			expect(out['hasVrznoAwait']).toBe(true);
			// and the table's input agrees with the binary
			expect(SHIPPED_CAPABILITIES.blockingOutbound).toBe(out['canSuspend']);
			expect(
				moduleTable().filter((r) => r.state === 'blocked').length,
				'blocked rows exist only because the interpreter cannot suspend'
			).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);
});
