# Carbon

Carbon figures for Drupflare and the hosts it is compared with.

Carbon is energy multiplied by a grid factor. The factor here is 384 g per kWh, the US average in Ember's Global Electricity Review 2025 [[13]](references.md). Neither system controls the grid factor. The figures are `derived` by `bun scripts/economics/fleet.ts`, from the energy totals on [Energy](energy/index.md) and [Fleet Energy](energy/fleet.md). The first tables are for one site against the production baseline, the later ones for the fleet.

With E the annual energy in kWh, G the grid factor in g per kWh and the result in kg CO2e a year:

```math
\text{CO}_2\text{e} = \frac{E \cdot G}{1000}
```

Energy and carbon per site per year, `derived`:

| deployment                  | energy (a year) | CO2e (kg a year) |
| --------------------------- | --------------: | ---------------: |
| production                  |         224 kWh |             86.1 |
| peak-sized production       |         390 kWh |              150 |
| worst case, one small VPS   |        9.34 kWh |             3.59 |
| drupflare, 1M views a month |         18.3 Wh |          0.00701 |

Moving one site from peak-sized production to drupflare at a million views a month avoids 390 kWh
and 150 kg of CO2e a year, `derived`.

The production row is the latency-matched shape in `scripts/economics/energy.ts`: three regions of four nodes,
each node 4 vCPUs at 15% utilisation. Peak-sized production is the same three regions and four nodes at 8 vCPUs
and 10% utilisation. The worst case is one 2 vCPU VPS sharing a 640-thread host at 15%, the case that leaves
drupflare the smallest saving. The drupflare row is `drupflareKwhYearOnMix` at one million views a month, from
`scripts/economics/perview.ts`. A host draws 135 W idle and 711 W at full load, interpolated linearly by
utilisation, with the colocation PUE of 1.54 over 8,766 hours a year. The rows come from the last block of
`bun scripts/economics/fleet.ts`, printed as "per site, per year, derived".

CO2e avoided per year by the fleet comparison, 1,000 sites against shared hosting, `derived`:

| views/site/month | CO2e avoided per year, 1,000 sites |
| ---------------: | ---------------------------------: |
|           10,000 |                             701 kg |
|          100,000 |                             712 kg |
|        1,000,000 |                             800 kg |
|       20,000,000 |                           1,429 kg |
|      100,000,000 |                           1,876 kg |
|    1,000,000,000 |                           3,975 kg |

These figures use the fleet model's quoted arm, the one with the smallest saving. Through 150 million
views that is shared hosting charged the measured native costs, which are lower than drupflare's wasm
costs, so the opponent's energy and the carbon avoided are lower than a drupflare-cost opponent would
give. At 1 billion views the quoted arm is the `same-cost` one.

Each row is the quoted arm's shared-hosting energy minus drupflare's energy at that traffic, times the grid
factor. `bun scripts/economics/fleet.ts` prints the rows under "carbon and water avoided per year, 1,000
sites". Its shared-hosting arms are described in `scripts/economics/fleet.ts`: the same-cost arm charges
drupflare's own per-request CPU, and the two native arms charge the measured nginx and PHP-FPM costs.

A second accounting is less favourable. Charging drupflare its share of Cloudflare's entire published
Scope 2 footprint [14] divided by every request the network serves [15] gives 24.6 micrograms of CO2e
per request, which includes DNS and attack traffic a cached page has nothing to do with. Under that
accounting, and charging three requests per page view, drupflare's attributed carbon crosses one
site's share of shared hosting at about 792,000 views per month. Below that the saving is 87% to
99%. Above it the saving inverts.

`bun scripts/economics/attributional.ts` prints the per-request figure, the saving at 10,000, 100,000 and 1,000,000 views a month, and the crossover. `bun scripts/economics/crossover.ts` prints the crossover at one, two and three requests per view.

## Choosing a Grid Factor

The US average is 384 g per kWh [13], and the EU's 2024 factor is 213 g per kWh [13]. At 213, the fleet CO2e figures above are 55% of their US values. Report energy first, and carbon with its factor named: two systems on the same regional grid can differ in kWh and barely differ in kg CO2e, or the reverse.
