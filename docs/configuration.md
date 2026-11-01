# Configuration

Every setting is a `vars` entry or a binding in `wrangler.jsonc`, and every one has a working
default. A deploy that sets nothing beyond what the canonical config already carries serves a site.

Values arrive from wrangler as strings, so a boolean is `"1"` or `"0"` and a number is a decimal
string. An unparseable value falls back to the default and never throws: these are read on the
serving path, and a typo must not take a site down.

Three layers decide what a value is, most specific first:

1. **A request parameter**, where the route exposes one (`?prefill=`, `?all=1`).
2. **The `CONFIG_KV` namespace**, for the plan and the runtime levers on
   [Runtime Overrides](configuration-operations.md#runtime-overrides). No redeploy needed.
3. **The `vars` entry**, then the per-plan default in `src/ops/plan-profile.ts`, then the constant.

## Variable Index

Every variable and binding on the configuration pages, once each.

| Variable                        | Default                               | Page                                                    |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| `SITE`                          | binding                               | [Configuration](configuration.md)                       |
| `ASSETS`                        | binding                               | [Configuration](configuration.md)                       |
| `CONFIG_KV`                     | binding                               | [Configuration](configuration.md)                       |
| `FLEET_DB`                      | binding                               | [Configuration](configuration.md)                       |
| `FILES`                         | binding                               | [Configuration](configuration.md)                       |
| `CF_VERSION_METADATA`           | binding                               | [Configuration](configuration.md)                       |
| `PAGE_KV`                       | binding                               | [Configuration](configuration.md)                       |
| `RENDER_LANES`                  | binding                               | [Configuration](configuration.md)                       |
| `SEND_EMAIL`                    | binding                               | [Configuration](configuration.md)                       |
| `CMS`                           | none, required at build               | [Configuration](configuration.md)                       |
| `SITE_ID`                       | derived, then `site`                  | [Configuration](configuration.md#site_id)               |
| `SITE_ID_PORTS`                 | `keep`                                | [Configuration](configuration.md#site_id_ports)         |
| `SITE_ORIGIN`                   | pinned on first use                   | [Configuration](configuration.md#site_origin)           |
| `SITE_LOCATION_HINT`            | unset                                 | [Configuration](configuration.md#site_location_hint)    |
| `PLAN`                          | `free`                                | [Configuration](configuration.md)                       |
| `DRUPAL_ENV_<NAME>`             | unset                                 | [Configuration](configuration.md)                       |
| `DRUPAL_CONFIG`                 | unset                                 | [Configuration](configuration.md)                       |
| `DRUPAL_SETTINGS`               | unset                                 | [Configuration](configuration.md)                       |
| `RESPONSE_HEADERS`              | unset                                 | [Configuration](configuration.md)                       |
| `REDIRECTS`                     | unset                                 | [Configuration](configuration.md)                       |
| `PW_DIAGNOSTICS`                | off                                   | [Configuration](configuration.md#pw_diagnostics)        |
| `PHP_LOG_LEVEL`                 | `info`                                | [Configuration](configuration.md#php_log_level)         |
| `PW_SQL_TRACE`                  | off                                   | [Configuration](configuration.md#pw_sql_trace)          |
| `PW_SQL_TRACE_FROM`             | 0                                     | [Configuration](configuration.md)                       |
| `MEMORY_TRACE`                  | off                                   | [Configuration](configuration.md)                       |
| `GEN_BUCKET_MS`                 | 5,000                                 | [Serving](configuration-serving.md)                     |
| `MAX_BODY_BYTES`                | 2 MiB                                 | [Serving](configuration-serving.md#max_body_bytes)      |
| `MAX_UPLOAD_BYTES`              | 100 MiB                               | [Serving](configuration-serving.md)                     |
| `OUTBOUND_GUARD`                | on                                    | [Serving](configuration-serving.md#outbound_guard)      |
| `PAGE_KV_ENABLED`               | on                                    | [Serving](configuration-serving.md)                     |
| `PAGE_KV_TTL`                   | 86,400                                | [Serving](configuration-serving.md)                     |
| `KV_WRITES_PER_DAY`             | per plan                              | [Serving](configuration-serving.md)                     |
| `EDGE_PLAN`                     | on                                    | [Serving](configuration-serving.md#edge_plan)           |
| `CSP_MODE`                      | per plan                              | [Serving](configuration-serving.md)                     |
| `SPOOL`                         | per plan                              | [Serving](configuration-serving.md)                     |
| `SPOOL_IMAGES`                  | on                                    | [Serving](configuration-serving.md)                     |
| `SPOOL_VIDEO`                   | on                                    | [Serving](configuration-serving.md)                     |
| `SPOOL_EMBEDS`                  | on                                    | [Serving](configuration-serving.md)                     |
| `NEVER_STALE`                   | unset                                 | [Serving](configuration-serving.md#never_stale)         |
| `AGED_SERVE_MAX_MS`             | 60,000                                | [Serving](configuration-serving.md)                     |
| `ASSET_AGGREGATES`              | unset                                 | [Serving](configuration-serving.md#asset_aggregates)    |
| `MEMORY_CACHE_BINS`             | unset                                 | [Serving](configuration-serving.md#memory_cache_bins)   |
| `MEMORY_CACHE_MAX_ITEMS`        | 64                                    | [Serving](configuration-serving.md)                     |
| `RENDER_BUDGET_MS`              | per plan                              | [Serving](configuration-serving.md)                     |
| `FILL_BATCH_SIZE`               | per plan                              | [Serving](configuration-serving.md)                     |
| `WINDOW_SITES`                  | unset                                 | [Serving](configuration-serving.md)                     |
| `WINDOW_MAX_FILLS`              | 50                                    | [Serving](configuration-serving.md)                     |
| `WINDOW_WALL_MS`                | 60,000                                | [Serving](configuration-serving.md)                     |
| `PREFILL`                       | on for free, off for paid             | [Serving](configuration-serving.md)                     |
| `PREFILL_ON_SAVE`               | on                                    | [Serving](configuration-serving.md)                     |
| `PREFILL_ON_SAVE_LIMIT`         | 25                                    | [Serving](configuration-serving.md)                     |
| `SAVE_DEBOUNCE_MS`              | 2000                                  | [Serving](configuration-serving.md)                     |
| `MIRROR_LIMIT`                  | per plan                              | [Serving](configuration-serving.md)                     |
| `R2_WRITES_PER_MONTH`           | 900000                                | [Serving](configuration-serving.md)                     |
| `HTTP_DRAIN_ON_ALARM`           | on                                    | [Serving](configuration-serving.md)                     |
| `HTTP_DRAIN_LIMIT`              | per plan                              | [Serving](configuration-serving.md)                     |
| `FILES_PUBLIC_URL`              | unset                                 | [Serving](configuration-serving.md#files_public_url)    |
| `IMAGE_ENGINE`                  | `tinyimg`                             | [Serving](configuration-serving.md#image_engine)        |
| `EAGER_DERIVATIVES`             | on                                    | [Serving](configuration-serving.md)                     |
| `DRUPAL_CRON`                   | on                                    | [Runtime](configuration-runtime.md)                     |
| `CRON_INTERVAL_MS`              | 900,000                               | [Runtime](configuration-runtime.md)                     |
| `CRON_MAX_UNITS`                | 6                                     | [Runtime](configuration-runtime.md)                     |
| `CRON_MAX_ROWS`                 | 500                                   | [Runtime](configuration-runtime.md)                     |
| `CRON_MAX_MS`                   | 500                                   | [Runtime](configuration-runtime.md)                     |
| `CRON_QUEUE_BATCH_SIZE`         | 5                                     | [Runtime](configuration-runtime.md)                     |
| `UPDATE_FETCH_URL`              | unset                                 | [Runtime](configuration-runtime.md)                     |
| `GC_INTERVAL_MS`                | 3,600,000                             | [Runtime](configuration-runtime.md)                     |
| `CACHE_DATA_MAX_ROWS`           | 5,000                                 | [Runtime](configuration-runtime.md)                     |
| `WATCHDOG_ROW_LIMIT`            | unset                                 | [Runtime](configuration-runtime.md)                     |
| `KEEP_WARM_MS`                  | 240,000                               | [Runtime](configuration-runtime.md)                     |
| `SITE_WARM`                     | by plan                               | [Runtime](configuration-runtime.md)                     |
| `WARM_INTERVAL_MS`              | 8,000                                 | [Runtime](configuration-runtime.md)                     |
| `WARM_CEILING_MS`               | unset                                 | [Runtime](configuration-runtime.md)                     |
| `RECYCLE_ABOVE_BYTES`           | 117440512                             | [Runtime](configuration-runtime.md)                     |
| `ISOLATE_ABOVE_BYTES`           | 130023424                             | [Runtime](configuration-runtime.md)                     |
| `FILL_SETTLE_MS`                | 60,000                                | [Runtime](configuration-runtime.md)                     |
| `RETAIN_INTERPRETER`            | on                                    | [Runtime](configuration-runtime.md)                     |
| `HEAP_SNAPSHOT`                 | on                                    | [Runtime](configuration-runtime.md)                     |
| `HEAP_IMAGE`                    | off                                   | [Runtime](configuration-runtime.md)                     |
| `BOOT_IMAGE`                    | off                                   | [Runtime](configuration-runtime.md)                     |
| `BOOT_IMAGE_BAKE`               | off                                   | [Runtime](configuration-runtime.md)                     |
| `HEAP_RESTORE_CHUNKS`           | all at once                           | [Runtime](configuration-runtime.md)                     |
| `LAZY_MOUNT`                    | `1` in the canonical config           | [Runtime](configuration-runtime.md)                     |
| `LAZY_FS_BUDGET_BYTES`          | 20 MiB, 4 MiB in the canonical config | [Runtime](configuration-runtime.md)                     |
| `SITE_DB_PREFIX`                | the packed default                    | [Runtime](configuration-runtime.md)                     |
| `SQL_CHUNK_PREFIX`              | `drupal-sql`                          | [Runtime](configuration-runtime.md)                     |
| `MIGRATE_ENGINE`                | `sql`                                 | [Runtime](configuration-runtime.md)                     |
| `MIGRATE_SELF_DRIVE`            | on                                    | [Runtime](configuration-runtime.md)                     |
| `MIGRATE_CHUNKS_PER_INVOCATION` | 40 on free, all on paid               | [Runtime](configuration-runtime.md)                     |
| `OPCACHE_MODE`                  | off                                   | [Runtime](configuration-runtime.md#opcache_mode)        |
| `ARGON2`                        | off                                   | [Runtime](configuration-runtime.md#argon2)              |
| `SHELL_ASSEMBLY`                | on                                    | [Runtime](configuration-runtime.md#shell_assembly)      |
| `REPLICA_COUNT`                 | 0                                     | [Replicas](configuration-replicas.md#replica_count)     |
| `REPLICA_AUTOSCALE`             | on                                    | [Replicas](configuration-replicas.md#replica_autoscale) |
| `REPLICA_MAX_LANES`             | 32                                    | [Replicas](configuration-replicas.md#replica_max_lanes) |
| `WRITE_FORWARD`                 | on                                    | [Replicas](configuration-replicas.md#write_forward)     |
| `REPLICA_LAG_MS`                | 30,000                                | [Replicas](configuration-replicas.md#replica_lag_ms)    |
| `REPLICA_READ_ONLY`             | off                                   | [Replicas](configuration-replicas.md)                   |
| `UPDB_FLUSH_SPLIT`              | on                                    | [Operations](configuration-operations.md)               |
| `UPDB_ALLOW_UNBOUNDED`          | off                                   | [Operations](configuration-operations.md)               |
| `UPDB_SNAPSHOT_MAX_ROWS`        | none                                  | [Operations](configuration-operations.md)               |
| `UPDB_RETRY_POLICY`             | none                                  | [Operations](configuration-operations.md)               |
| `UPDB_ON_ABORT`                 | none                                  | [Operations](configuration-operations.md)               |
| `UPDB_MAX_ATTEMPTS`             | none                                  | [Operations](configuration-operations.md)               |
| `UPDB_MAX_PASSES`               | none                                  | [Operations](configuration-operations.md)               |
| `UPDB_MAX_COLD_WAITS`           | none                                  | [Operations](configuration-operations.md)               |
| `UPDB_MAX_BEATS`                | none                                  | [Operations](configuration-operations.md)               |
| `UPDB_CHECK_REQUIREMENTS`       | none                                  | [Operations](configuration-operations.md)               |
| `RECONCILE`                     | on                                    | [Operations](configuration-operations.md)               |
| `SWEEP`                         | off                                   | [Operations](configuration-operations.md)               |
| `SWEEP_ROWS_FRACTION`           | 0.25                                  | [Operations](configuration-operations.md)               |
| `MAIL_TRANSPORT`                | `auto`                                | [Integrations](configuration-integrations.md)           |
| `MAIL_FROM`                     | none                                  | [Integrations](configuration-integrations.md)           |
| `MAIL_DRAIN_ON_ALARM`           | on                                    | [Integrations](configuration-integrations.md)           |
| `MAIL_DRAIN_LIMIT`              | 5                                     | [Integrations](configuration-integrations.md)           |
| `CF_EMAIL_ACCOUNT_ID`           | none                                  | [Integrations](configuration-integrations.md)           |
| `CF_EMAIL_TOKEN`                | none                                  | [Integrations](configuration-integrations.md)           |
| `SMTP_HOST`                     | none                                  | [Integrations](configuration-integrations.md)           |
| `SMTP_PORT`                     | 587/465                               | [Integrations](configuration-integrations.md)           |
| `SMTP_TLS`                      | starttls                              | [Integrations](configuration-integrations.md)           |
| `SMTP_USER`                     | none                                  | [Integrations](configuration-integrations.md)           |
| `SMTP_PASS`                     | none                                  | [Integrations](configuration-integrations.md)           |
| `SMTP_AUTH`                     | `PLAIN`                               | [Integrations](configuration-integrations.md)           |
| `REDIS_URL`                     | none                                  | [Integrations](configuration-integrations.md)           |
| `SYSLOG_URL`                    | none                                  | [Integrations](configuration-integrations.md)           |
| `SYSLOG_APP_NAME`               | `drupal`                              | [Integrations](configuration-integrations.md)           |
| `PARK`                          | on                                    | [Integrations](configuration-integrations.md)           |
| `SLEEP_BUDGET_MS`               | 2,000                                 | [Integrations](configuration-integrations.md)           |
| `AI`                            | none                                  | [Integrations](configuration-integrations.md)           |
| `AI_MODELS`                     | four model ids                        | [Integrations](configuration-integrations.md)           |
| `OIDC_CLIENT_SECRET`            | binding                               | [Integrations](configuration-integrations.md)           |

## Pages

- [Serving and caching](configuration-serving.md): page tiers, static assets, limits, prefill, files and images.
- [Runtime](configuration-runtime.md): cron, warming, the interpreter lifecycle, boot and storage.
- [Replicas](configuration-replicas.md): replica lanes and pool sizing.
- [Operations](configuration-operations.md): maintenance, database updates, reconciliation and runtime overrides.
- [Integrations](configuration-integrations.md): mail, outbound TCP, Workers AI, OIDC login and spool.

## Bindings

`wrangler.jsonc` is the canonical config and declares seven of the nine. `FILES` and `SEND_EMAIL` are
the two it leaves out.

| binding               | kind             | canonical config | what breaks without it                                                               |
| --------------------- | ---------------- | ---------------- | ------------------------------------------------------------------------------------ |
| `SITE`                | Durable Object   | declared         | the Worker has nothing to proxy to; every request fails                              |
| `ASSETS`              | Workers Assets   | declared         | no pack, no driver, no `/core/**`; an object cannot boot                             |
| `CONFIG_KV`           | KV               | declared         | the plan override and the runtime levers are absent; the deployed vars stay in force |
| `FLEET_DB`            | D1               | declared         | the cross-site inventory is absent; a single site does not need one                  |
| `FILES`               | R2               | not declared     | the page and file mirror drains nothing; the off-Worker serving path is unavailable  |
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
| `SITE_ID_PORTS`      | `keep`               | whether a port is part of a site id derived from the hostname  |
| `SITE_ORIGIN`        | pinned on first use  | the `scheme://host[:port]` Drupal builds absolute URLs against |
| `SITE_LOCATION_HINT` | unset                | which region the site's Durable Object is created in           |

### `SITE_ID`

One object per site, and the object's name is the site identity, so a wrong answer here serves a
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

### `SITE_ID_PORTS`

`keep` or `strip`. `keep` is the default: a non-default port is part of a derived site id, so
`example.com:8443` and `example.com` are two sites, as they are on a standalone workerd node that
serves different sites on different ports. `strip` drops any port, which is right on Cloudflare,
where a hostname is one site and the platform proxies extra ports (8443, 2053 and others) to it;
under `keep` each one creates a site object that holds an alarm chain and no visitors. The canonical
`wrangler.jsonc` sets `strip`. An id derived from a default-port host is the same under both values,
and a KV mapping, `SITE_ID` or the deployment's primary site is unaffected. Do not set `strip` on
a node that has sites on non-default ports, since their ids would change.

The KV reads in the chain (the host mapping and the deployment document) wait at most 2 seconds. A
read that does not answer uses the last value this isolate saw, or falls through as a failed read
does.

Spec: `tests/unit/ops/site-id.spec.ts`.

### `SITE_LOCATION_HINT`

One of `wnam enam sam weur eeur apac apac-ne apac-se oc afr me`, or unset.

Unset by default. Placement follows the first request a site answers, which for a deploy-button site
is wherever the deployer was. Pinning a region on an owner's behalf trades latency for one audience
against latency for every other, so the choice belongs to whoever knows the audience.

It applies when the object is created. Cloudflare ignores it for an object that already exists,
so setting it on a running site moves nothing.

An unrecognised value is ignored. The value reaches `SITE.get()` on the serving path, and a hint the
platform rejects would take the site down for the sake of a preference.

KV-overridable through the `settings` key, so a region can be chosen without a redeploy.

### `SITE_ORIGIN`

Every absolute URL Drupal emits is built from the origin: the canonical tag, a form action, a
`Location:`, the link in a password-reset mail.

The inbound `Host` carries no guarantee: an attacker who can set it can move a password-reset link
onto a host they control. So the origin is a property of the site, resolved in
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

`paid` and `free` are the only recognised values, and anything unrecognised is free: every limit
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

`/enable` is not needed for a text asset a migrated module ships: a `.css`, `.js` or `.svg` file
stored in `cfw_module_file` is served from `/modules`, `/themes`, `/profiles` and `/libraries` when
the pack does not hold the path. Binary assets are not served this way, because the table stores
source as text.

A migrated site claims with `POST /firstrun` and a body of `{"migrated": true}`. That mints the owner
token and marks the site claimed without changing uid 1, the site name or any mail setting. It takes no
`adminPass`, and an already claimed site answers 409.

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

## Related

- [Repository layout](repository-layout.md): every path outside `src/` and how it arrives
- [Building from source](building-from-source.md): how a source build runs
- [Measurement classes](measurement-classes.md): which instrument may produce which class of number
- [Recovery](recovery.md): which primitive answers which failure
- [External database](external-database.md): why the site database lives in the Durable Object
