import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Runs the contrib lane against a FIXTURE pack, then puts the shipping pack back.
 *
 *   bun scripts/contrib-fixture.ts [-- <extra vitest args>]   build, run the lane, restore
 *   bun scripts/contrib-fixture.ts --mount                    build and LEAVE it mounted
 *   bun scripts/contrib-fixture.ts --restore                  put the shipping pack back
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
 * `tests/node/module-table.spec.ts` compares the pack index against `SHIPPING_PACK_CONTRIB` and
 * fails while a fixture pack is mounted -- correctly, since the mounted pack is then not the shipping
 * one. That is why this runs the workers project alone and never `bun run test`.
 */

const ROOT = resolve(import.meta.dirname, '..');
const PACK = join(ROOT, 'assets', 'drupal-pf');
const BACKUP = join(ROOT, '.contrib-fixture', 'shipping');
const BUILD = join(ROOT, '.contrib-fixture', 'build');
const MEMBERS = ['core.pf.bin', 'core.pf.json'] as const;
const SPEC = 'tests/integration/contrib-verify.spec.ts';

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

const argv = process.argv.slice(2);
const mountOnly = argv.includes('--mount');
const restoreOnly = argv.includes('--restore');
const passthrough = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : [];

// A backup left behind means the previous run mounted a fixture and did not put the shipping pack
// back -- either an intended `--mount`, or a kill between the two. Restoring rather than overwriting
// is the difference between recovering the artifact and losing it, so both cases restore first.
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

const onSignal = () => {
	restore();
	process.exit(130);
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

try {
	mkdirSync(BUILD, { recursive: true });
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
		run('bunx', ['vitest', 'run', '--project=workers', SPEC, ...passthrough]);
	}
} finally {
	if (!mountOnly) restore();
}
