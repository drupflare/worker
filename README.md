# 🐘 Drupflare — Drupal on Cloudflare Workers

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/drupflare/worker)
[![Build](https://github.com/drupflare/worker/actions/workflows/build.yml/badge.svg)](https://github.com/drupflare/worker/actions/workflows/build.yml)
[![Prettier](https://github.com/drupflare/worker/actions/workflows/prettier.yml/badge.svg)](https://github.com/drupflare/worker/actions/workflows/prettier.yml)
[![codecov](https://codecov.io/gh/drupflare/worker/branch/master/graph/badge.svg)](https://codecov.io/gh/drupflare/worker)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Drupal 11 running on Cloudflare Workers.** No VPS, no container, no origin server — PHP
8.5 executes as WebAssembly inside a Durable Object, with the Durable Object's own SQLite as
the database. **8.5 is what ships**, with nothing dropped to fit, at **2,659,444** zstd bytes
against the 3,145,728 free-plan ceiling (`interp.lock.json`).

> [!NOTE]
> No release is published yet, and the deploy button pulls from a release payload. `assets/` is
> 121 MB of generated packs and is gitignored, so `bun run build` hydrates that payload: a plain
> HTTPS GET of a release asset, with no Docker, no token and no PHP.

The interpreter ships as a zstd frame inflated at module scope, which is what lets PHP 8.5 fit the
free plan's bundle limit with every extension intact. Cold boot is **1,398 ms** of `cpuTime` on a
deployed worker, and boot work is saturated: cutting boot cost per fill by 20x moves the regeneration
ceiling **1.1%**. Rows written is the meter that binds. See [Free vs Paid](#-free-vs-paid).

---

## ⚖️ Drupflare vs a Traditional VPS

Drupflare targets **solo, indie and budget-bound sites**, where the cost is the hours rather than the
hosting bill.

Every Drupflare figure marked **M** is measured, on deployed Cloudflare infrastructure or on this
machine, and the column says which. **L** is a vendor's published list price. **—** is not measured,
and is stated as a range or omitted.

|                                            | Drupflare                                                                                                                                         | Traditional VPS                                                      | prov.   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------- |
| **Setup, from zero to a rendering site**   | one deploy, no server                                                                                                                             | provision, webserver, PHP-FPM, MariaDB, TLS, cron, firewall, backups | —       |
| **Local toolchain you must learn first**   | none for deploy; `bun` to develop                                                                                                                 | ddev or Lando, Composer, Drush, ssh, a database client               | —       |
| **Monthly infrastructure**                 | itemised in [The Cost Model](#the-cost-model)                                                                                                     | the same table                                                       | L       |
| **What "scaling up" means**                | nothing to do — the edge absorbs it                                                                                                               | resize the box, tune PHP-FPM workers, add a cache layer              | —       |
| **OS patching, PHP upgrades, kernel CVEs** | none exist to patch                                                                                                                               | yours, forever                                                       | —       |
| **Anonymous page served from**             | edge cache, **~85%** of traffic, **0** Durable Object requests                                                                                    | your box, every request                                              | M edge  |
| **`page_cache` hit**                       | **1 ms** of Durable Object CPU, 1 statement                                                                                                       | full LEMP round trip                                                 | M edge  |
| **`dynamic_page_cache` hit**               | **26 ms**, 6 statements                                                                                                                           | —                                                                    | M edge  |
| **Full uncached render**                   | **34 ms**, both bins emptied, 13 statements                                                                                                       | **9.47 ms** native PHP, warm kernel                                  | M both  |
| **Wasm penalty**                           | **3.57x** warm / **3.94x** cold vs native PHP                                                                                                     | 1x by definition                                                     | M local |
| **Cold start**                             | **1,398 ms** measured (n=3, and the platform is bimodal by 400-600 ms) — paid absorbs it, free amortises it off the request path                  | ~0; the box is already running                                       | M edge  |
| **Free-plan capacity**                     | **~100,000 page views/day** (~3M/month), saturated; every visit costs one Worker request, cached or not                                           | whatever the box does before it swaps                                | M edge  |
| **Worker bundle**                          | fits the 3 MiB free-plan limit                                                                                                                    | n/a                                                                  | M local |
| **First-run migration**                    | **62 chunks**, one per invocation on free, each sized to fit the 10 ms cap                                                                        | `drush si`, then hope                                                | M local |
| **When something breaks at 3am**           | a self-repair ladder runs: L0 observe → L1 reset → L2 reconstruct → L3 reconfigure → L4 quarantine → L5 rollback, with a decaying circuit breaker | you, or someone you pay                                              | M built |
| **Failure detection**                      | **19 tripwires** (12 host, 7 PHP) plus a mandatory boot self-test                                                                                 | uptime ping, if configured                                           | M built |

### The Cost Model

**The infrastructure saving is small; the labour saving is the large one.**

Infrastructure, for one small content site. Vendor figures are list prices rather than measurements,
and are marked so:

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

**Price those at your own rate.** This project states no hourly figure.

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

### What the Self-Repair Layer Replaces

It is not a monitoring dashboard; it acts. A capped, GC'd health ledger; 12 host tripwires
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

**L4 quarantine and L5 rollback act.** Three consecutive findings of the same code at `error`
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
> **No page is served off-Worker today.** The alarm drains both mirrors — files and pages, the latter
> ordered by view count so a limited budget publishes what actually moves traffic — but the canonical
> `wrangler.jsonc` declares no R2 binding and no bucket is fronted by a custom domain, so nothing
> answers a page without the Worker running. Both page tiers, the edge cache and the optional KV
> tier, cost one Worker request each because the Worker has to run to consult them. The ceiling
> shipping today is the 3.0M row above, saturated; the floor once pages do move off-Worker is
> **3.33x**, 10M R2 Class B operations/month against 100,000 Worker requests/day.
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

### The Image Transform Cap

Cloudflare Images allows **5,000 unique transformations per month** on free, and it fails as a **hard
cap rather than a bill**. Every image style is a transformation, so ten styles over 2,000 images is
20,000 -- 4x over. It is the only quota here measured per month rather than per day, so it does not
clear at midnight.

It is **projected rather than counted**, because it is a function of the site's content and
configuration and both are known in advance. The object multiplies its image styles by its managed
images on every alarm and records `budget.image_transforms` in the health ledger at 80% of the
allowance. A warning, never a repair: the remedies are dropping a style or cutting the image count,
and both are decisions a human makes. `/health` shows it, and `/_cfw` shows the full projection with
the largest style count that still fits.

> [!CAUTION]
> Do **not** enable the Workers Caching feature on free. It bills every request at the standard rate
> _"including requests that are normally free: static asset requests"_ — converting the one free serving
> path into a billed one. The name reads like what a cache-first architecture wants; the billing does
> the opposite.

---

## 📋 Table of Contents

- [Drupflare vs a Traditional VPS](#-drupflare-vs-a-traditional-vps)
- [Free vs Paid](#-free-vs-paid)
- [Why](#-why)
- [How It Works](#-how-it-works)
- [What It Costs](#-what-it-costs)
- [Getting Started](#-getting-started)
- [Building From a Clean Clone](#-building-from-a-clean-clone)
- [Configuration](#-configuration)
- [Git Remotes](#-git-remotes)
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
  ├─ 0. Workers Assets (/core/**)          stylesheets, scripts, fonts; never reaches the Worker
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
   extension Drupal requires is statically linked (`MAIN_MODULE=0`). The toolchain is
   [`drupflare/phasm`](https://github.com/drupflare/phasm); this repository consumes its output.
2. **PHP runs _inside_ the Durable Object, not beside it.** `ctx.storage.sql` is synchronous
   only from within the object, and PHP's database calls are blocking. Any other arrangement
   cannot connect the two.
3. **A real Drupal database driver.** `cfw_do_sqlite`, from the
   [`rom`](https://github.com/drupflare/rom) sibling, is a Drupal 11 driver for Durable Object
   SQLite. Drupal's query builders, schema handling and condition compiler are used unchanged;
   what is replaced is everything that assumed PDO and a file on disk.
4. **Divisibility, not speed.** The free plan caps CPU _per invocation_. So work that does
   not fit is split rather than optimised — and what language a step runs in decides whether
   it can be split at all. First-run migration moved from PHP to JavaScript, from one 3,467 ms
   invocation to **62 chunks**, each sized to fit the cap on its own.

### Static Assets

Drupal's stylesheets, scripts, fonts and images are served by **Workers Assets** from `assets/core/`,
at the `/core/**` URLs Drupal already emits. All three PHP packers skip those extensions because PHP
never opens them, and nothing serves a file out of the in-memory filesystem over HTTP, so the asset
layer is the only thing that can answer them. `scripts/pack-static.ts` copies the tree; Workers Assets
content-hashes, caches and compresses what it serves, and a hit never reaches the Worker, so it costs
nothing against either free-tier ceiling.

**CSS and JS aggregation is off**, because an aggregate has no file to read: a hash mismatch 301s and
a match sends Drupal's optimiser at a path no pack carries. With the raw tree served there is nothing
for preprocessing to buy. `tests/unit/runtime/assets-ignore.spec.ts` asserts both halves — that no
prefilled page references an aggregate, and that every `/core/**` URL those pages do reference
answers 200.

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

| artifact             | size                                                                              | from                              |
| -------------------- | --------------------------------------------------------------------------------- | --------------------------------- |
| Worker bundle        | fits the 3 MiB free-plan limit                                                    | `bun run release:check`           |
| PHP 8.5, nothing cut | **2,659,444 bytes** zstd, from 12,218,396 raw; this is what ships                 | `interp.lock.json`                |
| First-run migration  | **62 chunks**, 1,564 statements over 1,316 rows; one chunk per invocation on free | `assets/drupal-sql/manifest.json` |
| Static asset tree    | **4,028 files** served by Workers Assets, never reaching the Worker               | `assets/core/`                    |
| Cold boot            | **1,398 ms** measured; amortised off the request path rather than eliminated      | deployed `cpuTime`, n=3           |

---

## 🚀 Getting Started

### Prerequisites

- [Bun](https://bun.sh/)
- **Node 24+** as well — a few scripts need `node:sqlite`, which Bun does not ship
- PHP 8.3+ with `pdo_sqlite` (only to run the database driver's test suite)
- A Cloudflare account with Durable Objects enabled (available on the free plan)

### Install and Run

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

The first visit starts the site up, which is [First Boot](#first-boot) below. To replay the whole
database in one shot instead, which is faster locally:

```bash
curl "localhost:8787/migrate?all=1"
```

### First Boot

A deployed site has an empty Durable Object until something asks it for a page. The first request
records the ask, arms the alarm chain and answers **503** with a self-refreshing page, and the object
replays the packed database one chunk per invocation until the cursor is done.

| header                | value                                                |
| --------------------- | ---------------------------------------------------- |
| `x-cfw-migrate`       | `starting`, then `<chunk>/<chunks>`                  |
| `x-cfw-migrate-state` | `queued`, `running` or `failed`                      |
| `retry-after`         | `2` on the first request, `1` while chunks are going |

A browser follows the `<meta http-equiv="refresh">` on that page and lands on the site by itself.
Every other client gets the same 503 with the one-word body `migrating`.

**Measured on a deployed worker: 4 to 7 polls at 2 s, so 8 to 14 seconds from the first request to
the first 200.** A 503 in that window means the site is starting, not that the deploy failed.

One chunk per invocation is what keeps every invocation under the free plan's 10 ms CPU cap, and the
chain drives itself to completion over **62 alarm firings**. The chunk count is whatever
`assets/drupal-sql/manifest.json` reports, and it moves whenever the packed database does.

### Claim the Site

The pack ships an installed database, so Drupal's `install.php` never runs and never asks you to
pick a password. `/firstrun` is what does that, and until it runs, uid 1 carries an empty hash that
no password can match.

**An unclaimed site says so.** Once the migration finishes, a browser asking for any HTML page gets
a one-click claim page instead of the front page: enter a site name, an administrator email and
optionally a password, and the credentials come back in the response. The page carries
`x-cfw-setup: required` and is never stored. A `curl`, an asset fetch and a POST all fall through to
the normal path, so nothing but a browser navigation is blocked.

To claim it from a terminal instead:

```bash
curl -X POST "localhost:8787/firstrun" \
  -H 'content-type: application/json' \
  -d '{"siteName":"My Site","adminMail":"you@example.com"}'
```

The response carries `adminPass` and `ownerToken`, **each shown once and stored nowhere**. Save both
before closing the terminal. Pass `"adminPass":"..."` in the body to choose your own instead of
taking the minted one. Claiming a site also pins its render origin — see
[Configuration](#-configuration).

The body takes `siteName`, `siteMail`, `adminName`, `adminMail`, `adminPass` and `timezone`, all
optional. A password never travels in a query string: `?pass=` is refused by name rather than
honoured, because the request line is what `wrangler tail`, observability and every intermediary
log.

A bare `GET /firstrun` reports whether a site has been claimed without claiming it:

```bash
curl "localhost:8787/firstrun"
```

Once claimed, `/firstrun` answers **409**. Reconfiguring is `POST /firstrun?force=1` with
`Authorization: Bearer <ownerToken>`, which resets the administrator password.

### Log In

Log in at `/user/login` as `admin` with the `adminPass` from the claim. That is the Drupal account,
and it is the only credential that reaches the administrative UI.

**The owner token is a different credential and is not a login.** It is sent as
`Authorization: Bearer <ownerToken>` and reaches four routes without turning on `PW_DIAGNOSTICS`:

| route         | what it does                                                   |
| ------------- | -------------------------------------------------------------- |
| `/export`     | dumps the site database; the "a customer can leave" property   |
| `/health`     | the health ledger, the repair state and the budget projections |
| `/setup/cf`   | connect, inspect or revoke a Cloudflare account for the site   |
| `/setup/mail` | onboard a sending domain onto a zone                           |

Without it those four answer **401** with a `WWW-Authenticate: Bearer` challenge; a diagnostic route
answers 404 to the same caller.

A dump withholds the owner token, the Cloudflare OAuth tokens and the hash salt, and reports how many
rows it held back. `?secrets=1` carries them: a faithful restore needs the salt, since it signs
one-time login links and form tokens, and a backup kept anywhere else should not have it.

A lost `adminPass` is recovered through Drupal's own password reset, which needs mail configured. A
lost `ownerToken` is read back by setting `PW_DIAGNOSTICS=1` and calling `POST /firstrun?force=1`,
which returns the stored token and resets the administrator password at the same time.

### Manage the Site

[`drangler`](https://github.com/drupflare/drangler) is the CLI for the rest of a site's life. It
needs no checkout of anything:

```sh
bun add -g @drupflare/drangler

drangler status my-site.example # plan, generation, header contract, claim state, diagnostics
drangler health my-site.example # is it up, and which cache tier answered
drangler doctor                 # the local toolchain and the Cloudflare credential
```

Moving to a newer Drupflare is `drangler update`. With no argument it fast-forwards the local
checkout and rebuilds the artifacts that belong to the version it left behind; naming a deployed
worker updates the checkout and then deploys it there.

```sh
drangler update             # the local .drupflare checkout, to the latest
drangler update --to v0.3.0 # or to a named version
drangler update my-site     # and then deploy it to an existing worker
```

`build`, `dev`, `deploy`, `update` and `migrate install` are the five commands that write; `status`,
`doctor`, `health`, `config`, `cf`, `secrets`, `validate` and the rest of `migrate` read. Its README
covers the migration commands in both directions.

### The Admin Surfaces

Six pages under `/_cfw`, each one driving machinery that already exists rather than holding its own.

| page         | path             | what it does                                                                            |
| ------------ | ---------------- | --------------------------------------------------------------------------------------- |
| **Limits**   | `/_cfw`          | every metered resource, what spends it, and whether exceeding it bills or stops working |
| **Extend**   | `/_cfw/extend`   | whether a contrib module installs here, answered against the shipped lock               |
| **Commands** | `/_cfw/commands` | a Drush-shaped field over the site's operations                                         |
| **Deploy**   | `/_cfw/deploy`   | the provisioning steps, two of which cannot be automated                                |
| **Git**      | `/_cfw/git`      | remotes, branches, pull requests and the working-tree diff                              |
| **Access**   | `/_cfw/access`   | the OpenID Connect provider                                                             |

The Commands field takes Drush spellings and resolves them to the operation the site registers, so
`cache:rebuild`, `cache-rebuild`, `cc` and `cr` are the same command. `en <module>` routes to the
module installer rather than to the operations registry, and an operation given arguments it cannot
take is refused by name instead of being truncated to its first word.

```text
cr                  rebuild the caches
en webform          install a module
en webform --dry    check whether it would install, without installing
status              generation, migration state, queue depth
```

An operation with no driver is listed and disabled rather than hidden, because a refusal with no
named alternative is a refusal that gets retried.

### Single Sign-On

The Access page configures an OpenID Connect provider. The host performs the token exchange and
verifies the `id_token` signature, because the interpreter is built without OpenSSL and cannot check
an RS256 signature at all — and an unverified `id_token` is an unauthenticated login.

Single sign-on needs `drupal/externalauth`, which maps the verified identity onto an account. No
contrib module ships in the packed tree, so install it from the Extend page before the first login.

Set the issuer and client id on the page, and the client secret as the `OIDC_CLIENT_SECRET` binding.
The redirect URI to register with the provider is shown on the page. Saving verifies the issuer's
discovery document immediately, so a typo surfaces there rather than at someone's first login.

Writing the provider takes the owner token, not the page's own gate. Whoever sets the issuer decides
which provider every login on the site authenticates against.

A login is refused when the signature comes from a key outside the provider's JWKS, when the issuer
does not match, when the audience belongs to another client of the same provider, when the token has
expired, or when the nonce belongs to a different login. The signing algorithm is taken from the key
rather than from the token header, and an account is keyed by issuer and subject together.

### URL Routing

**Drupal owns the URL space.** Any path the Worker does not claim is served as a page, so `/`,
`/user/login`, `/admin` and `/node/1` all work. The Worker's own surfaces live under `/_cfw`, which
Drupal does not generate; its diagnostic and owner routes are single-segment names like `/health`
and `/export`.

Which site a request resolves to is decided in [`src/ops/site-id.ts`](src/ops/site-id.ts): a KV
mapping for the host, then the `SITE_ID` var, then the hostname itself, then `site`. On `localhost`
the hostname names no site, so it lands on `site`. `?site=` is refused on the public routes, so a
link cannot choose which site answers; an owner route accepts it because the object checks the token
itself, and `PW_DIAGNOSTICS=1` accepts it everywhere, which is what `/serve?site=X&path=Y` uses.

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

`assets/` is 121 MB of generated packs and `.interp/` holds the interpreter. Both are gitignored, so
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

The source route runs fifteen steps in one order, each skipped when what it produces is already on
disk, and together they produce **every artifact a release payload carries**:

```txt
interpreter → frame → decoder      the three files the binary seam imports
siblings    → driver               the Drupal modules, packed into assets/driver.json
tree → site → patch                the Drupal tree, installed and patched for wasm
bootstrap → twig → core → pack     the file list, the compiled Twig cache, the per-file pack
static                             the browser-fetchable half of core/, into assets/core
sql                                the migration chunks, from the committed site.sqlite
prefill                            the pages, rendered by a local wrangler dev and lifted back
```

Run `bun run build:plan` first — it prints the plan and names every tool this machine is missing
before it spends a minute on the 180 MB tree download. Only `decoder` needs Docker, and only once.

**[`docs/building-from-source.md`](docs/building-from-source.md)** is the full account: what each step
produces, why the order is the order, what caches on what, and why `prefill` is the one step allowed
to fail without failing the build.

---

## 🔧 Configuration

Every knob is a `vars` entry in `wrangler.jsonc`, and every one has a working default. Eleven of them
can also be overridden at runtime through the `CONFIG_KV` namespace without a redeploy.
**[`docs/configuration.md`](docs/configuration.md)** is the full reference: every variable, its
default, what reads it, and what breaks when it is wrong. Three vars are worth stating here, plus the
two setup flows a new site runs once.

### `SITE_ORIGIN`

The `scheme://host[:port]` Drupal builds absolute URLs against — the canonical tag, a form action, a
`Location:`, the link in a password-reset mail. Unset, the object **pins the first non-local origin
it serves** into `cfw_meta` and measures every later request against that rather than believing the
inbound `Host`; `/firstrun` re-pins, so claiming a site also fixes its origin. Set it when a site is
reached through a host it cannot observe, such as behind a proxy that rewrites `Host`, or on a deploy
whose first request is a health check.

A local origin is never pinned, so running the suite or a `wrangler dev` against a persisted object
cannot fix a real site's canonical URL to a developer's laptop. Cron boots against the same origin,
which is what stops a mailed reset link pointing the recipient at their own machine.

### `PHP_LOG_LEVEL`

The highest RFC 5424 severity that PHP's log mirrors to `console.log`, and therefore to
`wrangler tail`. `off | error | warn | log | info | debug`, defaulting to `info`. `debug` is off
because a single render on 8.5 emits several severity-7 deprecation notices with full stack traces.
An unrecognised value is the default rather than an error.

### `MAX_BODY_BYTES`

The largest non-file request body the edge forwards, defaulting to **2 MiB**. Over it, the request is
refused with 413 before any Durable Object hop. It is a heap guard rather than a bandwidth one:
`parse_str()` on a form body allocates inside a 128 MB isolate, and `foo[][][][][]=bar` repeated
turns a few hundred kilobytes of wire into far more of it. `multipart/form-data` is exempt, so file
uploads are unaffected. `0` disables the guard.

### Connecting a Cloudflare Account

Mail needs an account behind it. Either paste `CF_EMAIL_ACCOUNT_ID` and `CF_EMAIL_TOKEN`, or run the
OAuth flow at `/setup/cf`, which issues a short-lived scoped grant that is revocable from the
Cloudflare dashboard. `?action=status`, `?action=connect` and `?action=disconnect` are the three
actions; the callback at `/setup/cf/callback` is the one public part of it.

[`docs/configuration.md`](docs/configuration.md#connecting-a-cloudflare-account) has the whole
contract: the client an operator registers once, the scopes requested, and why the client ID lives in
the site's database rather than in KV.

### Onboarding a Sending Domain

`GET /setup/mail?zone=<zone-id>` reports which step the domain is waiting on, and `?action=apply`
creates the sending subdomain and writes the DNS. Safe to re-run: a settled zone costs zero API
calls, and an existing DMARC record is reported rather than overwritten.

[`docs/configuration.md`](docs/configuration.md#onboarding-a-sending-domain) has the five stages, the
six records written, and what `settled` does and does not mean.

Both routes take the owner token — see [Log In](#log-in).

---

## 🌿 Git Remotes

A site follows as many repositories as you connect to it. A push installs the module; the result is
written back to the provider as a commit status. The page is `/_cfw/git`.

### The Transport

The transport is git's own smart HTTP, so anything that serves a repository over HTTPS works —
GitHub, GitLab, Bitbucket, Gitea, Forgejo, a bare repository behind nginx, an internal mirror. Two
requests do the whole job:

| Step | Request                                      | Cost                                       |
| ---- | -------------------------------------------- | ------------------------------------------ |
| Poll | `GET /info/refs?service=git-upload-pack`     | a few hundred bytes when nothing has moved |
| Pull | `POST /git-upload-pack`, one commit, depth 1 | the changed objects, as a packfile         |

The packfile is read in the Worker: pkt-line framing, both delta forms, and the tree walk that turns
a commit into files. Private repositories authenticate with the operator's access token over HTTPS.
A public repository needs no credential at all.

### What Gets Installed

Module names come from `*.info.yml` rather than from the directory, so a repository checked out under
one name that provides another installs correctly, and a repository holding several extensions
installs all of them at their own paths. Modules land in `modules/custom/`, themes in
`themes/custom/`, profiles in `profiles/custom/`.

Only mountable files are kept — PHP, YAML, Twig, JavaScript, CSS — with `tests/`, `vendor/`,
`node_modules/` and dotfiles dropped. Every file is stored as its own row, and the pull reports what
it skipped and why.

**PHP costs no bundle bytes.** Module source is fetched over the assets binding rather than compiled
into the Worker, so the size ceiling that governs the rest of the runtime does not apply to a custom
module written in PHP.

### Branches, Requests and Diffs

| Action        | What it does                                                                             |
| ------------- | ---------------------------------------------------------------------------------------- |
| Check         | reads the remote head without downloading anything                                       |
| Diff          | fetches the commit and reports added, modified and removed files with line counts        |
| Pull          | applies that diff and mounts the result                                                  |
| Branch switch | moves the site to another branch, deleting what the old one had and the new one does not |
| Requests      | lists open pull and merge requests                                                       |
| Preview       | installs a request's head instead of the branch, and holds it there                      |

A preview is held against polling and against pushes, so a branch that moves while somebody is
reviewing does not replace what they are looking at. Leaving the preview returns the site to its
branch.

### Triggers

**Polling** works against any remote and needs no cooperation from it. The interval is per repository
and defaults to an hour; a poll costs one ref advertisement.

**Webhooks** make a push arrive immediately. GitHub, GitLab, Bitbucket, Gitea and Forgejo can
register one from the page; for anything else the page mints a secret and shows the delivery URL to
register by hand. Every delivery is verified before it is acted on — HMAC-SHA256 where the provider
signs, and a shared secret on GitLab installs older than 19.0. An unverifiable delivery is refused.

### Provider Coverage

| Provider         | State                    | Exercised Against          |
| ---------------- | ------------------------ | -------------------------- |
| GitHub           | verified                 | github.com                 |
| GitLab           | verified                 | GitLab CE                  |
| Gitea            | verified                 | Gitea 1.24.6               |
| Forgejo          | verified                 | Forgejo 13                 |
| Any HTTPS remote | verified                 | `git upload-pack` directly |
| Bitbucket        | supported, not exercised | —                          |

Bitbucket authenticates with one API token and two names: the REST API takes the Atlassian account
email, and git over HTTPS takes the Bitbucket username, which is case sensitive. Both fields are on
the page.

### Safety

A pull is applied in one transaction and then verified by booting the Drupal kernel against the new
tree. If the boot fails, the previous files are restored and the site keeps serving. A path already
owned by another repository or by a `composer require` is reported as a conflict rather than taken.

Access tokens live in the site's own database, never in the KV namespace that carries runtime
overrides. [`docs/configuration.md`](docs/configuration.md#git-remotes) has the scopes each provider
needs and the storage contract.

---

## 📁 Project Structure

```txt
src/
  site.ts            the edge front end: cache tiers, generation counter, deny filter, body cap
  site-do.ts         the Durable Object: PHP lifecycle, render, fill queue, alarms
  env.ts             the vars this worker reads beyond @drupflare/durabledb's own
  runtime/           interpreter plumbing: mount, lazy FS, interrupt mask, gate, binary seam
  db/                codec, the ctx.storage.sql bridge, chunked migration, heap snapshot store
  drupal/            PHP fragments evaluated inside the interpreter
  ops/               cron/GC, sliced database updates, site identity, origin, setup page
  probes/            measurement workers, kept so a report figure can be reproduced
assets/
  core/              the browser-fetchable Drupal tree, served by Workers Assets
  driver.json        the two Drupal modules, packed; this is the copy that executes
  drupal-pf/         the per-file pack PHP materialises from
  drupal-sql/        the 62 migration chunks
  drupal/site.sqlite the installed database the chunks are cut from; the one tracked asset
tests/               unit (in workerd), integration (live Durable Object), e2e
scripts/             packers, benches, and the measurement instruments
experiments/         44 wrangler probe configs, kept for reproduction
docs/                configuration, the source build, repository layout, measurement classes
```

The PHP lives in the sibling repositories, not here: `cfw_do_sqlite` in
[`rom`](https://github.com/drupflare/rom), the capability module in
[`drupflare`](https://github.com/drupflare/drupflare), and the wasm build toolchain in
[`phasm`](https://github.com/drupflare/phasm). See [Repositories](#-repositories).

---

## 🧪 Testing

Three vitest projects. **3,701 tests across 182 files** in the commit gate, plus **1,106 PHP
assertions** and a 72-test end-to-end lane that needs a running server.

| lane                  | command                | count                     | runs in                                        |
| --------------------- | ---------------------- | ------------------------- | ---------------------------------------------- |
| vitest `workers`      | `bun run test:workers` | **2,757** in 127 files    | workerd, via `@cloudflare/vitest-pool-workers` |
| vitest `node`         | `bun run test:node`    | **944** in 55 files       | Node, for oracles workerd cannot host          |
| both, merged coverage | `bun run test`         | **3,701** in 182 files    | one invocation                                 |
| PHP suites            | see below              | **1,106** across 7 suites | real PHP, in the sibling repos                 |
| e2e                   | `bun run test:e2e`     | **72** in 9 files         | needs a running server                         |

The e2e lane talks to real servers rather than mocks: Keycloak for single sign-on, Gitea and Forgejo
for git, GreenMail for SMTP, Redis and a syslog collector for the TCP tier. `docker/compose.yml`
carries all of them pinned by digest, and `tests/e2e/README.md` has the commands.

The PHP suites live in the sibling repositories, which are the authority on their own module. Two
have a script here; all take this repository's `drupal-src/` as `DRUPAL_ROOT`:

| suite                          | repo        | assertions | run from here           |
| ------------------------------ | ----------- | ---------- | ----------------------- |
| `tests/health-suite.php`       | `drupflare` | 644        | `bun run test:health`   |
| `tests/run-driver-suite.php`   | `rom`       | 238        | `bun run test:php`      |
| `tests/load-classes.php`       | `drupflare` | 95         | `php`, with the var     |
| `tests/pdo-shim.php`           | `rom`       | 61         | `php`, with the var     |
| `tests/cfw-tcp.php`            | `drupflare` | 35         | `php`                   |
| `tests/solarium-transport.php` | `drupflare` | 17         | `bun run test:solarium` |
| `tests/run-installer.php`      | `rom`       | 16         | `php`, with the var     |

```sh
DRUPAL_ROOT=$PWD/drupal-src php ../rom/tests/run-installer.php
```

`run-installer.php` drives Drupal's own installer against the driver with core's sqlite driver as a
child-process control. It needs a real filesystem, so it has no counterpart here.

**Re-measure these counts before quoting them.** Every number in this table has been stale at least
once, in both directions.

### Three Vitest Projects

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

`e2e` is the third and is excluded from `bun run test` on purpose: it needs a running worker and, for
most of its specs, a running server to talk to. A commit gate that can be unavailable is not a gate.
It skips when nothing is reachable and fails when `CI` is set, so a lane that quietly stopped running
is distinguishable from one that passed.

Coverage from the two gate projects is merged into one lcov by `bun run test:coverage`; Codecov gets
a `coverage` flag for the merged report and `workers` / `node` flags for per-lane test results,
all with `carryforward: true`.

### The Integration Lane

Specs under `tests/integration/` use `ctx.storage.sql`, `transactionSync()`, `setAlarm()` and
`caches.default`. A mock of any of those would be testing the mock, and `runInDurableObject` from
`cloudflare:test` gives the real thing without a manually started server.

### Testing Inside workerd

Every one of these has already produced a defect that a Node-hosted mock passed:

- `ctx.storage.sql` is synchronous only from inside a Durable Object.
- `transactionSync()` has no Node equivalent; `BEGIN` as SQL is refused outright.
- The host caps a statement at **100 bound parameters**; local PDO allows 32,766. That gap
  hid a live cache-write defect behind a green suite.
- In-PHP `microtime()` and JS `Date.now()` both return **0** on the edge.

### Coverage

Coverage uses `provider: 'istanbul'`, not `v8`. The v8 provider reads coverage off the Node
inspector and these tests run inside workerd's isolate, so it instruments every statement and
attributes none of them while the suite passes. istanbul instruments at transform time, so it travels
into the isolate with the code.

The sibling repos split on the same axis: `earth-app/cloud` and `js/edgeport` are workerd and use
istanbul; `earth-app/crust` and `earth-app/sky` are happy-dom and use v8.

Thresholds sit just under the current measured figure and are ratcheted upward as coverage lands.
An aspirational number here would be a failing check everyone learns to ignore.

### Rules for a New Test

Assert on behaviour or a counter, never on timing, except where timing _is_ the claim. Name which
cache bins were emptied for every render figure. **An absolute CPU number comes only from a deployed
worker** — nothing in `tests/` can produce one. `docs/measurement-classes.md` is the full rule: which
instrument may produce which class of number, and which class is banned outright.

---

## 📦 Repositories

This started as one repository and is split, so each piece is usable on its own.

| repo                    | what it is                                                                      | install                                |
| ----------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| **`worker`** (this one) | the Worker: cache tiers, the Durable Object, the packers                        | clone                                  |
| **`drangler`**          | the CLI: stand a site up, check it, migrate one on or off                       | `bun add -g @drupflare/drangler`       |
| **`drupflare`**         | the capability module -- mail, fetch, images and KV bridged to Workers bindings | `composer require drupflare/drupflare` |
| **`rom`**               | `cfw_do_sqlite`, the Drupal database driver for Durable Object SQLite           | `composer require drupflare/rom`       |
| **`stream-http`**       | the `https://` stream wrapper `drupflare` extends                               | pulled in by `drupflare/drupflare`     |
| **`phasm`**             | the PHP-to-WebAssembly build toolchain                                          | GitHub Releases                        |
| **`cartridge`**         | the pack format, the lazy filesystem and the zstd inflate seam                  | `@drupflare/cartridge`                 |
| **`durabledb`**         | the `ctx.storage.sql` bridge and its codec                                      | `@drupflare/durabledb`                 |

### How the PHP Reaches the Edge

**A `composer require` ships nothing.** Composer does not run on the edge, so the packed tree is the
vendor directory. `bun run assets:driver` reads the sibling checkouts directly and writes
`assets/driver.json`, which the Durable Object mounts into its in-memory filesystem; that packed copy
is what executes. `composer.json` records provenance and lets a developer resolve the packages
normally, and both are on Packagist as `drupflare/rom` and `drupflare/drupflare`.

The packer resolves each sibling as `DRUPFLARE_SRC` / `ROM_SRC` / `STREAM_HTTP_SRC`, then
`../<name>`, then `.siblings/<name>`, and takes an allow-list of module-shaped paths (`src`,
`.info.yml`, `.install`, `.module`, `.services.yml`) — a module repository is not a module, and
walking a checkout wholesale would pull `node_modules/` and `vendor/` into the bundle.

**Run `bun run assets:driver` after any change in a sibling.** `tests/node/driver-pack.spec.ts`
rebuilds the pack from the modules on disk and compares it to `assets/driver.json` byte for byte, so
a stale pack fails the gate.

## 🧩 Contrib Modules

Installing a module works on a deployed site, measured at **6,810 ms** of Durable Object CPU with
the module present in `core.extension` afterwards on 6 of 6 attempts. The cache is cold for one
visit while the pages the install invalidated are re-rendered.

<!-- module-table:begin -->

**58 verified, 1 untested, 3 blocked.** Verified means the gate enabled the module and asserted an observable it owns, and it is the only state that is a support claim. Untested means nobody has enabled it here: the evidence column says what the capability analysis concluded, which is an inference about the runtime rather than an observation about the module.

Contrib modules are development dependencies here, verified against the test build and not shipped. The pack carries 4 (Admin Toolbar, Ctools, Pathauto, Token); the other 54 verified rows are tested that way and marked, so a site stays small and adds only what it asks for.

| Module                     | State    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Address                    | verified | enabled against a real site; the `address`, `address_country` and `address_zone` field types are registered and `address.country_repository`, `address.address_format_repository` and `address.subdivision_repository` resolve. None of the three is in the container beforehand. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Admin Toolbar              | verified | enabled against a real site in the workers lane; its own routes appear in the `router` table after the install-triggered rebuild                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Backup Migrate             | verified | enabled against a real site; it installed four config entity types and six default source and destination entities -- `default_db`, `entire_site`, the two file destinations and a daily schedule -- and 24 routes. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Better Exposed Filters     | verified | enabled against a real site; its three widget plugin managers and `better_exposed_filters.bef_helper` are in the container afterwards and absent before. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Captcha                    | verified | enabled against a real site; its schema hook created `captcha_sessions` and 8 routes appear in the `router` table. Its routes are named with underscores, so a dotted module-prefix match finds none of them. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Coffee                     | verified | enabled against a real site; `coffee.url_generator` resolves and `coffee.configuration` is installed, which is the config its command palette reads. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Colorbox                   | verified | enabled against a real site; `colorbox.settings` is installed and its admin route is in the `router` table. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Config Ignore              | verified | enabled against a real site; `config_ignore.settings` is installed and its admin route is in the `router` table. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Crop                       | verified | enabled against a real site; it created the crop entity type as four tables -- `crop`, `crop_field_data`, `crop_revision`, `crop_field_revision` -- and installed `crop_type` as a config entity type. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Csv Serialization          | verified | enabled against a real site; `serializer->supportsEncoding('csv')` is true afterwards and false before, with `json` true throughout as the control that the serializer is answering at all. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Ctools                     | verified | enabled against a real site in the workers lane; `core.extension` grew and the site still saved content afterwards. A library module with no user-visible behaviour of its own, so this is the strongest observable it has                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Devel                      | verified | enabled against a real site; `devel.dumper` and `plugin.manager.devel_dumper` resolve, its route and error subscribers are in the container, and it installs its own menu. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Easy Breadcrumb            | verified | enabled against a real site; `easy_breadcrumb.settings` is installed and its admin route is in the `router` table. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Editor Advanced Link       | verified | enabled against a real site; the `editor_advanced_link_link` CKEditor 5 plugin is registered and its two asset libraries resolve. Library discovery needs `common.inc` loaded first -- `JS_LIBRARY` and `CSS_COMPONENT` are defined there, not by the autoloader. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Entity                     | verified | enabled against a real site; `entity.bundle_plugin_installer`, `entity.bundle_entity_duplicator` and `access_checker.entity_revision` resolve afterwards and are absent before. A substring match on its name is NOT evidence here: most of what matches `entity` in the container is core. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Entity Browser             | verified | enabled against a real site; the `entity_browser` config entity type is installed and six of its routes are in the `router` table. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Entity Reference Revisions | verified | enabled against a real site; the `entity_reference_revisions` field type and its `entity_reference_revisions_entity_view` formatter are registered, and `entity_reference_revisions.orphan_purger` is in the container. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Externalauth               | verified | enabled against a real site; its schema hook created `authmap`, which is the table the identity mapping lives in. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Facets                     | verified | enabled against a real site; all five of its plugin managers resolve. It creates no table and ships no config, so the container IS the observable. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Field Group                | verified | enabled against a real site; it creates no table and ships no settings, so what was asserted is what it adds to the CONTAINER -- `plugin.manager.field_group.formatters`, `field_group.subscriber` and `field_group.param_converter` all resolve after the install, with a core service as the control. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Filefield Sources          | verified | enabled against a real site; `plugin.manager.filefield_sources`, its field access check and its own service all resolve. Ships no stable release, so this is the 2.0 development branch and the row says so. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Focal Point                | verified | enabled against a real site; `focal_point.settings` is installed and it created the `crop.type.focal_point` crop type inside the dependency it pulled in. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Google Analytics           | verified | enabled against a real site; `google_analytics.visibility`, `.accounts` and `.javascript_cache` resolve and `google_analytics.settings` is installed. The tag it emits is client-side, so nothing outbound is involved. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Google Tag                 | verified | enabled against a real site; the `google_tag_container` config entity type and `google_tag.settings` are installed, with eight routes. Nothing outbound happens in PHP -- the snippet it injects is called by the browser. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Honeypot                   | verified | enabled against a real site; its schema hook created `honeypot_user`. The recommended default over any captcha here, because a hidden field and a submission timer are entirely local and cost no outbound round trip. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Imageapi Optimize          | verified | enabled against a real site; its processor plugin manager resolves, `imageapi_optimize.settings` is installed and the pipeline config entity type is registered. The BINARY pipelines shell out and cannot run here; the pipeline plugin point is what was verified. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Imce                       | verified | enabled against a real site; the `imce_profile` config entity type and both shipped profiles -- `admin` and `member` -- are installed, with nine routes. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Jquery Ui                  | verified | enabled against a real site; 24 asset libraries resolve for it afterwards and none before, `core` and `widget` among them. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Jquery Ui Autocomplete     | verified | enabled against a real site; the `autocomplete` library resolves for it afterwards and none before. It ships no code of its own -- jquery_ui declares the library on its behalf, so the library existing IS the module working. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Jquery Ui Datepicker       | verified | enabled against a real site; the `datepicker` library resolves for it afterwards and none before. Four files on disk and no PHP, so its library is the only observable it has. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Jquery Ui Menu             | verified | enabled against a real site; the `menu` library resolves for it afterwards and none before. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Json Field                 | verified | enabled against a real site; it registers the `json` field type with core's field-type manager and its `json_field.views` service resolves. Its normalizer is a TAGGED service, which the compiler folds into the serializer and removes from the public map, so asking the container for it by id fails on a module that installed correctly. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Key                        | verified | enabled against a real site; its repository and three plugin managers resolve and the `key` config entity type is registered. A key PROVIDER that reads a file or an external service is a separate question. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Libraries                  | verified | enabled against a real site; `libraries.settings` is installed, which is where its external library definitions are read from. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Linkit                     | verified | enabled against a real site; its matcher and substitution managers resolve alongside the suggestion manager, and `linkit_profile` is registered. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Mailsystem                 | verified | enabled against a real site; `mailsystem.settings` is installed and its admin route is in the `router` table. It is how a site selects `cfw_mail`, so it is the module a site drops smtp in favour of. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Menu Block                 | verified | enabled against a real site; `menu_block:main` and `menu_block:footer` are block plugin derivatives it provides. `access_check.admin_menu_block_page` reads as its service and is CORE's -- the before reading is what said so. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Metatag                    | verified | enabled against a real site; it installed 8 config objects of its own, so it has defaults to apply rather than enabling inert the way pathauto does. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Migrate Plus               | verified | enabled against a real site; both config entity types it exists to provide are installed -- `migration.entity_type` and `migration_group.entity_type`. It ships no config OBJECTS, so a `migrate_plus.%` config probe finds nothing and would read as inert. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Module Filter              | verified | enabled against a real site; `module_filter.settings` is installed and its admin route is in the `router` table. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Openid Connect             | blocked  | drupal/openid_connect needs an outbound call to answer INSIDE one render, and this runtime cannot suspend mid-run to wait for a socket **Lift:** the MODULE stays refused and the CAPABILITY is covered instead, 2026-08-24. JSPI would not lift it either: `WITH_OPENSSL=0`, so PHP cannot verify an RS256 `id_token` even if handed one synchronously, and an unverified `id_token` is an unauthenticated login. `src/ops/oidc.ts` completes the exchange at a route the host owns, verifies the signature with `crypto.subtle`, and hands PHP a single-use claims ticket; `Drupal\drupflare\Network\CfwOidc` maps it onto `drupal/externalauth`, which is itself `verified`. So a site gets provider login without this module. The round trip is exercised against a real Keycloak, including the refusal of a token the provider genuinely signed for another of its clients; the setup page is live and states the `externalauth` dependency                                                                                             |
| Paragraphs                 | verified | enabled against a real site; it created its entity type as four tables -- `paragraphs_item`, `paragraphs_item_field_data`, `paragraphs_item_revision`, `paragraphs_item_revision_field_data`. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Pathauto                   | verified | enabled against a real site, given the pattern the shipped database does not carry; a node saved as "Pathauto Probe Title" produced the `path_alias` row `/node/1 -> /probe/pathauto-probe-title`. Pointed at `canonical_entities:user` the same run writes no row, so the assertion tracks this pattern rather than an ambient alias                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Purge                      | verified | enabled against a real site; `purge.queue`, `purge.processors`, `purge.purgers` and the invalidation factory all resolve. What it would PURGE is this host, which already invalidates from cache tags. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Queue Ui                   | verified | enabled against a real site; its admin routes are in the `router` table, and routes are the whole module. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Recaptcha                  | verified | enabled against a real site; captcha came with it, so dependency resolution ran, and it installed its own configuration. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Redirect                   | verified | enabled against a real site; the `redirect` table exists and 11 of its routes are in the `router` table, so both halves of a route subscriber over its own table are present. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Redis                      | blocked  | drupal/redis needs an outbound call to answer INSIDE one render, and this runtime cannot suspend mid-run to wait for a socket **Lift:** none needed for the cache: the Durable Object's own SQLite IS the backend, so this is a dependency the architecture removes. `Drupal\drupflare\Network\CfwTcp` covers the rest of what a site would reach Redis for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Scheduler                  | verified | enabled against a real site; it installed its own configuration and its routes are in the `router` table. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Search Api                 | verified | enabled against a real site; it created `search_api_item` and `search_api_task`, which is where the database backend writes, and its index routes are in the `router` table. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Search Api Solr            | untested | Its transport is not the blocker. Measured 2026-08-24 by installing it: it pulls `maennchen/zipstream-php`, which declares `php-64bit`, so composer emits a `platform_check.php` asserting `PHP_INT_SIZE === 8`. That check used to abort every request before Drupal booted, taking all 56 other contrib cases with it; the shipping build is 64-bit as of 2026-08-25 and it now passes. With `platform-check: false` the module installs clean and 57/57 pass: `plugin.manager.search_api_solr.connector`, `solarium.query_helper` and its four solr config entity types all resolve, none of them before. The transport was measured separately against solarium 6.4.2 and is interceptable: the default connector picks `extension_loaded('curl') ? new Curl() : new Http()`, this build has no curl, so it lands on the stream adapter, and `SolariumTransport` short-circuits that through Solarium's own `PreExecuteRequest` with no module change                                                                                      |
| Simple Sitemap             | verified | enabled against a real site; `simple_sitemap.generator`, `simple_sitemap.queue_worker` and `simple_sitemap.sitemap_writer` resolve, both `simple_sitemap` and `simple_sitemap_type` are registered entity types and `simple_sitemap.settings` is installed, none of it before. It was refused outright until the host supplied a pure-PHP `XMLWriter` and cleared its one install block through `hook_requirements_alter()` -- `extension_loaded('xmlwriter')` is a built-in and cannot be shimmed. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                    |
| Smtp                       | blocked  | drupal/smtp needs an outbound call to answer INSIDE one render, and this runtime cannot suspend mid-run to wait for a socket **Lift:** the replacement ships and IS now selected: `system.mail` is forced to `cfw_mail` in the settings override, so a site that drops smtp gets a working mailer rather than `php_mail`, which this runtime cannot run. AND ITS CONFIGURATION IS NOW READ, 2026-08-24: the module installs here and its socket never runs, so a site that filled in its relay and saved had a complete SMTP configuration nothing looked at, and its operator had to type the same host, port and password again as Worker vars. `CfwMail` passes `smtp.settings` to `cfwMail`, `mailEnvFromSite()` maps it onto the transport vars and the deployment's own vars still win. The settings are persisted to `cfw_meta` because the ALARM re-resolves the transport and never sees the message. So the module stays blocked -- the socket is what refuses it -- while both the capability and now the configuration are covered |
| Stage File Proxy           | verified | enabled against a real site; `stage_file_proxy.settings` is installed, which is what its fetch path reads. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Svg Image                  | verified | enabled against a real site; the `image` field formatter is `Drupal\svg_image\...\SvgImageFormatter` afterwards and core's `ImageFormatter` before, and the `image_image` widget moves the same way. It takes core's plugin ids over rather than adding its own. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Token                      | verified | enabled against a real site; `[random:hash:md5]` resolves to 32 hex digits, and it is declared by `token.tokens.inc` and by nothing in core -- with `ctools` enabled in its place the same call returns the literal. Controls both ways: `[nosuchtype:nosuchtoken]` comes back untouched, and core's `[site:name]` still answers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Twig Tweak                 | verified | enabled against a real site; its twig extension and four view builders resolve, which is the whole of what it adds. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Video Embed Field          | verified | enabled against a real site; the `video_embed_field` field type, its `video_embed_field_video` formatter and `video_embed_field.provider_manager` are all present afterwards and absent before. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Views Bulk Operations      | verified | enabled against a real site; `views_bulk_operations.processor`, `views_bulk_operations.data` and its action plugin manager resolve, the `views_bulk_operations_delete_entity` action is registered, and four of its routes are in the `router` table. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Views Data Export          | verified | enabled against a real site; the `data_export` views display and style plugins are registered, which is the whole module. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Webform                    | verified | enabled against a real site; four of its plugin managers resolve, the `webform` table exists and its shipped option sets are installed. Submissions are ordinary form POSTs. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Xmlsitemap                 | verified | enabled against a real site; `xmlsitemap_generator` and `xmlsitemap.link_storage` resolve, the `xmlsitemap` table exists and its settings are installed. Required as a dev dependency and verified against the test build rather than shipped, so a site does not carry it unless it asks for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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
- **Integers above 2^53** are read back through a second, casting query. The cursor returns doubles, so the driver detects a value a double cannot hold and re-reads that statement with the affected columns cast to text.
- **A 64-bit integer does not survive a JSON round trip.** `PHP_INT_SIZE` is 8 and `PHP_INT_MAX` is
  9,223,372,036,854,775,807, but a JSON number is a double, so a value above 2^53 handed across the
  host boundary comes back rounded. Cast it to a string first. The database path already does this.
- **The interpreter loads 25 extensions**: Core, PDO, Reflection, SPL, SimpleXML, Zend OPcache,
  ctype, date, dom, filter, hash, json, lexbor, libxml, pcre, pib, random, session, standard,
  tokenizer, uri, vrzno, xml, yaml and zlib. OPcache is loaded and disabled by default; see
  `OPCACHE_MODE` in the configuration reference. `mbstring` and `iconv` are supplied by Symfony's
  polyfills, which diverge from the real extensions on 37 of 1,232 measured cases and on none of the cases Drupal core reaches. There is no `gd` and no
  `pdo_sqlite`. `/php` reports the live list.
- **`curl_*` works without `ext-curl`.** The functions are supplied over the same deferred-HTTP
  queue as the rest of outbound traffic, so an SDK that bundles its own curl transport runs
  unmodified. `curl_version()` reports `0.0.0-drupflare-shim`, and an option the shim does not
  understand is refused rather than ignored.
- **Passwords hash with bcrypt by default, and argon2id is available.** `ARGON2=1` switches the
  password service to argon2id at m=19456 KiB, t=2, p=1, computed on the host rather than in PHP.
  Existing bcrypt hashes keep working and are upgraded at each account's next login. Hashes are
  written in PHP's own encoded form, so they verify on any PHP with `ext-argon2`.
- **Image styles are applied at delivery, not by rewriting files.** Without `gd` there is no image
  toolkit that produces derivatives, so Cloudflare Images resizes from the URL. A module that reads
  a derivative's own pixels sees the full-size image.
- **Outbound HTTP is answered from cache or refused.** A Worker cannot open a socket synchronously,
  so `Drupal::httpClient()` and `file_get_contents('https://...')` return a previous fetch's
  response, or fail while queueing the request for the next background drain. The call after it
  succeeds. Request headers are carried across the queue and are part of the cache key, except
  `User-Agent`, which is sent but not keyed.
- **Outbound TCP is declared, not opened.** Redis and syslog are reachable through
  `Drupal\drupflare\Network\CfwTcp`, which describes a whole exchange and reads the answer on a
  later request over the same queue. The endpoint and its credentials come from `REDIS_URL` and
  `SYSLOG_URL` rather than from the calling code, and administrative Redis commands are refused. A
  Redis cache backend is not possible on this: a cache read has to answer inside the request that
  asked it. The Durable Object's own SQLite is the cache backend.
- **Greek word-final sigma lowercases differently** from native PHP, and `mb_strwidth`
  under-counts emoji. Neither affects Drupal core.
- **Uncached traffic does not scale.** One site is one Durable Object is one thread, and you
  cannot buy a bigger one. Content sites win decisively; high-write authenticated sites do
  not.
- **A module install leaves the object with no room to do anything else.** It costs 6,810 ms of CPU
  — the installer is 1,570 ms of that and the kernel boot 3,101 ms — and ends with the wasm heap at
  ~110 MB of the isolate's 128 MB. `memory.grow` has no inverse, so the heap never shrinks; a
  further growth is served at a smaller step rather than refused. The install queues the pages it
  invalidated instead
  of re-rendering them, and the cache is cold for one visit. Restoring a heap snapshot instead of
  booting removes 2,310–3,578 ms of that (n=8 per arm, present in both modes of a bimodal
  population). It is **on by default**; each site pays 31,784,960 bytes across 159 rows for the
  image, and `HEAP_SNAPSHOT=0` turns it off.
- **A freshly deployed site is claimable until it is provisioned.** `/firstrun` answers without a
  credential while the site has never been configured, because the owner token that `/export` takes
  is minted by that route and nowhere else — gating it would mean the only way to get your data out
  was to expose `/sql`, `/restore` and `/php` first. The window is the unprovisioned state only:
  once configured the route answers 409, and reconfiguring needs the token. Same model as Drupal's
  own `install.php`. The window is signposted rather than silent: an unclaimed site answers a
  browser navigation with the claim page instead of its front page, so the owner is told to close it
  on the first visit. Claim the site as the first thing you do after deploying.

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
bun run test # 2,474 across the workers and node lanes
bunx prettier --check .

bun run test:e2e # excluded from the gate; needs a running server
```

Run `bun run assets:driver` after any change in `../drupflare`, `../rom` or `../stream-http` —
composer never runs on the edge, so `assets/driver.json` is the copy that actually executes, and
`tests/node/driver-pack.spec.ts` is what catches it going stale. The PHP suites live in those repos
and are the authority on their own module.

## 📄 License

See [LICENSE](LICENSE).
