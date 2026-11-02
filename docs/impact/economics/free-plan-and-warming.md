# The Free Plan and Keeping a Site Warm

What a site costs on the free plan, what keeping it warm adds, and what the price column does not buy.

## The Free Plan

The free plan covers 3.04 million views a month across the whole account, split however you like:
one site at 3.04 million views, a hundred sites at 30,439 each, a thousand at 3,043 each. Past that
the Workers Paid plan is $5 a month, including 10 million requests, 50 million rows written and 5 GB
of storage.

Worker requests, one per view, are the meter that runs out first. Every view reaches the Worker,
cached or not, so no change to rendering moves this ceiling. Only a response that never runs the
Worker avoids it: a static asset, or a hostname not routed to the Worker. The 3.04 million assumes
the 65 static assets beside each page do not bill as Worker requests, and a 198,000-request drive
invoked no Worker (`measured`). The one exception is Workers Cache,
which the shipped config does not enable: with it on, the same page load spends 66 requests and the
account serves 1,515 views a day. Mirroring pages to R2 or publishing them as assets lifts the ceiling in the model, to 10.2
million views a month for an R2 mirror with no Cache Rule and 82.0 million with one, and to 90.5
million for the assets arm, which is not built. Each carries conditions and a lower regeneration
ceiling, and [The Off-Worker Arms](free-vs-paid/off-worker-arms.md#the-off-worker-arms) has the scenarios and
sources. At the shipping default a
fill writes 1.75 rows, and the re-render ceiling is 50,916 a day, set by rows written. Renders follow
saves rather than views: at five saves a day a site re-renders about 25 pages, so a thousand active
sites use under half of that ceiling. For a large idle fleet the binding meter changes to storage, at
4.7 MB per site, and uploaded files are stored in each site's database against the same 5 GB.

What you pay, on your own account:

| views/site/mo | 1 site | 10 sites | 100 sites | 1,000 sites |
| ------------- | ------ | -------- | --------- | ----------- |
| 1,000         | free   | free     | free      | free        |
| 10,000        | free   | free     | free      | $5.80       |
| 100,000       | free   | free     | $5.15     | $38.44      |
| 1,000,000     | free   | $5.15    | $37.64    | $365.14     |
| 10,000,000    | $5.15  | $37.56   | $364.34   | $3,644.64   |

The first free cap you reach, and how much of it is used:

| views/site/mo | 1 site       | 10 sites     | 100 sites    | 1,000 sites |
| ------------- | ------------ | ------------ | ------------ | ----------- |
| 1,000         | storage 0%   | storage 1%   | storage 9%   | storage 95% |
| 10,000        | requests 0%  | requests 3%  | requests 33% | requests    |
| 100,000       | requests 3%  | requests 33% | requests     | requests    |
| 1,000,000     | requests 33% | requests     | requests     | requests    |
| 10,000,000    | requests     | requests     | requests     | requests    |

Against each host, one site, as the ratio of the host's bill to drupflare's:

| views/site/mo | cheapest VPS | most popular cloud | latency-matched VPS | managed floor |
| ------------- | ------------ | ------------------ | ------------------- | ------------- |
| 1,000         | free         | free               | free                | free          |
| 10,000        | free         | free               | free                | free          |
| 100,000       | free         | free               | free                | free          |
| 1,000,000     | free         | free               | free                | free          |
| 10,000,000    | 2.4x cheaper | 2.4x cheaper       | 11.3x cheaper       | 8.1x cheaper  |

Against each host, a thousand sites, every site asleep between requests. The 10,037.7x cell is the
sleeping-fleet ceiling against the latency-matched origin at 10,000 views a site; kept warm, the
same cell is 166.0x ([Kept Warm](#kept-warm)):

| views/site/mo | cheapest VPS    | most popular cloud | latency-matched VPS | managed floor   |
| ------------- | --------------- | ------------------ | ------------------- | --------------- |
| 1,000         | free            | free               | free                | free            |
| 10,000        | 1810.9x cheaper | 2155.9x cheaper    | 10037.7x cheaper    | 7186.2x cheaper |
| 100,000       | 273.2x cheaper  | 325.2x cheaper     | 1514.1x cheaper     | 1084.0x cheaper |
| 1,000,000     | 28.8x cheaper   | 34.2x cheaper      | 159.4x cheaper      | 114.1x cheaper  |
| 10,000,000    | 3.4x cheaper    | 3.4x cheaper       | 16.0x cheaper       | 11.4x cheaper   |

## Kept Warm

A paid plan keeps every site resident by default: the alarm re-arms every 8 s, the object never
hibernates, and an editor's first request after idle answers in 156 to 371 ms rather than 2 to 4 s.
The free plan leaves a site to the thermal policy, which declines any site below about 505 renders a
day, and any plan can set `SITE_WARM=0`. One site's chain sits inside the paid allowances. A fleet's
does not, because the allowances are account-wide: each warm site writes 10,896 rows and makes 10,800
object requests a day, and a thousand of them write 331 million rows a month against 50 million
included. The chain is billed for its wall time, 23.3 ms a firing (n=116). `derived`, from the rate
card and that firing, with a recomputation from the rate card alone pinned in
`tests/node/economics-energy.spec.ts`:

What you pay with every site kept warm:

| views/site/mo | 1 site | 10 sites | 100 sites | 1,000 sites |
| ------------- | ------ | -------- | --------- | ----------- |
| 1,000         | free   | $5.45    | $9.80     | $350.03     |
| 10,000        | free   | $5.45    | $9.95     | $350.65     |
| 100,000       | free   | $5.45    | $10.10    | $383.29     |
| 1,000,000     | free   | $5.75    | $42.59    | $709.99     |
| 10,000,000    | $5.30  | $38.16   | $369.29   | $3,989.49   |

Kept warm, against each host, one site:

| views/site/mo | cheapest VPS | most popular cloud | latency-matched VPS | managed floor |
| ------------- | ------------ | ------------------ | ------------------- | ------------- |
| 1,000         | free         | free               | free                | free          |
| 10,000        | free         | free               | free                | free          |
| 100,000       | free         | free               | free                | free          |
| 1,000,000     | free         | free               | free                | free          |
| 10,000,000    | 2.4x cheaper | 2.4x cheaper       | 11.0x cheaper       | 7.9x cheaper  |

Kept warm, against each host, a thousand sites:

| views/site/mo | cheapest VPS  | most popular cloud | latency-matched VPS | managed floor  |
| ------------- | ------------- | ------------------ | ------------------- | -------------- |
| 1,000         | 30.0x cheaper | 35.7x cheaper      | 166.3x cheaper      | 119.0x cheaper |
| 10,000        | 29.9x cheaper | 35.6x cheaper      | 166.0x cheaper      | 118.8x cheaper |
| 100,000       | 27.4x cheaper | 32.6x cheaper      | 151.8x cheaper      | 108.7x cheaper |
| 1,000,000     | 14.8x cheaper | 17.6x cheaper      | 82.0x cheaper       | 58.7x cheaper  |
| 10,000,000    | 3.1x cheaper  | 3.1x cheaper       | 14.6x cheaper       | 10.4x cheaper  |

A fleet pays for keeping its sites warm, about 35 cents a site a month at 1,000 sites. At 10,000 views
a site that leaves a thousand sites 30 times cheaper than the cheapest VPS, 166 times cheaper than a
latency-matched origin and 119 times cheaper than the managed floor. The sleeping tables reach 1,810
times at the cheapest VPS and 10,037 times at the latency-matched one. Those are ceilings, reached by
a fleet of mostly idle sites left to sleep.

## What The Price Column Does Not Buy

A monthly price buys capacity from one place, and this page does not measure capacity beyond the
sizing on [What A Conventional Host Needs](conventional-hosts.md#what-a-conventional-host-needs). It does not buy the latency profile: the same workload measures 100.2 ms on a VPS
against 8.9 ms on drupflare once an 82 ms round trip is injected, because one serves from a region
and the other from the visitor's colo. It does not buy the tail either, where the VPS p50 runs from
59 ms at 4 clients to 182 ms at 96 while drupflare holds. The latency-matched column prices the first
of those; nothing here prices the second.
