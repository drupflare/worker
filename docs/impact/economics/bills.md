# The Shape Of The Bills

The two bills differ in shape more than in total. A conventional host charges per site per month
whether or not anyone visits, and for hardware that grows with traffic; drupflare charges for traffic
served, against an allowance that costs nothing until it is crossed. The comparison therefore widens
with the number of idle sites and narrows with traffic.

On a paid account the monthly bill is a fixed base plus one charge for each meter's usage above its
included allowance, as `scripts/economics/bill.ts` computes it. B is the base subscription, m runs over
the meters (requests, CPU milliseconds, rows written, storage, Durable Object requests and Durable Object
duration), u_m is that meter's usage for the month, I_m is its included allowance, c_m is its rate and
U_m is the unit the rate is quoted in:

```math
\text{bill} = B + \sum_{m} c_m \cdot \frac{\mathrm{max}(0, u_m - I_m)}{U_m}
```

The two Durable Object meters round their excess up to the next whole unit before the rate applies. Usage
includes a kept-warm site's own rows and object requests, which the chain spends before any visitor arrives.
A month in which every free-plan daily cap stays within its limit costs nothing, and the formula does not
apply to it.

For a single site at ten million views a
month drupflare costs $5.15, the $5 subscription plus $0.15 of usage, against $10.50 for the
cheapest VPS, and the latency-matched host is 11.3 times dearer.

## Cost Per Request

Each unit a request can spend, priced at the paid plan's rate past its included allowance. The Worker
request and the Durable Object request are per view, and the R2 operations are per read or per write.
`derived`, from `bun scripts/economics/bindings.ts`:

| unit                                              | rate               | cost per million |
| ------------------------------------------------- | ------------------ | ---------------: |
| Worker request, one a view                        | $0.30 a million    |            $0.30 |
| Worker CPU, edge-cache hit at 0.703 ms (p50)      | $0.02 a million ms |           $0.014 |
| Worker CPU, object hit at 1.80 ms                 | $0.02 a million ms |           $0.036 |
| Durable Object request, one a view on an object   | $0.15 a million    |            $0.15 |
| Worker-to-Worker call, 1.10 ms of CPU, no request | $0.02 a million ms |           $0.022 |
| R2 Class B read, no cache absorption              | $0.36 a million    |            $0.36 |
| R2 Class A write, one a fill                      | $4.50 a million    |            $4.50 |

The Worker-to-Worker row is billed as CPU only, because Cloudflare does not charge a request fee for a
call through a service binding (`published`, Workers pricing page). Static assets do not bill. Whether that call counts toward the free plan's 100,000 requests a day is unmeasured.

The bill for a thousand sites, on the paid plan, in dollars a month (`derived (modelled)`):

| views a site a month | warming | shipped | +1 Worker invocation a view | Worker-to-Worker call billed as a request |
| -------------------: | ------- | ------: | --------------------------: | ----------------------------------------: |
|               10,000 | asleep  |   $5.80 |                       $6.02 |                                     $8.80 |
|               10,000 | warm    | $350.65 |                     $350.87 |                                   $353.65 |
|              100,000 | asleep  |  $38.44 |                      $40.64 |                                    $68.44 |
|              100,000 | warm    | $383.29 |                     $385.49 |                                   $413.29 |
|            1,000,000 | asleep  | $365.14 |                     $387.14 |                                   $665.14 |
|            1,000,000 | warm    | $709.99 |                     $731.99 |                                 $1,009.99 |

The shipped column is the bill the headline quotes. The middle column is the upper bound from
[Service Bindings And R2](../energy/per-request.md#service-bindings-and-r2). At 10,000 views a site the render share
already puts the account past its CPU allowance, so the extra CPU is charged in full: $5.80 becomes $6.02,
a rise of 3.8%. The third column is a what-if, because the pricing page says a call through a service
binding carries no request fee.
