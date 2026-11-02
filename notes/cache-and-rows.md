# Caching tiers and the rows-written meter

Stale tiers, cache bins, and the meters a feature can spend. Moved verbatim from the project CLAUDE.md.

## A meter that is most of what it counts

An idle warming tick charged **three** rows: the `setAlarm`, plus one each for `flushDailyRows()` and
`flushDailyDoRequests()`. On an idle tick the only writes those two have to record are their own, so
the counter sustained itself -- 32,400 rows/day at 8 s, **32.4% of free's daily row budget to count
almost nothing**. `shouldFlushMeters()` gates them on a 60 s interval or 25 pending rows and a tick
now charges 1; `tests/integration/warm-alarm-cost.spec.ts` pins it.

**`FREE_QUOTAS.rowsPerAlarmArm` was 1 and had never been measured.** It came from the published "a
`setAlarm()` is one row written", which is true about the setAlarm and not about the firing. Score a
warming proposal against a measurement, not against the platform's line item.

Two modelling traps came out of fixing it, and both produce a confident wrong number:

- **A cost with its own clock needs its own term.** Folding the meter flush into a per-arm constant
  is right only at the interval it was derived at.
- **The flush is capped by the FIRINGS.** An object waking every 240 s cannot flush every 60 s;
  without the cap the model charged a 240 s chain for 1,440 flushes it never performs. `saturatingSites`
  moved 277 -> 92 because it divided the quota by arms per site and rows per site is no longer that
  number.

## There are TWO stale tiers, and only `x-cfw-edge` tells them apart

`AGED` is the OBJECT answering a page that is stale BY TIME out of its own SQLite, reported with
`x-cfw-aged-ms`. `STALE` is the FRONT WORKER answering a PREVIOUS GENERATION out of `PAGE_KV` after
a content change, reported with `x-cfw-edge: STALE` and `x-cfw-stale-behind`. **Both answer
`x-cfw-cache: KV`**, so a measurement that reads only that header cannot say which mechanism
answered -- and one of mine did not, producing a 265 ms figure filed against the wrong item.

**NEITHER HAD EVER FIRED IN ANY LANE, because the test pool bound no KV at all.** `pageKvEnabled()`
returns false on a missing binding and `readStalePage()` returns null at its first line, so the KV
page tier and the stale-generation serve on top of it were unreachable in the gate AND on the
shipping config at once -- the same shape as `reportToFleet()` returning early on an undefined
`FLEET_DB`, one binding over. `vitest.config.ts` now declares `kvNamespaces: ['PAGE_KV','CONFIG_KV']`
and `wrangler.jsonc` declares both namespaces.

Two things to get right before measuring it, each of which cost a wrong reading:

- **The tier is on for both plans now, and a free site's writes are GRANTED by the object.** It was
  paid-only until 2026-09-24. Free KV allows 1,000 writes a day per account, so the front worker
  stores a page only when the answer carries `x-cfw-kv-grant`, and the object stops granting at
  `KV_WRITES_PER_DAY` (800 on free). A free site past its budget has nothing new to fall back to.
- **The generation pointer is discovered once per 5 s window**, so a request straight after a
  `/bump` is answered from the isolate memo at the OLD generation and the tier never runs. One
  `edge=0` request reaches the object and teaches the pointer forward. It cannot be the assertion
  itself: the KV read and the stale read both sit INSIDE the same `edgeWanted` guard that flag
  turns off.

**MEASURED 2026-09-24 on a paid-account throwaway with `PLAN=free`: the stale serve is p50 93 ms
(n=9, 86-109) and reached the object on none of them. It does NOT beat the object on a warm site.**
The control, the same window with `edge=0`, answered `HIT` at p50 90 ms (n=10, 11-160): after a
`/bump` the object keeps serving its own previous copy, so no render was waiting to be avoided. What
the tier buys there is the Durable Object hop. A cold object and a page with no stored copy were not
measured. Each cycle was a bump, one `edge=0` request on another path, then the read.

## A POOL MULTIPLIES THE ROWS-WRITTEN METER BY THE LANE COUNT

Every row written on a primary is written again on every lane, so N lanes cost N+1 rows. Rows written
is the meter that binds regeneration, and it is also the dominant Durable Object cost on paid --
requests, duration and storage are not close.

**The pool therefore trades rows written for read throughput at N+1 to 1**, which no document said
until 2026-09-19. Every row a lane replicates still spends the row budget regeneration shares, so an
8-lane pool reaches that ceiling nine times sooner. The pool is a lever for READ-heavy sites and is actively harmful to
write-heavy ones; score a proposed pool against the write rate, not only the read rate.

**A scaling ladder is priced by the multiplier, and the arithmetic is available before the run.** A
node save was 299 rows when that ladder ran, so seeding 200 nodes was ~59,800 rows on a primary -- and
a 192-lane arm multiplied that to **11.5M rows for the seeding alone**, before any authenticated
drive. A create is 48 rows now (`ROWS_PER_WRITE`), so the same seeding is ~9,600 and ~1.85M across
193 objects: smaller, and still the number to compute first. Nine arms at 0/1/2/4/8/32/64/128/192 is 431 lanes. Compute that total before provisioning,
and poll `durableObjectsPeriodicGroups { sum { rowsWritten } }` DURING a long run rather than
reading the total afterwards. That query takes `datetime_geq`, not `datetimeMinute_geq`, and its
dimension is `namespaceId` rather than `scriptName`.
