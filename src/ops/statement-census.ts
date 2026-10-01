/**
 * Decomposes the PHP-to-host crossings of one render into statements, and classifies each.
 *
 * The five categories partition the statements (first match wins). Counts and bytes only, never
 * time, because a count is the same locally and on the edge.
 *
 * @module
 */
import { writeTargetTable } from '../db/write-tally';

/** one statement, decomposed far enough to classify it */
export type CensusCall = {
	/** the capability crossed for; `cfwSqlExec` and `cfwSqlTxn` are the only ones carrying SQL */
	name: string;
	/** the statement's shape with literals and bindings as `?`; null when it carried no SQL */
	fingerprint: string | null;
	/** the table read or written */
	table: string | null;
	/** rows SQLite touched, which is what the row-read meter charges */
	rowsRead: number;
	/** rows written */
	rowsWritten: number;
	/** rows handed back across the bridge, which is not `rowsRead` */
	rows: number;
	/** bytes the host returned, so a cheap statement with an expensive reply is visible */
	resultBytes: number;
	/** true when the statement arrived inside a `cfwSqlTxn` batch rather than on its own */
	viaTxn: boolean;
	/** the first bound parameter when short (a cid on a cache bin); later ones are payload */
	key: string | null;
};

// the longest cid kept (a `cache_render` cid carries its cache contexts and passes 200 chars)
const MAX_KEY_CHARS = 512;

// an object as well as an array: Drupal binds named placeholders, and insertion order is bind order
function firstKey(params: unknown): string | undefined {
	const list = Array.isArray(params)
		? params
		: params !== null && typeof params === 'object'
			? Object.values(params as Record<string, unknown>)
			: [];
	const head = list[0];
	if (typeof head !== 'string' || head.length === 0 || head.length > MAX_KEY_CHARS) {
		return undefined;
	}
	return head;
}

/**
 * The statement's shape: every literal, bound value and placeholder list normalised to `?`, with
 * placeholder groups collapsed whatever their arity.
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

// quoting stripped, so `"main"."cache_default"` and `cache_default` are one table
const unquote = (sql: string) => String(sql ?? '').replace(/["`[\]]/g, '');

/**
 * The table a statement reads or writes, via `writeTargetTable()` plus the `FROM` form, with
 * `main.` dropped so both spellings count as one table.
 */
export function targetTable(sql: string): string | undefined {
	const bare = unquote(sql);
	const table = writeTargetTable(bare) ?? /\bFROM\s+([A-Za-z0-9_.]+)/i.exec(bare)?.[1];
	return table ? table.replace(/^main\./i, '') : undefined;
}

/** a statement that changes rows, decided from its text rather than its row count */
export const isWriteStatement = (sql: string | null): boolean =>
	sql !== null && writeTargetTable(unquote(sql)) !== undefined;

// a cache bin read that returns nothing is a miss rather than an absence
const isCacheBin = (table: string | null) => table !== null && /^cache_/.test(table);

/**
 * Which part of Drupal asked for a statement; a shared bin names a location, not a caller.
 */
export type Subsystem =
	| 'render'
	| 'page-assembly'
	| 'routing'
	| 'menu'
	| 'assets'
	| 'config'
	| 'theme'
	| 'entity'
	| 'cache-tags'
	| 'host'
	| 'other';

/** every {@link Subsystem}, in report order */
export const SUBSYSTEMS: Subsystem[] = [
	'render',
	'page-assembly',
	'routing',
	'menu',
	'assets',
	'config',
	'theme',
	'entity',
	'cache-tags',
	'host',
	'other'
];

// cid prefixes observed in census runs, tried before the table; first match wins
const KEY_RULES: Array<[RegExp, Subsystem]> = [
	[/^entity_view:/, 'render'],
	[/^response:/, 'page-assembly'],
	[/^route:/, 'routing'],
	[/^(css|js):/, 'assets'],
	[/^library_info/, 'assets'],
	[/^active-trail:/, 'menu'],
	[/^local_task_plugins/, 'menu'],
	[/^twig:/, 'theme'],
	[/^theme\./, 'theme'],
	[/^config[:.]/, 'config'],
	[/field_storage_definitions/, 'entity']
];

// the bin or table's owner, used when a statement carries no cid
const TABLE_RULES: Array<[RegExp, Subsystem]> = [
	[/^cfw_/, 'host'],
	[/^cache_(dynamic_page_cache|page)$/, 'page-assembly'],
	[/^cache_render$/, 'render'],
	[/^(router|path_alias|cache_routes)$/, 'routing'],
	[/^(menu_tree|cache_menu)$/, 'menu'],
	[/^(cache_config|key_value|key_value_expire|config)$/, 'config'],
	[/^cache_bootstrap$/, 'theme'],
	[/^cachetags$/, 'cache-tags'],
	[/_field_data$|_field_revision$|^node$|^users$/, 'entity']
];

/**
 * The subsystem a statement belongs to; the cid decides when there is one, and a shared bin with
 * no cid stays `other` rather than getting an invented owner.
 */
export function subsystemOf(table: string | null, key: string | null = null): Subsystem {
	if (key !== null) {
		for (const [pattern, subsystem] of KEY_RULES) if (pattern.test(key)) return subsystem;
	}
	if (table !== null) {
		for (const [pattern, subsystem] of TABLE_RULES) if (pattern.test(table)) return subsystem;
	}
	return 'other';
}

function parseJson(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== 'string') return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		if (parsed === null || typeof parsed !== 'object') return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function statementRecord(
	name: string,
	sql: unknown,
	params: unknown,
	result: Record<string, unknown> | undefined,
	resultBytes: number,
	viaTxn: boolean
): CensusCall {
	const text = typeof sql === 'string' ? sql : '';
	return {
		name,
		fingerprint: text === '' ? null : fingerprint(text),
		table: text === '' ? null : (targetTable(text) ?? null),
		rowsRead: num(result?.rowsRead),
		rowsWritten: num(result?.rowsWritten),
		rows: Array.isArray(result?.rows) ? result.rows.length : 0,
		resultBytes,
		viaTxn,
		key: firstKey(params) ?? null
	};
}

/**
 * Records one crossing as one or more statements (a `cfwSqlTxn` carries a whole transaction); an
 * unparseable payload keeps a null fingerprint rather than being dropped.
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
		log.push(statementRecord(name, request?.sql, request?.params, reply, resultBytes, false));
		return;
	}
	if (name === 'cfwSqlTxn') {
		const statements = Array.isArray(request?.statements) ? request.statements : [];
		const results = Array.isArray(reply?.results) ? reply.results : [];
		if (statements.length === 0) {
			log.push(statementRecord(name, null, null, reply, resultBytes, true));
			return;
		}
		statements.forEach((statement, i) => {
			const one = results[i] as Record<string, unknown> | undefined;
			const entry = statement as Record<string, unknown> | undefined;
			// each statement carries its own reply size; nothing carries the batch envelope
			log.push(
				statementRecord(
					name,
					entry?.sql,
					entry?.params,
					one,
					one === undefined ? 0 : JSON.stringify(one).length,
					true
				)
			);
		});
		return;
	}
	log.push(statementRecord(name, null, null, reply, resultBytes, false));
}

/**
 * The five buckets in test order: `bridge` (no SQL), `duplicate`, `cache-miss` (empty `cache_*`
 * read), `repeated-table` (same table, other fingerprint), `necessary`.
 */
export type CensusCategory = 'bridge' | 'duplicate' | 'cache-miss' | 'repeated-table' | 'necessary';

/** every {@link CensusCategory}, in test order */
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
	/** the category of the first occurrence; every later one is `duplicate` */
	category: CensusCategory;
	/** distinct first-parameter cids seen under this fingerprint, capped */
	keys: string[];
	/** distinct cids, uncapped; `count - distinctKeys` is the reducible repetition */
	distinctKeys: number;
	/** the first occurrence's subsystem, a label only; {@link Census.bySubsystem} has the split */
	subsystem: Subsystem;
};

/** what one subsystem spent, summed per statement rather than per fingerprint */
export type SubsystemSpend = {
	statements: number;
	rowsRead: number;
	rowsWritten: number;
	resultBytes: number;
};

// cids kept per fingerprint; enough to name the callers
const MAX_KEYS_PER_ROW = 8;

/** one render's statements aggregated by fingerprint, category, table and subsystem */
export type Census = {
	statements: number;
	/** distinct fingerprints, which is the floor a perfect deduplication would reach */
	distinct: number;
	rows: CensusRow[];
	byCategory: Record<CensusCategory, number>;
	byTable: Record<string, { statements: number; rowsRead: number; rowsWritten: number }>;
	/** per statement, so a shared bin's traffic lands on the callers rather than on the bin */
	bySubsystem: Record<Subsystem, SubsystemSpend>;
	totals: { rowsRead: number; rowsWritten: number; resultBytes: number };
};

// appends a cid once, silently stopping at the cap
function addKey(keys: string[], key: string | null): void {
	if (key === null || keys.length >= MAX_KEYS_PER_ROW || keys.includes(key)) return;
	keys.push(key);
}

function classify(call: CensusCall, readsByTable: Map<string, Set<string>>): CensusCategory {
	if (call.fingerprint === null) return 'bridge';
	if (isWriteStatement(call.fingerprint)) return 'necessary';
	if (isCacheBin(call.table) && call.rows === 0) return 'cache-miss';
	if (call.table !== null && (readsByTable.get(call.table)?.size ?? 0) > 1)
		return 'repeated-table';
	return 'necessary';
}

/**
 * Aggregates a render's statements by fingerprint and classifies each, over the finished log
 * because `repeated-table` depends on later statements.
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
	const bySubsystem = Object.fromEntries(
		SUBSYSTEMS.map((s) => [s, { statements: 0, rowsRead: 0, rowsWritten: 0, resultBytes: 0 }])
	) as Record<Subsystem, SubsystemSpend>;
	const rows = new Map<string, CensusRow>();
	const seenKeys = new Map<string, Set<string>>();
	const totals = { rowsRead: 0, rowsWritten: 0, resultBytes: 0 };

	for (const call of log) {
		totals.rowsRead += call.rowsRead;
		totals.rowsWritten += call.rowsWritten;
		totals.resultBytes += call.resultBytes;

		const spend = bySubsystem[subsystemOf(call.table, call.key)];
		spend.statements += 1;
		spend.rowsRead += call.rowsRead;
		spend.rowsWritten += call.rowsWritten;
		spend.resultBytes += call.resultBytes;

		const key = call.fingerprint ?? `<${call.name}>`;
		const distinct = seenKeys.get(key) ?? new Set<string>();
		if (call.key !== null) distinct.add(call.key);
		seenKeys.set(key, distinct);
		const existing = rows.get(key);
		if (existing) {
			existing.count += 1;
			existing.rowsRead += call.rowsRead;
			existing.rowsWritten += call.rowsWritten;
			existing.rows += call.rows;
			existing.resultBytes += call.resultBytes;
			addKey(existing.keys, call.key);
			existing.distinctKeys = distinct.size;
			byCategory.duplicate += 1;
		} else {
			const category = classify(call, readsByTable);
			const keys: string[] = [];
			addKey(keys, call.key);
			rows.set(key, {
				fingerprint: key,
				name: call.name,
				table: call.table,
				count: 1,
				rowsRead: call.rowsRead,
				rowsWritten: call.rowsWritten,
				rows: call.rows,
				resultBytes: call.resultBytes,
				category,
				keys,
				distinctKeys: distinct.size,
				subsystem: subsystemOf(call.table, call.key)
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
		bySubsystem,
		totals
	};
}
