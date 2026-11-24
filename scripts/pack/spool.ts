import { clientPath, navigatePath } from '@drupflare/spool/protocol';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { resetSpoolBudget, SPOOL_SW_PATH } from '../../src/ops/spool';
import { resetSpoolMemo, throughSpool } from '../../src/site/spool';
import type { SiteWorkerEnv } from '../../src/site/types';

/**
 * Writes the files spool serves with no Worker invocation into `assets/`:
 *
 *   bun scripts/pack/spool.ts          write them
 *   bun scripts/pack/spool.ts --check  exit 1 when a file on disk is not what the worker answers
 *
 * They are the worker script and the two page scripts of the installed library, taken from the
 * worker's own spool handler rather than from the library, so the bytes are the ones a device would
 * get from the Worker. `assets/_headers` and `assets/.assetsignore` carry the matching rules.
 */

const repo = new URL('../..', import.meta.url).pathname;
const assets = join(repo, 'assets');

/** the directory under `assets/` that holds the versioned page scripts */
export const SPOOL_ASSET_DIR = '.spool';

/** the installed library's version, which names the directory of its page scripts */
export function installedVersion(): string {
	const require = createRequire(import.meta.url);
	return (require('@drupflare/spool/package.json') as { version: string }).version;
}

/** the asset path of each file spool serves statically, relative to `assets/` */
export function spoolAssetPaths(version: string = installedVersion()): string[] {
	return [SPOOL_SW_PATH, clientPath(version), navigatePath(version)].map((p) => p.slice(1));
}

/** every file, as the worker answers it, keyed by its path under `assets/` */
export async function spoolAssetFiles(): Promise<Map<string, Uint8Array>> {
	const env = { PLAN: 'paid', SPOOL: '1' } as unknown as SiteWorkerEnv;
	const files = new Map<string, Uint8Array>();
	resetSpoolBudget();
	resetSpoolMemo();
	for (const path of spoolAssetPaths()) {
		const res = await throughSpool(
			new Request(`https://spool.pack/${path}`),
			env,
			'pack',
			() => {
				throw new Error(`the pipeline was asked for ${path}`);
			}
		);
		if (res.status !== 200) throw new Error(`the worker answered ${path} with ${res.status}`);
		files.set(path, new Uint8Array(await res.arrayBuffer()));
	}
	return files;
}

/** the version directories under `assets/.spool` other than `keep`, which a library upgrade leaves behind */
function staleVersions(keep: string): string[] {
	const dir = join(assets, SPOOL_ASSET_DIR);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => name !== keep);
}

/** the files that differ from what the worker answers, and the stale version directories */
export async function spoolAssetDrift(): Promise<string[]> {
	const drift: string[] = [];
	for (const [path, bytes] of await spoolAssetFiles()) {
		const file = join(assets, path);
		if (!existsSync(file) || !Buffer.from(bytes).equals(readFileSync(file))) drift.push(path);
	}
	for (const name of staleVersions(installedVersion())) {
		drift.push(`${SPOOL_ASSET_DIR}/${name}`);
	}
	return drift;
}

/** writes the files and removes the page scripts of any other library version */
export async function writeSpoolAssets(): Promise<string[]> {
	for (const name of staleVersions(installedVersion())) {
		rmSync(join(assets, SPOOL_ASSET_DIR, name), { recursive: true });
	}
	const written: string[] = [];
	for (const [path, bytes] of await spoolAssetFiles()) {
		const file = join(assets, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, bytes);
		written.push(path);
	}
	return written;
}

if (import.meta.main) {
	if (process.argv.includes('--check')) {
		const drift = await spoolAssetDrift();
		if (drift.length > 0) {
			console.error(
				`spool assets are stale: ${drift.join(', ')}\nrun: bun scripts/pack/spool.ts`
			);
			process.exit(1);
		}
		console.log('spool assets match the worker');
	} else {
		for (const path of await writeSpoolAssets()) console.log(`wrote assets/${path}`);
	}
}
