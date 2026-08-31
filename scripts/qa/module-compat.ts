import { spawn, type ChildProcess } from 'node:child_process';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, QA_MODULES, type QaResult, type Verdict } from './modules.js';

/**
 * The contrib compatibility pass, against a real running site.
 *
 *   bun scripts/qa/module-compat.ts [--port=8790] [--keep] [--only=webform,recaptcha] [--json=out.json]
 *
 * WHY A RUNNER RATHER THAN A HANDFUL OF CURLS, and it is the same answer `scripts/e2e-lifecycle.ts`
 * gives: **a Durable Object namespace persists.** `wrangler dev` writes to `.wrangler/state/v3/do/`
 * and nothing prunes it -- measured in this repo at 970 MB for one namespace -- and this pass
 * migrates a site and then attempts 25 module installs, each of which rebuilds the router. Left in
 * the default location that accumulates every run, and worse, the second run's "already enabled"
 * answers would be reading yesterday's state rather than measuring anything.
 *
 * So: a scratch `--persist-to`, a site name minted per run, and the directory removed on the way
 * out. It never touches `.wrangler/state/`, `vendor/` or `assets/drupal/site.sqlite`.
 *
 * WHAT IT MEASURES, and the pass exists to keep the two apart:
 *
 *   - `/installable` is the ORACLE's answer, computed from Packagist metadata against the shipped
 *     lock. It is a claim about version constraints.
 *   - `/enable` is what the SITE does when asked. It is a claim about a filesystem and a container.
 *
 * The gap between those two is a finding rather than a nuisance, and it is why both are recorded
 * for every module rather than short-circuiting when the first says no.
 *
 * ROWS. `/enable` arms the write tally around the install, so `rowsWritten` is measured rather than
 * estimated. Rows are the meter that binds the regeneration ceiling, so an install's row cost is
 * the number that decides whether a module is affordable, not its wall clock.
 *
 * NOT A CPU MEASUREMENT. Per RULE 0 an absolute CPU figure comes only from `cpuTime` on a DEPLOYED
 * worker; this runs against `wrangler dev` and reports no durations at all. Row counts are counts,
 * not durations, so they are reportable from here.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const hit = args.find((a: string) => a === `--${name}` || a.startsWith(`--${name}=`));
	if (hit === undefined) return undefined;
	return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '1';
};

const port = Number(flag('port') ?? 8790);
const keep = flag('keep') === '1';
const only = flag('only')
	?.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
const jsonOut = flag('json');

const site = `qa-${Date.now().toString(36)}`;
const stateDir = join(tmpdir(), `cfw-qa-${Date.now().toString(36)}`);
const logFile = join(stateDir, 'dev.log');
mkdirSync(stateDir, { recursive: true });

// the same guard `e2e-lifecycle.ts` carries: a bug in the path construction above must not be able
// to reach a real directory
const forbidden = [
	'/',
	process.cwd(),
	join(process.cwd(), '.wrangler'),
	join(process.cwd(), 'vendor')
];
if (forbidden.includes(stateDir) || !stateDir.includes('cfw-qa-')) {
	console.error(`refusing to use ${stateDir} as a scratch directory`);
	process.exit(2);
}

console.log(`[qa] scratch state: ${stateDir}`);
console.log(`[qa] dev log:       ${logFile}`);
console.log(`[qa] site:          ${site}`);

let dev: ChildProcess | null = null;

function shutdown(code: number): never {
	if (dev && dev.exitCode === null) dev.kill('SIGTERM');
	if (keep) {
		console.log(`[qa] --keep: leaving ${stateDir} in place`);
	} else {
		try {
			rmSync(stateDir, { recursive: true, force: true });
			console.log(`[qa] removed ${stateDir}`);
		} catch (e) {
			console.error(`[qa] could not remove ${stateDir}: ${String(e)}`);
		}
	}
	process.exit(code);
	throw new Error('unreachable');
}

async function waitForReady(timeoutMs = 180_000): Promise<string> {
	const started = Date.now();
	for (;;) {
		if (dev && dev.exitCode !== null) {
			throw new Error(`wrangler dev exited with ${dev.exitCode}; see ${logFile}`);
		}
		if (Date.now() - started > timeoutMs) {
			throw new Error(`wrangler dev did not become ready in ${timeoutMs} ms; see ${logFile}`);
		}
		const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
		const ready = /Ready on (https?:\/\/\S+)/.exec(log);
		if (ready?.[1] !== undefined) return ready[1].replace(/\/+$/, '');
		await new Promise((r) => setTimeout(r, 500));
	}
}

let origin = '';

/** one call against the site under test; every route here is diagnostic and needs PW_DIAGNOSTICS */
async function api<T = Record<string, unknown>>(
	path: string,
	params: Record<string, string> = {}
): Promise<{ status: number; body: T | null; text: string }> {
	const url = new URL(path, origin);
	url.searchParams.set('site', site);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
	const text = await res.text();
	let body: T | null = null;
	try {
		body = JSON.parse(text) as T;
	} catch {
		body = null;
	}
	return { status: res.status, body, text };
}

/** the first sentence of whatever went wrong, never a paraphrase of it */
function firstError(body: Record<string, unknown> | null, text: string): string | null {
	if (body === null) return text.trim().slice(0, 300) || null;
	for (const key of ['error', 'installError', 'discoverError', 'requirementsError']) {
		const value = body[key];
		if (typeof value === 'string' && value !== '') return value.slice(0, 400);
	}
	const requirements = body['requirements'];
	if (Array.isArray(requirements) && requirements.length > 0) {
		return `hook_requirements: ${JSON.stringify(requirements).slice(0, 300)}`;
	}
	return null;
}

async function main(): Promise<void> {
	// PW_DIAGNOSTICS is ON here and OFF in `wrangler.jsonc`: this pass drives /migrate, /installable,
	// /enable and /writes, and a DEPLOYED worker must not expose any of them
	dev = spawn(
		'bunx',
		[
			'wrangler',
			'dev',
			'-c',
			'wrangler.jsonc',
			'--port',
			String(port),
			'--inspector-port',
			String(port + 1000),
			'--persist-to',
			join(stateDir, 'state'),
			'--var',
			'PW_DIAGNOSTICS:1'
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	);
	let logging = true;
	const append = (chunk: unknown) => {
		if (!logging) return;
		try {
			appendFileSync(logFile, String(chunk));
		} catch {
			logging = false;
		}
	};
	dev.stdout?.on('data', append);
	dev.stderr?.on('data', append);

	origin = await waitForReady();
	console.log(`[qa] ready on ${origin}`);

	// #region provision
	// the site has to exist before a module can be enabled into it; /migrate is resumable and
	// reports its own cursor, so it is driven to completion rather than called once
	console.log('[qa] migrating the site');
	for (let pass = 0; pass < 200; pass++) {
		const { body } = await api<{ done?: boolean; chunk?: number; chunks?: number }>(
			'/migrate',
			{
				all: '1'
			}
		);
		if (body?.done === true) {
			console.log(`[qa] migrated in ${pass + 1} pass(es)`);
			break;
		}
		if (body === null) throw new Error('migrate returned no JSON; see the dev log');
	}

	const boot = await api<{ ok?: boolean }>('/enable', { verify: '1' });
	console.log(`[qa] kernel verify: ${boot.body?.ok === true ? 'ok' : JSON.stringify(boot.body)}`);
	// #endregion

	const wanted = only ? QA_MODULES.filter((m) => only.includes(m.machine)) : QA_MODULES;
	const results: QaResult[] = [];

	for (const mod of wanted) {
		process.stdout.write(`[qa] ${mod.machine.padEnd(28)}`);

		// #region the oracle's answer
		const oracle = await api<{ verdict?: string; note?: string; conflicts?: unknown[] }>(
			'/installable',
			{ module: mod.composer }
		);
		const installable = oracle.body?.verdict ?? `http-${oracle.status}`;
		const installableNote = String(oracle.body?.note ?? '').slice(0, 200);
		// #endregion

		// #region what the site actually does
		const attempt = await api<{
			ok?: boolean;
			discoverable?: boolean;
			alreadyEnabled?: boolean;
			rowsWritten?: number;
			writeStatements?: number;
			routerRebuilds?: number | null;
		}>('/enable', { module: mod.machine });
		const body = attempt.body ?? {};
		const discoverable = body.discoverable === true;
		const enabled = body.ok === true || body.alreadyEnabled === true;
		// #endregion

		const actual: Verdict = classify({
			machine: mod.machine,
			discoverable,
			enabled,
			needs: mod.needs,
			expected: mod.expected
		});

		results.push({
			machine: mod.machine,
			composer: mod.composer,
			expected: mod.expected,
			actual,
			installable,
			installableNote,
			discoverable,
			enabled,
			rowsWritten: Number(body.rowsWritten ?? 0),
			writeStatements: Number(body.writeStatements ?? 0),
			routerRebuilds: body.routerRebuilds ?? null,
			error: firstError(body as Record<string, unknown>, attempt.text),
			needs: mod.needs
		});

		const agree = actual === mod.expected ? ' ' : '!';
		console.log(
			`${agree} installable=${installable.padEnd(13)} discoverable=${String(discoverable).padEnd(5)} enabled=${String(enabled).padEnd(5)} rows=${body.rowsWritten ?? 0}`
		);
	}

	// #region does the site still render
	const serve = await fetch(`${origin}/serve?site=${encodeURIComponent(site)}&path=/&edge=0`, {
		signal: AbortSignal.timeout(300_000)
	});
	const html = await serve.text();
	const renders = serve.status === 200 && html.includes('</html>');
	console.log(
		`[qa] site still renders after the pass: ${renders} (${serve.status}, ${html.length} bytes)`
	);
	// #endregion

	report(results, renders, serve.status, html.length);

	if (jsonOut) {
		writeFileSync(
			jsonOut,
			`${JSON.stringify({ site, renders, status: serve.status, results }, null, 2)}\n`,
			'utf8'
		);
		console.log(`[qa] wrote ${jsonOut}`);
	}
	shutdown(0);
}

function report(results: QaResult[], renders: boolean, status: number, bytes: number): void {
	const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
	console.log('');
	console.log(
		`${pad('module', 28)}${pad('expected', 12)}${pad('actual', 12)}${pad('installable', 14)}${pad('rows', 8)}error`
	);
	console.log('-'.repeat(120));
	for (const r of results) {
		console.log(
			pad(r.machine, 28) +
				pad(r.expected, 12) +
				pad(r.actual, 12) +
				pad(r.installable, 14) +
				pad(String(r.rowsWritten), 8) +
				(r.error ?? '').slice(0, 60)
		);
	}
	console.log('');

	const disagreed = results.filter((r) => r.actual !== r.expected);
	console.log(`${results.length} module(s); ${disagreed.length} disagreed with the prediction`);
	for (const r of disagreed) {
		console.log(`  ${r.machine}: predicted ${r.expected}, measured ${r.actual}`);
	}

	// the gap the pass exists to expose: the oracle says yes, the site cannot do it
	const gap = results.filter((r) => r.installable === 'installable' && !r.discoverable);
	console.log('');
	console.log(
		`${gap.length} module(s) the oracle called installable and the site could not find:`
	);
	for (const r of gap) console.log(`  ${r.composer}`);

	console.log('');
	console.log(`site renders after the pass: ${renders} (HTTP ${status}, ${bytes} bytes)`);
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

main().catch((e) => {
	console.error(`[qa] ${String((e as Error)?.message ?? e)}`);
	shutdown(1);
});
