# Notes

Topic files moved out of the project CLAUDE.md. Each section is verbatim. This table maps a section heading to its file.

| section                                                                                          | file                   |
| ------------------------------------------------------------------------------------------------ | ---------------------- |
| The interpreter has no fiber backend, and the executor is persistent                             | park.md                |
| The Zend park ships, and every instrument that measured it was wrong once                        | park.md                |
| THE COST OF LOADING EXTENSIONS IS AN EXPORTED GLOBAL, NOT A GROWABLE TABLE                       | memory-and-isolates.md |
| `subarray` THROWS ABOVE 128 MiB ON THE PLATFORM, AND A LOCAL WORKERD DOES NOT                    | memory-and-isolates.md |
| A DROPPED INTERPRETER'S MEMORY IS REUSED, NOT COLLECTED                                          | memory-and-isolates.md |
| A DEPLOYED MEMORY IS CHARGED AT ITS FULL SIZE, touched or not                                    | memory-and-isolates.md |
| A MEMORY RESET IS `overloaded`, NOT `retryable`, and a write before an await survives it         | memory-and-isolates.md |
| A LARGE SITE'S FRESH ISOLATE HAS ALMOST NO ROOM, and placement decides who survives              | memory-and-isolates.md |
| AN INSTALLED MODULE'S FILES CARRIED THE BOOT TIME, so every young isolate re-fetched update data | memory-and-isolates.md |
| THE PACK BLOB IN SQLITE WAS BUILT, MEASURED AND REMOVED                                          | memory-and-isolates.md |
| BACKGROUND PHP WAITS A MINUTE AFTER A BOOT, and `wrangler tail` blames the alarm for the visitor | memory-and-isolates.md |
| A CLAIM IS THREE INVOCATIONS, because a CPU kill rolls back everything in one                    | memory-and-isolates.md |
| The heap image is a COST on both meters, so the producer is off by default                       | memory-and-isolates.md |
| The cold-boot number to move is the FREQUENCY, not the milliseconds                              | memory-and-isolates.md |
| The heap peak is per WORKLOAD; the isolate is charged per INCARNATION                            | memory-and-isolates.md |
| A Durable Object hibernates at 10 s, and `KEEP_WARM_MS` is 24x that                              | memory-and-isolates.md |
| EVERY HEAP PEAK IN THIS REPO IS AN ALLOCATOR RUNG, NOT A DEMAND                                  | memory-and-isolates.md |
| PHP LOADS EXTENSIONS AT STARTUP, NOT PER REQUEST, and that bounds the whole idea                 | memory-and-isolates.md |
| Two platform questions answered from source, so nobody re-measures them                          | memory-and-isolates.md |
| A restored heap carries a warm interpreter's pending writes, and a tag counter cannot see them   | memory-and-isolates.md |
| There is a VPS arm now, and the headline ratio was an instrument error                           | lanes-and-pool.md      |
| THE POOL EVICTED ITSELF, AND THREE INSTRUMENTS HAD TO BE BUILT BEFORE THAT WAS READABLE          | lanes-and-pool.md      |
| A LANE PINNED ITS OWN ORIGIN, SO IT COULD NOT SEE ANY SESSION                                    | lanes-and-pool.md      |
| A FRESH SESSION IS NOT ON ANY LANE, and the fix must not be awaited                              | lanes-and-pool.md      |
| NO SAVE HAD EVER COMMITTED THROUGH A LANE, AND THE LANE SAID IT HAD                              | lanes-and-pool.md      |
| A PLAUSIBLE CAUSE THAT FITS THE SYMPTOM IS THE EXPENSIVE KIND OF WRONG                           | lanes-and-pool.md      |
| One object is not a site-wide throughput ceiling                                                 | lanes-and-pool.md      |
| The end-to-end host comparison exists, and every cross-arm number it gave is pending             | lanes-and-pool.md      |
| The compressed bundle limit is GONE, and it was shaping the architecture                         | packs-and-delivery.md  |
| An artifact a clean checkout cannot build is a lane boundary, not a failure                      | packs-and-delivery.md  |
| A BUILT ARTIFACT IS NOT A PUBLISHED ONE, and `.assetsignore` denies by default                   | packs-and-delivery.md  |
| `config/` is the declaration and `src/ops/generated/` is what the edge reads                     | packs-and-delivery.md  |
| A pack update reset the object, and the container rebuild was why                                | packs-and-delivery.md  |
| The container row is keyed to the PACK, and the guard that missed it compared the wrong tree     | packs-and-delivery.md  |
| The one-click deploy was refused by ONE binding, and it was not the one this file named          | packs-and-delivery.md  |
| A STATIC SURVIVES EVERY LATER RUN, and that is what made `/install` useless                      | packs-and-delivery.md  |
| Run the pack lane locally before pushing at it                                                   | packs-and-delivery.md  |
| The pack delivers only at provisioning, and reconciliation is the path for everything after      | packs-and-delivery.md  |
| `/modify` is the third delivery path, and the only one with history                              | packs-and-delivery.md  |
| A meter that is most of what it counts                                                           | cache-and-rows.md      |
| There are TWO stale tiers, and only `x-cfw-edge` tells them apart                                | cache-and-rows.md      |
| A POOL MULTIPLIES THE ROWS-WRITTEN METER BY THE LANE COUNT                                       | cache-and-rows.md      |
| The database HAS a producer now, and four claims here were stale                                 | database.md            |
| A shared base has nowhere to live, and the read-through was never the hard half                  | database.md            |
| The gate and production reach the SAME interpreter, as of 2026-09-07                             | measurement-history.md |
| How the gate and production USED to reach the interpreter by two different routes                | measurement-history.md |
| A DOCUMENTED FIX IS A CLAIM, and one was cited as settled for three weeks                        | measurement-history.md |
| A module can be on the edge while the FUNCTION that matters is not                               | measurement-history.md |
| A REDIRECTED-THROUGH URL IS A REQUEST, NOT A NAVIGATION                                          | measurement-history.md |
| The gate's time is IMPORT, and splitting a spec file makes it worse                              | measurement-history.md |
| A hook timeout that was real did not explain the intermittent blamed on it                       | measurement-history.md |
| The levers are writable now, and `PLAN` is deliberately not one of them                          | platform-facts.md      |
| The owner-token check had no failure budget, and the token was never the risk                    | platform-facts.md      |
| IMAGE STYLES SERVED THE FULL-SIZE ORIGINAL ON EVERY SITE                                         | platform-facts.md      |
| NO UPLOAD HAD EVER BEEN STORED, AND FOUR DEFECTS STOOD IN A ROW                                  | platform-facts.md      |
| Two defects that only a browser and a rig could find, and both were on every site                | platform-facts.md      |
| Workers Cache is dominated here, and a `ctx.exports` call is its own invocation                  | platform-facts.md      |
| A `run: false` is load-bearing, and three of them outlived their reason                          | platform-facts.md      |
| `supported` is not a state a module may be in                                                    | platform-facts.md      |
| A boot verifies nothing about a module, and a null answer was reading as a pass                  | platform-facts.md      |
| `fetch()` ALREADY HOLDS THE GATE, and acquiring it again hangs forever                           | platform-facts.md      |
| `x-worker-ms` ON A CACHED SERVE IS ~99% NETWORK HOP, NOT OBJECT WORK                             | platform-facts.md      |
| Three GraphQL traps that each read as an empty dataset                                           | platform-facts.md      |
| `/big_pipe/no-js` answering 400 is core, and the transport is what to guard                      | platform-facts.md      |
| The boundary sweep walks SERVICES now, not only class statics                                    | platform-facts.md      |
