# Security Policy

## Supported Versions

Security fixes go into the latest 1.0 release only.

| Version | Supported |
| ------- | --------- |
| 1.0.x   | latest    |

A fix ships as a patch release. A running site picks up the Worker change on its next deploy, and
a new interpreter build also needs its pin merged. [docs/php-update-delivery.md](docs/php-update-delivery.md)
describes that path, and the release notes say which step a given fix needs.

## Reporting a Vulnerability

Do not open a public issue for a vulnerability. Report it privately through GitHub's
[private vulnerability reporting](https://github.com/drupflare/worker/security/advisories/new), or
by email to the maintainer at <me@gmitch215.xyz>.

Include the Drupflare version, whether the site runs on Cloudflare Free, Paid, a managed deployment
or self-hosted `workerd`, the steps to reproduce, and what an attacker gains. A failing test or a
minimal site is the fastest way to a fix. Do not include credentials or another person's data in a
report; a redacted request or a description is enough.

The maintainer confirms the report, works on a fix in private, and publishes a GitHub security
advisory with the patch release. Reporters are credited in the advisory unless they ask not to be.

## Scope

In scope:

- the Worker in this repository: the front worker, the Durable Object, owner routes, the SQL
  bridge, the `cfw*` host functions and the tuned interpreter glue
- the `drupflare` and `rom` Drupal modules and the `stream-http` library as packed into this
  repository's `assets/driver.json`
- the interpreter build pinned in `interp.lock.json` and the workflows that fetch and verify it
- `docs/security.md` where it states something that is false

Out of scope, with where to send it:

- a vulnerability in Drupal core or a contributed module: the
  [Drupal Security Team](https://www.drupal.org/drupal-security-team)
- a vulnerability in PHP itself: [php-src](https://github.com/php/php-src/security)
- a vulnerability in the Cloudflare platform, `workerd` or V8: Cloudflare, through its
  [vulnerability disclosure program](https://hackerone.com/cloudflare)
- a flaw in a site's own code or configuration, and an attacker who already holds the owner token
  or the Cloudflare account
- findings that need physical access, social engineering or a denial of service by volume alone

A Drupal or PHP remote code execution that runs inside a Drupflare site is a report for those
projects. What the attacker can then reach from inside the sandbox is in scope here.

## How the Runtime Contains a Foothold

The full threat model, with the file and the test behind each claim, is
[docs/security.md](docs/security.md). In short:

- **PHP runs as WebAssembly inside a V8 isolate inside Cloudflare's process sandbox.** There is no
  operating system, shell, web server or inbound socket in the site's trust boundary, and the module
  has no process to fork or exec into.
- **The interpreter reaches the host through a fixed list.** 102 module imports and 31 `cfw*` host
  functions are each classified in `config/host-imports.json`, and a gate fails when a new import is
  not. The glue refuses the socket calls and the JavaScript bridge `vrzno` would otherwise open.
- **Credentials sit outside SQL.** The owner token is stored only as a SHA-256 hash, and the git
  tokens and the Cloudflare grant are stored beside it, in key-value storage that the SQL bridge
  cannot read or write. Recovery rotates the token.
- **Persistence is held to sealed records.** Installed module files and stored interpreter heap
  images are checked against SHA-256 records in the same sealed storage before they are mounted or
  restored.
- **Owner calls leave a hash-chained log**, which `drangler audit --verify` recomputes.
- **Every claim is tagged** as read, measured or inferred, and every row is one of `removed`,
  `contained` or `open`. A claim that could not be established counts as `open`.

## What Drupflare Does Not Protect Against

Drupflare lists what it does not protect against rather than leave it to be found.

- A bug in Drupal, a contributed module or PHP still compromises the site. The attacker runs PHP
  inside the sandbox, with the whole site database, which sits in the same Durable Object.
- WebAssembly gives no protection against memory corruption inside the module. Do not count on
  exploit difficulty inside the sandbox.
- Egress to public hosts is open by design, and the outbound guard judges a string. A public name
  that resolves to a private address is not refused.
- A Cloudflare account holder can read and edit a site's Durable Object storage. The audit log is
  evidence against a site-level attacker and not against the account holder.
- Some authority still lives in SQL: the git remote list, the claim window and the OIDC provider
  settings. A planted module row on a primary reaches its replica lanes unchecked.
- Platform risk is Cloudflare's: engine bugs, side channels between co-located isolates, and outages.
  Cloudflare states a V8 patch gap under 24 hours. The PHP interpreter and Drupal are patched through
  Drupflare releases, a separate and slower path.

The [open rows of the class table](docs/security.md#classes-addressed-in-v104) and the
[Planned Work](docs/security.md#planned-work) table list each one with its size.

## Maintenance

Gregory Mitchell maintains Drupflare. Dependencies are kept current through Renovate. Security
changes land with a test that fails without them, and a measurement taken on a local `workerd` is
labelled that way and never upgrades a claim to `removed` by itself.

Security-relevant contributions are welcome through pull requests. Keep exploit details out of
public pull requests until the advisory is published.
