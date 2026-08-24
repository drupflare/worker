import type { SiteEnv as BaseSiteEnv } from '@drupflare/durabledb/do-sqlite';
import type { SendEmailLike } from './ops/mail';

/**
 * The worker's environment: `@drupflare/durabledb`'s generic shape plus the vars only this
 * application reads.
 *
 * These four stay here rather than in the package because nothing else could act on them -- heap
 * restore, the R2 mirror drain and prefill are all worker concerns.
 */
export interface SiteEnv extends BaseSiteEnv {
	HEAP_SNAPSHOT?: string;
	HEAP_RESTORE_CHUNKS?: string | number;
	MIRROR_LIMIT?: string | number;
	PREFILL?: string;
	/** P7 fragment assembly for authenticated GETs; OFF unless explicitly set to `1` */
	SHELL_ASSEMBLY?: string;
	/** P30's opcache arm: `file` (shipping), `shm` or `off`; see `src/runtime/opcache.ts` */
	OPCACHE_MODE?: string;
	/** P25 argon2id password hashing; OFF unless explicitly `1`, because it rehashes every login */
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
	 * ENDPOINT is deliberately the operator's -- PHP names an operation and never a host, or any
	 * module able to call a host function could reach arbitrary TCP.
	 */
	REDIS_URL?: string;
	/** `syslog://collector:514` or `syslogs://collector:6514` for RFC 5425 TLS */
	SYSLOG_URL?: string;
	/** APP-NAME on every record this site ships; defaults to `drupal` */
	SYSLOG_APP_NAME?: string;

	/**
	 * The OIDC client secret, for a provider that issued one; see `src/ops/oidc.ts`.
	 *
	 * A secret rather than a `vars` entry, and it must never join `KV_OVERRIDABLE` -- neither may
	 * the issuer, which lives in `cfw_meta`: a KV writer who could set it would point the consent
	 * screen at a provider they control and every login would authenticate against it.
	 */
	OIDC_CLIENT_SECRET?: string;
}
