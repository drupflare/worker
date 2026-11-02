# Rollback and Staged Rollout

How a bad interpreter is rolled back and how a good one reaches sites in stages.

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
  cannot carry one. `wrangler.jsonc` holds the
  migration tags `v1` (`SitePhpDurableObject`) and `v2` (`RenderLane`), so an interpreter bump must
  never also add a migration tag. Lifecycle changes go out alone, through
  `wrangler deploy`.

A rollback restores code, but a heap image is data and it is binary-specific. opcache runs
`file_cache_only=1` in MEMFS, which belongs to the interpreter instance and outlives nothing. **The
stored heap snapshot does outlive it.** `HEAP_SNAPSHOT` is on unless it is set to `0` or the
deployment carries environment variables or config. One measured site held 31,784,960 bytes of
snapshot across 159 rows. Restoring an image taken on one interpreter into another is corruption
rather than a slow path.

`cfw_heap_snapshot` rows are keyed on the heap generation (`latestSnapshotMeta(sql,
heapGeneration())` in `src/do/routes/heap.ts`), which is the pack generation plus the module set.
Neither is the interpreter. An interpreter bump that leaves the pack alone therefore
selects a snapshot taken on the previous binary. Ship an interpreter bump with `HEAP_SNAPSHOT=0`, or
move the pack generation with it, until the snapshot key carries the interpreter pin.

## Staged Rollout

Gradual deployments assign each Durable Object a version for the life of the deployment, and
Cloudflare guarantees that "for a given deployment, requests to each Durable Object will always use
the same Worker version". So `wrangler versions deploy <new>@10 <current>@90` puts roughly 10% of
sites entirely on the new interpreter rather than scattering 10% of requests. An object reassigned a
version is reset and drops its interpreter, so each rollout step costs one cold boot per object
moved: about 1,398 ms of edge cpuTime (n=3).

Percentages are the only lever wrangler exposes, so the canary set cannot be chosen. Treat the
presence of a quarantined row (`isQuarantined()` in `src/ops/repair.ts`) in the canary set as a
reason to abort, and never as health data.

Read the result out of `cfw_health`, which is capped at `LEDGER_MAX_ROWS` and indexed on `ts DESC`.

| signal                                       | catches                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `boot.capability_missing`                    | a build that silently dropped an extension. `/php` reports `get_loaded_extensions()`, and the release lane asserts opcache, lexbor and the platform map against it |
| `boot.bridge_missing`, `boot.sqlite_too_old` | a glue or host mismatch before any page is served                                                                                                                  |
| `render.empty`, `render.size_anomaly`        | "it rendered, but wrong", the class a new binary produces                                                                                                          |
| `bridge.asyncify_called`                     | a `.mjs` glue that does not match the `.wasm`                                                                                                                      |
| `pack.generation_mismatch`                   | packed assets disagreeing with the database                                                                                                                        |
| `budget.rows_written`                        | a regression in the meter that binds regeneration                                                                                                                  |

Do not gate on CPU. An absolute figure comes only from `cpuTime` on a deployed version. A canary
window of n=1 or n=3 cannot show a spread, so it cannot support a boot-time verdict.

An available upgrade must not enter `recordOutcome()`. `src/ops/repair.ts` counts consecutive
same-code failures toward quarantine and rollback, and an upgrade is not a fault.
