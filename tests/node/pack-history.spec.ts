import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

/**
 * The pack used to ship the bake's own log and the bake's own clock, and every site inherited both.
 *
 * `watchdog` carried 40 rows dated 7-9 August 2026 and `key_value` carried
 * `state:install_time = 1786258127`, so a site provisioned today opened with weeks-old log entries
 * and a red Cron row: `SystemRequirementsHooks` falls back to `install_time` when
 * `system.cron_last` is not numeric, against a two-week error threshold.
 *
 * ASSERTED AGAINST THE PACK, NOT THE SOURCE FILE, and that is the whole reason this file reads the
 * chunks. The same fix applied to `assets/drupal/site.sqlite` directly is undone by the next
 * `bun install`: `restore-artifacts` verifies that file against `cdn-manifest.json` and
 * re-downloads it. `pack-sql.ts` drops the rows out of its working copy instead, so the shipped
 * artifact is clean whatever the source file happens to hold.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
const PACK = resolve(ROOT, 'assets', 'drupal-sql');

/** every statement the pack replays, which is what a provisioned site ends up holding */
function statements(): string[] {
	const out: string[] = [];
	for (const file of readdirSync(PACK).sort()) {
		if (!file.endsWith('.json') || file === 'manifest.json') continue;
		const parsed = JSON.parse(readFileSync(resolve(PACK, file), 'utf8')) as unknown;
		for (const entry of (parsed as { statements?: Array<{ s?: unknown }> })?.statements ?? []) {
			if (typeof entry?.s === 'string') out.push(entry.s);
		}
	}
	return out;
}

describe('the shipped pack carries no history of the bake', () => {
	const ready = existsSync(PACK);

	it('found the pack to read, or it is asserting nothing', (ctx) => {
		if (!ready) return ctx.skip();
		expect(statements().length).toBeGreaterThan(100);
	});

	it('inserts no watchdog row', (ctx) => {
		if (!ready) return ctx.skip();
		const inserts = statements().filter((s) => /INSERT INTO ["`]?watchdog\b/i.test(s));
		expect(inserts, 'the bake log shipped to every site once').toEqual([]);
	});

	// the general form, because a check naming only `watchdog` passes on the next thing that leaks
	it('inserts no state key stamped with the bake clock', (ctx) => {
		if (!ready) return ctx.skip();
		const stamped = statements().filter(
			(s) =>
				/INSERT INTO ["`]?key_value\b/i.test(s) && /install_time|system\.cron_last/.test(s)
		);
		expect(stamped).toEqual([]);
	});

	it('still creates the watchdog TABLE, so this did not pass by dropping the schema', (ctx) => {
		if (!ready) return ctx.skip();
		const created = statements().filter((s) =>
			/CREATE TABLE (IF NOT EXISTS )?["`]?watchdog\b/i.test(s)
		);
		expect(created.length).toBeGreaterThan(0);
	});

	it('still ships the rows a site needs', (ctx) => {
		if (!ready) return ctx.skip();
		const config = statements().filter((s) => /INSERT INTO ["`]?config\b/i.test(s));
		expect(config.length).toBeGreaterThan(50);
	});
});

describe('a migrated database that carries the host tables', () => {
	it('creates the cfw_* tables IF NOT EXISTS and every other table plainly', () => {
		const dir = mkdtempSync(join(tmpdir(), 'pack-host-tables-'));
		try {
			const db = new DatabaseSync(join(dir, 'site.sqlite'));
			db.exec(
				'CREATE TABLE node (nid INTEGER PRIMARY KEY); INSERT INTO node VALUES (1);' +
					'CREATE TABLE cache_container (cid TEXT PRIMARY KEY, data BLOB, expire INTEGER, created INTEGER, serialized INTEGER, tags TEXT, checksum TEXT);' +
					'CREATE TABLE config (collection TEXT, name TEXT, data BLOB, PRIMARY KEY (collection, name));' +
					'CREATE TABLE IF NOT EXISTS cfw_file (uri TEXT PRIMARY KEY, size INTEGER NOT NULL);' +
					"INSERT INTO cfw_file VALUES ('public://a.png', 3);"
			);
			db.close();
			execFileSync(
				'node',
				['scripts/pack-sql.ts', join(dir, 'site.sqlite'), join(dir, 'out')],
				{
					cwd: ROOT,
					stdio: 'pipe'
				}
			);
			const ddl: string[] = [];
			for (const file of readdirSync(join(dir, 'out')).sort()) {
				if (!/^\d+\.json$/.test(file)) continue;
				const parsed = JSON.parse(readFileSync(join(dir, 'out', file), 'utf8')) as {
					statements?: Array<{ s?: unknown }>;
				};
				for (const e of parsed.statements ?? []) {
					if (typeof e.s === 'string' && /^CREATE TABLE/i.test(e.s)) ddl.push(e.s);
				}
			}
			// SQLite drops IF NOT EXISTS from the stored schema, so the source file cannot carry it
			expect(ddl.find((s) => /\bcfw_file\b/.test(s))).toMatch(
				/^CREATE TABLE IF NOT EXISTS cfw_file/
			);
			expect(ddl.find((s) => /\bnode\b/.test(s))).toMatch(/^CREATE TABLE "?node"?/);
			expect(ddl.find((s) => /\bnode\b/.test(s))).not.toContain('IF NOT EXISTS');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('packs a database fresh from an install, which has not created cache_container yet', () => {
		const dir = mkdtempSync(join(tmpdir(), 'pack-no-container-'));
		try {
			const db = new DatabaseSync(join(dir, 'site.sqlite'));
			db.exec(
				'CREATE TABLE node (nid INTEGER PRIMARY KEY); INSERT INTO node VALUES (1);' +
					'CREATE TABLE config (collection TEXT, name TEXT, data BLOB, PRIMARY KEY (collection, name));'
			);
			db.close();
			execFileSync(
				'node',
				['scripts/pack-sql.ts', join(dir, 'site.sqlite'), join(dir, 'out')],
				{
					cwd: ROOT,
					stdio: 'pipe'
				}
			);
			expect(readdirSync(join(dir, 'out')).some((f) => /^\d+\.json$/.test(f))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
