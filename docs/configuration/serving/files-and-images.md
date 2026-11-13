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
bytes either way (under `FILE_STORE=r2` a file already evicted serves from R2, and no file is
evicted without a verified put, so a spent budget stops new evictions and loses nothing). `/serve-stats` reports the month's tally as `r2`. Set it to `0` to stop both
mirrors while leaving `FILES` bound. On an account running several sites, divide the allocation
between them.

The share of traffic worth serving off the Worker depends on the traffic mix and on CDN absorption.
`optimalOffWorker()` in `scripts/measure/free-envelope.ts` computes it from the same model the free-plan
envelope uses.

## Files and Images

| var                   | default   | what it does                                                        |
| --------------------- | --------- | ------------------------------------------------------------------- |
| `FILES_PUBLIC_URL`    | unset     | origin a mirrored public file is linked from; unset uses the Worker |
| `FILE_STORE`          | unset     | `r2` makes the R2 buckets the home of file bytes; needs `FILES`     |
| `FILE_EVICT_AFTER_MS` | 900000    | how long a verified file stays in the object after its last write   |
| `IMAGE_ENGINE`        | `tinyimg` | which engine produces derivatives; `images` for Cloudflare Images   |
| `EAGER_DERIVATIVES`   | on        | render an upload's image styles on the rendering lanes; `0` off     |

### The R2 File Store

By default the Durable Object holds every file's bytes and `FILES` is an optional mirror of
`public://`, so uploads count against the 5 GB of object storage an account has. With
`FILE_STORE=r2` and `FILES` bound, R2 holds the bytes and the object keeps one metadata row per file.
The managed config sets it and binds a second bucket, `FILES_PRIVATE`, for `private://`. The canonical
config does not, so the one-click path is unchanged.

PHP calls the file store synchronously and R2 is asynchronous, so a write cannot wait for R2. The order
is write-behind:

1. PHP writes the file into the object as before. Drupal can read it back at once.
2. The alarm sends it to R2 with its SHA-256. R2 rejects the put if the bytes differ, and the drain
   also checks the stored size. A file rewritten while its put was in flight is left queued, not
   marked done.
3. After `FILE_EVICT_AFTER_MS` with no write, the object deletes the chunks. Eviction runs no R2 call,
   so a spent write budget cannot stop it, and it never touches a file whose put was not verified.

The grace window exists because Drupal often reads an upload back on the next request, and PHP cannot
wait for R2. Fifteen minutes is a chosen default, not a measured one. `0` evicts on the first alarm
after verification.

Reading an evicted file depends on who asks:

| reader                                            | what happens                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| a visitor requesting a public file                | the Worker streams it from R2 (`x-cfw-file-store: r2`)                     |
| the image styles                                  | the source is read from R2 on the Worker side                              |
| a download at `/system/files/...`                 | the object restores the file before PHP runs, then PHP serves it           |
| any other PHP read (`fopen`, `file_get_contents`) | the open fails and a restore is queued; a retry after the next alarm works |

`tests/integration/offloaded-file-reads.spec.ts` drives real Drupal over an evicted file. `file_exists`,
`filesize` and an overwrite (`file_put_contents`) work. `file_get_contents`, `getimagesize`, the image
factory, `fopen` in append mode and `FileSystem::copy()` and `move()` fail until the restore runs, and
all of them work after it. These are the flows that read the bytes of an old file inside PHP: cloning
or moving a file, regenerating an image's dimensions, and text extraction from stored documents. A
file edited within the grace window is unaffected. Raise `FILE_EVICT_AFTER_MS` for a site that runs
such flows on files older than that.

A rename of an evicted file is refused the same way, because R2 has no rename. The stream wrapper fails
the open of an offloaded file in every mode that reads, so an append cannot replace the file with a
fragment. A restored file stays in the object for another grace window.

`private://` files go to `FILES_PRIVATE` only, never to `FILES`. A custom domain publishes a whole
bucket, so the private bucket must not have one. Without `FILES_PRIVATE` bound, private files stay in
the object.

A site that switches to `FILE_STORE=r2` queues what the object already holds on its first alarm, and
the drain moves it under the normal limits. To move a site back to a config without `FILES`, call
`POST /mirror?rehydrate=1` with the owner token and wait until `storage.offloaded.files` in `/serve-stats` reads `0`. Removing
the var alone does not bring bytes back, and an evicted file whose bucket is unbound cannot be read.

R2 keys carry the site's name (`f/<site>/<scheme>/<path>`) and each row records the site that verified
its object. A site restored from another site's dump therefore starts with rows that name the
source's objects. It reads them, copies each under its own prefix on the alarm and re-points the
row only when the platform has granted that source (`file_clone:<site>` in `CONFIG_KV`); the name in
the row is a claim and never an authority. See [Recovery](../../operating/recovery.md#restore).

`/serve-stats` reports `storage.bytes` (every byte the site owns), `storage.offloaded` (the part
held only in R2) and `storage.adopting` (copies still queued after a restore). The `/export` dump holds file rows and no offloaded bytes; `GET /offloaded` lists those files and
streams each one, see [Recovery](../../operating/recovery.md#files-held-only-in-r2).

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

### Choosing GDToolkit

`gd` is not an engine in the sense `IMAGE_ENGINE` means. A shim in the drupflare module defines 40 of its functions, including
`imagegd2`, which is the only thing Drupal's `GDToolkit::isAvailable()` tests. So `GDToolkit` is selectable, and it is never the
default: `cfw_images` stays the toolkit on install and update (`Image\ToolkitDefault`), and a site that picks `gd` by hand keeps it.

Choosing GD builds every derivative at save time, in one park per image operation chain, and writes real pixels to the file
store. `cfw_images` writes a copy of the source and resizes at delivery. A site that reads a derivative's pixels needs GD; a site
that only serves styles does not.

What runs through the shim is what Drupal's own GD operations call: resize, scale, scale and crop, crop, convert, desaturate and
rotate. A custom image effect that reads or draws pixels (`imagecolorat`, the drawing functions, text) fails at the call.

Measured, all locally. Nothing below ran on Cloudflare, and no number here is a Workers CPU figure.

- **Drupal's GD operations end to end.** A real Drupal 11 kernel in the local workerd harness
  (`tests/integration/image-toolkit.spec.ts`), a 240 by 120 PNG, the shipped `thumbnail` style, toolkit set to `gd`: `image_scale`
  and `image_convert_avif` both apply, `GDToolkit::save()` returns true, and the derivative reads back as a 100 by 50 AVIF. Each of resize, scale, crop, scale and crop, desaturate, rotate 90 and rotate 30 applied through the toolkit API saves a PNG of the expected size (90 by 40, 120 by 60, 100 by 50, 64 by 64, 240 by 120, 120 by 240, 268 by 224); sizes were checked there, and pixels are compared by the differential below.
- **The differential.** `tests/gd-differential.php` runs the same calls against native gd and the shim with tinyimg as host, on PHP
  8.3.36 and 8.4.27: 389 rows, 383 PASS, 0 FAIL, 6 REFUSED on both. For `imagegd2`, 32 rows over 7 sources: 29 PASS and 3 REFUSED
  (the GIF source, which is an indexed handle; the shim writes true color GD2 only). Of the 26 file rows, 23 decode to the same
  pixels as libgd's file. The 3 AVIF rows differ by at most 1 level at 90.44 dB, the AVIF decoder spread that every AVIF row in
  the differential shows, with a floor of 89 dB. Raw files are byte for byte libgd's in 12 of 14 rows; the other 2 are the AVIF
  rows. Compressed files differ in the deflate stream, so they are compared by decoding. The reference is libgd 2.3.3 built with
  `ENABLE_GD_FORMATS=1`, because the Homebrew PHP builds used here have GD2 compiled out and `imagegd2()` there writes no bytes.
  The drawing, readback and text functions are not part of the 40.
- **Package size.** `assets/driver.json` grew from 1,031,632 to 1,034,458 bytes (+2,826) for `imagegd2`, the canvas-source copy and
  the GD2 writer; the writer lives in the host (`gd2Encode` in `src/ops/image-runtime.ts`) and adds nothing to the wasm module.
- **Derivative build cost, GD against `cfw_images` delivery** (1200 by 800 JPEG of 96,537 bytes to 300 by 200 JPEG at quality 75;
  the GD request is the one the shim emitted for a fresh white canvas and one `imagecopyresampled`; the delivery request is
  `runImageTransform` with the same size; `bun`, local, the module's work counters from `module.measure`):

  | counter                      | GD path   | delivery transform |
  | ---------------------------- | --------- | ------------------ |
  | source samples read          | 1,020,000 | 960,000            |
  | decoded samples              | 120,000   | 60,000             |
  | resampled samples            | 120,000   | 60,000             |
  | encode passes                | 2         | 1                  |
  | modeled work (`clockMicros`) | 7,850     | 3,909              |
  | output bytes                 | 7,829     | 7,829              |

  The GD path shows a second pass: 60,000 more samples read, decoded and resampled than the delivery transform. This
  run did not find which step of the host causes it. `clockMicros` is a count-derived estimate, not a clock. Wall time, 30 interleaved runs after 3 warmups in `bun` on an Apple M2 Pro, with the 1-minute load average at 2.97 when the timing started (other work was running on the machine before that, so the figure may carry some contention): GD path median 5.39 ms (min 5.01, max 7.02), delivery transform median 3.93 ms (min 3.72, max 4.12). The GD host function took about 1.4 times as long as the delivery transform for this one image. These are bun timings of the host function alone, not a request through PHP and not Workers CPU time.

- **Not measured.** Production Workers CPU for either path. Memory at the 128 MB isolate limit: the GD path holds the decoded
  source, the destination canvas and the queue's intermediate canvases as RGBA at once, and nothing here measured that peak. The
  PHP side (base64 and JSON of the request, the park round trips) was not timed. The workerd clock does not advance inside a
  request, so timings come from bun running the same host function with the same wasm, not from workerd.

GD2 reading (`imagecreatefromgd2`) is not shimmed. A palette GD2 is not written either: the host holds decoded pixels, not
palette indices, so `imagegd2()` on an indexed handle answers false and records a degradation. Core, WordPress and Joomla do not
write GD2.
