import type { SiteEnv as BaseSiteEnv } from '@drupflare/durabledb/do-sqlite';
import type { SendEmailLike } from './ops/mail.js';

/**
 * The worker's environment: `@drupflare/durabledb`'s generic shape plus the vars only this
 * application reads.
 *
 * These four stay here rather than in the package because nothing else could act on them -- heap
 * restore, the R2 mirror drain and prefill are all worker concerns.
 */
export interface SiteEnv extends BaseSiteEnv {
	/**
	 * Which uploaded Worker version is serving, supplied by the platform.
	 *
	 * `wrangler.jsonc` has declared `version_metadata` since the binding existed and NOTHING read
	 * it, so "which code is answering for this site" had no answer at all -- a deploy that half
	 * landed, or a site pinned to an older version by a gradual rollout, looked identical to a
	 * current one. It rides `/health` because that is the route an operator already polls.
	 *
	 * Absent under `wrangler dev --local` and in the test lanes, so every reader treats it as
	 * optional rather than asserting it.
	 */
	CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
	HEAP_SNAPSHOT?: string;
	HEAP_RESTORE_CHUNKS?: string | number;
	MIRROR_LIMIT?: string | number;
	/**
	 * linear memory above which the interpreter is dropped at the end of an invocation.
	 *
	 * Defaults to 117,440,512 (112 MiB) against a 128 MiB isolate. Raising it past ~120 MiB trades
	 * the boot this avoids for the reset it exists to prevent.
	 */
	RECYCLE_ABOVE_BYTES?: string | number;
	/**
	 * the WHOLE isolate's drop threshold, wasm linear memory plus the JS-side mount bytes.
	 *
	 * `RECYCLE_ABOVE_BYTES` reads linear memory alone, and the 128 MiB ceiling covers both -- so at
	 * its default plus the pack blob and MEMFS the object is already past the limit when it fires.
	 */
	ISOLATE_ABOVE_BYTES?: string | number;
	PREFILL?: string;
	/** fragment assembly for authenticated GETs; ON unless explicitly set to `0` */
	SHELL_ASSEMBLY?: string;
	/** the front worker's compiled-plan tier; ON unless explicitly set to `0` */
	EDGE_PLAN?: string;
	/**
	 * which engine produces image derivatives: `tinyimg` (default) or `images`.
	 *
	 * Cloudflare Images needs a zone with transformations enabled, does not exist on
	 * `*.workers.dev`, and caps at 5,000 transformations a month -- 1,250 images against the four
	 * shipped styles. It is kept reachable because it is the only one of the two that encodes AVIF.
	 */
	IMAGE_ENGINE?: string;
	/**
	 * the origin public files are served from, when the `FILES` bucket has a custom domain.
	 *
	 * Empty by default, which serves every file through the Worker -- correct, and one Worker
	 * request per file. Set to an R2 custom domain and a MIRRORED public file is linked there
	 * instead, which costs no Worker request at all. A file that has not mirrored yet keeps the
	 * Worker URL, because the alternative is a 404 on a file the site holds.
	 */
	FILES_PUBLIC_URL?: string;
	/**
	 * replace a stored page's asset tags with the build's aggregates; OFF unless `1`.
	 *
	 * Needs `bun run assets:agg` to have run, which writes `assets/agg/`. Off by default because the
	 * artifact is 6.57 MB for 808 libraries and a given site uses a few dozen -- shipping the rest
	 * would be paying for aggregates nothing reads.
	 */
	ASSET_AGGREGATES?: string;
	/**
	 * where release history is fetched from, when a site does not use drupal.org.
	 *
	 * Only the declared prefetch reads it; Drupal reads its own `update.settings:fetch.url`. Set
	 * both or neither -- a warm against one server and a fetch against another warms nothing.
	 */
	UPDATE_FETCH_URL?: string;
	/**
	 * extra path prefixes that may never be answered from a PREVIOUS generation, comma separated.
	 *
	 * Added to the built-in deny-list rather than replacing it, so a site cannot make its own login
	 * page staleable by configuring badly. See `staleAllowed()` in `src/ops/page-store.ts`.
	 */
	NEVER_STALE?: string;
	/** how long a superseded page may still be answered, in ms; see `agedServeMaxMs()` */
	AGED_SERVE_MAX_MS?: string;
	/**
	 * makes this object a read-only replica: every mutating host capability is refused.
	 *
	 * OFF unless explicitly `1`, and it must stay that way -- an object that answers writes is a
	 * primary, and a primary that silently refuses them is a broken site. See `src/ops/replica.ts`.
	 */
	REPLICA_READ_ONLY?: string;
	/**
	 * how many replica lanes a site has beyond the primary; 0 and unset mean one object per site.
	 *
	 * The var only tells the ROUTER how many lanes exist. An object's own role comes from its name,
	 * so raising this cannot make an existing object read-only by accident.
	 */
	REPLICA_COUNT?: string;
	/**
	 * whether the Zend park may arm; on unless set to something other than `1`.
	 *
	 * Arming routes every render through `cfw_park_run`, including the ones that call nothing, so a
	 * site running no module that needs a blocking outbound call pays a wrapper for no yield.
	 */
	PARK?: string;
	/**
	 * how long a SERVING lane may go without pulling the primary's log; the bound on staleness.
	 *
	 * A lane that stops replicating answers from a frozen copy and looks healthy, because the fence
	 * refuses only a caller that states a freshness requirement and a visitor states none.
	 */
	REPLICA_LAG_MS?: string;
	/**
	 * lets a pool lane execute writes and forward them to the primary instead of refusing them.
	 *
	 * OFF unless explicitly `1`. The read path's safety argument covers reads; a lane that forwards
	 * is doing something that argument does not reach.
	 */
	WRITE_FORWARD?: string;
	/**
	 * takes a heap image once per pack generation, so a cold boot can restore instead of booting.
	 *
	 * **OFF unless `1`, and it used to be on.** `HEAP_SNAPSHOT` gates the restore; this gates the
	 * PRODUCER. Measured on two deployed free workers differing only in these two vars, `cpuTime` on
	 * the cold render, no state polling between samples: **imaged 2020/1908/1937/1561/1912 (n=5,
	 * median 1,912) against unimaged 1277/1343/1113/1251 (n=4, median 1,264)**. The ranges do not
	 * overlap, so restoring an image costs about 648 ms MORE than booting from scratch. It also
	 * costs 8,071,929 bytes a site against an account-wide 5 GB cap.
	 *
	 * A cost on both meters and no benefit on either, so the default is off. The likely mechanism is
	 * `digestBytes`, a per-byte JS loop over the restored bytes, which is why compressing the stored
	 * chunks does not help: the digest is taken over heap bytes rather than stored ones.
	 */
	HEAP_IMAGE?: string;
	/**
	 * brings an already-provisioned site up to the pack that ships today.
	 *
	 * ON unless `0`. The pack delivers only at provisioning, so without this a fix inside it reaches
	 * new sites and no existing one. Off is for a site being debugged against a known state; leaving
	 * it off means a security fix in the pack never arrives.
	 */
	RECONCILE?: string;
	/**
	 * the object's own namespace, so a replica lane can pull the log from its primary.
	 *
	 * Optional here and required in `SiteWorkerEnv`: the front end cannot work without it, and a
	 * Durable Object only needs it to reach a SIBLING -- which nothing did until catch-up.
	 */
	SITE?: DurableObjectNamespace;
	/** the opcache arm: `file` (shipping), `shm` or `off`; see `src/runtime/opcache.ts` */
	OPCACHE_MODE?: string;
	/** argon2id password hashing; OFF unless explicitly `1`, because it rehashes every login */
	ARGON2?: string;
	DRUPAL_CRON?: string;
	CRON_MAX_UNITS?: string | number;
	CRON_MAX_ROWS?: string | number;
	CRON_MAX_MS?: string | number;
	/**
	 * the `scheme://host[:port]` Drupal renders absolute URLs against.
	 *
	 * Optional. Unset, the object pins the first non-local origin it serves and uses that; see
	 * `src/ops/site-origin.ts`. Set it when a site is reached through a host it cannot observe --
	 * behind a proxy that rewrites `Host`, or on a deploy whose first request is a health check.
	 */
	SITE_ORIGIN?: string;
	/**
	 * where a site's Durable Object is created: one of `wnam enam sam weur eeur apac oc afr me`.
	 *
	 * Unset by default, which lets placement follow the first request. **KV-overridable** through the
	 * `settings` key, so an owner who learns where their audience is can act on it without a
	 * redeploy. Applies at CREATION only; Cloudflare ignores it for an object that already exists.
	 */
	SITE_LOCATION_HINT?: string;
	/**
	 * the largest non-file request body the edge will forward, in bytes.
	 *
	 * Defaults to 2 MiB. `0` disables the guard. `multipart/form-data` is exempt, so raising it is
	 * only about non-upload submissions.
	 */
	MAX_BODY_BYTES?: string | number;
	/**
	 * how much of PHP's log is mirrored to `console.log`, by RFC 5424 name.
	 *
	 * `off | error | warn | log | info | debug`. Defaults to `info`, so `debug` -- which on 8.5 is
	 * mostly deprecation notices with full stack traces, several per render -- stays out of
	 * `wrangler tail` and out of a dev terminal unless it is asked for.
	 */
	PHP_LOG_LEVEL?: string;
	/**
	 * refuses an outbound fetch to a private, loopback or metadata address; ON unless `0`.
	 *
	 * PHP names the URL for `cfwFetch` and `cfwQueueFetch`, so any module that can build a string
	 * chooses the destination. `0` is for the e2e rig, which points a site at containers on the host.
	 */
	OUTBOUND_GUARD?: string;
	/** logs every Drupal statement through console.log, which survives an object reset */
	PW_SQL_TRACE?: string;
	/** first statement number to log, so a 256 KB tail budget covers the END of a long run */
	PW_SQL_TRACE_FROM?: string | number;

	/**
	 * a `send_email` binding, which is the only Cloudflare send that needs no credential.
	 *
	 * It reaches VERIFIED DESTINATION ADDRESSES ONLY -- 200 per account -- so it covers "mail the
	 * site owner" and cannot cover "mail a visitor who just registered". Free on every plan, where
	 * the REST API below is Workers Paid. See `src/ops/mail.ts`.
	 */
	SEND_EMAIL?: SendEmailLike;

	/** `auto | binding | api | smtp | off`; `auto` takes the first transport that is configured */
	MAIL_TRANSPORT?: string;
	/** the From address for a message that carries none; Drupal's own site mail wins when it does */
	MAIL_FROM?: string;
	/** whether `alarm()` sends what `cfwMail` queued */
	MAIL_DRAIN_ON_ALARM?: string;
	/** messages one firing may send; capped at 25, because each is one of 50 subrequests */
	MAIL_DRAIN_LIMIT?: string | number;

	/** the account the Cloudflare Email Sending REST API posts under */
	CF_EMAIL_ACCOUNT_ID?: string;
	/** an API token with Email Sending: Edit; a secret, never a `vars` entry */
	CF_EMAIL_TOKEN?: string;

	/** submission host for the third-party lane; a Cloudflare relay is refused, see `src/ops/mail.ts` */
	SMTP_HOST?: string;
	/** 587 for STARTTLS, 465 for implicit TLS; 25 is blocked on Workers and is refused */
	SMTP_PORT?: string | number;
	/** `starttls | implicit | off` */
	SMTP_TLS?: string;
	SMTP_USER?: string;
	SMTP_PASS?: string;
	/** `PLAIN | LOGIN` */
	SMTP_AUTH?: string;

	/**
	 * The TCP tier's endpoints, one var per protocol; see `src/ops/tcp.ts`.
	 *
	 * A whole URL rather than a host/port/user/pass set, because these carry credentials and a
	 * secret is one binding: `redis://user:pass@host:6379/0` (or `rediss://` for TLS). The
	 * ENDPOINT is the operator's -- PHP names an operation and never a host, or any
	 * module able to call a host function could reach arbitrary TCP.
	 */
	REDIS_URL?: string;
	/** `syslog://collector:514` or `syslogs://collector:6514` for RFC 5425 TLS */
	SYSLOG_URL?: string;
	/** APP-NAME on every record this site ships; defaults to `drupal` */
	SYSLOG_APP_NAME?: string;

	/**
	 * The Workers AI binding, and the model allow-list; see `src/ops/ai.ts`.
	 *
	 * A binding rather than the REST API, because the binding carries its own authorisation while a
	 * REST call would need the account token readable from a queue row. Absent on any account that
	 * has not enabled Workers AI, which is why every reader treats it as optional.
	 */
	AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> } | null;
	/** comma-separated model ids; unset means the short default list */
	AI_MODELS?: string;

	/**
	 * The OIDC client secret, for a provider that issued one; see `src/ops/oidc.ts`.
	 *
	 * A secret rather than a `vars` entry, and it must never join `KV_OVERRIDABLE` -- neither may
	 * the issuer, which lives in `cfw_meta`: a KV writer who could set it would point the consent
	 * screen at a provider they control and every login would authenticate against it.
	 */
	OIDC_CLIENT_SECRET?: string;
}
