#!/usr/bin/env bun
/**
 * S5 probe: does the glue's socket syscall path reach a host from a Durable Object?
 *
 *   bun scripts/e2e/s5-probe/run.ts build
 *   bun scripts/e2e/s5-probe/run.ts local   [--out=file.json]
 *   bun scripts/e2e/s5-probe/run.ts deploy  [--out=file.json]
 *
 * `deploy` uses the FREE account (FREE_CLOUDFLARE_*) and tears the worker down in a `finally`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const build = join(here, 'build');
const mode = process.argv[2];
const flag = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function buildArms(): Promise<Record<string, string>> {
	delete process.env.DRUPFLARE_GROWTH_STEP;
	const { emitTunedGlue } = await import('../../measure/growth-glue');
	const { withImportedMemory, withInitialPages } = await import('../../measure/initial-memory');
	const root = mkdtempSync(join(tmpdir(), 's5-glue-'));
	mkdirSync(join(root, '.interp'));
	cpSync(join(repo, '.interp/php8.5-worker.mjs'), join(root, '.interp/php8.5-worker.mjs'));
	const tuned = emitTunedGlue(root);
	mkdirSync(build, { recursive: true });
	cpSync(join(repo, '.interp/php8.5-worker.mjs'), join(build, 'control-worker.mjs'));
	cpSync(tuned, join(build, 'ship-worker.mjs'));
	const pristine = new Uint8Array(readFileSync(join(repo, '.interp/php8.5.wasm')));
	writeFileSync(
		join(build, 'php8.5.tuned.wasm'),
		withImportedMemory(withInitialPages(pristine, 1024))
	);
	rmSync(root, { recursive: true, force: true });
	const hashes = {
		control_glue: sha(join(build, 'control-worker.mjs')),
		ship_glue: sha(join(build, 'ship-worker.mjs')),
		ship_glue_on_disk: sha(join(repo, '.interp/php8.5-worker.tuned.mjs')),
		wasm_pristine: sha(join(repo, '.interp/php8.5.wasm')),
		wasm_used: sha(join(build, 'php8.5.tuned.wasm')),
		wasm_tuned_on_disk: sha(join(repo, '.interp/php8.5.tuned.wasm'))
	};
	console.log(JSON.stringify(hashes, null, 1));
	return hashes;
}

type Json = Record<string, any>;

const PROBE_KEY = crypto.randomUUID();

async function get(base: string, path: string, host?: string): Promise<Json> {
	const res = await fetch(base + path, {
		signal: AbortSignal.timeout(60_000),
		headers: { 'x-probe-key': PROBE_KEY, ...(host ? { host } : {}) }
	});
	const text = await res.text();
	try {
		const parsed = JSON.parse(text);
		return Array.isArray(parsed)
			? { status: res.status, items: parsed }
			: { status: res.status, ...parsed };
	} catch {
		return { status: res.status, text: text.slice(0, 300) };
	}
}

const ARMS = ['control-stock', 'control-wss', 'ship-stock', 'ship-wss'];

async function drive(base: string, host: string, closedPort: number, openPort: number) {
	const results: Json[] = [];
	const hit = async (path: string) => {
		try {
			const r = await get(base, path);
			results.push({ path, ...r });
			console.log(path, JSON.stringify(r).slice(0, 220));
		} catch (e) {
			results.push({ path, err: String(e) });
			console.log(path, 'ERR', String(e));
		}
	};
	await hit(`/control?host=${host}`);
	for (const arm of ARMS) {
		await hit(`/run?arm=${arm}&fn=info`);
		for (const [fn, h, port] of [
			['fsockopen', host, openPort],
			['ssc', host, openPort],
			['fsockopen', host, closedPort],
			['ssc', host, closedPort],
			['socket', host, openPort],
			['socket', host, closedPort],
			['socket', '127.0.0.1', closedPort],
			['ssc', '127.0.0.1', closedPort],
			['unix', host, 0]
		] as const) {
			await hit(`/run?arm=${arm}&fn=${fn}&host=${h}&port=${port}&reps=3`);
		}
	}
	await hit('/sinklog');
	return results;
}

async function local() {
	const port = 8799;
	const proc = spawn(
		'bunx',
		[
			'wrangler',
			'dev',
			'--local',
			'--port',
			String(port),
			'--var',
			`PROBE_KEY:${PROBE_KEY}`,
			'--persist-to',
			join(tmpdir(), 's5-state')
		],
		{ cwd: here, stdio: 'inherit' }
	);
	try {
		for (let i = 0; i < 60; i++) {
			try {
				await fetch(`http://localhost:${port}/sink-ping`);
				break;
			} catch {
				await sleep(1000);
			}
		}
		const r = await drive(`http://localhost:${port}`, 'localhost', 8443, port);
		if (flag('out')) writeFileSync(flag('out')!, JSON.stringify(r, null, 1));
	} finally {
		proc.kill('SIGTERM');
	}
}

async function deployed() {
	const free = process.env.FREE_CLOUDFLARE_ACCOUNT_ID;
	const freeToken = process.env.FREE_CLOUDFLARE_API_TOKEN;
	if (!free || !freeToken) throw new Error('FREE_CLOUDFLARE_* are not set');
	process.env.CLOUDFLARE_ACCOUNT_ID = free;
	process.env.CLOUDFLARE_API_TOKEN = freeToken;
	const { leftovers, isEmptyInventory } = await import('../live-deploy');
	const api = `https://api.cloudflare.com/client/v4/accounts/${free}`;
	const cf = async (path: string, init: RequestInit = {}) => {
		const res = await fetch(api + path, {
			...init,
			headers: { authorization: `Bearer ${freeToken}`, 'content-type': 'application/json' }
		});
		const body: any = await res.json();
		if (!res.ok || body.success === false) throw new Error(`${path}: ${res.status}`);
		return body.result;
	};
	const inventory = async () => ({
		workers: (await cf('/workers/scripts')).map((w: any) => w.id as string),
		durableObjects: (await cf('/workers/durable_objects/namespaces?per_page=1000')).map(
			(d: any) => `${d.id} ${d.name}`
		),
		kv: (await cf('/storage/kv/namespaces?per_page=100')).map((k: any) => `${k.id} ${k.title}`),
		d1: (await cf('/d1/database?per_page=100')).map((d: any) => `${d.uuid} ${d.name}`)
	});
	const before = await inventory();
	console.log('INVENTORY BEFORE', JSON.stringify(before));
	if (!before.workers.includes('cfw-idle-trial')) throw new Error('not the expected account');
	const name = `cfw-s5-${Date.now()}`;
	const startedAt = new Date().toISOString();
	let results: Json[] = [];
	let failed = '';
	try {
		const dep = spawnSync(
			'bunx',
			['wrangler', 'deploy', '--name', name, '--var', `PROBE_KEY:${PROBE_KEY}`],
			{
				cwd: here,
				env: process.env,
				encoding: 'utf8'
			}
		);
		console.log(
			(dep.stdout + dep.stderr)
				.replaceAll(PROBE_KEY, '<probe-key>')
				.replace(/[A-Za-z0-9_-]{40,}/g, '<redacted>')
		);
		const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(dep.stdout + dep.stderr)?.[0];
		if (!url) throw new Error('no workers.dev url in the deploy output');
		console.log('deployed', url);
		await sleep(60_000);
		const host = new URL(url).hostname;
		results = await drive(url, host, 8443, 443);
		writeFileSync(flag('out') ?? join(here, 'results.json'), JSON.stringify(results, null, 1));
		await sleep(90_000);
		try {
			const q = `query($a:String!,$s:Time!,$n:String!){viewer{accounts(filter:{accountTag:$a}){
				w:workersInvocationsAdaptive(limit:100,filter:{scriptName:$n,datetime_geq:$s}){sum{requests errors} dimensions{status}}
				d:durableObjectsPeriodicGroups(limit:100,filter:{datetime_geq:$s}){sum{rowsWritten rowsRead}}}}}`;
			const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${freeToken}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify({ query: q, variables: { a: free, s: startedAt, n: name } })
			});
			console.log('METRICS', JSON.stringify(await res.json()).slice(0, 1500));
		} catch (e) {
			console.log('METRICS unavailable', String(e));
		}
	} catch (e) {
		failed = String(e);
		console.log('RUN FAILED', failed);
	} finally {
		spawnSync('bunx', ['wrangler', 'delete', '--name', name, '--force'], {
			cwd: here,
			stdio: 'inherit',
			env: process.env
		});
		const created = leftovers(before, await inventory());
		for (const entry of created.durableObjects) {
			const [id, doName] = entry.split(' ');
			if (doName?.startsWith(name))
				await cf(`/workers/durable_objects/namespaces/${id}`, { method: 'DELETE' }).catch(
					(e) => console.log('ns delete', String(e))
				);
		}
		for (const entry of created.kv) {
			const [id, t] = entry.split(' ');
			if (t?.startsWith(name))
				await cf(`/storage/kv/namespaces/${id}`, { method: 'DELETE' }).catch(() => {});
		}
		for (const entry of created.d1) {
			const [id, n] = entry.split(' ');
			if (n?.startsWith(name))
				await cf(`/d1/database/${id}`, { method: 'DELETE' }).catch(() => {});
		}
		const after = await inventory();
		const diff = leftovers(before, after);
		console.log('INVENTORY AFTER', JSON.stringify(after));
		console.log('LEFTOVERS', JSON.stringify(diff));
		console.log(isEmptyInventory(diff) ? 'TEARDOWN OK' : 'TEARDOWN FAILED: leftovers');
		const gone = leftovers(after, before);
		if (!isEmptyInventory(gone)) console.log('MISSING VS BEFORE', JSON.stringify(gone));
		if (!isEmptyInventory(diff)) process.exitCode = 1;
	}
}

if (mode === 'build') await buildArms();
else if (mode === 'local') {
	await buildArms();
	await local();
} else if (mode === 'deploy') {
	await buildArms();
	await deployed();
} else console.log('usage: run.ts build|local|deploy');
