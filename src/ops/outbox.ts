/**
 * The durable outbox the worker's outside effects run through: mail, outbound HTTP and Redis, and
 * the cron firing. One table per lane, so a lane drains only its own rows, each with its own
 * effect, width and lease.
 *
 * The rules are folio's: a row is claimed and flushed before its effect runs, so a successor that
 * finds a running row with an expired lease knows the effect may have run. A `resend` kind runs
 * again with the same key (at least once, dedupable by the receiver), a `report` kind ends as
 * `failed` and never runs again (at most once). A kind with no policy is `report`.
 * @module
 */

import { Outbox, PermanentError, type OutboxEffect, type TaskRow } from '@gmitch215/folio/workers';

export type { OutboxContext, OutboxEffect, TaskRow } from '@gmitch215/folio/workers';
export { Outbox, PermanentError };

/** the SQL handle an outbox takes: `ctx.storage.sql`, or any `exec()` with a `toArray()` cursor */
export type OutboxSql = ConstructorParameters<typeof Outbox>[0];

/** one outbox table per lane */
export const OUTBOX_TABLES = {
	mail: 'cfw_outbox_mail',
	http: 'cfw_outbox_http',
	cron: 'cfw_outbox_cron'
} as const;

export type OutboxLane = keyof typeof OUTBOX_TABLES;

/**
 * What a successor does with a running row whose lease ended, by kind.
 *
 * `mail` and `http` carry a key the receiver can drop a repeat by (an SMTP `Message-ID`, an
 * `Idempotency-Key`). `redis` is a command that is not safe to repeat; `redis-idempotent` is one
 * that is. `cron` is a firing that ran a PHP hook, `cron-idempotent` one that ran only SQL passes.
 */
export const OUTBOX_POLICIES = {
	mail: 'resend',
	http: 'resend',
	redis: 'report',
	'redis-idempotent': 'resend',
	cron: 'report',
	'cron-idempotent': 'resend'
} as const;

/** the most `report` rows a lane keeps for an operator before the oldest are forgotten */
export const REPORTED_KEEP = 50;

/** what an operator reads next to a reported row */
export const REPORTED_HINT =
	'the effect may have run: check the receiver before re-enqueueing under a new id';

export interface OpenOptions {
	/** resolves once earlier writes survive a reset: `() => ctx.storage.sync()` in the object */
	flush?: () => Promise<void>;
	/** rows run at once; one by default */
	width?: number;
	/** the lease of a claim in ms; 15,000 by default, 5,000 at least */
	leaseMs?: number;
	/** executions a row may start before it fails; 3 by default */
	maxAttempts?: number;
	now?: () => number;
}

/** opens one lane's outbox over `sql`; the effect decides what each kind does */
export function openOutbox(
	sql: OutboxSql,
	lane: OutboxLane,
	effect: OutboxEffect,
	options: OpenOptions = {}
): Outbox {
	return new Outbox(sql, {
		table: OUTBOX_TABLES[lane],
		policies: OUTBOX_POLICIES,
		effect,
		...(options.flush ? { flush: options.flush } : {}),
		...(options.width ? { width: options.width } : {}),
		...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
		...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
		...(options.now ? { clock: { now: options.now } } : {})
	});
}

/** whether a failed row is one a `report` policy ended, which is the operator's to read */
export function isReported(row: Pick<TaskRow, 'state' | 'error'>): boolean {
	return row.state === 'failed' && (row.error ?? '').includes('policy report');
}

/** the text of a row's args, which every lane writes as JSON text */
export function argsText(row: Pick<TaskRow, 'args'>): string {
	return typeof row.args === 'string' ? row.args : new TextDecoder().decode(row.args);
}

/** the text of a row's result, or an empty string while it has none */
export function resultText(row: Pick<TaskRow, 'result'>): string {
	if (row.result === null) return '';
	return typeof row.result === 'string' ? row.result : new TextDecoder().decode(row.result);
}

/** removes finished rows, so the table holds only open rows and what an operator has not read */
export function forgetRows(sql: OutboxSql, lane: OutboxLane, ids: readonly string[]): void {
	if (ids.length === 0) return;
	sql.exec(
		`DELETE FROM ${OUTBOX_TABLES[lane]} WHERE id IN (SELECT value FROM json_each(?))`,
		JSON.stringify(ids)
	);
}

/**
 * Keeps the newest {@link REPORTED_KEEP} reported rows of a lane and forgets the older ones, so an
 * unread report cannot grow the table without bound.
 */
export function trimReported(sql: OutboxSql, lane: OutboxLane): void {
	const table = OUTBOX_TABLES[lane];
	sql.exec(
		`DELETE FROM ${table} WHERE state = 'failed' AND error LIKE '%policy report%' AND id NOT IN (SELECT id FROM ${table} WHERE state = 'failed' AND error LIKE '%policy report%' ORDER BY seq DESC LIMIT ?)`,
		REPORTED_KEEP
	);
}

/** a reported row as the ops status shows it */
export interface ReportedRow {
	lane: OutboxLane;
	id: string;
	kind: string | null;
	error: string;
	hint: string;
}

/**
 * The rows `report` ended in the given lanes, for the ops status. A lane whose table does not
 * exist yet has none; reading never creates a table.
 */
export function reportedRows(
	sql: OutboxSql,
	lanes: readonly OutboxLane[] = ['mail', 'http', 'cron']
): ReportedRow[] {
	const out: ReportedRow[] = [];
	for (const lane of lanes) {
		const table = OUTBOX_TABLES[lane];
		const present = sql
			.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table)
			.toArray();
		if (present.length === 0) continue;
		const rows = sql
			.exec(
				`SELECT id, kind, error FROM ${table} WHERE state = 'failed' AND error LIKE '%policy report%' ORDER BY seq`
			)
			.toArray();
		for (const row of rows) {
			out.push({
				lane,
				id: String(row.id),
				kind: row.kind === null ? null : String(row.kind),
				error: String(row.error ?? ''),
				hint: REPORTED_HINT
			});
		}
	}
	return out;
}

/**
 * The operator's re-enqueue of a reported row: the same kind and args under a new id, and the
 * reported row forgotten. It is for after the operator has checked the receiver; the outbox never
 * does it on its own. Returns false when `id` is not a reported row or `newId` already exists.
 */
export async function reenqueueReported(
	outbox: Outbox,
	sql: OutboxSql,
	lane: OutboxLane,
	id: string,
	newId: string
): Promise<boolean> {
	const row = outbox.results().find((r) => r.id === id);
	if (!row || !isReported(row) || row.kind === null) return false;
	if (outbox.results().some((r) => r.id === newId)) return false;
	const added = await outbox.enqueue([{ id: newId, kind: row.kind, args: row.args }]);
	if (added !== 1) return false;
	forgetRows(sql, lane, [id]);
	return true;
}
