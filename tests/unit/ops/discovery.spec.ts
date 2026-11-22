import { describe, expect, it } from 'vitest';
import packageJson from '../../../package.json';
import {
	DISCOVERY_DOCUMENT_PATH,
	DISCOVERY_ROUTES,
	discoveryDocument,
	discoveryLimits,
	leverSchema,
	PACKAGE_SCHEMA
} from '../../../src/ops/discovery';
import { HEALTH_LEVELS } from '../../../src/ops/health-tree';
import {
	KV_OVERRIDABLE,
	LEVER_DOMAINS,
	OWNER_ONLY_LEVERS,
	type KvOverridable
} from '../../../src/ops/plan';
import { PACK_VERSION } from '../../../src/ops/reconcile';
import { routeTable } from '../../../src/site';

/**
 * The discovery document against the dashboard's contract.
 *
 * The expectations below are the contract's `discoveryDocumentSchema`, read from the dashboard's
 * `contracts/src/discovery.ts` and written out by hand here, since this repository does not import
 * from that one. The contract ships no vectors for this document, so these checks are the whole of
 * what is asserted against it.
 */

const SITE_KINDS = ['drupal', 'nuxtpress', 'smoke', 'mylora', 'custom'];
const PERMISSIONS = ['runtime', 'content', 'security', 'integrations', 'appearance', 'access'];
const PROVENANCES = ['default', 'var', 'kv', 'override'];
const WRITE_LAYERS = ['var', 'kv', 'override'];
const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ROUTE_CLASSES = ['safe', 'rebuild', 'stateful'];
const ROUTE_AUTHS = ['owner-token', 'management-key', 'assertion', 'session', 'none'];
const CAPABILITY_STATES = ['enabled', 'disabled', 'unavailable', 'degraded'];

type Json = Record<string, unknown>;

const levers = () =>
	KV_OVERRIDABLE.map((name) => ({
		name,
		value: name === 'RENDER_BUDGET_MS' ? '4321' : null,
		source: (name === 'RENDER_BUDGET_MS' ? 'kv' : 'default') as 'kv' | 'default',
		domain: LEVER_DOMAINS[name]
	}));

const build = (over: Partial<Parameters<typeof discoveryDocument>[0]> = {}) =>
	discoveryDocument({
		levers: levers(),
		etag: '"0123456789abcdef0123456789abcdef"',
		releaseId: 'a1b2c3d4-0000-4000-8000-000000000000',
		limits: discoveryLimits(104_857_600),
		writable: true,
		...over
	});

/** the contract's rules for one document; the first broken rule is the message */
function contractProblem(doc: Json): string | undefined {
	const expectKeys = (value: Json, keys: string[], what: string) => {
		const missing = keys.filter((k) => !(k in value));
		if (missing.length > 0) return `${what} lacks ${missing.join(', ')}`;
		return undefined;
	};
	const top = expectKeys(
		doc,
		[
			'v',
			'kind',
			'version',
			'releaseId',
			'schemaVersion',
			'capabilities',
			'settings',
			'routes',
			'redirects',
			'healthVocabulary',
			'limits'
		],
		'the document'
	);
	if (top) return top;
	if (doc['v'] !== 1) return 'v is not 1';
	if (!SITE_KINDS.includes(doc['kind'] as string)) return 'kind is not a site kind';
	const version = doc['version'];
	if (version !== null && (typeof version !== 'string' || version === '')) return 'bad version';
	if (typeof doc['releaseId'] !== 'string' || doc['releaseId'] === '') return 'bad releaseId';
	const schemaVersion = doc['schemaVersion'];
	if (
		schemaVersion !== null &&
		(!Number.isInteger(schemaVersion) || (schemaVersion as number) < 0)
	) {
		return 'schemaVersion is not null or a whole number of zero or more';
	}
	for (const c of doc['capabilities'] as Json[]) {
		if (typeof c['id'] !== 'string' || c['id'] === '') return 'bad capability id';
		if (!CAPABILITY_STATES.includes(c['state'] as string)) return 'bad capability state';
		if (c['reason'] !== null && typeof c['reason'] !== 'string') return 'bad capability reason';
	}
	const settings = doc['settings'] as Json;
	const settingsKeys = expectKeys(
		settings,
		['schema', 'values', 'provenance', 'writable', 'etag'],
		'settings'
	);
	if (settingsKeys) return settingsKeys;
	if (typeof settings['etag'] !== 'string' || settings['etag'] === '') return 'bad etag';
	for (const value of Object.values(settings['provenance'] as Json)) {
		if (!PROVENANCES.includes(value as string)) return 'bad provenance';
	}
	for (const value of Object.values(settings['writable'] as Json)) {
		if (!WRITE_LAYERS.includes(value as string)) return 'bad write layer';
	}
	for (const [name, property] of Object.entries(settings['schema'] as Record<string, Json>)) {
		const ui = property['x-ui'] as Json | undefined;
		if (ui === undefined) return `${name} has no x-ui`;
		if (typeof ui['group'] !== 'string' || ui['group'] === '') return `${name} has no group`;
		if (!PERMISSIONS.includes(ui['permission'] as string)) return `${name} has no permission`;
		for (const optional of ['widget', 'planGate'] as const) {
			const v = ui[optional];
			if (v !== undefined && (typeof v !== 'string' || v === ''))
				return `${name} ${optional}`;
		}
		if (ui['danger'] !== undefined && typeof ui['danger'] !== 'boolean')
			return `${name} danger`;
		if (ui['docLink'] !== undefined) {
			try {
				new URL(String(ui['docLink']));
			} catch {
				return `${name} docLink is not a URL`;
			}
		}
	}
	for (const r of doc['routes'] as Json[]) {
		if (typeof r['id'] !== 'string' || r['id'] === '') return 'bad route id';
		if (!ROUTE_METHODS.includes(r['method'] as string)) return `${r['id']} method`;
		if (typeof r['path'] !== 'string' || !r['path'].startsWith('/')) return `${r['id']} path`;
		if (!ROUTE_CLASSES.includes(r['class'] as string)) return `${r['id']} class`;
		if (!ROUTE_AUTHS.includes(r['auth'] as string)) return `${r['id']} auth`;
	}
	for (const r of doc['redirects'] as Json[]) {
		if (!String(r['from']).startsWith('/') || !String(r['to']).startsWith('/')) {
			return 'bad redirect';
		}
	}
	const vocabulary = doc['healthVocabulary'] as unknown[];
	if (!vocabulary.every((w) => typeof w === 'string' && w !== '')) return 'bad health word';
	for (const value of Object.values(doc['limits'] as Json)) {
		if (typeof value !== 'number' || !Number.isFinite(value)) return 'bad limit';
	}
	return undefined;
}

describe('the discovery document', () => {
	it('satisfies the dashboard contract', () => {
		expect(contractProblem(build() as unknown as Json)).toBeUndefined();
	});

	it('the checker rejects what the contract rejects', () => {
		const doc = () => build() as unknown as Json;
		expect(contractProblem({ ...doc(), v: 2 })).toBe('v is not 1');
		expect(contractProblem({ ...doc(), kind: 'wordpress' })).toBe('kind is not a site kind');
		expect(contractProblem({ ...doc(), releaseId: '' })).toBe('bad releaseId');
		expect(contractProblem({ ...doc(), schemaVersion: -1 })).toContain('schemaVersion');
		const routes = (doc()['routes'] as Json[]).map((r) => ({ ...r, class: 'destructive' }));
		expect(contractProblem({ ...doc(), routes })).toContain('class');
	});

	it('is served at the well-known path and holds one entry per overridable lever', () => {
		expect(DISCOVERY_DOCUMENT_PATH).toBe('/.well-known/drupflare');
		const settings = build().settings;
		const names = [...KV_OVERRIDABLE].sort();
		for (const part of [
			settings.schema,
			settings.values,
			settings.provenance,
			settings.writable
		]) {
			expect(Object.keys(part).sort()).toEqual(names);
		}
	});

	it('states kind drupal, no version, the release id it was given and an empty capability list', () => {
		const doc = build();
		expect(doc).toMatchObject({
			v: 1,
			kind: 'drupal',
			version: null,
			releaseId: 'a1b2c3d4-0000-4000-8000-000000000000',
			capabilities: [],
			redirects: []
		});
	});

	it('carries the tag it was given and the value and source of each lever', () => {
		const { settings } = build();
		expect(settings.etag).toBe('"0123456789abcdef0123456789abcdef"');
		expect(settings.values['RENDER_BUDGET_MS']).toBe(4321);
		expect(settings.provenance['RENDER_BUDGET_MS']).toBe('kv');
		expect(settings.values['FILL_BATCH_SIZE']).toBeNull();
		expect(settings.provenance['FILL_BATCH_SIZE']).toBe('default');
	});

	it('writes a flag, an enum and a text lever as strings, and an int lever as a number', () => {
		const flag = levers().map((l) => (l.name === 'SPOOL' ? { ...l, value: '1' } : l));
		const enumLever = flag.map((l) => (l.name === 'CSP_MODE' ? { ...l, value: 'enforce' } : l));
		const { values } = build({ levers: enumLever }).settings;
		expect(values['SPOOL']).toBe('1');
		expect(values['CSP_MODE']).toBe('enforce');
		expect(typeof values['RENDER_BUDGET_MS']).toBe('number');
	});

	it('lists a lever as writable only when the site can store an override', () => {
		expect(Object.keys(build({ writable: false }).settings.writable)).toEqual([]);
		expect(new Set(Object.values(build().settings.writable))).toEqual(new Set(['kv']));
	});

	it('names the platform version id it was given, never a default of its own', () => {
		expect(build({ releaseId: 'unknown' }).releaseId).toBe('unknown');
	});

	it('reports the health words the health tree uses', () => {
		expect(build().healthVocabulary).toEqual([...HEALTH_LEVELS]);
		expect(HEALTH_LEVELS).toEqual(['ok', 'info', 'warn', 'error', 'critical']);
	});

	it('reports the limits it is given, as numbers', () => {
		expect(Object.keys(build().limits).sort()).toEqual([
			'edgePlanBytes',
			'edgePlanEntries',
			'fillQueueMax',
			'maxUploadBytes'
		]);
		expect(build({ limits: discoveryLimits(0) }).limits['maxUploadBytes']).toBe(0);
	});
});

describe('the lever schemas', () => {
	const schemaOf = (name: KvOverridable) =>
		leverSchema(name, LEVER_DOMAINS[name]) as Json & { 'x-ui': Json };

	it('puts an owner-only lever in security and every other lever in runtime', () => {
		for (const name of KV_OVERRIDABLE) {
			const ui = schemaOf(name)['x-ui'];
			const expected = OWNER_ONLY_LEVERS.has(name) ? 'security' : 'runtime';
			expect(ui['permission'], name).toBe(expected);
			expect(ui['group'], name).toBe(expected);
		}
		expect(OWNER_ONLY_LEVERS.size).toBeGreaterThan(0);
	});

	it('takes the widget from the lever type: a marked int is a slider and rules are json', () => {
		expect(schemaOf('WARM_INTERVAL_MS')['x-ui']['widget']).toBe('lever-slider');
		expect(schemaOf('REDIRECTS')['x-ui']['widget']).toBe('json');
		expect(schemaOf('RESPONSE_HEADERS')['x-ui']['widget']).toBe('json');
		expect(schemaOf('KEEP_WARM_MS')['x-ui']['widget']).toBeUndefined();
		expect(schemaOf('SPOOL')['x-ui']['widget']).toBeUndefined();
	});

	it('marks the one lever whose wrong value blocks pages as dangerous, and no other', () => {
		const dangerous = KV_OVERRIDABLE.filter((n) => schemaOf(n)['x-ui']['danger'] === true);
		expect(dangerous).toEqual(['CSP_MODE']);
	});

	it('writes each domain as the JSON Schema the dashboard reads', () => {
		expect(schemaOf('RENDER_BUDGET_MS')).toMatchObject({
			type: 'integer',
			minimum: 0,
			maximum: 60_000,
			'x-unit': 'ms'
		});
		expect(schemaOf('SPOOL')).toMatchObject({ type: 'string', enum: ['0', '1'] });
		expect(schemaOf('MAIL_TRANSPORT')).toMatchObject({
			type: 'string',
			enum: ['auto', 'binding', 'api', 'smtp', 'off']
		});
		expect(schemaOf('WARM_WINDOW')).toMatchObject({ type: 'string' });
		expect(schemaOf('SPOOL_EXCLUDE')).toMatchObject({ type: 'string' });
		expect(schemaOf('WARM_INTERVAL_MS')['x-marks']).toHaveLength(3);
		expect(schemaOf('WARM_INTERVAL_MS')).toMatchObject({ default: 8_000 });
	});

	it('states no plan gate, because no lever in the worker names one', () => {
		for (const name of KV_OVERRIDABLE) {
			expect(schemaOf(name)['x-ui']['planGate'], name).toBeUndefined();
		}
	});
});

describe('the routes the document lists', () => {
	const owner = () => routeTable().owner;

	it('are owner routes, each by an id of its own and one method per path', () => {
		const ids = DISCOVERY_ROUTES.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
		const keys = DISCOVERY_ROUTES.map((r) => `${r.method} ${r.path}`);
		expect(new Set(keys).size).toBe(keys.length);
		for (const r of DISCOVERY_ROUTES) {
			expect(owner().has(r.path), `${r.path} is not an owner route`).toBe(true);
			expect(r.auth).toBe('owner-token');
		}
	});

	it('list the document itself, the settings and the extension list as reads', () => {
		const read = (path: string) =>
			DISCOVERY_ROUTES.find((r) => r.path === path && r.method === 'GET');
		for (const path of ['/.well-known/drupflare', '/settings', '/extensions', '/health']) {
			expect(read(path)?.class, path).toBe('safe');
		}
	});

	it('put every write in a class other than safe, except the read-only console and the ledger trim', () => {
		const safeWrites = DISCOVERY_ROUTES.filter((r) => r.method !== 'GET' && r.class === 'safe');
		expect(safeWrites.map((r) => r.path).sort()).toEqual(['/db-console', '/ledger-gc']);
	});

	it('name the interpreter drop as a rebuild and the settings write as stateful', () => {
		const find = (id: string) => DISCOVERY_ROUTES.find((r) => r.id === id);
		expect(find('recycle.run')?.class).toBe('rebuild');
		expect(find('settings.write')?.class).toBe('stateful');
		expect(find('uninstall.run')?.class).toBe('stateful');
	});
});

describe('the data schema the release declares', () => {
	it('is two whole numbers in package.json, the oldest accepted at or below the current', () => {
		const declared = (
			packageJson as unknown as { schema: { version: number; accepts: number } }
		).schema;
		expect(Number.isInteger(declared.version) && declared.version >= 0).toBe(true);
		expect(Number.isInteger(declared.accepts) && declared.accepts >= 0).toBe(true);
		expect(declared.accepts).toBeLessThanOrEqual(declared.version);
		expect(PACKAGE_SCHEMA).toEqual(declared);
	});

	it('equals the pack version the reconcile steps end on, so a new step forces a decision', () => {
		expect(PACKAGE_SCHEMA.version).toBe(PACK_VERSION);
	});

	it('is what the document reports as schemaVersion', () => {
		expect(build().schemaVersion).toBe(PACKAGE_SCHEMA.version);
	});
});
