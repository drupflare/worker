# Runtime Settings

Settings for cron, warming, the interpreter lifecycle, replica mode, boot and storage. The index of every variable is on [Configuration](configuration.md).

## Cron

| var                     | default   | what it does                                                            |
| ----------------------- | --------- | ----------------------------------------------------------------------- |
| `DRUPAL_CRON`           | on        | whether Drupal cron runs from the alarm; `0` turns it off               |
| `CRON_INTERVAL_MS`      | 900,000   | minimum gap between firings                                             |
| `CRON_MAX_UNITS`        | 6         | hooks or queues one firing may run                                      |
| `CRON_MAX_ROWS`         | 500       | rows one firing may write                                               |
| `CRON_MAX_MS`           | 500       | wall-clock ms one firing may occupy                                     |
| `CRON_QUEUE_BATCH_SIZE` | 5         | queue items drained per queue per firing                                |
| `UPDATE_FETCH_URL`      | unset     | release-history origin the declared prefetch warms; unset is drupal.org |
| `GC_INTERVAL_MS`        | 3,600,000 | gap between garbage-collection passes                                   |
| `CACHE_DATA_MAX_ROWS`   | 5,000     | row cap on `cache_data`                                                 |
| `WATCHDOG_ROW_LIMIT`    | unset     | row cap on `watchdog`; unset reads `dblog.settings` from the site       |

`CRON_INTERVAL_MS` is what makes the per-firing budget a budget. The alarm is not a clock, since it re-arms at +1 ms while a fill queue is draining, so "once per alarm" during an active fill is once per page, each one costing an interpreter unit and up to `CRON_MAX_ROWS` writes. At 15 minutes the worst case is 96 firings/day, so a site that hit the row cap every time spends 48,000 of the 100,000 daily rows. Lowering it is the fastest way to burn the meter that binds regeneration.

Cron renders against the site's origin, so links in mail it sends point at the site. See [`SITE_ORIGIN`](configuration.md#site_origin).

## Warming

| var                | default | what it does                                                                                    |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------- |
| `KEEP_WARM_MS`     | 240,000 | idle alarm re-arm; does not keep the object warm                                                |
| `SITE_WARM`        | by plan | `1` warms, `0` never warms; unset warms a paid site and leaves a free one to the thermal policy |
| `WARM_INTERVAL_MS` | 8,000   | the warm re-arm, KV-overridable; clamped to 600,000, or to 8,000 when `RETAIN_INTERPRETER=0`    |
| `WARM_CEILING_MS`  | unset   | ceiling the solved warm interval may climb to; 9,500 to 120,000; KV-overridable                 |

A Durable Object hibernates after 10 seconds of idle, and hibernation discards in-memory state, so `this.php` dies there. Measured on a deployed worker: an object holding a 32 MB allocation and an id minted in its constructor kept one incarnation across 71 consecutive 8 s alarms, and at 12, 20, 30 and 45 s the constructor ran again on every probe.

`KEEP_WARM_MS` ships at 240,000, which is 24x the threshold, so it re-arms an idle alarm and keeps nothing warm.

`SITE_WARM` re-arms at `WARM_INTERVAL_MS` instead. At 8,000 the object never hibernates, so every request finds the interpreter it left. A longer interval lets it hibernate, and the next instance then adopts the retained interpreter only when it lands in the same isolate; without retention (`RETAIN_INTERPRETER=0`) nothing can be adopted and the interval stays clamped below 10,000.

`WARM_CEILING_MS` sets the ceiling the solved warm interval may climb to, from 9,500 to 120,000 ms. The solver starts at 8,000 ms, steps 500 ms below 9,500 and 2,000 ms above, and takes one step per two clean 15-minute windows. Above 9,500 ms a window is clean when it had at least one render and no cold boot; at or below it a window is clean when one incarnation spanned it, as before. A window with a cold boot sends the interval back to 8,000 ms, and a window with no render holds it. `/serve-stats` reports `warmCeilingMs` and `warmWindowColds` beside `warmDecision`. The var has no effect when `RETAIN_INTERPRETER=0`, which keeps the ceiling at 9,500, or when `WARM_INTERVAL_MS` is set, because the explicit interval wins. Why it is off: on one demo object on one colo (2026-10-31) the object stayed hot for gaps up to 40 s with warming off in one drive, and a repeat seven hours later read 12 of 12 cold at 40 s; an earlier 12-worker rotation read 30 s adopting 36% of idle visits, with four hosts never adopting. No fixed interval past hibernation is supported by that evidence. The lever lets one site find its own ceiling instead of taking the fixed one.

The default follows the economics. An explicit `SITE_WARM` always wins. Unset, a paid site warms: one site's 10,800 firings a day sit inside paid's included Durable Object requests and rows. Unset on free it is the thermal policy below, because the same firings are 10.8% of free's daily row and request budgets, and whether that buys enough is the operator's call. Both levers are on `/settings`. An idle tick charges one row, the `setAlarm` itself. What warming buys is the 1,398 ms cold boot on every page that renders, which is the authenticated tier; a cached page answers off SQL without booting PHP at all, so warming cannot make one faster by any amount.

Past hibernation the curve has one knee, at 30 s. Measured on paid deployments with a page that needs PHP, requested after 150-300 s of idle. The 30-120 s rows come from 12 workers over four phases, rotated so every worker ran every interval (288 visits).

| re-arm            | firings a day | share of free's budgets | paid, per site-month | adopted | the request                    |
| ----------------- | ------------- | ----------------------- | -------------------- | ------- | ------------------------------ |
| 8 s (`SITE_WARM`) | 10,800        | 10.8%                   | $0.373               | always  | never hibernated: 156-371 ms   |
| 30 s              | 2,880         | 2.9%                    | $0.099               | 36%     | 100-692 ms adopted, ~2.1 s not |
| 60-120 s          | 720-1,440     | 0.7-1.4%                | $0.025-0.050         | 14-15%  | 106-888 ms adopted, ~2.2 s not |
| 240 s             | 360           | 0.4%                    | $0.012               | ~2%     | booted: 2-4 s                  |

Past 10 s, adoption depends first on where the platform places the object. Four of the twelve workers never adopted at any interval; on the other eight, 30 s adopted 54% and 60-120 s 21-23%. Every visit that did not adopt found no retained interpreter in its isolate.

A site that is not warming re-arms at 240 s, whether the thermal policy declined it or an operator set `SITE_WARM=0`, because that is the cheapest point and the thermal policy declines exactly the sites whose firings cost more than the boots they save. 60-120 s cost two to four times the firings for little more. An operator who wants the middle point sets `SITE_WARM=1` and `WARM_INTERVAL_MS=30000` on `/settings`; 30 s is also the shortest interval under $0.10 a month.

The interval is priced per site rather than flat. A flat 8 s re-arm is 10,800 object requests and 10,800 rows a day whatever the traffic, 10.8% of the free daily budget for one site, and it is charged at both ends of the band it is only worth paying inside. `src/ops/thermal.ts` keeps a 64-entry ring of recent arrivals (in memory, so the decision costs no rows), estimates the probability of a render inside the hibernation threshold, and warms only while that probability times the 1,398 ms boot exceeds what a firing costs. Below roughly 505 renders/day it declines; above roughly 8,640 the site never idles 10 s and is already resident, so the warming would be redundant rather than harmful.

An active session overrides the rate estimate, because the rate is the wrong predictor for one. `renderRate()` is a property of anonymous traffic: it decides how likely a visitor is to arrive. What decides whether an expensive render is imminent is whether somebody is signed in and working, and an editor on a quiet site sits far below the 505 renders/day crossing while producing exactly the requests a cold boot hurts most. In measurement, an authenticated render took 31 ms on a warm object and 513 ms on a cold one. A compiled plan removes the render, not the boot: the first three requests of a session still render, and any request that falls through the plan tier pays whatever the object costs at that moment.

So an authenticated render keeps the object warm for 30 minutes on its own. It is a window rather than a latch, so a session that ended stops paying within one window, and at the 8 s re-arm it costs 225 firings, 225 requests and 225 rows, once. The signal is the uid Drupal reported rather than the presence of a cookie, so a stale cookie cannot arm it.

An explicit `SITE_WARM` still wins in both directions, including over an active session. Setting it to `1` warms a site the estimate would decline, and `0` declines one the estimate would warm. The predictor decides only when the var is unset.

After an editorial save the object prewarms one representative per route family rather than arbitrary URLs, because the page cache is keyed on the URL and what a visitor arriving on `/node/41` meets cold is the object, not the page.

Duration is not the meter. An object waiting on an armed alarm is idle and eligible to hibernate, and an idle-eligible object is not billed for duration; warming spends requests and rows.

## Interpreter Lifecycle

| var                   | default   | what it does                                                                                    |
| --------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `RECYCLE_ABOVE_BYTES` | 117440512 | drop the interpreter at the end of an invocation above this linear-memory reading; floor 32 MiB |
| `ISOLATE_ABOVE_BYTES` | 130023424 | the same drop against the whole-isolate estimate (linear memory plus the JS side); floor 64 MiB |
| `FILL_SETTLE_MS`      | 60,000    | ms after a boot before the alarm runs PHP (fills, cron, reconcile); `0` is off                  |
| `RETAIN_INTERPRETER`  | on        | keeps an evicted instance's interpreter for the next instance to adopt; `0` is off              |

`RECYCLE_ABOVE_BYTES` is the backstop for the isolate's 128 MiB limit, behind the primary defence. `USE_ZEND_ALLOC=0` means PHP returns nothing between requests, so demand inside one incarnation is cumulative; `/__migrate` and `/__firstrun` drop the interpreter when they finish, and this catches everything else. It must fire between invocations: linear memory is reclaimed only when the old module is collected, so dropping mid-request holds both allocations at once. `/serve-stats` reports `recycles` and `lastRecycle`; an object recycling every request is paying a boot per page.

The limit is per isolate, not per object, and an isolate can host several objects of one class. `/serve-stats` reports `isolate`: its `id`, the `interpreters` it holds and their `linearBytes` added together. Two interpreters do not fit 128 MiB, so `interpreters` above 1 is the thing to look for on a replica pool.

`RETAIN_INTERPRETER` keeps the interpreter in the isolate when the instance is evicted, so the next request skips the boot while the isolate survives. In measurement, adopting a kept interpreter took 61-169 ms against 1-2.5 s for a boot. When the isolate is gone the next request boots as it would have anyway. An adopted interpreter is refused when the site committed a write since it was kept. `/serve-stats` reports `retention`.

## Replica Mode

The replica variables are on [Replica Settings](configuration-replicas.md). This section covers the read-only interlock and the calls between a primary and its replicas.

**`REPLICA_READ_ONLY` is a safety interlock.** Setting it wraps every installed `cfw*` capability so the object cannot commit an authoritative write, and refuses anything unrecognised. The mode is reported under `replica` in `/serve-stats`.

A replica is started by a bulk copy and kept current by a log, both over `/__replica`:

| call                                  | on      | what it does                                                    |
| ------------------------------------- | ------- | --------------------------------------------------------------- |
| `GET ?action=snapshot`                | primary | the table plan; 409 when the primary's own identity is unminted |
| `GET ?action=snapshot&table=&offset=` | primary | one page of one copyable table                                  |
| `POST ?action=restore`                | replica | lands one chunk; `VERIFIED` when the whole copy has arrived     |
| `GET ?action=log&since=`              | primary | the records a replica at that generation still needs            |
| `POST ?action=apply`                  | replica | applies one record                                              |
| `?action=stage&to=`                   | either  | moves the stage, 409 on an illegal move                         |

A replica refuses a request it may not answer with 421 and `x-cfw-requires-primary`, and refuses a stale one with 503 when the caller sent `x-cfw-require-generation`.

## Boot and Storage

| var                             | default                               | what it does                                                                                      |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `HEAP_SNAPSHOT`                 | on                                    | restore a stored wasm heap instead of booting the kernel; `0` disables                            |
| `HEAP_IMAGE`                    | off                                   | take that heap image in the first place; `1` enables. A restore costs more than a boot            |
| `BOOT_IMAGE`                    | off                                   | boot a cold object from the published boot image when the site matches it; `1` enables            |
| `BOOT_IMAGE_BAKE`               | off                                   | lets an object capture its own boot image; only the local bake rig sets it                        |
| `HEAP_RESTORE_CHUNKS`           | all at once                           | chunks of a snapshot one invocation may apply                                                     |
| `LAZY_MOUNT`                    | `1` in the canonical config           | stream the pack per file instead of inflating it whole                                            |
| `LAZY_FS_BUDGET_BYTES`          | 20 MiB, 4 MiB in the canonical config | resident bytes the lazy filesystem keeps before evicting                                          |
| `SITE_DB_PREFIX`                | the packed default                    | which database pack an object mounts                                                              |
| `SQL_CHUNK_PREFIX`              | `drupal-sql`                          | which asset directory the migration chunks are read from                                          |
| `MIGRATE_ENGINE`                | `sql`                                 | `sql` replays chunks in JavaScript; `php` needs a `pdo_sqlite` the shipping binary does not carry |
| `MIGRATE_SELF_DRIVE`            | on                                    | whether a partial migration re-arms its own alarm                                                 |
| `MIGRATE_CHUNKS_PER_INVOCATION` | 40 on free, all on paid               | chunks replayed per invocation                                                                    |

### `OPCACHE_MODE`

| value  | what it does                                             |
| ------ | -------------------------------------------------------- |
| `off`  | default; opcache disabled                                |
| `file` | opcache on with the file cache as its only backing store |
| `shm`  | opcache on with shared memory as its backing store       |
| `pack` | reads a file cache baked into the pack, read-only        |

`off` is the default. `file` writes its cache into the in-memory filesystem and never reads it back, so opcache reports itself disabled on that arm. `shm` accelerates scripts but places its arena in PHP's linear memory; in one measurement that took an object to 191.25 MiB, past the 128 MiB isolate limit. `off` renders no slower than `file` and leaves more memory free.

`pack` needs `bun scripts/bake-opcache.ts` first and mounts nothing without it. It loads the baked cache as a second layer and cuts a cold render's object CPU by roughly 500-900 ms (deployed, n=8 per arm, with the levers swapped between deploys as a control). It holds 8.58 MB more of the isolate, and the visitor's wall time did not follow the CPU across the swap. Re-bake after any driver or composer change: scripts are never revalidated against their source, so the mount refuses a layer baked from other sources.

### `ARGON2`

`1` hashes passwords with argon2id at m=19456 KiB, t=2, p=1, computed on the host. Default off.

Turning it on is a migration: every bcrypt hash on the site reports as needing a rehash, and each account is upgraded at its owner's next login. Existing hashes keep working throughout; core's password service stays in place as the inner service and still owns bcrypt and legacy `$S$` hashes. Hashes are written in PHP's own `$argon2id$v=19$m=..,t=..,p=..$salt$tag` form, so a site that leaves this platform can verify them on any PHP with ext-argon2.

A hash costs a 19 MiB transient allocation and two passes of CPU. That is more than a free-plan login invocation has.

### `SHELL_ASSEMBLY`

Allows an authenticated GET to be answered from a stored shell with its personalised regions filled at the edge. On by default with no plan branch; `0` opts out, and an empty value is treated as unset. Assembly writes rows, described below. No visitor is served an assembly that has not been proven against their own render.

A path with no stored shell is seeded from the next authenticated request, which is what lets assembly resume after an invalidation. Every bump purges every shell, because no Drupal cache tag reaches one, so without seeding the feature stops at the first content change until an operator re-harvests.

An operator harvest takes two sessions of one role set and stores the shell only when both normalise to identical bytes. A seed takes one session, which widens what may be stored and leaves what may be served where it was. A visitor whose permissions hash differs from the stored shell's falls through to an ordinary render.

Each visitor's first request for a harvested path re-harvests under their own session and requires their normalised shell to equal the stored one byte for byte. That response carries `x-cfw-cache: VERIFY` and is answered from their own harvest; later requests carry `x-cfw-cache: ASSEMBLED`. A shell that disagrees is deleted and the reason is recorded in `cfw_meta` under `shellRefusal`.

The proof is stored per `(path, permissions hash, uid)` and voided when the path is harvested again. It costs 40 to 52 rows written once per visitor and path, against 4 to 10 for each render it then replaces; an assembly writes none.

A generation bump drops every stored shell, including a `cachetags` bump. A shell caches the shared region of a page and Drupal has no cache tag pointing at it, so nothing else would invalidate it. Assembly stops on that path until the shell is harvested again.

`HEAP_SNAPSHOT` gates the restore and `HEAP_IMAGE` gates the producer. The producer is off by default; `HEAP_IMAGE=1` opts back in.

It is off because a restore costs more than the boot it replaces. Two deployed free workers differing only in these two vars, `cpuTime` on the cold render, nothing asked of either object during the idle:

| arm                                  | cpuTime (ms)                 |   n | median |
| ------------------------------------ | ---------------------------- | --: | -----: |
| `HEAP_IMAGE=1` and `HEAP_SNAPSHOT=1` | 2020, 1908, 1937, 1561, 1912 |   5 |  1,912 |
| both `0`                             | 1277, 1343, 1113, 1251       |   4 |  1,264 |

The ranges do not overlap, so a restore cost about 648 ms more than booting from scratch, and it consumes storage against an account-wide 5 GB cap. The cause of the extra time is not known.

The image size depends on when it is taken. `snapshotStep()` takes its image from an alarm that finds no resident interpreter, so on a fresh site it captures the cold shape at 37,158,912 bytes. An image taken after a kernel boot and a serve is 9,699,328 bytes, and a restore from that image was measured at 314.5 ms faster than booting.

`snapshotStep()` still takes one image per pack generation from the alarm when opted in, and `/heap` reports `imagedGeneration`, `imageAttempts` and `lastHeapImage`. It never drops the interpreter: it runs before the fill loop and only when `this.php === null`. It also refuses to overwrite an image an operator took, since the GC keeps exactly one. When an image is stored its chunks are deflated, which bounds the storage at 3,134,727 bytes rather than 11,206,656.

The image is taken before the first render. Byte-identical anonymous output does not prove that no session state survives a render, so no post-render image is produced. The shared boot image below is the one exception, and it earns it differently: it is taken once from a throwaway site, and its test asserts the session id, the `$_SESSION` keys and the user after a restore.

### The shared boot image

`BOOT_IMAGE=1` boots a cold object from a heap image published with the worker, where a plain boot builds that heap from the database. It is off by default, because no real site's cold-boot share has been measured against it. `bun run assets:bootimage` bakes it into `assets/bootimage/`.

A boot restores an image only when the site equals what the image was baked from: the pack generation and enabled modules, the driver digest, a digest of the `config` rows, and a digest of the settings and PHP fragments the heap was built under. Any difference boots plain, which is always correct, so a stale image costs a plain boot. Two images are published. The `pack` image is for a site the pack made. The `claimed` image is for a claimed site and carries `config=reset` in place of the digest, because every claimed site has its own name, mail and timezone; its restore also resets the config factory and the entity memory cache.

After the pages land, the restore runs `src/site/php/boot-image/rekey.php`: it reads `settings.php` again (the site's salt and origin), flushes `cache.memory` and every memory bin, resets every cache collector (State's private key, and anything the bake computed but had not persisted) and reseeds `mt_rand`. A replica or pool lane never boots from the image.

The image is checked four ways. The first three were each rerun with the step that serves them removed, and the spec failed.

- **Rendered output.** A restored site renders what a plain boot renders, over five pages, after normalizing the ids a render invents. A first render that read as many rows as a plain boot would show the heap was not used, so the spec asserts fewer.
- **Site values.** The salt and the private key read before any request are the site's own, and a second restored site draws different `mt_rand` values. Without the settings re-read the bake's salt survives.
- **Config.** A claimed site's own name shows, and so do a theme colour, a disabled block, the maintenance switch, a new menu link and a saved node, from the image and from a plain boot alike. With the config reset off all six cases fail.
- **Corrupt files.** A corrupt file refuses the restore. If an earlier file already landed, the interpreter is dropped and the site boots plain; the page is the same either way.

A heap restored from a bake is only as fresh as an interpreter that rendered once. The bake's active trail for `/user/login` sat in a cache collector, waiting to be persisted, and the first request's resetter wrote it into the new site's cache under that site's current tag checksums. It read as valid and lacked a link the site had added. Resetting every collector on each restore prevents this.

Deployed, on a claimed site with `SITE_WARM=0` and `RETAIN_INTERPRETER=0`, a cold round cost 2,527 ms of object `cpuTime` without the image and 1,105 ms with it (medians, n=7 per arm, one worker each), and 3,974 against 2,454 ms of wall time. The cost is the request's fetch plus the alarm it queued behind, since the platform charges the boot to the alarm. The technical report has the table and its limits.

What is not measured: the share of real cold boots that match an image, the pack image deployed, a site with content or a large module set, and what the extra 18.6 MiB of memory (1,320 to 1,375 pages against 1,024) costs per fresh isolate, which a deployed memory is charged for in full. A site with a different module set, settings or interpreter build boots plain; the published index also names the interpreter, and `tests/node/boot-image-agrees.spec.ts` fails when it is not the one on disk.

What replaces this as the number to watch is the cold-encounter share, not the cold-boot duration. `src/ops/cold-encounter.ts` classifies every request the object handles and `/serve-stats` reports `coldOfPhp`, `coldOfObject` and `coldOfTraffic`. 1,264 ms is the floor for an object `thermal.ts` decided not to keep warm, and that policy already ships.

Read `coldOfTraffic`, not `coldOfObject`. A plan hit, an isolate memo hit, a `caches.default` hit and a KV page read all return from the front worker, so the object's own denominator is the leftovers and a share taken against it reads several times high. The front worker reports what it absorbed on the next request that hops anyway, under `x-cfw-absorbed`, and `coldOfTraffic` is null until it has, because a worker too old to report and a site with nothing absorbed are otherwise the same reading.

**Changing `LAZY_MOUNT`, `MIGRATE_ENGINE` or `SITE_DB_PREFIX` in a deploying config means changing `assets/.assetsignore` too.** The shipping asset set is derived from the canonical values of those three; `tests/unit/runtime/assets-ignore.spec.ts` fails when the two disagree.
