# Configuration

Every setting is a `vars` entry or a binding in `wrangler.jsonc`, and every one has a working
default. A deploy that sets nothing beyond what the canonical config already carries serves a site.

Values arrive from wrangler as **strings**, so a boolean is `"1"` or `"0"` and a number is a decimal
string. An unparseable value falls back to the default and never throws: these are read on the
serving path, and a typo must not take a site down.

Three layers decide what a value is, most specific first:

1. **A request parameter**, where the route exposes one (`?prefill=`, `?all=1`).
2. **The `CONFIG_KV` namespace**, for the plan and the runtime levers on
   [Runtime Overrides](#runtime-overrides). No redeploy needed.
3. **The `vars` entry**, then the per-plan default in `src/ops/plan-profile.ts`, then the constant.

## Bindings

`wrangler.jsonc` is the canonical config and declares seven of the nine. `FILES` and `SEND_EMAIL` are
the two it leaves out.

| binding               | kind             | canonical config | what breaks without it                                                               |
| --------------------- | ---------------- | ---------------- | ------------------------------------------------------------------------------------ |
| `SITE`                | Durable Object   | declared         | the Worker has nothing to proxy to; every request fails                              |
| `ASSETS`              | Workers Assets   | declared         | no pack, no driver, no `/core/**`; an object cannot boot                             |
| `CONFIG_KV`           | KV               | declared         | the plan override and the runtime levers are absent; the deployed vars stay in force |
| `FLEET_DB`            | D1               | declared         | the cross-site inventory is absent; a single site does not need one                  |
| `FILES`               | R2               | **not declared** | the page and file mirror drains nothing; the off-Worker serving path is unavailable  |
| `CF_VERSION_METADATA` | version metadata | declared         | the fleet row records `workerVersion: "unknown"`                                     |
| `PAGE_KV`             | KV               | declared         | the cross-colo page tier is absent, and so is the stale-generation serve             |
| `RENDER_LANES`        | Durable Object   | declared         | image styles render on first view instead of on upload                               |
| `SEND_EMAIL`          | `send_email`     | not declared     | the credential-free mail transport is absent; `api` or `smtp` still work             |

**`FILES` is left out of the shipping config because naming it breaks the deploy button.** R2 has to be enabled from the Cloudflare dashboard before any bucket can exist, so a
config that names one is refused with _"Please enable R2 through the Cloudflare Dashboard.
[code: 10042]"_ on every account that has not done that. Enabling R2 requires a payment card on
either Workers plan, even when usage stays inside the monthly allocation. KV and D1 have no such
requirement: wrangler creates `CONFIG_KV` and `FLEET_DB` on first deploy.

Once R2 is enabled, wrangler creates the named bucket on deploy as it does for KV and D1. Add the
binding when you want the mirror:

```jsonc
"r2_buckets": [{ "binding": "FILES", "bucket_name": "drupflare-files" }]
```

An unbound optional binding always wins over the var that would enable the feature. Asking for a tier
that is not bound is a configuration error, and answering it with a crash on the serving path would
be the wrong trade.

## CMS

`CMS` selects which CMS the build packs, and `drupal` is the only value. It is read at BUILD time by
`bun run assets:driver`, from the environment and then from `wrangler.jsonc`, which sets it. Unlike
every other var it has no default: a missing or unknown value fails the build instead of packing
Drupal under another name. At runtime it is only reported, as the fleet row's `cms`.

## Site Identity and Origin

| var                  | default              | what it does                                                   |
| -------------------- | -------------------- | -------------------------------------------------------------- |
| `SITE_ID`            | derived, then `site` | which site a request resolves to, when KV maps no host         |
| `SITE_ORIGIN`        | pinned on first use  | the `scheme://host[:port]` Drupal builds absolute URLs against |
| `SITE_LOCATION_HINT` | unset                | which region the site's Durable Object is created in           |

### `SITE_ID`

One object per site, and the object's **name** is the site identity, so a wrong answer here serves a
request from a different site's database. The layers, in order, are implemented in `src/ops/site-id.ts`: `?site=` (only when the caller opts
in), a `site:host:<host>` KV mapping, then `SITE_ID`, then the deployment's primary site
(`src/ops/deployment-site.ts`), then the hostname itself, then the literal `site`.

The optional layers sit above the derived one because derivation answers for every real host, so
anything below it would be unreachable on exactly the hosts it exists to configure. `localhost`,
`127.0.0.1`, `0.0.0.0` and `::1` name no site and fall past derivation, which is what lets a local
dev server and a deployed site run the same code path.

Set it when one deployment serves one site under a name you choose. Leave it unset when the hostname
is the identity. Changing it after a site has content points the Worker at a different, empty object;
the old one still holds the data.

### `SITE_LOCATION_HINT`

One of `wnam enam sam weur eeur apac apac-ne apac-se oc afr me`, or unset.

Unset by default. Placement follows the first request a site answers, which for a deploy-button site
is wherever the deployer was. Pinning a region on an owner's behalf trades latency for one audience
against latency for every other, so the choice belongs to whoever knows the audience.

It applies when the object is **created**. Cloudflare ignores it for an object that already exists,
so setting it on a running site moves nothing.

An unrecognised value is ignored. The value reaches `SITE.get()` on the serving path, and a hint the
platform rejects would take the site down for the sake of a preference.

KV-overridable through the `settings` key, so a region can be chosen without a redeploy.

### `SITE_ORIGIN`

Every absolute URL Drupal emits is built from the origin: the canonical tag, a form action, a
`Location:`, the link in a password-reset mail.

The inbound `Host` carries no guarantee: an attacker who can set it can move a password-reset link
onto a host they control. So the origin is a property of the **site**, resolved in
`src/ops/site-origin.ts` in this order:

1. `SITE_ORIGIN`, which wins outright.
2. **The pin**, held in `cfw_meta` under `site_origin`. Trust on first use: the first non-local
   origin a site serves is stored, and later requests do not overwrite it. A forged `Host` after the
   pin changes nothing.
3. The observed origin, when there is no pin; that request is the one that sets the pin.
4. `http://localhost`, only when nothing above produced a usable value.

A bare hostname is accepted and assumed `https`. A full URL is trimmed to its authority, so
`https://example.com/` does not become a double slash in every canonical tag. Only `http` and `https`
are accepted: a `javascript:` form action is why this is an allowlist.

A local origin is never pinned (`localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, `do.local`), so running
the suite or a `wrangler dev` against a persisted object cannot fix a real site's canonical URL to a
developer's laptop.

Set it when the site is reached through a host it cannot observe: behind a proxy that rewrites
`Host`, or on a deploy whose first request is a health check. `SITE_ORIGIN` takes precedence over the
pin on every request, so it can change the origin of a site that has already pinned one; the stored
value is left in place.

Getting it wrong points canonical tags, redirects and mailed links at the wrong host. What a request
resolves to is a separate question, answered by `SITE_ID`.

Specs: `tests/unit/ops/site-origin.spec.ts`, `tests/integration/render-origin.spec.ts`.

### Alias Hosts

A site answers on more than one hostname through `site:host:<host>` entries in `CONFIG_KV`, one per
host, each naming the site. `drangler domain add <host>` writes the entry with your wrangler login
and adds a Custom Domain route for the next deploy.

Every render uses the site's origin, so the stored page carries the canonical host. On a request
whose host resolved through a KV entry and differs from that origin, the front worker rewrites the
response for the visitor's host: absolute URLs in text bodies (plain and JSON-escaped), `Location`,
and the `Domain` on `Set-Cookie`, which Drupal derives from the render host and a browser refuses
from any other. The session cookie keeps its name, so one login works on every alias. The response
carries `x-cfw-alias: <canonical host>`.

Only a KV-mapped host is rewritten. An operator wrote that entry, so a forged `Host` cannot turn it
on, and an unmapped host that reaches the site through the deployment primary keeps the canonical
links. The first request a site ever answers still pins its origin, so claim the site on its main
host before adding aliases.

Specs: `tests/unit/ops/site-origin.spec.ts`, `tests/integration/deployment-site.spec.ts`.

## Plan

| var    | default | what it does                                    |
| ------ | ------- | ----------------------------------------------- |
| `PLAN` | `free`  | selects the whole per-invocation budget profile |

`paid` and `free` are the only recognised values, and **anything unrecognised is free**: every limit
in this project is a free-plan limit, and a typo must not silently grant a 30 s CPU budget to
something that has 10 ms.

The plan sets five defaults in `src/ops/plan-profile.ts`. Four are numbers, and each has its own var,
so a paid profile can run on free or the reverse. The fifth, `bootInline`, is not configurable.

| profile field    | var                | free   | paid   |
| ---------------- | ------------------ | ------ | ------ |
| `fillBatchSize`  | `FILL_BATCH_SIZE`  | 5      | 8      |
| `httpDrainLimit` | `HTTP_DRAIN_LIMIT` | 3      | 15     |
| `mirrorLimit`    | `MIRROR_LIMIT`     | 2      | 10     |
| `inlineBudgetMs` | `RENDER_BUDGET_MS` | 10,000 | 10,000 |
| `bootInline`     | none               | on     | on     |

`bootInline` decides whether a MISS on a cold object may boot the interpreter and render inline, or
answer 503 and hand the path to the alarm chain. It is on for both plans.

The plan override lives in `CONFIG_KV`. The deployment-wide key `plan` applies to every site, and
`plan:<site>` overlays it for one site. Both are read at most once per isolate per minute, so an
account upgrade takes effect without a redeploy. A missing binding, a KV error and an unrecognised
value all fall through to the var.

## Serving and Caching

| var                      | default  | what it does                                                                                              |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------- |
| `GEN_BUCKET_MS`          | 5,000    | how long the edge reuses a resolved site generation before re-reading it                                  |
| `MAX_BODY_BYTES`         | 2 MiB    | largest non-file request body the edge forwards                                                           |
| `MAX_UPLOAD_BYTES`       | 100 MiB  | largest `multipart/form-data` body the edge forwards                                                      |
| `OUTBOUND_GUARD`         | on       | refuse an outbound fetch to a private, loopback or metadata address; `0` off                              |
| `PAGE_KV_ENABLED`        | on       | the cross-colo KV page tier; `0` off, `1` also lets free store compiled plans                             |
| `PAGE_KV_TTL`            | 86,400   | seconds a stored page lives; floored at KV's own 60 s minimum                                             |
| `KV_WRITES_PER_DAY`      | per plan | page writes to `PAGE_KV` one site may make a UTC day; 800 on free, no limit on paid                       |
| `EDGE_PLAN`              | on       | serve an authenticated page from a compiled plan in the front worker; `0` off                             |
| `CSP_MODE`               | per plan | baseline Content-Security-Policy on HTML: `off`, `report-only` or `enforce`; paid defaults to report-only |
| `SPOOL`                  | per plan | spool, the client-side replica: on for paid, off for free; `0` off, `1` on                                |
| `SPOOL_IMAGES`           | on       | convert images to WebP for browsers that accept it while spool is on; `0` off                             |
| `SPOOL_VIDEO`            | on       | add `preload="none"` to video tags while spool is on; `0` off                                             |
| `SPOOL_EMBEDS`           | on       | swap YouTube and Vimeo iframes for click-to-load facades while spool is on; `0` off                       |
| `NEVER_STALE`            | unset    | extra path prefixes that may never be served from a previous generation                                   |
| `AGED_SERVE_MAX_MS`      | 60,000   | how long a page a save superseded may still be answered while it refills; 0 off                           |
| `ASSET_AGGREGATES`       | unset    | substitute the build's CSS and JS aggregates into a stored page; `1` on, and the canonical config sets it |
| `MEMORY_CACHE_BINS`      | unset    | cache bins the interpreter holds in memory instead of in SQL; `none` turns all off                        |
| `MEMORY_CACHE_MAX_ITEMS` | 64       | entries one in-memory bin may hold before it drops its oldest                                             |
| `RENDER_BUDGET_MS`       | per plan | wall-clock ms a MISS may spend rendering before handing off to the alarm                                  |
| `FILL_BATCH_SIZE`        | per plan | pages one alarm firing may fill before re-arming; capped at 50                                            |
| `WINDOW_SITES`           | unset    | narrows the scheduled fill window to these sites; unset drives the whole fleet                            |
| `WINDOW_MAX_FILLS`       | 50       | fills one window may drive                                                                                |
| `WINDOW_WALL_MS`         | 60,000   | wall-clock ms one window may run                                                                          |

### Static Asset Cache Lifetimes

`assets/_headers` sets `Cache-Control` on the files the asset layer serves. Without it every asset
answers `public, max-age=0, must-revalidate`, so a repeat view revalidates each stylesheet, script
and font.

| path                                 | `Cache-Control`                       |
| ------------------------------------ | ------------------------------------- |
| `/agg/*.css`, `/agg/*.js`            | `public, max-age=31536000, immutable` |
| `/core/*`, `/modules/*`, `/themes/*` | `public, max-age=31536000`            |

An aggregate's file name is the first 16 hex characters of the SHA-256 of its body
(`scripts/pack-aggregates.ts`), so a changed file gets a new URL and a year is safe. `/agg/manifest.json`
has no hash in its name and keeps the default.

The three Drupal prefixes get a year, which is what Drupal's own `.htaccess` allows
(`drupal-src/.htaccess:42`). The `?token` Drupal appends to those URLs is not tied to the shipped
files. It comes from `state` key `asset.css_js_query_string`, and only `drupal_flush_all_caches()`, a
site install and the `assets` flush step of the update chain reset it (`drupal-src/core/includes/common.inc:429`,
`src/site/php/updb/unit.php:252`). Reconciliation does not, so a pack update that changes a `/core`
file leaves an existing site's URLs the same, and a visitor keeps the old copy until it expires or
the token changes.

`_headers` has no allow line in `assets/.assetsignore` and must not get one. Wrangler ignores it by
default and reads the rules from the directory; an allow line uploads it as an ordinary asset, and a
deployed worker then answers `/_headers` with the file (200, 282 bytes, measured 2026-10-19).

HTML comes from the Worker and is not affected. `/robots.txt`, `/driver.json`, `/prefill.json`,
`/drupal-pf/*` and `/drupal-sql/*` have no rule.

### Request Headers

Drupal receives the request's headers, not only its cookie. `Authorization`, `X-Api-Key`, `Origin`,
`User-Agent` and any other header an API reads reach `$request->headers` and `$_SERVER`. Before this
the render was handed the cookie, `Accept`, the content type and the client address and nothing
else, so every bearer-token route on a headless site answered as anonymous.

Three rules keep that safe. A request that carries `Authorization` is treated like one that carries
a session: it is rendered per caller and never read from or written to the stored page, the KV tier or
the edge cache. An `Authorization` that is this deployment's owner token is dropped before PHP sees
it. `cf-*`, `x-cfw-*` and the hop-by-hop headers are dropped too, and at most 64 headers and 16 KiB
are forwarded, whole or not at all. The previous request's headers are removed from `$_SERVER` before
the next is built, so a token never outlives the request that carried it.

### `OUTBOUND_GUARD`

PHP names the URL for `cfwFetch` and `cfwQueueFetch`, so any module able to build a string chooses
where the Worker connects. The guard refuses a scheme other than `http`/`https`, a URL carrying
credentials, and any host that resolves to loopback, an RFC 1918 range, carrier-grade NAT, IPv6
unique-local or link-local, or a name ending `.local`, `.internal`, `.localhost` or `.home.arpa`.
`169.254.0.0/16` is refused as a block because `169.254.169.254` is the cloud metadata address, and
an IPv4-mapped IPv6 literal is decoded first so `::ffff:a9fe:a9fe` cannot smuggle one through.

It is a deny-list because the legitimate destination set is open-ended: every update server, OIDC
provider, webhook endpoint and CAPTCHA verifier a site might use. An allow-list would need editing
to install a module.

Checked when the request is queued and again next to the `fetch()` in the drain, since a row can
reach `cfw_http_queue` by another path. `0` turns it off, which is what the e2e rig uses to point a
site at containers on the host.

### `MAX_BODY_BYTES`

This guards the heap, and leaves bandwidth alone. `parse_str()` on a form body allocates inside a
128 MB isolate, and `foo[][][][][]=bar` repeated turns a few hundred kilobytes of wire into far more
of it. Drupal's own `post_max_size` default is 8 MB; this is tighter, because there is no separate
process to lose here.

A body that declares a `Content-Length` is checked against it, which the platform holds the body to.
A chunked body declares none, so the edge reads it under the same ceiling and stops at the first
chunk that crosses it. `GET` and `HEAD` are not checked.

`multipart/form-data` has its own ceiling, `MAX_UPLOAD_BYTES`, because a 2 MiB cap on uploads would
be a functional regression. It defaults to 100 MiB, the platform's own request limit, which is the
only limit a multipart body had before the edge counted it.

Over either limit, the edge answers **413 before any Durable Object hop**. `0` disables that guard
entirely. Raising `MAX_BODY_BYTES` trades isolate headroom for larger non-upload submissions; the
failure mode of too high is an object that runs out of memory mid-parse.

Consumer: `bodyTooLarge()` and `readBounded()` in `src/site/guards.ts`.

### The KV Page Tier

`PAGE_KV` is a cross-colo tier between the edge cache and the Durable Object, on for both plans
whenever the namespace is bound. It still costs one Worker request, since the Worker has to run to
consult it, so what it buys is latency and never serving ceiling. A missing binding always wins over
`PAGE_KV_ENABLED`.

Free KV allows 1,000 writes a day for the whole account, and `CONFIG_KV` draws on the same allowance.
So the object grants each page write: an answer that may be stored carries `x-cfw-kv-grant`, and the
front worker stores nothing without it. The object counts its grants in its daily meter row and stops
at `KV_WRITES_PER_DAY`, 800 on free. Past that, the site keeps serving from what it already stored
and from the object. Only the primary grants, so replica lanes do not multiply the budget.
`/serve-stats` reports `pageKv.writesToday` against `pageKv.budget`. Compiled plans share the namespace
and carry no budget, so on free they are written only when `PAGE_KV_ENABLED` is `1`.

Stored pages are keyed by site, generation and path, so a generation bump invalidates every one of
them without enumerating or deleting anything. KV has no bulk delete, so a scheme needing one would
be uninvalidatable in practice. `PAGE_KV_TTL` is therefore a floor on garbage, and no kind of
freshness knob.

### `NEVER_STALE`

Because the previous generation's entries are still in KV after a bump, a miss at generation `N` can
be answered from `N-1` or `N-2` while the current one regenerates on the alarm chain. The response
carries `x-cfw-edge: STALE` and `x-cfw-stale-behind`, and the regeneration is queued rather than run
inline, so the visitor never waits for a render on a path that has been rendered before.

Two bounds apply together. The generation depth is 2, so a stale answer is at most two content changes
behind; a 24 hour wall-clock bound on top of it stops an abandoned site serving last month's page.

A session-carrying response can never be served stale, and that is structural rather than a check: the
stale read sits behind the same `edgeWanted` gate that requires a non-personalised response. On top of
it, a built-in deny-list refuses `/user`, `/admin`, `/cart`, `/checkout` and the other paths where a
one-change-old answer is wrong rather than merely old. `NEVER_STALE` is a comma-separated list of extra
prefixes and is **added to** that list rather than replacing it, so a site cannot make its own login
page staleable by configuring badly.

Consumers: `staleAllowed()` and `readStalePage()` in `src/ops/page-store.ts`.

### `MEMORY_CACHE_BINS`

A cache bin named here is held in the interpreter's memory for the life of the incarnation instead of
in the tenant's SQLite. `pib_run` performs no request shutdown, so a class static survives from one
Worker invocation to the next, which is what makes this a real tier here and a test double on an
ordinary PHP host.

The default is `dynamic_page_cache` and `menu`. `MEMORY_CACHE_BINS=none` turns the tier off, and a
variable set to an empty string takes the default, the same as an unset one.

In a measured re-render after a tag invalidation, the bin in memory charged 4 rows where the bin in
SQL charged 8, for a byte-identical page (workerd, shipping pack, the two arms differing by this
variable only). Rows written is the meter that bounds regeneration.

After an interpreter drop the in-memory bin is empty, and the next render rebuilds it. Across a drop,
the in-memory setting charged 2 rows against 6 for the SQL bin. The cost is isolate memory for the
entries held and CPU on the rebuilding render.

Bin names are bare, without the `cache_` prefix: `MEMORY_CACHE_BINS=dynamic_page_cache,render`.

An entry is validated against the cache-tag checksum on every read, the same test the database
backend applies, so an invalidation that arrives as replicated SQL rather than as a PHP call still
refuses it. That is the property a read replica depends on and the reason this is not core's
`MemoryBackend`.

`MEMORY_CACHE_MAX_ITEMS` bounds each bin. It is a count rather than a byte budget because measuring
bytes means serialising the value, which is the cost moving the bin out of SQL removes; the isolate's
own 112 MiB recycle is the backstop underneath it.

Both are on `KV_OVERRIDABLE`. The value is read when `settings.php` is composed, which happens on
every boot because the pack's filesystem is remounted each time, so a change takes effect on the
next interpreter boot rather than needing a redeploy. Source: `memoryCacheBins()` in
`src/do/levers.ts`, and `CfwCacheBackendFactory` in the `drupflare` module.

### `ASSET_AGGREGATES`

Drupal's own `css.preprocess` and `js.preprocess` ship off, because the source CSS and JS files are not
in the interpreter's filesystem and its aggregate route answers a licence header alone. `bun run
assets:agg` reads the library definitions at build time, where the files do exist, and emits immutable
per-library aggregates plus a file-to-library index. With `ASSET_AGGREGATES=1`, a page's contiguous run
of tags for a library is replaced by that library's single aggregate tag as the page is stored.

The substitution is **all or nothing per library**: either every tag in the run is replaced or none is.
A partial replacement would store a page that references an aggregate for some of its CSS and not
the rest.

It is on `KV_OVERRIDABLE`, so turning it on needs no redeploy.

**The aggregates have to be published as well as built, or the lever cannot work at any setting.**
`assets/.assetsignore` denies by default, so it must carry `!/agg/`. Without that the substitution
rewrites every asset tag to a URL the asset layer does not publish, the Worker answers it as a Drupal
path, and the page renders with no CSS. That is the same failure the all-or-nothing rule above exists
to prevent, arriving from the other side.
`tests/unit/runtime/assets-ignore.spec.ts` resolves every URL the substitution emits, so a page whose
stylesheets 404 fails the test suite.

Turning it on without running `assets:agg` changes nothing rather than breaking a page: an absent
manifest means no library matches.

**What it buys is render time and stored bytes, not Worker requests.** An individual core stylesheet,
such as `/core/themes/olivero/css/base/base.css`, is answered by the asset layer without running the
Worker, so the individual files already cost no Worker request.

### `EDGE_PLAN`

The compiled-plan tier in the front worker. On by default on both plans; `0` opts out, and an empty
value is treated as unset. It is the only tier that answers an **authenticated** page without a
Durable Object hop, because it is the only one whose key is per-visitor: the shared page tiers are
keyed without a user and must never hold one.

Three renders of the same page compile a plan; the first is discarded, because it warms Drupal's
asset library cache and its stylesheet list differs from every later render. The plan must reproduce
both remaining renders byte for byte, hold no slot it cannot generate, and survive a re-diff against
a freshly generated one. Anything else falls through to an ordinary render.

The key is the site, the generation, the path and the visitor's **role set**. Two properties make
that narrow key safe. A plan is compiled only from renders by two DIFFERENT sessions of the role set,
so anything constant for one user and different for another shows up as a region the compiler cannot
name and the plan is refused; and it is served to a session only once that session's own render has
agreed with it.

A site with a single editor never produces a second session, so a plan is also compiled under a key
that names the session and is served to nobody else. It is held in isolate memory and never mirrored
to `PAGE_KV`. The shared plan is preferred whenever one exists.

Slots are the values that differ per request or per visitor: `form_build_id`, a view's DOM id, and
the session CSRF token in the logout link. The first two are generated fresh; the token is
substituted from what the visitor's own last render carried, so a plan holding one refuses to run for
a visitor whose token this isolate has not seen.

A response that rotates the session is never compiled: a `Set-Cookie` that sets a value the request
did not already hold. Drupal re-sends the session cookie unchanged on every request when
`session.cookie_lifetime` is non-zero (its default is 2000000), so a `Set-Cookie` header alone does
not mean rotation.

Served responses carry `x-cfw-cache: PLAN` and `x-cfw-plan: mem`, `private` or `kv`; everything else
reports on `x-cfw-plan` why it did not.

`x-cfw-plan` is the edge plan and nothing else. The Cloudflare account plan is `x-cfw-account-plan`.
`x-cfw-v` carries the header contract version, and a client checks it before reading either.

An isolate serves against the last generation it learned from the object, and stops after 10 seconds
without re-learning one. That is the staleness bound, and it is the same two-window lag the shared
generation pointer already carries. A write by the visitor moves the generation on its own response,
so their own save is visible immediately.

Compiled plans are mirrored into `PAGE_KV` so a second isolate does not have to compile them again.
That read is bounded at 8 ms: a KV key a colo already holds answers in 4-5 ms, and one it has not
seen costs 46-140 ms whether it exists or not, which is more than the object hop it would replace.

Measured on a deployed paid worker, one session, one 100,748-byte authenticated page:

| where the answer came from      |             ms to response | cpuTimeMs | wallTimeMs |
| ------------------------------- | -------------------------: | --------: | ---------: |
| `EDGE_PLAN=0`, the object hop   |    10 median, 7 min (n=40) |         1 |         18 |
| a plan in this isolate's memory | **0** median and max, n=57 |         0 |          1 |

## Extensibility Routes

`/installable`, `/install` and `/enable` take the owner token, the one `/firstrun` mints when the
site is claimed.

| route                   | what it does                                                           |
| ----------------------- | ---------------------------------------------------------------------- |
| `/installable?module=X` | resolves the package and names any conflict with the shipped lock      |
| `/install?module=X`     | fetches it and writes its files; runs the check first unless `force=1` |
| `/enable?module=X`      | installs it through Drupal's own module installer                      |

Separate steps, because a package that has landed is not yet a module Drupal knows about and the two
have different failure modes. `/install` also accepts `version=<constraint>` and `registry=npm`;
`drupal/*` resolves against `packages.drupal.org/8` and everything else against
`repo.packagist.org`.

A config import and a queue drain run in steps. `POST /ops?op=cim&drive=1` with the config objects as the
body, or `POST /ops?op=queue-drain&drive=1&arg=<queue>&limit=<n>`, runs the first step in the request and
leaves the rest to the alarm, one step per firing, until a step reports `done` or fails. A failed step
ends the job and stays failed. `cim` also takes `collections=a,b` and `budget=<units>`, which ride on
every step. `/serve-stats` reports the last step under `lastOpsJob` and the exec router's per-program
counters under `exec` on `/serve-stats?exec=1`.

A module you wrote yourself arrives through a git remote, or through `/modify` when it is not on a
host at all. `/enable` is the same next step either way.

## Migrated Project Settings

A project moved from another host usually reads environment variables, `$config` overrides, header
rules and redirects that the old host supplied. Five names carry them.

| name                | form                        | what it does                                                                   |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| `DRUPAL_ENV_<NAME>` | var or secret, one per name | PHP reads it as `getenv('<NAME>')`, `$_ENV['<NAME>']` and `$_SERVER['<NAME>']` |
| `DRUPAL_CONFIG`     | JSON object, as a secret    | merged over `$config` with `array_replace_recursive` at boot                   |
| `DRUPAL_SETTINGS`   | JSON object, as a secret    | merged over `$settings` with `array_replace_recursive` at boot                 |
| `RESPONSE_HEADERS`  | JSON array, KV-overridable  | `[{"path":"/blog/*","set":{"X-Frame-Options":"DENY"}}]`                        |
| `REDIRECTS`         | JSON array, KV-overridable  | `[{"from":"/old/*","to":"/new/*","status":301}]`                               |

Only the `DRUPAL_ENV_` prefix, `DRUPAL_CONFIG` and `DRUPAL_SETTINGS` reach PHP. The owner token,
`PW_DIAGNOSTICS`, mail credentials and API tokens live on the same environment and are never read
into it. A malformed value is ignored, and `/serve-stats` lists the names that were ignored under
`deploymentEnv`. A heap image is not taken or restored while any of them is set, because the image
would carry the old values. Values change with a redeploy.

`DRUPAL_SETTINGS` is for what `settings.php` carried on the old host, such as a module's
`$settings['...']` entries. It is read up to 64 KiB, and it cannot move the keys the Worker sets
itself: `trusted_host_patterns`, `config_sync_directory`, `container_yamls` and the public, private
and temp file paths. A key it names that is protected is dropped and listed in the ignored names.

`RESPONSE_HEADERS` matches an exact path or a `/prefix*`. It cannot set `Set-Cookie`, anything
starting `x-cfw-`, or the headers that frame the body. `REDIRECTS` matches an exact path (a trailing
slash is ignored) or a trailing `*` that carries the rest of the path into the target. It answers
before routing, so a redirect costs no Durable Object request, and it never applies to the Worker's
own routes such as `/settings`. Status is 301, 302, 307 or 308, 301 by default, and at most 100 rules
are read.

Every response the Worker answers carries `X-Content-Type-Options: nosniff`,
`X-Frame-Options: SAMEORIGIN` and `Referrer-Policy: strict-origin-when-cross-origin`, and over https
`Strict-Transport-Security: max-age=31536000`, with no `includeSubDomains` or `preload`. A
`RESPONSE_HEADERS` rule that names one of them replaces it, and a rule value of `""` removes it, which
a site embedded in another page needs for `X-Frame-Options`.

A Drupal module can set a header too. Security Kit's policy and a custom subscriber's
`X-Frame-Options: DENY` reach the browser, from the object, the edge cache, the isolate memo, KV, the
stale answer and the compiled plan for a signed-in page. The render reports
the response headers and the host keeps only these names: `Content-Security-Policy`,
`Content-Security-Policy-Report-Only`, `Permissions-Policy`, `X-Frame-Options`,
`X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`, `Cross-Origin-Opener-Policy`,
`Cross-Origin-Embedder-Policy`, `Cross-Origin-Resource-Policy` and `X-Permitted-Cross-Domain-Policies`.
A value with a line break, a character outside printable ASCII, or more than 4,096 bytes is dropped,
and `Set-Cookie`, `Location`, `Access-Control-*`, `Content-*` and `Link` are never forwarded. The
stored page carries them in the `headers` column of `cfw_page`, written by the same statement as the
page, so a fill costs no extra row. The order is the Worker's default, then the module's header, then
the operator's `RESPONSE_HEADERS` rule, so a module's `X-Frame-Options: DENY` replaces the default
`SAMEORIGIN` and a rule replaces both. A compiled plan holds the headers its two sample renders
agreed on, and sessions whose renders disagree on one do not compile a plan. The page mirror in R2
does not carry them (R2 serves a fixed header set).

`CSP_MODE` adds a baseline `Content-Security-Policy` to every HTML response: `off`,
`report-only` or `enforce`. It defaults to `report-only` on the paid plan and `off` on free, and an
unrecognised value falls back to that default. The policy is
`object-src 'none'; base-uri 'self'; frame-ancestors 'self'; report-uri /csp-report`. It sets no
`default-src`, `script-src` or `style-src`, so core's inline script and style keep working, and it
has no `form-action`, because Chromium applies that directive to the redirect after a form
submission, so a form that posts here and redirects to another origin (a login button for an
identity provider) would be blocked. A page
that already carries an enforcing policy, from a module or from a rule, keeps only its own in either
mode. One that carries only a report-only policy keeps it in `report-only` mode; in `enforce` mode
the baseline is still added, because a report enforces nothing. `CSP_MODE`
is on `KV_OVERRIDABLE`, so `PUT /settings` and the `settings` document set it, and Drupal's settings
form cannot: the form's submit reports it under `refused`. A strict `script-src` with nonces is not
part of it.

Browsers post a violation to `POST /csp-report`, which the Worker answers with `204` and never
passes to the Durable Object. It takes `application/csp-report` and `application/reports+json`, up
to 8 KiB, and writes one `cfw-csp-report` line per report to Workers observability with the blocked
URI (no query), the violated directive, the page path (no query) and the first 80 characters of the
sample. Each address may send 60 reports a minute and an isolate takes 600, counted in memory; past
either limit the answer is still `204` and nothing is logged. Static files the asset layer answers
(`/core`, `/modules`, `/themes`, `/agg`) carry the cache rules in `assets/_headers` and none of
these.

## Spool

[Spool](https://github.com/drupflare/spool) is the client-side replica. The front worker runs its
proxy in front of the page pipeline, so a visitor's browser can keep a public page and show it again
without asking the site, until a change makes that copy wrong. `SPOOL` turns it on: paid sites
default to on, free sites to off, and `0` or `1` overrides either. A free site stays off by default
because the service worker's update check, its syncs and its beacons are Worker requests, and Worker
requests are the limit that binds a free site. The levers are on `KV_OVERRIDABLE`, so `PUT /settings`
and the `settings` document set them, and Drupal's settings form cannot: its submit reports them
under `refused`.

What it does while it is on:

- An anonymous `GET` or `HEAD` answered `200` with HTML gets spool's client tag and envelope headers.
  This runs after every cache tier, so no stored or cached page is the decorated one. A request with
  a cookie or an authorization header, a response that sets a cookie, an owner or diagnostic route
  and anything that is not a page go through untouched.
- `/spool-sw.js` and everything under `/.spool/` are answered in the front worker by the library: the
  service worker script, the client script at `/.spool/<version>/client.js`, `/.spool/sync`,
  `/.spool/artifact` and `/.spool/beacon`. Those paths are reserved, so no redirect rule captures
  them. Each address may make 120 requests a minute to them and an isolate takes 3,000, counted in
  memory; past either limit the answer is `429`. A beacon becomes one `cfw-spool` line in Workers
  observability, bounded in size and count, and writes no row.
- The object keeps a version vector in memory, a map from tag to the cursor of its last change, and
  answers a sync from it on the internal `/__spool` route. A cursor is the generation times 4,096
  plus a count inside it. A sync costs one Durable Object request. Decorating a page costs none,
  because the generation rides on the page response; a device that piggybacks a sync on a navigation
  makes the front worker ask once per cursor in each isolate for two seconds and answer the rest from
  memory. A scoped purge stamps the tags it invalidated and the cached paths that depend on them. A
  wholesale bump, an object restart and a vector past 2,000 tags each tell a device behind that point
  to reset, which costs it its copies and never shows it a stale page.

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

One limit is known. The vector lives in memory, so an object that restarts forgets the changes it had
recorded inside its current generation. A device that synced a page rendered in the window between a
save's first write and the flush of its complete tag set can keep that page until the next change.
Devices holding any earlier generation reset.

The saving is spool's to state, and spool labels every figure it states. At version 0.2.0 its impact
page gives a headline of 12.4 J per local view (L2: published intensities applied to the 17,054-byte
median document a local view replaces, not a meter reading), 0.80 J saved on a desktop against
optimized HTTP caching (L1, measured), 0.088 J saved on an iPhone over Wi-Fi (L1, measured), and one
request avoided per local view. This page does not repeat or extend them. The demand claim that
carries over is the one request: a local view removes one Worker request and the document's bytes,
and only for a view answered inside its freshness bound, 15 minutes soft for a public route. The
first visit to a site adds requests (the client script, the worker script and its update checks,
syncs and beacons). Spool does not claim a radio-wake saving, a capacity saving without evidence
that equipment was removed, or a Transformative share, and neither does this page. The CPU cost of
rewriting a page and converting an image on the hot path is not measured here; the platform's
`cpuTime` on a deployed site is the only instrument for it.

`/enable` is not needed for a text asset a migrated module ships: a `.css`, `.js` or `.svg` file
stored in `cfw_module_file` is served from `/modules`, `/themes`, `/profiles` and `/libraries` when
the pack does not hold the path. Binary assets are not served this way, because the table stores
source as text.

A migrated site claims with `POST /firstrun` and a body of `{"migrated": true}`. That mints the owner
token and marks the site claimed without changing uid 1, the site name or any mail setting. It takes no
`adminPass`, and an already claimed site answers 409.

## Module Revisions

`/modify` takes the owner token and delivers a module tree from a developer's machine. It is the
third delivery path beside `/git` and `/install`, and the only one that keeps history.

| action                             | method | what it does                                              |
| ---------------------------------- | ------ | --------------------------------------------------------- |
| `?action=plan&package=X`           | POST   | splits declared files into what the site has and needs    |
| `?action=blobs&package=X`          | POST   | stores file bytes, verified against the hash sent with it |
| `?action=commit&package=X`         | POST   | records a revision from a manifest and makes it live      |
| `?action=revisions&package=X`      | GET    | the stored revisions, newest first, and which is active   |
| `?action=manifest&package=X&rev=Y` | GET    | one revision's file list; `rev` takes `active` by default |
| `?action=activate&package=X&rev=Y` | POST   | makes a stored revision live; `rev=previous` rolls back   |
| `?action=status`                   | GET    | what is live per package, with its size and age           |
| `?action=drop&package=X&rev=Y`     | POST   | deletes a revision and the blobs nothing else names       |

A revision is a manifest of content-addressed blobs, so a second upload sends only the files that
changed and a blob already present costs no rows. Five revisions per package are kept
(`REVISION_RETENTION` in `src/ops/module-rev.ts`).

`plan` answers the have/want split and the change it would make: `counts` over every declared file,
the `removed` paths by name, and the rows an apply would charge. A file whose new bytes have not been
sent yet counts as `modified` rather than as a removal, which is what the site not holding those
bytes means.

`commit` and `activate` go through the same apply, verify and restore path a git pull takes: the
files are written in one transaction, the kernel is booted against them with every enabled module's
PHP loaded, and a boot that fails restores the previous file set. A module whose `.module` no longer
parses is rolled back and the reply names the parse error.

Bytes are bounded twice, by `MAX_BODY_BYTES` per request and by a 2,199,995-byte cap per file. A
client batches to stay under both.

A `commit` body may carry `autoload`, one object or an array, for vendor packages a build delivers:
`{"name":"acme/widget","version":"1.4.0","mount":"vendor/acme/widget","autoload":{"psr-4":{...}}}`. The
mount must sit under `vendor/` or `libraries/`. The site registers each map with the class loader
before it boots the kernel and puts the row back if the boot refuses, and `/install` does not fetch a
package that is already registered. A revision may also carry paths under `core/`, which shadow the
packed files at the next boot; a changed `core/**/*.yml` drops `cache_container` and `cache_discovery`
first, so the verifying boot rebuilds them.

A requirement on a virtual package such as `psr/log-implementation` is met by the shipped lock's
`provide` and `replace` entries and is not fetched.

## Site Maintenance

`/armfill`, `/invalidate`, `/bump`, `/migrate` and `/updb` take the owner token, so purging your own
page cache does not mean exposing arbitrary SQL and a whole-database overwrite alongside it.

`/updb` drives a database update run. `GET` reports the run and its units; `POST` advances exactly
one beat and re-arms nothing, so a caller that wants the chain finished polls. The alarm chain drives
the same step.

`POST` takes an `action`, which is what starts a run rather than advancing one. Without it a beat has
nothing to advance and answers `{"beat":"none","reason":"no-run"}`.

| action              | what it does                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| none, `run`, `beat` | advances one beat, which is what the Operate page has always sent           |
| `prepare`           | raises the maintenance fence, snapshots the bookkeeping and plans the units |
| `drain`             | runs up to `maxBeats` beats in this invocation; keep it at 1 on free        |
| `rollback`          | restores what the snapshot covers; legal only from a halted run             |
| `abandon`           | accepts a halted run as-is; requires a written `reason`                     |

`abandon` will not take a default reason. The next person reading the run has to see that a human
decided, and a generated string would forge that signature.

### The Repair Surface

What an owner token can fix, and what each one costs. The class decides whether a tool may run it
unattended: **safe** changes nothing a visitor sees, **rebuild** discards derived state that comes
back on its own, and **stateful** changes what the site serves.

| route                   | class    | what it does                                              |
| ----------------------- | -------- | --------------------------------------------------------- |
| `/health`               | safe     | reads the repair state, the ledger and the worker version |
| `/health?clear=1`       | stateful | releases a quarantine, so the site serves again           |
| `/updb`                 | safe     | reads the update run                                      |
| `/updb` (POST)          | stateful | advances one beat of a database update                    |
| `/updb?action=prepare`  | stateful | starts an update run, fence and snapshot included         |
| `/updb?action=rollback` | stateful | restores the bookkeeping a halted run snapshotted         |
| `/armfill`              | rebuild  | queues a fill, so cold paths warm without a visitor       |
| `/invalidate`           | rebuild  | drops stored pages for a path or a tag                    |
| `/bump`                 | rebuild  | advances the generation, retiring every stored page       |
| `/migrate`              | stateful | resumes first-run migration on a site that stalled        |
| `/git?action=unpin`     | stateful | releases a preview pin without reaching the remote        |

`/git?action=unpin` exists because `unpreview` cannot help here: it re-syncs to the branch head, so it
needs the remote to answer, and a pin held against a remote that is down is exactly what an operator
is trying to release. Releasing without a sync leaves the site serving what it already serves and
gives the poller the branch back, so the next successful poll converges it.

A quarantine is released rather than prevented. `/health` reports what tripped it and the ledger
entry that recorded it; clearing without reading that first is how the same fault comes back.

### Reading the Degradation Band Off a Response

Once a site leaves `normal`, every response it serves carries these headers:

| header                 | value                                                   |
| ---------------------- | ------------------------------------------------------- |
| `x-cfw-degrade`        | `reduced` or `read-only`                                |
| `x-cfw-degrade-driver` | which meter drove it: `rows` or `do`                    |
| `x-cfw-degrade-at`     | the fraction of that meter's daily budget already spent |

A `normal` site carries none of them, so their presence is the signal and no parsing is needed to
tell the two states apart.

The band is reported on every response from `reduced` onward, not only on a refusal. The level is
not persisted: the counter is keyed per UTC day, so midnight clears it.

`/serve-stats` reports `lastGitPoll`, `lastMirrorDrain` and `lastPageMirrorDrain`, each with its
`*At`. Every alarm unit catches its own error so one failure cannot stop the chain, so these
timestamps are the way to see a unit that has been failing.

A withdrawn replica lane is not a repair target. It asks the primary for a fresh copy itself, and the
primary queues that copy and arms an alarm to perform it. `/replica` is diagnostic only: it also
carries the path a lane uses to commit a batch it executed speculatively, which belongs to the pool
rather than to the owner token. Read the state through `/health` and `/serve-stats`.

## The Admin Surface

The seven `/_cfw` pages take the same owner token. A browser cannot put a header on its own navigation,
so `/_cfw/login` exchanges the token for a cookie: `HttpOnly`, `SameSite=Strict`, twelve hours,
cleared by `/_cfw/logout`. A page reached without it redirects to the sign-in form and returns
afterwards. A bearer header reaches the same pages, so a script needs no browser.

**`PW_DIAGNOSTICS` does not open these pages.** It opens the other owner routes. These pages install
code and run privileged operations, so they take the owner token only.
`SameSite=Strict` is what stands in for a CSRF token: several owner routes act on a GET, so a
cross-site request carrying the cookie would be enough to install a module. Strict means no
cross-site request carries it, including a top-level link.

## Owner Token Recovery

The owner token is shown once, at the claim. `POST /recover-token` gives it back to anyone who can
write the deployment's `CONFIG_KV` namespace, which means anyone who can already redeploy the worker
with `PW_DIAGNOSTICS=1` and read it through `/sql`. The proof is no weaker than the token.

```sh
drangler recover-token https://mysite.example --store
```

`--store` saves the recovered token in the system keychain, or in the global config on a machine
with no keychain.

The client mints a nonce (32 random bytes, base64url, 43 characters) and writes
`recover:<host>:<sha256 hex of the nonce>` to `CONFIG_KV` with a 60-second TTL, KV's minimum. The
value is `{"host": "<host>", "exp": <epoch ms>}`. It then posts `{"nonce": "<nonce>"}` to the site. The
nonce appears only in that body; KV, wrangler's argv and the logs see its hash.

The route is public, since the caller has no token, and it is answered in the front worker like
`/settings`. The front worker reads the failure budget before it touches the object, then hops to
`/__recover-token`, which does the rest:

1. read `recover:<request host>:<sha256(nonce)>` from `CONFIG_KV`; missing is a 404;
2. refuse a record whose `host` is not the request host (403), whose `exp` has passed (410), or whose
   `exp` is more than two minutes ahead (400), since KV's TTL, not the writer's clock, is the limit;
3. add the record to the spent table in `cfw_meta` (`recover_spent`) with no `await` between the check
   and the write, so two racing requests spend it once; a spent record is a 410;
4. delete the KV record, best effort;
5. answer `{ "ok": true, "ownerToken": "..." }` with `cache-control: no-store`, or 409 if the site has
   no token yet.

| status | `reason`     | counts as a failure | the client                         |
| ------ | ------------ | ------------------- | ---------------------------------- |
| 200    |              | clears the budget   | prints the token                   |
| 400    | `malformed`  | yes                 | stops                              |
| 403    | `wrong-host` | yes                 | stops                              |
| 404    | `unknown`    | yes                 | retries; KV may not have it yet    |
| 409    | `unclaimed`  | no                  | stops; run `site claim`            |
| 410    | `spent`      | yes                 | stops; run the command again       |
| 429    | `rate`       | n/a                 | stops; `retry-after` says how long |
| 501    | `no-kv`      | no                  | stops; the deployment has no KV    |

**Why the spent table is in the object and not in KV.** A deleted KV key can be served for another
minute at a different colo, so a replay inside that window would find the record. The object is
strongly consistent, which makes it the only place single use can be enforced. The KV delete is
tidiness.

**Why a recovery never mints.** The route reads `owner_token` and never calls `ensureOwnerToken()`,
which mints on a miss. A recovery on an unclaimed site would otherwise claim it for whoever holds KV
access. The proof is spent in that case, and the client names `drangler site claim`.

**The failure budget is the owner check's.** `OWNER_FAIL_LIMIT` in `src/ops/admin-session.ts`: 12
failures per 60 seconds, per isolate, keyed on `cf-connecting-ip`, checked before the hop and shared
with the owner check and the sign-in form. A 404 counts because KV is eventually consistent and a
fresh record can miss, so the client paces its retries (growing pauses, at most eight attempts) to
stay under it. The budget removes the object-request cost of guessing. Guessing a 256-bit nonce was
never the threat.

Limits worth knowing:

- Edit rights on the `CONFIG_KV` namespace are owner-equivalent. A token scoped to "Workers KV
  Storage: Edit" is enough. In a managed deployment the operator owns the namespace and can already
  read every object, so tenants must never hold KV API access.
- A client clock more than about a minute behind the worker's makes `exp` already past (410).
- The token is not rotated. Whatever else holds it keeps working.
- A local `wrangler dev` site has local KV, which the Cloudflare API cannot write; the route is
  meant for a deployed site.

## Owner Audit Log

The object records every owner call that changes state or reads a secret, and `GET /audit` returns
the log. A call is recorded when it carries the owner token and reaches one of these: `/install`,
`/enable`, `/modify`, `/restore`, `/export`, `/migrate`, `/bump`, `/invalidate`, `/pitr` (POST),
`/updb` (POST), `/reconcile` (POST), `/firstrun?force=1`, `/git` with any action but `list`,
`check`, `branches`, `prs`, `diff` and `status`, `/queue?action=drop`, `/ops` with an `op`, the
`/setup/*` pages when they write, `/health?clear=1`, and a `/settings` write. A token recovery is
recorded with the actor `proof`, since it presents no token. Reads and polling (`/serve-stats`,
`/health`, `/queue?action=list`) are not, and neither is a call with no valid owner token.

An entry is `{seq, at, route, method, status, actor, prev, hash}`. `actor` is the first 8 hex
characters of the SHA-256 of the presented token, and `hash` is the SHA-256 of `prev` followed by
the entry's JSON without its hash, keys in that order. The route carries only `action`, `force`,
`secrets`, `all`, `op` and `clear` from the query. The log lives in `ctx.storage` key-value storage,
which the SQL bridge cannot read or write (the platform reserves the `_cf_` tables behind it), as a
ring of the last 1,000 entries, a head pointer, and the hash of the last entry the ring dropped.
Each entry costs two key-value writes, three when it overwrites an older one.

`GET /audit` answers `verified` and, when the chain breaks, `firstBadSeq`. `drangler audit --verify`
recomputes the chain on the caller's machine and does not use that field. Every appended entry also
writes `{"audit":{"seq":N,"hash":"..."}}` to Workers observability, which a site-level attacker
cannot rewrite.

Failed token checks are a count (`failedAttempts`, kept in memory and written with the next entry
or read), never an entry: a row per attempt is the amplification the failure budget removes.

Limits:

- Whoever holds the Cloudflare account can edit Durable Object storage, so the log is evidence
  against an attacker on the site and not against the account holder.
- A point-in-time restore rewinds the key-value table with the database, and the object cannot
  append after the rewind, so no `restore` entry is written for it. Compare the head against the
  anchor in observability: the `/pitr` entry's `seq` and `hash` there are the pre-restore head.
- A call made with `PW_DIAGNOSTICS=1` and no owner token, and the internal calls that carry none
  (provisioning, the claim), are not recorded.

## Cron

| var                     | default   | what it does                                                                                    |
| ----------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `DRUPAL_CRON`           | on        | whether Drupal cron runs from the alarm; `0` turns it off                                       |
| `CRON_INTERVAL_MS`      | 900,000   | minimum gap between firings                                                                     |
| `CRON_MAX_UNITS`        | 6         | hooks or queues one firing may run                                                              |
| `CRON_MAX_ROWS`         | 500       | rows one firing may write                                                                       |
| `CRON_MAX_MS`           | 500       | wall-clock ms one firing may occupy                                                             |
| `CRON_QUEUE_BATCH_SIZE` | 5         | queue items drained per queue per firing                                                        |
| `UPDATE_FETCH_URL`      | unset     | release-history origin the declared prefetch warms; unset is drupal.org                         |
| `GC_INTERVAL_MS`        | 3,600,000 | gap between garbage-collection passes                                                           |
| `CACHE_DATA_MAX_ROWS`   | 5,000     | row cap on `cache_data`                                                                         |
| `WATCHDOG_ROW_LIMIT`    | unset     | row cap on `watchdog`; unset reads `dblog.settings` from the site                               |
| `KEEP_WARM_MS`          | 240,000   | idle alarm re-arm; does not keep the object warm                                                |
| `SITE_WARM`             | by plan   | `1` warms, `0` never warms; unset warms a paid site and leaves a free one to the thermal policy |
| `WARM_INTERVAL_MS`      | 8,000     | the warm re-arm, KV-overridable; clamped to 600,000, or to 8,000 when `RETAIN_INTERPRETER=0`    |
| `RECYCLE_ABOVE_BYTES`   | 117440512 | drop the interpreter at the end of an invocation above this linear-memory reading; floor 32 MiB |
| `ISOLATE_ABOVE_BYTES`   | 130023424 | the same drop against the whole-isolate estimate (linear memory plus the JS side); floor 64 MiB |
| `FILL_SETTLE_MS`        | 60,000    | ms after a boot before the alarm runs PHP (fills, cron, reconcile); `0` is off                  |
| `RETAIN_INTERPRETER`    | on        | keeps an evicted instance's interpreter for the next instance to adopt; `0` is off              |
| `REPLICA_READ_ONLY`     | off       | `1` puts the object in replica mode; see below                                                  |
| `REPLICA_COUNT`         | 0         | replica lanes per site beyond the primary; 0 is one object per site                             |
| `REPLICA_LAG_MS`        | 30,000    | how long a serving lane may go without pulling the log; the bound on staleness                  |
| `REPLICA_AUTOSCALE`     | on        | grow the pool when the site is contended; `0` pins it at `REPLICA_COUNT`                        |
| `REPLICA_MAX_LANES`     | 32        | ceiling autoscaling will not grow past; `0` is the same as switching it off                     |
| `WRITE_FORWARD`         | on        | `0` makes a lane refuse a write instead of executing it and forwarding it to the primary        |

`RECYCLE_ABOVE_BYTES` is the backstop for the isolate's 128 MiB limit, behind the primary defence.
`USE_ZEND_ALLOC=0` means PHP returns nothing between requests, so demand inside one incarnation is
cumulative; `/__migrate` and `/__firstrun` drop the interpreter when they finish, and this catches
everything else. It must fire BETWEEN invocations: linear memory is reclaimed only when the old
module is collected, so dropping mid-request holds both allocations at once. `/serve-stats` reports
`recycles` and `lastRecycle`; an object recycling every request is paying a boot per page.

The limit is per isolate, not per object, and an isolate can host several objects of one class.
`/serve-stats` reports `isolate`: its `id`, the `interpreters` it holds and their `linearBytes`
added together. Two interpreters do not fit 128 MiB, so `interpreters` above 1 is the thing to look
for on a replica pool.

`RETAIN_INTERPRETER` keeps the interpreter in the isolate when the instance is evicted, so the next
request skips the boot while the isolate survives. In measurement, adopting a kept interpreter took
61-169 ms against 1-2.5 s for a boot. When the isolate is gone the next request boots as it would have
anyway.
An adopted interpreter is refused when the site committed a write since it was kept. `/serve-stats`
reports `retention`.

**`REPLICA_READ_ONLY` is a safety interlock.** Setting it wraps every installed `cfw*` capability so
the object cannot commit an authoritative write, and refuses anything unrecognised. The mode is
reported under `replica` in `/serve-stats`.

A replica is started by a bulk copy and kept current by a log, both over `/__replica`:

| call                                  | on      | what it does                                                    |
| ------------------------------------- | ------- | --------------------------------------------------------------- |
| `GET ?action=snapshot`                | primary | the table plan; 409 when the primary's own identity is unminted |
| `GET ?action=snapshot&table=&offset=` | primary | one page of one copyable table                                  |
| `POST ?action=restore`                | replica | lands one chunk; `VERIFIED` when the whole copy has arrived     |
| `GET ?action=log&since=`              | primary | the records a replica at that generation still needs            |
| `POST ?action=apply`                  | replica | applies one record                                              |
| `?action=stage&to=`                   | either  | moves the stage, 409 on an illegal move                         |

A replica refuses a request it may not answer with 421 and `x-cfw-requires-primary`, and refuses a
stale one with 503 when the caller sent `x-cfw-require-generation`.

### `REPLICA_COUNT`

How many lanes a site has beyond the primary. **0 is the default and means one object per site**, in
which case every routing decision resolves to the primary and nothing changes.

**One lane helps only once the single object is saturated.** Measured through the front worker on
authenticated pages, one lane served 0.87x the throughput of no pool at 32 clients and 0.98x at 64,
because the lane takes about 60% of the traffic onto an object whose Drupal caches are colder than
the primary's. At 128 clients the same lane served 2.06x, and at 512 a single object answered every
request with 503 while one lane still served 426. A fixed `REPLICA_COUNT` suits a site that is already
contended. Autoscaling provisions lanes only under sustained queueing, the regime where even one lane
pays.

Lane 0 is the primary; lanes 1..n are objects named `<site>#r<lane>`. `#` is outside the set
`encodeSiteId()` keeps and outside its `_<hex>` escape, so a replica name cannot collide with a site
id however a hostname is spelled.

An object's role comes from its own name. `REPLICA_READ_ONLY` is deployment-wide and would make the
primary read-only too, so raising `REPLICA_COUNT` cannot put an existing object into replica mode by
accident. It tells the router how many lanes to spread across, and nothing else.

A lane is chosen by hashing a stable key: the path for a request carrying a session, else the client
address, else the path (`affinityKey()` in `src/ops/replica-routing.ts`). An authenticated session keys
on the path, so one editor's pages spread across lanes. A write spreads only where the lane can
forward it; with `WRITE_FORWARD=0` it goes to the primary without asking a replica first.

**Only the serving path spreads.** `/serve` is the one route on the allow-list, and every other route
pins to the primary. A route wrongly pinned loses capacity; a route wrongly spread answers from a
replica's copy. Visitor paths are rewritten to `/serve` before routing, so the list needs no other
entry.

The router does not track which lanes are ready. A lane that is not `SERVING` answers 421 with
`x-cfw-retry-safe: 1` and the front worker retries on the primary, so readiness needs no cache and no
invalidation. It costs one extra hop, and only while a lane is not ready.

### `REPLICA_AUTOSCALE`

Raising `REPLICA_COUNT` by hand tells the router that lanes exist. It does not create them, so the
lanes it routes to hold no data and answer 421 until somebody drives the provisioning loop.
Autoscaling is the half that creates one.

The signal is peak concurrent in-flight requests on the primary. A Durable Object runs one request at
a time and a PHP render holds it for the whole render, so concurrency is the queue, and a queue is
the only thing a pool can fix. The target is the **minimum** peak across three windows, minus one, so
a single burst cannot provision a lane that then exists forever; one quiet window clears the run. The
copy is driven a chunk at a time off the alarm, the same way a fresh site migrates, so no firing owns
a whole table copy.

An explicit `REPLICA_COUNT` is a floor rather than a ceiling: a site told to run 2 lanes runs at
least 2 and may still grow. `REPLICA_AUTOSCALE=0` is how an operator pins the number instead.

### `REPLICA_MAX_LANES`

The ceiling autoscaling will not grow past. The default is 32, and larger values are capped at 32.

**Throughput does not set the cap.** Addressing objects directly and summing, efficiency against
perfect scaling is 100 / 95 / 90 / 85% at 8 / 16 / 32 / 48 replicas, a loss of about 5 points per
doubling. This figure describes the topology; routed throughput is a separate measurement.

**Set `REPLICA_AUTOSCALE=0` when measuring against a fixed lane count.** Autoscaling builds lanes
under the load a benchmark offers, so a control arm provisioned with zero lanes can answer from `r1`
and `r2` on its first run. Read `x-cfw-lanes` back at drive time rather than trusting the configured
number.

**A pool is reached only by isolates that have already seen it.** `believedLanes()` is per isolate
and is set from the `x-cfw-lanes` the primary reports on a response, so the first request a cold
isolate makes goes to the primary whatever the pool size, and the belief expires after
`LANES_TRUST_MS`. Sustained traffic keeps every isolate warm; a low-rate or bursty client sees a
larger share answered by the primary. Count distinct `x-cfw-replica` values across a burst to read a
pool, since a single response cannot show it.

**The hard ceiling is 256 and it is arithmetic.** `replicaCount()` clamps to `ID_PARTITION_LANES`,
which it imports rather than restates: a lane mints forwarded row ids from its residue class modulo
the partition, the primary takes class 0, and past 256 two writers would share a class and mint the
same id. The default of 32 is a cost bound below that, not a correctness one.

A lane the router is not choosing falls back to the slow re-arm and hibernates, so an unused lane
costs storage and replication catch-up rather than a warming chain.

### `WRITE_FORWARD`

Lets a pool lane execute a write and forward the statements to the primary rather than refusing it.
On unless `0`, and reachable only where a pool already exists: every caller is behind a lane name or
a non-zero `REPLICA_COUNT`, both off by default. A site with no pool is unaffected by this value.

The lane runs the whole write locally, discards its own effect through the driver's `commit: false`
path, and hands the statement list to the primary, which stays the sequencer. Ids are partitioned so
that every writer holds a residue class no other writer mints: lanes from their lane number, the
primary from slice 0. A lane records the ids it forwarded so it cannot repeat one before replication
catches up.

Two things are worth knowing before turning it off. A write reaches a lane at all only because this
is on: with it off the router pins every POST to the primary, so the one object the pool exists to
relieve keeps every form submission. An unbuffered write, one Drupal issues outside a transaction,
takes the transaction bridge on a lane rather than the exec bridge, because
`cfwSqlExec` has no rollback and a write on it can be neither forwarded nor discarded. That routing
lives in the driver; the host's guard refuses an exec write and fails over, which is what happens if
the two ever disagree about whether a connection holds a residue class.

### `REPLICA_LAG_MS`

A restored lane drives itself: reaching `VERIFIED` arms its alarm, each firing pulls
`action=log` from the primary and applies it, and `admissionVerdict()` decides the promotion to
`SERVING`. A lane below `SERVING` owns its alarm chain and re-arms every 2 s. One that is `WITHDRAWN`
resets itself to `CREATED`, clears its torn-copy markers and asks the primary for a fresh copy, then
re-arms and repeats the ask until the copy lands; the primary queues the lane in `cfw_meta` and takes
a repair before growing the pool, on a quiet site as well as a busy one.

Once a lane is `SERVING` it falls through to the ordinary alarm body, and this var is the bound on
how far behind it may fall. Without it, a serving lane re-arms at `KEEP_WARM_MS` and can serve a copy
four minutes behind the primary; the staleness fence refuses only a caller that states a freshness
requirement, and a visitor states none. The default is 30,000. KV overrides are limited to
1,000..300,000; below a second a lane spends more on asking than on serving.

Each round costs two Durable Object requests against the primary, so this is a cost knob as much as a
freshness one.

### Creating a Lane

`GET /replica?action=provision&lane=<n>` on the **primary**. It copies a bounded number of rows,
answers with a cursor, and the caller passes that cursor back until `done`:

```sh
curl "$SITE/replica?action=provision&lane=1"
curl "$SITE/replica?action=provision&lane=1&cursor=<the cursor from the last answer>"
```

It runs on the primary because that is the object a caller can reach; a lane has no route into it
from outside. The lane needs no Drupal install of its own, since each chunk carries the table's DDL,
and it reaches `VERIFIED` on the final chunk, which arms its alarm. From there it is self-driving.

`budget` sets rows per invocation and defaults to 4,000. The cursor carries the generation the copy
began at, so a commit on the primary part-way through answers `torn`, which keeps the far end from
refusing in a way that reads like a bug. Restart the copy; there is no resume.

**A primary cannot be copied from until it has minted `system.private_key`**, which Drupal does on
first use and never at install. `action=snapshot` answers 409 naming the gap;
`\Drupal::service('private_key')->get()` on the primary closes it.

Cron defaults to on. Leave it on unless a site has a reason not to: a module that depends on cron
does not fail when cron never runs, it silently does nothing. Six of twenty-five surveyed contrib
modules need it.

### Warming

**A Durable Object hibernates after 10 seconds of idle and hibernation discards in-memory state, so
`this.php` dies there.** Measured on a deployed worker: an object holding a 32 MB allocation and an
id minted in its constructor kept ONE incarnation across 71 consecutive 8 s alarms, and at 12, 20, 30
and 45 s the constructor ran again on every probe.

`KEEP_WARM_MS` ships at 240,000, which is 24x the threshold, so it re-arms an idle alarm and keeps
nothing warm.

`SITE_WARM` re-arms at `WARM_INTERVAL_MS` instead. At 8,000 the object never hibernates, so every
request finds the interpreter it left. A longer interval lets it hibernate, and the next instance then
adopts the retained interpreter only when it lands in the same isolate; without retention
(`RETAIN_INTERPRETER=0`) nothing can be adopted and the interval stays clamped below 10,000.

**The default follows the economics.** An explicit `SITE_WARM` always wins. Unset, a paid site warms:
one site's 10,800 firings a day sit inside paid's included Durable Object requests and rows. Unset on
free it is the thermal policy below, because the same firings are 10.8% of free's daily row and request
budgets, and whether that buys enough is the operator's call. Both levers are on `/settings`. An idle
tick charges one row, the `setAlarm` itself. What warming buys is the 1,398 ms
cold boot on every page that renders, which is the authenticated tier; a cached page answers off SQL
without booting PHP at all, so warming cannot make one faster by any amount.

**Past hibernation the curve has one knee, at 30 s.** Measured on paid deployments with a page that
needs PHP, requested after 150-300 s of idle. The 30-120 s rows come from 12 workers over four
phases, rotated so every worker ran every interval (288 visits).

| re-arm            | firings a day | share of free's budgets | paid, per site-month | adopted | the request                    |
| ----------------- | ------------- | ----------------------- | -------------------- | ------- | ------------------------------ |
| 8 s (`SITE_WARM`) | 10,800        | 10.8%                   | $0.373               | always  | never hibernated: 156-371 ms   |
| 30 s              | 2,880         | 2.9%                    | $0.099               | 36%     | 100-692 ms adopted, ~2.1 s not |
| 60-120 s          | 720-1,440     | 0.7-1.4%                | $0.025-0.050         | 14-15%  | 106-888 ms adopted, ~2.2 s not |
| 240 s             | 360           | 0.4%                    | $0.012               | ~2%     | booted: 2-4 s                  |

Past 10 s, adoption depends first on where the platform places the object. Four of the twelve
workers never adopted at any interval; on the other eight, 30 s adopted 54% and 60-120 s 21-23%. Every
visit that did not adopt found no retained interpreter in its isolate.

A site that is not warming re-arms at 240 s, whether the thermal policy declined it or an operator
set `SITE_WARM=0`, because that is the cheapest point and the thermal policy declines exactly the
sites whose firings cost more than the boots they save. 60-120 s cost two to four times the firings
for little more. An operator who wants the middle point sets `SITE_WARM=1` and
`WARM_INTERVAL_MS=30000` on `/settings`; 30 s is also the shortest interval under $0.10 a month.

**The interval is priced per site rather than flat.** A flat 8 s re-arm is 10,800 object requests and
10,800 rows a day whatever the traffic, 10.8% of the free daily budget for one site, and it is charged
at both ends of the band it is only worth paying inside. `src/ops/thermal.ts` keeps a 64-entry ring of
recent arrivals (in memory, so the decision costs no rows), estimates the probability of a render
inside the hibernation threshold, and warms only while that probability times the 1,398 ms boot exceeds
what a firing costs. Below roughly **505 renders/day** it declines; above roughly **8,640** the site
never idles 10 s and is already resident, so the warming would be redundant rather than harmful.

**An active session overrides the rate estimate, because the rate is the wrong predictor for one.**
`renderRate()` is a property of anonymous traffic: it decides how likely a visitor is to arrive. What
decides whether an expensive render is imminent is whether somebody is signed in and working, and an
editor on a quiet site sits far below the 505 renders/day crossing while producing exactly the requests
a cold boot hurts most. In measurement, an authenticated render took 31 ms on a warm object and 513 ms on a cold one. A compiled plan removes the render, not the boot: the first three
requests of a session still render, and any request that falls through the plan tier pays whatever the
object costs at that moment.

So an authenticated render keeps the object warm for 30 minutes on its own. It is a window rather than
a latch, so a session that ended stops paying within one window, and at the 8 s re-arm it costs 225
firings, 225 requests and 225 rows, once. The signal is the uid Drupal reported rather than the
presence of a cookie, so a stale cookie cannot arm it.

An explicit `SITE_WARM` still wins in both directions, including over an active session. Setting it to
`1` warms a site the estimate would decline, and `0` declines one the estimate would warm. The
predictor decides only when the var is unset.

After an editorial save the object prewarms **one representative per route family** rather than
arbitrary URLs, because the page cache is keyed on the URL and what a visitor arriving on `/node/41`
meets cold is the object, not the page.

Duration is not the meter. An object waiting on an armed alarm is idle and eligible to hibernate, and
an idle-eligible object is not billed for duration; warming spends requests and rows.

`CRON_INTERVAL_MS` is what makes the per-firing budget a budget. The alarm is not a clock, since it
re-arms at +1 ms while a fill queue is draining, so "once per alarm" during an active fill is once
per page, each one costing an interpreter unit and up to `CRON_MAX_ROWS` writes. At 15 minutes the
worst case is 96 firings/day, so a site that hit the row cap every time spends 48,000 of the 100,000
daily rows. Lowering it is the fastest way to burn the meter that binds regeneration.

Cron renders against the site's origin, so links in mail it sends point at the site. See
[`SITE_ORIGIN`](#site_origin).

## Boot and Storage

| var                             | default                               | what it does                                                                                      |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `HEAP_SNAPSHOT`                 | on                                    | restore a stored wasm heap instead of booting the kernel; `0` disables                            |
| `HEAP_IMAGE`                    | **off**                               | take that heap image in the first place; `1` enables. A restore costs more than a boot            |
| `BOOT_IMAGE`                    | **off**                               | boot a cold object from the published boot image when the site matches it; `1` enables            |
| `BOOT_IMAGE_BAKE`               | off                                   | lets an object capture its own boot image; only the local bake rig sets it                        |
| `HEAP_RESTORE_CHUNKS`           | all at once                           | chunks of a snapshot one invocation may apply                                                     |
| `LAZY_MOUNT`                    | `1` in the canonical config           | stream the pack per file instead of inflating it whole                                            |
| `LAZY_FS_BUDGET_BYTES`          | 20 MiB, 4 MiB in the canonical config | resident bytes the lazy filesystem keeps before evicting                                          |
| `SITE_DB_PREFIX`                | the packed default                    | which database pack an object mounts                                                              |
| `SQL_CHUNK_PREFIX`              | `drupal-sql`                          | which asset directory the migration chunks are read from                                          |
| `MIGRATE_ENGINE`                | `sql`                                 | `sql` replays chunks in JavaScript; `php` needs a `pdo_sqlite` the shipping binary does not carry |
| `MIGRATE_SELF_DRIVE`            | on                                    | whether a partial migration re-arms its own alarm                                                 |
| `MIGRATE_CHUNKS_PER_INVOCATION` | 40 on free, all on paid               | chunks replayed per invocation                                                                    |

### `OPCACHE_MODE`

| value  | what it does                                             |
| ------ | -------------------------------------------------------- |
| `off`  | default; opcache disabled                                |
| `file` | opcache on with the file cache as its only backing store |
| `shm`  | opcache on with shared memory as its backing store       |
| `pack` | reads a file cache baked into the pack, read-only        |

`off` is the default. `file` writes its cache into the in-memory filesystem and never reads it back, so
opcache reports itself disabled on that arm. `shm` accelerates scripts but places its arena in PHP's
linear memory; in one measurement that took an object to 191.25 MiB, past the 128 MiB isolate limit.
`off` renders no slower than `file` and leaves more memory free.

`pack` needs `bun scripts/bake-opcache.ts` first and mounts nothing without it. It loads the baked
cache as a second layer and cuts a cold render's object CPU by roughly 500-900 ms (deployed, n=8
per arm, with the levers swapped between deploys as a control). It holds 8.58 MB more of the isolate,
and the visitor's wall time did not follow the CPU across the swap. Re-bake after any driver or
composer change: scripts are never revalidated against their source, so the mount refuses a layer
baked from other sources.

### `ARGON2`

`1` hashes passwords with argon2id at m=19456 KiB, t=2, p=1, computed on the host. Default off.

Turning it on is a migration: every bcrypt hash on the site reports as needing a rehash, and each
account is upgraded at its owner's next login. Existing hashes keep working throughout; core's
password service stays in place as the inner service and still owns bcrypt and legacy `$S$` hashes.
Hashes are written in PHP's own `$argon2id$v=19$m=..,t=..,p=..$salt$tag` form, so a site that leaves
this platform can verify them on any PHP with ext-argon2.

A hash costs a 19 MiB transient allocation and two passes of CPU. That is more than a free-plan
login invocation has.

### `SHELL_ASSEMBLY`

Allows an authenticated GET to be answered from a stored shell with its personalised regions filled
at the edge. On by default with no plan branch; `0` opts out, and an empty value is treated as
unset. Assembly writes rows, described below. No visitor is served an assembly that has not been proven against their own
render.

A path with no stored shell is seeded from the next authenticated request, which is what lets
assembly resume after an invalidation. Every bump purges every shell, because no Drupal cache tag
reaches one, so without seeding the feature stops at the first content change until an operator
re-harvests.

An operator harvest takes two sessions of one role set and stores the shell only when both normalise
to identical bytes. A seed takes one session, which widens what may be STORED and leaves what may be
served where it was. A visitor whose permissions hash differs from the stored shell's falls through
to an ordinary render.

Each visitor's first request for a harvested path re-harvests under their own session and requires
their normalised shell to equal the stored one byte for byte. That response carries
`x-cfw-cache: VERIFY` and is answered from their own harvest; later requests carry
`x-cfw-cache: ASSEMBLED`. A shell that disagrees is deleted and the reason is recorded in `cfw_meta`
under `shellRefusal`.

The proof is stored per `(path, permissions hash, uid)` and voided when the path is harvested
again. It costs 40 to 52 rows written once per visitor and path, against 4 to 10 for each render it
then replaces; an assembly writes none.

A generation bump drops every stored shell, including a `cachetags` bump. A shell caches the shared
region of a page and Drupal has no cache tag pointing at it, so nothing else would invalidate it.
Assembly stops on that path until the shell is harvested again.

`HEAP_SNAPSHOT` gates the restore and `HEAP_IMAGE` gates the producer. **The producer is off by
default**; `HEAP_IMAGE=1` opts back in.

It is off because a restore costs more than the boot it replaces. Two deployed free workers differing
only in these two vars, `cpuTime` on the cold render, nothing asked of either object during the idle:

| arm                                  | cpuTime (ms)                 |   n | median |
| ------------------------------------ | ---------------------------- | --: | -----: |
| `HEAP_IMAGE=1` and `HEAP_SNAPSHOT=1` | 2020, 1908, 1937, 1561, 1912 |   5 |  1,912 |
| both `0`                             | 1277, 1343, 1113, 1251       |   4 |  1,264 |

The ranges do not overlap, so a restore cost about 648 ms more than booting from scratch, and it
consumes storage against an account-wide 5 GB cap. The cause of the extra time is not known.

**The image size depends on when it is taken.** `snapshotStep()` takes its image from an alarm that
finds no resident interpreter, so on a fresh site it captures the cold shape at 37,158,912 bytes. An
image taken after a kernel boot and a serve is 9,699,328 bytes, and a restore from that image was
measured at 314.5 ms faster than booting.

`snapshotStep()` still takes one image per pack generation from the alarm when opted in, and `/heap`
reports `imagedGeneration`, `imageAttempts` and `lastHeapImage`. It never drops the interpreter: it
runs before the fill loop and only when `this.php === null`. It also refuses to overwrite an image an
operator took, since the GC keeps exactly one. When an image IS stored its chunks are deflated, which
bounds the storage at 3,134,727 bytes rather than 11,206,656.

The image is taken before the first render. Byte-identical anonymous output does not prove that no
session state survives a render, so no post-render image is produced. The shared boot image below is
the one exception, and it earns it differently: it is taken once from a throwaway site, and its test
asserts the session id, the `$_SESSION` keys and the user after a restore.

### The shared boot image

`BOOT_IMAGE=1` boots a cold object from a heap image published with the worker, where a plain boot
builds that heap from the database. **It is off by default**, because no real site's cold-boot share
has been measured against it. `bun run assets:bootimage` bakes it into `assets/bootimage/`.

A boot restores an image only when the site equals what the image was baked from: the pack
generation and enabled modules, the driver digest, a digest of the `config` rows, and a digest of
the settings and PHP fragments the heap was built under. Any difference boots plain, which is always
correct, so a stale image costs a plain boot. Two images are published. The `pack` image is for a
site the pack made. The `claimed` image is for a claimed site and carries `config=reset` in place of
the digest, because every claimed site has its own name, mail and timezone; its restore also resets
the config factory and the entity memory cache.

After the pages land, the restore runs `src/site/php/boot-image/rekey.php`: it reads `settings.php`
again (the site's salt and origin), flushes `cache.memory` and every memory bin, resets every cache
collector (State's private key, and anything the bake computed but had not persisted) and reseeds
`mt_rand`. A replica or pool lane never boots from the image.

Four things are measured. The first three were each rerun with the step that serves them removed,
and the spec failed:

- A restored site renders what a plain boot renders, over five pages, after normalizing the ids a
  render invents. A first render that read as many rows as a plain boot would show the heap was
  not used, so the spec asserts fewer.
- The salt and the private key read before any request are the site's own, and a second restored
  site draws different `mt_rand` values. Without the settings re-read the bake's salt survives.
- A claimed site's own name shows, and so do a theme colour, a disabled block, the maintenance
  switch, a new menu link and a saved node, from the image and from a plain boot alike. With the
  config reset off all six cases fail.
- A corrupt file refuses the restore. If an earlier file already landed, the interpreter is dropped
  and the site boots plain; the page is the same either way.

**A heap restored from a bake is only as fresh as an interpreter that rendered once.** One case
showed it: the bake's active trail for `/user/login` sat in a cache collector, waiting to be
persisted, and the first request's resetter wrote it into the new site's cache under that site's
current tag checksums. It read as valid and lacked the link the site had added. Resetting the
collectors on every restore fixed it.

Deployed, on a claimed site with `SITE_WARM=0` and `RETAIN_INTERPRETER=0`, a cold round cost 2,527 ms
of object `cpuTime` without the image and 1,105 ms with it (medians, n=7 per arm, one worker each),
and 3,974 against 2,454 ms of wall time. The cost is the request's fetch plus the alarm it queued
behind, since the platform charges the boot to the alarm. The technical report has the table and
its limits.

What is not measured: the share of real cold boots that match an image, the pack image deployed, a
site with content or a large module set, and what the extra 18.6 MiB of memory (1,320 to 1,375 pages
against 1,024) costs per fresh isolate, which a deployed memory is charged for in full. A site with a different module set,
settings or interpreter build boots plain; the published index also names the interpreter, and
`tests/node/boot-image-agrees.spec.ts` fails when it is not the one on disk.

**What replaces this as the number to watch is the cold-encounter share**, not the cold-boot duration.
`src/ops/cold-encounter.ts` classifies every request the object handles and `/serve-stats` reports
`coldOfPhp`, `coldOfObject` and `coldOfTraffic`. 1,264 ms is the floor for an object `thermal.ts`
decided not to keep warm, and that policy already ships.

Read `coldOfTraffic`, not `coldOfObject`. A plan hit, an isolate memo hit, a `caches.default` hit and
a KV page read all return from the front worker, so the object's own denominator is the leftovers and
a share taken against it reads several times high. The front worker reports what it absorbed on the
next request that hops anyway, under `x-cfw-absorbed`, and `coldOfTraffic` is null until it has --
because a worker too old to report and a site with nothing absorbed are otherwise the same reading.

**Changing `LAZY_MOUNT`, `MIGRATE_ENGINE` or `SITE_DB_PREFIX` in a deploying config means changing
`assets/.assetsignore` too.** The shipping asset set is derived from the canonical values of those
three; `tests/unit/runtime/assets-ignore.spec.ts` fails when the two disagree.

## Diagnostics

| var                 | default | what it does                                                              |
| ------------------- | ------- | ------------------------------------------------------------------------- |
| `PW_DIAGNOSTICS`    | off     | exposes `/sql`, `/restore`, `/php` and the rest of the diagnostic surface |
| `PHP_LOG_LEVEL`     | `info`  | RFC 5424 ceiling on what PHP's log mirrors to `console.log`               |
| `PW_SQL_TRACE`      | off     | logs every Drupal statement through `console.log`                         |
| `PW_SQL_TRACE_FROM` | 0       | first statement number to log                                             |
| `MEMORY_TRACE`      | off     | logs memory readings at each boot and invocation end, for a reset         |

### `PW_DIAGNOSTICS`

**One boolean that exposes arbitrary SQL against the site database (`/sql`), a whole-database
overwrite (`/restore`) and arbitrary PHP (`/php`).** Diagnostic routes fail closed without it.
`bun run dev` sets it; a deployed configuration must not. It is not KV-overridable: a KV write that set
it would open `/sql` and `/restore` on a live site.

### `PHP_LOG_LEVEL`

`off | error | warn | log | info | debug`, mapped onto RFC 5424 severities (lower is more severe), the
same scale `CfwLogger` sends and Drupal's own `watchdog` uses. `warning` and `notice` are accepted as
aliases for `warn` and `log`, and `all` for `debug`.

`CfwLogger` ships every Drupal log entry across the host bridge and the object mirrors it to
`console.log`, so the output survives the isolate that produced it. Unfiltered, a single page render
emits several debug-level deprecation notices with stack traces, which fills a terminal. `info` is the
default for that reason.

An unrecognised value falls back to the default and raises no error. A fatal carries `level: "error"`
with no severity and is derived from the name, so a missing field never drops it.

Consumer: `src/ops/log-level.ts`.

### `PW_SQL_TRACE`

Logs every statement Drupal issues. `console.log` survives an object reset, which is what makes it
readable when the object dies mid-run. A `wrangler tail` has a 256 KB budget, so
`PW_SQL_TRACE_FROM=<n>` spends it on the end of a long run instead of the beginning.

## Prefill and Mirroring

| var                     | default                   | what it does                                                                        |
| ----------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `PREFILL`               | on for free, off for paid | seed the serving table from `assets/prefill.json`                                   |
| `PREFILL_ON_SAVE`       | on                        | re-render invalidated paths after a content save                                    |
| `PREFILL_ON_SAVE_LIMIT` | 25                        | paths one save may queue                                                            |
| `SAVE_DEBOUNCE_MS`      | 2000                      | how long the refill after a save waits for the rest of a burst; `0` refills at once |
| `MIRROR_LIMIT`          | per plan                  | files one alarm firing may push to R2; capped at 25                                 |
| `R2_WRITES_PER_MONTH`   | 900000                    | R2 writes both mirrors may spend in a UTC month; `0` turns both off                 |
| `HTTP_DRAIN_ON_ALARM`   | on                        | drain queued outbound requests from the alarm                                       |
| `HTTP_DRAIN_LIMIT`      | per plan                  | queued outbound requests one firing may fetch; capped at 25                         |

`PREFILL` is on for free because free is where a cold first request costs the most: a prefilled path
is a hit on its first ever request. It is off during a bake, or every render would be a hit of the
file being rebuilt.

`SAVE_DEBOUNCE_MS` holds the refill after a save for a short window, so a burst of saves costs one
generation bump and one render of each affected page. A refill that ran between two saves would
reopen the invalidation and make the second save pay for both again. The window starts at the first
save and later saves do not extend it. A visitor who asks for an invalidated page is still served at
once; only the pages nobody has asked for wait.

`R2_WRITES_PER_MONTH` caps what the file and page mirrors spend together. R2's allocation is
1,000,000 Class A operations a month per account, and every put past it is billed; the default stops
one site at 90% of that. The count is kept in `cfw_meta` under a key that names the month, so it
resets on the first of each month. Deletes count as well, so the tally reads high. A spent budget
leaves the rest of the queue in place and every file keeps serving from the object, which holds the
bytes either way. `/serve-stats` reports the month's tally as `r2`. Set it to `0` to stop both
mirrors while leaving `FILES` bound. On an account running several sites, divide the allocation
between them.

The share of traffic worth serving off the Worker depends on the traffic mix and on CDN absorption.
`optimalOffWorker()` in `scripts/measure/free-envelope.ts` computes it from the same model the free-plan
envelope uses.

## Files and Images

| var                 | default   | what it does                                                        |
| ------------------- | --------- | ------------------------------------------------------------------- |
| `FILES_PUBLIC_URL`  | unset     | origin a mirrored public file is linked from; unset uses the Worker |
| `IMAGE_ENGINE`      | `tinyimg` | which engine produces derivatives; `images` for Cloudflare Images   |
| `EAGER_DERIVATIVES` | on        | render an upload's image styles on the rendering lanes; `0` off     |

### Image Styles

A public image style's URL points at the Worker's delivery path, `/cfw-img/<id>/<uri>?<transform>`,
where the front worker renders the derivative with tinyimg. The drupflare module rewrites the URL
from the style's effect chain: scale, scale-and-crop, resize and convert each map to one transform.
A chain that cannot be expressed as one transform, and any private file, keeps Drupal's stock URL.

With `RENDER_LANES` bound, an image written to `public://` is queued, and the next alarm renders
every configured style at once on the rendering lanes, Durable Objects that hold no Drupal state.
The results are stored under `public://cfw-derivatives/`, and the image route answers a stored copy
in place of the source on the request it already makes, marked `x-cfw-image: STORED`. In measurement on
a deployed worker with the four shipped styles (n=5), the render job took 984-1,718 ms on four lanes
with five or six Durable Object requests. A stored first view answered in 41-91 ms, and the same style
rendered on first view took up to 1,647 ms. Stored and rendered bytes were identical in all 20
comparisons. Through the media form, an upload answered 303 in 750-939 ms and all four styles were
stored 3.9-4.4 s after the POST. `EAGER_DERIVATIVES=0` returns to rendering on first view.

### `FILES_PUBLIC_URL`

Unset, every file is served through the Worker, which is correct and costs one Worker request per
file. The front worker answers `/sites/default/files/<path>` from the object's file store and caches
it for 300 seconds. Drupal has no route for a public file, so until this route existed every public
original answered Drupal's 404 on a site with no mirror. PNG, JPEG, GIF, WebP and AVIF render inline;
every other type, SVG and PDF included, is sent as a download under a sandboxing
`Content-Security-Policy`, because the file shares the site's origin and its session cookie. Set to
an R2 custom domain, a public file that has already mirrored to the `FILES` bucket is
linked at that origin instead and costs **no Worker request at all**.

That is one of only two paths on the platform that cost nothing. A zone Cache Rule is not one of them:
the Worker runs before the cache is consulted, so a cache hit still spends an invocation. The two are
a static asset and a hostname that is not routed to the Worker.

Two files never get the external URL. A `private://` file is never linked externally at any setting,
because the bucket has no session and the URL would bypass Drupal's access check. A public file that
has not mirrored yet keeps the Worker URL, because the alternative is a 404 on a file the site holds.

### `IMAGE_ENGINE`

`tinyimg` is the default and runs in the front worker, where it never meets PHP's heap. It needs no
zone, no binding and no subrequest, and it has no monthly cap.

Cloudflare Images is reachable with `IMAGE_ENGINE=images`. It is the only one of the two that encodes
AVIF, and it costs a zone with transformations enabled, does not exist on `*.workers.dev`, and caps at
5,000 transformations a month. Against the four shipped image styles that is 1,250 images before a
site stops generating derivatives.

**The toolkit reports the engine's real format list.** All four
shipped styles are `image_scale` plus `image_convert_avif`, and core's `AvifImageEffect` asks the
toolkit whether AVIF is supported before using it, falling through to the style's configured fallback
of `webp` when the answer is no. So core degrades on its own with no config change, provided the
toolkit tells the truth. Claiming `avif` on the tinyimg engine produces a logged failure instead of a
fallback.

Measured on a deployed free worker, `cpuTime` amortised over 10 transforms per invocation, median of
12, against a source-only control at 0 ms: thumbnail 36.3 ms, medium 48.6, large 63.5, wide 188.2.
Styles at or below 480 px on the long edge are produced inline; larger ones go to the fill queue.

gd is not an engine. Code that calls PHP's `imagecreate*` functions directly finds them absent on this
runtime.

## Outbound Mail

Drupal's mail plugin is `cfw_mail`, and it hands the message to the Worker. The Worker resolves one
of three transports and commits the message to `cfw_mail_queue`; the alarm sends it. `src/ops/mail.ts`
is the implementation.

**The plugin is claimed by a config override that the module registers, not by `settings.php`.**
Assigning `system.mail:interface.default = cfw_mail` from `settings.php` would name a plugin of a
module the site may not have installed, and `MailManager` throws `PluginNotFoundException` for an id it
cannot resolve. `MailInterfaceOverride` runs only when `drupflare` is installed, and it yields to `smtp`
on a site that has `smtp`.

| var                   | default  | what it does                                               |
| --------------------- | -------- | ---------------------------------------------------------- |
| `MAIL_TRANSPORT`      | `auto`   | `auto`, `binding`, `api`, `smtp` or `off`                  |
| `MAIL_FROM`           | none     | the From for a message that carries none                   |
| `MAIL_DRAIN_ON_ALARM` | on       | send queued mail from the alarm                            |
| `MAIL_DRAIN_LIMIT`    | 5        | messages one firing may send; capped at 25                 |
| `CF_EMAIL_ACCOUNT_ID` | none     | the account the Email Sending REST API posts under         |
| `CF_EMAIL_TOKEN`      | none     | an API token with Email Sending: Edit; a secret, not a var |
| `SMTP_HOST`           | none     | submission host for the third-party lane                   |
| `SMTP_PORT`           | 587/465  | 587 for STARTTLS, 465 for implicit TLS                     |
| `SMTP_TLS`            | starttls | `starttls`, `implicit` or `off`                            |
| `SMTP_USER`           | none     | submission user; omit for an unauthenticated relay         |
| `SMTP_PASS`           | none     | submission password; a secret                              |
| `SMTP_AUTH`           | `PLAIN`  | `PLAIN` or `LOGIN`                                         |

`auto` takes the first transport that is configured, in the order binding, api, smtp. The binding
leads because it spends no credential.

### The `smtp` Module's Own Settings

A site with `drupal/smtp` installed and configured needs none of the `SMTP_*` vars. The module
installs on this runtime and its socket never runs, so its settings would otherwise sit unread while
an operator typed the same relay a second time. Its
`smtp.settings` is read and mapped onto the transport: `smtp_host`, `smtp_port`, `smtp_username`,
`smtp_password` and `smtp_from` map across directly, and `smtp_protocol` maps `ssl` to implicit TLS,
`tls` to STARTTLS and `standard` to no encryption. `smtp_on` turned off is honoured.

**A var always wins over the setting it corresponds to.** A var is set by whoever can deploy the
Worker; the settings form is reachable by anyone who can get to a Drupal admin page. So the settings
fill gaps only, and setting `SMTP_HOST` pins the relay regardless of what the site is configured
with.

### What Each Transport Reaches

`binding` uses a `send_email` binding named `SEND_EMAIL`, declared in your own Wrangler config. `api`
uses the Email Sending REST API. Cloudflare applies the same limits to both, and to its own SMTP
endpoint, so the choice between them comes down to credentials. Two account-level facts decide what
either can reach:

- **A sending domain that is not onboarded** reaches verified destination addresses only: the 200
  per account that somebody confirmed by clicking a link. Onboarding the domain with SPF and DKIM on
  Cloudflare DNS lifts that immediately.
- **Workers Free has no outbound Email Sending.** The one carve-out is that sends to verified
  destination addresses are free on every plan, from your routing domains, against no quota.

So a free site can mail its owner and cannot mail a visitor who just registered. Third-party SMTP is
the only general answer on free, and a rejected Cloudflare send says so in its error text, with no
status code to read.

### SMTP

**The canonical config does not declare `send_email`.** It is an ordinary Wrangler binding, so adding
one is a redeploy, and `allowed_destination_addresses` / `destination_address` narrow what it may reach.
Its prerequisites are account state the deploy button cannot provision: Email Routing enabled, at least
one verified destination address, and an onboarded sending domain. `api` needs only the token that
`/setup/cf` grants, so it is the transport the product provisions, and the binding is an opt-in.

Port 25 is blocked on Workers; `MAIL_TRANSPORT=smtp` with `SMTP_PORT=25` is refused by name, before
any attempt. `smtp.mx.cloudflare.net` is refused too: it resolves inside `162.158.0.0/15`, a
published Cloudflare range, and outbound TCP to those is blocked. Use `MAIL_TRANSPORT=api` or the
binding for Cloudflare mail. `SMTP_TLS=off` together with `SMTP_USER` is refused, because it would
put the relay password on the wire.

SMTP is the only transport that opens an outbound TCP socket, and an outbound socket is on
Cloudflare's list of conditions that prevent a Durable Object from hibernating. The object is
therefore billed for compute duration for the length of the send, and the queue drains sequentially,
so a batch is billed for the whole batch. The socket is closed in a `finally`, which caps the
exposure at the send itself, well under the 15-minute maximum a connection can defer eviction by.
The `api` and `binding` transports use `fetch`, which never holds an object in memory.

### Limits and What a Refusal Means

A message is refused at commit, where `CfwMail` logs the reason next to the operation that produced
it, for: no recipient, no From, more than 50 recipients across To/Cc/Bcc, a subject over 998
characters, headers over 16 KB, or a payload over 1,000,000 bytes. That last one derives from the
Durable Object record ceiling of 2,199,995 bytes; Cloudflare's own 5 MiB is the looser of the two and
never fires first.

A failure after commit is only visible on `/serve-stats`, under `mailQueue`, `lastMailDrain` and
`lastMailDrainAt`. A failed send is not retried: a send is not idempotent, and a password reset
delivered twice with two different one-time links is worse than one that did not arrive.

Mail sent through the `send_email` binding shows as **dropped** in the Email Routing summary even
when it was delivered. Read Email Sending metrics instead.

### Connecting a Cloudflare Account

Two ways, both owner-authenticated. Pasting `CF_EMAIL_ACCOUNT_ID` and `CF_EMAIL_TOKEN` needs no
setup. OAuth issues a short-lived scoped grant instead, revocable from the Cloudflare dashboard.

Owner-authenticated means `Authorization: Bearer <ownerToken>`, the token `/firstrun` returns once
when the site is claimed. Without it these routes answer 401 with a `WWW-Authenticate: Bearer`
challenge. `README.md` covers claiming.

`GET /setup/cf?action=connect&client_id=<id>` starts the flow and returns an authorize URL;
`/setup/cf/callback` completes it; `?action=status` reports whether an account is connected and
`?action=disconnect` revokes the grant at Cloudflare as well as forgetting it locally.

OAuth needs a client the operator registers once, under **Manage account > OAuth clients**, with
`https://<your-site>/setup/cf/callback` as its redirect URI and `private` visibility. A redirect URI
is registered against the client and every deployment answers on a different origin, so there is no
shared client that could serve all of them. The flow is Authorization Code with PKCE (S256) and
carries no client secret.

The client ID is stored in the site's own database, away from KV. It carries no secret, and a KV
writer who could change it would point the consent screen at an application they control.

Scopes requested: `user:read`, `account:read`, `email:read`, `email:write`. Onboarding a sending
domain additionally needs **zone DNS write**, which is why it is a separate opt-in step.

### Onboarding a Sending Domain

`GET /setup/mail?zone=<zone-id>` reports which step the domain is waiting on;
`?action=apply` creates the sending subdomain and writes the DNS records. Owner-authenticated, and
safe to re-run: a settled zone costs zero API calls.

| stage                   | meaning                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `no-zone`               | pick the zone this site sends from                           |
| `needs-subdomain`       | create the sending subdomain on that zone                    |
| `needs-dns`             | records still to write, counted in `waitingOn`               |
| `awaiting-verification` | click the link Cloudflare emailed to the destination address |
| `ready`                 | mail can send                                                |

`settled` means re-running changes nothing; onboarding may still be unfinished.
`awaiting-verification` is settled, because nothing more can be done from this side.

A sending subdomain is zone-scoped. Six records are written: three MX and an SPF TXT on the
return-path host, a DKIM TXT at `<selector>._domainkey`, and a DMARC TXT on the apex.

**An existing DMARC record is reported, never overwritten.** It states a policy for every mail
stream on the domain, so replacing `p=none` with `p=reject` would tell receivers to bounce
unauthenticated mail from senders that have nothing to do with this site. It appears under
`advisories` with both values, and the flow still reaches `ready`.

Destination-address verification is pollable: the address carries `status` and a `verified`
timestamp, so the surface updates on its own.

## Outbound TCP

Drupal reaches TCP through `Drupal\drupflare\Network\CfwTcp`, which declares a whole exchange and
reads the answer on a later invocation. `src/ops/tcp.ts` runs it between PHP invocations, over
[edgeport](https://github.com/gmitch215/edgeport). It shares the deferred HTTP tier's queue, cache
and retry budget.

| var               | default  | what it does                                            |
| ----------------- | -------- | ------------------------------------------------------- |
| `REDIS_URL`       | none     | `redis://user:pass@host:6379/0`, or `rediss://` for TLS |
| `SYSLOG_URL`      | none     | `syslog://collector:514`, or `syslogs://` for RFC 5425  |
| `SYSLOG_APP_NAME` | `drupal` | APP-NAME on every record this site ships                |

Both carry credentials, so both are secrets and neither is a `vars` entry, and neither can be set
from KV. A KV writer who could set `REDIS_URL` would receive whatever the site writes to it.

**The endpoint belongs to the deployment, and never to the caller.** Module code names a protocol and
an operation; the host supplies the host, port and credentials. Arbitrary `host:port` TCP behind any
code that can call a host function would be a port scanner and a protocol-smuggling surface.
Administrative Redis commands (`FLUSHALL`, `CONFIG`, `EVAL`, `SCRIPT`, `SHUTDOWN` and the rest of the
list in `src/ops/tcp.ts`) are refused before anything is dialled.

**A Redis cache backend cannot be built on this tier**, and it is served by a second one. A cache get
has to answer inside the request that asked, and a deferred exchange always misses the first time.
What this tier reaches is the deferrable half: a publish, a counter, a write nobody blocks on, or a
read a later request can use.

`syslog` is the shape this tier serves without compromise, because syslog over TCP never replies.

### The Parked Tier

`drupal/redis` works unmodified, over a second mechanism. A trapped socket call freezes PHP where it
stands, the Worker performs the exchange, and the call returns with the answer inside the same
request. Predis speaks RESP over `stream_socket_client`, and that is the shape the park suspends
under.

It arms only when `REDIS_URL` is set, and it dials that endpoint and no other: the host and port the
module asks for are checked for shape and then discarded, so a module that can build a string cannot
choose a destination. A request naming a port other than the configured one is refused. Any stream
the Worker did not open is handed back to PHP untouched, so arming does not disturb file writes in a
render.

**The Durable Object's own SQLite is still the faster cache backend and the recommended one.** A
parked get is a network round trip; a SQLite read is local. Measured from a Durable Object, a round
trip is 1 ms to a same-region server and 53 ms to a distant one, and every cache operation pays one.
Redis is here for a deployment that already has a server and wants Drupal pointed at it, not because
it is quicker. The status report says so on any site that enables the module.

A blocking outbound call over **HTTP** is served by replacing the transport rather than trapping it.
PHP reaches HTTPS through a stream wrapper the runtime invokes from inside a C frame, and a park under
one cannot resume, so Guzzle and Symfony's HTTP client are given a handler that yields from userland
instead. `drupal/openid_connect` completes a login through its own client that way. A call made from
inside an internal function such as `array_map` cannot park; it falls back to the deferred transport
rather than failing.

| var               | default | what it does                                                               |
| ----------------- | ------- | -------------------------------------------------------------------------- |
| `PARK`            | on      | whether the park may arm at all; anything but `1` routes renders around it |
| `SLEEP_BUDGET_MS` | 2,000   | total ms PHP may wait through the park per request; an alarm gets 15x      |

`sleep()`, `usleep()` and a Guzzle `delay` park for real, up to the budget. Past it, a sleep returns at
once and records how much it was short, so a retry loop never holds a visitor longer than a slow render.

## Workers AI

Inference is a queued tier over the same queue as outbound HTTP and TCP. A model call is declared,
run between PHP invocations, and read on a later one. `src/ops/ai.ts` runs it.

| binding or var | default        | what it does                                          |
| -------------- | -------------- | ----------------------------------------------------- |
| `AI`           | none           | the Workers AI binding; the tier is absent without it |
| `AI_MODELS`    | four model ids | comma-separated allow-list of model ids               |

The tier uses the binding. A REST call to `api.cloudflare.com` needs an `Authorization: Bearer`
header and the account id in its URL, which would put the account token in a queue row; the binding
carries its own authorisation.

**Neurons are a fourth meter.** 10,000 per day on Workers Free and Workers Paid alike, reset at
00:00 UTC, and exhaustion arrives as HTTP 429 with error 3036, never as a bill. Neither the serving
ceiling nor the regeneration ceiling sees it. `/ai` reports a projected cost per call, derived from
Cloudflare's published per-model rate and an approximate token count; the binding returns no metered
figure, so the projection is arithmetic and is labelled as such.

Measured on a deployed free-plan site: a `llama-3.3-70b` completion projects to 102.62 neurons, which
is **97 completions a day**. A `bge-m3` embedding of a short text projects to 0.01, and indexing 1,000
nodes at 500 tokens each is about 5% of one day. Embedding-backed search fits the free allocation;
chat completion overruns it.

### Two Catalogues

Cloudflare publishes two model lists and the difference matters to a site owner.

| catalogue                         | what it is                                                           |
| --------------------------------- | -------------------------------------------------------------------- |
| Workers AI, `/workers-ai/models/` | every entry Cloudflare-hosted; inference runs on Cloudflare hardware |
| unified AI catalog, `/ai/models/` | the above plus third-party models reached through AI Gateway         |

The extra entries on the unified catalogue are external providers (OpenAI, Anthropic, Google, xAI)
reached over AI Gateway and billed through it. A prompt sent to one leaves Cloudflare.

`Partner` is a separate axis. A Partner model on the Workers AI catalogue has proprietary weights and
still runs on Cloudflare hardware: Deepgram, Leonardo, Black Forest Labs and NVIDIA all appear there.
The privacy line runs between Cloudflare-hosted and external provider, and open-weight against
partner is a different line entirely.

`AI_MODELS` is the control. Its default list is Cloudflare-hosted only.

### What This Tier Does Not Do

**No inline AI in a render.** A block or field formatter calling a provider during a page render
holds the object across the round trip, which makes it ineligible for hibernation and bills as wall
clock. The surfaces this tier fits are the ones that already retry and already show progress:
generation on save, moderation, alt text, summarisation, and embedding on the cron path.

**No streaming.** The unit this queue carries is a finished response body.

## OIDC Login

A login is completed by the Worker. The callback is an ordinary request, so the token exchange and
the `id_token` signature check happen in JavaScript before PHP is entered, and PHP is handed a
decided result. `src/ops/oidc.ts` is the implementation.

This route needs no module. `drupal/openid_connect` also works, through its own client: the
`openssl_*` functions are bridged to the host's crypto and the token POST is parked. An unverified
`id_token` is an unauthenticated login either way, so both paths verify the signature.

| setting              | where      | what it does                                         |
| -------------------- | ---------- | ---------------------------------------------------- |
| `oidc_issuer`        | `cfw_meta` | the provider's issuer URL; https, or a loopback host |
| `oidc_client_id`     | `cfw_meta` | the client registered with that provider             |
| `OIDC_CLIENT_SECRET` | binding    | for a provider that issued one; a secret, not a var  |

The issuer and the client id sit in the object's own storage, and the secret is a binding. None of
the three can be set from KV: a writer who could change the issuer would point the consent screen at
a provider they control, and every login on the site would authenticate against it.

Plain http is refused except on a loopback host, which is what lets a provider run on the same machine
during development. A deployed Worker has no loopback to reach, so the exemption grants nothing there.

Register `https://<your-site>/oidc?action=callback` as the redirect URI. `/oidc` starts a login and
accepts an optional `return` path, which must be site-relative. It is a public route because a
provider's redirect carries no header this Worker controls; `state` is what authenticates it.

Completing a login also needs `drupal/externalauth` installed on the site, which is what maps the
verified identity onto an account.

`/setup/oidc` reads and writes the two `cfw_meta` values, and `/_cfw/access` is the page over it.

| action           | method | what it does                                                                   |
| ---------------- | ------ | ------------------------------------------------------------------------------ |
| `?action=status` | GET    | the issuer, the client id, whether the secret binding is set, the redirect URI |
| `?action=save`   | POST   | validates and stores the pair, then fetches the discovery document             |
| `?action=clear`  | GET    | forgets both, which turns login off                                            |

It is an **owner** route, so it takes the token minted at first run and refuses the admin page's
weaker gate. Reading which provider is configured is harmless; choosing it is not.

The issuer must be `https` and must carry no query or fragment: the discovery URL is built by
appending a fixed path, so an issuer carrying either produces a URL nobody intended. A trailing slash
is normalised away so that discovery and the later `iss` comparison agree on one spelling. Saving
fetches the discovery document immediately and reports what it advertises, so a wrong issuer surfaces
at configuration time, well before someone's first login. The secret is never read back.

**The claims never travel in a URL.** The browser carries a single-use ticket; the claims stay in the
object's storage and the row is deleted before they are returned, so a second presentation of the
same ticket finds nothing. A redirect lands in browser history, in a referrer and in any proxy log
on the path.

Five conditions refuse a login, each tested against real generated keys: a signature from a key
outside the provider's JWKS, an issuer that is not the configured one, an audience belonging to
another client of the same provider, an expired token, and a nonce from a different login. `none`
and the HMAC algorithms are refused by omission.

## Git Remotes

A site follows as many repositories as it is given. `src/ops/git-smart.ts` is the transport,
`src/ops/git-provider.ts` the provider layer above it, `src/ops/git-sync.ts` the layout and diff, and
`/_cfw/git` the page that drives all three.

### The Transport

Git's smart HTTP, so any host that serves a repository works. A poll is
`GET /info/refs?service=git-upload-pack` and a pull is `POST /git-upload-pack` for one commit at
depth 1; the packfile is parsed in the Worker, including both delta forms.

The provider APIs are a layer above it and the transport depends on none of them. `generic` uses no
API at all: branches and open requests both come out of the ref advertisement, since every provider
publishes `refs/pull/N/head` or `refs/merge-requests/N/head`.

| provider    | API                  | default host                |
| ----------- | -------------------- | --------------------------- |
| `github`    | REST v3              | `https://api.github.com`    |
| `gitlab`    | REST v4              | `https://gitlab.com`        |
| `bitbucket` | REST 2.0             | `https://api.bitbucket.org` |
| `gitea`     | REST v1, Forgejo too | none; the host is required  |
| `generic`   | none                 | none; the host is required  |

### Storage

| setting                 | where      | what it does                                      |
| ----------------------- | ---------- | ------------------------------------------------- |
| `git_remotes`           | `cfw_meta` | the configured remotes, as one JSON row           |
| `git_token_<id>`        | `cfw_meta` | the access token for one remote                   |
| `git_email_<id>`        | `cfw_meta` | the Atlassian account email, Bitbucket only       |
| `git_hooksecret_<id>`   | `cfw_meta` | the shared secret a delivery is verified against  |
| `git_head_<id>`         | `cfw_meta` | the sha the last poll saw                         |
| `git_installedsha_<id>` | `cfw_meta` | the sha whose files are actually mounted          |
| `git_interval_<id>`     | `cfw_meta` | poll cadence in minutes; `0` turns polling off    |
| `git_backoff_<id>`      | `cfw_meta` | epoch ms before which nothing polls this remote   |
| `git_previewof_<id>`    | `cfw_meta` | the request being previewed instead of the branch |

Module source lands in `cfw_module_file`, one row per file, with the remote id as the owning package.
That is the same table `composer require` writes to, which is what makes a conflict detectable.

All of it lives in the object's own storage and none of it can be set from KV: a writer who could
change a remote would point the site at a repository they control, and a writer who could read a
token would have push access to the operator's repository.

### Polling

The interval is per repository and defaults to 60 minutes, floored at 5. The alarm polls at most
three due remotes per firing, oldest first, so one slow remote cannot starve the others. A 429 sets a
backoff that honours `Retry-After` and otherwise doubles to an hour.

### Installing

`selectFiles()` keeps PHP, YAML, Twig, JavaScript and CSS, and drops `tests/`, `vendor/`,
`node_modules/`, `.github/` and dotfiles. Module names come from `*.info.yml`; a submodule inside
another module's tree stays where it is and is mounted once.

A module mounts under `modules/custom/<name>` unless the remote names a `mount`, a path inside
`modules`, `themes` or `profiles` such as `modules/mantle2`. A site that kept a module somewhere
else sets it so a pull updates the module where it already is instead of adding a second copy
beside it. It applies when the repository holds one module, and with several each keeps its
default. `/git?action=add&mount=` takes it, and a path with `..`, a dot segment, a leading slash or
a `core/` prefix is refused, both when it is added and on every pull.

`vendor/` is never delivered, so a module whose dependencies are bundled inside it keeps the ones
it was carried with, and a new dependency in a later commit has to arrive another way.

A pull is applied in one `transactionSync()` and then verified by booting the Drupal kernel. A boot
failure restores the previous file set and records the reason on the remote.

### What Gets Written Back

A **commit status** on the pushed sha: a state, a context, a description and a link. All three
providers support it and an access token can write it.

GitHub's Checks API carries annotations and per-line output, and only a GitHub App can write one. A
repository-scoped fine-grained token is refused with `Resource not accessible by personal access
token` on both check-run endpoints and accepted on the status endpoint, so the product writes commit
statuses.

| provider       | read the tree          | write a status           | create a webhook           |
| -------------- | ---------------------- | ------------------------ | -------------------------- |
| GitHub         | `Contents: read`       | `Commit statuses: write` | `Webhooks: write`          |
| GitLab         | `read_api`             | `api`                    | `api`, Maintainer or Owner |
| Bitbucket      | `repository:read`      | `repository:read`        | `webhook`                  |
| Gitea, Forgejo | `read:repository`      | `write:repository`       | `write:repository`         |
| Any git remote | read access over HTTPS | no API                   | register by hand           |

GitLab has no scope narrower than `api` for writing a status. Bitbucket has no personal access
token: an Atlassian API token authenticates as HTTP Basic with the account email as the username, so
its row on the page asks for one. A plain remote has nowhere to put a status, so `statusRequest()`
returns null for it.

Gitea takes `state` on the way in and answers `status` on the way out, which matters when reading a
status back through its API.

### Deliveries

`/githook?remote=<id>` receives them. It takes no credential this Worker controls, so the signature
is the whole of the authentication and an unverifiable delivery is refused.

| provider       | header                | what it proves                                           |
| -------------- | --------------------- | -------------------------------------------------------- |
| GitHub         | `X-Hub-Signature-256` | HMAC-SHA256 over the raw body                            |
| Gitea, Forgejo | `X-Hub-Signature-256` | the same scheme, verified the same way                   |
| Bitbucket      | `X-Hub-Signature`     | HMAC, method read from the header prefix                 |
| GitLab         | `webhook-signature`   | HMAC-SHA256, GitLab 19.0 and a feature flag              |
| GitLab         | `X-Gitlab-Token`      | the shared secret, in plaintext                          |
| Any git remote | `X-Hub-Signature-256` | accepted if the sender can produce it; refused otherwise |

GitLab installs before 19.0 send the secret in plaintext and cannot be HMAC-verified. Both forms are
accepted, and the page shows which one the last delivery used, since the two differ in what they
prove.

A push to the tracked branch installs the commit inline and writes the result back as a status. A
push to any other branch, a branch delete, and a push arriving while a request is being previewed all
record the head and stop there.

## Database Updates

`updb` slices Drupal's own update path across invocations. Every var here bounds one slice.

| var                       | default | what it does                                     |
| ------------------------- | ------- | ------------------------------------------------ |
| `UPDB_FLUSH_SPLIT`        | on      | split a cache flush across invocations           |
| `UPDB_ALLOW_UNBOUNDED`    | off     | permit an update with no measurable bound        |
| `UPDB_SNAPSHOT_MAX_ROWS`  | none    | rows a pre-update snapshot may hold              |
| `UPDB_RETRY_POLICY`       | none    | how a failed slice is retried                    |
| `UPDB_ON_ABORT`           | none    | what happens to a run that cannot continue       |
| `UPDB_MAX_ATTEMPTS`       | none    | attempts per slice                               |
| `UPDB_MAX_PASSES`         | none    | passes over the update list                      |
| `UPDB_MAX_COLD_WAITS`     | none    | consecutive cold-object waits tolerated          |
| `UPDB_MAX_BEATS`          | none    | alarm beats one run may consume                  |
| `UPDB_CHECK_REQUIREMENTS` | none    | run Drupal's own update requirements check first |

Read `src/ops/updb.ts` before changing any of these; the defaults are what a sliced update was
measured against.

## Pack Reconciliation

The pack delivers only at provisioning, so a fix that lands inside it reaches new sites and no
existing one. Reconciliation is the delivery path for the rest.

| var         | default | what it does                                            |
| ----------- | ------- | ------------------------------------------------------- |
| `RECONCILE` | on      | brings an existing site up to the pack that ships today |

Each step in `src/ops/reconcile.ts` carries an observation of the site's end state, asked before the
step runs and again afterwards. So a site provisioned after a fix answers `satisfied` and is marked
done without doing any work, and a step that ran and left the site still owing it is recorded as
failed rather than applied. A step gets three attempts before it stops being retried and stays
visible on the status report.

A step that changes configuration or state runs through Drupal's own writers rather than SQL.
`ConfigFactory::save()` already clears `cache_config` and invalidates `config:<name>`; a host
re-deriving that list gets it wrong, and the copy it forgets is the one that made the original
`cache.page.max_age` fix inert on every site.

Every applied step drops the heap image, unconditionally. A restored kernel predates whatever the
step just changed.

`GET /reconcile` reports every step and its standing. `POST /reconcile` drives one. The alarm chain
drives it on its own; the route is for an operator who wants a fix now rather than at the next
firing. Off is for a site being debugged against a known state, and leaving it off means a security
fix in the pack never arrives.

The D1 fleet inventory carries `reconcile_version` beside the pack generation. The pack generation
says which pack a site was provisioned from and never moves afterwards, so on its own it cannot tell
a patched old site from an unpatched one.

## The Addressable Sweep

Page coverage is demand-driven: a URL renders when a visitor asks for it, and that visitor waits.
The sweep enumerates the addressable space from the `router` table and the entity tables, ranks it,
and queues the top of the list for the fill batch that already exists.

| var                   | default | what it does                                   |
| --------------------- | ------- | ---------------------------------------------- |
| `SWEEP`               | off     | enumerate and queue uncovered addressable URLs |
| `SWEEP_ROWS_FRACTION` | 0.25    | share of the day's rows it may spend, 0.01-0.5 |

It never renders. Every path goes into the fill queue and the alarm's fill batch drains it under the
memory break it already has, so the sweep cannot be the batch that crosses the isolate limit.

The governor is the feature. It refuses below a remaining-budget floor, spends at most its declared
fraction of the day's rows and Durable Object requests, resumes tomorrow when spent, and carries a
cursor so a partial sweep does not repeat work. Enumeration reads the `router` table and the entity
tables and never crawls the site's own links, which would walk the facet and pager space and spend
the budget on URLs nobody requests.

Off by default for a meter reason rather than caution: the row and DO quotas are account-wide and a
site reads only its own, so four sweeping sites saturate the account while each one reads itself as
healthy. `src/ops/fleet.ts` is the inventory a fleet-aware share would read.

`GET /sweep` reports coverage and the governor's last decision, including the reason when it
declines. `GET /sweep?run=1` forces a step off its interval.

## Runtime Overrides

The names on `KV_OVERRIDABLE` can be overridden from the `CONFIG_KV` namespace under the key
`settings`, as one JSON object. One key covers them all: a single read is atomic, costs one of the
100,000 daily KV reads instead of one per lever, and gives an operator one place to see every
override in force.

```json
{ "RENDER_BUDGET_MS": 4000, "FILL_BATCH_SIZE": 8, "PREFILL": "0" }
```

`GET /settings` lists every lever with the value in force and where it came from.

### Writing Them

`GET /settings` reports every lever with its value and its source (`kv`, `var` or `default`);
`PUT /settings` merges a JSON patch. Both take the owner token.

```sh
curl -H "authorization: Bearer $OWNER_TOKEN" https://your-site/settings
curl -X PUT -H "authorization: Bearer $OWNER_TOKEN" -H 'content-type: application/json' \
  -d '{"RENDER_BUDGET_MS": 4000, "PREFILL": "0"}' https://your-site/settings
```

An unlisted name is refused and named in the reply rather than dropped in silence. The allow-list is
enforced at the writer as well as the reader: a reader-side filter makes an unlisted name inert, and a
writer-side filter makes it unstorable.

The route is answered by the front Worker with no object hop: `CONFIG_KV` is a front-Worker binding,
so reaching it through the Durable Object would spend a request to get at a namespace the isolate
already holds.

### From Drupal, Without the Owner Token

The same levers are editable at `/admin/config/drupflare/settings`, gated on the
`administer drupflare site` permission. Each field holds the stored override, with the deployed value
beside it and its source named, so an operator can tell an override they chose from a default nobody
has looked at. Only the fields that changed are sent, because a patch carrying every field would turn
a deployed value into a stored override by the act of pressing save.

Every lever has a domain, `LEVER_DOMAINS` in `src/ops/plan.ts`: a flag is `0` or `1`, a number has
the range its reader clamps to, and a fixed choice (`OPCACHE_MODE`, `MAIL_TRANSPORT`,
`SITE_LOCATION_HINT`) is one of its listed values. The form offers a select or a bounded number
field from it, and `writeSettings()` refuses a value outside it and names the reason, so a mistyped
value cannot reach a reader. `LAZY_FS_BUDGET_BYTES` accepts values up to 8 MiB.

### The Three Permissions

| permission                   | reaches                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `view drupflare status`      | the runtime status page, read only                             |
| `administer drupflare site`  | the levers, and the operations terminal's cache and queue work |
| `administer drupflare owner` | code delivery, including the terminal's `en` and package lines |

`administer drupflare owner` is granted at claim, through a `Site Owner` role given to the claimed
account, and only an account that already holds it can grant it. Holding `administer permissions` is
not enough: the permission forms disable its checkboxes, and a role or user save that adds or removes
it is put back when the acting user lacks it. An administrator role carries every permission, so
assigning one is the same grant. The owner token outranks all three and works when Drupal does not.

A site created before the tiers reconciles onto them: the five older names map to the three, and
uid 1 is given the owner role.

**`PLAN` is not on that form and cannot be written through it.** Every lever there has a worst case
of a slower site; `PLAN` selects a limits profile whose quotas are account-wide, while whoever
reaches a Drupal form administers one tenant. It stays on the owner-token route above, and the host
capability behind the form refuses it at every spelling.

`/admin/modules/drupflare` is the matching read-only page for code delivery: it names the three
delivery paths and lists what has been delivered to this site. Delivering code stays an owner action
on `/_cfw/git`, for the same tenancy reason. Within the operations terminal, `en` and any package
line additionally require `administer drupflare owner`, so a site can grant the terminal without
granting the ability to add code to the runtime.

The front Worker and the Durable Object each hold their own copy of the bindings, so the overrides are
applied inside the object too. `adoptSettings()` overlays every name on the allow-list in the object,
and it runs from `alarm()` as well as `handle()`, because several levers are read on the fill chain and
an alarm never passes through `handle()`. The fast storage lane adopts nothing: it is await-free by
construction and reads no lever.

A lever is consulted from KV before its var. An operator can change a setting without a redeploy, and
the var is the fallback.

**The list is an allow-list and it is a privilege boundary.** KV is operator-writable, so merging an
arbitrary object into the environment would let anyone with KV write set `PW_DIAGNOSTICS=1`. Every
name here is a performance lever whose worst case is a slow site; none changes what is reachable.
`PLAN` has its own key, its own resolver and its own authorisation, because it selects a whole
profile. `writeSettings()` refuses it at any spelling: every other name has a worst case of a slow
site, while the quotas `PLAN` models are account-wide and the actor setting it is one tenant. The mail credentials
are absent for the same reason: `MAIL_TRANSPORT` only chooses between transports the deploy already
configured, while a KV writer who could set `SMTP_HOST` would receive every password-reset link the
site sends.

A malformed document, an unknown key and a KV error all yield no overrides, and none of them throws.
Values are read once per isolate per minute.

## R2 Page Origin Caching

Mirroring pages to R2 moves them off the Worker, and an R2 public bucket on a custom domain serves
them. How much of that traffic Cloudflare's CDN absorbs in front of the bucket decides whether the
off-Worker lever is worth anything: an absorbed read costs neither a Worker request nor an R2 Class B
operation.

**Absorption is 0 without a Cache Rule and about 7/8 with one.** Measured with GET against
a cold object each time:

| Condition                   | Result                       |
| --------------------------- | ---------------------------- |
| Cache Rule on, cold object  | MISS, then **7 / 7 HIT**     |
| Cache Rule off, cold object | MISS, then **7 / 7 DYNAMIC** |

A second object under the same rule read 1 MISS, 7 HIT and 2 DYNAMIC across 10 requests, which is the
same picture with two requests landing at a PoP that had not filled yet.

**Measure with GET, never `curl -I`.** HEAD is what `curl -I` sends, Cloudflare does not populate its
cache from a HEAD, and every reading comes back `DYNAMIC`.

### The Cache Rule

One rule, scoped to the CDN hostname and nothing else:

```text
expression:        (http.host eq "drupflare-cdn.example.com")
action:            set_cache_settings
action_parameters: { "cache": true, "edge_ttl": { "mode": "override_origin", "default": 3600 } }
```

In the dashboard it is **Caching > Cache Rules > Create rule**, with the hostname as the only
condition and **Eligible for cache** plus an edge TTL override. Over the API it is
`PUT /zones/{ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint`.

**A PUT to an entrypoint replaces every rule in it.** Read the entrypoint first and merge; on a zone
that has never had a cache-phase ruleset the entrypoint does not exist yet and creating it destroys
nothing.

**One zone-scoped permission creates it: `Zone > Cache Rules > Edit`.** Cloudflare's documentation
also lists the account-scoped `Account Rulesets: Edit` and `Account Filter Lists: Edit`. This rule
shape needs neither.

### Smart Tiered Cache

Every PoP fills independently, so a request reaching a cold PoP is a MISS and an R2 Class B read.
Tiering routes a PoP miss through an upper tier instead of to the bucket, which changes absorption
from per-PoP to hierarchical.

Enable it at **Caching > Tiered Cache**, or:

```sh
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/cache/tiered_cache_smart_topology_enable" \
  --request PATCH \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --json '{ "value": "on" }'
```

The token needs `Zone Settings Write` or `Zone Write`. Tiered Cache and Smart Topology are both
available on the Free plan; Generic Global, Regional and Custom topologies are Enterprise only.
Cloudflare selects the upper tier automatically for a zone using R2 as an origin.

### Absorption in the Model

`cdnAbsorption` in `scripts/measure/free-envelope.ts` defaults to **0**.

Absorption follows the traffic. It depends on reads per colo per TTL window, so a site with few views
spread over many PoPs absorbs almost nothing, and the same site at high traffic absorbs nearly
everything. Zero is the floor for a low-traffic site and for any site with no rule.

`cdnAbsorption` is a code-level option. The command line takes `--visits`, `--dynamic` and `--warmth`
only; absorption is passed to `envelope()`, `optimalOffWorker()` and `scoreWorkload()` in
`scripts/measure/free-envelope.ts`.

Drupflare does not create the Cache Rule. It changes a zone the operator owns, and the model's default
stays at 0 until an operator applies the rule.

## Related

- [Repository layout](repository-layout.md): every path outside `src/` and how it arrives
- [Building from source](building-from-source.md): how a source build runs
- [Measurement classes](measurement-classes.md): which instrument may produce which class of number
- [Recovery](recovery.md): which primitive answers which failure
- [External database](external-database.md): why the site database lives in the Durable Object
