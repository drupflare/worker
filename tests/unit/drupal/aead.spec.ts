import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from '../../../src/db/file-store.js';
import {
	AEAD_ABYTES,
	AEAD_KEYBYTES,
	AEAD_NPUBBYTES,
	aeadHostCall,
	installAead,
	type AeadReply
} from '../../../src/drupal/sodium-fix.js';

/**
 * XChaCha20-Poly1305, and the one property a caller actually depends on.
 *
 * ext-sodium's `_decrypt()` returns FALSE when the tag does not verify and THROWS when an argument
 * is the wrong size. `XChaCha20Poly1305Cipher::open()` turns the FALSE into `AuthenticationFailure`,
 * which trips the `frame.aead_fail` tripwire and sweeps the frame. Collapsing the two would make a
 * mis-sized key sweep a healthy store, so the split is asserted rather than assumed.
 */

const b64 = (bytes: Uint8Array) => bytesToBase64(bytes);
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const KEY = b64(bytes(AEAD_KEYBYTES, 42));
const NONCE = b64(bytes(AEAD_NPUBBYTES, 9));

const seal = (message: string, aad = '') =>
	aeadHostCall({
		op: 'encrypt',
		b64: b64(new TextEncoder().encode(message)),
		aad64: b64(new TextEncoder().encode(aad)),
		nonce64: NONCE,
		key64: KEY
	});

const open = (sealed: string, aad = '', key = KEY, nonce = NONCE) =>
	aeadHostCall({
		op: 'decrypt',
		b64: sealed,
		aad64: b64(new TextEncoder().encode(aad)),
		nonce64: nonce,
		key64: key
	});

const okB64 = (r: AeadReply) => {
	expect(r.ok, 'ok' in r && !r.ok ? r.error : '').toBe(true);
	return (r as { b64: string }).b64;
};

describe('the XChaCha20-Poly1305 bridge', () => {
	it('round trips a message', () => {
		const sealed = okB64(seal('the quick brown fox'));
		const plain = okB64(open(sealed));
		expect(new TextDecoder().decode(base64ToBytes(plain))).toBe('the quick brown fox');
	});

	it('round trips with associated data', () => {
		const sealed = okB64(seal('payload', 'frame-header'));
		expect(new TextDecoder().decode(base64ToBytes(okB64(open(sealed, 'frame-header'))))).toBe(
			'payload'
		);
	});

	it('adds exactly the tag length, so a frame budget is predictable', () => {
		const sealed = base64ToBytes(okB64(seal('12345678')));
		expect(sealed.length).toBe(8 + AEAD_ABYTES);
	});

	it('produces different ciphertext for different associated data', () => {
		expect(okB64(seal('same', 'a'))).not.toBe(okB64(seal('same', 'b')));
	});

	// #region the split a caller reads
	it('reports a FLIPPED BYTE as an auth failure, not an argument error', () => {
		const sealed = base64ToBytes(okB64(seal('tamper me')));
		sealed[0] = (sealed[0] as number) ^ 0xff;
		const r = open(b64(sealed));
		expect(r.ok).toBe(false);
		expect((r as { auth?: boolean }).auth).toBe(true);
	});

	it('reports the WRONG KEY as an auth failure', () => {
		const sealed = okB64(seal('secret'));
		const r = open(sealed, '', b64(bytes(AEAD_KEYBYTES, 1)));
		expect(r.ok).toBe(false);
		expect((r as { auth?: boolean }).auth).toBe(true);
	});

	it('reports the WRONG associated data as an auth failure', () => {
		const sealed = okB64(seal('secret', 'header-a'));
		const r = open(sealed, 'header-b');
		expect(r.ok).toBe(false);
		expect((r as { auth?: boolean }).auth).toBe(true);
	});

	it('reports a TRUNCATED frame as an auth failure rather than crashing', () => {
		const r = open(b64(bytes(AEAD_ABYTES - 1, 3)));
		expect(r.ok).toBe(false);
		expect((r as { auth?: boolean }).auth).toBe(true);
	});

	it('reports a MIS-SIZED KEY as an argument error, which must NOT sweep the store', () => {
		const r = aeadHostCall({
			op: 'decrypt',
			b64: okB64(seal('x')),
			nonce64: NONCE,
			key64: b64(bytes(16))
		});
		expect(r.ok).toBe(false);
		// the whole point: not `auth`, so PHP throws instead of returning FALSE
		expect((r as { auth?: boolean }).auth).toBeFalsy();
		expect((r as { error: string }).error).toContain('KEYBYTES');
	});

	it('reports a MIS-SIZED NONCE as an argument error', () => {
		const r = aeadHostCall({
			op: 'encrypt',
			b64: b64(bytes(4)),
			nonce64: b64(bytes(12)),
			key64: KEY
		});
		expect(r.ok).toBe(false);
		expect((r as { auth?: boolean }).auth).toBeFalsy();
		expect((r as { error: string }).error).toContain('NPUBBYTES');
	});
	// #endregion

	it('refuses an unknown op', () => {
		expect(aeadHostCall({ op: 'sign' })).toMatchObject({ ok: false });
	});

	it('seals and opens an empty message', () => {
		const sealed = okB64(seal(''));
		expect(base64ToBytes(sealed).length).toBe(AEAD_ABYTES);
		expect(base64ToBytes(okB64(open(sealed))).length).toBe(0);
	});

	it('handles a message larger than one chacha block', () => {
		const big = 'x'.repeat(5000);
		expect(new TextDecoder().decode(base64ToBytes(okB64(open(okB64(seal(big))))))).toBe(big);
	});

	it('installs on a binary and answers through the mask', () => {
		const binary: Record<string, unknown> = {};
		let masked = 0;
		installAead(binary, (fn) => {
			masked++;
			return fn();
		});
		const call = binary.cfwAead as (json: string) => string;
		const reply = JSON.parse(
			call(JSON.stringify({ op: 'encrypt', b64: '', nonce64: NONCE, key64: KEY }))
		);
		expect(reply.ok).toBe(true);
		expect(masked).toBe(1);
	});

	it('answers rather than throwing on an unparseable request', () => {
		const binary: Record<string, unknown> = {};
		installAead(binary, (fn) => fn());
		const call = binary.cfwAead as (json: string) => string;
		expect(JSON.parse(call('not json')).ok).toBe(false);
	});
});
