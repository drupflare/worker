import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The packed `cache_container` row has to be keyed to the dependency set that ships.
 *
 * `DrupalKernel::getContainerCacheKey()` puts `DrupalInstalled::VERSIONS_HASH` in the cid, and that
 * hash moves on every composer change. The pack shipped a row keyed to an older one -- cid
 * `dbbbce4907a2ede9` against a tree computing `d87c6ada93448a4f` -- so the first `$kernel->boot()`
 * on every site MISSED and rebuilt a 482 KB container. Measured in the gate lane on a local wall
 * clock: `kernelBootMs` 1,024 against 86 once the row matched.
 *
 * It rots silently and by construction, which is why this exists rather than a comment.
 * `scripts/fix-container-cid.ts` is the repair.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
const SQLITE = resolve(ROOT, 'assets', 'drupal', 'site.sqlite');
const INSTALLED = resolve(ROOT, 'drupal-src', 'vendor', 'drupal', 'DrupalInstalled.php');

const have = existsSync(SQLITE) && existsSync(INSTALLED);

describe.skipIf(!have)('the packed container row', () => {
	it('is keyed to the dependency set this tree ships', () => {
		const hash = /VERSIONS_HASH\s*=\s*'([0-9a-f]+)'/.exec(readFileSync(INSTALLED, 'utf8'))?.[1];
		expect(hash, 'no VERSIONS_HASH in drupal-src').toBeTruthy();

		const rows = JSON.parse(
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
		) as { cid: string; bytes: number; expire: number }[];

		// exactly one, or a boot picks whichever matches and the other is dead weight
		expect(rows).toHaveLength(1);
		expect(rows[0]!.cid).toContain(`service_container:prod:${hash}:`);
		// a container that expires is a container rebuilt on a schedule
		expect(Number(rows[0]!.expire)).toBe(-1);
		expect(rows[0]!.bytes).toBeGreaterThan(100_000);
	});
});
