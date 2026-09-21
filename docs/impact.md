# Impact

What drupflare costs to run, in money, electricity, carbon and water, and how far each figure can be
trusted.

## Measurement Labels

Every number here carries one of three labels, and they are not interchangeable.

| label                | meaning                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `measured`           | read off an instrument on real hardware, with an n and a spread         |
| `derived`            | arithmetic over measured inputs and published constants                 |
| `derived (modelled)` | arithmetic that also takes an input nobody has measured for a real site |

A figure never moves up a tier by being repeated.

### Where Each Figure Comes From

Three deployments are involved and they are not equally observable.

| deployment                           | label                          | what it answers                            |
| ------------------------------------ | ------------------------------ | ------------------------------------------ |
| conventional VPS, nginx plus PHP-FPM | `measured`                     | joules per cached serve and per render     |
| drupflare on standalone `workerd`    | `measured`                     | the same, for this runtime, on one counter |
| drupflare on Cloudflare              | measured CPU, `derived` joules | the workload; joules need published W/core |

Rows one and two are the same machine and the same RAPL counter, which is what makes the runtime
comparison below a measurement rather than a model. Row three is permanently derived: Cloudflare
exposes no energy counter to a container and no energy field in its analytics, so its CPU time is
real and its wattage is an allocation.

## Energy Per Request

`measured`. RAPL package and core domains on a bare-metal AMD Ryzen 9 9900X, load generated off-box,
arms rotated per round, idle subtracted, n=5 per rung with no sample discarded. Both stacks run on
the same machine against the same counter in one interleaved run: the shipped `docker/vps.yml`
(nginx plus PHP 8.5 FPM with opcache and JIT) and drupflare under standalone `workerd serve`, each
capped at 3 CPUs by cgroup.

The cap is the VPS stack's total, `vps-php` at 2 plus `vps-web` at 1. It was read back from the
running containers as a `cpu.max` of `200000 100000` and `100000 100000` rather than from the compose
file, because a `deploy.resources` block is honoured by some Compose versions and ignored by others.

### A Per-Request Figure Needs Its Rate

The same arm reads 279, 202 and 131 mJ per request at 29, 57 and 114 requests per second. The decline
is the processor package leaving its idle C-states, a step that costs the same whether the window
carried 300 requests or 1,100. Idle subtraction cannot remove it, because it is absent from the idle
arm by definition. A per-request figure quoted without its rate is that fixed cost divided by
whatever throughput the run happened to reach.

Splitting the curve into a fixed term and a marginal term does not rescue it. The marginal cost
itself falls with rate, 123 mJ per additional request between 29 and 57 per second against 60 mJ
between 57 and 114, so the curve is concave and a fitted slope describes the spacing of the rungs.
Both arms are compared at the same request count instead, interpolating between measured rungs.

### The Two Runtimes At Matched Load

Package joules over idle, per 10-second window. Two independent runs, n=5 and n=3 per rung, 104
samples with zero failed requests. The second ran on a freshly provisioned site.

| tier   | requests | drupflare | VPS      |  ratio |
| ------ | -------- | --------- | -------- | -----: |
| cached | 565      | 114.62 J  | 114.72 J | 0.999x |
| cached | 1,101    | 154.60 J  | 147.28 J | 1.050x |
| cached | 532      | 105.53 J  | 100.68 J | 1.048x |
| cached | 1,043    | 145.51 J  | 144.62 J | 1.006x |
| render | 332      | 248.63 J  | 220.80 J | 1.126x |
| render | 409      | 253.31 J  | 252.27 J | 1.004x |
| render | 342      | 247.23 J  | 218.48 J | 1.132x |
| render | 408      | 255.39 J  | 241.69 J | 1.057x |

**The two runtimes cost the same energy per request to within about 13%**, on identical hardware, on
both the cached tier and a full render. PHP compiled to wasm and executed inside a Durable Object is
not cheaper per unit of work than native PHP-FPM, and it is not meaningfully more expensive either.

That agrees with the same-machine timing already on record: a re-render on a tag-invalidated page is
24 ms on the VPS against 30 on drupflare, and a page whose dynamic page cache is still warm is 24
against 22.

Throughput is not at parity. On this host the VPS stack saturates near 525 requests per second and
the drupflare arm near 220, because a site is one Durable Object and a Durable Object is
single-threaded, against 32 PHP-FPM children. The replica pool exists for that and was not enabled
here. Both arms were driven well below their ceilings so the energy figures measure work rather than
queueing.

### What The Idle Floor Costs

| arm        | package | core   |
| ---------- | ------- | ------ |
| idle floor | 18.17 W | 0.15 W |

**RAPL covers the processor package only.** PSU loss, fans, drives and DRAM sit outside its domains,
so these are a floor on machine energy rather than a total. Bounding the wall draw from a measured
29.3 W DC floor and an 80 Plus Bronze supply gives 35 to 42 W, depending where a 750 W unit running
at a few percent load sits on its efficiency curve. A wall meter needs physical access to the host
and has not been run.

On Cloudflare the equivalent readings are CPU time rather than joules, taken from `cpuTime` on a
deployed worker: **60.2 ms** for a re-render on a page a content change invalidated, and **0.42 ms**
of Durable Object time for a cached serve. A page served from the previous generation at the edge
answers in **12 ms** at the median and costs no Durable Object invocation at all.

## The Two Hosts

The energy figures above come from one machine and the CPU figures from another, because only one
of the two can report energy at all. Both were probed before either was trusted.

|                | Cloudflare Container             | `paisley-park`           |
| -------------- | -------------------------------- | ------------------------ |
| kind           | Firecracker microVM              | bare metal               |
| processor      | AMD EPYC, Zen 4                  | AMD Ryzen 9 9900X, Zen 5 |
| cores visible  | 1 vCPU                           | 12 cores, 24 threads     |
| cores enforced | 1/16 vCPU on the `lite` type     | all                      |
| memory         | 256 MiB                          | 30 GB                    |
| kernel         | `6.18.36-cloudflare-firecracker` | Ubuntu 24.04, 6.8        |
| discrete GPU   | none                             | RTX 4070, 11.1 W idle    |
| power supply   | not visible                      | 750 W, 80 Plus Bronze    |

**The container has more privilege than expected and less instrumentation.** It runs as root with
the full capability set, no seccomp filter, a writable `/sys`, and `/dev/cpu/0/msr` present. None of
that helps: `/sys/class/powercap` is absent, no `power` PMU is registered, the AMD RAPL MSRs answer
`I/O error` and the Intel ones return a constant zero. `nomodule` on the kernel command line means
no driver can be inserted to change it. There is no counter being withheld; there is no counter.

**`paisley-park` carries the counter the comparison needs.** `/sys/class/powercap/intel-rapl:0`
exposes real `package-0` and `core` domains with a 65,532,610,987 uJ range. The file is root-only by
default under the Platypus mitigation, and a session-scoped permission change makes it readable.

Two readings worth carrying from the pair. The container's `lite` instance type is enforced outside
the guest's view: the guest sees one full vCPU and `nr_throttled` stays at zero, while `/proc/stat`
reports **48% of wall clock as steal time**, which is how the 1/16 share actually arrives. And the
container's own accounting sits between Cloudflare's two published datasets for the same run, at
11.06 CPU-seconds against 5.59 reported for the workload and 22.10 for the workload plus its
micro-VM sandbox.

**What each host can answer.** The container measures CPU time, memory, disk and network, and can
never measure joules. `paisley-park` measures processor-package joules and cannot measure the wall,
because a wall meter needs physical access. Neither measures the other's runtime, so the energy
figures describe the conventional arm and the CPU figures describe drupflare, and the two are not
subtracted from each other anywhere in this document.

## Where The Saving Comes From

Two mechanisms, and neither is a claim that PHP runs faster here.

**Conventional multi-tenant hosting for small sites is memory-bound.** Packed at 1,000 sites of 1 GB
on a 1.5 TB two-socket host, the fleet runs its processors at approximately zero and draws
1,823 kWh/year, of which 100% is idle. It buys processors it never uses and powers them
continuously. A Worker consumes energy only while a request executes.

**A page store invalidates on content change; a CDN expires on a clock.** `cfw_page` carries a
`stale_at` column set when a save invalidates a tag, so a cached page survives until the content
behind it changes. A CDN in front of a conventional origin re-renders every path, at every edge
location, once per TTL whether or not anything changed. Modelled at 20 million views per site per
month, that is 28.34% of requests rendering for a CDN and origin against 4.38% for drupflare: the
Durable Object absorbs 6.5x the renders, because a per-location cache miss reaches a page store
instead of an origin.

## The Render Fraction

`derived (modelled)`. Economic models for edge-cached hosting usually assume a flat share of
requests that render. That share is not a free parameter:

```
renders = sum over paths of min(requests, window / TTL)   per path, per edge location
          + saves x pages invalidated per save
```

The floor does not depend on traffic, so **the fraction falls as traffic rises**. It is a property
of a site's content-to-traffic ratio rather than a constant of the platform, and a single number for
a whole fleet is wrong in both directions: a common 1% assumption is first reached at roughly
723 million views per site per month, far above the range these models cover.

Two consequences for anyone reproducing this work. The edge-location count is the largest term, and
it spans 4.38% to 62.91% across one to fifty locations. And **any measurement taken from a single
source address reads a floor**, because a one-address generator drives one edge location while real
visitors spread across many.

`scripts/measure/render-fraction.ts` computes it, with each input named as measured or modelled.

## Fleet Energy

`derived`, from the measured inputs above. One thousand sites against consolidated shared hosting
behind a CDN, per-arm render fractions:

| views/site/month | shared hosting renders | drupflare renders | saving |
| ---------------: | ---------------------: | ----------------: | -----: |
|           10,000 |                100.00% |             7.69% | 99.95% |
|          100,000 |                100.00% |             0.77% | 99.84% |
|        1,000,000 |                 91.77% |             0.08% | 98.92% |
|       20,000,000 |                 68.41% |             1.53% | 93.59% |

The saving narrows as the opponent's processors finally get used. At the top of the range the shared
host reaches meaningful utilisation and still loses.

## Carbon

`derived`, and conditioned on a grid factor neither system controls. At 384 g/kWh, the US average
reported in Ember's Global Electricity Review 2025:

| views/site/month | CO2e avoided per year, 1,000 sites |
| ---------------: | ---------------------------------: |
|           10,000 |                             702 kg |
|        1,000,000 |                             878 kg |
|       20,000,000 |                           1,914 kg |

The EU factor of roughly 140 g/kWh gives about a third of these. **Report energy first and carbon
with its factor named.** Two systems on the same regional grid can differ in kWh and barely differ
in kgCO2e, or the reverse.

A second accounting exists and is less favourable. Charging drupflare its share of Cloudflare's
entire published Scope 2 footprint divided by every request the network serves gives 24.6 micrograms
CO2e per request, which includes DNS and attack traffic a cached page has nothing to do with. Under
that accounting, and charging three requests per page view, drupflare's attributed carbon crosses
one site's share of shared hosting at about 792,000 views per month. Below that the saving is 87% to
99%. Above it the hostile accounting inverts.

## Water

`derived` from the same kWh delta, using 0.375 L/kWh direct and about 4.55 L/kWh indirect.

| views/site/month |  direct | indirect |
| ---------------: | ------: | -------: |
|           10,000 | 0.69 kL |  8.32 kL |
|       20,000,000 | 1.87 kL | 22.68 kL |

**Water behaves differently from carbon and the totals must not be read the same way.** Carbon is
global and fungible. Water is local: the same volume saved in a water-stressed watershed and in a
wet one are not equivalent, and aggregate litres carry no information about which.

## Embodied Carbon

`published`, from lifecycle studies rather than from any measurement here. Boavizta's
`platform_compute_medium` archetype carries 900 kg CO2e embedded, range 461.8 to 2,089.0. At a
four-year life that is 225 kg CO2e per server-year, or 0.23 kg per site-year at 1,000 sites per
host.

**It is not automatically avoided.** A migrated fleet retires no hardware unless the previous
operator retires some. Embodied carbon here describes hardware a sufficiently efficient architecture
makes unnecessary, not emissions that stop when a site moves.

## Cost

`derived` from published Workers for Platforms rates. One thousand sites at 10,000 views each cost
$26.22 per month, or **$0.0262 per site**, of which 95.3% is the base subscription and 3.6% is
storage. The marginal cost of one more site is $0.0012 per month.

Published competitor pricing for comparison: Pantheon from $55 per site per month, Upsun from about
EUR 19 per project, Acquia commonly $30,000 to $60,000 per year. Those products include support,
SLAs and an account team; this figure is infrastructure only.

## What This Does Not Claim

- **No per-tenant Cloudflare wattage.** It is not observable. Probing a deployed Cloudflare
  Container found no energy counter by any of the six routes a Linux process has, and no energy
  field exists anywhere in the account's analytics schema. The Cloudflare side of every figure above
  is an allocation over measured workload and published hardware.
- **No claim that 1,000 sites replace 1,000 servers.** VPS providers and managed platforms already
  consolidate. The comparison is against hosting that has already captured most of the
  multi-tenancy saving.
- **Pantheon is a pricing baseline and not an energy baseline.** It is already multi-tenant, and how
  many machines it runs, how well utilised they are, and how much of that would persist without a
  given workload are all unobservable from outside.
- **No market-share multiplier.** A CMS's share of websites is a count of sites, not a quantity of
  compute. It changes the addressable population and transfers no measurement.
- **An incremental measurement is not a hosting total.** Idle-subtracted workload energy is what the
  rig produces. A continuously provisioned server also pays its idle, and the equivalent allocation
  on a shared edge fleet is the thing that cannot be measured.

## Reproducing The Numbers

```sh
bun scripts/measure/vps-energy.ts run --ssh= \
  --ladder=2,4,8 < host > --target= < vps > --target2= < drupflare > --n=5
bun scripts/measure/render-fraction.ts
```

`--ladder` is not optional for a per-request figure. One rate cannot separate the cost of a request
from the cost of the package being awake, and the two arms must be read at the same request count.

The first needs a bare-metal x86 host with readable RAPL counters and a generator on a different
machine. A virtual machine cannot substitute: a Cloudflare Container exposes no energy counter at
all, and a mainstream KVM guest exposes a `power` PMU that reads a constant zero, which a tool will
report as 0 W.

The economic models live in `scripts/economics/`. Every measured input they take is in one file with
its provenance and the workload it was taken under, because a render cost measured with cold caches
and a render cost measured on the invalidation path differ by 35x and are not substitutable.
