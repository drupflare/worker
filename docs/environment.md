# Environment

Carbon, water and embodied carbon, derived from the totals on [Energy](energy.md) and [Fleet Energy](energy-fleet.md). Figures keep the labels defined on [Impact](impact.md#measurement-labels). Citations in brackets refer to the [references on Impact](impact.md#references).

## Carbon

Carbon is energy multiplied by a grid factor. The factor here is 384 g per kWh, the US average in Ember's Global Electricity Review 2025 [13]. Neither system controls the grid factor. The figures are `derived` by `bun scripts/economics/fleet.ts`, from the energy totals on [Energy](energy.md) and [Fleet Energy](energy-fleet.md). The first tables are for one site against the production baseline, the later ones for the fleet.

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

### Choosing a Grid Factor

The US average is 384 g per kWh [13], and the EU's 2024 factor is 213 g per kWh [13]. At 213, the fleet CO2e figures above are 55% of their US values. Report energy first, and carbon with its factor named: two systems on the same regional grid can differ in kWh and barely differ in kg CO2e, or the reverse.

## Water

`derived` from the same energy totals, using 0.375 L/kWh direct and about 4.55 L/kWh indirect: US data
centres used 176 TWh in 2023, with 66 billion litres consumed directly and nearly 800 billion
indirectly through generation [16]. With E the annual energy in kWh and W the water in litres a year:

```math
W_{\text{direct}} = 0.375 \cdot E
W_{\text{indirect}} = 4.55 \cdot E
```

Water per site per year, `derived`, in litres:

| deployment                  | direct (L a year) | indirect (L a year) |
| --------------------------- | ----------------: | ------------------: |
| production                  |              84.1 |               1,020 |
| peak-sized production       |               146 |               1,775 |
| worst case, one small VPS   |              3.50 |                42.5 |
| drupflare, 1M views a month |           0.00685 |              0.0831 |

Moving one site from peak-sized production to drupflare at a million views a month avoids about
1,921 L of water a year, 1.9 kL, `derived`.

Water avoided per year by the fleet comparison, 1,000 sites against shared hosting, `derived`, in
kilolitres:

| views/site/month | direct (kL a year) | indirect (kL a year) |
| ---------------: | -----------------: | -------------------: |
|           10,000 |               0.68 |                 8.30 |
|          100,000 |               0.69 |                 8.43 |
|        1,000,000 |               0.78 |                 9.48 |
|       20,000,000 |               1.40 |                16.94 |
|      100,000,000 |               1.83 |                22.23 |
|    1,000,000,000 |               3.88 |                47.10 |

Each row applies the same two factors to the kWh gap behind the carbon table, from the same `fleet.ts` block.

Water does not total the way carbon does. Carbon is global and fungible. Water is local: the same
volume saved in a water-stressed watershed and in a wet one are not equivalent, and aggregate litres
carry no information about which.

## Embodied Carbon

`published`, from lifecycle studies and not from any measurement here. Boavizta's
`platform_compute_medium` archetype carries 900 kg CO2e embedded, range 461.8 to 2,089.0 [17]. At a
four-year life that is 225 kg CO2e per server-year, or 0.23 kg per site-year at 1,000 sites per
host. The per-site figure is the server figure shared out across the sites on one host:

```math
C_{\text{site}} = \frac{M}{L \cdot N}
```

M is the embodied CO2e of one server, L is its life in years and N is the number of sites on it. Substituting
900 kg, four years and 1,000 sites gives 0.23 kg after rounding.

Embodied carbon is not automatically avoided. A migrated fleet retires no hardware unless the
previous operator retires some. The figure describes hardware a sufficiently efficient architecture
makes unnecessary, not emissions that stop when a site moves.
