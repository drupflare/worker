import mysql from 'mysql2/promise';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { classRow } from '../../src/db/sql/classes';
import { executeMysql, translationOf, type MysqlReply } from '../../src/db/sql/exec';
import { createDatabaseState, createState, type MysqlState } from '../../src/db/sql/translate';
import { memoryDatabase } from '../measure/sql-translate-run';
import { SUPPLEMENT } from '../measure/sql-translate-supplement';
import { httpGet, prepareSite, readLog, runPhp, startPhpServer } from './harness';
import { startHost } from './host';
import { ACTION_SCHEDULER, ACTION_SCHEDULER_SCENARIO } from './oracle-action-scheduler';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '../..');

/** one captured statement; a thread is one connection */
export interface Captured {
	scenario: string;
	i: number;
	thread: string;
	sql: string;
	/** a class the translator must refuse the statement by; the outside arms never run it */
	refused?: string;
	/** a class whose documented difference the statement is expected to show */
	known?: string;
}

/** what one arm answered for one statement */
export interface Outcome {
	kind: 'rows' | 'write' | 'none' | 'error';
	columns?: string[];
	rows?: (string | null)[][];
	affected?: number;
	insertId?: number;
	errno?: number;
}

/** the tables of a database after a scenario: name to sorted json rows */
export type Dump = Record<string, string[]>;

/** the recorded answers of the two outside arms over one capture */
export interface OracleRecord {
	/** upstream plugin tag and commit, the native server version, and the date of the run */
	meta: Record<string, string>;
	statements: Captured[];
	native: Outcome[];
	upstream: Outcome[];
	nativeDumps: { scenario: string; tables: Dump }[];
	upstreamDumps: { scenario: string; tables: Dump }[];
}

/** the paths fetched after the bake, in order */
export const CAPTURE_PATHS = [
	'/',
	'/?p=1',
	'/wp-login.php',
	'/wp-json/',
	'/feed/',
	'/?s=hello',
	'/category/uncategorized/',
	'/category/uncategorized/feed/',
	'/?cat=1',
	'/wp-sitemap.xml',
	'/wp-sitemap-posts-post-1.xml',
	'/wp-sitemap-taxonomies-category-1.xml',
	'/wp-sitemap-users-1.xml',
	'/wp-sitemap.xsl',
	'/tag/none/',
	'/2026/01/',
	'/author/admin/'
];

// #region capture

/** installs WordPress through the translator and writes every statement it sent */
export async function capture(out: string): Promise<number> {
	mkdirSync(out, { recursive: true });
	const site = await prepareSite(join(out, 'site'), {
		title: 'WordPress Site',
		muPlugins: join(ROOT, '../drupflare/src/Wp/mu')
	});
	site.email = 'admin@wordpress.invalid';
	const host = await startHost({ dbFile: site.db, socketPath: site.socket, keepText: true });
	const env = { CFW_LABEL: 'bake', WP_STAMP_EPOCH: '1767225600' };
	const bake = await runPhp(site, [join(HERE, 'bake.php')], env);
	if (bake.code !== 0) throw new Error(`bake exited ${bake.code}: ${bake.stdout}`);
	const rules = await runPhp(site, [join(HERE, 'bake-rules.php')], {
		...env,
		CFW_LABEL: 'bake-rules'
	});
	if (rules.code !== 0) throw new Error(`bake-rules exited ${rules.code}: ${rules.stdout}`);
	const activity = await runPhp(site, [join(HERE, 'oracle-activity.php')], {
		...env,
		CFW_LABEL: 'activity'
	});
	if (activity.code !== 0) {
		throw new Error(`activity exited ${activity.code}: ${activity.stdout} ${activity.stderr}`);
	}
	const server = await startPhpServer(site);
	for (const p of CAPTURE_PATHS) {
		await httpGet(site, p);
		await httpGet(site, '/__ping');
	}
	await server.stop();
	await host.stop();
	const lines: { seq: number; scenario: string; thread: string; sql: string }[] = [];
	host.requests.forEach((req, n) => {
		for (const s of req.statements) {
			if (s.sql !== undefined) {
				lines.push({
					seq: s.seq,
					scenario: req.label.slice(0, 40),
					thread: String(n),
					sql: s.sql
				});
			}
		}
	});
	lines.sort((a, b) => a.seq - b.seq);
	const all: Captured[] = lines.map((l, i) => ({
		scenario: l.scenario,
		i,
		thread: l.thread,
		sql: l.sql
	}));
	[
		...ACTION_SCHEDULER.map((c) => ({ ...c, scenario: ACTION_SCHEDULER_SCENARIO })),
		...SUPPLEMENT.map((c) => ({ ...c, scenario: 'supplement' }))
	].forEach((c, k) => {
		const item: Captured = {
			scenario: c.scenario,
			i: lines.length + k,
			thread: c.thread ?? 'sup',
			sql: c.sql
		};
		if (c.known !== undefined) item.known = c.known;
		if (c.refused !== undefined) item.refused = c.refused;
		all.push(item);
	});
	const rows = all.map((c) => JSON.stringify(c));
	writeFileSync(join(out, 'capture.jsonl'), rows.join('\n') + '\n');
	const log = readLog(site).trim();
	if (log !== '') console.log(`php log: ${log.slice(0, 300)}`);
	return rows.length;
}

// #endregion

// #region arms

const text = (v: unknown): string | null => {
	if (v === null || v === undefined) return null;
	if (v instanceof Uint8Array) return new TextDecoder().decode(v);
	return String(v);
};

const WRITE_VERB = /^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i;

/** a reply of the translator as the outcome shape the arms share */
export function fromReply(reply: MysqlReply): Outcome {
	if (!reply.ok) return { kind: 'error', errno: reply.errno };
	if (reply.kind === 'rows') {
		return { kind: 'rows', columns: reply.columns, rows: reply.rows.map((r) => r.map(text)) };
	}
	if (reply.kind === 'write') {
		return { kind: 'write', affected: reply.affected, insertId: reply.insertId };
	}
	return { kind: 'none' };
}

/** the native arm: one connection per thread against a server holding an empty database `wp` */
export async function runNative(
	statements: Captured[],
	options: { port: number; password: string }
): Promise<{ outcomes: Outcome[]; dumps: { scenario: string; tables: Dump }[] }> {
	const connect = () =>
		mysql.createConnection({
			host: '127.0.0.1',
			port: options.port,
			user: 'root',
			password: options.password,
			database: 'wp',
			flags: ['-FOUND_ROWS', '-IGNORE_SPACE'],
			charset: 'UTF8MB4_GENERAL_CI'
		});
	const query = async (conn: mysql.Connection, sql: string): Promise<Outcome> => {
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
					rows: (result as unknown[][]).map((r) => r.map(text))
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
	};
	const conns = new Map<string, mysql.Connection>();
	const outcomes: Outcome[] = [];
	const dumps: { scenario: string; tables: Dump }[] = [];
	let last: mysql.Connection | undefined;
	let lastScenario: string | undefined;
	const dump = async (conn: mysql.Connection): Promise<Dump> => {
		const tables = (await query(conn, 'SHOW TABLES')).rows!.map((r) => r[0]!).sort();
		const result: Dump = {};
		for (const t of tables) {
			const rows = (await query(conn, `SELECT * FROM \`${t}\``)).rows ?? [];
			result[t] = rows.map((r) => JSON.stringify(r)).sort();
		}
		return result;
	};
	for (const s of statements) {
		if (lastScenario !== undefined && s.scenario !== lastScenario && last !== undefined) {
			dumps.push({ scenario: lastScenario, tables: await dump(last) });
		}
		lastScenario = s.scenario;
		let conn = conns.get(s.thread);
		if (conn === undefined) {
			conn = await connect();
			conns.set(s.thread, conn);
		}
		last = conn;
		outcomes.push(s.refused === undefined ? await query(conn, s.sql) : { kind: 'none' });
	}
	if (last !== undefined && lastScenario !== undefined) {
		dumps.push({ scenario: lastScenario, tables: await dump(last) });
	}
	for (const c of conns.values()) await c.end();
	return { outcomes, dumps };
}

/** the translator arm over an in-memory database, one session state per thread */
export function runOurs(statements: Captured[]): {
	outcomes: Outcome[];
	classes: string[][];
	dumps: { scenario: string; tables: Dump }[];
} {
	const sqlite = memoryDatabase();
	const shared = createDatabaseState();
	const sessions = new Map<string, MysqlState>();
	const outcomes: Outcome[] = [];
	const classes: string[][] = [];
	const dumps: { scenario: string; tables: Dump }[] = [];
	let last: MysqlState | undefined;
	let lastScenario: string | undefined;
	const run = (state: MysqlState, sql: string) =>
		executeMysql(sql, sqlite.run, state, { atomic: sqlite.atomic });
	const dump = (state: MysqlState): Dump => {
		const reply = run(state, 'SHOW TABLES');
		if (!reply.ok || reply.kind !== 'rows') throw new Error('SHOW TABLES failed');
		const result: Dump = {};
		for (const t of reply.rows.map((r) => String(r[0])).sort()) {
			const rows = run(state, `SELECT * FROM \`${t}\``);
			result[t] =
				rows.ok && rows.kind === 'rows'
					? rows.rows.map((r) => JSON.stringify(r.map(text))).sort()
					: [];
		}
		return result;
	};
	for (const s of statements) {
		if (lastScenario !== undefined && s.scenario !== lastScenario && last !== undefined) {
			dumps.push({ scenario: lastScenario, tables: dump(last) });
		}
		lastScenario = s.scenario;
		let state = sessions.get(s.thread);
		if (state === undefined) {
			state = createState({ db: shared, database: 'wp' });
			sessions.set(s.thread, state);
		}
		last = state;
		classes.push(translationOf(s.sql, state).classes);
		outcomes.push(fromReply(run(state, s.sql)));
	}
	if (last !== undefined && lastScenario !== undefined) {
		dumps.push({ scenario: lastScenario, tables: dump(last) });
	}
	return { outcomes, classes, dumps };
}

/** the upstream arm: the plugin's driver on PHP CLI over a SQLite file */
export function runUpstream(
	upstreamSrc: string,
	capturePath: string,
	workDir: string
): { outcomes: Outcome[]; dumps: { scenario: string; tables: Dump }[] } {
	const out = join(workDir, 'upstream.jsonl');
	const res = spawnSync(
		process.env.PHP ?? 'php',
		[
			join(HERE, 'oracle-upstream.php'),
			upstreamSrc,
			capturePath,
			join(workDir, 'upstream.sqlite'),
			out
		],
		{ encoding: 'utf8', maxBuffer: 1 << 28 }
	);
	if (res.status !== 0) throw new Error(`upstream arm exited ${res.status}: ${res.stderr}`);
	const outcomes: Outcome[] = [];
	const dumps: { scenario: string; tables: Dump }[] = [];
	for (const line of readFileSync(out, 'utf8').split('\n')) {
		if (line === '') continue;
		const rec = JSON.parse(line) as { i?: number; o?: Outcome; dump?: string; tables?: Dump };
		if (rec.o !== undefined) outcomes.push(rec.o);
		else dumps.push({ scenario: rec.dump!, tables: rec.tables! });
	}
	return { outcomes, dumps };
}

// #endregion

// #region comparison

/** the SELECT-like statements whose row order MySQL does not promise without an ORDER BY */
function ordered(sql: string): boolean {
	return /\bORDER\s+BY\b/i.test(sql);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const sha = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16);

/** a password hash in a row, which a fixture must not carry, reduced to a fixed text */
const scrub = (line: string): string => line.replace(/\$wp\$[^"]*/g, () => '$wp$x');

/** an outcome reduced to what a comparison reads: row sets become two hashes, ordered and sorted */
export interface Digest {
	kind: Outcome['kind'];
	columns?: string[];
	rows?: number;
	ordered?: string;
	sorted?: string;
	affected?: number;
	insertId?: number;
	errno?: number;
}

/** reduces an outcome to its digest */
export function digestOf(o: Outcome): Digest {
	const d: Digest = { kind: o.kind };
	if (o.columns !== undefined) d.columns = o.columns;
	if (o.rows !== undefined) {
		const lines = o.rows.map((r) => scrub(JSON.stringify(r)));
		d.rows = lines.length;
		d.ordered = sha(lines.join('\n'));
		d.sorted = sha([...lines].sort().join('\n'));
	}
	if (o.affected !== undefined) d.affected = o.affected;
	if (o.insertId !== undefined) d.insertId = o.insertId;
	if (o.errno !== undefined) d.errno = o.errno;
	return d;
}

/** the first difference between two digests of one statement, or undefined */
export function difference(sql: string, a: Digest, b: Digest): string | undefined {
	if (a.kind !== b.kind) return `kind ${a.kind}/${b.kind}`;
	if (a.kind === 'error') return a.errno === b.errno ? undefined : `errno ${a.errno}/${b.errno}`;
	if (a.kind === 'write') {
		if (a.affected !== b.affected) return `affected ${a.affected}/${b.affected}`;
		if (a.insertId !== b.insertId) return `insertId ${a.insertId}/${b.insertId}`;
		return undefined;
	}
	if (a.kind === 'rows') {
		if (!same(a.columns, b.columns)) return 'columns';
		if (a.rows !== b.rows) return `row count ${a.rows}/${b.rows}`;
		if (a.sorted !== b.sorted) return 'row';
		return ordered(sql) && a.ordered !== b.ordered ? 'order' : undefined;
	}
	return undefined;
}

/** who a difference belongs to */
export type Owner = 'documented' | 'upstream' | 'unexplained';

/** a pair of arms */
export type Pair = 'native/ours' | 'native/upstream' | 'ours/upstream';

/** one statement on which two arms disagree, with the reason it is not a defect or the lack of one */
export interface Classified {
	index: number;
	scenario: string;
	pair: Pair;
	kind: string;
	owner: Owner;
	cause: string;
}

interface Context {
	sql: string;
	diff: string;
	native: Digest;
	upstream: Digest;
}

/** the ways the upstream plugin answers differently from MySQL, each a cause the table names */
const UPSTREAM_CAUSES: { cause: string; test: (c: Context) => boolean }[] = [
	{
		cause: 'describe of a missing table answers an empty set where MySQL answers 1146',
		test: (c) => /^\s*DESC(RIBE)?\b/i.test(c.sql) && c.diff.startsWith('kind')
	},
	{
		cause: 'schema answers keep integer display widths and the server default collation name',
		test: (c) =>
			/^\s*(DESC(RIBE)?|SHOW\s+(FULL\s+)?COLUMNS|SHOW\s+INDEX|SHOW\s+CREATE)\b/i.test(c.sql)
	},
	{
		cause: 'SHOW TABLES LIKE names its column without the pattern',
		test: (c) => /^\s*SHOW\s+TABLES\s+LIKE\b/i.test(c.sql) && c.diff === 'columns'
	},
	{
		cause: 'version strings name the plugin',
		test: (c) => /VERSION\(\)|@@version_comment/i.test(c.sql)
	},
	{
		cause: 'errors carry the SQLite or driver number where MySQL gives its own',
		test: (c) => c.diff.startsWith('errno')
	},
	{
		cause: 'syntax MySQL accepts and the plugin refuses (&&, COLLATE utf8mb4_bin, SQL_NO_CACHE, STRAIGHT_JOIN)',
		test: (c) =>
			c.diff.startsWith('kind') && c.upstream.kind === 'error' && c.native.kind !== 'error'
	},
	{
		cause: 'rows matched are reported where MySQL reports rows changed',
		test: (c) => c.diff.startsWith('affected') && /^\s*(INSERT|REPLACE|UPDATE)\b/i.test(c.sql)
	},
	{
		cause: 'the insert id is the last row written, or a rowid on a table with no auto-increment',
		test: (c) => c.diff.startsWith('insertId')
	},
	{
		cause: 'FOUND_ROWS after a LIMIT without SQL_CALC_FOUND_ROWS counts only the rows returned',
		test: (c) => /^\s*SELECT\s+FOUND_ROWS\(\)/i.test(c.sql) && c.diff === 'row'
	},
	{
		cause: 'integer division truncates where MySQL answers a decimal',
		test: (c) => /^\s*SELECT\s+\d+\s*\/\s*\d+\s*$/i.test(c.sql) && c.diff === 'row'
	},
	{
		cause: 'a text column compared with a number compares as text',
		test: (c) => /^\s*SELECT\s+option_value\s*<\s*\d+/i.test(c.sql) && c.diff === 'row'
	},
	{
		cause: 'LIKE folds ASCII only',
		test: (c) => /LIKE\s+'/i.test(c.sql) && /^\s*SELECT\s+'/i.test(c.sql) && c.diff === 'row'
	},
	{
		cause: 'a month step past a short month overflows where MySQL clamps',
		test: (c) => /DATE_ADD\(/i.test(c.sql) && c.diff === 'row'
	},
	{
		cause: 'LENGTH counts characters where MySQL counts bytes',
		test: (c) => /LENGTH\(/i.test(c.sql) && c.diff === 'row'
	},
	{
		cause: 'YEAR(NULL) answers 1970 where MySQL answers NULL',
		test: (c) => /YEAR\(NULL\)/i.test(c.sql) && c.diff === 'row'
	},
	{
		cause: 'a DECIMAL column returns the stored number without its scale',
		test: (c) => /price/i.test(c.sql) && /zz_t/i.test(c.sql) && c.diff === 'row'
	}
];

/** translated rows whose answer names the translator, so it differs from MySQL by design */
const NAMED_ANSWERS = new Set(['select-version', 'select-system-variable']);

/** every disagreement between the three arms over a recorded statement log, classified */
export function classify(
	statements: Captured[],
	native: Digest[],
	upstream: Digest[],
	ours: { digests: Digest[]; classes: string[][] }
): Classified[] {
	const out: Classified[] = [];
	statements.forEach((s, index) => {
		if (s.refused !== undefined) return;
		const n = native[index] as Digest;
		const o = ours.digests[index] as Digest;
		const u = upstream[index] as Digest;
		const documented = [
			...new Set([
				...(ours.classes[index] ?? []).filter(
					(id) => classRow(id)?.kind === 'semantics-changed' || NAMED_ANSWERS.has(id)
				),
				...(s.known !== undefined && classRow(s.known) !== undefined ? [s.known] : [])
			])
		];
		const oursDiff = difference(s.sql, n, o);
		const upstreamDiff = difference(s.sql, n, u);
		const pairDiff = difference(s.sql, o, u);
		const oursClass = (diff: string): [Owner, string] =>
			documented.length > 0 ? ['documented', documented.join('+')] : ['unexplained', diff];
		const upstreamClass = (diff: string): [Owner, string] => {
			const hit = UPSTREAM_CAUSES.find((c) =>
				c.test({ sql: s.sql, diff, native: n, upstream: u })
			);
			return hit === undefined ? ['unexplained', diff] : ['upstream', hit.cause];
		};
		const add = (pair: Pair, diff: string, [owner, cause]: [Owner, string]) =>
			out.push({
				index,
				scenario: s.scenario,
				pair,
				kind: diff.split(' ')[0] as string,
				owner,
				cause
			});
		if (oursDiff !== undefined) add('native/ours', oursDiff, oursClass(oursDiff));
		if (upstreamDiff !== undefined) {
			const both = oursDiff !== undefined && pairDiff === undefined;
			add(
				'native/upstream',
				upstreamDiff,
				both ? oursClass(upstreamDiff) : upstreamClass(upstreamDiff)
			);
		}
		if (pairDiff !== undefined) {
			if (oursDiff === undefined && upstreamDiff !== undefined) {
				add('ours/upstream', pairDiff, upstreamClass(upstreamDiff));
			} else if (oursDiff !== undefined) {
				add('ours/upstream', pairDiff, oursClass(oursDiff));
			} else {
				add('ours/upstream', pairDiff, ['unexplained', pairDiff]);
			}
		}
	});
	return out;
}

/** the counts the report and the gate pin: differences by pair, owner and cause */
export function tallyClassified(list: Classified[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const c of list) {
		const key = `${c.pair} | ${c.owner} | ${c.cause}`;
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(counts).sort());
}

/** a table's rows reduced to one hash, for the dump comparison */
export function dumpHashes(tables: Dump): Record<string, string> {
	return Object.fromEntries(
		Object.entries(tables).map(([t, rows]) => [t, sha(rows.map(scrub).sort().join('\n'))])
	);
}

/** the recorded oracle fixture: the statements, both outside arms as digests, and the table hashes */
export interface Fixture {
	meta: Record<string, string>;
	statements: Captured[];
	native: Digest[];
	upstream: Digest[];
	dumps: { scenario: string; native: Record<string, string>; upstream: Record<string, string> }[];
}

/** reads a fixture written by `record`, gzipped or plain */
export function loadFixture(path: string): Fixture {
	const raw = readFileSync(path);
	return JSON.parse(
		new TextDecoder().decode(path.endsWith('.gz') ? gunzipSync(raw) : raw)
	) as Fixture;
}

const PASSWORD_HASH = /'\$wp\$[^']*'/g;

/** reduces a full record to the fixture the gate replays; password hashes are replaced */
export function fixtureOf(record: OracleRecord): Fixture {
	return {
		meta: record.meta,
		statements: record.statements.map((s) => ({
			...s,
			sql: s.sql.replace(PASSWORD_HASH, "'$wp$x'")
		})),
		native: record.native.map(digestOf),
		upstream: record.upstream.map(digestOf),
		dumps: record.nativeDumps.map((d, i) => ({
			scenario: d.scenario,
			native: dumpHashes(d.tables),
			upstream: dumpHashes((record.upstreamDumps[i] as { tables: Dump }).tables)
		}))
	};
}

/** replays a fixture through the translator and classifies every disagreement */
export function replayFixture(fixture: Fixture): {
	classified: Classified[];
	dumps: { scenario: string; native: boolean; upstream: boolean }[];
} {
	const ours = runOurs(fixture.statements);
	const classified = classify(fixture.statements, fixture.native, fixture.upstream, {
		digests: ours.outcomes.map(digestOf),
		classes: ours.classes
	});
	const dumps = ours.dumps.map((d, i) => {
		const recorded = fixture.dumps[i] as Fixture['dumps'][number];
		const mine = dumpHashes(d.tables);
		return {
			scenario: d.scenario,
			native: same(mine, recorded.native),
			upstream: same(mine, recorded.upstream)
		};
	});
	return { classified, dumps };
}

// #endregion

const arg = (name: string, fallback?: string): string | undefined => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
};

if (import.meta.main) {
	const command = process.argv[2];
	if (command === 'capture') {
		const n = await capture(arg('out')!);
		console.log(`captured ${n} statements`);
	} else if (command === 'record') {
		const capturePath = arg('capture')!;
		const workDir = arg('out')!;
		mkdirSync(workDir, { recursive: true });
		const statements = readFileSync(capturePath, 'utf8')
			.split('\n')
			.filter((l) => l !== '')
			.map((l) => JSON.parse(l) as Captured);
		const password = arg('password') ?? process.env.MYSQL_ROOT_PASSWORD ?? '';
		const native = await runNative(statements, {
			port: Number(arg('port', '13307')),
			password
		});
		const upstream = runUpstream(arg('upstream')!, capturePath, workDir);
		const record: OracleRecord = {
			meta: {
				upstream: arg('upstream-tag', 'unknown')!,
				upstreamCommit: arg('upstream-sha', 'unknown')!,
				upstreamPackageTree: arg('upstream-tree', 'unknown')!,
				native: arg('native-version', 'unknown')!,
				date: new Date().toISOString().slice(0, 10)
			},
			statements,
			native: native.outcomes,
			upstream: upstream.outcomes,
			nativeDumps: native.dumps,
			upstreamDumps: upstream.dumps
		};
		writeFileSync(join(workDir, 'record.json'), JSON.stringify(record));
		const fixturePath = arg('fixture');
		if (fixturePath !== undefined) {
			const fixture = fixtureOf(record);
			const lines = fixture.statements.map((s) => `\t\t${JSON.stringify(s)}`).join(',\n');
			const digests = (list: Digest[]) =>
				list.map((d) => `\t\t${JSON.stringify(d)}`).join(',\n');
			const text = `{\n\t"meta": ${JSON.stringify(fixture.meta)},\n\t"statements": [\n${lines}\n\t],\n\t"native": [\n${digests(fixture.native)}\n\t],\n\t"upstream": [\n${digests(fixture.upstream)}\n\t],\n\t"dumps": ${JSON.stringify(fixture.dumps)}\n}\n`;
			writeFileSync(
				fixturePath,
				fixturePath.endsWith('.gz') ? gzipSync(text, { level: 9 }) : text
			);
		}
		console.log(
			`recorded ${statements.length} statements, native ${native.outcomes.length}, upstream ${upstream.outcomes.length}`
		);
	} else if (command === 'analyze') {
		const fixture = loadFixture(arg('fixture')!);
		const { classified, dumps } = replayFixture(fixture);
		console.log(JSON.stringify(tallyClassified(classified), null, 1));
		console.log(JSON.stringify(dumps));
		const bad = classified.filter((c) => c.owner === 'unexplained');
		for (const c of bad) {
			console.log(
				`unexplained #${c.index} ${c.pair} ${c.cause}: ${(fixture.statements[c.index] as Captured).sql.slice(0, 160)}`
			);
		}
		process.exit(bad.length === 0 ? 0 : 1);
	} else {
		console.error(
			'usage: oracles.ts capture --out=<dir> | record --capture= --out= --upstream= ...'
		);
		process.exit(2);
	}
}
