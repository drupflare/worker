import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Lever = { name: string; value: unknown; source: string };
type Settings = { levers: Lever[] };
type Arm = Record<'SITE_WARM' | 'WARM_INTERVAL_MS', string | null>;
type Levers = Record<'SITE_WARM' | 'WARM_INTERVAL_MS', string>;
type Probe = {
	t0: number;
	t1: number;
	error?: string;
	status?: number;
	wallMs?: number;
	cache?: string | null;
	inlineBoot?: string | null;
	phpBooted?: string | null;
	workerMs?: string | null;
	edge?: string | null;
};

const LEVERS = ['SITE_WARM', 'WARM_INTERVAL_MS'] as const;
const CLEAR: Arm = { SITE_WARM: null, WARM_INTERVAL_MS: null };
const ARMS: Record<string, Arm> = {
	off: { SITE_WARM: '0', WARM_INTERVAL_MS: null },
	on8: { SITE_WARM: '1', WARM_INTERVAL_MS: '8000' },
	dflt: CLEAR
};
const RESTORE_WINDOW_MS = 60 * 60 * 1000;

// the token is read here, never passed in: from the environment when set, else the keychain
// the watchdog waits while the drive is alive so it never clears levers out from under a live run
const WATCHDOG = [
	'sleep "$WARM_SLEEP"',
	'while kill -0 "$WARM_PARENT" 2>/dev/null; do sleep 60; done',
	'T="${DRUPFLARE_OWNER_TOKEN:-}"',
	'[ -n "$T" ] || T=$(security find-generic-password -s drupflare-owner-token -a "$WARM_ORIGIN" -w)',
	'for i in 1 2 3 4 5 6 7 8 9 10; do',
	`  printf 'authorization: Bearer %s\\n' "$T" | curl -sSf -m 30 -H @- -X PUT -H 'content-type: application/json' -d '{"SITE_WARM":null,"WARM_INTERVAL_MS":null}' "$WARM_ORIGIN/settings" >> "$WARM_DIR/watchdog.out" 2>&1 && break`,
	'  sleep 60',
	'done'
].join('\n');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const flag = (name: string): string | undefined =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function numEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === '') return fallback;
	const v = Number(raw);
	if (!Number.isFinite(v) || v < 0)
		throw new Error(`${name}=${raw} is not a non-negative number`);
	return v;
}

function originFrom(raw: string | undefined): string {
	if (!raw) throw new Error('no origin: pass --origin=https://<site> or set WARM_ORIGIN');
	const u = new URL(raw);
	if (
		!['https:', 'http:'].includes(u.protocol) ||
		(u.pathname !== '/' && u.pathname !== '') ||
		u.search ||
		u.hash
	) {
		throw new Error(`origin ${raw} must be a bare scheme://host[:port]`);
	}
	if (u.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
		throw new Error(
			`origin ${raw} is plain http off localhost; the owner token must not cross it`
		);
	}
	return u.origin;
}

function ownerToken(origin: string): string {
	const fromEnv = process.env.DRUPFLARE_OWNER_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	if (process.platform !== 'darwin') {
		throw new Error('set DRUPFLARE_OWNER_TOKEN (the keychain lookup is macOS only)');
	}
	try {
		return execFileSync(
			'security',
			['find-generic-password', '-s', 'drupflare-owner-token', '-a', origin, '-w'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
		).trim();
	} catch {
		throw new Error(
			`no owner token for ${origin} in the keychain (service drupflare-owner-token)`
		);
	}
}

// keeps the probe loop's own retry out of the caller; a dropped network is the failure this guards
async function retry<T>(fn: () => Promise<T>, tries = 4, backoffMs = 5000): Promise<T> {
	for (let i = 1; ; i++) {
		try {
			return await fn();
		} catch (e) {
			if (i >= tries) throw e;
			await sleep(backoffMs * i);
		}
	}
}

function errorCode(e: unknown): string {
	const err = e as { cause?: { code?: string }; name?: string } | undefined;
	return err?.cause?.code ?? err?.name ?? 'fetch failed';
}

// a wall-clock minute that is a multiple of 5 UTC inside the gap is the demo's own */5 cron
const cronIn = (a: number, b: number): boolean => Math.floor(b / 300000) > Math.floor(a / 300000);

// seeded shuffle so a rerun reproduces the order
function shuffler(seed: number): <T>(a: T[]) => T[] {
	let s = seed;
	const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
	return <T>(a: T[]): T[] => {
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.floor(rnd() * (i + 1));
			const t = a[i] as T;
			a[i] = a[j] as T;
			a[j] = t;
		}
		return a;
	};
}

function armDef(name: string): Arm {
	const def = Object.hasOwn(ARMS, name) ? ARMS[name] : undefined;
	if (def === undefined)
		throw new Error(`unknown arm ${name}; known: ${Object.keys(ARMS).join(',')}`);
	return def;
}

function leversFrom(json: unknown): Levers {
	const levers = (json as Settings | null)?.levers;
	if (!Array.isArray(levers)) throw new Error('GET /settings has no levers array');
	const pick = (name: (typeof LEVERS)[number]): string => {
		const l = levers.find((x) => x.name === name);
		if (!l) throw new Error(`GET /settings has no ${name}`);
		return `${l.value}(${l.source})`;
	};
	return { SITE_WARM: pick('SITE_WARM'), WARM_INTERVAL_MS: pick('WARM_INTERVAL_MS') };
}
const atDefault = (now: Levers): boolean => LEVERS.every((k) => now[k] === 'null(default)');
const armTaken = (arm: Arm, now: Levers): boolean =>
	LEVERS.every((k) => now[k].split('(')[0] === String(arm[k] ?? 'null'));

async function main(): Promise<void> {
	const origin = originFrom(flag('origin') ?? process.env.WARM_ORIGIN);
	const DIR = process.env.DIR ?? join(tmpdir(), 'warm-curve');
	const GAPS = (process.env.GAPS ?? '10,20,40,80,160').split(',').map(Number);
	if (GAPS.some((g) => !Number.isFinite(g) || g <= 0))
		throw new Error(`GAPS=${process.env.GAPS} has a non-positive gap`);
	const N = numEnv('N', 12);
	const SETTLE_S = numEnv('SETTLE_S', 180);
	const ARM_NAMES = (process.env.ARMS ?? 'off,on8,dflt').split(',');
	ARM_NAMES.forEach(armDef);
	const smoke = process.argv.includes('--smoke');
	const run = `r${Date.now().toString(36)}`;
	let n = 0;

	const probe = async (): Promise<Probe> => {
		const t0 = Date.now();
		let res: Response;
		try {
			res = await fetch(`${origin}/user/login?cfwprobe=${run}-${++n}`, {
				redirect: 'manual',
				signal: AbortSignal.timeout(30000)
			});
			await res.arrayBuffer();
		} catch (e) {
			return { t0, t1: Date.now(), error: errorCode(e) };
		}
		const h = (k: string) => res.headers.get(k);
		return {
			t0,
			t1: Date.now(),
			status: res.status,
			wallMs: Date.now() - t0,
			cache: h('x-cfw-cache'),
			inlineBoot: h('x-cfw-inline-boot'),
			phpBooted: h('x-cfw-php-booted'),
			workerMs: h('x-worker-ms'),
			edge: h('x-cfw-edge')
		};
	};

	if (smoke) {
		for (let i = 0; i < 3; i++) {
			console.log(JSON.stringify(await probe()));
			await sleep(2000);
		}
		return;
	}

	const token = ownerToken(origin);
	const owner = (path: string, method = 'GET', body?: unknown) =>
		retry(async () => {
			const res = await fetch(origin + path, {
				method,
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(30000)
			});
			return { status: res.status, json: (await res.json().catch(() => null)) as unknown };
		});
	const readSettings = async (): Promise<unknown> => {
		const r = await owner('/settings');
		if (r.status !== 200) throw new Error(`GET /settings answered ${r.status}`);
		return r.json;
	};
	const levers = async () => leversFrom(await readSettings());

	mkdirSync(DIR, { recursive: true });
	const log = (m: string) => {
		const line = `${new Date().toISOString()} ${m}`;
		console.log(line);
		appendFileSync(join(DIR, 'progress.log'), line + '\n');
	};

	// keeps trying until both levers read back as default; the watchdog covers a process that dies
	async function restore(): Promise<boolean> {
		const deadline = Date.now() + RESTORE_WINDOW_MS;
		for (let i = 1; Date.now() < deadline; i++) {
			try {
				await owner('/settings', 'PUT', CLEAR);
				const now = await levers();
				if (atDefault(now)) {
					log(`restored: ${JSON.stringify(now)}`);
					return true;
				}
			} catch (e) {
				log(`restore attempt ${i} failed: ${errorCode(e)}`);
			}
			await sleep(30000);
		}
		log(
			'RESTORE FAILED: the watchdog stays armed; clear SITE_WARM and WARM_INTERVAL_MS by hand if it does not clear them'
		);
		return false;
	}

	const start = await readSettings();
	const startLevers = leversFrom(start);
	if (!atDefault(startLevers)) {
		log(
			`levers are not at default ${JSON.stringify(startLevers)}; refusing to start so the snapshot stays the baseline`
		);
		process.exit(2);
	}
	writeFileSync(join(DIR, 'settings-before.json'), JSON.stringify(start, null, 1));
	log(`job ${run}; settings snapshot saved; levers now ${JSON.stringify(startLevers)}`);

	const shuffle = shuffler(20261030);
	const order = shuffle([...ARM_NAMES]);
	const plan = order.map((arm) => ({
		arm,
		gaps: shuffle(GAPS.flatMap((g) => Array(N).fill(g)))
	}));
	const total = plan.reduce((s, p) => s + p.gaps.reduce((a, g) => a + g, 0) + SETTLE_S, 0);
	log(
		`order ${order.join(' > ')}; ${N} probes per gap per arm; about ${(total / 3600).toFixed(1)} h`
	);

	// the watchdog fires at planned end plus 40 minutes and clears the levers only once this process is gone
	const planned = ARM_NAMES.length * (GAPS.reduce((a, g) => a + g, 0) * N + SETTLE_S) * 1.1;
	const watchdog = spawn('sh', ['-c', WATCHDOG], {
		detached: true,
		stdio: 'ignore',
		env: {
			...process.env,
			WARM_ORIGIN: origin,
			WARM_DIR: DIR,
			WARM_PARENT: String(process.pid),
			WARM_SLEEP: String(Math.round(planned + 2400))
		}
	});
	watchdog.unref();
	const stopWatchdog = () => {
		if (watchdog.pid === undefined) return;
		try {
			process.kill(-watchdog.pid);
		} catch {
			// already gone
		}
	};

	let stopping = false;
	let restoring: Promise<boolean> | undefined;
	const finish = async () => {
		restoring ??= restore();
		if (await restoring) stopWatchdog();
	};
	for (const sig of ['SIGINT', 'SIGTERM'] as const) {
		process.once(sig, async () => {
			stopping = true;
			log(`${sig}: restoring levers`);
			await finish();
			process.exit(1);
		});
	}

	const started = Date.now();
	let done = 0;
	let failures = 0;
	const all = plan.reduce((s, p) => s + p.gaps.length, 0);
	let lastNote = Date.now();
	try {
		for (const { arm, gaps } of plan) {
			if (stopping) throw new Error('interrupted');
			const def = armDef(arm);
			const put = await owner('/settings', 'PUT', def);
			if (put.status !== 200) throw new Error(`PUT ${arm} answered ${put.status}`);
			const now = await levers();
			if (!armTaken(def, now))
				throw new Error(`arm ${arm} did not take: ${JSON.stringify(now)}`);
			log(`arm ${arm}: PUT 200; levers ${JSON.stringify(now)}; settling ${SETTLE_S} s`);
			await sleep(SETTLE_S * 1000);
			let prevEnd = (await probe()).t1; // priming probe, discarded
			for (const gap of gaps) {
				await sleep(gap * 1000);
				const r = await probe();
				const row = {
					run,
					arm,
					gap,
					...r,
					cronInGap: cronIn(prevEnd, r.t0),
					gapActualS: (r.t0 - prevEnd) / 1000
				};
				appendFileSync(join(DIR, 'probes.jsonl'), JSON.stringify(row) + '\n');
				prevEnd = r.t1;
				done++;
				// a failed probe is a gap the network ate, not a reading; five in a row ends the run
				failures = r.error ? failures + 1 : 0;
				if (failures >= 5) throw new Error(`five probes in a row failed (${r.error})`);
				if (Date.now() - lastNote > 300000) {
					lastNote = Date.now();
					const rate = (Date.now() - started) / done;
					log(
						`progress ${done}/${all} probes (${((done / all) * 100).toFixed(0)}%), arm ${arm}, eta ${(((all - done) * rate) / 60000).toFixed(0)} min`
					);
				}
			}
			log(`arm ${arm} finished`);
		}
	} finally {
		await finish();
	}
	log('done');
}

main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : e);
	process.exitCode = 1;
});
