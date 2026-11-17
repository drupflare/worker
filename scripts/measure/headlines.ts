/**
 * One command for the three Drupal headlines, so another CMS has something to be compared against.
 *
 * ```sh
 * bun scripts/measure/headlines.ts                       # --local: the registry, nothing measured
 * bun scripts/measure/headlines.ts --deployed --account=student --name=cfw-headlines-a1
 * bun scripts/measure/headlines.ts --deployed --account=student --name=cfw-headlines-a1 --dry
 * ```
 *
 * `--local` measures nothing absolute and says so. An absolute CPU figure comes only from `cpuTime`
 * on a deployed worker, so `--deployed` deploys a throwaway to the student free account, drives one
 * contiguous block of sequential requests per arm, reads per-invocation `cpuTime` from Workers
 * Observability events, and tears the worker down. The literal each figure is compared with is read
 * from `scripts/economics/measured.ts` by import.
 *
 * The Observability read needs no tag on the object's invocation: those carry no request, so an
 * arm is a time window with nothing else driving the site. Each invocation is classed by its event
 * type; only the fetch class is the driven requests, the rest are reported per class beside the arm,
 * and an arm whose window holds a different number of fetches than it drove is `unresolved`. The
 * redacted raw events are written to `--events-out` (default under the temp dir) before teardown.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as measured from '../economics/measured';
import { MIN_SAMPLES, OBSERVABILITY_INGEST_LAG_MS, summarise } from './bench';
import { FREE_QUOTAS, ROWS_PER_FILL } from './free-envelope';
import { flattenEvents, tagFromUrl, type InvocationRow } from './obs-cpu';

// #region registry

/** a name exported by `scripts/economics/measured.ts` that holds a plain value */
export type LiteralName = Exclude<keyof typeof measured, 'renderMsFor'>;

/** an arm: one of the headlines, or `cold-serve`, the same cold path through `/serve`, which has no literal */
export type ArmId = Headline['id'] | 'cold-serve';

/** one headline: what it is, which literals it re-measures, and where the figure came from */
export type Headline = {
	id: 'cold-boot' | 'render-cold-bins' | 'render-warm-bin' | 'cached-serve';
	title: string;
	literals: readonly LiteralName[];
	/** the instrument the literal's provenance names, or what the tree actually holds */
	producer: string;
	/** whether the tree holds an instrument recorded as the producer of the literal */
	producerInTree: 'probable' | 'none';
	/** how the deployed arm drives it */
	arm: string;
};

/** the headlines `measure:headlines` re-measures; every literal in `measured.ts` is here or in {@link NOT_HEADLINES} */
export const HEADLINES: readonly Headline[] = [
	{
		id: 'cold-boot',
		title: 'cold boot (a cold serve: boot plus first render, one invocation)',
		literals: ['COLD_BOOT_MS'],
		producer:
			'probable: coldserve-ladder.ts arm none read through obs-cpu.ts; the raw samples are four numbers in notes/memory-and-isolates.md',
		producerInTree: 'probable',
		arm: 'idle 25 s so the object hibernates, then /fill?path=/?cold=<tag>&max=1 (queues the path and fills it in one invocation, as coldserve-ladder.ts does); a sample counts only when the answer says bootedInFill'
	},
	{
		id: 'render-cold-bins',
		title: 'uncached render, page, dynamic_page_cache and render bins emptied',
		literals: ['RENDER_COLD_BINS_MS', 'RENDER_COLD_BINS_LOCAL_MS'],
		producer:
			'none recorded: gbs-per-operation.ts drives the same /assemble path but prints activeTime ratios, not per-invocation cpuTime, and the 2026-09-23 re-measure did not reproduce the figure',
		producerInTree: 'none',
		arm: 'idle 25 s so the object hibernates and drops the interpreter, then /assemble?path=/&bins=page,dynamic_page_cache,render; a sample counts only when the answer says bootedInFill and the dynamic page cache did not hit'
	},
	{
		id: 'render-warm-bin',
		title: 'invalidated page re-rendered with the render bin warm',
		literals: ['RENDER_WARM_BIN_MS'],
		producer:
			'none in the tree; the provenance (35 renders on novel keys, x-cfw-cache RENDER, x-cfw-php-booted 1, GraphQL namespace filter) names no script',
		producerInTree: 'none',
		arm: '/serve of a novel key per sample; a sample counts only when x-cfw-cache is RENDER and x-cfw-php-booted is 1'
	},
	{
		id: 'cached-serve',
		title: 'cached serve, object and front worker plus object',
		literals: ['CACHED_SERVE_DO_MS', 'CACHED_SERVE_TOTAL_MS'],
		producer:
			'probable for the object figure: bench-run.ts (60 cached serves is its two scenarios of 30) read by namespace; none for the 1.8 total, which predates the object figure by a week and is not 0.42 plus the 1.10 front-worker reading',
		producerInTree: 'probable',
		arm: '/serve?edge=0 of a stored page; object cpuTime by window, front worker cpuTime by tag'
	}
];

/** every other export of `measured.ts`, with the reason it is not one of the three headlines */
export const NOT_HEADLINES: Readonly<Record<string, string>> = {
	STALE_SERVE_MS: 'open-measure.ts --arm=stale',
	SITE_GB: 'a size, derived from a database file',
	WARM_FIRING_WALL_MS: 'billed wall time of a warming firing; no instrument named',
	OBJECT_MEMORY_MIB: 'memory ramp, not a CPU headline',
	BOOTED_FOOTPRINT_MIB: 'memory ramp, not a CPU headline',
	REDRIVE_MS: 'bimodal re-drive path, not a headline',
	PARK_TAX_MS: 'open-measure.ts --arm=tax',
	MJ_RENDER_VPS: 'energy on bare metal, vps-energy.ts',
	MJ_CACHED_VPS: 'energy on bare metal, vps-energy.ts',
	DRUPFLARE_ENERGY_PARITY: 'energy ratio, vps-energy.ts',
	IDLE_W_VPS_ARM: 'idle watts of the VPS arm',
	JVIEW_CPU_MS: 'jview-energy.ts on paisley-park',
	REPEAT_NAV: 'browser energy run',
	REPEAT_NAV_DEPLOYED: 'browser energy run',
	SPOOL_REQUESTS: 'spool request counts',
	SPOOL_DEVICE: 'spool device energy',
	COLD_PATH_MAX_FRAC: 'a policy bound, not a measurement'
};

/** names in `measured.ts` that no registry entry names, and names a registry entry holds that `measured.ts` lacks */
export function registryGaps(exported: readonly string[]): {
	unregistered: string[];
	stale: string[];
} {
	const named = new Set<string>([
		...HEADLINES.flatMap((h) => h.literals),
		...Object.keys(NOT_HEADLINES)
	]);
	const have = new Set(exported);
	return {
		unregistered: exported.filter((n) => !named.has(n)).sort(),
		stale: [...named].filter((n) => !have.has(n)).sort()
	};
}

/** the plain-value exports of `measured.ts`, read at runtime so a new literal cannot be missed */
export function measuredLiteralNames(): string[] {
	return Object.entries(measured)
		.filter(([, v]) => typeof v !== 'function')
		.map(([k]) => k);
}

/** the literal a headline is compared with, read by import */
export function literalValue(name: LiteralName): unknown {
	return measured[name];
}

// #endregion

// #region statistics

/** n, p50, min, max and mean of a sample; null below the floor, as `summarise` refuses */
export type Reading = { n: number; p50: number; min: number; max: number; mean: number };

/** the reading of a sample, or null when n is below the floor */
export function readingOf(values: readonly number[]): Reading | null {
	const s = summarise(values);
	if (!s) return null;
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	return { n: s.n, p50: s.median, min: s.min, max: s.max, mean };
}

/** what one arm drove and what the object's window held; `observed` is the driven requests' invocations */
export type ArmObservation = {
	driven: number;
	valid: number;
	observed: InvocationRow[];
	/** invocations in the window that are not a driven request, by class; absent means none were read */
	others?: ClassedRow[];
	/** driven tags with no invocation, and with more than one */
	missingTags?: string[];
	duplicateTags?: string[];
};

/** the arm's figure, or the reasons it is not one */
export type ArmVerdict =
	| { status: 'ok'; reading: Reading }
	| { status: 'unresolved'; reasons: string[]; raw: Reading | null };

/** ok only when every driven request was valid and each driven tag has exactly one fetch invocation */
export function judgeArm(obs: ArmObservation): ArmVerdict {
	const reasons: string[] = [];
	if (obs.valid !== obs.driven)
		reasons.push(`${obs.driven - obs.valid} of ${obs.driven} samples invalid`);
	if (obs.observed.length !== obs.driven)
		reasons.push(
			`${obs.observed.length} object fetch invocations carry a driven tag against ${obs.driven} driven`
		);
	if ((obs.missingTags ?? []).length > 0)
		reasons.push(`${obs.missingTags?.length} driven tags have no invocation`);
	if ((obs.duplicateTags ?? []).length > 0)
		reasons.push(`${obs.duplicateTags?.length} driven tags have more than one invocation`);
	const bad = obs.observed.filter((r) => r.outcome !== 'ok').length;
	if (bad > 0) reasons.push(`${bad} invocations with an outcome other than ok`);
	const unclassified = (obs.others ?? []).filter((r) => r.cls === 'unclassified').length;
	if (unclassified > 0)
		reasons.push(`${unclassified} invocations whose event type could not be read`);
	const raw = readingOf(obs.observed.map((r) => r.cpuMs));
	if (reasons.length > 0 || !raw) {
		if (!raw) reasons.push(`n below ${MIN_SAMPLES}`);
		return { status: 'unresolved', reasons, raw };
	}
	return { status: 'ok', reading: raw };
}

// #endregion

// #region event classes

/**
 * What an object invocation was: a fetch with a driven tag, any other fetch (a setup or stats
 * read), an alarm firing, any other kind, or unreadable. `fetch` is what the events carry before
 * the tag is checked.
 */
export type InvocationClass = 'fetch' | 'other-fetch' | 'alarm' | 'other' | 'unclassified';

/** one invocation with its class and the event type string it was classed from */
export type ClassedRow = InvocationRow & {
	cls: InvocationClass;
	eventType: string | null;
	/** the event's own timestamp in epoch ms, which is when the invocation ended */
	at: number | null;
};

/** count, p50 and max of one class; a descriptive figure, not a headline */
export type ClassSummary = { n: number; p50: number; max: number };

/** the raw event's type string, `$workers.eventType` in the events view, or null when it carries none */
export function eventTypeOf(e: any): string | null {
	const t = e?.$workers?.eventType;
	return typeof t === 'string' && t !== '' ? t : null;
}

/** maps an event type string to a class; a missing string is `unclassified`, never assumed a fetch */
export function classOfEventType(eventType: string | null): InvocationClass {
	if (eventType === null) return 'unclassified';
	const t = eventType.toLowerCase();
	if (t === 'fetch') return 'fetch';
	if (t === 'alarm') return 'alarm';
	return 'other';
}

/**
 * The tag of a fetch event, read from `$workers.event.request.url` (an object invocation's event
 * carries the request line, measured 2026-11-16: 116 of 116 fetch invocations) and from
 * `$workers.event.search` where it is present.
 */
export function tagOfEvent(e: any): string | null {
	const ev = e?.$workers?.event;
	const fromSearch = ev?.search?.tag;
	if (typeof fromSearch === 'string' && fromSearch !== '') return fromSearch;
	return tagFromUrl(ev?.request?.url, 'tag');
}

/**
 * Every invocation in an events response with its class and tag. An invocation arrives as one
 * event with `outcome` and `cpuTimeMs` and a second log event (`cfw-demand`) with neither; only
 * the first is kept, which is `flattenEvents`'s rule too.
 */
export function classedRows(body: any): ClassedRow[] {
	const events = body?.result?.events?.events ?? [];
	const out: ClassedRow[] = [];
	for (const e of events) {
		const w = e?.$workers;
		if (!w || typeof w.cpuTimeMs !== 'number') continue;
		const eventType = eventTypeOf(e);
		out.push({
			tag: tagOfEvent(e),
			cpuMs: w.cpuTimeMs,
			wallMs: typeof w.wallTimeMs === 'number' ? w.wallTimeMs : 0,
			outcome: String(w.outcome ?? 'unknown'),
			cls: classOfEventType(eventType),
			eventType,
			at: typeof e.timestamp === 'number' ? e.timestamp : null
		});
	}
	return out;
}

/**
 * The fetches that carry one of the driven tags and the rest of the window, never dropping a row.
 * A fetch with another tag or none (a stats read, a setup call) goes to `others` as `other-fetch`.
 */
export function splitDriven(
	rows: readonly ClassedRow[],
	tags: readonly string[]
): {
	driven: ClassedRow[];
	others: ClassedRow[];
	missingTags: string[];
	duplicateTags: string[];
} {
	const mine = new Set(tags);
	const driven = rows.filter((r) => r.cls === 'fetch' && r.tag !== null && mine.has(r.tag));
	const others = rows
		.filter((r) => !(r.cls === 'fetch' && r.tag !== null && mine.has(r.tag)))
		.map((r): ClassedRow => (r.cls === 'fetch' ? { ...r, cls: 'other-fetch' } : r));
	const seen = new Map<string, number>();
	for (const r of driven) seen.set(r.tag as string, (seen.get(r.tag as string) ?? 0) + 1);
	return {
		driven,
		others,
		missingTags: tags.filter((t) => !seen.has(t)),
		duplicateTags: [...seen].filter(([, n]) => n > 1).map(([t]) => t)
	};
}

/** n, p50 and max per class, for the classes that are present */
export function classTable(
	rows: readonly ClassedRow[]
): Partial<Record<InvocationClass, ClassSummary>> {
	const out: Partial<Record<InvocationClass, ClassSummary>> = {};
	for (const cls of ['fetch', 'other-fetch', 'alarm', 'other', 'unclassified'] as const) {
		const v = rows
			.filter((r) => r.cls === cls)
			.map((r) => r.cpuMs)
			.sort((a, b) => a - b);
		if (v.length === 0) continue;
		const mid = v.length >> 1;
		const p50 =
			v.length % 2 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
		out[cls] = { n: v.length, p50, max: v[v.length - 1] as number };
	}
	return out;
}

/** how long after a fetch ended an alarm still counts as the one that fetch queued */
export const CHAIN_MS = 150;

/**
 * Each driven fetch with the first alarm that ended within {@link CHAIN_MS} after it, as the sum of
 * the two cpuTimes. Derived from timestamps, so it is reported beside an arm and never as the arm.
 * A fetch with no such alarm is counted in `unpaired` and left out of `sums`.
 */
export function chainedAlarmSums(
	driven: readonly ClassedRow[],
	alarms: readonly ClassedRow[]
): { sums: number[]; unpaired: number } {
	const free = alarms
		.filter((a) => a.cls === 'alarm' && a.at !== null)
		.sort((a, b) => (a.at as number) - (b.at as number));
	const sums: number[] = [];
	let unpaired = 0;
	for (const d of driven) {
		const i = free.findIndex(
			(a) => d.at !== null && (a.at as number) > d.at && (a.at as number) - d.at <= CHAIN_MS
		);
		if (i < 0) {
			unpaired++;
			continue;
		}
		sums.push(d.cpuMs + (free[i] as ClassedRow).cpuMs);
		free.splice(i, 1);
	}
	return { sums, unpaired };
}

/** one line per class for printing beside an arm */
export function formatClassTable(t: Partial<Record<InvocationClass, ClassSummary>>): string {
	const parts = Object.entries(t).map(
		([cls, s]) => `${cls} n=${s.n} p50 ${s.p50} ms max ${s.max} ms`
	);
	return parts.length > 0 ? parts.join('; ') : 'no invocations';
}

const SENSITIVE_KEY =
	/^(authorization|cookie|set-cookie|cf-connecting-ip|x-real-ip|x-forwarded-for|true-client-ip|cf-ray)$/i;

/** a copy of the events dump with secrets, client addresses, credential-bearing headers and the account subdomain removed */
export function redactDump(value: unknown, secrets: readonly string[]): unknown {
	if (typeof value === 'string') {
		return redact(value, secrets)
			.replace(/\.[a-z0-9-]+\.workers\.dev/gi, '.[subdomain].workers.dev')
			.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]');
	}
	if (Array.isArray(value)) return value.map((v) => redactDump(v, secrets));
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactDump(v, secrets);
		}
		return out;
	}
	return value;
}

// #endregion

// #region account, arguments and the inventory

/** the only account this command deploys to */
export const STUDENT_ID_ENV = 'STUDENT_CLOUDFLARE_ACCOUNT_ID';
/** the token that account's calls use */
export const STUDENT_TOKEN_ENV = 'STUDENT_CLOUDFLARE_API_TOKEN';

/** what the student account holds that is not ours: the gmux worker and its object namespace */
export const KNOWN_BASELINE: Inventory = {
	workers: ['gmux-e17'],
	durableObjects: ['gmux-e17_MachineDO'],
	kv: [],
	d1: []
};

/** the four lists a teardown has to return to baseline */
export type Inventory = { workers: string[]; durableObjects: string[]; kv: string[]; d1: string[] };

/** the parsed command line */
export type Options = {
	mode: 'local' | 'deployed';
	name: string;
	dry: boolean;
	account: string | undefined;
	/** where the redacted raw Observability events are written before teardown */
	eventsOut: string | undefined;
};

const NAME_RE = /^cfw-headlines-[a-z0-9][a-z0-9-]{0,30}$/;

/** parses `--local`, `--deployed`, `--account=`, `--name=` and `--dry`, refusing anything else */
export function parseOptions(argv: readonly string[]): Options {
	const opts: Options = {
		mode: 'local',
		name: '',
		dry: false,
		account: undefined,
		eventsOut: undefined
	};
	let local = false;
	for (const a of argv) {
		if (a === '--local') local = true;
		else if (a === '--deployed') opts.mode = 'deployed';
		else if (a === '--dry') opts.dry = true;
		else if (a.startsWith('--account=')) opts.account = a.slice('--account='.length);
		else if (a.startsWith('--name=')) opts.name = a.slice('--name='.length);
		else if (a.startsWith('--events-out=')) opts.eventsOut = a.slice('--events-out='.length);
		else throw new Error(`unknown argument ${a.startsWith('--account') ? '--account...' : a}`);
	}
	if (local && opts.mode === 'deployed') throw new Error('--local and --deployed are exclusive');
	if (
		opts.mode === 'local' &&
		(opts.account !== undefined || opts.name !== '' || opts.eventsOut !== undefined)
	) {
		throw new Error('--account, --name and --events-out belong to --deployed');
	}
	if (opts.eventsOut === '') throw new Error('--events-out needs a path');
	if (opts.mode === 'deployed') {
		if (opts.account !== 'student') {
			throw new Error('--deployed needs --account=student; no other account is accepted');
		}
		if (!NAME_RE.test(opts.name)) {
			throw new Error(
				'--deployed needs --name=cfw-headlines-<suffix> (lowercase letters, digits, hyphens)'
			);
		}
	}
	return opts;
}

/** the student id and token from the environment, refusing a missing value or an id that is another account's */
export function studentCredentials(env: Record<string, string | undefined>): {
	id: string;
	token: string;
} {
	const id = env[STUDENT_ID_ENV];
	const token = env[STUDENT_TOKEN_ENV];
	if (!id) throw new Error(`${STUDENT_ID_ENV} is not set`);
	if (!token) throw new Error(`${STUDENT_TOKEN_ENV} is not set`);
	for (const other of ['FREE_CLOUDFLARE_ACCOUNT_ID', 'PAID_CLOUDFLARE_ACCOUNT_ID']) {
		if (env[other] !== undefined && env[other] === id) {
			throw new Error(`${STUDENT_ID_ENV} equals ${other}; refusing a non-student account`);
		}
	}
	return { id, token };
}

/** the child process environment: every Cloudflare credential dropped, then the student pair set */
export function childEnv(
	env: Record<string, string | undefined>,
	creds: { id: string; token: string }
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined || /CLOUDFLARE/i.test(k)) continue;
		out[k] = v;
	}
	out.CLOUDFLARE_ACCOUNT_ID = creds.id;
	out.CLOUDFLARE_API_TOKEN = creds.token;
	out.WRANGLER_SEND_METRICS = 'false';
	return out;
}

/** removes every secret from text before it is printed */
export function redact(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const s of secrets) if (s.length > 0) out = out.split(s).join('[redacted]');
	return out;
}

/** the sorted names in one list response; throws when the page is not the whole list */
export function namesFrom(body: any, key: 'id' | 'name' | 'title'): string[] {
	if (body?.success === false) throw new Error('inventory call failed');
	const rows: any[] = body?.result ?? [];
	const total = body?.result_info?.total_count;
	if (typeof total === 'number' && total > rows.length) {
		throw new Error(`inventory incomplete: ${rows.length} of ${total} rows`);
	}
	return rows.map((r) => String(r?.[key] ?? '')).sort();
}

/** what a list holds beyond the known baseline, as problems; empty means the account is clean to run on */
export function baselineProblems(inv: Inventory): string[] {
	const problems: string[] = [];
	for (const k of ['workers', 'durableObjects', 'kv', 'd1'] as const) {
		const extra = inv[k].filter((n) => !KNOWN_BASELINE[k].includes(n));
		if (extra.length > 0) problems.push(`${k}: ${extra.join(', ')}`);
	}
	return problems;
}

/** what moved between two inventories; both lists empty on every key is a clean teardown */
export function inventoryDiff(
	before: Inventory,
	after: Inventory
): Record<keyof Inventory, { added: string[]; removed: string[] }> {
	const one = (a: string[], b: string[]) => ({
		added: b.filter((n) => !a.includes(n)),
		removed: a.filter((n) => !b.includes(n))
	});
	return {
		workers: one(before.workers, after.workers),
		durableObjects: one(before.durableObjects, after.durableObjects),
		kv: one(before.kv, after.kv),
		d1: one(before.d1, after.d1)
	};
}

/** true when the diff has no entry on any list */
export function diffIsEmpty(diff: ReturnType<typeof inventoryDiff>): boolean {
	return Object.values(diff).every((d) => d.added.length === 0 && d.removed.length === 0);
}

const API = 'https://api.cloudflare.com/client/v4';

/** reads the four lists the teardown is checked against */
export async function readInventory(
	creds: { id: string; token: string },
	doFetch: typeof fetch = fetch
): Promise<Inventory> {
	const get = async (path: string) => {
		const res = await doFetch(`${API}/accounts/${creds.id}${path}?per_page=100`, {
			headers: { authorization: `Bearer ${creds.token}` }
		});
		return res.json();
	};
	return {
		workers: namesFrom(await get('/workers/scripts'), 'id'),
		durableObjects: namesFrom(await get('/workers/durable_objects/namespaces'), 'name'),
		kv: namesFrom(await get('/storage/kv/namespaces'), 'title'),
		d1: namesFrom(await get('/d1/database'), 'name')
	};
}

// #endregion

// #region config and price

/** the shipping config with the bindings the free account lacks stripped, paths absolute */
export function throwawayConfig(name: string, root: string): Record<string, unknown> {
	return {
		name,
		main: join(root, 'src/site.ts'),
		minify: true,
		compatibility_date: '2026-08-01',
		compatibility_flags: ['nodejs_compat'],
		vars: {
			CMS: 'drupal',
			LAZY_MOUNT: '1',
			LAZY_FS_BUDGET_BYTES: '4194304',
			GEN_BUCKET_MS: '5000',
			PLAN: 'free',
			ASSET_AGGREGATES: '1',
			SITE_ID_PORTS: 'strip',
			PW_DIAGNOSTICS: '1',
			SITE_WARM: '0',
			RETAIN_INTERPRETER: '0'
		},
		rules: [
			{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: true },
			{ type: 'Data', globs: ['**/*.zst', '**/*.br'], fallthrough: true },
			{ type: 'Text', globs: ['**/composer.lock'], fallthrough: true }
		],
		durable_objects: {
			bindings: [
				{ name: 'SITE', class_name: 'SitePhpDurableObject' },
				{ name: 'RENDER_LANES', class_name: 'RenderLane' }
			]
		},
		migrations: [
			{ tag: 'v1', new_sqlite_classes: ['SitePhpDurableObject'] },
			{ tag: 'v2', new_sqlite_classes: ['RenderLane'] }
		],
		assets: { directory: join(root, 'assets'), binding: 'ASSETS' },
		observability: { enabled: true },
		alias: { './runtime/php-binary.js': join(root, 'src/runtime/php-binary-raw.ts') }
	};
}

/** requests per arm; the literals' own n is 60, 35, 10 and 4 */
export const ARM_N = {
	cachedServe: 60,
	renderWarmBin: 35,
	renderColdBins: 10,
	coldBoot: 8,
	coldServe: 8
} as const;

/** setup writes a migration of this many rows (gbs-per-operation.ts) */
export const MIGRATE_ROWS = 3952;

/** an upper bound on what one deployed run spends, against the free plan's daily meters */
export function priceRun(): {
	workerRequests: number;
	objectRequests: number;
	rowsWritten: number;
	rowsFractionOfDay: number;
	requestsFractionOfDay: number;
} {
	const driven = Object.values(ARM_N).reduce((a, b) => a + b, 0);
	// setup: up to 20 migrate polls, up to 60 readiness polls, one stats read
	const setup = 20 + 60 + 1;
	const requests = driven + setup;
	const renders =
		ARM_N.renderWarmBin + ARM_N.renderColdBins + ARM_N.coldBoot + ARM_N.coldServe + 1;
	const rows = MIGRATE_ROWS + renders * ROWS_PER_FILL.firstFillOnFreshObject;
	return {
		workerRequests: requests,
		objectRequests: requests,
		rowsWritten: rows,
		rowsFractionOfDay: rows / FREE_QUOTAS.rowsWrittenPerDay,
		requestsFractionOfDay: requests / FREE_QUOTAS.workerRequestsPerDay
	};
}

// #endregion

// #region the deployed run

/** what the deployed run needs from outside, so the teardown ordering is testable without a network */
export type Deps = {
	fetch: typeof fetch;
	run: (
		cmd: string,
		args: string[],
		env: Record<string, string>
	) => Promise<{ code: number; out: string }>;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
	measure: (ctx: RunContext) => Promise<void>;
};

/** what a measuring step receives */
export type RunContext = {
	name: string;
	base: string;
	creds: { id: string; token: string };
	deps: Deps;
	eventsOut?: string;
};

/** deploys, measures, and always tears down and diffs the inventory; returns the exit code */
export async function runDeployed(
	opts: Options,
	env: Record<string, string | undefined>,
	deps: Deps,
	root: string
): Promise<number> {
	const creds = studentCredentials(env);
	const secrets = [creds.id, creds.token];
	const cenv = childEnv(env, creds);
	const log = (s: string) => deps.log(redact(s, secrets));

	const before = await readInventory(creds, deps.fetch);
	const problems = baselineProblems(before);
	if (problems.length > 0) {
		log(`refusing: the account holds more than the known gmux pair: ${problems.join('; ')}`);
		return 2;
	}

	const dir = join(tmpdir(), `headlines-${opts.name}`);
	mkdirSync(dir, { recursive: true });
	const config = join(dir, 'wrangler.jsonc');
	writeFileSync(config, JSON.stringify(throwawayConfig(opts.name, root), null, '\t'));

	let code = 0;
	let deployed = false;
	try {
		deployed = true;
		const dep = await deps.run('bunx', ['wrangler', 'deploy', '-c', config], cenv);
		log(dep.out);
		if (dep.code !== 0) throw new Error(`wrangler deploy exited ${dep.code}`);
		const url = new RegExp(`https://${opts.name}\\.[a-z0-9-]+\\.workers\\.dev`).exec(
			dep.out
		)?.[0];
		if (!url) throw new Error('no workers.dev url in the deploy output');
		log('waiting 60 s for the object namespace to propagate');
		await deps.sleep(60_000);
		await deps.measure({
			name: opts.name,
			base: url,
			creds,
			deps,
			eventsOut: opts.eventsOut ?? join(dir, 'events.json')
		});
	} catch (e) {
		log(`run failed: ${(e as Error).message}`);
		code = 1;
	} finally {
		if (deployed) {
			const del = await deps.run(
				'bunx',
				['wrangler', 'delete', '--name', opts.name, '--force'],
				cenv
			);
			log(del.out);
			if (del.code !== 0) {
				log(`teardown exited ${del.code}; delete ${opts.name} by hand`);
				code = 1;
			}
		}
		const after = await readInventory(creds, deps.fetch);
		const diff = inventoryDiff(before, after);
		log(
			`inventory diff against the pre-run list: ${diffIsEmpty(diff) ? 'none' : JSON.stringify(diff)}`
		);
		if (!diffIsEmpty(diff)) code = 1;
	}
	return code;
}

/** a GET with a timeout, returning status, headers and text */
async function get(
	doFetch: typeof fetch,
	url: string,
	timeoutMs = 240_000
): Promise<{ status: number; headers: Headers; text: string }> {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await doFetch(url, { signal: ctl.signal });
		return { status: res.status, headers: res.headers, text: await res.text() };
	} finally {
		clearTimeout(t);
	}
}

/** events one query returns at most; a response this long may be truncated */
export const EVENTS_LIMIT = 1000;

/** one Observability events query over a window, the shape `obs-cpu.ts` sends, as the raw response body */
export async function queryEventsRaw(
	ctx: RunContext,
	model: 'durableObject' | 'stateless',
	from: number,
	to: number
): Promise<any> {
	const res = await ctx.deps.fetch(
		`${API}/accounts/${ctx.creds.id}/workers/observability/telemetry/query`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${ctx.creds.token}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				queryId: 'headlines',
				view: 'events',
				dry: false,
				limit: 1000,
				parameters: {
					datasets: ['cloudflare-workers'],
					filterCombination: 'and',
					filters: [
						{
							key: '$metadata.service',
							operation: 'eq',
							type: 'string',
							value: ctx.name
						},
						{
							key: '$workers.executionModel',
							operation: 'eq',
							type: 'string',
							value: model
						}
					],
					limit: 1000
				},
				timeframe: { from, to }
			})
		}
	);
	const body: any = await res.json();
	if (body?.success === false) throw new Error('observability query failed');
	return body;
}

/** the invocations in one window, tags read where the event carries a request */
export async function queryEvents(
	ctx: RunContext,
	model: 'durableObject' | 'stateless',
	from: number,
	to: number
): Promise<InvocationRow[]> {
	return flattenEvents(await queryEventsRaw(ctx, model, from, to), 'tag');
}

type Reply = { status: number; headers: Headers; text: string };

/** what one driven request answered, kept in the events dump so an arm can be audited later */
export type Sample = {
	arm: ArmId;
	tag: string;
	at: number;
	status: number;
	valid: boolean;
	headers: Record<string, string>;
	assemble: ReturnType<typeof assembleFacts>;
};

const SAMPLE_HEADERS = [
	'x-cfw-cache',
	'x-cfw-php-booted',
	'x-cfw-inline-boot',
	'x-cfw-inline-boot-predicted',
	'x-cfw-serve-ms',
	'x-worker-ms'
] as const;

/** one reply as a sample record: the status, the validity verdict and the headers the arms read */
export function sampleOf(arm: ArmId, tag: string, at: number, r: Reply, valid: boolean): Sample {
	const headers: Record<string, string> = {};
	for (const h of SAMPLE_HEADERS) {
		const v = r.headers.get(h);
		if (v !== null) headers[h] = v;
	}
	return { arm, tag, at, status: r.status, valid, headers, assemble: assembleFacts(r.text) };
}

type Arm = {
	headline: ArmId;
	tag: string;
	n: number;
	url: (site: string, i: number, tag: string) => string;
	valid: (r: Reply) => boolean;
	/** idle before each sample so the object hibernates */
	idleMs?: number;
};

/** the fields of an `/assemble` answer that say what the render paid for; null when the body is not JSON */
export function assembleFacts(text: string): {
	bootedInFill: boolean | null;
	dynamicCache: string | null;
	pageCache: string | null;
	rowsWritten: number | null;
	wallMs: number | null;
} | null {
	let body: any;
	try {
		body = JSON.parse(text);
	} catch {
		return null;
	}
	const str = (v: unknown) => (typeof v === 'string' ? v : null);
	const num = (v: unknown) => (typeof v === 'number' ? v : null);
	return {
		bootedInFill: typeof body?.bootedInFill === 'boolean' ? body.bootedInFill : null,
		dynamicCache: str(body?.dynamicCache),
		pageCache: str(body?.pageCache),
		rowsWritten: num(body?.rowsWritten),
		wallMs: num(body?.wallMs)
	};
}

/** a cold-boot sample counts only when `/fill` booted the interpreter and filled the path it was given */
export function filledCold(r: Reply): boolean {
	let body: any;
	try {
		body = JSON.parse(r.text);
	} catch {
		return false;
	}
	return (
		r.status === 200 &&
		body?.bootedInFill === true &&
		typeof body?.filled === 'string' &&
		body.filled.startsWith('/?cold=')
	);
}

/** a cold-bins sample counts only when the fill booted the interpreter and the dynamic page cache did not answer */
export function assembledCold(r: Reply): boolean {
	const f = assembleFacts(r.text);
	return r.status === 200 && f?.bootedInFill === true && f.dynamicCache !== 'HIT';
}

const SITE = 'hl';

const ARMS: readonly Arm[] = [
	{
		headline: 'cached-serve',
		tag: 'cs',
		n: ARM_N.cachedServe,
		url: (s, _i, t) => `/serve?site=${s}&path=/&edge=0&tag=${t}`,
		valid: (r) => r.status === 200 && r.headers.get('x-cfw-cache') === 'HIT'
	},
	{
		headline: 'render-warm-bin',
		tag: 'rw',
		n: ARM_N.renderWarmBin,
		url: (s, _i, t) => `/serve?site=${s}&path=/user/login%3Fhl%3D${t}&edge=0&tag=${t}`,
		valid: (r) =>
			r.status === 200 &&
			r.headers.get('x-cfw-cache') === 'RENDER' &&
			r.headers.get('x-cfw-php-booted') === '1'
	},
	{
		headline: 'render-cold-bins',
		tag: 'rc',
		n: ARM_N.renderColdBins,
		url: (s, _i, t) =>
			`/assemble?site=${s}&path=/&bins=page,dynamic_page_cache,render&tag=${t}`,
		valid: assembledCold,
		idleMs: 25_000
	},
	{
		headline: 'cold-boot',
		tag: 'cb',
		n: ARM_N.coldBoot,
		url: (s, _i, t) =>
			`/fill?site=${s}&path=${encodeURIComponent(`/?cold=${t}`)}&max=1&tag=${t}`,
		valid: filledCold,
		idleMs: 25_000
	},
	{
		headline: 'cold-serve',
		tag: 'cv',
		n: ARM_N.coldServe,
		url: (s, _i, t) =>
			`/serve?site=${s}&path=${encodeURIComponent(`/?cold=${t}`)}&edge=0&tag=${t}`,
		valid: (r) => r.status === 200 && r.headers.get('x-cfw-inline-boot') === '1',
		idleMs: 25_000
	}
];

const GAP_MS = 20_000;

/** provisions one site, drives each arm in its own window, waits for ingest, and prints the table */
export async function measureArms(ctx: RunContext): Promise<void> {
	const { deps, base } = ctx;
	const f = deps.fetch;
	const q = (p: string) => `${base}${p}`;
	for (let i = 0; i < 20; i++) {
		// no `all=1`: on free it replays every chunk in one invocation and spends more than 50 subrequests
		const r = await get(f, q(`/migrate?site=${SITE}&prefill=1`));
		if (r.text.includes('"done":true')) break;
		if (r.text.includes('"done":null'))
			throw new Error(`migrate failed (status ${r.status}): ${r.text.slice(0, 400)}`);
		await deps.sleep(500);
	}
	let ready = false;
	for (let i = 0; i < 60 && !ready; i++) {
		ready = (await get(f, q(`/serve?site=${SITE}&path=/&edge=0`))).status === 200;
		if (!ready) await deps.sleep(2000);
	}
	if (!ready) throw new Error('the site never served a 200; measuring it would measure warming');

	const runFrom = Date.now() - 2000;
	const windows: {
		arm: Arm;
		from: number;
		to: number;
		driven: number;
		valid: number;
		tags: string[];
		sent: string[];
	}[] = [];
	const samples: Sample[] = [];
	for (const arm of ARMS) {
		await deps.sleep(GAP_MS);
		const from = Date.now() - 2000;
		let valid = 0;
		const tags: string[] = [];
		const sent: string[] = [];
		for (let i = 0; i < arm.n; i++) {
			if (arm.idleMs) await deps.sleep(arm.idleMs);
			const tag = `${ctx.name}-${arm.tag}-${i}`;
			sent.push(tag);
			const at = Date.now();
			const r = await get(f, q(arm.url(SITE, i, tag)));
			const ok = arm.valid(r);
			samples.push(sampleOf(arm.headline, tag, at, r, ok));
			if (ok) {
				valid++;
				tags.push(tag);
			}
		}
		windows.push({ arm, from, to: Date.now() + 2000, driven: arm.n, valid, tags, sent });
		deps.log(`drove ${arm.headline}: ${arm.n} requests, ${valid} valid`);
	}
	const runTo = Date.now() + 2000;
	const stats = await get(f, q(`/serve-stats?site=${SITE}`));
	const rowsToday = /"rowsToday":\s*(\d+)/.exec(stats.text)?.[1];

	deps.log(`waiting ${OBSERVABILITY_INGEST_LAG_MS / 60_000} min for Observability ingest`);
	await deps.sleep(OBSERVABILITY_INGEST_LAG_MS);

	const verdicts = new Map<ArmId, ArmVerdict>();
	const tables = new Map<ArmId, ClassedRow[]>();
	const chains = new Map<ArmId, ReturnType<typeof chainedAlarmSums>>();
	const dump: Record<string, unknown> = {
		worker: ctx.name,
		windows: windows.map((w) => ({
			arm: w.arm.headline,
			from: w.from,
			to: w.to,
			driven: w.driven,
			valid: w.valid
		})),
		samples,
		armEvents: {} as Record<string, unknown>
	};
	let front: number[] = [];
	for (const w of windows) {
		let body: any;
		let rows: ClassedRow[] = [];
		let previous = -1;
		for (let attempt = 0; attempt < 6; attempt++) {
			body = await queryEventsRaw(ctx, 'durableObject', w.from, w.to);
			rows = classedRows(body);
			// a stable total, not just enough fetches, so alarm firings still arriving are not undercounted
			if (splitDriven(rows, w.sent).driven.length >= w.driven && rows.length === previous)
				break;
			previous = rows.length;
			await deps.sleep(60_000);
		}
		(dump.armEvents as Record<string, unknown>)[w.arm.headline] = body;
		if (rows.length >= EVENTS_LIMIT)
			deps.log(`${w.arm.headline}: events response may be truncated`);
		const { driven, others, missingTags, duplicateTags } = splitDriven(rows, w.sent);
		tables.set(w.arm.headline, [...driven, ...others]);
		chains.set(w.arm.headline, chainedAlarmSums(driven, others));
		verdicts.set(
			w.arm.headline,
			judgeArm({
				driven: w.driven,
				valid: w.valid,
				observed: driven,
				others,
				missingTags,
				duplicateTags
			})
		);
		if (w.arm.headline === 'cached-serve') {
			const stateless = await queryEvents(ctx, 'stateless', w.from, w.to);
			const mine = new Set(w.tags);
			front = stateless.filter((r) => r.tag !== null && mine.has(r.tag)).map((r) => r.cpuMs);
		}
	}
	const whole = {
		durableObject: await queryEventsRaw(ctx, 'durableObject', runFrom, runTo),
		stateless: await queryEventsRaw(ctx, 'stateless', runFrom, runTo)
	};
	dump.run = { from: runFrom, to: runTo, ...whole };
	const inArms = [...tables.values()].reduce((a, rows) => a + rows.length, 0);
	if (ctx.eventsOut) {
		const text = JSON.stringify(redactDump(dump, [ctx.creds.id, ctx.creds.token]));
		mkdirSync(dirname(resolve(ctx.eventsOut)), { recursive: true });
		writeFileSync(ctx.eventsOut, text);
		deps.log(`raw events written (redacted) to ${resolve(ctx.eventsOut)}`);
	}

	deps.log('');
	deps.log(
		'account student (free plan), cpuTime from Workers Observability events, object fetch invocations by driven tag'
	);
	const report = (id: ArmId) => {
		const rows = tables.get(id);
		if (rows) {
			deps.log(
				`  invocations in the window by class (fetch is the driven requests): ${formatClassTable(classTable(rows))}`
			);
		}
		const chain = formatChain(chains.get(id));
		if (chain) deps.log(chain);
	};
	for (const h of HEADLINES) {
		const v = verdicts.get(h.id);
		const literals = h.literals
			.map((l) => `${l} = ${JSON.stringify(literalValue(l))}`)
			.join(', ');
		deps.log(`${h.id}: ${v ? formatVerdict(v) : 'not run'}`);
		deps.log(`  compared with ${literals}`);
		deps.log(`  instrument: headlines.ts ${h.arm}`);
		report(h.id);
	}
	const serveArm = verdicts.get('cold-serve');
	deps.log(
		`cold-serve (no literal; the cold path through /serve): ${serveArm ? formatVerdict(serveArm) : 'not run'}`
	);
	report('cold-serve');
	const wholeObject = classedRows(whole.durableObject);
	deps.log(
		`whole run, object invocations by class: ${formatClassTable(classTable(wholeObject))}; ` +
			`${wholeObject.length - inArms} outside the four arm windows (setup and gaps)`
	);
	const objectCached = verdicts.get('cached-serve');
	const frontReading = readingOf(front);
	if (objectCached?.status === 'ok' && frontReading) {
		deps.log(
			`cached-serve total: ${(objectCached.reading.p50 + frontReading.p50).toFixed(2)} ms, ` +
				`derived: sum of the two p50s (front worker n=${frontReading.n} ${fmt(frontReading)})`
		);
	} else deps.log('cached-serve total: unresolved (front worker or object reading missing)');
	if (rowsToday)
		deps.log(`rows written today on the site: ${rowsToday} (/serve-stats rowsToday)`);
}

/** the derived line for a driven fetch plus the alarm it queued, or undefined when none paired */
export function formatChain(
	c: { sums: number[]; unpaired: number } | undefined
): string | undefined {
	if (!c) return undefined;
	const r = readingOf(c.sums);
	const head = '  derived, driven fetch plus the alarm that ended within 150 ms after it';
	if (!r)
		return `${head}: ${c.sums.length} paired, ${c.unpaired} unpaired (n below ${MIN_SAMPLES})`;
	return `${head}: n=${r.n} ${fmt(r)}, ${c.unpaired} unpaired`;
}

const fmt = (r: Reading): string =>
	`p50 ${r.p50} ms, min ${r.min}, max ${r.max}, mean ${r.mean.toFixed(2)}`;

/** one verdict as a line; a 1 ms reading is the meter's floor */
export function formatVerdict(v: ArmVerdict): string {
	if (v.status === 'unresolved') {
		return `unresolved (${v.reasons.join('; ')})${v.raw ? ` raw n=${v.raw.n} ${fmt(v.raw)}` : ''}`;
	}
	const floor =
		v.reading.p50 <= 1 ? ' (cpuTime is 1 ms granular: a 1 ms reading is the floor)' : '';
	return `n=${v.reading.n} ${fmt(v.reading)} cpuTime${floor}`;
}

// #endregion

// #region local mode

/** the local listing: the registry, the literals, the price of a deployed run; nothing is measured */
export function localReport(): string[] {
	const lines = [
		'measure:headlines --local: nothing is measured here, and no local figure is a headline.',
		'An absolute CPU figure comes only from cpuTime on a deployed worker (--deployed).',
		''
	];
	for (const h of HEADLINES) {
		lines.push(`${h.id}: ${h.title}`);
		for (const l of h.literals) {
			const note =
				l === 'RENDER_COLD_BINS_LOCAL_MS'
					? '  (local wall clock, not an absolute CPU figure)'
					: '';
			lines.push(`  ${l} = ${JSON.stringify(literalValue(l))}${note}`);
		}
		lines.push(`  producer in the tree: ${h.producer}`);
		lines.push(`  deployed arm: ${h.arm}`);
	}
	const p = priceRun();
	lines.push(
		'',
		`deployed run, upper bound: ${p.workerRequests} Worker requests (${(p.requestsFractionOfDay * 100).toFixed(2)}% of ${FREE_QUOTAS.workerRequestsPerDay}/day), ` +
			`${p.rowsWritten} rows written (${(p.rowsFractionOfDay * 100).toFixed(1)}% of ${FREE_QUOTAS.rowsWrittenPerDay}/day)`
	);
	return lines;
}

// #endregion

if (import.meta.main) {
	const opts = parseOptions(process.argv.slice(2));
	if (opts.mode === 'local') {
		for (const l of localReport()) console.log(l);
	} else if (opts.dry) {
		const root = resolve(import.meta.dirname, '../..');
		console.log(JSON.stringify(throwawayConfig(opts.name, root), null, '\t'));
		console.log(JSON.stringify(priceRun()));
	} else {
		const root = resolve(import.meta.dirname, '../..');
		const deps: Deps = {
			fetch,
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			log: (s) => console.log(s),
			measure: measureArms,
			run: (cmd, args, env) =>
				new Promise((res) => {
					const child = spawn(cmd, args, { cwd: root, env });
					let out = '';
					child.stdout.on('data', (d) => (out += d));
					child.stderr.on('data', (d) => (out += d));
					child.on('close', (code) => res({ code: code ?? 1, out }));
				})
		};
		process.exit(await runDeployed(opts, process.env, deps, root));
	}
}
