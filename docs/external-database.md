# External Databases and Hyperdrive

Drupflare stores a site in the Durable Object that serves it. There is one object per site and it
holds both the interpreter and the SQLite database. This page explains why an external database is
not an option the product offers, and what Hyperdrive is for.

## What Hyperdrive Is

Hyperdrive is connection pooling and query caching in front of a database you already run. It does
not store data. You point it at a PostgreSQL or PostgreSQL-compatible database, or a MySQL database,
and it gives a Worker a pooled connection string on `env.HYPERDRIVE.connectionString` that a normal
driver such as `pg` connects to. The pooling is the primary value: a Worker that dials a remote
database directly pays TCP, TLS and authentication on every request.

Current Cloudflare documentation, checked 2026-08-23:

| Property                   | Value                                                      |
| -------------------------- | ---------------------------------------------------------- |
| Plan availability          | Free and Paid Workers plans                                |
| Free plan limit            | 100,000 database queries/day, reset 00:00 UTC              |
| What counts as a query     | any statement, cached or uncached, `SELECT` through `DROP` |
| Query cache defaults       | `max_age` 60 s, `stale_while_revalidate` 15 s              |
| Query cache maximum        | `max_age` 1 hour                                           |
| Maximum cached response    | 50 MB                                                      |
| Maximum statement duration | 60 s                                                       |
| Egress charge              | none                                                       |
| Pooling and caching charge | none beyond the plan limits                                |

Exceeding the free query limit fails the operation with an error rather than billing for it.

Two things are worth being exact about. **A cached query still counts** against the daily limit, so
query caching buys latency and origin load, never quota. And **the cache is keyed on statement text**
including comments, which means a comment naming a volatile function such as `NOW()` can make a
query uncacheable; Cloudflare does not document SQL comments as a cache-control API and recommends a
cache-disabled configuration where a guaranteed fresh read is needed.

**Local development is documented two ways and they disagree.** The Workers local-development page
lists Hyperdrive among the bindings with no local simulation ("currently unsupported"), while a
2025-12-04 changelog and the Hyperdrive local-development page describe `localConnectionString` and
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING_NAME>` connecting `wrangler dev` to a real
database, including a remote one over TLS. Treat the `localConnectionString` mechanism as the working
answer and the local-development page as stale.

**Whether a Hyperdrive binding is usable from inside a Durable Object is unverified.** A Durable
Object receives `env` and Hyperdrive is an `env` binding, so it is reachable in principle, but no
Cloudflare document found says so. Verifying it means a deployed Durable Object reading
`env.HYPERDRIVE.connectionString` and completing one query; nothing short of that settles it.

## Why the Site Database Is Not External

### The Interpreter Cannot Await

`SqlLike.exec()` in `src/db/migrate-sql.ts` is synchronous and returns a cursor, and every write path
runs inside `ctx.storage.transactionSync()`. That is not a style choice: PHP compiled to wasm is a
synchronous interpreter, and the shipping build is not a JSPI build. `wrangler.jsonc` aliases
`./runtime/php-binary.js` to `src/runtime/php-binary-85.ts`; the JSPI seam
(`src/runtime/php-binary-jspi.ts`) targets an 8.3 experiment build and does not ship. Without JSPI,
PHP cannot suspend across a JavaScript `await`, so a database reachable only through a Promise cannot
be read from inside a Drupal render.

The project already lives with this on the outbound HTTP path, and the shape of that workaround is
the argument. PHP's HTTP goes through a stream wrapper and a queue drained on the alarm
(`HTTP_DRAIN_LIMIT`), and `TECHNICAL_REPORT.md` records what it costs: `Drupal::httpClient()` cannot
retrieve response headers through it at all, because only PHP's own http wrapper populates
`$http_response_header`. That is one subsystem making a handful of calls. A database makes fifteen
per warm render, and none of them can be deferred to an alarm, because the render is waiting on the
answer.

### The Consistency Story Lives in the Object

One object per site is what makes the rest of the design work. The Durable Object gives strict
serializability for free, which is what the generation counter, the resumable migration cursor in
`cfw_migrate`, and the chunked restore in `src/db/import-sql.ts` are all built on. Each of those
assumes a single writer whose transactions cannot interleave with another writer's.

Postgres behind Hyperdrive is a different concurrency model reached over a pooled connection from
any isolate in any colo. Moving the data there does not swap a binding; it removes the property the
migration, the invalidation and the restore are written against.

### The Arithmetic Does Not Help Either

Hyperdrive on Free allows 100,000 database queries/day. A warm render costs **15 host statements**,
measured on a deployed throwaway with the `page` and `dynamic_page_cache` bins emptied and the rest
warm (14 without the theme reset; 20 with `bootstrap` also emptied). So 100,000 queries is roughly
**6,666 renders/day**.

Score that against the two ceilings in RULE 0b. The regeneration ceiling is **1,052 renders/day**
cold and **7,575** windowed, bound by rows written. Hyperdrive's free query budget lands inside that
range rather than above it, so it does not raise the ceiling it would have to raise to be a capacity
lever. The serving ceiling is untouched: an edge cache hit never reaches the object and issues no
database query under either design, so 100,000 Worker requests/day still binds first.

## What Hyperdrive Would Buy

It is a real answer to a question this product does not ask. Someone who already runs a PostgreSQL
or MySQL database and wants Drupal in front of it gets pooling, a shared query cache, and no egress
charge. If that database is the system of record for something other than the Drupal site, keeping
it where it is may be the only correct architecture.

It would also close a set of compatibility gaps that come from Durable Object SQLite specifically
rather than from SQLite: the 100 bound-parameter cap, the 50-byte LIKE/GLOB pattern limit, integer
reads that lose precision above 2^53, and the absence of `NOCASE_UTF8` and `REGEXP`. Those are
documented in DEEP DIVE B of `TECHNICAL_REPORT.md` and each one has broken something real. Hyperdrive
is a compatibility escape hatch, not a capacity one.

## What It Costs

- **The one-click goal.** Standing a site up would require provisioning and paying for a database
  first. There is no free tier of "a Postgres you own".
- **The consistency primitives.** The generation counter, the resumable migration and the chunked
  restore would each need rewriting against a different concurrency model.
- **A JSPI interpreter, or an async bridge for every statement.** This is the blocking item, and it
  is measured rather than assumed: RULE 0b puts JSPI at about 1% of the regeneration ceiling as a
  performance lever, so it would be built for this reason alone.
- **A second failure domain.** Today a site is up when its object is up. With an external database it
  is up when the object, Hyperdrive and the database are all up.

## Related

- `docs/recovery.md` -- what backs the site up and what restores it
- `docs/configuration.md` -- every var and binding
- `TECHNICAL_REPORT.md` DEEP DIVE B -- the measured Durable Object SQLite limits
