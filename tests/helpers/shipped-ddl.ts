/**
 * DDL lifted verbatim out of `assets/drupal-sql/*.json`, for the specs that need the REAL schema
 * shapes rather than a plausible one.
 *
 * Two suites need the same strings and they cannot share a lane: the charge model has to be measured
 * against real Durable Object SQL, which only workerd provides, and the pack it came from can only be
 * read from a filesystem, which only the node lane has. So the DDL is written down once here, the
 * workers lane measures it, and `tests/node/index-audit.spec.ts` asserts the pack still parses to the
 * same shape -- an index added upstream fails there rather than silently invalidating a factor.
 *
 * Not a `.spec.ts`, so vitest does not collect it, and `tests/**` is excluded from coverage.
 */

/** one table as it ships: the CREATE TABLE, then every CREATE INDEX on it */
export type ShippedTable = { table: string; ddl: string[] };

/**
 * The shapes that decide the charge model, one per distinct primary-key form in the pack.
 *
 * `cache_dynamic_page_cache` is here because it is the subject: a fill's largest single row-writer.
 * The rest exist to make the model falsifiable at its edges -- a rowid key that stores no index, an
 * AUTOINCREMENT key that also touches `sqlite_sequence`, a composite key, a UNIQUE index, and a
 * table with no secondary index at all.
 */
export const SHIPPED: Record<string, ShippedTable> = {
	cacheDynamicPageCache: {
		table: 'cache_dynamic_page_cache',
		ddl: [
			`CREATE TABLE "cache_dynamic_page_cache" (
"cid" VARCHAR(255) NOT NULL DEFAULT '',
"data" BLOB NULL DEFAULT NULL,
"expire" INTEGER NOT NULL DEFAULT 0,
"created" FLOAT NOT NULL DEFAULT 0,
"serialized" INTEGER NOT NULL DEFAULT 0,
"tags" TEXT NULL DEFAULT NULL,
"checksum" VARCHAR(255) NOT NULL,
 PRIMARY KEY ("cid")
)`
			// no secondary indexes: CfwCacheBackend drops expire and created on every bin except
			// cache_data, which is the only one the host garbage-collects
		]
	},
	cachePage: {
		table: 'cache_page',
		ddl: [
			`CREATE TABLE "cache_page" (
"cid" VARCHAR(255) NOT NULL DEFAULT '',
"data" BLOB NULL DEFAULT NULL,
"expire" INTEGER NOT NULL DEFAULT 0,
"created" FLOAT NOT NULL DEFAULT 0,
"serialized" INTEGER NOT NULL DEFAULT 0,
"tags" TEXT NULL DEFAULT NULL,
"checksum" VARCHAR(255) NOT NULL,
 PRIMARY KEY ("cid")
)`
		]
	},
	watchdog: {
		table: 'watchdog',
		ddl: [
			`CREATE TABLE "watchdog" (
"wid" INTEGER PRIMARY KEY AUTOINCREMENT,
"uid" INTEGER NOT NULL CHECK ("uid">= 0) DEFAULT 0,
"type" VARCHAR(64) NOT NULL DEFAULT '',
"message" TEXT NOT NULL,
"variables" BLOB NOT NULL,
"severity" INTEGER NOT NULL CHECK ("severity">= 0) DEFAULT 0,
"link" TEXT NULL DEFAULT NULL,
"location" TEXT NOT NULL,
"referer" TEXT NULL DEFAULT NULL,
"hostname" VARCHAR(128) NOT NULL DEFAULT '',
"timestamp" INTEGER NOT NULL DEFAULT 0
)`,
			`CREATE INDEX "watchdog_severity" ON "watchdog" ("severity")`,
			`CREATE INDEX "watchdog_type" ON "watchdog" ("type")`,
			`CREATE INDEX "watchdog_uid" ON "watchdog" ("uid")`
		]
	},
	keyValue: {
		table: 'key_value',
		ddl: [
			`CREATE TABLE "key_value" (
"collection" VARCHAR(128) NOT NULL DEFAULT '',
"name" VARCHAR(128) NOT NULL DEFAULT '',
"value" BLOB NOT NULL,
 PRIMARY KEY ("collection", "name")
)`
		]
	},
	router: {
		table: 'router',
		ddl: [
			`CREATE TABLE "router" (
"name" VARCHAR(255) NOT NULL DEFAULT '',
"path" VARCHAR(255) NOT NULL DEFAULT '',
"pattern_outline" VARCHAR(255) NOT NULL DEFAULT '',
"fit" INTEGER NOT NULL DEFAULT 0,
"route" BLOB DEFAULT NULL,
"number_parts" INTEGER NOT NULL DEFAULT 0,
"alias" VARCHAR(255) DEFAULT NULL,
 PRIMARY KEY ("name")
)`,
			`CREATE INDEX "router_pattern_outline_parts" ON "router" ("pattern_outline", "number_parts")`,
			// partial: 402 of 419 routes store a NULL alias and pay nothing for this index.
			// `CfwMatcherDumper::ensurePartialAliasIndex()` is what puts it in this form
			`CREATE INDEX "router_alias" ON "router" ("alias") WHERE "alias" IS NOT NULL`
		]
	},
	cachetags: {
		table: 'cachetags',
		ddl: [
			`CREATE TABLE "cachetags" (
"tag" VARCHAR(255) NOT NULL DEFAULT '',
"invalidations" INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY ("tag")
)`
		]
	},
	usersFieldData: {
		table: 'users_field_data',
		ddl: [
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
			`CREATE INDEX "users_field_data_user__id__default_langcode__langcode" ON "users_field_data" ("uid", "default_langcode", "langcode")`,
			`CREATE UNIQUE INDEX "users_field_data_user__name" ON "users_field_data" ("name", "langcode")`,
			`CREATE INDEX "users_field_data_user_field__access" ON "users_field_data" ("access")`,
			`CREATE INDEX "users_field_data_user_field__created" ON "users_field_data" ("created")`,
			`CREATE INDEX "users_field_data_user_field__mail" ON "users_field_data" ("mail")`
		]
	}
};

/** the host's own serve table, which stores the rendered page (`src/site-do.ts:1695`) */
export const CFW_PAGE_DDL = `CREATE TABLE cfw_page (
        path TEXT PRIMARY KEY,
        status INTEGER NOT NULL,
        content_type TEXT,
        html TEXT NOT NULL,
        rendered_at INTEGER NOT NULL,
        render_ms REAL
      )`;
