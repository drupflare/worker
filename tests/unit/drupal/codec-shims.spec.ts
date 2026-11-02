import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from '../../../src/db/file-store';
import { brotliHostCall, installBrotli } from '../../../src/site/shims/brotli-fix';
import { EXTENSION_TABLE } from '../../../src/site/shims/extension-table';
import { installZstd, zstdHostCall } from '../../../src/site/shims/zstd-fix';

/**
 * The host halves on workerd's own `node:zlib`, which is where they run in production. The node
 * spec checks them against the CLIs; this one checks that the runtime that ships has the calls.
 */

const PLAIN = new TextEncoder().encode('body{color:red}a{b:c}'.repeat(300));

function bytesOf(reply: { ok: true; b64: string } | { ok: false; error: string }): Uint8Array {
	if (!reply.ok) throw new Error(reply.error);
	return base64ToBytes(reply.b64);
}

describe('codec shims on workerd', () => {
	it('round-trips brotli through node:zlib', () => {
		const frame = bytesOf(
			brotliHostCall({ op: 'compress', b64: bytesToBase64(PLAIN), level: 5, mode: 0 })
		);
		const back = bytesOf(brotliHostCall({ op: 'uncompress', b64: bytesToBase64(frame) }));
		expect(new TextDecoder().decode(back)).toBe(new TextDecoder().decode(PLAIN));
	});

	it('round-trips zstd through node:zlib, with and without a dictionary', () => {
		const frame = bytesOf(
			zstdHostCall({ op: 'compress', b64: bytesToBase64(PLAIN), level: 3 })
		);
		const back = bytesOf(zstdHostCall({ op: 'uncompress', b64: bytesToBase64(frame) }));
		expect(new TextDecoder().decode(back)).toBe(new TextDecoder().decode(PLAIN));

		const dict = new TextEncoder().encode('body{color:red}a{b:c}'.repeat(20));
		const primed = bytesOf(
			zstdHostCall({
				op: 'compress',
				b64: bytesToBase64(PLAIN),
				level: 3,
				dict: bytesToBase64(dict)
			})
		);
		const again = bytesOf(
			zstdHostCall({
				op: 'uncompress',
				b64: bytesToBase64(primed),
				dict: bytesToBase64(dict)
			})
		);
		expect(new TextDecoder().decode(again)).toBe(new TextDecoder().decode(PLAIN));
	});

	it('compresses incompressible input above 4 KiB, which workerd zstd refuses', () => {
		const plain = new Uint8Array(65536);
		for (let i = 0; i < plain.length; i += 65536) {
			crypto.getRandomValues(plain.subarray(i, Math.min(plain.length, i + 65536)));
		}
		const frame = bytesOf(
			zstdHostCall({ op: 'compress', b64: bytesToBase64(plain), level: 3 })
		);
		const back = bytesOf(zstdHostCall({ op: 'uncompress', b64: bytesToBase64(frame) }));
		expect(bytesToBase64(back)).toBe(bytesToBase64(plain));
	});

	it('round-trips brotli on incompressible and large input at each quality', () => {
		// measured in workerd 2026-11-02: no size or quality refused; the native CLI and
		// ext-brotli 0.21.0 decode the same frames (tests/node/codec-shims.spec.ts)
		const random = (n: number): Uint8Array => {
			const out = new Uint8Array(n);
			for (let i = 0; i < n; i += 65536) {
				crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
			}
			return out;
		};
		const cases: Array<[Uint8Array, number[]]> = [
			[new Uint8Array(0), [0, 4, 11]],
			[random(4096), [0, 4, 11]],
			[random(16384), [0, 4, 11]],
			[random(65536), [0, 4, 11]],
			[random(1 << 20), [0, 4]],
			[random(4 << 20), [0, 4]],
			[new TextEncoder().encode('body{color:red}a{b:c}'.repeat(100000)), [4]]
		];
		for (const [plain, qualities] of cases) {
			for (const level of qualities) {
				const frame = bytesOf(
					brotliHostCall({ op: 'compress', b64: bytesToBase64(plain), level, mode: 0 })
				);
				const back = bytesOf(
					brotliHostCall({ op: 'uncompress', b64: bytesToBase64(frame) })
				);
				expect(back.length, `${plain.length} bytes at quality ${level}`).toBe(plain.length);
				expect(bytesToBase64(back), `${plain.length} bytes at quality ${level}`).toBe(
					bytesToBase64(plain)
				);
			}
		}
	});

	it('refuses a brotli preset dictionary, since node:zlib cannot take one', () => {
		const reply = brotliHostCall({
			op: 'compress',
			b64: bytesToBase64(PLAIN),
			level: 5,
			mode: 0,
			dict: bytesToBase64(new TextEncoder().encode('body'))
		});
		expect(reply.ok).toBe(false);
	});

	it('answers an error reply, not a throw, for a bad brotli level, mode, op or frame', () => {
		const b64 = bytesToBase64(PLAIN);
		expect(brotliHostCall({ op: 'compress', b64, level: 12 })).toEqual({
			ok: false,
			error: 'compression level (12) must be within 0..11'
		});
		expect(brotliHostCall({ op: 'compress', b64, level: 5, mode: 3 })).toEqual({
			ok: false,
			error: 'compression mode (3) is not GENERIC, TEXT or FONT'
		});
		expect(brotliHostCall({ op: 'compress', b64, level: 5, mode: 2 }).ok).toBe(true);
		expect(brotliHostCall({ op: 'squash', b64 })).toEqual({
			ok: false,
			error: "unknown brotli op 'squash'"
		});
		expect(brotliHostCall({ op: 'uncompress', b64 }).ok).toBe(false);
	});

	it('answers an error reply for a bad zstd level, op or frame', () => {
		const b64 = bytesToBase64(PLAIN);
		expect(zstdHostCall({ op: 'compress', b64, level: 23 })).toEqual({
			ok: false,
			error: 'compression level (23) must be within 1..22 or smaller then 0'
		});
		expect(zstdHostCall({ op: 'squash', b64 })).toEqual({
			ok: false,
			error: "unknown zstd op 'squash'"
		});
		expect(zstdHostCall({ op: 'uncompress', b64 }).ok).toBe(false);
	});

	it.each([
		['brotli', 'cfwBrotli', installBrotli, 'compress'],
		['zstd', 'cfwZstd', installZstd, 'compress']
	] as const)(
		'hangs the %s bridge on its key and runs each call inside the mask',
		(_n, key, install, op) => {
			let masked = 0;
			const binary: Record<string, unknown> = {};
			install(binary, (fn) => {
				masked++;
				return fn();
			});
			const run = binary[key] as (json: string) => string;
			const frame = JSON.parse(
				run(JSON.stringify({ op, b64: bytesToBase64(PLAIN), level: 3 }))
			);
			expect(frame.ok).toBe(true);
			const back = JSON.parse(run(JSON.stringify({ op: 'uncompress', b64: frame.b64 })));
			expect(base64ToBytes(back.b64)).toEqual(PLAIN);
			const bad = JSON.parse(run('not json'));
			expect(bad.ok).toBe(false);
			expect(String(bad.error)).toContain('unparseable request');
			expect(masked).toBe(3);
		}
	);

	it('keeps brotli and zstd out of extension_loaded, which needs the whole API', () => {
		expect(EXTENSION_TABLE).not.toHaveProperty('brotli');
		expect(EXTENSION_TABLE).not.toHaveProperty('zstd');
	});
});
