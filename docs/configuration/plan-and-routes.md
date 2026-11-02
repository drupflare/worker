# Plan and Extensibility Routes

How the plan selects a limits profile, and which routes extend a site.

## Plan

| var    | default | what it does                                    |
| ------ | ------- | ----------------------------------------------- |
| `PLAN` | `free`  | selects the whole per-invocation budget profile |

`paid` and `free` are the only recognised values, and anything unrecognised is free: every limit
in this project is a free-plan limit, and a typo must not silently grant a 30 s CPU budget to
something that has 10 ms.

The plan sets five defaults in `src/ops/plan-profile.ts`. Four are numbers, and each has its own var,
so a paid profile can run on free or the reverse. The fifth, `bootInline`, is not configurable.

| profile field    | var                | free   | paid   |
| ---------------- | ------------------ | ------ | ------ |
| `fillBatchSize`  | `FILL_BATCH_SIZE`  | 5      | 8      |
| `httpDrainLimit` | `HTTP_DRAIN_LIMIT` | 3      | 15     |
| `mirrorLimit`    | `MIRROR_LIMIT`     | 2      | 10     |
| `inlineBudgetMs` | `RENDER_BUDGET_MS` | 10,000 | 10,000 |
| `bootInline`     | none               | on     | on     |

`bootInline` decides whether a MISS on a cold object may boot the interpreter and render inline, or
answer 503 and hand the path to the alarm chain. It is on for both plans.

The plan override lives in `CONFIG_KV`. The deployment-wide key `plan` applies to every site, and
`plan:<site>` overlays it for one site. Both are read at most once per isolate per minute, so an
account upgrade takes effect without a redeploy. A missing binding, a KV error and an unrecognised
value all fall through to the var.

## Extensibility Routes

`/installable`, `/install` and `/enable` take the owner token, the one `/firstrun` mints when the
site is claimed.

| route                   | what it does                                                           |
| ----------------------- | ---------------------------------------------------------------------- |
| `/installable?module=X` | resolves the package and names any conflict with the shipped lock      |
| `/install?module=X`     | fetches it and writes its files; runs the check first unless `force=1` |
| `/enable?module=X`      | installs it through Drupal's own module installer                      |

Separate steps, because a package that has landed is not yet a module Drupal knows about and the two
have different failure modes. `/install` also accepts `version=<constraint>` and `registry=npm`;
`drupal/*` resolves against `packages.drupal.org/8` and everything else against
`repo.packagist.org`.

A config import and a queue drain run in steps. `POST /ops?op=cim&drive=1` with the config objects as the
body, or `POST /ops?op=queue-drain&drive=1&arg=<queue>&limit=<n>`, runs the first step in the request and
leaves the rest to the alarm, one step per firing, until a step reports `done` or fails. A failed step
ends the job and stays failed. `cim` also takes `collections=a,b` and `budget=<units>`, which ride on
every step. `/serve-stats` reports the last step under `lastOpsJob` and the exec router's per-program
counters under `exec` on `/serve-stats?exec=1`.

A module you wrote yourself arrives through a git remote, or through `/modify` when it is not on a
host at all. `/enable` is the same next step either way.
