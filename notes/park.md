# The Zend park and the fiber backend

What the park does, how it was measured wrong three times, and what it cannot serve. Moved verbatim from the project CLAUDE.md.

## The interpreter has no fiber backend, and the executor is persistent

Both measured 2026-09-07 on the shipping binary, and the second is the useful half.

**`new Fiber(...)->start()` aborts the runtime**: `Aborted(missing function: getcontext)`. php-src's
ucontext branch needs `getcontext`/`makecontext`/`swapcontext` and emscripten implements none of them;
`vendor/static-jspisjlj` has the identical stub list, so **JSPI does not supply one either**, and
`-sSUPPORT_LONGJMP=wasm` cannot -- it is one-way and `swapcontext` needs two. This project already knew:
`FIBER_SHIM` / `PhpWasmSyncFiber` in `src/drupal/site-php.ts` exists because of it, and
`scripts/patch-drupal.mjs` rewrites core's five `new \Fiber(` sites to it. Do not re-propose fibers,
and do not propose writing a wasm `zend_fiber_switch_context()` -- that is strictly more work than
JSPI for the same capability.

**`pib_run` performs no `php_request_startup`/`shutdown` cycle.** `$GLOBALS` persist across `_run()`,
a class declared in run 1 exists in run 2, and a `register_shutdown_function` from run 1 never fires.
**A parked GENERATOR therefore survives a Worker invocation** -- suspended in `$GLOBALS`, resumed on a
later invocation with a host-supplied value, completed on a third. Its limit is the coloring problem:
`yield` suspends only its own frame, so it serves code written for it and cannot retrofit Predis,
Guzzle or the renderer. And a parked continuation lives in linear memory, so `recycleIfOversized()`
destroys one silently -- it needs a terminating OBSERVATION, like `/user/password`.

The premise behind the fiber proposal, "Zend already manages the continuation", is true of generators
and false of fibers: a generator copies `execute_data` and the VM stack to the HEAP, a fiber switches
a real C stack.

## The Zend park ships, and every instrument that measured it was wrong once

`ext/cfwpark` in phasm freezes the continuation of a trapped blocking call, `longjmp`s out of
`pib_run` and returns `PARKED`; `src/ops/park-drive.ts` reads what was asked for, performs it in JS,
and resumes the chain, all inside ONE invocation. `src/ops/park.ts` reports whether the interpreter
can do it at all. `drupal/redis` is what it exists for -- a cache get has to answer inside the
request that asked, which is the one shape the deferred tier cannot serve.

**IT WORKS, measured 2026-09-08 on the long64 build against the rig Redis.** PHP opens a socket,
writes and reads twice, and receives `+OK|+PONG` -- five parks, each performed in JavaScript on a
LATER invocation and resumed back into the same PHP chain. A real Drupal render with the traps armed
reports `done` too, which is the check that matters before arming: the render goes through
`cfw_park_run`, and that is `zend_eval_string` rather than a script.

It took two extension fixes, and BOTH FAILED SILENTLY:

- **`cfw_park_resume` did not re-arm.** `park_armed` was 0 for the whole resume, so every trip after
  the first ran the real function. A fall-through is the refusal path, so it looked deliberate.
- **The safety predicate's floor was a frame from the invocation that STARTED the chain.** On a
  resume the walk went past the parked chain into reused VM stack memory -- reading first as a
  refusal, then as `RuntimeError: memory access out of bounds`. A resumed chain now relinks its root
  to the resuming frame, which is what `zend_generator_resume` does and what this never did.

**AND A FOURTH, ON THE HTTP HALF: an UNQUALIFIED CALL INSIDE A NAMESPACE resolves at runtime, and
that is why every harness read this safe while every render refused.** `call_user_func_array` leaves
no frame at all -- `zend_compile_func_cufa` rewrites it to `ZEND_INIT_USER_CALL` -- but the rewrite
needs the compiler to have resolved the name, and an unqualified call inside a namespace compiles to
`ZEND_INIT_NS_FCALL_BY_NAME` instead. So the frame is REAL in every namespaced file, which is all of
Drupal, and ABSENT in the global namespace, which is where every synthetic harness in this project
was written. Measured on native 8.5.7: 3 frames through `Probe\Ns\viaUnqualified` against 2 through
`\call_user_func_array`. Measured on the shipping interpreter through the real pack: one internal
frame between `FormBuilder::retrieveForm` and the form callback it dispatched, with `array_map` at 1
as the control and the same line inside an `eval` at 0.

`ext/cfwpark`'s docblock had asserted the opposite and named the compiler as the reason, which is the
half that was true. **A claim that holds in the global namespace is not a claim about Drupal.**

**`park_flatten()` SPLICES SUCH A FRAME OUT rather than refusing it.** The frame's whole remaining
job is to copy its callback's return value, and `zend_leave_helper`'s nested path already does that
for an ordinary call -- so the callee is relinked to the trampoline's caller and its `ZEND_CALL_TOP`
cleared, and the return lands at `opline + 1` of the `DO_FCALL` that entered it. `cfw_park_resume`
needed no change at all. `call_user_func` and `call_user_func_array` are the whole list, and adding a
name means asserting six invariants of php-src's implementation of it; `array_map`, `usort` and
`iterator_to_array` all still refuse, which is the control that makes the change mean anything.

**The splice has a NATIVE gate, which is legitimate here for one reason: it measures the predicate
and the frame surgery rather than the resume.** `phasm/src/ext/cfwpark/tests-dispatch.php` against a
`phpize` build -- `phpize && ./configure --enable-cfwpark && make`, then
`php -n -d extension=modules/cfwpark.so tests-dispatch.php` -- is 20 assertions, and both halves are
falsified: disable the splice and 5 fail with the chain silently truncating, count trampolines unsafe
again and 7 fail with every park refused. `-n` matters, because Xdebug installs its own execute
handler. The RESUME is still a wasm question, since homebrew is the HYBRID VM and this build is
`ZEND_VM_KIND_CALL`, and `park-oidc.spec.ts` is where that one is answered.

So `blockingOutbound` is TRUE and `drupal/openid_connect` completes a login through its OWN client:
`park-oidc.spec.ts` drives a real authorization code from the rig Keycloak, and the token POST and
the userinfo GET are both parked, after which `externalauth` writes `openid_connect.keycloak` into
`authmap` against the id_token's `sub`. The control beside it is the same run on the previous
interpreter, where the deferred transport answered `is not in the fetch cache` and no row was
written. A refused park still falls back to the deferred transport rather than rejecting, because
rejecting made it strictly worse than what it replaced: every Search.gov render answered 500 until
the fallback existed. **A refused park must degrade, never fail.**

**THE ARTIFACT IS THE THING TO CHECK, and `cdn-manifest.json` names the OLD binary.** A `bun install`
downloads the published interpreter, which has no `park_flatten()`, so it silently replaces a build
the capability depends on. `park-dispatch.spec.ts` pins the flag against the reading for that reason:
on a reverted interpreter it fails and names the frame instead of leaving `SHIPPED_BLOCKING_HTTP`
claiming something the binary cannot do.

Two arming rules survive. Both classes stay gated on their capability, because arming one the park
cannot serve routes every render through `cfw_park_run` for a yield that always falls back -- measured
when `fetch` was armed unconditionally: `serve-chain` read a render estimate of -1. The `socket` class
additionally waits for `REDIS_URL`, and even then arms only `stream_socket_client` at boot: its
read/write traps divert every file write inside a parked run, so `drivePark` arms `fwrite`, `fread`
and `fgets` at the first open (`PARK_ARM_SOCKET_IO`), when a socket exists to read or write. Armed from
the first render they parked a `fwrite` inside a destructor, a chain whose C frame the `longjmp` had
destroyed: the run ended `done` with empty output and the next call trapped with `memory access out of
bounds`. A node save on any site with `REDIS_URL` set lost its answer that way, and the old unparked
re-run hid it until `1f234a0a67` stopped re-running a request. The traps cannot be removed, so a
site that opens a socket keeps them; `fetch` needs no endpoint, since the destination is whatever the module asks for and the
SSRF guard is what bounds it. **That guard had its own defect**: `classifyParkOp` called
`refuseOutbound()` directly while every other outbound path goes through `outboundGuardEnabled()`, so
`OUTBOUND_GUARD=0` -- which exists for the rig -- turned the guard off everywhere except there.

**THREE INSTRUMENTS MEASURED IT AND ALL THREE WERE WRONG, in both directions.** That is the part
worth carrying, because the mechanism was declared working and then declared impossible before it was
either:

- **A flat native harness said it worked.** Run and resume from the same scope put the resume's frame
  in the slot the run's just vacated, so the stale parent pointer and the live one were the same
  ADDRESS and the walk terminated by coincidence. It printed `trips=3` and `DONE`, and that reading
  carried the mechanism forward for a session; its remaining assertion, that each answer reached the
  call that asked, was never reached because the test fataled on its own reporting line first.
- **A native PHP said it was impossible.** Homebrew 8.5.7 runs the HYBRID VM and this build runs
  `ZEND_VM_KIND_CALL`. Native reported a resumed chain never unwinding into its caller; the wasm build
  unwinds it correctly. **Do not use a native PHP as the oracle for the park.**
- **The capability vector could not express the capability.** A contract probe is one PHP expression,
  so its run and its resumes all land in one `_run` -- and a host able to answer inside one `_run`
  would not need a park at all. It answered true for something the product could not use. It is
  `socket.park.inline` now, named for what it measures, and `blockingSocket` is a LITERAL beside
  `SHIPPED_CRON` for the same reason that one is: the flag and the vector answer different questions.
  `park-interpreter.spec.ts` is where the cross-invocation case is asserted, against a real server.

**`function_exists('cfw_park_run')` IS THE WRONG PROBE, and it is the decorative kind.** The first
built revision exported every symbol and did not re-arm inside `cfw_park_resume`, so a chain parked
ONCE and then ran its next trapped call for real. A fall-through is the refusal path, so it looks
deliberate and nothing reports it -- and every real exchange is multi-trip, so the capability was
absent on a build the symbol check called complete. `socket.outbound.blocking` in
`capability-contract.ts` takes two parks in one chain and requires the second, which is why it reads
false on a build that carries every `cfw_park_*` symbol.

**`blocking-outbound` AND `blocking-socket` ARE TWO CAPABILITIES, and both are TRUE now.** The park
serves each by a different route, which is why one flag could not describe them: a trapped
`stream_socket_client` / `fwrite` / `fgets` parks directly, while `fopen('https://...')` still
cannot, because the HTTPS wrapper is userland invoked from the INTERNAL `fopen` and a park under one
of those is refused -- correctly, since `fopen`'s C locals cannot survive the `longjmp`, and unlike a
dispatch trampoline it has real work left to do afterwards. So HTTP is served by REPLACING the
transport rather than by trapping it: `ParkFetchHandler` is plain userland and yields from there.
Keeping the two separate is still right, because the mechanisms are different and either could
regress alone.

Four things the wiring had to get right, each of which was wrong first:

- **`_run`'s return value is not the output.** php-wasm delivers printed text through an `output`
  EVENT, so a probe reading the return value reports `absent` on every build. The seam is `runText`.
- **The token a trapped open returns is minted in PHP, not in JS.** `cfw_park_resume` copies a zval
  and JS cannot construct a PHP resource, but the resume fragment is PHP the host composes -- so it
  opens a `php://memory` stream and hands that back. Predis calls `is_resource()` on the result, so
  an integer handle fails as a connection error naming nothing.
- **That token is opened `r`, and the read-only mode is the failure mode talking.** A refused park
  falls through to the real function, which would write the RESP command into the token and read
  nothing back -- a corrupted conversation rather than an error.
- **A run that does not finish must be unwound before returning.** `cfw_park_run` throws when a chain
  is already parked, so one refusal left in place makes every later render on that interpreter fail
  with `cfw: a chain is already parked`: a permanent fault out of a transient one.

**Traps are global for the duration of a parked run**, so a render that writes a file arrives at the
loop on a handle the host never minted. It is performed rather than refused, in PHP, because `fputs`
is a separate `zend_function` carrying its own copy of the handler pointer and so survives trapping
`fwrite`. `fread` and `fgets` have no alias and are rebuilt from `stream_get_contents`; `fclose` is
not trapped at all, because it has neither. Arming happens only when `REDIS_URL` is set, so a site
that never asked for Redis is untouched.

**A REQUEST RAN ITS PHP TWICE, and the host did it, not the park.** Fixed 2026-11-02.
`runJsonMaybeParked()` in `src/do/outbound.ts` parsed the printed output from its FIRST `{` and
re-ran `code` from the top when the parse threw. Two routes reached that line: a brace in text
printed before the result (SimpleSAMLphp's `%date{M j H:i:s}` log lines; the park never engaged, state
`done`, zero trips), and a refused park, where `unwind()` discarded everything the finished chain
printed including the final JSON. The first run's side effects were already committed, so one
create-node POST through a refused park made two nodes (rows 2 to 4). The tail now parses with
`parseJsonReply()`, `unwind()` returns what the chain printed, and a reply that does not parse is a
render failure and never a second run. Count entries into the program with a counter bumped at its
first statement; a status code cannot show a double run. `tests/integration/park-double-run.spec.ts`.
A deployed check is written down in lane 113's results and has not run.
