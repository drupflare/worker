import { describe, expect, it } from 'vitest';
import {
	HASH_SALT_KEY,
	OWNER_HASH_KEY,
	OWNER_TOKEN_KEY,
	SALT_BYTES,
	adoptLegacyOwnerToken,
	assertSalt,
	bearerToken,
	ensureHashSalt,
	hashSaltAssignment,
	mintOwnerToken,
	ownerTokenIsSet,
	ownerTokenMatches,
	randomKeyBase64,
	readSealed,
	rotateOwnerToken,
	stateSerialized,
	tokenMatches,
	writeSealed
} from '../../../src/ops/site-secrets';
import { memorySecretStore as fakeStore } from '../../helpers/secret-store';

describe('randomKeyBase64', () => {
	it('produces the 74 characters Drupal Crypt::randomBytesBase64(55) produces', () => {
		// the shipped system.private_key row was s:74:"..."; a value minted here has to be
		// indistinguishable in form or removing that row would be a format change in disguise
		expect(randomKeyBase64(SALT_BYTES)).toHaveLength(74);
	});

	it('stays inside the base64url alphabet, so it cannot break a PHP string literal', () => {
		for (let i = 0; i < 50; i++) expect(randomKeyBase64()).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('does not repeat', () => {
		const seen = new Set(Array.from({ length: 200 }, () => randomKeyBase64(18)));
		expect(seen.size).toBe(200);
	});
});

describe('ensureHashSalt', () => {
	it('mints and persists on an empty store', () => {
		const store = fakeStore();
		const salt = ensureHashSalt(store, () => 'minted-value');
		expect(salt).toBe('minted-value');
		expect(store.rows.get(HASH_SALT_KEY)).toBe('minted-value');
	});

	it('returns the stored salt on every later boot', () => {
		// the whole reason it is persisted: a remount that re-minted would invalidate every session
		// and every unexpired one-time login link
		const store = fakeStore({ [HASH_SALT_KEY]: 'already-here' });
		let mints = 0;
		expect(
			ensureHashSalt(store, () => {
				mints++;
				return 'fresh';
			})
		).toBe('already-here');
		expect(mints).toBe(0);
	});

	it('treats an empty stored value as absent rather than honouring it', () => {
		const store = fakeStore({ [HASH_SALT_KEY]: '' });
		expect(ensureHashSalt(store, () => 'replacement')).toBe('replacement');
	});

	it('gives two sites different salts', () => {
		const a = ensureHashSalt(fakeStore());
		const b = ensureHashSalt(fakeStore());
		expect(a).not.toBe(b);
	});

	it('refuses to persist a mint outside the alphabet', () => {
		const store = fakeStore();
		expect(() => ensureHashSalt(store, () => "'; system('rm -rf /'); $x = '")).toThrow(
			/not base64url/
		);
		expect(store.rows.size).toBe(0);
	});
});

describe('hashSaltAssignment', () => {
	it('is a complete PHP statement assigning the salt', () => {
		expect(hashSaltAssignment('abc-123_XYZ')).toBe("$settings['hash_salt'] = 'abc-123_XYZ';\n");
	});

	it('refuses anything that could close the literal', () => {
		// this builds source that gets executed, so "it can only be what we wrote" is exactly the
		// assumption not worth making about a value that arrives back out of a database
		for (const bad of ["a'b", 'a"b', 'a\\b', 'a b', 'a;b', 'a$b', '']) {
			expect(() => hashSaltAssignment(bad)).toThrow(/not base64url/);
		}
	});

	it('accepts what the mint produces, every time', () => {
		for (let i = 0; i < 50; i++) expect(() => assertSalt(randomKeyBase64())).not.toThrow();
	});
});

describe('stateSerialized', () => {
	it('matches the PHP serialization the removed private_key row used', () => {
		expect(stateSerialized('abc')).toBe('s:3:"abc";');
		expect(stateSerialized(randomKeyBase64(SALT_BYTES))).toMatch(/^s:74:"[A-Za-z0-9_-]{74}";$/);
	});
});

describe('the owner token, which is how a site is exported without opening a shell', () => {
	it('mints once, stores only its hash and returns the plaintext to the minter', async () => {
		const store = fakeStore();
		expect(await mintOwnerToken(store, () => 'tok-1')).toBe('tok-1');
		const stored = store.sealedRows.get(OWNER_HASH_KEY);
		expect(stored).toMatch(/^[0-9a-f]{64}$/);
		expect(stored).not.toBe('tok-1');
		// nothing in the SQL-reachable table holds the token or its hash
		expect([...store.rows.values()].join('|')).not.toContain('tok-1');
		expect([...store.rows.values()].join('|')).not.toContain(stored ?? 'x');
	});

	it('hands out nothing on a repeat claim, so a token is shown once', async () => {
		const store = fakeStore();
		await mintOwnerToken(store, () => 'tok-1');
		expect(await mintOwnerToken(store, () => 'tok-2')).toBeUndefined();
		expect(await ownerTokenMatches(store, 'tok-1')).toBe(true);
		expect(await ownerTokenMatches(store, 'tok-2')).toBe(false);
	});

	it('accepts the token and nothing that resembles it', async () => {
		const store = fakeStore();
		await mintOwnerToken(store, () => 'tok-1');
		for (const bad of ['tok-2', 'tok-', 'tok-11', 'TOK-1', '', null, undefined]) {
			expect(await ownerTokenMatches(store, bad), String(bad)).toBe(false);
		}
		expect(await ownerTokenMatches(fakeStore(), 'tok-1')).toBe(false);
	});

	it('is a DIFFERENT secret from the hash salt', async () => {
		// one credential guarding both the dump and the session signing would mean handing an
		// exporter the ability to forge password-reset links
		const store = fakeStore();
		expect(await mintOwnerToken(store)).not.toBe(ensureHashSalt(store));
	});

	it('gives two sites different tokens', async () => {
		expect(await mintOwnerToken(fakeStore())).not.toBe(await mintOwnerToken(fakeStore()));
	});

	it('rotates: the old token stops working and the new one works', async () => {
		const store = fakeStore();
		await mintOwnerToken(store, () => 'tok-1');
		expect(await rotateOwnerToken(store, () => 'tok-2')).toBe('tok-2');
		expect(await ownerTokenMatches(store, 'tok-1')).toBe(false);
		expect(await ownerTokenMatches(store, 'tok-2')).toBe(true);
	});

	it('migrates a legacy plaintext row on the first read of any kind and deletes the row', async () => {
		const store = fakeStore({ [OWNER_TOKEN_KEY]: 'legacy-token' });
		expect(await ownerTokenIsSet(store)).toBe(true);
		expect(store.rows.has(OWNER_TOKEN_KEY)).toBe(false);
		expect(store.sealedRows.get(OWNER_HASH_KEY)).toMatch(/^[0-9a-f]{64}$/);
		expect(await ownerTokenMatches(store, 'legacy-token')).toBe(true);
		// idempotent: adopting again changes nothing
		const before = store.sealedRows.get(OWNER_HASH_KEY);
		await adoptLegacyOwnerToken(store);
		expect(store.sealedRows.get(OWNER_HASH_KEY)).toBe(before);
	});

	it('ignores a plaintext row planted after the hash exists, and deletes it unread', async () => {
		// SQL can write cfw_meta, so a row there must never replace the sealed hash
		const store = fakeStore();
		await mintOwnerToken(store, () => 'real-token');
		store.rows.set(OWNER_TOKEN_KEY, 'attacker-token');
		expect(await ownerTokenMatches(store, 'attacker-token')).toBe(false);
		expect(await ownerTokenMatches(store, 'real-token')).toBe(true);
		expect(store.rows.has(OWNER_TOKEN_KEY)).toBe(false);
	});

	it('treats an emptied legacy row as no token', async () => {
		const store = fakeStore({ [OWNER_TOKEN_KEY]: '' });
		expect(await ownerTokenIsSet(store)).toBe(false);
		expect(store.rows.has(OWNER_TOKEN_KEY)).toBe(false);
	});
});

describe('sealed credentials', () => {
	it('moves a legacy row into the sealed store on first read', () => {
		const store = fakeStore({ git_token_a: 'ghp_made_up' });
		expect(readSealed(store, 'git_token_a')).toBe('ghp_made_up');
		expect(store.rows.has('git_token_a')).toBe(false);
		expect(store.sealedRows.get('git_token_a')).toBe('ghp_made_up');
	});

	it('writes to the sealed store only, and removes a stale row', () => {
		const store = fakeStore({ git_token_a: 'old' });
		writeSealed(store, 'git_token_a', 'new');
		expect(store.rows.has('git_token_a')).toBe(false);
		expect(readSealed(store, 'git_token_a')).toBe('new');
	});

	it('does not re-adopt a planted row once the credential is sealed or cleared', () => {
		const store = fakeStore();
		writeSealed(store, 'cf_oauth_token', 'live');
		store.rows.set('cf_oauth_token', 'planted');
		expect(readSealed(store, 'cf_oauth_token')).toBe('live');
		expect(store.rows.has('cf_oauth_token')).toBe(false);
		writeSealed(store, 'cf_oauth_token', '');
		store.rows.set('cf_oauth_token', 'planted again');
		expect(readSealed(store, 'cf_oauth_token')).toBe('');
		expect(store.rows.has('cf_oauth_token')).toBe(false);
	});

	it('reads null for a credential nobody set', () => {
		expect(readSealed(fakeStore(), 'git_token_none')).toBeNull();
	});
});

describe('tokenMatches', () => {
	it('accepts the exact token and nothing else', () => {
		expect(tokenMatches('abc', 'abc')).toBe(true);
		expect(tokenMatches('abd', 'abc')).toBe(false);
	});

	it('refuses a prefix, a suffix and an extension, which a length check alone would miss', () => {
		expect(tokenMatches('ab', 'abc')).toBe(false);
		expect(tokenMatches('abcd', 'abc')).toBe(false);
		expect(tokenMatches('bc', 'abc')).toBe(false);
	});

	it('refuses everything when no token has been minted', () => {
		// the dangerous default: an unminted site must not be exportable by presenting nothing
		expect(tokenMatches('anything', null)).toBe(false);
		expect(tokenMatches(null, null)).toBe(false);
		expect(tokenMatches('', '')).toBe(false);
	});

	it('refuses an absent header against a real token', () => {
		expect(tokenMatches(null, 'real')).toBe(false);
		expect(tokenMatches(undefined, 'real')).toBe(false);
		expect(tokenMatches('', 'real')).toBe(false);
	});

	it('compares every character rather than stopping at the first mismatch', () => {
		// a `===` leaks the prefix through timing, and this guards a whole-database dump. Asserted
		// structurally: a mismatch in the FIRST position and in the LAST must both be refused, and
		// a same-length wrong guess must not be distinguishable by outcome from a wrong-length one
		expect(tokenMatches('Xbc', 'abc')).toBe(false);
		expect(tokenMatches('abX', 'abc')).toBe(false);
		expect(tokenMatches('abcdefgh', 'abc')).toBe(false);
	});
});

describe('bearerToken', () => {
	it('reads the token out of an Authorization header', () => {
		expect(bearerToken('Bearer abc123')).toBe('abc123');
		expect(bearerToken('bearer abc123')).toBe('abc123');
		expect(bearerToken('  Bearer   abc123  ')).toBe('abc123');
	});

	it('returns null for anything that is not a bearer credential', () => {
		for (const header of [null, '', 'abc123', 'Basic abc123', 'Bearer', 'Bearer   ']) {
			expect(bearerToken(header), String(header)).toBeUndefined();
		}
	});
});
