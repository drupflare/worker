# Reproducing The Numbers

The commands that regenerate the figures on the impact pages, so a reader can check a number against its instrument.

```sh
bun scripts/measure/vps-energy.ts run --ssh="$HOST" --target="$VPS_ADDR" --target2="$DRUPFLARE_ADDR" --ladder=2,4,8 --n=5
bun scripts/measure/render-fraction.ts
bun scripts/economics/perview.ts
bun scripts/economics/states.ts
bun scripts/economics/device.ts
bun scripts/economics/fleet.ts
bun scripts/economics/comparison.ts --md
bun scripts/economics/comparison.ts --crossover
bun scripts/economics/comparison.ts --sites=426 --views=82160
bun scripts/economics/bindings.ts
```

The first command needs a bare-metal x86 host with readable RAPL counters and a load generator on a
different machine. A virtual machine cannot substitute: a Cloudflare Container exposes no energy
counter at all, and a mainstream KVM guest exposes a `power` PMU that reads a constant zero, which a
tool reports as 0 W. `--ladder` is required for a per-request figure. One rate cannot separate the
cost of a request from the cost of the package being awake, so the two arms are read at the same
request count.

Conventional host prices live in `scripts/economics/hosting-catalog.json`: every plan and rate carries
the provider page it was read from and the line quoted from it, and `tests/node/hosting-catalog.spec.ts`
fails on one without a source. The economic models live in `scripts/economics/`. Every measured input they take is in one file with
its provenance and the workload it was taken under, because a render cost measured with cold caches
and a render cost measured on the invalidation path differ by 35x and are not substitutable.
