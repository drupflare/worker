# Embodied Carbon

Embodied carbon of the hardware a site runs on.

`published`, from lifecycle studies and not from any measurement here. Boavizta's
`platform_compute_medium` archetype carries 900 kg CO2e embedded, range 461.8 to 2,089.0 [[17]](references.md). At a
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
