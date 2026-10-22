/**
 * Integrity records for installed module files, kept in sealed storage.
 *
 * `cfw_module_file` is SQL, so any PHP with a database write can plant a row that is mounted on
 * every boot. The record of what each row should hold lives in key-value storage, which the SQL
 * bridge cannot read or write, so a row with no record or a different digest is not trusted.
 *
 * A record is `path -> sha256 hex` of the file's UTF-8 bytes, grouped per package in chunks of at
 * most {@link MODSUM_CHUNK_BYTES} under `modsum:<package>:<index>`. A Durable Object with SQLite
 * storage takes a key and value up to 2 MB combined, and a legacy key-value object 128 KiB
 * (developers.cloudflare.com/durable-objects/platform/limits), so 100 KiB fits both.
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { type SealedStore, tokenMatches } from './site-secrets';

/** sealed key that says the rows already on the site were adopted once */
export const MODSUM_ADOPTED_KEY = 'modsum:adopted';

/** the most bytes one record chunk may hold; under every platform value limit */
export const MODSUM_CHUNK_BYTES = 100 * 1024;

/** how many refused paths the stats keep, and how many distinct paths warn */
export const FINDING_PATHS = 10;
const WARN_PATHS = 1000;

const CHUNK_KEY = /^modsum:([^:]+):(\d{4})$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** how a mount treated the installed files */
export type IntegrityMode = 'enforcing' | 'unclaimed' | 'replica';

/** what the integrity check has seen on this object, shown by `/__serve-stats` */
export type IntegrityStats = {
	mode: IntegrityMode;
	/** records read at the last mount */
	records: number;
	/** rows adopted at the last mount that adopted */
	adopted: number;
	/** files hashed on first open */
	checked: number;
	/** files refused: no record, or bytes that do not match */
	refused: number;
	/** the first few refused paths */
	paths: string[];
	/** paths that already logged a warning */
	warned: Set<string>;
};

/** a fresh stats object */
export function emptyIntegrityStats(): IntegrityStats {
	return {
		mode: 'unclaimed',
		records: 0,
		adopted: 0,
		checked: 0,
		refused: 0,
		paths: [],
		warned: new Set()
	};
}

/** the JSON a stats object answers with (the warned set stays inside) */
export function integrityReport(stats: IntegrityStats | undefined): Omit<IntegrityStats, 'warned'> {
	const s = stats ?? emptyIntegrityStats();
	return {
		mode: s.mode,
		records: s.records,
		adopted: s.adopted,
		checked: s.checked,
		refused: s.refused,
		paths: [...s.paths]
	};
}

/**
 * sha256 hex of a file's bytes; synchronous because the mount's load callback cannot await.
 *
 * `node:crypto` rather than `@noble/hashes`: 6.1 MB over 1,040 files read 4-10 ms against 550 ms on
 * the local workerd (30 ms for noble on node).
 */
export function digestBytes(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** sha256 hex of a stored source string, as the mount will read it back */
export function digestSource(source: string): string {
	return digestBytes(new TextEncoder().encode(source));
}

/** whether a record holds this digest, compared in constant time; a malformed record never does */
export function recordMatches(record: string | undefined, digest: string): boolean {
	return record !== undefined && HEX64.test(record) && tokenMatches(digest, record);
}

/** counts a refusal, keeping the first paths and warning once per distinct path */
export function noteRefusal(stats: IntegrityStats, path: string, reason: string): void {
	stats.refused++;
	if (stats.warned.has(path) || stats.warned.size >= WARN_PATHS) return;
	stats.warned.add(path);
	if (stats.paths.length < FINDING_PATHS) stats.paths.push(path);
	console.warn(JSON.stringify({ moduleIntegrity: { path, reason } }));
}

function chunkPrefix(pkg: string): string {
	return `modsum:${encodeURIComponent(pkg)}:`;
}

/** a chunk's entries; text that is not a JSON object yields nothing, a bad entry is dropped */
function parseChunk(value: string): [string, string][] {
	try {
		const parsed: unknown = JSON.parse(value);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
		return Object.entries(parsed).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && HEX64.test(entry[1])
		);
	} catch {
		return [];
	}
}

/** every record of one package */
export function readPackageRecords(store: SealedStore, pkg: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const [, value] of store.list(chunkPrefix(pkg))) {
		for (const [path, hash] of parseChunk(value)) out.set(path, hash);
	}
	return out;
}

/**
 * Every record on the site, by path. A path that two chunks disagree about reads as an empty
 * record, which matches nothing.
 */
export function readAllRecords(store: SealedStore): Map<string, string> {
	const out = new Map<string, string>();
	for (const [key, value] of store.list('modsum:')) {
		if (!CHUNK_KEY.test(key)) continue;
		for (const [path, hash] of parseChunk(value)) {
			const seen = out.get(path);
			out.set(path, seen === undefined || seen === hash ? hash : '');
		}
	}
	return out;
}

/**
 * Replaces a package's records, writing only the chunks that changed and deleting the ones past
 * the end. Answers the number of puts and deletes, which are the rows it cost.
 */
export function writePackageRecords(
	store: SealedStore,
	pkg: string,
	records: ReadonlyMap<string, string>
): number {
	const encoder = new TextEncoder();
	const chunks: [string, string][][] = [];
	let current: [string, string][] = [];
	let size = 2;
	for (const path of [...records.keys()].sort()) {
		const cost = encoder.encode(JSON.stringify(path)).length + 64 + 4;
		if (current.length > 0 && size + cost > MODSUM_CHUNK_BYTES) {
			chunks.push(current);
			current = [];
			size = 2;
		}
		current.push([path, records.get(path) as string]);
		size += cost;
	}
	if (current.length > 0) chunks.push(current);
	const prefix = chunkPrefix(pkg);
	const held = new Map(store.list(prefix));
	let changed = 0;
	chunks.forEach((chunk, index) => {
		const key = prefix + String(index).padStart(4, '0');
		const value = JSON.stringify(Object.fromEntries(chunk));
		if (held.get(key) !== value) {
			store.put(key, value);
			changed++;
		}
		held.delete(key);
	});
	for (const key of held.keys()) {
		store.delete(key);
		changed++;
	}
	return changed;
}

/** whether the rows already on the site were adopted */
export function isAdopted(store: SealedStore): boolean {
	return store.get(MODSUM_ADOPTED_KEY) !== undefined;
}

/** records that the rows already on the site were adopted */
export function markAdopted(store: SealedStore): void {
	store.put(MODSUM_ADOPTED_KEY, '1');
}
