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
	sha256Hex,
	spendProof
} from '../../src/ops/owner-recovery';
import {
	mintOwnerToken,
	OWNER_HASH_KEY,
	OWNER_TOKEN_KEY,
	ownerTokenMatches
} from '../../src/ops/site-secrets';
import worker, { routeTable } from '../../src/site';
import type { SitePhpDurableObject } from '../../src/site-do';
import { HOST_HELPERS_PHP } from '../../src/site/generated/assets';
import { memorySecretStore } from '../helpers/secret-store';
import { freshSite, inObject, provisionedNamedSite, type ServeDo } from '../helpers/serve-do';

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
	// a legacy plaintext row, which the first read migrates into the sealed store
	const store = memorySecretStore(
		over.token === null ? {} : { [OWNER_TOKEN_KEY]: over.token ?? TOKEN }
	);
	const meta = store.rows;
	const site = {
		meta,
		store,
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
	it('rotates the token for a valid proof, deletes the record and forbids caching', async () => {
		const site = fakeSite();
		const key = await proofFor(site.env.CONFIG_KV as ReturnType<typeof memoryKv>, nonce('a'));
		const res = await present(site, nonce('a'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; ownerToken: string; rotated: boolean };
		expect(body).toMatchObject({ ok: true, rotated: true });
		expect(body.ownerToken).not.toBe(TOKEN);
		// the old token is dead and the new one opens the site
		expect(await ownerTokenMatches(site.store, TOKEN)).toBe(false);
		expect(await ownerTokenMatches(site.store, body.ownerToken)).toBe(true);
		// only a hash is kept, and not in the SQL-reachable table
		expect([...site.meta.values()].join('|')).not.toContain(body.ownerToken);
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

	// a rotation here would let a recovery claim a site nobody has claimed
	it('never mints a token for an unclaimed site', async () => {
		const kv = memoryKv();
		const site = fakeSite({ kv, token: null });
		await proofFor(kv, nonce('i'));
		const res = await present(site, nonce('i'));
		expect(res.status).toBe(409);
		expect(site.meta.has(OWNER_TOKEN_KEY)).toBe(false);
		expect(site.store.sealedRows.size).toBe(0);
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
		const store = {
			get: (k: string) => meta.get(k) ?? null,
			set: (k: string, v: string) => void meta.set(k, v)
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

	it('rotates the real object token for a real KV proof, once, and the old token dies', async () => {
		const host = 'e2e-recover.example';
		const stub = await provisionedNamedSite(host);
		await inObject(stub, (site) => site.metaSet(OWNER_TOKEN_KEY, TOKEN));
		const key = await liveProof(host, nonce('m'));

		const res = await viaWorker(host, post(nonce('m')));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ownerToken: string; rotated: boolean };
		expect(body.rotated).toBe(true);
		expect(body.ownerToken).not.toBe(TOKEN);
		const check = (token: string) =>
			inObject(stub, (site) =>
				site.fetch(
					new Request('https://do.local/__ownercheck', {
						headers: { authorization: `Bearer ${token}` }
					})
				)
			).then((r) => r.status);
		expect(await check(TOKEN)).toBe(401);
		expect(await check(body.ownerToken)).toBe(200);
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

/**
 * Where the owner credential and the other secrets sit, read through the same SQL handle the
 * bridge hands PHP. `cfwSqlExec` applies no table filter, so what matters is what that handle can
 * reach: the platform reserves the `_cf_` tables behind key-value storage.
 */
describe('secrets held where the SQL bridge cannot reach them', () => {
	const MARK = 'sealed-probe-value';

	/** the outcome of one statement: its error text, or the rows it returned */
	function attempt(site: ServeDo, text: string, ...params: unknown[]) {
		try {
			return { rows: site.sql.exec(text, ...params).toArray() };
		} catch (e) {
			return { error: String((e as Error).message) };
		}
	}
	const kvOf = (site: ServeDo) =>
		(
			site.ctx.storage as unknown as {
				kv: { get(k: string): unknown; put(k: string, v: unknown): void };
			}
		).kv;

	it('answers no read of the key-value table and no write to it', async () => {
		const out = await inObject(freshSite(), (site) => {
			kvOf(site).put('probe', MARK);
			const reads = [
				attempt(site, 'SELECT * FROM _cf_KV'),
				attempt(site, "SELECT * FROM _cf_KV WHERE key = 'probe'"),
				attempt(
					site,
					"SELECT name, sql FROM sqlite_master WHERE name LIKE '\\_cf\\_%' ESCAPE '\\'"
				),
				attempt(site, 'SELECT * FROM pragma_table_list')
			];
			const writes = [
				attempt(site, "INSERT OR REPLACE INTO _cf_KV (key, value) VALUES ('probe', 'x')"),
				attempt(site, "UPDATE _cf_KV SET value = 'x'"),
				attempt(site, 'DELETE FROM _cf_KV'),
				attempt(site, 'DROP TABLE _cf_KV')
			];
			return { reads, writes, after: kvOf(site).get('probe') };
		});
		// none of the reads returned the stored value, and the stored value survived every write
		expect(JSON.stringify(out.reads)).not.toContain(MARK);
		expect(out.after).toBe(MARK);
		console.info(`sealed-storage reach, measured: ${JSON.stringify(out)}`);
	});

	it('answers no read through a view, a subquery, a copy, the raw pages or an attached file', async () => {
		const shapes = [
			'SELECT * FROM (SELECT * FROM _cf_KV)',
			'WITH k AS (SELECT * FROM _cf_KV) SELECT * FROM k',
			'SELECT a.value FROM sqlite_master m JOIN _cf_KV a ON 1 = 1',
			'CREATE TABLE stolen AS SELECT * FROM _cf_KV',
			'CREATE TEMP TABLE stolen AS SELECT * FROM _cf_KV',
			'CREATE VIEW stolen_view AS SELECT * FROM _cf_KV',
			'SELECT * FROM stolen_view',
			'SELECT * FROM sqlite_dbpage',
			'SELECT * FROM dbstat',
			"ATTACH DATABASE ':memory:' AS other",
			// the rename Check Point reported in 2026: the authorizer once checked what a statement
			// referenced and not the name a table was renamed to
			'CREATE TABLE planted (key TEXT PRIMARY KEY, value BLOB)',
			'ALTER TABLE planted RENAME TO _cf_KV',
			'ALTER TABLE planted RENAME TO _cf_kv',
			'ALTER TABLE _cf_KV RENAME TO moved_away',
			'ALTER TABLE _cf_KV ADD COLUMN extra TEXT',
			'CREATE TRIGGER sneak AFTER INSERT ON planted BEGIN SELECT 1; END',
			"VACUUM INTO '/tmp/stolen.db'",
			"SELECT load_extension('/tmp/x')",
			"SELECT readfile('/etc/passwd')",
			'PRAGMA writable_schema = 1'
		];
		const out = await inObject(freshSite(), (site) => {
			kvOf(site).put('probe', MARK);
			const results = shapes.map((text) => ({ text, ...attempt(site, text) }));
			return { results, after: kvOf(site).get('probe') };
		});
		// the value never comes back through any shape, whether the statement ran or was refused
		expect(JSON.stringify(out.results)).not.toContain(MARK);
		expect(out.after).toBe(MARK);
		console.info(
			`sealed-storage reach by shape: ${JSON.stringify(
				out.results.map((r) => [r.text, 'error' in r ? r.error : `${r.rows?.length} rows`])
			)}`
		);
	});

	it('refuses a rename onto the key-value table, including before anything has created it', async () => {
		const out = await inObject(freshSite(), (site) => {
			const listed = () =>
				(
					site.sql
						.exec("SELECT name FROM sqlite_master WHERE name = '_cf_KV'")
						.toArray() as { name: string }[]
				).length;
			const existedAtStart = listed() > 0;
			const steps = [
				'CREATE TABLE planted (key TEXT PRIMARY KEY, value BLOB)',
				"INSERT INTO planted (key, value) VALUES ('owner_token_sha256', 'planted-hash')",
				'ALTER TABLE planted RENAME TO _cf_KV'
			].map((text) => ({ text, ...attempt(site, text) }));
			const renamed = listed() > 0 && !existedAtStart;
			// what the object's own storage reads back after the attempt
			const read = kvOf(site).get('owner_token_sha256');
			return { existedAtStart, steps, renamed, read };
		});
		console.info(`rename onto _cf_KV, measured: ${JSON.stringify(out)}`);
		// a planted table must never become the key-value table, whether or not one existed
		expect(out.renamed).toBe(false);
		expect(out.read).not.toBe('planted-hash');
	});

	it('answers the same through PHP, which is how an attacker with code reaches SQL', async () => {
		const out = await inObject(freshSite(), async (site) => {
			kvOf(site).put('probe', MARK);
			const php = await site.runJson(
				`<?php
				$out = [];
				if (!function_exists('cfw_host')) {${HOST_HELPERS_PHP}}
					$out[] = json_encode(cfw_sql('SELECT 1 AS one', []));
					foreach (['SELECT * FROM _cf_KV', "UPDATE _cf_KV SET value = 'x'", 'DROP TABLE _cf_KV'] as $q) {
					try { $out[] = json_encode(cfw_sql($q, [])); } catch (\\Throwable $e) { $out[] = 'threw: ' . $e->getMessage(); }
				}
				echo json_encode($out);`
			);
			return { php, after: kvOf(site).get('probe') };
		});
		// the bridge is loaded and reaches SQL, so what follows is the platform's refusal
		expect(JSON.stringify(out.php)).toContain('one');
		expect(JSON.stringify(out.php)).not.toContain('undefined function');
		expect(JSON.stringify(out.php)).not.toContain(MARK);
		expect(out.after).toBe(MARK);
	});

	it('leaves neither the token nor its hash in cfw_meta after a claim', async () => {
		const stub = freshSite();
		const { token, rows } = await inObject(stub, async (site) => {
			site.ensureServeTables();
			const minted = await mintOwnerToken(site.secretStore());
			return {
				token: minted ?? '',
				rows: JSON.stringify(site.sql.exec('SELECT * FROM cfw_meta').toArray())
			};
		});
		expect(token).not.toBe('');
		const hash = await sha256Hex(token);
		expect(rows).not.toContain(token);
		expect(rows).not.toContain(hash);
		expect(rows).not.toContain(OWNER_HASH_KEY);
	});

	it('is not replaced by SQL: a planted token row or a hash write changes nothing', async () => {
		const stub = freshSite();
		const verdict = await inObject(stub, async (site) => {
			site.ensureServeTables();
			const store = site.secretStore();
			const real = (await mintOwnerToken(store)) ?? '';
			const attacker = 'attacker-known-token';
			// the two writes a SQL attacker has: a plaintext row, and a row holding a known hash
			site.sql.exec("INSERT INTO cfw_meta (k, v) VALUES ('owner_token', ?)", attacker);
			site.sql.exec(
				'INSERT OR REPLACE INTO cfw_meta (k, v) VALUES (?, ?)',
				OWNER_HASH_KEY,
				await sha256Hex(attacker)
			);
			return {
				attacker: await ownerTokenMatches(store, attacker),
				real: await ownerTokenMatches(store, real),
				plantedRowLeft: site.metaGet('owner_token')
			};
		});
		expect(verdict).toEqual({ attacker: false, real: true, plantedRowLeft: null });
	});

	it('migrates a legacy plaintext token when the object wakes, before any request', async () => {
		const stub = freshSite();
		await inObject(stub, (site) => {
			site.ensureServeTables();
			site.metaSet(OWNER_TOKEN_KEY, TOKEN);
		});
		// a second instance over the same storage is a wake; its constructor adopts the row
		const woke = await inObject(stub, async (site) => {
			const { SitePhpDurableObject } = await import('../../src/site-do');
			const next = new SitePhpDurableObject(
				site.ctx as never,
				site.env as never
			) as unknown as ServeDo & { ownerAdoption: Promise<void> };
			await next.ownerAdoption;
			return {
				row: next.metaGet(OWNER_TOKEN_KEY),
				matches: await ownerTokenMatches(next.secretStore(), TOKEN)
			};
		});
		expect(woke).toEqual({ row: null, matches: true });
	});
});
