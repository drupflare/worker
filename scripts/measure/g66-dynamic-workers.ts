#!/usr/bin/env bun
/**
 * Spec 66 gate 1: does a worker_loaders binding deploy on a free account, and does a Dynamic
 * Worker load with globalOutbound null and one host capability.
 *
 *   bun scripts/measure/g66-dynamic-workers.ts run --out=<dir>
 *
 * Reads STUDENT_CLOUDFLARE_* and never prints them. Deploys scripts/e2e/g66-probe once, drives
 * it, reads the account meters, then tears down and diffs the inventory.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const account = process.env.STUDENT_CLOUDFLARE_ACCOUNT_ID ?? '';
const token = process.env.STUDENT_CLOUDFLARE_API_TOKEN ?? '';
const root = join(import.meta.dir, '..', '..');
const probe = join(root, 'scripts', 'e2e', 'g66-probe');
const flag = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const out = flag('out') ?? join(root, '.g66-out');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log: string[] = [];
const say = (s: string) => {
	console.log(s);
	log.push(s);
};

async function cf<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
		...init,
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
	});
	const body = (await res.json()) as { success?: boolean; result?: T; errors?: unknown };
	if (!res.ok || body.success === false) {
		throw new Error(
			`${init.method ?? 'GET'} ${path}: ${res.status} ${JSON.stringify(body.errors)}`
		);
	}
	return body.result as T;
}

async function inventory() {
	const [workers, dos, kv, d1] = await Promise.all([
		cf<{ id: string }[]>('/workers/scripts'),
		cf<{ id: string; name: string }[]>('/workers/durable_objects/namespaces?per_page=1000'),
		cf<{ id: string; title: string }[]>('/storage/kv/namespaces?per_page=100'),
		cf<{ uuid: string; name: string }[]>('/d1/database?per_page=100')
	]);
	return {
		workers: workers.map((w) => w.id).sort(),
		durableObjects: dos.map((d) => `${d.id} ${d.name}`).sort(),
		kv: kv.map((k) => `${k.id} ${k.title}`).sort(),
		d1: d1.map((d) => `${d.uuid} ${d.name}`).sort()
	};
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
	const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ query, variables })
	});
	const body = (await res.json()) as { data?: T; errors?: unknown };
	if (body.errors) throw new Error(`graphql: ${JSON.stringify(body.errors).slice(0, 400)}`);
	return body.data as T;
}

async function spentToday() {
	const day = new Date().toISOString().slice(0, 10);
	const data = await gql<{
		viewer: {
			accounts: {
				w: { sum: { requests: number } }[];
				d: { sum: { rowsWritten: number } }[];
			}[];
		};
	}>(
		`query ($a: String!, $day: Date!, $since: Time!) { viewer { accounts(filter: { accountTag: $a }) {
			w: workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $since }) { sum { requests } }
			d: durableObjectsPeriodicGroups(limit: 1, filter: { date_geq: $day }) { sum { rowsWritten } }
		} } }`,
		{ a: account, day, since: `${day}T00:00:00Z` }
	);
	const a = data.viewer.accounts[0];
	return { requests: a?.w[0]?.sum.requests ?? 0, rowsWritten: a?.d[0]?.sum.rowsWritten ?? 0 };
}

function deploy(config: string, name: string) {
	const r = spawnSync(
		'bunx',
		['wrangler', 'deploy', '--config', join(probe, config), '--name', name],
		{
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token }
		}
	);
	return { code: r.status, text: `${r.stdout}\n${r.stderr}`.split(token).join('<token>') };
}

async function main() {
	if (!account || !token) throw new Error('STUDENT_CLOUDFLARE_* not set');
	mkdirSync(out, { recursive: true });
	const name = `cfw-e2e-g66-${Date.now()}`;
	const before = await inventory();
	writeFileSync(join(out, 'inventory-before.json'), JSON.stringify(before, null, 2));
	const spendBefore = await spentToday();
	say(
		`inventory before: ${JSON.stringify({ workers: before.workers, do: before.durableObjects.length, kv: before.kv.length, d1: before.d1.length })}`
	);
	say(`account today before: ${JSON.stringify(spendBefore)}`);
	say(`worker: ${name}`);
	const results: Record<string, unknown> = { name, spendBefore };
	let deployed = false;
	try {
		const d = deploy('wrangler.jsonc', name);
		writeFileSync(join(out, 'deploy-with-binding.log'), d.text);
		results.deployWithBinding = { exit: d.code };
		say(`deploy with worker_loaders: exit ${d.code}`);
		say(d.text.slice(-1500));
		deployed = d.code === 0;
		if (!deployed) {
			const c = deploy('wrangler.control.jsonc', name);
			writeFileSync(join(out, 'deploy-control.log'), c.text);
			results.deployControl = { exit: c.code };
			say(`control deploy (no binding): exit ${c.code}`);
			say(c.text.slice(-800));
			deployed = c.code === 0;
		} else {
			const sub = await cf<{ subdomain: string }>('/workers/subdomain');
			const base = `https://${name}.${sub.subdomain}.workers.dev`;
			let up = false;
			for (let i = 0; i < 18 && !up; i++) {
				const r = await fetch(`${base}/plain`).catch(() => undefined);
				up = r?.status === 200;
				if (!up) await sleep(5000);
			}
			say(`plain route up: ${up}`);
			const calls: { label: string; q: string }[] = [];
			for (let i = 0; i < 5; i++) calls.push({ label: 'load-cap', q: 'mode=load&p=cap' });
			for (let i = 0; i < 5; i++)
				calls.push({ label: 'get-cap', q: 'mode=get&id=g66-a&p=cap' });
			for (let i = 0; i < 3; i++) calls.push({ label: 'load-net', q: 'mode=load&p=net' });
			for (let i = 0; i < 3; i++) calls.push({ label: 'load-env', q: 'mode=load&p=env' });
			calls.push({ label: 'load-limits', q: 'mode=load&p=cap&limits=1' });
			const rows: unknown[] = [];
			for (const c of calls) {
				const t0 = performance.now();
				const r = await fetch(`${base}/?${c.q}`).catch((e) => e as Error);
				const wall = Math.round(performance.now() - t0);
				const row =
					r instanceof Error
						? { label: c.label, fetchError: String(r), wall }
						: {
								label: c.label,
								http: r.status,
								body: (await r.text()).slice(0, 600),
								wall
							};
				rows.push(row);
				say(JSON.stringify(row));
			}
			results.calls = rows;
			writeFileSync(join(out, 'calls.json'), JSON.stringify(rows, null, 2));
			// meters: read before teardown, wait for the lagging dataset to settle
			let last = -1;
			let reading: unknown;
			for (let i = 0; i < 16; i++) {
				await sleep(30000);
				const data = await gql<{
					viewer: {
						accounts: {
							w: {
								sum: { requests: number; errors: number };
								quantiles: Record<string, number>;
							}[];
						}[];
					};
				}>(
					`query ($a: String!, $s: String!, $since: Time!) { viewer { accounts(filter: { accountTag: $a }) {
						w: workersInvocationsAdaptive(limit: 5, filter: { scriptName: $s, datetime_geq: $since }) {
							sum { requests errors } quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 }
						} } } }`,
					{ a: account, s: name, since: new Date(Date.now() - 3600_000).toISOString() }
				).catch((e) => ({ error: String(e) }) as never);
				reading = data;
				const n =
					(data as { viewer?: { accounts: { w: { sum: { requests: number } }[] }[] } })
						.viewer?.accounts[0]?.w[0]?.sum.requests ?? 0;
				say(`meter poll ${i}: ${n} requests`);
				if (n > 0 && n === last) break;
				last = n;
			}
			results.workerMeter = reading;
			results.spendAfter = await spentToday();
			say(`account today after: ${JSON.stringify(results.spendAfter)}`);
		}
	} finally {
		let tdErr = '';
		try {
			await cf(`/workers/scripts/${name}?force=true`, { method: 'DELETE' });
		} catch (e) {
			tdErr = String(e);
		}
		say(`worker delete: ${tdErr || 'ok'}`);
		const after = await inventory();
		writeFileSync(join(out, 'inventory-after.json'), JSON.stringify(after, null, 2));
		const diff = {
			workers: after.workers.filter((x) => !before.workers.includes(x)),
			durableObjects: after.durableObjects.filter((x) => !before.durableObjects.includes(x)),
			kv: after.kv.filter((x) => !before.kv.includes(x)),
			d1: after.d1.filter((x) => !before.d1.includes(x)),
			missing: before.workers.filter((x) => !after.workers.includes(x))
		};
		say(`inventory diff (new vs before): ${JSON.stringify(diff)}`);
		results.diff = diff;
		results.deployed = deployed;
		writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
		writeFileSync(join(out, 'run.log'), log.join('\n'));
	}
}

await main();
