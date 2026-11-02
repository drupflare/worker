# Platform facts and request-path defects

Measured Cloudflare behaviour, the owner routes, and defects only a browser or a deploy found. Moved verbatim from the project CLAUDE.md.

## The levers are writable now, and `PLAN` is deliberately not one of them

`resolvePlan()` and `resolveSettings()` had read the `plan` and `settings` KV keys since they
shipped and **nothing in `src/` ever called `CONFIG_KV.put()`**, so every name on `KV_OVERRIDABLE`
was a knob that could only be turned by editing `wrangler.jsonc` and redeploying -- a deploy to
change a fact the deploy does not control, which is the exact thing `resolvePlan()`'s own docblock
says KV exists to avoid. `/settings` is the writer: GET reports every lever with the value in force
AND its source (`kv` / `var` / `default`), PUT merges a patch.

It is an OWNER route with no `DO_ROUTE` entry, for the reason `/fleet` has none: `CONFIG_KV` is a
front-worker binding, so an object hop would spend a Durable Object request to reach a namespace
this isolate already holds. `owner-routes.spec.ts` keeps a `WORKER_ANSWERED` set for exactly these.

**The allow-list is enforced at the WRITER, not only at the reader, and that is a privilege boundary
rather than belt-and-braces.** A reader-side filter makes an unlisted name inert; a writer-side
filter makes it unstorable. `KV_OVERRIDABLE`'s docblock says what a stored `PW_DIAGNOSTICS` would
reach -- `/sql` and `/restore` -- and a document written before another reader exists is a document
that reader will trust.

**`PLAN` has its own key, its own function and its own authorisation.** Every other name on the list
has a worst case of "a slow site". `PLAN` selects a whole limits profile, and the quotas it models
are ACCOUNT-WIDE while any actor setting it is one tenant -- which is the structural SaaS risk the
roadmap already names, with a write handle on it. `writeSettings()` refuses `PLAN` at any spelling.

## The owner-token check had no failure budget, and the token was never the risk

`ownerCredential()` fetched `/__ownercheck` on the Durable Object for every presented token, right or
wrong, unbounded. The token is 32 CSPRNG bytes compared in constant time, so guessing it is not a
practical attack -- **what was free was the COST of guessing.** An unauthenticated client could drive
the object's request counter, which is the meter the whole free-plan model is scored against, at one
DO request per HTTP request until the site degraded to read-only.

The budget is in `src/ops/admin-session.ts` and is checked BEFORE the hop, keyed on
`cf-connecting-ip`, 12 failures per 60 s, cleared by a correct token. Three things it is deliberately
not: durable (a row per attempt spends the meter it protects), a brute-force defence, or a stop to a
distributed attacker. It removes the amplification. The map is size-bounded because the key is
attacker-supplied, which would otherwise be a second amplification through the same door.

**A failed check is NOT counted when the object could not answer.** A migrating or quarantined object
must not lock its owner out of the routes they need to repair it.

## IMAGE STYLES SERVED THE FULL-SIZE ORIGINAL ON EVERY SITE

`CfwImageToolkit::save()` copies the source to the derivative path, and `deliveryUrl()`, the only
emitter of a `/cfw-img/` URL, had no caller, so the front worker's tinyimg path was reached by no page.
drupflare's `Hook\ImageDelivery` rewrites a public style URL to the delivery path now, and the
rendering lanes (`RENDER_LANES`, `src/ops/render-lane.ts`) store every style on upload.
`image-toolkit.spec.ts` asserts the URL, with the stock URL as the control when the container has not
rebuilt. A hook reaches an existing site only through a container rebuild, which reconciliation
performs when the packed driver's digest changes.

## NO UPLOAD HAD EVER BEEN STORED, AND FOUR DEFECTS STOOD IN A ROW

Found 2026-09-24 by driving the media form on a deployed worker. Each fix exposed the next, and a
multipart POST answered 200 or 303 through all of them.

- **PHP's upload table is empty here.** `UploadedFile::isValid()` asks `is_uploaded_file()` and
  `FileSystem::moveUploadedFile()` calls `move_uploaded_file()`, and only a POST SAPI fills the table
  both read. The request fragment builds test-mode `UploadedFile`s and records each temp path in
  `$GLOBALS['__cfw_uploads']`; drupflare's `File\CfwFileSystem` moves exactly those.
- **An empty directory did not exist.** Storage is a flat keyspace, so `is_dir()` was true only once
  a file sat under the prefix, and `FileSystem::move()` checks the destination directory without
  creating it. Every move into a new directory threw. `CfwFileStreamWrapper::mkdir()` remembers what
  it made now.
- **`file_save_upload()` keeps a function-local `static $upload_cache`**, keyed on the field name.
  Nothing can reset a function static, so the second upload to a field got the first file, including
  one another user uploaded. The object drops the interpreter after a request `carriesUpload()`
  matches. `multipart-submit.spec.ts` keeps the direct-render control, which still reproduces it.
- **A public original was Drupal's 404.** Drupal expects the web server to serve
  `sites/default/files` and has no route for it. The front worker answers it from the file store.

**The property sweep cannot see a function static.** `static-sweep.spec.ts` walks class statics and
initialised services; a `static` inside a function is invisible to both and to reflection's writer.
Grep core for `^\s*static \$` in any function a request reaches before trusting the sweep.

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

## Workers Cache is dominated here, and a `ctx.exports` call is its own invocation

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
- **A `ctx.exports.X.fetch()` is its own invocation.** The control's 120 is 60 requests times two,
  gateway plus inner. Whether the second one is BILLED is a different question this instrument
  cannot answer: Cloudflare's pricing page says a request through a service binding incurs no
  additional request fee, and whether it counts toward free's 100,000/day is unmeasured.
- The 63 is 60 gateway plus 3 inner, for 3 distinct URLs: the cache absorbed 95% of the inner tier.
  The 5 is the top-level arm caching the GATEWAY itself, which for this project is a disqualifier
  rather than a win, since the gateway is what routes by hostname and resolves the plan.

**So the L0 tier is refused, and the reason is that it is dominated by what already ships.** The front
worker already runs a `caches.default` tier at a 300 s TTL before the Durable Object hop and reports
it as `x-cfw-edge`. An L0 entrypoint's only advantage over that is not running the inner entrypoint on
a hit, and on a hit that entrypoint is a cache read; against it stands a second invocation on every
miss. The surviving objective is unchanged and belongs to off-worker serving: a hostname that is
not routed to the Worker.

**The static-asset billing question is UNANSWERED and the instrument is why.** 720 asset requests
produced zero rows on all three arms, including the one the docs say is billed, so
`workersInvocationsAdaptive` counts invocations and cannot see a billed non-invocation. Do not record
the doc's sentence as a measurement.

**THE FREE DAILY CAP IS NOT THAT INSTRUMENT, and this paragraph said it was.** Run 2026-09-25 on
the free account: 95,000 asset requests, ~7,300 worker requests, 4,765 requests making 20 binding
hops each, then 100,000 plain worker requests as the positive control. Analytics counted **209,512
invocations that day with zero refusals**, and a probe every 20 s for 30 minutes after stayed 200. So
the refusal the design waited for never came, and "where it refuses" answers nothing about assets or
hops. Two things it did show: a binding hop is its own invocation in `workersInvocationsAdaptive`
(94,540 of them, status `clientDisconnected` because the caller does not read the body), and a
static-asset request does not appear there at all. Whether either is billed toward 100,000/day is
still open; the next instrument is the day's billed usage, not a refusal. Run the positive control
first next time: a conditional arm with no control would have reported "not counted" for both.

**Two asset-routing facts, measured 2026-09-24 on a free throwaway** with `run_worker_first:
["/dyn/*"]` and no `not_found_handling`. The asset layer IGNORES THE QUERY STRING: `/?page=1` and
`/?q=x` both answered the published `index.html`. And a POST to a published path answers **405 from
the asset layer** without running the Worker. `_headers` applied to every asset response, and an
unmatched path fell through to the Worker as expected. So a page published as an asset answers every
pager, search and filter URL on its path with the same bytes, and breaks any form that posts back to
its own URL.

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

## `x-worker-ms` ON A CACHED SERVE IS ~99% NETWORK HOP, NOT OBJECT WORK

Measured 2026-09-14 on two deployed paid workers, both torn down. On a cached drupflare serve the
front worker spends **1.10 ms of CPU** and the Durable Object spends **0.70 ms of CPU and 0.93 ms of
wall**, against an `x-worker-ms` of 85 ms. The remainder is the front-worker-to-object hop: **5 ms
co-located in IAD, 73-84 ms across IAD to SEA**.

So a change in `x-worker-ms` on a cached path is a statement about WHERE the object is, until proven
otherwise. The single-object throughput decay this file used to treat as the most load-bearing
unknown -- p50 stepping 43 -> 111 -- is +68 ms, which is one US coast-to-coast round trip. Before
attributing a wall-clock move on a cached path to the object doing more work, decompose it:
`workersInvocationsAdaptive` for the front worker and `durableObjectsInvocationsAdaptiveGroups` for
the object, and read the colo on both.

**AND THE DECAY DOES NOT REPRODUCE ON PAID.** 11,385 requests over 16 minutes on one incarnation read
52 -> 55 ms, and 10,684 cached serves over 20.9 minutes read 74 ms flat across every bucket.
Throttling, SQLite growth and heap growth each have their own arm ruling them out.

**NOR ON FREE, 2026-09-25, which closes the free-plan CPU allowance hypothesis.** One object on the
free account, current build: 3,000 cached serves read p50 15-16 ms flat across every bucket, and 450
renders read p50 125-144 ms flat, about 45 CPU-seconds past the ~5 CPU-seconds where the original
step appeared. Every sample answered from IAD. The original reading stays unattributed; a colo change
is the remaining candidate and nothing now needs it explained.

## Three GraphQL traps that each read as an empty dataset

Each cost a session, and the first contradicts what this file used to say.

- **`durableObjectsInvocationsAdaptiveGroups` returning no rows is NOT a free-plan property.** On a
  PAID account a newly created namespace returned zero rows for about **25 minutes** while
  `workersInvocationsAdaptive` had the same traffic immediately. Three queries read empty before the
  data appeared. Re-query 30+ minutes later before concluding the dataset is unavailable; this file
  had recorded the emptiness as a plan limitation and used it to defer a measurement.
- **`datetimeMinute_geq` silently returns zero rows** as a filter field. The working one is
  `datetime_geq`. No error, just an empty result, which reads exactly like no traffic.
- **Deleting a worker deletes its Durable Object analytics.** Two hours after `cfw-writes` was torn
  down, `durableObjectsPeriodicGroups` and `durableObjectsInvocationsAdaptiveGroups` held no row for
  its namespace while live scripts in the same window did. Its Worker invocations survive, relabelled
  `__unknown__`. So read every object meter BEFORE the teardown; `write-workloads.ts` polls until each
  class has a row for that reason.

## `/big_pipe/no-js` answering 400 is core, and the transport is what to guard

Twelve occurrences sat in the browser lane's logs as UNVERIFIED for weeks.
`BigPipeController::setNoJsCookie()` throws `HttpException(400, 'The original location is missing.')`
when the request carries no `destination`, which is correct -- there is nowhere to redirect back to.
Measured: an authenticated render emits `big_pipe/no-js?destination=/admin/content`, and that URL
through the front worker answers 302. Nothing in this project produces the bare request.

What earns a regression test is the TRANSPORT. `/serve` is built from the ORIGIN so a visitor's query
cannot land among its own parameters, and the visitor's query rides inside the `path` parameter as
one percent-encoded value. If that ever became concatenation, `destination` would parse as a
parameter of `/serve`, `path` would read `/big_pipe/no-js` alone, and every no-JS visitor would meet
exactly the 400 already in the logs.

## The boundary sweep walks SERVICES now, not only class statics

The blind half fingerprinted static properties of declared classes, so it could not see a carrier
that is INSTANCE state on a persistent service -- and three of the nine named carriers are exactly
that: the page-cache kill switch, the renderer's `isRenderingRoot` and the locale lookup's memoised
cid. Each was found by hand and then added to the named list, which is not a search.

`BOUNDARY_STATE` now also walks `$container->getServiceIds()` filtered through
`$container->initialized($id)`. **The filter is the whole safety property**: asking the container for
a service it never built would CONSTRUCT the state the sweep is looking for, the same mistake as a
probe that warms what it reads. What is walked is exactly the set the request instantiated.

**TWO MORE CARRIERS, 2026-09-25, and the first was a disclosure.** `EntityAccessControlHandler::$accessCache`
memoises a verdict per entity, operation and account id, and the handler is held by
`entity_type.manager` for the life of the interpreter. So an anonymous view of a published node,
followed by an unpublish, left the ALLOW in place: the unpublished node answered 200 to anonymous
and `cfw_page` stored it. `LocalTaskManager::$taskData` is keyed by route name, not parameters, so
the tabs built for `/node/1` rendered on `/node/2` and every node page carried `node:1`.
`RequestResetter` clears both now, and each has a `static-sweep.spec.ts` case whose control reproduces
the leak with the reset disabled. Both were found while chasing a cache-tag fan-out, not by the sweep.
