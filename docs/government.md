# Federal Sites

A US federal public website is governed by OMB M-23-22, which implements the 21st Century IDEA. It
sets requirements in two groups: what a page contains, and how a server behaves. This project is a
server. It carries none of the first group and part of the second.

## What the Site Owner Owns

Section 508 conformance of rendered pages. The Revised 508 Standards incorporate WCAG 2.0 Level AA
by reference; M-23-22 directs agencies to the most current WCAG, which was 2.1 at publication.
Conformance is a property of the markup an author produces, and no host establishes it.

USWDS adoption and the federal government banner. Three federal website standards are published: the
banner, the HTML page title, and the meta page description. All three are theme and content output.

`.gov` domain registration through CISA, agency brand identity, plain language, the accessibility
statement and its public feedback mechanism, the vulnerability disclosure policy required by CISA
BOD 20-01, and the three-year review cadence for content that is not actively maintained.

Participation in the Digital Analytics Program, which M-23-22 requires. The DAP module
(`usfedgov_google_analytics`) is verified here: its settings, its route, its three hook services and
its seven asset libraries install and resolve. The DAP tag is a script the browser fetches from
`dap.digitalgov.gov`, so no outbound call happens in PHP.

## What the Host Owns

HTTPS on every request, and HSTS. M-23-22 requires agencies to preload their `.gov` domains as
HTTPS-only; the preload submission belongs to the domain owner, the transport does not.

Serving crawlers and archivers unimpeded. Agencies must not limit which crawlers reach public
content, and must not present challenge-response restrictions such as CAPTCHAs to them. Cloudflare
bot management or a Turnstile interstitial in front of a site built here puts the deployment out of
compliance, so those stay off.

HTTP 301 for retired content, which `drupal/redirect` produces and the edge honours.

## Search.gov Splits in Two

Search.gov offers two integrations and this architecture hosts one of them.

The crawl route works. Search.gov indexes the public site from an XML sitemap and renders results on
a Search.gov-hosted page. Nothing outbound happens in PHP: `simple_sitemap` and `xmlsitemap` produce
the sitemap, `metatag_search_gov` produces the `searchgov_custom1-3` fields the index reads, and
stored pages serve the crawler. All three are verified.

The Results API route does not. `search_gov_results_api` renders results on the site's own page by
calling `api.gsa.gov` while building the form, and the results are the page. This runtime performs an
outbound call between invocations rather than inside one, so a deferred exchange returns nothing on
the first request. The module is recorded blocked with that mechanism, alongside `drupal/redis`,
which is refused for the same reason.

## The USWDS Theme

`uswds_base` is a theme, and a theme reaches this runtime through a different installer than a
module. `composer/installers` places it under `themes/contrib`, `extension.list.module` does not list
themes, and `module_installer` cannot install one. The pack now sweeps the theme tree, `/__enable`
routes a theme to `theme_installer`, and `assets:static` copies the theme subtree alongside `core`
and `modules`.

Its default library mode loads USWDS from a CDN. M-23-22 prohibits embedding static third-party
assets hosted outside the agency's control and carves out only dynamic resources such as analytics,
so a federal deployment uses the local library mode. The DAP tag is the carved-out case and is fine
as shipped.

## What This Project Does Not Claim

No FedRAMP authorization, no Authority to Operate, no Authority to Use, and no accessibility audit.
The Cloudflare Workers platform's own authorization status is not established here.

cloud.gov Pages is the near comparison. It offers a FedRAMP-authorized platform, an ATU kit of
boilerplate text and evidence, and a shared responsibility model, and it still leaves the
authorization decision with the agency. This project offers less than that.

A site built on this host can meet the requirements a host is responsible for. Whether the site meets
the rest is a determination its agency makes.

## Sources

- OMB M-23-22, _Delivering a Digital-First Public Experience_
- Federal website standards, `standards.digital.gov`
- Revised Section 508 Standards, `section508.gov`
- CISA BOD 20-01, vulnerability disclosure policy
- `search.gov` documentation on crawl-based indexing and the Results API
- `cloud.gov/pages` on its FedRAMP posture and shared responsibility model
