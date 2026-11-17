import { describe, expect, it, vi } from 'vitest';
import { strataStorePhp } from '../../src/drupal/strata-php';
import { mintOwnerToken } from '../../src/ops/site-secrets';
import {
	parseStoreRequest,
	readStrataStore,
	type StrataStoreRequest
} from '../../src/ops/strata-config';
import { inObject, provisionedNamedSite, type ServeDo } from '../helpers/serve-do';

/** `/strata-store`: Strata's S3 endpoint, bucket and credentials set and read from the owner API */

const SECRET = 'SECRETvalue0123456789abcdefSECRETvalue0123456789abcdef';
const KEY_ID = 'AKIAEXAMPLEKEYID0001';

const body = (over: Record<string, unknown> = {}) => ({
	endpoint: 'https://acct.r2.cloudflarestorage.com',
	bucket: 'site-backups',
	region: 'auto',
	accessKeyId: KEY_ID,
	secretAccessKey: SECRET,
	pathStyle: true,
	...over
});

let sites = 0;

async function claimed() {
	const stub = await provisionedNamedSite(`strata-store-${++sites}.example`);
	const token = await inObject(stub, async (site) => {
		site.ensureServeTables();
		return (await mintOwnerToken(site.secretStore())) ?? '';
	});
	return { stub, token };
}

const call = (stub: DurableObjectStub, method: string, token: string, payload?: unknown) =>
	inObject(stub, (site) =>
		site.fetch(
			new Request('https://do.local/__strata-store', {
				method,
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				...(payload === undefined ? {} : { body: JSON.stringify(payload) })
			})
		)
	);

type Tree = { [key: string]: string | number | boolean | null | Tree };

/** PHP `serialize()` of the subset a config row holds */
function ser(value: Tree[string]): string {
	if (value === null) return 'N;';
	if (typeof value === 'boolean') return `b:${value ? 1 : 0};`;
	if (typeof value === 'number') return `i:${value};`;
	if (typeof value === 'string') return `s:${new TextEncoder().encode(value).length}:"${value}";`;
	const entries = Object.entries(value);
	return `a:${entries.length}:{${entries.map(([k, v]) => ser(k) + ser(v)).join('')}}`;
}

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

const settings = (key: string, enabled: boolean): Tree => ({
	enabled,
	provider: 'local',
	key,
	s3: {
		endpoint: '',
		bucket: '',
		region: 'us-east-1',
		access_key_id: '',
		secret_access_key: '',
		path_style: false
	},
	capture: { statements: true }
});

const install = (
	site: ServeDo,
	opts: { s3?: boolean; key?: string; row?: boolean; enabled?: boolean } = {}
) => {
	const modules: Tree = { strata: 0 };
	if (opts.s3 ?? true) modules['strata_s3'] = 0;
	putConfig(site, 'core.extension', ser({ module: modules, theme: {} }));
	if (opts.row !== false)
		putConfig(site, 'strata.settings', ser(settings(opts.key ?? '', opts.enabled ?? false)));
};

/** replaces the interpreter bridge with one that applies the payload the fragment carries */
const stubBridge = (site: ServeDo, calls: string[], reply?: Record<string, unknown>) => {
	(site as unknown as { runJson: (code: string) => Promise<unknown> }).runJson = async (code) => {
		calls.push(code);
		if (reply !== undefined) return reply;
		const encoded = /base64_decode\('([^']*)'\)/.exec(code)?.[1] ?? '';
		const want = JSON.parse(atob(encoded)) as StrataStoreRequest;
		const row = readStrataStore(site.sql);
		const keyCreated = row?.hasKey !== true;
		putConfig(
			site,
			'strata.settings',
			ser({
				enabled: want.enable ? true : row?.enabled === true,
				provider: 's3',
				key: keyCreated ? 'strata_backup' : 'existing_key',
				s3: {
					endpoint: want.endpoint,
					bucket: want.bucket,
					region: want.region,
					access_key_id: want.accessKeyId,
					secret_access_key: want.secretAccessKey,
					path_style: want.pathStyle
				}
			})
		);
		return { ok: true, keyCreated };
	};
};

type Stubbed = ServeDo & { speculating?: boolean; php: unknown };

const auditRoutes = async (stub: DurableObjectStub, token: string) => {
	const res = await inObject(stub, (site) =>
		site.fetch(
			new Request('https://do.local/__audit', {
				headers: { authorization: `Bearer ${token}` }
			})
		)
	);
	return await res.text();
};

describe('parseStoreRequest', () => {
	it('accepts a valid body and normalises the endpoint to its origin', () => {
		const ok = parseStoreRequest(body({ endpoint: 'https://Acct.example.com/' }));
		expect(ok).toMatchObject({ ok: true, value: { endpoint: 'https://acct.example.com' } });
	});

	it.each([
		['not an object', null, 'invalid_body'],
		['an array', [], 'invalid_body'],
		['http endpoint', body({ endpoint: 'http://a.example.com' }), 'invalid_endpoint'],
		['endpoint with a path', body({ endpoint: 'https://a.example.com/b' }), 'invalid_endpoint'],
		[
			'endpoint with a query',
			body({ endpoint: 'https://a.example.com?x=1' }),
			'invalid_endpoint'
		],
		[
			'endpoint with userinfo',
			body({ endpoint: 'https://u:p@a.example.com' }),
			'invalid_endpoint'
		],
		['no endpoint', body({ endpoint: undefined }), 'invalid_endpoint'],
		['short bucket', body({ bucket: 'ab' }), 'invalid_bucket'],
		['long bucket', body({ bucket: 'a'.repeat(64) }), 'invalid_bucket'],
		['uppercase bucket', body({ bucket: 'Site-Backups' }), 'invalid_bucket'],
		['dotted bucket', body({ bucket: 'site.backups' }), 'invalid_bucket'],
		['empty region', body({ region: '' }), 'invalid_region'],
		['empty key id', body({ accessKeyId: '' }), 'invalid_access_key_id'],
		['long key id', body({ accessKeyId: 'a'.repeat(257) }), 'invalid_access_key_id'],
		['empty secret', body({ secretAccessKey: '' }), 'invalid_secret_access_key'],
		['long secret', body({ secretAccessKey: 'a'.repeat(257) }), 'invalid_secret_access_key'],
		['spaced secret', body({ secretAccessKey: 'a b' }), 'invalid_secret_access_key'],
		['string path style', body({ pathStyle: 'true' }), 'invalid_path_style'],
		['string enable', body({ enable: 'true' }), 'invalid_enable'],
		['null enable', body({ enable: null }), 'invalid_enable']
	])('refuses %s with %s', (_name, input, code) => {
		expect(parseStoreRequest(input)).toEqual({ ok: false, code });
	});
});

describe('strataStorePhp', () => {
	it('sets provider s3 through ConfigFactory, uses the key maker, and carries no raw secret', () => {
		const php = strataStorePhp(parseOk(), 'https://a.example');
		expect(php).toContain("getEditable('strata.settings')");
		expect(php).toContain('isNew()');
		expect(php).toContain("Drupal::service('strata.key_maker')->create()");
		expect(php).toContain("moduleExists('strata_s3')");
		expect(php).not.toMatch(/__CFW_/);
		expect(php).not.toContain(SECRET);
	});

	it('never prints a message or a trace from a failure', () => {
		const php = strataStorePhp(parseOk());
		expect(php).not.toContain('getMessage');
		expect(php).not.toContain('getTrace');
	});
});

function parseOk(): StrataStoreRequest {
	const parsed = parseStoreRequest(body());
	if (!parsed.ok) throw new Error('fixture body must validate');
	return parsed.value;
}

describe('/strata-store', () => {
	it('answers 405 to a verb other than GET and POST', async () => {
		const { stub, token } = await claimed();
		expect((await call(stub, 'DELETE', token)).status).toBe(405);
	});

	it('answers 400 with a stable code and no PHP call for each refused body', async () => {
		const { stub, token } = await claimed();
		const calls: string[] = [];
		await inObject(stub, (site) => {
			install(site);
			stubBridge(site, calls);
		});
		const cases: [unknown, string][] = [
			[null, 'invalid_body'],
			[body({ endpoint: 'http://a.example.com' }), 'invalid_endpoint'],
			[body({ bucket: 'AB' }), 'invalid_bucket'],
			[body({ region: '' }), 'invalid_region'],
			[body({ accessKeyId: '' }), 'invalid_access_key_id'],
			[body({ secretAccessKey: '' }), 'invalid_secret_access_key'],
			[body({ pathStyle: 1 }), 'invalid_path_style'],
			[body({ enable: 1 }), 'invalid_enable']
		];
		for (const [payload, code] of cases) {
			const res = await call(stub, 'POST', token, payload);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ ok: false, error: code });
		}
		expect(calls).toEqual([]);
	});

	it('answers 409 strata_not_enabled when the module is absent, and writes nothing', async () => {
		const { stub, token } = await claimed();
		const calls: string[] = [];
		await inObject(stub, (site) => {
			putConfig(site, 'core.extension', ser({ module: {}, theme: {} }));
			stubBridge(site, calls);
		});
		for (const res of [
			await call(stub, 'GET', token),
			await call(stub, 'POST', token, body())
		]) {
			expect(res.status).toBe(409);
			expect(await res.json()).toEqual({ ok: false, error: 'strata_not_enabled' });
		}
		const rows = await inObject(stub, (site) =>
			site.sql
				.exec("SELECT COUNT(*) AS n FROM config WHERE name = 'strata.settings'")
				.toArray()
		);
		expect(rows[0]!.n).toBe(0);
		expect(calls).toEqual([]);
	});

	it('answers 409 strata_not_enabled when the module is listed but has no row', async () => {
		const { stub, token } = await claimed();
		const calls: string[] = [];
		await inObject(stub, (site) => {
			install(site, { row: false });
			stubBridge(site, calls);
		});
		expect((await call(stub, 'POST', token, body())).status).toBe(409);
		expect(calls).toEqual([]);
	});

	it('answers 409 strata_s3_not_enabled when the submodule is absent, and writes nothing', async () => {
		const { stub, token } = await claimed();
		const calls: string[] = [];
		await inObject(stub, (site) => {
			install(site, { s3: false });
			stubBridge(site, calls);
		});
		const res = await call(stub, 'POST', token, body());
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ ok: false, error: 'strata_s3_not_enabled' });
		expect(calls).toEqual([]);
		expect((await (await call(stub, 'GET', token)).json()) as object).toMatchObject({
			provider: 'local'
		});
	});

	it('reads the store with hasKey and hasCredentials and no secret', async () => {
		const { stub, token } = await claimed();
		await inObject(stub, (site) => install(site));
		const res = await call(stub, 'GET', token);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			provider: 'local',
			enabled: false,
			bucket: '',
			endpoint: '',
			region: 'us-east-1',
			hasKey: false,
			hasCredentials: false
		});
	});

	it('sets the store, creates the key when empty, and reads it back without a secret', async () => {
		const { stub, token } = await claimed();
		const calls: string[] = [];
		await inObject(stub, (site) => {
			install(site);
			stubBridge(site, calls);
		});
		const res = await call(stub, 'POST', token, body());
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(JSON.parse(text)).toEqual({
			provider: 's3',
			bucket: 'site-backups',
			endpoint: 'https://acct.r2.cloudflarestorage.com',
			region: 'auto',
			applied: true,
			previous: { provider: 'local', bucket: '' },
			keyCreated: true,
			enabled: false
		});
		const read = await (await call(stub, 'GET', token)).text();
		expect(JSON.parse(read)).toEqual({
			provider: 's3',
			enabled: false,
			bucket: 'site-backups',
			endpoint: 'https://acct.r2.cloudflarestorage.com',
			region: 'auto',
			hasKey: true,
			hasCredentials: true
		});
		for (const out of [text, read]) {
			expect(out).not.toContain(SECRET);
			expect(out).not.toContain(KEY_ID);
		}
		expect(calls).toHaveLength(1);
	});

	it('does not regenerate a key that is present', async () => {
		const { stub, token } = await claimed();
		await inObject(stub, (site) => {
			install(site, { key: 'existing_key' });
			stubBridge(site, []);
		});
		const res = await call(stub, 'POST', token, body());
		expect(await res.json()).toMatchObject({ applied: true, keyCreated: false });
	});

	it('turns Strata on with enable, repeats without PHP, and audits enable=1', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const { stub, token } = await claimed();
		const calls: string[] = [];
		await inObject(stub, (site) => {
			install(site);
			stubBridge(site, calls);
		});
		const first = await call(stub, 'POST', token, body({ enable: true }));
		expect(await first.json()).toMatchObject({ applied: true, enabled: true });
		expect(await (await call(stub, 'GET', token)).json()).toMatchObject({ enabled: true });
		const again = await call(stub, 'POST', token, body({ enable: true }));
		expect(await again.json()).toMatchObject({
			applied: true,
			keyCreated: false,
			enabled: true
		});
		expect(calls).toHaveLength(1);
		const log = await auditRoutes(stub, token);
		const routes = (JSON.parse(log) as { entries: { route: string }[] }).entries.map(
			(e) => e.route
		);
		expect(routes).toEqual([
			'/strata-store?bucket=site-backups&accessKeyId=AKIAEX&enable=1',
			'/strata-store?bucket=site-backups&accessKeyId=AKIAEX&enable=1'
		]);
		expect(log).not.toContain(SECRET);
	});

	it('writes when the store matches but enable is asked and Strata is off', async () => {
		const { stub, token } = await claimed();
		const calls: string[] = [];
		await inObject(stub, (site) => {
			install(site);
			stubBridge(site, calls);
		});
		await call(stub, 'POST', token, body());
		const res = await call(stub, 'POST', token, body({ enable: true }));
		expect(await res.json()).toMatchObject({ applied: true, enabled: true });
		expect(calls).toHaveLength(2);
	});

	it.each([[undefined], [false]])(
		'leaves enabled untouched when enable is %s',
		async (enable) => {
			const { stub, token } = await claimed();
			await inObject(stub, (site) => {
				install(site, { enabled: true, key: 'existing_key' });
				stubBridge(site, []);
			});
			const res = await call(
				stub,
				'POST',
				token,
				body(enable === undefined ? {} : { enable })
			);
			expect(await res.json()).toMatchObject({ applied: true, enabled: true });
			expect(await (await call(stub, 'GET', token)).json()).toMatchObject({ enabled: true });
		}
	);

	it('sets enabled in the fragment only when enable is true', () => {
		const php = strataStorePhp(parseOk());
		expect(php).toContain("$want['enable'] === true");
		expect(php).toContain("set('enabled', true)");
		expect(php).not.toContain("set('enabled', false)");
	});

	it('drops the interpreter after a write', async () => {
		const { stub, token } = await claimed();
		await inObject(stub, (site) => {
			install(site);
			stubBridge(site, []);
			(site as Stubbed).php = { binary: { HEAPU8: new Uint8Array(16) } };
		});
		await call(stub, 'POST', token, body());
		expect(await inObject(stub, (site) => (site as Stubbed).php)).toBeUndefined();
	});

	it('answers applied and runs no PHP on a repeat of the same body', async () => {
		const { stub, token } = await claimed();
		const calls: string[] = [];
		await inObject(stub, (site) => {
			install(site);
			stubBridge(site, calls);
		});
		await call(stub, 'POST', token, body());
		const again = await call(stub, 'POST', token, body());
		expect(again.status).toBe(200);
		expect(await again.json()).toMatchObject({
			applied: true,
			keyCreated: false,
			previous: { provider: 's3', bucket: 'site-backups' }
		});
		expect(calls).toHaveLength(1);
	});

	it('answers 500 with no message when the write does not land, and keeps the row', async () => {
		const { stub, token } = await claimed();
		await inObject(stub, (site) => {
			install(site);
			stubBridge(site, [], { ok: false, class: 'RuntimeException', error: SECRET });
		});
		const res = await call(stub, 'POST', token, body());
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(JSON.parse(text)).toEqual({
			ok: false,
			error: 'strata_store_write_failed',
			phpClass: 'RuntimeException'
		});
		expect(text).not.toContain(SECRET);
		expect(await (await call(stub, 'GET', token)).json()).toMatchObject({ provider: 'local' });
	});

	it('answers 500 with no message when the interpreter throws the secret', async () => {
		const { stub, token } = await claimed();
		await inObject(stub, (site) => {
			install(site);
			(site as unknown as { runJson: () => Promise<never> }).runJson = async () => {
				throw new Error(`boom ${SECRET}`);
			};
		});
		const res = await call(stub, 'POST', token, body());
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(text).not.toContain(SECRET);
		expect(JSON.parse(text)).toEqual({ ok: false, error: 'strata_store_write_failed' });
	});

	it('refuses with 409 while a transaction is open and writes nothing', async () => {
		const { stub, token } = await claimed();
		const calls: string[] = [];
		await inObject(stub, (site) => {
			install(site);
			stubBridge(site, calls);
			(site as Stubbed).speculating = true;
		});
		const res = await call(stub, 'POST', token, body());
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ ok: false, error: 'a transaction is open' });
		expect(calls).toEqual([]);
		await inObject(stub, (site) => {
			(site as Stubbed).speculating = false;
		});
		expect(await (await call(stub, 'GET', token)).json()).toMatchObject({ provider: 'local' });
	});

	it('audits the route, the bucket and six characters of the key id, never the secret', async () => {
		const info = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { stub, token } = await claimed();
		await inObject(stub, (site) => {
			install(site);
			stubBridge(site, []);
		});
		await call(stub, 'GET', token);
		await call(stub, 'POST', token, body());
		const log = await auditRoutes(stub, token);
		const entries = (JSON.parse(log) as { entries: { route: string; method: string }[] })
			.entries;
		expect(entries.map((e) => [e.method, e.route])).toEqual([
			['POST', '/strata-store?bucket=site-backups&accessKeyId=AKIAEX']
		]);
		expect(log).not.toContain(SECRET);
		expect(log).not.toContain(KEY_ID);
		const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
		expect(logged).not.toContain(SECRET);
		expect(JSON.parse(log)).toMatchObject({ verified: true });
	});
});
