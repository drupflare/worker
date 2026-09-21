/**
 * `J/request` and `J/render` for the VPS arm, from RAPL on a bare-metal host.
 *
 *   bun scripts/measure/vps-energy.ts ceiling --ssh=<host> --target=<ip:port>
 *   bun scripts/measure/vps-energy.ts run     --ssh=<host> --target=<ip:port> --n=7
 *
 * `--target2=<ip:port>` adds the drupflare arm and rotates it inside the same round as the VPS one,
 * so both hosts share one idle floor and one set of neighbours rather than being compared across
 * separate invocations.
 *
 * THE GENERATOR RUNS HERE AND THE COUNTER IS READ THERE, which is the whole point. RAPL reports the
 * package, so a generator sharing the die is inside the reading; the roadmap calls an off-box
 * generator non-optional and this is why. The energy window is opened and closed over ssh while the
 * load is driven from this process.
 *
 * WHAT THIS MEASURES IS PACKAGE PLUS CORE, NOT THE WALL. PSU loss, fans, drives and any discrete GPU
 * sit outside the RAPL domains, so the figure is a floor on machine energy and is labelled that way.
 * A wall meter needs physical access to the host and is the other half of the measurement.
 *
 * Idle is subtracted per arm rather than once, because the box is shared with unrelated containers
 * and its floor drifts. A sample whose load average moved outside the band is DISCARDED rather than
 * averaged, since a neighbour waking up is not part of what is being measured.
 *
 * WIPE THE DURABLE OBJECT STATE BEFORE A RUN AGAINST THE DRUPFLARE ARM. The render arm forces a
 * render with a unique query string, and the page store keeps every one of them: measured, a single
 * session took one object's SQLite from 5.6 MB to 311 MB. Two things then go wrong and only the
 * second is visible. The store grows without bound, and the site spends its daily row budget and
 * answers 503 `x-cfw-degrade: read-only` -- so the arm reports `0 req, 1185 failed` and a later run
 * silently prices a degraded site against a healthy VPS. Check `failed` is 0 on every sample before
 * believing a comparison.
 */
import { spawn } from 'node:child_process';

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
	const cmd = argv.find((a) => !a.startsWith('--')) ?? 'run';
	const args: Args = {};
	for (const a of argv) {
		if (!a.startsWith('--')) continue;
		const [k, v] = a.slice(2).split('=');
		args[k as string] = v === undefined ? true : v;
	}
	return { cmd, args };
}

const RAPL = '/sys/devices/virtual/powercap/intel-rapl/intel-rapl:0';

/**
 * A nonce for this process, mixed into every cache-missing URL.
 *
 * WITHOUT IT THE RENDER ARM MEASURES THE PREVIOUS RUN. A counter restarting at 0 each run reissues
 * the same `?cfwe=0,1,2,...` the last run rendered and populated the cache with, so every run after
 * the first reads 100% `HIT` -- measured, 763 of 763 -- at a rate no 2-CPU box could render, and the
 * energy comes out looking like a cheap render rather than like a cache hit.
 */
const RUN_NONCE = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Monotonic across every drive in the process, and that is the second half of the same defect.
 *
 * Per-call it resets to 0, so round 1's render arm reissues exactly the URLs round 0 just rendered
 * and cached: measured, the MISS share fell 100% -> 43.9% -> 28.2% across three rounds. The nonce
 * alone fixes only the between-RUN collision.
 */
let urlSeq = 0;

type Window = {
	pkgUj: number;
	coreUj: number;
	elapsedMs: number;
	loadBefore: number;
	loadAfter: number;
	/** discrete GPU board power, averaged from the ends of the window; milliwatts */
	gpuMwMean: number;
};

/**
 * The DISCRETE GPU's board power, which RAPL does not cover.
 *
 * NOT the `amdgpu` hwmon node. That one is the iGPU on the Ryzen package, so its draw is already
 * inside the RAPL package domain and adding it double-counts -- it also reads ~13 mW, which is the
 * tell. The discrete card has no hwmon entry and only `nvidia-smi` reports it.
 *
 * An instantaneous reading rather than an accumulator, so this is the mean of the two ends. It is
 * here to BOUND the platform terms the package domain misses, not to attribute anything: the
 * workload never touches the GPU, so whatever it draws belongs to the floor.
 */
const GPU_W =
	'nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits 2>/dev/null | head -1';

/**
 * Opens an energy window on the host, holds it for `seconds`, and returns what it cost.
 *
 * The counter wraps at `max_energy_range_uj`, so a negative delta is a wrap rather than a reading;
 * the caller discards those. Load average brackets the window because the only defence against a
 * neighbouring container waking mid-sample is to notice that it did.
 */
// MUST be async. A `spawnSync` here blocks the event loop for the whole window, so the driver below
// only starts once the window has already closed and every load arm measures an idle box. The first
// version of this file did exactly that.
function energyWindow(ssh: string, seconds: number): Promise<Window> {
	const script =
		`p0=$(cat ${RAPL}/energy_uj); c0=$(cat ${RAPL}/intel-rapl:0:0/energy_uj); ` +
		`g0=$(${GPU_W}); g0=\${g0:-0}; g0=$(printf "%.0f" "$(echo "$g0 * 1000" | bc -l 2>/dev/null || echo 0)"); ` +
		`l0=$(cut -d" " -f1 /proc/loadavg); t0=$(date +%s%N); ` +
		`sleep ${seconds}; ` +
		`p1=$(cat ${RAPL}/energy_uj); c1=$(cat ${RAPL}/intel-rapl:0:0/energy_uj); ` +
		`g1=$(${GPU_W}); g1=\${g1:-0}; g1=$(printf "%.0f" "$(echo "$g1 * 1000" | bc -l 2>/dev/null || echo 0)"); ` +
		`l1=$(cut -d" " -f1 /proc/loadavg); t1=$(date +%s%N); ` +
		`echo "$((p1-p0)) $((c1-c0)) $(((t1-t0)/1000000)) $l0 $l1 $(((g0+g1)/2))"`;
	return new Promise((resolve, reject) => {
		const p = spawn('ssh', ['-o', 'ConnectTimeout=20', ssh, script], {
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let out = '';
		let err = '';
		p.stdout.on('data', (d) => (out += d));
		p.stderr.on('data', (d) => (err += d));
		p.on('error', reject);
		p.on('close', () => {
			const parts = out.trim().split(/\s+/);
			if (parts.length < 6) {
				reject(new Error(`energy window failed: ${out} ${err}`));
				return;
			}
			resolve({
				pkgUj: Number(parts[0]),
				coreUj: Number(parts[1]),
				elapsedMs: Number(parts[2]),
				loadBefore: Number(parts[3]),
				loadAfter: Number(parts[4]),
				gpuMwMean: Number(parts[5])
			});
		});
	});
}

type Drive = { ok: number; failed: number; bytes: number; cache: Map<string, number> };

/** drives `paths` at `concurrency` until `deadline`, counting what completed */
async function drive(
	base: string,
	paths: string[],
	concurrency: number,
	deadline: number,
	unique: boolean
): Promise<Drive> {
	let ok = 0;
	let failed = 0;
	let bytes = 0;
	// path selection stays per-call; the cache-busting id is the module-scope urlSeq
	// the arm's OWN verdict on each response, because "a unique query string misses the cache" is an
	// inference and the cache state is an observation. A render arm answering from cache reads as a
	// cheap render rather than as a broken arm.
	const cache = new Map<string, number>();
	const worker = async () => {
		while (Date.now() < deadline) {
			const path = paths[urlSeq % paths.length]!;
			const i = urlSeq++;
			// a unique query string misses the fastcgi cache, which is how the render arm forces a
			// render without purging a cache the cached arm depends on
			const url = `${base}${path}${unique ? `${path.includes('?') ? '&' : '?'}cfwe=${RUN_NONCE}${i}` : ''}`;
			try {
				const res = await fetch(url, { redirect: 'manual' });
				const body = await res.arrayBuffer();
				// each host names its own tier: nginx answers `x-fastcgi-cache`, drupflare
				// `x-cfw-cache`. reading one header against the other host reports `none` for
				// every sample, which reads as a broken arm rather than as the wrong header
				const state =
					res.headers.get('x-fastcgi-cache') ?? res.headers.get('x-cfw-cache') ?? 'none';
				cache.set(state, (cache.get(state) ?? 0) + 1);
				if (res.status >= 200 && res.status < 400) {
					ok += 1;
					bytes += body.byteLength;
				} else failed += 1;
			} catch {
				failed += 1;
				cache.set('error', (cache.get('error') ?? 0) + 1);
			}
		}
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
	return { ok, failed, bytes, cache };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

/**
 * Reads one arm's energy curve at a request count it was not driven at.
 *
 * FALSIFIED FIRST, and the failure is worth keeping: `e = a + b*n` was the obvious model and this
 * host is not linear. The marginal cost of a request DECLINES as the rate rises -- vps-cached spends
 * 123 mJ per extra request between 29 and 57 req/s and 60 mJ between 57 and 114 -- because the step
 * out of the package's idle C-states is paid once and then amortised. A least-squares slope through
 * a concave curve reports a number that belongs to the rung spacing rather than to the workload.
 *
 * So no slope is fitted. Comparing two arms means reading both at the SAME request count, which is
 * interpolation between measured rungs and nothing more.
 */
function energyAt(points: { n: number; e: number }[], n: number): number | null {
	const pts = [...points].sort((x, y) => x.n - y.n);
	if (pts.length < 2) return null;
	for (let i = 0; i < pts.length - 1; i += 1) {
		const a = pts[i]!;
		const b = pts[i + 1]!;
		if (n >= a.n && n <= b.n) return a.e + ((n - a.n) * (b.e - a.e)) / (b.n - a.n);
	}
	const [a, b] =
		n < pts[0]!.n ? [pts[0]!, pts[1]!] : [pts[pts.length - 2]!, pts[pts.length - 1]!];
	return a.e + ((n - a.n) * (b.e - a.e)) / (b.n - a.n);
}

function report(label: string, samples: number[]) {
	const s = [...samples].sort((a, b) => a - b);
	console.log(
		`  ${label.padEnd(24)} median ${median(s).toFixed(2)}  ` +
			`range ${s[0]?.toFixed(2)}-${s[s.length - 1]?.toFixed(2)}  n=${s.length}`
	);
}

/**
 * The generator's own ceiling, in the shape the run uses.
 *
 * A reading taken with a different loop or a different concurrency is a reading of a ceiling this
 * run never drives against, which this project has already paid for twice.
 *
 * `--ceiling-path` matters and defaults to nothing for a third reason: `/robots.txt` read 52 req/s
 * at c=8 while `/` read 120 on the same arm in the same minute, so the "ceiling" came out BELOW
 * every arm and read as saturation everywhere. A no-work endpoint that is not actually no-work
 * measures itself. Sweep concurrency instead when the question is what the generator can do -- this
 * one reached 2,564 req/s at c=192 and was never the constraint.
 */
async function ceiling(args: Args) {
	const base = `http://${String(args.target)}`;
	const conc = Number(args.concurrency ?? 8);
	const secs = Number(args.window ?? 10);
	const path = String(args['ceiling-path'] ?? '/robots.txt');
	console.log(`generator ceiling against ${base}${path} at concurrency ${conc}`);
	const d = await drive(base, [path], conc, Date.now() + secs * 1000, false);
	console.log(`  ${(d.ok / secs).toFixed(1)} req/s, ${d.ok} ok, ${d.failed} failed`);
	console.log('  every arm below must sit well under this or it is measuring this process');
}

async function run(args: Args) {
	const ssh = String(args.ssh);
	const base = `http://${String(args.target)}`;
	const n = Number(args.n ?? 7);
	const secs = Number(args.window ?? 10);
	const conc = Number(args.concurrency ?? 8);
	const loadBand = Number(args.loadband ?? 6);
	const paths = String(args.paths ?? '/,/user/login').split(',');

	// a second host is rotated INSIDE the same round rather than run as its own invocation. the
	// arms already rotate for this reason; comparing a number taken now against one taken hours ago
	// is a per-arm block, which is what read a 1.5% ABI difference that interleaving put at 1.001x
	const base2 = args.target2 ? `http://${String(args.target2)}` : null;

	type Arm = {
		name: string;
		group: string;
		drive: boolean;
		unique: boolean;
		base: string;
		miss: string[];
		conc: number;
	};
	const VPS_MISS = ['MISS', 'EXPIRED', 'BYPASS'];
	const DRU_MISS = ['MISS', 'RENDER'];
	type Group = { group: string; unique: boolean; base: string; miss: string[] };
	const groups: Group[] = [
		{ group: 'vps-cached', unique: false, base, miss: VPS_MISS },
		{ group: 'vps-render', unique: true, base, miss: VPS_MISS },
		...(base2
			? [
					{ group: 'dru-cached', unique: false, base: base2, miss: DRU_MISS },
					{ group: 'dru-render', unique: true, base: base2, miss: DRU_MISS }
				]
			: [])
	];
	// EVERY ARM IS DRIVEN AT SEVERAL RATES, because energy per request is NOT a constant: a load of
	// any size lifts the package out of its idle C-states, and that step costs the same whether the
	// window carried 400 requests or 4,000. Idle subtraction cannot remove it -- it is absent from
	// the idle arm by definition -- so a single-rate run divides one fixed cost across whatever
	// throughput that arm happened to reach and calls the result mJ/req. Measured on this host: the
	// SAME vps-cached arm reads 55 mJ/req at 474 req/s and 125 mJ/req at 113 req/s. Two rates per
	// arm separate the fixed watts from the marginal joules and neither number is guessed.
	const ladder = String(args.ladder ?? conc)
		.split(',')
		.map((x) => Number(x.trim()))
		.filter((x) => x > 0);
	const arms: Arm[] = [
		{ name: 'idle', group: 'idle', drive: false, unique: false, base, miss: [], conc: 0 },
		...groups.flatMap((g) =>
			ladder.map((c) => ({
				name: `${g.group}@c${c}`,
				group: g.group,
				drive: true,
				unique: g.unique,
				base: g.base,
				miss: g.miss,
				conc: c
			}))
		)
	];

	const got: Record<string, { pkgJ: number[]; coreJ: number[]; reqs: number[]; gpuW: number[] }> =
		{};
	for (const a of arms) got[a.name] = { pkgJ: [], coreJ: [], reqs: [], gpuW: [] };

	console.log(`n=${n}, window=${secs}s, concurrency=${conc}, paths=${paths.join(' ')}`);
	let discarded = 0;

	// arms rotate per round rather than running in per-arm blocks, because anything that drifts
	// inside a round otherwise lands on whichever arm goes last
	for (let round = 0; round < n; round += 1) {
		const order = arms.map((a, i) => arms[(i + round) % arms.length]!);
		for (const arm of order) {
			const started = Date.now();
			const win = new Promise<Window>((resolve, reject) => {
				try {
					resolve(energyWindow(ssh, secs));
				} catch (e) {
					reject(e);
				}
			});
			let d: Drive = { ok: 0, failed: 0, bytes: 0, cache: new Map() };
			if (arm.drive) {
				await new Promise((r) => setTimeout(r, 400));
				d = await drive(
					arm.base,
					paths,
					arm.conc,
					started + (secs - 0.6) * 1000,
					arm.unique
				);
			}
			const w = await win;
			const moved = Math.abs(w.loadAfter - w.loadBefore);
			if (w.pkgUj <= 0 || (!arm.drive && moved > loadBand)) {
				discarded += 1;
				console.log(
					`  round ${round} ${arm.name.padEnd(14)}: DISCARDED (dPkg=${w.pkgUj}, dLoad=${moved})`
				);
				continue;
			}
			got[arm.name]!.pkgJ.push(w.pkgUj / 1e6);
			got[arm.name]!.coreJ.push(w.coreUj / 1e6);
			got[arm.name]!.reqs.push(d.ok);
			got[arm.name]!.gpuW.push(w.gpuMwMean / 1000);
			const states = [...d.cache].map(([k, v]) => `${k}:${v}`).join(' ');
			// the render arm's terminating observation: it is only a render arm while it MISSES. A
			// high hit share means the cache is answering and the sample prices a hit.
			if (arm.unique && d.ok > 0) {
				const miss = arm.miss.reduce((t, k) => t + (d.cache.get(k) ?? 0), 0);
				if (miss / d.ok < 0.9) {
					console.log(
						`  !! round ${round} render: only ${((100 * miss) / d.ok).toFixed(1)}% MISS ` +
							`-- this sample prices cache hits, not renders`
					);
				}
			}
			console.log(
				`  round ${round} ${arm.name.padEnd(14)}: ${(w.pkgUj / 1e6).toFixed(1)} J pkg, ` +
					`${(w.coreUj / 1e6).toFixed(1)} J core, ${d.ok} req, ${d.failed} failed, ` +
					`${(w.pkgUj / 1e6 / (w.elapsedMs / 1000)).toFixed(1)} W` +
					(states ? `  [${states}]` : '')
			);
		}
	}

	console.log(`\nper-window energy over ${secs}s (J), ${discarded} sample(s) discarded`);
	for (const a of arms) report(`${a.name} package`, got[a.name]!.pkgJ);
	for (const a of arms) report(`${a.name} core`, got[a.name]!.coreJ);

	const idlePkg = median(got['idle']!.pkgJ);
	const idleCore = median(got['idle']!.coreJ);
	console.log(
		`\nidle floor: ${(idlePkg / secs).toFixed(2)} W package, ${(idleCore / secs).toFixed(2)} W core`
	);
	console.log(
		'\nper-rate readings, idle subtracted (the naive column is what one rate reports):'
	);
	for (const a of arms.filter((x) => x.drive)) {
		const reqs = median(got[a.name]!.reqs);
		if (!reqs) continue;
		const pkg = (median(got[a.name]!.pkgJ) - idlePkg) / reqs;
		console.log(
			`  ${a.name.padEnd(14)} ${(reqs / secs).toFixed(1).padStart(6)} req/s   ` +
				`naive ${(pkg * 1000).toFixed(1).padStart(6)} mJ/req`
		);
	}

	if (base2) {
		const curve = (group: string) =>
			arms
				.filter((x) => x.group === group)
				.map((r) => ({
					n: median(got[r.name]!.reqs),
					e: median(got[r.name]!.pkgJ) - idlePkg
				}))
				.filter((p) => p.n > 0);
		console.log('\ndrupflare against the VPS at the SAME request count, package J over idle:');
		for (const [tier, dru, vps] of [
			['cached', 'dru-cached', 'vps-cached'],
			['render', 'dru-render', 'vps-render']
		] as const) {
			const dc = curve(dru);
			const vc = curve(vps);
			if (dc.length === 0 || vc.length < 2) continue;
			const lo = Math.min(...vc.map((p) => p.n));
			const hi = Math.max(...vc.map((p) => p.n));
			for (const p of dc) {
				const v = energyAt(vc, p.n);
				if (v === null || v <= 0) continue;
				const outside = p.n < lo || p.n > hi ? '  (extrapolated)' : '';
				console.log(
					`  ${tier.padEnd(7)} ${String(p.n).padStart(5)} req/window  ` +
						`drupflare ${p.e.toFixed(2).padStart(7)} J  VPS ${v.toFixed(2).padStart(7)} J  ` +
						`${(p.e / v).toFixed(3)}x${outside}`
				);
			}
		}
	}

	// the wall figure this box cannot measure, bounded from what it can. 80 Plus Bronze certifies
	// >=82% at 20% of rated load; a 750 W unit running at a few percent sits well below its own
	// curve, so the efficiency band is deliberately wide and the low end is the honest one.
	const gpuW = median(got['idle']!.gpuW);
	const dcCpu = idlePkg / secs;
	console.log(`\nplatform terms RAPL does not cover, measured where possible:`);
	console.log(
		`  discrete GPU board  ${gpuW.toFixed(1)} W (nvidia-smi, idle: the workload never touches it)`
	);
	console.log(`  the iGPU is NOT added: it sits on the CPU package and is already inside RAPL`);
	console.log(`  DRAM, chipset, drives, fans, NIC: UNMEASURED on this board`);
	console.log(
		`bounding the wall draw from a measured DC floor of ${(dcCpu + gpuW).toFixed(1)} W:`
	);
	for (const eff of [0.7, 0.8, 0.85]) {
		console.log(
			`  at ${(eff * 100).toFixed(0)}% PSU efficiency: >= ${((dcCpu + gpuW) / eff).toFixed(1)} W at the wall`
		);
	}
	console.log(
		'\nRAPL package+core only: PSU loss, fans, drives and DRAM are outside it, so every'
	);
	console.log('per-request figure above is a FLOOR on machine energy rather than a total.');
}

const { cmd, args } = parseArgs(process.argv.slice(2));
const table: Record<string, (a: Args) => Promise<void>> = { ceiling, run };
const fn = table[cmd];
if (!fn) {
	console.error(`unknown command ${cmd}; expected one of ${Object.keys(table).join(', ')}`);
	process.exit(1);
}
await fn(args);
