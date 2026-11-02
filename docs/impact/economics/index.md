# Economics

What a Drupflare site costs to run against the hosting it replaces, at each traffic level. Prices are list prices; the energy behind them is on [Energy](../energy/index.md), and the scope of each claim is on [Impact](../limits.md#what-this-does-not-claim). Citations in brackets refer to the [references on Impact](../references.md#references).

The figures are `derived`: Cloudflare's published rates [[18]](../references.md), [19] applied to the measured workload, and the list prices of the conventional hosts they are compared with. `bun scripts/economics/comparison.ts --md` generates the tables, so they follow the model behind them.

You deploy to your own Cloudflare account. There is no platform fee in any figure on these pages and no
per-tenant charge. Quotas are account-wide, so several sites share one envelope and do not each pay
their own floor.

The tables down to [Kept Warm](free-plan-and-warming.md#kept-warm) are for sites that sleep, which is the free plan's default and
`SITE_WARM=0` on any plan. [Kept Warm](free-plan-and-warming.md#kept-warm) prices the paid plan's default, where every site stays warm.

## Pages

- [Conventional Hosts](conventional-hosts.md): the conventional hosts, what they need, and what running it showed.
- [The Free Plan and Keeping a Site Warm](free-plan-and-warming.md): the free plan, keeping a site warm and what the price does not buy.
- [The Shape Of The Bills](bills.md): how a bill splits, including cost per request.
- [Drupflare vs a Traditional VPS](vps-comparison.md): latency, throughput and cost against nginx and PHP-FPM on the same tree.
- [Free vs Paid](free-vs-paid/index.md): what each plan allows and which limit binds first.

## Prices At Each Traffic Level

What hosting the same site costs conventionally, per site:

| views/site/mo | cheapest VPS | DigitalOcean | most popular cloud | latency-matched VPS | managed floor |
| ------------- | ------------ | ------------ | ------------------ | ------------------- | ------------- |
| 1,000         | $10.50       | $14.40       | $12.50             | $58.20              | $41.67        |
| 10,000        | $10.50       | $14.40       | $12.50             | $58.20              | $41.67        |
| 100,000       | $10.50       | $14.40       | $12.50             | $58.20              | $41.67        |
| 1,000,000     | $10.50       | $14.40       | $12.50             | $58.20              | $41.67        |
| 10,000,000    | $12.50       | $21.60       | $12.50             | $58.20              | $41.67        |

Amazon Lightsail publishes no transfer overage price for instances, so a plan whose transfer is
exceeded is not priced. At the CPU cost measured here the vCPUs a load needs bring enough included
transfer in every row, so none is dropped.

Above 9 million views the hardware grows with the traffic, and so does the bill. The same prices at
higher traffic, with drupflare's per-site bill at 1,000 sites:

| views/site/mo | cheapest VPS | DigitalOcean | latency-matched VPS | managed floor | drupflare |
| ------------- | ------------ | ------------ | ------------------- | ------------- | --------- |
| 30,000,000    | $25.00       | $43.20       | $79.80              | $41.67        | $10.92    |
| 100,000,000   | $75.00       | $129.60      | $144.60             | $41.67        | $36.39    |
| 1,000,000,000 | $877.00      | $1,206.40    | $1,221.40           | $41.67        | $363.86   |

## Where The Curves Meet

The bill grows with traffic and the conventional host's grows in whole boxes and in transfer, so the
lines can cross. Solved on the real functions with `comparison.ts --crossover`, per site, up to a
trillion views a site a month. The break-even is the first traffic at which drupflare's per-site bill reaches
the host's price. With s sites, C(s, v) is the account bill from [The Shape Of The Bills](bills.md#the-shape-of-the-bills), and P(v) is the
host's monthly price per site at v views a site a month:

```math
v^{*} = \min\{ v \geq 10^{4} : \frac{C(s, v)}{s} \geq P(v) \}
```

The search starts at 10,000 views and multiplies v by 1.01 each step, up to 10^12. P(v) is a step
function, because the VPS is priced in whole boxes sized to its render load, so the search also records
the last point above which drupflare stays behind. `never` means no step reached the host's price.

| against             | 1 site | 1,000 sites |
| ------------------- | ------ | ----------- |
| cheapest VPS        | never  | never       |
| latency-matched VPS | never  | never       |

drupflare is the cheaper bill at every traffic level against both. At 1,000 sites and 100 million
views per site the cheapest VPS costs $75.00 a site against drupflare's $36.39, and at a billion
views $877.00 against $363.86.

The managed floor would cross near 112 million views for one site and 115 million for a thousand,
but only because it is held flat at the entry plan's price. No managed plan serves that traffic at
$41.67, so the crossing comes from the flat price.
