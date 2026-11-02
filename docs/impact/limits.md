# What This Does Not Claim

What the impact figures do not claim. Each limit below is stated with the reason behind it.

- **No per-tenant Cloudflare wattage.** It is not observable. Probing a deployed Cloudflare Container
  found no energy counter by any of the six routes a Linux process has, and no energy field exists
  anywhere in the account's analytics schema. The Cloudflare side of every figure on these pages is an
  allocation over measured workload and published hardware.
- **No cost for custom domains.** The bills on the economics pages are Workers account bills. A site on its own domain
  through Cloudflare for SaaS adds $0.10 a hostname a month past the first 100 [[40]](references.md), so 1,000 of them
  add $90 a month and take the asleep bill at 10,000 views from $5.80 to $95.80. How a fleet's domains
  attach decides whether that applies, and `scripts/economics/pricing.ts` takes the count.
- **No R2 wattage.** R2 exposes no CPU and no energy counter, so an R2 operation carries no energy figure.
  Static assets are free and unlimited (`published`), and a 198,000-request drive invoked no Worker
  (`measured`, invocations and not billing). The billing read is pending (gate 65). Workers Cache is the one
  exception, which the shipped config does not enable; with it on, a free account serves 1,515 views a day.
  The R2 rates and free tier are in `scripts/economics/rates.ts` with their pages.
  [The Off-Worker Arms](economics/free-vs-paid/off-worker-arms.md#the-off-worker-arms) has the arms, and
  [Service Bindings And R2](energy/per-request.md#service-bindings-and-r2) has the energy bracket.
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
  fleet cannot be measured. [Operating States](energy/operating-states.md#operating-states) brackets it from zero to a
  memory-share bound; neither end is a reading.
- **No allocation for Cloudflare's own fleet utilisation.** The 2.22 W a busy core is the full-load
  floor, and [Watts For A Busy Core](energy/production-baseline.md#watts-for-a-busy-core) shows what a lower host load would
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
  sessions. None has an energy class here, and [How The Lead Moves](energy/views.md#how-the-lead-moves) charges a
  missed plan as a render.
- **No visitor-device energy in any total.** [Visitor Devices](energy/views.md#visitor-devices) prices a
  repeat navigation on its own. It is a desktop reading with the fresh-asset share swept, no phone has
  been measured, and it is never summed with the server figures.
- **No price on the v1.0.4 security controls.** The CPU readings on these pages predate the PHP 8.5.12
  interpreter and the controls, and no deployed `cpuTime` has been read since. What is counted: a new
  object's first fill writes one more row, 83 against 82, once per object for the module integrity
  record (`measured`). The interpreter is 14,011,458 bytes against 13,401,742, 4.5% larger
  (`measured`). An owner action appends to the audit log, and no view triggers one. A claimed site
  hashes each module file the first time it opens it. Heap image checks run only where `HEAP_IMAGE` is
  on, which is not the default. The report-only policy header adds about 120 bytes to each HTML
  response before compression (`derived`). None of these has an energy figure.
- **Institutional rows use an assumed workload.** The page views come from the case studies. The
  logged-in share, the saves a day and the pages a save invalidates are the model's, not theirs.
