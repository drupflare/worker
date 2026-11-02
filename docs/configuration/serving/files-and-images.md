# Files, Images and Prefill

How prefill warms a site and mirrors its pages, where files are served from, and how image styles are delivered.

## Prefill and Mirroring

| var                     | default                   | what it does                                                                        |
| ----------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `PREFILL`               | on for free, off for paid | seed the serving table from `assets/prefill.json`                                   |
| `PREFILL_ON_SAVE`       | on                        | re-render invalidated paths after a content save                                    |
| `PREFILL_ON_SAVE_LIMIT` | 25                        | paths one save may queue                                                            |
| `SAVE_DEBOUNCE_MS`      | 2000                      | how long the refill after a save waits for the rest of a burst; `0` refills at once |
| `MIRROR_LIMIT`          | per plan                  | files one alarm firing may push to R2; capped at 25                                 |
| `R2_WRITES_PER_MONTH`   | 900000                    | R2 writes both mirrors may spend in a UTC month; `0` turns both off                 |
| `HTTP_DRAIN_ON_ALARM`   | on                        | drain queued outbound requests from the alarm                                       |
| `HTTP_DRAIN_LIMIT`      | per plan                  | queued outbound requests one firing may fetch; capped at 25                         |

`PREFILL` is on for free because free is where a cold first request costs the most: a prefilled path
is a hit on its first ever request. It is off during a bake, or every render would be a hit of the
file being rebuilt.

`SAVE_DEBOUNCE_MS` holds the refill after a save for a short window, so a burst of saves costs one
generation bump and one render of each affected page. A refill that ran between two saves would
reopen the invalidation and make the second save pay for both again. The window starts at the first
save and later saves do not extend it. A visitor who asks for an invalidated page is still served at
once; only the pages nobody has asked for wait.

`R2_WRITES_PER_MONTH` caps what the file and page mirrors spend together. R2's allocation is
1,000,000 Class A operations a month per account, and every put past it is billed; the default stops
one site at 90% of that. The count is kept in `cfw_meta` under a key that names the month, so it
resets on the first of each month. Deletes count as well, so the tally reads high. A spent budget
leaves the rest of the queue in place and every file keeps serving from the object, which holds the
bytes either way. `/serve-stats` reports the month's tally as `r2`. Set it to `0` to stop both
mirrors while leaving `FILES` bound. On an account running several sites, divide the allocation
between them.

The share of traffic worth serving off the Worker depends on the traffic mix and on CDN absorption.
`optimalOffWorker()` in `scripts/measure/free-envelope.ts` computes it from the same model the free-plan
envelope uses.

## Files and Images

| var                 | default   | what it does                                                        |
| ------------------- | --------- | ------------------------------------------------------------------- |
| `FILES_PUBLIC_URL`  | unset     | origin a mirrored public file is linked from; unset uses the Worker |
| `IMAGE_ENGINE`      | `tinyimg` | which engine produces derivatives; `images` for Cloudflare Images   |
| `EAGER_DERIVATIVES` | on        | render an upload's image styles on the rendering lanes; `0` off     |

### Image Styles

A public image style's URL points at the Worker's delivery path, `/cfw-img/<id>/<uri>?<transform>`,
where the front worker renders the derivative with tinyimg. The drupflare module rewrites the URL
from the style's effect chain: scale, scale-and-crop, resize and convert each map to one transform.
A chain that cannot be expressed as one transform, and any private file, keeps Drupal's stock URL.

With `RENDER_LANES` bound, an image written to `public://` is queued, and the next alarm renders
every configured style at once on the rendering lanes, Durable Objects that hold no Drupal state.
The results are stored under `public://cfw-derivatives/`, and the image route answers a stored copy
in place of the source on the request it already makes, marked `x-cfw-image: STORED`. In measurement on
a deployed worker with the four shipped styles (n=5), the render job took 984-1,718 ms on four lanes
with five or six Durable Object requests. A stored first view answered in 41-91 ms, and the same style
rendered on first view took up to 1,647 ms. Stored and rendered bytes were identical in all 20
comparisons. Through the media form, an upload answered 303 in 750-939 ms and all four styles were
stored 3.9-4.4 s after the POST. `EAGER_DERIVATIVES=0` returns to rendering on first view.

### `FILES_PUBLIC_URL`

Unset, every file is served through the Worker, which is correct and costs one Worker request per
file. The front worker answers `/sites/default/files/<path>` from the object's file store and caches
it for 300 seconds. Drupal has no route for a public file, so until this route existed every public
original answered Drupal's 404 on a site with no mirror. PNG, JPEG, GIF, WebP and AVIF render inline;
every other type, SVG and PDF included, is sent as a download under a sandboxing
`Content-Security-Policy`, because the file shares the site's origin and its session cookie. Set to
an R2 custom domain, a public file that has already mirrored to the `FILES` bucket is
linked at that origin instead and costs no Worker request at all.

That is one of only two paths on the platform that cost nothing. A zone Cache Rule is not one of them:
the Worker runs before the cache is consulted, so a cache hit still spends an invocation. The two are
a static asset and a hostname that is not routed to the Worker.

Two files never get the external URL. A `private://` file is never linked externally at any setting,
because the bucket has no session and the URL would bypass Drupal's access check. A public file that
has not mirrored yet keeps the Worker URL, because the alternative is a 404 on a file the site holds.

### `IMAGE_ENGINE`

`tinyimg` is the default and runs in the front worker, where it never meets PHP's heap. It needs no
zone, no binding and no subrequest, and it has no monthly cap.

Cloudflare Images is reachable with `IMAGE_ENGINE=images`. It is the only one of the two that encodes
AVIF, and it costs a zone with transformations enabled, does not exist on `*.workers.dev`, and caps at
5,000 transformations a month. Against the four shipped image styles that is 1,250 images before a
site stops generating derivatives.

The toolkit reports the engine's real format list. All four
shipped styles are `image_scale` plus `image_convert_avif`, and core's `AvifImageEffect` asks the
toolkit whether AVIF is supported before using it, falling through to the style's configured fallback
of `webp` when the answer is no. So core degrades on its own with no config change, provided the
toolkit tells the truth. Claiming `avif` on the tinyimg engine produces a logged failure instead of a
fallback.

Measured on a deployed free worker, `cpuTime` amortised over 10 transforms per invocation, median of
12, against a source-only control at 0 ms: thumbnail 36.3 ms, medium 48.6, large 63.5, wide 188.2.
Styles at or below 480 px on the long edge are produced inline; larger ones go to the fill queue.

gd is not an engine. Code that calls PHP's `imagecreate*` functions directly finds them absent on this
runtime.
