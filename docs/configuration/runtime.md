# Runtime Settings

Settings for cron, warming, the interpreter lifecycle, replica mode, boot and storage. The index of every variable is on [Configuration](index.md).

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

A firing is claimed in `cfw_outbox_cron` before it runs. After an object reset a firing that ran
only SQL passes replays; one that reached a PHP hook is reported under `outboxReported` and not run again.

`CRON_INTERVAL_MS` is what makes the per-firing budget a budget. The alarm is not a clock, since it re-arms at +1 ms while a fill queue is draining, so "once per alarm" during an active fill is once per page, each one costing an interpreter unit and up to `CRON_MAX_ROWS` writes. At 15 minutes the worst case is 96 firings/day, so a site that hit the row cap every time spends 48,000 of the 100,000 daily rows. Lowering it is the fastest way to burn the meter that binds regeneration.

Cron renders against the site's origin, so links in mail it sends point at the site. See [`SITE_ORIGIN`](site-identity.md#site_origin).

## Warming

| var                | default | what it does                                                                                             |
| ------------------ | ------- | -------------------------------------------------------------------------------------------------------- |
| `KEEP_WARM_MS`     | 240,000 | idle alarm re-arm and the floor of the idle fade; 10,000 to 3,600,000; KV-overridable                    |
| `IDLE_CEILING_MS`  | unset   | ceiling of the idle fade; 10,000 to 3,600,000; unset keeps the re-arm fixed at `KEEP_WARM_MS`            |
| `SITE_WARM`        | by plan | `1` warms, `0` never warms; unset warms a paid site and leaves a free one to the thermal policy          |
| `WARM_WINDOW`      | unset   | days and hours the site is kept warm, for example `mon-fri 06:00-22:00 America/New_York`; KV-overridable |
| `WARM_INTERVAL_MS` | 8,000   | the warm re-arm, KV-overridable; clamped to 600,000, or to 8,000 when `RETAIN_INTERPRETER=0`             |
| `WARM_CEILING_MS`  | unset   | ceiling the solved warm interval may climb to; 9,500 to 120,000; KV-overridable                          |

`WARM_WINDOW` keeps a site warm only on some days and hours. The value is `<days> HH:MM-HH:MM [zone]`:
`days` is `daily`, one day (`sat`) or a range that may wrap (`mon-fri`, `fri-mon`), the hours are
24-hour clock with the start inclusive and the end exclusive, the window does not cross midnight
(`24:00` ends the day), and `zone` is an IANA name that defaults to UTC. Inside the window the site
warms at `WARM_INTERVAL_MS` whatever its plan; outside it the site takes the idle re-arm of a site
that is not warming, so the first visit after the window closes meets a cold start. `SITE_WARM=0`
still turns warming off in every hour. A value that does not parse answers 400 with
`code: "invalid_lever"` on the settings write and nothing in that body is stored; one already in KV
that does not parse is ignored when read. A window that sets the clock to a zone with daylight saving follows the zone.

A Durable Object hibernates after 10 seconds of idle, and hibernation discards in-memory state, so `this.php` dies there. Measured on a deployed worker: an object holding a 32 MB allocation and an id minted in its constructor kept one incarnation across 71 consecutive 8 s alarms, and at 12, 20, 30 and 45 s the constructor ran again on every probe.

`KEEP_WARM_MS` ships at 240,000, which is 24x the threshold, so it re-arms an idle alarm and keeps nothing warm.

`IDLE_CEILING_MS` lets that idle re-arm grow with idle time. For a site the predictor does not keep warm, the next re-arm is the time since its last render, clamped between `KEEP_WARM_MS` and `IDLE_CEILING_MS`, so each wake lands twice as far from the last activity as the one before. The floor holds while fill, mail or HTTP work is queued, while a pool has lanes, and during a migration, a stepped job, an update run or a repair. With the ceiling unset the re-arm is the fixed `KEEP_WARM_MS`, as before. The clock is the render window row: its sixth field, `lastAt`, records the newest render when the window rolls, so the fade adds no row. After a hibernation the stamp can be a window old, so 15 minutes come off it and the fade starts late. Only renders stamp it; a cached page served by the object does not. `/serve-stats` reports `rearm` with the interval in force, the reason and the idle time. No deployed run measures this yet, so neither lever has marks on the settings form.

The `*/5` fill window skips a site whose queue is empty: the object answers the socket request with a 204 and `x-cfw-window: skipped:empty-queue`, and the driver reports `skipped`.

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
| `RELEASE_HOST_GRAPH`  | on        | frees a dropped interpreter's filesystem graph; `0` is off                                      |

`RECYCLE_ABOVE_BYTES` is the backstop for the isolate's 128 MiB limit, behind the primary defence. `USE_ZEND_ALLOC=0` means PHP returns nothing between requests, so demand inside one incarnation is cumulative; `/__migrate` and `/__firstrun` drop the interpreter when they finish, and this catches everything else. It must fire between invocations: linear memory is reclaimed only when the old module is collected, so dropping mid-request holds both allocations at once. `/serve-stats` reports `recycles` and `lastRecycle`; an object recycling every request is paying a boot per page.

The limit is per isolate, not per object, and an isolate can host several objects of one class. `/serve-stats` reports `isolate`: its `id`, the `interpreters` it holds and their `linearBytes` added together. Two interpreters do not fit 128 MiB, so `interpreters` above 1 is the thing to look for on a replica pool.

`RETAIN_INTERPRETER` keeps the interpreter in the isolate when the instance is evicted, so the next request skips the boot while the isolate survives. In measurement, adopting a kept interpreter took 61-169 ms against 1-2.5 s for a boot. When the isolate is gone the next request boots as it would have anyway. An adopted interpreter is refused when the site committed a write since it was kept. `/serve-stats` reports `retention`.

## Growth Governor

The recycle thresholds above act between invocations. The growth governor acts inside one: it refuses a grow of the interpreter's linear memory that would pass a cap, so a request that would have pushed the isolate over the platform's kill line fails alone instead of resetting the object and every request in flight. It is on unless `GROWTH_GOVERNOR` is `0`.

| var                     | default  | what it does                                                                     |
| ----------------------- | -------- | -------------------------------------------------------------------------------- |
| `GROWTH_CAP_BYTES`      | unset    | the cap in bytes; wins over the ledger and over `GROWTH_GOVERNOR`                |
| `GROWTH_GOVERNOR`       | on       | `0` turns the derived cap off                                                    |
| `GROWTH_HEADROOM_BYTES` | 37748736 | the headroom the build holds with the interpreter resident (36 MiB), measured    |
| `GROWTH_MARGIN_BYTES`   | 4194304  | bytes held back below the headroom for one request landing above the cap (4 MiB) |

The cap is the boot size, plus the headroom, plus the JS-side bytes the ledger counted when the headroom was measured minus the ones it counts now, minus the margin, and never below the boot size. Each constant has one source:

| constant                   | value                       | source                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| boot size                  | 64 MiB                      | `INTERPRETER_MEMORY.initial`, 1024 pages, the tuned binary's import limit                                                                                                                                                                                                                                                                             |
| headroom                   | 36 MiB                      | headroom ladder on a deployed paid worker, 2026-11-23, interpreter resident at 64 MiB of linear memory: stock Drupal after an admin page or a flush read 36 in 8 of 9 readings at a 240 s settle and never below 36 after 60 s; a Thunder object read 36 after a flush (3 reps, zero spread). Growth of linear memory counts one for one below 96 MiB |
| JS side at the measurement | 19,187,577 bytes (18.3 MiB) | the worker's own ledger at that state: the mount blob 13,012,361 bytes, the merged pack index 1,980,912 bytes (`PACK_INDEX_BYTES`) and about 4 MiB of resident files                                                                                                                                                                                  |
| margin                     | 4 MiB                       | assumed; not measured                                                                                                                                                                                                                                                                                                                                 |

On stock Drupal that is 64 + 36 + 0 - 4 = 96 MiB with the resident set at 4 MiB. A freshly booted object holds about 1 MiB of resident files, so its cap reads about 99 MiB and falls as files are opened. A staged `COLD_PACK` (the blob and its index out of the ledger) raises the cap by the bytes it frees, 13,012,361 + 1,980,912 = 14,993,273 bytes, and a larger resident set lowers it byte for byte. The ledger is read at boot and again at the start of every governed request.

**WordPress is not measured.** Its headroom has no ladder reading. Its pack blob is smaller (7.07 MiB read locally against 12.41), so the formula gives it a higher cap than Drupal's, which assumes its headroom is at least 36 MiB. A smaller JS side suggests more room, so the Drupal-derived figure is probably conservative there, but nothing shows it. Set `GROWTH_HEADROOM_BYTES` from a ladder reading before relying on the number.

The cap is applied once the interpreter has started, so it never refuses the boot itself. A cap below the memory the interpreter already holds is lifted to what it holds: every grow is refused and nothing shrinks. A reused spare memory keeps the size an earlier incarnation grew it to, so after an owner phase that grew it (the provisioned incarnation sits at 107 MiB) the next boot's cap is lifted to that size and the governor refuses any further growth. A request that needs to grow then fails with a governed refusal.

The cap does not apply to every phase. Provisioning, claim, install, modify, enable, restore, migration, every other object route except a page render, a render carrying the owner phase header (`x-cfw-phase`), and every alarm firing (fills, cron, reconciliation) legitimately grow linear memory well past a serving cap, and a refusal there would be a flow that never completes where a reset is retried and finishes. They run with the governor lifted, and it goes back on when they end. `/serve-stats` reports the number running now as `growthExempt`.

A refused grow makes the interpreter's allocator fail. PHP prints `[error] Out of memory`, the run ends in `exit(1)`, and PHP's `catch` never runs. The object drops that interpreter, counts the run, and answers 503 with `x-cfw-growth-refused: 1`. The front worker repeats a GET or HEAD once, and sets `x-cfw-retried: growth` on the reply. Other methods and the GET routes that run cron are not repeated. A governed run is one transaction (see Refusal Tiers below), so a refused run saves nothing, and the 503 for an unsafe method says so.

The governor sees linear memory only. The JS-side charge (mount blob, resident files, host graph, reply strings, bridge buffers) is outside it, which is why the cap moves with what the ledger can see of that charge. About 44 MiB of what the ladder charges at that state is outside everything the worker counts, and the headroom figure already includes it.

`/serve-stats` reports `growthCap` (null while off), `growthRefusals` (refused grows; the allocator retries smaller sizes, so one failed run can add several), `governedRuns` (runs a refusal ended), `rolledBackRuns` (those whose writes the transaction undid) and `lastGoverned` (when, and the size it asked for against the cap). With `MEMORY_TRACE=1` each refusal also logs a `growth-refused` line with the sizes.

Those counters live in memory, and an object the platform resets after a refusal loses them. The refusal log is stored: each run a refusal ended writes one row to `cfw_growth_log` in the object's SQLite, after the run's transaction has rolled back and the interpreter is dropped, so the row is not part of what was undone. A row holds the time, the size it grew from and asked for, the cap, the JS-side bytes the ledger counted, the route (method and path without the query, and a path segment over 24 characters shown as `*`), whether the run's writes were rolled back, and the attempt (1 or 2). The newest 20 rows are kept; the older ones are deleted in the same batch. `/serve-stats` reports them newest first as `growthRefusalLog`, and a reset object still reports its last refusals. The table is created by the first refusal and by nothing else, so a site that was never refused has no table, and a normal request writes no row. A refusal writes one row, two once the log is full.

## Fresh First Routes

A cache flush on a heavy site (Thunder) needs more linear memory than the growth cap allows, and the platform ends an object that runs past its isolate limit. The registry gives such a request a fresh isolate. It is on by default for the performance page's POST (the cache flush), and `FRESH_FIRST_ROUTES=0` turns it off.

| var                  | default | what it does                                                                                                                                                               |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FRESH_FIRST_ROUTES` | `abort` | unset or `abort` covers the cache flush; a comma list of `METHOD /path` entries (a bare path means POST) replaces that route; `0` or an empty value turns the registry off |

A request on the list that finds an interpreter resident writes and syncs a record, then calls `ctx.abort()` before any PHP has run. The request has had no side effect, so the front worker repeats it once, for any method, with `x-cfw-retried: abort`. The repeat lands on a new isolate and runs under the same fresh-attempt allowance as a governor repeat (see Repeating a Refusal). The object never aborts a request that carries the header, and the hop strips that header from every inbound request. A route outside the list never aborts.

The cost of a matching request is one cold boot on the new isolate and one repeat, so the flush is slower than it would be on a warm interpreter. Dropping the interpreter inside the request instead was tried and removed: a fresh boot and the flush render after such a drop ended in a platform reset.

A platform reset in the middle of a flush answers with the platform's own page, which carries no header, and takes the in-memory counters with it. So each abort is also stored. Before it aborts, the object writes one row to `cfw_fresh_first` (one row, id 1) and waits for the write to be durable: the time, the route, the interpreter's linear memory in bytes, a count that only goes up, and the isolate as `isolateBytes` reads it. When the repeat finishes on the new isolate a second write sets `completed_at`, the isolate reading and `end`: `ok` when it answered, `refused` when the governor refused it, `error` for anything else. It is written for a refusal as well as a response. `/serve-stats` reports `freshFirst: { count, last }`, and a `last` with a null `completedAt` is an abort whose repeat never finished. The table is created by the first abort and by nothing else, a request that does not abort writes nothing, and an abort writes two rows. `/serve-stats` also reports `incarnation`: the isolate's id and the time it first served (a new isolate, after an abort or a memory reset, changes both), the object instance's id (changes when the object restarts, even in the same isolate) and the interpreter's id and boot time (changes at every interpreter creation), so a run can tell a fresh isolate from a fresh instance. The isolate's start time is the first use of its id, not the platform's own start.

The route is matched on method and path, with the query dropped, percent-escapes decoded, repeated and trailing slashes removed, and a leading language prefix (`/en`, `/pt-br`) tolerated for the request, so a multilingual site's flush is matched under any of its prefixes. The front worker hands the page request to the object as `/__serve?path=<path and query as sent>`, so a flush posted to `/admin/config/development/performance` arrives as exactly that path.

## Refusal Tiers

A refusal moves a request up a short ladder instead of ending it half done.

| tier | var                                                                     | default | what it does                                                                                                                                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `GROWTH_ROLLBACK`                                                       | on      | each governed run is one `transactionSync`; a refused grow rolls its writes back. `0` returns to partial writes                                                                                                                                                                    |
| 1    | `STEPPED_OPS`, `STEP_BUDGET_MS`, `STEP_MODULE_COST_MS`, `STEP_FLOOR_MS` | planner | a module enable too big for one invocation runs one module per slice, each with a checkpoint that commits with it. A call that cannot finish within the budget (20000 ms of PHP time) or that leaves the interpreter oversized answers 202 and a poll URL, which is the same route |

Tier 0 undoes a slice, never an earlier one that returned. A request with no park point is one slice, so it rolls back whole, and the 503 says `Nothing it did was saved` with `x-cfw-rolled-back: all`. A parked request (Redis, outbound HTTP, an external database) commits each slice at its park; a refusal in a later slice answers `x-cfw-rolled-back: slice` and says the earlier steps were saved. A trap or a fatal still commits what the run wrote. Effects that leave the object and are not rows, which today means the settings write to KV, wait for the slice to commit. Owner routes, provisioning and alarms are not wrapped.

Tier 1 is on by default with a planner. `STEPPED_OPS` unset or `1` steps a module enable only when the modules it has to install, times `STEP_MODULE_COST_MS`, exceed `STEP_BUDGET_MS`. `always` steps every enable and `0` turns stepping off. `STEP_BUDGET_MS` is the PHP time one invocation may spend on steps before it answers 202 (default 20000). `STEP_MODULE_COST_MS` is the predicted PHP time of one module (default 12000, the middle of the deployed CPU of one-module invocations on a module site, boot included, so it overstates a module and errs toward stepping). With the defaults one module runs as a single call and two or more are stepped. Inside a stepped call the platform clock does not advance, so the only estimate of a step is its host calls times 0.13 ms, and it does not separate sites: two modules with the same call count ran 3.5 s and 11 s of CPU, and a module install of 72,575 calls (an estimate of 9.4 s) ran 35.9 s. `STEP_FLOOR_MS` (default 20000) is the least a step is charged against the budget, so by default an invocation runs one step. Two steps in one call ran 23.9 s of CPU and 30.3 s of wall time on a deployed worker, against a kill line between 30.3 and 32.4 s. A single module whose own install runs past that line is not divided by stepping. A client of `/enable` repeats the request while the reply says `done: false`. The enable route is an owner phase, so its steps run without the serving cap (a kernel boot on a large module site already holds 95.8 MiB of the 96 MiB cap); each step still commits in one transaction with its cursor, so an interrupted step repeats whole and a finished one never repeats. A step that fails is rolled back and the job stays at that step.

## Repeating a Refusal

A refusal drops the interpreter, so a repeat boots a fresh one with the most room it will ever have (a render leaves 16 to 48 MiB of headroom right after a boot against 36 steady). The front worker already repeats a refused GET once. It now repeats a refused request of any method once, on one path and with the same `x-cfw-retried: growth` header, when the object proves the first try left nothing behind. It is on by default; `GROWTH_RETRY=0` returns to repeating safe methods only.

| var                            | default   | what it does                                                |
| ------------------------------ | --------- | ----------------------------------------------------------- |
| `GROWTH_RETRY`                 | on        | `0` stops the repeat of a request that is not a GET or HEAD |
| `GROWTH_RETRY_ALLOWANCE_BYTES` | 8388608   | what the repeat may grow past the computed cap (8 MiB)      |
| `GROWTH_RETRY_CEILING_BYTES`   | 109051904 | the cap the repeat never passes (104 MiB)                   |

A POST or other unsafe request is repeated only when all of these hold: the answer carries `x-cfw-growth-refused: 1`, `x-cfw-rolled-back: all` (the refused run's transaction undid its writes and no earlier step of the request committed), `x-cfw-effects: none`, the request is not one of the GET routes that run cron, and the body the hop already holds as one buffer is at most 1 MiB. A larger body is not repeated, and a body is never read twice. The repeat carries a new attempt id, because the first one was marked before the run.

`x-cfw-effects` comes from the object's own ledger of PHP-to-host calls since the request's interpreter booted. `some` when any of these ran: an outbound HTTP call, an outbound socket (Redis, an external database, a mail relay), mail, a file store write, delete or rename, the identity claims, the runtime settings; or when a parked socket is open. `none` only when none ran. `unknown` when the ledger cannot tell: no tally, or the interpreter was booted again during the request, which resets the counts. Not counted, because they stay in the object's SQLite and roll back with the run: SQL, the queued-fetch insert, the cache read, logging and file reads. Only `none` repeats; `some` and `unknown` answer the 503.

The repeat runs under the fresh-attempt allowance: the cap is the computed cap plus the allowance, never above the ceiling and never below the computed cap. Only a request carrying the header gets it, and the hop removes that header from every inbound request, so only the front worker can set it. The ceiling is the 108 MiB cliff the memory notes record, less the 4 MiB margin the cap already carries. Stock Drupal does not reach 96 MiB, so the allowance engages only on heavy routes. A second refusal on the repeat answers the 503 as before, and the refusal log keeps both tries: the `attempt` column reads 1 and 2.

The evidence is one Thunder site, deployed. With the cap at 96 MiB the fresh isolate's flush was refused at 95.81 to 96.06 MiB. With the cap at 104 MiB the flush completed on a fresh isolate (90.6 MiB linear), and a config export was still refused at 108.9 to 109.2 MiB against the 104 cap, rolled back, repeated and passed, with no platform kill at 128 MB total. Running a registry-off arm with the repeat on is a test of how the two interact, not a way to make a run pass.

## Replica Mode

The replica variables are on [Replica Settings](replicas.md). This section covers the read-only interlock and the calls between a primary and its replicas.

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
| `BOOT_IMAGE`                    | on                                    | boot a cold object from the published boot image when the site matches it; `0` disables           |
| `BOOT_IMAGE_BAKE`               | off                                   | lets an object capture its own boot image; only the local bake rig sets it                        |
| `HEAP_RESTORE_CHUNKS`           | all at once                           | chunks of a snapshot one invocation may apply                                                     |
| `LAZY_MOUNT`                    | `1` in the canonical config           | stream the pack per file instead of inflating it whole                                            |
| `LAZY_FS_BUDGET_BYTES`          | 20 MiB, 4 MiB in the canonical config | resident bytes the lazy filesystem keeps before evicting                                          |
| `COLD_PACK`                     | on; off for WordPress on free         | keep the pack in the object's own storage, not the isolate; `0` disables                          |
| `COLD_PACK_CACHE_CHUNKS`        | 8, at most 64                         | 64 KiB chunks of that pack held in memory                                                         |
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

`pack` needs `bun scripts/bake/opcache.ts` first and mounts nothing without it. It loads the baked cache as a second layer and cuts a cold render's object CPU by roughly 500-900 ms (deployed, n=8 per arm, with the levers swapped between deploys as a control). It holds 8.58 MB more of the isolate, and the visitor's wall time did not follow the CPU across the swap. Re-bake after any driver or composer change: scripts are never revalidated against their source, so the mount refuses a layer baked from other sources.

### `VIRTUAL_CLOCK`

| value       | what it does                                                                                |
| ----------- | ------------------------------------------------------------------------------------------- |
| `0`, `off`  | PHP reads the platform clock                                                                |
| unset, `1`  | default; PHP's clock advances with work inside a run                                        |
| `frozen`    | a measurement arm: PHP's clock holds still for a run, which reproduces the platform locally |
| `simulated` | a measurement arm: `1` over a platform clock that holds still, so a local run is repeatable |

`VIRTUAL_CLOCK_KAPPA_MS` sets how many milliseconds of PHP time one call across the host boundary costs. The default is 0.13.

A deployed worker advances `Date.now()` and `performance.now()` only when I/O completes, so inside one synchronous `php._run()` PHP's `time()`, `microtime()`, `hrtime()` and `gettimeofday()` do not move. Every loop that waits for a deadline then runs to the end of its work. Core's queue loop in `Cron::processQueue()` ends when `time()` passes its 15 second lease, so a queue drains whatever its size. Batch API ends a progressive request when `Timer::read()` passes 1,000 ms, so only the operation cap in `cfw_batch_yield()` ends one. `uniqid()` polls `gettimeofday()` for a new microsecond and spun for 302,500 ms on a deployed worker; a stand-in replaces it and stays.

With the flag on, the clock returns `max(platform, base + calls * kappa, last + 1 microsecond)` capped at the platform clock plus 60,000 ms. `calls` counts the glue's host-call imports (SQL bridge, file system calls, reads and writes), `base` is the platform clock when the run started, and each `_run()` starts again from the platform clock. A parked run, which is several `_run()` calls, therefore restarts at each slice. The worker's own TypeScript reads `Date.now()` and `x-worker-ms` as before; only PHP's view changes.

Measured on a local workerd, with the platform clock held still:

| probe                                            | clock held still | `VIRTUAL_CLOCK=simulated` | `VIRTUAL_CLOCK` off, local clock |
| ------------------------------------------------ | ---------------- | ------------------------- | -------------------------------- |
| `Cron::processQueue()` over 2,400 items          | 2,400 processed  | 275 to 284 processed      | 2,400 processed in 2.5 s or more |
| `_batch_process()` over 200 operations           | 20 operations    | 4 operations in 1.31 s    | 20 operations                    |
| poll for a new microsecond, bound of 1,000 reads | 1,000 reads      | 1 read                    | 530 to 1,000 reads               |

The queue figures are n=3 for every arm and the batch figure for the virtual arm is n=2, each item costing 400 file system calls. The default of 0.13 is the median of nine warm Drupal renders (range 0.085 to 0.164 ms per call, a first render 0.107), taken as local elapsed time over counted calls. It was not calibrated on a deployed worker.

Two limits follow from counting calls. Work that makes no host calls does not advance the clock, so a worker that burns CPU in pure PHP between calls is under-counted and the old behaviour returns for it. And the figures PHP reports from this clock, such as `renderMs` and the `x-cfw-render-ms` header, are modelled and never a CPU measurement; an absolute CPU figure still comes from `cpuTime`.

A write made while the clock runs ahead carries the later time. A row cached for an hour, a state stamp or a queue lease stamped in a long run reads up to the run's overshoot, never more than 60 seconds, later than the platform's time. Core's database cache and `CfwCacheBackend` judge expiry against the request time, so they are unaffected inside a run; `CfwMemoryBackend` judges it against the clock, and an entry with a 2 second life set before four seconds of work is gone after it, as it would be on a platform whose clock moved. `CfwLockBackend` never reads the clock.

### `ANACHRON_RETURN_TYPES`

Module code written before core typed a method fails to load on a current core: a class that extends `ItemList` or `Map` and declares `offsetExists($offset)`, `getIterator()` or `count()` with no return type is a fatal ("Declaration must be compatible"). When a module's files are stored, through `/install`, `/install-lock`, `/modify` or `/git`, the worker adds the return type core declares to each such method in a module, theme or profile file. It also narrows a declared type that is wider than core's, such as a `normalize()` that declares `ArrayObject|array|string|int|float|bool|null` where core declares `array`, but only when every `return` in the method is provably core's type from its tokens (an array literal, an `array_*` call, an `(array)` cast, `parent::normalize()`, or a variable assigned only from those). It changes no line count and leaves a method alone when it cannot show the type is right: a bare `return`, a literal of another type, a body that never returns, a different parameter count, a non-public method, or a parent class it cannot read. Each of those is named in the receipt.

The rewrite is on unless the variable is `off`, which stores the files as delivered. Files under `vendor/` and `libraries/` are never rewritten. The integrity record of a rewritten file holds the digest of the stored bytes, since those are the bytes that run. The archive digest a registry publishes is checked before anything is unpacked, so it still covers the original archive.

The `/install` receipt, a `/modify` commit and a `/git` pull carry `returnTypes`: `files` changed, `methods` typed, `refused` as a count and `refusals` listing the first 25 with path, class, method, line and reason. A plan compares the stored rows with the files as they will be stored, so a second identical `/modify` commit or `/git` pull reads every file as unchanged and writes no row.

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

`BOOT_IMAGE` boots a cold object from a heap image published with the worker, where a plain boot builds that heap from the database. It is on by default; `BOOT_IMAGE=0` turns it off. On a deployed claimed site a cold round took 1,105 ms of object CPU from the image against 2,527 ms plain (n=7 per arm, 2026-10-23). `bun run assets:bootimage` bakes it into `assets/bootimage/`, and `bun run build:local` runs that step whenever a published index names another interpreter than the one on disk.

When a site matches the image, the image restores before the site's own stored heap (`HEAP_SNAPSHOT`) is tried, so a site that keeps its own heap image boots from the shared one unless `BOOT_IMAGE=0`. A WordPress or Joomla site, a replica and a site that has not finished migrating always boot plain.

A restored boot starts with the memory the image was baked in (about 1,375 pages for the pack image, against 1,024 for a plain boot), so it gives up headroom on a fresh isolate in return for the CPU. Only sites that match the bake restore it, which means stock module sets; a site with its own modules boots plain.

A boot restores an image only when the site equals what the image was baked from: the pack generation and enabled modules, the driver digest, a digest of the `config` rows, and a digest of the settings and PHP fragments the heap was built under. Any difference boots plain, which is always correct, so a stale image costs a plain boot. Two images are published. The `pack` image is for a site the pack made. The `claimed` image is for a claimed site and carries `config=reset` in place of the digest, because every claimed site has its own name, mail and timezone; its restore also resets the config factory and the entity memory cache.

A claimed site restored from the `claimed` image does not yet behave like a plain boot, so set `BOOT_IMAGE=0` on a claimed site until that is fixed: an account without the owner tier could give itself the owner role, a site that selects the GD toolkit by hand built no image derivatives, and an uploaded theme was not rediscovered.

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

### The pack in the object's storage

`COLD_PACK` is on unless `0`, except for WordPress on the free plan, where it is off until you set it to a value other than `0`. An explicit value always wins. The exception follows from the row meters: every WordPress request mounts a fresh interpreter, so a staged pack adds 147 to 281 row reads to each PHP request (189 rows become 354 on a search page, n=3 objects, no spread), and the free plan's 5,000,000 daily rows read then allow 14,124 renders instead of 26,455, a loss of 46.6%. The 6.6 MiB it frees does not bind for WordPress, whose idle interpreter holds about 73 MiB. Drupal keeps the pack in storage on every plan, and WordPress does on the paid plan. When it is on, the first mount copies the 13,012,361-byte Drupal pack, or the 7,417,841-byte WordPress pack, from its assets into its own storage as rows of 64 KiB (`cfw_pack_chunk`, one `cfw_pack_root` row), refusing a copy that is not the pinned digest, and the lazy mount then reads files from those rows and keeps `COLD_PACK_CACHE_CHUNKS` of them (8; at most 64) in memory. `bun run gen:core-pack` pins both digests, so it runs after `assets:pack` and after `assets:wordpress`; a pack that does not match its pin is mounted from assets and logged on every boot. The pack stops being resident in the isolate. Headroom measured on Thunder's flush path is about 14 to 21 MiB (n=3 on Paid).

When the env sets no `LAZY_FS_BUDGET_BYTES`, `COLD_PACK` mounts with 4 MiB instead of the cartridge's 20 MiB, the value both shipped configs already carry. An explicit value wins.

Rows are keyed by the pack digest. A worker with a new pack stages its own rows on the next mount and then deletes the earlier pack's rows, so an upgrade leaves one copy. A chunk that fails its hash on read drops the root row, and the next mount stages again. A pack that cannot be staged mounts from assets as before.

Measured locally on stock Drupal with `tests/integration/pack-residency.spec.ts` (three objects per arm, no spread in any cell): the pack accounts for 12.41 MiB of what the mount holds with the flag off and for at most the cache (0.5 MiB at 8 chunks) with it on. Staging read 834 rows on the first boot and wrote 406 more than the flag-off arm. A cold page after an interpreter drop reads 218 more rows on the front page, 255 on `/admin/content` and 509 after a cache flush, which is 7.5% to 11.7% of the page's rows, and a warm page reads none. Caching 32 chunks cuts the front page's 218 to 155 and 64 chunks cuts it to 93, at 2 and 4 MiB resident, so 8 stays the default. The resident file budget costs almost nothing in rows: at 20, 12 and 8 MiB the arms are identical because no route here holds more than 6.34 MiB; at 4 MiB only the flush path evicts (650 files, one re-read), at 2 MiB the flush path re-reads 74 files and 26 more rows on a warm repeat, and at 1 MiB 129 files and the same 26 rows. Re-inflation costs CPU, which a local run cannot price, so the default stays at 4 MiB until a deployed run reads it. Nothing keeps a copy of the pack outside the rows: after the staged arms the pack cache had fetched the pack index once and the pack itself never.

The mount only reads the source when the cartridge supports it. `@drupflare/cartridge` 0.3.1 ignores it, so a deploy built against that version stages nothing and behaves as `COLD_PACK=0` until the cartridge release that reads `SQL_PACK_SOURCE` is the one the worker depends on.

| per object (local row meters, n=1 per arm; Paid prices from the list rates) | value                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| rows written to stage                                                       | 403 (199 chunks at 2 rows each, plus the table and root rows)                              |
| bytes stored                                                                | +13,148,160 (12.5 MiB)                                                                     |
| rows read at a cold boot                                                    | 7                                                                                          |
| rows read by the first page after a staging mount                           | 696 (271 with 64 chunks cached)                                                            |
| rows read by a cold page after a drop                                       | 387 (157 with 64 chunks cached)                                                            |
| rows read by a warm page                                                    | 0 to 1                                                                                     |
| Free: rows written per day (limit 100,000)                                  | 0.4% once per object                                                                       |
| Free: storage (limit 5 GB per account)                                      | 0.26% per object, about 380 objects                                                        |
| Paid: staging                                                               | $0.0004 once (at $1.00 per million rows written)                                           |
| Paid: storage                                                               | $0.0026 per object-month (13.15 MB at $0.20 per GB-month, before the 5 GB-month allowance) |
| Paid: a cold page                                                           | $0.0000004 (at $0.001 per million rows read)                                               |

A replica lane stages its own copy, so 32 lanes hold 32 copies (about $0.08 per month on Paid). The staged tables are local to each object and are never copied by a replica restore. A cold page costs no measurable time: 256 ms against 230 ms with the pack resident on one paired pass, inside the run-to-run spread. The boot image is unaffected, since the image restores a heap and the mount underneath it reads bytes either way.

An earlier build kept the pack in storage and was removed because it did not move Thunder's memory resets (three paired deploys per arm, 29 reset retries against 9, spread 0 to 19). This default is for the memory headroom above; the reset rate with it on is not measured on a deployed site.

### The Headroom Ladder

`LADDER_PROBE=1` turns on `/ladder`, an owner route for measuring how much memory an isolate holds before the platform replaces it. Each POST allocates and touches one 4 MiB buffer, keeps it for the isolate's life, and answers the isolate id, the total held (`totalMiB`), the interpreter's linear memory and the spare memory a dropped interpreter left behind. Without the variable the route answers 404, and any method but POST answers 405.

The route takes the site's owner token like the other owner routes and has no diagnostics fallback. The headroom is the total held by the last rung that still reported the first isolate id. `scripts/measure/ladder-arms.ts` drives it: it recycles the object, runs one of four arms (nothing, a booted site, an admin page, a cache flush), climbs until the id changes, and throws if 80 rungs pass without a replacement. Leave the variable off on a site that serves visitors, because a ladder run ends by getting the isolate replaced.

### Releasing a dropped interpreter

A dropped interpreter keeps its filesystem graph alive: the `Module`, the `FS` tree and the pack bytes of every lazily loaded file. On a deployed probe worker, eight collections nudged by 16 to 64 MiB of external buffers freed the `php` wrapper and nothing else of that graph. With the release on, the graph root and the largest file buffers were collected within one 12 to 28 MiB nudge in all 12 gated runs and 2 calibration calls. The `Module`, `FS` and name table shells stay, and what holds them is unknown.

`RELEASE_HOST_GRAPH` is on unless it is `0`. The release unlinks every node under `/drupal` from the name table, detaches the bytes of clean lazy files and empties the stream slots. It runs only for an interpreter nothing can run in again: not while the instance still holds parked outbound sockets, and not for an interpreter another instance of the object adopted. A build whose `FS` lacks the members it walks is left to the collector. Set `0` to turn it off without a code change.

A restart of PHP inside a dropped interpreter, and a mount kept across such a restart, were tried and removed. The restart read 0 of 18 reset pages on flush and cron against 17 of 18 without it on one object, then 2 of 24 against 3 of 24 on a second, so the benefit did not replicate. It also kept the heap: an install then a boot peaked at 231.5 MiB restarted and 98.1 MiB in a new instance.

**Changing `LAZY_MOUNT`, `MIGRATE_ENGINE` or `SITE_DB_PREFIX` in a deploying config means changing `assets/.assetsignore` too.** The shipping asset set is derived from the canonical values of those three; `tests/unit/runtime/assets-ignore.spec.ts` fails when the two disagree.
