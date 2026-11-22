# Operations Settings

Settings for maintenance, owner access, audit, runtime overrides, database updates and pack reconciliation. The index of every variable is on [Configuration](../index.md).

## Pages

- [Owner Access and Audit](owner-access.md): owner token recovery and the audit log.
- [Updates and Reconciliation](updates.md): database updates, pack reconciliation and the addressable sweep.
- [Runtime Overrides](overrides.md): reading and writing overrides, and the three permissions.
- [Discovery Document](discovery.md): the settings, routes and limits a Drupal site reports to the dashboard.
- [WordPress Packages](wordpress-packages.md): installing, updating, rolling back and deleting plugins and themes, archive limits, core updates and the Multisite refusal.

## Site Maintenance

`/armfill`, `/invalidate`, `/bump`, `/migrate`, `/recycle`, `/ledger-gc`, `/strata-config`, `/strata-store` and `/updb` take the owner token. Purging your own page
cache does not expose arbitrary SQL or a whole-database overwrite, which are separate routes.

`/updb` drives a database update run. `GET` reports the run and its units; `POST` advances exactly
one beat and re-arms nothing, so a caller that wants the chain finished polls. The alarm chain drives
the same step.

`POST` takes an `action`, which is what starts a run rather than advancing one. Without it a beat has
nothing to advance and answers `{"beat":"none","reason":"no-run"}`.

| action              | what it does                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| none, `run`, `beat` | advances one beat, which is what the Operate page sends                     |
| `prepare`           | raises the maintenance fence, snapshots the bookkeeping and plans the units |
| `drain`             | runs up to `maxBeats` beats in this invocation; keep it at 1 on free        |
| `rollback`          | restores what the snapshot covers; legal only from a halted run             |
| `abandon`           | accepts a halted run as-is; requires a written `reason`                     |

`abandon` will not take a default reason. The next person reading the run has to see that a human
decided, and a generated string would forge that signature.

### The Repair Surface

What an owner token can fix, and what each one costs. The class decides whether a tool may run it
unattended: `safe` changes nothing a visitor sees, `rebuild` discards derived state that comes back
on its own, and `stateful` changes what the site serves.

| route                    | class    | what it does                                                           |
| ------------------------ | -------- | ---------------------------------------------------------------------- |
| `/health`                | safe     | reads the repair state, the ledger and the worker version              |
| `/health?clear=1`        | stateful | releases a quarantine, so the site serves again                        |
| `/updb`                  | safe     | reads the update run                                                   |
| `/updb` (POST)           | stateful | advances one beat of a database update                                 |
| `/updb?action=prepare`   | stateful | starts an update run, fence and snapshot included                      |
| `/updb?action=rollback`  | stateful | restores the bookkeeping a halted run snapshotted                      |
| `/armfill`               | rebuild  | queues a fill, so cold paths warm without a visitor                    |
| `/invalidate`            | rebuild  | drops stored pages for a path or a tag                                 |
| `/bump`                  | rebuild  | advances the generation, retiring every stored page                    |
| `/migrate`               | stateful | resumes first-run migration on a site that stalled                     |
| `/recycle` (POST)        | rebuild  | drops the PHP interpreter; the next request pays a full boot           |
| `/ledger-gc` (POST)      | safe     | trims the health ledger to 500 rows, newest kept                       |
| `/strata-config`         | safe     | reads Strata's `capture.statements`                                    |
| `/strata-config` (POST)  | stateful | sets Strata's `capture.statements`; the next request boots fresh       |
| `/strata-store`          | safe     | reads Strata's store: provider, bucket, endpoint, region, key flags    |
| `/strata-store` (POST)   | stateful | points Strata at an S3 or R2 bucket; makes the key; `enable` starts it |
| `/uninstall` (POST)      | stateful | removes a module through Drupal's installer, after naming dependents   |
| `/theme-default`         | safe     | reads the default and admin theme and the installed themes             |
| `/theme-default` (POST)  | stateful | sets the default or the admin theme to an installed theme              |
| `/extensions`            | safe     | lists every module, theme and profile with its version and state       |
| `/.well-known/drupflare` | safe     | reads the discovery document: settings, routes and limits              |
| `/rotate-token` (POST)   | stateful | issues a new owner token and refuses the old one                       |
| `/file` (PUT)            | stateful | writes a streamed body to R2 and records the file as held only there   |
| `/admin-password` (POST) | stateful | sets a new password for user 1 and answers it once                     |
| `/db-console` (POST)     | safe     | runs one read-only SELECT against the site database and returns rows   |
| `/writemark`             | safe     | reads the accepted-write count; POST and DELETE start and end the mark |
| `/writechanges`          | safe     | reads the rows changed since the mark                                  |
| `/git?action=unpin`      | stateful | releases a preview pin without reaching the remote                     |

`/recycle` and `/ledger-gc` take the owner token only; `PW_DIAGNOSTICS` does not reach them, and a
`GET` answers 405. `/recycle` answers `{ok, recycled, recyclesBefore, recyclesAfter}`, with
`recycled: false` when no interpreter was resident. While a transaction is open it answers 409 and
drops nothing. `/ledger-gc` answers `{ok, rowsBefore, rowsDeleted, cap}`; each deleted row counts
against the day's rows written.

`/strata-config` takes the owner token only. `GET` answers `{captureStatements}`. `POST` takes
`{"captureStatements": true | false}` and answers `{captureStatements, previous, applied: true}`.
It writes `capture.statements` on `strata.settings` through `ConfigFactory`, then drops the
interpreter and the heap images so the next request reads the new value. Setting the value the site
already holds answers the same body and writes nothing. It answers 409 `strata_not_enabled` when
`strata` is not in `core.extension` or has no `strata.settings` row, and 409 while a transaction is
open. A body that is not a boolean answers 400.

`/strata-store` takes the owner token only. `GET` answers
`{provider, enabled, bucket, endpoint, region, hasKey, hasCredentials}`; `enabled` is Strata's own
`enabled` setting. It never returns a key or a secret. `POST` takes
`{"endpoint", "bucket", "region", "accessKeyId", "secretAccessKey", "pathStyle"}` and an optional
`"enable": true | false` (default false), and answers
`{provider, bucket, endpoint, region, applied: true, previous: {provider, bucket}, keyCreated, enabled}`,
with no key or secret in it. `enable: true` also sets Strata's `enabled` setting in the same write, so
the journal starts; `false` or absent never changes `enabled`, and the route never turns Strata off.
`enabled` in the answer is the stored value after the call. `endpoint` is an `https` origin with no path, `bucket` is 3 to 63 characters
of `a-z`, `0-9` and `-`, `region` is non-empty (R2 uses `auto`), and each key is 1 to 256 printable
characters with no space. A refused body answers 400 with one of `invalid_body`, `invalid_endpoint`,
`invalid_bucket`, `invalid_region`, `invalid_access_key_id`, `invalid_secret_access_key` or
`invalid_path_style` or `invalid_enable`. It sets `provider` to `s3` and the `s3.*` keys on `strata.settings` through
`ConfigFactory`, then drops the interpreter and the heap images. When `key` is empty it also creates
the encryption key through Strata's `KeyMaker`, the service behind `drush strata:new-key`, and
reports `keyCreated: true`; a key that exists is never replaced, and the cipher is never changed. A
repeat of the stored body answers the same shape and writes nothing; with `enable: true` it writes
only while `enabled` is still false. It answers 409
`strata_not_enabled` when `strata` is not in `core.extension` or has no `strata.settings` row, 409
`strata_s3_not_enabled` when `strata_s3` is not enabled (enable it through `/enable` first), and 409
while a transaction is open. A failed write answers 500 `strata_store_write_failed` with at most the
PHP exception class, never its message.

`/uninstall`, `/theme-default` and `/rotate-token` take the owner token only. `POST /uninstall?module=NAME`
removes one enabled module. It reads the enabled modules that require NAME first and answers 409
`module_has_dependents` with their names while any is enabled, then answers 409 `uninstall_blocked`
with `reasons` when Drupal's own uninstall validators refuse (a module that ships with every site, or
one that owns content). `?dry=1` answers 200 with `{module, dryRun, enabledModules, dependents,
reasons, wouldDelete}` and changes nothing. `wouldDelete` lists the files `cfw_module_file` holds for
the package `drupal/NAME` or `NAME`; the route never deletes them. A success answers
`{ok, module, uninstalled: true, dependents: []}`, drops the interpreter and heap images and advances
the page generation. A module that is not in `core.extension` answers 404 `module_not_enabled`, a
name that is not a machine name answers 400, and a failure answers 500 `uninstall_failed` with the
PHP class and a message of at most 300 characters.

`/extensions` takes the owner token and answers `GET` only. It answers a JSON array of
`{name, kind, version, enabled}`, one row for each module, theme and install profile Drupal discovers,
sorted by name and then kind. `kind` is `module`, `theme` or `profile`. `version` is the value the
info file states, or `null` when it states none. `enabled` is true when `core.extension` holds the
extension; a profile is enabled when it is the installed one, and appears once, as a profile, not
again as a module. A module whose files were delivered but not yet enabled is listed with
`enabled: false`. The route reads only, so it answers on a replica as `/health` does. It carries no
advisory state; the dashboard adds that from its own feed. It answers 405 for other methods, 501
`drupal_only` on WordPress and 500 `extensions_unreadable` with the PHP class when the kernel cannot
list them.

`/theme-default` answers `GET` and `POST ?dry=1` with `{default, admin, installed}`. `POST` takes
`{"project": "<theme>", "target": "default" | "admin"}` and answers
`{default, admin, installed, previous, applied: true}`; it sets that one key of `system.theme`
through `ConfigFactory`, then drops the interpreter and heap images and advances the page
generation. Naming the theme a key already holds writes nothing. An empty `project` with target
`admin` clears the admin theme, so the site uses the default theme for admin pages; `default`
takes no empty value. A theme that is not installed
answers 404 `theme_not_installed` (install and enable it first), and a body of any other shape
answers 400.

`/admin-password` takes the owner token only, `POST` only, with no body. It generates a password of
32 characters, sets it on user 1 through Drupal's user entity (so Drupal hashes it and ends that
user's other sessions), and answers `{ok, uid, name, blocked, password, applied: true}` with
`cache-control: no-store`. The password is shown once in this reply and is never stored or audited;
the audit entry names the route only. It does not unblock a blocked account. It answers 404
`admin_not_found` when user 1 does not exist, 409 while a transaction is open or on a replica, and 500
`admin_password_failed` with the PHP class on a failure. A site that runs WordPress answers 501
`drupal_only`.

`PUT /file?uri=public://path/name.png` registers a file that is held only in R2, which a site import
uses so the bytes never pass through the object. It takes the owner token, a `content-length`, the
hex sha256 of the bytes in `x-file-sha256` and, optionally, the type in `content-type`. The body
streams to this site's own prefix in the bucket for the scheme (`FILES`, or `FILES_PRIVATE` for
`private://`), where R2 checks the digest as it receives the bytes; the object then records an
evicted row with no resident chunks, so `/offloaded` lists it and a read comes from R2. The row is
written only after R2 has stored the size the caller declared. An existing file at the same URI is
replaced. The site needs `FILE_STORE=r2` and the bucket bound, or the route answers 501
`no_r2_store`. Other refusals, each `{ok: false, error, code}`: 400 `bad_uri`, `sha256_required`
and `length_required`; 422 `digest` when the bytes do not match, and `size`; 429 `r2_budget` when
this month's R2 write allowance is spent; 502 `storage_unavailable`; 405 for any method but `PUT`.
Each call spends one R2 write against that allowance. The body ceiling is `MAX_FILE_PUT_BYTES`
(100 MiB by default, the platform's request limit; `0` disables). The success answer is
`{ok, uri, size, sha256, store: "r2", replaced}`. Every call is recorded in the audit log as `/file`.

`/db-console` takes the owner token only, `POST` only. The body is
`{"v": 1, "sql", "params", "limit", "timeoutMs"}` with `sql` up to 10,000 characters, up to 100
params, a `limit` up to 1,000 rows and a `timeoutMs` up to 30,000. A success answers
`{columns, rows, truncated, elapsedMs}`; each cell is a string, number, boolean or null, a blob is
`x'<hex>'`, and an integer past 2^53 is a string. Every refusal is `{code, message}`: 422
`not_read_only` for anything but one SELECT, WITH or VALUES statement (a write or schema keyword
anywhere outside a comment or literal refuses it, so quote a column named `update`), 413
`too_large` for a bound above those limits, 400 `statement_failed` for a statement SQLite rejects
(a typo or a missing table, with SQLite's message), and 400 or 503 `unavailable` for a malformed
body or a transaction that is open. A statement that wrote a row despite the check is rolled back
and answers 422. Durable Object SQL cannot be interrupted, so the row limit stops the copy and not
the scan, and a result cut at `limit` answers `truncated: true`. `timeoutMs` is advisory: it is
checked against its bound and never enforced, so a slow statement still answers its rows, and
`elapsedMs` says how long it took. Send a `LIMIT` with the statement. Every call is recorded in the
audit log as `/db-console`, never with the statement.

`/git?action=unpin` exists because `unpreview` cannot help here: it re-syncs to the branch head, so it
needs the remote to answer, and a pin held against a remote that is down is exactly what an operator
is trying to release. Releasing without a sync leaves the site serving what it already serves and
gives the poller the branch back, so the next successful poll converges it.

A quarantine is released rather than prevented. `/health` reports what tripped it and the ledger
entry that recorded it; clearing without reading that first is how the same fault comes back.

A withdrawn replica lane is not a repair target. It asks the primary for a fresh copy itself, and the
primary queues that copy and arms an alarm to perform it. `/replica` is diagnostic only: it also
carries the path a lane uses to commit a batch it executed speculatively, which belongs to the pool
rather than to the owner token. Read the state through `/health` and `/serve-stats`. The pool itself
is on [Replica Lanes](../../operating/replica-lanes.md).

### The Degradation Band

Once a site leaves `normal`, every response it serves carries these headers:

| header                 | value                                                   |
| ---------------------- | ------------------------------------------------------- |
| `x-cfw-degrade`        | `reduced` or `read-only`                                |
| `x-cfw-degrade-driver` | which meter drove it: `rows` or `do`                    |
| `x-cfw-degrade-at`     | the fraction of that meter's daily budget already spent |

A `normal` site carries none of them, so their presence is the signal and no parsing is needed to
tell the two states apart.

The band is reported on every response from `reduced` onward, not only on a refusal. The level is
not persisted: the counter is keyed per UTC day, so midnight clears it.

`/serve-stats` reports `lastGitPoll`, `lastMirrorDrain` and `lastPageMirrorDrain`, each with its
`*At`. Every alarm unit catches its own error so one failure cannot stop the chain, so these
timestamps are the way to see a unit that has been failing.

## The Admin Surface

The seven `/_cfw` pages take the same owner token. A browser cannot put a header on its own navigation,
so `/_cfw/login` exchanges the token for a cookie: `HttpOnly`, `SameSite=Strict`, twelve hours,
cleared by `/_cfw/logout`. A page reached without it redirects to the sign-in form and returns
afterwards. A bearer header reaches the same pages, so a script needs no browser.

**`PW_DIAGNOSTICS` does not open these pages.** It opens the other owner routes. These pages install
code and run privileged operations, so they take the owner token only.
`SameSite=Strict` is what stands in for a CSRF token: several owner routes act on a GET, so a
cross-site request carrying the cookie would be enough to install a module. Strict means no
cross-site request carries it, including a top-level link.
