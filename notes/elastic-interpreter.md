# The elastic interpreter, closed

A translated PHP interpreter whose linear memory is paged into the object's SQLite, built so a request that needs more memory than the isolate allows could still finish. It was built, booted, rendered Drupal and ran on a deployed worker. It is closed, and the reason is structural: on this platform the memory limit and the wall-clock limit are one budget, and the translation spends the second to buy the first. The code stays under `experiments/elastic-tier/`. The seam and the `ELASTIC_EXECUTOR` setting are deleted.

Labels: measured (instrument named), derived (arithmetic from measured numbers), hypothesis. Each deployed figure below is n=1 per run, so none carries a spread.

## What it was

A Binaryen pass over the shipped interpreter (`php8.5.tuned.wasm`, 14,216,041 bytes) rewrites every load and store that is not stack-relative or a constant low address through a page table in the module's own memory. A miss calls a host import that faults a 64 KiB page in from, or out to, a page store in the object's SQLite. The pass needs no PHP rebuild. It lives in folio's research scripts, and `experiments/elastic-tier/build-elastic.ts` is the build that was run.

## What it cost

- **Size, measured:** 1,245,222 memory accesses in the binary, 472,522 of them checked after the exemptions. The inline form made the module 44,590,928 bytes (+30,374,887, all of it in the code section) and the deployable bundle 63,846,354 bytes against the 67,108,864 ceiling. A call-shaped form costs +4.4 MB and was not the one run on a platform.
- **Speed, measured:** local workerd, stock Drupal, medians of 3 to 4: `/` took 55 ms native and 153 ms translated with no eviction, 118 ms at 512 frames and 367 ms at 256. Deployed `cpuTime` on a Thunder object: admin modules page 3.9 to 6.2 s native against 17.2 s (2.8 to 4.4x), cron page 3.6 against 7.9 s (2.2x), the first-run warm phase 8.5 to 10.5 s against 28.9 s (2.8 to 3.4x).
- **Memory, measured and derived:** 768 frames held a logical heap of 76.0 MB in 56.4 MB of physical memory, a saving of 19.6 MB. The module itself added 30.4 MB of wasm bytes, and its compiled size was not measured.

## What happened deployed

| run | what it did                                                                      | how it ended                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | cap 104 MiB, elastic available, no forced refusal                                | 13 of 13 rows passed; the refusal that motivated the work did not reproduce, so nothing escalated                                                                    |
| 2   | cap 80 MiB to force refusals, escalate in the same isolate                       | two refused requests served on the translated build, then about 25 consecutive requests died on isolate memory resets                                                |
| 3   | every boot translated                                                            | the first-run phase ended `exceededWallTime` at cpu 29.5 s, wall 34.7 s, and the object threw on every call afterwards                                               |
| 4   | flush, export, import and `/batch` aborted into a new isolate and run translated | the flush render ended ok at a logical heap of 90.0 MB, but the invocation was killed `exceededWallTime` at cpu 41.7 s, wall 47.2 s; the object threw for 17 minutes |

## Why it fails, and why that is structural

1. **The routes that overflow memory are the routes that are already long.** A flush is 6.3 s of `cpuTime` native, an enable step 10 to 24 s, the first-run phase 8.5 to 10.5 s. The wall limit on one invocation is about 30 s (a 30.3 s invocation passed and a 32.4 s one was killed), and `limits.cpu_ms` does not move it. A multiplier of 2.2 to 4.4x takes any route above about 7 to 10 s native past that line. Runs 3 and 4 are that arithmetic.
2. **The multiplier is not constant.** Paging cost grows once a route's working set outgrows the frames: the same render took 118 ms at 512 frames and 367 ms at 256. A route large enough to need paging has a large working set, and the frames come out of the same isolate budget they are meant to relieve. Run 4's flush needed at least 6x.
3. **The footprint spends the headroom.** The translated module is 30.4 MB larger, its compiled code and page table sit in the isolate, and the frames are physical memory. Against a saving of 19.6 MB of heap at 768 frames the net gain is near zero or negative (derived; the compiled code size is the missing term). Run 1 took four memory resets where an earlier native run took one (n=1 each, cause unknown).
4. **It cannot start beside a native heap.** Escalating inside the isolate that just refused a request leaves the dropped native heap reachable, and run 2 shows the result. The only clean start is a new isolate, which costs the whole wall budget again. A collection gate does not change this: waiting for a dropped host graph to be collected before booting did not stop the deaths that follow an in-request drop.
5. **There is nothing to share instead.** No byte of one isolate is readable by another except through a message or storage, so paging to SQLite is the only elasticity the platform offers. Same-class objects shared an isolate in 8.75% of 80 in a tiny worker, and sharing one adds no capacity.

The cheaper memory ideas fell the same way. Evicting function bodies and doc comments recovered 6.4 to 9.1 MiB against a 10 MiB bar, and the three suspected holders of the flush peak freed nothing when released (a forced collection freed 0.6 MiB). Deferring the container rebuild moved the peak.

## What it does not close

The objective stays: finish a route that needs more linear memory than the platform allows. The mechanism, a translated interpreter paged to SQLite, is closed. The route that motivated it, a Thunder configuration export refused growing from 108,920,832 to 109,248,512 bytes against a 109,051,904 cap, needed none of it. That heap came from one resident interpreter climbing through the flush (90.6 MB), the performance form (99.8), the front page (102.9) and the export, and a repeat on a fresh interpreter passed every time. What does the work today is the governor, the slice rollback, the stepped enable, the repeat on a fresh interpreter and the abort that starts one.

## What would reopen it

A route whose native demand on a fresh interpreter exceeds the isolate's capacity and whose native `cpuTime` is under about 8 s, so that a 3x cost still fits the wall limit. None is on record. The Thunder configuration export is the one candidate, and its fresh-interpreter demand is unmeasured because the tree cannot run in the local pool. The two missing measurements if it is wanted: the flush on the translated build in a new isolate with the wall limit not binding, and the cause of the dead object after `exceededWallTime`.

## Where the pieces are

`experiments/elastic-tier/` holds the build, the size matrix, the compression timings, the timing spec, and copies of the pager, the binary wrapper and the executor, with the steps to restore them. The earlier gmux probe that paged 64 to 256 MiB strings on a translated 44 MB module read 20 to 62 s per paged Thunder render with CPU-limit resets (read from its notes, not re-measured here).
