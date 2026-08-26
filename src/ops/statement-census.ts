/**
 * Decomposes the PHP-to-host crossings of ONE render into statements, and classifies each.
 *
 * the five categories are a partition, first match wins, so counts sum to the total; counts and
 * bytes only, never time, because a count is the same number locally and on the edge
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
	// the first bound parameter when short, which on a cache bin is a cid; only the first, because
	// an upsert's later parameters are the payload and one row measured 97,749 bytes
	key: string | null;
};

/**
 * The longest cid kept.
 *
 * 512 rather than a tighter bound: a `cache_render` cid carries every cache context it varied on
 * (`[languages:language_interface]=en:[theme]=olivero:[user.permissions]=...`) and routinely passes
 * 200 characters, so a 160-char cap read null for the single largest group in the census.
 */
const MAX_KEY_CHARS = 512;

/**
 * An OBJECT as well as an array, and the array-only version read null for every statement.
 *
 * Drupal binds NAMED placeholders, so `params` arrives from PHP as an associative array and
 * `json_encode` writes it as `{":db_condition_placeholder_0": "..."}`. Insertion order is the bind
 * order for these keys, so the first value is still the first parameter.
 */
function firstKey(params: unknown): string | null {
	const list = Array.isArray(params)
		? params
		: params !== null && typeof params === 'object'
			? Object.values(params as Record<string, unknown>)
			: [];
	const head = list[0];
	if (typeof head !== 'string' || head.length === 0 || head.length > MAX_KEY_CHARS) return null;
	return head;
}

/**
 * The statement's shape: every literal, bound value and placeholder list normalised to `?`.
 *
 * Placeholder GROUPS collapse too, arity included, or six reads of one bin split into two
 * "distinct operations" on nothing but a one-element `IN` spelled differently.
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

/**
 * Which part of Drupal asked for a statement, which `targetTable()` cannot answer.
 *
 * Three of the bins a render touches are SHARED, so a table names a location and not a caller.
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

/**
 * cid prefixes, tried before the table.
 *
 * Every entry is a cid this project has actually observed in a census run rather than one read out
 * of core, which is the difference between a classification and a note. First match wins.
 */
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

/** the bin or table's owner, used when a statement carries no cid to be more specific with */
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
 * The subsystem a statement belongs to.
 *
 * the cid decides when there is one; the shared bins are absent from the table rules so a
 * statement with no cid stays `other` rather than getting an invented owner
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
	params: unknown,
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
		viaTxn,
		key: firstKey(params)
	};
}

/**
 * Records one crossing as one or more statements.
 *
 * a `cfwSqlTxn` carries a whole transaction, so statements run ahead of crossings; an unparseable
 * payload keeps a null fingerprint rather than being dropped
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
			const one = (results[i] ?? null) as Record<string, unknown> | null;
			const entry = statement as Record<string, unknown> | null;
			// a batch's framing cannot be split N ways honestly, so each statement carries the size
			// of ITS reply and nothing carries the envelope
			log.push(
				statementRecord(
					name,
					entry?.sql,
					entry?.params,
					one,
					one === null ? 0 : JSON.stringify(one).length,
					true
				)
			);
		});
		return;
	}
	log.push(statementRecord(name, null, null, reply, resultBytes, false));
}

/**
 * The five buckets, in the order a statement is tested against them.
 *
 * `bridge` no SQL; `duplicate` same fingerprint again; `cache-miss` empty `cache_*` read;
 * `repeated-table` same table via a different fingerprint; `necessary` everything left
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
	/** distinct first-parameter cids seen under this fingerprint, capped; see {@link CensusCall.key} */
	keys: string[];
	// distinct cids for this fingerprint, uncapped; `keys.length` is a capped sample, and
	// `count - distinctKeys` is the reducible half against a batchable remainder
	distinctKeys: number;
	/**
	 * the subsystem of the FIRST occurrence.
	 *
	 * One fingerprint against a SHARED bin can span subsystems -- the `cache_data` read is a route
	 * lookup once and a CSS aggregate twice -- so read {@link Census.bySubsystem} for the split and
	 * this field only as the row's label.
	 */
	subsystem: Subsystem;
};

/** what one subsystem spent, summed per STATEMENT rather than per fingerprint */
export type SubsystemSpend = {
	statements: number;
	rowsRead: number;
	rowsWritten: number;
	resultBytes: number;
};

/** cids kept per fingerprint; enough to name the callers, not enough to reprint the render */
const MAX_KEYS_PER_ROW = 8;

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

/** appends a cid once, up to the cap; silent past it, since a row is a summary rather than a log */
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
