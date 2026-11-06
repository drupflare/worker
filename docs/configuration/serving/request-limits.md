# Request Limits

The guard on outbound requests and the cap on request bodies.

## `OUTBOUND_GUARD`

PHP names the URL for `cfwFetch` and `cfwQueueFetch`, so any module able to build a string chooses
where the Worker connects. The guard refuses a scheme other than `http`/`https`, a URL carrying
credentials, and any host that resolves to loopback, an RFC 1918 range, carrier-grade NAT, IPv6
unique-local or link-local, or a name ending `.local`, `.internal`, `.localhost` or `.home.arpa`.
`169.254.0.0/16` is refused as a block because `169.254.169.254` is the cloud metadata address, and
an IPv4-mapped IPv6 literal is decoded first so `::ffff:a9fe:a9fe` cannot smuggle one through.

It is a deny-list because the legitimate destination set is open-ended: every update server, OIDC
provider, webhook endpoint and CAPTCHA verifier a site might use. An allow-list would need editing
to install a module.

Checked when the request is queued and again next to the `fetch()` in the drain, since a row can
reach `cfw_http_queue` by another path. `0` turns it off, which is what the e2e rig uses to point a
site at containers on the host.

## `MAX_BODY_BYTES`

This guards the heap, and leaves bandwidth alone. `parse_str()` on a form body allocates inside a
128 MB isolate, and `foo[][][][][]=bar` repeated turns a few hundred kilobytes of wire into far more
of it. Drupal's own `post_max_size` default is 8 MB; this is tighter, because there is no separate
process to lose here.

A body that declares a `Content-Length` is checked against it, which the platform holds the body to.
A chunked body declares none, so the edge reads it under the same ceiling and stops at the first
chunk that crosses it. `GET` and `HEAD` are not checked.

`multipart/form-data` has its own ceiling, `MAX_UPLOAD_BYTES`, because a 2 MiB cap on uploads would
be a functional regression. It defaults to 100 MiB, the platform's own request limit, which is the
only limit a multipart body had before the edge counted it.

## `MAX_RESTORE_BYTES`

A `/restore` body is one SQL dump, which the object holds as text and splits into statements, so it has
its own ceiling and the form-body one does not apply. The default is 16 MiB, a chosen value that has
not been measured against the isolate's heap. A fresh site's dump is 1.9 MB (n=1), which the 2 MiB form
ceiling would barely admit. `0` disables the guard.

Over either limit, the edge answers 413 before any Durable Object hop. `0` disables that guard
entirely. Raising `MAX_BODY_BYTES` trades isolate headroom for larger non-upload submissions; the
failure mode of too high is an object that runs out of memory mid-parse.

Consumer: `bodyTooLarge()` and `readBounded()` in `src/site/guards.ts`.
