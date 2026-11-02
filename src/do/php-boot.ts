import {
	mkdirp,
	mountDriver,
	mountDrupalLazy,
	mountDrupalStreaming
} from '@drupflare/cartridge/fs';
import { withMask } from '@drupflare/cartridge/mask';
import { PHP_CODEC } from '@drupflare/durabledb/codec';
import { PhpBase, type PhpBaseModuleFactory, type PhpRuntimeArgs } from 'php-wasm/PhpBase';
import { backendNeedsPark, selectBackend, type BackendEnv } from '../db/backend';
import { HeapChunkDigestError } from '../db/heap-store';
import { DISABLED, STANDIN_FIX } from '../drupal/standin-fix';
import { SHIPPED_CAPABILITIES } from '../ops/catalog';
import { recordEncounter } from '../ops/cold-encounter';
import { emptyCrossings, wrapCrossings } from '../ops/crossings';
import { DRIVER_DIGEST } from '../ops/driver-digest';
import { OPCACHE_PACK } from '../ops/opcache-pack';
import { parkEnabled } from '../ops/park';
import { enforceReadOnly } from '../ops/replica';
import { SHIPPED_LOCK_VERSIONS } from '../ops/shipped-lock';
import { ensureHashSalt, hashSaltAssignment } from '../ops/site-secrets';
import { writeForwardEnabled } from '../ops/write-forwarding';
import {
	DEFAULT_OPCACHE_MODE,
	OPCACHE_PACK_ROOT,
	opcacheIni,
	opcacheMode,
	opcacheSourceKey,
	opcachePackState as packedOpcacheState,
	type OpcacheMode
} from '../runtime/opcache';
import type { PhpInstance, SitePhpDurableObject } from '../site-do';
import { ARGON2_FIX, installArgon2 } from '../site/shims/argon2-fix';
import { BROTLI_FIX, installBrotli } from '../site/shims/brotli-fix';
import { CURL_FIX } from '../site/shims/curl-fix';
import { EXTENSIONS_FIX } from '../site/shims/extensions-fix';
import { ICONV_FIX } from '../site/shims/iconv-fix';
import { MB_FIX } from '../site/shims/mb-fix';
import { OPENSSL_FIX, installSign } from '../site/shims/openssl-fix';
import { SODIUM_FIX } from '../site/shims/sodium-fix';
import { installSodium } from '../site/shims/sodium-lib';
import { XMLWRITER_FIX } from '../site/shims/xmlwriter-fix';
import { ZLIB_FIX, installZlib } from '../site/shims/zlib-fix';
import { ZSTD_FIX, installZstd } from '../site/shims/zstd-fix';
import { errorMessage } from '../util/errors';
import { HeapRestoreIncomplete, heapRestoreChunkBudget, heapSnapshotEnabled } from './alarm';
import {
	bootImageBakeEnabled,
	planBootImage,
	planPages,
	restoreBootImage,
	type BootImagePlan
} from './boot-image';
import { forwardTo } from './helpers';
import { INTERPRETER_MEMORY, isolateResidency, shimGlobals, takeSpareMemory } from './isolate';
import { packCachedEnv } from './lazy-mount';
import { migrateEngine } from './levers';
import { mountInstalledModules } from './packages';
import { SERVICES_YAML, settingsOverride } from './settings';
import type { PhpOutputEvent, SiteBinary } from './types';

/** the binary seam; site-do.ts imports it because wrangler aliases that exact specifier */
export type PhpSeam = { factory: unknown; module: WebAssembly.Module };

/**
 * The interpreter, built the way prof.js builds it (static-free-v1, so recorded per-query numbers
 * stay comparable).
 */
export class PhpStatic extends PhpBase {
	/** the raw entry point php-wasm's published types omit; `run()` is a wrapper over it */
	declare _run: (code: string) => Promise<unknown>;

	constructor(
		seam: PhpSeam,
		args: PhpRuntimeArgs = {},
		diag: string[] = [],
		mode: OpcacheMode = DEFAULT_OPCACHE_MODE,
		memory?: WebAssembly.Memory
	) {
		const t0 = Date.now();
		const note = (m: string) => diag.push(`+${Date.now() - t0}ms ${m}`);
		// php-wasm types the loader's `default` as a constructor but real builds export a factory
		// (upstream mismatch)
		super(
			Promise.resolve({ default: seam.factory }) as unknown as Promise<PhpBaseModuleFactory>,
			{
				...args,
				ini: [
					// the opcache seam; `OPCACHE_MODE` selects the arm
					...opcacheIni(mode),
					// not a guard: `USE_ZEND_ALLOC=0` turns the enforcing allocator off
					// (an 8M cap held 38 MB)
					'memory_limit=96M',
					// removed so `STANDIN_FIX` can declare degraded versions under the same names
					`disable_functions=${DISABLED.join(',')}`,
					// PHP_INI_PERDIR, so only boot can set it; the upload parser is userland here
					'session.upload_progress.enabled=0',
					// no stack arguments in fatal error output
					'fatal_error_backtraces=0',
					// uploads are parsed in userland, so PHP's own handling stays off
					'file_uploads=0',
					'expose_php=0',
					'allow_url_include=0'
				].join('\n'),
				printErr: (t: string) => note(`err: ${t}`),
				onAbort: (what: unknown) => note(`abort: ${what}`),
				instantiateWasm(
					imports: WebAssembly.Imports,
					receiveInstance: (
						instance: WebAssembly.Instance,
						module: WebAssembly.Module
					) => void
				) {
					if (memory) (imports.env as Record<string, unknown>).memory = memory;
					WebAssembly.instantiate(seam.module, imports)
						.then((instance) => {
							receiveInstance(instance, seam.module);
							note('instantiated');
						})
						.catch((e: any) => note(`FAILED: ${e?.message ?? e}`));
					return {};
				}
			}
		);
	}
}

/**
 * A memory for a boot with nothing to reuse, or undefined when the loaded binary defines its own.
 */
function newInterpreterMemory(seam: PhpSeam, pages = 0): WebAssembly.Memory | undefined {
	let imports: WebAssembly.ModuleImportDescriptor[] = [];
	try {
		imports = WebAssembly.Module.imports(seam.module);
	} catch {
		// a stub binary in a spec has no import table; it defines nothing and imports nothing
	}
	return imports.some((i) => i.kind === 'memory')
		? new WebAssembly.Memory({
				...INTERPRETER_MEMORY,
				initial: Math.max(INTERPRETER_MEMORY.initial, pages)
			})
		: undefined;
}

/** the cold half of `ensurePhp`; only it and its own reboot call this */
export async function bootPhp(
	site: SitePhpDurableObject,
	opts: { skipRestore?: boolean },
	seam: PhpSeam
): Promise<PhpInstance> {
	site.encounters = recordEncounter(site.encounters, 'cold');
	site.coldsSinceFlush = (site.coldsSinceFlush ?? 0) + 1;
	// the heap a drop left behind, if any, so this boot never holds a second one beside it
	const spare = takeSpareMemory();
	if (spare) {
		site.heapsReused = (site.heapsReused ?? 0) + 1;
		site.lastReuse = { at: site.nowMs(), bytes: spare.buffer.byteLength };
	}
	let plan: BootImagePlan = opts.skipRestore ? { reason: 'skipped' } : await planBootImage(site);
	const memory = spare ?? newInterpreterMemory(seam, planPages(plan));
	if (plan.index && !memory) plan = { reason: 'the binary defines its own memory' };
	// the image's heap is larger than the boot memory once the bake's render has grown it
	const missing = memory ? planPages(plan) - memory.buffer.byteLength / 65_536 : 0;
	if (memory && missing > 0) memory.grow(missing);
	// an uncollected interpreter still counts toward the isolate's 128 MiB while this one grows
	const resident = isolateResidency();
	site.traceMemory('boot');
	if (resident.interpreters > 0) {
		site.bootBesideResident = { at: site.nowMs(), ...resident };
		console.warn(JSON.stringify({ cfw: 'boot-beside-resident', ...resident }));
	}

	const t0 = Date.now();
	// every closure installed below goes through `self`, so an adopting instance can take them
	// over
	const owner = { current: site as SitePhpDurableObject };
	site.phpOwner = owner;
	const self = forwardTo(owner);
	const php = new PhpStatic(seam, {}, site.bootDiag, opcacheMode(site.env?.OPCACHE_MODE), memory);
	// braced on purpose: a brace-less arrow returns `push`'s length and workerd warns on every
	// event
	php.addEventListener('output', (e) => {
		self.out.push(...([] as string[]).concat((e as PhpOutputEvent).detail ?? []));
	});
	php.addEventListener('error', (e) => {
		self.out.push(...([] as string[]).concat((e as PhpOutputEvent).detail ?? []));
	});
	// the one cast: php-wasm resolves site as a loosely-typed Module, and SiteBinary names
	// both the FS surface the mounts drive and the cfw* members installed just below
	const binary = (await php.binary) as unknown as SiteBinary;
	// what a drop hands to the next boot; see `keepSpareMemory()`
	if (memory) (binary as unknown as { wasmMemory: WebAssembly.Memory }).wasmMemory = memory;

	// the bridge the driver reaches through vrzno_env(); inherited from
	// SiteDurableObject so exec/txn semantics are the verified ones
	site.installBridge.call(self, binary as unknown as Record<string, unknown>);
	// whether this binary can suspend, read by drupflare's service provider; `FetchHandler`
	// needs Asyncify or JSPI (shipping has neither), so `ParkFetchHandler` answers HTTP instead
	binary.cfwCanSuspend =
		typeof shimGlobals.Asyncify === 'object' && shimGlobals.Asyncify.__cfwStub !== true;

	binary.cfwStats = () =>
		JSON.stringify({
			queryCount: self.queryCount,
			databaseSize: Number(self.sql.databaseSize),
			// what a progressive batch reads between operations, since memory_get_usage() is 0
			oversized: self.oversized()
		});
	// what the Worker knows (pool, meters, fill queue), handed to Drupal so it can be displayed
	binary.cfwServeStats = () => JSON.stringify(self.serveStatsSync());
	site.installCapabilities.call(self, binary);
	// ext-zlib over fflate, masked (a sync deflate is a long JS frame); installed even where
	// zlib exists (the PHP half then defines nothing)
	installZlib(binary as unknown as Record<string, unknown>, withMask);
	installBrotli(binary as unknown as Record<string, unknown>, withMask);
	installZstd(binary as unknown as Record<string, unknown>, withMask);
	// RSA/ECDSA over node:crypto, which is synchronous in workerd, so an ordinary masked bridge
	installSign(binary as unknown as Record<string, unknown>, withMask);
	installArgon2(binary as unknown as Record<string, unknown>, withMask);
	// the whole ext-sodium API over noble and blakejs; no build has the extension
	installSodium(binary as unknown as Record<string, unknown>, withMask);
	// not probed here: the park probe runs PHP, which cannot execute yet at this point of the
	// boot (see {@link parkState})
	site.parkInstall = undefined;
	// close old sockets here, not in `dropInterpreter()` (most drops assign `php = undefined`
	// directly); their tokens died with the old `$GLOBALS`
	void site.parkSockets?.closeAll();
	site.parkSockets = undefined;
	// read by `ParkFetchHandler::available()`; gated on the traps' switch, else a
	// `cfwpark+fetch://` target reaches the real `stream_socket_client` (reasoned, unmeasured)
	(binary as unknown as Record<string, unknown>)['cfwParkFetch'] =
		SHIPPED_CAPABILITIES.blockingOutbound && parkEnabled(site.env);
	// same flag for SQL plus a reachable backend: a yield the host will not answer is a hang
	// (no local database to fall back to)
	(binary as unknown as Record<string, unknown>)['cfwParkImage'] =
		SHIPPED_CAPABILITIES.blockingOutbound && parkEnabled(site.env);
	(binary as unknown as Record<string, unknown>)['cfwSqlPark'] =
		SHIPPED_CAPABILITIES.blockingOutbound &&
		parkEnabled(site.env) &&
		backendNeedsPark(selectBackend(site.env as unknown as BackendEnv));
	// last, after every installer (an earlier wrapper is overwritten and the tally reads 0)
	site.crossings = emptyCrossings();
	site.crossings.bytes = { in: 0, out: 0, maxIn: 0, maxOut: 0, maxName: '' };
	site.crossingNames = wrapCrossings(
		binary as unknown as Record<string, unknown>,
		site.crossings
	);
	// outside the tally (a refused call is not a crossing), and last so an installer cannot
	// overwrite the guard
	site.replicaGuard = site.isReplica()
		? enforceReadOnly(
				binary as unknown as Record<string, unknown>,
				(refusal) => {
					self.replicaRefusals.push(refusal);
					self.replicaRefusalsTotal += 1;
					if (self.replicaRefusals.length > 20) self.replicaRefusals.shift();
				},
				// a pool lane forwards its writes; a var-configured replica has no primary and
				// keeps refusing
				site.isPoolLane() && writeForwardEnabled(site.env)
					? (statements, payload) => self.collectForward(statements, payload)
					: undefined
			)
		: undefined;
	// before any PHP runs: a handle minted before the pin cannot be pinned retroactively
	site.pinHandles(binary);

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

	// point the site at this driver, and at a salt only this site has
	const settingsPath = '/drupal/sites/default/settings.php';
	const existing = new TextDecoder().decode(binary.FS.readFile(settingsPath));
	if (!existing.includes('cfw_do_sqlite')) {
		// the pack ships no hash_salt, so this append is the only assignment (a failed override
		// throws rather than sharing one salt)
		const salt = hashSaltAssignment(ensureHashSalt(site.secretStore()));
		// the pinned origin is interpolated here: settings.php runs once per boot and the pin
		// belongs to the site
		const override = settingsOverride({
			origin: JSON.stringify(site.canonicalOrigin()),
			...site.bootSettings()
		});
		binary.FS.writeFile(settingsPath, existing + override + salt);
	}
	// the path settings.php already registered but that never existed; see SERVICES_YAML
	binary.FS.writeFile('/drupal/sites/default/services.yml', SERVICES_YAML);

	site.php = { php, binary, out: site.out };
	site.phpBootedAt = site.nowMs();
	site.bootMs = Date.now() - t0;
	site.bootLinear = site.heapNow();
	site.rebuildBoot = site.containerMissing();

	// the published boot image goes first: it is the same restore from another source, shared by
	// every site whose context equals the bake's
	site.bootImage = { used: false, reason: plan.reason };
	if (bootImageBakeEnabled(site.env) && !opts.skipRestore)
		site.bootImageBaseline = site.heapBytes(binary)?.slice();
	if (plan.index && plan.variant) {
		const restored = await restoreBootImage(
			site,
			binary,
			plan.index,
			plan.variant,
			plan.reset === true
		);
		site.bootImage = { used: restored.restored === true, reason: plan.reason, ...restored };
		if (restored.dirty === true) {
			// bytes landed: the heap has the right length and wrong contents, so boot again plain
			const refused = site.bootImage;
			site.php = undefined;
			const fresh = await bootPhp(site, { skipRestore: true }, seam);
			site.bootImage = { ...refused, used: false, rebooted: true };
			return fresh;
		}
	}

	// restore a stored heap matching this pack after the mount, bridge and capabilities
	// (the heap holds vrzno handles by index into what they populate)
	if (site.bootImage.used !== true && heapSnapshotEnabled(site.env) && !opts.skipRestore) {
		try {
			site.heapRestore = await site.tryRestoreHeap(binary, {
				maxChunks: heapRestoreChunkBudget(site.env)
			});
		} catch (e) {
			// a refusal is a boot, not an outage: fall through to the normal path
			site.heapRestoreCursor = undefined;
			// unless bytes already landed: a refusal on chunk 0 leaves the pack's heap,
			// one on chunk N has applied N chunks (right length, wrong bytes)
			const dirty = e instanceof HeapChunkDigestError && e.bytesWritten > 0;
			site.heapRestore = {
				restored: false,
				reason: errorMessage(e),
				...(dirty ? { discardedHeap: true, dirtyBytes: e.bytesWritten } : {})
			};
			if (dirty) {
				// drop the poisoned instance and boot from the pack (`skipRestore` stops a
				// retry refusing the same chunk)
				site.php = undefined;
				// directly: through `ensurePhp()` this would wait on the boot it is part of
				const fresh = await bootPhp(site, { skipRestore: true }, seam);
				site.heapRestore.rebooted = true;
				return fresh;
			}
		}
		// the restore did not finish: the binary and mount survive to the next firing, and
		// the cursor keeps the object unservable meanwhile
		if (site.heapRestoreCursor) {
			await site.setAlarmAt(site.nowMs() + 1);
			throw new HeapRestoreIncomplete(site.heapRestoreCursor);
		}
	}

	// pw_encode()/pw_decode() must precede the driver's client; the mb_* wrappers must
	// precede Symfony's polyfill bootstrap (its function_exists() guards would win)
	// first, because every fragment below asks extension_loaded() and the built-in is disabled
	await site.run(`<?php ${EXTENSIONS_FIX}`);
	await site.run(`<?php ${PHP_CODEC}`);
	await site.run(`<?php ${MB_FIX}`);
	// same window as MB_FIX: polyfill-iconv's bootstrap must find the name taken (its
	// iconv_strrpos() is wrong at index 0)
	await site.run(`<?php ${ICONV_FIX}`);
	// gz* must exist before AssetDumper runs in a render; inert where the extension exists
	await site.run(`<?php ${ZLIB_FIX}`);
	// ext-brotli and ext-zstd over node:zlib; declared only where the extension is absent
	await site.run(`<?php ${BROTLI_FIX}`);
	await site.run(`<?php ${ZSTD_FIX}`);
	// curl_* must exist before an SDK constructs its own transport (the shim class resolves
	// on first call; no autoloader yet)
	await site.run(`<?php ${CURL_FIX}`);
	// openssl_sign/openssl_verify for firebase/php-jwt and the Google auth client; inert
	// with the real extension
	await site.run(`<?php ${OPENSSL_FIX}`);
	await site.run(`<?php ${ARGON2_FIX}`);
	// the sodium_* functions, needed before a content-addressed store's first write
	await site.run(`<?php ${SODIUM_FIX}`);
	// XMLWriter must exist before a module class extends it (compile time, hence a class and
	// not a shim set)
	await site.run(`<?php ${XMLWRITER_FIX}`);
	// ZipArchive, finfo, Transliterator and exif, plus the degraded sleep, exec and gd names
	await site.run(`<?php ${STANDIN_FIX}`);
	return site.php;
}
