# PHP Interpreter Update Delivery

How a PHP wasm interpreter built by [`drupflare/phasm`](https://github.com/drupflare/phasm) reaches
this repository, what is proved about it before anything can consume it, and where the pipeline
stops.

Scope: the interpreter only. Drupal core, contrib and the packed database move on their own lane, in
[Out of Scope](trust-and-cost.md#out-of-scope).

## Pages

- [Verification and Output](verification.md): verification, output, manual runs and credentials.
- [Rollback and Staged Rollout](rollback.md): rollback and staged rollout.
- [Trust, Cost and Scope](trust-and-cost.md): trust, self-hosted sites, cost, rejected alternatives and scope.

## Platform Constraints

A running Worker cannot swap its PHP binary. The change unit is a redeploy.

- **The interpreter is a bundle-time module.** `src/runtime/php-binary-raw.ts` reaches it with
  `import wasmModule from '../../.interp/php8.5.tuned.wasm'`, and `wrangler.jsonc` maps `**/*.wasm` to
  module type `CompiledWasm`. Wrangler resolves a module import when the bundle is built. No runtime
  API adds a module to a deployed bundle.
- **There is no compile step to pay.** A `CompiledWasm` import arrives already compiled, so the seam
  performs no codegen at all. That matters because `workerd` permits codegen during startup and
  refuses it at request time, which is what a compressed frame had to work around. Replacing the compressed seam took startup from ~106 ms to ~5 ms.
- **Startup cannot fetch.** Cloudflare refuses asynchronous I/O in global scope: "Disallowed
  operation called within global scope. Asynchronous I/O (ex: fetch() or connect()), setting a
  timeout, and generating random values are not allowed within global scope." `env` is importable at
  module scope, but calls on a Durable Object stub, a KV store or another Worker do not work there.

The one place that may compile may not download, and the one place that may download may not
compile. Together they rule out R2, KV, the asset layer, a service binding and Durable Object
storage as a source of interpreter bytes.

Everything after the build is automatable. `wrangler versions upload` produces a version without
deploying it, `wrangler versions deploy <id>@<pct>` splits traffic, and `wrangler rollback <id>`
reverses it, all against the wrangler version pinned in `package.json`.

## The Pipeline

Two workflows, one in each repository.

| step | where                                               | result                                              |
| ---- | --------------------------------------------------- | --------------------------------------------------- |
| 1    | `phasm` `.github/workflows/build.yml`, `notify` job | a `repository_dispatch` naming a published artifact |
| 2    | `worker` `.github/workflows/interpreter.yml`        | a verified payload artifact and a pull request      |
| 3    | a human                                             | merge, release, deploy                              |

Step 3 is not automated. The workflow has no deploy step and holds no Cloudflare credential.

## Notification

phasm's `notify` job runs after `publish`, so it fires when a build publishes interpreter artifacts
and not on the pull-request or archive-only paths. It sends one `repository_dispatch` per variant
listed in `CONSUMER_VARIANTS`, currently `long64`, the variant `interp.lock.json` pins. Earlier
builds named `control85`. `interpreter.yml` skips any dispatch for a variant other than the pin, so a
dispatch for an old variant never proposes an update for the shipping interpreter.

```json
{
  "event_type": "phasm-interpreter-published",
  "client_payload": {
    "variant": "long64",
    "php_version": "8.5",
    "artifact_id": "4102938475",
    "run_id": "18273645",
    "commit": "abc1234",
    "tag": "snapshot-abc1234"
  }
}
```

`php_version` is read from `src/rc/<variant>.rc`. `artifact_id` is resolved against the run's own
artifact list, so it names the build that just completed rather than whichever artifact is newest
when the consumer looks.

A variant with no rc, no `PHP_VERSION` or no artifact in the run is skipped with a warning. A run
that notifies nothing fails, because a silent no-op leaves `worker` on its old pin with a green
build behind it.

`POST /repos/{owner}/{repo}/dispatches` requires Contents: write on `drupflare/worker`. When
`PHASM_TOKEN` carries only Actions: write, the dispatch is refused and the job falls back to
`POST /repos/{owner}/{repo}/actions/workflows/interpreter.yml/dispatches`, which that permission
does cover. The fallback carries the variant, the PHP version and the artifact id; the phasm run id,
commit and tag reach the consumer only over `repository_dispatch`.
