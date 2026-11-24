/**
 * Counts how much memory one isolate holds before the platform replaces it, in a deployed site
 * that has the owner `/ladder` route on (`LADDER_PROBE=1`).
 *
 * Each rung is one POST that allocates 4 MiB. The isolate id in the answer is the signal: the first
 * rung that reports another id means the isolate was replaced, and the headroom is the total held
 * by the last rung that still reported the first one. A ladder that reaches the step cap throws, so
 * a site with more room than the cap allows cannot read as a measurement.
 *
 * ```sh
 * LADDER_OWNER_TOKEN=... LADDER_ADMIN_PASS=... bun scripts/measure/ladder-arms.ts \
 *   --origin=https://cfw-x.example.workers.dev --reps=3 --out=ladder.jsonl
 * ```
 *
 * `--cms=wordpress` drives WordPress instead: the admin arm opens `/wp-admin/edit.php` and the flush
 * arm saves Settings, Permalinks. The admin user is `admin` on Drupal and `rigadmin` on WordPress
 * unless `LADDER_ADMIN_USER` names another.
 *
 * The owner token comes from the claim's `POST /firstrun` answer (`ownerToken`). Take it without
 * printing it, for example `export LADDER_OWNER_TOKEN="$(curl -s -X POST "$ORIGIN/firstrun" -H
 * 'content-type: application/json' -d "$CLAIM_BODY" | bun -e 'process.stdout.write(JSON.parse(await
 * Bun.stdin.text()).ownerToken)')"`, with the admin password already in `LADDER_ADMIN_PASS`.
 *
 * `--settle=0,60,240` waits that many seconds after an arm's prepare step, once per value, so churn
 * left by the arm's work can be told from headroom. Before the first rung each ladder reads the
 * owner `/serve-stats` and keeps the bridge byte tally and the isolate estimate in its result line.
 *
 * Every raw answer goes to the `--out` file; the console gets one summary line per ladder. The
 * owner token and the admin password are read from the two variables above and never printed.
 */
import { appendFileSync } from 'node:fs';

/** the rung height the route allocates, in MiB */
export const RUNG_MIB = 4;

/** rungs a ladder may climb before it is a failed reading rather than a short one */
export const DEFAULT_STEP_CAP = 80;

/** the arms, in the order a repetition runs them */
export const ARMS = ['bare', 'boot', 'admin', 'flush'] as const;

/** one of the arms: bare recycles and measures, the others do their work first */
export type Arm = (typeof ARMS)[number];

/** what the route answers for one rung */
export type Rung = { id: string; totalMiB: number; linearMiB: number; spareMiB: number };

/** how a ladder ended; `cap` is never returned, it throws */
export type LadderStatus = 'replaced' | 'call-failed' | 'parse-failed';

/** one finished ladder */
export type LadderResult = {
	status: LadderStatus;
	/** rungs answered under the first isolate id */
	steps: number;
	/** MiB held by the last rung under that id; null when no rung answered */
	headroomMiB: number | null;
	/** the first rung's linear and spare memory, which says what the isolate held before it */
	first: { linearMiB: number; spareMiB: number } | null;
};

/** the step cap was reached with the isolate still in place */
export class LadderCapError extends Error {
	constructor(
		readonly steps: number,
		readonly headroomMiB: number | null
	) {
		super(`ladder reached its ${steps} step cap with no replacement; raise --cap and rerun`);
		this.name = 'LadderCapError';
	}
}

/** reads one rung out of a response body, or undefined when it is not one */
export function parseRung(text: string): Rung | undefined {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (body === null || typeof body !== 'object') return undefined;
	const { id, totalMiB, linearMiB, spareMiB } = body as Record<string, unknown>;
	if (typeof id !== 'string' || id === '') return undefined;
	for (const n of [totalMiB, linearMiB, spareMiB]) {
		if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
	}
	return { id, totalMiB, linearMiB, spareMiB } as Rung;
}

/** what a ladder needs from its caller, so a spec can stand in for the network */
export type LadderDeps = {
	fetch: typeof fetch;
	sleep: (ms: number) => Promise<void>;
	/** called with every raw answer, for the log */
	record?: (entry: Record<string, unknown>) => void;
};

/** climbs one ladder until the isolate id changes, a call fails, or the cap is reached */
export async function climb(
	origin: string,
	token: string,
	deps: LadderDeps,
	cap = DEFAULT_STEP_CAP
): Promise<LadderResult> {
	let id: string | undefined;
	let first: LadderResult['first'] = null;
	let headroomMiB: number | null = null;
	let steps = 0;
	for (let i = 1; i <= cap; i++) {
		const t0 = Date.now();
		let res: Response;
		try {
			res = await deps.fetch(`${origin}/ladder`, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(180_000)
			});
		} catch (error) {
			deps.record?.({ phase: 'step', i, error: String(error) });
			return { status: 'call-failed', steps, headroomMiB, first };
		}
		const text = await res.text();
		deps.record?.({ phase: 'step', i, httpStatus: res.status, ms: Date.now() - t0, text });
		if (!res.ok) return { status: 'call-failed', steps, headroomMiB, first };
		const rung = parseRung(text);
		if (!rung) return { status: 'parse-failed', steps, headroomMiB, first };
		if (id === undefined) {
			id = rung.id;
			first = { linearMiB: rung.linearMiB, spareMiB: rung.spareMiB };
		}
		if (rung.id !== id) return { status: 'replaced', steps, headroomMiB, first };
		headroomMiB = rung.totalMiB;
		steps = i;
		await deps.sleep(200);
	}
	throw new LadderCapError(steps, headroomMiB);
}

/** the command line, with the defaults a deployed run uses */
export type Options = {
	origin: string;
	reps: number;
	arms: Arm[];
	cap: number;
	/** seconds to wait after an arm's prepare step before the first rung; one ladder per value */
	settle: number[];
	/** which CMS the admin and flush arms drive */
	cms: Cms;
	out?: string;
};

/** reads a comma list of non-negative seconds, such as `0,60,240` */
export function parseSettles(value: string): number[] {
	const parts = value.split(',');
	const out = parts.map((p) => (/^\d+(\.\d+)?$/.test(p) ? Number(p) : Number.NaN));
	if (out.length === 0 || out.some((n) => !Number.isFinite(n))) {
		throw new Error(`--settle takes a comma list of seconds; got ${value}`);
	}
	return out;
}

/** what a ladder records about the object just before its first rung */
export type StatsSnapshot = {
	/**
	 * the bridge byte tally of one request or alarm, or null when the object reported none. The
	 * object resets its live tally per request and `/serve-stats` `crossings` carries counts only,
	 * so a deployed object's tally survives in the last `demand` entry that has a `bridge`; the
	 * request that entry belongs to is named in `path` and `method`.
	 */
	bridge: Record<string, number | string> | null;
	/** which `/serve-stats` field `bridge` came from: `demand[last].bridge`, `crossings.bytes` or `none` */
	bridgeField: string;
	/** why `bridge` is null, in words, when it is */
	bridgeNote?: string;
	/** the object's crossing count over its life; `crossings.total` is last-render and can be negative after a drop */
	crossingsTotal?: number;
	/** the object's own isolate estimate, bytes */
	isolateBytes?: Record<string, number>;
};

type Flat = Record<string, number | string>;

const flat = (value: unknown): Flat | undefined => {
	if (value === null || typeof value !== 'object') return undefined;
	const out: Flat = {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v === 'number' || typeof v === 'string') out[k] = v;
	}
	return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * Reads the bridge byte tally, the crossing total and the isolate estimate out of a `/serve-stats`
 * body; undefined only when the body is not a JSON object. A body with no tally still answers,
 * with `bridge: null` and a note, so the result line says so instead of dropping the field.
 */
export function parseStats(text: string): StatsSnapshot | undefined {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (body === null || typeof body !== 'object') return undefined;
	const { crossings, crossingsTotal, isolateBytes, demand } = body as {
		crossings?: { bytes?: unknown } | null;
		crossingsTotal?: unknown;
		isolateBytes?: unknown;
		demand?: unknown;
	};
	let bridge: Flat | undefined;
	let bridgeField = 'none';
	const live = flat(crossings?.bytes);
	if (live) {
		bridge = live;
		bridgeField = 'crossings.bytes';
	} else if (Array.isArray(demand)) {
		for (let i = demand.length - 1; i >= 0 && !bridge; i--) {
			const entry = demand[i] as Record<string, unknown> | null;
			const tally = flat(entry?.['bridge']);
			if (!tally) continue;
			bridge = {
				...tally,
				...(typeof entry?.['path'] === 'string' ? { path: entry['path'] } : {}),
				...(typeof entry?.['method'] === 'string' ? { method: entry['method'] } : {}),
				...(typeof entry?.['renderBytes'] === 'number'
					? { renderBytes: entry['renderBytes'] }
					: {})
			};
			bridgeField = 'demand[last].bridge';
		}
	}
	const isolate = flat(isolateBytes) as Record<string, number> | undefined;
	return {
		bridge: bridge ?? null,
		bridgeField,
		...(bridge
			? {}
			: {
					bridgeNote:
						'the object reported no bridge byte tally: no crossings.bytes and no demand entry carries a bridge'
				}),
		...(typeof crossingsTotal === 'number' ? { crossingsTotal } : {}),
		...(isolate ? { isolateBytes: isolate } : {})
	};
}

/** reads the owner `/serve-stats` once; a failure is a missing snapshot, never an error */
export async function readStats(
	origin: string,
	token: string,
	deps: Pick<LadderDeps, 'fetch'>
): Promise<StatsSnapshot | undefined> {
	try {
		const res = await deps.fetch(`${origin}/serve-stats`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(60_000)
		});
		return res.ok ? parseStats(await res.text()) : undefined;
	} catch {
		return undefined;
	}
}

/** reads `--origin`, `--reps`, `--arms`, `--cap`, `--settle`, `--cms` and `--out`; throws on anything else */
export function parseArgs(argv: readonly string[]): Options {
	const out: Options = {
		origin: '',
		reps: 3,
		arms: [...ARMS],
		cap: DEFAULT_STEP_CAP,
		settle: [0],
		cms: 'drupal'
	};
	for (const arg of argv) {
		const match = /^--([a-z]+)=(.*)$/.exec(arg);
		if (!match) throw new Error(`unrecognised argument ${arg}`);
		const [, key, value = ''] = match;
		if (key === 'origin') {
			if (!/^https:\/\/[^/\s]+$/.test(value))
				throw new Error('--origin must be https://host');
			out.origin = value;
		} else if (key === 'reps' || key === 'cap') {
			const n = Number(value);
			if (!Number.isInteger(n) || n < 1)
				throw new Error(`--${key} must be a positive integer`);
			out[key] = n;
		} else if (key === 'arms') {
			const arms = value.split(',').filter(Boolean);
			const bad = arms.filter((a) => !(ARMS as readonly string[]).includes(a));
			if (bad.length > 0 || arms.length === 0) {
				throw new Error(`--arms takes ${ARMS.join(', ')}; got ${value}`);
			}
			out.arms = arms as Arm[];
		} else if (key === 'cms') {
			if (!(CMSES as readonly string[]).includes(value)) {
				throw new Error(`--cms takes ${CMSES.join(' or ')}; got ${value}`);
			}
			out.cms = value as Cms;
		} else if (key === 'settle') {
			out.settle = parseSettles(value);
		} else if (key === 'out') {
			out.out = value;
		} else {
			throw new Error(`unrecognised argument ${arg}`);
		}
	}
	if (out.origin === '') throw new Error('--origin is required');
	return out;
}

/** the one line printed per ladder; carries no credential */
export function summarise(
	arm: Arm,
	rep: number,
	result: LadderResult | { error: string },
	extra: { settleS?: number; before?: StatsSnapshot } = {}
): string {
	return JSON.stringify({ arm, rep, ...extra, ...result });
}

/** the CMSes an arm's prepare step knows how to drive */
export const CMSES = ['drupal', 'wordpress'] as const;

/** one of {@link CMSES} */
export type Cms = (typeof CMSES)[number];

/** the admin user name a claim creates, unless `LADDER_ADMIN_USER` names another */
export const DEFAULT_ADMIN: Record<Cms, string> = { drupal: 'admin', wordpress: 'rigadmin' };

/** the parts of `route-peaks.ts` an arm's prepare step uses, so a spec can hand in the real module */
export type Peaks = Pick<
	typeof import('./route-peaks'),
	'send' | 'prepareSession' | 'DRUPAL_ROUTES'
>;

/** the inputs of the WordPress permalink form that a save has to send back, decoded */
export function permalinkFields(html: string): Record<string, string> | undefined {
	const start = /<form[^>]*action="options-permalink\.php"[^>]*>/.exec(html);
	if (!start) return undefined;
	const rest = html.slice(start.index + start[0].length);
	const body = rest.slice(
		0,
		rest.indexOf('</form>') === -1 ? undefined : rest.indexOf('</form>')
	);
	const decode = (v: string) =>
		v
			.replace(/&amp;/g, '&')
			.replace(/&quot;/g, '"')
			.replace(/&#0?39;/g, "'");
	const out: Record<string, string> = {};
	for (const tag of body.match(/<input[^>]*>/g) ?? []) {
		const name = /name="([^"]*)"/.exec(tag)?.[1];
		const type = /type="([^"]*)"/.exec(tag)?.[1];
		const value = decode(/value="([^"]*)"/.exec(tag)?.[1] ?? '');
		if (!name) continue;
		if (type === 'hidden' || name === 'permalink_structure') out[name] = value;
		else if (type === 'radio' && /\bchecked\b/.test(tag)) out[name] = value;
	}
	return '_wpnonce' in out ? out : undefined;
}

/**
 * Does the arm's work on the site and returns when it is done: nothing for `bare`, a front page
 * answering 200 for `boot`, then an admin page for `admin` and a cache flush for `flush`. On Drupal
 * the flush is the performance form; on WordPress it is a save of Settings, Permalinks, which
 * rewrites the rules and flushes them.
 */
export async function prepareArm(
	arm: Arm,
	rep: number,
	cms: Cms,
	session: Parameters<Peaks['send']>[0],
	peaks: Peaks,
	ctx: { sleep: (ms: number) => Promise<void>; record: (entry: Record<string, unknown>) => void }
): Promise<void> {
	const done = (r: { status: number; ms: number }, extra: Record<string, unknown> = {}) =>
		ctx.record({ arm, rep, phase: 'prepare', httpStatus: r.status, ms: r.ms, ...extra });
	if (arm === 'bare') return;
	if (arm === 'boot') {
		for (let i = 1; i <= 60; i++) {
			const r = await peaks.send(session, 'GET', '/');
			done(r, { i });
			if (r.status === 200) return;
			await ctx.sleep(2000);
		}
		throw new Error('GET / never answered 200');
	}
	await peaks.prepareSession(session, { claim: false });
	if (arm === 'admin') {
		const path = cms === 'wordpress' ? '/wp-admin/edit.php' : '/admin/content';
		const r = await peaks.send(session, 'GET', path, { cookie: true });
		done(r);
		if (r.status !== 200) throw new Error(`${path} answered ${r.status}`);
		return;
	}
	if (cms === 'wordpress') {
		const page = await peaks.send(session, 'GET', '/wp-admin/options-permalink.php', {
			cookie: true
		});
		const fields = permalinkFields(page.text);
		if (page.status !== 200 || !fields) {
			throw new Error(`/wp-admin/options-permalink.php answered ${page.status} with no form`);
		}
		const r = await peaks.send(session, 'POST', '/wp-admin/options-permalink.php', {
			cookie: true,
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ ...fields, submit: 'Save Changes' }).toString()
		});
		done(r, { location: r.headers?.get('location') ?? null });
		if (r.status !== 200 && r.status !== 302) {
			throw new Error(`the permalink save answered ${r.status}`);
		}
		return;
	}
	const route = peaks.DRUPAL_ROUTES.find((x) => x.id === 'flush');
	const ready = await route?.prepare(session, 1);
	if (!route || !ready || 'skip' in ready) throw new Error('the flush route is not available');
	done(
		await peaks.send(session, ready.method, ready.path, {
			cookie: ready.cookie,
			headers: ready.headers,
			body: ready.body
		})
	);
}

if (import.meta.main) {
	const options = parseArgs(process.argv.slice(2));
	const token = process.env['LADDER_OWNER_TOKEN'] ?? '';
	const pass = process.env['LADDER_ADMIN_PASS'] ?? '';
	if (token === '') throw new Error('LADDER_OWNER_TOKEN is not set');
	const record = (entry: Record<string, unknown>) => {
		if (options.out) {
			appendFileSync(
				options.out,
				`${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`
			);
		}
	};
	const deps: LadderDeps = {
		fetch,
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		record
	};
	const peaks = await import('./route-peaks');
	const session = peaks.newSession(
		options.origin,
		options.cms,
		{
			CENSUS_OWNER_TOKEN: token,
			CENSUS_ADMIN_PASS: pass,
			CENSUS_ADMIN_USER: process.env['LADDER_ADMIN_USER'] ?? DEFAULT_ADMIN[options.cms]
		},
		[],
		fetch,
		(note) => record({ note })
	);
	const recycle = async (arm: Arm, rep: number) => {
		const res = await fetch(`${options.origin}/recycle`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` }
		});
		record({ arm, rep, phase: 'recycle', httpStatus: res.status, text: await res.text() });
		if (!res.ok) throw new Error(`/recycle answered ${res.status}`);
	};
	const prepare = (arm: Arm, rep: number) =>
		prepareArm(arm, rep, options.cms, session, peaks, { sleep: deps.sleep, record });

	let failed = 0;
	for (let rep = 1; rep <= options.reps; rep++) {
		for (const arm of options.arms) {
			for (const settleS of options.settle) {
				try {
					await recycle(arm, rep);
					await prepare(arm, rep);
					if (settleS > 0) await deps.sleep(settleS * 1000);
					const before = (await readStats(options.origin, token, deps)) ?? {
						bridge: null,
						bridgeField: 'none',
						bridgeNote: '/serve-stats did not answer a JSON object'
					};
					const result = await climb(options.origin, token, deps, options.cap);
					const extra = { settleS, ...(before ? { before } : {}) };
					record({ arm, rep, phase: 'result', ...extra, ...result });
					console.log(summarise(arm, rep, result, extra));
					if (result.status !== 'replaced') failed += 1;
				} catch (error) {
					failed += 1;
					const message = error instanceof Error ? error.message : String(error);
					record({ arm, rep, settleS, phase: 'error', error: message });
					console.log(summarise(arm, rep, { error: message }, { settleS }));
				}
			}
		}
	}
	process.exitCode = failed === 0 ? 0 : 1;
}
