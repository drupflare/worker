import { SODIUM_API } from '../../src/site/generated/sodium-api';
import type { Arg, Case, Enc, Outcome } from './sodium-harness';

/** reproducible bytes as hex */
export const hex = (n: number, mul = 1, add = 7): string =>
	Buffer.from(new Uint8Array(n).map((_, i) => (i * mul + add) & 255)).toString('hex');

const B = (n: number, mul = 1, add = 7): Arg => ({ h: hex(n, mul, add) });
const I = (n: number | string): Arg => ({ i: n });
const U = (name: string, at?: number): Arg =>
	at === undefined ? { use: name } : { use: name, at };
const R = (name: string): Arg => ({ ref: name });

/** functions whose output is random, so only its shape can be compared */
export const RANDOM: ReadonlySet<string> = new Set(
	SODIUM_API.functions
		.map((f) => f.name)
		.filter(
			(n) =>
				n.endsWith('_keygen') ||
				[
					'sodium_crypto_box_keypair',
					'sodium_crypto_sign_keypair',
					'sodium_crypto_kx_keypair',
					'sodium_crypto_box_seal',
					'sodium_crypto_pwhash_str',
					'sodium_crypto_pwhash_scryptsalsa208sha256_str',
					'sodium_crypto_secretstream_xchacha20poly1305_init_push',
					'sodium_crypto_core_ristretto255_random',
					'sodium_crypto_core_ristretto255_scalar_random'
				].includes(n)
		)
);

/** functions whose state-carrying return value is opaque and not byte-compatible with native */
export const OPAQUE_STATE: ReadonlySet<string> = new Set([
	'sodium_crypto_generichash_init',
	'sodium_crypto_generichash_update'
]);

type Pair = [string, Arg[], string?];

const aead = (name: string, key: number, npub: number): Pair[] => [
	[`sodium_crypto_aead_${name}_encrypt`, [B(20), B(7, 3), B(npub, 5), B(key, 9)], `ct_${name}`],
	[`sodium_crypto_aead_${name}_decrypt`, [U(`ct_${name}`), B(7, 3), B(npub, 5), B(key, 9)]],
	[`sodium_crypto_aead_${name}_keygen`, []]
];

const KP_SEED = B(32, 3, 1);

/** the setup every later case reads from */
export const SETUP: Case[] = [
	{ fn: 'sodium_crypto_box_seed_keypair', args: [B(32, 3, 1)], store: 'bkpA' },
	{ fn: 'sodium_crypto_box_seed_keypair', args: [B(32, 5, 2)], store: 'bkpB' },
	{ fn: 'sodium_crypto_box_secretkey', args: [U('bkpA')], store: 'bskA' },
	{ fn: 'sodium_crypto_box_publickey', args: [U('bkpA')], store: 'bpkA' },
	{ fn: 'sodium_crypto_box_publickey', args: [U('bkpB')], store: 'bpkB' },
	{
		fn: 'sodium_crypto_box_keypair_from_secretkey_and_publickey',
		args: [U('bskA'), U('bpkB')],
		store: 'bkpAB'
	},
	{ fn: 'sodium_crypto_sign_seed_keypair', args: [KP_SEED], store: 'skp' },
	{ fn: 'sodium_crypto_sign_secretkey', args: [U('skp')], store: 'ssk' },
	{ fn: 'sodium_crypto_sign_publickey', args: [U('skp')], store: 'spk' },
	{ fn: 'sodium_crypto_sign_detached', args: [B(30), U('ssk')], store: 'sig' },
	{ fn: 'sodium_crypto_sign', args: [B(30), U('ssk')], store: 'smsg' },
	{ fn: 'sodium_crypto_kx_seed_keypair', args: [B(32, 7, 3)], store: 'kxC' },
	{ fn: 'sodium_crypto_kx_seed_keypair', args: [B(32, 11, 5)], store: 'kxS' },
	{ fn: 'sodium_crypto_kx_publickey', args: [U('kxC')], store: 'kxCpk' },
	{ fn: 'sodium_crypto_kx_publickey', args: [U('kxS')], store: 'kxSpk' },
	{ fn: 'sodium_crypto_core_ristretto255_from_hash', args: [B(64, 7, 3)], store: 'rP' },
	{ fn: 'sodium_crypto_core_ristretto255_from_hash', args: [B(64, 11, 5)], store: 'rQ' },
	{
		fn: 'sodium_crypto_core_ristretto255_scalar_reduce',
		args: [B(64, 13, 1)],
		store: 'rS'
	},
	{
		fn: 'sodium_crypto_core_ristretto255_scalar_reduce',
		args: [B(64, 17, 9)],
		store: 'rT'
	},
	{
		fn: 'sodium_crypto_secretstream_xchacha20poly1305_init_pull',
		args: [B(24, 3, 2), B(32, 5, 1)],
		store: 'ssPush'
	},
	{
		fn: 'sodium_crypto_secretstream_xchacha20poly1305_init_pull',
		args: [B(24, 3, 2), B(32, 5, 1)],
		store: 'ssPull'
	}
];

const ARGON_SALT = B(16, 3, 1);

/** one valid call per function, which the generated variants start from */
export const BASE: Pair[] = [
	...aead('aes256gcm', 32, 12),
	...aead('aegis128l', 16, 16),
	...aead('aegis256', 32, 32),
	...aead('chacha20poly1305', 32, 8),
	...aead('chacha20poly1305_ietf', 32, 12),
	...aead('xchacha20poly1305_ietf', 32, 24),
	['sodium_crypto_aead_aes256gcm_is_available', []],
	['sodium_crypto_auth', [B(20), B(32, 3)], 'mac'],
	['sodium_crypto_auth_verify', [U('mac'), B(20), B(32, 3)]],
	['sodium_crypto_auth_keygen', []],
	['sodium_crypto_box', [B(20), B(24, 5), U('bkpAB')], 'bx'],
	['sodium_crypto_box_open', [U('bx'), B(24, 5), U('bkpAB')]],
	['sodium_crypto_box_keypair', []],
	['sodium_crypto_box_seed_keypair', [B(32, 3, 1)]],
	['sodium_crypto_box_keypair_from_secretkey_and_publickey', [B(32), B(32, 3)]],
	['sodium_crypto_box_publickey', [U('bkpA')]],
	['sodium_crypto_box_secretkey', [U('bkpA')]],
	['sodium_crypto_box_publickey_from_secretkey', [U('bskA')]],
	['sodium_crypto_box_seal', [B(20), U('bpkA')]],
	['sodium_crypto_box_seal_open', [B(80), U('bkpA')]],
	['sodium_crypto_core_ristretto255_add', [U('rP'), U('rQ')]],
	['sodium_crypto_core_ristretto255_sub', [U('rP'), U('rQ')]],
	['sodium_crypto_core_ristretto255_from_hash', [B(64, 7, 3)]],
	['sodium_crypto_core_ristretto255_is_valid_point', [U('rP')]],
	['sodium_crypto_core_ristretto255_random', []],
	['sodium_crypto_core_ristretto255_scalar_add', [U('rS'), U('rT')]],
	['sodium_crypto_core_ristretto255_scalar_sub', [U('rS'), U('rT')]],
	['sodium_crypto_core_ristretto255_scalar_mul', [U('rS'), U('rT')]],
	['sodium_crypto_core_ristretto255_scalar_complement', [U('rS')]],
	['sodium_crypto_core_ristretto255_scalar_invert', [U('rS')]],
	['sodium_crypto_core_ristretto255_scalar_negate', [U('rS')]],
	['sodium_crypto_core_ristretto255_scalar_random', []],
	['sodium_crypto_core_ristretto255_scalar_reduce', [B(64, 13, 1)]],
	['sodium_crypto_kx_keypair', []],
	['sodium_crypto_kx_publickey', [U('kxC')]],
	['sodium_crypto_kx_secretkey', [U('kxC')]],
	['sodium_crypto_kx_seed_keypair', [B(32, 7, 3)]],
	['sodium_crypto_kx_client_session_keys', [U('kxC'), U('kxSpk')]],
	['sodium_crypto_kx_server_session_keys', [U('kxS'), U('kxCpk')]],
	['sodium_crypto_generichash', [B(50), B(32, 3), I(32)]],
	['sodium_crypto_generichash_keygen', []],
	['sodium_crypto_generichash_init', [B(32, 3), I(32)]],
	['sodium_crypto_kdf_derive_from_key', [I(32), I(7), B(8, 3), B(32, 5)]],
	['sodium_crypto_kdf_keygen', []],
	['sodium_crypto_pwhash', [I(32), B(8), ARGON_SALT, I(1), I(8192), I(2)]],
	['sodium_crypto_pwhash_str', [B(8), I(1), I(8192)]],
	['sodium_crypto_pwhash_str_needs_rehash', [B(40), I(2), I(65536)]],
	['sodium_crypto_pwhash_str_verify', [B(40), B(8)]],
	[
		'sodium_crypto_pwhash_scryptsalsa208sha256',
		[I(32), B(8), B(32, 3, 1), I(524288), I(16777216)]
	],
	['sodium_crypto_pwhash_scryptsalsa208sha256_str', [B(8), I(524288), I(16777216)]],
	['sodium_crypto_pwhash_scryptsalsa208sha256_str_verify', [B(40), B(8)]],
	['sodium_crypto_scalarmult', [B(32, 3, 1), U('bpkB')]],
	['sodium_crypto_scalarmult_base', [B(32, 3, 1)]],
	['sodium_crypto_scalarmult_ristretto255', [U('rS'), U('rP')]],
	['sodium_crypto_scalarmult_ristretto255_base', [U('rS')]],
	['sodium_crypto_secretbox', [B(20), B(24, 5), B(32, 9)], 'sb'],
	['sodium_crypto_secretbox_open', [U('sb'), B(24, 5), B(32, 9)]],
	['sodium_crypto_secretbox_keygen', []],
	['sodium_crypto_secretstream_xchacha20poly1305_keygen', []],
	['sodium_crypto_secretstream_xchacha20poly1305_init_push', [B(32, 5, 1)]],
	['sodium_crypto_secretstream_xchacha20poly1305_init_pull', [B(24, 3, 2), B(32, 5, 1)]],
	['sodium_crypto_shorthash', [B(20), B(16, 3)]],
	['sodium_crypto_shorthash_keygen', []],
	['sodium_crypto_sign', [B(30), U('ssk')]],
	['sodium_crypto_sign_detached', [B(30), U('ssk')]],
	['sodium_crypto_sign_ed25519_pk_to_curve25519', [U('spk')]],
	['sodium_crypto_sign_ed25519_sk_to_curve25519', [U('ssk')]],
	['sodium_crypto_sign_keypair', []],
	['sodium_crypto_sign_keypair_from_secretkey_and_publickey', [B(64), B(32)]],
	['sodium_crypto_sign_open', [U('smsg'), U('spk')]],
	['sodium_crypto_sign_publickey', [U('skp')]],
	['sodium_crypto_sign_secretkey', [U('skp')]],
	['sodium_crypto_sign_publickey_from_secretkey', [U('ssk')]],
	['sodium_crypto_sign_seed_keypair', [KP_SEED]],
	['sodium_crypto_sign_verify_detached', [U('sig'), B(30), U('spk')]],
	['sodium_crypto_stream', [I(100), B(24, 5), B(32, 9)]],
	['sodium_crypto_stream_keygen', []],
	['sodium_crypto_stream_xor', [B(100), B(24, 5), B(32, 9)]],
	['sodium_crypto_stream_xchacha20', [I(100), B(24, 5), B(32, 9)]],
	['sodium_crypto_stream_xchacha20_keygen', []],
	['sodium_crypto_stream_xchacha20_xor', [B(100), B(24, 5), B(32, 9)]],
	['sodium_crypto_stream_xchacha20_xor_ic', [B(100), B(24, 5), I(3), B(32, 9)]],
	['sodium_bin2hex', [B(20)]],
	['sodium_hex2bin', [{ h: Buffer.from('0a1B:2c').toString('hex') }, { h: '3a' }]],
	['sodium_bin2base64', [B(20), I(1)]],
	['sodium_base642bin', [{ h: Buffer.from('AQID/w==').toString('hex') }, I(1)]],
	['sodium_pad', [B(5), I(8)]],
	['sodium_unpad', [{ h: '6162638000000000' }, I(8)]],
	['sodium_memcmp', [B(8), B(8)]],
	['sodium_compare', [B(8), B(8, 3)]]
];

/** string lengths tried at each string position */
const LENGTHS = [
	0, 1, 2, 7, 8, 12, 15, 16, 17, 23, 24, 25, 31, 33, 47, 48, 63, 65, 95, 96, 97, 127
];
/** ints tried at each int position */
const INTS: Arg[] = [
	I(-1),
	I(0),
	I(1),
	I(2),
	I(255),
	I(256),
	I(4294967296),
	{ i: '9223372036854775807' },
	{ f: 7 },
	{ h: Buffer.from('xyz').toString('hex') },
	{ b: true }
];

/** the heavy functions skip ints that would make the native side run for minutes */
const INTS_HEAVY: Arg[] = INTS.filter((a) => !('i' in a && Number(a.i) >= 2 ** 31));

/** every type error and coercion worth comparing at one position */
const ODD: Arg[] = [{ arr: 1 }, { i: 12345 }, { f: 1.5 }, { b: true }, { n: 1 }];

/** the heavy functions get fewer variants, because each valid one hashes */
const HEAVY = new Set([
	'sodium_crypto_pwhash',
	'sodium_crypto_pwhash_str',
	'sodium_crypto_pwhash_scryptsalsa208sha256',
	'sodium_crypto_pwhash_scryptsalsa208sha256_str'
]);

/** functions an int past 2^31 would make allocate gigabytes on the native side */
const BIG_INT_UNSAFE = new Set([
	...HEAVY,
	'sodium_crypto_stream',
	'sodium_crypto_stream_xchacha20',
	'sodium_pad'
]);

const paramsOf = (fn: string) => SODIUM_API.functions.find((f) => f.name === fn)!.params;

/** the generated variants of one base call: a wrong-length string or a bad int at each position */
export function variants(fn: string, args: Arg[]): Case[] {
	const out: Case[] = [];
	const params = paramsOf(fn);
	args.forEach((arg, at) => {
		const p = params[at]!;
		if ('ref' in p && p.ref) return;
		if (p.type === 'int') {
			for (const v of BIG_INT_UNSAFE.has(fn) ? INTS_HEAVY : INTS)
				out.push({ fn, args: args.map((a, i) => (i === at ? v : a)) });
			return;
		}
		const lengths = HEAVY.has(fn) ? [0, 1, 15, 17, 31, 33, 64] : LENGTHS;
		for (const n of lengths) {
			out.push({ fn, args: args.map((a, i) => (i === at ? { h: hex(n, 5, 3) } : a)) });
		}
		if (!HEAVY.has(fn)) {
			for (const v of ODD) out.push({ fn, args: args.map((a, i) => (i === at ? v : a)) });
		}
	});
	return out;
}

/** the whole battery: setup, each base call, then its variants */
export function battery(): { cases: Case[]; index: string[] } {
	const cases: Case[] = [...SETUP];
	const index: string[] = SETUP.map((c) => c.fn);
	for (const [fn, args, store] of BASE) {
		const base: Case = store ? { fn, args, store } : { fn, args };
		for (const c of [base, ...variants(fn, args)]) {
			cases.push(c);
			index.push(fn);
		}
	}
	return { cases, index };
}

/** the stateful and multi-call flows, whose cases depend on each other */
export function flows(): { cases: Case[]; index: string[] } {
	const cases: Case[] = [];
	const index: string[] = [];
	const add = (fn: string, c: Case) => {
		cases.push(c);
		index.push(fn);
	};
	const GH = 'sodium_crypto_generichash';
	for (const len of [16, 32, 48, 64]) {
		for (const key of ['', hex(32, 3), hex(16, 5), hex(64, 7)]) {
			for (const chunks of [[0], [1, 5], [128, 1], [127, 129, 300], [200, 56, 256]]) {
				const st = `gh_${len}_${key.length}_${chunks.join('_')}`;
				add(`${GH}_init`, {
					fn: `${GH}_init`,
					args: [{ h: key }, I(len)],
					store: st
				});
				chunks.forEach((n, i) => {
					add(`${GH}_update`, { fn: `${GH}_update`, args: [R(st), B(n, 3, i)] });
				});
				add(`${GH}_final`, { fn: `${GH}_final`, args: [R(st), I(len)] });
				add(GH, {
					fn: GH,
					args: [{ h: chunks.map((n, i) => hex(n, 3, i)).join('') }, { h: key }, I(len)]
				});
			}
		}
	}
	// a final shorter and longer than the init, and a state used twice
	for (const [initLen, finLen] of [
		[32, 16],
		[32, 48],
		[16, 64],
		[64, 16]
	] as const) {
		const st = `ghx_${initLen}_${finLen}`;
		add(`${GH}_final`, { fn: `${GH}_init`, args: [{ h: '' }, I(initLen)], store: st });
		add(`${GH}_final`, { fn: `${GH}_update`, args: [R(st), B(40)] });
		add(`${GH}_final`, { fn: `${GH}_final`, args: [R(st), I(finLen)] });
	}
	add(`${GH}_final`, { fn: `${GH}_update`, args: [R('ghx_32_16'), B(3)] });
	add(`${GH}_update`, { fn: `${GH}_update`, args: [{ rh: hex(10) }, B(3)] });
	add(`${GH}_final`, { fn: `${GH}_final`, args: [{ rh: hex(5) }, I(32)] });
	add(`${GH}_update`, { fn: `${GH}_update`, args: [R('gh_null'), B(3)] });
	add(`${GH}_final`, { fn: `${GH}_final`, args: [R('gh_null'), I(32)] });

	const SS = 'sodium_crypto_secretstream_xchacha20poly1305';
	const key = B(32, 5, 1);
	const hdr = B(24, 3, 2);
	for (const [msg, ad] of [
		[0, 0],
		[1, 0],
		[63, 5],
		[64, 16],
		[200, 33]
	] as const) {
		const t = `ss_${msg}_${ad}`;
		add(`${SS}_init_pull`, { fn: `${SS}_init_pull`, args: [hdr, key], store: `${t}p` });
		add(`${SS}_init_pull`, { fn: `${SS}_init_pull`, args: [hdr, key], store: `${t}q` });
		for (const tag of [0, 1, 2, 3]) {
			add(`${SS}_push`, {
				fn: `${SS}_push`,
				args: [R(`${t}p`), B(msg, 3, tag), B(ad, 5), I(tag)],
				store: `${t}c${tag}`
			});
			add(`${SS}_pull`, {
				fn: `${SS}_pull`,
				args: [R(`${t}q`), U(`${t}c${tag}`), B(ad, 5)]
			});
		}
		add(`${SS}_pull`, { fn: `${SS}_pull`, args: [R(`${t}q`), U(`${t}c0`), B(ad, 5)] });
		add(`${SS}_pull`, { fn: `${SS}_pull`, args: [R(`${t}q`), B(40), B(ad, 5)] });
	}
	add(`${SS}_rekey`, { fn: `${SS}_rekey`, args: [R('ssPush')] });
	add(`${SS}_push`, { fn: `${SS}_push`, args: [R('ssPush'), B(10), B(0), I(0)] });
	add(`${SS}_pull`, { fn: `${SS}_pull`, args: [R('ssPull'), B(27), B(0)] });
	add(`${SS}_rekey`, { fn: `${SS}_rekey`, args: [{ rh: hex(10) }] });
	add(`${SS}_push`, { fn: `${SS}_push`, args: [{ rh: hex(10) }, B(1), B(0), I(0)] });
	add(`${SS}_push`, { fn: `${SS}_push`, args: [R('ssPush'), B(1), B(0), I(256)] });
	add(`${SS}_push`, { fn: `${SS}_push`, args: [R('ssPush'), B(1), B(0), I(-1)] });
	add(`${SS}_pull`, { fn: `${SS}_pull`, args: [{ rh: hex(10) }, B(30), B(0)] });
	add(`${SS}_pull`, { fn: `${SS}_pull`, args: [{ rh: hex(52) }, B(10), B(0)] });
	add(`${SS}_pull`, { fn: `${SS}_pull`, args: [R('gh_null'), B(30), B(0)] });
	for (const n of [0, 1, 2, 3, 63, 64, 65, 200]) {
		add('sodium_crypto_sign_verify_detached', {
			fn: 'sodium_crypto_sign_verify_detached',
			args: [U('sig'), B(n), U('spk')]
		});
	}

	// the pure-PHP helpers, across their edge inputs
	const ints = [-1, 0, 1, 3, 4, 7, 8, 16, 31, 32];
	for (const n of [0, 1, 7, 8, 9, 15, 16, 17, 33]) {
		for (const bs of ints) {
			add('sodium_pad', { fn: 'sodium_pad', args: [B(n), I(bs)], store: `pad_${n}_${bs}` });
			add('sodium_unpad', { fn: 'sodium_unpad', args: [U(`pad_${n}_${bs}`), I(bs)] });
			add('sodium_unpad', { fn: 'sodium_unpad', args: [B(n), I(bs)] });
		}
	}
	for (const s of [
		'',
		'0',
		'00',
		'0a1b',
		'0A1B',
		'0a1',
		'zz',
		'0a:1b',
		'0a 1b',
		' 0a1b',
		'0a1b ',
		'0:a1b',
		'::0a::',
		'0g'
	]) {
		for (const ignore of ['', ':', ': ', 'a']) {
			add('sodium_hex2bin', {
				fn: 'sodium_hex2bin',
				args: [
					{ h: Buffer.from(s).toString('hex') },
					{ h: Buffer.from(ignore).toString('hex') }
				]
			});
		}
	}
	for (const id of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
		for (const n of [0, 1, 2, 3, 4, 5, 20]) {
			add('sodium_bin2base64', {
				fn: 'sodium_bin2base64',
				args: [{ h: 'fbfffe01fbfffe01fbfffe01fbfffe01fbfffe01'.slice(0, n * 2) }, I(id)],
				store: `b64_${id}_${n}`
			});
			add('sodium_base642bin', {
				fn: 'sodium_base642bin',
				args: [U(`b64_${id}_${n}`), I(id)]
			});
		}
	}
	for (const s of [
		'AQID',
		'AQI=',
		'AQI',
		'AQ==',
		'AQ=',
		'AQ',
		'A',
		'AQID/w==',
		'AQID_w==',
		'AQID_w',
		'AQID/w',
		'AB==',
		'AR==',
		'AQ==AQ==',
		'AQ== ',
		' AQ==',
		'A Q I D',
		'AQ==\n',
		'====',
		'@@@@',
		'AQ===',
		''
	]) {
		for (const id of [1, 3, 5, 7]) {
			for (const ignore of ['', ' ', ' \n']) {
				add('sodium_base642bin', {
					fn: 'sodium_base642bin',
					args: [
						{ h: Buffer.from(s).toString('hex') },
						I(id),
						{ h: Buffer.from(ignore).toString('hex') }
					]
				});
			}
		}
	}
	for (const [a, b] of [
		['', ''],
		['00', '00'],
		['ff', '01'],
		['ffff', '0100'],
		['ffffff', '010000'],
		['0102', '0201'],
		['01', '0102'],
		['aabbccdd', '11223344'],
		['ffffffffffffffff', '0100000000000000']
	] as const) {
		add('sodium_add', { fn: 'sodium_add', args: [{ rh: a }, { h: b }] });
		add('sodium_compare', { fn: 'sodium_compare', args: [{ h: a }, { h: b }] });
		add('sodium_memcmp', { fn: 'sodium_memcmp', args: [{ h: a }, { h: b }] });
		add('sodium_increment', { fn: 'sodium_increment', args: [{ rh: a }] });
		add('sodium_memzero', { fn: 'sodium_memzero', args: [{ rh: a }] });
	}
	add('sodium_increment', { fn: 'sodium_increment', args: [{ i: 5 }] });
	add('sodium_memzero', { fn: 'sodium_memzero', args: [R('gh_null')] });
	add('sodium_add', { fn: 'sodium_add', args: [R('gh_null'), B(1)] });

	// ed25519: signatures, including ones libsodium refuses
	const base = hex(30);
	add('sodium_crypto_sign_open', {
		fn: 'sodium_crypto_sign_open',
		args: [{ h: base }, U('spk')]
	});
	for (const sig of [
		'00'.repeat(64),
		'01' + '00'.repeat(31) + '00'.repeat(32),
		'ff'.repeat(64),
		'ee' + 'ff'.repeat(30) + '7f' + '00'.repeat(32)
	]) {
		add('sodium_crypto_sign_verify_detached', {
			fn: 'sodium_crypto_sign_verify_detached',
			args: [{ h: sig }, B(5), U('spk')]
		});
	}
	for (const pk of [
		'00'.repeat(32),
		'01' + '00'.repeat(31),
		'ec' + 'ff'.repeat(30) + '7f',
		'ed' + 'ff'.repeat(30) + '7f',
		'ee' + 'ff'.repeat(30) + '7f',
		'ff'.repeat(32),
		'02' + '00'.repeat(31)
	]) {
		add('sodium_crypto_sign_ed25519_pk_to_curve25519', {
			fn: 'sodium_crypto_sign_ed25519_pk_to_curve25519',
			args: [{ h: pk }]
		});
		add('sodium_crypto_sign_verify_detached', {
			fn: 'sodium_crypto_sign_verify_detached',
			args: [U('sig'), B(30), { h: pk }]
		});
	}
	// x25519: all-zero and low-order points
	for (const p of [
		'00'.repeat(32),
		'01' + '00'.repeat(31),
		'ec' + 'ff'.repeat(30) + '7f',
		'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
		'5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
		'ff'.repeat(32)
	]) {
		add('sodium_crypto_scalarmult', {
			fn: 'sodium_crypto_scalarmult',
			args: [B(32, 3, 1), { h: p }]
		});
	}
	// ristretto255
	for (const s of [
		'00'.repeat(32),
		'01' + '00'.repeat(31),
		'ff'.repeat(32),
		'ed' + 'ff'.repeat(30) + '7f',
		'ec' + 'ff'.repeat(30) + '7f',
		'e2f2ae0a6abc4e71a884a961c500515f58e30b6aa582dd8db6a65945e08d2d76',
		'f3557f0b5a9d2c4e8b8b7f0a1c3d9e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d'
	]) {
		add('sodium_crypto_core_ristretto255_is_valid_point', {
			fn: 'sodium_crypto_core_ristretto255_is_valid_point',
			args: [{ h: s }]
		});
		add('sodium_crypto_core_ristretto255_add', {
			fn: 'sodium_crypto_core_ristretto255_add',
			args: [{ h: s }, U('rP')]
		});
		add('sodium_crypto_scalarmult_ristretto255', {
			fn: 'sodium_crypto_scalarmult_ristretto255',
			args: [U('rS'), { h: s }]
		});
	}
	for (const s of [
		'00'.repeat(32),
		'01' + '00'.repeat(31),
		'ff'.repeat(32),
		'ed' + 'd3f55c1a631258d69cf7a2def9de1400'.slice(0, 0) + '00'.repeat(30) + '10',
		'ff'.repeat(31) + '7f',
		'ff'.repeat(31) + '80'
	]) {
		for (const fn of [
			'sodium_crypto_core_ristretto255_scalar_invert',
			'sodium_crypto_core_ristretto255_scalar_negate',
			'sodium_crypto_core_ristretto255_scalar_complement',
			'sodium_crypto_scalarmult_ristretto255_base'
		]) {
			add(fn, { fn, args: [{ h: s }] });
		}
		for (const fn of [
			'sodium_crypto_core_ristretto255_scalar_add',
			'sodium_crypto_core_ristretto255_scalar_sub',
			'sodium_crypto_core_ristretto255_scalar_mul'
		]) {
			add(fn, { fn, args: [{ h: s }, U('rS')] });
		}
		add('sodium_crypto_scalarmult_ristretto255', {
			fn: 'sodium_crypto_scalarmult_ristretto255',
			args: [{ h: s }, U('rP')]
		});
	}
	for (const n of [64]) {
		for (const fill of ['00', 'ff', 'ed', '7f']) {
			add('sodium_crypto_core_ristretto255_from_hash', {
				fn: 'sodium_crypto_core_ristretto255_from_hash',
				args: [{ h: fill.repeat(n) }]
			});
			add('sodium_crypto_core_ristretto255_scalar_reduce', {
				fn: 'sodium_crypto_core_ristretto255_scalar_reduce',
				args: [{ h: fill.repeat(n) }]
			});
		}
	}
	// the streams at counters and lengths
	for (const ic of [0, 1, 2, 63, 64, 1000, 4294967295]) {
		add('sodium_crypto_stream_xchacha20_xor_ic', {
			fn: 'sodium_crypto_stream_xchacha20_xor_ic',
			args: [B(130), B(24, 5), I(ic), B(32, 9)]
		});
	}
	for (const len of [1, 2, 63, 64, 65, 127, 128, 129, 1000, 4096]) {
		for (const fn of ['sodium_crypto_stream', 'sodium_crypto_stream_xchacha20']) {
			add(fn, { fn, args: [I(len), B(24, 5), B(32, 9)] });
		}
	}
	for (const len of [0, 1, 15, 16, 17, 31, 32, 33, 63, 64, 65, 100, 1000]) {
		for (const fn of [
			'sodium_crypto_secretbox',
			'sodium_crypto_stream_xor',
			'sodium_crypto_stream_xchacha20_xor'
		]) {
			add(fn, { fn, args: [B(len), B(24, 5), B(32, 9)] });
		}
		add('sodium_crypto_auth', { fn: 'sodium_crypto_auth', args: [B(len), B(32, 3)] });
		add('sodium_crypto_shorthash', { fn: 'sodium_crypto_shorthash', args: [B(len), B(16, 3)] });
		add('sodium_crypto_sign_detached', {
			fn: 'sodium_crypto_sign_detached',
			args: [B(len), U('ssk')]
		});
		add('sodium_crypto_box', { fn: 'sodium_crypto_box', args: [B(len), B(24, 5), U('bkpAB')] });
		for (const [name, key, npub] of [
			['aes256gcm', 32, 12],
			['aegis128l', 16, 16],
			['aegis256', 32, 32],
			['chacha20poly1305', 32, 8],
			['chacha20poly1305_ietf', 32, 12],
			['xchacha20poly1305_ietf', 32, 24]
		] as const) {
			for (const ad of [0, 1, 16, 33]) {
				const fn = `sodium_crypto_aead_${name}_encrypt`;
				const t = `aead_${name}_${len}_${ad}`;
				add(fn, { fn, args: [B(len), B(ad, 3), B(npub, 5), B(key, 9)], store: t });
				const dec = `sodium_crypto_aead_${name}_decrypt`;
				add(dec, { fn: dec, args: [U(t), B(ad, 3), B(npub, 5), B(key, 9)] });
				add(dec, { fn: dec, args: [U(t), B(ad + 1, 3), B(npub, 5), B(key, 9)] });
			}
		}
		add('sodium_crypto_generichash', {
			fn: 'sodium_crypto_generichash',
			args: [B(len), { h: '' }, I(32)]
		});
	}
	for (const len of [1, 8, 16, 17, 32, 33, 48, 64]) {
		add('sodium_crypto_kdf_derive_from_key', {
			fn: 'sodium_crypto_kdf_derive_from_key',
			args: [I(len), I(len), B(8, 3), B(32, 5)]
		});
	}
	for (const id of ['0', '1', '4294967296', '9223372036854775807']) {
		add('sodium_crypto_kdf_derive_from_key', {
			fn: 'sodium_crypto_kdf_derive_from_key',
			args: [I(32), { i: id }, B(8, 3), B(32, 5)]
		});
	}
	// pwhash at small limits, so the gate stays quick
	for (const [ops, mem] of [
		[1, 8192],
		[2, 8192],
		[3, 16384],
		[1, 65536],
		[2, 131072]
	] as const) {
		for (const algo of [1, 2]) {
			add('sodium_crypto_pwhash', {
				fn: 'sodium_crypto_pwhash',
				args: [I(32), B(8), ARGON_SALT, I(ops), I(mem), I(algo)]
			});
		}
	}
	for (const len of [16, 17, 32, 64, 100]) {
		add('sodium_crypto_pwhash', {
			fn: 'sodium_crypto_pwhash',
			args: [I(len), B(0), ARGON_SALT, I(1), I(8192), I(2)]
		});
	}
	for (const algo of [0, 3, 99]) {
		add('sodium_crypto_pwhash', {
			fn: 'sodium_crypto_pwhash',
			args: [I(32), B(8), ARGON_SALT, I(1), I(8192), I(algo)]
		});
	}
	for (const [ops, mem] of [
		[0, 8192],
		[1, 0],
		[1, 4096],
		[1, 8191],
		[1, 8192],
		[2, 100000]
	] as const) {
		add('sodium_crypto_pwhash_str', {
			fn: 'sodium_crypto_pwhash_str',
			args: [B(8), I(ops), I(mem)]
		});
	}
	for (const [ops, mem] of [
		[524288, 16777216],
		[1000, 100],
		[1, 1]
	] as const) {
		add('sodium_crypto_pwhash_scryptsalsa208sha256_str', {
			fn: 'sodium_crypto_pwhash_scryptsalsa208sha256_str',
			args: [B(8), I(ops), I(mem)]
		});
	}
	for (const [ops, mem] of [
		[32768, 1048576],
		[524288, 16777216],
		[1, 1],
		[100000, 4194304],
		[2000000, 8388608],
		[524288, 67108864],
		[1000000, 1048576]
	] as const) {
		add('sodium_crypto_pwhash_scryptsalsa208sha256', {
			fn: 'sodium_crypto_pwhash_scryptsalsa208sha256',
			args: [I(32), B(8), B(32, 3, 1), I(ops), I(mem)]
		});
	}
	for (const garbage of [
		'',
		'x',
		'$argon2id$',
		'$argon2id$v=19$m=8,t=1,p=1$AAAA$AAAA',
		'$argon2i$v=19$m=8,t=1,p=1$c29tZXNhbHRzb21lc2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
		'$7$',
		'$7$C6..../....AAAA$AAAA'
	]) {
		const g = { h: Buffer.from(garbage).toString('hex') };
		add('sodium_crypto_pwhash_str_verify', {
			fn: 'sodium_crypto_pwhash_str_verify',
			args: [g, B(8)]
		});
		add('sodium_crypto_pwhash_str_needs_rehash', {
			fn: 'sodium_crypto_pwhash_str_needs_rehash',
			args: [g, I(2), I(65536)]
		});
		add('sodium_crypto_pwhash_scryptsalsa208sha256_str_verify', {
			fn: 'sodium_crypto_pwhash_scryptsalsa208sha256_str_verify',
			args: [g, B(8)]
		});
	}
	return { cases, index };
}

/** the shape of a value for random outputs: its kind and string lengths */
export function shape(e: Enc | undefined): unknown {
	if (!e) return null;
	if ('s' in e) return `s${e.s.length / 2}`;
	if ('l' in e) return e.l.map(shape);
	return e;
}

/** whether two outcomes agree for one function */
export function agree(fn: string, a: Outcome, b: Outcome, random = RANDOM.has(fn)): boolean {
	if (a.ex || b.ex) return JSON.stringify(a.ex) === JSON.stringify(b.ex);
	if (random || OPAQUE_STATE.has(fn)) {
		return (
			JSON.stringify(shape(a.ret)) === JSON.stringify(shape(b.ret)) &&
			(OPAQUE_STATE.has(fn) || JSON.stringify(a.refs) === JSON.stringify(b.refs))
		);
	}
	return (
		JSON.stringify(a.ret) === JSON.stringify(b.ret) &&
		JSON.stringify(a.refs) === JSON.stringify(b.refs)
	);
}

/** a small seeded generator, so a failing fuzz case reproduces */
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** random bytes of the lengths each base call uses, so every function sees inputs no one chose */
export function fuzz(rounds = 12, seed = 20261102): { cases: Case[]; index: string[] } {
	const rand = prng(seed);
	const bytes = (n: number) =>
		Buffer.from(Uint8Array.from({ length: n }, () => Math.floor(rand() * 256))).toString('hex');
	const cases: Case[] = [];
	const index: string[] = [];
	for (const [fn, args] of BASE) {
		const params = paramsOf(fn);
		const n = HEAVY.has(fn) ? 2 : rounds;
		for (let r = 0; r < n; r++) {
			const next = args.map((a, i): Arg => {
				const p = params[i]!;
				if (('ref' in p && p.ref) || p.type === 'int' || !('h' in a)) return a;
				// variable-length data gets a random length, fixed-size data keeps its size
				const size = a.h.length / 2;
				const free =
					size === 20 || size === 30 || size === 5 || size === 100 || size === 50;
				return { h: bytes(free ? Math.floor(rand() * 200) : size) };
			});
			cases.push({ fn, args: next });
			index.push(fn);
		}
	}
	return { cases, index };
}
