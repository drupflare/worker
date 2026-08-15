import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Boots a worker, runs the e2e lane against it, and tears the whole thing down.
 *
 *   bun scripts/e2e-lifecycle.ts [--port=8788] [--keep] [--only=lifecycle]
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const hit = args.find((a: string) => a === `--${name}` || a.startsWith(`--${name}=`));
	if (hit === undefined) return undefined;
	return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '1';
};

const port = Number(flag('port') ?? 8788);
const inspectorPort = port + 1000;
const keep = flag('keep') === '1';
const only = flag('only');

const stateDir = join(tmpdir(), `cfw-e2e-${Date.now().toString(36)}`);
const logFile = join(stateDir, 'dev.log');
mkdirSync(stateDir, { recursive: true });

// belt and braces: a bug in the path construction above must not be able to reach a real directory
const forbidden = [
	'/',
	process.cwd(),
	join(process.cwd(), '.wrangler'),
	join(process.cwd(), 'vendor')
];
if (forbidden.includes(stateDir) || !stateDir.includes('cfw-e2e-')) {
	console.error(`refusing to use ${stateDir} as a scratch directory`);
	process.exit(2);
}

console.log(`[e2e] scratch state: ${stateDir}`);
console.log(`[e2e] dev log:       ${logFile}`);

let dev: ChildProcess | null = null;

function shutdown(code: number): never {
	if (dev && dev.exitCode === null) dev.kill('SIGTERM');
	if (keep) {
		console.log(`[e2e] --keep: leaving ${stateDir} in place`);
	} else {
		try {
			rmSync(stateDir, { recursive: true, force: true });
			console.log(`[e2e] removed ${stateDir}`);
		} catch (e) {
			console.error(`[e2e] could not remove ${stateDir}: ${String(e)}`);
		}
	}
	process.exit(code);
	// unreachable; process.exit() is typed as returning void rather than never under this lib set
	throw new Error('unreachable');
}

/** resolves when the worker prints its ready line, rejects when it dies or takes too long */
async function waitForReady(timeoutMs = 120_000): Promise<string> {
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
		if (ready) return ready[1] as string;
		await new Promise((r) => setTimeout(r, 500));
	}
}

const run = (cmd: string, argv: string[], env: Record<string, string>): Promise<number> =>
	new Promise((resolve) => {
		const child = spawn(cmd, argv, {
			stdio: 'inherit',
			env: { ...process.env, ...env }
		});
		child.on('exit', (code) => resolve(code ?? 1));
	});

async function main(): Promise<void> {
	// `PW_DIAGNOSTICS` is ON here and OFF in `wrangler.jsonc`: the lifecycle drives
	// /migrate, /assemble, /firstrun and /export, and a DEPLOYED worker must not expose any of them
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
			String(inspectorPort),
			'--persist-to',
			stateDir,
			'--var',
			'PW_DIAGNOSTICS:1'
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	);

	const { createWriteStream } = await import('node:fs');
	const sink = createWriteStream(logFile, { flags: 'a' });
	dev.stdout?.pipe(sink);
	dev.stderr?.pipe(sink);

	const endpoint = await waitForReady();
	console.log(`[e2e] worker ready at ${endpoint}`);

	const vitestArgs = ['vitest', 'run', '--project=e2e'];
	if (only) vitestArgs.push(`tests/e2e/${only}.spec.ts`);
	const code = await run('bunx', vitestArgs, {
		CFW_E2E_ENDPOINT: endpoint,
		// the shared-site specs in `serve.spec.ts` migrate nothing themselves, so they get their own
		// name and read whatever state they find; the lifecycle spec mints its own per run
		CFW_E2E_SITE: process.env.CFW_E2E_SITE ?? 'e2e'
	});
	shutdown(code);
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

main().catch((e) => {
	console.error(`[e2e] ${String(e?.message ?? e)}`);
	shutdown(1);
});
