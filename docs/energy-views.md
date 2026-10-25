# Energy Per View

The energy of one page view, how often each host has to render one, and what a visitor's own device spends on the same page. The totals this builds on are on [Energy](energy.md). Numbered citations on this page, such as [7], refer to the [references on Impact](impact.md#references).

## Energy Per View

A visitor sees a view, and what a view costs depends on how often it renders. This section prices the mix. Render and cached-serve costs are CPU time priced at the modelled watts per core and PUE, the same basis as the [per-request figures](energy.md#energy-per-request). The results are the marginal energy of serving a view, with no idle power in them, unlike the totals in [Energy Savings](energy.md#energy-savings). Everything here is `derived (modelled)` unless marked, from `bun scripts/economics/perview.ts`.

### How Often Each Host Renders

The share of views that render, `derived (modelled)` from [the render-fraction model](energy.md#the-render-fraction): 100 paths, Zipf 1, five saves a day, five pages invalidated per ordinary save. A cache with a clock renders each path again every time it expires, at every location that holds a copy. drupflare's page store renders when a save invalidates a page and never on a clock. Each cell is a percentage of views a month.

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

Every table above stops at the data centre. A visitor's browser also spends energy on each navigation. drupflare gives its static assets a one-year cache lifetime, so a repeat navigation within that year requests the page and little else. [Configuration](configuration.md) lists the lifetimes. The measured run served the same year on every asset, and its navigations came minutes apart.

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

**Worker CPU, `measured`.** The platform's `cpuTime` for the front worker, in whole milliseconds:

| request class   | n (on) | on: median, p90, max | off: median, p90, max |
| --------------- | -----: | -------------------- | --------------------- |
| page            |    544 | 6, 16, 38 ms         | 1, 4, 23 ms           |
| image file      |    182 | 2, 96, 187 ms        | 1, 3, 9 ms            |
| spool endpoint  |    507 | 0, 0, 22 ms          | none                  |
| spool worker JS |    482 | 0, 4, 10 ms          | none                  |

Decorating a page costs about 5 ms at the median, and the first conversion of an image shows in the tail (a p90 of 96 ms and a 187 ms maximum). A median of 1 ms is the meter's floor and not a reading of 1.0. These ran on a paid account. A free handler caps CPU at 10 ms, and a 16 ms p90 and 38 ms maximum page have not been run there.

**Request economics, `derived (modelled)`.** The share of views a device answers locally and the views a device makes while its worker is installed are nobody's reading for a real site, so the tables sweep both. With `s` the local share, `n` the views a device makes and two fixed requests per new device, the Worker requests a view costs on average, `R`, and the break-even views per device, `n*`, are:

```math
R(s, n) = 1 - s + \frac{2}{n}
```

```math
n^{*} = \frac{2}{s}
```

Below `n*` the device makes too few views for the two requests to pay back, and spool sends the Worker more requests than it would have had. Above it, spool sends fewer. The tables are from `bun scripts/economics/spool.ts`:

| local share | 5 views | 10 views | 20 views | 50 views | break-even |
| ----------: | ------: | -------: | -------: | -------: | ---------: |
|         25% |    1.15 |     0.95 |     0.85 |     0.79 |  8.0 views |
|         50% |    0.90 |     0.70 |     0.60 |     0.54 |  4.0 views |
|         75% |    0.65 |     0.45 |     0.35 |     0.29 |  2.7 views |

The free plan's 100,000 requests a day carry 3,044,000 views a month without spool. At a 50% local share and 20 views a device they carry 5,073,333, and at 25% with 5 views a device they carry fewer, 2,646,957. On the paid plan a site at 30 million views a month pays $12.23 without spool and $10.46, $7.70 or $5.30 at 25%, 50% or 75% local, at 20 views a device. At 10 million views it moves by at most 15 cents, and below that the site is free either way.

The free default stays off. The break-even says spool sends the Worker fewer requests once a device makes a handful of views, but the local share of a real site is unmeasured, the page decoration p90 is above the free handler's 10 ms and nobody has run it there, and a site that gains requests on a short visit loses headroom on the plan that has the least. What would change it: a free-account run of the decorate path with no refusals, and a local share read off a real site.

```sh
bun scripts/measure/headers-deployed.ts --arm on=$ON --arm off=$OFF --pages / /user/login /node/1
bun scripts/measure/spool-report.ts results/repeat.jsonl results/cold-all.jsonl
bun scripts/measure/spool-cpu.ts --on=$ON_NAME --off=$OFF_NAME --from=$START --to=$END
bun scripts/economics/spool.ts
```

## How These Figures Are Computed

The render-share, mix, anonymous-only and penalty tables come from `bun scripts/economics/perview.ts`. The logged-in share and plan-hold tables under How The Lead Moves come from `bun scripts/economics/states.ts`. The request tables under What Spool Adds come from `bun scripts/economics/spool.ts`, which takes its fixed two requests per device from `SPOOL_REQUESTS` in `scripts/economics/measured.ts`. The yearly device table comes from `bun scripts/economics/device.ts`, which reads the per-navigation joules from `REPEAT_NAV` in the same file. The per-navigation and spool rows are measurements, not script output. The fenced block above lists the spool measurement commands.
</content>
