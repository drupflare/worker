/**
 * Publishes what `bun run release:payload` left in `dist/` to the CDN bucket.
 *
 * ```sh
 * bun scripts/publish-payload.ts --release            # payloads/v<package.json version>/
 * bun scripts/publish-payload.ts --release --tag=v1.0.0-rc1
 * bun scripts/publish-payload.ts --dev                # payloads/dev-<current branch>/
 * bun scripts/publish-payload.ts --dev --branch=master
 * bun scripts/publish-payload.ts --dev --dry-run      # print the puts, touch nothing
 * ```
 *
 * A RELEASE PREFIX IS WRITTEN ONCE AND A DEV PREFIX IS OVERWRITTEN ON EVERY PUSH, which is the whole
 * difference between the two lines and is why neither needs a version in its key beyond the prefix.
 * The dev line follows composer's `dev-master` spelling because it behaves the same way: it names a
 * moving branch tip, not an immutable artifact.
 *
 * `wrangler r2 object put` is the only write path here, the same one `scripts/backup-cdn.ts` uses --
 * the S3 endpoint would need a key pair nobody has. What this does NOT do is touch
 * `cdn-manifest.json`: that manifest is the backup set for artifacts nothing can regenerate, and a
 * payload is output CI rebuilds from a commit. Mixing the two is what produced three divergent
 * copies of the one file that mattered.
 *
 * @see scripts/payload-cdn.ts for the key layout both this and the resolver derive from
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUCKET } from './backup-cdn';
import {
	devKeyBase,
	PUBLISHED_SIDECARS,
	readSums,
	releaseKeyBase,
	type PayloadKind
} from './payload-cdn';

const root = process.cwd();

function flag(name: string): boolean {
	return process.argv.includes(`--${name}`);
}

function arg(name: string): string | undefined {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit?.slice(name.length + 3);
}

/** the branch a dev publish is keyed to; CI hands it over rather than being guessed at */
function branch(): string {
	const given = arg('branch') ?? process.env['GITHUB_REF_NAME'];
	if (given) return given;
	return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
		cwd: root,
		encoding: 'utf8'
	}).trim();
}

/** guessed from the extension so a browser hitting the URL gets something sensible */
function contentType(name: string): string {
	if (name.endsWith('.tar.gz')) return 'application/gzip';
	if (name.endsWith('.json')) return 'application/json';
	return 'text/plain';
}

function put(key: string, file: string, dryRun: boolean): void {
	const args = [
		'wrangler',
		'r2',
		'object',
		'put',
		`${BUCKET}/${key}`,
		`--file=${file}`,
		`--content-type=${contentType(key)}`,
		'--remote'
	];
	if (dryRun) {
		console.log(`would put ${BUCKET}/${key}`);
		return;
	}
	execFileSync('bunx', args, { cwd: root, stdio: 'inherit' });
	console.log(`put ${BUCKET}/${key}`);
}

/**
 * Everything a publish uploads, resolved against `dist/`.
 *
 * The tarball is named by `SHA256SUMS` rather than derived from a version, so this cannot publish a
 * tarball under a key that disagrees with the digest beside it -- the failure mode that would make a
 * consumer's verification fail on bytes that were fine.
 */
export function plan(
	dist: string,
	keyBase: string
): { key: string; file: string; required: boolean }[] {
	const sumsPath = join(dist, 'SHA256SUMS');
	if (!existsSync(sumsPath)) {
		throw new Error(`${sumsPath} does not exist; run \`bun run release:payload\` first`);
	}
	const { name } = readSums(readFileSync(sumsPath, 'utf8'));
	const tarball = join(dist, name);
	if (!existsSync(tarball)) {
		throw new Error(`SHA256SUMS names ${name}, which is not in ${dist}`);
	}

	const out = [{ key: `${keyBase}/${name}`, file: tarball, required: true }];
	for (const side of PUBLISHED_SIDECARS) {
		out.push({
			key: `${keyBase}/${side}`,
			file: join(dist, side),
			required: side === 'SHA256SUMS'
		});
	}
	return out;
}

function main(): void {
	const kind: PayloadKind = flag('dev') ? 'dev' : 'release';
	if (!flag('dev') && !flag('release')) {
		throw new Error('pass --release or --dev');
	}

	const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;
	const keyBase =
		kind === 'dev' ? devKeyBase(branch()) : releaseKeyBase(arg('tag') ?? `v${version}`);

	// --dist, so a already-published release can be mirrored from ITS OWN bytes rather than from a
	// local rebuild: the two differ, and a key under `v1.0.0` holding bytes no release carried is
	// the shape this project keeps finding
	const dist = arg('dist') ?? join(root, 'dist');
	const dryRun = flag('dry-run');
	console.log(`publishing ${dist} -> ${BUCKET}/${keyBase}`);

	for (const item of plan(dist, keyBase)) {
		if (!existsSync(item.file)) {
			if (item.required) throw new Error(`${item.file} is missing and is not optional`);
			// `metrics.json` comes from the metrics lane, so a release job's dist legitimately lacks it
			console.log(`skipping ${item.key}: not in dist`);
			continue;
		}
		put(item.key, item.file, dryRun);
	}
}

if (import.meta.main) main();
