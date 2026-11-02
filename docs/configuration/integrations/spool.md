# Spool

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
