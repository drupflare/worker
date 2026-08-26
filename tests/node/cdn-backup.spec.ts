import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	ARCHIVED,
	BUCKET,
	driftBetween,
	fetchFromCdn,
	MANIFEST_PATH,
	manifestFromDisk,
	mirrorProblems,
	ORIGIN,
	ORIGIN_FALLBACK,
	ORIGINS,
	verdictFor,
	type CdnEntry,
	type CdnManifest
} from '../../scripts/backup-cdn.ts';

/**
 * The backup of the two artifacts nothing regenerates.
 *
 * A backup that carries REGENERABLE output is how three divergent copies of
 * `assets/drupal/site.sqlite` came to exist with nothing marking one canonical, so the manifest's
 * contents are asserted here and not only its arithmetic.
 *
 * No network. `bun run backup:verify` does the HEAD pass and `.github/workflows/backup.yml` runs it.
 */

const temps: string[] = [];
function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), 'cdn-spec-'));
	temps.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const entry = (
	key: string,
	bytes = 10,
	sha256 = 'a'.repeat(64),
	md5 = 'b'.repeat(32)
): CdnEntry => ({ key, bytes, sha256, md5 });

const manifest = (keys: CdnEntry[]): CdnManifest => ({
	bucket: BUCKET,
	origin: ORIGIN,
	version: 1,
	keys,
	archived: []
});

describe('the manifest describes the tree', () => {
	it('walks a directory entry and digests every file twice', () => {
		const root = fixture();
		mkdirSync(join(root, 'vendor/static-o2'), { recursive: true });
		mkdirSync(join(root, 'assets/drupal'), { recursive: true });
		writeFileSync(join(root, 'vendor/static-o2/php8.3-worker.mjs'), 'glue');
		writeFileSync(join(root, 'vendor/.DS_Store'), 'noise');
		writeFileSync(join(root, 'assets/drupal/site.sqlite'), 'db');

		const built = manifestFromDisk(root);
		expect(built.keys.map((e) => e.key)).toEqual([
			'vendor/static-o2/php8.3-worker.mjs',
			'assets/drupal/site.sqlite'
		]);
		expect(built.keys[0]!.bytes).toBe(4);
		expect(built.keys[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
		// the md5 exists to be compared against an R2 ETag without downloading the object
		expect(built.keys[0]!.md5).toMatch(/^[0-9a-f]{32}$/);
		expect(built.bucket).toBe(BUCKET);
	});

	it('reports added, removed and changed keys against a committed manifest', () => {
		const before = manifest([entry('vendor/a'), entry('vendor/b'), entry('vendor/c')]);
		const after = manifest([
			entry('vendor/a'),
			entry('vendor/c', 10, 'c'.repeat(64)),
			entry('vendor/d')
		]);
		expect(driftBetween(before, after)).toEqual({
			added: ['vendor/d'],
			removed: ['vendor/b'],
			changed: ['vendor/c']
		});
	});
});

describe('scoring a key against the bucket', () => {
	const local = entry('vendor/a', 100, 'a'.repeat(64), 'd'.repeat(32));

	it('passes only when the size and the ETag both match', () => {
		expect(verdictFor(local, 200, 100, `"${'d'.repeat(32)}"`)).toBe('ok');
		expect(verdictFor(local, 200, 100, `"${'e'.repeat(32)}"`)).toBe('etag-mismatch');
		expect(verdictFor(local, 200, 99, `"${'d'.repeat(32)}"`)).toBe('size-mismatch');
	});

	it('calls any non-200 missing', () => {
		expect(verdictFor(local, 404)).toBe('missing');
		expect(verdictFor(local, 403)).toBe('missing');
	});

	it('refuses to score a response with no content-length', () => {
		// the domain answers a default HEAD with content-encoding: zstd and no length, and comparing
		// nothing would report every key as a mismatch
		expect(verdictFor(local, 200)).toBe('no-length');
	});

	it('degrades to size-only for a multipart ETag, which is not an md5', () => {
		expect(verdictFor(local, 200, 100, '"abc-3"')).toBe('size-only');
		expect(verdictFor(local, 200, 100)).toBe('size-only');
	});
});

describe('an archive is a snapshot', () => {
	it('fails when a mirrored local file has moved on from the archived bytes', () => {
		const root = fixture();
		mkdirSync(join(root, 'assets/drupal'), { recursive: true });
		writeFileSync(join(root, 'assets/drupal/site.sqlite'), 'edited in place');
		const problems = mirrorProblems(root, [
			{ ...entry('snapshots/x'), mirrors: 'assets/drupal/site.sqlite', note: 'x' }
		]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/no longer matches/);
	});

	it('says nothing about a mirror that is absent, because an unbuilt tree is not a failure', () => {
		const root = fixture();
		expect(
			mirrorProblems(root, [
				{ ...entry('snapshots/x'), mirrors: '.interp/php8.5.wasm', note: 'x' }
			])
		).toEqual([]);
	});
});

describe('what the backup is allowed to contain', () => {
	const committed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as CdnManifest;

	it('carries only paths nothing regenerates', () => {
		for (const { key } of committed.keys) {
			expect(
				key.startsWith('vendor/') || key === 'assets/drupal/site.sqlite',
				`${key} is regenerable; backing output up is what produced three divergent copies`
			).toBe(true);
		}
	});

	it('carries no pack, no interpreter frame and no driver asset', () => {
		const keys = committed.keys.map((e) => e.key).join('\n');
		for (const regenerable of [
			'assets/driver.json',
			'assets/drupal-pf/',
			'assets/drupal-sql/',
			'.zst'
		]) {
			expect(keys).not.toContain(regenerable);
		}
	});

	it('points at the bucket the recovery instructions name', () => {
		expect(committed.bucket).toBe('drupflare-cdn');
		expect(committed.origin).toBe('https://drupflare-cdn.gmitch215.dev');
	});

	it('keeps every superseded site.sqlite lineage', () => {
		const lineages = ARCHIVED.filter((e) => e.key.includes('site.sqlite'));
		expect(lineages.length).toBeGreaterThanOrEqual(3);
		for (const lineage of lineages) {
			expect(lineage.md5).toMatch(/^[0-9a-f]{32}$/);
			expect(lineage.note.length).toBeGreaterThan(10);
		}
	});

	it('mirrors the shipping interpreter, whose upstream source expires', () => {
		const mirrored = ARCHIVED.filter((e) => e.mirrors?.startsWith('.interp/'));
		expect(mirrored.map((e) => e.key)).toEqual([
			'vendor/static-long64/php8.5-worker.mjs.wasm',
			'vendor/static-long64/php8.5-worker.mjs'
		]);
	});

	it('agrees with the archive list the script carries', () => {
		expect(committed.archived.map((e) => e.key)).toEqual(ARCHIVED.map((e) => e.key));
	});
});

/**
 * THE SAME BUCKET UNDER A SECOND NAME.
 *
 * Some networks blocklist the whole `.dev` TLD, and it surfaces as
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` rather than as anything that reads like a DNS policy -- so a
 * restore or a verify fails in a way that looks like the bucket is wrong. The mirror is tried only
 * on a TRANSPORT failure: a reachable origin answering 404 is an answer, and retrying it elsewhere
 * would hide real manifest drift.
 */
describe('the CDN mirror, tried when the documented origin cannot be reached', () => {
	it('keeps the documented origin first', () => {
		expect(ORIGINS[0]).toBe(ORIGIN);
		expect(ORIGIN).toContain('.dev');
		expect(ORIGIN_FALLBACK).toContain('.xyz');
	});

	it('falls through to the mirror when the first origin throws', async () => {
		const tried: string[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			tried.push(url);
			if (url.startsWith(ORIGIN)) throw new Error('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
			return new Response('ok', { status: 200 });
		}) as typeof fetch;
		try {
			const res = await fetchFromCdn('some/key');
			expect(res.status).toBe(200);
		} finally {
			globalThis.fetch = original;
		}
		expect(tried).toHaveLength(2);
		expect(tried[1]?.startsWith(ORIGIN_FALLBACK)).toBe(true);
	});

	/** a 404 is an ANSWER; retrying it on the mirror would mask a manifest that has drifted */
	it('does NOT retry a reachable origin that answered', async () => {
		const tried: string[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			tried.push(String(input));
			return new Response('no', { status: 404 });
		}) as typeof fetch;
		try {
			expect((await fetchFromCdn('missing/key')).status).toBe(404);
		} finally {
			globalThis.fetch = original;
		}
		expect(tried).toHaveLength(1);
	});

	it('names the failure when no origin answers at all', async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error('offline');
		}) as unknown as typeof fetch;
		try {
			await expect(fetchFromCdn('k')).rejects.toThrow(/no CDN origin answered/);
		} finally {
			globalThis.fetch = original;
		}
	});
});
