# Repository Layout

Every path outside `src/`, how it arrives on a clean clone, and what breaks without it. Sizes are
`du -sh` on a development machine.

## Data Risk

`assets/drupal/site.sqlite` is the packed Drupal database. `scripts/drupal/install-site-db.php` builds
it from nothing (`bun run build:site-db`, with `docs/database.md` as the recipe), and it is tracked,
so the copy in the tree is the one that ships. Two other lineages exist in the `drupflare-cdn`
bucket: `.pack-backup/site.sqlite.bak`, which is the rollback point for an earlier lineage, and an
older hand-trimmed artifact from a different one. The SQLite header change counter is what orders
them.

`bun run backup:cdn` archives a key's remote bytes to `snapshots/<name>.<sha12>` before replacing
them, so nothing is lost by replacing one, and records the archive in `cdn-manifest.json` in the same
run, so the manifest is the only file left to commit. It refuses for a tracked file with uncommitted
changes, where the bytes going up are recorded nowhere. `bun run backup:verify` compares every key by
size and ETag.

## `.pack-backup/`

7.2 MB, one file, and it stays. It is the rollback point for an earlier lineage of the packed
database (7,585,792 bytes, against 5,832,704 for the current one), and `bun run bake:pack`
**overwrites it on its next run** (the `snapshot` step of `scripts/bake-pack.ts`). Its content is also in the
bucket at `snapshots/site.sqlite.064105ca7223`.

## Tracked Against Untracked

A deploy reads `src/`, `assets/` and `.interp/`. The rest of the untracked bulk is build input,
measurement state, or regenerable output.

**Measure the counts rather than reading them here.** `git ls-files | wc -l` and `du -sh` are the
instruments. The shape of the table is what is meant to last; the numbers in it go stale.

| path                | size | tracked          | how it arrives on a clean clone                                              | delete?          |
| ------------------- | ---- | ---------------- | ---------------------------------------------------------------------------- | ---------------- |
| `src/`              | 4.2M | 406 of 407 files | committed                                                                    | no               |
| `tests/`            | 5.2M | 438 of 438       | committed                                                                    | no               |
| `scripts/`          | 2.2M | 198 of 198       | committed                                                                    | no               |
| `docs/`             | 656K | yes              | committed                                                                    | no               |
| `assets/`           | 133M | 5 files          | `bun run hydrate`; `bun run build:local` in full                             | no               |
| `.interp/`          | 176M | no               | `bun install` restores 2 of 3; `bun run hydrate` or `build:local` the rest   | no               |
| `.siblings/`        | --   | no               | `bun run build:local`, only when the modules are not checked out beside this | yes, regenerable |
| `vendor/`           | 198M | no               | not reproducible; restored from `drupflare-cdn/vendor/`. Not a deploy input  | never            |
| `drupal-src/`       | 167M | no               | `bun run fetch:drupal`, which `build.yml` also calls                         | yes, regenerable |
| `experiments/`      | 332K | 71 files         | committed                                                                    | no               |
| `.pack-backup/`     | 7.2M | no               | `bun run bake:pack`                                                          | no               |
| `.contrib-fixture/` | 38M  | no               | `bun run test:contrib`, and only while it is running                         | no               |
| `.trim-assets/`     | 7.6M | no               | `bash scripts/stage-edge-assets.sh`                                          | yes, regenerable |
| `typedoc/`          | 36M  | no               | `bun run docs:build`                                                         | yes, regenerable |
| `coverage/`         | --   | no               | `bun run test:coverage`                                                      | yes, regenerable |
| `dist/`             | 72M  | no               | `bun run release:payload`                                                    | yes, regenerable |
| `.wrangler/`        | 209M | no               | any `wrangler dev` or vitest run                                             | yes, regenerable |
| `node_modules/`     | 950M | no               | `bun install`                                                                | yes, regenerable |

`.wrangler/` grows with every `wrangler dev` session and vitest run, and nothing prunes it. Delete it
when disk space matters.

`docker/` holds two rigs, which are unrelated. `compose.yml` is the nine-service integration rig
(GreenMail, Postgres, MySQL, Redis, syslog, Gitea, Forgejo, Keycloak, GitLab). `vps.yml` with
`docker/vps/` is the comparison arm: nginx and PHP 8.5 FPM running the same `drupal-src` tree and the
same `assets/drupal/site.sqlite` this project serves, so a measurement isolates the runtime. The arm
mounts the tracked database read-only and copies it, because SQLite writes to the file it reads.

## `experiments/`

71 files, 110,263 bytes, all committed, per `git ls-files experiments`: **61 wrangler configs** (59
under `experiments/wrangler/`, and one each in `arena/` and `duration/`), plus the
`experiments/wrangler/README.md`, the probe seams those directories pair with their configs, two
binary seams under `binary/`, a loose `probe-o3mbsjlj.ts` at the top, and the data files from the
boot-phase sweeps. They are kept for reproduction and are not maintained. `.prettierignore` excludes
the directory from formatting.

## `assets/core/`

24 MB, 4,030 files, produced by `bun run assets:static` from step 13 of the source build. It is the
browser-fetchable half of the Drupal tree (`css`, `js`, fonts and images under `core/`) copied to
where Workers Assets serves it at the `/core/**` URLs Drupal already emits.

All three PHP packers skip those extensions, because PHP never opens them. Nothing serves a file out
of the PHP MEMFS over HTTP, so these files reach the browser only through this directory. Workers
Assets content-hashes, caches and compresses what it serves, and a cache hit never reaches the Worker.

`assets/.assetsignore` denies by default and negates `/core/`. `tests/unit/runtime/assets-ignore.spec.ts`
asserts that the negation reaches into the directory and that every `/core/**` URL a prefilled page
references answers 200. The tracked `assets/_headers` sets the cache lifetimes of that tree; see
Static Asset Cache Lifetimes in `docs/configuration.md`.

## `vendor/`

`wrangler deploy` does not read it. The canonical config aliases `./runtime/php-binary.js` to
`src/runtime/php-binary-raw.ts`, which imports the interpreter from `.interp/`. `vendor/` reaches a
bundle only through the unaliased default seam `src/runtime/php-binary.ts` and the `src/probes/**`
configs, so it is a local store of hand-built binaries kept for reproducing past measurements.

Never delete, move or overwrite anything under it. A local deletion is recoverable, but the
recovery is not free. **All 34 vendor files are in `drupflare-cdn`**, each matching on size and on
ETag-against-md5. They are 34 of the manifest's 35 `keys`; the 35th is `assets/drupal/site.sqlite`.
Four retired `vendor/` keys sit in the manifest's `archived` list.

`vendor/php8.3.wasm`, `vendor/php8.4.wasm` and their `-web.mjs` glue are the only reproducible entries:
`bun run vendor` copies them out of the `php-wasm` npm package. They cost 27 MB and are backed up, and
no change is recommended.

## `drupal-src/`

The Drupal tree the packers read, and the only path that satisfies `DRUPAL_ROOT`. `bun run fetch:drupal`
produces it: the release tarball for `SHIPPED_CORE_VERSION` from `ftp.drupal.org`, extracted with the
`drupal-<version>/` wrapper stripped, then completed with the four contributed modules the tarball does
not carry. `DRUPAL_VERSION` overrides the version; `--force` replaces a tree that is present at a
different one. A second run on a satisfied tree downloads nothing.

`.github/workflows/build.yml` calls the same script, resolving the version with
`bun scripts/fetch-drupal-tree.ts --print-version`, so a developer and the gate lane hold the same tree.
`tests/node/drupal-tree.spec.ts` fails if the workflow grows a second producer.

The tarball is core only. `SHIPPED_LOCK_VERSIONS` names `admin_toolbar`, `ctools`, `pathauto` and
`token` beyond it, so the script installs those four at their pinned versions with composer;
`tests/node/shipped-lock.spec.ts` compares the resulting `composer.lock` against the baked map.

Four things need it. `assets:twig`, `assets:core`, `assets:pack` and `assets:static` read it as their
build input. `bun run test:php` and the sibling PHP suites in `../drupflare` and `../rom` take it as
`DRUPAL_ROOT`.
`composer analyze` resolves `\Drupal\Core\...` against it through `phpstan.neon`. An IDE indexes it for
the same reason. Everything except the packers degrades to skipped or unresolved without it, and none
of them fails loudly, so the tree being absent is quiet.

## `.siblings/`

`bun run assets:driver` reads the sibling checkouts of `drupflare/drupflare`, `drupflare/rom` and
`drupflare/stream-http` directly and packs them into `assets/driver.json`. **The repository keeps no
copy of the modules.**

Composer never runs on the edge, so the packed copy is what executes.
`tests/node/driver-pack.spec.ts` rebuilds `assets/driver.json` from the modules on disk and compares byte
for byte, so a stale pack fails the gate.

The packer takes an allow-list of module-shaped paths (`src`, `.info.yml`, `.install`, `.module`,
`.services.yml`), because a module repository is not a module and walking a checkout wholesale would
pull `node_modules/`, `vendor/` and `coverage/` into the bundle. The machine name comes from the
mount rather than the directory: `../rom` provides `cfw_do_sqlite`.

Each of the three is resolved as `DRUPFLARE_SRC` / `ROM_SRC` / `STREAM_HTTP_SRC`, then `../<name>`, then
`.siblings/<name>`. CI sets the environment variables and checks the repositories out under `.siblings/`;
`bun run build:local` clones into the same paths, and only the ones that are not already there.

## Unwired Scripts

Reference counts across `package.json`, `scripts/`, `src/`, `tests/`, `docs/` and the READMEs.

| script                         | refs | state                                                                                                                                                           |
| ------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/bake-container.php`   | 0    | superseded. `bake-pack.ts` records that rewriting the container key by hand produced a byte-identical render that still missed, which is what this script does. |
| `scripts/stage-edge-assets.sh` | 1    | superseded by `assets/.assetsignore` for the canonical config, still used by `experiments/wrangler/*`. Keep.                                                    |

`scripts/` is grouped by role, as described in `scripts/README.md`: the live pipeline in TypeScript,
`bench/` PHP for the native half of a ratio, `probe/` shell pairs, and `measure/` instruments.
`src/probes/**` holds measurement instruments on the same terms. `release-payload.ts`, `hydrate.ts`
and `backup-cdn.ts` sit flat alongside `pack-*.ts` and `gen-driver-assets.ts`. `experiments/` holds
configs kept for reproduction and excluded from prettier.

## Test Coverage of Headline Claims

Thirteen headline claims from the summary in `TECHNICAL_REPORT.md`, classed by what can check them:

- **(a) arithmetic or model**: hermetic, free, in the gate.
- **(b) artifact**: needs bytes on disk; runs in the release lane, which hydrates the payload.
- **(c) edge**: needs a deployed worker. An absolute CPU figure comes only from `cpuTime` on one.

| #   | claim                                                                    | class | caught?                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | the bundle fits the 64 MiB Worker size limit                             | b     | **yes.** `bun run release:check` parses wrangler's printed uncompressed figure and fails over the limit; the release lane runs it. `tests/unit/bundle-size.spec.ts` covers the arithmetic.                                                                                 |
| 2   | PHP 8.5 ships with nothing dropped to fit                                | b     | **yes, both halves.** `interp.lock.json` and the payload manifest pin the frame's sha256; `tests/integration/loaded-extensions.spec.ts` reads `get_loaded_extensions()` out of the running binary and asserts opcache and lexbor by name, plus the platform map both ways. |
| 3   | serving 3.0M visits/month, regeneration 50,916 renders/day               | a     | **yes.** `tests/unit/free-envelope.spec.ts` over `scripts/measure/free-envelope.ts`.                                                                                                                                                                                       |
| 4   | the per-class row cost of a fill                                         | a     | **yes.** `tests/integration/rows-per-fill-audit.spec.ts` drives every class on one object and pins it.                                                                                                                                                                     |
| 5   | the first-run migration chunk count                                      | a     | **yes.** `assets/drupal-sql/manifest.json` reports it. The count moves with the packed database, so read the manifest rather than a document.                                                                                                                              |
| 6   | `assets/driver.json` is the code that executes, and is current           | b     | **yes.** `tests/node/driver-pack.spec.ts`, byte for byte.                                                                                                                                                                                                                  |
| 7   | the canonical config reaches its own code                                | a     | **yes.** `tests/node/wrangler-reachability.spec.ts`, including the binary alias.                                                                                                                                                                                           |
| 8   | the compiled Twig cache is reachable at the key the runtime asks for     | b     | **yes, in the release lane.** `tests/node/twig-bake.spec.ts` with `REQUIRE_ARTIFACTS=1`.                                                                                                                                                                                   |
| 9   | DO SQLite: 100 bound params, 50-byte LIKE, lossy above 2^53              | a     | **yes.** `tests/unit/db/do-sqlite.spec.ts` and `tests/unit/db/file-store.spec.ts`, inside workerd against the real limits.                                                                                                                                                 |
| 10  | cold boot 1,398 ms, `page_cache` hit 1 ms, render 2,127 ms, startup 5 ms | c     | **no.** PHP clocks do not advance across a synchronous PHP run on the edge, so a duration read inside PHP is 0. The absolute time is a real epoch. Durations need a deployed worker's `cpuTime`.                                                                           |
| 11  | the shipping asset set is exactly what the runtime fetches               | a     | **yes.** `tests/unit/runtime/assets-ignore.spec.ts` through the real `ASSETS` binding, plus the payload's bidirectional check against the same file.                                                                                                                       |
| 12  | 19 tripwires, and the repair ladder fails closed mid-transaction         | a     | **yes.** `tests/unit/ops/repair.spec.ts`. 12 in `HOST_TRIPWIRES`, 7 under `drupflare/src/Health/Tripwire/`.                                                                                                                                                                |
| 13  | the render origin is a property of the site, not of the request          | a     | **yes.** `tests/unit/ops/site-origin.spec.ts` and `tests/integration/render-origin.spec.ts`.                                                                                                                                                                               |

## Nightly Automation

| lane                                                                    | asserts                    | cost                                            | verdict                                                                                                                     |
| ----------------------------------------------------------------------- | -------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| model figures: free envelope, ceiling arithmetic, rows-per-fill classes | every (a) row              | seconds, hermetic                               | already in the gate; a nightly adds nothing a push does not                                                                 |
| artifact figures: payload manifest, frame sizes, chunk count, Twig keys | the (b) rows               | one payload download plus a dry-run, ~3 minutes | built, in the release lane. Not scheduled; a nightly run against the latest release would catch a deleted or replaced asset |
| CDN backup intact                                                       | 35 live + 15 archived keys | one HEAD per key, no credentials                | built. `.github/workflows/backup.yml`, daily at 05:20 UTC                                                                   |
| edge figures: `cpuTime`, cold boot, render cost                         | the (c) rows               | a deploy, a tail and a teardown per run         | no. One nightly sample carries no spread                                                                                    |

Push checks the model, and the release checks the artifact. Nothing scheduled checks the edge. The
release workflow runs on `workflow_dispatch` only.

Tracking edge figures needs a `workflow_dispatch` job that deploys a `cfw-*` worker, reads `cpuTime`
from the Observability API at n >= 5, tears the worker down, and reports the spread.
