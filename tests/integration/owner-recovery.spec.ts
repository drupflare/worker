import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverToken } from '../../src/do/routes/auth';
import {
	OWNER_FAIL_LIMIT,
	ownerRefusedForNow,
	resetOwnerFailures
} from '../../src/ops/admin-session';
import {
	isNonce,
	judgeProof,
	RECOVER_MAX_LIFE_MS,
	RECOVER_SPENT_KEY,
	recoverKey,
	spendProof
} from '../../src/ops/owner-recovery';
import { OWNER_TOKEN_KEY, type SecretStore } from '../../src/ops/site-secrets';
import worker, { routeTable } from '../../src/site';
import type { SitePhpDurableObject } from '../../src/site-do';
import { inObject, provisionedNamedSite } from '../helpers/serve-do';

/**
 * Owner-token recovery: a nonce whose hash sits in `CONFIG_KV` is the credential.
 *
 * The route is public, so what these pin is everything that stops it being a way in: a proof
 * works once even while KV still serves it, dies with its minute, belongs to one host, never
 * claims a site, and shares the failure budget so guessing cannot spend the object's request
 * meter.
 */

const HOST = 'recover.example';
const TOKEN = 'owner-token-for-the-recovery-spec';
const NOW = 1_800_000_000_000;
const nonce = (c: string) => c.repeat(43);

/** KV with a switch for the eventual consistency that makes a delete unreliable */
function memoryKv(over: { staleAfterDelete?: boolean } = {}) {
	const rows = new Map<string, string>();
	return {
		rows,
		get: async (key: string) => rows.get(key) ?? null,
		put: async (key: string, value: string) => void rows.set(key, value),
		delete: async (key: string) => {
			if (over.staleAfterDelete !== true) rows.delete(key);
		}
	};
}

/** the slice of the object `recoverToken` touches, over a map */
function fakeSite(
	over: { token?: string | null; kv?: ReturnType<typeof memoryKv> | undefined; now?: number } = {}
) {
	const meta = new Map<string, string>();
	if (over.token !== null) meta.set(OWNER_TOKEN_KEY, over.token ?? TOKEN);
	const store: SecretStore = {
		get: (key) => meta.get(key) ?? null,
		set: (key, value) => void meta.set(key, value)
	};
	const site = {
		meta,
		env: { CONFIG_KV: 'kv' in over ? over.kv : memoryKv() },
		nowMs: () => over.now ?? NOW,
		metaGet: (key: string) => meta.get(key) ?? null,
		secretStore: () => store
	};
	return site as typeof site & SitePhpDurableObject;
}

async function proofFor(
	kv: ReturnType<typeof memoryKv>,
	n: string,
	record: Record<string, unknown> = {},
	host = HOST
) {
	const key = await recoverKey(host, n);
	kv.rows.set(key, JSON.stringify({ host, exp: NOW + 60_000, ...record }));
	return key;
}

const present = (site: ReturnType<typeof fakeSite>, n: unknown, host = HOST) =>
	recoverToken(
		site,
		new Request(`https://${host}/__recover-token`, {
			method: 'POST',
			body: JSON.stringify({ nonce: n })
		}),
		new URL(`https://${host}/__recover-token`)
	);

describe('the object route', () => {
	it('returns the token for a valid proof, deletes the record and forbids caching', async () => {
		const site = fakeSite();
		const key = await proofFor(site.env.CONFIG_KV as ReturnType<typeof memoryKv>, nonce('a'));
		const res = await present(site, nonce('a'));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, ownerToken: TOKEN });
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect((site.env.CONFIG_KV as ReturnType<typeof memoryKv>).rows.has(key)).toBe(false);
	});

	// KV serves a deleted key for up to a minute at another colo; the spent table is the real lock
	it('refuses a second use even when KV still serves the record', async () => {
		const kv = memoryKv({ staleAfterDelete: true });
		const site = fakeSite({ kv });
		await proofFor(kv, nonce('b'));
		expect((await present(site, nonce('b'))).status).toBe(200);
		expect(kv.rows.size).toBe(1);
		const again = await present(site, nonce('b'));
		expect(again.status).toBe(410);
		expect(await again.text()).not.toContain(TOKEN);
	});

	it('lets exactly one of two racing requests have it', async () => {
		const kv = memoryKv({ staleAfterDelete: true });
		const site = fakeSite({ kv });
		await proofFor(kv, nonce('c'));
		const statuses = (
			await Promise.all([present(site, nonce('c')), present(site, nonce('c'))])
		).map((r) => r.status);
		expect(statuses.sort()).toEqual([200, 410]);
	});

	it('refuses an expired proof and does not give the token', async () => {
		const kv = memoryKv();
		const site = fakeSite({ kv });
		await proofFor(kv, nonce('d'), { exp: NOW - 1 });
		const res = await present(site, nonce('d'));
		expect(res.status).toBe(410);
		expect(await res.text()).not.toContain(TOKEN);
	});

	// KV's own TTL is the real limit, so a record that claims a long life is not honoured
	it('refuses a record that claims more than two minutes of life', async () => {
		const kv = memoryKv();
		const site = fakeSite({ kv });
		await proofFor(kv, nonce('e'), { exp: NOW + RECOVER_MAX_LIFE_MS + 1 });
		expect((await present(site, nonce('e'))).status).toBe(400);
	});

	it('does not honour a proof written for another host', async () => {
		const kv = memoryKv();
		const site = fakeSite({ kv });
		await proofFor(kv, nonce('f'), {}, 'other.example');
		// the key names the other host, so this host's lookup finds nothing
		expect((await present(site, nonce('f'))).status).toBe(404);
		// and a record copied under THIS host's key still names the other one inside
		const key = await recoverKey(HOST, nonce('f'));
		kv.rows.set(key, JSON.stringify({ host: 'other.example', exp: NOW + 60_000 }));
		const copied = await present(site, nonce('f'));
		expect(copied.status).toBe(403);
		expect(await copied.text()).not.toContain(TOKEN);
	});

	it('answers 404 for a proof KV has not got, which the client may retry', async () => {
		const res = await present(fakeSite(), nonce('g'));
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ reason: 'unknown' });
	});

	it('refuses a nonce that is not 43 base64url characters, and a stored record that is junk', async () => {
		const site = fakeSite();
		for (const bad of ['short', 'x'.repeat(44), `${'a'.repeat(42)}!`, 7, undefined]) {
			expect((await present(site, bad)).status, String(bad)).toBe(400);
		}
		(site.env.CONFIG_KV as ReturnType<typeof memoryKv>).rows.set(
			await recoverKey(HOST, nonce('h')),
			'not json'
		);
		expect((await present(site, nonce('h'))).status).toBe(400);
	});

	// ensureOwnerToken() here would let a recovery claim a site nobody has claimed
	it('never mints a token for an unclaimed site', async () => {
		const kv = memoryKv();
		const site = fakeSite({ kv, token: null });
		await proofFor(kv, nonce('i'));
		const res = await present(site, nonce('i'));
		expect(res.status).toBe(409);
		expect(site.meta.has(OWNER_TOKEN_KEY)).toBe(false);
	});

	it('says so when the deployment has no CONFIG_KV', async () => {
		const res = await present(fakeSite({ kv: undefined }), nonce('j'));
		expect(res.status).toBe(501);
		expect(await res.json()).toMatchObject({ reason: 'no-kv' });
	});

	it('survives a KV delete that throws, since the TTL removes the record', async () => {
		const kv = memoryKv();
		kv.delete = async () => {
			throw new Error('kv is down');
		};
		const site = fakeSite({ kv });
		await proofFor(kv, nonce('k'));
		expect((await present(site, nonce('k'))).status).toBe(200);
	});
});

describe('the proof arithmetic', () => {
	it('shapes a nonce the way the client mints one', () => {
		expect(isNonce(nonce('A'))).toBe(true);
		expect(isNonce('a-_'.repeat(14) + 'a')).toBe(true);
		expect(isNonce(nonce('a').slice(1))).toBe(false);
		expect(isNonce(`${nonce('a')}=`)).toBe(false);
	});

	// the same vector sits in drangler's recover-token spec; the two must agree or no proof matches
	it('keys a proof as drangler does', async () => {
		expect(await recoverKey('mysite.example', 'a'.repeat(43))).toBe(
			'recover:mysite.example:66d34fba71f8f450f7e45598853e53bfc23bbd129027cbb131a2f4ffd7878cd0'
		);
		expect(await recoverKey('MySite.Example', 'a'.repeat(43))).toBe(
			await recoverKey('mysite.example', 'a'.repeat(43))
		);
	});

	it('judges the host first, then the clock on both sides', () => {
		const ok = { host: HOST, exp: NOW + 1_000 };
		expect(judgeProof(ok, HOST, NOW).verdict).toBe('ok');
		expect(judgeProof(ok, 'Recover.Example', NOW).verdict).toBe('ok');
		expect(judgeProof(ok, 'other.example', NOW).verdict).toBe('wrong-host');
		expect(judgeProof({ ...ok, exp: NOW - 1 }, HOST, NOW).verdict).toBe('spent');
		expect(judgeProof({ ...ok, exp: NOW + RECOVER_MAX_LIFE_MS + 1 }, HOST, NOW).verdict).toBe(
			'malformed'
		);
		for (const junk of [
			null,
			'x',
			{},
			{ host: HOST },
			{ host: 1, exp: NOW },
			{ host: HOST, exp: NaN }
		]) {
			expect(judgeProof(junk, HOST, NOW).verdict, JSON.stringify(junk)).toBe('malformed');
		}
	});

	it('spends once, and forgets a proof only after it could no longer be accepted', () => {
		const meta = new Map<string, string>();
		const store: SecretStore = {
			get: (k) => meta.get(k) ?? null,
			set: (k, v) => void meta.set(k, v)
		};
		expect(spendProof(store, 'k1', NOW + 100, NOW)).toBe(true);
		expect(spendProof(store, 'k1', NOW + 100, NOW + 50)).toBe(false);
		expect(spendProof(store, 'k2', NOW + 500, NOW + 50)).toBe(true);
		expect(JSON.parse(meta.get(RECOVER_SPENT_KEY) ?? '[]')).toHaveLength(2);
		// k1's exp has passed, so it is dropped and k2 stays
		expect(spendProof(store, 'k3', NOW + 900, NOW + 200)).toBe(true);
		expect(
			(JSON.parse(meta.get(RECOVER_SPENT_KEY) ?? '[]') as { h: string }[]).map((s) => s.h)
		).toEqual(['k2', 'k3']);
		meta.set(RECOVER_SPENT_KEY, '{"not":"an array"}');
		expect(spendProof(store, 'k1', NOW + 100, NOW)).toBe(true);
	});
});

/** the front worker with the diagnostic flag absent, the way it is deployed */
async function viaWorker(
	host: string,
	init: RequestInit & { ip?: string; hops?: { count: number } } = {}
): Promise<Response> {
	const { ip, hops, ...rest } = init;
	const counted = hops
		? {
				...env,
				SITE: {
					idFromName: (name: string) => env.SITE.idFromName(name),
					get: (...args: Parameters<typeof env.SITE.get>) => {
						hops.count++;
						return env.SITE.get(...args);
					}
				}
			}
		: env;
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`https://${host}/recover-token`, {
			method: 'POST',
			...rest,
			headers: { 'cf-connecting-ip': ip ?? '203.0.113.1', ...(rest.headers ?? {}) }
		}),
		{ ...counted, PW_DIAGNOSTICS: undefined } as unknown as typeof env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return res;
}

const post = (n: string) => ({ body: JSON.stringify({ nonce: n }) });

async function liveProof(host: string, n: string): Promise<string> {
	const key = await recoverKey(host, n);
	await env.CONFIG_KV?.put(key, JSON.stringify({ host, exp: Date.now() + 60_000 }), {
		expirationTtl: 60
	});
	return key;
}

describe('the public route', () => {
	beforeEach(() => resetOwnerFailures());
	afterEach(() => vi.restoreAllMocks());

	it('is public, answered in the Worker, and is not an owner or diagnostic route', () => {
		const table = routeTable();
		expect(table.public.has('/recover-token')).toBe(true);
		expect(table.owner.has('/recover-token')).toBe(false);
		expect(table.diagnostic.has('/recover-token')).toBe(false);
		expect(table.doRoute['/recover-token']).toBeUndefined();
	});

	it('returns the real object token for a real KV proof, once', async () => {
		const host = 'e2e-recover.example';
		const stub = await provisionedNamedSite(host);
		await inObject(stub, (site) => site.metaSet(OWNER_TOKEN_KEY, TOKEN));
		const key = await liveProof(host, nonce('m'));

		const res = await viaWorker(host, post(nonce('m')));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, ownerToken: TOKEN });
		expect(await env.CONFIG_KV?.get(key)).toBeNull();

		await env.CONFIG_KV?.put(key, JSON.stringify({ host, exp: Date.now() + 60_000 }));
		expect((await viaWorker(host, post(nonce('m')))).status).toBe(410);
	});

	it('never writes the token or the nonce to the console', async () => {
		const host = 'quiet-recover.example';
		const stub = await provisionedNamedSite(host);
		await inObject(stub, (site) => site.metaSet(OWNER_TOKEN_KEY, TOKEN));
		await liveProof(host, nonce('n'));
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
			vi.spyOn(console, m)
		);
		await viaWorker(host, post(nonce('n')));
		const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
		expect(logged).not.toContain(TOKEN);
		expect(logged).not.toContain(nonce('n'));
	});

	it('answers a method other than POST with 405 and spends no budget', async () => {
		for (let i = 0; i < OWNER_FAIL_LIMIT + 3; i++) {
			const res = await viaWorker('method.example', { method: 'GET' });
			expect(res.status).toBe(405);
			expect(res.headers.get('allow')).toBe('POST');
		}
		expect(ownerRefusedForNow('203.0.113.1', Date.now())).toBe(false);
	});

	it('counts a malformed body as a failure and reaches no object', async () => {
		const hops = { count: 0 };
		for (const body of [
			'',
			'not json',
			JSON.stringify({ nonce: 'short' }),
			'x'.repeat(5_000)
		]) {
			const res = await viaWorker('malformed.example', { body, hops, ip: '198.51.100.20' });
			expect(res.status).toBe(400);
		}
		expect(hops.count).toBe(0);
		for (let i = 0; i < OWNER_FAIL_LIMIT; i++) {
			await viaWorker('malformed.example', { body: 'nope', ip: '198.51.100.20' });
		}
		expect(ownerRefusedForNow('198.51.100.20', Date.now())).toBe(true);
	});

	// the budget is what stops a guesser driving the object's request meter
	it('refuses an address that spent its budget without asking the object, and only that address', async () => {
		const host = 'budget-recover.example';
		const stub = await provisionedNamedSite(host);
		await inObject(stub, (site) => site.metaSet(OWNER_TOKEN_KEY, TOKEN));
		const hops = { count: 0 };
		for (let i = 0; i < OWNER_FAIL_LIMIT; i++) {
			const res = await viaWorker(host, { ...post(nonce('p')), hops, ip: '192.0.2.10' });
			expect(res.status, `attempt ${i + 1}`).toBe(404);
		}
		expect(hops.count).toBe(OWNER_FAIL_LIMIT);

		await liveProof(host, nonce('q'));
		const refused = await viaWorker(host, { ...post(nonce('q')), hops, ip: '192.0.2.10' });
		expect(refused.status).toBe(429);
		expect(refused.headers.get('retry-after')).toBe('60');
		expect(await refused.text()).not.toContain(TOKEN);
		expect(hops.count, 'a refused address must cost no object request').toBe(OWNER_FAIL_LIMIT);

		const other = await viaWorker(host, { ...post(nonce('q')), hops, ip: '192.0.2.11' });
		expect(other.status).toBe(200);
	});

	it('clears the budget on a correct proof, so an earlier miss never holds back the owner', async () => {
		const host = 'clear-recover.example';
		const stub = await provisionedNamedSite(host);
		await inObject(stub, (site) => site.metaSet(OWNER_TOKEN_KEY, TOKEN));
		for (let i = 0; i < OWNER_FAIL_LIMIT - 1; i++) {
			await viaWorker(host, { ...post(nonce('r')), ip: '192.0.2.30' });
		}
		await liveProof(host, nonce('s'));
		expect((await viaWorker(host, { ...post(nonce('s')), ip: '192.0.2.30' })).status).toBe(200);
		expect(ownerRefusedForNow('192.0.2.30', Date.now())).toBe(false);
		await viaWorker(host, { ...post(nonce('r')), ip: '192.0.2.30' });
		expect(ownerRefusedForNow('192.0.2.30', Date.now())).toBe(false);
	});

	it('does not spend budget on a site that is not 200 or a refusal of the proof', async () => {
		const host = 'unclaimed-recover.example';
		const stub = await provisionedNamedSite(host);
		await inObject(stub, (site) => site.metaSet(OWNER_TOKEN_KEY, ''));
		// a fresh nonce each time, since a spent proof is a 410 and 410 is a counted failure
		for (let i = 0; i < OWNER_FAIL_LIMIT + 2; i++) {
			const fresh = nonce('abcdefghijklmnopqrstuvwxyz'[i] as string);
			await liveProof(host, fresh);
			const res = await viaWorker(host, { ...post(fresh), ip: '192.0.2.40' });
			expect(res.status).toBe(409);
		}
		expect(ownerRefusedForNow('192.0.2.40', Date.now())).toBe(false);
	});
});
