#!/bin/sh
# Seeds a writable site out of the read-only tree the host mounts.
#
# The shipped site.sqlite is a TRACKED artifact and is mounted read-only; it is copied
# rather than opened in place, because SQLite writes to the file it reads and a
# benchmark must never mutate what it is measuring.
set -eu

SITE_DIR=/var/www/html/sites/default
DB_DIR=/var/www/db

mkdir -p "$DB_DIR" "$SITE_DIR/files"

if [ ! -f "$DB_DIR/site.sqlite" ]; then
	cp /seed/site.sqlite "$DB_DIR/site.sqlite"
	# a fresh copy has no -wal/-shm; WAL is what a tuned operator would run
	php -r '$d=new PDO("sqlite:'"$DB_DIR"'/site.sqlite"); $d->exec("PRAGMA journal_mode=WAL"); $d->exec("PRAGMA synchronous=NORMAL");'
fi

chown -R www-data:www-data "$DB_DIR" "$SITE_DIR/files" 2> /dev/null || true
chmod -R 0777 "$DB_DIR" "$SITE_DIR/files" 2> /dev/null || true

cat > "$SITE_DIR/settings.php" << 'PHP'
<?php

$databases['default']['default'] = [
	'driver' => 'sqlite',
	'database' => '/var/www/db/site.sqlite',
];

$settings['hash_salt'] = 'vps-arm-fixed-salt-so-sessions-survive-a-restart';
$settings['config_sync_directory'] = '/var/www/html/sites/default/files/config/sync';
$settings['file_public_path'] = 'sites/default/files';
$settings['update_free_access'] = false;
$settings['trusted_host_patterns'] = ['.*'];
$settings['rebuild_access'] = false;
$settings['skip_permissions_hardening'] = true;

// the reverse-proxy posture a VPS behind Cloudflare would run
$settings['reverse_proxy'] = true;
$settings['reverse_proxy_addresses'] = ['127.0.0.1', '::1'];

// The driver layer's own library root, which composer did not install into this tree.
//
// `core.extension` in the seeded database lists `drupflare`, so ModuleHandler::loadAll() includes
// its .module and fatals on the parent class of HttpsStreamWrapper unless this root is registered.
// Registering it is also what keeps the comparison honest: both arms then run the SAME module set
// against the SAME database, and the difference measured is the runtime rather than the site.
$streamHttp = '/var/www/html/libraries/drupflare-stream-http/src/';
if (is_dir($streamHttp)) {
	$autoloader = require '/var/www/html/autoload.php';
	if (is_object($autoloader)) {
		$autoloader->addPsr4('Drupflare\\StreamHttp\\', $streamHttp);
	}
}
PHP

mkdir -p "$SITE_DIR/files/config/sync"
chmod -R 0777 "$SITE_DIR/files" 2> /dev/null || true

# uid 1's password, so BOTH arms authenticate as the same user with the same credential.
#
# The seeded database carries whatever hash the pack was baked with, and the edge arm's password is
# set by `/firstrun`. Without this the authenticated half of the comparison can only run on one side,
# which is how every published authenticated figure came to be a render-against-render reading.
#
# Through Drupal's own hasher rather than an UPDATE: the hash algorithm is Drupal's to choose, and a
# hand-written row authenticates against nothing.
if [ -n "${VPS_ADMIN_PASS:-}" ]; then
	php -d opcache.enable_cli=0 -r '
		$loader = require "/var/www/html/autoload.php";
		$request = Symfony\Component\HttpFoundation\Request::create("/", "GET");
		$kernel = new Drupal\Core\DrupalKernel("prod", $loader);
		Drupal\Core\DrupalKernel::bootEnvironment();
		$kernel->setSitePath("sites/default");
		Drupal\Core\Site\Settings::initialize("/var/www/html", "sites/default", $loader);
		$kernel->boot();
		$kernel->preHandle($request);
		$user = Drupal\user\Entity\User::load(1);
		$user->setPassword(getenv("VPS_ADMIN_PASS"));
		$user->save();
		fwrite(STDERR, "uid 1 password set\n");
	' || echo "could not set the uid 1 password; the authenticated arm will not run"
fi

# THE IMAGE DEFAULT IS pm.max_children=5, which measures a misconfigured VPS. Five children collapse
# at four concurrent clients and the curve reads non-monotonic, which would have handed drupflare a
# win the runtime did not earn.
# `static` rather than `dynamic` so a benchmark is not also measuring the process manager.
cat > /usr/local/etc/php-fpm.d/zz-bench.conf << CONF
[www]
pm = ${VPS_FPM_PM:-static}
pm.max_children = ${VPS_FPM_MAX_CHILDREN:-32}
pm.max_requests = 0
pm.status_path = /fpm-status
CONF

exec "$@"
