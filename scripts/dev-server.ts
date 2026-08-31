/**
 * Boots a local `wrangler dev`, waits for it to answer, and always tears it down.
 *
 * ```ts
 * const dev = await startDevServer({ label: 'prefill', port: 8801 });
 * try {
 *   await fetch(`${dev.origin}/serve?site=bake&path=/`);
 * } finally {
 *   dev.stop();
 * }
 * ```
 *
 * EXTRACTED RATHER THAN INVENTED. `scripts/e2e-lifecycle.ts` and `scripts/qa/module-compat.ts` each
 * carried this: the same `Ready on (\S+)` scrape, the same scratch-directory guard, the same
 * SIGTERM-and-remove shutdown. `scripts/bake-prefill.ts` would have been the third copy, which is
 * where an abstraction stops being speculative. Those two are not converted here -- both are lanes
 * that need a running server to exercise, so moving them is its own change with its own verification.
 *
 * THE READY LINE IS SCRAPED FROM A LOG FILE, not from a port probe. A TCP connect succeeds before
 * workerd has loaded the worker, so a probe races the boot and the first request answers with a
 * connection reset that reads exactly like a broken route.
 *
 * NEVER `.wrangler`. Each boot gets its own `--persist-to` under the system temp directory, so a
 * build cannot inherit a Durable Object left over from a previous run -- a migrated site persists in
 * `.wrangler/state/v3/do/`, and a prefill lifted from one is a page nobody rendered today.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** a booted worker and the handle that stops it */
export interface DevServer {
	/** where it answers, no trailing slash */
	origin: string;
	/** the scratch state directory, removed by {@link DevServer.stop} unless `keep` was set */
	stateDir: string;
	/** wrangler's combined output, kept when a boot fails so the reason survives */
	logFile: string;
	/** idempotent: safe to call from a `finally` that also ran on the success path */
	stop(): void;
}

export interface DevServerOptions {
	/** goes in the scratch directory name and every log line, so two boots stay distinguishable */
	label: string;
	port?: number;
	config?: string;
	/** `--var NAME:value` pairs; the diagnostic routes are off in `wrangler.jsonc` */
	vars?: Record<string, string>;
	timeoutMs?: number;
	/** leave the scratch directory behind, for debugging a boot that came up wrong */
	keep?: boolean;
	/** where to print progress; `null` is silent */
	log?: ((line: string) => void) | null;
}

/**
 * Refuses a scratch path that is not obviously disposable.
 *
 * `stop()` removes this directory, and the caller does not choose it -- so this guards against a
 * future caller being allowed to, which is the shape of the mistake `pack-drupal.ts` made when its
 * output directory was one argument away from `assets/`.
 */
function assertDisposable(stateDir: string, marker: string): void {
	const forbidden = [
		'/',
		process.cwd(),
		join(process.cwd(), '.wrangler'),
		join(process.cwd(), 'vendor')
	];
	if (forbidden.includes(stateDir) || !stateDir.includes(marker)) {
		throw new Error(`refusing to use ${stateDir} as a scratch directory`);
	}
}

/** every live server, so an interrupted build does not leak a wrangler holding a port */
const live = new Set<DevServer>();
let hooked = false;

function hookExit(): void {
	if (hooked) return;
	hooked = true;
	// a build is minutes long and Ctrl-C during it is normal; without this the worker survives the
	// script and the next run fails to bind, which reads as a broken config rather than a stale process
	for (const signal of ['exit', 'SIGINT', 'SIGTERM'] as const) {
		process.on(signal, () => {
			for (const server of [...live]) server.stop();
			if (signal !== 'exit') process.exit(130);
		});
	}
}

/**
 * Starts a worker and resolves once it reports itself ready.
 *
 * @throws when wrangler exits, or does not print its ready line in time, naming the log either way.
 */
export async function startDevServer(opts: DevServerOptions): Promise<DevServer> {
	const {
		label,
		port = 8801,
		config = 'wrangler.jsonc',
		vars = {},
		timeoutMs = 180_000,
		keep = false,
		log = (line: string) => console.log(line)
	} = opts;

	const marker = `cfw-${label}-`;
	const stateDir = join(tmpdir(), `${marker}${Date.now().toString(36)}`);
	assertDisposable(stateDir, marker);
	mkdirSync(stateDir, { recursive: true });
	const logFile = join(stateDir, 'dev.log');

	const argv = [
		'wrangler',
		'dev',
		'-c',
		config,
		'--port',
		String(port),
		// wrangler binds one too, and two boots on the same box collide on it before they collide on
		// the port they were told about
		'--inspector-port',
		String(port + 1000),
		'--persist-to',
		stateDir
	];
	for (const [name, value] of Object.entries(vars)) argv.push('--var', `${name}:${value}`);

	const child: ChildProcess = spawn('bunx', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
	const sink = createWriteStream(logFile);
	child.stdout?.pipe(sink);
	child.stderr?.pipe(sink);

	let stopped = false;
	const server: DevServer = {
		origin: '',
		stateDir,
		logFile,
		stop() {
			if (stopped) return;
			stopped = true;
			live.delete(server);
			if (child.exitCode === null) child.kill('SIGTERM');
			if (keep) {
				log?.(`[${label}] --keep: leaving ${stateDir}`);
				return;
			}
			try {
				rmSync(stateDir, { recursive: true, force: true });
			} catch {
				// a locked sqlite file on a killed worker is not worth failing a finished build over
			}
		}
	};
	live.add(server);
	hookExit();

	try {
		server.origin = await waitForReady(child, logFile, timeoutMs);
	} catch (cause) {
		// the log is the only account of WHY, and stop() would delete it
		const tail = existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(-2000) : '';
		server.stop();
		throw new Error(`${(cause as Error).message}\n--- wrangler output ---\n${tail}`);
	}
	log?.(`[${label}] ready on ${server.origin}`);
	return server;
}

/** resolves when the worker prints its ready line, rejects when it dies or takes too long */
async function waitForReady(
	child: ChildProcess,
	logFile: string,
	timeoutMs: number
): Promise<string> {
	const started = Date.now();
	for (;;) {
		if (child.exitCode !== null) {
			throw new Error(`wrangler dev exited with ${child.exitCode}`);
		}
		if (Date.now() - started > timeoutMs) {
			throw new Error(`wrangler dev did not become ready in ${timeoutMs} ms`);
		}
		const body = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
		const ready = /Ready on (https?:\/\/\S+)/.exec(body);
		if (ready?.[1] !== undefined) return ready[1].replace(/\/+$/, '');
		await new Promise((r) => setTimeout(r, 500));
	}
}

/** how {@link migrateSite} drives the route */
export interface MigrateOptions {
	/** passes before the loop gives up; the route is resumable and reports its own cursor */
	maxPasses?: number;
	/**
	 * Whether `/migrate` may seed the serving table from `assets/prefill.json`.
	 *
	 * `false` is what a BAKE needs, and it is not a preference. `/migrate` seeds `cfw_page` from the
	 * shipped `prefill.json`, so a bake that leaves it on renders nothing: `/serve` answers a HIT of
	 * the file the bake exists to replace, and the "new" artifact comes back byte-identical to the
	 * old one -- `renderMs` included, which is what made it detectable at all.
	 */
	prefill?: boolean;
}

/**
 * Drives `/migrate` to completion, which is what makes `/serve` render rather than answer 202.
 *
 * A LOOP, NOT ONE CALL, and `all=1` is not enough on its own: the route is resumable and reports its
 * own cursor precisely because a single invocation cannot hold the whole migration on the free plan.
 * Calling it once and rendering is how a build lifts a page from a half-migrated site.
 *
 * @param origin - a booted {@link DevServer}'s origin
 * @param site - the site id to migrate, which must be the one the renders then ask for
 * @returns how many passes it took
 * @throws when the route stops answering JSON, does not finish inside `maxPasses`, or prefilled the
 *   serving table after `prefill: false` asked it not to
 */
export async function migrateSite(
	origin: string,
	site: string,
	opts: MigrateOptions = {}
): Promise<number> {
	const { maxPasses = 200, prefill = true } = opts;
	for (let pass = 0; pass < maxPasses; pass++) {
		const url = new URL('/migrate', origin);
		url.searchParams.set('site', site);
		url.searchParams.set('all', '1');
		if (!prefill) url.searchParams.set('prefill', '0');
		const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
		const text = await res.text();
		let body: { done?: boolean; prefilled?: number } | null = null;
		try {
			body = JSON.parse(text) as { done?: boolean; prefilled?: number };
		} catch {
			throw new Error(
				`/migrate returned no JSON (HTTP ${res.status}): ${text.slice(0, 400)}`
			);
		}
		// a probe that cannot fail is not a probe: the caller asked for an unseeded site and every
		// page it then lifts is only a render if this stayed zero
		if (!prefill && (body?.prefilled ?? 0) > 0) {
			throw new Error(
				`/migrate prefilled ${body?.prefilled} page(s) after prefill=0; every page lifted ` +
					'from this site would be a copy of assets/prefill.json rather than a render'
			);
		}
		if (body?.done === true) return pass + 1;
	}
	throw new Error(`/migrate did not finish in ${maxPasses} passes`);
}
