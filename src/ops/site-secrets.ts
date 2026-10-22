/**
 * Per-site secrets, minted in the Durable Object and never in the shipped payload.
 *
 * Assets are public and identical on every site, so a secret in `assets/` is everyone's. Only the
 * hash salt needs minting here: Drupal regenerates the private key itself, while
 * `Settings::getHashSalt()` throws on an empty salt and only the installer (which never runs here)
 * makes one. The salt signs login links and form tokens.
 *
 * @module
 */

import { sha256Hex } from './owner-recovery';

/**
 * Durable Object key-value storage, which the SQL bridge cannot reach: the platform reserves the
 * `_cf_` tables behind it, so `cfwSqlExec` is refused on both reads and writes.
 */
export type SealedStore = {
	get(key: string): string | undefined;
	put(key: string, value: string): void;
	delete(key: string): void;
	/** every entry whose key starts with `prefix`, as [key, value] */
	list(prefix: string): [string, string][];
};

/**
 * A secret store; the Durable Object satisfies this with `metaGet`/`metaSet` (rows any SQL can
 * read and write) and its key-value storage (`sealed`).
 */
export type SecretStore = {
	get(key: string): string | null;
	set(key: string, value: string): void;
	delete(key: string): void;
	sealed: SealedStore;
};

/** `cfw_meta` key holding this site's hash salt */
export const HASH_SALT_KEY = 'hash_salt';

/** the legacy `cfw_meta` key that held the owner token in plaintext; read only to migrate it */
export const OWNER_TOKEN_KEY = 'owner_token';

/** sealed key holding the SHA-256 of the owner token */
export const OWNER_HASH_KEY = 'owner_token_sha256';

/**
 * Bytes of entropy behind a salt; Drupal's installer calls `Crypt::randomBytesBase64(55)`, which
 * encodes to 74 characters.
 */
export const SALT_BYTES = 55;

/** base64url, the alphabet Drupal's `Crypt::randomBytesBase64()` produces */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** mints a secret in Drupal's encoding from `crypto.getRandomValues` (it signs reset links) */
export function randomKeyBase64(bytes: number = SALT_BYTES): string {
	const raw = new Uint8Array(bytes);
	crypto.getRandomValues(raw);
	let binary = '';
	for (const byte of raw) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Reads this site's hash salt, minting and persisting one the first time (persisted so a
 * remount keeps sessions and login links valid).
 *
 * @param mint - injected so a test can assert the stored value rather than that one exists
 */
export function ensureHashSalt(store: SecretStore, mint: () => string = randomKeyBase64): string {
	const existing = store.get(HASH_SALT_KEY);
	if (existing !== null && existing !== '') return existing;
	const salt = mint();
	assertSalt(salt);
	store.set(HASH_SALT_KEY, salt);
	return salt;
}

/**
 * Refuses a salt that could break out of the PHP string literal it becomes; a stored value comes
 * back from the database, so it is checked before it reaches settings.php.
 */
export function assertSalt(salt: string): void {
	if (!BASE64URL.test(salt)) {
		throw new Error('hash salt is not base64url; refusing to write it into settings.php');
	}
}

/**
 * The settings.php line that points a site at its own salt. Appended after the shipped
 * assignment, so it wins over any salt the pack still carries.
 */
export function hashSaltAssignment(salt: string): string {
	assertSalt(salt);
	return `$settings['hash_salt'] = '${salt}';\n`;
}

/**
 * The PHP-serialized form of a `key_value` state value; exported for the test that pins a minted
 * key to the shape of the row Drupal reads.
 */
export function stateSerialized(value: string): string {
	return `s:${value.length}:"${value}";`;
}

/**
 * Moves a legacy plaintext owner token out of `cfw_meta`, which any SQL on the object can read and
 * write, into the sealed store as its hash. Idempotent.
 *
 * A sealed hash always wins: once one exists, an `owner_token` row is deleted without being read,
 * so SQL cannot swap in a token it knows. Before the first adoption a row is the only record of
 * the token, so it is trusted as it stands.
 */
export async function adoptLegacyOwnerToken(store: SecretStore): Promise<void> {
	const legacy = store.get(OWNER_TOKEN_KEY);
	if (legacy === null) return;
	if (legacy !== '' && store.sealed.get(OWNER_HASH_KEY) === undefined) {
		const hash = await sha256Hex(legacy);
		// re-checked after the await, in the same synchronous run as the write
		if (store.sealed.get(OWNER_HASH_KEY) === undefined) store.sealed.put(OWNER_HASH_KEY, hash);
	}
	store.delete(OWNER_TOKEN_KEY);
}

/** whether this site has an owner token (a claim happened), adopting a legacy row first */
export async function ownerTokenIsSet(store: SecretStore): Promise<boolean> {
	await adoptLegacyOwnerToken(store);
	return (store.sealed.get(OWNER_HASH_KEY) ?? '') !== '';
}

/**
 * Whether a presented token is this site's owner token. Only the hash is stored, so the presented
 * value is hashed and the two digests are compared in constant time.
 */
export async function ownerTokenMatches(
	store: SecretStore,
	presented: string | null | undefined
): Promise<boolean> {
	await adoptLegacyOwnerToken(store);
	const stored = store.sealed.get(OWNER_HASH_KEY);
	if (!stored || !presented) return false;
	return tokenMatches(await sha256Hex(presented), stored);
}

/**
 * Mints the owner token for a site that has none, stores its hash and returns the plaintext, which
 * the caller shows once. Returns undefined when a token already exists: a repeat claim must not
 * hand out a credential it no longer holds. A separate credential from `PW_DIAGNOSTICS`, which
 * also opens `/sql`, `/restore` and `/php`.
 */
export async function mintOwnerToken(
	store: SecretStore,
	mint: () => string = randomKeyBase64
): Promise<string | undefined> {
	if (await ownerTokenIsSet(store)) return undefined;
	return rotateOwnerToken(store, mint);
}

/** replaces the owner token with a new one; the previous token stops working at once */
export async function rotateOwnerToken(
	store: SecretStore,
	mint: () => string = randomKeyBase64
): Promise<string> {
	const token = mint();
	assertSalt(token);
	store.sealed.put(OWNER_HASH_KEY, await sha256Hex(token));
	store.delete(OWNER_TOKEN_KEY);
	return token;
}

/**
 * Reads a credential from the sealed store. A legacy `cfw_meta` row is moved over on first read;
 * once the sealed store holds a value (or an empty marker) a row is deleted unread.
 */
export function readSealed(store: SecretStore, key: string): string | null {
	const sealed = store.sealed.get(key);
	const legacy = store.get(key);
	if (sealed !== undefined) {
		if (legacy !== null) store.delete(key);
		return sealed;
	}
	if (legacy === null) return null;
	store.sealed.put(key, legacy);
	store.delete(key);
	return legacy;
}

/**
 * Writes a credential to the sealed store and removes any `cfw_meta` row for it. An empty value is
 * kept as a marker, so a cleared credential cannot be re-adopted from a row SQL plants later.
 */
export function writeSealed(store: SecretStore, key: string, value: string): void {
	store.sealed.put(key, value);
	if (store.get(key) !== null) store.delete(key);
}

/** the `cfw_meta` key a dump carries the owner hash under, so an import can adopt it */
export const OWNER_HASH_EXPORT_KEY = 'owner_token_hash';

/** sealed keys a dump with `secrets=1` carries, and the prefixes of the ones keyed by remote id */
const EXPORTED_SEALED_KEYS = ['cf_oauth_token'];
const EXPORTED_SEALED_PREFIXES = ['git_token_', 'git_hooksecret_'];

/** SHA-256 as `sha256Hex()` writes it */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The sealed credentials a dump with `secrets=1` carries, as `cfw_meta` rows. They are the format
 * an older dump already used, so a dump restores on any version, and an importing object moves
 * them back into sealed storage with {@link adoptLegacySecrets} before they sit in SQL for long.
 */
export function sealedExportRows(store: SecretStore): [string, string][] {
	const rows: [string, string][] = [];
	const hash = store.sealed.get(OWNER_HASH_KEY);
	if (hash) rows.push([OWNER_HASH_EXPORT_KEY, hash]);
	for (const key of EXPORTED_SEALED_KEYS) {
		const value = store.sealed.get(key);
		if (value) rows.push([key, value]);
	}
	for (const prefix of EXPORTED_SEALED_PREFIXES) {
		for (const [key, value] of store.sealed.list(prefix)) if (value) rows.push([key, value]);
	}
	return rows;
}

/**
 * Moves credentials that reached `cfw_meta` (an import, or a site from before sealed storage) into
 * sealed storage. A sealed value always wins, so restoring a dump over a claimed site keeps that
 * site's owner and credentials and deletes the incoming rows unread.
 *
 * @param keys - the `cfw_meta` keys currently holding a credential
 */
export function adoptLegacySecrets(store: SecretStore, keys: readonly string[]): void {
	for (const key of keys) {
		if (key !== OWNER_HASH_EXPORT_KEY) {
			readSealed(store, key);
			continue;
		}
		const incoming = store.get(key);
		if (
			incoming !== null &&
			SHA256_HEX.test(incoming) &&
			store.sealed.get(OWNER_HASH_KEY) === undefined
		) {
			store.sealed.put(OWNER_HASH_KEY, incoming);
		}
		store.delete(key);
	}
}

/**
 * Compares a presented token against the stored one in constant time; the lengths fold into the
 * accumulator so a wrong-length guess costs the same as a wrong value.
 */
export function tokenMatches(presented: string | null | undefined, stored: string | null): boolean {
	if (!stored) return false;
	const a = presented ?? '';
	let diff = a.length ^ stored.length;
	const width = Math.max(a.length, stored.length);
	for (let i = 0; i < width; i++) {
		// past the end charCodeAt is NaN and `NaN | 0` is 0, so a short guess costs a full pass
		diff |= (a.charCodeAt(i) | 0) ^ (stored.charCodeAt(i) | 0);
	}
	return diff === 0;
}

/**
 * A usable point-in-time recovery bookmark, checked by value: a back end with no change log
 * answers all zeros instead of throwing.
 */
export function isBookmark(value: string | null | undefined): boolean {
	if (typeof value !== 'string') return false;
	return /^[0-9a-f-]{16,}$/i.test(value) && /[1-9a-f]/i.test(value);
}

/** the bearer token out of the `Authorization` value an owner request carries */
export function bearerToken(header: string | null): string | undefined {
	if (!header) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match?.[1]?.trim();
}
