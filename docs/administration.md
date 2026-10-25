# Administration

The surfaces an owner uses to operate a site, and how each is authorised.

## The Admin Surfaces

Seven pages under `/_cfw` drive machinery that already exists, and all take the owner token; the
sign-in flow is on [Configuration Operations](configuration-operations.md#the-admin-surface).

| page         | path             | what it does                                                                            |
| ------------ | ---------------- | --------------------------------------------------------------------------------------- |
| **Limits**   | `/_cfw`          | every metered resource, what spends it, and whether exceeding it bills or stops working |
| **Extend**   | `/_cfw/extend`   | whether a contrib module installs here, answered against the shipped lock               |
| **Commands** | `/_cfw/commands` | a Drush-shaped field over the site's operations                                         |
| **Operate**  | `/_cfw/operate`  | the repair actions: purge, reconcile, sweep, database updates, restart the fill chain   |
| **Deploy**   | `/_cfw/deploy`   | the provisioning steps, two of which cannot be automated                                |
| **Git**      | `/_cfw/git`      | remotes, branches, pull requests and the working-tree diff                              |
| **Access**   | `/_cfw/access`   | the OpenID Connect provider                                                             |

The Commands field takes Drush spellings and resolves them to the operation the site registers, so
`cache:rebuild`, `cache-rebuild`, `cc` and `cr` are the same command. `en <module>` routes to the
module installer and not to the operations registry, and an operation given arguments it cannot
take is refused by name instead of being truncated to its first word.

```text
cr                  rebuild the caches
en webform          install a module
en webform --dry    check whether it would install, without installing
status              generation, migration state, queue depth
```

An operation with no driver is listed and disabled, not hidden, because a refusal with no named
alternative is a refusal that gets retried.

Extend checks a package against the shipped lock, installs it, and enables it. The page keeps those
three steps separate: a check writes nothing, an install fetches the package and writes its files,
and enabling turns the module on and reboots the interpreter. The same three are `/installable`,
`/install` and `/enable` for a script.

## Inside Drupal's Own Admin

`/_cfw` is the host's surface and sits outside Drupal. The module adds a second one where a Drupal
administrator looks first:

| page               | path                              | what it shows                                                    |
| ------------------ | --------------------------------- | ---------------------------------------------------------------- |
| **Drupflare**      | `/admin/config/drupflare`         | the section, alongside Drupal's own configuration groups         |
| **Runtime Status** | `/admin/config/drupflare/runtime` | the replica pool, page tiers, warming, edge plan and write lanes |
| **Help**           | `/admin/help/topic/drupflare`     | what runs where, and which Drupal assumptions do not hold here   |

Runtime Status reads the same payload `/serve-stats` returns, so the admin page and the host report
cannot disagree.

## Single Sign-On

The Access page at `/_cfw/access` sets the issuer and client id for the OpenID Connect provider the
host serves at `/oidc`. The client secret goes in the `OIDC_CLIENT_SECRET` binding. The redirect URI
to register with the provider is shown on the page, and saving checks the issuer's discovery document
at once, so a typo surfaces there and not at someone's first login. The verification rules, the
`drupal/externalauth` requirement and the `drupal/openid_connect` alternative are on
[OIDC Login](configuration-integrations.md#oidc-login).

## URL Routing

Drupal owns the URL space. Any path the Worker does not claim is served as a page, so `/`,
`/user/login`, `/admin` and `/node/1` all work. The Worker's own surfaces live under `/_cfw`, which
Drupal does not generate; its diagnostic and owner routes are single-segment names like `/health`
and `/export`.

Which site a request resolves to is decided in [`src/ops/site-id.ts`](../src/ops/site-id.ts): a KV
mapping for the host, then the `SITE_ID` var, then the deployment's primary site, then the hostname
itself, then `site`. One deployment is one site, so a second domain pointed at the worker reaches
the site already claimed and does not open a new one. A host mapped in KV is an alias: its pages,
redirects and login cookie carry that host, and `drangler domain add <host>` writes the mapping and
the Custom Domain route. On `localhost` the hostname names no site, so it lands on `site`. `?site=`
is refused on the public routes, so a link cannot choose which site answers; an owner route accepts
it because the object checks the token itself, and `PW_DIAGNOSTICS=1` accepts it everywhere, which
is what `/serve?site=X&path=Y` uses.

## Scripts

| command                      | what it does                                                |
| ---------------------------- | ----------------------------------------------------------- |
| `bun run dev`                | local worker with a real Durable Object                     |
| `bun run deploy`             | deploy to Cloudflare                                        |
| `bun run test`               | vitest: both projects, workers inside workerd               |
| `bun run test:coverage`      | the same, with merged coverage                              |
| `bun run test:node`          | only the node project (needs `node:sqlite`, a real PHP)     |
| `bun run test:php`           | the Drupal database driver suite, under real PHP            |
| `bun run typecheck`          | all three tsconfig projects; bare `tsc` covers only one     |
| `bun run check:reachability` | which modules the edge actually imports, and which are dead |
| `bun run assets:driver`      | repacks `assets/driver.json` from the sibling module repos  |
| `bun run build`              | hydrate the release payload: what a deploy runs             |
| `bun run build:local`        | build every generated artifact from source                  |
| `bun run build:plan`         | what a source build would do, and what tools are missing    |
| `bun run assets:sql`         | rebuild only the migration chunks                           |
| `bun run build:site-db`      | build the packed Drupal database from nothing               |
