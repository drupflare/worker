#!/usr/bin/env bun
/**
 * Drives one fixture on a throwaway Worker and records the result, or folds those records into the
 * published history.
 *
 *   bun scripts/e2e/certify.ts --fixture=<id> --out=<dir> [--plan=free|paid] [--cpu-ms=<n>] [--anachron]
 *   bun scripts/e2e/certify.ts --select [--history=<file>]
 *   bun scripts/e2e/certify.ts --teardown --fixture=<id>
 *   bun scripts/e2e/certify.ts --aggregate --records=<dir> --history=<file> --status=<file>
 *     [--interval-days=<n>]
 *
 * A run deploys `cfw-e2e-cert-<id>` through the same path the deployed corpus lane uses, drives the
 * rows with `corpus-lane.ts --deployed`, always tears the worker down, and compares the account with
 * its starting inventory: residue fails the run. The record is written either way, because a failed
 * run is the evidence that demotes a fixture. An account with no budget left writes no record and
 * exits 3. Needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, which the job maps from the
 * `DRUPFLARE_` secrets.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { gitShortSha } from './anachron-deliver';
import {
	appendRecords,
	failingRows,
	statusFile,
	type CertRecord,
	type CertRow
} from './certification';
import { deployArgs } from './corpus-deploy';
import { anachronDir, type Compatibility, type Corpus } from './corpus-lane';
import { nativeNotes, nativeRoot } from './corpus-project';
import {
	inventory,
	isEmptyInventory,
	leftovers,
	teardownByName,
	type Inventory
} from './live-deploy';
import {
	dayBudget,
	planDay,
	rotationPeriodDays,
	runCost,
	WINDOW_DAYS,
	type Candidate,
	type RotationConfig
} from './rotation';

const ROOT = join(import.meta.dirname, '..', '..');

/** the throwaway's name; `teardownByName` refuses anything outside `cfw-e2e-` */
export const certName = (fixture: string): string =>
	`cfw-e2e-cert-${fixture.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 54);

/** the entries of an inventory named for one throwaway, so a sibling job's worker is not residue */
export function ownedBy(inv: Inventory, name: string): Inventory {
	const mine = (list: string[]) =>
		list.filter((e) => e.split(' ').some((p) => p.startsWith(name)));
	return {
		workers: mine(inv.workers),
		durableObjects: mine(inv.durableObjects),
		kv: mine(inv.kv),
		d1: mine(inv.d1)
	};
}

/** the fixture whose native install holds the database a run lands: a sub-project runs on its base distribution's */
export const nativeFixtureOf = (repo: { id: string; base?: string }): string =>
	repo.base ?? repo.id;

/** the sha256 of a file, for telling whether a run changed it */
const digestOf = (path: string): string =>
	createHash('sha256').update(readFileSync(path)).digest('hex');

/** `schedule` for a scheduled workflow run and `dispatch` for everything else */
export const triggerOf = (env: Record<string, string | undefined>): string =>
	env['GITHUB_EVENT_NAME'] === 'schedule' ? 'schedule' : 'dispatch';

/** every row unknown with one reason, for a run that never reached the rows */
export function unreached(rows: readonly string[], why: string): Record<string, CertRow> {
	return Object.fromEntries(rows.map((r) => [r, { state: 'unknown', note: why }]));
}

const flag = (args: readonly string[], name: string) =>
	args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const corpusOf = (): Corpus =>
	parse(readFileSync(join(ROOT, 'config', 'corpus.yml'), 'utf8')) as Corpus;

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
	return spawnSync(cmd, args, {
		cwd: ROOT,
		encoding: 'utf8',
		env: { ...process.env, ...env },
		maxBuffer: 256 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'inherit']
	});
}

/** the release the site ran: the package version and the commit the tree was built from */
function releaseId(): string {
	if (process.env['CERTIFY_BUILD']) {
		const v = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;
		return `${v}+${process.env['CERTIFY_BUILD'].split('+')[0]}`;
	}
	const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;
	const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
	return `${version}+${sha.status === 0 ? sha.stdout.trim() : 'unknown'}`;
}

/**
 * What the platform holds as a deployed script's CPU ceiling, in milliseconds, or undefined when it
 * holds none (the default). Read before teardown so a run cannot read as a raised ceiling that was
 * never applied.
 */
export async function readCpuLimit(name: string): Promise<number | undefined> {
	const account = process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '';
	const res = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}/settings`,
		{ headers: { authorization: `Bearer ${process.env['CLOUDFLARE_API_TOKEN'] ?? ''}` } }
	);
	if (!res.ok) throw new Error(`reading the settings of ${name} answered ${res.status}`);
	const body = (await res.json()) as { result?: { limits?: { cpu_ms?: number } } };
	return body.result?.limits?.cpu_ms;
}

/** the reason a run must stop when a raised ceiling was asked for and the deployed one differs */
export function cpuLimitProblem(asked: number, deployed: number | undefined): string | undefined {
	if (asked <= 0 || deployed === asked) return undefined;
	return `a CPU ceiling of ${asked} ms was asked for and the deployed script holds ${deployed ?? 'the default'}`;
}

async function checkCpuLimit(name: string, asked: number): Promise<string | undefined> {
	if (asked <= 0) return undefined;
	try {
		const deployed = await readCpuLimit(name);
		cpuLimitMs = deployed;
		return cpuLimitProblem(asked, deployed);
	} catch (e) {
		return `the deployed CPU ceiling could not be read: ${e instanceof Error ? e.message : String(e)}`;
	}
}

let cpuLimitMs: number | undefined;

/** what the site says it spent, read before teardown because deleting the worker deletes the analytics */
/** the meters of a `/serve-stats` answer: the day's rows and what the growth governor did */
export function meterReading(body: Record<string, unknown>): CertRecord['meters'] {
	if (typeof body['rowsToday'] !== 'number') return undefined;
	const refusals = Number(body['growthRefusals'] ?? 0);
	const log = Array.isArray(body['growthRefusalLog']) ? body['growthRefusalLog'] : undefined;
	const governed = Number(body['governedRuns'] ?? 0);
	return {
		rowsToday: body['rowsToday'],
		...(log && log.length > 0 ? { growthRefusalLog: log as Record<string, unknown>[] } : {}),
		...(body['freshFirst']
			? { freshFirst: body['freshFirst'] as Record<string, unknown> }
			: {}),
		...(body['isolateBytes']
			? { isolateBytes: body['isolateBytes'] as Record<string, unknown> }
			: {}),
		...(refusals > 0 || governed > 0
			? {
					growth: {
						refusals,
						governedRuns: governed,
						lastGoverned: (body['lastGoverned'] ?? null) as Record<
							string,
							unknown
						> | null
					}
				}
			: {})
	};
}

async function readMeters(origin: string): Promise<CertRecord['meters']> {
	try {
		const res = await fetch(new URL('/serve-stats', origin), {
			headers: { authorization: 'Bearer pw-diagnostics' },
			signal: AbortSignal.timeout(30_000)
		});
		const body = (await res.json()) as Record<string, unknown>;
		return meterReading(body);
	} catch {
		return undefined;
	}
}

async function certify(args: string[]): Promise<number> {
	const fixture = flag(args, 'fixture');
	const out = flag(args, 'out');
	const plan = flag(args, 'plan') ?? 'free';
	if (!fixture || !out) throw new Error('--fixture=<id> and --out=<dir> are required');
	if (plan !== 'free' && plan !== 'paid') throw new Error('--plan is free or paid');
	const corpus = corpusOf();
	const repo = corpus.repos.find((r) => r.id === fixture);
	if (!repo) throw new Error(`no fixture ${fixture} in config/corpus.yml`);
	const anachron = args.includes('--anachron');
	// a paid worker can raise the per-request CPU ceiling past the 30 s default, up to 300,000 ms
	const cpuMs = plan === 'paid' ? Number(flag(args, 'cpu-ms') ?? 0) : 0;
	// worker vars for an experiment, set on the deployed script only; the record then says it is one
	const vars = args.filter((a) => a.startsWith('--var=')).map((a) => a.slice(6));
	const experiment = flag(args, 'experiment');
	const laneFlags = anachron ? ['--anachron'] : [];
	const name = certName(fixture);
	const before = await inventory();
	let rows: Record<string, CertRow> = unreached(corpus.rows, 'the run did not start');
	let spent = false;
	let reached = false;
	let statsFile = '';
	let skipped: CertRecord['skipped'];
	let limitProblem: string | undefined;
	let meters: CertRecord['meters'];
	let residue = '';
	// landing a native database rewrites the pack's database and its chunks in this tree, so both are put back
	const packDb = join(ROOT, 'assets', 'drupal', 'site.sqlite');
	const packBackup = join(mkdtempSync(join(tmpdir(), 'certify-pack-')), 'site.sqlite');
	copyFileSync(packDb, packBackup);
	try {
		const work = process.env['CORPUS_DIR'] ?? join(ROOT, '.corpus');
		const nativeDb = join(nativeRoot(), nativeFixtureOf(repo), 'site.sqlite');
		run('bun', [
			'scripts/e2e/corpus-lane.ts',
			`--repo=${fixture}`,
			'--native-only',
			...laneFlags
		]);
		const deploy = existsSync(nativeDb)
			? run('bun', [
					'scripts/e2e/corpus-deploy.ts',
					`--native=${join(nativeRoot(), nativeFixtureOf(repo))}`,
					`--name=${name}`,
					...(plan === 'paid' ? ['--paid'] : []),
					...(cpuMs > 0 ? [`--cpu-ms=${cpuMs}`] : []),
					...vars.map((v) => `--var=${v}`)
				])
			: run('bun', deployArgs(name, { paid: plan === 'paid', cpuMs, vars }));
		const origin = /\{"origin":"([^"]+)"\}/.exec(deploy.stdout ?? '')?.[1];
		if (!origin) {
			spent = deploy.status === 0;
			rows = unreached(
				corpus.rows,
				spent
					? 'the account had no budget left for a run, so none was made'
					: `the deploy failed with exit ${deploy.status}`
			);
		} else if ((limitProblem = await checkCpuLimit(name, cpuMs)) !== undefined) {
			rows = unreached(corpus.rows, limitProblem);
			console.error(limitProblem);
		} else {
			statsFile = join(mkdtempSync(join(tmpdir(), 'certify-stats-')), 'stats.json');
			const lane = run(
				'bun',
				[
					'scripts/e2e/corpus-lane.ts',
					'--deployed',
					`--plan=${plan}`,
					`--repo=${fixture}`,
					...laneFlags
				],
				{ CORPUS_ORIGIN: origin, CORPUS_STATS_OUT: statsFile }
			);
			meters = await readMeters(origin);
			const file = join(
				ROOT,
				'docs',
				anachron ? 'compatibility-anachron.json' : 'compatibility.json'
			);
			const got = existsSync(file)
				? (JSON.parse(readFileSync(file, 'utf8')) as Compatibility).repos[fixture]?.deployed
				: undefined;
			reached = got !== undefined && got.sha === repo.sha;
			if (existsSync(nativeDb))
				skipped = nativeNotes(
					join(nativeRoot(), nativeFixtureOf(repo)),
					join(
						process.env['CORPUS_DIR'] ?? join(ROOT, '.corpus'),
						nativeFixtureOf(repo),
						repo.root ?? '.'
					)
				);
			rows = reached
				? got!.rows
				: unreached(corpus.rows, `the deployed lane ended with exit ${lane.status}`);
		}
	} finally {
		if (digestOf(packDb) !== digestOf(packBackup)) {
			copyFileSync(packBackup, packDb);
			run('bun', ['run', 'assets:sql']);
		}
		await teardownByName(name, ROOT).catch((e) => {
			residue = `teardown threw: ${e instanceof Error ? e.message : String(e)}`;
		});
		const left = ownedBy(leftovers(before, await inventory()), name);
		if (!isEmptyInventory(left))
			residue = `teardown left resources behind: ${JSON.stringify(left)}`;
	}
	if (spent) return 3;
	const repeatsFile = `${statsFile}.repeats.json`;
	const repeats = (
		statsFile && existsSync(repeatsFile)
			? (JSON.parse(readFileSync(repeatsFile, 'utf8')) as CertRecord['repeats'])
			: []
	)!;
	const record: CertRecord = {
		cms: 'drupal',
		fixture,
		sha: repo.sha,
		release: releaseId(),
		plan,
		rows,
		date: new Date().toISOString().slice(0, 10),
		at: new Date().toISOString(),
		trigger: triggerOf(process.env),
		...(experiment ? { experiment } : {}),
		...(process.env['CERTIFY_BUILD'] ? { build: process.env['CERTIFY_BUILD'] } : {}),
		...(skipped ? { skipped } : {}),
		...(statsFile && existsSync(statsFile)
			? { snapshots: JSON.parse(readFileSync(statsFile, 'utf8')) as CertRecord['snapshots'] }
			: {}),
		...(repeats.length > 0 ? { repeats } : {}),
		...(meters ? { meters } : {}),
		...(cpuLimitMs !== undefined ? { limits: { cpuMs: cpuLimitMs } } : {}),
		run: process.env['GITHUB_RUN_ID'] ? `github:${process.env['GITHUB_RUN_ID']}` : 'local',
		...(anachron
			? {
					anachron:
						gitShortSha(anachronDir([`--anachron`], process.env, ROOT) ?? '') ??
						'unversioned'
				}
			: {})
	};
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, `${fixture}.json`), `${JSON.stringify(record, null, '\t')}\n`);
	const enablesFile = `${statsFile}.enables.json`;
	if (statsFile && existsSync(enablesFile))
		copyFileSync(enablesFile, join(out, `${fixture}.enables.json`));
	const bad = failingRows(record, corpus.rows);
	console.log(
		`${fixture}: ${bad.length === 0 ? 'every row passed' : `failing ${bad.join(', ')}`}`
	);
	if (residue) {
		console.error(residue);
		return 1;
	}
	return reached ? 0 : 2;
}

type CertifyConfig = RotationConfig & {
	fixtures: string[];
	profileFixtures: string[];
	/** fixtures that fail the free plan's limits, with the cause recorded in the report */
	paidFixtures?: string[];
	/** fixtures whose core does not accept Drupal 11, run with the anachron arm */
	anachronFixtures?: string[];
};

const certifyConfig = (): CertifyConfig =>
	parse(readFileSync(join(ROOT, 'config', 'corpus-certify.yml'), 'utf8')) as CertifyConfig;

/** the fixtures today's run certifies, with their job timeouts, and the days one rotation takes */
export function selectDay(
	cfg: CertifyConfig,
	history: readonly CertRecord[],
	rows: readonly string[],
	allowPaid = false,
	windowDays = WINDOW_DAYS
): {
	include: { fixture: string; timeout: number; plan: string; anachron: boolean }[];
	periodDays: number;
} {
	const paid = new Set(cfg.paidFixtures ?? []);
	const candidates: Candidate[] = cfg.fixtures
		.filter((id) => allowPaid || !paid.has(id))
		.map((id) => {
			const last = history
				.filter((r) => r.fixture === id)
				.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
			return {
				id,
				cost: runCost(cfg, id),
				...(last
					? { lastRun: last.date, lastPassed: failingRows(last, rows).length === 0 }
					: {})
			};
		});
	const periodDays = rotationPeriodDays(cfg.fixtures.length, windowDays);
	const day = planDay(candidates, dayBudget(cfg), windowDays);
	if (day.loweredByBudget)
		console.error(
			`::warning::the row budget lowered today's fixtures from ${day.cap} to ${day.ids.length}`
		);
	const include = day.ids.map((fixture) => ({
		fixture,
		timeout: cfg.profileFixtures.includes(fixture) ? 150 : 90,
		plan: paid.has(fixture) ? 'paid' : 'free',
		anachron: (cfg.anachronFixtures ?? []).includes(fixture)
	}));
	return { include, periodDays };
}

function select(args: string[]): void {
	const historyPath = flag(args, 'history');
	const history =
		historyPath && existsSync(historyPath)
			? (JSON.parse(readFileSync(historyPath, 'utf8')) as CertRecord[])
			: [];
	const cfg = certifyConfig();
	const windowDays = Number(flag(args, 'window')) || WINDOW_DAYS;
	const day = selectDay(cfg, history, corpusOf().rows, flag(args, 'paid') === 'true', windowDays);
	console.log(JSON.stringify(day));
	if (process.env['GITHUB_OUTPUT'])
		writeFileSync(
			process.env['GITHUB_OUTPUT'],
			`matrix=${JSON.stringify({ include: day.include })}\nany=${day.include.length > 0}\nperiod=${day.periodDays}\nwindow=${windowDays}\n`,
			{ flag: 'a' }
		);
}

function aggregate(args: string[]): void {
	const records = flag(args, 'records');
	const historyPath = flag(args, 'history');
	const statusPath = flag(args, 'status');
	const cfg = certifyConfig();
	const windowDays = Number(flag(args, 'window')) || WINDOW_DAYS;
	const interval =
		Number(flag(args, 'interval-days')) || rotationPeriodDays(cfg.fixtures.length, windowDays);
	if (!records || !historyPath || !statusPath)
		throw new Error('--records, --history and --status are required');
	const added = (existsSync(records) ? readdirSync(records) : [])
		.filter((f) => f.endsWith('.json'))
		.map((f) => JSON.parse(readFileSync(join(records, f), 'utf8')) as CertRecord);
	const history = existsSync(historyPath)
		? (JSON.parse(readFileSync(historyPath, 'utf8')) as CertRecord[])
		: [];
	const merged = appendRecords(history, added);
	writeFileSync(historyPath, `${JSON.stringify(merged)}\n`);
	const status = statusFile(
		merged,
		corpusOf(),
		new Date().toISOString().slice(0, 10),
		interval,
		windowDays
	);
	writeFileSync(statusPath, `${JSON.stringify(status, null, '\t')}\n`);
	console.log(
		`${added.length} records added; ${Object.values(status.fixtures).filter((s) => s.state === 'certified').length} certified`
	);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const fixture = flag(args, 'fixture');
	if (args.includes('--aggregate')) aggregate(args);
	else if (args.includes('--select')) select(args);
	else if (args.includes('--teardown') && fixture) await teardownByName(certName(fixture), ROOT);
	else process.exit(await certify(args));
}
