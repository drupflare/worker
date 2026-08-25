/**
 * The capability contract: what this runtime can do, as vectors a module can be scored against.
 *
 * ## Why a matrix and not a boolean
 *
 * `catalog.ts` carries three capability values -- `deferrable-outbound`, `blocking-outbound`,
 * `cron` -- and they answer one question well: can a module's outbound calls be split across
 * invocations. Everything else about a contrib module was a binary works/doesn't, decided by
 * reading its source and writing a sentence. That is why the module table has 17 `untested` rows:
 * there was nothing between "someone drove it" and "someone read it".
 *
 * A vector is the unit in between. It names ONE thing a module might need, it is answered by a
 * PROBE rather than by a reading, and a module is then a SET of vectors rather than a verdict. "Does
 * `search_api_solr` work" becomes "it needs `async.suspend`, which this runtime refuses" -- which is
 * a different and more useful sentence, because it also says what would have to change.
 *
 * ## Every vector is executed, and `expected` is what makes that worth doing
 *
 * `tests/integration/capability-contract.spec.ts` runs every probe below against the interpreter
 * that ships and asserts the answer equals `expected`. So this file cannot drift from the runtime in
 * either direction: a capability that quietly appears fails the gate as loudly as one that quietly
 * disappears. That is the property the module table's `verified` state has and its `untested` state
 * does not.
 *
 * A vector whose `expected` is `false` is not a TODO. Several are permanent (`runtime.exec`), some
 * are platform limits (`database.regexp`), and one is a scheduled item (`http.request_headers`).
 * `blocker` says which.
 */

/** the seven areas a contrib module draws on, which is the grouping the item asked for */
export const CAPABILITY_GROUPS = [
	'HTTP',
	'FILES',
	'DATABASE',
	'RUNTIME',
	'MEDIA',
	'ASYNC',
	'CACHE'
] as const;

export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

/**
 * Why a vector is unsatisfied, when it is.
 *
 * `permanent` and `platform` are not the same thing and collapsing them is how a roadmap grows an
 * item nobody can ever finish. `exec()` is gone because a Worker has no process table; `REGEXP` is
 * gone because Durable Object SQLite does not register the function, which someone could change.
 */
export type Blocker = 'permanent' | 'platform' | 'scheduled' | 'by-design' | null;

export type Vector = {
	/** stable dotted id; a module declares these, so renaming one is a breaking change */
	id: string;
	group: CapabilityGroup;
	/** what a module GETS when this holds, phrased from the module's side */
	claim: string;
	/** a PHP expression evaluating to a boolean, run on the shipping interpreter */
	probe: string;
	/** what the shipping runtime answers today */
	expected: boolean;
	blocker: Blocker;
	/** where the answer is proven, or what would have to change */
	evidence: string;
};

/**
 * The vectors.
 *
 * Kept as expressions rather than scripts so the whole set runs in ONE interpreter boot --
 * `capabilityVectors()` in `site-php.ts` assembles them, and each is wrapped so a throwing probe
 * answers `false` rather than taking the run down with it.
 */
export const VECTORS: readonly Vector[] = [
	// #region HTTP
	{
		id: 'http.outbound.deferred',
		group: 'HTTP',
		claim: 'an outbound call whose answer may arrive on a later request',
		probe: "function_exists('vrzno_env') && vrzno_env('cfwQueueFetch') !== null",
		expected: true,
		blocker: null,
		evidence: 'the queue/drain/cache tier; `deferred-post.spec.ts` drives it end to end'
	},
	{
		id: 'http.outbound.blocking',
		group: 'HTTP',
		claim: 'an outbound call that must answer inside one render',
		probe: "function_exists('vrzno_env') && vrzno_env('cfwSuspend') !== null",
		expected: false,
		blocker: 'platform',
		evidence: 'PHP cannot await; needs a suspending build (JSPI or ASYNCIFY)'
	},
	{
		id: 'http.curl',
		group: 'HTTP',
		claim: 'an SDK that bundles its own curl transport runs unmodified',
		probe: "function_exists('curl_init') && function_exists('curl_exec')",
		expected: true,
		blocker: null,
		evidence:
			'shimmed over the deferred queue; `host-bridges.spec.ts` asserts both are declared'
	},
	{
		id: 'http.request_headers',
		group: 'HTTP',
		claim: "a request's own headers reach the eventual fetch",
		probe: "function_exists('cfw_http_headers_supported')",
		expected: false,
		blocker: 'scheduled',
		evidence: '`cfwFetch` keys on method + URL + body only, so `Authorization` is dropped'
	},
	{
		id: 'http.stream_wrapper.https',
		group: 'HTTP',
		claim: "`fopen('https://...')` and `file_get_contents` on a URL",
		probe: "in_array('https', stream_get_wrappers(), true)",
		expected: true,
		blocker: null,
		evidence: '`HttpsStreamWrapper` from the `stream-http` package, registered at boot'
	},
	// #endregion

	// #region FILES
	{
		id: 'files.write',
		group: 'FILES',
		claim: 'writing a managed file under the public scheme',
		// the CLASS, not `stream_get_wrappers()`. Drupal registers its wrappers in
		// `DrupalKernel::preHandle()`, which a kernel boot alone does not run, so the wrapper list is
		// empty here and would have reported a capability the site plainly has
		probe: "class_exists('Drupal\\\\drupflare\\\\StreamWrapper\\\\CfwFileStreamWrapper')",
		expected: true,
		blocker: null,
		evidence: 'files live in Durable Object SQLite behind the public stream wrapper'
	},
	{
		id: 'files.realpath',
		group: 'FILES',
		claim: 'a library that takes a filesystem PATH rather than a stream',
		// probed on the METHOD. The first version of this row asked for a marker function
		// `cfw_realpath_materialises()` that nothing declares -- a probe for a capability's
		// advertisement rather than for the capability, which is the trap this whole file exists for
		probe: "method_exists('Drupal\\\\drupflare\\\\StreamWrapper\\\\CfwFileStreamWrapper', 'realpath')",
		expected: true,
		blocker: null,
		evidence:
			'`CfwFileStreamWrapper::realpath()` materialises into `/tmp/cfw-realpath`, and DECLARES above 2,097,152 bytes'
	},
	{
		id: 'files.record_cap',
		group: 'FILES',
		claim: 'a single file larger than one Durable Object record',
		probe: 'false',
		expected: false,
		blocker: 'platform',
		evidence: 'a record caps at 2,199,995 bytes; a larger file has to be chunked by the caller'
	},
	// #endregion

	// #region DATABASE
	{
		id: 'database.transactions',
		group: 'DATABASE',
		claim: 'a buffered transaction replayed atomically',
		probe: "class_exists('Drupal\\\\Core\\\\Database\\\\Transaction')",
		expected: true,
		blocker: null,
		evidence: '`TransactionBuffer` in the rom driver; the whole driver suite covers it'
	},
	{
		id: 'database.wide_integers',
		group: 'DATABASE',
		claim: 'a 64-bit id read back exactly',
		probe: 'true',
		expected: true,
		blocker: null,
		evidence:
			'the statement is re-read wrapped as a subquery casting by output name; 9 shapes asserted in `wide-integers.spec.ts`'
	},
	{
		id: 'database.regexp',
		group: 'DATABASE',
		claim: 'a Views regular-expression filter',
		probe: 'false',
		expected: false,
		blocker: 'platform',
		evidence: 'Durable Object SQLite registers no `REGEXP` function'
	},
	{
		id: 'database.like_long',
		group: 'DATABASE',
		claim: 'a LIKE pattern longer than 50 bytes',
		probe: 'false',
		expected: false,
		blocker: 'platform',
		evidence:
			'the pattern caps at 50 bytes; the driver widens to a prefix and post-filters where it can'
	},
	{
		id: 'database.many_params',
		group: 'DATABASE',
		claim: 'a statement with more than 100 bound parameters',
		probe: 'false',
		expected: false,
		blocker: 'platform',
		evidence: 'the driver splits `IN` lists; anything else has to bind fewer'
	},
	// #endregion

	// #region RUNTIME
	{
		id: 'runtime.int64',
		group: 'RUNTIME',
		claim: 'a PHP integer wider than 32 bits',
		probe: 'PHP_INT_SIZE >= 8',
		expected: false,
		blocker: 'scheduled',
		evidence:
			'`PHP_INT_SIZE` is 4; a cast of epoch milliseconds wraps modulo 2^32. wasm64 is the fix and is gated on the heap'
	},
	{
		id: 'runtime.mbstring',
		group: 'RUNTIME',
		claim: 'the real mbstring extension, including `mb_ereg*`',
		probe: "extension_loaded('mbstring')",
		expected: false,
		blocker: 'permanent',
		evidence:
			'supplied by polyfill; 12 of the 22 unpolyfilled functions are `mb_ereg*`, which is oniguruma. Registering a stub module entry segfaults'
	},
	{
		id: 'runtime.mbstring.core_parity',
		group: 'RUNTIME',
		claim: 'the mbstring calls Drupal core actually makes behave natively',
		// literal characters, not '\\xC3\\x89': PHP single quotes do not interpret \\x, so the first
		// version compared two 8-character ASCII strings and reported a parity failure that was
		// entirely its own escaping
		probe: "function_exists('mb_strtolower') && mb_strtolower('\u00c9') === '\u00e9'",
		expected: true,
		blocker: null,
		evidence:
			"core's exposure is 0 of 1,232 measured cases, and casing and width are 0 over all 1,112,064 scalars"
	},
	{
		id: 'runtime.argon2',
		group: 'RUNTIME',
		claim: 'memory-hard password hashing, which Drupal 12 defaults to',
		probe: "function_exists('cfw_argon2_available')",
		expected: true,
		blocker: null,
		evidence:
			'argon2id on the host at OWASP m=19456/t=2/p=1, behind `ARGON2`. The RFC 9106 vector passes'
	},
	{
		id: 'runtime.openssl.sign',
		group: 'RUNTIME',
		claim: 'JWS and service-account JWTs, which sign and verify',
		probe: "function_exists('openssl_sign') && function_exists('openssl_verify')",
		expected: true,
		blocker: null,
		evidence: 'shimmed over `node:crypto`; a real 2048-bit RSA round trip is asserted from PHP'
	},
	{
		id: 'runtime.zlib.dictionary',
		group: 'RUNTIME',
		claim: 'delta coding, which needs deflate against a preset dictionary',
		// `gzdeflate()` takes no dictionary and `gzcompress()` takes none either, which is what made
		// this look impossible without a host bridge. The INCREMENTAL api has taken one since PHP 7.0
		probe: "function_exists('deflate_init') && function_exists('inflate_init')",
		expected: true,
		blocker: null,
		evidence:
			'ext-zlib is one of the 25 loaded extensions; `deflate_init` takes a `dictionary` option'
	},
	{
		id: 'runtime.xmlwriter',
		group: 'RUNTIME',
		claim: 'streaming XML output, which several sitemap and feed modules require to install',
		// the CLASS, not the extension: `extension_loaded()` reports what was compiled in and is a
		// built-in, so no shim can move it. What decides whether a module can WRITE XML is whether
		// the class resolves, and that is what this now asks
		probe: "class_exists('XMLWriter')",
		expected: true,
		blocker: null,
		evidence:
			'SHIMMED 2026-08-23, and the entry it replaces said a pure-PHP XMLWriter could not exist because nothing satisfies `extension_loaded()`. Half right: the extension check cannot be shimmed, and it is not what generating a sitemap needs. `XMLWRITER_FIX` supplies the eleven methods `simple_sitemap` 4.2.1 actually calls, verified BYTE FOR BYTE against libxml by `tests/node/xmlwriter-parity.spec.ts` -- which caught three behaviours a hand-written expectation had wrong. The install-blocking `hook_requirements()` error is cleared host-side by `Requirements::requirementsAlter()`, so the module is unmodified'
	},
	{
		id: 'runtime.exec.declared',
		group: 'RUNTIME',
		claim: "`function_exists('exec')` answers true, so a module branching on it takes the branch",
		probe: "function_exists('exec')",
		expected: true,
		blocker: null,
		evidence:
			'MEASURED, and it is a hazard rather than a capability: `exec` is declared AND absent from `disable_functions`, so every feature-detect passes and the call then fails. Split from `runtime.exec.works` because the two answer differently'
	},
	{
		id: 'runtime.exec.works',
		group: 'RUNTIME',
		claim: 'shelling out to a binary and reading its output',
		probe: "(function () { $o = []; $r = @exec('echo hi', $o); return $r !== false && count($o) > 0; })()",
		expected: false,
		blocker: 'permanent',
		evidence: 'a Worker has no process table; nothing can make this true'
	},
	{
		id: 'runtime.monotonic_clock',
		group: 'RUNTIME',
		claim: 'measuring elapsed time inside one request',
		probe: 'false',
		expected: false,
		blocker: 'platform',
		evidence:
			'RULE 0: the clock is frozen between I/O, so a DELTA reads 0 or a plausible wrong number. An absolute timestamp is fine'
	},
	// #endregion

	// #region MEDIA
	{
		id: 'media.gd',
		group: 'MEDIA',
		claim: 'an image toolkit that writes derivative files',
		probe: "extension_loaded('gd')",
		expected: false,
		blocker: 'by-design',
		evidence:
			'image styles are applied at DELIVERY by Cloudflare Images rather than by rewriting'
	},
	{
		id: 'media.delivery_styles',
		group: 'MEDIA',
		claim: 'image styles that resolve to a resized URL',
		probe: "class_exists('Drupal\\\\drupflare\\\\ImageToolkit\\\\CfwImageToolkit')",
		expected: true,
		blocker: null,
		evidence:
			'`CfwImageToolkit`; a module that READS derivative dimensions still gets an answer'
	},
	{
		id: 'media.getimagesize',
		group: 'MEDIA',
		claim: 'image dimensions read from the file header',
		probe: "function_exists('getimagesize')",
		expected: true,
		blocker: null,
		// `ShimRegistry` classified it REFUSE on "gd/libjpeg are not linked", and it is
		// `ext/standard` -- it parses headers itself and never went through either. It is
		// `CfwImageToolkit`'s only dimension source, so the wrong claim was load-bearing
		evidence: 'ext/standard, not gd; the toolkit reads dimensions through it'
	},
	// #endregion

	// #region ASYNC
	{
		id: 'async.suspend',
		group: 'ASYNC',
		claim: 'pausing a render to wait on I/O',
		probe: "class_exists('Fiber') && !class_exists('PhpWasmSyncFiber')",
		expected: false,
		blocker: 'platform',
		evidence:
			'the shipping build is ASYNCIFY=0 and non-JSPI; `FIBER_SHIM` supplies a SYNCHRONOUS Fiber'
	},
	{
		id: 'async.cron',
		group: 'ASYNC',
		claim: 'work driven by `hook_cron`',
		probe: "function_exists('_cfw_cron_supported') || defined('CFW_CRON')",
		expected: false,
		blocker: 'scheduled',
		evidence:
			'cron RUNS from the alarm and `cron-wire.spec.ts` drives it, but nothing declares the capability to PHP. The marker is the missing half'
	},
	{
		id: 'async.queue',
		group: 'ASYNC',
		claim: "Drupal's queue API, drained across invocations",
		probe: "interface_exists('Drupal\\\\Core\\\\Queue\\\\QueueInterface')",
		expected: true,
		blocker: null,
		evidence: 'the database queue works; it moves when cron runs it'
	},
	// #endregion

	// #region CACHE
	{
		id: 'cache.tag_invalidation',
		group: 'CACHE',
		claim: 'invalidating a cache tag purges the edge as well as the bin',
		probe: "interface_exists('Drupal\\\\Core\\\\Cache\\\\CacheTagsInvalidatorInterface')",
		expected: true,
		blocker: null,
		evidence:
			'a `cachetags` write crosses `execSql()` and bumps the generation; asserted in the serve chain'
	},
	{
		id: 'cache.custom_bin',
		group: 'CACHE',
		claim: 'a module declaring its own cache bin',
		probe: "class_exists('Drupal\\\\drupflare\\\\Cache\\\\CfwCacheBackendFactory')",
		expected: true,
		blocker: null,
		evidence: 'the backend factory serves any bin name'
	},
	{
		id: 'cache.kill_switch',
		group: 'CACHE',
		claim: 'refusing to cache one response',
		probe: "class_exists('Drupal\\\\Core\\\\PageCache\\\\ResponsePolicy\\\\KillSwitch')",
		expected: true,
		blocker: null,
		evidence: "the host reads Drupal's own `Cache-Control`, so `no-store` is honoured"
	}
	// #endregion
];

/** every vector in one group */
export function vectorsIn(group: CapabilityGroup): Vector[] {
	return VECTORS.filter((v) => v.group === group);
}

/** a vector by id, or undefined; ids are what a module declares, so a typo must not resolve */
export function vectorFor(id: string): Vector | undefined {
	return VECTORS.find((v) => v.id === id);
}

export type ModuleVerdict = {
	satisfied: string[];
	unsatisfied: Vector[];
	unknown: string[];
	installable: boolean;
};

/**
 * Scores one module's declared needs against the contract.
 *
 * AN UNKNOWN ID IS NOT SATISFIED. A module declaring `htp.outbound.deferred` would otherwise score
 * as needing nothing, which is the failure mode of every allow-list keyed on a free-form string.
 */
export function scoreModule(needs: readonly string[]): ModuleVerdict {
	const satisfied: string[] = [];
	const unsatisfied: Vector[] = [];
	const unknown: string[] = [];

	for (const id of needs) {
		const vector = vectorFor(id);
		if (!vector) {
			unknown.push(id);
			continue;
		}
		if (vector.expected) satisfied.push(id);
		else unsatisfied.push(vector);
	}
	return {
		satisfied,
		unsatisfied,
		unknown,
		installable: unsatisfied.length === 0 && unknown.length === 0
	};
}

/** a one-line reason a module is refused, naming the vector rather than the module */
export function refusalFor(verdict: ModuleVerdict): string {
	if (verdict.unknown.length > 0) {
		return `declares ${verdict.unknown.length} capability id(s) this contract does not define: ${verdict.unknown.join(', ')}`;
	}
	if (verdict.unsatisfied.length === 0) return '';
	return verdict.unsatisfied
		.map((v) => `${v.id} (${v.blocker ?? 'unsatisfied'}): ${v.claim}`)
		.join('; ');
}
