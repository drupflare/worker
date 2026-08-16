# Building From Source

Two commands turn a clean clone into a deployable tree, and they are not interchangeable.

| route       | command               | needs                                          | takes   |
| ----------- | --------------------- | ---------------------------------------------- | ------- |
| **payload** | `bun run hydrate`     | network                                        | seconds |
| **source**  | `bun run build:local` | network, PHP, composer, node 24+, zstd, Docker | minutes |

`bun run hydrate` takes the payload route by default and falls back to the source route when no
payload exists. `--payload-only` forbids the fallback; `--from-source` skips straight to it.

## Why Two Routes

`assets/` is ~97 MB of generated packs and `.interp/` holds the interpreter. Both are gitignored, so
a clean checkout has neither and `wrangler deploy` has nothing to upload.

The payload route downloads them from a GitHub Release as one verified tarball. It is a plain HTTPS
GET: no Docker, no `gh` auth, no PHP, no Cloudflare credential. That is what makes the Deploy to
Cloudflare button work, since its build command is `bun install && bun run hydrate` and Workers
Builds has no Docker to build with.

The source route regenerates the same bytes locally. It exists for the case the payload cannot
cover: a checkout of a commit no release was cut from, and the window before the first release
exists at all.

## Quick Start

```sh
git clone https://github.com/drupflare/worker.git
cd worker
bun install     # postinstall restores the interpreter from the CDN, verified by sha256
bun run hydrate # payload if there is one, source build if there is not
bun run dev
```

To see what a build would do without doing it:

```sh
bun run build:plan
```

## Prerequisites, Per Route

The payload route needs Bun and a network. Nothing else.

The source route needs each of these, and `bun run build:plan` names any that are missing before it
spends a minute:

| tool       | version | used by                | note                                                       |
| ---------- | ------- | ---------------------- | ---------------------------------------------------------- |
| `bun`      | latest  | everything             |                                                            |
| `node`     | 24+     | `core`, `sql`, `patch` | `node:sqlite`, which Bun does not ship                     |
| `php`      | 8.3+    | `site`, `twig`         | with `pdo_sqlite`, `sqlite3`, `mbstring`, `iconv`          |
| `composer` | 2       | `tree`                 | the Drupal release tarball is core only                    |
| `zstd`     | any     | `frame`                | `brew install zstd`                                        |
| `docker`   | running | `decoder`              | once, ever; the output is cached and the inputs are pinned |
| `git`      | any     | `siblings`             |                                                            |
| `tar`      | any     | `tree`                 |                                                            |

Two of these run under `node` rather than `bun` on purpose. `pack-sql.ts` needs `node:sqlite`.
`pack-drupal.ts` writes `core.bin.gz` from `gzipSync(blob, { level: 9 })`, and the two runtimes do
not emit the same deflate stream for the same input, so running it under Bun would move a shipped
asset with nothing reporting it.

## The Steps

`bun run build:local` runs these in order. Each is skipped when what it produces is already on disk,
so a re-run after a failure resumes rather than restarting.

| #   | step          | produces                                           | needs                 |
| --- | ------------- | -------------------------------------------------- | --------------------- |
| 1   | `interpreter` | `.interp/php8.5.wasm`, `.interp/php8.5-worker.mjs` | network               |
| 2   | `frame`       | `.interp/php8.5.wasm.zst`                          | `zstd`                |
| 3   | `decoder`     | `.interp/zstddec.wasm`                             | `docker`              |
| 4   | `siblings`    | `.siblings/{drupflare,rom,stream-http}`            | `git`                 |
| 5   | `driver`      | `assets/driver.json`                               | step 4                |
| 6   | `tree`        | `drupal-src/`                                      | `composer`, `tar`     |
| 7   | `site`        | `drupal-src/sites/default/settings.php`            | `php`, step 6         |
| 8   | `patch`       | the wasm-runtime patches, in place                 | `node`, step 7        |
| 9   | `bootstrap`   | a first `assets/drupal/core.json`, `core.bin.gz`   | `node`, step 6        |
| 10  | `twig`        | `assets/drupal/twig-bake.json`, `core.list.json`   | `php`, steps 8 and 9  |
| 11  | `core`        | the same two, repacked from the list               | `node`, step 10       |
| 12  | `pack`        | `assets/drupal-pf/core.pf.json`, `core.pf.bin`     | step 11               |
| 13  | `sql`         | `assets/drupal-sql/`                               | `node`, `site.sqlite` |

### 1-3, The Interpreter

The shipping seam `src/runtime/php-binary-85.ts` imports three files, and all three have to exist
before the bundle builds: the glue, the zstd frame, and the decoder that inflates it.

`interpreter` restores the binary and its glue from the public CDN, verified by sha256 against
`cdn-manifest.json`, needing no credential. `bun install` already did this as a postinstall, so on a
normal clone the step is a no-op. When the CDN cannot be reached the step falls back to phasm's
workflow artifacts over `gh`, which is a different host on a different domain rather than a retry.

`frame` compresses the binary. Cloudflare measures the bundle after its own gzip and gzip cannot
shrink bytes that are already compressed, so shipping a zstd frame is what puts PHP 8.5 under the
3 MiB free-plan ceiling with nothing dropped. The frame is cached: its header declares the inflated
length of the binary it was packed from, so the cache key is read out of the artifact rather than
kept beside it.

`decoder` is the only step that needs Docker, and it needs it once. The zstd version is pinned and
verified by sha256 and the emsdk image is pinned to the one the PHP binaries were built with, so the
output is reproducible and an existing `zstddec.wasm` is reused. Pass `--force` to rebuild it.

### 4-5, The Driver Pack

Composer never runs on the edge, so a `require` in a manifest ships nothing. The Durable Object
mounts `assets/driver.json` into its in-memory filesystem, and that packed copy is what executes.

The two Drupal modules and the stream wrapper live in sibling repositories, which are the source of
truth. `siblings` resolves each one in this order and clones only what is missing:

1. `DRUPFLARE_SRC` / `ROM_SRC` / `STREAM_HTTP_SRC`, when set
2. `../drupflare`, `../rom`, `../stream-http` -- the developer layout
3. `.siblings/<name>` -- this build's own clone

An explicit environment setting outranks an inference from the layout, and the developer layout
outranks a private clone, so a checkout you are editing is never shadowed by a clone of master.

### 6-8, The Drupal Tree

`tree` downloads the pinned core tarball from ftp.drupal.org and completes it with the four
contributed modules the tarball does not carry. It is ~180 MB. A tree already at the requested
version is left alone, because re-extracting it rewrites every mtime -- and mtime is load-bearing
here, since Drupal's `MTimeProtectedFastFileStorage` hashes it into the compiled-Twig directory name.

`site` installs a Drupal site into `sites/build`, then points `sites/default/settings.php` at the
database it created. Nothing downstream reads that database as content; it exists so `bake-twig.php`
has a kernel to boot. A release tarball ships `default.settings.php` and no `settings.php` at all, so
without this step there is no site to boot.

**This is not how `assets/drupal/site.sqlite` is produced.** That file is the database the edge
executes, it is the one artifact under `assets/` that is committed, and the installer refuses to
overwrite it without `--allow-shipping-pack`.

`patch` rewrites the tree for the wasm runtime, and is idempotent. Drupal 11 uses `new \Fiber()` in
five places; PHP builds Fibers on ucontext, emscripten provides none, and the first Fiber aborts the
runtime. The patch swaps the class for a synchronous stand-in with the same surface. It also pins the
`twig` PHP-code bin to plain `FileStorage`, without which no precompiled Twig cache is reachable at
all: the default storage hashes the containing directory's mtime into the filename, and a mounted
MEMFS directory's mtime is mount time.

### 9-13, The Assets

`bootstrap` exists because the packers and the bake read each other's output. `bake-twig.php` builds
`core.list.json` as _the previous `core.json`, minus the compiled-Twig paths, plus the ones it just
compiled_ -- so on a checkout with no pack there is no list to build, and `PACK_INDEX=1` has no file
set. The bootstrap breaks that cycle by globbing the tree under `FULL=1` instead. It is skipped
entirely on a hydrated tree, which already has a `core.json`.

**This is the one place a source-built tree differs from a shipped one in content rather than in
presence.** The shipping pack's file list came from a traced run -- a recorded measurement a checkout
does not have -- so the bootstrap globs every non-test file instead, and the bake derives its list
from that. The difference is small, because the profiled set is completed by rules that already reach
most of the tree. Measured on Drupal 11.4.5, a clean clone against the shipping artifacts:

| artifact      | shipped    | source-built | delta            |
| ------------- | ---------- | ------------ | ---------------- |
| pack entries  | 11,444     | 11,446       | +2               |
| `core.pf.bin` | 11,992,672 | 12,457,108   | +464,436 (+3.9%) |
| `core.bin.gz` | 8,126,017  | 8,588,601    | +462,584 (+5.7%) |

The Worker bundle is unaffected -- the packs are Workers assets, not bundle bytes. A source-built
tree dry-runs at **2,830.85 KiB gzipped**, against the 3,145,728-byte free ceiling.

`twig` bakes the precompiled Twig cache and writes two records: `twig-bake.json`, which the gate
reads, and `core.list.json` -- **the file list both packers then read**.

`core` repacks the tree from that list. It runs under `PACK_INDEX=1`, which takes `core.list.json`
verbatim rather than re-globbing, so a repack measures the tree rather than the completion rules. It
rewrites the two files `bootstrap` wrote, and it is skipped only when they are NEWER than the list --
a presence check would skip the repack and ship a pack missing every template the bake just compiled.

`pack` rewrites that blob with every file compressed independently, which is what lets a file be
materialised when PHP opens it instead of inflating 11,447 files at boot. It then scrubs the pack:
`core.pf.bin` carries `settings.php` with a real `hash_salt`, Workers assets are served publicly, and
a packed-but-unscrubbed pack is the state `release-payload.ts` refuses to publish.

`sql` chunks the committed `site.sqlite` into the JSON the Durable Object replays in JavaScript. It
reads a tracked file, so it is the one step that works on a clone with nothing else built.

## Why The Order Is The Order

Four of these orderings fail silently when reversed, which is why they are asserted in
`tests/node/build-from-source.spec.ts` rather than left to a comment.

- **`site` before `patch`.** The settings half of the patch appends to a file the installer creates.
  On a tree with no `settings.php` the patch reports it skipped and the build continues.
- **`patch` before `twig`.** The bake boots a kernel that must already resolve `PhpWasmSyncFiber`,
  and reads the `php_storage` pin that decides whether the bake is reachable. Baking first writes
  files at paths the runtime never asks for.
- **`bootstrap` before `twig`.** The bake derives its list from an existing `core.json`, and exits
  naming the file it could not find when there is none.
- **`twig` before `core`.** `assets:twig` writes `core.list.json` and `PACK_INDEX=1 assets:core`
  takes it verbatim, so on a tree with no list there is no file set at all.
- **`core` before `pack`.** `pack-perfile.ts` reuses `core.json` rather than re-globbing, which keeps
  a repack a change of format and not a change of which files ship.

## What The Source Route Cannot Produce

`assets/prefill.json` holds the runtime's own rendered bytes, lifted from a running worker by
`scripts/lift-prefill.ts`. There is no offline producer. Rendering it on native PHP instead was tried
and shipped HTML the site could not reproduce -- suffixed block ids and a different favicon path --
which matters because a prefilled path is a **hit on its first ever request**, so whatever is in that
file is the page a visitor sees.

It is optional at runtime: an absent `prefill.json` means the first request to each path renders
instead of hitting. A hydrated tree and a source-built tree therefore differ by exactly this file. To
produce it:

```sh
bun run dev
bun scripts/lift-prefill.ts --endpoint=http://localhost:8787 --site=bake
```

## Caching

Every step's cache key is the artifact it produces, not a stamp file, so a `fetch:drupal --force`
that replaced a patched tree cannot leave a stamp behind claiming the patch is still applied.

The three expensive steps cache individually as well, and each takes `--force`:

| artifact                  | cached on                                        | rebuild with                                   |
| ------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| `.interp/php8.5.wasm`     | sha256 in `cdn-manifest.json`                    | `bun run restore:artifacts -- --force`         |
| `.interp/php8.5.wasm.zst` | the length the frame's own header declares       | `bun scripts/pack-wasm-zstd.ts <wasm> --force` |
| `.interp/zstddec.wasm`    | presence; the zstd and emsdk versions are pinned | `bash scripts/build-zstd-decoder.sh --force`   |
| `drupal-src/`             | the version in `core/lib/Drupal.php`             | `bun run fetch:drupal -- --force`              |

## A Step Is Judged By Its Artifact

`runLocalBuild()` checks what a step produced, not what it returned. `restore-artifacts.ts` exits 0
by design when a fetch fails -- it is a postinstall and must never break `bun install` -- so a step
that trusted the exit code reported success, produced nothing, and surfaced two steps later as
`frame needs .interp/php8.5.wasm`. Checking the artifact is also what lets the interpreter's fallback
know it is still needed.

## Rebuilding Only Part Of It

```sh
bun run build:local -- --only=twig,core,pack # after editing the Drupal tree
bun run build:local -- --skip=decoder        # on a machine with no Docker
bun run build:local -- --force               # rebuild everything
bun run build:local -- --json                # the plan and the preflight, as one object
```

`--only` and `--skip` reject a name that is not a step rather than silently doing nothing. A step
whose inputs are not on disk fails by name before it runs.

## Related

- `PUBLISHING.md` -- cutting the release that makes the payload route work
- `docs/repository-layout.md` -- every path outside `src/` and how it arrives
- `scripts/README.md` -- why each script is in the language it is in
