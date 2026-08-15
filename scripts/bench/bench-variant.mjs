#!/usr/bin/env node
/**
 * Boots a build variant under wrangler dev, reads its identity routes, then runs
 * /cpubench N times and reports the median with spread. Same CPU_BENCH source and
 * same route shape as src/o2.js, so the number is comparable to the recorded
 * 648 ms (-O2) and 674 ms (-Oz).
 *
 * usage: node scripts/bench/bench-variant.mjs <variant> [port] [runs] [n]
 *   node scripts/bench/bench-variant.mjs control 8800 5 200000
 */
import { spawn } from 'node:child_process';

const variant = process.argv[2];
if (!variant) {
	console.error('usage: node scripts/bench/bench-variant.mjs <variant> [port] [runs] [n]');
	process.exit(1);
}
const port = Number(process.argv[3] ?? 8800);
const runs = Number(process.argv[4] ?? 5);
const n = Number(process.argv[5] ?? 200000);
const base = `http://127.0.0.1:${port}`;

const wrangler = spawn(
	'bunx',
	[
		'wrangler',
		'dev',
		'-c',
		`experiments/wrangler/wrangler.probe-${variant}.jsonc`,
		'--port',
		String(port),
		'--inspector-port',
		String(port + 100)
	],
	{ stdio: ['ignore', 'pipe', 'pipe'] }
);
let log = '';
wrangler.stdout.on('data', (d) => (log += d));
wrangler.stderr.on('data', (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(timeoutMs = 180000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		try {
			const r = await fetch(`${base}/boot`);
			if (r.ok) return await r.json();
		} catch {
			// not listening yet
		}
		await sleep(1000);
	}
	return null;
}

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

try {
	const boot = await waitReady();
	if (!boot) throw new Error(`wrangler never became ready:\n${log.slice(-2000)}`);
	if (!boot.ok)
		throw new Error(`instantiation failed: ${boot.error}\n${JSON.stringify(boot.diag)}`);

	const version = await (await fetch(`${base}/version`)).json();
	const ext = await (await fetch(`${base}/extensions`)).json();
	const iconv = await (await fetch(`${base}/iconv`)).json();

	const samples = [];
	for (let i = 0; i < runs; i++) {
		const r = await (await fetch(`${base}/cpubench?n=${n}`)).json();
		samples.push(r.execMs);
	}

	const warm = samples.slice(1);
	console.log(`variant: ${variant}`);
	console.log(`bootMs: ${boot.bootMs}  linearMemory: ${boot.memory}`);
	console.log(`version: ${version.out}`);
	console.log(`extensions (${ext.extensions.length}): ${ext.extensions.join(' ')}`);
	console.log(`zend extensions: ${ext.zendExtensions.join(' ')}`);
	console.log(`iconv probe: ${JSON.stringify(iconv)}`);
	console.log(`cpubench n=${n} samples: ${samples.join(', ')} ms`);
	console.log(`cpubench median (all ${runs}): ${median(samples)} ms`);
	console.log(
		`cpubench median (dropping first): ${median(warm)} ms  min ${Math.min(...warm)}  max ${Math.max(...warm)}  spread ${Math.max(...warm) - Math.min(...warm)} ms`
	);
	console.log(`delta vs 648 ms baseline: ${(((median(warm) - 648) / 648) * 100).toFixed(1)}%`);
} catch (e) {
	console.error(`FAILED: ${e.message}`);
	process.exitCode = 1;
} finally {
	wrangler.kill('SIGTERM');
	await sleep(1500);
	wrangler.kill('SIGKILL');
}
