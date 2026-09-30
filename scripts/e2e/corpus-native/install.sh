#!/bin/bash
# native install of one repository inside the corpus-native image; the outputs land in /out
# env: KIND (project|profile), PROFILE (machine name), PROFILE_PKG (composer name), TEMPLATE (project template),
# CORE (the repository's core constraint)
set -euo pipefail
export COMPOSER_HOME=/out/.composer COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_MEMORY_LIMIT=-1 HOME=/out
export GIT_TERMINAL_PROMPT=0 COMPOSER_IGNORE_PLATFORM_REQS=1
git config --global --add safe.directory "*"
mkdir -p "$COMPOSER_HOME"
echo '{"config":{"allow-plugins":true}}' > "$COMPOSER_HOME/config.json"
exec > >(tee /out/install.log) 2>&1
cd /out
FLAGS="--no-interaction --no-progress --ignore-platform-reqs"
if [ "$KIND" = project ]; then
	cp -a /clone /out/site
	cd /out/site
	# a package behind a credential the fixture does not hold (herbie's private icon library) is
	# dropped with the repository that serves it, and the lock forgets it
	if [ -n "${OMIT:-}" ]; then
		OMIT="$OMIT" php -r '$j = json_decode(file_get_contents("composer.json"), true);
			foreach (explode(" ", getenv("OMIT")) as $p) {
				unset($j["require"][$p], $j["require-dev"][$p]);
				$j["repositories"] = array_values(array_filter($j["repositories"] ?? [],
					fn($r) => !is_array($r) || strpos($r["url"] ?? "", $p) === false));
			}
			file_put_contents("composer.json", json_encode($j, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));'
		composer update $OMIT --no-install $FLAGS
	fi
	composer install $FLAGS
elif [ -n "${TEMPLATE:-}" ]; then
	composer create-project "$TEMPLATE" /out/site --stability dev $FLAGS
	cd /out/site
	# the template resolves the released profile; the pinned clone replaces it through a path
	# repository so composer resolves the pinned profile's own dependencies too. Copying its files over
	# the released one left open y's code wanting protected_pages ^3.0 beside a locked 1.9.0
	composer config repositories.profile "{\"type\":\"path\",\"url\":\"/clone\",\"options\":{\"symlink\":false}}"
	composer require "$PROFILE_PKG:@dev" -W $FLAGS
else
	# the profile pins its own core, so the project has to start on a core it accepts
	composer create-project "drupal/recommended-project:${CORE:-^11}" /out/site $FLAGS
	cd /out/site
	composer config minimum-stability dev
	composer config prefer-stable true
	composer config --no-plugins allow-plugins true
	composer config repositories.assets composer https://asset-packagist.org
	# a pinned core can carry a later advisory, and the install is a fixture, not a site
	composer config audit.block-insecure false
	# a path dependency does not bring its own repositories, so the profile's are copied up, AHEAD
	# of the template's: composer takes the first repository that has a package as canonical, and
	# drupal.org's drupal/ala hid the dev-2.x-d11 package droopler defines inline. Written as one
	# list, because a named entry added with composer config is moved to the front
	php -r '$root = json_decode(file_get_contents("composer.json"), true);
		$own = json_decode(file_get_contents("/clone/composer.json"), true);
		$list = [["type" => "path", "url" => "/clone", "options" => ["symlink" => false]]];
		foreach ($own["repositories"] ?? [] as $r)
			if (is_array($r) && ($r["type"] ?? "") !== "path") $list[] = $r;
		foreach ($root["repositories"] ?? [] as $r) $list[] = $r;
		$root["repositories"] = $list;
		file_put_contents("composer.json", json_encode($root, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));'
	composer require "$PROFILE_PKG:@dev" drush/drush -W $FLAGS
fi
# a template may move bin-dir, so drush is found where composer put it
DRUSH="$(composer config bin-dir --absolute)/drush"
[ -x "$DRUSH" ] || composer require drush/drush -W $FLAGS
WEB=$( (ls -d web docroot html 2> /dev/null || true) | head -1)
cd "$WEB"
mkdir -p sites/default/files
# --existing-config installs from the project's own config/sync, which its settings name (openculturas)
case " ${INSTALL_ARGS:-} " in *" --existing-config "*)
	[ -d ../config/sync ] || { mkdir -p ../config && cp -a /clone/config/sync ../config/; }
	# a config exported from a MySQL site omits core's sqlite module, and the import would then
	# uninstall the module providing this install's database driver
	grep -q "^  sqlite:" ../config/sync/core.extension.yml \
		|| sed -i "/^module:/a\\  sqlite: 0" ../config/sync/core.extension.yml
	# core imports a moderation_state base field override before the workflow that defines the field,
	# and the install dies on it (openculturas); the overrides only relabel the field
	find ../config/sync -name "core.base_field_override.*.moderation_state.yml" -delete
	cp sites/default/default.settings.php sites/default/settings.php
	echo "\$settings['config_sync_directory'] = dirname(\$app_root) . '/config/sync';" >> sites/default/settings.php
	;;
esac
# droopler's profile applies DRUPAL_ROOT/../recipes/droopler itself during install, and that recipe
# needs the starter theme its launch script copies into place first
if [ -d /clone/recipes ]; then
	mkdir -p ../recipes
	cp -a /clone/recipes/. ../recipes/
fi
# RECIPE_REQUIRES pairs (recipe:dependency) add a recipe the copied one assumes but does not list;
# droopler's needs core's page_content_type, the only place Drupal 11 ships node's body storage
for pair in ${RECIPE_REQUIRES:-}; do
	file="../recipes/${pair%%:*}/recipe.yml"
	if grep -q "^recipes:" "$file"; then
		sed -i "/^recipes:/a\\  - ${pair#*:}" "$file"
	else
		sed -i "1i recipes:\\n  - ${pair#*:}" "$file"
	fi
done
if [ -d /clone/starter-theme ]; then
	mkdir -p themes/custom
	cp -a /clone/starter-theme/. themes/custom/
fi
# -v prints the trace when an install task throws, which is the only record of where
"$DRUSH" site:install -v "$PROFILE" --db-url=sqlite://sites/default/files/.ht.sqlite \
	--account-name=admin --account-pass=corpus --site-name="corpus $PROFILE" -y ${INSTALL_ARGS:-}
# a recipe-built distribution (droopler) is a bare profile until its recipes are applied
for recipe in ${RECIPES:-}; do
	case "$recipe" in
		*/*) "$DRUSH" recipe "$recipe" -y ;;
		*) "$DRUSH" recipe "/clone/recipes/$recipe" -y ;;
	esac
done
"$DRUSH" cache:rebuild
# drush reads `sqlite://sites/...` as a host and a path, so the file is found rather than assumed
DB=$(find . -path ./core -prune -o -name .ht.sqlite -print | head -1)
cp "$DB" /out/site.sqlite
ls -l /out/site.sqlite
