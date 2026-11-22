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

## What Spool Adds To The Plans

Spool is on by default on every plan, the free plan included, and `SPOOL=0` turns it off. It changes how many Worker requests a visitor costs, which is the meter the free plan's 100,000 a day and the paid plan's request price both count. How much it saves depends on how many pages a visitor reads in a visit and how many of them the device already holds, so the figures below come from the published and measured visit behaviour of each site type, cited in [Visit Behaviour From Public Data](../energy/views.md#visit-behaviour-from-public-data). All of them are `derived (modelled)`, from `bun scripts/economics/behavior.ts --md`, with a month of 30.44 days and every visitor running a worker, which is the upper bound on the saving.

### Per Site, By Site Type

Central visit length of each site type, the share of Worker requests spool removes, the views a month the free plan carries (3,044,000 with spool off), and the paid plan's monthly bill with spool on minus the bill with it off. A positive difference is a net deficit for spool and a negative one a net bonus. The 5 ms column uses the upper estimate of spool's CPU on a page that reaches the Worker, and the 0 ms column the lower bound, since two paid readings put the median difference under 1 ms:

| site type           | views a visit | requests saved | free plan carries a month | 10M views, 5 ms | 30M views, 5 ms | 100M views, 5 ms | 100M views, 0 ms |
| ------------------- | ------------: | -------------: | ------------------------: | --------------: | --------------: | ---------------: | ---------------: |
| personal site       |          1.60 |           0.1% |                 3,048,343 |          +$0.76 |          +$2.98 |           +$9.94 |           -$0.05 |
| blog                |          1.00 |           0.0% |                 3,044,000 |          +$0.76 |          +$3.00 |          +$10.00 |            $0.00 |
| documentation       |          1.50 |           1.6% |                 3,092,121 |          +$0.74 |          +$2.80 |           +$9.32 |           -$0.52 |
| marketing site      |          1.33 |           0.0% |                 3,044,057 |          +$0.76 |          +$3.00 |          +$10.00 |            $0.00 |
| news                |          1.92 |           1.5% |                 3,091,178 |          +$0.74 |          +$2.80 |           +$9.33 |           -$0.51 |
| higher education    |          2.40 |           1.7% |                 3,095,097 |          +$0.74 |          +$2.78 |           +$9.28 |           -$0.55 |
| all sites, surveyed |          4.60 |           6.4% |                 3,252,620 |          +$0.67 |          +$2.16 |           +$7.05 |           -$2.31 |

Read the table in three parts. A typical visit is short (the sources give 1.0 to 2.4 pages for six site types), so spool removes between 0% and 1.7% of Worker requests there, and the free plan's floor of 3,044,000 views a month rises by at most 51,000. The paid plan shows no difference up to about 4.4 million views a month, because the 10 million request and 30 million CPU millisecond allowances absorb it. Above that the 5 ms estimate makes spool a net deficit of about $0.10 per million views, from $0.74 at 10 million views to $9.28 for higher education at 100 million, and only the 0 ms bound turns it into a bonus, of $0.55 at most. The bottom row uses a cross-industry session depth of 4.6 pages whose mean or median the source does not state, and its high figure of 14% rests on a survey of 336 marketers, so it is not a site type.

Long visits are where spool pays. A deployed visit of 121 views reached the Worker 12 times with spool on and 122 with it off (measured, n=1), and a modelled visit of 20 views on a nine-page site carries 5,073,343 views a month. The sources show how rare that is. In Wikipedia's data, 68% to 78% of sessions load one page, and the navigation trees that run to a median of 18 page loads are 0.24% of them. The model's long-visit rows are therefore bounds for a site whose visitors read on, and no site type with a measured figure behaves that way on average.

### By Site Size

Requests saved and free-plan views a month for a fixed visit length, by the distinct pages a site has, with visitors drawn from a power law fitted to the measured share of views on the most-read page (the control row draws pages uniformly):

|     distinct pages |         5 views |         10 views |         20 views |
| -----------------: | --------------: | ---------------: | ---------------: |
|                 10 | 0.4%, 3,056,409 | 23.0%, 3,951,579 | 52.6%, 6,421,636 |
|                100 | 0.1%, 3,046,712 |  9.1%, 3,348,367 | 33.9%, 4,601,767 |
|              1,000 | 0.0%, 3,045,309 |  6.0%, 3,237,988 | 27.6%, 4,204,681 |
|             10,000 | 0.0%, 3,045,218 |  5.1%, 3,206,016 | 25.3%, 4,072,540 |
| uniform draws, 100 |            0.0% |             0.0% |             0.5% |

A small site gains more because visitors meet the same pages again. The surveyed sites hold a median of 900 distinct pages for WordPress and 1,475 for Drupal (sitemap counts of 71 and 43 public university sites, many a lower bound), where a 10-view visit saves about 6%. The 405-page site that the model uses where a site's size is not measured is the median of the page counts of four of the owner's own sites and the median of the higher-education sitemaps.

### What The Figures Assume

- Every visitor runs a worker. A visitor on a client that registers none sends the same requests as with spool off, so the saving falls in proportion.
- Bots send 13% to 73% of HTML views on the owner's own zones, by user agent, and most of them do not run a service worker, so the saving per metered request is smaller than the table.
- The site types are weighted equally where a single typical figure is needed, because no weights are measured. Nonprofit, community, ecommerce, healthcare and government sites have no readable figure and are not in the table.
- Pages are drawn independently, with no link structure. The fitted power law overstates the concentration past the first page (it puts 83% of views on the top ten pages of the personal site against 62% measured), so the saving is, if anything, high.
- A return visit costs one request for each distinct page, past the 900 s freshness bound. One return per returner is assumed.
- The R2 page mirror and spool are modelled by the same requests-per-view factor, which no deployed reading checks.

These figures use no real site's own visit data beyond the owner's, so they set no price cut and no allowance increase. [What Spool Adds](../energy/views.md#what-spool-adds) has the requests, the sweep over visit length and pages, and what is unmeasured, which includes spool's decoration CPU on a free-plan handler against its 10 ms cap.

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
