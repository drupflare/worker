import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { DEPLOYMENT_KEY, resetDeploymentMemo } from '../../src/ops/deployment-site';
import { resetHostMemo, resolveSite, siteKvKey } from '../../src/ops/site-id';
import { ORIGIN_KEY } from '../../src/ops/site-origin';
import worker from '../../src/site';
import {
	inObject,
	namedSite,
	provisionedNamedSite,
	seedPage,
	type ServeDo
} from '../helpers/serve-do';

/**
 * One deployment is one site, against real objects: the census each claimed site answers, the
 * choice it drives, and the promise that choosing never writes to the site that loses.
 *
 * The Drupal tables are created by hand with the columns the census reads, so this needs no pack.
 */

type Kv = { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> };
const kv = () => (env as unknown as { CONFIG_KV: Kv }).CONFIG_KV;
const run = Math.random().toString(36).slice(2, 8);

afterEach(async () => {
	await kv().put(DEPLOYMENT_KEY, '');
	resetDeploymentMemo();
	resetHostMemo();
});

/** a claimed site holding `nodes` nodes and `accounts` accounts beyond uid 1 */
async function claimedSite(name: string, nodes: number, accounts: number, claimedAt: number) {
	const stub = namedSite(name);
	await inObject(stub, (site: ServeDo) => {
		site.ensureServeTables();
		site.sql.exec('CREATE TABLE IF NOT EXISTS node (nid INTEGER PRIMARY KEY, type TEXT)');
		site.sql.exec('CREATE TABLE IF NOT EXISTS node_field_data (nid INTEGER, changed INTEGER)');
		site.sql.exec('CREATE TABLE IF NOT EXISTS users (uid INTEGER PRIMARY KEY, uuid TEXT)');
		site.sql.exec('CREATE TABLE IF NOT EXISTS users_field_data (uid INTEGER, changed INTEGER)');
		for (const uid of [0, 1])
			site.sql.exec('INSERT INTO users (uid, uuid) VALUES (?, ?)', uid, `u${uid}`);
		for (let i = 1; i <= nodes; i++) {
			site.sql.exec('INSERT INTO node (nid, type) VALUES (?, ?)', i, 'page');
			site.sql.exec(
				'INSERT INTO node_field_data (nid, changed) VALUES (?, ?)',
				i,
				1_700_000_000 + i
			);
		}
		for (let i = 2; i < 2 + accounts; i++) {
			site.sql.exec('INSERT INTO users (uid, uuid) VALUES (?, ?)', i, `u${i}`);
		}
		site.metaSet('first_run_at', claimedAt);
		site.metaSet('deployment_recorded', claimedAt);
	});
	return stub;
}

/** every row of every Drupal table, which is what "untouched" means for a site */
function drupalRows(site: ServeDo): string {
	const tables = site.sql
		.exec(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'cfw_%' AND name NOT LIKE '_cf_%' ORDER BY name"
		)
		.toArray()
		.map((r) => String(r.name));
	return JSON.stringify(
		tables.map((t) => [t, site.sql.exec(`SELECT * FROM "${t}" ORDER BY rowid`).toArray()])
	);
}

describe('a deployment with more than one claimed site', () => {
	it('serves the populated one to an unmapped host and leaves the empty one byte-identical', async () => {
		const real = `real-${run}`;
		const accidental = `accidental-${run}`;
		await claimedSite(real, 12, 3, 1_000);
		const loser = await claimedSite(accidental, 0, 0, 500);
		// the accidental claim is listed FIRST, so claim order cannot be what decides
		await kv().put(
			DEPLOYMENT_KEY,
			JSON.stringify({ primary: null, claimed: [accidental, real] })
		);
		const before = await inObject(loser, drupalRows);

		const resolved = await resolveSite(new URL('https://unmapped.example/'), {
			CONFIG_KV: kv(),
			SITE: env.SITE
		});
		expect(resolved).toEqual({ site: real, from: 'primary' });
		expect(JSON.parse((await kv().get(DEPLOYMENT_KEY)) ?? '{}')).toMatchObject({
			primary: real,
			chosen: 'content'
		});
		expect(await inObject(loser, drupalRows)).toBe(before);

		// content added to the losing site later does not move the hostname
		await inObject(loser, (site: ServeDo) => {
			for (let i = 1; i <= 50; i++)
				site.sql.exec('INSERT INTO node (nid, type) VALUES (?, ?)', i, 'page');
		});
		resetDeploymentMemo();
		expect(
			await resolveSite(new URL('https://another.example/'), {
				CONFIG_KV: kv(),
				SITE: env.SITE
			})
		).toEqual({ site: real, from: 'primary' });
	});

	it('reports what each site holds, which is what /health lists for the one not served', async () => {
		const name = `census-${run}`;
		await claimedSite(name, 4, 2, 42);
		const res = await namedSite(name).fetch('https://do.local/__deployment');
		expect(await res.json()).toEqual({
			site: name,
			claimedAt: 42,
			nodes: 4,
			accounts: 2,
			lastWrite: 1_700_000_004
		});
	});
});

describe('a site claimed before the deployment document existed', () => {
	it('lists itself on its next request and keeps serving every unmapped host', async () => {
		const name = `legacy-${run}.example.com`;
		const stub = namedSite(name);
		const before = await inObject(stub, (site: ServeDo) => {
			site.ensureServeTables();
			site.sql.exec('CREATE TABLE IF NOT EXISTS node (nid INTEGER PRIMARY KEY, type TEXT)');
			site.sql.exec('INSERT INTO node (nid, type) VALUES (1, ?)', 'article');
			site.metaSet('first_run_at', 7);
			return drupalRows(site);
		});
		await stub.fetch('https://do.local/__deployment');
		// the listing is written through waitUntil; poll the document rather than guess a delay
		let doc: { primary?: string | null; claimed?: string[] } = {};
		for (let i = 0; i < 50 && !(doc.claimed ?? []).includes(name); i++) {
			await new Promise((r) => setTimeout(r, 20));
			doc = JSON.parse((await kv().get(DEPLOYMENT_KEY)) || '{}');
		}
		expect(doc).toMatchObject({ primary: null, claimed: [name] });
		resetDeploymentMemo();
		expect(
			await resolveSite(new URL('https://demo.example.com/'), {
				CONFIG_KV: kv(),
				SITE: env.SITE
			})
		).toEqual({ site: name, from: 'primary' });
		expect(await inObject(stub, drupalRows)).toBe(before);
	});
});

describe('an alias host mapped to the site', () => {
	it('answers with its links on the alias, and the canonical host gets the stored bytes', async () => {
		const name = `aliased-${run}`;
		const canonical = `https://primary-${run}.example.test`;
		const alias = `https://alias-${run}.example.test`;
		const stub = await provisionedNamedSite(name);
		await inObject(stub, (site: ServeDo) => {
			site.metaSet(ORIGIN_KEY, canonical);
			seedPage(
				site,
				'/',
				`<link rel="canonical" href="${canonical}/"><a href="${canonical}/node/1">n</a>`
			);
		});
		for (const origin of [canonical, alias]) {
			await kv().put(siteKvKey(new URL(origin).host), name);
		}
		const get = async (origin: string) => {
			const res = await worker.fetch(new Request(`${origin}/`), env as never);
			return { alias: res.headers.get('x-cfw-alias'), body: await res.text() };
		};

		const onAlias = await get(alias);
		expect(onAlias.alias).toBe(new URL(canonical).host);
		expect(onAlias.body).toContain(`href="${alias}/node/1"`);
		expect(onAlias.body).not.toContain(canonical);

		// the control: the canonical host maps to the same site and gets the stored bytes
		const onCanonical = await get(canonical);
		expect(onCanonical.alias).toBeNull();
		expect(onCanonical.body).toContain(`href="${canonical}/node/1"`);
	});
});
