import mysql from 'mysql2/promise';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type MysqlReply } from '../../src/db/sql/exec';
import { httpGet, installWordpress, prepareSite, runPhp, startPhpServer } from './harness';
import { startHost } from './host';
import { fromReply, runNative, type Captured, type Outcome } from './oracles';

const HERE = import.meta.dirname;
const arg = (name: string, fallback: string): string =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

/** the scenarios the PHP seed knows */
export const SCENARIOS = ['spaced', 'ties', 'protected', 'sticky'] as const;

/** one statement of the front page request, with what each arm answered */
export interface Compared {
	sql: string;
	ours: Outcome;
	native: Outcome;
	same: boolean;
}

/** what one scenario found: the titles on the page and each statement of the request on both arms */
export interface Found {
	scenario: string;
	titles: string[];
	statements: Compared[];
}

/** the post titles a block theme lists on its front page, in page order */
export function titlesOf(body: string): string[] {
	return [...body.matchAll(/<h2 class="wp-block-post-title[^>]*>(.*?)<\/h2>/gs)].map((m) =>
		(m[1] as string).replace(/<[^>]+>/g, '').trim()
	);
}

/**
 * Installs WordPress through the translator, seeds one scenario, reads the front page, then replays
 * every statement against a native server and compares the answers of the front page request.
 */
export async function compare(
	scenario: string,
	native: { port: number; password: string }
): Promise<Found> {
	const dir = mkdtempSync(join(tmpdir(), 'wp-front-order-'));
	const site = await prepareSite(dir);
	const host = await startHost({
		dbFile: site.db,
		socketPath: site.socket,
		keepText: true,
		keepReply: true
	});
	try {
		const install = await installWordpress(site);
		if (install.code !== 0) throw new Error(`install exited ${install.code}`);
		const seed = await runPhp(site, [join(HERE, 'frontpage-order.php')], {
			CFW_LABEL: 'seed',
			FRONT_SCENARIO: scenario
		});
		if (seed.code !== 0) throw new Error(`seed exited ${seed.code}: ${seed.stderr}`);
		const server = await startPhpServer(site);
		const page = await httpGet(site, '/?front=1');
		await httpGet(site, '/__ping');
		await server.stop();
		const titles = titlesOf(page.body);

		const lines: { seq: number; scenario: string; thread: string; sql: string }[] = [];
		const answers = new Map<number, Outcome>();
		host.requests.forEach((req, n) => {
			for (const s of req.statements) {
				if (s.sql === undefined) continue;
				lines.push({
					seq: s.seq,
					scenario: req.label.slice(0, 40),
					thread: String(n),
					sql: s.sql
				});
				answers.set(s.seq, fromReply(s.reply as MysqlReply));
			}
		});
		lines.sort((a, b) => a.seq - b.seq);
		const captured: Captured[] = lines.map((l, i) => ({
			scenario: l.scenario,
			i,
			thread: l.thread,
			sql: l.sql
		}));

		const admin = await mysql.createConnection({
			host: '127.0.0.1',
			port: native.port,
			user: 'root',
			password: native.password
		});
		await admin.query('DROP DATABASE IF EXISTS wp');
		await admin.query('CREATE DATABASE wp');
		await admin.end();
		const run = await runNative(captured, native);

		const statements: Compared[] = [];
		lines.forEach((l, i) => {
			if (!l.scenario.startsWith('GET /?front=1')) return;
			const ours = answers.get(l.seq) as Outcome;
			const theirs = run.outcomes[i] as Outcome;
			statements.push({
				sql: l.sql,
				ours,
				native: theirs,
				same: JSON.stringify(ours.rows) === JSON.stringify(theirs.rows)
			});
		});
		return { scenario, titles, statements };
	} finally {
		await host.stop();
		rmSync(dir, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const port = Number(arg('port', '13307'));
	const password = arg('password', process.env.MYSQL_ROOT_PASSWORD ?? '');
	const wanted = arg('scenario', SCENARIOS.join(',')).split(',');
	let differing = 0;
	for (const scenario of wanted) {
		const found = await compare(scenario, { port, password });
		const home = found.statements.find((s) => /SQL_CALC_FOUND_ROWS/i.test(s.sql));
		console.log(`${scenario}: titles ${JSON.stringify(found.titles)}`);
		console.log(
			`  home ids ours ${JSON.stringify(home?.ours.rows)} native ${JSON.stringify(home?.native.rows)}`
		);
		const bad = found.statements.filter((s) => !s.same);
		differing += bad.length;
		console.log(`  ${found.statements.length} statements, ${bad.length} differ`);
		for (const s of bad) {
			console.log(`  differs: ${s.sql.replace(/\s+/g, ' ').slice(0, 200)}`);
			console.log(`    ours ${JSON.stringify(s.ours.rows).slice(0, 300)}`);
			console.log(`    native ${JSON.stringify(s.native.rows).slice(0, 300)}`);
		}
	}
	process.exit(differing === 0 ? 0 : 1);
}
