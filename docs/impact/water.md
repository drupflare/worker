# Water

Water figures for Drupflare and the hosts it is compared with.

`derived` from the same energy totals, using 0.375 L/kWh direct and about 4.55 L/kWh indirect: US data
centres used 176 TWh in 2023, with 66 billion litres consumed directly and nearly 800 billion
indirectly through generation [[16]](references.md). With E the annual energy in kWh and W the water in litres a year:

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
