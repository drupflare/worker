import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
	httpGet,
	installWordpress,
	phpVersion,
	prepareSite,
	readLog,
	runPhp,
	startPhpServer,
	type Site
} from './harness';
import {
	startHost,
	type Host,
	type RequestRecord,
	type Resume,
	type StatementRecord
} from './host';

const HERE = import.meta.dirname;

/** the paths the front page check fetches, in order */
export const PATHS = ['/', '/?p=1', '/wp-login.php', '/wp-json/', '/feed/', '/?s=hello'];

/** a statement with its literals replaced, so equal statements of different values group */
export function templateOf(sql: string): string {
	return sql
		.replace(/'(?:[^'\\]|\\.|'')*'/g, '?')
		.replace(/\b\d+(?:\.\d+)?\b/g, '?')
		.replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, '(?+)')
		.replace(/\s+/g, ' ')
		.trim();
}

/** the sums a request or an install report */
export interface Tally {
	statements: number;
	byVerb: Record<string, number>;
	errors: number;
	refusals: number;
	unknownClass: number;
	templates: number;
	translateMs: number;
	execMs: number;
}

/** counts a list of statements */
export function tally(list: StatementRecord[]): Tally {
	const byVerb: Record<string, number> = {};
	const templates = new Set<string>();
	let errors = 0;
	let refusals = 0;
	let unknownClass = 0;
	let translateMs = 0;
	let execMs = 0;
	for (const s of list) {
		byVerb[s.verb] = (byVerb[s.verb] ?? 0) + 1;
		if (s.sql !== undefined) templates.add(templateOf(s.sql));
		if (!s.ok) errors++;
		if (s.refused !== undefined) refusals++;
		if (s.classes.includes('statement-unknown')) unknownClass++;
		translateMs += s.translateMs;
		execMs += s.execMs;
	}
	return {
		statements: list.length,
		byVerb,
		errors,
		refusals,
		unknownClass,
		templates: templates.size,
		translateMs,
		execMs
	};
}

/** one GET of the front page check */
export interface PageResult {
	path: string;
	status: number;
	bytes: number;
	location: string | null;
	tally: Tally;
	sent: number | undefined;
	wpdbQueries: number | null | undefined;
	firstLogLine: string | undefined;
	wallMs: number;
}

/** fetches a path, then a ping so the request's own record is complete, and tallies the record */
export async function fetchPage(
	site: Site,
	host: Host,
	path: string,
	keep?: (name: string, body: string) => void
): Promise<PageResult> {
	const first = host.requests.length;
	const logBefore = readLog(site).length;
	const t0 = performance.now();
	const res = await httpGet(site, path);
	const wallMs = performance.now() - t0;
	await httpGet(site, '/__ping');
	const record = host.requests.slice(first).find((r) => r.label.startsWith('GET ' + path)) as
		RequestRecord | undefined;
	keep?.(path, res.body);
	const fresh = readLog(site).slice(logBefore).trim();
	return {
		path,
		status: res.status,
		bytes: res.bytes,
		location: res.location,
		tally: tally(record?.statements ?? []),
		sent: record?.end?.sent as number | undefined,
		wpdbQueries: record?.end?.wpdbQueries as number | null | undefined,
		firstLogLine: fresh === '' ? undefined : fresh.split('\n')[0],
		wallMs
	};
}

/** the title WordPress rendered, read from the page head */
export function titleOf(body: string): string | undefined {
	return /<title>([^<]*)<\/title>/.exec(body)?.[1];
}

/** a persistent PHP process that keeps its wpdb connection across a host restart */
export interface Repl {
	ask(command: string): Promise<Record<string, unknown>>;
	close(): Promise<void>;
}

/** starts session.php and waits for its ready line */
export async function startRepl(site: Site): Promise<Repl> {
	const child = spawn(
		process.env.PHP ?? 'php',
		[
			'-d',
			'display_errors=0',
			'-d',
			`auto_prepend_file=${join(HERE, 'stub.php')}`,
			'-d',
			`error_log=${site.log}`,
			join(HERE, 'session.php')
		],
		{
			env: {
				...process.env,
				WP_ROOT: site.www,
				CFW_SOCKET: site.socket,
				CFW_CODEC: site.codec,
				CFW_LABEL: 'repl'
			}
		}
	);
	const lines = createInterface({ input: child.stdout });
	const pending: Array<(v: Record<string, unknown>) => void> = [];
	lines.on('line', (line) => pending.shift()?.(JSON.parse(line) as Record<string, unknown>));
	await new Promise<void>((ready) => pending.push(() => ready()));
	return {
		ask: (command) =>
			new Promise((done) => {
				pending.push(done);
				child.stdin.write(`${command}\n`);
			}),
		close: () =>
			new Promise<void>((done) => {
				child.once('close', () => done());
				child.stdin.write('quit\n');
			})
	};
}

/** the two probe answers the persistence check reads from an old PHP process */
export interface ResumeResult {
	resume: Resume;
	titleBefore: unknown;
	strictBefore: unknown;
	titleAfter: unknown;
	strictAfter: unknown;
	strictAfterError: unknown;
	zeroDateBefore: unknown;
	zeroDateAfter: unknown;
	zeroDateAfterError: unknown;
	statementsAfterRestart: number;
}

/**
 * Runs one old PHP process across a host restart. The probe insert omits a NOT NULL column, which
 * succeeds in the relaxed mode WordPress sets on connect and answers 1364 in the strict default.
 */
export async function resumeProbe(site: Site, resume: Resume): Promise<ResumeResult> {
	let host = await startHost({ dbFile: site.db, socketPath: site.socket, resume: 'strict' });
	const repl = await startRepl(site);
	const titleBefore = (await repl.ask('title')).value;
	await repl.ask('setup');
	const before = await repl.ask('strict');
	const zeroBefore = await repl.ask('zerodate');
	await host.stop();
	host = await startHost({ dbFile: site.db, socketPath: site.socket, resume });
	const titleAfter = (await repl.ask('title')).value;
	const after = await repl.ask('strict');
	const zeroAfter = await repl.ask('zerodate');
	await repl.close();
	const statementsAfterRestart = host.requests.reduce((n, r) => n + r.statements.length, 0);
	await host.stop();
	return {
		resume,
		titleBefore,
		strictBefore: before.result,
		titleAfter,
		strictAfter: after.result,
		strictAfterError: after.error,
		zeroDateBefore: zeroBefore.result,
		zeroDateAfter: zeroAfter.result,
		zeroDateAfterError: zeroAfter.error,
		statementsAfterRestart
	};
}

/** rows of the schema comparison: lines present on one side only */
export function schemaDiff(
	native: Record<string, string>,
	bridge: Record<string, string>
): Array<{ table: string; only: 'native' | 'bridge'; line: string }> {
	const lines = (text: string) =>
		text
			.replace(/ AUTO_INCREMENT=\d+/, '')
			.split('\n')
			.map((l) => l.trim().replace(/,$/, ''));
	const out: Array<{ table: string; only: 'native' | 'bridge'; line: string }> = [];
	for (const table of new Set([...Object.keys(native), ...Object.keys(bridge)])) {
		const a = lines(native[table] ?? '');
		const b = lines(bridge[table] ?? '');
		for (const l of a) if (!b.includes(l)) out.push({ table, only: 'native', line: l });
		for (const l of b) if (!a.includes(l)) out.push({ table, only: 'bridge', line: l });
	}
	return out;
}

/** parses the native capture's SHOW CREATE TABLE file into a table map */
export function parseShowCreate(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	let table: string | undefined;
	let buffer: string[] = [];
	const flush = () => {
		if (table !== undefined) out[table] = buffer.join('\n');
	};
	for (const line of text.split('\n')) {
		const m = /^(wp_\w+)\t(CREATE TABLE .*)$/.exec(line);
		if (m !== null) {
			flush();
			table = m[1];
			buffer = [m[2] as string];
		} else if (table !== undefined && line !== '') buffer.push(line);
	}
	flush();
	return out;
}

async function main(): Promise<void> {
	const args = new Map(
		process.argv.slice(2).map((a) => {
			const [k, v] = a.replace(/^--/, '').split('=');
			return [k as string, v ?? 'true'] as const;
		})
	);
	const outDir = args.get('out');
	if (outDir !== undefined) mkdirSync(join(outDir, 'bodies'), { recursive: true });
	const dir = args.get('dir') ?? mkdtempSync(join(tmpdir(), 'wp-local-'));
	const repeats = Number(args.get('repeats') ?? 50);
	const report: Record<string, unknown> = { php: await phpVersion(), dir };

	const site = await prepareSite(join(dir, 'a'));
	let host = await startHost({ dbFile: site.db, socketPath: site.socket, keepText: true });
	let server = await startPhpServer(site);

	// install
	const t0 = performance.now();
	const install = await installWordpress(site);
	const installMs = performance.now() - t0;
	const installRecord = host.requests.find((r) => r.label === 'install');
	const loopback = host.requests.filter((r) => r.label.startsWith('GET /2'));
	const failed = (installRecord?.statements ?? []).filter((s) => !s.ok);
	const groups = new Map<string, { n: number; example: string }>();
	for (const s of failed) {
		const key = `${s.verb} errno=${s.errno} ${s.refused ?? ''}`.trim();
		const g = groups.get(key) ?? {
			n: 0,
			example: (s.sql ?? '').replace(/\s+/g, ' ').slice(0, 90)
		};
		g.n++;
		groups.set(key, g);
	}
	report.install = {
		exitCode: install.code,
		stdout: install.stdout.trim().slice(0, 200),
		wallMs: installMs,
		tally: tally(installRecord?.statements ?? []),
		end: installRecord?.end,
		loopbackRequests: loopback.map((r) => ({ label: r.label, tally: tally(r.statements) })),
		failureGroups: [...groups].map(([key, g]) => ({ key, ...g })),
		log: readLog(site)
	};

	// schema through the bridge
	const schemaRun = await runPhp(site, [join(HERE, 'schema.php')], { CFW_LABEL: 'schema' });
	const bridgeSchema = JSON.parse(schemaRun.stdout) as Record<string, string>;
	const nativePath = args.get('native-schema');
	if (nativePath !== undefined) {
		const native = parseShowCreate(readFileSync(nativePath, 'utf8'));
		const core = Object.fromEntries(Object.entries(bridgeSchema).filter(([k]) => k in native));
		report.schema = {
			tables: Object.keys(bridgeSchema).length,
			compared: Object.keys(core).length,
			diff: schemaDiff(native, core)
		};
	}

	// the six GETs, then a repeat series
	const keep = (path: string, body: string) => {
		if (outDir !== undefined) {
			const name = path === '/' ? 'root' : path.replace(/[^a-z0-9]+/gi, '_');
			writeFileSync(join(outDir, 'bodies', `${name}.html`), body);
		}
	};
	const pages: PageResult[] = [];
	for (const p of PATHS) pages.push(await fetchPage(site, host, p, keep));
	report.pages = pages;
	const frontBody = (await httpGet(site, '/')).body;
	report.title = titleOf(frontBody);

	const series: PageResult[] = [];
	for (let i = 0; i < repeats; i++) series.push(await fetchPage(site, host, '/'));
	const sum = (f: (p: PageResult) => number) => series.reduce((a, p) => a + f(p), 0);
	report.series = {
		n: series.length,
		statementsPerRequest: sum((p) => p.tally.statements) / series.length,
		translateMsPerRequest: sum((p) => p.tally.translateMs) / series.length,
		execMsPerRequest: sum((p) => p.tally.execMs) / series.length,
		wallMsPerRequest: sum((p) => p.wallMs) / series.length,
		wallMsMax: Math.max(...series.map((p) => p.wallMs))
	};

	// coverage
	const all = host.requests.flatMap((r) => r.statements);
	const mismatched = host.requests
		.filter((r) => r.end !== undefined && r.end.sent !== r.statements.length)
		.map((r) => ({ label: r.label, sent: r.end?.sent, received: r.statements.length }));
	const seqs = all.map((s) => s.seq).sort((a, b) => a - b);
	report.coverage = {
		statements: all.length,
		contiguousSeq: seqs.every((s, i) => s === i + 1),
		requestsWithEnd: host.requests.filter((r) => r.end !== undefined).length,
		requests: host.requests.length,
		sentVsReceivedMismatches: mismatched,
		unknownClass: all.filter((s) => s.classes.includes('statement-unknown')).length,
		anyUnknown: all.filter((s) => s.classes.some((c) => /unknown/.test(c))).length,
		translateThrew: all.filter((s) => s.classes.includes('translate-threw')).length,
		translatorLookups: host.translationStats()
	};
	const frontBefore = frontBody;

	// persistence: a new host over the same file, a new server, the same page
	await server.stop();
	await host.stop();
	host = await startHost({ dbFile: site.db, socketPath: site.socket, keepText: true });
	server = await startPhpServer(site);
	const again = await httpGet(site, '/');
	report.persistence = {
		identicalBody: again.body === frontBefore,
		status: again.status,
		bytes: again.bytes,
		installedAgain: host.requests.some((r) =>
			r.statements.some((s) => /^\s*CREATE TABLE/i.test(s.sql ?? ''))
		)
	};
	await server.stop();
	await host.stop();

	// an old PHP process against a fresh host
	const resumed: ResumeResult[] = [];
	for (const resume of ['strict', 'gone-away', 'relaxed'] as Resume[]) {
		const probe = await prepareSite(join(dir, `resume-${resume}`));
		const installer = await startHost({ dbFile: probe.db, socketPath: probe.socket });
		const srv = await startPhpServer(probe);
		await installWordpress(probe);
		await srv.stop();
		await installer.stop();
		resumed.push(await resumeProbe(probe, resume));
	}
	report.resume = resumed;

	const text = JSON.stringify(report, null, 2);
	if (outDir !== undefined) writeFileSync(join(outDir, 'report.json'), text + '\n');
	process.stdout.write(text + '\n');
}

if (import.meta.main) await main();
