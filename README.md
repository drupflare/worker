# 🐘 Drupflare — Drupal on Cloudflare Workers

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/drupflare/worker)
[![Build](https://github.com/drupflare/worker/actions/workflows/build.yml/badge.svg)](https://github.com/drupflare/worker/actions/workflows/build.yml)
[![Prettier](https://github.com/drupflare/worker/actions/workflows/prettier.yml/badge.svg)](https://github.com/drupflare/worker/actions/workflows/prettier.yml)
[![codecov](https://codecov.io/gh/drupflare/worker/branch/master/graph/badge.svg)](https://codecov.io/gh/drupflare/worker)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Drupal 11 running on Cloudflare Workers.** No VPS, no container, no origin server — PHP
8.5 executes as WebAssembly inside a Durable Object, with the Durable Object's own SQLite as
the database. **8.5 is what ships**, with every extension intact, at **2,658,002** zstd bytes
against the 3,145,728 free-plan ceiling.

> [!NOTE]
> **Not released yet.** The deploy button needs a published release payload to pull from. `assets/`
> is ~97 MB of generated packs and is gitignored, so a clean checkout builds nothing: `bun run build`
> hydrates that payload instead, which is a plain HTTPS GET of a release asset and needs no Docker,
> no token and no PHP. Every figure below is measured, and each one says where it came from.

> [!NOTE]
> **The bundle fits with 247,409 bytes to spare.** The interpreter ships as a zstd frame inflated
> at module scope, so Cloudflare's own gzip meter reads **2,898,319 bytes** against the free plan's
> 3 MiB ceiling, with nothing removed to get there. Run `bun run release:check` rather than quoting
> that figure — it has been stale in three documents at once. Boot is not the constraint either: cold boot is
> **1,398 ms** of absolute `cpuTime` on a deployed worker, but boot-directed work is saturated —
> cutting boot cost per fill by 20x moves the regeneration ceiling **1.1%**. Rows written is what
> binds. See [Free vs Paid](#-free-vs-paid).

---

## ⚖️ Drupflare vs a Traditional VPS

The point of this project is to make Drupal viable for **solo, indie and budget-bound sites** — the
ones where the hosting bill is not the problem, the _hours_ are.

**Read the provenance column.** Every Drupflare figure marked **M** is measured on deployed
Cloudflare infrastructure or on this machine, and says which. Alternatives are **L** (a vendor's
published list price) or **—** (not measured; stated as a range or omitted rather than invented).
Nothing in this table is a benchmark of someone else's host.

|                                            | Drupflare                                                                                                                                         | Traditional VPS                                                      | prov.   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------- |
| **Setup, from zero to a rendering site**   | one deploy, no server (**not live yet** — see the note at the top)                                                                                | provision, webserver, PHP-FPM, MariaDB, TLS, cron, firewall, backups | —       |
| **Local toolchain you must learn first**   | none for deploy; `bun` to develop                                                                                                                 | ddev or Lando, Composer, Drush, ssh, a database client               | —       |
| **Monthly infrastructure**                 | itemised in [The Cost Model, Exactly](#the-cost-model-exactly)                                                                                    | the same table                                                       | L       |
| **What "scaling up" means**                | nothing to do — the edge absorbs it                                                                                                               | resize the box, tune PHP-FPM workers, add a cache layer              | —       |
| **OS patching, PHP upgrades, kernel CVEs** | none exist to patch                                                                                                                               | yours, forever                                                       | —       |
| **Anonymous page served from**             | edge cache, **~85%** of traffic, **0** Durable Object requests                                                                                    | your box, every request                                              | M edge  |
| **`page_cache` hit**                       | **1 ms** of Durable Object CPU, 1 statement                                                                                                       | full LEMP round trip                                                 | M edge  |
| **`dynamic_page_cache` hit**               | **26 ms**, 6 statements                                                                                                                           | —                                                                    | M edge  |
| **Full uncached render**                   | **34 ms**, both bins emptied, 13 statements                                                                                                       | **9.47 ms** native PHP, warm kernel                                  | M both  |
| **Wasm penalty**                           | **3.57x** warm / **3.94x** cold vs native PHP                                                                                                     | 1x by definition                                                     | M local |
| **Cold start**                             | **1,398 ms** measured (n=3, and the platform is bimodal by 400-600 ms) — paid absorbs it, free amortises it off the request path                  | ~0; the box is already running                                       | M edge  |
| **Free-plan capacity**                     | **~100,000 page views/day** (~3M/month), saturated; every visit costs one Worker request, cached or not                                           | whatever the box does before it swaps                                | M edge  |
| **Worker bundle**                          | **2,898,319 bytes** gzipped, **247,409 under** the 3 MiB free ceiling                                                                             | n/a                                                                  | M local |
| **First-run migration**                    | 79 chunks, **max 3 ms** per invocation, **0** over the 10 ms cap                                                                                  | `drush si`, then hope                                                | M edge  |
| **When something breaks at 3am**           | a self-repair ladder runs: L0 observe → L1 reset → L2 reconstruct → L3 reconfigure → L4 quarantine → L5 rollback, with a decaying circuit breaker | you, or someone you pay                                              | M built |
| **Failure detection**                      | **19 tripwires** (12 JS, 7 PHP) plus a mandatory boot self-test                                                                                   | uptime ping, if configured                                           | M built |

### The Cost Model, Exactly

**The infrastructure saving is small. The labour saving is the product.** Anyone pitching this on
hosting price is pitching the wrong thing.

Infrastructure, for one small content site. Vendor figures are **list prices**, not measurements, and
are marked so:

| line item         | Drupflare free                  | Drupflare paid                 | small VPS                                  | prov. |
| ----------------- | ------------------------------- | ------------------------------ | ------------------------------------------ | ----- |
| Compute           | $0.00                           | $5.00 Workers Paid             | $5-12                                      | L     |
| Database          | $0.00 (the object's own SQLite) | included                       | on the box, or $15+ managed                | L     |
| Backups           | $0.00                           | included in the plan's storage | ~20% surcharge on the majors               | L     |
| CDN               | included                        | included                       | $0 with Cloudflare in front, which most do | L     |
| TLS               | included                        | included                       | $0 via Let's Encrypt, yours to renew       | L     |
| **Monthly total** | **$0.00**                       | **~$5.00**                     | **~$6-14**                                 |       |
| **Annual**        | **$0**                          | **~$60**                       | **~$72-168**                               |       |

So paid-vs-VPS is **roughly $12-108/year**, and at the bottom of the market it is close to a wash. The
row that has no VPS equivalent is the first one: **there is no $0 VPS, and free carries ~3.0M
visits/month with the same feature set as paid.**

What actually differs is the column that cannot be filled in:

| recurring obligation         | Drupflare                                             | VPS                                        |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| OS and kernel CVEs           | nothing to patch                                      | monthly, forever                           |
| PHP minor and major upgrades | a binary swap, built in CI                            | yours, with a compatibility risk each time |
| Webserver and PHP-FPM tuning | does not exist                                        | yours                                      |
| Drupal security releases     | rollout planning built; **advisory detection is not** | yours, on the advisory's schedule          |
| Backup verification          | export and restore chunked, resumable, rehearsed      | yours to configure, and to test            |
| Uptime and alerting          | 19 tripwires plus a self-repair ladder                | uptime ping, if configured                 |
| Traffic spike                | nothing to do                                         | resize, tune, add caching                  |

**Price those at your own rate.** This project will not invent an hourly figure for you, and two of
those rows say "not finished yet".

Performance, with the full provenance in
[the report's executive summary](TECHNICAL_REPORT.md#-executive-summary):

|                             | Drupflare                                                 | native PHP on a VPS     | prov.   |
| --------------------------- | --------------------------------------------------------- | ----------------------- | ------- |
| Cached page (the ~99% case) | **1 ms** DO CPU, 1 statement                              | full LEMP round trip    | M edge  |
| Uncached render             | **34 ms**                                                 | **9.47 ms**             | M both  |
| Wasm penalty                | **3.57x** warm / 3.94x cold                               | 1x by definition        | M local |
| Isolate startup             | **112 ms** of a 1,000 ms limit, not billed to the request | n/a; the box is running | M edge  |
| Cold boot                   | **1,398 ms**, amortised off the request path              | ~0                      | M edge  |

An uncached render is ~3.6x slower, and the architecture wins by not rendering rather than by rendering
faster. If your traffic is mostly authenticated or write-heavy, that trade goes the wrong way and a VPS
is the better tool — see below.

### Where a VPS Still Wins

- **Authenticated and write-heavy traffic.** One site is one Durable Object is one thread, and you
  cannot buy a bigger one. Content sites win decisively; a busy editorial workflow does not.
- **Cold start.** 1,398 ms of CPU, which no single free invocation can hold, so it is amortised off
  the request path rather than eliminated.
- **Arbitrary contrib modules.** Anything wanting `exec`, image libraries or sockets needs a shim or
  is refused by name. That is an engineering backlog, not a solved problem. **Uploads are no longer
  on this list** -- `public://` and `private://` are backed by the Durable Object's own SQL, so a
  file written through Drupal's file API survives an eviction. Before that they did not: the file
  system was MEMFS, so an upload lived as long as its isolate while the `file_managed` row
  describing it survived, and the site accumulated entities pointing at nothing.
- **A raw uncached render is ~3.6x slower** than native PHP. The architecture wins by not rendering,
  not by rendering faster.

### What the self-repair layer replaces

It is not a monitoring dashboard; it acts. A capped, GC'd health ledger; 12 JavaScript tripwires
(empty render, size anomaly, asyncify called, mask leaked, semaphore dirty, incomplete migration,
halted updb, pack generation mismatch, memory highwater rising, memory trend rising, ledger
oversized, image cap projected) plus budget pressure and its forward projection; 7 PHP tripwires (anonymous cache purity,
missing cache header, leaked transaction, account not restored, over-100 params, over-50-byte LIKE,
config drift); a mandatory boot self-test; and a repair ladder whose breaker escalates on repeated
failure and decays on a clean interval.

The tripwires run **on the alarm and never on the request path**. Recording a finding is a row
write, and rows written is the meter that binds regeneration, so a per-request pass would spend the
budget it exists to watch. A healthy site writes zero rows here: the repair state is persisted only
when it changes.

`RepairLadder::maySafelyRepair()` **fails closed** — it refuses to act while a transaction is open,
because a repair that runs mid-transaction is worse than the fault it was fixing.

**L4 quarantine and L5 rollback are live.** Three consecutive findings of the same code at `error`
or above quarantine the site; a different code resets the count, because two unrelated faults are
not one durable condition. A quarantined site **stops writing and stops filling, and keeps
serving** — the failure that matters for a free host is not "the site is wrong" but "the site is
gone", so a visitor sees a stale page rather than an error. Rollback additionally requires ten
consecutive failures and a restore point that exists; with none it refuses by name, because
reverting to nothing is worse than the fault. Leaving quarantine is an explicit operator act at
`/health?clear=1`, never automatic.

---

## 🆓 Free vs Paid

**The product goal: free and paid are the same host.** Paid buys performance and headroom. It does not
buy features, and free is not a demo -- both are viable Drupal hosts, or the project has failed.

Free's limits are **aggregate daily budgets**, not the 10 ms per-invocation CPU cap. The cap
constrains one execution unit; the architecture chooses what an execution unit is. Score any change
with `bun scripts/measure/free-envelope.ts`, never against a millisecond figure.

### The Two Ceilings

| ceiling          | what it limits                     | bound by                  | free today                         |
| ---------------- | ---------------------------------- | ------------------------- | ---------------------------------- |
| **Serving**      | visits/month that can be answered  | Worker requests, 100k/day | **3.0M/month**, saturated at 1.00x |
| **Regeneration** | distinct pages re-rendered per day | **rows written**          | **7,575/day**                      |

Serving has a way out. Pages served from an **R2 public bucket on a custom domain** are answered
through the CDN without invoking the Worker. But "requests to static assets are free and unlimited"
describes **Workers Static Assets**, which are uploaded at deploy time and cannot hold a page rendered
at runtime; R2 is metered at **10M Class B operations/month**. So the floor is **3.0M -> ~10M
visits/month, about 3.3x**, plus whatever the CDN absorbs in front of the bucket -- a hit ratio nobody
has measured. Regeneration then becomes the binding limit, and it decides whether free is a _Drupal_
host rather than a cache.

> [!IMPORTANT]
> **The off-Worker serving path is designed, not delivered.** The R2 mirror queue drains from the
> alarm now, but it mirrors **files**; the serving ceiling is set by **pages**, and no page is yet
> served without invoking the Worker. Both page tiers -- the edge cache and the optional KV tier --
> still cost one Worker request each, because the Worker has to run to consult them. So the ceiling
> shipping today is the 3.0M row above, saturated, and the measured floor once pages do move
> off-Worker is **3.33x**: 10M R2 Class B operations/month against 100,000 Worker requests/day.
>
> **There is no single rows-per-fill figure.** A fill costs **3 to 62 rows** depending on what is
> already warm, so the model names four measured warmth classes rather than averaging them;
> `ROWS_PER_FILL` in `scripts/measure/free-envelope.ts` carries all four, and `warmthMix` prices a
> realistic spread. Every figure is counted at the storage handle, so it includes the host's own
> writes -- notably the `cfw_page` insert that stores the whole rendered page.

### Where the Work Pays

| lever                                                  |      worth | note                                                                            |
| ------------------------------------------------------ | ---------: | ------------------------------------------------------------------------------- |
| Serve cached pages off-Worker (R2 custom domain)       |      ≥3.3x | serving only; the floor is R2's 10M Class B ops/month, the CDN carries the rest |
| **Null the `page` bin** (8 -> 3 rows, warm fill)       |  **2.67x** | **done.** It duplicated bytes the host already stores in `cfw_page`             |
| Cut the remaining rows per fill (13 -> 4)              |      3.25x | audit the fill's own bookkeeping; `cfw_page` is now most of what is left        |
| **Anything boot-directed** (JSPI, heap restore, `-O3`) | **~1.01x** | **saturated for this ceiling.** A 20x cut in boot cost per fill buys 1.1%       |
| More slicing / decomposition                           |   negative | alarms are counted DO requests; a 6-way split measured 5,555 -> 4,166 fills/day |

Two levers that look plausible are not levers. Uninstalling `dblog` does not reduce rows per fill:
measured, **zero** rows of a fill go to `watchdog`. And past ~85% off-Worker serving the binding meter
becomes **DO requests**, not rows, so trimming rows per fill beyond that point moves the rows meter and
does not move the ceiling at all -- a lever the binding meter does not respond to is not a lever.

### A third meter nothing else models

Cloudflare Images allows **5,000 unique transformations per month** on free, and it fails as a **hard
cap rather than a bill**. Every image style is a transformation, so ten styles over 2,000 images is
20,000 -- 4x over. It is the only quota here measured per month rather than per day, so it does not
clear at midnight.

It is **projected rather than counted**, because it is a function of the site's content and
configuration and both are known in advance. The object multiplies its image styles by its managed
images on every alarm and records `budget.image_transforms` in the health ledger at 80% of the
allowance. A warning, never a repair: the remedies are dropping a style or cutting the image count,
and both are decisions a human makes. `/health` shows it, and `/admin` shows the full projection with
the largest style count that still fits.

> [!CAUTION]
> Do **not** enable the Workers Caching feature on free. It bills every request at the standard rate
> _"including requests that are normally free: static asset requests"_ — converting the one free serving
> path into a billed one. Its name sounds exactly like what a cache-first architecture wants, which is
> what makes it dangerous.

---

## 📋 Table of Contents

- [Drupflare vs a Traditional VPS](#-drupflare-vs-a-traditional-vps)
- [Free vs Paid](#-free-vs-paid)
- [Why](#-why)
- [How It Works](#-how-it-works)
- [What It Costs](#-what-it-costs)
- [Getting Started](#-getting-started)
- [Building From a Clean Clone](#-building-from-a-clean-clone)
- [Project Structure](#-project-structure)
- [Testing](#-testing)
- [Contributing](#-contributing)
- [Repositories](#-repositories)
- [Contrib Modules](#-contrib-modules)
- [Limitations](#-limitations)
- [Technical Report](#-technical-report)

---

## 🎯 Why

A small Drupal site is a strange thing to host. It needs a webserver, a PHP runtime, a
database, a cache, a CDN, backups, and someone to apply security patches — and it serves
almost entirely anonymous, cacheable traffic. The infrastructure is sized for the 1% of
requests that render.

Drupflare inverts that. The 99% is served from Cloudflare's edge cache, the next slice from
a Durable Object's SQLite, and only a genuine miss reaches PHP at all. There is nothing to
patch at the OS level, nothing to keep running, and no origin to go down.

**The comparison is not $5 against a $6 VPS.** It is $5 against a VPS _plus_ CDN, backups,
monitoring, and patching labour — and the labour is the part that does not scale down.

---

## ⚙ How It Works

```txt
request
  │
  ├─ 1. edge cache (caches.default)        ~85% of traffic, 0 Durable Object requests
  │
  ├─ 2. Durable Object page cache (SQL)    ~14%, stored HTML, no PHP
  │
  └─ 3. PHP renders inside the Durable Object   ~1%, then fills the caches above
```

Four things make it work, and each was the hard part in turn:

1. **A purpose-built PHP wasm binary.** No published php-wasm build can do this. workerd
   forbids the runtime wasm codegen that emscripten's dynamic linker needs, so every
   extension Drupal requires is statically linked (`MAIN_MODULE=0`). See [`build/`](build/).
2. **PHP runs _inside_ the Durable Object, not beside it.** `ctx.storage.sql` is synchronous
   only from within the object, and PHP's database calls are blocking. Any other arrangement
   cannot connect the two.
3. **A real Drupal database driver.** [`drupal/cfw_do_sqlite/`](drupal/cfw_do_sqlite/) is a
   Drupal 11 driver for Durable Object SQLite. Drupal's query builders, schema handling and
   condition compiler are used unchanged; what is replaced is everything that assumed PDO and
   a file on disk.
4. **Divisibility, not speed.** The free plan caps CPU _per invocation_. So work that does
   not fit is split rather than optimised — and what language a step runs in decides whether
   it can be split at all. First-run migration moved from PHP to JavaScript and went from
   **3,467 ms in one invocation to a 3 ms worst case across 99**.

---

## 💰 What It Costs

Measured on deployed infrastructure, per-invocation `cpuTime` read through the Workers
Observability API.

| meter                        | free-plan ceiling | binds at                                     |
| ---------------------------- | ----------------- | -------------------------------------------- |
| **Worker requests**          | 100,000/day       | **~100,000 page views/day** ← the real limit |
| Durable Object requests      | 100,000/day       | ~588,000 PV/day                              |
| Rows written                 | 100,000/day       | ~555,000 PV/day                              |
| Duration, rows read, storage | —                 | not close                                    |

**Free tier is ~100,000 page views/day (~3M/month) for a well-cached site**, saturated at 1.00x,
and every meter except Worker requests has roughly 5x headroom.

| artifact               | size                                                                              |
| ---------------------- | --------------------------------------------------------------------------------- |
| Worker bundle, gzipped | **2,881,546 bytes** — **264,182 under** the 3 MiB free ceiling                    |
| PHP 8.5, nothing cut   | **2,658,002 bytes** zstd — **487,726 under** the same ceiling; this is what ships |
| First-run migration    | **62** chunks, **max 3 ms** of edge CPU, 0 over the 10 ms cap                     |
| Cold boot              | **1,398 ms** measured; amortised off the request path rather than eliminated      |

---

## 🚀 Getting Started

### Prerequisites

- [Bun](https://bun.sh/)
- **Node 24+** as well — a few scripts need `node:sqlite`, which Bun does not ship
- PHP 8.3+ with `pdo_sqlite` (only to run the database driver's test suite)
- A Cloudflare account with Durable Objects enabled (available on the free plan)

### Install and run

```bash
git clone https://github.com/drupflare/worker.git
cd worker
bun install
bun run hydrate
bun run dev
```

`assets/` and `.interp/` are generated and gitignored, so a clean clone has nothing to deploy until
`bun run hydrate` lands them. See [Building From a Clean Clone](#-building-from-a-clean-clone).

Then open it:

```bash
open http://localhost:8787/
```

The first visit to a site that has no database yet answers a self-refreshing setup page and starts
the migration on the alarm chain; the page becomes the site as soon as the replay finishes. To do it
in one shot instead, which is faster locally:

```bash
curl "localhost:8787/migrate?all=1"
```

**Drupal owns the URL space.** Any path the Worker does not claim is served as a page, so `/`,
`/user/login` and `/node/1` all work; `/serve?site=X&path=Y` still does the same thing explicitly.
Which site a request resolves to is decided in [`src/ops/site-id.ts`](src/ops/site-id.ts): a KV
mapping for the host, then the `SITE_ID` var, then the hostname itself, then `site`. On `localhost`
the hostname names no site, so it lands on `site`. A `?site=` on a path the visitor typed is ignored;
it names the site only on `/serve`, where the caller wrote the URL.

On the free plan, drop `&all=1` — migration then replays one chunk per invocation and drives
itself to completion over ~99 alarm firings, keeping every invocation under
10 ms of CPU.

### Scripts

| command                      | what it does                                                |
| ---------------------------- | ----------------------------------------------------------- |
| `bun run dev`                | local worker with a real Durable Object                     |
| `bun run deploy`             | deploy to Cloudflare                                        |
| `bun run test`               | vitest: both projects, **workers inside workerd**           |
| `bun run test:coverage`      | the same, with merged coverage                              |
| `bun run test:node`          | only the node project (needs `node:sqlite`, a real PHP)     |
| `bun run test:php`           | the Drupal database driver suite, under real PHP            |
| `bun run typecheck`          | `tsc --noEmit`                                              |
| `bun run check:reachability` | which modules the edge actually imports, and which are dead |
| `bun run assets:driver`      | repacks `assets/driver.json` from the sibling module repos  |
| `bun run build`              | hydrate the release payload: what a deploy runs             |
| `bun run build:local`        | build every generated artifact from source                  |
| `bun run build:plan`         | what a source build would do, and what tools are missing    |
| `bun run assets:sql`         | rebuild only the migration chunks                           |

### 🧰 Building From a Clean Clone

`assets/` is ~97 MB of generated packs and `.interp/` holds the interpreter. Both are gitignored, so
a fresh clone has nothing to deploy until one of two routes lands them.

```bash
bun install     # postinstall restores the interpreter from the CDN, verified by sha256
bun run hydrate # the payload if one is published, a source build if not
bun run dev
```

| route       | command               | needs                                          | takes   |
| ----------- | --------------------- | ---------------------------------------------- | ------- |
| **payload** | `bun run hydrate`     | network                                        | seconds |
| **source**  | `bun run build:local` | network, PHP, composer, node 24+, zstd, Docker | minutes |

The payload route is one verified HTTPS GET of a release asset, which is what lets the Deploy to
Cloudflare button work: Workers Builds has no Docker. The source route regenerates the same bytes
locally, for a commit no release was cut from. `bun run hydrate` takes the payload route and falls
back to the source route when there is no payload; `--payload-only` forbids the fallback and
`--from-source` skips straight to it.

The source route runs fourteen steps in one order, each skipped when what it produces is already on
disk, and together they produce **every artifact a release payload carries**:

```txt
interpreter → frame → decoder      the three files the binary seam imports
siblings    → driver               the Drupal modules, packed into assets/driver.json
tree → site → patch                the Drupal tree, installed and patched for wasm
bootstrap → twig → core → pack     the file list, the compiled Twig cache, the per-file pack
sql                                the migration chunks, from the committed site.sqlite
prefill                            the pages, rendered by a local wrangler dev and lifted back
```

Run `bun run build:plan` first — it prints the plan and names every tool this machine is missing
before it spends a minute on the 180 MB tree download. Only `decoder` needs Docker, and only once.

**[`docs/building-from-source.md`](docs/building-from-source.md)** is the full account: what each step
produces, why the order is the order, what caches on what, and why `prefill` is the one step allowed
to fail without failing the build.

---

## 📁 Project Structure

```txt
src/
  site.ts            the edge front end: cache tiers, generation counter, deny filter
  site-do.ts         the Durable Object: PHP lifecycle, render, fill queue, alarms
  runtime/           interpreter plumbing: mount, lazy FS, interrupt mask, gate, binary seam
  db/                codec, the ctx.storage.sql bridge, chunked migration, heap snapshot store
  drupal/            PHP fragments evaluated inside the interpreter
  ops/               cron/GC, sliced database updates, the Tail Worker
  probes/            measurement workers, kept so a report figure can be reproduced
drupal/
  cfw_do_sqlite/     the Drupal database driver for Durable Object SQLite (repo: rom)
  drupflare/         mail, fetch, images, KV, health/self-repair, and the shim registry
build/               the PHP wasm build: extension sets, the VM-interrupt patch, C probes (repo: phasm)
tests/               unit (in workerd), integration (live Durable Object), e2e
scripts/             packers, benches, and the measurement instruments
experiments/         44 measurement configs, kept for reproduction
```

---

## 🧪 Testing

Two vitest projects. **2,180 tests across 96 files, 0 failures**, plus **585 PHP assertions**.

| lane                  | command                            | count                        | runs in                                        |
| --------------------- | ---------------------------------- | ---------------------------- | ---------------------------------------------- |
| vitest `workers`      | `bun run test:workers`             | **1,652**                    | workerd, via `@cloudflare/vitest-pool-workers` |
| vitest `node`         | `bun run test:node`                | **528**                      | Node, for oracles workerd cannot host          |
| both, merged coverage | `bun run test`                     | **2,180** in 96 files        | one invocation                                 |
| PHP suites            | `bun run test:health` / `test:php` | **585** across 5 suites      | real PHP, in the sibling repos                 |
| e2e                   | `bun run test:e2e`                 | excluded from `bun run test` | needs a running server                         |

### Two Vitest Projects

`workers` is the default lane and where most of the subject lives. `node` exists because
workerd cannot host two things the suite needs, both verified rather than assumed:

- **`node:child_process` is not implemented.** A probe calling `execFileSync('php', ...)` fails
  with "The child_process.execFileSync method is not implemented", so any suite whose oracle is
  a real PHP process cannot run in the workers project at all.
- **`node:sqlite` does not exist**, which `test-migrate-sql.mjs` needs to diff a replayed
  database against its source.

Without that second project a PHP-oracle suite has to either transliterate the PHP and test the
copy, or stay outside vitest forever. `tests/node/mb-fix-iconv.spec.ts` is the first occupant:
it recovers two platform controls that had to be dropped when `mb-fix` moved into workerd, and
it **skips rather than fails** when no `php` is on PATH.

Coverage from both projects is merged into one lcov by `bun run test:coverage`; Codecov gets a
`coverage` flag for the merged report and `workers` / `node` flags for per-lane test results,
all with `carryforward: true`.

### The integration lane needs a real Durable Object

Specs under `tests/integration/` use `ctx.storage.sql`, `transactionSync()`, `setAlarm()` and
`caches.default`. A mock of any of those would be testing the mock, and `runInDurableObject` from
`cloudflare:test` gives the real thing without a manually started server, so the
serve-chain suite moved here rather than staying a script that needed `bun run dev` first.

### Why the tests run inside workerd

Every one of these has already produced a defect that a Node-hosted mock passed:

- `ctx.storage.sql` is synchronous only from inside a Durable Object.
- `transactionSync()` has no Node equivalent; `BEGIN` as SQL is refused outright.
- The host caps a statement at **100 bound parameters**; local PDO allows 32,766. That gap
  hid a live cache-write defect behind a green suite.
- In-PHP `microtime()` and JS `Date.now()` both return **0** on the edge.

### Coverage

Coverage uses `provider: 'istanbul'`, not `v8`. The v8 provider reads coverage off the Node
inspector, and these tests run inside workerd's isolate: it instrumented all 2,269 statements and
attributed zero while 110 tests passed. istanbul instruments at transform time, so it travels into
the isolate with the code.

The sibling repos split on exactly this axis: `earth-app/cloud` and `js/edgeport` are workerd
and use istanbul; `earth-app/crust` and `earth-app/sky` are happy-dom and use v8.

Thresholds sit just under the current measured figure and are meant to be **ratcheted** as
each legacy suite lands in `tests/`. An aspirational number here would be a failing check
everyone learns to ignore.

### The port is complete

There are no `scripts/test-*.mjs` suites left; every one now runs in the gate. Each original
was deleted only once **coverage of the module it tested** justified it — not on an assertion
count, which is not comparable across a rewrite in either direction.

| original               | sites | ported to                                                              | what the move bought                                                       |
| ---------------------- | ----- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `test-cron.mjs`        | 219   | `tests/unit/ops/cron-{chain,gc,step}.spec.ts`                          | its hand-written `fakeSql` replaced by the real `ctx.storage.sql`          |
| `test-updb.mjs`        | 364   | `tests/unit/ops/updb.spec.ts`                                          | bookkeeping now runs in a real `transactionSync`                           |
| `test-mask.mjs`        | 123   | `tests/unit/runtime/mask.spec.ts`                                      | source assertions made quote-agnostic                                      |
| `test-mb-fix.mjs`      | 25    | `tests/unit/drupal/mb-fix.spec.ts` + `tests/node/mb-fix-iconv.spec.ts` | split, because the `iconv_substr` control needs real PHP                   |
| `test-migrate-sql.mjs` | 89    | `tests/node/migrate-sql.spec.ts`                                       | stays in the node project; `node:sqlite` exists in neither workerd nor bun |
| `test-serve-chain.mjs` | 94    | 7 specs in `tests/integration/`                                        | **no `wrangler dev` step** — `runInDurableObject` instead                  |

The serve-chain port took 94 assertion sites to 344 across 96 cases, and dropped the requirement
for a manually started server.

Rules that carry over: assert on behaviour or a counter, never on timing, except where
timing _is_ the claim. Name which cache bins were emptied for every render figure. **An
absolute CPU number comes only from a deployed worker** — nothing in `tests/` can produce one.

---

## 📦 Repositories

This started as one repository and is being split, so each piece is usable on its own.

| repo                    | what it is                                                                      | install                                |
| ----------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| **`worker`** (this one) | the Worker: cache tiers, the Durable Object, the packers                        | clone                                  |
| **`drupflare`**         | the capability module -- mail, fetch, images and KV bridged to Workers bindings | `composer require drupflare/drupflare` |
| **`rom`**               | `cfw_do_sqlite`, the Drupal database driver for Durable Object SQLite           | `composer require drupflare/rom`       |
| **`phasm`**             | the PHP-to-WebAssembly build toolchain                                          | GitHub Releases                        |

### Why the Modules Exist Twice

`composer.json` requires both modules the published way. **The copies under `drupal/` are not
vestigial and must not be deleted.**

This worker never loads PHP from `vendor/` -- Composer does not run on the edge. `bun run
assets:driver` reads `drupal/cfw_do_sqlite` and `drupal/drupflare` off disk and packs them
into `assets/driver.json`, which the Durable Object mounts into its in-memory filesystem. So the
packed copy is what executes, and the Composer requirement records provenance and lets a
developer resolve the packages normally.

That trade has one hazard: a fix made here ships without running the sibling repo's suite, and a
fix made there never reaches the edge. The guard is `tests/node/driver-pack.spec.ts`, which
rebuilds the pack from `drupal/` and compares it to `assets/driver.json` byte for byte, so a stale
pack fails the gate. The sibling repos are published, and a release is when the copies under
`drupal/` are refreshed.

Both modules resolve from Packagist normally: `drupflare/rom` and `drupflare/drupflare` are published.

## 🧩 Contrib Modules

Installing a module works on a deployed site, measured at **6,810 ms** of Durable Object CPU with
the module present in `core.extension` afterwards on 6 of 6 attempts. The cache is cold for one
visit while the pages the install invalidated are re-rendered.

<!-- module-table:begin -->

**14 verified, 15 supported, 1 blocked.** Verified means the gate enabled the module and asserted an observable it owns. Supported means it has not been enabled here; where the evidence names a spec, the runtime capability that module needs has been measured end to end without the module.

| Module                     | State     | Evidence                                                                                                                                                                                                                                                                                               |
| -------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admin Toolbar              | verified  | enabled against a real site in the workers lane; its own routes appear in the `router` table after the install-triggered rebuild                                                                                                                                                                       |
| Captcha                    | verified  | enabled against a real site; its schema hook created `captcha_sessions` and 8 routes appear in the `router` table. Its routes are named with underscores, so a dotted module-prefix match finds none of them                                                                                           |
| Coffee                     | supported | classified as workable, not yet exercised                                                                                                                                                                                                                                                              |
| Ctools                     | verified  | enabled against a real site in the workers lane; `core.extension` grew and the site still saved content afterwards. A library module with no user-visible behaviour of its own, so this is the strongest observable it has                                                                             |
| Devel                      | supported | local introspection. Worth a warning rather than a capability: it dumps debug output INTO the page, and this runtime stores anonymous output in `cfw_page` and serves it to everyone                                                                                                                   |
| Entity Reference Revisions | supported | a field type                                                                                                                                                                                                                                                                                           |
| Facets                     | supported | facets themselves are local: they read from whatever Search API backend is configured. With the DATABASE backend this needs nothing, which is why it is not refused                                                                                                                                    |
| Field Group                | verified  | enabled against a real site; it creates no table and ships no settings, so what was asserted is what it adds to the CONTAINER -- `plugin.manager.field_group.formatters`, `field_group.subscriber` and `field_group.param_converter` all resolve after the install, with a core service as the control |
| Filefield Sources          | supported | the local sources (upload, reference, clipboard) need nothing. Only the "remote URL" source calls out, and it is one source among several                                                                                                                                                              |
| Google Analytics           | supported | classified as workable, not yet exercised                                                                                                                                                                                                                                                              |
| Honeypot                   | verified  | enabled against a real site; its schema hook created `honeypot_user`. The recommended default over any captcha here, because a hidden field and a submission timer are entirely local and cost no outbound round trip                                                                                  |
| Image Optimize             | supported | batch optimisation over managed files. The BINARY pipelines shell out and cannot work; the pure-PHP and remote-service pipelines are the ones in scope                                                                                                                                                 |
| Linkit                     | supported | autocomplete over local entities                                                                                                                                                                                                                                                                       |
| Metatag                    | verified  | enabled against a real site; it installed 8 config objects of its own, so it has defaults to apply rather than enabling inert the way pathauto does                                                                                                                                                    |
| Migrate Plus               | verified  | enabled against a real site; both config entity types it exists to provide are installed -- `migration.entity_type` and `migration_group.entity_type`. It ships no config OBJECTS, so a `migrate_plus.%` config probe finds nothing and would read as inert                                            |
| Paragraphs                 | verified  | enabled against a real site; it created its entity type as four tables -- `paragraphs_item`, `paragraphs_item_field_data`, `paragraphs_item_revision`, `paragraphs_item_revision_field_data`                                                                                                           |
| Pathauto                   | supported | token replacement over local entity data on save                                                                                                                                                                                                                                                       |
| Purge                      | supported | invalidation is a queue drained by cron, and each purger POSTs or PURGEs to a CDN. Both halves are deferrable; neither has to answer inside a render                                                                                                                                                   |
| Queue Ui                   | verified  | enabled against a real site; its admin routes are in the `router` table, and routes are the whole module                                                                                                                                                                                               |
| Recaptcha                  | verified  | enabled against a real site; captcha came with it, so dependency resolution ran, and it installed its own configuration                                                                                                                                                                                |
| Redirect                   | verified  | enabled against a real site; the `redirect` table exists and 11 of its routes are in the `router` table, so both halves of a route subscriber over its own table are present                                                                                                                           |
| Scheduler                  | verified  | enabled against a real site; it installed its own configuration and its routes are in the `router` table                                                                                                                                                                                               |
| Search Api                 | verified  | enabled against a real site; it created `search_api_item` and `search_api_task`, which is where the database backend writes, and its index routes are in the `router` table                                                                                                                            |
| Search Api Solr            | blocked   | drupal/search_api_solr needs an outbound call to answer INSIDE one render, and this runtime cannot suspend mid-run to wait for a socket **Lift:** JSPI or an Asyncify build, which is the whole-binary change this project has priced and deferred. Use the Search API database backend instead        |
| Simple Sitemap             | supported | generation is a queue drained by cron, and the cron wire is measured in `cron-wire.spec.ts`. The module is not in the pack                                                                                                                                                                             |
| Stage File Proxy           | verified  | enabled against a real site; `stage_file_proxy.settings` is installed, which is what its fetch path reads                                                                                                                                                                                              |
| Token                      | supported | a token vocabulary; no I/O of its own                                                                                                                                                                                                                                                                  |
| Twig Tweak                 | supported | Twig functions over local services                                                                                                                                                                                                                                                                     |
| Webform                    | supported | form building and submission storage are local. Handlers that POST to a remote endpoint are the deferrable case and are per-handler, not per-module                                                                                                                                                    |
| Xmlsitemap                 | supported | drupal/xmlsitemap does its work on cron, which runs from the Durable Object alarm; set DRUPAL_CRON=1 or it installs and silently does nothing                                                                                                                                                          |

<!-- module-table:end -->

## 🧱 Limitations

These are properties of the runtime, measured rather than assumed. They belong in release
notes, not in support tickets.

- **Case-insensitive matching is ASCII-only.** Durable Object SQLite has no user-defined
  collations, so Drupal's `NOCASE_UTF8` becomes builtin `NOCASE`. `Ünicode` does not match
  `ünicode`. This affects username and email uniqueness and taxonomy matching.
- **`LIKE`/`GLOB` patterns cap at 50 bytes.** A Views "contains" filter on a longer search
  string fails in the engine.
- **A statement caps at 100 bound parameters.**
- **`REGEXP` does not exist**, so Views regex filters do not work.
- **Reading an integer above 2^53 is lossy** — the cursor returns doubles. Writing is exact.
- **Greek word-final sigma lowercases differently** from native PHP, and `mb_strwidth`
  under-counts emoji. Neither affects Drupal core.
- **Uncached traffic does not scale.** One site is one Durable Object is one thread, and you
  cannot buy a bigger one. Content sites win decisively; high-write authenticated sites do
  not.
- **A module install leaves the object with no room to do anything else.** It costs 6,810 ms of CPU
  — the installer is 1,570 ms of that and the kernel boot 3,101 ms — and ends with the wasm heap at
  ~110 MB of the isolate's 128 MB. `memory.grow` has no inverse, so the next event on that isolate
  is refused until it is re-created. The install therefore queues the pages it invalidated instead
  of re-rendering them, and the cache is cold for one visit. Restoring a heap snapshot instead of
  booting removes 2,310–3,578 ms of that (n=8 per arm, present in both modes of a bimodal
  population). It is **on by default**; each site pays 31,784,960 bytes across 159 rows for the
  image, and `HEAP_SNAPSHOT=0` turns it off.
- **A freshly deployed site is claimable until it is provisioned.** `/firstrun` answers without a
  credential while the site has never been configured, because the owner token that `/export` takes
  is minted by that route and nowhere else — gating it would mean the only way to get your data out
  was to expose `/sql`, `/restore` and `/php` first. The window is the unprovisioned state only:
  once configured the route answers 409, and reconfiguring needs the token. Same model as Drupal's
  own `install.php`. Run `/firstrun` as the first thing you do after deploying.
- **A rejected form token stops later logins on the same instance.** After a submission fails
  its CSRF check — a stale tab, a back button, a double submit — the login form on that
  Durable Object stops being processed until the object drops its interpreter. It rebuilds
  with no error message rather than reporting a wrong password. No data is affected and
  nothing leaks between users.

---

## 📊 Technical Report

[**`TECHNICAL_REPORT.md`**](TECHNICAL_REPORT.md) is the full engineering record — every
measurement, every wrong turn, and why each conclusion changed. It is long: the
sequence of wrong turns is the most reusable part of it.

It documents, among other things, the rule the whole project runs on — **an absolute CPU
figure comes only from `cpuTime` on a deployed worker**, because in-PHP `microtime()` returns
0 on the edge — and the six occasions a free-tier verdict moved, four of which were the
instrument rather than the system.

> The report was written by Claude (Anthropic) while doing the work, and is a
> record of measurements taken on real hardware and real Cloudflare
> infrastructure rather than a summary of intent. Where a number is a local
> ratio rather than an edge absolute, it says so.

---

## 🤝 Contributing

```sh
bun install
bun run typecheck
bun run test # 2,066 across the workers and node lanes
bunx prettier --check .

bun run test:e2e # excluded from the gate; needs a running server
```

Run `bun run assets:driver` after any change under `drupal/` — composer never runs on the
edge, so `assets/driver.json` is the copy that actually executes, and
`tests/node/driver-pack.spec.ts` is what catches it going stale.

## 📄 License

See [LICENSE](LICENSE).
