import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	closeSockets,
	closeVrznoBridge,
	emitTunedGlue,
	emitVariant,
	growthLadder,
	plugCallableLeak,
	provideReallocarray,
	REALLOCARRAY,
	recordDecodeFailure,
	recordGrowth,
	SAFE_SUBARRAY,
	safeHeapSubarray,
	SHIPPING_GLUE,
	SHIPPING_STEP,
	SOCKET_CLOSURE,
	SUBARRAY_LIMIT,
	TUNED_GLUE,
	variantPath,
	VRZNO_CLOSURE
} from '../../scripts/measure/growth-glue';
import { closedProblems, runAttempts } from '../helpers/vrzno-bridge';

/**
 * The heap-growth rewrite, and the guard that stops it becoming a silent no-op.
 *
 * THE FAILURE THIS EXISTS FOR is the one this repository keeps hitting: a rewrite that matches
 * nothing still produces an output file, so a ladder run would emit N arms that are all the control
 * and read as "the growth step does not matter". `emitVariant` throws on a miss and this pins that.
 *
 * IT ALSO PINS EMSCRIPTEN'S EMITTED FORM, which is the real fragility. The growth policy is glue
 * JavaScript rather than anything in the `.wasm`, so an interpreter rebuild that ships a newer
 * emscripten can change `oldSize*(1+.2/cutDown)` without changing a single thing this project wrote.
 * Failing here is how that gets noticed.
 *
 * SKIPPED WITHOUT THE INTERPRETER. `.interp/` is a build artifact a clean checkout does not have;
 * `growthLadder` is pure arithmetic and is asserted either way.
 */

const CALLABLE =
	'let type=t(zv);const zf=Module.ccall("vrzno_expose_callable","number",["number"],[zv]);' +
	'if(zf&&type!==IS_STRING){}';

describe('the vrzno callable leak plug', () => {
	it('asks about callability only for an object or a two-element array', () => {
		const out = plugCallableLeak(CALLABLE);
		expect(out).not.toContain('const zf=Module.ccall("vrzno_expose_callable"');
		expect(out).toContain('type===IS_OBJECT||(type===IS_ARRAY&&');
		expect(out).toContain('?Module.ccall("vrzno_expose_callable","number",["number"],[zv]):0;');
		// the wrapping branch is untouched, so a callable still becomes a JS function
		expect(out).toContain('if(zf&&type!==IS_STRING){}');
	});

	it('keeps the pointer ABI of a wasm64 glue', () => {
		const out = plugCallableLeak(CALLABLE.replaceAll('"number"', '"pointer"'));
		expect(out).toContain(
			'?Module.ccall("vrzno_expose_callable","pointer",["pointer"],[zv]):0;'
		);
		expect(out).toContain('Module.ccall("vrzno_expose_array","pointer",["pointer"],[zv])');
	});

	it('throws when vrzno no longer emits the site', () => {
		expect(() => plugCallableLeak('a();b()')).toThrow(/callable site not found/);
	});
});

const have = existsSync(resolve(process.cwd(), SHIPPING_GLUE));
const PAGE = 65_536;

describe('emscripten growth arithmetic', () => {
	it('reproduces the shipping peak from INITIAL_MEMORY in one step', () => {
		// 100,663,296 grown once at 0.20 is the measured 120,848,384, to the byte
		expect(growthLadder(100_663_296, 100_663_297, 0.2)[0]).toBe(120_848_384);
	});

	it('degrades through THREE tries, so the cap is not a cliff', () => {
		// `for (cutDown = 1; cutDown <= 4; cutDown *= 2)` gives 0.20, 0.10, 0.05. When the first
		// grow throws, emscripten retries smaller rather than aborting -- which is why "one growth
		// event from OOM" was the wrong reading of the same arithmetic
		const tries = growthLadder(120_848_384, 120_848_385, 0.2);
		expect(tries).toHaveLength(3);
		expect(tries[0]).toBeGreaterThan(128 * 1_048_576);
		expect(tries[2]).toBeLessThan(128 * 1_048_576);
		// strictly decreasing, so each retry is a real second chance rather than the same size
		expect(tries[1]).toBeLessThan(tries[0]!);
		expect(tries[2]).toBeLessThan(tries[1]!);
	});

	it('collapses to demand rounded to a page at a step of 0', () => {
		const demand = 110_000_001;
		const [only] = growthLadder(100_663_296, demand, 0);
		expect(only).toBe(Math.ceil(demand / PAGE) * PAGE);
	});

	it('never returns a size below the request, at any step', () => {
		for (const step of [0, 0.01, 0.05, 0.2, 1]) {
			for (const size of growthLadder(100_663_296, 130_000_000, step)) {
				expect(size).toBeGreaterThanOrEqual(130_000_000);
			}
		}
	});
});

describe.skipIf(!have)('rewriting the shipping glue', () => {
	it('emits a variant whose growth site carries the requested step', () => {
		const out = variantPath(0.05);
		try {
			emitVariant(0.05);
			const glue = readFileSync(resolve(process.cwd(), out), 'utf8');
			expect(glue).toContain('oldSize*(1+0.05/cutDown)');
			expect(glue).not.toContain('oldSize*(1+.2/cutDown)');
			// byte-identical everywhere else, so an arm differs from the control in the growth
			// policy and in nothing else. A length bound would pass on a truncated variant
			const source = readFileSync(resolve(process.cwd(), SHIPPING_GLUE), 'utf8');
			expect(glue.replace('oldSize*(1+0.05/cutDown)', 'oldSize*(1+.2/cutDown)')).toBe(
				provideReallocarray(
					safeHeapSubarray(recordDecodeFailure(recordGrowth(plugCallableLeak(source))))
				)
			);
		} finally {
			rmSync(resolve(process.cwd(), out), { force: true });
		}
	});

	it('throws rather than emitting a control arm when the site is gone', () => {
		expect(() => emitVariant(0.1, '/nonexistent-root')).toThrow(/no shipping glue/);
	});
});

const GROW =
	'growMemory=size=>{var b=wasmMemory.buffer;var pages=(size-b.byteLength+65535)/65536;' +
	'try{wasmMemory.grow(pages);updateMemoryViews();return 1}catch(e){}}';

const VIEWS =
	'function updateMemoryViews(){var b=wasmMemory.buffer;' +
	[
		'HEAP8=Int8',
		'HEAP16=Int16',
		'HEAPU8=Uint8',
		'HEAPU16=Uint16',
		'HEAP32=Int32',
		'HEAPU32=Uint32',
		'HEAPF32=Float32',
		'HEAPF64=Float64'
	]
		.map(
			(p) => `Module["${p.split('=')[0]}"]=${p.split('=')[0]}=new ${p.split('=')[1]}Array(b);`
		)
		.join('') +
	'}';

const DECODE = 'x=()=>{return UTF8Decoder.decode(heapOrArray.subarray(idx,endPtr))};';

describe('a glue that already carries a step', () => {
	// phasm's LP64 patch emits 0.05 on the wasm64 build, so an anchor on emscripten's `.2` refused it
	it('is re-emitted at the new step', () => {
		const root = mkdtempSync(join(tmpdir(), 'growth-glue-'));
		try {
			mkdirSync(dirname(resolve(root, SHIPPING_GLUE)), { recursive: true });
			writeFileSync(
				resolve(root, SHIPPING_GLUE),
				`a();oldSize*(1+0.05/cutDown);${GROW}${DECODE}${VIEWS}${CALLABLE}`
			);
			emitVariant(0.11, root);
			const out = readFileSync(resolve(root, variantPath(0.11)), 'utf8');
			expect(out).toBe(
				`a();oldSize*(1+0.11/cutDown);${safeHeapSubarray(recordDecodeFailure(recordGrowth(GROW + DECODE)) + VIEWS)}${plugCallableLeak(CALLABLE)}`
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('still throws when no growth site is present at all', () => {
		const root = mkdtempSync(join(tmpdir(), 'growth-glue-'));
		try {
			mkdirSync(dirname(resolve(root, SHIPPING_GLUE)), { recursive: true });
			writeFileSync(resolve(root, SHIPPING_GLUE), 'a();growMemory(n);b()');
			expect(() => emitVariant(0.11, root)).toThrow(/growth site not found/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('the tuned glue the shipping seam imports', () => {
	it('carries SHIPPING_STEP and not emscripten default', () => {
		// ASSERTED AGAINST THE FILE, not against a render. With `OPCACHE_MODE=off` an anonymous
		// render no longer grows the heap at all, so nothing at runtime reveals the step any more --
		// and the divergence this guards is exactly the one CLAUDE.md records at this seam, where
		// the gate ran one interpreter for the life of the project while production ran another.
		//
		// The node lane rather than the workers one: this reads the filesystem, which workerd cannot
		const tuned = resolve(process.cwd(), TUNED_GLUE);
		if (!existsSync(tuned)) {
			expect(existsSync(resolve(process.cwd(), SHIPPING_GLUE))).toBe(false);
			return;
		}
		const glue = readFileSync(tuned, 'utf8');
		expect(SHIPPING_STEP).toBe(0.01);
		expect(glue).toContain(`oldSize*(1+${SHIPPING_STEP}/cutDown)`);
		expect(glue).not.toContain('oldSize*(1+.2/cutDown)');
		// a stale tuned file would bring back 256 bytes per host call on every site
		expect(glue).toContain('type===IS_OBJECT||(type===IS_ARRAY&&');
	});
});

describe('the growth record', () => {
	const PRISTINE =
		'growMemory=size=>{var b=wasmMemory.buffer;var pages=(size-b.byteLength+65535)/65536;' +
		'try{wasmMemory.grow(pages);updateMemoryViews();return 1}catch(e){}};';

	/** the rewritten growMemory, run against a memory that grows or throws */
	function run(grow: (pages: number) => void) {
		const out = recordGrowth(PRISTINE);
		const wasmMemory = { buffer: { byteLength: 65536 * 10 }, grow };
		const fn = new Function(
			'wasmMemory',
			'updateMemoryViews',
			`var ${out.replace(/;$/, '')}; return growMemory;`
		)(wasmMemory, () => {}) as (size: number) => number | undefined;
		return fn;
	}

	it('records the size asked, the size before and the pages handed to grow', () => {
		delete (globalThis as { __cfwGrow?: unknown }).__cfwGrow;
		expect(run(() => {})(65536 * 14)).toBe(1);
		const [r] = (globalThis as { __cfwGrow?: Record<string, unknown>[] }).__cfwGrow!;
		expect(r).toMatchObject({ size: 65536 * 14, old: 65536 * 10, ok: 1 });
		expect(Math.floor(r!['pages'] as number)).toBe(4);
	});

	it('keeps the error a failed grow throws, which emscripten discards', () => {
		delete (globalThis as { __cfwGrow?: unknown }).__cfwGrow;
		const failed = run(() => {
			throw new RangeError('Invalid array buffer length');
		})(65536 * 14);
		expect(failed).toBeUndefined();
		const [r] = (globalThis as { __cfwGrow?: Record<string, unknown>[] }).__cfwGrow!;
		expect(r).toMatchObject({ ok: 0, error: 'RangeError: Invalid array buffer length' });
		expect(String(r!['stack'])).toContain('Invalid array buffer length');
	});

	it('keeps the last 16 and refuses a glue whose growMemory changed', () => {
		delete (globalThis as { __cfwGrow?: unknown }).__cfwGrow;
		const fn = run(() => {});
		for (let i = 0; i < 20; i++) fn(65536 * (11 + i));
		expect((globalThis as { __cfwGrow?: unknown[] }).__cfwGrow).toHaveLength(16);
		expect(() => recordGrowth('growMemory=size=>{}')).toThrow(/growMemory not found/);
	});
});

describe('the decode failure record', () => {
	it('keeps what the view looked like when the decode threw, and rethrows', () => {
		delete (globalThis as { __cfwSub?: unknown }).__cfwSub;
		const out = recordDecodeFailure(DECODE);
		const buffer = { byteLength: 100 };
		const fn = new Function(
			'UTF8Decoder',
			'heapOrArray',
			'idx',
			'endPtr',
			'wasmMemory',
			`var ${out.replace(/;$/, '')}; return x();`
		);
		const view = {
			length: 100,
			byteLength: 100,
			buffer,
			subarray() {
				throw new RangeError('Invalid array buffer length');
			}
		};
		expect(() =>
			fn({ decode: () => '' }, view, 10, 90, { buffer: { byteLength: 200 } })
		).toThrow(/Invalid array buffer length/);
		const [r] = (globalThis as { __cfwSub?: Record<string, unknown>[] }).__cfwSub!;
		expect(r).toMatchObject({ idx: 10, endPtr: 90, len: 100, buf: 100, mem: 200, same: false });
		expect(() => recordDecodeFailure('nothing here')).toThrow(/decode not found/);
	});
});

describe('the heap subarray that works above 128 MiB', () => {
	type Fake = {
		length: number;
		byteOffset: number;
		BYTES_PER_ELEMENT: number;
		buffer: object;
		constructor: new (buffer: object, offset: number, length: number) => unknown;
		subarray: (a?: number, b?: number) => unknown;
	};

	/** a view whose own subarray throws from the byte offset the platform refuses, like the deployed one */
	function view(bpe: number, length: number): { v: Fake; native: number[][]; made: unknown[][] } {
		const native: number[][] = [];
		const made: unknown[][] = [];
		const buffer = {};
		const v: Fake = {
			length,
			byteOffset: 0,
			BYTES_PER_ELEMENT: bpe,
			buffer,
			constructor: function (this: unknown, ...args: unknown[]) {
				made.push(args);
			} as never,
			subarray(a = 0, b = length) {
				if (a * bpe >= SUBARRAY_LIMIT) throw new RangeError('Invalid array buffer length');
				native.push([a, b]);
				return 'native';
			}
		};
		return { v, native, made };
	}
	const wrap = (v: Fake): Fake =>
		new Function(`${SAFE_SUBARRAY} return cfwSafeSubarray;`)()(v) as Fake;

	it('is the failure without the wrapper, so the emulation means something', () => {
		const { v } = view(1, 200_000_000);
		expect(() => v.subarray(137_757_516, 137_759_972)).toThrow(/Invalid array buffer length/);
	});

	it('builds the view from the buffer above the limit and keeps the native call below it', () => {
		const { v, native, made } = view(1, 200_000_000);
		const safe = wrap(v);
		expect(safe.subarray(137_757_516, 137_759_972)).not.toBe('native');
		expect(made).toEqual([[v.buffer, 137_757_516, 2456]]);
		expect(safe.subarray(100, 200)).toBe('native');
		expect(native).toEqual([[100, 200]]);
	});

	it('counts the limit in bytes, so a wide view crosses it at a smaller index', () => {
		const { v, made } = view(4, 50_000_000);
		wrap(v).subarray(SUBARRAY_LIMIT / 4, SUBARRAY_LIMIT / 4 + 10);
		expect(made).toEqual([[v.buffer, SUBARRAY_LIMIT, 10]]);
	});

	it('follows the native rules for a negative, missing or reversed index', () => {
		const { v, made } = view(1, 200_000_000);
		const safe = wrap(v);
		safe.subarray(-10);
		safe.subarray(199_999_990, 199_999_000);
		expect(made).toEqual([
			[v.buffer, 199_999_990, 10],
			[v.buffer, 199_999_990, 0]
		]);
	});

	it('wraps all eight heap views when they are rebuilt, and refuses a glue that changed', () => {
		const out = safeHeapSubarray(VIEWS);
		expect(out.match(/cfwSafeSubarray\(new /g)).toHaveLength(8);
		expect(out).toContain(SAFE_SUBARRAY);
		expect(() => safeHeapSubarray('function updateMemoryViews(){}')).toThrow(
			/updateMemoryViews not found/
		);
	});

	it('clamps an index past the length like the native method', () => {
		const { v, made } = view(1, 200_000_000);
		wrap(v).subarray(199_999_999, 300_000_000);
		wrap(v).subarray(400_000_000, 500_000_000);
		expect(made).toEqual([
			[v.buffer, 199_999_999, 1],
			[v.buffer, 200_000_000, 0]
		]);
	});

	it('adds the view own byte offset before comparing with the limit', () => {
		const { v, native, made } = view(2, 100_000_000);
		v.byteOffset = SUBARRAY_LIMIT - 100;
		const safe = wrap(v);
		safe.subarray(10, 20);
		safe.subarray(50, 60);
		expect(native).toEqual([[10, 20]]);
		expect(made).toEqual([[v.buffer, SUBARRAY_LIMIT, 10]]);
	});
});

describe('the wrapper follows every rebuild of the heap views', () => {
	/** the glue's own updateMemoryViews, rewritten, run against a real growing memory */
	function glueViews() {
		const rewritten = safeHeapSubarray(VIEWS);
		const names = [
			'HEAP8',
			'HEAP16',
			'HEAPU8',
			'HEAPU16',
			'HEAP32',
			'HEAPU32',
			'HEAPF32',
			'HEAPF64'
		];
		const Module: Record<string, unknown> = {};
		const memory = new WebAssembly.Memory({ initial: 2100 });
		const run = new Function(
			'wasmMemory',
			'Module',
			`var ${names.join(',')};${rewritten}; updateMemoryViews(); return { update: updateMemoryViews, get: () => ({ ${names.join(', ')} }) };`
		)(memory, Module) as { update: () => void; get: () => Record<string, Int8Array> };
		return { memory, ...run };
	}

	it('installs it on the new views after a grow, and reads the same bytes as the native one', () => {
		const { memory, update, get } = glueViews();
		const before = get()['HEAPU8']!;
		memory.grow(100);
		update();
		const after = get();
		expect(Object.is(after['HEAPU8'], before)).toBe(false);
		const at = SUBARRAY_LIMIT + 4096;
		after['HEAPU8']![at] = 7;
		after['HEAPU8']![at + 1] = 9;
		const over = after['HEAPU8']!.subarray(at, at + 2);
		expect([...over]).toEqual([7, 9]);
		expect(over.byteOffset).toBe(at);
		expect(over.buffer).toBe(memory.buffer);
		expect(Object.prototype.hasOwnProperty.call(after['HEAPU8'], 'subarray')).toBe(true);
	});

	it('takes element indices for the wide views and compares the limit in bytes', () => {
		const { memory, get } = glueViews();
		const { HEAP32, HEAPF64, HEAP16 } = get() as unknown as Record<string, Int32Array>;
		const i32 = SUBARRAY_LIMIT / 4 + 8;
		const f64 = SUBARRAY_LIMIT / 8 + 8;
		const i16 = SUBARRAY_LIMIT / 2 + 8;
		HEAP32![i32] = 123456;
		(HEAPF64 as unknown as Float64Array)[f64] = 2.5;
		HEAP16![i16] = 77;
		const a = HEAP32!.subarray(i32, i32 + 1);
		const b = (HEAPF64 as unknown as Float64Array).subarray(f64, f64 + 1);
		const c = HEAP16!.subarray(i16, i16 + 1);
		expect([a[0], b[0], c[0]]).toEqual([123456, 2.5, 77]);
		expect([a.byteOffset, b.byteOffset, c.byteOffset]).toEqual([
			SUBARRAY_LIMIT + 32,
			SUBARRAY_LIMIT + 64,
			SUBARRAY_LIMIT + 16
		]);
		expect(a.buffer).toBe(memory.buffer);
	});
});

describe('reallocarray, which the glue stubbed with an abort', () => {
	/** the emitted function, run against a small heap and a bump allocator */
	function harness() {
		const HEAPU8 = new Uint8Array(1024);
		let next = 512;
		const freed: number[] = [];
		const _malloc = (n: number) => {
			const at = next;
			next += n;
			return at;
		};
		const _free = (p: number) => freed.push(p);
		const fn = new Function(
			'HEAPU8',
			'_malloc',
			'_free',
			`${REALLOCARRAY};return _reallocarray;`
		)(HEAPU8, _malloc, _free) as (ptr: number, n: number, size: number) => number;
		return { HEAPU8, fn, freed };
	}

	it('moves the contents to a new block and frees the old one', () => {
		const { HEAPU8, fn, freed } = harness();
		HEAPU8.set([1, 2, 3, 4], 16);
		const moved = fn(16, 2, 4);
		expect(Array.from(HEAPU8.subarray(moved, moved + 4))).toEqual([1, 2, 3, 4]);
		expect(freed).toEqual([16]);
	});

	it('allocates for a null pointer and refuses an overflowing product', () => {
		const { fn } = harness();
		expect(fn(0, 4, 4)).toBe(512);
		expect(fn(16, 2 ** 20, 2 ** 20)).toBe(0);
	});

	it('replaces the stub in a glue that has one, and leaves any other glue alone', () => {
		const stub =
			'a();function _reallocarray(){abort("missing function: reallocarray")}_reallocarray.stub=true;b();';
		expect(provideReallocarray(stub)).toBe(`a();${REALLOCARRAY};b();`);
		expect(provideReallocarray('a();b();')).toBe('a();b();');
	});
});

const SOCKET_WASM = resolve(process.cwd(), '.interp/php8.5.wasm');

/** a tuned glue emitted from the shipping glue into a scratch root, plus the shipping glue as a control */
function socketArms() {
	const root = mkdtempSync(join(tmpdir(), 'cfw-sockets-'));
	mkdirSync(join(root, '.interp'));
	const pristine = readFileSync(resolve(process.cwd(), SHIPPING_GLUE));
	writeFileSync(join(root, SHIPPING_GLUE), pristine);
	const tuned = emitTunedGlue(root);
	const control = join(root, '.interp/control-worker.mjs');
	writeFileSync(control, pristine);
	return { root, tuned, control };
}

/** boots the interpreter on a glue, keeping the import object so a raw syscall can be called */
async function bootOn(glue: string, extra: Record<string, unknown> = {}) {
	const g = globalThis as Record<string, unknown>;
	g['location'] ??= new URL(pathToFileURL(process.cwd() + '/').href);
	g['self'] ??= globalThis;
	const { PhpBase } = await import('php-wasm/PhpBase');
	const { default: PHPFactory } = (await import(pathToFileURL(glue).href)) as {
		default: unknown;
	};
	const module = await WebAssembly.compile(readFileSync(SOCKET_WASM));
	const out: string[] = [];
	let imports!: WebAssembly.Imports;
	const php = new PhpBase(
		Promise.resolve({ default: PHPFactory }) as never,
		{
			...extra,
			ini: ['opcache.enable=0', 'memory_limit=256M'].join('\n'),
			printErr: () => {},
			instantiateWasm(
				given: WebAssembly.Imports,
				receive: (i: WebAssembly.Instance, m: WebAssembly.Module) => void
			) {
				imports = given;
				WebAssembly.instantiate(module, given).then((i) => receive(i, module));
				return {};
			}
		} as never
	) as InstanceType<typeof PhpBase> & {
		_run(code: string): Promise<unknown>;
		binary: Promise<unknown>;
	};
	php.addEventListener('output', (e) => out.push(String((e as CustomEvent).detail)));
	await php.binary;
	const env = imports.env as Record<string, (...a: number[]) => number>;
	const run = async (code: string) => {
		out.length = 0;
		await php._run(code);
		return JSON.parse(out.join('')) as Record<string, unknown>;
	};
	/** one script's printed output, and the error it raised if it raised one */
	const raw = async (code: string) => {
		out.length = 0;
		try {
			await php._run(code);
		} catch (e) {
			return { out: out.join(''), error: e instanceof Error ? e.message : String(e) };
		}
		return { out: out.join(''), error: undefined };
	};
	return { env, run, raw };
}

/** swaps in a WebSocket that records each construction and refuses it, for the length of a run */
async function recordingWebSockets<T>(body: (made: string[]) => Promise<T>): Promise<T> {
	const g = globalThis as { WebSocket?: unknown };
	const had = g.WebSocket;
	const made: string[] = [];
	g.WebSocket = class {
		constructor(url: string) {
			made.push(String(url));
			throw new Error('recorded');
		}
	};
	try {
		return await body(made);
	} finally {
		g.WebSocket = had;
	}
}

const REACH = `<?php
$r = [];
$r['fsockopen'] = @fsockopen('127.0.0.1', 9, $e1, $s1, 1) !== false;
$r['fsockopenErrno'] = $e1;
$r['streamClient'] = @stream_socket_client('tcp://127.0.0.1:9', $e2, $s2, 1) !== false;
$r['streamServer'] = @stream_socket_server('tcp://127.0.0.1:0', $e3, $s3) !== false;
$r['sockets'] = extension_loaded('sockets');
$r['socketCreate'] = function_exists('socket_create') ? (@socket_create(AF_INET, SOCK_STREAM, 0) !== false) : null;
$r['byName'] = @fsockopen('probe.invalid', 80, $e4, $s4, 1) !== false;
echo json_encode($r);`;

describe.skipIf(!have)('the socket path in the tuned glue', () => {
	it('replaces every socket syscall body and getaddrinfo, and nothing else', () => {
		const glue = readFileSync(resolve(process.cwd(), SHIPPING_GLUE), 'utf8');
		const closed = closeSockets(glue);
		for (const { name, returns, body } of SOCKET_CLOSURE) {
			expect(closed).toContain(`function ${name}(`);
			const at = closed.indexOf(`function ${name}(`);
			const head = closed.slice(at).match(/^function \w+\([^)]*\)/)![0];
			expect(closed.slice(at + head.length).startsWith(body ?? `{return ${returns}}`)).toBe(
				true
			);
		}
		expect(closed).not.toContain('Asyncify');
		expect(closeSockets(closed)).toBe(closed);
		// the fake-DNS helpers touch no network and are left as emitted
		expect(closed).toContain(
			'function __emscripten_lookup_name(name){name>>>=0;var nameString'
		);
		expect(closed).toContain('function _getnameinfo(');
	});

	it('throws when a function or its body is not what emscripten emitted', () => {
		expect(() => closeSockets('a();b()')).toThrow(
			/__asyncjs__php_stream_fetch_real_open not found/
		);
		const glue = readFileSync(resolve(process.cwd(), SHIPPING_GLUE), 'utf8');
		const changed = glue.replace(
			'function ___syscall_connect(fd,addr,addrlen,d1,d2,d3){',
			'function ___syscall_connect(fd,addr,addrlen,d1,d2,d3){return -1;'
		);
		expect(changed).not.toBe(glue);
		expect(() => closeSockets(changed.replace(/getSocketFromFD\(/g, 'x('))).toThrow(
			/no longer carries/
		);
	});

	it('never constructs a WebSocket, where the unstubbed glue constructs one', async () => {
		const { root, tuned, control } = socketArms();
		try {
			expect(readFileSync(tuned, 'utf8')).toContain(
				'function ___syscall_socket(domain,type,protocol){return -13}'
			);
			const before = await recordingWebSockets(async (made) => {
				const { run } = await bootOn(control);
				const reach = await run(REACH);
				return { made: [...made], reach };
			});
			// the control: the recorder sees the construction, so a zero below means something
			expect(
				before.made.length,
				'the unstubbed glue did not reach WebSocket'
			).toBeGreaterThan(0);

			const after = await recordingWebSockets(async (made) => {
				const { env, run } = await bootOn(tuned);
				const reach = await run(REACH);
				return {
					made,
					reach,
					socket: env['__syscall_socket']!(2, 1, 0),
					connect: env['__syscall_connect']!(3, 0, 16, 0, 0, 0),
					bind: env['__syscall_bind']!(3, 0, 16, 0, 0, 0),
					sendto: env['__syscall_sendto']!(3, 0, 0, 0, 0, 0),
					addr: env['getaddrinfo']!(0, 0, 0, 0)
				};
			});
			console.log(`[growth-glue] sockets ${JSON.stringify({ before, after })}`);
			expect(after.made, 'a WebSocket was constructed').toEqual([]);
			expect(after.reach['fsockopen']).toBe(false);
			expect(after.reach['streamClient']).toBe(false);
			expect(after.reach['streamServer']).toBe(false);
			expect(after.reach['byName'], 'a host name got past getaddrinfo').toBe(false);
			expect(after.reach['socketCreate'] ?? false).toBe(false);
			expect(after.socket).toBe(-13);
			expect([after.connect, after.bind, after.sendto]).toEqual([-88, -88, -88]);
			expect(after.addr).toBe(-4);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);

	it('refuses the two asyncjs imports without Asyncify, where the unstubbed glue reaches fetch', async () => {
		const { root, tuned, control } = socketArms();
		const g = globalThis as { Asyncify?: unknown; fetch: unknown };
		const had = { Asyncify: g.Asyncify, fetch: g.fetch };
		try {
			const arm = async (glue: string) => {
				const { env } = await bootOn(glue);
				const handled: number[] = [];
				const fetched: string[] = [];
				g.Asyncify = {
					handleAsync: (body: () => Promise<number>) => {
						handled.push(1);
						return body();
					}
				};
				g.fetch = (url: unknown) => {
					fetched.push(String(url));
					return Promise.reject(new Error('recorded'));
				};
				const open = await env['__asyncjs__php_stream_fetch_real_open']!(0, 0, 8, 0, 0);
				const wait = await env['__asyncjs__vrzno_await_internal']!(0, 8);
				return { handled: handled.length, fetched, open, wait };
			};
			const before = await arm(control);
			// the control: with Asyncify defined the stock bodies run and reach fetch
			expect(before.handled, 'the unstubbed glue did not reach Asyncify').toBe(2);
			expect(before.fetched.length, 'the unstubbed glue did not reach fetch').toBe(1);
			const after = await arm(tuned);
			console.log(`[growth-glue] asyncjs ${JSON.stringify({ before, after })}`);
			expect(after.handled, 'Asyncify was reached').toBe(0);
			expect(after.fetched, 'fetch was called').toEqual([]);
			expect(typeof after.open).toBe('number');
			expect(after.wait).toBeUndefined();
		} finally {
			g.Asyncify = had.Asyncify;
			g.fetch = had.fetch;
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);

	it('closes the vrzno bridge to everything but the cfw host functions, where the unstubbed glue is open', async () => {
		const { root, tuned, control } = socketArms();
		const g = globalThis as Record<string, unknown>;
		const had = { fetch: g['fetch'], WebSocket: g['WebSocket'] };
		try {
			const arm = async (glue: string) => {
				const calls: string[] = [];
				const { raw } = await bootOn(glue, {
					cfwStats: () => '{"queryCount":3}',
					cfwObject: () => ({ a: 1 })
				});
				// installed after boot, so only what PHP does can reach them
				g['fetch'] = (url: unknown) => {
					calls.push(`fetch ${String(url)}`);
					return Promise.resolve(undefined);
				};
				g['WebSocket'] = class {
					constructor(url: unknown) {
						calls.push(`WebSocket ${String(url)}`);
						throw new Error('recorded');
					}
				};
				try {
					const rows = await runAttempts(raw);
					rows['object reply'] = await raw(
						`<?php $f = vrzno_env('cfwObject'); echo json_encode(['type' => get_debug_type($f())]);`
					);
					return { rows, calls };
				} finally {
					g['fetch'] = had.fetch;
					g['WebSocket'] = had.WebSocket;
				}
			};
			const before = await arm(control);
			// the control: the recorders see the global fetch and a WebSocket from userland PHP, so
			// the empty lists below mean something
			expect(before.calls, 'the unstubbed glue did not reach the globals').toEqual([
				'fetch http://169.254.169.254/latest/meta-data/',
				'WebSocket wss://socket.invalid/',
				'fetch http://x.invalid/'
			]);
			expect(closedProblems(before.rows).length).toBeGreaterThan(0);

			const after = await arm(tuned);
			expect(after.calls, 'PHP reached fetch or a WebSocket').toEqual([]);
			expect(closedProblems(after.rows)).toEqual([]);
			// the control hands PHP the object, and the tuned glue hands it a null
			expect(before.rows['object reply']?.out).toContain('"type":"Vrzno');
			expect(after.rows['object reply']?.out).toBe('{"type":"null"}');
		} finally {
			g['fetch'] = had.fetch;
			g['WebSocket'] = had.WebSocket;
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);

	it('rewrites each vrzno body once, throws when one is gone, and is idempotent', () => {
		const glue = readFileSync(resolve(process.cwd(), SHIPPING_GLUE), 'utf8');
		const closed = closeVrznoBridge(glue);
		expect(closeVrznoBridge(closed)).toBe(closed);
		for (const { from, to } of VRZNO_CLOSURE) {
			expect(closed.includes(from), `${from} survived`).toBe(false);
			expect(closed.includes(to)).toBe(true);
		}
		expect(closed).not.toContain('Module.targets.add(globalThis)');
		for (const { name, from } of VRZNO_CLOSURE) {
			expect(() => closeVrznoBridge(glue.replace(from, 'x'))).toThrow(
				new RegExp(`${name} not found`)
			);
			expect(() => closeVrznoBridge(`${glue}${from}`)).toThrow(/appears twice/);
		}
	});

	it('is what the tuned glue on disk carries, so a stale file fails here', () => {
		const tuned = resolve(process.cwd(), TUNED_GLUE);
		if (!existsSync(tuned)) return;
		const glue = readFileSync(tuned, 'utf8');
		expect(glue).toContain('function ___syscall_socket(domain,type,protocol){return -13}');
		expect(glue).not.toContain('Asyncify');
		expect(glue).not.toContain('Module.targets.add(globalThis)');
		expect(glue).not.toContain('globalThis[funcName]');
	});
});
