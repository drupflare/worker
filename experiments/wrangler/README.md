# Measurement probe configs

These are **not deployable and not maintained.** They are the wrangler configs used to take
individual measurements recorded in `TECHNICAL_REPORT.md`, kept so a number can be reproduced rather
than re-derived. The deployable config is the single `wrangler.jsonc` at the repo root.

**The paths are fixed; nothing needs editing before a run.** Wrangler resolves `main`,
`assets.directory` and `alias` relative to the config file, so every one of those fields now
carries the `../../` prefix and points at the post-reorg `src/` layout:

```jsonc
"main": "../../src/probes/min.ts",
"assets": { "directory": "../../assets", "binding": "ASSETS" },
"alias": { "./runtime/php-binary.js": "../../src/runtime/php-binary-o2.js" }
```

The `alias` **key** is the import specifier written in `src/site-do.js` and tracks that file,
not the config's location; only the value is a path. `$schema` was prefixed too, so editor
validation still resolves.

Verified by dry run, which builds and resolves everything but never touches the account:

```sh
bunx wrangler deploy --dry-run -c experiments/wrangler/wrangler.min.jsonc
```

**a subset of the 36 on disk build clean; the count was last verified at 25 of 30 and four failures are the documented missing-`vendor/` set.** Of the seven that do not, three are missing a generated
asset directory rather than pointing at a wrong path, and four lost their `vendor/` binary.
Both sets are under NOTES with the exact error, along with one duplicate awaiting deletion.

## What each family was for

| config | main | what it measured |
| --- | --- | --- |
| `wrangler.site.jsonc` | `src/site.js` | the real serving path; port 8798, the config `TECHNICAL_REPORT.md` names for the live driver and capability lanes |
| `wrangler.site-jspi.jsonc`, `wrangler.site-o2.jsonc` | `src/site.js` | the same worker with one alias swapped, so exactly the interpreter changes: `src/runtime/php-binary-jspi.js` (`static-jspisjlj`) and `src/runtime/php-binary-o2.js` (`static-o2`, the shipping binary) |
| `wrangler.trim.jsonc` | `src/site.js` | the trimmed pack, mounted by pointing `assets` at `.trim-assets` instead of editing the mount |
| `wrangler.edge-site.jsonc` | `src/site.js` | ONE render per Durable Object invocation on the deployed edge, against the 15 MB staged asset subset |
| `wrangler.edge.jsonc` | `src/probes/min.ts` | per-invocation `cpuTime` for the minimal profile on the edge, off the same staged subset |
| `wrangler.a0.jsonc` | `src/site.js` | **A0 post-container-fix cold boot**, on the shipping binary AND the shipping mount (`LAZY_MOUNT=1`, so it needs `WITH_PF=1 STREAMING=0 bash scripts/stage-edge-assets.sh`). Measured 2026-08-12 as `cfw-a0-probe`: 1,394-1,674 ms of DO `cpuTime` for cold boot + 1 render against a 4,019 ms pre-fix baseline, with `cache_container` proven at 1 row |
| `wrangler.a67.jsonc` | `src/probes/heapsize.ts` | **A7 under enforcement**: `/plateau` walks the wasm heap past the documented 128 MB isolate ceiling until the runtime answers. Measured 2026-08-12 as `cfw-heap-probe`: 195.06 MiB reached OK, and `outcome: exceededMemory` (HTTP 503, edge error 1102) on the failures |
| `wrangler.decomp.jsonc` | `src/probes/decomp.ts` | **A6**: `cpuTime` against codec pass count, because a single A/B cannot resolve a 400 ms quantity inside an 8,000 ms boot. Measured 2026-08-12 as `cfw-decomp-probe`: `DecompressionStream` IS billed, ~660 ms per 42.4 MB inflated |
| `wrangler.min.jsonc` | `src/probes/min.ts` | the minimal-profile bench locally; port 8797, `/min /breakdown /clock` |
| `wrangler.probe-*.jsonc` | `src/probes/probe-*.ts` | one build variant each (`o2`, `freev1`, `mbstring`, `jspimb`, `jspisjlj`, `jspisjljctl`, `jspimbsjlj`, `nolto`, `vmswitch`, `iconv`, `control`), for the build comparison table. All eleven are the same thin worker over `src/probes/probe-core.ts` (the `jspi*` three also mount `src/probes/jspi-routes.ts`), so a size difference between two of them is a binary difference and nothing else |
| `wrangler.mem.jsonc` | `src/probes/memtest.ts` | the isolate memory ceiling probes (512 MiB build constant, MEMFS beyond 2,050 MiB) |
| `wrangler.jspi.jsonc`, `wrangler.sjlj.jsonc` | `src/probes/jspi-probe.ts`, `src/probes/sjlj-probe.ts` | the suspension probes that proved a JSPI-suspended wasm stack survives an invocation boundary. `sjlj` is local only |
| `wrangler.attr.jsonc`, `wrangler.canary.jsonc` | `src/probes/attribution-probe.ts` | the CPU-attribution probe. `attr` is the standalone deploy the original 2/88/93 table was read off with `wrangler tail` attached; `canary` is the same worker plus a `tail_consumers` target, which scores the re-run unattended and therefore needs `wrangler.tail.jsonc` deployed FIRST |
| `wrangler.tail.jsonc` | `src/ops/tail-worker.js` | the Tail Worker itself: `cpuTime` without a human attached, plus the canary's verdict |
| `wrangler.budget.jsonc` | `src/probes/budget-probe.ts` | the DO CPU-budget experiment; `limits.cpu_ms: 10` is enforced only on a deployed Worker, which is why this config exists apart from the dev ones |
| `wrangler.do.jsonc` | `src/probes/do-test.ts` | the Durable Object base suite; port 8793, `/do-suite /do-persist /do-txnreplay /do-keepwarm` |
| `wrangler.prof.jsonc` | `src/probes/prof.ts` | the diagnostics worker; port 8790, `/dbal /codec /reentrancy /cache-headers /drupal` |
| `wrangler.static.jsonc`, `wrangler.o2.jsonc`, `wrangler.v2.jsonc`, `wrangler.opc.jsonc`, `wrangler.free.jsonc`, `wrangler.cap.jsonc` | `src/probes/static.ts`, `o2.ts`, `v2.ts`, `opc.ts`, `free.ts`, `cap.ts` | one full-workload probe worker per `vendor/` build (`static`, `static-o2`, `static-v2`, `static-opcache`, `static-free`, `static-cap`) |

`compatibility_date` is pinned at `2026-08-01` everywhere, and in `wrangler.canary.jsonc` and
`wrangler.tail.jsonc` it is load-bearing: the attribution finding is undocumented behaviour, so
a verdict is only evidence about the date it ran under.

Every deploy these configs produced was torn down; the Cloudflare account carries unrelated
production workers, so a probe always used a `cfw-*` or `drupal-cfw-*` name and was deleted
immediately.

## NOTES

**Four cannot build: the `vendor/` binary is gone.** `wrangler.probe-control.jsonc`,
`wrangler.probe-nolto.jsonc`, `wrangler.probe-vmswitch.jsonc` and
`wrangler.probe-iconv.jsonc` each point at a worker whose build was never kept:

```text
✘ [ERROR] Build failed with 2 errors:
  ✘ [ERROR] ENOENT: no such file or directory, open
    '.../vendor/static-nolto/php8.3-worker.mjs.wasm'
  ✘ [ERROR] Could not resolve "../../vendor/static-nolto/php8.3-worker.mjs"
      ../../src/probes/probe-nolto.js:4:23
```

`vendor/` has no `static-control`, `static-nolto`, `static-vmswitch` or `static-iconv`, and no
section of `TECHNICAL_REPORT.md` records a number taken on any of them. They are kept because the
worker file still exists and the config records what was attempted; the measurement cannot be
reproduced without rebuilding the binary (`bash scripts/build-variant.sh`).

**Three need a generated asset directory, which is not committed.** `wrangler.edge.jsonc`,
`wrangler.edge-site.jsonc` and `wrangler.site-o2.jsonc` point at `../../.edge-assets`, the
15 MB subset an edge deploy can actually upload; the full 48 MB `assets/` tree fails to
upload. The path is right, the directory is gitignored:

```text
✘ [ERROR] The directory specified by the "assets.directory" field in your configuration
  file does not exist: /.../worker/.edge-assets
```

```sh
bash scripts/stage-edge-assets.sh   # rebuilds .edge-assets, then the dry run passes
```

`wrangler.trim.jsonc` has the same shape: `.trim-assets` is gitignored too, and is hardlinked
from `assets/drupal-trim` by hand (see the pack-trim section of `TECHNICAL_REPORT.md`).

`scripts/bench/bench-ab.mjs` still carries an explicit `mbonly: 'static-mbstring'` entry in its
gzip-size map; its fallback already resolves `mbstring` to `static-mbstring`, so that entry can
go with the config.

**The bench harnesses no longer find these configs.** `scripts/bench/bench-ab.mjs` and
`scripts/bench/bench-variant.mjs` both build the path as `wrangler.probe-<variant>.jsonc`, relative
to the working directory, which was the repo root before the move. They need
`experiments/wrangler/` prefixed.
