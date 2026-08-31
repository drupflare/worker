# drupflare/worker

Drupal 11 running inside a Cloudflare Worker, with PHP 8.5 compiled to wasm and executed inside a
Durable Object. This repo is the deployable product; the reusable pieces live in sibling repos.

## How to Measure Anything Here

`TECHNICAL_REPORT.md` has a Measurement Rules section. Read it before producing a number. The two
that catch the most mistakes:

- **An absolute CPU figure comes only from `cpuTime` on a deployed worker.** The clock does not
  advance across a synchronous `php._run()`, so a duration taken from PHP's `microtime()` or from
  `Date.now()` AROUND ONE is wrong in a way that survives review.
  **NARROWED 2026-08-30, because the rule as written discarded a working instrument.** A `Date.now()`
  delta SPANNING I/O is usable: the clock updates on I/O completion, and an `x-worker-ms` delta
  bracketing `stub.fetch()` tracked the platform's own `wallTimeMs` to within 1 ms on every arm of a
  deployed run. So the rule is about deltas across synchronous PHP, not about `Date.now()` as such.
- **`cpuTime` is 1 ms granular**, so a reading of 1 ms is the meter's floor rather than a measurement
  of 1.0 ms. It bounds an invocation; it cannot resolve below itself. Amortise over many requests
  when the quantity is sub-millisecond.
- **State an n and a spread with every absolute.** The 400-600 ms bimodality this file used to assert
  as a standing property **did not reproduce** across 640 client-side requests on a continuously
  driven warm object: two samples exceeded their arm's median by more than 300 ms and both were
  attributable, one queued behind a 5,907 ms alarm and one a 4,284 ms render. It may be a property of
  cold or first invocations; as a general claim it is unverified, so re-observe it before designing
  around it.

## Scoring a Proposal

Free's limits are aggregate daily budgets, not the 10 ms per-invocation cap. There are two ceilings:
serving is bound by Worker requests at 100,000/day, regeneration by rows written at 10,869/day
windowed and 2,777 on the alarm chain -- so regeneration is the tighter one by 12x and 36x
respectively. Score with `bun scripts/measure/free-envelope.ts`, which fails a workload that misses
either. (This paragraph carried an unsourced "476x" that no file derived and neither ratio produces.)

A cache hit still costs one Worker request, and decomposition spends the DO quota it is trying to
dodge. Rows-per-fill is 2 to 156 depending on what is already warm, not a flat number, and
`tests/integration/rows-per-fill-audit.spec.ts` pins each class.

**When a measurement kills an approach, close the approach and keep the goal.** The tell is "X does
not move today's dominant constraint, therefore X is closed" -- the first half is a measurement and
the second is a decision about every other constraint X touches.

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
What is no longer checked is `drupal/` against the siblings.

**A composer `require` ships NOTHING, and this is the same rule pointed at dependencies.** The
packed tree IS the vendor directory. `drupflare` requires `drupflare/stream-http` and its
`HttpsStreamWrapper` extends the packaged class, so the packer mounts `../stream-http/src` at
`libraries/drupflare-stream-http/src` and the PSR-4 root is registered in **both** autoloader sites
-- `SETTINGS_OVERRIDE` in `src/site-do.ts` and the boot fragment in `src/drupal/site-php.ts`.
Adding a dependency means all three steps; the manifest line alone is a fatal on a missing class.
It is read from the sibling rather than copied under `drupal/`, because a fourth copy is what
created the drift the subclass removed.

## The rig is `docker/compose.yml`, and a rig finds what a green suite cannot

Seven services, every one pinned by digest: GreenMail, Redis, syslog, Gitea, **Forgejo**, **Keycloak**,
and **GitLab CE** behind `--profile heavy` because it wants ~4 GB and several minutes. `tests/e2e/README.md`
has the commands.

**Building these found three defects in one pass, and no lane could have seen any of them:**

- **The OIDC callback was a 404.** Tier B handed every provider `redirect_uri=/__oidc?action=callback`,
  and a `__` path is a Durable Object route the front worker refuses from outside BY CONSTRUCTION.
  25 assertions covered the exchange and none covered whether a browser could reach it, because every
  one drove the object directly. `/oidc` is now a `DO_ROUTE` + `PUBLIC_ROUTES` entry.
- **GitLab hook registration had never worked.** `createHookRequest()` sent `token` and `signing_token`
  together on the reasoning that an older install ignores the second. It does not -- it validates it and
  rejects the whole request, so no hook was created at all.
- **Bitbucket's git username is not its API username.** Atlassian's own documentation: the REST API takes
  the account email, git over HTTPS takes the Bitbucket username, case sensitive. One field drove both.

Two rig traps worth keeping. GitLab's `allow_local_requests_from_web_hooks_and_services` is an
APPLICATION setting, so the omnibus key for it is **decorative** and silently does nothing; set it
through `gitlab-rails runner`. And GitLab indexes a pushed branch asynchronously, so a merge-request
POST answers `source_branch does not exist` on a branch git has already accepted -- retry it.

**Bitbucket Cloud is `supported, not exercised`.** Not `verified`, which is reserved for a run that
asserted an observable, and not `untested`, which is false.

**A Data Center container cannot stand in, and the reason this file used to give was WRONG.** It said
a licence needs a human form; Atlassian publishes copy-paste timebomb licences on a public docs page,
no account, and a 3-hour one outlives any CI run. The real reason is that **DC is a different API,
not a different auth mode**: `/rest/api/1.0` and `/rest/build-status/1.0` rather than `/2.0`,
`repo:refs_changed` rather than `repo:push`, and `changes[].ref.displayId` / `.toHash` rather than
`push.changes[].new.name` / `.new.target.hash`. So a DC delivery falls through `readHookEvent()` to
`{kind:'other'}` -- **a DC rig would exercise the refusal path and report green.** The only thing the
two share is `X-Hub-Signature`, which is one line of `verifyHook()` for ~4 GB of JVM.

What IS contained is Atlassian's published Cloud OpenAPI spec (`api.bitbucket.org/swagger.json`,
unauthenticated). Checking the request builders against it found `pullsRequest()` hardcoding
`draft: false` for Bitbucket while every other provider read its flag, so every Bitbucket draft
reported as ready to merge. A spec check is an external oracle and **still is not `verified`** -- it
says nothing about whether the auth is accepted or a hook ever fires.

**Three places hardcode the real host**, so no mock is reachable through `/git?action=add` without a
shipping-code change: `parseRemote()` discards the host for Bitbucket, `cloneUrl()` returns
`https://bitbucket.org/...` unconditionally, and the add route never sets `remote.clone`.

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

**AND A SURGICAL EDIT CAN BE SHADOWED BY A CACHED COPY OF THE ROW IT EDITS.** The `max_age` fix
below was made correctly in the `config` table and `cache_config` kept its own serialized copy at
**0**. Drupal reads the bin first, so nothing changed: every render still said `no-store`, `cfw_page`
never filled, and every request on every site re-rendered -- for the whole time the fix was believed
shipped. `tests/node/page-cacheable.spec.ts` PASSED throughout, because it read the row the edit had
touched rather than the one in the way; it asserts both copies and their equality now.

**So when editing a config row, find every cached copy of it first.** The section already says to
verify `expire` and `cachetags` when COPYING a cache row between databases; the rule is wider than
that -- a config edit that leaves a `cache_config` row behind is inert, and inert in a way that reads
as working.

**A DRUPAL DEFAULT THAT IS CORRECT ELSEWHERE CAN BE FATAL HERE, and one was.**
`system.performance:cache.page.max_age` shipped at **0**, which is Drupal's installer default and
right for a generic host that configures a reverse proxy separately. Here the reverse proxy IS the
product: at 0 every render returns `Cache-Control: private, no-store`, `fillOne()`'s `refused` check
declines the `cfw_page` upsert, and **the page table stayed empty on every site ever created**. Every
request rendered. Measured on a fresh site: 0 rows before, 4 rows after, and paths that answered
`RENDER` now answer `HIT`.

Two things not to get wrong when reading that:

- **Honouring `no-store` is not the bug.** Storing a response Drupal marked `private` and replaying it
  is the uid-1 leak this project already shipped once. The value has to be right at the SOURCE.
- **The fix is a surgical sqlite edit, not a repack**, exactly as this section says: unserialize the
  `system.performance` blob, change the one key, reserialize, then `bun run assets:sql`.
  `tests/node/page-cacheable.spec.ts` reads the shipped row and fails at 0.

The general form is worth carrying: **the pack inherits Drupal's opinions about a deployment that is
not this one.** When something the architecture depends on is silently inert, check what the shipped
config believes before checking the code.

## The gate and production reach the SAME interpreter by two different routes

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

## An artifact a clean checkout cannot build is a lane boundary, not a failure

`bun install` runs `scripts/restore-artifacts.ts`, which pulls the interpreter from the public CDN,
**verifies sha256 against `cdn-manifest.json`**, and skips anything already current. No credential --
the bucket is fronted by a custom domain, the same property that lets `backup:verify` run from CI.
It never fails the install; offline you get a stub and a printed list of what was skipped.
`DRUPFLARE_SKIP_RESTORE=1` opts out.

**The pack cannot be restored that way.** `assets/drupal-pf` and `assets/drupal-sql` need a native
PHP Drupal bake plus `assets/drupal/site.sqlite`, whose trim recipe is written down nowhere, so they
arrive only in a published release payload via `bun run hydrate`. Until one exists,
`ARTIFACT_SPECS` in `vitest.config.ts` -- **measured, never guessed** -- is excluded and the lane
prints what it dropped. **Count it, do not quote it**: this line said 15 while the list held 17, then
19 while it held 34, and the "51 files / 1,521 tests still run" that used to follow moved with it and
was never re-measured. The lane prints both numbers when it skips.

**A LOCAL GATE CANNOT SEE THIS AND MASTER STAYED RED FOR SIX DAYS BECAUSE OF IT.** Every dev machine
has the pack, so a spec that reaches a real render passes here and fails on a clean checkout with
`per-file pack not reachable: core.pf.json 404`. Twenty had accumulated. Reproduce the clean-checkout
state before trusting a green local run on anything that renders:

```sh
mv assets/drupal-pf/core.pf.json assets/drupal-pf/core.pf.json.absent
bun run test
mv assets/drupal-pf/core.pf.json.absent assets/drupal-pf/core.pf.json
```

Back the file up first -- it arrives only from a release payload, so a lost rename is not recoverable
from this repository. Anything that fails there belongs in `ARTIFACT_SPECS`.

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

## `bunx tsc --noEmit` CHECKS ONE OF THREE PROGRAMS

The root `tsconfig.json` includes `src/**` and `scripts/**/*.mjs`. **`scripts/**/*.ts` and `tests/**`
are covered only by `bun run typecheck`**, which runs all three projects and filters `node_modules`.

So "typecheck clean" reported from the bare `tsc` is a claim about a third of the repository. It was
reported that way, CI went red on a commit nobody re-checked, and it stayed red across sessions with
103 errors -- **none of which was a real defect.** Every strictness error sat behind a guard TS could
not see. Two thirds of them were one wrong annotation repeated (`ServeDo` where a `DurableObjectStub`
was held) and ten were **`@cloudflare/workers-types` shadowing `@types/node` globals**, which is why
`socket.setTimeout(ms, cb)` read as "Expected 0 arguments" and looked like a broken install.

That shadowing is worth recognising on sight: inside a program carrying both, `process` degrades to
`any` so callback parameters lose inference, `URL` resolves to the workers one so `PathLike` rejects
it, and `Buffer` methods lose their overloads. **Fix it at the call site rather than by splitting the
tsconfig** -- `socket.setEncoding('utf8')` removes the `Buffer.toString(encoding)` call entirely, and
a `tests/e2e/tsconfig.json` on node types breaks any e2e spec that imports from `src/`.

## A green gate is not evidence the project bundles

**Every vitest lane resolves through vite; wrangler bundles with esbuild, and they disagree.**
`src/ops/tcp.ts` imported two error classes from edgeport's root barrel, whose `dist/index.js`
re-exports twenty namespaces it never imports. vite tolerates that; esbuild answers
`"dns" is not declared in this file` and emits nothing, so `wrangler dev` and `wrangler deploy` were
broken for a day with the whole suite green.

`bunx wrangler deploy --dry-run --outdir=<tmp>` is the check and does not deploy. Run it after any
dependency change, and prefer a subpath export (`edgeport/core`) over a package root.
`tests/node/bundle-imports.spec.ts` is an allow-list of known-broken roots, not a general check.

## A passing test does not mean anything calls it

`src/ops/supervisor.ts` -- the host tripwires, the health ledger, the circuit breaker,
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
the direction that matters, because an allow-list nobody prunes is how the next dead module
gets waved through.

**Count the list, do not quote it** -- this paragraph said five while the list held six, which is the
same drift the module table and the spec counts have shown. `bun run check:reachability` prints it.
Every entry today is legitimately off the edge: `src/ops/dormancy.ts`, `src/ops/module-table.ts` and
`src/ops/mutation-oracle.ts` are build-lane or discovery instruments driven by their own vitest
specs, and `src/runtime/php-binary-{jspi,o2,zstd}.ts` are alias targets reached through a wrangler
`alias` rather than through an import. The list may shrink without ceremony; **adding to it is the
thing to think twice about**, because an entry is a promise the module is reached some other way
rather than a way to silence the check.

## Commands

**VITEST 4'S DEFAULT REPORTER HIDES CONSOLE OUTPUT FROM PASSING TESTS, and every `DRUPFLARE_MEASURE`
spec here reports by printing and passing.** So the whole measurement lane currently prints nothing
and exits green, which reads as "no output to give" rather than "output suppressed". `silent: false`
does not fix it. Use `--reporter=verbose` to read any measurement spec.

```sh
bun run test      # vitest: --project=workers --project=node
bun run typecheck # tsc --noEmit
bunx prettier --check .
bun run assets:driver      # repack after ANY change in a sibling
bun run test:health        # the sibling's health suite
bun run check:reachability # which modules the edge imports; which are dead

bun run hydrate         # a clean checkout -> deployable, from the release payload
bun run release:payload # build that payload; needs vendor/ and the packs
bun run release:check   # dry-run the canonical config and price it against the 3 MiB ceiling
bun run build:wasm      # the interpreter into .interp/ (gh auth); no docker, the decoder is gone
bun run backup:verify   # 40 CDN keys, no credentials

bun run measure:abi-speed   # wasm32 vs long64 vs wasm64, interleaved, on node/V8
bun run measure:abi-control # the same harness with one binary as two arms; read this first
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
excluded from `bun run test`.

**The browser lane BUILDS THE PACK when there is no release, and used to skip instead.** It ran on
every push and always passed having executed nothing: with no release `HAVE_PAYLOAD` was empty and
every step was guarded on it, so five consecutive green runs ran zero specs. `bun run build:local`
completes on a clean checkout now that `assets/drupal/site.sqlite` is restorable from the CDN, so the
lane builds and runs. The from-source pack is a SUPERSET -- 19.74 MB against the shipped 11.49 -- and
that is by construction: the shipped file list came from a traced run a checkout does not have, so
the bootstrap globs every non-test file. Verified rendering: 200 in 26 ms cold, 3.6 ms warm.

**A fourth lane drives a BROWSER, and it exists because no HTTP lane could see the defect that
opened it.** `bun run test:browser` runs Playwright over `bun run dev` against `tests/e2e/browser/`.
The files are `*.pw.ts` rather than `*.spec.ts` so the vitest `e2e` glob cannot collect them, and it
is NOT part of `bun run test` -- the gate stays hermetic. Every spec fails on a browser console error
or an uncaught page error, which is the assertion that separates a working page from a 200 whose
widget threw. `/user/register` and `/user/*/edit` were a white screen on every site and the e2e lane
read both as healthy.

PHP suites live in the siblings, and **they are the authority on their own module** -- what ships is
`assets/driver.json`, packed from those same checkouts, and nothing tests the pack's PHP directly.

| suite                                                            | repo           |
| ---------------------------------------------------------------- | -------------- |
| `php tests/health-suite.php`                                     | `../drupflare` |
| `php tests/cfw-tcp.php`                                          | `../drupflare` |
| `php tests/solarium-transport.php`                               | `../drupflare` |
| `DRUPAL_ROOT=<worker>/drupal-src php tests/load-classes.php`     | `../drupflare` |
| `DRUPAL_ROOT=<worker>/drupal-src php tests/run-driver-suite.php` | `../rom`       |
| `DRUPAL_ROOT=<worker>/drupal-src php tests/run-installer.php`    | `../rom`       |
| `DRUPAL_ROOT=<worker>/drupal-src php tests/pdo-shim.php`         | `../rom`       |

`run-installer.php` drives Drupal's own installer against the driver with core's sqlite driver as a
child-process control. It needs a real filesystem, so it is sibling-only and has no counterpart
here.

**This repo's gate checks the siblings out with no `composer install`.** A suite or fixture that
needs `drupal/core` must therefore search `../../drupal-src/vendor/autoload.php` as well as its own
`vendor/`, and supply `Drupal\drupflare\` itself, since only composer's autoloader maps it.
`health-suite.php` searches both; a hardcoded path in `tests/fixtures/renamed-form-state.php` did
not, and failed three assertions here while passing in its own repo.

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

Constants are lowercase `true`/`false`/`null`, following the reference Drupal codebase (1,276 lowercase vs 1 uppercase),
not Drupal core's legacy style.

A malformed `phpcs.xml.dist` **fails silently and reports a fake pass**. Verify a ruleset change by
loading it. `--` inside an XML comment is invalid.

## A `run: false` is load-bearing, and three of them outlived their reason

`CRON_HOOKS` switched `update`, `system` and `announcements_feed` off for "outbound HTTPS; there is
no socket". True when written; false once the stream wrapper and `CachedFetchHandler`'s
defer-and-answer-next-drain landed, and nothing re-read it. So `hook_cron` for `update` never fired
on any site, the fetch queue was drained only by a human clicking Check, and **security advisories
were never wired at all**. All three now run, and advisory detection is `cron:advisories`.

A skipped hook is absent from every site rather than merely unverified, and nothing reports it.
Before adding one, check the limit still holds.

**A `run: true` CAN BE JUST AS ABSENT, and `drupflare`'s is.** Hook implementations compile into the
container and the pack ships it prebuilt, so a `#[Hook]` class added after the bake is invisible on
every installed site: `hasImplementations('cron', ['drupflare'])` answers false while the class loads
fine, and `runCronHook()` answers `no cron implementation`. `DeferredCron` has therefore never run
anywhere, and adding `drupflare` to `KNOWN_CRON_HOOKS` only made the host schedule a firing with
nothing to invoke.

So a host-driven unit reaches an existing site and a module hook does not. That is why the advisory
scan is `cron:advisories` calling `AdvisoryScan` directly rather than a second `#[Hook]` class -- the
class stays in the module, where the knowledge of `update_project_data` belongs, and only the
invocation moved. **Check `hasImplementations()` before assuming a new hook runs**; the unit reports
`ran: false` with a reason and nothing escalates it.

**`cronHookList()` IS EXPORTED, SPEC'D AND CALLED BY NOTHING**, so the chain always uses the
hardcoded list and a customer-installed module's `hook_cron` never runs. Its docblock says the
opposite. Not fixed.

**AND TURNING THEM ON QUARANTINED THE SITE.** A cold fetch cache plus cron tripped
`bridge.asyncify_called` to three strikes and every page answered 503 -- so a newly provisioned site,
whose cache is always cold, took itself down on its first cron round. The tripwire's `error` severity
was calibrated to the pre-stub behaviour where reaching a free identifier killed the invocation; the
stub was added to make that survivable and the severity never moved. A graceful degradation must not
escalate to an outage.

## The heap peak is per WORKLOAD; the isolate is charged per INCARNATION

`USE_ZEND_ALLOC=0` means PHP returns nothing between requests, so demand inside one incarnation is
the SUM of what it has done and the growth step rounds every rise up. Measured on one object:
96.00 MiB booted, **108.50 after migrate + firstrun, 122.63 after the first authenticated render,
138.63 after the second** -- 10.63 MiB past the 128 MiB isolate limit. So provisioning a site and
then viewing two pages on it was over the ceiling BY CONSTRUCTION, which is the first-run path of
every new site. On the edge that is `Durable Object's isolate exceeded its memory limit and was
reset`: every in-flight request on the object is lost and a cascade of
`Internal error in Durable Object storage caused object to be reset` follows.

Every figure in `TECHNICAL_REPORT.md`'s Memory section is a single-workload peak, and each one is
correct. None of them is what the isolate meters.

**CRON WAS THE FIRST HYPOTHESIS AND IT WAS WRONG.** Both resets landed on an alarm whose logs were
full of the update module's deferred fetches, which reads as a cause. A sweep of 16 firings moves
linear memory by nothing at all. `tests/integration/interpreter-recycle.spec.ts` keeps that control
so the next reader does not re-derive the same wrong answer from the same suggestive stack.

**THE FIX IS AT PROVISIONING, AND THE CEILING VERSION WAS BUILT FIRST AND WAS NOT ENOUGH.** A drop
keyed on linear memory runs BETWEEN invocations; on a deployed paid worker the reset happened INSIDE
one -- the first authenticated `/admin/content` on each of four freshly provisioned sites went from
the install's 108.50 straight past the limit in a single render, 4,661-4,936 ms of cpuTime, exception
with no message and no stack. `/__migrate` and `/__firstrun` now drop the interpreter when they
finish, the way `/__enable` always has, so the serving incarnation starts at `INITIAL_MEMORY` and the
peak over four authenticated pages is 108.50, flat.

`recycleIfOversized()` remains the backstop for everything else, dropping at the end of an invocation
above `RECYCLE_ABOVE_BYTES` (112 MiB). It must run BETWEEN invocations: linear memory is reclaimed
only when the old module is collected, so dropping mid-request holds both allocations at once.
`/serve-stats` reports `recycles` and `lastRecycle` -- an object recycling on every request is paying
a boot per page.

**A FILL BATCH IS N WORKLOADS INSIDE ONE INVOCATION, so that drop cannot reach it.** The batch was
bounded by page count alone; the wall-clock guard cannot bind because the clock does not advance
across a synchronous `php._run()`. On paid at `fillBatchSize` 25 this reset all four freshly
provisioned sites -- cpuTime 2,213-4,944 ms, exception with NO message and NO stack, then the storage
cascade on every route. The batch reads `oversized()` and ends early, which hands the drop to the
recycle at the bottom of the alarm. A message-less exception at high CPU is what this looks like;
the memory-limit text only appears when the limit is crossed between invocations rather than inside
one.

The supervisor had detected this since it shipped. `memory.trend_rising` fires with the text
"recycle at the next quiet moment", `warn` findings are recorded in the ledger, and **nothing ever
acted on one**. Detection wired to no act is the same family as tested-but-never-called.

## A Durable Object hibernates at 10 s, and `KEEP_WARM_MS` is 24x that

Measured on a throwaway deploy, an object minting an id in its constructor and holding a 32 MB
allocation: re-armed every **8 s** one incarnation survived **71 consecutive alarms**; at 12, 20, 30
and 45 s the constructor ran again on every probe; with no alarm the id changed across a 20 s gap.

So `KEEP_WARM_MS = 240_000` re-arms an idle alarm and keeps nothing warm. Two places had recorded the
wider claim that an armed alarm "buys no warmth" as a general fact -- correct at 240 s, false at 8 s,
because the FIRING resets the idle clock. Arming does not warm; firing under the threshold does.

**Duration is not the meter.** An object waiting on an armed alarm is idle and ELIGIBLE to hibernate,
and an idle-eligible object is not billed for duration. Warming spends requests and rows, one of each
per firing, which is 10,800/day. What it removes is the 1,398 ms boot from pages that render; a
cached page answers off `ctx.storage.sql` without booting PHP, so warming cannot make one faster by
any amount.

**`SITE_WARM` IS ON BY DEFAULT, and this file said off until 2026-08-30.** `siteWarmEnabled()`
returns true when the var is unset and there is no plan branch in it. Observed on the current tree: an
object with an armed alarm re-arms every 8 s, climbed to 33 firings, stayed warm through every 25 s
gap and served at 48.5 ms median. So the object that pays a cold serve is one whose chain has
stopped, not every idle site. The figure that argued for off was a thousand-site fleet total, which
is the wrong lever for a default -- see `no-per-site-pricing` in project memory.

## A meter that is most of what it counts

An idle warming tick charged **three** rows: the `setAlarm`, plus one each for `flushDailyRows()` and
`flushDailyDoRequests()`. On an idle tick the only writes those two have to record are their own, so
the counter sustained itself -- 32,400 rows/day at 8 s, **32.4% of free's daily row budget to count
almost nothing**. `shouldFlushMeters()` gates them on a 60 s interval or 25 pending rows and a tick
now charges 1; `tests/integration/warm-alarm-cost.spec.ts` pins it.

**`FREE_QUOTAS.rowsPerAlarmArm` was 1 and had never been measured.** It came from the published "a
`setAlarm()` is one row written", which is true about the setAlarm and not about the firing. Score a
warming proposal against a measurement, not against the platform's line item.

Two modelling traps came out of fixing it, and both produce a confident wrong number:

- **A cost with its own clock needs its own term.** Folding the meter flush into a per-arm constant
  is right only at the interval it was derived at.
- **The flush is capped by the FIRINGS.** An object waking every 240 s cannot flush every 60 s;
  without the cap the model charged a 240 s chain for 1,440 flushes it never performs. `saturatingSites`
  moved 277 -> 92 because it divided the quota by arms per site and rows per site is no longer that
  number.

## One object is not a site-wide throughput ceiling

A Durable Object is single-threaded; a SITE is not, because a namespace holds unlimited objects.
Measured on a throwaway rig with a fixed CPU burn, concurrency scaled with the pool so per-replica
offered load stays constant: **1.00 / 2.05 / 3.16 / 5.72x at 1 / 2 / 4 / 8**, p50 flat throughout,
zero errors. Little's Law closes at 1 and 2 and opens a gap at 4 and 8, so something above the
service-time path constrains aggregate concurrency past N=2 -- **not attributed**, and 16/32 are not
worth building until a distributed generator separates the load generator from the topology.

**An authenticated GET writes no authoritative state under this SAPI**, which is what makes any of it
possible. No `sessions`, no `users_field_data.access`, no `flood`. Core throttles the access write by
`session_write_interval` on `KernelEvents::TERMINATE`; here it never fires at all because this SAPI
does not dispatch terminate. Nothing depends on that by design, so
`tests/integration/replica-invariant.spec.ts` is its only guard.

**Classify the EFFECT, never the route and never the table.** Both cheap classifications were measured
wrong on the same page:

- `/admin/reports/status` wrote only `key_value` against a warm fetch cache and also `watchdog` against
  a cold one, because the advisories fetch failed and Drupal logged it. `watchdog` appears on any
  authenticated GET that logs.
- `key_value` holds the disposable `update_fetch_task:*` queue **and `state:system.private_key`**, which
  Drupal mints lazily and keys CSRF tokens on. Two replicas each minting their own issue tokens the
  others reject, so it must arrive by replication and may never be generated on a replica.

`src/ops/replica.ts` is therefore two allow-lists and no deny-list, and it walks the capabilities
INSTALLED on the module rather than a list -- `cfwOidcClaims` and `cfwTcp` had both drifted out of
`CROSSING_NAMES` and both mutate.

**Three load-generator errors each produced a confident wrong curve**, and all three are cheap to
repeat: a `while (Date.now() < until)` CPU burn never terminates because the clock is frozen between
I/O; a shared-counter round-robin distributes unevenly and reported a completely FLAT curve; fixed
concurrency gives every arm a different per-replica load, so N=1 collapsed at 160 connections while
N=8 was never saturated. Always measure the generator's own ceiling against a no-work endpoint first
-- here it was 958 req/s, which is what makes the rest mean anything.

## `supported` is not a state a module may be in

**Nothing is a support claim except a gated enable-and-assert run.** The module table has exactly
three states - `verified`, `untested`, `blocked` - and `verified` is reachable only by a test that
enabled the module against a real site and asserted an observable it owns.

`supported` used to exist and meant "the capability this module needs was measured WITHOUT the
module". That is an inference about the runtime, and it read to everyone else as a promise about the
module. Do not reintroduce it under another name: `tests/node/module-table.spec.ts` pins the state
set and fails on a rendered table containing the word at all.

**The table is 58 verified / 0 untested / 4 blocked -- count it, do not quote it.** `moduleTable()`
is the census; every prose figure in this repo has been stale in both directions.

**A note written from reading a module's source is not a classification.** `drupal/search_api_solr`
sat untested behind a correct note about its Solarium transport being interceptable, and the
transport was never the blocker: it pulls `maennchen/zipstream-php`, which declares `php-64bit`, so
composer's `platform_check.php` asserts `PHP_INT_SIZE === 8` and aborts every request before Drupal
boots. All 56 other contrib cases failed with it. The blast radius of a dependency constraint is the
whole application and only an install measures it; `bun scripts/contrib-fixture.ts` is the harness.

**THE BUILD KEEPS COMPOSER'S PLATFORM CHECK ON. Decided 2026-08-24.** With `platform-check: false`
that one module installs clean and 57/57 pass, so the temptation is real and the measurement is not in
dispute. It stayed on for three reasons: the guard was CORRECT there (`PHP_INT_SIZE` was 4 and zipstream
wants 64-bit offsets for ZIP64), turning it off ships an unexercised 64-bit path SITE-WIDE to unlock
one module, and the setting is not per-dependency -- it would be off for every future package that
declares the same thing, silently. **`PHP_INT_SIZE` IS 8 as of 2026-08-25, so the guard now PASSES** and `search_api_solr` moved to
`untested` on its own. The platform check stays on and is now costing nothing: it asserts a condition
this build satisfies. Leave it on. Do not set it in
`drupal-src/composer.json`: that tree is gitignored and is the build input for the shipping pack, so
a local change there is the silent-drift shape this file exists to prevent.

## Conventions

- `bunx`, never `npx`.
- Imports use a `.js` specifier even for `.ts` files (`from './site-do.js'`). This matches what bun
  resolves; `node` cannot resolve it, which is why some scripts must run under bun.
- `src/probes/**` are frozen measurement instruments cited by figure in the report. Moving a file
  does not change what it measures; rewriting it might. Do not refactor them.
- `src/drupal/*-php.ts` are mostly `String.raw` blocks holding PHP source. A backtick inside a PHP
  comment truncates the block and breaks the PHP while leaving the JavaScript valid - this has
  happened twice. `tests/node/php-fragments.spec.ts` runs `php -l` over all of them; keep it green.
  **An APOSTROPHE is the same hazard one level in.** `PW_SERVE_INLINE` is embedded in a
  single-quoted PHP string, so a `'` anywhere inside it - including in a `//` comment, where it
  reads as ordinary prose - closes that string and the next word becomes a stray identifier.
  Writing "the status report's Web server row" in a comment produced
  `syntax error, unexpected identifier "s"`. Say "the Web server row on the status report" instead.
- **A shim over an INTERNAL PHP function does not need `eval()`.** `mb-fix.ts` wraps its
  declarations in one and `zlib-fix.ts` does not: a conditional function declaration is
  bound at runtime, not at compile time, so `if (!extension_loaded('zlib')) { function gzencode(){} }`
  compiles clean on a build that HAS the extension and the branch never runs. That matters for
  coverage rather than style - `php -l` sees INSIDE plain PHP and sees only a string literal inside
  an `eval`, which is why `ZLIB_FIX` is in the fragment gate and `MB_FIX` cannot be.
- `experiments/` is prettier-ignored: probe configs kept for reproduction, not maintained.
- Comments: lowercase, terse, one line, no trailing period, only where the WHY is non-obvious.

## Deploying, when authorized

The account has **real production workers**. Use a `cfw-*` name, tear down immediately, and verify
the worker list returns to exactly its prior baseline. A DO-namespace deploy needs ~60 s propagation
before `stub.fetch()` stops returning "Worker not found" - wait, do not debug it. Uploading the full
48 MB `assets/` tree fails; stage only what is needed.

`wrangler deploy --dry-run --outdir=<tmp>` does not deploy and is the only cheap way to prove an
entrypoint and its binary alias still resolve.
