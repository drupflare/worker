# Impact

What Drupflare costs to run in electricity, carbon, water and money, and how far each figure can be trusted. The figures are split across four pages:

- [Energy](energy.md): the saving against conventional hosting, the operating states, and the per-request model.
- [Energy Per View](energy-views.md): the energy of one view, the traffic mix, visitor devices and Spool.
- [Fleet Energy](energy-fleet.md): many sites at once, institutional workloads and the saving by site count.
- [Environment](environment.md): carbon, water and embodied carbon.
- [Economics](economics.md): what each host costs at each traffic level.

This page holds what they share: the labels, the limits of every claim, how to reproduce the numbers, and the numbered references the other pages cite.

## Measurement Labels

Every figure on this page carries one of four labels.

| label                | meaning                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `measured`           | read off an instrument on real hardware, with an n and a spread         |
| `derived`            | arithmetic over measured inputs and published constants                 |
| `derived (modelled)` | arithmetic that also takes an input nobody has measured for a real site |
| `published`          | quoted from a named external source, cited where it appears             |

A figure keeps its label wherever it is repeated.

## What This Does Not Claim

- **No per-tenant Cloudflare wattage.** It is not observable. Probing a deployed Cloudflare Container
  found no energy counter by any of the six routes a Linux process has, and no energy field exists
  anywhere in the account's analytics schema. The Cloudflare side of every figure above is an
  allocation over measured workload and published hardware.
- **No cost for custom domains.** The bills above are Workers account bills. A site on its own domain
  through Cloudflare for SaaS adds $0.10 a hostname a month past the first 100 [40], so 1,000 of them
  add $90 a month and take the asleep bill at 10,000 views from $5.80 to $95.80. How a fleet's domains
  attach decides whether that applies, and `scripts/economics/pricing.ts` takes the count.
- **No consolidated-host bill.** The conventional bills price one origin a site. A consolidated host
  pays for memory alone at least $5.00 a GiB a month at the cheapest sourced plan: $5,000 for 1,000
  sites at 1 GiB each, $1,250 at 0.25 GiB and $500 at 0.1 GiB, before CPU, disk, transfer and
  backups. A bill of $350.65 buys 71.8 MiB of memory a site across 1,000 sites and $5.80 buys 1.2 MiB,
  so a consolidated host undercuts the kept-warm bill only if a site fits in about 72 MiB. No source
  gives a Drupal site's memory on a shared host.
- **No claim that 1,000 sites replace 1,000 servers.** VPS providers and managed platforms already
  consolidate, so the comparison is against hosting that has captured most of the multi-tenancy
  saving.
- **Conventional prices are sized list prices.** They exclude labour, a CDN, the database and file
  replication of a multi-region origin and cross-region transfer, and they price a box from documented
  minimums and a measured stack. The stack was measured with SQLite and not MariaDB, on one machine
  and on a Cloudflare container, and no source gives PHP-FPM memory per child for Drupal.
- **The energy worst case and the priced box differ in size.** The energy model charges a VPS a 320th
  of a host, two vCPUs. The cost model prices one vCPU and 2 GiB, which is a 192nd of a 384 GiB host by
  memory, so the energy charge is at most low for the box priced.
- **Pantheon as a price, not an energy baseline.** It is already multi-tenant, and how many machines
  it runs, how well utilised they are and how much of that would persist without a given workload
  are all unobservable from outside.
- **No market-share multiplier.** A CMS's share of websites is a count of sites and not a quantity of
  compute. It changes the addressable population and transfers no measurement.
- **Incremental energy is not a hosting total.** The rig produces idle-subtracted workload energy. A
  continuously provisioned server also pays its idle, and the equivalent allocation on a shared edge
  fleet cannot be measured. [Operating States](energy.md#operating-states) brackets it from zero to a
  memory-share bound; neither end is a reading.
- **No allocation for Cloudflare's own fleet utilisation.** The 2.22 W a busy core is the full-load
  floor, and [Watts For A Busy Core](energy.md#watts-for-a-busy-core) shows what a lower host load would
  charge. At 10,000 views that leaves the saving at 99.98% against one VPS, and it moves no
  per-view ratio, since both sides use the same figure.
- **No cold-encounter reading.** The headline carries none, and no deployed site has reported
  `coldOfTraffic`. The sensitivity rows are assumptions about how many editor sessions find an object
  cold.
- **No price on the hostname lookup.** A request through the production hostname resolves the site
  from a key-value mapping, memoised for a minute, and its CPU time has not been read. Its wall time
  is 4 ms warm and 46 to 140 ms in a colo that has not seen the key, and CPU time excludes the wait.
  The closest per-view cell has room for about 0.3 ms of extra CPU on every view against a free hit
  and 0.9 ms against an nginx hit, at a million views a month and above.
- **No price on the shell tier, replica lanes or the plan's compile.** A logged-in view that misses
  the compiled plan can be answered from a stored shell, which renders a fragment instead of the
  page. Lanes copy writes to every object of a busy site. The plan compiles from three agreeing
  sessions. None has an energy class here, and [How The Lead Moves](energy-views.md#how-the-lead-moves) charges a
  missed plan as a render.
- **No visitor-device energy in any total above.** [Visitor Devices](energy-views.md#visitor-devices) prices a
  repeat navigation on its own. It is a desktop reading with the fresh-asset share swept, no phone has
  been measured, and it is never summed with the server figures.
- **No price on the v1.0.4 security controls.** The CPU readings above predate the PHP 8.5.12
  interpreter and the controls, and no deployed `cpuTime` has been read since. What is counted: a new
  object's first fill writes one more row, 83 against 82, once per object for the module integrity
  record (`measured`). The interpreter is 14,011,458 bytes against 13,401,742, 4.5% larger
  (`measured`). An owner action appends to the audit log, and no view triggers one. A claimed site
  hashes each module file the first time it opens it. Heap image checks run only where `HEAP_IMAGE` is
  on, which is not the default. The report-only policy header adds about 120 bytes to each HTML
  response before compression (`derived`). None of these has an energy figure.
- **Institutional rows use an assumed workload.** The page views come from the case studies. The
  logged-in share, the saves a day and the pages a save invalidates are the model's, not theirs.

## Reproducing The Numbers

```sh
bun scripts/measure/vps-energy.ts run --ssh="$HOST" --target="$VPS_ADDR" --target2="$DRUPFLARE_ADDR" --ladder=2,4,8 --n=5
bun scripts/measure/render-fraction.ts
bun scripts/economics/perview.ts
bun scripts/economics/states.ts
bun scripts/economics/device.ts
bun scripts/economics/fleet.ts
bun scripts/economics/comparison.ts --md
bun scripts/economics/comparison.ts --crossover
bun scripts/economics/comparison.ts --sites=426 --views=82160
```

The first command needs a bare-metal x86 host with readable RAPL counters and a load generator on a
different machine. A virtual machine cannot substitute: a Cloudflare Container exposes no energy
counter at all, and a mainstream KVM guest exposes a `power` PMU that reads a constant zero, which a
tool reports as 0 W. `--ladder` is required for a per-request figure. One rate cannot separate the
cost of a request from the cost of the package being awake, so the two arms are read at the same
request count.

Conventional host prices live in `scripts/economics/hosting-catalog.json`: every plan and rate carries
the provider page it was read from and the line quoted from it, and `tests/node/hosting-catalog.spec.ts`
fails on one without a source. The economic models live in `scripts/economics/`. Every measured input they take is in one file with
its provenance and the workload it was taken under, because a render cost measured with cold caches
and a render cost measured on the invalidation path differ by 35x and are not substitutable.

## References

[1] Standard Performance Evaluation Corporation, "SPECpower_ssj2008 result: Dell Inc. PowerEdge
R6725 (AMD EPYC 9845)," SPEC, Nov. 4, 2025. Two chips, 320 cores, 640 hardware threads, active idle
135 W, 711 W at 100% target load. Accessed: Oct. 1, 2026. [Online]. Available:
https://www.spec.org/power_ssj2008/results/res2025q4/power_ssj2008-20251021-01543.txt

[2] U.S. Energy Information Administration, "How much electricity does an American home use?,"
EIA FAQ, Jan. 8, 2024. Accessed: Sep. 28, 2026. [Online]. Available:
https://www.eia.gov/tools/faqs/faq.php?id=97&t=3

[3] U.S. Environmental Protection Agency, "Greenhouse Gas Emissions from a Typical Passenger
Vehicle," EPA, Jun. 3, 2026. Accessed: Sep. 28, 2026. [Online]. Available:
https://www.epa.gov/greenvehicles/greenhouse-gas-emissions-typical-passenger-vehicle

[4] Acquia, "Availability," Acquia Docs. Accessed: Oct. 14, 2026. [Online]. Available: https://docs.acquia.com/acquia-cloud/arch/security/availability

[5] Amazon Web Services, "aws-refarch-drupal," GitHub. Accessed: Oct. 14, 2026. [Online]. Available: https://github.com/aws-samples/aws-refarch-drupal

[6] Uptime Institute, "Uptime Institute Global Data Center Survey 2025," Uptime Institute Intelligence,
Keynote Report 180, Jul. 2025. Accessed: Oct. 14, 2026. [Online]. Available:
https://intelligence.uptimeinstitute.com/resource/uptime-institute-global-data-center-survey-2025

[7] nginx, "Module ngx_http_proxy_module," nginx documentation. Accessed: Oct. 14, 2026. [Online]. Available: https://nginx.org/en/docs/http/ngx_http_proxy_module.html

[8] Pantheon, "Global CDN," Pantheon Docs. Accessed: Oct. 14, 2026. [Online]. Available: https://docs.pantheon.io/guides/global-cdn

[9] Acquia, "Arizona State University," Acquia Customer Stories. Accessed: Sep. 28, 2026. [Online].
Available: https://www.acquia.com/resources/customer-stories/arizona-state-university

[10] Last Call Media, "Huge Performance Gains for Mass.gov," Drupal.org Case Studies, Apr. 2, 2019.
Accessed: Sep. 28, 2026. [Online]. Available:
https://new.drupal.org/case-study/huge-performance-gains-for-massgov

[11] Mobomo, "NASA.gov," Drupal.org Case Studies, May 25, 2018. Accessed: Sep. 28, 2026. [Online].
Available: https://new.drupal.org/case-study/nasagov

[12] DevPanel, "How a U.S. Government News Agency Uncovered 75% Hosting Savings with DevPanel on
AWS," DevPanel Blog, Jul. 20, 2025. Accessed: Sep. 28, 2026. [Online]. Available:
https://devpanel.com/blog/how-a-u-s-government-news-agency-uncovered-75-hosting-savings-with-devpanel-on-aws/

[13] E. Graham, N. Fulghum, and K. Altieri, "Global Electricity Review 2025," Ember, Apr. 8, 2025.
Accessed: Sep. 28, 2026. [Online]. Available:
https://ember-energy.org/app/uploads/2025/04/Report-Global-Electricity-Review-2025.pdf

[14] Cloudflare, "Cloudflare Emissions Inventory, 2024," Cloudflare, Inc., Jul. 15, 2025. Scope 2
location-based, facilities and network rows summed. Accessed: Sep. 28, 2026. [Online]. Available:
https://cf-assets.www.cloudflare.com/slt3lc6tev37/2lg914L21Lyfpcya6weavX/6ded4e6ca673dbc1197c6b772a92aa29/Emission_inventory_PDF__2024.pdf

[15] Cloudflare, "The 2025 Cloudflare Radar Year in Review," The Cloudflare Blog. Accessed: Sep. 28, 2026. [Online]. Available: https://blog.cloudflare.com/radar-2025-year-in-review/

[16] A. Shehabi et al., "2024 United States Data Center Energy Usage Report," Lawrence Berkeley
National Laboratory, Berkeley, CA, USA, Rep. LBNL-2001637, Dec. 2024. Accessed: Sep. 28, 2026.
[Online]. Available:
https://eta-publications.lbl.gov/sites/default/files/2024-12/lbnl-2024-united-states-data-center-energy-usage-report_1.pdf

[17] Boavizta, "Get the impacts of a server," Boavizta API documentation. Accessed: Sep. 28, 2026.
[Online]. Available: https://doc.api.boavizta.org/getting_started/single_server/

[18] Cloudflare, "Pricing," Cloudflare Workers documentation, Aug. 28, 2026. Accessed: Sep. 28, 2026.
[Online]. Available: https://developers.cloudflare.com/workers/platform/pricing/

[19] Cloudflare, "Pricing," Cloudflare Durable Objects documentation, Aug. 25, 2026. Accessed: Sep.
28, 2026. [Online]. Available: https://developers.cloudflare.com/durable-objects/platform/pricing/

[20] Stack Overflow, "2025 Developer Survey: Technology," Stack Overflow. Accessed: Oct. 14, 2026. [Online]. Available: https://survey.stackoverflow.co/2025/technology/

[21] Synergy Research Group, "Q2 Cloud Market Passes $143 Billion," Jul. 30, 2026. Accessed: Oct. 14, 2026. [Online]. Available: https://www.srgresearch.com/articles/q2-cloud-market-passes-143-billion-highest-growth-rate-in-eight-years

[22] DigitalOcean, "Load Balancers Pricing," DigitalOcean Documentation, Jul. 13, 2026. Accessed:
Sep. 28, 2026. [Online]. Available:
https://docs.digitalocean.com/products/networking/load-balancers/details/pricing/

[23] Google Cloud, "Multi-regional deployment archetype," Google Cloud Architecture Center. Accessed: Oct. 14, 2026. [Online]. Available: https://docs.cloud.google.com/architecture/deployment-archetypes/multiregional

[24] Amazon Web Services, "Disaster recovery options in the cloud," AWS Whitepapers. Accessed: Oct. 14, 2026. [Online]. Available: https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html

[25] Pantheon, "Pantheon Pricing," Pantheon.io. Accessed: Sep. 28, 2026. [Online]. Available:
https://pantheon.io/plans/pricing

[26] Akamai, "Linode types," Linode API v4. Accessed: Oct. 14, 2026. [Online]. Available: https://api.linode.com/v4/linode/types

[27] nginx, "Module ngx_http_fastcgi_module," nginx documentation. Accessed: Oct. 14, 2026. [Online]. Available: https://nginx.org/en/docs/http/ngx_http_fastcgi_module.html

[28] Apache Software Foundation, "Apache Core Features: TimeOut," Apache HTTP Server 2.4 documentation. Accessed: Oct. 14, 2026. [Online]. Available: https://httpd.apache.org/docs/2.4/mod/core.html

[29] Cloudflare, "Error 524," Cloudflare Support. Accessed: Oct. 14, 2026. [Online]. Available: https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/

[30] Google, "Optimize Time to First Byte (TTFB)," web.dev. Accessed: Oct. 14, 2026. [Online]. Available: https://web.dev/articles/ttfb

[31] Akamai, "Shared CPU Compute Instances," Akamai Cloud documentation. Accessed: Oct. 14, 2026. [Online]. Available: https://techdocs.akamai.com/cloud-computing/docs/shared-cpu-compute-instances

[32] Amazon Web Services, "Key concepts and definitions for burstable performance instances," Amazon EC2 User Guide. Accessed: Oct. 14, 2026. [Online]. Available: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-credits-baseline-concepts.html

[33] Canonical, "System requirements," Ubuntu Server documentation. Accessed: Oct. 14, 2026. [Online]. Available: https://ubuntu.com/server/docs/reference/installation/system-requirements

[34] MariaDB, "InnoDB System Variables," MariaDB documentation. Accessed: Oct. 14, 2026. [Online]. Available: https://mariadb.com/docs/server/server-usage/storage-engines/innodb/innodb-system-variables

[35] Drupal.org, "Memory requirements," Drupal system requirements. Accessed: Oct. 14, 2026. [Online]. Available: https://www.drupal.org/docs/getting-started/system-requirements/memory-requirements

[36] Vultr, "Plans," Vultr API v2. Accessed: Oct. 14, 2026. [Online]. Available: https://api.vultr.com/v2/plans

[37] Amazon Web Services, "Amazon Lightsail Pricing," AWS. Accessed: Oct. 14, 2026. [Online]. Available: https://aws.amazon.com/lightsail/pricing/

[38] DigitalOcean, "Droplet Pricing," DigitalOcean. Accessed: Oct. 14, 2026. [Online]. Available: https://www.digitalocean.com/pricing/droplets

[39] Microsoft, "Azure Retail Prices API" and "Bandwidth pricing," Microsoft Azure. Accessed: Oct. 14, 2026. [Online]. Available: https://prices.azure.com/api/retail/prices and https://azure.microsoft.com/en-us/pricing/details/bandwidth/

[40] Cloudflare, "Plans," Cloudflare for SaaS documentation. Accessed: Oct. 14, 2026. [Online]. Available: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/
