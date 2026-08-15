#!/usr/bin/env node
/**
 * Paired A/B of two build variants: boots BOTH under wrangler dev and alternates
 * A,B,A,B,... so machine drift hits both arms equally. Reports each arm's median
 * and the ratio; the ratio is the only number that means anything, because these
 * are local wrangler-dev figures, not edge cpuTime.
 *
 * Interleaving rather than running one variant then the other is what makes it comparable.
 * FINDINGS records a false regression alarm caused by comparing runs taken under
 * different machine load, so the two arms must be sampled in the same minutes.
 *
 * usage: bun scripts/bench/bench-ab.mjs <variantA> <variantB> [runs] [n] [portA]
 *   bun scripts/bench/bench-ab.mjs o2 jspimb 7 200000
 */
import { execFileSync, spawn } from 'node:child_process';

const [a, b] = [process.argv[2], process.argv[3]];
if (!a || !b) {
	console.error('usage: bun scripts/bench/bench-ab.mjs <variantA> <variantB> [runs] [n] [portA]');
	process.exit(1);
}
const runs = Number(process.argv[4] ?? 7);
const n = Number(process.argv[5] ?? 200000);
const portA = Number(process.argv[6] ?? 8810);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
	const s = [...xs].sort((x, y) => x - y);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function boot(variant, port) {
	const p = spawn(
		'bunx',
		[
			'wrangler',
			'dev',
			'-c',
			`experiments/wrangler/wrangler.probe-${variant}.jsonc`,
			'--port',
			String(port),
			'--inspector-port',
			String(port + 50)
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	);
	let log = '';
	p.stdout.on('data', (d) => (log += d));
	p.stderr.on('data', (d) => (log += d));
	return { proc: p, port, variant, log: () => log };
}

async function ready(arm, timeoutMs = 240000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		try {
			const r = await fetch(`http://127.0.0.1:${arm.port}/boot`);
			if (r.ok) return await r.json();
		} catch {
			// not listening yet
		}
		await sleep(1000);
	}
	throw new Error(`${arm.variant} never became ready:\n${arm.log().slice(-2000)}`);
}

function gzTotal(dir) {
	try {
		const out = execFileSync('bash', [
			'-c',
			`for f in vendor/${dir}/*.wasm vendor/${dir}/*worker.mjs; do gzip -9 -c "$f" | wc -c; done`
		])
			.toString()
			.trim()
			.split('\n')
			.map((x) => Number(x.trim()));
		return out.reduce((s, x) => s + x, 0);
	} catch {
		return null;
	}
}

const arms = [boot(a, portA), boot(b, portA + 2)];
try {
	const boots = [];
	for (const arm of arms) boots.push(await ready(arm));
	for (const [i, bt] of boots.entries()) {
		if (!bt.ok)
			throw new Error(
				`${arms[i].variant} instantiation failed: ${bt.error}\n${JSON.stringify(bt.diag)}`
			);
	}

	const samples = [[], []];
	// one throwaway pass per arm first: the first /cpubench pays class-table and
	// allocator warmup that no later pass repeats
	for (const arm of arms) await fetch(`http://127.0.0.1:${arm.port}/cpubench?n=${n}`);
	for (let i = 0; i < runs; i++) {
		for (const [k, arm] of arms.entries()) {
			const r = await (await fetch(`http://127.0.0.1:${arm.port}/cpubench?n=${n}`)).json();
			samples[k].push(r.execMs);
		}
	}

	const rows = arms.map((arm, k) => ({
		variant: arm.variant,
		bootMs: boots[k].bootMs,
		samples: samples[k],
		median: median(samples[k]),
		min: Math.min(...samples[k]),
		max: Math.max(...samples[k])
	}));

	console.log(
		`paired /cpubench n=${n}, ${runs} interleaved passes per arm, LOCAL wrangler dev ratios only\n`
	);
	for (const r of rows) {
		console.log(
			`${r.variant.padEnd(12)} median ${String(r.median).padStart(5)} ms  min ${r.min}  max ${r.max}  boot ${r.bootMs} ms  samples ${r.samples.join(',')}`
		);
	}
	const [ra, rb] = rows;
	const ratio = rb.median / ra.median;
	console.log(
		`\nratio ${rb.variant} / ${ra.variant} = ${ratio.toFixed(4)}  (${((ratio - 1) * 100).toFixed(2)}%)`
	);
	for (const r of rows) {
		const dir =
			{ o2: 'static-o2', mbonly: 'static-mbstring', freev1: 'static-free-v1' }[r.variant] ??
			`static-${r.variant}`;
		const gz = gzTotal(dir);
		if (gz)
			console.log(`${r.variant.padEnd(12)} gzipped total ${gz} bytes (free ceiling 3145728)`);
	}
} catch (e) {
	console.error(`FAILED: ${e.message}`);
	process.exitCode = 1;
} finally {
	for (const arm of arms) arm.proc.kill('SIGTERM');
	await sleep(1500);
	for (const arm of arms) arm.proc.kill('SIGKILL');
}
