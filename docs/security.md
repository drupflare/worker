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

Every statement is tagged with how it was established.

| Tag      | Meaning                                                                          |
| -------- | -------------------------------------------------------------------------------- |
| Read     | The source file or the primary document was read, and the line or quote is cited |
| Measured | A command was run against the shipping build, and the command is given           |
| Inferred | It follows from the architecture and nothing was run against it                  |
| Unknown  | It could not be established, and the page says what would settle it              |

No study measures how much a serverless or sandboxed runtime lowers breach probability. The page
does not put a percentage on safety. It counts attack classes instead, and the count is only as good
as the inference behind each row (see [How Much Safer](#how-much-safer)).

Sources were read on 2026-10-21. The quotes from Cloudflare's security model and Spectre post,
SA-CORE-2026-014, the Lehmann and Stiévenart abstracts and the GTIG report were checked a second
time against the live page. The rest were read once through a page extractor, so
check the live page before quoting one to a third party. Cloudflare's pages and the PHP and Drupal
advisories change.

## What Is Claimed and What Is Not

| Claim                                                                                         | Status                                                                |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| There is no operating system, shell, web server or PHP-FPM pool in the site's trust boundary  | Read: [layers](#the-layers)                                           |
| A PHP exploit runs inside WebAssembly linear memory and reaches the host only through imports | Read: webassembly.org security page                                   |
| Cloudflare states a V8 patch gap under 24 hours                                               | Read: Cloudflare security model                                       |
| Server-takeover classes (FPM, CGI, Shellshock, Apache, container and kernel escapes) are gone | Inferred: [map](#the-cve-and-incident-map)                            |
| Arbitrary code execution is impossible                                                        | False. Any Drupal RCE runs PHP in the sandbox                         |
| A compromised PHP cannot read the site's own data                                             | False. The database sits in the same object                           |
| WebAssembly makes memory corruption harder to exploit than native                             | False. See [Memory Corruption](#memory-corruption-inside-the-sandbox) |

## The Layers

A request passes through these layers, from the attacker's side inward.

| Layer                       | What it is                                                        | Source                        |
| --------------------------- | ----------------------------------------------------------------- | ----------------------------- |
| Drupal and contributed code | Application authorization, SQL, templates                         | the site itself               |
| PHP, compiled to wasm       | The interpreter in WebAssembly linear memory, built by `phasm`    | `interp.lock.json`            |
| Glue and host functions     | 103 JavaScript imports from the module, plus the `cfw*` functions | [Host Surface](#host-surface) |
| V8 isolate in workerd       | The JavaScript sandbox that holds the module and the glue         | Cloudflare docs               |
| Cloudflare process sandbox  | Linux namespaces and seccomp around the process                   | Cloudflare docs               |
| Cloudflare's hosts          | The machine, which belongs to the platform                        | not in scope                  |

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

The shipping module, `.interp/php8.5.wasm` as pinned in `interp.lock.json`, imports 103 functions,
all from `env` and `wasi_snapshot_preview1`, and the tuned copy derived from it imports 104
(Measured: compile the file with `new WebAssembly.Module` and read `WebAssembly.Module.imports()`).
They are Emscripten's libc layer, and what each one can do is decided by the glue that implements
it. `posix_spawnp` is a stub that aborts (`.interp/php8.5-worker.mjs`, "missing function:
posix_spawnp"), so there is no fork, no exec and no process table.

The `cfw*` host functions are the intended capability set (`src/do/capabilities.ts`,
`src/ops/park-drive.ts`, `src/ops/tcp.ts`, Read):

| Function                      | What it reaches                                           | Limit                                                                   |
| ----------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `cfwSqlExec`, `cfwSqlTxn`     | Any SQL on the site's own Durable Object SQLite           | It is Drupal's own database connection                                  |
| `cfwFetch`                    | The fetch cache only; a miss queues a request and returns | No synchronous network by construction                                  |
| `cfwQueueFetch`, park `fetch` | Any public HTTP(S) URL, with PHP's headers and body       | Deny-list for private and metadata hosts, applied to every redirect hop |
| `cfwTcp`, park `socket`       | Redis and syslog at the endpoint the operator configured  | PHP names no host; port must match the configured endpoint              |
| `cfwMail`                     | A message queued through the site's mail transport        | From-domain check and size caps                                         |
| `cfwFile*`                    | The site's own file tables                                | `..` rejected; flat keyspace inside one object                          |
| `cfwSettings`                 | Allow-listed levers                                       | `PLAN` is refused; writes are scoped to the site                        |
| image, zlib, signing, hashing | Computation in JavaScript inside the object               | Canvas and operation caps                                               |

No host function names the `SITE` namespace, the fleet D1 database or `CONFIG_KV` directly, so PHP
cannot address another site's object, the fleet table or raw KV (Read, by search of the install
path; Inferred as a boundary because a search proves absence only for the code searched).

Shell functions go through a router in the `drupflare` module (`src/Exec/Commands.php`) that serves
a fixed program list, including `echo`, `zip`, `curl` and `wget`, and refuses pipes, redirection
and every other program. The router is a compatibility layer written in PHP. It decides what
ordinary PHP code can do. The property that matters for an attacker is different: the wasm module
has no process to fork or exec into, because `posix_spawnp` aborts and there is no kernel.

### Request Path

| Control                                    | Where it is enforced                                                           | Strength                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `__` object routes answer 404 from outside | front worker, `src/site/entry.ts:174`                                          | route table                                              |
| Owner routes need the owner token          | front worker, `src/site/owner.ts`; object check in `src/do/routes/auth.ts:233` | policy check                                             |
| Failed-token budget, 12 per 60 s per IP    | front worker, `src/ops/admin-session.ts:71-114`                                | policy check; in memory, not a brute-force defence       |
| `?site=` ignored on visitor routes         | front worker, `src/site.ts:65`                                                 | policy check                                             |
| Forged `x-cfw-*` headers stripped          | `src/ops/forwarded-headers.ts:32`                                              | policy check                                             |
| Request body capped at 2 MiB               | `src/site/guards.ts:62-93`                                                     | policy check                                             |
| `PLAN` cannot be written by a tenant       | `src/ops/plan.ts:148-154`                                                      | policy check                                             |
| One Durable Object per site, id from host  | `src/ops/site-id.ts:26`                                                        | naming convention plus the platform's per-object storage |

A hard boundary is one where the host has no such function. A policy check is one where the
function exists and a list or a flag decides. The distinction matters for an attacker who can
change what PHP asks for, because a policy check is a decision about that request and a missing
function is not.

### Uploads and Request Parsing

PHP's multipart handling is not entered for an inbound request. No SAPI delivers the request: the
render fragment receives the method, body and cookies as arguments, parses multipart by hand and
builds `UploadedFile` objects in userland (`src/site/php/pw-serve-inline.php:134-223`), and
`$_FILES` is empty (`:323`). Nothing in `worker/src` or `phasm/src` calls `php_request_startup`,
`sapi_activate` or `php_default_treat_data`, and `pib_run` runs no request-startup cycle (Read).

The C-level answer is Inferred, not Measured, because php-src is fetched at build time and is not in
the repository. A regression test that posts a multipart body and asserts that PHP's own upload
handling never runs would turn the inference into a measurement (see
[Planned Work](#planned-work)).

### Response Headers

Until v1.0.3, the front worker sent none of `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Strict-Transport-Security` or `Content-Security-Policy` on a Drupal page. The
render fragment forwards only `x-drupal-*` headers, so core's own `X-Content-Type-Options` and
`X-Frame-Options` never reached a browser.

The v1.0.4 line sends `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` and
`Referrer-Policy: strict-origin-when-cross-origin` on every response the Worker answers, and
`Strict-Transport-Security: max-age=31536000` over https (`src/ops/edge-rules.ts`). A
`RESPONSE_HEADERS` rule replaces or removes any of them. There is no default
`Content-Security-Policy`, because core's own pages use inline script and style.

Two limits remain. Headers a Drupal module sets, such as Security Kit's, are not forwarded. Static
files served by the asset layer (`/core`, `/modules`, `/themes`, `/agg`) carry cache rules and none
of these headers.

### The Build

The shipping interpreter is built by `phasm`, which drives `seanmorris/php-wasm`'s Makefile with an
rc file per variant. The Makefile sets `TOTAL_STACK=32MB`. The extension list is short. `soap`, `phar`, `intl`, `gd`, `openssl`, `exif` and `sqlite` are not
compiled in (`WITH_*` settings in `long64.rc`; the binary contains no `SoapServer` string, Measured
with `grep -a -c`). Every extension left out is an extension its bugs cannot reach.

### Patching

Cloudflare patches V8 and the platform. Drupal core and the PHP interpreter are the project's to
patch, and that path has a manual step. A new interpreter build travels from `phasm` to a pull
request in this repository and ends there. The workflow has no deploy step, and a person merges,
releases and deploys (`docs/php-update-delivery.md`). The pin records `.interp/php8.5.wasm` with its
sha256.

The interpreter reports PHP 8.5.2 (`CLAUDE.md`, measured on `.interp/php8.5.wasm`; `phasm/README.md`).
Every PHP security release since then reaches a deployed site only through that pipeline. The
root `composer.lock` pins Drupal core 11.4.10, the fixed release for the 11.4 line of
SA-CORE-2026-014.

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
  instance, and uploads live in the site's own file tables.

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

### Data in the Same Object

Code execution inside the sandbox reads and writes the whole site database, which is in the same
object. Egress is open by design:
`cfwQueueFetch` sends any public HTTP(S) request PHP builds, because the legitimate set (update
servers, OIDC providers, webhooks) is open-ended. The deny-list protects private and metadata
addresses and does not stop a site's own data leaving to a public host.

### Co-Tenancy and Side Channels

Cloudflare runs many isolates in one process. On 2026-08-19 it published a revisit of remote Spectre
attacks on Workers, reporting a leak of "up to 12 bit/s with an accuracy of more than 99%" of a JWT
a researcher placed in a co-located Worker. It adds that "The V8 sandbox is not a complete Spectre
mitigation" and "MPK is not a complete answer to remediate Spectre, but it strictly reduces the
leakage surface". It lists frozen timers, no shared memory, detection, memory shuffling, process
isolation for suspicious scripts, the V8 sandbox and in-process isolation with memory protection
keys, deployed in September 2025
([Cloudflare](https://blog.cloudflare.com/revisiting-spectre-attacks-on-workers/); paper
[arXiv:2608.17043](https://arxiv.org/abs/2608.17043), abstract only). A site that holds a secret in a
Durable Object is exposed to this class on any shared platform. The mitigations are Cloudflare's.

### Platform Failure and Concentration

A bug in Cloudflare's own software reaches every tenant. Cloudbleed (2017) leaked memory from
Cloudflare's HTML parser into responses for about 1 in every 3,300,000 requests during its worst
window, and the post says the trigger was customer content
([Cloudflare](https://blog.cloudflare.com/incident-report-on-memory-leak-caused-by-cloudflare-parser-bug/)).
Two 2025 outages were not attacks: the 12 June Workers KV outage lasted 2 hours 28 minutes
([post](https://blog.cloudflare.com/cloudflare-service-outage-june-12-2025/)), and the 18 November
outage came from a database permissions change that doubled a feature file past a proxy limit
([post](https://blog.cloudflare.com/18-november-2025-outage/)). Drupflare's design answer is that a
site keeps serving with the control plane gone. It cannot keep serving with Cloudflare gone.

### Supply Chain

Composer packages and the interpreter's own dependencies run as code in every host. The PHP
project reverted two malicious commits to its source repository in March 2021 before any release
carried them ([php.net](https://www.php.net/archive/2021.php)). The same risk applies to a Composer
package or an interpreter dependency here as anywhere.

### Cost as an Attack and Visibility

No primary source on denial of wallet was found. The project's own rig has seen the mechanism: a
bench site driven all night used 103.8% of its daily row quota and went read-only, so every login
answered 503 (`CLAUDE.md`, measured). A busy site on the free plan can be degraded by traffic.
There is also no host disk image and no host log to examine after an incident, so forensics rest on
Workers observability events.

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
above. No exploit was run against a Drupflare site.

- `removed` means the attack path needs a component the object does not have.
- `contained` means the flaw runs, and the sandbox limits what the attacker reaches outside the object.
- `unchanged` means the flaw works the same way.
- `unknown` means the answer depends on a fact not yet established.

| Id                                                                                                                                                                     | Year       | Class                                | Verdict   | Reason                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------ | --------- | --------------------------------------------------------------------------- |
| [CVE-2014-3704](https://www.drupal.org/sa-core-2014-005)                                                                                                               | 2014       | SQL injection, Drupal 7 core         | unchanged | Reads the same database                                                     |
| [CVE-2018-7600](https://www.drupal.org/sa-core-2018-002)                                                                                                               | 2018       | Unauthenticated RCE, Drupal core     | contained | PHP runs in the sandbox; no shell for the observed miner payload (CVSS 9.8) |
| [CVE-2018-7602](https://www.drupal.org/sa-core-2018-004)                                                                                                               | 2018       | RCE, Drupal 7 and 8                  | contained | As CVE-2018-7600                                                            |
| [CVE-2019-6340](https://www.drupal.org/sa-core-2019-003)                                                                                                               | 2019       | RCE through REST input               | contained | PHP runs in the sandbox                                                     |
| [CVE-2020-13663](https://www.drupal.org/sa-core-2020-004)                                                                                                              | 2020       | CSRF in Form API                     | unchanged | Browser-side flaw                                                           |
| [CVE-2026-108097](https://www.drupal.org/sa-core-2026-014)                                                                                                             | 2026       | RCE in Field UI, Drupal core         | contained | PHP runs in the sandbox; lock pins 11.4.10, the fixed release               |
| [CVE-2019-11043](https://nvd.nist.gov/vuln/detail/CVE-2019-11043)                                                                                                      | 2019       | PHP-FPM buffer underflow via nginx   | removed   | No FPM, no nginx, no FastCGI socket                                         |
| [CVE-2024-4577](https://nvd.nist.gov/vuln/detail/CVE-2024-4577)                                                                                                        | 2024       | PHP-CGI argument injection, Windows  | removed   | Needs the CGI SAPI on Windows with Apache                                   |
| [CVE-2014-6271](https://nvd.nist.gov/vuln/detail/CVE-2014-6271)                                                                                                        | 2014       | Shellshock, Bash through CGI         | removed   | No Bash and no CGI                                                          |
| [CVE-2021-41773](https://nvd.nist.gov/vuln/detail/CVE-2021-41773)                                                                                                      | 2021       | Apache 2.4.49 path traversal         | removed   | No Apache and no filesystem to traverse                                     |
| [CVE-2016-3714](https://nvd.nist.gov/vuln/detail/CVE-2016-3714)                                                                                                        | 2016       | ImageMagick delegate shell injection | removed   | No ImageMagick; no process to spawn                                         |
| [CVE-2023-4966](https://nvd.nist.gov/vuln/detail/CVE-2023-4966)                                                                                                        | 2023       | CitrixBleed, edge appliance memory   | removed   | No appliance in the tenant's path                                           |
| [CVE-2014-0160](https://nvd.nist.gov/vuln/detail/CVE-2014-0160)                                                                                                        | 2014       | Heartbleed, OpenSSL                  | removed   | PHP has no OpenSSL; TLS ends at Cloudflare                                  |
| [CVE-2026-7261](https://nvd.nist.gov/vuln/detail/CVE-2026-7261)                                                                                                        | 2026       | PHP SoapServer use-after-free        | removed   | ext/soap is not compiled in (no `SoapServer` string in the binary)          |
| runc [CVE-2019-5736](https://nvd.nist.gov/vuln/detail/CVE-2019-5736), [CVE-2024-21626](https://github.com/opencontainers/runc/security/advisories/GHSA-xr7r-f8xq-vfvv) | 2019, 2024 | Container runtime escape             | removed   | The tenant has no container runtime; the platform does                      |
| [CVE-2022-0847](https://nvd.nist.gov/vuln/detail/CVE-2022-0847), [CVE-2016-5195](https://nvd.nist.gov/vuln/detail/CVE-2016-5195)                                       | 2022, 2016 | Linux kernel privilege escalation    | removed   | Needs a local process on a Linux kernel the tenant can reach                |
| [php-src malicious commits](https://www.php.net/archive/2021.php)                                                                                                      | 2021       | Source supply chain                  | unchanged | A bad commit reaching a build is the same risk on any host                  |
| [Spectre on Workers](https://blog.cloudflare.com/revisiting-spectre-attacks-on-workers/)                                                                               | 2026       | Co-tenant timing leak                | unchanged | Platform mitigations apply; not complete by Cloudflare's own statement      |
| [Cloudbleed](https://blog.cloudflare.com/incident-report-on-memory-leak-caused-by-cloudflare-parser-bug/)                                                              | 2017       | Edge memory disclosure               | unchanged | Platform-side; a tenant cannot prevent it                                   |

## How Much Safer

No study compares breach outcomes for serverless and server hosting. The attack-surface literature
(Manadhata and Wing, IEEE TSE 2011, and Howard's relative attack surface quotient) defines how to
count entry points and capabilities, and neither measures this pair. The vendor surveys searched
quote percentages that were read only through summaries, so none is repeated here.

What can be counted is the map above. Its 19 rows carry these verdicts:

| Verdict   | Rows | Meaning                                            |
| --------- | ---- | -------------------------------------------------- |
| removed   | 10   | The attack path needs a component the object lacks |
| contained | 4    | The flaw runs; the sandbox limits the reach        |
| unchanged | 5    | The flaw works as it does anywhere                 |

Read the 10 as a statement about classes of server takeover, and do not read it as a breach
probability. The rows were chosen from incidents that reached the attacker's goal on conventional
PHP hosting, so the selection favours the classes this architecture removes. None of the six Drupal
advisories in the map is `removed`: each is `contained` or `unchanged`, because Drupal's own bugs
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

These are the security items with a release against them. None is shipped except where marked.

| Item                                                         | Closes                                      | Release                     |
| ------------------------------------------------------------ | ------------------------------------------- | --------------------------- |
| Security headers on every Worker response                    | Missing headers on every page               | v1.0.4, in the working tree |
| Multipart parsing regression test                            | Reachability inference                      | v1.0.4                      |
| Host import census as a gate                                 | A new import joining the surface unreviewed | v1.0.4                      |
| `SECURITY.md` and a reporting route for researchers          | A documented disclosure path                | v1.0.4                      |
| Drupalgeddon 2 against three arms                            | The comparison above, first case            | v1.0.4                      |
| Module-set headers stored with the page                      | Security Kit and similar headers dropped    | v1.1                        |
| Content-Security-Policy with a report-only stage             | No default CSP                              | v1.1                        |
| Per-site egress allow-list                                   | Open egress                                 | v1.1                        |
| Fleet security-release rollout, owner patching with rollback | Manual PHP and Drupal patch delivery        | v1.1                        |
| The full three-arm comparison                                | The unmeasured claim                        | v1.1                        |

## References

Read on 2026-10-21 unless noted.

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
11. Drupal security advisories SA-CORE-2014-005, 2018-002, 2018-004, 2019-003, 2020-004 and 2026-014: <https://www.drupal.org/security>
12. NVD records for the CVE identifiers in the map: <https://nvd.nist.gov/>
13. PHP project, 2021 archive (malicious commits, 2021-03-30): <https://www.php.net/archive/2021.php>
14. Sophos, "The State of Ransomware in Education 2025": <https://www.sophos.com/en-us/blog/the-state-of-ransomware-in-education-2025>
15. workerd README, "WARNING: workerd is not a hardened sandbox": <https://github.com/cloudflare/workerd>
