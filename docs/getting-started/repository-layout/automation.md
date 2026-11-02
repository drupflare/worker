# Scripts and Automation

Scripts nothing calls, the tests behind the headline claims, and the nightly jobs.

## Unwired Scripts

Reference counts across `package.json`, `scripts/`, `src/`, `tests/`, `docs/` and the READMEs.

| script                         | refs | state                                                                                                                                                           |
| ------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/bake-container.php`   | 0    | superseded. `bake-pack.ts` records that rewriting the container key by hand produced a byte-identical render that still missed, which is what this script does. |
| `scripts/stage-edge-assets.sh` | 1    | superseded by `assets/.assetsignore` for the canonical config, still used by `experiments/wrangler/*`. Keep.                                                    |

`scripts/` is grouped by role, as described in `scripts/README.md`: the live pipeline in TypeScript,
`bench/` PHP for the native half of a ratio, `probe/` shell pairs, and `measure/` instruments.
`src/probes/**` holds measurement instruments on the same terms. `release-payload.ts`, `hydrate.ts`
and `backup-cdn.ts` sit flat alongside `pack-*.ts` and `gen-driver-assets.ts`. `experiments/` holds
configs kept for reproduction and excluded from prettier.

## Test Coverage of Headline Claims

Thirteen headline claims from the summary in `TECHNICAL_REPORT.md`, classed by what can check them:

- **(a) arithmetic or model**: hermetic, free, in the gate.
- **(b) artifact**: needs bytes on disk; runs in the release lane, which hydrates the payload.
- **(c) edge**: needs a deployed worker. An absolute CPU figure comes only from `cpuTime` on one.

| #   | claim                                                                    | class | caught?                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | the bundle fits the 64 MiB Worker size limit                             | b     | **yes.** `bun run release:check` parses wrangler's printed uncompressed figure and fails over the limit; the release lane runs it. `tests/unit/bundle-size.spec.ts` covers the arithmetic.                                                                                 |
| 2   | PHP 8.5 ships with nothing dropped to fit                                | b     | **yes, both halves.** `interp.lock.json` and the payload manifest pin the frame's sha256; `tests/integration/loaded-extensions.spec.ts` reads `get_loaded_extensions()` out of the running binary and asserts opcache and lexbor by name, plus the platform map both ways. |
| 3   | serving 3.0M visits/month, regeneration 50,916 renders/day               | a     | **yes.** `tests/unit/free-envelope.spec.ts` over `scripts/measure/free-envelope.ts`.                                                                                                                                                                                       |
| 4   | the per-class row cost of a fill                                         | a     | **yes.** `tests/integration/rows-per-fill-audit.spec.ts` drives every class on one object and pins it.                                                                                                                                                                     |
| 5   | the first-run migration chunk count                                      | a     | **yes.** `assets/drupal-sql/manifest.json` reports it. The count moves with the packed database, so read the manifest rather than a document.                                                                                                                              |
| 6   | `assets/driver.json` is the code that executes, and is current           | b     | **yes.** `tests/node/driver-pack.spec.ts`, byte for byte.                                                                                                                                                                                                                  |
| 7   | the canonical config reaches its own code                                | a     | **yes.** `tests/node/wrangler-reachability.spec.ts`, including the binary alias.                                                                                                                                                                                           |
| 8   | the compiled Twig cache is reachable at the key the runtime asks for     | b     | **yes, in the release lane.** `tests/node/twig-bake.spec.ts` with `REQUIRE_ARTIFACTS=1`.                                                                                                                                                                                   |
| 9   | DO SQLite: 100 bound params, 50-byte LIKE, lossy above 2^53              | a     | **yes.** `tests/unit/db/do-sqlite.spec.ts` and `tests/unit/db/file-store.spec.ts`, inside workerd against the real limits.                                                                                                                                                 |
| 10  | cold boot 1,398 ms, `page_cache` hit 1 ms, render 2,127 ms, startup 5 ms | c     | **no.** PHP clocks do not advance across a synchronous PHP run on the edge, so a duration read inside PHP is 0. The absolute time is a real epoch. Durations need a deployed worker's `cpuTime`.                                                                           |
| 11  | the shipping asset set is exactly what the runtime fetches               | a     | **yes.** `tests/unit/runtime/assets-ignore.spec.ts` through the real `ASSETS` binding, plus the payload's bidirectional check against the same file.                                                                                                                       |
| 12  | 19 tripwires, and the repair ladder fails closed mid-transaction         | a     | **yes.** `tests/unit/ops/repair.spec.ts`. 12 in `HOST_TRIPWIRES`, 7 under `drupflare/src/Health/Tripwire/`.                                                                                                                                                                |
| 13  | the render origin is a property of the site, not of the request          | a     | **yes.** `tests/unit/ops/site-origin.spec.ts` and `tests/integration/render-origin.spec.ts`.                                                                                                                                                                               |

## Nightly Automation

| lane                                                                    | asserts                    | cost                                            | verdict                                                                                                                     |
| ----------------------------------------------------------------------- | -------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| model figures: free envelope, ceiling arithmetic, rows-per-fill classes | every (a) row              | seconds, hermetic                               | already in the gate; a nightly adds nothing a push does not                                                                 |
| artifact figures: payload manifest, frame sizes, chunk count, Twig keys | the (b) rows               | one payload download plus a dry-run, ~3 minutes | built, in the release lane. Not scheduled; a nightly run against the latest release would catch a deleted or replaced asset |
| CDN backup intact                                                       | 35 live + 15 archived keys | one HEAD per key, no credentials                | built. `.github/workflows/backup.yml`, daily at 05:20 UTC                                                                   |
| edge figures: `cpuTime`, cold boot, render cost                         | the (c) rows               | a deploy, a tail and a teardown per run         | no. One nightly sample carries no spread                                                                                    |

Push checks the model, and the release checks the artifact. Nothing scheduled checks the edge. The
release workflow runs on `workflow_dispatch` only.

Tracking edge figures needs a `workflow_dispatch` job that deploys a `cfw-*` worker, reads `cpuTime`
from the Observability API at n >= 5, tears the worker down, and reports the spread.
