import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { auditOwnerCall } from '../../src/do/routes/audit';
import { AUDIT_GENESIS, type AuditEntry } from '../../src/ops/owner-audit';
import { sha256Hex } from '../../src/ops/owner-recovery';
import { mintOwnerToken } from '../../src/ops/site-secrets';
import worker, { routeTable } from '../../src/site';
import type { SitePhpDurableObject } from '../../src/site-do';
import { inObject, provisionedNamedSite, type ServeDo } from '../helpers/serve-do';

/**
 * The owner audit log: what an owner call records, what a failed attempt does not, and that the
 * log sits where the SQL bridge cannot reach it and detects an edit.
 */

type AuditBody = {
	ok: boolean;
	verified: boolean;
	firstBadSeq?: number;
	head: { seq: number; hash: string } | null;
	floor: { seq: number; hash: string } | null;
	failedAttempts: { count: number; since?: number };
	entries: AuditEntry[];
};

let sites = 0;

/** a provisioned object with an owner token, as the claim leaves it */
async function claimed() {
	const stub = await provisionedNamedSite(`audit-${++sites}.example`);
	const token = await inObject(stub, async (site) => {
		site.ensureServeTables();
		return (await mintOwnerToken(site.secretStore())) ?? '';
	});
	return { stub, token };
}

/** a request to the object's own route, the way the front worker hops it */
const call = (
	stub: DurableObjectStub,
	path: string,
	token: string | undefined,
	init: RequestInit = {}
) =>
	inObject(stub, (site) =>
		site.fetch(
			new Request(`https://do.local${path}`, {
				...init,
				headers: token === undefined ? {} : { authorization: `Bearer ${token}` }
			})
		)
	);

const readLog = async (stub: DurableObjectStub, token: string) =>
	(await (await call(stub, '/__audit', token)).json()) as AuditBody;

const rawKv = (site: ServeDo) =>
	(
		site.ctx.storage as unknown as {
			kv: { get(k: string): unknown; put(k: string, v: unknown): void };
		}
	).kv;

describe('what an owner call records', () => {
	it('appends a chained entry for a state change and none for a read', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const { stub, token } = await claimed();
		expect((await call(stub, '/__bump?reason=audit', token)).status).toBe(200);
		expect((await call(stub, '/__queue?action=drop', token)).status).toBe(200);
		// polling and reads leave the chain alone
		await call(stub, '/__serve-stats', token);
		await call(stub, '/__queue?action=list', token);
		await call(stub, '/__health', token);

		const log = await readLog(stub, token);
		expect(log.entries.map((e) => [e.seq, e.route, e.method, e.status])).toEqual([
			[1, '/bump', 'GET', 200],
			[2, '/queue?action=drop', 'GET', 200]
		]);
		expect(log.entries[0]!.prev).toBe(AUDIT_GENESIS);
		expect(log.entries[1]!.prev).toBe(log.entries[0]!.hash);
		expect(log.head).toEqual({ seq: 2, hash: log.entries[1]!.hash });
		expect(log).toMatchObject({ ok: true, verified: true, floor: null });
		// the actor is a short hash, and the token is nowhere in the answer
		expect(log.entries[0]!.actor).toBe((await sha256Hex(token)).slice(0, 8));
		expect(JSON.stringify(log)).not.toContain(token);
	});

	it('records an export and notes secrets=1', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const { stub, token } = await claimed();
		await call(stub, '/__export?secrets=1&limit=1', token);
		expect((await readLog(stub, token)).entries.map((e) => e.route)).toEqual([
			'/export?secrets=1'
		]);
	});

	it('records a rotation as proof, and counts a refused proof without an entry', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const { stub, token } = await claimed();
		const out = await inObject(stub, async (site) => {
			const request = () =>
				new Request('https://do.local/__recover-token', { method: 'POST' });
			await auditOwnerCall(site as unknown as SitePhpDurableObject, request(), 404);
			await auditOwnerCall(site as unknown as SitePhpDurableObject, request(), 200);
			return true;
		});
		expect(out).toBe(true);
		const log = await readLog(stub, token);
		expect(log.entries.map((e) => [e.route, e.actor, e.status])).toEqual([
			['/recover-token', 'proof', 200]
		]);
		expect(log.failedAttempts.count).toBe(1);
	});

	it('records no call without a valid owner token, so provisioning and a guess add nothing', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const { stub, token } = await claimed();
		await call(stub, '/__bump', undefined);
		await call(stub, '/__bump', 'a-token-nobody-minted');
		const log = await readLog(stub, token);
		expect(log.entries).toEqual([]);
		expect(log.head).toBeNull();
	});
});

describe('failed attempts', () => {
	it('are a count on the log and never an entry', async () => {
		const { stub, token } = await claimed();
		for (let i = 0; i < 4; i++) {
			expect((await call(stub, '/__ownercheck', `wrong-${i}`)).status).toBe(401);
		}
		// a request with no token at all is not an attempt to guess one
		await call(stub, '/__ownercheck', undefined);
		const log = await readLog(stub, token);
		expect(log.entries).toEqual([]);
		expect(log.failedAttempts.count).toBe(4);
		expect(log.failedAttempts.since).toBeGreaterThan(0);
		// the next read does not count them twice
		expect((await readLog(stub, token)).failedAttempts.count).toBe(4);
	});

	it('write nothing to storage until the log is read or an entry is appended', async () => {
		const { stub, token } = await claimed();
		const rows = await inObject(stub, async (site) => {
			const meter = site as unknown as { dailyRows: () => number };
			const wrong = () =>
				site.fetch(
					new Request('https://do.local/__ownercheck', {
						headers: { authorization: 'Bearer wrong-again' }
					})
				);
			// the first request of an incarnation pays its own first-touch rows
			await wrong();
			const before = meter.dailyRows();
			await wrong();
			await wrong();
			return meter.dailyRows() - before;
		});
		expect(rows).toBe(0);
		await readLog(stub, token);
	});
});

describe('where the log lives', () => {
	it('is out of reach of the SQL bridge: a read and a write both fail and the entry stands', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const { stub, token } = await claimed();
		await call(stub, '/__bump', token);
		const before = await readLog(stub, token);
		const out = await inObject(stub, (site) => {
			const attempt = (text: string, ...params: unknown[]) => {
				try {
					return site.sql.exec(text, ...params).toArray();
				} catch (e) {
					return String((e as Error).message);
				}
			};
			return {
				read: attempt('SELECT * FROM _cf_KV'),
				write: attempt("UPDATE _cf_KV SET value = x'00' WHERE key LIKE 'audit:%'"),
				drop: attempt('DELETE FROM _cf_KV'),
				meta: JSON.stringify(attempt('SELECT * FROM cfw_meta'))
			};
		});
		expect(typeof out.read).toBe('string');
		expect(typeof out.write).toBe('string');
		expect(typeof out.drop).toBe('string');
		expect(out.meta).not.toContain('audit:');
		expect((await readLog(stub, token)).entries).toEqual(before.entries);
	});

	it('shows an edit to one stored entry as a failed verification at that seq', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const { stub, token } = await claimed();
		for (let i = 0; i < 3; i++) await call(stub, `/__bump?reason=n${i}`, token);
		const edited = await inObject(stub, (site) => {
			const kv = rawKv(site);
			const slot = 'audit:e:0002';
			const entry = JSON.parse(kv.get(slot) as string) as AuditEntry;
			kv.put(slot, JSON.stringify({ ...entry, route: '/export?secrets=1' }));
			return entry.seq;
		});
		expect(edited).toBe(2);
		expect(await readLog(stub, token)).toMatchObject({ verified: false, firstBadSeq: 2 });
	});

	it('shows a removed entry and a reset head', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const { stub, token } = await claimed();
		for (let i = 0; i < 3; i++) await call(stub, `/__bump?reason=n${i}`, token);
		await inObject(stub, (site) => {
			(site.ctx.storage as unknown as { kv: { delete(k: string): void } }).kv.delete(
				'audit:e:0002'
			);
		});
		expect(await readLog(stub, token)).toMatchObject({ verified: false, firstBadSeq: 3 });
	});
});

describe('the owner route', () => {
	it('is an owner route with an object route entry, and refuses a caller with no token', async () => {
		const table = routeTable();
		expect(table.owner.has('/audit')).toBe(true);
		expect(table.diagnostic.has('/audit')).toBe(false);
		expect(table.doRoute['/audit']).toBe('/__audit');
		const { stub } = await claimed();
		expect((await call(stub, '/__audit', undefined)).status).toBe(401);
		expect((await call(stub, '/__audit', 'wrong')).status).toBe(401);
	});
});

describe('through the front worker', () => {
	/** the front worker with the diagnostic flag absent, the way it is deployed */
	async function viaWorker(host: string, path: string, token: string | undefined, init = {}) {
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			new Request(`https://${host}${path}`, {
				...init,
				headers: {
					'cf-connecting-ip': '203.0.113.9',
					...(token ? { authorization: `Bearer ${token}` } : {})
				}
			}),
			{ ...env, PW_DIAGNOSTICS: undefined } as unknown as typeof env,
			ctx
		);
		await waitOnExecutionContext(ctx);
		return res;
	}

	it('reads the log with the owner token and records a /settings write', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const host = `audit-settings-${++sites}.example`;
		const stub = await provisionedNamedSite(host);
		const token = await inObject(stub, async (site) => {
			site.ensureServeTables();
			return (await mintOwnerToken(site.secretStore())) ?? '';
		});
		expect((await viaWorker(host, '/audit', undefined)).status).toBe(401);

		const put = await viaWorker(host, '/settings', token, {
			method: 'PUT',
			body: JSON.stringify({})
		});
		expect(put.status).toBe(200);
		const res = await viaWorker(host, '/audit', token);
		expect(res.status).toBe(200);
		const log = (await res.json()) as AuditBody;
		expect(log.entries.map((e) => [e.route, e.method, e.status])).toEqual([
			['/settings', 'PUT', 200]
		]);
		expect(log.verified).toBe(true);
	});
});

describe('the cost of an owner call', () => {
	it('is the key-value writes of the entry on an audited call and zero on a read', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const { stub } = await claimed();
		const rows = await inObject(stub, async (site) => {
			const meter = site as unknown as { dailyRows: () => number };
			const authorized = new Request('https://do.local/__bump', {
				headers: { authorization: `Bearer ${await tokenOf(site)}` }
			});
			const read = new Request('https://do.local/__serve-stats', {
				headers: authorized.headers
			});
			const typed = site as unknown as SitePhpDurableObject;
			let mark = meter.dailyRows();
			await auditOwnerCall(typed, read, 200);
			const readRows = meter.dailyRows() - mark;
			mark = meter.dailyRows();
			await auditOwnerCall(typed, authorized, 200);
			const first = meter.dailyRows() - mark;
			mark = meter.dailyRows();
			await auditOwnerCall(typed, authorized, 200);
			return { readRows, first, second: meter.dailyRows() - mark };
		});
		console.info(`[owner-audit] rows per owner call ${JSON.stringify(rows)}`);
		expect(rows.readRows).toBe(0);
		expect(rows.first).toBeGreaterThan(0);
		expect(rows.second).toBe(rows.first);
	});
});

/** mints a fresh token on the object, since a claim keeps only the hash */
async function tokenOf(site: ServeDo): Promise<string> {
	const { rotateOwnerToken } = await import('../../src/ops/site-secrets');
	return rotateOwnerToken(site.secretStore());
}
