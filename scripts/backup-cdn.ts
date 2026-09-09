/**
 * Backs up the artifacts nothing can regenerate, and verifies the backup from anywhere.
 *
 * ```sh
 * bun scripts/backup-cdn.ts                 # drift between disk and cdn-manifest.json
 * bun scripts/backup-cdn.ts --write         # rewrite the manifest from disk
 * bun scripts/backup-cdn.ts --upload        # put what the bucket lacks or disagrees on
 * bun scripts/backup-cdn.ts --verify        # HEAD every key over HTTPS; no credentials
 * ```
 *
 * TWO ARTIFACTS QUALIFY: `vendor/`, which is 14 hand-built php-wasm binaries produced by a Docker
 * toolchain session, and `assets/drupal/site.sqlite`, whose trim recipe is written down nowhere.
 * Everything else here is output -- the packs, `assets/driver.json`, the `.zst` frames, `typedoc/` --
 * and backing output up is what produced three divergent copies of the one file that mattered.
 *
 * AN UPLOAD THAT REPLACES BYTES ARCHIVES THEM FIRST, unconditionally. It used to refuse and ask for
 * `--allow-overwrite`, on the reasoning that an overwrite "destroys a version nothing regenerates".
 * That is true and a content-addressed archive answers it completely, where a flag answers it only
 * while somebody is still reading the message. The one refusal left is a TRACKED file with
 * uncommitted changes, which no archive can help with: the bytes going up would be recorded nowhere.
 *
 * VERIFICATION IS BY ETAG, NOT BY SIZE. R2 returns an object's md5 as its ETag for a single-part
 * upload, so content is checked without downloading 214 MB. A multipart ETag carries a `-N` suffix and
 * is not an md5; those fall back to a size check and report `size-only`.
 *
 * @see docs/repository-layout.md for what is irreproducible and why
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** the bucket and the domain in front of it */
export const BUCKET = 'drupflare-cdn';
export const ORIGIN = 'https://drupflare-cdn.gmitch215.dev';

/**
 * The same bucket under a second name, tried when the first is unreachable.
 *
 * Not a different store and not a different manifest -- every key, size and hash is identical, so a
 * fetch that falls through here is still verified against `cdn-manifest.json`. It exists because
 * some networks blocklist the whole `.dev` TLD, which surfaces as
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` rather than as anything that reads like a DNS policy.
 * `ORIGIN` stays the documented one.
 */
export const ORIGIN_FALLBACK = 'https://drupflare-cdn.gmitch215.xyz';

/** the origins to try, in order */
export const ORIGINS = [ORIGIN, ORIGIN_FALLBACK];

/**
 * Fetches one key, trying each origin in turn.
 *
 * Returns the first response that arrives at all, including a 404 -- a reachable origin answering
 * "no such key" is an answer, and retrying it elsewhere would mask a real manifest drift. Only a
 * transport failure moves to the next.
 */
export async function fetchFromCdn(key: string, init?: RequestInit): Promise<Response> {
	let last: unknown;
	for (const origin of ORIGINS) {
		try {
			return await fetch(`${origin}/${key}`, init);
		} catch (cause) {
			last = cause;
		}
	}
	throw new Error(
		`no CDN origin answered for ${key}: ${last instanceof Error ? last.message : String(last)}`
	);
}

/** where the committed manifest lives, repo-relative */
export const MANIFEST_PATH = 'cdn-manifest.json';

/** one backed-up object */
export type CdnEntry = {
	key: string;
	bytes: number;
	sha256: string;
	md5: string;
	/** where the key belongs on disk, when that is not the key itself */
	mirrors?: string;
	/**
	 * whether the REPOSITORY is the source of truth for the mirrored path.
	 *
	 * A restore verifies but never overwrites one of these. For an untracked artifact the bucket is
	 * authoritative and a download is right; for a committed file the commit is, and restoring over
	 * it is a downgrade -- which is what silently reverted the container-cid repair.
	 *
	 * ON A LIVE KEY TOO, not only an archived one: `assets/drupal/site.sqlite` carries it in both
	 * groups, and an upload reads it to decide whether a dirty working copy may be published.
	 */
	tracked?: boolean;
};

/** an object that exists only in the bucket: a superseded lineage, or a mirror under another name */
export type ArchivedEntry = CdnEntry & { note: string };

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
export const IRREPRODUCIBLE: readonly { path: string; dir?: boolean; tracked?: boolean }[] = [
	{ path: 'vendor', dir: true },
	// TRACKED HERE RATHER THAN HAND-ADDED TO THE JSON, which is where it was and which `--write`
	// silently dropped on its next run. The flag decides whether `restore-artifacts` may overwrite
	// the file and whether an upload may publish a dirty working copy, so losing it on a regenerate
	// is the same silent-drift shape the flag was added to prevent
	{ path: 'assets/drupal/site.sqlite', tracked: true }
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
 * **AND A PAIR THAT WAS DROPPED FROM THE MANIFEST AND SURVIVED IN THE BUCKET.**
 * `vendor/static-control85/php8.5*` was removed when the shipping binary moved to `static-long64`.
 * It reads as dead weight and is not: the bytes are the WASM32 ARM, whose sha appears nowhere else
 * in this manifest and which exists locally only in gitignored `.interp/`. The key name is a third
 * thing again -- phasm's own `vendor/static-control85` is a different 12,676,181-byte build. Dropping
 * a key does not delete the object, so re-pinning costs nothing and makes it checkable.
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
		note: 'change counter 19, superseded by cc27; no mirrors field because it is history now'
	},
	{
		key: 'snapshots/site.sqlite.2259f3f96066',
		bytes: 7_585_792,
		sha256: '2259f3f96066719fc3f9a0e9c0c1bfc383a0ebefbbe4900d443da70e9210355a',
		md5: 'bb6d5813b0638d00835aaeaf522e2e52',
		note: 'change counter 27, the FIRST page max_age fix; superseded by the committed f97005b9 lineage and kept because an archive is a snapshot'
	},
	{
		key: 'snapshots/php8.5-worker.mjs.wasm.94d598fc403b',
		bytes: 12_234_575,
		sha256: '94d598fc403bf66690b76cf05aff508bb5dc47e641e963dc57dd4c43bcd28458',
		md5: '1488008fc46b3182f335beff4d29cad7',
		note: 'the shipping 8.5 binary before ext/cfwpark gained park_flatten; archived by the upload that replaced it'
	},
	{
		key: 'snapshots/php8.5-worker.mjs.6ec19188e65e',
		bytes: 865_849,
		sha256: '6ec19188e65e0491a54fffd3485a90ab9d3ddd75950c7fe207b2c894ab1ffc72',
		md5: '44123585c3daabf58e30978404d6bf2f',
		note: 'its glue, same replacement'
	},
	{
		key: 'vendor/static-control85/php8.5-worker.mjs.wasm',
		bytes: 12_218_393,
		sha256: '02244ae68d49a5b97116646447151c310b9d29d449ed33993d5ad99578539148',
		md5: '988a338279a50604fac00c565a42b6b4',
		note: 'THE KEY NAME IS WRONG AND THE BYTES ARE WHAT MATTER: this is the wasm32 arm, byte-identical to .interp/php8.5-wasm32.wasm, and NOT phasm vendor/static-control85, which is a different 12,676,181-byte build. It was the shipping binary when it was uploaded and the name has meant nothing since; this sha appears nowhere else here, so it is the only off-machine copy of the arm and is pinned rather than deleted. No mirrors field: it is history, and `.interp/` is a build output that may legitimately be rebuilt'
	},
	{
		key: 'vendor/static-control85/php8.5-worker.mjs',
		bytes: 863_402,
		sha256: '016b01a2853445ff549fdc735a5f7899897970b63e6788f17fda1ca572d39bcb',
		md5: '36aa14c39812465961b522d4065daba8',
		note: 'its glue; the same misnamed key, and the same reason for keeping it'
	},
	{
		key: 'vendor/static-long64/php8.5-worker.mjs.wasm',
		bytes: 13_401_742,
		sha256: 'fc6a660dec094cba2daf7461849e3c40ccc270e78f40d7ea289c827f6b7a85ac',
		md5: '8512cebe6ca6795f400be8edc78d67d8',
		mirrors: '.interp/php8.5.wasm',
		note: 'the shipping PHP 8.5 binary: wasm32 pointers with 64-bit zend_long, so PHP_INT_SIZE is 8'
	},
	{
		key: 'vendor/static-long64/php8.5-worker.mjs',
		bytes: 876_467,
		sha256: 'e86ef3e20ff94f136a1bc1ed7ec926fdb171bcd2b08b8a843449911d21f944ae',
		md5: '9de83d79aad46b4c4bbada9204e8e69a',
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
			keys.push({
				key,
				bytes: statSync(abs).size,
				...digests(abs),
				...(entry.tracked === true ? { tracked: true } : {})
			});
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
function put(root: string, key: string, file = join(root, key)): void {
	execFileSync(
		'bunx',
		['wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, `--file=${file}`, '--remote'],
		{ cwd: root, stdio: 'inherit' }
	);
}

/**
 * Copies the bucket's CURRENT bytes to a content-addressed key, before anything replaces them.
 *
 * This is what `--allow-overwrite` used to stand in for, and it is strictly better at the job that
 * flag was added to do. Its own comment said an overwrite "destroys a version nothing regenerates";
 * a content-addressed archive answers that completely, and a flag answers it only while somebody is
 * still reading the message rather than reflexively passing it. So the archive is unconditional and
 * the flag is gone.
 *
 * Content-addressed, so re-archiving the same bytes is the same key and costs nothing. The name
 * matches the three `snapshots/site.sqlite.<sha12>` entries already in the manifest, which were made
 * by hand for exactly this reason.
 *
 * @returns the archive key, so the caller can name it in the manifest.
 */
export function archiveRemote(root: string, key: string): string {
	const scratch = join(root, '.cdn-archive');
	mkdirSync(scratch, { recursive: true });
	const local = join(scratch, key.replaceAll('/', '_'));
	execFileSync(
		'bunx',
		['wrangler', 'r2', 'object', 'get', `${BUCKET}/${key}`, `--file=${local}`, '--remote'],
		{ cwd: root, stdio: 'inherit' }
	);
	const body = readFileSync(local);
	const sha = createHash('sha256').update(body).digest('hex');
	const archived = `snapshots/${key.split('/').pop()}.${sha.slice(0, 12)}`;
	put(root, archived, local);
	console.log(
		`  archived ${key} -> ${archived} (${body.length} bytes, sha256 ${sha.slice(0, 12)})`
	);
	return archived;
}

/**
 * Whether a TRACKED artifact's working copy is the committed one.
 *
 * The one refusal an archive cannot answer. Archiving preserves the bytes being replaced; it says
 * nothing about the bytes going up. For a tracked artifact git decides what is canonical, so
 * publishing a dirty working copy puts something in the bucket that no commit records -- and
 * `assets/drupal/site.sqlite` is hand-trimmed with its recipe written down nowhere, which is exactly
 * the file where that would be unrecoverable.
 */
export function committedBytes(root: string, path: string): boolean {
	try {
		const out = execFileSync('git', ['status', '--porcelain', '--', path], {
			cwd: root,
			encoding: 'utf8'
		});
		return out.trim() === '';
	} catch {
		// no git, or a path outside the work tree: not a reason to refuse a backup
		return true;
	}
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
		/** archive keys written this run, so the operator knows what to add to the manifest */
		const archived: string[] = [];
		/**
		 * A SUPERSEDED LINEAGE IS IMMUTABLE; A MIRROR OF A LIVE FILE IS NOT, and treating both as
		 * archives is why an interpreter bump could not be published.
		 *
		 * `--upload` walked `keys` only, and the shipping interpreter is in `archived` -- it lives in
		 * the bucket under phasm's variant name and has no path in this tree. So the documented
		 * two-step ("`bun run backup:cdn` publishes the new bytes") could not do its first step, and
		 * a run of it reported success having uploaded everything EXCEPT the binary it was run for.
		 *
		 * `mirrors` is the distinction and it was already there: an archived entry that names a local
		 * file tracks that file and moves with it; one without a `mirrors` field is history and is
		 * never uploaded. The old bytes are archived before the replacement either way.
		 */
		const mirroredArchives = (manifest.archived ?? ARCHIVED).filter(
			(e) => e.mirrors !== undefined
		);
		const checked = has('upload')
			? [...manifest.keys, ...mirroredArchives]
			: [...manifest.keys, ...(manifest.archived ?? ARCHIVED)];

		for (const entry of checked) {
			// SCORED AGAINST THE BYTES ABOUT TO GO UP, not the bytes the manifest last recorded.
			// For a mirrored archive those differ by definition during a bump -- that IS the bump --
			// and scoring the stale record reported `ok` and skipped the upload
			const source = join(root, entry.mirrors ?? entry.key);
			const going =
				has('upload') && existsSync(source)
					? { ...entry, bytes: statSync(source).size, ...digests(source) }
					: entry;
			const { status, length, etag } = await headKey(manifest.origin, entry.key);
			const verdict = verdictFor(going, status, length, etag);
			console.log(`${verdict.padEnd(14)} ${entry.key}  remote=${length ?? '-'}`);
			if (verdict === 'ok' || verdict === 'size-only') continue;

			if (!has('upload')) {
				problems.push(`${entry.key}: ${verdict} (remote=${length ?? 'none'})`);
				continue;
			}
			// A DIRTY TRACKED FILE IS THE ONE REFUSAL LEFT. Everything else is archived and then
			// replaced: see `archiveRemote`. This case is different in kind -- the bytes going UP
			// are an uncommitted edit, so the bucket would carry something no commit records, and
			// an archive of the old bytes does not help with that.
			const local = entry.mirrors ?? entry.key;
			if (entry.tracked === true && !committedBytes(root, local)) {
				problems.push(
					`${entry.key}: ${local} is tracked and has uncommitted changes, so the bytes ` +
						'that would go up are recorded nowhere. Commit them first.'
				);
				continue;
			}
			if (verdict !== 'missing') {
				archived.push(archiveRemote(root, entry.key));
			}
			console.log(`  put ${entry.key}`);
			// from `mirrors` when the key has no path of its own, which is every archived mirror
			put(root, entry.key, join(root, entry.mirrors ?? entry.key));
		}

		if (!has('upload')) problems.push(...mirrorProblems(root, manifest.archived ?? ARCHIVED));

		if (problems.length) {
			console.error(`\n${problems.length} problem(s):`);
			for (const p of problems) console.error(`  ${p}`);
			process.exit(1);
		}
		if (archived.length) {
			console.log(`\n${archived.length} archive key(s) written; add them to \`archived\`:`);
			for (const a of archived) console.log(`  ${a}`);
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
