import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ROWS_PER_TAGGED_PAGE, ROWS_PER_UNTAGGED_PAGE, fanoutDecision } from '../../src/ops/fanout';
import {
	noteWrittenRows,
	uncoveredWrites,
	writtenRows,
	writtenTables,
	type WrittenRows
} from '../../src/wordpress/tags';
import {
	httpGet,
	installWordpress,
	prepareSite,
	runPhp,
	startPhpServer,
	type PhpRun,
	type PhpServer,
	type Site
} from './harness';
import { startHost, type Host, type RequestRecord } from './host';

const HERE = import.meta.dirname;

/** the host plugin directory in the drupflare checkout; DRUPFLARE_SRC relocates it */
export const MU_DIR = join(
	process.env.DRUPFLARE_SRC ?? resolve(HERE, '../../../drupflare'),
	'src/Wp/mu'
);

/** a WordPress site on the local harness with the host plugin, a control and a naive plugin */
export interface TagSite {
	site: Site;
	host: Host;
	server: PhpServer;
	/** the install run's record, which carries every write the installer made */
	install: RequestRecord | undefined;
	stop(): Promise<void>;
}

/** what a page told the host */
export interface PageTags {
	path: string;
	status: number;
	tags: string[];
	untaggable: string | null;
	reasons: string[];
	readers: string[];
	/** what the render announced, which is nothing for a page that wrote nothing */
	calls: Record<string, unknown>[];
}

/** what one editorial write told the host, and what the host would have judged of it */
export interface ScenarioResult {
	scenario: string;
	removed: string | undefined;
	announced: string[];
	wholesale: string[];
	quiet: string[];
	/** content tables the successful statements wrote */
	writes: string[];
	/** writes the host's floor would turn into a wholesale purge */
	uncovered: string[];
	failed: boolean;
}

/** how much of the site's error log a failed install quotes, from the end */
const LOG_TAIL_CHARS = 2000;

/** a page of markup as plain text, since WordPress answers a fatal with an HTML error page */
function plainText(markup: string): string {
	return markup
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * The message for a failed install. The fatal itself is in the site's error log, because WordPress
 * catches it and prints a generic page, so the log tail comes first and both streams follow.
 */
export function installFailure(run: PhpRun, log: string): string {
	let logged = '';
	try {
		logged = readFileSync(log, 'utf8').trim();
	} catch {
		/* an install that died before the first log line has no file */
	}
	return [
		`install failed (exit ${run.code ?? 'signal'})`,
		`log: ${logged === '' ? '(empty)' : logged.slice(-LOG_TAIL_CHARS)}`,
		`stdout: ${plainText(run.stdout).slice(0, 400) || '(empty)'}`,
		`stderr: ${run.stderr.trim() || '(empty)'}`
	].join('\n');
}

/** copies the harness plugins into a prepared site and installs, then starts the server */
export async function startTagSite(prefix = 'wp-tags-'): Promise<TagSite> {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const site = await prepareSite(dir, { muPlugins: MU_DIR });
	const mu = join(site.www, 'wp-content/mu-plugins');
	mkdirSync(mu, { recursive: true });
	copyFileSync(join(HERE, 'tags-control.php'), join(mu, 'zz-tags-control.php'));
	copyFileSync(join(HERE, 'tags-naive.php'), join(mu, 'zz-tags-naive.php'));
	const host = await startHost({
		dbFile: site.db,
		socketPath: site.socket,
		resume: 'relaxed',
		keepText: true
	});
	const run = await installWordpress(site);
	if (run.code !== 0) {
		await host.stop();
		throw new Error(installFailure(run, site.log));
	}
	const install = host.requests.find((r) => r.label === 'install');
	const server = await startPhpServer(site);
	return {
		site,
		host,
		server,
		install,
		stop: async () => {
			await server.stop();
			await host.stop();
		}
	};
}

/** one GET, and what the emitter said about the page; a ping after it completes the record */
export async function renderPage(t: TagSite, path: string): Promise<PageTags> {
	const first = t.host.requests.length;
	const res = await httpGet(t.site, path);
	await httpGet(t.site, '/__ping');
	const record = t.host.requests.slice(first).find((r) => r.label === `GET ${path}`);
	const end = (record?.end?.['tags'] ?? {}) as {
		tags?: string[];
		untaggable?: string | null;
		reasons?: string[];
		readers?: string[];
	};
	return {
		path,
		status: res.status,
		tags: end.tags ?? [],
		untaggable: end.untaggable === undefined ? 'no-emitter' : end.untaggable,
		reasons: end.reasons ?? [],
		readers: end.readers ?? [],
		calls: record?.tagCalls ?? []
	};
}

/** what a record's calls announced, in the three kinds */
export function summarise(
	record: RequestRecord | undefined
): Pick<ScenarioResult, 'announced' | 'wholesale' | 'quiet' | 'writes' | 'uncovered'> {
	const announced = new Set<string>();
	const wholesale = new Set<string>();
	const quiet = new Set<string>();
	for (const call of record?.tagCalls ?? []) {
		if (call['op'] === 'announce')
			for (const tag of call['tags'] as string[]) announced.add(tag);
		if (call['op'] === 'wholesale') wholesale.add(String(call['reason']));
		if (call['op'] === 'quiet') quiet.add(String(call['table']));
	}
	const writes = new Set<string>();
	const rows: WrittenRows = new Map();
	for (const s of record?.statements ?? []) {
		if (s.ok && s.affected !== 0 && s.sql !== undefined) {
			const tables = writtenTables(s.sql);
			for (const table of tables) writes.add(table);
			noteWrittenRows(
				rows,
				tables,
				writtenRows(s.sql, {
					...(s.insertId === undefined ? {} : { insertId: s.insertId }),
					...(s.affected === undefined ? {} : { affected: s.affected })
				})
			);
		}
	}
	return {
		announced: [...announced],
		wholesale: [...wholesale],
		quiet: [...quiet],
		writes: [...writes],
		uncovered: uncoveredWrites(writes, announced, quiet, wholesale.size > 0, rows)
	};
}

/** runs one scenario as a CLI request, optionally with one hook of the emitter removed */
export async function runScenario(
	t: TagSite,
	scenario: string,
	removeHook?: string
): Promise<ScenarioResult> {
	const label = `scenario:${scenario}:${removeHook ?? ''}:${t.host.requests.length}`;
	const run = await runPhp(t.site, [join(HERE, 'tags-scenario.php')], {
		SCENARIO: scenario,
		CFW_LABEL: label,
		CFW_REMOVE_HOOK: removeHook ?? ''
	});
	const record = t.host.requests.find((r) => r.label === label);
	return {
		scenario,
		removed: removeHook,
		...summarise(record),
		failed: run.code !== 0
	};
}

/** the pages the accounting table stores, by path */
export const PAGE_PATHS = [
	'/',
	'/?p=1',
	'/?page_id=2',
	'/?s=hello',
	'/?feed=rss2',
	'/?cat=1',
	'/?author=1',
	'/?p=999',
	'/?rest_route=/wp/v2/posts'
];

// loaded by a computed specifier: the object's module graph is typed for workerd, and a static import
// would put it in this program, which types against the DOM
const INVALIDATE = '../../src/do/invalidate';
const { pathsForTags } = (await import(INVALIDATE)) as {
	pathsForTags: (store: never, tags: readonly string[]) => string[] | undefined;
};

/** a fake object holding page rows, enough for the real `pathsForTags` to read */
function fakeStore(pages: Record<string, string[]>): never {
	const rows = Object.entries(pages).map(([path, tags]) => ({
		path,
		tags: JSON.stringify(tags)
	}));
	return { sql: { exec: () => ({ toArray: () => rows }) } } as never;
}

/** which stored pages a run purges, by the same function the object uses */
export function purged(
	pages: Record<string, string[]>,
	result: Pick<ScenarioResult, 'announced' | 'wholesale'>
): { paths: string[]; scoped: boolean } {
	const all = Object.keys(pages);
	if (result.wholesale.length > 0) return { paths: all, scoped: false };
	if (result.announced.length === 0) return { paths: [], scoped: true };
	const paths = pathsForTags(fakeStore(pages), result.announced);
	return paths === undefined ? { paths: all, scoped: false } : { paths, scoped: true };
}

/** the rows a purge costs on the meter, counted from the constants the object prices with */
export function rowsFor(stored: number, outcome: { paths: string[]; scoped: boolean }) {
	const n = outcome.paths.length;
	if (n === 0) return { deleted: 0, marked: 0, refill: 0, policy: 'none' };
	if (outcome.scoped) {
		const decision = fanoutDecision(n, 25, false, ROWS_PER_TAGGED_PAGE);
		return {
			deleted: n,
			marked: 0,
			refill: decision.requeue * ROWS_PER_TAGGED_PAGE,
			policy: decision.policy
		};
	}
	return {
		deleted: 0,
		marked: stored,
		refill: Math.min(stored, 26) * ROWS_PER_UNTAGGED_PAGE,
		policy: 'wholesale'
	};
}
