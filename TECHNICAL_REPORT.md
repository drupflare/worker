# Technical Report: Drupal on Cloudflare Workers

Drupal 11.4.7 runs on Cloudflare Workers with PHP 8.5 executing as WebAssembly inside a Durable
Object, using that object's own SQLite as the database. This document is the engineering reference
for that system: how it is put together, which platform limits shape it, what each operation costs,
and which classes of defect it has produced.

Every figure here is measured. The instrument is named in each table, because a local wall clock and
a deployed `cpuTime` reading are not interchangeable.

---

## 🧭 Executive Summary

The bundle ships PHP 8.5 with every extension Drupal requires and nothing dropped. The interpreter
travels as a raw `CompiledWasm` import, which the platform compiles ahead of upload, so startup does
no decompression and no runtime codegen. Cloudflare removed the compressed size limit on 2026-09-04
and the ceiling is now 64 MiB uncompressed, which is what made that possible; the zstd frame this
project shipped before it is gone from the path.

| | measured | instrument |
| --- | --- | --- |
| Worker bundle, uncompressed | **17,003,366** of 67,108,864 (25.3%) on 2026-09-29 | `bun run release:check` |
| PHP 8.5, `long64` variant | **2,671,745** bytes as a zstd frame; 12,234,575 raw | `interp.lock.json` |
| Isolate startup | **5 ms** median (n=4) of a 1,000 ms budget, was 106 | Cloudflare `Worker Startup Time` |
| Startup billed to a request | **0-1 ms**; it is not billed | edge `cpuTime`, 3 cold isolates |
| Cold boot | **1,264 ms** (n=4, 1,113-1,343), heap image off, which is the shipping default | edge `cpuTime` |
| Cold boot from a stored heap image | **1,912 ms** (n=5, 1,561-2,020), so a restore COSTS ~648 ms | edge `cpuTime`, two deployed arms |
| Cold boot, object held resident | **0 ms**; an 8 s alarm re-arm keeps one incarnation | 71 consecutive alarms, deployed |
| Share of requests meeting a cold boot | **not yet read**; `coldOfTraffic` in `src/ops/cold-encounter.ts` | `/serve-stats`, per site |
| Full uncached render, both bins emptied | **2,127 ms** (n=10, 1,982-2,579) | edge `cpuTime` |
| Authenticated page, RENDER path | **208 ms p50**, and it is the render path rather than the median | see the mixture below |
| Serving ceiling, free | **3.0M visits/month**, saturated at 1.00x | model over measured meters |
| Regeneration ceiling, free | **50,916 renders/day** at the shipping default, **10,866** with `MEMORY_CACHE_BINS=none`; the same on the alarm chain and the fill window | rows written on both arms |
| Wasm penalty against native PHP | **3.57x** warm, **3.94x** cold | local, ratio only |
| Re-render against a real VPS, tag-invalidated page | **30 ms against 24 ms**, 1.21x, server clocks, n=25 | `docker/vps.yml`, same machine |
| Re-render against a real VPS, dynamic page cache hit | **22 ms against 24 ms** | the shape a save leaves on every page it did not invalidate |
| Anonymous cached against the same VPS | **2 ms p50 / 4 ms p95** against 3 / 49 | same rig |

The bundle figure moves whenever `src/` does. Run the command rather than carrying a number.

### The Two Ceilings

Free's limits are aggregate daily budgets, not the 10 ms per-invocation CPU cap. The cap constrains
one execution unit and the architecture decides what an execution unit is: 20 Durable Object hops
accumulate 142 ms with no single invocation over 10 ms.

**The cap does not fail a Durable Object invocation, and it fails a Worker handler only under
sustained heavy CPU.** A single invocation reading **1,882 ms of `cpuTime`** completed on a deployed
free worker on 2026-09-07. A later probe ran ~1.5 s burns back to back: the object completed 10/10
at 1.35-1.54 s, while the Worker handler completed two and was then killed at 412 ms and at 10 ms on
every call after. The front worker's image transform does not meet that limit at page-load rates. On
a fresh free deploy, 1090 px transforms of a 3000x1571 JPEG ran 30 in sequence and 40 in two
concurrent waves of 20, at `cpuTime` p50 ~180 ms and max 493 ms, with every invocation reported as
`success`. Where between those two workloads the Worker limit sits is unmeasured.

| ceiling | what it limits | bound by | free |
| --- | --- | --- | --- |
| **Serving** | visits/month answerable at all | Worker requests, 100k/day | **3.0M/month**, saturated |
| **Regeneration** | distinct pages re-rendered per day | rows written | **50,916/day** |

**The regeneration ceiling now subtracts warming, and it did not until 2026-09-22.** `envelope()`
divided the whole 100,000 rows/day as though nothing had been spent before a visitor arrived.
`siteWarmEnabled()` returns true when the var is unset, so a warmed object is the shipping default
(since 2026-09-25 on paid; an unset value on free is the thermal policy's call), and at the 8 s
interval it spends **10,896 rows/day and 10,800 DO requests/day** keeping itself
resident. The published ceiling was therefore the ceiling of a configuration the product does not
ship. Subtracting it took the windowed figure **10,869 -> 9,685/day**, which was **10.9% lower**,
and the alarm-chain figure 2,777 -> 2,477.

**Both have since moved again, on 2026-09-23, and in the other direction.** Four modelling defects
were found in one pass, each by predicting the mechanism before the measurement and confirming it
against a control:

| defect | what it did | the control |
| --- | --- | --- |
| a cold fill priced at **180** sliced invocations | put the alarm chain at 2,477, DO-bound, 4x below the fill window | no slicing code exists; a deployed free worker drains a batch in ONE invocation, to k=20 |
| the audit harness charged its own `DELETE` | read `realRender` and `warmReassemble` one row high | both cold classes unchanged, since a `DELETE` matching no row writes nothing |
| `byR2ClassA` unconditional | capped regeneration at 33,333/day with no R2 binding | invisible until rows/fill fell below 2.65 |
| the class quoted instead of the mix | optimistic at the shipping default, where the class sits below the mix | the mix is honest in both configurations |

| arm | rows/fill | regeneration/day | bound by |
| --- | --- | --- | --- |
| `MEMORY_CACHE_BINS=none`, `realRender` class | 8.20 | **10,866** | rows |
| `dynamic_page_cache` in memory, warmth mix | 2.50 | 35,641 | rows |
| **shipping default**: `dynamic_page_cache` and `menu` | 1.75 | **50,916** | rows |

The alarm chain and the fill window now give the SAME ceiling, because the gap between them was the
180-slice constant. Duration would take over only below ~0.27 rows/fill.

**`menu` joined the default on 2026-09-23, chosen by a census rather than by being a Drupal bin.**
Each reconstructible bin was held in memory on a fresh object, in the audit's sequence so its figures
map onto the model's classes:

| held in memory | rows/fill | regeneration/day | bound by |
| --- | --- | --- | --- |
| `dynamic_page_cache` | 2.50 | 35,641 | rows |
| + `menu` | 1.75 | **50,916** | rows |
| + `render` | 2.25 | 39,601 | rows |
| + `discovery` | 2.40 | 37,126 | rows |
| + all three | 1.40 | 63,645 | rows |

`menu` is the only candidate that writes on a warm re-render, the class carrying 70% of the mix, so it
is the largest single step. Adding `render` and `discovery` on top takes a fill to 1.40 rows and the
ceiling to 63,645, and both were refused on costs the rows census cannot see. Both refuse a stale
entry. `discovery` sat at its 64-entry bound, evicting, and added 12.4 MiB of heap. `render` fit the
heap but made the first render after an interpreter drop 2,696 ms against 1,450 (medians, n=10,
deployed, forced recycle), for about 1.5% of a free day's rows. The shipped two cost a cold
reassemble 1,324 ms against 1,073 all-SQL and stay, because they take a modelled free day's rows
written from 72% of the quota to 32%. Every arm produced a page
identical in CONTENT, not just length, once two values were normalised that have nothing to do with a
cache bin: the random `form_build_id`, which `Html::getId()` shortens by a byte whenever the token
contains consecutive hyphens, and `permissionsHash`, an HMAC keyed on each site's randomly minted
private key. `menu` also refuses an entry whose tag checksum moves through SQL alone, which matters
more for it than for any other bin, since a menu save invalidates every cached page.

**Duration does not bind, measured on a deployed object.** A steady-state fill costs 209-308 ms of
wall clock with three bins emptied (n=9) and 52-95 ms reassembling from a warm dynamic page cache
(n=18); the first fill after an idle boots and costs 4.5-8.4 s. `x-worker-ms` agreed with billed
`activeTime` to within 2-6%. Priced at the 308 ms maximum, duration allows 329,748 fills a day. Until
2026-09-24 the model priced a fill at the 2,127 ms cold-bins figure, which made duration read as
binding at 47,749.

**Each class is priced on its dearer path.** `/user/login` realRenders in 8 and reassembles in 1; `/`
realRenders in 3 and reassembles in 2, because the login form carries six `dynamic_page_cache`
variants to the front page's one. So `realRender` comes from login and `warmReassemble` from `/`.
Setting the reassemble to the login figure made the warmest priced class undercut a real fill, and
`fill-bins.spec.ts` failed on exactly that.

The row half of that was 12,240 until the daily meters stopped checkpointing on a flat 60 s clock.
`meterFlushBudget()` scales both flush triggers with the remaining budget and answers the old 25
rows and 60 s at the ceiling, where a lost count could change a decision; a warmed site now
checkpoints 96 times a day rather than 1,440.

`thermal.ts` declines to warm a site below about 505 renders/day, so this is not every site. A site
AT the regeneration ceiling is rendering far above that crossing by construction, which is what makes
the subtraction right for the ceiling specifically. `envelope({ warmed: false })` is the control and
answers 10,869.

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

**This meter is now opt-in.** The default toolkit encodes in the front worker over
`@gmitch215/tinyimg` and has no transform allowance at all; it spends CPU, which neither ceiling is
bound by. Cloudflare Images stays reachable at `IMAGE_ENGINE=images`, because it is the only one of
the two that encodes AVIF, and the meter above is what that choice costs.

**Durable Object duration** is 13,000 GB-s/day on free, billed against the 128 MB an object is
allocated regardless of use and on wall clock rather than CPU. At today's traffic it does not bind.
The exposure is hibernation eligibility rather than arithmetic; see Hibernation below.

### Where It Wins

The architecture wins by not rendering rather than by rendering faster. An uncached render costs
**2,127 ms** of edge `cpuTime`, and one Durable Object is one thread that cannot be made bigger.

**A site is no longer one object.** That sentence used to end here, and the second half of it -- "so
a site is one thread" -- was a property of the topology rather than of the platform. A namespace
holds unlimited objects, an authenticated GET writes no authoritative state under this SAPI, and a
site now has replica lanes. The measured curve -- **1.00 / 1.72 / 3.64 / 7.10 / 15.19x at 1 / 2 / 4 /
8 / 16, 95% at sixteen** -- was taken with `?lane=N` addressing each object DIRECTLY, so it is a
statement about the topology: N objects, driven separately, summed.

**Routed throughput is a different and smaller number, and it is measured now: 4.74x at 16 lanes
(16 clients) and 4.54x (64 clients)**, driven through the front worker with the affinity hash
choosing the lane and the primary also serving bucket 0 and feeding replication. The latency effect
is larger than the throughput one, p50 falling 16.4x and 24.8x. Four defects had to be fixed before
any routed reading meant anything; see the Replica Scaling section.

Per-object, driven alone on a deployed paid worker: **31 authenticated renders/s at p50 216 ms**, and
**268 cached pages/s at p50 ~20 ms**.

**Writes spread too**: a lane runs the write, discards its own effect and forwards the statements to
the primary, which stays the sequencer. What still serialises there is the commit itself and any
write whose target originates a value a lane may not mint.

**There is a VPS arm as of 2026-09-07.** `docker/vps.yml` runs nginx and PHP 8.5 FPM with opcache and
tracing JIT against the same Drupal tree and the same site database this project serves, so the
runtime is the only variable. On the anonymous cached path drupflare wins outright: **2 ms p50
against 3, 4 ms p95 against 49**, and at 32 concurrent clients it holds 438 req/s while the VPS falls
to 122.

**THE RE-RENDER FIGURE THIS SECTION CARRIED WAS TAKEN THROUGH A BROKEN ARM, and all three parts of it
were wrong.** It read 32 ms against 25 ms, 1.28x. Re-measured 2026-09-19 over n=25 with the arm order
rotated per cell:

- **The drupflare arm rendered nothing.** It drove `/bump` then `/fill` and timed a bare `/fill`; the
  bump re-queues paths and arms the fill alarm, `fetch()` holds the gate, so the timed call waited
  behind that batch and then found an empty queue. Six of seven samples answered
  `{"filled":null,"remaining":0}`. The published number was gate-queue time.
- **The VPS arm rendered a different page.** Its `vps-db` volume is not re-seeded by `vps:up`, so it
  held content from an earlier run: 23,284 bytes and ten node teasers against drupflare's 17,692 and
  none. After `vps:down -v`, the two agree to 0.2%.
- **Nothing guarded either.** There was no check on cache state, body size, or whether a render
  happened, and the render cells ran `vps` then `edge` in fixed order while the curve cells rotate.

Corrected, on the arms' own server clocks with `X-Drupal-Dynamic-Cache: MISS` verified on both sides:
**30 ms against 24 ms, 1.21x**, of which 1 ms is the no-work Durable Object hop. Two further runs the
same day read 1.36x and 1.21x on a machine carrying 9.9 GB of swap, so treat that spread as the
resolution rather than the measurement.

**The ratio applies to fewer pages than it appears to.** A save calls `purgeForTags()`, and
`bumpGeneration()` leaves `dynamic_page_cache` alone on that reason, so only tag-matched entries die.
Every other re-queued page renders from a dynamic-page-cache hit at **22 ms against the VPS's 24**,
which drupflare wins. The old rig purged the whole bin and so measured the worst case as if it were
the common one.

**An external review divided 2,127 ms by 9.47 ms and published 225x.** That is the both-bins-emptied
edge render over the native warm-kernel render: two workloads, two instruments, two machines. It is
the same shape as the `34 ms` error below and it is worth recognising on sight, because the numerator
and denominator were each correct.

**The authenticated arm was measuring a tier that could not run, and that was the finding.** The first
reading was 9 ms against 31 on a logged-in front page. Capturing `x-cfw-plan` on every sample -- which
the rig had been discarding -- showed `skip:set-cookie` on six consecutive authenticated GETs.
`planEligibility()` refused any render whose response carried `Set-Cookie`, and PHP re-sends the
session cookie on every `session_start()` when `session.cookie_lifetime` is non-zero, which Drupal
ships at 2000000. The compiled-plan tier had therefore never compiled a plan on any site, and its 25
covering assertions all passed a synthetic `setCookie: false`.

Two further refusals sat behind it: the tier needs two DISTINCT sessions of a role set to agree, so a
single-editor site never produced one; and two sessions of one role set differ in exactly one value on
an authenticated page -- the session CSRF token in the logout link -- for which `PlanSlot` had no kind.
Measured: two renders of `/`, 103,697 bytes each, one varying token in two places, every
`data-contextual-token` identical.

With `rotatesSession()` comparing the response's cookies against the request's jar, a `csrf` slot that
is substituted rather than generated, and a private key for a site that will never have a second
witness, one session driven sequentially converges at request 4 and holds:

| path                     | VPS converged p50 | drupflare converged p50 |
| ------------------------ | ----------------: | ----------------------: |
| `/` authenticated        |             11 ms |                **5 ms** |
| `/admin/content`         |             71 ms |                **5 ms** |
| `/user/1`                |             56 ms |                **5 ms** |
| `/admin/structure/types` |             18 ms |                **6 ms** |

Under concurrency drupflare wins every cell but one tie, and holds ~312 req/s flat from c=4 to c=32
while the VPS declines from 204 to 144 on the front page and 67 to 62 on admin. The generator's own
ceiling on the same machine is 8,308 req/s against nginx and 1,231 against the front worker, so
neither arm is generator-bound. Still local, still one workerd, and the replica pool's 3.29x is not
in any of it.

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

The manifest records **75 chunks / 1,370 rows / 1,669 statements**; it moves with the packed
database, so read `assets/drupal-sql/manifest.json` rather than this line. A live
migration drove exactly 79 of the 79 a then-current manifest held, at **max 3 ms of edge cpuTime per
chunk, 0 chunks over the 10 ms cap**. In one invocation the same work was 3,467 ms.

**Divisibility, not speed, is what made it fit.** A JavaScript loop can be split at any statement
where a synchronous `php._run()` cannot. There is also a smaller unit than a row: SQLite builds a
value across statements with `col = col || ?`, which is how three 520 KB rows became divisible.

A half-migrated site refuses to serve.

**The pack's router has to match the packed driver, or every new site rebuilds it.** Measured
2026-09-25: with the packed router four routes short of the driver's six, reconciliation rebuilt the
router in PHP on each fresh site's first cold alarm, and that invocation was reset for the isolate's
memory with the first visitor waiting, 8 of 8 throwaways. Rebuilding the pack database against the
current driver took two more to 0 resets across six cold visits. `driver-pack.spec.ts` compares the
packed router with the driver's routes and permissions.

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

**An external database is reachable from the object through Hyperdrive.** `DB_BACKEND=hyperdrive`
routes the driver's statements to PostgreSQL or MySQL through the park. Verified 2026-09-25 on a paid
throwaway: a Durable Object ran `SELECT 1` through a Hyperdrive configuration backed by a Workers VPC
service and a Cloudflare Tunnel, in 6-9 ms of query time. `docs/external-database.md` has the TLS and
permission requirements that surfaced.

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
both autoloader sites -- `src/site/php/settings-override.php` and the boot fragment in
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

**This said a Redis cache backend cannot be built, and `drupal/redis` is `verified`.** The reasoning
was correct about the DEFERRED tier -- a cache get has to answer inside the request that asked, and a
deferred exchange always misses the first time -- and it closed the objective along with the
mechanism. `ext/cfwpark` freezes the Zend continuation, `longjmp`s out of `pib_run`, and
`src/ops/park-drive.ts` performs the socket exchange in JavaScript before resuming the same PHP call,
so the answer arrives inside the request. Measured against the rig Redis: PHP opens a socket, writes
and reads twice, and receives `+OK|+PONG` over five parks.

The object's own SQLite remains the DEFAULT backend, which is a placement decision rather than a
limit: a configured external Redis costs nine parked round trips per render, ~9 ms same-region and
~477 ms distant. The deferred tier in this section is what a refused park degrades to, plus `syslog`,
which never replies and therefore never wanted a park.

**Mail.** `CfwMail` passes `smtp.settings` through `mailEnvFromSite()`, so a site that configured
`drupal/smtp` needs no Worker vars; the deployment's own vars win every field they set. The settings
are persisted to `cfw_meta` because the alarm re-resolves the transport and never sees the message.

### Identity

**Host-side pre-exchange is not the only route.** The argument against the alternative
was that `WITH_OPENSSL=0` leaves the interpreter unable to verify an RS256 `id_token` at all, so even
a synchronous token fetch would hand PHP something it could not check -- and an unverified
`id_token` is an unauthenticated login. Both halves have since moved. `src/drupal/openssl-fix.ts`
bridges `openssl_sign` / `openssl_verify` / `openssl_pkey_get_public` over `node:crypto`, and the
park carries the token POST and the userinfo GET, so **`drupal/openid_connect` completes a login
through its OWN client**: `park-oidc.spec.ts` drives a real authorization code from the rig Keycloak
and `externalauth` writes `openid_connect.keycloak` into `authmap` against the id_token's `sub`.

`src/ops/oidc.ts` still owns discovery, PKCE, state, the token exchange and the signature check, and
`/oidc` still starts and completes. It is the route for a site that wants identity without installing
a module, and the control beside the module path rather than the only way through.

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
window, so ARMING an alarm costs a row and a DO request and buys no residency.

**Arming does not warm; firing under the hibernation threshold does**, because the firing resets the idle clock. The threshold
is 10 s, measured: re-armed every 8 s one incarnation survived 71 consecutive alarms, while at 12,
20, 30 and 45 s the constructor ran again on every probe. And the row cost was mostly the meters
counting their own writes -- 3 charged rows per idle tick, of which 2 were `flushDailyRows()` and
`flushDailyDoRequests()` recording themselves. With `shouldFlushMeters()` gating those, a tick
charges 1, and **92 sites saturate both meters rather than 277**.

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

The documented isolate ceiling is **134,217,728 bytes**, and it is not what resets an object. Ramped
on a paid object on 2026-09-25, retaining committed JS buffers until the module scope changed: 180-192
MiB held with no interpreter, so the budget is ~195 MiB; beside a freshly booted interpreter only
20-40 MiB more in six of seven ramps. A booted interpreter therefore costs ~165-175 MiB, its linear
growth afterwards is mostly already paid, and the JS side is what runs out. The table below is the
estimate `isolateNow()` computes, not the platform's meter. The shipping binary starts linear memory at
`INITIAL_MEMORY` = 67,108,864 (1,024 pages, 64 MiB) since 2026-09-30, 80 MiB before, and grows it where
the growth step puts it.

**A 160-module site on a deployed object, 2026-09-30** (farmOS, paid `cfw-e2e` throwaways, direct
readings from the tail and the platform's per-minute `memoryUsageBytes` unless marked):

| component | bytes |
| --- | --- |
| no interpreter (bundle and object) | 16.6 MB |
| linear memory, fresh isolate / warm | 83.9 MB / 114-118 MB |
| pack blob (per-file compressed, 41.7 MB raw across 11,540 files) | 12.2 MB |
| pack index | ~2 MB (a constant, not read) |
| lazy-FS and module-file caches, all resident MEMFS contents | 4.8-7.6 MB |
| SQL bridge strings | 1-17 MB per page, 0.98 MB largest reply |
| the rest (compiled wasm, V8 heap, uncollected garbage) | ~45-60 MB warm, unattributed |

Warm serving reads 196-201 MB and the minutes with resets read 213-215 MB, so the kill line is about
203-204 MiB: a large site runs within ~3-8 MB of it. A fresh isolate that rendered one page at 83.9 MB
linear was reset on its next event, so it held at least ~130 MB outside linear memory at that moment.
Workers expose no heap statistics; compiled wasm tiers plus uncollected render garbage is an inference.

**Where a fresh isolate's memory goes, and the 64 MiB start, 2026-09-30.** A fresh isolate that rendered
one page was reset before anything else happened to it, and each new isolate was reset the same way
(the reset spiral). Read with `durableObjectsPeriodicGroups` grouped by `datetime`, which gives one row per
isolate period, each arm on a fresh isolate after a redeploy with one request 78 s later so the
isolate's first row is its own baseline:

| fresh isolate, farmOS | over its own baseline |
| --- | ---: |
| no PHP at all (baseline) | 13-42 MB, by placement |
| an untouched 80 MiB `WebAssembly.Memory` | +84 MB |
| that memory plus the interpreter instantiated with stub imports | +1-4 MB more |
| PHP started and the site mounted (`/php`), 80 / 64 MiB start | 125.2 / 112.3 MB |
| boot and one anonymous render, 80 MiB start | 135.5-164.0 MB |
| boot and one anonymous render, 64 MiB start | 118.4-119.9 MB |

A deployed memory is charged at its full size whether PHP touches it or not, and instantiating the
module adds almost nothing, so the compiled code is not charged up front. The Drupal boot adds ~3 MB
and a render ~7 MB over `/php`, which puts the SQL bridge, the pack fetch and boot garbage well below
what matters. The remaining ~40-55 MB of `/php` is inferred to be code compiled as PHP starts plus the
JS objects the startup and mount build; nothing the platform exposes splits it further. Every arm
isolate served exactly one object, so co-tenancy does not explain the spread.

A render on farmOS demands 67-71 MB of linear memory, so an 80 MiB start reserved memory a fresh isolate
paid for and never used. **The shipping binary starts at 64 MiB now** (1,024 pages): 13-17 MB less per
fresh isolate at the same boot CPU. On a fresh farmOS deploy the lane went from 10/13 with dozens of
resets to 13/13 with none.

**A boot after a drop reuses the dropped interpreter's memory.** The next boot used to allocate beside
a dropped heap V8 had not collected: on the deployed farmOS every reset after a drop found the old
93-113 MB heap alive. The tuned binary imports its memory now (`withImportedMemory()`), and a boot
after a drop zeroes and reuses it, so an isolate never holds two heaps; interleaved speed against the
defined-memory binary read 0.984 and 0.995 (A/A 0.998). A consequence: the memory keeps the largest
size any interpreter reached, so `RECYCLE_ABOVE_BYTES` now sets the permanent linear size rather than a
point memory returns from. The pressure-buffer collector it replaced read success off a weak reference
to the small wrapper object, which dies in a scavenge while the heap needs a full collection.

**Re-derived on that binary 2026-09-24**, one incarnation read through `/__serve-stats`
`isolateBytes` after each step (a scratch spec in the workers pool, deleted after):

| step                                            | linear      | whole isolate          |
| ----------------------------------------------- | ----------- | ---------------------- |
| booted and idle                                 | 83,886,080  | 97,907,893             |
| migrated + firstrun, which drop the interpreter | 83,886,080  | 97,907,893             |
| `/admin/content`, then `/`, `/user/1`, `/admin/people`, authenticated | 107,216,896 | 125,387,248 (**93.4%**) |

The four authenticated pages land on one rung and stay there. The whole isolate is 8.42 MiB under
the ceiling; the rest of it is the resident pack blob (12,001,784), the merged index (1,980,912) and
MEMFS at its 4 MiB budget.

**The provisioning drops are still what keep that true.** With both commented out for the control
arm, the provisioned incarnation sits at 107,216,896 and the first authenticated render grows linear
memory to **136,970,240, past the ceiling on linear memory alone**, the whole isolate at 155,137,454.
The test pool does not enforce the limit, which is why the run continued; `recycleIfOversized()`
dropped it at the end of that invocation. The history below is the same mechanism on the older
96 MiB-initial binary.

**A pack update reset the object on a deployed site, 2026-09-25, and the container rebuild was
why.** Reproduced twice on a paid throwaway, both times on a deploy that moved the driver digest:
reconciliation empties `cache_container` and `cache_discovery`, the next fill rebuilds both inside
its render and completes (3,615 ms of CPU), and the invocation after it (75 ms) is reset with
`isolate exceeded its memory limit`, taking a waiting visitor request with it as a 1101 or 500. The
same two drops made by hand did not reproduce it (0 of 2). Both thresholds read clear at the time
(linear 107,216,896, the whole-isolate estimate 93.4%), so what crossed is the rebuild's garbage,
which the estimate does not see. Three closes: `recycleIfOversized()` now reads the whole-isolate
threshold that `oversized()` always had, a boot that rebuilt the container drops at the end of its
invocation, and reconciliation writes the pack's own container when one matches the site's
`core.extension` (the migrated pack and the claimed site, `drupal-sql/container.json`), so an update
needs no rebuild. Not yet read on a second deployed update.

**The whole-isolate estimate overcounts.** A deployed object answered 200 with linear memory at
121,176,064 plus the ~18 MB JS-side estimate, ~139 MB against the 134,217,728 ceiling, and then
recycled on the linear threshold. So a workers-pool ladder past 100% on that estimate does not show
a page resets the object: in the pool, `/admin/modules` read 103.8% and `/node/add/page` 115.6%
after a chain of heavier pages with the drops suppressed, and neither reset on the deploy.

**The figures below this point were taken on that older binary** and are kept for the mechanism;
the table above is the current reading. Measured on a deployed worker 2026-09-11 by reading all four
terms together for the first time:

| term                                     | bytes           | how                                     |
| ---------------------------------------- | --------------- | --------------------------------------- |
| linear memory, anonymous serving          | 100,663,296     | `HEAPU8.byteLength`                     |
| linear memory, authenticated plateau      | 113,770,496     | same, after an authenticated render     |
| pack blob, resident for the interpreter   | 12,001,784      | `lazyMountBytes().blob`                 |
| MEMFS contents                            | 4,193,165       | `LAZY_FS_BUDGET_BYTES` is 4,194,304     |
| merged pack index                         | 1,980,912       | `heapUsed` either side of a `JSON.parse` |

An ordinary anonymous serving object therefore holds **116,835,132 bytes, 87.0% of the ceiling**,
and an authenticated one **131,947,496, 98.3%, with 2,270,232 bytes spare**. Fifty uncached renders
move neither figure; linear memory does not leave its rung and MEMFS saturates at its budget.

Two consequences. The drop guard compared linear memory against `RECYCLE_ABOVE_BYTES` = 117,440,512,
which with the JS half added trips at 133,636,600 against a 134,217,728 ceiling -- 581,128 bytes of
margin, less than one growth step's slack. It reads `isolateNow()` against a whole-isolate threshold
now, and `/serve-stats` reports the four terms. And the index is measured by RETENTION rather than
file size: 1,324,155 bytes of JSON retain 1,980,912, so the serialised size under-reads it by a
third.

**That peak is per workload and the isolate is charged per incarnation.** `USE_ZEND_ALLOC=0` means
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

**The fix is at provisioning, NOT at the ceiling**, and the ceiling version was built first. A drop
keyed on linear memory runs BETWEEN invocations, and on a deployed paid worker the reset happened
INSIDE one: the first authenticated `/admin/content` on each of four freshly provisioned sites went
from the install's 108.50 straight past the limit in a single render, 4,661-4,936 ms of cpuTime,
`outcome: exception` with no message and no stack. So `/__migrate` and `/__firstrun` drop the
interpreter when they finish, the way `/__enable` always has, and the serving incarnation starts at
`INITIAL_MEMORY`. The peak over four authenticated pages is then 108.50, flat -- and that is LINEAR memory; the whole-isolate reading for a serving object is 87.0% of ceiling, above.

Confirmed on the edge rather than only in the gate: provisioning four fresh sites on the previous
build reset all four, and the same provisioning on the fixed build produced **zero** entries in
`wrangler tail --status error`.

**The drop is conditional on there being a real interpreter to drop**, which is not a detail. A
`{ stubbed: true }` renderer holds no wasm heap, so dropping it accomplishes nothing and removes the
caller's stub -- a migration spec drove itself to `done` and then answered 503 because the drop had
taken away the renderer it had installed. Reading `binary` unguarded threw
`Cannot read properties of undefined` out of `fetch()` on the refusal path of a half-migrated site,
which is a request that had been answering correctly before any of this was added.

**Cron was the first hypothesis and the measurement refuted it.** Both resets landed on an alarm
whose logs were full of the update module's deferred fetches, which reads as a cause and is not one:
a sweep of 16 firings moves linear memory by nothing at all, on a cold interpreter and on a hot one.

`recycleIfOversized()` drops the interpreter at the end of an invocation once linear memory reaches
`RECYCLE_ABOVE_BYTES`, default 117,440,512 (112 MiB) -- above the serving plateau of 108.50 and below
the first over-large rung, so a serving object never recycles and one that has just installed always
does. It runs BETWEEN invocations because the old module's memory is reclaimed only once it is
collected. Measured after: the ladder above ends at 96.00 and stays there.

**A fill batch is n workloads in one invocation, so the recycle cannot reach it.** The batch was
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
and two symptoms follow from that one flag: `memory_get_usage()` reads 0, and an 8M cap holds 38 MB with
no error. This paragraph also said the cycle collector never runs; it does. Measured 2026-09-30 over 16
authenticated admin renders on one interpreter, `gc_status()` read 12 automatic runs and 10,042
collected, and calling `gc_collect_cycles()` after every render left linear memory identical
(93.44 -> 102.50 MiB on both arms), so uncollected cycles are not what an admin session accumulates. The consequence is
availability rather than accounting: a runaway allocation does not stop at a catchable fatal that
loses one request, it grows linear memory to the ceiling and takes the whole object with every
session on it. `tests/integration/php-allocator.spec.ts` pins both symptoms and the collector running.

**Heap restore requires reproducing the open file-descriptor table at the same fd numbers.** Inode
alignment does not matter. Dropping `/dev/urandom`'s fd throws `RandomException`; dropping the three
sqlite fds gives a locking-protocol error after an 80-120 s stall, which on the edge is a hung
request.

### Bundle Size

**The ceiling is 67,108,864 bytes uncompressed, the same on free and paid, as of 2026-09-04.**
Cloudflare removed the compressed limit that day: "There is no compressed size limit. Only the
uncompressed bundle size counts." The tree measures a fifth of that; `bun run release:check` prints
the current figure, which moves whenever `src/` does.

Everything below this paragraph is the history of a meter that no longer exists, and it is kept
because most of the interpreter work in this report was scored against it. The free ceiling WAS
**3,145,728 bytes measured after Cloudflare's own gzip**. gzip cannot compress what is already
compressed, which is the entire mechanism behind shipping the interpreter as a compressed frame in a
`Data` module: it saved 997,878 bytes in one change, more than four times what an entire
extension-removal programme achieved. That frame is gone from the shipping path; the interpreter is a
raw `CompiledWasm` import, and startup fell from 106 ms to 5 ms with it.

`bun run release:check` and `scripts/measure/bundle-size.ts` were both still scoring the gzipped
figure against 3,145,728 and therefore FAILED a bundle that deploys. A gate enforcing a dead limit
reads exactly like a real regression; when a platform limit moves, grep for the constant.

**And the grep missed two, which is the part worth carrying.** `scripts/measure/php-version-headroom.ts`
and `scripts/measure/size-report.mjs` held their own copies of the same constant, and the first
carried a 148-assertion spec whose verdicts included *"reports both versions as not fitting"* and
*"clears the ceiling on the WASM ALONE, so no bundle accounting can rescue either"* -- for **PHP 8.5,
which is the version that ships**. A green test asserting the opposite of production is the strongest
form of this failure, and it survived the fix to the other two because nothing but its own spec
imported it. Both scripts and the spec are deleted; the arithmetic they did is answered by
`release:check` against wrangler's own `Total Upload` line, which is a measurement rather than an
estimate.

Their durable half, kept because it is expensive to re-measure and because it is the clearest case in
this project of an estimator bracketing the wrong number. Wasm plus glue, `gzip -9`, from binaries
that each passed `inspect-build.sh --expect-static --expect-rc`:

| PHP  |      wasm |    glue |     total | delta against 8.3 |
| ---- | --------: | ------: | --------: | ----------------: |
| 8.3  | 2,757,693 | 119,162 | 2,876,855 |                 0 |
| 8.4  | 3,756,464 | 122,782 | 3,879,246 |        +1,002,391 |
| 8.5  | 3,686,964 | 146,358 | 3,833,322 |          +956,467 |

Two facts no extrapolation produces. **8.4 cost 5.8x the pessimistic estimate** (+1,002,391 against a
bracket of +144,935 to +173,830), because 8.4 vendors lexbor inside `ext/dom` for
`Dom\HTMLDocument` and Drupal requires ext-dom, so no trim can reach it: as LTO bitcode
`ext/dom/lexbor` is 4,195,780 B in 8.4 against 0 in 8.3, while Zend, ext/standard and main each move
under 2%. And **8.5 is SMALLER than 8.4**, which an estimator that only climbs cannot express: 8.5
promotes lexbor to its own always-on `ext/lexbor` and drops the CJK encoding tables on the way
(`gb18030` 767,216 + `big5` 615,108 + `euc_kr` 600,052 + `jis0208` 254,996 + `jis0212` 194,244 B of
bitcode, replaced by one 825,364 B `multi.o`), which pays for all of `ext/uri` including uriparser
with change left over.

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

**The meter is isolate startup, NOT cold boot, and confusing the two overstates the headroom by an
order of magnitude in the flattering direction.** This inflate runs at module scope, so it is charged
to `Worker Startup Time`, not to the 1,398 ms figure -- which is a different meter, PHP's boot plus
Drupal's bootstrap, charged per invocation on a cold OBJECT, and one the warm and shell levers
already took from 3,391 ms to ~467 ms with boot at 0. Dividing by 1,398 instead gives 0.7%, which
prices it against the wrong meter.

**And on the edge the difference is NOT measurable.** Deployed to a throwaway on 2026-08-30, the two
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

**An earlier reading said "essentially a wash" and was taken under load**, with the full vitest gate
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

**That instrument is diluted and the negative is weaker than it looks.** The figure is a curl wall
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
- The largest untaken lever is the embedded PHP: the `String.raw` blocks in `src/drupal/*-php.ts` and
  three of the probes. `rg -o 'String\.raw' src | wc -l` counts them and `rg -l 'String\.raw' src`
  names the files; both move with the tree, so run them rather than reading a figure here. Two routes
  were priced on `wrangler deploy --dry-run` in 2026-08 -- stripping comment lines at build time, and
  moving the source out to the asset layer, which saved more and supersedes it. Both deltas were
  measured against a tree that has since moved; re-run the dry-run before quoting either. Neither is
  taken: the ceiling has room and the stripper has a hazard, since a `//` inside a PHP string is a
  URL and not a comment, so it must be line-anchored and gated on `php -l`.
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

Startup on the shipping config: **33 ms for the whole worker, of which the interpreter seam is 5**
(n=5, 4/5/5/6/7 ms, deployed free worker importing the seam and nothing else). The **104.0 ms** this
line used to carry was the brotli seam, and the zstd-through-wasm path it blamed read 233-246; both
are gone. A raw `CompiledWasm` import performs no runtime codegen, so the work that spent the budget
no longer runs.

This closes "pre-warm at startup" as a MECHANISM. PHP's boot is 1,398 ms of `cpuTime` against a
1,000 ms ceiling, so the interpreter cannot be booted at module scope. **Both supporting facts have
moved since that sentence was written, and only the first still carries it:**

- **The ceiling is a DEPLOY-time check**, the third row of the table above: exceeding it rejects the
  upload with error 10021 rather than failing at runtime. That distinction is what separates booting
  at module scope from a snapshot taken at deploy.
- **"its heap peaks near 115 MB against 128 MB" was measured on a binary that no longer ships.** The
  shipping `php8.5.tuned.wasm` declared 1,280 pages until 2026-09-30 (1,024 since) and read **83,886,080 bytes (80.00 MiB) booted
  idle** on `growth-ladder.ts`, worst case 92.69 MiB across the three real workloads. The Memory
  section below still states `INITIAL_MEMORY` = 100,663,296; those figures are the 96 MiB-initial
  binary's and are correct for it.

**AND THE 1,398 ms IS THE WRONG METER FOR THIS REFUSAL, measured 2026-09-23.** This document says so
itself under the brotli comparison above: 1,398 ms is "PHP's boot plus Drupal's bootstrap, charged
per invocation on a cold OBJECT". Only the first half can run at module scope, and it is cheap.

`cfw-startup-boot` on the free account, two arms differing by one boolean, byte-identical uploads at
13,611.11 KiB, `Worker Startup Time` read off each deploy:

| module-scope boot | Worker Startup Time |
| ----------------- | ------------------- |
| off               | 2, 2, 2, 2 ms       |
| on                | 91, 91, 106, 125 ms |

**Booting the interpreter at module scope costs about 96 ms of the 1,000 ms budget, and the deploy is
accepted every time.** The terminating observation is a file PHP wrote and the handler read back
through `FS`: `8.5.2|27`, so PHP 8.5.2 with 27 extensions ran there. `Date.now()` around the boot
reads 0 ms in both arms, which is the frozen clock recorded elsewhere here, so the upload meter is
the only instrument that answers this.

Three things the run established that were not the question:

- **`setTimeout` and random generation are disallowed at global scope, not only `fetch`.** The
  probe's own hang guard tripped it and the error names all three.
- **The tuned glue is built `ENVIRONMENT=worker` and reads `self.location.href`**, and workerd has no
  `location` at module scope, so a boot there needs a shim for it. Whether request scope has one was
  NOT isolated, because the shim was installed at module scope in every arm.
- **`PhpBase` is not optional.** A direct emscripten factory call reaches `pib_run` without
  `pib_storage_init` and without `/preload`, and dies as `RuntimeError: null function`. What caught
  it was running the identical code at REQUEST time, which failed identically; without that control
  the harness bug would have been filed as a module-scope refusal.

**What this does NOT establish.** Drupal's bootstrap is the rest of the cold path and cannot run at
module scope at any price: it needs the pack, the pack arrives by `env.ASSETS.fetch()`, `env` is not
a module-scope value, and `fetch` is the disallowed operation above.

**AND THE 96 ms IS NOT COMPARABLE TO THE EDGE'S "interpreter up" FIGURE, which is the comparison that
matters.** `/php` on a cold object reads **415 / 446 / 490 / 523 / 752 ms of cpuTime, median 490**
(n=5, free account, 2026-09-23) against the ladder's published 402 / 484 / 695 -- so that figure
REPRODUCES and has not moved. The gap to 96 ms is the Durable Object invocation plus the LAZY MOUNT,
which fetches pack blobs (`fetchMs` 32-242 across the same run). About 390 ms of the cold path is
therefore mount rather than interpreter, and the mount is exactly the part that cannot move to module
scope. Do not quote the 96 ms as a cold-boot saving.

**THE TENANCY OBJECTION STANDS, AND MY REFUTATION OF IT WAS A SMALL-SAMPLE ARTIFACT.** For one day
this paragraph said the opposite. `cfw-tenancy` drove six named objects twice each, saw six distinct
module-scope identities and no cross-object state in either JS or PHP's `$GLOBALS`, and concluded
module scope is per object. **A larger probe refuted it the same day**: burrow's `burrow-par-probe`,
907 Durable Object invocations across 171 isolates, found **32-40 isolates hosting more than one
distinct object and 7 hosting two LIVE objects interleaved** -- one object served, a different object
served from the same isolate, the first resumed there, both reading the same module-level state.
Cloudflare's own documentation says it plainly: a single isolate can host multiple Durable Objects of
the same class and they all share that isolate's memory.

Six objects driven twice simply did not land two in one isolate. **Module scope is per ISOLATE**, so
a module-scope PHP interpreter would be shared by every object that lands there, `$GLOBALS` included,
which is a cross-tenant leak. The rule this cost: a negative result over a handful of samples is not
a property, and placement is the kind of thing that needs a sample large enough to hit the collision.

Three constraints stand, and the first is now the decisive one:

- **Module scope is shared between tenants**, so nothing tenant-specific may live there.
- **`ctx.abort()` does not clear module state**, measured by the same probe, so a poisoned
  module-scope interpreter survives the one reset the object has.
- **The front worker evaluates module scope too**, and reported `interpreterBooted: true` for an
  interpreter it never uses. Anything expensive there needs guarding to the object, and module-scope
  linear memory is not reclaimable by `recycleIfOversized()` in any case.

Also recorded because it cost a deploy: **`Date.now()` returns 0 at module scope**, so an identity
minted there is the same on every isolate. Mint it lazily on the first request instead.

#### A Deploy-Time Snapshot Is the Surviving Mechanism, and It Is Not Exposed

Cloudflare's Python Workers snapshot the Worker's wasm linear memory at DEPLOY time, after executing
the entrypoint and everything it imports at top level, and ship that snapshot beside the code. Their
published figure is 10 s of init becoming 1 s, which is init an order of magnitude past the 1,000 ms
global-scope ceiling, so the snapshot path does not score against that ceiling the way module-scope
execution does.

Applied here it would capture a booted interpreter. **The prize is smaller than the 45% it first
looks like, and the module-scope measurement above is why.** The `cfw-bootphase` ladder puts generic
execution state at 466 of 1,036 ms, which bounds a two-level bootstrap at 45%; but a snapshot can
only capture what module scope can REACH, and module scope cannot reach the pack. The interpreter
boot is ~96 ms of that 466, so a snapshot of what runs there today is worth about 9% of a cold
render, not 45%. Closing the gap would mean the pack arriving as a bundled import rather than
through `env.ASSETS.fetch()`, which is its own change and is not scored. Either way it moves the
regeneration ceiling about 1%, for the reason under "Boot work is saturated" below.

**It is documented for Python Workers only.** Nothing states it is reachable from a Worker that is
not one, and a secondary summary asserting wider application is an inference with no test behind it.
The mechanism is unavailable, the objective stays open, and what to watch for is a configuration
surface on the snapshot.

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

**The 100,000/day cap did not refuse, so whether an asset or a binding hop counts toward it is
unmeasured.** Driven 2026-09-25 on the free account: 95,000 asset requests, ~7,300 worker requests,
4,765 requests making 20 service-binding hops each, then 100,000 plain worker requests as the
positive control. Analytics counted 209,512 invocations that day and nothing was refused, including
a probe every 20 s for 30 minutes after. A hop is its own invocation in `workersInvocationsAdaptive`
(94,540 of them, `clientDisconnected` because the caller does not read the body); an asset request
does not appear there at all. The serving ceiling the envelope scores against is the published
figure, not one observed as a refusal.

A zone Cache Rule is NOT one of them: a Worker route runs the Worker before the cache is consulted.
The Workers Caching feature does skip the Worker on a hit, but bills the request anyway -- and its
cache key omits the host, which for a host serving many sites at `/` is a cross-tenant leak rather
than a saving. `tests/node/cache-partition.spec.ts` refuses it in a shipping config.

## Measured Costs

### Boot

Boot is one synchronous `php._run()`. No cursor design cuts it up; it needs a JSPI build or a
permanently warm object, and **the warm object is now the one that exists** - see "Warming and the
10-Second Threshold".

**Why it cannot be split**, because "run it in slices" is the first thing anyone proposes. `_run()`
enters wasm and the wasm stack runs to completion. A wasm module compiled `ASYNCIFY=0` has no
suspension point in it, so there is nothing for a cursor to resume FROM: the JavaScript event loop
cannot interrupt a synchronous wasm call, and PHP's own execution has no yield primitive the host can
reach. Every other sliced thing here - the migration, `updb`, the cron chain - is divisible because
the division is in the host: each unit is a separate `_run()` with its state in SQL between them. A
boot has no such seam, because the thing being built IS the in-memory state.

The two mechanisms that would add a seam are the two named above. JSPI compiles in real suspension
points, and was researched and closed: zero of 62 surveyed modules needs one. **One of its two
refusals has since expired and is recorded here so it is not cited again.** The closure also said
`WITH_OPENSSL=0` meant JSPI could not have fixed the module that motivated it, because PHP could not
verify an RS256 `id_token` even if handed one synchronously. `src/drupal/openssl-fix.ts` now bridges
`openssl_sign()`, `openssl_verify()` and `openssl_pkey_get_public()` over `node:crypto`, all
synchronous, so PHP can take a JWKS entry and check a token. What survives is the rest: billed
duration is wall clock, a suspension trips two hibernation disqualifiers, and one object per site
means a suspended render stalls every other request to that site. A warm object removes the need for
a seam instead of adding one, which is why it is the answer that shipped.

**The lazy mount was named here as the decisive blocker and it is the wrong frame.** This paragraph
used to end "the lazy mount puts a JS frame under the PHP stack that JSPI cannot suspend across". Six
call sites put a JS frame under that stack and the lazy mount is the least dangerous of them, because
`materialise()` is a LEAF -- fflate and an assignment, nothing that re-enters wasm, so no suspension
can originate beneath it. The frame that actually threw `SuspendError: trying to suspend JS frames`
was emscripten's default SjLj rewriting every call out of a `setjmp`-containing function into an
`invoke_*` JS trampoline, and `pib_run` opens a `zend_try` before entering the VM. Every `pib_run`
died on a plain `-sJSPI` build, including `<?php echo PHP_VERSION;`. `-sSUPPORT_LONGJMP=wasm` routes
longjmp through wasm exception handling and introduces no JS frame; `vendor/static-jspisjlj` is that
build. The refcounted mask seam recorded as "designed and unbuilt" is `cartridge/src/mask.ts`, wired
at six call sites and pinned by its own spec; what is unbuilt is `zend_wasm_slice_raise` alone, which
costs latency rather than correctness.

**Asyncify is refused, and NOT for the reason that expired.** The bundle argument died with the
compressed size limit on 2026-09-04 -- the tree is 20.2% of a 64 MiB ceiling and could absorb the
growth. The reason it stays refused is per-call cost. `-sJSPI` aliases to `ASYNCIFY=2`, native stack
switching with no Binaryen instrumentation, and measures **-0.35%** on the bundle across phasm's own
three arms. `ASYNCIFY=1` is the instrumented transform, published at roughly +50% size and speed on
emscripten's benchmark suite with **SQLite the named 5x outlier because of its interpreter-like
function** -- which is PHP's shape with a bigger interpreter. The flag that makes Asyncify cheap,
`ASYNCIFY_IGNORE_INDIRECT`, is unsound here: this build is `ZEND_VM_KIND_CALL` with no global
registers, so every opcode dispatches through `opline->handler` as an indirect call. The `~42%`
figure this repository quoted in eight places was never measured on this configuration; no
`ASYNCIFY=1` arm has ever been built here.

So the surviving objective is unchanged -- a PHP request obtaining an answer that must arrive before
it finishes -- and the mechanism to reach for is JSPI, not Asyncify. It stays closed on the four
refusals above plus the reopening condition already recorded: a named site with a Tier C need.

**Zend fibers are NOT an alternative, and the reason is one level below where it was looked for.**
Proposed on the grounds that Zend already manages the continuation, so the wasm engine would not have
to. Measured on the shipping 8.5 binary: the class exists and is fully declared, and `->start()`
aborts the runtime with `Aborted(missing function: getcontext)`. php-src's ucontext branch calls
`getcontext`, `makecontext` and `swapcontext`; **emscripten implements none of the three**, and the
glue's abort-stub list is exactly those. `vendor/static-jspisjlj` carries the identical list, so a
JSPI build does not supply one either, and `-sSUPPORT_LONGJMP=wasm` cannot: it unwinds one direction
and `swapcontext` needs two. Emscripten's own `fiber.h` says a fiber build must link Asyncify, so
implementing the backend means adopting the transform already refused above.

The premise was true of the wrong primitive. A **generator** copies `execute_data` and the VM stack to
the heap; a **fiber** switches a real C stack. This project had already found the difference the hard
way -- `FIBER_SHIM` / `PhpWasmSyncFiber` exists in `src/drupal/site-php.ts` and
`scripts/patch-drupal.mjs` rewrites Drupal core's five `new \Fiber(` sites onto it, so core's own
fiber use is excised from the shipping tree.

**A Zend VM continuation is the first mechanism to survive its gate.** Measured 2026-09-08 on local
PHP 8.5.7 with `phpize`, a 200-line extension, **zero php-src changes and no wasm toolchain session.**

Every mechanism above assumed the external operation must happen while the PHP computation is still
ALIVE: JSPI preserves the wasm stack, Fibers a native C stack, speculative replay the request's
effects. The park inverts it. Freeze `execute_data` and the VM stack, which are both already
heap-backed, `longjmp` out of `pib_run`, return PENDING to the host, perform the I/O, then re-enter
`execute_ex()` at the saved opline. The wasm stack is destroyed at the park and that is the point --
the Zend state is the continuation.

A four-deep PHP chain parked at an internal call resumed correctly after `longjmp` destroyed every C
frame from `execute_ex` down **and crossed an open `zend_try`**, which is `pib_run`'s own shape. Every
layer's locals were intact and the host was healthy afterwards. It works because this build is
`ZEND_VM_KIND_CALL`: `ZEND_DO_FCALL`'s PHP-to-PHP branch takes `ZEND_VM_ENTER_EX()`, a tagged opline
pointer consumed by the dispatch loop rather than a C recursion, so an arbitrarily deep pure-PHP chain
is **one** C frame. `SAVE_OPLINE()` writes `EX(opline)` before the handler runs and `execute_ex` opens
with `LOAD_OPLINE()`.

**The failure boundary is narrow, and checkable before parking.** What cannot survive is the C locals
of an internal function that called userland and is waiting to resume. Measured: a park under
`array_map`, `usort` or `iterator_to_array` returns **`NULL` silently**, with no error and no
exception. Nested plain PHP, a discarded result, `try`/`finally` and `foreach` over an `Iterator` all
resume correctly. A predicate walking `prev_execute_data` and refusing when any frame between the park
and the host's VM entry is `ZEND_INTERNAL_FUNCTION` converts that class into a refusal. The Fibers RFC
names `array_map` as precisely why a general language feature needs a C stack; this needs three call
sites rather than a general feature. `call_user_func_array` is not such a frame -- it compiles to
`ZEND_INIT_USER_CALL` -- which covers Drupal's own dispatch.

All three blocking call sites measure clean. PHPMailer's `stream_socket_client` sits at depth 7 with
`internal_below_top` **0**; Guzzle's `curl_exec` at depth 15 through twelve middleware closures also
reads **0**; Predis, installed into a scratch directory rather than the packed tree, reads **0** at
every call site. The predicate refuses nothing the three libraries do. Guzzle's
`CURLOPT_HEADERFUNCTION` and `CURLOPT_WRITEFUNCTION` callbacks are userland frames inside libcurl's C
frame and DO read 1, so a park there throws instead of returning a wrong answer; the transport call
site above them reads 0, so the refusal guards a site the design does not use.

**The cost is measured, and a park is not a network round trip.** Count-and-continue against the
GreenMail and Keycloak containers pinned in `docker/compose.yml`: PHPMailer delivered a real message
on 3025, Guzzle took a 200 carrying an `id_token` from Keycloak on 8081, and Predis drove the rig's
Redis.

| operation | parks | network trips |
| --- | --- | --- |
| redis MGET of 20, one command | 21 | **1** |
| redis, a 9-bin render at one `getMultiple` per bin | 189 | **9** |
| one PHPMailer `->send()` | 57 | **13** |
| one authenticated OIDC login | 3 | **3** |

Only the first read after a write batch waits for the wire. The reads after it come out of bytes the
host already holds, so they cost a resume, and a transport that buffers need not park for them at all.
The generic rule needs no protocol knowledge: a write is buffered and flushed with the next
answer-requiring call, and only a read finding an empty buffer must park. That takes PHPMailer's 57
trapped calls to 13 and `drupal/redis` to 9 per render, the same order as SMTP. A cache backend was
the one expected to be per-request rather than per-operation, and at one `getMultiple` per bin it is
not.

**Two instrument errors produced a confident wrong reading first, and both were a number from an
operation that never ran.** PHPMailer never connected, because its validator rejects
`drupflare@localhost` for having no dot in the domain, and the table read 0 parks. The rig's Redis
runs `--requirepass testpass`, so without the password every command answered `NOAUTH` and the table
read one park per operation; a live `PING` is the control now. `fwrite` and `fread` also serve local
streams, and Guzzle writes each response body to a `php://temp`, so the counter reads the stream's own
`ops->label` and counts only `*socket*`.

**That build order was derived from the trip counts and the trip counts DO NOT decide it.** It read
`openid_connect` first at 3 trips, `smtp` second at 13, `redis` third at 9 per render -- ranking three
modules by cost without asking whether the park reaches any of them. Two of the three it does not,
and the order came out exactly backwards.

- **`openid_connect` cannot be parked through guzzle's own transport**, which is a narrower claim
  than the one first written here and it took two corrections to get to. The trip count came from a
  NATIVE php with ext-curl; the shipping interpreter has no curl, so Guzzle picks its `StreamHandler`
  and the call goes through a userland stream wrapper PHP invokes from inside the internal `fopen`.
  A park under that frame is refused, correctly, because `fopen`'s C locals cannot survive the
  `longjmp`. **The transport is what moved.** `Drupal\drupflare\Http\ParkFetchHandler` replaces it
  and yields from plain userland, so the module's own exchange runs: measured 2026-09-08 against the
  rig Keycloak at **2 parks per login**, the token POST and the userinfo GET, with `authmap` written
  and a session opened. The `3` above was a native curl reading and is superseded.
- **`smtp` never needed a park.** `MailManager::mail()` returns a bool and nothing in a render waits
  for delivery, so the send is deferrable by construction; `CfwMail` hands `smtp.settings` to the
  host transport and the module's socket never runs. Its 13 trips are real and they are spent by
  JavaScript after the response.
- **`redis` is the whole customer.** A cache get has to answer inside the request that asked, which
  is the one shape no deferred tier serves, and Predis speaks RESP over `stream_socket_client` --
  which a park does suspend under.

So `blocking-outbound` and `blocking-socket` are two capabilities in `catalog.ts`, and the park
satisfies the second only. One flag would have said the runtime can make a blocking HTTP call because
it can make a blocking socket one.

**And it now delivers, measured 2026-09-08 on the long64 build against the rig's Redis.** PHP opens
a socket, writes and reads twice, and receives `+OK|+PONG` -- five parks, each performed in
JavaScript on a LATER invocation and resumed back into the same PHP chain. A real Drupal render with
the traps armed reports `done`, which is the check that has to pass before arming anything: the
render goes through `cfw_park_run`, and that is `zend_eval_string` rather than a script.

It took two extension fixes and both had failed silently: `cfw_park_resume` did not re-arm, so every
trip after the first ran the real function down the refusal path; and the safety predicate's floor
was a frame belonging to the invocation that STARTED the chain, so on a resume the walk went past the
parked chain into reused VM stack memory -- reading first as a refusal and then as
`RuntimeError: memory access out of bounds`. A resumed chain now relinks its root to the resuming
frame, which is what `zend_generator_resume` does.

**Three instruments measured this and all three were wrong, in both directions.** The mechanism was
declared working and then declared impossible before it was either:

- **A flat native harness reported success.** Calling run and resume from the same scope puts the
  resume's frame in the slot the run's just vacated, so a stale parent pointer and the live one are
  the same ADDRESS and the walk terminates by coincidence. It printed `trips=3` and `DONE`; its
  remaining assertion, that each answer reached the call that asked, was never reached, because the
  test fataled on its own reporting line first.
- **A native PHP reported impossibility.** Homebrew 8.5.7 runs the HYBRID VM and the wasm build runs
  `ZEND_VM_KIND_CALL`. Native said a resumed chain never unwinds into its caller; the wasm build
  unwinds it correctly.
- **The capability vector could not express the capability.** A contract probe is one PHP expression,
  so its run and its resumes all land in one `_run` -- and a host able to answer inside one `_run`
  would not need a park at all. It is `socket.park.inline` now, named for what it measures, and
  `blockingSocket` is a literal beside `SHIPPED_CRON` for the same reason that one is.

**And it works on wasm, measured 2026-09-08 on a PHP built for it.** The gate above ran on a native
interpreter, which left one question: whether `EG(vm_stack)`, `EG(current_execute_data)` and the
opline behave the same when the longjmp is emscripten's rather than the platform's. They do, and the
output is byte-identical.

| check | native | wasm |
| --- | --- | --- |
| the C, D and E assertion set | 16 passed, 0 failed | **16 passed, 0 failed** |
| gate frame walk | `depth=8 zend_call_top=2 internal_frames=2 internal_below_top=1` | identical |
| gate result | `L1(10,L2(20,L3(30,conn-local-A\|ANSWER-FROM-HOST)))` | identical |
| host after the park | `array_map: 3,6,9` / `closure+sort: 1,3,5,9` | identical |

This needed no phasm session, which is the part worth carrying: `--disable-all` against a native
arm64 emsdk builds a wasm PHP in about 45 minutes and 503 objects, where phasm compiles PHP and every
dependency from source. php-src 8.5.11-dev, `ext/zendpark` linked statically, `bison >= 3.0` and
`re2c` from brew because Apple's bison is 2.3.

Five build defects, each of which presents as something else. `php_<ext>.h` must exist BEFORE
configure, because `PHP_NEW_EXTENSION` emits its include only if it finds the header then, and
without it the static link fails on an undeclared `phpext_zendpark_ptr`. The CLI link rule reads
`EXTRA_LDFLAGS_PROGRAM`, not `EXTRA_LDFLAGS`, so a first attempt linked with no flags at all and read
as the flags being ignored. `-sSUPPORT_LONGJMP=wasm` has to be set at compile time as well; at link
only it asserts `invoke_ functions exported but exceptions and longjmp are both disabled`.
`-sNODERAWFS=1` leaves `php://stdin` with no backing node, so `cli_register_file_handles` dies in
`fstat` before any PHP runs. And emscripten marks `getcontext`/`makecontext`/`swapcontext`
unsupported, which is a hard link error whatever `ERROR_ON_UNDEFINED_SYMBOLS` says -- **a second,
independent confirmation of the fiber result, at link time from `Zend/zend_fibers.o` rather than at
runtime from an abort stub.**

What that arm does not carry: emsdk 6.0.6 against the shipping 3.1.68, wasm32 (`PHP_INT_SIZE=4`)
against the shipping long64, emscripten's default SjLj rather than `-sSUPPORT_LONGJMP=wasm`, and the
CLI SAPI rather than `pib_run`. The lowering is the one variable already controlled for, because the
first probe measured both SjLj arms identical on the unwind and a park unwinds rather than suspending.

**What is unsettled is the duration meter rather than the mechanism.** The four refusals that closed
JSPI apply to a park unchanged: billed duration is wall clock, a park trips two hibernation
disqualifiers, one object per site means a parked render stalls the site, and a parked continuation
dies silently between 6 and 10 s idle.

A park has two billing phases, and conflating them is what makes it look expensive. **While parked
the request is IN FLIGHT**, so the object is not idle and the meter is the wall clock of the I/O,
`trips x RTT`. **After the answer is delivered** the object goes idle and `idleBilledSeconds()`
applies: a park that closed its socket leaves nothing open, so `hibernationEligible()` passes and the
cost is **0**; a park that leaks one is refused on `outboundSocket` for `min(held, 900) + 70` seconds.
So the `finally` discipline already asserted in `hibernation-lifecycle.spec.ts` is what decides this,
and a leaked socket dwarfs every trip count measured above.

`openid_connect` spends `2 x RTT` on one request per session over a stateless `fetch()`. `smtp`
spends `13 x RTT` on an alarm rather than a visitor request, because Drupal's mail queue already
defers it. `redis` spends `9 x RTT` on **every render that misses the page cache**, which is where
RTT multiplies.

**RTT is measured, 2026-09-08**, on a throwaway free worker whose Durable Object made N sequential
`fetch()` calls. Sequential because a park cannot pipeline: the PHP chain is frozen until its answer
arrives, so N trips are N round trips and a parallel reading would understate them. `Date.now()` is
the right instrument here and only here, for the reason RULE 0 was narrowed -- the clock is frozen
across synchronous PHP and does advance on I/O completion.

| target | n | min | median | max |
| --- | --- | --- | --- | --- |
| Cloudflare's own edge, the floor a colo-local service approaches | 12 | 0 | **1 ms** | 1 |
| a real IdP discovery document, the shape `openid_connect` fetches | 12 | 34 | **53 ms** | 65 |

So `openid_connect` costs **106 ms** of billed wall clock against a real IdP, once per session,
beside a login render that already spends 400-500 ms of CPU. `smtp` costs 689 ms on an alarm.
**`redis` costs 9 ms per render against a same-region Redis and 477 ms per render against a distant
one**, which makes it conditional on the customer's placement rather than affordable or refused
outright. The park does not decide that and cannot; the condition is measurable per site.

Two limits on the colo row, which is the flattering one: it is measured against Cloudflare's own edge
rather than any real customer Redis, so it is a floor and not a prediction, and a 1 ms median sits at
the meter's granularity, so it reads as "at or below 1 ms".

**The 106 ms is the provider's latency rather than this project's overhead.** A VPS running the same
module makes the same two trips to the same provider and pays the same 53 ms each, so
`openid_connect` on nginx plus PHP-FPM is no faster at it. What a park adds per trip is a VM re-entry
rather than an interpreter boot, because the executor persists across `_run()` and a resume re-enters
`execute_ex()` at a saved opline; that is unmeasured as an absolute and bounded well below 53 ms.

That figure is the MODULE's own client, which fetches neither a discovery document nor a JWKS: its
endpoints are configured on the client entity and `OpenIDConnect::parseToken()` decodes the id_token
without verifying it. The host's `/oidc` route does verify, and pays discovery plus JWKS on top --
which is where the caching below applies and where the earlier 3-trip figure came from.

For that route, only one of its three trips is per-login. Discovery and JWKS are per-provider and
static, so caching both takes it to **1 trip, about 53 ms**. Discovery needs no new fetch at all: the
Access page's Configure form already retrieves and renders the provider's discovery document at
configure time, so persisting it there removes the trip from every later login -- the same shape as
the compiled edge plan, doing the work once off the request that needs it. JWKS caches with a
`kid`-miss refresh, so a key rotation costs one extra trip on one login rather than a trip on each.

**One trip is the floor.** The authorization code is single-use and short-lived, so nothing can be
precomputed; there is no partial answer to render, which is why this is the one module with no
deferred fallback. A park also cannot parallelize -- the chain is frozen until its answer arrives --
so trip count is the only lever. The module's second trip is its userinfo GET, which is per-subject
and not cacheable either; `usesUserInfo()` is false for a client configured with no userinfo
endpoint, which takes it to the floor at the cost of trusting the id_token's claims alone. Below 53 ms is the provider's
placement: the same probe read 1 ms to Cloudflare's own edge, so a well-placed IdP lands far under
the public-IdP figure with no change here.

**What the same session measured and is new: the executor survives `_run()`.** `pib_run` performs no
`php_request_startup`/`php_request_shutdown` cycle -- `$GLOBALS` persist, a class declared in run 1
exists in run 2, and a `register_shutdown_function` registered in run 1 never fires. A generator
parked in `$GLOBALS` was suspended across a `_run()` boundary, resumed on a later invocation with a
host-supplied value, and run to completion on a third. That is a working suspension primitive in this
interpreter today, bounded by the coloring problem: `yield` suspends only its own frame, so it serves
code written for it and cannot retrofit Predis, Guzzle or Drupal's renderer. A parked continuation
also lives in linear memory, so `recycleIfOversized()` destroys one silently; anything built on it
needs a terminating observation rather than a bound, for the reason `/user/password` records.

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

#### Re-measured 2026-09-23 on `cfw-bootphase`, free account, and two of three hold

A throwaway deploy of the canonical config, seven sites, every arm tagged and read back through
`obs-cpu.ts` so each cpuTime joins to the request that produced it. Every render arm is controlled on
a byte-identical body of **17,686 bytes**, which is what makes the arms comparable at all.

| quantity                                    | published            | re-measured                                    | verdict          |
| ------------------------------------------- | -------------------- | ---------------------------------------------- | ---------------- |
| interpreter up, no PHP                      | 402 / **484** / 695  | 415/446/490/523/752, median **490**, n=5       | **reproduces**   |
| re-boot, warm bins (the 1,398 ms)           | **1,398**            | 1,214/1,259/1,328/1,370/1,432, med **1,328**   | **reproduces**   |
| both bins emptied (`RENDER_COLD_BINS_MS`)   | **2,127**, 1,982-2,579 | median **1,229**, n=13, 1,049-2,923           | **splits, below** |

**The first two have not moved and need no action.** The re-boot figure in particular is the one the
warming policy prices `P(render inside the hibernation threshold)` against, and it still stands.

**The third is not one workload, and that is the defect rather than drift.** `RENDER_COLD_BINS_MS`'s
own docblock names three entry points -- "a first fill, a cold boot or a container rebuild" -- and
they are not the same cost. Holding the bins empty and varying only `cache_container`:

| container            | cpuTime                                |
| -------------------- | -------------------------------------- |
| warm (1 row)         | **1,229** median, n=13, 1,049-2,923    |
| emptied before the render | **3,080**, n=3, 2,880-3,176       |

The published 2,127 sits between the two arms and its range overlaps neither. So the constant
describes a MIXTURE of container states, and a model that multiplies it is charging some sites for a
rebuild they will not do and under-charging the ones that will. **Splitting it is a change to
`scripts/economics/measured.ts` with pinned specs behind it, so it is named here rather than made.**

Three rig facts worth keeping, each of which cost a wrong reading first:

- **One `/migrate?site=X&all=1` returns `done: true` with an EMPTY `router` table.** A second call
  fills it (0 -> 423 rows). Until then `/` answers 500 with a 61-byte body and
  `RouteNotFoundException: Route "view.frontpage.feed_1" does not exist` in `watchdog`. Four samples
  were taken against that 500 before the body was checked; they cost 2,123-4,586 ms, which is close
  enough to a real render to pass unnoticed. `bootphase-drive.ts`'s `migrate()` returns on the first
  `done`, so it inherits this.
- **A 500 is not cheap here.** It boots everything and fails at routing, so its cost is dominated by
  the same boot a render pays. Status and byte count are the only things that separate them.
- **`warmInterpreter` is reported by `/drupal` and reads 0 on these arms**, which is what makes them
  cold-interpreter samples rather than an assumption.

**These figures predate the `cache_container` fix and the first-ever boot has since moved.** The
packed row was keyed to a stale `DrupalInstalled::VERSIONS_HASH`, so every site's first kernel boot
missed and rebuilt a 482 KB container. Measured on deployed paid workers, a new site per
sample, n=8 paired: 32.4% of a first-ever boot in fast mode (4,269.5 -> 2,888 ms) and 36.3% in slow
mode (9,210.5 -> 5,867.5 ms). The re-boot path the 1,398 ms measures is unaffected, because a warm
site already held its own built row.

**A second phase ladder, on the WARM-BIN path, bounds the two-level bootstrap at 45%.** The proposal
is to restore generic Drupal execution state once and attach tenant state per site, and the question
is what fraction of a cold path is generic. Measured on a deployed paid worker, `cfw-bootphase`,
cumulative `cpuTime` per phase, n=3:

| phase                 | cumulative cpuTime |
| --------------------- | -----------------: |
| autoload              |             451 ms |
| kernel-new            |             466 ms |
| container-read        |             510 ms |
| container-unserialize |             477 ms |
| kernel-boot           |             616 ms |
| pre-handle            |             660 ms |
| render                |           1,036 ms |

Re-read 2026-09-24 on the current build (`cfw-boot`, paid, n=5, rotated, tail `cpuTime` on the
object): 500 / 535 / 541 / 531 / 649 / 647 / **1,131 ms**, the same ladder within about 10%. The
~500 ms before Drupal runs anything is the interpreter and the lazy mount, and it is the largest
single phase of a cold boot.

Generic execution state is 466 of 1,036, so **tenant attach is 55% and is the majority**. A split
recovers at most 45%, of a cost the previous-generation read already removes from the visitor. The
mechanism closes; the objective is the cold path and the stale read owns it.

**Read the phases from object invocations only.** The near-zero samples in the same tail are the front
worker, and a median over both understates every phase. That mistake is what an unfiltered first pass
produced.

**Boot work is saturated for the regeneration ceiling.** Once the fill window amortises the boot,
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

**Past the threshold, retention decides, and placement decides retention.** A hibernated object's
next instance adopts the interpreter its isolate kept, in 100-692 ms against ~2.1-2.3 s booting, when
it lands in that isolate. Measured 2026-09-25 on 12 paid workers over four phases, every worker at
every interval, a PHP-needing request after 150-300 s idle, n=72 per interval:

| re-arm | adopted | on the 8 workers that ever adopted |
| --- | ---: | ---: |
| 30 s | 36% | 54% |
| 60 s | 15% | 23% |
| 90 s | 15% | 23% |
| 120 s | 14% | 21% |

Four workers adopted at no interval. `/serve-stats`, read seconds after each visit, showed
`retention.last: null` on every miss, which means no interpreter was in the isolate; the code refused
none. A 240 s re-arm adopted ~2%. So the declined default stays 240 s and 30 s is an opt-in.

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

**A firing is one request but three rows, not one.** The figure of 1 was reasoned from the published
"a `setAlarm()` is one row written" rather than measured, and `FREE_QUOTAS.rowsPerAlarmArm` carried
it. A firing charged three: the `setAlarm`, plus one
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
| neither lever | 1,264 ms | 2,127 ms | 3,391 ms |
| warm only | 0 | 2,127 ms | 2,127 ms |
| shell assembly only | 1,264 ms | ~467 ms | ~1,731 ms |
| both | 0 | ~467 ms | **~467 ms** |

The boot column is a measured subtraction. **The render column is derived across instruments** and is
the softer half: a fragment render measured 4-5 ms of gate-lane wall clock against 20-21 ms for the
render it replaces, and applying that ratio to an edge `cpuTime` figure assumes it transfers.

**The interval is now priced per site instead of being flat.** A flat 8 s re-arm charges the same
10,800 firings a day whether the site renders 50 pages or 50,000, and the band where warming is worth
paying for is bounded at both ends: below ~505 renders/day the firings outnumber the boots they save,
and above ~8,640 the site never idles 10 s and is already resident. `src/ops/thermal.ts` keeps a
64-entry ring of recent arrivals in memory, so the decision itself costs no rows, and warms only while
`P(render inside the hibernation threshold) x 1,398 ms` exceeds what a firing costs. An explicit
`SITE_WARM` still wins in both directions.

**The firing cost in that comparison was invented before it was derived, and it moved the policy.**
At an assumed 130 ms the crossing landed at 845 renders/day against the measured 505. It is 79 ms now,
derived from the crossing rather than guessed, and the spec asserts the two agree so a change to
either constant moves the policy rather than silently keeping it.

**Only renders count toward the rate.** A cached page answers off `ctx.storage.sql` without booting
PHP, so counting cache hits would warm a site whose traffic warming cannot help. And the rate divides
by the WINDOW rather than by the observed span: ten renders one second apart is a burst, and dividing
by the span reads it as a sustained ten per second, which is how a predictor talks itself into warming
a site that had one visitor.

**Prewarming after a save targets a route FAMILY rather than a URL.** The page cache is keyed on the
URL, so a visitor arriving on `/node/41` after a save meets a cold object even though `/node/40` is
stored. Warming one member of the family warms the interpreter every member needs.

### Writes

Deployed 2026-09-24 (`cfw-writes`, torn down), the shipping config, n=8 per class, one object per
class, each provisioned and warmed before the measured sequence. Rows are exact per call from
`scripts/measure/write-workloads.ts`; CPU is the object's per-invocation `cpuTime` from `wrangler
tail`.

| op | charged rows (min/med/max) | statements | replays | cpuTime ms (min/med/max) |
| --- | --- | --- | --- | --- |
| node-create | 48 / 48 / 58 | 21 | 4 | 39 / **49** / 1,337 |
| node-revision | 53 / 53 / 64 | 31 | 9 | 50 / **66** / 178 |
| user-create | 17 / 17 / 30 | 11 | 3 | 450 / **478** / 3,227 |
| file-create | 7 / 7 / 22 | 6 | 1 | 14 / **17** / 184 |
| alias-create | 24 / 24 / 28 | 15 | 2 | 15 / **18.5** / 73 |
| txn-autoinc | 2 / 2 / 2 | 3 | 0 | 3 / **4.5** / 19 |
| txn-rowid | 1 / 1 / 1 | 2 | 0 | 3 / **4** / 8 |

**The rows halved or better against the 2026-08-27 reading of 103 / 218 / 33 / 14 / 41, with the
same replay counts.** rom's `dependencyIndexesUpTo()` sends a replay only the statements that write a
table the asked-about statement touches, falling back to the whole buffer on any failure, so a
revision's nine passes no longer re-send every earlier statement. What remains is index maintenance:
`node_field_data` charges 11 rows per stored row, and it and `node` carry 41 of a revision's 56
locally counted rows. `tests/integration/write-amplification.spec.ts` prints the per-table split.

**A user create is 478 ms and ten times a node create on CPU while writing a third of the rows.**
That is the password hash, and it makes an account-creation burst a CPU problem where every other
write here is a rows problem.

**The max column is the first priced call of each class**, and on node-create and user-create it
paid a boot. Reporting a mean would fold a 1.3 s boot into a 49 ms write.

### Rows Per Fill

There is no single figure. A fill is **2 / 9 / 19 / 14 / 91 rows** depending on what is already
warm, and `ROWS_PER_FILL` in `scripts/measure/free-envelope.ts` names all five classes; the model
defaults to `realRender`. Count them from that constant rather than from this line. Every figure is
counted at the storage handle, so it includes the
host's own writes -- notably the `cfw_page` insert that stores the whole rendered page.
`tests/integration/rows-per-fill-audit.spec.ts` re-measures each class and pins it; three consecutive
runs read identical counts, so these are exact charges rather than noisy readings.

The most expensive class is the FIRST fill on a fresh object, because `cache_discovery`,
`cache_default` and `cache_routes` are populated once per OBJECT rather than once per path. It needs
its own class: charging every new path the fresh-object figure overstates a fleet six-fold, and
leaving it out understates each new site by one such event.

**The serve tables are `WITHOUT ROWID`, which is worth a row per fill.** SQLite gives a rowid table's
`TEXT PRIMARY KEY` its own unique index, so one logical write is charged twice. Measured on
`ctx.storage.sql`: insert 2 -> 1, update 1 either way, the serve HIT still reads one row, and 200
rows of 12 KB html cost +0.32% on disk. The cheapest class benefits most -- `warmReassemble` went
3 -> 2 rows, its index charge to zero -- and the windowed regeneration ceiling moved 7,575 -> 8,196.

**The same shape was worth more on drupal's own cache bins.** Every bin `DatabaseBackend` creates
keys on a TEXT `cid`, and `scripts/measure/index-audit.ts` reports 13 of the 14 with NO secondary
index at all -- so the autoindex WAS their entire index cost. `scripts/pack-sql.ts` now emits the 14
bins `WITHOUT ROWID`, and `Schema::createTableSql()` in the `cfw_do_sqlite` driver does the same for
a bin a module adds at runtime, which the packer never sees. Verified through Drupal's own installer.
Measured on a steady-state render at **8 charged rows -> 6**, bins' index
charge **3 -> 0**, n=3 with zero spread. Every warmth class fell with it: `firstFillOnFreshObject`
156 -> **103**, `firstEverForPath` 24 -> **14**, `realRender` 12 -> **9**, and `warmReassemble`
alone unchanged at 2 because it writes only `cfw_page`. The windowed regeneration ceiling moved
**8,196 -> 10,869/day**. Both of those are pre-warming figures and the ceiling has moved twice since,
for the reasons given under The Two Ceilings; the 1.33x this conversion bought is unaffected by it.

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

**Scoped invalidation needed an index, and the obvious index cost more than the feature saved.** A
content change used to bump the generation and purge every stored page, so a busy site spends most of
its regeneration budget re-rendering pages the change did not touch. Purging only the paths whose tag
set the write invalidated needs a `tag -> paths` mapping, and the natural implementation is a
`(tag, path)` table written when a page is stored. Measured, that took rows per fill from **9 to 39**:
thirty rows spent per fill to save fills, on the exact meter the feature exists to move. Carried
instead as a `tags` column folded into the page INSERT, the same mapping costs **0** and rows per fill
is 9 again.

`pathsForTags()` returns **null**, not an empty set, when any stored page carries no recorded tags. A
null falls back to the wholesale purge. A scoped purge that misses a page serves content a visitor can
see is wrong, which is worse than an extra fill, so an incomplete index must purge widely rather than
narrowly.

**A commit charges no rows of its own**, which closes batching as a lever on this meter. Forty
statements inside one `transactionSync` charged exactly what forty single-statement transactions
charged, and doubling the statement count doubled the charge. The per-statement term is the only one
that binds. The meter here is rows rather than a clock by necessity: `Date.now()` does not advance
across synchronous work in a Worker, so a duration taken around a `transactionSync` reads 0 and would
be a fabricated measurement.

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

**The table above was measured with the shipped cache-context memo disabled by the probe itself.**
`pw_install_probes()` swaps in a subclass derived from core's `CacheContextsManager`, which silently
removes `Drupal\drupflare\Cache\MemoizedCacheContextsManager` -- the same container-swap-measures-the-
wrong-object failure this document already records for the router and the census. Corrected by an A/B
on uninstrumented `renderMs` with no decorator on that service: **the memo is worth 1.85 ms/render,
7.7%** in wasm, against 9.7% recorded natively. So the shipping baseline is **22.58 ms, not 23.400**,
and the whole-render gap is **5.64x, not 5.85x**. The `cache_contexts` row above is the UN-memoized
cost and must not be quoted as what ships.

**The renderer is 5.85x, and it is the largest bucket on both sides.** A figure of 1.6x is out by a
factor of 3.7, and it is what the "the renderer is nearly native, so attack the plumbing" framing
rested on. That framing is retired: **everything is 3-6x except
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

**The one measured lever so far: CSS/JS aggregation, -3.2 ms/render, 14.3%.** `system.performance`
ships `css.preprocess` and `js.preprocess` at `false`, which is Drupal's installer default and gives
60 `<link>` + 11 `<script>` against 9 + 2, and 17,779 bytes against 12,304. Bracketed in both arm
orders with no probe decorators, n=40 per arm: median 21 -> 18, minimum 19 -> 16, p25 20.3 -> 17.7,
and the ON arm wins in both orders. It also removes ~5,400 bytes from every stored `cfw_page` row.
**And it is unshippable. The saving is real and the page it produces has no CSS and no JavaScript.**
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

**A cross-path shell is 80.5% of the bytes and 3-16% of the CPU. The direction is closed.** Anonymous
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

**The noise floor, measured on two provably identical arms.** A `cache.render` decorator that
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

**Why every memo lever has failed, in one table.** The repeat shape is a property of the LAYER, not
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

**That multiplier is NOT a share, and reading it as one misranks the work.** It is how much slower
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

**And the census lied until it had A control.** Nine of fifteen services were swapped into the
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

**Which of those two the producer actually writes is NOT a choice, and that is what closed the heap
image.** `snapshotStep()` fires on an alarm that arrives with no resident interpreter, boots
`BOOT_KERNEL` and images. It does not require the site to have been configured or served, so on a
fresh site it captures the COLD shape. A deployed probe on 2026-09-09 read **37,158,912 restored
bytes**, which is the 36,175,872 row above rather than the 9,699,328 one, and `linearMemoryBytes`
read 113,770,496 before the cold pass.

That reconciles a contradiction rather than overwriting one. An earlier deployed run measured the
image SAVING 314.5 ms, and it measured the 9.7 MB configured-and-served shape. The 2026-09-09 arms
measured 1,912 ms against 1,264 unimaged (n=5/4, ranges not overlapping) on the 36 MB cold shape, so
the restore cost ~648 ms. Both readings are correct about the image they took; the producer takes the
expensive one on the path that matters, which is a fresh site's first alarm. `HEAP_IMAGE` is off by
default because of it.

**The cost is the row count and the inflate, measured 2026-09-25.** Four paid workers at the same
instants, fully cold, an 11,206,656-byte elided image, n=12 per arm: no image read 2,303 ms visitor
wall and 1,704 ms object cpuTime at p50; the shipping 200 KB deflated rows (57) read 2,918 and 1,981;
2 MB deflated rows (6) read 2,550 and 1,823; 2 MB raw rows (6) read 2,345 and 1,639. Raw rows remove
the penalty and still only match booting, because this image replaces the kernel boot and nothing
after it. A warm image taken right after a render (53.1 MB, 27 raw rows, restored 12 of 12) read
2,366 ms wall and 1,603 ms cpuTime against 1,412 and 1,015 booting at the same instants, so no image
shape beats a boot.

Cross-site heap dedup is **34.7-38.0%** on a provisioned pair, n=7, and
`tests/integration/snapshot-dedup.spec.ts` holds it as a band. It read 33.09% until 2026-08-28;
nothing guarded the figure, which is how it drifted.

**It was then pinned to 37.79% on the strength of three identical runs, and that was the next
error.** "n=3 with zero spread" was read as an exact property of the pack and written into the spec
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

### Image Derivatives

The toolkit runs `@gmitch215/tinyimg` in the FRONT worker rather than in the object, so it never meets
PHP's heap. The module has zero imports and one memory, so wrangler's existing `CompiledWasm` rule is
the whole integration; the wasm header declares a 64 MiB maximum, which is a ceiling and not a
reservation, and 56 transforms of a 768x512 JPEG settled linear memory at 4,194,304 bytes and left it
there.

Measured on a deployed FREE worker, `cpuTime` amortised over 10 transforms per invocation, median of
12 invocations, with a source-only arm as the control at 0 ms. `victoria-sponge-umami.jpg`, 65,418
bytes, 768x512, all four shipped styles as WebP:

| style     |   px | laptop wall clock | edge cpuTime |
| --------- | ---: | ----------------: | -----------: |
| thumbnail |  100 |              3 ms |      36.3 ms |
| medium    |  220 |              7 ms |      48.6 ms |
| large     |  480 |             22 ms |      63.5 ms |
| wide      | 1090 |             32 ms |     188.2 ms |

**Laptop wall clock understated the edge by 6 to 12x**, and non-uniformly, so the local table could not
have been scaled into a threshold. `INLINE_TRANSFORM_MAX_EDGE` is 480 from this reading: `large` at
63.5 ms is produced during the request and `wide` at 188.2 ms goes to the fill queue.

**Build the source image once, outside the timed region.** Building the source PNG in JS dominates
every cell and reads ~130 ms flat across three styles that differ by 6x in real work. Caching it and adding
`?only=source` as a control is what separated the transform from its setup, and it is the same
shared-instrument shape as every other one on this list.

An image style is write-once-serve-many: Drupal generates a derivative on first request and serves the
stored file afterwards. So the CPU is paid once per derivative rather than once per request, which is
what makes a per-transform figure this size affordable.

**gd as a third engine loses to tinyimg.** libgd 2.3.3 with libjpeg 9f, libpng 1.6.44 and zlib
1.3.1, built with emcc 6.0.9 to a standalone native module (252,329 bytes, seven stubbable
imports), deployed beside tinyimg on a paid throwaway, n=20 each on the same 3000x1571 JPEG to
1090 px, `cpuTime`:

| engine           | median | range   |
| ---------------- | -----: | ------- |
| tinyimg to JPEG  | 184 ms | 118-322 |
| tinyimg to WebP  | 214 ms | 163-428 |
| gd to JPEG       | 294 ms | 199-495 |

It also cannot write WebP without libwebp, which the pipeline defaults to. Through burrow's dylink it
did not load: an interpreted side module needs its host to supply emscripten's `invoke_*` setjmp
calls, the allocator with `memcpy`/`memset`, and dlmalloc's `GOT.mem` globals. What gd would add is
the PHP functions for contrib code that calls them directly, which only gd inside the interpreter
provides.

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

**And the same shape survived real replication, which is the claim the table above cannot make.**
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

**The shortfall at 4 and 8 was the instrument, and the pool scales to 16.** The gap read as "not
attributed", and 16 and 32 as not worth building until a distributed generator
separated it. Re-measured 2026-09-10 on a deployed free worker with `?lane=N` addressing an object
directly so routing is not a variable, a fixed iteration count rather than a wall-clock loop, arms
interleaved, and an N=1 control on BOTH sides of the sweep:

| lanes |    vs 1 lane |
| ----: | -----------: |
|     1 |        1.00x |
|     2 |        1.72x |
|     4 |        3.64x |
|     8 | 7.10x, 7.20x |
|    16 | **15.19x (95%)** |

Generator ceiling 2,068-2,120 req/s against a maximum observed 77.6, so it constrains nothing.

The old curve is what an ASCENDING sweep produces when the baseline is taken once at the start and
one object's throughput decays during the run. **A single object steps to about 2x slower after ~180
requests / ~5 CPU-seconds**: traced at c=1 on a fresh object, `x-worker-ms` p50 per 30 requests reads
43, 55, 53, 49, 55, 54, **111, 106**. A linear pool plus that decay reproduces 5.72/8 exactly, with
no scaling limit existing at all. Little's Law was closing at 1 and 2 and opening a gap at 4 and 8
because the later arms ran on objects that had already decayed.

**The decay is real, reaches the shipping product, and is NOT attributed.**
`durableObjectsInvocationsAdaptiveGroups` returns no rows on free, so throttling and extra work stay
unseparated. An object driven 20 minutes read 1,431 ms on a path that starts at ~116. That is the
open question; pool scaling is not.

The method lesson is the transferable half, and this project had already paid for it once on the ABI
comparison: **an ascending sweep with the control taken once at the start cannot distinguish a
scaling limit from a time-dependent decay in the thing being scaled.** Repeat the control at both
ends, or interleave.

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

**The same curve on real Drupal, paid, authenticated.** The arm above burns fixed CPU; this one
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

**A fresh install does not hold `system.private_key`, so no replica could ever have been admitted
from one.** Drupal mints it on first use rather than at install. Enumerated on a just-provisioned
site, `key_value` carries `state:system.cron_key`, `state:install_time` and `state:install_task` --
and not that one. It is in `MANDATORY_STATE` because two objects each minting their own issue CSRF
tokens the other rejects, so `admissionVerdict()` refused every replica of a new site forever, for a
value the primary did not have either.

**This paragraph claimed the fix for three weeks and the fix did NOT exist.** It read "the primary
mints with `\Drupal::service('private_key')->get()`", and no call to that service appeared anywhere
under `src/`. What surfaced it was a local rig rather than a re-read: three lanes provisioned against
a migrated and claimed site sat at stage `CREATED` through **40** provision steps each, then reached
`VERIFIED` in **1** step each once a single `/user/login` render had minted the key. So the whole
replica pool was unreachable on any site nobody had rendered a form on, and every measurement of that
pool was measuring lanes that were never admitted.

`firstRunConfig()` mints it now, through Drupal's own service so the value is indistinguishable from
a lazily minted one, and `tests/integration/firstrun.spec.ts` derives the names it asserts from
`MANDATORY_STATE` rather than restating them -- a name added to that list would otherwise be a value
no new site holds with nothing reporting it. Falsified both ways: removing the mint turns two cases
red and leaves the unclaimed-site control green.

The general shape is worth more than the defect. A documented fix is a claim like any other, and this
one was cited as settled while the code said otherwise. `bun run check:reachability` catches a module
nothing imports and `MUST_BE_CALLED` now catches an export nothing calls, but neither can catch a
sentence in a document. Grep for the call before citing the paragraph.

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

**A lane's readiness is NOT routing state.** The obvious design gives the front worker a cache of
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

### A Lane Drives Itself, and the Staleness Bound Is Measured

`action=provision` on the primary creates and fills a lane, a bounded number of rows per invocation
with the cursor handed back rather than stored. It runs on the primary because that is the object a
caller can reach. Reaching `VERIFIED` arms the lane's alarm; each firing pulls `action=log` and
applies it; `admissionVerdict()` decides the promotion to `SERVING`. A lane below `SERVING` owns its
alarm chain at 2 s.

**A `WITHDRAWN` lane used to stay that way, and A deployed pool proved it.** The stage machine has
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
part to get right: the load that made the lane withdraw goes to the primary the moment
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
outside the `shouldFlushMeters()` gate the daily meters go through. Against the 10,869 rows/day
windowed budget of the day that bound serving at ~10,869 views/day rather than the 100,000 Worker requests/day
the tier is sized for -- a 9.2x reduction to count something already counted in memory for nothing.

The tell was two lines below the write: a comment explaining that `pageHits` is kept in memory and
never a row, because a `hits` column would spend the rows-written meter to decide how to save it. The
counter beside it was doing exactly that. Same family as the warming tick whose meters recorded their
own writes.

It now accumulates in memory and folds into one row every 50 views or on the meters' own interval,
whichever comes first. The threshold bounds what an eviction can lose; the interval is what a quiet
site relies on.

### Four Counters, Four Rows, and Comments Saying Otherwise

The fix above left `serve_requests` beside three other keys -- `rows_written_<date>`,
`do_requests_<date>` and `encounters_<date>` -- each written on its own `cfw_meta` row at every meter
flush. The inline comments read "folded in the same firing, so the counter costs no row of its own".
The folding saved the ALARM. Nothing folded the rows, so a flush on a trafficked site wrote **four**,
and rows written is the meter the counters exist to count.

`src/ops/day-meters.ts` packs all four into one dated row, the way `writeRenderWindow()` already
packs its two values. An idle warming tick's flush goes **2 rows -> 1** and a trafficked site's
**4 -> 1**, which is what moves `FREE_QUOTAS.rowsPerMeterFlush` to 1 and takes a warmed site from
13,680 rows/day to **12,240**, and to **10,896** once the checkpoint left its flat 60 s clock. `serveTotal` stays a lifetime figure inside the daily row and carries
forward, so `/serve-stats` reports the quantity it always did rather than quietly becoming a daily
count. The four keys are still READ while a day has no packed row, so an object upgraded mid-day does
not restart the counter its own degrade guard reads.

### An Arm Whose Docblock Described a Guard Nobody Wrote

`armFillAlarm()` sat under "Arms the fill alarm **without disturbing one that is already sooner**",
with a paragraph explaining why it could not await `getAlarm()`, above a body that called
`setAlarm()` unconditionally. Each call is one charged row and the callers are the hot ones: an
aged-page serve, every deferred HTTP call inside one render, and the mail queue. The comment beside
the first of those says "ON CONFLICT DO NOTHING, so a burst costs one row, not one per hit", which is
true of the INSERT and was false of the `setAlarm` on the next line.

The guard is an in-memory note of when the alarm this object last set is due, so it needs no await. A
twelve-path burst charges **12 alarm rows before and 1 after**, falsified both ways in
`warm-alarm-cost.spec.ts`. Every `setAlarm()` in `site-do.ts` records the note, which is what keeps
the guard from skipping an arm the chain needs: without that, a keep-warm re-arm 240 s out would
leave a pending +1 ms alarm believed, and the next MISS would sit behind the wrong one for four
minutes -- the exact failure `/__fill`'s own `getAlarm()` check was added to fix once already. A memo
lost to hibernation costs one extra arm and never a missed one.

### The Cold-Boot Share Was Counted Against the Leftovers

`coldOfAll` divided cold boots by the requests that reached the DURABLE OBJECT, under a module
docblock promising a denominator of "every request the front worker sees". A plan hit, an isolate
memo hit, a `caches.default` hit and a KV page read all return from the front worker: measured, the
edge tier alone answers **82%** of anonymous traffic. So the published share would have read several
times high the first time anyone read it.

The front worker now counts what it answers per isolate, per site, and reports it under
`x-cfw-absorbed` on the next request that hops anyway -- no extra request, the same trade as the
generation pointer and the auth-spend counter that ride the same response. `coldOfAll` is split into
`coldOfObject` and `coldOfTraffic`, and `coldOfTraffic` is **null until something has been reported**,
because a front worker too old to report and a site with nothing absorbed are otherwise the same
reading. An isolate that dies before hopping loses its count, which biases the denominator down and
the share up: the direction a missing reading has to fail in.

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

**THAT TABLE IS THE RENDER PATH, NOT THE MEDIAN AUTHENTICATED RESPONSE, and its own selection
criterion says so.** Every sample in it was filtered to `RENDER` rather than `HIT`, deliberately, so
that each one is a genuine render. What the filter discards is the compiled-plan tier, which answers
an authenticated page **in the front worker with no object hop at all** -- measured at 0 ms median
and 0 ms max, n=57 deployed. So a visitor's median authenticated response on a site whose plan has
compiled is a plan hit, and 208 ms is the p50 of the requests that missed it.

Quote it as "the authenticated render path", never as "an authenticated page". The mixture itself is
now counted rather than estimated: the front worker reports what it answered by itself on the next
request that hops anyway, and `coldOfTraffic` in `src/ops/cold-encounter.ts` is the share against
that denominator. Until a deployed site has reported one, the mixture is **unmeasured here** -- an
earlier audit put the plan tier at 429 of 600 authenticated samples, and that figure has no
instrument in this repository behind it.

**That is faster than the 467 ms figure, which was pessimistic.** Per-lane throughput therefore runs
2.9 req/s on a heavy admin page to 6.2 req/s on a light authenticated one, against the 2.14 the
sizing table used -- so the pool sizes derived from 2.14 are upper bounds and the real ones are
smaller. Latency and throughput both move; the sizing rule itself does not.

**Those figures require A quiet object, and serveable is NOT quiet.** A Durable Object is
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

### What a Replica Buys, and What One Costs

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
| neither lever | 3,391 ms | 0.29 |
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

**A cold replica costs nothing.** It arms no alarm, serves no request and is not billed for duration
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

**And the row meter is A cliff, NOT A throttle.** Spending it stops the whole namespace for the rest
of the UTC day: every route on every site answered `error code: 1101` with none of the worker's own
headers, and the tail records
`Exceeded allowed rows written in Durable Objects free tier.` thrown out of `ensureMigrateTable()`
inside `alarm()`. Diagnostics go with it -- `/serve-stats`, `/heap` and `/health` all 1101 -- so the
one thing an operator would reach for to understand the outage is the thing the outage removes.
Reached here by provisioning a handful of sites and running load against them, which is a
measurement session rather than a workload, but nothing about the cliff is specific to that.

### Geography, Measured Rather Than Argued

Every localhost comparison in this report gives the VPS a visitor standing in its own datacenter.
`scripts/measure/delay-proxy.mjs` puts a real delaying proxy in front of the VPS arm so its
connection pays a network, and `scratchpad/geo.sh <site> <ms-one-way>` runs the whole verdict
through it. Distances are Azure's published P50 round-trip inter-region figures, 30-day window
ending 2026-07-30.

| injected round trip | VPS weighted p50 | edge weighted p50 | ratio  | verdict |
| ------------------- | ---------------: | ----------------: | -----: | ------- |
| 0                   |          14.8 ms |            9.9 ms |  1.50x | one p95 regression |
| 40                  |          56.5 ms |            8.9 ms |  6.35x | `viable: true` |
| 82                  |         100.2 ms |            8.9 ms | 11.32x | `viable: true` |
| 200                 |         218.0 ms |            9.4 ms | 23.09x | `viable: true` |

Three replica lanes, traffic-weighted across the workload mix, zero regressions on the three network
arms. The edge figure barely moves because the term being added is one a single-region host pays and
an edge network does not.

**The first version of this instrument inflated the result and its docblock asserted the opposite.**
It delayed every TCP chunk and claimed that was "exactly as a real path does". A real path pipelines
segments: a multi-segment response pays about one round trip to first byte and then streams. Charging
each chunk a full round trip makes a large response pay N times over, and the tell was in the numbers
-- `auth-admin` on the VPS arm read 627 ms at a 40 ms injection and 1,454 ms at 82 ms, far more than
the 42 ms difference can explain. It delays per FLIGHT now: a chunk arriving within 5 ms of the
previous one is forwarded without further delay. The same cell reads 106 ms at 40 ms injection, which
is its 66 ms of service plus one round trip.

The published ratios moved 6.61 -> 6.35 and 12.78 -> 11.32. An estimate of "nearer 9x" for the
second, made by hand before the re-run, missed in the other direction; it was labelled arithmetic
rather than a result for that reason.

Two limits travel with these figures. The proxy delays data rather than the TCP handshake, so a real
first visit pays a handshake and a TLS round trip this does not model. And the edge arm stays on
localhost and pays no network of its own -- Cloudflare's own real-user measurement, published
2026-09-26 across the top 964 networks, puts its median connect time at 49 ms including the last
mile. The last mile is paid by both arms and cancels; the distance to the origin does not.

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

**The 4 and 8 arms were not interpretable HERE, and a later run settled them.** The on-platform
generator saw 1,438 of 2,880 requests fail at N=2, and the run counted non-200 responses without
capturing the status, the Cloudflare error code, or the account's usage at that moment. Cloudflare
documents no general requests-per-second limit on Workers -- free has a 100,000/day request quota
that answers Error 1027 when exhausted -- so "free-plan rate limiting" was a guess and stays
withdrawn. The topology question it was blocking is answered above: **15.19x at 16 lanes, 95%**, on a
deployed free worker with the control repeated at both ends of the sweep. That is N objects driven
separately and summed; what a visitor gets is the routed figure in the next section, and it is
smaller.

### The Routed Pool, and Four Defects That Made Every Earlier Reading Meaningless

The figures above address each object directly, so they measure topology rather than the product. A
routed measurement drives the front worker and lets affinity choose. Every attempt at one before
2026-09-19 measured a pool that was broken in four independent ways, and each had to be fixed before
the next became visible.

1. **A lane pinned its own origin.** Drupal derives the session cookie NAME from the request host,
   and `canonicalOrigin()` pins trust-on-first-use PER OBJECT. Every lane had pinned the load
   generator's service-binding host, so each looked for a cookie no browser sends and resolved every
   visitor as uid 0 while holding the session row. The control: same cookie, same second, a lane with
   the pin repaired answered 200 `administrator,authenticated` and one left alone answered 421.
2. **`malformed()` required `generation === parent + 1`.** `sealGeneration()` seals one record per
   INVOCATION, so a sparse log is the normal shape and the shipped one held 360 records across
   generations 30 to 901. The first skipped generation refused a record, and a refusal withdraws the
   lane into a full re-copy.
3. **A snapshot was not sealed**, so a fresh lane landed off a record boundary and withdrew on its
   first record.
4. **`bufferForReplication()` opened a record with `parent: commitSeq() - 1`.** That assumes the
   invocation seals at the current sequence; it seals at whatever the sequence reached by the end, so
   a buffer opened at 69 could seal as `{parent: 68, generation: 70}` while record 69 already chained
   from 68. Two records claiming one parent, and a lane on the first met the second as `out of order`.
   This was the root cause; the three above were each necessary and none sufficient.

The instruments mattered as much as the fixes. `x-cfw-replica` named the ROUTING DECISION rather than
the object that answered, so a pool serving nothing read as one carrying the traffic; it names the
answering object now, with `x-cfw-failover` and `x-cfw-failover-reason` beside it. `lastCatchUp` is
overwritten by readmission before anyone can read it, so `lastWithdrawal` records why a lane left.

Measured with all four closed, authenticated admin pages, a fixed 20 second window per cell, served
count rather than a rate because a rate over elapsed time charges an arm twice for its own tail:

| lanes | served c=16 | vs 0      | p50 c=16 | served c=64 | vs 0      | p50 c=64 |
| ----: | ----------: | --------- | -------: | ----------: | --------- | -------: |
|     0 |          62 | 1.00x     |  5969 ms |          98 | 1.00x     | 16048 ms |
|     1 |          54 | 0.87x     |  7712 ms |          78 | 0.80x     | 33741 ms |
|     2 |          79 | 1.27x     |  3172 ms |         154 | 1.57x     | 10431 ms |
|     4 |          81 | 1.31x     |  2867 ms |         147 | 1.50x     |  6506 ms |
|     8 |         128 | 2.06x     |  1715 ms |         220 | 2.24x     |  6125 ms |
|    16 |         294 | **4.74x** |   364 ms |         445 | **4.54x** |   647 ms |

Zero failovers in all twelve cells, and all 31 lanes across the five sites were still `SERVING`
afterwards. Latency is the larger effect: p50 falls 16.4x at 16 clients and 24.8x at 64.

**What one lane is worth flips with saturation, and reading only the low-concurrency half of that
produced a wrong rule.** It loses below saturation, 0.87x at 32 clients and 0.98x at 64: affinity
hashes over two buckets, so the lane takes about 60% of the traffic onto an object with colder Drupal
bins while adding no parallelism. Above saturation it is decisive -- 2.06x at 128 clients, and at 512
a single object sheds every request as 503 while one lane serves 426. An `atLeastTwo()` floor was
briefly added to `laneTarget()` on the strength of the first two rows and removed when the 512-client
arm arrived; autoscaling fires on sustained queueing, which is the saturated regime.

**The saturated curve, driven separately.** 512 concurrent clients over 200 distinct authenticated
node pages per site, same 20 second window, on a generator carrying the shard-rotation fix:

| lanes | served c=512 | vs 1 lane | 500s |
| ----: | -----------: | --------- | ---: |
|     0 |        **0** | --        |    0 |
|     1 |          426 | 1.00x     |    1 |
|     2 |          814 | 1.91x     |   26 |
|     8 |    **1,889** | **4.43x** |    0 |

The 8-lane cell is the cleanest in the set: 1,889 served, 90.2% of them by lanes across all eight
objects, zero failovers and zero 500s at the highest load driven. **The 4-lane cell is withheld.**
Its site returned 199 500s in 1,518 requests where neither the smaller nor the larger pool returned
any, two hypotheses for it (per-object load, then lane count) were each refuted by the next cell, and
the rig was torn down before a re-drive could settle it. A site-specific fault is the surviving
explanation and it is unproven. The 32-lane cell is also withheld: it read zero lane-served requests
against a healthy pool, which is the routing defect recorded below rather than a throughput reading.
Arms at 64, 128 and 192 lanes were not completed.

This workload and the admin-page workload above are different measurements and must not be divided
into each other.

### A lane is paid for on the rows-written meter

Replication writes every primary row again on each lane, so a pool of N costs **N+1 rows per
change**. Rows written is the budget regeneration shares with everything else, so an
8-lane pool reaches that ceiling nine times sooner than a single object, and it is also the dominant
Durable Object cost line on paid -- requests, duration and storage are not close to it.

That makes the pool a lever for READ-heavy sites and a penalty on write-heavy ones, which no
document stated until 2026-09-19. `laneTarget()` scores read contention only: correct for what it
measures, incomplete as a sizing rule, since a write-heavy site can be told to grow a pool costing
it more than the queueing did. Sizing against the write rate is not built; `REPLICA_MAX_LANES`
is the manual bound meanwhile.

It is also what makes a scaling ladder expensive to measure. A lane provision is a full database
copy, so re-driving an arm after a fix re-pays that copy for every lane. Freeze the build before
measuring a pool, and price the ladder by lane count before provisioning it.

The errors in those cells are 503s rather than failures: the fill chain shedding rather than queueing
unboundedly. A status histogram from the 8-lane arm reads `{"200": 109, "404": 3, "503": 54}`. Shed
load belongs beside throughput, because a rate that discards a fifth of the offered load silently is
not a rate.

**Why one defect took the whole pool down, which is separate from the defects.** `catchUpOnce()`
answers ANY refused record with `WITHDRAWN`; readmission sets `CREATED`; a `CREATED` lane needs a
full 4.7 MB re-copy. A positional disagreement therefore gets the same response as database
corruption. `autoScaleStep()` then repairs one lane per alarm at a 4,000-row budget, so eight
withdrawn lanes take dozens of alarm cycles to return while the primary copies instead of serving.
That policy is unchanged and now has nothing to fire on.

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
| linear-memory headroom | 24.31 MiB | **19.50 MiB** | 5.00 MiB |
| blended CPU vs wasm32 | 1.000x | **1.001x** | 1.030x |

It buys the same capability as wasm64 for 21x fewer raw bytes, 5x fewer shipping bytes and 3.9x the
heap margin. The headroom row is LINEAR memory and the row above compares arms on that basis; the
whole-isolate figure for a serving object is 87.0% of ceiling, measured above. The CPU figures sit inside a self-control that reads **1.005x**, which is the harness's
resolution: `bun run measure:abi-control` loads one binary as two arms, so anything other than 1.000x
there is the instrument. Arms must be interleaved; run in series, machine contention inverts the
result.

**Re-measured 2026-09-07, once the bundle ceiling stopped being the deciding meter.** Control 1.008x;
long64 **1.001x** and wasm64 **1.027x**, reproducing the row above independently.

- **long64 against wasm32 is unresolvable by this instrument, not a win.** The two cases outside the
  control's range -- `floatmath` 0.956x and `packed` 1.088x -- are not mechanisms either ABI touches,
  and the cases that would move if it mattered read 1.047x, 0.997x and 0.999x. Post-rebuild code
  layout, the same artifact already recorded for `floatmath`.
- **wasm64's 2.7% is real and sorts by mechanism**: compile +10.6% and boot +11.1% for a module
  345,318 bytes larger, then `preg` +9.0%, `sort` +8.3%, `objects` +4.9%, `hashwrite` +4.6% -- the
  pointer-and-hash-traffic cases, which is what a wider pointer would cost.

Carry the TAILCALL precedent with either number: it measured **10.6% faster on this exact bench and
0% on a Drupal render**, because a render is bound by pcre, the host bridge and container
construction. So 2.7% is a ceiling on what wasm64 would cost a render, not a prediction. And the size
spread across all three arms is **0.5% of the 64 MiB ceiling**, so size cannot decide this and no
longer should be asked to. wasm64 stays closed on the 5.00 MiB of heap margin plus the measured CPU;
wasm32 stays closed on `PHP_INT_SIZE`, which one dependency's `php-64bit` constraint has already taken
a whole site down over.

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

`stepFor()` is per-ABI: **0.01 on long64 (0.13 until 2026-09-29), 0.08 on wasm32**. Applying wasm32's step to long64 makes it
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

**A cache baked at pack time is read, and it cuts CPU but not reliably wall.** `pack` mounts a layer
`scripts/bake-opcache.ts` captures from the `file` arm: 1,839 scripts, 8,581,446 bytes. Measured
2026-09-25 on two deployed paid workers, one cold first render per minute, then with the levers
swapped between the two deploys:

| run     | object cpuTime, `pack` | object cpuTime, `off` | visitor wall p50, `pack` | `off`    |
| ------- | ---------------------- | --------------------- | ------------------------ | -------- |
| first   | ~820-1,020 ms          | ~1,800 ms             | 1,482 ms                 | 2,291 ms |
| swapped | 1,204-1,524 ms         | 1,636-2,236 ms        | 2,341 ms                 | 2,286 ms |

CPU is the per-minute p90 from `durableObjectsInvocationsAdaptiveGroups`; wall is n=8 per arm. The
first run's wall gap belonged to the deploys. The layer adds its full size to the isolate estimate
(121.7 MB against 113.2 after one render, of a 134.2 MB ceiling), so it stays opt-in. Because
`validate_timestamps=0` never checks a cached script against its source, the descriptor records the
driver digest and the locked versions it was baked from, and the mount refuses a mismatch.

`USE_ZEND_ALLOC=1` is built as an arm and refused: it costs **2.66x the heap** (authenticated peak
342,294,528 against a 134,217,728 limit) and prints `munmap() failed: [28] Invalid argument` into
PHP's output stream, so in a render that text is prepended to the HTML. `emmalloc` costs +196,608
bytes on the binding workload. `IMPORTED_MEMORY` clears its precondition -- JavaScript owns the
`WebAssembly.Memory` -- and then fails on the next one: the module carries 15,619 data segments,
every one ACTIVE, writing 3,011,834 bytes during instantiation, so pre-filling splits the restore
phase rather than removing it.

`tests/node/abi-arms.spec.ts` pins the import/export shape and segment count for all four arms.

**Sharing the stack pointer with a side module costs 3.4% imported and 8.3% exported.** A side
module imports `env.__stack_pointer`, so an in-process extension needs the host's own global. Exporting
it stops the linker proving it module-private; phasm's `import-stack-pointer.mjs` instead moves it to
an `env` import after the link, keeping every global index. Interleaved on node, n=9, against the same
`long64` binary: 1.034x blended for the import (A/A 1.000x), 1.083x for the export. phasm's
`long64.rc` builds the import form. A side module has been linked only against the exported global,
so the import form is verified for PHP itself and not yet for loading one.

### Extensions

`get_loaded_extensions()` is the oracle, exposed on `/__php`, and
`tests/integration/loaded-extensions.spec.ts` asserts the platform map against it in both directions.
**27 extensions** on 2026-09-29: Core, PDO, Reflection, SPL, SimpleXML, Zend OPcache, cfwpark,
ctype, date, dom, filter, hash, json, lexbor, libxml, mbstring, pcre, pib, random, session, standard,
tokenizer, uri, vrzno, xml, yaml, zlib.

mbstring joined the list on 2026-09-08. There is still no iconv, gd, curl or openssl.
`DEFAULT_PLATFORM` is split into `NATIVE_PLATFORM` and `POLYFILLED_PLATFORM`, and a requirement met
only by a polyfill answers `unverifiable` rather than `installable`.

Function-name evidence is actively misleading: opcache's `func_info` table names functions from
extensions the build does not have.

#### The Nine Inherited Absences, Scored

`phasm/src/rc/control.rc` records that the zero-list was reconstructed from another binary's
`CONFIGURE_COMMAND` string, so most entries carried no reason at all. Scored 2026-09-08 by counting
unambiguous call sites across `drupal-src` -- core, vendor and 65 contrib modules -- with
`symfony/polyfill-*` excluded, because a polyfill DEFINES the symbol precisely when the extension may
be absent and counting it inverts the reading.

| extension | call sites | verdict |
| --- | --- | --- |
| `bcmath` | 0 | refused |
| `calendar` | 0 | refused |
| `exif` | 0 | refused |
| `phar` | 0 | refused |
| `intl` | 0 | refused |
| `tidy` | 2, both `webform`, one a Drush command and one its docs generator | refused |
| `xmlreader` | 1 file, `migrate_plus`'s XML data parser | refused, recorded as a ceiling |
| `zip` | core's `Archiver\Zip` unguarded; 3 contrib all `class_exists`-guarded | refused |
| `xmlwriter` | 2 contrib modules SUBCLASS it | refused; the stand-in is the implementation |

**`intl` reads zero, and the first run of the same census said 249 hits in 106 files.** That reading
was `Normalizer` -- Symfony's SERIALIZER interface, which Drupal's serialization module is built out
of -- plus a bare `Locale`. Against the unambiguous symbols it is zero, and core's
`composer.json` names no `ext-intl` while shipping `polyfill-intl-grapheme`, `-idn` and
`-normalizer`. The claim is bounded to the measured population: `drupal/commerce` requires `ext-intl`
hard and is not in this tree.

The composer channel agrees. Across those 65 modules the `ext-*` requirements are `ext-json` x4,
`ext-xmlwriter` x2, and one each of `ext-soap`, `ext-simplexml`, `ext-relay`, `ext-redis` and
`ext-dom`.

**The census found a defect, and it was in a polyfill rather than in a missing extension.**
`XMLWRITER_FIX` was inventoried against `simple_sitemap`, and its own docblock stated that nothing
calls `openUri`, `writeRaw` or `flush`. `xmlsitemap`'s `XmlSitemapWriter` calls `openUri()` in its
CONSTRUCTOR and `writeRaw()` on every link, so every sitemap generation on that module died on an
undefined method -- while the module read `verified`, because an enable-and-assert run resolves its
services and never writes a sitemap. Both methods are implemented now, `flush()` returns bytes for a
uri writer and the document for a memory one as libxml does, and three new cases in
`tests/node/xmlwriter-parity.spec.ts` compare against the real extension byte for byte.

Inventory a stand-in against every subclass in the tree, not against the one that prompted it.

#### gd, Refused on a Measurement

`drupal/core` requires `ext-gd` hard, so the question was whether a correctness gap follows from not
having it. It does not. `CfwImageToolkit::parseFile()` answers width, height and mime from
`getimagesize()`, which lives in `ext/standard` rather than in gd -- true of php-src and silent about
any given wasm build, so it was measured on the shipping binary with `gd` confirmed absent in the
same reading:

| file | reading |
| --- | --- |
| the shipped druplicon PNG | 88x100, `image/png` |
| a WebP from the delivery path | 80x91, `image/webp`, `IMAGETYPE_WEBP` 18 |
| a JPEG from the delivery path | 60x68, `image/jpeg` |
| a text file | `false`, which is what `isValid()` rests on |

So image fields store real dimensions, `max_resolution` validation runs, and a file that is not an
image is refused. What gd would add is pixel work inside the 128 MiB isolate on the fill path,
against a front-worker encoder that already produces WebP the isolate cannot. Zero of the 65 contrib
modules requires `ext-gd`, and composer never runs on the edge.

The ceiling that remains: contrib calling `imagecreatefrom*` directly gets `ShimRegistry`'s named
refusal, which `hook_requirements` already reports.

### mbstring

The polyfill is scored against the real extension as an oracle by `bun run measure:mb-parity`, over
the whole codepoint space of **1,112,064 scalars** (`0x110000` minus 2,048 surrogates) rather than a
sample.

| measurement | before | after |
| --- | --- | --- |
| the corpus, 1,302 cases as of 2026-09-07 | 77 | 47 |
| Drupal core's exposure within it | 33 | **10** |
| `mb_strtolower` over the full space | 95 | 0 |
| `mb_convert_case` titlecase | 273 | 0 |
| `mb_strwidth` | 9,733 | 0 |

**Read those from the instrument, not from here.** The corpus grows, and this table said 1,232 / 37
with a core exposure of **0** while `bun run measure:mb-parity` said 1,302 / 47 / 10; `packagist.ts`
carried a third figure. A parity count is a property of the corpus on the day it ran.

The tables are generated FROM mbstring and live on the asset layer (+1,034 gz there against +4,690
inlined). Generate them through workerd, whose `toLowerCase` is byte-exact against native mbstring;
node's ICU is 28 codepoints off. `tests/unit/drupal/unicode-workerd.spec.ts` runs the casing sweep
inside workerd on every commit.

Most of the remainder is invalid-byte input to `mb_str_split`, `mb_lcfirst`, `mb_trim` and
`mb_str_pad`, which is not closed by sanitising harder -- that regresses 19 cases that pass today.
What closes those is reproducing mbstring's error-marker model.

**Ten are reachable from core and they are one function.** `mb_convert_encoding($s, 'EUC-JP')` returns
`false` for every input including pure ASCII, where the extension returns bytes; GBK and
Windows-1252 substitute differently. Core has three call sites. The polyfill also defines 22 fewer
functions than the extension (`mb_strcut`, `mb_convert_kana`, `mb_parse_str`, the `mb_ereg_*` family),
and calling one of those is a fatal rather than a wrong answer; no caller exists in core or vendor.

Faking the extension is worse than either: a stub module entry **segfaults, exit 139**, because both
Symfony bootstraps branch on `extension_loaded('mbstring')` and the stub makes `iconv_strrpos()` and
`mb_strrpos()` recurse into each other.

Compiling it was refused at **+586,648 gz** against ~222,000 bytes of headroom, and that ceiling no
longer exists. Re-measured 2026-09-07 from a matched pair in `vendor/` differing only in this
extension (`static-o2` against `static-mbstring`, both 8.3.11 wasm32, 22 against 23 extensions):
**+1,097,508 raw bytes**, of which **+646,396 is data written into linear memory** across 3,601
additional active segments, and `WebAssembly.compile` +0.9 ms locally.

The speed case is close to absent, because the ASCII fast path already collected it. Three real
renders make 101, 112 and 114 `mb_*` calls, of which `mb_check_encoding` is 55-65%; on that mix the
shim costs ~120 us of a ~23 ms render, **about 0.5%**, and it is FASTER than the extension on long
ASCII `mb_strtolower` because it calls `strtolower()`. What reopens the question is the ten core
divergences, the 22 absent functions, and `ext-mbstring` moving from `POLYFILLED_PLATFORM` to
`NATIVE_PLATFORM` so contrib requirements stop degrading to `unverifiable`.

**Edge startup is measured, 2026-09-08: +2 ms, 0.2% of the 1,000 ms budget.** The same matched pair,
each arm imported as `CompiledWasm` and INSTANTIATED at module scope on a throwaway free worker, n=4
interleaved: `static-o2` 9 / 8 / 11 / 10 ms against `static-mbstring` 12 / 11 / 11 / 12. Instantiation
is the step that matters, because a `CompiledWasm` import is compiled by the platform ahead of time
and importing alone would price the code section, while the growth here is 3,601 additional active
segments in the data section. Every reading reported 1,536 memory pages and 95 imports, so the
segment copy ran in each.

**A first pass read +8 ms and was measuring a cache.** Re-uploading identical bytes gave 18, 14, 10,
11 -- a falling series that reads as noise and is better explained by a compile cached on content
hash, which makes every reading after the first an under-report. Appending a unique wasm custom
section per upload gives each one a distinct hash and a cold compile; a custom section is ignored by
validation, so nothing else about the module changes.

Two things a session doing it must not re-derive. `WITH_MBSTRING=static` emits `--with-mbstring`,
which `ext/mbstring/config.m4` silently ignores; it has to go through `CONFIGURE_FLAGS` as
`--enable-mbstring --disable-mbregex`. And the cost to watch is the isolate rather than the bundle:
+0.62 MiB against 19.50 MiB of headroom, with the extension's runtime buffers unmeasured on top.

### The Clock

In-PHP `microtime()` returns a real epoch, but it does not ADVANCE between I/O: PHP's clock is the
glue's `_emscripten_date_now = () => Date.now()`, and Workers freeze that. So an application
timestamp is correct and a duration taken from two readings is not. The host depends on the same
fact: `nowMs()` is `Date.now()` and arms every alarm and every `expires_at`.

`tests/integration/php-clock.spec.ts` pins it and `/clock` reports `absoluteS` and `jsAbsoluteMs`.

---

## Real Workloads

`config/corpus.yml` pins 27 production Drupal codebases by commit: government, university, non-profit,
media and product distributions, plus module suites. `scripts/e2e/corpus-lane.ts` delivers each one the
way a migration would (a native install, the database landed through `drangler migrate install`, the
locked packages through `/install`, the custom code through `drangler modify`) and scores 13
capabilities: install, container build, anonymous and authenticated render, entity CRUD, form submit,
file read and write, queue and cron, outbound HTTP, update, cache rebuild, config import and module
workflow. `docs/compatibility.md` is the rendered result and the website's fixtures page reads the same
file.

On 2026-09-29, 15 of the 27 passed all 13 rows on a local runtime, and farmOS, GovCMS and Thunder passed all 13 on
a deployed Worker. Getting there found 104 defects: 46 in the product, 39 in the lane, its probes and the tests, 16 in the native
install harness and 3 upstream. The product defects that
would have reached users:

- **`subarray` throws above 2^27 bytes on the platform.** Once linear memory passed 128 MiB,
  `TypedArray.prototype.subarray` failed for any begin offset from 134,217,728 up, and emscripten
  decodes every string longer than 16 bytes with it. About half the live drives failed with a 1101
  depending on where a string landed. A local workerd does not enforce it. `safeHeapSubarray()` in the
  tuned glue builds a view with the constructor above the limit.
- **Every host call leaked a copy of its argument.** vrzno's `vrzno_expose_callable()` passes an error
  string to `zend_is_callable_ex()` and never frees it, 256 bytes per call for a 56-byte argument and
  ~185 KB per `/admin/modules` render. The glue now asks only for the argument shapes that can be
  callable; the upstream `efree` is owed at the next interpreter build.
- **The installer ignored composer `replace`.** Open Y's sub-projects asked for
  `ymcatwincities/openy`, which the 11.x distribution replaces, and a depth-first walk fetched the
  Drupal 9 distro first. `installTree()` walks breadth first and remembers what a package replaces
  across calls.
- **A compiled container outlived the code it describes.** A migrated site enables its modules before
  their code arrives, so farmOS booted a `cache_container` row naming services that did not exist yet.
  A delivery that changes wiring drops the container and discovery bins after it verifies.
- **Drupal Canvas's fiber loop could not run on the Fiber stand-in.** Varbase rendered no login form.
  `PhpWasmSyncFiber` carries a static handler Canvas's loop is rewritten to use, and the render, cron
  and update fragments now share one stand-in instead of declaring three.
- **A migrated site's claim never finished on a deployed Worker.** PHP's `uniqid()` polls
  `gettimeofday()` until the microsecond changes, and inside a synchronous run the platform's clock
  does not move, so the second call in one run spun to the CPU limit (302,500 ms, 3.4 billion
  `Date.now()` reads, identified by disassembling `zif_uniqid`). The claim made two, one per lock
  backend. A local workerd advances the clock, so it finished there in 10 s. The stand-in steps one
  microsecond past the last id instead of waiting; the claim now answers in 14.9 s of CPU.
- **A boot after a drop allocated a second heap beside the uncollected one.** On the deployed farmOS every
  reset after a drop found the old 93-113 MB heap alive. The dropped interpreter's memory is reused now; see
  Memory above.
- **A parked fetch built its base64 one character per byte.** 44 MB of heap per MB of body, twice per reply,
  which reset fresh isolates on farmOS's update check. It uses the chunked encoder the file store already had.
- **An adopted interpreter read module files through the evicted instance's storage.** Interpreter
  retention hands a resident interpreter to the next instance, and every boot closure follows the new owner
  except the installed-module mount, which kept the booting instance's `sql`. A class first loaded after the
  handover failed, and Drupal's container then refused that service for the life of the interpreter.
- **The claim rebuilt the container twice.** Installing the driver module and `drupflare` in two calls took
  farmOS's claim to 25.3 s of CPU against the 30 s paid default; one call takes 9.7 s.
- **A GET that met a memory reset was refused instead of retried.** The front worker retries a safe
  request once when the site's object is reset, and required the platform's `retryable` flag. A reset for
  memory arrives as `overloaded` plus `durableObjectReset` with no `retryable` (read off a deployed probe,
  n=8), so every such GET got the Try Again page. It keys on `durableObjectReset` now; on the next farmOS
  demo drive two GETs came back retried and answered 200. A POST is still never repeated: a write made
  before the reset is committed, which a retried claim answering 409 showed. The hop to the primary
  after a lane refuses had no retry at all, so a primary resetting at that moment answered 500; it gets
  the same one retry now.
- **The 2026-09-29 memory work, checked on a stock site.** Three paired deploys of the shipping config, the tree
  before tonight against the tree after, both arms of each pair together: failed requests 28 -> 0, distinct
  memory-reset events 53 -> 0, object exceptions 105 -> 0; every control run failed the live lane and every
  treatment run passed it.
- **A reset POST was refused even when it had never started.** The front worker now tags each serve POST to
  the primary with an attempt id, and the object records it before PHP runs. Writes commit in order and the
  output gate holds subrequests, so a missing record means nothing landed and the POST is repeated once;
  a found record means it may have saved and the visitor gets the Try Again page. About one row per POST.
  It covers a POST that died queued behind other work, not one that died inside its own render.
- **Background PHP reset a freshly booted isolate and took a visitor's POST with it.** The alarm refilled
  ten pages 3-5 s after a boot, the isolate passed its memory limit at ~7 s, and the Run cron POST queued
  behind the alarm got a 503. `FILL_SETTLE_MS` (60 s) holds the fill, cron and reconciliation off an
  interpreter younger than that and re-arms for the end of the hold. Paired deployed arms, one demo drive
  each: a failed POST in 3 of 3 drives without the hold and 1 of 3 with it; fill pages rendered during
  the drives 77 against 9. The first version held the mail and HTTP drains as well: a held reconcile
  step ended the firing, so a reset mail on a young isolate left 62.8 s after it was queued. A held step
  now lets the firing reach the drains, which run no PHP.
- **Thunder's claim died at the CPU limit every time, and each retry repeated the same work.** The claim
  was one invocation: a cold boot (5.1 s), plugin discovery (6.2 s), a container compile and a router
  rebuild, then saving the administrator (2.0 s, all of it the bcrypt hash). A CPU kill rolls back every
  write in the invocation, so a retry started from nothing. Measured stage by stage on a deployed object,
  no stage passed ~7 s. The front worker now sends the claim as three invocations: a warm-up that fills the
  discovery caches, the module install, then the claim, which finds both done. On a fresh Thunder deploy they
  read 7.1, 10.0 and 3.3 s of CPU. Two invocations were not enough: the install alone took over 32.5 s
  cold. The SQL bridge moved 44 MB in and 7 MB out over the claim, which is not where the time went.
  Split on every site, the stock claim went from 5.5-8.4 s of CPU as one invocation to ~25 s as three (three
  paired stock deploys), since each phase boots and the warm-up fills every plugin cache. A site still on a
  module set the pack baked now skips both phases: redeployed, the phases took 6 and 1 ms and the claim 9.1 s
  of CPU in one invocation. Only a migrated site splits.
- **Every installed module's files carried the isolate's boot time.** The installed-module mount created
  its nodes without a timestamp, so each file's ctime and mtime read the boot. The update module
  re-fetches any project whose `.info.yml` ctime is newer than its last fetch, so a young isolate that
  rebuilt the project list marked every installed project pending, and Run cron drained release XML for
  all of them inside one request. That was farmOS's remaining demo failure, read at the time as a memory
  limit. The files carry their `installed_at` now; deployed farmOS then passed 3 of 3 demo drives twice
  (234 requests, 0 failed, 0 retried) against 1 of 3 before. Installed Twig templates recompiled on each
  young isolate for the same reason.
- **Moving the pack blob out of the isolate did not help, so it was removed.** The lazy mount holds the
  whole 12.2 MB compressed pack in memory. A build that streamed it into the object's SQLite and read
  each file with one query on first open was deployed against the resident blob on Thunder: three
  deploys per arm, run in pairs at the same time, 3 demo drives each. With the store 323 requests, 4
  failed, 29 reset retries (19, 0 and 10 per deploy); with the blob resident 332, 1 and 9 (4, 2, 3). The
  spread inside one arm is larger than the difference, which is placement, and every failure was a POST
  repeat correctly refused. It cost ~12 MB of storage per object for no measured headroom. Thunder's
  heavy admin pages take 90-110 MB of linear memory on a fresh isolate; after the lane's config import
  linear memory alone read 134.8 MB, and a boot after a drop reuses that memory at its full size. So
  Thunder's admin pages can still reset a fresh isolate, and its lane read 11 of 13 on one deploy; a GET
  that meets the reset is retried once. Most of that heap is compiled PHP: a warm stock admin heap holds
  2,520 files and 40.7 MiB of opcodes.
- **A login on a second hostname never held.** Drupal derives the session cookie's `Domain` from the
  render host, which was always the pinned origin, so a browser on an alias refused the cookie. The
  front worker rewrites links, `Location` and the cookie `Domain` for a KV-mapped alias.
- **Delivered packages were unknown to `Composer\InstalledVersions`.** `/admin/modules` answered 500 on
  Open Y the first time a module asked for drush's version. Delivered packages are registered.
- **The Run cron message was lost across a park.** A request that parked an outbound fetch resumed with
  the session closed, so the success message never reached the next page. `ParkSession` saves and
  restarts a started session around the yield.
- **An oversized cache write failed the render.** A Views data row larger than Durable Object SQLite
  accepts threw. The driver evicts the cid instead, which is what a cache miss already means.
- **Smaller ones:** the claim wrote config before `common.inc` loaded; `public://` itself was not a
  directory; the installer and drangler dropped `.json` files; the update chain did not load module
  files; `runJson()` took the first `{` in output a notice had prefixed; composer plugins were fetched
  as runtime packages; drangler measured upload batches in UTF-16 units.

## Defect Classes

These shapes account for most of what has gone wrong here. Each has a guard that fails on the shape
rather than on one instance. Count them off the list rather than quoting a total; this line said six
against seven entries.

**Built, tested, and read by nobody.** A module is imported by its unit test and by nothing under
`src/`, so it is green on every commit and absent from every deployed site. `bun run check:reachability`
walks imports from the wrangler `main` and classifies every module as `edge` / `probe` / `script` /
`dead`; `tests/node/reachability.spec.ts` fails on a new dead module **and on a stale exemption**.
Probes are correctly unreachable, which is why the scan separates them rather than counting 44
problems to hide 6.

**A module on the edge whose load-bearing function is not.** The scan classifies MODULES, so
`src/ops/updb.ts` passed every check above for its whole life: `updbStep()` is called from the alarm.
Beside it, `updbPrepare()`, `updbRollback()`, `updbAbandon()` and `updbDrain()` were exported,
unit-tested and called from nothing. `updbPrepare()` is the only thing that can START a run, so
`/updb` could advance a run nothing was able to create and an operator pressing Database Updates got
`{"beat":"none","reason":"no-run"}`, which reads the same as nothing to do. The whole
database-update chain had therefore never run on any site. `degradeHeaders()` was the same shape one
module over, which is why the `reduced` band was invisible on every answered response. The scan had
always reported `unusedExports` and nothing asserted on it; `MUST_BE_CALLED` in
`tests/node/reachability.spec.ts` is a short named list of exports whose absence from `src/` means a
capability does not exist. Deliberately not a blanket rule: 785 entries are the legitimate
exported-for-its-unit-test pattern, and a check that fails on all of them gets switched off.

**Two mechanisms behind one header value.** `AGED` is the object answering a page stale BY TIME from
its own SQLite; `STALE` is the front worker answering a PREVIOUS GENERATION from `PAGE_KV`. Both
report `x-cfw-cache: KV`, and only `x-cfw-edge` separates them. A run that read `x-cfw-cache`
measured the first and filed the number against the second, which is the same family as reading
`x-cfw-plan` to decide whether the compiled-plan tier answered. The guard is to assert on the header
that NAMES the mechanism, and `serve-edge.spec.ts` now requires `x-cfw-edge: STALE` plus
`x-cfw-stale-behind` rather than a cache value both tiers share.

**A binding absent from every lane, so the tier under it never ran anywhere.** `pageKvEnabled()`
returns false when `env.PAGE_KV` is undefined and `readStalePage()` returns null at its first line.
The test pool declared no KV namespace and `wrangler.jsonc` declared none either, so the KV page tier
and the stale-generation serve were unreachable in the gate and on the shipping config at once --
identical to `reportToFleet()` returning early on an undefined `FLEET_DB`, one binding over. Both are
declared now. The second half is that the tier is PAID-ONLY by default (`pageKvEnabled()` ends in
`isPaid(env)`), so adding the binding alone changes nothing for a free site; a spec asserting it has
to say which plan it is asserting, and its control has to show the free plan storing nothing.

**A catch that names an error raised outside its try.** `runRedis()` caught `ProtocolError` and
`AuthError` and turned both into a 502, on the stated reasoning that a server which has answered must
not be retried by the drain. `AuthError` is raised by `_connectOverSocket()`, which sat one line
ABOVE the `try`, so the branch could never match and a wrong password escaped as a retryable
transport fault. The catch was correct and was looking one call too late. Reached only by a socket
that connects and then refuses the handshake, which is why the mock grew a reply for it.

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

**A probabilistic write read as suite contention.** `replica-invariant.spec.ts` failed twice across
sessions with `{ table: 'sessions', statements: 1, rows: 0 }`, passed alone, and was filed as
contention because a slower object was the visible difference. It is
`session.gc_probability = 1 / gc_divisor = 100`: PHP sweeps `sessions` on ~1% of `session_start()`
calls, and a full gate gives the coin more throws than a solo run. Forcing the sweep reproduces the
signature exactly, so no repeated full run was needed to attribute it. When a failure is intermittent
at a low rate, look for a probability in the code before reaching for load.

The resolution is a classification rather than a suppression: the host already performs the identical
`DELETE FROM sessions WHERE timestamp < ?` from `EXPIRED_ROW_RULES`, so a replica running it
converges on the same set the primary does. Writing a session row stays authoritative; sweeping
expired ones does not. Same table, two effects, which is the `key_value` lesson aimed somewhere new.

**A verification that cannot reach what it verifies.** `gitVerifyBoot()` was the gate on every git
pull and every uploaded revision, and it passed a `.module` full of nonsense, the same file with the
module enabled, and a malformed `.info.yml`. `DrupalKernel::boot()` builds the container out of
`cache_container`, so a boot reads no module file at all; `ModuleHandler::loadAll()` is what includes
them and it runs during `preHandle()`. It also read a NULL result as a pass, and a null is exactly
what a parse error produces -- `include` raises E_COMPILE_ERROR, no `try` sees it, and the run dies
before printing a verdict. Both halves are fixed and the rollback now names the parse error.

**A non-reentrant gate acquired twice.** `fetch()` runs the whole router inside `this.gate.run()`, so
a route calling a helper that acquires the gate again awaits a release that only happens when the
router returns. `/updb` hung past every timeout on a fresh object and read as a platform fault. The
same hour was lost once before and the comment recording it sits fifty lines away; a helper written
for `alarm()`, which is its own event, is not safe to call from a route without saying which one is
holding what.

**A default naming something the deployment may not have.** `settings.php` assigned
`system.mail:interface.default = cfw_mail` unconditionally. `cfw_mail` is a plugin of the `drupflare`
module, the shipped `core.extension` does not carry it, and `MailManager` throws
`PluginNotFoundException` on a plugin id it cannot resolve -- so `/user/password` answered 500 on every
site. An assignment cannot know whether its provider is installed; a `ConfigFactoryOverride`
registered BY the module can only run when the module is there, and it yields to `smtp` when a site
has `smtp`. **Prefer the override to the assignment whenever the value names a plugin, a service or a
theme**, and assert both directions: absent the module, the stock value survives.

**A per-request static that no reset clears.** The interpreter does not die between requests, so every
plain static is process state. `Html::$seenIds` was found and fixed; `Html::$isAjax` is one static
over on the same class, `resetSeenIds()` does not touch it, and
`AjaxResponseSubscriber::onRequest` sets it true on any `_drupal_ajax` request. Left true,
`Html::getUniqueId()` takes its `Crypt::randomBytesBase64(8)` branch **for the rest of the
incarnation**, so every id on every later render differs on every request and a stored page stops
matching a fresh one. `BOUNDARY_STATE` names the carriers and `static-sweep.spec.ts` fingerprints every
static of every declared class -- but the blind half compares two objects, so a carrier that only
moves under an input neither object supplies reads clean on both. **When fixing one of these, check
the neighbouring statics on the same class**; this one sat two lines from its sibling's fix.

**A refusal that the test harness reads as a fault.** Chromium logs its own console error for every
non-2xx response whether or not the page handled it, so the browser lane's console guard failed any
spec asserting that a refusal renders correctly. The guard is right to have no general allow-list; the
exemption is per-test and per-status, `test.use({ refusals: [401] })`, so an undeclared refusal still
fails.

**A path the chain proves it cannot satisfy, retried forever.** `/user/password` renders correctly and
Drupal marks the response `private, no-store` because of its CSRF token, so the fill renders it,
declines to store it, deletes the queue row, and the next visitor gets 503 `warming` and re-queues.
On an idle object that never converges, and the symptom reads as a slow site rather than a broken
page. Record the verdict: a path the chain has PROVEN unstorable is lifted out of the cold inline
refusal rather than being asked again. The general form is that a retry loop needs a terminating
observation, not just a bound.

**A platform limit the local runtime does not enforce.** `subarray` above 2^27 bytes, the collection
of a dropped interpreter, and the per-object memory ceiling all behave differently on a local workerd,
so a green local lane says nothing about them. Emulate the platform in the spec where the behaviour is
known (`growth-glue.spec.ts` builds a view whose `subarray` throws at the same offset), and settle
anything else with a throwaway deploy.

**A probe that scores the site with the wrong reading.** Nearly half the defects the corpus found were
in the lane: a 302 to a terms page read as incompatibility, a failure recorded under one requirer and
then delivered by the lock a moment later, a prefilled required field the probe never sent, a save that
redirected somewhere other than `/node/N`. Each read as a product gap. Before recording a row as
unsupported, confirm on the site itself (the database row, the log, the page) that the capability did
not work.

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

17. **A true mechanism is not automatically the mechanism in front of you.** The 2026-09-14 replica
    arm came back with lanes 1 to 3 answering nothing, and that was attributed to affinity: an
    anonymous one-machine generator keys on its own address and cannot spread across a pool. The
    mechanism is real, it is reachable by reading the router, and it explained the symptom well
    enough to stop the search. It is also not what happened. That arm drives AUTHENTICATED requests,
    which key on the PATH, and running the router's own FNV-1a over its eight paths covers 4 of 4
    buckets at 3 lanes. The cause was admission: a lane lists `state:system.private_key` as
    mandatory state, Drupal mints it lazily on the first render carrying a CSRF token, and a site
    that has been migrated with `/firstrun` run does not have one. Reproduced on a local rig, the
    same three lanes sat at `CREATED` through 40 provision steps each and then reached `VERIFIED` in
    1 step each once a single `/user/login` render had minted the key. A plausible cause that fits
    the symptom is the most expensive kind of wrong, because it ends the investigation. Where the
    question is arithmetic -- can N keys cover M buckets -- compute it against the real hash instead
    of inferring it; that took twenty lines and settled it.

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
| `src/ui/` | the `/_cfw` owner surface: thresholds, extend, commands, deploy manifest, git remotes |
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
bun run release:check      # the shipping bundle against the 64 MiB uncompressed limit
bun run assets:driver      # repack after any change in a sibling repo
bun run backup:verify      # 35 live + 6 archived CDN keys, no credentials
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

---

## Design Records

The v1.0.3 comment pass cut most source comments to a line or two, keeping each constraint and
dropping the reasoning behind it. The reasoning is kept here, word for word as it stood in the
source, grouped by the file it was attached to. A record is one of three kinds: an alternative that
was tried or proposed and why it lost, a contract (what a crash leaves behind, what a caller may rely
on), or the measurement that set a constant.

A record describes the code as it stood when the comment was written. Where later work made part of
one wrong, a **Superseded** note says what changed. Anything the sections above already cover is
not repeated here.

### `src/db/file-store.ts`

#### Module overview

Durable storage for Drupal's `public://` and `private://` files.

Writing to `ctx.storage.sql` inverts that. It is synchronous from inside the Durable Object, so a
write is durable the moment PHP returns, in the SAME store as the entity row that describes it.
The two commit together or not at all. R2 then becomes an OFFLOAD -- worth doing because an R2
object on a custom domain serves without invoking the Worker at all, which is the only lever on
the serving ceiling -- rather than the thing durability depends on. A missing or failing bucket
degrades to "served from the Durable Object", not to data loss.

WHY CHUNKED. A Durable Object SQLite record is capped at 2,199,995 bytes, measured. A 3 MB image
is an ordinary Drupal upload, so single-row storage would fail on real content. Chunks are also
what make a large read divisible across invocations under a 10 ms cap.

The slice of `ctx.storage.sql` this module uses.

Structural rather than `SqlStorage`, so the store is drivable from anything that can run a
statement -- which is what lets the gate lane test it against a real Durable Object handle
without the two type surfaces having to agree on members nothing here touches.

#### `MIRRORABLE_SCHEMES`

The ONE scheme whose bytes may leave the Durable Object for a public bucket.

Drupal's `private://` is not a naming convention, it is an access-control boundary: those files
serve through `/system/files/`, a route that runs a per-user access check on every request
(`CfwFileStreamWrapper::getExternalUrl()` builds that path). An R2 object has no user, so
mirroring a private file publishes it permanently to anyone holding the URL -- an
authentication bypass, and a worse one than serving a stale personalised page, because it does
not expire and cannot be invalidated after the fact.

So this is the file-side of the same rule `src/site.ts` enforces for renders: **anything whose
correctness depends on knowing who is asking must not be answered by a layer that does not
know.** It is a list rather than a `!== 'private'` test -- a scheme added later
(`temporary://`, a contrib scheme) is refused until someone decides it is publishable, which is
the direction a mistake should fail in.

#### `drainMirrors`

Pushes queued files to R2 and removes the ones that left.

Serving a page from R2 on a custom domain costs **zero Worker requests**,
which is the only lever on the serving ceiling -- every other optimisation moves CPU or rows
while the ceiling stays at 3M visits/month. The queue existed and drained nowhere, so the
ceiling stayed saturated.

The refusal is re-checked here, having already been checked at enqueue, because of the boundary
rule: `isMirrorable()` at enqueue guards the queue, and a queue row
can outlive the state that admitted it. Only the check adjacent to the `put` guards the bucket.

Sequential rather than concurrent. A pass runs inside one invocation against a 10 ms
CPU budget, and `limit` is what bounds it; firing N puts at once would make the slowest one
decide the invocation and remove the only control there is over that.

### `src/db/heap-store.ts`

#### `gcHeapSnapshots`

Keeps the newest `keep` snapshots and deletes the rest.

An unbounded snapshot table is the watchdog lesson repeated at 40 MB a row: the health ledger
grew to 46% of the database before it was capped. Chunks go first so a crash between the two
deletes leaves orphaned metadata rather than orphaned megabytes.

### `src/db/migrate-sql.ts`

#### `chunksPerInvocation()`

```
 * **FREE WAS 1, AND THE REASON IT GAVE WAS THE 10 ms CAP.** That premise is retracted in writing
 * one file over: a single invocation reading 1,882 ms of `cpuTime` completed on a deployed free
 * worker, so the cap does not bind an object invocation, which is where migration runs -- see
 * `FREE_PROFILE` in `src/ops/plan-profile.ts`. At 1, a shipped pack of 75 chunks provisions a site
 * over **75 separate
 * Durable Object invocations**, each paying an alarm turnaround, a `setAlarm` row and a cursor row,
 * while the new owner watches the `migrating` page refresh itself.
 *
 * **The real bound is SUBREQUESTS, and it was measured rather than reasoned.** `/migrate?all=1` on
 * a deployed free worker failed with `Too many subrequests by single Worker invocation` -- free
 * allows 50, and {@link assetChunkLoader} spends one `env.ASSETS.fetch()` per chunk plus one for a
 * manifest that is memoised per incarnation. So N chunks costs at most N+1. That failure is also
 * the positive evidence that the whole replay fits one invocation's CPU: nothing else stopped it.
 *
 * 40 leaves ten subrequests of headroom. The migration branch returns before any other alarm work
 * runs, so nothing else is competing for them.
 *
 * Paid has a 30 s CPU budget and a 1,000-subrequest allowance, so the whole migration is one
 * invocation and the chunking is only a crash-resume property there.
```

#### `SqlMigrator.step()`, already-migrated branch

```
// "already migrated" has to mean "already migrated THIS generation". It used to mean "the
// cursor says done", which read the row without looking at whose it was -- so a restore, which
// shares this one cursor row with the pack, was skipped on every site that had finished
// migrating and reported `{ ok: true, done: true }` having replayed nothing. A rollback
// reported success and changed no data. The namespaced `import:<id>:<gen>` generation was
// written to prevent that and could not, because the branch never compared generations.
```

#### `SqlMigrator.reset()`

```
// `creates` rather than `tables`: the latter is a row-count map and omits every
// table with no rows, including the synthesised `sessions`. Dropping only the
// row-bearing tables left `sessions` behind and the next migration died on
// "table sessions already exists"
```

### `src/db/pg-exec.ts`

#### `DEFAULT_PG_DEPS`

The real client, reached by a DYNAMIC import, and the reason is the lane split rather than size.

A static `import { Client } from 'pg'` bundles correctly -- measured, esbuild produces a Worker
that uploads, and `pg` costs 90 KiB of the 65,536 KiB ceiling. It also makes every vitest spec
whose graph reaches this module fail to load at all: vite answers
`SyntaxError: Cannot use import statement outside a module` for `pg`'s CommonJS entry. That is
the gate-and-bundler disagreement this repository already has a rule about, arriving from the
other side -- and `park-drive.ts` imports this file, so a static import would have taken every
spec that reaches the park with it.

Dynamic, the import is not evaluated until a deployment actually selects this backend, so the
gate never resolves it and the bundler still does.

#### Module overview

`pg` is the client Cloudflare's own Hyperdrive documentation uses, and Hyperdrive itself supplies
no client at all -- only the pooled endpoint and the string. The pooling is the reason a
connection is made per call here rather than held: Cloudflare's guidance is a client per request
because the underlying connection is pooled on their side, and a Durable Object holding an open
socket is on the no-hibernation list, which bills duration for the whole time it is held.

#### `backendExec()`

`rowsWritten` comes from `rowCount` on a statement that returned no rows, which is what a write
is; a SELECT reports its rows read instead. MEASURED against the rig's PostgreSQL 17.6 rather
than assumed, because `pg` uses one field for both: `SELECT $1::int` answers
`{rows: [{n: 7}], rowCount: 1}` and `INSERT INTO probe (id) VALUES ($1)` answers
`{rows: [], rowCount: 1}`, so the row LIST is the only thing that separates them.

### `src/db/wide-integers.ts`

#### `repairWideIntegers()`

Exact reads for SQLite INTEGERs wider than 2^53.

##### What is actually broken

`ctx.storage.sql` hands INTEGER columns back as JavaScript numbers, so a value above
`Number.MAX_SAFE_INTEGER` has already lost precision before anything in this project sees it.
Re-measured 2026-08-23 on workerd, unchanged from the first reading:

| written               | read back             | `CAST(col AS TEXT)`   |
| --------------------- | --------------------- | --------------------- |
| `9007199254740993`    | `9007199254740992`    | `9007199254740993`    |
| `9223372036854775807` | `9223372036854776000` | `9223372036854775807` |

The storage is exact and the READ is lossy. The codec cannot help: by the time it runs the value
is already a wrong double, and the `__phpint` envelope then carries the wrong number faithfully.

##### Why this needs no SQL parser, which is what the item assumed

The backlog scoped this as "the driver knows the schema, so it can rewrite `SELECT id` to a text
cast for columns declared wide", and then listed the shapes such a rewrite has to survive --
`SELECT *`, aliases, expressions, JOINs, `ORDER BY`, aggregates. That is a SQL parser, and it
would cover the shapes it was written for and silently miss the rest.

It is unnecessary. **The result rows already carry the output column names**, whatever produced
them, so the exact values can be fetched by wrapping the ORIGINAL statement as a subquery and
casting by name:

```sql
SELECT "a", CAST("b" AS TEXT) AS "b" FROM ( <the original statement, untouched> )
```

The inner statement keeps full 64-bit precision inside SQLite; only the outer projection crosses
into JavaScript, and it crosses as TEXT. Aliases, aggregates and `SELECT *` all resolve to output
names before this sees them, so every shape is covered by construction rather than by enumeration.

##### And it costs nothing when nothing is wide

Triggered by DETECTION, never by schema: the second read happens only when a returned value is an
integer that a double cannot represent exactly. Drupal core never stores integers that wide, so on
an ordinary site this never fires at all.

`reread` runs the wrapper statement with the SAME bindings; it is injected rather than taken from
a handle so the whole decision is drivable from a unit test with no Durable Object.

#### `INT64_BOUND`

`2 ** 64` rather than `2 ** 63`, and the extra bit is not slack. Rounding pushes a wide value
PAST the signed bound on the way into a double -- measured, `9223372036854775807` arrives as
`9223372036854776000`, which is larger than `2 ** 63` and would be excluded by the tighter
guard. This bound also covers an unsigned 64-bit id, which contrib does store.

### `src/db/write-tally.ts`

#### `overheadShare()`

```
 * **This is not the index share, and it is not an upper bound on it either.** An earlier docblock
 * here said it was, and the measurement falsified that: the recorded cold fill is 63 statements
 * against 12 charged rows, so `explained` clamps to 12 and this returns **0** for a fill that
 * `scripts/measure/index-audit.ts` decomposes as **9 of 12 rows index maintenance**. A write path
 * with more no-op statements than rows will always read 0 here and look index-free.
 *
 * What it does bound is the opposite direction -- rows that arrived from FEWER statements than rows,
 * which is a multi-row statement (`INSERT ... SELECT`, a `DELETE` clearing a bin) or a heavily
 * indexed insert. Useful for spotting a burst; useless for pricing an index. Use
 * `splitChargedRows()` with the schema's factors when the question is how much of a cost is index
 * maintenance.
```

#### `routerRebuildPasses()`

```
 * **The default was 16 and the driver writes 1, so this returned `null` on every real enable.**
 * Measured 2026-08-19 on a `token` install: **422 router statements over 420 routes**, 2,518 charged
 * rows, 5.97 rows per statement -- one statement per route, not fourteen. The old default came from
 * the 100-bound-parameter ceiling over a 7-column row, which is what the driver COULD batch rather
 * than what it does. With `perPass` computed as 28 instead of 421, `422 / 28` is fractional and the
 * function refused to answer -- so `/enable` has reported `routerRebuilds: null` for its whole life,
 * and nobody noticed because a null reads as "not applicable" rather than as a broken instrument.
 *
 * The residual is reported rather than rejected. An enable pays one pass plus a handful of
 * incidental statements, and demanding exact divisibility turned "1 rebuild, 1 statement
 * unaccounted" into no answer at all. A caller that needs strictness reads `residual`.
```

#### `countingSql()`

```
 * That is not a rounding error. The `cfw_page` insert carries the whole rendered page -- 12,304
 * bytes for the front page -- and `cfw_page` is indexed, so it is the single largest write in a
 * fill. A fill measured at "12 rows" through the old instrument reported **0** for the statement
 * that stores the product of the fill.
```

#### `chargeFactorsFromSchema()`

```
 * `PRAGMA index_list` is the engine's own answer, so implicit primary-key and UNIQUE indexes arrive
 * as `sqlite_autoindex_*` rows without being inferred, and PARTIAL indexes are excluded on the
 * engine's `partial` flag rather than on a regex over the DDL. `AUTOINCREMENT` is still read from the
 * DDL text because no pragma reports it, and it costs a charged row of its own -- the
 * `sqlite_sequence` rewrite measured in `tests/unit/db/index-charge-model.spec.ts`.
 *
 * `WITHOUT ROWID` is read from the DDL for the same reason and corrects the opposite error: the
 * pragma reports the primary key as an autoindex there too, but the key IS the table, so adding a
 * base row double-counts it.
// (inline) Measured: such an insert charges 1 and this returned 2
```

#### `statementsByTable`

write STATEMENTS per table, which rows alone cannot substitute for.

Rows answer "how expensive", statements answer "how many times". The router rebuild is the
case that forced this: a rebuild is one DELETE plus a fixed number of parameter-budgeted
INSERTs, so statements-per-table divided by that fixed shape reads the number of REBUILDS
directly. Inferring it from rows instead means dividing a measured total by a subtrahend
nobody measured -- the exact error this project keeps finding.

Counted for every write statement including no-ops, unlike `byTable`, because a statement
that wrote nothing still happened.

### `src/do/alarm.ts`

#### `HeapRestoreIncomplete`

Thrown while a chunked restore is still in flight, so no caller can execute PHP through a heap
that is the right length and the wrong bytes.

A named error rather than a boolean return because `ensurePhp()` has roughly a dozen call sites
and a flag only works if every one of them remembers to read it. `LAZY_MOUNT` spent its entire
life as unreachable code behind exactly that kind of unchecked condition.

#### `heapRestoreChunkBudget()`

How many chunks one invocation may apply, or `undefined` for all of them in one go.

Unset is the whole snapshot at once, which is what every recorded restore measurement was taken
on (memcpy 14-18 ms for 22.4 MB). The budget exists because a 10 ms free-plan invocation cannot
be assumed to hold an arbitrary image: at 2 MiB a chunk, `HEAP_RESTORE_CHUNKS=2` is roughly 4 MB
of memcpy per firing.

#### `heapSnapshotEnabled()`

Whether a boot restores a stored heap instead of booting the kernel. ON, with `HEAP_SNAPSHOT=0`
to turn it off.

It shipped opt-in with a precondition written into `ensurePhp()`: the standalone restore probe ran
in one process with no Durable Object and no vrzno bridge in the image, so "until a host call is
shown to round-trip through a restored heap, this must not be on by default." That precondition is
now met -- `/heap?op=bridge` forces PHP to reach `cfwStats` through `vrzno_env()` on a restored
image and it round-trips with 3 handles replayed and the digest equal, and an install then runs on
that kernel and lands.

Priced before flipping it, because the storage is not free: **31,784,960 bytes across 159 rows per
site**, plus a 5,993 ms one-off to take the snapshot. What it buys is **2,310 ms (fast mode) to
3,578 ms (slow mode)** off every install, n=8 per arm, present in BOTH modes of a bimodal
population -- which is what makes it a result rather than an artefact of which mode was sampled.

#### `AlarmClass`

What an alarm lane actually achieved, as opposed to what it returned.

This type exists because the same bug happened three times. Migration re-armed at +1 ms on a step
that ERRORED, because an error return is non-null too. The fill head re-armed at +1 ms on a render
that THREW, producing **196 firings in 14 seconds, every one reporting `outcome: ok`**. Both were
fixed case by case, and both had the same shape: a non-null return read as work done.

The re-arm delay is now a function of this classification and of nothing else, so the fast path
cannot be reached without something having first said the work progressed. Queue depth is no longer
sufficient -- it was what made the third instance possible, since a row that failed to be struck
kept the queue non-empty and the chain fast forever.

#### `restoreAlarmDecision()`

What the alarm chain should do after one slice of a chunked restore.

Extracted rather than left inline for the reason `migrateAlarmDelayMs` was extracted: the inline
version of that decision shipped a branch that could never be taken, and nothing noticed because
an inline ternary in `alarm()` has no unit test. This one carries the halt, which is the branch
whose absence once spun an object at 1 ms forever and starved every gated request behind it.

#### `migrateAlarmDelayMs()`

How long to wait before the next migration alarm.

Extracted for the same reason `cronAlarmDelayMs` and `updbAlarmDelayMs` exist: this is a
three-branch decision that lived inline in `alarm()` as a ternary, and it was the only one of
the three alarm chains with no unit test.

That is how a real bug survived in it. The ternary read `pending.done`, but the caller hands it
`{ migrate: out }`, so `done` was ALWAYS undefined: the idle branch was unreachable, and the
firing that COMPLETED a migration re-armed at 1 ms instead of 240 s. Cheap in practice, because
the next firing finds the cursor `done`, returns null and falls through to the fill loop -- but
the branch was dead and the intent defeated. Taking the step result DIRECTLY rather than the
wrapper is what makes that mistake unspellable here.

### `src/do/capabilities.ts`

#### region durable files

```
// FULLY SYNCHRONOUS, and unlike every capability above that is not a compromise. `cfwFetch`
// and friends are split into a queue and a drain because the network cannot be awaited from
// PHP; `ctx.storage.sql` needs no await at all from inside the Durable Object, so a file
// write can report a real result -- durable, committed -- in the same call. That is the whole
// reason `src/db/file-store.ts` stores in DO SQL and treats R2 as an offload: it is the only
// arrangement where a synchronous stream wrapper can tell PHP the truth.
//
// Bytes cross as base64 in a string field rather than through the codec's bytes envelope,
// because a stream wrapper reads and writes partial buffers and an explicit field keeps the
// boundary readable at the one place a chunk is assembled.
```

#### `cfwFilePublicBase`

```
// The only structural serving lever. A zone Cache Rule cannot save an invocation because the
// Worker runs before the cache is consulted, so exactly two paths cost zero Worker requests:
// a static asset, and a hostname that is not routed to the Worker. An R2 custom domain is the
// second. Worker requests at 100,000/day are what bind serving, so moving media off them is
// the difference between the meter counting visitors and counting every image on the page.
```

#### `cfwSettings`

```
 * `set` cannot be synchronous: a KV write is I/O and `execSql()`-style host calls cannot
 * await. So it validates in full, answers what it accepted and refused, and performs the
 * write under `waitUntil`. That is honest rather than optimistic because the validation is
 * the part that can fail on the caller's input; a KV put that fails afterwards leaves the
 * previous value in force, which is the same state the caller was already in.
```

#### `cfwHealth`

```
 * `HealthLedger::record()` opens with `if (!Host::has('cfwHealth')) return false;` and
 * nothing installed it, so every finding the PHP tripwires produced was dropped on the
 * floor -- and `src/Health/` is 12 files whose entire output goes through this one call.
```

#### `cfwImageUrl`

```
// `CfwImageToolkit::getSupportedExtensions()` carried its own copy of the list and a
// `=== 'images'` branch, which pinned the wasm arm's capability to whatever it was
// when that line was written; tinyimg 1.1 added AVIF and every shipped style went on
// degrading to webp
```

#### `cfwTcp`

```
// A non-200 body is the server's own sentence, and it has to arrive as `error`.
// `runRedis()` answers a RESP error with 502 and the message as the body, while
// `CfwTcp::redis()` reads `error` and falls back to a generic string -- so the
// sentence was dropped between the two halves that exist to carry it. Found by
// the first exchange against a real server; every mock had answered 200
```

#### `cfwMail`

```
 * This used to push onto `this.mails` and answer `{ok: true}` whenever `CFW_EMAIL_BINDING`
 * was `'1'`, which gated a return value and not a transport -- nothing was ever sent.
```

### `src/do/fill.ts`

#### `openFillWindow`

Opens a warm window: one boot, then one fill per incoming WebSocket message, because each
message resets the available CPU time. The alarm chain cannot do this -- it re-pays boot every
firing, ~25x fewer fills on free.

`server.accept()`, never `ctx.acceptWebSocket()`: hibernation would discard the interpreter
the window exists to keep. A non-hibernatable object is billed for duration, so the window is
scoped to a drain and closed.

### `src/do/git.ts`

#### `handleGit` case 'unpin'

Releases the preview pin WITHOUT reaching the remote.

`unpreview` re-syncs to the branch head, which needs a ref advertisement -- so a pin cannot be
released while the remote is unreachable or its token has expired, and that is exactly the state an
operator is trying to heal. A pin held against a dead remote stops the poller and the webhook
indefinitely.

Releasing without a sync leaves the site serving the request's files, which is what it was already
serving. What changes is that the poller owns the branch again, so the NEXT successful poll
converges it. Degraded rather than immediate, and it is the half that works with no network at all.

### `src/do/health.ts`

#### `observe()`: isolate memory reading

The whole isolate. This read MEMFS resident bytes, for a reason that is half right: total linear
memory moves only on a grow and two rungs reach the cap, so four rising readings of IT cannot
happen. But MEMFS is capped at `LAZY_FS_BUDGET_BYTES` and saturates -- measured on a deployed object
at 4,193,165 of 4,194,304 -- so four rising readings of that cannot happen either, and the finding was
labelled `scope: 'linear-memory'` while watching neither. `isolateNow()` is linear plus the JS-side
mount, which is the quantity the platform enforces and the only one here that both varies and matters.

#### `supervise()`: why the alarm and not the request

On the alarm and nowhere else. `recordFinding()` is a row write and rows written is the meter that
binds the regeneration ceiling, so a per-request tripwire pass would spend the budget it exists to
watch; and a waiting visitor outranks bookkeeping, which is the same rule that puts GC and cron after
the fills. Error and above is a failure, not critical-only: keying the ladder on `quarantineDecision`
alone would record an error-severity finding and then advance the state as though the pass were
clean -- `bridge.asyncify_called` fires on a dead stream wrapper that kills the whole invocation, and
three of those is a durable condition whatever its severity label says. `warn` is not a failure:
budget pressure and a memory trend are things to watch at the next quiet moment, and striking on them
would quarantine a healthy busy site.

### `src/do/heap-image.ts`

#### `snapshotStep`

It never drops the interpreter, and two versions that did were both wrong. The image has to come
from a boot out of the PACK with the kernel up and nothing rendered, so a resident interpreter
is the wrong heap -- but taking it away to boot another holds two linear memories at once and
destroys state its owner is still using.

So it waits instead. `/__migrate`, `/__firstrun` and `/__enable` all drop when they finish and
`recycleIfOversized()` drops above the threshold, so a provisioned site reaches an alarm with
`php === null` as a matter of course. A site that never does simply never images, which `/heap`
reports as `imagedGeneration: null`.

#### `tryRestoreHeap`

The fd table is asserted BEFORE the memcpy and the refusal is loud. Dropping
`/dev/urandom`'s descriptor alone throws `RandomException`; dropping the three sqlite
descriptors gives a locking-protocol error after an **80-120 second stall**, which on the edge
is a hung request rather than an error. A refusal costs one boot; proceeding costs a hang.

the boot path reads these tables before anything has written them, and it is the ONLY caller
that can meet a table older than the code: a deployed object created `cfw_heap_snapshot`
before `handle_table` existed, and `CREATE TABLE IF NOT EXISTS` does not add a column, so
the first restore after the deploy refused with "no such column: handle_table". Measured on
the edge, which is the only place a pre-existing table exists.

the handle assertion, and the one the fd contract was missing. The heap holds
`Module.targets` ids as integers, so every handle the booted kernel captured -- notably
`CfwSqlClient::$execFunction` -- is a dead index in a fresh instance until it is
re-registered at the SAME id. Without this a render dies as
`TypeError: target is not a function`, measured on a deployed worker.
Same discipline as the fd table: replay first, refuse before any bytes land, and name
every failure at once. Restoring a heap whose handles could not be replayed is worse than
not restoring, because the failure surfaces as an uncatchable throw from inside a render.

#### snapshotHeap, live view

The live view, not A COPY. `toStorableBytes()` exists to survive a `memory.grow()`
invalidating a view, and nothing between here and the last chunk insert can grow the
heap: no PHP runs, and there is no await. Copying spent a second 64 MB at exactly
the moment the isolate had none -- measured `exceededMemory` on the edge.

#### `corruptStoredChunk`

This exists to make the refusal EXECUTABLE IN PRODUCTION rather than only in a test. The
distinction is not pedantic here: `LAZY_MOUNT` was covered by tests and unreachable in the
deployed worker for its entire life, and the failure this guards against -- a chunk that lands
with the wrong bytes -- produces a heap of the right length that renders something subtly wrong
with no error at all. The only convincing evidence that the guard works is watching a deployed
object refuse a chunk it was actually asked to apply.

### `src/do/invalidate.ts`

#### `bumpGeneration()`, before `const now`

```
// SUPERSEDED, NOT DELETED, and this is the whole 503 storm.
//
// A bump used to empty `cfw_page`, so between the save and the refill there was nothing to
// answer with and EVERY anonymous visitor got a 503 -- on the profile carrying 0.82 of the
// traffic, after every content save, on every site. `PREFILL_ON_SAVE` re-queues what it
// purged and that is correct, but it bounds how many pages come BACK; it cannot shorten a
// window whose length is the fill cost times the queue position. Measured on a deployed
// object: `/user/login` took three drain rounds to return, and a queue holding 15 entries
// from one arm kept it 503 throughout -- which is why an intermittent login failure read as
// a wrong password.
//
// The row is kept and marked instead. `serveFromStorage()` answers it as `AGED` inside
// {@link AGED_SERVE_MAX_MS} and queues the refill, so the visitor gets content that is one
// save old rather than an error. `putPage()` refuses any tier that is not HIT or RENDER, so
// an aged body cannot reach `caches.default`, the KV tier or the isolate page memo.
//
// AND IT IS NOT MARKED PER PAGE ANY MORE, which is where the rows went. `UPDATE cfw_page SET
// stale_at = ?` is charged per ROW, so a save reaching 34 pages spent 34 rows saying so --
// on the meter that binds regeneration, before regenerating anything. A page already carries
// the sum of its tags' invalidation counters, which is Drupal's own freshness test, so the
// marking is derivable and `pageStaleness()` derives it. The write happens once, on the
// serve that first meets the page stale, and a page refilled before anyone asks never pays
// it at all: per transition rather than per save.
//
// A row with no usable checksum -- stored before the column existed, or rendered declaring
// no tags -- cannot be derived and is still marked here. That is the fail-closed half, and
// it is what the `tag_checksum IS NULL` filter selects.
//
// AND ONLY ON THE `cachetags` REASON. The checksum can speak for an invalidation Drupal
// recorded as a tag; it cannot speak for a module install, a firstrun or a manual bump,
// because none of those moves a counter. Deriving there would answer HIT for a page the
// install changed -- so every other reason marks eagerly, exactly as before.
```

#### `bumpGeneration()`, shell purge

```
// A shell caches the whole shared region -- nav, blocks, footer, site name -- and Drupal
// knows nothing about it, so no cache tag reaches it and nothing else would ever invalidate
// it. It used to be purged on EVERY bump including `cachetags`, which meant assembly stopped
// at the first content save on every live site and never restarted without a human.
//
// A `cachetags` bump fires on the FIRST tag written and the rest of the invocation's tags do
// not exist yet, so it cannot decide anything about a shell either -- exactly the reason the
// page purge above already passes `scopedTo: []` on that reason. `flushTagPurge()` runs
// `purgeShellsForTags()` once the set is whole, and `drainPendingTags()` settles it at boot
// if this invocation dies in between.
```

#### `purgeForTags()`

```
// APPLIED, and this is the only caller that may. `purgeShellsForTags()` refuses by default --
// a tag on neither the shell nor one of its fragments drops the shell as unaccounted-for --
// so it is only correct where the invalidated set is COMPLETE, which is here and not at the
// `cachetags` bump. It was wired to nothing for as long as the bump was purging wholesale.
```

#### `purgeScopedPaths()`, fanout

```
// The fanout picks the policy. A node save touches a handful of pages and the write can pay
// for their regeneration; a config change touches everything, and regenerating that eagerly
// costs more of the daily row budget than the whole day's traffic. The lazy branch is not a
// refusal -- those pages have a previous generation in KV and the stale tier serves it while
// the visitor who asked queues the render
// the third argument is whether the stale tier the lazy branch leaves those pages to exists
// at all; without `PAGE_KV` bound it does not, and lazy would mean a cold render for every
// visitor after a config change
// WEIGHTED BY ROWS, not by page count. The thresholds were counts, and a page costs 2 rows
// when its `dynamic_page_cache` entry survived the invalidation and 9 when it did not -- so
// the same 34 pages is 68 rows or 306 depending on which set they are, and one count could
// not be right for both
```

### `src/do/lanes.ts`

#### `autoScaleStep()`, the idle-tick comment

An idle tick must write nothing. Recording every window unconditionally charged a row on
each of ~10,800 daily warming firings to say the site was quiet, which is the meter paying
for its own bookkeeping. Only a CONTENDED window is stored, and one quiet window clears the
run, so the sustained check means three contended firings with nothing quiet between

#### `autoScaleStep()`, the queueing comment

QUEUEING, measured, alongside the inflight proxy. `laneTimings` already records
whether each request waited and for how long -- it was read only for reporting, and
it is the quantity a lane actually removes

#### `provisionLane()`, the fresh-copy comment

A copy that starts at the beginning must drop what an earlier attempt left on the lane.

`RESTORE_GENERATION_KEY` survives an interrupted copy, and `chunkRefusal()` compares every
later chunk against it -- so a lane whose first attempt was cut short refuses the next one
as torn, against a generation only `clearRestore()` can move. Nothing on this side ever
sent `restart=1`, so the exit its docblock describes was reachable from a test and from no
caller, and a lane wedged this way stayed wedged.

The interruption is not exotic: `budget` bounds a copy to 4,000 rows per invocation, so any
site bigger than that needs several, and the primary's own alarm chain commits between them.
That moves `commitSeq()`, which tears the resume at the check above and sends the next
attempt back to index 0 -- straight into the stale marker.

#### `provisionLane()`, the sealed-first comment

SEALED FIRST, then the LAST RECORD rather than the sequence; see `copyableGeneration()`.
A lane landed at `commitSeq()` while the next record chained from one below it, and
`planApply()` withdrew it as out of order on the first write after its copy

### `src/do/levers.ts`

#### `shellAssemblyEnabled`

ON BY DEFAULT ON BOTH PLANS, and an explicit `SHELL_ASSEMBLY` still wins. `KV_OVERRIDABLE`
carries it, so turning it off needs no redeploy.

This used to be off on both plans on the reasoning that "the failure mode of a wrong shell is one
visitor seeing another's page". That failure mode is real and it is also not what gates this
lever, which is the distinction the old default missed. `assembleFor()` serves NO visitor until
their own uid has passed `verifyShellFor()` -- a re-harvest of THEM, compared byte for byte
against the stored shell, which on a mismatch deletes the shell, records the diverging offset and
answers them from their own render. The two-session harvest authorises the STORE; the per-uid
proof authorises the SERVE, and only the second stands between a visitor and someone else's page.
Every other failure returns null and falls through to an ordinary render.

The first request per `(path, role set, uid)` pays a 40-52 row toll and breaks even after 4-13.
At one site that fits free's 100,000 rows/day, which is why there is no plan branch here.

#### `prefillDefault`

**ON by default for free, OFF for paid.** This is a contract change, not a
convenience: a prefilled path is a **HIT on its first ever request**, so the cold contract that
ten assertions were correctly asserting no longer holds by default. It was opt-in precisely
because changing that silently broke them.

So the switch is explicit and three-way, most specific first: `?prefill=1` / `?prefill=0` on the
request, then a `PREFILL` env override, then the plan. Free gets it because free is where it
decides whether the site works at all -- a prefilled page costs no PHP on the serving path, and
a fill on free costs a 202 to the first visitor and rows against the binding meter. Paid can
afford to render, and a paid operator asking for the cold contract should get it.

#### `DEFAULT_MEMORY_CACHE_BINS`

ON BY DEFAULT, AND IT SHIPPED OFF UNTIL THE COST WAS MEASURED RATHER THAN REASONED ABOUT. The
saving was never in doubt: a real re-render charges 8 charged rows with the bin in SQL and 4 with
it in memory, on the meter that binds regeneration. What was in doubt was the cost after an
interpreter drop, since the bin dies with the interpreter -- and the argument for leaving it off
was that a render which could no longer reassemble would pay more.

It does not. Measured with both arms dropping the interpreter between two fills: **6 charged rows
with the bin in SQL against 2 in memory**. A cold render REWRITES the SQL bin rather than reading
it, so surviving the drop buys that render nothing, while the memory arm writes no SQL at all.
The lever is cheaper in both states and the conditional default had no evidence under it.

What it costs is latency on the first render after a drop, MEASURED 2026-09-24 on deployed
workers forced to recycle after every request (medians, n=10 interleaved): a cold reassemble is
1,324 ms against 1,073 with every bin in SQL, and a cold re-render 1,458 against 1,346. It stays
the default because of the write budget. On a modelled free day -- the whole request allowance at
a 4.38% render fraction, plus 50 saves each invalidating 34 pages, plus warming and those saves'
own rows -- it takes rows written from 72% of the quota to 32%, the margin before read-only.

`menu` JOINED ON 2026-09-23, chosen by a census rather than by being a Drupal cache bin. Of the
reconstructible bins measured in the audit's sequence, it is the only one that writes on a warm
re-render, the class carrying 70% of the steady-state mix, so it is the largest single step. It
passed the same three checks this bin did: never a row more, the page identical in content, and
an entry refused once its tag checksum moves through SQL alone. That last one matters most here,
because a menu save invalidates every cached page.

`render` and `discovery` were measured for the default on 2026-09-24 and both REFUSED, each on a
cost the rows census cannot see. `render` passes the stale-entry check and fits the heap, and would
take a fill 1.75 -> 1.50 rows -- but the first render after an interpreter drop is 2,696 ms with it
in memory against 1,450 with it in SQL (medians, n=10 interleaved, deployed), because the SQL bin
survives the drop and the memory one does not. That lifts a ceiling free traffic does not reach
(the request allowance drives ~4,380 renders/day against 50,916) and charges every cold render
1.25 s. `discovery` sat at its 64-entry bound, evicting, and cost 12.4 MiB of heap. Both stay
available through `MEMORY_CACHE_BINS` for a site that is warm and write-heavy.

#### `agedServeAllowed`

`staleAllowed()`'s built-in deny-list is NOT applied, and that is a decision rather than an
oversight. That list is calibrated for the KV tier, where a stale answer can be 24 hours old and
`/user/login` is on it for good reason. Here the row is the current content superseded seconds
ago by an unrelated save, and applying that list would keep the exact 503 this exists to remove --
the login page was the symptom that started it. Only the OPERATOR's own `NEVER_STALE` entries are
honoured, because those state an intent this cannot infer.

### `src/do/outbound.ts`

#### `ensureHttpTables`

Keyed by METHOD+URL+BODY, not by URL. Both tables were `url TEXT PRIMARY KEY`, which is a live
correctness bug rather than a POST-only gap: two deferred fetches to the same endpoint are one
row, so the second overwrites the first and a caller can be handed a response fetched for
somebody else. For a captcha verification that is one visitor receiving another's verdict.

#### queueHttp, drain wake

Wake the drain, or nothing does.

Draining in alarm() is only half a fix: on an idle site the alarm re-arms at the
240 s keep-warm interval, so a queued request waited up to four minutes. Measured --
a serve-chain assertion sat on a 2-entry queue for 30 s and failed. Arming here
makes the queue self-draining, which is the same reason the fill queue arms.

#### `parkState`

Lazy rather than installed with the other shims, because the probe RUNS PHP: at the point
`installSign()` and friends are wired the interpreter cannot execute yet, so a probe there
throws and reports `failed` on a build that parks perfectly well.

**Arms only when an endpoint is configured**, so a site that never asked for Redis pays
nothing and behaves exactly as it does today. An armed trap diverts every call to its name for
the duration of a parked run -- including a file write, which is why the loop carries a
passthrough branch -- and there is no reason to take that on for a site the loop would refuse
on its first op anyway.

The capability contract gates it, not the endpoint alone. `socket.outbound.blocking` is
executed against the shipping interpreter, and it answers false while a resumed chain
cannot complete -- so arming would divert a render into a park that delivers the host's
value and then loses the rest of the program. When the vector passes this arms itself
TWO CLASSES, armed independently, because they cost different things. `socket` serves
`drupal/redis` and waits for the endpoint that would use it, since its read/write traps
divert every file write inside a parked run. `fetch` serves the module's own Guzzle
transport and needs no endpoint, because the destination is whatever the module asks for
and the SSRF guard is what bounds it. Both stay gated on their capability: arming a class
the park cannot serve routes every render through `cfw_park_run` for a yield that always
falls back, and when `fetch` was armed unconditionally `serve-chain` read a render
estimate of -1.

#### `runJsonMaybeParked`

Two paths on purpose. A parked render costs an extra `_run` per blocking call and rewrites the
fragment through `zend_eval_string`, so a site with no Redis endpoint takes the path it always
has and nothing about it changes.

A parked run that does not finish still answers: the chain is unwound inside `drivePark`, so
whatever the render managed to print is parsed, and only an unparseable answer falls back to a
second unparked render.

**The shell tier used `runJson` DIRECTLY AND THAT MADE IT EXCLUSIVE WITH REDIS.** With the
socket class armed, a `cache_*` read inside `renderPlaceholder()` was not parked: it fell
through to the real `stream_socket_client`, which cannot connect in workerd, so the fragment
render reported `ok !== true` and `assembleFor()` returned null on every request. A site with
Redis configured therefore never assembled a shell, degraded rather than broken, and nothing
anywhere said so. All four shell-tier runs go through here now.

#### performOutbound, timeout

BOUNDED, because this runs on the alarm and the alarm is what fills pages. An outbound
host that accepts a connection and never answers would otherwise hold the firing open,
and the fill queued behind it never drains -- a visitor sees a permanent 503 caused by
somebody else's server. 10 s is far above any of the declared endpoints and far below a
stalled invocation.

#### drainHttpQueue, prepared / six at a time

PREPARED, NOT STARTED. This held a `run: Promise<TcpResult>` begun right here, so every
queued URL opened at once and the chunked loop below only chunked the AWAITS -- while its
comment said the batch "is chunked rather than opened all at once". At the paid
`httpDrainLimit` that is 15 concurrent responses buffered whole on the JS heap, against a
measured ~4 MiB of net isolate headroom; `/__ops` can raise it to 25.

SIX AT A TIME, STARTED HERE. The published subrequest concurrency is 6 and that is what
this loop now opens; serialising entirely would be wrong for the reason the old comment
gave -- N queued URLs would cost N round trips in series and duration is billed on wall
clock. Nothing in `performOutbound` touches SQL, which is what makes six at once safe.

#### queueDeclaredFetches, hourly bound

At most once an hour, and this bound is not cosmetic. Queued on every firing it wrote a
row per declared URL per alarm on any site whose fetch never lands -- measured, rows
per fill went 9 to 10 -- which spends the meter this whole tier is scored against to
re-ask a question that already has an answer or already has a queue entry.

### `src/do/provision.ts`

#### `ensureServeTables()`

```
SQLite gives a rowid table's text key its own unique index, so one logical write is charged
twice on the meter that binds regeneration. Storing the row inside the key's own B-tree charges
once. Measured on `ctx.storage.sql`: insert 2 -> 1, update 1 either way, the serve HIT still
reads one row, and 200 rows of 12 KB html cost +0.32% on disk. On a `warmReassemble` fill
`cfw_page` is 2 of the 3 charged rows, so this is the cheapest class's largest single item.
```

```
// Checked first, not attempted and caught. SQLite has no ADD COLUMN IF NOT EXISTS, and the
// obvious try/catch runs a FAILING DDL on every `ensureServeTables()` -- which dirties
// `sqlite_master` the same way a CREATE TABLE does, turns later reads in the same
// transaction into speculative replays, and was measured taking the serve path into
// `migrate: starting` on 2 of 3 runs. One `pragma_table_info` read instead
```

#### `migrateChunks()`

```
// NOT gated here: `fetch()` already runs the whole
// router inside `this.gate.run()` (see the bottom of this class), so entering again
// would be a nested non-reentrant acquire. The Gate is a FIFO promise chain, so the
// inner entry awaits a release that only happens when the outer returns -- which is
// waiting on the inner. I shipped that for an hour: every request hung past 90 s on a
// fresh object and it read exactly like a platform fault.
//
// The alarm path is the one that needs an explicit acquire, because alarm() is NOT
// gated as a whole -- it enters per fill. See migrateStepIfPending().
```

#### `migrateStepIfPending()`

```
// NO CURSOR STARTS A MIGRATION ONLY WHEN A VISITOR ASKED FOR ONE. Starting on any alarm
// instead was measured hijacking 37 tests: the object migrated first and never reached the
// quarantine check, the HTTP-queue drain or the deferred-POST drain, so an alarm asserting
// any of those got a migration report. The marker keeps this alarm's contract as it was --
// carry an IN-PROGRESS migration forward -- and makes provisioning an explicit request
```

```
// Gated HERE and not in migrateChunks(), because alarm() is not gated as a whole
// while fetch() is. Without this acquire a concurrent /migrate request and this alarm
// both read the same cursor, both replay the same chunk, the loser hits a UNIQUE
// constraint, and the cursor latches to `failed` -- after which /serve answers 503
// forever. An intermittently-failing serve-chain assertion was pointing at it.
```

```
// The digest the packed container was BAKED with, not the one that ships. They agree
// only when `bun run assets:container` ran after the last `assets:driver`; stamping
// the shipping one claimed a container current that could predate a hook, so the hook
// stayed invisible on every fresh site. Without any stamp the reconcile step reads
// `owed` on every fresh site and the first boot rebuilds at 1,024 ms against 86
```

#### `prefillServingTable`

Loads the CI-rendered pages straight into the serving table.

Default on for free, off for paid, overridable both ways. Pre-filling changes what a MISS means
-- a prefilled path is a HIT on its first ever request -- so the switch is explicit per plan.
An absent `prefill.json` is normal: a site that skipped the CI step just starts cold.

Shared by both callers rather than living in the `/__migrate` route, where only a
request-driven migration ever prefilled. A migration that completes on the ALARM chain is the
default and the only path a deployed site takes, so a real deploy finished migrating with
`cfw_page` empty and answered 503 until somebody happened to request a render.

@param asked the `?prefill=` override: '1' forces on, '0' forces off, undefined defers to the plan

### `src/do/reconcile.ts`

#### `updbActive()`

```
// NO DDL ON A READ. This is asked from the alarm, where creating the tables is free, and
// from the status report, where it is not: `Requirements` reaches it through the host and
// an ordinary status render started dirtying `sqlite_master` for two tables a site with no
// update run does not have. A site that has never run `updb` has no active run by
// definition, so the absent table IS the answer
```

```
// An ALLOWLIST of live phases, and both halves of that matter. The field is `phase`,
// not `state` -- reading `run.state` gives undefined, which compared unequal to
// every terminal name and made a COMPLETE run hold the alarm chain forever while
// fills starved. And an allowlist means a phase added upstream later defaults to
// "not active" rather than wedging the chain.
//
// UPDB_PHASES: planning, running, complete, halted, rolled_back, abandoned.
```

#### `updbAction()`

```
 * Beating was the only reachable entry point, so `/updb` could advance a run nothing
 * created and an operator met `{"beat":"none","reason":"no-run"}` -- indistinguishable
 * from "nothing to do". `prepare` is what closes that.
```

#### `sweepBeat()`

```
 * The sweep QUEUES paths and never renders one. That is what makes the isolate failure impossible
 * rather than merely bounded: a `fillBatchSize` of 25 reset four freshly provisioned sites by
 * crossing 128 MiB inside one invocation, and a step that adds no workload to any invocation can
 * never be the batch that does it. The existing fill batch drains the queue under the
 * `oversized()` break it already has.
```

#### `reconcileStepOnce()`

One reconciliation step per firing, or null when this site is already at the shipping version.

Null is the steady state and it costs one `cfw_meta` READ. `reconciled()` compares two integers
and no step is asked anything, so a site that is current pays nothing per alarm for a mechanism
that only matters the day a fix ships.

A step that ran ALWAYS drops the interpreter and the heap image. A restored kernel predates
whatever the step just changed, which is the shape of BUG 1, and making it unconditional means
no future step's author can get the flag wrong.

### `src/do/replication.ts`

#### sealGeneration, branch `generation <= buffer.parent`

A BUFFERED WRITE MUST GET A GENERATION, and returning here would silently lose it --
the buffer is already cleared two lines up, so the statements would go nowhere and no
replica would ever see the change.

The branch was unreachable while `parent` was `commitSeq() - 1`, which is why it could
be a bare return. `parent` is the last SEALED record now, so an invocation that wrote
something authoritative WITHOUT invalidating anything lands here legitimately: the
sequence only advances on an invalidation, and not every authoritative write is one.

#### catchUpOnce, refusal branch

A refusal ends the batch; IT DOES NOT UNDO THE RECORDS AHEAD OF IT, so
everything already applied is owed the same bookkeeping the loop's normal
exit performs. Without this a lane that applied a save and then met an
overflow kept the pages that save invalidated, and reported a commit
sequence behind the state it holds.

#### catchUpOnce, lastWithdrawal

KEPT SEPARATELY FROM `lastCatchUp`, which `requestReadmission()` overwrites
with "stage CREATED needs a restore" on the very next firing -- so the
reason a lane left the pool was unreadable by the time anyone looked, and a
pool cycling out from under its own traffic showed only the symptom.

#### bufferForReplication, parent

THE LAST SEALED RECORD, never `commitSeq() - 1`. That subtraction assumed this
invocation would seal at exactly the current sequence; `sealGeneration()` seals at
whatever the sequence reached by the END of the invocation, so a buffer opened at 69
could seal as `{parent: 68, generation: 70}` while record 69 already chained from 68.
Two records then claimed the same parent, and a lane sitting on the first met the
second as `out of order: applied 69, record builds on 68` -- which `catchUpOnce()`
answers by withdrawing it into a full re-copy. Measured on a fresh 8-lane site: all
eight started SERVING and all eight withdrew on that one sentence.

The last record's generation IS the position a caught-up replica holds, so chaining to
it makes `planApply()`'s `record.parent === pos.applied` exact by construction.

### `src/do/serve.ts`

#### `route()`, before `const arrivedAt`

```
// The queueing signal, taken before the gate because that is the only place it exists.
// `ahead` is what a replica removes: an exact count of requests this one waits behind, with
// no clock in it. See `noteLaneTiming()` for why the two durations beside it are floors.
// **HOISTING `adoptSettings()` OUT OF THE GATE WAS TRIED AND REVERTED, and the reason is
// worth more than the saving was.** `handle()` awaits it first, so once per isolate-minute a
// gated request performs a real `CONFIG_KV.get()` while holding this object's single-threaded
// lane -- 4-6 ms warm, 46-140 ms for a key the colo has not seen. Awaiting it up here
// instead removes that, and it also inserts a microtask boundary into a stretch of `route()`
// that is load-bearing precisely because it is synchronous:
//
// - the HERD check reads `renderFlights` and the leader registers its flight afterwards, so
//   an await between them lets all N waiters miss the map. Measured: eight concurrent
//   identical requests went from one render to EIGHT.
// - `ahead` is read immediately before `gate.run()`, so an await between them makes every
//   concurrent arrival see zero and the queueing signal report nothing.
//
// One KV read a minute against a herd collapse worth 16x on a burst is not a trade. If this
// is worth revisiting, the shape is an out-of-band refresh that leaves the read path
// synchronous, not a hoist.
```

#### `route()`, herd region

```
// Measured deployed: 16 concurrent authenticated readers on a path whose plan had not
// compiled read p50 9,709 ms with `RENDER=16` and zero plan hits -- each paid its own ~2.5 s
// render and they serialised on this object.
//
// The same coalescing in the FRONT WORKER was built and refuted: its map is per-isolate and
// Cloudflare spreads concurrent requests across isolates, so 16 requests still produced 17
// object hops. Here there is exactly one object per site, so every duplicate does arrive at
// the same map -- which is the whole reason this belongs at the object and not above it.
//
// BEFORE the gate, or the waiters each take a gate slot and queue behind the leader anyway,
// which is the cost this removes.
```

#### `route()`, fast-lane migratePartial condition

```
// A restore writes this cursor too. The gated lane has always refused a
// half-migrated site, but this lane answers before the gate and never looked, so a
// warm site returned 200 from `cfw_page` while a rollback was overwriting the
// database underneath it -- measured. Unreachable on a FIRST migration, because the
// pack ships no pages and `serveTablesReady` is false, which is why the migration
// specs never saw it. One indexed read of a single row, no DDL and no await, so all
// three fast-lane conditions still hold.
```

### `src/do/settings.ts`

#### `SERVICES_YAML`

Points Drupal's `page` bin at a null backend, and carries the file stream wrappers.

`cache_page` is a second copy of bytes the object already stores in its own SQL, on a path that
refuses to boot PHP at all -- measured at 12 rows per front-page fill, 4 of them this bin, and rows
written is the meter that binds regeneration. `dynamic_page_cache` and `render` stay: warm, they let
a fill reassemble rather than render, so nulling them trades 8 rows for a full render.

A services file rather than `$settings['cache']['bins']`, because core registers
`cache.backend.null` from a compiler pass and no yaml, so the settings route names a service that
does not exist. Overriding `stream_wrapper.public` by tag is the same story: `public://` belongs to
`StreamWrapperManager`, and a bare `stream_wrapper_register()` loses the race.

The FILENAME is load-bearing. The shipped `settings.php` already appends this exact path
unconditionally, and `getContainerCacheKey()` folds in the raw setting while `addServiceFiles()`
filters to files that exist -- so creating it changes the container without moving the cache key.

### `src/do/stats.ts`

#### `noteLaneTiming()`

```
 * **The two durations are floors, not service times**, and this is the trap the render estimator
 * at `estimateRenderMs()` already documents from a deployed measurement: the wall clock only
 * advances during I/O, so a synchronous `php._run()` contributes ZERO to a `Date.now()` delta
 * taken around it. A cold alarm fill once reported 117 ms for work that cost 1,398 ms of
 * `cpuTime`. So `queueMs` counts only the holder's host crossings and `serviceMs` only this
 * request's, and both understate by all the pure compute in between. Quote them as lower bounds
 * or not at all; the honest absolutes are the client's own clock and `cpuTime` from a tail.
```

```
// How the router finds out lanes exist. Autoscaling writes `lanes_provisioned` into this
// object's own meta and the front worker reads only `REPLICA_COUNT` from env, so a
// contended site copied its database into N objects and kept serving every request from
// one. Reported here rather than fetched: the response is already paid for, the same way
// the generation and the role set ride along
```

#### `serveStatsSync()`

```
// GUARDED, BECAUSE A READ MUST NOT RUN DDL. `storedBytes()` calls
// `ensureFileTables()`, which is three `CREATE TABLE IF NOT EXISTS` statements.
// That was harmless while nothing on a render path read these stats, and the
// status report now does: `Requirements::dailyQuotaRows()` reaches
// `serveStatsSync()` on an authenticated GET, so an ordinary page view started
// dirtying `sqlite_master` for five tables it does not use. `replica-invariant`
// caught it. `attributeSpend` reports a dimension with no counter as null with a
// reason, so an absent table costs the line its value rather than the site a
// hazard
```

```
// The whole isolate, which nothing has ever reported. Every memory figure this project
// has published measures wasm linear memory and subtracts it from 128 MiB to call the
// rest headroom -- and that subtraction has no term for the JS side, which the same
// ceiling covers. Reported as its three parts so a reader can see which one moved
```

```
// rows written is the free plan's binding meter; GC and fills compete for it.
// TWO figures: `rowsWritten` counts only what went through
// execSql(), so it sees Drupal's statements and none of the host's, while
// `rowsToday` comes from countingSql() wrapping the storage handle and is
// therefore complete. The first is kept because measurements are pinned to
// it; the second is the one a quota decision should use.
```

### `src/do/types.ts`

#### `FillOutcome.bootedInFill`

whether THIS fill also paid for the interpreter boot.

Measured inside the fill rather than inferred from `!this.php` at the caller, because the two
disagree and the deployed tail proved it: three paid cold-object renders reported a boot and
cost 55/58/77 ms of cpuTime, while the alarms beside them cost 3,200/3,608/3,623 ms. The
object looked cold when the decision was taken and an alarm had booted it by the time the
render ran behind the gate, so the header credited the render with a boot it never paid for.

NOT `booted`, which the warm-window reply already uses for "an interpreter is up" -- the two
are near-opposites on a warm fill, and spreading this outcome over that field inverted it.

#### `FillOutcome.roles`

The role set this render was for, sorted, or undefined when the render did not report one.

What the edge plan is keyed on. The plan tier used to key on the RAW COOKIE HEADER, so a site
with 200 logged-in users and 50 authenticated paths held up to 10,000 plans instead of
`role_sets x 50` -- and a key a colo has not seen costs 46-140 ms against 4-5 for a warm one,
so a per-user key maximised the expensive case and a logout minted a fresh one.

#### `FillOutcome.notReady`

The render failed because the SITE is not ready, not because the render is broken.

Today the one case is Drupal redirecting to `/core/install.php`, which is the database saying
it has not been installed. The serve path answers an ordinary failure with 500 on the ground
that "503 is right for a page that is coming; a page that threw gets the exception" -- and
this is the first of those. It stayed invisible while free refused to render inline at all,
because the refusal answered 503 before a render could report anything.

#### `Payload`

`any` values rather than `unknown`, with the trade named: each of these crosses a PHP or SQL
boundary as arbitrary JSON whose shape depends on which fragment ran, several call sites ADD
fields to one after the fact (`out.continuation`, `result.prefilled`), and `unknown` would turn
roughly forty guarded reads into casts without making one of them safer.

### `src/drupal/argon2-fix.ts`

#### Module overview and `ARGON2_BRIDGE`

argon2id password hashing, computed on the HOST side.

##### The blocker that was recorded, and the one that is real

argon2 was closed on memory: `PHP_PASSWORD_ARGON2_MEMORY_COST` defaults to 64 MiB, the isolate is
128 MB shared between JS and wasm, and an install already peaked at ~115 MiB. That reasoning is
correct about ONE mechanism -- an arena inside PHP's own heap, where `memory.grow` has no inverse,
so the first hash would raise that object's floor for the rest of its life.

It is not correct about argon2id. A JS-side arena is garbage-collected rather than permanent, and
OWASP's floor is m=19456 KiB (19 MiB), t=2, p=1 rather than 64 MiB. Measured on a DEPLOYED
throwaway (`cfw-arena-probe`, torn down), every OS page touched on both sides:

| resident wasm         | transient JS arena     | result |
| --------------------- | ---------------------- | ------ |
| 96 MiB                | 19 / 32 / 48 / 64 MiB  | all ok |
| 117 MiB (auth render) | 19 MiB                 | ok     |
| --                    | 19 MiB x 10 in a row   | 10/10  |

The first version of that probe touched one byte per 64 KiB wasm page, making 1 OS page in 16
resident and understating the footprint 16-fold. These are from the corrected one.

##### Why the hash is not computed in PHP

Two reasons, and the memory one is the smaller. `password_hash()` is a built-in that cannot be
redeclared, so a shim of the kind `curl-fix` and `openssl-fix` use is not available here -- the
guard would never pass. Drupal's own seam is the `password` service, which
`DrupflareServiceProvider` already alters, so `CfwPassword` in the sibling module calls the
helpers below and core's `PhpPassword` never runs. That is an ordinary Drupal service swap rather
than a patch, which is what an unmodified module requires.

##### Why @noble/hashes rather than an implementation here

Audited, dependency-free, synchronous TypeScript. The alternatives lose on this runtime for
reasons that are not about quality: `hash-wasm` and `argon2-browser` instantiate their wasm from
base64 on first call, which is REQUEST time, and workerd refuses codegen there -- the same rule
that forces the interpreter to be instantiated at module scope. A hand-written BlaMka would be
~250 lines of 64-bit arithmetic in a language without a 64-bit integer, to reproduce something
already audited.

#### `ARGON2_DEFAULTS`

m=19456 KiB, t=2, p=1. OWASP lists m=47104/t=1 as the other equal-strength option; that one is
46 MiB and has no reason to be preferred here, where the arena is the scarce thing. Anything
BELOW this is not offered -- a weaker argon2 is worse than the bcrypt cost 12 already shipping,
which is the objection that closed this item the first time and is still correct at 8 MiB.

#### `ARGON2_FIX`

NOT a `password_hash()` shim. That function is a built-in and always declared, so a conditional
declaration would never bind -- the inert-shim-guard failure, arrived at from the other direction.
Drupal's `password` service is the seam instead.

The encoded form is PHP's own, `$argon2id$v=19$m=..,t=..,p=..$salt$tag` with unpadded base64, so a
hash written here verifies on any ordinary PHP with ext-argon2 and a site can migrate off this
platform without every password becoming unverifiable.

### `src/drupal/iconv-fix.ts`

#### `ICONV_STRRPOS`

Corrects `iconv_strrpos()` in symfony/polyfill-iconv, which returns the wrong index whenever the
last match sits at the start of the string.

`Iconv.php:495` measures the wrong slice:

    return false === $pos ? false
      : self::iconv_strlen($pos ? substr($haystack, 0, $pos) : $haystack, 'utf-8');

`$pos` is an OFFSET, so a match at index 0 is falsy and the ternary measures the whole haystack
instead of an empty prefix. It answers `strlen()` where the extension answers 0. Measured on 8.5.7
against the real extension:

    iconv_strrpos('a', 'a')            native 0   polyfill 1
    iconv_strrpos('ab\0cd', 'a')       native 0   polyfill 5
    iconv_strrpos('AbC-123_xyz', 'A')  native 0   polyfill 11

`iconv_strpos()` twelve lines above has the same ternary written the other way round and is
correct, which is what makes this a slip rather than a policy. Present on upstream `main` as of
2026-08-21, in v1.37.0.

It reaches this project because the wasm build has neither extension: polyfill-mbstring's
`mb_strrpos()`, `mb_strripos()`, `mb_strrchr()` and `mb_strrichr()` are all thin wrappers over
`iconv_strrpos()`, so all four are wrong at index 0. No Drupal core path calls them -- the only
non-test caller in the tree is `symfony/string`'s `CodePointString::indexOfLast()`, which core does
not reach -- so this is a correctness fix for contrib rather than a live defect.

### `src/drupal/mb-fix.ts`

#### `MB_SANITIZE`

The bug. Without the mbstring extension, Symfony's polyfill provides mb_*. Its mb_substr() is
`return (string) iconv_substr(...)`, its mb_strlen() is `if (false !== $len = @iconv_strlen(...))`,
and Symfony's *iconv* polyfill returns FALSE for any string that is not valid UTF-8. `(string) false`
is `''`. So a stored value carrying one bad byte comes back BLANK where native PHP returns the text
with the bad bytes replaced by '?'. Core calls mb_substr 50 times and mb_strtolower 66 times.

The prescribed fix is wrong. AGENT-TECHNICAL_REPORT.md TASK C says "compile the real iconv extension
into the wasm build" and calls it cheap. It would not work. Measured on native PHP 8.5.7 with the
REAL iconv extension loaded:

  iconv_substr("abc\xff\xfedef", 0, 100, 'UTF-8')  ->  false
  iconv_strlen("abc\xff\xfedef", 'UTF-8')          ->  false
  mb_substr("abc\xff\xfedef", 0, 100)              ->  'abc??def'

Real iconv fails on invalid UTF-8 exactly like the polyfill does. It is real MBSTRING that
substitutes. So compiling iconv in leaves the polyfill's `(string) false` intact and changes nothing.

What this does: defines the affected mb_* functions BEFORE the polyfill's bootstrap runs, so its own
function_exists() guards skip. Each one replaces invalid UTF-8 with '?' -- byte for byte what native
mbstring's substitute character does -- and then delegates to the polyfill class for the real work.
No vendor file is edited and no rebuild is needed.

What it does not touch: mb_check_encoding() and mb_detect_encoding() must keep seeing the original
bytes: sanitising first would make mb_check_encoding() answer TRUE for input that is invalid, which
turns a correct answer into a wrong one. Both already agree with native.

Compiling real mbstring in (--enable-mbstring --disable-mbregex) remains the durable fix; this is the
one that works today and it is what the tests pin.

INERT ON THE SHIPPING BUILD AS OF 2026-09-08: the guard is `!extension_loaded('mbstring')` and the
long64 build carries the real extension; `loaded-extensions.spec.ts` says which build is which.

#### `MB_ASCII`

THE ASCII FAST PATH is not only a speed lever, though it is a large one -- the polyfill routes every
call through iconv even for bytes it cannot possibly change. Drupal's hot `mb_strtolower` inputs are
machine names, field names, langcodes and header names, all ASCII.

`strtolower()` is safe to substitute only because this is PHP 8: it became locale-insensitive and
ASCII-only in 8.2, so the C-locale trap that made this wrong on older builds is gone.

THE FINAL SIGMA post-pass closes the divergence that has been on record longest. Lowercasing a
word-final capital sigma must give U+03C2, and the polyfill's flat table gives U+03C3, so a Greek
title produces a different search key, sort order and URL alias in wasm than on a normal host. The
rule is contextual rather than per-codepoint, which is why a table cannot express it: sigma is final
when a letter precedes it and none follows.

### `src/drupal/openssl-fix.ts`

#### Module overview and `SIGN_BRIDGE`

`openssl_sign()` and `openssl_verify()` over `node:crypto`, synchronously.

The premise this was scoped under was wrong. It read "crypto.subtle covers RS256/ES256 but is
**async**, so it takes the queue/read-later pair", which would have made every signature a
two-invocation round trip through a deferred queue. Measured 2026-08-23 in workerd: `node:crypto`
exposes `createSign`/`createVerify` and they are SYNCHRONOUS -- a 2048-bit RS256 signature comes back
in-line, 256 bytes. So this is an ordinary bridge like `cfwZlib`, not a deferred one.

Why `openssl_*` rather than a new `cfwSign()` function. An unmodified module is the whole claim.
`firebase/php-jwt`, Google's auth client and Stripe's webhook verifier all call
`openssl_sign()`/`openssl_verify()` directly, so shimming the names PHP already uses makes them work
untouched. A new function would have required every one of them to be patched.

What is here now, and why it grew. The scope above was two functions and a note that the rest had "no
caller in this project". Three of the four names `ShimRegistry` refused turned out to have a measured
synchronous primitive behind them AND a named caller -- `openssl_pkey_get_public()` is what turns a
JWKS entry into something `openssl_verify()` accepts, which is the missing step in every OIDC library.
Measured in workerd, every call synchronous: `generateKeyPairSync` produced an RSA-2048 SPKI PEM of 451
bytes, `createPublicKey({key: jwk, format: 'jwk'}).export()` returned bytes IDENTICAL to that PEM, and
`privateEncrypt` returned 256.

The symmetric half, key details and certificates are here too, because every SSO and OAuth library in
real sites needs them: `openssl_encrypt`/`openssl_decrypt` (AES CBC, CTR, ECB and GCM) for
defuse/php-encryption and xmlseclibs, `openssl_pkey_get_details` for league/oauth2-server and
lcobucci/jwt, `openssl_x509_*` for php-saml, OAEP `openssl_public_encrypt` for XML encryption, and
`openssl_pkey_derive` (ECDH) for web push. Each is one synchronous `node:crypto` call.

What is still not here. `openssl_csr_new` and the PKCS#7/CMS family. `node:crypto` has no
certificate-request primitive at all, so that one is absent rather than unimplemented, and it stays
refused with the reason named. `openssl_x509_checkpurpose` needs a trust store and purpose table this
runtime does not carry, so it answers -1 and records a degradation.

#### `OPENSSL_FIX`

`openssl_sign()` takes its signature by reference and returns a bool, which is the shape callers
check; `openssl_verify()` returns 1, 0 or -1, where -1 is "an error occurred" rather than "invalid".
Getting that tri-state wrong would make a failed verification look like a successful rejection, so the
three are kept distinct. Keys and certificates are `OpenSSLAsymmetricKey` and `OpenSSLCertificate`
objects, declared here because the extension that owns those names is absent; lcobucci/jwt and
league/oauth2-server type against them, so a PEM string where an object belongs is a TypeError. Every
function still accepts a PEM string, a `file://` path or the older two-key array wherever ext-openssl
accepts a key.

### `src/drupal/reconcile-php.ts`

#### `reconcileRouterPhp`

THE SHIPPED PACK HAS `drupflare` IN `core.extension` AND NONE OF ITS ROUTES. Measured 2026-09-09
by rebuilding the pack database from `install-site-db.php` and diffing: the rebuilt file carries
`drupflare.admin`, `drupflare.status`, `drupflare.ops_terminal` and `drupflare.oidc_complete`
plus three menu links, and the shipped one carries zero of the seven. The module was enabled into
the pack before those routes existed and `router` was never rebuilt after, so the Drupflare admin
section, Runtime Status and the Operations Terminal answer 404 on every site.

The container step next to this one cannot fix it: dropping `cache_container` makes the next boot
rediscover HOOKS, and `router` is a table `RouteBuilder` writes rather than a cache Drupal
rebuilds on demand.

`setRebuildNeeded()` then `rebuildIfNeeded()` rather than `rebuild()` directly, because the
unconditional form does the work again on a site that is already current, and this runs inside an
alarm with a CPU budget.

#### Module overview

`system.performance:cache.page.max_age` was fixed correctly in the `config` table and stayed inert,
because `cache_config` held its own serialized copy and Drupal reads the bin first. Every render on
every site still answered `no-store` for the whole time the fix was believed shipped.

`ConfigFactory::save()` writes the row, clears the bin and invalidates `config:<name>`, which is
what makes the render caches downstream of it stale. State keeps a static cache and a
`cache_bootstrap` copy and `State::set()` knows about both. A host re-deriving either list gets it
wrong, and the copy it forgets is the one that made the original fix inert.

### `src/drupal/site-php.ts`

#### `renderPage`

Renders one path and hands the HTML back, for the alarm to store.

Separate from drupalRequest() because that one reports timings for measurement
and this one produces a cache entry. Both empty the page bin first: the point of
an alarm fill is to produce a fresh render, and PageCache would otherwise answer
from its own memoized cid.

`bins` names what is emptied, and it is load-bearing rather than cosmetic:
`['page']` alone leaves `dynamic_page_cache` warm, so the page is REASSEMBLED
from cached render arrays instead of rendered. That is the cheap path a
pre-filled site takes on a MISS, and the two cost 4.3x different amounts, so a
caller has to choose which one it is asking for.

`destruct` defaults to FALSE on the render path, and that is a measured decision
rather than an oversight.

The hypothesis was that nothing ever completed the request lifecycle, so every
`needs_destruction` CacheCollector discarded its accumulated entries instead of
writing them, and the render paid to rebuild them every time. The mechanism is
real. The payoff is not: with the five safe services destructing, a repeated
anonymous front-page render costs **17 host statements against 15**, writes the
**same 15 rows**, and returns the same 12,310 bytes. Cost, no benefit.

The reason is the same property that made `$kernel->terminate()` dangerous here:
the interpreter is PERSISTENT, so the collectors are already populated in memory
and never re-read from cache. Persistence only pays for a fresh process. On this
runtime the in-memory collector IS the cache.

Still worth passing `true` on a WRITE path, where `router.builder`'s
`rebuildIfNeeded()` and accumulated state flushes are correctness rather than
speed. Unmeasured: whether persisted collectors pay for themselves on the COLD
path, after a hibernation discards the interpreter.

#### HTTP_CLIENT_CHECK fragment

Does `Drupal::httpClient()` return a body, on the shipping binary?

It did not, for the whole life of the project, and the comment saying it did is the finding:
`DrupflareServiceProvider` left core's `StreamHandler` in place on a non-suspending build and
called that "the behaviour that actually works today". It works for `file_get_contents()`. For
Guzzle the fetch SUCCEEDS and the result is thrown away one line later --
`StreamHandler::createStream()` reads `$http_response_header`, a magic local only PHP's own http
wrapper populates, so `HeaderProcessor::parseHeaders([])` raises and every call rejects with
`RequestException: An error was encountered while creating the response`.

THE CONTROL IS WHAT THIS FRAGMENT ADDS. It drives core's handler over the same wrapper and
the same cached row and requires it to STILL fail; a seam whose control goes green is measuring
something other than the defect and must be thrown away rather than kept. The caller seeds
`cfw_http_cache` itself, so nothing here touches the network.

#### `accept`

the raw `Accept` header, which decides the SHAPE of every AJAX response.

`AjaxResponseSubscriber::onResponse()` wraps the JSON in a `<textarea>` and relabels it
`text/html` whenever `Accept` contains `text/html` -- an IE9 iframe-upload workaround. Absent
here, `Request::create()` fills in its own default of
`text/html,application/xhtml+xml,...`, so EVERY Drupal AJAX response came back wrapped and
`Drupal.AjaxError` fired on every one. Measured on Add field, where picking a field type is an
AJAX POST: the admin got "Oops, something went wrong" and no field could be created.
A browser asking for JSON sends `application/json, text/javascript`, which does not match.

### `src/drupal/sodium-fix.ts`

#### Module overview

Replaces the `sodium_crypto_generichash*` family, which no build here can provide.

BLAKE2b IS ABSENT FROM EVERY LAYER, MEASURED RATHER THAN ASSUMED. The shipping binary
loads 25 extensions and `sodium` is not one of them, so `sodium_crypto_generichash()` is an
undefined function. `ext-hash` IS loaded and offers 62 algorithms with no `blake*` among them --
and that is a property of PHP rather than of this build, since native 8.5.7 with the full
extension reports the same 0. workerd has none either: `node:crypto` answers "Digest method not
supported" for `blake2b512` and `crypto.subtle` answers "Unrecognized or unimplemented digest
algorithm". So there is nothing to fall back to and the digest has to be computed in JavaScript.

WHY IT BLOCKS AN INSTALL RATHER THAN A FEATURE. A content-addressed store writes the digest into
every frame header, so it IS the address: substituting sha256 is a different store rather than a
downgrade, and a module of that shape does not install at all without this.

`blakejs` is 12 KB of pure JavaScript with no dependencies, and synchronous -- the constraint
`zlib-fix` names applies unchanged: the shipping build sets `ASYNCIFY=0`, so a host function
that returned a Promise would hand PHP an object it can only stringify.

THE AEAD IS THE OTHER HALF AND IT IS HERE TOO, over a different library for a reason. It is a
CIPHER rather than a digest, so it shares no mechanism with the above: `crypto.subtle` offers
AES-GCM and no XChaCha20-Poly1305, and the extended 24-byte nonce is what such a store picks
the construction for. `@noble/ciphers` is the library `edgeport` assembles SSH's
chacha20-poly1305 from, and it is synchronous.

`extension_loaded('sodium')` stays FALSE either way, because the rest of the extension is not
here and a stub extension entry is the shape that took the isolate down at exit 139.

The Module key the PHP half resolves through `vrzno_env()`.

#### `aeadHostCall()`

One AEAD operation.

THE TWO FAILURE MODES ARE KEPT APART AND THAT IS THE WHOLE CONTRACT. ext-sodium's `_decrypt()`
returns FALSE when the tag does not verify and THROWS `SodiumException` when an argument is the
wrong size, and a caller reads the difference: a FALSE means the frame failed authentication and
should be swept, while a throw is a programming error. Collapsing them would make
a mis-sized key look like a tampered frame and sweep a healthy store.

#### `MAX_OPEN_STATES`

How many incremental digests may be open at once.

A state that is never finalised leaks its context for the life of the object, and a Durable
Object outlives many requests. It refuses past the cap rather than evicting the oldest: an
evicted context would make a later `final()` answer a digest computed over part of the message,
and a wrong content address is worse than a failed one.

#### `blake2bHostCall()`

One BLAKE2b operation, decoded.

Four ops rather than one, because `Hash::ofStream()` digests a 256 MiB object a megabyte at a
time and must never hold the whole thing: `hash` is the one-shot, and `init`/`update`/`final`
are the streaming form. The context stays here behind an integer handle for the reason
`CurlShim` keeps a handle at all -- there is nothing for PHP to hold. Unlike CurlShim's array,
this one cannot usefully be a PHP value: a BLAKE2b context is eight 64-bit words plus a 128-byte
buffer, and crossing it through the codec on every 1 MiB chunk would encode and decode ~192 bytes
of state per chunk to gain nothing PHP can read.

A failure is a reply rather than a throw; the PHP half turns it into the `SodiumException`
ext-sodium raises.

##### inside blake2bHostCall(), the final-length comment

libsodium fixes the digest length in the parameter block at init, so a different
length here cannot produce that digest. ext-sodium answers 64 bytes anyway -- measured
on 8.5.7, final($state, 64) on a state inited at 32 returns the 32-byte digest
followed by 32 bytes of adjacent memory -- so this REFUSES where native leaks

#### `SODIUM_FIX`

The PHP half: the four functions, the six constants and `SodiumException`.

Which functions: the `sodium_*` surface a content-addressed store reaches for. Six calls
to `sodium_crypto_generichash()` and one each to `_init`, `_update` and `_final` -- so the
one-shot and the streaming form are both reached, and `Hash::ofFile()` reaches the streaming one
on every captured file.

`extension_loaded('sodium')` STAYS FALSE. It is the guard this fragment is itself
written under, and a stub extension entry is the exact shape that took the isolate down at exit
139 when it was tried for mbstring. A caller testing for the extension gets an honest no; a
caller calling the function gets a digest.

NO `eval()`, following `zlib-fix` and `curl-fix`: a conditional declaration colliding with an
internal function is deferred to runtime, so this compiles clean on a build that HAS ext-sodium
and the branch never runs. That is what lets `tests/node/php-fragments.spec.ts` run `php -l` over
the body rather than over a string literal.

### `src/drupal/zlib-fix.ts`

#### `DICTIONARY_OPS`

The two ops a preset dictionary may be used with, and it is TWO rather than six.

MEASURED, and the measurement chose the implementation. `node:zlib` honours `{ dictionary }`
inside workerd -- 51 bytes to 15 on the probe input, `78bb` plus the dictionary's adler32 in the
header -- so the capability costs no bundle bytes at all. `fflate` honours it too and its output
is byte-identical, but the two differ on the case that matters: given the WRONG dictionary,
`node:zlib` answers "Bad dictionary" and fflate returns plausible garbage that decompressed
cleanly ("g else entirelyg else entirely..."). Silent corruption of a content-addressed frame is
the failure this capability exists to enable a store to avoid, so the dictionary path goes
through `node:zlib`. The six ops with no dictionary stay on fflate untouched.

gzip is excluded because RFC1952 has no header field to signal a preset dictionary: fflate emits
an ordinary gzip stream and `zlib.gunzipSync` answers "invalid distance too far back", so the
frame is readable by nothing else.

RAW deflate is excluded for the same reason as fflate. It interoperates fine, but a raw stream
has no header, so there is nowhere to put the dictionary checksum and a wrong dictionary is
undetectable. Six bytes of header is not worth that.

#### `ZLIB_FIX`

Defined only when the bridge resolves. Returning FALSE from every call on a host with no bridge
would let `AssetDumper` write a zero-byte `.gz` next to a real `.css` and serve it as gzip, which
is a broken site that looks fine in the logs. An undefined function is loud, and a build that has
no bridge has no database either.

Which functions: every zlib call site in Drupal 11.4.5 outside tests, found by grep over the whole
tree: `Asset\AssetDumper::dump()` calls `gzencode($data, 9, FORCE_GZIP)`; `Component\Utility\UrlHelper`
calls `gzcompress()` and `@gzuncompress()`. `gzdecode`, `gzdeflate` and `gzinflate` are carried because
they are the inverses of the three that are reached and a codec that can encode a form it cannot decode
is a defect, not a saving.

What is not covered, all three out of reach of a synchronous bridge or off the served path: `gzopen()`
and the rest of the stream family (`pear/archive_tar`, the update manager's tarballs),
`gzencode`/`gzdecode` in `symfony/http-kernel`'s profiler storage, and the `compress.zlib://` stream
wrapper named by `Core\Command\DbImportCommand`. A stream wrapper is a separate mechanism from a
function, and none of the three runs while a page is being served.

`cfw_zlib_dict()` is declared outside the extension guard. The shipping binary does load ext-zlib
(one of the 25 extensions `get_loaded_extensions()` reports), so everything under
`!extension_loaded('zlib')` is inert on the edge and exists for a `WITH_ZLIB=0` build. A dictionary is
not something ext-zlib provides at any version, so a capability declared under that guard would have
been a function nothing could ever reach.

### `src/ops/admin-session.ts`

#### Module overview

The browser's way of presenting the owner token.

A page cannot set an `Authorization` header on its own navigation, so the admin surface had two
states and both were wrong: behind `PW_DIAGNOSTICS` it was reachable by anybody who could reach
the worker, and without it every button called `window.prompt()` and pasted the token again. The
Access page's Configure form could not work in either state, because a plain HTML POST has nowhere
to put a bearer token.

The cookie carries the token itself rather than a session id derived from it. A session id would
need its own row and its own expiry in the object; the token already exists, already has a
constant-time comparison, and is checked on exactly the hop that a session id would have cost.
`HttpOnly` keeps it out of reach of page script, which is stronger than the prompt it replaces.

#### `OWNER_FAIL_LIMIT`

THE THREAT IS THE METER, NOT THE TOKEN. The owner token is 32 CSPRNG bytes and `tokenMatches()` is
constant-time over its full width, so guessing it is not a practical attack and this is not a
brute-force defence. What was unbounded is the COST of guessing: `ownerCredential()` resolves the
site and fetches `/__ownercheck` on the Durable Object for every presented token, so an
unauthenticated client could drive the object's request counter -- the meter the whole free-plan
model is scored against -- at one request per HTTP request, for free, until the site degraded to
read-only.

12 rather than 3, because an operator with a stale cookie in an open tab should not lock themselves
out of their own site: every navigation presents the same wrong token, and the window below is what
clears it.

#### `failures` map

Per isolate, deliberately. A durable counter would need a row per attempt, which spends the meter
this exists to protect -- the same self-defeating shape as the daily counters that were most of what
they counted. An isolate-local bound does not stop a distributed attacker and is not meant to; it
removes the amplification, which is the part that was free.

### `src/ops/aggregates.ts`

#### Module overview

##### Why the page rather than the library list

The obvious input is the render array's `#attached[library]`, and by the time a RESPONSE exists it
is gone -- so the host cannot ask which libraries a page used. The page itself names every file,
which is the same information from the other side, and it needs no PHP change to read.

##### The safety rule, which is the whole design

A library is replaced only when EVERY one of its files appears in the page, CONTIGUOUSLY and in
declaration order. Anything else leaves that library's tags alone. That is what makes the failure
mode "fewer libraries aggregated" rather than "a page missing rules": a partial replacement is
exactly the broken-CSS page the last attempt at this shipped, and it looked faster.

### `src/ops/ai.ts`

#### Module overview

Workers AI as a QUEUED tier, over the same queue the HTTP and TCP tiers already use.

An inference call has the same shape every outbound call here has: PHP names the whole operation,
the host runs it between invocations, and the answer is read on a later one. `drupal/ai`'s
provider interface is synchronous and has no async form, which this tier satisfies by having the
answer already.

"The interpreter cannot await" was the stated reason and it expired. `ext/cfwpark` freezes the
Zend continuation and resumes it after host-performed I/O, so an inference COULD block a render.
Two things still say queue, and neither is about the interpreter. A generation is seconds rather
than milliseconds, so an inline call spends the visitor's whole request on one field. And the
neuron meter below is a hard 429, so an inline call fails a page for a quota the page did not
need -- where a queued one degrades to nothing. Streaming is the case that stays genuinely
closed: a park delivers one answer, not a stream, and that holds whatever the meters do.

The `AI` binding, never the REST API. A REST call to `api.cloudflare.com` needs
`Authorization: Bearer` and an account id in the URL, so the account token would have to be
readable from the queue row; the binding carries its own authorisation and needs no header.

Neurons are a FOURTH meter. 10,000/day on free and paid alike, reset at 00:00 UTC, and
exhaustion is a hard 429 rather than a bill. Neither of RULE 0b's two ceilings sees it, so it is
projected from the model and the workload the way the Images meter is -- see `neuronCost`.

Degrades to nothing. No binding and every function here refuses with a reason, so the tier can
ship before any account has enabled Workers AI.

#### `DEFAULT_AI_MODELS`

Short and weighted toward embeddings: at 1,075 neurons per 1M input tokens, indexing 1,000 nodes at
500 tokens each is 538 neurons, about 5% of a day. A `llama-3.3-70b` completion is 129 neurons, so the
same allocation buys 77 of them.

### `src/ops/auth-budget.ts`

#### Module overview

A bounded daily allowance for AUTHENTICATED traffic, and a degrade ladder for past it.

MEASURED WITH `bun scripts/measure/free-envelope.ts --visits=3000000 --dynamic=0.01`, and every
number below is from that run rather than from arithmetic done here:

| ceiling                      | value                              |
| ---------------------------- | ---------------------------------- |
| serving                      | 100,000/day, worker-bound, **1.00x** |
| regeneration, windowed       | **10,866/day, rows-bound**         |
| regeneration, alarm chain    | **10,866/day, rows-bound**         |

At the default 25% reservation that splits as:

| slice                        | rows/day | what it buys                              |
| ---------------------------- | -------- | ----------------------------------------- |
| authenticated                | 25,000   | **3,125 authenticated views/day**         |
| anonymous regeneration       | 75,000   | **8,149 regenerations/day** (8.15x need)  |

The anonymous side still clears the 1,000 regenerations/day a 3M-visit month needs at 1% dynamic,
with 8.15x headroom, which is the property that makes the reservation safe to take.

All of these describe `MEMORY_CACHE_BINS=none`, the conservative arm. The two regeneration rows
are equal because the alarm chain was priced at 180 invocations per fill until 2026-09-23, a
boot-slicing mechanism nothing performs; a deployed free worker drains a batch in one invocation.

Paid has no reservation. The meters it is protecting do not bind there, and a limit that exists
only to be never reached is a limit a reader has to explain later.

#### `DAILY_ROWS_QUOTA`

The two figures from `scripts/measure/free-envelope.ts` this module needs.

Copied rather than imported, because of the bundle: `free-envelope.ts` carries an
`import.meta.main` CLI block that reads `process.argv`, so importing it here would drag a script
into the Worker. Copying a measured number is the drift hazard this project has been bitten by
twice, so it is pinned instead: `tests/unit/auth-budget.spec.ts` asserts both against the script's
own exports, and the spec fails the moment either moves.

#### `ROWS_PER_AUTH_RENDER`

`ROWS_PER_FILL.realRender`; both cache bins empty, which is what an authenticated view costs.

It describes `MEMORY_CACHE_BINS=none`; with the shipping default an authenticated view is 2, and
this tracks `ROWS_PER_FILL.realRender` rather than leading it.

9 -> 8 on 2026-09-23, and the row that went was never PHP's: the audit harness deleted the page
row inside its own tracked window before re-filling, and a DELETE is charged where a fill upserts.

#### `SESSION_COOKIE_RE`

Cookies that mean "this request belongs to a session".

`SESS` over HTTP and `SSESS` over HTTPS, then **exactly 32 lowercase hex characters**.

Read off the source; the first version of this was written from memory and was wrong in a way
that mattered. `SessionConfiguration::getName()` is
`($request->isSecure() ? 'SSESS' : 'SESS') . $this->getUnprefixedName($request)`
(`drupal-src/core/lib/Drupal/Core/Session/SessionConfiguration.php:79`), and
`getUnprefixedName()` ends `return substr(hash('sha256', $session_name), 0, 32);` at line 109 --
**outside** its if/elseif/else, so all three branches hash. The test-user-agent branch and the
`cookie_domain` branch produce 32 hex characters too. There is no unhashed form to be lenient
about.

The loose pattern that assumed otherwise matched `SESSION=`, which is a common cookie name in
other frameworks. Every request carrying one would have been charged as authenticated and
rendered, which destroys the allowance this module exists to enforce rather than protecting it.

The safety argument that motivated the looseness is real but belongs elsewhere: an authenticated
response must never reach the shared anonymous cache -- this project shipped that once, a render
that kept uid 1 landing in the anonymous page cache at 90,038 bytes against 12,296. That is
enforced STRUCTURALLY in `src/site.ts`, which refuses to cache when the request was authenticated
or the response carries `Set-Cookie`, so it does not depend on this pattern being perfect.

#### #region the contract with the Durable Object

The counter needs durable state, which only the object has. Rather than the Worker asking for it
-- a DO request spent to decide whether to spend a DO request -- the object reports it on the
response to the hop the request was making anyway, exactly as the generation pointer already does.
The Worker memoises that per UTC day, so once the allowance is gone it degrades at the edge with
ZERO DO cost, which is the only version of this that actually protects the meter.

### `src/ops/capability-contract.ts`

#### VECTORS entry `socket.park.inline`

EXECUTED, and it has to be: `function_exists('cfw_park_run')` was the obvious probe and it
is the decorative kind. The first built revision of the extension exported every symbol
and did not re-arm inside `cfw_park_resume`, so a chain parked ONCE and then ran its next
trapped call for real -- silently, because a fall-through is the refusal path. Every
multi-trip exchange, which is every real one, would have been broken on a build that
probe called capable.

**AND THE FIRST VERSION OF THIS PROBE ANSWERED TRUE ON A MECHANISM THAT CANNOT WORK.** It
put both trapped calls directly in the eval body, which is the one frame `cfw_park_resume`
DOES re-enter -- so it measured the narrow case and reported the capability. Real code
parks inside a nested call: Predis reaches `fwrite` from `StreamConnection::write`, several
frames down. The calls live in a function here for that reason, and the probe additionally
requires the DELIVERED value rather than the state strings, because a chain can answer
`DONE` having lost everything above the frame it resumed.

It cleans up after itself either way: a build with no re-arm has already finished the chain
by the time it answers, and one with the re-arm is resumed a second time here.

#### VECTORS entry `files.realpath`

probed on the METHOD. The first version of this row asked for a marker function
`cfw_realpath_materialises()` that nothing declares -- a probe for a capability's
advertisement rather than for the capability, which is the trap this whole file exists for

#### VECTORS entry `runtime.mbstring.core_parity`

literal characters, not '\\xC3\\x89': PHP single quotes do not interpret \\x, so the first
version compared two 8-character ASCII strings and reported a parity failure that was
entirely its own escaping

#### VECTORS entry `media.getimagesize`

`ShimRegistry` classified it REFUSE on "gd/libjpeg are not linked", and it is
`ext/standard` -- it parses headers itself and never went through either. It is
`CfwImageToolkit`'s only dimension source, so the wrong claim was load-bearing

### `src/ops/catalog.ts`

#### `SHIPPED_BLOCKING_SOCKET`

```
 * TRUE, measured 2026-09-08 on the long64 build carrying `ext/cfwpark`: PHP opens a socket, writes
 * and reads twice, and receives `+OK|+PONG` from the rig's Redis -- five parks, each answered from
 * JavaScript on a later `_run`. `park-interpreter.spec.ts` is the assertion, and it drives a real
 * server rather than a stub.
 *
 * It was false until two defects in the extension were fixed, and both are worth knowing because
 * each failed SILENTLY: `cfw_park_resume` did not re-arm, so every trip after the first ran the real
 * function down the refusal path; and the safety predicate's floor was a frame belonging to the
 * invocation that started the chain, so on a resume the walk went past the parked chain into reused
 * VM stack memory -- reading first as a refusal, then as `memory access out of bounds`. A resumed
 * chain now relinks its root to the resuming frame, which is what `zend_generator_resume` does.
```

#### `SHIPPED_BLOCKING_HTTP`

```
 * **AN UNQUALIFIED CALL INSIDE A NAMESPACE IS RESOLVED AT RUNTIME.** `call_user_func_array` normally
 * leaves no frame at all -- `zend_compile_func_cufa` rewrites it to `ZEND_INIT_USER_CALL` -- but that
 * rewrite needs the compiler to have resolved the name, and inside a namespace an unqualified call
 * compiles to `ZEND_INIT_NS_FCALL_BY_NAME` instead. So the frame is real in every namespaced file,
 * which is all of Drupal, and absent in the global namespace, which is where every harness that read
 * this safe was written. Measured on native 8.5.7 as 3 frames against 2, and on this build through
 * the shipping pack as one internal frame between `FormBuilder::retrieveForm` and its callback.
 *
 * `park_flatten()` in `ext/cfwpark` splices such a frame out of the chain rather than refusing it:
 * the callee is relinked to the trampoline's caller and its `ZEND_CALL_TOP` cleared, so its return
 * takes the path the VM already uses for a nested call. `array_map` and `usort` are still refused,
 * which is the control that makes the change mean anything.
 *
 * The consequence is asserted end to end in `park-oidc.spec.ts`: a real authorization code from the
 * rig Keycloak, exchanged by `drupal/openid_connect`'s own client inside the callback request.
```

#### `SHIPPED_CRON`

```
 * `cron` stays a literal, and the reason is worth stating: `async.cron` measures whether the
 * RUNTIME declares cron to PHP, which it does not, while this flag means "the alarm exists and drives
 * Drupal's cron", which it does. Two different questions with two different answers; collapsing them
 * would refuse every cron module on a site where cron demonstrably runs.
```

### `src/ops/cf-oauth.ts`

#### Module overview

Attached to: the module overview (`@module`).

Cloudflare OAuth 2.0, so an operator can grant drupflare access without pasting a long-lived token.

Self-managed OAuth clients shipped 2026-06-03. Before that the only option was an API token, which
is why the paste path exists and stays: this is an ADDITIONAL way in, never a replacement.

##### The flow, and why it is the only one available

Cloudflare supports **Authorization Code only** for third-party clients -- no Client Credentials,
Implicit, Device Authorization or ROPC. Of the two variants, drupflare must use **PKCE with S256**
rather than a client secret: the bundle is open source and self-hosted, so a secret compiled into
it is a secret published to everyone who deploys it. PKCE needs no secret, which is exactly the
property a distributed application needs.

##### Why the operator registers their own client

A redirect URI is registered against the client, and every drupflare deployment answers on a
different origin -- `<name>.<subdomain>.workers.dev`, or a custom domain. One shared client cannot
enumerate them in advance. Cloudflare's docs do not state whether redirect matching permits a
wildcard, and the OAuth 2.0 Security BCP says it must not, so this is built to not depend on the
answer: the operator creates a PRIVATE client on their own account, registers their own
deployment's callback, and pastes the `client_id`. Private visibility is enough because they are a
member of the account they are authorising -- the DNS-verified `public` visibility that a shared
client would need is permanent and irreversible, and buys nothing here.

##### Why the client id is NOT on the KV allow-list

It looks like it belongs there -- it is not a credential, and an operator should be able to set it
without a redeploy. It fails the allow-list's actual test, which is that every entry's worst case
is a slow site. KV is operator-writable, and a writer who could set the client id could point the
consent screen at an application they control: the operator would then read that app's name and
logo on Cloudflare's own consent page and approve it. That is a phishing surface, not a slow site.

So it is stored in the object's own `cfw_meta` and set through the owner-authenticated setup
route, which gives the same no-redeploy property behind a credential the operator holds.
`tests/unit/ops/cf-oauth.spec.ts` asserts it stays off `KV_OVERRIDABLE`.

#### `CF_SCOPES`

Scope names are the API-token permission names in `<name>:<read|write>` form. This list is the
least that makes the mail path work: `user:read` identifies the account so the operator does not
have to paste an account id alongside, and the two email scopes are what
`POST /accounts/:id/email/sending/send` requires.

`workers-platform:write` is ABSENT. drupflare is already deployed by the time a
human sees the setup page, so a token that could rewrite the Worker buys nothing and would make a
stolen token a remote-code-execution rather than a mail problem.

### `src/ops/core-version.ts`

#### Module overview

Invalidates the cache rows that embed the Drupal core version, when that version changes.

Two rows in the shipped database hard-code the core version as the `?v=` cache-buster on every asset
URL, and both are permanent (`expire = -1`), so nothing evicts them:

| table             | cid                    | version occurrences |
| ----------------- | ---------------------- | ------------------- |
| `cache_discovery` | `library_info:<theme>` | 298                 |
| `cache_data`      | `fonts:<theme>:<hash>` | 4                   |

Measured 2026-08-21 while rehearsing an 11.4.4 -> 11.4.5 upgrade. `core/misc/ajax.js` and
`core/misc/details.js` both changed in that diff, so an upgraded site serves new JavaScript at a URL
still advertising the old version -- and a browser holding the old copy has no reason to refetch.

##### Why this is not solved by shipping the rows empty

Deleting them from the pack would make EVERY site rebuild 89 KB of library discovery on its first
render: a permanent cost on every deployment, to fix something that only occurs on an upgrade.
Comparing versions costs one `cfw_meta` read once per object lifetime and pays the rebuild exactly
when it is needed.

##### Why the row is deleted rather than rewritten

The stored value is a serialized PHP structure with the version threaded through hundreds of asset
paths. Rewriting it means parsing and re-emitting Drupal's own serialization from JavaScript, which
would be a second implementation of a format only Drupal owns. A delete makes Drupal rebuild it
correctly on the next request, which is what its cache API is for.

#### `needsInvalidation`

A MISSING stored version is NOT an upgrade. Every database built before this existed has no key, and
treating that as a change would make every site rebuild its library cache once on the deploy that
introduced this. The first read records the shipped version and invalidates nothing.

### `src/ops/crossings.ts`

#### Module overview

WHY IT EXISTS: the docs say an RPC method call on a Durable Object stub is its own RPC session
and is BILLED AS A DO REQUEST. This project reaches the object through `stub.fetch()`, so one
request is one billed request today -- but the PHP-to-host bridge INSIDE the object is a
different surface, and nobody had counted it. That number has to exist before any RPC migration,
or the migration silently converts a free inner call into a charged request.

WHAT A CROSSING IS AND IS NOT. A `cfw*` call is a wasm import resolving to a JavaScript function
in the same isolate. It costs CPU and it is NOT a DO request. So this instrument prices a
REFACTOR RISK, not a live meter, and anything it reports should be read that way until a build
actually moves a capability onto RPC.

#### `rpcMigrationCost()`

What an RPC migration would cost, in DO requests per fill. **MEASURED ON A DEPLOYED WORKER.**

This was asserted, then withdrawn as an unestablished inference, then settled properly. The
experiment: a throwaway worker with a Durable Object exposing an RPC method, a `fetch()`, and a
loop that does the same work INSIDE one invocation. Each arm driven a distinct number of times
against a fresh object, then read from `durableObjectsInvocationsAdaptiveGroups`, which is the
billing-facing dataset:

| arm                                  | driven | requests billed |
| ------------------------------------ | -----: | --------------: |
| `stub.ping()`, an RPC method         |      7 |           **7** |
| `stub.fetch()`                       |     11 |          **11** |
| N loops inside ONE invocation        |     13 |           **1** |

Confirmed at n=25 on a first run, where both boundary arms billed 25.

**The third row is the one that matters and it is why today's bridge is free.** `Host::call()` is
a wasm import resolving to JavaScript inside the already-running object, on the far side of a
boundary the `stub.fetch()` already crossed -- the same shape as the `inner` arm, which billed
one request for thirteen operations. The first row is why the guard is real: a crossing
re-expressed as an RPC method on a stub would be billed one-for-one.

#### `CrossingTally.calls`

Off by default and not a route: a cold fill crosses 233 times and each record decodes both sides
of the payload, so leaving it on would put a diagnostic's allocation on every render.
`tests/integration/statement-census.spec.ts` is what arms it.

### `src/ops/deferred-post.ts`

#### `deferredKey`

**IT IS NOT A HASH.** The obvious design is
`hash(method + url + body)`, and both available hashes are wrong here:

  - A NON-CRYPTOGRAPHIC hash (FNV-1a, djb2) is forgeable. This key decides which cached response
    a verification reads, so an attacker who can craft a body that collides with a known-good
    verification gets that success served to their own submission. A captcha bypass through a
    hash collision is a worse bug than the one the tier exists to fix.
  - A CRYPTOGRAPHIC hash cannot be computed here. `crypto.subtle.digest` is async, and this key
    has to be derived inside the synchronous `cfwQueueFetch` and `cfwHttpCacheGet` calls that PHP
    makes. Shipping a synchronous SHA-256 to avoid that is a lot of code to reintroduce a
    collision domain that does not have to exist.

So the key is the exact tuple, LENGTH-PREFIXED. Collisions are impossible by construction rather
than improbable, the derivation is trivially synchronous, and the cost is index size -- bounded by
`MAX_DEFERRED_BODY`.

**The length prefix is the security property, and a separator is not good enough.** The first
version joined the fields with a NUL, reasoning that a NUL cannot appear in a method or a URL. It
can appear in a BODY, and a body is attacker-controlled: two different (url, body) pairs can be
made to serialise identically by moving the separator between them. That is the
forgeable-collision hole this function exists to close, reintroduced by its own encoding, and the
spec case named for it is what caught it.

Length prefixes make the encoding injective for ANY field contents, because nothing has to guess
where a field ends.

#### `CRON_FETCH_TTL_MS`

One hour was doing two jobs at once -- a garbage-collection bound AND a freshness contract -- and
only the first is what it was chosen for. The consumers here are all `hook_cron`, and the observed
cron period is hours rather than the configured 15 minutes, so at one hour the entry is expired at
the exact moment anything asks: fetch, defer, throw, drain, expire, repeat. Measured gaps between
`announcements_feed` rounds were 8,142 to 26,033 s, every one past the TTL.

A day is chosen from the consumer rather than from the endpoint: `update` stores its own release
data for 24 hours, so a fetch entry that outlives that is never the binding constraint.

#### `NOT_KEYED`

Under-keying is a DISCLOSURE -- serve one caller's authenticated response to another -- while
over-keying only costs a fetch, so anything credential-bearing or representation-selecting stays in:
`authorization`, `cookie`, `accept`, `accept-language` and every header this runtime has never heard of.
A server that varies its body on `User-Agent` would be served the wrong variant here. The correct fix
is `Vary` from the response, which needs a variant table rather than a longer deny-list; nothing has
measured it as a real cost, so it is not built.

#### `ResubmitPlan`

Three honest options for a form POST whose validator needs a deferred verification: (1) reject the
submission (visitor passed the captcha and is told they failed; never), (2) block the render until
the alarm drains (impossible, the run is synchronous), (3) re-submit once automatically (chosen).
The token survives the round trip because the SAME token is re-posted; a shim that minted a new token
on re-submit would miss the cache every time and loop forever.

### `src/ops/fanout.ts`

#### Module overview

How a content change is scheduled, from how many pages it invalidated.

Once the dependency closure of a write is known, the expensive work can happen DURING the editorial
operation rather than on the next visitor. For a CMS that is the right place to spend CPU: the write
already carries an expensive human operation and nobody is waiting on it the way a reader is.

What stops that being unconditional is that the closure is not always small. A node save touches the
node page and the listings that carry it; a config change touches everything. Regenerating both
eagerly turns the second into a stampede that costs more of the daily row budget than the whole day's
traffic. So the fanout picks the policy, and there are exactly three.

#### `ROWS_PER_TAGGED_PAGE`

`ROWS_PER_FILL.realRender`, copied rather than imported: the measured table lives in
`scripts/measure/free-envelope.ts` and a CLI script has no business in the Worker bundle. Pinned against
the original in `tests/unit/ops/fanout.spec.ts`, the same arrangement `auth-budget.ts` uses for the two
constants it copies. It describes `MEMORY_CACHE_BINS=none`; with the shipping default a tagged page is
2, and the constant tracks `ROWS_PER_FILL.realRender` deliberately rather than leading it.

#### `ROWS_PER_UNTAGGED_PAGE`

`ROWS_PER_FILL.warmReassemble`. A `cachetags` bump leaves `dynamic_page_cache` alone except for
tag-matched entries, so a page re-queued by a wholesale purge re-renders from a warm bin: it stores its
row and writes nothing else. 2, priced on the front page: `/user/login` reassembles in one row and `/`
in two, and the class takes the dearer path so it cannot undercut a real fill.

#### FANOUT_SMALL_ROWS / FANOUT_MEDIUM_ROWS

Fanout was a page count and a page is not a fixed cost. The two row constants differ by 4.5x, and
across the whole measured table a fill is 2 to 91 rows -- so 8 pages is 16 rows or 728 depending on
what those pages are, and one threshold could not be right for both. Expressed as rows, derived from
the page counts at the tagged cost, so the decision is unchanged for the case the counts were chosen
against and correct for the others.

#### fanoutDecision: the lazy branch

The lazy branch is not a refusal, and `stale` is what makes that true. A page that is not re-queued is
not lost only because it has a previous generation in KV and the stale tier serves it while the
visitor's own arrival queues the regeneration.

That precondition was asserted and not checked. The stale tier is `readStalePage()`, which needs
`PAGE_KV`, and the canonical `wrangler.jsonc` binds no such namespace -- so on the shipping config the
branch degraded every invalidated page to a cold render or a `503 warming` after any change touching
more than FANOUT_MEDIUM pages. With no stale tier the honest answer is one tier down: queue them and
let the ordinary alarm chain drain them.

### `src/ops/fragment-index.ts`

#### Module overview

Which fragment a cache tag reaches, and whether a fragment has changed at all.

The `tag -> paths` index answers "which stored pages does this save invalidate". One level down
sits the question it cannot: most of a page is unchanged by most saves, and on an authenticated
render Drupal has already drawn the boundary -- every auto-placeholdered region is a BigPipe hole
with its OWN cacheability, and `Renderer::renderPlaceholder()` keeps that metadata out of the
response's.

MEASURED ON THE SHIPPING PACK, which is what makes the split worth indexing. An anonymous render
of `/` carries 10 cache tags and zero holes; the authenticated harvest of the same path carries
**6** tags and 6 holes, and `local_task`, `config:system.menu.main` and `config:system.menu.account`
appear only on the fragments. So a menu-item save invalidates every anonymous page on the site and
touches no stored shell at all -- and today it drops every shell anyway, because
`bumpGeneration()` has nothing finer to consult.

##### The anonymous page tier has no seam, and that is structural

`cfw_page` stores cookieless GETs, and BigPipe only placeholders a request that has a session:
measured again here, a stored `/` row carries **zero** `data-big-pipe-placeholder-id` spans. There
is nothing on an anonymous page to address, so this indexes the SHELL tier, which has the holes.

##### Nothing here stores a fragment's bytes

A fragment is personalised by construction -- that is what a hole is for -- so a content-addressed
blob of one would be a store of one visitor's markup addressable by another, which is the
disclosure this project has already shipped once. The row carries the ADDRESS and the tag list,
never the markup, so the index has no reader to leak to.

##### What the address costs, and why the generation is in it anyway

The address is `sha256(plan + dependency values + generation)`, and an index pass whose address
matches the stored one writes NOTHING. The generation moves on every save, so a save does
re-address every fragment -- but re-indexing only happens at a HARVEST, and a harvest only happens
when a shell was dropped. What the check removes is the repeat: `verifyShellFor()` re-harvests once
per new `(path, role, uid)`, so a site with 50 editors re-indexes the same six fragments 50 times
per path. At one row each that is 300 rows for one page; with the address it is 6.

#### `shellVerdict`

REFUSES ON AN UNKNOWN, which is a narrower rule than the one this shipped with. An unrecorded tag
set still drops: a shell stored before the column existed cannot speak for itself, and that is a
genuine unknown rather than a judgement.

**A TAG ON NEITHER THE SHELL NOR A FRAGMENT NO LONGER DROPS, and the old rule made the whole
scoped purge inert.** `shellTags` is Drupal's own `cacheTags` for the shell render, taken from the
response's cacheability metadata rather than derived here -- the same set Drupal uses to decide
whether its own `dynamic_page_cache` entry for that response is still valid. A tag outside it
cannot invalidate that response by Drupal's rules, so dropping on one was stricter than Drupal
itself.

Measured with the old rule wired, on a fresh site: creating two users invalidates `user_list`, the
front page's shell records six tags and none of them is `user_list`, and the shell was dropped
with `user_list is not accounted for on this page`. Every save carries at least one tag no other
page depends on, so the scoped purge behaved like the wholesale purge it replaces.

A tag that belongs only to a FRAGMENT does not drop either. The fragment is not stored --
`assembleFor()` renders every hole on every request -- so the invalidation reaches it through
Drupal's own render cache on the next request, and the shell around it is unaffected.

#### `tagChecksum`

`DatabaseCacheTagsChecksum` decides a cache entry is valid by comparing the checksum it stored
against this same sum, so a page whose sum has not moved cannot have been invalidated. Stored on
the page row at fill time and compared at serve time, it replaces a WRITE per affected page with
a READ per served page -- and the free plan allows 5,000,000 rows read a day against 100,000
written.

### `src/ops/image-transform.ts`

#### Module overview

Image derivatives, produced in the front worker rather than bought from a delivery product.

##### Why the toolkit exists at all

gd is not compiled in: it measured 684,821 bytes against a 3 MB gzipped bundle ceiling. So a
Drupal image style cannot be applied in PHP here, and something else has to apply it.

##### Why not Cloudflare Images

`FREE_QUOTAS.imageTransformsPerMonth` is 5,000 and it is a CAP rather than a bill: the shipped
standard profile has four image styles, so that is 1,250 images a month before a site stops
generating derivatives at all. It also needs a zone with transformations enabled and does not
exist on `*.workers.dev`, and both mechanisms have to FETCH the source, which no session travels
with -- so a `private://` derivative was never reachable through either. It stays available
behind a var for a zone that wants AVIF, which is the one format the wasm arm does not encode.

##### The identity

`sha256(original + normalised style)`, so a style change mints a new identity and derivatives
already published stay addressable. The normalisation is what makes that true: two spellings of
the same transform have to produce one identity or the cache never hits.

> **Superseded:** the 3 MB gzipped bundle ceiling was removed on 2026-09-04, the identity is FNV-1a in `transformIdentity()` rather than sha256, and tinyimg 1.1 encodes AVIF, see `supportedExtensions()`.

#### `readImageRequest()`

Reads the request into one shape.

BOTH SHAPES, and that is the bug this function was written for. PHP sends `{uri, transform}` and
the host read `req.url ?? req.path` with `req.width`/`req.height`, so `cfwImageUrl` returned null
on every call -- and both lanes passed, because neither put the two halves together.

#### `INLINE_TRANSFORM_MAX_EDGE`

The longest edge above which a derivative belongs on the fill queue rather than in a request.

MEASURED ON A DEPLOYED FREE WORKER, `cpuTime` amortised over ten transforms per invocation,
median of twelve invocations, with a source-only control reading 0: thumbnail 36.3 ms at 100px,
medium 48.6 at 220, large 63.5 at 480, wide 188.2 at 1090. The laptop wall-clock figures the arm
was scoped on -- 3 / 7 / 22 / 32 -- understate the edge by 6 to 12x, which is why 320 was the
wrong number: it put `large` on the queue at 63 ms and left nothing but the two cheapest styles
inline.

480 IS THE MEASURED KNEE. Below it a derivative costs 36-64 ms, which a visitor can wait for
once; above it 188 ms, which is the cost the alarm chain exists to absorb.

#### `supportedExtensions()`

The formats the toolkit may claim.

AVIF IS THE WHOLE REASON THIS IS A FUNCTION. All four shipped styles are `image_scale` +
`image_convert_avif`, and `AvifImageEffect::applyEffect()` calls `isAvifSupported()` first and
falls through to its parent when the toolkit says no -- and the shipped fallback extension is
`webp`, which the wasm arm encodes. So core degrades on its own with no config change, PROVIDED
the toolkit tells the truth. Claiming `avif` while the engine cannot produce it makes the effect
call `convert('avif')`, get FALSE, and log a failed derivative instead of falling back.

IT TOOK THE ENGINE NAME AND NOTHING ELSE UNTIL TINYIMG 1.1, and that hardcoded the wasm arm's
capability at the value it had when this was written. 1.1 encodes AVIF, so the refusal above
expired and every one of those four styles was still quietly degrading to webp. `features` comes
from the module itself (`TinyImgModule.features`), so the answer cannot go stale again -- pass it
from `image-runtime.ts`, which is the only file that holds the module.

@param features - what the loaded engine reports it can encode; the pre-1.1 set when omitted.

### `src/ops/mail-onboard.ts`

#### Module overview

Onboards a sending domain, which is the whole gap between "mail refuses" and "mail works".

`src/ops/mail.ts` picks a transport; every transport then fails the same way if the domain was
never onboarded with Cloudflare. That is a DNS and account-state problem rather than a code one,
and it is the last manual step in a one-click setup.

##### What is automatable, measured against the live API rather than the docs

A sending subdomain is **zone-scoped**: `/zones/{zone}/email/sending/subdomains`. The
account-scoped path answers `Unable to authenticate request`, so a design that reached for
`/accounts/{id}/...` would fail with an error that reads like a bad token.

Its records are six: three MX on the return-path host, an SPF TXT beside them, a DKIM TXT at
`<selector>._domainkey`, and a DMARC TXT on the apex. `dnsPlan()` diffs them against the zone.

##### The one step that stays manual, and why that is fine

A destination address is verified by clicking a link Cloudflare emails. That cannot be automated
and should not be: it is the proof that whoever is configuring the site controls the inbox.
Drupal's own email flow already expects click-to-verify, so it fits the model rather than
fighting it.

**It can be POLLED, which was an open question and is now answered.** A destination address
carries both `status: "verified" | "unverified"` and a `verified` timestamp that is null until it
happens -- read off the live account. So the setup page waits and lights up on its own instead of
telling the operator to come back.

##### Permission

This needs **zone DNS write**, far broader than anything else drupflare asks for. It is opt-in and
never required by a site that only serves pages, which is why it is a separate surface rather than
part of the first-run claim.

#### `senderDomainVerdict`

A MISMATCH RESTRICTS DELIVERY RATHER THAN FAILING, which is why nothing noticed. Cloudflare will
accept a send from a domain it has no SPF or DKIM for and then deliver it only to verified
destination addresses -- so registration mail to a real visitor is accepted by the API and never
arrives, and the site's own status says the transport is configured.

#### `TokenGrants`

A SHORT PERMISSION USED TO SURFACE AS THE WRONG STAGE. `listDestinations()` failing was swallowed
-- `dests?.ok ? ... : undefined` -- so a token with no Email Routing read produced an undefined
destination, which reads exactly like an unverified one, and the flow told the operator to click
a link Cloudflare had never sent. The stage has to be able to say "this token cannot see".

#### `onboardState`

DNS propagation runs to 24 hours, and a flow that answers "failed" during a normal wait is a flow
an operator will run again and again. `settled` is the only true/false here, and it means
"re-running changes nothing" rather than "finished" -- `awaiting-verification` is settled and
not finished.

#### `dnsPlan`

An existing record whose content DIFFERS is an update rather than a second create. Creating a
second SPF TXT on one name is not a duplicate that gets ignored; it is two SPF records, which is a
permerror under RFC 7208 and fails mail delivery for the whole domain.

### `src/ops/module-rev.ts`

#### `dropRevision()`

Deletes a revision and the blobs no surviving manifest still names.

The refcount is computed from every REMAINING manifest across every package rather than from a
stored counter. A counter is one more thing to keep correct through a rollback, and the manifests
are the truth; the cost is a scan of a table with at most `REVISION_RETENTION` rows per package.

Refuses to drop the ACTIVE revision: that would leave the mounted tree with no record of where it
came from, which is the state this table exists to prevent.

### `src/ops/module-table.ts`

#### `VERIFIED_BEHAVIOURS`

Modules whose BEHAVIOUR the gate has asserted, with what was asserted.

Under `wrangler dev` an enable killed the host process, so no follow-up request could be made and
nothing could be verified. Re-run under `@cloudflare/vitest-pool-workers` that limit does not
exist: an enable survives, a follow-up request answers, and TWO enables in one object survive --
the exact case that killed wrangler dev hardest. The failure was miniflare's proxy controller, a
component that only exists locally, and suspecting the instrument first was right.

What that left was a configuration gap rather than a runtime one, and **the gap was closed by
supplying the configuration rather than by waiting for it.** This block used to record `pathauto`
as inert (no `pathauto.pattern.*` ships, so a node save produces no alias) and `token` as
unverifiable for the same reason. A pattern is a config entity a SITE OWNER creates, so the test
creates one; both are now verified against an alias the run generated.

The distinction worth keeping: absent CONFIGURATION is a fixture gap a test can fill, absent CODE
is not. Twelve rows here are in the second class -- see {@link SHIPPING_PACK_CONTRIB}.

#### `SupportState`

It claimed the spec "fails when README.md disagrees"; the spec compared this map against the SPEC
FILES, so a `verified` row needed a run behind it and the published table needed nothing. Three
rows were edited by hand on the strength of the guard described here. The comparison exists now.

### `src/ops/package-install.ts`

#### Module overview

Resolving a package name to source, and turning that source into files the mount can serve.

##### One pipeline, three callers

`composer require`, a git-delivered custom module and `npm install` all want the same
four steps: resolve a name to an archive URL, fetch it, filter what comes out, and write the files
where the boot mount reads them. Building three of those would produce three sets of bugs, so this
is the one, and the SOURCE is the only thing that differs.

##### Why the host does this and not PHP

PHP here cannot block on a socket, so a composer-shaped resolve-then-download is impossible inside
one render. It is also unnecessary: the archive is an ordinary HTTPS GET, which the Worker does
natively. The terminal parses intent in PHP and hands it over.

##### The two repositories, which are not interchangeable

Drupal modules are NOT on packagist. `repo.packagist.org/p2/drupal/token.json` answers
"404 not found, no packages here"; the metadata lives on `packages.drupal.org`, which is the
composer repository every Drupal site already has in its `composer.json`. Everything else resolves
against packagist. Sending a `drupal/*` name to packagist is a silent "package does not exist",
which reads as a typo.

> **Superseded:** PHP can block on a socket since the Zend park shipped, so that reason no longer holds.

#### `pickVersion()`

Picks a version from a composer `p2` document.

NEWEST STABLE unless a constraint names otherwise, and stable means no `-dev`, `-alpha`, `-beta`
or `-RC` suffix. Both repositories list newest first, so this takes the first match rather than
sorting -- a real version sort is `composer/semver`'s job and importing that reasoning here would
be a second, worse copy of it.

The constraint match is EXACT-OR-PREFIX rather than a range solver. A caret range
needs a real semver implementation, and answering one wrongly would install a version the site
cannot run. An unmatched constraint returns undefined, which the caller reports.

> **Superseded:** ranges resolve through `satisfies()` in `composer-constraint.ts` now, so the exact-or-prefix paragraph no longer describes the code.

#### `portFibers()`

Points a delivered PHP file's Fibers at the runtime's synchronous shim.

This interpreter has no Fiber backend, so the first `Fiber::start()` aborts the whole runtime
(`missing function: getcontext`). `scripts/patch-drupal.mjs` rewrites core's five sites at pack
time; a package installed later was never rewritten, and Varbase's `revolt/event-loop` aborted
every page. Qualified references become `\PhpWasmSyncFiber`, and `use Fiber;` becomes an alias
so unqualified ones follow. Code that needs a real suspension now fails as an ordinary error.

### `src/ops/packagist.ts`

#### `DRUPAL_METADATA_URL`

Routed by vendor, and getting this wrong made the whole check answer `not-found` for the entire
Drupal ecosystem. Drupal contrib is NOT on Packagist -- it is published to drupal.org's own
Composer repository, which core's own `composer.json` adds as a second repository. Measured:

  repo.packagist.org/p2/drupal/pathauto.json ................ 404
  packages.drupal.org/8/p2/drupal/pathauto.json ............. 302 -> www.drupal.org, then 404
  packages.drupal.org/files/packages/8/p2/drupal/pathauto.json  200 (the metadata)
  repo.packagist.org/p2/symfony/yaml.json ................... 200

So every `/installable?module=drupal/*` returned `not-found` with the plumbing working perfectly.
`drupal/core*` is the exception inside the exception: core and its subtree packages ARE mirrored
to Packagist, but drupal.org serves them too, so routing the whole `drupal/` vendor there is both
correct and simpler than special-casing.

#### `PLATFORM_PHP_VERSION`

Was 8.3.0 while the shipping binary is 8.5 (`wrangler.jsonc` aliases `php-binary-raw.ts`; a deployed
site reports `8.5.2` from `/php`), so anything requiring `>=8.4` was refused as unsatisfiable by a
platform that satisfies it, silently.

#### `NATIVE_PLATFORM`

Function-name evidence cannot replace the loaded-extensions spec. `curl_init`, `mysqli_stmt_init` and
`imagecreatetruecolor` all appear as strings in a binary that has none of those extensions, because
opcache's optimizer carries a `func_info` table naming functions across every bundled extension.
`ext-mbstring` was listed while `mb-fix.ts` existed because the build had no mbstring; it moved
here on 2026-09-08 when the long64 build carried the real extension (`--enable-mbstring
--disable-mbregex`; `mb_ereg*` still absent, needs oniguruma, core calls none of it).

### `src/ops/page-memo.ts`

#### Module overview

Anonymous pages held in the isolate that is already answering the request.

##### Why this tier exists

`anon-cached` is 0.82 of the traffic weight and is answered by `caches.default`, which is the cheapest
tier that leaves the isolate and is still an I/O. Measured on a deployed free worker, 2026-09-10: the
whole request costs 0.70 ms of `cpuTime` at p50 and 7.9-14.0 ms of `x-worker-ms`, so an order of
magnitude of the profile that decides the verdict is spent waiting for a read whose answer this isolate
has usually just seen. Against a localhost nginx serving the same page in 2-3 ms, that read is the
entire gap. The authenticated side already has this: `lookupEdgePlan` answers from isolate memory and
reports `mem`. The anonymous side had no equivalent and is 27x the weight.

##### Why serving one is safe

The key is `pageKey()`, unchanged -- origin, site, GENERATION and path. So this adds no staleness that
the tier below it does not already have: a bump moves the generation, a new generation is a new key,
and an isolate learns the generation from `genMemo` within `GEN_BUCKET_MS`. An entry for a superseded
generation is unreachable rather than stale, exactly as it is in `caches.default`.

What it must never hold is a personalised page, and it cannot: the only caller is the branch guarded
by `edgeWanted`, which is false for a session-carrying request, and the value stored is a body
`caches.default` had already accepted -- so `putPage()`'s refusals have run.

##### What bounds it

Bytes and entries, with a clear rather than an LRU for the reason `genMemo` and the plan store use one:
the working set is bounded by the traffic one isolate sees, and eviction accounting costs more than a
refill. The TTL mirrors the `max-age` the edge entry carries, so nothing outlives the copy it was
taken from.

#### `Entry`

The hit path did the header assembly, and it is the path that runs on every request: it spread
`Object.fromEntries(held.headers)` into a fresh literal and then set five more keys, so a tier whose
whole purpose is "no I/O at all" was materialising an array into an object and copying it on every
hit. Built once at store time instead. A `Headers` instance because `new Response` accepts it directly
and the caller must not be able to mutate what the memo holds (it is handed a clone).

### `src/ops/park.ts`

#### `PARK_TRAPS`

```
/**
 * The trap classes a site may arm.
 *
 * TWO, and the one that is NOT here is worth recording. An `http` class trapping `curl_exec` was
 * written and removed: **the shipping interpreter has no curl at all**, measured 2026-09-08 by
 * booting it and reading the extension list, so `cfw_park_trap('curl_exec')` answers false. The
 * earlier "Guzzle parks at `curl_exec`" reading came from a NATIVE php that has ext-curl, which is
 * the wrong instrument. `curl_exec` also takes a `CurlHandle` rather than a URL, so its pending
 * descriptor would carry an object the host cannot route on.
 *
 * Trapping `fopen` instead cannot work either, and the reason is the safety predicate rather than an
 * omission: `HttpsStreamWrapper` is userland called from the INTERNAL `fopen`, so `park_refused()`
 * counts that frame and declines -- correctly, since `fopen`'s C locals cannot survive the
 * `longjmp`. So the `fetch` class does not trap Guzzle's transport at all. It gives the module's own
 * handler a yield point, and that handler is plain userland, which is what makes the park safe
 * there.
 */
```

### `src/ops/plan-profile.ts`

#### Module overview

Before this, `PLAN=paid` reached exactly two decisions -- the migration slicer
(`chunksPerInvocation`) and the prefill default -- while five others were flat constants chosen
for a 10 ms cap. So a paid site paid for headroom and then behaved like a free one: batches of
five, a 2 s inline budget, and a 503 to the first visitor of every cold URL.

WHAT PAID ACTUALLY BUYS is a bigger per-invocation CPU budget (30 s against 10 ms) and a longer
wall clock, so every knob here is either "how much work fits in one invocation" or "how long a
visitor may wait". Nothing here touches the meters that bind the FREE ceiling -- rows written and
request counts are the same on both plans, and a paid profile that wrote more rows per fill would
be spending the wrong resource.

THE ONE THAT MATTERS is {@link PlanProfile.bootInline}. A cold object refuses to render inline
because `!this.php`, never because of a budget -- raising `RENDER_BUDGET_MS` from 2,000 to 25,000
did not move it, because the estimate is only consulted once an interpreter exists. So on free the
first visitor to a cold URL gets a 503 no matter what the budget says, and the fix is not a bigger
number but permission to boot. That boot is ~1.4 s, which is why it stays off on free.

#### `FREE_PROFILE`

**`bootInline` WAS FALSE AND THE REASON EXPIRED.** It was set against a 10 ms per-invocation cap
that a cold boot obviously cannot fit, and against an implicit alternative of "the chain fills it
shortly". Both halves are now measured and both are wrong:

- **The cap does not fail an object invocation.** A single invocation reading 1,882 ms of
  `cpuTime` completed on a deployed FREE worker, and a boot runs in the object. (A Worker handler
  running ~1.6 s burns back to back was cut to 10 ms, which is why this is scoped to the object.)
- **The alternative is not a short wait.** Time-to-served for an anonymous miss on a cold object,
  deployed: **19,004 ms, and only 4 of 8 paths served at all.** A cold boot plus render is ~3.8 s.
  Refusing to boot does not save the visitor anything; it costs them 15 seconds and often the
  page.

So the refusal was comparing a cold boot against a fast chain that does not exist. `inlineBudgetMs`
moves with it for the same reason -- it bounds the VISITOR'S PATIENCE rather than a billed
resource (wall time is not charged against the CPU budget: 4 ms of Worker CPU against 827 ms of
wall, measured), and 2 s of patience is the wrong bound when the alternative is 19 s of waiting.

What still protects the object: `estimateRenderMs()` against this budget, the herd collapse (N
concurrent identical misses cost ONE render), the daily row and request meters, and
`degraded.render` which answers 503 rather than rendering once the quota is spent. Cold encounters
are **0.13% of all visitor requests**, so this path is rare by construction.

#### `PAID_PROFILE`

THE BATCH IS SMALL, and the first version of this file got it wrong. A Durable Object
is single-threaded and `php._run()` is synchronous, so a fill occupies the object for its whole
duration and a queued cache HIT cannot be answered by EITHER lane while it runs. Measured on a
deployed worker at `fillBatchSize: 25`: alarms cost 4,337-5,832 ms of cpuTime (n=6) and every
`/__serve` racing them waited 5.0-6.8 s of wall (n=5). Nothing bounded it: a wall-clock guard
cannot, because the clock does not advance across a synchronous `php._run()`. It simply made paid
visitors wait seconds on an object that was filling.

Throughput does not pay for that, because the alarm RE-ARMS IMMEDIATELY while the queue is
non-empty: measured, consecutive firings 130-160 ms apart. So on paid, where DO requests are not
the binding meter, many short alarms deliver the same fills per second as one long one and bound
the worst HIT wait instead. At a measured 81 ms median per warm render (n=7, 67-107, uncontended),
8 fills is roughly 650 ms of occupancy against 4.5 s.

Subrequests are the reason the drain limits stay small-ish: an invocation gets 1,000 on paid
against 50 on free, but a fill in the same firing has already spent several, and each mirror put
carries a whole file through memory.

**BATCHING DOES AMORTISE REAL COST, AND THAT IS NOT WHAT BOUNDS THIS NUMBER.** Measured
2026-09-14 on a deployed free worker, n=5 per k, interleaved, every batch verified to drain
exactly k in one invocation: per-page wall falls 109 ms at k=1 to 82 at k=5, 50 at k=10 and
**42.9 at k=20**, a 2.54x saving with the curve still descending. Round-trip wall rather than
`cpuTime`, because the tag rides the front-worker request and the observability record is the
OBJECT's invocation, which carries no query -- the network term is near constant across the four
arms, so the relation holds even though the absolutes carry it.

It does not move either number above, and saying why is the point of recording it. That run drove
an otherwise idle object, so it measured THROUGHPUT and the two constraints here are HIT LATENCY
during a fill and the 128 MiB isolate -- a fill batch is N workloads inside ONE invocation, which
is what reset four freshly provisioned sites at 25. A throughput figure cannot overrule a latency
or a memory bound. What it does establish is that the cost is genuinely amortisable, so a future
topology where a fill does not occupy the serving object has a measured reason to revisit this.

### `src/ops/plan.ts`

#### `siteScopedKey()`

```
 * **BOTH DOCUMENTS WERE DEPLOYMENT-WIDE.** `plan` and `settings` were literal keys, so the owner of
 * ONE site could write levers every other site on the deployment reads -- and once the Drupal
 * settings form landed, so could a site administrator holding `administer drupflare settings`, who
 * is a tenancy level below even that. `KV_OVERRIDABLE`'s safety argument is "the worst case is a
 * slow site", which is an argument about the writer's OWN site; applied across tenants it does not
 * hold, and `PLAN` selects an account-wide limits profile on top.
 *
 * The global key is still READ, as the deployment-wide default, so an operator can set a fleet-wide
 * value in the dashboard and an existing deployment keeps the values it already has. A per-site
 * document overlays it. Writes only ever land on the per-site key.
```

#### `KV_OVERRIDABLE`

```
 * AN ALLOW-LIST, AND THIS IS A PRIVILEGE BOUNDARY RATHER THAN TIDINESS. KV is operator-writable, so
 * merging an arbitrary object into the environment would let anyone with KV write set
 * `PW_DIAGNOSTICS=1` -- which reaches `/sql` (arbitrary SQL against the site database) and
 * `/restore` (a whole-database overwrite). Every name here is a performance lever whose worst case
 * is a slow site; nothing here changes what is reachable.
 *
 * THE MAIL CREDENTIALS ARE ABSENT FOR THE SAME REASON `PW_DIAGNOSTICS` IS. `MAIL_TRANSPORT` and
 * `MAIL_DRAIN_LIMIT` are here because their worst case is "no mail" or "slower mail", and both only
 * choose between transports the DEPLOYER already configured. `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`,
 * `CF_EMAIL_TOKEN`, `CF_EMAIL_ACCOUNT_ID` and `MAIL_FROM` must never join them: a KV writer who could
 * set `SMTP_HOST` would receive every password-reset link the site sends, which is a reach rather
 * than a slow site.
```

Inline entries (originals):

```
// the baked asset aggregates. It met this list's own test and was left off it, so `assets/agg/`
// shipped built and there was no way to turn it on without a redeploy -- an oversight rather
// than a decision. A wrong value is a fatter or slower page, never a changed reachability
// ---
// how often a warmed site fires, which is the warming cost curve: 8 s holds the object resident
// on every request, and longer intervals trade firings for a chance of adopting the interpreter.
// Worst case is a cold boot or a costlier site, never a changed reachability
```

#### `writeSettings()`

```
 * **THE FILTER IS ENFORCED HERE AND NOT ONLY IN {@link resolveSettings}, and that is a privilege
 * boundary rather than belt-and-braces.** A reader-side filter makes an unlisted name inert; a
 * writer-side filter makes it unstorable. Those differ the moment anything else grows a reader --
 * a future surface reading the raw document would see whatever the last writer put there, and
 * `KV_OVERRIDABLE`'s docblock explains what a `PW_DIAGNOSTICS` in that document would reach.
```

#### `withSettings()`

```
 * TWO CALLERS, and there have to be two. This one runs in `src/site.ts` against the FRONT worker's
 * env, which is where `GEN_BUCKET_MS` and `SITE_LOCATION_HINT` are read. The Durable Object receives
 * its own copy of the bindings and cannot see this, so it overlays its own in `adoptSettings()` --
 * for the whole life of the convention it did not, and the levers read only inside the object
 * were knobs that configured nothing.
```

#### `SETTINGS_KEY`

The KV key holding runtime lever overrides, as one JSON object.

One key rather than one per lever: a single read is atomic, costs one of the 100,000 daily KV
reads instead of one per lever, and gives an operator one place to see every override in
force. Counted nowhere in prose: this docblock said seven while the list held eighteen.

### `src/ops/platform-limits.ts`

#### Module overview

Dynamic Worker concurrency is not among these, and the reason is worth keeping. Cloudflare
raised the number of distinct Dynamic Workers one Durable Object may run concurrently, which would
matter to a design that loaded code per request. This one has no worker-loader binding and no
dispatch namespace, so that limit cannot bind here no matter what the number is. The general
`io-context` class is a different failure and CAN appear: it fires when an I/O object
outlives the request that created it, which a long-lived interpreter holding a socket is exactly
the shape to do.

### `src/ops/render-plan.ts`

#### PlanSlot csrf kind

MEASURED, and it is the whole reason a shared role-set plan could not compile an authenticated
page. Two sessions of one role set rendering `/` differ in exactly this value and nothing else --
103,697 bytes each, one varying token in two places, every `data-contextual-token` identical.
Unlike the other kinds it cannot be generated, only substituted: the value belongs to the visitor
being served, so fillSlots takes it from the caller and refuses without one.

#### `anchorLine`

Uniqueness in BOTH is what makes it an alignment point. Every repeated `</div>` is a candidate
otherwise, and anchoring on one aligns two unrelated positions -- the census that first counted
varying bytes this way reported ~40 KB varying on pages that vary by 43.

#### `splitSpan`

Bracketing between the first and last difference produces ONE region, so a page with two dynamic
values hands the recognisers 4.6 KB of markup with a dom id at one end and a build id at the
other -- opaque, and every form page carrying a view has that shape.

### `src/ops/replica-routing.ts`

#### `affinityKey`

```
/**
 * The stable string a lane is chosen from.
 *
 * Anonymous requests spread by client address, then by path when they carry no address, so they
 * still spread rather than piling onto whichever lane the empty string hashes to.
 *
 * A SESSION-CARRYING REQUEST IS KEYED ON THE PATH, so a page's readers share a lane. Measured over
 * eight paths a run, two fresh sessions each, three lanes and the primary: keyed on the session the
 * plan tier compiled on 5/8 and 4/8 paths, keyed on the path 6/8 -- and the trials that failed under
 * the session key are the ones whose two sessions landed on different objects. It is a rate rather
 * than a rule, because a split pair still compiles sometimes: the compile runs in the FRONT WORKER's
 * isolate, so it sees both renders wherever they came from, and what a split costs it is agreement
 * on the generation the two samples were taken at.
 *
 * The trade is per-page concurrency for authenticated readers, and it is the right way round: the
 * anonymous slice is the bulk of the traffic and keeps spreading by address, while a plan HIT
 * answers without rendering at all, which beats sharing a page's renders across lanes.
 *
 * **AN ANONYMOUS ONE-MACHINE CLIENT CANNOT SPREAD ACROSS A POOL.** It presents one address on every
 * request, so the middle branch here returns one key however many paths it rotates through --
 * measured on a local rig, an anonymous drive reported `x-cfw-replica` as `{r3: 662}`, one object
 * for 100% of samples. Real traffic has the spread for free;
 * `scripts/measure/v101-arms.ts --clients=N` is how a rig gets it.
 *
 * It does NOT explain a pool whose lanes answer nothing, and it was wrongly blamed for one. An
 * AUTHENTICATED drive keys on the path, and the eight paths that rig rotates cover 4 of 4 buckets
 * at 3 lanes and 6 of 8 at 7 -- computed against this file's own FNV-1a, offline, in twenty lines.
 * The cause there was admission: a lane is refused until something mints `state:system.private_key`.
 * Count the distinct objects in `x-cfw-replica` AND check the lanes reached `SERVING` before
 * attributing a pool reading to routing.
 */
```

#### `replicaCount`

```
/**
 * How many replica lanes a site has, beyond the primary; unset, unparseable and negative are 0.
 *
 * **The ceiling is {@link ID_PARTITION_LANES}, and it is a mechanism rather than a taste.** This
 * used to clamp at 32 on the reasoning that a larger pool is "past what the measured curve covers",
 * which is a statement about what had been measured rather than a limit of anything. Removing it
 * outright was worse: a lane mints forwarded ids from its residue class modulo
 * `ID_PARTITION_LANES + 1`, so lane 257 wraps onto lane 0's class -- the PRIMARY's -- and two
 * writers mint the same id. `write-forwarding.spec.ts` is what caught that, by comparing the
 * router's reach against the partition rather than trusting either alone.
 *
 * So the number is bounded by the arithmetic that keeps ids disjoint, and the two are linked here
 * rather than restated. `replica-demand.ts` carries a different and smaller ceiling:
 * `REPLICA_MAX_LANES` bounds what AUTOSCALING creates, where the binding cost is per-lane idle
 * storage and catch-up rather than correctness.
 *
 * What this number does is tell the ROUTER how many buckets to hash over, and setting it above the
 * lanes a site has provisioned routes to objects that do not exist -- each one a wasted hop and a
 * retry on the primary. That is an operator error a ceiling cannot prevent; `chooseTarget()` takes
 * `max(this, believedLanes)` so the provisioned count is the floor either way.
 */
```

#### chooseTarget input.hasSession

```
	/**
	 * Whether the request already carries a session.
	 *
	 * A WRITE THAT CARRIES NO SESSION MAY ESTABLISH ONE, AND A LANE CANNOT. Forwarding executes the
	 * write on the lane, discards its own effect and sends the statements to the primary -- but the
	 * `Set-Cookie` handed back was minted during the lane's speculative run, so the client leaves
	 * holding a session id the primary does not have. Observed over six consecutive logins on a
	 * 4-lane site: five answered by the primary, one by `r3`, and after that one the PRIMARY itself
	 * read `x-cfw-roles: anonymous` on 125 of 200 samples. It presents as "the site stopped
	 * accepting the password".
	 *
	 * Login, registration and password reset are exactly the writes that arrive without a session,
	 * so pinning on this covers the class without naming any route.
	 */
```

### `src/ops/replica.ts`

#### `enforceReadOnly()`, exec write

```
// AN EXEC WRITE IS NOT FORWARDABLE HERE AND THAT IS THE DRIVER'S JOB TO AVOID.
// `cfwSqlExec` has no rollback, so there is no way to run this locally and discard
// it; the driver replays an unbuffered write as a one-statement transaction so it
// arrives on the branch above. Reaching this means the two disagree about whether
// this connection holds a residue class, and a failover is the safe answer
```

#### `statementAllowedOnReplica()`

```
 * THE TWO ALLOW-LISTS HAVE TO MEET HERE, and they did not at first: `isProvenRead()` alone refuses
 * `INSERT INTO cache_render`, which `isReplicaLocalTable()` calls local -- so a replica could not
 * fill its own cache bins and would re-render every request, which is the entire thing it exists to
 * avoid.
```

#### `compound()`

```
 * `sql.exec()` runs every statement in the string it is handed, and every classifier below reads the
 * LEADING keyword -- so a compound describes only its first statement. `SELECT 1; DELETE FROM users`
 * is a proven read and `INSERT INTO cache_render (...); DELETE FROM users` attributes to a
 * replica-local table, and both then mutate authoritative state on a lane.
```

#### Module overview

```
 * The bridge surface is the reason this cannot enumerate: `CROSSING_NAMES` in `crossings.ts` is a
 * hand-maintained list whose own docblock says a new capability should show up rather than be
 * "counted by accident", and TWO have been added since without joining it -- `cfwOidcClaims`, which
 * deletes a durable ticket, and `cfwTcp`, which queues an outbound exchange. Both mutate.
```

### `src/ops/replication-log.ts`

#### Module overview

How authoritative state reaches a replica, and why an interrupted delivery cannot be mistaken for
a complete one.

THE INVARIANT IS THAT A REPLICA IS FULLY VALID AT G OR KNOWN TO BE BELOW G, NEVER IN BETWEEN. A
replica that has applied half of a generation is not "slightly stale"; it holds a state the primary
was never in, and no fence expressed in generation numbers can describe it. So every path out of an
interrupted apply lands on a number that is true, or on a refusal.

Two mechanisms carry that, and they cover different failures:

- A record that fits one transaction needs no marker. The apply and the position advance commit
  together, so an interruption rolls both back and the replica is cleanly at the parent. This is
  the common case and it costs nothing.
- A record applied in CHUNKS cannot use that, because the chunks commit separately. An intent
  marker is committed before the first chunk and cleared with the last, so a marker found on
  restart means chunks landed and the position did not. That replica is untrusted until it
  restores; it cannot resume, because nothing records which chunks committed.

The marker is written only when it is load-bearing. Writing it for a single-transaction apply
would charge a row to record something the transaction already guarantees.

#### `LogRecord.overflowed`

Set when the change was too large to log statement by statement.

An overflowed record carries NO statements and cannot be applied; a replica meeting one has to
restore. That is the safe direction: a truncated statement list would
apply cleanly and leave the replica silently wrong, which is the one outcome the whole log
exists to prevent.

#### `LogPosition`

Where a replica is in the log, as durable state.

No schema version here. The object's pack generation is already recorded by the migrate
cursor, and a copy kept alongside the log position would be a second source of truth that can
disagree with the first. The applier is handed the live one.

#### `positionalBindings()`

A statement's bindings as `ctx.storage.sql` can take them: positional, and nothing else.

DRUPAL BINDS BY NAME AND THE LOG CARRIED IT THROUGH. `Connection::merge()` compiles to a SELECT
then an INSERT or an UPDATE, and only the INSERT binds positionally -- the UPDATE branch binds
`{':db_condition_placeholder_0': 'node_list'}`, which is an OBJECT. `SqlStorage.exec()` takes
`...bindings`, so applying one threw `Spread syntax requires ...iterable[Symbol.iterator] to be a
function` and killed the catch-up. Every cache-tag invalidation takes that branch once the row
exists, so any pool broke on the first repeat invalidation of any tag -- a node save.

Rewritten rather than refused, because the statement is legitimate and the primary has already
committed it. Tokens are read from the SQL IN ORDER, so the result does not depend on key order
in the map, and a token with no value throws rather than binding a silent `undefined`: a wrong
value replicated into a replica is worse than a refused record, which the fence can describe.

#### `positionTrust()`

Whether the replica's own position is a number anyone may act on.

A surviving marker is the untrusted case and it is NOT resumable: the marker records which
generation was being built, not which of its chunks committed, so there is no safe point to
continue from. Recording per-chunk progress would make resume possible and is not built, because
the recovery it replaces is a restore the replica can already perform.

#### `markInflight()`

Marks the position untrusted while a multi-transaction load is in flight.

The same marker a chunked apply uses, and for the same reason: a bulk restore commits table by
table, so an interruption leaves rows that landed and a position that did not. Sharing it rather
than adding a second flag means {@link positionTrust} already refuses both, and there is one
answer to "is this replica's number real" instead of two that can disagree.

#### `planApply()`

What to do with a delivered record.

Order matters. A malformed or wrong-schema record is refused before anything looks at generation
numbers, because its numbers are not evidence of anything. Only then does a re-delivery of an
already-applied generation collapse to a no-op.

`duplicate` is a SKIP rather than a re-apply. The statements in a record are not required to be
idempotent -- an `UPDATE ... SET n = n + 1` is a legitimate authoritative write -- so replaying one
at a generation the replica already passed would corrupt exactly the state this exists to carry.

**A GENERATION NUMBER IDENTIFIES A POSITION IN ONE PRIMARY'S HISTORY AND NOTHING MORE.** Nothing
here can tell a record from primary A apart from a record from primary B carrying the same number,
so a replica pointed at a second primary would skip its records as duplicates and diverge in
silence. What catches that is the fingerprint comparison at admission, which checks the RESULT
rather than the sequence -- and it runs at admission only, so divergence that begins after a
replica is already serving is not detected until it is re-admitted. Chaining each record to its
parent's fingerprint would close it inside the log; it is not built, and this is the surviving
objective rather than a settled one.

#### `applyRecord()`

Applies one record, or refuses it.

The statements are the primary's authoritative writes and are NOT passed through the
replica's read-only guard. That guard exists to stop a replica ORIGINATING an authoritative write;
this is the one path by which such a write legitimately arrives, and gating it there would leave a
replica able to receive only the writes it could have made itself.

@param localSchema
  The pack generation this object actually holds, read live rather than kept beside the position.
@param chunkSize
  Statements per transaction. The default applies the whole record in one, which is what makes an
  interruption roll back cleanly. Pass a smaller number only when a record is too large to apply in
  one invocation, and accept that an interruption then costs a restore.

### `src/ops/shell-assembly.ts`

#### Module overview

Fragment assembly: an anonymous shell from cache, personalised holes filled at the edge.

Authenticated HTML is never cached and must not be. What CAN be cached is the part of the page
that is identical for everyone, with the per-user parts left as holes -- which is exactly the
boundary Drupal already draws for BigPipe. `BigPipeStrategy` wraps every auto-placeholdered
element in `<span data-big-pipe-placeholder-id="...">`, so the seams exist in the markup already
and nothing here has to invent them.

##### The dangerous half is deciding WHEN, not doing it

Serving a shell that contains one visitor's content to another is the same defect as the static
-state leaks, arriving through a different door. So {@link shellSafety} refuses by default and
only permits a page it can positively account for: every personalised region must be inside a
placeholder, and anything that looks like identity outside one disqualifies the page.

The refusal is cheap -- the page just renders the way it does today. A wrong permit is a
disclosure. That asymmetry is why every unknown here resolves to `unsafe`.

#### `assemble`

HTMLRewriter is the obvious tool and is the wrong one here. It streams, so it cannot report which
placeholders went unfilled until the body is already on the wire -- and an unfilled hole is the
case that has to be caught BEFORE anything is sent, because it means the shell and the fragment
set disagree. Streaming is worth having later for byte latency; correctness comes first, and a
cached shell is a string already in memory.

AN UNFILLED PLACEHOLDER IS LEFT IN PLACE, never removed. Removing it would silently drop a
region -- a visitor would see a page with their account menu simply absent, and nothing would
report it. Left in place, it is an empty span that BigPipe's own JavaScript can still fill.

#### `normaliseShell`

The safety property is byte equality, not this pattern list. A list of markers is a guess about
what varies, and a guess is not something to build against. The check that actually holds is
differential: normalise the same page rendered for two different members of a role set, and REQUIRE
the results to be byte-identical. Anything that varies by person and is not in the list above makes
them differ, so the harvest refuses instead of storing a shell that leaks. {@link
normalisedShellsAgree} is that check, and the harvest calls it. So this function may be incomplete
without being unsafe. Adding a pattern turns a refusal into a shareable shell; omitting one costs a
shell, never a disclosure.

#### `rolesOf`

A SHELL RESPONSE CARRIED NO ROLES AND THAT STARVED THE COMPILED-PLAN TIER. The edge plan
compiles from three agreeing samples of `x-cfw-roles`, and `roleSeen` in the front worker is
keyed by COOKIE rather than by path -- so one path answered `ASSEMBLED` was enough to make the
whole session read `skip:roles-unknown` and never compile a plan for anything. `ASSEMBLED` still
costs a Durable Object hop and a real fragment render; `PLAN` costs neither, so the cheaper tier
was being locked out by the more expensive one.

The render already computes this, so carrying it out is free. Anything not a list of strings
yields nothing rather than a guess: a partial role set would compile a plan for the wrong
audience, which is strictly worse than compiling none.

### `src/ops/site-id.ts`

#### Module overview

Which site a request belongs to, when the caller did not say.

`/serve?site=X` names the site explicitly and always wins. Everything else -- a visitor asking for
`/about` on a real domain -- has to be resolved, and this is the only place that decides it. One
object per site, and the object's NAME is the site identity, so a wrong answer here is a request
served from a different site's database rather than an error.

The `site` parameter is layer 0 and is REFUSED unless the caller opts in, because the catch-all
resolves a URL whose query string belongs to the visitor. See {@link ResolveSiteOptions}.

Five layers, and the ORDER follows from which of them can be absent:

1. **KV**, keyed by host. Operator-writable at runtime, so two hostnames can share one site and a
   site can be renamed without a redeploy. First because it is the only layer that can be changed
   without shipping anything.
2. **`SITE_ID`**, a var. The per-deployment answer, set at deploy time.
3. **The deployment's primary site** (`src/ops/deployment-site.ts`). One deployment is one site,
   so once a site has been claimed every unmapped host reaches it.
4. **The hostname**, derived, only while nothing has been claimed: a fresh deploy serves the host
   it was pointed at, and that is how its first site is made.
5. **`site`**, the literal `src/site.ts` has always defaulted the `site` param to.

THE OPTIONAL LAYERS COME FIRST BECAUSE THE GUARANTEED ONE WOULD SHADOW THEM. Derivation answers
for every real host, so anything below it is unreachable on exactly the hosts it exists to
configure -- a KV mapping consulted after derivation could never apply to a deployed site, which
is the case it exists for. Ordering the two explicit layers above the inferred one is the
same rule `resolveSiblings()` follows for the sibling checkouts.

Layer 3 is also what makes layers 1 and 2 optional rather than nominally so: a deploy
that sets neither still resolves, and `localhost` -- which names no site -- falls past derivation
to the literal.

#### `locationHint()`

Where a site's Durable Object should be created, or undefined for "wherever it lands".

**UNSET IS THE DEFAULT.** Placement follows the first request, which for a
deploy-button site is wherever the deployer was. Guessing a region on their behalf trades latency
for one audience against latency for every other, and a one-click product has no way to ask - so
an owner who knows their audience pins it, and nobody else pays for a guess.

**KV FIRST, THEN THE VAR**, which is the ladder `resolveSettings()` already implements:
`SITE_LOCATION_HINT` is on {@link KV_OVERRIDABLE}, so it can be changed without a redeploy. That
ordering is the convention for any lever offered here, not a special case for this one.

IT ONLY APPLIES TO CREATION. Cloudflare uses the hint when the object is first instantiated and
ignores it afterwards, so setting this on a site that already exists moves nothing.

#### `encodeSiteId()`

One host, one id, and no two hosts sharing one.

`[^a-z0-9]+` collapsing to a dash made `a.b.example.com` and `a-b.example.com` the same id, and a
site id IS the Durable Object's name -- so two unrelated hostnames pointed at one deployment
shared one database. `.` and `-` are the ordinary furniture of a hostname and are now kept as
themselves; anything else becomes `_<hex>`, which cannot be produced any other way because `_` is
outside the kept set. That makes the mapping injective rather than merely tidier.

Readable in a log, and safe everywhere it is used: a DO name takes any string, and the cache, KV,
and R2 keys that carry it percent-encode their parts.

#### `ResolveSiteOptions.allowParam`

Whether `?site=` on the URL may name the site.

TRUE ONLY WHERE THE QUERY STRING IS OURS. On `/serve` the caller built the URL and the
parameter is an instruction; on a path the catch-all rewrote, the query belongs to Drupal and
came from the visitor -- so honouring it means `https://customer-a.example/about?site=customer-b`
serves customer B's database from customer A's hostname. Rewriting from the ORIGIN keeps the
visitor's parameters out of `/serve`'s own, and this keeps them out of the resolution that
chooses which object answers; both halves are needed.

#### `mappedHost()`

The host's KV mapping, or undefined; read at most once per host per {@link HOST_MEMO_MS}.

MEASURED ON A DEPLOYED WORKER, and this is why it exists: one WARM `CONFIG_KV.get()` costs 4 ms
at the median (a key the colo has not seen costs 46-140 ms), and a production page request made
TWO of them for the same host -- once in the catch-all
rewrite and again in `siteFor()` -- for 8.5 ms before any other tier was consulted. Every
measurement deploy in this repo sets `PW_DIAGNOSTICS=1` and calls `/serve?site=X`, which takes the
`param` branch above and reads 0, so no arm had ever priced the shape that ships.

A THROWN READ IS NOT MEMOISED. A KV blip must cost the next request a retry rather than pin
derivation for a minute.

### `src/ops/site-origin.ts`

#### Module overview

The origin Drupal renders against, and why it is not simply the `Host` header.

Every absolute URL Drupal emits -- the canonical tag, a form action, a `Location:`, the link in a
password-reset mail -- is built from the request's scheme and host. The render fragments hardcoded
`localhost`, so a deployed site told every visitor and every crawler that it lived on
`http://localhost`, and a reset link mailed to a user pointed at their own machine.

The inbound host is not automatically safe to use. An attacker who can set it can move a
password-reset link onto a host they control and can poison a cache keyed by path alone. The
defence here is that the origin is a property of the SITE rather than of the request:

1. `SITE_ORIGIN` -- set at deploy time, wins outright, and is the answer for anyone who wants no
   inference at all.
2. The PIN, held in `cfw_meta`. Trust on first use, the same shape `/firstrun` already uses for
   the owner token: the first request a site answers fixes its origin, and every later request is
   measured against that rather than believed. A forged `Host` after the pin changes nothing.
3. The observed origin, when there is no pin yet -- which is the request that sets the pin.
4. `http://localhost`, only when nothing above produced a usable value.

The window TOFU leaves open is the first request after a deploy, and it is closed from the other
end: `/firstrun` re-pins, so claiming a site also fixes its origin.

#### `normaliseOrigin`

Accepts a full URL and discards everything after the authority, because an operator setting
`SITE_ORIGIN` to `https://example.com/` should not get a double slash in every canonical tag. A bare
hostname is accepted and assumed `https`, since that is the only thing a deployed site can mean.
Anything that is not http or https is refused outright -- `javascript:` reaching a form action is the
reason this is an allowlist rather than a blocklist.

#### `aliasRewrite`

The page store keys on path alone and every render uses the pinned origin, so one stored copy serves
every host a site answers on. An alias visitor needs three things moved to its own host: the absolute
URLs in the body (plain and JSON-escaped, since drupalSettings and AJAX carry the second), a `Location`
that would send it to the canonical host, and the cookie `Domain` Drupal derives from the render host,
which a browser refuses from any other host -- so a login on an alias never held. The session cookie
NAME stays the canonical one, which is what the next render looks for, so one session works on every
alias. The body is rewritten as a stream, so a BigPipe response still arrives progressively.

### `src/ops/site-secrets.ts`

#### Module overview

Per-site secrets, minted in the Durable Object and never in the shipped payload.

Workers assets are served PUBLICLY, and `.assetsignore` un-ignores the packs, so anything
secret that ships in `assets/` is fetchable at a guessable URL by anyone -- and identical on
every site deployed from that payload. Three secrets were in there:

| secret               | where it shipped              | fix                                  |
| -------------------- | ----------------------------- | ------------------------------------ |
| `hash_salt`          | `drupal-pf/core.pf.bin`       | minted here, appended to settings.php |
| `system.private_key` | `drupal-sql/0052.json`        | removed; Drupal regenerates it        |
| admin bcrypt hash    | `drupal-sql/0064.json`        | blanked; `/firstrun` sets a real one  |

Only the salt needs this module. Drupal already self-heals the private key --
`PrivateKey::get()` calls `create()` and `set()` when state has none -- and a password has to
come from the operator. A salt has no such mechanism: `Settings::getHashSalt()` throws when it
is empty and nothing generates one outside the installer, which never runs here.

The salt is what signs one-time login links, form tokens and `Crypt::hmacBase64`, so sharing it
across sites lets anyone holding the payload mint a valid password-reset URL for any of them.

@see src/site-do.ts, which appends {@link hashSaltAssignment} to settings.php at boot
@see scripts/scrub-pack-secrets.ts, which removes the shipped salt from the pack

#### `ensureOwnerToken()`

Reads this site's owner token, minting one the first time.

WHY A SECOND SECRET RATHER THAN REUSING `PW_DIAGNOSTICS`. Getting your data out required
`PW_DIAGNOSTICS=1`, and that flag is one boolean over a set that also contains `/sql` (arbitrary
SQL against the site database), `/restore` (a whole-database overwrite) and `/php`. So the
supported way to leave was to expose a remote shell to the internet first. Export is an OWNER
operation, not a diagnostic, and it needs a credential rather than a mode.

Same mint and same storage as {@link ensureHashSalt}: per site, persisted, never in the payload.

### `src/ops/state-fingerprint.ts`

#### Module overview

Admission compares a replica's fingerprint against the primary's for the generation the primary
advertises. That comparison is a validation invariant rather than an optimisation: without it, "the
replica applied every generation up to G" rests on the log having been complete and correctly applied,
which is precisely the thing that can be wrong. A fingerprint checks the result instead of the process.

1. Order independence. The digest must not depend on the order rows come back in. SQLite is free to
   return them in any order absent an ORDER BY, and a replica that restored by a different path will
   differ. So the rows are sorted here rather than trusted.
2. Unambiguous framing. Joining fields with a separator makes `("ab", "c")` and `("a", "bc")` hash
   identically for any separator that can appear in a value, and values here are arbitrary serialized
   PHP. Every field is length-prefixed instead, which no value can forge.

#### `FINGERPRINT_TABLES`

`key_value` and `key_value_expire` only. The bulk tables are deliberately NOT covered: a content row
differing between primary and replica is a replication lag question that the generation already
answers, while an installation-global differing is a correctness failure the generation cannot see.
Widening this to content would make the fingerprint disagree constantly for reasons that are not
faults, and a check that cries wolf gets turned off. ORDER BY is present anyway, even though
`canonicaliseState` sorts: an unordered read of a large table looks deterministic in a test and is not
in production.

#### `fingerprintState`

SHA-256 through WebCrypto rather than a hand-rolled hash: this is a correctness comparison between two
machines, and a 32-bit hash collides at a rate that would eventually admit a replica whose state
differs. The cost is irrelevant because it runs at admission, not per request.

#### `readStateRows`

An un-restored object is exactly when this gets called, and a single UNION over both tables threw `no
such table` on one -- so the route that exists to report a replica's state answered 500 for the state
it is most often asked about. A missing table is reported rather than swallowed: zero rows because a
table is empty and zero rows because it does not exist are different facts, and only the caller knows
which of them should refuse.

### `src/ops/state-inventory.ts`

#### Module overview

Which persistent state a replica may hold, at the granularity the state actually has.

A TABLE IS NOT AN EFFECT, and this module exists because that was measured twice. `key_value`
holds the disposable `update_fetch_task:*` queue in the same table as `state:system.private_key`,
which Drupal mints lazily and keys CSRF tokens on -- two replicas each minting their own would
issue tokens the others reject. A per-table verdict is wrong in whichever direction it is set, so
classification here keys on `(table, collection, name)`.

The second secret was found by enumerating rather than by reasoning: `state:system.cron_key` is
the token in the cron URL, and nothing had named it. Assume the list is still incomplete -- that
is what {@link UNKNOWN} and `tests/integration/state-inventory.spec.ts` are for.

#### AUTHORITATIVE_TABLES entry `cfw_module_blob` / `cfw_module_rev`

The uploaded module store, and it is AUTHORITATIVE where `cfw_module_file` is derived.

The distinction is the whole reason the two are separate. `cfw_module_file` is the
materialised tree and a revision can rebuild it; the blob and the manifest are the only copy
of bytes that arrived from a developer's machine and exist nowhere else -- not in the pack, not
on a registry, not on a git host. Calling either derived would let a replica originate one and
would let a restore drop the module a site is running.

#### AUTHORITATIVE_TABLES entry `sequences`

THE ID GENERATOR, and the third lazily-dangerous value this inventory turned up.

Two replicas each allocating from their own `sequences` would mint colliding entity ids, and
nothing would error until the rows met. In the same family as the two secrets: the danger is
that a replica can ORIGINATE the value rather than that it merely holds it.

#### `AUTHORITATIVE_TABLE_PATTERNS`

Patterns that make a table authoritative, applied only after every explicit list above.

PATTERNS ARE ALLOWED HERE AND NOWHERE ELSE, because this is the direction that fails safely: a
table wrongly matched costs a failover to the primary, while a table wrongly matched as local or
derived lets a replica originate state. Entity storage is where the table count actually grows --
a contrib module adds `node__field_x`, `node_revision__field_x` and so on -- and enumerating it
would be a list nobody prunes.

#### trailing comment at end of file

`replicaMayOriginate()` and `replicaMayServe()` were here, exported, unit-tested and called by
nothing, and both are DELETED rather than wired -- they read as the missing callers for two real
decisions and are the wrong shape for either.

`replicaMayOriginate()` looked like the predicate `originable()` in write-forwarding.ts should
have used. It is not: it answers false for AUTHORITATIVE, which is every content table, and the
lane id partition exists precisely so a lane CAN mint into those safely under a disjoint stride.
Wiring it would have refused the feature it appeared to protect.

`replicaMayServe()` is a DENY-list over statuses, and `src/ops/replica.ts` is deliberately two
allow-lists and no deny-list, because an unknown effect has to fail closed by being absent from
an allow-list rather than by being absent from a deny-list.

What survives is `classifyState()`, which both were thin wrappers over and which
`hazardClass()` in write-forwarding.ts does call.

### `src/ops/supervisor.ts`

#### Module overview

The host half of the health layer: tripwires, the ledger, the breaker, quarantine.

Half of this has to be JavaScript, for one reason:
**a repair path must not depend on the subsystem it repairs.** PHP cannot observe a JS throw
out of a wasm import (measured twice -- `@` and `catch (\Throwable)` are both useless, and the
whole invocation dies), cannot observe its own isolate being killed, and cannot be trusted to
fix itself once poisoned. Detection and repair for those classes live here.

Every tripwire in this file corresponds to a defect this project has ALREADY SHIPPED and then
found: a tripwire earns its place by having caught something real, so each one names its
incident.

Everything here is a pure function of an observation, so it is testable without a Durable
Object, a wasm instance, or a clock. The wiring that gathers observations lives in
`src/site-do.js`; this module never reads global state.

#### `renderEmpty`

A 200 response with a zero-byte body.

THIS SHIPPED. Destructing `theme.registry` on a persistent interpreter made render 1 return
12,304 bytes and every render after it return 0, while rows-written per render jumped 15 -> 85.
A cache cannot tell an empty 200 from a real page, so it stores and re-serves it. This is the
tripwire the whole "quarantine beats wrong output" rule exists for.

#### `bridgeAsyncifyCalled`

The Asyncify stub was reached.

The glue calls `Asyncify.handleAsync(...)` from the http/https stream wrapper and from
`vrzno_await`, and declares `Asyncify` nowhere, so it was a free identifier that `ASYNCIFY=0`
compiled out. Reaching it threw `ReferenceError` out of a wasm import, which **PHP cannot catch
at all** -- measured from two unrelated routes -- and killed the invocation. `stream_get_wrappers()`
advertises http and https, so ordinary contrib code reaches for them.

A PHP-side handler cannot see this: no PHP fatal, no printErr, Drupal's logger never runs. The
counter on `globalThis` is the ONLY place it is observable, which is exactly why this tripwire
is in the host and not in PHP.

`warn` AND NOT `error`, because the severity above was calibrated to the paragraph above it and
the stub is what stopped that being true. Reaching a free identifier killed the invocation;
reaching the stub returns -1, `fopen()` returns false, and PHP handles it. Measured: with the
three outbound-HTTPS cron hooks on and a cold fetch cache, the first round trips this 10 times,
`error` starts at `reset`, three rounds reach `quarantine` and EVERY PAGE ANSWERS 503 -- so a
newly provisioned site took itself down the first time cron ran, over a feed fetch that had
already fallen back correctly. A graceful degradation must not escalate to an outage. An
invocation that does die is caught by the tripwires that watch renders.

#### `budgetPressure`

A daily free-plan meter projected past its allowance.

Rows written at 100,000/day is the meter that actually binds fills, and `setAlarm()` is itself
one row written. The watchdog lesson is the reason this exists: an unbounded log table became
**46% of the database** before anybody looked.

#### `memoryTrendRising`

Linear memory trending up across warm requests without rising every single time.

The complement of `memoryHighwaterRising`, not a replacement for it. That check demands a
strictly monotonic rise over the last four samples, which emscripten's geometric growth makes a
reasonable shape to demand -- but it also means one plateau or one dip inside the window hides a
real leak completely, and the lazy FS converges on the union of every route ever served, which
climbs in steps rather than smoothly.

So this one fits the whole ring and asks whether the rise beats the wobble, and it returns null
whenever the strict check already fired: two findings for one leak would escalate the breaker
twice as fast for no extra information.

**Acts at the next quiet moment, never the next request.** Recycling the interpreter mid-traffic
trades a leak nobody has noticed for a 4,019 ms boot every waiting request pays for, so the
severity is `warn`: `initialRung('warn')` is `observe`, which schedules rather than
resets.

### `src/ops/sweep.ts`

#### Module overview

The addressable sweep: pre-render the tail on a declared budget instead of billing a visitor for it.

Page coverage is demand-driven today. A URL renders when somebody asks, that visitor waits, and
nothing knows what fraction of the site is covered or bounds what a crawler can make the site
spend. Two renders of one anonymous entity page are byte-identical, so the question is never HOW
the tail is produced -- only WHEN it is paid for and who waits.

THE SWEEP QUEUES, IT NEVER RENDERS. Everything here writes `cfw_fill_queue` rows and stops; the
existing alarm fill batch drains them under the `oversized()` guard it already has. That is what
makes the isolate failure structurally impossible rather than bounded by a constant: a sweep adds
no workload to any invocation, so it cannot be the batch that crosses 128 MiB.

THE GOVERNOR IS THE FEATURE. Three bounds, each against a different failure: a floor it will not
start below, a share of the DAY it may spend, and a share of what is LEFT it may take at once.

#### `planSweep`

How many pages this step may queue, and why not more.

Three bounds, each against a different failure this project has already shipped:

- the FLOOR, against a QA day that wrote 104,451 rows and put a site read-only at 104% of quota
  with nothing on any admin page saying so. A sweep will not start where the ladder has already
  stopped cron.
- the DAILY cap, against the sweep pushing the site to the floor by taking a share of a shrinking
  remainder forever. The share of what is left bounds one step; this bounds the day.
- the BATCH, so `cfw_fill_queue` never grows past what the next firing drains, which is what the
  cron branch's `queueDepth() === 0` yield depends on being true.

The isolate limit is absent from that list on purpose: this queues rather than renders, so it adds
no workload to any invocation and the existing `oversized()` break in the fill batch is what still
bounds memory.

#### `sweepEnabled`

ON by default at a fleet-safe share; `SWEEP=0` turns it off.

IT WAS OFF, and the reason was a meter rather than caution: the row and DO quotas are
ACCOUNT-WIDE while `dailyRows()` counts one object, so the governor cannot see what the rest of
the fleet has spent. At 25% of 100,000 rows per site, four sweeping sites saturate the account
and each one reads its own meter as healthy. That is a real failure mode and it is not overridden
here -- it is priced. An unasked-for sweep takes {@link UNASKED_ROWS_FRACTION} instead of the
full share, so the number of sites it takes to saturate the account moves from 4 to 20, and an
operator who asks for a sweep still gets the measured 25%.

WHY IT IS WORTH DEFAULTING ON. A path nobody has rendered is the `anon-miss` slice, 0.095 of the
traffic mix, and it is the one profile a render cannot win: measured deployed, a warm inline
render answers in 474 ms against a well-configured VPS's 78 ms, and the wasm penalty alone
(3.57x) puts ~278 ms out of reach. **A render cannot be made competitive, so it has to not
happen.** A swept path is a HIT at ~1 ms. This is the only lever that changes that profile's
outcome rather than its cost.

The governor is unchanged and still the thing that bounds it: `sweepStep()` reads `rowsToday`
against `rowsLimit` and `doToday` against `doLimit` every step, `sweepDue()` gates on an interval
rather than firing per alarm, and a site with nothing uncovered does nothing at all.
`src/ops/fleet.ts` remains the inventory that would let the full share be safe by default.

### `src/ops/tcp.ts`

#### Module overview

The TCP tier of the CFW network capability: deferred, scripted, operator-scoped.

**Imported from `edgeport/core`, not the package root**, which re-exports 20 namespaces it never
imports: esbuild refuses that and vite tolerates it, so the gate stayed green while wrangler could
not bundle.

**THIS DOCBLOCK ASSERTED THAT A SESSION API CANNOT EXIST, AND THE SHIPPING BINARY HAS ONE.** The
claim was that `Host::call()` is `$reply = $invoke($json)`, so a host function that awaits hands
PHP a Promise it can only stringify, and a `read()` blocking for bytes that have not arrived is
therefore impossible. That was true of a HOST FUNCTION and it was never a property of the
interpreter: `ext/cfwpark` freezes the Zend continuation, `longjmp`s out of `pib_run`, and lets
`src/ops/park-drive.ts` perform exactly `open` / `write` / `read` / `line` in JavaScript before
resuming the same PHP chain. `drupal/redis` runs on it and is `verified`. The refusal closed a
mechanism and took the objective with it, which is the failure this repository names most often.

So this file is the DEFERRED tier, not the only tier. PHP declares a whole exchange, the exchange
runs in JS between invocations, and the answer is readable on a later one -- the same
cached -> deferred -> sync layering `cfwFetch` lives under, and the sync tier is `src/ops/park.ts`.
The deferred tier survives on its own terms rather than as a consolation: a park is refused
wherever the safety predicate cannot walk the frames, and **a refused park must degrade rather
than fail**, so this is what it degrades to.

**The ENDPOINT is the operator's, never the caller's.** A queued row names a host, so letting PHP
choose one would put arbitrary `host:port` TCP behind any module that can call a host function --
a port scanner and a protocol-smuggling surface, which is a strictly larger hole than the HTTP
tier's SSRF because it is not confined to HTTP semantics. `REDIS_URL` and `SYSLOG_URL` supply the
endpoint and the credentials; PHP supplies the operation and nothing else.

Two protocols ship because two shapes exist, not to be a catalogue: `redis` has a reply and is
therefore cached-or-deferred, `syslog` has none and is fire-and-forget. A third protocol is a
registry entry.

#### `tcpMethod()`

The HTTP method a TCP operation borrows, so the deferred tier's budget and TTL apply unchanged.

They are reused rather than duplicated: `attemptBudget()` already says a
non-idempotent operation gets one attempt, and a Redis `INCR` replayed after a timeout is the same
defect as a captcha token replayed -- the first attempt may have landed and only failed to return.

### `src/ops/thermal.ts`

#### Module overview

Whether to keep an object resident, decided from arrivals rather than from a constant.

##### What the flat interval costs and what it buys

`WARM_INTERVAL_MS` is 8,000 because a Durable Object hibernates at 10 s of idle -- measured on a
throwaway: re-armed every 8 s one incarnation survived 71 consecutive alarms; at 12, 20, 30 and 45
the constructor ran again on every probe. So warming is 10,800 firings a day whatever the traffic,
one Worker request and one row each, and what it removes is the 1,398 ms cold boot from pages that
render. A cached page answers off `ctx.storage.sql` without booting PHP, so warming cannot make
one faster by any amount.

Retention added a middle: past 10 s the object hibernates, and its next instance adopts the
interpreter when it lands in the same isolate, so an operator-set `WARM_INTERVAL_MS` above the
threshold buys that chance at fewer firings. This module still solves only below the threshold.

##### The band, and why a constant sits in the wrong place inside it

Below about 505 renders/day the alarms cost more than the boots they save. Above about 8,640 the
site never idles long enough to go cold, so the alarms are pure waste. A flat interval is only
right in the middle of that band, and it is charged at both ends.

##### The decision

`P(next render within T) x C_cold > C_warm`. Everything on the left is observable from arrivals
this object already counts, and everything on the right is measured. Modelled as a Poisson
process: for rate `r` renders per second, `P(at least one within T) = 1 - exp(-r x T)`.

A POISSON MODEL IS AN ASSUMPTION, not a measurement, and it is the one thing here that is not
pinned. Real traffic is bursty, so the estimate is conservative in the direction that matters: a
burst raises the observed rate and warming turns ON, and the error case is warming a site that
would have idled -- the same thing the flat interval does unconditionally.

#### `WARM_FIRING_COST_MS`

NOT a duration -- an object waiting on an armed alarm is idle-eligible and not billed for
duration. What a firing spends is one Worker request and one row, and the comparison has to be
made in one currency.

DERIVED FROM THE MEASURED BAND rather than chosen. The recorded crossing is ~505 renders/day:
below it the alarms cost more than the boots they save. At that rate `r = 505 / 86400 =
0.005845/s`, so `P(render within 10 s) = 1 - exp(-0.05845) = 0.05678`, and break-even means
`P x COLD_BOOT_MS = C_warm` -- which puts `C_warm` at 79. A first version of this file carried
130, invented, which moved the crossing to 845 renders/day and would have un-warmed a band the
project had already measured as worth warming.

#### `WARM_INTERVAL_VERIFIED_MS`

8,000 against a 10,000 ms hibernation threshold: one incarnation survived 71 consecutive firings
at this interval, and 12,000 lost the isolate on every probe. Nothing between 8,000 and 12,000
was ever driven, so this is the largest interval with evidence behind it rather than the largest
that works.

#### `WARM_MARGIN_MIN_MS`

The top of the band, and the margin is the only free parameter in the whole model.

Any interval below the threshold prevents every cold boot equally well, so the benefit does not
vary across the band and the cost is one firing per interval. That makes the optimum the LARGEST
safe interval, not a point somewhere inside: at 9,500 a warmed site fires 9,094 times a day
against 10,800, which is 1,706 rows returned.

Whether 9,500 is safe is an empirical question about how late a Cloudflare alarm may fire, and
this project has not measured it. So it is a ceiling to climb toward on observed evidence rather
than a new default; `solveWarmInterval` is what does the climbing.

#### `solveWarmInterval`

SOLVED RATHER THAN PICKED, which is the whole item: `thermalRearmMs()` chose between two
constants, and the one it chose when warming was the smallest interval anybody had evidence for.
The band above it is worth 1,706 rows a day and nothing in this repository knows whether it is
safe, so the object finds out for itself and pays for being wrong exactly once.

Climbs one step after WARM_CLEAN_WINDOWS windows that ONE incarnation spanned, and
retreats all the way to WARM_INTERVAL_VERIFIED_MS on a window it did not. The retreat is
to the verified value rather than one step back because a broken chain says the current interval
is unsafe on this object and the next-lower step has no more evidence behind it than the one that
just failed.

#### `RenderWindow`

THE RING IS IN MEMORY AND DIES WITH THE INCARNATION, which made the whole decision unreachable in
the band it was built for. Between 505 and 8,640 renders/day the object hibernates between
renders, so every wake read an empty ring, `renderRate()` answered 0, and `warmDecision()` took
its "no render in the window" branch every time. The branch could only ever fire on a site busy
enough not to need it.

A counter and a window start, in one `cfw_meta` row. Flushed on the window boundary rather than
on the meter interval: the estimate only has to separate ~505/day from ~8,640/day, so a 15-minute
bucket is enough resolution and caps this at 96 rows/day. The daily meters learned the other
lesson the expensive way -- a counter written on every idle tick was 32.4% of free's row budget
recording its own bookkeeping.

#### `readRenderWindow`

Two fields or four. The two-field form is what shipped, and it is read rather than discarded
because discarding it would reset every warmed object's rate estimate on the deploy that added
the interval -- which is the one reading the thermal decision cannot do without.

#### warmDecision, active session branch

AN ACTIVE SESSION BEATS THE RATE ESTIMATE, and the rate estimate is the wrong predictor for it.
`renderRate` is a property of ANONYMOUS traffic: it is what decides whether a visitor is likely
to arrive. What decides whether an expensive DO-required render is imminent is whether somebody
is signed in and working, and an editor on a quiet site produces a rate far below the 505
renders/day crossing while producing exactly the requests a cold boot hurts most. Measured on
the comparison rig: an authenticated page costs 31 ms warm against 513 ms on a cold object.

Bounded by a window rather than left latched, so a session that ended stops paying within one
window. At the 8 s re-arm a 30-minute window is 225 firings, 225 requests and 225 rows, once.
(sic: 30 min / 8 s is 225 firings as written in the source.)

#### `routeFamilies`

PREWARMING A FAMILY RATHER THAN A URL is the point. A visitor who arrives on `/node/41` after an
editorial save meets a cold object even though `/node/40` is warm, because the page cache is keyed
on the URL and the OBJECT is what was cold. The family is the first path segment, which is what
Drupal's own routes are grouped by, so warming one member warms the interpreter every other member
needs.

### `src/ops/updb.ts`

#### Module overview

`updb` sliced across Durable Object invocations: the plan, the cursor, and the
contract that makes a half-applied update impossible to produce silently.

**The problem, in measured numbers.**

A security release ships database updates. Applying them means every pending
`hook_update_N()`, every pending `hook_post_update_NAME()`, and
`drupal_flush_all_caches()` twice. Measured in this project (TECHNICAL_REPORT.md
"Module installation"): the install-class workload is **1,344.7 ms of CPU and a
78.5 MB peak**, of which `drupal_flush_all_caches()` alone is **282.9 ms in wasm
/ 268.8 ms native, and the 78.5 MB peak is its**.

The free plan gives **10 ms of CPU per invocation** -- for Durable Objects too,
and explicitly including alarm invocations -- and **100,000 rows written per day**,
which is the meter that actually binds. So `drupal_flush_all_caches()` is 28x one
invocation's entire budget in a single synchronous call, and the whole workload is
134x.

Four platform facts constrain every possible answer, all measured here:

  1. `ctx.storage.sql` is synchronous and only reachable from inside the DO.
     There is no async seam to suspend at mid-update.
  2. The object HIBERNATES after ~10 s idle and DISCARDS in-memory state,
     including the interpreter, the mounted tree and the booted kernel.
     Confirmed directly: `x-cfw-php-booted` flipped 1 -> 0 between two curls
     seconds apart, and the JSPI park probe found a parked stack survives 6 s
     and is gone at 10 s.
  3. Neither clock works. In-PHP `microtime()` returns 0 on the edge, and
     `Date.now()` is frozen during synchronous execution -- 16 assembly renders
     reported wallMs 0 while tail charged them 27-120 ms. **So no loop in this
     file may be driven by a clock.** The cost meter here is rows and statements
     off the cursor, which our own bridge increments per statement.
  4. A render cannot be interrupted once started: a `setTimeout(1)` raced
     against a 119 ms render LOST, because the timer cannot fire until the wasm
     call returns. Every budget decision is therefore a PRE-check, never a race.

**The avenues, costed, and which one this file is.**

**(a) One `hook_update_N` per invocation, cursor in DO storage.** Necessary
skeleton, not sufficient on its own: it splits the TOTAL across invocations but
enlarges none of them, exactly as the 20-hop measurement showed (142 ms of CPU
for one request, no single hop over 10 ms). A single hook, or a single
`drupal_flush_all_caches()`, still does not fit. **Adopted, plus (c).**

**(b) A warm window held by an outbound WebSocket.** A socket holds the object
alive for a documented 15 minutes, and each inbound message resets the 10 ms
budget. Costed: 15 minutes of resident object is 0.25 h against the 28.2
active-hours/day the 13,000 GB-s free duration allowance buys -- **0.9% of a day**,
so duration is not the objection. **Rejected as the default anyway**, because the
alarm chain already achieves the same thing for less: re-arming at +1 ms puts the
next unit ~1 ms of wall clock later, which is three orders of magnitude inside the
6-10 s eviction window, and costs 1 row written per re-arm instead of a held
connection and a 15-minute ceiling. Kept as the escape hatch for the one case the
alarm chain cannot cover: alarm delivery is documented best-effort, so a stalled
chain needs an outside poke, and a socket is that poke.

**(c) Split the indivisible-looking step until each piece is bounded.**
`drupal_flush_all_caches()` is not one operation, it is eleven, and core names
them (common.inc:408-475). `UPDB_FLUSH_STEPS` in src/updb-php.js runs them as
eleven units in core's own order. This is the only avenue that attacks the
single largest cost rather than relocating it. **Adopted.**

**(d) Batch by measured cost rather than by count.** Adopted in a weak form,
because of fact 3 above: there is no clock, so "cost" can only
mean rows written and statements executed, and neither is CPU --
`drupal_flush_all_caches()` is 282.9 ms across very few statements. So batching
can amortise the re-arm row but cannot protect the CPU cap. `maxBeats` defaults to
**1**, every unit records the rows and statements it actually cost so a future
round has real per-unit data, and the docblock on `updbStep()` says plainly that
raising it above 1 is a paid-plan setting.

**(e) Run against a COPY of the database and swap atomically.** **Rejected**, and
recorded so nobody re-derives it. Three findings kill it:
  - Rows written is the binding meter, and a copy costs one written row per row
    copied. The packed standard site is 1,342 rows, so copying THAT is 1.3% of a
    day -- affordable. A small real site with content is 50k-200k rows, so one
    copy is 50-200% of the daily allowance, and it fails by exhausting a meter
    shared with the serving path.
  - Size is not even the deciding objection. To run updates against the copy,
    Drupal has to ADDRESS the copy, which means a table prefix, and the driver
    **refuses prefixes** (DRIVER-NOTES.md). Copy-and-swap is therefore new driver
    work, not new SQL.
  - The swap needs `ALTER TABLE ... RENAME`, and DDL mid-flight dirties
    `sqlite_master`, which turns every later read in a transaction into a
    speculative replay -- the O(W x R) cost this project has already observed
    wedging the local runtime badly enough that unrelated sites stopped
    responding.
  Replaced by (f) plus (g), which buy the same guarantee for a bounded price.

**(f) A maintenance-mode gate.** Adopted, and it is the FIRST unit, not a wrapper:
`maint_on` is seq 0 so the fence is durable before anything -- including the
planning step, which writes (`_update_fix_missing_schema()` sets schema versions).
`maint_off` is the last unit and restores the PRE-RUN value rather than forcing
FALSE, which is what `DbUpdateController::batchFinished()` does through the
session; here it comes out of the run row, so it survives an eviction a session
would not.

**(g) Bounded snapshots plus an export for rollback.** Adopted. `snapshot` (seq 1)
copies the update system's own bookkeeping -- `key_value`, `key_value_expire`,
`config`, `cachetags` -- with a row ceiling that refuses rather than quietly
spending the day's writes. **Limitation:** that restores
"which updates ran" and the config they changed, NOT what a hook did to
`node_field_data`. Whole-site rollback is the R2 export, which
`exportDatabase()`/`/export` already produces, and `requireExport` makes it a
precondition of starting.

**The choice, and what it costs.**

A maintenance-fenced, JS-prechecked, TWO-BEAT alarm chain: one claim beat and one
run beat per unit, plan and cursor in `ctx.storage.sql`, the flush split eleven
ways, bookkeeping snapshotted, and **HALT rather than retry as the default
response to anything unexpected.**

Cost for a typical SA-CORE point release (0-3 `hook_update_N`, 0-2 post-updates),
derived from the plan shape, not measured on the edge:

  | | count |
  | --- | --- |
  | units: maint_on + snapshot + plan + 3 updates + 11 flush + 2 post + 11 flush + maint_off | 31 |
  | DO invocations, at 2 beats per unit | 62 |
  | rows written: ~2 bookkeeping + 1 setAlarm per beat | ~190 |
  | fraction of the 100,000/day request allowance | 0.06% |
  | fraction of the 100,000/day row allowance | 0.19% |

So the chain itself is free. **The cost that is NOT free: boot.**
A cold interpreter is 3,754 ms of cpuTime on the edge in one indivisible
synchronous stretch -- 375x the free cap -- and no cursor design cuts that up.
Therefore:

  - On paid, this runs today, and its value is the never-half-applies contract
    rather than the CPU split.
  - **The site no longer passes `phpReady`, 2026-09-29**, because the 10 ms cap does not
    fail a Durable Object invocation (a 1,882 ms one succeeded on free), so a cold unit
    boots. The refusal below stays for a caller that passes it. It was written when
    every unit had to fit 10 ms **provided the object is already
    warm**, which is what the keep-warm alarm and (b) exist for. A chain that
    starts cold cannot boot, so `updbStep()` refuses on a cold interpreter with
    `reason: "cold-interpreter"` rather than burning an invocation that will be
    killed. That refusal is bounded by `maxColdWaits` and then halts, so the halt
    reason names the real blocker instead of a mystery stall.
  - The lever that removes the last obstacle is a `-sJSPI` php-wasm build, which
    is measured to work on deployed infrastructure for the slicing half but has no
    binary yet. With it, boot becomes sliceable and the free-plan cold path opens.
    Nothing in this file assumes it.

**The resumability contract.**

**Why two beats, and the thing that cannot be done at all.** A crash detector needs
a marker that survives the crash. DO SQLite commits its implicit transaction at the
END OF EACH EVENT -- measured here: a `BEGIN` in one `fetch()` was already committed
before the `ROLLBACK` arrived in the next. So a marker written in the same event
that enters PHP is worthless: it dies with the event it was meant to outlive. The
claim must therefore commit in its OWN event, before the run event starts. That is
the two-beat rhythm, and it is why the cost table above says 62 invocations.

It is NOT sufficient, for a reason that is not obvious:
**whatever state the run beat READS is also the state a killed run beat LEAVES.**
Renaming it, pre-committing it, or moving the claim into the previous unit's commit
all preserve that symmetry exactly. Within a store whose only durability boundary
is "the event completed", a kill mid-event is undetectable from storage alone. The
detector has to come from outside the event.

So the detector here is **a single-use in-memory token**. The claim beat commits
`attempts + 1` and then issues a token naming (run, seq, attempts). The run beat
consumes the token before entering PHP. A beat that finds the unit `claimed` with
no matching token knows a run was owed and cannot prove it did not happen, and
**halts**.

That is fail-closed, and it has one false positive: if the object is
evicted between the claim beat and the run beat, the token goes with the
interpreter and a unit that never ran is reported unverifiable. The chain re-arms
at +1 ms specifically to make that window ~1 ms against a 6-10 s eviction timer,
and a false positive costs an operator one decision while the alternative costs a
half-applied schema. **The way to turn the false positive into a certainty is a
Tail Worker reading the `exceededCpu` / `exceededMemory` outcome for the killed
invocation** -- the only mechanism on this platform that observes a kill from
outside it. That is a named follow-up, not something this file pretends to have.

**What is written, per beat.**

  claim beat: `cfw_updb_unit.state = 'claimed'`, `attempts = attempts + 1`,
  `claimed_at`. Nothing else. No PHP is entered, so this beat cannot be killed by
  CPU.

  run beat, on a completed unit: in ONE `transactionSync` -- `state = 'done'`,
  `finished`, `message`, `rows`, `statements`, `ended_at`; `cfw_updb_run.cursor_seq
  = seq + 1`, `abort_list`, accumulated meters, `updated_at`. The bookkeeping
  triple is atomic by construction rather than by trusting the event model.

  run beat, on a partial unit (`finished < 1`): `state` goes back to `'pending'`,
  `passes = passes + 1`, `sandbox` updated, cursor unchanged. Back to `pending`,
  which is what keeps "state is `claimed` at claim time" an unambiguous crash
  signal.

**What happens when the object is evicted between two update hooks.** Nothing is
lost and nothing is guessed. Every completed unit is `done` in durable SQL, the
cursor points at the next one, the site is still fenced because maintenance mode
is state in the database rather than memory, and the sandbox of a half-finished
hook is base64 `serialize()` in the unit row -- which is core's own contract, since
the batch API serializes the same array into the `batch` table between HTTP
requests. The next alarm re-boots the interpreter and resumes at the cursor. The
only thing eviction costs is the boot.

**What happens when an invocation is KILLED mid-hook** (exceededCpu,
exceededMemory, isolate death). Its writes never commit, so the unit is still
`claimed` from the claim beat's commit -- and the token it would have consumed is
either consumed already or gone with the isolate. Either way the next beat finds
`claimed` with no valid token and **halts the run**: phase `halted`, reason
`unit-unverifiable`, maintenance mode left ON, cursor left pointing at the unit
that died. No retry, no advance, nothing silent.

That default answers a question this platform cannot yet
answer: whether a killed event's partial writes are discarded. The commit
direction is measured; **the kill direction is NOT measured here and cannot be
without a deploy.** If it turns out writes are discarded, re-running a killed unit
is safe and `retryPolicy: "core"` becomes provably correct -- it already matches
core, whose batch API re-runs an operation from its last persisted sandbox after a
fatal. Until someone measures it, the default halts, because a fenced site with a
precise cursor is strictly better than a site that silently re-ran half of
`system_update_11201`.

**Preconditions, checked in JS before PHP is entered at all.** This is what makes
a refusal cost ~0 ms instead of a 3,754 ms boot:

  - the run's `code_id` still matches. On this platform the PHP tree is a
    versioned asset pack, so a deploy can swap the code under a live cursor --
    a hazard a traditional host running update.php in one process does not have.
  - maintenance mode is still ON, read straight out of `key_value` (collection
    `state`, name `system.maintenance_mode`). Exempt for the two `maint_*` units.
  - for an `update` unit with `expect_schema`, the module's installed version in
    `key_value` (collection `system.schema`) equals it exactly. A mismatch means a
    previous unit did not land, or something outside this run moved it.
  - for a `post_update` unit, the function name does NOT already appear in
    `key_value` (collection `post_update`, name `existing_updates`).
  - the unit at the cursor is in a state the beat expects. Anything else is
    `cursor-desync` and halts.

Every one of those reads is 1-2 statements of plain SQL. Where a value cannot be
parsed the answer is `null` and the gate REFUSES -- unknown beats incorrect, which
is why the serialized-scalar reader below returns null rather than a guess.

**Wiring** (src/site-do.js is not edited by this file):

  import { updbStep, updbPrepare, updbStatus, updbAlarmDelayMs, updbOptions } from "./updb.js";

in alarm(), alongside the existing fill batch
  const step = await updbStep(
    { sql: this.sql, runJson: (code) => this.runJson(code), phpReady: () => !!this.php,
      txn: (fn) => this.ctx.storage.transactionSync(fn), nowMs: () => this.nowMs() },
    updbOptions(this.env),
  );
  await this.ctx.storage.setAlarm(this.nowMs() + updbAlarmDelayMs(step, updbOptions(this.env)));

The step function owns no transport, no alarm and no env of its own, exactly like
`cronStep()`, so the same chain runs off an alarm, off a WebSocket message, or off
one HTTP poke per beat in a test.

### `src/ops/write-forwarding.ts`

#### `ID_PARTITION_LANES`

The lane count every residue class is computed against.

A CONSTANT, NOT THE POOL SIZE, because no lane could learn the pool size and the partition was
therefore absent on every deployed pool. `idPartition()` read `REPLICA_COUNT` from env, which the
canonical `wrangler.jsonc` does not set, so a real lane was configured `lanes = 0`; the driver
takes `$lane >= 1 && $lanes >= 1` as false and strides on nothing. The whole disjointness
property -- the thing that makes a forwarded id safe to re-send on a conflict retry -- was
unreachable in production while its unit tests passed on a hand-set `REPLICA_COUNT`.

Fixed at {@link replicaCount}'s own ceiling, so the stride is 33 and lanes 1..32 hold distinct
non-zero residues however many exist. Nothing has to be told the count, which is the point: a
lane cannot read the primary's `lanes_provisioned` at all, because `cfw_meta` is replica-local by
design and is deliberately not copied.

> **Superseded:** the ceiling is 256 in the code and in docs/configuration.md; the 33 and 1..32 figures are stale.

#### `originable()`

Whether a reported table may stand on the allow-list at all; the primary re-applies this.

**A LANE CANNOT MINT FOR A TABLE IT DOES NOT HOLD.** A residue class only keeps two writers apart
when both count from the same base, and a lane's base is the maximum in its OWN copy. For a table
the restore refuses to copy that maximum is zero, so the lane mints the first id in its class --
`wid = lane` -- which the primary used when the site was new.

`watchdog` is the case that proved it: `planRestore()` answers
`copy: false, "an effect a replica must never perform"`, and a provisioned lane read
`count 0, seq null` against a primary at 61. Every authenticated POST on a pooled site answered
500 with `UNIQUE constraint failed: watchdog.wid`, because a login writes a dblog row.

Refusing here sends the batch back for the primary to serve, which is the right answer twice over:
the id becomes the primary's to allocate, and a PRIMARY_ONLY_SIDE_EFFECT is by definition work a
lane was never allowed to perform.

#### `writeForwardEnabled()`

The refusal it replaces was not free. With forwarding off a POST pins to the primary, so the one
object the pool exists to relieve keeps every form submission, and the lanes idle through exactly
the load that made the operator add them.

### `src/runtime/php-binary-85.ts`

#### Module overview

PHP 8.5, carrying every extension, reached through a brotli frame.

NOT THE SHIPPING SEAM since 2026-09-04. Cloudflare removed the compressed size limit this frame
existed to fit, so `php-binary-raw.ts` imports the binary uncompressed and startup fell from
~106 ms to ~5 ms. This is kept as an experiment arm, named by the configs under
`experiments/wrangler/`.

THE exit(-2) ABORT DESCRIBED HERE IS FIXED. Deployed to a throwaway on
2026-08-14 every request returned 1101 with `ExitStatus: Program terminated with exit(-2)` on both
the stateless and durableObject events, aborting during startup before any route logic. Size, the
recompression, the decoder and codegen were all ruled out.

The cause was `opcache.file_cache`, which opcache reads during PHP's MODULE STARTUP -- inside the
binary's constructor, before the mount sequence creates the directory. It was pointed at
`/tmp/opcache`, which did not exist yet. `src/site-do.ts` now passes `/tmp`, which emscripten's
MEMFS always creates, and carries the measurement: 1,301 `.bin` files across 425 directories after
one render on a deployed 8.5 worker. It was dead config until 8.5 -- the 8.3 build contains zero
occurrences of `Zend OPcache`, so every opcache ini line was silently ignored for the life of the
project and went live the moment 8.5 made it mandatory.

Read `src/site-do.ts` before removing any opcache ini line: `file_cache_only=1` makes the file
cache opcache's ONLY backing store, so dropping the path may disable opcache rather than merely
stop the writes. Removing opcache ini blind is what produced the abort.

8.4 is absent: it costs 49,220 MORE compressed bytes than 8.5 while being 357,323
smaller raw, because its data section is both larger and less compressible. Zero of the 73 packages
in the shipped lock exclude 8.5.

The binary lives in `.interp/` rather than `vendor/`, which holds unreproducible hand-built
artifacts and is never written to.

THE GLUE IS THE TUNED ONE, not the pristine download, and that is a memory decision rather than a
packaging one. Emscripten emits its heap-growth step into `_emscripten_resize_heap` as a
JavaScript literal, and its default of 0.20 takes an AUTHENTICATED render to 138.31 MiB against a
128 MiB isolate -- measured, three workloads, `scripts/measure/growth-ladder.ts`. At 0.05 the
worst of the three is 116.75 MiB. `restore-artifacts.ts` emits this file after verifying the
pristine one against `cdn-manifest.json`; `tests/node/growth-glue.spec.ts` asserts the two differ
at the growth site and nowhere else.

THE INFLATE IS THE RUNTIME'S, not a decoder we ship, and the frame is brotli rather than zstd.

Both halves are one change. `node:zlib` carries brotli and zstd, and workerd runs either
synchronously at MODULE scope -- which is the only place they could be used, since codegen is
forbidden at request time and the `new WebAssembly.Module` below has to happen at startup. Probed
on the shipping workerd against both frames of this exact binary: 2,671,745 zstd and 2,485,488
brotli, each inflating to the same 12,234,575 bytes, byte for byte identical, 4,118 exports.

What that buys, on `wrangler deploy --dry-run` gzip figures:

- the packed frame at 2,485,488 rather than 2,671,745, because brotli beats zstd on this binary
- `zstddec.wasm` gone, 25,473 bytes that existed only because the pure-JS zstd decoder was slow
- `fzstd` and cartridge's inflate helper gone with it

A previous note here said the zstd frame header carries the inflated length and the decompressor
pre-sizes from it. Brotli has no such field and `brotliDecompressSync` sizes its own output, so
nothing is lost; `scripts/pack-wasm-brotli.ts` records why its cache key changed to match.

NO `inflatedSize` cross-check, unlike the 8.3 seam. That binary is pinned in
`vendor/` and never changes, so a hardcoded size is a real guard there. This one is fetched from
phasm's newest artifact by `bun run fetch:interp85`, and two consecutive builds measured 12,218,400
and 12,218,393 -- so a hardcoded size turns every upstream rebuild into a code edit that fails
closed.

**The STARTUP cost cannot be measured locally**, because the wall clock does not advance between
I/O and a `Date.now()` delta around the inflate reads zero. Cloudflare reports it on upload, so a
deploy is the instrument. Measured on a FREE throwaway carrying this seam and nothing else,
2026-08-30: **104, 105, 107, 112 ms** (n=4, median 106) against a 1,000 ms limit. The
zstd-through-wasm path it replaces read 233/234/246 (n=3), so native brotli is about half of it
and spends a tenth of the budget.

### `src/runtime/php-binary-o2.ts`

#### Module overview

> **Superseded:** the shipping seam is `php-binary-raw.ts`; this one is an alias target for the -O2 experiment configs.

The shipping interpreter, and the one nothing in this document was measured on.

2,876,855 gzipped -- 268,873 UNDER the 3 MB free ceiling, where `static-free-v1` is
586,923 OVER it. It differs from the measured binary on three axes at once (RULE 0b-iii):

| | `static-free-v1` (measured on) | `static-o2` (here) |
| --- | --- | --- |
| optimisation | `-Oz` | `-O2`, separately measured 3.9% faster |
| SQLite | compiled in, ~614 KB | absent |
| ext-yaml | absent | present, worth 241 ms of boot |

It could not run Drupal until now: `MIGRATE_DB` reached for `new \PDO('sqlite:...')`
once, at first run, and `pdo_sqlite` is not in this build. `src/migrate-sql.js` replays
the site in JavaScript instead, so that last consumer is gone and this binary can run
the real workload. Base ext-pdo IS present, so the class constants core's sqlite
`Connection` references still resolve.

Selected by aliasing `./php-binary.js` to this file; see the docblock there for why the
alias cannot target the `.wasm` import directly.

### `src/site-do.ts`

#### `parkFetchDep`

What a parked HTTP yield is performed with; the global `fetch` unless a test replaces it.

The same injection `TcpDeps.connect` uses and for the same reason: stubbing `drivePark` itself
would assert against a stub, while stubbing the FETCH runs the real classifier, the real
outbound guard and the real resume.

#### `cfwCanSuspend`

Whether this binary can suspend, read by drupflare's service provider.

`FetchHandler` needs `vrzno_await()`, which needs Asyncify or JSPI. The shipping build has
neither and nothing defines a global `Asyncify`, so this reads false and the handler stays
off; `ParkFetchHandler` answers HTTP through the park instead.

The provider probes the binary rather than a settings flag, which would drift from the
binary actually loaded.

#### `flushDailyRows`

Folds the writes accumulated since the last flush into a per-UTC-day total.

Flushed on the alarm, never per write, and that is a correctness requirement rather than an
optimisation: persisting the counter costs a row write, so a per-write flush would DOUBLE
the number it is measuring. Once per firing it is one row against a batch of them, and that
row is itself counted, so the meter includes its own cost.

Keyed by UTC date because the limit is daily and the object is not. A Durable Object is
evicted whenever Cloudflare likes, so an in-memory lifetime counter reports a fraction of
the day and reads as healthy; the date key means an eviction loses at most the writes since
the last alarm rather than the whole day.

@returns the running total for today, after folding in whatever had accumulated.

#### `cfCredentials`

The Cloudflare API credentials, from the durable grant or from the deployed pair.

**The grant was written to memory and read from memory only.** `/__cfoauth?action=callback`
put the access token on `this.env`, which is one incarnation's overlay; the persisted copy was
read by `status` and `disconnect` and by nothing that put it back. An object hibernates at
about ten seconds idle, so the very next request had no token -- `/setup/mail` answered
`no Cloudflare token; connect an account first` while `/setup/cf?action=status` answered
`connected: true` at the same moment. Every consumer goes through here now.

**And the grant never refreshed.** `refresh()` and `needsRefresh()` were exported, unit
tested and called by nothing under `src/` -- `check:reachability` listed the second under
"tested but never called". An expired grant's only recovery was re-consent. A refreshed set is
persisted here so the next incarnation starts from it.

A refresh failure is not an error: the stored access token may still have life in it, and the
caller's own 401 is a better signal than a guess taken from a clock.

#### `cfCredentialsSync`

The same credentials without the refresh, for a caller that cannot await.

ONE RULE FOR WHICH CREDENTIAL THIS SITE USES, and there were two. `cfCredentials()` prefers
the durable grant and `mailEnv()` read only `this.env`, so a site whose Cloudflare account was
connected through `/setup/cf` -- the documented path, and the one `/setup/mail` onboards
against -- resolved its mail transport against a token that was never set. `auto` then walked
past `api` to SMTP, found no `SMTP_HOST`, and refused with "no mail transport is configured"
on a site that had just finished onboarding one.

Skipping the refresh is safe here for the reason `cfCredentials()` already gives: an expired
access token answers 401 and the caller's own 401 is a better signal than a guess taken from a
clock. The drain refreshes before it resolves, because it is the path that can await.

#### `setReplicaStage`

Moves this object's replica stage, or refuses the move.

**`replica_stage` was READ and written by nobody**, so every replica sat at `CREATED` forever
and the stage machine was decoration. This is the writer, and it goes through
{@link canTransition} rather than assigning, because the point of the machine is that each
stage is the check that the next one's precondition holds -- an assignment that skips
`VERIFIED` is exactly the bug the stages exist to make impossible.

@returns the stage now in force; unchanged when the transition was refused.

#### `idPartition`

Which slice of the rowid space this object's driver mints from.

The count is {@link ID_PARTITION_LANES} rather than the pool size, because a lane cannot learn
the pool size: `cfw_meta` is replica-local, so the primary's `lanes_provisioned` never reaches
it. `nextLaneId()` is the shared definition of what a slice means.

The primary takes slice 0, and while it did not, a primary minting plain sequential ids walked
through every class a lane had reserved and the forwarded row died on `UNIQUE constraint
failed`. `planForward()` cannot catch that: it is optimistic concurrency on the parent
generation, which is ordering, and says nothing about whether a minted id is free.
Disjointness comes from the arithmetic, and only closes when every writer strides.

Gated on the site HAVING a pool, because ids advance by the stride and a site that never
provisions a lane would pay sparser ids for a partition with nothing to be disjoint from.

#### `purgeAfterApply`

Drops the derived caches a lane holds, once the primary's log has moved it past a generation.

A LANE SERVED A STALE PAGE FOREVER WITHOUT THIS. Only the primary runs `bumpGeneration()`, and a
lane's content arrives as replayed SQL that writes `node_field_data` and leaves the rendered
HTML beside it untouched. `cfw_page` has no generation column and is read by path alone, so
nothing else could have caught it. It stayed masked while provisioned lanes held no pages at
all, because an empty cache cannot be stale.

WHOLESALE, matching what the primary does for every reason but `cachetags`: the log carries
statements rather than the tag set behind them, so a scoped purge has no scope to work from.

A bump carrying no authoritative statement -- `/bump` by hand -- writes only `cfw_meta` and
never reaches a lane. Content saves always carry one.

@returns what each store gave up, for the pull loop to report.

#### `FILL_BINS`

The bins a fill empties on itself.

`dynamic_page_cache` used to be here, on the meter that binds regeneration. Leaving it warm is
**1.4x** on a site whose page table actually fills -- 5 charged rows against 7, byte-identical
output -- and tag invalidation still reaches the warm entry through its checksum. The two
things that DID depend on the purge are handled where they belong: a non-tag bump purges the
bin itself, and `gcDynamicPageCache()` bounds it.

The figure here was 2.37x AND THAT ARM STORED NOTHING. It reported the narrow arm at zero
charged rows, which no working site reaches: `fillOne()` upserts `cfw_page` whenever the
response is cacheable and that insert is the largest write in a fill.
`tests/integration/fill-bins.spec.ts` derives the ratio and asserts the store is non-empty
first, so an arm that measures nothing fails instead of reporting a number.

#### `inlineBudgetMs`

Wall-clock budget a MISS may spend rendering before it gives up on the
visitor and hands the path to the alarm chain.

2 s covers the whole measured first-render range -- 195 ms on minimal, 909 ms
on standard, 1,636 ms observed here on a loaded machine -- and excludes the
3,754 ms cold boot, which cannot be waited out. It bounds the visitor's
patience, not a billed resource: wall time is not charged against the CPU
budget (4 ms of Worker CPU against 827 ms of wall, measured).

`budget` on the query string overrides so the fallback is testable, and 0
disables inline rendering entirely, which restores the always-202 shape.

Paid defaults to 10 s rather than 2 s, which only matters once an interpreter exists: a cold
object refuses on `!this.php` before this number is ever consulted. See `bootInline`.

#### `estimateRenderMs`

What the next render on this instance is expected to cost, in ms.

The budget has to be a PREDICTION, because a render cannot be interrupted once it starts:
`php._run()` is one synchronous call into wasm, so no `setTimeout`, `AbortSignal` or
`Promise.race` can preempt it. A 1 ms timer raced against a 119 ms render lost.

So the decision is taken before the render starts, from what this instance has observed. The
last render is the best predictor available, having met the same kernel state the next one will.

Pessimistic before any evidence exists, because an object hibernates after ~10 s and discards
`this.php`, the mounted tree and the booted kernel -- a cold instance is the common case, and it
must not gamble a visitor's request on a multi-second boot.

#### `neverMigrated`

Whether this site has never been provisioned, so a page request has nothing to render from.

No cursor at all is a different state from a half-finished one, and it was the state a fresh
deploy sat in forever: `migrateStepIfPending()` returns null without a cursor, so the alarm
chain never started, and `/serve` answered `warming` on every request for the life of the
object. Provisioning happened only if somebody called `/migrate` by hand -- which is a
DIAGNOSTIC route, so on the canonical config there was no way to do it at all.

#### `adoptSettings`

Overlays EVERY KV lever override onto this object's env.

`withSettings()` is applied to the FRONT worker's env and the Durable Object receives its own
copy of the bindings, so without this no KV lever reaches a reader inside this class -- and
several are read here and only here.

NO COUNT, deliberately: four places carried one and all four were wrong.
`tests/node/kv-levers-read.spec.ts` asserts the property a count stood in for -- every name on
the list reaches a reader, and no file cites a lever that no longer exists.

Awaited HERE and never in `fetch()`, because the fast storage lane must stay await-free. That is
safe: the fast lane is one indexed `cfw_page` read and consults no lever.

Called from `alarm()` too, which is not optional -- the fill chain reads several of them and an
alarm never passes through `handle()`.

### `src/site/edge-cache.ts`

#### `GEN_BUCKET_MS`

Width of the window the generation pointer is discovered once per, in ms.

The Worker needs the generation to build a cache key, and asking the DO for it every request would
spend a DO request to save one. So the pointer is itself an edge-cache entry whose key contains the
window index: the first request in a window reads the generation off a response it had to fetch
anyway, and every later one reads the pointer for free.

Bucketed rather than left to `max-age` expiry, because Cloudflare applies its own minimum TTLs and
a pointer outliving its window would serve a stale generation indefinitely.

Costs at most one extra DO request per window per colo, independent of traffic. A bump reaches
other colos within two windows; the bumping colo sees it immediately.

#### `asGeneration()`

A generation, or undefined. Never a number that is not one.

`Number(null)` is 0, not NaN, so reading a missing header straight into
Number() produced a perfectly finite generation 0 -- and one request to a route
that does not report a generation was enough to overwrite the pointer with 0 and
make every later edge lookup build a key nothing was ever stored under. Caught
by the integration test, which watched a HIT refuse to become an EDGE hit
whenever a /serve-stats call sat between two serves.

#### `putPage()`

Stores a rendered page at the edge, or says why it did not.

Only a real page is eligible: the guard is `status !== 200`, so the warming placeholder (a 503
with Retry-After) and every other non-200 is refused. Caching a placeholder is how a site serves
placeholders forever.

`cache.put()` rejects several header combinations (206 responses, `Vary: *`, `Set-Cookie` without
a matching `Cache-Control: private=set-cookie`), so the stored copy is built from an explicit
allow-list rather than from whatever the DO sent, and a rejection degrades to "no edge cache"
instead of failing the request.

Every refusal is synchronous and the write is not, so this returns the write rather than awaiting
it: an awaited `cache.put` of a 97 KB body costs 12.5 ms before the response leaves, and the same
put handed to `waitUntil` costs 0. A stored page reports `deferred`, because "it was handed off"
is what this function knows and "it landed" is not.

@returns an x-cfw-edge-put value, and the write to defer when there is one

##### inside putPage(), the authenticated refusal

a structural refusal, not a cookie-pattern check. The shared key has no user in it, so a personalised
response stored under it is served to the next anonymous visitor -- and this project has
shipped exactly that: a render that kept uid 1 landed in the anonymous page cache at 90,038
bytes against 12,296. Two independent signals, because either one alone can be wrong: the
caller says the REQUEST was authenticated, and Set-Cookie says the RESPONSE is per-user.
The header allow-list below would silently drop Set-Cookie, which makes the stored copy look
anonymous while carrying somebody's page, so this refuses before that can happen.

##### inside putPage(), the rejected memo seed

**Seeding the isolate memo from here was tried and reverted.** The memo only ever warms from a
`caches.default` HIT, so the isolate that just produced a page pays one `cache.match` on its
next request for it. Seeding it here removes that read -- ONCE per isolate per page, after
which the memo is warm either way -- and in exchange the EDGE tier stops being observable
within an isolate at all: `serve-edge.spec.ts` polls for `x-cfw-cache: EDGE` and gets `MEM`
forever, because `edge=0` declines the memo and the cache together. A 0.65 ms read taken once
is not worth a tier nobody can see; the three tiers being distinguishable is what that spec
exists for. Do not re-propose without a lever that separates the two.

### `src/site/memos.ts`

#### `laneKey()`

The lane-count pointer, at the edge rather than only in this isolate's memory.

`believedLanes()` is learned from an `x-cfw-lanes` header on a response the isolate has ALREADY
received, so a cold isolate routes its first request to the primary whatever the pool size, and
forgets again after `LANES_TRUST_MS`. Workers spawn isolates continuously, so under real spread
load most requests arrive at an isolate that has never seen the pool -- and after a deploy, none
of them has. Measured on a deployed 32-lane site: the primary's own `serveRequests` counter moved
by 904 across a 904-request drive, so the pool served none of it, and an anonymous drive reported
`answeredBy` as `{primary: 904}`.

Same shape as the generation pointer above and for the same reason: a value every isolate can
read before it decides anything, rather than one each isolate has to rediscover.

#### `LANE_POINTER_TTL_S`

How long the EDGE pointer lives, deliberately far longer than {@link LANES_TRUST_MS}.

The two answer different questions and tying them together collapsed a pool under exactly the
load it exists for. In-isolate belief is short so a SHRUNK pool stops being routed to quickly.
The edge pointer is a hint, and the two ways it can be wrong are not symmetric:

- **stale-high** (the pool shrank): a request hashes to a lane that no longer serves, the lane
  refuses, and the router retries the primary. One wasted hop, on a path that already exists.
- **stale-absent** (the pointer expired): every cold isolate believes there is no pool at all and
  sends everything to the primary, which is the whole pool lost.

Measured 2026-09-19: a 32-lane site answered 294 requests with **zero** served by lanes while all
sampled lanes were `SERVING` and a manual request routed to `r30`. Under saturation the primary
sheds, a shed answer carried no `x-cfw-lanes`, so nothing refreshed the pointer inside 60 s, and
the pool went invisible precisely when it was needed. The shed path now carries the header too,
which is the other half of this fix.

#### the authenticated-allowance region

Same trick as the generation pointer, and for the same reason: the Worker has to know how much of
the authenticated allowance is gone BEFORE it decides whether to hop to the object, and asking the
object would spend the DO request the reservation exists to protect. So the object reports the
counter on the response to a hop that was happening anyway, and this memoises it per UTC day --
the day the quotas actually reset on.

Once the memo says the allowance is spent, every later authenticated request degrades at the edge
with ZERO DO cost. That is the only version of this that protects the meter rather than measuring it.

### `src/site/routes.ts`

#### `PUBLIC_ROUTES`

```
/**
 * Routes reachable without diagnostics and without a credential.
 *
 * `/firstrun` is here because provisioning is TRUST-ON-FIRST-USE, and the alternative was worse.
 * The owner token is minted by that run and is the credential `/export` takes, so while `/firstrun`
 * was diagnostic-gated the only way to obtain it was to first expose `/sql`, `/restore` and `/php`
 * to the internet -- which made "a customer can leave" reachable only by opening a remote shell.
 *
 * The claim window is the UNPROVISIONED state and nothing else. Once `first_run_at` is set the
 * object answers 409, and `?force=1` (which resets the admin password) requires the owner token or
 * diagnostics -- enforced in the Durable Object, where the secret actually lives.
 *
 * `/setup/cf/callback` is PUBLIC because it cannot be anything else: it arrives as a redirect from
 * Cloudflare's consent screen carrying no header drupflare controls. The `state` parameter is what
 * authenticates it, matched constant-time against the pending record in the object. `/oidc` is
 * public for the same reason, and a `__`-prefixed path could not have served it.
 */
```

#### OWNER_ROUTES inline comments

```
	// what the object is actually doing: cached paths, queue depth, recycles, and the day's row and
	// request spend. Diagnostic-only meant a site owner could not read their own meters without the
	// flag that also opens `/sql`, which is the same trade `/export` was on
	'/serve-stats',
	'/setup/cf',
	'/setup/mail',
	'/setup/oidc',
	'/git',
	// EXTENSIBILITY, and it was half-delivered. `/git` could put a module's files on a site and
	// `/installable` could say whether a package was installable, and there was no route that
	// installed one and no route that turned one on -- `installPackage()` had no caller anywhere and
	// `/enable` was diagnostic-only. Both take the owner token because both execute code the site
	// did not ship with
	'/installable',
	'/install',
	'/enable',
	// SITE MAINTENANCE, which an owner could not perform on their own site. Clearing a cache,
	// re-running a migration and forcing a fill were reachable only with `PW_DIAGNOSTICS=1`, so the
	// supported way to purge your own page cache was to expose `/sql` to the internet first. An owner
	// token is the narrower credential: it is per site, where the flag is per deployment
	'/armfill',
	'/invalidate',
	'/bump',
	'/migrate',
	// the update chain the object already runs on its alarm, which nothing could drive or read.
	// `site-do.ts` refused a sliced `updb` operation by naming "/updb" as its driver while no such
	// route existed anywhere, which is a 501 pointing at a door that is not there
	'/updb',
	// The operation registry itself. It was diagnostic-only, so an owner token answered 404 and the
	// only reader was the Commands page reaching `/__ops` internally -- which meant `drangler`
	// could not list what a site can run without turning on the flag that also opens `/sql`.
	'/ops',
	// RECOVERY, and ONLY the half that does not take a payload. `/pitr` reads the platform's own
	// 30-day bookmark window and schedules a restore from it; its docblock says there is no
	// wrangler command and no dashboard button for that window, so without an owner-reachable
	// route an operator cannot recover a site at all.
	//
	// **`/restore` STAYS DIAGNOSTIC-ONLY and was promoted here for one commit before this comment
	// replaced it.** It replays SQL a caller supplies, which is the same shape as `/sql` rather
	// than the same shape as `/pitr`: a bookmark names a state the platform already holds, a body
	// names one the caller invents. `serve-edge.spec.ts` pins the pair and was right to.
	'/pitr',
	// FLEET RECONCILIATION. The pack delivers only at provisioning, so a fix that lands in it reaches
	// new sites and no existing one. This reports what a site still owes and drives one step of it
	'/reconcile',
	// The addressable sweep. Coverage was demand-driven, so nothing knew how much of a site was
	// covered and nothing bounded what an indexer could make it spend
	'/sweep',
	// The fill queue, and it is a RECOVERY route rather than a diagnostic one. A queue deeper than
	// a batch can survive resets the isolate inside the alarm, which leaves the queue at its old
	// depth and the next alarm attempting the same batch: measured on a deployed free worker at 103
	// entries, every render answering 500 across three redeploys. `recycleIfOversized()` cannot
	// reach it because it runs between invocations and the death is inside one. Draining the queue
	// is the only lever an operator has, and until now there was none
	'/queue',
	// Uploaded module revisions. `/git` delivers a tree from a git host and `/install` delivers one
	// from a registry; there was no way to deliver a tree that is on a developer's disk, and no
	// history behind either -- `gitRestore()` restores within the same call and then the previous
	// state is gone
	'/modify',
	// The runtime levers, which were readable from KV and writable by nobody. `resolvePlan()` and
	// `resolveSettings()` have read the `plan` and `settings` keys since they shipped, and nothing
	// in `src/` ever called `CONFIG_KV.put()` -- so changing a lever meant editing `wrangler.jsonc`
	// and redeploying, which is a deploy to change a fact the deploy does not control. Owner rather
	// than diagnostic for the reason `/serve-stats` is: a site owner tuning their own site should
	// not need the flag that also opens `/sql`
	'/settings',
	// Which site this deployment serves on a host with no mapping. Answered in the Worker, beside
	// `/settings`, because the document lives in CONFIG_KV
	'/deployment',
	// The product surfaces, and they are the one part of this set that `PW_DIAGNOSTICS` does NOT
	// also reach. They used to sit in the diagnostic set alone, so the pages that install code were
	// open to anybody who could reach a worker with the flag on, and each button's
	// `window.prompt('Owner token')` was accepted without being checked against anything
	...ADMIN_PAGES.map((p) => p.path)
```

### `src/vendor.d.ts`

#### '*.mjs'

The emscripten glue a `vendor/` or `assets/` build ships next to its `.wasm`.

Declared because both directories are gitignored: on a machine that has never run
`bun run vendor` -- CI, or this repo with four of the probe builds never rebuilt -- the
specifier resolves to nothing and every importer fails to typecheck. The shape is the one
emscripten emits for MODULARIZE=1, and it is what `PhpBase` calls.

**Matches every `.mjs`, not just `*-worker.mjs`.** The narrower pattern was green locally and
failed CI on three files it did not cover -- `vendor/php8.3-web.mjs` and the two
`assets/sjlj/*sjlj.mjs` -- which broke `typecheck` AND `docs:build`, because typedoc resolves the
same specifiers. Every `.mjs` imported anywhere in `src/` is emscripten glue of this shape, so
the wildcard is accurate rather than a blanket `any`.

