import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The payload may not overwrite what the repository tracks.
 *
 * A payload is a snapshot of `assets/`, and some of those paths are tracked in git. For those the
 * repository is authoritative and the payload holds a stale copy by construction, so landing it
 * silently reverts whatever the tree deliberately holds.
 *
 * **The same defect was already fixed once, in `restore-artifacts.ts`.** A `cdn-manifest.json`
 * entry overwrote the tracked `assets/drupal/site.sqlite` on every `bun install` and turned
 * `container-cid.spec.ts` red on a tree nobody had edited; that entry is marked `tracked` and the
 * restore verifies it and leaves it alone. `hydrate.ts` never got the same treatment, and the
 * published payload names two tracked paths.
 *
 * `assets/driver.json` is tracked for a second reason worth stating: it is built from the sibling
 * checkouts at the versions `composer.lock` pins, so the repository CAN produce it -- but the
 * deploy build runs neither composer nor a sibling checkout, so the only copy it could otherwise
 * reach is whatever a published payload happens to carry. That made a sibling fix wait on a payload
 * republish before it could reach a site.
 */
describe('hydrate leaves the repository its own files', () => {
	const tracked = new Set(
		execFileSync('git', ['-C', root, 'ls-files', '-z'], {
			encoding: 'utf8',
			maxBuffer: 1 << 26
		})
			.split('\0')
			.filter(Boolean)
	);

	it('tracks the driver pack, so a deploy does not wait on a payload for it', () => {
		expect(existsSync(join(root, 'assets', 'driver.json'))).toBe(true);
		expect(tracked.has('assets/driver.json')).toBe(true);
	});

	it('keeps the other repository-owned assets tracked', () => {
		expect(tracked.has('assets/robots.txt')).toBe(true);
		expect(tracked.has('assets/.assetsignore')).toBe(true);
		expect(tracked.has('assets/drupal/site.sqlite')).toBe(true);
	});

	it('asks git for the set rather than carrying a list that can drift', () => {
		const src = readFileSync(join(root, 'scripts', 'hydrate.ts'), 'utf8');
		expect(src).toContain("'ls-files'");
		// and it must SKIP rather than copy when a path is tracked
		expect(src).toMatch(/tracked\.has\(file\.path\)/);
	});

	it('reports a payload that disagrees rather than resolving it in silence', () => {
		// a tracked file the payload also carries is a real disagreement when the bytes differ, and
		// it means the payload was built from a different tree; the pack and the database it was
		// baked against have to agree or every first kernel boot rebuilds the container
		const src = readFileSync(join(root, 'scripts', 'hydrate.ts'), 'utf8');
		expect(src).toContain('differs from the payload');
	});
});
