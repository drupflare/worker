/**
 * Materialises `wordpress-src/` from the tarball `config/wordpress.lock.json` pins.
 *
 * ```sh
 * bun run fetch:wordpress
 * bun scripts/fetch-wordpress-tree.ts --force
 * ```
 *
 * The tarball is checked against the lock's sha256 before anything is unpacked. An unpinned lock
 * (empty sha256) refuses and prints the digest to record; the script never writes the lock.
 *
 * A tree this script did not write, or one at a different commit, is refused without `--force`.
 * With `--force` the old tree is moved aside, never deleted.
 *
 * @see scripts/fetch-drupal-tree.ts for the shape this mirrors
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where the tree lands. Fixed, not an argument: `--force` moves it, so it must not be aimable. */
export const WORDPRESS_TREE = 'wordpress-src';

/** The pin, relative to the repository root. */
export const LOCK_PATH = 'config/wordpress.lock.json';

/** Written inside the tree after a successful extract. */
export const MANIFEST_NAME = '.fetched.json';

const ROOT = new URL('..', import.meta.url).pathname;

/** The release pinned by commit and tarball digest. */
export type WordpressLock = {
	tag: string;
	sha: string;
	tarball: string;
	sha256: string;
};

/** What `wordpress-src/.fetched.json` records about the extracted tree. */
export type WordpressManifest = WordpressLock & { files: number };

/** What one run did. */
export type FetchResult = {
	root: string;
	tag: string;
	sha: string;
	action: 'extracted' | 'already-present';
	files: number;
};

/**
 * Validates the parsed lock and returns its four fields.
 *
 * @throws naming the field that is malformed.
 */
export function parseLock(json: unknown): WordpressLock {
	const o = json as Record<string, unknown> | null;
	const field = (name: string): string => {
		const value = o?.[name];
		if (typeof value !== 'string') throw new Error(`${LOCK_PATH}: ${name} is not a string`);
		return value;
	};
	const lock = {
		tag: field('tag'),
		sha: field('sha'),
		tarball: field('tarball'),
		sha256: field('sha256')
	};
	if (!/^\d+\.\d+\.\d+$/.test(lock.tag))
		throw new Error(`${LOCK_PATH}: tag ${lock.tag} is not a release version`);
	if (!/^[0-9a-f]{40}$/.test(lock.sha))
		throw new Error(`${LOCK_PATH}: sha ${lock.sha} is not a full commit SHA`);
	if (!lock.tarball.startsWith('https://'))
		throw new Error(`${LOCK_PATH}: tarball must be an https URL`);
	if (lock.sha256 !== '' && !/^[0-9a-f]{64}$/.test(lock.sha256))
		throw new Error(`${LOCK_PATH}: sha256 is not 64 hex characters`);
	return lock;
}

/** Reads and validates `config/wordpress.lock.json` from the repository. */
export function readWordpressLock(root = ROOT): WordpressLock {
	return parseLock(JSON.parse(readFileSync(join(root, LOCK_PATH), 'utf8')));
}

/**
 * Throws unless the downloaded bytes hash to the lock's digest.
 *
 * An empty digest in the lock throws too, and names the digest the caller must record.
 */
export function verifyDigest(lock: WordpressLock, actual: string): void {
	if (lock.sha256 === '')
		throw new Error(
			`no sha256 is recorded in ${LOCK_PATH}; the tarball hashes to ${actual}. ` +
				`Record it there and run again.`
		);
	if (actual !== lock.sha256)
		throw new Error(
			`tarball sha256 ${actual} does not match ${LOCK_PATH} (${lock.sha256}); not unpacking`
		);
}

/**
 * Decides whether the tree is extracted, left alone, or refused.
 *
 * @param treeExists - whether `wordpress-src/` is on disk
 * @param presentSha - the commit the tree's manifest records, undefined when it has none
 * @param sha - the commit the lock pins
 * @throws when the tree is at another commit, or was not written here, and `force` is off.
 */
export function planExtract(
	treeExists: boolean,
	presentSha: string | undefined,
	sha: string,
	force: boolean
): 'extract' | 'already-present' {
	if (!treeExists) return 'extract';
	if (presentSha === sha && !force) return 'already-present';
	if (!force)
		throw new Error(
			presentSha
				? `${WORDPRESS_TREE} holds ${presentSha.slice(0, 12)}, not ${sha.slice(0, 12)}. ` +
						`Pass --force to replace it.`
				: `${WORDPRESS_TREE} has no ${MANIFEST_NAME}. Pass --force to replace it.`
		);
	return 'extract';
}

/** The manifest written beside an extracted tree. */
export function treeManifest(lock: WordpressLock, files: number): WordpressManifest {
	return { tag: lock.tag, sha: lock.sha, tarball: lock.tarball, sha256: lock.sha256, files };
}

/** Counts regular files at every depth under `dir`. */
export function countFiles(dir: string): number {
	let n = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) n += countFiles(path);
		else if (entry.isFile()) n++;
	}
	return n;
}

async function download(url: string, attempts = 3): Promise<Uint8Array> {
	let last = '';
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
			return new Uint8Array(await res.arrayBuffer());
		} catch (e) {
			last = e instanceof Error ? e.message : String(e);
		}
	}
	throw new Error(`could not fetch ${url} in ${attempts} attempts: ${last}`);
}

/**
 * Puts the locked WordPress release in `wordpress-src/`, or explains why it will not.
 *
 * @param force - replace a tree that is present but not at the locked commit
 */
export async function fetchWordpressTree(
	force = false,
	lock = readWordpressLock()
): Promise<FetchResult> {
	const treeExists = existsSync(WORDPRESS_TREE);
	const manifestPath = join(WORDPRESS_TREE, MANIFEST_NAME);
	const present = existsSync(manifestPath)
		? (JSON.parse(readFileSync(manifestPath, 'utf8')) as WordpressManifest)
		: undefined;

	const action = planExtract(treeExists, present?.sha, lock.sha, force);
	if (action === 'already-present')
		return {
			root: WORDPRESS_TREE,
			tag: lock.tag,
			sha: lock.sha,
			action,
			files: present?.files ?? 0
		};

	const bytes = await download(lock.tarball);
	verifyDigest(lock, createHash('sha256').update(bytes).digest('hex'));

	const tarball = join(tmpdir(), `wordpress-${lock.sha}.tar.gz`);
	writeFileSync(tarball, bytes);
	if (treeExists)
		renameSync(WORDPRESS_TREE, join(tmpdir(), `wordpress-src-replaced-${Date.now()}`));
	mkdirSync(WORDPRESS_TREE);
	execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', WORDPRESS_TREE]);
	rmSync(tarball, { force: true });

	const files = countFiles(WORDPRESS_TREE);
	writeFileSync(manifestPath, JSON.stringify(treeManifest(lock, files), null, '\t') + '\n');
	return { root: WORDPRESS_TREE, tag: lock.tag, sha: lock.sha, action: 'extracted', files };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.includes('--help')) {
		console.error('usage: bun scripts/fetch-wordpress-tree.ts [--force]');
		process.exit(2);
	}
	const result = await fetchWordpressTree(args.includes('--force'));
	console.log(
		`${result.root}  WordPress ${result.tag} (${result.sha.slice(0, 12)}) ${result.action}, ` +
			`${result.files.toLocaleString()} files`
	);
}
