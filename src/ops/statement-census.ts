/**
 * Decomposes the PHP-to-host crossings of ONE render into statements, and classifies each.
 *
 * WHY IT EXISTS: `crossings.ts` answers "how many" and stops there. It measured a warm render at 48
 * crossings, every one of them `cfwSqlExec`, and closed the BATCHING mechanism -- correctly, because
 * Drupal's read path is read-decide-read. RULE 0c says a dead mechanism does not close the resource,
 * and the resource here is the 48 statements themselves. Nothing could act on that number without
 * knowing which statements they are, so this is the instrument that names them.
 *
 * WHAT A CATEGORY IS. The five are a PARTITION over statements, first match wins, so the counts sum
 * to the total and a statement cannot be reported twice. The order encodes which finding is more
 * actionable when a statement qualifies for two: a repeat of an identical query is a duplicate even
 * when it is also a cache miss, because deduplicating it removes the miss as well.
 *
 * WHAT IT DELIBERATELY DOES NOT MEASURE: time. A record carries counts and bytes only. RULE 0 --
 * an absolute CPU figure comes only from `cpuTime` on a deployed worker, and a count is the same
 * number locally and on the edge.
 */

import { writeTargetTable } from '../db/write-tally.js';

/** one statement, decomposed far enough to classify it */
export type CensusCall = {
	/** the capability crossed for; `cfwSqlExec` and `cfwSqlTxn` are the only ones carrying SQL */
	name: string;
	/** the statement's shape, literals and bindings normalised to `?`; null when it carried no SQL */
	fingerprint: string | null;
	table: string | null;
	/** rows SQLite touched, which is what the row-read meter charges */
	rowsRead: number;
	rowsWritten: number;
	/** rows handed back across the bridge, which is not `rowsRead` */
	rows: number;
	/** bytes the host returned, so a cheap statement with an expensive reply is visible */
	resultBytes: number;
	/** true when the statement arrived inside a `cfwSqlTxn` batch rather than on its own */
	viaTxn: boolean;
};

/**
 * The statement's shape: every literal, bound value and placeholder list normalised to `?`.
 *
 * Placeholder GROUPS collapse too (`IN ( :a, :b )` -> `IN (?)`, `VALUES (?), (?)` -> `VALUES (?)`),
 * because a cache `getMultiple()` for one cid and one for seven are the same query asked twice. The
 * arity has to go for that to work: Drupal spells a one-element `IN` as `( :a )` and a two-element
 * one as `( :a, :b )`, and a fingerprint that keeps the difference splits six reads of one bin into
 * two "distinct operations", which is what the first run of this instrument did.
 */
export function fingerprint(sql: string): string {
	return String(sql ?? '')
		.replace(/'(?:[^']|'')*'/g, '?')
		.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '?')
		.replace(/\b\d+(?:\.\d+)?\b/g, '?')
		.replace(/\(\s*\?(?:\s*,\s*\?)*\s*\)/g, '(?)')
		.replace(/\(\?\)(?:\s*,\s*\(\?\))+/g, '(?)')
		.replace(/\s+/g, ' ')
		.trim();
}

/** quoting stripped, so `"main"."cache_default"` and `cache_default` are one table rather than two */
const unquote = (sql: string) => String(sql ?? '').replace(/["`[\]]/g, '');

/**
 * The table a statement reads or writes.
 *
 * Reuses `writeTargetTable()` for the write forms rather than restating them, and adds the read
 * form. Drupal emits both the qualified and the bare spelling for the same table, and treating them
 * as two would hide the repetition this instrument exists to find.
 */
export function targetTable(sql: string): string | null {
	const bare = unquote(sql);
	const table = writeTargetTable(bare) ?? /\bFROM\s+([A-Za-z0-9_.]+)/i.exec(bare)?.[1] ?? null;
	return table === null ? null : table.replace(/^main\./i, '');
}

/** a statement that changes rows, decided from its text rather than from what it happened to write */
export const isWriteStatement = (sql: string | null): boolean =>
	sql !== null && writeTargetTable(unquote(sql)) !== null;

/** the shared cache bins, whose read returning nothing is a MISS rather than an absence */
const isCacheBin = (table: string | null) => table !== null && /^cache_/.test(table);

function parseJson(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'string') return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (parsed === null || typeof parsed !== 'object') return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function statementRecord(
	name: string,
	sql: unknown,
	result: Record<string, unknown> | null,
	resultBytes: number,
	viaTxn: boolean
): CensusCall {
	const text = typeof sql === 'string' ? sql : '';
	return {
		name,
		fingerprint: text === '' ? null : fingerprint(text),
		table: text === '' ? null : targetTable(text),
		rowsRead: num(result?.rowsRead),
		rowsWritten: num(result?.rowsWritten),
		rows: Array.isArray(result?.rows) ? result.rows.length : 0,
		resultBytes,
		viaTxn
	};
}

/**
 * Records one crossing as one or more statements.
 *
 * A `cfwSqlTxn` crossing carries a whole buffered transaction, so it yields N records and the
 * statement count runs ahead of the crossing count. Both numbers are reported rather than one
 * standing in for the other -- a crossing is the bridge cost and a statement is the database cost,
 * and the replay path is exactly where they diverge.
 *
 * A crossing whose payload does not parse is recorded with a null fingerprint rather than dropped. A
 * dropped record would make the census tidier than the measurement, which is the failure mode this
 * project keeps finding in its own instruments.
 */
export function recordCrossing(
	log: CensusCall[],
	name: string,
	arg: unknown,
	result: unknown
): void {
	const resultBytes = typeof result === 'string' ? result.length : 0;
	const request = parseJson(arg);
	const reply = parseJson(result);

	if (name === 'cfwSqlExec') {
		log.push(statementRecord(name, request?.sql, reply, resultBytes, false));
		return;
	}
	if (name === 'cfwSqlTxn') {
		const statements = Array.isArray(request?.statements) ? request.statements : [];
		const results = Array.isArray(reply?.results) ? reply.results : [];
		if (statements.length === 0) {
			log.push(statementRecord(name, null, reply, resultBytes, true));
			return;
		}
		statements.forEach((statement, i) => {
			const one = (results[i] ?? null) as Record<string, unknown> | null;
			const sql = (statement as Record<string, unknown> | null)?.sql;
			// a batch's framing cannot be split N ways honestly, so each statement carries the size
			// of ITS reply and nothing carries the envelope
			log.push(
				statementRecord(name, sql, one, one === null ? 0 : JSON.stringify(one).length, true)
			);
		});
		return;
	}
	log.push(statementRecord(name, null, reply, resultBytes, false));
}

/**
 * The five buckets, in the order a statement is tested against them.
 *
 * - `bridge` -- a crossing carrying no SQL at all: setup, teardown, a capability call.
 * - `duplicate` -- this exact fingerprint already ran in this render.
 * - `cache-miss` -- a read of a `cache_*` bin that came back with no rows.
 * - `repeated-table` -- a read whose table is also read by a DIFFERENT fingerprint in this render.
 * - `necessary` -- everything left: one distinct operation against a table nothing else reads.
 */
export type CensusCategory = 'bridge' | 'duplicate' | 'cache-miss' | 'repeated-table' | 'necessary';

export const CENSUS_CATEGORIES: CensusCategory[] = [
	'bridge',
	'duplicate',
	'cache-miss',
	'repeated-table',
	'necessary'
];

/** one fingerprint and everything the render spent on it */
export type CensusRow = {
	fingerprint: string;
	name: string;
	table: string | null;
	count: number;
	rowsRead: number;
	rowsWritten: number;
	rows: number;
	resultBytes: number;
	/** the category of the FIRST occurrence; every later one is `duplicate` by construction */
	category: CensusCategory;
};

export type Census = {
	statements: number;
	/** distinct fingerprints, which is the floor a perfect deduplication would reach */
	distinct: number;
	rows: CensusRow[];
	byCategory: Record<CensusCategory, number>;
	byTable: Record<string, { statements: number; rowsRead: number; rowsWritten: number }>;
	totals: { rowsRead: number; rowsWritten: number; resultBytes: number };
};

function classify(call: CensusCall, readsByTable: Map<string, Set<string>>): CensusCategory {
	if (call.fingerprint === null) return 'bridge';
	if (isWriteStatement(call.fingerprint)) return 'necessary';
	if (isCacheBin(call.table) && call.rows === 0) return 'cache-miss';
	if (call.table !== null && (readsByTable.get(call.table)?.size ?? 0) > 1)
		return 'repeated-table';
	return 'necessary';
}

/**
 * Aggregates a render's statements by fingerprint and classifies each one.
 *
 * The classification needs the WHOLE render before it can answer, which is why it is a function over
 * the finished log rather than a field set at record time: `repeated-table` is a property of the set,
 * and a statement cannot know whether a later one will read its table.
 */
export function census(log: CensusCall[]): Census {
	const readsByTable = new Map<string, Set<string>>();
	for (const call of log) {
		if (call.fingerprint === null || call.table === null) continue;
		if (isWriteStatement(call.fingerprint)) continue;
		const seen = readsByTable.get(call.table) ?? new Set<string>();
		seen.add(call.fingerprint);
		readsByTable.set(call.table, seen);
	}

	const byCategory = Object.fromEntries(CENSUS_CATEGORIES.map((c) => [c, 0])) as Record<
		CensusCategory,
		number
	>;
	const byTable: Census['byTable'] = {};
	const rows = new Map<string, CensusRow>();
	const totals = { rowsRead: 0, rowsWritten: 0, resultBytes: 0 };

	for (const call of log) {
		totals.rowsRead += call.rowsRead;
		totals.rowsWritten += call.rowsWritten;
		totals.resultBytes += call.resultBytes;

		const key = call.fingerprint ?? `<${call.name}>`;
		const existing = rows.get(key);
		if (existing) {
			existing.count += 1;
			existing.rowsRead += call.rowsRead;
			existing.rowsWritten += call.rowsWritten;
			existing.rows += call.rows;
			existing.resultBytes += call.resultBytes;
			byCategory.duplicate += 1;
		} else {
			const category = classify(call, readsByTable);
			rows.set(key, {
				fingerprint: key,
				name: call.name,
				table: call.table,
				count: 1,
				rowsRead: call.rowsRead,
				rowsWritten: call.rowsWritten,
				rows: call.rows,
				resultBytes: call.resultBytes,
				category
			});
			byCategory[category] += 1;
		}

		if (call.table !== null) {
			const bucket = byTable[call.table] ?? { statements: 0, rowsRead: 0, rowsWritten: 0 };
			bucket.statements += 1;
			bucket.rowsRead += call.rowsRead;
			bucket.rowsWritten += call.rowsWritten;
			byTable[call.table] = bucket;
		}
	}

	return {
		statements: log.length,
		distinct: rows.size,
		rows: [...rows.values()].sort((a, b) => b.count - a.count || b.rowsRead - a.rowsRead),
		byCategory,
		byTable,
		totals
	};
}
