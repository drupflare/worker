/**
 * What a read replica may do to itself, and what it must refuse and send to the primary.
 *
 * TWO ALLOW-LISTS AND NO DENY-LIST, which is the whole design. A deny-list is wrong here by
 * construction: the failure it produces is a replica silently committing an authoritative write
 * that the primary never sees, and the write it misses is by definition the one nobody thought of.
 * So a table is authoritative unless named local, a statement is a write unless proven a read, and
 * a capability is mutating unless named safe.
 *
 * The bridge surface is the reason this cannot enumerate: `CROSSING_NAMES` in `crossings.ts` is a
 * hand-maintained list whose own docblock says a new capability should show up rather than be
 * "counted by accident", and TWO have been added since without joining it -- `cfwOidcClaims`, which
 * deletes a durable ticket, and `cfwTcp`, which queues an outbound exchange. Both mutate. So
 * {@link enforceReadOnly} walks what is INSTALLED on the module and refuses anything it does not
 * recognise, rather than walking a list that has already drifted twice.
 */

import type { TxnRequest } from '@drupflare/durabledb/do-sqlite';
import { STORAGE_TABLE_PREFIX, writeTargetTable } from '../db/write-tally.js';

/**
 * Tables a replica may write to itself with nothing lost if the write is discarded.
 *
 * `cache_` covers Drupal's bins, which are derived from authoritative state and rebuildable.
 * `?storage.` is {@link STORAGE_TABLE_PREFIX}, the host's own alarm and key-value bookkeeping,
 * which is per-object by construction.
 *
 * The named set is SHORT and is not `cfw_`. A prefix rule over the host's
 * own tables would sweep in `cfw_mail_queue` (a committed message), `cfw_file` (durable file bytes)
 * and `cfw_http_queue` (an outbound request) -- three authoritative stores that happen to share a
 * naming convention with the page cache.
 */
const REPLICA_LOCAL_PREFIXES = ['cache_', STORAGE_TABLE_PREFIX] as const;

const REPLICA_LOCAL_TABLES: ReadonlySet<string> = new Set([
	// the page cache and the shell tier: derived, and already keyed by generation
	'cfw_page',
	'cfw_shell',
	'cfw_shell_verified',
	// per-object bookkeeping; a replica keeps its own cursor and its own health ledger
	'cfw_meta',
	'cfw_health'
]);

export function isReplicaLocalTable(table: string): boolean {
	if (REPLICA_LOCAL_TABLES.has(table)) return true;
	return REPLICA_LOCAL_PREFIXES.some((prefix) => table.startsWith(prefix));
}

/**
 * Expiry sweeps the HOST's own cron already performs, table by table and column by column.
 *
 * The pairs are `EXPIRED_ROW_RULES` in `cron.ts`, minus `queue`. Not imported from there because
 * `cron.ts` pulls the cron PHP fragments in with it and this module is on the front worker's routing
 * path; `tests/unit/ops/replica.spec.ts` drives both lists and fails when they disagree.
 *
 * `queue` is left out on purpose. Its rule carries a second `name LIKE` predicate and a queue item is
 * pending WORK rather than an expired copy of something, so discarding a replica's delete of one is
 * not the same trade as discarding a delete of a stale session.
 */
const EXPIRY_GC: ReadonlyArray<{ table: string; column: string }> = [
	{ table: 'sessions', column: 'timestamp' },
	{ table: 'flood', column: 'expiration' },
	{ table: 'key_value_expire', column: 'expire' },
	{ table: 'batch', column: 'timestamp' },
	{ table: 'semaphore', column: 'expire' }
];

/**
 * The table an expiry-GC delete sweeps, or `null` when the statement is not one.
 *
 * SAME TABLE, TWO EFFECTS, which is the `key_value` lesson pointed at `sessions`. Writing a session
 * row is authoritative; deleting rows whose `timestamp` has passed is the primary's own cron rule
 * executed by a different caller, so a replica running it loses nothing when its copy is discarded --
 * both sides converge on the same set.
 *
 * Anchored at both ends, so a delete carrying any extra predicate does not match and stays
 * authoritative. That is the direction to fail in: a shape this does not recognise is reported.
 */
export function expiryGcTable(sql: string): string | null {
	const text = String(sql ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	for (const rule of EXPIRY_GC) {
		const pattern = new RegExp(
			`^DELETE FROM ["'\`\\[]?${rule.table}["'\`\\]]? WHERE ["'\`\\[]?${rule.column}["'\`\\]]? *< *\\? *;?$`,
			'i'
		);
		if (pattern.test(text)) return rule.table;
	}
	return null;
}

/**
 * Whether every write statement a tally recorded against `table` was an expiry sweep of it.
 *
 * Reads the tally's `shapes`, which is a diagnostic with a cap and a truncation, so this fails
 * CLOSED in three ways: no `shapes` at all, a shape that does not parse as a sweep, or a shape count
 * that does not add up to the statements recorded. Any of them reports the table.
 */
function sweptOnly(
	shapes: Record<string, number> | undefined,
	table: string,
	statements: number
): boolean {
	if (!shapes || statements <= 0) return false;
	let swept = 0;
	for (const [shape, count] of Object.entries(shapes)) {
		if (expiryGcTable(shape) === table) swept += count;
	}
	return swept === statements;
}

/** one table a request wrote that a replica may not */
export type AuthoritativeWrite = { table: string; rows: number; statements: number };

/**
 * The authoritative half of a write tally, which is the quantity the replica bet rests on.
 *
 * Rows AND statements, because they answer different questions and the invariant needs both: rows
 * say whether anything was committed, statements say whether anything was attempted. A DELETE that
 * matched nothing writes no rows on this object and would match on one whose state differs.
 */
export function authoritativeWrites(tally: {
	byTable: Record<string, number>;
	statementsByTable: Record<string, number>;
	shapes?: Record<string, number>;
}): AuthoritativeWrite[] {
	const tables = new Set([
		...Object.keys(tally.byTable),
		...Object.keys(tally.statementsByTable)
	]);
	const out: AuthoritativeWrite[] = [];
	for (const table of tables) {
		if (isReplicaLocalTable(table)) continue;
		if (sweptOnly(tally.shapes, table, tally.statementsByTable[table] ?? 0)) continue;
		out.push({
			table,
			rows: tally.byTable[table] ?? 0,
			statements: tally.statementsByTable[table] ?? 0
		});
	}
	return out.sort((a, b) => b.rows - a.rows || a.table.localeCompare(b.table));
}

/**
 * Whether a statement is PROVEN to be a read.
 *
 * Anything unrecognised answers false. `writeTargetTable()` is not usable for this: it exists to
 * attribute a write to a table and answers null both for "this is a read" and for "this is a write
 * whose shape the parser does not know", and those two must not collapse here.
 *
 * `WITH` is refused despite usually introducing a SELECT, because SQLite accepts a CTE followed by
 * INSERT/UPDATE/DELETE and telling the two apart needs a parser.
 */
export function isProvenRead(sql: string): boolean {
	const text = sql.trim();
	// a compound is not a proven read whatever it starts with, and this is exported: the admission
	// path guards it too, but a future caller reaching the leaf directly would reopen the hole
	if (compound(text)) return false;
	if (/^SELECT\b/i.test(text)) return true;
	if (/^EXPLAIN\b/i.test(text)) return true;
	// the introspection forms Drupal's schema handler uses; `PRAGMA x = y` sets and is refused
	if (/^PRAGMA\s+[A-Za-z_]+\s*\(/i.test(text)) return true;
	return false;
}

/**
 * Whether the text carries more than one statement.
 *
 * `sql.exec()` runs every statement in the string it is handed, and every classifier below reads the
 * LEADING keyword -- so a compound describes only its first statement. `SELECT 1; DELETE FROM users`
 * is a proven read and `INSERT INTO cache_render (...); DELETE FROM users` attributes to a
 * replica-local table, and both then mutate authoritative state on a lane. Refused rather than
 * parsed, which is the call {@link isProvenRead} already makes about a CTE.
 *
 * One trailing separator is not a second statement; Drupal binds values rather than inlining them,
 * so a literal `;` inside the text is rare and costs a hop to the primary rather than a wrong answer.
 */
function compound(text: string): boolean {
	return text.replace(/;\s*$/, '').includes(';');
}

/**
 * Whether a replica may run this statement against its own database.
 *
 * THE TWO ALLOW-LISTS HAVE TO MEET HERE, and they did not at first: `isProvenRead()` alone refuses
 * `INSERT INTO cache_render`, which `isReplicaLocalTable()` calls local -- so a replica could not
 * fill its own cache bins and would re-render every request, which is the entire thing it exists to
 * avoid. A read is allowed, and so is a write whose target is replica-local.
 *
 * Still fail-closed: `writeTargetTable()` returns null both for a read and for a write it cannot
 * parse, and a null answer refuses.
 */
export function statementAllowedOnReplica(sql: string): boolean {
	if (compound(String(sql ?? '').trim())) return false;
	if (isProvenRead(sql)) return true;
	if (expiryGcTable(sql) !== null) return true;
	const target = writeTargetTable(sql);
	return target !== null && isReplicaLocalTable(target);
}

/**
 * The generation fence: whether a replica's view is fresh enough to answer.
 *
 * A REPLICA MAY ONLY SERVE STATE FOR GENERATION G IF ITS AUTHORITATIVE VIEW IS VALID THROUGH G.
 * Equality is sufficient and being ahead is fine; being behind by any amount refuses.
 *
 * The fence is only as strong as the generation ADVANCING on every change that matters, which is a
 * separate property and is measured by `tests/integration/generation-fence.spec.ts`. A change that
 * mutates authoritative state without bumping leaves a stale replica believing it is current, and
 * the fence cannot see it -- so the fence is necessary and is not on its own sufficient.
 */
export function fenceAllows(appliedGeneration: number, requiredGeneration: number): boolean {
	if (!Number.isFinite(appliedGeneration) || !Number.isFinite(requiredGeneration)) return false;
	return appliedGeneration >= requiredGeneration;
}

/** why a replica refused; the sentence a caller logs and the reason it fails over */
export class ReplicaRequiresPrimary extends Error {
	readonly capability: string;
	readonly detail: string;
	constructor(capability: string, detail: string) {
		super(`${capability} requires the primary: ${detail}`);
		this.name = 'ReplicaRequiresPrimary';
		this.capability = capability;
		this.detail = detail;
	}
}

/**
 * Capabilities a replica may serve itself.
 *
 * Every one is a pure function of its arguments or a read of replica-local state. Everything else
 * -- including anything absent from this set -- is mutating and refused.
 *
 * `cfwLog` is the one judgement call: it appends to an in-memory ring and
 * writes `console.log`, neither of which is authoritative state. A watchdog ROW would be, and this
 * capability does not write one.
 */
export const REPLICA_SAFE_CAPABILITIES: ReadonlySet<string> = new Set([
	'cfwStats',
	// a snapshot of this object's own counters; a replica reporting the primary's would be wrong
	'cfwServeStats',
	'cfwZlib',
	'cfwLog',
	// a pure URL builder over its arguments
	'cfwImageUrl',
	// reads of replica-local stores
	'cfwHttpCacheGet',
	'cfwFileRead',
	'cfwFileList',
	'cfwFileStat',
	// a configured string, identical on every lane
	'cfwFilePublicBase',
	// classified per statement rather than wholesale; see below
	'cfwSqlExec',
	'cfwSqlTxn'
]);

/** capabilities whose every call is refused outright */
export type CapabilityVerdict = 'safe' | 'per-call' | 'mutating';

export function classifyCapability(name: string): CapabilityVerdict {
	if (name === 'cfwSqlExec' || name === 'cfwSqlTxn') return 'per-call';
	return REPLICA_SAFE_CAPABILITIES.has(name) ? 'safe' : 'mutating';
}

/** the one binding that puts an object into replica mode; absent or `'0'` means primary */
export type ReplicaEnv = { REPLICA_READ_ONLY?: string | undefined };

export function replicaReadOnly(env?: ReplicaEnv | null): boolean {
	return String(env?.REPLICA_READ_ONLY ?? '') === '1';
}

/** what {@link enforceReadOnly} did, so a caller can assert the surface was actually covered */
export type ReadOnlyGuard = {
	/** every capability the guard wrapped, with its verdict */
	wrapped: Record<string, CapabilityVerdict>;
	/** refusals so far this request, most recent last */
	refusals: ReplicaRequiresPrimary[];
	/**
	 * whether any mutating inner function was reached.
	 *
	 * Always false by construction -- a refusal throws BEFORE the inner call -- and asserted rather
	 * than assumed, because it is the precondition for retrying on the primary. A retry after a
	 * partial mutation double-applies it.
	 */
	didMutate: () => boolean;
};

/** the payload shape both SQL capabilities are handed: a JSON string */
function parseJson(json: unknown): unknown {
	if (typeof json !== 'string') return null;
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

/**
 * Reads the statement text out of a `cfwSqlExec` payload.
 *
 * The payload crosses the bridge through the codec, so a bare `JSON.parse` sees the encoded form.
 * Only the `sql` field is needed and it is a plain string on both sides, so this does not decode.
 */
function execStatements(json: unknown): string[] | null {
	const body = parseJson(json) as { sql?: unknown } | null;
	if (body === null || typeof body.sql !== 'string') return null;
	return [body.sql];
}

function txnStatements(json: unknown): string[] | null {
	const body = parseJson(json) as Partial<TxnRequest> | null;
	if (body === null || !Array.isArray(body.statements)) return null;
	const out: string[] = [];
	for (const statement of body.statements) {
		if (typeof statement?.sql !== 'string') return null;
		out.push(statement.sql);
	}
	// the speculative read rides alongside the buffer and is a read by construction; included
	// anyway, because "by construction" is what this module refuses to take on trust
	if (body.read !== undefined && body.read !== null) {
		if (typeof body.read.sql !== 'string') return null;
		out.push(body.read.sql);
	}
	return out;
}

/**
 * The same transaction payload with `commit` forced off, or null when it cannot be read.
 *
 * Returned as a JSON string because that is what the capability was handed; rewriting the object in
 * place would mutate what the caller still holds.
 */
export function speculative(json: unknown): string | null {
	const body = parseJson(json) as Partial<TxnRequest> | null;
	if (body === null || !Array.isArray(body.statements)) return null;
	return JSON.stringify({ ...body, commit: false });
}

/**
 * Makes a replica physically unable to commit an authoritative side effect.
 *
 * Wraps the INSTALLED surface rather than a known list, so a capability added later is refused
 * until somebody classifies it. That direction is the safe one: an unclassified capability costs a
 * failover to the primary, where an unclassified capability waved through costs a divergent site.
 *
 * A refusal throws before the inner function is called, which is what makes the primary retry safe.
 *
 * @param binary
 *   The instantiated PHP module, mutated in place.
 * @param onRefusal
 *   Called with each refusal before it is thrown; the caller uses it to record the failover.
 * @param collect
 *   Turns SQL refusal into forwarding. Given one, a mutating transaction is downgraded to the
 *   driver's speculative path -- replayed, read through, rolled back -- and its statements are handed
 *   here for the primary to commit. Only SQL forwards: a `mutating` capability is an outbound effect
 *   like mail, and there is no rollback for one that has been sent.
 */
export function enforceReadOnly(
	binary: Record<string, unknown>,
	onRefusal?: (refusal: ReplicaRequiresPrimary) => void,
	collect?: (statements: readonly string[], payload: unknown) => void
): ReadOnlyGuard {
	const wrapped: Record<string, CapabilityVerdict> = {};
	const refusals: ReplicaRequiresPrimary[] = [];
	let mutated = false;

	const refuse = (capability: string, detail: string): never => {
		const refusal = new ReplicaRequiresPrimary(capability, detail);
		refusals.push(refusal);
		onRefusal?.(refusal);
		throw refusal;
	};

	for (const name of Object.keys(binary)) {
		if (!name.startsWith('cfw')) continue;
		const fn = binary[name];
		// `cfwCanSuspend` is a boolean the service provider probes; wrapping it would hand PHP a
		// callable where it expects a flag, which reads true and installs a handler that cannot work
		if (typeof fn !== 'function') continue;

		const verdict = classifyCapability(name);
		wrapped[name] = verdict;
		const inner = fn as (...args: unknown[]) => unknown;

		if (verdict === 'safe') continue;

		if (verdict === 'mutating') {
			binary[name] = () => refuse(name, 'the capability mutates state outside this replica');
			continue;
		}

		const read = name === 'cfwSqlTxn' ? txnStatements : execStatements;
		binary[name] = (...args: unknown[]) => {
			const statements = read(args[0]);
			// an unparseable payload is refused rather than passed through: the guard cannot see what
			// it would be authorising
			if (statements === null) refuse(name, 'the statement payload could not be read');
			const write = statements!.find((sql) => !statementAllowedOnReplica(sql));
			if (write !== undefined) {
				if (collect === undefined) {
					refuse(
						name,
						`not a read and not replica-local: ${write.replace(/\s+/g, ' ').trim().slice(0, 120)}`
					);
				}
				// forwarded rather than refused: run it speculatively so PHP reads through its own
				// write, and hand the statements to the primary. `commit: false` is the driver's
				// existing path and the rollback is what keeps this lane's database at its
				// applied generation
				const payload = speculative(args[0]);
				if (payload === null) {
					// AN EXEC WRITE IS NOT FORWARDABLE HERE AND THAT IS THE DRIVER'S JOB TO AVOID.
					// `cfwSqlExec` has no rollback, so there is no way to run this locally and discard
					// it; the driver replays an unbuffered write as a one-statement transaction so it
					// arrives on the branch above. Reaching this means the two disagree about whether
					// this connection holds a residue class, and a failover is the safe answer
					refuse(
						name,
						name === 'cfwSqlExec'
							? 'a write on the exec bridge cannot be rolled back, so it cannot be forwarded'
							: 'the transaction payload could not be downgraded'
					);
				}
				collect!(statements!, args[0]);
				mutated = true;
				try {
					return inner(payload, ...args.slice(1));
				} finally {
					mutated = false;
				}
			}
			mutated = true;
			try {
				return inner(...args);
			} finally {
				mutated = false;
			}
		};
	}

	return { wrapped, refusals, didMutate: () => mutated };
}
