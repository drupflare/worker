/**
 * Tables from floor-rig.ts runs, set beside what the hosting model assumes.
 *
 *   bun scripts/measure/floor-compare.ts cf.json paisley-a.json paisley-b.json ...
 */
import { readFileSync } from 'node:fs';
import { MEMORY_PER_BOX_GIB, RENDER_S_PER_CPU, waitTail } from '../economics/hosting';

interface Proc {
	name: string;
	rssKb: number;
	PssKb?: number;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? null;
const mb = (kb: number | null | undefined) =>
	kb == null || !Number.isFinite(kb) ? '-' : (kb / 1024).toFixed(1);
const bytesKb = (v: unknown) => (v == null ? null : Number(v) / 1024);
const fmt = (n: number | null | undefined, d = 1) => (n == null ? '-' : n.toFixed(d));

/** the p95 wait an M/M/c queue predicts, by bisection on the model's own tail function */
function predictedP95WaitMs(lambda: number, cores: number, mu: number): number {
	const a = lambda / mu;
	if (a >= cores) return Infinity;
	if (waitTail(a, cores, 0, mu) <= 0.05) return 0;
	let lo = 0;
	let hi = 600;
	for (let i = 0; i < 60; i += 1) {
		const mid = (lo + hi) / 2;
		if (waitTail(a, cores, mid, mu) > 0.05) lo = mid;
		else hi = mid;
	}
	return hi * 1000;
}

for (const file of process.argv.slice(2)) {
	const r = JSON.parse(readFileSync(file, 'utf8'));
	const quota = Number(String(r.probeEnd?.cgroup?.cpuMax ?? '').split(' ')[0]);
	const cpus =
		Number.isFinite(quota) && quota > 0 ? quota / 100_000 : Number(process.env.CPUS ?? 1);
	console.log(`\n## ${r.label}  (${cpus} cpu)`);
	console.log(
		`capacity ${fmt(r.capacityRps)} renders/s = ${fmt(r.capacityRps / cpus)} per cpu ` +
			`(model ${RENDER_S_PER_CPU}); cpu ms per render ${fmt(r.cpuMsPerRender, 2)} ` +
			`(model ${fmt(1000 / RENDER_S_PER_CPU, 2)})`
	);
	for (const [name, probe] of [
		['idle', r.probeIdle],
		['warm', r.probeWarm],
		['saturated', r.probeSaturated],
		['end', r.probeEnd]
	] as const) {
		const procs: Proc[] = probe?.procs ?? [];
		const fpm = procs.filter((p) => p.name === 'php-fpm');
		const nginx = procs.filter((p) => p.name === 'nginx');
		console.log(
			`mem ${name.padEnd(9)} cgroup current ${mb(bytesKb(probe?.cgroup?.memoryCurrent))} MB ` +
				`peak ${mb(bytesKb(probe?.cgroup?.memoryPeak))} MB | php-fpm n=${fpm.length} ` +
				`pss median ${mb(median(fpm.map((p) => p.PssKb ?? NaN).filter(Number.isFinite)))} MB ` +
				`rss median ${mb(median(fpm.map((p) => p.rssKb)))} MB | nginx n=${nginx.length} ` +
				`rss ${mb(nginx.reduce((n, p) => n + p.rssKb, 0))} MB | oom ${JSON.stringify(probe?.cgroup?.memoryEvents ?? {})}`
		);
	}
	console.log('closed loop: c, rps, serverP50, serverP95, clientP95, errors, hits');
	for (const c of r.sweep)
		console.log(
			`  ${c.concurrency}\t${fmt(c.rps)}\t${fmt(c.serverP50, 0)}\t${fmt(c.serverP95, 0)}\t${fmt(c.clientP95, 0)}\t${c.errors}\t${c.cacheHits}`
		);
	const mu = r.capacityRps / cpus;
	console.log(
		'open loop: frac, rate, measured serverP95 ms, M/M/c p95 (wait + service) ms, errors'
	);
	for (const o of r.openLoop) {
		const pred = predictedP95WaitMs(o.offeredRate, cpus, mu) + 1000 / mu;
		console.log(
			`  ${o.fraction}\t${fmt(o.offeredRate)}\t${fmt(o.serverP95, 0)}\t${fmt(pred, 0)}\t${o.errors}`
		);
	}
}
console.log(
	`\nmodel memory per box ${MEMORY_PER_BOX_GIB.toFixed(3)} GiB (OS 1 + stack 0.172 + db 0.128)`
);
