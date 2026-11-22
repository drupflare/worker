import { DurableObject } from 'cloudflare:workers';

import {
	SqlMigrator,
	type MigrationChunk,
	type MigrationManifest
} from '../../../src/db/migrate-sql';
import { executeMysql } from '../../../src/db/sql/exec';
import { createState, type MysqlState } from '../../../src/db/sql/translate';
import { generate, SEED, SHAPE } from '../loaded-data';

/** one statement and its bound values */
interface Statement {
	s: string;
	p?: (string | number | null)[];
}

/** what one statement did on the object's meter */
interface Outcome {
	rows?: unknown[][];
	rowsRead?: number;
	rowsWritten?: number;
	error?: string;
}

const MAX_ROWS = 40;

/** one Durable Object holding one WordPress database, driven statement by statement */
export class Probe extends DurableObject<Record<string, never>> {
	/** the MySQL session the translator keeps for this object */
	private session: MysqlState = createState();

	/** runs raw SQLite statements and reports each statement's own meter */
	private runSql(statements: Statement[]): Outcome[] {
		const sql = this.ctx.storage.sql;
		return statements.map((st) => {
			try {
				const cursor = sql.exec(st.s, ...(st.p ?? []));
				const rows = Array.from(cursor.raw()).slice(0, MAX_ROWS);
				return { rows, rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten };
			} catch (e) {
				return { error: String((e as Error).message ?? e) };
			}
		});
	}

	/** replays a manifest and its chunks through the migration the object runs at provisioning */
	private async migrate(manifest: MigrationManifest, chunks: MigrationChunk[]): Promise<unknown> {
		const migrator = new SqlMigrator({
			sql: this.ctx.storage.sql as never,
			storage: this.ctx.storage,
			loadManifest: async () => manifest,
			loadChunk: async (_file, index) => chunks[index] as MigrationChunk
		});
		const before = this.ctx.storage.sql.databaseSize;
		const result = await migrator.runAll();
		return {
			result,
			databaseSizeBefore: before,
			databaseSize: this.ctx.storage.sql.databaseSize
		};
	}

	/** inserts the generated database, one transaction per batch, and tallies the meter per table */
	private load(scale: number, tables: string[] | undefined): unknown {
		const sql = this.ctx.storage.sql;
		const existing = {
			options: Number(sql.exec('SELECT count(*) AS n FROM wp_options').one().n),
			autoloaded: Number(
				sql
					.exec(
						"SELECT count(*) AS n FROM wp_options WHERE autoload IN ('yes','on','auto-on','auto')"
					)
					.one().n
			)
		};
		const per: Record<string, { rows: number; rowsWritten: number }> = {};
		for (const batch of generate(SHAPE, SEED, scale, existing)) {
			if (tables !== undefined && !tables.includes(batch.table)) continue;
			const text = `INSERT INTO ${batch.table} (${batch.columns.join(',')}) VALUES (${batch.columns.map(() => '?').join(',')})`;
			this.ctx.storage.transactionSync(() => {
				for (const row of batch.rows) {
					const c = sql.exec(text, ...row);
					c.toArray();
					const t = (per[batch.table] ??= { rows: 0, rowsWritten: 0 });
					t.rows++;
					t.rowsWritten += c.rowsWritten;
				}
			});
		}
		return per;
	}

	/** runs MySQL statements through the translator; reports the bridge's meter and each read's plan */
	private mysql(statements: string[]): unknown[] {
		const sql = this.ctx.storage.sql;
		return statements.map((text) => {
			const seen: { text: string; params: unknown[] }[] = [];
			const run = ((t: string, ...params: unknown[]) => {
				if (!t.includes('cfw_mysql_schema')) seen.push({ text: t, params });
				return sql.exec(t, ...(params as never[]));
			}) as never;
			const reply = executeMysql(text, run, this.session, {
				atomic: (fn) => this.ctx.storage.transactionSync(fn)
			});
			if (!reply.ok) return { error: reply.error, refused: reply.refused };
			const plans = seen
				.filter((s) => /^\s*(SELECT|WITH)/i.test(s.text))
				.map((s) =>
					Array.from(
						sql.exec(`EXPLAIN QUERY PLAN ${s.text}`, ...(s.params as never[])).raw()
					)
						.map((r) => String(r[3]))
						.join(' | ')
				);
			return { rowsRead: reply.rowsRead, rowsWritten: reply.rowsWritten, plans };
		});
	}

	/** the one route: a JSON body naming an operation */
	override async fetch(request: Request): Promise<Response> {
		const body = (await request.json()) as {
			op: string;
			statements?: Statement[];
			mysql?: string[];
			manifest?: MigrationManifest;
			chunks?: MigrationChunk[];
			scale?: number;
			tables?: string[];
		};
		let out: unknown;
		if (body.op === 'sql') out = this.runSql(body.statements ?? []);
		else if (body.op === 'migrate') out = await this.migrate(body.manifest!, body.chunks!);
		else if (body.op === 'load') out = this.load(body.scale ?? 1, body.tables);
		else if (body.op === 'mysql') out = this.mysql(body.mysql ?? []);
		else return new Response(`unknown op ${body.op}`, { status: 400 });
		return Response.json(out);
	}
}

/** routes `/<name>` to the object of that name, so each arm gets a fresh database */
export default {
	async fetch(request: Request, env: { PROBE: DurableObjectNamespace }): Promise<Response> {
		const name = new URL(request.url).pathname.slice(1) || 'default';
		return env.PROBE.get(env.PROBE.idFromName(name)).fetch(request);
	}
};
