/**
 * ```sh
 * bun scripts/backup-cdn.ts                 # drift between disk and cdn-manifest.json
 * bun scripts/backup-cdn.ts --write         # rewrite the manifest from disk
 * bun scripts/backup-cdn.ts --upload        # put what the bucket lacks or disagrees on
 * bun scripts/backup-cdn.ts --verify        # HEAD every key over HTTPS; no credentials
 * ```
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** the bucket and the domain in front of it, which is the authoritative one */
export const BUCKET = 'drupflare-cdn';
export const ORIGIN = 'https://cdn.drupflare.com';

/** the same bucket under a second name, tried when the first is unreachable; still manifest-verified */
export const ORIGIN_FALLBACK = 'https://cdn.drupflare.app';

/** names this bucket answered under before the drupflare domains; kept last, never written to the manifest */
export const LEGACY_ORIGINS = [
	'https://drupflare-cdn.gmitch215.dev',
	'https://drupflare-cdn.gmitch215.xyz'
];

/** the origins to try, in order */
export const ORIGINS = [ORIGIN, ORIGIN_FALLBACK, ...LEGACY_ORIGINS];

/** fetches one key, trying each origin in turn; any answer, including a 404, ends the search */
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
	/** the repository is the source of truth for this path; a restore verifies it and never overwrites it */
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

/** the artifacts worth backing up; a directory entry is walked, a file entry is taken as is */
export const IRREPRODUCIBLE: readonly { path: string; dir?: boolean; tracked?: boolean }[] = [
	{ path: 'vendor', dir: true },
	// tracked here, not hand-added to the JSON, because `--write` dropped a hand-added flag on its next run.
	{ path: 'assets/drupal/site.sqlite', tracked: true }
];

/** objects the bucket holds that the tree does not, pinned so they cannot vanish; verified, never uploaded */
export const ARCHIVED: readonly ArchivedEntry[] = readArchived();

/** the list lives in the manifest, and `--upload` appends to it, so no entry is written by hand */
function readArchived(): readonly ArchivedEntry[] {
	try {
		const raw = JSON.parse(
			readFileSync(resolve(import.meta.dirname, '..', MANIFEST_PATH), 'utf8')
		);
		return Array.isArray(raw?.archived) ? raw.archived : [];
	} catch {
		return [];
	}
}

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

/** moves a live mirrored entry's digests to the bytes its local file holds now; `snapshots/` never moves */
export function refreshMirrors(
	root: string,
	archived: readonly ArchivedEntry[]
): readonly ArchivedEntry[] {
	return archived.map((entry) => {
		if (entry.mirrors === undefined || entry.key.startsWith('snapshots/')) return entry;
		const local = join(root, entry.mirrors);
		return existsSync(local)
			? { ...entry, bytes: statSync(local).size, ...digests(local) }
			: entry;
	});
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
	return {
		bucket: BUCKET,
		origin: ORIGIN,
		version: 1,
		keys,
		archived: refreshMirrors(root, ARCHIVED)
	};
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

/** scores a HEAD response against the manifest entry; `size-only` names what it could not check */
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

/** HEADs one key over the public domain; `Accept-Encoding: identity` keeps the byte count and ETag */
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

/** copies the bucket's current bytes to a content-addressed key before anything replaces them */
export function archiveRemote(root: string, key: string): ArchivedEntry {
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
	return {
		key: archived,
		bytes: body.length,
		sha256: sha,
		md5: createHash('md5').update(body).digest('hex'),
		note: `${key} as the bucket held it until an upload replaced it on ${new Date().toISOString().slice(0, 10)}`
	};
}

/** the archive list with new entries appended, a key already present keeping its own entry and note */
export function withArchives(
	archived: readonly ArchivedEntry[],
	added: readonly ArchivedEntry[]
): ArchivedEntry[] {
	const have = new Set(archived.map((e) => e.key));
	return [...archived, ...added.filter((e) => !have.has(e.key))];
}

/** refuses to publish a dirty working copy of a tracked artifact, since no archive can record its bytes */
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

/** downloads one key over the public domain and verifies it against the manifest's own digest */
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
	// lazy: an eager `manifestFromDisk()` threw on CI, where `vendor/` is absent, before `--verify` ran.
	// `--verify` reads the committed manifest and never needs the disk walk.
	let walked: CdnManifest | null = null;
	const current = (): CdnManifest => (walked ??= manifestFromDisk(root));
	const committed = readManifest(root);

	// `--restore=<prefix>` pulls the keys a lane needs. CI uses it for the interpreter the test
	// pool loads: `vendor/` is gitignored, and without it 34 spec files cannot even import.
	const restoreArg = process.argv.find((a: string) => a.startsWith('--restore='));
	if (restoreArg) {
		const prefix = restoreArg.slice('--restore='.length);
		const manifest = committed ?? current();
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
		const fresh = current();
		writeFileSync(join(root, MANIFEST_PATH), JSON.stringify(fresh, null, '\t') + '\n');
		const bytes = fresh.keys.reduce((n, e) => n + e.bytes, 0);
		console.log(
			`${MANIFEST_PATH}: ${fresh.keys.length} keys, ${bytes} bytes, ` +
				`${fresh.archived.length} archived`
		);
		process.exit(0);
	}

	if (has('verify') || has('upload')) {
		const manifest = has('upload') ? current() : (committed ?? current());
		if (!committed && has('verify')) {
			console.error(`no ${MANIFEST_PATH}; run: bun run backup:manifest`);
			process.exit(1);
		}

		const problems: string[] = [];
		/** archive entries written this run, recorded in the manifest before the upload returns */
		const archived: ArchivedEntry[] = [];
		/** a superseded lineage is immutable; a mirror of a live file moves with its file */
		const mirroredArchives = (manifest.archived ?? ARCHIVED).filter(
			(e) => e.mirrors !== undefined
		);
		const checked = has('upload')
			? [...manifest.keys, ...mirroredArchives]
			: [...manifest.keys, ...(manifest.archived ?? ARCHIVED)];

		for (const entry of checked) {
			// scored against the bytes about to go up, not the bytes the manifest last recorded.
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
			// a dirty tracked file is the one refusal left: the bytes going up are an uncommitted edit.
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
		if (has('upload')) {
			// the manifest is the archive list, so recording what was archived and re-deriving the
			// keys the upload just made current is one write, and committing it is the only step left
			const fresh = { ...current(), archived: withArchives(current().archived, archived) };
			writeFileSync(join(root, MANIFEST_PATH), JSON.stringify(fresh, null, '\t') + '\n');
			for (const a of archived) console.log(`  recorded ${a.key} in ${MANIFEST_PATH}`);
		}
		console.log(`\n${checked.length} keys verified against ${manifest.origin}`);
		process.exit(0);
	}

	if (!committed) {
		console.log(`no ${MANIFEST_PATH} yet; run: bun run backup:manifest`);
		process.exit(1);
	} else {
		const fresh = current();
		const drift = driftBetween(committed, fresh);
		console.log(JSON.stringify({ keys: fresh.keys.length, ...drift }, null, 2));
		for (const key of drift.changed) {
			const was = committed.keys.find((e) => e.key === key);
			const now = fresh.keys.find((e) => e.key === key);
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
