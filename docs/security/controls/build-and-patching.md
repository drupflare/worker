# Build and Patching Controls

The controls on how the interpreter is built and how patches reach a site.

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

Stack protection is not in the shipping build. A rebuilt baseline and two candidate flags were measured on `paisley-park` (`results/84-s12-builds.md`). `-fstack-protector-strong` added 0.545% to the wasm and left a 4-byte guard that is a constant zero: every access to it is a load, no data segment writes it, so it catches a non-zero overwrite of that slot and nothing else. `-sSTACK_OVERFLOW_CHECK=2` cost 6.3% of the blended median (range 4.9% to 9.7% over eight processes) and added 3.4% to the wasm. `-sSTACK_OVERFLOW_CHECK=1` changes only the glue and cost nothing the harness could resolve. Neither check was adopted. Unmeasured: whether a real PHP stack overflow reaches either trap. The open objective for v1.1 is a canary that is not constant. Nothing in the build writes the guard slot before the first PHP call, so a randomised canary needs a writer for that slot and its own cost measurement; that is an inference from the wasm dump, not a tested design.

## Patching

Cloudflare patches V8 and the platform. Drupal core and the PHP interpreter are the project's to
patch, and that path has a manual step. A new interpreter build travels from `phasm` to a pull
request in this repository and ends there. The workflow has no deploy step, and a person merges,
releases and deploys (`docs/operating/php-update-delivery/index.md`). The pin records `.interp/php8.5.wasm` with its
sha256.

The interpreter in the tree reports PHP 8.5.12, the first 8.5 release that carries the PHP2Shell
fixes (Measured: `interpreter-lifecycle.spec.ts` asserts `PHP_VERSION >= 8.5.12`). The advisory was
published 2026-10-21 13:34 UTC. A local rig build that passes the park, heap and static-sweep specs
finished 31 hours 39 minutes after it, and the attested CI artifact (phasm run 39876497434, artifact
12463245201, `gh attestation verify` exit 0) was created 32 hours 35 minutes after it. (Corrected 2026-11-02: this paragraph first cited run 39861586180. The pin record in `DRUPFLARE_ROADMAP.md` S11 and commit `0ee10e9db` name 39876497434. The 32 hours 35 minutes figure was not re-derived from the run record; it ends at 22:09 UTC, which is the pin commit's 22:09 EDT clock time read as UTC, so treat it as unverified.) The advisory
time is read from the PHP announcement; the build times come from the rig log and the workflow run
record. That is one interval on one build, not a rate. Deployed sites move only when someone
publishes the artifact, merges the pin and deploys. The root `composer.lock` pins Drupal core 11.4.11, which includes the 11.4.10 fix for the 11.4 line of SA-CORE-2026-014.

Rebuilding found a defect in `phasm`'s own park extension. When a parked chain completes after a
resume, the root frame's `return_value` still pointed at a C local of `zend_eval_stringl` that the
`longjmp` had destroyed, so the final `ZEND_RETURN` wrote a 16-byte zval onto whatever the resuming
stack held. On 8.5.2 the bytes were dead and nothing showed. On 8.5.12 the write corrupted the
dispatch state and the next call trapped. The extension now points the root at a slot it owns
(`park_pin_root()` in `cfwpark.c`). The fix is covered natively (22 pass with the fix; 21 pass and
1 fail without it) and by `park-interpreter.spec.ts`. It matters here because it is a memory-safety bug in
code the project wrote, reachable only on a site that arms the park (`REDIS_URL` set, or an OIDC or
other outbound fetch that parks).
