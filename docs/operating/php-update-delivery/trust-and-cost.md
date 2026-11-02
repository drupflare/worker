# Trust, Cost and Scope

What the pipeline asks a site to trust, how self-hosted sites differ, what it costs, which designs were rejected, and what it leaves out.

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
gap. Behaviour on the deployed site is checked by the health self-test, `BootSelfTest::run()`, which the
host calls through `runHealthSelfTest()` in `src/drupal/cron-php.ts` from the cron path in
`src/ops/cron.ts`.

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

Free and paid stay equivalent. Versions, gradual deployments and rollbacks are not plan-gated, and the
bundle ceiling is 64 MiB uncompressed on both plans. The gate reads it from wrangler's `Total Upload`
line.

## Rejected Alternatives

| rejected                                               | why                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime swap from R2, KV or DO storage                 | Request-time codegen is forbidden and startup I/O is forbidden. Both halves are needed and neither is available.                                                                                                                         |
| Interpreter as a Workers Static Asset, fetched at boot | Same constraint as the runtime swap: the bytes must be present at bundle time.                                                                                                                                                           |
| Dynamic Workers with `{data: ArrayBuffer}`             | PHP runs inside the Durable Object because `ctx.storage.sql` is synchronous only there and PHP's calls block. A Dynamic Worker is a different isolate, so every database call becomes async RPC out of synchronous wasm.                 |
| A scheduled poll of phasm's releases                   | The dispatch delivers the same signal without a 6-hourly job, and GitHub disables `schedule` workflows after 60 days of repository inactivity.                                                                                           |
| Polling GitHub from the Worker                         | The site cannot act on the answer. The unauthenticated GitHub API allows 60 requests/hour per source IP on a shared Worker egress, and free allows 5 Cron Triggers per account against 250 on paid, one of which the fill window spends. |
| "Update available" as a repair-ladder rung             | `repair.ts` strikes drive quarantine and rollback. An upgrade is not a fault and would contaminate the counters that decide whether a site stops serving.                                                                                |
| Fetching binaries into `vendor/`                       | 15 hand-built binaries under `vendor/static*/` that this repository cannot reproduce. A pipeline that writes there is one bad path expansion from the only permanent loss in the project. `.interp/` is gitignored and disposable.       |
| Committing the binary to either repository             | 9-12 MB per variant. phasm's `lint` job fails on a tracked `*.wasm`.                                                                                                                                                                     |
| `wrangler deploy` on a green gate                      | The gate proves the bundle builds and fits. It cannot prove a new interpreter renders correctly on the edge.                                                                                                                             |

## Out of Scope

- **Deploying.** The pipeline ends at a pull request and an artifact. Promotion, canary and rollback
  are `wrangler` commands a human runs.
- **Drupal.** `SHIPPED_LOCK_VERSIONS`, `assets/drupal/site.sqlite` and `assets/driver.json` are a
  separate lane, and `site.sqlite` is built by `scripts/drupal/install-site-db.php` (see [Site Database](../../architecture/database.md)). That lane reaches an existing site
  through `src/ops/reconcile.ts` rather than through a redeploy: a step observes the site's end state,
  and `container-driver-digest` compares `src/ops/driver-digest.ts` against what the site recorded, so
  a `#[Hook]` class added to a sibling after the bake is discovered on the next boot. A redeploy alone
  does not move it, because `DrupalKernel::getContainerCacheKey()` is composer's `VERSIONS_HASH` plus
  the PHP version and the OS.
- **Attestation.** Covered in [Trust](#trust).
- **PHP 8.5 on the edge.** The shipping seam is 8.5. opcache reads `opcache.file_cache` during PHP's
  module startup, before the mount sequence creates `/tmp/opcache`, and the boot exits with status -2.
  `src/runtime/opcache.ts` sets it to `/tmp`, which emscripten's MEMFS always creates. Each new build
  still needs its own deploy to prove it renders; the gate proves the bundle builds and fits.
- **A minor-version bump.** 8.3 to 8.5 moves the glue filename, needs a new seam plus one line in
  wrangler's `alias`, changes `DEFAULT_PLATFORM.php` in `src/ops/packagist.ts`, and re-runs
  `tests/node/php-fragments.spec.ts` and `bun run test:health` under the new interpreter. The
  version guard in step 1 of [Verification](verification.md#verification) refuses the fetch until the seam moves
  first.
- **Multiple Worker scripts.** Gradual deployments split versions of a single script. A fleet on N
  independently deployed scripts is N rollouts.
- **Toolchain pins are split.** The frame needs no external tool: `node:zlib` packs it and
  `node:zlib` inflates it on the edge. The interpreter is pinned to a builder image digest.
