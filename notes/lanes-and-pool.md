# Replica lanes, the pool and the host comparison

The pool eviction history, lane state, throughput, and the VPS and host arms. Moved verbatim from the project CLAUDE.md.

## There is a VPS arm now, and the headline ratio was an instrument error

`docker/vps.yml` is nginx plus PHP 8.5 FPM with opcache and tracing JIT, against the SAME
`drupal-src` tree and the SAME `assets/drupal/site.sqlite` this project serves. `bun run vps:up`,
then `bun run measure:vps`. Bodies agree to 10 bytes, and the generator's own ceiling is 7,330 req/s
so it constrains neither arm.

**MOUNT `drupal-src` READ-ONLY, and this rig learned it the hard way.** The first version bind-mounted
it read-write; the entrypoint wrote its own `settings.php` into
`drupal-src/sites/default/settings.php`, which is the build input for the shipping pack, and
`twig-bake.spec.ts` went red on a tree nobody had edited. That is the same silent-drift shape as the
`cdn-manifest.json` restore overwriting a tracked artifact. The site directory is a separate writable
volume now. Recovery, if it happens again: the installer's output survives at
`drupal-src/sites/build/settings.php`, so copy it over and re-run `node scripts/patch-drupal.mjs
drupal-src` to re-append the twig `php_storage` pin.

Measured 2026-09-07, both arms on localhost: anonymous cached p50 **3 ms VPS against 2 ms drupflare**
and p95 **49 against 4**; at 32 clients the VPS collapses to 122 req/s while drupflare holds 438; a
re-render on a tag-invalidated page is **24 ms against 30** on the arms' own server clocks, n=25.

**THE AUTHENTICATED ARM'S FIRST READING WAS MEASURING A TIER THAT COULD NOT RUN.** It read 9 ms VPS
against 31 drupflare. The rig was discarding `x-cfw-plan`; capturing it showed `skip:set-cookie` on
six consecutive authenticated GETs, because `planEligibility()` refused any response carrying
`Set-Cookie` and PHP re-sends the session cookie on every `session_start()` when
`session.cookie_lifetime` is non-zero, which Drupal ships at 2000000. The compiled-plan tier had
never compiled a plan on any site, and 25 assertions covering it all passed a synthetic
`setCookie: false`. **Capture the tier header before believing a latency number from this rig.**

With that fixed, plus a `csrf` slot and a private key for a single-editor site, a session converges at
request 4: `/` 11 ms VPS against **5 ms**, `/admin/content` 71 against **5**, `/user/1` 56 against
**5**. Under concurrency drupflare wins every cell but one tie and holds ~312 req/s flat from c=4 to
c=32 while the VPS declines. Use `--ceiling-path` for the generator control: the arms share no no-work
endpoint, and `/robots.txt` is a deny-list 404 on drupflare that reads 109 req/s against the
generator's real 1,231.

**THE "225x" AN EXTERNAL REVIEW COMPUTED IS THIS PROJECT'S OWN SIGNATURE ERROR.** It divided the
2,127 ms edge `cpuTime` for a BOTH-BINS-EMPTIED render by the 9.47 ms native WARM-KERNEL render: two
workloads, two instruments, two machines. Same machine and same bins, a re-render is **1.21x**.

**AND THE 1.28x THAT NUMBER REPLACED WAS ITSELF TAKEN THROUGH A BROKEN ARM, all three parts of it.**
`renderArm()` drove `/bump` then `/fill` and timed a bare `/fill`: the bump arms the fill alarm,
`fetch()` holds the gate, so the timed call waited behind that batch and found an empty queue -- six
of seven samples answered `{"filled":null,"remaining":0}`, so the figure was gate-queue time and not
a render. The VPS side meanwhile rendered a DIFFERENT PAGE, because `vps-db` is a docker volume
`vps:up` does not re-seed and it held an earlier run's content: 23,284 bytes and ten teasers against
17,692 and none. Nothing guarded either half, and the render cells ran in fixed arm order while the
curve cells rotate. **Run `bun run vps:down -v` before a comparison, and check the two bodies agree
before believing any ratio.**

**A SAVE DOES NOT PURGE `dynamic_page_cache` WHOLESALE, so the 1.21x describes fewer pages than it
looks like.** `bumpGeneration()` leaves that bin alone on the `cachetags` reason; only tag-matched
entries die. Every other re-queued page renders from a warm dynamic page cache at **22 ms against the
VPS's 24**, which drupflare wins. The old rig purged the whole bin and measured the worst case as
though it were the common one.

Three things the rig cannot say, and each has bitten a comparison before:

- **Localhost is the VPS's best case.** A VPS is one region; drupflare answers from the visitor's
  colo. The network term is absent and must be added back before an end-to-end claim.
- **`wrangler dev` is one local workerd**, so throughput there is a property of the laptop. Absolute
  CPU still comes only from `cpuTime` on a deployed worker; what this gives is a same-machine RATIO.
- **The authenticated arm ran with no replica lanes and no compiled plan.** A plan is 0 ms median and
  max, n=57 deployed, and a shared plan needs two sessions in a role set to agree before it
  compiles, which one benchmark client never gives. A single-editor site gets a private plan keyed
  to its own session instead (`privatePlanKey()` in `src/ops/edge-plan.ts`), so this arm's missing
  plan is the rig's, not the product's.

## THE POOL EVICTED ITSELF, AND THREE INSTRUMENTS HAD TO BE BUILT BEFORE THAT WAS READABLE

Found 2026-09-19 on a deployed 32-lane site. Under ordinary authenticated load every lane cycled
`SERVING -> WITHDRAWN -> CREATED -> full restore -> SERVING`, so the pool answered **0%** and the
primary carried all of it, while `/serve-stats` reported lanes at the head generation with
`refusals: 0`.

**`malformed()` required `record.generation === record.parent + 1`, and that was never the
invariant.** `sealGeneration()` seals ONE record per INVOCATION -- it opens a buffer at `parent`,
lets the invocation advance `commitSeq()` as far as it needs, and seals at whatever it reached; its
own docblock says why, that twelve rows written by one request are one atomic change from a
replica's point of view. So `parent + N` is the normal shape, and the shipped log held **360 records
across generations 30..901**. The first skipped generation answered `the record claims 901 -> 903,
which is not one step`, `catchUpOnce()` turns a refusal into `WITHDRAWN`, and readmission turns that
into `CREATED`, which refuses every request until the primary re-copies the whole database.

The real chain check already existed and is exact: `planApply()` refuses a record whose `parent` is
not precisely the replica's applied position, in BOTH directions. Contiguity of the numbers was a
second and wrong statement of the same rule.

**Two wrong diagnoses came first and both are cheap to repeat.** The code comment at the withdrawal
site says "an overflowed record is the common case here", which reads as the answer -- 0 of 360
records were overflowed. And the window 30..901 holding 360 records looks pruned; it is sparse.

**Nothing could name the cause until three instruments existed**, and each hid it differently:

- **`x-cfw-replica` named the ROUTING DECISION, not the serving object.** A lane that refuses hands
  back and the primary re-serves, and the header still named the lane -- so a pool serving nothing
  read as one carrying the traffic. It names the answering object now. A spec was PINNING the old
  behaviour with a comment admitting it, which is the shape to watch for.
- **`x-cfw-failover-reason` did not exist.** The lane's 421 carries `x-cfw-requires-primary` and the
  retry discards it. The reason read `serve`, not `session`, which is what redirected the search.
- **`lastCatchUp` is overwritten by readmission** before anyone can read it. `lastWithdrawal`
  survives, and it printed the sentence that ended the investigation.

**THE ROOT CAUSE WAS `parent: this.commitSeq() - 1` IN `bufferForReplication()`, and the two fixes
above did not stop the churn.** That subtraction assumes the invocation will seal at exactly the
current sequence; `sealGeneration()` seals at whatever the sequence reached by the END of the
invocation, so a buffer opened at 69 could seal as `{parent: 68, generation: 70}` while record 69
already chained from 68. Two records claiming one parent, and a lane on the first met the second as
`out of order: applied 69, record builds on 68`. The parent has to be the LAST SEALED RECORD, which
is by definition where a caught-up replica sits -- that makes `planApply()`'s
`record.parent === pos.applied` exact by construction rather than by luck.

Measured on one 8-lane site, same workload, before and after:

| arm    | rps c=16 | lanes served | rps c=64 | lanes served | lanes withdrawn |
| ------ | -------- | ------------ | -------- | ------------ | --------------- |
| before | 2.5      | 0.0%         | 2.4      | 0.0%         | 8 of 8          |
| after  | 4.8      | 88.8%        | **10.5** | 79.4%        | **0**           |

**8.1x over the 0-lane baseline at 64 clients**, zero failovers, all eight lanes still SERVING
afterwards. Three off-by-one assumptions about the log's own shape, in three files, cost the entire
replica feature.

**AND THE WITHDRAWAL POLICY IS WHAT MADE EACH ONE AN OUTAGE.** `catchUpOnce()` answers ANY refused
record with `WITHDRAWN`, readmission sets `CREATED`, and a `CREATED` lane needs a full 4.7 MB
re-copy -- so a positional disagreement gets the same response as database corruption. `autoScaleStep()`
then repairs ONE lane per alarm at a 4,000-row budget, so eight withdrawn lanes take dozens of alarm
cycles to return while the primary copies instead of serving. The policy is unchanged; it simply has
nothing to fire on now.

## A LANE PINNED ITS OWN ORIGIN, SO IT COULD NOT SEE ANY SESSION

Same day, same site. Drupal derives the session cookie NAME from the request host --
`substr(hash('sha256', $request->getHost() . $base_path), 0, 32)` in `SessionConfiguration` -- and
`canonicalOrigin()` pins trust-on-first-use PER OBJECT. A lane is its own object, so the first
request to touch one fixed its host forever. Every lane had pinned the load generator's
service-binding URL, looked for a cookie no browser sends, and rendered uid 0 while holding every
replicated session row.

The control, same cookie and same second: a lane with the pin repaired answered 200
`administrator,authenticated`; one left alone answered 421 `x-cfw-requires-primary: session`.

The origin is authoritative SITE state, like `system.private_key`, so a replica INHERITS it on the
first restore chunk and `canonicalOrigin()` refuses to pin on any `isReplica()` object.
**`isReplica()` rather than `isPoolLane()`**: a var-configured replica has the identical defect, and
the narrow predicate made the falsification run pass, which is what exposed it.

**A measurement rig can write a fact into the product it is measuring.** The generator's comment said
"the host is arbitrary over a service binding". It is not, and nothing else in the system would ever
have written `arm.invalid` into a site.

## A FRESH SESSION IS NOT ON ANY LANE, and the fix must not be awaited

Replication is alarm-driven, so a session written on the primary reaches a lane on ITS next firing:
measured, `head` 735 against every lane at 733, converging over **20-62 s**. A drive with a fresh
cookie read 100% failover against 25% lane share with a replicated one.

`sessionReach()` asks BEFORE the render, so a miss costs one indexed read rather than a render thrown
away, and it nudges one catch-up. **The nudge is NOT awaited, and awaiting it was measured harmful**:
it is a hop to the primary taken from inside a serve, so under 64 clients every lane that missed
queued behind the object the pool exists to relieve and errors went 21 -> 134 on the same drive.
Scheduled instead, convergence is 1 of 6 lanes at round 1 and 6 of 6 by round 4.

It is rate-limited because the cookie is attacker-supplied, which is the amplification shape
`adminSessionBudget()` removes one door over.

**The first version of its test could not fail.** It stored the session row under the same function
it later looked the row up with, so returning the cookie value unhashed kept it green. A golden
vector off a deployed site fixed that: `78e094846386248b8a5685a8a2dd4568` hashes to
`TIkEn6fkVm-NaFDE5eDlIfIXxgfFJXI2XRRnMxjurwI`, which is the row Drupal itself wrote.

## NO SAVE HAD EVER COMMITTED THROUGH A LANE, AND THE LANE SAID IT HAD

Found 2026-09-24 on two deployed 3-lane pools: twelve node creates answered `303` from a lane and
none existed on any object. Five defects in a chain, each hiding the next; the roadmap's
Write-Forwarding section lists them. Two rules out of it:

- **A response built before a side effect is confirmed must not survive the side effect failing.**
  `flushForward()` runs after `handle()`, so its refusal was recorded in a field nothing read and the
  visitor got the save's redirect. It throws `ReplicaRequiresPrimary('forward', ...)` at the end of
  the gate now, and the primary re-runs the request.
- **Anything signed with a site secret must use the site's secret.** `hash_salt` sits in `cfw_meta`,
  which is lane-local, so every lane minted its own and every form token crossed objects invalid. It
  rides the restore now, beside the origin. `private_key`, the origin and the salt are the three;
  check for a fourth before adding lane-local state that signs anything.

Measure a pool write by reading the PRIMARY afterwards, never by the status code: a `303` from a lane
was exactly the lie.

## A PLAUSIBLE CAUSE THAT FITS THE SYMPTOM IS THE EXPENSIVE KIND OF WRONG

The 2026-09-14 replica arm came back with lanes 1 to 3 answering nothing, and it was written up --
here, in the roadmap, in a memory file and in two docblocks -- as affinity: an anonymous one-machine
generator keys on its own address and cannot spread across a pool. That mechanism is real, it is
reachable by reading `affinityKey()`, and it is NOT what happened. The arm drives AUTHENTICATED
requests, which key on the PATH, and running the router's own FNV-1a over its eight paths covers
**4 of 4 buckets at 3 lanes**. The cause was admission, above.

Two rules out of it. **Where the question is arithmetic, compute it against the real function**
rather than inferring it -- twenty lines settled what four documents had asserted. And **count the
distinct objects in `x-cfw-replica` AND check the lanes reached `SERVING` before attributing a pool
reading to routing**; a fitting explanation ends the investigation, which is what makes it costlier
than no explanation at all.

**The affinity fact still holds for ANONYMOUS load** and is measured: a one-address drive answered
`{r3: 662}`, one object for every sample. `v101-arms.ts --clients=N` presents N synthetic addresses,
honoured by a local `wrangler dev` only.

**A SCHEDULED ALARM FIRES BY ITSELF IN THE WORKERS POOL, so an assertion taken after
`runDurableObjectAlarm()` races whatever that firing re-armed.** Verified: a `+300 ms` alarm raises
`alarmFirings` with no `runDurableObjectAlarm` call at all. `heap-image-producer.spec.ts` asserted a
queue was still queued after the imaging firing, which re-arms at +1,000 ms; the second firing images
nothing and therefore fills, and the spec passed alone and failed in a full run. Cancel the armed
alarm (`ctx.storage.deleteAlarm()`) before reading, and take every reading in ONE `inObject` round
trip -- a second round trip is a second wall-clock window.

**THAT FIX DID NOT CLOSE IT.** With the alarm cancelled, one full run on 2026-09-25 still failed the
same spec one assertion earlier: `heap_image_gen` null, so the counted firing never imaged. It passed
alone, in a loaded six-file run twice, and in the next full run. The assertion now prints the alarm
outcome, the `HEAP_IMAGE` flag the instance holds, the attempt key and the firing count, so the next
failure says whether the firing reconciled, lost the flag with its instance, failed the heap read, or
hit the attempt cap.

**AND NEVER RUN THE RIG BESIDE A VITEST RUN.** `wrangler dev` died mid-measurement under 24
concurrent while the gate had the memory, which this file already records for `bun run test` and is
equally true of a background agent running one.

## One object is not a site-wide throughput ceiling

A Durable Object is single-threaded; a SITE is not, because a namespace holds unlimited objects.
Measured on a throwaway rig with a fixed CPU burn, concurrency scaled with the pool so per-replica
offered load stays constant: **1.00 / 2.05 / 3.16 / 5.72x at 1 / 2 / 4 / 8**, p50 flat throughout,
zero errors. Little's Law closes at 1 and 2 and opens a gap at 4 and 8, so something above the
service-time path constrains aggregate concurrency past N=2 -- **not attributed**, and 16/32 are not
worth building until a distributed generator separates the load generator from the topology.

**SUPERSEDED FOR THE REAL PRODUCT, 2026-09-19.** That curve is a synthetic CPU burn on independent
objects. Driven through the front worker against real Drupal renders, with the six defects in
`## THE POOL EVICTED ITSELF` closed, a pool reaches **3.12x at 16 lanes** on served count over a
fixed window at 64 clients, p50 falling 3549 ms to 1129, with zero failovers. The generator runs
INSIDE Cloudflare (`scripts/measure/loadgen-worker.ts` fanned across sub-invocations), which is the
distributed generator this paragraph was waiting for.

**AND THE RIG WAS WRONG SIX TIMES BEFORE THE CURVE MEANT ANYTHING**, which is the part to carry: a
12-path workload reaching ~12 buckets however large the pool, a `requests` field that is a TOTAL
across shards rather than per shard, no settle after seeding, `/node/N` against a container with no
nodes, a failed settle read counting as settled, and `applied >= head` as a settle criterion that
cannot converge while the primary still seals meter rows. Every one produced a plausible curve.
Before recording that a pool does not scale, price the rig.

**An authenticated GET writes no authoritative state under this SAPI**, which is what makes any of it
possible. No `sessions`, no `users_field_data.access`, no `flood`. Core throttles the access write by
`session_write_interval` on `KernelEvents::TERMINATE`; here it never fires at all because this SAPI
does not dispatch terminate. Nothing depends on that by design, so
`tests/integration/replica-invariant.spec.ts` is its only guard.

**AND A LOW-RATE INTERMITTENT IS A PROBABILITY BEFORE IT IS LOAD.** `replica-invariant.spec.ts`
failed twice across sessions with `{ table: 'sessions', statements: 1, rows: 0 }`, passed alone, and
was filed as suite contention. It is `session.gc_probability = 1 / gc_divisor = 100` from
`core/core.services.yml`: PHP sweeps `sessions` on ~1% of `session_start()` calls, and a full gate
gives the coin more throws. Forcing the sweep reproduces the signature byte for byte, so no repeated
full run was needed. `expiryGcTable()` absorbs it -- the host already performs the identical delete
from `EXPIRED_ROW_RULES`, so a replica running it converges on the same set the primary does, while a
session ROW write stays authoritative.

**`cacheTagsIn()` READ ONLY A POSITIONAL ARRAY, so it missed every invalidation after a tag's
first.** `Connection::merge('cachetags')` compiles to a SELECT then an INSERT or an UPDATE. The
INSERT binds positionally (`[1, 'node_list']`) and was recorded; once the row exists every later
invalidation takes the UPDATE branch, which binds by NAME
(`{':db_condition_placeholder_0': 'node_list'}`), and an object is not an array. Measured on a
populated site: a node save moved `node_list` from 1 to 4 while the host recorded only `node:20`, so
`/` and `/node` were never purged and the front-page listing stayed stale. Three menu-item saves
moved `config:system.menu.main` and purged nothing, and a repeat term save recorded no tag at all,
where `flushTagPurge()` returns early on an empty set and drops the invalidation rather than widening
it. Reading the VALUES of a named map is the fix; the filters are what keep a placeholder name out.

**And scoped invalidation's ~11x does not reproduce.** Measured per save kind on a populated site
(30 nodes, two terms, three menu links, 34 filled paths), n=3: an ordinary node save invalidates
**5** pages, a term save **2**, and a save the main menu references **34**, which is every cached
page. The wholesale arm is 25 requeued against 34 invalidated, not the 55 the old arithmetic
assumed. So the ratio is **5.0x for an ordinary node save, 12.5x for a term save and 1.0x for
anything the main menu touches** -- scoping buys nothing on the shape an editor hits most. One ratio
cannot describe a save; the surviving objective is cheaper regeneration for menu-touching saves.

**A setup session is 32,641 rows, not 104,451.** Five installs plus two heap images on one site,
`dailyRows()` per step: migrate 3,397, firstrun 7,886, then 3,364 / 1,140 / 3,551 / 5,364 / 7,642,
and the two images **268 rows between them**. 32.6% of the daily quota and the site never leaves
`normal`. Whatever produced 104% of quota was not this workload, so do not cite it as that.

**Classify the EFFECT, never the route and never the table.** Both cheap classifications were measured
wrong on the same page:

- `/admin/reports/status` wrote only `key_value` against a warm fetch cache and also `watchdog` against
  a cold one, because the advisories fetch failed and Drupal logged it. `watchdog` appears on any
  authenticated GET that logs.
- `key_value` holds the disposable `update_fetch_task:*` queue **and `state:system.private_key`**, which
  Drupal mints lazily and keys CSRF tokens on. Two replicas each minting their own issue tokens the
  others reject, so it must arrive by replication and may never be generated on a replica.

`src/ops/replica.ts` is therefore two allow-lists and no deny-list, and it walks the capabilities
INSTALLED on the module rather than a list -- `cfwOidcClaims` and `cfwTcp` had both drifted out of
`CROSSING_NAMES` and both mutate.

**Three load-generator errors each produced a confident wrong curve**, and all three are cheap to
repeat: a `while (Date.now() < until)` CPU burn never terminates because the clock is frozen between
I/O; a shared-counter round-robin distributes unevenly and reported a completely FLAT curve; fixed
concurrency gives every arm a different per-replica load, so N=1 collapsed at 160 connections while
N=8 was never saturated. Always measure the generator's own ceiling against a no-work endpoint first
-- here it was 958 req/s, which is what makes the rest mean anything.

**AN EARLY RETURN INSIDE A BATCH SKIPS EVERYTHING WRITTEN AFTER THE LOOP.** `catchUpOnce()` applies
a batch of records and then does two things: `metaSet(COMMIT_SEQ_KEY, applied)` and
`purgeAfterApply()`. Its refusal branch returned from inside the loop, so a batch of
`[appliable, overflowed]` applied the first record's statements and reached neither -- the lane kept
the pages that save invalidated and reported a commit sequence behind the state it holds. A refusal
ends a batch; it does not undo the records ahead of it. Both now run on that branch when
`applied > position.applied`.

**The local gate could not produce it and CI could.** An overflowed record is sealed when a change is
too large to log statement by statement, so the shape depends on what a save touches, and the pack
lane's from-source pack is a superset of the shipped one. `replica-catchup.spec.ts` constructs the
batch deterministically instead of waiting for one: seal a real save, then insert an `overflowed = 1`
row at `generation + 1` straight into the primary's `cfw_repl_log`.

**Two things about the diagnosis are worth more than the fix.** It was reached by exhaustion rather
than by pattern-matching: CI asserted `records > 0` and passed, then failed the purge assertion, and
exactly one path in that function applies a record without purging. And the first hypothesis was
inert -- `outcome.action === 'apply'` and `outcome.applied > before` are the SAME condition, because
`planApply()` returns `apply` only when `record.generation > pos.applied` and the apply then sets
`applied` to it. Reverting that change altered nothing, which is what exposed it as a guess.

## The end-to-end host comparison exists, and every cross-arm number it gave is pending

`bun run measure:host` drives BOTH hosts through one matched workload set in ONE process and decides
against a predicate written before the numbers (`scripts/measure/verdict-math.ts`, 23 assertions in
`tests/node/host-verdict.spec.ts`). Every earlier comparison was a human reading two JSON documents
and dividing, which is where "225x" came from.

**IT DROVE `vps` THEN `edge` IN EVERY CELL OF EVERY RUN, so its bias had a direction and pointed at
the arm the rig exists to judge.** Sequential arms are correct and were justified; the FIXED ORDER
was not, and the docblock's reasoning stopped one step short. Anything that drifts inside a cell --
a cache filling, memory pressure building, another job starting -- lands on whichever arm goes
second. This repository had already recorded the identical mistake against the ABI harness: per-arm
blocks read long64 1.5% faster than wasm32 and interleaving read 1.001x. The order rotates per cell
now, and `selfControl()` runs ONE arm as both so a run prints the resolution a cell has to beat.
**The magnitude is unmeasured, so treat the readings below as owed a re-run rather than as refuted.**

**AND CHECK FREE MEMORY BEFORE BELIEVING ANY CELL.** On 2026-09-10 the OOM killer took the full gate
and `wrangler dev` twice at ~60 MB free, and an `auth-admin c=4` reading of 452 ms with errors was
the edge worker dying rather than answering. Never run `bun run test` alongside the rig.

**EVERY EARLIER "WITH LANES" READING DROVE 100% OF TRAFFIC TO THE PRIMARY, so re-measure before
citing one.** `/replica?action=provision` copied a lane, promoted it to SERVING and reported it
ready without ever writing `lanes_provisioned` -- and that key is the only thing that puts
`x-cfw-lanes` on a response, while `replicaCount()` reads only `REPLICA_COUNT`, which the canonical
config does not set. So the router never learned a pool existed. Two more defects sat behind it and
neither was reachable until traffic first met a lane: `affinityKey()` was handed `url.pathname`
AFTER the rewrite, which is the constant `/serve`, and `retryOnPrimary` was `innerRequest.clone()`
under a comment asserting only GET and HEAD could arrive -- an unread tee branch never releases, so
a forwarded POST hung past 240 s. `x-cfw-replica` now names the object that answered; capture it
before believing anything about lanes.

Measured 2026-09-10 on localhost with three lanes genuinely receiving traffic, traffic-weighted p50
**VPS 9.0 ms against 13.4 ms**. `auth-admin` is the standout the other way: **5 ms against 66 at
c=1, 41 against 243 at c=16**, and 361 req/s against 64. Cold path **55 ms against 138**.

One mechanism blocks a yes, and one that used to be listed here is refuted:

- **One Durable Object serializes.** `anon-cached` reads 2/2 ms at c=1 but 6 against 3 at c=4 and 25
  against 4 at c=16, against `pm.max_children = 32`. That slice is 82% of the traffic weight, so it
  decides the verdict alone. **These predate the `cfw_page` seed**: `planRestore()` refused to copy
  the page store, so every lane met anonymous traffic with an empty cache and RENDERED. Within the
  edge arm, c=4 went 405 ms / 6.1 req/s to 6 ms / 510 req/s once lanes arrived holding pages -- see
  `SEED_ON_RESTORE`. The serialization claim is about ONE object and may still hold; what is certain
  is that no reading taken before the seed measured a pool that could serve.
- **REFUTED: "the replica pool and the plan tier fight each other".** The reading behind it -- 0
  lanes reaching `PLAN:private` at request 4 and 3 lanes reading `RENDER` for all eight -- was taken
  on a rig where no request reached a lane, so lanes were not the variable it named. With them
  routed to, the paired curve is `RENDER ERROR PLAN:private x10` and converges at **7 ms against the
  VPS's 69**. The arm reported "NO CELL WAS ANSWERED BY THE COMPILED-PLAN TIER" because it drove 8
  requests and convergence lands at 7, so one ERROR cost a witness; it drives 12 now. Compilation
  does NOT need lane co-location either -- the compile runs in the FRONT WORKER's isolate, and 2 of
  5 trials whose sessions split across two objects still compiled.
- **Still losing `auth-account` (`/user`), and it is ERRORS not latency.** A lane raises
  `RuntimeException: Failed to start the session.` on roughly one authenticated request in ten.
  `fetch()` converts a `ReplicaRequiresPrimary` into the 421 the router retries only when the throw
  unwinds out, and Drupal catches the failed session write first -- so `replicaRefusals`, the field
  that records "this request needed the primary", had three readers and all three were stats lines.
  The wrapper hands off now. **The intermittent did not reproduce under control** (0 in 40 either
  way), so the spec asserts the mechanism and not the rate.

**Localhost is the VPS's best case and that is why the claim direction is safe**: a VPS answers from
one region and drupflare from the visitor's colo, so the missing network term can only move the
result toward drupflare. `--rtt` prices it; the verdict is always taken at rtt=0.

**`x-cfw-site` WAS DECORATIVE** -- present in three measurement scripts and in no file under `src/`,
because site identity is the hostname. Every local `--site` ever passed drove one shared object. The
tells were a never-used id answering `already migrated` and two random ids reporting the same
generation and the same 428 rows. All three scripts send `Host: <site>.localhost` now, and that also
turned a replica `schema mismatch` refusal from "provisioning is broken" into "the shared object was
migrated against an older pack and the lane was right".
