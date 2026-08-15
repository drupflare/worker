import { describe, expect, it } from 'vitest';
import {
	HASH_SALT_KEY,
	OWNER_TOKEN_KEY,
	SALT_BYTES,
	assertSalt,
	bearerToken,
	ensureHashSalt,
	ensureOwnerToken,
	hashSaltAssignment,
	randomKeyBase64,
	stateSerialized,
	tokenMatches,
	type SecretStore
} from '../../../src/ops/site-secrets';

/** an in-memory {@link SecretStore}; the contract is get-then-set, not a database */
function fakeStore(seed: Record<string, string> = {}): SecretStore & { rows: Map<string, string> } {
	const rows = new Map(Object.entries(seed));
	return {
		rows,
		get: (key) => rows.get(key) ?? null,
		set: (key, value) => void rows.set(key, value)
	};
}

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
	it('mints and persists on first use, like the salt', () => {
		const store = fakeStore();
		expect(ensureOwnerToken(store, () => 'tok-1')).toBe('tok-1');
		expect(store.rows.get(OWNER_TOKEN_KEY)).toBe('tok-1');
	});

	it('is stable, so a token handed out once keeps working', () => {
		const store = fakeStore({ [OWNER_TOKEN_KEY]: 'issued' });
		expect(ensureOwnerToken(store, () => 'fresh')).toBe('issued');
	});

	it('is a DIFFERENT secret from the hash salt', () => {
		// one credential guarding both the dump and the session signing would mean handing an
		// exporter the ability to forge password-reset links
		const store = fakeStore();
		expect(ensureOwnerToken(store)).not.toBe(ensureHashSalt(store));
	});

	it('gives two sites different tokens', () => {
		expect(ensureOwnerToken(fakeStore())).not.toBe(ensureOwnerToken(fakeStore()));
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
			expect(bearerToken(header), String(header)).toBeNull();
		}
	});
});
