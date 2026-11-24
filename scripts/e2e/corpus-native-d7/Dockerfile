FROM php:7.4-cli
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
ADD https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions /usr/local/bin/
RUN chmod +x /usr/local/bin/install-php-extensions \
	&& sed -i 's|deb.debian.org|archive.debian.org|g; /bullseye-updates/d' /etc/apt/sources.list \
	&& apt-get -o Acquire::Check-Valid-Until=false update \
	&& apt-get install -y --no-install-recommends git unzip patch rsync curl ca-certificates mariadb-server \
	&& install-php-extensions gd zip opcache pdo_mysql \
	&& rm -rf /var/lib/apt/lists/* \
	&& printf 'memory_limit=-1\nsendmail_path=/bin/true\n' > /usr/local/etc/php/conf.d/corpus.ini
ENV COMPOSER_HOME=/opt/composer COMPOSER_ALLOW_SUPERUSER=1
RUN composer global config audit.block-insecure false \
	&& composer global require drush/drush:8.4.12 --no-interaction --no-progress \
	&& ln -s /opt/composer/vendor/bin/drush /usr/local/bin/drush
