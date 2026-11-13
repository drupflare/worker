# Claiming and Managing a Site

How the first owner claims a freshly provisioned site, logs in, and finds the surfaces that manage it afterwards.

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
[Site Identity and Origin](../configuration/site-identity.md#site-identity-and-origin).

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

| route           | what it does                                                        |
| --------------- | ------------------------------------------------------------------- |
| `/export`       | dumps the site database; the "a customer can leave" property        |
| `/health`       | the health ledger, the repair state and the budget projections      |
| `/settings`     | every runtime lever with its value and source; `PUT` merges a patch |
| `/setup/cf`     | connect, inspect or revoke a Cloudflare account for the site        |
| `/setup/mail`   | onboard a sending domain onto a zone                                |
| `/setup/oidc`   | set the OpenID Connect issuer and client id                         |
| `/installable`  | whether a package can be installed here                             |
| `/install`      | fetch a package from a registry and write its files                 |
| `/enable`       | turn an installed module on                                         |
| `/modify`       | upload a module tree as a revision                                  |
| `/reconcile`    | what a site still owes the shipping pack, and one step of it        |
| `/sweep`        | coverage of the site's URLs, and one step of the sweep              |
| `/git`          | remotes, branches, pull requests and the working-tree diff          |
| `/writemark`    | start, read or end the count of writes accepted since a mark        |
| `/writechanges` | the rows changed since the mark, as a manifest or as SQL            |

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
`--store` saves it in the system keychain. [Owner Token Recovery](../configuration/operations/owner-access.md#owner-token-recovery)
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
hostname and adds its Custom Domain route; [URL Routing](../operating/administration.md#url-routing) covers the
rest.
