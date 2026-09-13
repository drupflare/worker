/**
 * Turns a clean checkout into a deployable tree.
 *
 * ```sh
 * bun run hydrate                              # the payload for package.json's version
 * bun run hydrate -- --tag=v1.0.1              # a specific release
 * bun run hydrate -- --from=dist/x.tar.gz      # a local tarball, for testing the payload
 * bun run hydrate -- --payload-only            # refuse to build from source; fail instead
 * bun run hydrate -- --from-source             # skip the payload and build every artifact locally
 * ```
 *
 * There are TWO routes to the same tree and this script picks between them.
 *
 * **The payload route is the default and the one that matters.** A release asset on a public
 * repository is a plain HTTPS GET, so it needs no Docker, no `gh` auth, no PHP and no Cloudflare
 * credential -- which is exactly what makes the Deploy to Cloudflare button viable, since its build
 * command is `bun install && bun run hydrate` and Workers Builds has no Docker to build with.
 *
 * **The source route is the fallback**, and it exists because the payload route has a hole a button
 * cannot cover: a checkout of a commit no release was cut from, and the window before the first
 * release exists at all. It is `scripts/build-local.ts`, it takes minutes rather than seconds, and it
 * needs a real toolchain -- so it announces itself rather than happening quietly, and
 * `--payload-only` turns it off for any lane that must not silently take it.
 *
 * Every payload byte is checked against the manifest's sha256 before it lands, and nothing outside
 * `assets/` and `.interp/` is written at all. `vendor/` is unreachable from here by construction: it
 * holds 14 hand-built binaries that exist on one machine.
 *
 * @see scripts/release-payload.ts for the producing half
 * @see scripts/build-local.ts for the source route
 * @see docs/building-from-source.md
 */

import { execFileSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ORIGINS } from './backup-cdn';
import { REENTRY_VAR, reentered } from './hydrating';
import { devKeyBase, payloadBaseUrl, readSums, releaseKeyBase } from './payload-cdn';
import { PAYLOAD_ROOTS, payloadName, sha256, type PayloadManifest } from './release-payload';

/** where a payload is published, so the default path needs no argument */
const REPO = process.env.DRUPFLARE_REPO ?? 'drupflare/worker';

/**
 * Whether a manifest path is safe to write.
 *
 * The traversal check is not theoretical: a payload is downloaded over the network, and `tar` will
 * happily write `../../vendor/` if a member says so.
 */
export function isSafePayloadPath(path: string): boolean {
	if (path.startsWith('/') || path.includes('..')) return false;
	return PAYLOAD_ROOTS.some((root) => path.startsWith(root));
}

/** Reads and validates a payload manifest, without touching the tree. */
export function readManifest(path: string): PayloadManifest {
	const manifest = JSON.parse(readFileSync(path, 'utf8')) as PayloadManifest;
	if (manifest.version !== 1) {
		throw new Error(`payload manifest version ${manifest.version} is not supported`);
	}
	const unsafe = manifest.files.map((f) => f.path).filter((p) => !isSafePayloadPath(p));
	if (unsafe.length) {
		throw new Error(`payload names paths outside ${PAYLOAD_ROOTS.join(' and ')}: ${unsafe}`);
	}
	return manifest;
}

/**
 * Verifies an extracted payload against its own manifest.
 *
 * @returns every discrepancy, empty when the extraction is exactly what the manifest describes.
 */
export function verifyExtracted(dir: string, manifest: PayloadManifest): string[] {
	const problems: string[] = [];
	for (const file of manifest.files) {
		const abs = join(dir, file.path);
		if (!existsSync(abs)) {
			problems.push(`${file.path} is missing from the payload`);
			continue;
		}
		const bytes = statSync(abs).size;
		if (bytes !== file.bytes) {
			problems.push(`${file.path} is ${bytes} bytes, the manifest says ${file.bytes}`);
			continue;
		}
		const digest = sha256(abs);
		if (digest !== file.sha256) {
			problems.push(`${file.path} sha256 ${digest} != ${file.sha256}`);
		}
	}
	return problems;
}

/** where a payload came from, or that there is none to be had */
export type PayloadSource =
	| { kind: 'given'; path: string }
	| { kind: 'dist'; path: string }
	| { kind: 'release'; tag: string; base: string; via: PayloadVia }
	| { kind: 'none'; tag: string; reason: string };

/** which host answered, and whether the bytes are a cut release or a branch tip */
export type PayloadVia = 'cdn' | 'github' | 'cdn-dev';

/** the branch whose rolling payload answers when no release does */
function currentBranch(root: string): string {
	const named = process.env.DRUPFLARE_DEV_BRANCH?.trim();
	if (named) return named;
	try {
		return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
			cwd: root,
			encoding: 'utf8'
		}).trim();
	} catch {
		return 'master';
	}
}

/**
 * Every network base to try for a tag, in order, each paired with what answering it would mean.
 *
 * THE CDN OUTRANKS THE RELEASE and that ordering is measured rather than preferred: Workers Builds
 * hung for its whole job timeout on a release asset body in a container that had pulled 13.4 MB
 * from this CDN 0.6 s earlier. The release is still the canonical artifact and still the fallback,
 * so a CDN that is down or behind costs a retry rather than the deploy.
 *
 * The dev line comes last and never displaces a release. A checkout sitting on a commit no release
 * was cut from used to have only the source route, which needs a PHP toolchain the deploy container
 * does not have -- so `dev-<branch>` is what turns that case from "build for minutes, if you can"
 * into "download the tip". `master` is tried after the checkout's own branch because a fork or a
 * detached HEAD names a branch nothing publishes.
 */
function networkBases(root: string, tag: string): { base: string; via: PayloadVia }[] {
	const bases: { base: string; via: PayloadVia }[] = [];
	for (const origin of ORIGINS) {
		bases.push({ base: payloadBaseUrl(origin, releaseKeyBase(tag)), via: 'cdn' });
	}
	bases.push({ base: `https://github.com/${REPO}/releases/download/${tag}`, via: 'github' });

	const branches = [currentBranch(root), 'master'];
	for (const branch of [...new Set(branches)]) {
		for (const origin of ORIGINS) {
			bases.push({ base: payloadBaseUrl(origin, devKeyBase(branch)), via: 'cdn-dev' });
		}
	}
	return bases;
}

/**
 * Picks the payload to hydrate from, cheapest first.
 *
 * A LOCAL `dist/` tarball outranks the network, because that is what
 * `bun run release:payload` just produced and re-downloading a release to test the build that made it
 * would test the wrong bytes. A release is probed rather than inferred from `git tag`: a shallow clone
 * has no tags, and the tags a clone does have say nothing about whether the asset was ever attached.
 *
 * EVERY NETWORK CANDIDATE IS PROBED BY ITS `SHA256SUMS` rather than by a tarball name. The name is
 * then read back out of that file, which is what lets the rolling dev line resolve at all: it is
 * built from whatever `package.json` said at that commit and a checkout cannot know which version
 * that was.
 *
 * @param probe - answers whether a URL exists; injected so the routing is testable without a network
 */
export async function resolvePayloadSource(
	root: string,
	tag: string,
	given: string | undefined,
	probe: (url: string) => Promise<boolean>
): Promise<PayloadSource> {
	if (given) {
		if (!existsSync(given)) throw new Error(`--from=${given} does not exist`);
		return { kind: 'given', path: given };
	}

	const local = join(root, 'dist', payloadName(tag.replace(/^v/, '')));
	if (existsSync(local)) return { kind: 'dist', path: local };

	for (const { base, via } of networkBases(root, tag)) {
		if (await probe(`${base}/SHA256SUMS`)) return { kind: 'release', tag, base, via };
	}

	return {
		kind: 'none',
		tag,
		reason:
			`no ${local} on disk, and no ${tag} payload on the CDN, on ${REPO}'s releases, ` +
			`or on the dev line for ${currentBranch(root)}`
	};
}

function arg(name: string, fallback?: string): string | undefined {
	const hit = process.argv.find((a: string) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
}

/** one attempt's budget; the failure this bounds is a body that stalls, not a slow link */
const DOWNLOAD_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 30_000;
const DOWNLOAD_ATTEMPTS = 3;

/**
 * Downloads a URL to a path, failing on any non-200 rather than writing an error page to disk.
 *
 * **A BARE `fetch()` HERE HANGS THE BUILD INSTEAD OF FAILING IT**, measured on Cloudflare Workers
 * Builds: the job printed `fetching` and stopped dead. {@link assetExists} had already HEADed the
 * same URL through its redirect, so the host resolved and only the body stalled -- and with no
 * signal there was nothing to end it, so the platform's own job timeout was the only thing that
 * could, which names nothing and reads as a slow download rather than an unreachable one.
 *
 * The body is buffered rather than streamed into {@link Bun.write} so the signal covers reading it
 * too, and so a short read is caught here by length instead of two steps later as a sha256 mismatch,
 * which reads as a corrupt release.
 */
async function download(url: string, to: string): Promise<void> {
	let last = 'no attempt was made';
	for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
		const started = Date.now();
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			const declared = Number(res.headers.get('content-length') ?? 0);
			const body = new Uint8Array(await res.arrayBuffer());
			if (declared > 0 && body.byteLength !== declared) {
				throw new Error(`read ${body.byteLength} bytes of a declared ${declared}`);
			}
			await Bun.write(to, body);
			return;
		} catch (e) {
			const secs = Math.round((Date.now() - started) / 1000);
			last = `${(e as Error).message}, after ${secs}s`;
			console.log(
				`hydrate: attempt ${attempt}/${DOWNLOAD_ATTEMPTS} for ${url} failed: ${last}`
			);
		}
	}
	throw new Error(
		`could not download ${url}: ${last}. The interpreter restore in \`bun install\` reaches the ` +
			`CDN from the same place, so a failure only here is specific to the release asset host ` +
			`rather than to outbound HTTP. Hydrate from a local tarball with --from=<path> instead.`
	);
}

/** whether a release asset is actually there, without pulling 22 MB to find out */
async function assetExists(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, {
			method: 'HEAD',
			redirect: 'follow',
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** Extracts a verified payload over the checkout, writing only what the manifest names. */
function landPayload(root: string, tarball: string, work: string): PayloadManifest {
	const staged = join(work, 'staged');
	mkdirSync(staged, { recursive: true });
	execFileSync('tar', ['-xzf', resolve(tarball), '-C', staged], { maxBuffer: 1 << 28 });

	const manifest = readManifest(join(staged, 'manifest.json'));
	const problems = verifyExtracted(staged, manifest);
	if (problems.length) {
		throw new Error(`the payload does not match its manifest:\n  ${problems.join('\n  ')}`);
	}

	for (const file of manifest.files) {
		const dest = join(root, file.path);
		mkdirSync(dirname(dest), { recursive: true });
		cpSync(join(staged, file.path), dest);
	}
	return manifest;
}

/** Hands over to the source route, which prints its own plan and preflight. */
function buildFromSource(root: string, forwarded: string[]): void {
	execFileSync('bun', ['scripts/build-local.ts', ...forwarded], {
		cwd: root,
		stdio: 'inherit',
		maxBuffer: 1 << 28
	});
}

/** Downloads, verifies and lands a payload that is known to exist. */
async function hydrateFrom(
	root: string,
	tag: string,
	found: Exclude<PayloadSource, { kind: 'none' }>
): Promise<void> {
	const work = mkdtempSync(join(tmpdir(), 'drupflare-hydrate-'));
	try {
		let tarball: string;
		if (found.kind === 'release') {
			// SUMS FIRST, because it is what NAMES the tarball. Deriving the name from the tag is
			// right for a cut release and impossible for the dev line, whose version is whatever
			// the branch tip happened to carry
			const sums = join(work, 'SHA256SUMS');
			await download(`${found.base}/SHA256SUMS`, sums);
			const { sha256: expected, name: asset } = readSums(readFileSync(sums, 'utf8'));

			tarball = join(work, asset);
			console.log(`fetching ${found.base}/${asset} (${found.via})`);
			await download(`${found.base}/${asset}`, tarball);

			const actual = sha256(tarball);
			if (expected !== actual) {
				throw new Error(`SHA256SUMS says ${expected}, the download is ${actual}`);
			}
			console.log(`tarball sha256 ${actual} matches SHA256SUMS`);
			if (found.via === 'cdn-dev') {
				// NAMING THE BRANCH IS THE POINT: the resolver tries `master` after the checkout's
				// own branch, so a fork or a detached HEAD legitimately lands on a line it is not
				// on, and a message that says only "a branch tip" makes that substitution silent
				const line = found.base.slice(found.base.lastIndexOf('/') + 1);
				console.log(
					`this is the ${line} BRANCH TIP rather than a cut release: no release carried ` +
						'these bytes, and the next push to that branch replaces them'
				);
			}
		} else {
			tarball = found.path;
			console.log(`hydrating from ${tarball} (${found.kind})`);
		}

		const manifest = landPayload(root, tarball, work);
		console.log(
			`hydrated ${manifest.totals.files} files, ${manifest.totals.bytes} bytes, ` +
				`from ${manifest.release} (${manifest.commit.slice(0, 7)})`
		);
		console.log(`interpreter: ${manifest.interpreter.join(', ')}`);
		console.log('the tree is deployable now: bunx wrangler deploy -c wrangler.jsonc');
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/**
 * The artifacts that make a tree deployable, and whether they are all there.
 *
 * **HYDRATING A TREE THAT IS ALREADY HYDRATED OVERWRITES IT**, and the payload it overwrites with is
 * whatever release `package.json`'s version names -- so a developer who has just repacked
 * `assets/driver.json` gets the published copy back, silently. That is the same shape as
 * `restore-artifacts.ts` reverting a hand edit to `site.sqlite`, and it becomes a live hazard the
 * moment `wrangler.jsonc` names this as its build command: every `wrangler deploy` would do it.
 *
 * So a complete tree is left alone unless `--force` says otherwise.
 */
const HYDRATED_MARKERS = [
	'assets/driver.json',
	'assets/prefill.json',
	'assets/core',
	'assets/drupal-pf/core.pf.json',
	'assets/drupal-pf/core.pf.bin',
	'assets/drupal-sql/manifest.json',
	'assets/drupal/twig-bake.json'
] as const;

/** the marker paths a tree is missing, so a refusal can NAME them rather than say "incomplete" */
export function missingMarkers(root: string, exists = existsSync): string[] {
	return HYDRATED_MARKERS.filter((p) => !exists(join(root, p)));
}

async function main(): Promise<number> {
	const root = resolve(import.meta.dirname, '..');
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
		version?: string;
	};
	const tag = arg('tag', `v${pkg.version}`)!;
	const payloadOnly = process.argv.includes('--payload-only');
	const fromSource = process.argv.includes('--from-source');
	const force = process.argv.includes('--force');

	if (reentered()) {
		console.log(`${REENTRY_VAR} is set; a build is already producing these artifacts.`);
		return 0;
	}

	const missing = missingMarkers(root);
	if (missing.length === 0 && !force && !fromSource) {
		console.log('the tree is already hydrated; nothing to do.');
		console.log('pass --force to replace it with the published payload anyway.');
		return 0;
	}
	// --force reaches the source route, where it means "rebuild every step"; the payload route has
	// nothing to force, since it overwrites whatever is there anyway
	const forwarded = process.argv
		.slice(2)
		.filter((a: string) => a === '--force' || a.startsWith('--only='));

	if (fromSource && payloadOnly) {
		console.error('--from-source and --payload-only are opposites; pass one or neither');
		return 2;
	}
	if (fromSource) {
		buildFromSource(root, forwarded);
		return 0;
	}

	const source = await resolvePayloadSource(root, tag, arg('from'), assetExists);
	if (source.kind === 'none') {
		if (payloadOnly) {
			console.error(`no payload to hydrate from: ${source.reason}.`);
			console.error(
				'\n--payload-only forbids the source route. Drop it to build the artifacts locally\n' +
					'(`bun run build:local`), point --from= at a tarball, or cut a release first.\n' +
					'See docs/building-from-source.md for what each route needs.'
			);
			return 1;
		}
		console.log(`${source.reason}.`);
		console.log('falling back to the source route; this needs a toolchain and takes minutes.');
		console.log('Pass --payload-only to fail here instead.\n');
		buildFromSource(root, forwarded);
		return 0;
	}

	await hydrateFrom(root, tag, source);
	return 0;
}

if (import.meta.main) process.exit(await main());
