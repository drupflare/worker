# Packs, artifacts and the delivery paths

How the pack, the container row and the published assets are built, updated and reconciled. Moved verbatim from the project CLAUDE.md.

## The compressed bundle limit is GONE, and it was shaping the architecture

Cloudflare removed it on **2026-09-04**: the Worker size limit is now **64 MiB UNCOMPRESSED on both
Free and Paid**, and their docs say "There is no compressed size limit. Only the uncompressed bundle
size counts." The 3 MiB gzipped ceiling this project spent two sessions engineering around no longer
exists.

Measured 2026-09-10 on the canonical config: **14,481.28 KiB uncompressed against 65,536 KiB, which
is 22.1%.** Its gzip figure is 4,621.13 KiB, so this configuration was impossible six days ago. The

**AND IT HAS MOVED SINCE, unremarked, which is what the sentence below means.** `metrics.yml` run
34777198609 on 2026-09-13 read **15,479,767 bytes against 67,108,864, which is 23.1%** (gzip
4,969,636). That is ~650 KB of growth in three days with nothing reporting it, because the gate
compares against a baseline rather than against this file. The gate is the counter; this paragraph
is history with a date on it.
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
`per-file pack not reachable: core.pf.json 404`. Twenty had accumulated, and six more on 2026-09-26.
**Run `bun run check:artifact-specs` before pushing anything that adds a render-reaching spec**: it
parks `core.pf.json` and `.dev.vars` (keeping a copy of each), runs the workers lane, restores both
whatever happens, and names each failing file as needing the pack or failing anyway; `--write`
appends the first kind to `ARTIFACT_SPECS`.

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

## A pack update reset the object, and the container rebuild was why

Reproduced 2026-09-25 on a deployed paid site, twice, and only on a deploy that moved the driver
digest. Reconciliation's `container-driver-digest` step empties `cache_container` and
`cache_discovery`; the next fill boots, rebuilds both inside the render, and COMPLETES (3,615 ms of
CPU); the invocation after it, 75 ms of CPU, is reset with `isolate exceeded its memory limit`, and a
visitor request waiting on the object gets a 1101 or 500. The same drops made by hand and followed by
a boot did not reproduce it (0 of 2), so the digest deploy is the condition, not the drop alone.
Linear memory read 107,216,896 and the whole-isolate estimate 93.4%, both clear of their thresholds:
the rebuild's garbage is what the estimate cannot see.

Three closes, each falsified by a spec:

- `recycleIfOversized()` compared linear memory alone while `oversized()` read both thresholds. It
  reads both now (`interpreter-recycle.spec.ts`).
- A boot that found no container row drops its interpreter at the end of that invocation, the way
  provisioning does, whatever the thresholds say (`rebuildBoot`).
- Reconciliation writes the PACK'S container when one matches the site's `core.extension`
  fingerprint and the running driver, so an update needs no rebuild at all. `container.json` beside
  the chunks carries one variant per module set: the migrated pack, and the same site claimed,
  because first-run enables `cfw_do_sqlite` and a claimed site's container is not the pack's. The
  cid does not carry the module set, so the fingerprint is what tells them apart. A site with any
  other module set still rebuilds (`reconcile-converge.spec.ts`).

**AND THE BAKE HAD NEVER FOLLOWED A DRIVER CHANGE.** `bake-container.ts` skipped whenever the cid
matched composer's `VERSIONS_HASH`, which a sibling change never moves, while provisioning stamped
the SHIPPING digest as the container's. So a `#[Hook]` added after the last bake was invisible on
every fresh site and nothing said so. The bake now records the digest it baked with in
`src/ops/container-digest.ts`, skips only when that matches `DRIVER_DIGEST`, and provisioning stamps
that recorded digest, so a stale bake reads as owed. **Run `bun run assets:container` after
`assets:driver`** whenever a sibling changed, then update `cdn-manifest.json`, which the spec will
name. Once a changed `assets/drupal/site.sqlite` is committed, `bun run backup:cdn` publishes it,
archives the old object and records the archive in the manifest; otherwise the scheduled backup
verify goes red with a size mismatch, which it did on 2026-09-26.

**A bake must not share `.wrangler/state`.** Every object an earlier bake left there wakes with its
alarms and renders beside the new one; three bakes in a row died with an empty wrangler `ERROR` that
way before the cause showed in a debug log as requests to an old bake's host. The bake passes
`--persist-to` a temp directory of its own and captures the claimed variant in a second process.

**A deployed object ran at an estimated 139 MB of isolate with no reset** (linear 121,176,064 plus
the ~18 MB JS-side estimate, answered 200 and recycled after). So `isolateNow()` overcounts what the
platform meters, or the ceiling is not a hard 128 MiB on that sum. A workers-pool ladder that reads
past 100% on that estimate is not evidence a page resets the object; confirm on a deploy.

**RAMPED 2026-09-25, and the ceiling is not 128 MiB on that sum.** A paid object retaining committed
JS buffers at 1 request per second until its module-scope id changed: with no interpreter it held
180, 192 and 184 MiB, so the object's budget is ~195 MiB, which gmux measured independently. Beside a
freshly booted interpreter (linear 80 MiB, `isolateNow()` ~93.5 MiB) it held only 20-40 MiB more in
six ramps, and 80 in one taken after a render. So a booted interpreter costs ~165-175 MiB of the
budget, far more than its linear memory, and linear growth after that is largely already paid:
`/admin/content` grows linear 27 MB and survives, and a second interpreter is a second reservation,
which is the update reset. **The JS side is what runs out**, with ~20-32 MiB to spare, and
`isolateAboveBytes()` watches linear growth rather than it. That headroom is also why
`OPCACHE_MODE=pack` stays off: its 8.58 MB lives in MEMFS on the JS side.

**THE THREE CLOSES DID NOT CLOSE IT, read on a deployed update 2026-09-25.** Two paid throwaways
provisioned on one build and redeployed on the next (driver `2c2c311d` -> `9cbc5c32`, re-baked
container, rebuilt chunks) both answered their first visitor 500: an alarm of 908 ms and 1,884 ms of
CPU was reset for the isolate's memory with the visitor waiting on it. The container half of the fix
worked: the serving object's `cache_container` row was the packed variant, `created` equal to the
bake's to the millisecond, so nothing rebuilt a container. 44 discovery rows were written in that
minute.

**The discovery rebuild alone does not reproduce it.** A simulated update on the same two workers
(a fake digest on `DRIVER_DIGEST` and in `container.json`, everything else unchanged) ran the shipped
step on one and the step minus `DELETE FROM cache_discovery` on the other: 0 resets on either, and
the shipped arm rebuilt 60 discovery rows inside a cold render that answered 200. What the real update
had and the simulation lacked: changed PHP in `driver.json`, rebuilt SQL chunks, and objects meeting
their first update rather than their second.

**A FRESH SITE RESET THE SAME WAY WITH NO UPDATE AT ALL, and that one is attributed.** Eight
throwaways, retention on and off, one object each: provisioning rendered fine, and the first alarm
after ~75 s idle was reset for memory at 921-1,280 ms of CPU, 8 of 8, with the visitor waiting.
The packed router lagged the driver -- 4 of its 6 routes and the pre-tier permissions -- so
`router-driver-routes` was owed on EVERY fresh site and ran a PHP router rebuild on that first cold
alarm. Rebuilding the pack database against the current driver (`bun run assets:driver --
--to=drupal-src`, then `bun run build:site-db`) took two more throwaways to 6 of 6 first-and-later
cold visits at 200 and 0 resets. Three hypotheses died first, each by an instrument rather than an
argument: two interpreters booting in one object (the gate serialises them, one cold boot counted),
a second object sharing the isolate (the reset held with only the hostname object touched), and an
uncollected interpreter from the provisioning incarnation (`boot-beside-resident`, logged from
`ensurePhp()`, never fired). `driver-pack.spec.ts` now fails when the packed router lacks a driver
route or carries a permission the driver no longer declares.

**The rebuild moves the Twig prefix, so the pack has to follow it.** A fresh install mints a new
`twig_extension_hash_prefix`; after `build:site-db` run `assets:twig` -> `assets:core` ->
`assets:pack` -> `assets:scrub`, then `assets:container`. `twig-bake.spec.ts` names the prefix when
this is skipped, and the first fill otherwise compiles every template it should have loaded.

**The update path gets the split, since nothing reproduced its reset.** On an update (a recorded
digest that no longer matches), the digest step now warms discovery in its own invocation and drops
the interpreter, so no render rebuilds it. A fresh site's `php()` returns null and boots nothing,
which is the constraint that reverted the last `php()` on this step.

**AND THE WARM-UP EXPOSED THE REAL SHAPE: TWO INTERPRETERS AT ONCE.** Nine seconds after an update
deploy the alarm and a visitor's `/__serve` were reset together at 262 and 139 ms of CPU, far too
early for any rebuild. Reconciliation runs in the alarm OUTSIDE the gate, so its PHP and a visitor's
inline render each reached `ensurePhp()` cold and each constructed an interpreter. `ensurePhp()` now
shares an in-flight boot (`bootInFlight`), falsified by disabling it: `reconcile-converge.spec.ts`
then sees two instances. Six update deploys with a visitor arriving at once afterwards: 0 memory
resets, against 3 of 4 before. My first concurrency probe missed it because it drove the FILL path,
which the gate serialises; probe the ungated paths when asking whether two boots can overlap.

**Two instrument traps from that run.** The opcache rig sends `?site=opcab` on owner routes, which
reach a DIFFERENT object from the hostname-keyed one that serves visitors, so `/sql` and
`/serve-stats` read the wrong site until the parameter is dropped. And a result that holds on one
pair of deploys can be placement: swap the levers between the same two workers before crediting one.

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

Use the canonical `wrangler.jsonc`, not `experiments/wrangler/wrangler.bench.jsonc` -- bench aliases the brotli seam and
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

## A STATIC SURVIVES EVERY LATER RUN, and that is what made `/install` useless

`pib_run` performs no `php_request_startup`/`shutdown`, which this file already records for
`$GLOBALS` and parked generators. It is equally true of CLASS statics, and
`ExtensionDiscovery::$files` is one: a site that rendered anything before a module was installed
keeps a file scan taken without it, for the life of the interpreter. So `/install` wrote its 27
files, the boot mounted them, PHP could open them by path, and `/enable` still answered
`discoverable: false` however long anything waited.

`extension.list.module`'s own `reset()` does not reach it, and Drupal 11 removed
`ExtensionDiscovery::reset()` -- the property is `protected static` with no public clear, so
reflection is the only way in. `ENABLE_MODULE` does that now and reports `filesMounted` beside
`discoverable`, because without the first the second has two completely different causes and reads
identically.

**FOUR WRONG DIAGNOSES PRECEDED IT**, each plausible and each costing a round: an enable/mount race
(five retries over 8 s changed nothing), a missing boot between install and enable (a forced render
changed nothing), the lazy mount hiding a directory (it creates REAL MEMFS nodes and real
directories, so a scan sees them), and `LAZY_MOUNT=0` as a workaround (it needs `core.json` /
`core.bin.gz`, which the asset layer does not publish -- 404). The thing that ended it was making the
probe report `filesMounted` rather than reasoning about which half was broken.

## Run the pack lane locally before pushing at it

Four rounds of this lane were fixed one CI failure at a time, because nothing here ran what it runs.
The step it fails on is reproducible in full:

```sh
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 24.20.0 # what CI resolves for '24'
REQUIRE_ARTIFACTS=1 PACK_FROM_SOURCE=1 bun run test
```

That alone catches the node-version and flag failures, which were three of the last six. For the
from-source pack, copy the tree and build it:

```sh
rsync -a --exclude '.git' ./ /tmp/ci-repro/ # NOT --exclude vendor/dist, see below
cd /tmp/ci-repro
find assets -mindepth 1 -maxdepth 1 ! -name '.assetsignore' ! -name 'robots.txt' ! -name '_headers' ! -name drupal -exec rm -rf {} +
find assets/drupal -mindepth 1 ! -name site.sqlite -exec rm -rf {} + # a fresh checkout's state
DRUPFLARE_SRC= ROM_SRC= STREAM_HTTP_SRC= < abs > /drupflare < abs > /rom < abs > /stream-http/src bun run build:local
```

**An rsync exclude matches at every depth, and it cost two rounds here.** `--exclude vendor` also
removes `drupal-src/vendor`, which fails the twig bake on a missing `autoload.php`; `--exclude dist`
also removes `node_modules/*/dist`, which makes vitest unresolvable. Exclude `.git` and nothing else,
or name the paths with a leading slash.

**A `bun -e` script is NOT the node the gate runs on.** Bun ships its own `node:sqlite`, and it
refused a `sqlite_master` write that real node 24.11 allows -- so a harness written in bun reported
the wrong answer for both runtimes. Use `node` for anything that measures node behaviour.

**AND A BUILT PACK IS NOT THE SHIPPED PACK, which the pack lane asserts against by default.** Seven
specs failed the first time that lane got as far as running the gate, and only one was a defect:

- **A from-source pack SHIPPED A HASH SALT.** `install-site-db.php` writes
  `sites/build/settings.php`, the bootstrap globs every non-test file, and `SECRET_REWRITES` named
  only `sites/default/settings.php`. The DETECTOR was already general -- `pack-secrets.spec.ts`
  scans every entry, which is how this surfaced -- and only the rewriter was keyed to one literal.
- **`agg` was outside the numbered build sequence** while `wrangler.jsonc` ships
  `ASSET_AGGREGATES: "1"`, so every from-source tree ran the lever against nothing. It degrades
  quietly by design, which is why nothing reported it.
- **`writable_schema` IS NOT ENOUGH ON NODE 24.20**, which added `enableDefensive` and defaults it
  ON: `SQLITE_DBCONFIG_DEFENSIVE` refuses a direct write to `sqlite_master` whatever the pragma says.
  Measured across both runtimes and both databases -- 24.11.0 permits it on the shipped file AND on a
  freshly built one, 24.20.0 refuses both -- which is what separated the runtime from the pack.
  **Two earlier explanations were wrong and each cost a round**: a schema reload clearing the pragma,
  and "Build Project passes on the same node, so it is not the runtime". The second read as decisive
  and was not.
- **Node 24.20 also FIXED the `node:sqlite` NUL truncation.** The control asserting a JS read is
  still cut at the first NUL read 117 bytes on 24.11 and the full 1,697 on 24.20, so it turned an
  upstream fix into a red gate. It asserts one of the two known shapes now. The other NUL hazards
  this file records -- `length()` in SQL, fflate's `{ out }` hint -- were never node:sqlite's doing
  and are unaffected.
- **A magnitude in a control moves when a feature lands.** `assets-ignore.spec.ts` required more than
  50 `/core/**` URLs across the prefilled pages; once `agg` joined the sequence the prefill bakes
  pages whose tags are already rewritten to `/agg/**`, and the lane read 6. Both prefixes are the
  same claim, so both are counted and the threshold is gone.
- The rest are the boundary itself: `PACK_FROM_SOURCE=1` marks a tree whose artifacts were BUILT, and
  a spec whose subject is the shipped bytes -- a pinned row count, a manifest digest -- skips on it.
  A spec asserting a PROPERTY still runs, which is what stops the flag becoming a way to skip the
  lane. The workers side reads it through a `define`, because workerd has no `process.env` and an
  env-gated `skipIf` there is false on every run.

**A collection-time `import ...?raw` cannot be skipped by any gate**, so `PROBE_IMPORTS` in
`vitest.config.ts` excludes those specs when the file they import is absent. Nothing in this
repository produces `assets/probe/pw-probe.php`, so the pack lane built every artifact and still read
`ENOENT` on it.

**THE COVERAGE LANE DOES NOT BUILD THE PACK, AND THAT IS NOW DELIBERATE.** It was dropping **104
spec files** every run -- every `park-*`, `crossings`, `opcache-ab`, `effect-census` and the
integration half of `fragment-index` -- so those modules read as coverage gaps when each of them has
a spec. The gap was lane scope, not missing tests.

Making `coverage.yml` build the pack was tried and REPLACED on 2026-09-18 by `b5f9958f8`, which
moved the pack-dependent coverage onto the lanes that already build it rather than paying for a
second build. This paragraph asserted the opposite for a day; check `coverage.yml` itself before
citing either shape, because the claim has now been wrong in both directions.

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
CI run 34777198614 on 2026-09-13 read **74.45 stmts / 63.9 branch / 80.97 funcs / 75.06 lines**,
which clears the lines gate by **0.06** -- so the margin has been eroding, not holding at 0.31, and
the next spec to join the list would have taken the lane red on its own.

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
