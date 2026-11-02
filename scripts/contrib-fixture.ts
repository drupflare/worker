import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { GENERATED_COLLISIONS } from '../src/ops/generated/modules';
import { SHIPPING_PACK_CONTRIB, moduleTable } from '../src/ops/module-table';
import { BLOCKED_MODULES } from '../tests/helpers/contrib-blocked';
import {
	composerFailure,
	digestsOf as digestsOfFiles,
	mismatches,
	renderSummary,
	resolvePhases,
	restoreFiles,
	snapshotFiles,
	summarise,
	usageShare,
	type Phase,
	type Report
} from './contrib-phases';
import { censusPackages } from './install-census';

/**
 * Runs the contrib lane against a FIXTURE pack, then puts the shipping pack back.
 *
 *   bun scripts/contrib-fixture.ts [-- <extra vitest args>]   build, run the lane, restore
 *   bun scripts/contrib-fixture.ts --mount                    build and LEAVE it mounted
 *   bun scripts/contrib-fixture.ts --restore                  put the shipping pack back
 *   bun scripts/contrib-fixture.ts --skip-collisions          run the base build only
 *   bun scripts/contrib-fixture.ts --phases-only              run the collision phases only
 *
 * Contrib is a dev dependency here: `pack-drupal.ts` gates `modules/contrib` behind `PACK_CONTRIB=1`
 * so the shipping artifact stays small, and the `verified` rows are established against a build that
 * has the modules. Without a lane that mounts one, `contrib-verify.spec.ts` answers every fixture row
 * with a skip -- and a skip and a pass are indistinguishable from the outside.
 *
 * **THE SHIPPING PACK IS NOT IN GIT AND NOTHING ELSE REPRODUCES IT CHEAPLY.** `assets/drupal-pf` is
 * 13 MB, gitignored, and the fixture build writes to that exact path because the mount prefix is
 * `drupal-pf`. So the swap is bracketed: the shipping pair is copied to {@link BACKUP} and sha256'd
 * first, the restore runs in a `finally` and on SIGINT/SIGTERM, and the hashes are compared
 * afterwards. A leftover backup from a killed run is restored on the next start rather than
 * overwritten, which is the case a plain `finally` cannot cover.
 *
 * **A SKIP IN THIS RUN IS A FAILURE.** The vitest child gets `CONTRIB_FIXTURE=1`, which makes
 * `contrib-pack.ts` throw for any module the mounted pack lacks, whether or not the pack looks like a
 * fixture. Without it, a census that failed to install left a pack equal to the shipping one and the
 * run read "2 passed, 66 skipped" with exit 0. The run ends by counting both reports, writes
 * `.contrib-fixture/summary.md`, and exits 1 on any failed row, any row nothing reached, and any `verified` registry
 * module with no passing row.
 *
 * `tests/node/module-table.spec.ts` compares the pack index against `SHIPPING_PACK_CONTRIB` and
 * fails while a fixture pack is mounted -- correctly, since the mounted pack is then not the shipping
 * one. That is why this runs the workers project alone and never `bun run test`.
 */

const ROOT = resolve(import.meta.dirname, '..');
const PACK = join(ROOT, 'assets', 'drupal-pf');
const BACKUP = join(ROOT, '.contrib-fixture', 'shipping');
const BUILD = join(ROOT, '.contrib-fixture', 'build');
const MEMBERS = ['core.pf.bin', 'core.pf.json'] as const;
const SPECS = [
	'tests/integration/contrib-verify.spec.ts',
	'tests/integration/contrib-generic.spec.ts'
];
const DRUPAL_SRC = join(ROOT, 'drupal-src');
const LOCK_FILES = [join(DRUPAL_SRC, 'composer.json'), join(DRUPAL_SRC, 'composer.lock')];
const LOCK_BACKUP = join(ROOT, '.contrib-fixture', 'composer');
const ASSET_CAP = 25 * 1024 * 1024;
const REPORTS = join(ROOT, '.contrib-fixture', 'reports');
const SUMMARY = join(ROOT, '.contrib-fixture', 'summary.md');
const USAGE = join(ROOT, 'config', 'contrib-usage.json');

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const digests = (dir: string) => MEMBERS.map((m) => `${m} ${sha(join(dir, m))}`);
const present = (dir: string) => MEMBERS.every((m) => existsSync(join(dir, m)));

function run(cmd: string, args: string[], env: Record<string, string> = {}): void {
	const out = spawnSync(cmd, args, {
		cwd: ROOT,
		stdio: 'inherit',
		env: { ...process.env, ...env }
	});
	if (out.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${out.status}`);
}

function composer(args: string[]): void {
	const flags = args[0] === 'config' ? [] : ['--no-interaction', '--no-progress'];
	const out = spawnSync('composer', [...args, ...flags], {
		cwd: DRUPAL_SRC,
		stdio: ['inherit', 'inherit', 'pipe'],
		encoding: 'utf8'
	});
	process.stderr.write(out.stderr);
	if (out.status !== 0) throw composerFailure(args, out.status, out.stderr);
}

/** runs the installed vitest and reports whether it passed, so one red phase does not skip the next */
function vitest(extra: string[], report: string): boolean {
	const json = ['--reporter=default', '--reporter=json', `--outputFile.json=${report}`];
	// the INSTALLED vitest; bunx resolves from the registry and CI ran 5.0.0 against a 4.1.11 pin
	const out = spawnSync(
		'./node_modules/.bin/vitest',
		['run', '--project=workers', ...SPECS, ...json, ...extra],
		{ cwd: ROOT, stdio: 'inherit', env: { ...process.env, CONTRIB_FIXTURE: '1' } }
	);
	if (out.status !== 0) return false;
	// a filter that matched nothing exits 0 with every test skipped, which is not a pass
	const { numPassedTests = 0 } = JSON.parse(readFileSync(report, 'utf8')) as {
		numPassedTests?: number;
	};
	return numPassedTests > 0;
}

/** copies the two members, leaving anything else in the target alone */
function swapIn(from: string, to: string): void {
	mkdirSync(to, { recursive: true });
	for (const m of MEMBERS) cpSync(join(from, m), join(to, m));
}

function restore(): void {
	if (!present(BACKUP)) return;
	swapIn(BACKUP, PACK);
	const back = digests(PACK).join('\n');
	const kept = digests(BACKUP).join('\n');
	if (back !== kept) throw new Error(`restore did not match:\n${back}\nwanted:\n${kept}`);
	rmSync(BACKUP, { recursive: true, force: true });
	console.error(`[contrib-fixture] shipping pack restored and verified\n${back}`);
}

/**
 * Puts composer.json and composer.lock back byte for byte, then reinstalls from that lock.
 *
 * A phase removes and requires packages, so the tree under `drupal-src` no longer matches the
 * lock the base build used. Restoring the two files is not enough; `composer install` is what
 * removes the phase's packages and brings the collider back.
 */
function restoreLock(): void {
	if (!existsSync(join(LOCK_BACKUP, 'composer.lock'))) return;
	restoreFiles(LOCK_FILES, LOCK_BACKUP);
	composer(['install']);
	const bad = mismatches(LOCK_FILES, LOCK_BACKUP);
	if (bad.length > 0)
		throw new Error(`composer files changed during the restore: ${bad.join(', ')}`);
	rmSync(LOCK_BACKUP, { recursive: true, force: true });
	console.error(
		`[contrib-fixture] composer files restored and verified\n${digestsOfFiles(LOCK_FILES).join('\n')}`
	);
}

function runPhase(phase: Phase): boolean {
	console.error(`[contrib-fixture] phase ${phase.module}: removing ${phase.remove.join(' ')}`);
	composer(['remove', '--dev', '--no-audit', ...phase.remove]);
	for (const plugin of phase.plugins) {
		composer(['config', '--no-plugins', `allow-plugins.${plugin}`, 'true']);
	}
	composer(['require', '--dev', '-W', '--no-audit', phase.require ?? phase.module]);
	rmSync(BUILD, { recursive: true, force: true });
	mkdirSync(BUILD, { recursive: true });
	run('node', ['scripts/pack-drupal.ts', 'drupal-src', 'assets/drupal/core.list.json', BUILD], {
		PACK_INDEX: '1',
		PACK_CONTRIB: '1'
	});
	run('bun', ['scripts/pack-perfile.ts', 'drupal-src', BUILD, join(BUILD, 'core.json')]);
	const size = statSync(join(BUILD, 'core.pf.bin')).size;
	if (size > ASSET_CAP) {
		throw new Error(
			`the ${phase.module} pack is ${size} bytes against the ${ASSET_CAP} asset cap; ` +
				'declare `sheds` on the module in config/modules.yml'
		);
	}
	swapIn(BUILD, PACK);
	const short = phase.module.replace(/^drupal\//, '');
	return vitest(['-t', `(^| )${short}: `], join(REPORTS, `${short}.json`));
}

const readReport = (path: string): Report =>
	existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Report) : {};

function summarize(plan: { phases: Phase[] }, strict: boolean, ranBase: boolean): boolean {
	const phases = Object.fromEntries(
		plan.phases.map((p) => {
			const short = p.module.replace(/^drupal\//, '');
			return [short, readReport(join(REPORTS, `${short}.json`))];
		})
	);
	const expected = moduleTable()
		.filter((r) => r.state === 'verified' && !SHIPPING_PACK_CONTRIB.includes(r.name))
		.map((r) => r.name.replace(/^[^/]+\//, ''));
	const s = summarise(
		ranBase ? readReport(join(REPORTS, 'base.json')) : undefined,
		phases,
		strict,
		expected,
		BLOCKED_MODULES,
		plan.phases.filter((p) => p.require).map((p) => p.module.replace(/^drupal\//, ''))
	);
	const usage = existsSync(USAGE)
		? (JSON.parse(readFileSync(USAGE, 'utf8')) as { counts: Record<string, number> })
		: undefined;
	const text = renderSummary(s, usage ? usageShare(usage.counts, s.verified) : undefined);
	writeFileSync(SUMMARY, text);
	console.error(`[contrib-fixture] ${text}`);
	return s.failed === 0 && s.unreached.length === 0 && s.missing.length === 0;
}

const argv = process.argv.slice(2);
const mountOnly = argv.includes('--mount');
const skipCollisions = argv.includes('--skip-collisions');
const phasesOnly = argv.includes('--phases-only');
const restoreOnly = argv.includes('--restore');
const passthrough = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : [];

// A backup left behind means the previous run mounted a fixture and did not put the shipping pack
// back -- either an intended `--mount`, or a kill between the two. Restoring rather than overwriting
// is the difference between recovering the artifact and losing it, so both cases restore first.
if (existsSync(join(LOCK_BACKUP, 'composer.lock'))) {
	console.error(
		'[contrib-fixture] a phase was interrupted; restoring composer.json and composer.lock'
	);
	restoreLock();
}
if (present(BACKUP)) {
	console.error('[contrib-fixture] a mounted fixture is in place; restoring the shipping pack');
	restore();
}
if (restoreOnly) process.exit(0);
if (!present(PACK)) {
	console.error(
		`no shipping pack at ${PACK}. This lane swaps one out and back; it will not build one.\n` +
			'  bun run hydrate            (from a release payload)\n' +
			'  bun run assets:core && bun run assets:pack   (from drupal-src)'
	);
	process.exit(1);
}

swapIn(PACK, BACKUP);
writeFileSync(join(BACKUP, 'sha256.txt'), digests(BACKUP).join('\n') + '\n');
console.error(`[contrib-fixture] shipping pack saved to ${BACKUP}\n${digests(BACKUP).join('\n')}`);

const plan = resolvePhases(censusPackages(), GENERATED_COLLISIONS);
const runPhases = !mountOnly && !skipCollisions && plan.phases.length > 0;
if (runPhases)
	console.error(`[contrib-fixture] ${snapshotFiles(LOCK_FILES, LOCK_BACKUP).join('\n')}`);

const onSignal = () => {
	restore();
	restoreLock();
	process.exit(130);
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

try {
	mkdirSync(BUILD, { recursive: true });
	rmSync(REPORTS, { recursive: true, force: true });
	mkdirSync(REPORTS, { recursive: true });
	rmSync(SUMMARY, { force: true });
	// node rather than bun for pack-drupal, for the reason its own header gives: the two runtimes
	// emit different deflate streams
	run('node', ['scripts/pack-drupal.ts', 'drupal-src', 'assets/drupal/core.list.json', BUILD], {
		PACK_INDEX: '1',
		PACK_CONTRIB: '1'
	});
	run('bun', ['scripts/pack-perfile.ts', 'drupal-src', BUILD, join(BUILD, 'core.json')]);
	swapIn(BUILD, PACK);
	console.error(`[contrib-fixture] fixture pack mounted\n${digests(PACK).join('\n')}`);

	if (mountOnly) {
		console.error(
			'[contrib-fixture] left mounted. The shipping pack is in .contrib-fixture/shipping;\n' +
				'                  put it back with: bun scripts/contrib-fixture.ts --restore'
		);
	} else {
		let green = phasesOnly || vitest(passthrough, join(REPORTS, 'base.json'));
		if (runPhases) {
			// the colliders' own rows ran in the base build above, before any phase removes them
			for (const phase of plan.phases) {
				try {
					green = runPhase(phase) && green;
				} catch (error) {
					console.error(`[contrib-fixture] ${(error as Error).message}`);
					green = false;
				}
			}
		}
		const counted = summarize(
			runPhases ? plan : { phases: [] },
			passthrough.length === 0,
			!phasesOnly
		);
		if (!green || !counted) process.exitCode = 1;
	}
} finally {
	if (!mountOnly) restore();
	if (runPhases) restoreLock();
}
