export const PAGE_SHIFT = 16;
export const MISS_ENTRY = -1;
export const TABLE_ENTRIES = 65536;

export class TranslationMiss extends Error {
	address: number;
	bytes: number;
	constructor(address: number, bytes: number, what = 'page miss') {
		super(
			`folio.translate: ${what} at 0x${address.toString(16).padStart(8, '0')} (${bytes} bytes)`
		);
		this.name = 'TranslationMiss';
		this.address = address;
		this.bytes = bytes;
	}
}

/** The i32 delta table for a fully resident, identity-mapped memory; pages past `pages` read as miss. */
export function initTable(memory: WebAssembly.Memory, tableBase: number, pages: number) {
	const table = new Int32Array(memory.buffer, tableBase, TABLE_ENTRIES);
	table.fill(MISS_ENTRY);
	table.fill(0, 0, pages);
}

export interface TranslationHost {
	imports: { folio: Record<string, (...args: number[]) => number | void> };
	counts: { slow: number; straddles: number };
}

/** Host imports for a translated module: a miss and a stack-window violation trap with a typed error. */
export function translationHost(memory: WebAssembly.Memory, tableBase: number): TranslationHost {
	const counts = { slow: 0, straddles: 0 };
	return {
		counts,
		imports: {
			folio: {
				slow(pointer: number, offset: number, bytes: number) {
					counts.slow++;
					const address = (pointer >>> 0) + offset;
					if (address > 0xffffffff)
						throw new TranslationMiss(address >>> 0, bytes, 'address wrap');
					const table = new Int32Array(memory.buffer, tableBase, TABLE_ENTRIES);
					const first = address >>> PAGE_SHIFT;
					const entry = table[first]!;
					if (entry === MISS_ENTRY) throw new TranslationMiss(address, bytes);
					const last = (address + bytes - 1) >>> 0;
					if (last >>> PAGE_SHIFT === first) return entry;
					counts.straddles++;
					const next = first + 1;
					if (next >= TABLE_ENTRIES || table[next] !== entry)
						throw new TranslationMiss(
							(next << PAGE_SHIFT) >>> 0,
							bytes,
							'page straddle'
						);
					return entry;
				},
				stack_miss(pointer: number) {
					throw new TranslationMiss(pointer >>> 0, 0, 'stack window');
				}
			}
		}
	};
}
