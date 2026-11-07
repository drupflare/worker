import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { DUMP_START, dumpChunk, type DumpCursor, type DumpOptions } from '../../src/db/export-sql';
import type { SqlLike } from '../../src/db/migrate-sql';

/**
 * A dump must carry every row of a table once, whatever the table's shape and however many chunks
 * the export takes.
 *
 * `cfw_meta` is `WITHOUT ROWID`, so it is paged by `OFFSET`, and it holds rows a dump withholds (the
 * owner token, the hash salt, the site identity). A withheld row was consumed without moving the
 * `OFFSET`, so the next query began one row early and the dump carried that row twice. A restore
 * replays plain `INSERT`s, so the second one stopped the replay on a primary key, with the target
 * half overwritten: `UNIQUE constraint failed: cfw_meta.k`.
 */

function sqlOver(db: DatabaseSync): SqlLike {
	return {
		exec(text, ...params) {
			const stmt = db.prepare(text);
			if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)) {
				const rows = stmt.all(...params) as Record<string, unknown>[];
				return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
			}
			const r = stmt.run(...params);
			return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes ?? 0) };
		}
	};
}

const WITHHELD = ['cf_oauth_token', 'first_run_at', 'hash_salt', 'owner_token', 'site_name'];
const ORDINARY = Array.from({ length: 30 }, (_, i) => `k${String(i).padStart(2, '0')}`);

function seed(db: DatabaseSync, shape: 'without-rowid' | 'rowid') {
	db.exec(
		`CREATE TABLE cfw_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)${shape === 'without-rowid' ? ' WITHOUT ROWID' : ''}`
	);
	const put = db.prepare('INSERT INTO cfw_meta (k, v) VALUES (?, ?)');
	for (const key of [...ORDINARY, ...WITHHELD]) put.run(key, `value of ${key}`);
}

function keysInserted(sql: string): string[] {
	return [...sql.matchAll(/INSERT INTO "cfw_meta" \("k", "v"\) VALUES \('([^']+)'/g)].map(
		(match) => match[1]!
	);
}

function dumpAll(db: DatabaseSync, opts: DumpOptions = {}): { sql: string; chunks: number } {
	const sql = sqlOver(db);
	let cursor: DumpCursor = DUMP_START;
	let text = '';
	let chunks = 0;
	for (; chunks < 1000;) {
		const chunk = dumpChunk(sql, cursor, opts);
		chunks++;
		text += `${chunk.sql}\n`;
		if (chunk.done) break;
		cursor = chunk.cursor;
	}
	return { sql: text, chunks };
}

let db: DatabaseSync;

beforeEach(() => {
	db = new DatabaseSync(':memory:');
});

describe('a WITHOUT ROWID table with withheld rows', () => {
	it('is carried once per row in a single chunk', () => {
		seed(db, 'without-rowid');
		const keys = keysInserted(dumpAll(db).sql);
		expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
		expect([...keys].sort()).toEqual([...ORDINARY].sort());
	});

	it('is carried once per row across many chunks', () => {
		seed(db, 'without-rowid');
		const { sql, chunks } = dumpAll(db, { maxLiteralChars: 64, maxCharsPerChunk: 128 });
		expect(chunks).toBeGreaterThan(5);
		const keys = keysInserted(sql);
		expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
		expect([...keys].sort()).toEqual([...ORDINARY].sort());
	});

	it('never carries a withheld row', () => {
		seed(db, 'without-rowid');
		const keys = keysInserted(dumpAll(db, { maxLiteralChars: 64, maxCharsPerChunk: 128 }).sql);
		for (const key of WITHHELD) expect(keys).not.toContain(key);
	});

	it('matches a table that has a rowid, which keyset-pages and always did', () => {
		seed(db, 'rowid');
		const keys = keysInserted(dumpAll(db, { maxLiteralChars: 64, maxCharsPerChunk: 128 }).sql);
		expect([...keys].sort()).toEqual([...ORDINARY].sort());
	});

	it('replays into a fresh database without a constraint failure', () => {
		seed(db, 'without-rowid');
		const { sql } = dumpAll(db, { maxLiteralChars: 64, maxCharsPerChunk: 128 });
		const target = new DatabaseSync(':memory:');
		expect(() => target.exec(sql)).not.toThrow();
		const rows = target.prepare('SELECT COUNT(*) AS n FROM cfw_meta').get() as { n: number };
		expect(rows.n).toBe(ORDINARY.length);
	});
});
