# `scripts/`

Four kinds of script live here, and the kind decides the language.

| where              | what                                                   | language           |
| ------------------ | ------------------------------------------------------ | ------------------ |
| `scripts/*.ts`     | the live build and ops pipeline                        | TypeScript         |
| `scripts/bench/`   | native-PHP price baselines, and build-variant A/B      | PHP, plus 2 `.mjs` |
| `scripts/probe/`   | paired experiment harnesses                            | shell, plus 2 PHP  |
| `scripts/drupal/`  | Drupal tree manipulation, run under native PHP         | PHP                |
| `scripts/measure/` | instruments that produce a figure quoted in the report | `.mjs`             |

## The Build Pipeline

`vendor.ts`, `fetch-drupal-tree.ts`, `pack-perfile.ts`, `pack-sql.ts`, `pack-drupal.ts`,
`pack-static.ts`, `gen-driver-assets.ts` are wired into `package.json` and run in CI or a pre-commit
hook.

Each was converted with byte-identical output proven against the `.mjs` it replaced. A packer whose
output moves during a refactor invalidates every size figure downstream, so identity is the
acceptance criterion. For `pack-drupal.ts` the proof is `tests/node/pack-drupal.spec.ts`, which
carries the artifact digests the `.mjs` produced on a synthetic Drupal tree across all five modes.

### Node Rather Than Bun

`assets:sql` and `assets:core` are the two `package.json` entries that do not say `bun`.

`pack-sql.ts` needs `node:sqlite`, which bun does not ship (`No such built-in module`).
`pack-drupal.ts` writes `core.bin.gz` from `gzipSync(blob, { level: 9 })`, and the two runtimes emit
different deflate streams: on one 263,004-byte input node wrote 99,727 bytes and bun wrote 101,240,
different sha256. Running it under bun moves a shipped asset with nothing reporting it.

### The Twig Bake

`bake-twig.php` (`assets:twig`) is PHP for the reason `scripts/drupal/` is: it needs a real Drupal
kernel to reach `\Drupal::service('twig')` and the container's `%twig_extension_hash%`. It bakes the
precompiled Twig cache into `drupal-src/sites/default/files/php/twig/`, writes
`assets/drupal/twig-bake.json` as the build record, and writes `assets/drupal/core.list.json` -- the
file list both packers read. `pack-perfile.ts` and `PACK_INDEX=1 pack-drupal.ts` take their file set
from an existing index, so neither can notice a file the bake just created.

### The Tree

`fetch-drupal-tree.ts` produces the input all three packers read, and is what
`.github/workflows/build.yml` calls in place of the inline `curl` it used to carry. `phpstan.neon`
bootstraps that tree's autoloader, which is what lets `composer analyze` resolve `\Drupal\Core\...`
in `scripts/*.php`. `tests/node/drupal-tree.spec.ts` fails if a second producer appears.

### The Static Copy

`pack-static.ts` is a copy rather than a pack. The three packers skip `css|js|woff2|...` because PHP
never opens them, and nothing serves a file out of the PHP MEMFS over HTTP, so those URLs 404ed until
`assets:static` mirrored `drupal-src/core` into `assets/core` for the Workers Assets layer to answer.
No index and no compression: Assets content-hashes and compresses what it serves, and a hit never
reaches the Worker. It runs anywhere after `fetch:drupal`, refuses a target holding a file it could
not have written, and prunes what the tree no longer has.

### Command Order

`assets:twig` -> `assets:core` -> `assets:pack`, which is the order `bun run assets` runs them in.

`assets:pack` writes **`assets/drupal-pf`**, the prefix `mountDrupalLazy()` reads
(`src/runtime/lazy-fs.ts:186`). It used to write `assets/drupal/core.pf.*`, which nothing fetches, so
the pack the canonical `LAZY_MOUNT=1` config mounted was whatever was last left in `drupal-pf` -- in
practice a copy two days stale and missing 14 files.

`pack-drupal.ts` does not open with `rm -rf` on its output directory. That line put
`assets/drupal/site.sqlite`, the only unrecoverable artifact here, one argument away from deletion.
It overwrites `core.json`, `core.bin.gz` and `core.bin` and nothing else.

## The Contrib Fixture Lane

`contrib-fixture.ts` (`bun run test:contrib`) is the only script here that overwrites a shipping
artifact. Contrib is a dev dependency: `PACK_CONTRIB=1` packs `modules/contrib` and the `vendor` and
`libraries` trees that arrive with it, and the mount prefix is fixed at `drupal-pf`, so the fixture
pack occupies the path the shipping one occupies. `assets/drupal-pf` is 13 MB and not in git.

The swap is bracketed. The shipping pair is copied to `.contrib-fixture/shipping` and sha256'd before
anything is built, the restore runs in a `finally` and on SIGINT, and a backup left behind by a killed
run is restored on the next start instead of being overwritten. `--mount` leaves the fixture in place
for iteration; `--restore` puts the shipping pack back.

It runs the workers project alone. `tests/node/module-table.spec.ts` compares the pack index against
`SHIPPING_PACK_CONTRIB` and fails while a fixture is mounted, because the mounted pack is then not
the shipping one.

## `site.sqlite`

`install-site-db.php` drives `install_drupal()` with a pinned parameter set and installs into
`sites/build`, so it never touches `sites/default` and the baked Twig cache there. It runs in about
4 s, and its output is structurally equivalent to the shipping pack: identical table set bar the six
cache bins Drupal creates on first request, identical 169 config objects, identical 40-module set,
identical 419 routes, identical 68 menu links.

It is not byte-identical and cannot be -- a Drupal install mints a random hash salt, a UUID per config
object, an admin password hash and per-row timestamps. The acceptance check is `diff-site-db.ts`,
which compares structure and exits non-zero on a divergence, and which has its own tests in
`tests/node/site-db-diff.spec.ts`. A render cannot be the check: a cache hit and a cache miss produce
the same 12,304 bytes, which is how a container-cache miss survived a byte-identical render for a
whole session.

`bake-pack.ts` takes an exclusive lock on the pack (`assets/drupal/.pack.lock`). Two sessions baked
concurrently once while an acceptance test read the result, and the migration chunk count moved
101 -> 86 -> 79 underneath it with no error anywhere.

## Native Benchmarks

Every `bench-*.php` file is the native half of a wasm:native ratio. `bench-cpu.php` runs
byte-identical PHP source to `src/probes/cpu-bench.ts` so the two numbers are comparable;
`bench-render.php` prices the same render the Durable Object prices. Rewriting them in TypeScript
would not port them, it would remove the native figure there is to divide by.

`bench-ab.mjs` and `bench-variant.mjs` are JavaScript because they drive `wrangler dev` and read the
worker's own identity routes.

## Frozen Instruments

`scripts/measure/` and `scripts/probe/` are not casually rewritten. This project has moved a free-tier
verdict five times and four of those were the instrument rather than the system -- see RULE 0 in
`TECHNICAL_REPORT.md`. `wrangler tail` silently omitting `durableObject` events; a fidelity test
reading both sides through the same truncating API; a fixture that allowed 32,766 bound parameters
where the platform allows 100.

Each file here is cited in `TECHNICAL_REPORT.md` as the thing that produced a specific figure.
`measure/gen-assets.mjs` has zero callers and still must not be deleted: it is the fixture generator
behind the granular-vs-packed table, and replaying its seed-42 arithmetic reproduces the recorded
`200 files, 2988695 bytes total, median 8354 bytes`.

**Moving a file does not change what it measures; rewriting it might.** These were grouped into
subdirectories and every citation in the report was updated to match, because the path is not the
instrument. Converting the language is a different act and needs the same byte-identity proof the
pipeline conversions got.

Two files are conversion candidates, each blocked on something specific:

- `patch-drupal.mjs` mutates `drupal-src/`, which is gitignored and has no committed version to diff
  against, so verification needs a throwaway copy of the tree first.
- `tree-diff.mjs`, formerly `security-update.mjs`, hashes a tree, diffs it against a prior manifest
  and plans the objects a rollout moves. Advisory detection does not exist; the tree must already be
  patched. Its only `fetch()` is of the operator's own `--fleet=` URL, so it ports offline.
  `tests/node/tree-diff.spec.ts` covers it in 21 assertions, including the `--fleet` success and
  failure branches against a loopback server.

## Rules

- A script that writes an artifact takes its output directory as an argument.
  `measure/gen-assets.mjs` used to default to `../assets` and open with `rm -rf` on it; it now
  requires `--out` and refuses any target holding files it did not generate. That directory is 96 MB.
- Never point a packer at `assets/` while tests are running; they read it.
- `probe-*` scripts come in pairs. The `-paired` variant measures a control and the treatment in the
  same process; the unpaired predecessor is kept because its result may be the one recorded. Use the
  paired one for anything new -- an unpaired sweep drifted 57%.
