/**
 * Which side of the CMS boundary every module and every object route is on.
 *
 * - `host`: knows nothing about Drupal; a second CMS would reuse it as it is.
 * - `cms`: knows only Drupal; a second CMS would replace it wholesale.
 * - `mixed`: host machinery that also knows Drupal's tables, cookies, packages or PHP, and would
 *   have to be split before a second CMS could use it.
 *
 * Classified by reading each module's CODE, not its comments: a docblock that explains a Drupal
 * behaviour does not make a module Drupal-specific. `bun run check:reachability` reports it, and
 * `tests/node/reachability.spec.ts` fails when a `host` module imports a `cms` one, when a module
 * has no entry, and when an entry names a module that no longer exists. Probes are frozen
 * instruments and are not classified.
 */
export type Side = 'host' | 'cms' | 'mixed';

/** every module under this prefix is `cms`: the PHP fragments and the shims Drupal needs */
export const CMS_PREFIX = 'src/drupal/';

export const MODULE_SIDES: Readonly<Record<string, Side>> = {
	'src/db/backend.ts': 'host',
	// knows which tables are Drupal's disposable caches (cachetags, cache_*)
	'src/db/export-sql.ts': 'mixed',
	'src/db/file-store.ts': 'host',
	'src/db/heap-store.ts': 'host',
	'src/db/import-sql.ts': 'host',
	'src/db/migrate-sql.ts': 'host',
	'src/db/pg-exec.ts': 'host',
	'src/db/wide-integers.ts': 'host',
	// reads the router table's statement count
	'src/db/write-tally.ts': 'mixed',
	// declares DRUPAL_CRON and other Drupal-named vars
	'src/env.ts': 'mixed',
	'src/ops/admin-session.ts': 'host',
	// the update module's state row
	'src/ops/advisories.ts': 'cms',
	'src/ops/aggregates.ts': 'host',
	'src/ops/ai.ts': 'host',
	// Drupal's own cookie names are not sessions
	'src/ops/auth-budget.ts': 'mixed',
	'src/ops/body-limit.ts': 'host',
	'src/ops/cache-tiers.ts': 'host',
	// probes name drupflare classes and Drupal's stream wrappers
	'src/ops/capability-contract.ts': 'mixed',
	'src/ops/catalog.ts': 'cms',
	'src/ops/cf-oauth.ts': 'host',
	'src/ops/cold-encounter.ts': 'host',
	'src/ops/composer-constraint.ts': 'host',
	'src/ops/container-digest.ts': 'host',
	// the Drupal core version embedded in cache rows
	'src/ops/core-version.ts': 'cms',
	'src/ops/cost-attribution.ts': 'host',
	'src/ops/cron-drive.ts': 'mixed',
	'src/ops/cron.ts': 'mixed',
	'src/ops/crossings.ts': 'host',
	'src/ops/day-meters.ts': 'host',
	// drupal.org feed URLs are allow-listed for deferral
	'src/ops/deferred-post.ts': 'mixed',
	'src/ops/degrade.ts': 'host',
	'src/ops/dormancy.ts': 'cms',
	'src/ops/driver-digest.ts': 'host',
	'src/ops/edge-plan.ts': 'host',
	'src/ops/fanout.ts': 'host',
	'src/ops/fleet.ts': 'host',
	// cachetags is Drupal's table
	'src/ops/fragment-index.ts': 'mixed',
	'src/ops/generated/modules.ts': 'cms',
	'src/ops/git-provider.ts': 'host',
	'src/ops/git-smart.ts': 'host',
	// where a repository lands in the Drupal tree
	'src/ops/git-sync.ts': 'mixed',
	'src/ops/health-tree.ts': 'host',
	'src/ops/hibernation.ts': 'host',
	'src/ops/image-runtime.ts': 'host',
	'src/ops/image-transform.ts': 'host',
	'src/ops/inflate-raw.ts': 'host',
	'src/ops/log-level.ts': 'host',
	'src/ops/mail-onboard.ts': 'host',
	// the CfwMail bridge and Drupal's recipient format
	'src/ops/mail.ts': 'mixed',
	'src/ops/module-rev.ts': 'host',
	'src/ops/module-table.ts': 'cms',
	'src/ops/module-tiers.ts': 'cms',
	// Drupal's key_value security state
	'src/ops/mutation-oracle.ts': 'mixed',
	// index names on Drupal's node_field_data
	'src/ops/node-indexes.ts': 'cms',
	'src/ops/oidc.ts': 'host',
	// a cache of compiled Drupal scripts
	'src/ops/opcache-pack.ts': 'cms',
	// install verdicts keyed on the Drupal core version, tiers from the contrib catalog
	'src/ops/oracle.ts': 'mixed',
	'src/ops/outbound-guard.ts': 'host',
	// drupal/* packages resolve against packages.drupal.org
	'src/ops/package-install.ts': 'mixed',
	'src/ops/packagist.ts': 'mixed',
	// Drupal's compiled container row and its core.extension fingerprint
	'src/ops/packed-container.ts': 'mixed',
	'src/ops/page-memo.ts': 'host',
	'src/ops/page-mirror.ts': 'host',
	'src/ops/page-store.ts': 'host',
	'src/ops/park-drive.ts': 'host',
	'src/ops/park.ts': 'host',
	'src/ops/plan-profile.ts': 'host',
	'src/ops/plan.ts': 'host',
	'src/ops/platform-limits.ts': 'host',
	// drupal.org release-history and announcement feeds
	'src/ops/prefetch.ts': 'cms',
	// the engine is generic and the steps are Drupal's
	'src/ops/reconcile.ts': 'mixed',
	'src/ops/render-lane.ts': 'host',
	// where Drupal prints a view dom id and the CSRF token
	'src/ops/render-plan.ts': 'mixed',
	'src/ops/repair.ts': 'host',
	'src/ops/replica-admission.ts': 'host',
	'src/ops/replica-demand.ts': 'host',
	'src/ops/replica-restore.ts': 'host',
	'src/ops/replica-routing.ts': 'host',
	// Drupal's session row id derivation
	'src/ops/replica.ts': 'mixed',
	'src/ops/replication-log.ts': 'host',
	'src/ops/setup-page.ts': 'host',
	'src/ops/shell-assembly.ts': 'host',
	'src/ops/shipped-lock.ts': 'cms',
	'src/ops/site-id.ts': 'host',
	'src/ops/site-origin.ts': 'host',
	// Drupal's hash salt and private key encodings
	'src/ops/site-secrets.ts': 'mixed',
	// Drupal's key_value tables
	'src/ops/state-fingerprint.ts': 'mixed',
	// Drupal's entity and config tables by name
	'src/ops/state-inventory.ts': 'mixed',
	'src/ops/statement-census.ts': 'mixed',
	'src/ops/supervisor.ts': 'host',
	// node_field_data, users_field_data and the router as sweep sources
	'src/ops/sweep.ts': 'mixed',
	'src/ops/tcp.ts': 'host',
	'src/ops/thermal.ts': 'host',
	'src/ops/thresholds.ts': 'host',
	'src/ops/updb.ts': 'cms',
	'src/ops/warming-page.ts': 'host',
	// parses Drupal's cachetags statements out of a forwarded batch
	'src/ops/write-forwarding.ts': 'mixed',
	'src/runtime/opcache.ts': 'host',
	'src/runtime/php-binary-85.ts': 'host',
	'src/runtime/php-binary-jspi.ts': 'host',
	'src/runtime/php-binary-o2.ts': 'host',
	'src/runtime/php-binary-raw.ts': 'host',
	'src/runtime/php-binary.ts': 'host',
	'src/site-do.ts': 'mixed',
	'src/site.ts': 'mixed',
	// drupal/* package search and module upload
	'src/ui/admin.ts': 'mixed',
	'src/vendor.d.ts': 'host'
};

/** every `DO_ROUTE` key in `src/site.ts`, by what its handler does */
export const ROUTE_SIDES: Readonly<Record<string, Side>> = {
	'/heap': 'host',
	'/opcache': 'host',
	'/backend': 'host',
	'/bootphase': 'cms',
	'/ops': 'mixed',
	'/installable': 'cms',
	'/install': 'mixed',
	'/writes': 'host',
	'/replica': 'host',
	'/files': 'host',
	'/enable': 'cms',
	'/php': 'host',
	'/probe': 'host',
	'/mb': 'host',
	'/migrate': 'mixed',
	'/driver': 'cms',
	'/drupal': 'cms',
	'/stats': 'host',
	'/sql': 'host',
	'/txnprobe': 'host',
	'/armfill': 'host',
	'/keepwarm': 'host',
	'/serve': 'mixed',
	'/setup/cf': 'host',
	'/setup/mail': 'host',
	'/setup/oidc': 'mixed',
	'/oidc': 'mixed',
	'/setup/cf/callback': 'host',
	'/fill': 'mixed',
	'/assemble': 'mixed',
	'/plan': 'mixed',
	'/serve-stats': 'host',
	'/bump': 'host',
	'/export': 'mixed',
	'/restore': 'mixed',
	'/pitr': 'host',
	'/queue': 'host',
	'/firstrun': 'cms',
	'/savenode': 'cms',
	'/writeworkload': 'cms',
	'/capability': 'host',
	'/tcp': 'host',
	'/ai': 'host',
	'/git': 'mixed',
	'/githook': 'host',
	'/httpdrain': 'host',
	'/nativefetch': 'host',
	'/invalidate': 'mixed',
	'/health': 'host',
	'/updb': 'cms',
	'/reconcile': 'mixed',
	'/sweep': 'mixed',
	'/modify': 'mixed'
};
