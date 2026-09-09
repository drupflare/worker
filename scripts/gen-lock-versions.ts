import { readFileSync, writeFileSync } from 'node:fs';
import { lockVersions } from '../src/ops/packagist';

/**
 * Bakes `composer.lock`'s name -> version map into a TypeScript constant.
 *
 *   bun scripts/gen-lock-versions.ts
 *
 * THE ROOT LOCK, WHICH IS WHAT BREAKS A CYCLE. This read `drupal-src/composer.lock` until
 * 2026-09-09, and that tree is materialised by `fetch-drupal-tree.ts` at the version
 * `SHIPPED_CORE_VERSION` names -- so the tree's lock decided what version populated the tree and
 * could only ever confirm itself. The root lock sat outside the loop and nothing read it.
 *
 * `composer.json` therefore requires `drupal/core-recommended` and the four contrib modules
 * directly. `composer update` at the root is now the one place a version moves, and everything
 * downstream reads the result: the tarball `fetch:drupal` pulls, the pins it installs beside it, and
 * the installed map the runtime answers an installability question against.
 *
 * Baked rather than fetched. The map is ~2.4 KB, and the installability check's whole value is that a
 * refusal costs ONE subrequest; spending a second one to learn what this site already ships would
 * halve that. It is also part of the bundle's identity -- the lock and the packed Drupal tree have
 * to agree, and a runtime fetch could disagree with the tree that shipped beside it.
 *
 * `tests/node/shipped-lock.spec.ts` fails when this drifts from the lock on disk, because
 * `assets/driver.json` went silently stale twice by exactly this mechanism.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const lock = JSON.parse(readFileSync(`${ROOT}composer.lock`, 'utf8'));
const versions = lockVersions(lock);
const names = Object.keys(versions).sort();

const body = `/**
 * What this site ships, from the root \`composer.lock\`. GENERATED -- run
 * \`bun run gen:lock\` after any composer change; \`tests/node/shipped-lock.spec.ts\` fails on drift.
 */
export const SHIPPED_LOCK_VERSIONS: Record<string, string> = {
${names.map((n) => `\t${JSON.stringify(n)}: ${JSON.stringify(versions[n])}`).join(',\n')}
};

/** the Drupal core version these packages were locked against */
export const SHIPPED_CORE_VERSION = ${JSON.stringify(versions['drupal/core'] ?? '')};
`;

writeFileSync(`${ROOT}src/ops/shipped-lock.ts`, body);
console.log(
	JSON.stringify(
		{ packages: names.length, core: versions['drupal/core'], bytes: body.length },
		null,
		2
	)
);
