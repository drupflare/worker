#!/usr/bin/env bun
/**
 * The BLAKE2b bridge against a real oracle, case by case.
 *
 * The same shape `mb-parity.ts` uses and for the same reason: a shim over an extension is only
 * worth anything if it agrees with the extension, and the way to know that is to run both. What is
 * measured here is the SHIPPING host call -- `blake2bHostCall()` out of `src/drupal/sodium-fix.ts`,
 * the function the Durable Object installs -- rather than a re-implementation of it.
 *
 * TWO ORACLES, and the script says which one it used. Native `ext-sodium` is preferred because it
 * covers keyed hashing, every output length and the incremental form; where it is absent the run
 * falls back to the published BLAKE2 vectors, which cover far less but need no PHP.
 *
 * usage: bun scripts/measure/blake2b-parity.ts [--json]
 */
import { spawnSync } from 'node:child_process';
import { blake2bHostCall, emptyStates } from '../../src/drupal/sodium-fix.js';

const asJson = process.argv.slice(2).includes('--json');

/**
 * Published BLAKE2b vectors, used when no ext-sodium is reachable.
 *
 * RFC 7693 Appendix A gives the 512-bit digest of "abc"; the 256-bit digests are the ones strata's
 * own docblock quotes for its shard example, so a disagreement here is visible in that module's
 * documentation too.
 */
const PUBLISHED: { label: string; msg: string; outlen: number; hex: string }[] = [
	{
		label: 'blake2b-512("abc") -- RFC 7693 Appendix A',
		msg: 'abc',
		outlen: 64,
		hex:
			'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
			'7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923'
	},
	{
		label: 'blake2b-256("abc")',
		msg: 'abc',
		outlen: 32,
		hex: 'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319'
	},
	{
		label: 'blake2b-256("")',
		msg: '',
		outlen: 32,
		hex: '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8'
	}
];

const MSG_LENGTHS = [0, 1, 2, 3, 31, 32, 63, 64, 65, 127, 128, 129, 255, 256, 1000, 65535];
const OUT_LENGTHS = [16, 20, 32, 48, 64];
const KEY_LENGTHS = [0, 16, 32, 64];
const CHUNK_SIZES = [1, 7, 128, 1000];

/** reproducible bytes that are deliberately not valid UTF-8, so the base64 bridge is exercised */
function pattern(n: number): Uint8Array {
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i++) out[i] = (i * 37 + 11) & 0xff;
	return out;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

type Case = {
	label: string;
	msg64: string;
	key64: string;
	len: number;
	/** absent for the one-shot form */
	chunk?: number;
};

function cases(): Case[] {
	const out: Case[] = [];
	for (const n of MSG_LENGTHS) {
		const msg64 = b64(pattern(n));
		for (const len of OUT_LENGTHS) {
			for (const k of KEY_LENGTHS) {
				out.push({
					label: `oneshot msg=${n} out=${len} key=${k}`,
					msg64,
					key64: k === 0 ? '' : b64(pattern(k)),
					len
				});
			}
		}
		for (const chunk of CHUNK_SIZES) {
			for (const k of [0, 32]) {
				out.push({
					label: `stream msg=${n} chunk=${chunk} key=${k}`,
					msg64,
					key64: k === 0 ? '' : b64(pattern(k)),
					len: 32,
					chunk
				});
			}
		}
	}
	return out;
}

/** the shim's answer, through the same entry point the Durable Object installs */
function throughBridge(c: Case): string {
	const states = emptyStates();
	if (c.chunk === undefined) {
		const r = blake2bHostCall({ op: 'hash', b64: c.msg64, key64: c.key64, len: c.len }, states);
		return r.ok ? hex(Buffer.from(r.b64 ?? '', 'base64')) : `ERR ${r.error}`;
	}
	const init = blake2bHostCall({ op: 'init', key64: c.key64, len: c.len }, states);
	if (!init.ok) return `ERR ${init.error}`;
	const state = init.state;
	const msg = Buffer.from(c.msg64, 'base64');
	for (let i = 0; i < msg.length; i += c.chunk) {
		const slice = msg.subarray(i, i + c.chunk);
		const up = blake2bHostCall({ op: 'update', state, b64: slice.toString('base64') }, states);
		if (!up.ok) return `ERR ${up.error}`;
	}
	const fin = blake2bHostCall({ op: 'final', state, len: c.len }, states);
	return fin.ok ? hex(Buffer.from(fin.b64 ?? '', 'base64')) : `ERR ${fin.error}`;
}

/**
 * The oracle: one php process reading the whole case list off stdin.
 *
 * One spawn rather than one per case, because a spawn is milliseconds and there are hundreds of
 * cases; the PHP side does exactly what strata does, including chunking through the incremental
 * API rather than re-deriving it.
 */
const ORACLE = String.raw`<?php
$cases = json_decode(stream_get_contents(STDIN), true);
$out = [];
foreach ($cases as $c) {
	$msg = base64_decode($c['msg64']);
	$key = $c['key64'] === '' ? '' : base64_decode($c['key64']);
	try {
		if (!isset($c['chunk'])) {
			$out[] = bin2hex(sodium_crypto_generichash($msg, $key, $c['len']));
			continue;
		}
		$state = sodium_crypto_generichash_init($key, $c['len']);
		for ($i = 0; $i < strlen($msg); $i += $c['chunk']) {
			sodium_crypto_generichash_update($state, substr($msg, $i, $c['chunk']));
		}
		$out[] = bin2hex(sodium_crypto_generichash_final($state, $c['len']));
	} catch (Throwable $e) {
		$out[] = 'ERR ' . $e->getMessage();
	}
}
echo json_encode($out);
`;

function nativeOracle(list: Case[]): string[] | null {
	const probe = spawnSync('php', ['-r', 'echo extension_loaded("sodium") ? "1" : "0";'], {
		encoding: 'utf8'
	});
	if (probe.status !== 0 || probe.stdout.trim() !== '1') return null;
	const r = spawnSync('php', ['-r', ORACLE.replace(/^<\?php\n/, '')], {
		input: JSON.stringify(list),
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (r.status !== 0) return null;
	return JSON.parse(r.stdout) as string[];
}

const list = cases();
const native = nativeOracle(list);
const rows = list.map((c, i) => ({
	label: c.label,
	shim: throughBridge(c),
	oracle: native ? (native[i] ?? '') : null
}));

const compared = native ? rows : [];
const diverged = compared.filter((r) => r.shim !== r.oracle);

const publishedRows = PUBLISHED.map((v) => {
	const r = blake2bHostCall(
		{
			op: 'hash',
			b64: Buffer.from(v.msg, 'utf8').toString('base64'),
			key64: '',
			len: v.outlen
		},
		emptyStates()
	);
	const shim = r.ok ? hex(Buffer.from(r.b64 ?? '', 'base64')) : `ERR ${r.error}`;
	return { label: v.label, shim, oracle: v.hex };
});
const publishedDiverged = publishedRows.filter((r) => r.shim !== r.oracle);

if (asJson) {
	console.log(
		JSON.stringify(
			{
				oracle: native ? 'native ext-sodium' : 'published vectors only',
				cases: list.length,
				compared: compared.length,
				diverged,
				published: publishedRows,
				publishedDiverged
			},
			null,
			2
		)
	);
} else {
	console.log(
		`oracle: ${native ? 'native ext-sodium' : 'PUBLISHED VECTORS ONLY (no ext-sodium)'}`
	);
	console.log(`published vectors: ${publishedRows.length}, diverged ${publishedDiverged.length}`);
	for (const r of publishedDiverged)
		console.log(`  ${r.label}\n    shim ${r.shim}\n    want ${r.oracle}`);
	console.log(
		`generated cases: ${list.length}, compared ${compared.length}, diverged ${diverged.length}`
	);
	for (const r of diverged.slice(0, 20)) {
		console.log(`  ${r.label}\n    shim   ${r.shim}\n    native ${r.oracle}`);
	}
}

if (diverged.length > 0 || publishedDiverged.length > 0) process.exit(1);
