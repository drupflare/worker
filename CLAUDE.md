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
- **A built-in that WAITS for the clock to move never returns on the platform.** `uniqid()` polls
  `gettimeofday()` until the microsecond changes; a migrated farmOS claim spun to 302,500 ms on it
  while a local workerd, whose clock advances, answered in 10 s. It is a stand-in now (`standin-fix.ts`).
  Suspect this shape first when a deployed invocation burns CPU with no host call.
- **`x-cfw-serve-ms` is that same frozen clock**, taken inside the object around a serve that may run
  PHP, so on a render it under-reads by the whole synchronous span. `x-worker-ms` brackets the hop and
  is the wall figure. And `x-cfw-inline-boot: 1` is what says a request booted; `x-cfw-php-booted`
  only says an interpreter is resident.
- **A request tag joined to object invocations can pick the wrong invocation.** Measured 2026-09-25:
  the tag join returned object rows of 38-121 ms for cold renders whose per-minute
  `durableObjectsInvocationsAdaptiveGroups` quantiles read cpuTime p90 ~865-959 ms. Read the object
  dataset per minute, one cold sample per minute per arm, and check the join against it before
  quoting a per-request object figure.
- **For a throwaway, read Workers Observability events rather than the GraphQL object datasets.** Measured
  2026-09-30: `durableObjectsInvocationsAdaptiveGroups` returned 9 of ~340 invocations for a namespace
  younger than ~10 minutes, and deleting the worker deletes those rows; Observability events survive a
  teardown and carry per-invocation CPU, wall and outcome.
- **`cpuTime` is 1 ms granular**, so a reading of 1 ms is the meter's floor rather than a measurement
  of 1.0 ms. It bounds an invocation; it cannot resolve below itself. Amortise over many requests
  when the quantity is sub-millisecond.
- **State an n and a spread with every absolute.** The 400-600 ms bimodality this file used to assert
  as a standing property **did not reproduce** across 640 client-side requests on a continuously
  driven warm object: two samples exceeded their arm's median by more than 300 ms and both were
  attributable, one queued behind a 5,907 ms alarm and one a 4,284 ms render. It may be a property of
  cold or first invocations; as a general claim it is unverified, so re-observe it before designing
  around it.
- **CHECK `.wrangler/state` BEFORE DIAGNOSING A SLOW OR TIMING-OUT RIG.** `wrangler.jsonc` sets
  `observability: { enabled: true }` and miniflare honours it LOCALLY, writing every request into
  one sqlite file that nothing prunes: measured at **20.75 GB** on 2026-09-10, inside a 22 GB
  `.wrangler/state`, having grown since 10 August. A night of `measure:host` runs timed out against
  it and the generator ceiling decayed 871 -> 600 req/s; parking the trace store and the accumulated
  DO state took the tree to 1.0 GB and the ceiling back to ~1,010. It is derived state and safe to
  delete, and none of that was the host.
- **A BENCH SITE CAN EXHAUST ITS OWN DAILY ROW QUOTA, and it does not look like a quota.** A site
  driven all night read **103.8%** and went read-only, so every login answered 503 and the rig
  reported a wrong password. The field is `rowsToday` in `/serve-stats`, NOT `limits.hitAny` --
  that one is the platform-limit tally and stays false while the site is read-only. For a
  measurement rig, `wrangler dev --var PLAN:paid` lifts the budget so a harness is not fighting the
  degrade it did not come to measure.

## Notes

The incident write-ups, measurements and platform facts live in `notes/`, one topic per file. Read the file for the area you are about to touch; `notes/README.md` maps every section heading to its file, so a citation of the old CLAUDE.md finds its text with a grep.

| file                                                         | covers                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [notes/park.md](notes/park.md)                               | What the park does, how it was measured wrong three times, and what it cannot serve.            |
| [notes/memory-and-isolates.md](notes/memory-and-isolates.md) | Linear memory, the isolate budget, boots, recycling, heap images and what the platform charges. |
| [notes/lanes-and-pool.md](notes/lanes-and-pool.md)           | The pool eviction history, lane state, throughput, and the VPS and host arms.                   |
| [notes/packs-and-delivery.md](notes/packs-and-delivery.md)   | How the pack, the container row and the published assets are built, updated and reconciled.     |
| [notes/cache-and-rows.md](notes/cache-and-rows.md)           | Stale tiers, cache bins, and the meters a feature can spend.                                    |
| [notes/database.md](notes/database.md)                       | What produces assets/drupal/site.sqlite and why a shared base has nowhere to live.              |
| [notes/measurement-history.md](notes/measurement-history.md) | Instrument errors and gate-lane findings, each with the case that earned the rule.              |
| [notes/platform-facts.md](notes/platform-facts.md)           | Measured Cloudflare behaviour, the owner routes, and defects only a browser or a deploy found.  |

## Scoring a Proposal

Free's limits are aggregate daily budgets, not the 10 ms per-invocation cap. There are two ceilings:
serving is bound by Worker requests at 100,000/day, and regeneration at **50,916/day at the shipping
default** (`dynamic_page_cache` and `menu` in memory, priced on the warmth mix at 1.75 rows/fill) and
**10,866/day on the conservative `MEMORY_CACHE_BINS=none` arm** -- the SAME on the alarm chain and
the fill window. Score with `bun scripts/measure/free-envelope.ts`, which prints both and fails a
workload that misses either.

**ROWS BIND ON BOTH ARMS, AND DURATION WAS A FIFTH MODELLING DEFECT.** It read 47,749 duration-bound
for one day because the duration term priced every fill at 2,127 ms, the cold-bins mixture. Measured
2026-09-24 on a deployed object with `gbs-per-operation.ts`: a steady-state fill is 209-308 ms with
three bins emptied (n=9) and 52-95 ms reassembling from a warm dynamic page cache (n=18), and
`x-worker-ms` agreed with billed `activeTime` to 2-6%. `SECONDS_PER.warmRender` is the 308 ms maximum,
which puts duration at 329,748 fills/day. It reopened the census: `render` and `discovery` on top of
`menu` would take a fill to 1.40 rows, and both were then REFUSED on costs rows cannot see --
`render` makes a cold render 2,696 ms against 1,450, `discovery` costs 12.4 MiB at its 64-entry cap.
**Price a memory bin on the cold render too.** The shipped two cost a cold reassemble +251 ms, which
their docblock had reasoned away as landing on a request already paying a boot.

**THOSE FIGURES WERE 9,685 WINDOWED AND 2,477 ON THE ALARM CHAIN UNTIL 2026-09-23, and four
modelling defects produced them**, each found by predicting the mechanism and confirming it with a
control. They are the case study for "a number outlives its mechanism":

- **`DO_INVOCATIONS_PER_COLD_FILL = 180`** priced a cold boot sliced across alarms at 8 ms each.
  No slicing code exists, the Boot section says a boot has no seam to resume from, and a deployed
  FREE worker drains a batch in exactly one invocation, verified to k=20. It is 1. That single
  constant was the whole 4x gap between the two paths and the whole reason the alarm chain read
  DO-bound -- which made every row saving look worthless on the path a default deploy takes.
- **The audit harness charged its own DELETE.** It deleted the page row inside the tracked window;
  a DELETE is charged and a fill upserts. `realRender` and `warmReassemble` each read one row high.
  The control was that both cold classes did not move, because a DELETE matching no row writes
  nothing.
- **`byR2ClassA` was unconditional**, capping regeneration at 33,333/day on a config with no
  `r2_buckets` binding. It only became visible once the in-memory bins took rows/fill below 2.65.
- **The class was quoted instead of the mix.** At SQL bins the `realRender` class sits below the
  mix, so quoting it was conservative; at the shipping default it sits above, so it would have been
  optimistic. The mix is honest in both.

**Every class is priced on its DEARER path, and the two classes disagree about which that is.**
`/user/login` realRenders in 8 and reassembles in 1; `/` realRenders in 3 and reassembles in 2. So
`realRender` comes from login and `warmReassemble` from the front page. Measure both paths before
moving either -- the reassemble was briefly set to the login figure and `fill-bins.spec.ts` caught it
undercutting a real fill. (This paragraph once carried an unsourced "476x" that no file derived.)

**On free the 10 ms cap does not fail a Durable Object invocation, and a Worker handler is refused
only under sustained heavy CPU whose threshold is unmeasured.** A 1,882 ms `cpuTime` invocation
succeeded on a deployed free worker on 2026-09-07. burrow's M5 probe (2026-09-24) ran back-to-back
~1.6 s burns: an object completed 10/10, while a Worker handler completed two and was then killed at
412 ms and at 10 ms on every call after. **That did NOT generalise to image work**, measured the same
day on a fresh free deploy running `runImageTransform()` over a 3000x1571 JPEG: 30 sequential and 40
concurrent (two waves of 20) 1090 px transforms plus 19 earlier ones, `cpuTime` p50 ~180 ms and max
493 ms, **every invocation `success`, zero refusals**. So the front-worker image path is fine at
page-load rates. Before refusing anything because "it will not fit in 10 ms", check where it runs
and how hard it runs back to back.

**A rows-saving feature can cost more rows than it saves, and one did.** Scoped invalidation's
`tag -> paths` index as a `(tag, path)` TABLE took rows per fill from 9 to 39. Folded into the page
INSERT as a column it costs 0. Price the index against the meter the feature exists to move, on the
same instrument, before building the second half.

A cache hit still costs one Worker request, and decomposition spends the DO quota it is trying to
dodge. Rows-per-fill is 2 to 94 across five classes depending on what is already warm, not a flat
number -- **count it from `ROWS_PER_FILL`, do not quote it**, this line said 156 after the
`WITHOUT ROWID` conversion took it to 94 -- and
`tests/integration/rows-per-fill-audit.spec.ts` pins each class.

**When a measurement kills an approach, close the approach and keep the goal.** The tell is "X does
not move today's dominant constraint, therefore X is closed" -- the first half is a measurement and
the second is a decision about every other constraint X touches.

## Never touch `vendor/`

It holds **15** hand-built php-wasm arms under `vendor/static*/`, one `.wasm` and one `.mjs` each,
plus four `php-wasm` npm copies at the top level: **34 files, 198 MB**, gitignored. The arms are not
reproducible without a Docker toolchain session. Never delete, move, or overwrite anything under it.

**It is no longer one-machine-only, and the prohibition stands anyway.** All **34 vendor files** are
in the `drupflare-cdn` R2 bucket under the same paths, verified by size and by ETag-against-md5:
`bun run backup:verify`. They are 34 of the manifest's 35 `keys`, the 35th being
`assets/drupal/site.sqlite`; the `.DS_Store` sitting in `vendor/` is not one of the 34. Restoring one
is
`bunx wrangler r2 object get drupflare-cdn/<path> --remote --file=<path>`. A local delete is now
recoverable rather than permanent; it is still a mistake nobody needs to make.

**`bun run vendor` can no longer replace one of them.** It copies two builds out of the installed
`php-wasm` package, and php-wasm 0.2.0 ships a different 8.3 build than 0.1.0 did (12,222,482 bytes
against 13,165,354). `writeOnce()` in `scripts/vendor.ts` now fails on a file that already holds
other bytes instead of overwriting it, so a renovate bump of the package cannot make
`backup:drift` report a backed-up file as changed.

**The worker runs on php-wasm 0.1.0 and 0.2.0.** What 0.2.0 changed, from a diff of the two
`PhpBase.mjs` files: `_run()` strips a leading `<?php` and evaluates in PHP mode where 0.1.0
prefixed `?>`, so every shim this file runs through `run()` evaluates the same; `_enqueue` is one
serial `_drainQueue`, which the worker does not use because it calls `_run()` directly; a `variant`
argument throws, which nothing here passes; `ENV.PHP_VERSION` is set only when the caller passes
`version`, which nothing here does; and the factory is called without `new` unless it is a class,
which the tuned glue's plain `function(moduleArg)` answers identically either way. Checked rather
than read: the workers and node gate under 0.2.0 passed 6,489 tests and failed one,
`heap-image-producer.spec.ts` ("ends the firing after imaging"), which passes alone on both versions
and failed while a `wrangler dev` boot shared the machine; and a `wrangler dev` boot rendered Drupal.

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
-- `src/site/php/settings-override.php` and the boot fragment in `src/drupal/site-php.ts`.
Adding a dependency means all three steps; the manifest line alone is a fatal on a missing class.
It is read from the sibling rather than copied under `drupal/`, because a fourth copy is what
created the drift the subclass removed.

## The rig is `docker/compose.yml`, and a rig finds what a green suite cannot

Nine services, every one pinned by digest: GreenMail, PostgreSQL, MySQL, Redis, Gitea, **Forgejo**,
**Keycloak**, syslog, and **GitLab CE** behind `--profile heavy` because it wants ~4 GB and several minutes. `tests/e2e/README.md`
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
POST answers `source_branch does not exist` on a branch git has already accepted -- retry it. Gitea 28
ignores `[webhook].ALLOWED_HOST_LIST` and refuses the catch-all `*`, so the rig sets
`[security].ALLOWED_HOST_LIST = private`; with the old key every hook to `host.docker.internal` was denied.

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
which is why the scan separates them rather than counting 44 problems to hide 6.

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
Every entry today is legitimately off the edge: `src/ops/dormancy.ts` and
`src/ops/mutation-oracle.ts` are build-lane or discovery instruments driven by their own vitest
specs, and `src/runtime/php-binary-{jspi,o2,raw}.ts` are alias targets reached through a wrangler
`alias` rather than through an import. The list may shrink without ceremony; **adding to it is the
thing to think twice about**, because an entry is a promise the module is reached some other way
rather than a way to silence the check.

**`dead` MEANS "not imported from the wrangler `main`", NOT "unused", and the difference matters
before anyone deletes one.** `php-binary-raw.ts` is on that list and it is the SHIPPING interpreter. The o2 and
jspi seams are named by six configs under `experiments/wrangler/`. Check what aliases a file before
concluding nothing reaches it.

**`php-binary-zstd.ts` WAS orphaned and is deleted, 2026-09-07.** No shipping config and no
experiment config named it: the arms alias o2, jspi and 85, and the shipping alias is now the raw
import. The zstd PACKER survives, because `pack:wasm` still frames the 8.3 binary and the experiment
arms. That is the shape to look for -- a live producer says nothing about its consumer.

## `bun run hydrate` OVERWRITES a hydrated tree, and that took three artifacts at once

Run on a complete checkout it unpacks the payload `package.json`'s version names, over whatever is
there. Measured 2026-09-11: one run replaced `assets/drupal-pf`, `assets/drupal-sql` and the tuned
interpreter glue with an older release's copies, and the damage presented as three unrelated
failures rather than as one clobber.

- `container-cid.spec.ts`: the pack hashed `748a88e7a06b6d0a` against the database's
  `01b5b66bd61b00b1`, which is the 1,024 ms-per-boot container rebuild this file already documents.
- twelve `index-audit` assertions: **302 CREATE INDEX against 157**.
- every workers spec aborting with `ASM_CONSTS[code] is not a function`, which is a glue/wasm
  mismatch and reads exactly like a broken interpreter.

**All three were recovered with no download**, which is the useful half: `bun run assets:pack`
rebuilds the pack from `drupal-src`, whose `vendor/drupal/DrupalInstalled.php` carries the right
`VERSIONS_HASH`; `bun run assets:sql` rebuilds the chunks from the TRACKED `site.sqlite`; and
`emitTunedGlue()` in `scripts/measure/growth-glue.ts` re-derives the tuned glue from the pristine
`php8.5-worker.mjs`, which still matched `interp.lock.json`.

**AND `assets:pack` ALONE IS NOT THE RECOVERY, which this project has now got wrong twice.** It
needs `assets:twig` BEFORE it -- the pack has to carry the baked templates and the manifest is
compared against them -- and `assets:scrub` AFTER it, because a rebuild puts a `hash_salt` back into
`sites/default/settings.php` and every site would then share one. Seven assertions across
`twig-bake.spec.ts` and `pack-secrets.spec.ts` are what catch each half. The order is
`assets:twig` -> `assets:pack` -> `assets:scrub`, and running the middle alone is the mistake.

`hydrate` no-ops on a complete tree now unless `--force`. That matters beyond the accident:
`wrangler.jsonc` declares `build.command` for the first time, so without the guard every
`wrangler deploy` would have done this to a developer's tree.

**AND THE NO-OP GUARD IS NOT ENOUGH, BECAUSE MID-BUILD THE TREE IS LEGITIMATELY INCOMPLETE.**
`build-local.ts` orders `container` before `sql`, so when the container step spawns
`wrangler dev --local` the tree is still missing `assets/drupal-sql/manifest.json`. The build command
fires, `missingMarkers()` correctly answers "not hydrated", there is no published release, and hydrate
falls back to `build-local.ts` -- which reaches the container step and spawns wrangler again. Each
level forks another full Drupal build.

Measured 2026-09-12: Pack Suites, Browser Lane and Class A Metrics all ended in
_"The runner has received a shutdown signal"_ about three minutes in, three lanes running three
different commands. `scripts/hydrating.ts` is the flag that closes it; `hydrate-reentry.spec.ts` pins
all three links.

**NOTHING NAMED IT, BECAUSE THE INSTRUMENT SWALLOWED THE ONLY OUTPUT THAT COULD.**
`bake-container.ts` buffered wrangler's stdout into a string and printed it from its `catch`, and a
SIGTERM never reaches a `catch` -- so the logs read as 200 seconds of silence. The run of 2026-09-11
01:37 is the control: it predates the build command, so wrangler bound, `waitForPort` returned, and
the next real defect printed as `migrate answered 401: owner token required`. **A long wait on a
child must echo that child as it arrives.**

That 401 is the second half and is its own rule: **`--var`, not the process environment.** wrangler
forwards neither into the worker's `env`, so a `PW_DIAGNOSTICS` set on the spawn was never read.
`/migrate` is an owner route, so it answered 401 on CI and 200 on every machine with a `.dev.vars` --
measured both ways with the file parked, 401 without the flag and 200 with it.

**AND THE SAME STEP ORDER HAS A SECOND CONSEQUENCE, which closing the cycle is what exposed.** `sql`
running after `container` also means there is no `assets/drupal-sql/` when the container step asks
the object to migrate, so `/migrate` answered 200 in 54 ms having replayed nothing, `/fill` drained
`{"filled":null,"remaining":0}` and the read came back `400 no such table: cache_container`.
`bake-container.ts` chunks the database itself when nothing has. The stale row inside those chunks is
the point rather than a problem: the boot misses on it and rebuilds the container the script exists
to capture.

**THE CAPTURE ALSO NEEDED MORE THAN ONE RENDER, and its terminating observation is the ROW.** Two
things defeat a single pass and neither is visible from the serve's status code. Reconciliation's
`container-driver-digest` step reads a FRESH site as owed -- it has no recorded digest -- so it runs
`DELETE FROM cache_container` and deliberately leaves the rebuild to the next boot. And the serve
renders inline and answers 200, or queues and answers 503 for the fill, depending on what the object
already holds; both shapes were observed in one run.

**AND THE FIRST RETRY LOOP STILL FAILED, because a repeated path is a cache HIT.** Pass one stores
`/` in `cfw_page`, so every later serve of it answers 200 having booted nothing: four passes read
`0 row(s)` exactly like one. `RENDER_PATHS` is one distinct path per pass. Measured against a live
`wrangler dev`, the shipping `capture()` reads `pass 1 /: 0 container row(s)` then
`pass 2 /user/login: 1 container row(s) including the one wanted`, and returns 482,568 bytes at
`expire -1`. **A 200 from `/serve` is not evidence a kernel booted.**

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
bun run gen:config         # config/modules.yml -> src/ops/generated/modules.ts
bun run gen:config:check   # fail if the generated copy is stale
bun run assets:container   # rekey the packed cache_container row, then re-chunk
bun run test:health        # the sibling's health suite
bun run check:reachability # which modules the edge imports; which are dead

bun run hydrate         # a clean checkout -> deployable, from the release payload
bun run release:payload # build that payload; needs vendor/ and the packs
bun run release:check   # dry-run the canonical config and price it against the 64 MiB ceiling
bun run build:wasm      # the interpreter into .interp/ (gh auth); no docker, the decoder is gone
bun run backup:verify   # 35 live + 6 archived CDN keys, no credentials

bun run measure:abi-speed   # wasm32 vs long64 vs wasm64, interleaved, on node/V8
bun run measure:abi-control # the same harness with one binary as two arms; read this first

bun run vps:up             # the comparison arm: nginx + php-fpm 8.5 on the SAME tree and database
bun run measure:bench-site # provision a site on a running `bun run dev` so it can be driven
bun run measure:vps        # drive either arm; --workload=ceiling first, always
bun run measure:host       # drive BOTH and decide; exits 1 when the verdict is not viable
bun run build:site-db      # the pack database, from nothing; docs/architecture/database.md is the recipe
bun run check:site-db      # diff a built database against the shipped one
bun run vps:down           # tear it down, including its volume
```

**The bucket is fronted by `cdn.drupflare.com` (authoritative) and `cdn.drupflare.app`**, with the
older `drupflare-cdn.gmitch215.dev` and `.xyz` names still serving the same keys (checked
2026-10-16: one site.sqlite, 5,832,704 bytes, the same ETag on all of them). `ORIGINS` in
`scripts/backup-cdn.ts` tries them in that order, and the manifest names only the first.
`backup:verify` used to fail on Gregory's home network because it blocklists `*.dev` and answers
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`; the verify reads the manifest's origin, which is now a `.com`, so
that should no longer apply. It has not been run from that network since the change. Do not conclude
anything about the bucket's contents from a failure with that error.

**AND "RUN IT FROM CI" WAS ADVICE TO USE AN INSTRUMENT THAT HAD NEVER RUN.** Found 2026-09-14:
`manifestFromDisk()` was called unconditionally at the top of `backup-cdn.ts`'s `import.meta.main`
block, BEFORE the `--verify` / `--restore` / `--upload` dispatch. It walks `vendor/static-long64/`,
which exists only on a machine that ran `composer install`, and no runner does -- so every scheduled
run threw `ENOENT: scandir .../vendor` and exited 1 before its first HTTP HEAD. `backup.yml` then
piped through `tee` with no `set -o pipefail`, so the step reported the exit status of `tee`. **Nine
of nine scheduled runs since 2026-09-05 were green and none verified a key.** The call is lazy now
and the step sets `pipefail`.

Two things to carry from it. The recoverability of all 34 `vendor/` files -- which is the whole
reason the "never touch `vendor/`" section says a local delete is survivable -- rested on this
check, so that claim was unverified for as long as the lane was green. And a `| tee` in a workflow
step silently discards the exit status of everything upstream of it: grep for one before trusting
any lane that ends in a pipe.

`docs/getting-started/building-from-source/index.md` is the release and build procedure;
`docs/configuration/index.md` is every var and binding; `docs/architecture/database.md` is how
`assets/drupal/site.sqlite` is built and what each of its non-default values is for;
`docs/getting-started/repository-layout/index.md` says how every path arrives
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

**IT FOUND `Html::$isAjax`, and four of its own specs were red for it.** The flag is `Html::$seenIds`
one static over; `AjaxResponseSubscriber` sets it true on a `_drupal_ajax` request and nothing sets it
back, so `Html::getUniqueId()` took its `randomBytesBase64` branch for the rest of the incarnation and
**every id on every later render differed on every request.** `content-type.pw.ts` adds a field through
the field-UI modal, and `node-create.pw.ts` then could not find `form#node-page-form` because the page
said `node-page-form--iGSVurTf0ZU`. Four specs failed in the full lane and passed in isolation, which
reads as flake. `static-sweep.spec.ts`'s blind fingerprint could not have caught it: it diffs two
objects and neither makes an ajax request.

Three things had to be right before the regression test could fail, and each was wrong first:
`_wrapper_format` is a different constant on a different subscriber (`_drupal_ajax` is the trigger);
`BOUNDARY_STATE` reads the residue and the reset runs at the START of the next request, so the flag
reads 1 with the fix in place; and without `COLD_BINS` a warm `dynamic_page_cache` replays the markup
so the form is never rebuilt. **Run the control.**

**The console guard is per-STATUS now.** Chromium logs its own console error for every non-2xx
response whether or not the page handled it, so a spec asserting that a refusal renders correctly
could never pass. `test.use({ refusals: [401] })` declares the ones a spec drives; an undeclared
refusal still fails.

**`tests/e2e/browser/surface-lifecycle.pw.ts` is the one spec that drives what this project ADDS.**
The other thirteen of the fourteen drive stock Drupal pages, which is how the `/_cfw` surface reached
production with no credential at all.

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

## CI CHECKS THE SIBLINGS OUT AT THEIR LATEST CODE, and only a release pins them

Reversed 2026-10-16. For a month every lane checked the siblings out at the tags `composer.lock`
names, on the argument that a sibling commit should not be a silent release. The cost showed the same
day: the worker's baked artifacts (the driver pack and digest, the container row in `site.sqlite`)
were built from sibling code that no tag had been cut for, so Pack Suites, Browser Lane and Verify CDN
Backup were red by construction until two other repositories had released and a lock bump had landed.
"Build from source" means the latest pushed code, and nothing in a development build should wait on a
release.

`.github/actions/siblings` is the single expression of it. Its default checks each sibling out at the
branch this run is on when that branch exists there, and at the sibling's default branch otherwise.
`pin: 'true'` checks out the tag `composer.lock` names and fails loudly on a package the lock does
not pin; `release.yml` is the only caller that passes it, and `tests/node/workflows.spec.ts` fails if
another one does. A release has to be reproducible from a version. A development build has to be
current.

The consequence to know: a development build is only as reproducible as the siblings' branches, and a
sibling push does not start a worker run. The worker's lanes see it on their next push or schedule.

## The lock is authoritative now, and the chain used to be a cycle

`drupal-src/composer.lock` -> a generated map -> core version -> `fetch:drupal` -> `drupal-src`.
The tree's own lock chose the version that populated the tree, so the only thing it could confirm was
itself, and the ROOT lock sat outside the loop with nothing reading it. That is how a `composer
update` moved `drupal/core` to 11.4.6 for phpstan while the pack stayed at 11.4.5.

`composer.json` requires `drupal/core-recommended` and the four contrib modules directly now, and
the root lock is read directly (the runtime bundles it as text, the scripts read it from disk):
manifest -> root lock -> fetched tree. `tests/node/shipped-lock.spec.ts` asserts the DIRECTION rather
than mere agreement.

**A core bump reaches the pack by itself.** Measured 2026-10-16 on renovate's 11.4.7 to 11.4.10:
the tracked `site.sqlite` carried a `twig_extension_hash` and a baked container row from the old
core, the `tree` step refused to replace the tree without `--force`, and every step after it stayed
skipped because its output was still on disk. Now `tree` passes `--force` and `replacesTree` makes
every later step rerun, `bake-twig.php` rewrites the shipped twig hash row to the tree's (prefix
kept), and the `container` step rebakes when the versions hash or the driver digest the row recorded
differs. The tracked database is rewritten in a build and republished by hand with
`bun run backup:manifest` and `bun run backup:cdn`; a stale row costs speed, not correctness.

**11.4.8 stopped BigPipe handling the navigation placeholder** (`NavigationRenderer` denies
`BigPipeStrategy`), so an admin's navigation is rendered into the page and is no longer one more
hole than a member has. `shell.spec.ts` and `static-sweep.spec.ts` accept either arrangement.

**It was also a correctness fix.** With no `core-recommended` the root resolved symfony 8.1 while the
site runs 7.4, so static analysis was reading a different framework. Two things not to break:
`allow-plugins` must carry `composer/installers: false` or `composer update` refuses to run, and the
spec compares at MAJOR.MINOR because 19 transitive patch versions in the baked map are legitimately
ahead of a tree resolved weeks earlier.

**The root's phpstan is at 56 errors, always has been, and is gated nowhere** -- verified against the
old manifest and lock, same count. Not caused by this.

## Conventions

- `bunx`, never `npx`.
- **Never capture the return of `require_once`.** It answers `true` when the file is already
  included, so `$GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php'` yields the boolean
  rather than the ClassLoader, and the next `addPsr4()` fatals with
  `Call to a member function addPsr4() on true`. **A heap restore reaches exactly that state**: it
  brings back the included-files table and `__pw_site_booted` without every global beside them, so
  the `!isset()` guard opens onto an already-included file. Use `require` and guard on the VALUE
  (`!is_object(...)`); composer's `getLoader()` memoizes, so re-requiring costs nothing and
  re-registers nothing. `tests/integration/heap-restore-autoload.spec.ts` is falsified against it.
- **A backtick inside a comment in a `String.raw` block terminates the block**, and a comment is
  where it is least expected. Writing ``// `require` rather than `require_once` `` inside a PHP
  fragment broke the TypeScript, not the PHP. Rare now that the PHP lives in real files under
  `src/site/php/`, but any remaining `String.raw` block still carries it. The apostrophe hazard is
  recorded below; this is the same shape one punctuation mark over.
- **Never pass fflate's `{ out }` hint to `inflateSync`.** A preallocated buffer makes it TRUNCATE
  to that length and return quietly, so a payload longer than the buffer inflates to exactly the
  length a caller would compare against -- right length, wrong content, which is this repository's
  signature failure. Measured: a 2,048-byte payload against `{ out: new Uint8Array(999) }` returned
  999 bytes and threw nothing. Let fflate allocate and check the length afterwards. Same shape as
  `node:sqlite` cutting a TEXT value at its first NUL, and as `length()` in SQL doing the same --
  the seed's cache bins read 397,804 bytes that way against a true 1,072,666, because serialized PHP
  carries NULs. `src/db/heap-store.ts`'s `unpackChunk()` is the only caller that wanted the hint;
  `src/site/shims/zlib-fix.ts` and `package-install.ts` never passed one.
- **A constructed `Request` sets no `content-length`, and `bodyTooLarge()` reads exactly that
  header.** So a spec posting an oversized body through the front worker does NOT trip the cap unless
  it sets the header itself; it falls through to whatever gate comes next and passes for the wrong
  reason. Measured: the same case read 401 without the header and 413 with it, and the docblock
  written from the first reading explained an ordering that does not exist.
- **`src/site-do.ts` is detected as BINARY by grep, so a plain `grep` over it silently returns
  NOTHING.** Not an error, not a warning, no matches. Two sessions have concluded a function was
  missing from it on that evidence. Use `/usr/bin/grep -a`, or `rg`, or the Grep tool.
- Absence is `undefined`: `x?: T` for properties and options, `T | undefined` for returns, not
  `T | null`. `null` stays at the boundary, where it differs from absent: JSON that leaves the
  process (`JSON.stringify` drops undefined keys, so a `/serve-stats` field would vanish), SQL NULLs,
  PHP replies, and platform APIs that return `null`. Convert at the edge with `?? null`.
- Paired state is one object: `lastCron?: { at, value }`, not `lastCron` plus `lastCronAt`; emitters
  keep their old keys.
- Every export, class property and non-delegator method has a one-line TSDoc; delegators
  (`return fn(this, ...)`) have none, their function does.
- Relative imports omit the extension (`from './site-do'`); `moduleResolution: bundler` resolves
  them under tsc, vite and esbuild. The one exception is `from './runtime/php-binary.js'` in
  `src/site-do.ts`: wrangler aliases that exact string, and any other spelling bundles the default
  seam. `tests/node/import-specifiers.spec.ts` guards it.
  **A file a `node`-run script reaches cannot use one.** Plain node resolves a relative specifier as
  an exact path, so `src/ops/packed-container.ts` (read by `scripts/pack-sql.ts`) and
  `src/db/heap-store.ts` (timed by `scripts/measure/heap-digest-cost.ts`) keep no relative imports.
  A DRY pass gave both `../util` imports and `build:local` failed with the gate green. The same
  spec walks every script a `node ...` invocation names and fails on a specifier node cannot find.
- **Check `pragma_table_info` before an `ALTER TABLE`; never wrap one in `try`/`catch`.** A
  caught-and-ignored `ALTER` inside `ensureServeTables()` still dirties `sqlite_master` on every call,
  and that took the serve path into `migrate: starting` on 2 of 3 runs. The exception is not the cost;
  attempting the statement is.
- `src/probes/**` are frozen measurement instruments cited by figure in the report. Moving a file
  does not change what it measures; rewriting it might. Do not refactor them.
- The PHP source lives under `src/site/php/` and is packed by `scripts/gen-assets.ts` into
  `src/site/generated/assets.ts`; run `bun run gen:assets:check` after editing any of it.
  `src/drupal/*-php.ts` still hold a few `String.raw` blocks (composition helpers go through
  `phpWhen`/`phpScript` in `src/util/php.ts`). A backtick inside a PHP comment truncated a block
  and broke the PHP while leaving the JavaScript valid - this has happened twice.
  `tests/node/php-fragments.spec.ts` runs `php -l` over the compositions; keep it green.
  **An APOSTROPHE is the same hazard one level in.** `PW_SERVE_INLINE` is embedded in a
  single-quoted PHP string, so a `'` anywhere inside it - including in a `//` comment, where it
  reads as ordinary prose - closes that string and the next word becomes a stray identifier.
  Writing "the status report's Web server row" in a comment produced
  `syntax error, unexpected identifier "s"`. Say "the Web server row on the status report" instead.
- **A shim over an INTERNAL PHP function does not need `eval()`.** A conditional function
  declaration is bound at runtime, not at compile time, so
  `if (!extension_loaded('zlib')) { function gzencode(){} }` compiles clean on a build that HAS
  the extension and the branch never runs. The PHP fragments now live as real files under
  `src/site/php/` (packed by `scripts/gen-assets.ts` into `src/site/generated/assets.ts`), so
  `php -l` sees inside every one of them. `src/site/php/mb/fix.php` is the one that still cannot be
  linted STANDALONE, because it redeclares internal `mb_*` functions; the fragment gate lints it
  wrapped in `phpWhen('true', ...)`.
- `experiments/` is prettier-ignored: probe configs kept for reproduction, not maintained.
- Comments: lowercase, terse, one line, no trailing period, only where the WHY is non-obvious.

## Deploying, when authorized

The account has **real production workers**. Use a `cfw-*` name, tear down immediately, and verify
the worker list returns to exactly its prior baseline -- workers AND
`workers/durable_objects/namespaces`, because a DO deploy leaves one behind and the worker list
alone will not show it.

**THE FREE ACCOUNT IS A SEPARATE ONE**: `FREE_CLOUDFLARE_ACCOUNT_ID` / `FREE_CLOUDFLARE_API_TOKEN`
in the shell profile, exported as `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`. As of 2026-09-25
it holds two KV namespaces and no workers: burrow's `burrow-e2e2` rig finished and was removed.
Record the inventory before a run and diff against it, and check nothing else has moved onto it before
spending its daily allowance.

A DO-namespace deploy needs ~60 s propagation before `stub.fetch()` stops returning "Worker not
found" - wait, do not debug it.

**THE 50 MB ASSET SUBSET UPLOADS FINE, and this file said it fails.** That was true of the whole
tree before `.assetsignore`; the deny-by-default list is what made the canonical config deployable,
and the published set measured 50 MB and uploaded in **32.93 s** on 2026-09-10. What still does not
deploy unmodified is the config's other bindings -- `CONFIG_KV`, the `drupflare-files` R2 bucket and
the `drupflare-fleet` D1 database do not exist on the free account, so a measurement deploy strips
them and keeps `durable_objects`, `assets`, `migrations`, `alias` and `rules`.

**`cpuTime` COMES FROM `workersInvocationsAdaptive`, AND `scriptName` ONLY WORKS AS A FILTER.** As a
DIMENSION it answers `__unknown__` on this account, so a per-worker breakdown taken that way
attributes nothing; pass `scriptName` inside `filter` and query one worker at a time. The dataset is
in MICROSECONDS and lags a few minutes, so mark the window before driving and re-query until the
request count stops rising -- a first read gave 9 of 20 requests and a p50 two thirds higher than
the settled one.

Measured 2026-09-10 on a deployed free worker, `/` served from `cfw_page` with every request
reaching the object: **cpuTime p50 4.14 ms, p90 7.50 ms, p99 9.15 ms (n=14, 0 errors)**, wallTime
p50 57.4 ms.

`wrangler deploy --dry-run --outdir=<tmp>` does not deploy and is the only cheap way to prove an
entrypoint and its binary alias still resolve.
