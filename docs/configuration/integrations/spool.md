# Spool

[Spool](https://github.com/drupflare/spool) is the client-side replica. The front worker runs its
proxy in front of the page pipeline, so a visitor's browser can keep a public page and show it again
without asking the site, until a change makes that copy wrong. It works the same for every CMS the
worker serves, and it only ever touches public traffic.

Spool is on by default on every plan, and `SPOOL=0` turns it off. Its own files and requests stay off
the Worker meter: the worker script and the page scripts are static assets, the script's one-day
lease answers its update checks without a request, and a page view sends no beacon. A device still
sends the Worker one request for each page it has not held yet, and none for a page it holds. The
first two views are ordinary documents. After that, the device's worker fetches each new page itself,
which is the request the browser would have made without spool, and keeps the copy. On a local rig
with a demo site of nine pages, a device that made 1, 2, 3, 5, 10, 20 and 100 views sent the Worker
1, 2, 3, 4, 7, 11 and 11 requests, against 1, 2, 3, 5, 10, 20 and 100 with spool off (measured, rig
browser counts, n=1 per cell, no spread). A sync rides on a navigation the device makes anyway.
[Avoidances](#avoidances) lists each avoidance. The levers are on `KV_OVERRIDABLE`, so `PUT /settings`
and the `settings` document set them, and Drupal's settings form cannot: its submit reports them
under `refused`.

## What Is Replicated

A request goes through spool only when it is a `GET` or `HEAD` with no cookie and no `Authorization`
header. Any cookie counts, including a WordPress comment author cookie and `wordpress_test_cookie`:
the saving on those visitors is small and a wrong copy would show one visitor another's page. A
signed-in request, a write, an owner or diagnostic route and the object's own `__` paths are never
touched. The library refuses a cookie or credential request as well, so two checks stand behind that
rule.

What else a CMS keeps out is one table, `SPOOL_CMS_RULES` in `src/ops/spool.ts`, and the response
side of it in `src/site/spool.ts`:

| CMS       | Kept out by path                                                                                                                                                       | Kept out by response                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Drupal    | nothing beyond the shared rule                                                                                                                                         | the library's own checks                                                                                  |
| WordPress | `/wp-admin` (so `admin-ajax.php`), `/wp-login.php`, `/wp-json`, `/wp-cron.php`, `/xmlrpc.php`, feeds, previews, search, and any path the page store's key rule refuses | a page the WordPress store rule refuses (a nonce, a search body, an unfinished body), and a password form |
| Joomla    | `/administrator` and `/api`                                                                                                                                            | none yet                                                                                                  |

A page is replicated only where the object's page store holds that CMS's pages, because the store's
index is how a purge names the pages a device holds. For WordPress that means `WORDPRESS_PAGE_CACHE`
is not `0`; with it `0` no WordPress page is decorated, and the media features and spool's own paths
still run. Joomla's store is off, so no Joomla page is replicated.

A WordPress page the rule refuses reaches the visitor exactly as the CMS sent it, with its own
`Cache-Control`. The front worker marks it `private` for the length of the library call, so the
library neither decorates it nor keeps a copy, and puts the original header back before the visitor
sees it. The same call tells a device that holds an older copy of that path to drop it.

## What The Worker Serves

- An anonymous `GET` or `HEAD` answered `200` with HTML gets spool's client tag and envelope headers.
  The tag is the library's inline gate: it counts views and loads the page script from the second view.
  This runs after every cache tier, so no stored or cached page is the decorated one.
- `/spool-sw.js` and `/.spool/<version>/client.js` and `navigate.js` are static assets (below). The
  Worker answers the same bytes if the asset tier does not hold the file.
- `/.spool/sync`, `/.spool/artifact` and `/.spool/beacon` are answered in the front worker by the
  library. Those paths are reserved, so no redirect rule captures them. Each address may make 120
  requests a minute to spool's paths and an isolate takes 3,000, counted in memory; past either limit
  the answer is `429`. A beacon becomes one `cfw-spool` line in Workers observability, bounded in size
  and count, and writes no row.
- The object keeps a version vector in memory, a map from tag to the cursor of its last change, and
  answers a sync from it on the internal `/__spool` route. A cursor is the generation times 4,096 plus
  a count inside it. A sync costs one Durable Object request. Decorating a page costs none, because
  the generation rides on the page response, and the worker script costs none, because it holds no
  pack and does not depend on the vector.

## Static Tier

The worker script and the two page scripts of the installed library are files in `assets/`:
`spool-sw.js` and `.spool/<version>/client.js` and `navigate.js`. Workers Assets answers a request for
a file before the Worker runs, and `wrangler.jsonc` sets no `run_worker_first`, so these requests are
not Worker invocations. Paths under `/.spool/` that are not files, the data endpoints, still reach the
Worker.

`bun scripts/pack/spool.ts` writes the files, taking each one from the worker's own spool handler, so
the bytes are what a device would get from the Worker. `bun scripts/pack/spool.ts --check` exits 1
when a file on disk differs, and the integration spec for spool fails the gate on the same
difference. Run the packer after any change to the library version or to the spool options in
`src/site/spool.ts`. The packer removes the page scripts of any other library version.

`assets/_headers` carries the library's two rules: `/.spool/*` is `public, max-age=31536000,
immutable`, and `/spool-sw.js` is `max-age=86400` with `Service-Worker-Allowed: /`. The one-day
`max-age` is the lease: it is what lets Chromium and Firefox skip the update check on a controlled
navigation. `assets/.assetsignore` un-ignores exactly the file and the directory.

The stub names no site policy, so a device makes one network view that teaches it the security
headers before it renders locally.

## Upgrading The Library

The version of the installed library is the version of every device's replica. A device that holds a
0.3.0 replica gets a worker script that names a different code version, and the library wipes what
the old version stored; it never serves a page from the old copy. Until the device next checks the
script, at most a day, the old worker keeps running against the new server, which speaks the same
protocol version. A page that still names `/.spool/0.3.0/client.js` finds a 404 and loads as a plain
document. `tests/integration/spool.spec.ts` pins the code version a 0.3.0 device held against the
one the script names now. The browser-level upgrade check is in the library's own repository.

## Reaching A Device

A device learns a page changed from the vector. Each of these records a change a device's next sync
names, with a real object under test:

- A Drupal tag purge stamps the tags it invalidated and the cached paths that depend on them.
- A WordPress announcement through `cfwWpTags` (editing or publishing a post, changing an option,
  deleting a term) stamps its tags, and the purge it triggers stamps the stored pages that carry
  them.
- A wholesale bump, a WordPress wholesale purge, the floor purge for a write nobody announced, an
  object restart and a vector past 2,000 tags each tell a device behind that point to reset, which
  costs it its copies and never shows it a stale page.

One limit is known. A purge names the pages the object stores, by their path. A page that was served
and decorated but never stored, such as a render the store refused, is not in that index, so a change
to it reaches a device only when the copy passes its freshness bound: 900 seconds for a public route,
shown once from the copy and then checked. The same holds for an object that restarts, which forgets
the changes it had recorded inside its current generation; a device that synced a page rendered in the
window between a save's first write and the flush of its complete tag set can keep that page until the
next change. Devices holding any earlier generation reset.

## Avoidances

Each row is a request a device would otherwise send to the Worker. The options marked build are
fields of the stub, which the static tier serves as a file, so they are set in `src/site/spool.ts` and
take effect after `bun scripts/pack/spool.ts`. An environment lever could not change them for a site,
because the device gets the file and not the Worker's answer.

| Avoidance                                          | Default | Where set                         | Request it removes                                                             |
| -------------------------------------------------- | ------- | --------------------------------- | ------------------------------------------------------------------------------ |
| Worker script and page scripts as static assets    | on      | build, `assets/`                  | the Worker invocation for each script fetch and each lease check               |
| One-day lease on `/spool-sw.js`                    | on      | build, `assets/_headers`          | the update check on a controlled navigation, in Chromium and Firefox           |
| `views: false`                                     | on      | build, `src/site/spool.ts`        | the beacon a page view would queue, and the catalogue request it carries       |
| Inline gate with `bootstrap: 'second-view'`        | on      | library default                   | the page script request of a one-view visitor                                  |
| `workerMode: 'auto'`                               | on      | library default                   | the script check WebKit makes on each navigation, because it registers none    |
| No identity, no principal datasets, no live stream | on      | not configured                    | signed-in sync and dataset requests, which the spool repo's readings show lose |
| Cookie and `Authorization` requests skipped        | on      | `eligible` in `src/site/spool.ts` | a signed-in or commenting visitor's page held on a device                      |
| `SPOOL=0`                                          | off     | environment, KV                   | everything above, for a site that should not run spool                         |
| `SPOOL_IMAGES`, `SPOOL_VIDEO`, `SPOOL_EMBEDS`      | on      | environment, KV                   | none; they remove bytes, and each is a lever so a site can keep them out       |
| `SPOOL_EXCLUDE`                                    | empty   | environment, KV                   | the extra requests of a frequently edited public route, for that route only    |

Left off, with the reason: `beacons` stays unset, because Cloudflare's own analytics post to
`/cdn-cgi/rum`, which the edge answers and the Worker never sees, and listing it would route those
posts through a Worker request. `cdn` and `cdn.worker` stay off: the scripts are already static
assets on the site's own origin. `stamp` stays unset: the stub changes when the library or the spool
options change, and a stamp would force a check each lease with nothing to install. `policy` stays
unset, so a device makes one network view that teaches it the headers; setting it needs the site's
real security headers, which differ per site. `bootstrap: 'first-view'` and `inlineMaxBytes` stay off
because each adds requests or bytes to a first view.

Two cases from the spool repo's economics page lose, and the worker keeps both out. A signed-in reader
on defaults sent 20 origin requests against 7 without spool, and a persistent reader on a held day sent
4 against 1; the worker never configures an identity, so neither arm exists. A public-edit route held
as a stored page sent 17 against 9 over four days, against 10 for a family route; the worker's routes
are stored-page routes, so a site that edits public pages often gives some of that back.
`SPOOL_EXCLUDE` keeps such a route out of spool without turning it off for the rest of the site.

## Excluding Paths

`SPOOL_EXCLUDE` is a comma-separated list of absolute path prefixes. A request whose path equals a
prefix or sits under it (`/news` takes `/news` and `/news/today`, not `/newsletter`) is not decorated,
not kept by a device and not rewritten, and its images and videos are left alone too. The check runs
before every other spool rule, for every CMS, so the page reaches the visitor exactly as it would with
spool off. Pages outside the list are unchanged, and an unset or empty value changes nothing.

The lever is read like `SPOOL`: environment, then KV through `PUT /settings`, and it is owner-only, so
Drupal's settings form reports it under `refused`. A value is refused when an entry is not an absolute
path prefix without a query, when it names the root (use `SPOOL=0`), or when it names `/spool-sw.js` or
anything under `/.spool`.

## Media Features

The media features run only while spool is on, each with its own lever that defaults to on:

- `SPOOL_IMAGES` converts a PNG or JPEG to WebP for a browser whose `Accept` header allows it, caches
  the result in the isolate by content hash, adds `Vary: Accept`, and leaves the original when the
  conversion is not smaller. It also asks for `Sec-CH-Width` on pages that carry images. An image that
  already fits the requested width is converted at its own width, because tinyimg 1.1.1 enlarges an
  image to the width it is given even with `fit: 'scale-down'`.
- `SPOOL_VIDEO` adds `preload="none"` to `<video>` tags, so a page no longer downloads a video the
  visitor has not played.
- `SPOOL_EMBEDS` replaces a server-rendered YouTube or Vimeo iframe with a facade that loads the
  player on click.

Spool's lazy loading, responsive sizing, dictionary compression and trim options are not enabled.

## What The Saving Is

The saving is spool's to state, and spool labels every figure it states. This page repeats none of
them. A local view removes one Worker request and the document's bytes, and only for a view answered
inside its freshness bound. A first view costs what it cost before spool. A page the device's worker
fetches for the first time is one Worker request, the same as the document it replaces; the worker
script and the page script are static assets, syncs are Worker requests and beacons are off.
[What Spool Adds](../../impact/energy/views.md#what-spool-adds) has the counts and the free plan's
floor, which equals the spool-off cap because a device never sends more requests than it would
without spool. Spool does not claim a
radio-wake saving, a capacity saving without evidence that equipment was removed, or a Transformative
share, and neither does this page. The CPU cost of decorating a page and converting an image on the
hot path is not measured here; the platform's `cpuTime` on a deployed site is the only instrument for
it.
