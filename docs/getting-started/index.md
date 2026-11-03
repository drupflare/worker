# Getting Started

From a clean clone to a running site, then claiming it and moving an existing one in.

## Pages

- [Claiming and Managing a Site](claim-and-log-in.md): claim a new site, log in, and the management surfaces.
- [Updating a Site](updating.md): taking a new release, keeping a site current, and what an update leaves alone.
- [Reproducing Thunder](reproduce-thunder.md): rebuild a Verified codebase on your own machine and score it.

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

## Building From a Clean Clone

`bun install` restores the interpreter from the CDN in its postinstall step. `bun run hydrate` then
lands the packs: from the release payload when one is published, and from a source build when none
is. [Building From Source](building-from-source/index.md) covers the two routes, the prerequisites for
each, the seventeen build steps, and why `prefill` is the one step allowed to fail without failing
the build.

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
  [Migrated Project Settings](../configuration/migrated-settings.md#migrated-project-settings).
- **Response headers.** Every response carries `X-Content-Type-Options`, `X-Frame-Options` and
  `Referrer-Policy`, and `Strict-Transport-Security` over https. `RESPONSE_HEADERS` replaces or
  removes any of them and is where a `Content-Security-Policy` goes. The baseline is described on
  [Response Headers](../security/controls/requests.md#response-headers).
