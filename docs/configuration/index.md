# Configuration

Every setting is a `vars` entry or a binding in `wrangler.jsonc`, and every one has a working
default. A deploy that sets nothing beyond what the canonical config already carries serves a site.

Values arrive from wrangler as strings, so a boolean is `"1"` or `"0"` and a number is a decimal
string. An unparseable value falls back to the default and never throws: these are read on the
serving path, and a typo must not take a site down.

Three layers decide what a value is, most specific first:

1. **A request parameter**, where the route exposes one (`?prefill=`, `?all=1`).
2. **The `CONFIG_KV` namespace**, for the plan and the runtime levers on
   [Runtime Overrides](operations/overrides.md#runtime-overrides). No redeploy needed.
3. **The `vars` entry**, then the per-plan default in `src/ops/plan-profile.ts`, then the constant.

## Pages

- [Site Identity and Origin Settings](site-identity.md): the CMS selector, site id, location hint and origin.
- [Plan and Extensibility Routes](plan-and-routes.md): the plan variable and the extensibility routes.
- [Migrated Project Settings](migrated-settings.md): settings a migrated project carries over from its old host.
- [Diagnostics](diagnostics.md): diagnostic variables and logging.
- [Serving and Caching](serving/index.md): page tiers, static assets, limits, prefill, files and images.
- [Runtime](runtime.md): cron, warming, the interpreter lifecycle, boot and storage.
- [Replicas](replicas.md): replica lanes and pool sizing.
- [Operations](operations/index.md): maintenance, owner access, database updates, reconciliation and runtime overrides.
- [Integrations](integrations/index.md): mail, outbound TCP, Workers AI, OIDC login and Spool.

## Variable Index

Every variable and binding on the configuration pages, once each.

| Variable                        | Default                               | Page                                                     |
| ------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| `SITE`                          | binding                               | [Configuration](index.md)                                |
| `ASSETS`                        | binding                               | [Configuration](index.md)                                |
| `CONFIG_KV`                     | binding                               | [Configuration](index.md)                                |
| `FLEET_DB`                      | binding                               | [Configuration](index.md)                                |
| `FILES`                         | binding                               | [Configuration](index.md)                                |
| `FILES_PRIVATE`                 | binding                               | [Configuration](index.md)                                |
| `CF_VERSION_METADATA`           | binding                               | [Configuration](index.md)                                |
| `PAGE_KV`                       | binding                               | [Configuration](index.md)                                |
| `RENDER_LANES`                  | binding                               | [Configuration](index.md)                                |
| `SEND_EMAIL`                    | binding                               | [Configuration](index.md)                                |
| `CMS`                           | none, required at build               | [Configuration](index.md)                                |
| `SITE_ID`                       | derived, then `site`                  | [Configuration](site-identity.md#site_id)                |
| `SITE_ID_PORTS`                 | `keep`                                | [Configuration](site-identity.md#site_id_ports)          |
| `SITE_ORIGIN`                   | pinned on first use                   | [Configuration](site-identity.md#site_origin)            |
| `SITE_LOCATION_HINT`            | unset                                 | [Configuration](site-identity.md#site_location_hint)     |
| `PLAN`                          | `free`                                | [Configuration](index.md)                                |
| `DRUPAL_ENV_<NAME>`             | unset                                 | [Configuration](index.md)                                |
| `DRUPAL_CONFIG`                 | unset                                 | [Configuration](index.md)                                |
| `DRUPAL_SETTINGS`               | unset                                 | [Configuration](index.md)                                |
| `RESPONSE_HEADERS`              | unset                                 | [Configuration](index.md)                                |
| `REDIRECTS`                     | unset                                 | [Configuration](index.md)                                |
| `PW_DIAGNOSTICS`                | off                                   | [Configuration](diagnostics.md#pw_diagnostics)           |
| `PHP_LOG_LEVEL`                 | `info`                                | [Configuration](diagnostics.md#php_log_level)            |
| `PW_SQL_TRACE`                  | off                                   | [Configuration](diagnostics.md#pw_sql_trace)             |
| `PW_SQL_TRACE_FROM`             | 0                                     | [Configuration](index.md)                                |
| `MEMORY_TRACE`                  | off                                   | [Configuration](index.md)                                |
| `GEN_BUCKET_MS`                 | 5,000                                 | [Serving](serving/index.md)                              |
| `MAX_BODY_BYTES`                | 2 MiB                                 | [Serving](serving/request-limits.md#max_body_bytes)      |
| `MAX_UPLOAD_BYTES`              | 100 MiB                               | [Serving](serving/index.md)                              |
| `OUTBOUND_GUARD`                | on                                    | [Serving](serving/request-limits.md#outbound_guard)      |
| `PAGE_KV_ENABLED`               | on                                    | [Serving](serving/index.md)                              |
| `PAGE_KV_TTL`                   | 86,400                                | [Serving](serving/index.md)                              |
| `KV_WRITES_PER_DAY`             | per plan                              | [Serving](serving/index.md)                              |
| `EDGE_PLAN`                     | on                                    | [Serving](serving/page-cache.md#edge_plan)               |
| `CACHE_API`                     | on                                    | [Configuration](index.md#the-managed-config)             |
| `CSP_MODE`                      | per plan                              | [Serving](serving/index.md)                              |
| `SPOOL`                         | per plan                              | [Serving](serving/index.md)                              |
| `SPOOL_IMAGES`                  | on                                    | [Serving](serving/index.md)                              |
| `SPOOL_VIDEO`                   | on                                    | [Serving](serving/index.md)                              |
| `SPOOL_EMBEDS`                  | on                                    | [Serving](serving/index.md)                              |
| `NEVER_STALE`                   | unset                                 | [Serving](serving/page-cache.md#never_stale)             |
| `AGED_SERVE_MAX_MS`             | 60,000                                | [Serving](serving/index.md)                              |
| `ASSET_AGGREGATES`              | unset                                 | [Serving](serving/static-assets.md#asset_aggregates)     |
| `MEMORY_CACHE_BINS`             | unset                                 | [Serving](serving/page-cache.md#memory_cache_bins)       |
| `MEMORY_CACHE_MAX_ITEMS`        | 64                                    | [Serving](serving/index.md)                              |
| `RENDER_BUDGET_MS`              | per plan                              | [Serving](serving/index.md)                              |
| `FILL_BATCH_SIZE`               | per plan                              | [Serving](serving/index.md)                              |
| `WINDOW_SITES`                  | unset                                 | [Serving](serving/index.md)                              |
| `WINDOW_MAX_FILLS`              | 50                                    | [Serving](serving/index.md)                              |
| `WINDOW_WALL_MS`                | 60,000                                | [Serving](serving/index.md)                              |
| `PREFILL`                       | on for free, off for paid             | [Serving](serving/index.md)                              |
| `PREFILL_ON_SAVE`               | on                                    | [Serving](serving/index.md)                              |
| `PREFILL_ON_SAVE_LIMIT`         | 25                                    | [Serving](serving/index.md)                              |
| `SAVE_DEBOUNCE_MS`              | 2000                                  | [Serving](serving/index.md)                              |
| `MIRROR_LIMIT`                  | per plan                              | [Serving](serving/index.md)                              |
| `R2_WRITES_PER_MONTH`           | 900000                                | [Serving](serving/index.md)                              |
| `HTTP_DRAIN_ON_ALARM`           | on                                    | [Serving](serving/index.md)                              |
| `HTTP_DRAIN_LIMIT`              | per plan                              | [Serving](serving/index.md)                              |
| `FILES_PUBLIC_URL`              | unset                                 | [Serving](serving/files-and-images.md#files_public_url)  |
| `FILE_STORE`                    | unset; `r2` on the managed config     | [Serving](serving/files-and-images.md#the-r2-file-store) |
| `FILE_EVICT_AFTER_MS`           | 900000                                | [Serving](serving/files-and-images.md#the-r2-file-store) |
| `IMAGE_ENGINE`                  | `tinyimg`                             | [Serving](serving/files-and-images.md#image_engine)      |
| `EAGER_DERIVATIVES`             | on                                    | [Serving](serving/index.md)                              |
| `DRUPAL_CRON`                   | on                                    | [Runtime](runtime.md)                                    |
| `CRON_INTERVAL_MS`              | 900,000                               | [Runtime](runtime.md)                                    |
| `CRON_MAX_UNITS`                | 6                                     | [Runtime](runtime.md)                                    |
| `CRON_MAX_ROWS`                 | 500                                   | [Runtime](runtime.md)                                    |
| `CRON_MAX_MS`                   | 500                                   | [Runtime](runtime.md)                                    |
| `CRON_QUEUE_BATCH_SIZE`         | 5                                     | [Runtime](runtime.md)                                    |
| `UPDATE_FETCH_URL`              | unset                                 | [Runtime](runtime.md)                                    |
| `GC_INTERVAL_MS`                | 3,600,000                             | [Runtime](runtime.md)                                    |
| `CACHE_DATA_MAX_ROWS`           | 5,000                                 | [Runtime](runtime.md)                                    |
| `WATCHDOG_ROW_LIMIT`            | unset                                 | [Runtime](runtime.md)                                    |
| `KEEP_WARM_MS`                  | 240,000                               | [Runtime](runtime.md)                                    |
| `SITE_WARM`                     | by plan                               | [Runtime](runtime.md)                                    |
| `WARM_INTERVAL_MS`              | 8,000                                 | [Runtime](runtime.md)                                    |
| `WARM_CEILING_MS`               | unset                                 | [Runtime](runtime.md)                                    |
| `IDLE_CEILING_MS`               | unset                                 | [Runtime](runtime.md)                                    |
| `RECYCLE_ABOVE_BYTES`           | 117440512                             | [Runtime](runtime.md)                                    |
| `ISOLATE_ABOVE_BYTES`           | 130023424                             | [Runtime](runtime.md)                                    |
| `FILL_SETTLE_MS`                | 60,000                                | [Runtime](runtime.md)                                    |
| `RETAIN_INTERPRETER`            | on                                    | [Runtime](runtime.md)                                    |
| `HEAP_SNAPSHOT`                 | on                                    | [Runtime](runtime.md)                                    |
| `HEAP_IMAGE`                    | off                                   | [Runtime](runtime.md)                                    |
| `BOOT_IMAGE`                    | off                                   | [Runtime](runtime.md)                                    |
| `BOOT_IMAGE_BAKE`               | off                                   | [Runtime](runtime.md)                                    |
| `HEAP_RESTORE_CHUNKS`           | all at once                           | [Runtime](runtime.md)                                    |
| `LAZY_MOUNT`                    | `1` in the canonical config           | [Runtime](runtime.md)                                    |
| `LAZY_FS_BUDGET_BYTES`          | 20 MiB, 4 MiB in the canonical config | [Runtime](runtime.md)                                    |
| `SITE_DB_PREFIX`                | the packed default                    | [Runtime](runtime.md)                                    |
| `SQL_CHUNK_PREFIX`              | `drupal-sql`                          | [Runtime](runtime.md)                                    |
| `MIGRATE_ENGINE`                | `sql`                                 | [Runtime](runtime.md)                                    |
| `MIGRATE_SELF_DRIVE`            | on                                    | [Runtime](runtime.md)                                    |
| `MIGRATE_CHUNKS_PER_INVOCATION` | 40 on free, all on paid               | [Runtime](runtime.md)                                    |
| `OPCACHE_MODE`                  | off                                   | [Runtime](runtime.md#opcache_mode)                       |
| `ARGON2`                        | off                                   | [Runtime](runtime.md#argon2)                             |
| `SHELL_ASSEMBLY`                | on                                    | [Runtime](runtime.md#shell_assembly)                     |
| `REPLICA_COUNT`                 | 0                                     | [Replicas](replicas.md#replica_count)                    |
| `REPLICA_AUTOSCALE`             | on                                    | [Replicas](replicas.md#replica_autoscale)                |
| `REPLICA_MAX_LANES`             | 32                                    | [Replicas](replicas.md#replica_max_lanes)                |
| `WRITE_FORWARD`                 | on                                    | [Replicas](replicas.md#write_forward)                    |
| `REPLICA_LAG_MS`                | 30,000                                | [Replicas](replicas.md#replica_lag_ms)                   |
| `REPLICA_READ_ONLY`             | off                                   | [Replicas](replicas.md)                                  |
| `UPDB_FLUSH_SPLIT`              | on                                    | [Operations](operations/index.md)                        |
| `UPDB_ALLOW_UNBOUNDED`          | off                                   | [Operations](operations/index.md)                        |
| `UPDB_SNAPSHOT_MAX_ROWS`        | none                                  | [Operations](operations/index.md)                        |
| `UPDB_RETRY_POLICY`             | none                                  | [Operations](operations/index.md)                        |
| `UPDB_ON_ABORT`                 | none                                  | [Operations](operations/index.md)                        |
| `UPDB_MAX_ATTEMPTS`             | none                                  | [Operations](operations/index.md)                        |
| `UPDB_MAX_PASSES`               | none                                  | [Operations](operations/index.md)                        |
| `UPDB_MAX_COLD_WAITS`           | none                                  | [Operations](operations/index.md)                        |
| `UPDB_MAX_BEATS`                | none                                  | [Operations](operations/index.md)                        |
| `UPDB_CHECK_REQUIREMENTS`       | none                                  | [Operations](operations/index.md)                        |
| `RECONCILE`                     | on                                    | [Operations](operations/index.md)                        |
| `SWEEP`                         | off                                   | [Operations](operations/index.md)                        |
| `SWEEP_ROWS_FRACTION`           | 0.25                                  | [Operations](operations/index.md)                        |
| `MAIL_TRANSPORT`                | `auto`                                | [Integrations](integrations/index.md)                    |
| `MAIL_FROM`                     | none                                  | [Integrations](integrations/index.md)                    |
| `MAIL_DRAIN_ON_ALARM`           | on                                    | [Integrations](integrations/index.md)                    |
| `MAIL_DRAIN_LIMIT`              | 5                                     | [Integrations](integrations/index.md)                    |
| `CF_EMAIL_ACCOUNT_ID`           | none                                  | [Integrations](integrations/index.md)                    |
| `CF_EMAIL_TOKEN`                | none                                  | [Integrations](integrations/index.md)                    |
| `SMTP_HOST`                     | none                                  | [Integrations](integrations/index.md)                    |
| `SMTP_PORT`                     | 587/465                               | [Integrations](integrations/index.md)                    |
| `SMTP_TLS`                      | starttls                              | [Integrations](integrations/index.md)                    |
| `SMTP_USER`                     | none                                  | [Integrations](integrations/index.md)                    |
| `SMTP_PASS`                     | none                                  | [Integrations](integrations/index.md)                    |
| `SMTP_AUTH`                     | `PLAIN`                               | [Integrations](integrations/index.md)                    |
| `REDIS_URL`                     | none                                  | [Integrations](integrations/index.md)                    |
| `SYSLOG_URL`                    | none                                  | [Integrations](integrations/index.md)                    |
| `SYSLOG_APP_NAME`               | `drupal`                              | [Integrations](integrations/index.md)                    |
| `PARK`                          | on                                    | [Integrations](integrations/index.md)                    |
| `SLEEP_BUDGET_MS`               | 2,000                                 | [Integrations](integrations/index.md)                    |
| `AI`                            | none                                  | [Integrations](integrations/index.md)                    |
| `AI_MODELS`                     | four model ids                        | [Integrations](integrations/index.md)                    |
| `OIDC_CLIENT_SECRET`            | binding                               | [Integrations](integrations/index.md)                    |

## Bindings

`wrangler.jsonc` is the canonical config and declares seven of the ten. `FILES`, `FILES_PRIVATE` and
`SEND_EMAIL` are the three it leaves out.

| binding               | kind             | canonical config | what breaks without it                                                               |
| --------------------- | ---------------- | ---------------- | ------------------------------------------------------------------------------------ |
| `SITE`                | Durable Object   | declared         | the Worker has nothing to proxy to; every request fails                              |
| `ASSETS`              | Workers Assets   | declared         | no pack, no driver, no `/core/**`; an object cannot boot                             |
| `CONFIG_KV`           | KV               | declared         | the plan override and the runtime levers are absent; the deployed vars stay in force |
| `FLEET_DB`            | D1               | declared         | the cross-site inventory is absent; a single site does not need one                  |
| `FILES`               | R2               | not declared     | the page and file mirror drains nothing; the off-Worker serving path is unavailable  |
| `FILES_PRIVATE`       | R2               | not declared     | with `FILE_STORE=r2`, `private://` files stay in the object                          |
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

### The managed config

`wrangler.managed.jsonc` is the canonical config plus the three bindings it leaves out, `FILES`,
`FILES_PRIVATE` and `SEND_EMAIL`, and two vars, `CACHE_API=off` and `FILE_STORE=r2`.
`FILE_STORE=r2` makes the two R2 buckets the home of file bytes; see
[the R2 file store](serving/files-and-images.md#the-r2-file-store). The private bucket is
`drupflare-files-private` and has no custom domain. A user Worker in a Workers for Platforms dispatch namespace
cannot read `caches.default`: the property access throws, and every dynamic request failed with error
1101 before the var existed. With `CACHE_API=off` the serving path never touches the Cache API and
answers from the KV page tier and the object instead. Unset, it is on. The managed config is what a managed deployment deploys with, where the control plane has enabled R2 on
the account and set up Email Routing, which a deploy button cannot do:

```sh
bunx wrangler deploy -c wrangler.managed.jsonc
```

`tests/node/oneclick-config.spec.ts` holds the two files together. It fails when the managed config
differs from the canonical one in any key but those, and when the canonical config names a binding
that needs an account resource it cannot create. `bun run release:check` dry-runs both configs and
prices each bundle against the 64 MiB limit, and the release workflow bundles both before it
publishes. Whether a deploy that names `send_email` is refused on an account without Email Routing has
not been measured, so the managed config assumes the control plane has set it up.

A binding goes into this file when the code that reads it lands, not before. Service bindings,
`worker_loaders` and a facade Worker are listed in the roadmap as managed-only and are not here yet,
because nothing in `src/` reads them and a binding nothing reads fails a deploy for no gain.

An unbound optional binding always wins over the var that would enable the feature. Asking for a tier
that is not bound is a configuration error, and answering it with a crash on the serving path would
be the wrong trade.

## Related

- [Repository layout](../getting-started/repository-layout/index.md): every path outside `src/` and how it arrives
- [Building from source](../getting-started/building-from-source/index.md): how a source build runs
- [Measurement classes](../architecture/measurement-classes.md): which instrument may produce which class of number
- [Recovery](../operating/recovery.md): which primitive answers which failure
- [External database](../operating/external-database/index.md): why the site database lives in the Durable Object
