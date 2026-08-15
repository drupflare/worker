/**
 * Turns a clean checkout into a deployable tree from a release payload.
 *
 * ```sh
 * bun scripts/hydrate.ts                          # the payload for package.json's version
 * bun scripts/hydrate.ts --tag=v1.0.1             # a specific release
 * bun scripts/hydrate.ts --from=dist/x.tar.gz     # a local tarball, for testing the payload
 * ```
 *
 * This is the one command between `git clone` and `wrangler deploy`, and it deliberately needs no
 * Docker, no `gh` auth and no Cloudflare credential -- a release asset on a public repository is a
 * plain HTTPS GET. That is what makes the Deploy to Cloudflare button viable: its build command is
 * `bun install && bun run hydrate`, and Workers Builds has no Docker to build the zstd decoder with.
 *
 * Every byte is checked against the manifest's sha256 before it lands, and nothing outside
 * `assets/` and `.interp/` is written at all. `vendor/` is unreachable from here by construction:
 * it holds 14 hand-built binaries that exist on one machine.
 *
 * @see scripts/release-payload.ts for the producing half
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

if (import.meta.main) {
	const root = resolve(import.meta.dirname, '..');
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
		version?: string;
	};
	const tag = arg('tag', `v${pkg.version}`)!;
	const release = tag.replace(/^v/, '');
	const work = mkdtempSync(join(tmpdir(), 'drupflare-hydrate-'));

	try {
		let tarball = arg('from');
		if (!tarball) {
			const base = `https://github.com/${REPO}/releases/download/${tag}`;
			tarball = join(work, payloadName(release));
			console.log(`fetching ${base}/${payloadName(release)}`);
			await download(`${base}/${payloadName(release)}`, tarball);
			const sums = join(work, 'SHA256SUMS');
			await download(`${base}/SHA256SUMS`, sums);
			const expected = readFileSync(sums, 'utf8').trim().split(/\s+/)[0];
			const actual = sha256(tarball);
			if (expected !== actual) {
				throw new Error(`SHA256SUMS says ${expected}, the download is ${actual}`);
			}
			console.log(`tarball sha256 ${actual} matches SHA256SUMS`);
		}

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
