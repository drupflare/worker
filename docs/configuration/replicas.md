# Replica Settings

Settings for replica lanes: count, autoscaling, write forwarding and lag. The concepts are on [Replica Lanes](../operating/replica-lanes.md); the index of every variable is on [Configuration](index.md).

## Variables

| Variable            | Default | What it does                                                                                               |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `REPLICA_COUNT`     | 0       | Replica lanes beyond the primary. 0 means one object per site. Values above 256 are clamped to 256.        |
| `REPLICA_AUTOSCALE` | on      | Grows the pool under sustained queueing. `0` pins the pool at `REPLICA_COUNT`.                             |
| `REPLICA_MAX_LANES` | 32      | Ceiling autoscaling will not grow past. Values above 32 are capped at 32. `0` stops growth.                |
| `WRITE_FORWARD`     | on      | Lets a lane execute a write and forward it to the primary. `0` sends every write to the primary.           |
| `REPLICA_LAG_MS`    | 30,000  | The longest a serving lane may go without pulling the log. Clamped to 1,000 through 300,000 ms.            |
| `REPLICA_READ_ONLY` | off     | `1` puts the object into replica mode. The setting is deployment-wide; see [Runtime Settings](runtime.md). |

## `REPLICA_COUNT`

Lane 0 is the primary, and lanes 1 to n are objects named `<site>#r<lane>`. `#` is outside the set `encodeSiteId()` keeps and outside its `_<hex>` escape, so a replica name cannot collide with a site id however a hostname is spelled.

The lane count the router uses is the larger of `REPLICA_COUNT` and the pool size the isolate last learned from the primary (`chooseTarget()` in `src/site/target.ts`). With the default of 0, every routing decision resolves to the primary and nothing changes.

An object's role comes from its own name. `REPLICA_READ_ONLY` is deployment-wide and would make the primary read-only too, so raising `REPLICA_COUNT` cannot put an existing object into replica mode by accident. The variable tells the router how many lanes to spread across, and nothing else.

Only `/serve` spreads. Every other route pins to the primary. A route wrongly pinned loses capacity, and a route wrongly spread answers from a replica's copy. Lane selection and the 421 handoff are described on [Replica Lanes](../operating/replica-lanes.md#routing-a-request).

One lane helps only once the single object is saturated. A fixed `REPLICA_COUNT` suits a site that is already contended. Autoscaling provisions lanes only under sustained queueing, which is the regime where even one lane pays. The measurements are on [Replica Lanes](../operating/replica-lanes.md#when-a-lane-helps).

The ceiling is 256 because of arithmetic. A lane mints forwarded row ids from its own residue class modulo the partition (`ID_PARTITION_LANES`, `src/ops/write-forwarding.ts`), and the primary takes class 0. 256 is the largest pool whose writers all hold a class of their own. Past it, two writers would mint the same id.

Set `REPLICA_COUNT` no higher than the lanes a site has provisioned. Above that, the router hashes over buckets whose objects do not exist, which costs a wasted hop and a retry on the primary for each one. `REPLICA_COUNT`, `REPLICA_AUTOSCALE` and `REPLICA_MAX_LANES` are all KV-overridable, so a pool can be turned on, resized or turned off without a redeploy.

## `REPLICA_AUTOSCALE`

Raising `REPLICA_COUNT` by hand tells the router that lanes exist. It does not create them, so the lanes it routes to hold no data and answer 421 until somebody drives the provisioning loop. Autoscaling is the half that creates one.

The signal is the number of requests that waited for the primary's gate in a window. A Durable Object runs one request at a time and a PHP render holds it for the whole render, so a waiting request is the queue, and a queue is the only thing a pool can fix. The target is one lane per waiter that held across the last three windows (the minimum over them), so a single burst cannot provision a lane that then exists forever. A window with no queue count falls back to peak concurrent in-flight requests, and the target is then the minimum peak across the three windows, minus one (`laneTarget()` in `src/ops/replica-demand.ts`). One quiet window clears the run. The copy is driven a chunk at a time off the alarm, the same way a fresh site migrates, so no firing owns a whole table copy.

An explicit `REPLICA_COUNT` is a floor rather than a ceiling: a site told to run 2 lanes runs at least 2 and may still grow. `REPLICA_AUTOSCALE=0` is how an operator pins the number instead.

## `REPLICA_MAX_LANES`

The ceiling autoscaling will not grow past. The default is 32, and larger values are capped at 32.

Throughput does not set the cap. Addressing objects directly and summing, efficiency against perfect scaling is 100, 95, 90 and 85% at 8, 16, 32 and 48 replicas, a loss of about 5 points per doubling. This figure describes the topology. Routed throughput is a separate measurement, on [Replica Lanes](../operating/replica-lanes.md#across-a-pool). The default of 32 is a cost bound, not a correctness one. The correctness ceiling is 256, as described under `REPLICA_COUNT`.

Set `REPLICA_AUTOSCALE=0` when measuring against a fixed lane count. Autoscaling builds lanes under the load a benchmark offers, so a control arm provisioned with zero lanes can answer from `r1` and `r2` on its first run. Read `x-cfw-lanes` back at drive time rather than trusting the configured number.

A pool is reached only by isolates that have already seen it. `believedLanes()` is per isolate and is set from the `x-cfw-lanes` the primary reports on a response. The first request a cold isolate makes goes to the primary whatever the pool size. The belief expires after `LANES_TRUST_MS` (60 seconds, `src/ops/replica-routing.ts`). Sustained traffic keeps every isolate warm, while a low-rate or bursty client sees a larger share answered by the primary. Count distinct `x-cfw-replica` values across a burst to read a pool, since a single response cannot show it.

A lane the router is not choosing falls back to the slow re-arm and hibernates, so an unused lane costs storage and replication catch-up rather than a warming chain.

## `WRITE_FORWARD`

Lets a pool lane execute a write and forward the statements to the primary rather than refusing it. On unless `0`. It is reachable only where a pool already exists: every caller is behind a lane name or a non-zero `REPLICA_COUNT`, and both are off by default. A site with no pool is unaffected by this value.

The lane runs the whole write locally, discards its own effect through the driver's `commit: false` path, and hands the statement list to the primary, which stays the sequencer. Ids are partitioned so that every writer holds a residue class no other writer mints: lanes from their lane number, the primary from slice 0. A lane records the ids it forwarded so it cannot repeat one before replication catches up.

Two things are worth knowing before turning it off. A write reaches a lane at all only because this is on. With it off, the router pins every POST to the primary, so the one object the pool exists to relieve keeps every form submission. An unbuffered write, one Drupal issues outside a transaction, takes the transaction bridge on a lane rather than the exec bridge, because `cfwSqlExec` has no rollback and a write on it can be neither forwarded nor discarded. That routing lives in the driver. The host's guard refuses an exec write and fails over, which is what happens if the two ever disagree about whether a connection holds a residue class.

## `REPLICA_LAG_MS`

The bound on how far behind a serving lane may fall. A `SERVING` lane pulls the primary's log on its own alarm, and `replicaLagMs()` (`src/ops/replica-routing.ts`) sets the interval. The default is 30,000 ms, clamped to 1,000 through 300,000 ms. Below a second a lane spends more on asking than on serving.

Without this bound, a serving lane re-arms at `KEEP_WARM_MS` (240,000 ms) and can serve a copy four minutes behind the primary. The staleness fence refuses only a caller that states a freshness requirement, and a visitor states none.

Each round costs two Durable Object requests against the primary, so this is a cost knob as much as a freshness one.

## Creating a Lane

`GET /replica?action=provision&lane=<n>` on the primary. It copies a bounded number of rows, answers with a cursor, and the caller passes that cursor back until `done`:

```sh
curl "$SITE/replica?action=provision&lane=1"
curl "$SITE/replica?action=provision&lane=1&cursor=<the cursor from the last answer>"
```

It runs on the primary because that is the object a caller can reach. A lane has no route into it from outside. The lane needs no Drupal install of its own, since each chunk carries the table's DDL, and it reaches `VERIFIED` on the final chunk, which arms its alarm. From there it is self-driving.

`budget` sets rows per invocation and defaults to 4,000. The cursor carries the generation the copy began at, so a commit on the primary part-way through answers `torn`, which keeps the far end from refusing in a way that reads like a bug. Restart the copy; there is no resume.

A primary cannot be copied from until it has minted `system.private_key`, which Drupal does on first use and never at install. `action=snapshot` answers 409 naming the gap. `\Drupal::service('private_key')->get()` on the primary closes it.

Cron defaults to on. Leave it on unless a site has a reason not to: a module that depends on cron does not fail when cron never runs, it silently does nothing. Six of twenty-five surveyed contrib modules need it.
