# Verification and Output

What is proved about a new interpreter before anything consumes it, what the pipeline produces, how to run it by hand, and the credentials it needs.

## Verification

`interpreter.yml` accepts `repository_dispatch` and `workflow_dispatch`. Both resolve to the same
three values, and the workflow refuses a variant that is not a phasm rc name, a PHP version that is
not `<major>.<minor>`, and a non-numeric artifact id.

The run hydrates the current release payload first. That supplies `assets/` and the incumbent
interpreter, so the bundle is measured against the tree that ships, and the incumbent figure
is recorded before the swap.

Two checks stand between the download and the pull request. Each throws, each fails its step, and
a failed step ends the run: no payload is uploaded and no branch is pushed.

1. **The seam imports what was fetched.** `assertSeamImports()` in `scripts/fetch-interpreter.ts`
   reads the interpreter imports out of the seam `wrangler.jsonc` aliases and requires the fetched
   frame and glue to be among them. On a hydrated tree a fetch for the wrong PHP version otherwise
   builds cleanly, passes the size gate, and measures the incumbent.
2. **The bundle fits the Worker size limit.** `bun run release:check` dry-runs the canonical config,
   parses the uncompressed `Total Upload` figure wrangler prints, and throws above 67,108,864 bytes.
   The dry run also proves the entrypoint and the binary alias still resolve.

`tests/node/interp-fetch.spec.ts` covers the first directly.
`tests/node/release-payload.spec.ts` covers the KiB-to-bytes conversion and the ceiling arithmetic.

## Output

A run that passes produces two things and deploys neither.

- **A payload artifact**, `drupflare-worker-payload-<variant>-php<version>`, holding the tarball,
  `SHA256SUMS`, `manifest.json` and the pin. It is a complete hydrate input, retained 30 days.
- **A pull request** carrying `interp.lock.json`, which records the variant, the PHP version, the
  phasm artifact id, the frame's raw, packed and declared sizes, and a sha256 per file. The binaries
  are 9-12 MB and gitignored, so the pin is the reviewable part of an interpreter bump. The body
  carries the incumbent and proposed bundle figures side by side.

The branch is `interp/<variant>-php<version>-<artifact id>`, so a re-run for the same artifact finds
the branch on the remote and opens nothing. A pin byte-identical to the one already on the base
branch opens nothing either.

The pull request touches one tracked file, so `build.yml` and `coverage.yml` run the full code gate
on it. `interpreter.yml` gates the bytes and the bundle.

To reproduce a pinned interpreter by hand, pass the recorded artifact id:

```sh
bun scripts/fetch-interpreter.ts long64 8.5 4102938475 --pin
```

## Manual Runs

`workflow_dispatch` takes `variant`, `php_version`, `artifact_id` and `payload_tag`. An empty
`artifact_id` takes the newest unexpired artifact for the variant. An empty `payload_tag` hydrates
the payload for `package.json`'s version.

## Credentials

| what                   | where                       | scope                                                 |
| ---------------------- | --------------------------- | ----------------------------------------------------- |
| `PHASM_TOKEN`          | organization secret, both   | Actions: read on `phasm`; Contents: write on `worker` |
| `GITHUB_TOKEN`         | default, per job            | `contents: write`, `pull-requests: write` on `worker` |
| `CLOUDFLARE_API_TOKEN` | not held by either workflow | deploys are manual                                    |

`PHASM_TOKEN` authenticates two hops: phasm's dispatch into `worker`, and `worker`'s read of phasm's
Actions artifacts API. Contents: write is what the `repository_dispatch` endpoint requires; with
Actions: write alone the pipeline runs on the `workflow_dispatch` fallback.

Opening the pull request also requires "Allow GitHub Actions to create and approve pull requests" in
the repository's Actions settings. A pull request opened with `GITHUB_TOKEN` does not trigger
workflows that a `pull_request` event would otherwise start.
