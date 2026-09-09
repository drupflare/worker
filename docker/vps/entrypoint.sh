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
PHP

mkdir -p "$SITE_DIR/files/config/sync"
chmod -R 0777 "$SITE_DIR/files" 2> /dev/null || true

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
