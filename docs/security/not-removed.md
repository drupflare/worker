# What It Does Not Remove

The risks the architecture does not remove: application bugs, code execution and memory corruption inside the sandbox, JavaScript in the isolate, shared data, side channels, platform failure, supply chain, cost as an attack, and state that survives between requests.

## Application Bugs

A SQL injection, an authorization bypass or a cross-site request forgery behaves as it does on any
host. Drupalgeddon (CVE-2014-3704, SA-CORE-2014-005) is a SQL injection reachable by an anonymous
user, and it reads the same database here. SA-CORE-2020-004 (CVE-2020-13663) is a CSRF flaw in the
Form API, and a browser does not care where the server runs.

## Code Execution Inside the Sandbox

Drupalgeddon 2 (CVE-2018-7600, CVSS 9.8) and SA-CORE-2019-003 (CVE-2019-6340) execute PHP. So does
SA-CORE-2026-014 (CVE-2026-108097), a Field UI remote code execution in core published 2026-10-14.
Its advisory says "At least one known exploit path does not require authentication" and also says
the flaw "is not directly exploitable with core alone", with serious exploit paths through
contributed modules. In each case the attacker runs PHP in the object, with the host functions
(see [Host Surface](controls/index.md#host-surface)) and the database in the same object. The architecture contains what that PHP can do
outside the object. It does not stop the PHP from running.

## Memory Corruption Inside the Sandbox

WebAssembly does not make a C program's memory bugs harder to exploit. Lehmann, Kinder and Pradel
(USENIX Security 2020) find that many classic vulnerabilities that common mitigations block in
native code are exposed in WebAssembly, that the platform enables new attacks such as
overwriting constant data, and that attacks can divert control flow or manipulate the host. Their
conclusion is "a perhaps surprising lack of binary security in WebAssembly"
([USENIX](https://www.usenix.org/conference/usenixsecurity20/presentation/lehmann), abstract).
Stiévenart, De Roover and Ghafari compiled 4,469 C programs with known buffer
overflows to x86 and to WebAssembly, found 1,088 whose outcome differed, and attribute it to "the
lack of security measures such as stack canaries in the generated WebAssembly"
([arXiv:2111.01421](https://arxiv.org/abs/2111.01421), abstract).

So treat an exploit of a PHP memory bug as no harder inside the sandbox than on a native build, and
do not count on in-sandbox exploit difficulty. WebAssembly checks an indirect call's type
signature, so a hijack is limited to functions of the same type
([webassembly.org](https://webassembly.org/docs/security/)). What the sandbox changes is the step
after: code in the module reaches the host only through the imports above.

## JavaScript Code Execution in the Isolate

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
request-time `WebAssembly.Module` compilation is refused by `workerd` (`notes/memory-and-isolates.md` and `notes/measurement-history.md`, both measured on
this project's own probes). Neither is a statement about hosted Workers in general.

Of the 14 runtime npm packages, advisories were checked for four. `mysql2` 3.24.4 is above the fix
for GHSA-3f6p-5ww8-9rcr, and `pg` has a 2018 advisory whose affected range was not read. The other
ten and every transitive package are unchecked, and an unchecked package counts as `open`.

## Data in the Same Object

Code execution inside the sandbox reads and writes the whole site database, which is in the same
object. Sealed storage keeps credentials out of that database, and nothing keeps the site's
content, users, sessions and configuration out of it. Egress is open by design:
`cfwQueueFetch` sends any public HTTP(S) request PHP builds, because the legitimate set (update
servers, OIDC providers, webhooks) is open-ended. The deny-list protects private and metadata
addresses and does not stop a site's own data leaving to a public host. A per-site egress allow-list
is `L` and is not built.

## Co-Tenancy and Side Channels

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

## Platform Failure and Concentration

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

## Supply Chain

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

## Cost as an Attack and Visibility

No primary source on denial of wallet was found. The project's own rig has seen the mechanism: a
bench site driven all night used 103.8% of its daily row quota and went read-only, so every login
answered 503 (`CLAUDE.md`, measured). A busy site on the free plan can be degraded by traffic. This
is `open`. There is also no host disk image and no host log to examine after an incident, so
forensics rest on Workers observability events and the owner audit log's anchor lines.

## State That Survives Between Requests

A warm Durable Object keeps its interpreter between requests, and static state in PHP survives.
Seven cases are documented in this repository: an AJAX flag that randomised every later element id,
an entity access cache that kept an unpublished node readable by anonymous visitors, a cached
local-task list that rendered one node's tabs on another, a `file_save_upload()` function static
that handed one user's uploaded file to the next upload to the same field, SimpleSAMLphp's
`Session` static and the `simplesamlphp_auth` manager, which logged a request with no cookie in as
the previous visitor, the `access_unpublished` token getter, which kept the last visitor's token so
an anonymous request read an embargoed node, and strata's `CaptureScope`, which memoises its
settings for the life of the container and so ignored a saved change. Each was found and fixed, and each had no signal until a test looked for
it (`notes/platform-facts.md`, "The boundary sweep walks SERVICES now").

A service that holds per-request state needs a named entry in the request resetter's seed list.
Contrib services are reached that way, because a generic pass that calls `reset()` on every
initialised service would also reset about 20 core services, and what each of those drops is not
measured. The sweep that looks for such state walks the services a request instantiated and so
catches a new carrier only after a test drives it.

This class is specific to a persistent
runtime. A request-per-process server such as PHP-FPM resets it by design.
