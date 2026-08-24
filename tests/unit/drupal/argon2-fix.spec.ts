import { argon2id } from '@noble/hashes/argon2.js';
import { describe, expect, it } from 'vitest';
import {
	ARGON2_BRIDGE,
	ARGON2_DEFAULTS,
	ARGON2_FIX,
	ARGON2_MAX_MEMORY_KIB,
	ARGON2_VERSION,
	argon2HostCall,
	installArgon2
} from '../../../src/drupal/argon2-fix';

/**
 * P25's host half.
 *
 * The RFC vector is the whole correctness argument. Everything else here is about the parameters
 * this runtime will and will not accept, and about the encoded form staying PHP's own so a hash
 * written on this platform verifies on a site that leaves it.
 */

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

describe('the argon2id implementation is the one it claims to be', () => {
	it('reproduces the RFC 9106 test vector', () => {
		// RFC 9106 section 5.3: argon2id, v=19, t=3, m=32, p=4, with a secret and associated data
		const tag = argon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), {
			t: 3,
			m: 32,
			p: 4,
			dkLen: 32,
			version: 0x13,
			key: new Uint8Array(8).fill(3),
			personalization: new Uint8Array(12).fill(4)
		});
		expect(hex(new Uint8Array(tag))).toBe(
			'0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659'
		);
	});

	it('is deterministic and salt-sensitive through the bridge', () => {
		const req = {
			passB64: b64(new TextEncoder().encode('correct horse battery staple')),
			saltB64: b64(new Uint8Array(16).fill(9)),
			m: 64,
			t: 2,
			p: 1
		};
		const a = argon2HostCall(req);
		const b = argon2HostCall(req);
		const c = argon2HostCall({ ...req, saltB64: b64(new Uint8Array(16).fill(10)) });
		expect(a.ok && b.ok && c.ok).toBe(true);
		if (!a.ok || !b.ok || !c.ok) return;
		expect(a.tagB64).toBe(b.tagB64);
		expect(a.tagB64).not.toBe(c.tagB64);
	});
});

describe('the parameters it refuses', () => {
	const base = { passB64: b64(new TextEncoder().encode('x')), saltB64: b64(new Uint8Array(16)) };

	it('refuses an arena the isolate does not have', () => {
		const out = argon2HostCall({ ...base, m: ARGON2_MAX_MEMORY_KIB + 1 });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toContain('memory cost');
	});

	it('refuses a salt short enough to make the hash reusable', () => {
		const out = argon2HostCall({ ...base, saltB64: b64(new Uint8Array(4)) });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toContain('salt');
	});

	it('refuses nonsense time, lane and tag values rather than passing them through', () => {
		expect(argon2HostCall({ ...base, t: 0 }).ok).toBe(false);
		expect(argon2HostCall({ ...base, p: 99 }).ok).toBe(false);
		expect(argon2HostCall({ ...base, tagLen: 8 }).ok).toBe(false);
	});

	it('defaults to OWASP floor rather than to something cheaper', () => {
		expect(ARGON2_DEFAULTS).toEqual({ m: 19_456, t: 2, p: 1 });
		// 19 MiB, which is what the deployed arena probe measured as fitting beside a 117 MiB heap
		expect(ARGON2_DEFAULTS.m * 1024).toBe(19_922_944);
		expect(ARGON2_VERSION).toBe(0x13);
	});
});

describe('the bridge install', () => {
	it('hangs one masked entry on the binary and answers JSON', () => {
		const binary: Record<string, unknown> = {};
		let masked = 0;
		installArgon2(binary, (fn) => {
			masked++;
			return fn();
		});
		const call = binary[ARGON2_BRIDGE] as (json: string) => string;
		expect(typeof call).toBe('function');

		const reply = JSON.parse(
			call(
				JSON.stringify({
					passB64: b64(new TextEncoder().encode('pw')),
					saltB64: b64(new Uint8Array(16).fill(1)),
					m: 64,
					t: 1,
					p: 1
				})
			)
		);
		expect(reply.ok).toBe(true);
		expect(masked).toBe(1);
	});

	it('answers an unparseable request rather than throwing into PHP', () => {
		const binary: Record<string, unknown> = {};
		installArgon2(binary, (fn) => fn());
		const reply = JSON.parse((binary[ARGON2_BRIDGE] as (j: string) => string)('{not json'));
		expect(reply.ok).toBe(false);
		expect(String(reply.error)).toContain('unparseable');
	});
});

describe('the PHP half', () => {
	it('does NOT try to redeclare password_hash, which is a built-in', () => {
		// the [[inert-shim-guard]] failure from the other direction: a conditional declaration of a
		// function PHP always provides would never bind, so the seam has to be Drupal's service
		expect(ARGON2_FIX).not.toContain('function password_hash');
		expect(ARGON2_FIX).not.toContain('function password_verify');
		expect(ARGON2_FIX).toContain('function cfw_argon2_hash');
		expect(ARGON2_FIX).toContain('function cfw_argon2_verify');
	});

	it("writes PHP's own encoded form, so a hash survives leaving this platform", () => {
		expect(ARGON2_FIX).toContain('$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s');
		// unpadded base64 is what PHP's argon2 encoding uses; padding makes the string non-standard
		expect(ARGON2_FIX).toContain("rtrim(base64_encode($raw), '=')");
	});

	it('compares in constant time', () => {
		expect(ARGON2_FIX).toContain('hash_equals(');
	});
});
