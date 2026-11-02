# Energy Per Request

`measured`. RAPL package and core domains on a bare-metal AMD Ryzen 9 9900X, load generated off-box,
arms rotated per round, idle subtracted, n=5 per rung with no sample discarded. Both stacks run on
the same machine against the same counter in one interleaved run: the shipped `docker/vps.yml`
(nginx plus PHP 8.5 FPM with opcache and JIT) and drupflare under standalone `workerd serve`, each
capped at 3 CPUs by cgroup.

The cap is the VPS stack's total, `vps-php` at 2 plus `vps-web` at 1. It is read back from the running
containers as a `cpu.max` of `200000 100000` and `100000 100000`, because a `deploy.resources` block
is honoured by some Compose versions and ignored by others.

## A Per-Request Figure Needs Its Rate

The same arm reads 279, 202 and 131 mJ per request at 29, 57 and 114 requests per second. The decline
is the processor package leaving its idle C-states, a step that costs the same whether the window
carried 300 requests or 1,100. Idle subtraction cannot remove it, because it is absent from the idle
arm by definition. A per-request figure quoted without its rate is that fixed cost divided by
whatever throughput the run reached.

A fixed-plus-marginal fit does not fix this. The marginal cost itself falls with rate, 123 mJ per
additional request between 29 and 57 per second against 60 mJ between 57 and 114, so the curve is
concave and a fitted slope describes the spacing of the rungs. Both arms are compared at the same
request count instead, interpolating between measured rungs.

## The Two Runtimes At Matched Load

`measured`. Package energy over idle per 10-second window, drupflare against the VPS stack at the same
request count. Two independent runs, n=5 and n=3 per rung, 104 samples with zero failed requests. The
second ran on a freshly provisioned site.

| tier   | requests per window | drupflare (J per window) | VPS (J per window) |  ratio |
| ------ | ------------------: | -----------------------: | -----------------: | -----: |
| cached |                 565 |                   114.62 |             114.72 | 0.999x |
| cached |               1,101 |                   154.60 |             147.28 | 1.050x |
| cached |                 532 |                   105.53 |             100.68 | 1.048x |
| cached |               1,043 |                   145.51 |             144.62 | 1.006x |
| render |                 332 |                   248.63 |             220.80 | 1.126x |
| render |                 409 |                   253.31 |             252.27 | 1.004x |
| render |                 342 |                   247.23 |             218.48 | 1.132x |
| render |                 408 |                   255.39 |             241.69 | 1.057x |

The two runtimes cost the same energy per request to within about 13%, on identical hardware, on both
the cached tier and a full render. PHP compiled to wasm and executed inside a Durable Object is
neither cheaper nor meaningfully dearer per unit of work than native PHP-FPM.

That agrees with the same-machine timing: a re-render on a tag-invalidated page is 24 ms on the VPS
against 30 on drupflare, and a page whose dynamic page cache is still warm is 24 against 22.

Throughput differs. On this host the VPS stack saturates near 525 requests per second and the
drupflare arm near 220, because a site is one single-threaded Durable Object while the VPS has 32
PHP-FPM children. The [replica pool](../../operating/replica-lanes.md) addresses that and was not enabled for this run. Both arms were
driven well below their ceilings, so the energy figures measure work and not queueing.

## Logged-In Views

`measured`. A logged-in administrator's view of `/admin/content` is answered by the compiled-plan tier
at 2.1 ms of CPU against 19.9 ms natively, and costs 503 mJ against 751 mJ per view on the same
machine, 33% less. Conditions: RAPL package on `paisley-park`, idle subtracted, 40 offered views a
second, n=6 to 7 rounds per cell, drupflare on a `bastion` node under a 3-CPU cgroup against the
shipped nginx and PHP-FPM stack at 3 CPUs.

## Service Bindings And R2

The shipped model charges a cached view 1.8 ms of CPU, which is a front-worker reading plus an object
reading (`measured`, 2026-09-14). A Worker-to-Worker call is its own invocation with its own CPU and no
request fee (`published`). An R2 binding read is a subrequest of the invocation that makes it, and a
public R2 bucket on a custom domain runs no Worker. R2 exposes no CPU and no energy counter, so the energy
bracket runs from zero to one extra Worker invocation a view:

| views a month | shipped, Wh a year | +1 Worker invocation a view, Wh a year | multiple, shipped | multiple, +1 invocation | saving, shipped | saving, +1 invocation |
| ------------: | -----------------: | -------------------------------------: | ----------------: | ----------------------: | --------------: | --------------------: |
|        10,000 |               0.53 |                                   0.62 |           426,766 |                 362,167 |        99.9998% |              99.9997% |
|       100,000 |               2.14 |                                   3.07 |           104,856 |                  72,905 |        99.9990% |              99.9986% |
|     1,000,000 |              18.26 |                                  27.63 |            12,274 |                   8,112 |        99.9919% |              99.9877% |
|    10,000,000 |             179.52 |                                 273.21 |             1,249 |                     820 |        99.9199% |              99.8781% |
|    30,000,000 |             537.86 |                                 818.93 |               417 |                     274 |        99.7601% |              99.6347% |

The extra invocation is charged 1.10 ms a view, the front-worker reading (`measured`, n not recorded),
or 2.81 mJ at the model's watts and PUE (`derived (modelled)`). It is a bound for a path the shipped
product does not take. The shipped headline already prices a Worker-to-object hop on every cached view, so
adding a hop to the shipped default moves nothing beyond that. Two terms do not move the headline by
their own measure:

- **Front worker on a render.** The 60.2 ms render is Durable Object CPU only. Adding 1.10 ms of
  front-worker CPU a render moves 1M views a month by 0.0071 Wh a year, 0.039% of the shipped figure
  (`derived (modelled)`).
- **R2 public bucket.** No Worker runs, so the energy term is zero. Its operations carry no wattage.

The term that moves the shipped figure is the cached-serve constant, not a binding. The 1.8 ms is charged
to every cached view, but 82% of views are answered by the edge cache in the front worker and never reach
the object. The measured whole-request p50 on that edge tier is 0.703 ms (`measured`, deployed free worker,
2026-09-10, reading taken before the in-isolate page memo). Re-basing to 0.703 ms would lower the 1M figure
by 7.66 Wh a year, from 18.26 to about 10.6 Wh (`derived (modelled)`). That is a decision about the
constant, not a result of this section, so the shipped figures are unchanged.

## What The Idle Floor Costs

Idle power of the processor package and cores, `measured` by RAPL with idle windows interleaved with
the load windows of each run:

| run             | package (W)               | core (W) |
| --------------- | ------------------------- | -------: |
| per-request run | 18.17                     |     0.15 |
| per-view run    | 20.65 (19.65-21.85, n=15) |     0.23 |

RAPL covers the processor package only. PSU loss, the VRM, the GPU, drives, DRAM, the chipset and
fans sit outside its domains, so these are a floor on machine energy. The whole machine is modelled
component by component below. No wall meter reading was taken, because that needs physical access to
the host.

<details>
<summary>Idle power by component</summary>

Each component of the host's idle power, with its label:

| component                       | power                     | label                                             |
| ------------------------------- | ------------------------- | ------------------------------------------------- |
| CPU package at idle             | 20.65 W                   | `measured`, RAPL                                  |
| CPU at idle, published          | about 40 W                | `published`, PC Gamer 9900X review, another board |
| CPU VRM loss                    | 12% of package            | `derived (modelled)`                              |
| RTX 4070 at idle                | 11 W                      | `measured`, `nvidia-smi`                          |
| WD2003FZEX hard drive           | 8.1 W idle, 1.3 W standby | `published`, datasheet, not checked on the drive  |
| NVMe SSD                        | 0.05 W in its idle state  | `measured`, NVMe Identify power states            |
| DDR5, chipset, board, fans      | modelled per part         | `derived (modelled)`                              |
| PSU efficiency, 20 W to 80 W DC | 62.9% rising to 81.3%     | `published`, Tom's Hardware, a sibling 750 W unit |

</details>

`derived (modelled)` from those parts, idle at the wall:

| case                                    | DC   | AC (wall) |
| --------------------------------------- | ---- | --------- |
| floor from measured RAPL, disks parked  | 46 W | 62 W      |
| floor from measured RAPL, one disk spun | 53 W | 69 W      |
| floor at the published 40 W CPU         | 69 W | 87 W      |
| reasonable, disks parked                | 75 W | 94 W      |
| reasonable, every disk spinning         | 87 W | 107 W     |

Disk spin state during the runs is unknown, so both cases are carried. Under load, marginal wall
energy is about 1.22 times the RAPL figure (PSU 1.09 between 60 and 80 W DC, VRM 1.12).

The idle figure does not transfer to a production server, and the direction favours the conventional
host. This is a desktop: 62 to 107 W at the wall for 24 threads, or 2.6 to 4.5 W per thread, with a
discrete GPU, two hard drives and a desktop chipset. A production server idles at 135 W for 640
threads, 0.21 W per thread for the whole machine (SPECpower [[1]](../references.md)). The idle-charged figures on this
host therefore overstate a production host's idle per view, and the energy model uses the
server figure. Ratios between arms do transfer, because both stacks run on the same processor. The
same wasm render takes 1.85 times longer on a deployed EPYC core than on this machine's cores, so
every Cloudflare figure is priced from `cpuTime` and not from these joules.

On Cloudflare the equivalent readings are CPU time rather than joules, taken from `cpuTime` on a
deployed worker: 60.2 ms for a re-render on a page a content change invalidated, and 0.42 ms
of Durable Object time for a cached serve. A page served from the previous generation at the edge
answers in 12 ms at the median and costs no Durable Object invocation at all.
