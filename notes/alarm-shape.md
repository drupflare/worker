# Alarm Shape

`ALARM_SHAPE` picks how a request moves the fill alarm. With the var unset the shape is `delay`,
and no response header changes in any mode. No request header is read.

## Modes

| Value      | What a request does to the alarm                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `head`     | The alarm moves one tick out, as the code did before `delay` became the default.                                      |
| `delay`    | Default, and what a missing or unknown value reads as. Every request-path move lands at least `ALARM_DELAY_MS` ahead. |
| `end-sync` | No request-path move. The request ends with a commit, then one un-awaited move.                                       |

`delay` floors the pull-in in the serve route, `setAlarmAt()` and `armFillAlarm()`. A longer ask is
left alone, and a standing alarm already inside the floor is kept. `ALARM_DELAY_MS` is a whole number
from 1,000 to 60,000; anything else reads as 5,000.

`end-sync` drops those same three, including asks longer than one tick. At the end of the request it
reads `getAlarm()`, awaits `sync()`, then calls `setAlarm(now + 1)` without awaiting it, when no alarm
is stored or the stored one is more than 50 ms out.

An alarm firing runs `head` in every mode (`alarmDepth` counts the firings running). `end-sync` also
skips its end move while a firing runs, because the alarm a firing is working under can read as none.
The serve route's pull-in follows the shape even when a request overlaps a firing, as the deployed
A/B did.

## Measured

One Thunder build, one site, one object, blocks of six requests (perf, cache clear, status, modules,
content, perf) with the arms interleaved: 50 blocks and 300 requests per arm, on 2026-11-22 against
a copy of this tree's HEAD (b4288951d1) with a per-request header toggle. `delay` was run as `a5`
(5,000 ms) and `end-sync` as `se`. The older Thunder drives (R7 to R9, the censuses) ran a frozen
older copy of the worker, so their rates do not describe this tree.

| Arm             | Requests | Reset requests | Blocks with a reset |
| --------------- | -------: | -------------: | ------------------: |
| `head`          |      300 |             47 |               27/50 |
| `delay` (5,000) |      300 |              0 |                0/50 |
| `end-sync`      |      300 |              2 |                2/50 |

A reset is the `x-cfw-retried: reset` or `x-cfw-object-reset` header, or the storage-reset exception
in the tail. At block level `delay` against `head` is p 5.6e-11 and `end-sync` against `head` is
p 1.1e-8 (one-sided Fisher). The request-level values are smaller and overstate independence.

The bare-object chain runs (24 events per chain, 20 chains per arm, folio's `experiments/alarm-retirement`)
count resets at isolate retirements:

| Shape at the end of an event                | Retirements | Resets |
| ------------------------------------------- | ----------: | -----: |
| `start-near-awaited`                        |           9 |      9 |
| `end-near-unawaited`                        |           6 |      6 |
| `start-5s-awaited`                          |           8 |      0 |
| `end-sync-then-near` (the `end-sync` shape) |          13 |      0 |
| `no-alarm`                                  |           9 |      0 |

## Caveats

- One site, one Thunder build, one object. Nothing here shows the rate on another site.
- The arm order was fixed (head, then `delay`, then `end-sync`) and the arms share one isolate, so a
  retirement lands on whichever request is running and carry-over from the previous arm is mixed in.
- Resets cluster by block. Read the block-level figures.
- No cause is shown. The runs show the shape matters and leave open which part does: `end-sync`
  also adds one `sync()` per request, and `delay` raises every held arm to the floor.
- `delay` postpones queued post-response work. The median time from a response to the next alarm
  firing was 8.2 s in the `delay` arm against 3.1 s for `head`. `end-sync` read 11.0 s because the
  request stream kept the object busy; that figure reflects the traffic as well as the shape.
- `delay` starts a never-migrated site's first migration later: about 6 s after the first request in the
  workers rig, against about 2 s under `head`. `setAlarmAt()` keeps a standing alarm that is already
  inside the floor. Without that, each retry of the migrating page (every 2 s) pushed the alarm out
  again and the migration never started; `serve-edge.spec.ts` caught it.
- Some `end-sync` requests that overlapped a firing took no end move, and the A/B did not count
  how many.

## Changing It

`delay` at 5,000 ms is the default, so a site needs no var. Add `ALARM_DELAY_MS` to change the
floor. To get the old one-tick move back, set the var on the Worker, in `wrangler.jsonc`:

```jsonc
"vars": { "ALARM_SHAPE": "head" }
```

or at deploy time with `wrangler deploy --var ALARM_SHAPE:head`. `scripts/e2e/live-deploy.ts` takes
`--var=ALARM_SHAPE=head`. Neither change touches stored data.

## Reading It

The owner route `/serve-stats` reports three fields beside `alarmFirings`:

- `alarmShape`: the mode the object resolved from the var (`delay`, `head` or `end-sync`).
- `alarmMoves`: the alarm moves made outside a firing since this incarnation started. It counts in
  `head` too, so a baseline is readable before the flag is set. A hibernation resets it.
- `alarmLastDistanceMs`: how far ahead of now the last of those moves was set, or `null` before one.
  Under `delay` it sits at or just under the floor. Under `end-sync` it is about 1, and under
  `head` it is whatever the last ask was, usually 1.
