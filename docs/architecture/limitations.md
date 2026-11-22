# Limitations

What does not run, what runs differently, and the platform limits behind each.

Measured properties of the runtime, listed so they are known before they are hit.

## Unavailable Features

- **Fibers are not available.** `new Fiber()` aborts the interpreter, because emscripten implements
  none of the context-switching calls it needs. The build rewrites core's five uses to a
  synchronous stand-in with the same surface.
- **`exit()` in a request is not handled generically.** The serve prints its JSON result after the
  kernel returns, and `pib_run` performs no request shutdown, so shutdown handlers never fire. A
  request that reaches `exit` ends the program before the JSON and answers 500 with "no JSON in the
  output", and an `exit` while an output buffer is open leaves the buffer open until the object
  recycles. Measured with SimpleSAMLphp's own redirect. SimpleSAMLphp works through a switch for its
  `exit`; other code that exits does not have one, and the generic handler is planned for v1.1.
- **Shell commands run only through a router.** `exec()`, `shell_exec()`, `proc_open()` and the rest
  serve a fixed set of programs with platform equivalents (`echo`, `date`, `file`, `zip`, `unzip`,
  `gzip`, `wget`, `curl`, checksums and a few more). Pipes, redirection and any other program fail
  with a recorded degradation and not a fatal. `sleep()` parks the call and is capped per request by
  [`SLEEP_BUDGET_MS`](../configuration/integrations/tcp.md#the-parked-tier).
- **The interpreter loads 27 extensions**: Core, PDO, Reflection, SPL, SimpleXML, Zend OPcache,
  cfwpark, ctype, date, dom, filter, hash, json, lexbor, libxml, mbstring, pcre, pib, random,
  session, standard, tokenizer, uri, vrzno, xml, yaml and zlib. OPcache is loaded and disabled by
  default; see [`OPCACHE_MODE`](../configuration/runtime.md#opcache_mode). `mbstring` is the native
  extension; `iconv` is a PHP polyfill. `gd` is not compiled in and a stand-in covers 40 of its
  functions; there is no `pdo_sqlite`. `/php` reports the live list.
- **`extension_loaded()` is true for a stand-in only when the stand-in covers the extension's whole
  API.** The check is gated by a manifest of the extension's functions, constants and classes, and
  the shim answers false for any name outside it. `sodium` answers true: the stand-in covers the
  whole of ext-sodium and a conformance gate holds it to native libsodium, except that password
  hashing refuses work above a 64 MiB memory cap (see [Modules](modules.md#verified)). `zstd` and
  `brotli` answer false because their streaming API is not shimmed. `gd` answers true for the 40 functions the
  WordPress, Joomla and Drupal image paths call, held to native gd by a differential; `imagecolorat()`, the drawing
  functions and text stay undefined.

## Behavior Differences

- **A parked call made inside a generator ends the request without output.** The park resumes a
  chain across invocations, but a network read made in a generator's body finishes with state
  `done` and nothing printed. Strata's `CommitLog::walk()` is one, so strata's cron stops silently
  at its dictionary stage and its compaction, scheduled drill and telemetry do not run. Measured
  2026-11-02. The fix is in the park extension in `phasm`.
- **Six more extensions are stand-ins the driver installs at boot**: curl, openssl, zip (including
  `ZipArchive`), exif, fileinfo (including `finfo`) and xmlwriter. Each is parity-tested against the
  real extension, and what a stand-in does not implement is refused at the call and recorded as a
  degradation, never answered wrongly. The openssl stand-in covers AES and x509.
- **`curl_*` works without `ext-curl`.** The functions are supplied over the same transport as the
  rest of outbound traffic, so an SDK that bundles its own curl transport runs unmodified.
  `curl_version()` reports `0.0.0-drupflare-shim`, and an option the shim does not understand is
  refused and not ignored. The options Stripe and elastica set are understood.
- **Passwords hash with bcrypt by default, and argon2id is available.** [`ARGON2=1`](../configuration/runtime.md#argon2)
  switches the password service to argon2id at m=19456 KiB, t=2, p=1, computed on the host and not
  in PHP. Existing bcrypt hashes keep working and are upgraded at each account's next login. Hashes
  are written in PHP's own encoded form, so they verify on any PHP with `ext-argon2`.
- **Image derivatives are produced in the Worker and not by `gd`.** The toolkit hands the work to
  `@gmitch215/tinyimg`, a wasm encoder that runs in the front worker and needs no zone, no binding
  and no monthly transform allowance. It covers scale, crop, rotate, desaturate and format
  conversion, and encodes JPEG, PNG and WebP. It does not encode AVIF: core asks the toolkit before
  applying an AVIF effect and falls through to the style's `webp` fallback. Cloudflare Images is
  reachable with [`IMAGE_ENGINE=images`](../configuration/serving/files-and-images.md#image_engine) on a zone that wants
  AVIF. Styles at or below 480 px on the long edge are produced during the request; larger ones are
  produced on the alarm chain. A public image style URL is rewritten to the `/cfw-img/` delivery path. A site can
  select Drupal's `GDToolkit` by hand, which builds each derivative at save time; see
  [Choosing GDToolkit](../configuration/serving/files-and-images.md#choosing-gdtoolkit).
- **Outbound HTTP completes inside the request that asks.** `Drupal::httpClient()` and a Symfony HTTP
  client park the PHP call while the Worker performs the fetch, and the same call resumes with the
  answer. Where a park is refused (a call made from inside an internal function such as
  `array_map`), the request falls back to the deferred transport: a previous fetch's response is
  returned and no connection is opened. A URL the site can predict from its own installed projects
  is warmed on the alarm before Drupal asks for it. A URL it cannot predict is queued, and an
  idempotent request that deferred is drained and rendered once more inside the same visit, so the
  answer usually arrives on the first request. Request headers are carried across the queue and are
  part of the cache key, except `User-Agent`, which is sent but not keyed. A non-idempotent request
  is never re-driven: a replayed POST is a different outcome.
- **A page that has been rendered before does not wait for a re-render.** After a content change, a
  request for a path with history is answered from the previous generation with
  `x-cfw-edge: STALE` while the current one regenerates on the alarm chain. It is bounded two
  generations and 24 hours deep, never applies to a session-carrying response, and refuses a
  deny-list that [`NEVER_STALE`](../configuration/serving/page-cache.md#never_stale) extends. The previous
  generation is kept in the KV page tier, which is on for both plans whenever `PAGE_KV` is bound
  ([`PAGE_KV_ENABLED`](../configuration/serving/page-cache.md#the-kv-page-tier)). A free site stops writing pages
  at its daily KV write budget.
- **Outbound TCP is either parked or declared, depending on which the module needs.**
  `Drupal\drupflare\Network\CfwTcp` describes a whole exchange and reads the answer on a later
  request over a queue, which suits syslog. A module that needs the answer inside the request that
  asked, which is what a cache read is, gets it from the park: the PHP call is suspended mid-frame,
  the Worker performs the socket read, and the same call resumes with the result. `drupal/redis` is
  verified on that path. The endpoint and its credentials come from
  [`REDIS_URL` and `SYSLOG_URL`](../configuration/integrations/tcp.md#outbound-tcp) and not from the calling
  code, and administrative Redis commands are refused. The Durable Object's own SQLite is still the
  recommended cache backend, because a parked get is a network round trip where SQLite is a local
  read.
- **Config import and queue drains run in steps.** `POST /ops?op=cim&drive=1` and
  `op=queue-drain&drive=1` run the first step in the request and leave the rest to the alarm, one
  step per firing. [`docs/configuration/index.md`](../configuration/plan-and-routes.md#extensibility-routes) has the
  parameters.
- **Greek word-final sigma lowercases differently** from native PHP, and `mb_strwidth` under-counts
  emoji. Neither affects Drupal core.
- **An object reset for memory costs a form submission a retry by hand.** A GET or HEAD that meets a
  reset is sent once more to the fresh instance and answers normally with `x-cfw-retried: reset`. A
  POST is repeated only when the object never started it: it records an attempt id before the page
  runs, so a missing record means nothing was saved. A POST it had started gets a short "Try Again
  in a Moment" page with `Retry-After: 2` instead of Cloudflare's 1101, because it may already have
  saved.
- **A freshly deployed site is claimable until it is provisioned.** `/firstrun` answers without a
  credential while the site has never been configured, because the owner token that `/export` takes
  is minted by that route and nowhere else; gating it would mean the only way to get your data out
  was to expose `/sql`, `/restore` and `/php` first. The window is the unprovisioned state only:
  once configured the route answers 409, and reconfiguring needs the token. It is the same model as
  Drupal's own `install.php`, and the window is signposted: an unclaimed site answers a browser
  navigation with the claim page instead of its front page. Claim the site as the first thing you do
  after deploying.

## Platform Limits

- **Case-insensitive matching is ASCII-only.** Durable Object SQLite has no user-defined
  collations, so Drupal's `NOCASE_UTF8` becomes builtin `NOCASE`. `Ünicode` does not match
  `ünicode`. This affects username and email uniqueness and taxonomy matching.
- **`LIKE`/`GLOB` patterns cap at 50 bytes.** A Views "contains" filter on a longer search string
  fails in the engine.
- **A statement caps at 100 bound parameters.**
- **`REGEXP` is evaluated in PHP by the driver**, as are `MD5()` and `SUBSTRING_INDEX()` in a select
  list. The engine has none of them, so the driver widens the statement and filters the rows
  itself: Views regex filters work, and on a large table they cost a scan.
- **Integers above 2^53** are read back through a second, casting query. The cursor returns doubles,
  so the driver detects a value a double cannot hold and re-reads that statement with the affected
  columns cast to text.
- **A 64-bit integer does not survive a JSON round trip.** `PHP_INT_SIZE` is 8 and `PHP_INT_MAX` is
  9,223,372,036,854,775,807, but a JSON number is a double, so a value above 2^53 handed across the
  host boundary comes back rounded. Cast it to a string first. The database path already does this.
- **A module install leaves the object with little room to do anything else.** It is the most
  expensive thing a site can do, and a booted interpreter already holds most of the object's
  ~195 MiB memory budget. `memory.grow` has no inverse, so the heap never shrinks; a further growth
  is served at a smaller step and not refused. The install queues the pages it invalidated instead
  of re-rendering them, and the cache is cold for one visit.
- **A cold object rebuilds Drupal, and the heap image does not help.** An evicted Durable Object has
  no interpreter, so the next request that needs one pays a boot. [`HEAP_IMAGE`](../configuration/runtime.md#the-shared-boot-image)
  stores a heap so that boot can be replaced by a restore, and it is off by default: measured on two
  deployed workers, the restore costs more than the boot it replaces, and it consumes storage on
  every site as well. `1` opts in. What keeps a cold boot off the visitor's path is the page cache,
  the compiled plan, the stale-generation serve, and a [resident object](../configuration/runtime.md#warming)
  while a session is active.
- **Writes do not scale, and a replica pool does not change that.** A lane refuses an authoritative
  write and hands it back, so every write is still one object and one thread. What a pool scales is
  authenticated reads; see [Replica Lanes](../operating/replica-lanes.md) and [`REPLICA_COUNT`](../configuration/replicas.md#replica_count).

## WordPress Outbound Requests

- **WordPress requests leave through the host, with limits.** The host plugin answers `pre_http_request`
  through the same park as Drupal. It refuses non-HTTP schemes, URLs with credentials, loopback, private,
  link-local and metadata addresses, and any redirect to one, and the worker checks each hop again. A request
  is capped at 30 outbound requests on the free plan and 500 on paid, and a response at 5 MiB unless the caller
  sets `limit_response_size`. These three numbers are chosen, not measured.
- **`sslverify => false` is not honoured.** The request is made with certificate checks on and a degradation is recorded.
- **`curl_*` called directly from a WordPress plugin still answers errno 7.** Only the WordPress HTTP API is wired.
- **A DNS name that resolves to a private address is not checked.** PHP cannot resolve names here, so that case rests on
  Cloudflare's egress and is untested.
- **WordPress still reports no SSL support**, so it builds `http://` URLs. The plugin upgrades `wordpress.org` hosts to
  HTTPS and leaves other hosts as asked.

## WordPress Mail

- **`wp_mail()` returns true when the host accepted the message, not when it was delivered.** The host plugin answers
  `pre_wp_mail` through the same queue and transports Drupal uses (`send_email` binding, Email Sending API or SMTP).
  WordPress has no delivered state to report, so none is invented. With `MAIL_TRANSPORT=off`, or with no transport
  configured, `wp_mail()` returns false and fires `wp_mail_failed` with a `WP_Error` that carries the host's reason.
- **A message the host accepted and could not send is counted.** The count and the last error are stored, and show on
  the Site Health screen, the debug tab, `/wp-json/drupflare/v1/status` and `/serve-stats` (`mailFailed`).
- **A message is sent again only when the relay never took it.** A WordPress message asks for three attempts. The host
  repeats one after an API 429 or 503, or after an SMTP connection or login that failed before any data was sent, with
  waits of 1, 5, 15 and 60 minutes. Any other failure ends the message, because a repeat after a lost reply sends a
  one-time link twice.
- **Attachments are capped at 700,000 bytes in total.** The queued row holds them as base64 inside the 1,000,000-byte
  message limit, which comes from the Durable Object record size.
- **Inline images (`$embeds`) are refused.** The host takes attachments only, and sending without the image would report
  success for a different message.
- **Only `In-Reply-To` and `References` pass through as custom headers.** Any other header a caller sets is dropped and a
  degradation is recorded. A caller-built multipart body is sent as the text it holds.

## WordPress Object Cache

- **No persistent object cache is installed, and no `object-cache.php` or `advanced-cache.php` drop-in ships.** WordPress
  keeps its default cache, which lasts one request. A front-page render counted in a local run (three renders, one
  object, measured with `SAVEQUERIES` and the object cache's own counters) issued 17 queries on the first and 13 on the
  next two, with 127 cache hits and 31 misses. The misses fill options, posts, post meta, terms, term relationships,
  themes and translation files.
- **Why not.** A persistent store could answer at most those 13 queries. A hit kept in the object's SQLite is still a row
  read, so only host memory saves rows, and it adds a host call per lookup. The cost the earlier deployed readings put on
  a render is the PHP load (487 files, 10.4 MB), which an object cache does not touch. A persistent copy would also go
  stale when a plugin writes with SQL and skips `wp_cache_delete()`, and every fill would write rows on a budget where
  writes bind. Rows and CPU saved were not measured on a deployed object, so this is a judgement from the query count,
  not a measured saving; it reopens if a deployed reading shows the queries matter.
- **Page caching** is separate and covered by the page store, which already answers an anonymous page without starting
  WordPress, so `advanced-cache.php` would remove no work the page store does not.
- **Site Health reports the cache as one request long**, with no recommendation to install a drop-in.

## WordPress Cron

- **The platform drives `wp-cron.php`, and visitors do not.** `DISABLE_WP_CRON` stays on. The alarm requests
  `wp-cron.php` on the one-shot path, at most once per `CRON_INTERVAL_MS`, and WordPress's own `doing_cron` lock
  keeps two runs from working the same events. Two triggers arriving together ran a due event once in a local test
  (one version check reached the stand-in origin). Ten page renders moved the alarm firing count by no more than two.
- **One firing that has due events wrote 112 rows in a local run, and a firing with nothing due wrote 2** (n=3,
  counted by the object's SQL wrapper). CPU per firing is not measured; it needs a deployed reading.
- **Two stand-ins remain, on purpose.** `CURL_VERSION_SSL` is defined by the request fragment because the curl stand-in
  reports no features and declares no constants, and it is shared with Drupal, whose behaviour stays fixed.
  `wp-cron.php` ends in a bare `die()` in three places and a die leaves nothing to read, so the fragment turns each
  into a stop; a node spec fails if a release changes the count.
- **Action Scheduler stores, claims, runs and recovers actions.** Release 4.2.0 stores an action with an `INSERT ...
SELECT ... FROM DUAL` and reads `insert_id` back, and claims with `UPDATE ... t1 JOIN (SELECT ... FOR UPDATE) t2 ...
SET claim_id`. The translator refused the claim by name (`update-multi-table`), could not find a table named `DUAL`,
  and reported no insert id for an `INSERT ... SELECT`; all three are fixed. A recording of the plugin's statements over
  its own table definitions answers the same as MySQL 26.7 on every row and every table: three actions claimed by a
  `LIMIT 3` out of five due, a second claim taking the rest, a third taking none, stale claims found and cleared one by
  one, and a unique action blocked by a pending twin. The plugin itself is not in the pack, so the statements are
  copied from release 4.2.0 and the test says so.
- **Action Scheduler leaves three differences.** A claim that sorts on a key that leaves ties, which only a site filter
  on the claim order can produce, keeps whichever rows SQLite reads first; the plugin's own order ends in the action id.
  `SKIP LOCKED` is dropped because the object has one connection and no open transaction, and the plugin only sends it
  when the server version reads 8.0.1 or later, which this one reports as 8.0.0. Searching actions by a partial JSON
  match sends `JSON_EXTRACT`, which the translator still refuses (`function-unknown`).
