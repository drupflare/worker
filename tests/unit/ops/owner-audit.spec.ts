import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	AUDIT_GENESIS,
	AUDIT_RING,
	appendAudit,
	auditedRoute,
	canonicalEntry,
	entryHash,
	flushFailedAttempts,
	noteFailedAttempt,
	readAudit,
	verifyAuditChain,
	type AuditCall,
	type AuditEntry
} from '../../../src/ops/owner-audit';
import { sha256Hex } from '../../../src/ops/owner-recovery';
import { memorySecretStore } from '../../helpers/secret-store';

const call = (n: number): AuditCall => ({
	at: 1_800_000_000_000 + n,
	route: '/install?force=1',
	method: 'POST',
	status: 200,
	actor: 'a1b2c3d4'
});

const freshStore = () => memorySecretStore().sealed;

afterEach(() => vi.restoreAllMocks());

describe('the hash input', () => {
	it('covers prev and the entry without its hash, in a fixed key order', async () => {
		const body = { ...call(1), seq: 1, prev: AUDIT_GENESIS };
		expect(canonicalEntry(body)).toBe(
			'{"seq":1,"at":1800000000001,"route":"/install?force=1","method":"POST","status":200,' +
				`"actor":"a1b2c3d4","prev":"${AUDIT_GENESIS}"}`
		);
		// drangler's `tests/audit.spec.ts` pins the same vector, so the two sides cannot drift apart
		expect(await entryHash(body)).toBe(
			'7b03b07fd2e40697a9d49db6854268faaf9cc654d4127f12a15f7a062bc7d151'
		);
		// a reordered literal hashes the same, so the order is the serializer's and not the caller's
		const { prev, actor, status, ...rest } = body;
		const shuffled = { prev, actor, status, ...rest };
		expect(await entryHash(shuffled)).toBe(await sha256Hex(body.prev + canonicalEntry(body)));
	});
});

describe('appending', () => {
	it('starts a chain on a site with no log and chains each entry to the last', async () => {
		const store = freshStore();
		const empty = readAudit(store);
		expect(empty).toMatchObject({ entries: [], failedAttempts: { count: 0 } });
		expect(await verifyAuditChain(empty.entries, empty.floor, empty.head)).toEqual({
			verified: true
		});

		const first = await appendAudit(store, call(1));
		const second = await appendAudit(store, call(2));
		expect(first).toMatchObject({ seq: 1, prev: AUDIT_GENESIS });
		expect(second).toMatchObject({ seq: 2, prev: first.hash });
		const log = readAudit(store);
		expect(log.head).toEqual({ seq: 2, hash: second.hash });
		expect(log.entries).toEqual([first, second]);
		expect(await verifyAuditChain(log.entries, log.floor, log.head)).toEqual({
			verified: true
		});
	});

	it('serializes concurrent appends so no two entries share a parent', async () => {
		const store = freshStore();
		const made = await Promise.all([1, 2, 3, 4, 5].map((n) => appendAudit(store, call(n))));
		expect(made.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
		const log = readAudit(store);
		expect(await verifyAuditChain(log.entries, log.floor, log.head)).toEqual({
			verified: true
		});
	});

	it('emits the seq and hash of each entry to the console as the off-object anchor', async () => {
		const lines = vi.spyOn(console, 'log').mockImplementation(() => {});
		const entry = await appendAudit(freshStore(), call(1));
		expect(lines).toHaveBeenCalledWith(
			JSON.stringify({ audit: { seq: entry.seq, hash: entry.hash } })
		);
	});

	it('keeps the last 1,000 entries, leaves the dropped hash as the floor, and still verifies', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const store = freshStore();
		const all: AuditEntry[] = [];
		for (let n = 1; n <= AUDIT_RING + 5; n++) all.push(await appendAudit(store, call(n)));
		const log = readAudit(store);
		expect(log.entries).toHaveLength(AUDIT_RING);
		expect((log.entries[0] as AuditEntry).seq).toBe(6);
		expect(log.floor).toEqual({ seq: 5, hash: all[4]!.hash });
		expect(await verifyAuditChain(log.entries, log.floor, log.head)).toEqual({
			verified: true
		});
		// without the floor the retained window cannot be anchored
		expect(await verifyAuditChain(log.entries, undefined, log.head)).toEqual({
			verified: false,
			firstBad: 6
		});
	}, 30_000);
});

describe('tampering', () => {
	async function chain(n = 4) {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const store = freshStore();
		for (let i = 1; i <= n; i++) await appendAudit(store, call(i));
		const log = readAudit(store);
		return { entries: log.entries as AuditEntry[], head: log.head! };
	}

	it('fails at the entry whose field changed', async () => {
		const { entries, head } = await chain();
		const edited = entries.map((e) => (e.seq === 2 ? { ...e, route: '/export' } : e));
		expect(await verifyAuditChain(edited, undefined, head)).toEqual({
			verified: false,
			firstBad: 2
		});
	});

	it('fails at the next entry when the edit also rewrites the hash', async () => {
		const { entries, head } = await chain();
		const forged = { ...entries[1]!, actor: 'ffffffff' };
		forged.hash = await entryHash(forged);
		const edited = entries.map((e) => (e.seq === 2 ? forged : e));
		expect(await verifyAuditChain(edited, undefined, head)).toEqual({
			verified: false,
			firstBad: 3
		});
	});

	it('fails at a removed entry and at a cut-off tail', async () => {
		const { entries, head } = await chain();
		expect(
			await verifyAuditChain(
				entries.filter((e) => e.seq !== 2),
				undefined,
				head
			)
		).toEqual({ verified: false, firstBad: 3 });
		expect(await verifyAuditChain(entries.slice(0, 3), undefined, head)).toEqual({
			verified: false,
			firstBad: 4
		});
	});

	it('refuses a value that is not an entry', async () => {
		const { entries } = await chain(2);
		expect(await verifyAuditChain([entries[0], 'junk'])).toEqual({
			verified: false,
			firstBad: 2
		});
	});
});

describe('failed attempts', () => {
	it('are a counter written with the next read, and never an entry', async () => {
		const store = freshStore();
		noteFailedAttempt(store, 1000);
		noteFailedAttempt(store, 2000);
		noteFailedAttempt(store, 3000);
		const log = readAudit(store);
		expect(log.entries).toEqual([]);
		expect(log.head).toBeUndefined();
		expect(log.failedAttempts).toEqual({ count: 3, since: 1000 });
		// flushing again adds nothing, and a later count adds to the stored total
		flushFailedAttempts(store);
		noteFailedAttempt(store, 4000);
		expect(readAudit(store).failedAttempts).toEqual({ count: 4, since: 1000 });
	});
});

describe('which calls are recorded', () => {
	const route = (path: string, method = 'GET', query = '') =>
		auditedRoute(path, method, new URLSearchParams(query));

	it.each([
		['/__install', 'POST', '', '/__install'],
		['/__enable', 'POST', 'module=x', '/__enable'],
		['/__modify', 'POST', 'action=commit', '/__modify?action=commit'],
		['/__restore', 'POST', '', '/__restore'],
		['/__export', 'GET', 'secrets=1', '/__export?secrets=1'],
		['/__export', 'GET', '', '/__export'],
		['/__recover-token', 'POST', '', '/__recover-token'],
		['/__pitr', 'POST', 'bookmark=abc', '/__pitr'],
		['/__firstrun', 'POST', 'force=1', '/__firstrun?force=1'],
		['/__git', 'GET', 'action=pull&remote=r1', '/__git?action=pull'],
		['/__git', 'GET', 'action=add', '/__git?action=add'],
		['/__updb', 'POST', 'action=beat', '/__updb?action=beat'],
		['/__reconcile', 'POST', '', '/__reconcile'],
		['/__queue', 'GET', 'action=drop', '/__queue?action=drop'],
		['/__ops', 'POST', 'op=cim', '/__ops?op=cim'],
		['/__bump', 'GET', 'reason=x', '/__bump'],
		['/__cfoauth', 'GET', 'action=callback', '/__cfoauth?action=callback'],
		['/__oidcsetup', 'POST', '', '/__oidcsetup']
	])('records %s %s ?%s as %s', (path, method, query, label) => {
		expect(route(path, method, query)).toBe(label);
	});

	it.each([
		['/__serve-stats', 'GET', ''],
		['/__health', 'GET', ''],
		['/__installable', 'GET', 'module=x'],
		['/__ownercheck', 'GET', ''],
		['/__audit', 'GET', ''],
		['/__serve', 'GET', 'path=/'],
		['/__git', 'GET', ''],
		['/__git', 'GET', 'action=list'],
		['/__git', 'GET', 'action=status'],
		['/__firstrun', 'POST', ''],
		['/__pitr', 'GET', 'at=2026-01-01'],
		['/__updb', 'GET', ''],
		['/__reconcile', 'GET', ''],
		['/__queue', 'GET', 'action=list'],
		['/__ops', 'GET', ''],
		['/__cfoauth', 'GET', ''],
		['/__mailonboard', 'GET', 'action=status'],
		['/__sweep', 'GET', ''],
		['/__armfill', 'GET', '']
	])('leaves %s %s ?%s alone', (path, method, query) => {
		expect(route(path, method, query)).toBeUndefined();
	});

	it('never copies a query parameter outside the short list into the label', () => {
		const label = route('/__git', 'POST', 'action=add&token=SECRET&url=https://x&secrets=1');
		expect(label).toBe('/__git?action=add&secrets=1');
		expect(route('/__ops', 'POST', 'op=a b')).toBe('/__ops');
	});
});
