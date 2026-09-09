import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
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
