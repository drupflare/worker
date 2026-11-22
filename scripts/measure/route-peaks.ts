/**
 * Drives one site through a fixed set of routes, each from a cold interpreter, and records what the
 * object says about its memory: the linear size the route reached, whether the object's incarnation
 * changed, whether a response named the memory limit, and (on a deployed worker) the platform meter
 * row and `cpuTime`. It prints one table with n and spread per route.
 *
 * ```sh
 * bun scripts/measure/route-peaks.ts --cms=wordpress --dry
 * bun scripts/measure/route-peaks.ts --cms=drupal --local --n=3
 * CENSUS_OWNER_TOKEN=... bun scripts/measure/route-peaks.ts --cms=drupal --base=https://site.example --n=5
 * bun scripts/measure/route-peaks.ts --cms=wordpress --deployed --account=paid --name=cfw-wp-0a1b2c3d --n=5
 * ```
 *
 * `--margin-mib` and `--warn-share` have no default. Without them the script prints counts and no
 * share; with them it prints the arithmetic and no verdict word. A local peak is the object's own
 * linear-memory reading, not the platform meter, and the local base of that probe is not calibrated,
 * so no local reading is compared with the 203 MiB line.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { classifyLimit } from '../../src/ops/platform-limits';
import { OBSERVABILITY_INGEST_LAG_MS } from './bench';
import {
	queryEventsRaw,
	redact,
	redactDump,
	runDeployed,
	throwawayConfig,
	type Deps,
	type RunContext
} from './headlines';
import {
	CookieJar,
	joinEvents,
	loginBody,
	probePath,
	stageAssets,
	withTag,
	wpConfig,
	wpRows,
	type RequestRecord
} from './wordpress-deployed';

// #region constants

/** bytes in a MiB */
export const MIB = 1_048_576;

/** the platform meter reading at which an object was killed, in MiB (the roadmap's figure, measured on Thunder routes) */
export const LINE_MIB = 203;

/** the longest a single drive request may take */
export const DRIVE_TIMEOUT_MS = 240_000;

/** times the after-drive stats read is tried; an object that just reset answers nothing for about 10 s */
export const AFTER_READ_TRIES = 6;

/** the wait between those tries */
export const AFTER_READ_WAIT_MS = 3000;

/** the window one meter row covers: a row starts with an isolate and then there is one per minute */
export const METER_ROW_MS = 60_000;

/** the gap between drives that lets a meter row belong to one drive */
export const METER_GAP_MS = 65_000;

/** the counters the object keeps in memory per incarnation; a drop in any of them says it restarted */
export const INCARNATION_COUNTERS = [
	'phpLaneEntries',
	'storageLaneServes',
	'alarmFirings',
	'recycles',
	'heapsReused',
	'exitedRuns',
	'trappedRuns'
] as const;

/** the response headers a drive keeps */
export const KEPT_HEADERS = ['x-worker-ms', 'x-cfw-inline-boot', 'x-cfw-php-booted'] as const;

// #endregion

// #region snapshots

/** one entry of the object's demand log: what a request did to linear memory */
export type DemandEntry = {
	path: string;
	method: string;
	before: number;
	after: number;
	reused?: boolean;
};

/** the fields of `/serve-stats` the census reads; a field the object did not report is absent */
export type Snapshot = {
	isolateId?: string;
	/** other interpreters resident in this isolate, as the residency tag reports them */
	residents?: number;
	residentLinearBytes?: number;
	/** the interpreter's linear memory now; 0 with none resident */
	linearBytes?: number;
	/** the object's own estimate of the isolate: linear, mounted files, index and resident files */
	isolateTotalBytes?: number;
	counters: Partial<Record<(typeof INCARNATION_COUNTERS)[number], number>>;
	demand: DemandEntry[];
	growthEntries?: number;
	limitTally?: Record<string, number>;
	/** the last run that ended in exit(), and the interpreter's linear size just before it was dropped when the object reports one */
	lastExit?: { at: number; linearBytes?: number };
};

function num(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** reads a `/serve-stats` body into a snapshot, leaving absent anything it does not hold */
export function parseSnapshot(stats: unknown): Snapshot {
	const s = (stats !== null && typeof stats === 'object' ? stats : {}) as Record<string, any>;
	const counters: Snapshot['counters'] = {};
	for (const k of INCARNATION_COUNTERS) {
		const v = num(s[k]);
		if (v !== undefined) counters[k] = v;
	}
	const demand: DemandEntry[] = [];
	if (Array.isArray(s.demand)) {
		for (const d of s.demand) {
			const before = num(d?.before);
			const after = num(d?.after);
			if (before === undefined || after === undefined) continue;
			demand.push({
				path: String(d.path ?? ''),
				method: String(d.method ?? ''),
				before,
				after,
				...(d.reused === true ? { reused: true } : {})
			});
		}
	}
	const out: Snapshot = { counters, demand };
	if (typeof s.isolate?.id === 'string') out.isolateId = s.isolate.id;
	const residents = num(s.isolate?.interpreters);
	if (residents !== undefined) out.residents = residents;
	const residentLinear = num(s.isolate?.linearBytes);
	if (residentLinear !== undefined) out.residentLinearBytes = residentLinear;
	const linear = num(s.isolateBytes?.linear);
	if (linear !== undefined) out.linearBytes = linear;
	const total = num(s.isolateBytes?.total);
	if (total !== undefined) out.isolateTotalBytes = total;
	if (Array.isArray(s.growth)) out.growthEntries = s.growth.length;
	const exitAt = num(s.lastExit?.at);
	if (exitAt !== undefined) {
		const linear = num(s.lastExit?.linear);
		out.lastExit = { at: exitAt, ...(linear === undefined ? {} : { linearBytes: linear }) };
	}
	if (s.limits?.tally !== null && typeof s.limits?.tally === 'object') {
		out.limitTally = { ...s.limits.tally };
	}
	return out;
}

/**
 * The demand entries added between two reads of the ring. The log keeps its last 60 entries, so the
 * overlap is found by sliding; `ambiguous` is set when no overlap exists, which means the ring may
 * have turned over and the entries cannot be told from older ones.
 */
export function newDemand(
	before: readonly DemandEntry[],
	after: readonly DemandEntry[]
): { entries: DemandEntry[]; ambiguous: boolean } {
	const same = (a: DemandEntry, b: DemandEntry) => JSON.stringify(a) === JSON.stringify(b);
	for (let s = 0; s < before.length; s++) {
		const tail = before.slice(s);
		if (tail.length > after.length) continue;
		if (tail.every((e, k) => same(e, after[k] as DemandEntry))) {
			return { entries: after.slice(tail.length), ambiguous: false };
		}
	}
	return { entries: [...after], ambiguous: before.length > 0 };
}

// #endregion

// #region the classifier

/** what one drive's request did, as the driver saw it */
export type DriveFacts = {
	/** the first request's status; 0 when the connection failed */
	status: number;
	/** the transport error message when status is 0 */
	error?: string;
	/** the body of a 5xx answer, cut to the part a classifier needs */
	failureText?: string;
};

/** a drive's verdict from the recorded facts */
export type Verdict = {
	failed: boolean;
	/** true, false, or undefined when the facts cannot say */
	incarnationChanged: boolean | undefined;
	memoryMessage: boolean;
	reasons: string[];
};

/** the platform's wording for an object it reset, in a response or an error */
export const RESET_TEXT = /caused object to be reset|durableObjectReset|Network connection lost/i;

/**
 * Whether a drive failed. A drive fails when the incarnation changed during or right after the
 * route, or when a response carried the isolate memory-limit message. The message is read only from
 * a failed answer (5xx or no answer), because an ordinary admin page can print the words "memory
 * limit" in a status table.
 */
export function classifyDrive(
	before: Snapshot,
	after: Snapshot | undefined,
	facts: DriveFacts
): Verdict {
	const reasons: string[] = [];
	const failedAnswer = facts.status === 0 || facts.status >= 500;
	const text = `${facts.error ?? ''} ${facts.failureText ?? ''}`;
	const memoryMessage = failedAnswer && classifyLimit(text.trim()) === 'memory-limit';
	if (memoryMessage) reasons.push('a response carries the memory-limit message');
	let changed: boolean | undefined;
	if (failedAnswer && RESET_TEXT.test(text)) {
		changed = true;
		reasons.push('a failed answer names a reset');
	}
	if (after !== undefined) {
		let comparable = false;
		if (before.isolateId !== undefined && after.isolateId !== undefined) {
			comparable = true;
			if (before.isolateId !== after.isolateId) {
				changed = true;
				reasons.push('the isolate id changed');
			}
		}
		for (const k of INCARNATION_COUNTERS) {
			const a = before.counters[k];
			const b = after.counters[k];
			if (a === undefined || b === undefined) continue;
			comparable = true;
			if (b < a) {
				changed = true;
				reasons.push(`${k} fell from ${a} to ${b}`);
			}
		}
		if (changed === undefined && comparable) changed = false;
	}
	return {
		failed: changed === true || memoryMessage,
		incarnationChanged: changed,
		memoryMessage,
		reasons
	};
}

// #endregion

// #region statistics

/** n, min, p50 (the median) and max of a sample */
export type Spread = { n: number; min: number; p50: number; max: number };

/** the spread of a sample, or undefined when it is empty */
export function spreadOf(values: readonly number[]): Spread | undefined {
	if (values.length === 0) return undefined;
	const s = [...values].sort((a, b) => a - b);
	const mid = s.length >> 1;
	const p50 =
		s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
	return { n: s.length, min: s[0] as number, p50, max: s[s.length - 1] as number };
}

/** one drive of one route, with everything the table reads */
export type Drive = {
	route: string;
	i: number;
	tag: string;
	status: number;
	/** the status after one followed redirect, when the route follows one */
	finalStatus?: number;
	requests: number;
	startedAt: number;
	endedAt: number;
	/** whether the interpreter was dropped just before the route; false means none was resident */
	recycled?: boolean;
	before: Snapshot;
	after?: Snapshot;
	verdict: Verdict;
	/** the highest linear size the route reached, in bytes, and where it was read */
	peakBytes?: number;
	peakFrom?: PeakSource;
	demandAmbiguous?: boolean;
	/** whether the boot reused a dropped interpreter's memory, so the size is a floor set by that memory */
	peakReused?: boolean;
	/** the `ok` field of a JSON reply, for the owner routes that answer one */
	replyOk?: boolean;
	/** the object's estimate of the whole isolate after the route */
	isolateTotalBytes?: number;
	meterBytes?: number;
	meterShared?: boolean;
	cpuMs?: number;
	note?: string;
};

/** the demand entries the census's own stats and recycle reads leave behind; they are not the route */
export const OWNER_READ_PATHS = /^\/(__)?(serve-stats|recycle)\b/;

/** where a drive's linear peak was read: the demand log, the last exit() record, or the resident interpreter */
export type PeakSource = 'demand' | 'exit' | 'resident';

/**
 * The linear size a drive reached. Linear memory only grows while one interpreter lives, so a
 * demand entry's `after` is that request's size. A request that ended in exit() drops its
 * interpreter before the demand record is taken, so the object's exit record stands in when it
 * carries a size. A route outside the serve path (an owner route) has no entry, and the resident
 * interpreter's size after the route stands in only when none was resident before.
 */
export function peakOf(
	before: Snapshot,
	after: Snapshot | undefined
): { bytes: number; from: PeakSource; ambiguous: boolean; reused?: boolean } | undefined {
	if (after === undefined) return undefined;
	const added = newDemand(before.demand, after.demand);
	const routed = added.entries.filter(
		(e) => e.method !== 'ALARM' && !OWNER_READ_PATHS.test(e.path)
	);
	if (routed.length > 0 && !added.ambiguous) {
		return {
			bytes: Math.max(...routed.map((e) => e.after)),
			from: 'demand',
			ambiguous: false,
			reused: routed.some((e) => e.reused === true)
		};
	}
	const exitedBefore = before.counters.exitedRuns;
	const exitedAfter = after.counters.exitedRuns;
	const freshExit =
		exitedBefore !== undefined && exitedAfter !== undefined
			? exitedAfter > exitedBefore
			: after.lastExit?.at !== before.lastExit?.at;
	if (freshExit && (after.lastExit?.linearBytes ?? 0) > 0) {
		return {
			bytes: after.lastExit?.linearBytes as number,
			from: 'exit',
			ambiguous: added.ambiguous
		};
	}
	if ((before.linearBytes ?? 0) === 0 && (after.linearBytes ?? 0) > 0) {
		return { bytes: after.linearBytes as number, from: 'resident', ambiguous: added.ambiguous };
	}
	return undefined;
}

/** what a route's drives add up to */
export type RouteSummary = {
	route: string;
	label: string;
	drives: number;
	skipped?: string;
	peak?: Spread;
	peakFrom: Record<PeakSource, number>;
	noPeak: number;
	/** drives whose boot reused a dropped memory */
	reusedBoots: number;
	/** drives whose JSON reply said ok was false */
	replyNotOk: number;
	isolateTotal?: Spread;
	incarnationChanged: number;
	incarnationUnknown: number;
	memoryMessages: number;
	failed: number;
	meter?: Spread;
	meterMissing: number;
	meterShared: number;
	cpu?: Spread;
	statuses: Record<string, number>;
};

/** folds one route's drives into a summary; a drive with no reading counts in `noPeak` and never as zero */
export function summariseRoute(
	route: string,
	label: string,
	drives: readonly Drive[]
): RouteSummary {
	const peaks = drives
		.filter((d) => d.peakBytes !== undefined)
		.map((d) => (d.peakBytes as number) / MIB);
	const totals = drives
		.filter((d) => d.isolateTotalBytes !== undefined)
		.map((d) => (d.isolateTotalBytes as number) / MIB);
	const meters = drives
		.filter((d) => d.meterBytes !== undefined)
		.map((d) => (d.meterBytes as number) / MIB);
	const cpus = drives.filter((d) => d.cpuMs !== undefined).map((d) => d.cpuMs as number);
	const statuses: Record<string, number> = {};
	for (const d of drives) statuses[String(d.status)] = (statuses[String(d.status)] ?? 0) + 1;
	const out: RouteSummary = {
		route,
		label,
		drives: drives.length,
		peakFrom: {
			demand: drives.filter((d) => d.peakFrom === 'demand').length,
			exit: drives.filter((d) => d.peakFrom === 'exit').length,
			resident: drives.filter((d) => d.peakFrom === 'resident').length
		},
		noPeak: drives.length - peaks.length,
		reusedBoots: drives.filter((d) => d.peakReused === true).length,
		replyNotOk: drives.filter((d) => d.replyOk === false).length,
		incarnationChanged: drives.filter((d) => d.verdict.incarnationChanged === true).length,
		incarnationUnknown: drives.filter((d) => d.verdict.incarnationChanged === undefined).length,
		memoryMessages: drives.filter((d) => d.verdict.memoryMessage).length,
		failed: drives.filter((d) => d.verdict.failed).length,
		meterMissing: drives.filter((d) => d.meterBytes === undefined).length,
		meterShared: drives.filter((d) => d.meterShared === true).length,
		statuses
	};
	const p = spreadOf(peaks);
	if (p) out.peak = p;
	const t = spreadOf(totals);
	if (t) out.isolateTotal = t;
	const m = spreadOf(meters);
	if (m) out.meter = m;
	const c = spreadOf(cpus);
	if (c) out.cpu = c;
	return out;
}

/** the counts and shares across the driven routes (each route is one pair for this site) */
export type Shares = {
	pairs: number;
	/** pairs with at least one failed drive */
	failedPairs: number;
	/** pairs whose highest meter reading is at or above the line */
	atOrAboveLine: number;
	/** pairs whose highest meter reading is below the line and within the margin of it */
	withinMargin: number | undefined;
	/** pairs with no meter reading at all, which no share can place */
	noMeter: number;
};

/** the arithmetic over route summaries; `withinMargin` is undefined without a margin */
export function sharesOf(
	routes: readonly RouteSummary[],
	lineMib = LINE_MIB,
	marginMib?: number
): Shares {
	const driven = routes.filter((r) => r.skipped === undefined && r.drives > 0);
	const topMeter = (r: RouteSummary) => r.meter?.max;
	return {
		pairs: driven.length,
		failedPairs: driven.filter((r) => r.failed > 0).length,
		atOrAboveLine: driven.filter((r) => (topMeter(r) ?? -Infinity) >= lineMib).length,
		withinMargin:
			marginMib === undefined
				? undefined
				: driven.filter((r) => {
						const m = topMeter(r);
						return m !== undefined && m < lineMib && m >= lineMib - marginMib;
					}).length,
		noMeter: driven.filter((r) => topMeter(r) === undefined).length
	};
}

// #endregion

// #region the table

function cell(s: Spread | undefined, digits = 1): string {
	if (s === undefined) return '-';
	const f = (v: number) => v.toFixed(digits);
	return `${f(s.min)}/${f(s.p50)}/${f(s.max)}`;
}

/** the table, one row per route; an empty cell is `-` and its count sits in the next column */
export function formatTable(rows: readonly RouteSummary[]): string[] {
	const head = [
		'route',
		'n',
		'linear MiB min/p50/max',
		'read from demand/exit/resident',
		'no peak',
		'reused memory',
		'reply not ok',
		'isolate est MiB min/p50/max',
		'incarnation changed/unknown',
		'memory msg',
		'failed',
		'meter MiB min/p50/max',
		'meter missing',
		'cpuTime ms min/p50/max',
		'statuses'
	];
	const lines = [head.join(' | ')];
	for (const r of rows) {
		if (r.skipped !== undefined) {
			lines.push(`${r.route} | 0 | skipped: ${r.skipped}`);
			continue;
		}
		lines.push(
			[
				r.route,
				r.drives,
				cell(r.peak),
				`${r.peakFrom.demand}/${r.peakFrom.exit}/${r.peakFrom.resident}`,
				r.noPeak,
				r.reusedBoots,
				r.replyNotOk,
				cell(r.isolateTotal),
				`${r.incarnationChanged}/${r.incarnationUnknown}`,
				r.memoryMessages,
				r.failed,
				cell(r.meter),
				r.meterMissing,
				cell(r.cpu, 0),
				Object.entries(r.statuses)
					.map(([k, v]) => `${k}x${v}`)
					.join(',')
			].join(' | ')
		);
	}
	return lines;
}

/** the share lines; with no margin or no warn-share the line says what is missing and prints no share */
export function formatShares(
	s: Shares,
	opts: { lineMib: number; marginMib?: number; warnShare?: number }
): string[] {
	const lines = [
		`pairs driven: ${s.pairs}; pairs with a failed drive: ${s.failedPairs}; pairs with no meter reading: ${s.noMeter}`,
		`pairs whose highest meter reading is at or above ${opts.lineMib} MiB: ${s.atOrAboveLine}`
	];
	if (opts.marginMib === undefined) {
		lines.push('--margin-mib not given: no within-margin count and no share is printed');
		return lines;
	}
	lines.push(
		`pairs whose highest meter reading is within ${opts.marginMib} MiB below ${opts.lineMib}: ${s.withinMargin}`
	);
	if (opts.warnShare === undefined) {
		lines.push('--warn-share not given: no comparison is printed');
		return lines;
	}
	if (s.pairs === 0) {
		lines.push('no pair was driven: no share');
		return lines;
	}
	if (s.noMeter > 0) {
		lines.push(
			`${s.noMeter} of ${s.pairs} pairs have no meter reading, so the share below counts them as not over (a floor)`
		);
	}
	const share = ((s.atOrAboveLine + (s.withinMargin ?? 0)) / s.pairs) * 100;
	lines.push(
		`arithmetic only: (${s.atOrAboveLine} + ${s.withinMargin}) / ${s.pairs} = ${share.toFixed(1)}%; --warn-share ${opts.warnShare}% ; share >= warn-share is ${share >= opts.warnShare}`
	);
	return lines;
}

// #endregion

// #region options

/** the parsed command line */
export type CensusOptions = {
	cms: 'wordpress' | 'drupal';
	mode: 'dry' | 'local' | 'base' | 'deployed';
	base: string;
	n: number;
	cold: 'recycle' | 'none';
	routes: string[] | undefined;
	port: number;
	lineMib: number;
	marginMib: number | undefined;
	warnShare: number | undefined;
	account: 'student' | 'paid' | undefined;
	name: string;
	modules: string[];
	claim: boolean;
	jsonOut: string | undefined;
	ingestMin: number | undefined;
};

/** the core modules a Drupal module-enable drive takes in turn, one per drive */
export const DEFAULT_MODULES = [
	'contact',
	'tour',
	'history',
	'datetime_range',
	'config_translation'
];

/** a fresh `cfw-wp-<8 hex>` name */
export function freshName(cms: 'wordpress' | 'drupal'): string {
	const b = crypto.getRandomValues(new Uint8Array(4));
	const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
	return `${cms === 'wordpress' ? 'cfw-wp' : 'cfw-headlines'}-${hex}`;
}

function intFlag(name: string, v: string, min: number, max: number): number {
	const x = Number(v);
	if (!Number.isInteger(x) || x < min || x > max)
		throw new Error(`${name} needs an integer from ${min} to ${max}`);
	return x;
}

/** parses the command line, refusing anything unknown; margin and warn-share have no default */
export function parseCensusOptions(argv: readonly string[]): CensusOptions {
	const o: CensusOptions = {
		cms: 'wordpress',
		mode: 'dry',
		base: 'http://localhost:8787',
		n: 3,
		cold: 'recycle',
		routes: undefined,
		port: 8796,
		lineMib: LINE_MIB,
		marginMib: undefined,
		warnShare: undefined,
		account: undefined,
		name: '',
		modules: DEFAULT_MODULES,
		claim: false,
		jsonOut: undefined,
		ingestMin: undefined
	};
	let cms: string | undefined;
	const modes = new Set<string>();
	let baseGiven = false;
	for (const a of argv) {
		const eq = a.indexOf('=');
		const key = eq === -1 ? a : a.slice(0, eq);
		const val = eq === -1 ? '' : a.slice(eq + 1);
		switch (key) {
			case '--cms':
				cms = val;
				break;
			case '--dry':
			case '--local':
			case '--deployed':
				modes.add(key.slice(2));
				break;
			case '--base':
				o.base = val.replace(/\/+$/, '');
				baseGiven = true;
				break;
			case '--n':
				o.n = intFlag('--n', val, 1, 50);
				break;
			case '--cold':
				if (val !== 'recycle' && val !== 'none')
					throw new Error('--cold takes recycle or none');
				o.cold = val;
				break;
			case '--routes':
				o.routes = val.split(',').filter((x) => x !== '');
				break;
			case '--port':
				o.port = intFlag('--port', val, 1024, 65000);
				break;
			case '--line-mib':
				o.lineMib = intFlag('--line-mib', val, 1, 4096);
				break;
			case '--margin-mib':
				o.marginMib = intFlag('--margin-mib', val, 0, 4096);
				break;
			case '--warn-share':
				o.warnShare = intFlag('--warn-share', val, 0, 100);
				break;
			case '--account':
				if (val !== 'student' && val !== 'paid')
					throw new Error('--account takes student or paid');
				o.account = val;
				break;
			case '--name':
				o.name = val;
				break;
			case '--modules':
				o.modules = val.split(',').filter((x) => x !== '');
				break;
			case '--claim':
				o.claim = true;
				break;
			case '--json-out':
				if (val === '') throw new Error('--json-out needs a path');
				o.jsonOut = val;
				break;
			case '--ingest-min':
				o.ingestMin = intFlag('--ingest-min', val, 1, 60);
				break;
			default:
				throw new Error(`unknown argument ${key}`);
		}
	}
	if (cms !== 'wordpress' && cms !== 'drupal') throw new Error('--cms takes wordpress or drupal');
	o.cms = cms;
	if (modes.size > 1 && !(modes.size === 2 && modes.has('dry')))
		throw new Error('give one of --dry, --local, --deployed');
	if (modes.has('dry')) o.mode = 'dry';
	else if (modes.has('local')) o.mode = 'local';
	else if (modes.has('deployed')) o.mode = 'deployed';
	else if (baseGiven) o.mode = 'base';
	else throw new Error('say one of --dry, --local, --deployed or --base=<url>');
	if (baseGiven && (modes.has('local') || modes.has('deployed'))) {
		throw new Error(
			'--base names an existing site; it does not combine with --local or --deployed'
		);
	}
	if (o.mode === 'deployed' || (modes.has('dry') && modes.has('deployed'))) {
		if (o.account === undefined)
			throw new Error('--deployed needs --account=student or --account=paid');
	}
	if (
		o.account !== undefined &&
		o.mode !== 'deployed' &&
		!(modes.has('dry') && modes.has('deployed'))
	) {
		throw new Error('--account belongs to --deployed');
	}
	if (o.name === '') o.name = freshName(o.cms);
	if (o.mode === 'local') o.claim = true;
	if (o.mode === 'deployed') o.claim = true;
	return o;
}

// #endregion

// #region sessions and requests

/** one response as the driver keeps it */
export type Reply = {
	status: number;
	headers: Headers | undefined;
	text: string;
	error?: string;
	ms: number;
};

/** what the routes need while they run: the site, the credentials and the fetch */
export type Session = {
	base: string;
	cms: 'wordpress' | 'drupal';
	doFetch: typeof fetch;
	sleep: (ms: number) => Promise<void>;
	log: (s: string) => void;
	jar: CookieJar;
	owner: string;
	nonce: string;
	adminUser: string;
	adminPass: string;
	/** modules not yet taken by a drive */
	modules: string[];
};

/** sends one request; a connection failure is a reply with status 0 and the message, never a throw */
export async function send(
	s: Session,
	method: string,
	path: string,
	opts: { cookie?: boolean; headers?: Record<string, string>; body?: string | Uint8Array } = {}
): Promise<Reply> {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), DRIVE_TIMEOUT_MS);
	const t0 = Date.now();
	try {
		const cookie = opts.cookie ? s.jar.header() : undefined;
		const res = await s.doFetch(`${s.base}${path}`, {
			method,
			redirect: 'manual',
			signal: ctl.signal,
			headers: {
				accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				...(cookie ? { cookie } : {}),
				...opts.headers
			},
			...(opts.body === undefined ? {} : { body: opts.body as BodyInit })
		});
		const text = await res.text();
		if (opts.cookie) s.jar.take(res.headers.getSetCookie());
		return { status: res.status, headers: res.headers, text, ms: Date.now() - t0 };
	} catch (e) {
		return {
			status: 0,
			headers: undefined,
			text: '',
			error: (e as Error).message,
			ms: Date.now() - t0
		};
	} finally {
		clearTimeout(timer);
	}
}

const ownerHeaders = (s: Session): Record<string, string> => ({
	authorization: `Bearer ${s.owner}`
});

/** reads `/serve-stats` with the owner token; undefined when the object does not answer JSON */
export async function readStats(s: Session): Promise<Snapshot | undefined> {
	const r = await send(s, 'GET', '/serve-stats', { headers: ownerHeaders(s) });
	if (r.status !== 200) return undefined;
	try {
		return parseSnapshot(JSON.parse(r.text));
	} catch {
		return undefined;
	}
}

function decode(v: string): string {
	return v
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');
}

/** the hidden inputs of the form with this id attribute, decoded; empty when the form is absent */
export function formFields(html: string, formId: string): Record<string, string> {
	const start = new RegExp(`<form[^>]*\\bid="${formId}"[^>]*>`).exec(html);
	if (!start) return {};
	const rest = html.slice(start.index + start[0].length);
	const end = rest.indexOf('</form>');
	const body = end === -1 ? rest : rest.slice(0, end);
	const out: Record<string, string> = {};
	for (const tag of body.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []) {
		const name = /name="([^"]*)"/.exec(tag)?.[1];
		if (name) out[name] = decode(/value="([^"]*)"/.exec(tag)?.[1] ?? '');
	}
	return out;
}

/** a urlencoded body from fields */
export function encodeForm(fields: Record<string, string>): string {
	return Object.entries(fields)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join('&');
}

/** the first plugin activation link on WordPress's plugins page, as a path, or undefined */
export function activationLink(html: string): string | undefined {
	const m = /href="([^"]*plugins\.php\?action=activate[^"]*)"/.exec(html);
	if (!m) return undefined;
	const href = decode(m[1] as string);
	const at = href.indexOf('/wp-admin/');
	return at === -1 ? `/wp-admin/${href.replace(/^\.?\//, '')}` : href.slice(at);
}

/** a one pixel PNG, for the media upload */
export const TINY_PNG = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=='
	),
	(c) => c.charCodeAt(0)
);

// #endregion

// #region routes

/** a request ready to send, or the reason the route cannot be driven this time */
export type Ready =
	| {
			method: 'GET' | 'POST';
			path: string;
			cookie: boolean;
			headers?: Record<string, string>;
			body?: string | Uint8Array;
			follow?: boolean;
			note?: string;
	  }
	| { skip: string };

/** one route of a census */
export type RouteSpec = {
	id: string;
	label: string;
	cms: 'wordpress' | 'drupal';
	/** why the route cannot be driven yet; a pending route is listed and never driven */
	pending?: string;
	/** builds the request; it may read pages (before the cold step) for tokens it needs */
	prepare: (s: Session, drive: number) => Promise<Ready>;
};

const plain =
	(path: string, cookie = false, extra: Partial<Extract<Ready, { method: string }>> = {}) =>
	async (): Promise<Ready> => ({ method: 'GET', path, cookie, ...extra });

/** the WordPress route set */
export const WORDPRESS_ROUTES: readonly RouteSpec[] = [
	{ id: 'front', label: 'anonymous front page', cms: 'wordpress', prepare: plain('/') },
	{
		id: 'post',
		label: 'a single post (/?p=1, one redirect followed)',
		cms: 'wordpress',
		prepare: plain('/?p=1', false, { follow: true })
	},
	{
		id: 'login-get',
		label: 'GET /wp-login.php',
		cms: 'wordpress',
		prepare: plain('/wp-login.php')
	},
	{
		id: 'login-post',
		label: 'POST /wp-login.php',
		cms: 'wordpress',
		prepare: async (s) => ({
			method: 'POST',
			path: '/wp-login.php',
			cookie: false,
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				cookie: 'wordpress_test_cookie=WP%20Cookie%20check'
			},
			body: loginBody(s.adminUser, s.adminPass, s.base)
		})
	},
	{
		id: 'admin',
		label: '/wp-admin/ dashboard',
		cms: 'wordpress',
		prepare: plain('/wp-admin/', true)
	},
	{
		id: 'post-new',
		label: 'block editor page (post-new.php)',
		cms: 'wordpress',
		prepare: plain('/wp-admin/post-new.php', true)
	},
	{
		id: 'heartbeat',
		label: 'admin-ajax.php heartbeat',
		cms: 'wordpress',
		prepare: async (s) => ({
			method: 'POST',
			path: '/wp-admin/admin-ajax.php',
			cookie: true,
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: encodeForm({
				action: 'heartbeat',
				_nonce: s.nonce,
				interval: '60',
				screen_id: 'dashboard',
				has_focus: 'false'
			})
		})
	},
	{
		id: 'rest-posts',
		label: 'REST posts',
		cms: 'wordpress',
		prepare: plain('/wp-json/wp/v2/posts')
	},
	{
		id: 'rest-me',
		label: 'REST users/me (cookie and nonce)',
		cms: 'wordpress',
		prepare: async (s) => ({
			method: 'GET',
			path: '/wp-json/wp/v2/users/me',
			cookie: true,
			headers: { 'x-wp-nonce': s.nonce }
		})
	},
	{ id: 'cron', label: '/wp-cron.php', cms: 'wordpress', prepare: plain('/wp-cron.php') },
	{
		id: 'plugin-activate',
		label: 'plugin activation through plugins.php',
		cms: 'wordpress',
		prepare: async (s) => {
			const page = await send(s, 'GET', '/wp-admin/plugins.php', { cookie: true });
			const link = activationLink(page.text);
			if (link === undefined) {
				return {
					skip: `plugins.php answered ${page.status} and offered no inactive plugin to activate`
				};
			}
			return { method: 'GET', path: link, cookie: true, follow: true };
		}
	},
	{
		id: 'media-upload',
		label: 'media upload (REST, a one pixel PNG)',
		cms: 'wordpress',
		prepare: async (s, i) => ({
			method: 'POST',
			path: '/wp-json/wp/v2/media',
			cookie: true,
			headers: {
				'content-type': 'image/png',
				'content-disposition': `attachment; filename="census-${i}.png"`,
				'x-wp-nonce': s.nonce
			},
			body: TINY_PNG
		})
	}
];

/** a Drupal admin form posted with one of its buttons */
function drupalForm(page: string, formId: string, op: string): RouteSpec['prepare'] {
	return async (s) => {
		const got = await send(s, 'GET', page, { cookie: true });
		const fields = formFields(got.text, formId);
		if (!('form_build_id' in fields)) {
			return { skip: `${page} answered ${got.status} and held no ${formId} form` };
		}
		return {
			method: 'POST',
			path: page,
			cookie: true,
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: encodeForm({ ...fields, op })
		};
	};
}

/** the Drupal route set */
export const DRUPAL_ROUTES: readonly RouteSpec[] = [
	{ id: 'front', label: 'anonymous front page', cms: 'drupal', prepare: plain('/') },
	{
		id: 'auth-front',
		label: 'authenticated front page',
		cms: 'drupal',
		prepare: plain('/', true)
	},
	{
		id: 'admin',
		label: 'cold admin (/admin/content)',
		cms: 'drupal',
		prepare: plain('/admin/content', true)
	},
	{
		id: 'flush',
		label: 'flush all caches (performance form)',
		cms: 'drupal',
		prepare: drupalForm(
			'/admin/config/development/performance',
			'system-performance-settings',
			'Clear all caches'
		)
	},
	{
		id: 'cron',
		label: 'run cron (cron form)',
		cms: 'drupal',
		prepare: drupalForm('/admin/config/system/cron', 'system-cron-settings', 'Run cron')
	},
	{
		id: 'module-enable',
		label: 'module enable (/enable, one module per drive)',
		cms: 'drupal',
		prepare: async (s) => {
			const next = s.modules.shift();
			if (next === undefined) return { skip: 'no module left in --modules for this drive' };
			return {
				method: 'GET',
				path: `/enable?module=${encodeURIComponent(next)}`,
				cookie: false,
				headers: ownerHeaders(s),
				note: next
			};
		}
	},
	{
		id: 'update',
		label: 'database update',
		cms: 'drupal',
		pending:
			'a fresh site has no update pending, so a drive would run a no-op and read a low peak; needs a site with an update owed',
		prepare: async () => ({ skip: 'pending' })
	}
];

/** the routes of one CMS, narrowed by `--routes`; an unknown id is an error */
export function routesFor(cms: 'wordpress' | 'drupal', only?: readonly string[]): RouteSpec[] {
	const all = cms === 'wordpress' ? WORDPRESS_ROUTES : DRUPAL_ROUTES;
	if (only === undefined) return [...all];
	const known = new Set(all.map((r) => r.id));
	for (const id of only)
		if (!known.has(id)) throw new Error(`unknown route ${id}; known: ${[...known].join(', ')}`);
	return all.filter((r) => only.includes(r.id));
}

// #endregion

// #region the driver

/** the tag of one drive, which joins it to its invocations */
export function tagFor(name: string, route: string, i: number): string {
	return `${name}-${route}-${i}`;
}

/** what a census run needs from the site before the first drive */
export async function prepareSession(
	s: Session,
	opts: { claim: boolean }
): Promise<{ notes: string[] }> {
	const notes: string[] = [];
	if (opts.claim) {
		if (s.cms === 'wordpress') {
			let ready = false;
			let last = 0;
			for (let i = 0; i < 40 && !ready; i++) {
				const r = await send(s, 'GET', '/wp-login.php');
				ready = r.status === 200;
				last = r.status;
				if (!ready) await s.sleep(2000);
			}
			if (!ready)
				throw new Error(
					`the site never answered 200 on /wp-login.php; the last was ${last}`
				);
		} else {
			let done = false;
			for (let i = 0; i < 200 && !done; i++) {
				const r = await send(s, 'GET', '/migrate?chunks=10');
				if (r.status === 0) {
					notes.push(`migrate call ${i} lost its connection: ${r.error}`);
					await s.sleep(500);
					continue;
				}
				try {
					const body = JSON.parse(r.text) as { done?: boolean | null; ok?: boolean };
					if (body.done === true) done = true;
					else if (body.ok === false)
						throw new Error(`migration refused: ${r.text.slice(0, 200)}`);
				} catch (e) {
					if ((e as Error).message.startsWith('migration refused')) throw e;
					throw new Error(`migrate answered ${r.status} and not JSON`);
				}
			}
			if (!done) throw new Error('the migration did not finish in 200 calls');
		}
		s.adminUser = s.cms === 'wordpress' ? 'rigadmin' : 'admin';
		s.adminPass = `pw-${crypto.randomUUID()}`;
		const claim = await send(
			s,
			'POST',
			s.cms === 'wordpress' ? '/firstrun' : '/firstrun?force=1',
			{
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(
					s.cms === 'wordpress'
						? {
								adminName: s.adminUser,
								adminMail: 'rig@example.test',
								adminPass: s.adminPass,
								siteName: 'Census Site'
							}
						: {
								siteName: 'Census Site',
								adminName: s.adminUser,
								adminMail: 'admin@example.invalid',
								adminPass: s.adminPass,
								timezone: 'UTC'
							}
				)
			}
		);
		try {
			s.owner = String((JSON.parse(claim.text) as { ownerToken?: unknown }).ownerToken ?? '');
		} catch {
			s.owner = '';
		}
		if (claim.status !== 200 || s.owner === '') {
			throw new Error(`the claim answered ${claim.status}; no owner token came back`);
		}
		s.log('claimed; owner token received (not printed)');
	}
	if (s.owner === '')
		throw new Error('no owner token: set CENSUS_OWNER_TOKEN or let the run claim');
	if (s.adminPass === '')
		throw new Error('no admin password: set CENSUS_ADMIN_PASS or let the run claim');
	await login(s, notes);
	return { notes };
}

async function login(s: Session, notes: string[]): Promise<void> {
	if (s.cms === 'wordpress') {
		const r = await send(s, 'POST', '/wp-login.php', {
			cookie: true,
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				cookie: 'wordpress_test_cookie=WP%20Cookie%20check'
			},
			body: loginBody(s.adminUser, s.adminPass, s.base)
		});
		if (s.jar.size === 0) throw new Error(`login answered ${r.status} and set no cookie`);
		const n = await send(s, 'GET', '/wp-admin/admin-ajax.php?action=rest-nonce', {
			cookie: true
		});
		s.nonce = n.text.trim();
		if (n.status !== 200 || s.nonce === '')
			notes.push(`rest-nonce answered ${n.status}; cookie-nonce routes will run without one`);
		return;
	}
	const page = await send(s, 'GET', '/user/login');
	const fields = formFields(page.text, 'user-login-form');
	if (!('form_build_id' in fields))
		throw new Error(`/user/login answered ${page.status} with no login form`);
	const r = await send(s, 'POST', '/user/login', {
		cookie: true,
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: encodeForm({ ...fields, name: s.adminUser, pass: s.adminPass, op: 'Log in' })
	});
	if (s.jar.size === 0) throw new Error(`login answered ${r.status} and set no cookie`);
}

/** options for one census run */
export type RunOptions = {
	n: number;
	cold: 'recycle' | 'none';
	name: string;
	gapMs: number;
};

/** drives one route n times from the cold step the options name; never throws on a failed drive */
export async function driveRoute(s: Session, route: RouteSpec, o: RunOptions): Promise<Drive[]> {
	const drives: Drive[] = [];
	for (let i = 0; i < o.n; i++) {
		const tag = tagFor(o.name, route.id, i);
		const ready = await route.prepare(s, i);
		if ('skip' in ready) {
			s.log(`${route.id} drive ${i}: skipped, ${ready.skip}`);
			drives.push(skipped(route.id, i, tag, ready.skip));
			continue;
		}
		let recycled: boolean | undefined;
		if (o.cold === 'recycle') {
			const r = await send(s, 'POST', '/recycle', { headers: ownerHeaders(s) });
			try {
				recycled = (JSON.parse(r.text) as { recycled?: boolean }).recycled === true;
			} catch {
				recycled = undefined;
			}
		}
		const before = (await readStats(s)) ?? { counters: {}, demand: [] };
		const startedAt = Date.now();
		const headers = { ...ready.headers };
		let r = await send(s, ready.method, withTag(ready.path, tag), {
			cookie: ready.cookie,
			headers,
			...(ready.body === undefined ? {} : { body: ready.body })
		});
		let requests = 1;
		let finalStatus: number | undefined;
		if (ready.follow && r.status >= 300 && r.status < 400) {
			const loc = r.headers?.get('location');
			if (loc) {
				const target = loc.startsWith('http')
					? new URL(loc).pathname + new URL(loc).search
					: loc;
				const next = await send(s, 'GET', target, { cookie: ready.cookie });
				requests = 2;
				finalStatus = next.status;
				if (next.status >= 500 || next.status === 0) r = next;
			}
		}
		const endedAt = Date.now();
		let after: Snapshot | undefined;
		for (let t = 0; t < AFTER_READ_TRIES && after === undefined; t++) {
			after = await readStats(s);
			if (after === undefined) await s.sleep(AFTER_READ_WAIT_MS);
		}
		const facts: DriveFacts = {
			status: r.status,
			...(r.error === undefined ? {} : { error: r.error }),
			...(r.status >= 500 ? { failureText: r.text.slice(0, 600) } : {})
		};
		const verdict = classifyDrive(before, after, facts);
		const peak = peakOf(before, after);
		let replyOk: boolean | undefined;
		if (r.text.startsWith('{')) {
			try {
				const ok = (JSON.parse(r.text) as { ok?: unknown }).ok;
				if (typeof ok === 'boolean') replyOk = ok;
			} catch {
				replyOk = undefined;
			}
		}
		const d: Drive = {
			route: route.id,
			i,
			tag,
			status: r.status,
			requests,
			startedAt,
			endedAt,
			before,
			verdict,
			...(finalStatus === undefined ? {} : { finalStatus }),
			...(recycled === undefined ? {} : { recycled }),
			...(after === undefined ? {} : { after }),
			...(after?.isolateTotalBytes === undefined || after.isolateTotalBytes === 0
				? {}
				: { isolateTotalBytes: after.isolateTotalBytes }),
			...(peak === undefined ? {} : { peakBytes: peak.bytes, peakFrom: peak.from }),
			...(peak?.ambiguous ? { demandAmbiguous: true } : {}),
			...(peak?.reused ? { peakReused: true } : {}),
			...(replyOk === undefined ? {} : { replyOk }),
			...(ready.note === undefined ? {} : { note: ready.note })
		};
		drives.push(d);
		s.log(
			`${route.id} drive ${i}: status ${d.status}, peak ${peak === undefined ? '-' : (peak.bytes / MIB).toFixed(1) + ' MiB'}, incarnation ${verdict.incarnationChanged === undefined ? 'unknown' : verdict.incarnationChanged ? 'changed' : 'same'}`
		);
		if (o.gapMs > 0) await s.sleep(o.gapMs);
	}
	return drives;
}

function skipped(route: string, i: number, tag: string, why: string): Drive {
	return {
		route,
		i,
		tag,
		status: -1,
		requests: 0,
		startedAt: 0,
		endedAt: 0,
		before: { counters: {}, demand: [] },
		verdict: {
			failed: false,
			incarnationChanged: undefined,
			memoryMessage: false,
			reasons: []
		},
		note: `skipped: ${why}`
	};
}

/** the drives that ran, with skipped ones removed and their reasons returned */
export function splitSkipped(drives: readonly Drive[]): { ran: Drive[]; skippedReasons: string[] } {
	return {
		ran: drives.filter((d) => d.status !== -1),
		skippedReasons: drives.filter((d) => d.status === -1).map((d) => d.note ?? 'skipped')
	};
}

/** a new session for a site; the owner token and admin password come from the environment unless the run claims */
export function newSession(
	base: string,
	cms: 'wordpress' | 'drupal',
	env: Record<string, string | undefined>,
	modules: readonly string[],
	doFetch: typeof fetch = fetch,
	log: (s: string) => void = (s) => console.log(s)
): Session {
	return {
		base,
		cms,
		doFetch,
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		log,
		jar: new CookieJar(),
		owner: env.CENSUS_OWNER_TOKEN ?? '',
		nonce: '',
		adminUser: env.CENSUS_ADMIN_USER ?? 'admin',
		adminPass: env.CENSUS_ADMIN_PASS ?? '',
		modules: [...modules]
	};
}

/** runs every route; a pending route is listed with its reason and never driven */
export async function runCensus(
	s: Session,
	routes: readonly RouteSpec[],
	o: RunOptions
): Promise<{ summaries: RouteSummary[]; drives: Drive[]; notes: string[] }> {
	const { notes } = await prepareSession(s, { claim: s.owner === '' });
	const summaries: RouteSummary[] = [];
	const all: Drive[] = [];
	for (const route of routes) {
		if (route.pending !== undefined) {
			summaries.push({
				...summariseRoute(route.id, route.label, []),
				skipped: route.pending
			});
			continue;
		}
		const drives = await driveRoute(s, route, o);
		const { ran, skippedReasons } = splitSkipped(drives);
		const summary = summariseRoute(route.id, route.label, ran);
		if (ran.length === 0) summary.skipped = skippedReasons[0] ?? 'no drive ran';
		else if (skippedReasons.length > 0)
			notes.push(
				`${route.id}: ${skippedReasons.length} of ${o.n} drives skipped: ${skippedReasons[0]}`
			);
		summaries.push(summary);
		all.push(...ran);
	}
	return { summaries, drives: all, notes };
}

// #endregion

// #region the platform meter and cpuTime

/** one row of the platform's per-isolate meter */
export type MeterRow = { at: number; maxMemoryBytes: number; exceededMemoryErrors: number };

/** reads `durableObjectsPeriodicGroups` rows out of a GraphQL response; a missing or malformed body is no rows */
export function parseMeterRows(body: unknown): MeterRow[] {
	const groups = (body as any)?.data?.viewer?.accounts?.[0]?.durableObjectsPeriodicGroups;
	if (!Array.isArray(groups)) return [];
	const out: MeterRow[] = [];
	for (const g of groups) {
		const at = Date.parse(String(g?.dimensions?.datetime ?? ''));
		const mem = g?.max?.memoryUsageBytes;
		if (!Number.isFinite(at) || typeof mem !== 'number') continue;
		out.push({
			at,
			maxMemoryBytes: mem,
			exceededMemoryErrors: Number(g?.sum?.exceededMemoryErrors ?? 0)
		});
	}
	return out.sort((a, b) => a.at - b.at);
}

/**
 * Gives each drive the meter row that overlaps it. A row covers the minute that starts at its
 * datetime. A drive that overlaps no row has a missing row; a drive that overlaps two or more takes
 * their highest value and is marked shared, since the row cannot be told apart from a neighbour
 * drive's. Drives are returned changed in a copy.
 */
export function attributeMeter(drives: readonly Drive[], rows: readonly MeterRow[]): Drive[] {
	return drives.map((d) => {
		const hit = rows.filter((r) => r.at <= d.endedAt && r.at + METER_ROW_MS >= d.startedAt);
		if (hit.length === 0) return { ...d };
		const peak = Math.max(...hit.map((r) => r.maxMemoryBytes));
		const neighbours = drives.filter(
			(o) =>
				o !== d && hit.some((r) => r.at <= o.endedAt && r.at + METER_ROW_MS >= o.startedAt)
		);
		return {
			...d,
			meterBytes: peak,
			...(hit.length > 1 || neighbours.length > 0 ? { meterShared: true } : {})
		};
	});
}

/** gives each drive the summed object `cpuTime` of the invocations its tag joins to; none joined leaves it empty */
export function attributeCpu(
	drives: readonly Drive[],
	front: Parameters<typeof joinEvents>[1],
	objects: Parameters<typeof joinEvents>[2]
): Drive[] {
	const records: RequestRecord[] = drives.map((d) => ({
		step: d.route,
		i: d.i,
		tag: d.tag,
		method: 'GET',
		status: d.status,
		bytes: 0,
		startedAt: d.startedAt,
		endedAt: d.endedAt,
		headers: {}
	}));
	const joined = joinEvents(records, front, objects);
	return drives.map((d) => {
		const j = joined.find((x) => x.record.tag === d.tag);
		if (!j || !j.front || j.objects.length === 0) return { ...d };
		return { ...d, cpuMs: j.objects.reduce((a, o) => a + o.cpuMs, 0) };
	});
}

const API = 'https://api.cloudflare.com/client/v4';

/** the GraphQL query for one namespace's meter rows over a window */
export const METER_QUERY = `
	query ($a: String!, $ns: [String!], $from: Time!, $to: Time!) {
		viewer {
			accounts(filter: { accountTag: $a }) {
				durableObjectsPeriodicGroups(
					limit: 1000
					filter: { namespaceId_in: $ns, datetime_geq: $from, datetime_leq: $to }
					orderBy: [datetime_ASC]
				) {
					dimensions { datetime }
					max { memoryUsageBytes }
					sum { exceededMemoryErrors }
				}
			}
		}
	}
`;

async function readMeter(ctx: RunContext, from: number, to: number): Promise<MeterRow[]> {
	const list = await ctx.deps.fetch(
		`${API}/accounts/${ctx.creds.id}/workers/durable_objects/namespaces?per_page=100`,
		{
			headers: { authorization: `Bearer ${ctx.creds.token}` }
		}
	);
	const body: any = await list.json();
	const ns: string[] = (body?.result ?? [])
		.filter((n: any) => String(n?.script ?? '') === ctx.name)
		.map((n: any) => String(n.id));
	if (ns.length === 0) throw new Error(`no namespace of ${ctx.name} in the account listing`);
	const res = await ctx.deps.fetch(`${API}/graphql`, {
		method: 'POST',
		headers: { authorization: `Bearer ${ctx.creds.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			query: METER_QUERY,
			variables: {
				a: ctx.creds.id,
				ns,
				from: new Date(from).toISOString(),
				to: new Date(to).toISOString()
			}
		})
	});
	const meter: any = await res.json();
	if (Array.isArray(meter?.errors) && meter.errors.length > 0)
		throw new Error(`the meter query answered ${JSON.stringify(meter.errors).slice(0, 300)}`);
	return parseMeterRows(meter);
}

// #endregion

// #region the report

/** the JSON record a run writes, with every secret removed by the caller */
export type CensusReport = {
	cms: string;
	mode: string;
	n: number;
	cold: string;
	lineMib: number;
	marginMib?: number;
	warnShare?: number;
	summaries: RouteSummary[];
	drives: Drive[];
	notes: string[];
};

/** prints the table, the shares and the notes */
export function report(r: CensusReport, log: (s: string) => void): void {
	log('');
	log(
		`cms ${r.cms}, mode ${r.mode}, ${r.n} drives per route, cold step ${r.cold}; every figure is per drive and n is shown`
	);
	log(
		"linear = the object's own reading of the interpreter's linear memory, not the platform meter; n below 5 is not a claim"
	);
	for (const l of formatTable(r.summaries)) log(l);
	log('');
	for (const l of formatShares(sharesOf(r.summaries, r.lineMib, r.marginMib), {
		lineMib: r.lineMib,
		...(r.marginMib === undefined ? {} : { marginMib: r.marginMib }),
		...(r.warnShare === undefined ? {} : { warnShare: r.warnShare })
	})) {
		log(l);
	}
	for (const n of r.notes) log(`note: ${n}`);
}

// #endregion

// #region runs

/** the local Drupal config: the tracked one with the build step and the cron trigger removed and its paths made absolute */
export function drupalLocalConfig(root: string, name: string): Record<string, unknown> {
	const cfg = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')) as Record<
		string,
		any
	>;
	delete cfg.build;
	delete cfg.triggers;
	delete cfg.$schema;
	cfg.name = name;
	cfg.main = join(root, cfg.main);
	cfg.vars = { ...cfg.vars, PW_DIAGNOSTICS: '1' };
	cfg.assets = { ...cfg.assets, directory: join(root, cfg.assets.directory) };
	cfg.alias = Object.fromEntries(
		Object.entries(cfg.alias as Record<string, string>).map(([k, v]) => [k, join(root, v)])
	);
	return cfg;
}

/** the Drupal throwaway with interpreter retention left at its shipping default, since the census reads what it does to memory */
export function drupalDeployedConfig(name: string, root: string): Record<string, unknown> {
	const cfg = throwawayConfig(name, root);
	const vars = { ...(cfg.vars as Record<string, string>) };
	delete vars.RETAIN_INTERPRETER;
	return { ...cfg, vars };
}

async function withLocalWrangler<T>(
	root: string,
	config: Record<string, unknown>,
	opts: CensusOptions,
	body: (origin: string) => Promise<T>
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), `route-peaks-${opts.cms}-`));
	const configPath = join(dir, 'wrangler.jsonc');
	writeFileSync(configPath, JSON.stringify(config, null, '\t'));
	const origin = `http://localhost:${opts.port}`;
	const child: ChildProcess = spawn(
		'bunx',
		[
			'wrangler',
			'dev',
			'-c',
			configPath,
			'--port',
			String(opts.port),
			'--inspector-port',
			String(opts.port + 500),
			'--persist-to',
			join(dir, 'state')
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
				await fetch(`${origin}/`);
				break;
			} catch {
				if (Date.now() > deadline) throw new Error('wrangler dev never listened');
				await new Promise((r) => setTimeout(r, 1500));
			}
		}
		return await body(origin);
	} catch (e) {
		console.log(tail);
		throw e;
	} finally {
		await stop();
	}
}

function deployedMeasure(opts: CensusOptions): (ctx: RunContext) => Promise<void> {
	return async (ctx) => {
		const secrets = [ctx.creds.id, ctx.creds.token];
		const log = (s: string) => ctx.deps.log(redact(s, secrets));
		const s = newSession(ctx.base, opts.cms, {}, opts.modules, ctx.deps.fetch, log);
		const routes = routesFor(opts.cms, opts.routes);
		const gap = opts.cold === 'recycle' ? METER_GAP_MS : 0;
		const startedAt = Date.now();
		const run = await runCensus(s, routes, {
			n: opts.n,
			cold: opts.cold,
			name: ctx.name,
			gapMs: gap
		});
		const endedAt = Date.now();
		const ingestMs =
			opts.ingestMin === undefined ? OBSERVABILITY_INGEST_LAG_MS : opts.ingestMin * 60_000;
		log(`waiting ${ingestMs / 60_000} min for ingest`);
		await ctx.deps.sleep(ingestMs);
		let drives = run.drives;
		const notes = [...run.notes];
		try {
			const rows = await readMeter(ctx, startedAt - 120_000, endedAt + 120_000);
			notes.push(
				`meter rows read: ${rows.length}; a drive that overlaps none is counted as a missing row`
			);
			drives = attributeMeter(drives, rows);
		} catch (e) {
			notes.push(
				`the meter read failed: ${(e as Error).message}; every drive's meter cell is empty`
			);
		}
		let objBody: any;
		let frontBody: any;
		try {
			objBody = await queryEventsRaw(ctx, 'durableObject', startedAt - 2000, endedAt + 2000);
			frontBody = await queryEventsRaw(ctx, 'stateless', startedAt - 2000, endedAt + 2000);
			drives = attributeCpu(drives, wpRows(frontBody), wpRows(objBody));
			notes.push(
				'cpuTime is the object fetch invocations joined to a drive by its tag; unchecked against the per-minute dataset'
			);
		} catch (e) {
			notes.push(
				`the events read failed: ${(e as Error).message}; every drive's cpuTime cell is empty`
			);
		}
		const names = new Map<string, Drive[]>();
		for (const d of drives) names.set(d.route, [...(names.get(d.route) ?? []), d]);
		const summaries = run.summaries.map((r) =>
			r.skipped !== undefined ? r : summariseRoute(r.route, r.label, names.get(r.route) ?? [])
		);
		const rep: CensusReport = {
			cms: opts.cms,
			mode: `deployed (${opts.account})`,
			n: opts.n,
			cold: opts.cold,
			lineMib: opts.lineMib,
			...(opts.marginMib === undefined ? {} : { marginMib: opts.marginMib }),
			...(opts.warnShare === undefined ? {} : { warnShare: opts.warnShare }),
			summaries,
			drives,
			notes
		};
		report(rep, log);
		if (ctx.eventsOut) {
			mkdirSync(dirname(resolve(ctx.eventsOut)), { recursive: true });
			writeFileSync(
				ctx.eventsOut,
				JSON.stringify(redactDump({ rep, objBody, frontBody }, secrets))
			);
			log(`raw events and the report written (redacted) to ${resolve(ctx.eventsOut)}`);
		}
	};
}

/** the plan `--dry` prints; it touches nothing */
export function planLines(opts: CensusOptions): string[] {
	const routes = routesFor(opts.cms, opts.routes);
	const driven = routes.filter((r) => r.pending === undefined);
	const perDrive = opts.cold === 'recycle' ? 4 : 3;
	return [
		`cms ${opts.cms}; ${driven.length} routes driven, ${routes.length - driven.length} pending; n ${opts.n}; cold step ${opts.cold}`,
		...routes.map((r) => `  ${r.id}: ${r.label}${r.pending ? ` (pending: ${r.pending})` : ''}`),
		`requests per drive: ${perDrive} (${opts.cold === 'recycle' ? 'recycle, ' : ''}stats before, the route, stats after) plus one page read for form and link routes`,
		`requests for the drives: ${driven.length * opts.n * perDrive}, plus setup (readiness polls, claim, login, nonce)`,
		opts.cold === 'recycle' && opts.mode !== 'local'
			? `deployed drives wait ${METER_GAP_MS / 1000} s apart so each meter row belongs to one drive: ${Math.round((driven.length * opts.n * METER_GAP_MS) / 60_000)} min of waiting, and ${opts.ingestMin === undefined ? OBSERVABILITY_INGEST_LAG_MS / 60_000 : opts.ingestMin} min for ingest`
			: 'no meter or cpuTime reading on this mode',
		opts.marginMib === undefined ? '--margin-mib not given' : `--margin-mib ${opts.marginMib}`,
		opts.warnShare === undefined ? '--warn-share not given' : `--warn-share ${opts.warnShare}`
	];
}

// #endregion

if (import.meta.main) {
	const opts = parseCensusOptions(process.argv.slice(2));
	const root = resolve(import.meta.dirname, '../..');
	if (opts.mode === 'dry') {
		for (const l of planLines(opts)) console.log(l);
		process.exit(0);
	}
	const write = (rep: CensusReport, secrets: string[]) => {
		if (opts.jsonOut === undefined) return;
		mkdirSync(dirname(resolve(opts.jsonOut)), { recursive: true });
		writeFileSync(opts.jsonOut, JSON.stringify(redactDump(rep, secrets), null, 1));
		console.log(`record written to ${resolve(opts.jsonOut)}`);
	};
	const routes = routesFor(opts.cms, opts.routes);
	const runOpts = { n: opts.n, cold: opts.cold, name: opts.name, gapMs: 0 };
	const base = (
		rep: Omit<
			CensusReport,
			'cms' | 'mode' | 'n' | 'cold' | 'lineMib' | 'marginMib' | 'warnShare'
		>,
		mode: string
	): CensusReport => ({
		cms: opts.cms,
		mode,
		n: opts.n,
		cold: opts.cold,
		lineMib: opts.lineMib,
		...(opts.marginMib === undefined ? {} : { marginMib: opts.marginMib }),
		...(opts.warnShare === undefined ? {} : { warnShare: opts.warnShare }),
		...rep
	});
	if (opts.mode === 'base') {
		const s = newSession(opts.base, opts.cms, process.env, opts.modules);
		const secrets = [s.owner, s.adminPass];
		s.log = (l) => console.log(redact(l, secrets));
		const run = await runCensus(s, routes, runOpts);
		const rep = base(run, 'existing site (no meter, no cpuTime)');
		report(rep, (l) => console.log(redact(l, secrets)));
		write(rep, secrets);
	} else if (opts.mode === 'local') {
		let rep: CensusReport | undefined;
		let secrets: string[] = [];
		if (opts.cms === 'drupal') {
			rep = await withLocalWrangler(
				root,
				drupalLocalConfig(root, opts.name),
				opts,
				async (origin) => {
					const s = newSession(origin, 'drupal', {}, opts.modules);
					const run = await runCensus(s, routes, runOpts);
					secrets = [s.owner, s.adminPass];
					return base(
						run,
						"local wrangler dev (the object's own readings; no meter, no cpuTime)"
					);
				}
			);
		} else {
			const probe = readFileSync(probePath(root, process.env), 'utf8');
			const staged = join(tmpdir(), `route-peaks-${opts.name}`, 'assets');
			stageAssets(root, staged, probe);
			rep = await withLocalWrangler(
				root,
				wpConfig(opts.name, root, staged, `http://localhost:${opts.port}`),
				opts,
				async (origin) => {
					const s = newSession(origin, 'wordpress', {}, opts.modules);
					const run = await runCensus(s, routes, runOpts);
					secrets = [s.owner, s.adminPass];
					return base(
						run,
						"local wrangler dev (the object's own readings; no meter, no cpuTime)"
					);
				}
			);
		}
		report(rep, (l) => console.log(redact(l, secrets)));
		write(rep, secrets);
	} else {
		const deps: Deps = {
			fetch,
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			log: (s) => console.log(s),
			measure: deployedMeasure(opts),
			run: (cmd, args, env) =>
				new Promise((res) => {
					const child = spawn(cmd, args, { cwd: root, env });
					let o = '';
					child.stdout.on('data', (d) => (o += d));
					child.stderr.on('data', (d) => (o += d));
					child.on('close', (code) => res({ code: code ?? 1, out: o }));
				})
		};
		let build: (name: string, r: string) => Record<string, unknown> = drupalDeployedConfig;
		if (opts.cms === 'wordpress') {
			const probe = readFileSync(probePath(root, process.env), 'utf8');
			const staged = join(tmpdir(), `route-peaks-${opts.name}`, 'assets');
			stageAssets(root, staged, probe);
			build = (name, r) => wpConfig(name, r, staged);
		}
		process.exit(
			await runDeployed(
				{
					mode: 'deployed',
					name: opts.name,
					dry: false,
					account: opts.account,
					eventsOut: undefined
				},
				process.env,
				deps,
				root,
				build
			)
		);
	}
}
