# Page Cache Settings

Settings for the KV page tier, stale serving, the in-memory cache bins and the compiled plan tier.

## The KV Page Tier

`PAGE_KV` is a cross-colo tier between the edge cache and the Durable Object, on for both plans
whenever the namespace is bound. It still costs one Worker request, since the Worker has to run to
consult it, so what it buys is latency and never serving ceiling. A missing binding always wins over
`PAGE_KV_ENABLED`.

Free KV allows 1,000 writes a day for the whole account, and `CONFIG_KV` draws on the same allowance.
So the object grants each page write: an answer that may be stored carries `x-cfw-kv-grant`, and the
front worker stores nothing without it. The object counts its grants in its daily meter row and stops
at `KV_WRITES_PER_DAY`, 800 on free. Past that, the site keeps serving from what it already stored
and from the object. Only the primary grants, so replica lanes do not multiply the budget.
`/serve-stats` reports `pageKv.writesToday` against `pageKv.budget`. Compiled plans share the namespace
and carry no budget, so on free they are written only when `PAGE_KV_ENABLED` is `1`.

Stored pages are keyed by site, generation and path, so a generation bump invalidates every one of
them without enumerating or deleting anything. KV has no bulk delete, so a scheme needing one would
be uninvalidatable in practice. `PAGE_KV_TTL` is therefore a floor on garbage, and no kind of
freshness knob.

## `NEVER_STALE`

Because the previous generation's entries are still in KV after a bump, a miss at generation `N` can
be answered from `N-1` or `N-2` while the current one regenerates on the alarm chain. The response
carries `x-cfw-edge: STALE` and `x-cfw-stale-behind`, and the regeneration is queued rather than run
inline, so the visitor never waits for a render on a path that has been rendered before.

Two bounds apply together. The generation depth is 2, so a stale answer is at most two content changes
behind; a 24 hour wall-clock bound on top of it stops an abandoned site serving last month's page.

A session-carrying response can never be served stale, and that is structural rather than a check: the
stale read sits behind the same `edgeWanted` gate that requires a non-personalised response. On top of
it, a built-in deny-list refuses `/user`, `/admin`, `/cart`, `/checkout` and the other paths where a
one-change-old answer is wrong rather than merely old. `NEVER_STALE` is a comma-separated list of extra
prefixes and is added to that list rather than replacing it, so a site cannot make its own login
page staleable by configuring badly.

Consumers: `staleAllowed()` and `readStalePage()` in `src/ops/page-store.ts`.

## `MEMORY_CACHE_BINS`

A cache bin named here is held in the interpreter's memory for the life of the incarnation instead of
in the tenant's SQLite. `pib_run` performs no request shutdown, so a class static survives from one
Worker invocation to the next, which is what makes this a real tier here and a test double on an
ordinary PHP host.

The default is `dynamic_page_cache` and `menu`. `MEMORY_CACHE_BINS=none` turns the tier off, and a
variable set to an empty string takes the default, the same as an unset one.

In a measured re-render after a tag invalidation, the bin in memory charged 4 rows where the bin in
SQL charged 8, for a byte-identical page (workerd, shipping pack, the two arms differing by this
variable only). This is a tag-invalidated re-render, not the `realRender` class. That class, a
first render of `/user/login` with both bins empty, charges 1 row in memory and 8 in SQL
(`tests/integration/rows-per-fill-audit.spec.ts`, 2026-11-02). Rows written is the meter that bounds regeneration.

After an interpreter drop the in-memory bin is empty, and the next render rebuilds it. Across a drop,
the in-memory setting charged 2 rows against 6 for the SQL bin. The cost is isolate memory for the
entries held and CPU on the rebuilding render.

Bin names are bare, without the `cache_` prefix: `MEMORY_CACHE_BINS=dynamic_page_cache,render`.

An entry is validated against the cache-tag checksum on every read, the same test the database
backend applies, so an invalidation that arrives as replicated SQL rather than as a PHP call still
refuses it. That is the property a read replica depends on and the reason this is not core's
`MemoryBackend`.

`MEMORY_CACHE_MAX_ITEMS` bounds each bin. It is a count rather than a byte budget because measuring
bytes means serialising the value, which is the cost moving the bin out of SQL removes; the isolate's
own 112 MiB recycle is the backstop underneath it.

Both are on `KV_OVERRIDABLE`. The value is read when `settings.php` is composed, which happens on
every boot because the pack's filesystem is remounted each time, so a change takes effect on the
next interpreter boot rather than needing a redeploy. Source: `memoryCacheBins()` in
`src/do/levers.ts`, and `CfwCacheBackendFactory` in the `drupflare` module.

## `EDGE_PLAN`

The compiled-plan tier in the front worker. On by default on both plans; `0` opts out, and an empty
value is treated as unset. It is the only tier that answers an authenticated page without a
Durable Object hop, because it is the only one whose key is per-visitor: the shared page tiers are
keyed without a user and must never hold one.

Three renders of the same page compile a plan; the first is discarded, because it warms Drupal's
asset library cache and its stylesheet list differs from every later render. The plan must reproduce
both remaining renders byte for byte, hold no slot it cannot generate, and survive a re-diff against
a freshly generated one. Anything else falls through to an ordinary render.

The key is the site, the generation, the path and the visitor's role set. Two properties make
that narrow key safe. A plan is compiled only from renders by two DIFFERENT sessions of the role set,
so anything constant for one user and different for another shows up as a region the compiler cannot
name and the plan is refused; and it is served to a session only once that session's own render has
agreed with it.

A site with a single editor never produces a second session, so a plan is also compiled under a key
that names the session and is served to nobody else. It is held in isolate memory and never mirrored
to `PAGE_KV`. The shared plan is preferred whenever one exists.

Slots are the values that differ per request or per visitor: `form_build_id`, a view's DOM id, and
the session CSRF token in the logout link. The first two are generated fresh; the token is
substituted from what the visitor's own last render carried, so a plan holding one refuses to run for
a visitor whose token this isolate has not seen.

A response that rotates the session is never compiled: a `Set-Cookie` that sets a value the request
did not already hold. Drupal re-sends the session cookie unchanged on every request when
`session.cookie_lifetime` is non-zero (its default is 2000000), so a `Set-Cookie` header alone does
not mean rotation.

Served responses carry `x-cfw-cache: PLAN` and `x-cfw-plan: mem`, `private` or `kv`; everything else
reports on `x-cfw-plan` why it did not.

`x-cfw-plan` is the edge plan and nothing else. The Cloudflare account plan is `x-cfw-account-plan`.
`x-cfw-v` carries the header contract version, and a client checks it before reading either.

An isolate serves against the last generation it learned from the object, and stops after 10 seconds
without re-learning one. That is the staleness bound, and it is the same two-window lag the shared
generation pointer already carries. A write by the visitor moves the generation on its own response,
so their own save is visible immediately.

Compiled plans are mirrored into `PAGE_KV` so a second isolate does not have to compile them again.
That read is bounded at 8 ms: a KV key a colo already holds answers in 4-5 ms, and one it has not
seen costs 46-140 ms whether it exists or not, which is more than the object hop it would replace.

Measured on a deployed paid worker, one session, one 100,748-byte authenticated page:

| where the answer came from      |          ms to response | cpuTimeMs | wallTimeMs |
| ------------------------------- | ----------------------: | --------: | ---------: |
| `EDGE_PLAN=0`, the object hop   | 10 median, 7 min (n=40) |         1 |         18 |
| a plan in this isolate's memory |  0 median and max, n=57 |         0 |          1 |
