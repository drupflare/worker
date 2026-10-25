# Economics

What a Drupflare site costs to run against the hosting it replaces, at each traffic level. Prices are list prices; the energy behind them is on [Energy](energy.md), and the scope of each claim is on [Impact](impact.md#what-this-does-not-claim). Citations in brackets refer to the [references on Impact](impact.md#references).

The figures are `derived`: Cloudflare's published rates [18], [19] applied to the measured workload, and the list prices of the conventional hosts they are compared with. `bun scripts/economics/comparison.ts --md` generates the tables, so they follow the model behind them.

You deploy to your own Cloudflare account. There is no platform fee in any figure below and no
per-tenant charge. Quotas are account-wide, so several sites share one envelope and do not each pay
their own floor.

The tables down to [Kept Warm](#kept-warm) are for sites that sleep, which is the free plan's default and
`SITE_WARM=0` on any plan. [Kept Warm](#kept-warm) prices the paid plan's default, where every site stays warm.

## The Conventional Hosts

- **Your cost:** Cloudflare's published rates on your own account. `free` means the whole account
  fits inside the free plan.
- **Cheapest VPS:** `derived`. Each priced provider's list price for the smallest box that meets the
  load in What A Conventional Host Needs, plus backups and any transfer overage, taking the lowest.
  It excludes the labour of running the server, which for most people is the largest real cost, and
  it excludes a CDN.
- **Most popular cloud:** Amazon Lightsail, the VPS product of AWS. AWS is the most-used cloud among
  professional developers, at 45.9% in the 2025 Stack Overflow survey [20], and the largest by market
  share, at 28% in Synergy Research's second quarter of 2026 [21]. DigitalOcean, the most-used
  specialist VPS provider in that survey at 11.1%, is shown beside it in the price table.
- **Latency-matched VPS:** `derived (modelled)`. One origin in each of three regions (US East,
  Europe and Asia Pacific), each sized for a third of the traffic on DigitalOcean's plans, behind
  DigitalOcean's global load balancer at $15 a month [22]. It is what serving visitors from nearby
  costs conventionally. It is a floor: the database replica, file replication and cross-region
  transfer that multi-region architectures carry [23], [24] are not priced, and three regions still
  leave most visitors tens of milliseconds from an origin where the edge answers from their own colo.
- **Managed floor:** Pantheon Basic at $500 a year billed annually, or $55 billed monthly [25].
  `published`. The $41.67 a month in the tables is $500 divided by twelve, so it is `derived`. It is
  held flat because overage is not published in a form that can be quoted.
- **Energy:** `derived`, from the energy model on [Energy](energy.md). The servers-not-built figure is modelled: the
  hardware share of the host, rounded down, with no manufacturing or recycling figure attached.

Google Cloud, Oracle Cloud, Kamatera, OVHcloud, Contabo, IONOS, Scaleway and Hetzner are not priced.
Each lacked a complete USD list price for the components below on its own pages, or listed its
cheapest plan as unavailable. Linode's per-plan backup price comes from its API [26].

## What A Conventional Host Needs

A conventional price here is the bill for the hardware the traffic needs, and it moves with traffic.
Peak load is five times the average, and every view is charged to the origin as a render. A render
costs 44.7 ms of CPU, the capacity of one core of a Ryzen 9 9900X running the shipped nginx and
PHP-FPM stack ([What Running It Showed](#what-running-it-showed)). The cores a box needs are the fewest whole cores
that keep the p95 response inside a bound in an M/M/c queue, and never above a utilisation cap, at that peak rate.

Two bounds give two sizings. A viable box keeps the p95 under 60 seconds, the default read timeout
of nginx and Apache [7], [27], [28], so no client or proxy gives up, with utilisation capped at 95%.
Cloudflare's own cutoff is 125 seconds [29]. A matched box keeps the p95 under 0.8 seconds, the
first-byte time web.dev rates good (poor starts at 1.8 seconds) [30], with utilisation capped at 80%.
The caps are modelled, and the 80% matches Linode's guidance to stay below 80% sustained CPU on a
shared plan [31]. A burstable plan has a lower baseline, such as the 10% of a vCPU on a `t3.micro`
[32], but the average load here is a few percent of one core.

Memory sets the floor and does not grow with traffic. The Ubuntu 24.04 cloud image needs 1 GB of RAM
for the operating system alone [33]. The shipped stack's nginx and 8 PHP-FPM children held 169 MB
under the render load, and MariaDB's default InnoDB buffer pool is 128 MiB [34]. Together that is
1.29 GiB a box, so a 1 GiB plan is below the floor and 2 GiB is the smallest size that meets it.
Drupal's own documentation gives 1 GB as the minimum for Composer [35], which is a build requirement
and not a serving one. Disk is about 10 GB in use (the operating system, the 167 MB Drupal tree and
the 5.8 MB database, modelled) against 25 GB on the smallest 2 GiB plans. Transfer is 166 KB a view,
the first load of the demo site (66 requests, 17.2 KB of HTML, n=1), so 3 million views move about
498 GB. Every view is charged as a first load, and no CDN is assumed. What a conventional host needs at each
traffic level, with the cheapest priced provider for each sizing:

| views/site/mo | peak req/s | viable vCPU | matched vCPU | GiB a box | transfer GB | cheapest viable      | cheapest matched     |
| ------------- | ---------- | ----------- | ------------ | --------- | ----------- | -------------------- | -------------------- |
| 10,000        | 0.0        | 1           | 1            | 1.29      | 2           | Vultr vc2-1c-2gb x1  | Vultr vc2-1c-2gb x1  |
| 100,000       | 0.2        | 1           | 1            | 1.29      | 17          | Vultr vc2-1c-2gb x1  | Vultr vc2-1c-2gb x1  |
| 1,000,000     | 1.9        | 1           | 1            | 1.29      | 166         | Vultr vc2-1c-2gb x1  | Vultr vc2-1c-2gb x1  |
| 3,000,000     | 5.7        | 1           | 1            | 1.29      | 498         | Vultr vc2-1c-2gb x1  | Vultr vc2-1c-2gb x1  |
| 10,000,000    | 19.0       | 1           | 2            | 1.29      | 1,660       | Vultr vc2-1c-2gb x1  | Amazon $12 bundle x1 |
| 30,000,000    | 57.0       | 3           | 4            | 1.29      | 4,980       | Amazon $12 bundle x2 | Amazon $12 bundle x2 |
| 100,000,000   | 190.1      | 9           | 11           | 1.29      | 16,600      | Vultr vc2-2c-2gb x5  | Amazon $12 bundle x6 |

Three million views a month is 5.7 requests a second at peak and a quarter of a core, so a single
vCPU serves it with room to spare, and one vCPU carries a matched box up to about 9.4 million views
a month and a viable one to 11.2 million. The two sizings differ from there, and the gap widens with
traffic: 9 vCPU against 11 at 100 million. The floor is the memory a box needs, and the traffic that
follows moves the bill through the vCPU count above 9 million views and through transfer above a
plan's included allowance.

The providers priced, at the smallest box that meets the floor at 100,000 views a month:

| provider                       | plan              | vCPU | GiB | transfer TB | plan   | backups | other | total  |
| ------------------------------ | ----------------- | ---- | --- | ----------- | ------ | ------- | ----- | ------ |
| Vultr [36]                     | vc2-1c-2gb        | 1    | 2   | 2           | $10.00 | $0.50   | $0.00 | $10.50 |
| Amazon Lightsail [37]          | $12 bundle        | 2    | 2   | 3           | $12.00 | $0.50   | $0.00 | $12.50 |
| DigitalOcean [38]              | Basic 2 GiB       | 1    | 2   | 2           | $12.00 | $2.40   | $0.00 | $14.40 |
| Akamai Cloud (Linode) [26]     | g6-standard-1     | 1    | 2   | 2           | $12.00 | $2.50   | $0.00 | $14.50 |
| Microsoft Azure (East US) [39] | Standard_B2pls_v2 | 2    | 4   | none        | $24.53 | $10.22  | $4.40 | $39.15 |

## What Running It Showed

The shipped nginx and PHP-FPM 8.5 stack, with opcache and the tracing JIT, on the same Drupal tree and
SQLite database that drupflare serves, was run in one container image on two hosts and driven by the
same generator from one machine, `measured`, by `scripts/measure/floor-rig.ts`. Every request is a
render: a unique query string that misses nginx, the page cache and the dynamic page cache, checked on
each response. Server time is nginx's own `$request_time`, so it carries no network.

| host                            | CPU a render | renders a second at one core | server time, one client |
| ------------------------------- | -----------: | ---------------------------: | ----------------------: |
| Ryzen 9 9900X, database on disk | 44.1-46.4 ms |                  6.2 to 10.5 |           113 to 116 ms |
| same, database on tmpfs         |      44.8 ms |                         22.4 |                   41 ms |
| Cloudflare Container, 1 vCPU    |     144.9 ms |                          6.6 |                  144 ms |

- **CPU:** a render costs 44.1 to 46.4 ms of a Zen 5 core in all eight disk and tmpfs runs, across 1
  and 2 CPUs, 8 to 32 children and 1 to 4 GiB limits, and the full-core capacity of 22.4 a second is
  44.7 ms. An earlier rig gave 17.9 ms, which did not reproduce here, and the gap is unexplained.
  Cloudflare's container vCPU took 145 ms, so a slower core needs proportionally more of them.
- **Disk:** with the database on disk a render also waits about 70 ms, and throughput stops near 10 a
  second however many cores it has: the 2-CPU run read 8.5. The container used about 0.45 of its core
  at that ceiling. Moving the database to tmpfs took one client from 113 ms to 41 ms and capacity to
  22.4 a second, a full core. SQLite commits synchronously by default and every unique render writes
  cache rows, so this is that rig's commit latency, and MariaDB on a production disk was not
  measured. The cost model uses the CPU figure and no disk wait.
- **Queueing:** on the tmpfs run the p95 was 190 ms at half of capacity and 272 ms at 80%, against
  268 and 671 ms from an M/M/1 queue with that service time. The model's bound held with room, since
  render times vary less than an exponential. Errors appeared at 16 clients and in the 80% cell; the
  cause was not examined.
- **Memory:** nginx plus PHP-FPM held 169 MB with 8 children, 227 MB with 16 and 342 MB with 32 under
  load, anonymous and shared memory from the container's cgroup, about 7.2 MB a child. A 1 GiB limit
  was reached 1,743 and 2,386 times, with 8 and 32 children, and killed nothing: anonymous memory
  stayed under 300 MB and the pressure was page cache. Per-child proportional memory could not be
  read, because the probe ran unprivileged.

The model charges 44.7 ms a render. That moves nothing at or below 3 million views, where a box
is one vCPU, and above 9 million views it roughly doubles the vCPUs a load needs.

## Prices At Each Traffic Level

What hosting the same site costs conventionally, per site:

| views/site/mo | cheapest VPS | DigitalOcean | most popular cloud | latency-matched VPS | managed floor |
| ------------- | ------------ | ------------ | ------------------ | ------------------- | ------------- |
| 1,000         | $10.50       | $14.40       | $12.50             | $58.20              | $41.67        |
| 10,000        | $10.50       | $14.40       | $12.50             | $58.20              | $41.67        |
| 100,000       | $10.50       | $14.40       | $12.50             | $58.20              | $41.67        |
| 1,000,000     | $10.50       | $14.40       | $12.50             | $58.20              | $41.67        |
| 10,000,000    | $12.50       | $21.60       | $12.50             | $58.20              | $41.67        |

Amazon Lightsail publishes no transfer overage price for instances, so a plan whose transfer is
exceeded is not priced. At the CPU cost measured here the vCPUs a load needs bring enough included
transfer in every row, so none is dropped.

Above 9 million views the hardware grows with the traffic, and so does the bill. The same prices at
higher traffic, with drupflare's per-site bill at 1,000 sites:

| views/site/mo | cheapest VPS | DigitalOcean | latency-matched VPS | managed floor | drupflare |
| ------------- | ------------ | ------------ | ------------------- | ------------- | --------- |
| 30,000,000    | $25.00       | $43.20       | $79.80              | $41.67        | $10.92    |
| 100,000,000   | $75.00       | $129.60      | $144.60             | $41.67        | $36.39    |
| 1,000,000,000 | $877.00      | $1,206.40    | $1,221.40           | $41.67        | $363.86   |

## The Free Plan

The free plan covers 3.04 million views a month across the whole account, split however you like:
one site at 3.04 million views, a hundred sites at 30,439 each, a thousand at 3,043 each. Past that
the Workers Paid plan is $5 a month, including 10 million requests, 50 million rows written and 5 GB
of storage.

Worker requests, one per view, are the meter that runs out first. Every view reaches the Worker,
cached or not, so no change to rendering moves this ceiling. Only a response that never runs the
Worker avoids it: a static asset, or a hostname not routed to the Worker. At the shipping default a
fill writes 1.75 rows, and the re-render ceiling is 50,916 a day, set by rows written. Renders follow
saves rather than views: at five saves a day a site re-renders about 25 pages, so a thousand active
sites use under half of that ceiling. For a large idle fleet the binding meter changes to storage, at
4.7 MB per site, and uploaded files are stored in each site's database against the same 5 GB.

What you pay, on your own account:

| views/site/mo | 1 site | 10 sites | 100 sites | 1,000 sites |
| ------------- | ------ | -------- | --------- | ----------- |
| 1,000         | free   | free     | free      | free        |
| 10,000        | free   | free     | free      | $5.80       |
| 100,000       | free   | free     | $5.15     | $38.44      |
| 1,000,000     | free   | $5.15    | $37.64    | $365.14     |
| 10,000,000    | $5.15  | $37.56   | $364.34   | $3,644.64   |

The first free cap you reach, and how much of it is used:

| views/site/mo | 1 site       | 10 sites     | 100 sites    | 1,000 sites |
| ------------- | ------------ | ------------ | ------------ | ----------- |
| 1,000         | storage 0%   | storage 1%   | storage 9%   | storage 95% |
| 10,000        | requests 0%  | requests 3%  | requests 33% | requests    |
| 100,000       | requests 3%  | requests 33% | requests     | requests    |
| 1,000,000     | requests 33% | requests     | requests     | requests    |
| 10,000,000    | requests     | requests     | requests     | requests    |

Against each host, one site, as the ratio of the host's bill to drupflare's:

| views/site/mo | cheapest VPS | most popular cloud | latency-matched VPS | managed floor |
| ------------- | ------------ | ------------------ | ------------------- | ------------- |
| 1,000         | free         | free               | free                | free          |
| 10,000        | free         | free               | free                | free          |
| 100,000       | free         | free               | free                | free          |
| 1,000,000     | free         | free               | free                | free          |
| 10,000,000    | 2.4x cheaper | 2.4x cheaper       | 11.3x cheaper       | 8.1x cheaper  |

Against each host, a thousand sites:

| views/site/mo | cheapest VPS    | most popular cloud | latency-matched VPS | managed floor   |
| ------------- | --------------- | ------------------ | ------------------- | --------------- |
| 1,000         | free            | free               | free                | free            |
| 10,000        | 1810.9x cheaper | 2155.9x cheaper    | 10037.7x cheaper    | 7186.2x cheaper |
| 100,000       | 273.2x cheaper  | 325.2x cheaper     | 1514.1x cheaper     | 1084.0x cheaper |
| 1,000,000     | 28.8x cheaper   | 34.2x cheaper      | 159.4x cheaper      | 114.1x cheaper  |
| 10,000,000    | 3.4x cheaper    | 3.4x cheaper       | 16.0x cheaper       | 11.4x cheaper   |

## Kept Warm

A paid plan keeps every site resident by default: the alarm re-arms every 8 s, the object never
hibernates, and an editor's first request after idle answers in 156 to 371 ms rather than 2 to 4 s.
The free plan leaves a site to the thermal policy, which declines any site below about 505 renders a
day, and any plan can set `SITE_WARM=0`. One site's chain sits inside the paid allowances. A fleet's
does not, because the allowances are account-wide: each warm site writes 10,896 rows and makes 10,800
object requests a day, and a thousand of them write 331 million rows a month against 50 million
included. The chain is billed for its wall time, 23.3 ms a firing (n=116). `derived`, from the rate
card and that firing, with a recomputation from the rate card alone pinned in
`tests/node/economics-energy.spec.ts`:

What you pay with every site kept warm:

| views/site/mo | 1 site | 10 sites | 100 sites | 1,000 sites |
| ------------- | ------ | -------- | --------- | ----------- |
| 1,000         | free   | $5.45    | $9.80     | $350.03     |
| 10,000        | free   | $5.45    | $9.95     | $350.65     |
| 100,000       | free   | $5.45    | $10.10    | $383.29     |
| 1,000,000     | free   | $5.75    | $42.59    | $709.99     |
| 10,000,000    | $5.30  | $38.16   | $369.29   | $3,989.49   |

Kept warm, against each host, one site:

| views/site/mo | cheapest VPS | most popular cloud | latency-matched VPS | managed floor |
| ------------- | ------------ | ------------------ | ------------------- | ------------- |
| 1,000         | free         | free               | free                | free          |
| 10,000        | free         | free               | free                | free          |
| 100,000       | free         | free               | free                | free          |
| 1,000,000     | free         | free               | free                | free          |
| 10,000,000    | 2.4x cheaper | 2.4x cheaper       | 11.0x cheaper       | 7.9x cheaper  |

Kept warm, against each host, a thousand sites:

| views/site/mo | cheapest VPS  | most popular cloud | latency-matched VPS | managed floor  |
| ------------- | ------------- | ------------------ | ------------------- | -------------- |
| 1,000         | 30.0x cheaper | 35.7x cheaper      | 166.3x cheaper      | 119.0x cheaper |
| 10,000        | 29.9x cheaper | 35.6x cheaper      | 166.0x cheaper      | 118.8x cheaper |
| 100,000       | 27.4x cheaper | 32.6x cheaper      | 151.8x cheaper      | 108.7x cheaper |
| 1,000,000     | 14.8x cheaper | 17.6x cheaper      | 82.0x cheaper       | 58.7x cheaper  |
| 10,000,000    | 3.1x cheaper  | 3.1x cheaper       | 14.6x cheaper       | 10.4x cheaper  |

A fleet pays for keeping its sites warm, about 35 cents a site a month at 1,000 sites. At 10,000 views
a site that leaves a thousand sites 30 times cheaper than the cheapest VPS, 166 times cheaper than a
latency-matched origin and 119 times cheaper than the managed floor. The sleeping tables reach 1,810
times at the cheapest VPS and 10,037 times at the latency-matched one. Those are ceilings, reached by
a fleet of mostly idle sites left to sleep.

## What The Price Column Does Not Buy

A monthly price buys capacity from one place, and this page does not measure capacity beyond the
sizing above. It does not buy the latency profile: the same workload measures 100.2 ms on a VPS
against 8.9 ms on drupflare once an 82 ms round trip is injected, because one serves from a region
and the other from the visitor's colo. It does not buy the tail either, where the VPS p50 runs from
59 ms at 4 clients to 182 ms at 96 while drupflare holds. The latency-matched column prices the first
of those; nothing here prices the second.

## The Shape Of The Bills

The two bills differ in shape more than in total. A conventional host charges per site per month
whether or not anyone visits, and for hardware that grows with traffic; drupflare charges for traffic
served, against an allowance that costs nothing until it is crossed. The comparison therefore widens
with the number of idle sites and narrows with traffic.

On a paid account the monthly bill is a fixed base plus one charge for each meter's usage above its
included allowance, as `scripts/economics/bill.ts` computes it. B is the base subscription, m runs over
the meters (requests, CPU milliseconds, rows written, storage, Durable Object requests and Durable Object
duration), u_m is that meter's usage for the month, I_m is its included allowance, c_m is its rate and
U_m is the unit the rate is quoted in:

```math
\text{bill} = B + \sum_{m} c_m \cdot \frac{\mathrm{max}(0, u_m - I_m)}{U_m}
```

The two Durable Object meters round their excess up to the next whole unit before the rate applies. Usage
includes a kept-warm site's own rows and object requests, which the chain spends before any visitor arrives.
A month in which every free-plan daily cap stays within its limit costs nothing, and the formula does not
apply to it.

For a single site at ten million views a
month drupflare costs $5.15, the $5 subscription plus $0.15 of usage, against $10.50 for the
cheapest VPS, and the latency-matched host is 11.3 times dearer.

## Where The Curves Meet

The bill grows with traffic and the conventional host's grows in whole boxes and in transfer, so the
lines can cross. Solved on the real functions with `comparison.ts --crossover`, per site, up to a
trillion views a site a month. The break-even is the first traffic at which drupflare's per-site bill reaches
the host's price. With s sites, C(s, v) is the account bill from [The Shape Of The Bills](#the-shape-of-the-bills), and P(v) is the
host's monthly price per site at v views a site a month:

```math
v^{*} = \min\{ v \geq 10^{4} : \frac{C(s, v)}{s} \geq P(v) \}
```

The search starts at 10,000 views and multiplies v by 1.01 each step, up to 10^12. P(v) is a step
function, because the VPS is priced in whole boxes sized to its render load, so the search also records
the last point above which drupflare stays behind. `never` means no step reached the host's price.

| against             | 1 site | 1,000 sites |
| ------------------- | ------ | ----------- |
| cheapest VPS        | never  | never       |
| latency-matched VPS | never  | never       |

drupflare is the cheaper bill at every traffic level against both. At 1,000 sites and 100 million
views per site the cheapest VPS costs $75.00 a site against drupflare's $36.39, and at a billion
views $877.00 against $363.86.

The managed floor would cross near 112 million views for one site and 115 million for a thousand,
but only because it is held flat at the entry plan's price. No managed plan serves that traffic at
$41.67, so the crossing comes from the flat price.
