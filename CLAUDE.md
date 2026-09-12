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

## There is a VPS arm now, and the headline ratio was an instrument error

`docker/vps.yml` is nginx plus PHP 8.5 FPM with opcache and tracing JIT, against the SAME
`drupal-src` tree and the SAME `assets/drupal/site.sqlite` this project serves. `bun run vps:up`,
then `bun run measure:vps`. Bodies agree to 10 bytes, and the generator's own ceiling is 7,330 req/s
so it constrains neither arm.

**MOUNT `drupal-src` READ-ONLY, and this rig learned it the hard way.** The first version bind-mounted
it read-write; the entrypoint wrote its own `settings.php` into
`drupal-src/sites/default/settings.php`, which is the build input for the shipping pack, and
`twig-bake.spec.ts` went red on a tree nobody had edited. That is the same silent-drift shape as the
`cdn-manifest.json` restore overwriting a tracked artifact. The site directory is a separate writable
volume now. Recovery, if it happens again: the installer's output survives at
`drupal-src/sites/build/settings.php`, so copy it over and re-run `node scripts/patch-drupal.mjs
drupal-src` to re-append the twig `php_storage` pin.

Measured 2026-09-07, both arms on localhost: anonymous cached p50 **3 ms VPS against 2 ms drupflare**
and p95 **49 against 4**; at 32 clients the VPS collapses to 122 req/s while drupflare holds 438; a
re-render with Drupal's bins warm is **25 ms against 32**.

**THE AUTHENTICATED ARM'S FIRST READING WAS MEASURING A TIER THAT COULD NOT RUN.** It read 9 ms VPS
against 31 drupflare. The rig was discarding `x-cfw-plan`; capturing it showed `skip:set-cookie` on
six consecutive authenticated GETs, because `planEligibility()` refused any response carrying
`Set-Cookie` and PHP re-sends the session cookie on every `session_start()` when
`session.cookie_lifetime` is non-zero, which Drupal ships at 2000000. The compiled-plan tier had
never compiled a plan on any site, and 25 assertions covering it all passed a synthetic
`setCookie: false`. **Capture the tier header before believing a latency number from this rig.**

With that fixed, plus a `csrf` slot and a private key for a single-editor site, a session converges at
request 4: `/` 11 ms VPS against **5 ms**, `/admin/content` 71 against **5**, `/user/1` 56 against
**5**. Under concurrency drupflare wins every cell but one tie and holds ~312 req/s flat from c=4 to
c=32 while the VPS declines. Use `--ceiling-path` for the generator control: the arms share no no-work
endpoint, and `/robots.txt` is a deny-list 404 on drupflare that reads 109 req/s against the
generator's real 1,231.

**THE "225x" AN EXTERNAL REVIEW COMPUTED IS THIS PROJECT'S OWN SIGNATURE ERROR.** It divided the
2,127 ms edge `cpuTime` for a BOTH-BINS-EMPTIED render by the 9.47 ms native WARM-KERNEL render: two
workloads, two instruments, two machines. Same machine and same bins, a re-render is **1.28x**.

Three things the rig cannot say, and each has bitten a comparison before:

- **Localhost is the VPS's best case.** A VPS is one region; drupflare answers from the visitor's
  colo. The network term is absent and must be added back before an end-to-end claim.
- **`wrangler dev` is one local workerd**, so throughput there is a property of the laptop. Absolute
  CPU still comes only from `cpuTime` on a deployed worker; what this gives is a same-machine RATIO.
- **The authenticated arm ran with no replica lanes and no compiled plan.** A plan is 0 ms median and
  max, n=57 deployed, and it needs two sessions in a role set to agree before it compiles, which one
  benchmark client never gives. **A single-editor site therefore never gets one** -- correct as a
  safety property, and a real coverage hole.

## Scoring a Proposal

Free's limits are aggregate daily budgets, not the 10 ms per-invocation cap. There are two ceilings:
serving is bound by Worker requests at 100,000/day, regeneration by rows written at 10,869/day
windowed and 2,777 on the alarm chain -- so regeneration is the tighter one by 12x and 36x
respectively. Score with `bun scripts/measure/free-envelope.ts`, which fails a workload that misses
either. (This paragraph carried an unsourced "476x" that no file derived and neither ratio produces.)

**The 10 ms cap does not fail a request, measured 2026-09-07: a 1,882 ms `cpuTime` invocation
SUCCEEDED on a deployed free worker.** Before refusing anything because "it will not fit in 10 ms",
check whether that refusal was ever measured. This project has been wrong about it in both
directions, and so is `@gmitch215/tinyimg`'s README, which tells its users a request either fits or
fails.

**A rows-saving feature can cost more rows than it saves, and one did.** Scoped invalidation's
`tag -> paths` index as a `(tag, path)` TABLE took rows per fill from 9 to 39. Folded into the page
INSERT as a column it costs 0. Price the index against the meter the feature exists to move, on the
same instrument, before building the second half.

A cache hit still costs one Worker request, and decomposition spends the DO quota it is trying to
dodge. Rows-per-fill is 2 to 156 depending on what is already warm, not a flat number, and
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

## The database HAS a producer now, and four claims here were stale

`assets/drupal/site.sqlite` is **5,349,376 bytes** as of `3e4f2737` and
`scripts/drupal/install-site-db.php` builds it
from nothing. `docs/database.md` is the recipe; `bun run build:site-db` runs it and
`node scripts/diff-site-db.ts` is the acceptance check. Measured 2026-09-09, a fresh build against
the shipped file agrees on **41 modules of 41 and 175 config rows of 175**, with every remaining
difference attributed.

**This section said the opposite until 2026-09-09, and each correction is worth knowing:**

- "6.6 MB" was the superseded R2-archived lineage `site.sqlite.trimmed-1618p-cc13` at 6,627,328
  bytes, pinned in `scripts/backup-cdn.ts`. It then read 7,585,792 from 2026-08-14, and 5,349,376
  since `3e4f2737 chore: rebuild the packed database at 11.4.6`. **Count it, do not quote it** --
  this line has been wrong twice.
- "nothing in this repo produces it" -- `install-site-db.php` had existed for two weeks and
  `bake-pack.ts` already said so. What had no producer was three DELTAS: the `page_content_type`
  recipe, enabling `drupflare`, and 16 cache index drops. All three are in the script now.
- "the build input is 14.4 MB" named the **wrong file**. `drupal-src/sites/default/files/.sqlite` is
  5,222,400 bytes; the ~14.4 MB one is the gitignored intermediate `assets/drupal-std/site.sqlite`.
- the 3 MB gzipped ceiling it argued against **no longer exists** -- see the section on that below.

**AND ONE TRIM THE SCRIPT WAS DOING HAD EXPIRED.** It forced `system.advisories:enabled` false for
"no outbound socket". The stream wrapper and the park landed, `CRON_HOOKS` runs `system` and
`update`, and the shipped pack has carried `enabled: true` in all six of its committed versions -- so
the trim was wrong about the runtime AND about what it was reproducing. Same shape as the three
`run: false` entries that outlived their reason.

Prefer a rebuild to a surgical edit now. Where an edit is still right, the two rules below hold.

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

**AND A SURGICAL EDIT TO A TRACKED ARTIFACT IS REVERTED BY `bun install`.** `assets/drupal/site.sqlite`
is tracked AND has a `cdn-manifest.json` entry, and the entry named an older lineage, so
`restore-artifacts.ts` overwrote the file on every install and turned `container-cid.spec.ts` red on a
tree nobody had edited. The entry is now marked `tracked: true` and the restore verifies it and leaves
it alone; `tests/node/cdn-manifest-agrees.spec.ts` fails if the two disagree again.

**So prefer a BUILD STEP to a hand edit whenever the artifact is tracked.** BUG 4's watchdog trim was
first made by hand and is now `dropBakeHistory()` inside `pack-sql.ts`, which is reproducible and
survives a restore. A hand edit is correct only where nothing in the repository produces the file, and
`site.sqlite`'s trim recipe is the one case of that.

## A shared base has nowhere to live, and the read-through was never the hard half

Measured 2026-09-08. The premise holds and is stronger than when it was written: three
independently provisioned sites are byte-identical after `/migrate` except one `cfw_meta` row -- 20
of 21 tables, 1,281 of 1,282 rows -- and `bun scripts/measure/per-site-census.ts` reads the same
thing on workerd at `seedSharedFraction` 0.9992 and `warmSharedFraction` 0.9488. A fresh site is
4,726,784 bytes of which ~96.6% is the pack.

**THE QUERY LAYER IS NOT WHERE THIS DIES.** A read-through costs **1.35x** on the statement, measured
against the real `site.sqlite` with the pack's own indexes over six statement shapes taken from a
traced render, 2,000 iterations each, three runs (1.35/1.35/1.37, range 0.97-1.69), every row count
agreeing including a JOIN whose two sides sit in different layers. The overlay resolves as
`t_T UNION ALL base_T WHERE NOT EXISTS (...)`.

**IT DIES ON WHERE THE BASE CAN PHYSICALLY BE, and all three exits are closed by measurement:**

- **`ATTACH` is refused.** `ATTACH DATABASE ':memory:' AS base` answers `SQLITE_AUTH`, and so does
  `PRAGMA database_list`. A second file cannot join the tenant's engine.
- **`execSql()` cannot await.** `module.cfwSqlExec = (json) => withMask(() => ... JSON.stringify(...))`
  in `@drupflare/durabledb/src/do-sqlite.ts` is synchronous by construction, so KV, R2, D1, another
  Durable Object and `env.ASSETS.fetch()` are all unreachable from inside a read. That last one
  matters most: the pack chunks themselves arrive by `env.ASSETS.fetch()` in `src/db/migrate-sql.ts`,
  so even a lazy fill cannot reach its own source from a statement.
- **The interpreter carries no SQLite.** PHP 8.5.2 reports `pdo_sqlite=no`, `sqlite3=no` and an empty
  `PDO::getAvailableDrivers()`, verified on `.interp/php8.5.wasm` under node and through `/php` on
  workerd. PHP cannot open `assets/drupal/site.sqlite` in process.

What IS reachable is anything already resident: the 62 chunks parse in **4.5 ms (n=3)** and retain
**3.79 MiB** indexed by table, which fits both the 1,000 ms startup budget and the 16 MiB between
`recycleAboveBytes()` at 117,440,512 and the 128 MiB isolate. Resident rows are not a queryable base
though, and that is the gap nothing closes.

Two mechanisms follow from that and both are refused with a number:

- **Lazy per-table materialisation** needs no engine, and saves **2.03% of base rows / 2.18% of base
  bytes**. Driven over `/`, `/user/login`, `/node/1` and `/user/password`, 16 of 20 base tables are
  read; the four that are not are `cache_file_parsing`, `cache_render`, `cfw_page` and `users`, and
  `users` goes on the first authenticated request. Deleting `router`'s 419 rows takes `/user/login`
  from 18,418 bytes to 57.
- **A separate base Durable Object** needs the park, which resolves inside one invocation -- so the
  meter is SUBREQUESTS, not requests. A cold first render issues **224** statements and a warm one
  **31-48**, against free's 50. At even a 1 ms hop the warm path adds 31-48 ms to a serve the plan
  tier answers in 5.

**THE SURVIVING OBJECTIVE IS PER-TENANT STORAGE, and it is a hard cap rather than a bill.**
`FREE_QUOTAS.storageBytes` is 5 GB account-wide, so 4,726,784 bytes per site is 1,057 sites and
nothing else in the model says so. The one lever the measurement handed over needs no overlay at
all: **the seed's eight cache bins are 1,549,471 bytes of its 2,933,572 row bytes, 32.8% of the
4,726,784 the object stores**, and every one of them can be emptied with the front page still
rendering byte-identical. `cache_container` must stay -- a rebuild is 1,024 ms against 86. The other
seven are 1,067,229 bytes, **22.6% of the stored database**, for at most 44 extra statements on the
first render.

Sharing across tenants needs both layers in ONE object's SQLite, which means many tenants per object.
That is a topology change and it is not the item as scoped; within one tenant's own object there is
nothing to share and the overlay saves zero.

## The interpreter has no fiber backend, and the executor is persistent

Both measured 2026-09-07 on the shipping binary, and the second is the useful half.

**`new Fiber(...)->start()` aborts the runtime**: `Aborted(missing function: getcontext)`. php-src's
ucontext branch needs `getcontext`/`makecontext`/`swapcontext` and emscripten implements none of them;
`vendor/static-jspisjlj` has the identical stub list, so **JSPI does not supply one either**, and
`-sSUPPORT_LONGJMP=wasm` cannot -- it is one-way and `swapcontext` needs two. This project already knew:
`FIBER_SHIM` / `PhpWasmSyncFiber` in `src/drupal/site-php.ts` exists because of it, and
`scripts/patch-drupal.mjs` rewrites core's five `new \Fiber(` sites to it. Do not re-propose fibers,
and do not propose writing a wasm `zend_fiber_switch_context()` -- that is strictly more work than
JSPI for the same capability.

**`pib_run` performs no `php_request_startup`/`shutdown` cycle.** `$GLOBALS` persist across `_run()`,
a class declared in run 1 exists in run 2, and a `register_shutdown_function` from run 1 never fires.
**A parked GENERATOR therefore survives a Worker invocation** -- suspended in `$GLOBALS`, resumed on a
later invocation with a host-supplied value, completed on a third. Its limit is the coloring problem:
`yield` suspends only its own frame, so it serves code written for it and cannot retrofit Predis,
Guzzle or the renderer. And a parked continuation lives in linear memory, so `recycleIfOversized()`
destroys one silently -- it needs a terminating OBSERVATION, like `/user/password`.

The premise behind the fiber proposal, "Zend already manages the continuation", is true of generators
and false of fibers: a generator copies `execute_data` and the VM stack to the HEAP, a fiber switches
a real C stack.

## The Zend park ships, and every instrument that measured it was wrong once

`ext/cfwpark` in phasm freezes the continuation of a trapped blocking call, `longjmp`s out of
`pib_run` and returns `PARKED`; `src/ops/park-drive.ts` reads what was asked for, performs it in JS,
and resumes the chain, all inside ONE invocation. `src/ops/park.ts` reports whether the interpreter
can do it at all. `drupal/redis` is what it exists for -- a cache get has to answer inside the
request that asked, which is the one shape the deferred tier cannot serve.

**IT WORKS, measured 2026-09-08 on the long64 build against the rig Redis.** PHP opens a socket,
writes and reads twice, and receives `+OK|+PONG` -- five parks, each performed in JavaScript on a
LATER invocation and resumed back into the same PHP chain. A real Drupal render with the traps armed
reports `done` too, which is the check that matters before arming: the render goes through
`cfw_park_run`, and that is `zend_eval_string` rather than a script.

It took two extension fixes, and BOTH FAILED SILENTLY:

- **`cfw_park_resume` did not re-arm.** `park_armed` was 0 for the whole resume, so every trip after
  the first ran the real function. A fall-through is the refusal path, so it looked deliberate.
- **The safety predicate's floor was a frame from the invocation that STARTED the chain.** On a
  resume the walk went past the parked chain into reused VM stack memory -- reading first as a
  refusal, then as `RuntimeError: memory access out of bounds`. A resumed chain now relinks its root
  to the resuming frame, which is what `zend_generator_resume` does and what this never did.

**AND A FOURTH, ON THE HTTP HALF: an UNQUALIFIED CALL INSIDE A NAMESPACE resolves at runtime, and
that is why every harness read this safe while every render refused.** `call_user_func_array` leaves
no frame at all -- `zend_compile_func_cufa` rewrites it to `ZEND_INIT_USER_CALL` -- but the rewrite
needs the compiler to have resolved the name, and an unqualified call inside a namespace compiles to
`ZEND_INIT_NS_FCALL_BY_NAME` instead. So the frame is REAL in every namespaced file, which is all of
Drupal, and ABSENT in the global namespace, which is where every synthetic harness in this project
was written. Measured on native 8.5.7: 3 frames through `Probe\Ns\viaUnqualified` against 2 through
`\call_user_func_array`. Measured on the shipping interpreter through the real pack: one internal
frame between `FormBuilder::retrieveForm` and the form callback it dispatched, with `array_map` at 1
as the control and the same line inside an `eval` at 0.

`ext/cfwpark`'s docblock had asserted the opposite and named the compiler as the reason, which is the
half that was true. **A claim that holds in the global namespace is not a claim about Drupal.**

**`park_flatten()` SPLICES SUCH A FRAME OUT rather than refusing it.** The frame's whole remaining
job is to copy its callback's return value, and `zend_leave_helper`'s nested path already does that
for an ordinary call -- so the callee is relinked to the trampoline's caller and its `ZEND_CALL_TOP`
cleared, and the return lands at `opline + 1` of the `DO_FCALL` that entered it. `cfw_park_resume`
needed no change at all. `call_user_func` and `call_user_func_array` are the whole list, and adding a
name means asserting six invariants of php-src's implementation of it; `array_map`, `usort` and
`iterator_to_array` all still refuse, which is the control that makes the change mean anything.

**The splice has a NATIVE gate, which is legitimate here for one reason: it measures the predicate
and the frame surgery rather than the resume.** `phasm/src/ext/cfwpark/tests-dispatch.php` against a
`phpize` build -- `phpize && ./configure --enable-cfwpark && make`, then
`php -n -d extension=modules/cfwpark.so tests-dispatch.php` -- is 20 assertions, and both halves are
falsified: disable the splice and 5 fail with the chain silently truncating, count trampolines unsafe
again and 7 fail with every park refused. `-n` matters, because Xdebug installs its own execute
handler. The RESUME is still a wasm question, since homebrew is the HYBRID VM and this build is
`ZEND_VM_KIND_CALL`, and `park-oidc.spec.ts` is where that one is answered.

So `blockingOutbound` is TRUE and `drupal/openid_connect` completes a login through its OWN client:
`park-oidc.spec.ts` drives a real authorization code from the rig Keycloak, and the token POST and
the userinfo GET are both parked, after which `externalauth` writes `openid_connect.keycloak` into
`authmap` against the id_token's `sub`. The control beside it is the same run on the previous
interpreter, where the deferred transport answered `is not in the fetch cache` and no row was
written. A refused park still falls back to the deferred transport rather than rejecting, because
rejecting made it strictly worse than what it replaced: every Search.gov render answered 500 until
the fallback existed. **A refused park must degrade, never fail.**

**THE ARTIFACT IS THE THING TO CHECK, and `cdn-manifest.json` names the OLD binary.** A `bun install`
downloads the published interpreter, which has no `park_flatten()`, so it silently replaces a build
the capability depends on. `park-dispatch.spec.ts` pins the flag against the reading for that reason:
on a reverted interpreter it fails and names the frame instead of leaving `SHIPPED_BLOCKING_HTTP`
claiming something the binary cannot do.

Two arming rules survive. Both classes stay gated on their capability, because arming one the park
cannot serve routes every render through `cfw_park_run` for a yield that always falls back -- measured
when `fetch` was armed unconditionally: `serve-chain` read a render estimate of -1. The `socket` class
additionally waits for `REDIS_URL`, because its read/write traps divert every file write inside a
parked run; `fetch` needs no endpoint, since the destination is whatever the module asks for and the
SSRF guard is what bounds it. **That guard had its own defect**: `classifyParkOp` called
`refuseOutbound()` directly while every other outbound path goes through `outboundGuardEnabled()`, so
`OUTBOUND_GUARD=0` -- which exists for the rig -- turned the guard off everywhere except there.

**THREE INSTRUMENTS MEASURED IT AND ALL THREE WERE WRONG, in both directions.** That is the part
worth carrying, because the mechanism was declared working and then declared impossible before it was
either:

- **A flat native harness said it worked.** Run and resume from the same scope put the resume's frame
  in the slot the run's just vacated, so the stale parent pointer and the live one were the same
  ADDRESS and the walk terminated by coincidence. It printed `trips=3` and `DONE`, and that reading
  carried the mechanism forward for a session; its remaining assertion, that each answer reached the
  call that asked, was never reached because the test fataled on its own reporting line first.
- **A native PHP said it was impossible.** Homebrew 8.5.7 runs the HYBRID VM and this build runs
  `ZEND_VM_KIND_CALL`. Native reported a resumed chain never unwinding into its caller; the wasm build
  unwinds it correctly. **Do not use a native PHP as the oracle for the park.**
- **The capability vector could not express the capability.** A contract probe is one PHP expression,
  so its run and its resumes all land in one `_run` -- and a host able to answer inside one `_run`
  would not need a park at all. It answered true for something the product could not use. It is
  `socket.park.inline` now, named for what it measures, and `blockingSocket` is a LITERAL beside
  `SHIPPED_CRON` for the same reason that one is: the flag and the vector answer different questions.
  `park-interpreter.spec.ts` is where the cross-invocation case is asserted, against a real server.

**`function_exists('cfw_park_run')` IS THE WRONG PROBE, and it is the decorative kind.** The first
built revision exported every symbol and did not re-arm inside `cfw_park_resume`, so a chain parked
ONCE and then ran its next trapped call for real. A fall-through is the refusal path, so it looks
deliberate and nothing reports it -- and every real exchange is multi-trip, so the capability was
absent on a build the symbol check called complete. `socket.outbound.blocking` in
`capability-contract.ts` takes two parks in one chain and requires the second, which is why it reads
false on a build that carries every `cfw_park_*` symbol.

**`blocking-outbound` AND `blocking-socket` ARE TWO CAPABILITIES, and both are TRUE now.** The park
serves each by a different route, which is why one flag could not describe them: a trapped
`stream_socket_client` / `fwrite` / `fgets` parks directly, while `fopen('https://...')` still
cannot, because the HTTPS wrapper is userland invoked from the INTERNAL `fopen` and a park under one
of those is refused -- correctly, since `fopen`'s C locals cannot survive the `longjmp`, and unlike a
dispatch trampoline it has real work left to do afterwards. So HTTP is served by REPLACING the
transport rather than by trapping it: `ParkFetchHandler` is plain userland and yields from there.
Keeping the two separate is still right, because the mechanisms are different and either could
regress alone.

Four things the wiring had to get right, each of which was wrong first:

- **`_run`'s return value is not the output.** php-wasm delivers printed text through an `output`
  EVENT, so a probe reading the return value reports `absent` on every build. The seam is `runText`.
- **The token a trapped open returns is minted in PHP, not in JS.** `cfw_park_resume` copies a zval
  and JS cannot construct a PHP resource, but the resume fragment is PHP the host composes -- so it
  opens a `php://memory` stream and hands that back. Predis calls `is_resource()` on the result, so
  an integer handle fails as a connection error naming nothing.
- **That token is opened `r`, and the read-only mode is the failure mode talking.** A refused park
  falls through to the real function, which would write the RESP command into the token and read
  nothing back -- a corrupted conversation rather than an error.
- **A run that does not finish must be unwound before returning.** `cfw_park_run` throws when a chain
  is already parked, so one refusal left in place makes every later render on that interpreter fail
  with `cfw: a chain is already parked`: a permanent fault out of a transient one.

**Traps are global for the duration of a parked run**, so a render that writes a file arrives at the
loop on a handle the host never minted. It is performed rather than refused, in PHP, because `fputs`
is a separate `zend_function` carrying its own copy of the handler pointer and so survives trapping
`fwrite`. `fread` and `fgets` have no alias and are rebuilt from `stream_get_contents`; `fclose` is
not trapped at all, because it has neither. Arming happens only when `REDIS_URL` is set, so a site
that never asked for Redis is untouched.

## Two defects that only a browser and a rig could find, and both were on every site

Recorded because the shapes recur, and 4,451 gate tests were green through both.

**A `settings.php` assignment naming a plugin of a module a site may not have is a 500.**
`system.mail:interface.default` was forced to `cfw_mail` unconditionally. `cfw_mail` belongs to
`drupflare`, the shipped `core.extension` does not carry it, and `MailManager` throws
`PluginNotFoundException` on an id it cannot resolve, so **`/user/password` answered 500 on every
site**. An assignment cannot know whether its provider is installed; `Config\MailInterfaceOverride`
can only run when the module is there, and it yields to `smtp`. Assert both directions.

**A path the fill chain proves it cannot store retries forever.** `/user/password` renders in 402 ms
and Drupal marks it `private, no-store` for its CSRF token, correctly, so the fill renders it,
declines to store it, deletes the queue row, and the next visitor gets 503 `warming` and re-queues.
On an idle object that never converges. `noteStorable()`/`isUnstorable()` record the verdict and the
cold inline refusal is lifted for a path the chain has PROVEN it cannot satisfy. A retry loop needs a
terminating OBSERVATION, not just a bound.

The third one is the instrument: `watchdog-show` threw on the first real log row it read, because
`unserialize(allowed_classes: false)` yields `__PHP_Incomplete_Class` and casting one to string
throws. It is the command that found the mail defect.

## The compressed bundle limit is GONE, and it was shaping the architecture

Cloudflare removed it on **2026-09-04**: the Worker size limit is now **64 MiB UNCOMPRESSED on both
Free and Paid**, and their docs say "There is no compressed size limit. Only the uncompressed bundle
size counts." The 3 MiB gzipped ceiling this project spent two sessions engineering around no longer
exists.

Measured 2026-09-10 on the canonical config: **14,481.28 KiB uncompressed against 65,536 KiB, which
is 22.1%.** Its gzip figure is 4,621.13 KiB, so this configuration was impossible six days ago. The
figure moves with `src/`; `bun run release:check` prints the current one.

**The interpreter therefore ships as a raw `CompiledWasm` import.** `src/runtime/php-binary-raw.ts`
replaces the brotli seam: no `brotliDecompressSync`, no `new WebAssembly.Module`, and the
`CompiledWasm` rule for `**/*.wasm` was already in `wrangler.jsonc`. Verified boot on
`wrangler dev --local`: PHP **8.5.2** with the full extension list.

**STARTUP MEASURED ON A DEPLOYED FREE WORKER: 4, 5, 5, 6, 7 ms (n=5, median 5)**, re-measured
2026-09-10 on a worker importing the seam and nothing else, against brotli's 104/105/107/112
(median 106) and the zstd-through-wasm path's 233/234/246. **21x cheaper**, 0.5% of the 1,000 ms
budget rather than 10.6%. The bigger module is the cheaper one, because the platform compiles it
ahead of time and the work at startup is what cost.

**THE WHOLE WORKER IS 33 ms, and the seam is 5 of it.** Same account, same session, the canonical
config at 14,481.28 KiB against the seam-only 13,584.15 -- so the front worker's own module scope is
~28 ms, still 3.3% of the budget. Quote whichever answers the question being asked; the 5 ms is a
statement about the interpreter and not about a deployment.

Startup is NOT billed to a request (0-1 ms of request `cpuTime` across three cold isolates), so this
is a limit-compliance figure rather than a latency one. It still matters: a Worker over the limit is
refused at upload, and 10.6% of the budget spent on decompression was headroom nothing else could use.

**What this reopens.** Anything previously refused for bundle size is now unrefused and needs
re-scoring, not re-refusing: the asset aggregates that were held off by artifact size, additional
baked modules, and any capability that lost to the meter rather than to a limit. What did NOT change
is the 1,000 ms startup budget and the 128 MB isolate, and those are the real constraints now.

**AND THE CHECK ITSELF WAS STALE, which is the part that would have bitten quietly.**
`bun run release:check` scored the GZIPPED figure against 3,145,728 and therefore failed a bundle
that deploys -- a gate enforcing a limit that no longer exists reads exactly like a real regression.
`SIZE_CEILING` is 67,108,864 and the check reads wrangler's `Total Upload` line; the gzip figure is
still printed because every historical measurement in the report is expressed in it, and is no longer
compared against anything. **When a platform limit moves, grep for the constant before trusting any
gate that mentions it.**

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
Every entry today is legitimately off the edge: `src/ops/dormancy.ts`, `src/ops/module-table.ts` and
`src/ops/mutation-oracle.ts` are build-lane or discovery instruments driven by their own vitest
specs, and `src/runtime/php-binary-{jspi,o2,raw}.ts` are alias targets reached through a wrangler
`alias` rather than through an import. The list may shrink without ceremony; **adding to it is the
thing to think twice about**, because an entry is a promise the module is reached some other way
rather than a way to silence the check.

**`dead` MEANS "not imported from the wrangler `main`", NOT "unused", and the difference matters
before anyone deletes one.** `php-binary-raw.ts` is on that list and it is the SHIPPING interpreter.
`module-table.ts` renders the contrib table in the README and is pinned by 13 assertions. The o2 and
jspi seams are named by six configs under `experiments/wrangler/`. Check what aliases a file before
concluding nothing reaches it.

**`php-binary-zstd.ts` WAS orphaned and is deleted, 2026-09-07.** No shipping config and no
experiment config named it: the arms alias o2, jspi and 85, and the shipping alias is now the raw
import. The zstd PACKER survives, because `pack:wasm` still frames the 8.3 binary and the experiment
arms. That is the shape to look for -- a live producer says nothing about its consumer.

## The heap image is a COST on both meters, so the producer is off by default

Measured 2026-09-09 on two deployed free workers differing only in `HEAP_IMAGE` and `HEAP_SNAPSHOT`,
`cpuTime` on the cold render, nothing asked of the object during the idle:

| arm      | cpuTime (ms)                 |   n | median    |
| -------- | ---------------------------- | --: | --------- |
| imaged   | 2020, 1908, 1937, 1561, 1912 |   5 | **1,912** |
| no image | 1277, 1343, 1113, 1251       |   4 | **1,264** |

The ranges do not overlap: the imaged minimum 1,561 is above the unimaged maximum 1,343. **A restore
costs about 648 ms MORE than booting from scratch**, and it also costs ~8 MB a site against an
account-wide 5 GB cap. A cost on both meters and no benefit on either, so `HEAP_IMAGE` defaults off.

It agrees in direction with the local `/bootphase` reading of 0.962 and separates far more cleanly.
The likely mechanism is `digestBytes`, a per-byte JS loop over the restored bytes, which is why
compressing the stored chunks cannot help: the digest is taken over HEAP bytes rather than stored
ones, deliberately, so it catches a bad inflate as well as bad storage.

**AND THE EARLIER RUN THAT MEASURED A SAVING WAS RIGHT ABOUT A DIFFERENT IMAGE.** It read a cold
serve at 904 ms with an image against 1,218.5 without, a 314.5 ms saving, on a **9,699,328-byte**
image. The 2026-09-09 arms restored **37,158,912** bytes. Both are in the report's storage table:
9,699,328 over 148 pages for a configured-and-served object, 36,175,872 over 552 for a cold one.
`snapshotStep()` fires on an alarm with no resident interpreter and requires neither configuration nor
a prior serve, so on a fresh site it captures the COLD shape. The producer takes the expensive image on
the path that matters, which is what closes it. Reconcile a contradicting measurement; do not
overwrite it.

**AND MY FIRST ATTEMPT AT THIS MEASURED NOTHING, because the instrument warmed what it read.** The
driver polled `/heap` and `/serve-stats` before every sample to prove the arms were distinct.
`/heap` reads linear memory and costs **808-1052 ms of cpuTime**, so the poll kept the object
resident and every "cold" reading was warm: the arms came back flat and `restored: true` on both.
Distinctness has to come from the CONFIG, established once, with nothing asked of the object between
samples.

**Do not optimise this mechanism; it is closed.** `HEAP_IMAGE=1` opts back in and the chunk codec
survives behind it, so a workload that turns out to want an image does not have to rebuild one.

## The cold-boot number to move is the FREQUENCY, not the milliseconds

1,264 ms is the floor for an object `src/ops/thermal.ts` decided NOT to keep warm, which is what
`SITE_WARM=0` forces. In production the hot-set policy already exists and already carries the
asymmetry that matters: `AUTH_WARM_WINDOW_MS` keeps an object resident while a session is active,
because the render rate is a property of ANONYMOUS traffic and an editor on a quiet site sits below
the crossing while producing exactly the requests a cold boot hurts.

So the metric worth reporting is the share of user-visible requests that meet a cold boot, not the
cost of one. A proposal to make the boot faster has to be scored against that share first.

**`PhpDumper` IS NOT A DRUPAL 11.4 FEATURE, checked 2026-09-09 against the shipping tree.** A
compiled-PHP service container through OPcache is a credible-sounding lever and core does not offer
it: `DrupalKernel::$phpArrayDumperClass` is `OptimizedPhpArrayDumper`, `getArray()` is what runs, and
the result is cached as a PHP ARRAY in `cache_container` (`DrupalKernel.php:66,1046,1632`). There is
no `Dumper/` directory under `Core/DependencyInjection/` and no `PhpDumper` reference in core;
Symfony's own `PhpDumper.php` sits in vendor because it ships with `symfony/dependency-injection`.
Overriding the property plus a `PhpStorage` write is real work, and "benefits from OPcache" needs
OPcache on, which is loaded-and-disabled here by default.

## A BUILT ARTIFACT IS NOT A PUBLISHED ONE, and `.assetsignore` denies by default

`assets/.assetsignore` is a deny-by-default list: `/*` followed by the un-ignored set. So a new
artifact under `assets/` uploads NOWHERE until a line names it, and nothing reports that.

**`ASSET_AGGREGATES` was decorative for its whole life because of this.** `scripts/pack-aggregates.ts`
wrote 785 files into `assets/agg/`, `substituteAggregates()` rewrote a stored page's asset tags to
`/agg/<hash>.css`, and the asset layer did not publish that prefix -- so the Worker answered the URL
as a Drupal path and the page rendered with **no CSS at all**. Measured on `wrangler dev`, 2026-09-09:
`/agg/00c7beb25a6342ea.css` answered **503** with `x-cfw-cache: MISS` while
`/core/themes/olivero/css/base/base.css` answered **200 with no `x-cfw-*` header at all**. Copying one
identical file into each directory reproduced the split exactly.

The guard is keyed on the substitution's OUTPUT rather than on a path literal: `assets-ignore.spec.ts`
runs `substituteAggregates()` over the prefilled pages and resolves every `/agg/` URL it emits through
the real `ASSETS` binding. Falsified by removing `!/agg/`, which turns it red naming the manifest.

**THE PUBLISHING FIX WAS ONLY HALF OF IT, and the browser lane found the other half.**
`scripts/pack-aggregates.ts` concatenated each library's CSS without rebasing `url()`. An aggregate is
served from `/agg/`, so `url(../../fonts/metropolis/Metropolis-Regular.woff2)` written against
`/core/themes/olivero/css/base/fonts.css` resolved to `/fonts/...`: **270 relative targets across 408
CSS aggregates, every one broken.** Publishing the aggregates made the stylesheets load and every
icon, spinner and webfont inside them 404.

`rebaseCssUrls()` fixes it and the artifact now reads **408 CSS aggregates, 0 relative, 289
absolute**. Of the targets that still do not resolve under `assets/`, counted independently: 22 are
`demo_umami` (an install profile nobody installs), 49 are contrib modules that do not ship, and 1 is
`/core/themes/misc`. **None is olivero, claro or a core module**, so nothing a default site's page
loads is missing.

An HTTP check could not have seen this: the page is 200 and the stylesheet is 200. What fails is a
subresource the CSS asks for, which only a browser fetches.

**And the roadmap's premise for that lever was wrong about the baseline.** It called build aggregates
"the other zero-request path"; the individual files were already on it. Aggregation buys render time
and stored page bytes, not Worker requests. Measured on `/` with the lever on: 13 aggregates replacing
63 tags, 17,678 bytes of markup down to 12,211.

## Workers Cache is dominated here, and a `ctx.exports` call is a BILLED invocation

Measured 2026-09-09 on three deployed free workers, 60 worker requests and 240 static-asset requests
each, invocations read from `workersInvocationsAdaptive`:

| arm                                          | invocations |
| -------------------------------------------- | ----------- |
| no `cache` block at all                      | **120**     |
| `exports.default` off, a named entrypoint on | **63**      |
| top-level `cache.enabled = true`             | **5**       |

Three things it settles:

- **Per-entrypoint caching works with no top-level block**, which the docs allow and which is what
  makes a gateway pattern expressible.
- **A `ctx.exports.X.fetch()` is its own billed invocation.** The control's 120 is 60 requests times
  two, gateway plus inner. So a gateway-and-inner split DOUBLES the request meter on every miss.
- The 63 is 60 gateway plus 3 inner, for 3 distinct URLs: the cache absorbed 95% of the inner tier.
  The 5 is the top-level arm caching the GATEWAY itself, which for this project is a disqualifier
  rather than a win, since the gateway is what routes by hostname and resolves the plan.

**So the L0 tier is refused, and the reason is that it is dominated by what already ships.** The front
worker already runs a `caches.default` tier at a 300 s TTL before the Durable Object hop and reports
it as `x-cfw-edge`. An L0 entrypoint's only advantage over that is not running the inner entrypoint on
a hit, and on a hit that entrypoint is a cache read; against it stands a second billed invocation on
every miss. The surviving objective is unchanged and belongs to off-worker serving: a hostname that is
not routed to the Worker.

**The static-asset billing question is UNANSWERED and the instrument is why.** 720 asset requests
produced zero rows on all three arms, including the one the docs say is billed, so
`workersInvocationsAdaptive` counts invocations and cannot see a billed non-invocation. Do not record
the doc's sentence as a measurement.

## `config/` is the declaration and `src/ops/generated/` is what the edge reads

`config/modules.yml` holds the contrib census and the cron hook policy. It names NO versions --
`composer.lock` stays authoritative for those -- and stores no labels, because `labelFor()` derives
them. Adding a module is one entry there and nothing else: `tests/node/config-generated.spec.ts`
asserts every declared module reaches `moduleTable()`, which README.md is compared against.

A Worker has no filesystem, so the YAML cannot be read at runtime. `bun run gen:config` compiles it to
`src/ops/generated/modules.ts` and `module-tiers.ts`, `module-table.ts` and `cron.ts` import from
there -- the same generated-TS pattern as `shipped-lock.ts` and `driver-digest.ts`. That makes a
second copy, so `bun run gen:config:check` and the spec fail when the two disagree. `src/ops/generated/`
is prettier-ignored, or the formatter and the generator rewrite each other forever.

**The round trip was verified lossless before the old maps were deleted**: 66 table rows deep-equal to
the pre-refactor values with the array order unchanged, and only the tier map's iteration order moved.
Do that check before replacing a hand-maintained map with a generated one.

## The container row is keyed to the PACK, and the guard that missed it compared the wrong tree

`DrupalKernel::getContainerCacheKey()` folds `DrupalInstalled::VERSIONS_HASH` in, so any composer
change moves it. When `assets/drupal/site.sqlite` and `assets/drupal-pf` disagree, every first
`$kernel->boot()` rebuilds a 482 KB container: 1,024 ms against 86, and ~3.7x the heap image.

**IT RECURRED ON 2026-09-09 AND `container-cid.spec.ts` WAS SKIPPING.** It compared the database
against `drupal-src`, which is not what boots, and therefore needed a `fixtureTree()` escape hatch --
which fires on any tree carrying `composer require --dev drupal/<module>`, the documented way to get
the contrib fixture. So the check was off on every machine able to run that lane, and the three heap
specs caught the drift instead, by magnitude, naming nothing. Pack against database needs no hatch.

**The cid cannot be retargeted by editing it.** A compiled container embeds the absolute root it was
built against; a natively baked row carries 27 build-machine paths. The row has to come from a boot
where the root IS `/drupal`, which is why `bun run assets:container` drives `wrangler dev --local`
rather than baking one with `php`. Two traps in that capture: `/fill` on an empty queue returns in
milliseconds having booted nothing, so a serve must queue the path first; and `hex(data)` on a 482 KB
row drops the connection, so it is read in 64 KiB slices.

Use the canonical `wrangler.jsonc`, not `wrangler.bench.jsonc` -- bench aliases the brotli seam and
`.interp/php8.5.wasm.br` lags the glue, which aborts the boot with `ASM_CONSTS[e] is not a function`.

## The one-click deploy was refused by ONE binding, and it was not the one this file named

Measured 2026-09-11 on a fresh free account with the canonical config, name changed and nothing
else. All 4,749 assets uploaded and the deploy was then refused:
_"Please enable R2 through the Cloudflare Dashboard. [code: 10042]"_ on
`/r2/buckets/drupflare-files`.

**The control is the finding.** The same deploy with only `r2_buckets` removed SUCCEEDED, and
wrangler **auto-provisioned both of the others** -- `CONFIG_KV` came back with a new namespace id
and `FLEET_DB` was created by name. This file had recorded "CONFIG_KV, the drupflare-files R2 bucket
and the drupflare-fleet D1 database do not exist on the free account" as though the three were
equivalent; only R2 needs a dashboard action before a bucket can exist, so only R2 can refuse a
deploy.

`r2_buckets` is out of `wrangler.jsonc` and documented as an opt-in addition. **The test lane still
has it**: `vitest.config.ts` declares `r2Buckets: ['FILES']`, because miniflare's R2 is local and
needs no account, so the tier stays exercised while the button works.

What the same deploy then proved end to end: the 75-chunk pack replays in **2 invocations**
(`x-cfw-migrate: 40/75` on the first poll), a real Drupal page answered ~6 s after deploy, and
`/user/login` read `x-cfw-cache: HIT` with `x-cfw-php-booted: 0`. Worker Startup Time 24 ms.

**`wrangler deploy --dry-run` cannot see any of this.** A binding that names an existing resource is
a deploy-time dependency even where the runtime treats it as optional, and the only instrument for a
one-click claim is a real deploy against an account that has never been used.

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

**AND A BUILT PACK IS NOT THE SHIPPED PACK, which the pack lane asserts against by default.** Seven
specs failed the first time that lane got as far as running the gate, and only one was a defect:

- **A from-source pack SHIPPED A HASH SALT.** `install-site-db.php` writes
  `sites/build/settings.php`, the bootstrap globs every non-test file, and `SECRET_REWRITES` named
  only `sites/default/settings.php`. The DETECTOR was already general -- `pack-secrets.spec.ts`
  scans every entry, which is how this surfaced -- and only the rewriter was keyed to one literal.
- **`agg` was outside the numbered build sequence** while `wrangler.jsonc` ships
  `ASSET_AGGREGATES: "1"`, so every from-source tree ran the lever against nothing. It degrades
  quietly by design, which is why nothing reported it.
- **`PRAGMA writable_schema` is cleared by a schema reload**, and preparing the `UPDATE
sqlite_master` is what triggers that load on a connection which has not read a table yet. It
  failed only against a freshly built database and passed in every lane reading the shipped one on
  the SAME node 24.20.0, which is what ruled the runtime out.
- The rest are the boundary itself: `PACK_FROM_SOURCE=1` marks a tree whose artifacts were BUILT, and
  a spec whose subject is the shipped bytes -- a pinned row count, a manifest digest -- skips on it.
  A spec asserting a PROPERTY still runs, which is what stops the flag becoming a way to skip the
  lane. The workers side reads it through a `define`, because workerd has no `process.env` and an
  env-gated `skipIf` there is false on every run.

**A collection-time `import ...?raw` cannot be skipped by any gate**, so `PROBE_IMPORTS` in
`vitest.config.ts` excludes those specs when the file they import is absent. Nothing in this
repository produces `assets/probe/pw-probe.php`, so the pack lane built every artifact and still read
`ENOENT` on it.

**THE COVERAGE THRESHOLD IS MEASURED ON A LANE WHOSE SCOPE SHRINKS, so adding to `ARTIFACT_SPECS`
lowers it.** `coverage.yml` never builds the pack, so every pack-dependent spec is excluded and the
~2,210 uncovered statements in `site-do.ts` are structural rather than a testing gap. Nine specs
joined the list on 2026-09-12 and the lines figure fell to 74.76 against a threshold of 75. Reproduce
it the way CI sees it before believing a local number:

```sh
mv assets/drupal-pf/core.pf.json assets/drupal-pf/core.pf.json.absent
mv .dev.vars /tmp/dev.vars.bak
bun run test:coverage
```

Read 75.31 / 74.68 / 64.04 / 81.19 against 75 / 74 / 63 / 72 once the shell slot half was covered.
The lines margin is 0.31, so the next spec to join the list needs its own tests in the same commit.

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
bun run build:site-db      # the pack database, from nothing; docs/database.md is the recipe
bun run check:site-db      # diff a built database against the shipped one
bun run vps:down           # tear it down, including its volume
```

**`backup:verify` fails on Gregory's home network and that is not a defect.** The bucket is fronted
by `drupflare-cdn.gmitch215.dev`, and the network blocklists `*.dev`, so it answers
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Run it behind a VPN or from CI. Do not debug the script, and do
not conclude anything about the bucket's contents from a failure with that error.

`docs/building-from-source.md` is the release and build procedure; `docs/configuration.md` is every
var and binding; `docs/database.md` is how `assets/drupal/site.sqlite` is built and what each of its
non-default values is for; `docs/repository-layout.md` says how every path arrives
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

**`cronHookList()` IS WIRED AND A CUSTOMER MODULE'S `hook_cron` RUNS.** This paragraph said the
opposite -- exported, spec'd, called by nothing -- and it was a live citation pointing at a closed
defect. `cronHooksForSite()` calls it, `alarm()` calls that, the result is cached in `cfw_meta` keyed
on `enabledModulesFingerprint()`, and `tests/integration/cron-wire.spec.ts` drives the real
`site.alarm()` and asserts a DISCOVERED contrib module reaches the ring. `KNOWN_CRON_HOOKS` is now the
fallback for an unreadable `core.extension` rather than the list. The first contended alarm after the
module set changes spends its PHP unit on discovery and schedules nothing; the next one schedules from
what it found.

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

**The interval is decided by `src/ops/thermal.ts` now, not by a constant.** It prices
P(render inside the hibernation threshold) x 1,398 ms against a firing, over a 64-entry in-memory ring
of arrivals that costs no rows, and declines below the measured ~505 renders/day crossing. An explicit
`SITE_WARM` still wins in both directions. Two things to keep straight: only RENDERS count toward the
rate, because a cached page needs no warm object, and the rate divides by the WINDOW rather than by
the observed span -- dividing by the span reads a ten-second burst as ten renders per second.

**`WARM_FIRING_COST_MS` was invented at 130 and moved the crossing to 845 renders/day.** It is 79
now, derived from the crossing rather than guessed, and the spec asserts the two agree. A constant in
a policy comparison needs the same provenance as a published figure.

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

**AND A LOW-RATE INTERMITTENT IS A PROBABILITY BEFORE IT IS LOAD.** `replica-invariant.spec.ts`
failed twice across sessions with `{ table: 'sessions', statements: 1, rows: 0 }`, passed alone, and
was filed as suite contention. It is `session.gc_probability = 1 / gc_divisor = 100` from
`core/core.services.yml`: PHP sweeps `sessions` on ~1% of `session_start()` calls, and a full gate
gives the coin more throws. Forcing the sweep reproduces the signature byte for byte, so no repeated
full run was needed. `expiryGcTable()` absorbs it -- the host already performs the identical delete
from `EXPIRED_ROW_RULES`, so a replica running it converges on the same set the primary does, while a
session ROW write stays authoritative.

**`cacheTagsIn()` READ ONLY A POSITIONAL ARRAY, so it missed every invalidation after a tag's
first.** `Connection::merge('cachetags')` compiles to a SELECT then an INSERT or an UPDATE. The
INSERT binds positionally (`[1, 'node_list']`) and was recorded; once the row exists every later
invalidation takes the UPDATE branch, which binds by NAME
(`{':db_condition_placeholder_0': 'node_list'}`), and an object is not an array. Measured on a
populated site: a node save moved `node_list` from 1 to 4 while the host recorded only `node:20`, so
`/` and `/node` were never purged and the front-page listing stayed stale. Three menu-item saves
moved `config:system.menu.main` and purged nothing, and a repeat term save recorded no tag at all,
where `flushTagPurge()` returns early on an empty set and drops the invalidation rather than widening
it. Reading the VALUES of a named map is the fix; the filters are what keep a placeholder name out.

**And scoped invalidation's ~11x does not reproduce.** Measured per save kind on a populated site
(30 nodes, two terms, three menu links, 34 filled paths), n=3: an ordinary node save invalidates
**5** pages, a term save **2**, and a save the main menu references **34**, which is every cached
page. The wholesale arm is 25 requeued against 34 invalidated, not the 55 the old arithmetic
assumed. So the ratio is **5.0x for an ordinary node save, 12.5x for a term save and 1.0x for
anything the main menu touches** -- scoping buys nothing on the shape an editor hits most. One ratio
cannot describe a save; the surviving objective is cheaper regeneration for menu-touching saves.

**A setup session is 32,641 rows, not 104,451.** Five installs plus two heap images on one site,
`dailyRows()` per step: migrate 3,397, firstrun 7,886, then 3,364 / 1,140 / 3,551 / 5,364 / 7,642,
and the two images **268 rows between them**. 32.6% of the daily quota and the site never leaves
`normal`. Whatever produced 104% of quota was not this workload, so do not cite it as that.

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

**Count it, do not quote it.** `moduleTable()` is the census; every prose figure in this repo has
been stale in both directions, and the figure that used to sit here said 62/1/3 while the table held
64/1/1. `bun -e "import {moduleTable} from './src/ops/module-table.js'; ..."` prints it, and
`tests/node/module-table.spec.ts` now compares the whole table against README.md's three lists in
both directions -- which `module-table.ts` had CLAIMED for as long as the claim had existed, while
what the spec actually compared was the verified map against the spec files. So the published table
had no guard at all, and three rows were edited by hand trusting the one described in the source.

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

## A boot verifies nothing about a module, and a null answer was reading as a pass

`gitVerifyBoot()` gates every git pull and every uploaded revision. It passed a `.module` full of
nonsense, the same file with the module ENABLED, and a malformed `.info.yml` -- three fixtures that
should have failed, all green. Two holes, either one sufficient:

- **`DrupalKernel::boot()` reads no module file.** The container comes out of `cache_container`, so a
  boot discovers nothing and includes nothing. `ModuleHandler::loadAll()` is what includes an enabled
  module's `.module` and it runs during `preHandle()`. `VERIFY_MODULES` in `src/drupal/site-php.ts`
  is the added step.
- **A NULL result took the success path**, and a null is exactly what a broken module produces:
  `include` raises E_COMPILE_ERROR, no `try` catches it, and the run dies before printing a verdict.
  So the failure the guard exists for was the one it could not see.

The rollback now names the parse error, which is how the fix was confirmed rather than assumed.
`tests/integration/modify-upload.spec.ts` falsifies it both ways.

## `fetch()` ALREADY HOLDS THE GATE, and acquiring it again hangs forever

`this.gate` is a FIFO promise chain and is not reentrant. The router runs inside `this.gate.run()`,
so a route calling a helper that acquires it again awaits a release that only happens when the router
returns. `/updb` hung past every timeout on a fresh object and read as a platform fault.

**This hour was lost once before**; the comment recording it sits at the migrate path in
`site-do.ts`. A helper written for `alarm()`, which is its own event, is not safe to call from a
route without saying which one is holding what. `updbBeat(gated)` takes the flag for that reason.

## The lock is authoritative now, and the chain used to be a cycle

`drupal-src/composer.lock` -> `gen:lock` -> `SHIPPED_CORE_VERSION` -> `fetch:drupal` -> `drupal-src`.
The tree's own lock chose the version that populated the tree, so the only thing it could confirm was
itself, and the ROOT lock sat outside the loop with nothing reading it. That is how a `composer
update` moved `drupal/core` to 11.4.6 for phpstan while the pack stayed at 11.4.5.

`composer.json` requires `drupal/core-recommended` and the four contrib modules directly now, and
`gen-lock-versions.ts` reads the root lock: manifest -> root lock -> `src/ops/shipped-lock.ts` ->
fetched tree. `tests/node/shipped-lock.spec.ts` asserts the DIRECTION rather than mere agreement.

**It was also a correctness fix.** With no `core-recommended` the root resolved symfony 8.1 while the
site runs 7.4, so static analysis was reading a different framework. Two things not to break:
`allow-plugins` must carry `composer/installers: false` or `composer update` refuses to run, and the
spec compares at MAJOR.MINOR because 19 transitive patch versions in the baked map are legitimately
ahead of a tree resolved weeks earlier.

**The root's phpstan is at 56 errors, always has been, and is gated nowhere** -- verified against the
old manifest and lock, same count. Not caused by this.

## The end-to-end host comparison exists, and every cross-arm number it gave is pending

`bun run measure:host` drives BOTH hosts through one matched workload set in ONE process and decides
against a predicate written before the numbers (`scripts/measure/verdict-math.ts`, 23 assertions in
`tests/node/host-verdict.spec.ts`). Every earlier comparison was a human reading two JSON documents
and dividing, which is where "225x" came from.

**IT DROVE `vps` THEN `edge` IN EVERY CELL OF EVERY RUN, so its bias had a direction and pointed at
the arm the rig exists to judge.** Sequential arms are correct and were justified; the FIXED ORDER
was not, and the docblock's reasoning stopped one step short. Anything that drifts inside a cell --
a cache filling, memory pressure building, another job starting -- lands on whichever arm goes
second. This repository had already recorded the identical mistake against the ABI harness: per-arm
blocks read long64 1.5% faster than wasm32 and interleaving read 1.001x. The order rotates per cell
now, and `selfControl()` runs ONE arm as both so a run prints the resolution a cell has to beat.
**The magnitude is unmeasured, so treat the readings below as owed a re-run rather than as refuted.**

**AND CHECK FREE MEMORY BEFORE BELIEVING ANY CELL.** On 2026-09-10 the OOM killer took the full gate
and `wrangler dev` twice at ~60 MB free, and an `auth-admin c=4` reading of 452 ms with errors was
the edge worker dying rather than answering. Never run `bun run test` alongside the rig.

**EVERY EARLIER "WITH LANES" READING DROVE 100% OF TRAFFIC TO THE PRIMARY, so re-measure before
citing one.** `/replica?action=provision` copied a lane, promoted it to SERVING and reported it
ready without ever writing `lanes_provisioned` -- and that key is the only thing that puts
`x-cfw-lanes` on a response, while `replicaCount()` reads only `REPLICA_COUNT`, which the canonical
config does not set. So the router never learned a pool existed. Two more defects sat behind it and
neither was reachable until traffic first met a lane: `affinityKey()` was handed `url.pathname`
AFTER the rewrite, which is the constant `/serve`, and `retryOnPrimary` was `innerRequest.clone()`
under a comment asserting only GET and HEAD could arrive -- an unread tee branch never releases, so
a forwarded POST hung past 240 s. `x-cfw-replica` now names the object that answered; capture it
before believing anything about lanes.

Measured 2026-09-10 on localhost with three lanes genuinely receiving traffic, traffic-weighted p50
**VPS 9.0 ms against 13.4 ms**. `auth-admin` is the standout the other way: **5 ms against 66 at
c=1, 41 against 243 at c=16**, and 361 req/s against 64. Cold path **55 ms against 138**.

One mechanism blocks a yes, and one that used to be listed here is refuted:

- **One Durable Object serializes.** `anon-cached` reads 2/2 ms at c=1 but 6 against 3 at c=4 and 25
  against 4 at c=16, against `pm.max_children = 32`. That slice is 82% of the traffic weight, so it
  decides the verdict alone. **These predate the `cfw_page` seed**: `planRestore()` refused to copy
  the page store, so every lane met anonymous traffic with an empty cache and RENDERED. Within the
  edge arm, c=4 went 405 ms / 6.1 req/s to 6 ms / 510 req/s once lanes arrived holding pages -- see
  `SEED_ON_RESTORE`. The serialization claim is about ONE object and may still hold; what is certain
  is that no reading taken before the seed measured a pool that could serve.
- **REFUTED: "the replica pool and the plan tier fight each other".** The reading behind it -- 0
  lanes reaching `PLAN:private` at request 4 and 3 lanes reading `RENDER` for all eight -- was taken
  on a rig where no request reached a lane, so lanes were not the variable it named. With them
  routed to, the paired curve is `RENDER ERROR PLAN:private x10` and converges at **7 ms against the
  VPS's 69**. The arm reported "NO CELL WAS ANSWERED BY THE COMPILED-PLAN TIER" because it drove 8
  requests and convergence lands at 7, so one ERROR cost a witness; it drives 12 now. Compilation
  does NOT need lane co-location either -- the compile runs in the FRONT WORKER's isolate, and 2 of
  5 trials whose sessions split across two objects still compiled.
- **Still losing `auth-account` (`/user`), and it is ERRORS not latency.** A lane raises
  `RuntimeException: Failed to start the session.` on roughly one authenticated request in ten.
  `fetch()` converts a `ReplicaRequiresPrimary` into the 421 the router retries only when the throw
  unwinds out, and Drupal catches the failed session write first -- so `replicaRefusals`, the field
  that records "this request needed the primary", had three readers and all three were stats lines.
  The wrapper hands off now. **The intermittent did not reproduce under control** (0 in 40 either
  way), so the spec asserts the mechanism and not the rate.

**Localhost is the VPS's best case and that is why the claim direction is safe**: a VPS answers from
one region and drupflare from the visitor's colo, so the missing network term can only move the
result toward drupflare. `--rtt` prices it; the verdict is always taken at rtt=0.

**`x-cfw-site` WAS DECORATIVE** -- present in three measurement scripts and in no file under `src/`,
because site identity is the hostname. Every local `--site` ever passed drove one shared object. The
tells were a never-used id answering `already migrated` and two random ids reporting the same
generation and the same 428 rows. All three scripts send `Host: <site>.localhost` now, and that also
turned a replica `schema mismatch` refusal from "provisioning is broken" into "the shared object was
migrated against an older pack and the lane was right".

## The pack delivers only at provisioning, and reconciliation is the path for everything after

`src/ops/reconcile.ts` is a declarative list of steps, each carrying an OBSERVATION of the site's end
state rather than a script. The verdict is asked twice, before the apply and again after, so "the
reconciliation ran" is never the success condition -- two Outstanding Bugs closed on that weaker
assertion and neither site converged. A site provisioned after a fix answers `satisfied` and is marked
done having done no work; a step that ran and left the site still owing it is recorded as failed with
its attempt count and stops owning the chain after three.

Four things the acceptance test caught that reading the code did not:

- **A deferred step must not block the ones after it.** `bake-clock` defers until the site is claimed,
  which on a site nobody claims is forever, so the first version returned on the first deferral and
  every later step was unreachable by construction.
- **`done` must report the version REACHED, not the version that ships.** Reporting `PACK_VERSION`
  once a failed step had spent its attempts told a rollout the site was patched while the fix it was
  waiting on had never landed.
- **`config.data` is a BLOB.** A reader that accepted only `string` answered null on every real pack,
  so the step deferred forever while passing against a fixture that wrote the column as TEXT.
- **A step whose end state IS a recorded marker has to write that marker inside its own apply**, or
  the verdict immediately afterwards reads the old value and files the successful run as a failure.

A config or state step runs PHP through Drupal's own writers, never SQL. `ConfigFactory::save()`
already clears `cache_config` and invalidates `config:<name>`; the copy a host re-deriving that list
forgets is the one that made the `max_age` fix inert on every site. A unit test asserts no step's
`sql()` writes `config` or `key_value`.

**The container step is the general close for a hook added after the bake.**
`DrupalKernel::getContainerCacheKey()` is composer's `VERSIONS_HASH` plus the PHP version and the OS,
and none of those moves when `assets/driver.json` changes -- which is why `DeferredCron` has never run
anywhere. `bun run assets:driver` now also writes `src/ops/driver-digest.ts`, and the step drops
`cache_container` when a site's recorded digest disagrees, so the next boot rediscovers.

Every applied step drops the SNAPSHOT, not just the image meta key. The generation is the pack plus
the module set and neither moves here, so a restore would otherwise bring back the kernel the step
exists to replace.

**IT RUNS BEFORE THE IMAGE PRODUCER, and three specs had to learn that.** Imaging first pays a full
heap read the next step throws away, so reconciliation settles first and the image is taken once
there is nothing left to reconcile. `heap-image-producer.spec.ts` and `snapshot-delta.spec.ts` both
imaged by hand while the alarm chain was still reconciling: the first read no image at all, and the
second read `cfw_heap_chunk` empty on its warm arm. Driving reconciliation first is right for the
producer spec, which is about the alarm chain; `RECONCILE=0` is right for the delta spec, which
measures image size and read 37,158,912 bytes against an expected ~10.4 MB when a kernel was booted
through reconciliation on the way.

## `/modify` is the third delivery path, and the only one with history

`/git` delivers from a host, `/install` from a registry, and neither could deliver a tree on a
developer's disk. Neither kept history either: `gitRestore()` holds its snapshot in memory for ONE
call, so a pull that succeeded left nothing to go back to.

`src/ops/module-rev.ts` stores content-addressed blobs plus one manifest row per revision, so a
second upload costs the files that changed and a blob already present costs no rows -- which is the
only way history is affordable against the meter that binds regeneration. Five revisions per package;
dropping one frees only the blobs no surviving manifest names.

**Blobs are verified against the hash they were sent under.** A manifest names files by hash, so a
client able to store chosen bytes under a chosen hash could make a later `activate` mount content
nobody reviewed. One digest per blob removes the class.

`commit` and `activate` go through the same apply, verify and restore path a git pull takes, so an
uploaded tree and a git-delivered tree cannot diverge in how they land.

**`planSync()` CANNOT COUNT AN UPLOAD AND THE FIRST VERSION ASKED IT TO.** It compares by SOURCE, so
a declared file whose blob has not been sent yet has no source and had to be left out of its input --
at which point `planSync` sees a stored path that is not incoming and calls it REMOVED. Every
modified file in an upload reported as a removal, and the caller was told its edit would delete the
file it had just edited. `planDeclared()` counts directly instead, and the missing source is not
needed: bytes the site does not hold are new to it, so the path being stored is the whole question.

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
  fragment broke the TypeScript, not the PHP. The apostrophe hazard is already recorded below; this
  is the same shape one punctuation mark over.
- **Never pass fflate's `{ out }` hint to `inflateSync`.** A preallocated buffer makes it TRUNCATE
  to that length and return quietly, so a payload longer than the buffer inflates to exactly the
  length a caller would compare against -- right length, wrong content, which is this repository's
  signature failure. Measured: a 2,048-byte payload against `{ out: new Uint8Array(999) }` returned
  999 bytes and threw nothing. Let fflate allocate and check the length afterwards. Same shape as
  `node:sqlite` cutting a TEXT value at its first NUL, and as `length()` in SQL doing the same --
  the seed's cache bins read 397,804 bytes that way against a true 1,072,666, because serialized PHP
  carries NULs. `src/db/heap-store.ts`'s `unpackChunk()` is the only caller that wanted the hint;
  `zlib-fix.ts` and `package-install.ts` never passed one.
- **A constructed `Request` sets no `content-length`, and `bodyTooLarge()` reads exactly that
  header.** So a spec posting an oversized body through the front worker does NOT trip the cap unless
  it sets the header itself; it falls through to whatever gate comes next and passes for the wrong
  reason. Measured: the same case read 401 without the header and 413 with it, and the docblock
  written from the first reading explained an ordering that does not exist.
- **`src/site-do.ts` is detected as BINARY by grep, so a plain `grep` over it silently returns
  NOTHING.** Not an error, not a warning, no matches. Two sessions have concluded a function was
  missing from it on that evidence. Use `/usr/bin/grep -a`, or `rg`, or the Grep tool.
- Imports use a `.js` specifier even for `.ts` files (`from './site-do.js'`). This matches what bun
  resolves; `node` cannot resolve it, which is why some scripts must run under bun.
- **Check `pragma_table_info` before an `ALTER TABLE`; never wrap one in `try`/`catch`.** A
  caught-and-ignored `ALTER` inside `ensureServeTables()` still dirties `sqlite_master` on every call,
  and that took the serve path into `migrate: starting` on 2 of 3 runs. The exception is not the cost;
  attempting the statement is.
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
the worker list returns to exactly its prior baseline -- workers AND
`workers/durable_objects/namespaces`, because a DO deploy leaves one behind and the worker list
alone will not show it.

**THE FREE ACCOUNT IS A SEPARATE ONE**: `FREE_CLOUDFLARE_ACCOUNT_ID` / `FREE_CLOUDFLARE_API_TOKEN`
in the shell profile, exported as `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`. Its baseline is
0 workers, so anything listed there is something a run left behind.

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
