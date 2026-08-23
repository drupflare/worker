# Recovery

A site is a Durable Object holding a SQLite database. Four primitives can move it backwards, and
they answer different failures. Picking the wrong one either does nothing or destroys more than it
restores.

| Primitive              | Scope                             | Window                 | Survives object loss |
| ---------------------- | --------------------------------- | ---------------------- | -------------------- |
| Point-in-time recovery | the object's whole storage        | 30 days                | no                   |
| `/export` dump         | the site database, as SQL text    | as long as you keep it | yes                  |
| `wrangler rollback`    | Worker code and config            | 100 versions           | n/a                  |
| The R2 mirror          | rendered pages and uploaded files | current state          | yes                  |

**PITR is operational recovery, not backup.** It reverses a change to an object that still exists.
It lives in the same place as the data it protects, so a deleted namespace, a deleted Worker or a
lost account takes the recovery log with it. The `/export` dump is the only thing on this page that
leaves the platform, and it is the only thing that answers "the object is gone".

## Point-in-Time Recovery

SQLite-backed Durable Objects can be restored to any point in the **past 30 days**. The window
covers the whole of `ctx.storage`, both SQL tables and key-value pairs.

Recovery is addressed by **bookmarks**, not timestamps. A bookmark is a mostly alphanumeric string
such as `0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b`, and bookmarks are lexically
comparable, so ordering them as strings orders them in time. Three methods:

| Method                                        | Returns                                                     |
| --------------------------------------------- | ----------------------------------------------------------- |
| `ctx.storage.getCurrentBookmark()`            | a bookmark for now                                          |
| `ctx.storage.getBookmarkForTime(t)`           | a bookmark for a `Date` or epoch ms within the last 30 days |
| `ctx.storage.onNextSessionRestoreBookmark(b)` | a bookmark that undoes the restore it schedules             |

The restore is applied on the object's **next** start, not immediately. The bookmark returned by
`onNextSessionRestoreBookmark()` is the undo, so capture it before restarting.

**There is no wrangler command and no dashboard button.** PITR is a runtime API only, which means an
operator can reach it only through code running inside the Durable Object.

**Drupflare does not call it.** `getCurrentBookmark`, `getBookmarkForTime` and
`onNextSessionRestoreBookmark` have zero references under `src/` and `scripts/`, so no route exposes
it today. Using it requires adding one.

**It is not supported in local development.** Cloudflare's wording: "The PITR API is not supported in
local development because a durable log of data changes is not stored locally." The gate cannot cover
it and any claim about its behaviour here needs a deployed test.

## The Export Dump

`GET /export` with `Authorization: Bearer <ownerToken>` dumps the site database as replayable SQL.
It is one of four routes the owner token reaches without `PW_DIAGNOSTICS=1`.

The dump is produced host-side by `dumpDatabase()` in `src/db/export-sql.ts`, not by PHP. Every value
is read as `typeof()` plus `hex()` and never as the column, because a Durable Object SQLite integer
read loses precision above 2^53 and a `hex()` of an integer never passes its digits through a double.
REAL is the one class read directly.

What a dump contains:

- **Structure only** for tables whose rows regenerate: every `cache_*` bin, `cachetags`, `sessions`,
  `semaphore`, `flood`, `queue`, `watchdog`, `history`, the `search_*` tables and `cfw_page`. This is
  correctness rather than size. A restored `cache_container` would boot the site on the previous
  site's service container, and `cachetags` checksums that disagree with the bins they describe leave
  rows that are present and permanently rejected.
- **Nothing at all** from `cfw_migrate`, `cfw_import` and `cfw_import_chunk`. A dump carrying
  `cfw_import_chunk` would contain itself, and one carrying `cfw_migrate` would have a replay
  overwrite the cursor that makes the replay resumable.
- **No secrets by default.** The owner token, the Cloudflare OAuth access and refresh tokens and
  `hash_salt` are withheld and the count of withheld rows is reported. `?secrets=1` carries them. A
  faithful restore needs `hash_salt`, since it signs one-time login links and form tokens; a backup
  stored anywhere else should not have it.

Options:

| Parameter       | Effect                                                            |
| --------------- | ----------------------------------------------------------------- |
| `?cursor=start` | chunked and resumable; each response carries `nextCursor`         |
| `?body=1`       | include the SQL text in a chunked response rather than its length |
| `?all=1`        | carry rows for the regenerable tables too                         |
| `?secrets=1`    | carry the four withheld `cfw_meta` keys                           |
| `?limit=N`      | cap rows per table                                                |
| `?chunkChars=N` | override the 1,000,000-character chunk size                       |

**A dump that cannot be replayed answers 409 rather than 200.** A restore point nobody can replay is
worse than none, because it reads as a backup. `?all=1` is the usual way to produce one: the whole
`cache_container` row measures 960,544 characters against the 100,000-character Durable Object
statement ceiling. A chunked export answers 409 on a shape mismatch as well, which is how splicing
two different dumps into one file is caught.

## Restore

`POST /restore` with the dump as the request body. **This route is diagnostic-gated, not
owner-gated**: it needs `PW_DIAGNOSTICS=1`, because it overwrites a whole database. Export is a
supported customer-facing property; restore is an operator action taken deliberately.

The body is stored, not executed. `storeImport()` splits it into statements, refuses at store time if
any statement exceeds the 100,000-character ceiling, and writes the parent row and every chunk in one
`transactionSync()`. Then the object arms its alarm and the replay runs there, a chunk at a time. The
invocation that accepts the upload is never the one holding a half-overwritten site open.

`?label=` names the restore point; it defaults to the current time. `GET /health` reports whether a
complete stored import exists.

## The Recovery Matrix

| Failure                     | Primitive                                    | Does not cover                                                                                                                                     | Command                                                                      |
| --------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Accidental content deletion | PITR to just before the delete               | anything written after the bookmark; the object must still exist; needs code that calls the API                                                    | in-object: `getBookmarkForTime(t)` then `onNextSessionRestoreBookmark(b)`    |
| Bad module update           | PITR, then `wrangler rollback` if code moved | files already mirrored to R2; a config change an editor made after the update                                                                      | as above, plus `wrangler rollback [VERSION_ID]`                              |
| Corrupted config            | `/restore` of the last good dump             | content created since that dump; needs `PW_DIAGNOSTICS=1`                                                                                          | `POST /restore?label=pre-fix` with the dump as the body                      |
| Failed migration            | re-run the migration                         | nothing, if the cursor survived; `cfw_migrate` is resumable and a dump deliberately excludes it                                                    | `drangler migrate ...`; `GET /migrate` reports `chunk`, `chunks` and `done`  |
| Whole-object loss           | `/restore` into a new object                 | PITR entirely -- the log died with the object; `hash_salt` unless the dump used `?secrets=1`                                                       | `POST /restore` against the new site name                                    |
| Worker version rollback     | `wrangler rollback`                          | **the database.** Code moves, data does not. Refused if a Durable Object class lifecycle change or a deleted binding sits between the two versions | `wrangler rollback [VERSION_ID] --name <worker>`                             |
| R2 asset loss               | the mirror refills from the object           | nothing; the object is the durable copy and R2 is a cache in front of it                                                                           | no operator route; `/__mirror` is DO-internal and the alarm drains the queue |

Two rows carry the distinctions that matter most.

**A Worker rollback is not a data rollback.** `wrangler rollback` creates a new deployment from a
previous version and becomes active across every route immediately. It reaches the 100 most recent
versions. It does not touch `ctx.storage`, so a bad deploy that also wrote bad rows needs both a
rollback and a PITR restore, in that order. Cloudflare refuses the rollback outright if a Durable
Object class lifecycle change happened between the two versions, or if the target version binds an R2
bucket, KV namespace or queue that no longer exists.

**R2 is a mirror, not a backup.** With no `FILES` bucket bound -- the free-tier default -- the object
is the durable copy and there is nothing to lose. With one bound, the bucket holds rendered pages and
uploaded files that the object still has, and the mirror queue refills it on the alarm.

## Keeping a Dump

Nothing schedules an export. A dump exists because someone asked for one, and it lives wherever they
put it. For a site whose object still exists, PITR covers the last 30 days with no storage of your
own; the dump is what covers everything else.

Two properties make an unattended export practical: `?cursor=` walks the database in bounded chunks
rather than building the whole file in one invocation, and a 409 tells the caller the file it just
built is not replayable, so a backup job can fail loudly instead of storing something that reads
like a backup.

## Related

- `docs/configuration.md` -- `PW_DIAGNOSTICS`, the `FILES` binding and the runtime overrides
- `docs/external-database.md` -- why the data lives in the object
- `TECHNICAL_REPORT.md` DEEP DIVE B -- the 100,000-character statement ceiling and the other
  measured Durable Object SQLite limits
