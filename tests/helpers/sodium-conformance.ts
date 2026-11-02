import { SODIUM_API } from '../../src/site/generated/sodium-api';
import { SODIUM_FIX, sodiumConstantsPhp } from '../../src/site/shims/sodium-fix';
import { agree, battery, flows, fuzz, hex, SETUP } from './sodium-cases';
import { nativePhp, runBatch, type Arg, type Case, type Outcome } from './sodium-harness';

/** constants whose value is the native library's own version, which a shim cannot match by itself */
export const VERSION_CONSTANTS = new Set([
	'SODIUM_LIBRARY_VERSION',
	'SODIUM_LIBRARY_MAJOR_VERSION',
	'SODIUM_LIBRARY_MINOR_VERSION'
]);

/** what one function did across the whole battery */
export type FunctionResult = { cases: number; failures: string[] };

/** the result of a full conformance run */
export type Conformance = {
	functions: Record<string, FunctionResult>;
	constants: string[];
	classes: string[];
	cases: number;
};

const U = (use: string, off?: number, len?: number): Arg =>
	off === undefined ? { use } : { use, off, len };
const H = (n: number, m = 1, a = 7): Arg => ({ h: hex(n, m, a) });

/** a produce step that runs on one side and a consume step that runs on the other */
type Cross = { fn: string; produce: Case[]; consume: Case[]; expect?: (string | undefined)[] };

const SS = 'sodium_crypto_secretstream_xchacha20poly1305';

const MSG = hex(40, 3, 5);

/** outputs one side makes and the other must accept */
export function crosses(): Cross[] {
	const kp = (name: string) => `x_${name}`;
	return [
		{
			fn: 'sodium_crypto_box_seal',
			produce: [
				{ fn: 'sodium_crypto_box_seal', args: [{ h: MSG }, U('bpkA')], store: 'sealed' }
			],
			consume: [{ fn: 'sodium_crypto_box_seal_open', args: [U('sealed'), U('bkpA')] }],
			expect: [MSG]
		},
		{
			fn: 'sodium_crypto_pwhash_str',
			produce: [
				{
					fn: 'sodium_crypto_pwhash_str',
					args: [{ h: MSG }, { i: 1 }, { i: 8192 }],
					store: 'ph1'
				},
				{
					fn: 'sodium_crypto_pwhash_str',
					args: [{ h: MSG }, { i: 2 }, { i: 65536 }],
					store: 'ph2'
				}
			],
			consume: [
				{ fn: 'sodium_crypto_pwhash_str_verify', args: [U('ph1'), { h: MSG }] },
				{ fn: 'sodium_crypto_pwhash_str_verify', args: [U('ph1'), H(8)] },
				{ fn: 'sodium_crypto_pwhash_str_verify', args: [U('ph2'), { h: MSG }] },
				{
					fn: 'sodium_crypto_pwhash_str_needs_rehash',
					args: [U('ph2'), { i: 2 }, { i: 65536 }]
				},
				{
					fn: 'sodium_crypto_pwhash_str_needs_rehash',
					args: [U('ph2'), { i: 3 }, { i: 65536 }]
				},
				{
					fn: 'sodium_crypto_pwhash_str_needs_rehash',
					args: [U('ph1'), { i: 1 }, { i: 8192 }]
				}
			]
		},
		{
			fn: 'sodium_crypto_pwhash_scryptsalsa208sha256_str',
			produce: [
				{
					fn: 'sodium_crypto_pwhash_scryptsalsa208sha256_str',
					args: [{ h: MSG }, { i: 524288 }, { i: 16777216 }],
					store: 'sc1'
				}
			],
			consume: [
				{
					fn: 'sodium_crypto_pwhash_scryptsalsa208sha256_str_verify',
					args: [U('sc1'), { h: MSG }]
				},
				{
					fn: 'sodium_crypto_pwhash_scryptsalsa208sha256_str_verify',
					args: [U('sc1'), H(8)]
				}
			]
		},
		{
			fn: 'sodium_crypto_box_keypair',
			produce: [{ fn: 'sodium_crypto_box_keypair', args: [], store: kp('box') }],
			consume: [
				{
					fn: 'sodium_crypto_scalarmult_base',
					args: [U(kp('box'), 0, 32)],
					store: 'derived'
				},
				{ fn: 'sodium_crypto_box_publickey', args: [U(kp('box'))] }
			]
		},
		{
			fn: 'sodium_crypto_kx_keypair',
			produce: [{ fn: 'sodium_crypto_kx_keypair', args: [], store: kp('kx') }],
			consume: [
				{ fn: 'sodium_crypto_scalarmult_base', args: [U(kp('kx'), 0, 32)] },
				{ fn: 'sodium_crypto_kx_publickey', args: [U(kp('kx'))] }
			]
		},
		{
			fn: 'sodium_crypto_sign_keypair',
			produce: [{ fn: 'sodium_crypto_sign_keypair', args: [], store: kp('sign') }],
			consume: [
				{ fn: 'sodium_crypto_sign_seed_keypair', args: [U(kp('sign'), 0, 32)] },
				{
					fn: 'sodium_crypto_sign_keypair_from_secretkey_and_publickey',
					args: [U(kp('sign'), 0, 64), U(kp('sign'), 64, 32)]
				}
			]
		},
		{
			fn: 'sodium_crypto_core_ristretto255_random',
			produce: [{ fn: 'sodium_crypto_core_ristretto255_random', args: [], store: 'rr' }],
			consume: [{ fn: 'sodium_crypto_core_ristretto255_is_valid_point', args: [U('rr')] }]
		},
		{
			fn: 'sodium_crypto_core_ristretto255_scalar_random',
			produce: [
				{ fn: 'sodium_crypto_core_ristretto255_scalar_random', args: [], store: 'rsr' }
			],
			consume: [
				{
					fn: 'sodium_crypto_core_ristretto255_scalar_add',
					args: [U('rsr'), { h: '00'.repeat(32) }]
				},
				{
					fn: 'sodium_crypto_core_ristretto255_scalar_mul',
					args: [U('rsr'), { h: '01' + '00'.repeat(31) }]
				}
			]
		},
		{
			fn: `${SS}_init_push`,
			produce: [
				{ fn: `${SS}_init_push`, args: [H(32, 5, 1)], store: 'sp', split: true },
				{
					fn: `${SS}_push`,
					args: [{ ref: 'sp0' }, { h: MSG }, H(3), { i: 0 }],
					store: 'sc0'
				},
				{
					fn: `${SS}_push`,
					args: [{ ref: 'sp0' }, { h: MSG }, H(3), { i: 3 }],
					store: 'sc1'
				}
			],
			consume: [
				{ fn: `${SS}_init_pull`, args: [U('sp1'), H(32, 5, 1)], store: 'sq' },
				{ fn: `${SS}_pull`, args: [{ ref: 'sq' }, U('sc0'), H(3)] },
				{ fn: `${SS}_pull`, args: [{ ref: 'sq' }, U('sc1'), H(3)] }
			]
		}
	];
}

/** produce on one side, consume on the other, both ways; every consume must read the same */
async function runCrosses(): Promise<Record<string, string[]>> {
	const failures: Record<string, string[]> = {};
	const setup = SETUP;
	for (const x of crosses()) {
		const produce = [...setup, ...x.produce];
		const [n, s] = await Promise.all([runBatch('native', produce), runBatch('shim', produce)]);
		const consume = [...setup, ...x.consume];
		const [onShim, onNative] = await Promise.all([
			runBatch('shim', consume, n.vars),
			runBatch('native', consume, s.vars)
		]);
		// the same consume over each side's own product is the control for what it should read
		const [selfNative, selfShim] = await Promise.all([
			runBatch('native', consume, n.vars),
			runBatch('shim', consume, s.vars)
		]);
		const from = setup.length;
		x.consume.forEach((c, i) => {
			const at = from + i;
			// each consumer reading a product must read what the producer's own side reads
			const pairs: [Outcome, Outcome][] = [
				[onShim.out[at]!, selfNative.out[at]!],
				[onNative.out[at]!, selfShim.out[at]!]
			];
			if (!pairs.every(([a, b]) => JSON.stringify(a) === JSON.stringify(b))) {
				(failures[x.fn] ??= []).push(`${c.fn}: ${JSON.stringify(pairs)}`.slice(0, 600));
			}
		});
		if (x.expect) {
			x.expect.forEach((want, i) => {
				for (const o of [onShim.out[from + i]!, onNative.out[from + i]!]) {
					const got = o.ret && 's' in o.ret ? o.ret.s : undefined;
					if (got !== want) (failures[x.fn] ??= []).push(`expected ${want}, read ${got}`);
				}
			});
		}
	}
	return failures;
}

const phpConstants = (): Map<string, string> => {
	const out = new Map<string, string>();
	for (const line of sodiumConstantsPhp().split('\n')) {
		const m = /define\('([A-Z0-9_]+)', (.*)\); \}$/.exec(line.trim());
		if (m) out.set(m[1]!, m[2]!);
	}
	return out;
};

const literal = (v: string | number): string =>
	typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : String(v);

/** runs everything and says which names of the inventory pass */
export async function runConformance(): Promise<Conformance> {
	if (!nativePhp()) throw new Error('no native php with the full ext-sodium inventory');
	const functions: Record<string, FunctionResult> = Object.fromEntries(
		SODIUM_API.functions.map((f) => [f.name, { cases: 0, failures: [] }])
	);
	let total = 0;
	const stages: [string, { cases: Case[]; index: string[] }][] = [
		['battery', battery()],
		['flows', flows()],
		['fuzz', fuzz(30)]
	];
	for (const [stage, b] of stages) {
		const setup = stage === 'battery' ? [] : SETUP;
		const cases = [...setup, ...b.cases];
		const [n, s] = await Promise.all([runBatch('native', cases), runBatch('shim', cases)]);
		b.cases.forEach((c, i) => {
			const at = setup.length + i;
			const fn = c.fn;
			const slot = functions[fn] ?? functions[b.index[i]!];
			total++;
			if (!slot) return;
			slot.cases++;
			if (!agree(fn, n.out[at]!, s.out[at]!)) {
				slot.failures.push(
					`${stage}#${i} ${JSON.stringify(c.args).slice(0, 120)} native ${JSON.stringify(n.out[at]).slice(0, 160)} shim ${JSON.stringify(s.out[at]).slice(0, 160)}`
				);
			}
		});
	}
	for (const [fn, why] of Object.entries(await runCrosses())) {
		total += why.length;
		functions[fn]?.failures.push(...why.map((w) => `cross ${w}`));
		if (functions[fn]) functions[fn]!.cases += 1;
	}
	const defined = phpConstants();
	const constants = Object.entries(SODIUM_API.constants)
		.filter(([name, v]) => defined.get(name) === literal(v))
		.map(([name]) => name);
	const classes = SODIUM_API.classes.filter((c) =>
		new RegExp(`class ${c} extends Exception`).test(SODIUM_FIX)
	);
	return { functions, constants, classes, cases: total };
}

/** the manifest: the names that pass and ran at least one case */
export function manifestOf(r: Conformance): {
	functions: string[];
	constants: string[];
	classes: string[];
} {
	return {
		functions: Object.entries(r.functions)
			.filter(([, f]) => f.cases > 0 && f.failures.length === 0)
			.map(([name]) => name)
			.sort(),
		constants: [...r.constants].sort(),
		classes: [...r.classes].sort()
	};
}
