# The packed database

What produces assets/drupal/site.sqlite and why a shared base has nowhere to live. Moved verbatim from the project CLAUDE.md.

## The database HAS a producer now, and four claims here were stale

`assets/drupal/site.sqlite` is **5,832,704 bytes** as of the 2026-09-30 rebuild against drupflare
v0.5.0 and rom v0.4.0, and `scripts/drupal/install-site-db.php` builds it
from nothing. `docs/architecture/database.md` is the recipe; `bun run build:site-db` runs it and
`node scripts/diff-site-db.ts` is the acceptance check. Measured 2026-09-09, a fresh build against
the shipped file agrees on **41 modules of 41 and 175 config rows of 175**, with every remaining
difference attributed.

**This section said the opposite until 2026-09-09, and each correction is worth knowing:**

- "6.6 MB" was the superseded R2-archived lineage `site.sqlite.trimmed-1618p-cc13` at 6,627,328
  bytes, pinned in `scripts/backup-cdn.ts`. It then read 7,585,792 from 2026-08-14, 5,349,376
  from `3e4f2737 chore: rebuild the packed database at 11.4.6`, and 5,832,704 since 2026-09-30.
  **Count it, do not quote it** -- this line has been wrong three times.
- "nothing in this repo produces it" -- `install-site-db.php` had existed for two weeks and
  `bake-pack.ts` already said so. What had no producer was three DELTAS: the `page_content_type`
  recipe, enabling `drupflare`, and 16 cache index drops. All three are in the script now.
- "the build input is 14.4 MB" named the **wrong file**. `drupal-src/sites/default/files/.sqlite` is
  5,222,400 bytes; the ~14.4 MB one is the gitignored intermediate `assets/drupal-std/site.sqlite`.
- the 3 MB gzipped ceiling it argued against **no longer exists** -- see the section on that below.

**AND ONE TRIM THE SCRIPT WAS DOING HAD EXPIRED.** It forced `system.advisories:enabled` false for
"no outbound socket". The stream wrapper and the park landed, `CRON_HOOKS` runs `system` and
`update`, and the shipped pack has carried `enabled: true` in all six of its committed versions -- so
the trim was wrong about the runtime AND about what it was reproducing. Same shape as the three
`run: false` entries that outlived their reason.

Prefer a rebuild to a surgical edit now. Where an edit is still right, the two rules below hold.

When copying a cache row between databases, verify `expire = -1` and that **both** databases carry
identical `cachetags` - a `checksum` that disagrees with the destination's tags means the row is
present but rejected, so the cost it was meant to remove is still paid and nothing looks wrong. See
the provenance section in `TECHNICAL_REPORT.md`.

**AND A SURGICAL EDIT CAN BE SHADOWED BY A CACHED COPY OF THE ROW IT EDITS.** The `max_age` fix
below was made correctly in the `config` table and `cache_config` kept its own serialized copy at
**0**. Drupal reads the bin first, so nothing changed: every render still said `no-store`, `cfw_page`
never filled, and every request on every site re-rendered -- for the whole time the fix was believed
shipped. `tests/node/page-cacheable.spec.ts` PASSED throughout, because it read the row the edit had
touched rather than the one in the way; it asserts both copies and their equality now.

**So when editing a config row, find every cached copy of it first.** The section already says to
verify `expire` and `cachetags` when COPYING a cache row between databases; the rule is wider than
that -- a config edit that leaves a `cache_config` row behind is inert, and inert in a way that reads
as working.

**A DRUPAL DEFAULT THAT IS CORRECT ELSEWHERE CAN BE FATAL HERE, and one was.**
`system.performance:cache.page.max_age` shipped at **0**, which is Drupal's installer default and
right for a generic host that configures a reverse proxy separately. Here the reverse proxy IS the
product: at 0 every render returns `Cache-Control: private, no-store`, `fillOne()`'s `refused` check
declines the `cfw_page` upsert, and **the page table stayed empty on every site ever created**. Every
request rendered. Measured on a fresh site: 0 rows before, 4 rows after, and paths that answered
`RENDER` now answer `HIT`.

Two things not to get wrong when reading that:

- **Honouring `no-store` is not the bug.** Storing a response Drupal marked `private` and replaying it
  is the uid-1 leak this project already shipped once. The value has to be right at the SOURCE.
- **The fix is a surgical sqlite edit, not a repack**, exactly as this section says: unserialize the
  `system.performance` blob, change the one key, reserialize, then `bun run assets:sql`.
  `tests/node/page-cacheable.spec.ts` reads the shipped row and fails at 0.

The general form is worth carrying: **the pack inherits Drupal's opinions about a deployment that is
not this one.** When something the architecture depends on is silently inert, check what the shipped
config believes before checking the code.

**AND A SURGICAL EDIT TO A TRACKED ARTIFACT IS REVERTED BY `bun install`.** `assets/drupal/site.sqlite`
is tracked AND has a `cdn-manifest.json` entry, and the entry named an older lineage, so
`restore-artifacts.ts` overwrote the file on every install and turned `container-cid.spec.ts` red on a
tree nobody had edited. The entry is now marked `tracked: true` and the restore verifies it and leaves
it alone; `tests/node/cdn-manifest-agrees.spec.ts` fails if the two disagree again.

**So prefer a BUILD STEP to a hand edit whenever the artifact is tracked.** BUG 4's watchdog trim was
first made by hand and is now `dropBakeHistory()` inside `pack-sql.ts`, which is reproducible and
survives a restore. A hand edit is correct only where nothing in the repository produces the file, and
`site.sqlite`'s trim recipe is the one case of that.

## A shared base has nowhere to live, and the read-through was never the hard half

Measured 2026-09-08. The premise holds and is stronger than when it was written: three
independently provisioned sites are byte-identical after `/migrate` except one `cfw_meta` row -- 20
of 21 tables, 1,281 of 1,282 rows -- and `bun scripts/measure/per-site-census.ts` reads the same
thing on workerd at `seedSharedFraction` 0.9992 and `warmSharedFraction` 0.9488. A fresh site is
4,726,784 bytes of which ~96.6% is the pack.

**THE QUERY LAYER IS NOT WHERE THIS DIES.** A read-through costs **1.35x** on the statement, measured
against the real `site.sqlite` with the pack's own indexes over six statement shapes taken from a
traced render, 2,000 iterations each, three runs (1.35/1.35/1.37, range 0.97-1.69), every row count
agreeing including a JOIN whose two sides sit in different layers. The overlay resolves as
`t_T UNION ALL base_T WHERE NOT EXISTS (...)`.

**IT DIES ON WHERE THE BASE CAN PHYSICALLY BE, and all three exits are closed by measurement:**

- **`ATTACH` is refused.** `ATTACH DATABASE ':memory:' AS base` answers `SQLITE_AUTH`, and so does
  `PRAGMA database_list`. A second file cannot join the tenant's engine.
- **`execSql()` cannot await.** `module.cfwSqlExec = (json) => withMask(() => ... JSON.stringify(...))`
  in `@drupflare/durabledb/src/do-sqlite.ts` is synchronous by construction, so KV, R2, D1, another
  Durable Object and `env.ASSETS.fetch()` are all unreachable from inside a read. That last one
  matters most: the pack chunks themselves arrive by `env.ASSETS.fetch()` in `src/db/migrate-sql.ts`,
  so even a lazy fill cannot reach its own source from a statement.
- **The interpreter carries no SQLite.** PHP 8.5.2 reports `pdo_sqlite=no`, `sqlite3=no` and an empty
  `PDO::getAvailableDrivers()`, verified on `.interp/php8.5.wasm` under node and through `/php` on
  workerd. PHP cannot open `assets/drupal/site.sqlite` in process.

What IS reachable is anything already resident: the 62 chunks parse in **4.5 ms (n=3)** and retain
**3.79 MiB** indexed by table, which fits both the 1,000 ms startup budget and the 16 MiB between
`recycleAboveBytes()` at 117,440,512 and the 128 MiB isolate. Resident rows are not a queryable base
though, and that is the gap nothing closes.

Two mechanisms follow from that and both are refused with a number:

- **Lazy per-table materialisation** needs no engine, and saves **2.03% of base rows / 2.18% of base
  bytes**. Driven over `/`, `/user/login`, `/node/1` and `/user/password`, 16 of 20 base tables are
  read; the four that are not are `cache_file_parsing`, `cache_render`, `cfw_page` and `users`, and
  `users` goes on the first authenticated request. Deleting `router`'s 419 rows takes `/user/login`
  from 18,418 bytes to 57.
- **A separate base Durable Object** needs the park, which resolves inside one invocation -- so the
  meter is SUBREQUESTS, not requests. A cold first render issues **224** statements and a warm one
  **31-48**, against free's 50. At even a 1 ms hop the warm path adds 31-48 ms to a serve the plan
  tier answers in 5.

**THE SURVIVING OBJECTIVE IS PER-TENANT STORAGE, and it is a hard cap rather than a bill.**
`FREE_QUOTAS.storageBytes` is 5 GB account-wide, so 4,726,784 bytes per site is 1,057 sites and
nothing else in the model says so. The one lever the measurement handed over needs no overlay at
all: **the seed's eight cache bins are 1,549,471 bytes of its 2,933,572 row bytes, 32.8% of the
4,726,784 the object stores**, and every one of them can be emptied with the front page still
rendering byte-identical. `cache_container` must stay -- a rebuild is 1,024 ms against 86. The other
seven are 1,067,229 bytes, **22.6% of the stored database**, for at most 44 extra statements on the
first render.

**AND THAT LEVER IS REFUTED, WHICH THIS PARAGRAPH USED TO OMIT -- so it has been re-proposed twice
from the figure above.** 22.6% is a PROVISIONING-TIME reading. Measured across a render: 1,273,856
bytes saved at provisioning, then **NEGATIVE 176,128 bytes and 227 extra rows written after one
render**, because the bins a live render rebuilds are larger than the packed ones. Rows written is
the meter that binds regeneration, so it loses on both meters rather than trading between them.
Quote the post-render figure; the provisioning one is the half that reads like a win.

Sharing across tenants needs both layers in ONE object's SQLite, which means many tenants per object.
That is a topology change and it is not the item as scoped; within one tenant's own object there is
nothing to share and the overlay saves zero.
