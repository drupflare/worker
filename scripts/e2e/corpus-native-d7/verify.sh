#!/bin/bash
# serves the installed Drupal 7 tree and reads the front page and the admin pages; writes /out/verify.json
set -euo pipefail
export HOME=/out
bash /d7/mysql.sh
cd /out/site
php -S 127.0.0.1:8088 -t . > /out/serve.log 2>&1 &
for i in $(seq 1 30); do
	curl -s -o /dev/null http://127.0.0.1:8088/ && break
	sleep 1
done
probe() {
	local name=$1 url=$2 jar=${3:-/dev/null}
	local out title
	out=$(curl -s -L -b "$jar" -c "$jar" -o /tmp/body -w '%{http_code} %{size_download}' "http://127.0.0.1:8088$url")
	title=$(grep -o '<title>[^<]*' /tmp/body | head -1 | sed 's/<title>//' | tr -d '\n"' || true)
	printf '"%s":{"status":%s,"bytes":%s,"title":"%s"}' "$name" "${out%% *}" "${out##* }" "$title"
}
LINK=$(drush user-login --uri=http://127.0.0.1:8088 --browser=0 admin)
JAR=/tmp/jar
first=$(probe front "/")
second=$(probe login "/?q=user/login")
curl -s -L -c "$JAR" -o /dev/null "$LINK"
third=$(probe admin "/?q=admin" "$JAR")
fourth=$(probe modules "/?q=admin/modules" "$JAR")
fifth=$(probe content "/?q=admin/content" "$JAR")
echo "{$first,$second,$third,$fourth,$fifth}" > /out/verify.json
mysqladmin shutdown
chown -R "${HOST_UID:-0}:${HOST_GID:-0}" /out
cat /out/verify.json
