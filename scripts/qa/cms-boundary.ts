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
 * has no side, when an entry names a module or directory that no longer holds one, and when a
 * per-file entry repeats its directory's side. Probes are frozen instruments and are not classified.
 */
export type Side = 'host' | 'cms' | 'mixed';

/**
 * Directories whose every module shares one side, keyed with a trailing slash. The longest
 * matching prefix wins, and a `MODULE_SIDES` entry overrides it for one file.
 */
export const DIRECTORY_SIDES: Readonly<Record<string, Side>> = {
	// the PHP fragments and the shims Drupal needs
	'src/drupal/': 'cms',
	'src/runtime/': 'host',
	'src/util/': 'host'
};

/** one side per module outside `DIRECTORY_SIDES`, or an override for one module inside it */
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
	'src/do/alarm-body.ts': 'mixed',
	'src/do/alarm.ts': 'host',
	'src/do/alarm/autoscale.ts': 'host',
	'src/do/alarm/context.ts': 'host',
	// drives Drupal's own cron
	'src/do/alarm/cron.ts': 'mixed',
	// drains deferred HTTP and mail, whose queues Drupal's fetch and mail handlers fill
	'src/do/alarm/drains.ts': 'mixed',
	'src/do/alarm/fill.ts': 'host',
	// runs the cron GC pass over Drupal's disposable tables
	'src/do/alarm/health.ts': 'mixed',
	'src/do/alarm/image.ts': 'host',
	'src/do/alarm/lane.ts': 'host',
	'src/do/alarm/meters.ts': 'host',
	'src/do/alarm/migrate.ts': 'host',
	'src/do/alarm/mirrors.ts': 'host',
	'src/do/alarm/quarantine.ts': 'host',
	// reads the cron and mail queues to pick the next firing
	'src/do/alarm/rearm.ts': 'mixed',
	'src/do/alarm/reconcile.ts': 'host',
	'src/do/alarm/restore.ts': 'host',
	// carries Drupal's database update chain
	'src/do/alarm/stepped.ts': 'mixed',
	'src/do/capabilities.ts': 'mixed',
	'src/do/fill.ts': 'mixed',
	// reports the shipped Drupal core version
	'src/do/fleet.ts': 'mixed',
	'src/do/git-delivery.ts': 'mixed',
	'src/do/git.ts': 'mixed',
	'src/do/health.ts': 'mixed',
	'src/do/heap-image.ts': 'mixed',
	// passes x-drupal-* headers through and reads cachetags writes
	'src/do/helpers.ts': 'mixed',
	'src/do/invalidate.ts': 'mixed',
	'src/do/isolate.ts': 'host',
	'src/do/keys.ts': 'host',
	'src/do/lanes.ts': 'mixed',
	'src/do/lazy-mount.ts': 'host',
	// defaults the drupal-sql chunk prefix
	'src/do/levers.ts': 'mixed',
	// matches writes to Drupal's cachetags table
	'src/do/limits.ts': 'mixed',
	'src/do/mail-setup.ts': 'host',
	'src/do/meters.ts': 'host',
	'src/do/modify.ts': 'mixed',
	'src/do/outbound.ts': 'mixed',
	'src/do/packages.ts': 'mixed',
	'src/do/provision.ts': 'mixed',
	'src/do/reconcile.ts': 'mixed',
	'src/do/replication.ts': 'mixed',
	'src/do/routes/auth.ts': 'mixed',
	// imports src/drupal/
	'src/do/routes/diagnostics.ts': 'mixed',
	'src/do/routes/fill.ts': 'mixed',
	'src/do/routes/heap.ts': 'mixed',
	// the table names the Drupal-only routes
	'src/do/routes/index.ts': 'mixed',
	'src/do/routes/lifecycle.ts': 'mixed',
	'src/do/routes/mail.ts': 'host',
	'src/do/routes/owner.ts': 'mixed',
	'src/do/routes/packages.ts': 'mixed',
	'src/do/routes/replica.ts': 'mixed',
	'src/do/routes/serve.ts': 'mixed',
	'src/do/routes/writes.ts': 'mixed',
	'src/do/serve.ts': 'mixed',
	// the settings.php override and services.yml
	'src/do/settings.ts': 'mixed',
	'src/do/shell.ts': 'mixed',
	'src/do/stats.ts': 'mixed',
	// carries Drupal's Set-Cookie lines and x-drupal-* headers
	'src/do/types.ts': 'mixed',
	// declares DRUPAL_CRON and other Drupal-named vars
	'src/env.ts': 'mixed',
	'src/site/admin.ts': 'mixed',
	'src/site/allowance.ts': 'host',
	'src/site/decorate.ts': 'host',
	'src/site/deployment.ts': 'host',
	'src/site/edge-cache.ts': 'host',
	'src/site/edge-read.ts': 'host',
	'src/site/edge-store.ts': 'host',
	'src/site/entry.ts': 'host',
	// the public files directory, module asset roots and public:// uris
	'src/site/files.ts': 'mixed',
	'src/site/fill-window.ts': 'host',
	// the PHP fragments Drupal runs and the pages the host serves, packed from src/site/php and html
	'src/site/generated/assets.ts': 'mixed',
	// the scanner deny list and the core entry point redirects
	'src/site/guards.ts': 'mixed',
	'src/site/hop.ts': 'host',
	// the /enable module install and its fill arming
	'src/site/learn.ts': 'mixed',
	'src/site/memos.ts': 'host',
	// the claim's warm and consistency phases are Drupal's install steps
	'src/site/object-routes.ts': 'mixed',
	'src/site/owner.ts': 'host',
	// reads the session csrf token out of a Drupal render
	'src/site/plan-tier.ts': 'mixed',
	'src/site/routes.ts': 'host',
	// names Drupal's entry points in the deny headers
	'src/site/screen.ts': 'mixed',
	'src/site/surfaces.ts': 'host',
	'src/site/target.ts': 'host',
	'src/site/types.ts': 'host',
	'src/ops/admin-session.ts': 'host',
	// the update module's state row
	'src/ops/advisories.ts': 'cms',
	'src/ops/aggregates.ts': 'host',
	'src/ops/ai.ts': 'host',
	'src/ops/attempt.ts': 'host',
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
	// names PHP reads from the environment and the $config overlay
	'src/ops/deployment-env.ts': 'mixed',
	// one deployment is one site: the primary and the sites it lists
	'src/ops/deployment-site.ts': 'host',
	'src/ops/driver-digest.ts': 'host',
	'src/ops/edge-plan.ts': 'host',
	// header and redirect rules the front worker applies
	'src/ops/edge-rules.ts': 'host',
	'src/ops/error-probe.ts': 'host',
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
	'src/ops/json-reply.ts': 'host',
	'src/ops/lock-map.ts': 'mixed',
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
	'src/site-do.ts': 'mixed',
	'src/site.ts': 'mixed',
	// drupal/* package search and module upload
	'src/ui/admin.ts': 'mixed',
	'src/ui/admin/access.ts': 'host',
	// drush aliases and the `/__ops` operations are Drupal's
	'src/ui/admin/commands.ts': 'mixed',
	'src/ui/admin/deploy.ts': 'host',
	// drupal/* package search and module upload
	'src/ui/admin/extend.ts': 'mixed',
	'src/ui/admin/git.ts': 'host',
	'src/ui/admin/limits.ts': 'host',
	'src/ui/admin/operate.ts': 'host',
	'src/ui/admin/shell.ts': 'host',
	'src/vendor.d.ts': 'host'
};

/** every `DO_ROUTE` key in `src/site/routes.ts`, by what its handler does */
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
