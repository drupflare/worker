# WordPress

WordPress 7.1.4 runs the same way Drupal does: PHP 8.5 as WebAssembly inside a Durable Object, with the object's own SQLite as the database. This page says what runs, how it differs from Drupal, and every figure read so far with its n, plan and date. A figure labelled `measured` came off an instrument; `derived` is arithmetic over measured inputs and assumed weights.

## What Runs

A WordPress site answers its front page, `/wp-admin/`, login, the REST API, `admin-ajax.php` and cron from the object, with `wpdb` ending at `ctx.storage.sql`. The build selects it with `CMS=wordpress`; see [Site Identity](../configuration/site-identity.md#cms).

| piece              | what it is                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| database seam      | a `wpdb` subclass shipped as `wp-content/db.php`; a MySQL-to-SQLite translator written in TypeScript runs on the host                                           |
| pack               | WordPress core and its bundled themes in one read-only pack, a database baked by WordPress's own installer, and seven shim classes for outbound HTTP and images |
| browser files      | published through Workers Assets from `assets/wordpress-site/`; see [Static Assets](../configuration/serving/static-assets.md#wordpress-assets)                 |
| plugins and themes | delivered by the host from a pinned registry; see [WordPress Packages](../configuration/operations/wordpress-packages.md)                                       |
| page cache         | on by default; see [Page Cache](../configuration/serving/page-cache.md#wordpress_page_cache)                                                                    |

Build and run one locally:

```bash
bun run fetch:wordpress
bun run assets:wordpress
bun run dev:wordpress
```

WordPress Multisite is refused by name. The behaviour that differs from stock WordPress is on [Limitations](limitations.md): outbound requests, mail, the object cache and cron.

## Differences From Drupal

|                    | Drupal                                                  | WordPress                                                                                   |
| ------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| database           | `cfw_do_sqlite` driver replaces Drupal's database layer | `wpdb` subclass plus a host-side translator                                                 |
| interpreter        | stays resident between requests on a warm object        | dropped after every render; WordPress cannot serve a second request in the same interpreter |
| render shape       | a warm render reassembles from cache bins               | no bins, so every fill is a full render                                                     |
| module delivery    | `/install`, `/modify`, git remotes                      | `/wp-packages` with receipts, one transaction each                                          |
| discovery document | published                                               | answers 404, the format has no kind for WordPress                                           |
| pack blob          | 12.41 MiB                                               | 7.07 MiB                                                                                    |

## Measurements

Each row is one instrument on one plan. Do not set a Drupal figure against a WordPress one unless the instrument and the plan match.

| quantity                                                         | figure                                                                                                                            | n and spread                                        | plan, date               | label      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------ | ---------- |
| statements translated against pinned MySQL                       | 2,372 of 2,372                                                                                                                    | 2,372                                               | local, 2026-11-18        | `measured` |
| differential against the upstream SQLite plugin and native MySQL | 0 unexplained differences                                                                                                         | 1,849 statements                                    | local, 2026-11-22        | `measured` |
| slug lookup on a 20,000-post model                               | 3 rows read, was 11,002                                                                                                           | fixed-seed model                                    | local, 2026-11-22        | `measured` |
| uncached front page, object CPU                                  | about 1.0 to 2.0 s; the two runs differ by 2x and the cause is unknown                                                            | two runs, n=10 and n=5                              | student free, 2026-11-18 | `measured` |
| uncached front page, wall                                        | 1.1 to 2.3 s; run one p50 2,250 ms, min 1,830, max 3,061                                                                          | n=10 in run one                                     | student free, 2026-11-18 | `measured` |
| cached hit, object CPU                                           | 0 ms; wall median 4 ms                                                                                                            | n=9                                                 | student free, 2026-11-18 | `measured` |
| fill wall by route                                               | home 2,517, post 3,481, page 2,187, category 2,324, feed 1,956 ms                                                                 | one fill per route                                  | paid, 2026-11-23         | `measured` |
| cached hit wall by route, p50                                    | home 11, post 4, page 78, category 4, feed 3 ms                                                                                   | n=10 per route                                      | paid, 2026-11-23         | `measured` |
| rows written per fill                                            | median 15, range 5 to 124; a publish wrote 55                                                                                     | one fill per route                                  | paid, 2026-11-23         | `measured` |
| `cpuTime` p50 by route                                           | front 1,715, login form 1,083, login POST 3,106, admin 1,791, new post 2,214, REST posts 1,124, cron 1,276, media upload 1,533 ms | n=3 per route                                       | paid, 2026-11-23         | `measured` |
| free regeneration ceiling                                        | 45,138 renders a day, bound by duration; rows would allow 89,104                                                                  | assumed weights, 2.25 s a fill from one run of n=10 | model, free              | `derived`  |
| free serving ceiling                                             | 100,000 requests a day, bound by Worker requests                                                                                  | model                                               | model, free              | `derived`  |

The uncached render sits at Drupal's cold-bins order (2,127 ms, `measured`, n=10) and not at its warm render (38 to 60 ms). The local wall time of a render is 0.47 to 0.6 s, so a deployed render takes 2.3 to 10.9 times as long, and the cause is not found. Reproduce the two ceilings with `bun scripts/measure/free-envelope.ts`; the 2.25 s is an input taken from a deployed run, not a result of the model.

### Memory

The route census drives twelve stock WordPress routes on a deployed paid worker with the memory governor at its default.

| reading                       | figure                                          | n and spread                                     | plan, date       | label      |
| ----------------------------- | ----------------------------------------------- | ------------------------------------------------ | ---------------- | ---------- |
| interpreter linear memory     | 64.0 MiB on every route; cron 64.7 MiB          | 34 drives, n=3 per route (plugin activation n=1) | paid, 2026-11-23 | `measured` |
| platform meter, per route p50 | 109.9 to 134.8 MiB; plugin activation 149.8 MiB | same                                             | paid, 2026-11-23 | `measured` |
| refusals and resets           | none; no incarnation changed                    | same                                             | paid, 2026-11-23 | `measured` |

An earlier census (12 routes, n=5, 2026-11-22, paid) read the interpreter at 69 to 91 MiB and the meter at up to 200.7 MiB on the single-post route, 2.3 MiB under the 203 MiB kill line. It ran on an earlier build, and shared minute rows can inflate a meter reading. The later table is the current build's. The WordPress interpreter is dropped after every render, so its linear figure is per render. The growth governor has no WordPress reading; see [Runtime](../configuration/runtime.md).

## Page Cache

The page cache stores an anonymous page and replays it without starting WordPress. An authenticated response never enters it. It was checked by soak and by a write-to-fresh contract.

| check                                                                        | result                                                                                              | n            | environment, date | label      |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------ | ----------------- | ---------- |
| two soaks of 4,400 operations                                                | no stale content after a purge; clean restart arm in both                                           | 2 soaks      | local, 2026-11-22 | `measured` |
| one stale `/feed/` answer from the edge                                      | did not recur; unexplained                                                                          | 1 answer     | local, 2026-11-22 | `measured` |
| soak of 1,500 operations, final code                                         | publish median 1.2 s, max 2.3 s; edit max 1.7 s; trash 1.7 s; option change median 5.4 s, max 9.7 s | one run      | local, 2026-11-22 | `measured` |
| six-route publish until fresh, with the 25 ms yield and visitor quiet window | 3.7 to 5.6 s, median 4.5 s, down from a median of 29.3 s                                            | n=10 and n=6 | local, 2026-11-22 | `measured` |
| publish until fresh, deployed                                                | 13.9, 15.3 and 21.1 s in the soak that finished; other readings of 22 to 55 s are unexplained       | a few runs   | paid, 2026-11-23  | `measured` |

The contract is one second per route a write names plus two seconds: 8 s for a publish, 6 s for an edit. The local soak meets it. The deployed readings do not, because a deployed render takes about 2.3 s and the object renders one page at a time, so six routes need about 14 s. A publish purges 19 of 20 stored rows even with neighbour tagging. After a wholesale purge the first visitor of each page waits for one render, 2 to 3.5 s deployed; `AGED_SERVE_MAX_MS` brings the old copy back.

## Free Plan

The free plan runs WordPress. Two deployed runs on a student free account answered the front page, login, admin and REST routes, and a cached hit cost the object no CPU. The 10 ms CPU cap does not fail a Durable Object invocation, and an uncached render of 1 to 2 s completed in both runs. Two limits shape the plan:

- Regeneration is bound by duration at about 45,138 renders a day, against 50,916 for Drupal, which is bound by rows. Both are `derived`.
- `COLD_PACK` is off for WordPress on free, because every WordPress request mounts a fresh interpreter and a staged pack adds 147 to 281 row reads to each one. See [Runtime](../configuration/runtime.md).

A deployed cached run on a free account has not been read, so the render fraction that prices the page store is not known for WordPress.

## Plugins and Themes

The registry in `config/wp-plugins.yml` holds one plugin, Classic Editor, at 1.6.7 and 1.7.0. In a local `wrangler dev` run it was installed at 1.7.0, activated in a browser, updated to 1.6.7 and rolled back (n=1). Thirty-five ZIP rule cases refuse hostile archives. No set of real sites or plugins has been run, so this page makes no claim about which plugins work. A plugin that calls `curl_*` directly, or one that sends a statement the translator refuses, will fail; Action Scheduler's claim statement is one that is refused today.

## Joomla

Joomla has local proofs and no running site. Its installer SQL (147 statements) runs through the translator after five bake-time rewrites, with data equal to native MySQL in all 76 tables. A running site is blocked by the SQL Joomla sends at runtime: nested-set writes send `LOCK TABLES`, and the translator refuses `LOCK TABLES`, `START TRANSACTION` and `SAVEPOINT`. 13 of 50 statements in its update scripts are refused today. No Joomla request or memory reading exists.

## Not Yet Read

- A deployed cached run on a free account, and the render fraction it gives.
- Deployed publish-to-fresh over a full soak.
- WordPress under the memory governor.
- Energy for a WordPress view, and a VPS comparison.
- A WordPress codebase or plugin corpus run.
