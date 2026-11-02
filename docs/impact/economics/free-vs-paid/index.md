# Free vs Paid

What the free and paid Cloudflare plans allow a site, and which limit binds first.

Free and paid run the same host. Paid buys performance and headroom, not features. Both plans are meant to be viable Drupal hosts; free is not a demo.

Free's limits are aggregate daily budgets, not the 10 ms per-invocation CPU cap. The cap constrains one execution unit, and the architecture chooses what an execution unit is. The model is [`free-envelope.ts`](../../../../scripts/measure/free-envelope.ts); score any change with it and not against a millisecond figure.

## Pages

- [The Off-Worker Arms](off-worker-arms.md): serving without a Worker, and what a binding or an R2 read adds.

## Free-Plan Meters

Measured on deployed infrastructure, per-invocation `cpuTime` read through the Workers Observability API.

| meter                        | free-plan ceiling | binds at                                       |
| ---------------------------- | ----------------- | ---------------------------------------------- |
| **Worker requests**          | 100,000/day       | **~100,000 page views/day**, the binding limit |
| Durable Object requests      | 100,000/day       | ~588,000 PV/day                                |
| Rows written                 | 100,000/day       | ~555,000 PV/day                                |
| Duration, rows read, storage | n/m               | not close                                      |

A free site serves about 100,000 page views a day (about 3M a month) for a well-cached site,
saturated at 1.00x, and every meter except Worker requests has roughly 5x headroom. That figure
counts one Worker request a view. Static asset requests do not bill, and a drive of 198,000 asset
requests invoked no Worker (`measured`; see [The Off-Worker Arms](off-worker-arms.md#the-off-worker-arms)). Workers Cache is the one documented case that changes
this, and the shipped config does not enable it. With it on, the same arithmetic gives 1,515 views a
day.

| artifact             | what it is                                                     | from                              |
| -------------------- | -------------------------------------------------------------- | --------------------------------- |
| Worker bundle        | fits the 64 MiB Worker size limit                              | `bun run release:check`           |
| PHP 8.5, nothing cut | a raw wasm module the platform compiles ahead of time          | `interp.lock.json`                |
| First-run migration  | chunked and resumable, each batch sized to complete on its own | `assets/drupal-sql/manifest.json` |
| Static asset tree    | served by Workers Assets; 198,000 requests invoked no Worker   | `assets/core/`                    |
| Cold boot            | amortised off the request path                                 | deployed `cpuTime`                |

## What One Site Gets

Both performance levers are on by default on paid, managed or self-managed, where a warm object
costs $0 marginal. On free, shell assembly is on and warming follows the thermal policy: a site
rendering more than about 505 pages a day warms itself and a quieter one does not, because a warm
object spends 10.8% of free's two daily meters. `SITE_WARM=1` on `/settings` forces it, and
`WARM_INTERVAL_MS=30000` is a cheaper middle point at 2.9%. The numbers below are what a paid site
gets, and what a free site gets once it is busy or has opted in.

| authenticated page      |     boot |   render |       total | vs neither |
| ----------------------- | -------: | -------: | ----------: | ---------: |
| neither lever           | 1,264 ms | 2,127 ms |    3,391 ms |          - |
| warm only               |        0 | 2,127 ms |    2,127 ms |       -37% |
| shell assembly only     | 1,264 ms |  ~467 ms |   ~1,731 ms |       -49% |
| **both, on by default** |        0 |  ~467 ms | **~467 ms** |   **-86%** |

Every number in this table is derived. The shipping configuration measures 208 ms p50 from a
client ([VPS comparison](../vps-comparison.md#performance-summary)). The boot saving is a measured
subtraction. The render saving comes from a measured 4-5 ms against 20-21 ms ratio for a fragment
render against the render it replaces, and applying that ratio to an edge `cpuTime` figure is an
assumption. The table separates the two levers, which the measured figure does not.

A cached page is 0 ms in every row: it answers off the object's own SQL without booting PHP, so
neither lever can make one faster. What they speed up is the tier that always renders, which is the
logged-in one.

A fill is one page being rendered and stored so the next visitor gets it instantly, and a save is
what causes most of them. A save invalidates the pages whose cache tags it matches. A save that
touches a widely shared tag can invalidate most of a site, and then every page has to be earned
back. `PREFILL_ON_SAVE` re-queues up to `PREFILL_ON_SAVE_LIMIT` (25 by default) of the paths a save
purged, and the rest fill when somebody asks. For one site, fills/day is roughly `saves/day x 25`
plus whatever else gets visited.

| your site                    | saves/day | fills/day | share of free | share, no memory bins |
| ---------------------------- | --------: | --------: | ------------: | --------------------: |
| personal blog, 80 pages      |         1 |       ~55 |          0.1% |                  0.5% |
| small business, 200 pages    |         2 |      ~150 |          0.3% |                  1.4% |
| club or nonprofit, 500 pages |         5 |      ~375 |          0.7% |                  3.5% |
| local news, 1,500 pages      |        20 |    ~1,300 |          2.6% |                 12.0% |
| busy news, 3,000 pages       |        50 |    ~2,750 |          5.4% |                 25.3% |

The share is fills a day over the regeneration ceiling in [The Two Ceilings](#the-two-ceilings):
50,916 a day at the shipping default, 10,866 with `MEMORY_CACHE_BINS=none` (`derived`). At 55 fills
a save, a 3,000-page site can publish about 900 times a day before regeneration binds at the
shipping default and about 200 times with `MEMORY_CACHE_BINS=none` (`derived`), and serve about 3M
pageviews a month while doing it. Free's quotas are account-wide, so several warm
sites on one free account share them; a site that spends its daily meter drops back to the slow
re-arm on its own and recovers at midnight UTC.

## The Two Ceilings

| ceiling          | what it limits                     | bound by                  | free today                         |
| ---------------- | ---------------------------------- | ------------------------- | ---------------------------------- |
| **Serving**      | visits/month that can be answered  | Worker requests, 100k/day | **3.0M/month**, saturated at 1.00x |
| **Regeneration** | distinct pages re-rendered per day | rows written              | **50,916/day**                     |

The regeneration figure is the shipping default, with `dynamic_page_cache` and `menu` held in
memory. With `MEMORY_CACHE_BINS=none` it is 10,866 a day. Regeneration decides whether free is a
Drupal host and not a cache.

No page is served off the Worker. Both page tiers, the edge cache and the optional KV tier, cost one
Worker request each because the Worker has to run to consult them. The alarm drains the file and
page mirrors to an R2 bucket when one is bound, with pages ordered by view count so a limited budget
publishes what moves traffic; the canonical `wrangler.jsonc` binds no bucket. Workers Static Assets
are uploaded at deploy time, so a page rendered at runtime reaches them only through a republish.
That path is not built; [The Off-Worker Arms](off-worker-arms.md#the-off-worker-arms) models it and the R2 mirror
side by side.

There is no single rows-per-fill figure. A fill costs 2 to 94 rows depending on what is already
warm, so the model names five measured warmth classes. `ROWS_PER_FILL` in
`scripts/measure/free-envelope.ts` carries all five, and `warmthMix` prices a realistic spread.
Every figure is counted at the storage handle, so it includes the host's own writes, notably the
`cfw_page` insert that stores the whole rendered page.

The regeneration ceiling is the daily row quota (R) less the rows warming spends (W), divided by
the rows one fill writes on average (r):

```math
\text{regeneration ceiling} = \lfloor \frac{R - W}{r} \rfloor
```

The envelope script reports W as 10,896, which leaves 89,104 rows for regeneration. At the 1.75
rows per fill of the shipping default, that is 50,916 fills a day. W is the idle-day figure: 10,800
alarm rows plus 96 meter flushes, one every 900 s. The flush interval falls to 60 s as the day's
budget is spent (`meterFlushBudget()`), which is 1,440 flushes and a W of 12,240 on a heavy day, so
the ceiling is about 1.5% lower at the end of a day that used its budget than at the start.

## Where the Work Pays

| lever                                                  |      worth | note                                                                                                                                                                                         |
| ------------------------------------------------------ | ---------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Null the `page` bin** (8 -> 3 rows, warm fill)       |  **2.67x** | done. It duplicated bytes the host already stores in `cfw_page`                                                                                                                              |
| **Anything boot-directed** (JSPI, heap restore, `-O3`) | **~1.01x** | saturated for this ceiling: a 20x cut in boot cost per fill buys 1.1% of the regeneration budget. It says nothing about latency, where holding the object resident removes the boot outright |
| More slicing / decomposition                           |   negative | alarms are counted DO requests; a 6-way split measured 5,555 -> 4,166 fills/day                                                                                                              |

Two levers that look plausible are not levers. Uninstalling `dblog` does not reduce rows per fill:
measured, zero rows of a fill go to `watchdog`. And past about 85% off-Worker serving the binding
meter becomes DO requests and not rows, so trimming rows per fill beyond that point moves the rows
meter and does not move the ceiling at all.

## The Image Transform Cap

This applies to `IMAGE_ENGINE=images` only. The default engine encodes in the Worker and has no
transform allowance; it spends CPU, which is not a meter this project is bound by.

Cloudflare Images allows 5,000 unique transformations per month on free, and it fails as a hard cap
and not a bill. Every image style is a transformation, so ten styles over 2,000 images is 20,000, 4x
over. It is the only quota here measured per month and not per day, so it does not clear at
midnight.

It is projected and not counted, because it is a function of the site's content and configuration
and both are known in advance. The object multiplies its image styles by its managed images on every
alarm and records `budget.image_transforms` in the health ledger at 80% of the allowance. It is a
warning and never a repair: the remedies are dropping a style, cutting the image count, or switching
to the default engine, and all three are decisions a human makes. `/health` shows it, and `/_cfw`
shows the full projection with the largest style count that still fits.

> **Do not enable the Workers Caching feature.** Its cache key does not include the host, and this
> product is multi-tenant by host; every site serves `/`, so one site's pages would be served to
> another site's visitors. Cloudflare states it plainly: _"The cache key does not include the host,
> so a request to `/api/users/42` hits the same cached entry whether it came in through
> `api.example.com`, `api.example.net`, a service binding, or a `workers.dev` URL."_
>
> Zone settings cannot add the host back. _"No zone configuration for caching applies to Workers
> Caching. Cache Rules, Cache Response Rules, Page Rules, cache level settings … have no effect on a
> Worker's cache."_ The zone-level cache-key documentation does put the host in the key, and it
> describes a different product, so it is not evidence about this one.
>
> It is also not a serving lever. A hit skips Worker execution but is still _"billed at the standard
> Workers request rate"_, so the 100,000/day meter does not move, and it _"bills requests that are
> normally free: static asset requests and worker-to-worker invocations"_, making it a net increase.
> What it saves is CPU, which is not a meter this project is bound by.
>
> The `caches.default` tier this project does use is a different mechanism and is safe: its key
> carries both the origin and the site id. `tests/node/cache-partition.spec.ts` holds both halves.
