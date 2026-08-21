# Repository Layout

Every path outside `src/`, how it arrives on a clean clone, and what breaks without it. Sizes are
`du -sh` on the development machine, 2026-08-18.

## Data Risk

Three versions of `assets/drupal/site.sqlite` existed. The SQLite header change counter orders them:

| copy                              | mtime            | bytes     | pages | change counter | writer |
| --------------------------------- | ---------------- | --------- | ----- | -------------- | ------ |
| `assets/drupal/site.sqlite`       | 2026-08-18 18:54 | 7,585,792 | 1852  | **26**         | 3.50.4 |
| `.pack-backup/site.sqlite.bak`    | 2026-08-12 03:10 | 7,585,792 | 1852  | **16**         | 3.50.4 |
| the previous `drupflare-cdn` copy | --               | 6,627,328 | 1618  | **13**         | 3.53.4 |

**The live tree is canonical.** The 6.6 MB copy is a different lineage rather than an older revision:
1618 pages against 1852, written by a newer SQLite, and it is the original hand-trimmed artifact the
report describes. `.pack-backup/site.sqlite.bak` is the rollback point for the current lineage.

All three are in the bucket and none was replaced:

| key                                            | bytes     | is                              |
| ---------------------------------------------- | --------- | ------------------------------- |
| `assets/drupal/site.sqlite`                    | 7,585,792 | the canonical live copy         |
| `snapshots/site.sqlite.a18db26a417b`           | 7,585,792 | the counter-19 bytes, by digest |
| `snapshots/site.sqlite.064105ca7223`           | 7,585,792 | the counter-16 rollback point   |
| `assets/drupal/site.sqlite.trimmed-1618p-cc13` | 6,627,328 | the original trimmed lineage    |

The live copy has advanced to change counter 26 since those digests were recorded, so the
`assets/drupal/site.sqlite` key is only current if it has been re-uploaded.
`bun run backup:cdn` refuses to replace any key whose remote content differs from local without
`--allow-overwrite`, and `bun run backup:verify` compares every key by size and ETag.

## `.pack-backup/`

7.2 MB, one file, and it stays. It is the rollback point for the canonical lineage, it is a distinct
version of an artifact whose trim recipe is written down nowhere, and `bun run bake:pack` **overwrites
it on its next run** (`scripts/bake-pack.ts:138`, the `snapshot` step). Its content is also in the
bucket at `snapshots/site.sqlite.064105ca7223`.

## Tracked Against Untracked

**382 files are tracked. 3.3 GB is on disk.** A deploy reads `src/`, `assets/` and `.interp/`. The
rest of the untracked bulk is build input, measurement state, or regenerable output.

| path                | size | tracked        | how it arrives on a clean clone                                              | delete?          |
| ------------------- | ---- | -------------- | ---------------------------------------------------------------------------- | ---------------- |
| `src/`              | 1.7M | 84 of 87 files | committed                                                                    | no               |
| `tests/`            | 1.5M | 122 of 127     | committed                                                                    | no               |
| `scripts/`          | 760K | 83 of 84       | committed                                                                    | no               |
| `docs/`             | 92K  | yes            | committed                                                                    | no               |
| `assets/`           | 121M | 2 files        | `bun run hydrate`; `bun run build:local` in full                             | no               |
| `.interp/`          | 17M  | no             | `bun install` restores 2 of 3; `bun run hydrate` or `build:local` the rest   | no               |
| `.siblings/`        | --   | no             | `bun run build:local`, only when the modules are not checked out beside this | yes, regenerable |
| `vendor/`           | 198M | no             | not reproducible; restored from `drupflare-cdn/vendor/`. Not a deploy input  | never            |
| `drupal-src/`       | 189M | no             | `bun run fetch:drupal`, which `build.yml` also calls                         | yes, regenerable |
| `experiments/`      | 256K | 52 files       | committed                                                                    | no               |
| `.pack-backup/`     | 7.2M | no             | `bun run bake:pack`                                                          | no               |
| `.contrib-fixture/` | 27M  | no             | `bun run test:contrib`, and only while it is running                         | no               |
| `.trim-assets/`     | 7.6M | no             | `bash scripts/stage-edge-assets.sh`                                          | yes, regenerable |
| `typedoc/`          | 7.9M | no             | `bun run docs:build`                                                         | yes, regenerable |
| `coverage/`         | 4.6M | no             | `bun run test:coverage`                                                      | yes, regenerable |
| `dist/`             | 35M  | no             | `bun run release:payload`                                                    | yes, regenerable |
| `.wrangler/`        | 1.8G | no             | any `wrangler dev` or vitest run                                             | yes, regenerable |
| `node_modules/`     | 883M | no             | `bun install`                                                                | yes, regenerable |

Two paths this table used to carry are gone. `drupal-min-src/` had no producer and was read only by
`src/probes/min.ts`. `build/` was a stale copy of phasm's toolchain: 9 rc files against phasm's 16,
three shared scripts all smaller than their upstream, and nothing under `src/`, `scripts/` or
`tests/` reading any of it. Its one live subdirectory, `build/wasm/`, is now `.interp/`, a build
output in its own top-level directory with one producer, `bun run build:wasm`.

phasm should not become a submodule. The worker consumes its output rather than its source, and a
submodule would put a Docker toolchain in a clean clone's dependency path.

## `experiments/`

52 files, 88,300 bytes, all committed: **44 wrangler probe configs**, their README, one probe seam
config, two binary seams and four data files from the boot-phase sweeps. `CLAUDE.md` keeps them
prettier-ignored — they are kept for reproduction, not maintained.

The 282 MB of `experiments/wrangler/.wrangler` miniflare state this section used to describe is gone;
it regenerates on the next `wrangler dev` and is gitignored.

## `assets/core/`

24 MB, 4,028 files, produced by `bun run assets:static` from step 13 of the source build. It is the
browser-fetchable half of the Drupal tree — `css`, `js`, fonts and images under `core/` — copied to
where Workers Assets serves it at the `/core/**` URLs Drupal already emits.

All three PHP packers skip those extensions, correctly, because PHP never opens them. But nothing
serves a file out of the PHP MEMFS over HTTP either, so before this every stylesheet, script and font
404'd. It is a copy rather than a pack: Workers Assets content-hashes, caches and compresses what it
serves, and a hit never reaches the Worker, so the tree costs nothing against either free-tier
ceiling.

`assets/.assetsignore` denies by default and negates `/core/`; `tests/unit/runtime/assets-ignore.spec.ts`
asserts both that the negation reaches into the directory and that every `/core/**` URL a prefilled
page references answers 200.

## `vendor/`

`wrangler deploy` does not read it. The canonical config aliases `./runtime/php-binary.js` to
`src/runtime/php-binary-85.ts`, which imports the interpreter from `.interp/`. `vendor/` reaches a
bundle only through the unaliased default seam `src/runtime/php-binary.ts` and the `src/probes/**`
configs, so it is a local store of hand-built binaries kept for reproducing past measurements.

Never delete, move or overwrite anything under it. What has changed is the recovery position, not the
rule: **35 of 35 keys are in `drupflare-cdn`**, and every one matches on size and on ETag-against-md5.
`vendor/static-o3mbsjlj/php8.3-worker.mjs{,.wasm}` were the last two missing and were uploaded.

`vendor/php8.3.wasm`, `vendor/php8.4.wasm` and their `-web.mjs` glue are the only reproducible entries:
`bun run vendor` copies them out of the `php-wasm` npm package. They cost 27 MB and are backed up, and
no change is recommended.

## `drupal-src/`

The Drupal tree the packers read, and the only path that satisfies `DRUPAL_ROOT`. `bun run fetch:drupal`
produces it: the release tarball for `SHIPPED_CORE_VERSION` from `ftp.drupal.org`, extracted with the
`drupal-<version>/` wrapper stripped, then completed with the four contributed modules the tarball does
not carry. `DRUPAL_VERSION` overrides the version; `--force` replaces a tree that is present at a
different one. A second run on a satisfied tree downloads nothing.

`.github/workflows/build.yml` calls the same script and keys its cache on
`bun scripts/fetch-drupal-tree.ts --print-version`, so a developer and the gate lane hold the same tree.
`tests/node/drupal-tree.spec.ts` fails if the workflow grows a second producer.

The tarball is core only. `SHIPPED_LOCK_VERSIONS` names `admin_toolbar`, `ctools`, `pathauto` and
`token` beyond it, so the script installs those four at their pinned versions with composer;
`tests/node/shipped-lock.spec.ts` compares the resulting `composer.lock` against the baked map.

Four things need it. `assets:twig`, `assets:core`, `assets:pack` and `assets:static` read it as their
build input. `bun run test:php` and the sibling PHP suites in `../drupflare` and `../rom` take it as
`DRUPAL_ROOT`.
`composer analyze` resolves `\Drupal\Core\...` against it through `phpstan.neon`. An IDE indexes it for
the same reason. Everything except the packers degrades to skipped or unresolved without it rather than
failing loudly, so the tree being absent is quiet.

## `.siblings/`

`bun run assets:driver` reads the sibling checkouts of `drupflare/drupflare`, `drupflare/rom` and
`drupflare/stream-http` directly and packs them into `assets/driver.json`. **There is no in-repo copy
of the modules.** One existed, at `drupal/`, and it was what the packer read; it drifted from both
siblings, with `CircuitBreaker.php` differing and the test copies sitting 8 assertions behind and
nothing reporting it.

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
`scripts/build-oracle.ts` was deleted: no `wrangler.*.jsonc` declares `ORACLE_KV`, so
`src/ops/oracle.ts` always fell through to the live check and the oracle it built had no consumer.

| script                         | refs | state                                                                                                                                                           |
| ------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/bake-container.php`   | 0    | superseded. `bake-pack.ts` records that rewriting the container key by hand produced a byte-identical render that still missed, which is what this script does. |
| `scripts/stage-edge-assets.sh` | 3    | superseded by `assets/.assetsignore` for the canonical config, still used by `experiments/wrangler/*`. Keep.                                                    |

`scripts/` needs no reorganisation. Its four groups map to the rule in `scripts/README.md`: live pipeline
in TypeScript, `bench/` PHP for the native half of a ratio, `probe/` shell pairs, `measure/` frozen
instruments. `CLAUDE.md` freezes `src/probes/**` on the same grounds. `release-payload.ts`,
`hydrate.ts` and `backup-cdn.ts` sit flat alongside `pack-*.ts` and `gen-driver-assets.ts`.
`experiments/` is the counterpart to `src/probes/**`: configs kept for reproduction, prettier-ignored.

## QA Coverage of the Report's Claims

Thirteen load-bearing claims from the executive summary and above the FOLD, scored by what a test can
catch. Three classes:

- **(a) arithmetic or model** -- hermetic, free, in the gate.
- **(b) artifact** -- needs bytes on disk; runs in the release lane, which hydrates the payload.
- **(c) edge** -- needs a deployed worker. An absolute CPU figure comes only from `cpuTime` on one.

| #   | claim                                                                   | class | caught?                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | the bundle fits the 3 MiB ceiling                                       | b     | **yes.** `bun run release:check` parses wrangler's printed figure and fails over the ceiling; the release lane runs it. `tests/unit/bundle-size.spec.ts` covers the arithmetic.         |
| 2   | PHP 8.5 is 2,659,444 zstd bytes with every extension intact             | b     | **size yes, extensions no.** `interp.lock.json` and the payload manifest pin the frame's sha256. Nothing here asserts `Zend OPcache` is in the binary; phasm's `inspect-build.sh` does. |
| 3   | serving 3.0M visits/month, regeneration 7,575 renders/day               | a     | **yes.** `tests/unit/free-envelope.spec.ts` over `scripts/measure/free-envelope.ts`.                                                                                                    |
| 4   | a fill costs 3 / 13 / 19 / 62 rows                                      | a     | **partly.** `tests/unit/db/write-tally.spec.ts` counts rows through a real Durable Object; the four warmth classes are model constants.                                                 |
| 5   | first-run migration is 62 chunks                                        | a     | **yes.** `assets/drupal-sql/manifest.json` reports `"chunks": 62`. The count moves with the packed database, so quote the manifest rather than a document.                              |
| 6   | `assets/driver.json` is the code that executes, and is current          | b     | **yes.** `tests/node/driver-pack.spec.ts`, byte for byte.                                                                                                                               |
| 7   | the canonical config reaches its own code                               | a     | **yes.** `tests/node/wrangler-reachability.spec.ts` covers five defects of that shape, including the binary alias.                                                                      |
| 8   | the compiled Twig cache is reachable at the key the runtime asks for    | b     | **yes, in the release lane.** `tests/node/twig-bake.spec.ts` with `REQUIRE_ARTIFACTS=1`.                                                                                                |
| 9   | DO SQLite: 100 bound params, 50-byte LIKE, lossy above 2^53             | a     | **yes.** `tests/unit/db/do-sqlite.spec.ts` and `tests/unit/db/file-store.spec.ts`, inside workerd against the real limits.                                                              |
| 10  | cold boot 1,398 ms, `page_cache` hit 1 ms, render 34 ms, startup 112 ms | c     | **no.** In-PHP `microtime()` and `Date.now()` both return 0 on the edge.                                                                                                                |
| 11  | the shipping asset set is exactly what the runtime fetches              | a     | **yes.** `tests/unit/runtime/assets-ignore.spec.ts` through the real `ASSETS` binding, plus the payload's bidirectional check against the same file.                                    |
| 12  | 19 tripwires, and the repair ladder fails closed mid-transaction        | a     | **yes.** `tests/unit/ops/repair.spec.ts`. 12 in `HOST_TRIPWIRES`, 7 under `drupflare/src/Health/Tripwire/`.                                                                             |
| 13  | the render origin is a property of the site, not of the request         | a     | **yes.** `tests/unit/ops/site-origin.spec.ts` and `tests/integration/render-origin.spec.ts`.                                                                                            |

One gap remains. Claim 2's extension set is asserted in phasm and nowhere here, so a binary swap that
dropped `opcache` would pass this repository's gate and change PHP boot by ~70 ms.

## Nightly Automation

| lane                                                                    | asserts       | cost                                            | verdict                                                                                                                                                             |
| ----------------------------------------------------------------------- | ------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| model figures: free envelope, ceiling arithmetic, rows-per-fill classes | every (a) row | seconds, hermetic                               | already in the gate; a nightly adds nothing a push does not                                                                                                         |
| artifact figures: payload manifest, frame sizes, chunk count, Twig keys | the (b) rows  | one payload download plus a dry-run, ~3 minutes | built, in the release lane. Worth running nightly against the latest release to catch an asset that has been deleted or replaced                                    |
| CDN backup intact                                                       | 40 keys       | 40 HEADs, no credentials                        | built. `.github/workflows/backup.yml`, nightly at 05:20                                                                                                             |
| edge figures: `cpuTime`, cold boot, render cost                         | the (c) rows  | a deploy, a tail and a teardown per run         | no. It needs a deploy into an account carrying production workers, and the platform is bimodal by 400-600 ms, so an n=1 nightly figure is noise reported as a trend |

The recommendation is the split that exists: **push proves the model, the release proves the artifact, and
nothing automated proves the edge.** The one addition worth making is a nightly re-run of the release
lane's `payload` job against the latest published release, at ~3 minutes of runner time.

Edge figures, if they are ever tracked, need a manual `workflow_dispatch` that deploys a `cfw-*`
throwaway, reads `cpuTime` from the Observability API at n>=5, tears it down and asserts a **spread**.
That is separate work, it needs an account decision, and it is not a test.
