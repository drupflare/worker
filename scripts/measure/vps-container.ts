/**
 * Stand up, drive and tear down the VPS comparison arm as a Cloudflare Container.
 *
 * The point of this arm is that both sides of the comparison answer from inside Cloudflare's
 * network. `docker/vps.yml` runs the identical stack on localhost, which has no network term and
 * shares a kernel with its generator; that is the VPS's best case and it is the standing caveat on
 * every host comparison this project has published.
 *
 *   bun scripts/measure/vps-container.ts plan                  # what each instance type costs, no deploy
 *   bun scripts/measure/vps-container.ts up                    # stage the build context and deploy
 *   bun scripts/measure/vps-container.ts budget                # what the arm has spent so far
 *   bun scripts/measure/vps-container.ts drive --workload=anon-cached
 *   bun scripts/measure/vps-container.ts down                  # delete the worker and its container
 *
 * SPEND IS GUARDED IN THE WORKER, NOT HERE. A driver-side limit protects nothing, because the
 * expensive failure is the driver dying with the arm still up. `scripts/measure/vps-container-worker.ts`
 * refuses once a meter reaches its share of the allowance, and `--no-enforce` is the explicit opt
 * out. This CLI prints the accounting so a run is legible while it happens.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	INCLUDED_ALLOWANCE,
	INSTANCE_TYPES,
	armApplications,
	budgetedRuntimeMs,
	resolveInstance
} from './container-budget.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CONTEXT = resolve(ROOT, '.vps-context');
const CONFIG = resolve(ROOT, 'experiments/wrangler/wrangler.vps-container.jsonc');

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
	const cmd = argv.find((a) => !a.startsWith('--')) ?? 'plan';
	const args: Args = {};
	for (const a of argv) {
		if (!a.startsWith('--')) continue;
		const [k, v] = a.slice(2).split('=');
		args[k as string] = v === undefined ? true : v;
	}
	return { cmd, args };
}

function hours(ms: number): string {
	return `${(ms / 3_600_000).toFixed(2)} h`;
}

function run(cmd: string, argv: string[], opts: { quiet?: boolean } = {}) {
	const r = spawnSync(cmd, argv, {
		cwd: ROOT,
		stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
		encoding: 'utf8'
	});
	return r;
}

/**
 * Copies exactly what the image needs into a context of its own.
 *
 * The repository root is not usable as a build context: `vendor/` alone is 198 MB of hand-built
 * php-wasm arms, and a context that sweeps it would be slow AND would risk baking artifacts into a
 * published image. Naming the five inputs is also the honest statement of what the arm contains.
 */
function stage() {
	const inputs: [string, string][] = [
		['drupal-src', 'drupal-src'],
		['assets/drupal/site.sqlite', 'site.sqlite'],
		['docker/vps-container/nginx.conf', 'nginx.conf'],
		['docker/vps-container/start.sh', 'start.sh'],
		['docker/vps/prepend.php', 'prepend.php']
	];
	for (const [from] of inputs) {
		if (!existsSync(resolve(ROOT, from))) {
			throw new Error(
				`missing build input ${from}. A clean checkout cannot build this arm: drupal-src ` +
					`arrives from \`bun run fetch:drupal\` and site.sqlite from the CDN restore.`
			);
		}
	}
	clearContext();
	mkdirSync(CONTEXT, { recursive: true });
	for (const [from, to] of inputs) {
		cpSync(resolve(ROOT, from), resolve(CONTEXT, to), { recursive: true, dereference: true });
	}
	// the installer's own settings.php lives here and carries a hash_salt; it is build output the
	// runtime never reads, and leaving it in bakes a secret into the image
	rmSync(resolve(CONTEXT, 'drupal-src/sites/build'), { recursive: true, force: true });
	console.log(`staged ${inputs.length} inputs into ${CONTEXT}`);
}

/**
 * Removes the staged context, having first made every directory in it writable.
 *
 * `rmSync` cannot unlink out of a directory it may not write to, and Drupal's installer hardens
 * `sites/build` to 0555 -- so a plain recursive remove answers ENOTEMPTY on the SECOND stage and
 * every one after it, naming a directory that looks ordinary.
 */
function clearContext() {
	if (!existsSync(CONTEXT)) return;
	// `chmod -R` rather than a walk: bun's `globSync` ignores `absolute`, so a walk written that way
	// returns paths relative to the CWD and quietly chmods the REPOSITORY's tree instead of the copy
	spawnSync('chmod', ['-R', 'u+w', CONTEXT], { stdio: 'ignore' });
	rmSync(CONTEXT, { recursive: true, force: true });
}

function plan() {
	console.log('Included monthly allowance on the Workers Paid plan:');
	console.log(
		`  ${INCLUDED_ALLOWANCE.memoryGibHours} GiB-hours memory, ` +
			`${INCLUDED_ALLOWANCE.vcpuMinutes} vCPU-minutes, ` +
			`${INCLUDED_ALLOWANCE.diskGbHours} GB-hours disk\n`
	);
	console.log('instance      vCPU   memory     disk      runtime at reserve 0.5   binds');
	for (const [name, spec] of Object.entries(INSTANCE_TYPES)) {
		const ms = budgetedRuntimeMs(spec);
		const v = budgetedRuntimeMs(spec) === ms ? '' : '';
		const binding = (() => {
			const f = {
				mem: spec.memoryMib / 1024 / (INCLUDED_ALLOWANCE.memoryGibHours * 0.5),
				cpu: (spec.vcpu * 60) / (INCLUDED_ALLOWANCE.vcpuMinutes * 0.5),
				disk: spec.diskMb / 1000 / (INCLUDED_ALLOWANCE.diskGbHours * 0.5)
			};
			return f.cpu > f.mem && f.cpu > f.disk ? 'cpu' : f.disk > f.mem ? 'disk' : 'memory';
		})();
		console.log(
			`  ${name.padEnd(12)}${String(spec.vcpu).padEnd(7)}${String(spec.memoryMib + ' MiB').padEnd(11)}` +
				`${String(spec.diskMb + ' MB').padEnd(10)}${hours(ms).padEnd(24)}${binding}${v}`
		);
	}
	console.log(
		'\nCPU is the worst case: it charges every running millisecond as though the vCPU were\n' +
			'saturated, because active usage is the one meter the guard cannot observe.'
	);
}

function armUrl(args: Args): string {
	const explicit = args.url;
	if (typeof explicit === 'string') return explicit.replace(/\/$/, '');
	const sub = typeof args.subdomain === 'string' ? args.subdomain : process.env.CFW_SUBDOMAIN;
	if (!sub) {
		throw new Error('pass --url=https://cfw-vps.<subdomain>.workers.dev or set CFW_SUBDOMAIN');
	}
	return `https://cfw-vps.${sub}.workers.dev`;
}

async function up(args: Args) {
	const instance = String(args.instance ?? 'standard-2');
	const spec = resolveInstance(instance);
	const reserve = Number(args.reserve ?? 0.5);
	const enforce = args['no-enforce'] ? '0' : '1';

	console.log(
		`instance ${instance}: ${spec.vcpu} vCPU, ${spec.memoryMib} MiB, ${spec.diskMb} MB`
	);
	console.log(
		`budgeted runtime at reserve ${reserve}: ${hours(budgetedRuntimeMs(spec, undefined, reserve))}`
	);
	if (enforce === '0') {
		console.log('!! ENFORCEMENT OFF: this arm will run until it is torn down by hand');
	}

	stage();
	const argv = [
		'wrangler',
		'deploy',
		'-c',
		CONFIG,
		'--var',
		`VPS_INSTANCE_TYPE:${instance}`,
		'--var',
		`VPS_BUDGET_ENFORCE:${enforce}`,
		'--var',
		`VPS_BUDGET_RESERVE:${reserve}`
	];
	if (typeof args.name === 'string') argv.push('--name', args.name);
	const r = run('bunx', argv);
	if (r.status !== 0) throw new Error(`deploy failed with status ${r.status}`);
	console.log('\ndeployed. tear it down with: bun scripts/measure/vps-container.ts down');
}

async function budget(args: Args) {
	const res = await fetch(`${armUrl(args)}/__budget`);
	const body = await res.json();
	console.log(JSON.stringify(body, null, 2));
}

function listArmApplications(worker: string) {
	const r = run('bunx', ['wrangler', 'containers', 'list', '--json'], { quiet: true });
	return r.status === 0 ? armApplications(r.stdout ?? '', worker) : [];
}

/**
 * Deletes the worker AND the container application behind it, then proves both are gone.
 *
 * DELETING THE WORKER DOES NOT DELETE THE CONTAINER. Measured 2026-09-21: `wrangler delete`
 * reported "Successfully deleted" while `wrangler containers list` still showed the application
 * `active` with 1 live instance, and the next deploy was refused because the name was taken. An
 * instance left awake bills memory and disk for as long as it is up, so a teardown that reports
 * success on half the job is the most expensive shape this rig has.
 */
async function down(args: Args) {
	const worker = typeof args.name === 'string' ? args.name : 'cfw-vps';
	const argv = ['wrangler', 'delete', '-c', CONFIG, '--force'];
	if (typeof args.name === 'string') argv.push('--name', args.name);
	const r = run('bunx', argv);
	clearContext();

	for (const app of listArmApplications(worker)) {
		console.log(`deleting container application ${app.name} (${app.id})`);
		run('bunx', ['wrangler', 'containers', 'delete', app.id]);
	}

	const left = listArmApplications(worker);
	if (r.status !== 0 || left.length) {
		console.error(
			'teardown did not finish. An awake container bills memory and disk whether or not the\n' +
				'worker exists, so clear these by hand before leaving it:\n' +
				left.map((a) => `  bunx wrangler containers delete ${a.id}  # ${a.name}`).join('\n')
		);
		process.exitCode = 1;
		return;
	}
	console.log('worker and container application deleted, and the staged context is removed');
}

/** one warm-up plus n timed samples of a path, reporting the arm's own service time beside total */
async function sample(base: string, path: string, n: number, cookie?: string) {
	const latencies: number[] = [];
	const vpsMs: number[] = [];
	const statuses = new Map<string, number>();
	const cacheStates = new Map<string, number>();
	for (let i = 0; i < n; i += 1) {
		const t0 = Date.now();
		const res = await fetch(`${base}${path}`, {
			headers: cookie ? { cookie } : {},
			redirect: 'manual'
		});
		await res.text();
		latencies.push(Date.now() - t0);
		statuses.set(String(res.status), (statuses.get(String(res.status)) ?? 0) + 1);
		const own = Number(res.headers.get('x-vps-ms'));
		if (Number.isFinite(own)) vpsMs.push(own * 1000);
		const cs = res.headers.get('x-fastcgi-cache') ?? 'none';
		cacheStates.set(cs, (cacheStates.get(cs) ?? 0) + 1);
		if (res.headers.get('x-vps-budget') === 'exhausted') {
			console.error(
				'the budget guard stopped the arm mid-run; the samples above are partial'
			);
			break;
		}
	}
	const p = (xs: number[], q: number) =>
		xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)] : null;
	return {
		path,
		n: latencies.length,
		p50: p(latencies, 0.5),
		p95: p(latencies, 0.95),
		ownP50: p(vpsMs, 0.5),
		statuses: Object.fromEntries(statuses),
		cache: Object.fromEntries(cacheStates)
	};
}

async function drive(args: Args) {
	const base = armUrl(args);
	const n = Number(args.requests ?? 40);
	const paths = String(args.paths ?? '/,/node/1,/user/login').split(',');

	const up = await fetch(`${base}/_up`).catch(() => null);
	console.log(`readiness: ${up?.status ?? 'unreachable'}`);

	const out = [];
	for (const path of paths) {
		await sample(base, path, 3);
		out.push(await sample(base, path, n));
	}
	console.log(JSON.stringify(out, null, 2));
	await budget(args).catch(() => {});
}

const { cmd, args } = parseArgs(process.argv.slice(2));
const table: Record<string, (a: Args) => unknown> = { plan, up, budget, down, drive, stage };
const fn = table[cmd];
if (!fn) {
	console.error(`unknown command ${cmd}; expected one of ${Object.keys(table).join(', ')}`);
	process.exit(1);
}
await fn(args);
