import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PhpBase } from 'php-wasm/PhpBase';
// `.ts` rather than this repo's usual `.js` specifier, because this one runs under node as well as
// bun and node resolves the extension it is given
import { summarise, type Summary } from './bench.ts';
import { emitTunedGlue, glueFor, stepFor, tunedGlueFor, type Abi } from './growth-glue.ts';

/**
 * What each pointer/integer ABI costs in CPU. Interpreter time only -- no host bridge, no SQLite,
 * no fill chain -- so quote it as local wall clock and as a RATIO, never as an edge cost.
 *
 * RULE 0 reserves an absolute from a deployed worker because the isolate freezes its clock. That is
 * a rule about the PLATFORM; an ABI cost is a property of the BINARY, and the edge is the worse
 * place to read one: it is bimodal by 400-600 ms where this effect is a few percent.
 *
 * `node` by default, because workerd is V8 and no other local lane shares that. `bun` runs the same
 * script on JavaScriptCore, so agreement across the two is what makes a ratio a property of the
 * binary; bun cannot measure wasm64 at all, since JSC refuses `Memory64`.
 *
 * **Run `--abis=wasm32,wasm32` before believing any figure.** One binary as two arms is 1.000x by
 * construction, so what it prints instead is the resolution -- measured, 0.5% blended and 1-3% per
 * case, which is larger than several differences between real ABIs. Read the blended geometric mean;
 * a single case moving is not a finding.
 *
 * Arms are timed interleaved, rotating which leads each round. Measured in series, the same three
 * binaries reported long64 1.5% faster, and that was the machine. Each arm runs its own shipping
 * glue ({@link stepFor}), warmed up first so its one growth event and the engine's tiering are paid.
 *
 * ```sh
 * node scripts/measure/abi-speed.ts --n=25
 * node scripts/measure/abi-speed.ts --abis=wasm32,wasm32 --n=25
 * ```
 */

/** one PHP case, sized to land in the low hundreds of milliseconds under wasm */
type Case = {
	name: string;
	/** the mechanism it isolates, printed beside the ratio so a reading is not read blind */
	probes: string;
	/** run once per instance; declarations belong here, since a redeclare fatals from pass two on */
	setup?: string;
	php: string;
};

export const CASES: Case[] = [
	// every accumulator is masked to 30 bits. Unmasked, a sum overflows PHP_INT_MAX on the 4-byte arm
	// and silently promotes to float, so the arms would be running different arithmetic
	{
		name: 'intmath',
		probes: 'zend_long arithmetic',
		php: `$s = 0; for ($i = 0; $i < 3000000; $i++) { $s = ($s + (($i * 3) ^ ($i >> 2))) & 0x3fffffff; }
			return $s;`
	},
	{
		name: 'floatmath',
		probes: 'zend_double, unchanged by either ABI',
		php: `$s = 0.0; for ($i = 1; $i < 1500000; $i++) { $s += sqrt($i) * 1.000001; }
			return (int) ($s / 1000);`
	},
	{
		name: 'hashwrite',
		probes: 'Bucket insert, 24 -> 32 bytes',
		php: `$a = []; for ($i = 0; $i < 400000; $i++) { $a['k' . $i] = $i; } return count($a);`
	},
	{
		name: 'hashread',
		probes: 'Bucket lookup over a built table',
		setup: `$GLOBALS['bench_keys'] = []; for ($i = 0; $i < 200000; $i++) { $GLOBALS['bench_keys']['k' . $i] = $i; }`,
		php: `$a = $GLOBALS['bench_keys']; $s = 0;
			for ($r = 0; $r < 3; $r++) {
				for ($i = 0; $i < 200000; $i++) { $s = ($s + $a['k' . $i]) & 0x3fffffff; }
			}
			return $s;`
	},
	{
		name: 'packed',
		probes: 'packed array, zval only, no Bucket',
		php: `$a = []; for ($i = 0; $i < 1000000; $i++) { $a[] = $i; }
			$s = 0; foreach ($a as $v) { $s = ($s + $v) & 0x3fffffff; } return $s;`
	},
	{
		name: 'strings',
		probes: 'zend_string, which carries a zend_ulong h',
		php: `$s = 0; for ($i = 0; $i < 300000; $i++) { $t = 'row-' . $i . '-value';
			$s += strlen($t) + (strpos($t, 'value') ?: 0); } return $s;`
	},
	{
		name: 'usercall',
		probes: 'VM dispatch and stack frames',
		setup: `function bench_add(int $x, int $y): int { return ($x + $y) & 0x3fffffff; }`,
		php: `$s = 0; for ($i = 0; $i < 1500000; $i++) { $s = bench_add($s, $i); } return $s;`
	},
	{
		name: 'objects',
		probes: 'property table lookup',
		setup: `class BenchPoint { public int $x = 0; public int $y = 0;
			public function move(int $d): void { $this->x += $d; $this->y -= $d; } }`,
		php: `$p = new BenchPoint(); for ($i = 0; $i < 1000000; $i++) { $p->move($i & 7); }
			return $p->x - $p->y;`
	},
	{
		name: 'sort',
		probes: 'Bucket movement under zend_sort',
		// Schrage's method, whose intermediates provably stay under 2^31-1: a plain LCG overflows to
		// float on the 4-byte arm and the arms would then be sorting different arrays
		setup: `$GLOBALS['bench_sort'] = []; $x = 123456789;
			for ($i = 0; $i < 150000; $i++) {
				$hi = intdiv($x, 127773); $lo = $x % 127773;
				$x = 16807 * $lo - 2836 * $hi; if ($x <= 0) { $x += 2147483647; }
				$GLOBALS['bench_sort'][] = $x;
			}`,
		php: `$a = $GLOBALS['bench_sort']; sort($a); return $a[0] + count($a);`
	},
	{
		name: 'json',
		probes: 'a mixed real-world shape',
		setup: `$GLOBALS['bench_rows'] = []; for ($i = 0; $i < 20000; $i++) {
			$GLOBALS['bench_rows'][] = ['id' => $i, 'title' => 'node ' . $i, 'tags' => ['a', 'b'], 'w' => $i / 7]; }`,
		php: `$rows = $GLOBALS['bench_rows']; $j = json_encode($rows);
			return count(json_decode($j, true)) + strlen($j);`
	},
	{
		name: 'preg',
		probes: 'pcre, which the render path leans on',
		setup: `$GLOBALS['bench_subject'] = str_repeat('a-b_c 123 /path/to/x?q=1 ', 40);`,
		php: `$s = 0; $subject = $GLOBALS['bench_subject'];
			for ($i = 0; $i < 3000; $i++) { $s += preg_match_all('#([a-z]+)[-_/]([a-z0-9]+)#', $subject, $m); }
			return $s;`
	}
];

/** the trivial script that proves an instance is up; the boot arm is timed to its resolution */
const READY = `<?php echo PHP_INT_SIZE;`;

const ABI_WASM: Record<string, string> = {
	wasm32: '.interp/php8.5-wasm32.wasm',
	long64: '.interp/php8.5-long64.wasm',
	wasm64: '.interp/php8.5-wasm64.wasm'
};

export type Arm = {
	abi: Exclude<Abi, null>;
	/** what the table calls it; a repeated ABI is the self-control and gets a `#n` suffix */
	label: string;
	wasm: string;
	glue: string;
	step: number;
	bytes: number;
	intSize: number;
	version: string;
	compile: Summary;
	boot: Summary;
	cases: Record<string, Summary>;
};

/** emscripten's worker glue reads `self.location`, which bun has no reason to define */
function shimWorkerGlobals(): void {
	const g = globalThis as Record<string, unknown>;
	g.location ??= new URL(pathToFileURL(process.cwd() + '/').href);
	g.self ??= globalThis;
}

async function makePhp(wasm: WebAssembly.Module, glue: string) {
	const { default: PHPFactory } = (await import(pathToFileURL(glue).href)) as {
		default: unknown;
	};
	const out: string[] = [];
	const php = new PhpBase(
		Promise.resolve({ default: PHPFactory }) as never,
		{
			ini: ['opcache.enable=0', 'opcache.enable_cli=0', 'memory_limit=256M'].join('\n'),
			printErr: () => {},
			onAbort: (what: unknown) => out.push(`abort: ${String(what)}`),
			instantiateWasm(
				imports: WebAssembly.Imports,
				receive: (i: WebAssembly.Instance, m: WebAssembly.Module) => void
			) {
				WebAssembly.instantiate(wasm, imports).then((i) => receive(i, wasm));
				return {};
			}
		} as never
	) as PhpBase & { _run(code: string): Promise<unknown>; binary: Promise<unknown> };
	php.addEventListener('output', (e) => out.push(String((e as CustomEvent).detail)));
	return { php, out };
}

/** an arm made ready to time: its module compiled, one warm instance, setups run, cases verified */
type Prepared = {
	abi: Exclude<Abi, null>;
	label: string;
	wasm: string;
	glue: string;
	step: number;
	bytes: number;
	intSize: number;
	version: string;
	module: WebAssembly.Module;
	php: { _run(code: string): Promise<unknown>; binary: Promise<unknown> };
	samples: { compile: number[]; boot: number[]; cases: Record<string, number[]> };
};

async function prepare(abi: Exclude<Abi, null>, label: string): Promise<Prepared> {
	const wasmPath = ABI_WASM[abi];
	if (!wasmPath || !existsSync(wasmPath)) throw new Error(`no binary for ${abi} at ${wasmPath}`);
	if (!existsSync(glueFor(abi))) throw new Error(`no glue for ${abi} at ${glueFor(abi)}`);
	const glue = tunedGlueFor(abi);
	if (!existsSync(glue)) emitTunedGlue(process.cwd(), abi);
	// read back rather than stepFor(): the wasm64 glue arrives already carrying its own step
	const step = Number(
		/oldSize\*\(1\+([0-9.]+)\/cutDown\)/.exec(readFileSync(glue, 'utf8'))?.[1] ?? NaN
	);
	if (step !== stepFor(abi)) {
		process.stderr.write(`  ${abi} glue carries step ${step}, stepFor says ${stepFor(abi)}\n`);
	}

	const bytes = readFileSync(wasmPath);
	const module = await WebAssembly.compile(bytes);
	const { php, out } = await makePhp(module, glue);
	await php.binary;
	out.length = 0;
	await php._run(`<?php echo PHP_INT_SIZE . ' ' . PHP_VERSION;`);
	const [size, version] = out.join('').trim().split(' ');

	for (const c of CASES) if (c.setup) await php._run(`<?php ${c.setup}`);

	// echo each result once: with stderr suppressed a fatal otherwise reads as an impossibly fast case
	for (const c of CASES) {
		out.length = 0;
		await php._run(`<?php echo (int) (function () { ${c.php} })();`);
		const answer = out.join('').trim();
		if (!/^-?\d+$/.test(answer) || answer === '0') {
			throw new Error(`case ${c.name} on ${abi} produced ${JSON.stringify(answer)}`);
		}
	}

	return {
		abi,
		label,
		wasm: wasmPath,
		glue,
		step,
		bytes: bytes.byteLength,
		intSize: Number(size),
		version: version ?? '',
		module,
		php,
		samples: {
			compile: [],
			boot: [],
			cases: Object.fromEntries(CASES.map((c) => [c.name, []]))
		}
	};
}

/** one sample per arm per round, rotating the leader; in series, drift reads as an ABI effect */
async function timeAll(arms: Prepared[], n: number): Promise<void> {
	const bodies = new Map(CASES.map((c) => [c.name, `<?php (function () { ${c.php} })();`]));
	for (let round = 0; round < n; round++) {
		for (let i = 0; i < arms.length; i++) {
			const arm = arms[(round + i) % arms.length] as Prepared;
			for (const c of CASES) {
				const code = bodies.get(c.name) as string;
				const t0 = performance.now();
				await arm.php._run(code);
				(arm.samples.cases[c.name] as number[]).push(performance.now() - t0);
			}
		}
	}

	// separate pass: a boot allocates ~100 MB, and interleaved its GC lands on whichever arm is next
	for (let round = 0; round < n; round++) {
		for (let i = 0; i < arms.length; i++) {
			const arm = arms[(round + i) % arms.length] as Prepared;

			const t0 = performance.now();
			await WebAssembly.compile(readFileSync(arm.wasm));
			arm.samples.compile.push(performance.now() - t0);

			const t1 = performance.now();
			const { php } = await makePhp(arm.module, arm.glue);
			await php.binary;
			await php._run(READY);
			arm.samples.boot.push(performance.now() - t1);
		}
	}
}

function finish(p: Prepared): Arm {
	const need = (values: number[], what: string) => {
		const s = summarise(values);
		if (!s) throw new Error(`${p.abi} ${what}: n=${values.length} is below the floor`);
		return s;
	};
	return {
		abi: p.abi,
		label: p.label,
		wasm: p.wasm,
		glue: p.glue,
		step: p.step,
		bytes: p.bytes,
		intSize: p.intSize,
		version: p.version,
		compile: need(p.samples.compile, 'compile'),
		boot: need(p.samples.boot, 'boot'),
		cases: Object.fromEntries(
			CASES.map((c) => [c.name, need(p.samples.cases[c.name] as number[], c.name)])
		)
	};
}

const fmt = (s: Summary) => `${s.median.toFixed(1)} (${s.min.toFixed(1)}-${s.max.toFixed(1)})`;
const ratio = (arm: Summary, base: Summary) => arm.median / base.median;

/** which wasm engine produced the numbers; workerd is V8, so a bun run is the cross-engine control */
function engine(): string {
	const bun = (globalThis as { Bun?: { version: string } }).Bun;
	if (bun) return `bun ${bun.version} (JavaScriptCore)`;
	const v8 = process.versions?.v8;
	return v8 ? `node ${process.versions.node} (V8 ${v8})` : 'an unidentified engine';
}

export function report(arms: Arm[]): string {
	// the FIRST arm is the baseline, so `--abis=wasm32,wasm32` reads as the self-control it is
	const base = arms[0];
	if (!base) throw new Error('no arms');
	const others = arms.slice(1);
	const lines: string[] = [];

	lines.push('| arm | PHP_INT_SIZE | growth step | raw bytes | binary |');
	lines.push('| --- | --- | --- | --- | --- |');
	for (const a of arms) {
		lines.push(
			`| ${a.label} | ${a.intSize} | ${a.step} | ${a.bytes.toLocaleString('en-US')} | ${a.wasm} (PHP ${a.version}) |`
		);
	}

	lines.push('');
	lines.push(
		`| case | probes | ${arms.map((a) => a.label).join(' | ')} | ${others
			.map((a) => `${a.label} / ${base.label}`)
			.join(' | ')} |`
	);
	lines.push(
		`| --- | --- | ${arms.map(() => '---').join(' | ')} | ${others.map(() => '---').join(' | ')} |`
	);

	const row = (name: string, probes: string, pick: (a: Arm) => Summary) => {
		const cells = arms.map((a) => fmt(pick(a)));
		const ratios = others.map((a) => `${ratio(pick(a), pick(base)).toFixed(3)}x`);
		lines.push(`| ${name} | ${probes} | ${cells.join(' | ')} | ${ratios.join(' | ')} |`);
	};

	row('compile', 'WebAssembly.compile of the module', (a) => a.compile);
	row('boot', 'instantiate to first run', (a) => a.boot);
	for (const c of CASES) row(c.name, c.probes, (a) => a.cases[c.name] as Summary);

	// the geometric mean over the cases, so no single long case decides the headline
	const blended = others.map((a) => {
		const logs = CASES.map((c) =>
			Math.log(ratio(a.cases[c.name] as Summary, base.cases[c.name] as Summary))
		);
		return Math.exp(logs.reduce((x, y) => x + y, 0) / logs.length);
	});
	lines.push(
		`| **blended** | geometric mean of the cases | ${arms.map(() => '').join(' | ')} | ${blended
			.map((b) => `**${b.toFixed(3)}x**`)
			.join(' | ')} |`
	);

	lines.push('');
	lines.push(
		`n=${base.boot.n} interleaved rounds, median with (min-max), on ${engine()}. Local wall clock, ` +
			'interpreter only; not an edge cpuTime and not comparable to one.'
	);
	return lines.join('\n');
}

if (import.meta.main) {
	// annotated: `@cloudflare/workers-types` degrades `process` to any, so the callback loses inference
	const args: string[] = process.argv.slice(2);
	const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
	const n = Number(arg('n') ?? 7);
	const abis = (arg('abis') ?? 'wasm32,long64,wasm64').split(',') as Exclude<Abi, null>[];

	shimWorkerGlobals();
	const seen = new Map<string, number>();
	const prepared: Prepared[] = [];
	for (const abi of abis) {
		const nth = (seen.get(abi) ?? 0) + 1;
		seen.set(abi, nth);
		// a repeated ABI is the self-control; its ratio is 1.000x by construction
		const label = abis.filter((a) => a === abi).length > 1 ? `${abi}#${nth}` : abi;
		process.stderr.write(`preparing ${label} ...\n`);
		prepared.push(await prepare(abi, label));
	}
	process.stderr.write(`timing ${n} interleaved rounds ...\n`);
	await timeAll(prepared, n);
	const arms = prepared.map(finish);
	console.log(report(arms));
	console.log(`\n<!-- ${JSON.stringify(arms)} -->`);
}
