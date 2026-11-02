# Migrated Project Settings

A project moved from another host usually reads environment variables, `$config` overrides, header
rules and redirects that the old host supplied. Five names carry them.

| name                | form                        | what it does                                                                   |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| `DRUPAL_ENV_<NAME>` | var or secret, one per name | PHP reads it as `getenv('<NAME>')`, `$_ENV['<NAME>']` and `$_SERVER['<NAME>']` |
| `DRUPAL_CONFIG`     | JSON object, as a secret    | merged over `$config` with `array_replace_recursive` at boot                   |
| `DRUPAL_SETTINGS`   | JSON object, as a secret    | merged over `$settings` with `array_replace_recursive` at boot                 |
| `RESPONSE_HEADERS`  | JSON array, KV-overridable  | `[{"path":"/blog/*","set":{"X-Frame-Options":"DENY"}}]`                        |
| `REDIRECTS`         | JSON array, KV-overridable  | `[{"from":"/old/*","to":"/new/*","status":301}]`                               |

Only the `DRUPAL_ENV_` prefix, `DRUPAL_CONFIG` and `DRUPAL_SETTINGS` reach PHP. The owner token,
`PW_DIAGNOSTICS`, mail credentials and API tokens live on the same environment and are never read
into it. A malformed value is ignored, and `/serve-stats` lists the names that were ignored under
`deploymentEnv`. A heap image is not taken or restored while any of them is set, because the image
would carry the old values. Values change with a redeploy.

`DRUPAL_SETTINGS` is for what `settings.php` carried on the old host, such as a module's
`$settings['...']` entries. It is read up to 64 KiB, and it cannot move the keys the Worker sets
itself: `trusted_host_patterns`, `config_sync_directory`, `container_yamls` and the public, private
and temp file paths. A key it names that is protected is dropped and listed in the ignored names.

`RESPONSE_HEADERS` matches an exact path or a `/prefix*`. It cannot set `Set-Cookie`, anything
starting `x-cfw-`, or the headers that frame the body. `REDIRECTS` matches an exact path (a trailing
slash is ignored) or a trailing `*` that carries the rest of the path into the target. It answers
before routing, so a redirect costs no Durable Object request, and it never applies to the Worker's
own routes such as `/settings`. Status is 301, 302, 307 or 308, 301 by default, and at most 100 rules
are read.

Every response the Worker answers carries `X-Content-Type-Options: nosniff`,
`X-Frame-Options: SAMEORIGIN` and `Referrer-Policy: strict-origin-when-cross-origin`, and over https
`Strict-Transport-Security: max-age=31536000`, with no `includeSubDomains` or `preload`. A
`RESPONSE_HEADERS` rule that names one of them replaces it, and a rule value of `""` removes it, which
a site embedded in another page needs for `X-Frame-Options`.

A Drupal module can set a header too. Security Kit's policy and a custom subscriber's
`X-Frame-Options: DENY` reach the browser, from the object, the edge cache, the isolate memo, KV, the
stale answer and the compiled plan for a signed-in page. The render reports
the response headers and the host keeps only these names: `Content-Security-Policy`,
`Content-Security-Policy-Report-Only`, `Permissions-Policy`, `X-Frame-Options`,
`X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`, `Cross-Origin-Opener-Policy`,
`Cross-Origin-Embedder-Policy`, `Cross-Origin-Resource-Policy` and `X-Permitted-Cross-Domain-Policies`.
A value with a line break, a character outside printable ASCII, or more than 4,096 bytes is dropped,
and `Set-Cookie`, `Location`, `Access-Control-*`, `Content-*` and `Link` are never forwarded. The
stored page carries them in the `headers` column of `cfw_page`, written by the same statement as the
page, so a fill costs no extra row. The order is the Worker's default, then the module's header, then
the operator's `RESPONSE_HEADERS` rule, so a module's `X-Frame-Options: DENY` replaces the default
`SAMEORIGIN` and a rule replaces both. A compiled plan holds the headers its two sample renders
agreed on, and sessions whose renders disagree on one do not compile a plan. The page mirror in R2
does not carry them (R2 serves a fixed header set).

`CSP_MODE` adds a baseline `Content-Security-Policy` to every HTML response: `off`,
`report-only` or `enforce`. It defaults to `report-only` on the paid plan and `off` on free, and an
unrecognised value falls back to that default. The policy is
`object-src 'none'; base-uri 'self'; frame-ancestors 'self'; report-uri /csp-report`. It sets no
`default-src`, `script-src` or `style-src`, so core's inline script and style keep working, and it
has no `form-action`, because Chromium applies that directive to the redirect after a form
submission, so a form that posts here and redirects to another origin (a login button for an
identity provider) would be blocked. A page
that already carries an enforcing policy, from a module or from a rule, keeps only its own in either
mode. One that carries only a report-only policy keeps it in `report-only` mode; in `enforce` mode
the baseline is still added, because a report enforces nothing. `CSP_MODE`
is on `KV_OVERRIDABLE`, so `PUT /settings` and the `settings` document set it, and Drupal's settings
form cannot: the form's submit reports it under `refused`. A strict `script-src` with nonces is not
part of it.

Browsers post a violation to `POST /csp-report`, which the Worker answers with `204` and never
passes to the Durable Object. It takes `application/csp-report` and `application/reports+json`, up
to 8 KiB, and writes one `cfw-csp-report` line per report to Workers observability with the blocked
URI (no query), the violated directive, the page path (no query) and the first 80 characters of the
sample. Each address may send 60 reports a minute and an isolate takes 600, counted in memory; past
either limit the answer is still `204` and nothing is logged. Static files the asset layer answers
(`/core`, `/modules`, `/themes`, `/agg`) carry the cache rules in `assets/_headers` and none of
these.

`/enable` is not needed for a text asset a migrated module ships: a `.css`, `.js` or `.svg` file
stored in `cfw_module_file` is served from `/modules`, `/themes`, `/profiles` and `/libraries` when
the pack does not hold the path. Binary assets are not served this way, because the table stores
source as text.

A migrated site claims with `POST /firstrun` and a body of `{"migrated": true}`. That mints the owner
token and marks the site claimed without changing uid 1, the site name or any mail setting. It takes no
`adminPass`, and an already claimed site answers 409.
