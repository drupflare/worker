# Request Controls

The controls on the request path, outbound requests, uploads and request parsing, and response headers.

## Request Path

| Control                                            | Where it is enforced                                                                | Strength                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `__` object routes answer 404 from outside         | front worker, `src/site/entry.ts:174`                                               | route table                                              |
| Owner routes need the owner token                  | front worker, `src/site/owner.ts`; object check in `src/do/routes/auth.ts`          | policy check, against a stored hash                      |
| Failed-token budget, 12 per 60 s per IP            | front worker, `src/ops/admin-session.ts`                                            | policy check; in memory, not a brute-force defence       |
| `?site=` ignored on visitor routes                 | front worker, `src/site.ts`                                                         | policy check                                             |
| Forged `x-cfw-*` headers stripped                  | `src/ops/forwarded-headers.ts`                                                      | policy check                                             |
| Request body capped at 2 MiB, multipart at 100 MiB | `src/site/guards.ts`, `src/ops/body-limit.ts`; a chunked body is read under the cap | policy check                                             |
| `PLAN` and `CSP_MODE` cannot be written by PHP     | `src/ops/plan.ts`, `src/do/capabilities.ts`                                         | policy check at the writer                               |
| The outbound guard has no lever                    | `src/ops/outbound-guard.ts`; four spellings tried in `settings-capability.spec.ts`  | read from the operator's environment only                |
| One Durable Object per site, id from host          | `src/ops/site-id.ts`                                                                | naming convention plus the platform's per-object storage |

A hard boundary is one where the host has no such function. A policy check is one where the
function exists and a list or a flag decides. The distinction matters for an attacker who can
change what PHP asks for, because a policy check is a decision about that request and a missing
function is not.

Before v1.0.4 the request cap exempted multipart bodies and nothing counted a chunked body while it
streamed, so the only bound was the platform's 100 MB request limit. A declared length is now
checked up front and a chunked body is read under the cap (`tests/integration/serve-edge.spec.ts`,
falsified).

## Outbound Requests

The guard in `src/ops/outbound-guard.ts` refuses private, link-local, metadata and credentialed
hosts, and `fetchGuarded` re-checks every redirect hop. Both fetch paths, the queue and the park,
call the same function. v1.0.4 closed four spellings that passed the string checks: a trailing dot
(`metadata.google.internal.`), the NAT64 prefix `64:ff9b::/96` and `64:ff9b:1::/48`, site-local
`fec0::/10` and multicast `ff00::/8` (`tests/unit/ops/outbound-guard.spec.ts`, falsified). 6to4
(`2002::/16`) and Teredo also embed a v4 address and are not matched.

The guard judges a string. A public name that resolves to a private address cannot be refused by it,
and whether a hosted Worker's `fetch` reaches link-local addresses was not measured. Both stay
`open`, and a deployed probe against a name with an A record of 169.254.169.254 would settle the
second. Egress to public hosts is open by design (see
[Data in the Same Object](../not-removed.md#data-in-the-same-object)).

## Uploads and Request Parsing

PHP's multipart handling is not entered for an inbound request. No SAPI delivers the request: the
render fragment receives the method, body and cookies as arguments, parses multipart by hand and
builds `UploadedFile` objects in userland (`src/site/php/pw-serve-inline.php`), and `$_FILES` is
empty. Nothing in `worker/src` or `phasm/src` calls `php_request_startup`, `sapi_activate` or
`php_default_treat_data`, and `pib_run` runs no request-startup cycle (Read).

Measured since v1.0.4: `tests/integration/multipart-submit.spec.ts` posts a multipart body with a
file and asserts from inside PHP that `$_FILES` is `[]`, that `is_uploaded_file()` is false on the
userland path, that the file arrived as a Symfony `UploadedFile` built by the render fragment, and
that its bytes match. Removing the fragment's record of the temp path fails it. The C-level claim
that PHP's own upload handler never runs stays Inferred, because php-src is fetched at build time.

The boot ini also sets `session.upload_progress.enabled=0`, `file_uploads=0`, `expose_php=0` and
`allow_url_include=0` (`PhpStatic` in `src/site-do.ts`). `session.upload_progress.enabled` is
`PHP_INI_PERDIR`, so boot is the only place to change it. Each value is read back from the running
interpreter in `interpreter-lifecycle.spec.ts`, and `disable_functions` is unchanged.

## Response Headers

Until v1.0.3, the front worker sent none of `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Strict-Transport-Security` or `Content-Security-Policy` on a Drupal page. The
render fragment forwarded only `x-drupal-*` headers, so core's own `X-Content-Type-Options` and
`X-Frame-Options` never reached a browser.

The v1.0.4 line sends three defaults on every response the Worker answers, and
`Strict-Transport-Security: max-age=31536000` over https (`src/ops/edge-rules.ts`):

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: strict-origin-when-cross-origin`

It also stores eleven allow-listed headers a module sets, such as Security Kit's, with the page and
replays them on every tier: the object, `caches.default`, the isolate memo, KV, the stale answer
and the compiled plan. Precedence is the default, then the module's header, then an operator
`RESPONSE_HEADERS` rule, and a rule value of `""` removes a header. `set-cookie`, `location`,
`link`, `content-*` and `access-control-*` are never replayed, and a stored value is re-checked on
read, so a row written through SQL cannot replay a cookie
(`tests/unit/ops/module-headers.spec.ts` and the tier cases in `serve-chain.spec.ts`,
`serve-edge.spec.ts` and `edge-read.spec.ts`, falsified).

`CSP_MODE` sets a baseline `Content-Security-Policy` on HTML that carries none:
`object-src 'none'; base-uri 'self'; frame-ancestors 'self'; report-uri /csp-report`. The default is
`report-only` on paid plans and `off` on free. A page that already carries an enforcing policy keeps
only its own. The baseline constrains `<object>`, `<embed>`, `<base>` and framing, and nothing else.
It sets no `script-src`, so it does not stop injected script (a strict nonce policy is `L`).
`form-action` is out of the baseline: a form that posts here and redirects to an identity provider
would break, and the OIDC and git-provider flows were not driven in a browser. `POST /csp-report`
answers in the front worker, rate limited, and logs one line per report. A real browser has not
loaded a core page under the header; the workers-pool check shows only that `/`, `/user/login` and
`/user/password` contain none of the four elements the baseline constrains. Verdict: `contained`
for plugin embedding and clickjacking, `open` for script injection.

A compromised Drupal administrator can still remove the baseline, because `RESPONSE_HEADERS` is
writable from Drupal's settings form and `{"path":"/*","set":{"Content-Security-Policy":""}}`
removes it. Refusing `CSP_MODE` from PHP closes only the direct switch. This is `open`, and
whether the form should lose `RESPONSE_HEADERS` is a decision the page leaves to the maintainer.

Two limits remain. Pages mirrored to R2 carry none of these headers (`L`: R2 serves a fixed header
set), and static files served by the asset layer carry cache rules and none of them.

A page whose response varies by `Accept`, `Origin`, `User-Agent` or `*` is not stored. The page
key holds no request header, so storing such a page would hand one visitor's variant to everyone.
On the stock pack nothing varies: `/` and `/user/login` rendered the same under five header sets,
and four requests through the front worker with different headers got one body
(`forwarded-headers.spec.ts`, `serve-edge.spec.ts`, Measured). The refusal is for modules that vary.
