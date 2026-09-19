#!/bin/sh
# nginx is PID 1 so a php-fpm crash shows as a 502 rather than a silently dead instance.
#
# NO `set -e`. A sandboxed container runtime need not provide everything the local Docker daemon
# does, and with `set -e` any one of these steps exits the script -- which the platform reports only
# as "the container just exited", with nothing to debug. Every step reports instead.

echo "vps-start: booting" >&2

# FOREGROUND, backgrounded by the shell. `--daemonize` forks and detaches, which the local Docker
# daemon allows and the container sandbox does not: nginx then came up and every request answered
# 502 because php-fpm was never listening.
php-fpm -F --force-stderr > /tmp/fpm.log 2>&1 &
FPM=$!
echo "vps-start: php-fpm pid $FPM" >&2

i=0
while [ "$i" -lt 50 ]; do
	nc -z 127.0.0.1 9000 2> /dev/null && break
	i=$((i + 1))
	sleep 0.1
done
if [ "$i" -ge 50 ]; then
	echo "vps-start: php-fpm never opened 127.0.0.1:9000" >&2
else
	echo "vps-start: php-fpm ready after ${i} tries" >&2
fi

mkdir -p /run/nginx /var/cache/nginx/drupal 2> /dev/null

nginx -t 2>&1 || echo "vps-start: nginx config test failed" >&2

echo "vps-start: exec nginx" >&2
cat /tmp/fpm.log >&2 2> /dev/null
exec nginx -g 'daemon off;'
