# Energy Per View

The energy of one page view, how often each host has to render one, and what a visitor's own device spends on the same page. The totals this builds on are on [Energy](index.md). Numbered citations on this page, such as [[7]](../references.md), refer to the [references on Impact](../references.md#references).

## Energy Per View

A visitor sees a view, and what a view costs depends on how often it renders. This section prices the mix. Render and cached-serve costs are CPU time priced at the modelled watts per core and PUE, the same basis as the [per-request figures](per-request.md#energy-per-request). The results are the marginal energy of serving a view, with no idle power in them, unlike the totals in [Energy Savings](index.md#energy-savings). Everything here is `derived (modelled)` unless marked, from `bun scripts/economics/perview.ts`.

### How Often Each Host Renders

The share of views that render, `derived (modelled)` from [the render-fraction model](operating-states.md#the-render-fraction): 100 paths, Zipf 1, five saves a day, five pages invalidated per ordinary save. A cache with a clock renders each path again every time it expires, at every location that holds a copy. drupflare's page store renders when a save invalidates a page and never on a clock. Each cell is a percentage of views a month.

| host shape                      | 10,000 | 100,000 | 1,000,000 | 10,000,000 | 30,000,000 |
| ------------------------------- | -----: | ------: | --------: | ---------: | ---------: |
| stock nginx, 5 min, no purge    | 100.0% |   86.2% |     45.7% |      8.65% |      2.92% |
| one shield, 1 h, tag purge      |  91.0% |   43.0% |     7.34% |     0.738% |     0.246% |
| 8-location CDN, 24 h, tag purge | 100.0% |   27.5% |     3.04% |     0.304% |     0.101% |
| one shield, 24 h, tag purge     |  33.2% |   3.80% |    0.380% |     0.038% |     0.013% |
| drupflare page store            |  7.60% |  0.760% |    0.076% |     0.008% |     0.003% |

Stock nginx caches nothing without configuration and its purge is a commercial feature [7], so the first row has no purge. The lifetimes are assumptions: Pantheon's documentation describes origin shields and sets a lifetime per response without recommending one [8], so the 1 h and 24 h rows are chosen and not quoted, and 24 h is the longest row. At a million views a month drupflare renders 5 to 97 times less often than the three shielded or purged shapes, and 601 times less often than stock nginx. At 10,000 views the gap is 4.4 to 13 times.

The lifetimes favour the caches. drupflare still renders less often than every row, because it never renders on a clock. What that saves per view depends on what a view costs when it does not render, which the rest of this section prices.

### Energy On The Traffic Mix

`config/traffic.yml` weights 82% anonymous reads of an existing page, 9.5% uncached anonymous views, 3% signed-in readers, 3% editors in the admin interface and 2.5% signed-in users on their own page. Logged-in views are included. A conventional host renders every logged-in view, because its cache is bypassed for a session. drupflare answers them from the compiled plan. Both sides are priced from CPU time at the same watts per core and PUE, with the opponent's CPU scaled to the deployed render, so one instrument charges both. The drupflare row is the figure the headline and the production table use.

The 9.5% uncached share sets the mix and is not a render count. A render is priced from the page-store model for drupflare, saves times the pages a save invalidates, and from each opponent's lifetime model for the others. A view that a store or a cache already holds costs a hit. The weight would matter if every such view were a PHP render on drupflare. That adds 0.095 of the 149.2 mJ gap between a render (153.8 mJ) and a hit (4.6 mJ), 14.2 mJ a view, and a native opponent that rendered them all adds 8.7 mJ. At a million views that is 19.7 mJ for drupflare against 16.6 mJ for the 24-hour shield, so the lead depends on those views not rendering. `config/traffic.yml` calls them the uncached tail, a first visit or a purged path, and no deployed site has reported what share of them reaches PHP.

On anonymous views, the energy per view is the cached-hit energy plus the render fraction times the gap between a render and a hit. With `f` the render fraction from the first table, `E_hit` the cached-hit energy and `E_render` the render energy, both for drupflare:

```math
E_{\text{view}} = E_{\text{hit}} + f(E_{\text{render}} - E_{\text{hit}})
```

At a million views `f` is 0.076%, which gives 4.6 + 0.00076 x 149.2 = 4.71 mJ, the anonymous-only figure below.

Energy per view on the mix, in millijoules, `derived (modelled)`, with the opponent's figure over drupflare's in brackets:

| host shape (mJ per view)               |       10,000 |       100,000 |    1,000,000 |   10,000,000 |   30,000,000 |
| -------------------------------------- | -----------: | ------------: | -----------: | -----------: | -----------: |
| drupflare, compiled plan holding       |         15.8 |           6.4 |          5.5 |          5.4 |          5.4 |
| stock VPS, Drupal page cache only      | 21.4 (1.36x) |  16.3 (2.54x) | 15.8 (2.88x) | 15.7 (2.92x) | 15.7 (2.92x) |
| stock nginx, 5 min, no purge           | 91.0 (5.77x) | 79.4 (12.38x) | 45.7 (8.34x) | 14.8 (2.75x) | 10.0 (1.87x) |
| one shield, 1 h, tag purge, nginx hit  | 83.4 (5.29x) |  43.5 (6.78x) | 13.7 (2.50x) |  8.2 (1.53x) |  7.8 (1.45x) |
| one shield, 24 h, tag purge, nginx hit | 35.3 (2.24x) |  10.8 (1.68x) |  7.9 (1.45x) |  7.6 (1.42x) |  7.6 (1.42x) |
| same, CDN hit costed at 0 (a floor)    | 34.2 (2.17x) |   9.1 (1.43x) |  6.2 (1.14x) |  5.9 (1.10x) |  5.9 (1.10x) |

The `/user/1` page is charged the compiled-plan cost of `/admin/content`. That rests on a measured 2.3 ms of CPU for the page in plan state, with the plan held on 94% to 99% of views once it had converged, at n=2 per cell on `paisley-park`, below the n=5 bar. A first run saw `/user/1` render on 57% of views. The suspected cause, the plan tier's retry latch (`edgePlanRefused` and `refusedAt` in `src/ops/edge-plan.ts`), has been fixed. The effect on a deployed `/user/1` is unmeasured.

### The Two Penalties

drupflare pays two costs that a native host does not:

- **Wasm render:** 1.65 times the CPU of a native one, `measured`, at 32.5 ms against 19.6 ms for the same page on the same machine. At the same watts that is 153.8 mJ against 92.9 mJ per render.
- **Cached hit:** 4.6 mJ against 1.9 mJ for an nginx hit, `derived` on one CPU basis. A view that reaches drupflare is charged the front Worker and the object, 1.8 ms of CPU, while nginx answers a hit from its own cache.

Rendering less often outweighs both up to a point the model prices. An nginx-hit opponent costs more per anonymous view than drupflare once it renders on more than 3.0% of views, because renders at that rate repay the 2.7 mJ gap on the hit. Stock nginx and the one-hour shield sit above that line at 100,000 and 1,000,000 views a month, and the mix table above shows the result: 2.5 to 12 times the energy per view. The same comparison on anonymous views alone, `derived (modelled)`:

| anonymous views only (mJ per view)     | 10,000 | 100,000 | 1,000,000 | 10,000,000 | 30,000,000 |
| -------------------------------------- | -----: | ------: | --------: | ---------: | ---------: |
| drupflare                              |  15.95 |    5.73 |      4.71 |       4.61 |       4.60 |
| stock nginx, 5 min, no purge           |  92.95 |   80.33 |     43.49 |       9.73 |       4.51 |
| one shield, 1 h, tag purge, nginx hit  |  84.72 |   41.05 |      8.54 |       2.52 |       2.07 |
| one shield, 24 h, tag purge, nginx hit |  32.11 |    5.31 |      2.20 |       1.88 |       1.86 |

Below that line the penalties win on anonymous views. A shielded host that renders on 0.38% of views costs 2.20 mJ per anonymous view against drupflare's 4.71, and it keeps that lead from a million views a month up. On the mix drupflare is still ahead, because the logged-in views go the other way: they add 5.9 mJ per view to the opponent and 1.2 to drupflare, which renders none of them when the plan holds.

### The Closest Opponent

The closest opponent is a shielded 24 h tag-purged cache. It uses 1.45 times drupflare's energy per view at a million views and 1.42 times from ten million up. Its lifetime is the longest modelled, so it is chosen to favour the opponent. A shield collapses the per-location expiry to one fill, and a 24 h lifetime with tag purge leaves it almost nothing to render. Two further assumptions in the model favour it:

- The model has no CDN eviction term. A real cache drops cold pages under memory pressure and each location fills cold, while a page store that persists on disk does not.
- The opponent's hit is priced as an origin nginx hit, 1.9 mJ, because no source publishes the cost of a CDN hit. Costing the hit at zero is a floor and gives 1.10 to 1.14 times.

### How The Lead Moves

drupflare renders 5 to 97 times less often than the shield at a million views, and the shield can still use less marginal energy per view, because its cache hit costs 1.9 mJ against drupflare's 4.6. Which wins depends on how much of the traffic is logged in, since a conventional host renders every logged-in view and drupflare answers it from a compiled plan, and on how often that plan holds.

The first table is the shield's energy per view over drupflare's, so a value above 1 means drupflare is ahead. The plan holds on every logged-in view, and "free hit" costs the CDN hit at zero. `derived (modelled)`, from `bun scripts/economics/states.ts`:

| logged-in share | drupflare at 1M (mJ) | shield, nginx hit | shield, free hit | drupflare at 10M (mJ) | shield, nginx hit | shield, free hit |
| --------------: | -------------------: | ----------------: | ---------------: | --------------------: | ----------------: | ---------------: |
|              0% |                 4.71 |             0.47x |            0.07x |                  4.61 |             0.41x |            0.01x |
|              1% |                 4.80 |             0.60x |            0.22x |                  4.70 |             0.54x |            0.16x |
|              5% |                 5.16 |             1.08x |            0.74x |                  5.07 |             1.04x |            0.69x |
|   8.5%, the mix |                 5.48 |             1.45x |            1.14x |                  5.39 |             1.42x |            1.10x |
|             20% |                 6.52 |             2.40x |            2.18x |                  6.43 |             2.39x |            2.16x |
|             50% |                 9.22 |             3.89x |            3.79x |                  9.17 |             3.89x |            3.79x |

On a mostly anonymous mix the shield uses less. The two are level at 4.3% logged-in views at a million and 4.7% at ten million against an nginx hit. drupflare is 1.4 times ahead at the mix's 8.5%. The plan matters the same way. The second table holds the logged-in share at the mix's 8.5% and lets the plan hold on fewer of those views:

| plan holds on | drupflare at 1M (mJ) | shield, nginx hit | shield, free hit | drupflare at 10M (mJ) | shield, nginx hit | shield, free hit |
| ------------: | -------------------: | ----------------: | ---------------: | --------------------: | ----------------: | ---------------: |
|          100% |                 5.48 |             1.45x |            1.14x |                  5.39 |             1.42x |            1.10x |
|           90% |                 6.34 |             1.25x |            0.98x |                  6.25 |             1.22x |            0.95x |
|           75% |                 7.63 |             1.04x |            0.82x |                  7.54 |             1.01x |            0.79x |
|           50% |                 9.78 |             0.81x |            0.64x |                  9.69 |             0.79x |            0.61x |
|            0% |                14.09 |             0.56x |            0.44x |                 14.00 |             0.55x |            0.42x |

A view the plan does not hold is charged a wasm render of the page, native CPU times the measured 1.65 wasm ratio. The plan has to hold on 72% of logged-in views at a million views a month and 74% at ten million to stay ahead of an nginx hit, and on 91% and 94% to stay ahead of a free one. The measured hold is 94% to 99%, at n=2, so the free-hit cell is the least settled figure on this page and the nginx-hit cell has about twenty points of margin.

## Visitor Devices

Every table above stops at the data centre. A visitor's browser also spends energy on each navigation. drupflare gives its static assets a one-year cache lifetime, so a repeat navigation within that year requests the page and little else. [Configuration](../../configuration/index.md) lists the lifetimes. The measured run served the same year on every asset, and its navigations came minutes apart.

One repeat navigation, `measured` on a desktop CPU with RAPL package-0, idle subtracted per round, n=8 rounds of 300 navigations a window, arm order rotated. The first row put the four demo pages on a static origin in the same container as headless Chromium, with a 40 ms emulated round trip. The second drove a deployed free-plan worker over the lab's Wi-Fi, a 16 ms round trip:

| setup                         | joules a navigation | range     | requests | wall time |
| ----------------------------- | ------------------: | --------- | -------: | --------: |
| static mirror, 40 ms emulated |                1.45 | 1.35-1.51 |     3.00 |   49.9 ms |
| deployed worker, real network |                1.31 | 1.23-1.41 |     1.00 |   48.7 ms |

The mirror's three requests are the HTML and two analytics beacons. A workers.dev site has no beacon, so the deployed worker's one request is the HTML, and a fresh site references 19 to 20 assets a page where the demo references more. The readings include the origin's CPU on the mirror, and they leave out the display, the radio, network equipment and the energy of Cloudflare's asset layer. They are desktop readings. No phone has been measured, and a phone is expected to draw less per navigation.

The yearly total depends on an input nobody has measured for a real site: the share of navigations that find every asset still fresh in the browser. A cold-cache navigation has no reading here, so the table covers the fresh ones alone. It sweeps that share, `derived (modelled)`, priced at the mirror's 1.45 J, the higher reading, from `bun scripts/economics/device.ts`:

| views a month | 25% fresh | 50% fresh | 75% fresh |
| ------------: | --------: | --------: | --------: |
|        10,000 |   12.1 Wh |   24.2 Wh |   36.3 Wh |
|       100,000 |    121 Wh |    242 Wh |    363 Wh |
|     1,000,000 |  1.21 kWh |  2.42 kWh |  3.63 kWh |
|    10,000,000 |  12.1 kWh |  24.2 kWh |  36.3 kWh |
|    30,000,000 |  36.3 kWh |  72.7 kWh |   109 kWh |

Those are kWh a year on visitors' desktops. The server tables above don't include them, and the two sets of figures are not added or divided on this page: one is a measured desktop package reading, the other is modelled CPU time at 2.22 W a core.

## What Spool Adds

Spool is the service worker the front worker installs in a visitor's browser. It answers repeat navigations on the device, converts images to WebP, sets `preload="none"` on video and swaps a YouTube or Vimeo embed for a facade until it is clicked. It changes the Worker request count, the visitor's device energy and the Worker's own CPU, and each is measured or modelled separately below. The measured rows come from two deployed paid-account workers that differ only in whether spool runs. They were driven from a container on a desktop CPU (RAPL package-0, idle subtracted per navigation, arm order rotated, one fresh browser context per cold navigation). The sites are synthetic: one page with an image, a video and an embed, and plain pages beside it.

**Requests, `measured`.** Every one of 48 repeat navigations on the spool worker made zero network requests, answered from the device. The same navigations on the other worker made one to six. A new device asks the spool worker for `/spool-sw.js` and for `/.spool/*`: 482 and 507 requests over about 500 new devices, so a new device costs about two Worker requests beyond its page (`derived`, from those two counts and the device count). Over the whole run the spool worker answered 1,751 front worker invocations and the other 4,196 for the same drive. An earlier local run counted four per device. The deployed workers show the two artifact requests, so the count here is two.

These readings were taken with the 0.x library, which served the worker script and the page script from the Worker. The 1.0.0 library serves both as static assets, which are not Worker invocations, so the Worker requests a new device costs differ from the two counted here. That count is not re-measured on this page. [Spool](../../configuration/integrations/spool.md) says what the worker serves now, and the request model below counts the 1.0.0 library.

**Visitor energy, `measured`.** Joules a navigation on a desktop CPU, off over on per round:

| navigation                      | spool on | spool off | off over on (range) | rounds |
| ------------------------------- | -------: | --------: | ------------------- | -----: |
| repeat                          |   0.53 J |    1.29 J | 2.47 (2.26-2.56)    |      8 |
| repeat, the same arm both sides |   1.31 J |    1.34 J | 1.00 (0.99-1.05)    |      4 |
| first view, all media           |   12.9 J |    32.8 J | 2.65 (2.29-3.36)    |      6 |
| first view, embed only          |   12.0 J |    34.1 J | 2.89 (2.63-3.72)    |      5 |
| first view, image only          |   9.83 J |    9.65 J | 0.94 (0.80-1.02)    |      6 |
| first view, video only          |   10.9 J |    10.9 J | 1.02 (0.87-1.47)    |      6 |
| first view, plain pages         |   10.0 J |    8.94 J | 0.84 (0.68-1.02)    |      6 |

The second row is the harness against itself and reads 1.00, so the 2.47 is not a bias in the instrument. A repeat navigation saves 0.77 J here, which agrees with the 0.80 J desktop reading in spool's own impact page (`published`). That page also gives 0.088 J on an iPhone 14 Pro and a 12.4 J modelled headline, and neither is re-derived here. The saving on a first view comes from the embed: all-media pages moved 1.37 MB in 35 requests off and 0.20 MB in 21 on, and the embed-only page moved 1.29 MB in 35 and 0.16 MB in 20. The image-only, video-only and plain rows sit inside their own spread and are not savings. The plain-page row leans the other way (0.84), which fits a new device paying for the worker's install, but its spread covers 1.0, so it is not a cost either. The cold rows range from 4 to 14 J within one arm, so read the ratios and not a single figure. The embed rows depend on the live third-party player a visitor's browser fetched that day.

**Time per view, `measured` on a deployed site.** Two deployed throwaway sites (paid account, one session per arm, Chromium on one desktop, 100 clicks through the seeded articles) were timed with the browser's own navigation timing, in milliseconds, median with p90 in brackets:

| arm                                |   n | first byte   | load event   | click to load |
| ---------------------------------- | --: | ------------ | ------------ | ------------- |
| spool on, answered on the device   |  98 | 1.8 (3.6)    | 11.8 (18.6)  | 22.0 (52.0)   |
| spool off, answered by the network | 100 | 41.9 (139.7) | 52.0 (146.9) | 74.0 (166.0)  |

The ratios of the medians are 23x for the first byte, 4.4x for the load event and 3.4x for the whole click. With spool on, two of the 100 clicks went to the network (clicks 1 and 2) and are not in the first row. This is one session per arm, so there is no spread across sessions, and the within-session maxima are long (1,772 ms for one device click, 1,829 ms for one network click). The host load average ran from 2.5 to 20 across the two arms and the cause was not traced, which if anything inflates the device row. The network row is this desktop's path to its nearest Cloudflare location, so a visitor farther from a location gains more and one next to it gains less. The same rig against a local server over loopback, with no network delay (3 repeats per arm, spread 0.1 ms), reads 2.2 ms against 5.7 ms for the first byte, 14.7 against 16.9 ms for the whole view and 33 against 34 ms for the click, so the deployed gain is probably the network round trip a view no longer makes (inferred, not separated by a latency arm). Spool's own impact page reports 10.8 ms against 49.9 ms (4.6 times, `published`, 8 rounds, loopback, its own demo); the loopback reading on a drupflare site did not reproduce that ratio. A phone and a radio are not measured.

**Worker CPU, `measured`.** The platform's `cpuTime` for the front worker, in whole milliseconds:

| request class   | n (on) | on: median, p90, max | off: median, p90, max |
| --------------- | -----: | -------------------- | --------------------- |
| page            |    544 | 6, 16, 38 ms         | 1, 4, 23 ms           |
| image file      |    182 | 2, 96, 187 ms        | 1, 3, 9 ms            |
| spool endpoint  |    507 | 0, 0, 22 ms          | none                  |
| spool worker JS |    482 | 0, 4, 10 ms          | none                  |

Decorating a page costs about 5 ms at the median, and the first conversion of an image shows in the tail (a p90 of 96 ms and a 187 ms maximum). A median of 1 ms is the meter's floor and not a reading of 1.0. These ran on a paid account. A free handler caps CPU at 10 ms, and a 16 ms p90 and 38 ms maximum page have not been run there.

A later paid-account reading was lower. Two deployed workers answered 200 sequential fetches of one page each (n=200 per arm): the decorated page read a median of 1 ms, p90 3, p99 4, maximum 10, and the undecorated page a median of 1 ms, p90 1, p99 4, maximum 6. At the meter's whole-millisecond grain the medians are equal, so the bills below keep the 5 ms as an upper estimate and the true difference is between under 1 and 5 ms. A 10-request loop on the long-session worker read a median of 5 ms, p90 7, maximum 10 (n=10), which sits with the 5 ms, so the two loop lengths disagree. The cause of the gap between the two readings is not isolated, and a free-plan reading is still missing.

**Requests per visit, `derived (modelled)` over `measured` counts.** Spool 1.0.0 serves its page script, boot script and stub as static assets, which are not Worker invocations, so a new device pays no request of its own for them. The Worker still answers a request in four places: a document, a page the device's worker fetches, a contact (a sync), and a write or a miss. The device's worker fetches a page only the first time it sees it, in place of the document the browser would have sent, and answers a page it holds with no request. There is no precache. An earlier reading counted nine "page copies" on top of the views, and they are the nine distinct pages that session visited, each fetched once. Each constant is `SPOOL_REQUESTS` in `scripts/economics/measured.ts`, read with the browser rig in `scripts/measure/spool-deployed.ts` on `wrangler dev` with Chromium headless, on a demo site of nine pages, one run per cell (n=1, no spread), counting network documents, service-worker page fetches and `/.spool/*` endpoints:

| views in one visit | spool off | spool on | with one returning view, off | with one returning view, on |
| -----------------: | --------: | -------: | ---------------------------: | --------------------------: |
|                  1 |         1 |        1 |                            2 |                           2 |
|                  2 |         2 |        2 |                            3 |                           3 |
|                  3 |         3 |        3 |                            4 |                           3 |
|                  5 |         5 |        4 |                            6 |                           4 |
|                 10 |        10 |        7 |                           11 |                           7 |
|                 20 |        20 |       11 |                           21 |                          11 |
|                100 |       100 |       11 |                          101 |                          11 |

The visit walks the front page and articles 1 to 8 in turn, so it reaches 3, 6 and 9 distinct pages at 5, 10 and 20 views and stays at 9 from there. A device on spool never sent the Worker more requests than with spool off, at any of the seven lengths. The deployed fixed session on the paid account (n=1, platform Workers Observability events per phase) read the same shape. The first view was 1 Worker invocation with 59 static assets beside it adding none. The 20 clicks sent 2 network documents and the device answered the other 18; the window held 11 Worker invocations, the 2 documents and the 9 fetches, with 15 object invocations. The reload and the repeat visit sent no request and invoked nothing. The deployed spool-off session read 1 Worker invocation for the first view, 20 for the window, 1 for the reload and 1 for the repeat visit, which is one per document view and what the model assumes for off. A paid-account deployed session therefore counts 3 network documents before the worker controls (the first view and clicks 1 and 2), against 2 on the local rig. Each is one reading.

The model has one constant for the views that reach the network before the worker controls the page, `c`. A visit of `v` views to `D` distinct pages costs the Worker, with a held page costing 0:

```math
Q = \min(v, c) + \min(\max(v - c, 0), D)
```

That form treats every page seen before the worker took control as seen again later, so it is an upper bound on an actual path, and `Q \le v` for every `v`, `D` and `c`. A path that never returns to the first `c` pages costs less. Fitted with `c = 2` and counting the rig's actual page sequence, the model reproduces all seven local cells and the seven with-return cells with a residual of 0 each. With `c = 3` it reproduces the deployed session (12 on, 23 off for the 21 views, reload and repeat) with a residual of 0. The same constants cross over: `c = 3` misses the local matrix, and `c = 2` is one request short on the deployed session. The model fits no free parameter, because each of `c` and `D` is read off a run. The visits below are from `bun scripts/economics/spool.ts` at `c = 3`, `derived (modelled)`:

| visit              | spool off | spool on |
| ------------------ | --------: | -------: |
| 1 view             |         1 |        1 |
| 2 views, 2 pages   |         2 |        2 |
| 5 views, 3 pages   |         5 |        5 |
| 20 views, 9 pages  |        20 |       12 |
| 20 views, 20 pages |        20 |       20 |
| 121-view session   |       121 |       12 |
| 2,000-view tab     |     2,000 |       12 |

The 5-view row is the model's bound: the rig's own 5-view visit cost 4 at `c = 2`, because it returns to the front page after the worker holds it. The 121-view session is the spool repository's own length, on the demo site's nine pages; its page count is the demo site's and is not a real site's. The 2,000-view tab is a bound and says nothing about a real visitor. The deployed 121-view mix on the paid account (n=1) read 12 Worker invocations with spool on and 122 with it off, which is the model's 12 and 121 plus the one the off arm's repeat visit adds. A deployed 2,000-click tab with spool on (n=1) sent 2 network documents, answered 1,998 clicks on the device and invoked the Worker 11 times in the click window and once for the first view, so 12 in all; its reload and its repeat visit invoked nothing. The tab has no spool-off arm, which the model puts at about 2,000. The local rig's 100-view visit read 11 at `c = 2`. The no-worker case (WebKit's default, which registers no worker) has no reading and is not modelled; the floor section below sweeps what it would take to matter. A return day past the 900 s freshness bound would cost one contact in place of the document, `assumed`, an upper bound that cannot exceed what the same day costs with spool off.

### Visit Behaviour From Public Data

How much spool saves depends on pages read in a visit and on how many of them a device already holds. The figures below were read from public sources and from the maintainer's own Cloudflare analytics on 2026-11-21, and each quoted number was then re-checked against the page that prints it (86 of 99 figures matched as written, 7 were corrected for wording such as desktop-only or "average" against "mean", and 6 were dropped because the page could not be read or no longer showed the figure). The sources do not measure the same thing: a visit is a session, a reading sequence or a navigation tree depending on the source, so read each row with its definition. The economics tables on [What Spool Adds To The Plans](../economics/index.md#what-spool-adds-to-the-plans) use only the rows marked used.

| source (year of data)                                                                                                                                                                                            | site type                       | figure                                                                                                                     | what it counts                                                                                | used    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------- |
| [Oho, higher education benchmarks (2022)](https://www.oho.com/blog/2023-google-analytics-benchmarks-higher-education-websites)                                                                                   | higher education                | 2.3 pages a session                                                                                                        | "average", Google Analytics                                                                   | yes     |
| [Oho (2021)](https://www.oho.com/blog/2022-google-analytics-benchmarks-higher-education-websites)                                                                                                                | higher education                | 2.4 pages a session                                                                                                        | "average"                                                                                     | yes     |
| [Oho (2017)](https://www.oho.com/blog/2018-google-analytics-benchmarks-higher-education-college-and-university-websites)                                                                                         | higher education                | 2.74 pages a session                                                                                                       | "average"                                                                                     | yes     |
| [smartocto, 231 brands, 343,167 articles (2025)](https://smartocto.com/blog/metrics-that-matter-in-2025-useful-editorial-analytics-benchmarks/)                                                                  | news                            | 1.92 articles of page depth                                                                                                | article level; the text says average, the method says median                                  | yes     |
| [Contentsquare, 2,942 websites (2022)](https://go.contentsquare.com/en/2023-digital-experience-benchmark-explorer)                                                                                               | all industries                  | 4.6 pages of session depth                                                                                                 | mean or median not stated                                                                     | yes     |
| [HubSpot, 336 U.S. SEOs and marketers (2025)](https://blog.hubspot.com/website/web-traffic-analytics-report)                                                                                                     | all industries                  | 7 page views a visit                                                                                                       | self-reported estimates, not analytics                                                        | yes     |
| [Piccardi et al., English Wikipedia (March 2021)](https://arxiv.org/html/2112.11848)                                                                                                                             | reference                       | 1.41 (mobile) to 2.40 (desktop) page loads a reading sequence; 68% to 78% of sessions load one page                        | geometric and arithmetic means; 11.1% of consecutive views reload the same article, 13.4% ABA | yes     |
| [Piccardi et al., rabbit holes (March 2021)](https://arxiv.org/html/2203.06932)                                                                                                                                  | reference                       | median 18, mean 24 page loads in 0.24% of navigation trees                                                                 | the longest-visit tail                                                                        | yes     |
| [Chartbeat, over 300 million first visits](https://chartbeat.com/resources/general/increase-return-visits-news-sites/)                                                                                           | news                            | 14% return within 7 days; 8% after one page, 22% after two, 28% after five                                                 | return within 7 days                                                                          | yes     |
| [Pew Research, Parse.ly corpus of about 71 million users (2016)](https://www.pewresearch.org/journalism/2016/05/05/5-on-cellphones-return-visitors-spend-more-time-with-articles-than-visitors-overall/markdown) | news                            | 3% (short form) and 4% (long form) return to the same article; 81% of returners come back the same day                     | cellphone readers                                                                             | context |
| [Tauscher and Greenberg, 23 subjects (1997)](https://chi1997.acm.org/proceedings/paper/sg.html)                                                                                                                  | all pages                       | 58% recurrence rate (SD 9%)                                                                                                | browsing in the 1990s                                                                         | context |
| the maintainer's own sites, Cloudflare Web Analytics (30 days to 2026-11-21)                                                                                                                                     | personal, blog, docs, marketing | 1.60, 1.00, 1.25 and 1.00 to 1.88 page loads a visit; 1.18 pooled (1,760 loads, 1,490 visits) and 1.00 for the median host | real browsers, bot filter on, sampled; excludes the maintainer's own benchmark host           | yes     |
| the same sites, Cloudflare HTML request analytics                                                                                                                                                                | personal, blog, docs, marketing | 405, 99, 1,045 and 77 distinct pages with a human view; the top page takes 44%, 14%, 19% and 65% of views                  | bots separated by user agent (13% to 73% of HTML views); sampled                              | yes     |
| sitemap counts of 260 sampled public US university home pages (2026-11-21)                                                                                                                                       | higher education                | median 900 URLs for WordPress (71 sites, 34 lower bounds), 1,475 for Drupal (43 sites, 3 lower bounds)                     | CMS read from raw page markup; Joomla had 1 site and is not reported                          | yes     |

What the sources do not give. The federal analytics program publishes visits and sessions and no page views, so there is no views-per-visit figure for government sites. The Web Almanac CMS chapters publish no pages-per-site count. No readable source gives a visit length for nonprofit, community, ecommerce or healthcare sites, or for a visit split by CMS, and no public analytics dashboard of a Drupal, WordPress or Joomla site with page views turned up. A returning-visitor share over 30 days was not readable either, and the 7-day and same-article figures above are for news. Those site types are left out of the tables, not filled from an average.

### The Net Floor

The net floor is the views a day the free plan's 100,000 Worker requests carry when every visit has the length that costs spool the most per view, which is a visit that reaches a new page on every view. With spool off it is the cap, 100,000. `derived (modelled)`: the floor equals the cap, 100,000 views a day at 1.00 requests a view. A device sends a request for a page the first time it sees it, the same request the document would have been, and none for a page it holds, so no visit costs more than it would have with spool off. This holds for the local matrix at all seven lengths (measured, n=1 per cell) and for the deployed session (n=1).

No term in the model lowers the floor. The only one that could is a request a device adds beyond its documents and fetches, for example a bootstrap by a client that registers no worker. No reading exists for that client, so the model carries it as an input set to 0 and the sweep shows what it would take:

| requests added a device, visits of 2 or more views | floor, views a day |
| -------------------------------------------------: | -----------------: |
|                                                  0 |            100,000 |
|                                                  1 |             66,667 |
|                                                  2 |             50,000 |

This table is a sweep input, not a measurement. WebKit, Firefox, and an aged copy past the 900 s freshness bound are not measured, so the floor is the cap for Chromium on the demo site and an inference elsewhere.

### Capacity Above The Floor

The ceiling side is a sweep, not a claim. The views a day the free plan's Worker cap carries depends on views a visit, the distinct pages a visit reaches, and the share of visits that run a worker. None is measured on a real site, so each is a sweep input (the demo site has nine pages and the rig's visits reach up to nine). All visits run a worker in the first table, at 3 documents before control (`derived (modelled)`, upper bound):

| distinct pages a visit | 2 views | 5 views | 10 views | 20 views |  50 views | 121 views |
| ---------------------: | ------: | ------: | -------: | -------: | --------: | --------: |
|                      1 | 100,000 | 125,000 |  250,000 |  500,000 | 1,250,000 | 3,025,000 |
|                      3 | 100,000 | 100,000 |  166,667 |  333,333 |   833,333 | 2,016,667 |
|                      9 | 100,000 | 100,000 |  100,000 |  166,667 |   416,667 | 1,008,333 |
|                     20 | 100,000 | 100,000 |  100,000 |  100,000 |   217,391 |   526,087 |
|                     50 | 100,000 | 100,000 |  100,000 |  100,000 |   100,000 |   228,302 |

Every cell is at or above the spool-off cap, and the rows with many distinct pages sit on it. The two named points use the demo site's nine pages: the 121-view session at 1,008,333 views a day and the 2,000-view tab at 16,666,667, a bound. The 121-view figure comes from the model. A deployed session of 101 views (100 clicks) and 20 reloads on the paid account read 12 Worker invocations in total, 1 for the first view and 11 in the click window, and none for the reloads or the repeat visit (n=1), which is the model's 12 at `c = 3`. The deployed 2,000-click tab read 12 Worker invocations in total (n=1, spool on). The spool repository reports 2,420,000 views a day for its 121 views, counting origin requests with the stub on the Worker and the page's static files, which is a bound on Worker requests and a different count. A visit of `D` distinct pages breaks even with no spool at `c + D + 1` views: 5 views for 1 page, 13 for 9 pages, 24 for 20. A population where some visits run no worker moves the figure toward the spool-off cap. At 20-view visits on 9 pages it is 166,667 views a day with every visit on a worker, 142,857 with 75% and 125,000 with half.

The regeneration side follows the requests that still reach the object. A view the device holds reaches no render, so the views a day a free site can carry before rows or duration run out rise as fewer documents arrive, by the ratio of documents to views. The pages a day a site can regenerate do not change, because a render follows a save and a new path and not a view (`inference`: the Drupal and WordPress `free-envelope` classes price a miss per document, and no reading shows how many misses a spool-held view would have caused). `bun scripts/economics/spool.ts` prints both bounds, one holding the miss share per document and one holding renders where they were. On the 121-view session on nine pages the Worker meter binds first on both arms, at 1,008,333 views a day with the miss share held per document and 924,369 with renders held, against 100,000 off. Regeneration is 50,916 pages a day on Drupal and 45,138 on WordPress with spool off or on.

### Costs Per Request

`derived`, from the rates file `scripts/economics/rates.ts` and the medians in `SPOOL_DEVICE`. A Worker request past the paid plan's allowance costs $0.30 a million, 3.00e-7 a request. A cached serve adds 1.8 ms of CPU at $0.02 a million ms and reaches 3.36e-7. A decorated page adds the 5 ms between the paid-account medians of the two arms (6 ms against 1 ms, whole milliseconds, so the figure carries the meter's granularity, and the decorated p90 is 16 ms), which makes 4.36e-7. A render costs 1.50e-6. A view that reaches the object costs the Worker request and one object request, and a miss costs three object requests (`COST_PER_VIEW`). A fill writes 1 row on a real render, 2 reassembling a warm page and 11 on a path new to the object, at the shipping default (`ROWS_PER_FILL_MEMORY_BINS`). Spool does not change what a fill writes. The decoration CPU of a free-plan request against the 10 ms handler cap is not measured: the paid platform cannot show a refusal.

The monthly bill for one site, from `account()` with the documents that reach the Worker and the decoration CPU on each, `derived (modelled)` at 3 documents before control, 9 distinct pages where a page count is needed, and the 5 ms decoration estimate. The figures of $77.69 against $12.23 at 30 million views came from nine page copies added to every device, which the measurements did not show, and they are replaced:

| views a month | spool off | first views only | 2-view visits | 20 views, 20 pages | 20 views, 9 pages | same, 75% on a worker | 121-view session | 2,000-view tab |
| ------------: | --------: | ---------------: | ------------: | -----------------: | ----------------: | --------------------: | ---------------: | -------------: |
|     1,000,000 |      free |             free |          free |               free |              free |                  free |             free |           free |
|    10,000,000 |     $5.15 |            $5.91 |         $5.91 |              $5.91 |             $5.37 |                 $5.50 |             free |           free |
|    30,000,000 |    $12.23 |           $15.23 |        $15.23 |             $15.23 |             $9.70 |                $11.01 |             free |           free |

Two things set the table. A site whose visits reach a new page on every view pays the decoration CPU and saves nothing: $3.00 a month at 30 million views, 150 million milliseconds at $0.02 a million, and that figure uses the 5 ms upper estimate. The later fetch-loop reading (a median of 1 ms on both arms, n=200 each) puts the true difference at under 5 ms, so the $3.00 is a ceiling on the cost and not a reading of it. A site whose visitors return to pages they hold saves requests as the visit lengthens: $9.70 against $12.23 at 30 million views for 20-view visits on 9 pages. Neither figure comes from a real site. The earlier conclusion that no plan's price or allowance should change today holds, for a different reason. The floor is the cap, so spool costs the free plan's request cap nothing, and the gain runs from 0 to 3,025,000 views a day across the sweep, set by views and distinct pages a device reaches that no site has reported. The deciding figure is that range against an input nobody has read off a real site: the 20-view, 9-page point (166,667 views a day, $9.70 against $12.23) is a modelled bound for a demo site, so it justifies no price cut or allowance increase.

**Media and Firefox, `measured`.** A local matrix on `wrangler dev` puts an image, a video clip and an embed on each article and counts Worker-class requests from the server log, because a browser count over-reads media (Chromium range requests answered from its own media cache read as 8 against 4 in the log). Chromium, n=3 per arm, spread 0. At 1, 2, 3, 5, 10, 20 and 100 views spool off costs 4, 5, 6, 8, 13, 23 and 103 requests and spool on costs 3, 5, 5, 6, 9, 13 and 13. Spool on never costs more, and no request to `/.spool/artifact` or any other `/.spool/*` path appeared. The one request only the on arm adds is a second image fetch through the service worker, cause inferred. `SPOOL_IMAGES=0` removes it (n=1 per arm), the clip saving is `SPOOL_VIDEO`, and `SPOOL_EMBEDS` changes page bytes only. The rewrites cost bytes: the on front page is 37,214 B against 27,276 B. Firefox 153 reads the same text counts as Chromium (n=2). With media it costs 11 requests at 1 view and 110 at 100 views with spool off (n=2) and 3 and 12 with spool on (n=1, because the first on run timed out at the 100-view device and was not repeated). The deployed seed now adds setup requests of its own, so these counts do not compare with the deployed rows above.

Spool is on by default on the free plan as well. What would settle it: a free-account run of the decorate path that counts any refusal against the 10 ms handler cap, a views-per-device and distinct-pages-per-device figure read off a real site, and a deployed reading of the 100-view and 2,000-view sessions.

What is still unmeasured, in one place:

- the CPU of a decorated page on a free-plan handler against the 10 ms cap (the paid platform cannot show a refusal);
- WebKit, and any client with no worker (Firefox is measured on the local rig above, with one run for spool on with media);
- copies aged past the 900 s freshness bound, their syncs, and devices returning over days;
- a site with many distinct pages per device;
- the media case on a deployed site (the local matrix above found no `/.spool/artifact` request, the one mechanism that could push a device above spool off, and a deployed run has not been made since the rig's seed changed);
- the deployed timing of a local view at more than one session per arm, on a phone or over a radio, and from more than one location;
- a real site's share of visits that run a worker, its views per device and its distinct pages.

```sh
bun scripts/measure/headers-deployed.ts --arm on=$ON --arm off=$OFF --pages / /user/login /node/1
bun scripts/measure/spool-report.ts results/repeat.jsonl results/cold-all.jsonl
bun scripts/measure/spool-cpu.ts --on=$ON_NAME --off=$OFF_NAME --from=$START --to=$END
bun scripts/economics/spool.ts
```

## How These Figures Are Computed

The render-share, mix, anonymous-only and penalty tables come from `bun scripts/economics/perview.ts`. The logged-in share and plan-hold tables under How The Lead Moves come from `bun scripts/economics/states.ts`. The request, floor, capacity and bill tables under What Spool Adds come from `bun scripts/economics/spool.ts`, which takes the constants of a device from `SPOOL_REQUESTS` in `scripts/economics/measured.ts`, fits them to the measured matrix in the same script, and takes the free plan's ceilings from `scripts/measure/free-envelope.ts`. The yearly device table comes from `bun scripts/economics/device.ts`, which reads the per-navigation joules from `REPEAT_NAV` in the same file. The per-navigation and spool rows are measurements, not script output. The fenced block above lists the spool measurement commands.
</content>
