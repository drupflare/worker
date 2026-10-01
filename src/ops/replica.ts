/**
 * What a read replica may do to itself, and what it must refuse and send to the primary.
 *
 * Two allow-lists and no deny-list: a table is authoritative unless named local, a statement is a
 * write unless proven a read, a capability is mutating unless named safe. A deny-list misses the
 * write nobody thought of, which a replica would commit silently. {@link enforceReadOnly} walks the
 * capabilities installed on the module, not `CROSSING_NAMES`, which has drifted (`cfwOidcClaims`
 * and `cfwTcp` mutate and never joined it).
 *
 * @module
 */

import type { TxnRequest } from '@drupflare/durabledb/do-sqlite';
import { STORAGE_TABLE_PREFIX, writeTargetTable } from '../db/write-tally';

/**
 * Tables a replica may write to itself with nothing lost if the write is discarded.
 *
 * `cache_` covers rebuildable bins; `?storage.` is {@link STORAGE_TABLE_PREFIX} (per-object
 * bookkeeping). The set is not `cfw_`: that would sweep in the authoritative `cfw_mail_queue`,
 * `cfw_file` and `cfw_http_queue`.
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

/** whether a write to `table` is safe for a replica to keep and discard */
export function isReplicaLocalTable(table: string): boolean {
	if (REPLICA_LOCAL_TABLES.has(table)) return true;
	return REPLICA_LOCAL_PREFIXES.some((prefix) => table.startsWith(prefix));
}

/**
 * `EXPIRED_ROW_RULES` in `cron.ts` minus `queue` (a queue item is pending work, not an expired
 * copy); copied because `cron.ts` pulls PHP fragments onto the front worker's routing path.
 * `tests/unit/ops/replica.spec.ts` fails when the lists disagree.
 */
const EXPIRY_GC: ReadonlyArray<{ table: string; column: string }> = [
	{ table: 'sessions', column: 'timestamp' },
	{ table: 'flood', column: 'expiration' },
	{ table: 'key_value_expire', column: 'expire' },
	{ table: 'batch', column: 'timestamp' },
	{ table: 'semaphore', column: 'expire' }
];

/**
 * The table an expiry-GC delete sweeps, or `undefined` when the statement is not one.
 *
 * Writing a session row is authoritative but the expiry delete is the primary's own cron rule, so a
 * replica running it loses nothing. Anchored at both ends: any extra predicate stays authoritative.
 */
export function expiryGcTable(sql: string): string | undefined {
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
	return undefined;
}

/**
 * Whether every write statement a tally recorded against `table` was an expiry sweep of it.
 *
 * `shapes` is capped, so this fails closed: missing shapes, a non-sweep shape or a count that does
 * not add up to the recorded statements all report the table.
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
 * The authoritative half of a write tally. Rows and statements both: a `DELETE` matching nothing
 * writes no rows here but could match on an object whose state differs.
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
 * Whether a statement is proven to be a read; unrecognised answers false. `writeTargetTable()`
 * cannot serve: it answers undefined for both a read and an unparsed write. `WITH` is refused
 * because SQLite accepts a CTE before a write.
 */
export function isProvenRead(sql: string): boolean {
	const text = sql.trim();
	// exported, so guard the compound here too
	if (compound(text)) return false;
	if (/^SELECT\b/i.test(text)) return true;
	if (/^EXPLAIN\b/i.test(text)) return true;
	// the introspection forms Drupal's schema handler uses; `PRAGMA x = y` sets and is refused
	if (/^PRAGMA\s+[A-Za-z_]+\s*\(/i.test(text)) return true;
	return false;
}

/**
 * Whether the text carries more than one statement. `sql.exec()` runs them all but the classifiers
 * read only the leading keyword, so `SELECT 1; DELETE FROM users` would pass as a read. A literal
 * `;` in the text costs a hop to the primary, not a wrong answer; one trailing separator is fine.
 */
function compound(text: string): boolean {
	return text.replace(/;\s*$/, '').includes(';');
}

/**
 * Whether a replica may run this statement against its own database.
 *
 * Allowed: a proven read, an expiry sweep, or a write to a replica-local table (so a replica can
 * fill its own cache bins). Fail-closed: an unparsed target refuses.
 */
export function statementAllowedOnReplica(sql: string): boolean {
	if (compound(String(sql ?? '').trim())) return false;
	if (isProvenRead(sql)) return true;
	if (expiryGcTable(sql) !== undefined) return true;
	const target = writeTargetTable(sql);
	return target !== undefined && isReplicaLocalTable(target);
}

/**
 * The generation fence: whether a replica's view is fresh enough to answer.
 *
 * A replica may serve generation G only if its view is valid through G; behind by any amount
 * refuses. It relies on the generation advancing on every change that matters
 * (`tests/integration/generation-fence.spec.ts`); an unbumped mutation is invisible to it.
 */
export function fenceAllows(appliedGeneration: number, requiredGeneration: number): boolean {
	if (!Number.isFinite(appliedGeneration) || !Number.isFinite(requiredGeneration)) return false;
	return appliedGeneration >= requiredGeneration;
}

/**
 * Drupal's own session id, which is what `sessions.sid` holds.
 *
 * `SessionHandler::read()` keys on `Crypt::hashBase64($sid)` (base64 of the raw sha256, `+/` to
 * `-_`, padding stripped), never the cookie value. Golden vector from a deployed site:
 * `78e0948463...` hashes to `TIkEn6fkVm-NaFDE5eDlIfIXxgfFJXI2XRRnMxjurwI`.
 */
export async function drupalSessionRowId(cookieValue: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cookieValue));
	let raw = '';
	for (const byte of new Uint8Array(digest)) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** why a replica refused; the sentence a caller logs and the reason it fails over */
export class ReplicaRequiresPrimary extends Error {
	/** the refused capability name */
	readonly capability: string;
	/** why it needs the primary */
	readonly detail: string;
	constructor(capability: string, detail: string) {
		super(`${capability} requires the primary: ${detail}`);
		this.name = 'ReplicaRequiresPrimary';
		this.capability = capability;
		this.detail = detail;
	}
}

/**
 * Capabilities a replica may serve itself: pure functions or reads of replica-local state;
 * anything absent is mutating and refused. `cfwLog` only appends to an in-memory ring and
 * `console.log`, never a watchdog row.
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
	// reads replicated `cfw_module_rev` rows; sibling `cfwSettings` is absent (writes account KV)
	'cfwModules',
	// classified per statement rather than wholesale; see below
	'cfwSqlExec',
	'cfwSqlTxn'
]);

/** `per-call` is classified by statement; `mutating` is refused outright */
export type CapabilityVerdict = 'safe' | 'per-call' | 'mutating';

/** the verdict for a bridge capability name; unnamed means mutating */
export function classifyCapability(name: string): CapabilityVerdict {
	if (name === 'cfwSqlExec' || name === 'cfwSqlTxn') return 'per-call';
	return REPLICA_SAFE_CAPABILITIES.has(name) ? 'safe' : 'mutating';
}

/** the one binding that puts an object into replica mode; absent or `'0'` means primary */
export type ReplicaEnv = { REPLICA_READ_ONLY?: string | undefined };

/** whether `REPLICA_READ_ONLY` is `'1'` */
export function replicaReadOnly(env?: ReplicaEnv): boolean {
	return String(env?.REPLICA_READ_ONLY ?? '') === '1';
}

/** what {@link enforceReadOnly} did, so a caller can assert the surface was actually covered */
export type ReadOnlyGuard = {
	/** every capability the guard wrapped, with its verdict */
	wrapped: Record<string, CapabilityVerdict>;
	/** refusals so far this request, most recent last */
	refusals: ReplicaRequiresPrimary[];
	/** whether a mutating inner function was reached; must be false before a primary retry */
	didMutate: () => boolean;
};

/** the payload shape both SQL capabilities are handed: a JSON string */
function parseJson(json: unknown): unknown {
	if (typeof json !== 'string') return undefined;
	try {
		return JSON.parse(json) ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Reads the statement text out of a `cfwSqlExec` payload.
 *
 * Only the `sql` field is read; it is a plain string on both sides of the codec, so no decode.
 */
function execStatements(json: unknown): string[] | undefined {
	const body = parseJson(json) as { sql?: unknown } | undefined;
	if (body === undefined || typeof body.sql !== 'string') return undefined;
	return [body.sql];
}

/** every statement in a `cfwSqlTxn` payload, including the speculative read */
function txnStatements(json: unknown): string[] | undefined {
	const body = parseJson(json) as Partial<TxnRequest> | undefined;
	if (body === undefined || !Array.isArray(body.statements)) return undefined;
	const out: string[] = [];
	for (const statement of body.statements) {
		if (typeof statement?.sql !== 'string') return undefined;
		out.push(statement.sql);
	}
	// the speculative read is checked too; nothing here is trusted by construction (PHP sends
	// `"read": null` when there is none)
	if (body.read !== undefined && body.read !== null) {
		if (typeof body.read.sql !== 'string') return undefined;
		out.push(body.read.sql);
	}
	return out;
}

/**
 * The same transaction payload with `commit` forced off, or undefined when it cannot be read.
 *
 * Returned as a JSON string, as handed in; editing the object would mutate the caller's copy.
 */
export function speculative(json: unknown): string | undefined {
	const body = parseJson(json) as Partial<TxnRequest> | undefined;
	if (body === undefined || !Array.isArray(body.statements)) return undefined;
	return JSON.stringify({ ...body, commit: false });
}

/**
 * Makes a replica unable to commit an authoritative side effect by wrapping the installed surface,
 * so a later capability is refused until classified. A refusal throws before the inner call.
 *
 * @param binary - the instantiated PHP module, mutated in place
 * @param onRefusal - called with each refusal before it is thrown
 * @param collect - turns an SQL refusal into forwarding: the mutating transaction runs on the
 *   driver's speculative path (rolled back) and its statements go here for the primary to commit;
 *   only SQL forwards, since a sent mail has no rollback
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
		// skip flags like `cfwCanSuspend`: wrapping one hands PHP a callable that reads true
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
			// refuse an unreadable payload; the guard cannot see what it would authorise
			if (statements === undefined) refuse(name, 'the statement payload could not be read');
			const write = statements!.find((sql) => !statementAllowedOnReplica(sql));
			if (write !== undefined) {
				if (collect === undefined) {
					refuse(
						name,
						`not a read and not replica-local: ${write.replace(/\s+/g, ' ').trim().slice(0, 120)}`
					);
				}
				// run speculatively (`commit: false`, rolled back) so PHP reads its own write
				const payload = speculative(args[0]);
				if (payload === undefined) {
					// `cfwSqlExec` has no rollback and the driver sends writes as transactions
					refuse(
						name,
						name === 'cfwSqlExec'
							? 'a write on the exec bridge cannot be rolled back, so it cannot be forwarded'
							: 'the transaction payload could not be downgraded'
					);
				}
				// a replay resends the whole buffer beside each read; collect only the commit
				if ((parseJson(args[0]) as Partial<TxnRequest> | undefined)?.commit !== false) {
					collect!(statements!, args[0]);
				}
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
