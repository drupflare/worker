# The VPS comparison arm: the same Drupal, the same site database, native PHP.
#
# PHP 8.5 to match the interpreter drupflare ships, so the comparison isolates the
# runtime rather than folding a version difference into it.
FROM php:8.5-fpm-alpine

# mbstring, pdo_sqlite, sqlite3 and opcache are already in the base image; installing one that is
# built in emits no shared module and fails the whole layer with "cp: can't stat 'modules/*'"
RUN set -eux; \
	apk add --no-cache --virtual .build-deps $PHPIZE_DEPS libpng-dev libjpeg-turbo-dev freetype-dev libzip-dev icu-dev; \
	apk add --no-cache libpng libjpeg-turbo freetype libzip icu-libs; \
	docker-php-ext-configure gd --with-freetype --with-jpeg; \
	docker-php-ext-install -j"$(nproc)" gd pdo_mysql zip intl; \
	apk del .build-deps

# opcache tuned the way a competent operator would tune a VPS. An untuned arm would
# hand drupflare a win it did not earn.
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

COPY entrypoint.sh /usr/local/bin/vps-entrypoint
RUN chmod +x /usr/local/bin/vps-entrypoint

ENTRYPOINT ["/usr/local/bin/vps-entrypoint"]
CMD ["php-fpm"]
