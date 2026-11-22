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

## `WORDPRESS_PAGE_CACHE`

`1` lets a WordPress site answer anonymous page views from the object's stored copy and the shared
tiers. Any other value, or no value, stores and replays nothing, which is the default. Drupal never
reads it, and it is not on `KV_OVERRIDABLE`: a wrong stored page is a wrong answer, not a slow site.

A response is stored only when every rule below passes, and each rule is a named row in
`src/wordpress/store-rule.ts` with a test that removes it and shows the case then gets through.

- The request is an anonymous `GET` with no cookie (analytics and consent cookies are dropped first,
  see Cookies), no `Authorization` and none of the headers that
  change a body (`Forwarded`, `X-Forwarded-Server`, `X-Original-URL`, `X-HTTP-Method-Override` and
  similar). `X-Forwarded-Host`, `X-Forwarded-For` and `X-Forwarded-Proto` are not on that list:
  proxies and `wrangler dev` add them, and the pinned origin keeps them out of the body.
- The path is lowercase, has no doubled slash, dot segment or encoded slash, no file extension, no
  `wp-*` first segment and is not under `/search/`. Only the query variables WordPress uses to choose
  a page are allowed, each with a fixed value shape (`p`, `page_id`, `cat`, `tag`, `author`, `paged`,
  `feed` and a few more). Any other variable, such as `s`, `preview` or `replytocom`, refuses the
  path, so a visitor cannot mint a row per value.
- `utm_*`, `fbclid`, `gclid` and the other campaign identifiers are removed from the key and from the
  path PHP renders, and the remaining variables are sorted. Drupal keys the path as sent.
- The response is a 200 with no `Set-Cookie`, no `private`, `no-store` or `no-cache`, and no `Vary`
  but `Accept-Encoding`. A 404 or a redirect is never stored: a 404 is an unbounded key space, and
  `cfw_page` has no `location` column.
- The body is complete (`</html>`, or a feed that starts with `<?xml` and ends in its closing tag),
  has the content type its path implies, carries no nonce, and is not a search or not-found page.
- The render named at least one cache tag, so a write can purge it.

`/wp-json/` and `?rest_route=` are refused. REST collections vary by authentication and some carry
nonces; storing one needs a per-route allow-list, a check that the route is anonymous, and tags per
collection. Sitemaps, `wp-cron.php` and any path under `wp-*` are refused by the same rule, so each
request renders.

### Purges and Stale Copies

A write purges the pages that carry the tags it announced. A write nobody announced purges every
stored page, and structural changes (theme, menus, widgets, core options) do the same by design.

The host checks each run's writes against its announcements, and calls a write nobody announced a
floor purge. For `wp_posts` and `wp_postmeta` it reads the post ids out of the statement when the
`WHERE` clause is a plain conjunction on `ID` or `post_id` (an `=` or an `IN` list), or from the id the
database reports for a single-row insert. Such a write counts as announced only when a `post:<id>` tag
came for every one of those ids, so a tag for one post no longer covers a write to another. Any other
statement shape (an `OR`, a subselect, a join, a different key column, more than 100 ids) falls back
to the table family check: a tag of a family the table feeds covers it.

A post page's previous and next links used to carry the all-posts tag, so any publish purged every
post page. The stock lookup, a published post of the same type ordered by date and then ID, now
carries a tag for the links of its own post instead. Publishing a post, restoring it from the trash
or moving it to a new date announces the links of the two published posts on either side of its new
place, one indexed query each way, and nothing else about those posts. A post that leaves
publication, whether trashed, drafted, made private or deleted, announces nothing extra: every page
that linked to it loaded it and already carries its tag. Equal dates break on ID, as the lookup does.
A lookup limited to the same category or tag, one that excludes terms, one a theme or plugin changed
with a filter, and any other statement shape keep the all-posts tag and purge with every publish.

That narrows the post pages a publish purges to the post, its two neighbours and the pages that
list it. It does not cover everything a post page loads. A new or removed post changes its
category's post count, which purges every page that loaded the category, and a theme that lists
recent posts on its post pages carries the listing tag a publish announces. On those sites a
publish still purges most post pages.

Publishing also sets two flags in post meta, `_pingme` and `_encloseme`, which WordPress's next cron
run clears. No page shows either, so the host announces nothing for them, and it announces nothing
for the option where it records its own cron run. Before this, the cron run that followed a publish
purged about as many pages as the publish had.

A floor purge is still wholesale. The host does not know which listings a post it never saw belongs
to, so it cannot name a smaller set of tags. `/serve-stats` reports `floorPurges` and the tables behind
the last one under `wordpressTags`. A wholesale purge marks every stored page superseded and queues
refills for them.

`NEVER_STALE` and the previous-generation tier of `PAGE_KV` do not apply to WordPress. A trashed or
unpublished post renders a 404 that is never stored, so nothing would replace its old copy in `PAGE_KV`
and the post would stay visible. After a purge the front worker therefore waits for a render. The
object still answers a page marked superseded by a wholesale purge for up to `AGED_SERVE_MAX_MS`
(60 seconds by default), and says so with `x-cfw-cache: AGED`.

An isolate learns a new generation within its pointer window, so another colo can answer the old page
for a few seconds after a write.

### Background Fills and Visitors

A purge queues a refill for every page it removed, and the object works through the queue on its
alarm. A WordPress render takes about half a second and holds the object for all of it, so a request
that arrives in the middle waits, and the alarm used to start the next fill the moment one ended.
After a publish that left a dozen pages queued, a visitor's reads waited for the whole queue to
drain.

The fill batch now yields to the event loop between fills, so a request that arrived during a render
is served before the next fill starts. It also stands aside for `VISITOR_QUIET_MS` (500 ms by
default) after a request reaches the gated lane, which covers the gap between two requests of one
visitor. Two rules keep the queue moving:

- A queued page that a visitor is waiting on is filled at once. Only background pages wait.
- A fill goes through once none has run for ten windows, so a steady stream of requests cannot hold
  the queue back for good.

`0` turns the wait off and leaves only the yield. The pages nobody asked for are filled after the
visitors go quiet, so the queue takes longer to empty than it did.

How long a page can stay stale after the write that purged it depends on how many pages that write
purges, because the object renders one page at a time. The bound is 1 second per page the write
affects plus 2 seconds: 8 seconds for a publish (six pages), 6 seconds for an edit (four), and 1
second per stored page plus 2 seconds for a write that purges every stored page. It rests on a
measured render of about 0.6 seconds per page on a local object that renders one page at a time. No
deployed reading has been taken, so treat it as the local figure.

### Validators

A stored page answers with `ETag: "wp-<render time>"`, and a matching `If-None-Match` gets a 304 with
no body. A copy that spool has decorated carries `W/"wp-<render time>"`, and the two forms never
validate each other. A refill changes the render time, so a client holding a purged copy always
fetches. An `AGED` answer carries no validator.

### Cookies

A request is read against three groups of cookie names.

- Login and personal cookies (`wordpress_logged_in_*`, `wordpress_sec_*`, `wordpress_*`,
  `wp-settings-*`, `wp-postpass_*`, `comment_author_*`) make the request authenticated. It renders for
  that visitor, spends the authenticated allowance on the free plan, and is never answered from or
  stored in a shared tier.
- Analytics and consent cookies never change what WordPress renders: Google Analytics (`_ga`,
  `_ga_<id>`, `_gid`, `_gat*`, `_gcl_*`, `__utm*`), `_fbp` and `_fbc`, Hotjar, Matomo, Microsoft
  Clarity, the Cloudflare cookies `__cf_bm`, `_cfuvid` and `cf_clearance`, and the consent cookies of
  GDPR Cookie Consent, Cookiebot, Complianz, CookieYes, OneTrust, Borlabs and Moove. A request that
  carries only these is the anonymous request. The front worker drops them before it asks any tier, so
  the stored page is the one a visitor with no cookie gets, and a visitor with `_ga` and one without
  read and fill the same entry. The names are anchored patterns in `src/ops/auth-budget.ts`, so a
  look-alike such as `_ga_session_admin` stays in the third group.
- Every other name is unclassified. The request is treated as authenticated (no shared tier, no store,
  the allowance applies) because a plugin cookie such as a cart can make the page per visitor.
  `/serve-stats` reports these under `unclassifiedCookies`: the request count, the count per name for
  the first 32 names seen, and the requests whose names did not fit.

An analytics cookie beside a login or an unclassified cookie changes nothing: the request keeps all of
its cookies and stays per visitor. `wordpress_test_cookie` is kept on every request, because
`wp-login.php` fails without it. A consent plugin that reads its own cookie on the server and prints
different markup for it would see no cookie from a visitor who carries only consent cookies, so the
page such a visitor gets is the one a visitor who has not answered the banner gets.
