# The Steps

`bun run build:local` runs these in order. Each is skipped when what it produces is already on disk,
so a re-run after a failure resumes rather than restarting. Together they produce **every artifact a
release payload carries**, which `tests/node/build-from-source.spec.ts` asserts against the payload's
own manifest rather than against a list.

| #   | step          | produces                                           | needs                 |
| --- | ------------- | -------------------------------------------------- | --------------------- |
| 1   | `interpreter` | `.interp/php8.5.wasm`, `.interp/php8.5-worker.mjs` | network               |
| 2   | `frame`       | `.interp/php8.5.wasm.br`                           | -                     |
| 3   | `siblings`    | `.siblings/{drupflare,rom,stream-http}`            | `git`                 |
| 4   | `driver`      | `assets/driver.json`                               | step 3                |
| 5   | `tree`        | `drupal-src/`                                      | `composer`, `tar`     |
| 6   | `mount`       | the driver modules, inside `drupal-src/`           | `bun`, step 5         |
| 7   | `site`        | `drupal-src/sites/default/settings.php`            | `php`, step 6         |
| 8   | `patch`       | the wasm-runtime patches, in place                 | `node`, step 7        |
| 9   | `bootstrap`   | a first `assets/drupal/core.json`, `core.bin.gz`   | `node`, step 5        |
| 10  | `twig`        | `assets/drupal/twig-bake.json`, `core.list.json`   | `php`, steps 8 and 9  |
| 11  | `core`        | the same two, repacked from the list               | `node`, step 10       |
| 12  | `pack`        | `assets/drupal-pf/core.pf.json`, `core.pf.bin`     | step 11               |
| 13  | `static`      | `assets/core/`                                     | step 5                |
| 14  | `agg`         | `assets/agg/`                                      | `bun`, step 5         |
| 15  | `container`   | the packed `cache_container` row, rekeyed          | a free port, step 12  |
| 16  | `sql`         | `assets/drupal-sql/`                               | `node`, `site.sqlite` |
| 17  | `prefill`     | `assets/prefill.json`                              | a free port, 1-16     |

## 1-2, The Interpreter

The shipping seam `src/runtime/php-binary-raw.ts` imports two files, and both have to exist before the
bundle builds: the glue and the interpreter itself.

`interpreter` restores the binary and its glue from the public CDN, verified by sha256 against
`cdn-manifest.json`, needing no credential. `bun install` already did this as a postinstall, so on a
normal clone the step is a no-op. When the CDN cannot be reached the step falls back to phasm's
workflow artifacts over `gh`: a different host on a different domain, so it is a second source and
never a retry.

`frame` compresses the binary to `.interp/php8.5.wasm.br`, and **the shipping bundle does not need
it.** The Worker size limit is 64 MiB uncompressed, with no compressed limit. `bun run release:check`
prints the current uncompressed figure. The interpreter travels as a raw `CompiledWasm` import, which
took startup from 106 ms to 5 ms on a deployed free worker.

The step stays because three configs under `experiments/wrangler/` still name the brotli seam, and it
is the rollback path if the raw import has to be reverted. It is brotli at quality 11 and window 22,
packed and inflated by `node:zlib`, so producer and consumer are the same implementation. The frame
is cached on mtime; pass `--force` to repack.

The build has no decoder step and needs no Docker.

## 3-4, The Driver Pack

Composer never runs on the edge, so a `require` in a manifest ships nothing. The Durable Object
mounts `assets/driver.json` into its in-memory filesystem, and that packed copy is what executes.

The two Drupal modules and the stream wrapper live in sibling repositories, which are the source of
truth. `siblings` resolves each one in this order and clones only what is missing:

1. `DRUPFLARE_SRC` / `ROM_SRC` / `STREAM_HTTP_SRC`, when set
2. `../drupflare`, `../rom`, `../stream-http` (the developer layout)
3. `.siblings/<name>` (this build's own clone)

An explicit environment setting outranks an inference from the layout, and the developer layout
outranks a private clone, so a checkout you are editing is never shadowed by a clone of master.

## 5-8, The Drupal Tree

`tree` downloads the pinned core tarball from ftp.drupal.org and completes it with the four
contributed modules the tarball does not carry. It is ~180 MB. A tree already at the requested
version is left alone, because re-extracting it rewrites every mtime, and mtime decides behaviour
here: Drupal's `MTimeProtectedFastFileStorage` hashes it into the compiled-Twig directory name.

`site` installs a Drupal site into `sites/build`, then points `sites/default/settings.php` at the
database it created. Nothing downstream reads that database as content; it exists so `bake-twig.php`
has a kernel to boot. A release tarball ships `default.settings.php` and no `settings.php` at all, so
without this step there is no site to boot.

**This step's database is a throwaway; the shipping one is built by the same script.** Both come from
`scripts/drupal/install-site-db.php`, and it refuses to write `assets/drupal/site.sqlite` without
`--allow-shipping-pack`, so the normal loop is build elsewhere and compare with
`node scripts/diff-site-db.ts`. [Site Database](../../architecture/database.md) is the recipe and lists every value the shipped
database disagrees with a stock install about.

`patch` rewrites the tree for the wasm runtime, and is idempotent. Drupal 11 uses `new \Fiber()` in
five places; PHP builds Fibers on ucontext, emscripten provides none, and the first Fiber aborts the
runtime. The patch swaps the class for a synchronous stand-in with the same surface. It also pins the
`twig` PHP-code bin to plain `FileStorage`, without which no precompiled Twig cache is reachable at
all: the default storage hashes the containing directory's mtime into the filename, and a mounted
MEMFS directory's mtime is mount time.

## 9-16, The Assets

`bootstrap` exists because the packers and the bake read each other's output. `bake-twig.php` builds
`core.list.json` as _the previous `core.json`, minus the compiled-Twig paths, plus the ones it just
compiled_, so on a checkout with no pack there is no list to build, and `PACK_INDEX=1` has no file
set. The bootstrap breaks that cycle by globbing the tree under `FULL=1` instead. It is skipped
entirely on a hydrated tree, which already has a `core.json`.

This is the one place where a source-built tree and a shipped one differ in content. The shipping
pack's file list came from a traced run that a checkout cannot repeat, so the bootstrap globs every
non-test file instead, and the bake derives its list from that. The difference is small, because the
profiled set is completed by rules that already reach most of the tree.

Measured on Drupal 11.4.5, a clean clone against the shipping artifacts. The shipped core version is
`SHIPPED_CORE_VERSION` in `src/ops/shipped-lock.ts`:

| artifact      | shipped    | source-built | delta            |
| ------------- | ---------- | ------------ | ---------------- |
| pack entries  | 11,444     | 11,446       | +2               |
| `core.pf.bin` | 11,992,672 | 12,457,108   | +464,436 (+3.9%) |
| `core.bin.gz` | 8,126,017  | 8,588,601    | +462,584 (+5.7%) |

The Worker bundle is unaffected; the packs are Workers assets and carry no bundle bytes.

`twig` bakes the precompiled Twig cache and writes two records: `twig-bake.json`, which the gate
reads, and `core.list.json`, the file list both packers then read.

`core` repacks the tree from that list. It runs under `PACK_INDEX=1`, which takes `core.list.json`
verbatim with no re-globbing, so a repack measures the tree and never the completion rules. It
rewrites the two files `bootstrap` wrote, and it is skipped only when they are NEWER than the list;
a presence check would skip the repack and ship a pack missing every template the bake just compiled.

`pack` rewrites that blob with every file compressed independently, which is what lets a file be
materialised when PHP opens it instead of inflating 11,447 files at boot. It then scrubs the pack:
`core.pf.bin` carries `settings.php` with a real `hash_salt`, Workers assets are served publicly, and
a packed-but-unscrubbed pack is the state `release-payload.ts` refuses to publish.

`static` copies the browser-fetchable half of the tree (`css`, `js`, fonts and images under
`core/`) into `assets/core/`, where the Workers Assets layer serves it at the `/core/**` URLs
Drupal already emits. Every pack skips those extensions because PHP never opens them, and nothing
serves a file out of the PHP MEMFS over HTTP, so this is the only thing that answers them. It copies
where the other steps pack: Workers Assets content-hashes and compresses what it serves, and a hit
never reaches the Worker. 4,028 files on the current tree, with
`core/profiles/demo_umami`, `tests/`, `node_modules/` and `.pcss.css` sources left out.

`sql` chunks the committed `site.sqlite` into the JSON the Durable Object replays in JavaScript. It
reads a tracked file, so it is the one step that works on a clone with nothing else built.

It also drops the bake's own history on the way through: `dropBakeHistory()` empties `watchdog` and
removes `state:install_time`. Without that, a new site inherits the bake's log dates and an install
time that makes the Cron requirement read as overdue. This is a build step rather than a hand edit,
because `bun install` restores the tracked database from the CDN and would revert a hand edit.

## 14, The Aggregates

`agg` reads the `*.libraries.yml` definitions out of `drupal-src` and emits immutable per-library CSS
and JS aggregates into `assets/agg/`, plus a file-to-library index. The output is not committed. The
serving side is off unless `ASSET_AGGREGATES=1`, and with no manifest present it changes nothing.

**It belongs in the numbered sequence, because `wrangler.jsonc` sets `ASSET_AGGREGATES: "1"`.** A
tree that builds the pack without it runs the lever with nothing to substitute, and the lever
degrades quietly by design, so nothing reports it. The symptom is `/agg/manifest.json` answering 404.

The output has to be published as well as built. `assets/.assetsignore` denies by default, so it
needs `!/agg/`; without that line the aggregates upload nowhere and a page with the lever on has no
CSS. The aggregates count against the Workers Assets store, not the 64 MiB bundle.
