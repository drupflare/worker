import {
	createExecutionContext,
	env,
	runDurableObjectAlarm,
	waitOnExecutionContext
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	OWNER_FAIL_LIMIT,
	ownerRefusedForNow,
	resetOwnerFailures
} from '../../src/ops/admin-session';
import { DEPLOYMENT_KEY, resetDeploymentMemo } from '../../src/ops/deployment-site';
import { ensureFleetTable, listSites, reportSite, type FleetDb } from '../../src/ops/fleet';
import { verifyAuditChain } from '../../src/ops/owner-audit';
import { RETIRE_LOG_KEY } from '../../src/ops/retire';
import { resetHostMemo, siteKvKey } from '../../src/ops/site-id';
import { mintOwnerToken } from '../../src/ops/site-secrets';
import worker from '../../src/site';
import { inObject, namedSite, provisionedNamedSite, type ServeDo } from '../helpers/serve-do';

/**
 * `POST /retire`: an owner route that wipes one site's object and forgets it in the front worker.
 *
 * Every call goes through the front worker with `PW_DIAGNOSTICS` removed, which is how it is
 * deployed. The pool binds the flag for the whole project, and under it an owner route skips its
 * credential, so a spec that kept it would assert nothing about the token.
 */

type Kv = {
	get(k: string): Promise<string | null>;
	put(k: string, v: string): Promise<void>;
	delete(k: string): Promise<void>;
};
const kv = () => (env as unknown as { CONFIG_KV: Kv }).CONFIG_KV;
const run = Math.random().toString(36).slice(2, 8);
const TIMEOUT = 900_000;

// fresh names per test: a retired instance stays retired in memory for as long as it is resident
let PRIMARY = '';
let OLD = '';
let count = 0;
type Armable = { setAlarmAt(at: number): Promise<void> };
const fleetDb = () => env.FLEET_DB as unknown as FleetDb;
const tokens = new Map<string, string>();

beforeEach(() => {
	resetOwnerFailures();
	count++;
	PRIMARY = `retire-primary-${run}-${count}`;
	OLD = `retire-old-${run}-${count}`;
});

afterEach(async () => {
	await kv().put(DEPLOYMENT_KEY, '');
	await kv().put(RETIRE_LOG_KEY, '');
	resetDeploymentMemo();
	resetHostMemo();
});

/** a provisioned site with an owner token and a pending alarm, recorded in the deployment */
async function site(name: string, claimed = true): Promise<void> {
	const stub = await provisionedNamedSite(name);
	await inObject(stub, async (s: ServeDo) => {
		const token = await mintOwnerToken(s.secretStore());
		tokens.set(name, token as string);
		await (s as unknown as Armable).setAlarmAt(Date.now() + 600_000);
	});
	if (claimed) {
		const doc = JSON.parse((await kv().get(DEPLOYMENT_KEY)) || '{"primary":null,"claimed":[]}');
		doc.claimed.push(name);
		await kv().put(DEPLOYMENT_KEY, JSON.stringify(doc));
	}
}

async function deployment(): Promise<{ primary: string | null; claimed: string[] }> {
	return JSON.parse((await kv().get(DEPLOYMENT_KEY)) || '{"primary":null,"claimed":[]}');
}

async function fleetRow(name: string): Promise<void> {
	const db = fleetDb();
	await ensureFleetTable(db);
	await reportSite(db, {
		site: name,
		packGeneration: 'g',
		coreVersion: '11',
		workerVersion: 'w',
		plan: 'free',
		lastSeenMs: Date.now(),
		reconcileVersion: 0,
		schemaVersion: 1,
		cms: 'drupal',
		tier: 'managed',
		health: 'ok'
	});
}

/** the front worker without the diagnostic flag */
async function retire(
	name: string,
	opts: {
		token?: string | null;
		body?: unknown;
		query?: string;
		method?: string;
		ip?: string;
		diagnostics?: boolean;
	} = {}
): Promise<Response> {
	const token = opts.token === undefined ? tokens.get(name) : (opts.token ?? undefined);
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (token) headers['authorization'] = `Bearer ${token}`;
	if (opts.ip) headers['cf-connecting-ip'] = opts.ip;
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`https://cfw.local/retire?site=${name}${opts.query ?? ''}`, {
			method: opts.method ?? 'POST',
			headers,
			body:
				opts.method === 'GET'
					? undefined
					: JSON.stringify(opts.body === undefined ? { confirm: name } : opts.body)
		}),
		{
			...env,
			PW_DIAGNOSTICS: opts.diagnostics ? '1' : undefined
		} as unknown as typeof env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return res;
}

/** what the object still holds: user tables, stored keys, and the armed alarm */
function holdings(name: string) {
	return inObject(namedSite(name), async (s: ServeDo) => {
		const storage = (s as unknown as { ctx: DurableObjectState }).ctx.storage;
		const tables = storage.sql
			.exec("SELECT name FROM sqlite_master WHERE name NOT LIKE '_cf_%'")
			.toArray();
		return {
			tables: tables.length,
			keys: (await storage.list()).size,
			alarm: await storage.getAlarm()
		};
	});
}

describe('POST /retire', () => {
	it(
		'wipes a claimed non-primary object and forgets it in the front worker',
		async () => {
			await site(PRIMARY);
			await site(OLD);
			await kv().put(
				DEPLOYMENT_KEY,
				JSON.stringify({ primary: PRIMARY, claimed: [PRIMARY, OLD], chosen: 'explicit' })
			);
			await fleetRow(OLD);
			await fleetRow(PRIMARY);
			await kv().put(siteKvKey('old.example.com'), OLD);
			await kv().put(siteKvKey('keep.example.com'), PRIMARY);
			const before = await holdings(OLD);
			expect(before.tables, 'the fixture holds nothing to wipe').toBeGreaterThan(0);
			expect(before.alarm, 'the fixture armed no alarm').not.toBeNull();

			const res = await retire(OLD);
			expect(res.status, await res.clone().text()).toBe(200);

			expect(await holdings(OLD)).toEqual({ tables: 0, keys: 0, alarm: null });
			expect(await deployment()).toEqual({
				primary: PRIMARY,
				claimed: [PRIMARY],
				chosen: 'explicit'
			});
			const rows = (await listSites(fleetDb())).map((r) => r.site);
			expect(rows).toContain(PRIMARY);
			expect(rows).not.toContain(OLD);
			expect(await kv().get(siteKvKey('old.example.com'))).toBeNull();
			expect(await kv().get(siteKvKey('keep.example.com'))).toBe(PRIMARY);

			const log = JSON.parse((await kv().get(RETIRE_LOG_KEY)) as string);
			expect(log).toHaveLength(1);
			expect(log[0]).toMatchObject({
				seq: 1,
				route: `/retire?site=${OLD}`,
				method: 'POST',
				status: 200
			});
			expect(await verifyAuditChain(log)).toEqual({ verified: true });
			// the primary's own object is untouched
			expect((await holdings(PRIMARY)).alarm).not.toBeNull();
		},
		TIMEOUT
	);

	it(
		'refuses the deployment primary and leaves its object alone',
		async () => {
			await site(PRIMARY);
			await site(OLD);
			await kv().put(
				DEPLOYMENT_KEY,
				JSON.stringify({ primary: PRIMARY, claimed: [PRIMARY, OLD], chosen: 'explicit' })
			);
			const res = await retire(PRIMARY);
			expect(res.status).toBe(409);
			expect(((await res.json()) as { error: string }).error).toContain('primary');
			const held = await holdings(PRIMARY);
			expect(held.tables).toBeGreaterThan(0);
			expect(held.alarm).not.toBeNull();
			expect((await deployment()).claimed).toContain(PRIMARY);
			expect(await kv().get(RETIRE_LOG_KEY)).toBeFalsy();
		},
		TIMEOUT
	);

	it(
		'refuses the only claimed site, which is the primary by default',
		async () => {
			await site(OLD);
			const res = await retire(OLD);
			expect(res.status).toBe(409);
			expect((await holdings(OLD)).tables).toBeGreaterThan(0);
		},
		TIMEOUT
	);

	it(
		'refuses a missing or wrong confirm',
		async () => {
			await site(PRIMARY);
			await site(OLD);
			await kv().put(
				DEPLOYMENT_KEY,
				JSON.stringify({ primary: PRIMARY, claimed: [PRIMARY, OLD] })
			);
			for (const body of [{}, { confirm: PRIMARY }, { confirm: '' }, 'nope']) {
				const res = await retire(OLD, { body });
				expect(res.status, JSON.stringify(body)).toBe(400);
			}
			const held = await holdings(OLD);
			expect(held.tables).toBeGreaterThan(0);
			expect(held.alarm).not.toBeNull();
			expect((await deployment()).claimed).toContain(OLD);
		},
		TIMEOUT
	);

	it(
		'refuses a caller with no token, and counts a wrong one against the failure budget',
		async () => {
			await site(PRIMARY);
			await site(OLD);
			await kv().put(
				DEPLOYMENT_KEY,
				JSON.stringify({ primary: PRIMARY, claimed: [PRIMARY, OLD] })
			);
			const none = await retire(OLD, { token: null });
			expect(none.status).toBe(401);
			expect(none.headers.get('www-authenticate')).toContain('Bearer');

			// the flag opens no owner route here: a destructive call still needs the token
			const flagged = await retire(OLD, { token: null, diagnostics: true });
			expect(flagged.status).toBe(401);

			const ip = '203.0.113.77';
			expect(ownerRefusedForNow(ip, Date.now())).toBe(false);
			for (let i = 0; i < OWNER_FAIL_LIMIT + 1; i++) {
				const res = await retire(OLD, { token: 'not-the-token', ip });
				expect(res.status).toBe(401);
			}
			expect(ownerRefusedForNow(ip, Date.now())).toBe(true);
			// over budget, even the right token from that address is refused before the hop
			expect((await retire(OLD, { ip })).status).toBe(401);

			const held = await holdings(OLD);
			expect(held.tables).toBeGreaterThan(0);
			expect(held.alarm).not.toBeNull();
		},
		TIMEOUT
	);

	it(
		'refuses a token that belongs to another site',
		async () => {
			await site(PRIMARY);
			await site(OLD);
			await kv().put(
				DEPLOYMENT_KEY,
				JSON.stringify({ primary: PRIMARY, claimed: [PRIMARY, OLD] })
			);
			const res = await retire(OLD, { token: tokens.get(PRIMARY) });
			expect(res.status).toBe(401);
			expect((await holdings(OLD)).tables).toBeGreaterThan(0);
		},
		TIMEOUT
	);

	it(
		'retires an unclaimed object only with force=1, and refuses a name that holds nothing',
		async () => {
			await site(PRIMARY);
			await site(OLD, false);
			await kv().put(
				DEPLOYMENT_KEY,
				JSON.stringify({ primary: PRIMARY, claimed: [PRIMARY] })
			);

			const plain = await retire(OLD);
			expect(plain.status).toBe(409);
			expect(((await plain.json()) as { error: string }).error).toContain('force=1');
			expect((await holdings(OLD)).tables).toBeGreaterThan(0);

			const forced = await retire(OLD, { query: '&force=1' });
			expect(forced.status, await forced.clone().text()).toBe(200);
			expect(await holdings(OLD)).toEqual({ tables: 0, keys: 0, alarm: null });

			// it holds nothing now, so retiring it again would only mint a phantom object
			const again = await retire(`ghost-${run}-${count}`, {
				token: tokens.get(PRIMARY),
				query: '&force=1'
			});
			expect([401, 404]).toContain(again.status);
		},
		TIMEOUT
	);

	it(
		'lets the deployment operator retire an unclaimed object that has no owner, with force=1',
		async () => {
			await site(PRIMARY);
			const stray = `retire-stray-${run}-${count}`;
			await provisionedNamedSite(stray);
			await kv().put(
				DEPLOYMENT_KEY,
				JSON.stringify({ primary: PRIMARY, claimed: [PRIMARY] })
			);

			expect((await retire(stray, { token: null, diagnostics: true })).status).toBe(401);
			const res = await retire(stray, {
				token: null,
				diagnostics: true,
				query: '&force=1'
			});
			expect(res.status, await res.clone().text()).toBe(200);
			expect((await holdings(stray)).tables).toBe(0);
			// a claimed site is never reachable this way
			await site(OLD);
			await kv().put(
				DEPLOYMENT_KEY,
				JSON.stringify({ primary: PRIMARY, claimed: [PRIMARY, OLD] })
			);
			const claimed = await retire(OLD, {
				token: null,
				diagnostics: true,
				query: '&force=1'
			});
			expect(claimed.status).toBe(401);
		},
		TIMEOUT
	);

	it('answers 405 to anything but POST', async () => {
		await site(PRIMARY);
		await site(OLD);
		const res = await retire(OLD, { method: 'GET' });
		expect(res.status).toBe(405);
		expect((await holdings(OLD)).tables).toBeGreaterThan(0);
	});
});

describe('a retired object stays retired', () => {
	it(
		'arms no alarm after a request, a fired alarm, or a stray setAlarm',
		async () => {
			await site(PRIMARY);
			await site(OLD);
			await kv().put(
				DEPLOYMENT_KEY,
				JSON.stringify({ primary: PRIMARY, claimed: [PRIMARY, OLD] })
			);
			expect((await retire(OLD)).status).toBe(200);
			const stub = namedSite(OLD);

			// a request: answered 410, writes nothing, arms nothing
			const served = await stub.fetch('https://do.local/__serve?path=/');
			expect(served.status).toBe(410);
			expect(await holdings(OLD)).toEqual({ tables: 0, keys: 0, alarm: null });

			// the platform has no alarm to fire, and a firing run by hand does nothing either
			expect(await runDurableObjectAlarm(stub)).toBe(false);
			await inObject(stub, async (s: ServeDo) => {
				await (s as unknown as { alarm(): Promise<unknown> }).alarm();
			});
			expect(await holdings(OLD)).toEqual({ tables: 0, keys: 0, alarm: null });

			// the schedulers a fill or the warm chain would call
			await inObject(stub, async (s: ServeDo) => {
				await (s as unknown as Armable).setAlarmAt(Date.now() + 1000);
				(s as unknown as { armFillAlarm(ms?: number): void }).armFillAlarm(5_000);
			});
			expect(await holdings(OLD)).toEqual({ tables: 0, keys: 0, alarm: null });
		},
		TIMEOUT
	);
});
