import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');
const config = JSON.parse(readFileSync(resolve(ROOT, 'wrangler.jsonc'), 'utf8')) as Record<
	string,
	unknown
>;

// r2_buckets (2026-09-11, code 10042) and worker_loaders (2026-11-01, code 10195) are measured
// to refuse a free deploy; the rest are unmeasured
const ACCOUNT_BOUND = [
	'r2_buckets',
	'worker_loaders',
	'services',
	'dispatch_namespaces',
	'queues',
	'workflows',
	'vectorize',
	'hyperdrive',
	'ai',
	'browser',
	'analytics_engine_datasets',
	'pipelines',
	'send_email',
	'mtls_certificates',
	'secrets_store_secrets',
	'containers'
];

const managed = JSON.parse(readFileSync(resolve(ROOT, 'wrangler.managed.jsonc'), 'utf8')) as Record<
	string,
	unknown
>;

const MANAGED_ONLY = ['r2_buckets', 'send_email'];
const MANAGED_VARS = ['CACHE_API', 'FILE_STORE'];

describe('the managed config is the canonical one plus the managed-only bindings', () => {
	it('adds exactly the managed-only keys', () => {
		expect(Object.keys(managed).filter((k) => !(k in config))).toEqual(MANAGED_ONLY);
	});

	it('is the canonical config in every other key', () => {
		const rest = Object.fromEntries(
			Object.entries(managed).filter(([k]) => !MANAGED_ONLY.includes(k))
		);
		const vars = Object.fromEntries(
			Object.entries(rest.vars as Record<string, string>).filter(
				([k]) => !MANAGED_VARS.includes(k)
			)
		);
		expect({ ...rest, vars }).toEqual(config);
	});

	it('sets the managed-only vars the platform needs', () => {
		expect((managed.vars as Record<string, string>).CACHE_API).toBe('off');
		expect((config.vars as Record<string, string>).CACHE_API).toBeUndefined();
	});

	it('binds the file buckets and the mail transport the code reads', () => {
		expect(managed.r2_buckets).toEqual([
			{ binding: 'FILES', bucket_name: 'drupflare-files' },
			{ binding: 'FILES_PRIVATE', bucket_name: 'drupflare-files-private' }
		]);
		expect(managed.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
	});

	it('makes R2 the file store only on the managed config', () => {
		expect((managed.vars as Record<string, string>).FILE_STORE).toBe('r2');
		expect((config.vars as Record<string, string>).FILE_STORE).toBeUndefined();
	});

	it('gives the private bucket no public origin', () => {
		expect((managed.vars as Record<string, string>).FILES_PUBLIC_URL).toBeUndefined();
	});
});

describe('the canonical config keeps the one-click deploy working', () => {
	it('declares none of the bindings that need an account resource it cannot create', () => {
		expect(Object.keys(config).filter((k) => ACCOUNT_BOUND.includes(k))).toEqual([]);
	});

	it('names KV and D1 without ids, so wrangler provisions them on the first deploy', () => {
		for (const ns of config.kv_namespaces as Record<string, unknown>[])
			expect(ns, String(ns.binding)).not.toHaveProperty('id');
		for (const db of config.d1_databases as Record<string, unknown>[])
			expect(db, String(db.binding)).not.toHaveProperty('database_id');
	});
});
