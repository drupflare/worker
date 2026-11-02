# Site Identity and Origin Settings

The variable that selects the CMS, and the variables that name a site and fix the origin its sessions and links use.

## CMS

`CMS` selects which CMS the build packs, and `drupal` is the only value. It is read at BUILD time by
`bun run assets:driver`, from the environment and then from `wrangler.jsonc`, which sets it. Unlike
every other var it has no default: a missing or unknown value fails the build instead of packing
Drupal under another name. At runtime it is only reported, as the fleet row's `cms`.

## Site Identity and Origin

| var                  | default              | what it does                                                   |
| -------------------- | -------------------- | -------------------------------------------------------------- |
| `SITE_ID`            | derived, then `site` | which site a request resolves to, when KV maps no host         |
| `SITE_ID_PORTS`      | `keep`               | whether a port is part of a site id derived from the hostname  |
| `SITE_ORIGIN`        | pinned on first use  | the `scheme://host[:port]` Drupal builds absolute URLs against |
| `SITE_LOCATION_HINT` | unset                | which region the site's Durable Object is created in           |

### `SITE_ID`

One object per site, and the object's name is the site identity, so a wrong answer here serves a
request from a different site's database. The layers, in order, are implemented in `src/ops/site-id.ts`: `?site=` (only when the caller opts
in), a `site:host:<host>` KV mapping, then `SITE_ID`, then the deployment's primary site
(`src/ops/deployment-site.ts`), then the hostname itself, then the literal `site`.

The optional layers sit above the derived one because derivation answers for every real host, so
anything below it would be unreachable on exactly the hosts it exists to configure. `localhost`,
`127.0.0.1`, `0.0.0.0` and `::1` name no site and fall past derivation, which is what lets a local
dev server and a deployed site run the same code path.

Set it when one deployment serves one site under a name you choose. Leave it unset when the hostname
is the identity. Changing it after a site has content points the Worker at a different, empty object;
the old one still holds the data.

### `SITE_ID_PORTS`

`keep` or `strip`. `keep` is the default: a non-default port is part of a derived site id, so
`example.com:8443` and `example.com` are two sites, as they are on a standalone workerd node that
serves different sites on different ports. `strip` drops any port, which is right on Cloudflare,
where a hostname is one site and the platform proxies extra ports (8443, 2053 and others) to it;
under `keep` each one creates a site object that holds an alarm chain and no visitors. The canonical
`wrangler.jsonc` sets `strip`. An id derived from a default-port host is the same under both values,
and a KV mapping, `SITE_ID` or the deployment's primary site is unaffected. Do not set `strip` on
a node that has sites on non-default ports, since their ids would change.

The KV reads in the chain (the host mapping and the deployment document) wait at most 2 seconds. A
read that does not answer uses the last value this isolate saw, or falls through as a failed read
does.

Spec: `tests/unit/ops/site-id.spec.ts`.

### `SITE_LOCATION_HINT`

One of `wnam enam sam weur eeur apac apac-ne apac-se oc afr me`, or unset.

Unset by default. Placement follows the first request a site answers, which for a deploy-button site
is wherever the deployer was. Pinning a region on an owner's behalf trades latency for one audience
against latency for every other, so the choice belongs to whoever knows the audience.

It applies when the object is created. Cloudflare ignores it for an object that already exists,
so setting it on a running site moves nothing.

An unrecognised value is ignored. The value reaches `SITE.get()` on the serving path, and a hint the
platform rejects would take the site down for the sake of a preference.

KV-overridable through the `settings` key, so a region can be chosen without a redeploy.

### `SITE_ORIGIN`

Every absolute URL Drupal emits is built from the origin: the canonical tag, a form action, a
`Location:`, the link in a password-reset mail.

The inbound `Host` carries no guarantee: an attacker who can set it can move a password-reset link
onto a host they control. So the origin is a property of the site, resolved in
`src/ops/site-origin.ts` in this order:

1. `SITE_ORIGIN`, which wins outright.
2. **The pin**, held in `cfw_meta` under `site_origin`. Trust on first use: the first non-local
   origin a site serves is stored, and later requests do not overwrite it. A forged `Host` after the
   pin changes nothing.
3. The observed origin, when there is no pin; that request is the one that sets the pin.
4. `http://localhost`, only when nothing above produced a usable value.

A bare hostname is accepted and assumed `https`. A full URL is trimmed to its authority, so
`https://example.com/` does not become a double slash in every canonical tag. Only `http` and `https`
are accepted: a `javascript:` form action is why this is an allowlist.

A local origin is never pinned (`localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, `do.local`), so running
the suite or a `wrangler dev` against a persisted object cannot fix a real site's canonical URL to a
developer's laptop.

Set it when the site is reached through a host it cannot observe: behind a proxy that rewrites
`Host`, or on a deploy whose first request is a health check. `SITE_ORIGIN` takes precedence over the
pin on every request, so it can change the origin of a site that has already pinned one; the stored
value is left in place.

Getting it wrong points canonical tags, redirects and mailed links at the wrong host. What a request
resolves to is a separate question, answered by `SITE_ID`.

Specs: `tests/unit/ops/site-origin.spec.ts`, `tests/integration/render-origin.spec.ts`.

### Alias Hosts

A site answers on more than one hostname through `site:host:<host>` entries in `CONFIG_KV`, one per
host, each naming the site. `drangler domain add <host>` writes the entry with your wrangler login
and adds a Custom Domain route for the next deploy.

Every render uses the site's origin, so the stored page carries the canonical host. On a request
whose host resolved through a KV entry and differs from that origin, the front worker rewrites the
response for the visitor's host: absolute URLs in text bodies (plain and JSON-escaped), `Location`,
and the `Domain` on `Set-Cookie`, which Drupal derives from the render host and a browser refuses
from any other. The session cookie keeps its name, so one login works on every alias. The response
carries `x-cfw-alias: <canonical host>`.

Only a KV-mapped host is rewritten. An operator wrote that entry, so a forged `Host` cannot turn it
on, and an unmapped host that reaches the site through the deployment primary keeps the canonical
links. The first request a site ever answers still pins its origin, so claim the site on its main
host before adding aliases.

Specs: `tests/unit/ops/site-origin.spec.ts`, `tests/integration/deployment-site.spec.ts`.
