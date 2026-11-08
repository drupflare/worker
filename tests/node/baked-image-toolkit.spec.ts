import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { artifactGate } from './helpers/artifact-gate';

/**
 * A baked site that no claim has touched keeps whatever `system.image` the database ships, and
 * core's own default is `gd`. `GDToolkit::isAvailable()` is `function_exists('imagegd2')`, which the
 * shim defines, so a baked `gd` makes Drupal build every derivative eagerly instead of through the
 * delivery path. Neither the claim-time reconcile step nor `pack/consistency.php` flips an available
 * selection, so the database has to say `cfw_images` itself.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
const SQLITE = resolve(ROOT, 'assets', 'drupal', 'site.sqlite');
const CHUNKS = resolve(ROOT, 'assets', 'drupal-sql');
const INSTALLER = resolve(ROOT, 'scripts', 'drupal', 'install-site-db.php');

const have = !artifactGate(['assets/drupal/site.sqlite', 'assets/drupal-sql']);

/** the toolkit a serialized `system.image` names, or undefined when it names none */
function toolkitOf(serialized: string): string | undefined {
	return /s:7:"toolkit";s:\d+:"([^"]*)";/.exec(serialized)?.[1];
}

/**
 * Both rows Drupal reads: the config row and the `cache_config` copy it reads first.
 *
 * Read from a copy, because the file is in WAL mode and opening it in place, even read-only, leaves
 * a `-wal` and a `-shm` beside the tracked artifact.
 */
function stored(): { config: string; cached: string } {
	const dir = mkdtempSync(join(tmpdir(), 'baked-toolkit-'));
	const copy = join(dir, 'site.sqlite');
	copyFileSync(SQLITE, copy);
	const db = new DatabaseSync(copy, { readOnly: true });
	try {
		const config = db.prepare("SELECT data FROM config WHERE name = 'system.image'").get();
		const cached = db.prepare("SELECT data FROM cache_config WHERE cid = 'system.image'").get();
		return { config: String(config?.data), cached: String(cached?.data) };
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

type Chunk = { statements: { s: string; p?: unknown[] }[] };

/** every packed statement that carries a `system.image` row, with the table it inserts into */
function packedRows(): { table: string; data: string }[] {
	const rows: { table: string; data: string }[] = [];
	for (let i = 0; ; i++) {
		let chunk: Chunk;
		try {
			chunk = JSON.parse(
				readFileSync(resolve(CHUNKS, `${String(i).padStart(4, '0')}.json`), 'utf8')
			);
		} catch {
			return rows;
		}
		for (const { s, p } of chunk.statements) {
			const table = /^INSERT INTO "?(config|cache_config)"?/.exec(s)?.[1];
			if (!table || !p?.includes('system.image')) continue;
			rows.push({
				table,
				data: String(p.find((v) => typeof v === 'string' && v.includes('toolkit')))
			});
		}
	}
}

describe.skipIf(!have)('the baked image toolkit', () => {
	it('names cfw_images in the config row', () => {
		expect(toolkitOf(stored().config), 'system.image in site.sqlite').toBe('cfw_images');
	});

	it('names it in the cache_config copy Drupal reads first', () => {
		expect(toolkitOf(stored().cached), 'system.image in cache_config').toBe('cfw_images');
	});

	it('keeps the two copies identical, so only the toolkit was edited', () => {
		const { config, cached } = stored();
		expect(cached).toBe(config);
	});

	it('is the value the replay chunks carry, in both tables', () => {
		const rows = packedRows();
		expect(rows.map((r) => r.table).sort()).toEqual(['cache_config', 'config']);
		for (const row of rows) {
			expect(toolkitOf(row.data), `${row.table} chunk; run \`bun run assets:sql\``).toBe(
				'cfw_images'
			);
		}
	});

	it('is written by the script that rebuilds the database', () => {
		const source = readFileSync(INSTALLER, 'utf8');
		expect(source).toMatch(/'system\.image'\s*=>\s*\['toolkit'\s*=>\s*'cfw_images'\]/);
	});
});

describe('the toolkit reader', () => {
	it('reads the value out of a serialized row and returns undefined without one', () => {
		expect(toolkitOf('a:1:{s:7:"toolkit";s:2:"gd";}')).toBe('gd');
		expect(toolkitOf('a:1:{s:7:"toolkit";s:10:"cfw_images";}')).toBe('cfw_images');
		expect(toolkitOf('a:1:{s:12:"jpeg_quality";i:75;}')).toBeUndefined();
	});
});
