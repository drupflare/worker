import { describe, expect, it } from 'vitest';
import { strataConfigPhp } from '../../src/drupal/strata-php';
import { mintOwnerToken } from '../../src/ops/site-secrets';
import { capturesStatements, strataEnabled } from '../../src/ops/strata-config';
import { inObject, provisionedNamedSite, type ServeDo } from '../helpers/serve-do';

/** `/strata-config`: Strata's `capture.statements` read and set from the owner API */

let sites = 0;

async function claimed() {
	const stub = await provisionedNamedSite(`strata-${++sites}.example`);
	const token = await inObject(stub, async (site) => {
		site.ensureServeTables();
		return (await mintOwnerToken(site.secretStore())) ?? '';
	});
	return { stub, token };
}

const call = (stub: DurableObjectStub, method: string, token: string, body?: unknown) =>
	inObject(stub, (site) =>
		site.fetch(
			new Request('https://do.local/__strata-config', {
				method,
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			})
		)
	);

const serialised = (statements: boolean) =>
	`a:2:{s:7:"capture";a:2:{s:6:"entity";b:1;s:10:"statements";b:${statements ? 1 : 0};}s:7:"enabled";b:0;}`;

const putConfig = (site: ServeDo, name: string, data: string) => {
	site.sql.exec(
		"CREATE TABLE IF NOT EXISTS config (collection TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', data BLOB, PRIMARY KEY (collection, name))"
	);
	site.sql.exec('DELETE FROM config WHERE collection = ? AND name = ?', '', name);
	site.sql.exec(
		'INSERT INTO config (collection, name, data) VALUES (?, ?, ?)',
		'',
		name,
		new TextEncoder().encode(data)
	);
};

const installStrata = (site: ServeDo, statements: boolean) => {
	putConfig(
		site,
		'core.extension',
		'a:2:{s:6:"module";a:1:{s:6:"strata";i:0;}s:5:"theme";a:0:{}}'
	);
	putConfig(site, 'strata.settings', serialised(statements));
};

type Stubbed = ServeDo & { speculating?: boolean; php: unknown };

/** replaces the interpreter bridge with one that applies the requested value to the row */
const stubBridge = (site: ServeDo, calls: string[], reply?: Record<string, unknown>) => {
	(site as unknown as { runJson: (code: string) => Promise<unknown> }).runJson = async (code) => {
		calls.push(code);
		if (reply !== undefined) return reply;
		const value = code.includes("'capture.statements', true");
		putConfig(site, 'strata.settings', serialised(value));
		return { ok: true, before: !value, after: value };
	};
};

describe('the stored-row readers', () => {
	it('reads the flag from a serialised strata.settings row', async () => {
		const { stub } = await claimed();
		const seen = await inObject(stub, (site) => {
			installStrata(site, true);
			const on = capturesStatements(site.sql);
			putConfig(site, 'strata.settings', serialised(false));
			const off = capturesStatements(site.sql);
			putConfig(site, 'strata.settings', 'a:0:{}');
			const absentKey = capturesStatements(site.sql);
			site.sql.exec("DELETE FROM config WHERE name = 'strata.settings'");
			return { on, off, absentKey, noRow: capturesStatements(site.sql) };
		});
		expect(seen).toEqual({ on: true, off: false, absentKey: false, noRow: undefined });
	});

	it('reads the module from core.extension', async () => {
		const { stub } = await claimed();
		const seen = await inObject(stub, (site) => {
			putConfig(site, 'core.extension', 'a:2:{s:6:"module";a:0:{}s:5:"theme";a:0:{}}');
			const without = strataEnabled(site.sql);
			installStrata(site, true);
			return { without, with: strataEnabled(site.sql) };
		});
		expect(seen).toEqual({ without: false, with: true });
	});
});

describe('strataConfigPhp', () => {
	it('writes through ConfigFactory, refuses a row-less save, and carries the value', () => {
		const on = strataConfigPhp(true, 'https://a.example');
		const off = strataConfigPhp(false, 'https://a.example');
		expect(on).toContain("getEditable('strata.settings')");
		expect(on).toContain('isNew()');
		expect(on).toContain("set('capture.statements', true)");
		expect(off).toContain("set('capture.statements', false)");
		expect(on).not.toMatch(/__CFW_/);
	});
});

describe('/strata-config', () => {
	it('answers 405 to a verb other than GET and POST', async () => {
		const { stub, token } = await claimed();
		expect((await call(stub, 'DELETE', token)).status).toBe(405);
	});

	it('answers 409 strata_not_enabled when the module is absent, and writes nothing', async () => {
		const { stub, token } = await claimed();
		const calls: string[] = [];
		await inObject(stub, (site) => {
			putConfig(site, 'core.extension', 'a:2:{s:6:"module";a:0:{}s:5:"theme";a:0:{}}');
			stubBridge(site, calls);
		});
		for (const res of [
			await call(stub, 'GET', token),
			await call(stub, 'POST', token, { captureStatements: true })
		]) {
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({ ok: false, error: 'strata_not_enabled' });
		}
		const rows = await inObject(stub, (site) =>
			site.sql
				.exec("SELECT COUNT(*) AS n FROM config WHERE name = 'strata.settings'")
				.toArray()
		);
		expect(rows[0]!.n).toBe(0);
		expect(calls).toEqual([]);
	});

	it('answers 409 when the module is listed but has no config row', async () => {
		const { stub, token } = await claimed();
		const calls: string[] = [];
		await inObject(stub, (site) => {
			installStrata(site, false);
			site.sql.exec("DELETE FROM config WHERE name = 'strata.settings'");
			stubBridge(site, calls);
		});
		const res = await call(stub, 'POST', token, { captureStatements: true });
		expect(res.status).toBe(409);
		expect(calls).toEqual([]);
	});

	it('rejects a body that is not {captureStatements: boolean}', async () => {
		const { stub, token } = await claimed();
		await inObject(stub, (site) => installStrata(site, false));
		for (const body of [{}, { captureStatements: 'true' }, { captureStatements: 1 }, null]) {
			expect((await call(stub, 'POST', token, body)).status).toBe(400);
		}
	});

	it('sets true then false, reporting the previous value each time', async () => {
		const { stub, token } = await claimed();
		const calls: string[] = [];
		await inObject(stub, (site) => {
			installStrata(site, false);
			stubBridge(site, calls);
		});
		expect(await (await call(stub, 'GET', token)).json()).toEqual({ captureStatements: false });

		const up = await call(stub, 'POST', token, { captureStatements: true });
		expect(up.status).toBe(200);
		expect(await up.json()).toEqual({
			captureStatements: true,
			previous: false,
			applied: true
		});
		expect(await (await call(stub, 'GET', token)).json()).toEqual({ captureStatements: true });

		const down = await call(stub, 'POST', token, { captureStatements: false });
		expect(await down.json()).toEqual({
			captureStatements: false,
			previous: true,
			applied: true
		});
		expect(calls).toHaveLength(2);
	});

	it('drops the interpreter after a write', async () => {
		const { stub, token } = await claimed();
		await inObject(stub, (site) => {
			installStrata(site, false);
			stubBridge(site, []);
			(site as Stubbed).php = { binary: { HEAPU8: new Uint8Array(16) } };
		});
		await call(stub, 'POST', token, { captureStatements: true });
		expect(await inObject(stub, (site) => (site as Stubbed).php)).toBeUndefined();
	});

	it('answers applied with previous equal to the value, and runs no PHP, on a repeat', async () => {
		const { stub, token } = await claimed();
		const calls: string[] = [];
		await inObject(stub, (site) => {
			installStrata(site, true);
			stubBridge(site, calls);
		});
		const res = await call(stub, 'POST', token, { captureStatements: true });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			captureStatements: true,
			previous: true,
			applied: true
		});
		expect(calls).toEqual([]);
	});

	it('answers 500 and keeps the row when the write does not land', async () => {
		const { stub, token } = await claimed();
		await inObject(stub, (site) => {
			installStrata(site, false);
			stubBridge(site, [], { ok: false, error: 'boom' });
		});
		const res = await call(stub, 'POST', token, { captureStatements: true });
		expect(res.status).toBe(500);
		expect(await (await call(stub, 'GET', token)).json()).toEqual({ captureStatements: false });
	});

	it('refuses with 409 while a transaction is open and writes nothing', async () => {
		const { stub, token } = await claimed();
		const calls: string[] = [];
		await inObject(stub, (site) => {
			installStrata(site, false);
			stubBridge(site, calls);
			(site as Stubbed).speculating = true;
		});
		const res = await call(stub, 'POST', token, { captureStatements: true });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ ok: false, error: 'a transaction is open' });
		expect(calls).toEqual([]);
		await inObject(stub, (site) => {
			(site as Stubbed).speculating = false;
		});
		expect(await (await call(stub, 'GET', token)).json()).toEqual({ captureStatements: false });
	});
});
