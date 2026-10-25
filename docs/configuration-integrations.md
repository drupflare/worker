# Integration Settings

Settings for outbound mail, TCP, Workers AI, OIDC login and Spool. The index of every variable is on [Configuration](configuration.md).

## Outbound Mail

Drupal's mail plugin is `cfw_mail`, and it hands the message to the Worker. The Worker resolves one
of three transports and commits the message to `cfw_mail_queue`; the alarm sends it. `src/ops/mail.ts`
is the implementation.

The plugin is claimed by a config override that the module registers, not by `settings.php`.
Assigning `system.mail:interface.default = cfw_mail` from `settings.php` would name a plugin of a
module the site may not have installed, and `MailManager` throws `PluginNotFoundException` for an id it
cannot resolve. `MailInterfaceOverride` runs only when `drupflare` is installed, and it yields to `smtp`
on a site that has `smtp`.

| var                   | default  | what it does                                               |
| --------------------- | -------- | ---------------------------------------------------------- |
| `MAIL_TRANSPORT`      | `auto`   | `auto`, `binding`, `api`, `smtp` or `off`                  |
| `MAIL_FROM`           | none     | the From for a message that carries none                   |
| `MAIL_DRAIN_ON_ALARM` | on       | send queued mail from the alarm                            |
| `MAIL_DRAIN_LIMIT`    | 5        | messages one firing may send; capped at 25                 |
| `CF_EMAIL_ACCOUNT_ID` | none     | the account the Email Sending REST API posts under         |
| `CF_EMAIL_TOKEN`      | none     | an API token with Email Sending: Edit; a secret, not a var |
| `SMTP_HOST`           | none     | submission host for the third-party lane                   |
| `SMTP_PORT`           | 587/465  | 587 for STARTTLS, 465 for implicit TLS                     |
| `SMTP_TLS`            | starttls | `starttls`, `implicit` or `off`                            |
| `SMTP_USER`           | none     | submission user; omit for an unauthenticated relay         |
| `SMTP_PASS`           | none     | submission password; a secret                              |
| `SMTP_AUTH`           | `PLAIN`  | `PLAIN` or `LOGIN`                                         |

`auto` takes the first transport that is configured, in the order binding, api, smtp. The binding
leads because it spends no credential. The api transport is selected by either of its two variables,
and when only one is set the send is refused rather than falling through to smtp. The choice runs as
follows.

```mermaid
flowchart TD
    A["MAIL_TRANSPORT"] --> B{"selected value"}
    B -- "auto" --> C{"send_email binding bound as SEND_EMAIL?"}
    C -- yes --> T1["binding"]
    C -- no --> D{"CF_EMAIL_ACCOUNT_ID or CF_EMAIL_TOKEN set?"}
    D -- yes --> T2["api"]
    D -- no --> E{"SMTP_HOST set?"}
    E -- yes --> T3["smtp"]
    E -- no --> R1["refused: no transport configured"]
    B -- "binding" --> T1
    B -- "api" --> T2
    B -- "smtp" --> T3
    B -- "off" --> R2["refused: mail switched off"]
```

### The `smtp` Module's Own Settings

A site with `drupal/smtp` installed and configured needs none of the `SMTP_*` vars. The module
installs on this runtime and its socket never runs, so its settings would otherwise sit unread while
an operator typed the same relay a second time. Its
`smtp.settings` is read and mapped onto the transport: `smtp_host`, `smtp_port`, `smtp_username`,
`smtp_password` and `smtp_from` map across directly, and `smtp_protocol` maps `ssl` to implicit TLS,
`tls` to STARTTLS and `standard` to no encryption. `smtp_on` turned off is honoured.

A var always wins over the setting it corresponds to. A var is set by whoever can deploy the
Worker; the settings form is reachable by anyone who can get to a Drupal admin page. So the settings
fill gaps only, and setting `SMTP_HOST` pins the relay regardless of what the site is configured
with.

### What Each Transport Reaches

`binding` uses a `send_email` binding named `SEND_EMAIL`, declared in your own Wrangler config. `api`
uses the Email Sending REST API. Cloudflare applies the same limits to both, and to its own SMTP
endpoint, so the choice between them comes down to credentials. Two account-level facts decide what
either can reach:

- **A sending domain that is not onboarded** reaches verified destination addresses only: the 200
  per account that somebody confirmed by clicking a link. Onboarding the domain with SPF and DKIM on
  Cloudflare DNS lifts that immediately.
- **Workers Free has no outbound Email Sending.** The one carve-out is that sends to verified
  destination addresses are free on every plan, from your routing domains, against no quota.

So a free site can mail its owner and cannot mail a visitor who just registered. Third-party SMTP is
the only general answer on free, and a rejected Cloudflare send says so in its error text, with no
status code to read.

### The `send_email` Binding

The canonical config does not declare `send_email`. It is an ordinary Wrangler binding, so adding
one is a redeploy, and `allowed_destination_addresses` / `destination_address` narrow what it may reach.
Its prerequisites are account state the deploy button cannot provision: Email Routing enabled, at least
one verified destination address, and an onboarded sending domain. `api` needs only the token that
`/setup/cf` grants, so it is the transport the product provisions, and the binding is an opt-in.

### SMTP

SMTP is the only transport that opens an outbound TCP socket, and an outbound socket is on
Cloudflare's list of conditions that prevent a Durable Object from hibernating. The object is
therefore billed for compute duration for the length of the send, and the queue drains sequentially,
so a batch is billed for the whole batch. The socket is closed in a `finally`, which caps the
exposure at the send itself, well under the 15-minute maximum a connection can defer eviction by.
The `api` and `binding` transports use `fetch`, which never holds an object in memory.

<details>
<summary>Port and TLS refusals</summary>

Port 25 is blocked on Workers; `MAIL_TRANSPORT=smtp` with `SMTP_PORT=25` is refused by name, before
any attempt. `smtp.mx.cloudflare.net` is refused too: it resolves inside `162.158.0.0/15`, a
published Cloudflare range, and outbound TCP to those is blocked. Use `MAIL_TRANSPORT=api` or the
binding for Cloudflare mail. `SMTP_TLS=off` together with `SMTP_USER` is refused, because it would
put the relay password on the wire.

</details>

### Limits and What a Refusal Means

A message is refused at commit, where `CfwMail` logs the reason next to the operation that produced
it, for: no recipient, no From, more than 50 recipients across To/Cc/Bcc, a subject over 998
characters, headers over 16 KB, or a payload over 1,000,000 bytes. That last one derives from the
Durable Object record ceiling of 2,199,995 bytes; Cloudflare's own 5 MiB is the looser of the two and
never fires first.

A failure after commit is only visible on `/serve-stats`, under `mailQueue`, `lastMailDrain` and
`lastMailDrainAt`. A failed send is not retried: a send is not idempotent, and a password reset
delivered twice with two different one-time links is worse than one that did not arrive.

Mail sent through the `send_email` binding shows as dropped in the Email Routing summary even
when it was delivered. Read Email Sending metrics instead.

### Connecting a Cloudflare Account

Two ways, both owner-authenticated. Pasting `CF_EMAIL_ACCOUNT_ID` and `CF_EMAIL_TOKEN` needs no
setup. OAuth issues a short-lived scoped grant instead, revocable from the Cloudflare dashboard.

Owner-authenticated means `Authorization: Bearer <ownerToken>`, the token `/firstrun` returns once
when the site is claimed. Without it these routes answer 401 with a `WWW-Authenticate: Bearer`
challenge. `README.md` covers claiming.

`GET /setup/cf?action=connect&client_id=<id>` starts the flow and returns an authorize URL;
`/setup/cf/callback` completes it; `?action=status` reports whether an account is connected and
`?action=disconnect` revokes the grant at Cloudflare as well as forgetting it locally.

<details>
<summary>Registering the OAuth client</summary>

OAuth needs a client the operator registers once, under Manage account > OAuth clients, with
`https://<your-site>/setup/cf/callback` as its redirect URI and `private` visibility. A redirect URI
is registered against the client and every deployment answers on a different origin, so there is no
shared client that could serve all of them. The flow is Authorization Code with PKCE (S256) and
carries no client secret.

The client ID is stored in the site's own database, away from KV. It carries no secret, and a KV
writer who could change it would point the consent screen at an application they control.

</details>

Scopes requested: `user:read`, `account:read`, `email:read`, `email:write`. Onboarding a sending
domain additionally needs zone DNS write, which is why it is a separate opt-in step.

### Onboarding a Sending Domain

`GET /setup/mail?zone=<zone-id>` reports which step the domain is waiting on;
`?action=apply` creates the sending subdomain and writes the DNS records. Owner-authenticated, and
safe to re-run: a settled zone costs zero API calls.

| stage                   | meaning                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `no-zone`               | pick the zone this site sends from                           |
| `needs-subdomain`       | create the sending subdomain on that zone                    |
| `needs-dns`             | records still to write, counted in `waitingOn`               |
| `awaiting-verification` | click the link Cloudflare emailed to the destination address |
| `ready`                 | mail can send                                                |

`settled` means re-running changes nothing; onboarding may still be unfinished.
`awaiting-verification` is settled, because nothing more can be done from this side.

A sending subdomain is zone-scoped. Six records are written: three MX and an SPF TXT on the
return-path host, a DKIM TXT at `<selector>._domainkey`, and a DMARC TXT on the apex.

**An existing DMARC record is reported, never overwritten.** It states a policy for every mail
stream on the domain, so replacing `p=none` with `p=reject` would tell receivers to bounce
unauthenticated mail from senders that have nothing to do with this site. It appears under
`advisories` with both values, and the flow still reaches `ready`.

Destination-address verification is pollable: the address carries `status` and a `verified`
timestamp, so the surface updates on its own.

## Outbound TCP

Drupal reaches TCP through `Drupal\drupflare\Network\CfwTcp`, which declares a whole exchange and
reads the answer on a later invocation. `src/ops/tcp.ts` runs it between PHP invocations, over
[edgeport](https://github.com/gmitch215/edgeport). It shares the deferred HTTP tier's queue, cache
and retry budget.

| var               | default  | what it does                                            |
| ----------------- | -------- | ------------------------------------------------------- |
| `REDIS_URL`       | none     | `redis://user:pass@host:6379/0`, or `rediss://` for TLS |
| `SYSLOG_URL`      | none     | `syslog://collector:514`, or `syslogs://` for RFC 5425  |
| `SYSLOG_APP_NAME` | `drupal` | APP-NAME on every record this site ships                |

Both carry credentials, so both are secrets and neither is a `vars` entry, and neither can be set
from KV. A KV writer who could set `REDIS_URL` would receive whatever the site writes to it.

The endpoint belongs to the deployment, and never to the caller. Module code names a protocol and
an operation; the host supplies the host, port and credentials. Arbitrary `host:port` TCP behind any
code that can call a host function would be a port scanner and a protocol-smuggling surface.
Administrative Redis commands (`FLUSHALL`, `CONFIG`, `EVAL`, `SCRIPT`, `SHUTDOWN` and the rest of the
list in `src/ops/tcp.ts`) are refused before anything is dialled.

**A Redis cache backend cannot be built on this tier**, and it is served by a second one. A cache get
has to answer inside the request that asked, and a deferred exchange always misses the first time.
What this tier reaches is the deferrable half: a publish, a counter, a write nobody blocks on, or a
read a later request can use.

`syslog` is the shape this tier serves without compromise, because syslog over TCP never replies.

### The Parked Tier

`drupal/redis` works unmodified, over a second mechanism. A trapped socket call freezes PHP where it
stands, the Worker performs the exchange, and the call returns with the answer inside the same
request. Predis speaks RESP over `stream_socket_client`, and that is the shape the park suspends
under.

It arms only when `REDIS_URL` is set, and it dials that endpoint and no other: the host and port the
module asks for are checked for shape and then discarded, so a module that can build a string cannot
choose a destination. A request naming a port other than the configured one is refused. Any stream
the Worker did not open is handed back to PHP untouched, so arming does not disturb file writes in a
render.

The Durable Object's own SQLite is still the faster cache backend and the recommended one. A
parked get is a network round trip; a SQLite read is local. Measured from a Durable Object, a round
trip is 1 ms to a same-region server and 53 ms to a distant one, and every cache operation pays one.
Redis is here for a deployment that already has a server and wants Drupal pointed at it, not because
it is quicker. The status report says so on any site that enables the module.

A blocking outbound call over HTTP is served by replacing the transport rather than trapping it.
PHP reaches HTTPS through a stream wrapper the runtime invokes from inside a C frame, and a park under
one cannot resume, so Guzzle and Symfony's HTTP client are given a handler that yields from userland
instead. `drupal/openid_connect` completes a login through its own client that way. A call made from
inside an internal function such as `array_map` cannot park; it falls back to the deferred transport
rather than failing.

| var               | default | what it does                                                               |
| ----------------- | ------- | -------------------------------------------------------------------------- |
| `PARK`            | on      | whether the park may arm at all; anything but `1` routes renders around it |
| `SLEEP_BUDGET_MS` | 2,000   | total ms PHP may wait through the park per request; an alarm gets 15x      |

`sleep()`, `usleep()` and a Guzzle `delay` park for real, up to the budget. Past it, a sleep returns at
once and records how much it was short, so a retry loop never holds a visitor longer than a slow render.

## Workers AI

Inference is a queued tier over the same queue as outbound HTTP and TCP. A model call is declared,
run between PHP invocations, and read on a later one. `src/ops/ai.ts` runs it.

| binding or var | default        | what it does                                          |
| -------------- | -------------- | ----------------------------------------------------- |
| `AI`           | none           | the Workers AI binding; the tier is absent without it |
| `AI_MODELS`    | four model ids | comma-separated allow-list of model ids               |

The tier uses the binding. A REST call to `api.cloudflare.com` needs an `Authorization: Bearer`
header and the account id in its URL, which would put the account token in a queue row; the binding
carries its own authorisation.

Neurons are a fourth meter. 10,000 per day on Workers Free and Workers Paid alike, reset at
00:00 UTC, and exhaustion arrives as HTTP 429 with error 3036, never as a bill. Neither the serving
ceiling nor the regeneration ceiling sees it. `/ai` reports a projected cost per call, derived from
Cloudflare's published per-model rate and an approximate token count; the binding returns no metered
figure, so the projection is arithmetic and is labelled as such.

Measured on a deployed free-plan site: a `llama-3.3-70b` completion projects to 102.62 neurons, which
is **97 completions a day**. A `bge-m3` embedding of a short text projects to 0.01, and indexing 1,000
nodes at 500 tokens each is about 5% of one day. Embedding-backed search fits the free allocation;
chat completion overruns it.

### Two Catalogues

Cloudflare publishes two model lists and the difference matters to a site owner.

| catalogue                         | what it is                                                           |
| --------------------------------- | -------------------------------------------------------------------- |
| Workers AI, `/workers-ai/models/` | every entry Cloudflare-hosted; inference runs on Cloudflare hardware |
| unified AI catalog, `/ai/models/` | the above plus third-party models reached through AI Gateway         |

The extra entries on the unified catalogue are external providers (OpenAI, Anthropic, Google, xAI)
reached over AI Gateway and billed through it. A prompt sent to one leaves Cloudflare.

`Partner` is a separate axis. A Partner model on the Workers AI catalogue has proprietary weights and
still runs on Cloudflare hardware: Deepgram, Leonardo, Black Forest Labs and NVIDIA all appear there.
The privacy line runs between Cloudflare-hosted and external provider, and open-weight against
partner is a different line entirely.

`AI_MODELS` is the control. Its default list is Cloudflare-hosted only.

### What This Tier Does Not Do

**No inline AI in a render.** A block or field formatter calling a provider during a page render
holds the object across the round trip, which makes it ineligible for hibernation and bills as wall
clock. The surfaces this tier fits are the ones that already retry and already show progress:
generation on save, moderation, alt text, summarisation, and embedding on the cron path.

No streaming. The unit this queue carries is a finished response body.

## OIDC Login

A login is completed by the Worker. The callback is an ordinary request, so the token exchange and
the `id_token` signature check happen in JavaScript before PHP is entered, and PHP is handed a
decided result. `src/ops/oidc.ts` is the implementation.

This route needs no module. `drupal/openid_connect` also works, through its own client: the
`openssl_*` functions are bridged to the host's crypto and the token POST is parked. An unverified
`id_token` is an unauthenticated login either way, so both paths verify the signature.

| setting              | where      | what it does                                         |
| -------------------- | ---------- | ---------------------------------------------------- |
| `oidc_issuer`        | `cfw_meta` | the provider's issuer URL; https, or a loopback host |
| `oidc_client_id`     | `cfw_meta` | the client registered with that provider             |
| `OIDC_CLIENT_SECRET` | binding    | for a provider that issued one; a secret, not a var  |

The issuer and the client id sit in the object's own storage, and the secret is a binding. None of
the three can be set from KV: a writer who could change the issuer would point the consent screen at
a provider they control, and every login on the site would authenticate against it.

Plain http is refused except on a loopback host, which is what lets a provider run on the same machine
during development. A deployed Worker has no loopback to reach, so the exemption grants nothing there.

Register `https://<your-site>/oidc?action=callback` as the redirect URI. `/oidc` starts a login and
accepts an optional `return` path, which must be site-relative. It is a public route because a
provider's redirect carries no header this Worker controls; `state` is what authenticates it.

Completing a login also needs `drupal/externalauth` installed on the site, which is what maps the
verified identity onto an account. No contrib module ships in the packed tree, so install it from the
Extend page at `/_cfw/extend` before the first login.

`/setup/oidc` reads and writes the two `cfw_meta` values, and `/_cfw/access` is the page over it.

| action           | method | what it does                                                                   |
| ---------------- | ------ | ------------------------------------------------------------------------------ |
| `?action=status` | GET    | the issuer, the client id, whether the secret binding is set, the redirect URI |
| `?action=save`   | POST   | validates and stores the pair, then fetches the discovery document             |
| `?action=clear`  | GET    | forgets both, which turns login off                                            |

It is an owner route, so it takes the token minted at first run and refuses the admin page's
weaker gate. Reading which provider is configured is harmless; choosing it is not.

The issuer must be `https` and must carry no query or fragment: the discovery URL is built by
appending a fixed path, so an issuer carrying either produces a URL nobody intended. A trailing slash
is normalised away so that discovery and the later `iss` comparison agree on one spelling. Saving
fetches the discovery document immediately and reports what it advertises, so a wrong issuer surfaces
at configuration time, well before someone's first login. The secret is never read back.

**The claims never travel in a URL.** The browser carries a single-use ticket; the claims stay in the
object's storage and the row is deleted before they are returned, so a second presentation of the
same ticket finds nothing. A redirect lands in browser history, in a referrer and in any proxy log
on the path.

Five conditions refuse a login, each tested against real generated keys: a signature from a key
outside the provider's JWKS, an issuer that is not the configured one, an audience belonging to
another client of the same provider, an expired token, and a nonce from a different login. `none`
and the HMAC algorithms are refused by omission. The signing algorithm is taken from the key and not
from the token header, and an account is keyed by issuer and subject together.

## Spool

[Spool](https://github.com/drupflare/spool) is the client-side replica. The front worker runs its
proxy in front of the page pipeline, so a visitor's browser can keep a public page and show it again
without asking the site, until a change makes that copy wrong. `SPOOL` turns it on: paid sites
default to on, free sites to off, and `0` or `1` overrides either. A free site stays off by default
because the service worker's update check, its syncs and its beacons are Worker requests, and Worker
requests are the limit that binds a free site. The levers are on `KV_OVERRIDABLE`, so `PUT /settings`
and the `settings` document set them, and Drupal's settings form cannot: its submit reports them
under `refused`.

What it does while it is on:

- An anonymous `GET` or `HEAD` answered `200` with HTML gets spool's client tag and envelope headers.
  This runs after every cache tier, so no stored or cached page is the decorated one. A request with
  a cookie or an authorization header, a response that sets a cookie, an owner or diagnostic route
  and anything that is not a page go through untouched.
- `/spool-sw.js` and everything under `/.spool/` are answered in the front worker by the library: the
  service worker script, the client script at `/.spool/<version>/client.js`, `/.spool/sync`,
  `/.spool/artifact` and `/.spool/beacon`. Those paths are reserved, so no redirect rule captures
  them. Each address may make 120 requests a minute to them and an isolate takes 3,000, counted in
  memory; past either limit the answer is `429`. A beacon becomes one `cfw-spool` line in Workers
  observability, bounded in size and count, and writes no row.
- The object keeps a version vector in memory, a map from tag to the cursor of its last change, and
  answers a sync from it on the internal `/__spool` route. A cursor is the generation times 4,096
  plus a count inside it. A sync costs one Durable Object request. Decorating a page costs none,
  because the generation rides on the page response; a device that piggybacks a sync on a navigation
  makes the front worker ask once per cursor in each isolate for two seconds and answer the rest from
  memory. A scoped purge stamps the tags it invalidated and the cached paths that depend on them. A
  wholesale bump, an object restart and a vector past 2,000 tags each tell a device behind that point
  to reset, which costs it its copies and never shows it a stale page.

The media features run only while spool is on, each with its own lever that defaults to on:

- `SPOOL_IMAGES` converts a PNG or JPEG to WebP for a browser whose `Accept` header allows it, caches
  the result in the isolate by content hash, adds `Vary: Accept`, and leaves the original when the
  conversion is not smaller. It also asks for `Sec-CH-Width` on pages that carry images. An image that
  already fits the requested width is converted at its own width, because tinyimg 1.1.1 enlarges an
  image to the width it is given even with `fit: 'scale-down'`.
- `SPOOL_VIDEO` adds `preload="none"` to `<video>` tags, so a page no longer downloads a video the
  visitor has not played.
- `SPOOL_EMBEDS` replaces a server-rendered YouTube or Vimeo iframe with a facade that loads the
  player on click.

Spool's lazy loading, responsive sizing, dictionary compression and trim options are not enabled.

One limit is known. The vector lives in memory, so an object that restarts forgets the changes it had
recorded inside its current generation. A device that synced a page rendered in the window between a
save's first write and the flush of its complete tag set can keep that page until the next change.
Devices holding any earlier generation reset.

The saving is spool's to state, and spool labels every figure it states. At version 0.2.0 its impact
page gives a headline of 12.4 J per local view (L2: published intensities applied to the 17,054-byte
median document a local view replaces, not a meter reading), 0.80 J saved on a desktop against
optimized HTTP caching (L1, measured), 0.088 J saved on an iPhone over Wi-Fi (L1, measured), and one
request avoided per local view. This page does not repeat or extend them. The demand claim that
carries over is the one request: a local view removes one Worker request and the document's bytes,
and only for a view answered inside its freshness bound, 15 minutes soft for a public route. The
first visit to a site adds requests (the client script, the worker script and its update checks,
syncs and beacons). Spool does not claim a radio-wake saving, a capacity saving without evidence
that equipment was removed, or a Transformative share, and neither does this page. The CPU cost of
rewriting a page and converting an image on the hot path is not measured here; the platform's
`cpuTime` on a deployed site is the only instrument for it.
