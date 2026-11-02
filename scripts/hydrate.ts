/**
 * ```sh
 * bun run hydrate                              # the payload for package.json's version
 * bun run hydrate -- --tag=v1.0.1              # a specific release
 * bun run hydrate -- --from=dist/x.tar.gz      # a local tarball, for testing the payload
 * bun run hydrate -- --payload-only            # refuse to build from source; fail instead
 * bun run hydrate -- --from-source             # skip the payload and build every artifact locally
 * bun run hydrate -- --dev[=branch]            # the rolling payload of a branch tip, never a release
 * ```
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
import { devKeyBase, devLabel, payloadBaseUrl, readSums, releaseKeyBase } from './payload-cdn';
import { PAYLOAD_ROOTS, payloadName, sha256, type PayloadManifest } from './release-payload';

/** where a payload is published, so the default path needs no argument */
const REPO = process.env.DRUPFLARE_REPO ?? 'drupflare/worker';

/** whether a manifest path is safe to write; a downloaded payload can name `../` paths */
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

/** verifies an extracted payload against its own manifest; returns every discrepancy */
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

/** every network base to try for a tag, in order; the CDN outranks the release, which is measured */
function networkBases(
	root: string,
	tag: string,
	dev?: string
): { base: string; via: PayloadVia }[] {
	const bases: { base: string; via: PayloadVia }[] = [];
	// an explicit dev line asks for the tip of that branch and nothing else
	if (dev !== undefined) {
		for (const origin of ORIGINS) {
			bases.push({ base: payloadBaseUrl(origin, devKeyBase(dev)), via: 'cdn-dev' });
		}
		return bases;
	}
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

/** picks the payload to hydrate from, cheapest first: a local `dist/` tarball, then the network */
export async function resolvePayloadSource(
	root: string,
	tag: string,
	given: string | undefined,
	probe: (url: string) => Promise<boolean>,
	dev?: string
): Promise<PayloadSource> {
	if (given) {
		if (!existsSync(given)) throw new Error(`--from=${given} does not exist`);
		return { kind: 'given', path: given };
	}

	const local = join(root, 'dist', payloadName(tag.replace(/^v/, '')));
	if (dev === undefined && existsSync(local)) return { kind: 'dist', path: local };

	for (const { base, via } of networkBases(root, tag, dev)) {
		if (await probe(`${base}/SHA256SUMS`)) return { kind: 'release', tag, base, via };
	}

	return {
		kind: 'none',
		tag,
		reason:
			dev === undefined
				? `no ${local} on disk, and no ${tag} payload on the CDN, on ${REPO}'s releases, ` +
					`or on the dev line for ${currentBranch(root)}`
				: `no payload on the ${devLabel(dev)} line of the CDN`
	};
}

/** the branch `--dev` names: `--dev=feat/x` is that branch, a bare `--dev` is the checkout's own */
export function devBranch(argv: readonly string[], root: string): string | undefined {
	const hit = argv.find((a) => a === '--dev' || a.startsWith('--dev='));
	if (hit === undefined) return undefined;
	const named = hit.slice('--dev='.length).trim();
	return hit === '--dev' || named === '' ? currentBranch(root) : named;
}

function arg(name: string, fallback?: string): string | undefined {
	const hit = process.argv.find((a: string) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
}

/** one attempt's budget; the failure this bounds is a body that stalls, not a slow link */
const DOWNLOAD_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 30_000;
const DOWNLOAD_ATTEMPTS = 3;

/** downloads a URL to a path, failing on non-200; the body read runs under the abort signal */
async function download(url: string, to: string, fresh = false): Promise<void> {
	let last = 'no attempt was made';
	for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
		const started = Date.now();
		try {
			const res = await fetch(url, {
				signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
				// the nonce below is what actually defeats an edge cache; this is the local half
				...(fresh ? { cache: 'no-store' as const } : {})
			});
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

/** files the repository owns, which a payload may never overwrite; asked of git, not hard-coded */
function trackedFiles(root: string): Set<string> {
	try {
		const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
			encoding: 'utf8',
			maxBuffer: 1 << 26
		});
		return new Set(out.split('\0').filter(Boolean));
	} catch {
		return new Set();
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

	const tracked = trackedFiles(root);
	const kept: string[] = [];
	const drifted: string[] = [];
	for (const file of manifest.files) {
		const dest = join(root, file.path);
		if (tracked.has(file.path) && existsSync(dest)) {
			// verified, not skipped: a disagreement means the payload was built from a different tree.
			if (sha256(dest) !== sha256(join(staged, file.path))) drifted.push(file.path);
			kept.push(file.path);
			continue;
		}
		mkdirSync(dirname(dest), { recursive: true });
		cpSync(join(staged, file.path), dest);
	}
	if (kept.length) {
		console.log(
			`hydrate: kept ${kept.length} tracked file(s) the repository owns: ${kept.join(', ')}`
		);
	}
	for (const path of drifted) {
		console.log(
			`hydrate: WARNING ${path} differs from the payload's copy; the tree's is in force`
		);
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

/** the URL a payload is fetched from, carrying its digest; the tarball is cached for max-age=14400 */
export function payloadUrl(base: string, asset: string, sha256: string): string {
	return `${base}/${asset}?sha256=${sha256}`;
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
			// SHA256SUMS first: it names the tarball, which the dev line cannot derive from its tag.
			const sums = join(work, 'SHA256SUMS');
			await download(`${found.base}/SHA256SUMS`, sums);
			const { sha256: expected, name: asset } = readSums(readFileSync(sums, 'utf8'));

			tarball = join(work, asset);
			console.log(`fetching ${found.base}/${asset} (${found.via})`);
			// the digest is in the URL, so a mismatched sums and tarball pair cannot be reached.
			const versioned = payloadUrl(found.base, asset, expected);
			await download(versioned, tarball);

			let actual = sha256(tarball);
			if (expected !== actual) {
				// a stale entry under the new key is possible; one forced revalidation separates it from corruption.
				console.log(`hydrate: ${actual} is not ${expected}; refetching without the cache`);
				await download(`${versioned}&fresh=${Date.now()}`, tarball, true);
				actual = sha256(tarball);
			}
			if (expected !== actual) {
				throw new Error(`SHA256SUMS says ${expected}, the download is ${actual}`);
			}
			console.log(`tarball sha256 ${actual} matches SHA256SUMS`);
			if (found.via === 'cdn-dev') {
				// name the branch: a fork or detached HEAD can legitimately land on a line it is not on.
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

/** the artifacts that make a tree deployable; a complete tree is left alone unless `--force` says otherwise */
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
	// --force reaches the source route only; the payload route overwrites whatever is there anyway.
	const forwarded = process.argv
		.slice(2)
		.filter((a: string) => a === '--force' || a.startsWith('--only='));

	if (fromSource && payloadOnly) {
		console.error('--from-source and --payload-only are opposites; pass one or neither');
		return 2;
	}
	const dev = devBranch(process.argv, root);
	if (
		dev !== undefined &&
		(fromSource || arg('from') !== undefined || arg('tag') !== undefined)
	) {
		console.error(
			'--dev takes the tip of a branch; it cannot be combined with --from-source, --from or --tag'
		);
		return 2;
	}
	if (fromSource) {
		buildFromSource(root, forwarded);
		return 0;
	}

	const source = await resolvePayloadSource(root, tag, arg('from'), assetExists, dev);
	if (source.kind === 'none') {
		if (payloadOnly) {
			console.error(`no payload to hydrate from: ${source.reason}.`);
			console.error(
				'\n--payload-only forbids the source route. Drop it to build the artifacts locally\n' +
					'(`bun run build:local`), point --from= at a tarball, or cut a release first.\n' +
					'See docs/getting-started/building-from-source/index.md for what each route needs.'
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
