# Drupflare vs a Traditional VPS

Latency, throughput and cost against nginx with PHP-FPM on the same Drupal tree and database.

Drupflare targets solo, enterprise, indie and budget-bound sites, where the cost is the hours and not
the hosting bill.

Drupflare is faster than a single-region VPS for any visitor who is not sitting next to it, and the
margin grows with distance. Traffic-weighted across the workload mix, against nginx and PHP-FPM 8.5
serving the same Drupal tree and the same database:

| the visitor is               | ratio      |
| ---------------------------- | ---------- |
| in the VPS's own datacenter  | **1.50x**  |
| on the same continent        | **6.35x**  |
| one ocean away               | **11.32x** |
| on the far side of the world | **23.09x** |

Same-datacenter is the VPS at its theoretical best and nobody's real audience. The rest is
[Geography](#geography). Where Drupflare is slower is under [Limitations](limitations.md), and a raw
uncached render is one of them.

Every Drupflare figure marked **M** is measured, on deployed Cloudflare infrastructure or on this
machine, and the column says which. **D** is derived from measured inputs and is arithmetic, not a
reading. **L** is a vendor's published list price. **n/m** is not measured, and is stated as a range
or omitted.

## Against a VPS

`docker/vps.yml` runs nginx 1.29 and PHP 8.5 FPM with opcache and tracing JIT against the same
Drupal tree and the same site database Drupflare serves, so the runtime is the only variable.
`bun run measure:vps` drives both. The generator's own ceiling on the same machine is 8,308 req/s
against nginx and 1,231 against the front worker, so it constrains neither arm.

| workload                     | VPS                  | Drupflare            |
| ---------------------------- | -------------------- | -------------------- |
| Anonymous cached, p50        | 3 ms                 | **2 ms**             |
| Anonymous cached, p95        | 49 ms                | **4 ms**             |
| Anonymous cached, 32 clients | 122 req/s, p50 10 ms | **438 req/s**, 62 ms |
| Re-render, tag-invalidated   | **24 ms**            | 30 ms                |
| Re-render, page cache hit    | 24 ms                | **22 ms**            |

An authenticated session is a curve and not a median: the first three requests render and compile a
plan, and everything after is answered in the isolate with no Durable Object hop. Converged p50 for
one session driven sequentially, n=14 per path:

| authenticated path       | VPS   | Drupflare |
| ------------------------ | ----- | --------- |
| `/`                      | 11 ms | **5 ms**  |
| `/admin/content`         | 71 ms | **5 ms**  |
| `/user/1`                | 56 ms | **5 ms**  |
| `/admin/structure/types` | 18 ms | **6 ms**  |

Under concurrency Drupflare holds about 312 req/s flat from 4 to 32 clients on both authenticated
workloads. The VPS peaks at 204 req/s on the front page and 67 on admin, then declines.

**Both arms are on localhost, which is the VPS's best case.** A VPS sits in one region; Drupflare
answers from the visitor's own colo. The network term a real user pays on every VPS request is
absent from the tables above. [Geography](#geography) measures it, and it is the largest term in the
comparison.

**A re-render is 1.21x on the pages a save invalidates, and Drupflare is faster on the rest.** A
save purges only the cache entries matching its tags, so every other page re-renders from a warm
dynamic page cache. The larger ratios elsewhere in this file are a warm-kernel interpreter
comparison and a both-bins-emptied edge render, which are different workloads on different
instruments and do not divide into each other. The authenticated rows are not a runtime ratio
either: they are a hop that does not happen.

**The authenticated arm is one Durable Object with no replica lanes.** A four-lane pool measured
3.29x on real authenticated renders and none of it is in the numbers above. Bodies agree to within
10 bytes on the anonymous arms; on the authenticated arms Drupflare serves the larger page (103,689
against 96,177 on the front page) and the difference is unexplained.

|                                            | Drupflare                                                                                                                     | Traditional VPS                                                      | prov.   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------- |
| **Setup, from zero to a rendering site**   | one deploy, no server                                                                                                         | provision, webserver, PHP-FPM, MariaDB, TLS, cron, firewall, backups | n/m     |
| **Local toolchain you must learn first**   | none for deploy; `bun` to develop                                                                                             | ddev or Lando, Composer, Drush, ssh, a database client               | n/m     |
| **Monthly infrastructure**                 | itemised in [The Cost Model](#the-cost-model)                                                                                 | the same table                                                       | L       |
| **What "scaling up" means**                | nothing to do; the edge absorbs it                                                                                            | resize the box, tune PHP-FPM workers, add a cache layer              | n/m     |
| **OS patching, PHP upgrades, kernel CVEs** | none exist to patch                                                                                                           | yours, forever                                                       | n/m     |
| **Anonymous page served from**             | edge cache, **~85%** of traffic, **0** Durable Object requests                                                                | your box, every request                                              | M edge  |
| **`page_cache` hit**                       | **1 ms** of Durable Object CPU, 1 statement                                                                                   | full LEMP round trip                                                 | M edge  |
| **`dynamic_page_cache` hit**               | a handful of ms and 6 statements                                                                                              | n/m                                                                  | M edge  |
| **Full uncached render**                   | seconds of Durable Object CPU with both cache bins emptied; the [technical report](../TECHNICAL_REPORT.md) carries the figure | tens of ms native PHP, warm kernel                                   | M edge  |
| **Wasm penalty, warm kernel only**         | a same-machine interpreter ratio, not the edge cost above; the [technical report](../TECHNICAL_REPORT.md) carries it          | 1x by definition                                                     | M local |
| **Authenticated page, plan hit**           | answered in the front worker with no Durable Object hop; see the curve above                                                  | tens of ms on a warm PHP-FPM pool                                    | M edge  |
| **Authenticated read concurrency**         | scales with the [replica pool](replica-lanes.md): **1.00 / 2.03 / 3.29x** at 1 / 2 / 4 lanes, on real renders                 | one box, until you resize it                                         | M edge  |
| **Cold start**                             | over a second; paid absorbs it and free amortises it off the request path                                                     | ~0; the box is already running                                       | M edge  |
| **Free-plan capacity**                     | **~100,000 page views/day** (~3M/month), saturated; every visit costs one Worker request, cached or not                       | whatever the box does before it swaps                                | M edge  |
| **Worker bundle**                          | fits the 64 MiB Worker size limit                                                                                             | n/a                                                                  | M local |
| **First-run migration**                    | chunked, one per invocation on free, each sized to complete on its own                                                        | `drush si`, then hope                                                | M local |
| **When something breaks at 3am**           | a self-repair ladder runs: L0 observe, L1 reset, L2 reconstruct, L3 reconfigure, L4 quarantine, L5 rollback                   | you, or someone you pay                                              | M built |
| **Failure detection**                      | **19 tripwires** (12 host, 7 PHP) plus a mandatory boot self-test                                                             | uptime ping, if configured                                           | M built |

## The Cost Model

The infrastructure saving is small. The labour saving is the large one.

Infrastructure, for one small content site. Vendor figures are list prices and are marked so. For the same comparison across traffic levels, see [Prices at each traffic level](economics.md#prices-at-each-traffic-level).

| line item         | Drupflare free                  | Drupflare paid                 | small VPS                                  | prov. |
| ----------------- | ------------------------------- | ------------------------------ | ------------------------------------------ | ----- |
| Compute           | $0.00                           | $5.00 Workers Paid             | $10-12 for 1-2 vCPU and 2 GiB              | L     |
| Database          | $0.00 (the object's own SQLite) | included                       | on the box, or $15+ managed                | L     |
| Backups           | $0.00                           | included in the plan's storage | $0.50-2.50, snapshots or a plan surcharge  | L     |
| CDN               | included                        | included                       | $0 with Cloudflare in front, which most do | L     |
| TLS               | included                        | included                       | $0 via Let's Encrypt, yours to renew       | L     |
| **Monthly total** | **$0.00**                       | **~$5.00**                     | **~$10.50-14.50**                          |       |
| **Annual**        | **$0**                          | **~$60**                       | **~$126-174**                              |       |

Paid against a VPS is roughly $66-114 a year. The VPS is the smallest box that meets Drupal's
documented memory minimum, priced from provider list prices in [the impact report](impact.md).
The free column has no VPS equivalent: there is no $0 VPS, and free carries about 3.0M visits a
month with the same feature set as paid. Shell assembly is on for both plans, and warming is on by
default only on paid ([Free vs Paid](free-vs-paid.md#what-one-site-gets)). At fleet scale the infrastructure works out near $0.028 per site per month.

The column that cannot be filled in is the difference:

| recurring obligation         | Drupflare                                         | VPS                                        |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------ |
| OS and kernel CVEs           | nothing to patch                                  | monthly, forever                           |
| PHP minor and major upgrades | a binary swap, built in CI                        | yours, with a compatibility risk each time |
| Webserver and PHP-FPM tuning | does not exist                                    | yours                                      |
| Drupal security releases     | detected on the cron chain, reported by `/health` | yours, on the advisory's schedule          |
| Backup verification          | export and restore chunked, resumable, rehearsed  | yours to configure, and to test            |
| Uptime and alerting          | 19 tripwires plus a self-repair ladder            | uptime ping, if configured                 |
| Traffic spike                | nothing to do                                     | resize, tune, add caching                  |

Price those at your own rate; this project states no hourly figure.

## Performance Summary

Full provenance for each figure is in [the report's executive summary](../TECHNICAL_REPORT.md#executive-summary).

|                             | Drupflare                                           | native PHP on a VPS     | prov.   |
| --------------------------- | --------------------------------------------------- | ----------------------- | ------- |
| Cached page (the ~99% case) | **1 ms** DO CPU, 1 statement                        | full LEMP round trip    | M edge  |
| Re-render, tag-invalidated  | **30 ms**                                           | **24 ms**               | M local |
| Re-render, page cache hit   | **22 ms**                                           | 24 ms                   | M local |
| Uncached render, cold bins  | **2,127 ms** DO CPU (n=10); a different cache state | n/m on this instrument  | M edge  |
| Wasm penalty, warm kernel   | **3.57x** warm / 3.94x cold, same-machine ratio     | 1x by definition        | M local |
| Isolate startup             | **5 ms**, not billed to the request                 | n/a; the box is running | M edge  |
| Cold boot                   | **1,264 ms**, amortised off the request path        | ~0                      | M edge  |
| Authenticated page          | **208 ms** p50 from a client, both levers on        | tens of ms, warm pool   | M edge  |

The architecture wins by not rendering. The tiers above answer without a render, and where a
logged-in visitor forces one, shell assembly cuts the render and not the boot.

The two render rows are different workloads on different instruments and must not be divided. The
30/24 pair is one machine and one instrument, with Drupal's `render` and `dynamic_page_cache` bins
warm on both sides, which is the state a content change produces. The 2,127 ms is the edge billing a
render with both bins emptied. Dividing an edge cold figure by a local warm one is how an external
review published a 225x that this project had to retract; the technical report keeps that correction
at its Provenance section.

Authenticated traffic is the harder case. Shell assembly and a resident interpreter put a logged-in
page at about 467 ms against 3,391, and a replica pool spreads authenticated reads across objects
instead of queueing them behind one. A VPS with a warm PHP-FPM pool is still ahead on a single
request. Drupflare answers the concurrency question with lanes: adding one is a config change and a
provisioning call, not a resize ([replica settings](configuration-replicas.md#creating-a-lane)).

Write-heavy traffic is a narrow loss. A lane runs a write locally, discards its own effect and
forwards the statement list to the primary, which sequences it, so the work spreads and only the
commit serialises. The class of write that originates a value two objects would mint differently
cannot spread; those are refused, because a retry cannot repair them.

## Geography

Every table above gives the VPS a visitor standing in its own datacenter. A real visitor is
somewhere else, and a single-region VPS answers all of them from one place while Cloudflare answers
from the colo nearest each. That difference is the largest term in the comparison. It is measured:
`scripts/measure/delay-proxy.mjs` puts a real delaying proxy in front of the VPS arm, so its
connection pays the network instead of having a number added afterwards.

The injected delays are Azure's published P50 round-trip figures between regions. From US-East: West
US 69 ms, West Europe 83 ms, Brazil 117 ms, India 198 ms, Australia 201 ms, Southeast Asia 224 ms.

| injected round trip   | VPS weighted p50 | Drupflare weighted p50 | ratio      |
| --------------------- | ---------------- | ---------------------- | ---------- |
| 0 ms, same datacenter | 14.8 ms          | 9.9 ms                 | **1.50x**  |
| 40 ms, same continent | 56.5 ms          | 8.9 ms                 | **6.35x**  |
| 82 ms, transatlantic  | 100.2 ms         | 8.9 ms                 | **11.32x** |
| 200 ms, antipodal     | 218.0 ms         | 9.4 ms                 | **23.09x** |

Traffic-weighted across the workload mix, three replica lanes, `viable: true` with zero regressions
on all three network arms. Drupflare's figure barely moves, because the term being added is one a
single-region VPS pays and an edge network does not.

Cloudflare Containers accept a placement constraint, so the same comparison runs on real
infrastructure. The VPS arm was pinned first to western Europe and then to eastern North America,
same image and same instance type, driven from a US-East client, n=15 interleaved with the arm order
alternating:

| VPS placement         | VPS floor | Drupflare floor |
| --------------------- | --------- | --------------- |
| Western Europe        | 174.3 ms  | 82.6 ms         |
| Eastern North America | 111.7 ms  | 78.0 ms         |

These are minima and not medians, because the client's own round trip is in both and the floor is
where it shows. Moving the container across the Atlantic costs 62.6 ms on an otherwise identical
arm, and a same-continent VPS still sits about 34 ms above Drupflare, because a region is not the
visitor's own colo. Subtracting the shared client round trip leaves figures that agree with the
proxy table above, so two instruments reach the same answer.

The advantage is zero for a visitor in the VPS's own city and largest for one on the other side of
the world, so a site whose audience sits beside its VPS gains nothing here. There is no single
worldwide number to quote in place of the rows above: internet penetration is published by region,
users per region are not, and averaging without that table would invent a figure. The proxy also
understates the gap, since it delays data and not the TCP handshake, and Drupflare's own arm stays on
localhost.
