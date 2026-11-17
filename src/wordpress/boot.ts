import { mountDrupalLazy, mountRecord } from '@drupflare/cartridge/fs';
import { assetRequestCounts, packCachedEnv, type SiteMountInfo } from '../do/lazy-mount';
import type { SiteBinary } from '../do/types';
import { ensureHashSalt } from '../ops/site-secrets';
import type { SitePhpDurableObject } from '../site-do';
import { deriveSalts, wpConfigText } from './config';
import { DRIVER_DIGEST } from './driver-digest';
import { DIGEST_KEY, setOriginOptions } from './provision';

/** where the tree is mounted; the cartridge mounts under `/drupal` and the boot moves it */
export const WORDPRESS_ROOT = '/wordpress';

/** the asset prefixes the pack publishes under */
const PREFIX = { tree: 'wordpress/pf', driver: 'wordpress/driver.json' } as const;

/** the FS calls the boot makes beyond the cartridge's own */
interface RootFS {
	rename(from: string, to: string): void;
	rmdir(path: string): void;
	readdir(path: string): string[];
}

/** boots in this isolate, which an asset request count is divided by */
let boots = 0;

/**
 * What `/serve-stats` reports about WordPress boots: the asset requests this isolate has made
 * and what the last mount opened. A request is one boot, so the delta of the counts over the
 * delta of `boots` is the subrequests a request spends; the pack is fetched once per isolate.
 */
export function wordpressBootStats(mount: SiteMountInfo | undefined): {
	boots: number;
	assetRequests: ReturnType<typeof assetRequestCounts>;
	lastMount: {
		files: number;
		blobBytes: number;
		fetchMs: number;
		opened: number;
		openedBytes: number;
	};
} {
	const lazy = mount !== undefined && 'inflateStats' in mount ? mount : undefined;
	return {
		boots,
		assetRequests: assetRequestCounts(),
		lastMount: {
			files: lazy?.files ?? 0,
			blobBytes: lazy?.blobBytes ?? 0,
			// spans the asset fetches, so the clock advances across it on the platform
			fetchMs: lazy?.fetchMs ?? 0,
			opened: lazy?.inflateStats.inflated ?? 0,
			openedBytes: lazy?.inflateStats.inflatedBytes ?? 0
		}
	};
}

/**
 * Mounts the WordPress tree and the packed drop-in, then writes `wp-config.php`.
 *
 * The cartridge's lazy mount is Drupal-shaped in one way: it roots the tree at `/drupal` and makes
 * a Drupal files directory. Rather than fork it, the boot moves the root and removes the one empty
 * directory chain. There is no opcache layer and no packed container: WordPress has neither.
 */
export async function bootWordpressTree(
	site: SitePhpDurableObject,
	binary: SiteBinary
): Promise<void> {
	const FS = binary.FS as unknown as RootFS & typeof binary.FS;
	boots += 1;
	const mountEnv = packCachedEnv(site.env);
	site.mountInfo = await mountDrupalLazy(binary, mountEnv, {
		layers: [{ prefix: PREFIX.tree }]
	});
	FS.rename('/drupal', WORDPRESS_ROOT);
	for (const dir of [
		'sites/default/files/php/twig',
		'sites/default/files/php',
		'sites/default/files',
		'sites/default',
		'sites'
	]) {
		try {
			FS.rmdir(`${WORDPRESS_ROOT}/${dir}`);
		} catch {
			// a directory the mount did not make is not a boot failure
		}
	}

	const res = await mountEnv.ASSETS.fetch(new URL(`https://a.local/${PREFIX.driver}`));
	if (!res.ok) throw new Error(`${PREFIX.driver} not reachable: ${res.status}`);
	mountRecord(binary.FS, await res.json<Record<string, string>>(), WORDPRESS_ROOT);

	if (site.metaGet(DIGEST_KEY) !== DRIVER_DIGEST) site.metaSet(DIGEST_KEY, DRIVER_DIGEST);

	// the origin is pinned by the first request that reaches the object; see `canonicalOrigin()`
	const origin = site.canonicalOrigin();
	setOriginOptions(site, origin);
	binary.FS.writeFile(
		`${WORDPRESS_ROOT}/wp-config.php`,
		wpConfigText({ origin, salts: deriveSalts(ensureHashSalt(site.secretStore())) })
	);
}
