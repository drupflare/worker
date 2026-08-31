/**
 * Per-site secrets, minted in the Durable Object and never in the shipped payload.
 *
 * Workers assets are served PUBLICLY, and `.assetsignore` un-ignores the packs, so anything
 * secret that ships in `assets/` is fetchable at a guessable URL by anyone -- and identical on
 * every site deployed from that payload. Three secrets were in there:
 *
 * | secret               | where it shipped              | fix                                  |
 * | -------------------- | ----------------------------- | ------------------------------------ |
 * | `hash_salt`          | `drupal-pf/core.pf.bin`       | minted here, appended to settings.php |
 * | `system.private_key` | `drupal-sql/0052.json`        | removed; Drupal regenerates it        |
 * | admin bcrypt hash    | `drupal-sql/0064.json`        | blanked; `/firstrun` sets a real one  |
 *
 * Only the salt needs this module. Drupal already self-heals the private key --
 * `PrivateKey::get()` calls `create()` and `set()` when state has none -- and a password has to
 * come from the operator. A salt has no such mechanism: `Settings::getHashSalt()` throws when it
 * is empty and nothing generates one outside the installer, which never runs here.
 *
 * The salt is what signs one-time login links, form tokens and `Crypt::hmacBase64`, so sharing it
 * across sites lets anyone holding the payload mint a valid password-reset URL for any of them.
 *
 * @see src/site-do.ts, which appends {@link hashSaltAssignment} to settings.php at boot
 * @see scripts/scrub-pack-secrets.ts, which removes the shipped salt from the pack
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
 * Bytes of entropy behind a salt, matching `Crypt::randomBytesBase64(55)`.
 *
 * 55 bytes is what Drupal's own installer uses, and it encodes to the 74 characters the shipped
 * `system.private_key` row carried -- so a value minted here is indistinguishable in form from one
 * Drupal would have made itself.
 */
export const SALT_BYTES = 55;

/** base64url, the alphabet Drupal's `Crypt::randomBytesBase64()` produces */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Mints a secret in Drupal's own encoding.
 *
 * `crypto.getRandomValues` rather than `Math.random()`: this is the value that signs password-reset
 * links, so a predictable one is the same defect as a shared one.
 */
export function randomKeyBase64(bytes: number = SALT_BYTES): string {
	const raw = new Uint8Array(bytes);
	crypto.getRandomValues(raw);
	let binary = '';
	for (const byte of raw) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Reads this site's hash salt, minting and persisting one the first time.
 *
 * Idempotent by construction: a second call returns the stored value, so a remount keeps every
 * session and every unexpired one-time login link valid. That is the whole reason it is persisted
 * rather than derived per boot.
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
 * Refuses a salt that could break out of the PHP string literal it is about to become.
 *
 * {@link hashSaltAssignment} builds source code, so an unchecked value is an injection into
 * settings.php. The mint only ever produces base64url, which makes this cheap -- but a stored value
 * arrives from the database, and "it can only be what we wrote" is exactly the assumption worth
 * refusing to make about a file that gets executed.
 */
export function assertSalt(salt: string): void {
	if (!BASE64URL.test(salt)) {
		throw new Error('hash salt is not base64url; refusing to write it into settings.php');
	}
}

/**
 * The settings.php line that points a site at its own salt.
 *
 * Appended AFTER the shipped assignment, and a later assignment wins, so this overrides whatever
 * the pack carried even on a pack that still carries one.
 */
export function hashSaltAssignment(salt: string): string {
	assertSalt(salt);
	return `$settings['hash_salt'] = '${salt}';\n`;
}

/**
 * The PHP-serialized form of a `key_value` state value.
 *
 * Exported for the test that proves a minted key is byte-shaped like the row that used to ship,
 * so removing that row cannot be mistaken for changing the format Drupal reads.
 */
export function stateSerialized(value: string): string {
	return `s:${value.length}:"${value}";`;
}

/**
 * Reads this site's owner token, minting one the first time.
 *
 * WHY A SECOND SECRET RATHER THAN REUSING `PW_DIAGNOSTICS`. Getting your data out required
 * `PW_DIAGNOSTICS=1`, and that flag is one boolean over a set that also contains `/sql` (arbitrary
 * SQL against the site database), `/restore` (a whole-database overwrite) and `/php`. So the
 * supported way to leave was to expose a remote shell to the internet first. Export is an OWNER
 * operation, not a diagnostic, and it needs a credential rather than a mode.
 *
 * Same mint and same storage as {@link ensureHashSalt}: per site, persisted, never in the payload.
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
 * Compares a presented token against the stored one in constant time.
 *
 * A `===` on a secret leaks its prefix through timing, and this one guards a whole-database dump.
 * The length check is NOT an early return on mismatch -- it folds the lengths into the
 * same accumulator so a wrong-length guess costs the same as a wrong-value one.
 */
export function tokenMatches(presented: string | null | undefined, stored: string | null): boolean {
	if (!stored) return false;
	const a = presented ?? '';
	let diff = a.length ^ stored.length;
	const width = Math.max(a.length, stored.length);
	for (let i = 0; i < width; i++) {
		// charCodeAt past the end is NaN and `NaN | 0` is 0, so a short guess costs a full pass
		// rather than branching out of the loop early
		diff |= (a.charCodeAt(i) | 0) ^ (stored.charCodeAt(i) | 0);
	}
	return diff === 0;
}

/** the `Authorization` value an owner request carries */
/**
 * A usable point-in-time recovery bookmark.
 *
 * An all-zero one is what a back end with no change log answers instead of throwing, so it has to
 * be refused by VALUE; a feature-detect on the method passes there.
 */
export function isBookmark(value: string | null | undefined): boolean {
	if (typeof value !== 'string') return false;
	return /^[0-9a-f-]{16,}$/i.test(value) && /[1-9a-f]/i.test(value);
}

export function bearerToken(header: string | null): string | null {
	if (!header) return null;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match?.[1]?.trim() ?? null;
}
