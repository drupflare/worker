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
	| { kind: 'release'; tag: string; base: string }
	| { kind: 'none'; tag: string; reason: string };

/**
 * Picks the payload to hydrate from, cheapest first.
 *
 * A LOCAL `dist/` tarball outranks the network, because that is what
 * `bun run release:payload` just produced and re-downloading a release to test the build that made it
 * would test the wrong bytes. A release is probed rather than inferred from `git tag`: a shallow clone
 * has no tags, and the tags a clone does have say nothing about whether the asset was ever attached.
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

	const base = `https://github.com/${REPO}/releases/download/${tag}`;
	const url = `${base}/${payloadName(tag.replace(/^v/, ''))}`;
	if (await probe(url)) return { kind: 'release', tag, base };

	return {
		kind: 'none',
		tag,
		reason: `no ${local} on disk and ${REPO} has published no ${tag} payload`
	};
}

function arg(name: string, fallback?: string): string | undefined {
	const hit = process.argv.find((a: string) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
}

/** Downloads a URL to a path, failing on any non-200 rather than writing an error page to disk. */
async function download(url: string, to: string): Promise<void> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
	await Bun.write(to, res);
}

/** whether a release asset is actually there, without pulling 22 MB to find out */
async function assetExists(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
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
			const asset = payloadName(tag.replace(/^v/, ''));
			tarball = join(work, asset);
			console.log(`fetching ${found.base}/${asset}`);
			await download(`${found.base}/${asset}`, tarball);

			const sums = join(work, 'SHA256SUMS');
			await download(`${found.base}/SHA256SUMS`, sums);
			const expected = readFileSync(sums, 'utf8').trim().split(/\s+/)[0];
			const actual = sha256(tarball);
			if (expected !== actual) {
				throw new Error(`SHA256SUMS says ${expected}, the download is ${actual}`);
			}
			console.log(`tarball sha256 ${actual} matches SHA256SUMS`);
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

async function main(): Promise<number> {
	const root = resolve(import.meta.dirname, '..');
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
		version?: string;
	};
	const tag = arg('tag', `v${pkg.version}`)!;
	const payloadOnly = process.argv.includes('--payload-only');
	const fromSource = process.argv.includes('--from-source');
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
					'(`bun run build:local`), point --from= at a tarball, or cut a release first --\n' +
					'see PUBLISHING.md.'
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
