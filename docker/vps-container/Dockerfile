# The VPS arm as a Cloudflare Container, so both arms answer from inside Cloudflare's network.
#
# `docker/vps.yml` runs the same software on localhost, which is the VPS's best case: it has no
# network term at all, and the generator shares a kernel with the thing it measures. This image puts
# the identical stack in a real region reached over the same path the edge arm is reached by, so the
# transport is common to both and cancels instead of being argued about.
#
# Two differences from the compose arm, both forced by the platform rather than chosen:
#
#   - ONE container, so nginx and php-fpm share it. The compose arm splits them across a network.
#   - NOTHING IS MOUNTED. `drupal-src` and the site database are copied in, and the site is claimed
#     at BUILD time. A container that seeded itself on first request would charge that work to the
#     first measurement.
FROM php:8.5-fpm-alpine

# mbstring, pdo_sqlite, sqlite3 and opcache are already in the base image; installing one that is
# built in emits no shared module and fails the whole layer with "cp: can't stat 'modules/*'"
RUN set -eux; \
	apk add --no-cache --virtual .build-deps $PHPIZE_DEPS libpng-dev libjpeg-turbo-dev freetype-dev libzip-dev icu-dev; \
	apk add --no-cache nginx libpng libjpeg-turbo freetype libzip icu-libs; \
	docker-php-ext-configure gd --with-freetype --with-jpeg; \
	docker-php-ext-install -j"$(nproc)" gd pdo_mysql zip intl; \
	apk del .build-deps

# opcache tuned the way a competent operator would tune a VPS. An untuned arm would
# hand drupflare a win it did not earn. Identical to the compose arm's settings.
RUN { \
		echo 'opcache.enable=1'; \
		echo 'opcache.enable_cli=0'; \
		echo 'opcache.memory_consumption=192'; \
		echo 'opcache.interned_strings_buffer=16'; \
		echo 'opcache.max_accelerated_files=40000'; \
		echo 'opcache.validate_timestamps=0'; \
		echo 'opcache.jit=tracing'; \
		echo 'opcache.jit_buffer_size=64M'; \
	} > /usr/local/etc/php/conf.d/99-opcache.ini

COPY prepend.php /usr/local/etc/php/prepend.php

RUN { \
		echo 'memory_limit=256M'; \
		echo 'realpath_cache_size=4096K'; \
		echo 'realpath_cache_ttl=600'; \
		echo 'max_execution_time=60'; \
		echo 'expose_php=0'; \
		echo 'auto_prepend_file=/usr/local/etc/php/prepend.php'; \
	} > /usr/local/etc/php/conf.d/99-drupal.ini

COPY drupal-src /var/www/html
COPY site.sqlite /seed/site.sqlite
COPY nginx.conf /etc/nginx/nginx.conf
COPY start.sh /usr/local/bin/vps-start
RUN chmod +x /usr/local/bin/vps-start

ARG VPS_ADMIN_PASS=cfw-Bench-9143-pass
ARG VPS_FPM_MAX_CHILDREN=32

# THE IMAGE DEFAULT IS pm.max_children=5, which measures a misconfigured VPS. Five children collapse
# at four concurrent clients and the curve reads non-monotonic. `static` rather than `dynamic` so a
# benchmark is not also measuring the process manager.
RUN { \
		echo '[www]'; \
		echo 'pm = static'; \
		echo "pm.max_children = ${VPS_FPM_MAX_CHILDREN}"; \
		echo 'pm.max_requests = 0'; \
		echo 'pm.status_path = /fpm-status'; \
		echo 'listen = 127.0.0.1:9000'; \
	} > /usr/local/etc/php-fpm.d/zz-bench.conf

# The site is claimed HERE rather than on first request, so a cold-start measurement is a
# measurement of the runtime rather than of this script. Otherwise identical to the compose arm's
# entrypoint: the seed is copied before it is opened, because SQLite writes to the file it reads and
# a benchmark must never mutate what it is measuring.
RUN set -eux; \
	mkdir -p /var/www/db /var/www/html/sites/default/files/config/sync; \
	cp /seed/site.sqlite /var/www/db/site.sqlite; \
	php -r '$d = new PDO("sqlite:/var/www/db/site.sqlite"); $d->exec("PRAGMA journal_mode=WAL"); $d->exec("PRAGMA synchronous=NORMAL");'; \
	printf '%s\n' \
		'<?php' \
		'' \
		"\$databases['default']['default'] = ['driver' => 'sqlite', 'database' => '/var/www/db/site.sqlite'];" \
		"\$settings['hash_salt'] = 'vps-arm-fixed-salt-so-sessions-survive-a-restart';" \
		"\$settings['config_sync_directory'] = '/var/www/html/sites/default/files/config/sync';" \
		"\$settings['file_public_path'] = 'sites/default/files';" \
		"\$settings['update_free_access'] = false;" \
		"\$settings['trusted_host_patterns'] = ['.*'];" \
		"\$settings['rebuild_access'] = false;" \
		"\$settings['skip_permissions_hardening'] = true;" \
		"\$settings['reverse_proxy'] = true;" \
		"\$settings['reverse_proxy_addresses'] = ['127.0.0.1', '::1'];" \
		"\$streamHttp = '/var/www/html/libraries/drupflare-stream-http/src/';" \
		"if (is_dir(\$streamHttp)) {" \
		"	\$autoloader = require '/var/www/html/autoload.php';" \
		"	if (is_object(\$autoloader)) { \$autoloader->addPsr4('Drupflare\\\\StreamHttp\\\\', \$streamHttp); }" \
		"}" \
		> /var/www/html/sites/default/settings.php

# uid 1's password, through Drupal's own hasher rather than an UPDATE: the hash algorithm is
# Drupal's to choose, and a hand-written row authenticates against nothing. Both arms then
# authenticate as the same user with the same credential.
RUN set -eux; \
	VPS_ADMIN_PASS="${VPS_ADMIN_PASS}" php -d opcache.enable_cli=0 -r ' \
		$loader = require "/var/www/html/autoload.php"; \
		$request = Symfony\Component\HttpFoundation\Request::create("/", "GET"); \
		$kernel = new Drupal\Core\DrupalKernel("prod", $loader); \
		Drupal\Core\DrupalKernel::bootEnvironment(); \
		$kernel->setSitePath("sites/default"); \
		Drupal\Core\Site\Settings::initialize("/var/www/html", "sites/default", $loader); \
		$kernel->boot(); \
		$kernel->preHandle($request); \
		$user = Drupal\user\Entity\User::load(1); \
		$user->setPassword(getenv("VPS_ADMIN_PASS")); \
		$user->save(); \
		fwrite(STDERR, "uid 1 password set\n"); \
	'; \
	mkdir -p /var/cache/nginx/drupal /run/nginx; \
	chown -R www-data:www-data /var/www/db /var/www/html/sites/default/files /var/cache/nginx; \
	chmod -R 0777 /var/www/db /var/www/html/sites/default/files /var/cache/nginx

EXPOSE 8080
CMD ["/usr/local/bin/vps-start"]
