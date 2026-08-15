#!/usr/bin/env bash
# Drives the terminate() experiment: two arms from an identical database, one
# render each in its own process, then diffs the cache rows.
#
#   probe-terminate-diff.sh <drupal-root> <route> <work-dir> <cold|warm>
#
# cold = every cache_* bin emptied first. warm = the database exactly as shipped.
set -euo pipefail

ROOT="$1"
ROUTE="${2:-/}"
WORK="$3"
MODE="${4:-warm}"
ORDER="${5:-noterm term}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DB="$ROOT/sites/default/files/.sqlite"
PHPSTORE="$ROOT/sites/default/files/php"
PHP="php -d opcache.enable_cli=0 -d xdebug.mode=off"

mkdir -p "$WORK"

# the compiled-Twig PhpStorage tree is a side channel between arms: if arm 1
# leaves a compiled template on disk, Twig in arm 2 loads it and never writes
# the matching cache_default row, which reads as terminate() deleting rows
rm -rf "$WORK/baseline-php"
if [ -d "$PHPSTORE" ]; then cp -a "$PHPSTORE" "$WORK/baseline-php"; else mkdir -p "$WORK/baseline-php"; fi

# a pristine baseline nobody renders against, restored before each arm
cp "$DB" "$WORK/baseline.sqlite"
if [ "$MODE" = "cold" ]; then
	for t in $(sqlite3 "$WORK/baseline.sqlite" "select name from sqlite_master where type='table' and name like 'cache\_%' escape '\\';"); do
		sqlite3 "$WORK/baseline.sqlite" "delete from \"$t\";"
	done
	sqlite3 "$WORK/baseline.sqlite" "delete from cachetags;"
fi
"$HERE/probe-snapshot.sh" "$WORK/baseline.sqlite" "$WORK/snap-baseline"

for ARM in $ORDER; do
	cp "$WORK/baseline.sqlite" "$DB"
	rm -f "$DB-wal" "$DB-shm"
	rm -rf "$PHPSTORE"
	cp -a "$WORK/baseline-php" "$PHPSTORE"
	FLAG=""
	[ "$ARM" = "term" ] && FLAG="--terminate"
	# shellcheck disable=SC2086
	$PHP "$HERE/probe-terminate.php" "$ROOT" "$ROUTE" $FLAG --count > "$WORK/render-$ARM.json"
	"$HERE/probe-snapshot.sh" "$DB" "$WORK/snap-$ARM"
done

# restore so the tree is left as it was found
cp "$WORK/baseline.sqlite" "$DB"
rm -f "$DB-wal" "$DB-shm"
rm -rf "$PHPSTORE"
cp -a "$WORK/baseline-php" "$PHPSTORE"

echo "=== mode=$MODE route=$ROUTE"
echo "--- counts: baseline | noterm | term"
paste "$WORK/snap-baseline/counts.txt" "$WORK/snap-noterm/counts.txt" "$WORK/snap-term/counts.txt" \
	| awk '{printf "%-28s %6s %6s %6s\n", $1, $2, $4, $6}'
echo "--- cids present ONLY after terminate()"
comm -13 "$WORK/snap-noterm/all-cids.txt" "$WORK/snap-term/all-cids.txt"
echo "--- cids present ONLY without terminate()"
comm -23 "$WORK/snap-noterm/all-cids.txt" "$WORK/snap-term/all-cids.txt"
