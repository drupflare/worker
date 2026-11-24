# Dashboard Requests

The worker side of the dashboard's request list, one section per row. The row numbers are the
dashboard's own. Status is one of built, verified, question or declined. The commit or snapshot
column is left for the person who commits.

Rows 1, 12, 25, 26 and 27 are not touched here: 1 and 12 shipped, and 25 to 27 are withdrawn.

## New Owner Route Paths

Add these three to the dashboard's `OWNER_ROUTE_PATHS`. All take the owner token only.

- `/uninstall`
- `/theme-default`
- `/rotate-token`

## Index

| Row                       | Subject                                 | Status                            | Commit |
| ------------------------- | --------------------------------------- | --------------------------------- | ------ |
| 33                        | Binary files in `/modify` blobs         | built                             |        |
| 34                        | `keep` and `remove` on `/modify` commit | built                             |        |
| 14                        | Module uninstall route                  | built                             |        |
| 15                        | Default and admin theme route           | built                             |        |
| 16                        | Owner-token rotation route              | built                             |        |
| 9                         | Per-call git token                      | built                             |        |
| 31                        | ETag and `If-Match` on `/settings`      | built                             |        |
| 28                        | Install from a composer lock            | already in the tree; spec run     |        |
| 39                        | Tar archives in `/install-lock`         | built                             |        |
| 40                        | `DELETE /install-lock` idempotence      | built                             |        |
| 5                         | Read-only site database route           | built, route name is a question   |        |
| 38                        | `/recover-token` leaves the token valid | withdrawn                         |        |
| 13                        | Admin password reset                    | built, route name is a question   |        |
| 29                        | `kind` on the module census             | built                             |        |
| 30                        | `GET /pitr/bookmarks`                   | question                          |        |
| 36                        | Warm schedule lever                     | built, format is a question       |        |
| 37                        | Force install on a named conflict       | built (`accept`)                  |        |
| 8                         | Paged restore above 16 MiB              | not started                       |        |
| 2, 3, 4, 6, 7, 10, 11, 22 | batch 8                                 | not started                       |        |
| 17 to 21, 23, 24, 32, 35  | end-to-end check                        | specs run, routes not driven live |        |

## Index, Third Stretch

This table replaces the status column above where the two differ.

| Row                      | Subject                                 | Status                                                    | Commit |
| ------------------------ | --------------------------------------- | --------------------------------------------------------- | ------ |
| 8                        | Paged restore above 16 MiB              | already met by `/restore-parts`; verified by spec         |        |
| 22                       | `PUT /file` registers a file held in R2 | built                                                     |        |
| 11                       | `/deployment` marks a failed read       | built                                                     |        |
| 10                       | Module census as JSON                   | question                                                  |        |
| 2                        | Managed deploy artifact                 | withdrawn by the dashboard                                |        |
| 3                        | Owner assertion                         | question, design decision                                 |        |
| 4                        | `/.well-known/drupflare`                | question                                                  |        |
| 6                        | Usage push                              | question                                                  |        |
| 7                        | Release webhook                         | question                                                  |        |
| 30                       | `GET /pitr/bookmarks`                   | withdrawn by the dashboard                                |        |
| 5, 13, 28, 36, 37, 39    | follow-ups from the second answers      | built (see "Answers From the Dashboard Session", 6 to 11) |        |
| 17 to 21, 23, 24, 32, 35 | live drive on a local `wrangler dev`    | driven; no mismatch in the nine (see "Live Drive")        |        |

Two defects the live drive found are fixed: row 13 answered 500 on a site that had not rendered since
its claim, and `npm-asset` and `bower-asset` packages mounted under `vendor/`.

## New Owner Route Paths, Third Stretch

Add `/file` (PUT only, owner token only). Names are proposals; see the questions.

## Row 22: Register a File Held in R2

Route: `PUT /file?uri=public://path/name.ext` (or `private://`), owner token. Headers: `content-length`
(required), `x-file-sha256` (hex, required), `content-type` (kept as the file's type). The body streams
to this site's own prefix in the bucket for the scheme, R2 checks the digest as it receives the
bytes, and the object records an evicted row with no resident chunks, so `/offloaded` lists it and
reads come from R2. The row is written only after R2 stored the declared size. An existing file at
that URI is replaced. Answers `{ok, uri, size, sha256, store: "r2", replaced}`; errors `{ok: false,
error, code}`: 400 `bad_uri`, `sha256_required`, `length_required`; 422 `digest`, `size`; 429
`r2_budget`; 501 `no_r2_store` (needs `FILE_STORE=r2` and the bucket); 502 `storage_unavailable`;
405 other methods. One R2 write is charged per call. Body ceiling `MAX_FILE_PUT_BYTES` (100 MiB, the
platform's request limit). Audited as `/file` for `PUT`.

Files: `src/do/routes/file.ts`, `registerOffloaded` in `src/db/file-store.ts`, `src/site/guards.ts`,
`src/ops/body-limit.ts`, route tables. Docs: `docs/configuration/operations/index.md`,
`docs/configuration/serving/request-limits.md`. Spec: `tests/integration/offloaded-file-reads.spec.ts`
(describe "PUT /file": stored at the site prefix with no chunks and read back, digest mismatch and
size mismatch leave no row, refusals), `tests/integration/serve/edge.spec.ts` (the ceiling and its
control), the route-table and audit specs.

Not verified: a real R2 bucket. The spec uses an in-memory bucket that checks the digest as R2 does;
local `wrangler dev` answered 501 `no_r2_store` because `FILE_STORE` is unset in the default config.
R2's own message for a digest mismatch is matched by the words checksum, digest or sha-256, which is
from its documentation and not observed. A path exactly `/file` is now an owner route, so a Drupal page
with that alias would answer 401 to an anonymous visitor; the same holds for every other owner route
name.

Status: built. Commit or snapshot: .

## Row 11: Degraded Flag on `/deployment`

`GET /deployment` and the `deployment` block of `GET /health` add `degraded`
(`"kv_read_failed"` or `"kv_read_timeout"`) when the read of the deployment document failed or ran
past 2 seconds. Without the field the read worked. An empty claimed list with `degraded` set is not
evidence of no claimed sites. Files: `src/ops/deployment-site.ts` (`readDeploymentState`),
`src/site/deployment.ts`, `src/site/object-routes.ts`. Docs: `docs/operating/administration.md`,
"Deployment Report". Spec: `tests/integration/deployment-site.spec.ts` ("the deployment report when
the document cannot be read": a failed read, a hung read under fake timers, and the working read as
the control).

Status: built. Commit or snapshot: .

## Rows 3 and 6: Not Built

Row 3 is a trust-boundary change that needs Gregory's yes. Row 6 is withdrawn: billable views are
counted at the dispatch Worker. Row 8's answer is above and row 30 is withdrawn.

## Index, Fourth Stretch

| Row | Subject                        | Status                           | Commit |
| --- | ------------------------------ | -------------------------------- | ------ |
| 2   | Managed deploy archive         | withdrawn by the dashboard       |        |
| 4   | `/.well-known/drupflare`       | built                            |        |
| 7   | Release event to the dashboard | built; needs secret and variable |        |
| 10  | `GET /extensions`              | built                            |        |

New owner route paths for the dashboard's `OWNER_ROUTE_PATHS`: `/extensions` and `/.well-known/drupflare`.

## Row 2: Managed Deploy Archive

Withdrawn by the dashboard. It already consumes `drupflare-managed-bundle-<version>.tar.gz`, the
managed bundle built by `scripts/build/managed-bundle.ts`, so a second release asset was not needed.
The archive producer, its spec and its release step were removed; the managed bundle is unchanged.

## Row 4: Discovery Document

`GET /.well-known/drupflare`, owner token, answered in the front Worker from the same read as
`/settings`; `Cache-Control: no-store`; 405 other methods; 404 on WordPress. Fields, `x-ui`, routes
and limits are in `docs/configuration/operations/discovery.md`. `settings.etag` is the `/settings`
ETag, usable in `If-Match`. `releaseId` is `CF_VERSION_METADATA.id` or `unknown`; `version`,
`capabilities` and `redirects` are null or empty by design; `schemaVersion` is `package.json`
`schema.version`. Hints live in `src/ops/discovery.ts`: `danger` on `CSP_MODE`, nothing else
hand-written. No lever has a plan gate in code, so none is stated. `routes` lists 25 entries whose
method and class the operations page states; routes with unstated methods (`/armfill`, `/invalidate`,
`/bump`, `/migrate`, `/git` and others) are left out, not guessed.

Files: `src/ops/discovery.ts`, `src/site/deployment.ts` (`discoveryRoute`, `settingsView`),
`src/site/surfaces.ts`, `src/site/routes.ts`. Specs: `tests/unit/ops/discovery.spec.ts` (the contract's
rules written out by hand; the dashboard ships no discovery vectors), `tests/integration/owner/gate.spec.ts`
("the discovery document": wrong token, tag equals `/settings` tag, stored override, no secret from
the environment, 405, WordPress 404), the route-table specs.

Mismatch for the dashboard: its `leverDomainSchema` lacks the `paths` and `window` kinds that
`SPOOL_EXCLUDE` and `WARM_WINDOW` report on `GET /settings`, so its settings parser would reject the
body today.

Status: built. Commit or snapshot: .

## Row 7: Release Event

`package.json` `schema: {version: 7, accepts: 7}`. Dashboard defines both as whole numbers;
`version` is the data schema a release leaves a site at and `accepts` the oldest it accepts (its own
build script defaults `accepts` to `version`, which is what is set). A spec pins `version` to
`PACK_VERSION` in `src/ops/reconcile.ts`, which the dashboard's own script reads.

Release workflow: the payload job writes `drupflare-release-manifest-<version>.json` (kind `worker`,
every `SHA256SUMS` file with its release URL and digest) and it rides on the release. A new `announce`
job, after `publish`, on `master` only, runs `scripts/release/event.ts post`: builds the
`release.published` event, confirms the manifest URL serves the same bytes (up to 20 tries, 15 s),
then POSTs with `x-drupflare-signature: sha256=<hex>` (HMAC-SHA256 of the raw body); body over 64 KiB
refused. Repository secret `DASHBOARD_RELEASE_SECRET` and repository variable `DASHBOARD_RELEASE_URL`
(Gregory creates both). Missing either stops the job before any request. Event id is
`release-<tag>`. Specs: `tests/node/release-event.spec.ts` (26: RFC 4231 vector, an openssl-computed
vector for a real event, the 64 KiB boundary, fail-closed through the CLI, dry run) and
`tests/node/workflows.spec.ts`. The workflow was not run. The release workflow has no dry-run mode;
the guard is `master` only plus the script's `--dry-run`.

Status: built. Commit or snapshot: .

## Row 10: Extension List

`GET /extensions`, owner token, answers `[{name, kind, version, enabled}]`; see
`docs/configuration/operations/index.md`. Lists everything Drupal discovers, `enabled` from
`core.extension`, so a delivered module reads `false` until enabled. Spec:
`tests/integration/extension-routes.spec.ts` ("listing the extensions", 4) and
`tests/unit/ops/extensions.spec.ts`; control: without the profile de-duplication the profile is
listed twice and the spec fails. On a fresh site 103 rows. Not tested: WordPress 501.

Status: built. Commit or snapshot: .

## Live Drive

Driven on a local `wrangler dev` (`PLAN:paid`, one site per run, fake values), 2026-11-21. Requests
were the dashboard adapter's own (`engine/src/adapters/write-mark.ts`, `site.ts`, `modules.ts`,
`repair/handles.ts`). Positive checks, 31 of 31 on the final run with diagnostics on: `GET /writemark`
with no mark is 404 `{ok: false, error}`; `POST ?mark=` is 201, a repeat 200, another mark 409 with
`active`; the count answers `{mark, writes, incomplete}` and read 3 after an admin password reset;
`/writechanges` answers `{mark, writes, incomplete, through, cannotCarry}`, `body=1` carries
`x-cfw-through`, `since=1` carries `x-cfw-since` and the line `-- changes after write 1 through write
3`; `/offloaded` lists `{ok, files, next, total}` and answers 404 `not_found` for a missing file;
`/recycle` answers `recycled` and `/ledger-gc` answers `rowsDeleted`; `/strata-config` and
`/strata-store` answer 409 `strata_not_enabled`, which is in the dashboard's refusal vocabulary, and
never echoed the secret; `/restore?mark=` answered 200 and echoed `mark`, an invalid mark answered 400,
and `/health` read `import.state: applied` afterwards. The follow-up routes also answered as built:
`/settings` ETag, `If-Match` 412 and the `WARM_WINDOW` 400, `/db-console` (select, `statement_failed`,
`not_read_only`), `/theme-default`, `/uninstall?dry=1`, `/deployment`.

Negative controls, diagnostics off: 13 owner routes (`/writemark`, `/writechanges`, `/offloaded`,
`/recycle`, `/ledger-gc`, `/strata-config`, `/strata-store`, `/file`, `/db-console`, `/admin-password`,
`/uninstall`, `/theme-default`, `/rotate-token`) with GET, POST and PUT, each with no token and with a
wrong token: all 78 answered 401. With `PW_DIAGNOSTICS=1` an unauthenticated `POST /recycle` answered
200 and `GET /writemark` answered 404 from the route, so that setting opens owner routes the route
table calls owner-only. A deployed site runs with it off.

Mismatches found and fixed: `POST /admin-password` answered 500 `phpClass: Error`
("Undefined constant Drupal\Core\Entity\SAVED_UPDATED") on a site whose interpreter had not loaded
`core/includes/common.inc`, which the workers lane always had loaded. The script now loads it when
the constant is absent; the spec drops the interpreter first and fails without the include.
`npm-asset` and `bower-asset` packages, which is what asset-packagist and Thunder's lock name, were
not in `mountFor`, so they would have mounted under `vendor/` and not `libraries/`; both are added.
Not mismatches: the dashboard sends `siteId` in the `db-console` body and the route ignores it;
`since` equal to `through` with no writes answers 400 `since must not be past through`.

Thunder: a lock generated 2026-11-21 with composer 2.11.2 from `thunder/thunder-project`
(161 packages, core 11.4.13, `thunder/thunder-distribution` 8.4.7 as `drupal-profile`, three
`npm-asset` packages, 369,293 bytes of JSON) went through `POST /install-lock` in 5 calls (5.1, 3.8,
9.8, 1.9, 0.7 s, n=1 each, local): 89 installed, 72 skipped (plugins, the metapackage, packages the
pack ships), 0 failed, `cache: compiled container dropped`. The profile landed at
`profiles/contrib/thunder-distribution` with 460 files, and the three assets under
`libraries/dropzone`, `libraries/exif-js` and `libraries/yaireo--tagify`; no row under
`vendor/npm-asset`. No image or font was in those three libraries, so the binary path was not
exercised on Thunder's own bytes; the spec covers it. The profile directory is named for the
composer package (`thunder-distribution`), as Thunder's own `installer-paths` do; the machine name
`thunder` comes from the info file inside. Not run: enabling the profile or installing Thunder.

## New Owner Route Paths, Second Stretch

Add `/db-console` and `/admin-password` to `OWNER_ROUTE_PATHS`. Both take the owner token only, and
`POST` only. Both names are proposals; see the questions.

## Row 31: ETag and If-Match on Settings

`GET /settings` answers an `ETag` header: a strong tag, a quoted 32-character hex digest of the plan
and every lever with its value and source as the body reports them. The tag is taken from a fresh
read, so a change made behind the route (the Drupal settings form writes the same KV document)
changes it. `PUT` or `POST` with `If-Match` writes only when the header names the current tag
(`*`, a weak prefix and a comma list are accepted). A stale tag answers 412
`{ok: false, error, code: "stale_settings", etag}` with the current tag, and nothing is written,
including the plan. A write with no `If-Match` is accepted as before. A written reply carries the new
tag in its `ETag` header.

Files: `src/site/deployment.ts`. Docs: `docs/configuration/operations/overrides.md`. Spec:
`tests/integration/owner/gate.spec.ts` (23 passed): two writers on one tag, the second gets 412 and
the stored value is the first writer's; the answered tag matches the next read; `*`, weak and no
header; a document written straight to KV changes the tag. Control not run against the old route;
without the check the second writer would read 200.

One cost: the route now drops the isolate's plan and settings memos on every call (it reads KV each
time, so the tag describes what is stored). It is an owner route and rare.

Status: built. Commit or snapshot: .

## Row 28: Install From a Composer Lock

Already in the tree before this list: `POST /install-lock` takes a `composer.lock` body, optional
`profile`, `dev` and `cursor`, installs a window of 40 packages per call and answers
`{session, done, cursor, total, installed, skipped, failed, patches, cache}`. See
`docs/architecture/modules.md`, "Installing a Lock". Spec: `tests/integration/install-lock.spec.ts`
(16 passed with the rows below). Not measured: the size of the code tree a template lock produces,
and a full template lock against a real registry.

Status: nothing to build; spec run. Commit or snapshot: .

## Row 39: Tar Archives in Install-Lock

`dist.type: tar` is read as an npm registry serves it (gzipped, one leading folder stripped), through
the unpacker `/install` already had for npm. Packages of type `npm-asset-library` and
`bower-asset-library` mount at `libraries/<name>`. The digest rule is unchanged: a `shasum` must match
or the package fails. Only the file types a mounted tree keeps are stored (`.js`, `.css`, `.json`,
`.php`, templates and the rest of the list), so a library's images and fonts are not stored by this
route. Checked against the live npm registry tarball for `dropzone` 5.9.3: one leading `package/`
folder, 20 entries. Not checked: asset-packagist's own `dist.url` shape (its metadata paths answered
404 to the probes tried), so that `npm-asset/*` entries point at the npm registry is inferred.

Files: `src/do/install-lock.ts`, `src/ops/composer/package-install.ts` (`mountFor`). Spec:
`tests/integration/install-lock.spec.ts` ("installs a package that ships a tar into libraries", and
a digest mismatch on a tar).

Status: built. Commit or snapshot: .

## Row 40: Install-Lock Rollback Idempotence

`DELETE /install-lock?session=` answers 404 `{ok: false, error, session, rolledBack: true}` for a
session already rolled back, the same status as one the site never held. A rollback that succeeds
adds `leftInPlace`: `[{name, version, files}]` for each package the session reused from an earlier
session and so did not touch; `removed` still counts only what this session installed.

Files: `src/do/install-lock.ts`. Docs: `docs/architecture/modules.md`. Spec: the rollback case and
"reports the reused packages a rollback leaves in place" in `tests/integration/install-lock.spec.ts`.

Status: built. Commit or snapshot: .

## Row 5: Read-Only Database Console

Route: `POST /db-console`, owner token, body `{v: 1, sql, params, limit, timeoutMs}` per the
`site-db-console` contract. Answers `{columns, rows, truncated, elapsedMs}`. Refusals are
`{code, message}`: 422 `not_read_only`, 413 `too_large`, 504 `timeout`, 400 or 503 `unavailable`.
One SELECT, WITH or VALUES statement; a write or schema keyword outside a comment or literal refuses
it; anything that still wrote a row is rolled back inside a transaction and refused. A blob is
`x'<hex>'`, an integer past 2^53 a string. Audited as `/db-console`, never with the statement.

What is not enforced: Durable Object SQL cannot be interrupted and its clock does not advance during
a synchronous call, so `timeoutMs` is compared with elapsed time after the statement finishes and
cannot stop a slow scan; `limit` bounds the rows copied, not the rows read. A heavy query costs rows
read on the daily meter. There is no read-only connection mode on this platform, so the guard is the
statement check plus the rollback.

Files: `src/ops/db-console.ts`, `src/do/routes/lifecycle.ts` (`dbconsole`), route tables. Docs:
`docs/configuration/operations/index.md`. Spec: `tests/integration/db-console.spec.ts` (24 passed),
including a statement stood in for one the check misses, which is rolled back with the row intact.

Status: built; the route name is a question. Commit or snapshot: .

## Row 13: Admin Password Reset

Route: `POST /admin-password`, owner token, no body. Generates 32 characters of base64url, sets it on
user 1 through the entity API, answers `{ok, uid, name, blocked, password, applied: true}` with
`cache-control: no-store`. 404 `admin_not_found`, 405, 409 (transaction open, replica), 500
`admin_password_failed`, 501 `drupal_only` on WordPress. Audited by route name only. The password
is never accepted from the caller. It does not unblock the account.

Files: `src/site/php/admin/password.php`, `src/drupal/php/extension.ts`, `src/do/routes/lifecycle.ts`
(`adminpassword`). Docs: `docs/configuration/operations/index.md`. Spec:
`tests/integration/extension-routes.spec.ts` "resetting the admin password": 405 leaves the stored
hash unchanged, the stored hash changes on each reset and the two passwords differ. Not verified: that
the new password logs in. In the workers lane `password` service `check()` accepted a wrong password
(a stand-in), so a login proof needs the browser lane.

Status: built; the route name is a question. Commit or snapshot: .

## Row 29: Kind on the Module Census

`moduleTable()` rows carry `kind: 'module' | 'theme'`, from `kind: theme` in `config/modules.yml`
(generated into `GENERATED_THEMES`). Two entries are themes: `drupal/gin` and `drupal/uswds_base`;
`gin_toolbar` stays a module. The dashboard sync reads `moduleTable()` directly, so it can read
`row.kind` where it now writes `unknown`. Files: `config/modules.yml`, `scripts/gen/config.ts`,
`src/ops/generated/modules.ts` (generated), `src/ops/module/table.ts`. Spec:
`tests/node/module/table.spec.ts` (17 passed). Docs: `docs/architecture/modules.md`.

Status: built. Commit or snapshot: .

## Row 36: Warm Window Lever

Lever `WARM_WINDOW`, KV-overridable and settable through `/settings`. Value
`<days> HH:MM-HH:MM [zone]`, for example `mon-fri 06:00-22:00 America/New_York`. Inside the window
the site is kept warm; outside it takes the idle re-arm of a site that is not warming. `SITE_WARM=0`
still wins. A value that does not parse is refused on write (`invalid` in the reply) and ignored on
read. Days are `daily`, one day or a range that may wrap; the window does not cross midnight; the zone
is an IANA name, UTC when absent, and follows daylight saving.

Files: `src/ops/warm/window.ts`, `src/ops/cron.ts` (`warmForced`), `src/ops/plan.ts`,
`src/do/warming.ts`, `src/do/alarm/rearm.ts`. Docs: `docs/configuration/runtime.md`,
`docs/configuration/index.md`. Specs: `tests/integration/lever-behaviour.spec.ts` (window edges in a
zone, weekends, `SITE_WARM=0`, an unparseable value), `tests/integration/kv-levers.spec.ts` (every
lever carries a probe). Not measured: the rows and requests a window saves; `bun scripts/measure/free-envelope.ts`
was not run.

Status: built; the format is a question. Commit or snapshot: .

## Row 37: Install With a Named Conflict

`POST /install?module=X&accept=a/b,c/d`: the install proceeds past the shipped-lock check only when
every conflict names one of the listed packages in `requires`. A conflict outside the list answers 409
with the full list, as before; a package the registry cannot find still answers 404. `force=1` is
unchanged and still waives everything, so the dashboard can send `accept=drupal/key` after it showed
the owner that one conflict. Files: `src/do/routes/packages.ts`. Docs: `docs/architecture/modules.md`.
Spec: `tests/integration/install-lock.spec.ts`, "POST /install with a named conflict" (three cases:
refused with none named, passes the gate when named, still refused with a second unnamed conflict).

Status: built. Commit or snapshot: .

## Row 30: Recovery Bookmarks List

Not built. The platform has no stored list: `getBookmarkForTime(at)` turns any one time in the last
30 days into a bookmark, so a bookmark is a function of time and not a row. A list would be samples
the worker invents. See the questions.

## Row 33: Binary Files in Modify Blobs

Route: `POST /modify?action=blobs&package=X`, owner token, unchanged. Each blob in `blobs` takes an
optional `encoding`.

```json
{ "blobs": [{ "hash": "<sha256 hex of the bytes>", "source": "<base64>", "encoding": "base64" }] }
```

`encoding` is `utf8` (the default, `source` is the text) or `base64` (`source` is the file's bytes).
The hash is the sha256 of the decoded bytes in both cases, so a text file sent either way has one
hash and one stored copy. Answers: 200 with `{ ok, stored, skipped, bytes, rejected }`, or 422 with
`ok: false` when any blob is in `rejected` (bytes do not match the hash, base64 does not decode, an
encoding other than the two, or a hash that is not a lowercase sha256). A claimed site and an
unclaimed diagnostics site follow the existing owner rule, 401 otherwise.

How it is stored: a file that is UTF-8 text with no NUL stays as the text. Any other file is stored
as `\u0001cfw-base64\u0001` followed by its base64, in the same TEXT columns. The mount decodes it
when PHP opens the file, `stat` reports the decoded size before the file opens, the integrity record
covers the decoded bytes, and `plan` and `commit` compare stored strings as before. No schema
change, so no `ALTER`, and the Drupal pack is untouched.

Also built, because a delivered image or font is only useful if a browser can fetch it: the front
worker now serves `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `ico`, `woff`, `woff2`, `ttf` and
`otf` from `/modules/`, `/themes/`, `/profiles/` and `/libraries/` with the matching type, the same
way it already served `css`, `js`, `mjs` and `svg`. A path the site does not hold falls through to
Drupal. Cost: a request for a missing image under those roots now makes one object request before
it falls through, as a missing stylesheet already did.

Limits: the 2,199,995-byte row cap applies to the stored form, which is 4/3 of a binary file.

Files: `src/ops/module/bytes.ts` (new), `src/ops/module/rev.ts`, `src/ops/module/integrity.ts`,
`src/do/packages.ts`, `src/do/routes/packages.ts`, `src/site/files.ts`,
`scripts/qa/cms-boundary.ts`, `docs/architecture/modules.md`, `docs/configuration/migrated-settings.md`.
`src/ops/module/rev.ts` held a raw NUL byte in `hashManifest` that made the editor refuse the file;
it is now the escape `\0`, and the manifest hash for a fixed input is byte for byte the same
(checked before and after).

Specs: `tests/node/module/bytes.spec.ts` (new, 11 cases including the stored length against real
SQLite), `tests/node/module/rev.spec.ts` (blob encodings), `tests/integration/modify-upload.spec.ts`
(exact bytes to PHP and the front-worker route on an enforcing site, forged base64 refused),
`tests/integration/image/delivery.spec.ts` (types served). Control: with the mount reading
`TextEncoder` instead of `sourceBytes`, the delivery case fails (PHP read an empty file).

Status: built. Commit or snapshot: .

## Row 34: Keep and Remove on Commit

Route: `POST /modify?action=commit&package=X`, owner token. The body takes two more fields.

```json
{ "files": [{ "path": "...", "hash": "..." }], "keep": true, "remove": ["path/to/drop"] }
```

Without `keep` a commit is the whole package, as before. With `keep: true`, the named files replace
their paths in the package's active revision and every other file stays. `remove` is a list of
paths to delete from the result and needs `keep: true`. Errors, all 400: `keep` not a boolean or
`remove` not a list of non-empty strings; `remove` without `keep`; a path both named and removed;
a result with no files (the same refusal as an empty commit). `files` may be empty with `keep`.
A removed path the package does not hold is ignored. With no active revision `keep` keeps nothing.

Reply adds `kept` (files carried over) and `removed` (paths dropped) when `keep` is set.
`POST ?action=plan` takes `keep` and `remove` and answers `kept` as well, with `counts.removed`
counting only the `remove` paths. The revision hash is the hash of the final manifest, so a
keep-commit that produces an existing file set reuses that revision.

Specs: `tests/node/module/rev.spec.ts` (`commitManifest`, `planDeclared` with keep),
`tests/integration/modify-upload.spec.ts` (keep, replace, remove, remove without keep, empty result,
whole-package commit unchanged).

Status: built. Commit or snapshot: .

Follow-up: `base`, an optional field on `commit`, is the revision hash the caller read. If it is not
the active revision, nothing is written and the answer is 409
`{ok: false, error: "stale_base", code: "stale_base", base, active}` where `active` is the active
revision hash (null when the package has none), so the caller can fetch the manifest and show what
changed. A `base` that is not a hash is 400. `remove` still needs `keep: true`. Spec:
`tests/integration/modify-upload.spec.ts`, describe "a commit built on a base revision": the control
is two commits on one base, where the second gets 409 and leaves the stored files and the revision
list as they were; a retry on the new active hash lands. Docs: `docs/architecture/modules.md`.

## Row 14: Module Uninstall

Route: `POST /uninstall?module=NAME`, owner token only (a `GET` is 405). `NAME` must be a machine
name (`[a-z][a-z0-9_]*`), else 400. `?dry=1` reads and changes nothing.

Answers:

| status | body                                                                           | when                                                               |
| ------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 200    | `{ok, module, uninstalled: true, dependents: []}`                              | removed                                                            |
| 200    | `{ok, module, dryRun: true, enabledModules, dependents, reasons, wouldDelete}` | `dry=1`, whether or not a real call would be allowed               |
| 404    | `{error: "module_not_enabled", module}`                                        | not in `core.extension`                                            |
| 409    | `{error: "module_has_dependents", module, dependents}`                         | an enabled module requires it                                      |
| 409    | `{error: "uninstall_blocked", module, reasons}`                                | Drupal's uninstall validators refuse (core-required, owns content) |
| 409    | `{error: "a transaction is open"}`                                             | same rule as the repair ladder                                     |
| 500    | `{error: "uninstall_failed", phpClass, phpMessage}`                            | the installer threw                                                |

`wouldDelete` is the paths `cfw_module_file` holds for the package `drupal/NAME` or `NAME`, at most 500. The route never deletes files; the dashboard removes them afterwards, which matches its note
that files go only after the uninstall works. Audited as `/uninstall` except for `dry=1`. A success
drops the interpreter and heap images and advances the page generation. The uninstall script loads
the legacy includes and every module before it runs, as an install does: without that, uninstalling
`update` threw an undefined `update_storage_clear()`.

Files: `src/site/php/uninstall/module.php`, `src/drupal/php/extension.ts`,
`src/do/routes/lifecycle.ts`, plus the route tables (`src/site/routes.ts`,
`src/do/routes/index.ts`, `src/ops/owner/audit.ts`, `scripts/qa/cms-boundary.ts`).
Docs: `docs/configuration/operations/index.md`, `owner-access.md`.
Spec: `tests/integration/extension-routes.spec.ts` against a real kernel (405, 400, 404 with and
without `dry`, dependents named and the module still enabled after the refusal, dependent removed
then base removed, `system` refused and still enabled), and the route-table and audit specs.

Status: built. Commit or snapshot: .

## Row 15: Default and Admin Theme

Route: `/theme-default`, owner token only. `GET` and `POST ?dry=1` answer
`{default, admin, installed}` and change nothing. `POST` takes
`{"project": "<theme>", "target": "default" | "admin"}` and answers
`{default, admin, installed, previous: {default, admin}, applied: true}`. 404 `theme_not_installed`,
400 for a bad body, 409 while a transaction is open, 500 `theme_write_failed`. Naming the theme a key
already holds writes nothing and leaves the interpreter alone. A write drops the interpreter and heap
images and advances the page generation so stored pages do not keep the old theme. Audited for
`POST`.

Follow-up: an empty `project` with target `admin` clears the admin theme to "same as default"
(answers `{default, admin: "", applied: true}`). `default` takes no empty value (400). Pinned in
`tests/integration/extension-routes.spec.ts`; documented in `docs/configuration/operations/index.md`.

Files: `src/site/php/theme/default.php`, `src/drupal/php/extension.ts`,
`src/do/routes/lifecycle.ts`, route tables as above. Spec: `tests/integration/extension-routes.spec.ts`
(read, dry write leaves the stored row alone, admin then default set and read back from
`system.theme`, repeat is applied with no change, 404, 400, 405).

Status: built. Commit or snapshot: .

## Row 16: Owner-Token Rotation

Route: `POST /rotate-token`, current owner token in `Authorization: Bearer`. Answers
`{ok: true, ownerToken, rotated: true}` with `cache-control: no-store`; the old token is refused from
then on. 401 without a valid token, 405 for a `GET`, 409 on a replica. The audit entry is written
inside the route, before the old token stops matching, because the generic recorder re-checks the
presented token after the route answers and would drop the entry. Actor is the first 8 characters of
the old token's hash.

Files: `src/do/routes/auth.ts` (`rotatetoken`), route tables as above. Docs: `owner-access.md`
(new section "Rotating the Token"). Spec: `tests/integration/owner/recovery.spec.ts` (rotation,
old token dead, new token live, no plaintext in SQL-reachable rows, audit entry; 401, 405 and 409
leave the stored hash unchanged and write no entry).

Status: built. Commit or snapshot: .

## Row 38: Recover-Token and the Stored Token

Answer, not a code change: `/recover-token` has rotated the owner token since the token became a
stored hash. The site keeps only the hash, so it cannot hand back the old token; it issues a new one
and the old one stops working. The reply says so (`rotated: true`) and
`tests/integration/owner/recovery.spec.ts` pins it. The one wrong thing was the doc line
"The token is not rotated", in `docs/configuration/operations/owner-access.md`; it is corrected. The
option "stop rotating" cannot be built without storing the token in the clear. What the dashboard
needs: after a recovery, reseal the `ownerToken` in the reply. See the questions.

Withdrawn by the dashboard session. The reply fields the dashboard relies on are pinned:
`tests/integration/owner/recovery.spec.ts` asserts `rotated: true`, a string `ownerToken` and
`cache-control: no-store` on the object route and through the front worker.

Status: withdrawn. Commit or snapshot: .

## Row 9: Per-Call Git Token

Header: `x-drupflare-git-token`, on `/git` calls with the owner token. It serves that one call. The
route sets it on the object for the duration of the call and clears it in a `finally`; nothing
writes it, and error text stored in `git_lasterror_<id>` or returned in a 400 has the token
replaced by `[token]`.

- `action=add`: a header token implies a tokenless remote, as does `tokenless=1`. A tokenless add
  never writes `git_token_pending` or `git_token_<id>` (the pending slot is cleared), records
  `tokenless: true` on the remote, sets its poll interval to 0, and answers `tokenless: true`. A
  `token` in the query on a tokenless add answers 400 naming the header. A tokenless add of an API
  provider with no header answers 400 `an access token is required`. A plain remote needs no token.
- `action=pull`: on a tokenless API remote with no header, 400 `a token is required`, before any
  provider call. With a header the pull authenticates with it. The commit-status write-back is
  skipped for a tokenless remote.
- The alarm poll skips a tokenless remote whatever its interval says.
- A token in the query on a non-tokenless add still works and is stored, as before.

The header is not an audited parameter and the audit label copies only listed query keys, so it
never reaches the audit log.

Files: `src/do/git/handler.ts`, `src/do/git/remotes.ts`, `src/do/host.ts`, `src/do/routes/packages.ts`,
`src/ops/git/provider.ts` (`tokenless` on `Remote`), `src/site-do.ts` (`gitCallToken`). Spec:
`tests/integration/git-remotes.spec.ts`, describe "a provider token sent with one call" (5 cases:
nothing stored and the header reached the provider, query refusals, pull refusal and pull with no
write-back, no poll, scrubbed error and cleared token through the route). Docs: `docs/operating/git-remotes.md`.

Status: built. Commit or snapshot: .

## Row 8: Paged Restore Above 16 MiB

Already met, nothing to build. `POST /restore-parts` (owner token) takes a dump as parts of at most
1 MiB (`RESTORE_PART_MAX_BYTES`, fixed), so the 16 MiB `MAX_RESTORE_BYTES` ceiling that applies to
`/restore` does not apply to it: the edge ceiling for `/restore-parts` is the part size, and the
whole dump is bounded by `MAX_RESTORE_PAGED_BYTES` (128 MiB by default, up to 8,192 parts). No call
holds more than one part: a part is verified and stored whole in one row, and a commit turns up to
16 MiB of parts into replay chunks per call, deleting each part as it goes. Calls: `begin`
(`{bytes, parts, sha256, label}`), `put` (`PUT`, one part, `x-part-sha256`), `status`, `commit`
(repeat until `done: true`; takes `mark` like row 20) and `abort`. See
`docs/operating/recovery.md`, "Restore in Parts". Spec: `tests/node/dump/restore-parts.spec.ts` (36
passed, run again 2026-11-21), including a dump refused as one body and restored in parts, and the
dump ceiling lowered through `MAX_RESTORE_PAGED_BYTES`.

What is not met: a dump above 128 MiB needs `MAX_RESTORE_PAGED_BYTES` raised. That figure is a
chosen default and not measured against the isolate. The parts live in the object's SQLite while the
upload is open, so a 128 MiB dump holds 128 MiB of rows until the commit finishes. See the questions.

Status: built before this list (in the tree); verified by spec. Commit or snapshot: .

## Answers From the Dashboard Session

1. Row 34: `keep` is the switch and `remove` needs it. Unchanged.
2. Row 34 `base`: build it. Built (see row 34 follow-up).
3. Rows 14 and 15 route names accepted as built. `wouldDelete` as built is accepted for managed
   sites.
4. Row 15: accept an empty `project` for `admin`. Built (see row 15 follow-up).
5. Row 38: withdrawn.

Second set of answers (all built; the section of each row has the detail):

6. Row 5: SQL that SQLite rejects answers 400 `statement_failed` (contract 1.1); `unavailable` stays
   for a malformed body or an open transaction. A cut result answers `truncated: true`. `timeoutMs`
   is advisory: it is read and bounded, never enforced, a slow statement still answers its rows, and
   the old 504 after the fact is gone. The dashboard bounds what it sends (a `LIMIT`, at most 1,000
   rows) and shows `elapsedMs`. Spec: `tests/integration/db-console.spec.ts`.
7. Row 13: refuses while a transaction is open and answers 409 on a replica; the password is
   generated on the site, returned once with `cache-control: no-store`; the audit entry is written by
   the object's recorder after the answer (route `/admin-password`) and never carries the password.
   Spec: `tests/integration/extension-routes.spec.ts`, "answers 409 and changes nothing while a
   transaction is open or on a replica, and audits a reset".
8. Row 36: a `WARM_WINDOW` that does not parse answers 400 `{code: "invalid_lever", name:
"WARM_WINDOW", error}` on the settings write and the whole body is refused. Format
   `<days> HH:MM-HH:MM [zone]`, UTC when the zone is unset. Spec: `tests/integration/owner/gate.spec.ts`.
9. Row 37: a package in `accept` that is not among the current conflicts answers 400
   `{code: "accept_not_in_conflicts", unlisted, conflicts}`. This applies when `force` is not set and
   the registry knows the package; `accept` with no conflict at all is also a 400. Spec:
   `tests/integration/install-lock.spec.ts`.
10. Row 28: a `drupal-profile` mounts at `profiles/contrib/<name>` (the project template path) and
    never under `vendor/`; the `drupal-custom-*` types now mount under `custom/` as the template
    does (they went to `contrib/` before). Spec: `tests/unit/ops/composer/package-install.spec.ts`. The Thunder
    lock drive is under "Live Drive".
11. Row 39: the tar reader keeps `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `ico`, `svg`, `woff`,
    `woff2`, `ttf` and `otf`; a file that is not text is stored with the base64 encoding of row 33.
    The 2,199,995-byte cap applies to the stored form. An oversized file is listed in the answer's
    `skippedFiles` as `{package, path, why}` and the lock continues. Spec:
    `tests/integration/install-lock.spec.ts`, "keeps a tar library images and fonts as stored bytes
    and lists an oversized one by path". New table `cfw_lock_skipped`, added to the state inventory.
12. Row 30: withdrawn by the dashboard. Nothing to build.

## Questions for the Dashboard Session

1. Row 5: the list states no path. Built as `POST /db-console`. Accept the name, or give another?
   Also: the contract has four refusal codes and no code for a statement SQLite rejects (a typo, a
   missing table). Built as 400 `unavailable` with SQLite's message. Recommend adding a
   `statement_failed` code to the contract, or accept `unavailable` for it.
2. Row 5: `timeoutMs` cannot stop a statement, only report one that ran long (see row 5). Is a
   post-hoc check enough for the console, or should the dashboard also bound statements by the shape
   it allows (for example require a `LIMIT`)? Recommend the dashboard adds a `LIMIT` to what it sends.
3. Row 13: the list states no path. Built as `POST /admin-password`, generating the password on the
   site. Accept the name? Recommend yes; a caller-chosen password would put a secret in the request.
4. Row 30: recommend withdrawing. A recovery bookmark is a function of time (any moment in the last
   30 days has one), so there is no list to return. The dashboard's time picker already matches the
   platform. If a list of selectable moments is still wanted, say how many and how far apart, and the
   worker can answer a sampled list from `?from=&to=&step=` with a cap; each sample is one platform
   call whose cost has not been measured.
5. Row 36: the list gives the window (weekdays 06:00 to 22:00) but no zone or format. Built as one
   lever, `WARM_WINDOW`, `<days> HH:MM-HH:MM [zone]` with an IANA zone, UTC by default. The
   dashboard would write the owner's zone. Accept the format? The site has no zone of its own to
   default to, so an unset zone is UTC.
6. Row 37: built as `accept=<package list>` beside the existing `force=1`, so the caller names what
   it showed. The alternative in the row, carrying `drupal/key` in the pack at a version Strata
   accepts, is not built; it moves the pack and needs a decision about the shipped lock. Recommend
   `accept` now.
7. Row 28: the route already exists (`POST /install-lock`). The row says the profile is optional; the
   route records `profile` with the session and does not install it as a profile. Is that what the
   dashboard expects?
8. Row 39: the tar reader keeps only the file types a mounted tree uses, so a library's images and
   fonts are dropped. Does Thunder need any of them served, or are scripts and styles enough?

9. Row 8: met by `/restore-parts` up to 128 MiB per dump. Is 128 MiB enough for Adopt, or what is the
   largest dump you expect? The ceiling is `MAX_RESTORE_PAGED_BYTES` and a raise costs up to three
   times the dump in object storage while it is open.
10. Row 3: verification is a pure function over the contract, but wiring it changes who may call an
    owner route. The object checks the owner token itself and records the actor from it, and it holds
    only a hash, so an assertion cannot become a token. Recommend that the front worker verifies the
    assertion (`x-drupflare-assertion`, with `x-drupflare-op` for the operation id, and the route name
    as `action`) and forwards an internal marker the object trusts only from the front worker, with the
    audit actor `assertion:<kid prefix>`. That is a trust-boundary change for Fredric and Gregory to
    approve before it is built. Also: the seen-id set lives in one isolate, so a replay to another
    isolate within the 5 minute lifetime is not caught; a Durable Object row per id would close it.
11. Row 4: the document needs `releaseId`, `schemaVersion`, `healthVocabulary`, a JSON Schema per
    lever with `x-ui` annotations and a `routes` list with each route's class. None is stated, and
    `capabilities.ts` no longer exists. Recommend generating it from `KV_OVERRIDABLE`, `LEVER_DOMAINS`
    and the route tables, with `releaseId` from `CF_VERSION_METADATA` and `schemaVersion` null until
    row 7 says where it comes from. Confirm that, and whether `x-ui` is hand-written in
    `config/modules.yml` beside each lever.
12. Row 6: the list gives no URL, credential or counting rule. A site counts views today only through
    `/serve-stats` windows. Recommend the dashboard keeps polling and reconciling, since an hourly
    push from a Durable Object needs a dashboard URL, a signing key and a counter that survives
    eviction, and a push that misses an hour is a billing gap. If you want it, give the endpoint, how
    the site authenticates, and what counts as a view.
13. Row 7: the release webhook is CI tooling and needs `schemaVersion` and `acceptsSchema`, which
    nothing in the worker declares. Recommend a `schema` field in `package.json` the release
    workflow reads, and a workflow step after `gh release create` that posts the event signed with
    a key you provide. Say where the dashboard receives it.
14. Row 10: the list names "the module browser data" and "the existing module listing" without a
    route. `moduleTable()` is the support census and carries no version or enabled state. Recommend
    `GET /extensions`, owner token, answering `[{name, kind, version, enabled}]` from `core.extension`
    and each extension's info file. `advisory` has no source on a site that cannot reach drupal.org
    during a request, so recommend the dashboard fills it from the advisory feed it already reads.

## Withdraw or Change

Row 38 as written was withdrawn by the dashboard session. Row 30: recommend withdrawing (question 4).

## Not Done

Rows 3, 4, 6, 7 and 10 are not built; each has a question above. Row 22 was never run against a
real R2 bucket. Enabling the Thunder profile after its lock installed was not run. The free envelope
was not rescored for `WARM_WINDOW`, the image and font serving or the tar assets. The nine built rows
(17 to 21, 23, 24, 32, 35) had their specs run and were then driven on a local `wrangler dev` (see
"Live Drive").
