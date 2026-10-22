import { sha256Hex } from './owner-recovery';
import type { SealedStore } from './site-secrets';

/** entries kept; the one that falls off the end leaves its hash behind as the chain's floor */
export const AUDIT_RING = 1000;

/** the `prev` of the first entry a site ever writes */
export const AUDIT_GENESIS = '0'.repeat(64);

/** the actor recorded for a rotation, where no token is presented */
export const AUDIT_ACTOR_PROOF = 'proof';

const HEAD_KEY = 'audit:head';
const FLOOR_KEY = 'audit:floor';
const FAIL_KEY = 'audit:fail';
const SLOT_PREFIX = 'audit:e:';

/** one owner call, chained to the one before it */
export type AuditEntry = {
	seq: number;
	at: number;
	route: string;
	method: string;
	status: number;
	actor: string;
	prev: string;
	hash: string;
};

/** a position in the chain: the entry's sequence number and its hash */
export type AuditPoint = { seq: number; hash: string };

/** the fields of an entry the caller supplies */
export type AuditCall = Pick<AuditEntry, 'at' | 'route' | 'method' | 'status' | 'actor'>;

/** what a check of the retained window found */
export type AuditVerdict = {
	verified: boolean;
	/** the first sequence number at which the chain stops holding */
	firstBad?: number;
};

/** the entry without its own hash, keys in the fixed order the hash covers */
export function canonicalEntry(entry: Omit<AuditEntry, 'hash'>): string {
	return JSON.stringify({
		seq: entry.seq,
		at: entry.at,
		route: entry.route,
		method: entry.method,
		status: entry.status,
		actor: entry.actor,
		prev: entry.prev
	});
}

/** `sha256(prev || canonical entry)` as lowercase hex */
export function entryHash(entry: Omit<AuditEntry, 'hash'>): Promise<string> {
	return sha256Hex(entry.prev + canonicalEntry(entry));
}

/** whether a parsed value has the shape of an entry; a stored value comes back from storage */
export function isAuditEntry(value: unknown): value is AuditEntry {
	if (typeof value !== 'object' || value === null) return false;
	const e = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(e['seq']) &&
		Number.isSafeInteger(e['at']) &&
		Number.isSafeInteger(e['status']) &&
		typeof e['route'] === 'string' &&
		typeof e['method'] === 'string' &&
		typeof e['actor'] === 'string' &&
		typeof e['prev'] === 'string' &&
		typeof e['hash'] === 'string'
	);
}

/**
 * Checks the retained window of a chain, recomputing every hash.
 *
 * `floor` is the hash of the last entry dropped from the ring, which the first retained entry
 * must name as its `prev` (absent while the ring has never wrapped, so the first entry must be
 * sequence 1 chaining from the genesis hash). `head` is the pointer the object keeps beside the
 * ring; without it a chain cut short at the end would still verify. An edit to one entry shows
 * at that entry; an edit that also rewrites its hash shows at the next one.
 */
export async function verifyAuditChain(
	entries: readonly unknown[],
	floor?: AuditPoint,
	head?: AuditPoint
): Promise<AuditVerdict> {
	let expectSeq = (floor?.seq ?? 0) + 1;
	let expectPrev = floor?.hash ?? AUDIT_GENESIS;
	for (const raw of entries) {
		if (!isAuditEntry(raw)) {
			return { verified: false, firstBad: expectSeq };
		}
		if (raw.seq !== expectSeq || raw.prev !== expectPrev) {
			return { verified: false, firstBad: raw.seq };
		}
		if ((await entryHash(raw)) !== raw.hash) return { verified: false, firstBad: raw.seq };
		expectSeq = raw.seq + 1;
		expectPrev = raw.hash;
	}
	if (head !== undefined && (head.seq !== expectSeq - 1 || head.hash !== expectPrev)) {
		return { verified: false, firstBad: Math.min(head.seq, expectSeq) };
	}
	return { verified: true };
}

function slotKey(seq: number): string {
	return `${SLOT_PREFIX}${String(seq % AUDIT_RING).padStart(4, '0')}`;
}

function readJson<T>(store: SealedStore, key: string): T | undefined {
	const raw = store.get(key);
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

function readPoint(store: SealedStore, key: string): AuditPoint | undefined {
	const point = readJson<AuditPoint>(store, key);
	return point !== undefined && Number.isSafeInteger(point.seq) && typeof point.hash === 'string'
		? point
		: undefined;
}

/** appends in flight per store, so two calls cannot read the same head */
const tails = new WeakMap<SealedStore, Promise<unknown>>();

/** failed owner-token checks not yet written to storage, per store */
const failures = new WeakMap<SealedStore, { pending: number; since?: number }>();

/**
 * Appends one owner call to the chain and returns the entry.
 *
 * Writes the ring slot and the head (and the floor when the slot held an older entry), then emits
 * the entry's seq and hash with `console.log`, which Workers observability keeps where an attacker
 * on the site cannot rewrite it.
 */
export function appendAudit(store: SealedStore, call: AuditCall): Promise<AuditEntry> {
	const run = (tails.get(store) ?? Promise.resolve()).then(async () => {
		const head = readPoint(store, HEAD_KEY) ?? { seq: 0, hash: AUDIT_GENESIS };
		const body = { ...call, seq: head.seq + 1, prev: head.hash };
		const entry: AuditEntry = { ...body, hash: await entryHash(body) };
		const slot = slotKey(entry.seq);
		const dropped = readJson<AuditEntry>(store, slot);
		if (isAuditEntry(dropped) && dropped.seq === entry.seq - AUDIT_RING) {
			store.put(FLOOR_KEY, JSON.stringify({ seq: dropped.seq, hash: dropped.hash }));
		}
		store.put(slot, JSON.stringify(entry));
		store.put(HEAD_KEY, JSON.stringify({ seq: entry.seq, hash: entry.hash }));
		flushFailedAttempts(store);
		console.log(JSON.stringify({ audit: { seq: entry.seq, hash: entry.hash } }));
		return entry;
	});
	tails.set(
		store,
		run.catch(() => undefined)
	);
	return run;
}

/** counts a refused owner token; kept in memory and written with the next entry or read */
export function noteFailedAttempt(store: SealedStore, now: number): void {
	const state = failures.get(store) ?? { pending: 0 };
	state.pending++;
	state.since ??= now;
	failures.set(store, state);
}

/** writes the pending failure count into the stored total; a no-op when there is none */
export function flushFailedAttempts(store: SealedStore): void {
	const state = failures.get(store);
	if (state === undefined || state.pending === 0) return;
	const total = readJson<{ count: number; since: number }>(store, FAIL_KEY);
	store.put(
		FAIL_KEY,
		JSON.stringify({
			count: (total?.count ?? 0) + state.pending,
			since: total?.since ?? state.since ?? 0
		})
	);
	failures.set(store, { pending: 0 });
}

/** the retained log, the pointers beside it and the failure count */
export type AuditLog = {
	entries: unknown[];
	head?: AuditPoint;
	floor?: AuditPoint;
	failedAttempts: { count: number; since?: number };
};

/** reads everything a verification needs, in sequence order */
export function readAudit(store: SealedStore): AuditLog {
	flushFailedAttempts(store);
	const entries: unknown[] = [];
	for (const [, value] of store.list(SLOT_PREFIX)) {
		try {
			entries.push(JSON.parse(value));
		} catch {
			entries.push(value);
		}
	}
	entries.sort(
		(a, b) => (isAuditEntry(a) ? a.seq : Infinity) - (isAuditEntry(b) ? b.seq : Infinity)
	);
	const head = readPoint(store, HEAD_KEY);
	const floor = readPoint(store, FLOOR_KEY);
	const total = readJson<{ count: number; since: number }>(store, FAIL_KEY);
	return {
		entries,
		...(head ? { head } : {}),
		...(floor ? { floor } : {}),
		failedAttempts: total ? { count: total.count, since: total.since } : { count: 0 }
	};
}

/** the query parameters a label may carry, since the rest can hold a token or a path */
const LABEL_PARAMS = ['action', 'force', 'secrets', 'all', 'op', 'clear'];

/** a parameter value safe to write into a label */
const LABEL_VALUE = /^[A-Za-z0-9_:.-]{1,40}$/;

/** `/git` actions that only read */
const GIT_READS = new Set(['list', 'check', 'branches', 'prs', 'diff', 'status']);

/** object routes recorded whatever the method or query */
const ALWAYS = new Set([
	'/__install',
	'/__enable',
	'/__modify',
	'/__restore',
	'/__export',
	'/__recover-token',
	'/__migrate',
	'/__bump',
	'/__invalidate'
]);

/**
 * The label an owner call is recorded under, or undefined when the call reads or polls.
 *
 * Keyed on the object's own path: the front worker is the only caller of a `/__` route, so the
 * name cannot be shadowed by a Drupal page. The label is the path plus the few parameters that
 * change what the call does (`action`, `force`, `secrets`, `all`, `op`, `clear`), never the rest of
 * the query.
 */
export function auditedRoute(
	path: string,
	method: string,
	params: URLSearchParams
): string | undefined {
	const write = method !== 'GET' && method !== 'HEAD';
	const action = params.get('action');
	let audited = ALWAYS.has(path);
	switch (path) {
		case '/__pitr':
		case '/__updb':
		case '/__reconcile':
			audited = method === 'POST';
			break;
		case '/__firstrun':
			audited = params.get('force') === '1';
			break;
		case '/__git':
			audited = !GIT_READS.has(action ?? 'list');
			break;
		case '/__queue':
			audited = action === 'drop';
			break;
		case '/__health':
			audited = params.get('clear') === '1';
			break;
		case '/__ops':
			audited = params.get('op') !== null;
			break;
		case '/__cfoauth':
		case '/__mailonboard':
		case '/__oidcsetup':
			audited = write || (action !== null && action !== 'status') || params.has('zone');
			break;
	}
	if (!audited) return undefined;
	const flags = LABEL_PARAMS.flatMap((name) => {
		const value = params.get(name);
		return value !== null && LABEL_VALUE.test(value) ? [`${name}=${value}`] : [];
	});
	return flags.length > 0 ? `${path}?${flags.join('&')}` : path;
}
