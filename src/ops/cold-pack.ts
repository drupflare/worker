import { createHash } from 'node:crypto';
import { cmsOf } from '../util/cms';
import {
	CORE_PACK_DIGEST,
	CORE_PACK_LENGTH,
	WORDPRESS_PACK_DIGEST,
	WORDPRESS_PACK_LENGTH
} from './generated/core-pack';
import { digestBytes } from './module/integrity';
import { isPaid } from './plan';

const CHUNK_BYTES = 65_536;
const DEFAULT_CACHE_CHUNKS = 8;
const MAX_CACHE_CHUNKS = 64;
const packUrl = (prefix: string) => `https://assets.local/${prefix}/core.pf.bin`;

/**
 * resident bytes the lazy filesystem keeps when the pack is served from storage and the env sets
 * none: the cartridge's own 20 MiB buys nothing there, since an evicted file is one row read away
 */
export const COLD_PACK_BUDGET_BYTES = 4 * 1024 * 1024;

/** a layer's packed bytes, in the shape the cartridge reads them */
export interface PackBytes {
	length: number;
	residentBytes?: number;
	subarray(start: number, end: number): Uint8Array;
}

export type ColdPackSource = PackBytes & { readonly residentBytes: number };

export type ColdPackEnv = {
	ASSETS: Fetcher;
	COLD_PACK?: string;
	COLD_PACK_CACHE_CHUNKS?: string;
	LAZY_FS_BUDGET_BYTES?: string | number;
	SQL_PACK_SOURCE?: (prefix: string) => Promise<ColdPackSource | undefined>;
};

type Pin = { digest: string; length: number };

/** the pack asset prefixes this module stages, each with the digest and length of its shipped file */
const SHIPPED_PINS: Readonly<Record<string, Pin>> = {
	'drupal-pf': { digest: CORE_PACK_DIGEST, length: CORE_PACK_LENGTH },
	'wordpress/pf': { digest: WORDPRESS_PACK_DIGEST, length: WORDPRESS_PACK_LENGTH }
};

/** a stored chunk that is missing or does not match its hash; the pack is staged again next boot */
export class ColdPackCorrupt extends Error {
	constructor(readonly part: number) {
		super(`cold-pack chunk ${part} is missing or differs from its hash`);
		this.name = 'ColdPackCorrupt';
	}
}

/** how many chunks a source keeps in memory, from `COLD_PACK_CACHE_CHUNKS` */
export function coldPackCacheChunks(raw: string | undefined): number {
	const value = Number(raw ?? DEFAULT_CACHE_CHUNKS);
	if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_CACHE_CHUNKS;
	return Math.min(value, MAX_CACHE_CHUNKS);
}

/**
 * A synchronous byte source over the staged chunks, which keeps at most `maximum` of them in
 * memory. Every chunk read from storage is checked against its stored hash.
 */
export function sqlPackSource(
	sql: SqlStorage,
	digest: string,
	length: number,
	options: { maximum?: number } = {}
): ColdPackSource {
	const maximum = options.maximum ?? DEFAULT_CACHE_CHUNKS;
	const cache = new Map<number, Uint8Array>();

	const chunk = (part: number): Uint8Array => {
		const held = cache.get(part);
		if (held) {
			// a hit moves to the back, so the front is the least recently read
			cache.delete(part);
			cache.set(part, held);
			return held;
		}
		const row = sql
			.exec<{ hash: string; bytes: ArrayBuffer }>(
				'SELECT hash, bytes FROM cfw_pack_chunk WHERE digest = ? AND part = ?',
				digest,
				part
			)
			.toArray()[0];
		const bytes = row ? new Uint8Array(row.bytes) : undefined;
		const size = Math.min(CHUNK_BYTES, length - part * CHUNK_BYTES);
		if (!row || !bytes || bytes.length !== size || digestBytes(bytes) !== row.hash) {
			sql.exec('DELETE FROM cfw_pack_root WHERE digest = ?', digest);
			throw new ColdPackCorrupt(part);
		}
		cache.set(part, bytes);
		if (cache.size > maximum) {
			cache.delete(cache.keys().next().value as number);
		}
		return bytes;
	};

	return {
		length,
		get residentBytes() {
			let total = 0;
			for (const bytes of cache.values()) total += bytes.length;
			return total;
		},
		subarray(start, end) {
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
				throw new RangeError('cold-pack range is not an integer');
			}
			if (start < 0 || end < start || end > length) {
				throw new RangeError(`cold-pack range ${start}..${end} is outside 0..${length}`);
			}
			const out = new Uint8Array(end - start);
			for (let at = start; at < end;) {
				const part = Math.floor(at / CHUNK_BYTES);
				const bytes = chunk(part);
				const offset = at - part * CHUNK_BYTES;
				const take = Math.min(end - at, bytes.length - offset);
				out.set(bytes.subarray(offset, offset + take), at - start);
				at += take;
			}
			return out;
		}
	};
}

/** copies the shipped pack into chunk rows, refusing one that is not the pinned bytes */
async function stagePack(
	assets: Fetcher,
	sql: SqlStorage,
	pin: Pin,
	prefix: string
): Promise<void> {
	const response = await assets.fetch(new Request(packUrl(prefix)));
	if (!response.ok || !response.body)
		throw new Error(`cold-pack asset answered ${response.status}`);
	const reader = response.body.getReader();
	const whole = createHash('sha256');
	const buffer = new Uint8Array(CHUNK_BYTES);
	let used = 0;
	let total = 0;
	let part = 0;
	const put = (bytes: Uint8Array) => {
		const copy = bytes.slice();
		sql.exec(
			'INSERT OR REPLACE INTO cfw_pack_chunk (digest, part, hash, bytes) VALUES (?, ?, ?, ?)',
			pin.digest,
			part,
			digestBytes(copy),
			copy
		);
		part += 1;
	};
	try {
		for (;;) {
			const read = await reader.read();
			if (read.done) break;
			whole.update(read.value);
			total += read.value.length;
			if (total > pin.length) throw new Error('cold-pack asset is longer than pinned');
			for (let at = 0; at < read.value.length;) {
				const take = Math.min(buffer.length - used, read.value.length - at);
				buffer.set(read.value.subarray(at, at + take), used);
				used += take;
				at += take;
				if (used === buffer.length) {
					put(buffer);
					used = 0;
				}
			}
		}
		if (used) put(buffer.subarray(0, used));
		if (total !== pin.length || whole.digest('hex') !== pin.digest) {
			throw new Error('cold-pack asset differs from the pinned digest');
		}
	} catch (error) {
		// a refused copy leaves nothing for a later read to find
		sql.exec('DELETE FROM cfw_pack_chunk WHERE digest = ?', pin.digest);
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
	sql.exec(
		'INSERT OR REPLACE INTO cfw_pack_root (digest, length) VALUES (?, ?)',
		pin.digest,
		total
	);
}

/**
 * Whether the pack is served from storage. `COLD_PACK` decides when it is set. When it is not, the
 * pack is staged except for WordPress on the free plan: every WordPress request mounts afresh, so
 * the staged pack adds 147 to 281 row reads to each one (189 to 354 on a search page) and the free
 * read bound falls from about 26,500 renders a day to about 14,100, for 6.6 MiB that does not bind.
 */
export function coldPackEnabled(env: {
	COLD_PACK?: string;
	CMS?: unknown;
	PLAN?: string;
}): boolean {
	if (env.COLD_PACK !== undefined) return env.COLD_PACK !== '0';
	return !(cmsOf(env) === 'wordpress' && !isPaid(env));
}

/**
 * `env` with a `SQL_PACK_SOURCE` that serves the Drupal or WordPress pack from the object's own
 * storage when {@link coldPackEnabled} says so, and `env` itself otherwise.
 *
 * It also sets `LAZY_FS_BUDGET_BYTES` to {@link COLD_PACK_BUDGET_BYTES} when the env names none.
 *
 * A pack that cannot be staged or does not match the pinned digest answers undefined, so the mount
 * reads it from ASSETS as it does with the flag off.
 */
export function coldPackEnv<E extends ColdPackEnv>(
	site: { sql: SqlStorage; env: E },
	env: E,
	options: { pin?: Pin; pins?: Record<string, Pin>; log?: (line: string) => void } = {}
): E {
	if (!coldPackEnabled(site.env)) return env;
	const pins: Record<string, Pin> = {
		...SHIPPED_PINS,
		...(options.pin ? { 'drupal-pf': options.pin } : {}),
		...options.pins
	};
	const log = options.log ?? console.warn;
	return {
		...env,
		LAZY_FS_BUDGET_BYTES: env.LAZY_FS_BUDGET_BYTES ?? String(COLD_PACK_BUDGET_BYTES),
		SQL_PACK_SOURCE: async (prefix: string) => {
			const pin = pins[prefix];
			if (!pin) return undefined;
			try {
				const sql = site.sql;
				sql.exec(
					'CREATE TABLE IF NOT EXISTS cfw_pack_chunk (digest TEXT NOT NULL, part INTEGER NOT NULL, hash TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (digest, part))'
				);
				sql.exec(
					'CREATE TABLE IF NOT EXISTS cfw_pack_root (digest TEXT PRIMARY KEY, length INTEGER NOT NULL)'
				);
				const staged = sql
					.exec('SELECT length FROM cfw_pack_root WHERE digest = ?', pin.digest)
					.toArray();
				// the original binding: the one `packCachedEnv` wraps keeps the whole blob
				if (staged.length === 0) {
					await stagePack(site.env.ASSETS, sql, pin, prefix);
					// a pack from an earlier worker version is dead weight once the new one is staged
					const live = Object.values(pins).map((p) => p.digest);
					const marks = live.map(() => '?').join(', ');
					sql.exec(`DELETE FROM cfw_pack_chunk WHERE digest NOT IN (${marks})`, ...live);
					sql.exec(`DELETE FROM cfw_pack_root WHERE digest NOT IN (${marks})`, ...live);
				}
				return sqlPackSource(sql, pin.digest, pin.length, {
					maximum: coldPackCacheChunks(site.env.COLD_PACK_CACHE_CHUNKS)
				});
			} catch (error) {
				log(`cold-pack unavailable, reading the pack from assets: ${String(error)}`);
				return undefined;
			}
		}
	};
}
