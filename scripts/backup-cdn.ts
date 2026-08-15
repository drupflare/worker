/**
 * Backs up the artifacts nothing can regenerate, and verifies the backup from anywhere.
 *
 * ```sh
 * bun scripts/backup-cdn.ts                 # drift between disk and cdn-manifest.json
 * bun scripts/backup-cdn.ts --write         # rewrite the manifest from disk
 * bun scripts/backup-cdn.ts --upload        # put the keys the bucket lacks
 * bun scripts/backup-cdn.ts --verify        # HEAD every key over HTTPS; no credentials
 * ```
 *
 * TWO ARTIFACTS QUALIFY: `vendor/`, which is 14 hand-built php-wasm binaries produced by a Docker
 * toolchain session, and `assets/drupal/site.sqlite`, whose trim recipe is written down nowhere.
 * Everything else here is output -- the packs, `assets/driver.json`, the `.zst` frames, `typedoc/` --
 * and backing output up is what produced three divergent copies of the one file that mattered.
 *
 * VERIFICATION IS BY ETAG, NOT BY SIZE. R2 returns an object's md5 as its ETag for a single-part
 * upload, so content is checked without downloading 214 MB. A multipart ETag carries a `-N` suffix and
 * is not an md5; those fall back to a size check and report `size-only`.
 *
 * @see docs/repository-layout.md for what is irreproducible and why
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** the bucket and the domain in front of it */
export const BUCKET = 'drupflare-cdn';
export const ORIGIN = 'https://drupflare-cdn.gmitch215.dev';

/** where the committed manifest lives, repo-relative */
export const MANIFEST_PATH = 'cdn-manifest.json';

/** one backed-up object */
export type CdnEntry = { key: string; bytes: number; sha256: string; md5: string };

/** an object that exists only in the bucket: a superseded lineage, or a mirror under another name */
export type ArchivedEntry = CdnEntry & { note: string; mirrors?: string };

/** the committed manifest */
export type CdnManifest = {
	bucket: string;
	origin: string;
	version: number;
	keys: CdnEntry[];
	archived: readonly ArchivedEntry[];
};

/**
 * The only two things worth backing up.
 *
 * A directory entry is walked; a file entry is taken as is. Nothing regenerable belongs here, and
 * `bun run assets` / `bun run build:wasm` / `bun run assets:driver` is the test of whether something
 * is regenerable.
 */
export const IRREPRODUCIBLE: readonly { path: string; dir?: boolean }[] = [
	{ path: 'vendor', dir: true },
	{ path: 'assets/drupal/site.sqlite' }
];

/**
 * Objects the bucket holds that the tree does not, pinned so they cannot vanish unnoticed.
 *
 * Two kinds. **Superseded `site.sqlite` lineages**: the SQLite header change counter orders the three
 * copies that existed -- live at 19, the `.pack-backup` rollback point at 16, and the original
 * hand-trimmed artifact at 13 with 1618 pages against the current 1852. `assets/drupal/site.sqlite` in
 * the bucket is the live one; the older two are kept here. **A mirror of the shipping interpreter**,
 * under phasm's own variant name, because it comes from a workflow artifact and those expire after 90
 * days.
 *
 * Verified, never uploaded.
 */
export const ARCHIVED: readonly ArchivedEntry[] = [
	{
		key: 'assets/drupal/site.sqlite.trimmed-1618p-cc13',
		bytes: 6_627_328,
		sha256: '94911463f798d3bbefb66f8e9a2b17decb453048af59d559a407b2bf61e8dab8',
		md5: 'd7a5801614964886e4834e287b189432',
		note: 'the original hand-trimmed lineage: 1618 pages, change counter 13'
	},
	{
		key: 'snapshots/site.sqlite.064105ca7223',
		bytes: 7_585_792,
		sha256: '064105ca7223ef57f48e3e979d7ddcf53293060939c1202400110f08ea760380',
		md5: '6a6a872406851f8947b2c03b1e86283d',
		mirrors: '.pack-backup/site.sqlite.bak',
		note: 'the rollback point bun run bake:pack overwrites on its next run: change counter 16'
	},
	{
		key: 'snapshots/site.sqlite.a18db26a417b',
		bytes: 7_585_792,
		sha256: 'a18db26a417b65e163b7a4a5a3ac250d41048e40f2eb84a7e6da51777f5d8974',
		md5: 'd62c74571fc35f2b0b3559b8f70e2b9d',
		mirrors: 'assets/drupal/site.sqlite',
		note: 'the canonical lineage at change counter 19, pinned by digest so a later edit cannot move it'
	},
	{
		key: 'vendor/static-control85/php8.5-worker.mjs.wasm',
		bytes: 12_218_393,
		sha256: '02244ae68d49a5b97116646447151c310b9d29d449ed33993d5ad99578539148',
		md5: '988a338279a50604fac00c565a42b6b4',
		mirrors: '.interp/php8.5.wasm',
		note: 'the shipping PHP 8.5 binary; phasm publishes it as an artifact and artifacts expire'
	},
	{
		key: 'vendor/static-control85/php8.5-worker.mjs',
		bytes: 863_402,
		sha256: '016b01a2853445ff549fdc735a5f7899897970b63e6788f17fda1ca572d39bcb',
		md5: '36aa14c39812465961b522d4065daba8',
		mirrors: '.interp/php8.5-worker.mjs',
		note: 'its glue, which the seam imports as PHPFactory'
	}
];

/** files that are noise rather than artifacts */
const SKIP = /(^|\/)\.DS_Store$/;

/** every file under a directory, repo-relative and sorted */
function walk(root: string, dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
		const rel = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(root, rel));
		else if (!SKIP.test(rel)) out.push(rel);
	}
	return out.sort();
}

/** sha256 and md5 of a file; the md5 is what an R2 ETag can be compared against */
export function digests(path: string): { sha256: string; md5: string } {
	const body = readFileSync(path);
	return {
		sha256: createHash('sha256').update(body).digest('hex'),
		md5: createHash('md5').update(body).digest('hex')
	};
}

/** Builds the manifest the local tree describes. Reads `vendor/` and never writes to it. */
export function manifestFromDisk(root: string): CdnManifest {
	const keys: CdnEntry[] = [];
	for (const entry of IRREPRODUCIBLE) {
		const paths = entry.dir ? walk(root, entry.path) : [entry.path];
		for (const key of paths) {
			const abs = join(root, key);
			keys.push({ key, bytes: statSync(abs).size, ...digests(abs) });
		}
	}
	return { bucket: BUCKET, origin: ORIGIN, version: 1, keys, archived: ARCHIVED };
}

/** what changed between a committed manifest and the tree */
export type Drift = { added: string[]; removed: string[]; changed: string[] };

/** Compares two manifests by key and digest. */
export function driftBetween(committed: CdnManifest, current: CdnManifest): Drift {
	const before = new Map(committed.keys.map((e) => [e.key, e]));
	const after = new Map(current.keys.map((e) => [e.key, e]));
	return {
		added: [...after.keys()].filter((k) => !before.has(k)),
		removed: [...before.keys()].filter((k) => !after.has(k)),
		changed: [...after.keys()].filter((k) => {
			const was = before.get(k);
			const now = after.get(k);
			return was !== undefined && now !== undefined && was.sha256 !== now.sha256;
		})
	};
}

/** one key's verdict against the bucket */
export type KeyVerdict =
	'ok' | 'size-only' | 'missing' | 'size-mismatch' | 'etag-mismatch' | 'no-length';

/**
 * Scores a HEAD response against the manifest entry.
 *
 * `size-only` is a pass that names what it could not check: a multipart upload's ETag is not an md5, so
 * content cannot be compared without downloading the object.
 */
export function verdictFor(
	entry: CdnEntry,
	status: number,
	length?: number,
	etag?: string
): KeyVerdict {
	if (status !== 200) return 'missing';
	if (length === undefined) return 'no-length';
	if (length !== entry.bytes) return 'size-mismatch';
	const clean = etag?.replace(/"/g, '');
	if (clean === undefined || clean.includes('-')) return 'size-only';
	return clean === entry.md5 ? 'ok' : 'etag-mismatch';
}

/**
 * HEADs one key over the public domain, which needs no credential.
 *
 * `Accept-Encoding: identity` is load-bearing. The domain answers a default HEAD with
 * `content-encoding: zstd` and NO `content-length`, so the size check degrades to comparing nothing;
 * asking for identity returns the object's own byte count and its ETag.
 */
export async function headKey(
	origin: string,
	key: string
): Promise<{ status: number; length?: number; etag?: string }> {
	const res = await fetch(`${origin}/${key}`, {
		method: 'HEAD',
		headers: { 'accept-encoding': 'identity' }
	});
	const raw = res.headers.get('content-length');
	return {
		status: res.status,
		length: raw === null ? undefined : Number(raw),
		etag: res.headers.get('etag') ?? undefined
	};
}

const has = (name: string) => process.argv.includes(`--${name}`);

function readManifest(root: string): CdnManifest | undefined {
	try {
		return JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf8')) as CdnManifest;
	} catch {
		return undefined;
	}
}

/** `wrangler r2 object put`, the only write path; the S3 endpoint would need key pairs nobody has */
function put(root: string, key: string): void {
	execFileSync(
		'bunx',
		[
			'wrangler',
			'r2',
			'object',
			'put',
			`${BUCKET}/${key}`,
			`--file=${join(root, key)}`,
			'--remote'
		],
		{ cwd: root, stdio: 'inherit' }
	);
}

/** Checks that a mirrored archive still matches the local file it was taken from. */
export function mirrorProblems(root: string, archived: readonly ArchivedEntry[]): string[] {
	const problems: string[] = [];
	for (const entry of archived) {
		if (entry.mirrors === undefined) continue;
		let local: { sha256: string };
		try {
			local = digests(join(root, entry.mirrors));
		} catch {
			continue; // an unbuilt tree is not a backup failure
		}
		if (local.sha256 !== entry.sha256) {
			problems.push(
				`${entry.mirrors} no longer matches ${entry.key}; an archive is a snapshot, so ` +
					'either archive the new bytes under a new key or drop the mirrors field'
			);
		}
	}
	return problems;
}

/**
 * Downloads one key over the public domain and verifies it against the manifest's own digest.
 *
 * No credential, same as `--verify`: the bucket is fronted by a custom domain, which is what lets CI
 * restore a gitignored artifact without a secret. The size and sha256 come from `cdn-manifest.json`,
 * so a truncated or swapped object fails here rather than as a confusing wasm error later.
 */
async function restoreKey(root: string, entry: CdnEntry): Promise<void> {
	const res = await fetch(`${ORIGIN}/${entry.key}`, {
		headers: { 'accept-encoding': 'identity' }
	});
	if (!res.ok) throw new Error(`${entry.key}: HTTP ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (bytes.length !== entry.bytes) {
		throw new Error(`${entry.key}: got ${bytes.length} bytes, manifest says ${entry.bytes}`);
	}
	const sha = createHash('sha256').update(bytes).digest('hex');
	if (sha !== entry.sha256) {
		throw new Error(`${entry.key}: sha256 ${sha}, manifest says ${entry.sha256}`);
	}
	const target = join(root, entry.key);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, bytes);
}

if (import.meta.main) {
	const root = resolve(import.meta.dirname, '..');
	const current = manifestFromDisk(root);
	const committed = readManifest(root);

	// `--restore=<prefix>` pulls the keys a lane needs. CI uses it for the interpreter the test
	// pool loads: `vendor/` is gitignored, and without it 34 spec files cannot even import.
	const restoreArg = process.argv.find((a: string) => a.startsWith('--restore='));
	if (restoreArg) {
		const prefix = restoreArg.slice('--restore='.length);
		const manifest = committed ?? current;
		const wanted = manifest.keys.filter((e) => e.key.startsWith(prefix));
		if (wanted.length === 0) {
			console.error(`no key in ${MANIFEST_PATH} starts with ${prefix}`);
			process.exit(1);
		}
		for (const entry of wanted) {
			await restoreKey(root, entry);
			console.log(`restored ${entry.key} (${entry.bytes} bytes, sha256 verified)`);
		}
		process.exit(0);
	}

	if (has('write')) {
		writeFileSync(join(root, MANIFEST_PATH), JSON.stringify(current, null, '\t') + '\n');
		const bytes = current.keys.reduce((n, e) => n + e.bytes, 0);
		console.log(
			`${MANIFEST_PATH}: ${current.keys.length} keys, ${bytes} bytes, ` +
				`${current.archived.length} archived`
		);
		process.exit(0);
	}

	if (has('verify') || has('upload')) {
		const manifest = has('upload') ? current : (committed ?? current);
		if (!committed && has('verify')) {
			console.error(`no ${MANIFEST_PATH}; run: bun run backup:manifest`);
			process.exit(1);
		}

		const problems: string[] = [];
		// archives are verified in both modes and uploaded in neither: they are already immutable
		const checked = has('upload')
			? manifest.keys
			: [...manifest.keys, ...(manifest.archived ?? ARCHIVED)];

		for (const entry of checked) {
			const { status, length, etag } = await headKey(manifest.origin, entry.key);
			const verdict = verdictFor(entry, status, length, etag);
			console.log(`${verdict.padEnd(14)} ${entry.key}  remote=${length ?? '-'}`);
			if (verdict === 'ok' || verdict === 'size-only') continue;

			if (!has('upload')) {
				problems.push(`${entry.key}: ${verdict} (remote=${length ?? 'none'})`);
				continue;
			}
			// overwriting a key whose content differs destroys a version nothing regenerates. An
			// explicit flag, never a default: this is what preserved the 6.6 MB lineage
			if (verdict !== 'missing' && !has('allow-overwrite')) {
				problems.push(
					`${entry.key}: remote is ${length} bytes and does not match local ` +
						`(${entry.bytes} bytes, md5 ${entry.md5}). Pass --allow-overwrite to replace it.`
				);
				continue;
			}
			console.log(`  put ${entry.key}`);
			put(root, entry.key);
		}

		if (!has('upload')) problems.push(...mirrorProblems(root, manifest.archived ?? ARCHIVED));

		if (problems.length) {
			console.error(`\n${problems.length} problem(s):`);
			for (const p of problems) console.error(`  ${p}`);
			process.exit(1);
		}
		console.log(`\n${checked.length} keys verified against ${manifest.origin}`);
		process.exit(0);
	}

	if (!committed) {
		console.log(`no ${MANIFEST_PATH} yet; run: bun run backup:manifest`);
		process.exit(1);
	} else {
		const drift = driftBetween(committed, current);
		console.log(JSON.stringify({ keys: current.keys.length, ...drift }, null, 2));
		for (const key of drift.changed) {
			const was = committed.keys.find((e) => e.key === key);
			const now = current.keys.find((e) => e.key === key);
			console.log(`changed ${key}: ${was?.bytes} -> ${now?.bytes} bytes`);
		}
		const stale = drift.added.length || drift.removed.length || drift.changed.length;
		const mirrors = mirrorProblems(root, ARCHIVED);
		for (const problem of mirrors) console.log(problem);
		if (stale || mirrors.length) {
			console.log('\nthe manifest is stale; run: bun run backup:manifest');
			process.exit(1);
		}
		console.log(`\n${MANIFEST_PATH} matches the tree`);
	}
}
