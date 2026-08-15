import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { compareSiteDbs } from '../../scripts/diff-site-db';

/**
 * The packer's acceptance gate, tested against its own failure modes.
 *
 * `scripts/diff-site-db.ts` is what decides whether a rebuilt `site.sqlite` is equivalent to the one
 * that ships, so it is the instrument the whole 2.5 claim rests on. This project has moved a
 * free-tier verdict five times and FOUR of those were the instrument rather than the system, so the
 * assertions here are mostly negative: the gate must go red on a database that diverged. A gate that
 * only ever reports green is indistinguishable from no gate, and that is the state `site.sqlite` was
 * already in.
 */

/** the minimum shape the comparison reads: tables, config, core.extension, key_value */
function fixture(opts: {
	tables?: string[];
	config?: string[];
	modules?: string[];
	stateRows?: string[];
	routerRows?: number;
}): { path: string; db: DatabaseSync } {
	const db = new DatabaseSync(':memory:');
	const tables = opts.tables ?? [];
	db.exec('CREATE TABLE config (name TEXT PRIMARY KEY, data BLOB)');
	db.exec('CREATE TABLE router (name TEXT PRIMARY KEY)');
	db.exec('CREATE TABLE key_value (collection TEXT, name TEXT, value BLOB)');
	db.exec('CREATE TABLE menu_tree (id TEXT PRIMARY KEY)');
	db.exec('CREATE TABLE users_field_data (uid INTEGER PRIMARY KEY)');
	for (const t of tables) db.exec(`CREATE TABLE "${t}" (cid TEXT PRIMARY KEY)`);

	const modules = opts.modules ?? ['system', 'user'];
	// the serialised shape core.extension actually stores, because the parser reads it with a regex
	const serialised =
		'a:2:{s:6:"module";a:' +
		modules.length +
		':{' +
		modules.map((m) => `s:${m.length}:"${m}";i:0;`).join('') +
		'}s:5:"theme";a:0:{}}';
	db.prepare('INSERT INTO config (name, data) VALUES (?, ?)').run('core.extension', serialised);
	for (const name of opts.config ?? []) {
		db.prepare('INSERT INTO config (name, data) VALUES (?, ?)').run(name, 'a:0:{}');
	}
	for (let i = 0; i < (opts.routerRows ?? 0); i++) {
		db.prepare('INSERT INTO router (name) VALUES (?)').run(`route.${i}`);
	}
	for (const name of opts.stateRows ?? []) {
		db.prepare('INSERT INTO key_value (collection, name, value) VALUES (?, ?, ?)').run(
			'state',
			name,
			'x'
		);
	}
	return { path: `:memory:${modules.length}`, db };
}

const BAKED = {
	tables: ['cache_container', 'cache_page', 'cache_render'],
	config: ['system.site', 'system.theme'],
	modules: ['node', 'system', 'user'],
	stateRows: ['system.private_key', 'system.theme.files', 'twig_extension_hash_prefix'],
	routerRows: 5
};

describe('the packer acceptance gate goes GREEN only on an equivalent database', () => {
	it('passes two databases describing the same site', () => {
		const report = compareSiteDbs(fixture(BAKED), fixture(BAKED));
		expect(report.verdict).toBe('STRUCTURALLY EQUIVALENT');
		expect(report.problems).toEqual([]);
	});

	it('passes a FRESH install missing only the lazily-created bins and first-request state', () => {
		// the real case: install-site-db.php output against the shipping pack. Those six bins and
		// three state rows are written on first request, so their absence is correct rather than
		// tolerated
		const fresh = fixture({ ...BAKED, tables: ['cache_container'], stateRows: [] });
		const report = compareSiteDbs(fixture(BAKED), fresh);
		expect(report.verdict).toBe('STRUCTURALLY EQUIVALENT');
		expect(report.lazyBinsAbsentFromBuild).toEqual(['cache_page', 'cache_render']);
		expect(report.firstRequestStateRowsAbsentFromBuild).toEqual([
			'system.private_key',
			'system.theme.files',
			'twig_extension_hash_prefix'
		]);
	});
});

describe('and RED on every divergence that matters, which is the point of having it', () => {
	it('fails a missing table that is not a lazily-created cache bin', () => {
		const built = fixture({ ...BAKED, tables: ['cache_page', 'cache_render'] });
		const report = compareSiteDbs(fixture(BAKED), built);
		expect(report.verdict).toBe('DIVERGED');
		expect(report.problems.join(' ')).toContain('cache_container');
	});

	it('fails a missing config object', () => {
		const built = fixture({ ...BAKED, config: ['system.site'] });
		const report = compareSiteDbs(fixture(BAKED), built);
		expect(report.verdict).toBe('DIVERGED');
		expect(report.problems.join(' ')).toContain('system.theme');
	});

	it('fails a module set that gained a module', () => {
		// the divergence that would silently change the container cache key and the render
		const built = fixture({ ...BAKED, modules: ['node', 'system', 'user', 'media'] });
		const report = compareSiteDbs(fixture(BAKED), built);
		expect(report.verdict).toBe('DIVERGED');
		expect(report.problems.join(' ')).toContain('media');
		expect(report.modules.identical).toBe(false);
	});

	it('fails a module set that LOST a module', () => {
		const built = fixture({ ...BAKED, modules: ['system', 'user'] });
		const report = compareSiteDbs(fixture(BAKED), built);
		expect(report.verdict).toBe('DIVERGED');
		expect(report.problems.join(' ')).toContain('node');
	});

	it('fails a router that lost routes, which a render would not reveal', () => {
		// 419 routes against 400 renders the same front page; only a count catches it
		const built = fixture({ ...BAKED, routerRows: 3 });
		const report = compareSiteDbs(fixture(BAKED), built);
		expect(report.verdict).toBe('DIVERGED');
		expect(report.problems.join(' ')).toContain('router');
	});

	it('does NOT excuse a missing state row the reference also lacks', () => {
		// the subtraction is conditional on the reference HAVING the row; otherwise a build could be
		// short by three rows for some other reason and be waved through
		const reference = fixture({ ...BAKED, stateRows: [] });
		const built = fixture({ ...BAKED, stateRows: [] });
		const report = compareSiteDbs(reference, built);
		expect(report.firstRequestStateRowsAbsentFromBuild).toEqual([]);
		expect(report.verdict).toBe('STRUCTURALLY EQUIVALENT');
	});
});
