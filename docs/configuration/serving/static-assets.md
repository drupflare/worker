# Static Asset Settings

Cache lifetimes for static assets, the response headers a request carries, and asset aggregation.

## Static Asset Cache Lifetimes

`assets/_headers` sets `Cache-Control` on the files the asset layer serves. Without it every asset
answers `public, max-age=0, must-revalidate`, so a repeat view revalidates each stylesheet, script
and font.

| path                                 | `Cache-Control`                       |
| ------------------------------------ | ------------------------------------- |
| `/agg/*.css`, `/agg/*.js`            | `public, max-age=31536000, immutable` |
| `/core/*`, `/modules/*`, `/themes/*` | `public, max-age=31536000`            |

An aggregate's file name is the first 16 hex characters of the SHA-256 of its body
(`scripts/pack-aggregates.ts`), so a changed file gets a new URL and a year is safe. `/agg/manifest.json`
has no hash in its name and keeps the default.

The three Drupal prefixes get a year, which is what Drupal's own `.htaccess` allows
(`drupal-src/.htaccess:42`). The `?token` Drupal appends to those URLs is not tied to the shipped
files. It comes from `state` key `asset.css_js_query_string`, and only `drupal_flush_all_caches()`, a
site install and the `assets` flush step of the update chain reset it (`drupal-src/core/includes/common.inc:429`,
`src/site/php/updb/unit.php:252`). Reconciliation does not, so a pack update that changes a `/core`
file leaves an existing site's URLs the same, and a visitor keeps the old copy until it expires or
the token changes.

`_headers` has no allow line in `assets/.assetsignore` and must not get one. Wrangler ignores it by
default and reads the rules from the directory; an allow line uploads it as an ordinary asset, and a
deployed worker then answers `/_headers` with the file (200, 282 bytes, measured on a deployed worker).

HTML comes from the Worker and is not affected. `/robots.txt`, `/driver.json`, `/prefill.json`,
`/drupal-pf/*` and `/drupal-sql/*` have no rule.

## WordPress Assets

A WordPress site serves its browser files from `assets/wordpress-site/`, not from `assets/`. The
Drupal asset directory has no rule for `/wp-includes`, `/wp-admin` or `/wp-content`, so a Drupal
deploy publishes none of it. Deploy a WordPress site with `--assets assets/wordpress-site` and
`CMS=wordpress`. The directory has to be separate because the asset layer answers before the Worker:
`assets/robots.txt` is Drupal's static file, and with it published WordPress could not serve its own
virtual `robots.txt`. `/favicon.ico` is the same, and WordPress redirects it to the site icon.

`bun scripts/pack-wordpress.ts --site` writes the directory from `wordpress-src`, and `bun run
assets:wordpress` runs it last. The directory holds:

- the stylesheets, scripts, images and fonts of `wp-includes` and `wp-admin`
- the same file types of the active theme, `twentytwentyfive`
- a copy of the WordPress pack the object reads through its asset binding
- a generated `_headers`

A stock tree publishes 976 files and 41,495,778 bytes. The largest is
`wp-includes/js/dist/script-modules/vips/worker.min.js` at 13,418,072 bytes. The limits are 20,000
files per version on free and 100,000 on paid, and 25 MiB per file; the packer fails above the free
count or the file size. `--themes=a,b` publishes other bundled themes and `--themes=all` publishes
all fifteen, which is 1,645 files and 75,041,354 bytes. A site that activates a theme whose files
are not published renders without that theme's fonts and images.

Left out on purpose:

- PHP, JSON, `.txt`, `.scss` and the other files no page links. WordPress reads PHP and JSON from
  the pack.
- The plain copy of a script or stylesheet when a `.min` file sits beside it: 528 files, 36,491,342
  bytes. WordPress loads the plain file only when `SCRIPT_DEBUG` is set. Core PHP names 442
  scripts and stylesheets outright, and those stay published, since `wp-tooltip.js` and
  `svg-painter.js` are requested plain even with a `.min` file present.
- Right-to-left sheets: 460 files, 4,171,329 bytes. No language pack ships.
- `wp-content/uploads`. Uploaded files are not static assets.

Stylesheets and scripts get `public, max-age=31536000, immutable`, because WordPress requests them
with a `?ver=` query that changes on an update. Images and fonts are linked from stylesheets with no
version, so they get the year without `immutable`. `_headers` is generated from the published list
with one rule per directory and extension, since the platform joins the headers of every rule that
matches.

`/wp-admin/load-scripts.php` and `load-styles.php` are PHP routes that concatenate files. They end
with `exit` and answer 500 on the current request fragment, so a page that links them loses jQuery
and its stylesheets.

## Request Headers

Drupal receives the request's headers, not only its cookie. `Authorization`, `X-Api-Key`, `Origin`,
`User-Agent` and any other header an API reads reach `$request->headers` and `$_SERVER`. Before this
the render was handed the cookie, `Accept`, the content type and the client address and nothing
else, so every bearer-token route on a headless site answered as anonymous.

Three rules keep that safe. A request that carries `Authorization` is treated like one that carries
a session: it is rendered per caller and never read from or written to the stored page, the KV tier or
the edge cache. An `Authorization` that is this deployment's owner token is dropped before PHP sees
it. `cf-*`, `x-cfw-*` and the hop-by-hop headers are dropped too, and at most 64 headers and 16 KiB
are forwarded, whole or not at all. The previous request's headers are removed from `$_SERVER` before
the next is built, so a token never outlives the request that carried it.

## `ASSET_AGGREGATES`

Drupal's own `css.preprocess` and `js.preprocess` ship off, because the source CSS and JS files are not
in the interpreter's filesystem and its aggregate route answers a licence header alone. `bun run
assets:agg` reads the library definitions at build time, where the files do exist, and emits immutable
per-library aggregates plus a file-to-library index. With `ASSET_AGGREGATES=1`, a page's contiguous run
of tags for a library is replaced by that library's single aggregate tag as the page is stored.

The substitution is all or nothing per library: either every tag in the run is replaced or none is.
A partial replacement would store a page that references an aggregate for some of its CSS and not
the rest.

It is on `KV_OVERRIDABLE`, so turning it on needs no redeploy.

**The aggregates have to be published as well as built, or the lever cannot work at any setting.**
`assets/.assetsignore` denies by default, so it must carry `!/agg/`. Without that the substitution
rewrites every asset tag to a URL the asset layer does not publish, the Worker answers it as a Drupal
path, and the page renders with no CSS. That is the same failure the all-or-nothing rule above exists
to prevent, arriving from the other side.
`tests/unit/runtime/assets-ignore.spec.ts` resolves every URL the substitution emits, so a page whose
stylesheets 404 fails the test suite.

Turning it on without running `assets:agg` changes nothing rather than breaking a page: an absent
manifest means no library matches.

What it buys is render time and stored bytes, not Worker requests. An individual core stylesheet,
such as `/core/themes/olivero/css/base/base.css`, is answered by the asset layer without running the
Worker, so the individual files already cost no Worker request.
