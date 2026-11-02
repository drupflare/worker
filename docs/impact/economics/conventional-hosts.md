# Conventional Hosts

What conventional hosts cost, what a conventional host needs, and what running Drupflare showed.

## The Conventional Hosts

- **Your cost:** Cloudflare's published rates on your own account. `free` means the whole account
  fits inside the free plan.
- **Cheapest VPS:** `derived`. Each priced provider's list price for the smallest box that meets the
  load in What A Conventional Host Needs, plus backups and any transfer overage, taking the lowest.
  It excludes the labour of running the server, which for most people is the largest real cost, and
  it excludes a CDN.
- **Most popular cloud:** Amazon Lightsail, the VPS product of AWS. AWS is the most-used cloud among
  professional developers, at 45.9% in the 2025 Stack Overflow survey [[20]](../references.md), and the largest by market
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
- **Energy:** `derived`, from the energy model on [Energy](../energy/index.md). The servers-not-built figure is modelled: the
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
