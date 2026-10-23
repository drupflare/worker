# Security

Drupflare runs unmodified Drupal 11 on PHP 8.5 compiled to WebAssembly, inside a Durable Object on
Cloudflare Workers. This page says what that changes about the attacks a Drupal site faces, what it
leaves alone, and how each statement was established. It is written for a security reviewer, so the
parts that weaken the case are on the page as plainly as the parts that strengthen it.

The short version: a bug in Drupal, a contributed module or PHP still compromises the site. What
changes is the next step. On a conventional host an attacker who can run code gets a process on an
operating system, with a shell, a filesystem, a network, neighbouring services and a kernel to
attack. Here the attacker gets a PHP interpreter inside two sandboxes with a fixed list of host
functions and no operating system to enumerate. Several well-known classes of server takeover have
no path left to run. Application-layer bugs, and the data inside the same object, are exposed
exactly as they were.

## How to Read the Claims

Every statement carries a tag for how it was established.

| Tag      | Meaning                                                                          |
| -------- | -------------------------------------------------------------------------------- |
| Read     | The source file or the primary document was read, and the line or quote is cited |
| Measured | A command or a test was run, and the command or the spec is named                |
| Inferred | It follows from the architecture and nothing was run against it                  |

Every row is closed to one of three verdicts. There is no fourth.

- `removed`: the attack path needs a component the object does not have.
- `contained`: the flaw or the attacker's foothold exists, and a control limits what it reaches or
  what it keeps. The control and its residual are named.
- `open`: the flaw works as it does on any host, or it could not be established either way. A claim
  that could not be established counts as `open` at full capacity, and the row says what would
  settle it.

A measurement taken on a local `workerd` is labelled that way. It runs the same runtime code as the
platform and not the platform's extra protections, so it never upgrades a row to `removed` by
itself.

No study measures how much a serverless or sandboxed runtime lowers breach probability. The page
does not put a percentage on safety. It counts attack classes instead, and the count is only as good
as the inference behind each row (see [How Much Safer](#how-much-safer)).

Sources were read on 2026-10-21 and 2026-10-22. The quotes from Cloudflare's security model and
Spectre post, SA-CORE-2026-014, the Lehmann and Stiévenart abstracts and the GTIG report were
checked a second time against the live page. The rest were read once through a page extractor, so
check the live page before quoting one to a third party. Cloudflare's pages and the PHP and Drupal
advisories change.

## What Is Claimed and What Is Not

| Claim                                                                                         | Status                                                                                                        |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| There is no operating system, shell, web server or PHP-FPM pool in the site's trust boundary  | Read: [layers](#the-layers)                                                                                   |
| A PHP exploit runs inside WebAssembly linear memory and reaches the host only through imports | Read: webassembly.org security page                                                                           |
| Cloudflare states a V8 patch gap under 24 hours                                               | Read: Cloudflare security model                                                                               |
| Server-takeover classes (FPM, CGI, Shellshock, Apache, container and kernel escapes) are gone | Inferred: [map](#the-cve-and-incident-map)                                                                    |
| PHP in the interpreter cannot open a socket, call a JavaScript global or spawn a process      | Measured: control 3 recorded calls, shipping glue 0; see [Host Surface](#host-surface)                        |
| An owner token stored by Drupflare can be read by code with SQL access                        | False since v1.0.4. Only its hash is kept, outside SQL: [Credentials](#credentials-and-persistence)           |
| Arbitrary code execution is impossible                                                        | False. Any Drupal RCE runs PHP in the sandbox                                                                 |
| A compromised PHP cannot read the site's own data                                             | False. The database sits in the same object                                                                   |
| WebAssembly makes memory corruption harder to exploit than native                             | False. See [Memory Corruption](#memory-corruption-inside-the-sandbox)                                         |
| A published PHP2Shell chain works against a Drupflare site                                    | No. Each needs a per-request startup and shutdown cycle that does not exist here; see [PHP2Shell](#php2shell) |
| Drupflare is safer than a VPS                                                                 | Inferred, per attack class, and unmeasured as a whole: [How Much Safer](#how-much-safer)                      |

## The Layers

A request passes through these layers, from the attacker's side inward.

| Layer                       | What it is                                                       | Source                        |
| --------------------------- | ---------------------------------------------------------------- | ----------------------------- |
| Drupal and contributed code | Application authorization, SQL, templates                        | the site itself               |
| PHP, compiled to wasm       | The interpreter in WebAssembly linear memory, built by `phasm`   | `interp.lock.json`            |
| Glue and host functions     | 102 JavaScript imports from the module, plus 31 `cfw*` functions | [Host Surface](#host-surface) |
| V8 isolate in workerd       | The JavaScript sandbox that holds the module and the glue        | Cloudflare docs               |
| Cloudflare process sandbox  | Linux namespaces and seccomp around the process                  | Cloudflare docs               |
| Cloudflare's hosts          | The machine, which belongs to the platform                       | not in scope                  |

Cloudflare's security model page describes the last two. "The layer 2 sandbox uses Linux namespaces
and seccomp to prohibit all access to the filesystem and network." It also says that "Workers does
not allow our customers to upload native-code binaries to run on the Cloudflare network" and that
"the Workers patch gap is now under 24 hours", where the patch gap is the time between publishing a
V8 fix and deploying it ([Cloudflare](https://developers.cloudflare.com/workers/reference/security-model/),
read 2026-10-21). All three are Cloudflare's statements about its own platform. None was
independently measured here.

The same page carries two cautions. It says "Local `workerd` processes do not include every
defense-in-depth protection described here", and the workerd README is headed "WARNING: `workerd`
is not a hardened sandbox." The protections above belong to hosted Workers. A self-hosted `workerd`
needs a microVM or equivalent boundary around it, which is what the `isolated` mode of
[bastion](https://github.com/drupflare/bastion) provides.

The database sits inside the same object as PHP. There is no boundary between the interpreter and
the site's own SQLite file, and none was ever claimed.

## What Drupflare Provides Today

### Host Surface

The interpreter reaches the outside through two routes: the imports of the wasm module, and the
`cfw*` functions the Durable Object installs on the Emscripten `Module`.

**The module.** The shipping module, `.interp/php8.5.wasm` as pinned in `interp.lock.json`, imports
102 functions, all from `env` and `wasi_snapshot_preview1`. The tuned copy derived from it imports
103, the extra one being `env.memory` (Measured: `WebAssembly.Module.imports()` on both files).
`config/host-imports.json` holds every one with a class, and `bun scripts/import-census.ts` fails on
an import that is not on file, a name that is gone, or a class that is missing
(`tests/node/host-import-census.spec.ts`, Measured, falsified by removing an entry and by leaving
one unclassified). A new import therefore cannot join the surface without a reviewed line.

| Class     | Imports | Meaning                                                                                                 |
| --------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `hard`    | 18      | The host has no such function: five abort stubs, 11 closed in the tuned glue (below), two asyncjs stubs |
| `policy`  | 2       | The function exists and a list decides: the two `emscripten_asm_const_*` entries that carry the bridge  |
| `compute` | 60      | libc, time, memory, in-isolate pipes and fake name lookups; no outside effect                           |
| `io`      | 22      | The in-isolate file system and the wasi read and write calls                                            |

The five abort stubs are `posix_spawnp`, `getdtablesize`, `__assert_fail`, `_abort_js` and
`emscripten_fiber_swap`. `posix_spawnp` aborts (`.interp/php8.5-worker.mjs`, "missing function:
posix_spawnp"), so there is no fork, no exec and no process table.

**Raw sockets, closed in v1.0.4.** Emscripten's stock glue implements `socket`, `connect` and the
rest of the socket calls over a `WebSocket`, and resolves names through a fake DNS.
`closeSockets()` in `scripts/measure/growth-glue.ts` replaces the bodies of the 10 socket syscalls
and `getaddrinfo` in the tuned glue, so each returns a fixed refusal. Measured in node with a
recording `WebSocket` on `globalThis`: on the stock glue `fsockopen` and `stream_socket_client`
constructed 3 WebSockets, including one to `probe.invalid`; on the tuned glue 0
(`tests/node/growth-glue.spec.ts`). Every legitimate network path here goes through a `cfw*` host
function, and 149 park, Redis, mail, HTTP-queue and TCP tests ran with a recording `WebSocket` and
constructed none.

**The vrzno bridge, closed in v1.0.4.** The interpreter carries `vrzno`, the extension that lets PHP
call JavaScript. Its `EM_ASM` bodies reached all of `globalThis`, an `eval`, a dynamic `import` and
every property of `Module`, so userland PHP could call a JavaScript global directly, including
`fetch` and `WebSocket`, with no host function and no outbound guard in the way. The shipping PHP
uses only `vrzno_env('<cfw name>')`. `closeVrznoBridge()` in the same file now leaves three things:
`vrzno_env` answers only names of the form `cfw[A-Za-z0-9]*`, the root handle is an empty frozen
object instead of `globalThis`, and each `cfw*` function reaches PHP as a sealed wrapper with no
prototype, whose object or function replies become null. `vrzno_eval`, `vrzno_run` and
`vrzno_import` answer a fixed string. Measured in node, 14 attempts, control against shipping glue:
the stock glue made 3 recorded calls (a `fetch` to a metadata address, a `WebSocket`, a `fetch` to
another host) and returned live proxies for `process`, `crypto` and `Function`; the tuned glue
made 0 calls and returned null for each (`tests/node/growth-glue.spec.ts`,
`tests/integration/interpreter-lifecycle.spec.ts`, both falsified). What it leaves open: PHP can
still call any `cfw*` function with any argument, which is the capability list below, and a PHP
write to the frozen root throws a JavaScript `TypeError` through the wasm frame, which ends that
invocation. Whether the open bridge could read `process.env` on a hosted Worker, where the secrets
sit, was not measured on the platform and is treated as having been possible. The fix reaches a
deployed site only with the next deploy of the tuned glue.

**The `cfw*` functions** are the intended capability set (`src/do/capabilities.ts`,
`src/ops/park-drive.ts`, `src/ops/tcp.ts`, Read):

| Function                                                                 | What it reaches                                              | Limit                                                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `cfwSqlExec`, `cfwSqlTxn`, `cfwSqlPark`                                  | Any SQL on the site's own Durable Object SQLite              | It is Drupal's own database connection; `_cf_KV` answers `SQLITE_AUTH`               |
| `cfwFetch`, `cfwHttpCacheGet`                                            | The fetch cache only; a miss queues a request and returns    | No synchronous network by construction                                               |
| `cfwQueueFetch`, `cfwParkFetch`                                          | Any public HTTP(S) URL, with PHP's headers and body          | Deny-list for private and metadata hosts, applied to every redirect hop              |
| `cfwTcp`                                                                 | Redis and syslog at the endpoint the operator configured     | PHP names no host; port must match the configured endpoint                           |
| `cfwMail`                                                                | A message queued through the site's mail transport           | From-domain check and size caps                                                      |
| `cfwFile*`, `cfwFilePublicBase`                                          | The site's own file tables                                   | `..` rejected; flat keyspace inside one object                                       |
| `cfwSettings`                                                            | `CONFIG_KV`, for the allow-listed levers                     | `PLAN`, `CSP_MODE` and the outbound guard are refused; writes are scoped to the site |
| `cfwOidcClaims`, `cfwModules`, `cfwHealth`                               | One redeemed OIDC ticket, the module list, the health ledger | Read or own-object only                                                              |
| `cfwAead`, `cfwArgon2`, `cfwBlake2b`, `cfwSign`, zlib, image, stats, log | Computation in JavaScript inside the object                  | Canvas and operation caps                                                            |

`cfwSettings` is the one host function that reaches `CONFIG_KV`. No host function names the `SITE`
namespace or the fleet D1 database, so PHP cannot address another site's object or the fleet table
(Measured: the census spec asserts that scan, and a planted function naming `SITE` through a
computed key is caught). The scan reads what a host function's own source names and not what its
helpers reach, which is why `writeSettings` has its own spec.

Shell functions go through a router in the `drupflare` module (`src/Exec/Commands.php`) that serves
a fixed program list, including `echo`, `zip`, `curl` and `wget`, and refuses pipes, redirection
and every other program. The router is a compatibility layer written in PHP. It decides what
ordinary PHP code can do. The property that matters for an attacker is different: the wasm module
has no process to fork or exec into, because `posix_spawnp` aborts and there is no kernel.

### Request Path

| Control                                            | Where it is enforced                                                                | Strength                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `__` object routes answer 404 from outside         | front worker, `src/site/entry.ts:174`                                               | route table                                              |
| Owner routes need the owner token                  | front worker, `src/site/owner.ts`; object check in `src/do/routes/auth.ts`          | policy check, against a stored hash                      |
| Failed-token budget, 12 per 60 s per IP            | front worker, `src/ops/admin-session.ts`                                            | policy check; in memory, not a brute-force defence       |
| `?site=` ignored on visitor routes                 | front worker, `src/site.ts`                                                         | policy check                                             |
| Forged `x-cfw-*` headers stripped                  | `src/ops/forwarded-headers.ts`                                                      | policy check                                             |
| Request body capped at 2 MiB, multipart at 100 MiB | `src/site/guards.ts`, `src/ops/body-limit.ts`; a chunked body is read under the cap | policy check                                             |
| `PLAN` and `CSP_MODE` cannot be written by PHP     | `src/ops/plan.ts`, `src/do/capabilities.ts`                                         | policy check at the writer                               |
| The outbound guard has no lever                    | `src/ops/outbound-guard.ts`; four spellings tried in `settings-capability.spec.ts`  | read from the operator's environment only                |
| One Durable Object per site, id from host          | `src/ops/site-id.ts`                                                                | naming convention plus the platform's per-object storage |

A hard boundary is one where the host has no such function. A policy check is one where the
function exists and a list or a flag decides. The distinction matters for an attacker who can
change what PHP asks for, because a policy check is a decision about that request and a missing
function is not.

Before v1.0.4 the request cap exempted multipart bodies and nothing counted a chunked body while it
streamed, so the only bound was the platform's 100 MB request limit. A declared length is now
checked up front and a chunked body is read under the cap (`tests/integration/serve-edge.spec.ts`,
falsified).

### Outbound Requests

The guard in `src/ops/outbound-guard.ts` refuses private, link-local, metadata and credentialed
hosts, and `fetchGuarded` re-checks every redirect hop. Both fetch paths, the queue and the park,
call the same function. v1.0.4 closed four spellings that passed the string checks: a trailing dot
(`metadata.google.internal.`), the NAT64 prefix `64:ff9b::/96` and `64:ff9b:1::/48`, site-local
`fec0::/10` and multicast `ff00::/8` (`tests/unit/ops/outbound-guard.spec.ts`, falsified). 6to4
(`2002::/16`) and Teredo also embed a v4 address and are not matched.

The guard judges a string. A public name that resolves to a private address cannot be refused by it,
and whether a hosted Worker's `fetch` reaches link-local addresses was not measured. Both stay
`open`, and a deployed probe against a name with an A record of 169.254.169.254 would settle the
second. Egress to public hosts is open by design (see
[Data in the Same Object](#data-in-the-same-object)).

### Uploads and Request Parsing

PHP's multipart handling is not entered for an inbound request. No SAPI delivers the request: the
render fragment receives the method, body and cookies as arguments, parses multipart by hand and
builds `UploadedFile` objects in userland (`src/site/php/pw-serve-inline.php`), and `$_FILES` is
empty. Nothing in `worker/src` or `phasm/src` calls `php_request_startup`, `sapi_activate` or
`php_default_treat_data`, and `pib_run` runs no request-startup cycle (Read).

Measured since v1.0.4: `tests/integration/multipart-submit.spec.ts` posts a multipart body with a
file and asserts from inside PHP that `$_FILES` is `[]`, that `is_uploaded_file()` is false on the
userland path, that the file arrived as a Symfony `UploadedFile` built by the render fragment, and
that its bytes match. Removing the fragment's record of the temp path fails it. The C-level claim
that PHP's own upload handler never runs stays Inferred, because php-src is fetched at build time.

The boot ini also sets `session.upload_progress.enabled=0`, `file_uploads=0`, `expose_php=0` and
`allow_url_include=0` (`PhpStatic` in `src/site-do.ts`). `session.upload_progress.enabled` is
`PHP_INI_PERDIR`, so boot is the only place to change it. Each value is read back from the running
interpreter in `interpreter-lifecycle.spec.ts`, and `disable_functions` is unchanged.

### Credentials and Persistence

Drupal's database connection reaches `cfwSqlExec`, which applies no table filter, so any code that
can run SQL can read and write every table in the object. These changes move authority out of SQL.

**Sealed storage.** `ctx.storage.kv` is a separate table in the object's SQLite file that the SQL
bridge cannot read or write. Measured on a local `workerd` 1.20261012.1 (`owner-recovery.spec.ts`):
`SELECT`, `INSERT`, `UPDATE`, `DELETE` and `DROP` on `_cf_KV` all answer `SQLITE_AUTH`, from the SQL
bridge and from PHP's `cfw_sql()`; `ATTACH` and `DETACH` are denied; a view, a subquery, a table
copy and a trigger over `_cf_KV` read nothing; and a table renamed onto the name `_cf_KV` does not
become the key-value table. `sqlite_master` and `pragma_table_list` still reveal that the table
exists. The rename case is tested because Check Point reported a rename-based authorizer bypass in
2026 that Cloudflare says it fixed in production, with no date given
([Check Point](https://research.checkpoint.com/2026/when-agentic-glue-melts/), extract). The local
build refuses the rename, and the hosted fix is not independently dated, so the sealed-storage
claim on the platform is `contained` and not `removed`.

**The owner token.** Only its SHA-256 is stored, in sealed storage, and the check compares hashes
in constant time. A claim returns the token once. Recovery rotates the token, returns
`rotated: true` and the new value, and `drangler recover-token` stores the new value and lists every
place that still holds the old one. A site upgraded from a version that kept a plaintext
`owner_token` row adopts it at wake and at every alarm: the row is hashed into sealed storage and
deleted, and a sealed value always wins over a row. The git tokens, webhook secrets and Cloudflare
OAuth grant follow the same path. A restore point from before the upgrade brings the old row back
and the next wake adopts it again, so rotate through recovery after restoring to one. Verdict:
contained (Measured, `site-secrets.spec.ts`, `owner-recovery.spec.ts`, `git-remotes.spec.ts`,
falsified by mirroring the hash into `cfw_meta` and by removing rotation). Residual: a Cloudflare
account holder can read the object's storage.

**Export and import.** A default export carries none of these values. `/export?secrets=1` carries
the sealed values as ordinary `cfw_meta` rows (`owner_token_hash`, `cf_oauth_token`, `git_token_*`,
`git_hooksecret_*`), and an import adopts them on the next wake, so a demo or a migration keeps
working without a manual step (`serve-restore.spec.ts`, 7 cases). A dump from a pre-sealed worker
still carries the owner token in the clear.

**Module files.** `mountInstalledModules()` mounts every row of `cfw_module_file` into the
interpreter's file system on every boot, and PHP's SQL connection can write that table, so a planted
row used to survive a restart, a Drupal patch and a redeploy. On a claimed site each row is now
checked, when the file is first opened, against a SHA-256 record in sealed storage. One function,
`changeModuleFiles` in `src/do/module-files.ts`, writes records and rows together for installs,
git pulls, `/modify`, rollbacks, removals and branch switches. A row with no record or other bytes
mounts as an empty file, is counted under `moduleIntegrity` in `/__serve-stats`, and is logged once
per path. Measured on a local `workerd`: hashing 1,040 files and 6.1 MB costs 4 to 10 ms with
`node:crypto` (550 ms with the pure-JavaScript SHA-256, which is why it is not used), and first open
of every file read 42 to 46 ms claimed against 41 to 49 unclaimed (`modify-upload.spec.ts`,
falsified). Verdict: `contained`. It stays `contained` for these reasons:

- Unclaimed sites are not held, because a migrated site's code arrives as rows before the claim.
  The first mount after the claim adopts the rows as they stand, so a site compromised before the
  upgrade stays compromised.
- Replica lanes are not checked. A planted row on the primary still reaches them (`L`).
- Other database-resident paths remain: the compiled container row in `cache_container`,
  `unserialize` of stored data, `cfw_package_autoload`, `cfw_module_blob` until a revision applies
  it, and `/__moduleasset`, which serves a stored text file to a browser without a record check.
- An import brings module rows with no records, so they are refused until the owner redelivers the
  package through `/modify`, `/install` or `/git`.

**Heap images.** A boot restores a stored interpreter heap from `cfw_heap_snapshot` and
`cfw_heap_chunk` instead of booting PHP. The restore is gated by `HEAP_SNAPSHOT`, which is on unless
it is `0` or a deployment environment is set, and not by `HEAP_IMAGE`, which gates only the
producer. The digests sat in the same tables as the bytes, so code with SQL write could plant a
snapshot with matching digests and have its memory restored on the next boot. That was `open` on a
default site: with the new check bypassed, a planted row restored on the shipping configuration
(Measured, `heap-restore-autoload.spec.ts`). A SHA-256 root over the stored rows and over the
metadata that steers a restore (page index, fd table, handle table, generation, sizes) is now sealed
and verified before any byte, handle or descriptor reaches the instance, and per chunk on a sliced
restore. A planted, altered or unsealed image is refused and deleted, the site boots from the pack,
and `heapIntegrity` in `/__serve-stats` counts it. Verified restore cost: 2 to 3 ms against 71 to
72 ms of copying, local `workerd`. Verdict: `contained`. SQL write can still delete images, which
costs a boot and nothing more, and the survival of a sealed record across a point-in-time restore is
Inferred.

**Still in SQL.** These `cfw_meta` keys carry authority and have not moved: `git_remotes` (point a
remote at a repository the writer controls, and the next pull installs that tree), `recover_spent`,
`first_run_at` and `first_run_keys` (reopen the claim window), and the OIDC issuer and client id
(point logins at another provider). All are `open`.

**The owner audit log.** Owner calls that change something append to a hash chain held in sealed
storage: sequence, time, route label, method, status, a token fingerprint, and the previous hash,
in a ring of 1,000. Each append also writes `{seq, hash}` to Workers observability, so a rewrite of
the ring is checkable against a copy outside the object. `GET /audit` and `drangler audit --verify`
recompute the chain. It is evidence against a site-level attacker and none against the account
holder, who can edit the object's storage. Two gaps: a point-in-time restore rewinds the log and
nothing in the object can append after it, and the first claim is not an entry. A refused token adds
no row.

### Response Headers

Until v1.0.3, the front worker sent none of `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Strict-Transport-Security` or `Content-Security-Policy` on a Drupal page. The
render fragment forwarded only `x-drupal-*` headers, so core's own `X-Content-Type-Options` and
`X-Frame-Options` never reached a browser.

The v1.0.4 line sends three defaults on every response the Worker answers, and
`Strict-Transport-Security: max-age=31536000` over https (`src/ops/edge-rules.ts`):

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: strict-origin-when-cross-origin`

It also stores eleven allow-listed headers a module sets, such as Security Kit's, with the page and
replays them on every tier: the object, `caches.default`, the isolate memo, KV, the stale answer
and the compiled plan. Precedence is the default, then the module's header, then an operator
`RESPONSE_HEADERS` rule, and a rule value of `""` removes a header. `set-cookie`, `location`,
`link`, `content-*` and `access-control-*` are never replayed, and a stored value is re-checked on
read, so a row written through SQL cannot replay a cookie
(`tests/unit/ops/module-headers.spec.ts` and the tier cases in `serve-chain.spec.ts`,
`serve-edge.spec.ts` and `edge-read.spec.ts`, falsified).

`CSP_MODE` sets a baseline `Content-Security-Policy` on HTML that carries none:
`object-src 'none'; base-uri 'self'; frame-ancestors 'self'; report-uri /csp-report`. The default is
`report-only` on paid plans and `off` on free. A page that already carries an enforcing policy keeps
only its own. The baseline constrains `<object>`, `<embed>`, `<base>` and framing, and nothing else.
It sets no `script-src`, so it does not stop injected script (a strict nonce policy is `L`).
`form-action` is out of the baseline: a form that posts here and redirects to an identity provider
would break, and the OIDC and git-provider flows were not driven in a browser. `POST /csp-report`
answers in the front worker, rate limited, and logs one line per report. A real browser has not
loaded a core page under the header; the workers-pool check shows only that `/`, `/user/login` and
`/user/password` contain none of the four elements the baseline constrains. Verdict: `contained`
for plugin embedding and clickjacking, `open` for script injection.

A compromised Drupal administrator can still remove the baseline, because `RESPONSE_HEADERS` is
writable from Drupal's settings form and `{"path":"/*","set":{"Content-Security-Policy":""}}`
removes it. Refusing `CSP_MODE` from PHP closes only the direct switch. This is `open`, and
whether the form should lose `RESPONSE_HEADERS` is a decision the page leaves to the maintainer.

Two limits remain. Pages mirrored to R2 carry none of these headers (`L`: R2 serves a fixed header
set), and static files served by the asset layer carry cache rules and none of them.

A page whose response varies by `Accept`, `Origin`, `User-Agent` or `*` is not stored. The page
key holds no request header, so storing such a page would hand one visitor's variant to everyone.
On the stock pack nothing varies: `/` and `/user/login` rendered the same under five header sets,
and four requests through the front worker with different headers got one body
(`forwarded-headers.spec.ts`, `serve-edge.spec.ts`, Measured). The refusal is for modules that vary.

### The Build

The shipping interpreter is built by `phasm`, which drives `seanmorris/php-wasm`'s Makefile with an
rc file per variant. The Makefile sets `TOTAL_STACK=32MB`. The extension list is short. `soap`,
`phar`, `intl`, `gd`, `openssl`, `exif` and `sqlite` are not compiled in (`WITH_*` settings in
`long64.rc`; the binary contains no `SoapServer` string, Measured with `grep -a -c`). Every extension
left out is an extension its bugs cannot reach.

`phasm` now pins the PHP patch release (`src/php-versions.lock`, 8.5.12) and the php-wasm commit.
php-wasm's Makefile hardcodes 8.5.2, and an rc cannot move it, so the pinned release arrives as make
variables, `build-variant.sh` refuses a php-src tree that disagrees with the pin, and
`inspect-build.sh` fails a binary that reports a PHP below the pin. The worker's `interpreter.yml`
now runs `gh attestation verify` on the fetched files before it prices or pins them, against the
phasm build workflow's identity. That verification was written and tested for its position in the
workflow and has not run against a real attestation.

### Patching

Cloudflare patches V8 and the platform. Drupal core and the PHP interpreter are the project's to
patch, and that path has a manual step. A new interpreter build travels from `phasm` to a pull
request in this repository and ends there. The workflow has no deploy step, and a person merges,
releases and deploys (`docs/php-update-delivery.md`). The pin records `.interp/php8.5.wasm` with its
sha256.

The interpreter in the tree reports PHP 8.5.12, the first 8.5 release that carries the PHP2Shell
fixes (Measured: `interpreter-lifecycle.spec.ts` asserts `PHP_VERSION >= 8.5.12`). The advisory was
published 2026-10-21 13:34 UTC. A local rig build that passes the park, heap and static-sweep specs
finished on 2026-10-22 at 21:13 UTC, 31 hours 39 minutes later, and the attested CI artifact
(phasm run 39861586180, artifact 12463245201, `gh attestation verify` exit 0) was created at 22:09
UTC, 32 hours 35 minutes after the advisory (the advisory time is Read from the PHP announcement,
the build times from the rig log and the run record). That is one interval on one build, not a rate,
and deployed sites move only when someone publishes the artifact, merges the pin and deploys. The
root `composer.lock` pins
Drupal core 11.4.10, the fixed release for the 11.4 line of SA-CORE-2026-014.

Rebuilding found a defect in `phasm`'s own park extension. When a parked chain completes after a
resume, the root frame's `return_value` still pointed at a C local of `zend_eval_stringl` that the
`longjmp` had destroyed, so the final `ZEND_RETURN` wrote a 16-byte zval onto whatever the resuming
stack held. On 8.5.2 the bytes were dead and nothing showed. On 8.5.12 the write corrupted the
dispatch state and the next call trapped. The extension now points the root at a slot it owns
(`park_pin_root()` in `cfwpark.c`). The fix is covered natively (22 pass, 21 pass and 1 fail
without it) and by `park-interpreter.spec.ts`. It matters here because it is a memory-safety bug in
code the project wrote, reachable only on a site that arms the park (`REDIS_URL` set, or an OIDC or
other outbound fetch that parks).

## What the Architecture Removes

These classes need a component the object does not have.

- **A server process to take over.** There is no PHP-FPM pool, CGI handler, web server, SSH daemon
  or inbound socket. CVE-2019-11043 (PHP-FPM behind nginx), CVE-2024-4577 (PHP-CGI on Windows),
  CVE-2021-41773 (Apache path traversal) and CVE-2014-6271 (Shellshock through CGI) each need one.
- **A shell and delegates.** `posix_spawnp` aborts and the module has no process table, so
  command-injection classes such as ImageMagick delegates (CVE-2016-3714) have nothing to run.
  GD is not compiled in, and image operations run as JavaScript.
- **A kernel and a container runtime in the tenant's boundary.** Container and kernel escapes,
  including runc CVE-2019-5736, runc CVE-2024-21626, Dirty Pipe CVE-2022-0847 and Dirty COW
  CVE-2016-5195, start from a process on a shared Linux kernel. That kernel is Cloudflare's, and an
  attacker here needs a vulnerability in Cloudflare's runtime first.
- **An appliance in front of the application.** The CitrixBleed class (CVE-2023-4966) is a memory
  disclosure on an edge appliance. TLS ends at Cloudflare's edge, and PHP has no OpenSSL (`WITH_OPENSSL=0`).
- **A native binary upload.** Cloudflare accepts only JavaScript and WebAssembly.
- **A writable server filesystem that persists.** The in-memory filesystem is rebuilt on a new
  instance, and uploads live in the site's own file tables. The rebuild reads `cfw_module_file`, so
  a planted module row was a way back in; see [Credentials and Persistence](#credentials-and-persistence)
  for what now holds it.

Google's Threat Intelligence Group counted 90 zero-days exploited in the wild in 2025, with 43
(48%) in enterprise software and appliances and browsers under 10% of the total
([GTIG](https://cloud.google.com/blog/topics/threat-intelligence/2025-zero-day-review/), read
2026-10-21). The count is about products in general. It shows where attackers spend zero-days, and
it does not measure Drupflare.

## What It Does Not Remove

### Application Bugs

A SQL injection, an authorization bypass or a cross-site request forgery behaves as it does on any
host. Drupalgeddon (CVE-2014-3704, SA-CORE-2014-005) is a SQL injection reachable by an anonymous
user, and it reads the same database here. SA-CORE-2020-004 (CVE-2020-13663) is a CSRF flaw in the
Form API, and a browser does not care where the server runs.

### Code Execution Inside the Sandbox

Drupalgeddon 2 (CVE-2018-7600, CVSS 9.8) and SA-CORE-2019-003 (CVE-2019-6340) execute PHP. So does
SA-CORE-2026-014 (CVE-2026-108097), a Field UI remote code execution in core published 2026-10-14.
Its advisory says "At least one known exploit path does not require authentication" and also says
the flaw "is not directly exploitable with core alone", with serious exploit paths through
contributed modules. In each case the attacker runs PHP in the object, with the host functions
above and the database in the same object. The architecture contains what that PHP can do
outside the object. It does not stop the PHP from running.

### Memory Corruption Inside the Sandbox

WebAssembly does not make a C program's memory bugs harder to exploit. Lehmann, Kinder and Pradel
(USENIX Security 2020) find that many classic vulnerabilities that common mitigations block in
native code are exposed in WebAssembly, that the platform enables new attacks such as
overwriting constant data, and that attacks can divert control flow or manipulate the host. Their
conclusion is "a perhaps surprising lack of binary security in WebAssembly"
([USENIX](https://www.usenix.org/conference/usenixsecurity20/presentation/lehmann), abstract read
2026-10-21). Stiévenart, De Roover and Ghafari compiled 4,469 C programs with known buffer
overflows to x86 and to WebAssembly, found 1,088 whose outcome differed, and attribute it to "the
lack of security measures such as stack canaries in the generated WebAssembly"
([arXiv:2111.01421](https://arxiv.org/abs/2111.01421), abstract read 2026-10-21).

So treat an exploit of a PHP memory bug as no harder inside the sandbox than on a native build, and
do not count on in-sandbox exploit difficulty. WebAssembly checks an indirect call's type
signature, so a hijack is limited to functions of the same type
([webassembly.org](https://webassembly.org/docs/security/)). What the sandbox changes is the step
after: code in the module reaches the host only through the imports above.

### JavaScript Code Execution in the Isolate

A foothold in the isolate's JavaScript would be worse than one in PHP, because the isolate holds
the bindings the Worker holds: the `SITE` and render-lane namespaces, `CONFIG_KV` and `PAGE_KV`
across sites, the fleet D1 database, `ASSETS`, and the variables and secrets in `env` (an email
token, the SMTP password, `REDIS_URL` with its password, the OIDC client secret). The `cfw*` list
limits what PHP can ask for and does nothing to limit JavaScript that is already running. This
section is Inferred from the bindings model and `wrangler.jsonc`; the Durable Object and secrets
documentation was not read.

Three paths to that foothold:

| Path                  | What stops it                                                                                                  | What the repo does                                                                                                                                                                     | Verdict     |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| From wasm outward     | V8's isolation; Cloudflare says the V8 sandbox needs a bypass to leave                                         | The bridge and socket closures above remove the userland routes. The engine's code-generation ban remains for any other object                                                         | `contained` |
| From the engine       | Cloudflare's patch gap, under 24 hours for V8; the sandbox is "not a complete Spectre mitigation" in its words | Nothing here changes V8 or `workerd`                                                                                                                                                   | `open`      |
| From the supply chain | Cloudflare accepts no native uploads, which does not cover an npm package that runs at build time              | A lockfile pins versions, not contents. `postinstall` runs `scripts/restore-artifacts.ts` on every install and fetches the interpreter from a CDN, checked against `cdn-manifest.json` | `open`      |

The engine path has one published case. Check Point (2026-08) reported use-after-free and
out-of-bounds bugs in `workerd`'s zlib, HTMLRewriter and URLPattern code and a bypass of the
key-value SQL authorizer. On self-hosted `workerd` with the V8 sandbox switched off they reached
native code execution and a co-located Worker's API token. Cloudflare confirmed the bugs reproduce
on its production platform with one exception and says they are fixed there. No date was found and no
CVEs were assigned ([Check Point](https://research.checkpoint.com/2026/when-agentic-glue-melts/),
extract). A second item, CVE-2026-87491, is a V8 out-of-bounds write in the CISA known-exploited
catalog whose entry names Chrome and Chromium; whether the Workers build is affected was not
established. Both count as `open` until Cloudflare gives a hosted date and says what the Workers
build took.

Cloudflare's security model page does not say that `eval` or runtime WebAssembly compilation is
blocked, so the page does not claim it. A `new Function` was refused in a deployed probe and
request-time `WebAssembly.Module` compilation is refused by `workerd` (`CLAUDE.md`, both measured on
this project's own probes). Neither is a statement about hosted Workers in general.

Of the 14 runtime npm packages, advisories were checked for four. `mysql2` 3.24.4 is above the fix
for GHSA-3f6p-5ww8-9rcr, and `pg` has a 2018 advisory whose affected range was not read. The other
ten and every transitive package are unchecked, and an unchecked package counts as `open`.

### Data in the Same Object

Code execution inside the sandbox reads and writes the whole site database, which is in the same
object. Sealed storage keeps credentials out of that database, and nothing keeps the site's
content, users, sessions and configuration out of it. Egress is open by design:
`cfwQueueFetch` sends any public HTTP(S) request PHP builds, because the legitimate set (update
servers, OIDC providers, webhooks) is open-ended. The deny-list protects private and metadata
addresses and does not stop a site's own data leaving to a public host. A per-site egress allow-list
is `L` and is not built.

### Co-Tenancy and Side Channels

Cloudflare runs many isolates in one process. On 2026-08-19 it published a revisit of remote Spectre
attacks on Workers, reporting a leak of "up to 12 bit/s with an accuracy of more than 99%" of a JWT
a researcher placed in a co-located Worker. It adds that "The V8 sandbox is not a complete Spectre
mitigation" and "MPK is not a complete answer to remediate Spectre, but it strictly reduces the
leakage surface". It lists frozen timers, no shared memory, detection, memory shuffling, process
isolation for suspicious scripts, the V8 sandbox and in-process isolation with memory protection
keys. Only the memory protection keys carry a date, September 2025
([Cloudflare](https://blog.cloudflare.com/revisiting-spectre-attacks-on-workers/); paper
[arXiv:2608.17043](https://arxiv.org/abs/2608.17043), abstract only). A site that holds a secret in
a Durable Object is exposed to this class on any shared platform. The mitigations are Cloudflare's.

### Platform Failure and Concentration

A bug in Cloudflare's own software reaches every tenant. Cloudbleed (2017) leaked memory from
Cloudflare's HTML parser into responses for about 1 in every 3,300,000 requests during its worst
window, and the post says the trigger was customer content
([Cloudflare](https://blog.cloudflare.com/incident-report-on-memory-leak-caused-by-cloudflare-parser-bug/)).
Two 2025 outages were not attacks: the 12 June Workers KV outage, which the post says "lasted 2
hours and 28 minutes" while its own timeline runs 17:52 to 20:28 UTC
([post](https://blog.cloudflare.com/cloudflare-service-outage-june-12-2025/)), and the 18 November
outage, which came from a database permissions change that doubled a feature file past a proxy limit
([post](https://blog.cloudflare.com/18-november-2025-outage/)). Drupflare's design answer is that a
site keeps serving with the control plane gone. It cannot keep serving with Cloudflare gone.

### Supply Chain

Composer packages and the interpreter's own dependencies run as code in every host. The PHP
project reverted two malicious commits to its source repository in March 2021 before any release
carried them ([php.net](https://www.php.net/archive/2021.php)). The same risk applies to a Composer
package or an interpreter dependency here as anywhere.

What v1.0.4 adds is a digest check at install. `packages.drupal.org` publishes a SHA-1 `dist.shasum`
on every release of the three modules checked (23, 24 and 58 of 58) and an archive downloaded from
`ftp.drupal.org` matched it. A package that carries a digest is checked before it is unpacked, and a
mismatch refuses the install even with `force=1`. Packagist publishes an empty string for all 189,
91 and 499 releases checked of three packages, so those install unverified and the result says
`verified: false`. The check guards a swapped or corrupted archive, not a registry that lies in both
its metadata and its archive. Packagist trust is `open` and needs a different root, such as a signed
lock (`L`). The first release of a malicious package is `open` on every host. The fetched
interpreter is checked against its pinned digest and, once the attestation step has run, against
phasm's build provenance.

### Cost as an Attack and Visibility

No primary source on denial of wallet was found. The project's own rig has seen the mechanism: a
bench site driven all night used 103.8% of its daily row quota and went read-only, so every login
answered 503 (`CLAUDE.md`, measured). A busy site on the free plan can be degraded by traffic. This
is `open`. There is also no host disk image and no host log to examine after an incident, so
forensics rest on Workers observability events and the owner audit log's anchor lines.

### State That Survives Between Requests

A warm Durable Object keeps its interpreter between requests, and static state in PHP survives.
Four cases are documented in this repository: an AJAX flag that randomised every later element id,
an entity access cache that kept an unpublished node readable by anonymous visitors, a cached
local-task list that rendered one node's tabs on another, and a `file_save_upload()` function static
that handed one user's uploaded file to the next upload to the same field. Each was found and fixed,
and each had no signal until a test looked for it
(`CLAUDE.md`, "The boundary sweep walks services now"). This class is specific to a persistent
runtime. A request-per-process server such as PHP-FPM resets it by design.

## The CVE and Incident Map

Each row maps a published vulnerability or incident to what an attacker needs on a conventional
host and what changes inside a Drupflare site. The verdicts are Inferred from the architecture
above. No exploit was run against a Drupflare site. The verdict words are defined under
[How to Read the Claims](#how-to-read-the-claims).

| Id                                                                                                                                                                     | Year       | Class                                          | Verdict   | Reason                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| [CVE-2014-3704](https://www.drupal.org/sa-core-2014-005)                                                                                                               | 2014       | SQL injection, Drupal 7 core                   | open      | Reads the same database                                                                                                   |
| [CVE-2018-7600](https://www.drupal.org/sa-core-2018-002)                                                                                                               | 2018       | Unauthenticated RCE, Drupal core               | contained | PHP runs in the sandbox; no shell for the observed miner payload (CVSS 9.8)                                               |
| [CVE-2018-7602](https://www.drupal.org/sa-core-2018-004)                                                                                                               | 2018       | RCE, Drupal 7 and 8                            | contained | As CVE-2018-7600                                                                                                          |
| [CVE-2019-6340](https://www.drupal.org/sa-core-2019-003)                                                                                                               | 2019       | RCE through REST input                         | contained | PHP runs in the sandbox                                                                                                   |
| [CVE-2020-13663](https://www.drupal.org/sa-core-2020-004)                                                                                                              | 2020       | CSRF in Form API                               | open      | Browser-side flaw                                                                                                         |
| [CVE-2026-108097](https://www.drupal.org/sa-core-2026-014)                                                                                                             | 2026       | RCE in Field UI, Drupal core                   | contained | PHP runs in the sandbox; lock pins 11.4.10, the fixed release                                                             |
| [CVE-2019-11043](https://nvd.nist.gov/vuln/detail/CVE-2019-11043)                                                                                                      | 2019       | PHP-FPM buffer underflow via nginx             | removed   | No FPM, no nginx, no FastCGI socket                                                                                       |
| [CVE-2024-4577](https://nvd.nist.gov/vuln/detail/CVE-2024-4577)                                                                                                        | 2024       | PHP-CGI argument injection, Windows            | removed   | Needs the CGI SAPI on Windows with Apache                                                                                 |
| [CVE-2014-6271](https://nvd.nist.gov/vuln/detail/CVE-2014-6271)                                                                                                        | 2014       | Shellshock, Bash through CGI                   | removed   | No Bash and no CGI                                                                                                        |
| [CVE-2021-41773](https://nvd.nist.gov/vuln/detail/CVE-2021-41773)                                                                                                      | 2021       | Apache 2.4.49 path traversal                   | removed   | No Apache and no filesystem to traverse                                                                                   |
| [CVE-2016-3714](https://nvd.nist.gov/vuln/detail/CVE-2016-3714)                                                                                                        | 2016       | ImageMagick delegate shell injection           | removed   | No ImageMagick; no process to spawn                                                                                       |
| [CVE-2023-4966](https://nvd.nist.gov/vuln/detail/CVE-2023-4966)                                                                                                        | 2023       | CitrixBleed, edge appliance memory             | removed   | No appliance in the tenant's path                                                                                         |
| [CVE-2014-0160](https://nvd.nist.gov/vuln/detail/CVE-2014-0160)                                                                                                        | 2014       | Heartbleed, OpenSSL                            | removed   | PHP has no OpenSSL; TLS ends at Cloudflare                                                                                |
| [CVE-2026-7261](https://nvd.nist.gov/vuln/detail/CVE-2026-7261)                                                                                                        | 2026       | PHP SoapServer use-after-free                  | removed   | ext/soap is not compiled in (no `SoapServer` string in the binary)                                                        |
| runc [CVE-2019-5736](https://nvd.nist.gov/vuln/detail/CVE-2019-5736), [CVE-2024-21626](https://github.com/opencontainers/runc/security/advisories/GHSA-xr7r-f8xq-vfvv) | 2019, 2024 | Container runtime escape                       | removed   | The tenant has no container runtime; the platform does                                                                    |
| [CVE-2022-0847](https://nvd.nist.gov/vuln/detail/CVE-2022-0847), [CVE-2016-5195](https://nvd.nist.gov/vuln/detail/CVE-2016-5195)                                       | 2022, 2016 | Linux kernel privilege escalation              | removed   | Needs a local process on a Linux kernel the tenant can reach                                                              |
| [CVE-2026-109618](https://github.com/php/php-src/security/advisories/GHSA-w8hw-w9fx-j79w)                                                                              | 2026       | RCE via OOM corruption, PHP                    | removed   | The chain needs a request startup and shutdown cycle and a `memory_limit` bailout, and neither exists here                |
| [CVE-2026-109619](https://github.com/php/php-src/security/advisories/GHSA-6wmf-4rv5-p3rp)                                                                              | 2026       | RCE via stale global state, PHP                | removed   | The consumers run at request startup, which does not happen per request here, and no request memory is freed between runs |
| [php-src malicious commits](https://www.php.net/archive/2021.php)                                                                                                      | 2021       | Source supply chain                            | open      | A bad commit reaching a build is the same risk on any host                                                                |
| [Shai-Hulud npm worm](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem)                                   | 2025       | Trojaned releases through hijacked maintainers | open      | The class applies to any registry; the build and publish hosts run `postinstall`                                          |
| [Spectre on Workers](https://blog.cloudflare.com/revisiting-spectre-attacks-on-workers/)                                                                               | 2026       | Co-tenant timing leak                          | open      | Platform mitigations apply; not complete by Cloudflare's own statement                                                    |
| [Cloudbleed](https://blog.cloudflare.com/incident-report-on-memory-leak-caused-by-cloudflare-parser-bug/)                                                              | 2017       | Edge memory disclosure                         | open      | Platform-side; a tenant cannot prevent it                                                                                 |
| [Check Point workerd research](https://research.checkpoint.com/2026/when-agentic-glue-melts/)                                                                          | 2026       | Engine memory bugs, KV authorizer bypass       | open      | Cloudflare says fixed in production with no date; the local build refuses the rename, which is not the platform           |
| CVE-2026-87491 (CISA known-exploited catalog)                                                                                                                          | 2026       | V8 out-of-bounds write                         | open      | The entry names Chrome; whether the Workers build is affected was not established                                         |

## Classes Addressed in v1.0.4

The map above is about published incidents. This table is about attack classes a code-execution
foothold could use, with the verdict before and after the v1.0.4 work. Each "after" names its
evidence and its residual.

| Class                                                  | Before | After     | Evidence                                                               | Residual                                                                             |
| ------------------------------------------------------ | ------ | --------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Owner and git credentials readable through SQL         | open   | contained | Measured, local `workerd`; [Credentials](#credentials-and-persistence) | Account holder; a pre-upgrade restore point; hosted rename fix undated               |
| Planted module row survives a restart                  | open   | contained | Measured, local `workerd`                                              | Unclaimed sites, replica lanes, other SQL-resident paths                             |
| Planted heap image restored on boot                    | open   | contained | Measured: restored by default before, refused after                    | SQL write can delete images (a boot of cost)                                         |
| PHP opens a raw socket through the glue                | open   | removed   | Measured, node: 3 constructed, 0                                       | None known; the `cfw*` list is the only route out                                    |
| PHP calls a JavaScript global through vrzno            | open   | removed   | Measured, node: 3 recorded calls, 0                                    | `cfw*` functions callable with any argument; a `TypeError` ends an invocation        |
| Outbound guard bypass by spelling                      | open   | contained | Measured, unit                                                         | Public name resolving to a private address; hosted link-local reach unmeasured       |
| Oversized chunked or multipart body                    | open   | contained | Measured, `serve-edge.spec.ts`                                         | Platform 100 MB limit still the outer bound                                          |
| A page stored for one visitor served to all            | open   | contained | Measured: stock pack varies nothing; modules that vary are not stored  | A module varying by something other than the four named headers                      |
| Module headers dropped before a browser                | open   | contained | Measured, every tier                                                   | R2 mirror carries none (`L`)                                                         |
| Plugin embedding and clickjacking                      | open   | contained | Measured: header sent in report-only; no browser run                   | Script injection needs a strict policy (`L`); a Drupal admin can remove the baseline |
| PHP2Shell interim mitigations                          | open   | contained | Measured: values read back from the interpreter                        | Package updated to 8.5.12; chains have no path here regardless                       |
| Stale write in the park extension                      | open   | removed   | Measured: native 21/1 without the fix, 22/0 with                       | Present in every interpreter built before the fix                                    |
| Swapped Composer archive                               | open   | contained | Measured: drupal.org digests present and verified                      | Packagist installs unverified                                                        |
| Interpreter below the PHP floor ships                  | open   | contained | Measured: `inspect-build.sh` fails below the pin                       | The attestation step has not run against a real attestation                          |
| Tenant switches the outbound guard off                 | open   | removed   | Measured: four spellings refused from PHP, the owner route and KV      | An operator can still set it in the environment                                      |
| Owner action leaves no trace                           | open   | contained | Measured: chain verifies and tamper is caught                          | Evidence against a site-level attacker only; PITR rewinds the log                    |
| `RESPONSE_HEADERS` removes the CSP baseline            | open   | open      | Read: writable from the PHP settings form                              | A maintainer decision                                                                |
| `cfw_meta` authority keys (`git_remotes`, claim, OIDC) | open   | open      | Read: [Credentials](#credentials-and-persistence)                      | Moving them is `M`                                                                   |
| Planted row on a replica lane                          | open   | open      | Read: lanes hold no records                                            | `L`                                                                                  |

## PHP2Shell

PHP2Shell is the name given to two critical remote code execution vulnerabilities in PHP,
CVE-2026-109618 and CVE-2026-109619, published on 2026-10-21 and fixed in PHP 8.5.12, 8.4.27,
8.3.36 and 8.2.35. This section says what the advisories require, what the shipping interpreter does
about each requirement. The result: the published PHP2Shell chains do not work against a Drupflare
site, and the map marks both `removed`. The reason is the lifecycle described below. The sandbox is
not the reason, because WebAssembly does not stop corruption inside the module.

### What the Advisories Say

CVE-2026-109618, "RCE via OOM corruption"
([GHSA-w8hw-w9fx-j79w](https://github.com/php/php-src/security/advisories/GHSA-w8hw-w9fx-j79w)):
"PHP uses `longjmp()` for out-of-memory (OOM) errors to exit the current context and abort handling
of the request", and "does not properly account for the early exit and leaves the request memory in
an invalid state". Request shutdown then reads that state. The validated exploit is against Apache
mod_php, where body parsing at request startup can exhaust `memory_limit` and shutdown still runs.
For PHP-FPM the advisory says "no complete FPM exploit has been demonstrated".

CVE-2026-109619, "RCE via stale global state"
([GHSA-6wmf-4rv5-p3rp](https://github.com/php/php-src/security/advisories/GHSA-6wmf-4rv5-p3rp)):
state owned by one request survives after its memory is freed, and a later operation on the same
worker reads it before normal initialization resets it. The exploit needs a producer, which is a fatal
error, timeout or OOM that skips a reset, and a consumer that runs before initialization. The
confirmed consumers are INI diagnostics raised while settings are applied and session upload
progress. The confirmed producer on PHP 8.5 is `fatal_error_backtraces`.

Both are CVSS v4 9.2, unauthenticated and network reachable. PHP's announcement says "there are no
complete mitigations, updating is the only safe choice" and names PHP-FPM, Apache with mod_php,
php-cgi, FrankenPHP and LiteSpeed as at risk
([php.net](https://www.php.net/archive/2026.php#2026-10-21-5)). It does not address embedded SAPIs.
Wiz reports working exploits on standard SAPIs against WordPress, Drupal and Joomla, including one
against Drupal that uses the fatal-error backtrace state
([Wiz](https://www.wiz.io/blog/php2shell-php-rce)).

### What the Shipping Interpreter Does

| Fact                                                                                      | Value                                                                   | Basis                                                       |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| PHP version                                                                               | 8.5.12                                                                  | Measured: `tests/integration/interpreter-lifecycle.spec.ts` |
| SAPI                                                                                      | `embed`                                                                 | Measured                                                    |
| A fatal error in one run leaves `$GLOBALS` and `error_get_last()` visible to the next run | yes                                                                     | Measured                                                    |
| Multipart bodies parsed by PHP's request startup                                          | no, parsed in userland                                                  | Measured: `tests/integration/multipart-submit.spec.ts`      |
| `USE_ZEND_ALLOC`                                                                          | `0`, the system allocator                                               | Measured                                                    |
| `memory_limit` enforced                                                                   | no: an 8M cap held 40 MB                                                | Measured, on 8.5.2; not repeated on 8.5.12                  |
| Where PHP 8.5.12 checks `memory_limit`                                                    | inside `zend_mm` paths a custom heap bypasses                           | Read: php-src `PHP-8.5.12` `Zend/zend_alloc.c`              |
| `malloc` failure under the system allocator                                               | `exit(1)`, no bailout                                                   | Read: the same file (8.5.2 was not diffed)                  |
| `session.upload_progress.enabled`, `fatal_error_backtraces`                               | both `0` at boot; `fatal_error_backtraces` can be set back by user code | Measured: read back from the interpreter                    |
| `file_uploads`, `expose_php`, `allow_url_include`                                         | all `0`                                                                 | Measured                                                    |
| OPcache                                                                                   | loaded, `opcache.enable=0`                                              | Measured                                                    |
| `soap`, `phar`                                                                            | not compiled in                                                         | Measured                                                    |

The two settings PHP lists as interim mitigations are off at boot, and the analysis below does not
depend on them. `session.upload_progress.enabled` is a per-directory setting that `ini_set` cannot
change, so boot is the only place it could be set. `fatal_error_backtraces` is a default and not a
ceiling, because user code can set it back.

### What Follows and What Does Not

These are Inferred from the table.

- The CVE-2026-109618 chain that was demonstrated starts at request startup and ends in request
  shutdown. This runtime runs code through `pib_run` inside one retained request and performs
  neither per request. Its allocator does not enforce `memory_limit`, so the `longjmp()` the
  advisory describes has no limit to fire on, and allocation failure ends the instance through
  `exit(1)` instead of leaving partial state behind.
- The CVE-2026-109619 consumers run before a request's normal initialization: per-request INI
  application and the upload-progress handler inside multipart startup. Neither happens per
  request here. A producer does leave state behind, but request memory is never freed between
  runs, so a stale pointer aims at live memory and not at reclaimed memory.

Neither published chain has a path in this runtime, which is the decision recorded in the map. The
interpreter is rebuilt at 8.5.12, because it contained the vulnerable code at 8.5.2 and PHP says
updating is the only complete mitigation. A retained request can also keep per-extension state
across a fatal error that a request shutdown would reset. That is a logic hazard, of the kind
documented in [State That Survives Between Requests](#state-that-survives-between-requests), and not
a use-after-free, because request memory is never freed between runs. What would reverse the
decision is a working chain against this runtime. The public write-ups use standard SAPIs and
report none.

## How Much Safer

No study compares breach outcomes for serverless and server hosting. The attack-surface literature
(Manadhata and Wing, IEEE TSE 2011, and Howard's relative attack surface quotient) defines how to
count entry points and capabilities, and neither measures this pair. The vendor surveys searched
quote percentages that were read only through summaries, so none is repeated here.

What can be counted is the two tables above. Every sentence on this page that says Drupflare is more
resistant than a VPS to a class is Inferred from the architecture until the three-arm comparison
below has a result.

The incident map's 24 rows carry these verdicts:

| Verdict   | Rows | Meaning                                                                       |
| --------- | ---- | ----------------------------------------------------------------------------- |
| removed   | 12   | The attack path needs a component the object lacks                            |
| contained | 4    | The flaw runs; the sandbox limits the reach                                   |
| open      | 8    | The flaw works as it does anywhere, or it could not be established either way |

The v1.0.4 class table has 19 rows: 4 move from `open` to `removed`, 12 to `contained`, and 3 stay
`open`. Read the `removed` counts as statements about classes of server takeover and published exploit chains, and do not read
them as a breach probability. The incident rows were chosen from incidents that reached the attacker's goal on conventional
PHP hosting, so the selection favours the classes this architecture removes. None of the six Drupal
advisories in the map is `removed`: each is `contained` or `open`, because Drupal's own bugs
run inside the sandbox. Sophos's 2025 education survey reports that higher education providers were
more likely to be attacked through exploited vulnerabilities (35%), from 441 respondents across
lower and higher education
([Sophos](https://www.sophos.com/en-us/blog/the-state-of-ransomware-in-education-2025)). The
figure concerns the entry vector and says nothing about the host.

The measurable form of the claim is a comparison of authority retained after the same exploit. The
planned experiment runs one pinned vulnerable Drupal against three arms (a minimally configured
VPS, a hardened container and Drupflare) with a fixed list of post-exploitation actions, and
publishes how many each arm blocked.

## Planned Work

Items marked shipped are in the v1.0.4 working tree and measured as stated above. Everything else is
not built.

| Item                                                                      | Closes                                           | Size | State           |
| ------------------------------------------------------------------------- | ------------------------------------------------ | ---- | --------------- |
| Security headers, module-set headers, CSP baseline and report route       | Missing headers; Security Kit headers dropped    |      | v1.0.4, shipped |
| Owner credentials and heap and module integrity records in sealed storage | Plaintext token; planted persistence             |      | v1.0.4, shipped |
| Host import census gate, socket and vrzno closure, boot ini               | A new import joining the surface unreviewed      |      | v1.0.4, shipped |
| Owner audit log and `drangler audit`                                      | Owner actions leaving no trace                   |      | v1.0.4, shipped |
| `SECURITY.md` and a reporting route for researchers                       | A documented disclosure path                     |      | v1.0.4, shipped |
| Drupalgeddon 2 against three arms                                         | The comparison above, first case                 | XL   | not built       |
| Egress allow-list per site                                                | Open egress                                      | L    | v1.1            |
| Fleet security-release rollout, owner patching with rollback              | Manual PHP and Drupal patch delivery             | XL   | v1.1            |
| Integrity records carried to replica lanes                                | A planted row on the primary reaching lanes      | L    | not built       |
| Page mirror carries module headers                                        | R2 pages without headers                         | L    | not built       |
| Packagist digest trust (a signed lock)                                    | Packagist installs unverified                    | L    | not built       |
| Strict `script-src` with nonces                                           | Script injection under the baseline              | L    | not built       |
| `cfw_meta` authority keys out of SQL                                      | `git_remotes`, claim window, OIDC keys           | M    | not built       |
| An EXPLAIN-based host-table policy at the SQL bridge                      | SQL access to host-owned tables                  | M-L  | not built       |
| Browser-lane proof of the CSP baseline, then `form-action`                | A baseline no browser has loaded                 | M    | not built       |
| A deployed probe for `process.env`, `Function` and link-local reach       | Three platform claims that were not measured     | S    | not built       |
| An audit entry for the first claim and a restore entry after PITR         | Two gaps in the audit log                        | S-M  | not built       |
| An owner action that adopts a package's current module rows               | A re-imported migrated site's code being refused | M    | not built       |
| `--source-ref` on the attestation check                                   | A feature branch build verifying                 | S    | not built       |
| Advisory checks for the other ten runtime packages                        | Unchecked npm dependencies                       | S    | not built       |
| The full three-arm comparison                                             | The unmeasured claim                             | XL   | v1.1            |

## References

Read on 2026-10-21 and 2026-10-22 unless noted.

1. Cloudflare, Workers security model: <https://developers.cloudflare.com/workers/reference/security-model/>
2. Cloudflare, "A revisit of remote Spectre attacks on Cloudflare Workers", 2026-08-19: <https://blog.cloudflare.com/revisiting-spectre-attacks-on-workers/>
3. Schwarzl et al., "Remote-Timer-as-a-Service", arXiv:2608.17043 (abstract only): <https://arxiv.org/abs/2608.17043>
4. Cloudflare, Cloudbleed incident report, 2017-02-23: <https://blog.cloudflare.com/incident-report-on-memory-leak-caused-by-cloudflare-parser-bug/>
5. Cloudflare, 12 June 2025 service outage: <https://blog.cloudflare.com/cloudflare-service-outage-june-12-2025/>
6. Cloudflare, 18 November 2025 outage: <https://blog.cloudflare.com/18-november-2025-outage/>
7. Lehmann, Kinder and Pradel, "Everything Old is New Again: Binary Security of WebAssembly", USENIX Security 2020 (abstract): <https://www.usenix.org/conference/usenixsecurity20/presentation/lehmann>
8. Stiévenart, De Roover and Ghafari, "The Security Risk of Lacking Compiler Protection in WebAssembly", arXiv:2111.01421 (abstract): <https://arxiv.org/abs/2111.01421>
9. WebAssembly security documentation: <https://webassembly.org/docs/security/>
10. Google Threat Intelligence Group, "2025 Zero-Days in Review", 2026-03-05: <https://cloud.google.com/blog/topics/threat-intelligence/2025-zero-day-review/>
11. PHP project, security advisory 2026-10-21 (CVE-2026-109618, CVE-2026-109619) and the two php-src advisories GHSA-w8hw-w9fx-j79w and GHSA-6wmf-4rv5-p3rp: <https://www.php.net/archive/2026.php#2026-10-21-5>
12. Wiz, "PHP2Shell: AI uncovers critical RCE vulnerabilities" (read once through a page extractor): <https://www.wiz.io/blog/php2shell-php-rce>
13. Drupal security advisories SA-CORE-2014-005, 2018-002, 2018-004, 2019-003, 2020-004 and 2026-014: <https://www.drupal.org/security>
14. NVD records for the CVE identifiers in the map: <https://nvd.nist.gov/>
15. PHP project, 2021 archive (malicious commits, 2021-03-30): <https://www.php.net/archive/2021.php>
16. Sophos, "The State of Ransomware in Education 2025": <https://www.sophos.com/en-us/blog/the-state-of-ransomware-in-education-2025>
17. workerd README, "WARNING: workerd is not a hardened sandbox": <https://github.com/cloudflare/workerd>
18. Check Point Research, workerd and Code Mode research, 2026-08-07 (read as an extract): <https://research.checkpoint.com/2026/when-agentic-glue-melts/>
19. CISA, "Widespread supply chain compromise impacting npm ecosystem", 2025-09-23 (extract): <https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem>
20. Cloudflare, Durable Object platform limits (key and value size): <https://developers.cloudflare.com/durable-objects/platform/limits>
