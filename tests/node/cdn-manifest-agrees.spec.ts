import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtFromSource } from './helpers/artifact-gate';

/**
 * `bun install` restores from the CDN, and a manifest that disagrees with a TRACKED file makes it a
 * downgrade.
 *
 * `restore-artifacts` verifies each file against `cdn-manifest.json` and re-downloads anything that
 * does not match. For an untracked artifact that is exactly right -- the bucket is the source of
 * truth and the file is not in the repository. For a file git DOES track it inverts: the committed
 * version is the source of truth, and a stale manifest entry means every `bun install` silently
 * replaces it with an older copy.
 *
 * MEASURED, not hypothetical. `assets/drupal/site.sqlite` is tracked, its committed hash is
 * `f97005b9...`, and the manifest asserted `2259f3f9...` -- an older lineage whose
 * `cache_container` row is keyed to `dbbbce4907a2ede9` against a tree computing `d87c6ada93448a4f`.
 * So an install undid the container-cid repair that `tests/node/container-cid.spec.ts` exists to
 * catch, and the spec then failed on a working tree nobody had edited.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
const MANIFEST = resolve(ROOT, 'cdn-manifest.json');

type Entry = { key: string; sha256: string; bytes: number; mirrors?: string; tracked?: boolean };

function manifest(): { keys?: Entry[]; archived?: Entry[] } {
	return JSON.parse(readFileSync(MANIFEST, 'utf8')) as { keys?: Entry[]; archived?: Entry[] };
}

function entries(): Entry[] {
	const m = manifest();
	return [...(m.keys ?? []), ...(m.archived ?? [])];
}

/**
 * The entries a restore would ACT on: present on disk, and not marked as the repository's.
 *
 * A `tracked` entry is verified and skipped by `restore-artifacts`, so it is not a file about to be
 * replaced -- but it is still checked. **The exemption used to skip the sha too, "a stale manifest to
 * fix at leisure", and leisure did not come**: `assets/drupal/site.sqlite` was committed twice after
 * the manifest last recorded it, and the manifest went on naming the first of the two max_age fixes
 * while `backup:cdn` reported an `etag-mismatch` nobody could read. Not overwriting a file and not
 * checking it are different exemptions and only the first was earned.
 */
function present(): Array<Entry & { path: string }> {
	return entries()
		.map((e) => ({ ...e, path: resolve(ROOT, e.mirrors ?? e.key) }))
		.filter((e) => existsSync(e.path));
}

// `assets:container` rewrites `site.sqlite` in place, so a built tree legitimately disagrees with
// the manifest describing the published one
describe.skipIf(builtFromSource())('the CDN manifest against the files it would overwrite', () => {
	it('found entries to check, or it is asserting nothing', () => {
		expect(entries().length).toBeGreaterThan(10);
	});

	it('marks the tracked file as the repository, so a restore leaves it alone', () => {
		// the one that proved this matters: committed, and the manifest named an older lineage
		const sqlite = entries().find((e) => (e.mirrors ?? e.key) === 'assets/drupal/site.sqlite');
		expect(sqlite?.tracked, 'assets/drupal/site.sqlite is committed').toBe(true);
	});

	it('agrees with every artifact a restore would act on', () => {
		const disagree: string[] = [];
		for (const entry of present()) {
			const body = readFileSync(entry.path);
			const sha = createHash('sha256').update(body).digest('hex');
			if (sha !== entry.sha256 || body.length !== entry.bytes) {
				disagree.push(
					`${entry.key}: on disk ${sha} (${body.length}b), manifest ${entry.sha256} (${entry.bytes}b)`
				);
			}
		}
		// a disagreement here is not cosmetic: the next `bun install` acts on it
		expect(disagree).toEqual([]);
	});
});
