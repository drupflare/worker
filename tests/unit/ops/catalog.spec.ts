import { describe, expect, it } from 'vitest';
import {
	findEntry,
	KNOWN_MODULE_CAPABILITIES,
	loadCatalog,
	parseCatalog,
	planInstall,
	tierFor,
	type Catalog,
	type ModuleCapability
} from '../../../src/ops/catalog';

/**
 * The pre-packed module catalog.
 *
 * The install MECHANISM already existed -- `lazy-fs` can mount a layer straight out of R2, and an
 * R2-backed layer costs zero subrequests. This is the half that says which modules exist and whether
 * they fit, and the assertions that matter are the refusals plus the LAYER ORDER.
 *
 * Layer order is load-bearing: `lazy-fs` merges layers before node creation and a later
 * layer overrides an earlier one on the same path, so the requested module must come last or one of its
 * own dependencies can shadow its files. Getting that backwards would not error -- it would mount a site
 * running the wrong copy of a file, which is this project's signature failure.
 */

const CORE = '11.4.5';
/** the interpreter this site runs; 8.5 is the shipping seam */
const PHP = '8.5.0';

const CATALOG = parseCatalog({
	builtAt: '2026-08-13T00:00:00Z',
	entries: [
		{ name: 'drupal/token', version: '1.15.0', r2: 'mod/token', core: '^11', bytes: 1000 },
		{
			name: 'drupal/pathauto',
			version: '1.13.0',
			r2: 'mod/pathauto',
			core: '^11',
			requires: ['drupal/token', 'drupal/ctools'],
			bytes: 2000
		},
		{ name: 'drupal/ctools', version: '4.1.0', r2: 'mod/ctools', core: '^11', bytes: 500 },
		{
			name: 'drupal/phpok',
			version: '2.0.0',
			r2: 'mod/phpok',
			core: '^11',
			php: '>=8.3',
			bytes: 400
		},
		{
			name: 'drupal/phpcapped',
			version: '1.0.0',
			r2: 'mod/phpcapped',
			core: '^11',
			php: '~8.3.0',
			bytes: 400
		},
		{
			name: 'drupal/phpjunk',
			version: '1.0.0',
			r2: 'mod/phpjunk',
			core: '^11',
			php: 42 as unknown as string,
			bytes: 400
		},
		{ name: 'drupal/old', version: '2.0.0', r2: 'mod/old', core: '^10', bytes: 100 },
		{
			name: 'drupal/weird',
			version: '1.0.0',
			r2: 'mod/weird',
			core: 'dev-main as 11',
			bytes: 100
		},
		{
			name: 'drupal/orphan',
			version: '1.0.0',
			r2: 'mod/orphan',
			core: '^11',
			requires: ['drupal/absent']
		},
		{
			name: 'drupal/loopa',
			version: '1.0.0',
			r2: 'mod/loopa',
			core: '^11',
			requires: ['drupal/loopb']
		},
		{
			name: 'drupal/loopb',
			version: '1.0.0',
			r2: 'mod/loopb',
			core: '^11',
			requires: ['drupal/loopa']
		}
	]
});

describe('parsing tolerates a bad object read instead of throwing', () => {
	it('drops entries missing any required field', () => {
		const c = parseCatalog({
			entries: [
				{ name: 'a/b' },
				{ name: 'c/d', r2: 'x', version: '1', core: '^11' },
				'nope',
				null
			]
		});
		expect(c.entries).toHaveLength(1);
		expect(c.entries[0]!.name).toBe('c/d');
	});

	it('returns an empty catalog for junk', () => {
		for (const raw of [null, undefined, {}, { entries: 'no' }, 42]) {
			expect(parseCatalog(raw).entries).toEqual([]);
		}
	});

	it('finds an entry by composer name', () => {
		expect(findEntry(CATALOG, 'drupal/token')?.version).toBe('1.15.0');
		expect(findEntry(CATALOG, 'drupal/nope')).toBeNull();
	});
});

describe('the plan mounts dependencies FIRST, so nothing shadows the requested module', () => {
	it('puts the requested module last', () => {
		const plan = planInstall(CATALOG, 'drupal/pathauto', CORE, PHP);
		expect(plan.ok).toBe(true);
		expect(plan.layers.map((l) => l.name)).toEqual([
			'drupal/token',
			'drupal/ctools',
			'drupal/pathauto'
		]);
	});

	it('sums the bytes so a caller can refuse before reading R2', () => {
		expect(planInstall(CATALOG, 'drupal/pathauto', CORE, PHP).totalBytes).toBe(3500);
	});

	it('does not duplicate a layer shared by two dependencies', () => {
		const plan = planInstall(CATALOG, 'drupal/pathauto', CORE, PHP);
		const keys = plan.layers.map((l) => l.r2);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('plans a leaf module as a single layer', () => {
		const plan = planInstall(CATALOG, 'drupal/token', CORE, PHP);
		expect(plan.layers).toEqual([{ name: 'drupal/token', r2: 'mod/token' }]);
	});
});

describe('and it REFUSES rather than mounting something that will break', () => {
	it('refuses a module absent from the catalog', () => {
		const plan = planInstall(CATALOG, 'drupal/nope', CORE, PHP);
		expect(plan.ok).toBe(false);
		expect(plan.problems[0]).toContain('not in the catalog');
	});

	it('refuses a pack built against a core this site does not run', () => {
		const plan = planInstall(CATALOG, 'drupal/old', CORE, PHP);
		expect(plan.ok).toBe(false);
		expect(plan.problems.join(' ')).toContain('^10');
		expect(plan.problems.join(' ')).toContain(CORE);
	});

	it('refuses an unjudgeable core constraint, because unknown is not a yes', () => {
		const plan = planInstall(CATALOG, 'drupal/weird', CORE, PHP);
		expect(plan.ok).toBe(false);
		expect(plan.problems.join(' ')).toContain('cannot decide');
	});

	it('refuses when a DEPENDENCY is missing from the catalog', () => {
		// mounting the parent without its dependency gives a site that boots and then fatals
		const plan = planInstall(CATALOG, 'drupal/orphan', CORE, PHP);
		expect(plan.ok).toBe(false);
		expect(plan.problems.join(' ')).toContain('drupal/absent');
	});

	it('survives a dependency cycle instead of recursing forever', () => {
		// a catalog is data and may be wrong; a cycle must not take the object down
		const plan = planInstall(CATALOG, 'drupal/loopa', CORE, PHP);
		expect(plan.ok).toBe(true);
		expect(plan.layers.length).toBeGreaterThan(0);
		expect(new Set(plan.layers.map((l) => l.r2)).size).toBe(plan.layers.length);
	});
});

describe('loading from R2 degrades to "no catalog" rather than to an error', () => {
	it('returns null with no bucket bound', async () => {
		expect(await loadCatalog(null)).toBeNull();
		expect(await loadCatalog(undefined)).toBeNull();
	});

	it('returns null when the object is absent', async () => {
		expect(
			await loadCatalog({
				async get() {
					return null;
				}
			})
		).toBeNull();
	});

	it('returns null on unparseable JSON, so the feature is absent not broken', async () => {
		const bucket = {
			async get() {
				return {
					async text() {
						return 'not json';
					}
				};
			}
		};
		expect(await loadCatalog(bucket)).toBeNull();
	});

	it('parses a real catalog', async () => {
		const bucket = {
			async get() {
				return {
					async text() {
						return JSON.stringify({
							builtAt: 'T',
							entries: [{ name: 'a/b', version: '1', r2: 'k', core: '^11' }]
						});
					}
				};
			}
		};
		const c = await loadCatalog(bucket);
		expect(c?.entries).toHaveLength(1);
		expect(c?.builtAt).toBe('T');
	});
});

describe('the php constraint', () => {
	it('plans a module whose constraint the running interpreter satisfies', () => {
		const plan = planInstall(CATALOG, 'drupal/phpok', CORE, PHP);
		expect(plan.ok).toBe(true);
		expect(plan.problems).toStrictEqual([]);
	});

	it('refuses a module that caps php below the running interpreter, naming all three facts', () => {
		// the refusal message IS the feature: a reader must learn which module, what it wants and
		// what this site runs, without going to the catalog
		const plan = planInstall(CATALOG, 'drupal/phpcapped', CORE, PHP);
		expect(plan.ok).toBe(false);
		expect(plan.problems).toHaveLength(1);
		expect(plan.problems[0]).toContain('drupal/phpcapped');
		expect(plan.problems[0]).toContain('~8.3.0');
		expect(plan.problems[0]).toContain('8.5.0');
	});

	it('plans that same module on the interpreter it does support', () => {
		// proves the refusal is about the constraint, not about the module
		const plan = planInstall(CATALOG, 'drupal/phpcapped', CORE, '8.3.11');
		expect(plan.ok).toBe(true);
	});

	it('tolerates a non-string php field exactly as before, dropping it at parse time', () => {
		expect(CATALOG.entries.find((e) => e.name === 'drupal/phpjunk')?.php).toBeUndefined();
		expect(planInstall(CATALOG, 'drupal/phpjunk', CORE, PHP).ok).toBe(true);
	});

	it('refuses an unjudgeable constraint rather than guessing, matching core', () => {
		const catalog = parseCatalog({
			builtAt: 'x',
			entries: [
				{
					name: 'drupal/odd',
					version: '1.0.0',
					r2: 'mod/odd',
					core: '^11',
					php: 'dev-main as 8.3'
				}
			]
		});
		const plan = planInstall(catalog, 'drupal/odd', CORE, PHP);
		expect(plan.ok).toBe(false);
		expect(plan.problems[0]).toContain('cannot decide whether php');
	});

	it('leaves a module with no php constraint alone', () => {
		expect(planInstall(CATALOG, 'drupal/token', CORE, PHP).ok).toBe(true);
	});
});

describe('the capability constraint, which a version check cannot express', () => {
	const withNeeds = (needs: ModuleCapability[], name = 'drupal/recaptcha'): Catalog => ({
		builtAt: 'now',
		entries: [{ name, version: '3.4.0', r2: 'r', core: '^11', needs }]
	});

	it('ALLOWS deferrable outbound, because the queue and the alarm drain already ship', () => {
		// the correction that matters: treating every outbound need as a wall classified reCAPTCHA
		// and Stage File Proxy as impossible when both are two-phase problems. cfwQueueFetch records
		// the call, drainHttpQueue() performs it inside alarm() where awaiting is legal, and a later
		// invocation reads the answer synchronously
		const plan = planInstall(
			withNeeds(['deferrable-outbound']),
			'drupal/recaptcha',
			'11.4.5',
			'8.5.2'
		);
		expect(plan.ok).toBe(true);
	});

	it('REFUSES an outbound call that must answer inside one render', () => {
		// search_api_solr is the real refusal: a query per keystroke against a remote index cannot
		// be split across invocations without changing what the user sees
		const plan = planInstall(
			withNeeds(['blocking-outbound'], 'drupal/search_api_solr'),
			'drupal/search_api_solr',
			'11.4.5',
			'8.5.2'
		);
		expect(plan.ok).toBe(false);
		// the message names the MECHANISM, not the module, and distinguishes the two tiers so the
		// reader learns which calls ARE supported
		expect(plan.problems[0]).toContain('INSIDE one render');
		expect(plan.problems[0]).toContain('ASYNCIFY=0');
		expect(plan.problems[0]).toContain('split across invocations is supported');
	});

	it('ALLOWS blocking outbound on a runtime that can suspend, so it is a capability not a ban', () => {
		const plan = planInstall(
			withNeeds(['blocking-outbound'], 'drupal/search_api_solr'),
			'drupal/search_api_solr',
			'11.4.5',
			'8.5.2',
			new Set(),
			{ deferredOutbound: true, blockingOutbound: true, cron: true }
		);
		expect(plan.ok).toBe(true);
	});

	it('REFUSES deferrable outbound on a site with no queue at all', () => {
		const plan = planInstall(
			withNeeds(['deferrable-outbound']),
			'drupal/recaptcha',
			'11.4.5',
			'8.5.2',
			new Set(),
			{ deferredOutbound: false, blockingOutbound: false, cron: true }
		);
		expect(plan.ok).toBe(false);
		expect(plan.problems[0]).toContain('deferred outbound tier');
	});

	it('allows a cron-driven module, because the alarm exists', () => {
		const plan = planInstall(withNeeds(['cron']), 'drupal/recaptcha', '11.4.5', '8.5.2');
		expect(plan.ok).toBe(true);
	});

	it('refuses a cron-driven module where nothing drives cron', () => {
		const plan = planInstall(
			withNeeds(['cron']),
			'drupal/recaptcha',
			'11.4.5',
			'8.5.2',
			new Set(),
			{ deferredOutbound: true, blockingOutbound: false, cron: false }
		);
		expect(plan.ok).toBe(false);
		expect(plan.problems[0]).toContain('needs cron');
	});

	it('still passes a module that declares no capabilities at all', () => {
		const plan = planInstall(
			{
				builtAt: 'now',
				entries: [{ name: 'drupal/honeypot', version: '2.2.0', r2: 'r', core: '^11' }]
			},
			'drupal/honeypot',
			'11.4.5',
			'8.5.2'
		);
		expect(plan.ok).toBe(true);
		expect(plan.problems).toEqual([]);
	});

	it('drops an unrecognised capability rather than failing closed on it', () => {
		// a catalog written by a newer build must not brick an older planner
		const plan = planInstall(
			parseCatalog({
				builtAt: 'now',
				entries: [
					{
						name: 'drupal/x',
						version: '1.0.0',
						r2: 'r',
						core: '^11',
						needs: ['quantum', 'blocking-outbound']
					}
				]
			}),
			'drupal/x',
			'11.4.5',
			'8.5.2'
		);
		// the one it understands still refuses; the one it does not is ignored
		expect(plan.problems).toHaveLength(1);
		expect(plan.problems[0]).toContain('INSIDE one render');
	});

	it('refuses when a DEPENDENCY needs a capability the runtime lacks', () => {
		const plan = planInstall(
			{
				builtAt: 'now',
				entries: [
					{
						name: 'drupal/parent',
						version: '1.0.0',
						r2: 'p',
						core: '^11',
						requires: ['drupal/child']
					},
					{
						name: 'drupal/child',
						version: '1.0.0',
						r2: 'c',
						core: '^11',
						needs: ['blocking-outbound']
					}
				]
			},
			'drupal/parent',
			'11.4.5',
			'8.5.2'
		);
		expect(plan.ok).toBe(false);
		expect(plan.problems[0]).toContain('INSIDE one render');
	});
});

describe('tierFor: will it RUN here, which is not the same question as can composer resolve it', () => {
	it('classifies a module needing nothing as works-today', () => {
		expect(tierFor('drupal/honeypot')).toEqual({ tier: 'works-today' });
	});

	it('classifies reCAPTCHA as DEFERRABLE and explains the mechanism', () => {
		// it resolves perfectly on Packagist; the install verdict has nothing to say about this
		const out = tierFor('drupal/recaptcha');
		expect(out.tier).toBe('needs-deferred-tier');
		expect(out.reason).toContain('queued');
		expect(out.reason).toContain('alarm');
	});

	// Solr USED to be this assertion, and it moved on a measurement rather than on a tidy-up: the
	// Solarium transport is interceptable above the adapter, so the deferred tier reaches it.
	// `openid_connect` is the surviving refusal and it is a different mechanism -- a token exchange
	// has no partial answer to render, so there is nothing to defer
	it('classifies a token exchange as REFUSED, because a login has no partial answer', () => {
		const out = tierFor('drupal/openid_connect');
		expect(out.tier).toBe('refused');
		expect(out.reason).toContain('INSIDE one render');
	});

	// **ITS TRANSPORT WAS NEVER THE BLOCKER.** This asserted `needs-deferred-tier` until 2026-08-24,
	// on the strength of a note written from reading the module rather than from installing it.
	// Installed, it pulls `maennchen/zipstream-php`, which declares `php-64bit`, so composer's
	// `platform_check.php` asserts `PHP_INT_SIZE === 8` and aborts every request before Drupal boots
	// -- all 56 other contrib cases failed with it. The vector comes first in `tierFor()`, which is
	// exactly why a capability-contract id is the right place to express this
	it('no longer refuses Solr, since the integer width it waited on is satisfied', () => {
		expect(tierFor('drupal/search_api_solr').tier).not.toBe('refused');
	});

	it('names the failure mode a cron module has when cron is turned OFF', () => {
		// the failure mode worth naming: a module that enables and never runs looks fine.
		// The direction matters and this warning used to have it backwards -- it said to SET
		// DRUPAL_CRON=1, which `drupalCronEnabled()` has always treated as the default, so it told
		// a reader to configure something they already had and named no real hazard
		const out = tierFor('drupal/scheduler');
		expect(out.tier).toBe('needs-deferred-tier');
		expect(out.reason).toContain('silently does nothing');
		expect(out.reason).toContain('ON by default');
		expect(out.reason).toContain('DRUPAL_CRON=0');
		expect(out.reason).not.toContain('DRUPAL_CRON=1');
	});

	it('returns UNKNOWN for an unclassified module, never works-today', () => {
		// absence of knowledge is not evidence of safety. Defaulting to works-today would make the
		// tier always agree with the install verdict, which is the blank-meter failure again
		const out = tierFor('drupal/something_nobody_looked_at');
		expect(out.tier).toBe('unknown');
		expect(out.reason).toContain('has not been classified');
	});

	/**
	 * `openid_connect` rather than `search_api_solr`, and why they were swapped.
	 *
	 * Solr used to be the example here and stopped being one on 2026-08-23: its transport turned out
	 * to be interceptable above the adapter, so it needs the DEFERRED tier rather than a suspending
	 * one. A token exchange still cannot be deferred -- there is no placeholder to render while the
	 * login completes -- so it is the honest remaining example of something only suspension fixes.
	 */
	it('promotes the refusal to works-today on a runtime that can suspend', () => {
		expect(
			tierFor('drupal/openid_connect', {
				deferredOutbound: true,
				blockingOutbound: true,
				cron: true
			}).tier
		).toBe('works-today');
	});

	it('refuses a deferrable module on a site with no deferred tier at all', () => {
		expect(
			tierFor('drupal/recaptcha', {
				deferredOutbound: false,
				blockingOutbound: false,
				cron: true
			}).tier
		).toBe('refused');
	});

	it('every classified entry names a real capability or none', () => {
		// a typo in the map would silently classify a module as needing nothing
		const allowed = new Set(['deferrable-outbound', 'blocking-outbound', 'cron']);
		for (const [name, needs] of Object.entries(KNOWN_MODULE_CAPABILITIES)) {
			expect(name.startsWith('drupal/'), name).toBe(true);
			for (const need of needs) expect(allowed.has(need), `${name}: ${need}`).toBe(true);
		}
	});
});
