import { isPaid } from '../ops/plan';
import { errorMessage } from '../util/errors';
/** a value `sql.exec()` can bind; wide integers arrive as decimal strings (see `decodeParam`) */
export type SqlParam = null | number | bigint | string | Uint8Array;

/**
 * What `decodeParam()` returns for a packed param: the one type for a known tag, else the whole
 * bindable union.
 */
export type DecodedParam<T> = T extends { $b64: unknown }
	? Uint8Array
	: T extends { $i: unknown }
		? string
		: SqlParam;

/** the cursor `sql.exec()` returns, narrowed to what a replay reads */
export interface SqlCursor {
	toArray(): Record<string, unknown>[];
	rowsRead: number;
	rowsWritten: number;
}

/** `ctx.storage.sql`, narrowed; gate tests drive a real SQLite through the same shape */
export interface SqlLike {
	exec(text: string, ...params: SqlParam[]): SqlCursor;
}

/** `ctx.storage`, narrowed to the call that makes a chunk atomic with its cursor */
export interface StorageLike {
	transactionSync<T>(cb: () => T): T;
}

/** the part of `manifest.json` a replay reads (`scripts/pack-sql.ts` writes more) */
export interface MigrationManifest {
	generation: string;
	totals: { chunks: number; statements: number; rows: number };
	chunks: { file: string }[];
	creates?: string[];
	tables?: Record<string, number>;
	/**
	 * Whether this manifest may replay over a database that finished a different generation. Absent
	 * (the shipped pack) means no; only a restore sets it, since a newer pack over a live site
	 * would produce a database that is neither.
	 */
	replaces?: boolean;
}

/** one packed statement: SQL text plus its params, still packed */
export interface PackedStatement {
	s: string;
	p?: unknown[];
}

/** one chunk file; `step()` refuses a chunk missing either optional field */
export interface MigrationChunk {
	i?: number;
	statements?: PackedStatement[];
}

/** where the manifest and chunks come from; injected so gate tests can replay off disk */
export interface MigrationLoader {
	loadManifest: () => Promise<MigrationManifest>;
	loadChunk: (file: string, index: number) => Promise<MigrationChunk>;
}

/** constructor options for {@link SqlMigrator}; `now` is injectable for tests */
export interface SqlMigratorOptions extends MigrationLoader {
	sql: SqlLike;
	storage: StorageLike;
	now?: () => number;
}

/** the cursor row, decoded; `state` stays a plain string because SQL produced it */
export interface MigrateCursor {
	generation: string;
	chunk: number;
	chunks: number;
	statements: number;
	rowsWritten: number;
	state: string;
	error: string | null;
	startedAt: number;
	updatedAt: number;
}

/** options for {@link SqlMigrator.step} */
export interface MigrateStepOptions {
	maxChunks?: number;
	budgetMs?: number;
}

/** options for {@link SqlMigrator.runAll} */
export interface MigrateRunAllOptions {
	budgetMs?: number;
}

/**
 * What `step()` reports; `skipped` is set only on the already-migrated no-op, and `generation` /
 * `elapsedMs` only on a run that reached the replay loop.
 */
export interface MigrateStepResult {
	ok: true;
	done: boolean;
	chunk: number;
	chunks: number;
	applied: number;
	statements: number;
	rowsWritten: number;
	skipped?: string;
	generation?: string;
	elapsedMs?: number;
}

/** what {@link SqlMigrator.status} reports */
export interface MigrateStatus {
	generation: string;
	chunks: number;
	statements: number;
	rows: number;
	cursor?: MigrateCursor;
	done: boolean;
	started: boolean;
}

/** what {@link SqlMigrator.reset} reports */
export interface MigrateResetResult {
	ok: true;
	dropped: number;
}

/** the binding the shipped loader fetches its assets through */
export interface MigrateAssetEnv {
	ASSETS: Fetcher;
}

/** the two bindings the chunk budget reads; wrangler delivers them as strings */
export interface MigratePlanEnv {
	PLAN?: string;
	MIGRATE_CHUNKS_PER_INVOCATION?: string | number;
}

/** table holding the single cursor row */
export const MIGRATE_TABLE = 'cfw_migrate';

/** cursor states, in order; `failed` is terminal only until the next attempt */
export const MIGRATE_STATES = ['pending', 'running', 'done', 'failed'];

/** the cursor is partway through one generation and the manifest names another */
export class MigrationGenerationError extends Error {
	/** the generation the cursor is partway through */
	stored: string;
	/** the generation the manifest names */
	incoming: string;

	constructor(stored: string, incoming: string) {
		super(
			`migration generation mismatch: cursor is partway through ${stored}, manifest is ${incoming}. ` +
				`Replaying a different pack over a half-migrated database would produce a site that is neither.`
		);
		this.name = 'MigrationGenerationError';
		this.stored = stored;
		this.incoming = incoming;
	}
}

/** a chunk failed (and was rolled back) or could not be replayed */
export class MigrationChunkError extends Error {
	/** the failing chunk's index */
	index: number;

	constructor(index: number, cause: string) {
		super(`chunk ${index} failed and was rolled back: ${cause}`);
		this.name = 'MigrationChunkError';
		this.index = index;
		this.cause = cause;
	}
}

/**
 * Decodes one packed param for `sql.exec()`. `$b64` is bytes that were not valid UTF-8; `$i` is an
 * integer beyond the safe range, bound as a decimal string (INTEGER affinity converts it
 * losslessly; a JS number would already have lost the low bits).
 */
export function decodeParam<T>(v: T): DecodedParam<T>;
export function decodeParam(v: unknown): SqlParam {
	// untagged values are already bindable JSON scalars
	if (v === null || typeof v !== 'object') return v as SqlParam;
	const packed = v as { $b64?: unknown; $i?: unknown };
	if (typeof packed.$b64 === 'string') {
		const bin = atob(packed.$b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return bytes;
	}
	if (typeof packed.$i === 'string') return packed.$i;
	throw new Error(`unrecognised packed param: ${JSON.stringify(v).slice(0, 80)}`);
}

/** creates the cursor table; safe on every invocation */
export function ensureMigrateTable(sql: SqlLike): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS ${MIGRATE_TABLE} (
			id INTEGER PRIMARY KEY,
			generation TEXT NOT NULL,
			chunk INTEGER NOT NULL DEFAULT 0,
			chunks INTEGER NOT NULL DEFAULT 0,
			statements INTEGER NOT NULL DEFAULT 0,
			rows_written INTEGER NOT NULL DEFAULT 0,
			state TEXT NOT NULL DEFAULT 'pending',
			error TEXT,
			started_at INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL DEFAULT 0
		)`
	);
}

/** the cursor row, or undefined when migration never started */
export function readMigrateCursor(sql: SqlLike): MigrateCursor | undefined {
	const rows = sql.exec(`SELECT * FROM ${MIGRATE_TABLE} WHERE id = 1`).toArray();
	const r = rows[0];
	if (r === undefined) return undefined;
	return {
		generation: String(r.generation),
		chunk: Number(r.chunk),
		chunks: Number(r.chunks),
		statements: Number(r.statements),
		rowsWritten: Number(r.rows_written),
		state: String(r.state),
		error: r.error === null || r.error === undefined ? null : String(r.error),
		startedAt: Number(r.started_at),
		updatedAt: Number(r.updated_at)
	};
}

/**
 * First-run migration, replayed in JavaScript into `ctx.storage.sql`. A JS loop is divisible where
 * a synchronous wasm call is not: one chunk per invocation, cursor in DO SQLite, resume next time.
 *
 * The cursor advances inside the same `transactionSync()` as the chunk's statements, so a killed
 * invocation retries from a consistent point (a `ctx.storage.put()` cursor would be a second
 * commit). `loadManifest`, `loadChunk` and `now` are injected so gate tests replay off disk.
 */
export class SqlMigrator {
	/** the tenant database the chunks replay into */
	sql: SqlLike;
	/** the storage handle whose `transactionSync()` makes a chunk atomic with its cursor */
	storage: StorageLike;
	/** fetches the manifest (memoised by `getManifest()`) */
	loadManifest: () => Promise<MigrationManifest>;
	/** fetches one chunk by file name and index */
	loadChunk: (file: string, index: number) => Promise<MigrationChunk>;
	/** the clock, injectable for tests */
	now: () => number;
	/** the manifest once loaded */
	manifest?: MigrationManifest;

	constructor({
		sql,
		storage,
		loadManifest,
		loadChunk,
		now = () => Date.now()
	}: SqlMigratorOptions) {
		this.sql = sql;
		this.storage = storage;
		this.loadManifest = loadManifest;
		this.loadChunk = loadChunk;
		this.now = now;
	}

	/** the manifest, loaded once per migrator */
	async getManifest(): Promise<MigrationManifest> {
		if (!this.manifest) this.manifest = await this.loadManifest();
		return this.manifest;
	}

	/** everything a diagnostics route needs about the migration, in one read */
	async status(): Promise<MigrateStatus> {
		ensureMigrateTable(this.sql);
		const manifest = await this.getManifest();
		const cursor = readMigrateCursor(this.sql);
		return {
			generation: manifest.generation,
			chunks: manifest.totals.chunks,
			statements: manifest.totals.statements,
			rows: manifest.totals.rows,
			cursor,
			done: cursor?.state === 'done',
			started: cursor !== undefined
		};
	}

	/**
	 * Replays up to `maxChunks` chunks (default one; `Infinity` is the paid and local path), then
	 * returns. A chunk that throws leaves the database as it was and records the error without
	 * advancing the cursor, so the next call retries it; skipping would leave a site quietly
	 * missing rows.
	 */
	async step({
		maxChunks = 1,
		budgetMs = 0
	}: MigrateStepOptions = {}): Promise<MigrateStepResult> {
		ensureMigrateTable(this.sql);
		const manifest = await this.getManifest();
		const generation = String(manifest.generation);
		const total = manifest.totals.chunks;

		let cursor = readMigrateCursor(this.sql);
		if (cursor && cursor.generation !== generation && cursor.state !== 'done') {
			throw new MigrationGenerationError(cursor.generation, generation);
		}
		// "already migrated" means this generation: a restore shares the cursor row with the pack,
		// and a bare `done` skipped it while reporting success with no data changed
		const sameGeneration = cursor?.generation === generation;
		if (cursor?.state === 'done' && (sameGeneration || manifest.replaces !== true)) {
			return {
				ok: true,
				done: true,
				skipped: 'already migrated',
				chunk: cursor.chunk,
				chunks: cursor.chunks,
				statements: cursor.statements,
				rowsWritten: cursor.rowsWritten,
				applied: 0
			};
		}

		if (cursor && !sameGeneration) {
			const at = this.now();
			this.sql.exec(
				`UPDATE ${MIGRATE_TABLE}
				 SET generation = ?, chunk = 0, chunks = ?, statements = 0, rows_written = 0,
				     state = 'running', error = NULL, started_at = ?, updated_at = ?
				 WHERE id = 1`,
				generation,
				total,
				at,
				at
			);
			cursor = readMigrateCursor(this.sql);
			if (!cursor) throw new Error('migrate cursor missing immediately after its handover');
		}

		const startedAt = cursor?.startedAt || this.now();
		if (!cursor) {
			this.sql.exec(
				`INSERT INTO ${MIGRATE_TABLE}
					(id, generation, chunk, chunks, statements, rows_written, state, error, started_at, updated_at)
				 VALUES (1, ?, 0, ?, 0, 0, 'running', NULL, ?, ?)`,
				generation,
				total,
				startedAt,
				startedAt
			);
			cursor = readMigrateCursor(this.sql);
			if (!cursor) throw new Error('migrate cursor missing immediately after its insert');
		}

		const t0 = this.now();
		let applied = 0;
		let statements = cursor.statements;
		let rowsWritten = cursor.rowsWritten;
		let index = cursor.chunk;

		while (index < total && applied < maxChunks) {
			const meta = manifest.chunks[index];
			// totals outrunning the chunk list is the same mismatch as a chunk from another build
			if (!meta) {
				throw new MigrationChunkError(
					index,
					'manifest totals list more chunks than it names'
				);
			}
			const chunk = await this.loadChunk(meta.file, index);
			const list = Array.isArray(chunk?.statements) ? chunk.statements : undefined;
			if (!list) {
				throw new MigrationChunkError(index, 'chunk has no statements array');
			}
			if (chunk.i !== undefined && Number(chunk.i) !== index) {
				throw new MigrationChunkError(
					index,
					`chunk file reports index ${chunk.i}; a manifest and chunk set from different builds is not replayable`
				);
			}

			const next = index + 1;
			const wroteBefore = rowsWritten;
			let chunkRows = 0;
			try {
				this.storage.transactionSync(() => {
					for (const st of list) {
						const params = Array.isArray(st.p) ? st.p.map(decodeParam) : [];
						const c = this.sql.exec(st.s, ...params);
						// the cursor is a live iterator; drain it before the next exec
						c.toArray();
						chunkRows += Number(c.rowsWritten ?? 0);
					}
					// same transaction as the data: chunk and cursor commit together
					this.sql.exec(
						`UPDATE ${MIGRATE_TABLE}
						 SET chunk = ?, statements = ?, rows_written = ?, state = ?, error = NULL, updated_at = ?
						 WHERE id = 1`,
						next,
						statements + list.length,
						wroteBefore + chunkRows,
						next >= total ? 'done' : 'running',
						this.now()
					);
				});
			} catch (e) {
				const message = errorMessage(e);
				// outside the rolled-back transaction, so the record of the failure survives
				this.sql.exec(
					`UPDATE ${MIGRATE_TABLE} SET state = 'failed', error = ?, updated_at = ? WHERE id = 1`,
					message,
					this.now()
				);
				throw new MigrationChunkError(index, message);
			}

			statements += list.length;
			rowsWritten = wroteBefore + chunkRows;
			index = next;
			applied++;

			// wall-clock guard for paid and local; edge clocks read 0 (`maxChunks` bounds)
			if (budgetMs > 0 && this.now() - t0 >= budgetMs) break;
		}

		const done = index >= total;
		return {
			ok: true,
			done,
			chunk: index,
			chunks: total,
			applied,
			statements,
			rowsWritten,
			generation,
			elapsedMs: this.now() - t0
		};
	}

	/** runs to completion: the paid and local shape (on free it exceeds the ceiling) */
	async runAll({ budgetMs = 0 }: MigrateRunAllOptions = {}): Promise<MigrateStepResult> {
		return this.step({ maxChunks: Infinity, budgetMs });
	}

	/**
	 * Clears the cursor and every table the manifest declares so a re-migration starts empty.
	 * Destructive; the route gates it behind an explicit flag.
	 */
	async reset(): Promise<MigrateResetResult> {
		ensureMigrateTable(this.sql);
		const manifest = await this.getManifest();
		const dropped: string[] = [];
		// `creates` as well as `tables`: the row-count map omits empty tables such as `sessions`,
		// and leaving one behind fails the next migration on "already exists"
		const targets = new Set([
			...(Array.isArray(manifest.creates) ? manifest.creates : []),
			...Object.keys(manifest.tables ?? {})
		]);
		this.storage.transactionSync(() => {
			for (const table of targets) {
				try {
					this.sql.exec(`DROP TABLE IF EXISTS "${table.replace(/"/g, '""')}"`);
					dropped.push(table);
				} catch {
					/* a table that will not drop is reported by absence, not by throwing */
				}
			}
			this.sql.exec(`DELETE FROM ${MIGRATE_TABLE} WHERE id = 1`);
		});
		return { ok: true, dropped: dropped.length };
	}
}

/**
 * Reads the manifest and chunks from the static assets binding, whole: a Range request costs the
 * same subrequest and chunk sizing already bounds what one invocation pulls.
 */
export function assetChunkLoader(env: MigrateAssetEnv, prefix = 'drupal-sql'): MigrationLoader {
	const base = `https://a.local/${prefix}/`;
	return {
		async loadManifest() {
			const res = await env.ASSETS.fetch(new URL(`${base}manifest.json`));
			if (!res.ok) {
				throw new Error(`no migration manifest at ${prefix}/manifest.json (${res.status})`);
			}
			return res.json<MigrationManifest>();
		},
		async loadChunk(file) {
			const res = await env.ASSETS.fetch(new URL(`${base}${file}`));
			if (!res.ok) {
				throw new Error(`missing migration chunk ${prefix}/${file} (${res.status})`);
			}
			return res.json<MigrationChunk>();
		}
	};
}

/**
 * How many chunks a plan should replay per invocation.
 *
 * The bound is subrequests, not the 10 ms cap (an object invocation read 1,882 ms of `cpuTime`
 * on free): free allows 50 and {@link assetChunkLoader} spends one fetch per chunk plus one for the
 * memoised manifest, so free replays 40 per invocation. Paid is one invocation (30 s CPU, 1,000
 * subrequests), so chunking there is only crash-resume.
 */
export function chunksPerInvocation(env?: MigratePlanEnv): number {
	const explicit = Number(env?.MIGRATE_CHUNKS_PER_INVOCATION ?? 0);
	if (Number.isFinite(explicit) && explicit > 0) return explicit;
	// a count, so it shares the predicate but not the `planFlag()` boolean chain
	return isPaid(env) ? Infinity : FREE_CHUNKS_PER_INVOCATION;
}

/**
 * Chunks a free invocation replays; one fetch per chunk plus the manifest must stay under
 * {@link FREE_SUBREQUEST_LIMIT} (`tests/node/migrate-sql.spec.ts`).
 */
export const FREE_CHUNKS_PER_INVOCATION = 40;

/** subrequests a single free-plan Worker invocation may issue */
export const FREE_SUBREQUEST_LIMIT = 50;
