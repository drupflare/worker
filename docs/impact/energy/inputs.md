# Where The Figures Come From

Three deployments appear on this page, and they are not equally observable.

| deployment                           | label                          | what it answers                            |
| ------------------------------------ | ------------------------------ | ------------------------------------------ |
| conventional VPS, nginx plus PHP-FPM | `measured`                     | joules per cached serve and per render     |
| drupflare on standalone `workerd`    | `measured`                     | the same, for this runtime, on one counter |
| drupflare on Cloudflare              | measured CPU, `derived` joules | the workload; joules need published W/core |

Rows one and two run on the same machine against the same RAPL counter, so the runtime comparison
under [Energy Per Request](per-request.md#energy-per-request) is a measurement. Row three stays derived: Cloudflare exposes no energy
counter to a container and no energy field in its analytics, so its CPU time is read and its wattage
is an allocation.

## Model Inputs

Each input to the model, with the file that holds it in `scripts/economics/` or `scripts/measure/`
and its reference on [Impact](../references.md#references) where one exists.

- **Server power.** The 135 W idle draw and 711 W full-load draw, with the 256 W at 10% load and 466 W
  at 50%, are the SPECpower result [[1]](../references.md). `scripts/economics/energy.ts` holds them as `IDLE_W`,
  `PEAK_W` and `SPEC_LOAD_POINTS`.
- **Cores and memory.** 320 cores, 640 hardware threads and 384 GiB of memory come from the same
  result [1], held as `CORES`, `THREADS_PER_HOST` and `HOST_MEMORY_GIB` in `scripts/economics/energy.ts`.
- **PUE.** `PUE_COLO` is 1.54, the Uptime Institute 2025 weighted average [6]. `PUE_HYPER` is 1.15, the
  worse end of Uptime's 1.10 to 1.15 hyperscale band [6], and it prices drupflare's Cloudflare side.
  Both are in `scripts/economics/energy.ts`.
- **Per-core charge.** `W_PER_CORE` in `scripts/economics/energy.ts` is computed from the server power
  and core count above. It has no source of its own.
- **Traffic mix.** The share of views in each class is in `config/traffic.yml`: 82% anonymous cached,
  9.5% anonymous miss, 3% each for signed-in front-end and editor views, and 2.5% for a signed-in
  user's own page. `scripts/measure/verdict-math.ts` loads it as `TRAFFIC_MIX`. The file gives a reason
  for each class, not a source for the weights.
- **Render fraction.** `pageStoreFraction` in `scripts/measure/render-fraction.ts` takes the monthly view
  count, with the save rate and pages per save as defaults. `scripts/economics/perview.ts` calls it for
  drupflare. The file marks the result `derived (modelled)`.
- **CPU per view.** A warm-bin render is 60.2 ms and a cached serve is 1.8 ms, front worker plus object,
  both in `scripts/economics/measured.ts`. The render figure is Durable Object `cpuTime` on a deployed
  paid worker, per the comment on `RENDER_WARM_BIN_MS`.

## The Two Hosts

Joules come from one machine and Cloudflare CPU time from another, because only one of the two can
report energy at all. Both were probed before either was used.

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

The container runs as root with the full capability set, no seccomp filter, a writable `/sys` and
`/dev/cpu/0/msr` present, and still has no energy counter: `/sys/class/powercap` is absent, no
`power` PMU is registered, the AMD RAPL MSRs answer `I/O error` and the Intel ones return a constant
zero. `nomodule` on the kernel command line means no driver can be inserted to change that.

`paisley-park` has the counter the comparison needs. `/sys/class/powercap/intel-rapl:0` exposes
`package-0` and `core` domains with a 65,532,610,987 uJ range. The file is root-only by default
under the Platypus mitigation, and a session-scoped permission change makes it readable.

Two readings from the container. Its `lite` instance type is enforced outside the guest's view: the
guest sees one full vCPU and `nr_throttled` stays at zero, while `/proc/stat` reports 48% of wall
clock as steal time, which is how the 1/16 share arrives. And its own accounting sits between
Cloudflare's two published datasets for the same run, at 11.06 CPU-seconds against 5.59 reported for
the workload and 22.10 for the workload plus its micro-VM sandbox.

The container measures CPU time, memory, disk and network, and can never measure joules.
`paisley-park` measures processor-package joules for both runtimes, drupflare under standalone
`workerd` and the VPS stack, and cannot measure the wall, because a wall meter needs physical access.
Neither host can measure drupflare on Cloudflare's own hardware. That side is `cpuTime` from a
deployed worker priced at watts per core, and the per-view figures price both arms from CPU time at
the same watts, so a measured joule is never set against a derived one.
