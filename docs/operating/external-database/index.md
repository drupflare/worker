# External Databases and Hyperdrive

Drupflare stores a site in the Durable Object that serves it. There is one object per site and it
holds both the interpreter and the SQLite database. That is the default.

An external database is an option for self-hosted deployments. It is not offered on the managed tier.
The limits listed on [Why the Default Is Not External](why-not-default.md), such as the configuration cap, the daily query limit and the missing MySQL
`COM_STMT_PREPARE`, are properties of a Cloudflare account, and a workerd an operator runs has no
account behind it. An external database also makes a site portable, and it moves site storage off the 5 GB
account-wide storage cap, which otherwise bounds how many sites a free account holds.

## Pages

- [Why the Default Is Not External](why-not-default.md): the measured reasons the object stays the default store.

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
under Platform Constraints in the [technical report](../../../TECHNICAL_REPORT.md). Hyperdrive is a compatibility option. It does not
add capacity.

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

- [Recovery](../recovery.md): what backs the site up and what restores it
- [Configuration](../../configuration/index.md): every var and binding
- [Technical report](../../../TECHNICAL_REPORT.md), Platform Constraints: the measured Durable Object SQLite limits
