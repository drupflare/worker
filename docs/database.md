# The Site Database

`assets/drupal/site.sqlite` is the Drupal database every new site is created from. It is 7,585,792
bytes, it is the only tracked artifact under `assets/`, and this page is how it is built.

One command produces it:

```sh
php -d opcache.enable_cli=0 -d xdebug.mode=off \
  scripts/drupal/install-site-db.php drupal-src /tmp/site.sqlite
```

`bun run build:site-db` is the same thing with the flags already set. The script refuses to write
`assets/drupal/site.sqlite` unless given `--allow-shipping-pack`, so the normal loop is build
elsewhere and compare:

```sh
node scripts/diff-site-db.ts assets/drupal/site.sqlite /tmp/site.sqlite
```

## What the Script Does

1. **Installs Drupal** into `drupal-src/sites/build` with the `standard` profile, driving
   `install_drupal()` directly. It never installs into `sites/default`, which holds the baked Twig
   cache and the working settings.
2. **Enables `media` and `drupflare`.** The shipped module set is the `standard` profile's
   dependency closure, plus `update` from the install form, plus these two.
3. **Applies the `page_content_type` recipe.** Drupal 11.4 ships no node type in `standard`; `page`
   and `article` are recipes under `core/recipes/`.
4. **Writes four configuration values** through `ConfigFactory::save()`.
5. **Drops the cache secondary indexes** on every bin except `cache_data`.
6. **Truncates `watchdog`**, checkpoints the WAL and vacuums.

Each step prints what it did, so a build log records the module set, the recipe list, the config keys
and the index count.

## The Four Configuration Values

| Key                                     | Value   | Why                                                                   |
| --------------------------------------- | ------- | --------------------------------------------------------------------- |
| `system.performance:cache.page.max_age` | `300`   | at `0` every render answers `private, no-store` and no page is stored |
| `system.performance:css.preprocess`     | `false` | the aggregates are built at pack time and served from `/agg/`         |
| `system.performance:js.preprocess`      | `false` | the same                                                              |
| `automated_cron.settings:interval`      | `0`     | the host owns the schedule; Drupal must not run cron inside a serve   |

`max_age` is the one to understand. Drupal's installer default of `0` is right for a host that
configures a reverse proxy separately. Here the reverse proxy is the product: at `0` the fill chain
declines to store every response it renders, and the page table stays empty on every site.

**Write these through Drupal, never with SQL.** `ConfigFactory::save()` writes the `config` row and
clears the `cache_config` copy. Drupal reads the bin first, so an `UPDATE` against `config` alone
leaves the old value in force. That happened: the `max_age` fix was committed correctly and had no
effect on any site until a later commit moved the cached row as well.

## The Cache Indexes

Every cache bin ships `<bin>_created` and `<bin>_expire`. Sixteen of them are dropped, leaving the
pair on `cache_data` only.

Nothing on this runtime reads them. `DatabaseBackend::getMultiple()` selects by `cid`, and
`garbageCollection()` never runs because the host sweeps expiry itself. Each surviving index costs a
charged row on every insert into the bin, and the fill path is what the free plan's row budget
binds. `cache_data` keeps both because the host's own `gcPass()` caps that bin with
`ORDER BY created` and sweeps it with `expire < ?`; dropping them turns every alarm into a full scan.

`tests/node/index-audit.spec.ts` asserts both halves: thirteen bins at one charged row per stored
row, and `cache_data` at three.

## What Reproducible Means Here

Structurally, not byte for byte. A Drupal install mints a random hash salt, a UUID per config
object, a password hash and per-row timestamps, so two correct runs differ in thousands of bytes
while describing the same site. `scripts/diff-site-db.ts` compares the table set, the module set,
the config names and five row counts.

Measured on 2026-09-09, a fresh build against the shipped file: **41 modules against 41, 175 config
rows against 175, and every table present.** The differences that remain are these, and each is
accounted for:

| Difference                           | Direction    | Cause                                                    |
| ------------------------------------ | ------------ | -------------------------------------------------------- |
| 4 `drupflare.*` routes, 3 menu links | build only   | the shipped file predates those routes; see below        |
| `state:drupflare.router_fingerprint` | build only   | written when the module is enabled                       |
| `state:twig_extension_hash_prefix`   | shipped only | written by `bun run assets:twig`, a later build step     |
| `state:system.theme.files`           | shipped only | written on the first request                             |
| six `cache_*` bins                   | shipped only | Drupal creates them on the first request, not at install |
| 739 free pages                       | shipped only | the shipped file has never been vacuumed after an edit   |

The six lazy bins and the two first-request state rows are named in `diff-site-db.ts` rather than
tolerated by a wildcard, so a seventh missing table is a failure instead of a rounding error.

## The Shipped File Is Missing Its Own Routes

The comparison found this. `core.extension` in the shipped database lists `drupflare`, and the
`router` table carries none of its four routes and none of its three menu links, because the module
was enabled into the database before those routes existed. `router` is a table that
`RouteBuilder` writes, not a cache Drupal rebuilds on demand, so the Drupflare admin section,
Runtime Status and the Operations Terminal answer 404 on every site created from it.

Rebuilding the database fixes it for new sites. Existing sites are reached by the
`router-driver-routes` step in `src/ops/reconcile.ts`, which compares a site's `router` rows against
`DRIVER_ROUTES` and rebuilds when any are absent.

## Changing One Row

Rebuilding is preferred. A surgical edit is still sometimes right, and two rules apply.

**Find every cached copy of what you are editing.** A `config` row usually has a serialized twin in
`cache_config`, and Drupal reads the twin first.

**When copying a cache row between databases, check `expire = -1` and that both databases carry
identical `cachetags`.** A checksum that disagrees with the destination's tags means the row is
present and rejected, so the cost it was meant to remove is still paid and nothing looks wrong.

After any change, run `bun run assets:sql` to rewrite the migration chunks the Durable Object
replays, then `node scripts/diff-site-db.ts` to see what moved.

## Reading It With Other Tools

The user tables are declared `COLLATE NOCASE_UTF8`, a collation the Drupal SQLite driver registers
per connection. A plain `sqlite3` client or a raw `new PDO()` cannot rebuild an index over them and
fails with `no such collation sequence`. Read-only queries are fine; anything that rewrites an index
has to go through Drupal's own connection.

## Upgrading Drupal Core

The root `composer.lock` decides which core the pack is built from. `bun run gen:lock` bakes the
version into `src/ops/shipped-lock.ts`, and `bun run fetch:drupal` materialises that version into
`drupal-src`. So an upgrade is:

```sh
composer update # or bump the pin in composer.json first
bun run gen:lock
bun run fetch:drupal -- --force
bun run build:site-db /tmp/site.sqlite
node scripts/diff-site-db.ts assets/drupal/site.sqlite /tmp/site.sqlite
```

`bun run qa:core-freshness` reports whether the shipped core is behind upstream, including whether
its branch still receives security fixes.
