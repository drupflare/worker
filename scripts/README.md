# `scripts/`

Four kinds of thing live here, and the kind decides the language. That is the whole policy, and
it is the answer to "why is this not all TypeScript yet".

| where              | what                                                   | language           |
| ------------------ | ------------------------------------------------------ | ------------------ |
| `scripts/*.ts`     | the live build and ops pipeline                        | TypeScript         |
| `scripts/bench/`   | native-PHP price baselines, and build-variant A/B      | PHP, plus 2 `.mjs` |
| `scripts/probe/`   | paired experiment harnesses                            | shell, plus 2 PHP  |
| `scripts/drupal/`  | Drupal tree manipulation, run under native PHP         | PHP                |
| `scripts/measure/` | instruments that produce a figure quoted in the report | `.mjs`             |

## The live pipeline is TypeScript

`vendor.ts`, `fetch-drupal-tree.ts`, `pack-perfile.ts`, `pack-sql.ts`, `pack-drupal.ts`,
`gen-driver-assets.ts`.
These are wired into `package.json`, run in CI or a pre-commit hook, and are the ones a
contributor actually invokes. Each was converted with **byte-identical output proven** against
the `.mjs` it replaced -- a packer whose output moved during a refactor would invalidate every
size figure downstream, so identity was the acceptance criterion, not "the tests still pass".
For `pack-drupal.ts` that proof is `tests/node/pack-drupal.spec.ts`, which carries the artifact
digests the `.mjs` produced on a synthetic Drupal tree across all five modes.

Two of them run under **`node`, not `bun`**, and `assets:sql` and `assets:core` are the two
`package.json` entries that do not say `bun`. `pack-sql.ts` needs `node:sqlite`, which bun does
not ship (`No such built-in module`). `pack-drupal.ts` writes `core.bin.gz` from
`gzipSync(blob, { level: 9 })`, and the two runtimes do not emit the same deflate stream: on one
263,004-byte input node wrote 99,727 bytes and bun wrote 101,240, different sha256. Running it
under bun would move a shipped asset with nothing reporting it.

`bake-twig.php` is in the pipeline too (`assets:twig`) and is PHP for the reason
`scripts/drupal/` is: it needs a real Drupal kernel to reach `\Drupal::service('twig')` and the
container's `%twig_extension_hash%`. It bakes the precompiled Twig cache into
`drupal-src/sites/default/files/php/twig/`, writes `assets/drupal/twig-bake.json` as the build
record, and writes `assets/drupal/core.list.json` -- **the file list both packers then read**,
because `pack-perfile.ts` and `PACK_INDEX=1 pack-drupal.ts` take their file set from an existing
index on purpose and so can never notice a file the bake just created.

`fetch-drupal-tree.ts` produces the input all three packers read. It is also what
`.github/workflows/build.yml` calls, in place of the inline `curl` it used to carry, so there is one
mechanism and one version -- and `phpstan.neon` bootstraps that tree's autoloader, which is what lets
`composer analyze` resolve `\Drupal\Core\...` in `scripts/*.php`. `tests/node/drupal-tree.spec.ts`
fails if a second producer appears.

The three commands are ordered and the order matters: `assets:twig` -> `assets:core` ->
`assets:pack`. `bun run assets` runs them in that order. `assets:pack` writes
**`assets/drupal-pf`**, which is the prefix `mountDrupalLazy()` actually reads
(`src/runtime/lazy-fs.ts:186`); it used to write `assets/drupal/core.pf.*`, which nothing has ever
fetched, so the pack the canonical `LAZY_MOUNT=1` config mounts was whatever was last left in
`drupal-pf` -- in practice a copy two days stale and missing 14 files.

`pack-drupal.ts` no longer opens with `rm -rf` on its output directory. That one line put
`assets/drupal/site.sqlite`, the only unrecoverable artifact here, one argument away from
deletion, and it broke the rule two sections down about a packer refusing a target holding files
it did not generate. It now overwrites only `core.json`, `core.bin.gz` and `core.bin`.

## `site.sqlite` now has a producer, and the gate is not a render

`install-site-db.php` drives `install_drupal()` directly with a pinned parameter set and installs
into `sites/build`, so it never touches `sites/default` and the baked Twig cache there. It runs in
about 4 s and its output is **structurally equivalent** to the shipping pack: identical table set bar
the six cache bins Drupal creates on first request, identical 169 config objects, identical 40-module
set, identical 419 routes, identical 68 menu links.

It is deliberately NOT byte-identical, and cannot be -- a Drupal install mints a random hash salt, a
UUID per config object, an admin password hash and per-row timestamps. So the acceptance check is
`diff-site-db.ts`, which compares structure and exits non-zero on a divergence, and which has its own
tests in `tests/node/site-db-diff.spec.ts` because a gate that only reports green is no gate. A render
cannot be the check: a cache hit and a cache miss produce the same 12,304 bytes, which is how a
container-cache miss survived a byte-identical render for a whole session.

`bake-pack.ts` also takes an exclusive lock on the pack now (`assets/drupal/.pack.lock`). Two sessions
baked concurrently once while an acceptance test read the result and the migration chunk count moved
101 -> 86 -> 79 underneath it, with no error anywhere.

## `scripts/bench/` cannot be TypeScript, and that is the point

Every `bench-*.php` file is the **native half of a wasm:native ratio**. `bench-cpu.php` runs
byte-identical PHP source to `src/probes/cpu-bench.ts` so the two numbers are comparable;
`bench-render.php` prices the same render the Durable Object prices. Rewriting them in
TypeScript would not port them, it would delete the measurement -- there would no longer be a
native PHP figure to divide by.

`bench-ab.mjs` and `bench-variant.mjs` are the two exceptions: they are JavaScript because they
drive `wrangler dev` and read the worker's own identity routes.

## `scripts/measure/` and `scripts/probe/` are instruments, and an instrument gets frozen

This project has moved a free-tier verdict five times, and **four of those were the instrument
rather than the system** -- see RULE 0 in `TECHNICAL_REPORT.md`. `wrangler tail` silently
omitting `durableObject` events, a fidelity test reading both sides through the same truncating
API, a fixture that allowed 32,766 bound parameters where the platform allows 100. That history
is why these are not casually rewritten.

Each of these files is cited in `TECHNICAL_REPORT.md` as the thing that produced a specific
figure. `measure/gen-assets.mjs` has **zero callers anywhere** and still must not be deleted: it
is the fixture generator behind the granular-vs-packed table, and replaying its seed-42
arithmetic reproduces the recorded `200 files, 2988695 bytes total, median 8354 bytes` exactly.

**Moving a file does not change what it measures; rewriting it might.** These were grouped into
subdirectories and every citation in the report was updated to match, because the path is not
the instrument -- the bytes are. Converting the language is a different act, and it needs the
same byte-identity proof the pipeline conversions got.

Two files are honest conversion candidates rather than frozen instruments, and are **not done
yet** for a stated reason each:

- `patch-drupal.mjs` -- mutates `drupal-src/`, which is gitignored and has no committed version
  to diff against, so verification needs a throwaway copy of the tree first.
- `security-update.mjs` -- reaches the network for SA-CORE advisories, so there is no offline
  way to prove the port behaves identically.

## Rules

- A script that writes an artifact takes its output directory as an argument. `measure/gen-assets.mjs`
  used to default to `../assets` and open with `rm -rf` on it; it now requires `--out` and
  refuses any target holding files it did not generate. That directory is 96 MB.
- Never point a packer at `assets/` while tests are running; they read it.
- `probe-*` scripts come in pairs for a reason. The `-paired` variant measures a control and the
  treatment in the same process; the unpaired predecessor is kept because its result may be the
  one recorded. Prefer the paired one for anything new -- an unpaired sweep drifted 57%.
