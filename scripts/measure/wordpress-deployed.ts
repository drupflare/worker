/**
 * Drives a WordPress build through one fixed set of routes, on a local `wrangler dev` or on a
 * throwaway deployed to the student free account, and prints one table.
 *
 * ```sh
 * bun scripts/measure/wordpress-deployed.ts --dry                  # the plan; touches nothing
 * bun scripts/measure/wordpress-deployed.ts --local                # every step on wrangler dev
 * bun scripts/measure/wordpress-deployed.ts --deployed --account=student --name=cfw-wp-0a1b2c3d
 * ```
 *
 * `--dry` and `--local` never call Cloudflare. `--deployed` reuses `runDeployed()` from
 * `headlines.ts` for the inventory, deploy, settle and teardown, and reads per-invocation `cpuTime`,
 * wall time and outcome from Workers Observability events, which survive a teardown.
 *
 * A request carries `cfwrig=<tag>` in its query: WordPress ignores it, and the front worker's event
 * carries the URL, so the tag joins a request to its invocation. The object's invocations carry no
 * tag of their own; each is attached to the front event whose time span contains it. A request with
 * no tag (the cached serve) joins by the step's time window and only when the counts agree.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
	copyFileSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { OBSERVABILITY_INGEST_LAG_MS } from './bench';
import { ASSET_PUBLISH } from './free-envelope';
import {
	EVENTS_LIMIT,
	KNOWN_BASELINE,
	STUDENT_ID_ENV,
	STUDENT_TOKEN_ENV,
	classOfEventType,
	classTable,
	eventTypeOf,
	formatClassTable,
	queryEventsRaw,
	readingOf,
	redact,
	redactDump,
	runDeployed,
	type ClassedRow,
	type Deps,
	type Inventory,
	type Reading,
	type RunContext
} from './headlines';

// #region plan

/** the throwaway's name: a `cfw-wp-` prefix and eight hex digits */
export const NAME_RE = /^cfw-wp(?:shim)?-[0-9a-f]{8}$/;

/** requests the whole run may send; the spec's ceiling */
export const REQUEST_CEILING = 600;

/** readiness polls before the claim, an upper bound on what the migration chain needs */
export const READY_POLLS_MAX = 40;

/** the `/serve-stats` reads that bracket the measured steps */
export const STATS_READS = 2;

/** the query name that carries a request's tag; `tag` is a WordPress query variable and cannot be it */
export const TAG_PARAM = 'cfwrig';

/** the env var the page cache reads; the throwaway leaves it unset and runs the shipped default */
export const PAGE_CACHE_VAR = 'WORDPRESS_PAGE_CACHE';

/** how a step is authenticated */
export type Auth = 'none' | 'cookie' | 'cookie-nonce' | 'owner';

/** one measured step: a request repeated `n` times */
export type PlanStep = {
	id: string;
	label: string;
	method: 'GET' | 'POST';
	path: string;
	n: number;
	/** tagged requests join to their invocation by tag; an untagged step joins by its window */
	tagged: boolean;
	auth: Auth;
	/** the `x-cfw-phase` value an owner request carries */
	phase?: 'boot-only' | 'load' | 'render' | 'probe';
	/** read the rows-written counter around the step, pausing each side so no other request joins its window */
	meter?: boolean;
};

/** the measured steps, in the order they run after the claim */
export const REQUEST_PLAN: readonly PlanStep[] = [
	{
		id: 'cold',
		label: 'front page, first render after the claim',
		method: 'GET',
		path: '/',
		n: 1,
		tagged: true,
		auth: 'none'
	},
	{
		id: 'warm',
		label: 'front page, 10 more',
		method: 'GET',
		path: '/',
		n: 10,
		tagged: true,
		auth: 'none'
	},
	{
		id: 'post',
		label: '/?p=1 (a redirect to the permalink)',
		method: 'GET',
		path: '/?p=1',
		n: 5,
		tagged: true,
		auth: 'none'
	},
	{
		id: 'login-page',
		label: '/wp-login.php',
		method: 'GET',
		path: '/wp-login.php',
		n: 5,
		tagged: true,
		auth: 'none'
	},
	{
		id: 'feed',
		label: '/feed/',
		method: 'GET',
		path: '/feed/',
		n: 5,
		tagged: true,
		auth: 'none'
	},
	{
		id: 'rest-index',
		label: '/wp-json/',
		method: 'GET',
		path: '/wp-json/',
		n: 5,
		tagged: true,
		auth: 'none'
	},
	{
		id: 'login',
		label: 'POST /wp-login.php (the administrator)',
		method: 'POST',
		path: '/wp-login.php',
		n: 1,
		tagged: true,
		auth: 'none'
	},
	{
		id: 'admin',
		label: '/wp-admin/',
		method: 'GET',
		path: '/wp-admin/',
		n: 5,
		tagged: true,
		auth: 'cookie'
	},
	{
		id: 'options',
		label: '/wp-admin/options-general.php',
		method: 'GET',
		path: '/wp-admin/options-general.php',
		n: 5,
		tagged: true,
		auth: 'cookie'
	},
	{
		id: 'rest-nonce',
		label: 'admin-ajax rest-nonce',
		method: 'GET',
		path: '/wp-admin/admin-ajax.php?action=rest-nonce',
		n: 1,
		tagged: true,
		auth: 'cookie'
	},
	{
		id: 'users-me',
		label: '/wp-json/wp/v2/users/me (cookie and nonce)',
		method: 'GET',
		path: '/wp-json/wp/v2/users/me',
		n: 5,
		tagged: true,
		auth: 'cookie-nonce'
	},
	{
		id: 'draft',
		label: 'POST a draft post through REST',
		method: 'POST',
		path: '/wp-json/wp/v2/posts',
		n: 5,
		tagged: true,
		auth: 'cookie-nonce'
	},
	{
		id: 'cron',
		label: '/wp-cron.php',
		method: 'GET',
		path: '/wp-cron.php',
		n: 1,
		tagged: true,
		auth: 'none'
	},
	{
		id: 'cached',
		label: 'anonymous front page, store fill then hits',
		method: 'GET',
		path: '/',
		n: 11,
		tagged: false,
		auth: 'none'
	},
	{
		id: 'save',
		label: 'POST a post update through REST (the purge)',
		method: 'POST',
		path: '/wp-json/wp/v2/posts/1',
		n: 1,
		tagged: true,
		auth: 'cookie-nonce'
	},
	{
		id: 'after-save',
		label: 'anonymous front page after the save: refill, then hits',
		method: 'GET',
		path: '/',
		n: 3,
		tagged: false,
		auth: 'none'
	},
	{
		id: 'phase-boot-only',
		label: 'fresh interpreter, tree mounted, WordPress not loaded',
		method: 'GET',
		path: '/',
		n: 5,
		tagged: true,
		auth: 'owner',
		phase: 'boot-only'
	},
	{
		id: 'phase-load',
		label: 'fresh interpreter through wp-load.php',
		method: 'GET',
		path: '/',
		n: 5,
		tagged: true,
		auth: 'owner',
		phase: 'load'
	},
	{
		id: 'phase-render',
		label: 'fresh interpreter, whole request',
		method: 'GET',
		path: '/',
		n: 5,
		tagged: true,
		auth: 'owner',
		phase: 'render'
	},
	{
		id: 'probe',
		label: 'outbound HTTP and gd, inside the object',
		method: 'GET',
		path: '/',
		n: 1,
		tagged: true,
		auth: 'owner',
		phase: 'probe'
	}
];

const ROUTES = [
	{ id: 'home', label: 'front page', path: '/' },
	{ id: 'post', label: 'a post', path: '/2026/01/01/hello-world/' },
	{ id: 'page', label: 'a page', path: '/sample-page/' },
	{ id: 'category', label: 'a category archive', path: '/category/uncategorized/' },
	{ id: 'feed', label: 'the feed', path: '/feed/' }
] as const;

const anonymous = (
	id: string,
	label: string,
	path: string,
	n: number,
	meter = false
): PlanStep => ({ id, label, method: 'GET', path, n, tagged: false, auth: 'none', meter });

/** hits per route after its fill */
export const CACHED_HITS = 10;

/**
 * The page store's cost: each route filled on a fresh interpreter then hit, one publish, and the
 * pages it purges filled again. Every request but the publish is untagged, because a `cfwrig`
 * query makes the path one the store refuses.
 */
export const CACHED_PLAN: readonly PlanStep[] = [
	{ ...(REQUEST_PLAN.find((s) => s.id === 'login') as PlanStep) },
	{ ...(REQUEST_PLAN.find((s) => s.id === 'rest-nonce') as PlanStep) },
	...ROUTES.flatMap((r) => [
		anonymous(`fill-${r.id}`, `${r.label}, first request: a fill`, r.path, 1, true),
		anonymous(`hit-${r.id}`, `${r.label}, ${CACHED_HITS} more: hits`, r.path, CACHED_HITS)
	]),
	{
		id: 'publish',
		label: 'POST a published post through REST (the purge)',
		method: 'POST',
		path: '/wp-json/wp/v2/posts',
		n: 1,
		tagged: true,
		auth: 'cookie-nonce',
		meter: true
	},
	...(['home', 'category', 'feed'] as const).map((id) => {
		const r = ROUTES.find((x) => x.id === id) as (typeof ROUTES)[number];
		return anonymous(`refill-${id}`, `${r.label} after the publish: a refill`, r.path, 1, true);
	}),
	anonymous('hit-after', 'front page after the refill: hits', '/', 3)
];

/** the plans by name */
export const PLANS = { full: REQUEST_PLAN, cached: CACHED_PLAN } as const;

/** what a plan costs in requests, before it runs */
export function countBudget(plan: readonly PlanStep[] = REQUEST_PLAN): {
	measured: number;
	setup: number;
	total: number;
	claimObjectInvocations: number;
} {
	const measured = plan.reduce((a, s) => a + s.n, 0);
	// the polls, the claim, the two bracketing stats reads, and two per metered step
	const setup = READY_POLLS_MAX + 1 + STATS_READS + 2 * plan.filter((s) => s.meter).length;
	return { measured, setup, total: measured + setup, claimObjectInvocations: 3 };
}

/** throws when the plan would send more than the ceiling */
export function assertBudget(plan: readonly PlanStep[] = REQUEST_PLAN): void {
	const b = countBudget(plan);
	if (b.total > REQUEST_CEILING) {
		throw new Error(`the plan sends ${b.total} requests; the ceiling is ${REQUEST_CEILING}`);
	}
}

/** the tag of request `i` of a step */
export function tagFor(name: string, step: string, i: number): string {
	return `${name}-${step}-${i}`;
}

/** the path with the rig tag added to its query */
export function withTag(path: string, tag: string): string {
	return `${path}${path.includes('?') ? '&' : '?'}${TAG_PARAM}=${tag}`;
}

/** the requests a plan sends by step id, with tags where the step is tagged */
export function planRequests(
	name: string,
	plan: readonly PlanStep[] = REQUEST_PLAN
): { step: string; i: number; method: string; path: string; tag: string | null }[] {
	const out: { step: string; i: number; method: string; path: string; tag: string | null }[] = [];
	for (const s of plan) {
		for (let i = 0; i < s.n; i++) {
			const tag = s.tagged ? tagFor(name, s.id, i) : null;
			out.push({
				step: s.id,
				i,
				method: s.method,
				path: tag === null ? s.path : withTag(s.path, tag),
				tag
			});
		}
	}
	return out;
}

// #endregion

// #region options

/** the parsed command line */
export type WpOptions = {
	mode: 'dry' | 'local' | 'deployed' | 'emit-config';
	plan: keyof typeof PLANS;
	/** false leaves `PW_DIAGNOSTICS` out of the throwaway, as a shipped deployment runs */
	diagnostics: boolean;
	name: string;
	account: string | undefined;
	eventsOut: string | undefined;
	port: number;
};

/** a fresh `cfw-wp-<8 hex>` name */
export function freshName(): string {
	const b = crypto.getRandomValues(new Uint8Array(4));
	return `cfw-wp-${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** parses the command line, refusing anything unknown; `--dry` and `--local` take no account */
export function parseWpOptions(argv: readonly string[]): WpOptions {
	const o: WpOptions = {
		mode: 'dry',
		plan: 'full',
		diagnostics: true,
		name: '',
		account: undefined,
		eventsOut: undefined,
		port: 8795
	};
	const modes = new Set<string>();
	for (const a of argv) {
		if (a === '--dry' || a === '--local' || a === '--deployed' || a === '--emit-config')
			modes.add(a.slice(2));
		else if (a === '--no-diagnostics') o.diagnostics = false;
		else if (a.startsWith('--plan=')) {
			const p = a.slice('--plan='.length);
			if (p !== 'full' && p !== 'cached') throw new Error('--plan takes full or cached');
			o.plan = p;
		} else if (a.startsWith('--account=')) o.account = a.slice('--account='.length);
		else if (a.startsWith('--name=')) o.name = a.slice('--name='.length);
		else if (a.startsWith('--events-out=')) o.eventsOut = a.slice('--events-out='.length);
		else if (a.startsWith('--port=')) o.port = Number(a.slice('--port='.length));
		else throw new Error(`unknown argument ${a.startsWith('--account') ? '--account...' : a}`);
	}
	if (modes.has('local') && modes.has('deployed')) {
		throw new Error('--local and --deployed are exclusive');
	}
	if (modes.has('local') && modes.has('dry')) throw new Error('--local and --dry are exclusive');
	if (modes.has('emit-config') && modes.size > 1) {
		throw new Error('--emit-config is exclusive with the other modes');
	}
	o.mode = modes.has('emit-config')
		? 'emit-config'
		: modes.has('deployed')
			? 'deployed'
			: modes.has('local')
				? 'local'
				: 'dry';
	if (modes.size === 0) throw new Error('say one of --dry, --local or --deployed');
	if (modes.has('deployed') && modes.has('dry')) o.mode = 'dry';
	const wantsAccount = modes.has('deployed') || modes.has('dry');
	if (o.account !== undefined && !wantsAccount)
		throw new Error('--account belongs to --deployed');
	if (modes.has('deployed') && o.account !== 'student' && o.account !== 'paid') {
		throw new Error('--deployed needs --account=student or --account=paid');
	}
	if (o.account !== undefined && o.account !== 'student' && o.account !== 'paid') {
		throw new Error('--account takes student or paid');
	}
	if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 65000)
		throw new Error('--port is out of range');
	if (o.name === '') o.name = freshName();
	if (!NAME_RE.test(o.name)) throw new Error('--name needs cfw-wp-<8 hex digits>');
	if (o.eventsOut === '') throw new Error('--events-out needs a path');
	return o;
}

// #endregion

// #region the throwaway config and its assets

/** what the throwaway publishes: the WordPress pack and nothing else */
export const PACK_FILES = [
	'wordpress/driver.json',
	'wordpress/pf/core.pf.json',
	'wordpress/pf/core.pf.bin'
] as const;

/** the probe file's name inside the throwaway's copy of the driver pack */
export const PROBE_KEY = 'wp-content/mu-plugins/cfw-probe.php';

/** the largest single asset the free plan takes, as `notes` in the repo record it; unverified here */
export const ASSET_MAX_BYTES = 25 * 1024 * 1024;

/** one staged file */
export type StagedFile = { path: string; bytes: number };

/** the staged set against the free limits; `problems` is empty when it fits */
export function stageProblems(files: readonly StagedFile[]): string[] {
	const problems: string[] = [];
	if (files.length > ASSET_PUBLISH.filesPerVersion.free) {
		problems.push(
			`${files.length} files against ${ASSET_PUBLISH.filesPerVersion.free} per version`
		);
	}
	for (const f of files) {
		if (f.bytes > ASSET_MAX_BYTES) problems.push(`${f.path} is ${f.bytes} bytes`);
	}
	return problems;
}

/** the driver map with the probe file added; the original is not changed */
export function withProbe(driver: Record<string, string>, probe: string): Record<string, string> {
	if (PROBE_KEY in driver) throw new Error('the driver pack already holds a probe file');
	return { ...driver, [PROBE_KEY]: probe };
}

/** where the probe file lives: the GPL tree of the drupflare checkout */
export function probePath(root: string, env: Record<string, string | undefined>): string {
	const src = env.DRUPFLARE_SRC ?? resolve(root, '../drupflare');
	return join(src, 'tests/wp/probe/cfw-probe.php');
}

function listFiles(dir: string, base = dir): StagedFile[] {
	const out: StagedFile[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...listFiles(p, base));
		else out.push({ path: p.slice(base.length + 1), bytes: statSync(p).size });
	}
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Copies the WordPress pack into `outDir` with the probe added to the driver map, and lists what it
 * holds. The repo's `assets/` is read, never written.
 */
export function stageAssets(root: string, outDir: string, probe: string): StagedFile[] {
	const src = join(root, 'assets');
	for (const f of PACK_FILES) {
		mkdirSync(dirname(join(outDir, f)), { recursive: true });
		if (f === 'wordpress/driver.json') {
			const driver = JSON.parse(readFileSync(join(src, f), 'utf8')) as Record<string, string>;
			writeFileSync(join(outDir, f), JSON.stringify(withProbe(driver, probe)));
		} else copyFileSync(join(src, f), join(outDir, f));
	}
	const chunks = join(src, 'wordpress/sql');
	mkdirSync(join(outDir, 'wordpress/sql'), { recursive: true });
	for (const e of readdirSync(chunks)) {
		copyFileSync(join(chunks, e), join(outDir, 'wordpress/sql', e));
	}
	return listFiles(outDir);
}

/** the vars the throwaway runs with, and why each is set */
export function wpVars(origin?: string, diagnostics = true): Record<string, string> {
	return {
		CMS: 'wordpress',
		PLAN: 'free',
		SITE_WARM: '0',
		RETAIN_INTERPRETER: '0',
		SQL_CHUNK_PREFIX: 'wordpress/sql',
		HEAP_SNAPSHOT: '0',
		...(diagnostics ? { PW_DIAGNOSTICS: '1' } : {}),
		...(origin === undefined ? {} : { SITE_ORIGIN: origin })
	};
}

/** the shipping config with the bindings the free account lacks stripped, the WordPress vars, and the staged assets */
export function wpConfig(
	name: string,
	root: string,
	assetsDir: string,
	origin?: string,
	diagnostics = true
): Record<string, unknown> {
	return {
		name,
		main: join(root, 'src/site.ts'),
		minify: true,
		compatibility_date: '2026-08-01',
		compatibility_flags: ['nodejs_compat'],
		vars: wpVars(origin, diagnostics),
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
		assets: { directory: assetsDir, binding: 'ASSETS' },
		observability: { enabled: true },
		alias: { './runtime/php-binary.js': join(root, 'src/runtime/php-binary-raw.ts') }
	};
}

// #endregion

// #region the probe result

/** what the probe printed, or why it could not be read */
export type ProbeResult =
	| {
			ok: true;
			gdInfo: unknown;
			imagecreatefromstring: boolean;
			curlInit: boolean;
			blockExternal: unknown;
			remoteGet: unknown;
			curlExec: unknown;
			refusals?: unknown;
			remotePost?: unknown;
			selfFetch?: unknown;
			imageEditor?: unknown;
			outbound?: unknown;
	  }
	| { ok: false; reason: string };

/** reads the JSON the probe file prints between its `CFWPROBE` markers */
export function parseProbeBody(text: string): ProbeResult {
	const m = /CFWPROBE([\s\S]*?)CFWPROBE/.exec(text);
	if (!m) return { ok: false, reason: 'no CFWPROBE markers in the body' };
	let v: any;
	try {
		v = JSON.parse(m[1] as string);
	} catch {
		return { ok: false, reason: 'the probe JSON did not parse' };
	}
	if (v === null || typeof v !== 'object')
		return { ok: false, reason: 'the probe JSON is not an object' };
	return {
		ok: true,
		gdInfo: v.gdInfo,
		imagecreatefromstring: v.imagecreatefromstring === true,
		curlInit: v.curlInit === true,
		blockExternal: v.blockExternal,
		remoteGet: v.remoteGet,
		curlExec: v.curlExec,
		...(v.refusals === undefined ? {} : { refusals: v.refusals }),
		...(v.remotePost === undefined ? {} : { remotePost: v.remotePost }),
		...(v.selfFetch === undefined ? {} : { selfFetch: v.selfFetch }),
		...(v.imageEditor === undefined ? {} : { imageEditor: v.imageEditor }),
		...(v.outbound === undefined ? {} : { outbound: v.outbound })
	};
}

/** one line per question; a failure is printed as the result, not softened */
export function describeProbe(p: ProbeResult): string[] {
	if (!p.ok) return [`probe unreadable: ${p.reason}`];
	const gd =
		p.gdInfo !== null && typeof p.gdInfo === 'object'
			? `gd_info() answered an array of ${Object.keys(p.gdInfo as object).length} keys`
			: `gd_info() answered ${JSON.stringify(p.gdInfo)}`;
	const more = (label: string, value: unknown): string[] =>
		value === undefined ? [] : [`${label} = ${JSON.stringify(value)}`];
	return [
		gd,
		`function_exists('imagecreatefromstring') = ${p.imagecreatefromstring}`,
		`wp_remote_get = ${JSON.stringify(p.remoteGet)} (WP_HTTP_BLOCK_EXTERNAL = ${JSON.stringify(p.blockExternal)})`,
		`curl shim: curl_init exists = ${p.curlInit}; curl_exec = ${JSON.stringify(p.curlExec)}`,
		...more('refusals', p.refusals),
		...more('wp_remote_post', p.remotePost),
		...more('fetch of the site itself', p.selfFetch),
		...more('image editor', p.imageEditor),
		...more('outbound tally', p.outbound)
	];
}

// #endregion

// #region events and the join

/** one request as the driver sent it and the response answered */
export type RequestRecord = {
	step: string;
	i: number;
	tag: string | null;
	method: string;
	status: number;
	bytes: number;
	startedAt: number;
	endedAt: number;
	headers: Record<string, string>;
};

/** the response headers the table reads */
export const RECORDED_HEADERS = [
	'x-worker-ms',
	'x-cfw-cache',
	'x-cfw-edge',
	'x-cfw-edge-put',
	'x-cfw-kv-put',
	'x-cfw-inline-boot',
	'x-cfw-php-booted',
	'x-cfw-serve-ms',
	'x-cfw-migrate'
] as const;

/** the rig tag in a request URL, in plain or percent-encoded form */
export function rigTagFromUrl(url: unknown): string | null {
	if (typeof url !== 'string') return null;
	const m = new RegExp(`(?:[?&]|%3F|%26)${TAG_PARAM}(?:=|%3D)([A-Za-z0-9-]+)`, 'i').exec(url);
	return m ? (m[1] as string) : null;
}

/** every invocation in an events response with its class, rig tag and end time; secondary log events are skipped */
export function wpRows(body: any): ClassedRow[] {
	const events = body?.result?.events?.events ?? [];
	const out: ClassedRow[] = [];
	for (const e of events) {
		const w = e?.$workers;
		if (!w || typeof w.cpuTimeMs !== 'number') continue;
		const eventType = eventTypeOf(e);
		out.push({
			tag: rigTagFromUrl(w.event?.request?.url) ?? rigTagFromUrl(w.event?.request?.path),
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

/** what one request joined to: its front event and the object fetch invocations inside that event's span */
export type Joined = {
	record: RequestRecord;
	front: ClassedRow | undefined;
	objects: ClassedRow[];
};

/** slack on the span of a front event, for the two meters' clocks */
export const SPAN_SLACK_MS = 25;

function objectsWithin(front: ClassedRow, objects: readonly ClassedRow[]): ClassedRow[] {
	if (front.at === null) return [];
	const end = front.at + SPAN_SLACK_MS;
	const start = front.at - front.wallMs - SPAN_SLACK_MS;
	return objects.filter(
		(o) => o.cls === 'fetch' && o.at !== null && o.at >= start && o.at <= end
	);
}

/**
 * Joins requests to events. A tagged request takes the one front event with its tag. An untagged
 * step takes the front events in its time window when their count equals the requests it sent,
 * in time order. A request with no join keeps `front` undefined, and nothing is guessed for it.
 */
export function joinEvents(
	records: readonly RequestRecord[],
	front: readonly ClassedRow[],
	objects: readonly ClassedRow[],
	windowMs = 2000
): Joined[] {
	const fronts = front.filter((r) => r.cls === 'fetch');
	const out: Joined[] = [];
	const untagged = new Map<string, RequestRecord[]>();
	for (const r of records) {
		if (r.tag === null) {
			untagged.set(r.step, [...(untagged.get(r.step) ?? []), r]);
			continue;
		}
		const hits = fronts.filter((f) => f.tag === r.tag);
		const f = hits.length === 1 ? hits[0] : undefined;
		out.push({ record: r, front: f, objects: f ? objectsWithin(f, objects) : [] });
	}
	for (const rs of untagged.values()) {
		const from = Math.min(...rs.map((r) => r.startedAt)) - windowMs;
		const to = Math.max(...rs.map((r) => r.endedAt)) + windowMs;
		const inWindow = fronts
			.filter((f) => f.tag === null && f.at !== null && f.at >= from && f.at <= to)
			.sort((a, b) => (a.at as number) - (b.at as number));
		const usable = inWindow.length === rs.length;
		const ordered = [...rs].sort((a, b) => a.startedAt - b.startedAt);
		ordered.forEach((r, k) => {
			const f = usable ? inWindow[k] : undefined;
			out.push({ record: r, front: f, objects: f ? objectsWithin(f, objects) : [] });
		});
	}
	return out;
}

// #endregion

// #region the table

/** n and spread of a sample, or the raw values when n is below the floor, labelled as such */
export function show(values: readonly number[], unit = 'ms'): string {
	if (values.length === 0) return 'none';
	const r: Reading | null = readingOf(values);
	if (!r) return `n=${values.length} below the floor, values [${values.join(', ')}] ${unit}`;
	return `n=${r.n} p50 ${r.p50}, min ${r.min}, max ${r.max}, mean ${r.mean.toFixed(1)} ${unit}`;
}

/** one step's row */
export type TableRow = {
	step: string;
	label: string;
	n: number;
	statuses: string;
	bytes: string;
	tiers: string;
	booted: string;
	workerMs: string;
	frontCpu: string;
	objectCpu: string;
	objectInvocations: string;
	joined: string;
	outcomes: string;
};

const count = (values: readonly (string | undefined)[]): string => {
	const m = new Map<string, number>();
	for (const v of values) m.set(v ?? '-', (m.get(v ?? '-') ?? 0) + 1);
	return [...m].map(([k, n]) => `${k} x${n}`).join(', ');
};

/** the table rows, one per step in plan order; joins are optional (a local run has none) */
export function assembleTable(
	records: readonly RequestRecord[],
	joined: readonly Joined[] | undefined,
	plan: readonly PlanStep[] = REQUEST_PLAN
): TableRow[] {
	return plan.map((s) => {
		const rs = records.filter((r) => r.step === s.id);
		const num = (h: string) =>
			rs.map((r) => Number(r.headers[h])).filter((v) => Number.isFinite(v));
		const js = (joined ?? []).filter((j) => j.record.step === s.id);
		const ok = js.filter((j) => j.front !== undefined);
		const objectSums = ok.map((j) => j.objects.reduce((a, o) => a + o.cpuMs, 0));
		const outcomes = [
			...ok.map((j) => j.front?.outcome),
			...ok.flatMap((j) => j.objects.map((o) => o.outcome))
		];
		return {
			step: s.id,
			label: s.label,
			n: rs.length,
			statuses: count(rs.map((r) => String(r.status))),
			bytes:
				rs.length === 0
					? 'none'
					: show(
							rs.map((r) => r.bytes),
							'bytes'
						),
			tiers: count(rs.map((r) => r.headers['x-cfw-cache'] ?? r.headers['x-cfw-edge'])),
			booted: count(rs.map((r) => r.headers['x-cfw-inline-boot'])),
			workerMs: show(num('x-worker-ms')),
			frontCpu: joined
				? show(ok.map((j) => (j.front as ClassedRow).cpuMs))
				: 'not read (local)',
			objectCpu: joined ? show(objectSums) : 'not read (local)',
			objectInvocations: joined
				? count(ok.map((j) => String(j.objects.length)))
				: 'not read (local)',
			joined: joined ? `${ok.length} of ${rs.length}` : 'not read (local)',
			outcomes: joined ? count(outcomes) : 'not read (local)'
		};
	});
}

/** the table as printable lines */
export function formatTable(rows: readonly TableRow[]): string[] {
	const out: string[] = [];
	for (const r of rows) {
		out.push(`${r.step}: ${r.label} (n=${r.n})`);
		out.push(`  status ${r.statuses}; bytes ${r.bytes}`);
		out.push(`  tier (x-cfw-cache or x-cfw-edge) ${r.tiers}; x-cfw-inline-boot ${r.booted}`);
		out.push(`  x-worker-ms (the hop, wall) ${r.workerMs}`);
		out.push(`  front worker cpuTime (Observability) ${r.frontCpu}`);
		out.push(`  object cpuTime, summed per request (Observability) ${r.objectCpu}`);
		out.push(
			`  object fetch invocations per request ${r.objectInvocations}; joined ${r.joined}; outcomes ${r.outcomes}`
		);
	}
	return out;
}

const METER_KEY = /row|memory|mib|heap|limit|exit|trap|wordpress|recycle|reset|^alarmFirings$/i;

/** the `/serve-stats` fields that name rows, memory, limits, exits, WordPress counters or alarm firings, one level deep */
export function pickMeters(stats: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (stats === null || typeof stats !== 'object') return out;
	for (const [k, v] of Object.entries(stats as Record<string, unknown>)) {
		if (METER_KEY.test(k)) out[k] = v;
	}
	return out;
}

/** the fields of one meter set that moved between two reads, numeric ones as a delta */
export function meterDelta(
	before: Record<string, unknown>,
	after: Record<string, unknown>
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(after)) {
		const a = after[k];
		const b = before[k];
		if (typeof a === 'number' && typeof b === 'number') {
			if (a !== b) out[k] = `${b} -> ${a} (${a - b >= 0 ? '+' : ''}${a - b})`;
		} else if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = a;
	}
	return out;
}

// #endregion

// #region the driver

/** a cookie jar that drops a cookie WordPress clears, whether by an expiry in the past or `max-age=0` */
export class CookieJar {
	private readonly jar = new Map<string, string>();

	/** takes the `Set-Cookie` lines of a response */
	take(lines: readonly string[], now = Date.now()): void {
		for (const line of lines) {
			const [pair = ''] = line.split(';');
			const eq = pair.indexOf('=');
			const name = pair.slice(0, eq);
			const value = pair.slice(eq + 1);
			const expires = /expires=([^;]+)/i.exec(line)?.[1];
			const gone =
				(expires !== undefined && Date.parse(expires) < now) || /max-age=0/i.test(line);
			if (gone || value === 'deleted') this.jar.delete(name);
			else this.jar.set(name, value);
		}
	}

	/** the `Cookie` request header, or undefined when the jar is empty */
	header(): string | undefined {
		return this.jar.size === 0
			? undefined
			: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
	}

	/** how many cookies it holds; the values are never read out */
	get size(): number {
		return this.jar.size;
	}
}

/** the form-encoded body of a login */
export function loginBody(user: string, pass: string, origin: string): string {
	return new URLSearchParams({
		log: user,
		pwd: pass,
		'wp-submit': 'Log In',
		redirect_to: `${origin}/wp-admin/`,
		testcookie: '1'
	}).toString();
}

/** the run's outputs besides the per-request records */
export type RunOutput = {
	records: RequestRecord[];
	statsBefore: Record<string, unknown>;
	statsAfter: Record<string, unknown>;
	probe: ProbeResult;
	notes: string[];
	/** rows the object counted written around each metered step */
	stepRows: Record<string, number>;
	startedAt: number;
	endedAt: number;
};

type Step = PlanStep;

/** pause either side of a metered step, longer than the join window, so only its own requests fall in it */
export const METER_PAUSE_MS = 4000;

/**
 * Sends the whole plan to `base`: ready polls, the claim, each measured step, two stats reads. The
 * password is generated here, lives in this function and the cookie jar, and is never logged. `log`
 * receives no body, cookie or token.
 */
export async function driveWordpress(
	base: string,
	name: string,
	doFetch: typeof fetch,
	sleep: (ms: number) => Promise<void>,
	log: (s: string) => void,
	probeUrl = 'https://example.com/',
	plan: readonly PlanStep[] = REQUEST_PLAN
): Promise<RunOutput> {
	assertBudget(plan);
	const stepRows: Record<string, number> = {};
	const pass = `pw-${crypto.randomUUID()}`;
	const jar = new CookieJar();
	const records: RequestRecord[] = [];
	const notes: string[] = [];
	let owner = '';
	let nonce = '';
	const startedAt = Date.now();

	async function send(
		step: string,
		i: number,
		tag: string | null,
		method: string,
		path: string,
		opts: {
			cookie?: boolean;
			headers?: Record<string, string>;
			body?: string;
			keep?: boolean;
		} = {}
	): Promise<{ status: number; text: string; headers: Headers }> {
		const cookie = opts.cookie ? jar.header() : undefined;
		const t0 = Date.now();
		const res = await doFetch(`${base}${path}`, {
			method,
			redirect: 'manual',
			headers: {
				accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				...(cookie ? { cookie } : {}),
				...opts.headers
			},
			...(opts.body === undefined ? {} : { body: opts.body })
		});
		const text = await res.text();
		const t1 = Date.now();
		if (opts.cookie) jar.take(res.headers.getSetCookie());
		const headers: Record<string, string> = {};
		for (const h of RECORDED_HEADERS) {
			const v = res.headers.get(h);
			if (v !== null) headers[h] = v;
		}
		if (opts.keep !== false) {
			records.push({
				step,
				i,
				tag,
				method,
				status: res.status,
				bytes: new TextEncoder().encode(text).length,
				startedAt: t0,
				endedAt: t1,
				headers
			});
		}
		return { status: res.status, text, headers: res.headers };
	}

	// ready: the first requests start the migration chain and answer 503 until it is done
	let ready = false;
	let lastStatus = 0;
	let lastHead = '';
	for (let i = 0; i < READY_POLLS_MAX && !ready; i++) {
		const r = await send('ready', i, null, 'GET', '/wp-login.php', { keep: false });
		ready = r.status === 200;
		lastStatus = r.status;
		lastHead = r.text.slice(0, 160).replace(/\s+/g, ' ');
		if (!ready) await sleep(2000);
	}
	if (!ready) {
		throw new Error(
			`the site never answered 200 on /wp-login.php; the last answer was ${lastStatus}: ${lastHead}`
		);
	}

	const origin = base;
	const claimBody = JSON.stringify({
		adminName: 'rigadmin',
		adminMail: 'rig@example.test',
		adminPass: pass,
		siteName: 'Rig Site'
	});
	const claim = await send('claim', 0, null, 'POST', '/firstrun', {
		headers: { 'content-type': 'application/json' },
		body: claimBody,
		keep: false
	});
	try {
		owner = String((JSON.parse(claim.text) as { ownerToken?: unknown }).ownerToken ?? '');
	} catch {
		owner = '';
	}
	if (claim.status !== 200 || owner === '') {
		throw new Error(`the claim answered ${claim.status}; no owner token was returned`);
	}
	log(`claim answered ${claim.status}; owner token received (not printed)`);

	const statsGet = async (): Promise<Record<string, unknown>> => {
		const r = await send('stats', 0, null, 'GET', '/serve-stats', {
			headers: { authorization: `Bearer ${owner}` },
			keep: false
		});
		try {
			return pickMeters(JSON.parse(r.text));
		} catch {
			notes.push(`/serve-stats answered ${r.status} and was not JSON`);
			return {};
		}
	};
	const statsBefore = await statsGet();

	let probe: ProbeResult = { ok: false, reason: 'the probe step did not run' };
	const stepDone = (s: Step) => log(`drove ${s.id}: ${s.n} request${s.n === 1 ? '' : 's'}`);
	const rowsNow = async () => Number((await statsGet()).rowsToday);
	for (const s of plan) {
		let rowsBefore = Number.NaN;
		if (s.meter) {
			await sleep(METER_PAUSE_MS);
			rowsBefore = await rowsNow();
			await sleep(METER_PAUSE_MS);
		}
		for (let i = 0; i < s.n; i++) {
			const tag = s.tagged ? tagFor(name, s.id, i) : null;
			const path = tag === null ? s.path : withTag(s.path, tag);
			const headers: Record<string, string> = {};
			let body: string | undefined;
			if (s.auth === 'owner') {
				headers.authorization = `Bearer ${owner}`;
				if (s.phase) headers['x-cfw-phase'] = s.phase;
			}
			if (s.auth === 'cookie-nonce') headers['x-wp-nonce'] = nonce;
			if (s.id === 'login') {
				headers['content-type'] = 'application/x-www-form-urlencoded';
				headers.cookie = 'wordpress_test_cookie=WP%20Cookie%20check';
				body = loginBody('rigadmin', pass, origin);
			}
			if (s.id === 'draft' || s.id === 'save' || s.id === 'publish') {
				headers['content-type'] = 'application/json';
				body =
					s.id === 'draft'
						? JSON.stringify({ title: `rig draft ${i}`, status: 'draft' })
						: s.id === 'publish'
							? JSON.stringify({ title: 'Published by the rig', status: 'publish' })
							: JSON.stringify({ title: 'Hello world, saved by the rig' });
			}
			const withCookies =
				s.auth === 'cookie' || s.auth === 'cookie-nonce' || s.id === 'login';
			const target =
				s.id === 'probe' ? `${path}&cfwurl=${encodeURIComponent(probeUrl)}` : path;
			const r = await send(s.id, i, tag, s.method, target, {
				cookie: withCookies,
				headers,
				...(body === undefined ? {} : { body })
			});
			if (s.id === 'rest-nonce') nonce = r.text.trim();
			if (s.id === 'probe') probe = parseProbeBody(r.text);
		}
		if (s.meter) {
			await sleep(METER_PAUSE_MS);
			stepRows[s.id] = (await rowsNow()) - rowsBefore;
		}
		stepDone(s);
	}
	const statsAfter = await statsGet();
	return {
		records,
		statsBefore,
		statsAfter,
		probe,
		notes,
		stepRows,
		startedAt,
		endedAt: Date.now()
	};
}

// #endregion

// #region the runs

/** the wall-clock names a run prints beside a figure so a reader knows which instrument it is */
export const SOURCES = {
	cpu: 'cpuTime, Workers Observability events (the CPU figure)',
	hop: 'x-worker-ms, the front worker hop (the wall figure)'
} as const;

const median = (v: readonly number[]): number | undefined => {
	const s = [...v].sort((a, b) => a - b);
	return s.length === 0 ? undefined : s[Math.floor(s.length / 2)];
};

/**
 * The inputs `free-envelope.ts` takes for WordPress, read from a cached run: per route the fill's
 * wall and object cpuTime, the rows it wrote, and the hit's wall and front cpuTime. A figure with
 * no source (no join, no meter) prints `unread`. Nothing here replaces the assumed 2.25 s a fill;
 * that is the main session's decision.
 */
export function cachedInputs(
	records: readonly RequestRecord[],
	joined: readonly Joined[] | undefined,
	stepRows: Readonly<Record<string, number>>
): string[] {
	const wall = (step: string) =>
		records
			.filter((r) => r.step === step)
			.map((r) => Number(r.headers['x-worker-ms']))
			.filter(Number.isFinite);
	const cpu = (step: string, side: 'objects' | 'front') =>
		(joined ?? [])
			.filter((j) => j.record.step === step && j.front !== undefined)
			.map((j) =>
				side === 'front'
					? (j.front as ClassedRow).cpuMs
					: j.objects.reduce((a, o) => a + o.cpuMs, 0)
			);
	const fmt = (v: number | undefined, n: number, unit: string) =>
		v === undefined ? 'unread' : `${v} ${unit} (p50, n=${n})`;
	const out = [
		'free-envelope inputs for WordPress (measured, this run; assumed values stay until told)'
	];
	for (const r of ROUTES) {
		const f = `fill-${r.id}`;
		const h = `hit-${r.id}`;
		out.push(
			`  ${r.id}: fill wall ${fmt(median(wall(f)), wall(f).length, 'ms')}; fill object cpu ${fmt(median(cpu(f, 'objects')), cpu(f, 'objects').length, 'ms')}; ` +
				`fill rows ${stepRows[f] ?? 'unread'}; hit wall ${fmt(median(wall(h)), wall(h).length, 'ms')}; hit front cpu ${fmt(median(cpu(h, 'front')), cpu(h, 'front').length, 'ms')}`
		);
	}
	const fills = ROUTES.map((r) => median(wall(`fill-${r.id}`))).filter(
		(v): v is number => v !== undefined
	);
	out.push(
		`  WORDPRESS_RENDER_SECONDS candidate: ${fills.length === 0 ? 'unread' : `${(median(fills) as number) / 1000} s (median of the ${fills.length} route medians, n=1 fill each)`}; the file assumes 2.25 s`
	);
	const rows = ROUTES.map((r) => stepRows[`fill-${r.id}`]).filter((v) => v !== undefined);
	out.push(
		`  WORDPRESS_ROWS_PER_FILL candidate: ${rows.length === 0 ? 'unread' : `${median(rows)} rows (median over ${rows.length} fills); the file derives it from a warmth mix`}`
	);
	out.push(
		`  publish rows ${stepRows.publish ?? 'unread'}; refill rows home ${stepRows['refill-home'] ?? 'unread'}, category ${stepRows['refill-category'] ?? 'unread'}, feed ${stepRows['refill-feed'] ?? 'unread'}`
	);
	return out;
}

/** prints the run: the table, the meters, the probe and the notes */
export function report(
	out: RunOutput,
	joined: readonly Joined[] | undefined,
	log: (s: string) => void,
	events?: { front: ClassedRow[]; objects: ClassedRow[] },
	plan: readonly PlanStep[] = REQUEST_PLAN
): void {
	log('');
	log(`sources: CPU is ${SOURCES.cpu}; wall is ${SOURCES.hop}; n and spread are per row`);
	for (const l of formatTable(assembleTable(out.records, joined, plan))) log(l);
	if (plan === CACHED_PLAN)
		for (const l of cachedInputs(out.records, joined, out.stepRows)) log(l);
	if (events) {
		log(
			`whole run, object invocations by class: ${formatClassTable(classTable(events.objects))}`
		);
		log(
			`whole run, front worker invocations by class: ${formatClassTable(classTable(events.front))}`
		);
	}
	log(
		`serve-stats fields that moved: ${JSON.stringify(meterDelta(out.statsBefore, out.statsAfter))}`
	);
	log(`serve-stats before: ${JSON.stringify(out.statsBefore)}`);
	for (const l of describeProbe(out.probe)) log(`probe: ${l}`);
	for (const n of out.notes) log(`note: ${n}`);
}

/** the deploy plan `--dry` prints; calls nothing */
export function planLines(
	name: string,
	root: string,
	staged: readonly StagedFile[],
	env: Record<string, string | undefined>,
	plan: readonly PlanStep[] = REQUEST_PLAN
): string[] {
	const b = countBudget(plan);
	const bytes = staged.reduce((a, f) => a + f.bytes, 0);
	const missing = [STUDENT_ID_ENV, STUDENT_TOKEN_ENV].filter((v) => !env[v]);
	const problems = stageProblems(staged);
	return [
		`worker name: ${name}`,
		`account: student (free), the variables ${STUDENT_ID_ENV} and ${STUDENT_TOKEN_ENV} are ${missing.length === 0 ? 'both set' : `MISSING: ${missing.join(', ')}`}`,
		`vars: ${JSON.stringify(wpVars())}`,
		`page cache: ${PAGE_CACHE_VAR} is not passed, so the throwaway runs the shipped default (on)`,
		`published assets: ${staged.length} files, ${bytes} bytes; largest ${Math.max(...staged.map((f) => f.bytes))} bytes; free limits ${ASSET_PUBLISH.filesPerVersion.free} files per version, ${ASSET_MAX_BYTES} bytes per asset (the per-asset figure is the repo's note, not re-read from the docs)`,
		...staged.map((f) => `  ${f.path} ${f.bytes}`),
		problems.length === 0
			? 'assets fit the limits'
			: `assets do NOT fit: ${problems.join('; ')}`,
		'not published: wp-includes and wp-admin css and js, theme assets. A page links to /wp-includes/... and /wp-content/themes/...; on this deploy those answer from the Worker, not the asset layer, so a browser would see unstyled pages. The server work of every route below is unchanged by it.',
		`inventory it would diff against (read only by --deployed): ${JSON.stringify(KNOWN_BASELINE satisfies Inventory)}`,
		`request budget: ${b.measured} measured + ${b.setup} setup (up to ${READY_POLLS_MAX} readiness polls, 1 claim, ${STATS_READS} stats reads) = ${b.total} of ${REQUEST_CEILING}; the claim is ${b.claimObjectInvocations} object invocations`,
		`root: ${root}`,
		`reads after the run: Workers Observability events (durableObject and stateless) for the run window, after ${OBSERVABILITY_INGEST_LAG_MS / 60_000} min; /serve-stats before and after`
	];
}

/** what a cached plan sends and how long it takes, as `--dry` prints it; needs no credential */
export function cachedPlanLines(plan: readonly PlanStep[] = CACHED_PLAN): string[] {
	const b = countBudget(plan);
	const metered = plan.filter((s) => s.meter).length;
	const pauseS = (metered * 3 * METER_PAUSE_MS) / 1000;
	const fills = plan.filter((s) => s.id.startsWith('fill-') || s.id.startsWith('refill-')).length;
	const hits = plan.filter((s) => s.id.startsWith('hit-')).reduce((a, s) => a + s.n, 0);
	return [
		`cached plan: ${plan.length} steps, ${b.measured} measured requests (${fills} fills, ${hits} hits, 1 publish), ${b.setup} setup requests (polls up to ${READY_POLLS_MAX}, 1 claim, ${STATS_READS + 2 * metered} stats reads) = ${b.total} of ${REQUEST_CEILING}`,
		`pauses: ${metered} metered steps at ${(3 * METER_PAUSE_MS) / 1000} s each = ${pauseS} s, so a stats read never falls in a step's join window`,
		'owner stats reads are front-worker requests that each cost one object invocation; a fill is one object invocation plus its rows; a hit served from the front worker costs no object invocation',
		'figures read: cpuTime and wall per invocation from Workers Observability events (measured), rows per fill from rowsToday around each metered step (the object counter, not the bill), x-worker-ms per request (wall)',
		'the 2.25 s a fill in free-envelope.ts stays assumed until the main session replaces it'
	];
}

/** the deployed measuring step: drive, wait for ingest, read events, print */
export function measureDeployed(
	name: string,
	plan: readonly PlanStep[] = REQUEST_PLAN
): (ctx: RunContext) => Promise<void> {
	return async (ctx) => {
		const secrets = [ctx.creds.id, ctx.creds.token];
		const log = (s: string) => ctx.deps.log(redact(s, secrets));
		const out = await driveWordpress(
			ctx.base,
			name,
			ctx.deps.fetch,
			ctx.deps.sleep,
			log,
			undefined,
			plan
		);
		log(`waiting ${OBSERVABILITY_INGEST_LAG_MS / 60_000} min for Observability ingest`);
		await ctx.deps.sleep(OBSERVABILITY_INGEST_LAG_MS);
		const from = out.startedAt - 2000;
		const to = out.endedAt + 2000;
		let objBody: any;
		let frontBody: any;
		let previous = -1;
		for (let attempt = 0; attempt < 6; attempt++) {
			objBody = await queryEventsRaw(ctx, 'durableObject', from, to);
			frontBody = await queryEventsRaw(ctx, 'stateless', from, to);
			const total = wpRows(objBody).length + wpRows(frontBody).length;
			if (total === previous) break;
			previous = total;
			await ctx.deps.sleep(60_000);
		}
		const objects = wpRows(objBody);
		const front = wpRows(frontBody);
		if (objects.length >= EVENTS_LIMIT || front.length >= EVENTS_LIMIT) {
			out.notes.push('an events response reached the limit and may be truncated');
		}
		if (ctx.eventsOut) {
			mkdirSync(dirname(resolve(ctx.eventsOut)), { recursive: true });
			writeFileSync(
				ctx.eventsOut,
				JSON.stringify(
					redactDump(
						{ worker: ctx.name, objBody, frontBody, records: out.records },
						secrets
					)
				)
			);
			log(`raw events written (redacted) to ${resolve(ctx.eventsOut)}`);
		}
		report(out, joinEvents(out.records, front, objects), log, { front, objects }, plan);
	};
}

async function localRun(opts: WpOptions, root: string, staged: string): Promise<number> {
	const origin = `http://localhost:${opts.port}`;
	const dir = join(tmpdir(), `wp-rig-${opts.name}`);
	const config = join(dir, 'wrangler.jsonc');
	writeFileSync(config, JSON.stringify(wpConfig(opts.name, root, staged, origin), null, '\t'));
	const state = join(dir, 'state');
	const child: ChildProcess = spawn(
		'bunx',
		[
			'wrangler',
			'dev',
			'-c',
			config,
			'--port',
			String(opts.port),
			'--inspector-port',
			String(opts.port + 500),
			'--persist-to',
			state
		],
		{ cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	let tail = '';
	child.stdout?.on('data', (d) => (tail = (tail + d).slice(-4000)));
	child.stderr?.on('data', (d) => (tail = (tail + d).slice(-4000)));
	const stop = async () => {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
		} catch {
			// already gone
		}
		await new Promise((r) => setTimeout(r, 1500));
	};
	try {
		const deadline = Date.now() + 240_000;
		for (;;) {
			try {
				await fetch(`${origin}/wp-login.php`);
				break;
			} catch {
				if (Date.now() > deadline) throw new Error('wrangler dev never listened');
				await new Promise((r) => setTimeout(r, 1500));
			}
		}
		const out = await driveWordpress(
			origin,
			opts.name,
			fetch,
			(ms) => new Promise((r) => setTimeout(r, ms)),
			(s) => console.log(s),
			undefined,
			PLANS[opts.plan]
		);
		console.log(
			'local run: no Observability here; wall figures are this machine, not the platform'
		);
		report(out, undefined, (s) => console.log(s), undefined, PLANS[opts.plan]);
		return 0;
	} catch (e) {
		console.log(`local run failed: ${(e as Error).message}`);
		console.log(tail);
		return 1;
	} finally {
		await stop();
	}
}

// #endregion

if (import.meta.main) {
	const opts = parseWpOptions(process.argv.slice(2));
	const root = resolve(import.meta.dirname, '../..');
	const probeFile = probePath(root, process.env);
	const probe = readFileSync(probeFile, 'utf8');
	const staged = join(tmpdir(), `wp-rig-${opts.name}`, 'assets');
	const files = stageAssets(root, staged, probe);
	if (opts.mode === 'dry') {
		const plan = PLANS[opts.plan];
		const lines = planLines(opts.name, root, files, process.env, plan);
		for (const l of lines) console.log(l);
		if (opts.plan === 'cached') {
			for (const l of cachedPlanLines(plan)) console.log(l);
			process.exit(stageProblems(files).length === 0 ? 0 : 2);
		}
		process.exit(
			[STUDENT_ID_ENV, STUDENT_TOKEN_ENV].every((v) => process.env[v]) &&
				stageProblems(files).length === 0
				? 0
				: 2
		);
	} else if (opts.mode === 'emit-config') {
		const dir = join(tmpdir(), `wp-rig-${opts.name}`);
		const config = join(dir, 'wrangler.jsonc');
		const cfg = wpConfig(opts.name, root, staged, undefined, opts.diagnostics);
		writeFileSync(config, JSON.stringify(cfg, null, '\t'));
		console.log(JSON.stringify({ name: opts.name, config, assets: staged }));
	} else if (opts.mode === 'local') {
		process.exit(await localRun(opts, root, staged));
	} else {
		const deps: Deps = {
			fetch,
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			log: (s) => console.log(s),
			measure: measureDeployed(opts.name, PLANS[opts.plan]),
			run: (cmd, args, env) =>
				new Promise((res) => {
					const child = spawn(cmd, args, { cwd: root, env });
					let o = '';
					child.stdout.on('data', (d) => (o += d));
					child.stderr.on('data', (d) => (o += d));
					child.on('close', (code) => res({ code: code ?? 1, out: o }));
				})
		};
		process.exit(
			await runDeployed(
				{
					mode: 'deployed',
					name: opts.name,
					dry: false,
					account: opts.account,
					eventsOut: opts.eventsOut
				},
				process.env,
				deps,
				root,
				(name, r) => wpConfig(name, r, staged, undefined, opts.diagnostics)
			)
		);
	}
}
