/**
 * Reads `DrupalInstalled::VERSIONS_HASH` out of the per-file pack.
 *
 * The PACK is what the interpreter mounts, so the pack's hash is the one a kernel boot computes and
 * the one the packed `cache_container` row has to be keyed to. `drupal-src/vendor` agrees only when
 * the pack was built from the current tree.
 *
 * Its own module because both consumers need it and they run on different runtimes:
 * `bake-container.ts` is bun, and `tests/node/container-cid.spec.ts` is node, which cannot import
 * anything that reaches `bun:sqlite`.
 */

import { inflateSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

export const PACK_MANIFEST = resolve(ROOT, 'assets', 'drupal-pf', 'core.pf.json');
export const PACK_BIN = resolve(ROOT, 'assets', 'drupal-pf', 'core.pf.bin');

type Entry = { p: string; o: number; c: number; l: number };

export function packVersionsHash(): string {
	const manifest = JSON.parse(readFileSync(PACK_MANIFEST, 'utf8')) as Record<string, Entry>;
	const entry = Object.values(manifest).find((e) => e.p === 'vendor/drupal/DrupalInstalled.php');
	if (!entry) throw new Error('the pack carries no vendor/drupal/DrupalInstalled.php');

	const bin = new Uint8Array(readFileSync(PACK_BIN));
	// no `{ out }` hint: a preallocated buffer makes fflate TRUNCATE quietly to that length
	const raw = inflateSync(bin.subarray(entry.o, entry.o + entry.c));
	if (raw.length !== entry.l) {
		throw new Error(`DrupalInstalled.php inflated to ${raw.length}, manifest says ${entry.l}`);
	}
	const hash = /VERSIONS_HASH\s*=\s*'([0-9a-f]+)'/.exec(new TextDecoder().decode(raw))?.[1];
	if (!hash) throw new Error('the packed DrupalInstalled.php carries no VERSIONS_HASH');
	return hash;
}
