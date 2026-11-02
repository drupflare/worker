# Production Baseline

Enterprise Drupal runs oversupplied. Teams that put performance ahead of cost run high-availability,
multi-region deployments sized for peak, and those nodes draw their idle power around the clock. The
baseline is three regions, a high-availability web pair and database pair in each (12 nodes), 4-vCPU
nodes sized at 15% utilisation. Each node owns its vCPUs' share of a 640-thread host drawing 135 W
idle and 711 W at full load, at the 1.54 colocation PUE.

A deployment's annual energy `E`, in kWh, is its node count `n` times each node's share of the
640-thread host (`v` vCPUs over 640), times the host's power at utilisation `u`, times PUE, over
8,766 hours. The host's power is 135 W idle plus 576 W (711 less 135) scaled by `u`:

```math
E = \frac{n v}{640} (135 + 576 u) \cdot 1.54 \cdot \frac{8766}{1000}
```

That deployment draws 224 kWh a year while idle-dominated. drupflare serving the same site at 1
million views a month draws 18.3 Wh a year. The saving is the percentage by which drupflare's annual
energy `E_d` falls below the deployment's `E_p`:

```math
S = 100 \cdot (1 - \frac{E_d}{E_p})
```

At one million views that is a saving of 99.9919%.

Idle energy of each deployment, and the saving of one drupflare site against it by views a month, the
worst case last. `derived (modelled)`, from `bun scripts/economics/perview.ts`.

| deployment                                       | idle energy (kWh a year) |   10,000 |  100,000 | 1,000,000 | 10,000,000 | 30,000,000 |
| ------------------------------------------------ | -----------------------: | -------: | -------: | --------: | ---------: | ---------: |
| production: 3 regions, 12 nodes, 4 vCPU, 15%     |                    224.2 | 99.9998% | 99.9990% |  99.9919% |   99.9199% |   99.7601% |
| peak-sized: 3 regions, 12 nodes, 8 vCPU, 10%     |                    390.0 | 99.9999% | 99.9995% |  99.9953% |   99.9540% |   99.8621% |
| single-region HA: 1 region, 4 nodes, 4 vCPU, 15% |                     74.7 | 99.9993% | 99.9971% |  99.9756% |   99.7597% |   99.2802% |
| worst case: one small VPS, 2 vCPU, 15%           |                     9.34 | 99.9944% | 99.9771% |  99.8045% |   98.0780% |   94.2413% |

The node count, the vCPU per node and the utilisation are modelled, because no source sizes a
production node. The topology follows Acquia's high-availability design, which spreads a site over several
availability zones of one region [[4]](../references.md), and the AWS reference architecture for Drupal, whose subnets
sit in two or three zones [5]. Neither states instance sizes. The 135 W and 711 W server power, the 320 cores and the
640 threads are the SPECpower result [1]. The PUE is 1.54 for the conventional host and 1.15 for
Cloudflare's hyperscale facilities, both Uptime Institute averages [6]. A VPS vCPU is a hardware thread,
so a node owns its vCPUs over 640 of the host.

drupflare's busy core is a physical core, because each Workers isolate thread runs on one. Its energy
is CPU time on the traffic mix at 2.22 W a core, charged under [Watts For A Busy
Core](#watts-for-a-busy-core), with logged-in views at the compiled-plan cost. [Energy Per
View](views.md#energy-per-view) has the mix and the plan.

The saving is the idle term. These nodes are provisioned for peak, so almost all of their energy is
spent waiting. A site that sleeps between requests holds no compute and spends energy only while a
view, a render or a cold boot executes. A site kept warm also pays for its warming and holds its
memory, which [Operating States](operating-states.md#operating-states) prices. Per request the two runtimes are at
parity, as the measurements below show, so none of this comes from PHP running faster.

## Watts For A Busy Core

The 2.22 W charge is the host's 711 W at full load over its 320 cores. A busy core is charged its
idle share plus the marginal draw that load adds, where `W_core` is watts per busy core, 135 W is the
idle draw and 576 W the rise from idle to full load:

```math
W_{\text{core}} = \frac{135 + 576}{320} = \frac{711}{320} = 2.22
```

The 2.22 W charge is the full-load end of the measured curve, so it is a floor: a host that runs
below full load spends more per busy core-second. From the same SPECpower result [1], `derived`:

| host load | watts per busy core | against the model | linear model understates the draw by |
| --------: | ------------------: | ----------------: | -----------------------------------: |
|      100% |                2.22 |             1.00x |                                1.00x |
|       50% |                2.91 |             1.31x |                                1.10x |
|       30% |                3.76 |             1.69x |                                1.17x |
|       15% |                5.88 |             2.65x |                                1.27x |
|       10% |                8.00 |             3.60x |                                1.33x |

The idle and full-load points are the result's own, and the 256 W at 10% load and 466 W at 50% are
read from it. Charging 8.0 W a busy core raises drupflare's 0.525 Wh a year at 10,000 views to 1.89 Wh
and leaves the saving at 99.98% against one small VPS. It cancels in every per-view ratio below,
because both sides are priced at the same watts per core.

The conventional figures carry the opposite error. The model interpolates linearly between idle and
peak, which gives 221 W for a host at 15% load where the measured curve gives 282 W, so every
conventional figure here is about 22% low (the measured curve is 1.27 times the model) and the saving is understated. SPECpower's load is a share
of throughput rather than of CPU utilisation, so read the 22% as a direction and not a correction.

## The Worst Case

The last row of the production table is the smallest conventional deployment there is: one small VPS
of two vCPUs, a 320th of a host at 15% utilisation, no redundancy and one region. It draws 9.34 kWh a
year, and the saving holds there too: 99.8045% at a million views a month and 94.2413% at 30 million,
`derived (modelled)`. The utilisation and host share are chosen to be generous to the VPS, so this is
the lowest saving the model produces, not a typical one. The other energy pages use this deployment
wherever they quote a single-site VPS.
