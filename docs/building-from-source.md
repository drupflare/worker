# Building From Source

Two commands turn a clean clone into a deployable tree, and they are not interchangeable.

| route       | command               | needs                            | takes   |
| ----------- | --------------------- | -------------------------------- | ------- |
| **payload** | `bun run hydrate`     | network                          | seconds |
| **source**  | `bun run build:local` | network, PHP, composer, node 24+ | minutes |

`bun run hydrate` takes the payload route by default and falls back to the source route when no
payload exists. `--payload-only` forbids the fallback; `--from-source` skips straight to it.

## Why Two Routes

`assets/` is generated packs and `.interp/` holds the interpreter. Both are gitignored, so a clean
checkout has neither and `wrangler deploy` has nothing to upload.

The payload route downloads them as one verified tarball. It is a plain HTTPS GET: no Docker, no
`gh` auth, no PHP, no Cloudflare credential. That is what makes the Deploy to Cloudflare button
work. Its build command is `bun run hydrate` (`build.command` in `wrangler.jsonc`), and Workers
Builds has no Docker to build with.

The source route regenerates the same bytes locally. It covers what the payload cannot: a checkout of
a commit no release was cut from, and a repository with no release yet. It produces every artifact
the payload carries, `assets/prefill.json` included.

## Where a Payload Comes From

`hydrate` tries four places and takes the first that answers, and every one of them is verified
against the `SHA256SUMS` published beside it.

| order | source                         | what it is                                    |
| ----- | ------------------------------ | --------------------------------------------- |
| 1     | `--from=<path>` or `dist/`     | a tarball on disk, which outranks the network |
| 2     | `payloads/v<version>/` on R2   | the release, mirrored to the CDN              |
| 3     | the GitHub Release             | the same bytes, canonical                     |
| 4     | `payloads/dev-<branch>/` on R2 | that branch's tip, replaced on every push     |

**The CDN copy is tried before the GitHub Release.** A Workers Builds job stalled for its whole
timeout on a release asset download, in a container that had restored the same 13.4 MB from the CDN
seconds earlier. The Release stays canonical and stays the fallback, so a CDN outage costs a retry
rather than a deploy.

**The dev line is tried last and never displaces a release.** It is keyed by branch: the checkout's
own branch first, then `master`. It lets a checkout on a commit no release was cut from download a
tree in seconds instead of building one with a toolchain the deploy container does not have.
`bun run build:local` is still there when you want the bytes regenerated rather than fetched.

Both lines are published by CI from the tarball the release job already built, so nothing is
rebuilt to publish it. The keys come from `scripts/payload-cdn.ts`, which the resolver and the
workflows both read; `tests/node/workflows.spec.ts` fails if a workflow starts spelling a key of its
own.

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

| tool       | version | used by                | note                                              |
| ---------- | ------- | ---------------------- | ------------------------------------------------- |
| `bun`      | latest  | everything             |                                                   |
| `node`     | 24+     | `core`, `sql`, `patch` | `node:sqlite`, which Bun does not ship            |
| `php`      | 8.3+    | `site`, `twig`         | with `pdo_sqlite`, `sqlite3`, `mbstring`, `iconv` |
| `composer` | 2       | `tree`                 | the Drupal release tarball is core only           |
| `git`      | any     | `siblings`             |                                                   |
| `tar`      | any     | `tree`                 |                                                   |

Two of these run under `node` rather than `bun`. `pack-sql.ts` needs `node:sqlite`.
`pack-drupal.ts` writes `core.bin.gz` from `gzipSync(blob, { level: 9 })`, and the two runtimes do
not emit the same deflate stream for the same input, so running it under Bun would move a shipped
asset with nothing reporting it.

## The Steps

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

### 1-2, The Interpreter

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

### 3-4, The Driver Pack

Composer never runs on the edge, so a `require` in a manifest ships nothing. The Durable Object
mounts `assets/driver.json` into its in-memory filesystem, and that packed copy is what executes.

The two Drupal modules and the stream wrapper live in sibling repositories, which are the source of
truth. `siblings` resolves each one in this order and clones only what is missing:

1. `DRUPFLARE_SRC` / `ROM_SRC` / `STREAM_HTTP_SRC`, when set
2. `../drupflare`, `../rom`, `../stream-http` (the developer layout)
3. `.siblings/<name>` (this build's own clone)

An explicit environment setting outranks an inference from the layout, and the developer layout
outranks a private clone, so a checkout you are editing is never shadowed by a clone of master.

### 5-8, The Drupal Tree

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
`node scripts/diff-site-db.ts`. `docs/database.md` is the recipe and lists every value the shipped
database disagrees with a stock install about.

`patch` rewrites the tree for the wasm runtime, and is idempotent. Drupal 11 uses `new \Fiber()` in
five places; PHP builds Fibers on ucontext, emscripten provides none, and the first Fiber aborts the
runtime. The patch swaps the class for a synchronous stand-in with the same surface. It also pins the
`twig` PHP-code bin to plain `FileStorage`, without which no precompiled Twig cache is reachable at
all: the default storage hashes the containing directory's mtime into the filename, and a mounted
MEMFS directory's mtime is mount time.

### 9-16, The Assets

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
reads, and `core.list.json`, **the file list both packers then read**.

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
never reaches the Worker. 4,030 files on the current tree, with
`core/profiles/demo_umami`, `tests/`, `node_modules/` and `.pcss.css` sources left out.

`sql` chunks the committed `site.sqlite` into the JSON the Durable Object replays in JavaScript. It
reads a tracked file, so it is the one step that works on a clone with nothing else built.

It also drops the bake's own history on the way through: `dropBakeHistory()` empties `watchdog` and
removes `state:install_time`. Without that, a new site inherits the bake's log dates and an install
time that makes the Cron requirement read as overdue. This is a build step rather than a hand edit,
because `bun install` restores the tracked database from the CDN and would revert a hand edit.

### 14, The Aggregates

`agg` reads the `*.libraries.yml` definitions out of `drupal-src` and emits immutable per-library CSS
and JS aggregates into `assets/agg/`, plus a file-to-library index. The output is not committed. The
serving side is off unless `ASSET_AGGREGATES=1`, and with no manifest present it changes nothing.

**It belongs in the numbered sequence, because `wrangler.jsonc` sets `ASSET_AGGREGATES: "1"`.** A
tree that builds the pack without it runs the lever with nothing to substitute, and the lever
degrades quietly by design, so nothing reports it. The symptom is `/agg/manifest.json` answering 404.

The output has to be published as well as built. `assets/.assetsignore` denies by default, so it
needs `!/agg/`; without that line the aggregates upload nowhere and a page with the lever on has no
CSS. The aggregates count against the Workers Assets store, not the 64 MiB bundle.

## Why The Order Is The Order

These orderings fail silently when reversed, which is why
`tests/node/build-from-source.spec.ts` asserts them. `agg` is absent from the list because it reads
`drupal-src` and nothing else, so it has no ordering constraint against the rest.

- **`site` before `patch`.** The settings half of the patch appends to a file the installer creates.
  On a tree with no `settings.php` the patch reports it skipped and the build continues.
- **`patch` before `twig`.** The bake boots a kernel that must already resolve `PhpWasmSyncFiber`,
  and reads the `php_storage` pin that decides whether the bake is reachable. Baking first writes
  files at paths the runtime never asks for.
- **`bootstrap` before `twig`.** The bake derives its list from an existing `core.json`, and exits
  naming the file it could not find when there is none.
- **`twig` before `core`.** `assets:twig` writes `core.list.json` and `PACK_INDEX=1 assets:core`
  takes it verbatim, so on a tree with no list there is no file set at all.
- **`core` before `pack`.** `pack-perfile.ts` reuses `core.json` and never re-globs, which keeps a
  repack a change of format and leaves the set of shipped files alone.
- **`pack` before `container`.** The row is keyed to the hash the pack carries, so there has to be a
  pack to read it from.
- **`container` before `sql`.** `sql` chunks the database into the migration the Durable Object
  replays, so a rekey after it would ship the old row.

### 15, The Container Row

`container` rewrites one row of `assets/drupal/site.sqlite` and produces no file of its own.

`DrupalKernel::getContainerCacheKey()` folds `DrupalInstalled::VERSIONS_HASH` into the cache id, and
that hash covers every installed composer package. Any change in `drupal-src` moves it, including
`composer require --dev drupal/<module>`, which is how the contrib lane gets its fixture. When the
packed row and the pack disagree, the first `$kernel->boot()` on every site misses and rebuilds a
482 KB container, which took 1,024 ms against 86 ms for a boot that hits.

The row cannot be retargeted by editing its key. A compiled container embeds the absolute root it was
built against, so it has to come from a boot where the root is `/drupal`. The step runs `wrangler dev --local`, migrates a throwaway site, renders one page
and reads back the row that boot rebuilt.

`tests/node/container-cid.spec.ts` compares the pack against the database and fails when they
disagree. Run the step on its own with `bun run assets:container`, which re-chunks afterwards.

### 17, The Prefill

`prefill` produces `assets/prefill.json`, which holds the bytes the site returns for five paths. A
prefilled path is a **hit on its first ever request**, so whatever is in that file is the page a
visitor sees.

The bytes depend on the runtime, so native PHP cannot produce them. Native PHP returns suffixed block
ids, because `Html::$seenIds` is a static that `drupal_static_reset()` does not clear. It also
returns a different favicon path, because the packer drops `.ico` and wasm's `file_exists()` answers
differently. Both renders are valid pages that do not match what the site serves.

The step needs the runtime, and it does not need a deploy. `scripts/bake-prefill.ts` boots
`wrangler dev` locally (workerd, with its own Durable Object, no Cloudflare login), drives
`/migrate` to completion, renders the five paths through `/serve`, and tears the worker down. The
state directory is a fresh `--persist-to` under the system temp directory each time, so a run cannot
lift a page from a Durable Object left behind by an earlier run.

The migration runs with `prefill=0`, which is what makes it a bake. `/migrate` seeds the serving
table from the shipped `assets/prefill.json`, so with it on every `/serve` is a hit of the file being
rebuilt. `migrateSite()` asks for an unseeded site and throws if the route prefills anyway.

It is the **only optional step**. It binds a port and boots an interpreter, and a busy port must not
discard sixteen finished steps: a failure here is reported, the build continues, and the run ends
naming the file and the command that retries it. An absent `prefill.json` is normal at runtime; the
first request to each path renders, and misses the prefill hit.

To produce or refresh it on its own:

```sh
bun run build:local -- --only=prefill
bun scripts/bake-prefill.ts --port=8802 --keep # or drive it directly
```

## Caching

Every step's cache key is the artifact it produces. There are no stamp files, so a rebuilt tree cannot
keep a stale record of a patch that is gone.

The three expensive steps cache individually as well, and each takes `--force`:

| artifact                 | cached on                                        | rebuild with                                     |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------ |
| `.interp/php8.5.wasm`    | sha256 in `cdn-manifest.json`                    | `bun run restore:artifacts -- --force`           |
| `.interp/php8.5.wasm.br` | mtime against the binary it was packed from      | `bun scripts/pack-wasm-brotli.ts <wasm> --force` |
| `drupal-src/`            | installed core version matches the requested one | `bun run fetch:drupal -- --force`                |

The `tree` step is satisfied only when the installed core version matches `DRUPAL_VERSION`, or
`SHIPPED_CORE_VERSION` when it is unset. A different version runs `fetch:drupal`, which refuses to
replace the tree without `--force`. See [Upgrading Drupal Core](#upgrading-drupal-core).

## A Step Is Judged By Its Artifact

`runLocalBuild()` decides success from the files a step produces, not from its exit code.
`restore-artifacts.ts` exits 0 when a fetch fails, because it runs as a postinstall. A step that
trusted the exit code would report success with no output, and the failure would surface later as
`frame needs .interp/php8.5.wasm`.

## Rebuilding Only Part Of It

```sh
bun run build:local -- --only=twig,core,pack # after editing the Drupal tree
bun run build:local -- --skip=prefill        # skip the step that needs a free port
bun run build:local -- --force               # rebuild everything
bun run build:local -- --json                # the plan and the preflight, as one object
```

`--only` and `--skip` reject a name that is not a step, by name and out loud. A step whose inputs are
not on disk fails by name before it runs.

## Upgrading Drupal Core

Changing the core version means replacing the Drupal tree, then rebuilding every artifact made from
it. A plain `DRUPAL_VERSION=<version> bun run build:local` re-runs the `tree` step, which refuses to
replace a tree at another version without `--force`. The steps after `tree` are keyed on their own
outputs, so they keep what is on disk unless `--force` or `--only` says otherwise.

### The Sequence

`DRUPAL_VERSION` must be set on both commands, or on neither. A forced build runs `fetch:drupal`
again, and that script reads the version from its own environment.

```sh
DRUPAL_VERSION=11.4.5 bun scripts/fetch-drupal-tree.ts --force
DRUPAL_VERSION=11.4.5 bun run build:local -- --force \
  --skip=interpreter,frame,siblings,driver,prefill
```

Four of the five skipped steps do not depend on the core version: two are the interpreter, one is
the sibling checkouts and one is the driver pack. The fifth, `prefill`, does; drop it from that list
on a real upgrade, since it re-renders the prefilled pages and a core patch can change them.

Wall clock on one development machine, six core-version swaps (median in the first row):

| measure                                           |  n  | wall clock               |
| ------------------------------------------------- | :-: | ------------------------ |
| a core-version swap, end to end                   |  6  | **23-27 s**, median 25 s |
| of which: tarball fetch, extract, contrib install |  6  | 8-11 s                   |
| of which: reinstall, rebake, repack, recopy       |  6  | 15-16 s                  |
| a from-scratch build, same steps plus `driver`    |  1  | 23 s                     |

A swap replaces about 167 MB of tree, reinstalls the build site, rebakes 23 Twig templates, repacks
11,457 files and recopies 4,060 static assets.

**Verified by artifact.** A rebuilt `assets/core/misc/ajax.js` hashed identically to the 11.4.5
reference tree and differently from 11.4.4. `assets/drupal/core.bin.gz` carried `const VERSION =
'11.4.5'` and no other version string.

### What A Patch Release Moves

`scripts/tree-diff.mjs` hashes a tree and plans the objects a rollout has to move. Example, 11.4.4
to 11.4.5:

| set                                  | count   |
| ------------------------------------ | ------- |
| pack objects to upload               | **209** |
| pack objects to delete               | 0       |
| fraction of the 11,024-file pack set | 1.90%   |
| static assets that also change       | **2**   |

The 209 are 93 `.info.yml` version stamps, 86 files under `vendor/`, 28 PHP classes under `core/`
and two `core/*.json`. **Zero `*.routing.yml`, zero `.install`, zero `config/schema/*.yml`, zero
`config/{install,optional}/*.yml`, zero `*.post_update.php` and zero `*.services.yml`**, so this
release is the code-only case, and no route, schema or config default moved.

**`tree-diff.mjs` cannot see the static half.** Its `SHIPPED` regex matches the extensions the PHP
packs carry, which leaves out `css` and `js`, because `assets:static` serves those. Diffed
separately, 11 browser-fetchable files changed, of which two match `pack-static.ts`'s own `SERVED`
set and therefore ship: `core/misc/ajax.js` and `core/misc/details.js`. Read `objectsToUpload` as the
pack half of a rollout, with the static half counted separately.

### The Two Rows Nothing Regenerates

`sql` reads `assets/drupal/site.sqlite` verbatim. Two of its prefilled rows embed the core version,
both at `expire = -1`:

| bin               | cid                    | bytes  |
| ----------------- | ---------------------- | ------ |
| `cache_discovery` | `library_info:olivero` | 89,184 |
| `cache_data`      | `fonts:olivero:...`    | 630    |

The version in them is the `?v=` cache-buster Drupal appends to every asset URL. Across repeated
core swaps, `site.sqlite` came out byte-identical to the committed one. **A core upgrade does not
change these rows**, so after a patch that changes `core/misc/ajax.js`, the site serves new bytes at
`/core/misc/ajax.js` while the query string still carries the old version.

The correction is a cache invalidation: delete both rows and Drupal rebuilds them, at the cost of one
discovery pass on the first render. `scripts/bake-collectors.php` produced them, and it is not
wired into `build:local`. It reads `<root>/sites/default/files/.sqlite`, which the `site` step does
not create (that step writes `sites/build/files/build-site.sqlite`), and it writes into the build
database, from which the rows were copied by hand into `site.sqlite`.

## Related

- `docs/configuration.md`: every variable and binding, and what breaks when one is wrong
- `docs/repository-layout.md`: every path outside `src/` and how it arrives
- `scripts/README.md`: why each script is in the language it is in

`bun run release:payload` builds the payload the fast route downloads and `bun run release:check`
prices the canonical config against the 64 MiB ceiling.
