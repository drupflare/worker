/**
 * Replays a captured WordPress statement log against MySQL and against `executeMysql` over
 * `node:sqlite`, statement by statement, and reports every difference in rows, columns, affected
 * rows or errno. With `--supplement` it then runs a list of authored statements that cover what the
 * capture never exercises, and checks each against its stated expectation.
 *
 * Usage: bun scripts/measure/sql-translate-differential.ts --capture=<raw-statements.jsonl>
 *   --password=<root password> [--port=13307] [--out=<report.json>] [--limit=<n>] [--supplement]
 * MySQL must be running with an empty database `wp`. Each record of the capture is
 * `{ scenario, i, thread, sql }`; a thread is one connection.
 */
import mysql from 'mysql2/promise';
import { readFileSync, writeFileSync } from 'node:fs';

import { executeMysql, translationOf, type MysqlReply } from '../../src/db/sql/exec';
import { tokenize } from '../../src/db/sql/lexer';
import { createDatabaseState, createState, type MysqlState } from '../../src/db/sql/translate';
import { memoryDatabase } from './sql-translate-run';
import { SUPPLEMENT } from './sql-translate-supplement';

interface Captured {
	scenario: string;
	i: number;
	thread: string;
	sql: string;
	known?: string;
	refused?: string;
}

interface Outcome {
	kind: 'rows' | 'write' | 'none' | 'error';
	columns?: string[];
	rows?: string[][];
	affected?: number;
	insertId?: number;
	errno?: number;
}

function arg(name: string, fallback?: string): string | undefined {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const text = (v: unknown): string | null => {
	if (v === null || v === undefined) return null;
	if (v instanceof Uint8Array) return new TextDecoder().decode(v);
	return String(v);
};

function fromReply(reply: MysqlReply): Outcome {
	if (!reply.ok) return { kind: 'error', errno: reply.errno };
	if (reply.kind === 'rows') {
		return {
			kind: 'rows',
			columns: reply.columns,
			rows: reply.rows.map((r) => r.map((v) => text(v) as string))
		};
	}
	if (reply.kind === 'write') {
		return { kind: 'write', affected: reply.affected, insertId: reply.insertId };
	}
	return { kind: 'none' };
}

const WRITE_VERB = /^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i;

async function runMysql(conn: mysql.Connection, sql: string): Promise<Outcome> {
	try {
		const [result, fields] = await conn.query({
			sql,
			rowsAsArray: true,
			typeCast: (field: { string(): string | null }) => field.string()
		} as mysql.QueryOptions);
		if (Array.isArray(result)) {
			return {
				kind: 'rows',
				columns: (fields as unknown as { name: string }[]).map((f) => f.name),
				rows: (result as unknown[][]).map((r) => r.map((v) => text(v) as string))
			};
		}
		const header = result as { affectedRows: number; insertId: number };
		if (WRITE_VERB.test(sql)) {
			return {
				kind: 'write',
				affected: header.affectedRows,
				insertId: Number(header.insertId)
			};
		}
		return { kind: 'none' };
	} catch (e) {
		return { kind: 'error', errno: (e as { errno?: number }).errno ?? -1 };
	}
}

function ordered(sql: string): boolean {
	const tokens = tokenize(sql).filter((t) => t.type !== 'whitespace' && t.type !== 'comment');
	let depth = 0;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t.text === '(') depth++;
		else if (t.text === ')') depth--;
		else if (
			depth === 0 &&
			t.text.toUpperCase() === 'ORDER' &&
			tokens[i + 1]?.text.toUpperCase() === 'BY'
		) {
			return true;
		}
	}
	return false;
}

/** the first difference between two outcomes, or undefined */
function diff(sql: string, a: Outcome, b: Outcome): string | undefined {
	if (a.kind !== b.kind) return `kind mysql=${a.kind} sqlite=${b.kind}`;
	if (a.kind === 'error')
		return a.errno === b.errno ? undefined : `errno mysql=${a.errno} sqlite=${b.errno}`;
	if (a.kind === 'write') {
		if (a.affected !== b.affected) return `affected mysql=${a.affected} sqlite=${b.affected}`;
		if (a.insertId !== b.insertId) return `insertId mysql=${a.insertId} sqlite=${b.insertId}`;
		return undefined;
	}
	if (a.kind === 'rows') {
		if (JSON.stringify(a.columns) !== JSON.stringify(b.columns)) {
			return `columns mysql=${JSON.stringify(a.columns)} sqlite=${JSON.stringify(b.columns)}`;
		}
		const ra = a.rows!.map((r) => JSON.stringify(r));
		const rb = b.rows!.map((r) => JSON.stringify(r));
		if (ra.length !== rb.length) return `row count mysql=${ra.length} sqlite=${rb.length}`;
		if (ordered(sql)) {
			for (let i = 0; i < ra.length; i++) {
				if (ra[i] !== rb[i]) {
					const same = JSON.stringify([...ra].sort()) === JSON.stringify([...rb].sort());
					return `${same ? 'order only' : 'row'} ${i} mysql=${ra[i]?.slice(0, 200)} sqlite=${rb[i]?.slice(0, 200)}`;
				}
			}
			return undefined;
		}
		const sa = [...ra].sort();
		const sb = [...rb].sort();
		for (let i = 0; i < sa.length; i++) {
			if (sa[i] !== sb[i])
				return `set row mysql=${sa[i]?.slice(0, 200)} sqlite=${sb[i]?.slice(0, 200)}`;
		}
	}
	return undefined;
}

const capturePath = arg('capture');
if (capturePath === undefined) throw new Error('--capture=<raw-statements.jsonl> is required');
const port = Number(arg('port', '13307'));
const limit = Number(arg('limit', '0'));
const password = arg('password') ?? process.env.MYSQL_ROOT_PASSWORD ?? '';
const supplement = process.argv.includes('--supplement');

const statements: Captured[] = readFileSync(capturePath, 'utf8')
	.split('\n')
	.filter((l) => l !== '')
	.map((l) => JSON.parse(l) as Captured);

// the rig reset the permalink options through the mysql client right after install; the general
// log filter dropped that thread, so the replay injects it where it happened
const RIG_SETUP =
	"UPDATE wp_options SET option_value='' WHERE option_name IN ('permalink_structure','rewrite_rules')";
const replay: Captured[] = [];
let injected = false;
for (const s of statements) {
	if (!injected && s.scenario !== 'install' && replay.length > 0) {
		replay.push({ scenario: 'rig-setup', i: -1, thread: 'rig', sql: RIG_SETUP });
		injected = true;
	}
	replay.push(s);
}
const todo = limit > 0 ? replay.slice(0, limit) : replay;
if (supplement) {
	SUPPLEMENT.forEach((c, i) => {
		const item: Captured = { scenario: 'supplement', i, thread: c.thread ?? 'sup', sql: c.sql };
		if (c.known !== undefined) item.known = c.known;
		if (c.refused !== undefined) item.refused = c.refused;
		todo.push(item);
	});
}

const sqlite = memoryDatabase();
const shared = createDatabaseState();
const sessions = new Map<string, MysqlState>();
const conns = new Map<string, mysql.Connection>();

interface Mismatch {
	scenario: string;
	index: number;
	classes: string[];
	reason: string;
	sql: string;
}
const mismatches: Mismatch[] = [];
const knownDifferences: { class: string; reason: string; sql: string }[] = [];
const refusals: { class: string; mysql: string; ok: boolean; sql: string }[] = [];
let matches = 0;
let replayed = 0;
const perScenario = new Map<string, { n: number; bad: number }>();
const kinds = new Map<string, number>();
const outcomes = new Map<string, number>();
let rowsSeen = 0;
let nonEmptyReads = 0;

for (const s of todo) {
	let conn = conns.get(s.thread);
	if (conn === undefined) {
		conn = await mysql.createConnection({
			host: '127.0.0.1',
			port,
			user: 'root',
			password,
			database: 'wp',
			flags: ['-FOUND_ROWS', '-IGNORE_SPACE'],
			charset: 'UTF8MB4_GENERAL_CI'
		});
		conns.set(s.thread, conn);
	}
	let state = sessions.get(s.thread);
	if (state === undefined) {
		state = createState({ db: shared, database: 'wp' });
		sessions.set(s.thread, state);
	}
	// a refused statement is never sent to MySQL: several of them would change the data
	const mine: Outcome = s.refused === undefined ? await runMysql(conn, s.sql) : { kind: 'none' };
	const reply = executeMysql(s.sql, sqlite.run, state, { atomic: sqlite.atomic });
	const theirs = fromReply(reply);
	const d = diff(s.sql, mine, theirs);
	const label =
		s.refused !== undefined
			? 'refused'
			: mine.kind === 'error'
				? `error ${mine.errno}`
				: mine.kind;
	outcomes.set(label, (outcomes.get(label) ?? 0) + 1);
	if (mine.kind === 'rows') {
		rowsSeen += mine.rows!.length;
		if (mine.rows!.length > 0) nonEmptyReads++;
	}
	const bucket = perScenario.get(s.scenario) ?? { n: 0, bad: 0 };
	bucket.n++;
	replayed++;
	if (s.refused !== undefined) {
		const ok = !reply.ok && reply.refused === s.refused;
		refusals.push({ class: s.refused, mysql: label, ok, sql: s.sql.slice(0, 120) });
		if (ok) {
			matches++;
		} else {
			bucket.bad++;
			mismatches.push({
				scenario: s.scenario,
				index: s.i,
				classes: translationOf(s.sql, state).classes,
				reason: `expected a refusal by ${s.refused}, got ${JSON.stringify(reply).slice(0, 160)}`,
				sql: s.sql
			});
		}
	} else if (s.known !== undefined) {
		knownDifferences.push({
			class: s.known,
			reason: d ?? 'no difference',
			sql: s.sql.slice(0, 160)
		});
		matches++;
	} else if (d === undefined) {
		matches++;
	} else {
		bucket.bad++;
		const classes = translationOf(s.sql, state).classes;
		mismatches.push({ scenario: s.scenario, index: s.i, classes, reason: d, sql: s.sql });
		const key = `${d.split(' ')[0]} ${classes.join('+')}`;
		kinds.set(key, (kinds.get(key) ?? 0) + 1);
	}
	perScenario.set(s.scenario, bucket);
}

for (const c of conns.values()) await c.end();

const report = {
	replayed,
	matches,
	mismatches: mismatches.length,
	byKind: Object.fromEntries([...kinds.entries()].sort()),
	outcomes: Object.fromEntries([...outcomes.entries()].sort()),
	rowsSeen,
	nonEmptyReads,
	byScenario: Object.fromEntries(perScenario),
	knownDifferences,
	refusals,
	samples: mismatches
		.filter(
			(m, i, all) =>
				all.findIndex(
					(x) =>
						x.classes.join() === m.classes.join() &&
						x.reason.split(' ')[0] === m.reason.split(' ')[0]
				) === i
		)
		.map((m) => ({ ...m, sql: m.sql.length > 400 ? `${m.sql.slice(0, 400)}...` : m.sql })),
	all: mismatches.map((m) => ({ ...m, sql: m.sql.slice(0, 300) }))
};
const out = arg('out');
if (out !== undefined) writeFileSync(out, JSON.stringify(report, null, 1));
console.log(
	JSON.stringify(
		{
			replayed,
			matches,
			mismatches: mismatches.length,
			byKind: report.byKind,
			outcomes: report.outcomes,
			rowsSeen,
			nonEmptyReads,
			byScenario: report.byScenario,
			knownDifferences: knownDifferences.length,
			refusals: refusals.length
		},
		null,
		1
	)
);
for (const m of report.samples.slice(0, 30)) {
	console.log(
		`\n[${m.scenario} #${m.index}] ${m.classes.join(',')}: ${m.reason}\n  ${m.sql.replace(/\s+/g, ' ').slice(0, 300)}`
	);
}
process.exit(mismatches.length === 0 ? 0 : 1);
