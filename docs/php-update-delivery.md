# PHP Interpreter Update Delivery

How a PHP wasm interpreter built by [`drupflare/phasm`](https://github.com/drupflare/phasm) reaches
this repository, what is proved about it before anything can consume it, and where the pipeline
stops.

Scope: the interpreter only. Drupal core, contrib and the packed database move on their own lane, in
[Out of Scope](#out-of-scope).

## Platform Constraints

A running Worker cannot swap its PHP binary. The change unit is a redeploy.

- **The interpreter is a bundle-time module.** `src/runtime/php-binary-85.ts` reaches it with
  `import blob from '../../.interp/php8.5.wasm.zst'`, and `wrangler.jsonc` maps `**/*.zst` to module
  type `Data`. Wrangler resolves a module import when the bundle is built. No runtime API adds a
  module to a deployed bundle.
- **The compile happens at module scope.** `wasmModuleFromZstd` calls
  `new WebAssembly.Module(bytes)` during top-level evaluation. `workerd` permits codegen during
  startup and refuses it at request time.
- **Startup cannot fetch.** Cloudflare refuses asynchronous I/O in global scope: "Disallowed
  operation called within global scope. Asynchronous I/O (ex: fetch() or connect()), setting a
  timeout, and generating random values are not allowed within global scope." `env` is importable at
  module scope, but calls on a Durable Object stub, a KV store or another Worker do not work there.

The one place that may compile may not download, and the one place that may download may not
compile. Together they rule out R2, KV, the asset layer, a service binding and Durable Object
storage as a source of interpreter bytes.

Everything after the build is automatable. `wrangler versions upload` produces a version without
deploying it, `wrangler versions deploy <id>@<pct>` splits traffic, and `wrangler rollback <id>`
reverses it, all against wrangler 4.120.0.

## The Pipeline

Two workflows, one in each repository.

| step | where                                               | result                                              |
| ---- | --------------------------------------------------- | --------------------------------------------------- |
| 1    | `phasm` `.github/workflows/build.yml`, `notify` job | a `repository_dispatch` naming a published artifact |
| 2    | `worker` `.github/workflows/interpreter.yml`        | a verified payload artifact and a pull request      |
| 3    | a human                                             | merge, release, deploy                              |

Step 3 is not automated. The workflow has no deploy step and holds no Cloudflare credential.

## Notification

phasm's `notify` job runs after `publish`, so it fires when a build publishes interpreter artifacts
and not on the pull-request or archive-only paths. It sends one `repository_dispatch` per variant
listed in `CONSUMER_VARIANTS`, currently `control85`.

```json
{
  "event_type": "phasm-interpreter-published",
  "client_payload": {
    "variant": "control85",
    "php_version": "8.5",
    "artifact_id": "4102938475",
    "run_id": "18273645",
    "commit": "abc1234",
    "tag": "snapshot-abc1234"
  }
}
```

`php_version` is read from `src/rc/<variant>.rc`. `artifact_id` is resolved against the run's own
artifact list, so it names the build that just completed rather than whichever artifact is newest
when the consumer looks.

A variant with no rc, no `PHP_VERSION` or no artifact in the run is skipped with a warning. A run
that notifies nothing fails, because a silent no-op leaves `worker` on its old pin with a green
build behind it.

`POST /repos/{owner}/{repo}/dispatches` requires **Contents: write** on `drupflare/worker`. When
`PHASM_TOKEN` carries only **Actions: write**, the dispatch is refused and the job falls back to
`POST /repos/{owner}/{repo}/actions/workflows/interpreter.yml/dispatches`, which that permission
does cover. The fallback carries the variant, the PHP version and the artifact id; the phasm run id,
commit and tag reach the consumer only over `repository_dispatch`.

## Verification

`interpreter.yml` accepts `repository_dispatch` and `workflow_dispatch`. Both resolve to the same
three values, and the workflow refuses a variant that is not a phasm rc name, a PHP version that is
not `<major>.<minor>`, and a non-numeric artifact id.

The run hydrates the current release payload first. That supplies `assets/`, the zstd decoder and
the incumbent interpreter, so the bundle is measured against the tree that actually ships, and the
incumbent figure is recorded before the swap.

Three checks stand between the download and the pull request. Each throws, each fails its step, and
a failed step ends the run: no payload is uploaded and no branch is pushed.

1. **The frame declares the binary.** `assertDeclaredSize()` in `scripts/pack-wasm-zstd.ts` reads
   the zstd frame header with cartridge's own `zstdContentSize()` and compares it to the file that
   was packed. The frame is written to disk only after the comparison passes. A frame that declares
   the wrong length, or omits the field, fails at isolate startup on the edge, where the only
   symptom is an exit code.
2. **The seam imports what was fetched.** `assertSeamImports()` in `scripts/fetch-interpreter.ts`
   reads the interpreter imports out of the seam `wrangler.jsonc` aliases and requires the fetched
   frame and glue to be among them. On a hydrated tree a fetch for the wrong PHP version otherwise
   builds cleanly, passes the size gate, and measures the incumbent.
3. **The bundle fits the free ceiling.** `bun run release:check` dry-runs the canonical config,
   parses the gzip figure wrangler prints with `parseWranglerGzipBytes()`, and throws above
   3,145,728 bytes. The dry run also proves the entrypoint and the binary alias still resolve.

`tests/node/interp-fetch.spec.ts` covers the first two directly, including a round trip through the
real `zstd` CLI. `tests/node/release-payload.spec.ts` covers the KiB-to-bytes conversion and the
ceiling arithmetic.

## Output

A run that passes produces two things and deploys neither.

- **A payload artifact**, `drupflare-worker-payload-<variant>-php<version>`, holding the tarball,
  `SHA256SUMS`, `manifest.json` and the pin. It is a complete hydrate input, retained 30 days.
- **A pull request** carrying `interp.lock.json`, which records the variant, the PHP version, the
  phasm artifact id, the frame's raw, packed and declared sizes, and a sha256 per file. The binaries
  are 9-12 MB and gitignored, so the pin is the reviewable part of an interpreter bump. The body
  carries the incumbent and proposed bundle figures side by side.

The branch is `interp/<variant>-php<version>-<artifact id>`, so a re-run for the same artifact finds
the branch on the remote and opens nothing. A pin byte-identical to the one already on the base
branch opens nothing either.

The pull request touches one tracked file, so `build.yml` and `coverage.yml` run the full code gate
on it. `interpreter.yml` gates the bytes and the bundle.

To reproduce a pinned interpreter by hand, pass the recorded artifact id:

```sh
bun scripts/fetch-interpreter.ts control85 8.5 4102938475 --pin
```

## Manual Runs

`workflow_dispatch` takes `variant`, `php_version`, `artifact_id` and `payload_tag`. An empty
`artifact_id` takes the newest unexpired artifact for the variant. An empty `payload_tag` hydrates
the payload for `package.json`'s version.

## Credentials

| what                   | where                       | scope                                                 |
| ---------------------- | --------------------------- | ----------------------------------------------------- |
| `PHASM_TOKEN`          | organization secret, both   | Actions: read on `phasm`; Contents: write on `worker` |
| `GITHUB_TOKEN`         | default, per job            | `contents: write`, `pull-requests: write` on `worker` |
| `CLOUDFLARE_API_TOKEN` | not held by either workflow | deploys are manual                                    |

`PHASM_TOKEN` authenticates two hops: phasm's dispatch into `worker`, and `worker`'s read of phasm's
Actions artifacts API. Contents: write is what the `repository_dispatch` endpoint requires; with
Actions: write alone the pipeline runs on the `workflow_dispatch` fallback.

Opening the pull request also requires "Allow GitHub Actions to create and approve pull requests" in
the repository's Actions settings. A pull request opened with `GITHUB_TOKEN` does not trigger
workflows that a `pull_request` event would otherwise start.

## Rollback

**The rollback unit is a Worker version.** The binary is not independently addressable at runtime,
so there is nothing smaller to revert. `wrangler rollback` and `wrangler versions deploy` both
operate on version ids, and a version is a whole bundle.

The consequence is that an interpreter bump ships in a version containing nothing else. Otherwise
the change unit and the rollback unit differ, and reverting a bad interpreter reverts unrelated
fixes with it.

Two documented limits shape a revert:

- Only the 100 most recent versions are reachable.
- A rollback cannot cross a Durable Object class lifecycle change, and `wrangler versions upload`
  cannot carry one. `wrangler.jsonc` holds
  `migrations: [{ tag: "v1", new_sqlite_classes: ["SitePhpDurableObject"] }]`, so an interpreter
  bump must never also add a migration tag. Lifecycle changes go out alone, through
  `wrangler deploy`.

A rollback restores code, but a heap image is data and it is binary-specific. opcache runs
`file_cache_only=1` in MEMFS, which belongs to the interpreter instance and outlives nothing. **The
stored heap snapshot does outlive it.** `HEAP_SNAPSHOT` is on by default and each site holds
31,784,960 bytes across 159 rows, so restoring an image taken on one interpreter into another is
corruption rather than a slow path.

`cfw_heap_snapshot` rows are keyed on the **pack generation** (`latestSnapshotMeta(sql,
packGeneration())`), not on the interpreter. An interpreter bump that leaves the pack alone therefore
selects a snapshot taken on the previous binary. Ship an interpreter bump with `HEAP_SNAPSHOT=0`, or
move the pack generation with it, until the snapshot key carries the interpreter pin.

## Staged Rollout

Gradual deployments assign each Durable Object a version for the life of the deployment, and
Cloudflare guarantees that "for a given deployment, requests to each Durable Object will always use
the same Worker version". So `wrangler versions deploy <new>@10 <current>@90` puts roughly 10% of
sites entirely on the new interpreter rather than scattering 10% of requests. An object reassigned a
version is reset and drops its interpreter, so each rollout step costs one cold boot per object
moved: 1,398 ms of edge cpuTime, n=3, on a platform that is bimodal by 400-600 ms.

Percentages are the only lever wrangler exposes, so the canary set cannot be chosen. Treat the
presence of a quarantined row (`isQuarantined()` in `src/ops/repair.ts`) in the canary set as a
reason to abort rather than as health data.

Read the result out of `cfw_health`, which is capped at `LEDGER_MAX_ROWS` and indexed on `ts DESC`.

| signal                                       | catches                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `boot.capability_missing`                    | a build that silently dropped an extension. `/php` reports `get_loaded_extensions()`, and the release lane asserts opcache, lexbor and the platform map against it |
| `boot.bridge_missing`, `boot.sqlite_too_old` | a glue or host mismatch before any page is served                                                                                                                  |
| `render.empty`, `render.size_anomaly`        | "it rendered, but wrong", the class a new binary produces                                                                                                          |
| `bridge.asyncify_called`                     | a `.mjs` glue that does not match the `.wasm`                                                                                                                      |
| `pack.generation_mismatch`                   | packed assets disagreeing with the database                                                                                                                        |
| `budget.rows_written`                        | a regression in the meter that binds regeneration                                                                                                                  |

Do not gate on CPU. An absolute figure comes only from `cpuTime` on a deployed version, and the
platform's 400-600 ms spread means a canary window cannot support a boot-time verdict at n=1 or n=3.

An available upgrade must not enter `recordOutcome()`. `src/ops/repair.ts` counts consecutive
same-code failures toward quarantine and rollback, and an upgrade is not a fault.

## Trust

The interpreter is the entire PHP runtime for every hosted site, and it executes inside the Durable
Object that holds that site's database, with the host bridge and the SQL handle in reach. It is also
the least reviewable artifact in the system: the shipping build is stripped at `-O2`, so `strings`
finds no symbol names, and 97.2% of a link map attributes to a single `lto.tmp` object. There is no
post-hoc audit available, so the pre-execution checks are the whole control.

What the pipeline proves today: the bytes came from a named artifact on a named repository over an
authenticated API, the frame header agrees with the binary, the seam imports the files that were
fetched, the bundle resolves and fits, and every file is content-addressed in the pin.

What it does not prove: provenance. phasm's `build.yml` attests `subject-path: dist/*`, so each
staged asset carries its own subject digest, but nothing in this repository runs
`gh attestation verify` against a downloaded artifact. Add it against
`--repo drupflare/phasm --signer-workflow drupflare/phasm/.github/workflows/build.yml` to close the
gap. Behaviour is proved after deploy by `BootSelfTest::run()`, which runs before the first request
is served.

## Self-Hosted Sites

A self-hosted site runs in the user's own Cloudflare account and drupflare holds no credential
there. The one-click template is the user's own repository with Workers Builds connected, so an
upstream interpreter arrives as a release they choose to consume. The mechanism ends at a pull
request; whether it merges is theirs.

## Cost

Nothing in the pipeline runs in the Worker, so it costs zero on both free-tier ceilings.

| component                             | Worker requests | DO requests                       | rows written                                     |
| ------------------------------------- | --------------- | --------------------------------- | ------------------------------------------------ |
| Notification and verification (CI)    | 0               | 0                                 | 0                                                |
| `versions upload` / `versions deploy` | 0               | 0                                 | 0                                                |
| Canary in, then promote               | 0               | 2 cold boots per site per release | boot-class rows, which a cold object pays anyway |

The only runtime cost is the cold boot each Durable Object pays when it is reassigned a version,
twice per rollout. At a few interpreter releases per year that does not appear in either ceiling,
and a version change introduces no new row class.

Free and paid stay equivalent. Versions, gradual deployments and rollbacks are not plan-gated. The
one plan-sensitive number is the 3 MiB bundle ceiling against 10 MiB on paid, which the gate reads
from wrangler rather than assuming.

## Rejected Alternatives

| rejected                                               | why                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime swap from R2, KV or DO storage                 | Request-time codegen is forbidden and startup I/O is forbidden. Both halves are needed and neither is available.                                                                                                                         |
| Interpreter as a Workers Static Asset, fetched at boot | Same wall. `CLAUDE.md` records this as why the binary cannot live on the asset layer.                                                                                                                                                    |
| Dynamic Workers with `{data: ArrayBuffer}`             | PHP runs inside the Durable Object because `ctx.storage.sql` is synchronous only there and PHP's calls block. A Dynamic Worker is a different isolate, so every database call becomes async RPC out of synchronous wasm.                 |
| A scheduled poll of phasm's releases                   | The dispatch delivers the same signal without a 6-hourly job, and GitHub disables `schedule` workflows after 60 days of repository inactivity.                                                                                           |
| Polling GitHub from the Worker                         | The site cannot act on the answer. The unauthenticated GitHub API allows 60 requests/hour per source IP on a shared Worker egress, and free allows 5 Cron Triggers per account against 250 on paid, one of which the fill window spends. |
| "Update available" as a repair-ladder rung             | `repair.ts` strikes drive quarantine and rollback. An upgrade is not a fault and would contaminate the counters that decide whether a site stops serving.                                                                                |
| Fetching binaries into `vendor/`                       | 14 unreproducible binaries. A pipeline that writes there is one bad path expansion from the only permanent loss in the project. `.interp/` is gitignored and disposable.                                                                 |
| Committing the binary to either repository             | 9-12 MB per variant. phasm's `lint` job fails on a tracked `*.wasm`.                                                                                                                                                                     |
| `wrangler deploy` on a green gate                      | The gate proves the bundle builds and fits. It cannot prove a new interpreter renders correctly on the edge.                                                                                                                             |

## Out of Scope

- **Deploying.** The pipeline ends at a pull request and an artifact. Promotion, canary and rollback
  are `wrangler` commands a human runs.
- **Drupal.** `SHIPPED_LOCK_VERSIONS`, `assets/drupal/site.sqlite` and `assets/driver.json` are a
  separate lane, and `site.sqlite` has no reproducible recipe.
- **Attestation.** Covered in [Trust](#trust).
- **PHP 8.5 on the edge.** The shipping seam is 8.5. A `cfw-*` deploy once returned 1101 with
  `ExitStatus: Program terminated with exit(-2)`; the cause was opcache, which reads
  `opcache.file_cache` during PHP's module startup, before the mount sequence creates
  `/tmp/opcache`. `src/site-do.ts:599` sets it to `/tmp`, which emscripten's MEMFS always creates.
  8.5 has rendered on a deployed worker since — the opcache file-cache counts in that comment were
  read off one. Each new build still needs its own deploy to prove it renders; the gate proves the
  bundle builds and fits.
- **A minor-version bump.** 8.3 to 8.5 moves the glue filename, needs a new seam plus one line in
  wrangler's `alias`, changes `DEFAULT_PLATFORM.php` in `src/ops/packagist.ts`, and re-runs
  `tests/node/php-fragments.spec.ts` and `bun run test:health` under the new interpreter. The
  version guard in step 2 of [Verification](#verification) refuses the fetch until the seam moves
  first.
- **Multiple Worker scripts.** Gradual deployments split versions of a single script. A fleet on N
  independently deployed scripts is N rollouts.
- **Toolchain pins are split.** The frame needs the `zstd` CLI, the decoder is pinned to
  `emscripten/emsdk:3.1.68`, and the interpreter is pinned to a builder image digest.
