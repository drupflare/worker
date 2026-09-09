import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	enqueueSweep,
	enumerateAddressable,
	readCovered,
	readSweepCursor,
	writeSweepCursor,
	type SweepSql
} from '../../src/ops/sweep';
import { SHIPPED } from '../helpers/shipped-ddl';

/**
 * The enumeration against real SQLite and the real column shapes.
 *
 * The workers-lane spec drives the same calls over a stand-in, which cannot fail on SQL that does
 * not parse or on a column Drupal does not have. The DDL below is lifted verbatim out of
 * `assets/drupal-sql/*.json` for the same reason `tests/helpers/shipped-ddl.ts` is: a plausible
 * schema would make this spec an assertion about the fixture.
 */

const ENTITY_DDL = [
	`CREATE TABLE "node_field_data" (
"nid" INTEGER NOT NULL CHECK ("nid">= 0),
"vid" INTEGER NOT NULL CHECK ("vid">= 0),
"type" VARCHAR(32) NOT NULL,
"langcode" VARCHAR(12) NOT NULL,
"status" INTEGER NOT NULL,
"uid" INTEGER NOT NULL CHECK ("uid">= 0),
"title" VARCHAR(255) COLLATE NOCASE NOT NULL,
"created" INTEGER NOT NULL,
"changed" INTEGER NOT NULL,
"promote" INTEGER NOT NULL,
"sticky" INTEGER NOT NULL,
"default_langcode" INTEGER NOT NULL,
"revision_translation_affected" INTEGER NULL DEFAULT NULL,
 PRIMARY KEY ("nid", "langcode")
)`,
	`CREATE TABLE "taxonomy_term_field_data" (
"tid" INTEGER NOT NULL CHECK ("tid">= 0),
"revision_id" INTEGER NOT NULL CHECK ("revision_id">= 0),
"vid" VARCHAR(32) NOT NULL,
"langcode" VARCHAR(12) NOT NULL,
"status" INTEGER NOT NULL,
"name" VARCHAR(255) COLLATE NOCASE NOT NULL,
"description__value" TEXT NULL DEFAULT NULL,
"description__format" VARCHAR(255) NULL DEFAULT NULL,
"weight" INTEGER NOT NULL,
"changed" INTEGER NULL DEFAULT NULL,
"default_langcode" INTEGER NOT NULL,
"revision_translation_affected" INTEGER NULL DEFAULT NULL,
 PRIMARY KEY ("tid", "langcode")
)`,
	`CREATE TABLE "users_field_data" (
"uid" INTEGER NOT NULL CHECK ("uid">= 0),
"langcode" VARCHAR(12) NOT NULL,
"preferred_langcode" VARCHAR(12) NULL DEFAULT NULL,
"preferred_admin_langcode" VARCHAR(12) NULL DEFAULT NULL,
"name" VARCHAR(60) COLLATE NOCASE NOT NULL,
"pass" VARCHAR(255) COLLATE NOCASE NULL DEFAULT NULL,
"mail" VARCHAR(254) NULL DEFAULT NULL,
"timezone" VARCHAR(32) COLLATE NOCASE NULL DEFAULT NULL,
"status" INTEGER NULL DEFAULT NULL,
"created" INTEGER NOT NULL,
"changed" INTEGER NULL DEFAULT NULL,
"access" INTEGER NOT NULL,
"login" INTEGER NULL DEFAULT NULL,
"init" VARCHAR(254) NULL DEFAULT NULL,
"default_langcode" INTEGER NOT NULL,
 PRIMARY KEY ("uid", "langcode")
)`,
	`CREATE TABLE "path_alias" (
"id" INTEGER PRIMARY KEY AUTOINCREMENT CHECK ("id">= 0),
"revision_id" INTEGER NULL CHECK ("revision_id">= 0) DEFAULT NULL,
"uuid" VARCHAR(128) COLLATE NOCASE NOT NULL,
"langcode" VARCHAR(12) NOT NULL,
"path" VARCHAR(255) COLLATE NOCASE NULL DEFAULT NULL,
"alias" VARCHAR(255) COLLATE NOCASE NULL DEFAULT NULL,
"status" INTEGER NOT NULL
)`,
	'CREATE TABLE cfw_page (path TEXT PRIMARY KEY, html TEXT NOT NULL) WITHOUT ROWID',
	'CREATE TABLE cfw_fill_queue (path TEXT PRIMARY KEY, queued_at INTEGER NOT NULL) WITHOUT ROWID',
	'CREATE TABLE cfw_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID'
];

/** the `exec(text, ...params)` shape over a node handle, as `tests/node/module-rev.spec.ts` does */
function open(ddl: string[]): SweepSql & { db: DatabaseSync; close(): void } {
	const db = new DatabaseSync(':memory:');
	for (const statement of ddl) db.exec(statement);
	return {
		db,
		exec(sql: string, ...bindings: unknown[]) {
			const statement = db.prepare(sql);
			if (!/^\s*(SELECT|PRAGMA)/i.test(sql)) {
				statement.run(...(bindings as never[]));
				return { toArray: () => [] };
			}
			const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
			return { toArray: () => rows };
		},
		close: () => db.close()
	};
}

function seeded() {
	const sql = open([...SHIPPED.router!.ddl, ...ENTITY_DDL]);
	const route = (name: string, path: string) =>
		sql.db
			.prepare(
				'INSERT INTO router (name, path, pattern_outline, fit, route, number_parts) VALUES (?, ?, ?, 0, NULL, 0)'
			)
			.run(name, path, path);
	route('front', '/');
	route('contact', '/contact');
	route('node.canonical', '/node/{node}');
	route('node.edit', '/node/{node}/edit');
	route('admin.content', '/admin/content');
	route('user.login', '/user/login');
	route('view.frontpage.page_1', '/node');

	const node = (nid: number, changed: number, status: number) =>
		sql.db
			.prepare(
				`INSERT INTO node_field_data
				 (nid, vid, type, langcode, status, uid, title, created, changed, promote, sticky, default_langcode)
				 VALUES (?, ?, 'page', 'en', ?, 1, 't', 0, ?, 0, 0, 1)`
			)
			.run(nid, nid, status, changed);
	node(1, 1_700_000_000, 1);
	node(2, 1_700_000_100, 1);
	node(3, 1_700_000_200, 0);

	sql.db
		.prepare(
			`INSERT INTO taxonomy_term_field_data
			 (tid, revision_id, vid, langcode, status, name, weight, changed, default_langcode)
			 VALUES (4, 4, 'tags', 'en', 1, 'Tag', 0, NULL, 1)`
		)
		.run();

	const user = (uid: number, status: number | null) =>
		sql.db
			.prepare(
				`INSERT INTO users_field_data
				 (uid, langcode, name, status, created, changed, access, default_langcode)
				 VALUES (?, 'en', 'u' || ?, ?, 0, 1, 0, 1)`
			)
			.run(uid, uid, status);
	user(0, 1);
	user(1, 1);
	user(2, null);

	sql.db
		.prepare(
			"INSERT INTO path_alias (revision_id, uuid, langcode, path, alias, status) VALUES (1, 'u', 'en', ?, ?, ?)"
		)
		.run('/node/2', '/about', 1);
	sql.db
		.prepare(
			"INSERT INTO path_alias (revision_id, uuid, langcode, path, alias, status) VALUES (2, 'v', 'en', ?, ?, ?)"
		)
		.run('/node/1', '/draft-alias', 0);
	return sql;
}

describe('enumerateAddressable against real SQLite', () => {
	it('builds the addressable space from the router and the entity tables', () => {
		const sql = seeded();
		try {
			const paths = enumerateAddressable(sql).map((c) => c.path);
			expect(paths).toEqual(
				expect.arrayContaining(['/', '/contact', '/node', '/node/1', '/taxonomy/term/4'])
			);
		} finally {
			sql.close();
		}
	});

	it('substitutes a published alias and ignores an unpublished one', () => {
		const sql = seeded();
		try {
			const paths = enumerateAddressable(sql).map((c) => c.path);
			expect(paths).toContain('/about');
			expect(paths).not.toContain('/node/2');
			// status 0, so the system path is what a visitor asks for
			expect(paths).toContain('/node/1');
			expect(paths).not.toContain('/draft-alias');
		} finally {
			sql.close();
		}
	});

	it('produces no pager, facet or placeholder URL', () => {
		const sql = seeded();
		try {
			for (const { path } of enumerateAddressable(sql)) {
				expect(path).not.toMatch(/[?#&{}]/);
			}
		} finally {
			sql.close();
		}
	});

	it('drops the admin routes, the entity operations and the login form', () => {
		const sql = seeded();
		try {
			const paths = enumerateAddressable(sql).map((c) => c.path);
			expect(paths).not.toContain('/admin/content');
			expect(paths).not.toContain('/user/login');
			expect(paths).not.toContain('/node/3');
			// uid 0 is anonymous and uid 2 has a NULL status, so neither is a profile to render
			expect(paths).not.toContain('/user/0');
			expect(paths).not.toContain('/user/2');
			expect(paths).toContain('/user/1');
		} finally {
			sql.close();
		}
	});

	it('reads a NULL entity clock as no recency rather than as 1970 in milliseconds', () => {
		const sql = seeded();
		try {
			const term = enumerateAddressable(sql).find((c) => c.path === '/taxonomy/term/4');
			expect(term?.changedMs).toBe(0);
			const node = enumerateAddressable(sql).find((c) => c.path === '/node/1');
			expect(node?.changedMs).toBe(1_700_000_000_000);
		} finally {
			sql.close();
		}
	});

	it('enumerates a site whose tables are absent instead of throwing', () => {
		const sql = open(['CREATE TABLE cfw_page (path TEXT PRIMARY KEY) WITHOUT ROWID']);
		try {
			expect(enumerateAddressable(sql)).toEqual([]);
			expect(readCovered(sql).queued.size).toBe(0);
		} finally {
			sql.close();
		}
	});
});

describe('the queue and the cursor against real SQLite', () => {
	it('inserts a queue row once, so a repeat is not a second row', () => {
		const sql = seeded();
		try {
			enqueueSweep(sql, ['/a', '/b'], 5);
			enqueueSweep(sql, ['/a'], 9);
			expect(readCovered(sql).queued).toEqual(new Set(['/a', '/b']));
			const held = sql.db
				.prepare('SELECT queued_at FROM cfw_fill_queue WHERE path = ?')
				.get('/a');
			expect(Number((held as Record<string, unknown>).queued_at)).toBe(5);
		} finally {
			sql.close();
		}
	});

	it('round-trips the cursor through cfw_meta', () => {
		const sql = seeded();
		try {
			const now = Date.parse('2026-09-08T10:00:00Z');
			writeSweepCursor(sql, {
				day: '2026-09-08',
				rowsSpent: 320,
				doSpent: 2,
				pages: 20,
				generation: 7,
				lastRunMs: now,
				done: false
			});
			// upserted rather than duplicated
			writeSweepCursor(sql, {
				day: '2026-09-08',
				rowsSpent: 640,
				doSpent: 4,
				pages: 40,
				generation: 7,
				lastRunMs: now,
				done: false
			});
			const rows = sql.db.prepare('SELECT COUNT(*) AS c FROM cfw_meta').get() as Record<
				string,
				unknown
			>;
			expect(Number(rows.c)).toBe(1);
			expect(readSweepCursor(sql, now, 7).rowsSpent).toBe(640);
		} finally {
			sql.close();
		}
	});
});
