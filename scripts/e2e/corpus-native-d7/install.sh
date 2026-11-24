#!/bin/bash
# native install of one Drupal 7 distribution inside the corpus-native-d7 image; the outputs land in /out
# env: PROFILE (machine name), CORE_MAKE and CONTRIB_MAKE (make files in /clone), HOST_UID and HOST_GID
set -euo pipefail
export HOME=/out COMPOSER_HOME=/opt/composer
exec > >(tee /out/install.log) 2>&1
cd /out
started=$(date +%s)
echo "php $(php -r 'echo PHP_VERSION;') $(drush --version 2> /dev/null | head -1 || true)"
# a distribution is built the way its packaging builds it: core from the core make file, the profile
# copied in, then the contrib make file with its destination inside the profile
drush make --yes --concurrency=4 "/clone/${CORE_MAKE:-drupal-org-core.make}" site
mkdir -p "site/profiles/$PROFILE"
rsync -a --exclude=.git /clone/ "site/profiles/$PROFILE/"
cd site
# a download that no longer exists is recorded in the log and the build goes on
drush make --yes --no-core --force-complete --concurrency=4 --contrib-destination="profiles/$PROFILE" \
	"/clone/${CONTRIB_MAKE:-drupal-org.make}"
mkdir -p sites/default/files
cp sites/default/default.settings.php sites/default/settings.php
chmod -R u+w sites/default
built=$(date +%s)
bash /d7/mysql.sh
drush site-install "$PROFILE" -v --db-url="mysql://d7:d7@127.0.0.1/d7" --account-name=admin \
	--account-pass=corpus --site-name="corpus $PROFILE" -y
installed=$(date +%s)
drush cc all
# the enabled extensions are what the delivery step reads
drush php-eval 'echo json_encode(array("core" => VERSION, "modules" => array_values(module_list()),
	"themes" => array_keys(array_filter(list_themes(), function ($t) { return $t->status; })),
	"default_theme" => variable_get("theme_default"), "front" => variable_get("site_frontpage", "node")));' \
	> /out/extensions.json
mysqldump d7 > /out/site.sql
echo "{\"build_s\":$((built - started)),\"install_s\":$((installed - built))}" > /out/timing.json
mysqladmin shutdown
chown -R "${HOST_UID:-0}:${HOST_GID:-0}" /out
ls -l /out/extensions.json /out/timing.json /out/site.sql
