# External Databases and Hyperdrive

Drupflare stores a site in the Durable Object that serves it. There is one object per site and it
holds both the interpreter and the SQLite database. That is the default.

An external database is an option for self-hosted deployments. It is not offered on the managed tier.
The limits listed below, such as the configuration cap, the daily query limit and the missing MySQL
`COM_STMT_PREPARE`, are properties of a Cloudflare account, and a workerd an operator runs has no
account behind it. An external database also makes a site portable, and it removes the 5 GB
account-wide storage cap that is otherwise the only hard limit on fleet size.

## Selecting One

`DB_BACKEND` chooses: `do-sqlite` (the default, the object's own storage) or `hyperdrive`. Choosing
`hyperdrive` with no `HYPERDRIVE` binding is reported as misconfigured and does not fall back, because
a site running on a different database from the one its operator chose is worse than one that refuses
to start.

The clients are `pg` and `mysql2`, ordinary npm dependencies in the Worker. **Hyperdrive supplies no
client**. It supplies a pooled endpoint and a connection string, and Cloudflare's own get-started says
"you will need a database driver". Both clients are imported dynamically, so a deployment that never
selects this backend evaluates neither. A client is opened for each statement and closed after it, so
the object holds no socket between statements.

The connection string's scheme picks the client: `postgres://`, `postgresql://` and `mysql://` are
what Hyperdrive itself accepts. There is no second setting to disagree with the string.

Two differences between the databases are handled in the adapter (`src/db/pg-exec.ts`), and the
driver does not know which one it is on:

- **Placeholders.** The driver emits `?`, which MySQL takes as-is and PostgreSQL does not, so a
  PostgreSQL statement is rewritten to `$1..$n`. A `?` inside a quoted literal is left alone.
- **No prepared statements on MySQL.** `mysql2`'s `execute()` sends `COM_STMT_PREPARE`, which
  Hyperdrive does not support. `query()` interpolates client-side and sends one text statement, which
  survives the pool.

PostgreSQL answers a `SELECT` as `{rows: [...], rowCount: n}` and an `INSERT` as
`{rows: [], rowCount: n}`. MySQL answers a `SELECT` as an array and an `INSERT` as a header object
carrying `affectedRows`. The adapter reduces both to the one shape the host's own SQL seam uses.

`cfwSqlExec` is synchronous, the same property that puts KV, R2, D1 and `env.ASSETS.fetch()` out of
reach of a read, and a `pg` query is not. So the driver yields the statement instead: `rom`'s
`CfwSqlClient` opens a `cfwpark+sql://` pseudo-socket, `ext/cfwpark` freezes the continuation, the
Worker runs the query, and the chain resumes inside the same invocation. The HTTP transport rides the
same trap under a different scheme.

**A refused yield is an error and not a fallback.** A refused fetch falls back to the deferred one,
but there is no local copy of an external database to answer from, so a refusal reaches Drupal as a
database error.

### Verifying It Without a Deploy

`localConnectionString` makes `wrangler dev` connect straight to a database, so the whole path is
drivable against the rig:

```sh
docker compose -f docker/compose.yml up -d postgres # or: mysql
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://drupflare:drupflarepass@127.0.0.1:5432/drupflare"
# mysql://drupflare:drupflarepass@127.0.0.1:3306/drupflare
```

The `hyperdrive` binding is not in the canonical `wrangler.jsonc`. A binding that names a
configuration that does not exist refuses the deploy, so it is an opt-in addition for a deployment
that has one.

`/backend` (diagnostic-gated) runs `SELECT 1` through the binding from inside the object and reports
the dialect and latency. It never echoes the connection string.

## What Hyperdrive Is For

Hyperdrive is connection pooling and query caching in front of a database you already run. It does
not store data. You point it at a PostgreSQL or PostgreSQL-compatible database, or a MySQL database,
and it gives a Worker a pooled connection string on `env.HYPERDRIVE.connectionString` that a normal
driver such as `pg` connects to. The pooling is the primary value: a Worker that dials a remote
database directly pays TCP, TLS and authentication on every request.

Current Cloudflare documentation:

| Property                   | Value                                                      |
| -------------------------- | ---------------------------------------------------------- |
| Plan availability          | Free and Paid Workers plans                                |
| Free plan limit            | 100,000 database queries/day, reset 00:00 UTC              |
| What counts as a query     | any statement, cached or uncached, `SELECT` through `DROP` |
| Configurations per account | 10 on Free, 25 on Paid                                     |
| Origin connections         | ~20 per configuration on Free, ~100 on Paid                |
| Query cache defaults       | `max_age` 60 s, `stale_while_revalidate` 15 s              |
| Query cache maximum        | `max_age` 1 hour                                           |
| Maximum cached response    | 50 MB                                                      |
| Maximum statement duration | 60 s                                                       |
| Initial connection timeout | 15 s                                                       |
| Idle connection timeout    | 10 minutes                                                 |
| Egress charge              | none                                                       |
| Pooling and caching charge | none beyond the plan limits                                |

Exceeding the free query limit fails the operation with an error rather than billing for it.
Hyperdrive does not support MySQL `COM_STMT_PREPARE`, so prepared statements have to be removed from
MySQL queries; named prepared statements work only through `postgres.js` and `node-postgres`.

A cached query still counts against the daily limit, so query caching buys latency and origin load
and no quota. The cache is keyed on statement text including comments, so a comment naming a
volatile function such as `NOW()` can make a query uncacheable. Cloudflare does not document SQL
comments as a cache-control API and recommends a cache-disabled configuration where a guaranteed
fresh read is needed.

Cloudflare documents local development two ways. The Workers local-development page lists
Hyperdrive among the bindings with no local simulation ("currently unsupported"), while a changelog
entry and the Hyperdrive local-development page describe `localConnectionString` and
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING_NAME>` connecting `wrangler dev` to a real
database, including a remote one over TLS. The `localConnectionString` mechanism is the one that
works.

A Hyperdrive binding is usable from inside a Durable Object. On a paid account, with a PostgreSQL 17
origin behind a Cloudflare Tunnel reached through a Workers VPC service, the object read
`env.HYPERDRIVE.connectionString` and completed `SELECT 1` in 6-9 ms of query time on three
consecutive requests.

The path has three requirements:

- **The origin must speak TLS.** Hyperdrive refuses a plaintext PostgreSQL (`code 2012`).
- **Certificate verification is set on the VPC service.** The origin takes no `--sslmode` or custom
  CA on the Hyperdrive configuration; Hyperdrive answers `mtls cannot be used with service_id`
  (`code 2007`). Set `--cert-verification-mode` on the VPC service instead. A self-signed origin
  certificate is otherwise refused with `CERTIFICATE_VERIFY_FAILED` (`code 2015`).
- **The token needs a Hyperdrive permission.** An account API token may carry none. A configuration
  created through `wrangler login` works, because its OAuth scopes include Hyperdrive.

## Why the Default Is Not External

### The Configuration Cap Bounds the Product Shape

A Hyperdrive configuration is per origin database. Free allows 10 per account and Paid 25, so a
product that gives each site its own database tops out at 25 sites per Cloudflare account regardless
of traffic. Sharing one configuration across every site means sharing ~20 origin connections on Free
or ~100 on Paid, against a design where each site is an independently woken object that answers with
no coordination.

A new site on the default backend costs one Durable Object and no account-level resource.

### Every Statement Parks

The park suspends a PHP call, and it cannot suspend the host callback a statement is already
executing inside. The external backend therefore yields each statement from PHP: `CfwSqlClient` hands
it to the Worker, which performs it, and the call resumes with the result. Every statement is then a
park and a network round trip, where the default backend answers it with a local read. A render issues 15 to 48
statements (see below), and none of them can be deferred, because the render is waiting on the
answer.

### The Consistency Story Lives in the Object

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

### The Query Cache Cannot Be Used for a CMS on the Same Database

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

### Latency Moves From Zero to Regional

Cloudflare quantifies an uncached query at 20-30 ms from a distant region and 1-3 ms when the Worker
is placed near the database, and says that multiple queries compound. A first render is 48 SQL
statements and a repeat render 18, so a cold render would spend roughly 1 to 1.4 seconds in network
alone at the distant figure, on top of the boot.

The documented remedy is `placement.region`, which pins the Worker to the database's cloud region.
That is the opposite of `SITE_LOCATION_HINT`, a KV-overridable setting that places a site near its
visitors. On the default backend those statements cost no network, because the storage is inside the
object making the call.

### An Open Socket Bills Duration

An outbound TCP connection held open inside a Durable Object blocks hibernation, defers eviction and
accrues duration charges for up to 15 minutes per connection. The backend opens a connection for each
statement and closes it, so no connection outlives a statement. A driver that held one across a render
would make it a billed residency decision. `src/ops/hibernation.ts` transcribes the eligibility list.

### The Query Budget

Hyperdrive on Free allows 100,000 database queries/day. A warm render costs **15 host statements**,
measured on a deployed throwaway with the `page` and `dynamic_page_cache` bins emptied and the rest
warm (14 without the theme reset; 20 with `bootstrap` also emptied). So 100,000 queries is roughly
**6,666 renders/day**.

Regeneration on the free plan is bound by rows written at **10,866 renders/day** with
`MEMORY_CACHE_BINS=none` and **50,916** at the shipping default; `bun scripts/measure/free-envelope.ts`
prints both. Hyperdrive's free query budget is below both, so it cannot raise the ceiling and would
lower it. The serving ceiling is unaffected: an edge cache hit never reaches the object and issues no
database query under either design, so 100,000 Worker requests/day still binds first.

## What Hyperdrive Buys

Someone who already runs a PostgreSQL or MySQL database and wants Drupal in front of it gets pooling,
a shared query cache, and no egress charge. If that database is the system of record for something
other than the Drupal site, keeping it where it is may be the only correct architecture.

Beyond the site's own database, the tier `src/ops/tcp.ts` defines fits a secondary, host-side,
deferrable read against a database the operator owns, dispatched by scheme through `cfw_http_queue`,
with the endpoint set by the operator and never by the caller. A search index, an analytics sink or an
external content feed has that shape.

A socket exchange that has to answer inside the request uses the park instead. A trapped socket call
freezes PHP where it stands, the Worker performs the exchange, and the call returns with the answer
in the same request. That is how `drupal/redis` runs, and how the site database runs on an external
backend. It costs a network round trip per exchange where the Durable Object's own SQLite costs a
local read, which is why SQLite is the default and the cache backend.

An external database also avoids the compatibility gaps that come from Durable Object SQLite and not
from SQLite itself: the 100 bound-parameter cap, the 50-byte LIKE/GLOB pattern limit, integer reads
that lose precision above 2^53, and the absence of `NOCASE_UTF8` and `REGEXP`. They are documented
under Platform Constraints in `TECHNICAL_REPORT.md`. Hyperdrive is a compatibility option and not a
capacity lever.

## What It Costs

- **The one-click goal.** Standing a site up requires provisioning and paying for a database first.
  There is no free tier of "a Postgres you own".
- **The consistency primitives.** The generation counter, the resumable migration and the chunked
  restore are written against a single writer in one object, and an external database has a
  different concurrency model.
- **A round trip per statement.** Each statement parks and waits on the network. JSPI does not
  change that: JSPI is dominated by the park and is worth about 1% of the regeneration ceiling on
  its own.
- **A second failure domain.** On the default backend a site is up when its object is up. With an
  external database it is up when the object, Hyperdrive and the database are all up.

## Related

- `docs/recovery.md`: what backs the site up and what restores it
- `docs/configuration.md`: every var and binding
- `TECHNICAL_REPORT.md`, Platform Constraints: the measured Durable Object SQLite limits
