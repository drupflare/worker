# Memory, isolates and the interpreter lifecycle

Linear memory, the isolate budget, boots, recycling, heap images and what the platform charges. Moved verbatim from the project CLAUDE.md.

## THE COST OF LOADING EXTENSIONS IS AN EXPORTED GLOBAL, NOT A GROWABLE TABLE

Measured 2026-09-17, n=9 interleaved rounds per arm over `abi-speed.ts`'s `CASES`, every arm carrying
a self-control that never read above 0.78%.

A long64 rebuild carrying `-sALLOW_TABLE_GROWTH=1` and `-Wl,--export=__stack_pointer` measured
**+8.29% and +7.90%** against the shipping binary. Isolating the two by post-link edit:

| arm                              | table    | `__stack_pointer` | vs shipping |
| -------------------------------- | -------- | ----------------- | ----------: |
| bounded at 8192                  | max 8192 | exported          |      +8.14% |
| restored to `max == min`         | fixed    | exported          |      +7.66% |
| glue swapped, wasm held constant | --       | --                |      -0.60% |
| **both neutralised**             | fixed    | **removed**       |  **-0.20%** |

**The export is the whole cost; the growable table is free.** Exporting a mutable global stops the
linker proving it module-private. `usercall` reads +13.6% and `preg` +1.1%, which is the gradient
that predicts -- and which I first read as evidence for the table, because the table is what I had
changed.

**THREE WRONG ATTRIBUTIONS PRECEDED IT, each from reading the diff rather than isolating a
variable**: it is the table, a bounded max will fix it, the glue differs by 99 bytes (it differs in
378,810). The first isolation test was the fourth one run. When a change has two parts, measure each
alone BEFORE building variants of either.

**It does not contradict burrow's 1.1-1.4%; it prices a different delta.** Their arms were
`MAIN_MODULE=0 + --export-dynamic` against the same plus table growth, so their baseline already
exported everything and could only measure the table. This binary exports 4,178 symbols and
`__stack_pointer` is not among them. Two correct numbers from two baselines.

**And only the HOST path needs it.** Built with the local emcc: a leaf side module imports nothing;
one with a 256-byte local imports `env.__stack_pointer` as `(mut i32)`. burrow's `dylink.ts`
synthesises that value for a standalone library and deliberately does not with a host, where it
would aim into PHP's heap. So a sandboxed user-supplied library costs nothing and an in-process PHP
extension costs ~8%.

**Importing it instead costs 3.4%, measured 2026-09-25.** phasm's `src/import-stack-pointer.mjs`
moves the linker's first defined global to the last `env` import, which keeps every global index,
so the arm (`spimport` in `abi-speed.ts`) is `long64` plus that edit and an unbounded table and
nothing else. Interleaved, n=9: **1.034x blended** against an A/A of 1.000x, `usercall` 1.044x,
against the export arm's 1.083x and 1.136x. Cheaper, not free. `long64.rc` carries
`STACK_POINTER=import` now instead of the 8% `TABLE_GROWTH=1`. Linking a real side module against
the imported global is still unrun, so do that before a release relies on loading one.

## `subarray` THROWS ABOVE 128 MiB ON THE PLATFORM, AND A LOCAL WORKERD DOES NOT

Measured 2026-09-29 on a deployed Durable Object. Once a wasm memory has grown past 128 MiB,
`TypedArray.prototype.subarray` throws `RangeError: Invalid array buffer length` for any begin
BYTE offset from 2^27 (134,217,728) up. Only that method does: `new Uint8Array(buffer, offset,
length)`, `slice`, `set`, `copyWithin`, `fill` and `DataView` work at the same offsets on the same
buffer. The threshold is on the byte offset, so a wide view (`Int32Array`, `Float64Array`) hits it at
a smaller element index.

Emscripten decodes every string longer than 16 bytes with `HEAPU8.subarray`, so a PHP string that
lived above 128 MiB failed a host call and the request answered a 1101. It needed the heap to have
grown past 128 MiB and a string to sit in the top of it, which is why about half of the live drives
failed and the other half read clean on the same tree. Two greens (p3, p5) were two draws.

`safeHeapSubarray()` in `scripts/measure/growth-glue.ts` gives every heap view its own `subarray`
that calls the native one below 2^27 bytes and builds `new View(buffer, offset, length)` above it.
It is installed inside `updateMemoryViews()`, so every rebuild after a grow gets it. It costs about
0.03 microseconds per call below the limit and nothing above it (node, 2M calls).

**A green local lane proves nothing about this.** `wrangler dev` and the vitest pool do not enforce
it, and `growth-glue.spec.ts` emulates the platform with a view whose native `subarray` throws at
the same offset. To retest the platform: `scripts/e2e/subarray-probe` is a 40-line Durable Object
that grows a memory to 2,362 pages and tries each operation at offsets around 2^27; deploy it as a
`cfw-e2e-*` worker, read `/?pages=2362`, tear it down. `new Function` is refused on the platform
(the probe answers 1101), so a probe cannot build its subject from a string.

The fix lives in the generated tuned glue. A fresh clone gets it from `restore-artifacts`; a tree
filled by `bun run hydrate` does not until the release payload is rebuilt and republished. The glue
also records failed growths and failed decodes on `globalThis.__cfwGrow` and `__cfwSub`, and
`/serve-stats` reports them with any RangeError a handler caught (`rangeErrors`, `growth`,
`decodeFailures`), each with its stack.

## A DROPPED INTERPRETER'S MEMORY IS REUSED, NOT COLLECTED

A dropped `WebAssembly.Memory` stays alive until V8 runs a FULL collection, and nothing an object does
forces one. The next boot used to allocate a second heap beside it and reset the object for memory: on
a deployed farmOS every reset after a drop (the post-claim login, `/admin/content` after a recycle)
found the old 93-113 MB heap still alive. Measured 2026-09-29, paid `cfw-e2e-farmos`.

**The interpreter is built with an imported memory now, and a boot after a drop instantiates into the
dropped one after zeroing it** (`withImportedMemory()` in `scripts/measure/initial-memory.ts`, applied by
`emitTunedWasm()`, so the CDN wasm is unchanged; the one-slot `WeakRef` and `newInterpreterMemory()` in
`src/site-do.ts`). An isolate never holds two heaps for a drop. `oversized()` counts growth since the
boot, because a reused memory starts large and a drop cannot shrink it; without that it recycled on
every invocation. Interleaved speed against the defined-memory binary: 0.984 and 0.995 (A/A 0.998).
`/serve-stats` reports `heapsReused` and `spareMemoryBytes`.

**The pressure-buffer trick it replaced was watching the wrong object.** `collectByPressure()` allocated
48 MiB to provoke a collection and read success off a `WeakRef` to the small `{php, binary, out}`
wrapper. The wrapper dies in a scavenge while the heap needs a full collection, so it reported `freed`
with the heap resident, and 3 of 4 boots after a drop found the heap alive; the untouched buffer also
counted in full toward the object. Hold a `WeakRef` on the memory itself when the question is memory.
The earlier probe (`scripts/e2e/gc-probe`) was right that a 36 MiB+ buffer CAN trigger a collection;
it did not show that it reliably does.

## A DEPLOYED MEMORY IS CHARGED AT ITS FULL SIZE, touched or not

Measured 2026-09-30 on deployed farmOS, one fresh isolate per arm: an untouched 80 MiB
`WebAssembly.Memory` added 84 MB to the platform reading, and instantiating the interpreter against it
added 1-4 MB more, so compiled code is not charged up front. `/php` (PHP started, site mounted) cost
112-125 MB over the isolate's own baseline, and a render only ~7 MB on top. A fresh isolate therefore
paid for the unused tail of the start size, and a render needs 67-71 MB, so the binary starts at 64 MiB
(1,024 pages, `INITIAL_PAGES` and `INTERPRETER_MEMORY.initial` together): 13-17 MB less per fresh
isolate, same boot CPU, and farmOS's reset spiral stopped (lane 10/13 -> 13/13, 0 resets).

**The per-isolate instrument is `durableObjectsPeriodicGroups` grouped by `datetime`**: a row starts
when an isolate starts and then one per minute, so an arm reads per isolate rather than per namespace
minute. Request 78 s after a redeploy so the isolate's first row is its own baseline, which varied
13-42 MB by placement alone. Co-tenancy was checked with an isolate nonce and a served-object map and
did not occur (one object per isolate, 39 isolates).

## A MEMORY RESET IS `overloaded`, NOT `retryable`, and a write before an await survives it

Read off a deployed probe (`cfw-e2e-resetprobe`, n=8, 2026-09-30): a Durable Object reset for memory
reaches the caller's `stub.fetch()` as an error with `overloaded: true` and `durableObjectReset: true` and
no `retryable`. The same stub then fails at once; a new stub answers in ~54 ms. `resetRecovery()` in
`src/site.ts` required `retryable` and refused anything `overloaded`, so every GET that met a memory reset
got the Try Again page instead of its one retry. It keys on `durableObjectReset` now
(`serve-edge.spec.ts` uses the measured shape).

**A POST is repeated only when the object never started it**, and the reason the rest are not is measured:
a write the object makes before it awaits I/O is committed when the reset lands, and a record written just
before a PHP run survived the memory kill of that same request. Thunder's claim reset after committing and
its retry answered 409, the half-applied shape a retried save produces. So the front worker mints an attempt
id (`src/ops/attempt.ts`, stripped from client input) and the serve route records it before PHP runs; a
repeat that finds the record is refused. Writes commit in order and the output gate holds subrequests, so no
record means nothing landed. Cost: about one row per POST, kept 10 minutes. On deployed farmOS the one
repeat that fired was correctly refused: that Run cron had reached `update_cron()`.

**After a "Network connection lost" reset the object was unreachable for ~10 s**, and every immediate retry
failed. And start a corpus lane ~60 s after `corpus-deploy.ts`: a package install that lands in the first
minute meets "Durable Object reset because its code was updated" and the lane is invalid.

## A LARGE SITE'S FRESH ISOLATE HAS ALMOST NO ROOM, and placement decides who survives

Measured 2026-09-30 on deployed farmOS: an idle isolate holding a booted interpreter read ~187 MB for four
minutes against resets at ~200-217 MB. Boot plus nine admin pages on fresh isolates finished at 184.0 and
189.6 MB or died at 216-236 MB (n=4) with identical linear memory and JS counters; the one dying isolate
with a baseline read 40.4 MB before any PHP against 13.9 for a survivor. A page costs the same young or warm
(+8-11 MB linear for structure, people, config, modules). Each successor of a reset isolate pays its own
boot (nothing is carried: reuse 0, recycles 0), so a busy admin session can reset isolate after isolate.
The demo's one remaining failure was Run cron on an isolate under ~40 s old, dying inside `update_cron()`.
That was read as a memory limit and it was a re-fetch: see the next section.

## AN INSTALLED MODULE'S FILES CARRIED THE BOOT TIME, so every young isolate re-fetched update data

`mountInstalledModules()` created each node with `FS.create()` and never set its timestamp, so every file
of every installed module reported the isolate's boot as its ctime and mtime. The update module compares
each project's `.info.yml` ctime against its `last_fetch`, so a project list rebuilt on a young isolate
marked every installed project pending, and `update_get_available(TRUE)` drained the fetch queue: release
XML for every contrib project, parked, parsed into arrays, for up to `fetch.timeout` (30 s). On farmOS
that was the 20-25 MB, and it was why only young isolates died. The node now carries the row's
`installed_at`; `modify-upload.spec.ts` failed first (ctime read the boot, 1790769651). Deployed farmOS on
the fix: demo 3 of 3 clean, 117 requests, 0 failed, 0 retries, 0 object exceptions, against 1 of 3 before.
Packed files were never affected, since the lazy mount copies the packer's mtime. The same stamp also moved
the compiled Twig directory names of installed templates, which hash `filemtime()`, so each young isolate
recompiled them. **A stat a module reads is part of its input**: check what a file reports before
attributing a young-isolate cost to memory.

## THE PACK BLOB IN SQLITE WAS BUILT, MEASURED AND REMOVED

The lazy mount holds the whole compressed pack (12,185,657 bytes) in the isolate for its life. On
2026-09-30 it was moved into the object's SQLite (64 KiB rows, one `substr` query per member on first
open; `/serve-stats` read `mount: 0` on a deploy) and taken out again the same day, because it did not
move Thunder's memory resets: three paired deploys per arm, run at the same time, read 29 reset retries
with the store and 9 without, per-deploy spread 0-19. It cost ~12 MB of storage per object, and each read
copies the member out of SQLite where the resident blob hands out a view. cartridge shipped the
`LayerSpec.store` option it needed in v0.3.0 and removed it in v0.3.1. Do not re-propose it for headroom
without a new mechanism and a paired measurement.

## BACKGROUND PHP WAITS A MINUTE AFTER A BOOT, and `wrangler tail` blames the alarm for the visitor

Measured 2026-09-30 on deployed farmOS: every memory reset in a demo drive was on an isolate 0-10 s after
a fresh boot with alarm PHP running, typically the fill re-rendering ten pages 3-5 s in. `FILL_SETTLE_MS`
(default 60,000) holds the alarm's fill batch, cron, reconcile steps and fill window while the interpreter
is younger than that; queue rows stay and the alarm re-arms for the end of the hold, so nothing is
dropped. `/serve-stats` reports `fillHold`. Paired arms, one drive each: control failed a POST in 3 of 3
drives with 77 fill pages rendered during them, the hold 1 of 3 with 9. The test pool binds it to `0`
(`vitest.config.ts`) because ~20 alarm specs fill straight after a boot; the shipping default is not off.

**The hold is on PHP, and it once held the mail too.** A held reconcile step returned out of the alarm and
re-armed for the end of the hold, so the HTTP and mail drains below it did not run: every password reset on
a young isolate waited ~60 s, measured at 62.8 s from queue to send, and the e2e mail lane's 45 s deadline
went red. A held step now lets the firing continue to the drains; `interpreter-recycle.spec.ts` asserts the
mail leaves on the held firing and fails with the old early return.

**A request waiting on the object's gate is charged to the alarm it queued behind** in `wrangler tail`:
its CPU and its logs appear on the ALARM event. So a 1.3-2.8 s ALARM row on a fresh isolate is usually a
visitor's boot, not background work. Read the request's own row before blaming the alarm.

## A CLAIM IS THREE INVOCATIONS, because a CPU kill rolls back everything in one

Measured 2026-09-30 on a deployed Thunder, each stage as its own invocation: cold boot 5.1 s, plugin
discovery 6.2 s, container compile 3.2 s, router 1.9 s, the uid-1 save 2.0 s (bcrypt alone). No stage passed
~7 s; together they passed the 30 s default, and a killed invocation commits nothing, so every retry reinstalled
the same two modules from scratch. The front worker sends `/__firstrun?phase=warm` (fills discovery, installs
nothing), then `phase=consistency` (the driver and `drupflare` install), then the claim: 7.1 / 10.0 / 3.3 s.
Two phases were not enough, since the install alone read over 32.5 s cold. **Only a migrated site splits**: a site still on a
module set the pack baked (its `core.extension` fingerprint matches a `container.json` variant) answers
both phases at once, because splitting a stock claim took it from 5.5-8.4 s of CPU to ~25 s (three paired
deploys) and the skip brought it back to 9.1 s in one invocation. The SQL bridge moved 44 MB in and
7 MB out and is not the lever. Before raising `cpu_ms` for anything, check whether the work splits at a
commit boundary.

**The one-invocation stock claim has about 3x headroom, and a slow host used all of it.** Live Deploy
on free, same tree and same SQL traffic to within 1%: claims of 7.45 and 9.75 s CPU passed, and one
of 19.3 s CPU / 36.9 s wall ended `exceededWallTime` (run 36764623205, 2026-09-30). That host ran
EVERY invocation ~2.7x slower, the cold `/` render included (9.5 s against 3.4), so it was placement
and not the claim. A killed claim leaves `first_run_at` unset, so the retry the reset page asks for
is safe. Read the cold render's CPU beside the claim's before calling a red claim a regression.

In Drupal 11.4 the multi-module branch of `ModuleInstaller::install()` calls `resetContainer()`, which drops
instantiated services and does not recompile, so installing two modules in one call costs one compile.

## The heap image is a COST on both meters, so the producer is off by default

Measured 2026-09-09 on two deployed free workers differing only in `HEAP_IMAGE` and `HEAP_SNAPSHOT`,
`cpuTime` on the cold render, nothing asked of the object during the idle:

| arm      | cpuTime (ms)                 |   n | median    |
| -------- | ---------------------------- | --: | --------- |
| imaged   | 2020, 1908, 1937, 1561, 1912 |   5 | **1,912** |
| no image | 1277, 1343, 1113, 1251       |   4 | **1,264** |

The ranges do not overlap: the imaged minimum 1,561 is above the unimaged maximum 1,343. **A restore
costs about 648 ms MORE than booting from scratch**, and it also costs ~8 MB a site against an
account-wide 5 GB cap. A cost on both meters and no benefit on either, so `HEAP_IMAGE` defaults off.

It agrees in direction with the local `/bootphase` reading of 0.962 and separates far more cleanly.
**It is NOT `digestBytes`,** which this paragraph named for two weeks without a reading behind it.
The digest walks words, not bytes, and verifying a 37,158,912-byte image costs 13-16 ms whole and
19-20 ms as 200 KB chunks on a laptop's V8 (`node scripts/measure/heap-digest-cost.ts`), about 3% of
the gap.

**ATTRIBUTED 2026-09-25: the row count and the inflate, and removing both buys nothing.** Four paid
workers at the same instants, fully cold (`SITE_WARM=0`, `RETAIN_INTERPRETER=0`), an 11,206,656-byte
elided image, n=12 per arm, visitor wall p50 and object cpuTime p50 (the largest invocation in each
visit minute):

| arm                         | rows | wall     | cpu      |
| --------------------------- | ---: | -------- | -------- |
| no image                    |   -- | 2,303 ms | 1,704 ms |
| 200 KB deflated (the codec) |   57 | 2,918    | 1,981    |
| 2 MB deflated               |    6 | 2,550    | 1,823    |
| 2 MB raw                    |    6 | 2,345    | 1,639    |

So ~160 ms of CPU is the small rows and ~180 ms the inflate, and raw 2 MB rows restore at no cost.
But the image only replaces the kernel boot, which is about what reading it costs, so no arm beats
booting. `DEFAULT_CHUNK_BYTES` was sized for a 10 ms-per-invocation cap a Durable Object does not
have. Arms were shadow trees; the codec is unchanged. gmux restores a 64 MiB machine in 112 ms the
same way, which is what prompted the re-measure.

**A WARM image is worse, which closes the last shape.** Taken with `/heap?op=snapshot` right after a
render, at 94.8 MB linear: 810 kept pages, 53.1 MB in 27 raw rows, restored on 12 of 12 cold visits
after growing the fresh heap through `_malloc`. Wall p50 2,366 ms against 1,412 booting from the pack
at the same instants, object cpuTime 1,603 against 1,015. Reading and writing 53 MB costs more than
the boot and compile it replaces. **So no image shape beats a boot here**, and the cold number moves
only by frequency: warming and retention.

**AND THE EARLIER RUN THAT MEASURED A SAVING WAS RIGHT ABOUT A DIFFERENT IMAGE.** It read a cold
serve at 904 ms with an image against 1,218.5 without, a 314.5 ms saving, on a **9,699,328-byte**
image. The 2026-09-09 arms restored **37,158,912** bytes. Both are in the report's storage table:
9,699,328 over 148 pages for a configured-and-served object, 36,175,872 over 552 for a cold one.
`snapshotStep()` fires on an alarm with no resident interpreter and requires neither configuration nor
a prior serve, so on a fresh site it captures the COLD shape. The producer takes the expensive image on
the path that matters, which is what closes it. Reconcile a contradicting measurement; do not
overwrite it.

**AND MY FIRST ATTEMPT AT THIS MEASURED NOTHING, because the instrument warmed what it read.** The
driver polled `/heap` and `/serve-stats` before every sample to prove the arms were distinct.
`/heap` reads linear memory and costs **808-1052 ms of cpuTime**, so the poll kept the object
resident and every "cold" reading was warm: the arms came back flat and `restored: true` on both.
Distinctness has to come from the CONFIG, established once, with nothing asked of the object between
samples.

**Do not optimise this mechanism; it is closed.** `HEAP_IMAGE=1` opts back in and the chunk codec
survives behind it, so a workload that turns out to want an image does not have to rebuild one.

## The cold-boot number to move is the FREQUENCY, not the milliseconds

1,264 ms is the floor for an object `src/ops/thermal.ts` decided NOT to keep warm, which is what
`SITE_WARM=0` forces. In production the hot-set policy already exists and already carries the
asymmetry that matters: `AUTH_WARM_WINDOW_MS` keeps an object resident while a session is active,
because the render rate is a property of ANONYMOUS traffic and an editor on a quiet site sits below
the crossing while producing exactly the requests a cold boot hurts.

So the metric worth reporting is the share of user-visible requests that meet a cold boot, not the
cost of one. A proposal to make the boot faster has to be scored against that share first.

**Re-measured 2026-09-25 as the visitor sees it**, a paid throwaway with `SITE_WARM=0` and
`RETAIN_INTERPRETER=0`, one fully cold first render per minute: wall p50 **1,285 ms**, p95 2,696
(n=10), object cpuTime p90 ~865-959 ms per cold minute. The mount is not where it goes: `bootMs`
read 86-108 and `fetchMs` 31-71. A warm render is 180-220 ms, and waking an object without booting
PHP is ~310 ms against ~150 warm. So the 500 / 700 ms target is not met for a fully cold isolate,
and retention plus warming remain what keeps visitors off that path. **The target is settled by
warming, decided 2026-09-25**: an 8 s re-arm is the default on paid sites, managed and self-managed,
and a free site leaves it to the thermal policy with 30 s and 8 s available on `/settings`. Do not
reopen it by trying to make the fully cold boot faster; every lever measured for that is recorded
below and none beat a boot.

**PAST HIBERNATION THE WARMING CURVE HAS ONE KNEE, AT 30 s, and I shipped the wrong point for an
afternoon.** Past 10 s the object hibernates, and the next instance adopts the retained interpreter
only when it lands in the same isolate. The first curve (3 workers, 16:00-17:10 UTC 2026-09-25) read
30-120 s adopting 27 of 28 and became `ADOPTABLE_REARM_MS = 120_000`. Eighteen workers at the same
instants over the next two hours read nothing ordered across 120-600 s, twins at 8 of 8 and 0 of 8,
and the account at 0 of 60 from 19:00. A Latin square then settled it: 12 workers, four phases, every
worker at every interval, 288 visits. 30 s adopted 36% and 60/90/120 s 14-15%; four workers never
adopted at any interval, and on the other eight 30 s read 54% against 21-23%. `/serve-stats` read
seconds after each visit showed `retention.last: null` on every miss, which `adoptRetained()` leaves
only when no interpreter exists in the isolate, so placement refused and the code never did. The
declined re-arm is back at `KEEP_WARM_MS` (240 s), the cheapest point; 30 s is the opt-in middle
(`SITE_WARM=1`, `WARM_INTERVAL_MS=30000`, $0.099/site-month, 2.9% of free). **Three traps from it**:
a curve on a few workers in one hour measures their hosts and that hour; an A/B whose arms both read
0 during a churn phase separates nothing, so read the refusal reason; and without rotation the
interval that happens to land on the good hosts wins, which 30 s did for three phases before reading
0 of 18 on the dead ones. An unset `SITE_WARM` warms a paid site at 8 s and leaves a free one to the
thermal policy; `SITE_WARM` and `WARM_INTERVAL_MS` are both on `/settings`.
Deterministic residency cannot be made much cheaper: the solver's 9.5 s ceiling saves 16%, and holding
an object open by other means is billed as duration.

**`PhpDumper` IS NOT A DRUPAL 11.4 FEATURE, checked 2026-09-09 against the shipping tree.** A
compiled-PHP service container through OPcache is a credible-sounding lever and core does not offer
it: `DrupalKernel::$phpArrayDumperClass` is `OptimizedPhpArrayDumper`, `getArray()` is what runs, and
the result is cached as a PHP ARRAY in `cache_container` (`DrupalKernel.php:66,1046,1632`). There is
no `Dumper/` directory under `Core/DependencyInjection/` and no `PhpDumper` reference in core;
Symfony's own `PhpDumper.php` sits in vendor because it ships with `symfony/dependency-injection`.
Overriding the property plus a `PhpStorage` write is real work, and "benefits from OPcache" needs
OPcache on, which is loaded-and-disabled here by default.

## The heap peak is per WORKLOAD; the isolate is charged per INCARNATION

`USE_ZEND_ALLOC=0` means PHP returns nothing between requests, so demand inside one incarnation is
the SUM of what it has done and the growth step rounds every rise up.

**THE FIGURES BELOW WERE TAKEN ON A BINARY THAT IS NO LONGER SHIPPED, and the conclusion drawn from
them is now an open question rather than a fact.** Measured on one object: 96.00 MiB booted,
**108.50 after migrate + firstrun, 122.63 after the first authenticated render, 138.63 after the
second** -- 10.63 MiB past the 128 MiB isolate limit, which made provisioning a site and then
viewing two pages over the ceiling BY CONSTRUCTION on the first-run path of every new site. On the
edge that reads as `Durable Object's isolate exceeded its memory limit and was reset`, with a
cascade of `Internal error in Durable Object storage caused object to be reset` behind it.

That run used a 96 MiB-initial binary. Parsed from the Memory section of each `.wasm`, the shipping
`php8.5.tuned.wasm` declares **1,280 pages = 80.00 MiB** where `php8.5.wasm` and
`php8.5-long64.wasm` declare 1,536 = 96.00 MiB. Re-measured 2026-09-14 on the shipping binary with
`bun scripts/measure/growth-ladder.ts 0.05 0`, driving the same three workloads:

| workload                    | demand (step 0) | peak at the shipping 0.05 |
| --------------------------- | --------------- | ------------------------- |
| boot idle                   | 83,886,080      | 83,886,080 (80.00 MiB)    |
| migrate + two renders       | 90,898,432      | 92,536,832 (88.25 MiB)    |
| migrate + firstrun + render | 91,815,936      | 92,536,832 (88.25 MiB)    |
| two authenticated renders   | 96,993,280      | 97,189,888 (92.69 MiB)    |

**Worst case 92.69 MiB for those three workloads, and it is not the worst page.** Re-read
2026-09-24 through `isolateBytes`: an authenticated `/admin/content` takes linear memory to
107,216,896 and the whole isolate to 125,387,248, 93.4% of the ceiling, flat across three more pages.

**THE BREACH STILL EXISTS ON THE SHIPPING BINARY, and the drops are what prevent it.** With the
`/__migrate` and `/__firstrun` drops commented out for the control arm, the provisioned incarnation
sits at 107,216,896 and the first authenticated render grows linear memory to 136,970,240, past the
ceiling before the JS half is counted. The test pool does not enforce the limit, so the run survived
and `recycleIfOversized()` dropped it; on the edge that invocation is the reset. Keep the drops.

Every figure in `TECHNICAL_REPORT.md`'s Memory section is a single-workload peak, and each one is
correct. None of them is what the isolate meters.

**CRON WAS THE FIRST HYPOTHESIS AND IT WAS WRONG.** Both resets landed on an alarm whose logs were
full of the update module's deferred fetches, which reads as a cause. A sweep of 16 firings moves
linear memory by nothing at all. `tests/integration/interpreter-recycle.spec.ts` keeps that control
so the next reader does not re-derive the same wrong answer from the same suggestive stack.

**THE FIX IS AT PROVISIONING, AND THE CEILING VERSION WAS BUILT FIRST AND WAS NOT ENOUGH.** A drop
keyed on linear memory runs BETWEEN invocations; on a deployed paid worker the reset happened INSIDE
one -- the first authenticated `/admin/content` on each of four freshly provisioned sites went from
the install's 108.50 straight past the limit in a single render, 4,661-4,936 ms of cpuTime, exception
with no message and no stack. `/__migrate` and `/__firstrun` now drop the interpreter when they
finish, the way `/__enable` always has, so the serving incarnation starts at `INITIAL_MEMORY` and the
peak over four authenticated pages is 108.50, flat.

`recycleIfOversized()` remains the backstop for everything else, dropping at the end of an invocation
above `RECYCLE_ABOVE_BYTES` (112 MiB). It must run BETWEEN invocations: linear memory is reclaimed
only when the old module is collected, so dropping mid-request holds both allocations at once.
`/serve-stats` reports `recycles` and `lastRecycle` -- an object recycling on every request is paying
a boot per page.

**A FILL BATCH IS N WORKLOADS INSIDE ONE INVOCATION, so that drop cannot reach it.** The batch was
bounded by page count alone; the wall-clock guard cannot bind because the clock does not advance
across a synchronous `php._run()`. On paid at `fillBatchSize` 25 this reset all four freshly
provisioned sites -- cpuTime 2,213-4,944 ms, exception with NO message and NO stack, then the storage
cascade on every route. The batch reads `oversized()` and ends early, which hands the drop to the
recycle at the bottom of the alarm. A message-less exception at high CPU is what this looks like;
the memory-limit text only appears when the limit is crossed between invocations rather than inside
one.

The supervisor had detected this since it shipped. `memory.trend_rising` fires with the text
"recycle at the next quiet moment", `warn` findings are recorded in the ledger, and **nothing ever
acted on one**. Detection wired to no act is the same family as tested-but-never-called.

## A Durable Object hibernates at 10 s, and `KEEP_WARM_MS` is 24x that

Measured on a throwaway deploy, an object minting an id in its constructor and holding a 32 MB
allocation: re-armed every **8 s** one incarnation survived **71 consecutive alarms**; at 12, 20, 30
and 45 s the constructor ran again on every probe; with no alarm the id changed across a 20 s gap.

So `KEEP_WARM_MS = 240_000` re-arms an idle alarm and keeps nothing warm. Two places had recorded the
wider claim that an armed alarm "buys no warmth" as a general fact -- correct at 240 s, false at 8 s,
because the FIRING resets the idle clock. Arming does not warm; firing under the threshold does.

**Duration is not the meter.** An object waiting on an armed alarm is idle and ELIGIBLE to hibernate,
and an idle-eligible object is not billed for duration. Warming spends requests and rows, one of each
per firing, which is 10,800/day. What it removes is the 1,398 ms boot from pages that render; a
cached page answers off `ctx.storage.sql` without booting PHP, so warming cannot make one faster by
any amount.

**`SITE_WARM` IS ON BY DEFAULT, and this file said off until 2026-08-30.** `siteWarmEnabled()`
returns true when the var is unset and there is no plan branch in it. Observed on the current tree: an
object with an armed alarm re-arms every 8 s, climbed to 33 firings, stayed warm through every 25 s
gap and served at 48.5 ms median. So the object that pays a cold serve is one whose chain has
stopped, not every idle site. The figure that argued for off was a thousand-site fleet total, which
is the wrong lever for a default -- see `no-per-site-pricing` in project memory.

**The interval is decided by `src/ops/thermal.ts` now, not by a constant.** It prices
P(render inside the hibernation threshold) x 1,398 ms against a firing, over a 64-entry in-memory ring
of arrivals that costs no rows, and declines below the measured ~505 renders/day crossing. An explicit
`SITE_WARM` still wins in both directions. Two things to keep straight: only RENDERS count toward the
rate, because a cached page needs no warm object, and the rate divides by the WINDOW rather than by
the observed span -- dividing by the span reads a ten-second burst as ten renders per second.

**`WARM_FIRING_COST_MS` was invented at 130 and moved the crossing to 845 renders/day.** It is 79
now, derived from the crossing rather than guessed, and the spec asserts the two agree. A constant in
a policy comparison needs the same provenance as a published figure.

## EVERY HEAP PEAK IN THIS REPO IS AN ALLOCATOR RUNG, NOT A DEMAND

An independent audit (`drupflare/burrow`, 2026-09-14) reproduced this project's two published peaks
to the BYTE from `newSize = align64K(max(demand, oldSize * (1 + step)))` starting at 96 MiB:
wasm32 at step 0.08 gives rung[1] = **108,724,224**, and long64 at 0.13 gives rung[1] =
**113,770,496**. Both are exactly what was recorded as measured peaks.

So the figures in the memory section below bound demand rather than state it, and headroom computed
by subtracting a published peak from 128 MiB is subtracting a rung.

**THE DEMAND IS MEASURED NOW, and it needed no new export.** `sbrk` is not among the interpreter's
exports, but `growth-glue.ts` already documents the equivalent: at **step 0** the geometric candidate
collapses to `oldSize`, so `newSize` becomes `align64K(requestedSize)` and the heap stops being a
series. `bun scripts/measure/growth-ladder.ts 0.05 0` prints the pair, and the over-reservation
column is the slack:

| workload | demand at step 0 | shipping peak at 0.05 | over-reservation       |
| -------- | ---------------- | --------------------- | ---------------------- |
| render   | 90,898,432       | 92,536,832            | 1,638,400 (1.56 MiB)   |
| install  | 91,815,936       | --                    | --                     |
| auth     | 96,993,280       | 97,189,888            | **196,608 (0.19 MiB)** |

**0.19 MiB is the free SLACK on the worst workload**, against an audit that could only bound it in
[0, 983,040]. An extension whose `mem_size` exceeds it crosses a rung; one that fits is free.

**SLACK IS NOT THE BUDGET, and reading it as one understates the room by two orders of magnitude.**
Crossing a rung is not a failure, it costs one rung -- about 4.7 MiB here -- and there are six more
rungs before the cap. The admitted static image before the heap would pass 128 MiB is **33,423,360
bytes (31.88 MiB) at the shipping step, 37,224,448 (35.50 MiB) at step 0**. Against the audit's real
side-module builds, which ask 18,048 / 11,752 / 76,779 / 142,360 bytes of `mem_size`, that is
hundreds of extensions rather than the "two or three" the slack figure suggests. Linear memory is
not what bounds loading extensions here and never was; the interpreter tax on their WORK is.

**THE GAP TO THE 108.50 / 122.63 / 138.63 FIGURES IS THE BINARY, NOT THE WORKLOAD.** The ladder's
three arms already drive migrate, migrate-plus-firstrun, and two authenticated renders -- the same
workloads the memory section names. What differs is `INITIAL_MEMORY`, parsed from the Memory section
of each `.wasm`:

| binary                      | initial pages | initial memory |
| --------------------------- | ------------- | -------------- |
| `php8.5.tuned.wasm` (ships) | 1,024         | **64.00 MiB**  |
| `php8.5.wasm`               | 1,536         | 96.00 MiB      |
| `php8.5-long64.wasm`        | 1,536         | 96.00 MiB      |

The audit modelled the ladder from 96 MiB and matched the published peaks to the byte, because those
peaks were taken on a 96 MiB-initial binary. The shipping one started 16 MiB lower (1,280 pages, idle
83,886,080) until 2026-09-30 and starts at 1,024 pages since; see the fresh-isolate section. So the memory section's figures describe a binary this
project no longer ships, and the ladder's are the current ones. Re-measure before quoting either.

**AND A STEP RECOMMENDATION FROM ANOTHER HARNESS DOES NOT TRANSFER HERE, measured.** The audit found
dropping the geometric step to 0.01 buys 13 MiB on its own harness, which fills to a chosen demand
and then reads the rung. Re-run on THIS project's three real workloads with
`bun scripts/measure/growth-ladder.ts 0.05 0.02 0.01`, the worst-case peak moves 92.69 -> 92.44 MiB:
**0.25 MiB, not 13**, and 0.02 is WORSE than the shipping 0.05 at 94.00. The ladder is
path-dependent and non-monotonic by construction -- growth compounds from the previous size, so a
finer step can take more rungs and land higher -- which the script's own docblock already recorded
for `0.01 > 0.05`. The shipping 0.05 stays.

Three findings from that audit that DO apply and are not about the step:

- **Gate on `mem_size`, never on file size**, if `.so` loading ever lands. The `dylink.0` custom
  section is 16-18 bytes in the first ~40 bytes of the file and carries `mem_size` and `table_size`,
  so admission control costs one header read. An 8 MiB bss ships in a **211-byte** file, and
  `mem_size = data + bss` exactly, with code contributing zero.
- **`dlclose` is a three-line stub and emscripten defaults `nodelete: true`.** An isolate therefore
  accumulates the union of every extension any request ever asked for, with no upper bound. Workers
  isolates are reused, so that is a permanent floor per isolate rather than per request.
- **Whether workerd compiles wasm lazily is the audit's largest unverified assumption**, and this is
  the project that can answer it: lazy costs 1.78x the file in V8 and eager 4.64x. The 5 ms startup
  measured for the raw `CompiledWasm` seam is consistent with upload-time compilation and says
  nothing about a module compiled during a request.

## PHP LOADS EXTENSIONS AT STARTUP, NOT PER REQUEST, and that bounds the whole idea

A PHP request does not choose extensions; a PHP process does, from `php.ini`, before any request
runs. The only runtime loader is `dl()`, and it is confined to the CLI SAPI and off by default --
measured on PHP 8.5.7, `enable_dl` is empty and `dl()` returns false. This SAPI is `embed`.

So "load an extension for this request" is not a shape PHP has. What the interpreter's persistence
turns it into is **load an extension for this INCARNATION**, which is a different and better-behaved
thing: the object already boots once and serves many requests, and `recycleIfOversized()` already
drops the whole interpreter, which is the coarse unload path.

Three numbers that size the objective, and they argue for a small ambition:

- **The set is ~25 and nearly constant.** `get_loaded_extensions()` on the shipping build reports 25,
  Drupal's own requirements page names 14, and a census across core, vendor and 65 contrib modules
  found zero unambiguous call sites for `bcmath`, `calendar`, `exif`, `phar` or `intl`, one file for
  `xmlreader` and two for `tidy`. The composer `ext-*` requirements across those 65 modules are
  `ext-json` x4, `ext-xmlwriter` x2, and one each of `soap`, `simplexml`, `relay`, `redis`, `dom`.
- **The variable tail is 0 to 2 per SITE**, not per request. A request-time mechanism would be
  serving an almost empty tail, and a build-time one already serves the constant part.
- **An isolate accumulates the UNION and it saturates.** Measured over 12 simulated requests drawing
  2 extensions from a 5-item catalogue: 3,473,408 bytes total growth, all of it in the first four
  requests, and every request after the catalogue was exhausted cost zero. So budget the union of
  everything any tenant may ever ask for, never the per-request set -- an admission check that passes
  each extension individually will pass all of them and still blow the isolate on the tenth request.

The surviving objective is therefore per-TENANT rather than per-request, and its value is reach into
a tail a bundle cannot hold, not speed. Anything on the hot path belongs in the bundle at native
speed.

## Two platform questions answered from source, so nobody re-measures them

- **workerd compiles wasm LAZILY, and it is not close.** It sets no wasm-related V8 flag anywhere:
  the complete set is five `SetFlagsFromString` calls in `jsg/setup.c++` (`--noincremental-marking`,
  `--js-source-phase-imports`, `--single-threaded-gc` on macOS only, `--expose-gc` in test modes)
  plus whatever `config.getV8Flags()` carries, and workerd's own config comment says most users
  should set none. So V8's default stands: `wasm_lazy_compilation` is true. Lazy retains 1.78x the
  file against eager's 4.64x, which means an eager penalty this project has never paid. The caveat
  is that Cloudflare's upload pipeline is not in that repository -- but the 1 ms materialisation of
  12.78 MiB on a cold isolate is not the shape of 59 MiB of TurboFan output being paged in.
- **`wasm_memory_discard` is not a reclamation lever.** The compatibility flag exists and its own
  comment in `compatibility-date.capnp` reads "Obsolete flag. Has no effect." `memory.grow` still has
  no inverse and `mem.buffer.transfer()` throws; dropping the interpreter remains the only way to
  return linear memory.

## A restored heap carries a warm interpreter's pending writes, and a tag counter cannot see them

`BOOT_IMAGE=1` restores a shared after-render heap (`src/do/boot-image.ts`, folio v1's technique;
`docs/configuration/runtime.md` has the keys). Off by default. Measured deployed 2026-10-23 on a claimed
site: a cold round cost 2,527 ms of object `cpuTime` plain and 1,105 ms from the image (n=7 per arm,
one worker each); the report has the table and its limits.

**A cold request's CPU lands on the ALARM event it queued behind**, and the same-timestamp fetch
event reads small (580 against 1,765 ms plain, 17 against 1,082 from the image). Read the fetch
alone and the image looks like a 97% saving. Sum both. Also: the Observability event's time is the
top-level `timestamp`, not `$metadata.timestamp`, and a stock site answers `/user/password` from a
stored page, so a cold sample needs a distinct query string.

**A `CacheCollector` holds what it computed until `destruct()`, and the first request's resetter
writes it out under the NEW site's current tag checksums.** The bake's active trail for
`/user/login` reached a site that had since added a menu link and read as valid. Two sites with the
same number of saves share a counter, so no checksum catches it. `rekey.php` resets every
initialized collector on every restore. The test that found it renders a page BEFORE the edit,
because a stale entry needs something cached to hide behind; without that render a disabled reset
passed.

**Run the control for every step of a reset, and delete the ones that pass without it.** A
checksum-provider reset and a `State` reset were written from reasoning and both passed when
removed: the per-request resetter and the collector reset already did their work.

**An image is keyed on the PHP fragments it was built under** (`fragmentsDigest()`), because a
fragment's `function_exists` guard keeps the function the heap already holds. Any edit under
`src/site/php/` sends every site to the plain boot until `bun run assets:bootimage` runs again;
the interpreter is the one input no context names, so `tests/node/boot-image-agrees.spec.ts`
compares the index to the wasm on disk. The image is NOT in `build-local.ts` yet, which is the
`ASSET_AGGREGATES` shape (a lever with no producer in the build); it degrades to a plain boot, and
it is a step to add before the lever defaults on.
