import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KV_OVERRIDABLE, SETTINGS_KV_KEY } from '../../src/ops/plan';

/**
 * Every lever on the allow-list reaches a reader.
 *
 * `plan-kv.spec.ts` proves each name is read OUT of KV and `lever-behaviour.spec.ts` proves each
 * one changes an observable. Neither could catch the third failure: a name that is on the list,
 * resolved per plan, copied onto the object's env and asserted through the plumbing, and then read
 * by nothing in `src/`. `FILL_BATCH_WALL_MS` was exactly that -- it could not have worked, because
 * the clock does not advance across a synchronous `php._run()` so wall clock cannot bound a batch
 * from inside one, and it survived on the list until somebody read the fill loop.
 *
 * A grep rather than a call graph, deliberately: the failure is a name nothing MENTIONS, and a name
 * that appears somewhere real is one a reader can follow. The exclusion is `plan.ts` itself, which
 * is where the list lives.
 *
 * This also replaces four prose counts. `plan.ts`, `site-do.ts` and `docs/configuration.md` each
 * carried a number -- seven, or eleven -- while the list held eighteen, and one of them named the
 * deleted lever. A count in prose cannot be checked; this property can.
 */

const SRC = new URL('../../src', import.meta.url).pathname;

function sources(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			sources(path, out);
			continue;
		}
		if (entry.endsWith('.ts')) out.push(path);
	}
	return out;
}

/** every `src/` file except the one that declares the list */
const FILES = sources(SRC).filter((p) => !p.endsWith(`${join('ops', 'plan.ts')}`));
const TEXT = new Map(FILES.map((p) => [p, readFileSync(p, 'utf8')]));

describe('the KV allow-list is a list of live levers', () => {
	it('names a lever that at least one other module mentions', () => {
		const orphans = KV_OVERRIDABLE.filter(
			(name) => ![...TEXT.values()].some((text) => text.includes(name))
		);
		expect(
			orphans,
			`on the allow-list and read by nothing in src/: ${orphans.join(', ')}`
		).toEqual([]);
	});

	it('does not name the lever that was deleted for being unreadable', () => {
		// the specific regression, kept by name because its docblock outlived it in three files
		expect(KV_OVERRIDABLE as readonly string[]).not.toContain('FILL_BATCH_WALL_MS');
		for (const [path, text] of TEXT) {
			expect(text, `${path} still cites a deleted lever`).not.toContain('FILL_BATCH_WALL_MS');
		}
	});

	it('holds no duplicates, so the count and the set agree', () => {
		expect(new Set(KV_OVERRIDABLE).size).toBe(KV_OVERRIDABLE.length);
	});

	it('withholds every name whose worst case is a reach rather than a slow site', () => {
		// the privilege boundary the docblock states: KV is operator-writable, so a name here that
		// changed what is REACHABLE would hand `/sql` to anyone who can write the namespace
		for (const name of [
			'PW_DIAGNOSTICS',
			'SMTP_HOST',
			'SMTP_USER',
			'SMTP_PASS',
			'CF_EMAIL_TOKEN',
			'CF_EMAIL_ACCOUNT_ID',
			'MAIL_FROM',
			'OUTBOUND_GUARD',
			'PLAN'
		]) {
			expect(KV_OVERRIDABLE as readonly string[], `${name} is KV-overridable`).not.toContain(
				name
			);
		}
	});

	it('is reached through one key, which is what makes the read atomic', () => {
		expect(SETTINGS_KV_KEY).toBe('settings');
	});

	it('carries no count in prose, because four of them drifted', () => {
		// a number a reader trusts and nothing checks; the property above is the replacement
		const claims = /\b(?:seven|eleven|twelve|thirteen|fourteen|fifteen)\s+levers\b/i;
		for (const [path, text] of TEXT) {
			expect(text, `${path} counts the levers in prose`).not.toMatch(claims);
		}
	});
});
