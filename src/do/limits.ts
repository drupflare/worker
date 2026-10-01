/**
 * The `x-cfw-*` header contract version, bumped when a header is renamed or removed (not added).
 *
 * 2: `x-cfw-plan` now means the edge plan alone; the object's account plan moved to
 * `x-cfw-account-plan`.
 */
export const CFW_HEADER_VERSION = '2';

/** samples of render size kept per path, for {@link SitePhpDurableObject.medianRenderBytes} */
export const RENDER_BYTES_SAMPLES = 8;
/** minimum samples before a median counts (a median of one is that sample) */
export const RENDER_BYTES_MIN_SAMPLES = 3;
/** paths whose render-size history is kept */
export const RENDER_BYTES_PATHS = 200;

/**
 * How many paths may wait for a fill.
 * Unbounded, an anonymous visitor asking for `/a1`, `/a2`, ... grew the table forever; past the
 * cap a miss is still answered but not promised a fill.
 */
export const FILL_QUEUE_MAX = 500;

/**
 * Which existing driver can run each sliced operation, named in the refusal so a 501 is not
 * retried; an operation with no entry has no sliced driver.
 */
export const OPS_DRIVERS: Record<string, string> = {
	cr: 'the 11 UPDB_FLUSH_STEPS units, driven by the updb alarm chain (/updb)',
	updb: '/updb -- already sliced at 28 units / 56 beats for a 1-update release',
	en: 'Cloudflare Workflows, 25,000 separately-budgeted steps (1,344.7 ms native, 78.5 MB peak)',
	pmu: 'the same Workflow path as `en`; 666-945 ms per module measured natively',
	'sql-dump': '/export, which streams the database as replayable SQL',
	cex: '/ops?op=cex&offset=N -- paged at 25 config objects, driven by the caller',
	cim: 'POST /ops?op=cim with a JSON body of at most 25 config objects'
};

/** how many gated requests the timing ring keeps (a pool sizer needs a recent window) */
export const LANE_TIMING_RING = 64;

/** how many absorbed faults `/serve-stats` keeps; the oldest drops first */
export const RECENT_ERRORS_MAX = 20;

/** how much of a fault's stack is kept, since the ring rides in every stats reply */
export const RECENT_ERROR_STACK_CHARS = 1_500;

/**
 * The largest outbound response body the queue holds, in bytes (2 MiB, like `MAX_BODY_BYTES`).
 *
 * The body is buffered whole on the JS heap, which shares the isolate's 128 MiB with wasm memory;
 * a serving object is already at 87.0% of it and an authenticated one at 96.8% (deployed), so a
 * few concurrent unbounded bodies reset the isolate inside one invocation.
 */
export const MAX_OUTBOUND_BODY_BYTES = 2 * 1024 * 1024;

/** the send attempts `/capability` reports (a recent window) */
export const MAX_MAIL_ATTEMPTS = 50;

/**
 * A statement that mutates Drupal's `cachetags` table: the automatic-invalidation seam.
 *
 * `invalidateTags()` writes only here, so watching `execSql()` for the mutating half signals a
 * content change with no Drupal-side hook. A `SELECT` must not match (read on every request).
 */
export const CACHETAG_WRITE =
	/^\s*(?:INSERT|UPDATE|REPLACE|DELETE|TRUNCATE)\b[\s\S]{0,400}?\bcachetags\b/i;

/**
 * How long after a module install the fill chain may start; the default +1 ms alarm would fire
 * into a still-writing object. 1 s clears the longest install measured (6,810 ms of CPU).
 */
const INSTALL_FILL_DELAY_MS = 1000;

/**
 * Served requests to accumulate before one row pays for all of them.
 * An eviction loses what is pending; 50 bounds that loss at 49 and cuts the write rate 50x.
 */
export const SERVE_REQUESTS_FLUSH = 50;

/**
 * How often a lane below `SERVING` pulls the primary's log.
 * Two Durable Object requests per round on the primary, so this is a cost knob, not latency.
 */
export const CATCH_UP_INTERVAL_MS = 2_000;

/**
 * Statements one replication record may carry before it is marked overflowed; a replica meeting
 * an overflowed record must restore instead of catching up.
 */
export const REPLICATION_RECORD_MAX_STATEMENTS = 500;

/** the bins `fillOne()` passes to `renderPage()` by default (reassembles from warm bins) */
export const FILL_BINS = ['page'];
/** minimum gap, in ms, between catch-ups a lane starts for a session it has not replicated yet */
export const SESSION_CATCHUP_MS = 1_000;
