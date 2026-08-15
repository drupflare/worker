#!/usr/bin/env bash
# Prices the terminate() defect: K consecutive fresh-process renders in each arm
# against a database that is NOT reset between renders, which is what a sequence
# of isolate restarts against one persistent store looks like.
#
#   probe-terminate-cost.sh <drupal-root> <route> <work-dir> <K> [cold|warm]
set -euo pipefail

ROOT="$1"
ROUTE="${2:-/}"
WORK="$3"
K="${4:-10}"
MODE="${5:-warm}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DB="$ROOT/sites/default/files/.sqlite"
PHPSTORE="$ROOT/sites/default/files/php"
PHP="php -d opcache.enable_cli=0 -d xdebug.mode=off"

mkdir -p "$WORK"
rm -rf "$WORK/baseline-php"
cp -a "$PHPSTORE" "$WORK/baseline-php"
cp "$DB" "$WORK/baseline.sqlite"
if [ "$MODE" = "cold" ]; then
	for t in $(sqlite3 "$WORK/baseline.sqlite" "select name from sqlite_master where type='table' and name like 'cache\_%' escape '\\';"); do
		sqlite3 "$WORK/baseline.sqlite" "delete from \"$t\";"
	done
	sqlite3 "$WORK/baseline.sqlite" "delete from cachetags;"
fi

for ARM in noterm term; do
	cp "$WORK/baseline.sqlite" "$DB"
	rm -f "$DB-wal" "$DB-shm"
	rm -rf "$PHPSTORE"
	cp -a "$WORK/baseline-php" "$PHPSTORE"
	FLAG=""
	[ "$ARM" = "term" ] && FLAG="--terminate"
	: > "$WORK/seq-$ARM.tsv"
	for i in $(seq 1 "$K"); do
		# shellcheck disable=SC2086
		$PHP "$HERE/probe-terminate.php" "$ROOT" "$ROUTE" $FLAG --count > "$WORK/r-$ARM-$i.json"
		python3 - "$WORK/r-$ARM-$i.json" "$i" >> "$WORK/seq-$ARM.tsv" << 'PY'
import json,sys
d=json.load(open(sys.argv[1]))
r=d["renders"][0]
print("\t".join(str(x) for x in [sys.argv[2], r["handleQueries"], r["totalQueries"], r["handleCpuMs"], r["handleMs"], r["terminateCpuMs"], r["bytes"], r["x-drupal-cache"], r["x-drupal-dynamic-cache"]]))
PY
	done
	"$HERE/probe-snapshot.sh" "$DB" "$WORK/snap-$ARM"
done

cp "$WORK/baseline.sqlite" "$DB"
rm -f "$DB-wal" "$DB-shm"
rm -rf "$PHPSTORE"
cp -a "$WORK/baseline-php" "$PHPSTORE"

echo "=== mode=$MODE route=$ROUTE K=$K   (n  handleQ  totalQ  handleCpuMs  handleMs  termCpuMs  bytes  page  dynamic)"
for ARM in noterm term; do
	echo "--- $ARM"
	cat "$WORK/seq-$ARM.tsv"
done
