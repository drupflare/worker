import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	coldPackCacheChunks,
	ColdPackCorrupt,
	coldPackEnv,
	type ColdPackEnv
} from '../../../src/ops/cold-pack';
import { freshSite, inObject, type ServeDo } from '../../helpers/serve-do';

/**
 * COLD_PACK: the Drupal pack is staged into the object's storage once and read from there.
 *
 * The staging pin is injected (`options.pin`), so the specs run on a three-chunk pack instead of the
 * shipped 13 MB one; the pin the shipped file carries is checked by `gen-core-pack.ts --check`.
 */

const CHUNK = 65_536;

function packBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	let x = 12345;
	for (let i = 0; i < length; i++) {
		x = (x * 1103515245 + 12345) & 0x7fffffff;
		bytes[i] = x >> 16;
	}
	return bytes;
}

const pinOf = (bytes: Uint8Array) => ({
	digest: createHash('sha256').update(bytes).digest('hex'),
	length: bytes.length
});

function fakeAssets(bytes: Uint8Array, status = 200) {
	const calls = { fetched: 0 };
	const assets = {
		fetch: async () => {
			calls.fetched += 1;
			return new Response(status === 200 ? bytes.slice() : null, { status });
		}
	} as unknown as Fetcher;
	return { assets, calls };
}

function siteOf(obj: ServeDo, env: ColdPackEnv) {
	return { sql: obj.sql as unknown as SqlStorage, env };
}

const rowCount = (obj: ServeDo, table: string) =>
	Number(
		(obj.sql as unknown as SqlStorage).exec(`SELECT COUNT(*) AS n FROM ${table}`).one()['n']
	);

describe('coldPackEnv', () => {
	it('returns the env it was given when the flag is unset', async () => {
		const out = await inObject(freshSite(), (obj) => {
			const env: ColdPackEnv = { ASSETS: fakeAssets(packBytes(10)).assets };
			return coldPackEnv(siteOf(obj, env), env) === env;
		});
		expect(out).toBe(true);
	});

	it('returns the env it was given for any value other than 1', async () => {
		const out = await inObject(freshSite(), (obj) => {
			const env: ColdPackEnv = { ASSETS: fakeAssets(packBytes(10)).assets, COLD_PACK: '0' };
			return coldPackEnv(siteOf(obj, env), env) === env;
		});
		expect(out).toBe(true);
	});

	it('serves the pack it staged, across chunk boundaries and the short last chunk', async () => {
		const bytes = packBytes(CHUNK * 2 + 1_234);
		const out = await inObject(freshSite(), async (obj) => {
			const { assets, calls } = fakeAssets(bytes);
			const env: ColdPackEnv = { ASSETS: assets, COLD_PACK: '1' };
			const wrapped = coldPackEnv(siteOf(obj, env), env, { pin: pinOf(bytes) });
			const source = await wrapped.SQL_PACK_SOURCE?.('drupal-pf');
			const other = await wrapped.SQL_PACK_SOURCE?.('drupal-opc');
			if (!source) return undefined;
			const whole = source.subarray(0, source.length);
			const across = source.subarray(CHUNK - 10, CHUNK + 10);
			const tail = source.subarray(bytes.length - 5, bytes.length);
			// a second mount finds the staged rows and fetches nothing
			await wrapped.SQL_PACK_SOURCE?.('drupal-pf');
			return {
				length: source.length,
				other,
				whole: Buffer.compare(whole, bytes) === 0,
				across: Buffer.compare(across, bytes.subarray(CHUNK - 10, CHUNK + 10)) === 0,
				tail: Buffer.compare(tail, bytes.subarray(bytes.length - 5)) === 0,
				chunks: rowCount(obj, 'cfw_pack_chunk'),
				roots: rowCount(obj, 'cfw_pack_root'),
				fetched: calls.fetched
			};
		});
		expect(out).toEqual({
			length: bytes.length,
			other: undefined,
			whole: true,
			across: true,
			tail: true,
			chunks: 3,
			roots: 1,
			fetched: 1
		});
	});

	it('keeps at most COLD_PACK_CACHE_CHUNKS chunks in memory', async () => {
		const bytes = packBytes(CHUNK * 3);
		const resident = await inObject(freshSite(), async (obj) => {
			const env: ColdPackEnv = {
				ASSETS: fakeAssets(bytes).assets,
				COLD_PACK: '1',
				COLD_PACK_CACHE_CHUNKS: '2'
			};
			const wrapped = coldPackEnv(siteOf(obj, env), env, { pin: pinOf(bytes) });
			const source = await wrapped.SQL_PACK_SOURCE?.('drupal-pf');
			source?.subarray(0, source.length);
			return source?.residentBytes;
		});
		expect(resident).toBe(CHUNK * 2);
	});

	it('detaches a read range only when RELEASE_EVICTED is 1', async () => {
		const bytes = packBytes(CHUNK);
		const out = await inObject(freshSite(), async (obj) => {
			const read = async (release: string | undefined) => {
				const env: ColdPackEnv = {
					ASSETS: fakeAssets(bytes).assets,
					COLD_PACK: '1',
					RELEASE_EVICTED: release
				};
				const wrapped = coldPackEnv(siteOf(obj, env), env, { pin: pinOf(bytes) });
				const source = await wrapped.SQL_PACK_SOURCE?.('drupal-pf');
				const range = source?.subarray(0, 100);
				if (!source || !range) return -1;
				source.releaseRange?.(range);
				return range.byteLength;
			};
			return { off: await read(undefined), on: await read('1') };
		});
		expect(out).toEqual({ off: 100, on: 0 });
	});

	it('refuses an asset that differs from the pin, stages nothing, and answers undefined', async () => {
		const good = packBytes(CHUNK + 500);
		const bad = packBytes(CHUNK + 500);
		bad[CHUNK + 3]! ^= 0xff;
		const out = await inObject(freshSite(), async (obj) => {
			const lines: string[] = [];
			const env: ColdPackEnv = { ASSETS: fakeAssets(bad).assets, COLD_PACK: '1' };
			const wrapped = coldPackEnv(siteOf(obj, env), env, {
				pin: pinOf(good),
				log: (line) => lines.push(line)
			});
			const source = await wrapped.SQL_PACK_SOURCE?.('drupal-pf');
			return {
				source,
				chunks: rowCount(obj, 'cfw_pack_chunk'),
				roots: rowCount(obj, 'cfw_pack_root'),
				logged: lines.length
			};
		});
		expect(out).toEqual({ source: undefined, chunks: 0, roots: 0, logged: 1 });
	});

	it('answers undefined when the asset is missing, so the mount reads ASSETS as before', async () => {
		const out = await inObject(freshSite(), async (obj) => {
			const lines: string[] = [];
			const env: ColdPackEnv = {
				ASSETS: fakeAssets(packBytes(10), 404).assets,
				COLD_PACK: '1'
			};
			const wrapped = coldPackEnv(siteOf(obj, env), env, {
				pin: pinOf(packBytes(10)),
				log: (line) => lines.push(line)
			});
			return { source: await wrapped.SQL_PACK_SOURCE?.('drupal-pf'), logged: lines.length };
		});
		expect(out).toEqual({ source: undefined, logged: 1 });
	});

	it('refuses a stored chunk that no longer matches its hash, and stages again on the next mount', async () => {
		const bytes = packBytes(CHUNK * 2);
		const out = await inObject(freshSite(), async (obj) => {
			const { assets, calls } = fakeAssets(bytes);
			const env: ColdPackEnv = { ASSETS: assets, COLD_PACK: '1' };
			const wrapped = coldPackEnv(siteOf(obj, env), env, { pin: pinOf(bytes) });
			await wrapped.SQL_PACK_SOURCE?.('drupal-pf');
			const sql = obj.sql as unknown as SqlStorage;
			sql.exec('UPDATE cfw_pack_chunk SET bytes = ? WHERE part = 1', new Uint8Array(CHUNK));
			const damaged = await wrapped.SQL_PACK_SOURCE?.('drupal-pf');
			let caught: unknown;
			try {
				damaged?.subarray(CHUNK, CHUNK + 10);
			} catch (error) {
				caught = error;
			}
			const rootsAfter = rowCount(obj, 'cfw_pack_root');
			const healed = await wrapped.SQL_PACK_SOURCE?.('drupal-pf');
			return {
				corrupt: caught instanceof ColdPackCorrupt,
				part: caught instanceof ColdPackCorrupt ? caught.part : -1,
				rootsAfter,
				healed: healed
					? Buffer.compare(healed.subarray(0, healed.length), bytes) === 0
					: false,
				fetched: calls.fetched
			};
		});
		expect(out).toEqual({ corrupt: true, part: 1, rootsAfter: 0, healed: true, fetched: 2 });
	});

	it('rejects a range outside the pack', async () => {
		const bytes = packBytes(100);
		const out = await inObject(freshSite(), async (obj) => {
			const env: ColdPackEnv = { ASSETS: fakeAssets(bytes).assets, COLD_PACK: '1' };
			const wrapped = coldPackEnv(siteOf(obj, env), env, { pin: pinOf(bytes) });
			const source = await wrapped.SQL_PACK_SOURCE?.('drupal-pf');
			const attempt = (start: number, end: number) => {
				try {
					source?.subarray(start, end);
					return 'ok';
				} catch (error) {
					return error instanceof RangeError ? 'RangeError' : 'other';
				}
			};
			return [attempt(-1, 5), attempt(5, 4), attempt(0, 101), attempt(0.5, 4)];
		});
		expect(out).toEqual(['RangeError', 'RangeError', 'RangeError', 'RangeError']);
	});
});

describe('coldPackCacheChunks', () => {
	it('defaults to 8, caps at 64 and ignores a value that is not a positive integer', () => {
		expect(coldPackCacheChunks(undefined)).toBe(8);
		expect(coldPackCacheChunks('3')).toBe(3);
		expect(coldPackCacheChunks('1000')).toBe(64);
		expect(coldPackCacheChunks('0')).toBe(8);
		expect(coldPackCacheChunks('many')).toBe(8);
	});
});
