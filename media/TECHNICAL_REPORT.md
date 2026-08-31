# Technical Report: Drupal on Cloudflare Workers

Drupal 11.4.5 runs on Cloudflare Workers with PHP 8.5 executing as WebAssembly inside a Durable
Object, using that object's own SQLite as the database. This document is the engineering reference
for that system: how it is put together, which platform limits shape it, what each operation costs,
and which classes of defect it has produced.

Every figure here is measured. The instrument is named in each table, because a local wall clock and
a deployed `cpuTime` reading are not interchangeable.

---

## 🧭 Executive Summary

The bundle ships PHP 8.5 with every extension Drupal requires and nothing dropped. The interpreter
travels as a zstd frame in a `Data` module and is inflated at module scope, so Cloudflare's own gzip
measures bytes it cannot compress further.

| | measured | instrument |
| --- | --- | --- |
| Worker bundle, gzipped | under the 3,145,728-byte free ceiling | `bun run release:check` |
| PHP 8.5, `long64` variant | **2,671,380** bytes as a zstd frame; 12,234,574 raw | `interp.lock.json` |
| Isolate startup | **112 ms** median (n=5) of a 1,000 ms budget | Cloudflare `Worker Startup Time` |
| Startup billed to a request | **0-1 ms**; it is not billed | edge `cpuTime`, 3 cold isolates |
| Cold boot | **1,398 ms** (n=3) | edge `cpuTime` |
| Cold boot, object held resident | **0 ms**; an 8 s alarm re-arm keeps one incarnation | 71 consecutive alarms, deployed |
| Full uncached render, both bins emptied | **2,127 ms** (n=10, 1,982-2,579) | edge `cpuTime` |
| Authenticated page, both levers on | **~467 ms** against 3,525 with neither | derived; see Warming |
| Serving ceiling, free | **3.0M visits/month**, saturated at 1.00x | model over measured meters |
| Regeneration ceiling, free | **10,869 renders/day** windowed, **2,777** on the alarm chain | rows written binds |
| Wasm penalty against native PHP | **3.57x** warm, **3.94x** cold | local, ratio only |

The bundle figure moves whenever `src/` does. Run the command rather than carrying a number.

### The Two Ceilings

Free's limits are aggregate daily budgets, not the 10 ms per-invocation CPU cap. The cap constrains
one execution unit and the architecture decides what an execution unit is: 20 Durable Object hops
accumulate 142 ms with no single invocation over 10 ms.

| ceiling | what it limits | bound by | free |
| --- | --- | --- | --- |
| **Serving** | visits/month answerable at all | Worker requests, 100k/day | **3.0M/month**, saturated |
| **Regeneration** | distinct pages re-rendered per day | **rows written** | **10,869/day** |

Score any proposal with `bun scripts/measure/free-envelope.ts`; it fails a workload that misses
either ceiling, and `tests/unit/free-envelope.spec.ts` covers the arithmetic. Two properties decide
most arguments:

- **A cache hit is not free.** It costs one Worker request whether or not PHP runs, so a 99%-cached
  architecture rescues CPU and buys no extra visits.
- **Decomposition is not free.** The DO quota counts alarm invocations, so slicing spends the meter
  it is trying to dodge; a measured 6-way split took fills from 5,555 to 4,166/day.

A page served from an R2 public bucket on a custom domain is answered through the CDN without
invoking the Worker. That is the only lever worth more than 2x on serving, and its floor is **3.3x**
-- R2's 10M Class B operations/month against 100,000 Worker requests/day. The off-Worker share has an
optimum rather than a maximum: modelled on the default mix, **77% peaks at 432,900 views/day; 99%
falls back to 336,700**, because past the crossover it spends a 333,333/day meter to save a
100,000/day one.

### Two More Meters

**Cloudflare Images allows 5,000 unique transformations per month on free**, and it fails as a hard
cap rather than a bill. Every image style is a transformation, so 10 styles over 2,000 images is 4x
over. It is projected rather than counted -- the object multiplies its styles by its images on each
alarm and records `budget.image_transforms` at 80% -- because it is a function of content and
configuration, both known in advance, and it is monthly so it does not clear at midnight.

**Durable Object duration** is 13,000 GB-s/day on free, billed against the 128 MB an object is
allocated regardless of use and on wall clock rather than CPU. At today's traffic it does not bind.
The exposure is hibernation eligibility rather than arithmetic; see Hibernation below.

### Where It Wins and Where It Does Not

The architecture wins by not rendering rather than by rendering faster. An uncached render costs
**2,127 ms** of edge `cpuTime`, and one Durable Object is one thread that cannot be made bigger.

**A SITE IS NO LONGER ONE OBJECT.** That sentence used to end here, and the second half of it -- "so
a site is one thread" -- was a property of the topology rather than of the platform. A namespace
holds unlimited objects, an authenticated GET writes no authoritative state under this SAPI, and a
site now has replica lanes: 1.00 / 2.03 / 3.29x at 1 / 2 / 4 on real authenticated renders, against
1.00 / 2.05 / 3.16 / 5.72x for a fixed CPU burn on independent objects. Content sites win decisively
and authenticated reads scale with the pool. **Writes now spread too**, and this paragraph used to
say they could not: a lane runs the write, discards its own effect and forwards the statements to
the primary, which stays the sequencer. What still serialises there is the commit itself and any
write whose target originates a value a lane may not mint.

**The 3.57x wasm penalty is not that number and must not be read as it.** It is a warm-kernel ratio
between two interpreters on ONE machine, with the container already built; the edge figure is the
whole request. The README carried `34 ms` for this row until 2026-08-29, which is `9.47 x 3.57` --
an arithmetic product of a native measurement and a local ratio, published under a provenance code
meaning "measured on deployed infrastructure", and 62x below what the deployed meter reports.
`scripts/bench/bench-render-breakdown.php` calls the 33.8 ms basis an inference in its own header.
The neighbouring `page_cache` row is 1 ms because a stored-page serve runs at a 20x
`activeTime/cpuTime` ratio; a render runs at **1x**, so no divisor carries across.

---

## Architecture

### PHP Runs Inside the Durable Object

`ctx.storage.sql.exec()` is synchronous because `ctx` exists inside the Durable Object class. From a
Worker isolate holding a `DurableObjectStub`, every call is `await stub.fetch()` or an async RPC
method: there is no synchronous cross-isolate call in Workers, and PHP's database calls are blocking.

| shape | database access | bundle consequence | concurrency |
| --- | --- | --- | --- |
| **PHP inside the DO** | sync `exec()` | no Asyncify; the bundle fits | one request at a time per site |
| PHP in Worker isolates | every query async | JSPI or Asyncify on all queries per render | horizontal |

PHP runs inside the object. The database, the alarm that drives regeneration, and per-site
serialization all live there too. The accepted consequence is that a site is serialized: one request
at a time. A stored-page serve is ~22 ms of wall clock and a full render is ~2.4 s, so the FIFO gate
is a real throughput ceiling and per-site sharding is a design requirement rather than an
optimisation.

### The Front Worker

`src/site.ts` runs no PHP. It owns the tier above the object: `caches.default`, the generation
pointer, the deny filter, the body guard, the auth budget, and route classification.

A `caches.default` hit costs no Durable Object request and no Durable Object wall clock -- two
separately billed budgets the architecture otherwise spends on every page view -- and it takes hit
traffic off the object's single-threaded gate. It is also the only layer that scales across colos;
DO storage is one location.

The route set is split into `PUBLIC_ROUTES`, `OWNER_ROUTES` and `DIAGNOSTIC_ROUTES`. A route absent
from the union is rewritten to `/serve`, which means an unlisted route renders as a Drupal page
rather than 404ing. `/__*` paths are Durable Object routes and are refused from outside by
construction, so any redirect target a browser must reach needs a public route of its own.

### Cache Tiers

`src/ops/cache-tiers.ts` is the single list of values `x-cfw-cache` may carry: `HIT`, `MISS`,
`RENDER`, `ASSEMBLED`, `EDGE`, `KV`, `DENY`. `pageResponse()` takes the tier and sets the header, so
a hand-built header set is the way a response loses `x-cfw-generation`.

Four tiers hold anonymous pages, and every one refuses authenticated content on the write side:
`fillOne()` refuses a cookie-rendered page, `putPage()` refuses an authenticated request or a
`Set-Cookie` response, the KV tier answers `skipped:authenticated`, and the R2 drain refuses any path
whose `cfw_page` row is absent or not 200.

Both page tiers cost one Worker request each, because the Worker has to run to consult them. No page
is served off-Worker today: the canonical `wrangler.jsonc` declares no R2 binding and no bucket is
fronted by a custom domain.

### The Fill Chain

A render happens off the request path. A MISS queues the path in `cfw_fill_queue`, the alarm renders
it in batches, and `fillOne()` upserts the result into `cfw_page`. The queue is capped at 500, since
an anonymous visitor asking for distinct paths otherwise grows it forever at ~12 rows each.

`FILL_BATCH_SIZE`, `FILL_BATCH_WALL_MS`, `RENDER_BUDGET_MS`, `HTTP_DRAIN_LIMIT`, `MIRROR_LIMIT`,
`LAZY_FS_BUDGET_BYTES` and `PREFILL` are read on this chain, which never passes through `handle()`.
`adoptSettings()` overlays the KV-resolved values in both `handle()` and `alarm()` for that reason.

A cold URL costs its first visitor two requests. The alarm mechanism moves the cost rather than
removing it:

| mechanism | Worker | DO | rows | peak invocation | fits the 10 ms cap |
| --- | --- | --- | --- | --- | --- |
| alarmRetry | 2 | 3 | 14 | 10 ms | yes |
| inlineBoot | 1 | 1 | 13 | 1,398 ms | no, by 140x |
| skeleton | 1 | 1 | 0 | -- | no artifact |

The cheapest mechanism on every meter is the one the cap refuses. Measured on a deployed free
account, a fully cold object answers 503 then 404-from-storage in **3,166 ms of wall clock across
two visitor requests**; a path already in `cfw_page` answers on the first at 57-69 ms.

A cold MISS refuses at `!this.php`, not on a budget: raising `RENDER_BUDGET_MS` from 2,000 to 25,000
does not move it.

### First-Run Migration

A pre-built site is shipped and replayed rather than installed. `assets/drupal-sql/` holds the
chunked SQL; `src/db/migrate-sql.ts` replays it as a JavaScript loop with a cursor in DO storage.

The manifest records **79 chunks / 1,343 rows / 1,670 statements**, and a live migration drives
exactly 79 of 79 at **max 3 ms of edge cpuTime per chunk, 0 chunks over the 10 ms cap**. In one
invocation the same work was 3,467 ms.

**Divisibility, not speed, is what made it fit.** A JavaScript loop can be split at any statement
where a synchronous `php._run()` cannot. There is also a smaller unit than a row: SQLite builds a
value across statements with `col = col || ?`, which is how three 520 KB rows became divisible.

A half-migrated site refuses to serve.

### The Database Driver

`cfw_do_sqlite` (sibling repo `rom`) is a Drupal 11 driver over `ctx.storage.sql`. It extends
`Drupal\sqlite\Driver\Database\sqlite`, calling the grandparent `Connection::__construct()` directly
so it never touches PDO, and returns a synthetic `['main' => 'main']` from `getAttachedDatabases()`
so the inherited `Schema::findTables()` works while the destructor's prune loop stays empty.

The query builders, the condition compiler, the type map and the table-rebuild dance are inherited
unchanged. `Upsert` is the one override, because the host caps a statement at 100 bound parameters
and core's sqlite `Upsert` emits one multi-row statement.

**Transactions are buffered and replayed.** `BEGIN` as SQL is refused outright, and
`ctx.storage.transactionSync(cb)` is callback-scoped and driven from JS, so the two APIs do not
compose:

```text
startTransaction()   -> open a buffer
  write              -> append to the buffer, return no rows and no row count
  read, clean table  -> straight to the host
  read, dirty table  -> replay the buffer + the read in one transactionSync,
                        capture the rows, roll the whole thing back
  savepoint          -> record the buffer length
  rollback to it     -> truncate the buffer to that length
rollBack()           -> discard the buffer; this cannot fail
commit()             -> replay the buffer in one transactionSync
```

A read is clean when none of the tables it references has a buffered write. `SqlAnalyzer`
over-approximates in every uncertain direction -- an unclassifiable statement, an unpinnable write
target or a `RENAME` marks everything dirty -- because a false positive costs one expensive read and
a false negative returns wrong data silently. DDL additionally dirties a pseudo-table
`sqlite_master`, so `tableExists()`, `findTables()` and `PRAGMA table_info()` resolve through the
replay rather than reading stale schema.

The replay is O(W x R) in statement count. A warm node save through Drupal's entity API opens 10
transactions, 9 of them speculative, and executes **54 replayed statements of 59 total**; a first
save on a fresh kernel is 18 / 137 / 152. Buffers are small (5.4 statements per transaction), so the
number to watch is statements-per-transaction rather than transactions.

Four functions core registers through `PDO::sqliteCreateFunction()` are rewritten to builtins --
`GREATEST` to `max`, `LEAST` to `min`, `RAND` to `random`, `IF` to `iif`. `MD5()`,
`SUBSTRING_INDEX()` and `REGEXP` have no builtin equivalent and fail loudly. `NOCASE_UTF8` becomes
builtin `NOCASE`, which is ASCII-only. `LENGTH()` changes meaning: core overrides it with PHP's
`strlen()`, so it counts bytes, while SQLite's builtin counts characters on TEXT.

`LIKE BINARY` is translated rather than refused. `Condition::compile()` emits
`field OPERATOR prefix placeholder postfix`, so a marker in the operator's `prefix` identifies which
bound argument is the pattern; `translateLikeBinary()` rewrites it with `likeToGlob()` and strips the
marker. Core's `ESCAPE '\'` postfix is dropped, because builtin `GLOB` refuses a third argument.
9,000 differential cases agree with core's own `sqlFunctionLikeBinary()`, all of them on patterns of
at most 5 characters -- the 50-byte refusal, not the differential agreement, is what protects a
`CONTAINS` filter over that length.

**Wide integers are read exactly through re-execution, not a parser.** `ctx.storage.sql` hands
INTEGERs back as JS doubles, so the read is lossy above 2^53 while the storage is not.
`src/db/wide-integers.ts` re-runs the original statement wrapped as a subquery with the result rows'
own output column names cast to TEXT. `SELECT *`, aliases, JOINs, aggregates, `UNION` and bound
parameters are covered by construction. It triggers on detection, so a site storing no wide integers
pays nothing; `WITH`, `PRAGMA` and non-SELECT are refused.

### The PHP Filesystem

The Drupal tree is mounted lazily from the shared ASSETS binding and a file is inflated only when PHP
opens it. **Zero rows of file content reach the site's SQLite**: 11,525 nodes and 41,796,908 bytes at
a shared fraction of 1.000000, with exactly one file permitted to differ -- `settings.php`, carrying
the per-site hash salt.

Uploads are different. `public://` and `private://` are backed by the object's own SQL through
`src/db/file-store.ts`, so a file written through Drupal's file API survives an eviction. Before
that, MEMFS meant an upload lived as long as its isolate while the `file_managed` row describing it
survived.

`CfwFileStreamWrapper::realpath()` returns FALSE, which makes a file-capturing module capture nothing
silently. The rule that covers cases like it: a capability is **shimmed, accommodated, or declared**,
never silently absent -- declared meaning a no-op that cannot fatal, logs once per boot, and raises a
`hook_requirements()` row.

### The Interpreter Seam

`src/runtime/php-binary*.ts` are the arms. `wrangler.jsonc` aliases the exact specifier
`./runtime/php-binary.js` to the zstd 8.5 seam; an extensionless import resolves the default seam
instead and bundles a binary 710,410 bytes over the ceiling with nothing failing but the size.

The gate cannot use the zstd seam. `php-binary-85.ts` inflates and calls `new WebAssembly.Module` at
module scope, which is correct in production because workerd permits codegen at worker startup -- but
a vitest spec is evaluated inside a fetch handler, so module scope there is request time and workerd
answers `inflate.codegen-disallowed`. `vitest.config.ts` therefore aliases the seam's two imports to
the raw `.wasm` and worker glue, which arrive pre-compiled through the `CompiledWasm` rule. That
costs 12,218,393 bytes, which is why it is a test path.

Both routes reach the same interpreter and the same growth policy: `restore-artifacts.ts` emits the
tuned glue after verifying the pristine download against `cdn-manifest.json`, and `vitest.config.ts`
emits the same file when it is missing.

### Modules on the Edge

Composer never runs on the edge, so `assets/driver.json` is what executes. `scripts/gen-driver-assets.ts`
packs it directly from the sibling checkouts `../drupflare`, `../rom` and `../stream-http`, reading an
allow-list (`src`, `.info.yml`, `.install`, `.module`, `.services.yml`) rather than walking a checkout
wholesale. The machine name comes from the mount, not the directory.

A composer `require` ships nothing: the packed tree is the vendor directory. `drupflare` requires
`drupflare/stream-http` and its `HttpsStreamWrapper` extends the packaged class, so the packer mounts
`../stream-http/src` at `libraries/drupflare-stream-http/src` and the PSR-4 root is registered in
both autoloader sites -- `SETTINGS_OVERRIDE` in `src/site-do.ts` and the boot fragment in
`src/drupal/site-php.ts`.

`tests/node/driver-pack.spec.ts` asserts the pack matches the modules on disk byte for byte.

`moduleTable()` in `src/ops/module-table.ts` is the contrib census. It has exactly three states:

- **verified** -- a gated run enabled the module against a real site and asserted an observable it
  owns.
- **untested** -- nothing has run it.
- **blocked** -- a named refusal.

An inference about the runtime is not a support claim. `search_api_solr` sat behind a correct note
about its Solarium transport and the transport was never the blocker: it pulls
`maennchen/zipstream-php`, which declares `php-64bit`, so composer's `platform_check.php` aborted
every request before Drupal booted -- and all 56 other contrib cases failed with it. The blast radius
of a dependency constraint is the whole application, and only an install measures it.

The platform check stays on. It now costs nothing, because `PHP_INT_SIZE` is 8.

### Outbound Capability

Three tiers, layered cached -> deferred -> sync, with the sync tier absent.

**HTTP.** `cfwFetch` answers from cache, or arms `cfw_http_queue` and defers; `drainHttpQueue()`
dispatches in the alarm. `Drupal::httpClient()` reaches it through
`Drupal\drupflare\Http\CachedFetchHandler` -- a Guzzle handler rather than a `StreamHandler`
subclass, because `createStream()` and `lastHeaders` are private. A cache hit gives a real PSR-7
response; a miss arms the queue and rejects with `ConnectException`, because `http_errors` does not
raise on 2xx and a 202 deferral note would be `Json::decode()`d and iterated by callers.

**TCP.** `cfw_tcp_connect()` / `read()` / `write()` / `close()` cannot exist: `Host::call()` is
`$reply = $invoke($json)` and the wasm stack cannot suspend without JSPI, so a `read()` that blocks
for bytes that have not arrived has nowhere to block. What ships instead (`src/ops/tcp.ts`) is a
declared exchange -- PHP names a whole operation, the host runs it in JavaScript between invocations
over edgeport, and the answer is read on a later invocation. It shares the HTTP queue, cache and
retry budget: a `tcp+redis://` row goes in `cfw_http_queue` and the drain dispatches on the scheme.

The endpoint is the operator's, never the caller's. `REDIS_URL` and `SYSLOG_URL` carry host, port and
credentials; PHP supplies only the operation. Arbitrary `host:port` behind anything that can call a
host function is a port scanner and a protocol-smuggling surface, strictly wider than the HTTP tier's
SSRF because it is not confined to HTTP semantics. Both are secrets and neither may join
`KV_OVERRIDABLE`.

**A Redis cache backend cannot be built on this.** A cache get has to answer inside the request that
asked, and a deferred exchange always misses the first time. The object's own SQLite is the backend.
What the tier reaches is the deferrable half, plus `syslog`, which never replies.

**Mail.** `CfwMail` passes `smtp.settings` through `mailEnvFromSite()`, so a site that configured
`drupal/smtp` needs no Worker vars; the deployment's own vars win every field they set. The settings
are persisted to `cfw_meta` because the alarm re-resolves the transport and never sees the message.

### Identity

**`WITH_OPENSSL=0`, so the interpreter cannot verify an RS256 `id_token` at all.** A JSPI build that
let PHP fetch the token endpoint synchronously would hand PHP a token it still could not check, and
an unverified `id_token` is an unauthenticated login. The host has `crypto.subtle`, so host-side
pre-exchange is the only route rather than the cheap one.

`src/ops/oidc.ts` owns discovery, PKCE, state, the token exchange and the signature check. `/oidc`
starts and completes; `cfwOidcClaims` hands PHP a decided result synchronously, because the awaiting
already happened at a route the host owns.

- The claims never travel in a URL. The browser carries a single-use ticket, the row is deleted
  before the claims are returned, and a replay finds nothing. A redirect lands in browser history, in
  a referrer and in every proxy log on the path, so single-use is the property that matters and a TTL
  only narrows the window.
- Five refusals: a signature from a key outside the JWKS, a foreign issuer, an audience belonging to
  another client of the same provider, an expired token, and a nonce from another login. `none` and
  the HMAC families are refused by omission, and `alg` is taken from the KEY -- trusting the header is
  the RS256-to-HS256 confusion attack.
- The authmap key is scoped by ISSUER. A subject is unique within one provider and says nothing
  across providers.
- `oidc_issuer` lives in `cfw_meta` and the secret is a binding. Neither may join `KV_OVERRIDABLE`: a
  KV writer who could set the issuer would point the consent screen at a provider they control.

### Levers Are Offered Through KV First

Anything offered as a knob is offered through KV before it is offered as a `vars` entry, so an
operator can change it without a redeploy. The ladder is KV, then the var, then whatever fallbacks
the reader already has; `resolveSettings()` and `KV_OVERRIDABLE` in `src/ops/plan.ts` implement it.

`KV_OVERRIDABLE` is a privilege boundary. KV is operator-writable, so nothing on it may change what
is REACHABLE -- every entry's worst case is a slow site. `PW_DIAGNOSTICS` would reach `/sql` and
`/restore`; it, `SITE_ID` and `PLAN` are absent and a spec asserts they stay absent.
`CF_OAUTH_CLIENT_ID` fails the same test and lives in `cfw_meta`, because a KV writer who could set
it would point the consent screen at an application they control and the operator would approve it
reading the attacker's name off Cloudflare's own page.

`tests/integration/kv-levers.spec.ts` asserts the seam by name coverage, so an entry with no wiring
fails rather than shipping.

### Self-Repair

A capped, GC'd health ledger; 12 host tripwires plus budget pressure and its forward projection;
7 PHP tripwires; a mandatory boot self-test; and a repair ladder L0 observe -> L1 reset ->
L2 reconstruct -> L3 reconfigure -> L4 quarantine -> L5 rollback, with a circuit breaker that
escalates on repeated failure and decays on a clean interval.

The tripwires run on the alarm and never on the request path. Recording a finding is a row write, and
rows written is the meter that binds regeneration, so a per-request pass would spend the budget it
exists to watch. A healthy site writes zero rows here.

`RepairLadder::maySafelyRepair()` fails closed: it refuses to act while a transaction is open. Three
consecutive findings of the same code at `error` or above quarantine the site; a different code
resets the count. A quarantined site stops writing and stops filling and **keeps serving**, because
the failure that matters for a free host is "the site is gone" rather than "the site is wrong".
Rollback additionally requires ten consecutive failures and a restore point that exists. Leaving
quarantine is an explicit operator act at `/health?clear=1`.

### Hibernation

Cloudflare bills an object that is idle and unable to hibernate, and does not bill one that is idle
and eligible. The five disqualifying conditions are transcribed in `src/ops/hibernation.ts` rather
than paraphrased: no `setTimeout`/`setInterval`, no in-progress awaited `fetch()`, no standard
WebSocket, no request still being processed, no outbound TCP socket or WebSocket.

**A pending alarm is not on that list.** An armed-alarm object accrued 0.177 s over a 60 s pending
window, so a keep-warm chain costs a row and a DO request per arm and buys no residency. Because the
free DO quotas are account-wide, 277 sites saturate both meters with zero visitors.

**`connect()` is on the list**, and `src/ops/mail.ts` is the only place in `src/` that opens one. An
SMTP send makes the object non-hibernateable for the length of the send, and the drain sends
sequentially. `sendViaSmtp()` closes in a `finally`. Plain `fetch()` never keeps an object alive,
even while its body streams.

---

## Platform Constraints

### Durable Object SQLite

| limit | value | what it broke |
| --- | --- | --- |
| bound parameters per statement | **100** | Drupal's cache write path emits 700; fixed by re-batching on placeholder count in an `Upsert` override |
| LIKE/GLOB pattern | **50 bytes** | six controllers in one real contrib module trip it |
| bytes per record | **2,199,995** | the chunk sizes in the migration and export loops |
| statement text | **100,000 chars** | -- |
| INTEGER reads | lossy above **2^53** | `9007199254740993` reads back `...992`; storage is exact |

Refusals, each measured by running the driver inside the object:

| operation | answer |
| --- | --- |
| `PRAGMA table_info()` / `index_list()` / `index_info()` | works |
| Schema-qualified `"main".sqlite_master`, quoted and bare index names | works |
| `concat`, `concat_ws`, `pow`, `exp`, `iif`, variadic `max`/`min`, `random` | all present |
| `BEGIN` / `SAVEPOINT` / `COMMIT` / `ROLLBACK` as SQL | **refused**; use `transactionSync()` |
| `CREATE TEMPORARY TABLE` | **refused**, `not authorized: SQLITE_AUTH` |
| `sqlite_version()` | **refused**, `not authorized to use function` |
| `GLOB ... ESCAPE` | **refused**, wrong number of arguments |
| `sql.exec()` binding a JS BigInt | **refused**; `bindable()` converts to a decimal string and INTEGER affinity applies |

`version()` cannot call `sqlite_version()`, so it establishes a floor by feature probe and reports
**3.46.0**, proven by `unhex()`. Drupal 11.4.5 gates installation on 3.45, and `concat` -- the obvious
probe -- proves only 3.44 and would have failed the gate. `engineVersionIsFloor()` reports that the
number is a floor.

Across events the implicit transaction commits at the end of **each event**, so a `BEGIN` in one
request is already committed before a `ROLLBACK` arrives in the next.

**An index is a write multiplier, not a read optimisation.** Every index on a hot table is another
charged row per insert, and rows written binds regeneration. ~60% of a router rebuild is index
maintenance, and `router_alias` is 96% NULL and charged on all 419 routes every rebuild.
`amplification()` and `overheadShare()` in `src/db/write-tally.ts` report charged rows per statement
per table, exposed on `/writes`; read `overheadShare` as an upper bound, since a multi-row statement
also charges more rows than statements. A factor of 1.0 on a hot table means there is nothing to win.

`AUTOINCREMENT` costs **2 charged rows against 1** on a deployed A/B, through driver-side speculative
replay rather than through indexes. On a real node save that is 1.16x: the mechanism is expensive and
its share of a real write is small.

### workerd

- **Request-time wasm codegen is blocked.** Codegen is permitted at worker startup, which is why the
  interpreter is instantiated at module scope and why the binary cannot live on the asset layer. No
  published php-wasm build can load its extensions here, since emscripten's dynamic linker needs
  runtime codegen; the shipping binary is static, `MAIN_MODULE=0`, with every required extension
  linked in.
- **`new WebAssembly.Memory({index:"i64"})` is refused**, which is what makes emscripten's
  `toIndexType` probe degrade to the identity on a wasm64 build.
- **`node:child_process` and `node:fs` do not exist**, which is what forces three vitest projects.
- Uploading the full 48 MB `assets/` tree on deploy fails; stage only what is needed.
- A DO-namespace deploy needs ~60 s propagation before `stub.fetch()` stops returning "Worker not
  found".

### Memory

The isolate ceiling is **134,217,728 bytes**. The heap starts at `INITIAL_MEMORY` = 100,663,296 and
peaks where the growth step puts it; at the shipping configuration the authenticated peak is
**113,770,496**, leaving 19.50 MiB.

**THAT PEAK IS PER WORKLOAD AND THE ISOLATE IS CHARGED PER INCARNATION.** `USE_ZEND_ALLOC=0` means
PHP returns nothing between requests, so demand inside one incarnation is the SUM of what it has
done, and the growth step rounds every rise up. Measured on one object, MiB:

| step                        | before | after  |
| --------------------------- | -----: | -----: |
| booted and idle             |  96.00 |  96.00 |
| migrated + firstrun         | 108.50 |  96.00 |
| first authenticated render  | 122.63 |  96.00 |
| second authenticated render | 138.63 | 108.50 |
| third, fourth               | 138.63 | 108.50 |

138.63 is **10.63 MiB past the 128 MiB limit**, so provisioning a site and then viewing two pages on
it exceeded the isolate by construction -- the first-run path of every new site. On the edge that is
`Durable Object's isolate exceeded its memory limit and was reset`, captured twice on a deployed free
worker, and it takes every in-flight request on the object with it plus a cascade of
`Internal error in Durable Object storage caused object to be reset`.

**THE FIX IS AT PROVISIONING, NOT AT THE CEILING**, and the ceiling version was built first. A drop
keyed on linear memory runs BETWEEN invocations, and on a deployed paid worker the reset happened
INSIDE one: the first authenticated `/admin/content` on each of four freshly provisioned sites went
from the install's 108.50 straight past the limit in a single render, 4,661-4,936 ms of cpuTime,
`outcome: exception` with no message and no stack. So `/__migrate` and `/__firstrun` drop the
interpreter when they finish, the way `/__enable` always has, and the serving incarnation starts at
`INITIAL_MEMORY`. The peak over four authenticated pages is then 108.50, flat, with 19.50 MiB spare.

Confirmed on the edge rather than only in the gate: provisioning four fresh sites on the previous
build reset all four, and the same provisioning on the fixed build produced **zero** entries in
`wrangler tail --status error`.

**The drop is conditional on there being a real interpreter to drop**, which is not a detail. A
`{ stubbed: true }` renderer holds no wasm heap, so dropping it accomplishes nothing and removes the
caller's stub -- a migration spec drove itself to `done` and then answered 503 because the drop had
taken away the renderer it had installed. Reading `binary` unguarded threw
`Cannot read properties of undefined` out of `fetch()` on the refusal path of a half-migrated site,
which is a request that had been answering correctly before any of this was added.

**CRON WAS THE FIRST HYPOTHESIS AND THE MEASUREMENT REFUTED IT.** Both resets landed on an alarm
whose logs were full of the update module's deferred fetches, which reads as a cause and is not one:
a sweep of 16 firings moves linear memory by nothing at all, on a cold interpreter and on a hot one.

`recycleIfOversized()` drops the interpreter at the end of an invocation once linear memory reaches
`RECYCLE_ABOVE_BYTES`, default 117,440,512 (112 MiB) -- above the serving plateau of 108.50 and below
the first over-large rung, so a serving object never recycles and one that has just installed always
does. It runs BETWEEN invocations because the old module's memory is reclaimed only once it is
collected. Measured after: the ladder above ends at 96.00 and stays there.

**A FILL BATCH IS N WORKLOADS IN ONE INVOCATION, so the recycle cannot reach it.** The batch was
bounded by page count and nothing else -- the wall-clock guard cannot bind, because the clock does
not advance across a synchronous `php._run()`. On paid, where `fillBatchSize` is 25, the first
authenticated render on each of four freshly provisioned sites reset the object: cpuTime
2,213-4,944 ms, `outcome: exception`, no message and no stack, followed by the
`Internal error in Durable Object storage caused object to be reset` cascade on every route of that
site. The batch now carries a third budget and ends early on the same threshold, which hands the drop
to the recycle at the bottom of the alarm.

`tests/integration/interpreter-recycle.spec.ts` carries all four properties, the cron control
included. Each was checked against a build with the guard removed.

`getHeapMax()` returns 4,294,901,760, so the module declares no maximum: the 128 MiB ceiling is
workerd's, enforced by `grow()` throwing. Emscripten catches that and retries with `cutDown = 1,2,4`,
so a growth from the shipping peak degrades rather than aborting.

**`memory_limit` is not enforced.** `USE_ZEND_ALLOC=0` is baked into the binary by upstream php-wasm,
and three symptoms follow from that one flag: `memory_get_usage()` reads 0, the cycle collector never
runs (`gc_status()` reports `runs: 0`), and an 8M cap holds 38 MB with no error. The consequence is
availability rather than accounting: a runaway allocation does not stop at a catchable fatal that
loses one request, it grows linear memory to the ceiling and takes the whole object with every
session on it. `tests/integration/php-allocator.spec.ts` pins all three.

**Heap restore requires reproducing the open file-descriptor table at the same fd numbers.** Inode
alignment does not matter. Dropping `/dev/urandom`'s fd throws `RandomException`; dropping the three
sqlite fds gives a locking-protocol error after an 80-120 s stall, which on the edge is a hung
request.

### Bundle Size

The free ceiling is **3,145,728 bytes measured after Cloudflare's own gzip**. gzip cannot compress
what is already compressed, which is the entire mechanism behind shipping the interpreter as a
compressed frame in a `Data` module: it saved 997,878 bytes in one change, more than four times what
an entire extension-removal programme achieved.

**The frame is BROTLI and the inflate is `node:zlib`, as of 2026-08-30.** Both halves are one change
and the second is what made the first possible. `node:zlib` carries brotli and zstd, and workerd runs
either synchronously at module scope -- which is the only place they can be used, since wasm codegen
is forbidden at request time. Probed on the shipping workerd against both frames of the same binary:
2,671,745 zstd and 2,485,488 brotli, each inflating to the same 12,234,575 bytes, **byte for byte
identical**, 4,118 exports. Measured on `wrangler deploy --dry-run`, the pair moved the bundle from
**2,981,406 to 2,775,429 gzipped bytes, -205,977**, in three parts: the better frame, the 25,473-byte
`zstddec.wasm` that no longer ships, and `fzstd` plus cartridge's inflate helper going with it. A
full Drupal 11 page was rendered from the result on local workerd.

`lgwin` is 22 rather than 24, which costs 18,738 bytes and asks the decoder for a 4 MiB ring buffer
instead of 16 MiB. The frame inflates at module scope inside a 128 MiB isolate, and this project's
repeated production failure is that ceiling rather than the bundle one. Revisit only with a
measurement of module-scope peak on a deployed object. Measured and rejected: `lgwin` 20 costs 95,244
more; `large_window` 30 is 3 bytes worse than 24.

**Brotli costs startup time, and the bundle bytes it buys are worth more here.** Three inflate arms on the same
12,234,575-byte binary, interleaved, n=25, on node -- a PROXY, because `Date.now()` does not advance
inside a Worker isolate and the in-isolate probe read 0 for every arm:

| arm                                    |     min |  median |     max |
| -------------------------------------- | ------: | ------: | ------: |
| wasm-zstd, the previous shipping path   | 17.7 ms | 18.6 ms | 47.6 ms |
| native-zstd, `node:zlib`                | 11.2 ms | 12.4 ms | 27.2 ms |
| native-brotli, shipping                 | 27.5 ms | 28.8 ms | 35.2 ms |

So brotli is **+10.2 ms against what shipped before** and **+16.4 ms against native zstd**, which was
available for free once `node:zlib` turned out to work at module scope. **The same mechanism produces
both effects**: brotli's context modelling is what buys the smaller frame and what costs the decode.

**THE METER IS ISOLATE STARTUP, NOT COLD BOOT, and confusing the two overstates the headroom by an
order of magnitude in the flattering direction.** This inflate runs at module scope, so it is charged
to `Worker Startup Time`, not to the 1,398 ms figure -- which is a different meter, PHP's boot plus
Drupal's bootstrap, charged per invocation on a cold OBJECT, and one the warm and shell levers
already took from 3,525 ms to ~467 ms with boot at 0. An earlier draft divided by 1,398 and called
the cost 0.7%.

**AND ON THE EDGE THE DIFFERENCE IS NOT MEASURABLE.** Deployed to a throwaway on 2026-08-30, the two
seams alternated so Cloudflare-side drift hits both arms, `Worker Startup Time` read off each
deploy, n=9 each:

| arm           | min |    median |     max |  mean |
| ------------- | --: | --------: | ------: | ----: |
| native-brotli |  89 |   108 ms  |  117 ms | 107.8 |
| native-zstd   |  92 |   102 ms  |  142 ms | 107.8 |

Identical means. The pooled SD is 13.3 ms, so the 95% interval on the difference of means is about
+/-12.3 ms and the node proxy's predicted +10.2 ms sits inside it. **The proxy did not transfer, and
the reason is that it measured a minority of the thing that matters**: the inflate is one step of a
startup dominated by `new WebAssembly.Module` compiling 12,234,575 bytes, and a 10 ms difference in
the first is invisible against noise wider than the effect.

So the claim is NOT "brotli is free". It is that any cost is smaller than this instrument resolves at
n=9, against a saving of 205,977 bytes that is exact. Resolving 10 ms here needs roughly an order of
magnitude more deploys, and nothing turns on the answer.

Isolate startup is also the RAREST of the three paths -- an isolate outlives an object incarnation,
which outlives a request -- so this is the cost paid least often of anything measured here.

**AN EARLIER READING SAID "essentially a wash" AND WAS TAKEN UNDER LOAD**, with the full vitest gate
running; every arm was inflated about 3.5x and their order survived but their differences did not.
Measure an inflate on an idle machine.

---

### ZEND_VM_KIND=TAILCALL: 10.6% On The Bench, 0% On A Render

Measured 2026-08-30 against long64, in the three layers a VM change has to be scored in separately,
because they are not the same workload and only one of them is the product.

**Layer 1, VM-bound synthetic PHP.** `scripts/measure/abi-speed.ts`, n=25 interleaved rounds with the
arms rotating which leads, on node/V8. Blended geometric mean **0.894x**, against a control
(`--abis=wasm32,wasm32`) that read **0.985x on the same machine the same night** -- so the effect is
about 7x the resolution. What makes it credible is not the margin but that **it sorts itself by
mechanism**: the VM-bound cases move hardest and the C-library-bound cases do not move at all.

| case                    | ratio      | what it probes                    |
| ----------------------- | ---------- | --------------------------------- |
| `intmath`               | **0.686x** | zend_long arithmetic              |
| `packed`                | 0.768x     | packed array, zval only           |
| `usercall`              | 0.827x     | VM dispatch and stack frames      |
| `hashread`              | 0.881x     | Bucket lookup                     |
| `preg` / `json` / `sort` | ~1.00x    | pcre and C library, VM-independent |
| `compile`               | 1.110x     | the binary is 986,294 bytes bigger |

**Layer 3, a real Drupal render.** Local workerd, unique query per request so `cfw_page` cannot
answer, `x-cfw-cache: RENDER` asserted on the responses, n=20 per arm:

| arm        | min     | p50         | p95     |
| ---------- | ------- | ----------- | ------- |
| long64     | 42.9 ms | **48.0 ms** | 61.0 ms |
| vmtailcall | 42.9 ms | **48.0 ms** | 60.7 ms |

**Identical p50 and identical minimum.** The minimum is the least noisy statistic available and the
one a 10% gain moves first; it did not move at all.

**THAT INSTRUMENT IS DILUTED AND THE NEGATIVE IS WEAKER THAN IT LOOKS.** The figure is a curl wall
clock, and a matched measurement on 2026-08-30 put the RENDER at 23 ms while curl total was ~70 ms on
the same request -- local `wrangler dev` HTTP, the front worker and the edge-cache layer are the
rest, and a static asset with no PHP at all costs 4.5-13.1 ms through the same server. So roughly
half to two thirds of what was timed here is not PHP. A 10% gain on the render portion is ~2 ms on a
48 ms reading against a 42.9-64.9 spread, which this n=20 cannot resolve. The honest statement is
**no effect detectable at a diluted instrument**, not 0%. Re-run it against `/__assemble`'s PHP-side
`renderMs`, which reports the render alone; until then the decision not to ship rests on the bundle
cost and on the absence of a VM-bound workload, not on a proven render null.

**Layer 0, the artifact itself.** Neither of the above means anything if the arm is not what its name
says, and this repository has been burned by exactly that. Instruction-column census over the full
disassembly, `wasm-objdump -d` piped through an awk extraction of the mnemonic column:

| binary     | disassembled lines | `call` | `call_indirect` | `return_call` | `return_call_indirect` |
| ---------- | -----------------: | -----: | --------------: | ------------: | ---------------------: |
| long64     |          3,850,451 | 82,200 |           5,827 |         **0** |                  **0** |
| vmtailcall |          4,256,429 | 87,273 |           6,109 |       **553** |              **1,700** |

2,253 tail-call instructions present in one artifact and structurally absent from the other, so the
lowering is real and the arms are what they claim. **A loose `grep -c` for the mnemonic reads 957 or
1,700 or 2,253 depending on whether it matches the operand column and whether
`return_call_indirect` is counted as a `return_call`** -- the awk column extraction is the one to
copy.

**Both binaries are PHP 8.5.2**, read out of the artifacts with `strings`, not from a build label.
That matters for how far this result travels: upstream shipped TAILCALL interrupt fixes in 8.5.7 and
8.5.8, so the VM measured here is an early revision of the implementation. The fixes are correctness
rather than throughput, so they do not undermine the layer-3 negative, and a later patch level is the
first thing to change before re-running any of this.

**So the mechanism is closed and the objective is not.** TAILCALL does make the Zend VM faster
and a Drupal render is not VM-dispatch-bound -- it is bound by pcre, by the host bridge, and by
container construction, which are exactly the cases that read 1.00x above. Paying 27,904 bytes for a
speedup this workload cannot use is the wrong trade at any headroom. **Revisit it the moment a
VM-bound workload exists** -- a long-running cron computation, a large migration, anything that is
PHP arithmetic rather than template assembly -- because for those the 31% on `intmath` is real.

One caveat on layer 3 that would have to fall before the negative is final: the client wall clock
includes workerd and HTTP overhead this did not separate, so a small gain could be diluted below
detection. That is the same dilution that hid the brotli inflate inside module compilation. It does
not rescue the trade, because a gain too small to see is also too small to buy.

Consequences for a size proposal:

- Do not reason about the ceiling from a `gzip` figure on a `.wasm`. The relevant compressor is the
  one the frame actually uses and the authority is what `wrangler deploy` prints.
- **PHP 8.4 costs 49,220 MORE compressed bytes than 8.5** while being 357,323 smaller raw, because
  its data section is both larger and less compressible (0.370 against 0.331; the code sections
  compress identically).
- **`ZEND_VM_KIND=SWITCH` costs +129,760 gzipped bytes -- SUSPECT, priced by the instrument the line
  above warns against.** It is a `gzip` figure on a `.wasm`, not a wrangler bundle figure. The same
  mistake priced `ZEND_VM_KIND=TAILCALL` at +173,884 by gzip against **+20,549** measured on the
  shipping path, an error of 8.5x in the direction that refuses a change. Re-measure before quoting.
- **`ZEND_VM_KIND=TAILCALL` costs +27,904 bytes** on the brotli bundle, re-measured 2026-08-30:
  2,737.74 KiB against 2,710.49. The earlier +20,549 was priced on the zstd tree. The artifact carries
  2,253 `return_call` and 1,700 `return_call_indirect` against 0 in long64, so the VM really does
  dispatch through tail calls. **It is 10.6% faster on VM-bound synthetic PHP and 0% faster on a
  Drupal render** -- see below. Not shipped.
- Dropping extensions buys bytes that are not scarce, while costing capability and needing shims. The
  inflate half of that argument is gone rather than merely weak: there is no bundled decoder left to
  amortise, because `node:zlib` does the work.
- The glue's export trampolines are collapsed, worth 47,093 gz. Emscripten emits a self-rebinding
  wrapper per wasm export -- 2,466 of them, 472,712 raw bytes -- and only `_main` is read back by the
  glue. One lazy binder installed inside `receiveInstance` replaces the rest; that is the first point
  the export table exists, which is why emscripten uses trampolines at all.
- The largest untaken lever is the embedded PHP: 76 `String.raw` blocks across 18 files, 249,168
  source bytes, of which 217,274 survive minification into the bundle. Both routes are measured on
  `wrangler deploy --dry-run`: stripping comment lines at build time is **-26,501**, and moving the
  source out to the asset layer is **-64,143** and supersedes it. Neither is taken -- the ceiling has
  room and the stripper has a real hazard, since a `//` inside a PHP string is a URL and not a
  comment, so it must be line-anchored and gated on `php -l`.
- **Static assets are already carrying what they can, and executables cannot join them.** At request
  time `new WebAssembly.Module()` and `WebAssembly.compile()` both answer
  `Wasm code generation disallowed by embedder`; at module scope any async I/O answers
  `Disallowed operation called within global scope`. There is no moment where fetched bytes and wasm
  codegen are both permitted, so the interpreter cannot live outside the bundle. `driver.json`
  (528,793 bytes), `prefill.json`, `drupal-pf/` and `drupal-sql/` are already assets and already
  outside it; asset requests are free and unlimited but spend one of the 50 subrequests a free
  request gets.

`bunx wrangler deploy --dry-run --outdir=<tmp>` proves an entrypoint and its binary alias resolve
without deploying.

---

### Worker Startup

| limit | value |
| --- | --- |
| global-scope CPU | **1 second** (raised from 400 ms on 2025-10-10) |
| global-scope memory | **128 MB** |
| what exceeding it does | rejects the DEPLOY with error 10021, not a runtime failure |

`wrangler check startup` on the shipping config: **104.0 ms active** of that budget, bundle 2,904 KiB
gzip. The zstd inflate and the `WebAssembly.Module` compile are what spends it.

This closes the "pre-warm at startup" idea. PHP's boot is 1,398 ms of `cpuTime` against a 1,000 ms
ceiling, and its heap peaks near 115 MB against 128 MB, so the interpreter cannot be booted at module
scope at any price. The headroom that does exist is for cheap work, and nothing cheap has been named.

**It does NOT close pre-warming as an objective, and the two were conflated.** Booting at STARTUP is
refused by the numbers above. Keeping an object that has already booted RESIDENT is a different
mechanism with a different meter, and it works: measured on a deployed worker, an object re-armed
every 8 s kept one incarnation across 71 consecutive alarms while holding a 32 MB allocation, and at
12, 20, 30 and 45 s the constructor ran again on every probe. See "Warming and the 10-Second
Threshold".

### Requests That Never Reach the Worker

Two paths, and only two, cost nothing against the 100,000/day serving ceiling:

- **Static assets.** `run_worker_first` defaults to `false`, so a request matching a file in the
  assets directory is served without invoking the Worker, and Cloudflare bills those at zero. The
  serving ceiling is therefore ~100,000 page views rather than 100,000 divided by the asset count.
- **A hostname not routed to the Worker at all**, which is what an R2 custom domain is.

A zone Cache Rule is NOT one of them: a Worker route runs the Worker before the cache is consulted.
The Workers Caching feature does skip the Worker on a hit, but bills the request anyway -- and its
cache key omits the host, which for a host serving many sites at `/` is a cross-tenant leak rather
than a saving. `tests/node/cache-partition.spec.ts` refuses it in a shipping config.

## Measured Costs

### Boot

Boot is one synchronous `php._run()`. No cursor design cuts it up; it needs a JSPI build or a
permanently warm object, and **the warm object is now the one that exists** - see "Warming and the
10-Second Threshold".

**WHY IT CANNOT BE SPLIT**, because "run it in slices" is the first thing anyone proposes. `_run()`
enters wasm and the wasm stack runs to completion. A wasm module compiled `ASYNCIFY=0` has no
suspension point in it, so there is nothing for a cursor to resume FROM: the JavaScript event loop
cannot interrupt a synchronous wasm call, and PHP's own execution has no yield primitive the host can
reach. Every other sliced thing here - the migration, `updb`, the cron chain - is divisible because
the DIVISION IS IN THE HOST: each unit is a separate `_run()` with its state in SQL between them. A
boot has no such seam, because the thing being built IS the in-memory state.

The two mechanisms that would add a seam are the two named above. JSPI compiles in real suspension
points, and was researched and closed: zero of 62 surveyed modules needs one, and `WITH_OPENSSL=0`
means it could not have fixed the module that motivated it. A warm object removes the need for a seam
instead of adding one, which is why it is the answer that shipped.

The phase ladder below is a **different workload from the 1,398 ms** and must not be subtracted from
it. It is a first-ever fill on a fresh site, which builds and writes `cache_container`,
`cache_discovery`, `cache_bootstrap` and `cache_routes`; the 1,398 ms is a re-boot on a site whose
bins are already warm. Both are real, they are measured on the same instrument, and neither
decomposes the other. `kernel-boot` reading 4.5x the whole cold boot is what that difference looks
like.

| phase | edge cpuTime, min/med/max |
| --- | --- |
| interpreter up, no PHP | 402 / **484** / 695 |
| autoload | 481 / 795 / 930 |
| kernel-new | 557 / 639 / 940 |
| container-read | 625 / 788 / 1,049 |
| container-unserialize | 739 / 1,027 / 1,112 |
| kernel-boot | 5,839 / **6,246** / 6,632 |
| pre-handle | 3,371 / 3,923 / 6,277 |
| render | 5,489 / 9,525 / 11,093 |

Cumulative, n=3, phase order rotated per sweep. The ladder is not monotonic at that n, so the
sub-second marginals are noise. What survives is that `kernel-boot` dominates everything before it,
and that is Drupal building its service container and module handler: not I/O, not the pack, not the
interpreter. It would cost the same on any host that could not keep a process alive between
requests. PHP-FPM keeps one alive, and that is the whole difference.

**The per-object instantiate is 484 ms**, which is the figure a heap-restore or always-warm proposal
is scored against.

**These figures predate the `cache_container` fix and the first-ever boot has since moved.** The
packed row was keyed to a stale `DrupalInstalled::VERSIONS_HASH`, so every site's first kernel boot
missed and rebuilt a 482 KB container. Measured on deployed paid workers, a new site per
sample, n=8 paired: 32.4% of a first-ever boot in fast mode (4,269.5 -> 2,888 ms) and 36.3% in slow
mode (9,210.5 -> 5,867.5 ms). The re-boot path the 1,398 ms measures is unaffected, because a warm
site already held its own built row.

**Boot work is saturated FOR THE REGENERATION CEILING.** Once the fill window amortises the boot,
that ceiling is bound by rows written, so a 20x reduction in boot cost per fill moves it about **1%**.
Rows work first, and that is a statement about the CEILING.

**It is not a statement about latency, and reading it as one closed the wrong thing.** A visitor
waiting on a page that must render pays the whole 1,398 ms, and no row budget is involved. That is
what warming removes.

### Warming and the 10-Second Threshold

Cloudflare hibernates an idle Durable Object after **10 seconds** and hibernation discards in-memory
state, so `this.php` dies there. Measured on a deployed worker, with an object minting an id in its
constructor and holding a 32 MB allocation so a changed id is a lost isolate rather than a proxy for
one:

| re-arm interval | result |
| --- | --- |
| none | id changed across a 20 s gap, the shortest tested |
| **8 s** | **one incarnation across 71 consecutive alarms, 32 MB intact** |
| 12 / 20 / 30 / 45 s | id changed on every probe; `alarmsSeen` never passed 1 |

`KEEP_WARM_MS` shipped at 240,000, 24x the threshold, so nothing it governed was ever kept warm. Two
places in this codebase had promoted "an armed alarm buys no warmth" into a general fact; it is true
at 240 s and false at 8 s, because the FIRING resets the idle clock. Arming does not warm. Firing
under the threshold does.

**Duration is not the meter, and ROWS are.** An object waiting on an armed alarm is idle and ELIGIBLE
to hibernate, and an idle-eligible object is not billed for duration. Measured on a deployed worker,
n=116 firings across two objects, torn down afterwards:

| meter | per firing | per day at 8 s | free budget | share |
| --- | ---: | ---: | ---: | ---: |
| DO requests | 1 | 10,800 | 100,000 | 10.8% |
| rows, as measured | 3 | 32,400 | 100,000 | 32.4% |
| **rows, after the fix** | **1** | **13,680** | 100,000 | **13.7%** |
| wall time | 23.3 ms | 252 s | -- | -- |
| duration | 2.9e-3 GB-s | 31.4 GB-s | 13,000 | 0.24% |

**This paragraph said "one request and one row per firing", and the row half was wrong.** It was
reasoned from the published "a `setAlarm()` is one row written" rather than measured, and
`FREE_QUOTAS.rowsPerAlarmArm` carried the same 1. A firing charged THREE: the `setAlarm`, plus one
row each for `flushDailyRows()` and `flushDailyDoRequests()`. **Two thirds of a warming tick's row
cost was the daily meters recording their own writes** -- on an idle tick there is nothing else for
them to record, so the counter sustained itself and was most of what it counted.

`shouldFlushMeters()` now gates both on a 60 s interval or 25 pending rows, so an idle tick charges
the `setAlarm` alone and the two meter rows are amortised across 7.5 firings: 10,800 + 1,440 x 2 =
13,680 a day. `tests/integration/warm-alarm-cost.spec.ts` pins the per-tick count at exactly 1.

The model had to grow a second term for this. Folding the flush into a per-arm constant is wrong at
every interval except the one it was derived at, and the flush is additionally capped by the FIRINGS
-- an object waking every 240 s cannot flush every 60 s, and without the cap the model charged a
240 s chain for 1,440 flushes it never performs. `saturatingSites` moved with it, from 277 to **92**:
it divided the quota by arms per site, and rows per site is no longer the same number.

The two arms differed by one SQL insert and billed 23.34 ms against 23.14 ms, so the cost is the
firing rather than the work.

$0 marginal on paid, where 328,752 alarms a month sit inside 1,000,000 included object requests.
Free's quotas are account-wide, so a site that spends its daily meter drops back to the slow re-arm
on its own and recovers at midnight UTC.

**What it is worth, per page class.** A cached page answers off `ctx.storage.sql` without booting
PHP, so warming cannot make one faster by any amount. The tier that always renders is the
authenticated one, because a session-carrying response is never stored in the anonymous bin:

| authenticated page | boot | render | total |
| --- | ---: | ---: | ---: |
| neither lever | 1,398 ms | 2,127 ms | 3,525 ms |
| warm only | 0 | 2,127 ms | 2,127 ms |
| shell assembly only | 1,398 ms | ~467 ms | ~1,865 ms |
| both | 0 | ~467 ms | **~467 ms** |

The boot column is a measured subtraction. **The render column is derived across instruments** and is
the softer half: a fragment render measured 4-5 ms of gate-lane wall clock against 20-21 ms for the
render it replaces, and applying that ratio to an edge `cpuTime` figure assumes it transfers.

### Writes

Deployed, the shipping config, n=8 per class, one object per class, each provisioned and warmed
before the measured sequence. Rows and bytes are exact per call; CPU is per-invocation `cpuTime`.

| op | charged rows (min/med/max) | statements | replays | cpuTime ms (min/med/max) |
| --- | --- | --- | --- | --- |
| node-create | 103 / 103 / 108 | 34 | 4 | 18 / **23** / 1,868 |
| node-revision | 218 / 218 / 226 | 78 | 9 | 51 / **78** / 1,673 |
| user-create | 33 / 33 / 37 | 16 | 3 | 510 / **578** / 1,212 |
| file-create | 14 / 14 / 18 | 7 | 1 | 10 / **14** / 861 |
| alias-create | 41 / 41 / 57 | 19 | 2 | 18 / **26** / 1,198 |
| txn-autoinc | 2 / 2 / 2 | 3 | 0 | 3 / **3** / 644 |
| txn-rowid | 1 / 1 / 1 | 2 | 0 | 5 / **6** / 997 |

**A user create is 578 ms and 25x a node create on CPU while writing a fifth of the rows.** That is
the password hash, and it makes an account-creation burst a CPU problem where every other write here
is a rows problem.

**The max column is a cold boot on every row.** The first call after an object goes cold pays the
boot; reporting a mean would fold a 1.4 s boot into a 23 ms write.

### Rows Per Fill

There is no single figure. A fill is **2 / 12 / 19 / 24 / 156 rows** depending on what is already
warm, and `ROWS_PER_FILL` in `scripts/measure/free-envelope.ts` names all five classes; the model
defaults to `realRender: 12`. Every figure is counted at the storage handle, so it includes the
host's own writes -- notably the `cfw_page` insert that stores the whole rendered page.
`tests/integration/rows-per-fill-audit.spec.ts` re-measures each class and pins it; three consecutive
runs read identical counts, so these are exact charges rather than noisy readings.

Two of those classes were wrong until 2026-08-28. `firstEverForPath` stood at 62 and measures 24, and
the most expensive case had no class at all: the FIRST fill on a fresh object costs **156**, because
`cache_discovery`, `cache_default` and `cache_routes` are populated once per OBJECT rather than once
per path. Charging every new path the fresh-object figure overstates a fleet six-fold; leaving it out
understates each new site by one 156-row event.

**The serve tables are `WITHOUT ROWID`, which is worth a row per fill.** SQLite gives a rowid table's
`TEXT PRIMARY KEY` its own unique index, so one logical write is charged twice. Measured on
`ctx.storage.sql`: insert 2 -> 1, update 1 either way, the serve HIT still reads one row, and 200
rows of 12 KB html cost +0.32% on disk. The cheapest class benefits most -- `warmReassemble` went
3 -> 2 rows, its index charge to zero -- and the windowed regeneration ceiling moved 7,575 -> 8,196.

**THE SAME SHAPE WAS WORTH MORE ON DRUPAL'S OWN CACHE BINS.** Every bin `DatabaseBackend` creates
keys on a TEXT `cid`, and `scripts/measure/index-audit.ts` reports 13 of the 14 with NO secondary
index at all -- so the autoindex WAS their entire index cost. `scripts/pack-sql.ts` now emits the 14
bins `WITHOUT ROWID`, and `Schema::createTableSql()` in the `cfw_do_sqlite` driver does the same for
a bin a module adds at runtime, which the packer never sees. Verified through Drupal's own installer.
Measured on a steady-state render at **8 charged rows -> 6**, bins' index
charge **3 -> 0**, n=3 with zero spread. Every warmth class fell with it: `firstFillOnFreshObject`
156 -> **103**, `firstEverForPath` 24 -> **14**, `realRender` 12 -> **9**, and `warmReassemble`
alone unchanged at 2 because it writes only `cfw_page`. The windowed regeneration ceiling moved
**8,196 -> 10,869/day**.

Two things that were nearly reported wrong here. A first pass read 11 -> 6 and **3 of those 5 rows
were warmth, not the conversion**: one warming render leaves `cache_menu` and `cache_discovery` cold,
so they are written in the control arm and not in the treatment arm. Both arms need the same warmth
before the comparison means anything. And `index-audit.ts` does not model `WITHOUT ROWID` at all, so
it reports "the floor in this schema is 2x" and "factor 1.0 (nothing to win): NO TABLE" -- both are
statements about the instrument rather than the schema, and the second one would have closed this
lever outright.

Two things that look like levers and are not. **Zero rows of a fill go to `watchdog`**, so
uninstalling `dblog` buys nothing. And past ~85% off-Worker serving the binding meter becomes DO
requests rather than rows, so trimming rows beyond that point moves a meter the ceiling no longer
responds to.

`fillOne()` used to empty `dynamic_page_cache` on itself, measured at 4 charged rows against 0 with
the output byte-identical. Staleness was never the failure mode: tag invalidation reaches a warm
entry through its checksum.

### Duration Per Operation

`durableObjectsPeriodicGroups` carries `duration`, `activeTime`, `cpuTime`, `rowsRead`, `rowsWritten`
and `exceededMemoryErrors`, dimensioned by `objectId` and `name`. `activeTime` is microseconds of
wall clock, `duration` is GB-s, and `DO_GB_ALLOCATED = 0.128`. Ingestion lags ~8 minutes.

| class | GB-s/op | wall clock | rows/op | active/cpu |
| --- | --- | --- | --- | --- |
| first migration | 0.322641 | 2,520.6 ms | 3,952.0 | 14x |
| render, 3 bins emptied | 0.309374 | 2,417.0 ms | 82.8 | **1x** |
| render, page bin emptied | 0.158422 | 1,237.7 ms | 31.2 | **1x** |
| stored page | 0.002868 | 22.4 ms | 1.0 | 20x |
| node save | 0.340949 | 2,663.7 ms | 306.0 | **1x** |
| cron run | 0.002017 | 15.8 ms | 0.0 | 16x |
| invalidate + refill | 0.190584 | 1,488.9 ms | 89.8 | **1x** |

**`cpuTime` is a lower bound on billed duration and the gap is a property of the workload.**
`activeTime / cpuTime` is ~1x on a render, a node save and an invalidate-plus-refill, and 14-20x on a
migration, a stored-page serve and a cron run. Use the class's own ratio or measure it.

There is no wake cost on the serving path.

### Where Render CPU Goes

Measured 2026-08-30 on the SHIPPING interpreter, per render. Route `/node`, `page` +
`dynamic_page_cache` purged per render and the `render` bin warm. Native `php-cli` 8.5.7 n=30; wasm
8.5.2 through `cfw_do_sqlite` and the compiled container, n=60, both at load 3.1-4.3.

| bucket             | native ms/r | wasm ms/r |  measured | previously published | calls/r nat / wasm |
| ------------------ | ----------: | --------: | --------: | -------------------: | ------------------ |
| renderer           |       0.983 |     5.750 |  **5.85x** |             *1.6x*  | 34 / 34            |
| events             |       0.939 |     4.867 |     5.18x |             *4.3x*  | 7 / 7              |
| `cache_contexts`   |       0.498 |     2.750 |     5.52x |             *5.8x*  | 113 / 127          |
| `render_cache.get` |       0.344 |     2.342 |     6.81x |                   - | 6 / 6              |
| **assets.resolve** |       0.102 |     2.042 | **20.02x** |                   - | 3 / 3              |
| theme              |       0.407 |     1.517 |     3.73x |                   - | 14 / 14            |
| `twig.execute`     |       0.251 |     0.733 |     2.92x |                   - | 14 / 14            |
| attachments        |       0.085 |     0.925 |    10.88x |                   - | 1 / 1              |
| access             |       0.036 |     0.183 |     5.09x |                   - | 2 / 2              |
| residual           |       0.358 |     2.292 |     6.40x |                   - |                    |
| **total**          |   **4.003** | **23.400** | **5.85x** |                      |                    |

**THE TABLE ABOVE WAS MEASURED WITH THE SHIPPED CACHE-CONTEXT MEMO DISABLED BY THE PROBE ITSELF.**
`pw_install_probes()` swaps in a subclass derived from core's `CacheContextsManager`, which silently
removes `Drupal\drupflare\Cache\MemoizedCacheContextsManager` -- the same container-swap-measures-the-
wrong-object failure this document already records for the router and the census. Corrected by an A/B
on uninstrumented `renderMs` with no decorator on that service: **the memo is worth 1.85 ms/render,
7.7%** in wasm, against 9.7% recorded natively. So the shipping baseline is **22.58 ms, not 23.400**,
and the whole-render gap is **5.64x, not 5.85x**. The `cache_contexts` row above is the UN-memoized
cost and must not be quoted as what ships.

**THE RENDERER IS NOT 1.6x. IT IS 5.85x, AND IT IS THE LARGEST BUCKET ON BOTH SIDES.** The old figure
was wrong by a factor of 3.7 and it is the number the whole "the renderer is nearly native, so attack
the plumbing" framing rested on. That framing is retired: **everything is 3-6x except
`assets.resolve` at 20x**, which is the only structural outlier in the system. Call counts agree
bucket for bucket, so this is the same page rendered the same way; only the interpreter and the
driver differ.

The old numbers were wrong because **they were measured on a binary that does not ship, and nothing
said so.** `pw_bench_breakdown()` was reachable only through `src/probes/min.ts`, pinned to the 8.3
`vendor/static-free-v1` interpreter and to `drupal-min` / `drupal-std` packs that
`assets/.assetsignore` does not publish. Same class as the gate running 8.3 for the life of the
project while production ran 8.5: an instrument pinned to an experiment arm, invisible because every
dev machine has the arm. The 8.3 route cannot be revived either -- the shipping binary reports
`pdo_sqlite: false`, so core's `sqlite` driver fatals and the only reachable database is
`cfw_do_sqlite` over the host bridge, which needs a real Durable Object. The replacement instrument is
a scratch DO subclassing `SitePhpDurableObject` and wrapping the real `fillOne()` path.

Three things that instrument had to get right, each of which failed first and each of which would
have produced a confident wrong table: the interpreter is recycled between invocations, so boot,
probe load, decorator install and all N renders must happen inside ONE `fetch()`; `Request::create()`
does not reach the DO router and answers 302 to the installer, so renders go through `fillOne()`; and
decorators installed AFTER a render report every service `preexisting` and attribute 1 ms of 1,484
rather than 1,291 of 1,433. workerd's clock is 1 ms granular (`minStepMs` 0.999928), so every figure
above is a tick count over 60 renders.

**A matched pair on 2026-08-30 puts the whole-render gap at 4.4x**, not the 8.5x an earlier reading
gave: 23 ms wasm `renderMs` from `/__assemble?bins=page,dynamic_page_cache` against 5.20 ms native
from `bench-render-breakdown.php` purging the same two bins, both on one machine. The 8.5x was a curl
wall clock against an in-process native render and it double-counted local HTTP, the front worker and
the edge-cache layer.

Two readings from that sweep that survive the provenance problem, because they are wasm-vs-wasm and
native-vs-native increments rather than cross-binary multipliers:

- **Emptying the `render` bin costs native +11.0 ms and wasm +22 ms, so pure extra rendering is
  2.0x.** The renderer is the best-behaved part of the system.
- **A `dynamic_page_cache` HIT that renders nothing still costs 13 ms and 6 host statements.** That
  fixed floor, not the rendering, is where the multiplier lives, and it is the thing to attribute
  next.

**THE ONE MEASURED LEVER SO FAR: CSS/JS AGGREGATION, -3.2 ms/render, 14.3%.** `system.performance`
ships `css.preprocess` and `js.preprocess` at `false`, which is Drupal's installer default and gives
60 `<link>` + 11 `<script>` against 9 + 2, and 17,779 bytes against 12,304. Bracketed in both arm
orders with no probe decorators, n=40 per arm: median 21 -> 18, minimum 19 -> 16, p25 20.3 -> 17.7,
and the ON arm wins in both orders. It also removes ~5,400 bytes from every stored `cfw_page` row.
**AND IT IS UNSHIPPABLE. The saving is real and the page it produces has no CSS and no JavaScript.**
The route is fine: `AssetControllerBase::deliver()` preserves the whole query string through its
redirect, the `include` parameter decodes to six real libraries, and the aggregate answers
`200 text/css`. It answers 69 bytes, the licence header alone, because **the source files do not
exist**: 0 of 12 sampled CSS files are readable in MEMFS, and the per-file pack cannot supply them
either --

| ext      | entries in `assets/drupal-pf/core.pf.json` |
| -------- | -----------------------------------------: |
| `.php`   |                                      8,162 |
| `.yml`   |                                      1,401 |
| `.twig`  |                                        945 |
| **`.css`** |                                     **13** |
| **`.js`**  |                                      **0** |

The exclusion is correct and documented: the packs skip `.css`/`.js` because PHP never opens them and
the asset layer answers `/core/**` for the browser. **Aggregation is the one feature that makes PHP
open all of them.** So `optimizeGroup()` concatenates nothing. The -3.2 ms is the measured cost of
NOT resolving 60 files into the head, and collecting it means putting ~600 CSS and ~200 JS files into
the pack or the lazy-mount index, paying asset bytes and MEMFS residency inside a 128 MiB isolate.
That is an engineering task to be priced against 3.2 ms, not a config flip.

**And the bin-cache lever this document prices at "bounded at 4.4%" is worth approximately zero as
described.** That bound was computed from NATIVE SQLite query time, 0.249 ms of 5.676 ms at 0.0062 ms
a query. The quantity that binds in wasm is the bridge CROSSING, not the read behind it: 11 cache
reads x 0.074 ms is 0.81 ms, 3.5%, which lands near the old number by coincidence. But a HOST-side
cache cannot collect it -- PHP still calls `cache->get()` and still crosses the bridge to ask. Proved
independently: removing 30 host SQL statements per render, 60% of all host SQL, moved the render by
nothing across bracketed arm orders. **The 0.81 ms is collectable only by a PHP-side, CROSS-REQUEST
memo**, because within-render repeats are 0.0% and across-render repeats are 87.5% over 11 distinct
keys. That split is the resident-interpreter advantage stated precisely, and it carries the
cache-tag invalidation risk this project has already shipped a leak from.

**A CROSS-PATH SHELL IS 80.5% OF THE BYTES AND 3-16% OF THE CPU. The direction is closed.** Anonymous
pages are nearly identical -- censused over six pairs, overlap 85.0-97.8%, median 86.6%, and 14,305
bytes common to all four paths in runs of 120 bytes or more. That reads like a large lever and is
not one. Per-element self-time over 30 renders per path: the shell blocks plus `t:block` are
**1.432 ms of 51, 2.8%**, and even counting the entire `html_tag` head as shell gives **8.199 ms,
16.1%** -- an over-estimate, because per-element probe overhead lands on the numerator. The
arithmetic needs **57.3%**.

The two numbers diverge because **the shell blocks are already in `cache_render`.** They are 80% of
the bytes because they are large chunks of markup, and 3% of the CPU because rendering them is a
cache read and a string concatenation. What costs is the **45.633 ms of non-element pipeline work** --
events, `cache_contexts`, twig, theme, `render_cache`, `assets.resolve` -- which runs once per request
whatever the page contains, and which no shell artifact removes.

**An independent instrument agrees from the opposite direction.** A `dynamic_page_cache` hit reuses
the ENTIRE cached page render array, every shell block included, and still costs 13-14 ms of a 23 ms
render. If the shell were the CPU, reusing all of it would collapse the cost. It does not.

**`RenderCache::getMultiple()` batching is worth ~0.33 ms, because Drupal already batches.** Counted
without a clock: `/node` runs 5.5 single `get()` calls and **1.1 `getMultiple()` calls covering 7.7
items** per render -- `CachedStrategy` already doing it. Collapsing the remaining singles removes 4.5
crossings at 0.074 ms. A third of the noise floor.

**THE NOISE FLOOR, MEASURED ON TWO PROVABLY IDENTICAL ARMS.** A `cache.render` decorator that
intercepted nothing -- `RenderCache::get()` resolves its bin through `variation_cache_factory`, so the
swap could never fire, and the counters read `{served: 0, missed: 0, batches: 0}` -- gave two
identical arms at n=100 each:

| statistic | delta between IDENTICAL arms |
| --------- | ---------------------------: |
| min       |                     **0.00** |
| p25       |                     **0.00** |
| median    |                        -1.00 |
| mean      |                        -0.45 |

**Median and mean drift by up to 1 ms on nothing at all; min and p25 do not.** That is the empirical
basis for reporting minimums, and it means no lever under ~1 ms is measurable on a loaded machine.

**WHY EVERY MEMO LEVER HAS FAILED, in one table.** The repeat shape is a property of the LAYER, not
the subsystem, and there are only two layers:

| layer                                   | within-render repeat | across-render | distinct keys |
| --------------------------------------- | -------------------: | ------------: | ------------: |
| host crossings, cache-bin reads         |    **0.0%** (0 of 88) |         87.5% |            11 |
| host crossings, on a DPC hit            |    **0.0%** (0 of 48) |         87.5% |             6 |
| PHP service, `convertTokensToKeys`      |                99.4% |         ~100% |            15 |
| PHP service, `getLibraryByName`         |                89.4% |         ~100% |            11 |
| PHP service, `getLibrariesToLoad`       |                95.3% |         ~100% |             6 |

A request-scoped memo on a PHP service hits 89-99% and saves nothing, because the repeated call is
already an array lookup -- measured three times, identical minimums each time. A request-scoped memo
on a host crossing is worthless by construction: there is no second call to serve. **Only a
cross-request memo on a host crossing has headroom, and it is 0.81 ms.** Drupal already caches inside
the request; the bridge is crossed once per distinct key. There is no third category to search.

Two hypotheses were refuted with controls on the native side and should not be re-proposed without
new evidence. **Freezing the Symfony listener dispatch table is worth 0.0057 ms/render** -- 7
dispatches resolving 36 listeners, and Symfony already caches the sorted array per event name, so a
precomputed table replaces an array read. **Per-request rebuild is worth 0.0403 ms/render** across
`drupal_static_reset()`, the 13-service `RequestResetter` loop, `Html::resetSeenIds()` and the
response `json_encode`.

**And `events` is not a subsystem that can be optimised.** Inclusive listener invocation measures
6.004 ms on a 5.514 ms render, so essentially the entire render happens inside listeners and the
26.6% above is EXCLUSIVE attribution -- the glue between buckets, not a component. The 4.3x is the
interpreter multiplier on object-graph and hashtable work, which is what wasm is worst at, against
Twig's string concatenation, which is what it is best at. The two numbers agree rather than conflict.

**THAT MULTIPLIER IS NOT A SHARE, AND READING IT AS ONE MISRANKS THE WORK.** It is how much slower
wasm is than native for that bucket. The share of a native steady-state render, measured per bucket
by `scripts/bench/bench-render-breakdown.php` over 5 accumulated renders at 5.676 ms each:

| bucket | ms/render | calls/render | share |
| --- | --- | --- | --- |
| events | 1.512 | 7 | 26.6% |
| renderer | 1.388 | 34 | 24.5% |
| `cache_contexts` | 0.598 | 113 | 10.5% |
| theme | 0.547 | 14 | 9.6% |
| `render_cache.get` | 0.427 | 6 | 7.5% |
| twig.execute | 0.322 | 14 | 5.7% |
| residual | 0.605 | -- | 10.7% |

`events` is 7 calls costing 1.512 ms, so it is the LISTENERS doing work rather than dispatch
overhead; a frozen listener table would return only the resolution part of it.

#### The Cache-Context Memo

`convertTokensToKeys()` is called **51 times over 13 distinct token lists** on a steady-state front
page, so **74.5% of the calls repeat a list already answered in the same request**, and **zero token
lists produced two different answers** -- which is what makes a memo sound rather than merely cheap.
Core recomputes every time: `optimizeTokens()` plus a `getContext()` per surviving token, with
nothing remembering it just did exactly that. The nested `optimizeTokens()` calls fall 51 -> 13 with
it. `bench-context-memo.php` is the instrument; `MemoizedCacheContextsManager` in the `drupflare`
module is the change.

Measured on three interleaved pairs at n=25, native and local: **4.006 ms -> 3.619 ms median, ~9.7%**,
every pair favouring the memo and the rendered body identical at 12,330 bytes in both arms.

**The generation is not just the request, and that is the whole safety argument.** `AccountSwitcher`
changes the current user mid-request and `user.permissions`, `user.roles` and `user` all read from
it, so a request-keyed memo would serve a key computed for the previous account -- the uid-1 leak
shape this project has already shipped once. The generation carries the account id, and
`load-classes.php` asserts a switch invalidates. Removing the account id from the generation makes
that assertion fail with `[probe]=first`, the stale key, which is the falsification.

#### The Recompute Census, And Why A1 Did Not Generalise

A1 removed 74.5% repeated work from one service and took ~9.7% off a render, so the obvious next move
is to look for the same shape elsewhere. `scripts/bench/bench-recompute-census.php` does that: per
method it records calls, DISTINCT argument lists and wall clock, and ranks by repeat rate times cost
rather than by cost -- cost alone ranks the renderer first, and the renderer is doing the work rather
than repeating it. The wrappers are generated from each service's RUNTIME class, because
`language_manager` is `ConfigurableLanguageManager` with the language module and `LanguageManager`
without it.

**The repeat phenomenon is everywhere and it is already cheap.** Of the services the census actually
reached, `language_manager::getLanguage` repeats 91.7% over 12 calls, `entity_type.manager::
getDefinition` 96.0% over 25, `current_user::id` 96.2% over 26 -- and the whole recoverable total is
**0.0556 ms of 3.904 ms, 1.4%**. Those services carry their own static caches, so a repeat costs a
property read. What made `convertTokensToKeys()` worth memoising was not its repeat rate but that
each call did real work: `optimizeTokens()` plus a `getContext()` per token, 113 times.

**AND THE CENSUS LIED UNTIL IT HAD A CONTROL.** Nine of fifteen services were swapped into the
container and never called, because their consumers captured them at construction --
`placeholder_strategy`, `html_response.attachments_processor`, `asset.resolver`, `render_cache`,
`router.route_provider`, `module_handler` and three more. Each recorded nothing, which is
indistinguishable in the output from a service with no repeated work, and all four of the ones added
specifically to chase the placeholder cost were in that set. The census now reports
`swappedButNeverCalled` separately, so a zero is never read as a measurement. This is the second time
in one session that a container swap produced a silent zero; the first was the router.

#### Two Levers Priced And Not Taken

**A DO-local cache in front of the Drupal bins is bounded at 4.4%.** The entire database cost of a
steady-state render is **0.249 ms of 5.676 ms** across 8 queries, so that is the ceiling for any
read-side change to how bins are stored, before any invalidation risk. It does not touch rows
written either, which is the meter that binds; the write-side saving on those bins was already taken
by `WITHOUT ROWID`.

**Route-match memoisation is refused on a mechanism, not on its size.** Route matching is **1 call
per render at 0.138-0.159 ms with ZERO repeats within a request**, so a request-scoped memo saves
nothing by construction and a cross-request one is bounded at 3.8%. The refusal is that
`AccessAwareRouter::matchRequest()` runs the access checks, so memoising its result caches an access
decision across requests. Only the matching below access could be memoised safely, for less than
that 3.8%.

#### Anonymous Specialisation Is Already Built, Three Times

Per-listener timing, which the shared `events` bucket cannot show, on a 4.5 ms steady-state render:

| listener | ms | share |
| --- | --- | --- |
| `kernel.view` :: `MainContentViewSubscriber` | 2.762 | 61% |
| `kernel.response` :: `HtmlResponseSubscriber` | 0.775 | 17% |
| `kernel.response` :: `HtmlResponsePlaceholderStrategySubscriber` | 0.304 | 6.8% |
| `kernel.request` :: `RouterListener` | 0.181 | 4.0% |
| `kernel.response` :: `DynamicPageCacheSubscriber` | 0.069 | 1.5% |
| `kernel.request` :: `AuthenticationSubscriber` (x2) | **0.015** | **0.3%** |
| `MaintenanceModeSubscriber`, `TimeZoneResolver`, `ReplicaKillSwitch` | 0.020 | 0.4% |

**The whole pool a "skip session, auth and user negotiation for anonymous" specialisation would
remove is ~0.035 ms, 0.8% of a render.** It is that small because the host already renders anonymous
fills with NO cookies, so Drupal's session and authentication paths short-circuit on their own.
`kernel.request` in total is 4.3%, and most of that is the router.

The reason there is nothing left to win is that the fast path exists three times over: `page_cache`
is enabled and returns from `kernel.request` before any of the listeners above run, `cfw_page` sits
above it, and the edge cache above that. **The render measured here is the triple-miss path.**
Building a fourth "is this request anonymous?" branch would add a security-relevant check -- the
exact check that has gone wrong here before -- to recover 0.8%.

**The one anonymous-specific target worth its own measurement is the placeholder strategy**, at
**0.304 ms (6.8%)**. `big_pipe` is enabled, and BigPipe only placeholders a session-carrying render,
so on an anonymous fill its per-placeholder negotiation runs and declines every time. Forcing the
single-flush strategy when the host says the fill is anonymous is semantically a no-op there. Not
built; the number is recorded so it can be scored rather than re-guessed.

**Measuring the router took two failed instruments and both failed silently.** Swapping the container
entry after boot throws `ServiceCircularReferenceException` -- `router -> router.no_access_checks ->
router.request_context -> router_listener` -- which is the same cycle `pw-probe.php` documents for
Twig. Swapping it after the first render succeeds and then reads **0 calls**, because
`router_listener` captured the original object when it was built. A count of zero from a probe that
was never reached reads exactly like a router that costs nothing. The listener's reference has to be
rebound by reflection, which is what `pw_probe_twig_in_engine()` already does for the theme engine.

### Install and Module Enable

One router rebuild is **2,095 rows**, and a module enable through Drupal's own `ModuleInstaller`
costs ~20,533 rows of which `router` is 84%. That is about **4 enables per day** on free. Chunking
the rebuild is already done and cannot help: it is a repeat, not a burst.

**The Twig bake is saturated**: six paths bake byte-identically to three, because Drupal's templates
are shared.

### Storage

| item | bytes |
| --- | --- |
| heap snapshot, cold object | 36,175,872 over 552 pages |
| heap snapshot, configured and served once | 9,699,328 over 148 pages |
| seed database | 4,616,192, of which 1,320 of 1,321 rows are identical across sites |
| filesystem in SQLite | **0** |

Cross-site heap dedup is **34.7-38.0%** on a provisioned pair, n=7, and
`tests/integration/snapshot-dedup.spec.ts` holds it as a band. It read 33.09% until 2026-08-28;
nothing guarded the figure, which is how it drifted.

**IT WAS THEN PINNED TO 37.79% ON THE STRENGTH OF THREE IDENTICAL RUNS, AND THAT WAS THE NEXT
ERROR.** "n=3 with zero spread" was read as an exact property of the pack and written into the spec
with a tolerance of 0.00005. Seven runs read 0.3472, 0.3779 five times, and 0.3797 -- the outliers
appeared only once the full suite ran the spec under load, which is also why it passed alone and
failed in the gate. **Three identical readings are evidence of a mode, not of zero variance**, and a
tolerance that tight is a guard that fails on the truth. It is a band now.

A pair of BARE objects read 39.94 / 39.94 / 76.03%, so that arm is reported and never quoted -- an
object with no database has little structure to share and the fraction swings on what little there is.

Raw over best encoding on the live heap is **5.6-5.8x**. XOR-delta at page granularity is refuted,
and the reason changed under it: the one-node arm read **1.65x WORSE** than plain gzip on three
consecutive runs, and now reads **0.974 / 0.976** -- about 2.5% BETTER -- because the `WITHOUT ROWID`
cache bins and one added container class changed what is in the heap. **Parity is still not a lever**:
2.5% does not pay for a delta format, a base-image dependency and a restore path, against site-image
dedup at 34.7-38.0%. The spec now asserts a band around parity rather than a direction, since a
direction that flips on an unrelated pack change was never the property worth guarding. The best diverged
arm lands on 1.000. Interned strings are 2.1-3.0% of linear memory against a 10% threshold.

Content-keying the page store saves 21.05% of bytes on a real nine-path corpus -- Drupal's 404 is
byte-identical across paths, and that one class is the entire saving -- but costs **4 charged rows
against 2** for a new body, because a `TEXT PRIMARY KEY` costs a table row plus an index row. Storage
binds nothing here (30,880 bytes against a 5 GB allowance) and rows bind regeneration.

### One Object Is Not a Site-Wide Throughput Ceiling

A Durable Object is single-threaded, which has been read here as "a site is single-threaded". Those
are different claims, and the second one is false: a namespace holds unlimited objects, so the
question is whether a site's request population can be spread across several.

**An authenticated GET writes no authoritative state under this SAPI**, which is what makes spreading
it possible at all. Measured with the per-table write tally on a real render, steady state:

| path | rows written | authoritative |
| --- | ---: | --- |
| `/` | 9 | none |
| `/user/1` | 34 | none |
| `/admin/content` | 47 | none |
| `/admin/people` | 71 | none |
| `/admin/structure/types` | 45 | none |
| `/admin/reports/status` | 39 | `key_value`, `key_value_expire`, `watchdog`, `cfw_http_queue` |

No `sessions` row, no `users_field_data.access`, no `flood`, no form state. Core attaches
`UserRequestSubscriber` to `KernelEvents::TERMINATE` and throttles the access write by
`session_write_interval`, so on a stock host it is periodic; here it does not happen at all, because
this SAPI never dispatches terminate. No design decision rests on it, so
`tests/integration/replica-invariant.spec.ts` is its only guard.

**Replica-safety is a property of the REQUEST, not of the route**, and the status report is what
showed it. Measured against a dev server whose fetch cache was warm it wrote only `key_value`; measured
on a cold object it also wrote `watchdog`, because the advisories fetch failed and Drupal logged it.
A route allow-list derived from either reading would have been wrong about the other. `watchdog`
appears on any authenticated GET where Drupal logs.

**And a table name is not an effect either.** Reading the collections rather than the table turned
one verdict over: `key_value` holds `update_fetch_task:*` and `update:update_project_projects`, which
are a disposable fetch queue, alongside **`state:system.private_key`**, which Drupal mints lazily and
keys CSRF tokens and other HMACs on. Two replicas each minting their own would issue tokens the
others reject. So the private key must arrive by replication or at seeding and may never be generated
on a replica, while the rest of the same table can be dropped -- a per-table verdict is wrong in
whichever direction it is set.

This is why the guard in `src/ops/replica.ts` is effect-based rather than a route list. It walks the
capabilities INSTALLED on the PHP module instead of a known list, classifies each SQL statement
against the tables a replica may own, and refuses anything it does not recognise. Two capabilities
had already drifted out of `CROSSING_NAMES` -- `cfwOidcClaims`, which deletes a durable ticket, and
`cfwTcp`, which queues an outbound exchange -- so a list would have inherited that gap.

**The scaling curve.** A fixed CPU burn rather than Drupal, so the absolute rates are not Drupal's;
what the arm measures is the shape. Concurrency scaled WITH the replica count so per-replica offered
load is constant at 48 connections, zero errors:

| replicas | throughput | p50 | p95 | p99 | scaling | ideal |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 91.4/s | 528 ms | 634 ms | 639 ms | 1.00x | 1x |
| 2 | 187.7/s | 499 ms | 592 ms | 710 ms | **2.05x** | 2x |
| 4 | 288.9/s | 526 ms | 1,900 ms | 2,180 ms | 3.16x | 4x |
| 8 | 523.2/s | 543 ms | 1,824 ms | 2,288 ms | 5.72x | 8x |

p50 is flat across every arm, so per-request service time does not degrade as the pool grows. The
primary fed every pull with no measurable degradation; replication lag was 13-87 ms.

**AND THE SAME SHAPE SURVIVED REAL REPLICATION, which is the claim the table above cannot make.**
That arm ran a fixed CPU burn on independent objects; this one ran authenticated Drupal renders
across a replicated pool, with the generator's own ceiling measured first at 121.9 req/s so the
numbers mean something:

| lanes | median req/s | vs 1 lane | usable runs |
| ---: | ---: | ---: | ---: |
| 1 | 5.99 | 1.00x | 3 of 3 |
| 2 | 12.17 | 2.03x | 1 of 3 |
| 4 | 19.69 | 3.29x | 2 of 3 |
| 7 | - | - | **0 of 3** |

2.03 against 2.05 and 3.29 against 3.16, so replication costs nothing the topology arm did not
already show. The rates are two orders of magnitude below the burn arm's because these are real
renders rather than a spin loop, and only the ratio is comparable.

**The "usable runs" column is the finding.** At 7 lanes every lane withdrew and no run completed --
the terminal-`WITHDRAWN` defect, reproduced under load rather than reasoned about. The 2-lane and
4-lane arms lost runs to the same cause. Re-measure the curve now that readmission exists; the ratios
above are a floor rather than a ceiling, because each arm was scored on the runs that survived.

**The shortfall at 4 and 8 is NOT attributed.** Little's Law closes at 1 and 2 -- 48/0.528 = 90.9
against 91.4 observed, 96/0.51 = 188 against 187.7 -- and opens a gap at 4 (predicted 364, observed
289) and 8 (predicted 708, observed 523). Something above the service-time path constrains aggregate
concurrency past N=2. A single Node process holding 384 sockets is a candidate and is not evidence;
separating it needs a distributed generator, and 16 and 32 are not worth building until it is
separated.

**Three instrument errors had to fall first**, each of which produced a confident wrong curve:

- `while (Date.now() < until)` as a CPU burn never terminates, because the clock is frozen between
  I/O. Every request errored after ~37 s. The comment asserting it advanced across a compute loop was
  a guess.
- A shared-counter round-robin distributed unevenly and reported a completely FLAT curve
  (102 / 99.6 / 110). Pinning the replica per worker turned the same rig into 1.00 / 1.80 / 2.14.
- Fixed concurrency gave every arm a different per-replica load: N=1 collapsed with 2,227 errors at
  160 connections while N=8 ran 20 per replica and was never saturated.

The control that makes the numbers mean anything: the same generator against an endpoint doing no
work reached **958 req/s**, which is what rules it out as the cap at N<=4.

**THE SAME CURVE ON REAL DRUPAL, PAID, AUTHENTICATED.** The arm above burns fixed CPU; this one
renders `/admin/content` on N independently provisioned sites with a session, 6 connections per site
so per-site offered load is constant. Run in both arm orders on the SAME four objects, because
ascending order is a warming ramp:

| sites | A per site | B per site | mean | p50 A/B | order in A / B |
| ----: | ---------: | ---------: | ---: | ------: | -------------- |
| 1 | 5.16/s | 5.95/s | 5.56 | 1,172 / 993 ms | first / last |
| 2 | 6.57/s | 6.92/s | 6.75 | 840 / 819 ms | middle / middle |
| 4 | 6.70/s | 6.87/s | 6.79 | 958 / 929 ms | last / first |

2,498 authenticated renders, **zero non-200s and zero error-tail entries across both runs**. Per site
is FLAT from 2 to 4 -- 6.75 against 6.79, which is linear scaling in that range and is the criterion
the replica decision hangs on.

**N=1 is ~18% lower in BOTH orders**, so it is not the warming ramp. It is not attributed. The
leading candidate is that background work is per-object: `alarms` ran 65-73 per arm regardless of N,
so one object absorbs all of its own fill and GC while a pool of four dilutes the same amount over
four lanes. That would mean a pool buys tail insulation as well as throughput, which is a claim worth
testing rather than one to write down.

Little's Law closes at every point: 194 ms service x 6 connections = 1,164 against a measured p50 of
1,172 at N=1; 152 x 6 = 913 against 840 at N=2. The p95/p99 barely separate from p50 anywhere
(1,411 / 1,414 at N=1), which is the settle working -- the multi-second tails every earlier run
showed were the objects' own fill batches rather than service time.

### How a Replica Is Started, and the Value a Fresh Install Does Not Have

The log carries changes and cannot carry a beginning. `planApply()` requires every record to build on
the one before it, so an object at generation 0 with an empty database can never reach a primary at
generation 900 no matter how many records it is handed. A bulk copy is the other half, and it is a
different shape: rows rather than statements, whole tables rather than one write.

`GET /__replica?action=snapshot` produces -- the table plan, then one page of one table -- and
`POST /__replica?action=restore` consumes, split the way `action=log` and `action=apply` already are
so the object producing state and the object consuming it are never the same one. A restore is
refused outright on a primary: it clears the tables it copies, which makes aiming one at the object
that owns the state the most destructive thing the route could do.

**A torn copy is what the design is against.** The primary keeps serving while its rows are read, so
a copy spanning several invocations can hold table A at generation 12 and table B at 13 -- a state the
primary was never in, and which no generation number afterwards describes. Every chunk states the
generation it was read at, a chunk disagreeing with the one that began the copy is refused, and the
position stays marked in-flight until the whole copy has landed. That is the same marker a chunked
log apply uses, so `positionTrust()` already refuses both and there is one answer to "is this
replica's number real" rather than two that can disagree.

**A FRESH INSTALL DOES NOT HOLD `system.private_key`, so no replica could ever have been admitted
from one.** Drupal mints it on first use rather than at install. Enumerated on a just-provisioned
site, `key_value` carries `state:system.cron_key`, `state:install_time` and `state:install_task` --
and not that one. It is in `MANDATORY_STATE` because two objects each minting their own issue CSRF
tokens the other rejects, so `admissionVerdict()` would have refused every replica of a new site
forever, for a value the primary did not have either. The snapshot route now answers 409 naming the
gap; the primary mints with `\Drupal::service('private_key')->get()`.

The direction of the unknown flips between the two questions. At request time an
unclassified table routes to the primary, because serving from state nobody has checked is a
correctness failure a user sees. In a restore an unclassified table is COPIED, because one missing
from a replica costs whatever it held with nothing naming the restore as the cause, while a surplus
one is visible -- every copied unknown is listed in the plan.

### An Object's Role Is Its Name, and the Router Does Not Track Readiness

`REPLICA_READ_ONLY` is a deployment-wide var, so the moment a site has more than one object it makes
the primary read-only too. The role has to be per-object, and the id the router already used to
address the object is the only thing that carries it: `SITE.get(idFromName('example.com#r1'))` names
a replica, and no request a client can send changes which id was used.

The alternative considered was a header the front worker sets and the object pins on first sight.
Measured against the id: the header needs a forgery check, a contradiction check, a strip-first rule
on every subrequest, and a first request to arrive before a restore can run -- and `ctx.id.name` was
already read elsewhere in the same file. The pinned-header design was dropped for the derived one.

Lane 0 is the primary rather than a lane apart. Excluding it would idle the object that already holds
every warm cache while replicas boot cold, and it makes `REPLICA_COUNT=0` arithmetic that degenerates
on its own -- the modulus is 1 and every request lands on the primary -- rather than a special case
the caller has to remember.

**A LANE'S READINESS IS NOT ROUTING STATE.** The obvious design gives the front worker a cache of
which lanes are `SERVING`, which then needs something to invalidate it. Instead a lane that is not
`SERVING` answers the handoff that already exists: 421 with `x-cfw-retry-safe` computed from
`didMutate()`, and the router retries on the primary. One extra hop, only while a lane is not ready,
and no cache to be wrong.

That check runs before any interpreter exists, which is the one place `replicaHandoff()`'s default is
wrong: with no guard to ask, `didMutate()` reads as "not provably clean" and the refusal downgrades to
a 500 the caller must not retry. Correct everywhere else, so the call site states the exception rather
than the default changing.

The var and the name mean different things and only one of them is a promise. An object put into
replica mode by the var has no stage lifecycle -- nothing drives it, so it sits at `CREATED` forever
-- and applying the readiness check to it would refuse every request it ever gets and make the
generation fence unreachable. `isPoolLane()` is the narrower question, and it is what the readiness
check asks.

### A Lane Drives Itself, and the Staleness Bound Was Measured Rather Than Reasoned About

`action=provision` on the primary creates and fills a lane, a bounded number of rows per invocation
with the cursor handed back rather than stored. It runs on the primary because that is the object a
caller can reach. Reaching `VERIFIED` arms the lane's alarm; each firing pulls `action=log` and
applies it; `admissionVerdict()` decides the promotion to `SERVING`. A lane below `SERVING` owns its
alarm chain at 2 s.

**A `WITHDRAWN` LANE USED TO STAY THAT WAY, AND A DEPLOYED POOL PROVED IT.** The stage machine has
permitted `WITHDRAWN -> CREATED` since it shipped and nothing performed the move; the lane's alarm
stopped re-arming on the reasoning that a withdrawn lane needs a restore and re-arming only
re-learns that; and the primary picks lanes above its `lanes_provisioned` high-water mark, so a
number it has already copied is never chosen again. Unreachable from both ends. Measured on a
7-lane deployment: every lane withdrew and not one run of the read-scaling arm produced a number.

The exit is a whole re-copy rather than a resume, because what a withdrawn lane holds is untrusted
rather than partial -- it withdrew on a position it could not trust or a record it could not apply.
So the lane clears its torn-copy markers, returns to `CREATED`, and asks the primary through
`action=readmit`; the primary queues the lane number and its provisioning driver takes a repair
before growth, dequeuing only on a copy that finished. The repair runs on a QUIET site, which is the
part that is easy to get wrong: the load that made the lane withdraw goes to the primary the moment
it does, so waiting for contention to rebuild is waiting for the outage to continue.

**A first attempt at the steady-state guard was a guard that could not fire, and its test passed with
the whole method disabled.** It armed only when no alarm existed, on the belief that an idle serving
lane fires once and never again. `alarmBody()` ends in an unconditional re-arm, so that never
happens. What is actually true is narrower and still worth fixing: without a tightening, catch-up
runs on the idle re-arm, so a lane can serve a copy four minutes behind the primary and look healthy
doing it.

Measured, both ways, on the next armed firing after promotion:

| | next firing |
| --- | ---: |
| with `REPLICA_LAG_MS` tightening | 30,000 ms |
| without it | 240,000 ms |

**The test could not see the difference until the harness was corrected**, which is the more useful
half. The workers lane runs with `SITE_WARM=1` and production does not; warming re-arms at 8,000 ms,
already inside the bound, so the case passed whatever the guard did. Setting the spec's env to the
shipped default is what made it fail correctly. A lane's own configuration was measuring the harness.

### Counting a Page View Cost a Row Per View

`serve_requests` ran an unconditional `INSERT ... ON CONFLICT DO UPDATE` on both serving lanes,
outside the `shouldFlushMeters()` gate the daily meters go through. Against free's 10,869 rows/day
windowed budget that bound serving at ~10,869 views/day rather than the 100,000 Worker requests/day
the tier is sized for -- a 9.2x reduction to count something already counted in memory for nothing.

The tell was two lines below the write: a comment explaining that `pageHits` is kept in memory and
never a row, because a `hits` column would spend the rows-written meter to decide how to save it. The
counter beside it was doing exactly that. Same family as the warming tick whose meters recorded their
own writes.

It now accumulates in memory and folds into one row every 50 views or on the meters' own interval,
whichever comes first. The threshold bounds what an eviction can lose; the interval is what a quiet
site relies on.

### The Warm Authenticated Render, Measured on a Deployed Worker

The 467 ms this report scored the architecture against was derived across instruments. This is the
shipping artifact on a deployed worker, both levers on, every response marked `RENDER` rather than
`HIT` -- so each is a genuine authenticated render and not a cache read:

| path | p50 | p95 | p99 | min |
| --- | ---: | ---: | ---: | ---: |
| `/` authenticated | 208 ms | 229 ms | 229 ms | 172 ms |
| `/user/1` | 227 ms | 271 ms | 271 ms | 187 ms |
| `/admin/content` | 330 ms | 433 ms | 433 ms | 274 ms |
| `/admin/people` | 392 ms | 572 ms | 572 ms | 359 ms |

End-to-end from a client, n=20 each after three warming requests. Client RTT to the colo is ~47 ms,
measured separately against an endpoint doing no work, so **server time is roughly 161-345 ms
depending on the page**.

**That is faster than the 467 ms figure, which was pessimistic.** Per-lane throughput therefore runs
2.9 req/s on a heavy admin page to 6.2 req/s on a light authenticated one, against the 2.14 the
sizing table used -- so the pool sizes derived from 2.14 are upper bounds and the real ones are
smaller. Latency and throughput both move; the sizing rule itself does not.

**THOSE FIGURES REQUIRE A QUIET OBJECT, AND SERVEABLE IS NOT QUIET.** A Durable Object is
single-threaded and a fill batch may hold it for `fillBatchWallMs`, 5,000 ms on free, so every
request queued behind one waits that long. Measured on the same site, same data, same build,
`/admin/content` sequential n=12: **p50 2,742 ms while its alarm chain was draining and p50 214 ms
once it had stopped.** A fresh site measured 305 ms on the same path in the same minute, which is
what ruled out accumulated state -- the two databases differ by 10 sessions and 26 cache rows.

So an arm read through a draining object measures the object's own housekeeping and reports it as
service time, and the first curve run after this was measured that way: 1.38 req/s at N=1 against
3.91 and 4.17 per site at N=2 and N=4. A single object cannot be three times slower per site than
the same object running beside three others; the baseline was contaminated and the superlinear
"12.08x of 4.00x" was its shadow. `perf-curve.mjs` now settles every object to zero queued pages and
a stationary alarm count before each arm, and reports the alarm firings that happened DURING an arm
so a contaminated one is visible rather than silent.

**A COLD authenticated render throws Worker exception 1101 on this plan.** Reproduced twice
immediately after login, then 200 on every request once the object was warm, and 80 warm renders
across four paths with zero failures. The anonymous path never did it -- it answered 403 and then
`HIT` throughout. So the failure is the cold authenticated render specifically, which is the
combination that pays 1,398 ms of boot before it renders anything, and it is an argument for warming
being on by default rather than against the architecture. What it is NOT yet is diagnosed: the
exception text was not captured, and "exceeds a limit" is inference until a tail records it.

### How Much Authenticated Traffic Is Provably Replica-Safe

Measured over ten authenticated admin paths with every effect class instrumented -- SQL, sequences,
session, security state, files, mail, outbound HTTP, queues and alarms -- rather than rows alone. A
request that writes no row and sends one mail is not replica-safe, and a row count calls it clean.

**8 of 10, and the two exceptions share one cause:**

| path | effects |
| --- | --- |
| `/admin/config` | `watchdog` 5 rows, `setAlarm`, 1 x `cfwFetch` |
| `/admin/reports/status` | `watchdog` 5 rows, `setAlarm`, 1 x `cfwFetch` |

Both are the advisories fetch failing on a COLD object: Drupal logs the failure, the request is
queued for the next drain, and an alarm is armed to drain it. None of the dangerous classes fired at
all -- no authoritative SQL, no sequence allocation, no session write, no security state, no file,
no mail.

**So 80% of the MEASURED authenticated workload is currently proven replica-safe.** Not a floor, and
this section called it one until the claim was examined: a floor asserts that no further measurement
can go below it, which requires the sampling and the classifier to be monotonic, and neither has been
shown to be. A wider path set can contain a worse path; the oracle records what it observed rather
than what exists. It is a measurement over 10 paths on one object, and it is not the product number.

**The remaining 20% splits into two kinds, and only one of them is a limit.** The distinction decides
whether a path is routable at all:

| kind | meaning | what to do |
| --- | --- | --- |
| bootstrap-only | writes only because something has not been established yet | establish it, then re-measure |
| intrinsically primary-only | writes authoritative state as its purpose | route to the primary, permanently |

**Both current exceptions look bootstrap-only, and neither is confirmed.** They are the same cause:
the advisories fetch failing on a COLD object, so Drupal logs to `watchdog`, queues the request and
arms a drain. On an object whose fetch cache is warm the same paths write none of it. That points at
a state precondition rather than an intrinsic write, which would move both into the eligible set once
the cache is seeded at admission. **Not measured, and not to be hard-coded as primary-only until it
is** -- classifying a bootstrap cost as an intrinsic one is how a routable path gets permanently
pinned to the primary for a reason that stopped being true.

`src/ops/mutation-oracle.ts` records rather than refuses, which is the opposite posture to the
runtime guard: a replica must not learn what a request does while serving it to a user.
`eligibilityRate()` scores only profiles whose instrumentation was actually installed, because an
unarmed oracle observes nothing and reports nothing -- indistinguishable from a clean request, and
the exact shape of several past defects here. The first run of the census tripped that control and
refused to score, which is what caught the oracle reaching for `php` instead of `php.binary`.

### The Queue/Service Split, and Why Only Half of It Is Measurable Here

A replica pool removes QUEUEING, not service time, so sizing one needs the two separated. The gated
lane now records both at `/serve-stats` under `lane`, and they are not equally trustworthy.

**`aheadMean`, `aheadMax` and `queuedFraction` are counts taken at arrival**, with no clock in them.
`ahead` is exactly the quantity a second execution lane removes: requests waiting on a
single-threaded object. This is the input to `arrival rate x service time / target utilisation`.

**`queueMsFloorMean` and `serviceMsFloorMean` are FLOORS and are named so nobody can quote one
without the word.** The wall clock only advances during I/O, so a `Date.now()` delta taken around a
synchronous `php._run()` contributes zero: a deployed cold fill once reported 117 ms for work that
cost 1,398 ms of `cpuTime`. These durations therefore count host crossings and nothing else, and
understate by all the pure compute between them. The honest absolutes remain the client's own clock
and `cpuTime` from a tail, which is why the 1->2->4 curve is measured end-to-end from outside.

`tests/integration/lane-timing.spec.ts` asserts the counts and does NOT assert the
durations are positive: `serviceMs > 0` would be asserting that the render did I/O, not that it took
time, and would pass for the wrong reason.

### What a Replica Actually Buys, and What One Costs

**Replicas do not make a page faster. They raise how many pages run at once.**

The measured p50 of 528 ms at N=1 is almost entirely QUEUEING, not service, and separating the two
resolves an apparent contradiction in the numbers above: one single-threaded object cannot serve
91.4 req/s if each request occupies it for 528 ms. It does not. Little's Law on the same arms:

| replicas | conns | total req/s | per replica | **service time** | p50 residence | queueing |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 48 | 91.4 | 91.4 | **10.94 ms** | 528 ms | 517 ms |
| 2 | 96 | 187.7 | 93.9 | **10.66 ms** | 499 ms | 488 ms |
| 4 | 192 | 288.9 | 72.2 | **13.85 ms** | 526 ms | 512 ms |
| 8 | 384 | 523.2 | 65.4 | **15.29 ms** | 543 ms | 528 ms |

Service time is one over per-replica throughput; residence is what a client observes. **97% of the
observed latency was requests waiting behind each other**, which is exactly what a pool removes.

That table also localises the shortfall the earlier arms could not. Per-replica service time is flat
through N=2 -- 10.94 to 10.66 ms, no degradation at all -- and then rises **27% at N=4 and 40% at
N=8**. So the 4->8 gap is not the load generator and not the ideal-vs-actual ratio; it is each
object getting slower as the pool grows, which points at placement or account-level contention and
needs per-object `cpuTime` and DO identity to settle.

**Sizing is a division, not a curve:**

```text
replicas = peak concurrent authenticated req/s / per-replica req/s
```

Per-replica throughput is one over the SERVICE time. The synthetic burn ran at 10.9 ms; a Drupal
authenticated render does not:

| authenticated render | service time | per-replica req/s |
| --- | ---: | ---: |
| neither lever | 3,525 ms | 0.28 |
| warm only | 2,127 ms | 0.47 |
| both levers | ~467 ms | 2.14 |

**Which puts 32 replicas at ~68 authenticated renders per second, sustained** -- a large site. A busy
editorial Drupal site runs 1-5, which is **1-3 replicas**. 32 was brainstormed and the arithmetic
does not support it as a default. The ~467 ms is derived across instruments rather than measured at
the edge, so treat that row as an order of magnitude and do not convert the synthetic 91.4 req/s into
a Drupal capacity number.

### Free Supports Replicas; What It Meters Is WARMTH

Durable Objects are available on free, SQLite-backed, with unlimited objects per class. What free
bounds is not how many replicas exist but how many are kept HOT, because warming spends the same
daily meters serving does.

Measured, per warmed object per day: **10,800 DO requests and 13,680 rows** -- 10,800 `setAlarm`
rows plus 1,440 meter flushes at 2 rows each. **Rows bind first**, and an earlier version of this
section checked only the request meter and put the ceiling at 9 objects. It is 7:

| warmed objects | requests/day | rows/day | inside free? |
| ---: | ---: | ---: | --- |
| 2 (primary + 1 hot) | 21,600 | 27,360 | yes |
| 4 | 43,200 | 54,720 | yes |
| **7** | 75,600 | **95,760** | **yes, the ceiling** |
| 8 | 86,400 | 109,440 | no, 9% over on rows |

**A COLD REPLICA COSTS NOTHING.** It arms no alarm, serves no request and is not billed for duration
while hibernating, so the pool size and the hot count are separate numbers. Free's shape is therefore
a small hot pool plus cold burst capacity:

```text
primary        hot
replica 0      hot
replica 1..N   cold, woken on sustained contention, hibernating again after
```

The trade a cold replica makes is the 1,398 ms boot on its first request, against an extra
independent execution lane for every request after it. That is the right trade for a burst tier and
the wrong one for a latency floor.

So a replica count belongs in configuration with a hard maximum and a separate hot-pool target,
demand-driven rather than fixed. Free's always-hot maximum is 7 objects total; its cold pool is
bounded by the daily request budget it would spend when actually used, not by its size.

**AND THE ROW METER IS A CLIFF, NOT A THROTTLE.** Spending it stops the whole namespace for the rest
of the UTC day: every route on every site answered `error code: 1101` with none of the worker's own
headers, and the tail records
`Exceeded allowed rows written in Durable Objects free tier.` thrown out of `ensureMigrateTable()`
inside `alarm()`. Diagnostics go with it -- `/serve-stats`, `/heap` and `/health` all 1101 -- so the
one thing an operator would reach for to understand the outage is the thing the outage removes.
Reached here by provisioning a handful of sites and running load against them, which is a
measurement session rather than a workload, but nothing about the cliff is specific to that.

### What Each Replica Buys, Against a VPS

A PHP-FPM worker and a replica are the same unit: one execution lane. So the comparison is
lane-for-lane, and the only thing that differs is the service time per lane and what a lane costs.

**Queueing delay is `(C / N - 1) x service_time`.** Observed latency at C concurrent authenticated
requests, using the measured service times above and a **200 ms native PHP render, which is ASSUMED
and is the weakest number here**:

| pool | neither lever | warm only | both levers | VPS lane (assumed) |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 70.50 s | 42.54 s | 9.34 s | 4.00 s |
| 2 | 35.25 s | 21.27 s | 4.67 s | 2.00 s |
| 4 | 17.62 s | 10.63 s | 2.33 s | 1.00 s |
| 8 | 8.81 s | 5.32 s | 1.17 s | 0.50 s |
| 16 | 4.41 s | 2.66 s | 0.58 s | 0.25 s |
| 32 | 3.52 s | 2.13 s | **0.47 s** | 0.20 s |

at C = 20. Two things fall out of it:

**The sweet spot is exactly `N = peak concurrent authenticated requests`, and nothing above it buys
anything.** Queueing reaches zero when `N >= C` and the row goes flat -- 32 replicas and 20 replicas
are the same page at C=20. That is the answer to "what is the right number": not 32, not a constant,
but the site's own peak concurrency.

**Per lane the VPS is faster, so matching it takes more lanes.** 2.14 renders/sec against 5.00, a
2.3x deficit, so throughput parity with an `M`-worker FPM pool needs roughly `2.3 M` replicas. What
closes that gap is not more replicas but a shorter service time, which is what the two levers already
did -- 0.28 to 2.14 renders/sec per lane, a 7.6x move.

### Where the Cost Crosses Over

Priced with Workers Paid ($5/mo, 10 M requests included, then $0.30/M), DO requests (1 M included,
then $0.15/M), DO rows (50 M included, then $1.00/M), a measured 9 rows per warm authenticated
render, and the hot pool sized to a peak of 10x average:

| views/month | authenticated | hot objects | drupflare | $40 VPS |
| ---: | ---: | ---: | ---: | --- |
| 100,000 | 10% | 2 | **$5.00** | wins |
| 1,000,000 | 10% | 2 | **$5.00** | wins |
| 10,000,000 | 10% | 3 | **$5.15** | wins |
| 50,000,000 | 10% | 10 | **$18.09** | wins |
| 100,000,000 | 10% | 19 | $82.07 | loses |

**The crossover against a $40/month VPS is ~67 million views a month**, about 26 views/sec sustained.
Below it the architecture is cheaper; above it the per-request meters overtake a fixed monthly box.

The reason the low end is so flat is that anonymous traffic never reaches an object at all, so a
small site's bill is the Workers base fee and nothing else -- a VPS pays for peak capacity 24 hours a
day whether or not anyone visits, and this does not.

**Latency is the other half and it does not favour this architecture.** Unqueued, a VPS lane answers
an authenticated render in less time than a replica does; replicas remove queueing, they do not make
a lane faster. Where this wins on latency is the cached anonymous page, which is answered at the edge
and which a VPS cannot match without putting a CDN in front of itself.

### What a Hot Pool Costs on Paid

Warming `N+1` objects at 8 s, per month, against 1,000,000 included DO requests and 50,000,000
included rows:

| replicas | requests/mo | rows/mo | duration | **total** |
| ---: | ---: | ---: | ---: | ---: |
| 3 | 1.30 M | 1.64 M | 118 GB-s | **$0.05** |
| 7 | 2.59 M | 3.28 M | 236 GB-s | **$0.24** |
| 15 | 5.18 M | 6.57 M | 452 GB-s | **$0.63** |
| 31 | 10.37 M | 13.13 M | 934 GB-s | **$1.41** |

Rows stay inside the included 50 M at every size, so requests are the only line that bills.

**Cost does not decide the pool size on paid** -- 32 replicas kept permanently hot is under two
dollars a month. Measured queueing relief and replica utilisation should decide it.

**The 4 and 8 arms are not yet interpretable, and the reason is not recorded.** The on-platform
generator saw 1,438 of 2,880 requests fail at N=2, and the run counted non-200 responses without
capturing the status, the Cloudflare error code, or the account's usage at that moment. Cloudflare
documents no general requests-per-second limit on Workers -- free has a 100,000/day request quota
that answers Error 1027 when exhausted -- so "free-plan rate limiting" is a guess and is withdrawn
until a run records the code. 16 and 32 are not worth building until a paid account has re-run
1->2->4 on a real Drupal workload with per-object `cpuTime` and DO identity captured.

---

## The Interpreter Build

The shipping variant is **`long64`**: 64-bit `zend_long` on 32-bit pointers, so `PHP_INT_SIZE` is 8.

`Zend/zend_long.h` sets `ZEND_ENABLE_ZVAL_LONG64` from compiler predefines and derives
`SIZEOF_ZEND_LONG` from it; neither `configure.ac` nor `Zend.m4` mentions either macro, so a `-D` on
the command line stands and there is no generated header to patch. `Makefile:209` clears
`EXTRA_CFLAGS` after the rc is included, so the flag is passed as a make variable rather than in the
rc. The ABI stamp treats it as its own ABI, because every object differs.

| | wasm32 | **long64** | wasm64 |
| --- | --- | --- | --- |
| `PHP_INT_SIZE` | 4 | **8** | 8 |
| raw wasm | 12,218,393 | **12,234,574** | 12,563,711 |
| zstd -22 | 2,659,133 | **2,671,380** | 2,720,787 |
| auth peak | 108,724,224 | **113,770,496** | ~129 MB |
| headroom | 24.31 MiB | **19.50 MiB** | 5.00 MiB |
| blended CPU vs wasm32 | 1.000x | **1.001x** | 1.030x |

It buys the same capability as wasm64 for 21x fewer raw bytes, 5x fewer shipping bytes and 3.9x the
heap margin. The CPU figures sit inside a self-control that reads **1.005x**, which is the harness's
resolution: `bun run measure:abi-control` loads one binary as two arms, so anything other than 1.000x
there is the instrument. Arms must be interleaved; run in series, machine contention inverts the
result.

**What `PHP_INT_SIZE` 8 does not fix is the JSON bridge.** `PHP_INT_MAX` crosses back as
`9223372036854776000`, because a JSON number is a double. PHP can now hold values the bridge mangles.
`src/db/wide-integers.ts` solves the SQL half; anything else crossing a wide integer must cast to a
string first.

### The Growth Step

Emscripten emits `MEMORY_GROWTH_GEOMETRIC_STEP` into `_emscripten_resize_heap` as a JavaScript
literal; the `.wasm` carries no growth policy at all, so re-emitting the glue produces any step
without a rebuild. `scripts/measure/growth-glue.ts` emits it and `growth-ladder.ts` drives the arms.

`newSize = align(max(demand, oldSize * (1 + step)), 64 KiB)`, so the peak is a **step function** of
the step: flat across a range, then a jump. A smaller step is not reliably a lower peak -- one that
undershoots on its first grow grows again, and the second rung compounds above where a larger single
rung landed.

`stepFor()` is per-ABI: **0.13 on long64, 0.08 on wasm32**. Applying wasm32's step to long64 makes it
grow twice and peak at 117,440,512, which reads as the ABI's cost and is the mistuning's.

Score a step against the **authenticated** render. Read the render column alone and every arm is
identical; the peak lives in the auth column. A render no longer grows the heap at all on any arm,
which is opcache being off.

Margin is the fourth metric and it overrules the Pareto frontier: what headroom, grow events, bytes
copied and spare events do not measure is how far the rung sits above a demand that moves, and the
authenticated demand is bimodal by one page and drifting up.

### The Allocator and opcache

**opcache is off.** `file` mode wrote 2,346 `.bin` files and 32,141,312 bytes into MEMFS while
`opcache_get_status()` reported opcache disabled, because `file_cache_only=1` turns the shared-memory
backend off and that API answers about the backend. `shm` does accelerate and puts its arena in
linear memory, reaching 191.25 MiB against a 128 MiB cap, so it cannot ship. `off` renders within 1 ms
of `file` at n=5 and frees 5,046,272 bytes of linear memory plus 32,141,312 of MEMFS. `OPCACHE_MODE`
is the seam and is KV-overridable.

`USE_ZEND_ALLOC=1` is built as an arm and refused: it costs **2.66x the heap** (authenticated peak
342,294,528 against a 134,217,728 limit) and prints `munmap() failed: [28] Invalid argument` into
PHP's output stream, so in a render that text is prepended to the HTML. `emmalloc` costs +196,608
bytes on the binding workload. `IMPORTED_MEMORY` clears its precondition -- JavaScript owns the
`WebAssembly.Memory` -- and then fails on the next one: the module carries 15,619 data segments,
every one ACTIVE, writing 3,011,834 bytes during instantiation, so pre-filling splits the restore
phase rather than removing it.

`tests/node/abi-arms.spec.ts` pins the import/export shape and segment count for all four arms.

### Extensions

`get_loaded_extensions()` is the oracle, exposed on `/__php`, and
`tests/integration/loaded-extensions.spec.ts` asserts the platform map against it in both directions.
**25 extensions**: Core, PDO, Reflection, SPL, SimpleXML, Zend OPcache, ctype, date, dom, filter,
hash, json, lexbor, libxml, pcre, pib, random, session, standard, tokenizer, uri, vrzno, xml, yaml,
zlib.

No mbstring, no iconv, no gd, no curl, no openssl. `DEFAULT_PLATFORM` is split into
`NATIVE_PLATFORM` and `POLYFILLED_PLATFORM`, and a requirement met only by a polyfill answers
`unverifiable` rather than `installable`.

Function-name evidence is actively misleading: opcache's `func_info` table names functions from
extensions the build does not have.

### mbstring

The polyfill is scored against the real extension as an oracle by `bun run measure:mb-parity`, over
the whole codepoint space of **1,112,064 scalars** (`0x110000` minus 2,048 surrogates) rather than a
sample.

| measurement | before | after |
| --- | --- | --- |
| the 1,232-case corpus | 77 | 37 |
| Drupal core's exposure within it | 33 | **0** |
| `mb_strtolower` over the full space | 95 | 0 |
| `mb_convert_case` titlecase | 273 | 0 |
| `mb_strwidth` | 9,733 | 0 |

The tables are generated FROM mbstring and live on the asset layer (+1,034 gz there against +4,690
inlined). Generate them through workerd, whose `toLowerCase` is byte-exact against native mbstring;
node's ICU is 28 codepoints off. `tests/unit/drupal/unicode-workerd.spec.ts` runs the casing sweep
inside workerd on every commit.

The 37 remaining cases are all invalid-byte input to `mb_str_split`, `mb_lcfirst`, `mb_trim` and
`mb_str_pad`, none reachable from core, and they are not closed by sanitising harder -- that
regresses 19 cases that pass today. What closes them is reproducing mbstring's error-marker model.

Compiling the extension is **+586,648 gz**, and faking it is worse: a stub module entry **segfaults,
exit 139**, because both Symfony bootstraps branch on `extension_loaded('mbstring')` and the stub
makes `iconv_strrpos()` and `mb_strrpos()` recurse into each other.

### The Clock

In-PHP `microtime()` returns a real epoch, but it does not ADVANCE between I/O: PHP's clock is the
glue's `_emscripten_date_now = () => Date.now()`, and Workers freeze that. So an application
timestamp is correct and a duration taken from two readings is not. The host depends on the same
fact: `nowMs()` is `Date.now()` and arms every alarm and every `expires_at`.

`tests/integration/php-clock.spec.ts` pins it and `/clock` reports `absoluteS` and `jsAbsoluteMs`.

---

## Defect Classes

Six shapes account for most of what has gone wrong here. Each has a guard that fails on the shape
rather than on one instance.

**Built, tested, and read by nobody.** A module is imported by its unit test and by nothing under
`src/`, so it is green on every commit and absent from every deployed site. `bun run check:reachability`
walks imports from the wrangler `main` and classifies every module as `edge` / `probe` / `script` /
`dead`; `tests/node/reachability.spec.ts` fails on a new dead module **and on a stale exemption**.
Probes are correctly unreachable, which is why the scan separates them rather than counting 45
problems to hide 5. The scan also reports exports only tests mention -- usually the legitimate
"exported for its unit test" pattern, and sometimes a function whose writer stopped calling it.

**An invariant enforced on one path and asserted on another.** Two serving lanes exist and guards
added to one were never mirrored onto the other. The generalisation: any duplicated read path needs
its guards asserted against the same fixture, and a spec must be able to vary the thing that
distinguishes the paths -- a cookie, an `Accept`, a method. A test helper that cannot express "the
same request, but signed in" cannot catch this family, and every such case needs the anonymous
control too, or a lane that stopped answering anything at all passes.

**A guard that cannot fire.** A comparison against a value the reader never produces, arguments
transposed, a probe that re-resolves the state it is checking after the event it is checking survival
across. Falsify a guard by removing the fix and requiring red. A regression test that has never been
seen to fail is not known to test anything.

**Decorative configuration.** Code that reads as configuration and is a no-op. `Request::create()`
never reads `$_SERVER` -- Symfony builds its own parameter bag, so anything set afterwards is
invisible to `getClientIp()` and the rest. `memory_limit` cannot bind under `USE_ZEND_ALLOC=0`.
`setAccessible()` has been a no-op since PHP 8.1. Assert the observable the setting is supposed to
change, not the setting.

**A cached copy shadows the edit.** A surgical `config` row edit is inert while `cache_config` holds
its own serialized copy, because Drupal reads the bin first. When editing a config row, find every
cached copy of it, and assert both copies and their equality. The same rule covers copying a cache
row between databases: verify `expire = -1` and that both databases carry identical `cachetags`, or
the row is present and rejected and the cost it was meant to remove is still paid.

**The gate and the thing that ships are different programs.** Every vitest lane resolves through
vite; wrangler bundles with esbuild, and they disagree on re-export barrels. `bunx tsc --noEmit`
covers one of three tsconfig projects. `wrangler.jsonc` aliases a binary seam that vite does not
apply. Each seam needs a check that runs the shipping path:
`bunx wrangler deploy --dry-run --outdir=<tmp>`, `bun run typecheck` rather than bare `tsc`, and a
spec comparing the alias key to what `src/site-do.ts` imports.

**A hand-written list of what the code emits.** An assertion enumerating tiers, headers or states
goes stale in both directions -- naming values the source does not emit and omitting ones it does.
Export the list from `src/` and hold the const in both directions.

---

## Measurement Rules

1. **An absolute CPU figure comes only from `cpuTime` on a deployed worker.** The clock does not
   advance across a synchronous `php._run()`, so a delta from in-PHP `microtime()` or from
   `Date.now()` around one reads 0 or a plausible wrong number -- 114 ms was once reported for a
   1,374 ms invocation. A local `wrangler dev` wall clock cannot reliably order two profiles, and it
   was measured understating a deployed PHP render by roughly 5x. Say "local wall clock" or do not
   say it.
1b. **The rule is about synchronous PHP, not about `Date.now()`.** A delta SPANNING I/O is usable:
   an `x-worker-ms` delta bracketing `stub.fetch()` tracked the platform's `wallTimeMs` to within
   1 ms on every arm of a deployed run, n=78-80. Narrowed 2026-08-30 because the wider form
   discarded a working instrument.
1c. **`cpuTime` is 1 ms granular.** A reading of 1 ms bounds an invocation at or below 1 ms; it does
   not measure 1.0 ms and cannot confirm or refute a sub-millisecond claim.
2. **State an n and a spread.** The 400-600 ms bimodality asserted here **did not reproduce** on
   2026-08-30 across 640 client-side requests against a continuously driven warm object: exactly two
   samples exceeded their arm's median by more than 300 ms and both were attributable to a specific
   alarm or render. It may hold for cold or first invocations, which is where it was first seen. As
   a standing property of the platform it is unverified; re-observe it rather than assuming it.
3. **`wrangler tail` omits `durableObject` events** unless asked for them, and Observability's
   `calculations` view omits zero-valued groups. Read the `events` view where the expected answer is
   "below the meter's resolution".
4. **Never call `Database::startLog()`.** It changes what is being measured.
5. **Benchmark inside a PHP closure and name which cache bins were emptied.** "Warm render" and
   "cache hit" are different measurements even when both are warm, and `dynamic_page_cache` alone is
   not the gate for a shell harvest -- the `render` bin is.
6. **A subtraction is only as good as its subtrahend.** Check what the number being subtracted
   measured before trusting the difference.
7. **A probe that cannot fail is not a probe.** A probe for state survival must exercise state
   captured before the event, never state re-resolved after it.
8. **Count both halves.** An instrument attached to one layer measures that layer, not the system.
9. **Size a chunk by the meter that binds it, and name that meter.** A chunk sized against storage
   while CPU is the binding cost passes its own test and blows the real one.
10. **Run the self-control first, and interleave the arms.** A harness loading one binary as two arms
    is 1.000x by construction; what it actually prints is its resolution.
11. **Quantisation reads as equality.** Where a step function sits between the quantity and the
    reading, identical values mean the rung is wider than the difference, not that the difference is
    absent.
12. **`PLAN=free` is this project's var, not Cloudflare's plan.** A deployed run on a paid account
    measures cost, which is plan-independent, and never enforcement. The free CPU cap also has a
    burst allowance: one large request succeeds where the same request repeated fails 11 of 15.
13. **Two artifacts are only comparable in the same MODE.** Where the thing being compared exists
    only because of a condition -- an emptied bin, a flag, a cold cache -- the other side has to be
    produced under that same condition, or the structural difference reads as a finding. Shell
    verification cost three comparators to this: a shell has BigPipe holes only because harvesting
    empties the `render` bin, so its personalised regions never aggregate their `#attached`
    libraries into the head, and an ordinary render of the same page carries a different asset set
    by construction. The diff pointed at offset 3407, `action-links.css` against `block.css`, which
    looks like a defect and is a mode mismatch. Harvesting both sides made them equal byte for byte.

14. **A load arm must not start its clock before its own warm-up.** The scaling harness set
    `until = now + SECONDS` at the top of the arm and warmed the pool afterwards, so the warm
    requests spent the window they were preparing for: the N=2 arm ran 12 connections for whatever
    was left of 15 s, collected 96 responses where 240 were expected, divided them by a short
    elapsed and reported a HIGHER throughput than the N=1 arm. Nothing about the output looked
    wrong, because a throughput is a ratio and both halves moved.
15. **An ascending arm order is a warming ramp.** Running 1, 2, 4 in sequence means the later arms
    always sit on objects that have served more, so a per-site figure that RISES with N is partly
    drift and not scaling: measured 5.16 then 6.57 req/s per site at N=1 and N=2, where offered load
    per site is identical by construction. Bracket it by running the arms in both orders and
    comparing, not by asserting the drift is small.
16. **Serveable is not quiet, and quiet is not idle.** A Durable Object is single-threaded and a
    fill batch holds it for up to `fillBatchWallMs`, so an arm read through a draining alarm chain
    reports housekeeping as service time -- 2,742 ms against 214 ms on the same site in the same
    minute. The settle that fixes it must watch the FILL QUEUE: an idle object re-arms forever by
    design, so `alarmFirings` never goes stationary and a settle keyed on it waits out its whole
    deadline and then reports the object busy.

Suspect the instrument first. Most moved verdicts in this project moved because the instrument was
wrong, not the system.

---

## Repository Layout

| path | what |
| --- | --- |
| `src/site-do.ts` | the Durable Object that runs PHP: boot, mount, bridge, serving path, alarm fill chain |
| `src/site.ts` | the front worker: cache tiers, generation pointer, deny filter, body guard, routes |
| `src/env.ts` | every var this worker reads, with what each costs if it is wrong |
| `src/drupal/*-php.ts` | PHP fragments, mostly `String.raw`. `site-php.ts` is the render path |
| `src/runtime/` | the mount, the lazy FS, the interrupt mask, the gate, and the binary seam |
| `src/db/` | codec bridge, chunked migration, export/import, durable files, heap store, write tally |
| `src/ops/` | cron, sliced updates, plan and thresholds, health ladder, identity, mirrors, setup pages |
| `src/probes/` | frozen measurement instruments, each its own entrypoint |
| `assets/drupal/` | the packed standard tree and `site.sqlite` |
| `assets/drupal-pf/`, `assets/drupal-sql/` | the per-file pack the object mounts, and the migration chunks |
| `assets/core/` | the browser-fetchable Drupal tree, served by Workers Assets |
| `assets/driver.json` | the Drupal modules that execute, packed from the sibling repos |
| `vendor/` | hand-built php-wasm binaries, gitignored, mirrored to R2 |
| `.interp/` | the shipping interpreter, its zstd frame, and the wasm decoder |
| `drupal-src/` | the installed Drupal site the packers read; not committed |

Four sibling repositories hold the rest: `drupflare` (the capability module), `rom` (the
`cfw_do_sqlite` driver), `phasm` (the wasm build toolchain), and `cartridge` / `durabledb` /
`stream-http` as packages.

`docs/repository-layout.md` is the account of how every path arrives on a clean clone;
`docs/building-from-source.md` is the release and build procedure; `docs/configuration.md` is every
var and binding.

`src/probes/**` are cited by figure in this document. Moving one does not change what it measures;
rewriting one might.

**Two artifacts have no producer in this repository.** `assets/drupal/site.sqlite` is hand-trimmed --
`pack-sql.ts` consumes it and nothing writes it, and the build input is 14.4 MB against its 6.6 MB.
To change a row, read it out of the build input, insert it, and re-run `bun run assets:sql`.
`assets/drupal-pf` and `assets/drupal-sql` need a native PHP Drupal bake, so they arrive only through
`bun run hydrate` from a published release payload. Until one exists, `ARTIFACT_SPECS` in
`vitest.config.ts` excludes the specs that assert them and the lane prints what it dropped.

---

## Verifying the Tree

```sh
bun install                # restores the interpreter from the CDN, sha256-verified
bun run test               # vitest: --project=workers --project=node
bun run typecheck          # all three tsconfig projects; bare `tsc` covers one
bunx prettier --check .
bun run check:reachability # which modules the edge imports; which are dead
bun run release:check      # the shipping bundle against the 3 MiB ceiling
bun run assets:driver      # repack after any change in a sibling repo
bun run backup:verify      # 40 CDN keys, no credentials
```

Three vitest projects exist because workerd cannot do `node:child_process` or `node:fs`: `workers`
runs in workerd, `node` runs what needs a real PHP binary or filesystem, and `e2e` needs a server and
is excluded from `bun run test`.

The PHP suites live in the sibling repos and are the authority on their own module:

| suite | repo |
| --- | --- |
| `php tests/health-suite.php` | `../drupflare` |
| `php tests/cfw-tcp.php` | `../drupflare` |
| `php tests/solarium-transport.php` | `../drupflare` |
| `DRUPAL_ROOT=<worker>/drupal-src php tests/load-classes.php` | `../drupflare` |
| `DRUPAL_ROOT=<worker>/drupal-src php tests/run-driver-suite.php` | `../rom` |
| `DRUPAL_ROOT=<worker>/drupal-src php tests/run-installer.php` | `../rom` |
| `DRUPAL_ROOT=<worker>/drupal-src php tests/pdo-shim.php` | `../rom` |

`run-installer.php` drives Drupal's own installer against the driver with core's sqlite driver as a
child-process control. It needs a real filesystem, so it is sibling-only.

This repo's gate checks the siblings out with no `composer install`, so a suite or fixture needing
`drupal/core` must search `../../drupal-src/vendor/autoload.php` as well as its own `vendor/`, and
supply `Drupal\drupflare\` itself.

Every command prints its own total. Run it rather than quoting a count from this document.

The rig is `docker/compose.yml`: seven services pinned by digest -- GreenMail, Redis, syslog, Gitea,
Forgejo, Keycloak, and GitLab CE behind `--profile heavy`. `tests/e2e/README.md` has the commands.

Deploys use a `cfw-*` name, are torn down immediately, and the worker list is verified back to its
prior baseline.
