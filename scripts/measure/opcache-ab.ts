/**
 * A cold render with the shipped opcache cache, read against one without, on deployed workers.
 *
 *   bun scripts/measure/opcache-ab.ts \
 *     --arms off=https://cfw-opc-off.x.workers.dev,pack=https://cfw-opc-pack.x.workers.dev --n 8
 *
 * Each arm is its own deployment, differing only in `OPCACHE_MODE`, with warming and interpreter
 * retention off so every sample boots. The drop is hibernation: a 25 s gap discards the interpreter,
 * and the request after it boots and renders `/user/password?cold=<tag>` in one invocation. The query
 * is new on every sample, so nothing answers it from the page store.
 *
 * Each serve carries `&tag=`, and `scripts/measure/obs-cpu.ts --model durableObject` joins it back to
 * `cpuTime`. A sample whose response does not say `x-cfw-inline-boot: 1` did not boot in that request
 * and is reported as warm; `x-cfw-php-booted` only says an interpreter is up afterwards. `--visitor`
 * requests the page itself rather than `/serve`, so the wall time is what a visitor waits.
 */

type Args = Record<string, string | undefined>;

function parseArgs(argv: string[]): Args {
	const out: Args = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (!a.startsWith('--')) continue;
		const next = argv[i + 1];
		if (next && !next.startsWith('--')) {
			out[a.slice(2)] = next;
			i++;
		} else out[a.slice(2)] = '1';
	}
	return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const args = parseArgs(process.argv.slice(2));
const arms = (args.arms ?? '').split(',').map((pair) => {
	const [name, base] = pair.split('=') as [string, string];
	return { name, base: base.replace(/\/$/, '') };
});
const n = Number(args.n ?? 8);
const gapMs = Number(args.gap ?? 25_000);
const site = args.site ?? 'opcab';
const run = Date.now().toString(36);

async function provision(base: string): Promise<void> {
	for (let i = 0; i < 40; i++) {
		const res = await fetch(`${base}/migrate?all=1&prefill=0&site=${site}`);
		const body = (await res.json()) as { done?: boolean };
		if (body.done === true) break;
	}
	const claimed = await fetch(`${base}/firstrun?site=${site}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ adminPass: 'cfw-Opcache-Ab-3301', siteName: 'Opcache' })
	});
	const text = await claimed.text();
	if (!claimed.ok && !text.includes('already'))
		throw new Error(`firstrun ${claimed.status}: ${text}`);
}

async function sample(arm: { name: string; base: string }, i: number) {
	const tag = `opcab-${run}-${arm.name}-${i}`;
	// a query no earlier sample stored, because `/user/password` itself is now a page-store HIT
	const path = `/user/password?cold=${tag}`;
	// the visitor's URL rather than `/serve`, so the wall time is the one a visitor waits
	const url = args.visitor
		? `${arm.base}${path}&site=${site}&tag=${tag}`
		: `${arm.base}/serve?site=${site}&path=${encodeURIComponent(path)}&edge=0&tag=${tag}`;
	const started = performance.now();
	const res = await fetch(url);
	const body = await res.text();
	return {
		arm: arm.name,
		i,
		tag,
		status: res.status,
		booted: res.headers.get('x-cfw-php-booted'),
		inlineBoot: res.headers.get('x-cfw-inline-boot'),
		cache: res.headers.get('x-cfw-cache'),
		wallMs: Math.round(performance.now() - started),
		bytes: body.length
	};
}

if (import.meta.main) {
	if (arms.length < 1 || arms.some((a) => !a.base)) {
		throw new Error('--arms name=url[,name=url] is required');
	}
	for (const arm of arms) await provision(arm.base);
	// one boot per arm before the clock starts, so provisioning's own render is not a sample
	for (const arm of arms) await sample(arm, -1);
	const samples = [];
	for (let i = 0; i < n; i++) {
		await sleep(gapMs);
		// the order alternates, so a drift inside a round cannot land on one arm every time
		const order = i % 2 === 0 ? arms : [...arms].reverse();
		for (const arm of order) {
			const s = await sample(arm, i);
			samples.push(s);
			console.log(JSON.stringify(s));
		}
	}
	for (const arm of arms) {
		const stats = (await (
			await fetch(`${arm.base}/serve-stats?site=${site}`)
		).json()) as Record<string, unknown>;
		console.log(
			JSON.stringify({
				arm: arm.name,
				isolateBytes: stats['isolateBytes'] ?? null,
				linearMemoryBytes: stats['linearMemoryBytes'] ?? null,
				mount:
					(stats['mount'] as Record<string, unknown> | undefined)?.['opcachePack'] ?? null
			})
		);
	}
	const warm = samples.filter((s) => s.inlineBoot !== '1').length;
	for (const arm of arms) {
		const walls = samples
			.filter((s) => s.arm === arm.name && s.inlineBoot === '1')
			.map((s) => s.wallMs)
			.sort((a, b) => a - b);
		const at = (q: number) => walls[Math.min(walls.length - 1, Math.floor(q * walls.length))];
		console.log(
			JSON.stringify({ arm: arm.name, coldWallMs: walls, p50: at(0.5), p95: at(0.95) })
		);
	}
	console.log(JSON.stringify({ run, samples: samples.length, warm }));
}
