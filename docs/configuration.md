# Configuration

Every setting is a `vars` entry or a binding in `wrangler.jsonc`, and every one has a working
default. A deploy that sets nothing beyond what the canonical config already carries serves a site.

Values arrive from wrangler as **strings**, so a boolean is `"1"` or `"0"` and a number is a decimal
string. An unparseable value falls back to the default rather than throwing: these are read on the
serving path, and a typo must not take a site down.

Three layers decide what a value is, most specific first:

1. **A request parameter**, where the route exposes one (`?prefill=`, `?all=1`).
2. **The `CONFIG_KV` namespace**, for the plan and the eleven levers on
   [Runtime Overrides](#runtime-overrides). No redeploy needed.
3. **The `vars` entry**, then the per-plan default in `src/ops/plan-profile.ts`, then the constant.

## Bindings

`wrangler.jsonc` is the canonical config and declares five of the eight. `PAGE_KV`, `FILES` and
`SEND_EMAIL` are read where they are bound and absent otherwise.

| binding               | kind             | canonical config | what breaks without it                                                               |
| --------------------- | ---------------- | ---------------- | ------------------------------------------------------------------------------------ |
| `SITE`                | Durable Object   | declared         | the Worker has nothing to proxy to; every request fails                              |
| `ASSETS`              | Workers Assets   | declared         | no pack, no driver, no `/core/**`; an object cannot boot                             |
| `CONFIG_KV`           | KV               | declared         | the plan override and the runtime levers are absent; the deployed vars stay in force |
| `FLEET_DB`            | D1               | declared         | the cross-site inventory is absent; a single site does not need one                  |
| `CF_VERSION_METADATA` | version metadata | declared         | the fleet row records `workerVersion: "unknown"`                                     |
| `PAGE_KV`             | KV               | not declared     | the cross-colo page tier is absent rather than broken                                |
| `FILES`               | R2               | not declared     | the page and file mirror drains nothing; the off-Worker serving path is unavailable  |
| `SEND_EMAIL`          | `send_email`     | not declared     | the credential-free mail transport is absent; `api` or `smtp` still work             |

An unbound optional binding always wins over the var that would enable the feature. Asking for a tier
that is not bound is a configuration error, and answering it with a crash on the serving path would
be the wrong trade.

## Site Identity and Origin

| var                  | default              | what it does                                                   |
| -------------------- | -------------------- | -------------------------------------------------------------- |
| `SITE_ID`            | derived, then `site` | which site a request resolves to, when KV maps no host         |
| `SITE_ORIGIN`        | pinned on first use  | the `scheme://host[:port]` Drupal builds absolute URLs against |
| `SITE_LOCATION_HINT` | unset                | which region the site's Durable Object is created in           |

### `SITE_ID`

One object per site, and the object's **name** is the site identity, so a wrong answer here serves a
request from a different site's database. Four layers, in `src/ops/site-id.ts`: a `site:host:<host>`
KV mapping, then `SITE_ID`, then the hostname itself, then the literal `site`.

The two optional layers sit above the derived one because derivation answers for every real host, so
anything below it would be unreachable on exactly the hosts it exists to configure. `localhost`,
`127.0.0.1`, `0.0.0.0` and `::1` name no site and fall past derivation, which is what lets a local
dev server and a deployed site run the same code path.

**Set it when one deployment serves one site under a name you choose.** Leave it unset when the
hostname is the identity. Changing it after a site has content points the Worker at a different,
empty object; the old one still holds the data.

### `SITE_LOCATION_HINT`

One of `wnam enam sam weur eeur apac oc afr me`, or unset.

Unset by default. Placement follows the first request a site answers, which for a deploy-button site
is wherever the deployer was. Pinning a region on an owner's behalf trades latency for one audience
against latency for every other, so the choice belongs to whoever knows the audience.

It applies when the object is **created**. Cloudflare ignores it for an object that already exists,
so setting it on a running site moves nothing.

An unrecognised value is ignored rather than passed through. The value reaches `SITE.get()` on the
serving path, and a hint the platform rejects would take the site down for the sake of a preference.

KV-overridable through the `settings` key, so a region can be chosen without a redeploy.

### `SITE_ORIGIN`

Every absolute URL Drupal emits is built from the request's scheme and host: the canonical tag, a
form action, a `Location:`, the link in a password-reset mail. The render fragments hardcoded
`localhost`, so a deployed site told every visitor and every crawler that it lived on
`http://localhost`, and a reset link mailed to a user pointed at their own machine.

The inbound `Host` is not automatically safe to use — an attacker who can set it can move a
password-reset link onto a host they control. So the origin is a property of the **site**, resolved
in `src/ops/site-origin.ts` in this order:

1. `SITE_ORIGIN`, which wins outright.
2. **The pin**, held in `cfw_meta` under `site_origin`. Trust on first use: the first non-local
   origin a site serves is stored, and every later request is measured against it rather than
   believed. A forged `Host` after the pin changes nothing.
3. The observed origin, when there is no pin — which is the request that sets the pin.
4. `http://localhost`, only when nothing above produced a usable value.

A bare hostname is accepted and assumed `https`. A full URL is trimmed to its authority, so
`https://example.com/` does not become a double slash in every canonical tag. Anything that is not
`http` or `https` is refused: a `javascript:` form action is why this is an allowlist.

**A local origin is never pinned** (`localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, `do.local`), so
running the suite or a `wrangler dev` against a persisted object cannot fix a real site's canonical
URL to a developer's laptop.

**Set it when the site is reached through a host it cannot observe** — behind a proxy that rewrites
`Host`, or on a deploy whose first request is a health check. `/firstrun` re-pins, so claiming a site
also fixes its origin, and cron boots against the same value.

Getting it wrong points canonical tags, redirects and mailed links at the wrong host. It does not
affect what a request resolves to; that is `SITE_ID`.

Specs: `tests/unit/ops/site-origin.spec.ts`, `tests/integration/render-origin.spec.ts`.

## Plan

| var    | default | what it does                                    |
| ------ | ------- | ----------------------------------------------- |
| `PLAN` | `free`  | selects the whole per-invocation budget profile |

`paid` and `free` are the only recognised values, and **anything unrecognised is free**: every limit
in this project is a free-plan limit, and a typo must not silently grant a 30 s CPU budget to
something that has 10 ms.

The plan selects six numbers at once, from `src/ops/plan-profile.ts`. Each is individually
overridable by its own var, so a paid profile can be run on free or the reverse.

| profile field     | var                  | free  | paid   |
| ----------------- | -------------------- | ----- | ------ |
| `fillBatchSize`   | `FILL_BATCH_SIZE`    | 5     | 8      |
| `fillBatchWallMs` | `FILL_BATCH_WALL_MS` | 5,000 | 1,500  |
| `httpDrainLimit`  | `HTTP_DRAIN_LIMIT`   | 3     | 15     |
| `mirrorLimit`     | `MIRROR_LIMIT`       | 2     | 10     |
| `inlineBudgetMs`  | `RENDER_BUDGET_MS`   | 2,000 | 10,000 |
| `bootInline`      | none                 | off   | on     |

`bootInline` is the one that changes an outcome rather than a rate: whether a MISS on a **cold**
object may boot the interpreter and render, or answer 503 and hand the path to the alarm chain. That
boot is ~1.4 s, which is why it stays off on free. Raising `RENDER_BUDGET_MS` does not move it — the
estimate is only consulted once an interpreter exists.

`CONFIG_KV` under the key `plan` overrides the var and is read once per isolate per minute, so an
account upgrade takes effect without a redeploy. A missing binding, a KV error and an unrecognised
value all fall through to the var.

## Serving and Caching

| var                  | default   | what it does                                                             |
| -------------------- | --------- | ------------------------------------------------------------------------ |
| `GEN_BUCKET_MS`      | 5,000     | how long the edge reuses a resolved site generation before re-reading it |
| `MAX_BODY_BYTES`     | 2 MiB     | largest non-file request body the edge forwards                          |
| `PAGE_KV_ENABLED`    | per plan  | force the cross-colo KV page tier on (`1`) or off (`0`)                  |
| `PAGE_KV_TTL`        | 86,400    | seconds a stored page lives; floored at KV's own 60 s minimum            |
| `RENDER_BUDGET_MS`   | per plan  | wall-clock ms a MISS may spend rendering before handing off to the alarm |
| `FILL_BATCH_SIZE`    | per plan  | pages one alarm firing may fill before re-arming; capped at 50           |
| `FILL_BATCH_WALL_MS` | per plan  | wall-clock ms one alarm firing may occupy the object; capped at 60,000   |
| `WINDOW_SITES`       | `default` | which sites the scheduled fill window drives                             |
| `WINDOW_MAX_FILLS`   | 50        | fills one window may drive                                               |
| `WINDOW_WALL_MS`     | 60,000    | wall-clock ms one window may run                                         |

### `MAX_BODY_BYTES`

A heap guard rather than a bandwidth one. `parse_str()` on a form body allocates inside a 128 MB
isolate, and `foo[][][][][]=bar` repeated turns a few hundred kilobytes of wire into far more of it.
Drupal's own `post_max_size` default is 8 MB; this is tighter, because there is no separate process
to lose here.

The check reads `Content-Length` and nothing else, which is the only measurement available before the
body has been consumed — and consuming it to measure it is the cost the guard exists to avoid. A
chunked request declares none and falls through to the object's own limits. `GET` and `HEAD` are not
checked.

**`multipart/form-data` is exempt.** That is the file-upload shape, its size is the point, and it is
not `parse_str()`d into a nested array, so a 2 MiB cap on uploads would be a functional regression.

Over the limit, the edge answers **413 before any Durable Object hop**. `0` disables the guard
entirely. Raising it trades isolate headroom for larger non-upload submissions; the failure mode of
too high is an object that runs out of memory mid-parse.

Consumer: `bodyTooLarge()` in `src/site.ts`.

### The KV Page Tier

`PAGE_KV` is a cross-colo tier between the edge cache and the Durable Object. It is **on for paid and
off for free** by default, because it still costs one Worker request — the Worker has to run to
consult it — so it buys latency rather than serving ceiling. A missing binding always wins over
`PAGE_KV_ENABLED`.

Stored pages are keyed by site, generation and path, so a generation bump invalidates every one of
them without enumerating or deleting anything. KV has no bulk delete, so a scheme needing one would
be uninvalidatable in practice. `PAGE_KV_TTL` is therefore a floor on garbage rather than a freshness
knob.

## Cron

| var                     | default   | what it does                                                      |
| ----------------------- | --------- | ----------------------------------------------------------------- |
| `DRUPAL_CRON`           | on        | whether Drupal cron runs from the alarm; `0` turns it off         |
| `CRON_INTERVAL_MS`      | 900,000   | minimum gap between firings                                       |
| `CRON_MAX_UNITS`        | 6         | hooks or queues one firing may run                                |
| `CRON_MAX_ROWS`         | 500       | rows one firing may write                                         |
| `CRON_MAX_MS`           | 500       | wall-clock ms one firing may occupy                               |
| `CRON_QUEUE_BATCH_SIZE` | 5         | queue items drained per queue per firing                          |
| `GC_INTERVAL_MS`        | 3,600,000 | gap between garbage-collection passes                             |
| `CACHE_DATA_MAX_ROWS`   | 5,000     | row cap on `cache_data`                                           |
| `WATCHDOG_ROW_LIMIT`    | unset     | row cap on `watchdog`; unset reads `dblog.settings` from the site |

**Cron defaults to on, and it used to default to off.** Six of twenty-five surveyed contrib modules
were classified as needing cron for that reason: the capability was built and wired into the alarm,
and nothing turned it on. A module that depends on cron does not fail when cron never runs, it
silently does nothing.

`CRON_INTERVAL_MS` is what makes the per-firing budget a budget. The alarm is not a clock — it
re-arms at +1 ms while a fill queue is draining — so "once per alarm" during an active fill is once
per page, each one costing an interpreter unit and up to `CRON_MAX_ROWS` writes. At 15 minutes the
worst case is 96 firings/day, so a site that hit the row cap every time spends 48,000 of the 100,000
daily rows. Lowering it is the fastest way to burn the meter that binds regeneration.

Cron renders against the site's origin, so links in mail it sends point at the site. See
[`SITE_ORIGIN`](#site_origin).

## Boot and Storage

| var                             | default                               | what it does                                                                                      |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `HEAP_SNAPSHOT`                 | on                                    | restore a stored wasm heap instead of booting the kernel; `0` disables                            |
| `HEAP_RESTORE_CHUNKS`           | all at once                           | chunks of a snapshot one invocation may apply                                                     |
| `LAZY_MOUNT`                    | `1` in the canonical config           | stream the pack per file instead of inflating it whole                                            |
| `LAZY_FS_BUDGET_BYTES`          | 20 MiB, 4 MiB in the canonical config | resident bytes the lazy filesystem keeps before evicting                                          |
| `SITE_DB_PREFIX`                | the packed default                    | which database pack an object mounts                                                              |
| `SQL_CHUNK_PREFIX`              | `drupal-sql`                          | which asset directory the migration chunks are read from                                          |
| `MIGRATE_ENGINE`                | `sql`                                 | `sql` replays chunks in JavaScript; `php` needs a `pdo_sqlite` the shipping binary does not carry |
| `MIGRATE_SELF_DRIVE`            | on                                    | whether a partial migration re-arms its own alarm                                                 |
| `MIGRATE_CHUNKS_PER_INVOCATION` | 1 on free, all on paid                | chunks replayed per invocation                                                                    |

### `OPCACHE_MODE`

| value  | what it does                                             |
| ------ | -------------------------------------------------------- |
| `off`  | default; opcache disabled                                |
| `file` | opcache on with the file cache as its only backing store |
| `shm`  | opcache on with shared memory as its backing store       |

The default is `off`, and the arms are measured. `file` writes 2,346 `.bin` files and 32,141,312
bytes into the in-memory filesystem for a cache nothing ever reads, and `opcache_get_status()`
reports opcache DISABLED on that arm because `file_cache_only=1` turns the shared-memory backend
off. `shm` does accelerate -- 2,346 cached scripts, no filesystem writes -- and puts its arena in
PHP's linear memory, taking an object to 191.25 MiB against a 128 MiB isolate. `off` renders within
1 ms of `file` and leaves 37 MiB more room.

### `ARGON2`

`1` hashes passwords with argon2id at m=19456 KiB, t=2, p=1, computed on the host. Default off.

Turning it on is a migration: every bcrypt hash on the site reports as needing a rehash, and each
account is upgraded at its owner's next login. Existing hashes keep working throughout; core's
password service stays in place as the inner service and still owns bcrypt and legacy `$S$` hashes.
Hashes are written in PHP's own `$argon2id$v=19$m=..,t=..,p=..$salt$tag` form, so a site that leaves
this platform can verify them on any PHP with ext-argon2.

A hash costs a 19 MiB transient allocation and two passes of CPU. That is more than a free-plan
login invocation has.

### `SHELL_ASSEMBLY`

`1` allows an authenticated GET to be answered from a stored shell with its personalised regions
filled at the edge. Default off, and nothing happens until a shell has been harvested for a path.

A shell is harvested under two sessions of one role set and stored only when both normalise to
identical bytes. A visitor whose permissions hash differs from the stored shell's falls through to
an ordinary render.

`HEAP_SNAPSHOT` is on and costs **31,784,960 bytes across 159 rows per site**, plus a 5,993 ms
one-off to take the image. It buys 2,310 ms (fast mode) to 3,578 ms (slow mode) off every module
install, n=8 per arm, present in both modes of a bimodal population.

**Changing `LAZY_MOUNT`, `MIGRATE_ENGINE` or `SITE_DB_PREFIX` in a deploying config means changing
`assets/.assetsignore` too.** The shipping asset set is derived from the canonical values of those
three; `tests/unit/runtime/assets-ignore.spec.ts` fails when the two disagree.

## Diagnostics

| var                 | default | what it does                                                              |
| ------------------- | ------- | ------------------------------------------------------------------------- |
| `PW_DIAGNOSTICS`    | off     | exposes `/sql`, `/restore`, `/php` and the rest of the diagnostic surface |
| `PHP_LOG_LEVEL`     | `info`  | RFC 5424 ceiling on what PHP's log mirrors to `console.log`               |
| `PW_SQL_TRACE`      | off     | logs every Drupal statement through `console.log`                         |
| `PW_SQL_TRACE_FROM` | 0       | first statement number to log                                             |

### `PW_DIAGNOSTICS`

**One boolean that exposes arbitrary SQL against the site database (`/sql`), a whole-database
overwrite (`/restore`) and arbitrary PHP (`/php`).** Diagnostic routes fail closed without it.
`bun run dev` sets it; a deployed configuration must not. It is deliberately absent from the KV
override allow-list — KV is operator-writable, and every name on that list has a worst case of a slow
site rather than a change in what is reachable.

### `PHP_LOG_LEVEL`

`off | error | warn | log | info | debug`, mapped onto RFC 5424 severities (lower is more severe), the
same scale `CfwLogger` sends and Drupal's own `watchdog` uses. `warning` and `notice` are accepted as
aliases for `warn` and `log`, and `all` for `debug`.

`CfwLogger` ships every Drupal log entry across the host bridge and the object mirrors it to
`console.log` so it survives the isolate that produced it. Unfiltered, that is right for a ring
buffer and wrong for a terminal: one page render on 8.5 emits several severity-7 deprecation notices
with full stack traces, which is most of what a `wrangler dev` session prints. `info` is the default
for that reason.

An unrecognised value is the default rather than an error. A fatal carries `level: "error"` with no
severity and is derived from the name, so it is never dropped by a missing field.

Consumer: `src/ops/log-level.ts`.

### `PW_SQL_TRACE`

Logs every statement Drupal issues. `console.log` survives an object reset, which is what makes it
readable when the object dies mid-run. A `wrangler tail` has a 256 KB budget, so
`PW_SQL_TRACE_FROM=<n>` spends it on the end of a long run instead of the beginning.

## Prefill and Mirroring

| var                     | default                   | what it does                                                |
| ----------------------- | ------------------------- | ----------------------------------------------------------- |
| `PREFILL`               | on for free, off for paid | seed the serving table from `assets/prefill.json`           |
| `PREFILL_ON_SAVE`       | on                        | re-render invalidated paths after a content save            |
| `PREFILL_ON_SAVE_LIMIT` | 25                        | paths one save may queue                                    |
| `MIRROR_LIMIT`          | per plan                  | files one alarm firing may push to R2; capped at 25         |
| `HTTP_DRAIN_ON_ALARM`   | on                        | drain queued outbound requests from the alarm               |
| `HTTP_DRAIN_LIMIT`      | per plan                  | queued outbound requests one firing may fetch; capped at 25 |

`PREFILL` is on for free because free is where a cold first request costs the most — a prefilled path
is a hit on its first ever request. It is off during a bake, or every render would be a hit of the
file being rebuilt.

**Mirror to the optimum, not to everything.** Once R2's read meter binds, moving more traffic
off-Worker spends a 333,333/day meter to save a 100,000/day one. On the default traffic mix the peak
is 0.769 off-Worker for 432,900 views/day, against 336,700 for mirroring everything — so maximising
costs 96,200 views/day.

The optimum moves with the traffic mix and with CDN absorption, so compute it rather than copying a
share: `optimalOffWorker()` in `scripts/measure/free-envelope.ts` derives it from the same model
every other caller uses. Raising absorption does not converge on "mirror everything" — at absorption
1, where R2 reads cannot bind at all, the peak lands at 0.888 and is bound by rows instead.

## Outbound Mail

Drupal's mail plugin is `cfw_mail`, and it hands the message to the Worker. The Worker resolves one
of three transports and commits the message to `cfw_mail_queue`; the alarm sends it. `src/ops/mail.ts`
is the implementation.

| var                   | default  | what it does                                               |
| --------------------- | -------- | ---------------------------------------------------------- |
| `MAIL_TRANSPORT`      | `auto`   | `auto`, `binding`, `api`, `smtp` or `off`                  |
| `MAIL_FROM`           | —        | the From for a message that carries none                   |
| `MAIL_DRAIN_ON_ALARM` | on       | send queued mail from the alarm                            |
| `MAIL_DRAIN_LIMIT`    | 5        | messages one firing may send; capped at 25                 |
| `CF_EMAIL_ACCOUNT_ID` | —        | the account the Email Sending REST API posts under         |
| `CF_EMAIL_TOKEN`      | —        | an API token with Email Sending: Edit; a secret, not a var |
| `SMTP_HOST`           | —        | submission host for the third-party lane                   |
| `SMTP_PORT`           | 587/465  | 587 for STARTTLS, 465 for implicit TLS                     |
| `SMTP_TLS`            | starttls | `starttls`, `implicit` or `off`                            |
| `SMTP_USER`           | —        | submission user; omit for an unauthenticated relay         |
| `SMTP_PASS`           | —        | submission password; a secret                              |
| `SMTP_AUTH`           | `PLAIN`  | `PLAIN` or `LOGIN`                                         |

`auto` takes the first transport that is configured, in the order binding, api, smtp. The binding
leads because it spends no credential.

### What Each Transport Reaches

`binding` uses a `send_email` binding named `SEND_EMAIL`, declared in your own Wrangler config. `api`
uses the Email Sending REST API. Cloudflare applies the same limits to both, and to its own SMTP
endpoint, so the choice between them is about credentials rather than capability. Two account-level
facts decide what either can reach:

- **A sending domain that is not onboarded** reaches verified destination addresses only — the 200
  per account that somebody confirmed by clicking a link. Onboarding the domain with SPF and DKIM on
  Cloudflare DNS lifts that immediately.
- **Workers Free has no outbound Email Sending.** The one carve-out is that sends to verified
  destination addresses are free on every plan, from your routing domains, against no quota.

So a free site can mail its owner and cannot mail a visitor who just registered. **Third-party SMTP
is the only general answer on free**, and a rejected Cloudflare send says so in its error rather than
reporting a status code.

### SMTP

Port 25 is blocked on Workers; `MAIL_TRANSPORT=smtp` with `SMTP_PORT=25` is refused by name rather
than attempted. `smtp.mx.cloudflare.net` is refused too: it resolves inside `162.158.0.0/15`, a
published Cloudflare range, and outbound TCP to those is blocked. Use `MAIL_TRANSPORT=api` or the
binding for Cloudflare mail. `SMTP_TLS=off` together with `SMTP_USER` is refused, because it would
put the relay password on the wire.

SMTP is the only transport that opens an outbound TCP socket, and an outbound socket is on
Cloudflare's list of conditions that prevent a Durable Object from hibernating. The object is
therefore billed for compute duration for the length of the send, and the queue drains sequentially,
so a batch is billed for the whole batch. The socket is closed in a `finally`, which keeps the
exposure to the send itself rather than the 15-minute maximum a connection can defer eviction by.
The `api` and `binding` transports use `fetch`, which never holds an object in memory.

### Limits and What a Refusal Means

A message is refused at commit, where `CfwMail` logs the reason next to the operation that produced
it, for: no recipient, no From, more than 50 recipients across To/Cc/Bcc, a subject over 998
characters, headers over 16 KB, or a payload over 1,000,000 bytes. That last one is the Durable
Object record ceiling of 2,199,995 bytes, not Cloudflare's 5 MiB — the smaller number is the one that
fires.

A failure after commit is only visible on `/__serve-stats`, under `mailQueue`, `lastMailDrain` and
`lastMailDrainAt`. A failed send is not retried: a send is not idempotent, and a password reset
delivered twice with two different one-time links is worse than one that did not arrive.

Mail sent through the `send_email` binding shows as **dropped** in the Email Routing summary even
when it was delivered. Read Email Sending metrics instead.

### Connecting a Cloudflare Account

Two ways, both owner-authenticated. Pasting `CF_EMAIL_ACCOUNT_ID` and `CF_EMAIL_TOKEN` needs no
setup. OAuth issues a short-lived scoped grant instead, revocable from the Cloudflare dashboard.

Owner-authenticated means `Authorization: Bearer <ownerToken>`, the token `/firstrun` returns once
when the site is claimed. Without it these routes answer 401 with a `WWW-Authenticate: Bearer`
challenge. `README.md` covers claiming.

`GET /setup/cf?action=connect&client_id=<id>` starts the flow and returns an authorize URL;
`/setup/cf/callback` completes it; `?action=status` reports whether an account is connected and
`?action=disconnect` revokes the grant at Cloudflare rather than only forgetting it locally.

OAuth needs a client the operator registers once, under **Manage account > OAuth clients**, with
`https://<your-site>/setup/cf/callback` as its redirect URI and `private` visibility. A redirect URI
is registered against the client and every deployment answers on a different origin, so there is no
shared client that could serve all of them. The flow is Authorization Code with PKCE (S256) and
carries no client secret.

The client ID is stored in the site's own database rather than in KV. It is not a credential, but a
KV writer who could change it would point the consent screen at an application they control.

Scopes requested: `user:read`, `account:read`, `email:read`, `email:write`. Onboarding a sending
domain additionally needs **zone DNS write**, which is why it is a separate opt-in step.

### Onboarding a Sending Domain

`GET /setup/mail?zone=<zone-id>` reports which step the domain is waiting on;
`?action=apply` creates the sending subdomain and writes the DNS records. Owner-authenticated, and
safe to re-run: a settled zone costs zero API calls.

| stage                   | meaning                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `no-zone`               | pick the zone this site sends from                           |
| `needs-subdomain`       | create the sending subdomain on that zone                    |
| `needs-dns`             | records still to write, counted in `waitingOn`               |
| `awaiting-verification` | click the link Cloudflare emailed to the destination address |
| `ready`                 | mail can send                                                |

`settled` means re-running changes nothing, not that onboarding finished. `awaiting-verification` is
settled: nothing more can be done from this side.

A sending subdomain is zone-scoped. Six records are written: three MX and an SPF TXT on the
return-path host, a DKIM TXT at `<selector>._domainkey`, and a DMARC TXT on the apex.

**An existing DMARC record is reported, never overwritten.** It states a policy for every mail
stream on the domain, so replacing `p=none` with `p=reject` would tell receivers to bounce
unauthenticated mail from senders that have nothing to do with this site. It appears under
`advisories` with both values, and the flow still reaches `ready`.

Destination-address verification is pollable: the address carries `status` and a `verified`
timestamp, so the surface lights up on its own.

## Database Updates

`updb` slices Drupal's own update path across invocations. Every var here bounds one slice.

| var                       | default | what it does                                     |
| ------------------------- | ------- | ------------------------------------------------ |
| `UPDB_FLUSH_SPLIT`        | on      | split a cache flush across invocations           |
| `UPDB_ALLOW_UNBOUNDED`    | off     | permit an update with no measurable bound        |
| `UPDB_SNAPSHOT_MAX_ROWS`  | —       | rows a pre-update snapshot may hold              |
| `UPDB_RETRY_POLICY`       | —       | how a failed slice is retried                    |
| `UPDB_ON_ABORT`           | —       | what happens to a run that cannot continue       |
| `UPDB_MAX_ATTEMPTS`       | —       | attempts per slice                               |
| `UPDB_MAX_PASSES`         | —       | passes over the update list                      |
| `UPDB_MAX_COLD_WAITS`     | —       | consecutive cold-object waits tolerated          |
| `UPDB_MAX_BEATS`          | —       | alarm beats one run may consume                  |
| `UPDB_CHECK_REQUIREMENTS` | —       | run Drupal's own update requirements check first |

Read `src/ops/updb.ts` before changing any of these; the defaults are what a sliced update was
measured against.

## Runtime Overrides

Eleven names can be overridden from the `CONFIG_KV` namespace under the key `settings`, as one JSON
object. One key rather than one per lever: a single read is atomic, costs one of the 100,000 daily KV
reads instead of eleven, and gives an operator one place to see every override in force.

```json
{ "RENDER_BUDGET_MS": 4000, "FILL_BATCH_SIZE": 8, "PREFILL": "0" }
```

`RENDER_BUDGET_MS`, `FILL_BATCH_SIZE`, `FILL_BATCH_WALL_MS`, `HTTP_DRAIN_LIMIT`, `MIRROR_LIMIT`,
`LAZY_FS_BUDGET_BYTES`, `PREFILL`, `GEN_BUCKET_MS`, `SITE_LOCATION_HINT`, `MAIL_TRANSPORT`,
`MAIL_DRAIN_LIMIT`.

**All eleven reach a reader inside the Durable Object, and for a while only two did.**
`withSettings()` is applied in `src/site.ts`, to the front Worker's env, and the object receives its
own copy of the bindings, so seven of the eleven were knobs nothing read: `RENDER_BUDGET_MS`,
`FILL_BATCH_SIZE`, `FILL_BATCH_WALL_MS`, `HTTP_DRAIN_LIMIT`, `MIRROR_LIMIT`, `LAZY_FS_BUDGET_BYTES`
and `PREFILL` are read in `src/site-do.ts` and only there. `adoptSettings()` now overlays every name
on the allow-list, and is called from `alarm()` as well as `handle()`, because four of the seven are
read on the fill chain and an alarm never passes through `handle()`. The fast storage lane adopts
nothing and must not: it is await-free by construction and reads no lever.

**A lever is offered here first, then as a var.** KV comes before `vars` so an operator can change a
setting without a redeploy; the var is the fallback. That ordering applies to anything new, including
values that look like deploy-time properties — `SITE_LOCATION_HINT` reads like one and is not, since
`DurableObjectNamespace.get()` takes the hint per call.

**The list is an allow-list and it is a privilege boundary.** KV is operator-writable, so merging an
arbitrary object into the environment would let anyone with KV write set `PW_DIAGNOSTICS=1`. Every
name here is a performance lever whose worst case is a slow site; none changes what is reachable.
`PLAN` has its own key and its own resolver, because it selects a whole profile rather than one
number. The mail credentials are absent for the same reason: `MAIL_TRANSPORT` only chooses between
transports the deploy already configured, while a KV writer who could set `SMTP_HOST` would receive
every password-reset link the site sends.

A malformed document, an unknown key and a KV error all yield no overrides rather than throwing.
Values are read once per isolate per minute.

## R2 Page Origin Caching

Mirroring pages to R2 moves them off the Worker, and an R2 public bucket on a custom domain serves
them. How much of that traffic Cloudflare's CDN absorbs in front of the bucket decides whether the
off-Worker lever is worth anything: an absorbed read costs neither a Worker request nor an R2 Class B
operation.

**Absorption is 0 without a Cache Rule and about 7/8 with one.** Measured 2026-08-21 with GET against
a cold object each time:

| Condition                   | Result                       |
| --------------------------- | ---------------------------- |
| Cache Rule on, cold object  | MISS, then **7 / 7 HIT**     |
| Cache Rule off, cold object | MISS, then **7 / 7 DYNAMIC** |

A second object under the same rule read 1 MISS, 7 HIT and 2 DYNAMIC across 10 requests, which is the
same picture with two requests landing at a PoP that had not filled yet.

**Measure with GET, never `curl -I`.** HEAD is what `curl -I` sends, Cloudflare does not populate its
cache from a HEAD, and every reading comes back `DYNAMIC`. That method produced the conclusion "R2
custom domains do not cache", which was an artifact of the instrument rather than a property of R2.

### The Cache Rule

One rule, scoped to the CDN hostname and nothing else:

```
expression:        (http.host eq "drupflare-cdn.example.com")
action:            set_cache_settings
action_parameters: { "cache": true, "edge_ttl": { "mode": "override_origin", "default": 3600 } }
```

In the dashboard it is **Caching > Cache Rules > Create rule**, with the hostname as the only
condition and **Eligible for cache** plus an edge TTL override. Over the API it is
`PUT /zones/{ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint`.

**A PUT to an entrypoint replaces every rule in it.** Read the entrypoint first and merge; on a zone
that has never had a cache-phase ruleset the entrypoint does not exist yet and creating it destroys
nothing.

**One zone-scoped permission creates it: `Zone > Cache Rules > Edit`.** Cloudflare's documentation
also lists the account-scoped `Account Rulesets: Edit` and `Account Filter Lists: Edit`; measured,
this rule shape does not need them. That correction matters, because the account-scoped reading is
what had rejected this lever as an account-wide write bought for one site.

### Smart Tiered Cache

Every PoP fills independently, so a request reaching a cold PoP is a MISS and an R2 Class B read.
Tiering routes a PoP miss through an upper tier instead of to the bucket, which changes absorption
from per-PoP to hierarchical.

Enable it at **Caching > Tiered Cache**, or:

```sh
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/cache/tiered_cache_smart_topology_enable" \
  --request PATCH \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --json '{ "value": "on" }'
```

The token needs `Zone Settings Write` or `Zone Write`. Tiered Cache and Smart Topology are both
available on the Free plan; Generic Global, Regional and Custom topologies are Enterprise only.
Cloudflare selects the upper tier automatically for a zone using R2 as an origin.

### Why the Model Still Defaults to Zero

`cdnAbsorption` in `scripts/measure/free-envelope.ts` defaults to **0** and should stay there.

Absorption is not a property of the configuration. It is a function of reads per colo per TTL window,
so a site at 10 views/day spread over 40 PoPs absorbs almost nothing and the same site at 10,000
views/day absorbs nearly everything. Zero is the correct floor for a low-traffic site and for any site
with no rule, and it is the only value that is true regardless of traffic.

So the 4.33x peak is reachable, at traffic high enough to keep PoPs warm, with one operator-applied
rule. Report anything derived from a non-zero absorption as a range rather than a point.

**`cdnAbsorption` is a code-level option, not a CLI flag.** The command line takes `--visits`,
`--dynamic` and `--warmth` only; absorption is passed to `envelope()`, `optimalOffWorker()` and
`scoreWorkload()` in `scripts/measure/free-envelope.ts`, so a claim that depends on it comes from a
caller that names the value rather than from the default run.

**Drupflare does not create the rule.** It is a change to a zone the operator owns, its value depends
on traffic the product cannot see, and the model's default does not move until an operator says they
applied it.

## Related

- `docs/repository-layout.md` — every path outside `src/` and how it arrives
- `docs/building-from-source.md` — the fifteen steps a source build runs
- `docs/measurement-classes.md` — which instrument may produce which class of number
- `docs/recovery.md` — which primitive answers which failure
- `docs/external-database.md` — why the site database lives in the Durable Object
