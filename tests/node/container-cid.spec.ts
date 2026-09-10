import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packVersionsHash } from '../../scripts/pack-hash.js';
import { artifactGate } from './helpers/artifact-gate';

/**
 * The packed `cache_container` row has to be keyed to the dependency set the PACK carries.
 *
 * `DrupalKernel::getContainerCacheKey()` puts `DrupalInstalled::VERSIONS_HASH` in the cid, and that
 * hash moves on every composer change. When the pack and the database disagree, the first
 * `$kernel->boot()` on every site MISSES and rebuilds a 482 KB container: `kernelBootMs` 1,024
 * against 86, and ~3.7x the heap image.
 *
 * THIS COMPARED THE DATABASE AGAINST `drupal-src` AND SKIPPED WHENEVER THAT TREE HAD DEV
 * DEPENDENCIES. Both halves were wrong. `drupal-src` is not what boots -- the pack is -- so the
 * comparison was against a tree the runtime never reads, which is why it needed an escape hatch at
 * all. And the hatch fired on exactly the trees that break it: `composer require --dev
 * drupal/<module>` is how the contrib lane gets its fixture, so a machine running that lane silently
 * turned the check off. The drift then shipped and three heap specs caught it instead, by magnitude,
 * naming nothing.
 *
 * Pack against database is always meaningful and never needs skipping. `bun run assets:container`
 * is the repair.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
const SQLITE = resolve(ROOT, 'assets', 'drupal', 'site.sqlite');

/**
 * The release-lane boundary, and the only legitimate reason to skip: a clean checkout has neither.
 *
 * Through `artifactGate` rather than a bare `existsSync`, because a bare one skips in EVERY lane --
 * including the release lane, which sets `REQUIRE_ARTIFACTS` precisely to say it has the artifacts.
 * This check was already off on every machine able to run the contrib lane once, and the drift it
 * guards shipped; a second silent skip is the same failure with a different condition.
 */
const have = !artifactGate(['assets/drupal/site.sqlite', 'assets/drupal-pf/core.pf.bin']);

type Row = { cid: string; bytes: number; expire: number };

function containerRows(): Row[] {
	return JSON.parse(
		execFileSync(
			'php',
			[
				'-r',
				`$d = new PDO("sqlite:" . $argv[1]);
				 echo json_encode($d->query('SELECT cid, length(data) AS bytes, expire FROM cache_container')->fetchAll(PDO::FETCH_ASSOC));`,
				'--',
				SQLITE
			],
			{ encoding: 'utf8' }
		)
	) as Row[];
}

describe.skipIf(!have)('the packed container row', () => {
	it('is keyed to the dependency set the pack carries', async () => {
		const hash = packVersionsHash();
		const rows = containerRows();

		// exactly one, or a boot picks whichever matches and the other is dead weight
		expect(rows).toHaveLength(1);
		expect(rows[0]!.cid).toContain(`service_container:prod:${hash}:`);
		// a container that expires is a container rebuilt on a schedule
		expect(Number(rows[0]!.expire)).toBe(-1);
		expect(rows[0]!.bytes).toBeGreaterThan(100_000);
	});

	it('was baked by the runtime rather than by a native php', async () => {
		// the compiled container embeds the absolute root it was built against, so a row baked under
		// `php` on this machine is wrong for the runtime whatever its key says -- 27 build-machine
		// paths in one measured natively. The cid records both, which makes it checkable
		const [row] = containerRows();
		expect(row!.cid).toContain('/drupal/sites/default/services.yml');
		expect(row!.cid).toContain(':Linux:');
		expect(row!.cid).not.toMatch(/\/(?:Users|home)\//);
	});
});
