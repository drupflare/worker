# Why the Default Is Not External

The reasons the Durable Object stays the default store for a site, each with the limit or measurement behind it.

## The Configuration Cap Bounds the Product Shape

A Hyperdrive configuration is per origin database. Free allows 10 per account and Paid 25, so a
product that gives each site its own database tops out at 25 sites per Cloudflare account regardless
of traffic. Sharing one configuration across every site means sharing ~20 origin connections on Free
or ~100 on Paid, against a design where each site is an independently woken object that answers with
no coordination.

A new site on the default backend costs one Durable Object and no account-level resource.

## Every Statement Parks

The park suspends a PHP call, and it cannot suspend the host callback a statement is already
executing inside. The external backend therefore yields each statement from PHP: `CfwSqlClient` hands
it to the Worker, which performs it, and the call resumes with the result. Every statement is then a
park and a network round trip, where the default backend answers it with a local read. A render issues 15 to 48
statements (see [The Query Budget](#the-query-budget)), and none of them can be deferred, because the render is waiting on the
answer.

## The Consistency Story Lives in the Object

One object per site is what makes the rest of the design work. The Durable Object gives strict
serializability, which is what the generation counter, the resumable migration cursor in
`cfw_migrate`, and the chunked restore in `src/db/import-sql.ts` are all built on. Each of those
assumes a single writer whose transactions cannot interleave with another writer's.

Postgres behind Hyperdrive is a different concurrency model reached over a pooled connection from
any isolate in any colo. Moving the data there removes the property the migration, the invalidation
and the restore are written against.

The pooler runs in transaction mode, and Cloudflare documents three consequences that bear directly
on Drupal. Session state does not persist, because connections are `RESET` when returned to the
pool. A single Worker invocation may obtain several different connections. And wrapping multiple
operations in one transaction to hold `SET` state is discouraged, since the connection cannot be
reused while the transaction is open. Drupal opens transactions around entity saves, batch API runs
and the installer.

## The Query Cache Cannot Be Used for a CMS on the Same Database

Query caching is the latency lever, it is on by default, and it has no write invalidation:
Cloudflare states that it does not purge cached read results when the application writes. Its own
guidance is to create a second binding to the same database with `--caching-disabled` and route
"authentication, sessions, permissions, billing state, admin settings, and reads immediately after a
write" through it.

For Drupal that list is `sessions`, `users_field_data`, `key_value`, `config`, `semaphore` and every
`cache_*` bin. A 60-second uninvalidated window over `cache_config` or `semaphore` is a correctness
failure and not a staleness tradeoff. What remains after disabling the cache is connection pooling,
which buys back a TCP, TLS and authentication handshake the default backend never pays.

Cache eligibility is also decided by text matching: both `VOLATILE` and `STABLE` PostgreSQL
functions make a query uncacheable, and a function name such as `NOW()` appearing in a SQL comment is
enough to trigger it.

## Latency Moves From Zero to Regional

Cloudflare quantifies an uncached query at 20-30 ms from a distant region and 1-3 ms when the Worker
is placed near the database, and says that multiple queries compound. A first render is 48 SQL
statements and a repeat render 18, so a cold render would spend roughly 1 to 1.4 seconds in network
alone at the distant figure, on top of the boot.

The documented remedy is `placement.region`, which pins the Worker to the database's cloud region.
That is the opposite of `SITE_LOCATION_HINT`, a KV-overridable setting that places a site near its
visitors. On the default backend those statements cost no network, because the storage is inside the
object making the call.

## An Open Socket Bills Duration

An outbound TCP connection held open inside a Durable Object blocks hibernation, defers eviction and
accrues duration charges for up to 15 minutes per connection. The backend opens a connection for each
statement and closes it, so no connection outlives a statement. A driver that held one across a render
would make it a billed residency decision. `src/ops/hibernation.ts` transcribes the eligibility list.

## The Query Budget

Hyperdrive on Free allows 100,000 database queries/day. A warm render costs 15 host statements,
measured on a deployed throwaway with the `page` and `dynamic_page_cache` bins emptied and the rest
warm (14 without the theme reset; 20 with `bootstrap` also emptied). So 100,000 queries is roughly
**6,666 renders/day**.

Regeneration on the free plan is bound by rows written at 10,866 renders/day with
`MEMORY_CACHE_BINS=none` and 50,916 at the shipping default; `bun scripts/measure/free-envelope.ts`
prints both. Hyperdrive's free query budget is below both, so it cannot raise the ceiling and would
lower it. The serving ceiling is unaffected: an edge cache hit never reaches the object and issues no
database query under either design, so 100,000 Worker requests/day still binds first.
