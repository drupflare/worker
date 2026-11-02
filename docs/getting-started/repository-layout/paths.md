# Tracked and Generated Paths

Which paths the repository tracks, which it generates, and what each top-level directory holds.

## Tracked Against Untracked

A deploy reads `src/`, `assets/` and `.interp/`. The rest of the untracked bulk is build input,
measurement state, or regenerable output.

**Measure the counts rather than reading them here.** `git ls-files | wc -l` and `du -sh` are the
instruments. The shape of the table is what is meant to last; the numbers in it go stale.

| path                | size | tracked | how it arrives on a clean clone                                              | delete?          |
| ------------------- | ---- | ------- | ---------------------------------------------------------------------------- | ---------------- |
| `src/`              | 4.5M | yes     | committed                                                                    | no               |
| `tests/`            | 6.0M | yes     | committed                                                                    | no               |
| `scripts/`          | 17M  | yes     | committed                                                                    | no               |
| `docs/`             | 1.1M | yes     | committed                                                                    | no               |
| `assets/`           | 207M | 5 files | `bun run hydrate`; `bun run build:local` in full                             | no               |
| `.interp/`          | 251M | no      | `bun install` restores 2 of 3; `bun run hydrate` or `build:local` the rest   | no               |
| `.siblings/`        | --   | no      | `bun run build:local`, only when the modules are not checked out beside this | yes, regenerable |
| `vendor/`           | 198M | no      | not reproducible; restored from `drupflare-cdn/vendor/`. Not a deploy input  | never            |
| `drupal-src/`       | 173M | no      | `bun run fetch:drupal`, which `build.yml` also calls                         | yes, regenerable |
| `experiments/`      | 340K | yes     | committed                                                                    | no               |
| `.pack-backup/`     | 7.2M | no      | `bun run bake:pack`                                                          | no               |
| `.contrib-fixture/` | 38M  | no      | `bun run test:contrib`, and only while it is running                         | no               |
| `.trim-assets/`     | 37M  | no      | `bash scripts/stage-edge-assets.sh`                                          | yes, regenerable |
| `typedoc/`          | 37M  | no      | `bun run docs:build`                                                         | yes, regenerable |
| `coverage/`         | --   | no      | `bun run test:coverage`                                                      | yes, regenerable |
| `dist/`             | 74M  | no      | `bun run release:payload`                                                    | yes, regenerable |
| `.wrangler/`        | 209M | no      | any `wrangler dev` or vitest run                                             | yes, regenerable |
| `node_modules/`     | 950M | no      | `bun install`                                                                | yes, regenerable |

`.wrangler/` grows with every `wrangler dev` session and vitest run, and nothing prunes it. Delete it
when disk space matters.

`docker/` holds two rigs, which are unrelated. `compose.yml` is the nine-service integration rig
(GreenMail, Postgres, MySQL, Redis, syslog, Gitea, Forgejo, Keycloak, GitLab). `vps.yml` with
`docker/vps/` is the comparison arm: nginx and PHP 8.5 FPM running the same `drupal-src` tree and the
same `assets/drupal/site.sqlite` this project serves, so a measurement isolates the runtime. The arm
mounts the tracked database read-only and copies it, because SQLite writes to the file it reads.

## `docs/`

`docs/` holds seven folders: `getting-started/`, `operating/`, `architecture/`, `configuration/`,
`security/`, `impact/` and `audiences/`. Each has an `index.md` that lists its pages, and a page
longer than about 250 lines becomes a folder of its own with an `index.md` and sibling pages.
`docs/operating/recovery.md` publishes as `operating/recovery.html`, and a folder's index publishes
as `<folder>/index.html`. `docs/README.md` is a map for the repository and is not published.

The published navigation lists only the top-level entries, which are each folder's index and the
technical report, and each page's contents list holds its `##` headings only. A page is reached from
its folder's index and from links in the text. A new page goes in the folder it belongs to and needs
a `# ` title and a lead paragraph, which becomes its description. A new folder needs an `index.md`
and an entry in `TOP` in `scripts/docs/pages.ts`.

Moving or splitting a page means adding its old name to `scripts/docs/moves.json`, which writes a
redirect page at the old URL. An entry is a new page name, or `{ "to": ..., "anchors": { ... } }`
where `anchors` sends a heading that moved to another page to that page, so a link to the heading
keeps working. Fix every link to the old path as well.
`tests/node/docs-site.spec.ts` fails on a folder with no index, a page with no lead or title, a moved
page with no redirect, a redirect or anchor that does not resolve, and a relative link that does not
resolve.

## `experiments/`

73 files, 112,477 bytes, all committed, per `git ls-files experiments`: **63 wrangler configs** (61
under `experiments/wrangler/`, including the old rig and bench configs moved there from the repo
root, and one each in `arena/` and `duration/`), plus the
`experiments/wrangler/README.md`, the probe seams those directories pair with their configs, two
binary seams under `binary/`, a loose `probe-o3mbsjlj.ts` at the top, and the data files from the
boot-phase sweeps. They are kept for reproduction and are not maintained. `.prettierignore` excludes
the directory from formatting.

## `assets/core/`

24 MB, 4,028 files, produced by `bun run assets:static` from step 13 of the source build. It is the
browser-fetchable half of the Drupal tree (`css`, `js`, fonts and images under `core/`) copied to
where Workers Assets serves it at the `/core/**` URLs Drupal already emits.

All three PHP packers skip those extensions, because PHP never opens them. Nothing serves a file out
of the PHP MEMFS over HTTP, so these files reach the browser only through this directory. Workers
Assets content-hashes, caches and compresses what it serves, and a cache hit never reaches the Worker.

`assets/.assetsignore` denies by default and negates `/core/`. `tests/unit/runtime/assets-ignore.spec.ts`
asserts that the negation reaches into the directory and that every `/core/**` URL a prefilled page
references answers 200. The tracked `assets/_headers` sets the cache lifetimes of that tree; see
Static Asset Cache Lifetimes in `docs/configuration/index.md`.

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

Composer never runs on the edge, so a `composer require` ships nothing: the packed tree is the vendor
directory, and the packed copy is what executes. `composer.json` records provenance and lets a
developer resolve the packages normally. Both packages are on Packagist as `drupflare/rom` and
`drupflare/drupflare`.
`tests/node/driver-pack.spec.ts` rebuilds `assets/driver.json` from the modules on disk and compares byte
for byte, so a stale pack fails the gate.

The packer takes an allow-list of module-shaped paths (`src`, `.info.yml`, `.install`, `.module`,
`.services.yml`), because a module repository is not a module and walking a checkout wholesale would
pull `node_modules/`, `vendor/` and `coverage/` into the bundle. The machine name comes from the
mount rather than the directory: `../rom` provides `cfw_do_sqlite`.

Each of the three is resolved as `DRUPFLARE_SRC` / `ROM_SRC` / `STREAM_HTTP_SRC`, then `../<name>`, then
`.siblings/<name>`. CI sets the environment variables and checks the repositories out under `.siblings/`;
`bun run build:local` clones into the same paths, and only the ones that are not already there.
