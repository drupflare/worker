# The Site Database

`assets/drupal/site.sqlite` is the Drupal database every new site is created from. It is the tracked
database under `assets/`, and this page is how it is built. Read its current size and shape
off the file rather than from here. `node scripts/diff-site-db.ts` compares a fresh build against it.

One command produces it:

```sh
php -d opcache.enable_cli=0 -d xdebug.mode=off \
  scripts/drupal/install-site-db.php drupal-src /tmp/site.sqlite
```

`bun run build:site-db <output>` runs the same command with the flags already set. The script refuses to write
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
4. **Writes five configuration values** through `ConfigFactory::save()`.
5. **Drops the cache secondary indexes** on every bin except `cache_data`.
6. **Truncates `watchdog`**, checkpoints the WAL and vacuums.

Each step prints what it did, so a build log records the module set, the recipe list, the config keys
and the index count.

## The Five Configuration Values

| Key                                     | Value        | Why                                                                   |
| --------------------------------------- | ------------ | --------------------------------------------------------------------- |
| `system.performance:cache.page.max_age` | `300`        | at `0` every render answers `private, no-store` and no page is stored |
| `system.performance:css.preprocess`     | `false`      | the aggregates are built at pack time and served from `/agg/`         |
| `system.performance:js.preprocess`      | `false`      | the same                                                              |
| `automated_cron.settings:interval`      | `0`          | the host owns the schedule; Drupal must not run cron inside a serve   |
| `system.image:toolkit`                  | `cfw_images` | core ships `gd`; see below                                            |

`toolkit` matters because the gd shim defines `imagegd2`, so `GDToolkit::isAvailable()` is true.
A database that kept core's `gd` would make every site nobody has claimed yet build its image
derivatives eagerly. Neither the claim-time `image-toolkit` reconcile step nor
`pack/consistency.php` changes a toolkit that is available, so the shipped rows have to say
`cfw_images` themselves. `tests/node/baked-image-toolkit.spec.ts` reads the `config` row, the
`cache_config` copy and the replay chunks.

`max_age` is the one to understand. Drupal's installer default of `0` suits a host that configures a
reverse proxy separately. This runtime serves its own cached pages, so at `0` the fill chain declines
to store every response it renders and the page table stays empty.

**Write these through Drupal, never with SQL.** `ConfigFactory::save()` writes the `config` row and
clears the `cache_config` copy. Drupal reads the bin first, so an `UPDATE` against `config` alone
leaves the old value in force.

## The Cache Indexes

Every cache bin ships `<bin>_created` and `<bin>_expire`. The pair is dropped on every bin except
`cache_data`, which keeps it.

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

A fresh build agrees with the shipped file on the module set, the config rows and the table set: 41
modules, 175 config rows and every table. The remaining differences are these:

| Difference                           | Direction    | Cause                                                    |
| ------------------------------------ | ------------ | -------------------------------------------------------- |
| `state:drupflare.router_fingerprint` | build only   | written when the module is enabled                       |
| `state:twig_extension_hash_prefix`   | shipped only | written by `bun run assets:twig`, a later build step     |
| `state:system.theme.files`           | shipped only | written on the first request                             |
| six `cache_*` bins                   | shipped only | Drupal creates them on the first request, not at install |

The six lazy bins and the state rows in `FIRST_REQUEST_STATE_ROWS` are named in `diff-site-db.ts`
rather than tolerated by a wildcard, so a seventh missing table is a failure instead of a rounding error.

## The Router Follows the Driver

`router` is a table that `RouteBuilder` writes, not a cache Drupal rebuilds on demand. A database
built before a module's routes existed lacks them, and the Drupflare admin section, Runtime Status
and the Operations Terminal answer 404 on every site created from it.

The packed database carries the current driver's routes. `tests/node/driver-pack.spec.ts` fails when
the packed router lacks a route the driver declares or carries a permission the driver no longer
declares. Existing sites are reached by the
`router-driver-routes` step in `src/ops/reconcile.ts`, which compares a site's `router` rows against
`DRIVER_ROUTES` and rebuilds when any are absent. After a rebuild, run `assets:twig`, `assets:core`,
`assets:pack` and `assets:scrub`, then `assets:container`: a fresh install mints a new
`twig_extension_hash_prefix` and the pack has to follow it.

## Changing One Row

Rebuilding is preferred. A surgical edit is still sometimes right, and two rules apply.

**Find every cached copy of what you are editing.** A `config` row usually has a serialized twin in
`cache_config`, and Drupal reads the twin first.

**When copying a cache row between databases, check `expire = -1` and that both databases carry
identical `cachetags`.** A checksum that disagrees with the destination's tags means the row is
present and rejected, so the cost it was meant to remove is still paid and nothing looks wrong.

After any change, run `bun run assets:sql` to rewrite the migration chunks the Durable Object
replays, then `node scripts/diff-site-db.ts <previous file> assets/drupal/site.sqlite` to see what
moved.

## The WordPress Database

The WordPress database is baked by `bun scripts/bake-wordpress.ts`, which runs WordPress's own
installer through the MySQL translator and cuts the result into `assets/wordpress/sql`. It is a
separate pack with its own producer. Nothing on this page except this section describes it.

### Planner Statistics

SQLite chooses an index from `sqlite_stat1`, and nothing in a Durable Object runs `ANALYZE` for you.
A baked database has three posts, so statistics taken from it would describe three rows. Without any,
the planner guesses ten rows per key, which makes the permalink lookup
(`post_name = ? AND post_type = 'post' AND post_status = 'publish'`) use `type_status_date`
and read every published post. On a model site with 20,000 posts a Durable Object read 11,002 rows
for that lookup, against 3 with statistics.

The bake therefore ships statistics for a model site. `scripts/wp/loaded-data.ts` generates it from a
fixed seed: 20,000 posts (11,000 published posts, 3,500 attachments, 3,200 revisions and the rest),
100,000 postmeta rows, 2,000 terms, 50,000 comments, 5,000 users and 3,000 options of which 150 load
on every request. `modelStatistics()` in `scripts/wp/planner-stats.ts` loads that site into the
installed schema, runs `ANALYZE` and keeps the `sqlite_stat1` rows. `pack-sql.ts` writes them as the
last statements of the last chunk, and the migration replay installs them:

1. `ANALYZE sqlite_master` creates `sqlite_stat1`. The name is reserved, so `CREATE TABLE` is refused.
2. One `INSERT` per row.
3. `ANALYZE sqlite_master` again. The planner reads the table when the schema loads, so rows written
   directly have no effect until this reload.

The rows are the same on every bake, and `tests/node/wordpress-planner-stats.spec.ts` compares them
with the script's output. Run `bun scripts/wp/planner-stats.ts stats` to print them.

### What a Real Site Does to Them

The planner reads the seeded rows and never the site's data, so a plan cannot flip as a site grows.
What can change is whether the seeded plan is still the one the site's own `ANALYZE` would pick.
`bun scripts/wp/planner-stats.ts sensitivity` loads seven sites (200, 2,000 and 100,000 posts, and
20,000 posts that are mostly revisions, attachments or drafts) and compares the 72 read templates
under the seeded rows against each site's own statistics. The permalink, date permalink, comment and
post parent reads agree on all seven. The category archive, author archive and admin count reads
differ only on the 200-post site, where either plan reads a handful of rows. The other
disagreements are ties between `type_status_date` and `type_status_author` for ordered reads, and
three reads that the site's own statistics send to a full scan of `wp_posts` on sites whose posts
are mostly revisions, attachments or drafts.

### Why Not a Full ANALYZE

`ANALYZE` is permitted on a Durable Object and costs the whole database in rows read: 1,671,358 read
and 34 written on the model site, measured on a local Durable Object. It also makes one hot read
worse. `wp_options__autoload` holds three values and 95% of the rows carry `off`, so its average of
1,500 rows per key makes the planner scan all 3,000 options for the request that loads the
autoloaded ones, where the index reads 155. The seeded rows leave that index out
(`UNREPRESENTATIVE` in `planner-stats.ts`), so the planner keeps its default for it.

`PRAGMA optimize` is permitted and runs an `ANALYZE`, but its cursor reports 13 rows read and 0
written while `sqlite_stat1` gains 30 rows, so its cost cannot be read from the meter. Nothing in the
product runs either.

The user tables are declared `COLLATE NOCASE_UTF8`, a collation the Drupal SQLite driver registers
per connection. A plain `sqlite3` client or a raw `new PDO()` cannot rebuild an index over them and
fails with `no such collation sequence`. Read-only queries are fine; anything that rewrites an index
has to go through Drupal's own connection.

## Upgrading Drupal Core

The root `composer.lock` decides which core the pack is built from. The runtime bundles the lock and
reads its versions from it, and `bun run fetch:drupal` materialises the locked core into
`drupal-src`. Nothing else records the version, so a renovate bump of the lock is the whole change.
An upgrade by hand is:

```sh
composer update # or bump the pin in composer.json first
bun run fetch:drupal -- --force
bun run build:site-db /tmp/site.sqlite
node scripts/diff-site-db.ts assets/drupal/site.sqlite /tmp/site.sqlite
```

`bun run qa:core-freshness` reports whether the shipped core is behind upstream, including whether
its branch still receives security fixes.

To swap the core under a full tree rebuild, follow [Upgrading Drupal Core](../getting-started/building-from-source/upgrading-core.md#upgrading-drupal-core)
in Building From Source.
