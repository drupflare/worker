import { describe, expect, it } from 'vitest';
import {
	CORE_VERSION_KEY,
	invalidateVersionPinnedCaches,
	needsInvalidation,
	VERSION_PINNED_CACHES,
	type SqlLike
} from '../../../src/ops/core-version';

/**
 * The two permanent cache rows that hard-code the core version into every asset URL.
 *
 * Measured on the shipped database 2026-08-21: `cache_discovery/library_info:olivero` contains
 * `11.4.5` **298 times** and `cache_data/fonts:olivero:<hash>` 4 times, both at `expire = -1`. On an
 * upgrade whose diff changes `core/misc/ajax.js` -- which 11.4.4 -> 11.4.5 does -- the site serves
 * new JavaScript at a URL still advertising the old version.
 */

function fakeSql(rows: Record<string, string[]>) {
	const statements: { text: string; binding: unknown }[] = [];
	const state = { ...rows };
	const sql: SqlLike = {
		exec(text: string, ...bindings: unknown[]) {
			statements.push({ text, binding: bindings[0] });
			const table = /FROM\s+(\w+)/.exec(text)?.[1] ?? '';
			const prefix = String(bindings[0] ?? '').replace(/%$/, '');
			const present = (state[table] ?? []).filter((cid) => cid.startsWith(prefix));
			if (text.startsWith('DELETE')) {
				state[table] = (state[table] ?? []).filter((cid) => !cid.startsWith(prefix));
			}
			return { toArray: () => present.map((cid) => ({ cid })) };
		}
	};
	return { sql, statements, state };
}

const SHIPPED = ['library_info:olivero', 'fonts:olivero:abc', 'other:thing'];

describe('needsInvalidation', () => {
	it('invalidates when the version moved', () => {
		expect(needsInvalidation('11.4.4', '11.4.5')).toBe(true);
	});

	it('does nothing when the version matches', () => {
		expect(needsInvalidation('11.4.5', '11.4.5')).toBe(false);
	});

	/**
	 * A MISSING VERSION IS NOT AN UPGRADE.
	 *
	 * Every database built before this key existed has no value for it. Treating absent as changed
	 * would make every deployed site rebuild 89 KB of library discovery once, on the deploy that
	 * introduced the check -- a self-inflicted stampede to fix a problem none of them had yet.
	 */
	it('treats a missing stored version as a baseline, not a change', () => {
		expect(needsInvalidation(null, '11.4.5')).toBe(false);
		expect(needsInvalidation('', '11.4.5')).toBe(false);
	});
});

describe('invalidateVersionPinnedCaches', () => {
	it('drops both pinned rows on an upgrade and records the new version', () => {
		const { sql, state } = fakeSql({ cache_discovery: SHIPPED, cache_data: SHIPPED });
		let recorded: string | null = null;
		const out = invalidateVersionPinnedCaches(sql, '11.4.4', '11.4.5', (v) => (recorded = v));
		expect(out.deleted).toBe(2);
		expect(out.from).toBe('11.4.4');
		expect(recorded).toBe('11.4.5');
		expect(state.cache_discovery).not.toContain('library_info:olivero');
		expect(state.cache_data).not.toContain('fonts:olivero:abc');
	});

	/**
	 * Only the pinned rows. Dropping a whole bin would be a far bigger rebuild than the problem.
	 */
	it('leaves every other row in those bins alone', () => {
		const { sql, state } = fakeSql({ cache_discovery: SHIPPED, cache_data: SHIPPED });
		invalidateVersionPinnedCaches(sql, '11.4.4', '11.4.5', () => {});
		expect(state.cache_discovery).toContain('other:thing');
		expect(state.cache_data).toContain('other:thing');
	});

	it('deletes nothing on the normal path and still records a baseline', () => {
		const { sql, statements } = fakeSql({ cache_discovery: SHIPPED, cache_data: SHIPPED });
		let recorded: string | null = null;
		const out = invalidateVersionPinnedCaches(sql, null, '11.4.5', (v) => (recorded = v));
		expect(out.deleted).toBe(0);
		expect(statements, 'the normal path must touch no table').toHaveLength(0);
		expect(recorded, 'but it must leave a baseline for the next upgrade').toBe('11.4.5');
	});

	it('writes nothing at all when the version already matches', () => {
		const { sql, statements } = fakeSql({ cache_discovery: SHIPPED });
		let writes = 0;
		invalidateVersionPinnedCaches(sql, '11.4.5', '11.4.5', () => writes++);
		expect(statements).toHaveLength(0);
		expect(writes, 'a matching version must not rewrite the meta row every request').toBe(0);
	});

	/**
	 * A site that has never rendered has no cache tables at all, and that is not an error.
	 */
	it('survives a bin that does not exist yet', () => {
		const sql: SqlLike = {
			exec() {
				throw new Error('no such table: cache_discovery');
			}
		};
		let recorded: string | null = null;
		const out = invalidateVersionPinnedCaches(sql, '11.4.4', '11.4.5', (v) => (recorded = v));
		expect(out.deleted).toBe(0);
		expect(recorded, 'and the version is still recorded, or it retries forever').toBe('11.4.5');
	});

	it('matches by prefix, so a site on another theme is covered', () => {
		const { sql, state } = fakeSql({
			cache_discovery: ['library_info:claro'],
			cache_data: ['fonts:claro:zzz']
		});
		invalidateVersionPinnedCaches(sql, '11.4.4', '11.4.5', () => {});
		expect(state.cache_discovery).toEqual([]);
		expect(state.cache_data).toEqual([]);
	});

	it('keeps every LIKE pattern inside the 50-byte platform ceiling', () => {
		// a LIKE/GLOB pattern over 50 bytes is refused by DO SQLite
		for (const { prefix } of VERSION_PINNED_CACHES) {
			expect(new TextEncoder().encode(`${prefix}%`).length).toBeLessThan(50);
		}
	});

	it('names a stable meta key, since a rename would re-trigger every site', () => {
		expect(CORE_VERSION_KEY).toBe('core_version');
	});
});
