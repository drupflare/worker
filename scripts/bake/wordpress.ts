import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { dropInMissing, prepareSite, runPhp } from '../wp/harness';
import { startHost } from '../wp/host';
import { installStatistics, modelStatistics } from '../wp/planner-stats';

/**
 * Bakes the WordPress database the pack ships: WordPress's own installer runs through the MySQL
 * translator onto a SQLite file, the file is scrubbed and stamped, and `pack/sql.ts` cuts it into
 * the chunks a site replays.
 *
 *   bun scripts/bake/wordpress.ts [--work=<dir>] [--out=<dir>] [--keep-db=<file>]
 *
 * Nothing secret is baked. The installer needs an administrator password and the config needs eight
 * salts; both are random per bake and neither is stored: the password hash is replaced with an
 * unusable value and the leak scan fails the bake if either string is found in any column. The site
 * owner's credential is created at provisioning.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');

/** the origin every baked row names; provisioning replaces `siteurl` and `home` with the real one */
export const PLACEHOLDER_ORIGIN = 'http://wordpress.invalid';

/** the one time every baked row carries: 2026-01-01 00:00:00 UTC, so two bakes agree */
export const STAMP = { text: '2026-01-01 00:00:00', epoch: 1_767_225_600 } as const;

/** `admin_email_lifespan` is the install time plus six 30-day months */
const ADMIN_EMAIL_LIFESPAN = 6 * 30 * 86_400;

/** the value that can never match a password hash, so the baked administrator cannot sign in */
export const UNUSABLE_PASSWORD = '!';

/** the title and administrator address the installer is given; neither is a credential */
export const BAKED_TITLE = 'WordPress Site';
export const BAKED_EMAIL = 'admin@wordpress.invalid';

/** statements that make a baked database independent of the minute it was baked in and of its password */
export function scrubStatements(prefix = 'wp_'): string[] {
	const t = (name: string) => `${prefix}${name}`;
	const at = `'${STAMP.text}'`;
	return [
		`UPDATE ${t('posts')} SET post_date = ${at}, post_date_gmt = ${at}, post_modified = ${at}, post_modified_gmt = ${at}`,
		`UPDATE ${t('comments')} SET comment_date = ${at}, comment_date_gmt = ${at}`,
		`UPDATE ${t('users')} SET user_registered = ${at}, user_pass = '${UNUSABLE_PASSWORD}', user_activation_key = ''`,
		`UPDATE ${t('options')} SET option_value = '${STAMP.epoch + ADMIN_EMAIL_LIFESPAN}' WHERE option_name = 'admin_email_lifespan'`,
		`DELETE FROM ${t('options')} WHERE option_name LIKE '\\_transient\\_%' ESCAPE '\\' OR option_name LIKE '\\_site\\_transient\\_%' ESCAPE '\\'`
	];
}

/** one text column a string was found in */
export interface Hit {
	table: string;
	column: string;
	rows: number;
}

/** every column of every table whose text contains `needle`; the translator's own catalogue is skipped */
export function findHits(db: DatabaseSync, needle: string): Hit[] {
	const hits: Hit[] = [];
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
		.all() as { name: string }[];
	for (const { name } of tables) {
		if (name === 'cfw_mysql_schema') continue;
		const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
		for (const c of columns) {
			const row = db
				.prepare(
					`SELECT count(*) AS n FROM "${name}" WHERE instr(CAST("${c.name}" AS TEXT), ?) > 0`
				)
				.get(needle) as { n: number };
			if (row.n > 0) hits.push({ table: name, column: c.name, rows: row.n });
		}
	}
	return hits;
}

const hex = (bytes: number): string =>
	Array.from(randomBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

/** what one bake wrote */
export interface Baked {
	db: string;
	hits: Hit[];
	sql: string | undefined;
}

/**
 * Runs the installer, then a second process that writes the rewrite rules, and scrubs the result.
 * The secrets exist only inside this function: a password and the salts the prepared config
 * carries.
 */
export async function bake(work: string, out: string | undefined): Promise<Baked> {
	const missing = dropInMissing();
	if (missing !== undefined) throw new Error(missing);
	const site = await prepareSite(join(work, 'site'), {
		origin: PLACEHOLDER_ORIGIN,
		title: BAKED_TITLE
	});
	site.email = BAKED_EMAIL;
	site.pass = hex(16);
	const host = await startHost({ dbFile: site.db, socketPath: site.socket });
	try {
		const run = await runPhp(site, [join(import.meta.dirname, '..', 'wp/bake.php')], {
			CFW_LABEL: 'bake',
			WP_STAMP_EPOCH: String(STAMP.epoch)
		});
		if (run.code !== 0 || !run.stdout.includes('"blogInstalled":true')) {
			throw new Error(`the installer failed (${run.code}): ${run.stderr.slice(0, 400)}`);
		}
		const rules = await runPhp(site, [join(import.meta.dirname, '..', 'wp/bake-rules.php')], {
			CFW_LABEL: 'bake-rules',
			WP_STAMP_EPOCH: String(STAMP.epoch)
		});
		if (rules.code !== 0 || !rules.stdout.includes('"rules":')) {
			throw new Error(
				`the rewrite rules failed (${rules.code}): ${rules.stderr.slice(0, 400)}`
			);
		}
	} finally {
		await host.stop();
	}
	const db = new DatabaseSync(site.db);
	try {
		for (const sql of scrubStatements()) db.exec(sql);
		installStatistics(db, modelStatistics(db));
		const secrets = [site.pass, ...site.salts];
		for (const secret of secrets) {
			const leaked = findHits(db, secret);
			if (leaked.length > 0) {
				throw new Error(`a secret reached the baked database: ${JSON.stringify(leaked)}`);
			}
		}
		const hits = findHits(db, PLACEHOLDER_ORIGIN);
		db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		db.close();
		let sql: string | undefined;
		if (out !== undefined) {
			const pack = spawnSync(
				'node',
				[join(ROOT, 'scripts/pack/sql.ts'), site.db, out, '--cms=wordpress'],
				{ encoding: 'utf8' }
			);
			if (pack.status !== 0) throw new Error(`pack-sql failed: ${pack.stderr.slice(0, 400)}`);
			sql = out;
		}
		return { db: site.db, hits, sql };
	} finally {
		try {
			db.close();
		} catch {
			// closed above
		}
	}
}

if (import.meta.main) {
	const arg = (name: string) =>
		process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
	const work = resolve(arg('work') ?? mkdtempSync(join(tmpdir(), 'cfw-bake-wp-')));
	mkdirSync(work, { recursive: true });
	const out = resolve(arg('out') ?? join(ROOT, 'assets/wordpress/sql'));
	const baked = await bake(work, out);
	console.log(JSON.stringify({ db: baked.db, sql: baked.sql, originHits: baked.hits }, null, 2));
}
