# drupflare/worker

Drupal 11 running inside a Cloudflare Worker, with PHP 8.5 compiled to wasm and executed inside a
Durable Object. This repo is the deployable product; the reusable pieces live in sibling repos.

## RULE 0, above everything else

**An absolute CPU figure comes ONLY from `cpuTime` in `wrangler tail` on a DEPLOYED worker.**

In-PHP `microtime()` returns **0** on the edge, and `Date.now()` inside the isolate returns 0 or, worse,
a **plausible wrong number** - it has reported 114 ms for a 1,374 ms invocation. 0 is obviously broken;
114 survives review. A local `wrangler dev` wall clock cannot even ORDER two profiles correctly.

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
  worth ~1% until rows-per-fill falls. Rows work FIRST.
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
bun run test:health        # the sibling's health suite, 566 PHP assertions
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
| `php tests/health-suite.php`                                     | `../drupflare` | 566        |
| `DRUPAL_ROOT=<worker>/drupal-src php tests/load-classes.php`     | `../drupflare` | 94         |
| `DRUPAL_ROOT=<worker>/drupal-src php tests/run-driver-suite.php` | `../rom`       | 219        |
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
Cloudflare's gzip measures bytes it cannot compress further. On 2026-08-15 the shipping bundle is
**2,898,319**, **247,409 under the 3,145,728 ceiling**; the interpreter alone is 2,658,002 with
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

**Still do not do**: boot micro-optimisation below the heap snapshot. `-O3`, PGO and
`ZEND_VM_KIND=SWITCH` are a few percent of a once-per-object cost, and SWITCH was measured at
**+129,760 gzipped bytes** -- it costs bytes. Spend headroom on real mbstring (+586,648 gz, and it closes
the Greek final-sigma and emoji-width divergences outright) and on keeping lexbor.

**One refinement measured today**: a cold object refuses an inline render because `!this.php`, not
because of a budget -- raising `RENDER_BUDGET_MS` from 2,000 to 25,000 did not move it. So
"render inline on MISS" on a cold object is **boot-dominated at ~1.4 s**, not 34 ms. Still the largest
latency win available; price it honestly.

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
