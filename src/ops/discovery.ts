import { schema as packageSchema } from '../../package.json';
import { FILL_QUEUE_MAX } from '../do/limits';
import { EDGE_PLAN_BYTES, EDGE_PLAN_ENTRIES } from './edge-plan';
import { HEALTH_LEVELS } from './health-tree';
import { type LeverDomain, OWNER_ONLY_LEVERS } from './plan';

/** the path the discovery document is served at */
export const DISCOVERY_DOCUMENT_PATH = '/.well-known/drupflare';

/** the discovery format's major version, which the document carries as `v` */
export const DISCOVERY_VERSION = 1;

/** the data schema this build leaves a site at, and the oldest one it accepts */
export const PACKAGE_SCHEMA = packageSchema as { version: number; accepts: number };

/** `safe` changes nothing a visitor sees, `rebuild` drops derived state, `stateful` changes it */
export type RouteClass = 'safe' | 'rebuild' | 'stateful';

/** one callable route as the document lists it */
export type DiscoveryRoute = {
	id: string;
	method: 'GET' | 'POST' | 'PUT';
	path: string;
	class: RouteClass;
	auth: 'owner-token';
};

const route = (
	id: string,
	method: DiscoveryRoute['method'],
	path: string,
	cls: RouteClass
): DiscoveryRoute => ({ id, method, path, class: cls, auth: 'owner-token' });

/**
 * The owner routes the document lists: each method and path whose behaviour the operations page
 * states. A route whose methods are not stated there is left out rather than guessed.
 */
export const DISCOVERY_ROUTES: readonly DiscoveryRoute[] = [
	route('discovery.read', 'GET', DISCOVERY_DOCUMENT_PATH, 'safe'),
	route('settings.read', 'GET', '/settings', 'safe'),
	route('settings.write', 'PUT', '/settings', 'stateful'),
	route('health.read', 'GET', '/health', 'safe'),
	route('deployment.read', 'GET', '/deployment', 'safe'),
	route('deployment.write', 'PUT', '/deployment', 'stateful'),
	route('serve-stats.read', 'GET', '/serve-stats', 'safe'),
	route('extensions.read', 'GET', '/extensions', 'safe'),
	route('updb.read', 'GET', '/updb', 'safe'),
	route('updb.beat', 'POST', '/updb', 'stateful'),
	route('recycle.run', 'POST', '/recycle', 'rebuild'),
	route('ledger-gc.run', 'POST', '/ledger-gc', 'safe'),
	route('strata-config.read', 'GET', '/strata-config', 'safe'),
	route('strata-config.write', 'POST', '/strata-config', 'stateful'),
	route('strata-store.read', 'GET', '/strata-store', 'safe'),
	route('strata-store.write', 'POST', '/strata-store', 'stateful'),
	route('uninstall.run', 'POST', '/uninstall', 'stateful'),
	route('theme-default.read', 'GET', '/theme-default', 'safe'),
	route('theme-default.write', 'POST', '/theme-default', 'stateful'),
	route('rotate-token.run', 'POST', '/rotate-token', 'stateful'),
	route('admin-password.reset', 'POST', '/admin-password', 'stateful'),
	route('db-console.query', 'POST', '/db-console', 'safe'),
	route('file.put', 'PUT', '/file', 'stateful'),
	route('writemark.read', 'GET', '/writemark', 'safe'),
	route('writechanges.read', 'GET', '/writechanges', 'safe')
];

/** a lever as `GET /settings` reports it */
export type DiscoveryLever = {
	name: string;
	value: string | null;
	source: 'kv' | 'var' | 'default';
	domain: LeverDomain;
};

/** what the document is built from; every field is read by the caller, none is looked up here */
export type DiscoveryInput = {
	levers: readonly DiscoveryLever[];
	/** the tag `GET /settings` sent, so a write can name the document it read */
	etag: string;
	/** the platform's version id for this deployment, or `unknown` */
	releaseId: string;
	limits: Record<string, number>;
	/** whether the site can store an override; without a writable KV binding no lever is */
	writable: boolean;
};

/** the group of settings a lever belongs to; only the permission a lever needs is stated here */
function permissionOf(name: string): 'security' | 'runtime' {
	return OWNER_ONLY_LEVERS.has(name) ? 'security' : 'runtime';
}

/** hints the lever's own type does not decide */
const DANGEROUS_LEVERS: ReadonlySet<string> = new Set(['CSP_MODE']);

/** the JSON Schema of one lever's value, with the `x-ui` hints the dashboard reads */
export function leverSchema(name: string, domain: LeverDomain): Record<string, unknown> {
	const widget =
		domain.kind === 'int' && domain.marks !== undefined
			? 'lever-slider'
			: domain.kind === 'rules'
				? 'json'
				: undefined;
	const permission = permissionOf(name);
	const typed: Record<string, unknown> = (() => {
		switch (domain.kind) {
			case 'int':
				return {
					type: 'integer',
					minimum: domain.min,
					maximum: domain.max,
					...(domain.default === undefined ? {} : { default: domain.default }),
					...(domain.unit === undefined ? {} : { 'x-unit': domain.unit }),
					...(domain.marks === undefined ? {} : { 'x-marks': domain.marks })
				};
			case 'flag':
				return { type: 'string', enum: ['0', '1'] };
			case 'enum':
				return { type: 'string', enum: [...domain.values] };
			default:
				return { type: 'string' };
		}
	})();
	return {
		...typed,
		title: name,
		'x-ui': {
			group: permission,
			permission,
			...(widget === undefined ? {} : { widget }),
			...(DANGEROUS_LEVERS.has(name) ? { danger: true } : {})
		}
	};
}

/** an int lever arrives as text; the document carries the number */
function valueOf(lever: DiscoveryLever): string | number | null {
	if (lever.domain.kind === 'int' && lever.value !== null && /^-?\d+$/.test(lever.value.trim())) {
		return Number(lever.value);
	}
	return lever.value;
}

/** the limits this site reports, which the caller reads from the same constants the guards use */
export function discoveryLimits(uploadBytes: number): Record<string, number> {
	return {
		fillQueueMax: FILL_QUEUE_MAX,
		edgePlanEntries: EDGE_PLAN_ENTRIES,
		edgePlanBytes: EDGE_PLAN_BYTES,
		maxUploadBytes: uploadBytes
	};
}

/**
 * The discovery document. Capabilities and redirects are empty because the worker holds neither
 * list; `version` is null because a release is registered by the dashboard, not by the build.
 */
export function discoveryDocument(input: DiscoveryInput) {
	const schema: Record<string, unknown> = {};
	const values: Record<string, unknown> = {};
	const provenance: Record<string, DiscoveryLever['source']> = {};
	const writable: Record<string, 'kv'> = {};
	for (const lever of input.levers) {
		schema[lever.name] = leverSchema(lever.name, lever.domain);
		values[lever.name] = valueOf(lever);
		provenance[lever.name] = lever.source;
		if (input.writable) writable[lever.name] = 'kv';
	}
	return {
		v: DISCOVERY_VERSION,
		kind: 'drupal' as const,
		version: null,
		releaseId: input.releaseId,
		schemaVersion: PACKAGE_SCHEMA.version,
		capabilities: [] as { id: string; state: string; reason: string | null }[],
		settings: { schema, values, provenance, writable, etag: input.etag },
		routes: DISCOVERY_ROUTES.map((r) => ({ ...r })),
		redirects: [] as { from: string; to: string }[],
		healthVocabulary: [...HEALTH_LEVELS] as string[],
		limits: input.limits
	};
}
