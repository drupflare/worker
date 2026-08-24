# drupflare/worker

Drupal 11 running inside a Cloudflare Worker, with PHP 8.5 compiled to wasm and executed inside a
Durable Object. This repo is the deployable product; the reusable pieces live in sibling repos.

## RULE 0, above everything else

**An absolute CPU figure comes ONLY from `cpuTime` in `wrangler tail` on a DEPLOYED worker.**

In-PHP `microtime()` **does not advance** on the edge, and neither does `Date.now()` inside the
isolate: a DELTA taken from either reads 0, or worse, a **plausible wrong number** - 114 ms has been
reported for a 1,374 ms invocation. 0 is obviously broken; 114 survives review. A local
`wrangler dev` wall clock cannot even ORDER two profiles correctly.

**"Returns 0" is what this file used to say, and it is a claim about the DELTA that was read as a
claim about the value.** Measured 2026-08-22: `microtime()` returns a real epoch
(1787454264.88 in workerd), because PHP's clock is the glue's
`_emscripten_date_now = () => Date.now()` and Workers FREEZE that between I/O rather than zeroing
it. The host depends on the same fact - `nowMs()` is `Date.now()` and arms every alarm and every
`expires_at` on deployed sites. So a frozen clock breaks a duration and an application timestamp is
fine, which is the opposite of what P41 had scheduled a security fix for. `tests/integration/php-clock.spec.ts`
pins it and `/clock` reports `absoluteS`/`jsAbsoluteMs` for the deployed reading.

**What IS broken about a timestamp here is `PHP_INT_SIZE` 4.** `(int) (microtime(true) * 1000)`
overflows and the cast is MODULAR rather than saturating - measured, `1787454172276.0` casts to
`747777140`, exactly `mod 2^32`. So any module storing epoch milliseconds or microseconds as an int
stores a wrapped value. A `cfwNow` bridge would not help; 64-bit `zend_long` (P28) is the fix.

**`memory_get_usage()` reading 0 is a BUILD property, not an edge one** - it reads 0 in the gate
lane too, where the clock demonstrably works. The report grouped the two as one platform symptom
and they share no mechanism.

`wrangler tail` **silently omits `durableObject` events** unless you ask for them, so a tail that
looks empty is not proof of anything.

**The platform is bimodal by +400-600 ms**, on the same object with the interpreter dropped each time,
and the split appears in every phase. **So an n=1 or n=3 verdict about anything under ~500 ms is
unsupportable here.** State an n and a spread with every absolute; a bare single number is not a
measurement.

Corollaries, each of which cost real work to learn:

- Never quote a local number as a CPU cost. Say "local wall clock" or do not say it.
- Never call `Database::startLog()`. It changes what you are measuring.
- Benchmark inside a PHP closure, and **name which cache bins you emptied** for every render figure.
  "Warm render" and "cache hit" are different measurements even when both are warm.
- **A subtraction is only as good as its subtrahend.** Check what the number you are subtracting
  actually measured before trusting the difference.
- **A probe that cannot fail is not a probe.** A probe for state SURVIVAL must exercise state
  captured before the event, never state re-resolved after it.
- **Size a chunk by the meter that binds it, and name that meter.** A chunk sized against storage
  while CPU is the binding cost will pass its own test and blow the real one.
- **Count both halves.** An instrument attached to one layer measures that layer, not the system;
  ask what it cannot see before quoting it.
- **`PLAN=free` is drupflare's var, not Cloudflare's plan, and the working account is Workers PAID.**
  A 6,355 ms invocation completed `ok`; free refuses with HTTP 503 and error 1102. So a deployed run
  on the working account measures COST, which is plan-independent, and never ENFORCEMENT.
  `limits.cpu_ms` does not substitute -- a 152 ms invocation survived a configured cap of 10. A
  separate free account exists for enforcement work.
- **THE FREE CAP HAS A BURST ALLOWANCE, so an n=1 probe of it reads ~200x too generous.** Measured on
  a real free account: one 200,000,000-iteration request SUCCEEDS, the same request repeated fails
  11 of 15. Sustained, only 1,000,000 iterations holds 10/10. Single-shot and sustained are different
  measurements and the single-shot one is nearly useless. A warm render is 2,127 ms, so free is about
  three orders of magnitude short of rendering; prefill and the alarm chain are load-bearing, not
  defensive.
- **Observability's `calculations` view omits zero-valued groups.** 360 driven invocations returned
  13 groups, all of them the 1-2 ms tail, and the query reported no error. Read the `events` view;
  `obs-cpu.ts` now defaults to it. Where the expected answer is "below the meter's resolution", an
  instrument blind to zero reports the tail as the body.
- Most moved verdicts in this project moved because the _instrument_ was wrong, not the system.
  Suspect the instrument first.

The measurements behind each of these -- the readings, the spreads, and what was concluded wrongly
from them -- are in project memory rather than here, because they are findings rather than
instructions to a maintainer.

`TECHNICAL_REPORT.md` is the single source of truth (~9,400 lines). Everything above its `FOLD`
marker is authoritative; everything below is historical record in measurement order. `FINDINGS.md`,
`RESUME.md`, `AGENT-FINDINGS.md` and `DRIVER-NOTES.md` were merged into it and **deleted** - if
something points you at those, it is stale.

## RULE 0b: score against the PRODUCT ENVELOPE, never against the 10 ms cap

The 10 ms invocation cap constrains **one execution unit**, and the architecture chooses what an
execution unit is - 20 DO hops accumulated 142 ms here with no single invocation over 10 ms. So "does
this fit in 10 ms" was never the definition of free-tier viability, and scoring work against it produced
a pendulum: find a cost over 10 ms, declare free impossible, split it, declare free viable, repeat.

**There are TWO ceilings and they differ by 476x:**

| ceiling      | bound by                     | measured                                                   |
| ------------ | ---------------------------- | ---------------------------------------------------------- |
| Serving      | Worker requests, 100k/day    | **100,000 visits/day** (= 3M/month, saturated at 1.00x)    |
| Regeneration | DO requests AND rows written | **1,052 renders/day** cold, **7,575** windowed (rows bind) |

Regeneration is the ceiling that decides whether free is a real Drupal host. Score every proposal with
`bun scripts/measure/free-envelope.ts --visits=3000000 --dynamic=0.01`; it fails a workload that misses
EITHER ceiling, and `tests/unit/free-envelope.spec.ts` covers the arithmetic.

Two traps this closes:

- **A cache hit is not free.** It costs one Worker request whether or not PHP runs, so a "99% cached"
  architecture rescues CPU and does nothing for the serving ceiling.
- **Decomposition is not free.** The DO quota explicitly counts alarm invocations, so slicing spends the
  meter it is trying to dodge; a measured 6-way split took fills from 5,555 to 4,166/day.
- **BOOT WORK IS SATURATED, and this reorders the roadmap.** Once the fill window amortises the boot,
  the regeneration ceiling is bound by ROWS WRITTEN, not by DO requests. A 20x reduction in boot cost
  per fill moves the ceiling about **1%**, so JSPI, the A2 heap restore and always-warm objects are
  worth ~1% until rows-per-fill falls. Rows work FIRST. **The "always-warm objects" half of that
  sentence is a FREE-TIER result and does not generalise** - on paid, one always-warm object fits
  inside the included duration allowance and two cost ~$3.29/month, so what refuses them there is
  throughput, consistency and snapshot distribution, never the bill. See RULE 0c.
- **There is no single rows-per-fill figure, and the flat 17 this file used to quote was wrong twice
  over.** It came from an instrument hung off `execSql()`, which sees Drupal's statements and none of
  the host's - it never counted the `cfw_page` insert that stores the whole rendered page. Measured
  completely, a fill is **3 / 13 / 19 / 62 rows** depending on what is already warm, a 20x spread.
  `ROWS_PER_FILL` in `scripts/measure/free-envelope.ts` names all four classes; the model defaults to
  `realRender: 13`, which is what a regeneration actually pays. The "drop dblog for 2.15x" lever does
  not exist: measured, zero rows go to `watchdog`.
- **There is a THIRD meter neither ceiling sees.** Cloudflare Images allows **5,000 unique
  transformations per MONTH** on free and it fails as a hard cap rather than a bill. Every image style is
  a transformation, so 10 styles over 2,000 images is 4x over. It is now **projected rather than
  counted** -- the object multiplies its own styles by its own images on each alarm and records
  `budget.image_transforms` at 80% -- because the meter is a function of content and configuration,
  both known in advance, and it is monthly so it does not clear at midnight.

**The adversarial rule.** A workaround does NOT succeed merely because it fits a Cloudflare limit.
Reject it if it makes free and paid functionally equivalent, violates the one-click goal, charges a
"understand Workers internals" tax, produces latency a visitor would call broken, or burns a daily quota
at a rate incompatible with ~3M visits/month on both ceilings.

This exists because the cost model that said "Worker requests bind first" was already in the report,
was correct, and governed nothing. A right metric that scores no decisions is decoration.

## RULE 0c: a negative result closes a MECHANISM, never an OBJECTIVE

**When a measurement kills a proposed lever, close the lever and keep the resource on the board.**
This is the single most common way work is lost here, and it is subtler than being wrong: the
measurement is correct, the conclusion drawn from it is one step too wide, and an entire engineering
objective quietly leaves the backlog attached to the implementation that failed.

Five items were closed this way on 2026-08-23 and four had to be reopened the same day:

| what was measured                                          | what it closes                         | what it does NOT close                                                                                                                       |
| ---------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `INITIAL_MEMORY` is a floor, the peak is reached by growth | lowering 96 -> 80 MB to lower the peak | **reducing peak linear memory.** Growth over-reservation, MEMFS, snapshot staging and SQLite buffers are all unmeasured shares of 115.25 MiB |
| two always-warm objects exceed the free duration allowance | permanently resident replicas on free  | **replicas.** A hibernating replica accrues no idle duration -- MEASURED 2026-08-23, see below                                               |
| duration spends 2.1% at today's traffic                    | duration as today's binding meter      | **duration.** The figure was `cpuTime`-derived, and cpuTime understates it by a measured **2,612x**                                          |
| a warm render crosses the bridge 48 times, 0 batchable     | coalescing the bridge                  | **the 48 SQL statements.** 48 is the FIRST render; a repeat one is 18, and bridge overhead is 0 of both                                      |
| no cache bin declares `AUTOINCREMENT`                      | it as a rows-per-FILL lever            | **write amplification.** Measured: the keyword costs 4 charged rows against 1, through driver speculative replay                             |

**The habit that prevents it.** After any "this does not matter", answer three questions in writing
before closing anything:

1. **Which resource did I measure**, and which OTHER mechanism could move that same resource?
2. **Under which workload?** This project's ceilings are computed from a page fill. A node save, a
   login, an upload and a cron run spend different meters, and an item scored against one of them
   has not been scored against the others.
3. **Is the claim I am about to write DOWNSTREAM of what I measured?** Counting 48 crossings is a
   measurement. "48 crossings would be 48 billed DO requests" is an inference about billing that no
   crossing count can support, and it shipped in a test before this rule existed.

**Be hardest on this when the item unlocks CAPABILITY.** A capacity lever that dies costs a
percentage. A capability item that dies wrongly - argon2, wasm64, 64-bit integers, replicas - takes
a whole class of sites with it, and it dies quietly because nobody is waiting for the feature. For
those, "the obvious implementation does not fit" is the START of the question. Ask where the work
must EXECUTE, not only whether it fits where it currently runs.

## RULE 0d: duration is WALL CLOCK, and `cpuTime` understates it by 2,612x

**Measured 2026-08-23 on a deployed throwaway with no PHP in it.** Ten 1,000 ms holds on one object:
`activeTime` 10,026,244 us, `cpuTime` 3,838 us, `duration` 1.283359232 GB-s. `10.026244 * 0.128` is
that figure exactly, so `activeTime` is microseconds of wall clock, `duration` is GB-s, and
`DO_GB_ALLOCATED = 0.128` is confirmed from BILLING rather than from a docs example.

**The dataset matters and the report named the wrong one.** `durableObjectsInvocationsAdaptiveGroups`
has no duration; **`durableObjectsPeriodicGroups`** carries `duration`, `activeTime`, `cpuTime`,
`rowsRead`, `rowsWritten` and `exceededMemoryErrors`, dimensioned by `objectId`. "GraphQL does not
expose duration" was an instrument error, not a platform limit. Ingestion lags ~8 minutes; an empty
result before then is not evidence.

**So every duration ceiling derived from `cpuTime` is a LOWER bound, and the gap is unbounded.**
cpuTime does not count time spent awaiting; this meter charges for it.

**Hibernation eligibility is the billing boundary, not hibernation itself.** Cloudflare bills an
object that is idle and UNABLE to hibernate, and does not bill one that is idle and eligible "even
before the runtime has hibernated them". The five disqualifying conditions are transcribed in
`src/ops/hibernation.ts` rather than paraphrased -- no `setTimeout`/`setInterval`, no in-progress
awaited `fetch()`, no standard WebSocket, no request still being processed, no outbound TCP socket
or WebSocket.

- **A PENDING ALARM IS NOT ON THAT LIST, and the probe confirms it**: the armed-alarm object accrued
  0.177 s over a 60 s pending window. The keep-warm chain costs a row and a DO request per arm and
  buys **no residency**. `keepWarmFleetCost()` prices it: 360 arms/day/site, and because the free DO
  quotas are ACCOUNT-WIDE, **277 sites saturate both meters with zero visitors**.
- **`connect()` IS on the list, and `src/ops/mail.ts:674` is the only place in `src/` that opens
  one.** An SMTP send makes the object non-hibernateable for the length of the send; the drain sends
  sequentially, so a batch holds it for the whole batch. `sendViaSmtp()` closes in a `finally`, so
  the 15-minute per-connection pin is the worst case rather than the normal one. Plain `fetch()`
  never keeps an object alive, even while its body streams.

## Never touch `vendor/`

It holds 14 hand-built php-wasm binaries, 198 MB, gitignored. They are not reproducible without a
Docker toolchain session. Never delete, move, or overwrite anything under it.

**It is no longer one-machine-only, and the prohibition stands anyway.** All 35 files are in the
`drupflare-cdn` R2 bucket under the same paths, verified by size and by ETag-against-md5:
`bun run backup:verify`. Restoring one is
`bunx wrangler r2 object get drupflare-cdn/<path> --remote --file=<path>`. A local delete is now
recoverable rather than permanent; it is still a mistake nobody needs to make.

## The PHP exists in TWO places, and the SIBLING REPO is the source of truth

1. the sibling repos `../drupflare` and `../rom`, published as `drupflare/drupflare` and
   `drupflare/rom` -- **edit here, always**
2. **`assets/driver.json`** - packed by `scripts/gen-driver-assets.ts`, and **this is the copy that
   executes on the edge**

Composer never runs on the edge, so the packed copy is what ships, and it has gone silently stale
twice. Run `bun run assets:driver` after ANY change in a sibling.

**`drupal/` IS GONE, and it was a third copy that drifted.** It held module-shaped copies of both
siblings, was untracked, and was what the packer read -- so the shipping bytes came from a directory
nothing kept in sync. Measured before deleting it: `CircuitBreaker.php` differed from the sibling,
and the test copies were 8 assertions behind (`test:health` gave 169 against the sibling's 177) with
nothing reporting it, because `driver-pack.spec.ts` guards the pack against its inputs and never the
inputs against upstream. `gen-driver-assets.ts` now reads `../drupflare` and `../rom` directly, the
way it already read `../stream-http` -- whose own comment had said why: "a fourth copy is what
created the drift".

A module REPO is not a module, so the packer takes an allow-list (`src`, `.info.yml`, `.install`,
`.module`, `.services.yml`); walking a checkout wholesale would pull `node_modules/`, `vendor/` and
`coverage/` into a 3 MiB bundle. The machine name comes from the MOUNT, not the directory: `../rom`
provides `cfw_do_sqlite`, so deriving it from the checkout would look for `rom.info.yml` and pack a
module with no info file. `DRUPFLARE_SRC` / `ROM_SRC` / `STREAM_HTTP_SRC` relocate the checkouts,
which is how CI points at `.siblings/*`.

**There was a sync check and deleting it was right.** `scripts/check-module-sync.ts` compared the
copies on every commit; it picked "newer" by MTIME, so after a prettier run in this repo it declared
the stale local copy newer than a sibling that held the real fix, and `sync:fix` would have
overwritten the fix with the stale text. There is nothing to sync now.

The guard that mattered survives where it belongs. `tests/node/driver-pack.spec.ts` asserts the pack
matches the modules on disk **byte for byte**, so a stale `assets/driver.json` still fails the gate.
What is deliberately no longer checked is `drupal/` against the siblings.

**A composer `require` ships NOTHING, and this is the same rule pointed at dependencies.** The
packed tree IS the vendor directory. `drupflare` requires `drupflare/stream-http` and its
`HttpsStreamWrapper` extends the packaged class, so the packer mounts `../stream-http/src` at
`libraries/drupflare-stream-http/src` and the PSR-4 root is registered in **both** autoloader sites
-- `SETTINGS_OVERRIDE` in `src/site-do.ts` and the boot fragment in `src/drupal/site-php.ts`.
Adding a dependency means all three steps; the manifest line alone is a fatal on a missing class.
It is read from the sibling rather than copied under `drupal/`, because a fourth copy is what
created the drift the subclass removed.

## Do not "regenerate the pack" to change the database

`assets/drupal/site.sqlite` (6.6 MB) is **hand-trimmed and nothing in this repo produces it.**
`pack-sql.ts` only consumes it; `pack-perfile.ts` never touches sqlite. The build input
`drupal-src/sites/default/files/.sqlite` is 14.4 MB, so a trim happened whose recipe is written down
nowhere.

To add or change a row, be **surgical**: read it out of the build input and insert it into
`site.sqlite`, then re-run `bun run assets:sql`. Running `bun run assets:pack` to do it would balloon
the artifact toward 14.4 MB and silently discard the trim, against a 3 MB gzipped bundle ceiling.

When copying a cache row between databases, verify `expire = -1` and that **both** databases carry
identical `cachetags` - a `checksum` that disagrees with the destination's tags means the row is
present but rejected, so the cost it was meant to remove is still paid and nothing looks wrong. See
the provenance section in `TECHNICAL_REPORT.md`.

## The gate and production reach the SAME interpreter by two different routes

`wrangler.jsonc` aliases `./runtime/php-binary.js` to the zstd 8.5 seam. **Vite does not apply that
alias**, so for the whole life of the project the test lane resolved the DEFAULT seam and ran PHP
**8.3** from `vendor/static-free-v1`, an experiment arm, while production ran 8.5. Every dev machine
has `vendor/`, so it was invisible until a clean checkout had neither.

**The zstd seam cannot be used by the gate, and this is a platform limit rather than a preference.**
`php-binary-85.ts` inflates and calls `new WebAssembly.Module` at module scope, which is correct in
production because workerd permits codegen at worker STARTUP -- but a vitest spec is evaluated inside
a fetch handler, so module scope there is REQUEST time and workerd answers `inflate.codegen-disallowed`.
Measured by pointing the seam at it: every workers spec fails to load.

So `vitest.config.ts` aliases the seam's two imports to the **raw** `.interp/php8.5.wasm` +
`php8.5-worker.mjs`. A `.wasm` import arrives pre-compiled through the `CompiledWasm` rule and needs
no runtime codegen. It costs 12,218,393 bytes, which is why it is a TEST path and never a shipping
one. The gate now executes the interpreter that actually ships.

**What that immediately caught**, both invisible while the gate ran 8.3: a hardcoded `< 80 MB` heap
assertion that 8.5 fails at 96 MB (now compared against a fresh run of the same build), and
`HEAP_CEILING` at 100 MB when an install on 8.5 peaks at **115 MB** -- which agrees with the
~110.6 MB measured on a deployed worker. The 8.5 opcache startup abort shipped undetected for
exactly this reason and had to be caught on a throwaway deploy.

## An artifact a clean checkout cannot build is a lane boundary, not a failure

`bun install` runs `scripts/restore-artifacts.ts`, which pulls the interpreter from the public CDN,
**verifies sha256 against `cdn-manifest.json`**, and skips anything already current. No credential --
the bucket is fronted by a custom domain, the same property that lets `backup:verify` run from CI.
It never fails the install; offline you get a stub and a printed list of what was skipped.
`DRUPFLARE_SKIP_RESTORE=1` opts out.

**The pack cannot be restored that way.** `assets/drupal-pf` and `assets/drupal-sql` need a native
PHP Drupal bake plus `assets/drupal/site.sqlite`, whose trim recipe is written down nowhere, so they
arrive only in a published release payload via `bun run hydrate`. Until one exists,
`ARTIFACT_SPECS` in `vitest.config.ts` -- **19 files, measured from CI, never guessed** -- is
excluded and the lane prints what it dropped. **Count it, do not quote it**: this line said 15 while
the list held 17, and the "51 files / 1,521 tests still run" that used to follow moved with it and
was never re-measured. The lane prints both numbers when it skips.

Same rule for `.github/workflows/interpreter.yml`: it prices a new interpreter against the tree that
ships, so with no release it now **fetches, verifies and pins anyway** and skips only the pricing.
An explicitly named `payload_tag` that does not exist is still a hard error.

**A COUNT TAKEN THROUGH THIS BOUNDARY MEASURES THE MACHINE, NOT THE REPOSITORY.** `vitest list`
honours the exclusion, so the Class A `tests.cases.workers` metric read 1,862 in CI against 2,066 on
a checkout that has the pack -- and it held still only because the list did. The commit that added
two files to it was reported as deleting 21 tests. `DRUPFLARE_LIST_ALL=1` collects the excluded
specs without running them, which is what the collector now passes; `tests/node/metrics.spec.ts`
evaluates the config from a directory with no artifacts, both ways, so the control is what makes the
assertion mean anything.

## A passing test does not mean anything calls it

`src/ops/supervisor.ts` -- 11 tripwires, the health ledger, the circuit breaker,
`quarantineDecision()` -- was imported by `tests/unit/ops/supervisor.spec.ts` and by **nothing under
`src/`**. It was green on every commit and absent from every deployed site. `repair_state` was read
by the quarantine branch in `alarm()` and **written by nobody**, so L4 and L5 were not unbuilt; they
were unreachable by construction, and the README said "Not built" when the truth was "built, tested,
wired to nothing".

`bun run check:reachability` walks imports from the wrangler `main` and classifies every module as
`edge` / `probe` / `script` / `dead`; `tests/node/reachability.spec.ts` fails on a new dead module
**and** on a stale exemption. Probes are correct to be unreachable -- each is its own entrypoint --
which is why the scan separates them rather than counting 45 problems to hide 5.

It also reports exports that only tests mention. That is usually the legitimate
"exported for its unit test" pattern, but it is how `readHeapSnapshot` and `elideZeroPages` were
found still passing their tests after the writer stopped calling them.

**`src/ops/tail-worker.ts` and `src/drupal/capabilities.ts` were the two known-dead modules and both
have since been DELETED.** This paragraph named them as permanently exempt, which stopped being true
without anyone editing it -- so do not go looking for either file. What caught the removal was the
spec's stale-exemption half: it failed with both names the moment the files went. That direction is
the one that is easy to get wrong, because an allow-list nobody prunes is how the next dead module
gets waved through.

The five entries on the list today are all legitimately off the edge: `src/ops/dormancy.ts` and
`src/ops/module-table.ts` are build-lane tools driven by their own vitest specs, and
`src/runtime/php-binary-{jspi,o2,zstd}.ts` are alias targets reached through a wrangler `alias`
rather than through an import. The list may shrink without ceremony; **adding to it is the thing to
think twice about**, because an entry is a promise the module is reached some other way rather than a
way to silence the check.

## Commands

```sh
bun run test      # vitest: --project=workers --project=node
bun run typecheck # tsc --noEmit
bunx prettier --check .
bun run assets:driver      # repack after ANY change in a sibling
bun run test:health        # the sibling's health suite, 633 PHP assertions
bun run check:reachability # which modules the edge imports; which are dead

bun run hydrate         # a clean checkout -> deployable, from the release payload
bun run release:payload # build that payload; needs vendor/ and the packs
bun run release:check   # dry-run the canonical config and price it against the 3 MiB ceiling
bun run build:wasm      # the zstd decoder (docker) and the interpreter (gh auth) into .interp/
bun run backup:verify   # 40 CDN keys, no credentials
```

**`backup:verify` fails on Gregory's home network and that is not a defect.** The bucket is fronted
by `drupflare-cdn.gmitch215.dev`, and the network blocklists `*.dev`, so it answers
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Run it behind a VPN or from CI. Do not debug the script, and do
not conclude anything about the bucket's contents from a failure with that error.

`docs/building-from-source.md` is the release and build procedure; `docs/configuration.md` is every
var and binding; `docs/repository-layout.md` says how every path arrives
on a clean clone. The gate's own limit is written down there too: a clean checkout cannot build
`assets/drupal-pf`, `assets/drupal-sql` or `.interp/`, so the specs that assert them run in the
release lane, which hydrates the payload first and sets `REQUIRE_ARTIFACTS=1`.

Three vitest projects exist because workerd cannot do `node:child_process` or `node:fs`: `workers`
runs in workerd, `node` runs what needs a real PHP binary or filesystem, `e2e` needs a server and is
excluded from `bun run test` on purpose.

PHP suites live in the siblings, and **they are the authority on their own module** -- what ships is
`assets/driver.json`, packed from those same checkouts, and nothing tests the pack's PHP directly.

| suite                                                            | repo           | assertions |
| ---------------------------------------------------------------- | -------------- | ---------- |
| `php tests/health-suite.php`                                     | `../drupflare` | 633        |
| `php tests/cfw-tcp.php`                                          | `../drupflare` | 27         |
| `php tests/solarium-transport.php`                               | `../drupflare` | 17         |
| `DRUPAL_ROOT=<worker>/drupal-src php tests/load-classes.php`     | `../drupflare` | 95         |
| `DRUPAL_ROOT=<worker>/drupal-src php tests/run-driver-suite.php` | `../rom`       | 238        |
| `DRUPAL_ROOT=<worker>/drupal-src php tests/run-installer.php`    | `../rom`       | 16         |
| `DRUPAL_ROOT=<worker>/drupal-src php tests/pdo-shim.php`         | `../rom`       | 61         |

`run-installer.php` drives Drupal's own installer against the driver with core's sqlite driver as a
child-process control. It needs a real filesystem, so it is sibling-only and has no counterpart
here.

**This repo's gate checks the siblings out with no `composer install`.** A suite or fixture that
needs `drupal/core` must therefore search `../../drupal-src/vendor/autoload.php` as well as its own
`vendor/`, and supply `Drupal\drupflare\` itself, since only composer's autoloader maps it.
`health-suite.php` searches both; a hardcoded path in `tests/fixtures/renamed-form-state.php` did
not, and failed three assertions here while passing in its own repo.

**Re-measure these counts before quoting them.** Every number in this table has been stale at least
once, in both directions, and a count copied forward from a previous session is not a measurement.

## Formatting: prettier owns layout, phpcs owns meaning

PHP is formatted by `@prettier/plugin-php` at the house style - **TABS rendered 4 wide, 100-char
lines** - the same as every other language here, NOT 2-space Drupal layout. The `.prettierrc`
override that forced `useTabs: false, tabWidth: 2` on PHP was wrong and was corrected on 2026-08-12;
the PHP override now carries only `parser: php`. YAML keeps its space override because tabs are
invalid YAML, which is the only kind of reason that justifies one.

phpcs cannot also be right about layout, so each sibling's `phpcs.xml.dist` excludes the whitespace,
brace-position and casing sniffs with the reasoning inline, and keeps everything semantic.
**`Drupal.Arrays.Array.ArrayIndentation` is now excluded**, reversing what this file used to say:
under tabs it asserts "parent indent + 2 spaces" against a file with no indent spaces, so it can
never pass and carries no signal.

Constants are lowercase `true`/`false`/`null`, following mantle2 (1,276 lowercase vs 1 uppercase),
not Drupal core's legacy style.

A malformed `phpcs.xml.dist` **fails silently and reports a fake pass**. Verify a ruleset change by
loading it. `--` inside an XML comment is invalid.

## The binary ships pre-compressed, and that is why the size levers are no longer urgent

**The interpreter travels as a zstd frame in a `Data` module and is inflated at module scope**, so
Cloudflare's gzip measures bytes it cannot compress further. On 2026-08-21 the shipping bundle is
**2,925,701**, **220,027 under the 3,145,728 ceiling** (2026-08-23); the interpreter alone is 2,658,002 with
nothing dropped.

**Do not quote that number, run `bun run release:check`.** It has now been stale in THREE documents
simultaneously -- this file said 2,885,427, `README.md` said 2,881,567 and `TECHNICAL_REPORT.md` said
2,885,427, none of which was what the tool printed. The bundle moves whenever `src/` does, so any
figure written down here is a snapshot with a decay rate, and the three disagreeing copies were
harder to notice than one wrong one.

Consequences for anyone scoring a proposal here:

- **Do not reason about the ceiling from a `gzip` figure on a `.wasm`.** The relevant compressor is
  zstd, and the authority is what `wrangler deploy` prints.
- **The scarce resource moved from bundle bytes to startup CPU, and that is now largely paid.** The
  inflate was ~257 ms of a 1,000 ms startup budget (`CompiledWasm` was 8 ms) and it is NOT billed to
  request cpuTime. A wasm zstd decoder imported as `CompiledWasm` took the startup to a median of
  **112 ms (n=5)** for 25,569 bundle bytes; `bun run pack:decoder` builds it. What remains is the
  interpreter's own compile, so **there is no large startup lever left**.
- **Dropping extensions is no longer worth it.** It buys bytes that are not scarce and ~10-25 ms of
  inflate that the decoder already returned tenfold, while costing capability and needing shims. The
  trimmed rcs in `phasm` are measurement artifacts, not shipping candidates.
- **8.4 is a dead end: it costs 49,220 MORE compressed bytes than 8.5** while being 357,323 smaller
  raw, because its data section is both larger and less compressible (0.370 against 0.331; the code
  sections compress identically). Zero of the 73 packages in the shipped lock exclude 8.5. Go
  8.3 -> 8.5.
- **`WebAssembly.Module` must be constructed at MODULE SCOPE.** workerd allows startup codegen and
  forbids it at request time, which is also why the binary cannot live on the asset layer.
- The lexbor surgery is **off the list**: it traded `Dom\HTMLDocument` for a ceiling that is no
  longer binding.

`@drupflare/cartridge/inflate` owns the mechanism (`wasmModuleFromZstd`); `bun run pack:wasm`
rebuilds the frame from `vendor/`. **`.interp/` is gitignored, so a fresh clone must run
`bun run build:wasm` or `bun run hydrate`.** It used to be `build/wasm/`; the output moved out of
`build/`, which is a stale pre-split copy of `phasm` (see `docs/repository-layout.md`).

**The `.js` in `import ... from './runtime/php-binary.js'` is load-bearing.** `wrangler.jsonc`
aliases that exact specifier, so an extensionless form resolves the DEFAULT seam instead and bundles
`vendor/static-free-v1` -- measured at 3,856,138 gzipped bytes, 710,410 over the ceiling, with
nothing failing but the size. `tests/unit/runtime/route-gate.spec.ts` now compares the alias key to
what `src/site-do.ts` imports.

## What to optimise now that free is functionally equivalent to paid

The recompression removed the constraint that shaped every earlier decision, so the ordering changed.
Three rules replace "score it against the free envelope and stop".

**R2 ABSORPTION IS 0 WITHOUT A CACHE RULE AND ~7/8 WITH ONE, measured 2026-08-21 -- and the first
measurement of it was wrong twice.** `curl -I` sends HEAD, Cloudflare does not fill its cache from a
HEAD, so every reading came back `DYNAMIC` and produced "R2 custom domains do not cache". With GET
and a Cache Rule the A/B is clean: rule ON gives MISS then 7/7 HIT, rule OFF gives MISS then 7/7
DYNAMIC, cold object both times. **Use GET when measuring cache behaviour.** The same pass also
claimed the rule needs account-scoped `Account Rulesets: Edit`; measured, a zone-scoped
`Zone > Cache Rules > Edit` alone creates it, so the privilege objection that had rejected this lever
does not stand.

Absorption is **not a constant**: every PoP fills independently, so it is a function of
reads-per-colo-per-TTL-window. `cdnAbsorption` stays 0 as the model default because that is the
correct floor for a low-traffic site and for any site with no rule; report anything derived from it
as a range.

**The off-Worker lever has a MAXIMUM, not a limit.** Once R2's read meter binds, moving more traffic
off the Worker spends a 333,333/day meter faster to save a 100,000/day one. Modelled on the default
mix: **77% off-Worker peaks at 432,900 views/day (4.33x); 99% falls back to 336,700 (3.37x)**. A page
mirror that mirrors everything gives up 22% of the ceiling it exists to buy, so compute the optimum
rather than maximising. `cdnAbsorption` in `free-envelope.ts` is explicit and defaults to 0 because
nobody has measured the hit ratio in front of an R2 custom domain.

**An index is a write multiplier, not a read optimisation.** Under this billing model every index on a
hot table is another charged row per insert, and `rows written` binds the regeneration ceiling. ~60% of
a router rebuild is index maintenance; `router_alias` is 96% NULL and charged on all 419 routes every
rebuild. `amplification()` and `overheadShare()` in `src/db/write-tally.ts` report charged rows per
statement per table, exposed on `/writes` -- **measure the index share before touching a schema**, and
read `overheadShare` as an upper bound, since a multi-row statement also charges more rows than
statements. A factor of 1.0 on a hot table means there is nothing to win there.

**Render CPU is now worth optimising, and the targets are not where anyone assumed.** Free scored it at
zero because CPU never bound. The bucket attribution says event dispatch is the most expensive at 3.0 ms
across only **7** dispatches (4.3x native -- Symfony listener resolution, not rendering), `cache_contexts`
is second at 73 calls/render (5.8x), and the renderer itself is the _cheapest_ at 1.6x. The top two have
never been touched.

**OPCACHE IS OFF, and the file cache it used to write was pure cost.** Measured per arm, boot plus
one fill: `file` (what shipped) wrote 2,346 `.bin` files and 32,141,312 bytes into MEMFS while
`opcache_get_status()` reported opcache DISABLED -- `file_cache_only=1` turns the shared-memory
backend off, which is what that API answers about. `shm` genuinely accelerates (2,346 cached scripts,
zero filesystem writes) and puts its arena in linear memory, reaching 191.25 MiB against a 128 MiB
cap, so it cannot ship. `off` renders within 1 ms of `file` at n=5 and frees 5,046,272 bytes of
linear memory plus 32,141,312 of MEMFS. `OPCACHE_MODE` is the seam and is KV-overridable.

**Still do not do**: boot micro-optimisation below the heap snapshot. `-O3`, PGO and
`ZEND_VM_KIND=SWITCH` are a few percent of a once-per-object cost, and SWITCH was measured at
**+129,760 gzipped bytes** -- it costs bytes. Spend headroom on keeping lexbor.

**"Spend headroom on real mbstring" used to be the sentence above and it was UNFOLLOWABLE**, which is
the failure mode this file warns about elsewhere: mbstring is +586,648 gz against ~222,000 of
headroom, so it is 2.6x a budget it was being recommended out of. Nobody could have obeyed it.

What replaced it is measured rather than argued. `bun run measure:mb-parity` runs the shipping
polyfill stack against the real extension as the oracle, and a full sweep now runs the whole
codepoint space rather than a 1,232-case sample:

| measurement                             | before | after |
| --------------------------------------- | ------ | ----- |
| the original 1,232 cases                | 77     | 37    |
| Drupal core's exposure within them      | 33     | **0** |
| `mb_strtolower` over 1,112,064 scalars  | 95     | 0     |
| `mb_strtoupper` over 1,112,064 scalars  | 95     | 0     |
| `mb_convert_case` titlecase, same space | 273    | 0     |
| `mb_strwidth`, same space               | 9,733  | 0     |

**The scalar space is 1,112,064, not 194,528**, which this file and the backlog both had wrong:
`0x110000` minus 2,048 surrogates. The tables are generated FROM mbstring and live in
`../drupflare/src/unicode-tables.php` on the asset layer -- +1,034 gz there against +4,690 inlined
into the bundle. `tests/unit/drupal/unicode-workerd.spec.ts` runs the casing sweep inside workerd on
every commit as a vintage control.

The 37 that remain are all invalid-byte input to `mb_str_split`, `mb_lcfirst`, `mb_trim` and
`mb_str_pad`, none reachable from core, and they are NOT closed by sanitising harder -- measured,
that regresses 19 cases that pass today. What survives is reproducing mbstring's error-marker model.

**A TextDecoder bridge for legacy charsets is REFUTED, not deferred.** The premise was that workerd
decodes 23 labels the polyfill refuses; measured, the polyfill decodes `Shift_JIS`, `CP936`, `CP950`
and `CP949` from its own 55 charmaps and refused `SJIS`, `GBK`, `BIG5` and `EUC-KR` only because four
ALIASES were missing. Six alias entries closed 35 of 70 decode cases. A host bridge would have
replaced working charmaps with a dependency.

**ARGON2 SHIPPED, and the memory objection was true of one mechanism and not of the objective.**
What was closed is a 64 MiB arena INSIDE PHP's linear memory, where `memory.grow` has no inverse so
the first hash raises that object's floor for life. What was not closed is argon2id: OWASP's floor is
m=19456 KiB (19 MiB), not 64, and a HOST-side arena is garbage-collected. Measured on a deployed
throwaway with every OS page touched, 19 MiB of transient JS allocation coexists with a 117 MiB wasm
heap, ten times consecutively. `src/drupal/argon2-fix.ts` is the bridge, `CfwPassword` in the sibling
decorates Drupal's `password` service, the RFC 9106 vector passes, and `ARGON2` is off by default
because enabling it rehashes every account at its owner's next login.

Two traps that cost real time there. `password_hash()` is a BUILT-IN, so the conditional-declaration
pattern `curl-fix` and `openssl-fix` use can never bind -- Drupal's service is the only seam. And
`new Definition()` is PRIVATE by default in Symfony while Drupal's dumper drops private services from
the public map, so a decorator without `setPublic(true)` fails 45 specs with
`ServiceNotFoundException: password`.

**wasm64 RUNS, `PHP_INT_SIZE` IS 8, AND WHAT STOPS IT IS NOT MEMORY.** This paragraph has been
wrong twice: first "still blocked by memory, do not re-price it against the bundle", then "blocked by
vrzno". phasm run 32690008621 built it; at `--ultra -22` it is **2,720,787 against wasm32's
2,659,563, so +61,224 zstd bytes into 220,027 of headroom**.

`DRUPFLARE_ABI=wasm64` in `vitest.config.ts` points the gate's seam at
`.interp/php8.5-wasm64.{wasm,-worker.mjs}`, which is how each wall was found in turn:

- emscripten's `toIndexType` probes with `new WebAssembly.Memory({initial:1n,index:"i64"})`, which
  **workerd refuses**, so it degrades to the identity and every `wasmTable.get()` throws. Replacing
  that IIFE with `i=>BigInt(i)` gets past it -- a glue edit, no rebuild, the growth-step lever again.
- **vrzno was not LP64-clean, and `phasm/src/patch-vrzno-lp64.{sh,mjs}` fixes it.** 60 `Module.ccall`
  sites retyped in BOTH directions -- the argument half throws, the return half hands back a raw
  BigInt that never matches a Number `Map` key, so it is silently wrong rather than loud. Plus 85
  `EM_ASM` argument bindings coerced: `readEmAsmArgs` reads `p` as a Number but `j` as a BigInt, and
  under LP64 every `size_t` / `zend_long` / `off_t` becomes `j`. Checking only the pointer case said
  EM_ASM was unaffected.
- **emscripten's `growMemory` passes a Number to `wasmMemory.grow` and a bare `catch(e){}` eats the
  throw**, so EVERY grow fails silently, `_emscripten_resize_heap` gives up after four retries, PHP's
  allocator gets NULL and the process exits(1) with nothing on stderr and no `onAbort`.
  `phasm/src/patch-lp64-glue.mjs` fixes it and the `toIndexType` probe together, POST-BUILD, because
  the glue is emitted at link time.

**THAT DEFECT IS WHY A WASM64 HEAP LOOKED LIKE IT NEVER GREW**, and a whole pass concluded "the
blocker is not memory" from a flat reading produced by broken memory. Two other readings died with
it: `memory_limit` 96M -> 256M changed nothing because the limit was never reached, and `?all=1`
looked like the culprit because chunking only postponed the first grow.

**IT FITS, at the shipping growth step of 0.05:**

| workload     | wasm32     | wasm64     | delta      | headroom to 128 MiB |
| ------------ | ---------- | ---------- | ---------- | ------------------- |
| booted idle  | 96.00 MiB  | 96.00 MiB  | +0.00      | 32.00               |
| render       | 96.00 MiB  | 106.00 MiB | +10.00     | 22.00               |
| install peak | 100.81 MiB | 117.06 MiB | +16.25     | 10.94               |
| auth peak    | 105.88 MiB | 123.00 MiB | **+17.12** | **5.00**            |

+16.2% blended, under the +20.9% break-even. **At emscripten's DEFAULT step of 0.20 it does NOT
fit** -- 138.44 MiB on both the install and auth arms. The step is a glue literal, so an unpatched
wasm64 build measures a different growth policy from the one that ships.

5.00 MiB of margin is thin, so whether to ship it is a product call rather than a measurement; P28
buys the same `PHP_INT_SIZE` 8 on wasm32 for a fraction of the memory.

**`INITIAL_MEMORY` IS NOT THAT GATE, and this sentence used to say it was.** The heap starts at
100,663,296; where it PEAKS is set by `MEMORY_GROWTH_GEOMETRIC_STEP`.

**THE STEP IS NOT A LINK-TIME SETTING AND NEEDS NO PHASM REBUILD.** Emscripten emits it into
`_emscripten_resize_heap` as the JavaScript literal `.2`; the `.wasm` carries no growth policy at
all. `scripts/measure/growth-glue.ts` re-emits the glue at any step and `growth-ladder.ts` drives the
arms -- one binary, N variants.

**THE SHIPPING STEP IS 0.05, NOT EMSCRIPTEN'S 0.20**, since 2026-08-23. `restore-artifacts.ts`
emits the tuned glue AFTER verifying the pristine download against `cdn-manifest.json` (a hash that
covered a locally-rewritten file would guarantee nothing), `src/runtime/php-binary-85.ts` imports
`.interp/php8.5-worker.tuned.mjs`, and `vitest.config.ts` emits the same file when it is missing so
the GATE cannot run a different growth policy from production -- that divergence has happened at this
exact seam before.

**SCORE A STEP AGAINST THE AUTHENTICATED RENDER, WHICH IS THE BINDING WORKLOAD.** Measured with
opcache off, which is what ships:

| step | render MiB | install MiB | auth MiB | worst  | headroom to 128 MiB | grow events |
| ---- | ---------- | ----------- | -------- | ------ | ------------------- | ----------- |
| 0.20 | 96.00      | 115.25      | 115.25   | 115.25 | 12.75               | 1           |
| 0.10 | 96.00      | 105.63      | 105.63   | 105.63 | 22.38               | 1           |
| 0.05 | 96.00      | 100.81      | 105.88   | 105.88 | 22.13               | 2           |
| 0.01 | 96.00      | 97.00       | 103.13   | 103.13 | 24.88               | ~7          |
| 0    | 96.00      | 96.69       | 102.56   | 102.56 | 25.44               | many        |

Read the render column alone and every arm is identical; read install-and-render and the answer is
"worth about 1%". The AUTH column is where the peak lives, and it did not exist until 2026-08-23.
0.05 rather than 0.01 or 0 because those buy 2.75 and 3.31 MiB more while a grow event COPIES the
heap. Grow counts are derived from the series, not counted -- RULE 0 forbids reading the CPU off a
local clock.

**A RENDER NO LONGER GROWS THE HEAP AT ALL**, on any arm. That is P30 rather than P16: opcache's
compile-time working set was ~5 MiB of a render and **19 MiB of an install**, and none of it is spent
now. `enable-memory.spec.ts` asserted 15-35 MB of growth for an enable and now asserts none.

**AND THE FIRST VERSION OF THAT TABLE DID NOT SURVIVE ITS OWN RE-MEASUREMENT.** Taken with opcache
still on, it read 138.31 MiB for the authenticated arm at 0.20 and concluded emscripten's default
"does not fit inside the isolate AT ALL". True of that build, false of the one that ships. Two
changes landed in one session and each was first measured against a tree the other had not touched.
Neither is worth its own headline alone.

**AND THE BUILD IS NOT "ONE GROWTH EVENT FROM OOM", which is what this file used to say.** The same
arithmetic read to its end refutes it: `getHeapMax()` returns 4,294,901,760, so the module declares no
maximum and the 128 MiB ceiling is workerd's, enforced by `grow()` THROWING. Emscripten catches that
and retries -- `for (cutDown = 1; cutDown <= 4; cutDown *= 2)` gives 145,031,168, then 132,972,544,
then 126,943,232, and the third fits. A growth from the shipping peak DEGRADES; it does not abort.

**`PHP_INT_SIZE` 8 is not available at a discount either.** `zend_ulong` is typedef'd from
`zend_long`, and both `Bucket` and `zend_string` carry a `zend_ulong h`. Modelled against the wasm32
ABI with a real compiler, forcing `ZEND_ENABLE_ZVAL_LONG64` leaves `zval` at 16 and takes `Bucket`
from 24 to 32 -- exactly wasm64's 33%. Widening EITHER the hash or the pointer alone produces 32, so
there is no arrangement that keeps `Bucket` at 24.

**One refinement measured today**: a cold object refuses an inline render because `!this.php`, not
because of a budget -- raising `RENDER_BUDGET_MS` from 2,000 to 25,000 did not move it. So
"render inline on MISS" on a cold object is **boot-dominated at ~1.4 s**, not 34 ms. Still the largest
latency win available; price it honestly.

## Two capability seams landed on 2026-08-23 and both have a trap worth reading

**WIDE INTEGERS ARE READ EXACTLY NOW, and it took no SQL parser.** `ctx.storage.sql` still hands
INTEGERs back as JS doubles -- re-measured, `9007199254740993` arrives as `...992` -- so the read is
lossy and the storage is not. The backlog scoped the fix as a schema-aware rewrite of `SELECT id`
and then listed the shapes such a rewrite must survive, which is a parser. Unnecessary: the RESULT
ROWS already carry the output column names, so `src/db/wide-integers.ts` re-runs the original
statement wrapped as a subquery with those names cast to TEXT. `SELECT *`, aliases, JOINs,
aggregates, `UNION` and bound parameters are covered by CONSTRUCTION rather than by enumeration, and
each is asserted. Triggered by DETECTION, so a site storing no wide integers pays nothing; `WITH`,
`PRAGMA` and non-SELECT are refused and keep the value they already had.

**AUTHENTICATED SHELLS ARE HARVESTABLE ON DEMAND, and the constraint that said otherwise was an
artifact of the arm that measured it.** `shell-derivation.spec.ts` reported that only the FIRST
authenticated render in an interpreter carries BigPipe placeholders. It emptied no cache bins, so
render two answered from `dynamic_page_cache`. **The gate is the `render` bin**: empty
`dynamic_page_cache` alone and every persona comes back holeless with the placeholders substituted
inline, which reads as "this page has no shell"; empty `render` too and every persona comes back
holed, repeatably.

The authorisation is BYTE EQUALITY, not a marker list. Two different members of one role set are
normalised and required to be byte-identical; anything person-varying the pattern list missed makes
them differ and the harvest refuses. Measured, exactly four classes vary: the uid in drupalSettings
and in BigPipe's appended scripts, `/user/logout?token=`, `data-contextual-token=`, and views'
`js-view-dom-id-` nonce. `permissionsHash` does NOT vary between two members and DOES vary by role,
which is what keys a shell to a role set.

A fragment render costs 4-5 ms against 20-22 for the render it replaces, gate-lane wall clock, ratio
only. The recipe is captured at harvest and replayed -- core never decodes a placeholder id back into
a render array, so there is no parser to call, and that is also the security property: a visitor's
input never becomes a `#lazy_builder`.

## Outbound has THREE tiers, and the third one cannot have the shape it was asked for

**`cfw_tcp_connect()` / `read()` / `write()` / `close()` CANNOT EXIST here.** `Host::call()` is
`$reply = $invoke($json)` and the wasm stack cannot suspend without JSPI, so a `read()` that blocks
for bytes that have not arrived has nowhere to block. That closes the SESSION mechanism, not the
objective. What ships instead (`src/ops/tcp.ts`, 2026-08-24) is a DECLARED exchange: PHP names a
whole operation, the host runs it in JavaScript between invocations over edgeport, and the answer is
read on a later one -- the same cached -> deferred -> sync layering `cfwFetch` lives under, with the
sync tier absent for the same reason.

- **It shares the HTTP queue, cache and retry budget on purpose.** A `tcp+redis://` row goes in
  `cfw_http_queue` and `drainHttpQueue()` dispatches on the scheme. Dedup, TTL, `attemptBudget()` and
  the resubmit plan are already correct there, and a second queue is a second place for them to drift.
  A Redis read borrows the GET budget, everything else the POST one -- a replayed `INCR` is a
  different outcome, not a slower success.
- **The ENDPOINT is the operator's, never the caller's.** `REDIS_URL` / `SYSLOG_URL` carry the host,
  port and credentials; PHP supplies only the operation. Arbitrary `host:port` TCP behind anything
  that can call a host function is a port scanner and a protocol-smuggling surface, which is strictly
  wider than the HTTP tier's SSRF because it is not confined to HTTP semantics. Both vars are
  therefore secrets and neither may join `KV_OVERRIDABLE`; `kv-levers.spec.ts` asserts it.
- **A Redis CACHE BACKEND cannot be built on this**, and it is worth saying where someone would try:
  a cache get has to answer inside the request that asked and a deferred exchange always misses the
  first time. `drupal/redis` stays refused and that is the right answer -- the DO's own SQLite is the
  backend. What the tier reaches is the deferrable half, and `syslog` with no compromise at all,
  because syslog over TCP never replies.
- **`drupal/smtp` installs here and its socket never runs**, so a site that configured its relay had
  a complete SMTP setup nothing read. `CfwMail` now passes `smtp.settings` and `mailEnvFromSite()`
  maps it onto the transport vars, with the deployment's own vars winning every field they set. The
  settings are persisted to `cfw_meta` because **the ALARM re-resolves the transport and never sees
  the message** -- merging only at `cfwMail` time resolves one transport at commit and dials another
  on the drain.

## Tier B: the exchange that must happen OUTSIDE PHP

**`WITH_OPENSSL=0`, so the interpreter cannot verify an RS256 `id_token` at all.** That is the whole
argument for the OIDC tier and it does not rest on a module count or a millisecond: a JSPI build that
let PHP fetch the token endpoint synchronously would hand PHP a token it still could not check, and
an unverified `id_token` is an unauthenticated login. The host has `crypto.subtle`. So host-side
pre-exchange is not the cheap route to `openid_connect`, it is the only one -- and that is what
closed P13 (C112) rather than the module count.

`src/ops/oidc.ts` owns discovery, PKCE, state, the token exchange and the signature check;
`/__oidc` starts and completes; `cfwOidcClaims` hands PHP a decided result synchronously, because
the awaiting already happened at a route the host owns.

- **The claims never travel in a URL.** The browser carries a single-use ticket, the row is deleted
  before the claims are returned, and a replay finds nothing. A redirect lands in browser history,
  in a referrer and in every proxy log on the path, so single-use is the property that matters and a
  TTL only narrows the window.
- **Five refusals, each silent if it is missing**: a signature from a key outside the JWKS, a foreign
  issuer, an audience belonging to another client of the same provider (the confused deputy, and the
  one that looks most valid), an expired token, and a nonce from another login. `none` and the HMAC
  families are refused by omission, and `alg` is taken from the KEY -- trusting the header is how the
  RS256-to-HS256 confusion attack works.
- **The authmap key is scoped by ISSUER**, not by `sub` alone: a subject is unique within one
  provider and says nothing across providers, so keying on it alone would let a subject from a
  newly-configured issuer take over an existing account.
- **`oidc_issuer` lives in `cfw_meta` and the secret is a binding; neither may join
  `KV_OVERRIDABLE`.** A KV writer who could set the issuer would point the consent screen at a
  provider they control, and every login on the site would authenticate against it -- the same
  reasoning that keeps `CF_OAUTH_CLIENT_ID` off that list.
- **It has never seen a real IdP.** 25 assertions on generated `crypto.subtle` keys and 8 on the
  authmap scoping; the round trip is unexercised and there is no setup UI yet.

## A lever is offered through KV FIRST, then a var

**Standing convention, 2026-08-18.** Anything you offer as a knob is offered through KV before it is
offered as a `vars` entry, so an operator can change it **without a redeploy**. The ladder is KV,
then the var, then whatever other fallbacks the reader already has. `resolveSettings()` and
`KV_OVERRIDABLE` in `src/ops/plan.ts` implement it, so adding a lever means adding a name to the
allow-list rather than building anything.

Apply it even where it looks inapplicable, and check before assuming it is. `locationHint` read like
a deploy-time property and is not: `DurableObjectNamespace.get()` takes it per call, so
`SITE_LOCATION_HINT` sits on the allow-list like everything else.

`KV_OVERRIDABLE` is a **privilege boundary, not tidiness.** KV is operator-writable, so nothing on it
may change what is REACHABLE - every entry's worst case is a slow site. `PW_DIAGNOSTICS` would reach
`/sql` and `/restore`; it, `SITE_ID` and `PLAN` are absent and a spec asserts they stay absent.
`CF_OAUTH_CLIENT_ID` fails the same test for a subtler reason and lives in `cfw_meta` instead: a KV
writer who could set it would point the consent screen at an application they control, and the
operator would approve it reading the attacker's name off Cloudflare's own page.

**THE CONVENTION WAS DECORATIVE FOR SEVEN OF ITS ELEVEN NAMES UNTIL 2026-08-21.** `withSettings()`
runs in `src/site.ts` against the FRONT worker's env, and the Durable Object gets its own copy of the
bindings - so `RENDER_BUDGET_MS`, `FILL_BATCH_SIZE`, `FILL_BATCH_WALL_MS`, `HTTP_DRAIN_LIMIT`,
`MIRROR_LIMIT`, `LAZY_FS_BUDGET_BYTES` and `PREFILL` were knobs nothing read. Every one had a passing
test of its RESOLVER, which is why nothing noticed: the resolvers were correct and were being handed
an env the override never touched. `adoptSettings()` now overlays all eleven, and is called from
`handle()` AND `alarm()` - four of the seven are read on the fill chain, which never passes through
`handle()`. The fast storage lane still adopts nothing and must not: it is await-free by
construction, and it reads no lever. `tests/integration/kv-levers.spec.ts` asserts the seam by NAME
COVERAGE, so a twelfth entry with no wiring fails rather than shipping.

## `supported` is not a state a module may be in

**Nothing is a support claim except a gated enable-and-assert run.** The module table has exactly
three states - `verified`, `untested`, `blocked` - and `verified` is reachable only by a test that
enabled the module against a real site and asserted an observable it owns.

`supported` used to exist and meant "the capability this module needs was measured WITHOUT the
module". That is an inference about the runtime, and it read to everyone else as a promise about the
module. Do not reintroduce it under another name: `tests/node/module-table.spec.ts` pins the state
set and fails on a rendered table containing the word at all.

## Platform limits that are measured, not guessed

Durable Object SQLite: **100 bound parameters** per statement, **50 bytes** for a LIKE/GLOB pattern,
**2,199,995 bytes** per record, **100,000 chars** of statement text, and integer reads are lossy
above 2^53. Each one broke something real. See DEEP DIVE B.

`workerd` blocks request-time wasm codegen, which is why the binary is instantiated the way it is.

Heap restore requires reproducing the **open file-descriptor table at the same fd numbers**. Inode
alignment does NOT matter - that was tested and falsified. Dropping `/dev/urandom`'s fd throws
`RandomException`; dropping the three sqlite fds gives a locking-protocol error **after an 80-120 s
stall**, which on the edge is a hung request.

## Conventions

- `bunx`, never `npx`.
- Imports use a `.js` specifier even for `.ts` files (`from './site-do.js'`). This is deliberate and
  matches what bun resolves; `node` cannot resolve it, which is why some scripts must run under bun.
- `src/probes/**` are frozen measurement instruments cited by figure in the report. Moving a file
  does not change what it measures; rewriting it might. Do not refactor them.
- `src/drupal/*-php.ts` are mostly `String.raw` blocks holding PHP source. A backtick inside a PHP
  comment truncates the block and breaks the PHP while leaving the JavaScript valid - this has
  happened twice. `tests/node/php-fragments.spec.ts` runs `php -l` over all of them; keep it green.
- **A shim over an INTERNAL PHP function does not need `eval()`.** `mb-fix.ts` wraps its
  declarations in one and `zlib-fix.ts` deliberately does not: a conditional function declaration is
  bound at runtime, not at compile time, so `if (!extension_loaded('zlib')) { function gzencode(){} }`
  compiles clean on a build that HAS the extension and the branch never runs. That matters for
  coverage rather than style - `php -l` sees INSIDE plain PHP and sees only a string literal inside
  an `eval`, which is why `ZLIB_FIX` is in the fragment gate and `MB_FIX` cannot be.
- `experiments/` is prettier-ignored on purpose: probe configs kept for reproduction, not maintained.
- Comments: lowercase, terse, one line, no trailing period, only where the WHY is non-obvious.

## Deploying, when authorized

The account has **real production workers**. Use a `cfw-*` name, tear down immediately, and verify
the worker list returns to exactly its prior baseline. A DO-namespace deploy needs ~60 s propagation
before `stub.fetch()` stops returning "Worker not found" - wait, do not debug it. Uploading the full
48 MB `assets/` tree fails; stage only what is needed.

`wrangler deploy --dry-run --outdir=<tmp>` does not deploy and is the only cheap way to prove an
entrypoint and its binary alias still resolve.
