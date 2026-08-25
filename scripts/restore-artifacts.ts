/**
 * Populates the gitignored interpreter a clean clone needs, from the public CDN.
 *
 * ```sh
 * bun scripts/restore-artifacts.ts           # verify, download only what is missing or wrong
 * bun scripts/restore-artifacts.ts --force   # re-download even when the digest already matches
 * bun scripts/restore-artifacts.ts --strict  # exit non-zero on a failed fetch, for a build step
 * DRUPFLARE_SKIP_RESTORE=1 bun install       # opt out entirely
 * ```
 *
 * WHY THIS IS A postinstall AND NOT A CI STEP. `src/site-do.ts` imports the interpreter at module
 * scope, so EVERY workers spec needs it to resolve -- clone, edit, `bun run test` and 34 spec files
 * fail to import before a single assertion runs. That is a contributor-onboarding defect that CI
 * merely happened to surface first, and a CI-only download would have left it in place for everyone
 * working locally.
 *
 * NO CREDENTIAL. The bucket is fronted by a custom domain, which is the same property that lets
 * `bun run backup:verify` HEAD every key from CI without a secret.
 *
 * IDEMPOTENT AND HASHED. Every entry carries its size and sha256 in `cdn-manifest.json`, so a file
 * already on disk is verified rather than re-fetched, and a truncated or swapped object fails here
 * with a named reason instead of as a confusing wasm error later.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
	ARCHIVED,
	MANIFEST_PATH,
	fetchFromCdn,
	type ArchivedEntry,
	type CdnManifest
} from './backup-cdn';
import { emitTunedGlue, glueFor } from './measure/growth-glue.js';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * What a clean clone needs to run the gate: the interpreter the TEST lane loads.
 *
 * Taken from the manifest's `mirrors` field rather than hardcoded -- those entries already record
 * that `vendor/static-control85/php8.5*` in the bucket is the shipping binary saved under phasm's
 * variant name, and where it belongs on disk. Everything else in `vendor/` is the 18-arm measurement
 * fleet the frozen probes read, which is 198 MB and which no contributor needs to run tests.
 */
function wanted(manifest: CdnManifest): ArchivedEntry[] {
	return [...(manifest.archived ?? ARCHIVED)].filter((e) => e.mirrors?.startsWith('.interp/'));
}

/** whether the file at `path` already has this digest; the local file IS the cache */
function current(path: string, sha256: string, bytes: number): boolean {
	if (!existsSync(path)) return false;
	const body = readFileSync(path);
	if (body.length !== bytes) return false;
	return createHash('sha256').update(body).digest('hex') === sha256;
}

async function restore(entry: ArchivedEntry, target: string): Promise<void> {
	const res = await fetchFromCdn(entry.key, {
		headers: { 'accept-encoding': 'identity' }
	});
	if (!res.ok) throw new Error(`${entry.key}: HTTP ${res.status}`);
	const body = new Uint8Array(await res.arrayBuffer());
	if (body.length !== entry.bytes) {
		throw new Error(`${entry.key}: got ${body.length} bytes, manifest says ${entry.bytes}`);
	}
	const sha = createHash('sha256').update(body).digest('hex');
	if (sha !== entry.sha256) {
		throw new Error(`${entry.key}: sha256 ${sha}, manifest says ${entry.sha256}`);
	}
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, body);
}

if (import.meta.main) {
	// an opt-out matters because this is a postinstall: a contributor on a metered connection, or one
	// who only wants to read the source, should not be made to pull 13 MB to run `bun install`
	if (process.env.DRUPFLARE_SKIP_RESTORE) {
		console.log('restore-artifacts: skipped (DRUPFLARE_SKIP_RESTORE)');
		process.exit(0);
	}

	const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST_PATH), 'utf8')) as CdnManifest;
	const force = process.argv.includes('--force');
	// a postinstall must never fail; `bun run build:local` calls the same script as a STEP, where a
	// silent success would hand the next step a missing interpreter and fail somewhere unrelated
	const strict = process.argv.includes('--strict');

	let fetched = 0;
	let held = 0;
	for (const entry of wanted(manifest)) {
		const target = join(ROOT, entry.mirrors as string);
		if (!force && current(target, entry.sha256, entry.bytes)) {
			held++;
			continue;
		}
		try {
			await restore(entry, target);
			fetched++;
			console.log(
				`restore-artifacts: ${entry.mirrors} (${entry.bytes} bytes, sha256 verified)`
			);
		} catch (e) {
			// NEVER fail the install. A contributor offline, or behind a proxy, still gets a working
			// checkout: the vitest config stubs the interpreter and names the specs it skipped, so the
			// failure mode is reduced coverage with a printed reason rather than a broken `bun install`
			console.warn(
				`restore-artifacts: could not fetch ${entry.key}: ${(e as Error).message}` +
					(strict
						? ''
						: '\n  the test lane will stub the interpreter and skip the specs that boot it.')
			);
			process.exit(strict ? 1 : 0);
		}
	}
	// AFTER verification, never instead of it. The shipping seam imports the TUNED glue, whose
	// growth step is 0.05 rather than emscripten's 0.20 -- measured, 0.20 does not fit an
	// authenticated render inside the 128 MiB isolate at all. See `SHIPPING_STEP`.
	try {
		console.log(`restore-artifacts: tuned glue -> ${emitTunedGlue(ROOT)}`);
	} catch (e) {
		console.warn(`restore-artifacts: could not emit the tuned glue: ${(e as Error).message}`);
		if (strict) process.exit(1);
	}
	// the wasm64 arm, when its build is present. Never fetched -- `phasm` publishes it separately
	// and it is an experiment rather than a shipping artifact -- so its absence is silent. What is
	// NOT silent is running the gate against emscripten's 0.20 while production runs 0.05, which is
	// what the manual substitution left open
	if (existsSync(resolve(ROOT, glueFor('wasm64')))) {
		try {
			console.log(`restore-artifacts: tuned wasm64 glue -> ${emitTunedGlue(ROOT, 'wasm64')}`);
		} catch (e) {
			console.warn(
				`restore-artifacts: wasm64 glue present but not tunable: ${(e as Error).message}`
			);
			if (strict) process.exit(1);
		}
	}

	console.log(
		`restore-artifacts: ${fetched} downloaded, ${held} already current` +
			(fetched > 0 ? '' : ' (nothing to do)')
	);
}
