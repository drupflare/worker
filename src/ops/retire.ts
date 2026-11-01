import {
	AUDIT_GENESIS,
	type AuditCall,
	type AuditEntry,
	entryHash,
	isAuditEntry
} from './owner-audit';
import { siteKvKey } from './site-id';

/** the CONFIG_KV key holding the retirement log, a hash chain in the shape of the owner audit log */
export const RETIRE_LOG_KEY = 'site:retired-log';

/** the KV surface the retirement writes touch; `list` and `delete` are absent on a stub */
export type RetireKv = {
	get(key: string): Promise<string | null>;
	put?(key: string, value: string): Promise<void>;
	delete?(key: string): Promise<void>;
	list?(options: {
		prefix: string;
		cursor?: string;
	}): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
};

/** the retained entries, with anything malformed dropped rather than trusted */
export function parseRetireLog(raw: string | null): AuditEntry[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter(isAuditEntry) : [];
	} catch {
		return [];
	}
}

/**
 * Appends one retirement to the log and returns the entry.
 *
 * The log lives in the front worker's `CONFIG_KV` because the object's own audit ring is in the
 * storage `deleteAll()` removes. The entry's seq and hash also go to `console.log`, which
 * Workers observability keeps. Read-modify-write on one key, so two retirements at once can lose
 * one; they are an operator's hand and seconds apart at the closest.
 */
export async function appendRetireLog(
	kv: RetireKv & { put: NonNullable<RetireKv['put']> },
	call: AuditCall
): Promise<AuditEntry> {
	const log = parseRetireLog(await kv.get(RETIRE_LOG_KEY));
	const last = log.at(-1);
	const body = { ...call, seq: (last?.seq ?? 0) + 1, prev: last?.hash ?? AUDIT_GENESIS };
	const entry: AuditEntry = { ...body, hash: await entryHash(body) };
	await kv.put(RETIRE_LOG_KEY, JSON.stringify([...log, entry]));
	console.log(JSON.stringify({ retire: { seq: entry.seq, hash: entry.hash } }));
	return entry;
}

/** a host mapping page is 1,000 keys; a deployment with more is not a shape this serves */
const HOST_MAP_PAGES = 10;

/**
 * Deletes every `site:host:<host>` key that points at `site`, so no host resolves to it again.
 *
 * @returns the hosts removed, or undefined when the binding cannot list or delete
 */
export async function forgetHostMappings(
	kv: RetireKv | undefined,
	site: string
): Promise<string[] | undefined> {
	if (!kv || typeof kv.list !== 'function' || typeof kv.delete !== 'function') return undefined;
	const prefix = siteKvKey('');
	const removed: string[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < HOST_MAP_PAGES; page++) {
		const listed = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
		for (const { name } of listed.keys) {
			if ((await kv.get(name)) !== site) continue;
			await kv.delete(name);
			removed.push(name.slice(prefix.length));
		}
		if (listed.list_complete || !listed.cursor) break;
		cursor = listed.cursor;
	}
	return removed;
}
