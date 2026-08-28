import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** at `max_age` 0 Drupal emits `private, no-store` and `cfw_page` never fills; fix it at the source */

const ROOT = resolve(import.meta.dirname, '..', '..');
const SQLITE = resolve(ROOT, 'assets', 'drupal', 'site.sqlite');

/**
 * PHP rather than a sqlite3 CLI, because the value is a serialized PHP array inside the blob.
 *
 * @param table `config`, or the CACHE BIN that shadows it.
 */
function performanceConfig(table: 'config' | 'cache_config' = 'config'): Record<string, any> {
	const column = table === 'config' ? 'name' : 'cid';
	const out = execFileSync(
		'php',
		[
			'-r',
			`$d = new PDO("sqlite:" . $argv[1]);
			 $r = $d->query('SELECT data FROM ' . $argv[2] . ' WHERE ' . $argv[3] . ' = "system.performance"')->fetch(PDO::FETCH_ASSOC);
			 echo json_encode(unserialize($r["data"]));`,
			'--',
			SQLITE,
			table,
			column
		],
		{ encoding: 'utf8' }
	);
	return JSON.parse(out);
}

function haveTools(): boolean {
	if (!existsSync(SQLITE)) return false;
	try {
		execFileSync('php', ['-r', 'exit(class_exists("PDO") ? 0 : 1);']);
		return true;
	} catch {
		return false;
	}
}

describe('the shipped page cache configuration', () => {
	const ready = haveTools();

	it('declares a non-zero page max_age, or nothing is ever stored', (ctx) => {
		if (!ready) return ctx.skip();
		const max = performanceConfig()?.cache?.page?.max_age;
		expect(typeof max).toBe('number');
		expect(
			Number(max),
			'cache.page.max_age is 0, so Drupal emits `private, no-store` and cfw_page stays empty'
		).toBeGreaterThan(0);
	});

	// the CACHED copy, which is what Drupal reads and what this file used to miss: `config` was
	// edited to 300 and `cache_config` kept its own serialized 0, so no site ever filled cfw_page
	it('carries the same max_age in the cache bin that shadows it', (ctx) => {
		if (!ready) return ctx.skip();
		const fromConfig = Number(performanceConfig('config')?.cache?.page?.max_age);
		const fromCache = Number(performanceConfig('cache_config')?.cache?.page?.max_age);
		expect(fromCache).toBe(fromConfig);
		expect(fromCache).toBeGreaterThan(0);
	});

	it('keeps the two copies otherwise identical, so only the one integer was touched', (ctx) => {
		if (!ready) return ctx.skip();
		expect(performanceConfig('cache_config')).toEqual(performanceConfig('config'));
	});

	it('keeps the rest of the row intact, because the edit is surgical', (ctx) => {
		if (!ready) return ctx.skip();
		const cfg = performanceConfig();
		// a regenerated pack would plausibly lose these too, and they are cheap to pin
		expect(cfg?.css?.compress).toBe(true);
		expect(cfg?.js?.compress).toBe(true);
		expect(cfg?.fast_404?.enabled).toBe(true);
		expect(cfg?._core?.default_config_hash).toBeTruthy();
	});
});

describe('what a render has to NOT say for a page to be stored', () => {
	// the literal `fillOne()` tests against; kept here so a change to either side is visible
	const refuses = (cacheControl: string) =>
		/(^|,)\s*(no-store|private)\s*(,|$)/i.test(cacheControl);

	it('refuses exactly what Drupal emits at max_age 0', () => {
		expect(refuses('private, no-store')).toBe(true);
		expect(refuses('must-revalidate, no-cache, private')).toBe(true);
	});

	it('accepts what Drupal emits once a max_age is set', () => {
		expect(refuses('max-age=300, public')).toBe(false);
		expect(refuses('public, max-age=300')).toBe(false);
	});

	it('does not refuse on a substring, which would drop cacheable pages', () => {
		// `no-store` inside another token is not the directive
		expect(refuses('max-age=300, public, x-no-storefront')).toBe(false);
		expect(refuses('private-cache=1')).toBe(false);
	});
});
