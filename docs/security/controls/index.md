# Security Controls

What Drupflare provides today, control by control: the host surface, the request path, outbound requests, uploads, credentials, response headers, the build and patching. The claims and their labels are on [Security](../index.md).

## Pages

- [Request Controls](requests.md): request path, outbound requests, uploads and response headers.
- [Credentials and Persistence](credentials.md): how credentials and persistent state are protected.
- [Build and Patching Controls](build-and-patching.md): the build and patching.

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
