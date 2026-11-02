# Build Order and Caching

Why the steps run in the order they do, what the build caches, how a step is judged by the artifact it leaves, and how to rebuild only part of the tree.

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
built against, so it has to come from a boot where the root is `/drupal`. The step runs `wrangler dev --local`, migrates a throwaway site, renders the paths in
`RENDER_PATHS` until the row appears, and reads back the row that boot rebuilt.

`tests/node/container-cid.spec.ts` compares the pack against the database and fails when they
disagree. Run the step on its own with `bun run assets:container`, which re-chunks afterwards.

### 17, The Prefill

`prefill` produces `assets/prefill.json`, which holds the bytes the site returns for five paths. A
prefilled path is a hit on its first ever request, so whatever is in that file is the page a
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

It is the only optional step. It binds a port and boots an interpreter, and a busy port must not
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
replace the tree without `--force`. See [Upgrading Drupal Core](upgrading-core.md#upgrading-drupal-core).

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
