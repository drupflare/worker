# Impact

What Drupflare costs to run in electricity, carbon, water and money, and how far each figure can be trusted. This page holds the labels every figure carries and a map of the pages that hold the figures.

## Pages

- [What This Does Not Claim](limits.md): the limits of every claim.
- [Reproducing The Numbers](reproducing.md): commands that reproduce each figure.
- [References](references.md): the numbered references the other pages cite.
- [Energy](energy/index.md): the saving against conventional hosting, operating states and the per-request model.
- [Energy Per View](energy/views.md): the energy of one view, the traffic mix, visitor devices, and what Spool changes in requests, time and the plans' floor.
- [Fleet Energy](energy/fleet.md): many sites at once, institutional workloads and the saving by site count.
- [Carbon](carbon.md), [Water](water.md) and [Embodied Carbon](embodied.md): the environmental figures.
- [Economics](economics/index.md): what each host costs at each traffic level, what Spool adds to the plans, the plan limits and the comparison against a VPS.

## Measurement Labels

Every figure on the impact pages carries one of four labels.

| label                | meaning                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `measured`           | read off an instrument on real hardware, with an n and a spread         |
| `derived`            | arithmetic over measured inputs and published constants                 |
| `derived (modelled)` | arithmetic that also takes an input nobody has measured for a real site |
| `published`          | quoted from a named external source, cited where it appears             |

A figure keeps its label wherever it is repeated.

## Which CMS a Figure Describes

The energy, carbon, water and cost figures on these pages are Drupal's. No joules have been read for a WordPress view, and its cost per render is not yet on the economics model. The WordPress readings that exist, with their plan and n, are on [WordPress](../architecture/wordpress.md). The one WordPress input on these pages is the free-plan envelope, whose WordPress ceilings are `derived` with assumed weights.
