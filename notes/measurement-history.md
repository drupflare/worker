# Measurement and gate history

Instrument errors and gate-lane findings, each with the case that earned the rule. Moved verbatim from the project CLAUDE.md.

## The gate and production reach the SAME interpreter, as of 2026-09-07

The section below is the history, and the divergence lasted the whole
life of the project. It is closed: a `CompiledWasm` import performs no codegen, so `vitest.config.ts`
aliases `./runtime/php-binary.js` to `src/runtime/php-binary-raw.ts` exactly as `wrangler.jsonc`
does, and both lanes now load the same module. The arm aliases repoint that seam's own two imports,
so `DRUPFLARE_ABI` and `DRUPFLARE_GROWTH_STEP` still work.

## How the gate and production USED to reach the interpreter by two different routes

`wrangler.jsonc` aliases `./runtime/php-binary.js` to the compressed 8.5 seam. **Vite does not apply
that alias**, so for the whole life of the project the test lane resolved the DEFAULT seam and ran PHP
**8.3** from `vendor/static-free-v1`, an experiment arm, while production ran 8.5. Every dev machine
has `vendor/`, so it was invisible until a clean checkout had neither.

**The compressed seam cannot be used by the gate, and this is a platform limit rather than a
preference.** `php-binary-85.ts` inflates and calls `new WebAssembly.Module` at module scope, which is
correct in production because workerd permits codegen at worker STARTUP -- but a vitest spec is
evaluated inside a fetch handler, so module scope there is REQUEST time and workerd refuses codegen.
Measured by pointing the seam at it: every workers spec fails to load.

**SO NOTHING IN THE GATE EXERCISES THE SHIPPING SEAM, and a change to it needs its own check.** The
three that reach it, none of which is `bun run test`: `bunx wrangler deploy --dry-run` proves it
bundles, `bunx wrangler dev --local` + a request proves the interpreter boots and Drupal renders, and
a throwaway deploy proves the startup budget. All three ran for the brotli switch on 2026-08-30. The
third read **104, 105, 107, 112 ms** (n=4, median 106) against a 1,000 ms limit, on a free worker
importing the seam and nothing else, so a failure there could not have been anything else. The
zstd-through-wasm path it replaced read 233/234/246 (n=3).

**Cloudflare prints the startup time on UPLOAD, which makes a deploy the only instrument for it** --
and a worker over the limit is refused at upload, so the deploy succeeding is half the measurement.

So `vitest.config.ts` aliases the seam's two imports to the **raw** `.interp/php8.5.wasm` +
`php8.5-worker.mjs`. A `.wasm` import arrives pre-compiled through the `CompiledWasm` rule and needs
no runtime codegen. It costs 12,218,393 bytes, which is why it is a TEST path and never a shipping
one. The gate now executes the interpreter that actually ships.

**What that immediately caught**, both invisible while the gate ran 8.3: a hardcoded `< 80 MB` heap
assertion that 8.5 fails at 96 MB (now compared against a fresh run of the same build), and
`HEAP_CEILING` at 100 MB when an install on 8.5 peaks at **115 MB** -- which agrees with the
~110.6 MB measured on a deployed worker. The 8.5 opcache startup abort shipped undetected for
exactly this reason and had to be caught on a throwaway deploy.

## A DOCUMENTED FIX IS A CLAIM, and one was cited as settled for three weeks

`TECHNICAL_REPORT.md` stated that the replica-admission gap was closed: "the primary mints with
`\Drupal::service('private_key')->get()`". **No call to that service existed anywhere under `src/`.**
Drupal mints `system.private_key` lazily on the first render carrying a CSRF token, `MANDATORY_STATE`
lists it because two objects each minting their own issue tokens the other rejects, and so every
replica of a migrated-and-claimed site was refused. The whole pool was unreachable while the document
said it worked.

A local rig found it, not a re-read: three lanes sat at stage `CREATED` through **40** provision
steps each, then reached `VERIFIED` in **1** step each once a single `/user/login` render had minted
the key. `firstRunConfig()` mints it now, and `tests/integration/firstrun.spec.ts` derives the names
it asserts from `MANDATORY_STATE` rather than restating them.

`check:reachability` catches a module nothing imports and `MUST_BE_CALLED` catches an export nothing
calls; neither can read a paragraph. **Grep for the call before citing a document as evidence a
defect is fixed.**

## A module can be on the edge while the FUNCTION that matters is not

The reachability scan classifies MODULES, so `src/ops/updb.ts` passed every check for its whole life:
`updbStep()` is called from the alarm. Beside it, `updbPrepare()`, `updbRollback()`, `updbAbandon()`
and `updbDrain()` were exported, unit-tested and called by nothing -- and `updbPrepare()` is the only
thing that can START a run, so `/updb` could advance a run nothing was able to create and an operator
got `{"beat":"none","reason":"no-run"}`, which reads as nothing to do. **The database-update chain had
never run on any site.** `degradeHeaders()` was the same shape one module over, which is why the
`reduced` band was invisible on every answered response.

`MUST_BE_CALLED` in `tests/node/reachability.spec.ts` is the guard: a short NAMED list of exports
whose absence from `src/` means a capability does not exist. Deliberately not a blanket rule -- 785
entries on that report are the legitimate exported-for-its-unit-test pattern, and a check that fails
on all of them gets switched off within a week.

**AND A CATCH CAN NAME AN ERROR RAISED OUTSIDE ITS `try`.** `runRedis()` caught `AuthError` on the
stated reasoning that a server which has answered must not be retried; `AuthError` is raised by
`_connectOverSocket()`, which sat one line ABOVE the `try`, so a wrong password escaped as a
retryable transport fault and the drain would retry it forever.

## A REDIRECTED-THROUGH URL IS A REQUEST, NOT A NAVIGATION

`page.waitForURL()` waits for a LOAD at a matching URL, and a 302 fires no load event at the URL it
redirects away from. `CfwOidc::complete` redeems the ticket and redirects onward, so the only URL
carrying `?cfw_oidc` is one the browser passes through -- and the wait timed out on a journey that
had already succeeded, with `External registration`, `Session opened for Drup Flare` and the ticket
visible in the worker's own request line. `page.waitForRequest()`, armed BEFORE the click that
starts the navigation, observes it without a race.

## The gate's time is IMPORT, and splitting a spec file makes it worse

Profiled 2026-09-14 on the workers project: 251 files, 510 s wall, lane-work
`transform 14 + import 1,188 + tests 2,284 = 3,487 s`. At 8 lanes the balanced floor is 436 s, so
**1 s of lane-work removed is 0.146 s of wall**.

**Import is charged per FILE.** A spec whose graph reaches `cloudflare:test`, `src/site.ts` or
`src/site-do.ts` instantiates the 12,218,393-byte interpreter into a fresh isolate: 52 ms outside
that set against 3.19 s inside it, n=3 each, and **7.78 s under eight contending lanes**. 152 of 251
files are in it. So a new spec file is not free, and splitting one to parallelise it **costs ~1.1 s
of wall** for nothing.

`static-sweep.spec.ts` was the candidate and is refused three ways: its lane-cost is 354.8 s against
a 436 s floor, it ends at t=363.5 s of a 509.2 s run and so finishes 145.8 s before the tail, and
the split adds import. **The lever is the WORK in a file, not its boundary** -- deleting that one
would save ~52 s.

What did work, both measured: making two `createUser()` calls opt-in took it 380 s -> 240 s alone
(26 of 28 provisions paid for accounts they never used), and memoising `subjectSweep()` took
`unicode-corpus.spec.ts` **53.81 s -> 27.39 s**, which passes 1:1 because the node project is
serial. What did NOT work is `maxWorkers` on the node project: `fileParallelism: false` means plain
`it()` cases do not parallelise, so it bought ~0.

**`workerLanes()`'s cap of 8 is a guess wearing a rule's clothes** -- its stated reason, that the
lanes contend on the same SQLite, has no reading behind it, and `byCores` is 10 on this machine. The
balanced floor at 10 is 349 s against 436. `DRUPFLARE_TEST_WORKERS=10` runs the arm.

**MEASURE THE GATE ON A QUIET MACHINE.** These numbers were taken with 18 GB swapped and an
unrelated process pinned at ~98% CPU for three days; a two-file control drifted +45% inside one
session, and a combined `bun run test` read 1,784 s against 617 s for the same work as two separate
invocations. Check `sysctl vm.swapusage` and `ps` before believing any gate timing.

## A hook timeout that was real did not explain the intermittent blamed on it

The `e2e` project set `testTimeout` and never `hookTimeout`, so a `beforeAll` could die at vitest's
10 s default while waiting out a `wrangler dev` Durable Object restart the gate exists to absorb.
That is fixed and covers **six** of the eight e2e specs, counted rather than asserted: `git`,
`hard-cases`, `lifecycle`, `mail`, `oidc` and `tcp` carry a bare `beforeAll`.

**`leak.spec.ts` is not one of them.** Its `beforeAll` carries an explicit `1_200_000` timeout, so
the default never governed it, and its `e2eGate()` call is at MODULE level where collection rather
than the hook applies. The roadmap had recorded the fix as the likely cause of that file's
intermittent; it cannot be. Check which hook actually governs before attributing a timeout.
