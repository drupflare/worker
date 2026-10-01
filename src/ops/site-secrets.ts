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

/** a secret store; the Durable Object satisfies this with `metaGet`/`metaSet` */
export type SecretStore = {
	get(key: string): string | null;
	set(key: string, value: string): void;
};

/** `cfw_meta` key holding this site's hash salt */
export const HASH_SALT_KEY = 'hash_salt';

/** `cfw_meta` key holding this site's owner token */
export const OWNER_TOKEN_KEY = 'owner_token';

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
 * Reads this site's owner token, minting it like {@link ensureHashSalt}. A separate credential
 * because `PW_DIAGNOSTICS` also opens `/sql`, `/restore` and `/php`.
 */
export function ensureOwnerToken(store: SecretStore, mint: () => string = randomKeyBase64): string {
	const existing = store.get(OWNER_TOKEN_KEY);
	if (existing !== null && existing !== '') return existing;
	const token = mint();
	assertSalt(token);
	store.set(OWNER_TOKEN_KEY, token);
	return token;
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
