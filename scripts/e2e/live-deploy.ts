#!/usr/bin/env bun
/**
 * Deploys a throwaway worker to a real Cloudflare account, drives it the way people use a site,
 * and fails on any invocation the platform recorded as a failure.
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bun scripts/e2e/live-deploy.ts
 *     [--rounds=3] [--gaps=0,30,150] [--keep] [--name=cfw-e2e-x] [--var=NAME=value]
 *     [--slope=8] [--deploy-only [--no-provision]] [--teardown] [--origin=http://localhost:8787]
 *     [--paid] [--cpu-ms=300000]
 *
 * An HTTP status cannot see the failures this lane exists for: a Durable Object reset for its
 * memory answers the visitor a 1101 from the front worker, and a retried request can still read
 * 200. So after the drive it reads the account's own record of every invocation (Workers
 * Observability events, and `workersInvocationsAdaptive` from GraphQL) and fails on any
 * exception, exceeded limit or storage reset.
 *
 * After the rounds it drives the admin pages back to back on one warm object and reads linear memory
 * after each pass. A persistent interpreter that keeps anything per request grows until the recycle
 * drops it, so the run also fails when that drive recycles or grows past one allocator rung.
 *
 * Teardown always runs: the worker, then every Durable Object namespace, KV namespace and D1
 * database this run created, identified by diffing the account before and after the deploy and
 * never by name alone. The account is then compared with its starting inventory again, and a
 * leftover fails the run.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHIPPING_STEP } from '../measure/growth-glue';

// #region pure helpers, exported for the gate

/** what the account holds, by kind; each entry is `id name` */
export type Inventory = {
	workers: string[];
	durableObjects: string[];
	kv: string[];
	d1: string[];
};

/** entries present after that were not present before, per kind */
export function leftovers(before: Inventory, after: Inventory): Inventory {
	const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
	return {
		workers: minus(after.workers, before.workers),
		durableObjects: minus(after.durableObjects, before.durableObjects),
		kv: minus(after.kv, before.kv),
		d1: minus(after.d1, before.d1)
	};
}

export const isEmptyInventory = (inv: Inventory) =>
	inv.workers.length + inv.durableObjects.length + inv.kv.length + inv.d1.length === 0;

/** an Observability event, reduced to what the verdict reads */
export type Event = {
	outcome?: string;
	level?: string;
	message?: string;
	url?: string;
	entry?: string;
};

/** outcomes that are not a failure of the site: success, and a client that stopped reading */
const FINE = new Set(['ok', 'canceled', 'clientDisconnected']);

/** log text that means an object was reset under a request */
const RESET_TEXT = /caused object to be reset|Network connection lost|exceeded its memory limit/i;

/** every event that should fail the lane, with the reason */
export function failures(events: Event[]): string[] {
	const out: string[] = [];
	for (const e of events) {
		if (e.outcome !== undefined && !FINE.has(e.outcome)) {
			out.push(`${e.entry ?? 'invocation'} ${e.outcome} ${e.url ?? ''}`.trim());
		} else if (e.level === 'error' && RESET_TEXT.test(e.message ?? '')) {
			out.push(`log: ${String(e.message).slice(0, 200)}`);
		}
	}
	return [...new Set(out)];
}

/** every hidden input of a form, entity-decoded, because a token must travel back verbatim */
export function hiddenFields(html: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const tag of html.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []) {
		const name = /name="([^"]*)"/.exec(tag)?.[1];
		const value = (/value="([^"]*)"/.exec(tag)?.[1] ?? '')
			.replace(/&amp;/g, '&')
			.replace(/&quot;/g, '"')
			.replace(/&#0?39;/g, "'");
		if (name) fields[name] = value;
	}
	return fields;
}

/** the values of the text-like inputs a settings form carries, so a resubmit keeps them */
export function textFields(html: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const tag of html.match(/<input[^>]*type="(?:text|email|url|number)"[^>]*>/g) ?? []) {
		const name = /name="([^"]*)"/.exec(tag)?.[1];
		if (name) fields[name] = (/value="([^"]*)"/.exec(tag)?.[1] ?? '').replace(/&amp;/g, '&');
	}
	return fields;
}

export const encodeForm = (fields: Record<string, string>) =>
	Object.entries(fields)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join('&');

/** the Drupal session cookie from a login response, as a Cookie header value */
export function sessionFrom(setCookies: string[]): string | null {
	const line = setCookies.find((c) => /^S?SESS[0-9a-f]+=/.test(c));
	return line ? (line.split(';')[0] ?? null) : null;
}

/** markup that means Drupal rendered an error page rather than the page asked for */
// php prints the class and a colon; bare "Uncaught Exception" is text a page may carry (drupalx)
export const ERROR_PAGE =
	/The website encountered an unexpected error|Fatal error:|Uncaught [\w\\]+: /;

// #endregion

// #region the account

const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const token = process.env.CLOUDFLARE_API_TOKEN ?? '';

async function cf<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			...init.headers
		}
	});
	const body = (await res.json()) as { success?: boolean; result?: T; errors?: unknown };
	if (!res.ok || body.success === false) {
		throw new Error(
			`${init.method ?? 'GET'} ${path}: ${res.status} ${JSON.stringify(body.errors)}`
		);
	}
	return body.result as T;
}

async function inventory(): Promise<Inventory> {
	const [workers, dos, kv, d1] = await Promise.all([
		cf<{ id: string }[]>('/workers/scripts'),
		cf<{ id: string; name: string }[]>('/workers/durable_objects/namespaces?per_page=1000'),
		cf<{ id: string; title: string }[]>('/storage/kv/namespaces?per_page=100'),
		cf<{ uuid: string; name: string }[]>('/d1/database?per_page=100')
	]);
	return {
		workers: workers.map((w) => w.id),
		durableObjects: dos.map((d) => `${d.id} ${d.name}`),
		kv: kv.map((k) => `${k.id} ${k.title}`),
		d1: d1.map((d) => `${d.uuid} ${d.name}`)
	};
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
	const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ query, variables })
	});
	const body = (await res.json()) as { data?: T; errors?: unknown };
	if (body.errors) throw new Error(`graphql: ${JSON.stringify(body.errors).slice(0, 400)}`);
	return body.data as T;
}

/** the account's requests and rows written today, across every worker and object */
async function spentToday(): Promise<{ requests: number; rowsWritten: number }> {
	const day = new Date().toISOString().slice(0, 10);
	const data = await graphql<{
		viewer: {
			accounts: {
				w: { sum: { requests: number } }[];
				d: { sum: { rowsWritten: number } }[];
			}[];
		};
	}>(
		`
			query ($a: String!, $day: Date!, $since: Time!) {
				viewer {
					accounts(filter: { accountTag: $a }) {
						w: workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $since }) {
							sum {
								requests
							}
						}
						d: durableObjectsPeriodicGroups(limit: 1, filter: { date_geq: $day }) {
							sum {
								rowsWritten
							}
						}
					}
				}
			}
		`,
		{ a: account, day, since: `${day}T00:00:00Z` }
	);
	const acc = data.viewer.accounts[0];
	return {
		requests: acc?.w[0]?.sum.requests ?? 0,
		rowsWritten: acc?.d[0]?.sum.rowsWritten ?? 0
	};
}

/**
 * The run's objects per minute: the largest isolate memory the platform sampled and how many
 * invocations it reset for memory. The only reading of real isolate memory there is; the
 * interpreter's own estimate leaves out the JavaScript side.
 */
async function objectMemory(
	namespaces: string[],
	since: string
): Promise<
	{ minute: string; maxMemoryMiB: number; exceededMemory: number; rowsWritten: number }[]
> {
	if (namespaces.length === 0) return [];
	const data = await graphql<{
		viewer: {
			accounts: {
				d: {
					dimensions: { datetimeMinute: string };
					max: { memoryUsageBytes: number };
					sum: { exceededMemoryErrors: number; rowsWritten: number };
				}[];
			}[];
		};
	}>(
		`
			query ($a: String!, $ns: [String!], $since: Time!) {
				viewer {
					accounts(filter: { accountTag: $a }) {
						d: durableObjectsPeriodicGroups(
							limit: 200
							filter: { namespaceId_in: $ns, datetime_geq: $since }
							orderBy: [datetimeMinute_ASC]
						) {
							dimensions {
								datetimeMinute
							}
							max {
								memoryUsageBytes
							}
							sum {
								exceededMemoryErrors
								rowsWritten
							}
						}
					}
				}
			}
		`,
		{ a: account, ns: namespaces, since }
	);
	return (data.viewer.accounts[0]?.d ?? []).map((row) => ({
		minute: row.dimensions.datetimeMinute,
		maxMemoryMiB: Math.round((row.max.memoryUsageBytes / 1048576) * 10) / 10,
		exceededMemory: row.sum.exceededMemoryErrors,
		rowsWritten: row.sum.rowsWritten
	}));
}

/** how the front worker's invocations ended, by status */
async function workerStatuses(name: string, since: string): Promise<Record<string, number>> {
	const data = await graphql<{
		viewer: {
			accounts: { w: { sum: { requests: number }; dimensions: { status: string } }[] }[];
		};
	}>(
		`
			query ($a: String!, $name: String!, $since: Time!) {
				viewer {
					accounts(filter: { accountTag: $a }) {
						w: workersInvocationsAdaptive(
							limit: 50
							filter: { scriptName: $name, datetime_geq: $since }
						) {
							sum {
								requests
							}
							dimensions {
								status
							}
						}
					}
				}
			}
		`,
		{ a: account, name, since }
	);
	const out: Record<string, number> = {};
	for (const row of data.viewer.accounts[0]?.w ?? []) {
		out[row.dimensions.status] = (out[row.dimensions.status] ?? 0) + row.sum.requests;
	}
	return out;
}

/** every Observability event for the worker in the window, objects included */
async function events(name: string, from: number, to: number): Promise<Event[]> {
	const result = await cf<{ events?: { events?: Record<string, any>[] } }>(
		'/workers/observability/telemetry/query',
		{
			method: 'POST',
			body: JSON.stringify({
				queryId: `live-e2e-${name}`,
				view: 'events',
				limit: 2000,
				timeframe: { from, to },
				parameters: {
					filterCombination: 'and',
					filters: [
						{ key: '$metadata.service', operation: 'eq', type: 'string', value: name }
					]
				}
			})
		}
	);
	return (result.events?.events ?? []).map((e) => {
		const w = e['$workers'] ?? {};
		const m = e['$metadata'] ?? {};
		const src = e['source'];
		return {
			outcome: w.outcome,
			entry: w.entrypoint ?? w.eventType,
			url: w.event?.request?.url,
			level: m.level,
			message:
				typeof src === 'object' && src !== null
					? (src.message ?? JSON.stringify(src))
					: (m.message ?? src)
		};
	});
}

// #endregion

// #region the drive

type Step = { path: string; status: number; ms: number; note?: string };

class Site {
	requests = 0;
	steps: Step[] = [];
	problems: string[] = [];
	cookie: string | null = null;

	constructor(readonly origin: string) {}

	async hit(
		path: string,
		init: RequestInit & { expect?: number[]; auth?: boolean } = {}
	): Promise<{ res: Response; body: string }> {
		const t0 = Date.now();
		const headers = new Headers(init.headers);
		if (init.auth && this.cookie) headers.set('cookie', this.cookie);
		this.requests += 1;
		const res = await fetch(new URL(path, this.origin), {
			...init,
			headers,
			redirect: 'manual',
			signal: AbortSignal.timeout(120_000)
		});
		const body = await res.text();
		const expect = init.expect ?? [200];
		const step: Step = { path, status: res.status, ms: Date.now() - t0 };
		this.steps.push(step);
		if (!expect.includes(res.status)) {
			this.problems.push(
				`${init.method ?? 'GET'} ${path} answered ${res.status}, expected ${expect.join('/')}: ${body.slice(0, 160)}`
			);
		} else if (res.status === 200 && ERROR_PAGE.test(body)) {
			this.problems.push(`${init.method ?? 'GET'} ${path} rendered an error page`);
		}
		return { res, body };
	}

	async post(path: string, fields: Record<string, string>, expect = [303, 302]) {
		return this.hit(path, {
			method: 'POST',
			auth: true,
			expect,
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: encodeForm(fields)
		});
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function provision(site: Site, pass: string): Promise<string> {
	// the first request provisions the object; poll until it stops answering 503 while it migrates
	for (let i = 0; i < 60; i++) {
		const res = await fetch(new URL('/', site.origin), {
			signal: AbortSignal.timeout(120_000)
		});
		site.requests += 1;
		const text = await res.text();
		if (res.status !== 503 && !/Worker not found|There is nothing here yet/i.test(text)) break;
		await sleep(5_000);
	}
	const first = await fetch(new URL('/', site.origin), { signal: AbortSignal.timeout(120_000) });
	if (quotaExhausted(await first.text()))
		throw new QuotaSkip('the first request reported the quota spent');
	const claim = await site.hit('/firstrun', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			siteName: 'drupflare e2e',
			adminName: 'admin',
			adminPass: pass,
			adminMail: 'e2e@example.invalid'
		})
	});
	if (quotaExhausted(claim.body)) throw new QuotaSkip('/firstrun reported the quota spent');
	let owner: string | undefined;
	try {
		owner = (JSON.parse(claim.body) as { ownerToken?: string }).ownerToken;
	} catch {
		throw new Error(
			`/firstrun answered ${claim.res.status} with no JSON: ${claim.body.slice(0, 300)}`
		);
	}
	if (!owner) throw new Error(`/firstrun returned no owner token: ${claim.body.slice(0, 300)}`);
	return owner;
}

async function login(site: Site, pass: string): Promise<void> {
	const form = await site.hit('/user/login');
	const hidden = hiddenFields(form.body);
	const res = await site.post('/user/login', { ...hidden, name: 'admin', pass, op: 'Log in' });
	site.cookie = sessionFrom(res.res.headers.getSetCookie());
	if (!site.cookie) site.problems.push('the login set no session cookie');
}

async function anonymousRound(site: Site): Promise<void> {
	await site.hit('/');
	await site.hit('/?edge=0');
	await site.hit(`/does-not-exist-${Date.now()}`, { expect: [404] });
	await site.hit('/core/misc/drupal.js');
	await site.hit('/user/login');
	await site.hit('/user/password');
}

const ADMIN_PATHS = [
	'/',
	'/admin/content',
	'/admin/content/block',
	'/admin/people',
	'/admin/modules',
	'/admin/reports/status',
	'/node/add'
];

async function authenticatedRound(site: Site, round: number): Promise<void> {
	// `/node/add` redirects to the one content type when a site has only one
	for (const path of ADMIN_PATHS)
		await site.hit(path, { auth: true, expect: path === '/node/add' ? [200, 302] : [200] });
	const add = await site.hit('/node/add/page', { auth: true });
	const created = await site.post('/node/add/page', {
		...hiddenFields(add.body),
		'title[0][value]': `e2e round ${round}`,
		'body[0][value]': `created by the live lane, round ${round}`,
		op: 'Save'
	});
	const nid = /\/node\/(\d+)/.exec(created.res.headers.get('location') ?? '')?.[1];
	if (!nid) {
		site.problems.push(`node create returned no node location (${created.res.status})`);
		return;
	}
	await site.hit(`/node/${nid}`, { auth: true });
	const edit = await site.hit(`/node/${nid}/edit`, { auth: true });
	await site.post(`/node/${nid}/edit`, {
		...hiddenFields(edit.body),
		'title[0][value]': `e2e round ${round} edited`,
		'body[0][value]': 'edited',
		op: 'Save'
	});
	const del = await site.hit(`/node/${nid}/delete`, { auth: true });
	await site.post(`/node/${nid}/delete`, { ...hiddenFields(del.body), op: 'Delete' });
	await site.hit(`/node/${nid}`, { auth: true, expect: [404] });
	const settings = await site.hit('/admin/config/system/site-information', { auth: true });
	await site.post(
		'/admin/config/system/site-information',
		{
			...textFields(settings.body),
			...hiddenFields(settings.body),
			site_slogan: `round ${round}`,
			op: 'Save configuration'
		},
		[303, 302, 200]
	);
}

/** rows written the free plan allows an account per UTC day, across every Durable Object */
export const FREE_DAILY_ROWS = 100_000;

/**
 * Rows one lane run writes, measured on the free account and rounded up.
 *
 * The preflight compares this against what the account has already written today, so a run that
 * would exhaust the quota part-way is skipped before it deploys anything.
 */
export const ROWS_PER_RUN = 12_000;

/** the text the platform answers once the account has spent its daily rows */
const QUOTA_TEXT =
	/Exceeded allowed rows written in Durable Objects free tier|daily request limit/i;

/** whether an answer says the account's free quota for today is spent */
export function quotaExhausted(text: string): boolean {
	return QUOTA_TEXT.test(text);
}

/** raised when the account cannot carry the run; the lane skips rather than failing */
export class QuotaSkip extends Error {}

/** the notice a skipped run prints, naming what was used, what was needed and when it resets */
export function quotaNotice(used: number | null, needed: number, now = new Date()): string {
	const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
	const limit = FREE_DAILY_ROWS.toLocaleString('en-US');
	const state =
		used === null
			? `the platform refused a write because the free account's ${limit} daily Durable Object rows are spent`
			: `the free account has written ${used.toLocaleString('en-US')} of ${limit} Durable Object rows today`;
	return `skipped: ${state}, and a run needs ${needed.toLocaleString('en-US')}; the quota resets at ${reset.toISOString()}`;
}

/**
 * Whether the platform logged a spent quota for this run.
 *
 * The visitor sees only the front worker's error page, so the reason is read from the account's own
 * event log, which lags by up to a minute.
 */
async function quotaInEvents(name: string, since: number): Promise<boolean> {
	for (let i = 0; i < 6; i++) {
		const seen = await events(name, since - 60_000, Date.now()).catch(() => [] as Event[]);
		if (seen.some((e) => quotaExhausted(JSON.stringify(e)))) return true;
		if (seen.length > 0) return false;
		await sleep(10_000);
	}
	return false;
}

/** one reading of `/serve-stats` taken after a pass over the admin pages */
export type MemorySample = { linear: number; recycles: number };

/**
 * Whether a warm drive held its memory, after `warm` passes of warm-up.
 *
 * Linear memory moves in allocator rungs of `SHIPPING_STEP`, so a single rise is quantisation and
 * tolerated once; a leak of even 0.1 MiB per request crosses several over a drive. A recycle is a
 * failure on its own, because it is the recycle that hides a leak until the object resets.
 */
export function slopeVerdict(samples: MemorySample[], warm = 2): string | null {
	const tail = samples.slice(warm);
	if (tail.length < 2) return `the warm drive took ${samples.length} readings, too few to judge`;
	const first = tail[0]!;
	const last = tail[tail.length - 1]!;
	if (last.recycles > first.recycles) {
		return `the warm drive recycled the interpreter ${last.recycles - first.recycles} time(s)`;
	}
	const ceiling = first.linear * (1 + SHIPPING_STEP) + 65_536;
	if (last.linear > ceiling) {
		const mib = (n: number) => (n / 1_048_576).toFixed(2);
		return `linear memory grew ${mib(first.linear)} -> ${mib(last.linear)} MiB over ${tail.length - 1} warm passes`;
	}
	return null;
}

/** the admin pages plus the heaviest authenticated ones, which set the high-water mark */
const WARM_PATHS = [
	...ADMIN_PATHS,
	'/admin/config',
	'/admin/structure',
	'/admin/appearance',
	'/user/1/edit',
	'/node/add/page'
];

async function warmDrive(site: Site, owner: string, passes: number): Promise<MemorySample[]> {
	const samples: MemorySample[] = [];
	for (let pass = 0; pass < passes; pass++) {
		for (const path of WARM_PATHS) {
			await site.hit(path, { auth: true, expect: path === '/node/add' ? [200, 302] : [200] });
		}
		const stats = await site.hit('/serve-stats', {
			headers: { authorization: `Bearer ${owner}` }
		});
		try {
			const body = JSON.parse(stats.body) as {
				isolateBytes?: { linear?: number };
				recycles?: number;
				lastRecycle?: { bytes?: number } | null;
			};
			// a recycled interpreter reads 0 until the next request boots, so its size is the one
			// the recycle recorded
			samples.push({
				linear: Number(body.isolateBytes?.linear || body.lastRecycle?.bytes || 0),
				recycles: Number(body.recycles ?? 0)
			});
		} catch {
			// the status assertion already recorded a non-JSON answer
		}
	}
	return samples;
}

// #endregion

/**
 * The same drive against a site that is already running, such as a local `wrangler dev`.
 *
 * Nothing is deployed, read from the account or torn down, so this answers only what the site
 * itself reports: statuses, error pages and the warm drive's memory readings.
 */
async function driveLocal(
	origin: string,
	rounds: number,
	gaps: number[],
	passes: number
): Promise<void> {
	const site = new Site(origin);
	const pass = `e2e-${crypto.randomUUID()}`;
	const owner = await provision(site, pass);
	for (let round = 1; round <= rounds; round++) {
		if (gaps[round - 1]) await sleep(gaps[round - 1]!);
		site.cookie = null;
		await anonymousRound(site);
		await login(site, pass);
		await authenticatedRound(site, round);
		console.log(
			`round ${round}: ${site.steps.length} requests so far, ${site.problems.length} problems`
		);
	}
	if (passes > 0) {
		await login(site, pass);
		const samples = await warmDrive(site, owner, passes);
		console.log(
			`warm drive: linear ${samples.map((m) => (m.linear / 1_048_576).toFixed(2)).join(' ')} MiB, recycles ${samples.map((m) => m.recycles).join(' ')}`
		);
		const slope = slopeVerdict(samples);
		if (slope) site.problems.push(slope);
	}
	for (const p of site.problems) console.log(`::error::${p}`);
	if (site.problems.length > 0) process.exit(1);
	console.log('local drive: every request answered as expected');
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const flag = (name: string) =>
		args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
	const rounds = Number(flag('rounds') ?? 3);
	const passes = Number(flag('slope') ?? 8);
	const gaps = (flag('gaps') ?? '0,30,150').split(',').map((s) => Number(s) * 1000);
	const local = flag('origin');
	if (local) return driveLocal(local, rounds, gaps, passes);
	if (!account || !token)
		throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
	const name = flag('name') ?? `cfw-e2e-${process.env.GITHUB_RUN_ID ?? Date.now().toString(36)}`;
	const keep = args.includes('--keep');
	if (args.includes('--teardown')) {
		await teardownByName(name, join(import.meta.dir, '..', '..'));
		return;
	}
	const root = join(import.meta.dir, '..', '..');
	const config = join(root, `wrangler.${name}.jsonc`);
	const summary: string[] = [];
	const report = (line: string) => {
		console.log(line);
		summary.push(line);
	};

	// a paid account has no daily row quota to fit inside, and its own traffic would read as spent
	const paid = args.includes('--paid');
	const spent = await spentToday().catch(() => null);
	if (spent && !paid) {
		report(
			`account today before the run: ${spent.requests} requests, ${spent.rowsWritten} rows written`
		);
		if (spent.rowsWritten + ROWS_PER_RUN > FREE_DAILY_ROWS || spent.requests > 90_000) {
			const notice = quotaNotice(spent.rowsWritten, ROWS_PER_RUN);
			console.log(`::notice::${notice}`);
			if (process.env.GITHUB_STEP_SUMMARY) {
				writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Live deploy\n\n- ${notice}\n`, {
					flag: 'a'
				});
			}
			return;
		}
	}

	const before = await inventory();
	const base = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
	base.name = name;
	base.d1_databases = [{ binding: 'FLEET_DB', database_name: `${name}-fleet` }];
	// a paid account can raise the per-invocation CPU ceiling past the 30 s default
	const cpuMs = Number(flag('cpu-ms') ?? 0);
	if (cpuMs > 0) base.limits = { ...base.limits, cpu_ms: cpuMs };
	// `--var=NAME=value` sets a var for an arm, e.g. the paid warming interval on a free account
	for (const pair of args.filter((a) => a.startsWith('--var=')).map((a) => a.slice(6))) {
		const at = pair.indexOf('=');
		if (at > 0) base.vars[pair.slice(0, at)] = pair.slice(at + 1);
	}
	writeFileSync(config, JSON.stringify(base, null, '\t'));

	const started = Date.now();
	let failed: string[] = [];
	let skipped: string | null = null;
	let deployedOnly = false;
	try {
		const deploy = spawnSync('bunx', ['wrangler', 'deploy', '-c', config], {
			cwd: root,
			encoding: 'utf8',
			env: process.env,
			maxBuffer: 64 * 1024 * 1024
		});
		process.stdout.write(deploy.stdout ?? '');
		process.stderr.write(deploy.stderr ?? '');
		if (deploy.status !== 0) throw new Error(`wrangler deploy exited ${deploy.status}`);
		const origin = /https:\/\/[^\s]+\.workers\.dev/.exec(deploy.stdout ?? '')?.[0];
		if (!origin) throw new Error('wrangler printed no workers.dev URL');
		report(`deployed ${name} at ${origin}`);
		// a new Durable Object namespace answers "Worker not found" for about a minute
		await sleep(60_000);

		if (args.includes('--deploy-only') && args.includes('--no-provision')) {
			// the caller claims the site itself (the corpus lane's deployed mode)
			console.log(JSON.stringify({ origin }));
			deployedOnly = true;
			return;
		}
		const site = new Site(origin);
		const pass = `e2e-${crypto.randomUUID()}`;
		const owner = await provision(site, pass);
		if (args.includes('--deploy-only')) {
			// for driving the site by hand; `--teardown --name=<name>` removes it afterwards
			console.log(JSON.stringify({ origin, owner, pass }));
			deployedOnly = true;
			return;
		}
		for (let round = 1; round <= rounds; round++) {
			if (gaps[round - 1]) {
				report(`idle ${gaps[round - 1]! / 1000} s before round ${round}`);
				await sleep(gaps[round - 1]!);
			}
			site.cookie = null;
			await anonymousRound(site);
			await login(site, pass);
			await authenticatedRound(site, round);
			report(
				`round ${round}: ${site.steps.length} requests so far, ${site.problems.length} problems`
			);
		}
		let slope: string | null = null;
		if (passes > 0) {
			await login(site, pass);
			const samples = await warmDrive(site, owner, passes);
			const mib = (n: number) => (n / 1_048_576).toFixed(2);
			report(
				`warm drive: linear ${samples.map((m) => mib(m.linear)).join(' ')} MiB, recycles ${samples.map((m) => m.recycles).join(' ')}`
			);
			slope = slopeVerdict(samples);
		}
		const stats = await site.hit('/serve-stats', {
			headers: { authorization: `Bearer ${owner}` }
		});
		let rows: number | undefined;
		if (process.env.LIVE_EVENTS_OUT) {
			writeFileSync(`${process.env.LIVE_EVENTS_OUT}.stats.json`, stats.body);
			writeFileSync(
				`${process.env.LIVE_EVENTS_OUT}.steps.json`,
				JSON.stringify(site.steps, null, 1)
			);
		}
		try {
			rows = (JSON.parse(stats.body) as { rowsToday?: number }).rowsToday;
		} catch {
			// the status assertion above already recorded a non-JSON answer
		}
		report(
			`drive spent ${site.requests} requests from this runner; the site reports ${rows ?? 'unknown'} rows written today`
		);

		// the account's own record, read before teardown because deleting a worker deletes it
		await sleep(90_000);
		const seen = await events(name, started - 60_000, Date.now());
		if (process.env.LIVE_EVENTS_OUT)
			writeFileSync(process.env.LIVE_EVENTS_OUT, JSON.stringify(seen, null, 1));
		const statuses = await workerStatuses(name, new Date(started).toISOString()).catch((e) => ({
			error: String(e)
		}));
		report(
			`observability: ${seen.length} events; front worker statuses ${JSON.stringify(statuses)}`
		);
		const namespaces = leftovers(before, await inventory())
			.durableObjects.filter((e) => e.includes(`${name}_SitePhpDurableObject`))
			.map((e) => e.split(' ')[0] as string);
		const memory = await objectMemory(namespaces, new Date(started).toISOString()).catch(
			() => []
		);
		const peak = Math.max(0, ...memory.map((m) => m.maxMemoryMiB));
		const resets = memory.reduce((n, m) => n + m.exceededMemory, 0);
		report(
			`object memory: peak ${peak} MiB over ${memory.length} sampled minutes, ${resets} memory resets`
		);
		// read before teardown: deleting the namespace deletes these rows from the account's analytics
		report(
			`rows written by this run's objects: ${memory.reduce((n, m) => n + m.rowsWritten, 0)} (analytics), ${rows ?? 'unknown'} (the site's own meter)`
		);
		if (process.env.LIVE_EVENTS_OUT)
			writeFileSync(
				`${process.env.LIVE_EVENTS_OUT}.memory.json`,
				JSON.stringify(memory, null, 1)
			);
		failed = [...site.problems, ...failures(seen)];
		if (slope) failed.push(slope);
		if (resets > 0)
			failed.push(
				`the platform reset objects for memory ${resets} time(s), peak ${peak} MiB`
			);
		for (const [status, n] of Object.entries(statuses)) {
			if (
				status !== 'success' &&
				status !== 'clientDisconnected' &&
				typeof n === 'number' &&
				n > 0
			) {
				failed.push(`front worker status ${status} x${n}`);
			}
		}
	} catch (e) {
		if (e instanceof QuotaSkip || (await quotaInEvents(name, started))) {
			skipped = quotaNotice(null, ROWS_PER_RUN);
		} else failed.push(`the run itself failed: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		rmSync(config, { force: true });
		if (!keep && !deployedOnly) {
			spawnSync('bunx', ['wrangler', 'delete', '--name', name, '--force'], {
				cwd: root,
				stdio: 'inherit',
				env: process.env
			});
			const created = leftovers(before, await inventory());
			// only what this run made: every id here was absent before the deploy and names the run
			for (const entry of created.durableObjects) {
				const [id, doName] = entry.split(' ');
				if (doName?.startsWith(name))
					await cf(`/workers/durable_objects/namespaces/${id}`, {
						method: 'DELETE'
					}).catch((e) => failed.push(String(e)));
			}
			for (const entry of created.kv) {
				const [id, title] = entry.split(' ');
				if (title?.startsWith(name))
					await cf(`/storage/kv/namespaces/${id}`, { method: 'DELETE' }).catch((e) =>
						failed.push(String(e))
					);
			}
			for (const entry of created.d1) {
				const [id, dbName] = entry.split(' ');
				if (dbName?.startsWith(name))
					await cf(`/d1/database/${id}`, { method: 'DELETE' }).catch((e) =>
						failed.push(String(e))
					);
			}
			// only this run's names count: a baseline diff also sees anything another client created
			const mine = (entries: string[]) => entries.filter((e) => e.includes(name));
			const diff = leftovers(before, await inventory());
			const left = {
				workers: mine(diff.workers),
				durableObjects: mine(diff.durableObjects),
				kv: mine(diff.kv),
				d1: mine(diff.d1)
			};
			if (!isEmptyInventory(left))
				failed.push(`teardown left resources behind: ${JSON.stringify(left)}`);
			else if (!isEmptyInventory(diff))
				console.log(
					`::warning::the account gained resources this run did not create: ${JSON.stringify(diff)}`
				);
			else report('teardown: the account matches its starting inventory');
		}
		const after = await spentToday().catch(() => null);
		if (after)
			report(
				`account today after the run: ${after.requests} requests, ${after.rowsWritten} rows written`
			);
		if (process.env.GITHUB_STEP_SUMMARY) {
			writeFileSync(
				process.env.GITHUB_STEP_SUMMARY,
				[
					'## Live deploy',
					'',
					...summary.map((l) => `- ${l}`),
					...failed.map((l) => `- FAILED: ${l}`),
					''
				].join('\n'),
				{ flag: 'a' }
			);
		}
	}
	// a quota the run itself exhausted says nothing about the product, so it is a skip as well
	if (skipped === null && failed.some(quotaExhausted)) skipped = quotaNotice(null, ROWS_PER_RUN);
	if (skipped !== null) {
		console.log(`::notice::${skipped}`);
		if (process.env.GITHUB_STEP_SUMMARY) {
			writeFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${skipped}\n`, { flag: 'a' });
		}
		return;
	}
	if (failed.length > 0) {
		for (const f of failed) console.log(`::error::${f}`);
		process.exit(1);
	}
	report('live deploy lane: every invocation succeeded');
}

/**
 * Removes a run's worker and every resource named after it, with no baseline to diff against.
 *
 * The backstop for a runner that was cancelled or timed out mid-run, which never reaches the
 * `finally` above. Only names that start with the run's own name are touched.
 */
async function teardownByName(name: string, root: string): Promise<void> {
	if (!name.startsWith('cfw-e2e-')) throw new Error(`refusing to tear down ${name}`);
	spawnSync('bunx', ['wrangler', 'delete', '--name', name, '--force'], {
		cwd: root,
		stdio: 'inherit',
		env: process.env
	});
	const inv = await inventory();
	// the worker delete takes its namespace with it while the listing still shows it, and a throw
	// here would leave the KV namespaces and the database behind
	const gone = (e: unknown) => {
		if (!/: 404 /.test(String(e))) throw e;
	};
	for (const entry of inv.durableObjects) {
		const [id, doName] = entry.split(' ');
		if (doName?.startsWith(name))
			await cf(`/workers/durable_objects/namespaces/${id}`, { method: 'DELETE' }).catch(gone);
	}
	for (const entry of inv.kv) {
		const [id, title] = entry.split(' ');
		if (title?.startsWith(name))
			await cf(`/storage/kv/namespaces/${id}`, { method: 'DELETE' }).catch(gone);
	}
	for (const entry of inv.d1) {
		const [id, dbName] = entry.split(' ');
		if (dbName?.startsWith(name))
			await cf(`/d1/database/${id}`, { method: 'DELETE' }).catch(gone);
	}
	const left = (await inventory()).workers.filter((w) => w === name);
	console.log(
		left.length === 0
			? `teardown: nothing named ${name} remains`
			: `teardown: ${name} still listed`
	);
}

if (import.meta.main) await main();
