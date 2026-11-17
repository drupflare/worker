import {
	SEALED_META_KEYS,
	adoptLegacyOwnerToken,
	adoptLegacySecrets,
	readSealed,
	writeSealed,
	type SecretStore
} from '../ops/site-secrets';
import type { SecretsHost } from './host';
import type { Row } from './types';

/**
 * The meta table as a {@link SecretStore}, so the mint needs no Durable Object to test, with
 * `sealed` on key-value storage: the SQL bridge cannot read or write it.
 */
export function secretStore(host: SecretsHost): SecretStore {
	const kv = host.storage.kv;
	return {
		get: (key: string) => host.metaRowGet(key),
		set: (key: string, value: string) => host.metaRowSet(key, value),
		delete: (key: string) => {
			host.ensureServeTables();
			host.sql.exec('DELETE FROM cfw_meta WHERE k = ?', key);
		},
		sealed: {
			get: (key: string) => kv.get<string>(key),
			put: (key: string, value: string) => kv.put(key, value),
			delete: (key: string) => void kv.delete(key),
			list: (prefix: string) =>
				[...kv.list<string>({ prefix })].map(
					([key, value]) => [key, value] as [string, string]
				)
		}
	};
}

/** reads a credential from sealed storage, moving a legacy `cfw_meta` row over on first read */
export function readSecret(host: SecretsHost, key: string): string | null {
	return readSealed(secretStore(host), key);
}

/** stores a credential in sealed storage, where the SQL bridge cannot read or write it */
export function writeSecret(host: SecretsHost, key: string, value: string): void {
	writeSealed(secretStore(host), key, value);
}

/** moves credentials found in `cfw_meta` into the sealed store before any request is served */
export function adoptOwnerToken(host: SecretsHost): Promise<void> {
	return host.ctx.blockConcurrencyWhile(() => adoptSecrets(host));
}

/**
 * Moves every credential that sits in `cfw_meta` (a site from before sealed storage, or an
 * import that carried them) into sealed storage. Runs on wake and at the head of each alarm,
 * which is where an import is applied, so a credential is in SQL for one firing at most.
 */
export async function adoptSecrets(host: SecretsHost): Promise<void> {
	try {
		if (!hasMetaTable(host)) return;
		const store = secretStore(host);
		await adoptLegacyOwnerToken(store);
		const moved = [...SEALED_META_KEYS];
		const keys = host.sql
			.exec<Row<{ k: string }>>(
				`SELECT k FROM cfw_meta WHERE k IN ('owner_token_hash', 'cf_oauth_token',
					${moved.map(() => '?').join(', ')})
					OR substr(k, 1, 10) = 'git_token_' OR substr(k, 1, 15) = 'git_hooksecret_'`,
				...moved
			)
			.toArray()
			.map((row) => row.k);
		if (keys.length > 0) adoptLegacySecrets(store, keys);
	} catch {
		// a failed adoption retries on the next wake, alarm or credential read
	}
}

/** whether `cfw_meta` exists, read without creating it (an unprovisioned object has none) */
function hasMetaTable(host: SecretsHost): boolean {
	return (
		host.sql
			.exec<Row<{ name: string }>>(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cfw_meta'`
			)
			.toArray().length > 0
	);
}
