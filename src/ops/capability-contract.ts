/**
 * The capability contract: what this runtime can do, as vectors a module is scored against.
 *
 * Every probe runs against the shipping interpreter and must equal `expected`, in BOTH directions.
 * An `expected: false` is not a TODO; `blocker` says which kind it is.
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
 * `permanent` and `platform` differ: no Worker has a process table, but Durable Object SQLite
 * could register `REGEXP` tomorrow
 */
export type Blocker = 'permanent' | 'platform' | 'scheduled' | 'by-design' | null;

/**
 * Whether the probe DOES the thing or only asks whether the symbol is there.
 *
 * `declared` is legal where the claim IS about a declaration; such a row must say so in `evidence`
 */
export type VectorKind = 'executed' | 'declared';

export type Vector = {
	/** stable dotted id; a module declares these, so renaming one is a breaking change */
	id: string;
	group: CapabilityGroup;
	kind: VectorKind;
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

/** expressions rather than scripts, so the whole set runs in one boot and a throw answers false */
export const VECTORS: readonly Vector[] = [
	// #region HTTP
	{
		id: 'http.outbound.deferred',
		group: 'HTTP',
		kind: 'declared',
		claim: 'an outbound call whose answer may arrive on a later request',
		probe: "function_exists('vrzno_env') && vrzno_env('cfwQueueFetch') !== null",
		expected: true,
		blocker: null,
		evidence: 'the queue/drain/cache tier; `deferred-post.spec.ts` drives it end to end'
	},
	{
		id: 'http.outbound.blocking',
		group: 'HTTP',
		kind: 'declared',
		claim: 'an outbound call that must answer inside one render',
		probe: "function_exists('vrzno_env') && vrzno_env('cfwSuspend') !== null",
		expected: false,
		blocker: 'platform',
		evidence: 'PHP cannot await; needs a suspending build (JSPI or ASYNCIFY)'
	},
	{
		id: 'http.curl',
		group: 'HTTP',
		kind: 'executed',
		claim: 'an SDK that bundles its own curl transport runs unmodified',
		probe: "(function () { if (!function_exists('curl_init') || !function_exists('curl_exec')) { return false; } $h = curl_init('https://example.invalid/'); if ($h === false) { return false; } $set = curl_setopt($h, CURLOPT_RETURNTRANSFER, true); curl_close($h); return $set === true; })()",
		expected: true,
		blocker: null,
		evidence:
			'shimmed over the deferred queue; `host-bridges.spec.ts` asserts both are declared'
	},
	{
		id: 'http.request_headers',
		group: 'HTTP',
		kind: 'declared',
		claim: "a request's own headers reach the eventual fetch",
		probe: "function_exists('cfw_http_headers_supported')",
		expected: false,
		blocker: 'scheduled',
		evidence: '`cfwFetch` keys on method + URL + body only, so `Authorization` is dropped'
	},
	{
		id: 'http.stream_wrapper.https',
		group: 'HTTP',
		kind: 'executed',
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
		kind: 'declared',
		claim: 'writing a managed file under the public scheme',
		// the CLASS, not `stream_get_wrappers()`. Drupal registers its wrappers in
		// `DrupalKernel::preHandle()`, which a kernel boot alone does not run, so the wrapper list is
		// empty here and would have reported a capability the site plainly has
		probe: "class_exists('Drupal\\\\drupflare\\\\StreamWrapper\\\\CfwFileStreamWrapper')",
		expected: true,
		blocker: null,
		evidence:
			'DECLARED, and the reason is measured: `public` is absent from `stream_get_wrappers()` after a bare kernel boot, because Drupal registers its wrappers during the request lifecycle -- so an executed probe here reports a capability every render has as missing. The round trip runs in the file specs instead'
	},
	{
		id: 'files.realpath',
		group: 'FILES',
		kind: 'declared',
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
		kind: 'executed',
		claim: 'a single file larger than one Durable Object record',
		probe: "(function () { $uri = 'public://cfw_probe_big.bin'; $big = str_repeat('x', 2400000); $wrote = @file_put_contents($uri, $big) !== false; $back = $wrote ? (int) @filesize($uri) : 0; @unlink($uri); return $wrote && $back === strlen($big); })()",
		expected: false,
		blocker: 'platform',
		evidence: 'a record caps at 2,199,995 bytes; a larger file has to be chunked by the caller'
	},
	// #endregion

	// #region DATABASE
	{
		id: 'database.transactions',
		group: 'DATABASE',
		kind: 'executed',
		claim: 'a buffered transaction replayed atomically',
		probe: "(function () { $db = \\Drupal::database(); $txn = $db->startTransaction(); $n = $db->query('SELECT 1 AS n')->fetchField(); unset($txn); return (int) $n === 1; })()",
		expected: true,
		blocker: null,
		evidence: '`TransactionBuffer` in the rom driver; the whole driver suite covers it'
	},
	{
		id: 'database.wide_integers',
		group: 'DATABASE',
		kind: 'executed',
		claim: 'a 64-bit id read back exactly',
		probe: "(function () { $n = \\Drupal::database()->query('SELECT 9007199254740993 AS n')->fetchField(); return (string) $n === '9007199254740993'; })()",
		expected: true,
		blocker: null,
		evidence:
			'the statement is re-read wrapped as a subquery casting by output name; 9 shapes asserted in `wide-integers.spec.ts`'
	},
	{
		id: 'database.regexp',
		group: 'DATABASE',
		kind: 'executed',
		claim: 'a Views regular-expression filter',
		probe: "(function () { try { \\Drupal::database()->query(\"SELECT 'a' REGEXP 'a' AS n\")->fetchField(); return true; } catch (\\Throwable $e) { return false; } })()",
		expected: false,
		blocker: 'platform',
		evidence: 'Durable Object SQLite registers no `REGEXP` function'
	},
	{
		id: 'database.like_long',
		group: 'DATABASE',
		kind: 'executed',
		claim: 'a LIKE pattern longer than 50 bytes',
		probe: "(function () { $pattern = str_repeat('a', 60) . '%'; try { \\Drupal::database()->query('SELECT 1 AS n WHERE :s LIKE :p', [':s' => 'x', ':p' => $pattern])->fetchField(); return true; } catch (\\Throwable $e) { return false; } })()",
		expected: false,
		blocker: 'platform',
		evidence:
			'the pattern caps at 50 bytes; the driver widens to a prefix and post-filters where it can'
	},
	{
		id: 'database.many_params',
		group: 'DATABASE',
		kind: 'executed',
		claim: 'a query binding more than 100 parameters, which the driver splits before the platform sees it',
		probe: "(function () { $ph = []; $args = []; for ($i = 0; $i < 101; $i++) { $ph[] = ':p' . $i; $args[':p' . $i] = $i; } try { \\Drupal::database()->query('SELECT 1 AS n WHERE 1 IN (' . implode(', ', $ph) . ')', $args)->fetchField(); return true; } catch (\\Throwable $e) { return false; } })()",
		expected: true,
		blocker: null,
		evidence:
			"THE CLAIM MOVED WHEN IT WAS EXECUTED. The platform cap is still 100 bound parameters per statement, measured; what changed is the answer to the question this row asks. A 101-parameter `IN` issued through Drupal SUCCEEDS, because the driver splits the list before the platform sees it, so from a module's side the capability is present. The row used to read `expected: false` with the literal `false` as its probe, which asserted the platform limit rather than the module-side claim its `claim` names"
	},
	// #endregion

	// #region RUNTIME
	{
		id: 'runtime.int64',
		group: 'RUNTIME',
		kind: 'executed',
		claim: 'a PHP integer wider than 32 bits',
		probe: 'PHP_INT_SIZE >= 8',
		expected: true,
		blocker: null,
		evidence:
			'`PHP_INT_SIZE` is 8. `ZEND_ENABLE_ZVAL_LONG64` is forced on a wasm32 build, so the integer width is bought without the pointer width: +12,247 zstd bytes and 19.50 MiB of heap headroom, against wasm64 which costs 5x the bytes for the same capability'
	},
	{
		id: 'runtime.mbstring',
		group: 'RUNTIME',
		kind: 'declared',
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
		kind: 'executed',
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
		kind: 'executed',
		claim: 'memory-hard password hashing, which Drupal 12 defaults to',
		probe: "(function () { return function_exists('cfw_argon2_available') && cfw_argon2_available() === true; })()",
		expected: true,
		blocker: null,
		evidence:
			'argon2id on the host at OWASP m=19456/t=2/p=1, behind `ARGON2`. The RFC 9106 vector passes'
	},
	{
		id: 'runtime.openssl.sign',
		group: 'RUNTIME',
		kind: 'declared',
		claim: 'JWS and service-account JWTs, which sign and verify',
		probe: "function_exists('openssl_sign') && function_exists('openssl_verify')",
		expected: true,
		blocker: null,
		evidence: 'shimmed over `node:crypto`; a real 2048-bit RSA round trip is asserted from PHP'
	},
	{
		id: 'runtime.zlib.dictionary',
		group: 'RUNTIME',
		kind: 'executed',
		claim: 'delta coding, which needs deflate against a preset dictionary',
		// `gzdeflate()` takes no dictionary and `gzcompress()` takes none either, which is what made
		// this look impossible without a host bridge. The INCREMENTAL api has taken one since PHP 7.0
		probe: "(function () { $dict = 'drupal-node-field-data'; $data = str_repeat('drupal-node-field-data', 8); $d = deflate_init(ZLIB_ENCODING_DEFLATE, ['dictionary' => $dict]); $z = deflate_add($d, $data, ZLIB_FINISH); $i = inflate_init(ZLIB_ENCODING_DEFLATE, ['dictionary' => $dict]); return inflate_add($i, $z, ZLIB_FINISH) === $data; })()",
		expected: true,
		blocker: null,
		evidence:
			'ext-zlib is one of the 25 loaded extensions; `deflate_init` takes a `dictionary` option'
	},
	{
		id: 'runtime.xmlwriter',
		group: 'RUNTIME',
		kind: 'executed',
		claim: 'streaming XML output, which several sitemap and feed modules require to install',
		// the CLASS, not the extension: `extension_loaded()` reports what was compiled in and is a
		// built-in, so no shim can move it. What decides whether a module can WRITE XML is whether
		// the class resolves, and that is what this now asks
		probe: "(function () { $w = new \\XMLWriter(); $w->openMemory(); $w->startDocument('1.0', 'UTF-8'); $w->startElement('urlset'); $w->writeElement('loc', 'https://example.test/'); $w->endElement(); $w->endDocument(); return strpos($w->outputMemory(), '<loc>https://example.test/</loc>') !== false; })()",
		expected: true,
		blocker: null,
		evidence:
			'SHIMMED 2026-08-23, and the entry it replaces said a pure-PHP XMLWriter could not exist because nothing satisfies `extension_loaded()`. Half right: the extension check cannot be shimmed, and it is not what generating a sitemap needs. `XMLWRITER_FIX` supplies the eleven methods `simple_sitemap` 4.2.1 actually calls, verified BYTE FOR BYTE against libxml by `tests/node/xmlwriter-parity.spec.ts` -- which caught three behaviours a hand-written expectation had wrong. The install-blocking `hook_requirements()` error is cleared host-side by `Requirements::requirementsAlter()`, so the module is unmodified'
	},
	{
		id: 'runtime.exec.declared',
		group: 'RUNTIME',
		kind: 'declared',
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
		kind: 'executed',
		claim: 'shelling out to a binary and reading its output',
		probe: "(function () { $o = []; $r = @exec('echo hi', $o); return $r !== false && count($o) > 0; })()",
		expected: false,
		blocker: 'permanent',
		evidence: 'a Worker has no process table; nothing can make this true'
	},
	{
		id: 'runtime.monotonic_clock',
		group: 'RUNTIME',
		kind: 'declared',
		claim: 'a monotonic clock function is declared; whether it ADVANCES is the edge question',
		probe: "function_exists('hrtime')",
		expected: true,
		blocker: null,
		evidence:
			'DECLARED on purpose. An executed delta ANSWERS TRUE in the gate lane and false on the edge -- measured, a 300,000-iteration loop moves `microtime()` here and does not out there -- so executing it would put a confident wrong answer about production into the contract. RULE 0: an absolute CPU or elapsed figure comes only from `cpuTime` on a deployed worker'
	},
	// #endregion

	// #region MEDIA
	{
		id: 'media.gd',
		group: 'MEDIA',
		kind: 'executed',
		claim: 'an image toolkit that writes derivative files',
		probe: "(function () { if (!function_exists('imagecreatetruecolor')) { return false; } return @imagecreatetruecolor(1, 1) !== false; })()",
		expected: false,
		blocker: 'by-design',
		evidence:
			'image styles are applied at DELIVERY by Cloudflare Images rather than by rewriting'
	},
	{
		id: 'media.delivery_styles',
		group: 'MEDIA',
		kind: 'declared',
		claim: 'image styles that resolve to a resized URL',
		probe: "class_exists('Drupal\\\\drupflare\\\\Plugin\\\\ImageToolkit\\\\CfwImageToolkit')",
		expected: true,
		blocker: null,
		evidence:
			'The toolkit lived at `src/ImageToolkit/` while the manager registers the subdir `Plugin/ImageToolkit`, so discovery never saw it and a site had NO toolkit at all -- gd is absent too. Moved; `tests/integration/image-toolkit.spec.ts` asserts discovery, availability and a derivative end to end'
	},
	{
		id: 'media.getimagesize',
		group: 'MEDIA',
		kind: 'executed',
		claim: 'image dimensions read from the file header',
		probe: "(function () { $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='); $f = '/tmp/cfw_probe.png'; file_put_contents($f, $png); $i = @getimagesize($f); @unlink($f); return is_array($i) && $i[0] === 1 && $i[1] === 1; })()",
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
		kind: 'declared',
		claim: 'pausing a render to wait on I/O',
		probe: "class_exists('Fiber') && !class_exists('PhpWasmSyncFiber')",
		expected: false,
		blocker: 'platform',
		evidence:
			'DECLARED, and the reason is measured: driving a real `Fiber::suspend()` does not throw, it ABORTS the interpreter with `missing function: getcontext`, which takes every other vector in the shared probe run down with it. `PhpWasmSyncFiber` is the shim that runs the body inline instead'
	},
	{
		id: 'async.cron',
		group: 'ASYNC',
		kind: 'declared',
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
		kind: 'executed',
		claim: "Drupal's queue API, drained across invocations",
		probe: "(function () { $q = \\Drupal::queue('cfw_probe_queue'); $q->createQueue(); $q->createItem(['n' => 7]); $item = $q->claimItem(); if ($item === false) { return false; } $ok = ($item->data['n'] ?? null) === 7; $q->deleteItem($item); $q->deleteQueue(); return $ok; })()",
		expected: true,
		blocker: null,
		evidence: 'the database queue works; it moves when cron runs it'
	},
	// #endregion

	// #region CACHE
	{
		id: 'cache.tag_invalidation',
		group: 'CACHE',
		kind: 'executed',
		claim: 'invalidating a cache tag purges the edge as well as the bin',
		probe: "(function () { $b = \\Drupal::cache(); $cid = 'cfw_probe_tag'; $b->set($cid, 'v', -1, ['cfw_probe_tag']); if ($b->get($cid) === false) { return false; } \\Drupal\\Core\\Cache\\Cache::invalidateTags(['cfw_probe_tag']); $after = $b->get($cid); $b->delete($cid); return $after === false; })()",
		expected: true,
		blocker: null,
		evidence:
			'a `cachetags` write crosses `execSql()` and bumps the generation; asserted in the serve chain'
	},
	{
		id: 'cache.custom_bin',
		group: 'CACHE',
		kind: 'executed',
		claim: 'a module declaring its own cache bin',
		probe: "(function () { $b = \\Drupal::service('cache_factory')->get('cfw_probe_bin'); if (!$b instanceof \\Drupal\\Core\\Cache\\CacheBackendInterface) { return false; } $d = \\Drupal::cache('data'); $cid = 'cfw_probe_bin_rt'; $d->set($cid, 'v'); $hit = $d->get($cid); $d->delete($cid); return $hit !== false && $hit->data === 'v'; })()",
		expected: true,
		blocker: null,
		evidence: 'the backend factory serves any bin name'
	},
	{
		id: 'cache.kill_switch',
		group: 'CACHE',
		kind: 'executed',
		claim: 'refusing to cache one response',
		probe: "(function () { $k = \\Drupal::service('page_cache_kill_switch'); $req = \\Symfony\\Component\\HttpFoundation\\Request::create('/'); $res = new \\Symfony\\Component\\HttpFoundation\\Response(); if ($k->check($res, $req) !== null) { return false; } $k->trigger(); return $k->check($res, $req) === \\Drupal\\Core\\PageCache\\ResponsePolicyInterface::DENY; })()",
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
