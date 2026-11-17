import {
	mkdirp,
	mountDriver,
	mountDrupalLazy,
	mountDrupalStreaming
} from '@drupflare/cartridge/fs';
import { packCachedEnv } from '../do/lazy-mount';
import { migrateEngine } from '../do/levers';
import { mountInstalledModules } from '../do/packages';
import type { SiteBinary } from '../do/types';
import { DRIVER_DIGEST } from '../ops/driver-digest';
import { OPCACHE_PACK } from '../ops/opcache-pack';
import { SHIPPED_LOCK_VERSIONS } from '../ops/shipped-lock';
import {
	OPCACHE_PACK_ROOT,
	opcacheMode,
	opcacheSourceKey,
	opcachePackState as packedOpcacheState
} from '../runtime/opcache';
import type { SitePhpDurableObject } from '../site-do';
import { writeDrupalSettings } from './settings';

/**
 * Mounts the Drupal tree, the packed driver and the installed modules, then points `settings.php`
 * at the driver. Everything here names a Drupal path or a Drupal pack.
 */
export async function bootDrupalTree(
	site: SitePhpDurableObject,
	binary: SiteBinary
): Promise<void> {
	// SITE_DB_PREFIX swaps only the database (the default pack has no node bundles)
	// LAZY_MOUNT swaps the mount strategy: streaming inflates 39 MB up front (3,066 ms of a
	// 3,754 ms cold start), lazy inflates on first open
	const lazyOptions = {
		dbPrefix: site.env?.SITE_DB_PREFIX || undefined,
		// same condition as the streaming path below
		database: migrateEngine(undefined, site.env) === 'php'
	};
	const opcachePackState = packedOpcacheState(
		OPCACHE_PACK,
		opcacheMode(site.env?.OPCACHE_MODE),
		site.env?.LAZY_MOUNT === '1',
		opcacheSourceKey(DRIVER_DIGEST, SHIPPED_LOCK_VERSIONS)
	);
	const packedOpcache = opcachePackState === 'usable';
	const mountEnv = packCachedEnv(site.env);
	site.mountInfo =
		site.env?.LAZY_MOUNT === '1'
			? packedOpcache
				? await mountDrupalLazy(binary, mountEnv, {
						...lazyOptions,
						layers: [{ prefix: 'drupal-pf' }, { prefix: 'drupal-opc' }]
					}).catch(() => mountDrupalLazy(binary, mountEnv, lazyOptions))
				: await mountDrupalLazy(binary, mountEnv, lazyOptions)
			: await mountDrupalStreaming(binary, site.env, {
					dbPrefix: site.env?.SITE_DB_PREFIX || undefined,
					// only the PHP migration engine opens the packed .sqlite (the JS engine
					// would spend 6.47 MB and a subrequest)
					database: migrateEngine(undefined, site.env) === 'php'
				});
	site.mountInfo.driver = await mountDriver(binary, site.env);
	// opcache looks in /tmp/<system id>; the layer sits beside the tree, so a link joins them
	const opcLayer =
		'layers' in site.mountInfo && site.mountInfo.layers.some((l) => l.name === 'drupal-opc');
	if (packedOpcache && opcLayer && OPCACHE_PACK) {
		try {
			(binary.FS as unknown as { symlink(target: string, path: string): void }).symlink(
				`${OPCACHE_PACK_ROOT}/${OPCACHE_PACK.systemId}`,
				`/tmp/${OPCACHE_PACK.systemId}`
			);
			site.mountInfo.opcachePack = OPCACHE_PACK.systemId;
		} catch {
			// an unlinked cache is a miss on every script, which is the `off` arm's cost
		}
	} else if (opcachePackState === 'stale') {
		site.mountInfo.opcachePack = 'stale';
	}
	// at mount time, not settings.php: a restored heap never boots a kernel, so the override's
	// `@mkdir()` would not run
	try {
		mkdirp(binary.FS, '/drupal/sites/default/files/config/sync');
	} catch {
		// a read-only or already-present node is not a boot failure
	}
	// after the packed driver, so an installed module overrides a packed file (the only place
	// `cfw_module_file` reaches PHP)
	site.installedModuleFiles = mountInstalledModules(site, binary);

	writeDrupalSettings(site, binary);
}
