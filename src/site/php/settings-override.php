<?php
// --- appended by src/site-do.js: run against ctx.storage.sql ---
$databases['default']['default'] = [
	'driver' => 'cfw_do_sqlite',
	'namespace' => 'Drupal\\cfw_do_sqlite\\Driver\\Database\\cfw_do_sqlite',
	'autoload' => 'modules/custom/cfw_do_sqlite/src/Driver/Database/cfw_do_sqlite/',
	'prefix' => '',
	// this object's slice of the rowid space. A forwarding lane predicts an id, tells the visitor
	// about it, and then hands the statement to a primary that would append its own -- so the driver
	// mints from a residue class no other lane can reach and names the id in the INSERT. Both are 0
	// on the primary and wherever forwarding is off, which is the arithmetic that was always there
	'lane' => __CFW_LANE__,
	'lanes' => __CFW_LANES__,
];
$class_loader->addPsr4(
	'Drupal\\sqlite\\Driver\\Database\\sqlite\\',
	$app_root . '/core/modules/sqlite/src/Driver/Database/sqlite/',
);
// PDO, PDOException and PDOStatement in userland, for a build with no ext-pdo. Global classes,
// so no PSR-4 root can reach them and the require is the only mechanism; it has to run before
// the first statement is constructed, and Settings::initialize() is the earliest place that does
require_once $app_root . '/modules/custom/cfw_do_sqlite/src/pdo-shim.php';
// the namespace is registered here rather than by the module system: the PSR-4 root has to exist
// before Settings::initialize() returns, and the extension list is not read until after
$class_loader->addPsr4('Drupal\\drupflare\\', $app_root . '/modules/custom/drupflare/src/');
// The mailer is claimed by the module, not forced here. This block used to assign
// system.mail:interface.default = cfw_mail unconditionally, on the reasoning that php_mail cannot
// run in this runtime and a config import must not revert a site into a mailer that drops
// everything. Both halves are true and the assignment was still a 500 on every site: cfw_mail is a
// plugin of the drupflare module, an assignment cannot know whether its provider is installed,
// and MailManager throws PluginNotFoundException for an interface it cannot resolve -- so
// /user/password answered 500 rather than failing to send. Measured on a provisioned site.
// (The shipped core.extension DOES list drupflare today; it did not when this was found, and the
// override is still the right shape because a site can uninstall the module.)
//
// drupflare_install() sets it instead, which cannot run before the plugin exists, and
// Drupal\drupflare\Hook\Requirements reports an interface that is not cfw_mail.
// drupflare/stream-http, which drupflare's HttpsStreamWrapper now EXTENDS. Composer never runs
// on the edge, so the packed tree is the vendor directory and this line is the autoloader entry
// composer would otherwise have written. Without it the subclass fatals on its parent.
$class_loader->addPsr4(
	'Drupflare\\StreamHttp\\',
	$app_root . '/libraries/drupflare-stream-http/src/',
);
// A forged host cannot move the site, so the pattern list is the origin the object already pinned
// rather than a wildcard. cfw_serve() builds every request from that same origin, so anything else
// is a request this site did not issue to itself. Empty until the origin is known, which is the one
// state where the check has nothing to compare against.
$cfw_host = (string) parse_url(__CFW_SITE_ORIGIN__, PHP_URL_HOST);
if ($cfw_host !== '') {
	$settings['trusted_host_patterns'] = ['^' . str_replace('.', '\\.', $cfw_host) . '$'];
}
// Drupal derives this from the hash salt and then reports that it does not exist. Nothing in this
// runtime creates it, and config import/export is the one feature that reads it.
$settings['config_sync_directory'] = $app_root . '/sites/default/files/config/sync';
// created HERE, not once at claim time: the filesystem is remounted from the pack on every boot,
// so a directory made during provisioning is gone by the next request
if (!is_dir($settings['config_sync_directory'])) {
	@mkdir($settings['config_sync_directory'], 0777, true);
}
// FALSE is what core asks for: SystemRequirementsHooks warns on TRUE *and* on NULL, and both
// messages say to set FALSE. It is the Drupal 12 default and the Drupal 13 behaviour, and it only
// adds a novalidate attribute to forms -- server-side validation is untouched
$settings['enable_html5_validation'] = false;
// whether the password service hashes with argon2id on the host. OFF unless the operator says
// so -- turning it on rehashes every password at its owner's next login, and on the free plan a
// 19 MiB two-pass hash is CPU a login invocation does not have
$settings['drupflare.argon2'] = __CFW_ARGON2__;
// Cache bins the interpreter keeps in memory instead of in this tenant's SQLite, from
// MEMORY_CACHE_BINS. Empty by default. Measured on the shipping pack: a real re-render after a tag
// invalidation charges 9 rows, of which 6 are the dynamic_page_cache bin -- two thirds of the
// operation the free plan's regeneration ceiling is computed from, in one bin. What it costs back
// is a rebuild after every interpreter drop, which is a property of a site's own traffic, so the
// default is a decision an operator makes rather than one shipped for them
// NOT $settings['cache']['bins'], which names a SERVICE. A service is resolved out of the compiled
// container, the pack ships that container prebuilt, and its cache key does not move when the
// driver pack does -- so the settings route names something the container has never heard of and
// the boot throws. Measured on a fresh site: the arm with a bin selected rendered nothing at all,
// 0 rows and 0 bytes, against 8 rows on the control. CfwCacheBackendFactory reads this instead, and
// its body is remounted from the pack on every boot
$settings['drupflare']['memory_cache_bins'] = __CFW_MEMORY_BINS__;
$settings['drupflare']['memory_cache_max_items'] = __CFW_MEMORY_ITEMS__;
// libraries delivered after the pack, registered the way composer would have; see autoloadPhp()
// __CFW_PACKAGE_AUTOLOAD__
// DRUPAL_ENV_* and DRUPAL_CONFIG from the deployment; see src/ops/deployment-env.ts
// __CFW_DEPLOYMENT_ENV__
