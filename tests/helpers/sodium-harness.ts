import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SODIUM_API } from '../../src/site/generated/sodium-api';
import { SODIUM_FIX } from '../../src/site/shims/sodium-fix';
import { sodiumHostCall } from '../../src/site/shims/sodium-lib';

/** one argument of a case; bytes travel as hex */
export type Arg =
	| { h: string }
	| { i: number | string }
	| { f: number }
	| { b: boolean }
	| { n: 1 }
	| { arr: 1 }
	| { use: string; at?: number; off?: number; len?: number }
	| { ref: string }
	| { rh: string };

/** one call and what to keep of it */
export type Case = {
	fn: string;
	args: Arg[];
	/** stores the return value under this name for later cases */
	store?: string;
	/** a stored variable to also store the first array element of, as `${store}0` and `${store}1` */
	split?: boolean;
};

/** an encoded PHP value */
export type Enc =
	{ s: string } | { b: boolean } | { i: number } | { n: 1 } | { l: Enc[] } | { o: string };

/** what one case produced */
export type Outcome = {
	ex?: [string, string];
	ret?: Enc;
	refs?: (Enc | null)[];
};

/** PHP that runs a case list and prints the outcomes; shared by both sides */
const DRIVER = String.raw`
function cfw_enc($v) {
	if (is_string($v)) { return ['s' => bin2hex($v)]; }
	if (is_bool($v)) { return ['b' => $v]; }
	if (is_int($v)) { return ['i' => $v]; }
	if ($v === null) { return ['n' => 1]; }
	if (is_array($v)) { return ['l' => array_map('cfw_enc', $v)]; }
	return ['o' => get_debug_type($v)];
}
set_error_handler(static function () { return true; });
$cases = json_decode(file_get_contents($argv[1]), true);
$vars = [];
foreach (json_decode($argv[2] ?? '{}', true) as $k => $h) { $vars[$k] = hex2bin($h); }
$out = [];
foreach ($cases as $c) {
	$args = [];
	$refArgs = [];
	foreach ($c['args'] as $k => $a) {
		if (isset($a['h'])) { $args[$k] = hex2bin($a['h']); }
		elseif (array_key_exists('i', $a)) { $args[$k] = is_string($a['i']) ? (int) $a['i'] : $a['i']; }
		elseif (array_key_exists('f', $a)) { $args[$k] = (float) $a['f']; }
		elseif (array_key_exists('b', $a)) { $args[$k] = (bool) $a['b']; }
		elseif (array_key_exists('n', $a)) { $args[$k] = null; }
		elseif (array_key_exists('arr', $a)) { $args[$k] = []; }
		elseif (isset($a['use'])) { $v = $vars[$a['use']] ?? null; $args[$k] = isset($a['at']) ? $v[$a['at']] : (isset($a['off']) ? substr($v, $a['off'], $a['len']) : $v); }
		elseif (isset($a['ref'])) { if (!array_key_exists($a['ref'], $vars)) { $vars[$a['ref']] = null; } $args[$k] = &$vars[$a['ref']]; $refArgs[$k] = $a['ref']; }
		elseif (isset($a['rh'])) { $tmp[$k] = hex2bin($a['rh']); $args[$k] = &$tmp[$k]; $refArgs[$k] = null; }
	}
	$o = [];
	try {
		$r = call_user_func_array($c['fn'], $args);
		$o['ret'] = cfw_enc($r);
		if (isset($c['store'])) {
			$vars[$c['store']] = $r;
			if (!empty($c['split']) && is_array($r)) { foreach ($r as $i => $part) { $vars[$c['store'] . $i] = $part; } }
		}
	} catch (Throwable $e) {
		$o['ex'] = [get_class($e), $e->getMessage()];
	}
	if ($refArgs) {
		$o['refs'] = [];
		foreach ($refArgs as $k => $name) { $o['refs'][] = cfw_enc($args[$k]); }
	}
	$out[] = $o;
}
$kept = [];
foreach ($vars as $k => $v) { if (is_string($v)) { $kept[$k] = bin2hex($v); } }
echo json_encode(['out' => $out, 'vars' => $kept]);
`;

const PRELUDE = String.raw`
function vrzno_env($name) {
	if ($name !== 'cfwSodium') { return null; }
	return static function ($json) {
		fwrite(STDERR, $json . "\n");
		return rtrim((string) fgets(STDIN), "\n");
	};
}
`;

/** the php to use as the oracle, or undefined when there is none with the full inventory */
export function nativePhp(): string | undefined {
	const probe = spawnSync(
		'php',
		[
			'-n',
			'-r',
			'echo extension_loaded("sodium") ? json_encode(get_extension_funcs("sodium")) : "no";'
		],
		{ encoding: 'utf8' }
	);
	if (probe.status !== 0 || !probe.stdout.startsWith('[')) return undefined;
	const have = new Set(JSON.parse(probe.stdout) as string[]);
	return SODIUM_API.functions.every((f) => have.has(f.name)) ? 'php' : undefined;
}

const dir = mkdtempSync(join(tmpdir(), 'cfw-sodium-'));
let counter = 0;

/** runs a batch on the native extension or on the shim over the real host library */
export async function runBatch(
	side: 'native' | 'shim',
	cases: Case[],
	init: Record<string, string> = {}
): Promise<{ out: Outcome[]; vars: Record<string, string> }> {
	const id = counter++;
	const casesFile = join(dir, `cases-${id}.json`);
	const script = join(dir, `run-${id}.php`);
	writeFileSync(casesFile, JSON.stringify(cases));
	const names = SODIUM_API.functions.map((f) => f.name);
	let args: string[];
	if (side === 'native') {
		writeFileSync(script, `<?php ${DRIVER}`);
		args = ['-n', '-d', 'display_errors=0', '-d', 'memory_limit=1G', script, casesFile];
	} else {
		const shim = join(dir, `shim-${id}.php`);
		writeFileSync(shim, `<?php ${PRELUDE}\n${SODIUM_FIX}\n`);
		writeFileSync(script, `<?php require ${JSON.stringify(shim)};\n${DRIVER}`);
		args = [
			'-n',
			'-d',
			`disable_functions=${names.join(',')}`,
			'-d',
			'display_errors=0',
			'-d',
			'memory_limit=1G',
			script,
			casesFile
		];
	}
	args.push(JSON.stringify(init));
	return await new Promise((resolve, reject) => {
		const child = spawn('php', args, { stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let pending = '';
		let noise = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (d: string) => (stdout += d));
		child.stderr.on('data', (d: string) => {
			pending += d;
			let at: number;
			while ((at = pending.indexOf('\n')) >= 0) {
				const line = pending.slice(0, at);
				pending = pending.slice(at + 1);
				if (!(side === 'shim' && line.startsWith('{'))) noise += line.slice(0, 300) + '\n';
				if (side === 'shim' && line.startsWith('{')) {
					if (process.env.SODIUM_TRACE) writeFileSync('/tmp/sod/last.txt', line);
					const t0 = Date.now();
					const reply = sodiumHostCall(JSON.parse(line));
					if (process.env.SODIUM_TRACE && Date.now() - t0 > 500) {
						console.error(`slow ${Date.now() - t0} ms: ${line.slice(0, 160)}`);
					}
					child.stdin.write(JSON.stringify(reply) + '\n');
				}
			}
		});
		child.on('error', reject);
		child.on('close', (code, signal) => {
			try {
				resolve(JSON.parse(stdout));
			} catch {
				reject(
					new Error(
						`no result from the ${side} run (exit ${code} ${signal}): ${stdout.slice(0, 400)} ${noise.slice(0, 600)}`
					)
				);
			}
		});
	});
}

/** the shim's own reflection of every function, read in a process that loaded only the fragment */
export function shimReflection(): Record<
	string,
	{ name: string; ref: boolean; opt: boolean; def?: unknown; sensitive: boolean }[]
> {
	const names = SODIUM_API.functions.map((f) => f.name);
	const shim = join(dir, 'reflect-shim.php');
	const script = join(dir, 'reflect.php');
	writeFileSync(shim, `<?php ${PRELUDE}\n${SODIUM_FIX}\n`);
	writeFileSync(
		script,
		`<?php require ${JSON.stringify(shim)};
$out = [];
foreach (${JSON.stringify(names)} as $n) {
	$rows = [];
	foreach ((new ReflectionFunction($n))->getParameters() as $p) {
		$row = ['name' => $p->getName(), 'ref' => $p->isPassedByReference(), 'opt' => $p->isOptional(),
			'sensitive' => count($p->getAttributes(SensitiveParameter::class)) > 0];
		if ($p->isOptional()) { $row['def'] = $p->getDefaultValue(); }
		$rows[] = $row;
	}
	$out[$n] = $rows;
}
echo json_encode($out);`
	);
	const run = spawnSync(
		'php',
		['-n', '-d', `disable_functions=${names.join(',')}`, '-d', 'display_errors=0', script],
		{ encoding: 'utf8' }
	);
	return JSON.parse(run.stdout);
}
