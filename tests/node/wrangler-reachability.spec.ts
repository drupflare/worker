import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The canonical config must actually REACH the code it depends on.
 *
 * This project has shipped the same defect five times: a correct fact recorded in one file and a wrong
 * default in another, where no measurement of the right artifact could catch it.
 *
 *   1. `wrangler.jsonc` had no `alias`, so it bundled a binary the report said "can never ship".
 *   2. **No config set `LAZY_MOUNT=1`** -- the lazy FS was unreachable code from the day it was written.
 *   3. The diagnostics gate covered `/serve`, and the config set the flag to "1".
 *   4. `assets.directory` was `./assets`, publishing the site database at `/drupal/site.sqlite`.
 *   5. `scheduled()` drove the WebSocket fill window and **nothing configured a cron trigger**, so it
 *      never fired -- and the fill window is what makes the target workload fit at all (1% dynamic at
 *      3M visits/month needs ~1,000 regenerations/day; the alarm chain funds ~210).
 *
 * Every one was found by asking "what does the DEFAULT do", which is a different question from "is this
 * component correct". These assertions ask it automatically.
 *
 * Node lane, because workerd cannot read a file.
 */

/** JSONC: strip line comments before parsing, which is why this cannot just be `import` */
function readJsonc(path: string): Record<string, unknown> {
	const raw = readFileSync(path, 'utf8');
	const stripped = raw
		.split('\n')
		.map((line) => line.replace(/^\s*\/\/.*$/, ''))
		.join('\n');
	return JSON.parse(stripped) as Record<string, unknown>;
}

const config = readJsonc('wrangler.jsonc');
const vars = (config.vars ?? {}) as Record<string, string>;

describe('the canonical config reaches the code it needs', () => {
	it('configures a cron trigger, or the fill window is unreachable', () => {
		// defect 5. `scheduled()` exists in src/site.ts and drove this all along
		const triggers = config.triggers as { crons?: string[] } | undefined;
		expect(triggers?.crons, 'no cron trigger: scheduled() can never fire').toBeTruthy();
		expect(triggers!.crons!.length).toBeGreaterThan(0);
	});

	it('sets LAZY_MOUNT=1, which was unreachable code for its entire life once', () => {
		expect(vars.LAZY_MOUNT).toBe('1');
	});

	it('does NOT set PW_DIAGNOSTICS, because the gate once covered /serve too', () => {
		// defect 3: a deployed worker had two states and both were wrong
		expect(vars.PW_DIAGNOSTICS).toBeUndefined();
	});

	it('keeps the alias that stops a can-never-ship binary being bundled', () => {
		const alias = (config.alias ?? {}) as Record<string, string>;
		expect(Object.keys(alias).length).toBeGreaterThan(0);
		expect(Object.values(alias).join(' ')).toContain('php-binary');
	});

	it('serves assets from a directory an .assetsignore narrows', () => {
		// defect 4: ./assets published the site database. The ignore file is what withholds it
		const assets = (config.assets ?? {}) as { directory?: string };
		expect(assets.directory).toBeTruthy();
		expect(() => readFileSync('assets/.assetsignore', 'utf8')).not.toThrow();
	});

	it('declares the DO migration, or a fresh deploy has no SQLite class', () => {
		const migrations = config.migrations as
			Array<{ new_sqlite_classes?: string[] }> | undefined;
		expect(migrations?.[0]?.new_sqlite_classes).toContain('SitePhpDurableObject');
	});
});
