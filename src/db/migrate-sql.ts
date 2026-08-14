import { isPaid } from '../ops/plan.js';
/**
 * First-run migration, replayed in JavaScript straight into `ctx.storage.sql`.
 *
 * Replaying pre-built statements from JS fixes that for a reason that has nothing to do
 * with JavaScript being faster. **A JS loop is divisible where a synchronous wasm call
 * is not.** One chunk per invocation, cursor in DO SQLite, resume on the next
 * invocation -- no JSPI, no VM-interrupt patch, no mask seam, none of the four
 * undocumented behaviours the sliced-render path depends on.
 *
 * ATOMICITY. The cursor advances inside the same `transactionSync()` as the chunk's
 * statements. That is the whole correctness argument: a chunk either lands with its
 * cursor or neither, so a killed invocation is always retried from a consistent point
 * and never double-applies. A cursor in `ctx.storage.put()` would be a second commit
 * and a window where the data is in and the cursor is not.
 *
 * @see scripts/pack-sql.ts for the artifact format and why params beat SQL literals.
 */

/** A value `sql.exec()` can bind. Wide integers arrive here as decimal strings; see decodeParam. */
export type SqlParam = null | number | bigint | string | Uint8Array;

/**
 * What `decodeParam()` returns for a given packed param.
 *
 * A call site that already knows the tag gets the one type back; everything else gets the whole
 * bindable union, which is what the replay loop passes straight to `exec()`.
 */
export type DecodedParam<T> = T extends { $b64: unknown }
	? Uint8Array
	: T extends { $i: unknown }
		? string
		: SqlParam;

/** The cursor `sql.exec()` hands back, narrowed to what a replay reads off it. */
export interface SqlCursor {
	toArray(): Record<string, unknown>[];
	rowsRead: number;
	rowsWritten: number;
}

/** `ctx.storage.sql`, narrowed. The gate tests drive a real SQLite through this same shape. */
export interface SqlLike {
	exec(text: string, ...params: SqlParam[]): SqlCursor;
}

/** `ctx.storage`, narrowed to the one call that makes a chunk atomic with its cursor. */
export interface StorageLike {
	transactionSync<T>(cb: () => T): T;
}

/** The part of `manifest.json` a replay reads; `scripts/pack-sql.ts` writes considerably more. */
export interface MigrationManifest {
	generation: string;
	totals: { chunks: number; statements: number; rows: number };
	chunks: { file: string }[];
	creates?: string[];
	tables?: Record<string, number>;
}

/** One packed statement: SQL text plus its params, still in packed form. */
export interface PackedStatement {
	s: string;
	p?: unknown[];
}

/** One chunk file. Both fields are optional; a chunk missing either is a case step() refuses. */
export interface MigrationChunk {
	i?: number;
	statements?: PackedStatement[];
}

/** Where the manifest and chunks come from. Injected so the gate tests can replay off disk. */
export interface MigrationLoader {
	loadManifest: () => Promise<MigrationManifest>;
	loadChunk: (file: string, index: number) => Promise<MigrationChunk>;
}

export interface SqlMigratorOptions extends MigrationLoader {
	sql: SqlLike;
	storage: StorageLike;
	now?: () => number;
}

/** The cursor row, decoded. `state` stays a plain string because SQL is what produced it. */
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

export interface MigrateStepOptions {
	maxChunks?: number;
	budgetMs?: number;
}

export interface MigrateRunAllOptions {
	budgetMs?: number;
}

/**
 * What `step()` reports.
 *
 * `skipped` is set only on the already-migrated no-op, and `generation` / `elapsedMs` only on a
 * run that reached the replay loop, so all three are optional on the one shape.
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

export interface MigrateStatus {
	generation: string;
	chunks: number;
	statements: number;
	rows: number;
	cursor: MigrateCursor | null;
	done: boolean;
	started: boolean;
}

export interface MigrateResetResult {
	ok: true;
	dropped: number;
}

/** The binding the shipped loader fetches its assets through. */
export interface MigrateAssetEnv {
	ASSETS: Fetcher;
}

/** The two bindings the chunk budget reads; both arrive from wrangler as strings. */
export interface MigratePlanEnv {
	PLAN?: string;
	MIGRATE_CHUNKS_PER_INVOCATION?: string | number;
}

/** Table holding the single cursor row. Named like the other `cfw_*` host tables. */
export const MIGRATE_TABLE = 'cfw_migrate';

/** Cursor states, in order. `failed` is terminal only until the next attempt. */
export const MIGRATE_STATES = ['pending', 'running', 'done', 'failed'];

export class MigrationGenerationError extends Error {
	stored: string;
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

export class MigrationChunkError extends Error {
	index: number;

	constructor(index: number, cause: string) {
		super(`chunk ${index} failed and was rolled back: ${cause}`);
		this.name = 'MigrationChunkError';
		this.index = index;
		this.cause = cause;
	}
}

/**
 * Decodes one packed param back to something `sql.exec()` can bind.
 *
 * `$b64` is bytes that were not valid UTF-8. `$i` is an integer outside the IEEE-754
 * safe range: it is bound as a decimal STRING deliberately, because SQLite's INTEGER
 * affinity converts a well-formed integer string losslessly on the way in, while a JS
 * number would already have lost the low bits before the binding saw it.
 */
export function decodeParam<T>(v: T): DecodedParam<T>;
export function decodeParam(v: unknown): SqlParam {
	// anything the packer did not tag is already a bindable scalar out of JSON
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

/** Creates the cursor table. Safe to call on every invocation. */
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

/** @returns the cursor row, or null when migration has never been started. */
export function readMigrateCursor(sql: SqlLike): MigrateCursor | null {
	const rows = sql.exec(`SELECT * FROM ${MIGRATE_TABLE} WHERE id = 1`).toArray();
	const r = rows[0];
	if (r === undefined) return null;
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
 * Drives the chunk replay.
 *
 * `loadManifest` / `loadChunk` are injected rather than reading `env.ASSETS` directly so
 * the gate tests can replay the real shipped chunks off disk into a real SQLite without
 * a dev server. `now` is injected for the same reason.
 */
export class SqlMigrator {
	sql: SqlLike;
	storage: StorageLike;
	loadManifest: () => Promise<MigrationManifest>;
	loadChunk: (file: string, index: number) => Promise<MigrationChunk>;
	now: () => number;
	manifest: MigrationManifest | null;

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
		this.manifest = null;
	}

	async getManifest(): Promise<MigrationManifest> {
		if (!this.manifest) this.manifest = await this.loadManifest();
		return this.manifest;
	}

	/**
	 * Everything a diagnostics route needs about the migration, in one read.
	 *
	 * The JSDoc `@returns` that used to sit here was WRONG -- it claimed
	 * `{state, chunk, chunks, done}` while the method returns generation, chunks, statements,
	 * rows, cursor, done and started. It went unnoticed because JSDoc types on a `.js` file are
	 * advisory; once the file became TypeScript the declared `MigrateStatus` contradicted it in
	 * plain sight, which is the argument for the conversion in one line.
	 */
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
			started: cursor !== null
		};
	}

	/**
	 * Replays up to `maxChunks` chunks, then returns.
	 *
	 * One chunk is the default because one chunk is the unit sized to fit a single
	 * invocation's CPU budget. `maxChunks: Infinity` is the paid-plan and local path,
	 * where the whole migration in one invocation is simply cheaper.
	 *
	 * A chunk that throws leaves the database exactly as it was and records the error on
	 * the cursor without advancing it, so the next call retries the same chunk rather
	 * than skipping it. Skipping a failed chunk is how you get a site that renders and is
	 * quietly missing rows.
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
		if (cursor?.state === 'done') {
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
			// the row was just inserted, so this only guards the type
			if (!cursor) throw new Error('migrate cursor missing immediately after its insert');
		}

		const t0 = this.now();
		let applied = 0;
		let statements = cursor.statements;
		let rowsWritten = cursor.rowsWritten;
		let index = cursor.chunk;

		while (index < total && applied < maxChunks) {
			const meta = manifest.chunks[index];
			// a manifest whose totals outrun its own chunk list is the same class of mismatch as a
			// chunk file from another build, so it fails the same way
			if (!meta) {
				throw new MigrationChunkError(
					index,
					'manifest totals list more chunks than it names'
				);
			}
			const chunk = await this.loadChunk(meta.file, index);
			const list = Array.isArray(chunk?.statements) ? chunk.statements : null;
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
					// same transaction as the data, deliberately: a chunk and its cursor
					// commit together or not at all
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
				const message = String((e as { message?: unknown } | null)?.message ?? e);
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

			// a wall-clock guard for the paid/local path only: it cannot bound CPU, and on
			// the edge in-wasm and in-JS clocks both read 0, so the real bound is maxChunks
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

	/** Runs to completion. The paid-plan and local shape; on free this is 227x the ceiling. */
	async runAll({ budgetMs = 0 }: MigrateRunAllOptions = {}): Promise<MigrateStepResult> {
		return this.step({ maxChunks: Infinity, budgetMs });
	}

	/**
	 * Clears the cursor AND every table the manifest declares, so a re-migration starts
	 * from empty rather than colliding with its own previous rows.
	 *
	 * Destructive by definition, which is why the route gates it behind an explicit flag.
	 */
	async reset(): Promise<MigrateResetResult> {
		ensureMigrateTable(this.sql);
		const manifest = await this.getManifest();
		const dropped: string[] = [];
		// `creates` rather than `tables`: the latter is a row-count map and omits every
		// table with no rows, including the synthesised `sessions`. Dropping only the
		// row-bearing tables left `sessions` behind and the next migration died on
		// "table sessions already exists"
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
 * Reads the manifest and chunks out of the Workers Static Assets binding.
 *
 * Assets are fetched whole rather than range-fetched for the reason recorded against
 * the pack: a Range request against the asset server costs the same subrequest and
 * arrives as a fresh response either way, and the chunk sizing already bounds how much
 * a single invocation pulls.
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
 * Free is 1: the 10 ms ceiling is per invocation, and the chunk sizes in
 * `scripts/pack-sql.ts` are chosen so one chunk is the largest unit with a chance of
 * fitting. Paid has a 30 s CPU budget, so the whole migration is one invocation and the
 * chunking is only a crash-resume property there.
 */
export function chunksPerInvocation(env?: MigratePlanEnv | null): number {
	const explicit = Number(env?.MIGRATE_CHUNKS_PER_INVOCATION ?? 0);
	if (Number.isFinite(explicit) && explicit > 0) return explicit;
	// not a planFlag(): this one is a COUNT, so it shares the predicate and not the boolean chain
	return isPaid(env) ? Infinity : 1;
}
