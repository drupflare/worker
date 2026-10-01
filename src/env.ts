import type { SiteEnv as BaseSiteEnv } from '@drupflare/durabledb/do-sqlite';
import type { SendEmailLike } from './ops/mail';

/**
 * The worker's environment: `@drupflare/durabledb`'s generic shape plus the vars only this
 * application reads (heap restore, the R2 mirror drain and prefill).
 */
export interface SiteEnv extends BaseSiteEnv {
	/** the serving Worker version, reported on `/health`; absent under `wrangler dev --local` */
	CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
	/** the lanes an upload's image styles are rendered on; see `src/ops/render-lane.ts` */
	RENDER_LANES?: DurableObjectNamespace;
	/** `0` stops rendering styles on upload while the binding stays */
	EAGER_DERIVATIVES?: string;
	HEAP_SNAPSHOT?: string;
	HEAP_RESTORE_CHUNKS?: string | number;
	MIRROR_LIMIT?: string | number;
	/**
	 * Linear memory above which the interpreter is dropped at the end of an invocation.
	 * Defaults to 112 MiB; past ~120 MiB it trades the boot it avoids for the reset it prevents.
	 */
	RECYCLE_ABOVE_BYTES?: string | number;
	/** ms a fresh interpreter runs no background PHP (fill, cron); default 60,000, 0 is off */
	FILL_SETTLE_MS?: string | number;
	/**
	 * Whole-isolate drop threshold: linear memory plus the JS-side mount bytes.
	 * `RECYCLE_ABOVE_BYTES` reads linear memory alone, but the 128 MiB ceiling covers both.
	 */
	ISOLATE_ABOVE_BYTES?: string | number;
	PREFILL?: string;
	/** fragment assembly for authenticated GETs; on unless `0` */
	SHELL_ASSEMBLY?: string;
	/** the front worker's compiled-plan tier; on unless `0` */
	EDGE_PLAN?: string;
	/**
	 * Image derivative engine: `tinyimg` (default) or `images`.
	 * `images` needs a zone with transformations and caps at 5,000 a month; only it encodes `avif`.
	 */
	IMAGE_ENGINE?: string;
	/**
	 * The origin public files are served from, when `FILES` has a custom domain.
	 * Empty serves through the Worker; a file not yet mirrored keeps the Worker URL.
	 */
	FILES_PUBLIC_URL?: string;
	/**
	 * Replaces a stored page's asset tags with the build's aggregates; off unless `1`.
	 * Needs `bun run assets:agg` (writes `assets/agg/`, 6.57 MB for 808 libraries).
	 */
	ASSET_AGGREGATES?: string;
	/**
	 * Where release history is fetched from when a site does not use drupal.org.
	 * Only the prefetch reads it; set it together with `update.settings:fetch.url`.
	 */
	UPDATE_FETCH_URL?: string;
	/**
	 * Comma-separated path prefixes never answered from a previous generation.
	 * Added to the built-in deny-list, not replacing it; see `staleAllowed()`.
	 */
	NEVER_STALE?: string;
	/** how long a superseded page may still be answered, in ms; see `agedServeMaxMs()` */
	AGED_SERVE_MAX_MS?: string;
	/**
	 * Makes this object a read-only replica: every mutating host capability is refused.
	 * Off unless `1`; a primary that silently refuses writes is a broken site.
	 */
	REPLICA_READ_ONLY?: string;
	/**
	 * Replica lanes a site has beyond the primary; 0 or unset means one object per site.
	 * Only the router reads it; an object's own role comes from its name.
	 */
	REPLICA_COUNT?: string;
	/**
	 * Whether the Zend park may arm; on unless set to something other than `1`.
	 * Arming routes every render through `cfw_park_run`, even when nothing yields.
	 */
	PARK?: string;
	/**
	 * How long a serving lane may go without pulling the primary's log; the staleness bound.
	 * A stalled lane looks healthy: the fence refuses only callers that state a freshness need.
	 */
	REPLICA_LAG_MS?: string;
	/**
	 * Lets a pool lane execute writes and forward them to the primary instead of refusing them.
	 * Off unless `1`; the read path's safety argument does not cover forwarding.
	 */
	WRITE_FORWARD?: string;
	/**
	 * Takes a heap image per pack generation so a cold boot can restore; off unless `1`.
	 * A restore cost ~648 ms more cpuTime than a boot (1,912 vs 1,264 ms median, deployed free).
	 */
	HEAP_IMAGE?: string;
	/** response header rules for the front worker, as a JSON string or array; see `edge-rules` */
	RESPONSE_HEADERS?: string | unknown[];
	/** redirect rules for the front worker, in the same two forms */
	REDIRECTS?: string | unknown[];
	/**
	 * Brings an already-provisioned site up to the pack that ships today; on unless `0`.
	 * The pack delivers only at provisioning, so off means pack fixes never arrive.
	 */
	RECONCILE?: string;
	/** `1` logs memory readings at each boot and invocation end; for diagnosing a reset */
	MEMORY_TRACE?: string;
	/** see `sleepBudgetMs()` */
	SLEEP_BUDGET_MS?: string;
	/** the object's own namespace, so a replica lane can reach its primary to pull the log */
	SITE?: DurableObjectNamespace;
	/** the opcache arm: `file` (shipping), `shm` or `off`; see `src/runtime/opcache.ts` */
	OPCACHE_MODE?: string;
	/** argon2id password hashing; off unless `1`, because it rehashes every login */
	ARGON2?: string;
	DRUPAL_CRON?: string;
	CRON_MAX_UNITS?: string | number;
	CRON_MAX_ROWS?: string | number;
	CRON_MAX_MS?: string | number;
	/**
	 * The `scheme://host[:port]` Drupal renders absolute URLs against.
	 * Unset, the object pins the first non-local origin; set it behind a proxy rewriting `Host`.
	 */
	SITE_ORIGIN?: string;
	/**
	 * Where a site's Durable Object is created: one of `wnam enam sam weur eeur apac oc afr me`.
	 * KV-overridable through `settings`; applies at creation only.
	 */
	SITE_LOCATION_HINT?: string;
	/** largest non-file request body the edge forwards, in bytes; default 2 MiB, `0` disables */
	MAX_BODY_BYTES?: string | number;
	/**
	 * PHP log level mirrored to `console.log`: `off | error | warn | log | info | debug`.
	 * Defaults to `info`; on 8.5 `debug` is mostly deprecation notices with stack traces.
	 */
	PHP_LOG_LEVEL?: string;
	/**
	 * Refuses an outbound fetch to a private, loopback or metadata address; on unless `0`.
	 * PHP names the URL, so any module chooses the destination; `0` is for the e2e rig.
	 */
	OUTBOUND_GUARD?: string;
	/** logs every Drupal statement through console.log, which survives an object reset */
	PW_SQL_TRACE?: string;
	/** first statement number to log, so a 256 KB tail budget covers the end of a long run */
	PW_SQL_TRACE_FROM?: string | number;

	/**
	 * A `send_email` binding, the only Cloudflare send that needs no credential.
	 * It reaches verified destination addresses only (200 per account), so it cannot mail visitors.
	 */
	SEND_EMAIL?: SendEmailLike;

	/** `auto | binding | api | smtp | off`; `auto` takes the first configured transport */
	MAIL_TRANSPORT?: string;
	/** the From address for a message that carries none; Drupal's site mail wins when set */
	MAIL_FROM?: string;
	/** whether `alarm()` sends what `cfwMail` queued */
	MAIL_DRAIN_ON_ALARM?: string;
	/** messages one firing may send; capped at 25, because each is one of 50 subrequests */
	MAIL_DRAIN_LIMIT?: string | number;

	/** the account the Cloudflare Email Sending HTTP API posts under */
	CF_EMAIL_ACCOUNT_ID?: string;
	/** an API token with Email Sending: Edit; a secret, never a `vars` entry */
	CF_EMAIL_TOKEN?: string;

	/** submission host for the third-party lane; a Cloudflare relay is refused */
	SMTP_HOST?: string;
	/** 587 for starttls, 465 for implicit TLS; 25 is blocked on Workers and is refused */
	SMTP_PORT?: string | number;
	/** `starttls | implicit | off` */
	SMTP_TLS?: string;
	SMTP_USER?: string;
	SMTP_PASS?: string;
	/** `PLAIN | LOGIN` */
	SMTP_AUTH?: string;

	/**
	 * The Redis endpoint as one URL, `redis://user:pass@host:6379/0` (`rediss://` for TLS).
	 * The endpoint is the operator's; PHP names an operation and never a host.
	 */
	REDIS_URL?: string;
	/** `syslog://collector:514` or `syslogs://collector:6514` for RFC 5425 TLS */
	SYSLOG_URL?: string;
	/** the app name on every record this site ships; defaults to `drupal` */
	SYSLOG_APP_NAME?: string;

	/**
	 * The Workers AI binding; absent on accounts without it, so readers treat it as optional.
	 * A binding, not the HTTP API, which would need the account token readable from a queue row.
	 */
	AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
	/** comma-separated model ids; unset means the short default list */
	AI_MODELS?: string;

	/**
	 * The OIDC client secret. Never add it or the issuer (in `cfw_meta`) to `KV_OVERRIDABLE`:
	 * a KV writer could point logins at their own provider.
	 */
	OIDC_CLIENT_SECRET?: string;
}
