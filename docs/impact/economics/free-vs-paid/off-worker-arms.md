# The Off-Worker Arms

Worker requests bind the serving ceiling, and only a view that never runs the Worker avoids them.
Two arms do that. The assets arm publishes a rendered page as a static asset, which the asset layer
answers with no Worker. The R2 arm mirrors the page to a bucket behind a custom domain. Both are
scored by `offWorkerArm()` in `scripts/measure/free-envelope.ts` at the shipping default, and
`bun scripts/measure/free-envelope.ts` prints every row below.

The assets arm is not built. The R2 arm ships, but the canonical `wrangler.jsonc` binds no bucket,
and serving from it needs R2 enabled on the account and a custom domain you bought, since the
off-Worker path is a bucket on a custom domain. Every row of the first table is `derived` from the
model, each at 99% of views answered off the Worker, which is every view that is not a miss.

Static asset requests are free and unlimited (`published`, Cloudflare's Workers pricing page). The
Observability events agree on invocations (`measured`): a drive on 2026-11-02 sent 198,000 asset
requests (3,000 views of 66 paths, one laptop, 151 s) and recorded one fetch event at 0 ms of CPU in
that window, against 20,000 control requests to a deny-listed path that each ran the Worker. That
reading counts invocations, not billed requests. Whether the 198,000 bill is pending the billing read
(gate 65). The one documented exception is Workers
Cache, under which assets bill at the Worker request rate. The shipped config has no `cache` block, so
that row describes a configuration the product does not ship. A view is 66 requests, the demo site's
first load (n=1), counted as the page and 65 assets.

| arm and scenario                              | today, views a day | with the arm | bound by         | regeneration ceiling a day |
| --------------------------------------------- | -----------------: | -----------: | ---------------- | -------------------------- |
| assets, not billed                            |            100,000 |    2,973,333 | DO requests      | 50,916 (rows written)      |
| assets, Workers Cache exception (not shipped) |              1,515 |        1,515 | Worker requests  | 50,916 (rows written)      |
| R2, not billed, no Cache Rule                 |            100,000 |      336,700 | R2 Class B reads | 33,333 (R2 Class A)        |
| R2, not billed, Cache Rule on                 |            100,000 |    2,693,602 | R2 Class B reads | 33,333 (R2 Class A)        |
| R2, Workers Cache exception (not shipped)     |              1,515 |        1,538 | Worker requests  | 33,333 (R2 Class A)        |

The Cache Rule row uses an absorption of 7/8, which is the measured hit rate in
[R2 Page Origin Caching](../../../configuration/serving/r2-page-origin.md#r2-page-origin-caching): 7 of 7 hits on a cold
object after one miss, and 1 miss, 7 hits and 2 dynamic across 10 requests on a second object, so
n is small. Without a rule absorption is 0, and the best mirror share is 77%, which gives 432,900
views a day rather than 336,700. At 30.44 days a month the not-billed rows are 3.04 million views
today, 10.2 million for R2 without a rule (13.2 million at the 77% share), 82.0 million for R2 with
one and 90.5 million for the assets arm. Read the last two as ceilings of the model, not as traffic
any site has served.

What the table says, in order:

- **Under the Workers Cache exception, no arm helps.** A page that loads its 65 assets through the Worker meter spends
  66 requests a view, so the free plan's own ceiling is 1,515 views a day, about 46,000 a month, and
  the arms move it by 0% (assets) and 1.5% (R2). That figure is a first-load bound and a browser
  that caches the assets spends fewer; the cache rate has not been measured.
- **With assets unbilled, the arms lift the Worker meter and another meter binds.** The assets arm
  reaches the DO-request meter at 2.97 million views a day, because a miss still costs three object
  requests. The R2 arm reaches its Class B read allowance of 10 million a month first.
- **A month is 30 days in the ceilings and 30.44 in the bills.** `scripts/measure/free-envelope.ts`
  divides a monthly allowance by 30 (`DAYS_PER_MONTH`), which is how 1,000,000 Class A writes become
  33,333 a day. The bills in [Economics](../index.md) use `DAYS_MONTH` = 30.44 in
  `scripts/economics/bill.ts`, the same allowance as about 32,852 a day. The conventions differ by
  1.5%. Each figure here uses the convention of the script that prints it, and neither is a
  measurement.
- **Mirroring to R2 caps regeneration at a lower ceiling.** Every fill writes one R2
  object, a Class A operation. The free Class A allowance of 1,000,000 a month is 33,333 a day, which
  binds before the 50,916 a day that rows allow, so a free-account site cannot regenerate more than
  33,333 pages a day with the mirror on. That is a 34.5% lower ceiling. It does not reduce the
  regeneration a site does: a site under 33,333 a day regenerates the same amount with or without the
  mirror, and the mirror buys serving headroom in return. The shipped `R2_WRITES_PER_MONTH` guard
  stops at 900,000, which is 30,000 a day. On the managed plan, Class A beyond the allowance is billed
  rather than capped. The paid R2 rate is not recorded in `scripts/economics/rates.ts`, so it is not
  stated here. The assets arm writes no R2 object and leaves the regeneration ceiling where it is.

| per-arm quantity       | assets arm                                                                    | R2 arm                                       |
| ---------------------- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| Durable Object storage | unchanged; the page row stays in `cfw_page`                                   | unchanged                                    |
| other storage          | 14,615 page paths beside the pack on free, 94,615 on paid, per Worker version | bytes in R2, not priced here                 |
| publishing a day       | at most 5,268 serial; 1,440 at a 60 s debounce                                | 33,333 objects (30,000 at the shipped guard) |
| a save becomes visible | debounce plus 11.9 to 13.7 s                                                  | not measured                                 |

R2 is priced here only from the free-tier operation counts in `config/quotas.yml`. The R2 storage
allowance and every paid R2 rate are missing from `scripts/economics/rates.ts` and from
`config/quotas.yml`, and are not filled in from memory, so a paid R2 bill is not modelled. The
page-path headroom comes from the documented 20,000 files a Worker version on free and 100,000 on
paid, against the 5,385 files wrangler read for the canonical config.

The publishing figures for the assets arm are from the 2026-11-02 drive, on one paid throwaway
with one changed asset per republish. Four of seven attempted republishes completed; the three that
failed died in wrangler with `fetch failed` from the laptop, which says nothing about the platform.

| measurement                             | reading                                                                                | n                               |
| --------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| deploy command, wall                    | 13.0 to 16.4 s for a 17.6 MB script                                                    | 4 completed republishes         |
| changed asset served, from deploy start | 11.9 to 13.7 s, old body until then, no 404 or 5xx                                     | 4                               |
| republishes that reset the warm object  | 0 of 4                                                                                 | 4                               |
| no-deploy windows that turned over      | 1 of 5 (two idle arms and three failed deploys)                                        | 5                               |
| upload API rate limit                   | 1,200 requests per 5 minutes per token, no limit on deploys found in the docs searched | 9 deploy attempts, none refused |

The serial cap of 5,268 publishes a day is 86,400 s over the slowest measured deploy. It is a
throughput bound from four runs and not a quota, and a changed script, as opposed to a changed
asset, was not tried. The reset result is the one a republish-per-save design depends on, and n=4
with one object turning over by itself in the no-deploy windows does not separate the two.

A save does not make a visitor wait for a render at this size. In a drive of 10 saves and 1,000
anonymous visits on a six-node site where each save invalidated three paths, 0.3% of visits met a
render, 0% a 503, 27.2% a stale page and 72.5% a current one. The stale answers lasted up to
29.2 s, p50 6.6 s. Both numbers describe one small site and not a save that invalidates every page.

## What A Binding Or An R2 Read Adds

The shipped path makes one Worker invocation a view, and one more Durable Object invocation when the
view is served from the object. A Worker-to-Worker call is a separate invocation with its own CPU and no
request fee (`published`, Workers pricing page). An R2 binding read is a subrequest of the invocation that
makes it, so it adds no invocation.

- **Public bucket on a custom domain** runs no Worker: 0 invocations and 0 Worker CPU a view. This is the
  lower bound and the one the 13.2 million views a month assumes.
- **One extra Worker invocation a view**, bracketed at 1.10 ms of front-worker CPU (`measured`, a cached
  object serve on deployed paid workers, 2026-09-14, n not recorded). That is 2.81 mJ a view at the model's
  watts and PUE (`derived (modelled)`). It stands in for an R2 read through a Worker or a service hop, whose
  callee CPU is unmeasured, so it is a bound and not a reading.

Through a Worker, the mirror no longer offloads the Worker meter, and the free ceiling falls to the
Worker bound in the table above. The whole-year effect on the energy headline is in
[Service Bindings And R2](../../energy/per-request.md#service-bindings-and-r2).

On a paid account, R2 costs $0.36 per million Class B reads, $4.50 per million Class A writes and $0.015
per GB-month of storage (`published`, R2 pricing page, last updated Oct 30, 2026). The page gives the free
tier as 10 million Class B and 1 million Class A a month, and does not say what a paid account keeps. A
17.2 KB page costs $0.000258 a month per 1,000 mirrored pages (`derived (modelled)`, the page size is one
page, n=1). Whether a service-bound invocation counts toward the free plan's 100,000 requests a day is
unmeasured.
