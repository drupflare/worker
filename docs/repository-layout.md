# Repository Layout

Every path outside `src/`, how it arrives on a clean clone, and what breaks without it. Sizes are
`du -sh` on the development machine, 2026-08-14.

## Data Risk

Three versions of `assets/drupal/site.sqlite` existed. The SQLite header change counter orders them:

| copy                              | mtime            | bytes     | pages | change counter | writer |
| --------------------------------- | ---------------- | --------- | ----- | -------------- | ------ |
| `assets/drupal/site.sqlite`       | 2026-08-13 16:23 | 7,585,792 | 1852  | **19**         | 3.50.4 |
| `.pack-backup/site.sqlite.bak`    | 2026-08-12 03:10 | 7,585,792 | 1852  | **16**         | 3.50.4 |
| the previous `drupflare-cdn` copy | --               | 6,627,328 | 1618  | **13**         | 3.53.4 |

**The live tree is canonical.** The 6.6 MB copy is a different lineage rather than an older revision:
1618 pages against 1852, written by a newer SQLite, and it is the original hand-trimmed artifact the
report describes. `.pack-backup/site.sqlite.bak` is the rollback point for the current lineage.

All three are in the bucket and none was replaced:

| key                                            | bytes     | is                               |
| ---------------------------------------------- | --------- | -------------------------------- |
| `assets/drupal/site.sqlite`                    | 7,585,792 | the canonical live copy          |
| `snapshots/site.sqlite.a18db26a417b`           | 7,585,792 | the same bytes, pinned by digest |
| `snapshots/site.sqlite.064105ca7223`           | 7,585,792 | the counter-16 rollback point    |
| `assets/drupal/site.sqlite.trimmed-1618p-cc13` | 6,627,328 | the original trimmed lineage     |

`bun run backup:cdn` refuses to replace any key whose remote content differs from local without
`--allow-overwrite`, and `bun run backup:verify` compares every key by size and ETag.

## `.pack-backup/`

7.2 MB, one file, and it stays. It is the rollback point for the canonical lineage, it is a distinct
version of an artifact whose trim recipe is written down nowhere, and `bun run bake:pack` **overwrites
it on its next run** (`scripts/bake-pack.ts:138`, the `snapshot` step). Its content is also in the
bucket at `snapshots/site.sqlite.064105ca7223`.

## Tracked Against Untracked

**29 files are tracked. 3.9 GB is on disk.** A deploy reads `src/`, `assets/` and `.interp/`. The rest
of the untracked bulk is build input, measurement state, or regenerable output.

| path              | size | tracked         | how it arrives on a clean clone                                              | delete?          |
| ----------------- | ---- | --------------- | ---------------------------------------------------------------------------- | ---------------- |
| `src/`            | 15M  | 15 of 76 files  | committed                                                                    | no               |
| `tests/`          | 884K | no, not ignored | committed                                                                    | no               |
| `scripts/`        | 420K | no, not ignored | committed                                                                    | no               |
| `assets/`         | 97M  | no              | `bun run hydrate`, for the 22 MB that ships; `bun run build:local` in full   | no               |
| `.interp/`        | 17M  | no              | `bun install` restores 2 of 3; `bun run hydrate` or `build:local` the rest   | no               |
| `.siblings/`      | 3.4M | no              | `bun run build:local`, only when the modules are not checked out beside this | yes, regenerable |
| `vendor/`         | 198M | no              | not reproducible; restored from `drupflare-cdn/vendor/`. Not a deploy input  | never            |
| `drupal-src/`     | 159M | no              | `bun run fetch:drupal`, which `build.yml` also calls                         | yes, regenerable |
| `drupal-min-src/` | 164M | no              | no producer; read only by `src/probes/min.ts` and `stage-edge-assets.sh`     | recommend        |
| `experiments/`    | 282M | no              | 88,874 bytes of configs are committed; the rest is dev state                 | see below        |
| `build/`          | 96K  | no              | a stale copy of `phasm`'s toolchain                                          | recommend        |
| `.pack-backup/`   | 7.2M | no              | `bun run bake:pack`                                                          | no               |
| `.trim-assets/`   | 7.5M | no              | `bash scripts/stage-edge-assets.sh`                                          | yes, regenerable |
| `typedoc/`        | 7.0M | no              | `bun run docs:build`                                                         | yes, regenerable |
| `coverage/`       | 3.2M | no              | `bun run test:coverage`                                                      | yes, regenerable |
| `dist/`           | 22M  | no              | `bun run release:payload`                                                    | yes, regenerable |
| `.wrangler/`      | 1.7G | no              | any `wrangler dev` or vitest run                                             | yes, regenerable |
| `node_modules/`   | 828M | no              | `bun install`                                                                | yes, regenerable |

## `experiments/`

```txt
282M  experiments
282M  experiments/wrangler/.wrangler
 52 files, 88,874 bytes outside .wrangler
```

`experiments/wrangler/.wrangler` is miniflare state: Durable Object SQLite files and
`observability/miniflare-wobs-trace-store` blobs, regenerated by the next `wrangler dev`. It is already
gitignored, so this is disk hygiene rather than a tracking problem, and it is the largest safe cleanup
available. The 44 probe configs and their README stay; `CLAUDE.md` keeps them prettier-ignored for
reproduction.

## `build/`

Recommend deleting `build/` and pointing `README.md` at `drupflare/phasm`:

- `build/rc/` has **9** rc files; `phasm/src/rc/` has **16**, including every 8.4 and 8.5 variant
  (`control84`, `control85`, `min85`, `trim85`, `noopcache85`, `nopdo85`, `mergefunc85`,
  `nolexbor85.rc.pending`). `build/` predates the PHP 8.5 programme, which is what now ships.
- All three shared scripts differ and phasm's are larger: `build-variant.sh` 1,993 -> 2,323 bytes,
  `patch-vm-interrupt.sh` 8,498 -> 11,026, `build-static.sh` 7,076 -> 9,995. phasm also carries
  `fetch-deps.sh`, `inspect-build.sh`, `pin-builder-image.sh`, `patch-drop-opcache.sh`,
  `patch-drop-lexbor-html.sh`, `patch-iconv-pic.sh` and `deps.lock`, none of which exist here.
- Nothing under `src/`, `scripts/` or `tests/` reads any of it.

`build/wasm/` was the one live thing inside it and has moved to **`.interp/`**, a build output in its own
top-level directory with one producer, `bun run build:wasm`. The dry-run reports the same
`gzip: 2808.67 KiB` after the move, so the `CompiledWasm` and `Data` loader rules still match a
dot-directory.

phasm should not become a submodule. The worker consumes its output rather than its source, and a
submodule would put a Docker toolchain in a clean clone's dependency path.

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

Four things need it. `assets:twig`, `assets:core` and `assets:pack` read it as their build input.
`bun run test:php` and the sibling PHP suites in `../drupflare` and `../rom` take it as `DRUPAL_ROOT`.
`composer analyze` resolves `\Drupal\Core\...` against it through `phpstan.neon`. An IDE indexes it for
the same reason. Everything except the packers degrades to skipped or unresolved without it rather than
failing loudly, so the tree being absent is quiet.

## `.siblings/`

**`drupal/` is gone.** It held module-shaped copies of `drupflare/drupflare` and `drupflare/rom`, it was
what the packer read, and it had drifted from both: `CircuitBreaker.php` differed from its sibling and the
test copies sat 8 assertions behind, with nothing reporting it. `bun run assets:driver` now reads the
sibling checkouts directly, the way it already read `drupflare/stream-http` -- whose entry had said why:
"a fourth copy is what created the drift".

Composer never runs on the edge, so the packed copy is what executes.
`tests/node/driver-pack.spec.ts` rebuilds `assets/driver.json` from the modules on disk and compares byte
for byte, so a stale pack still fails the gate.

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

Ten load-bearing claims from the executive summary and above the FOLD, scored by what a test can catch.
Three classes:

- **(a) arithmetic or model** -- hermetic, free, in the gate.
- **(b) artifact** -- needs bytes on disk; runs in the release lane, which hydrates the payload.
- **(c) edge** -- needs a deployed worker. An absolute CPU figure comes only from `cpuTime` on one.

| #   | claim                                                                   | class | caught?                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | the bundle fits the 3 MiB ceiling                                       | b     | **yes.** `bun run release:check` parses wrangler's printed figure and fails over the ceiling; the release lane runs it. `tests/unit/bundle-size.spec.ts` covers the arithmetic. |
| 2   | PHP 8.5 is 2,659,133 zstd bytes with every extension intact             | b     | **size yes, extensions no.** The payload manifest pins the frame's sha256. Nothing here asserts `Zend OPcache` is in the binary; phasm's `inspect-build.sh` does.               |
| 3   | serving 3.0M visits/month, regeneration 7,575 renders/day               | a     | **yes.** `tests/unit/free-envelope.spec.ts` over `scripts/measure/free-envelope.ts`.                                                                                            |
| 4   | a fill costs 3 / 13 / 19 / 62 rows                                      | a     | **partly.** `tests/unit/db/write-tally.spec.ts` counts rows through a real Durable Object; the four warmth classes are model constants.                                         |
| 5   | first-run migration is 101 chunks                                       | a     | **stale claim.** `assets/drupal-sql/manifest.json` reports `"chunks": 79`, and `bake-pack.ts` records the count moving 101 -> 86 -> 79. README and the report still say 101.    |
| 6   | `assets/driver.json` is the code that executes, and is current          | b     | **yes.** `tests/node/driver-pack.spec.ts`, byte for byte.                                                                                                                       |
| 7   | the canonical config reaches its own code                               | a     | **yes.** `tests/node/wrangler-reachability.spec.ts` covers five defects of that shape, including the binary alias.                                                              |
| 8   | the compiled Twig cache is reachable at the key the runtime asks for    | b     | **yes, in the release lane.** `tests/node/twig-bake.spec.ts` with `REQUIRE_ARTIFACTS=1`.                                                                                        |
| 9   | DO SQLite: 100 bound params, 50-byte LIKE, lossy above 2^53             | a     | **yes.** `tests/unit/db/do-sqlite.spec.ts` and `tests/unit/db/file-store.spec.ts`, inside workerd against the real limits.                                                      |
| 10  | cold boot 1,398 ms, `page_cache` hit 1 ms, render 34 ms, startup 112 ms | c     | **no.** In-PHP `microtime()` and `Date.now()` both return 0 on the edge.                                                                                                        |
| 11  | the shipping asset set is exactly what the runtime fetches              | a     | **yes.** `tests/unit/runtime/assets-ignore.spec.ts` through the real `ASSETS` binding, plus the payload's bidirectional check against the same file.                            |
| 12  | 17 tripwires, and the repair ladder fails closed mid-transaction        | a     | **yes.** `tests/unit/ops/repair.spec.ts`.                                                                                                                                       |

Two gaps. Claim 2's extension set is asserted in phasm and nowhere here, so a binary swap that dropped
`opcache` would pass this repository's gate and change PHP boot by ~70 ms. Claim 5 is a figure that no
longer matches the artifact it describes.

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
