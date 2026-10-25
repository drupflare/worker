# Getting Started

From a clean clone to a running site, then claiming it and moving an existing one in.

## Prerequisites

- [Bun](https://bun.sh/)
- Node 24+ as well; a few scripts need `node:sqlite`, which Bun does not ship
- PHP 8.3+ with `pdo_sqlite` (only to run the database driver's test suite)
- A Cloudflare account with Durable Objects enabled (available on the free plan)

## Install and Run

```bash
git clone https://github.com/drupflare/worker.git
cd worker
bun install
bun run hydrate
bun run dev
```

`assets/` and `.interp/` are generated and gitignored, so a clean clone has nothing to deploy until
`bun run hydrate` lands them. See [Building From a Clean Clone](#building-from-a-clean-clone).

Then open it:

```bash
open http://localhost:8787/
```

The first visit starts the site up, which is [First Boot](#first-boot) below. To replay the whole
database in one shot, which is faster locally:

```bash
curl "localhost:8787/migrate?all=1"
```

## First Boot

A deployed site has an empty Durable Object until something asks it for a page. The first request
records the ask, arms the alarm chain and answers 503 with a self-refreshing page, and the object
replays the packed database a batch of chunks at a time until the cursor is done.

| header                | value                                                |
| --------------------- | ---------------------------------------------------- |
| `x-cfw-migrate`       | `starting`, then `<chunk>/<chunks>`                  |
| `x-cfw-migrate-state` | `queued`, `running` or `failed`                      |
| `retry-after`         | `2` on the first request, `1` while chunks are going |

A browser follows the `<meta http-equiv="refresh">` on that page and lands on the site by itself.
Every other client gets the same 503 with the one-word body `migrating`.

Measured on a deployed free worker with the 75-chunk pack of that release, the replay took 2
invocations, `x-cfw-migrate` read `40/75` on the first poll, and a real Drupal page answered about 6
seconds after the deploy. A 503 in that window means the site is starting, not that the deploy
failed.

Free replays `FREE_CHUNKS_PER_INVOCATION` chunks per invocation, which is 40; paid and local replay
the whole pack in one. Batching is bound by chunk count because the clock does not advance across a
synchronous replay. The chunk count is whatever `assets/drupal-sql/manifest.json` reports, and it
moves whenever the packed database does.

## Claim the Site

The pack ships an installed database, so Drupal's `install.php` never runs and never asks you to
pick a password. `/firstrun` does that, and until it runs, uid 1 carries an empty hash that no
password can match.

An unclaimed site says so. Once the migration finishes, a browser asking for any HTML page gets a
one-click claim page instead of the front page: enter a site name, an administrator email and
optionally a password, and the credentials come back in the response. The page carries
`x-cfw-setup: required` and is never stored. A `curl`, an asset fetch and a POST all fall through to
the normal path, so only a browser navigation is blocked.

To claim it from a terminal instead:

```bash
curl -X POST "localhost:8787/firstrun" \
  -H 'content-type: application/json' \
  -d '{"siteName":"My Site","adminMail":"you@example.com"}'
```

The response carries `adminPass` and `ownerToken`, each shown once and stored nowhere. Save both
before closing the terminal. Pass `"adminPass":"..."` in the body to choose your own instead of
taking the minted one. Claiming a site also pins its render origin; see
[Site Identity and Origin](configuration.md#site-identity-and-origin).

The body takes `siteName`, `siteMail`, `adminName`, `adminMail`, `adminPass` and `timezone`, all
optional. A password never travels in a query string: `?pass=` is refused by name, because the
request line is what `wrangler tail`, observability and every intermediary log.

A bare `GET /firstrun` reports whether a site has been claimed without claiming it:

```bash
curl "localhost:8787/firstrun"
```

Once claimed, `/firstrun` answers 409. Reconfiguring is `POST /firstrun?force=1` with
`Authorization: Bearer <ownerToken>`, which resets the administrator password.

A claim is one invocation on a site still on the module set the pack baked. A migrated site claims
in three, each with its own CPU budget: a warm-up that fills the discovery caches, the module
install, then the claim itself. A CPU kill rolls back every write in its invocation, so a single
long claim restarted from nothing on each retry.

A migrated site claims with `POST /firstrun` and `{"migrated": true}`, which mints the owner token and
marks the site claimed without changing uid 1, the site name or any mail setting.

## Log In

Log in at `/user/login` as `admin` with the `adminPass` from the claim. That is the Drupal account,
and it is the only credential that reaches the administrative UI.

The owner token is a different credential and is not a Drupal login. It signs in to the `/_cfw`
pages at `/_cfw/login`, and it is sent as `Authorization: Bearer <ownerToken>` to reach the owner
routes directly, without turning on `PW_DIAGNOSTICS`. These are the ones this page uses:

<details>
<summary>Owner routes used on this page</summary>

| route          | what it does                                                        |
| -------------- | ------------------------------------------------------------------- |
| `/export`      | dumps the site database; the "a customer can leave" property        |
| `/health`      | the health ledger, the repair state and the budget projections      |
| `/settings`    | every runtime lever with its value and source; `PUT` merges a patch |
| `/setup/cf`    | connect, inspect or revoke a Cloudflare account for the site        |
| `/setup/mail`  | onboard a sending domain onto a zone                                |
| `/setup/oidc`  | set the OpenID Connect issuer and client id                         |
| `/installable` | whether a package can be installed here                             |
| `/install`     | fetch a package from a registry and write its files                 |
| `/enable`      | turn an installed module on                                         |
| `/modify`      | upload a module tree as a revision                                  |
| `/reconcile`   | what a site still owes the shipping pack, and one step of it        |
| `/sweep`       | coverage of the site's URLs, and one step of the sweep              |
| `/git`         | remotes, branches, pull requests and the working-tree diff          |

</details>

`OWNER_ROUTES` in `src/site/routes.ts` is the whole list. Without the token these routes answer 401
with a `WWW-Authenticate: Bearer` challenge; a diagnostic route answers 404 to the same caller.

Signing in at `/_cfw/login` exchanges the token for a session cookie that page script cannot read and
that no cross-site request carries. It expires after twelve hours, and `/_cfw/logout` ends it.

A dump withholds the owner token, the Cloudflare OAuth tokens and the hash salt, and reports how many
rows it held back. `?secrets=1` carries them: a faithful restore needs the salt, since it signs
one-time login links and form tokens, and a backup kept anywhere else should not have it.

A lost `adminPass` is recovered through Drupal's own password reset, which needs mail configured. A
lost `ownerToken` comes back with `drangler recover-token <site> --store`, which proves write access
to the site's `CONFIG_KV` namespace with a single-use record and receives the stored token;
`--store` saves it in the system keychain. [Owner Token Recovery](configuration-operations.md#owner-token-recovery)
has the protocol.

## Manage the Site

[`drangler`](https://github.com/drupflare/drangler) is the CLI for the rest of a site's life. It
needs no checkout of anything:

```sh
bun add -g @drupflare/drangler

drangler status my-site.example # plan, generation, header contract, claim state, diagnostics
drangler health my-site.example # is it up, and which cache tier answered
drangler doctor                 # the local toolchain and the Cloudflare credential
```

Moving to a newer Drupflare is `drangler update`. With no argument it fast-forwards the local
checkout and rebuilds the artifacts that belong to the version it left behind; naming a deployed
worker updates the checkout and then deploys it there.

```sh
drangler update             # the local .drupflare checkout, to the latest
drangler update --to v0.3.0 # or to a named version
drangler update my-site     # and then deploy it to an existing worker
```

The same CLI claims a site (`site claim`), recovers its owner token (`recover-token`), maps
hostnames (`domain add`), drives reconciliation and the sweep, uploads module revisions (`modify`)
and migrates a site in either direction. Its README has the command table and says which commands
write to a live site.

One deployment serves one site on any number of hostnames. `drangler domain add <host>` maps a
hostname and adds its Custom Domain route; [URL Routing](administration.md#url-routing) covers the
rest.

## Updating a Deployed Worker

The deploy button creates a repository from this one, so your worker is a copy and not a fork, and
the two share no history. Adding this repository as a remote lets you merge later releases into it.

```bash
# one time
git remote add template https://github.com/drupflare/worker

# to install an update
git switch master
git fetch --all
git merge template --allow-unrelated-histories -m "chore: merge upstream"
```

Pushing the result deploys it, if you connected the repository to Cloudflare when you created it.
Otherwise run `bunx wrangler deploy`, or `drangler update my-site` to update the checkout and deploy
in one step.

- The `git remote add` runs once per clone.
- Switch to the branch you want to update before merging.
- `--allow-unrelated-histories` is what lets two repositories with no common commit merge at all.
- Take a backup branch first, so a merge you dislike costs nothing:

```bash
git switch -c before-template-merge
```

To take a specific release instead of the tip:

```bash
git fetch --tags template
git switch master
git merge v1.0.4 --allow-unrelated-histories -m "chore: merge template v1.0.4"
```

Your own changes are the ones that conflict, and `wrangler.jsonc` is the usual place: it carries the
worker name and the bindings you added. Resolve it in favour of your values and take the template's
side elsewhere. `-X theirs` does that in one pass when you have made no changes worth keeping.

A merge that changes `src/` or the packed modules needs a deploy to take effect. A merge that changes
the pack reaches existing sites through reconciliation, described next.

## Keeping an Existing Site Current

The pack is delivered when a site is provisioned, so a fix that lands inside it reaches new sites on
its own. Reconciliation carries the same fix to sites that already exist. Each step is an
observation of the site's end state, not a script: it is checked before the step runs and again
afterwards, so a site that already matches is marked done without doing any work, and a step that
ran without converging is reported and not assumed.

The alarm chain drives one step per firing. `drangler reconcile` shows where a site stands and which
step is stuck, and `--run` takes a step now instead of at the next firing.

```sh
drangler reconcile my-site.example       # version, every step, and its standing
drangler reconcile my-site.example --all # drive steps until the version stops moving
```

Steps that change configuration or state go through Drupal's own writers, so every cached copy of a
value is invalidated by the code that owns it. A step that changes what the compiled container holds
drops the container and any stored heap image, and the next boot rebuilds it.

## Covering the Rest of the Site

A page is rendered when a visitor asks for it, and that visitor waits. The sweep enumerates the URLs
a site actually has, from its router table and its entity tables, ranks them by observed views then
recency then depth, and queues the top of the list for the same fill batch a visitor's request would
use. It never renders, so it cannot compete with a request for the interpreter.

It runs by default and is bounded: it refuses below a remaining-budget floor, spends at most a
declared share of the day's writes, and resumes the next day when that share is gone. Left unasked it
takes the smaller share; `SWEEP` sets it explicitly in both directions, and `SWEEP=0` turns it off.
The sweep's settings are listed in [The Addressable Sweep](configuration-operations.md#the-addressable-sweep).

```sh
drangler sweep my-site.example       # coverage, and what bounded the last step
drangler sweep my-site.example --run # take a step now
```

## Building From a Clean Clone

`bun install` restores the interpreter from the CDN in its postinstall step. `bun run hydrate` then
lands the packs: from the release payload when one is published, and from a source build when none
is. [Building From Source](building-from-source.md) covers the two routes, the prerequisites for
each, the seventeen build steps, and why `prefill` is the one step allowed to fail without failing
the build.

---

## Moving a Site In

[`drangler`](https://github.com/drupflare/drangler) reads an existing Drupal site, scores the move
and carries it over; the worker accepts what it sends.

- **Preview.** `drangler preview --host <ssh target> --root <docroot>` makes a working duplicate of
  a live site with read-only commands on the old server. It converts a MySQL, MariaDB or PostgreSQL
  dump to SQLite, carries the public and private files and the code, and reads `$config` literals
  and `.htaccess` redirects and headers. The duplicate runs on `wrangler dev`, or deploys with
  `--deploy`.
- **Drupal 10 sources.** A Drupal 10 site is a migration source that drangler plans onto the Drupal
  11 pack. A custom install profile travels inside the database, so the site can be claimed.
- **Registry-first delivery.** `/install` resolves a composer graph: `replace`, stability flags,
  branch aliases, branch archives, metapackages, virtual packages and `InstalledVersions`.
  Composer plugins are skipped. `drangler build --project` covers patches and private repositories.
- **Settings from the old host.** `DRUPAL_ENV_<NAME>`, `DRUPAL_CONFIG` and `DRUPAL_SETTINGS` reach PHP, and
  `RESPONSE_HEADERS` and `REDIRECTS` carry a migrated site's header and redirect rules. See
  [Migrated Project Settings](configuration.md#migrated-project-settings).
- **Response headers.** Every response carries `X-Content-Type-Options`, `X-Frame-Options` and
  `Referrer-Policy`, and `Strict-Transport-Security` over https. `RESPONSE_HEADERS` replaces or
  removes any of them and is where a `Content-Security-Policy` goes. The baseline is described on
  [Response Headers](security-controls.md#response-headers).

---
