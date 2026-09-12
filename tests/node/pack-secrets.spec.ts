import { describe, expect, it } from 'vitest';
import { expandPlan, payloadPlan, scanSeededCredentials } from '../../scripts/release-payload.ts';
import { readEntry, readPack, scrubPack } from '../../scripts/scrub-pack-secrets.ts';
import { artifactGate } from './helpers/artifact-gate';

/**
 * The shipped assets carry no secret, asserted against the real artifacts.
 *
 * Node lane, artifact-gated: a clean checkout has no `assets/`, and the release lane hydrates the
 * payload and sets `REQUIRE_ARTIFACTS=1` so a dirty pack fails there before anything is published.
 */

const PACK = 'assets/drupal-pf';
const ARTIFACTS = [`${PACK}/core.pf.json`, `${PACK}/core.pf.bin`, 'assets/drupal-sql'];

describe.skipIf(artifactGate(ARTIFACTS))('the shipped assets', () => {
	it('publish no credential any two sites would share', () => {
		const root = process.cwd();
		const found = scanSeededCredentials(root, expandPlan(root, payloadPlan(root)));
		expect(found).toEqual([]);
	});

	it('assign an EMPTY hash_salt, so a missing host override throws instead of sharing one', () => {
		// Settings::getHashSalt() rejects an empty value outright. That is the failure mode worth
		// having: a site that cannot boot is recoverable, a fleet signing reset links with one
		// public salt is not
		const { index, bin } = readPack(PACK);
		const entry = Object.values(index).find((e) => e.p === 'sites/default/settings.php');
		expect(entry, 'the pack must contain settings.php').toBeDefined();
		const php = new TextDecoder().decode(readEntry(bin, entry!));
		expect(php).toMatch(/^\$settings\['hash_salt'\] = '';$/m);
		expect(php).not.toMatch(/^\$settings\['hash_salt'\] = '[^']+';$/m);
	});

	it('leave the scrub with nothing to do, and it stays that way when run again', () => {
		// idempotence is the property that lets `bun run assets` end with a scrub: a repack
		// reintroduces the salt, and a second scrub of an already-clean pack must not rewrite it.
		//
		// THE PROPERTY, NOT THE ENUMERATION. This pinned a one-element list, so it failed on a
		// FROM-SOURCE pack for a correct reason: that pack also carries `sites/build/settings.php`,
		// the installer's own output, so the scrub reports on two files rather than one. What has to
		// hold is that every file it reports on is already clean
		for (const check of [true, false]) {
			const results = scrubPack(PACK, check);
			expect(results.length, 'the scrub reported on no file at all').toBeGreaterThan(0);
			expect(results.map((r) => r.path)).toContain('sites/default/settings.php');
			for (const r of results) {
				expect(r, `${r.path} still carries ${r.found.join(', ')}`).toMatchObject({
					found: [],
					rewritten: false
				});
			}
		}
	});
});
