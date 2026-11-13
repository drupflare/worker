import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dumpDatabase } from '../../src/db/export-sql';
import { storeImport, storedImportLoader } from '../../src/db/import-sql';
import {
	SqlMigrator,
	readMigrateCursor,
	type SqlLike,
	type StorageLike
} from '../../src/db/migrate-sql';
import {
	WRITE_JOURNAL_CAP,
	changeManifest,
	changeStatements,
	endMark,
	isTracked,
	markSchemaHook,
	mysqlLiteral,
	noteRestoreMark,
	openRestoreMark,
	readMark,
	readRestoreMark,
	schemaChange,
	startMark,
	type MarkState
} from '../../src/db/write-mark';
import { countingSql } from '../../src/db/write-tally';

/**
 * The accepted-write count and the changes since a mark, over a real SQLite.
 *
 * What these pin: a write to an authoritative table counts and one to a cache bin or a session
 * does not; the count lives in the database, so reopening it loses nothing; a site with no mark
 * holds no trigger and no journal; and the count and the export stop at the same write.
 */

function sqlOver(db: DatabaseSync): SqlLike {
	return {
		exec(text, ...params) {
			const stmt = db.prepare(text);
			if (/^\s*(SELECT|PRAGMA|WITH)\b|\bRETURNING\b/i.test(text)) {
				const rows = stmt.all(...(params as never[])) as Record<string, unknown>[];
				return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
			}
			const r = stmt.run(...(params as never[]));
			return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes ?? 0) };
		}
	};
}

function storageOver(db: DatabaseSync): StorageLike {
	return {
		transactionSync(cb) {
			db.exec('BEGIN');
			try {
				const out = cb();
				db.exec('COMMIT');
				return out;
			} catch (e) {
				db.exec('ROLLBACK');
				throw e;
			}
		}
	};
}

const SCHEMA = [
	'CREATE TABLE node (nid INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT)',
	'CREATE TABLE node_field_data (nid INTEGER, vid INTEGER, langcode TEXT, title TEXT, PRIMARY KEY (nid, langcode))',
	'CREATE TABLE users_field_data (uid INTEGER PRIMARY KEY, name TEXT, access INTEGER)',
	'CREATE TABLE config (name TEXT PRIMARY KEY, data BLOB)',
	'CREATE TABLE comment_field_data (cid INTEGER PRIMARY KEY, body TEXT)',
	'CREATE TABLE file_managed (fid INTEGER PRIMARY KEY, uri TEXT)',
	'CREATE TABLE cache_render (cid TEXT PRIMARY KEY, data BLOB)',
	'CREATE TABLE cachetags (tag TEXT PRIMARY KEY, invalidations INTEGER)',
	'CREATE TABLE sessions (sid TEXT PRIMARY KEY, session BLOB)',
	'CREATE TABLE semaphore (name TEXT PRIMARY KEY, value TEXT)',
	'CREATE TABLE flood (fid INTEGER PRIMARY KEY, event TEXT)',
	'CREATE TABLE watchdog (wid INTEGER PRIMARY KEY, message TEXT)',
	'CREATE TABLE key_value (collection TEXT, name TEXT, value BLOB, PRIMARY KEY (collection, name))',
	'CREATE TABLE sequences (value INTEGER PRIMARY KEY AUTOINCREMENT)',
	'CREATE TABLE cfw_page (path TEXT PRIMARY KEY, html TEXT)'
];

let dir: string;
let db: DatabaseSync;
let sql: SqlLike;
let storage: StorageLike;
const NOW = 1_800_000_000_000;

function open(file = join(dir, 'site.db')): void {
	db = new DatabaseSync(file);
	sql = sqlOver(db);
	storage = storageOver(db);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'write-mark-'));
	open();
	for (const ddl of SCHEMA) db.exec(ddl);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

const start = (mark = 'm1', opts: { replace?: boolean; cap?: number } = {}) =>
	startMark(sql, storage, { mark, now: NOW, ...opts });
const writes = () => readMark(sql)?.writes;
const names = (type: string) =>
	(
		db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type) as {
			name: string;
		}[]
	).map((r) => r.name);

function all(through?: number, dialect: 'mysql' | 'sqlite' = 'mysql', keysPerPage = 200): string {
	const m = changeManifest(sql, through);
	const out: string[] = [];
	for (const page of changeStatements(sql, { through: m!.through, dialect, keysPerPage })) {
		out.push(...page);
	}
	return out.join('\n');
}

describe('which tables count', () => {
	it.each([
		'node',
		'node_field_data',
		'node__body',
		'users_field_data',
		'config',
		'file_managed',
		'comment_field_data',
		'webform_submission'
	])('%s counts', (table) => {
		expect(isTracked(table)).toBe(true);
	});

	it.each([
		'cache_render',
		'cache_container',
		'cachetags',
		'sessions',
		'semaphore',
		'flood',
		'queue',
		'watchdog',
		'history',
		'search_index',
		'batch',
		'sequences',
		'key_value',
		'key_value_expire',
		'router',
		'menu_tree',
		'cfw_page',
		'cfw_mark',
		'cfw_wj',
		'sqlite_sequence'
	])('%s does not count', (table) => {
		expect(isTracked(table)).toBe(false);
	});
});

describe('a site with no mark', () => {
	it('holds no trigger, no journal and no mark table', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a')");
		expect(names('trigger')).toEqual([]);
		expect(names('table')).not.toContain('cfw_mark');
		expect(names('table')).not.toContain('cfw_wj');
		expect(readMark(sql)).toBeUndefined();
	});
});

describe('starting a mark', () => {
	it('returns the same mark for the same id and never resets the count', () => {
		const first = start('m1');
		expect(first.status).toBe('started');
		db.exec("INSERT INTO node (uuid) VALUES ('a')");
		const again = start('m1');
		expect(again.status).toBe('existing');
		expect(again.mark.startedAt).toBe(first.mark.startedAt);
		expect(again.mark.writes).toBe(1);
	});

	it('refuses a different id unless replace is set', () => {
		start('m1');
		db.exec("INSERT INTO node (uuid) VALUES ('a')");
		const refused = start('m2');
		expect(refused.status).toBe('conflict');
		expect(refused.mark.mark).toBe('m1');
		expect(writes()).toBe(1);
	});

	it('replaces on request, with an empty count and an empty journal', () => {
		start('m1');
		db.exec("INSERT INTO node (uuid) VALUES ('a')");
		const replaced = start('m2', { replace: true });
		expect(replaced.status).toBe('replaced');
		expect(replaced.mark.writes).toBe(0);
		expect(db.prepare('SELECT COUNT(*) AS c FROM cfw_wj').get()).toEqual({ c: 0 });
		db.exec("INSERT INTO node (uuid) VALUES ('b')");
		expect(writes()).toBe(1);
	});

	it('installs three triggers on every tracked table and none on the others', () => {
		start();
		const triggers = names('trigger');
		expect(triggers).toContain('cfw_wt_node_i');
		expect(triggers).toContain('cfw_wt_comment_field_data_d');
		expect(triggers.some((t) => t.includes('cache_render'))).toBe(false);
		expect(triggers.some((t) => t.includes('sessions'))).toBe(false);
		expect(triggers.some((t) => t.includes('cfw_page'))).toBe(false);
		expect(triggers.length % 3).toBe(0);
	});
});

describe('the count', () => {
	beforeEach(() => void start());

	it('counts inserts, updates and deletes on authoritative tables', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a'), ('b')");
		db.exec("UPDATE node SET uuid = 'c' WHERE nid = 1");
		db.exec('DELETE FROM node WHERE nid = 2');
		expect(writes()).toBe(4);
	});

	it('does not count cache, session, semaphore, flood, watchdog, key-value or sequence rows', () => {
		db.exec("INSERT INTO cache_render VALUES ('a', x'00')");
		db.exec("INSERT INTO cachetags VALUES ('t', 1)");
		db.exec("INSERT INTO sessions VALUES ('s', x'00')");
		db.exec("INSERT INTO semaphore VALUES ('l', 'v')");
		db.exec("INSERT INTO flood (event) VALUES ('e')");
		db.exec("INSERT INTO watchdog (message) VALUES ('m')");
		db.exec("INSERT INTO key_value VALUES ('state', 'k', x'00')");
		db.exec('INSERT INTO sequences DEFAULT VALUES');
		db.exec("INSERT INTO cfw_page VALUES ('/', '<p>')");
		db.exec("UPDATE cache_render SET data = x'01'");
		db.exec('DELETE FROM sessions');
		expect(writes()).toBe(0);
		expect(db.prepare('SELECT COUNT(*) AS c FROM cfw_wj').get()).toEqual({ c: 0 });
	});

	it('counts an unlisted contrib table, so a visitor comment cannot read as no writes', () => {
		db.exec("INSERT INTO comment_field_data (body) VALUES ('hi')");
		expect(writes()).toBe(1);
	});

	it('counts a replace as one insert', () => {
		db.exec("INSERT INTO config VALUES ('a', x'01')");
		db.exec("INSERT OR REPLACE INTO config VALUES ('a', x'02')");
		expect(writes()).toBe(2);
	});

	it('counts a changed key as two writes, the old key leaving and the new one arriving', () => {
		db.exec("INSERT INTO config VALUES ('a', x'01')");
		db.exec("UPDATE config SET name = 'b' WHERE name = 'a'");
		expect(writes()).toBe(3);
		const sqlText = all();
		expect(sqlText).toContain("DELETE FROM `config` WHERE `name` = 'a';");
		expect(sqlText).toContain("REPLACE INTO `config` (`name`, `data`) VALUES ('b', x'01');");
	});

	it('does not count a statement that changes no row, or one that rolls back', () => {
		db.exec('DELETE FROM node WHERE nid = 99');
		expect(writes()).toBe(0);
		try {
			storage.transactionSync(() => {
				db.exec("INSERT INTO node (uuid) VALUES ('x')");
				throw new Error('speculative rollback');
			});
		} catch {
			// expected
		}
		expect(writes()).toBe(0);
	});

	it('survives a reopen of the storage, triggers included', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a')");
		db.close();
		open();
		expect(writes()).toBe(1);
		db.exec("INSERT INTO node (uuid) VALUES ('b')");
		expect(writes()).toBe(2);
		expect(all()).toContain('REPLACE INTO `node`');
	});
});

describe('the journal cap', () => {
	it('keeps counting past the cap and reports an incomplete export', () => {
		start('m1', { cap: 3 });
		for (let i = 0; i < 5; i++) db.exec(`INSERT INTO node (uuid) VALUES ('u${i}')`);
		expect(writes()).toBe(5);
		expect(db.prepare('SELECT COUNT(*) AS c FROM cfw_wj').get()).toEqual({ c: 3 });
		const m = changeManifest(sql)!;
		expect(m.incomplete).toBe(true);
		expect(m.reason).toBe('journal_full');
		expect(m.through).toBe(5);
		expect((all().match(/REPLACE INTO/g) ?? []).length).toBe(3);
	});

	it('defaults to a documented cap', () => {
		expect(start().mark.cap).toBe(WRITE_JOURNAL_CAP);
	});
});

describe('the export', () => {
	beforeEach(() => void start());

	it('carries inserted and updated rows whole and deleted keys, once per key', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a'), ('b'), ('c')");
		db.exec("UPDATE node SET uuid = 'a2' WHERE nid = 1");
		db.exec('DELETE FROM node WHERE nid = 3');
		const text = all();
		expect(text).toContain("REPLACE INTO `node` (`nid`, `uuid`) VALUES (1, 'a2');");
		expect(text).toContain("REPLACE INTO `node` (`nid`, `uuid`) VALUES (2, 'b');");
		expect(text).toContain('DELETE FROM `node` WHERE `nid` = 3;');
		expect((text.match(/VALUES \(1,/g) ?? []).length).toBe(1);
		expect(text.trimEnd().split('\n').at(-1)).toBe('-- end, 3 statements');
		expect(text).toContain('UPDATE sequences SET value');
	});

	it('reads a composite key', () => {
		db.exec("INSERT INTO node_field_data VALUES (7, 1, 'en', 'Hello')");
		db.exec("DELETE FROM node_field_data WHERE nid = 7 AND langcode = 'en'");
		expect(all()).toContain(
			"DELETE FROM `node_field_data` WHERE `nid` = 7 AND `langcode` = 'en';"
		);
	});

	it('spells values for the dialect', () => {
		db.exec("INSERT INTO config VALUES ('a\\b''c', x'DEADBEEF')");
		db.exec("INSERT INTO comment_field_data (body) VALUES ('line' || char(10) || 'two')");
		db.exec("INSERT INTO node_field_data VALUES (9223372036854775807, 1, 'en', NULL)");
		const mysql = all(undefined, 'mysql');
		expect(mysql).toContain("VALUES ('a\\\\b''c', x'DEADBEEF');");
		expect(mysql).toContain("'line\ntwo'");
		expect(mysql).toContain("VALUES (9223372036854775807, 1, 'en', NULL);");
		const lite = all(undefined, 'sqlite');
		expect(lite).toContain('REPLACE INTO "config"');
		expect(lite).toContain("VALUES ('a\\b''c', x'DEADBEEF');");
	});

	it('writes a control character as bytes so a line stays one statement', () => {
		expect(mysqlLiteral('text', '610062', null)).toBe("CONVERT(x'610062' USING utf8mb4)");
		expect(mysqlLiteral('real', '', Infinity)).toBe('NULL');
	});

	it('reports what it cannot carry', () => {
		db.exec("INSERT INTO file_managed (uri) VALUES ('public://a.png'), ('public://b.png')");
		const m = changeManifest(sql)!;
		expect(m.cannotCarry).toContain('sessions');
		expect(m.cannotCarry).toContain('settings and state kept in key-value storage');
		expect(m.cannotCarry).toContain('the bytes of 2 new, replaced or removed files');
		expect(m.keys['file_managed']).toBe(2);
		expect(m.incomplete).toBe(false);
	});

	it('names a table with no key, counted but not exported', () => {
		db.exec('CREATE TABLE history_note (a TEXT, b TEXT)');
		const state: MarkState = { active: true };
		const hooked: SqlLike = countingSql(
			sql,
			() => undefined,
			undefined,
			markSchemaHook(() => hooked, state)
		);
		hooked.exec('CREATE TABLE loose (a TEXT, b TEXT)');
		hooked.exec("INSERT INTO loose VALUES ('x', 'y')");
		const m = changeManifest(sql)!;
		expect(m.cannotCarry).toContain('rows in loose, which has no key to export by');
		expect(all()).not.toContain('REPLACE INTO `loose`');
		expect(writes()).toBeGreaterThanOrEqual(2);
	});

	it('leaves the triggers, the journal and the mark out of a dump', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a')");
		changeManifest(sql);
		const dump = dumpDatabase(sql).sql;
		expect(dump).not.toContain('cfw_mark');
		expect(dump).not.toContain('cfw_wj');
		expect(dump).not.toContain('cfw_wt_');
	});
});

describe('a write while the export runs', () => {
	beforeEach(() => void start());

	it('stops at the write the count had reached, and agrees with it', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a'), ('b'), ('c')");
		const manifest = changeManifest(sql)!;
		expect(manifest.through).toBe(3);

		const steps = changeStatements(sql, {
			through: manifest.through,
			dialect: 'mysql',
			keysPerPage: 1
		});
		const out: string[] = [...steps.next().value!];
		out.push(...steps.next().value!);
		// lands between two pages: a new row, and a newer value for a row the export already holds
		db.exec("INSERT INTO node (uuid) VALUES ('late')");
		db.exec("UPDATE node SET uuid = 'a-late' WHERE nid = 1");
		for (const page of steps) out.push(...page);
		const text = out.join('\n');

		expect(text).not.toContain("'late'");
		expect(text).toContain("VALUES (2, 'b')");
		expect(text).toContain("VALUES (3, 'c')");
		expect(writes()).toBe(5);
		// a key first changed after the mark point reads in the next export, with its own count
		expect(changeManifest(sql)!.through).toBe(5);
		expect(all()).toContain("'late'");
	});

	it('shows a row changed again after the point once, with its newer values', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a')");
		const m = changeManifest(sql)!;
		db.exec("UPDATE node SET uuid = 'newer' WHERE nid = 1");
		const text = all(m.through);
		expect((text.match(/REPLACE INTO/g) ?? []).length).toBe(1);
		expect(text).toContain("(1, 'newer')");
	});

	it('turns a row deleted after the point into a delete', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a')");
		const m = changeManifest(sql)!;
		db.exec('DELETE FROM node WHERE nid = 1');
		expect(all(m.through)).toContain('DELETE FROM `node` WHERE `nid` = 1;');
	});
});

describe('table-level statements while a mark is active', () => {
	let hooked: SqlLike;

	beforeEach(() => {
		start();
		const state: MarkState = {};
		hooked = countingSql(
			sql,
			() => undefined,
			undefined,
			markSchemaHook(() => hooked, state)
		);
	});

	it('recognises the statements it reacts to and ignores the rest', () => {
		expect(schemaChange('CREATE TABLE IF NOT EXISTS "node__x" (a)')).toEqual({
			verb: 'create',
			table: 'node__x'
		});
		expect(schemaChange(' drop table node')).toEqual({ verb: 'drop', table: 'node' });
		expect(schemaChange('ALTER TABLE node ADD COLUMN x')).toEqual({
			verb: 'alter',
			table: 'node'
		});
		expect(schemaChange('CREATE TEMP TABLE t (a)')).toBeUndefined();
		expect(schemaChange('DELETE FROM node')).toBeUndefined();
		expect(schemaChange('INSERT INTO node VALUES (1)')).toBeUndefined();
	});

	it('puts triggers on a table created after the start', () => {
		hooked.exec(
			'CREATE TABLE node__field_tags (entity_id INTEGER, delta INTEGER, PRIMARY KEY (entity_id, delta))'
		);
		hooked.exec('INSERT INTO node__field_tags VALUES (1, 0)');
		// one for the table, one for the row
		expect(writes()).toBe(2);
		expect(names('trigger')).toContain('cfw_wt_node__field_tags_i');
	});

	it('lets a column be dropped from a table whose key a trigger names, then restores them', () => {
		hooked.exec('ALTER TABLE node_field_data DROP COLUMN title');
		hooked.exec("INSERT INTO node_field_data VALUES (1, 1, 'en')");
		expect(names('trigger')).toContain('cfw_wt_node_field_data_u');
		expect(writes()).toBe(2);
	});

	it('restores the triggers when the statement fails', () => {
		expect(() => hooked.exec('ALTER TABLE node ADD COLUMN nid INTEGER')).toThrow();
		expect(names('trigger')).toContain('cfw_wt_node_i');
		db.exec("INSERT INTO node (uuid) VALUES ('a')");
		expect(writes()).toBeGreaterThanOrEqual(2);
	});

	it('counts a dropped authoritative table, so a removal never reads as zero writes', () => {
		hooked.exec('DROP TABLE comment_field_data');
		expect(writes()).toBe(1);
		expect(changeManifest(sql)!.cannotCarry).toContain(
			'structure changes to comment_field_data'
		);
	});

	it('keeps counting after the tables are rebuilt the way a restore rebuilds them', () => {
		hooked.exec('DROP TABLE IF EXISTS node');
		hooked.exec('CREATE TABLE node (nid INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT)');
		hooked.exec("INSERT INTO node (uuid) VALUES ('restored')");
		expect(writes()).toBe(3);
	});
});

describe('ending a mark', () => {
	it('removes the triggers, the journal and the mark, and writes still work', () => {
		start();
		db.exec("INSERT INTO node (uuid) VALUES ('a')");
		endMark(sql, storage);
		expect(names('trigger')).toEqual([]);
		expect(names('table')).not.toContain('cfw_mark');
		expect(names('table')).not.toContain('cfw_wj');
		db.exec("INSERT INTO node (uuid) VALUES ('b')");
		expect(readMark(sql)).toBeUndefined();
	});
});

describe('a change list after a point', () => {
	beforeEach(() => void start());

	function since(from: number, through?: number, keysPerPage = 200): string {
		const m = changeManifest(sql, through, from)!;
		const out: string[] = [];
		for (const page of changeStatements(sql, {
			through: m.through,
			since: from,
			dialect: 'mysql',
			keysPerPage
		})) {
			out.push(...page);
		}
		return out.join('\n');
	}

	it('carries only the keys written after the point, and says where it starts', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a'), ('b')");
		const first = changeManifest(sql)!;
		db.exec("INSERT INTO node (uuid) VALUES ('c')");
		db.exec("INSERT INTO comment_field_data (body) VALUES ('hi')");
		const text = since(first.through);
		expect(text.split('\n')[0]).toBe(
			`-- changes after write ${first.through} through write 4, mysql`
		);
		expect(text).toContain("VALUES (3, 'c')");
		expect(text).toContain('comment_field_data');
		expect(text).not.toContain("VALUES (1, 'a')");
		expect(text).not.toContain("VALUES (2, 'b')");
		expect(text.trimEnd().split('\n').at(-1)).toBe('-- end, 2 statements');
		expect(changeManifest(sql, undefined, first.through)).toMatchObject({
			since: first.through,
			through: 4,
			keys: { node: 1, comment_field_data: 1 }
		});
	});

	it('carries a key written before and after the point once, with its newer values', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a')");
		const first = changeManifest(sql)!;
		db.exec("UPDATE node SET uuid = 'newer' WHERE nid = 1");
		const text = since(first.through);
		expect((text.match(/REPLACE INTO/g) ?? []).length).toBe(1);
		expect(text).toContain("(1, 'newer')");
	});

	it('holds only the closing line when nothing was written after the point', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a')");
		const first = changeManifest(sql)!;
		const text = since(first.through);
		expect(text.trimEnd().split('\n').at(-1)).toBe('-- end, 0 statements');
		expect(text).not.toContain('REPLACE INTO');
		expect(changeManifest(sql, undefined, first.through)).toMatchObject({ keys: {} });
	});

	it('together with the first read reaches every write, whichever page a write lands between', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a'), ('b')");
		const first = changeManifest(sql)!;
		const firstText = all(first.through);
		db.exec("UPDATE node SET uuid = 'b2' WHERE nid = 2");
		db.exec("INSERT INTO node (uuid) VALUES ('c')");
		db.exec('DELETE FROM node WHERE nid = 1');
		const second = since(first.through, undefined, 1);
		const replica = new DatabaseSync(':memory:');
		replica.exec('CREATE TABLE node (nid INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT)');
		for (const part of [firstText, second]) {
			for (const line of part.split('\n')) {
				if (line.startsWith('REPLACE') || line.startsWith('DELETE')) {
					replica.exec(line.replace(/`/g, '"'));
				}
			}
		}
		expect(replica.prepare('SELECT nid, uuid FROM node ORDER BY nid').all()).toEqual(
			db.prepare('SELECT nid, uuid FROM node ORDER BY nid').all()
		);
		replica.close();
	});

	it('reads the same window twice to the same text, with its own header and closing line', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a'), ('b'), ('c'), ('d')");
		const window = since(1, 3);
		expect(since(1, 3)).toBe(window);
		expect(window.split('\n')[0]).toBe('-- changes after write 1 through write 3, mysql');
		expect(window).toContain("VALUES (2, 'b')");
		expect(window).toContain("VALUES (3, 'c')");
		expect(window).not.toContain("VALUES (1, 'a')");
		expect(window).not.toContain("VALUES (4, 'd')");
		expect(window.trimEnd().split('\n').at(-1)).toBe('-- end, 2 statements');
	});

	it('is read in contiguous windows that cover every write, in order, and replay to the same rows', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a'), ('b'), ('c'), ('d'), ('e')");
		db.exec("UPDATE node SET uuid = 'b2' WHERE nid = 2");
		db.exec('DELETE FROM node WHERE nid = 4');
		db.exec("INSERT INTO node (uuid) VALUES ('f')");
		const total = changeManifest(sql)!.through;
		expect(total).toBe(8);
		const replica = new DatabaseSync(':memory:');
		replica.exec('CREATE TABLE node (nid INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT)');
		const edges: [number, number][] = [];
		let counted = 0;
		for (let from = 0; from < total; from += 3) {
			const through = Math.min(from + 3, total);
			edges.push([from, through]);
			const text = from === 0 ? all(through, 'mysql', 1) : since(from, through, 1);
			expect(changeManifest(sql, through, from)).toMatchObject({ since: from, through });
			counted += Number(/-- end, (\d+) statements?$/.exec(text.trimEnd())![1]);
			for (const line of text.split('\n')) {
				if (line.startsWith('REPLACE') || line.startsWith('DELETE')) {
					replica.exec(line.replace(/`/g, '"'));
				}
			}
		}
		expect(edges).toEqual([
			[0, 3],
			[3, 6],
			[6, 8]
		]);
		expect(counted).toBeGreaterThanOrEqual(5);
		expect(replica.prepare('SELECT nid, uuid FROM node ORDER BY nid').all()).toEqual(
			db.prepare('SELECT nid, uuid FROM node ORDER BY nid').all()
		);
		replica.close();
	});

	it('clamps a window that reaches past the last write to that write', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a'), ('b')");
		expect(changeManifest(sql, 99, 1)).toMatchObject({ since: 1, through: 2 });
	});

	it('leaves a read with no since exactly as it was', () => {
		db.exec("INSERT INTO node (uuid) VALUES ('a')");
		expect(all().split('\n')[0]).toBe('-- changes through write 1, mysql');
		expect(changeManifest(sql)).toMatchObject({ since: 0 });
	});
});

describe('a restore that opens the mark with its last chunk', () => {
	const DUMP = [
		'DROP TABLE IF EXISTS node;',
		'CREATE TABLE node (nid INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT);',
		"INSERT INTO node (nid, uuid) VALUES (1, 'a');",
		"INSERT INTO node (nid, uuid) VALUES (2, 'b');"
	].join('\n');

	function apply(
		dump: string,
		opts: { label?: string; mark?: string; perChunk?: number; whenDone?: () => void } = {}
	) {
		const label = opts.label ?? 'promote-1';
		const stored = storeImport(sql, dump, {
			storage,
			generation: label,
			source: 'test',
			nowMs: NOW,
			perChunk: opts.perChunk ?? 1
		});
		if (opts.mark !== undefined) noteRestoreMark(sql, label, opts.mark);
		const asked = readRestoreMark(sql, label);
		const migrator = new SqlMigrator({
			sql,
			storage,
			now: () => NOW,
			...storedImportLoader(sql, stored.id)
		});
		const seen: (number | undefined)[] = [];
		const run = async (maxChunks: number) => {
			const out = await migrator.step({
				maxChunks,
				onLastChunk:
					asked === undefined
						? undefined
						: () => {
								openRestoreMark(sql, { generation: label, mark: asked, now: NOW });
							}
			});
			try {
				seen.push(readMark(sql)?.writes);
			} catch {
				seen.push(undefined);
			}
			return out;
		};
		return { run, seen, stored };
	}

	it('counts nothing for the restore and everything a visitor writes after it', async () => {
		const { run, seen } = apply(DUMP, { mark: 'cutover-op1' });
		await run(Infinity);
		expect(db.prepare('SELECT COUNT(*) AS c FROM node').get()).toEqual({ c: 2 });
		expect(readMark(sql)).toMatchObject({ mark: 'cutover-op1', writes: 0, broken: false });
		expect(seen).toEqual([0]);
		expect(names('trigger')).toContain('cfw_wt_node_i');
		db.exec("INSERT INTO node (uuid) VALUES ('visitor')");
		expect(writes()).toBe(1);
		expect(readMigrateCursor(sql)).toMatchObject({ state: 'done' });
		expect(readRestoreMark(sql, 'promote-1')).toBeUndefined();
	});

	it('opens no mark until the last chunk, however many calls the restore takes', async () => {
		const { run, seen } = apply(DUMP, { mark: 'cutover-op1', perChunk: 1 });
		await run(1);
		await run(1);
		expect(seen).toEqual([undefined, undefined]);
		await run(1);
		expect(seen).toEqual([undefined, undefined, undefined]);
		await run(1);
		expect(seen.at(-1)).toBe(0);
		expect(readMigrateCursor(sql)).toMatchObject({ state: 'done' });
	});

	it('behaves as before when no mark was asked for', async () => {
		const { run } = apply(DUMP);
		await run(Infinity);
		expect(readMark(sql)).toBeUndefined();
		expect(names('table')).not.toContain('cfw_mark');
		expect(names('table')).not.toContain('cfw_restore_mark');
		expect(names('trigger')).toEqual([]);
	});

	it('does not reset a running tally when the same mark is opened again', async () => {
		const { run } = apply(DUMP, { mark: 'cutover-op1' });
		await run(Infinity);
		db.exec("INSERT INTO node (uuid) VALUES ('visitor')");
		db.exec("INSERT INTO node (uuid) VALUES ('another')");
		expect(writes()).toBe(2);
		openRestoreMark(sql, { generation: 'promote-1', mark: 'cutover-op1', now: NOW + 5 });
		expect(readMark(sql)).toMatchObject({ writes: 2, startedAt: NOW });
		expect(start('cutover-op1')).toMatchObject({ status: 'existing' });
		expect(writes()).toBe(2);
	});

	it('leaves a different mark that is already running alone, and still applies the restore', async () => {
		start('other');
		db.exec("INSERT INTO node (uuid) VALUES ('x')");
		const { run } = apply(DUMP, { mark: 'cutover-op1' });
		await run(Infinity);
		expect(readMark(sql)).toMatchObject({ mark: 'other' });
		expect(readMigrateCursor(sql)).toMatchObject({ state: 'done' });
		expect(db.prepare('SELECT COUNT(*) AS c FROM node').get()).toEqual({ c: 2 });
		expect(readRestoreMark(sql, 'promote-1')).toBeUndefined();
	});

	it('does not fail the restore when the mark cannot be opened', async () => {
		db.exec('CREATE TABLE cfw_mark (id INTEGER PRIMARY KEY, wrong TEXT)');
		const { run } = apply(DUMP, { mark: 'cutover-op1' });
		await run(Infinity);
		expect(readMigrateCursor(sql)).toMatchObject({ state: 'done', error: null });
		expect(db.prepare('SELECT COUNT(*) AS c FROM node').get()).toEqual({ c: 2 });
	});

	it('opens no mark when the last chunk fails, and opens it on the retry', async () => {
		const bad = [DUMP, 'INSERT INTO missing_table VALUES (1);'].join('\n');
		const { run } = apply(bad, { mark: 'cutover-op1', perChunk: 1 });
		await expect(run(Infinity)).rejects.toThrow();
		expect(readMark(sql)).toBeUndefined();
		expect(names('table')).not.toContain('cfw_mark');
		expect(readRestoreMark(sql, 'promote-1')).toBe('cutover-op1');
		expect(readMigrateCursor(sql)).toMatchObject({ state: 'failed' });
	});

	it('leaves the noted mark out of a dump', async () => {
		noteRestoreMark(sql, 'promote-9', 'cutover-op9');
		expect(dumpDatabase(sql).sql).not.toContain('cfw_restore_mark');
	});
});
