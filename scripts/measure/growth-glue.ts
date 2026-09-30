import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
// `.ts` rather than this repo's usual `.js` specifier: `abi-speed.ts` imports this module under
// NODE, which resolves the extension it is given and cannot map `.js` onto a `.ts` file. Bun and
// vite both accept the explicit form, so this is the specifier that works in all three lanes --
// with `.js` here, `measure:abi-speed` and `measure:abi-control` both fail to load
import { stripExportWrappers } from './glue-exports.ts';

/**
 * Emscripten's heap-growth policy, re-emitted at a chosen step.
 *
 * THE POLICY IS JAVASCRIPT, NOT A LINK-TIME CONSTANT, and that is the whole reason this script can
 * exist. `MEMORY_GROWTH_GEOMETRIC_STEP` is documented as a `-s` setting, so the backlog recorded it
 * as needing a phasm rebuild to test. It does not: emscripten bakes it into `_emscripten_resize_heap`
 * in the glue as the literal `.2`, and the wasm binary carries no growth policy at all. One
 * interpreter, N glue variants, no relink.
 *
 * WHY A STEP OF 0 IS THE MEASUREMENT AND NOT JUST THE FLOOR. With the step at 0 the over-grown
 * candidate collapses to `oldSize`, so `newSize` is `align(requestedSize, 64 KiB)` -- the heap stops
 * being a geometric series and becomes live demand rounded up to a page. That converts "demand is
 * somewhere in a 19.25 MiB interval" into a reading.
 */

const PAGE = 65_536;

/** the shipping glue, and the only input; the `.wasm` is untouched because it holds no policy */
export const SHIPPING_GLUE = '.interp/php8.5-worker.mjs';

/**
 * Every arm a glue is emitted for; `null` is wasm32, which needs no suffix.
 *
 * `vmtailcall` is not a pointer ABI at all -- it is long64 with the Zend VM threaded through
 * `musttail` rather than through call/return. It belongs here because this is what names an arm's
 * files on disk, and `abi-speed.ts` scores whatever is named.
 */
export type Abi =
	| null
	| 'wasm64'
	| 'long64'
	| 'wasm32'
	| 'emmalloc'
	| 'bulkmem'
	| 'impmem'
	| 'zendalloc'
	| 'vmtailcall'
	| 'spimport';

/** the pristine glue for an ABI, as `phasm` publishes it */
export function glueFor(abi: Abi): string {
	return abi === null ? SHIPPING_GLUE : `.interp/php8.5-${abi}-worker.mjs`;
}

/** where the tuned copy for an ABI is written */
export function tunedGlueFor(abi: Abi): string {
	return abi === null ? TUNED_GLUE : `.interp/php8.5-${abi}-worker.tuned.mjs`;
}

/**
 * The geometric step as emscripten emits it.
 *
 * Anchored on `cutDown` rather than on the bare number: `.2` occurs all over a 12 MB glue file and
 * this expression occurs once, which a spec asserts before any rewrite happens.
 *
 * The step itself is matched loosely because not every published glue is emscripten-fresh: phasm's
 * LP64 patch rewrites `growMemory` on the wasm64 build and emits `0.05` there, so an anchor on `.2`
 * refuses the one arm that most needs re-emitting.
 */
const STEP_SITE = /oldSize\*\(1\+[0-9.]+\/cutDown\)/;

/** where a variant is written, keyed by step so a ladder run leaves every arm on disk */
export function variantPath(step: number): string {
	return `.interp/php8.5-worker.growth-${String(step).replace('.', 'p')}.mjs`;
}

/**
 * The geometric growth step the shipping glue is emitted at.
 *
 * A peak is a STEP FUNCTION of the step -- `newSize = align(max(demand, oldSize * (1 + step)))` --
 * so it is flat across a range and then jumps, and interpolating between two arms is invalid. What
 * decides an arm is which rung first exceeds the AUTHENTICATED demand, which is the binding
 * workload; a plain render reads 96.00 MiB on every arm and answers nothing.
 *
 * 0.01 ships, decided 2026-09-29 on client-visible failures. Three paid runs per arm of the heavy
 * drive (`live-deploy.ts`, 3 rounds, 8 warm passes) failed 4, 4 and 4 visitor requests at 0.01 against
 * 17, 14 and 6 at 0.13. Distinct reset events moved only 18.0 against 21.3, so the step is not what
 * resets the object; it is what a visitor meets when one happens. 0.13 grew straight to 115.56 MiB from
 * 102.25, and 0.01 climbs in ~1 MiB rungs that stop near the demand.
 *
 * **An earlier 0.01 pair lost, and it was measured before `safeHeapSubarray()`.** Its five failures were
 * `Invalid array buffer length`, which is the `subarray` limit above 2^27 bytes, not the step. The
 * runs above carry the fix. 0.13 had been chosen for long64 because 0.12 reached its authenticated
 * demand of (111,738,880, 112,787,456] with no pages of margin.
 *
 * **Margin is a fourth metric and it overrules the Pareto frontier**, because demand MOVES. The full
 * wasm32 sweep behind that rule -- every hundredth to 0.20 plus thousandths across the breakpoint --
 * is in `TECHNICAL_REPORT.md` rather than here.
 */ export const SHIPPING_STEP = 0.01;

/**
 * The step the specs' growth ceilings were set at, which is a bound on how much a workload may
 * allocate. It stayed when the shipping step moved: the demand did not change, only the rung size.
 */
export const CEILING_STEP = 0.13;

/**
 * The step per ABI, because the optimum is a property of that ABI's demand.
 *
 * `wasm32` is the OFF arm and keeps its own 0.08, the step its sweep chose.
 * wasm64 falls back -- its sweep ran at 0.05 and a number here would be invented.
 */
const STEP_BY_ABI: Record<string, number> = { wasm32: 0.08 };
// emmalloc/bulkmem/impmem/zendalloc are long64 plus ONE flag each, so they inherit long64's step
// rather than getting a number nobody swept -- an arm measured at a different growth policy is not
// an arm

/**
 * `DRUPFLARE_ABI_STEP` forces the step for an ABI arm, which is the only way to read raw DEMAND.
 *
 * The peak is `align(max(demand, old * (1 + step)))`, so at a coarse step four arms whose demand
 * differs by less than a rung all report the SAME peak -- which reads as "no effect" and is quantisation. At
 * step 0 the heap grows by exactly what was asked for.
 */
export function stepFor(abi: Abi): number {
	const forced = Number(process.env.DRUPFLARE_ABI_STEP);
	if (Number.isFinite(forced) && forced >= 0) return forced;
	return (abi !== null && STEP_BY_ABI[abi]) || SHIPPING_STEP;
}

/** the tuned glue the shipping seam imports; emitted after the pristine one is sha256-verified */
export const TUNED_GLUE = '.interp/php8.5-worker.tuned.mjs';

/**
 * Emits the glue for an ABI at {@link stepFor}, with the export trampolines collapsed.
 *
 * Written BESIDE the pristine file rather than over it. `restore-artifacts.ts` verifies the
 * download against `cdn-manifest.json`, so rewriting in place would either break that check or
 * force the hash to cover a file this repo edits -- and a hash that covers a locally-mutated file
 * guarantees nothing.
 *
 * Two transforms, one file: the growth step, and `stripExportWrappers` for the bundle bytes. They
 * ride together because both must apply to the copy the shipping seam imports, and a second emitter
 * is a second thing to forget.
 */
export function emitTunedGlue(root = process.cwd(), abi: Abi = null): string {
	const from = glueFor(abi);
	const source = resolve(root, from);
	if (!existsSync(source)) throw new Error(`no shipping glue at ${from}`);
	const glue = readFileSync(source, 'utf8');
	if (!STEP_SITE.test(glue)) {
		throw new Error(`growth site not found in ${from}; emscripten changed its emitted form`);
	}
	const stepped = glue.replace(STEP_SITE, `oldSize*(1+${stepFor(abi)}/cutDown)`);
	const out = resolve(root, tunedGlueFor(abi));
	writeFileSync(
		out,
		stripExportWrappers(
			provideReallocarray(
				safeHeapSubarray(recordDecodeFailure(recordGrowth(plugCallableLeak(stepped))))
			)
		).source
	);
	return out;
}

const CALLABLE_SITE =
	/const zf=Module\.ccall\("vrzno_expose_callable",("\w+"),\[("\w+")\],\[zv\]\);/;

/**
 * Asks vrzno whether a value is callable only when it could be one vrzno wraps.
 *
 * `vrzno_expose_callable()` calls `zend_is_callable_ex()` with an error out-parameter and never
 * frees it, so every string handed to JS left `function "<the whole string>" not found` on the
 * heap. Every host call passes a JSON string, and with no request shutdown here nothing reclaimed
 * them: measured on the zend-alloc arm, 256 bytes per call for a 56-byte argument and 4,096 for a
 * 3,073-byte one, ~185 KB per authenticated `/admin/modules` render. vrzno already discards the
 * answer for a string, so skipping the question for every type that cannot be a closure, an
 * invokable or a two-element `[object, method]` array changes nothing but the leak.
 */
export function plugCallableLeak(glue: string): string {
	if (!CALLABLE_SITE.test(glue)) {
		throw new Error(
			'vrzno callable site not found in the glue; vrzno changed its emitted form'
		);
	}
	return glue.replace(
		CALLABLE_SITE,
		'const zf=type===IS_OBJECT||(type===IS_ARRAY&&Module.ccall("vrzno_expose_array_length",' +
			'"number",[$2],[Module.ccall("vrzno_expose_array",$2,[$2],[zv])])===2)' +
			'?Module.ccall("vrzno_expose_callable",$1,[$2],[zv]):0;'
	);
}

const GROW_SITE =
	/growMemory=size=>\{var b=wasmMemory\.buffer;var pages=\(size-b\.byteLength\+65535\)\/65536;try\{wasmMemory\.grow\(pages\);updateMemoryViews\(\);return 1\}catch\(e\)\{\}\}/;

/**
 * Records every heap growth on `globalThis.__cfwGrow`, last 16 events.
 *
 * Emscripten's `growMemory` swallows whatever `wasmMemory.grow()` throws and answers "could not
 * grow", so a RangeError from the platform reaches nobody. Each record carries the requested size,
 * the size before, the page count handed to `grow()` and the error, which is what separates an
 * invalid LENGTH (negative, fractional or past the maximum) from an allocation refused.
 */
export function recordGrowth(glue: string): string {
	if (!GROW_SITE.test(glue)) {
		throw new Error('growMemory not found in the glue; emscripten changed its emitted form');
	}
	return glue.replace(
		GROW_SITE,
		'growMemory=size=>{var b=wasmMemory.buffer;var pages=(size-b.byteLength+65535)/65536;' +
			'var r={at:Date.now(),size:size,old:b.byteLength,pages:pages,ok:1};' +
			'var l=globalThis.__cfwGrow||(globalThis.__cfwGrow=[]);l.push(r);if(l.length>16)l.shift();' +
			'try{wasmMemory.grow(pages);updateMemoryViews();return 1}' +
			'catch(e){r.ok=0;r.error=e&&e.name+": "+e.message;r.stack=e&&String(e.stack).slice(0,600)}}'
	);
}

const DECODE_SITE = /return UTF8Decoder\.decode\(heapOrArray\.subarray\(idx,endPtr\)\)/;

/**
 * Records what `UTF8ArrayToString` was looking at when its decode threw, on `globalThis.__cfwSub`.
 *
 * `Invalid array buffer length` reached visitors from this line, under vrzno's `zvalToJS`, on about
 * half of the live drives. The record separates the candidates: a view that no longer belongs to the
 * live memory (`same` false), a scan that ran off the end of the heap (`endPtr` against `len`), and a
 * view whose own length disagrees with its buffer.
 */
export function recordDecodeFailure(glue: string): string {
	if (!DECODE_SITE.test(glue)) {
		throw new Error(
			'UTF8ArrayToString decode not found in the glue; emscripten changed its form'
		);
	}
	return glue.replace(
		DECODE_SITE,
		'try{return UTF8Decoder.decode(heapOrArray.subarray(idx,endPtr))}catch(e){' +
			'var l=globalThis.__cfwSub||(globalThis.__cfwSub=[]);' +
			'l.push({at:Date.now(),idx:idx,endPtr:endPtr,len:heapOrArray.length,bytes:heapOrArray.byteLength,' +
			'buf:heapOrArray.buffer.byteLength,mem:wasmMemory.buffer.byteLength,' +
			'same:heapOrArray.buffer===wasmMemory.buffer,error:e&&e.name+": "+e.message});' +
			'if(l.length>8)l.shift();throw e}'
	);
}

const VIEWS_SITE =
	/function updateMemoryViews\(\)\{var b=wasmMemory\.buffer;(?:Module\["HEAP\w+"\]=HEAP\w+=new \w+Array\(b\);?){8}\}/;

/** the byte offset from which the platform refuses `subarray` on a wasm memory, 2^27 */
export const SUBARRAY_LIMIT = 134_217_728;

/**
 * The `subarray` that replaces the heap views' own, as glue source.
 *
 * MEASURED ON A DEPLOYED DURABLE OBJECT, 2026-09-29: once a wasm memory has grown past 128 MiB,
 * `TypedArray.prototype.subarray` throws `RangeError: Invalid array buffer length` for any begin
 * offset from 2^27 bytes up, and only that method does. `new Uint8Array(buffer, offset, length)`,
 * `slice`, `set`, `copyWithin`, `fill` and `DataView` all work at the same offsets, on the same
 * buffer, in the same isolate. A local workerd does not enforce it, so no gate lane sees it.
 * Emscripten decodes every string longer than 16 bytes with `HEAPU8.subarray`, so any PHP string
 * that lived above 128 MiB failed a host call, which is the `Invalid array buffer length` that
 * answered about half of the live drives with a 500. Below the limit the native method runs.
 */
export const SAFE_SUBARRAY =
	'var cfwSafeSubarray=function(v){var n=v.subarray,bpe=v.BYTES_PER_ELEMENT;' +
	'v.subarray=function(a,b){var len=this.length;' +
	'a=a===undefined?0:Math.trunc(a)||0;a=a<0?Math.max(len+a,0):Math.min(a,len);' +
	'b=b===undefined?len:Math.trunc(b)||0;b=b<0?Math.max(len+b,0):Math.min(b,len);' +
	`var off=this.byteOffset+a*bpe;if(off<${SUBARRAY_LIMIT})return n.call(this,a,b);` +
	'return new this.constructor(this.buffer,off,Math.max(b-a,0))};return v};';

/** routes every heap view's `subarray` through {@link SAFE_SUBARRAY} whenever the views are rebuilt */
export function safeHeapSubarray(glue: string): string {
	const match = VIEWS_SITE.exec(glue);
	if (!match) {
		throw new Error(
			'updateMemoryViews not found in the glue; emscripten changed its emitted form'
		);
	}
	const wrapped = match[0].replace(/=new (\w+Array)\(b\)/g, '=cfwSafeSubarray(new $1(b))');
	return glue.replace(match[0], () => SAFE_SUBARRAY + wrapped);
}

/**
 * A real `reallocarray` where emscripten emitted a stub that aborts the runtime.
 *
 * The interpreter imports it from libc and emscripten's JS library has none, so the glue carries
 * `abort("missing function: reallocarray")`, and every farmOS render reached it: an abort, then a
 * 1101. It is `realloc` with an overflow check. `realloc` is not exported, so the old block's size
 * is unknown and the copy takes the new size, clamped to the heap; the bytes past the old block are
 * indeterminate either way, as C allows. Returns 0 on overflow, like the C function.
 */
export const REALLOCARRAY =
	'function _reallocarray(ptr,n,size){var total=n*size;' +
	'if(n&&Math.floor(total/n)!==size||total>4294967295)return 0;' +
	'if(!ptr)return _malloc(total);if(!total){_free(ptr);return 0}' +
	'var np=_malloc(total);if(!np)return 0;' +
	'HEAPU8.copyWithin(np,ptr,Math.min(ptr+total,HEAPU8.length));_free(ptr);return np}';

const REALLOCARRAY_STUB =
	'function _reallocarray(){abort("missing function: reallocarray")}_reallocarray.stub=true';

/** swaps the aborting stub for {@link REALLOCARRAY}; a glue that implements it already is left alone */
export function provideReallocarray(glue: string): string {
	return glue.replace(REALLOCARRAY_STUB, () => REALLOCARRAY);
}

/** the sizes emscripten will try, in order, for one growth event */
export function growthLadder(oldSize: number, requestedSize: number, step: number): number[] {
	const tries: number[] = [];
	for (let cutDown = 1; cutDown <= 4; cutDown *= 2) {
		const overGrown = Math.min(oldSize * (1 + step / cutDown), requestedSize + 100_663_296);
		tries.push(Math.ceil(Math.max(requestedSize, overGrown) / PAGE) * PAGE);
	}
	return tries;
}

/**
 * Rewrite the glue at `step` and return where it was written.
 *
 * Fails loudly on a miss. A silent no-op here would produce a ladder whose arms are all the control,
 * which reads as "the step does not matter" -- the exact instrument error RULE 0 is about.
 */
export function emitVariant(step: number, root = process.cwd()): string {
	const source = resolve(root, SHIPPING_GLUE);
	if (!existsSync(source)) throw new Error(`no shipping glue at ${SHIPPING_GLUE}`);

	const glue = readFileSync(source, 'utf8');
	if (!STEP_SITE.test(glue)) {
		throw new Error('growth site not found in the glue; emscripten changed its emitted form');
	}

	const out = resolve(root, variantPath(step));
	writeFileSync(
		out,
		provideReallocarray(
			safeHeapSubarray(
				recordDecodeFailure(
					recordGrowth(
						plugCallableLeak(glue.replace(STEP_SITE, `oldSize*(1+${step}/cutDown)`))
					)
				)
			)
		)
	);
	return out;
}

if (import.meta.main) {
	const steps = process.argv.slice(2).map(Number);
	if (!steps.length || steps.some((s: number) => !Number.isFinite(s) || s < 0)) {
		console.error('usage: bun scripts/measure/growth-glue.ts <step> [step ...]');
		process.exit(1);
	}
	for (const step of steps) console.log(`${step} -> ${emitVariant(step)}`);
}
