# Measurement Classes

Every number this project produces belongs to one of four classes. The class decides which
instrument may produce it, where it may be archived, and whether a regression in it can fail a
build. Picking the wrong class is how a verdict moves without the system changing: of the free-tier
verdicts that have moved here, four out of five moved because the instrument was wrong.

| Class | What it is          | Instrument                  | CI     | Gated |
| ----- | ------------------- | --------------------------- | ------ | ----- |
| A     | Counts and bytes    | `collect-metrics.ts`        | Yes    | Yes   |
| B     | Same-process ratios | PHP closures, paired probes | No     | No    |
| C     | Absolute wall clock | None that is trustworthy    | Banned | No    |
| D     | Deployed CPU        | `wrangler tail`, `cpuTime`  | Manual | No    |

## Class A: Deterministic Counts and Bytes

Same input, same output, no clock. A bundle's gzipped size, the number of `CREATE INDEX` statements
in the shipped pack, the charged rows one stored row costs, the chunk count of a migration, the
number of collected test cases. Asking the question twice gives the same answer by definition.

This is the only class a shared CI runner can produce honestly, so it is the only class the
`Class A Metrics` workflow collects, archives and gates. `scripts/measure/collect-metrics.ts`
emits one JSON document; `scripts/measure/metrics-gate.ts` compares it to the document archived by
the last passing master run and exits non-zero when a metric crosses its tolerance.

The baseline is that archived document, fetched with `gh run download`. There is no committed
baseline file: the one that existed had to be refreshed by hand whenever master moved, so it was
not, and it recorded 305,599 driver-pack bytes against an actual 331,533 and a case count no run
had been able to collect. `--require-baseline` makes a download that produced nothing a failure
rather than a thin pass on the two checks that need no baseline at all.

The document carries no timestamp. Two runs on one commit produce identical bytes, so a diff
between two archived documents is a real change rather than a clock reading.
`tests/node/metrics.spec.ts` asserts that property directly.

Three rules keep the class honest:

- **A metric whose inputs are absent reports `{ "skipped": "<why>" }`.** Never omitted, never zero.
  A zero would be compared against a baseline and pass a no-decrease check.
- **The gate fails when no check could be evaluated.** A run where everything skipped is
  indistinguishable from a run where everything passed, and a step that can only skip is worse than
  no step.
- **Tolerances live in code, not in the baseline.** A newer master document moves the recorded
  values and cannot widen what is allowed. The baseline is data; `CHECKS` is the contract. What a
  master-relative baseline gives up is the cumulative reading -- creep since a release rather than
  since the previous commit -- which the absolute checks carry instead, and which any archived
  document restores by being passed as `--baseline-metrics`.

### What the Toolchain Contributes

Two Class A metrics are deterministic only against a pinned toolchain. The bundle figure is what
wrangler's own compressor prints, so the wrangler version travels with the number in the document.
The collected case count comes from `vitest list`, which is collection without execution. A version
bump moves either one, the gate reports it, and the next master document records the move.

### What Was Rejected From Class A

**Coverage percentage.** It depends on which specs ran. Artifact-gated specs skip when
`assets/drupal-sql` is absent and `tests/node/zlib-php.spec.ts` skips without a PHP binary carrying
ext-zlib, so the same source yields different coverage on different machines. The repository already
enforces coverage thresholds in `vitest.config.ts` through the `Check Test Coverage` workflow, which
is the right place for a number that depends on the lane.

**The node lane's test-case count.** `tests/node/zlib-php.spec.ts` builds its `it.each` table from a
live `php` subprocess, so the count changes with whether PHP is installed and with what that driver
reports. It is an environment reading wearing a count's clothes. The lane's spec-FILE count is
collected instead, because a glob over the checkout is deterministic everywhere.

## Class B: Same-Process Ratios

A ratio between two measurements taken in one process, in one invocation, on one machine: the
bucket attribution that puts event dispatch at 4.3x native, `cache_contexts` at 5.8x, the renderer
at 1.6x. Both halves move together when the machine is loaded, so the ratio survives what the
absolutes do not.

These stay out of CI. A ratio is only meaningful next to the conditions it was taken under, and a
runner cannot state those conditions. They are recorded in `TECHNICAL_REPORT.md` with the cache
bins that were emptied, the `n`, and the spread, which is what makes them readable a year later.

## Class C: Absolute Wall Clock

Banned outright, in CI and out of it.

In-PHP `microtime()` returns 0 on the edge. `Date.now()` inside the isolate returns 0 or a
plausible wrong number; it has reported 114 ms for a 1,374 ms invocation. Zero is obviously broken
and 114 survives review, which is what makes this class dangerous rather than merely useless. A
local `wrangler dev` wall clock cannot even order two profiles correctly.

Nothing in the metrics workflow may emit, archive or render a duration. `tests/node/metrics.spec.ts`
asserts that the collected document matches no `durationMs`/`elapsed`/`timestamp` key and that the
rendered summary carries no millisecond figure, so the ban is enforced rather than remembered.

## Class D: Deployed CPU

The only trustworthy absolute: `cpuTime` from `wrangler tail` on a deployed worker, with
`durableObject` events explicitly requested, because a tail silently omits them otherwise and an
empty tail proves nothing.

It cannot be automated here. It needs a real deploy against an account that holds production
workers, a `cfw-*` name, a teardown, and a check that the worker list returns to its prior
baseline. It also needs an `n` and a spread with every figure: the platform is bimodal by 400-600 ms
on the same object, so an n=1 or n=3 verdict about anything under ~500 ms is unsupportable.

That makes it a `workflow_dispatch` shape with a credential and a human deciding to spend it, never
a nightly. `scripts/measure/read-tail-cpu.mjs` is the reader; the readings live in
`TECHNICAL_REPORT.md`.

## Running It

```sh
bun run metrics                         # the document, to stdout
bun run metrics --no-bundle --no-vitest # the cheap collectors only
bun run metrics --out=dist/metrics.json
bun run metrics:gate --metrics=dist/metrics.json # exits 1 on a regression
bun run metrics:gate --metrics=dist/metrics.json --baseline-metrics=master.json
bun scripts/ensure-artifacts.ts --dry-run # what a lane can and cannot measure here
```

`bun scripts/ensure-artifacts.ts` produces what the collectors read, and CI runs it before the
collector. Three of the four inputs need no release payload: `assets/drupal/site.sqlite` is tracked
so `assets:sql` always works, the modules come from the sibling checkouts, and the interpreter comes
from the public CDN with no credential. Only `assets/drupal-pf` needs a payload, and no gated metric
reads it, so a clean checkout gates every Class A metric and one reporting itself as not collected
means something broke rather than something is missing.

A master run that could not measure a metric contributes no baseline value for it rather than a
zero, so a partially hydrated master run cannot silently drop the bundle figure to nothing.
