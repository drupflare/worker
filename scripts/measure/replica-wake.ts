/**
 * What a hibernating replica costs to wake, and whether adding replicas buys throughput.
 *
 * ```sh
 * bun scripts/measure/replica-wake.ts --endpoint=https://cfw-rep.example.workers.dev \
 *   --replicas=1,2,4 --burst=20 --idle=120
 * bun scripts/measure/replica-wake.ts --dry
 * ```
 *
 * WHAT WAS ALREADY SETTLED, so this measures the open half. A pending alarm is absent from
 * Cloudflare's hibernation-eligibility list and the probe confirms it: an armed-alarm object accrued
 * 0.177 s over a 60 s pending window. So the keep-warm chain costs a row and a request per arm and
 * buys NO residency, which makes "N replicas that hibernate" the DEFAULT behaviour rather than a
 * design to invent. What nobody has measured is the WAKE, which on this runtime means restoring or
 * re-booting a 96 MiB interpreter.
 *
 * WHY LATENCY AND NOT DURATION HERE. The duration half is already answered -- an idle, eligible
 * object accrues nothing. The question a replica has to answer is what a VISITOR experiences on the
 * request that lands on a cold one, and how that changes as replicas are added.
 *
 * A REPLICA BUYS NO QUOTA. Rows written is account-wide, so this cannot move the regeneration
 * ceiling and is not a capacity lever. It is a latency and concurrency measurement.
 */

/** one latency sample */
export type Sample = { ms: number; status: number; site: string; booted: boolean };

/**
 * A percentile by nearest-rank, which is the honest one for small n.
 *
 * Interpolating between two samples invents a value that was never observed, and at n=20 the
 * invented number sits further from the truth than simply naming the rank does.
 */
export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number;
}

export type Summary = {
	n: number;
	p50: number;
	p95: number;
	p99: number;
	min: number;
	max: number;
	/** how many samples reported the interpreter was NOT up when the request arrived */
	cold: number;
};

export function summarise(samples: readonly Sample[]): Summary {
	const ms = samples.map((s) => s.ms);
	return {
		n: samples.length,
		p50: percentile(ms, 50),
		p95: percentile(ms, 95),
		p99: percentile(ms, 99),
		min: ms.length ? Math.min(...ms) : NaN,
		max: ms.length ? Math.max(...ms) : NaN,
		cold: samples.filter((s) => !s.booted).length
	};
}

/**
 * How far short of linear the throughput scaled.
 *
 * 1.0 is perfect scaling and 0 is none at all. Reported rather than a bare ratio because the
 * interesting answer is the SHORTFALL: a replica that buys 1.6x on 2 objects is a different product
 * decision from one that buys 1.95x, and both look like "it scaled" without this.
 */
export function scalingEfficiency(
	baseThroughput: number,
	scaled: number,
	replicas: number
): number {
	if (baseThroughput <= 0 || replicas <= 0) return 0;
	return scaled / (baseThroughput * replicas);
}

/** the replica an index lands on; round robin, because that is what a hash of a visitor approximates */
export function replicaFor(prefix: string, index: number, replicas: number): string {
	return `${prefix}-r${index % replicas}`;
}

const arg = (name: string, fallback = '') =>
	process.argv
		.find((a) => a.startsWith(`--${name}=`))
		?.split('=')
		.slice(1)
		.join('=') ?? fallback;

async function sample(endpoint: string, site: string, path: string): Promise<Sample> {
	const t0 = Date.now();
	const res = await fetch(
		`${endpoint}/serve?site=${encodeURIComponent(site)}&path=${encodeURIComponent(path)}&edge=0`
	);
	await res.arrayBuffer();
	return {
		// the CLIENT's wall clock, which is what a visitor experiences and the only clock that is
		// meaningful for this question. It is NOT a CPU figure and must never be quoted as one
		ms: Date.now() - t0,
		status: res.status,
		site,
		booted: res.headers.get('x-cfw-php-booted') === '1'
	};
}

if (import.meta.main) {
	const dry = process.argv.includes('--dry');
	const endpoint = arg('endpoint').replace(/\/+$/, '');
	const prefix = arg('prefix', 'wake');
	const replicaArms = arg('replicas', '1,2,4')
		.split(',')
		.map((n) => Number(n.trim()))
		.filter((n) => n > 0);
	const burst = Number(arg('burst', '20'));
	const idle = Number(arg('idle', '120'));
	const path = arg('path', '/');

	if (dry) {
		console.log(`plan: arms ${replicaArms.join(', ')}; burst ${burst}; idle ${idle}s\n`);
		for (const replicas of replicaArms) {
			const names = [
				...new Set(Array.from({ length: burst }, (_, i) => replicaFor(prefix, i, replicas)))
			];
			console.log(`  ${replicas} replica(s): ${names.join(', ')}`);
		}
		console.log('\nprovision, warm, idle past hibernation, then burst and record percentiles');
		process.exit(0);
	}
	if (endpoint === '') throw new Error('--endpoint is required (or pass --dry)');

	const results: { replicas: number; warm: Summary; cold: Summary; throughput: number }[] = [];

	for (const replicas of replicaArms) {
		const names = [
			...new Set(Array.from({ length: replicas }, (_, i) => replicaFor(prefix, i, replicas)))
		];

		for (const site of names) {
			await fetch(`${endpoint}/migrate?site=${site}&all=1`).then((r) => r.arrayBuffer());
			await fetch(`${endpoint}/prefill?site=${site}&force=1`).then((r) => r.arrayBuffer());
			// warm the path, or the first burst measures the fill queue rather than the wake
			for (let i = 0; i < 30; i++) {
				const res = await sample(endpoint, site, path);
				if (res.status < 500) break;
				await new Promise((r) => setTimeout(r, 1000));
			}
		}

		const warm: Sample[] = [];
		const t0 = Date.now();
		await Promise.all(
			Array.from({ length: burst }, async (_, i) => {
				warm.push(await sample(endpoint, replicaFor(prefix, i, replicas), path));
			})
		);
		const throughput = burst / ((Date.now() - t0) / 1000);

		console.log(`${replicas} replica(s): idling ${idle}s so every object can hibernate`);
		await new Promise((r) => setTimeout(r, idle * 1000));

		const cold: Sample[] = [];
		await Promise.all(
			Array.from({ length: burst }, async (_, i) => {
				cold.push(await sample(endpoint, replicaFor(prefix, i, replicas), path));
			})
		);

		results.push({ replicas, warm: summarise(warm), cold: summarise(cold), throughput });
		console.log(
			`  warm p50 ${summarise(warm).p50} ms; after idle p50 ${summarise(cold).p50} ms`
		);
	}

	const base = results[0];
	console.log(
		'\n| replicas | warm p50 | warm p95 | warm p99 | woken p50 | woken p95 | woken p99 | cold hits | req/s | scaling |'
	);
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const r of results) {
		const eff =
			base === undefined
				? 0
				: scalingEfficiency(base.throughput / base.replicas, r.throughput, r.replicas);
		console.log(
			`| ${r.replicas} | ${r.warm.p50} | ${r.warm.p95} | ${r.warm.p99} | ` +
				`${r.cold.p50} | ${r.cold.p95} | ${r.cold.p99} | ${r.cold.cold}/${r.cold.n} | ` +
				`${r.throughput.toFixed(1)} | ${eff.toFixed(2)} |`
		);
	}
	console.log(
		`\nn=${burst} per arm, client wall clock. Not a CPU figure and must not be quoted as one.`
	);
}
