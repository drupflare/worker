# Configuration

Every setting is a `vars` entry or a binding in `wrangler.jsonc`, and every one has a working
default. A deploy that sets nothing beyond what the canonical config already carries serves a site.

Values arrive from wrangler as **strings**, so a boolean is `"1"` or `"0"` and a number is a decimal
string. An unparseable value falls back to the default and never throws: these are read on the
serving path, and a typo must not take a site down.

Three layers decide what a value is, most specific first:

1. **A request parameter**, where the route exposes one (`?prefill=`, `?all=1`).
2. **The `CONFIG_KV` namespace**, for the plan and the eleven levers on
   [Runtime Overrides](#runtime-overrides). No redeploy needed.
3. **The `vars` entry**, then the per-plan default in `src/ops/plan-profile.ts`, then the constant.

## Bindings

`wrangler.jsonc` is the canonical config and declares five of the eight. `PAGE_KV`, `FILES` and
`SEND_EMAIL` are read where they are bound and absent otherwise.

| binding               | kind             | canonical config | what breaks without it                                                               |
| --------------------- | ---------------- | ---------------- | ------------------------------------------------------------------------------------ |
| `SITE`                | Durable Object   | declared         | the Worker has nothing to proxy to; every request fails                              |
| `ASSETS`              | Workers Assets   | declared         | no pack, no driver, no `/core/**`; an object cannot boot                             |
| `CONFIG_KV`           | KV               | declared         | the plan override and the runtime levers are absent; the deployed vars stay in force |
| `FLEET_DB`            | D1               | declared         | the cross-site inventory is absent; a single site does not need one                  |
| `CF_VERSION_METADATA` | version metadata | declared         | the fleet row records `workerVersion: "unknown"`                                     |
| `PAGE_KV`             | KV               | not declared     | the cross-colo page tier is absent rather than broken                                |
| `FILES`               | R2               | not declared     | the page and file mirror drains nothing; the off-Worker serving path is unavailable  |
| `SEND_EMAIL`          | `send_email`     | not declared     | the credential-free mail transport is absent; `api` or `smtp` still work             |

An unbound optional binding always wins over the var that would enable the feature. Asking for a tier
that is not bound is a configuration error, and answering it with a crash on the serving path would
be the wrong trade.

## Site Identity and Origin

| var                  | default              | what it does                                                   |
| -------------------- | -------------------- | -------------------------------------------------------------- |
| `SITE_ID`            | derived, then `site` | which site a request resolves to, when KV maps no host         |
| `SITE_ORIGIN`        | pinned on first use  | the `scheme://host[:port]` Drupal builds absolute URLs against |
| `SITE_LOCATION_HINT` | unset                | which region the site's Durable Object is created in           |

### `SITE_ID`

One object per site, and the object's **name** is the site identity, so a wrong answer here serves a
request from a different site's database. Four layers, in `src/ops/site-id.ts`: a `site:host:<host>`
KV mapping, then `SITE_ID`, then the hostname itself, then the literal `site`.

The two optional layers sit above the derived one because derivation answers for every real host, so
anything below it would be unreachable on exactly the hosts it exists to configure. `localhost`,
`127.0.0.1`, `0.0.0.0` and `::1` name no site and fall past derivation, which is what lets a local
dev server and a deployed site run the same code path.

Set it when one deployment serves one site under a name you choose. Leave it unset when the hostname
is the identity. Changing it after a site has content points the Worker at a different, empty object;
the old one still holds the data.

### `SITE_LOCATION_HINT`

One of `wnam enam sam weur eeur apac oc afr me`, or unset.

Unset by default. Placement follows the first request a site answers, which for a deploy-button site
is wherever the deployer was. Pinning a region on an owner's behalf trades latency for one audience
against latency for every other, so the choice belongs to whoever knows the audience.

It applies when the object is **created**. Cloudflare ignores it for an object that already exists,
so setting it on a running site moves nothing.

An unrecognised value is ignored. The value reaches `SITE.get()` on the serving path, and a hint the
platform rejects would take the site down for the sake of a preference.

KV-overridable through the `settings` key, so a region can be chosen without a redeploy.

### `SITE_ORIGIN`

Every absolute URL Drupal emits is built from the request's scheme and host: the canonical tag, a
form action, a `Location:`, the link in a password-reset mail. The render fragments hardcoded
`localhost`, so a deployed site told every visitor and every crawler that it lived on
`http://localhost`, and a reset link mailed to a user pointed at their own machine.

The inbound `Host` carries no guarantee: an attacker who can set it can move a password-reset link
onto a host they control. So the origin is a property of the **site**, resolved in
`src/ops/site-origin.ts` in this order:

1. `SITE_ORIGIN`, which wins outright.
2. **The pin**, held in `cfw_meta` under `site_origin`. Trust on first use: the first non-local
   origin a site serves is stored, and every later request is measured against it. A forged `Host`
   after the pin changes nothing.
3. The observed origin, when there is no pin; that request is the one that sets the pin.
4. `http://localhost`, only when nothing above produced a usable value.

A bare hostname is accepted and assumed `https`. A full URL is trimmed to its authority, so
`https://example.com/` does not become a double slash in every canonical tag. Only `http` and `https`
are accepted: a `javascript:` form action is why this is an allowlist.

A local origin is never pinned (`localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, `do.local`), so running
the suite or a `wrangler dev` against a persisted object cannot fix a real site's canonical URL to a
developer's laptop.

Set it when the site is reached through a host it cannot observe: behind a proxy that rewrites
`Host`, or on a deploy whose first request is a health check. `/firstrun` re-pins, so claiming a site
also fixes its origin, and cron boots against the same value.

Getting it wrong points canonical tags, redirects and mailed links at the wrong host. What a request
resolves to is a separate question, answered by `SITE_ID`.

Specs: `tests/unit/ops/site-origin.spec.ts`, `tests/integration/render-origin.spec.ts`.

## Plan

| var    | default | what it does                                    |
| ------ | ------- | ----------------------------------------------- |
| `PLAN` | `free`  | selects the whole per-invocation budget profile |

`paid` and `free` are the only recognised values, and **anything unrecognised is free**: every limit
in this project is a free-plan limit, and a typo must not silently grant a 30 s CPU budget to
something that has 10 ms.

The plan selects six numbers at once, from `src/ops/plan-profile.ts`. Each is individually
overridable by its own var, so a paid profile can be run on free or the reverse.

| profile field     | var                  | free  | paid   |
| ----------------- | -------------------- | ----- | ------ |
| `fillBatchSize`   | `FILL_BATCH_SIZE`    | 5     | 8      |
| `fillBatchWallMs` | `FILL_BATCH_WALL_MS` | 5,000 | 1,500  |
| `httpDrainLimit`  | `HTTP_DRAIN_LIMIT`   | 3     | 15     |
| `mirrorLimit`     | `MIRROR_LIMIT`       | 2     | 10     |
| `inlineBudgetMs`  | `RENDER_BUDGET_MS`   | 2,000 | 10,000 |
| `bootInline`      | none                 | off   | on     |

`bootInline` is the one that changes an outcome rather than a rate: whether a MISS on a **cold**
object may boot the interpreter and render, or answer 503 and hand the path to the alarm chain. That
boot is ~1.4 s, which is why it stays off on free. Raising `RENDER_BUDGET_MS` does not move it; the
estimate is only consulted once an interpreter exists.

`CONFIG_KV` under the key `plan` overrides the var and is read once per isolate per minute, so an
account upgrade takes effect without a redeploy. A missing binding, a KV error and an unrecognised
value all fall through to the var.

## Serving and Caching

| var                  | default  | what it does                                                                   |
| -------------------- | -------- | ------------------------------------------------------------------------------ |
| `GEN_BUCKET_MS`      | 5,000    | how long the edge reuses a resolved site generation before re-reading it       |
| `MAX_BODY_BYTES`     | 2 MiB    | largest non-file request body the edge forwards                                |
| `OUTBOUND_GUARD`     | on       | refuse an outbound fetch to a private, loopback or metadata address; `0` off   |
| `PAGE_KV_ENABLED`    | per plan | force the cross-colo KV page tier on (`1`) or off (`0`)                        |
| `PAGE_KV_TTL`        | 86,400   | seconds a stored page lives; floored at KV's own 60 s minimum                  |
| `EDGE_PLAN`          | on       | serve an authenticated page from a compiled plan in the front worker; `0` off  |
| `RENDER_BUDGET_MS`   | per plan | wall-clock ms a MISS may spend rendering before handing off to the alarm       |
| `FILL_BATCH_SIZE`    | per plan | pages one alarm firing may fill before re-arming; capped at 50                 |
| `FILL_BATCH_WALL_MS` | per plan | wall-clock ms one alarm firing may occupy the object; capped at 60,000         |
| `WINDOW_SITES`       | unset    | narrows the scheduled fill window to these sites; unset drives the whole fleet |
| `WINDOW_MAX_FILLS`   | 50       | fills one window may drive                                                     |
| `WINDOW_WALL_MS`     | 60,000   | wall-clock ms one window may run                                               |

### `OUTBOUND_GUARD`

PHP names the URL for `cfwFetch` and `cfwQueueFetch`, so any module able to build a string chooses
where the Worker connects. The guard refuses a scheme other than `http`/`https`, a URL carrying
credentials, and any host that resolves to loopback, an RFC 1918 range, carrier-grade NAT, IPv6
unique-local or link-local, or a name ending `.local`, `.internal`, `.localhost` or `.home.arpa`.
`169.254.0.0/16` is refused as a block because `169.254.169.254` is the cloud metadata address, and
an IPv4-mapped IPv6 literal is decoded first so `::ffff:a9fe:a9fe` cannot smuggle one through.

It is a deny-list because the legitimate destination set is open-ended: every update server, OIDC
provider, webhook endpoint and CAPTCHA verifier a site might use. An allow-list would need editing
to install a module.

Checked when the request is queued and again next to the `fetch()` in the drain, since a row can
reach `cfw_http_queue` by another path. `0` turns it off, which is what the e2e rig uses to point a
site at containers on the host.

### `MAX_BODY_BYTES`

This guards the heap, and leaves bandwidth alone. `parse_str()` on a form body allocates inside a
128 MB isolate, and `foo[][][][][]=bar` repeated turns a few hundred kilobytes of wire into far more
of it. Drupal's own `post_max_size` default is 8 MB; this is tighter, because there is no separate
process to lose here.

The check reads `Content-Length` and nothing else, the only measurement available before the body has
been consumed, and consuming it to measure it is the cost the guard exists to avoid. A chunked
request declares none and falls through to the object's own limits. `GET` and `HEAD` are not checked.

`multipart/form-data` is exempt. That is the file-upload shape, its size is what a caller is asking
for, and it never reaches `parse_str()` as a nested array, so a 2 MiB cap on uploads would be a
functional regression.

Over the limit, the edge answers **413 before any Durable Object hop**. `0` disables the guard
entirely. Raising it trades isolate headroom for larger non-upload submissions; the failure mode of
too high is an object that runs out of memory mid-parse.

Consumer: `bodyTooLarge()` in `src/site.ts`.

### The KV Page Tier

`PAGE_KV` is a cross-colo tier between the edge cache and the Durable Object. It is **on for paid and
off for free** by default. It still costs one Worker request, since the Worker has to run to consult
it, so what it buys is latency and never serving ceiling. A missing binding always wins over
`PAGE_KV_ENABLED`.

Stored pages are keyed by site, generation and path, so a generation bump invalidates every one of
them without enumerating or deleting anything. KV has no bulk delete, so a scheme needing one would
be uninvalidatable in practice. `PAGE_KV_TTL` is therefore a floor on garbage, and no kind of
freshness knob.

### `EDGE_PLAN`

The compiled-plan tier in the front worker. On by default on both plans; `0` opts out, and an empty
value is treated as unset. It is the only tier that answers an **authenticated** page without a
Durable Object hop, because it is the only one whose key is per-visitor: the shared page tiers are
keyed without a user and must never hold one.

Three renders of the same page in the same session compile a plan; the first is discarded, because
it warms Drupal's asset library cache and its stylesheet list differs from every later render. The
plan must reproduce both remaining renders byte for byte, hold no slot it cannot generate, and
survive a re-diff against a freshly generated one. Anything else falls through to an ordinary render.

The key is the site, the generation, the path and the visitor's own `Cookie` header, so a plan is
reachable only by a request presenting the credential it was rendered for. A response carrying
`Set-Cookie` is never compiled, since that is a session rotation. Served responses carry
`x-cfw-cache: PLAN` and `x-cfw-plan: mem` or `kv`; everything else reports on `x-cfw-plan` why it did
not.

An isolate serves against the last generation it learned from the object, and stops after 10 seconds
without re-learning one. That is the staleness bound, and it is the same two-window lag the shared
generation pointer already carries. A write by the visitor moves the generation on its own response,
so their own save is visible immediately.

Compiled plans are mirrored into `PAGE_KV` so a second isolate does not have to compile them again.
That read is bounded at 8 ms: a KV key a colo already holds answers in 4-5 ms, and one it has not
seen costs 46-140 ms whether it exists or not, which is more than the object hop it would replace.

Measured on a deployed paid worker, one session, one 100,748-byte authenticated page:

| where the answer came from      |             ms to response | cpuTimeMs | wallTimeMs |
| ------------------------------- | -------------------------: | --------: | ---------: |
| `EDGE_PLAN=0`, the object hop   |    10 median, 7 min (n=40) |         1 |         18 |
| a plan in this isolate's memory | **0** median and max, n=57 |         0 |          1 |

## Cron

| var                     | default   | what it does                                                                                    |
| ----------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `DRUPAL_CRON`           | on        | whether Drupal cron runs from the alarm; `0` turns it off                                       |
| `CRON_INTERVAL_MS`      | 900,000   | minimum gap between firings                                                                     |
| `CRON_MAX_UNITS`        | 6         | hooks or queues one firing may run                                                              |
| `CRON_MAX_ROWS`         | 500       | rows one firing may write                                                                       |
| `CRON_MAX_MS`           | 500       | wall-clock ms one firing may occupy                                                             |
| `CRON_QUEUE_BATCH_SIZE` | 5         | queue items drained per queue per firing                                                        |
| `GC_INTERVAL_MS`        | 3,600,000 | gap between garbage-collection passes                                                           |
| `CACHE_DATA_MAX_ROWS`   | 5,000     | row cap on `cache_data`                                                                         |
| `WATCHDOG_ROW_LIMIT`    | unset     | row cap on `watchdog`; unset reads `dblog.settings` from the site                               |
| `KEEP_WARM_MS`          | 240,000   | idle alarm re-arm; NOT a keep-warm, see below                                                   |
| `SITE_WARM`             | on        | re-arms below the hibernation threshold so the object stays resident; `0` opts out              |
| `WARM_INTERVAL_MS`      | 8,000     | the warm re-arm; clamped under 10,000 whatever is set                                           |
| `RECYCLE_ABOVE_BYTES`   | 117440512 | drop the interpreter at the end of an invocation above this linear-memory reading; floor 32 MiB |
| `REPLICA_READ_ONLY`     | off       | `1` puts the object in replica mode; see below                                                  |
| `REPLICA_COUNT`         | 0         | replica lanes per site beyond the primary; 0 is one object per site                             |
| `REPLICA_LAG_MS`        | 30,000    | how long a serving lane may go without pulling the log; the bound on staleness                  |
| `REPLICA_AUTOSCALE`     | on        | grow the pool when the site is contended; `0` pins it at `REPLICA_COUNT`                        |
| `REPLICA_MAX_LANES`     | 32        | ceiling autoscaling will not grow past; `0` is the same as switching it off                     |
| `WRITE_FORWARD`         | on        | `0` makes a lane refuse a write instead of executing it and forwarding it to the primary        |

`RECYCLE_ABOVE_BYTES` is the backstop for the isolate's 128 MiB limit, behind the primary defence.
`USE_ZEND_ALLOC=0` means PHP returns nothing between requests, so demand inside one incarnation is
cumulative; `/__migrate` and `/__firstrun` drop the interpreter when they finish, and this catches
everything else. It must fire BETWEEN invocations: linear memory is reclaimed only when the old
module is collected, so dropping mid-request holds both allocations at once. `/serve-stats` reports
`recycles` and `lastRecycle`; an object recycling every request is paying a boot per page.

**`REPLICA_READ_ONLY` is a SAFETY interlock.** Setting it wraps every installed `cfw*` capability so
the object physically cannot commit an authoritative write, and refuses anything unrecognised. That
half works and is reported at `/serve-stats` under `replica`.

A replica is started by a bulk copy and kept current by a log, both over `/__replica`:

| call                                  | on      | what it does                                                    |
| ------------------------------------- | ------- | --------------------------------------------------------------- |
| `GET ?action=snapshot`                | primary | the table plan; 409 when the primary's own identity is unminted |
| `GET ?action=snapshot&table=&offset=` | primary | one page of one copyable table                                  |
| `POST ?action=restore`                | replica | lands one chunk; `VERIFIED` when the whole copy has arrived     |
| `GET ?action=log&since=`              | primary | the records a replica at that generation still needs            |
| `POST ?action=apply`                  | replica | applies one record                                              |
| `?action=stage&to=`                   | either  | moves the stage, 409 on an illegal move                         |

A replica refuses a request it may not answer with 421 and `x-cfw-requires-primary`, and refuses a
stale one with 503 when the caller sent `x-cfw-require-generation`.

### `REPLICA_COUNT`

How many lanes a site has beyond the primary. **0 is the default and means one object per site**, in
which case every routing decision resolves to the primary and nothing changes.

Lane 0 is the primary; lanes 1..n are objects named `<site>#r<lane>`. `#` is outside the set
`encodeSiteId()` keeps and outside its `_<hex>` escape, so a replica name cannot collide with a site
id however a hostname is spelled.

An object's role comes from its own name. `REPLICA_READ_ONLY` is deployment-wide and would make the
primary read-only too, so raising `REPLICA_COUNT` cannot put an existing object into replica mode by
accident. It tells the router how many lanes to spread across, and nothing else.

A lane is chosen by hashing a stable per-visitor key -- the session cookie, else the client address,
else the path -- because a shared-counter round robin produced a completely flat scaling curve on the
rig while per-client affinity produced 1.00 / 1.80 / 2.14. A write spreads only where the lane can
forward it; with `WRITE_FORWARD=0` it goes to the primary without asking a replica first.

**Only the serving path spreads.** `/serve` is an allow-list of one and every other route pins to the
primary, because the two mistakes do not cost the same: a route wrongly pinned loses capacity nobody
sees, and a route wrongly spread answers from a replica's copy. The routing rule read the method and
never the path, so `/export` handed back one lane's database and `GET /migrate` re-ran migration on
an object that is not the site. Every visitor path is rewritten to `/serve` before the router is
asked, so the list needs no other entry.

The router does not track which lanes are ready. A lane that is not `SERVING` answers 421 with
`x-cfw-retry-safe: 1` and the front worker retries on the primary, so readiness needs no cache and no
invalidation. It costs one extra hop, and only while a lane is not ready.

### `REPLICA_AUTOSCALE`

Raising `REPLICA_COUNT` by hand tells the ROUTER that lanes exist. It does not create them, so the
lanes it routes to hold no data and answer 421 until somebody drives the provisioning loop.
Autoscaling is the half that creates one.

The signal is peak concurrent in-flight requests on the primary. A Durable Object runs one request at
a time and a PHP render holds it for the whole render, so concurrency is the queue, and a queue is
the only thing a pool can fix. The target is the **minimum** peak across three windows, minus one, so
a single burst cannot provision a lane that then exists forever; one quiet window clears the run. The
copy is driven a chunk at a time off the alarm, the same way a fresh site migrates, so no firing owns
a whole table copy.

An explicit `REPLICA_COUNT` is a floor rather than a ceiling: a site told to run 2 lanes runs at
least 2 and may still grow. `REPLICA_AUTOSCALE=0` is how an operator pins the number instead.

### `REPLICA_MAX_LANES`

The ceiling autoscaling will not grow past, defaulting to the router's own clamp of 32.

**Throughput gives no reason to cap.** Measured on deployed workers at 8 / 16 / 32 / 48 replicas,
efficiency against perfect scaling is 100 / 95 / 90 / 85% -- a flat ~5 points per doubling with no
knee, and saturation was checked rather than assumed: N=32 returned 183.2 req/s at 128 offered
clients against 183.4 at 64. A linear decline never crosses zero, so any number here is arbitrary.

An earlier default of 3 existed for a different reason and is worth recording, because it read as a
performance limit and was not one. Warming is per OBJECT, so a warmed pool multiplied it: 32 idle
lanes re-arming every 8 s is 345,600 rows a day to serve nothing, 3.5x free's entire daily budget. A
lane the router is not choosing now falls back to the slow re-arm and hibernates, so an unused lane
costs storage and replication catch-up rather than a warming chain. That per-lane idle cost is the
bound that actually matters and it is not yet measured.

### `WRITE_FORWARD`

Lets a pool lane execute a write and forward the statements to the primary rather than refusing it.
On unless `0`, and reachable only where a pool already exists: every caller is behind a lane name or
a non-zero `REPLICA_COUNT`, both off by default. A site with no pool is unaffected by this value.

The lane runs the whole write locally, discards its own effect through the driver's `commit: false`
path, and hands the statement list to the primary, which stays the sequencer. Ids are partitioned so
that every writer holds a residue class no other writer mints -- lanes from their lane number, the
primary from slice 0 -- and a lane records the ids it forwarded so it cannot repeat one before
replication catches up.

Two things are worth knowing before turning it off. A write reaches a lane at all only because this
is on: with it off the router pins every POST to the primary, so the one object the pool exists to
relieve keeps every form submission. And an unbuffered write -- one Drupal issues outside a
transaction -- takes the transaction bridge on a lane rather than the exec bridge, because
`cfwSqlExec` has no rollback and a write on it can be neither forwarded nor discarded. That routing
lives in the driver; the host's guard refuses an exec write and fails over, which is what happens if
the two ever disagree about whether a connection holds a residue class.

### `REPLICA_LAG_MS`

A restored lane drives itself: reaching `VERIFIED` arms its alarm, each firing pulls
`action=log` from the primary and applies it, and `admissionVerdict()` decides the promotion to
`SERVING`. A lane below `SERVING` owns its alarm chain and re-arms every 2 s. One that is `WITHDRAWN`
resets itself to `CREATED`, clears its torn-copy markers and asks the primary for a fresh copy, then
re-arms and repeats the ask until the copy lands; the primary queues the lane in `cfw_meta` and takes
a repair before growing the pool, on a quiet site as well as a busy one.

Once a lane is `SERVING` it falls through to the ordinary alarm body, and this var is the bound on
how far behind it may fall. Measured: without the tightening a serving lane re-arms at
`KEEP_WARM_MS`, so it pulls the log every 240,000 ms and can serve a copy four minutes behind the
primary while looking healthy; the fence refuses only a caller that states a freshness requirement,
and a visitor states none. With it, 30,000. Clamped to 1,000..300,000; below a second a lane spends
more on asking than on serving.

Each round costs two Durable Object requests against the primary, so this is a cost knob as much as a
freshness one.

### Creating a Lane

`GET /replica?action=provision&lane=<n>` on the **primary**. It copies a bounded number of rows,
answers with a cursor, and the caller passes that cursor back until `done`:

```sh
curl "$SITE/replica?action=provision&lane=1"
curl "$SITE/replica?action=provision&lane=1&cursor=<the cursor from the last answer>"
```

It runs on the primary because that is the object a caller can reach; a lane has no route into it
from outside. The lane needs no Drupal install of its own -- each chunk carries the table's DDL --
and it reaches `VERIFIED` on the final chunk, which arms its alarm. From there it is self-driving.

`budget` sets rows per invocation and defaults to 4,000. The cursor carries the generation the copy
began at, so a commit on the primary part-way through answers `torn`, which keeps the far end from
refusing in a way that reads like a bug. Restart the copy; there is no resume.

**A primary cannot be copied from until it has minted `system.private_key`**, which Drupal does on
first use and never at install. `action=snapshot` answers 409 naming the gap;
`\Drupal::service('private_key')->get()` on the primary closes it.

Cron defaults to on, and it used to default to off. Six of twenty-five surveyed contrib modules were
classified as needing cron for that reason: the capability was built and wired into the alarm, and
nothing turned it on. A module that depends on cron does not fail when cron never runs, it silently
does nothing.

### Warming

**A Durable Object hibernates after 10 seconds of idle and hibernation discards in-memory state, so
`this.php` dies there.** Measured on a deployed worker: an object holding a 32 MB allocation and an
id minted in its constructor kept ONE incarnation across 71 consecutive 8 s alarms, and at 12, 20, 30
and 45 s the constructor ran again on every probe.

`KEEP_WARM_MS` ships at 240,000, which is 24x the threshold, so it re-arms an idle alarm and keeps
nothing warm. The name is older than the measurement; it is an idle re-arm.

`SITE_WARM` re-arms at `WARM_INTERVAL_MS` instead, clamped below 10,000 because a larger value
spends a request and a row per firing and holds nothing, the worst of both.

On by default on both plans; `siteWarmEnabled()` returns true when the var is unset and carries no
plan branch. An idle tick charges one row, the `setAlarm` itself, so a warm site costs 10,800 object
requests and 10,800 rows a day whatever its traffic, which is 10.8% of the free daily budget for one
site. What it buys is the 1,398 ms cold boot on every page that renders, which is the authenticated
tier; a cached page answers off SQL without booting PHP at all, so warming cannot make one faster.

Two bounds worth knowing before setting it to `0`. Below roughly 505 renders/day the alarms cost more
CPU than they save. Above roughly 8,640 the site never idles 10 s and is already resident, so the
warming is redundant rather than harmful.

Duration is not the meter. An object waiting on an armed alarm is idle and eligible to hibernate, and
an idle-eligible object is not billed for duration; warming spends requests and rows.

`CRON_INTERVAL_MS` is what makes the per-firing budget a budget. The alarm is not a clock, since it
re-arms at +1 ms while a fill queue is draining, so "once per alarm" during an active fill is once
per page, each one costing an interpreter unit and up to `CRON_MAX_ROWS` writes. At 15 minutes the
worst case is 96 firings/day, so a site that hit the row cap every time spends 48,000 of the 100,000
daily rows. Lowering it is the fastest way to burn the meter that binds regeneration.

Cron renders against the site's origin, so links in mail it sends point at the site. See
[`SITE_ORIGIN`](#site_origin).

## Boot and Storage

| var                             | default                               | what it does                                                                                      |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `HEAP_SNAPSHOT`                 | on                                    | restore a stored wasm heap instead of booting the kernel; `0` disables                            |
| `HEAP_IMAGE`                    | on                                    | take that heap image in the first place; `0` disables. One image costs 10,420,224 bytes           |
| `HEAP_RESTORE_CHUNKS`           | all at once                           | chunks of a snapshot one invocation may apply                                                     |
| `LAZY_MOUNT`                    | `1` in the canonical config           | stream the pack per file instead of inflating it whole                                            |
| `LAZY_FS_BUDGET_BYTES`          | 20 MiB, 4 MiB in the canonical config | resident bytes the lazy filesystem keeps before evicting                                          |
| `SITE_DB_PREFIX`                | the packed default                    | which database pack an object mounts                                                              |
| `SQL_CHUNK_PREFIX`              | `drupal-sql`                          | which asset directory the migration chunks are read from                                          |
| `MIGRATE_ENGINE`                | `sql`                                 | `sql` replays chunks in JavaScript; `php` needs a `pdo_sqlite` the shipping binary does not carry |
| `MIGRATE_SELF_DRIVE`            | on                                    | whether a partial migration re-arms its own alarm                                                 |
| `MIGRATE_CHUNKS_PER_INVOCATION` | 1 on free, all on paid                | chunks replayed per invocation                                                                    |

### `OPCACHE_MODE`

| value  | what it does                                             |
| ------ | -------------------------------------------------------- |
| `off`  | default; opcache disabled                                |
| `file` | opcache on with the file cache as its only backing store |
| `shm`  | opcache on with shared memory as its backing store       |

The default is `off`, and the arms are measured. `file` writes 2,346 `.bin` files and 32,141,312
bytes into the in-memory filesystem for a cache nothing ever reads, and `opcache_get_status()`
reports opcache DISABLED on that arm because `file_cache_only=1` turns the shared-memory backend
off. `shm` does accelerate (2,346 cached scripts, no filesystem writes) and puts its arena in PHP's
linear memory, taking an object to 191.25 MiB against a 128 MiB isolate. `off` renders within 1 ms of
`file` and leaves 37 MiB more room.

### `ARGON2`

`1` hashes passwords with argon2id at m=19456 KiB, t=2, p=1, computed on the host. Default off.

Turning it on is a migration: every bcrypt hash on the site reports as needing a rehash, and each
account is upgraded at its owner's next login. Existing hashes keep working throughout; core's
password service stays in place as the inner service and still owns bcrypt and legacy `$S$` hashes.
Hashes are written in PHP's own `$argon2id$v=19$m=..,t=..,p=..$salt$tag` form, so a site that leaves
this platform can verify them on any PHP with ext-argon2.

A hash costs a 19 MiB transient allocation and two passes of CPU. That is more than a free-plan
login invocation has.

### `SHELL_ASSEMBLY`

Allows an authenticated GET to be answered from a stored shell with its personalised regions filled
at the edge. On by default with no plan branch; `0` opts out, and an empty value is treated as
unset. The row toll below is what a plan branch would have been about, and at one site it fits
free's 100,000 rows/day. No visitor is served an assembly that has not been proven against their own
render.

A path with no stored shell is seeded from the next authenticated request, which is what lets
assembly resume after an invalidation. Every bump purges every shell, because no Drupal cache tag
reaches one, so without seeding the feature stops at the first content change until an operator
re-harvests.

An operator harvest takes two sessions of one role set and stores the shell only when both normalise
to identical bytes. A seed takes one session, which widens what may be STORED and leaves what may be
served where it was. A visitor whose permissions hash differs from the stored shell's falls through
to an ordinary render.

Each visitor's first request for a harvested path re-harvests under their own session and requires
their normalised shell to equal the stored one byte for byte. That response carries
`x-cfw-cache: VERIFY` and is answered from their own harvest; later requests carry
`x-cfw-cache: ASSEMBLED`. A shell that disagrees is deleted and the reason is recorded in `cfw_meta`
under `shellRefusal`.

The proof is stored per `(path, permissions hash, uid)` and voided when the path is harvested
again. It costs 40 to 52 rows written once per visitor and path, against 4 to 10 for each render it
then replaces; an assembly writes none.

A generation bump drops every stored shell, including a `cachetags` bump. A shell caches the shared
region of a page and Drupal has no cache tag pointing at it, so nothing else would invalidate it.
Assembly stops on that path until the shell is harvested again.

**`HEAP_SNAPSHOT` gates the RESTORE and `HEAP_IMAGE` gates the producer.** Restoring an image is free
to a site that has one; taking one is what costs. Until 2026-08-30 nothing produced an image at all,
and this paragraph stated both the cost and the benefit as if a site incurred either.

The measured exchange rate, on a deployed worker with `cpuTime`, once an image exists. A cold serve
with no image is 1,218.5 ms at the median (n=8, 1,099-1,397):

| image taken                                |                 storage | cold serve, median |  removes |
| ------------------------------------------ | ----------------------: | -----------------: | -------: |
| post-kernel-boot, the shape the code takes |   9,699,328 B / 49 rows |       904 ms (n=8) | 314.5 ms |
| post-render                                | 62,586,880 B / 313 rows |       572 ms (n=7) | 646.5 ms |

The producer ships on, and `HEAP_IMAGE=0` opts out. `snapshotStep()` takes one image per pack
generation from the alarm, and `/heap` reports `imagedGeneration`, `imageAttempts` and
`lastHeapImage` so a deployed site can be checked. It never drops the interpreter: it runs before the
fill loop and only when `this.php === null`, which a provisioned site reaches as a matter of course
because `/__migrate`, `/__firstrun` and `/__enable` all drop when they finish. It also refuses to
overwrite an image an operator took, since the GC keeps exactly one.

One image costs 10,420,224 bytes, and that cost is measured while the saving is a range. Four paired
runs on deployed workers, arms interleaved, read 59, 72, 314.5 and 665.5 ms at the median, and two of
them carry a negative sample. The 72 ms was taken after the packed `cache_container` row was fixed,
and it is the most representative: a cold boot on the fixed pack has less to rebuild, so the image
saves less. The mechanism is confirmed throughout: `restored: true`, matching digests,
byte-identical output on every arm.

The post-render image is not shipped and its safety is not established: byte-identical anonymous
output is a first-order check, and it falls short of proving that no session-bearing state survives,
which is the reason the code images before the first render.

**A pack-generic image cannot ship in the bundle, and it fails on size.** Two sites provisioned from
one pack with the hash salt and pinned origin forced equal share 70.27% of pages once rendered, and
the image is 2,588,005 bytes gzipped against roughly 355 KiB of headroom. Over by 7.3x even at
perfect determinism. Delta encoding against a shared base, or shipping a base through the assets
binding, are the surviving ideas and neither is priced.

**Changing `LAZY_MOUNT`, `MIGRATE_ENGINE` or `SITE_DB_PREFIX` in a deploying config means changing
`assets/.assetsignore` too.** The shipping asset set is derived from the canonical values of those
three; `tests/unit/runtime/assets-ignore.spec.ts` fails when the two disagree.

## Diagnostics

| var                 | default | what it does                                                              |
| ------------------- | ------- | ------------------------------------------------------------------------- |
| `PW_DIAGNOSTICS`    | off     | exposes `/sql`, `/restore`, `/php` and the rest of the diagnostic surface |
| `PHP_LOG_LEVEL`     | `info`  | RFC 5424 ceiling on what PHP's log mirrors to `console.log`               |
| `PW_SQL_TRACE`      | off     | logs every Drupal statement through `console.log`                         |
| `PW_SQL_TRACE_FROM` | 0       | first statement number to log                                             |

### `PW_DIAGNOSTICS`

**One boolean that exposes arbitrary SQL against the site database (`/sql`), a whole-database
overwrite (`/restore`) and arbitrary PHP (`/php`).** Diagnostic routes fail closed without it.
`bun run dev` sets it; a deployed configuration must not. It is absent from the KV override
allow-list: KV is operator-writable, and every name on that list has a worst case of a slow site,
with no change to what is reachable.

### `PHP_LOG_LEVEL`

`off | error | warn | log | info | debug`, mapped onto RFC 5424 severities (lower is more severe), the
same scale `CfwLogger` sends and Drupal's own `watchdog` uses. `warning` and `notice` are accepted as
aliases for `warn` and `log`, and `all` for `debug`.

`CfwLogger` ships every Drupal log entry across the host bridge and the object mirrors it to
`console.log` so it survives the isolate that produced it. Unfiltered, that is right for a ring
buffer and wrong for a terminal: one page render on 8.5 emits several severity-7 deprecation notices
with full stack traces, which is most of what a `wrangler dev` session prints. `info` is the default
for that reason.

An unrecognised value falls back to the default and raises no error. A fatal carries `level: "error"`
with no severity and is derived from the name, so a missing field never drops it.

Consumer: `src/ops/log-level.ts`.

### `PW_SQL_TRACE`

Logs every statement Drupal issues. `console.log` survives an object reset, which is what makes it
readable when the object dies mid-run. A `wrangler tail` has a 256 KB budget, so
`PW_SQL_TRACE_FROM=<n>` spends it on the end of a long run instead of the beginning.

## Prefill and Mirroring

| var                     | default                   | what it does                                                |
| ----------------------- | ------------------------- | ----------------------------------------------------------- |
| `PREFILL`               | on for free, off for paid | seed the serving table from `assets/prefill.json`           |
| `PREFILL_ON_SAVE`       | on                        | re-render invalidated paths after a content save            |
| `PREFILL_ON_SAVE_LIMIT` | 25                        | paths one save may queue                                    |
| `MIRROR_LIMIT`          | per plan                  | files one alarm firing may push to R2; capped at 25         |
| `HTTP_DRAIN_ON_ALARM`   | on                        | drain queued outbound requests from the alarm               |
| `HTTP_DRAIN_LIMIT`      | per plan                  | queued outbound requests one firing may fetch; capped at 25 |

`PREFILL` is on for free because free is where a cold first request costs the most: a prefilled path
is a hit on its first ever request. It is off during a bake, or every render would be a hit of the
file being rebuilt.

**Mirror to the optimum.** Once R2's read meter binds, moving more traffic off-Worker spends a
333,333/day meter to save a 100,000/day one. On the default traffic mix the peak is 0.769 off-Worker
for 432,900 views/day, against 336,700 for mirroring everything, so maximising costs 96,200
views/day.

The optimum moves with the traffic mix and with CDN absorption, so compute it every time:
`optimalOffWorker()` in `scripts/measure/free-envelope.ts` derives it from the same model every other
caller uses. Raising absorption does not converge on "mirror everything"; at absorption 1, where R2
reads cannot bind at all, the peak lands at 0.898 and is bound by rows.

## Outbound Mail

Drupal's mail plugin is `cfw_mail`, and it hands the message to the Worker. The Worker resolves one
of three transports and commits the message to `cfw_mail_queue`; the alarm sends it. `src/ops/mail.ts`
is the implementation.

| var                   | default  | what it does                                               |
| --------------------- | -------- | ---------------------------------------------------------- |
| `MAIL_TRANSPORT`      | `auto`   | `auto`, `binding`, `api`, `smtp` or `off`                  |
| `MAIL_FROM`           | —        | the From for a message that carries none                   |
| `MAIL_DRAIN_ON_ALARM` | on       | send queued mail from the alarm                            |
| `MAIL_DRAIN_LIMIT`    | 5        | messages one firing may send; capped at 25                 |
| `CF_EMAIL_ACCOUNT_ID` | —        | the account the Email Sending REST API posts under         |
| `CF_EMAIL_TOKEN`      | —        | an API token with Email Sending: Edit; a secret, not a var |
| `SMTP_HOST`           | —        | submission host for the third-party lane                   |
| `SMTP_PORT`           | 587/465  | 587 for STARTTLS, 465 for implicit TLS                     |
| `SMTP_TLS`            | starttls | `starttls`, `implicit` or `off`                            |
| `SMTP_USER`           | —        | submission user; omit for an unauthenticated relay         |
| `SMTP_PASS`           | —        | submission password; a secret                              |
| `SMTP_AUTH`           | `PLAIN`  | `PLAIN` or `LOGIN`                                         |

`auto` takes the first transport that is configured, in the order binding, api, smtp. The binding
leads because it spends no credential.

### The `smtp` Module's Own Settings

A site with `drupal/smtp` installed and configured needs none of the `SMTP_*` vars. The module
installs on this runtime and its socket never runs, because `system.mail` is forced to `cfw_mail`, so
its settings would otherwise sit unread while an operator typed the same relay a second time. Its
`smtp.settings` is read and mapped onto the transport: `smtp_host`, `smtp_port`, `smtp_username`,
`smtp_password` and `smtp_from` map across directly, and `smtp_protocol` maps `ssl` to implicit TLS,
`tls` to STARTTLS and `standard` to no encryption. `smtp_on` turned off is honoured.

**A var always wins over the setting it corresponds to.** A var is set by whoever can deploy the
Worker; the settings form is reachable by anyone who can get to a Drupal admin page. So the settings
fill gaps only, and setting `SMTP_HOST` pins the relay regardless of what the site is configured
with.

### What Each Transport Reaches

`binding` uses a `send_email` binding named `SEND_EMAIL`, declared in your own Wrangler config. `api`
uses the Email Sending REST API. Cloudflare applies the same limits to both, and to its own SMTP
endpoint, so the choice between them comes down to credentials. Two account-level facts decide what
either can reach:

- **A sending domain that is not onboarded** reaches verified destination addresses only: the 200
  per account that somebody confirmed by clicking a link. Onboarding the domain with SPF and DKIM on
  Cloudflare DNS lifts that immediately.
- **Workers Free has no outbound Email Sending.** The one carve-out is that sends to verified
  destination addresses are free on every plan, from your routing domains, against no quota.

So a free site can mail its owner and cannot mail a visitor who just registered. Third-party SMTP is
the only general answer on free, and a rejected Cloudflare send says so in its error text, with no
status code to read.

### SMTP

Port 25 is blocked on Workers; `MAIL_TRANSPORT=smtp` with `SMTP_PORT=25` is refused by name, before
any attempt. `smtp.mx.cloudflare.net` is refused too: it resolves inside `162.158.0.0/15`, a
published Cloudflare range, and outbound TCP to those is blocked. Use `MAIL_TRANSPORT=api` or the
binding for Cloudflare mail. `SMTP_TLS=off` together with `SMTP_USER` is refused, because it would
put the relay password on the wire.

SMTP is the only transport that opens an outbound TCP socket, and an outbound socket is on
Cloudflare's list of conditions that prevent a Durable Object from hibernating. The object is
therefore billed for compute duration for the length of the send, and the queue drains sequentially,
so a batch is billed for the whole batch. The socket is closed in a `finally`, which caps the
exposure at the send itself, well under the 15-minute maximum a connection can defer eviction by.
The `api` and `binding` transports use `fetch`, which never holds an object in memory.

### Limits and What a Refusal Means

A message is refused at commit, where `CfwMail` logs the reason next to the operation that produced
it, for: no recipient, no From, more than 50 recipients across To/Cc/Bcc, a subject over 998
characters, headers over 16 KB, or a payload over 1,000,000 bytes. That last one derives from the
Durable Object record ceiling of 2,199,995 bytes; Cloudflare's own 5 MiB is the looser of the two and
never fires first.

A failure after commit is only visible on `/__serve-stats`, under `mailQueue`, `lastMailDrain` and
`lastMailDrainAt`. A failed send is not retried: a send is not idempotent, and a password reset
delivered twice with two different one-time links is worse than one that did not arrive.

Mail sent through the `send_email` binding shows as **dropped** in the Email Routing summary even
when it was delivered. Read Email Sending metrics instead.

### Connecting a Cloudflare Account

Two ways, both owner-authenticated. Pasting `CF_EMAIL_ACCOUNT_ID` and `CF_EMAIL_TOKEN` needs no
setup. OAuth issues a short-lived scoped grant instead, revocable from the Cloudflare dashboard.

Owner-authenticated means `Authorization: Bearer <ownerToken>`, the token `/firstrun` returns once
when the site is claimed. Without it these routes answer 401 with a `WWW-Authenticate: Bearer`
challenge. `README.md` covers claiming.

`GET /setup/cf?action=connect&client_id=<id>` starts the flow and returns an authorize URL;
`/setup/cf/callback` completes it; `?action=status` reports whether an account is connected and
`?action=disconnect` revokes the grant at Cloudflare as well as forgetting it locally.

OAuth needs a client the operator registers once, under **Manage account > OAuth clients**, with
`https://<your-site>/setup/cf/callback` as its redirect URI and `private` visibility. A redirect URI
is registered against the client and every deployment answers on a different origin, so there is no
shared client that could serve all of them. The flow is Authorization Code with PKCE (S256) and
carries no client secret.

The client ID is stored in the site's own database, away from KV. It carries no secret, and a KV
writer who could change it would point the consent screen at an application they control.

Scopes requested: `user:read`, `account:read`, `email:read`, `email:write`. Onboarding a sending
domain additionally needs **zone DNS write**, which is why it is a separate opt-in step.

### Onboarding a Sending Domain

`GET /setup/mail?zone=<zone-id>` reports which step the domain is waiting on;
`?action=apply` creates the sending subdomain and writes the DNS records. Owner-authenticated, and
safe to re-run: a settled zone costs zero API calls.

| stage                   | meaning                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `no-zone`               | pick the zone this site sends from                           |
| `needs-subdomain`       | create the sending subdomain on that zone                    |
| `needs-dns`             | records still to write, counted in `waitingOn`               |
| `awaiting-verification` | click the link Cloudflare emailed to the destination address |
| `ready`                 | mail can send                                                |

`settled` means re-running changes nothing; onboarding may still be unfinished.
`awaiting-verification` is settled, because nothing more can be done from this side.

A sending subdomain is zone-scoped. Six records are written: three MX and an SPF TXT on the
return-path host, a DKIM TXT at `<selector>._domainkey`, and a DMARC TXT on the apex.

**An existing DMARC record is reported, never overwritten.** It states a policy for every mail
stream on the domain, so replacing `p=none` with `p=reject` would tell receivers to bounce
unauthenticated mail from senders that have nothing to do with this site. It appears under
`advisories` with both values, and the flow still reaches `ready`.

Destination-address verification is pollable: the address carries `status` and a `verified`
timestamp, so the surface updates on its own.

## Outbound TCP

Drupal reaches TCP through `Drupal\drupflare\Network\CfwTcp`, which declares a whole exchange and
reads the answer on a later invocation. `src/ops/tcp.ts` runs it between PHP invocations, over
[edgeport](https://github.com/gmitch215/edgeport). It shares the deferred HTTP tier's queue, cache
and retry budget.

| var               | default  | what it does                                            |
| ----------------- | -------- | ------------------------------------------------------- |
| `REDIS_URL`       | —        | `redis://user:pass@host:6379/0`, or `rediss://` for TLS |
| `SYSLOG_URL`      | —        | `syslog://collector:514`, or `syslogs://` for RFC 5425  |
| `SYSLOG_APP_NAME` | `drupal` | APP-NAME on every record this site ships                |

Both carry credentials, so both are secrets and neither is a `vars` entry, and neither can be set
from KV. A KV writer who could set `REDIS_URL` would receive whatever the site writes to it.

**The endpoint belongs to the deployment, and never to the caller.** Module code names a protocol and
an operation; the host supplies the host, port and credentials. Arbitrary `host:port` TCP behind any
code that can call a host function would be a port scanner and a protocol-smuggling surface.
Administrative Redis commands (`FLUSHALL`, `CONFIG`, `EVAL`, `SCRIPT`, `SHUTDOWN` and the rest of the
list in `src/ops/tcp.ts`) are refused before anything is dialled.

**A Redis cache backend cannot be built on this.** A cache get has to answer inside the request that
asked, and a deferred exchange always misses the first time. What this reaches is the deferrable half:
a publish, a counter, a write nobody blocks on, or a read a later request can use. The Durable
Object's own SQLite is the cache backend.

`syslog` is the shape this tier serves without compromise, because syslog over TCP never replies.

## Workers AI

Inference is a queued tier over the same queue as outbound HTTP and TCP. A model call is declared,
run between PHP invocations, and read on a later one. `src/ops/ai.ts` runs it.

| binding or var | default        | what it does                                          |
| -------------- | -------------- | ----------------------------------------------------- |
| `AI`           | —              | the Workers AI binding; the tier is absent without it |
| `AI_MODELS`    | four model ids | comma-separated allow-list of model ids               |

The tier uses the binding. A REST call to `api.cloudflare.com` needs an `Authorization: Bearer`
header and the account id in its URL, which would put the account token in a queue row; the binding
carries its own authorisation.

**Neurons are a fourth meter.** 10,000 per day on Workers Free and Workers Paid alike, reset at
00:00 UTC, and exhaustion arrives as HTTP 429 with error 3036, never as a bill. Neither the serving
ceiling nor the regeneration ceiling sees it. `/ai` reports a projected cost per call, derived from
Cloudflare's published per-model rate and an approximate token count; the binding returns no metered
figure, so the projection is arithmetic and is labelled as such.

Measured on a deployed free-plan site: a `llama-3.3-70b` completion projects to 102.62 neurons, which
is **97 completions a day**. A `bge-m3` embedding of a short text projects to 0.01, and indexing 1,000
nodes at 500 tokens each is about 5% of one day. Embedding-backed search fits the free allocation;
chat completion overruns it.

### Two Catalogues

Cloudflare publishes two model lists and the difference matters to a site owner.

| catalogue                         | what it is                                                           |
| --------------------------------- | -------------------------------------------------------------------- |
| Workers AI, `/workers-ai/models/` | every entry Cloudflare-hosted; inference runs on Cloudflare hardware |
| unified AI catalog, `/ai/models/` | the above plus third-party models reached through AI Gateway         |

The extra entries on the unified catalogue are external providers (OpenAI, Anthropic, Google, xAI)
reached over AI Gateway and billed through it. A prompt sent to one leaves Cloudflare.

`Partner` is a separate axis. A Partner model on the Workers AI catalogue has proprietary weights and
still runs on Cloudflare hardware: Deepgram, Leonardo, Black Forest Labs and NVIDIA all appear there.
The privacy line runs between Cloudflare-hosted and external provider, and open-weight against
partner is a different line entirely.

`AI_MODELS` is the control. Its default list is Cloudflare-hosted only.

### What This Tier Does Not Do

**No inline AI in a render.** A block or field formatter calling a provider during a page render
holds the object across the round trip, which makes it ineligible for hibernation and bills as wall
clock. The surfaces this tier fits are the ones that already retry and already show progress:
generation on save, moderation, alt text, summarisation, and embedding on the cron path.

**No streaming.** The unit this queue carries is a finished response body.

## OIDC Login

A login is completed by the Worker. The callback is an ordinary request, so the token exchange and
the `id_token` signature check happen in JavaScript before PHP is entered, and PHP is handed a
decided result. `src/ops/oidc.ts` is the implementation.

Correctness forces that split. The interpreter carries no OpenSSL, so it cannot verify an RS256
`id_token` at all, and an unverified `id_token` is an unauthenticated login.

| setting              | where      | what it does                                         |
| -------------------- | ---------- | ---------------------------------------------------- |
| `oidc_issuer`        | `cfw_meta` | the provider's issuer URL; https, or a loopback host |
| `oidc_client_id`     | `cfw_meta` | the client registered with that provider             |
| `OIDC_CLIENT_SECRET` | binding    | for a provider that issued one; a secret, not a var  |

The issuer and the client id sit in the object's own storage, and the secret is a binding. None of
the three can be set from KV: a writer who could change the issuer would point the consent screen at
a provider they control, and every login on the site would authenticate against it.

Plain http is refused except on a loopback host, which is what lets a provider run on the same machine
during development. A deployed Worker has no loopback to reach, so the exemption grants nothing there.

Register `https://<your-site>/oidc?action=callback` as the redirect URI. `/oidc` starts a login and
accepts an optional `return` path, which must be site-relative. It is a public route because a
provider's redirect carries no header this Worker controls; `state` is what authenticates it.

Completing a login also needs `drupal/externalauth` installed on the site, which is what maps the
verified identity onto an account.

`/setup/oidc` reads and writes the two `cfw_meta` values, and `/_cfw/access` is the page over it.

| action           | method | what it does                                                                   |
| ---------------- | ------ | ------------------------------------------------------------------------------ |
| `?action=status` | GET    | the issuer, the client id, whether the secret binding is set, the redirect URI |
| `?action=save`   | POST   | validates and stores the pair, then fetches the discovery document             |
| `?action=clear`  | GET    | forgets both, which turns login off                                            |

It is an **owner** route, so it takes the token minted at first run and refuses the admin page's
weaker gate. Reading which provider is configured is harmless; choosing it is not.

The issuer must be `https` and must carry no query or fragment: the discovery URL is built by
appending a fixed path, so an issuer carrying either produces a URL nobody intended. A trailing slash
is normalised away so that discovery and the later `iss` comparison agree on one spelling. Saving
fetches the discovery document immediately and reports what it advertises, so a wrong issuer surfaces
at configuration time, well before someone's first login. The secret is never read back.

**The claims never travel in a URL.** The browser carries a single-use ticket; the claims stay in the
object's storage and the row is deleted before they are returned, so a second presentation of the
same ticket finds nothing. A redirect lands in browser history, in a referrer and in any proxy log
on the path.

Five conditions refuse a login, each tested against real generated keys: a signature from a key
outside the provider's JWKS, an issuer that is not the configured one, an audience belonging to
another client of the same provider, an expired token, and a nonce from a different login. `none`
and the HMAC algorithms are refused by omission.

## Git Remotes

A site follows as many repositories as it is given. `src/ops/git-smart.ts` is the transport,
`src/ops/git-provider.ts` the provider layer above it, `src/ops/git-sync.ts` the layout and diff, and
`/_cfw/git` the page that drives all three.

### The Transport

Git's smart HTTP, so any host that serves a repository works. A poll is
`GET /info/refs?service=git-upload-pack` and a pull is `POST /git-upload-pack` for one commit at
depth 1; the packfile is parsed in the Worker, including both delta forms.

The provider APIs are a layer above it and the transport depends on none of them. `generic` uses no
API at all: branches and open requests both come out of the ref advertisement, since every provider
publishes `refs/pull/N/head` or `refs/merge-requests/N/head`.

| provider    | API                  | default host                |
| ----------- | -------------------- | --------------------------- |
| `github`    | REST v3              | `https://api.github.com`    |
| `gitlab`    | REST v4              | `https://gitlab.com`        |
| `bitbucket` | REST 2.0             | `https://api.bitbucket.org` |
| `gitea`     | REST v1, Forgejo too | none; the host is required  |
| `generic`   | none                 | none; the host is required  |

### Storage

| setting                 | where      | what it does                                      |
| ----------------------- | ---------- | ------------------------------------------------- |
| `git_remotes`           | `cfw_meta` | the configured remotes, as one JSON row           |
| `git_token_<id>`        | `cfw_meta` | the access token for one remote                   |
| `git_email_<id>`        | `cfw_meta` | the Atlassian account email, Bitbucket only       |
| `git_hooksecret_<id>`   | `cfw_meta` | the shared secret a delivery is verified against  |
| `git_head_<id>`         | `cfw_meta` | the sha the last poll saw                         |
| `git_installedsha_<id>` | `cfw_meta` | the sha whose files are actually mounted          |
| `git_interval_<id>`     | `cfw_meta` | poll cadence in minutes; `0` turns polling off    |
| `git_backoff_<id>`      | `cfw_meta` | epoch ms before which nothing polls this remote   |
| `git_previewof_<id>`    | `cfw_meta` | the request being previewed instead of the branch |

Module source lands in `cfw_module_file`, one row per file, with the remote id as the owning package.
That is the same table `composer require` writes to, which is what makes a conflict detectable.

All of it lives in the object's own storage and none of it can be set from KV: a writer who could
change a remote would point the site at a repository they control, and a writer who could read a
token would have push access to the operator's repository.

### Polling

The interval is per repository and defaults to 60 minutes, floored at 5. The alarm polls at most
three due remotes per firing, oldest first, so one slow remote cannot starve the others. A 429 sets a
backoff that honours `Retry-After` and otherwise doubles to an hour.

### Installing

`selectFiles()` keeps PHP, YAML, Twig, JavaScript and CSS, and drops `tests/`, `vendor/`,
`node_modules/`, `.github/` and dotfiles. Module names come from `*.info.yml`; a submodule inside
another module's tree stays where it is and is mounted once.

A pull is applied in one `transactionSync()` and then verified by booting the Drupal kernel. A boot
failure restores the previous file set and records the reason on the remote.

### What Gets Written Back

A **commit status** on the pushed sha: a state, a context, a description and a link. All three
providers support it and an access token can write it.

GitHub's Checks API carries annotations and per-line output, and only a GitHub App can write one. A
repository-scoped fine-grained token is refused with `Resource not accessible by personal access
token` on both check-run endpoints and accepted on the status endpoint, so the product offers commit
statuses and avoids the word "checks".

| provider       | read the tree          | write a status           | create a webhook           |
| -------------- | ---------------------- | ------------------------ | -------------------------- |
| GitHub         | `Contents: read`       | `Commit statuses: write` | `Webhooks: write`          |
| GitLab         | `read_api`             | `api`                    | `api`, Maintainer or Owner |
| Bitbucket      | `repository:read`      | `repository:read`        | `webhook`                  |
| Gitea, Forgejo | `read:repository`      | `write:repository`       | `write:repository`         |
| Any git remote | read access over HTTPS | no API                   | register by hand           |

GitLab has no scope narrower than `api` for writing a status. Bitbucket has no personal access
token: an Atlassian API token authenticates as HTTP Basic with the account email as the username, so
its row on the page asks for one. A plain remote has nowhere to put a status, so `statusRequest()`
returns null for it.

Gitea takes `state` on the way in and answers `status` on the way out, which matters when reading a
status back through its API.

### Deliveries

`/githook?remote=<id>` receives them. It takes no credential this Worker controls, so the signature
is the whole of the authentication and an unverifiable delivery is refused.

| provider       | header                | what it proves                                           |
| -------------- | --------------------- | -------------------------------------------------------- |
| GitHub         | `X-Hub-Signature-256` | HMAC-SHA256 over the raw body                            |
| Gitea, Forgejo | `X-Hub-Signature-256` | the same scheme, verified the same way                   |
| Bitbucket      | `X-Hub-Signature`     | HMAC, method read from the header prefix                 |
| GitLab         | `webhook-signature`   | HMAC-SHA256, GitLab 19.0 and a feature flag              |
| GitLab         | `X-Gitlab-Token`      | the shared secret, in plaintext                          |
| Any git remote | `X-Hub-Signature-256` | accepted if the sender can produce it; refused otherwise |

GitLab installs before 19.0 send the secret in plaintext and cannot be HMAC-verified. Both forms are
accepted, and the page shows which one the last delivery used, since the two differ in what they
prove.

A push to the tracked branch installs the commit inline and writes the result back as a status. A
push to any other branch, a branch delete, and a push arriving while a request is being previewed all
record the head and stop there.

## Database Updates

`updb` slices Drupal's own update path across invocations. Every var here bounds one slice.

| var                       | default | what it does                                     |
| ------------------------- | ------- | ------------------------------------------------ |
| `UPDB_FLUSH_SPLIT`        | on      | split a cache flush across invocations           |
| `UPDB_ALLOW_UNBOUNDED`    | off     | permit an update with no measurable bound        |
| `UPDB_SNAPSHOT_MAX_ROWS`  | —       | rows a pre-update snapshot may hold              |
| `UPDB_RETRY_POLICY`       | —       | how a failed slice is retried                    |
| `UPDB_ON_ABORT`           | —       | what happens to a run that cannot continue       |
| `UPDB_MAX_ATTEMPTS`       | —       | attempts per slice                               |
| `UPDB_MAX_PASSES`         | —       | passes over the update list                      |
| `UPDB_MAX_COLD_WAITS`     | —       | consecutive cold-object waits tolerated          |
| `UPDB_MAX_BEATS`          | —       | alarm beats one run may consume                  |
| `UPDB_CHECK_REQUIREMENTS` | —       | run Drupal's own update requirements check first |

Read `src/ops/updb.ts` before changing any of these; the defaults are what a sliced update was
measured against.

## Runtime Overrides

Eleven names can be overridden from the `CONFIG_KV` namespace under the key `settings`, as one JSON
object. One key covers all eleven: a single read is atomic, costs one of the 100,000 daily KV reads
instead of eleven, and gives an operator one place to see every override in force.

```json
{ "RENDER_BUDGET_MS": 4000, "FILL_BATCH_SIZE": 8, "PREFILL": "0" }
```

`RENDER_BUDGET_MS`, `FILL_BATCH_SIZE`, `FILL_BATCH_WALL_MS`, `HTTP_DRAIN_LIMIT`, `MIRROR_LIMIT`,
`LAZY_FS_BUDGET_BYTES`, `PREFILL`, `GEN_BUCKET_MS`, `SITE_LOCATION_HINT`, `MAIL_TRANSPORT`,
`MAIL_DRAIN_LIMIT`.

**All eleven reach a reader inside the Durable Object, and for a while only two did.**
`withSettings()` is applied in `src/site.ts`, to the front Worker's env, and the object receives its
own copy of the bindings, so seven of the eleven were knobs nothing read: `RENDER_BUDGET_MS`,
`FILL_BATCH_SIZE`, `FILL_BATCH_WALL_MS`, `HTTP_DRAIN_LIMIT`, `MIRROR_LIMIT`, `LAZY_FS_BUDGET_BYTES`
and `PREFILL` are read in `src/site-do.ts` and only there. `adoptSettings()` now overlays every name
on the allow-list, and is called from `alarm()` as well as `handle()`, because four of the seven are
read on the fill chain and an alarm never passes through `handle()`. The fast storage lane adopts
nothing and must not: it is await-free by construction and reads no lever.

A lever is offered here first, then as a var. KV comes before `vars` so an operator can change a
setting without a redeploy; the var is the fallback. That ordering applies to anything new, including
values that look like deploy-time properties. `SITE_LOCATION_HINT` reads like one and behaves
otherwise, since `DurableObjectNamespace.get()` takes the hint per call.

**The list is an allow-list and it is a privilege boundary.** KV is operator-writable, so merging an
arbitrary object into the environment would let anyone with KV write set `PW_DIAGNOSTICS=1`. Every
name here is a performance lever whose worst case is a slow site; none changes what is reachable.
`PLAN` has its own key and its own resolver, because it selects a whole profile. The mail credentials
are absent for the same reason: `MAIL_TRANSPORT` only chooses between transports the deploy already
configured, while a KV writer who could set `SMTP_HOST` would receive every password-reset link the
site sends.

A malformed document, an unknown key and a KV error all yield no overrides, and none of them throws.
Values are read once per isolate per minute.

## R2 Page Origin Caching

Mirroring pages to R2 moves them off the Worker, and an R2 public bucket on a custom domain serves
them. How much of that traffic Cloudflare's CDN absorbs in front of the bucket decides whether the
off-Worker lever is worth anything: an absorbed read costs neither a Worker request nor an R2 Class B
operation.

**Absorption is 0 without a Cache Rule and about 7/8 with one.** Measured 2026-08-21 with GET against
a cold object each time:

| Condition                   | Result                       |
| --------------------------- | ---------------------------- |
| Cache Rule on, cold object  | MISS, then **7 / 7 HIT**     |
| Cache Rule off, cold object | MISS, then **7 / 7 DYNAMIC** |

A second object under the same rule read 1 MISS, 7 HIT and 2 DYNAMIC across 10 requests, which is the
same picture with two requests landing at a PoP that had not filled yet.

**Measure with GET, never `curl -I`.** HEAD is what `curl -I` sends, Cloudflare does not populate its
cache from a HEAD, and every reading comes back `DYNAMIC`. That method produced the conclusion "R2
custom domains do not cache", which was an artifact of the instrument.

### The Cache Rule

One rule, scoped to the CDN hostname and nothing else:

```
expression:        (http.host eq "drupflare-cdn.example.com")
action:            set_cache_settings
action_parameters: { "cache": true, "edge_ttl": { "mode": "override_origin", "default": 3600 } }
```

In the dashboard it is **Caching > Cache Rules > Create rule**, with the hostname as the only
condition and **Eligible for cache** plus an edge TTL override. Over the API it is
`PUT /zones/{ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint`.

**A PUT to an entrypoint replaces every rule in it.** Read the entrypoint first and merge; on a zone
that has never had a cache-phase ruleset the entrypoint does not exist yet and creating it destroys
nothing.

**One zone-scoped permission creates it: `Zone > Cache Rules > Edit`.** Cloudflare's documentation
also lists the account-scoped `Account Rulesets: Edit` and `Account Filter Lists: Edit`; measured,
this rule shape needs neither. That correction matters, because the account-scoped reading is what
had rejected this lever as an account-wide write bought for one site.

### Smart Tiered Cache

Every PoP fills independently, so a request reaching a cold PoP is a MISS and an R2 Class B read.
Tiering routes a PoP miss through an upper tier instead of to the bucket, which changes absorption
from per-PoP to hierarchical.

Enable it at **Caching > Tiered Cache**, or:

```sh
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/cache/tiered_cache_smart_topology_enable" \
  --request PATCH \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --json '{ "value": "on" }'
```

The token needs `Zone Settings Write` or `Zone Write`. Tiered Cache and Smart Topology are both
available on the Free plan; Generic Global, Regional and Custom topologies are Enterprise only.
Cloudflare selects the upper tier automatically for a zone using R2 as an origin.

### Why the Model Still Defaults to Zero

`cdnAbsorption` in `scripts/measure/free-envelope.ts` defaults to **0** and should stay there.

Absorption follows the traffic, not the configuration. It is a function of reads per colo per TTL
window, so a site at 10 views/day spread over 40 PoPs absorbs almost nothing and the same site at
10,000 views/day absorbs nearly everything. Zero is the correct floor for a low-traffic site and for
any site with no rule, and it is the only value that holds at every traffic level.

So the 4.33x peak is reachable, at traffic high enough to keep PoPs warm, with one operator-applied
rule. Report anything derived from a non-zero absorption as a range.

**`cdnAbsorption` is a code-level option.** The command line takes `--visits`, `--dynamic` and
`--warmth` only; absorption is passed to `envelope()`, `optimalOffWorker()` and `scoreWorkload()` in
`scripts/measure/free-envelope.ts`, so a claim that depends on it comes from a caller that names the
value, and never from the default run.

**Drupflare does not create the rule.** It is a change to a zone the operator owns, its value depends
on traffic the product cannot see, and the model's default does not move until an operator says they
applied it.

## Related

- `docs/repository-layout.md` — every path outside `src/` and how it arrives
- `docs/building-from-source.md` — the fifteen steps a source build runs
- `docs/measurement-classes.md` — which instrument may produce which class of number
- `docs/recovery.md` — which primitive answers which failure
- `docs/external-database.md` — why the site database lives in the Durable Object
