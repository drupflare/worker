import type { SiteEnv } from '../env';

/** globals the deleted runtime shim installed; nothing sets them now, so both read as absent */
export const shimGlobals = globalThis as unknown as {
	Asyncify?: { __cfwStub?: boolean };
	__cfwAsyncifyCalls?: number;
};

/**
 * Interpreters alive in this isolate, by object id.
 *
 * Module scope is per isolate and an isolate can host several objects, so two interpreters can
 * share one 128 MiB allocation. Weak references; uncollected memory still counts toward the limit.
 */
const residentInterpreters = new Map<string, WeakRef<object>>();

/**
 * The linear memory of the last interpreter this isolate dropped, until V8 collects it.
 *
 * A dropped interpreter's memory comes back only when V8 collects it, and a boot beside it holds
 * both heaps (3 of 4 boots found it alive on deployed farmOS). The binary imports its memory, so a
 * boot zeroes this one and instantiates into it. Weak, one slot.
 */
let spareMemory: WeakRef<WebAssembly.Memory> | undefined;

/** remembers a dropped interpreter's memory for the next boot; nothing may run in it afterwards */
export function keepSpareMemory(php: object | undefined): void {
	const memory = (php as { binary?: { wasmMemory?: unknown } } | undefined)?.binary?.wasmMemory;
	if (memory instanceof WebAssembly.Memory) spareMemory = new WeakRef(memory);
}

/** the dropped memory if V8 has not collected it yet, zeroed, since the module assumes zeros */
export function takeSpareMemory(): WebAssembly.Memory | undefined {
	const memory = spareMemory?.deref();
	spareMemory = undefined;
	if (memory) new Uint8Array(memory.buffer).fill(0);
	return memory;
}

/**
 * The pages a shipping interpreter's memory starts with: the tuned binary's import limits
 * (`INITIAL_PAGES` in `initial-pages.ts`). A disagreement fails every boot with a LinkError.
 */
export const INTERPRETER_MEMORY = { initial: 1024, maximum: 65536 } as const;

/** @internal the bytes a dropped, still uncollected memory holds, for a spec and `/serve-stats` */
export function spareMemoryBytes(): number {
	return spareMemory?.deref()?.buffer.byteLength ?? 0;
}

let isolateIdMemo: string | undefined;

/** this isolate's id, minted on first use because workerd refuses randomness at global scope */
export function isolateId(): string {
	return (isolateIdMemo ??= crypto.randomUUID());
}

/** records whether an object holds an interpreter at the end of an invocation */
export function noteResident(objectId: string, php: object | undefined): void {
	if (php) residentInterpreters.set(objectId, new WeakRef(php));
	else residentInterpreters.delete(objectId);
}

function linearBytesOf(php: object): number {
	const b = (php as { binary?: { HEAPU8?: unknown; wasmMemory?: { buffer?: ArrayBufferLike } } })
		.binary;
	if (b?.HEAPU8 instanceof Uint8Array) return b.HEAPU8.byteLength;
	return b?.wasmMemory?.buffer?.byteLength ?? 0;
}

/** every interpreter this isolate still holds, and their linear memory added together */
export function isolateResidency(): { id: string; interpreters: number; linearBytes: number } {
	let interpreters = 0;
	let linearBytes = 0;
	for (const [objectId, ref] of residentInterpreters) {
		const php = ref.deref();
		if (!php) {
			residentInterpreters.delete(objectId);
			continue;
		}
		interpreters++;
		linearBytes += linearBytesOf(php);
	}
	return { id: isolateId(), interpreters, linearBytes };
}

/**
 * Whether an evicted instance's interpreter is kept for the next one (on unless
 * `RETAIN_INTERPRETER=0`).
 *
 * An adopted interpreter answered the first request after an idle gap in 61-169 ms against
 * 1,033-2,463 ms booting (deployed, 2026-09-24); when the isolate is gone the boot is ordinary.
 */
export function retainInterpreterEnabled(env?: SiteEnv): boolean {
	return (
		String((env as { RETAIN_INTERPRETER?: string } | undefined)?.RETAIN_INTERPRETER ?? '1') !==
		'0'
	);
}

/**
 * Linear memory above which the interpreter is dropped at the end of an invocation.
 *
 * `USE_ZEND_ALLOC=0` means PHP never returns memory between requests, so demand in one incarnation
 * is cumulative (108.50 MiB after provisioning, 122.63 then 138.63 after two authenticated renders,
 * past the 128 MiB limit).
 *
 * 112 MiB sits above the render plateau of 108.50 and below the first over-large rung, so a serving
 * object never recycles and a freshly installed one always does. A platform figure, not a plan
 * budget (128 MiB on free and paid).
 */
export function recycleAboveBytes(env?: SiteEnv): number {
	const n = Number(env?.RECYCLE_ABOVE_BYTES);
	if (Number.isFinite(n) && n > 0) return Math.max(32 * 1024 * 1024, Math.floor(n));
	return 117_440_512;
}

/**
 * The whole isolate's ceiling, the one the platform enforces.
 *
 * `RECYCLE_ABOVE_BYTES` compares wasm linear memory only, so it fires too late (the 128 MiB covers
 * the JS heap too). 124 MiB holds 4 MiB back for one workload landing above a growth rung.
 * Separate from it because an operator who set that set a linear number, and reading it as a total
 * would recycle on every request.
 */
export function isolateAboveBytes(env?: SiteEnv): number {
	const n = Number(env?.ISOLATE_ABOVE_BYTES);
	if (Number.isFinite(n) && n > 0) return Math.max(64 * 1024 * 1024, Math.floor(n));
	return 130_023_424;
}
