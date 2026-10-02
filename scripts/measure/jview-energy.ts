/**
 * Joules per VIEW on the traffic mix, for the arms that can be measured on one RAPL counter.
 *
 * ```sh
 * bun scripts/measure/jview-energy.ts ceiling  --ssh=<host> --vps=<url> --bastion=<url> --wdev=<url>
 * bun scripts/measure/jview-energy.ts capacity --ssh=<host> ... --pass=<pw> --out=<dir>
 * bun scripts/measure/jview-energy.ts run      --ssh=<host> ... --pass=<pw> --out=<dir> --n=5
 * bun scripts/measure/jview-energy.ts report   --out=<dir>
 * ```
 *
 * The question is the one `docs/impact.md` could not answer: its 13% parity is per RENDER, while a
 * view that `caches.default`, `cfw_page` or a compiled plan answers runs no PHP at all. So the unit
 * here is a view drawn from `config/traffic.yml`, offered at a fixed rate and counted when answered.
 *
 * WHAT IS DECIDED BEFORE THE NUMBERS, so it cannot be fitted to them:
 * - the headline figure is the idle-subtracted weighted J/view of the MIX windows, taken directly;
 *   a weighted sum of per-class windows is reported beside it as a cross-check, never in its place;
 * - the 20% rule is `beatsByTwentyPercent` in `jview-math.ts`: at most 0.80 of the regular host at
 *   EVERY offered rate, on the shipped nginx-plus-php-fpm host;
 * - a window is discarded when containers outside the rig used more than {@link UNRELATED_CPU_S_PER_S}
 *   CPU-seconds per second inside it, and every discard is printed.
 *
 * THE GENERATOR RUNS HERE AND THE COUNTER IS READ THERE; see `vps-energy.ts` for why. Arrivals are
 * OPEN LOOP at the offered rate: a closed loop lets a slow arm shed its own load and read cheap.
 * Every window is opened over ssh and the generator starts only after the remote end says it is
 * open, because ssh setup time otherwise lands the first hundreds of milliseconds outside it.
 *
 * RAPL covers package and core only, so every figure is a floor on machine energy.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	beatsByTwentyPercent,
	counterDelta,
	derivedJoulesPerView,
	jPerView,
	normalizeBody,
	publishedHostJoulesPerView,
	scaleRates,
	smoothPicker,
	spread,
	weightedMean
} from './jview-math';
import { TRAFFIC_MIX } from './verdict-math';
import { login, setExtraHeaders } from './vps-compare';

type Args = Record<string, string | undefined>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
	const cmd = argv.find((a) => !a.startsWith('--')) ?? 'run';
	const args: Args = {};
	for (const a of argv) {
		if (!a.startsWith('--')) continue;
		const at = a.indexOf('=');
		args[at === -1 ? a.slice(2) : a.slice(2, at)] = at === -1 ? '1' : a.slice(at + 1);
	}
	return { cmd, args };
}

const RAPL = '/sys/devices/virtual/powercap/intel-rapl/intel-rapl:0';
const NONCE = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** CPU-seconds per second that containers outside the rig may use inside a window before it is discarded */
export const UNRELATED_CPU_S_PER_S = 0.1;

/** below the front door's 64 connections per address, so the generator never trips a limit of its own */
const MAX_INFLIGHT = 48;

type ClassSpec = { path: string; auth: boolean; unique: boolean };
const CLASSES: Record<string, ClassSpec> = {
	'anon-cached': { path: '/', auth: false, unique: false },
	'anon-miss': { path: '/', auth: false, unique: true },
	'auth-front': { path: '/', auth: true, unique: false },
	'auth-admin': { path: '/admin/content', auth: true, unique: false },
	'auth-account': { path: '/user/1', auth: true, unique: false }
};
const WEIGHTS = Object.fromEntries(Object.entries(TRAFFIC_MIX).map(([k, v]) => [k, v.weight]));

type Arm = {
	name: string;
	base: string;
	headers: Record<string, string>;
	/** docker names whose CPU is attributed to this arm */
	containers: string[];
};

function armsFrom(args: Args): Arm[] {
	const host = args.host ?? 'bench.localhost';
	const arms: Arm[] = [];
	if (args.vps) {
		arms.push({
			name: 'vps',
			base: args.vps,
			headers: {},
			containers: ['drupflare-vps-vps-php-1', 'drupflare-vps-vps-web-1']
		});
	}
	if (args['vps-fpm']) {
		arms.push({
			name: 'vps-fpm',
			base: args['vps-fpm'],
			headers: {},
			containers: ['drupflare-vps-vps-php-1', 'jview-vps-fpm-web']
		});
	}
	if (args.bastion) {
		arms.push({
			name: 'bastion',
			base: args.bastion,
			headers: { host },
			containers: ['jview-bastion']
		});
	}
	if (args.wdev) {
		arms.push({ name: 'wdev', base: args.wdev, headers: { host }, containers: ['jview-wdev'] });
	}
	if (arms.length === 0) throw new Error('no arm given: pass --vps, --bastion and --wdev');
	return arms;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// #region requests

type Outcome = { cls: string; status: number; bytes: number; ms: number; tier: string };

let seq = 0;

/** which tier answered, in the arm's own words */
function tierOf(res: Response): string {
	const h = res.headers;
	const nginx = h.get('x-fastcgi-cache');
	if (nginx !== null) {
		const pc = h.get('x-drupal-cache');
		const dpc = h.get('x-drupal-dynamic-cache');
		return [`nginx:${nginx}`, pc ? `pc:${pc}` : '', dpc ? `dpc:${dpc}` : '']
			.filter(Boolean)
			.join('+');
	}
	const cache = h.get('x-cfw-cache');
	if (cache === null) return 'none';
	const plan = h.get('x-cfw-plan');
	const edge = h.get('x-cfw-edge');
	return [cache, cache === 'PLAN' && plan ? plan : '', edge ? `edge:${edge}` : '']
		.filter(Boolean)
		.join('/');
}

async function issue(arm: Arm, cls: string, cookies: Record<string, string[]>): Promise<Outcome> {
	const spec = CLASSES[cls] as ClassSpec;
	const i = seq++;
	const url = `${arm.base}${spec.path}${spec.unique ? `?cfwe=${NONCE}${i}` : ''}`;
	const jar = cookies[arm.name] ?? [];
	const cookie = spec.auth ? jar[i % jar.length] : undefined;
	const t0 = performance.now();
	try {
		const res = await fetch(url, {
			redirect: 'manual',
			headers: { ...arm.headers, ...(cookie ? { cookie } : {}) }
		});
		const buf = await res.arrayBuffer();
		return {
			cls,
			status: res.status,
			bytes: buf.byteLength,
			ms: performance.now() - t0,
			tier: tierOf(res)
		};
	} catch {
		return { cls, status: 0, bytes: 0, ms: performance.now() - t0, tier: 'error' };
	}
}

type Tally = {
	sent: number;
	ok: number;
	failed: number;
	shed: number;
	bytes: number;
	byClass: Record<string, { sent: number; ok: number; failed: number }>;
	tiers: Record<string, Record<string, number>>;
	ms: number[];
};

const emptyTally = (): Tally => ({
	sent: 0,
	ok: 0,
	failed: 0,
	shed: 0,
	bytes: 0,
	byClass: {},
	tiers: {},
	ms: []
});

function record(t: Tally, o: Outcome): void {
	const c = (t.byClass[o.cls] ??= { sent: 0, ok: 0, failed: 0 });
	const good = o.status >= 200 && o.status < 400;
	if (good) {
		t.ok += 1;
		c.ok += 1;
		t.bytes += o.bytes;
		t.ms.push(o.ms);
	} else {
		t.failed += 1;
		c.failed += 1;
	}
	const tiers = (t.tiers[o.cls] ??= {});
	const key = good ? o.tier : `${o.status}:${o.tier}`;
	tiers[key] = (tiers[key] ?? 0) + 1;
}

/**
 * Open-loop arrivals at `rate` per second for `seconds`.
 *
 * Due times are absolute, so a late timer issues its request at once rather than dropping it and the
 * count over a window is the rate times the window. A request that finds {@link MAX_INFLIGHT} in
 * flight is shed and counted, which is how an arm past its ceiling shows up as achieved < offered.
 */
async function offer(
	arm: Arm,
	rate: number,
	seconds: number,
	pick: () => string,
	cookies: Record<string, string[]>
): Promise<Tally> {
	const t = emptyTally();
	const inflight = new Set<Promise<void>>();
	const interval = 1000 / rate;
	const t0 = performance.now();
	for (let k = 0; k * interval < seconds * 1000; k += 1) {
		const wait = t0 + k * interval - performance.now();
		if (wait > 1) await sleep(wait);
		if (inflight.size >= MAX_INFLIGHT) {
			t.shed += 1;
			continue;
		}
		const cls = pick();
		t.sent += 1;
		(t.byClass[cls] ??= { sent: 0, ok: 0, failed: 0 }).sent += 1;
		const p: Promise<void> = issue(arm, cls, cookies).then((o) => {
			record(t, o);
			inflight.delete(p);
		});
		inflight.add(p);
	}
	await Promise.race([Promise.allSettled([...inflight]), sleep(20_000)]);
	return t;
}

/** closed loop at fixed concurrency, for the capacity probe only */
async function saturate(
	arm: Arm,
	cls: string,
	concurrency: number,
	seconds: number,
	cookies: Record<string, string[]>
): Promise<{ rps: number; failed: number }> {
	const t = emptyTally();
	const until = Date.now() + seconds * 1000;
	const worker = async () => {
		while (Date.now() < until) record(t, await issue(arm, cls, cookies));
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
	return { rps: t.ok / seconds, failed: t.failed };
}

// #endregion

// #region sessions

async function ensureSecondUser(arm: Arm, cookie: string, user: string, pass: string) {
	const form = await fetch(`${arm.base}/admin/people/create`, {
		headers: { ...arm.headers, cookie },
		redirect: 'manual'
	});
	const html = await form.text();
	const buildId = /name="form_build_id" value="([^"]+)"/.exec(html)?.[1];
	const token = /name="form_token" value="([^"]+)"/.exec(html)?.[1] ?? '';
	if (!buildId) throw new Error(`${arm.name}: /admin/people/create served no form`);
	const body = new URLSearchParams({
		name: user,
		mail: `${user}@example.invalid`,
		'pass[pass1]': pass,
		'pass[pass2]': pass,
		status: '1',
		'roles[administrator]': 'administrator',
		form_build_id: buildId,
		form_id: 'user_register_form',
		form_token: token,
		op: 'Create new account'
	});
	const res = await fetch(`${arm.base}/admin/people/create`, {
		method: 'POST',
		body,
		redirect: 'manual',
		headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...arm.headers }
	});
	const after = await res.text();
	if (res.status >= 400) throw new Error(`${arm.name}: creating ${user} answered ${res.status}`);
	const plain = after.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
	const refusal = /Error message(.{0,200})/.exec(plain)?.[1];
	if (refusal !== undefined && !/already taken|already in use/.test(plain)) {
		throw new Error(`${arm.name}: creating ${user} was refused: ${refusal.trim()}`);
	}
}

/** two sessions of one role set per arm, so a shared plan can see two witnesses */
async function sessions(arms: Arm[], pass: string): Promise<Record<string, string[]>> {
	const out: Record<string, string[]> = {};
	for (const arm of arms) {
		setExtraHeaders(arm.headers);
		const a = await login(arm.base, 'admin', pass);
		if (a === null) throw new Error(`${arm.name}: cannot log in as admin`);
		await ensureSecondUser(arm, a, 'bench-editor', pass);
		const b = await login(arm.base, 'bench-editor', pass);
		if (b === null) throw new Error(`${arm.name}: cannot log in as bench-editor`);
		out[arm.name] = [a, b];
		console.log(`  ${arm.name}: two sessions`);
	}
	setExtraHeaders({});
	return out;
}

// #endregion

// #region the counter

type Snap = { id: string; usec: number; mem: number };
type WindowResult = {
	pkgJ: number;
	coreJ: number;
	elapsedMs: number;
	load0: number;
	load1: number;
	snap0: Snap[];
	snap1: Snap[];
};

const WINDOW_SCRIPT = (seconds: number) => `
R=${RAPL}
snap(){ for d in /sys/fs/cgroup/system.slice/docker-*.scope; do b=\${d##*/docker-}; b=\${b%.scope}; u=$(awk '/^usage_usec/{print $2}' $d/cpu.stat 2>/dev/null); m=$(cat $d/memory.current 2>/dev/null); echo "$1 $b \${u:-0} \${m:-0}"; done; }
snap S0
p0=$(cat $R/energy_uj); c0=$(cat $R/intel-rapl:0:0/energy_uj); l0=$(cut -d" " -f1 /proc/loadavg); t0=$(date +%s%N)
echo OPEN
sleep ${seconds}
p1=$(cat $R/energy_uj); c1=$(cat $R/intel-rapl:0:0/energy_uj); l1=$(cut -d" " -f1 /proc/loadavg); t1=$(date +%s%N)
snap S1
echo "RESULT $p0 $p1 $c0 $c1 $(( (t1-t0)/1000000 )) $l0 $l1"
`;

function ssh(host: string, script: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn('ssh', ['-o', 'ConnectTimeout=20', host, 'bash -s'], {
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let out = '';
		p.stdout.on('data', (d) => (out += d));
		p.on('error', reject);
		p.on('close', () => resolve(out));
		p.stdin.end(script);
	});
}

let ENERGY_RANGE = 0;

/** opens a window on the host; `opened` resolves once the first counter reading is taken there */
function openWindow(host: string, seconds: number) {
	const p = spawn('ssh', ['-o', 'ConnectTimeout=20', host, 'bash -s'], {
		stdio: ['pipe', 'pipe', 'pipe']
	});
	let out = '';
	let signalOpen: () => void = () => {};
	const opened = new Promise<void>((r) => (signalOpen = r));
	p.stdout.on('data', (d) => {
		out += d;
		if (out.includes('OPEN\n')) signalOpen();
	});
	const done = new Promise<WindowResult>((resolve, reject) => {
		p.on('error', reject);
		p.on('close', () => {
			signalOpen();
			const lines = out.split('\n');
			const result = lines.find((l) => l.startsWith('RESULT '));
			if (!result) return reject(new Error(`window failed: ${out.slice(0, 300)}`));
			const f = result.split(' ').slice(1).map(Number) as number[];
			const snaps = (tag: string): Snap[] =>
				lines
					.filter((l) => l.startsWith(`${tag} `))
					.map((l) => {
						const [, id, usec, mem] = l.split(' ');
						return { id: id as string, usec: Number(usec), mem: Number(mem) };
					});
			resolve({
				pkgJ: counterDelta(f[0] as number, f[1] as number, ENERGY_RANGE) / 1e6,
				coreJ: counterDelta(f[2] as number, f[3] as number, ENERGY_RANGE) / 1e6,
				elapsedMs: f[4] as number,
				load0: f[5] as number,
				load1: f[6] as number,
				snap0: snaps('S0'),
				snap1: snaps('S1')
			});
		});
	});
	p.stdin.end(WINDOW_SCRIPT(seconds));
	return { opened, done };
}

async function containerNames(host: string): Promise<Record<string, string>> {
	const out = await ssh(host, `docker ps --no-trunc --format '{{.ID}} {{.Names}}'`);
	return Object.fromEntries(
		out
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((l) => {
				const [id, name] = l.split(' ');
				return [id as string, name as string];
			})
	);
}

// #endregion

// #region run

type Sample = {
	phase: string;
	round: number;
	arm: string;
	cell: string;
	rate: number;
	pkgJ: number;
	coreJ: number;
	elapsedMs: number;
	views: number;
	failed: number;
	shed: number;
	sent: number;
	byClass: Tally['byClass'];
	tiers: Tally['tiers'];
	armCpuS: number;
	unrelatedCpuS: number;
	armMemMiB: number;
	load0: number;
	load1: number;
	discarded: string | null;
};

function attribute(
	win: WindowResult,
	names: Record<string, string>,
	mine: string[]
): { armCpuS: number; unrelatedCpuS: number; armMemMiB: number } {
	let armCpuS = 0;
	let unrelatedCpuS = 0;
	let armMem = 0;
	const before = new Map(win.snap0.map((s) => [s.id, s]));
	for (const s of win.snap1) {
		const b = before.get(s.id);
		if (!b) continue;
		const cpuS = (s.usec - b.usec) / 1e6;
		const name = names[s.id] ?? s.id;
		if (mine.includes(name)) {
			armCpuS += cpuS;
			armMem += s.mem;
		} else if (!ALL_RIG.has(name)) {
			unrelatedCpuS += cpuS;
		}
	}
	return { armCpuS, unrelatedCpuS, armMemMiB: armMem / 1048576 };
}

const ALL_RIG = new Set([
	'drupflare-vps-vps-php-1',
	'drupflare-vps-vps-web-1',
	'jview-vps-fpm-web',
	'jview-bastion',
	'jview-wdev'
]);

async function oneWindow(
	args: Args,
	arm: Arm | null,
	phase: string,
	round: number,
	cell: string,
	rate: number,
	secs: number,
	cookies: Record<string, string[]>,
	names: Record<string, string>,
	out: string
): Promise<Sample> {
	const host = args.ssh as string;
	const win = openWindow(host, secs);
	await win.opened;
	let t = emptyTally();
	if (arm !== null) {
		await sleep(300);
		const pick = cell === 'mix' ? smoothPicker(WEIGHTS) : (): string => cell;
		t = await offer(arm, rate, secs - 0.7, pick, cookies);
	}
	const w = await win.done;
	const mine = arm?.containers ?? [];
	const att = attribute(w, names, mine);
	const s: Sample = {
		phase,
		round,
		arm: arm?.name ?? 'idle',
		cell,
		rate,
		pkgJ: w.pkgJ,
		coreJ: w.coreJ,
		elapsedMs: w.elapsedMs,
		views: t.ok,
		failed: t.failed,
		shed: t.shed,
		sent: t.sent,
		byClass: t.byClass,
		tiers: t.tiers,
		...att,
		load0: w.load0,
		load1: w.load1,
		discarded: null
	};
	const limit = UNRELATED_CPU_S_PER_S * (w.elapsedMs / 1000);
	if (att.unrelatedCpuS > limit) {
		s.discarded = `unrelated containers used ${att.unrelatedCpuS.toFixed(2)} CPU-s (limit ${limit.toFixed(2)})`;
	} else if (w.pkgJ <= 0) s.discarded = 'no energy delta';
	appendFileSync(join(out, 'samples.jsonl'), `${JSON.stringify(s)}\n`);
	const states = Object.values(t.tiers)
		.flatMap((x) => Object.entries(x))
		.reduce<Record<string, number>>((a, [k, v]) => ((a[k] = (a[k] ?? 0) + v), a), {});
	console.log(
		`  ${phase} r${round} ${s.arm.padEnd(8)} ${cell.padEnd(12)} @${String(rate).padStart(3)}  ` +
			`${w.pkgJ.toFixed(1).padStart(6)} J  ${String(t.ok).padStart(5)} ok ${t.failed} fail ${t.shed} shed` +
			`${s.discarded ? `  DISCARDED: ${s.discarded}` : ''}  ` +
			Object.entries(states)
				.slice(0, 4)
				.map(([k, v]) => `${k}:${v}`)
				.join(' ')
	);
	return s;
}

type Rates = { mix: number[]; classes: Record<string, number[]> };

async function run(args: Args) {
	const arms = armsFrom(args);
	const out = args.out as string;
	mkdirSync(out, { recursive: true });
	const secs = Number(args.window ?? 10);
	const n = Number(args.n ?? 5);
	const rates = JSON.parse(readFileSync(join(out, 'rates.json'), 'utf8')) as Rates;
	const phases = (args.phases ?? 'mix,class').split(',');
	ENERGY_RANGE = Number(
		(await ssh(args.ssh as string, `cat ${RAPL}/max_energy_range_uj`)).trim()
	);
	const names = await containerNames(args.ssh as string);
	console.log(
		`rig containers: ${[...ALL_RIG].filter((x) => Object.values(names).includes(x)).join(', ')}`
	);
	console.log('logging in');
	const cookies = await sessions(arms, args.pass as string);

	const rotate = <T>(xs: T[], r: number): T[] => xs.map((_, i) => xs[(i + r) % xs.length] as T);

	const phaseCells = (phase: string): { cell: string; rate: number }[] =>
		phase === 'mix'
			? rates.mix.map((rate) => ({ cell: 'mix', rate }))
			: Object.keys(CLASSES).flatMap((cell) =>
					(rates.classes[cell] as number[]).map((rate) => ({ cell, rate }))
				);

	for (const phase of phases) {
		const cells = phaseCells(phase);
		console.log(`\nphase ${phase}: ${cells.length} cells x ${arms.length} arms x n=${n}`);
		// warm every arm on every class before the first window, so a cold tier is not a sample
		for (const arm of arms) {
			for (const cls of Object.keys(CLASSES)) {
				await offer(arm, 20, 3, () => cls, cookies);
			}
		}
		for (
			let round = Number(args['round-start'] ?? 0);
			round < Number(args['round-start'] ?? 0) + n;
			round += 1
		) {
			await oneWindow(args, null, phase, round, 'idle', 0, secs, cookies, names, out);
			let k = 0;
			for (const c of cells) {
				for (const arm of rotate(arms, round + k)) {
					await oneWindow(
						args,
						arm,
						phase,
						round,
						c.cell,
						c.rate,
						secs,
						cookies,
						names,
						out
					);
				}
				k += 1;
				if (k === Math.floor(cells.length / 2)) {
					await oneWindow(args, null, phase, round, 'idle', 0, secs, cookies, names, out);
				}
			}
			await oneWindow(args, null, phase, round, 'idle', 0, secs, cookies, names, out);
			const dump = await ssh(
				args.ssh as string,
				`docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'; df -h / | tail -1; free -g | sed -n 2p`
			);
			writeFileSync(join(out, `docker-stats-${phase}-r${round}.txt`), dump);
		}
	}
	console.log('\ndone; run `report` over the same --out');
}

// #endregion

// #region ceiling and capacity

async function ceiling(args: Args) {
	const arms = armsFrom(args);
	const path = args['ceiling-path'] ?? '/core/misc/checkbox.js';
	console.log(`generator ceiling on ${path}, closed loop, c=32, 4 s per arm`);
	console.log(
		'  bastion does not serve /core/** (the front door has no static layer), so it reads /robots.txt'
	);
	for (const arm of arms) {
		const path =
			arm.name === 'bastion'
				? '/robots.txt'
				: (args['ceiling-path'] ?? '/core/misc/checkbox.js');
		const t = emptyTally();
		const until = Date.now() + 4000;
		await Promise.all(
			Array.from({ length: 32 }, async () => {
				while (Date.now() < until) {
					const res = await fetch(`${arm.base}${path}`, { headers: arm.headers }).catch(
						() => null
					);
					if (res && res.status < 500) {
						await res.arrayBuffer();
						t.ok += 1;
					} else t.failed += 1;
				}
			})
		);
		console.log(`  ${arm.name.padEnd(8)} ${(t.ok / 4).toFixed(0)} req/s, ${t.failed} failed`);
	}
}

async function capacity(args: Args) {
	const arms = armsFrom(args);
	const out = args.out as string;
	mkdirSync(out, { recursive: true });
	const cookies = await sessions(arms, args.pass as string);
	const base = (args.rates ?? '30,60,120').split(',').map(Number);
	const cap: Record<string, Record<string, number>> = {};
	for (const arm of arms) {
		cap[arm.name] = {};
		for (const cls of Object.keys(CLASSES)) {
			await offer(arm, 20, 2, () => cls, cookies);
			const r = await saturate(arm, cls, 12, 4, cookies);
			cap[arm.name]![cls] = r.rps;
			console.log(
				`  ${arm.name.padEnd(8)} ${cls.padEnd(13)} ${r.rps.toFixed(1)} ok/s, ${r.failed} failed`
			);
		}
	}
	const classCap = (cls: string) => Math.min(...arms.map((a) => cap[a.name]![cls] as number));
	const mixCap = Math.min(
		...arms.map(
			(a) =>
				1 /
				Object.entries(WEIGHTS).reduce(
					(n, [c, w]) => n + w / (cap[a.name]![c] as number),
					0
				)
		)
	);
	const rates: Rates = {
		mix: scaleRates(base, mixCap),
		classes: Object.fromEntries(
			Object.keys(CLASSES).map((c) => [c, scaleRates(base, classCap(c))])
		)
	};
	writeFileSync(join(out, 'capacity.json'), JSON.stringify({ cap, mixCap }, null, 2));
	writeFileSync(join(out, 'rates.json'), JSON.stringify(rates, null, 2));
	console.log(`mix capacity (slowest arm) ${mixCap.toFixed(1)} views/s`);
	console.log(JSON.stringify(rates));
}

// #endregion

// #region body check

async function bodies(args: Args) {
	const arms = armsFrom(args);
	const cookies = await sessions(arms, args.pass as string);
	for (const cls of ['anon-cached', 'auth-front', 'auth-account', 'auth-admin']) {
		const spec = CLASSES[cls] as ClassSpec;
		const got: { arm: string; raw: number; norm: string }[] = [];
		for (const arm of arms) {
			for (let i = 0; i < 6; i += 1) await issue(arm, cls, cookies);
			const jar = cookies[arm.name] as string[];
			const res = await fetch(`${arm.base}${spec.path}`, {
				headers: { ...arm.headers, ...(spec.auth ? { cookie: jar[0] as string } : {}) },
				redirect: 'manual'
			});
			const html = await res.text();
			got.push({ arm: arm.name, raw: html.length, norm: normalizeBody(html) });
		}
		const first = got[0] as (typeof got)[number];
		for (const g of got) {
			const same = g.norm === first.norm;
			const ratio = g.norm.length / first.norm.length;
			console.log(
				`  ${cls.padEnd(13)} ${g.arm.padEnd(8)} raw ${String(g.raw).padStart(6)} normalised ${String(g.norm.length).padStart(6)} ` +
					`${same ? 'IDENTICAL to ' + first.arm : `differs from ${first.arm}, size ratio ${ratio.toFixed(3)}`}`
			);
		}
	}
}

// #endregion

// #region report

function load(out: string): Sample[] {
	return readFileSync(join(out, 'samples.jsonl'), 'utf8')
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as Sample)
		.map((s) =>
			s.discarded === null && s.shed > 0.02 * (s.sent + s.shed)
				? { ...s, discarded: `generator shed ${s.shed} of ${s.sent + s.shed} offered` }
				: s
		);
}

const mj = (x: number) => (x * 1000).toFixed(1);

function report(args: Args) {
	const out = args.out as string;
	const all = load(out);
	const used = all.filter((s) => s.discarded === null);
	const discarded = all.filter((s) => s.discarded !== null);
	const arms = [...new Set(all.filter((s) => s.arm !== 'idle').map((s) => s.arm))];
	const lines: string[] = [];
	const say = (l = '') => (lines.push(l), console.log(l));

	say(`${all.length} windows, ${discarded.length} discarded`);
	for (const d of discarded)
		say(`  discarded ${d.phase} r${d.round} ${d.arm} ${d.cell}@${d.rate}: ${d.discarded}`);

	const idleW: Record<string, Spread> = {};
	for (const phase of [...new Set(all.map((s) => s.phase))]) {
		const idle = used.filter((s) => s.phase === phase && s.arm === 'idle');
		const w = idle.map((s) => s.pkgJ / (s.elapsedMs / 1000));
		const c = idle.map((s) => s.coreJ / (s.elapsedMs / 1000));
		idleW[phase] = { pkg: spread(w), core: spread(c) };
		say(
			`\nidle floor, phase ${phase}: ${idleW[phase]!.pkg.median.toFixed(2)} W package (${idleW[phase]!.pkg.min.toFixed(2)}-${idleW[phase]!.pkg.max.toFixed(2)}, n=${w.length}), ${idleW[phase]!.core.median.toFixed(2)} W core`
		);
	}

	type Cellkey = string;
	const key = (s: Sample): Cellkey => `${s.phase}|${s.cell}|${s.rate}|${s.arm}`;
	const groups = new Map<Cellkey, Sample[]>();
	for (const s of used.filter((x) => x.arm !== 'idle'))
		groups.set(key(s), [...(groups.get(key(s)) ?? []), s]);

	const figures = (g: Sample[], phase: string) => {
		const iw = (idleW[phase] as { pkg: ReturnType<typeof spread> }).pkg.median;
		const per = g
			.map((s) =>
				jPerView({
					windowJ: s.pkgJ,
					elapsedS: s.elapsedMs / 1000,
					idleW: iw,
					views: s.views
				})
			)
			.filter((x): x is { subtracted: number; charged: number } => x !== null);
		return {
			sub: spread(per.map((p) => p.subtracted)),
			chg: spread(per.map((p) => p.charged)),
			views: spread(g.map((s) => s.views)),
			failed: g.reduce((n, s) => n + s.failed, 0),
			shed: g.reduce((n, s) => n + s.shed, 0),
			sent: g.reduce((n, s) => n + s.sent, 0),
			cpu: spread(g.map((s) => (s.views > 0 ? s.armCpuS / s.views : 0)))
		};
	};

	const cellsOf = (phase: string, cell: string) =>
		[
			...new Set(used.filter((s) => s.phase === phase && s.cell === cell).map((s) => s.rate))
		].sort((a, b) => a - b);

	const table = (phase: string, cell: string) => {
		say(
			`\n${cell} (phase ${phase}); mJ per view, median (min-max), n per cell; subtracted | charged | CPU-ms per view`
		);
		say(
			`| rate | ${arms.map((a) => `${a} sub`).join(' | ')} | ${arms.map((a) => `${a} charged`).join(' | ')} | ${arms.map((a) => `${a} cpu ms`).join(' | ')} | ok/offered |`
		);
		for (const rate of cellsOf(phase, cell)) {
			const f = arms.map((a) =>
				figures(groups.get(`${phase}|${cell}|${rate}|${a}`) ?? [], phase)
			);
			const cap = f.map(
				(x, i) =>
					`${arms[i]} ${x.sent === 0 ? 'n/a' : `${((100 * x.views.median * x.views.n) / Math.max(1, x.sent)).toFixed(0)}%`}`
			);
			say(
				`| ${rate} | ${f.map((x) => `${mj(x.sub.median)} (${mj(x.sub.min)}-${mj(x.sub.max)}) n=${x.sub.n}`).join(' | ')} | ${f.map((x) => `${mj(x.chg.median)} (${mj(x.chg.min)}-${mj(x.chg.max)})`).join(' | ')} | ${f.map((x) => (x.cpu.median * 1000).toFixed(2)).join(' | ')} | ${cap.join(', ')} (fail ${f.map((x) => x.failed).join('/')}, shed ${f.map((x) => x.shed).join('/')}) |`
			);
		}
	};

	if (idleW.mix) table('mix', 'mix');
	for (const cls of Object.keys(CLASSES)) if (idleW.class) table('class', cls);

	// the weighted figure from per-class cells, at the same rung index
	if (idleW.class) {
		say('\nweighted sum of the per-class cells at rung i (cross-check; rates differ by class)');
		for (let i = 0; i < 3; i += 1) {
			const row = arms.map((a) => {
				const v: Record<string, number | undefined> = {};
				for (const cls of Object.keys(CLASSES)) {
					const rate = cellsOf('class', cls)[i];
					const f =
						rate === undefined
							? null
							: figures(groups.get(`class|${cls}|${rate}|${a}`) ?? [], 'class');
					v[cls] = f && f.sub.n > 0 ? f.sub.median : undefined;
				}
				const wm = weightedMean(v, WEIGHTS);
				return wm === null ? 'n/a' : mj(wm);
			});
			say(`  rung ${i + 1}: ${arms.map((a, j) => `${a} ${row[j]} mJ`).join(', ')}`);
		}
	}

	// the rule
	if (idleW.mix) {
		const rates = cellsOf('mix', 'mix');
		const host = arms.includes('vps') ? 'vps' : (arms[0] as string);
		const hostJ = rates.map(
			(r) => figures(groups.get(`mix|mix|${r}|${host}`) ?? [], 'mix').sub.median
		);
		say(`\n20% rule against ${host}, idle-subtracted weighted J/view of the mix windows`);
		for (const a of arms.filter((x) => x !== host)) {
			const armJ = rates.map(
				(r) => figures(groups.get(`mix|mix|${r}|${a}`) ?? [], 'mix').sub.median
			);
			const v = beatsByTwentyPercent(armJ, hostJ);
			say(
				`  ${a}: ratios ${v.ratios.map((x) => x.toFixed(3)).join(' / ')} at ${rates.join('/')} views/s -> ${v.beats ? 'BEATS by 20%' : 'does not beat by 20%'}`
			);
		}
	}
	writeFileSync(join(out, 'report.txt'), lines.join('\n'));
}

type Spread = { pkg: ReturnType<typeof spread>; core: ReturnType<typeof spread> };

// #endregion

// #region derived arm

/**
 * The fourth arm. `derived`, never compared as if measured: no counter exists on the network side.
 *
 * Every input is printed beside the result. Cloudflare publishes emissions and no energy, so the
 * energy is the Scope 2 total divided by a grid factor, and both factors are shown.
 */
const DERIVED = {
	scope2Facilities_tCO2e: 1611, // Cloudflare Emissions Inventory 2024, location-based, published
	scope2Network_tCO2e: 61_171, // same table, published
	gridGlobal_gPerKWh: 473, // Ember Global Electricity Review 2025, 2024 global average, published
	gridUs_gPerKWh: 384, // Ember, US, as carried in docs/impact.md
	httpRequestsPerSecond: 81e6, // Cloudflare Radar 2025 Year in Review: "over 81 million HTTP requests per second on average"
	requestsPerView: [1, 3], // 3 is the figure docs/impact.md already charges; 1 is the floor
	// as carried in scripts/economics/energy.ts, not re-fetched for this run
	hostIdleW: 135,
	hostLoadedW: 460,
	pue: 1.54,
	sitesPerServer: [20, 50, 100],
	loadedFraction: [0.05, 0.1, 0.15],
	viewsPerSitePerMonth: [10_000, 100_000, 1_000_000, 10_000_000]
};

function derived(): void {
	const d = DERIVED;
	const tCO2e = d.scope2Facilities_tCO2e + d.scope2Network_tCO2e;
	console.log('derived arm (never compared as if measured)');
	console.log(
		`  Cloudflare Scope 2 location-based: ${tCO2e} tCO2e (facilities ${d.scope2Facilities_tCO2e} + network ${d.scope2Network_tCO2e}), published`
	);
	console.log(
		`  requests: ${(d.httpRequestsPerSecond / 1e6).toFixed(0)} M HTTP/s average, published; includes traffic Cloudflare blocks, so per-request is an upper bound`
	);
	console.log(
		'  the report publishes no MWh, and its network figure excludes colocation facility power'
	);
	for (const [label, g] of [
		['global 473 g/kWh', d.gridGlobal_gPerKWh],
		['US 384 g/kWh', d.gridUs_gPerKWh]
	] as const) {
		const joules = ((tCO2e * 1e6) / g) * 3.6e6;
		console.log(
			`  energy at ${label}: ${(joules / 3.6e12).toFixed(1)} GWh/yr (${joules.toExponential(3)} J)`
		);
		for (const rpv of d.requestsPerView) {
			const j = derivedJoulesPerView({
				cloudflareJoulesPerYear: joules,
				requestsPerSecond: d.httpRequestsPerSecond,
				requestsPerView: rpv
			});
			console.log(`    ${rpv} request(s) per view: ${(j * 1000).toFixed(0)} mJ per view`);
		}
	}
	console.log(
		`\nshared server, published: idle ${d.hostIdleW} W, loaded ${d.hostLoadedW} W, PUE ${d.pue}; idle is charged because it is the cost`
	);
	console.log('| views/site/month | sites/server | loaded | J per view |');
	for (const v of d.viewsPerSitePerMonth) {
		for (let i = 0; i < d.sitesPerServer.length; i += 1) {
			const j = publishedHostJoulesPerView({
				idleW: d.hostIdleW,
				loadedW: d.hostLoadedW,
				loadedFraction: d.loadedFraction[i] as number,
				sitesPerServer: d.sitesPerServer[i] as number,
				viewsPerSitePerMonth: v,
				pue: d.pue
			});
			console.log(
				`| ${v.toLocaleString('en-US')} | ${d.sitesPerServer[i]} | ${((d.loadedFraction[i] as number) * 100).toFixed(0)}% | ${j.toFixed(2)} |`
			);
		}
	}
}

// #endregion

const { cmd, args } = parseArgs(process.argv.slice(2));
const table: Record<string, (a: Args) => Promise<void> | void> = {
	ceiling,
	capacity,
	bodies,
	run,
	report,
	derived
};
const fn = table[cmd];
if (!fn) {
	console.error(`unknown command ${cmd}; expected one of ${Object.keys(table).join(', ')}`);
	process.exit(1);
}
if (!['ceiling', 'report', 'derived'].includes(cmd) && !args.ssh) {
	console.error('--ssh=<host> is required');
	process.exit(1);
}
await fn(args);
