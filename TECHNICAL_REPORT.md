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
| Full uncached render, both bins emptied | **2,127 ms** (n=10, 1,982-2,579) | edge `cpuTime` |
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
**2,127 ms** of edge `cpuTime`, and one site is one Durable Object is one thread that cannot be made
bigger. Content sites win decisively; busy authenticated editorial workflows do not.

**The 3.57x wasm penalty is not that number and must not be read as it.** It is a warm-kernel ratio
between two interpreters on ONE machine, with the container already built; the edge figure is the
whole request. The README carried `34 ms` for this row until 2026-08-29, which is `9.47 x 3.57` --
an arithmetic product of a native measurement and a local ratio, published under a provenance code
meaning "measured on deployed infrastructure", and 62x below what the deployed meter reports.
`scripts/bench/bench-render-breakdown.php` calls the 33.8 ms basis an inference in its own header.
The neighbouring `page_cache` row is genuinely 1 ms because a stored-page serve runs at a 20x
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
account, a genuinely cold object answers 503 then 404-from-storage in **3,166 ms of wall clock across
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
what is already compressed, which is the entire mechanism behind shipping the interpreter as a zstd
frame in a `Data` module: it saved 997,878 bytes in one change, more than four times what an entire
extension-removal programme achieved.

Consequences for a size proposal:

- Do not reason about the ceiling from a `gzip` figure on a `.wasm`. The relevant compressor is zstd
  and the authority is what `wrangler deploy` prints.
- **PHP 8.4 costs 49,220 MORE compressed bytes than 8.5** while being 357,323 smaller raw, because
  its data section is both larger and less compressible (0.370 against 0.331; the code sections
  compress identically).
- **`ZEND_VM_KIND=SWITCH` costs +129,760 gzipped bytes.** `-O3` is smaller raw and bigger gzipped.
- Dropping extensions buys bytes that are not scarce and ~10-25 ms of inflate that the wasm decoder
  already returned tenfold, while costing capability and needing shims.
- The glue's export trampolines are collapsed, worth 47,093 gz. Emscripten emits a self-rebinding
  wrapper per wasm export -- 2,466 of them, 472,712 raw bytes -- and only `_main` is read back by the
  glue. One lazy binder installed inside `receiveInstance` replaces the rest; that is the first point
  the export table exists, which is why emscripten uses trampolines at all.
- The largest untaken lever is the ~194,000 raw bytes of `String.raw` PHP in `src/drupal/*-php.ts`.
  Moving it to the asset layer turns eight always-on polyfills into eight conditionally-loaded ones.

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
permanently warm object.

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
sub-second marginals are noise; what survives is that `kernel-boot` dominates everything before it by
roughly 5x. **The per-object instantiate is 484 ms**, which is the figure a heap-restore or
always-warm proposal is scored against.

**Boot work is saturated.** Once the fill window amortises the boot, the regeneration ceiling is
bound by rows written, so a 20x reduction in boot cost per fill moves the ceiling about **1%**. Rows
work first.

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

Bucket attribution against native PHP, per render:

| bucket | calls | multiplier |
| --- | --- | --- |
| event dispatch | 7 | **4.3x**, 3.0 ms -- Symfony listener resolution |
| `cache_contexts` | 73 | 5.8x |
| the renderer itself | -- | 1.6x |

The two most expensive buckets are not the renderer.

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

Raw over best encoding on the live heap is **5.6-5.8x**. XOR-delta at page granularity is refuted:
the one-node arm reads 1.65x WORSE than plain gzip on three consecutive runs, and the best diverged
arm lands on 1.000. Interned strings are 2.1-3.0% of linear memory against a 10% threshold.

Content-keying the page store saves 21.05% of bytes on a real nine-path corpus -- Drupal's 404 is
byte-identical across paths, and that one class is the entire saving -- but costs **4 charged rows
against 2** for a new body, because a `TEXT PRIMARY KEY` costs a table row plus an index row. Storage
binds nothing here (30,880 bytes against a 5 GB allowance) and rows bind regeneration.

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
backend off and that API answers about the backend. `shm` genuinely accelerates and puts its arena in
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

1. **An absolute CPU figure comes only from `cpuTime` on a deployed worker.** In-PHP `microtime()`
   and JS `Date.now()` do not advance between I/O, so a delta from either reads 0 or a plausible
   wrong number -- 114 ms was once reported for a 1,374 ms invocation. A local `wrangler dev` wall
   clock cannot reliably order two profiles. Say "local wall clock" or do not say it.
2. **State an n and a spread.** The platform is bimodal by 400-600 ms, on the same object, and the
   split appears in every phase, so a single number about anything under ~500 ms is unsupportable.
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
