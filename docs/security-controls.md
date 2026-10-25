# Security Controls

What Drupflare provides today, control by control: the host surface, the request path, outbound requests, uploads, credentials, response headers, the build and patching. The claims and their labels are on [Security](security.md).

## Host Surface

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

## Request Path

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

## Outbound Requests

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
[Data in the Same Object](security.md#data-in-the-same-object)).

## Uploads and Request Parsing

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

## Credentials and Persistence

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

- **Unclaimed sites.** Not held, because a migrated site's code arrives as rows before the claim.
  The first mount after the claim adopts the rows as they stand, so a site compromised before the
  upgrade stays compromised.
- **Replica lanes.** Not checked. A planted row on the primary still reaches them (`L`).
- **Other database-resident paths.** The compiled container row in `cache_container`,
  `unserialize` of stored data, `cfw_package_autoload`, `cfw_module_blob` until a revision applies
  it, and `/__moduleasset`, which serves a stored text file to a browser without a record check.
- **Imports.** An import brings module rows with no records, so they are refused until the owner
  redelivers the package through `/modify`, `/install` or `/git`.

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

## Response Headers

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

## The Build

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
workflow. The workflow step itself has not run against a real attestation; the one real artifact checked with the command is under [Patching](#patching).

## Patching

Cloudflare patches V8 and the platform. Drupal core and the PHP interpreter are the project's to
patch, and that path has a manual step. A new interpreter build travels from `phasm` to a pull
request in this repository and ends there. The workflow has no deploy step, and a person merges,
releases and deploys (`docs/php-update-delivery.md`). The pin records `.interp/php8.5.wasm` with its
sha256.

The interpreter in the tree reports PHP 8.5.12, the first 8.5 release that carries the PHP2Shell
fixes (Measured: `interpreter-lifecycle.spec.ts` asserts `PHP_VERSION >= 8.5.12`). The advisory was
published 2026-10-21 13:34 UTC. A local rig build that passes the park, heap and static-sweep specs
finished 31 hours 39 minutes after it, and the attested CI artifact (phasm run 39861586180, artifact
12463245201, `gh attestation verify` exit 0) was created 32 hours 35 minutes after it. The advisory
time is read from the PHP announcement; the build times come from the rig log and the workflow run
record. That is one interval on one build, not a rate. Deployed sites move only when someone
publishes the artifact, merges the pin and deploys. The root `composer.lock` pins Drupal core 11.4.10, the fixed release for the 11.4 line of SA-CORE-2026-014.

Rebuilding found a defect in `phasm`'s own park extension. When a parked chain completes after a
resume, the root frame's `return_value` still pointed at a C local of `zend_eval_stringl` that the
`longjmp` had destroyed, so the final `ZEND_RETURN` wrote a 16-byte zval onto whatever the resuming
stack held. On 8.5.2 the bytes were dead and nothing showed. On 8.5.12 the write corrupted the
dispatch state and the next call trapped. The extension now points the root at a slot it owns
(`park_pin_root()` in `cfwpark.c`). The fix is covered natively (22 pass with the fix; 21 pass and
1 fail without it) and by `park-interpreter.spec.ts`. It matters here because it is a memory-safety bug in
code the project wrote, reachable only on a site that arms the park (`REDIS_URL` set, or an OIDC or
other outbound fetch that parks).
