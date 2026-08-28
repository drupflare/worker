import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * What the four one-flag arms off `long64` changed, checked against the BINARIES.
 *
 * Demand at `DRUPFLARE_ABI_STEP=0`, byte-identical across two runs. The first three share a peak of
 * 113,770,496 at the shipping 0.13 step, and that is QUANTISATION rather than equality -- the rung
 * is `align(max(demand, old * 1.13))`, so gaps under one rung vanish.
 *
 * | arm      | zstd -22  | install demand | auth demand |
 * | -------- | --------- | -------------- | ----------- |
 * | long64   | 2,671,753 | 106,430,464    | 112,918,528 |
 * | emmalloc | 2,668,264 | 106,692,608    | 113,115,136 |
 * | bulkmem  | 2,671,268 | 106,430,464    | 112,787,456 |
 * | impmem   | 2,671,684 | 106,430,464    | 112,721,920 |
 *
 * `zendalloc` is the one arm quantisation did not hide: it peaks at 302,907,392 on the install and
 * 342,294,528 authenticated, against long64's 113,770,496 and 128,581,632 on the same run. It is
 * excluded from {@link ARMS} because every assertion below is about a build that fits.
 */

const ARMS = ['long64', 'emmalloc', 'bulkmem', 'impmem'] as const;
const wasmFor = (arm: string) => `.interp/php8.5-${arm}.wasm`;
const haveAll = ARMS.every((a) => existsSync(wasmFor(a)));

// `@cloudflare/workers-types` shadows the node global and types `Module` as abstract, so the
// constructor call has to go through the runtime value rather than the shadowed declaration
const WasmModule = WebAssembly.Module as unknown as new (b: BufferSource) => WebAssembly.Module;
const moduleFor = (arm: string) => new WasmModule(readFileSync(wasmFor(arm)));

describe.skipIf(!haveAll)('the one-flag ABI arms, checked against the binaries', () => {
	it('drops the memcpy import ONLY on the bulk-memory arm', () => {
		// `_emscripten_memcpy_js` is emitted only when the feature is off, so its absence is the
		// arm working. Without this the arm could have built with the flag silently ignored --
		// which is what happened when `-mbulk-memory` reached the link line alone
		const imports = (arm: string) =>
			WebAssembly.Module.imports(moduleFor(arm)).map((i) => i.name);
		expect(imports('bulkmem')).not.toContain('_emscripten_memcpy_js');
		for (const arm of ['long64', 'emmalloc', 'impmem']) {
			expect(imports(arm), `${arm} should still cross into JS for memcpy`).toContain(
				'_emscripten_memcpy_js'
			);
		}
	});

	it('imports its memory ONLY on the IMPORTED_MEMORY arm, which is what a pre-fill needs', () => {
		// the precondition for restoring INTO the memory rather than after it: when JS owns the
		// `WebAssembly.Memory`, it can be written before the module is instantiated
		const mem = (arm: string) => {
			const m = moduleFor(arm);
			return {
				imported: WebAssembly.Module.imports(m).filter((i) => i.kind === 'memory'),
				exported: WebAssembly.Module.exports(m).filter((e) => e.kind === 'memory')
			};
		};
		const imp = mem('impmem');
		expect(imp.imported.map((i) => `${i.module}.${i.name}`)).toEqual(['env.memory']);
		expect(imp.exported).toHaveLength(0);
		for (const arm of ['long64', 'emmalloc', 'bulkmem']) {
			expect(mem(arm).imported, `${arm} creates its own memory`).toHaveLength(0);
			expect(mem(arm).exported.map((e) => e.name)).toEqual(['memory']);
		}
	});

	it('applies 15,619 ACTIVE data segments, which is what refuses a pre-filled image', () => {
		// P75's own refutation condition: active segments write into the imported memory DURING
		// instantiation, so a pre-fill keeps everything above 3,413,674 and loses the static region
		// under it -- SPLITTING the restore rather than removing it. Passive segments are the way out
		const dataSection = (arm: string) => {
			const buf = readFileSync(wasmFor(arm));
			let o = 8;
			while (o < buf.length) {
				const id = buf[o++];
				let size = 0;
				let shift = 0;
				let b: number;
				do {
					b = buf[o++] as number;
					size |= (b & 0x7f) << shift;
					shift += 7;
				} while (b & 0x80);
				if (id === 11) return { start: o, size };
				o += size;
			}
			return null;
		};
		const leb = (buf: Buffer, at: number): [number, number] => {
			let v = 0;
			let shift = 0;
			let b: number;
			let o = at;
			do {
				b = buf[o++] as number;
				v |= (b & 0x7f) << shift;
				shift += 7;
			} while (b & 0x80);
			return [v >>> 0, o];
		};

		for (const arm of ARMS) {
			const sec = dataSection(arm);
			expect(sec, `${arm} has a data section`).not.toBeNull();
			const buf = readFileSync(wasmFor(arm));
			let [count, o] = leb(buf, sec!.start);
			let active = 0;
			let hi = 0;
			for (let i = 0; i < count; i++) {
				let flags: number;
				[flags, o] = leb(buf, o);
				let offset = 0;
				if (flags === 0 || flags === 2) {
					if (flags === 2) [, o] = leb(buf, o);
					if (buf[o] === 0x41) {
						o++;
						[offset, o] = leb(buf, o);
					}
					while (buf[o] !== 0x0b) o++;
					o++;
					active++;
				}
				let size: number;
				[size, o] = leb(buf, o);
				if (flags === 0 || flags === 2) hi = Math.max(hi, offset + size);
				o += size;
			}
			// every segment is ACTIVE, so none of this is under the host's control
			expect(active, `${arm} active segments`).toBe(count);
			// and they reach only into the low 4 MiB, far under the 96 MB the heap starts at
			expect(hi, `${arm} data span`).toBeLessThan(4 * 1024 * 1024);
		}
	});

	it.skipIf(!existsSync(wasmFor('zendalloc')))(
		'reads the allocator flag out of the data section rather than off the build log',
		() => {
			// the arm is `long64` plus one patched literal, so the wasm is +1 byte and a green build
			// proves nothing. The shipping build must carry `=0` and the arm `=1`, both directions,
			// because a patch that matched no file produces a binary identical to its control
			const flag = (arm: string, want: string) =>
				readFileSync(wasmFor(arm)).includes(Buffer.from(`USE_ZEND_ALLOC=${want}`));
			expect(flag('zendalloc', '1'), 'the zendalloc patch did not take').toBe(true);
			expect(flag('zendalloc', '0')).toBe(false);
			expect(flag('long64', '0'), 'the control lost its baked-in flag').toBe(true);
			expect(flag('long64', '1')).toBe(false);
		}
	);

	it('keeps every arm inside the bundle ceiling, so size decides nothing here', () => {
		// the widest spread is 3,489 zstd bytes against 177,551 of headroom, so none of these is a
		// size decision and emmalloc must be scored on heap instead
		const raw = Object.fromEntries(ARMS.map((a) => [a, readFileSync(wasmFor(a)).byteLength]));
		expect(raw.emmalloc).toBeLessThan(raw.long64 as number);
		// impmem changes who CREATES the memory, not what the code does, so it is long64 +/- a byte
		expect(Math.abs((raw.impmem as number) - (raw.long64 as number))).toBeLessThanOrEqual(8);
	});
});
