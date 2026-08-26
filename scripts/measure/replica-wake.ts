/**
 * What a hibernating replica costs to wake, and whether adding replicas buys throughput.
 *
 * ```sh
 * bun scripts/measure/replica-wake.ts --endpoint=https://cfw-rep.example.workers.dev \
 *   --replicas=1,2,4 --burst=20 --idle=120
 * bun scripts/measure/replica-wake.ts --dry
 * ```
 *
 * an idle hibernation-eligible object accrues no duration, so the open half is the wake: what a
 * visitor pays on the request that lands on a cold object, and how that moves as replicas are added.
 * rows written is account-wide, so a replica buys no quota and this is not a capacity lever
 */

/** one latency sample */
export type Sample = { ms: number; status: number; site: string; booted: boolean };

/** nearest-rank, so every reported value is one that was actually observed */
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
	// only meaningful where the response carries `x-cfw-php-booted`; `/assemble` does not
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

/** how far short of linear throughput scaled; 1.0 is perfect, 0 is none */
export function scalingEfficiency(
	baseThroughput: number,
	scaled: number,
	replicas: number
): number {
	if (baseThroughput <= 0 || replicas <= 0) return 0;
	return scaled / (baseThroughput * replicas);
}

/** the replica an index lands on; round robin approximates a hash of a visitor */
export function replicaFor(prefix: string, index: number, replicas: number): string {
	return `${prefix}-r${index % replicas}`;
}

const arg = (name: string, fallback = '') =>
	process.argv
		.find((a: string) => a.startsWith(`--${name}=`))
		?.split('=')
		.slice(1)
		.join('=') ?? fallback;

/**
 * which path a sample drives; one mode cannot answer both questions.
 *
 * `serve` is a prefilled cache hit on the storage lane and never boots the interpreter, so it reads
 * the object's own wake; `render` drives `/assemble`, which has to run PHP and pays the boot
 */
export type Mode = 'serve' | 'render';

export function sampleUrl(endpoint: string, site: string, path: string, mode: Mode): string {
	const s = encodeURIComponent(site);
	const p = encodeURIComponent(path);
	return mode === 'render'
		? `${endpoint}/assemble?site=${s}&path=${p}&bins=page`
		: `${endpoint}/serve?site=${s}&path=${p}&edge=0`;
}

async function sample(
	endpoint: string,
	site: string,
	path: string,
	mode: Mode = 'serve'
): Promise<Sample> {
	const t0 = Date.now();
	const res = await fetch(sampleUrl(endpoint, site, path, mode));
	await res.arrayBuffer();
	return {
		// the client's wall clock; NOT a CPU figure and must never be quoted as one
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
		.map((n: string) => Number(n.trim()))
		.filter((n: number) => n > 0);
	const burst = Number(arg('burst', '20'));
	const idle = Number(arg('idle', '120'));
	const path = arg('path', '/');
	const mode = (arg('mode', 'serve') === 'render' ? 'render' : 'serve') as Mode;

	if (dry) {
		console.log(
			`plan: arms ${replicaArms.join(', ')}; burst ${burst}; idle ${idle}s; mode ${mode}\n`
		);
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
			// `/prefill` is not a route and never was; the prefill is a parameter on `/migrate`,
			// so the old pair rendered a 404 Drupal page and provisioned nothing
			await fetch(`${endpoint}/migrate?site=${site}&all=1&prefill=1`).then((r) =>
				r.arrayBuffer()
			);
			// warm the path, or the first burst measures the fill queue rather than the wake
			for (let i = 0; i < 30; i++) {
				const res = await sample(endpoint, site, path, mode);
				if (res.status < 500) break;
				await new Promise((r) => setTimeout(r, 1000));
			}
		}

		const warm: Sample[] = [];
		const t0 = Date.now();
		await Promise.all(
			Array.from({ length: burst }, async (_, i) => {
				warm.push(await sample(endpoint, replicaFor(prefix, i, replicas), path, mode));
			})
		);
		const throughput = burst / ((Date.now() - t0) / 1000);

		console.log(`${replicas} replica(s): idling ${idle}s so every object can hibernate`);
		await new Promise((r) => setTimeout(r, idle * 1000));

		const cold: Sample[] = [];
		await Promise.all(
			Array.from({ length: burst }, async (_, i) => {
				cold.push(await sample(endpoint, replicaFor(prefix, i, replicas), path, mode));
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
		`\nn=${burst} per arm, mode ${mode}, client wall clock. NOT a CPU figure and must not be quoted as one.`
	);
}
