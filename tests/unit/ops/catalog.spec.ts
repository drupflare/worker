import { describe, expect, it } from 'vitest';
import { findEntry, loadCatalog, parseCatalog, planInstall } from '../../../src/ops/catalog';

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
