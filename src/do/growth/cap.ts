import { governGrowth, type GrowthGovernor } from '@gmitch215/folio/memory';
import type { SiteEnv } from '../../env';
import { INTERPRETER_MEMORY } from '../isolate';
import { PACK_INDEX_BYTES, lazyMountBytes, type SiteMountInfo } from '../lazy-mount';
import { EFFECTS_HEADER, retryCap } from './retry';

const MIB = 1_048_576;
const PAGE_BYTES = 65_536;

/** set on a response whose run a refused grow ended, so the front worker may repeat a safe method */
export const GROWTH_REFUSED_HEADER = 'x-cfw-growth-refused';

/** the pages the interpreter's memory starts with; a cap never goes below it */
export const BOOT_LINEAR_BYTES = INTERPRETER_MEMORY.initial * PAGE_BYTES;

/**
 * Headroom an isolate holds with the interpreter resident at 64 MiB of linear memory: the MiB it
 * can still take before the platform replaces it. Measured on a deployed paid worker with the
 * headroom ladder (`scripts/measure/ladder-arms.ts`, 2026-11-23): stock Drupal after an admin page
 * or a flush settles at 36 (8 of 9 readings at a 240 s settle, none below 36 after 60 s), and a
 * Thunder object read 36 after a flush (3 reps, zero spread). Growth of linear memory counts one
 * for one below 96 MiB. `GROWTH_HEADROOM_BYTES` overrides it for a build measured differently.
 */
export const STEADY_HEADROOM_BYTES = 36 * MIB;

/**
 * What the worker's own ledger counted outside linear memory at that measurement: the mount blob
 * (13,012,361 bytes, 12.41 MiB), the merged pack index (`PACK_INDEX_BYTES`) and about 4 MiB of
 * resident files, 18.3 MiB in all (`/serve-stats` `isolateBytes` on stock Drupal, local read for the
 * blob and index, the ladder record for the resident figure). The cap moves by the difference
 * between this and the ledger now.
 */
export const JS_SIDE_AT_MEASUREMENT_BYTES = 13_012_361 + PACK_INDEX_BYTES + 4 * MIB;

/** held back below the headroom for one request landing above the cap; an assumed value */
export const DEFAULT_GROWTH_MARGIN_BYTES = 4 * MIB;

/** what the worker knows about the isolate's non-linear bytes at the moment a cap is chosen */
export interface GrowthLedger {
	/** the mount blob, the files held resident and the merged pack index */
	jsSideBytes: number;
}

/** what a refused grow reports */
export interface GrowthRefusal {
	fromBytes: number;
	toBytes: number;
	capBytes: number;
}

/** reads the ledger from the mount the object holds; zeros for a streaming mount */
export function growthLedger(mountInfo: SiteMountInfo | undefined): GrowthLedger {
	// the booting request picks its cap before the mount loads, and no blob read yet must not lift it
	if (!mountInfo) return { jsSideBytes: JS_SIDE_AT_MEASUREMENT_BYTES };
	const lazy = lazyMountBytes(mountInfo);
	return {
		jsSideBytes: lazy.blob + lazy.resident + (lazy.blob > 0 ? PACK_INDEX_BYTES : 0)
	};
}

function positiveBytes(v: unknown): number | undefined {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * The cap on linear memory, or undefined when the governor is off.
 *
 * `GROWTH_CAP_BYTES` wins over everything. Otherwise the governor is on unless `GROWTH_GOVERNOR=0`,
 * and the cap is the boot size plus the steady headroom, plus the JS-side bytes the ledger counted
 * at the measurement minus the ones it counts now, minus the margin, never below the boot size. A
 * staged pack (blob gone) raises the cap by the freed bytes and a larger resident set lowers it.
 */
export function growthCapBytes(env: SiteEnv | undefined, ledger: GrowthLedger): number | undefined {
	const explicit = positiveBytes(env?.GROWTH_CAP_BYTES);
	if (explicit !== undefined) return explicit;
	if (String(env?.GROWTH_GOVERNOR ?? '') === '0') return undefined;
	const headroom = positiveBytes(env?.GROWTH_HEADROOM_BYTES) ?? STEADY_HEADROOM_BYTES;
	const set = env?.GROWTH_MARGIN_BYTES;
	const margin =
		set === undefined || set === '' || !Number.isFinite(Number(set))
			? DEFAULT_GROWTH_MARGIN_BYTES
			: Math.max(0, Math.floor(Number(set)));
	const jsSide = JS_SIDE_AT_MEASUREMENT_BYTES - ledger.jsSideBytes;
	return Math.max(BOOT_LINEAR_BYTES + headroom + jsSide - margin, BOOT_LINEAR_BYTES);
}

const governors = new WeakMap<WebAssembly.Memory, GrowthGovernor>();
const memories = new WeakMap<object, WebAssembly.Memory>();
const refusers = new WeakMap<WebAssembly.Memory, (info: GrowthRefusal) => void>();

/** takes a memory's governor off, so a dropped interpreter's memory holds no closure */
export function releaseGrowthCap(memory: WebAssembly.Memory | undefined): void {
	const governor = memory && governors.get(memory);
	if (!memory || !governor) return;
	governors.delete(memory);
	try {
		governor.restore();
	} catch {
		// something wrapped grow after the governor; the stale wrapper keeps its own cap
	}
}

/** the memory a binary was instantiated with, whichever shape it has; see {@link installGrowthCap} */
export function memoryOf(binary: object): WebAssembly.Memory | undefined {
	return memories.get(binary);
}

/**
 * Puts a cap on a binary's memory and returns the cap in force, or undefined when there is none.
 *
 * `fresh` is the memory an instantiation produced (imported, or the module's own export); a reused
 * instance passes nothing and the one remembered for its binary is used. Any governor already on
 * the memory is released first, because a reused or spare memory comes back here and two stacked
 * governors would each hold their own cap. A cap below what the memory holds already is lifted to
 * that size: growth is refused, nothing shrinks.
 */
export function installGrowthCap(
	binary: object,
	fresh: WebAssembly.Memory | undefined,
	capBytes: number | undefined,
	onRefuse: (info: GrowthRefusal) => void
): number | undefined {
	if (fresh) memories.set(binary, fresh);
	const memory = fresh ?? memories.get(binary);
	if (!memory) return undefined;
	refusers.set(memory, onRefuse);
	return retuneGrowthCap(binary, capBytes);
}

/**
 * Moves a binary's cap, keeping the refusal handler it was installed with; undefined takes the
 * governor off. Returns the cap in force. A binary nothing was installed for has no handler and is
 * left alone.
 */
export function retuneGrowthCap(binary: object, capBytes: number | undefined): number | undefined {
	const memory = memories.get(binary);
	const onRefuse = memory && refusers.get(memory);
	if (!memory || !onRefuse) return undefined;
	releaseGrowthCap(memory);
	if (capBytes === undefined) return undefined;
	const effective = Math.max(capBytes, memory.buffer.byteLength);
	governors.set(
		memory,
		governGrowth(memory, {
			capBytes: effective,
			onRefuse: ({ fromBytes, toBytes }) =>
				onRefuse({ fromBytes, toBytes, capBytes: effective })
		})
	);
	return effective;
}

/** the object fields the cap and its phases read and write */
export interface GrowthSite extends GrowthHost {
	php?: { binary?: object };
	mountInfo?: SiteMountInfo;
	growthCap?: number;
	growthExempt?: number;
	/** whether the request in flight is the front worker's repeat, which runs under the allowance */
	growthRetry?: boolean;
}

/**
 * Recomputes the cap from the ledger as it reads now and puts it on the interpreter, or takes it off
 * while an exempt phase is running.
 */
export function syncGrowthCap(site: GrowthSite): void {
	const cap = growthCapBytes(site.env, growthLedger(site.mountInfo));
	// the front worker's repeat of a fully rolled-back refusal gets the fresh-attempt allowance
	site.growthCap = cap !== undefined && site.growthRetry ? retryCap(site.env, cap) : cap;
	const binary = site.php?.binary;
	if (binary) retuneGrowthCap(binary, (site.growthExempt ?? 0) > 0 ? undefined : site.growthCap);
}

/** starts a phase the cap does not apply to; pair with {@link leaveGrowthExempt} */
export function enterGrowthExempt(site: GrowthSite): void {
	site.growthExempt = (site.growthExempt ?? 0) + 1;
	syncGrowthCap(site);
}

/** ends a phase started by {@link enterGrowthExempt} */
export function leaveGrowthExempt(site: GrowthSite): void {
	site.growthExempt = Math.max(0, (site.growthExempt ?? 0) - 1);
	syncGrowthCap(site);
}

/**
 * Whether a request to the object is outside the cap: every route but a page render, and a render
 * carrying the owner's phase header. Provisioning, claim, install, modify, enable, restore and the
 * other owner routes legitimately grow linear memory well past a serving cap (the provisioned
 * incarnation sits at 107 MiB), and a refusal there would be a stuck flow instead of a reset the
 * front worker absorbs.
 */
export function growthPhaseExempt(request: Request): boolean {
	return new URL(request.url).pathname !== '/__serve' || request.headers.has('x-cfw-phase');
}

/**
 * A run that a refused grow ended; the interpreter is already dropped when this is thrown.
 * `rolledBack` says the run's slice transaction undid its writes.
 */
export class GrowthRefused extends Error {
	constructor(
		readonly refusal: GrowthRefusal | undefined,
		cause: unknown,
		readonly rolledBack = false
	) {
		super('the request ran out of memory under the growth cap', { cause });
		this.name = 'GrowthRefused';
	}
}

/** whether an error is what Emscripten throws when `exit()` ends the run with status 1 */
export function isExitOne(e: unknown): boolean {
	const err = e as { name?: unknown; status?: unknown } | null;
	return err?.name === 'ExitStatus' && err.status === 1;
}

/** set on a refusal whose writes were rolled back: `all` for the whole request, `slice` for the last step */
export const ROLLED_BACK_HEADER = 'x-cfw-rolled-back';

/** what a refusal left behind: nothing, earlier committed steps only, or not known */
export type RefusalWrites = 'none' | 'earlier' | 'unknown';

/**
 * The answer for a request a refused grow ended; only a safe method may be repeated. `writes`
 * says what the request saved: `none` when its transaction rolled back and no earlier step wrote.
 */
export function growthRefusedResponse(
	method: string,
	writes: RefusalWrites = 'unknown',
	effects: 'none' | 'some' | 'unknown' = 'unknown'
): Response {
	const safe = method === 'GET' || method === 'HEAD';
	let body = 'This page needed more memory than the site is allowed. Try again.\n';
	if (!safe) {
		const saved = {
			none: 'Nothing it did was saved.',
			earlier: 'Steps that finished before it were saved; the step that ran out was undone.',
			unknown: 'Changes it made before that point may have been saved.'
		}[writes];
		body = `This request ran out of memory and was stopped. ${saved}\n`;
	}
	return new Response(method === 'HEAD' ? null : body, {
		status: 503,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'retry-after': '2',
			'cache-control': 'no-store',
			[GROWTH_REFUSED_HEADER]: '1',
			[EFFECTS_HEADER]: effects,
			...(writes === 'unknown'
				? {}
				: { [ROLLED_BACK_HEADER]: writes === 'none' ? 'all' : 'slice' })
		}
	});
}

/** the object fields a refusal and a governed run write */
export interface GrowthHost {
	env?: SiteEnv;
	growthRefusals?: number;
	lastGrowthRefusal?: GrowthRefusal;
}

/** counts a refused grow, remembers it, and logs it under `MEMORY_TRACE` */
export function noteGrowthRefusal(host: GrowthHost, info: GrowthRefusal): void {
	host.growthRefusals = (host.growthRefusals ?? 0) + 1;
	host.lastGrowthRefusal = info;
	if (host.env?.MEMORY_TRACE === '1') {
		console.log(
			JSON.stringify({
				cfw: 'growth-refused',
				from: info.fromBytes,
				to: info.toBytes,
				cap: info.capBytes
			})
		);
	}
}
