/** the OAuth client id, in `cfw_meta` not KV (an operator-writable id is a phishing surface) */
export const CF_OAUTH_CLIENT_ID_KEY = 'cf_oauth_client_id';
/** the Cloudflare OAuth login in flight */
export const CF_OAUTH_PENDING_KEY = 'cf_oauth_pending';
/** the Cloudflare OAuth token */
export const CF_OAUTH_TOKEN_KEY = 'cf_oauth_token';
/** the Cloudflare account the OAuth token belongs to */
export const CF_OAUTH_ACCOUNT_KEY = 'cf_oauth_account';
/** the zone mail is sent from */
export const MAIL_ZONE_KEY = 'mail_sending_zone';

/** the onboarded sending domain, compared against a message's From; empty when none */
export const MAIL_SENDING_DOMAIN_KEY = 'mail_sending_domain';
/** the site's own `smtp.settings`, mapped to transport vars; the alarm reads it, see `mailEnv()` */
export const SITE_SMTP_KEY = 'site_smtp_settings';
/** Tier B's OIDC provider issuer */
export const OIDC_ISSUER_KEY = 'oidc_issuer';
/** Tier B's OIDC client id */
export const OIDC_CLIENT_ID_KEY = 'oidc_client_id';
/** the OIDC login in flight */
export const OIDC_PENDING_KEY = 'oidc_pending';
/** the single-use OIDC claims ticket */
export const OIDC_TICKET_KEY = 'oidc_ticket';

/** the key holding which site this object is; see {@link SitePhpDurableObject.siteName} */
export const SITE_NAME_KEY = 'site_name';

/** set once this site is listed in the deployment document */
export const DEPLOYMENT_RECORDED_KEY = 'deployment_recorded';

/** where a site records how far it has reconciled with the pack that ships today */
export const RECONCILE_KEY = 'reconcile_state';

/** the pack generation of the heap image; see {@link SitePhpDurableObject.snapshotStep} */
export const HEAP_IMAGE_KEY = 'heap_image_gen';

/** the stepped operation the alarm is carrying, as JSON */
export const OPS_JOB_KEY = 'ops_job';

/** the tag set an invocation has invalidated and not yet purged; see {@link notePendingTags} */
export const PENDING_TAGS_KEY = 'pending_tags';

/** when the declared outbound warm last queued anything; see {@link queueDeclaredFetches} */
export const DECLARED_WARMED_KEY = 'declared_warmed';

/** paths a render proved cannot be stored; see {@link SitePhpDurableObject.noteStorable} */
export const UNSTORABLE_KEY = 'unstorable_paths';
/** how many times the heap image producer has tried the current generation */
export const HEAP_IMAGE_ATTEMPTS_KEY = 'heap_image_attempts';
/** the discovered cron hooks and the module set they were discovered against */
export const CRON_HOOKS_KEY = 'cron_hooks';
/** the contention history autoscaling decides from; see `src/ops/replica-demand.ts` */
export const DEMAND_WINDOWS_KEY = 'demand_windows';
/** the high-water mark of lane numbers copied so far */
export const LANES_PROVISIONED_KEY = 'lanes_provisioned';
/** bumped whenever the pool changes; see `LANES_EPOCH_HEADER` */
export const LANES_EPOCH_KEY = 'lanes_epoch';

/** the render count the thermal predictor reads after a hibernation; `<startedAt>:<renders>` */
export const RENDER_WINDOW_KEY = 'render_window';
/** the lane a provisioning step is currently copying */
export const LANE_IN_FLIGHT_KEY = 'lane_in_flight';
/** where the autoscaler resumes its walk over the lanes */
export const LANE_CURSOR_KEY = 'lane_cursor';
/**
 * Lane numbers that withdrew and are asking to be copied again, comma separated.
 *
 * `lanes_provisioned` is a high-water mark, so a withdrawn lane is unreachable from the primary
 * without this queue. A lane enqueues itself; nothing polls (a poll is a DO request per lane).
 */
export const LANE_REPAIR_KEY = 'lane_repair';
/** how many times this lane asked to be readmitted (backoff counter and waiting flag) */
export const READMIT_ASKS_KEY = 'readmit_asks';

/** the authoritative commit sequence a replica fences on; see `advanceCommit()` */
export const COMMIT_SEQ_KEY = 'commit_seq';

/** the generation a restore in progress is copying; empty when none is */
export const RESTORE_GENERATION_KEY = 'restore_generation';

/** the tables a restore in progress promised, and the ones it has delivered */
export const RESTORE_EXPECT_KEY = 'restore_expect';
/** the tables a restore in progress has delivered */
export const RESTORE_SEEN_KEY = 'restore_seen';
