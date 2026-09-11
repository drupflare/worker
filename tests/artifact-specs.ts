/**
 * The specs that need a BUILD ARTIFACT: the interpreter, the pack, the migration chunks, or the
 * browser-fetchable core tree.
 *
 * Measured from CI rather than guessed, and the list only ever grows by being MEASURED. Two errors
 * put a file here: the interpreter stub's "no PHP interpreter in this lane", and
 * `per-file pack not reachable: core.pf.json 404` / `dump contains no statements` once the
 * interpreter is restored but the pack is not. The pack is the wider and the binding case, because
 * it is the artifact a clean checkout cannot obtain at all.
 *
 * **No count in this sentence, deliberately.** It has said 15 while the list held 17 and 19, and
 * CLAUDE.md records that drift twice over. The skip message below reads `ARTIFACT_SPECS.length`, so
 * the lane reports the real number every run.
 *
 * A new spec that needs an artifact and is not listed here fails with one of those named errors,
 * which is the intended way to find out -- an exclusion list that silently grew would be worse.
 */
export const ARTIFACT_SPECS = [
	'tests/integration/admin-config.spec.ts',
	// twenty joined on 2026-08-28, found by hiding assets/drupal-pf/core.pf.json locally and
	// running the gate -- the same state a clean checkout is in. Master had been red since
	// 2026-08-22 because each of these reaches a real render and nothing listed them
	'tests/integration/anonymous-register.spec.ts',
	'tests/integration/autoincrement.spec.ts',
	'tests/integration/cache-bin-rowid.spec.ts',
	'tests/integration/capability-contract.spec.ts',
	'tests/integration/contrib-verify.spec.ts',
	'tests/integration/cron-wire.spec.ts',
	'tests/integration/crossings.spec.ts',
	'tests/integration/crud-journey.spec.ts',
	'tests/integration/csrf.spec.ts',
	'tests/integration/degrade-serve.spec.ts',
	'tests/integration/effect-census.spec.ts',
	'tests/integration/enable-memory.spec.ts',
	'tests/integration/fill-bins.spec.ts',
	// the populated-site instruments: a real render per filled page, a real install per module,
	// and a heap image needs a booted interpreter
	'tests/integration/fills-per-save.spec.ts',
	'tests/integration/module-converge.spec.ts',
	'tests/integration/qa-session-rows.spec.ts',
	'tests/integration/firstrun.spec.ts',
	'tests/integration/fragment-index.spec.ts',
	'tests/integration/git-remotes.spec.ts',
	'tests/integration/guzzle-handler.spec.ts',
	'tests/integration/heap-growth.spec.ts',
	'tests/integration/heap-image-storage.spec.ts',
	'tests/integration/host-bridges.spec.ts',
	'tests/integration/image-toolkit.spec.ts',
	// eight joined on 2026-09-08, found the same way: hide `assets/drupal-pf/core.pf.json` and run
	// the gate. All eight reach the interpreter and several a real render. The park four and
	// `mb-native` had landed EARLIER the same day without this reproduction being run, which is the
	// six-days-red shape CLAUDE.md records -- every dev machine has the pack, so nothing local says so
	'tests/integration/image-metadata.spec.ts',
	'tests/integration/heap-restore-autoload.spec.ts',
	'tests/integration/inherited-extensions.spec.ts',
	'tests/integration/mb-native.spec.ts',
	'tests/integration/modify-upload.spec.ts',
	'tests/integration/park-dispatch.spec.ts',
	'tests/integration/park-interpreter.spec.ts',
	'tests/integration/park-oidc.spec.ts',
	// drives two real renders to prove the tally moves with them and only with them
	'tests/integration/park-totals.spec.ts',
	'tests/integration/seed-cache-cost.spec.ts',
	'tests/integration/session-gc.spec.ts',
	'tests/integration/interpreter-recycle.spec.ts',
	'tests/integration/lazy-fs-budget.spec.ts',
	'tests/integration/linear-memory.spec.ts',
	'tests/integration/loaded-extensions.spec.ts',
	'tests/integration/long64-abi.spec.ts',
	'tests/integration/mail-drupal.spec.ts',
	'tests/integration/module-behaviour.spec.ts',
	'tests/integration/module-enable.spec.ts',
	'tests/integration/multipart-submit.spec.ts',
	'tests/integration/opcache-ab.spec.ts',
	'tests/integration/ops-surface.spec.ts',
	'tests/integration/pack-consistency.spec.ts',
	'tests/integration/page-content-key.spec.ts',
	'tests/integration/php-allocator.spec.ts',
	'tests/integration/php-clock.spec.ts',
	// the reconciliation acceptance test boots a kernel and writes config through Drupal's own
	// factory, so it needs the pack the same way every render above does
	'tests/integration/reconcile-converge.spec.ts',
	// the sweep enumerates `router` and the entity tables, which arrive with the pack
	'tests/integration/sweep-wire.spec.ts',
	// the cold-encounter counter is read around a real interpreter entry
	'tests/integration/cold-encounter-wire.spec.ts',
	// wholly gated on DRUPFLARE_MEASURE until each grew an ungated gate-sized counterpart, which
	// renders for real
	'tests/integration/authenticated-throughput.spec.ts',
	'tests/integration/plan-amortisation.spec.ts',
	'tests/integration/plan-coverage.spec.ts',
	'tests/integration/render-floor-ladder.spec.ts',
	// and this one imports `scripts/bench/pw-plan-replay.php?raw`, which is UNTRACKED rather than
	// gitignored, so a clean checkout could not COLLECT it either -- the same shape as
	// `render-buckets.spec.ts` above and equally invisible while the gate never ran the file
	'tests/integration/render-plan-arms.spec.ts',
	// imports `assets/probe/pw-probe.php?raw`, which is gitignored, so a clean checkout cannot
	// COLLECT it even though the spec itself is gated on DRUPFLARE_MEASURE and never runs
	'tests/integration/render-buckets.spec.ts',
	'tests/integration/render-origin.spec.ts',
	'tests/integration/rows-per-fill-audit.spec.ts',
	'tests/integration/serve-chain.spec.ts',
	'tests/integration/serve-invalidation.spec.ts',
	'tests/integration/serve-lanes.spec.ts',
	'tests/integration/serve-migration.spec.ts',
	'tests/integration/serve-restore.spec.ts',
	'tests/integration/shell-seed.spec.ts',
	'tests/integration/replica-invariant.spec.ts',
	'tests/integration/shell-verify-cost.spec.ts',
	'tests/integration/shell-verify.spec.ts',
	'tests/integration/shell.spec.ts',
	'tests/integration/snapshot-dedup.spec.ts',
	'tests/integration/snapshot-delta.spec.ts',
	'tests/integration/speculative-replay.spec.ts',
	'tests/integration/statement-census.spec.ts',
	'tests/integration/static-sweep.spec.ts',
	'tests/integration/submission-wall.spec.ts',
	'tests/integration/without-rowid.spec.ts',
	'tests/integration/workload-matrix.spec.ts',
	'tests/integration/write-amplification.spec.ts',
	// thirteen joined on 2026-09-07 the same way the twenty above did: hide
	// `assets/drupal-pf/core.pf.json` locally and run the gate. Every one reaches a real render --
	// a replica copies a rendered site, a heap image needs a booted interpreter, an advisory needs
	// cron to have run -- and none of them was listed, so a clean checkout was red on all of them
	'tests/integration/advisory-detect.spec.ts',
	'tests/integration/generation-fence.spec.ts',
	'tests/integration/heap-image-producer.spec.ts',
	'tests/integration/heap-image-site-keyed.spec.ts',
	'tests/integration/replica-catchup.spec.ts',
	'tests/integration/replica-handoff.spec.ts',
	'tests/integration/replica-provision.spec.ts',
	'tests/integration/replica-readmit.spec.ts',
	'tests/integration/replica-restore.spec.ts',
	'tests/integration/replication-emit.spec.ts',
	'tests/integration/shared-base-share.spec.ts',
	'tests/integration/state-inventory.spec.ts',
	'tests/integration/warm-alarm-cost.spec.ts',
	'tests/unit/runtime/assets-ignore.spec.ts'
];
