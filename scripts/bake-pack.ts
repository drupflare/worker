import { spawnSync } from 'node:child_process';
import {
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';

/**
 * The pack recipe: every bake, in the one order that works, as a single command.
 *
 *   bun scripts/bake-pack.ts [--from-runtime] [--yes]
 *
 * `assets/drupal/site.sqlite` is the artifact the edge executes, and for most of
 * this project's life **nothing in this repository produced it** -- it was a hand-trimmed 6.5 MB file
 * whose recipe lived in a chat log, so every fix that touched it went in by surgical insert against a
 * database no one could rebuild.
 *
 * `scripts/drupal/install-site-db.php` now produces one from nothing in about 4 s, and
 * `scripts/diff-site-db.ts` is the gate that says whether the result matches what ships. A fresh
 * install is structurally equivalent to the shipping pack -- identical table set bar six cache bins
 * Drupal creates on first request, identical 169 config objects, identical 40-module set, identical
 * 419 routes -- which is what closes the reproducibility hole. What this script adds on top is the
 * BAKED state: the warmed caches and the container definition that turn an installed site into a
 * fast-booting one.
 *
 * There are FOUR bakes and they are not independent:
 *
 *   1. autoloader   `composer dump-autoload --optimize`, in drupal-src
 *   2. collectors   `bake-collectors.php`, which needs a kernel that TERMINATES (the entries persist
 *                   on destruct, and a plain render leaves them absent)
 *   3. twig         `bake-twig.php`, which must run AFTER 1 so the classmap it records is the one
 *                   that ships
 *   4. container    the definition, which can only come from a RUNTIME BOOT -- see below
 *
 * The ordering that matters, and the coupling that fails silently:
 *
 * - twig before container. `TwigEnvironment` compares the container's `%twig_extension_hash%` against
 *   a State row; if they disagree it mints a fresh `uniqid()` prefix and **every compiled template is
 *   orphaned with no error**. So the container must be produced by a runtime that already has the
 *   baked Twig state.
 * - the container row cannot be built offline. Its cache key folds in `PHP_OS` and the absolute
 *   `container_yamls` path, so a definition compiled on this machine is keyed `Darwin` + a build path
 *   and can never be read on the edge. Rewriting the key by hand was tried and produced a
 *   byte-identical render that still missed, because the versions hash differed too. The only source
 *   of a correct row is the runtime itself: boot it once, let it compile and cache, then lift the row
 *   it wrote. `--from-runtime` does that lift.
 *
 * So the full cycle is: bake 1-3, pack, boot a runtime, lift the container row, re-pack the SQL, then
 * verify. The verification is not optional and not a render: a cache hit and a cache miss render the
 * same bytes, so the acceptance check counts rows.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const DRUPAL = join(ROOT, 'drupal-src');
const SITE_DB = join(ROOT, 'assets/drupal/site.sqlite');
const args = process.argv.slice(2);
const fromRuntime = args.includes('--from-runtime');
const assumeYes = args.includes('--yes');

const LOCK = join(ROOT, 'assets/drupal/.pack.lock');

/**
 * Takes an exclusive lock on the pack, or refuses with who holds it.
 *
 * 2.6, and it is a fix for something that actually happened rather than a precaution. Two sessions
 * ran the bakes concurrently while an acceptance test was reading the result, and the migration chunk
 * count moved 101 -> 86 -> 79 underneath the test. Nothing errored; the test simply measured three
 * different databases and reported the last one. That is the failure mode this project keeps
 * producing -- plausible output, no error -- and a lock is the only thing that makes it impossible
 * rather than unlikely.
 *
 * `wx` semantics via openSync: the create-if-absent test and the claim are one syscall, so two
 * processes racing cannot both win. A stale lock names its own owner and its own age, because the
 * usual response to a mystery lock file is to delete it, and this way that decision is informed.
 */
function acquireLock(): void {
	try {
		const fd = openSync(LOCK, 'wx');
		closeSync(fd);
		writeFileSync(
			LOCK,
			JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
		);
	} catch (e) {
		if ((e as { code?: string }).code !== 'EEXIST') throw e;
		let held = 'unknown';
		let ageMs = 0;
		try {
			held = readFileSync(LOCK, 'utf8');
			ageMs = Date.now() - statSync(LOCK).mtimeMs;
		} catch {
			// the holder released it between our open and our read, which is a lost race, not an error
		}
		throw new Error(
			`another bake holds the pack lock: ${held} (${Math.round(ageMs / 1000)}s old)\n` +
				`If that process is gone, remove ${LOCK} and retry.\n` +
				'Do NOT run two bakes at once: the last one to finish silently wins and an acceptance ' +
				'test reading the pack meanwhile measures neither.'
		);
	}
}

function releaseLock(): void {
	try {
		rmSync(LOCK);
	} catch {
		// already gone; nothing to do and nothing to report
	}
}

/** runs a command, streaming nothing, and refuses to continue on a non-zero exit */
function run(cmd: string, cmdArgs: string[], cwd = ROOT): string {
	const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8' });
	if (r.status !== 0) {
		throw new Error(`${cmd} ${cmdArgs.join(' ')} exited ${r.status}\n${r.stderr || r.stdout}`);
	}
	return r.stdout ?? '';
}

/** a step's before/after size, so a bake that silently did nothing is visible */
function sizeOf(path: string): number {
	return existsSync(path) ? statSync(path).size : 0;
}

const steps: Array<{ name: string; note: string; run: () => string }> = [
	{
		name: 'snapshot',
		// site.sqlite has no producer, so a mistake here is unrecoverable without the R2 copy
		note: 'copies site.sqlite aside before anything writes to it',
		run() {
			const dir = join(ROOT, '.pack-backup');
			mkdirSync(dir, { recursive: true });
			const dest = join(dir, 'site.sqlite.bak');
			copyFileSync(SITE_DB, dest);
			return `${sizeOf(dest)} bytes -> .pack-backup/site.sqlite.bak`;
		}
	},
	{
		name: 'autoloader',
		note: 'composer dump-autoload --optimize; NEVER --classmap-authoritative, it breaks Drupal',
		run() {
			run('composer', ['dump-autoload', '--optimize', '--no-interaction'], DRUPAL);
			const n = sizeOf(join(DRUPAL, 'vendor/composer/autoload_classmap.php'));
			if (n < 100_000) {
				throw new Error(`classmap is ${n} bytes; the optimize flag did not take effect`);
			}
			return `classmap ${n} bytes`;
		}
	},
	{
		name: 'collectors',
		note: 'bake-collectors.php; needs kernel->terminate(), a plain render leaves them absent',
		run() {
			const out = run('php', [
				'-d',
				'opcache.enable_cli=0',
				'scripts/bake-collectors.php',
				'drupal-src'
			]);
			const parsed = JSON.parse(out) as { pairPresent?: boolean; gained?: string[] };
			if (!parsed.pairPresent) {
				throw new Error('the library_info + library.parsing_cache PAIR is still absent');
			}
			return `${parsed.gained?.length ?? 0} entries, pair present`;
		}
	},
	{
		name: 'twig',
		note: 'bake-twig.php, AFTER the autoloader so the recorded classmap is the shipping one',
		run() {
			if (!existsSync(join(ROOT, 'scripts/bake-twig.php')))
				return 'skipped: bake-twig.php absent';
			const out = run('php', ['scripts/bake-twig.php', 'drupal-src']);
			return out.trim().split('\n').slice(-1)[0] ?? 'ok';
		}
	},
	{
		name: 'pack',
		note: 'assets:pack; writes assets/drupal-pf, which is the prefix the runtime mounts',
		run() {
			run('bun', ['run', 'assets:pack']);
			return `core.pf.bin ${sizeOf(join(ROOT, 'assets/drupal-pf/core.pf.bin'))} bytes`;
		}
	},
	{
		name: 'sql',
		note: 'assets:sql; the chunked migration, regenerated from site.sqlite',
		run() {
			const out = run('bun', ['run', 'assets:sql']);
			const m = /chunks\s+(\d+)/.exec(out);
			return `${m?.[1] ?? '?'} chunks`;
		}
	},
	{
		name: 'driver',
		note: 'assets:driver; the packed PHP modules, the copy that executes',
		run() {
			run('bun', ['run', 'assets:driver']);
			return `${sizeOf(join(ROOT, 'assets/driver.json'))} bytes`;
		}
	}
];

console.log('# pack recipe\n');
acquireLock();
// AFTER the acquire, never before: a process that was refused the lock must not register a handler
// that deletes the holder's lock on its way out
process.on('exit', releaseLock);

const results: Array<[string, string]> = [];
for (const step of steps) {
	process.stdout.write(`${step.name.padEnd(11)} `);
	try {
		const detail = step.run();
		results.push([step.name, detail]);
		console.log(detail);
	} catch (e) {
		console.log(`FAILED\n\n${(e as Error).message}`);
		console.log('\nsite.sqlite is unchanged unless a later step wrote it; the snapshot is in');
		console.log('.pack-backup/site.sqlite.bak and R2 has a copy at');
		console.log('drupflare-cdn/assets/drupal/site.sqlite');
		console.log(
			'It can also be rebuilt now: bun run build:site-db <out> && bun run check:site-db <out>'
		);
		// the exit handler releases the lock, so a failed bake does not leave the pack claimed
		process.exit(1);
	}
}

console.log('\n# what is NOT done by this script\n');
console.log('The container definition cannot be produced offline: its key folds in PHP_OS and the');
console.log(
	'absolute container_yamls path, so anything compiled here is keyed Darwin + a build path'
);
console.log(
	'and is unreadable on the edge. Rewriting the key by hand renders byte-identically and'
);
console.log('STILL misses, which is why that route was abandoned.\n');
console.log('To finish the pack, boot a runtime once and lift the row it writes:\n');
console.log('  bunx wrangler dev -c wrangler.jsonc --port 8801 --var PW_DIAGNOSTICS:1');
console.log('  curl "localhost:8801/migrate?site=bake"   # repeat until done:true');
console.log('  curl -o /dev/null "localhost:8801/serve?site=bake&path=/"');
console.log('  bun scripts/bake-pack.ts --from-runtime   # lifts via node, bun lacks node:sqlite');
console.log('  bun run assets:sql\n');
console.log('# acceptance, and it is NOT a render\n');
console.log(
	'A cache hit and a cache miss render the same 12,304 bytes. Boot a FRESH site, then in'
);
console.log('the newest .wrangler/state/v3/do/*/*.sqlite assert BOTH:\n');
console.log('  SELECT COUNT(*) FROM cache_container            -- must be 1, not 2');
console.log("  SELECT COUNT(*) FROM cache_default WHERE cid LIKE 'twig:%'   -- must not increase");
console.log('\nThe first catches a container miss. The second catches the silent coupling: a');
console.log(
	'container whose %twig_extension_hash% disagrees with the State row mints a fresh prefix'
);
console.log('and orphans every compiled template with no error at all.');

if (fromRuntime) {
	console.log('\n# --from-runtime: lifting the container row\n');
	const lift = run('node', ['scripts/lift-container.ts']);
	console.log(lift.trim());
}

if (!assumeYes) {
	console.log('\nsite.sqlite was written by the collectors step. Snapshot: .pack-backup/');
}
