FROM php:8.5-cli
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
ADD https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions /usr/local/bin/
RUN chmod +x /usr/local/bin/install-php-extensions \
	&& apt-get update && apt-get install -y --no-install-recommends git unzip patch rsync \
	&& install-php-extensions gd zip intl bcmath opcache exif pcntl sockets geos \
	&& rm -rf /var/lib/apt/lists/* \
	&& echo 'memory_limit=-1' > /usr/local/etc/php/conf.d/corpus.ini
