#!/usr/bin/env bash
# Attributes the terminate() saving to individual collectors: start from a
# database where every collector entry IS present, then remove exactly one and
# render without terminate(), which is precisely the state a shipped cache pack
# is left in when that one entry was never persisted.
#
#   probe-collector-attrib.sh <drupal-root> <route> <work-dir> <K>
set -euo pipefail

ROOT="$1"
ROUTE="${2:-/}"
WORK="$3"
K="${4:-8}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DB="$ROOT/sites/default/files/.sqlite"
PHPSTORE="$ROOT/sites/default/files/php"
PHP="php -d opcache.enable_cli=0 -d xdebug.mode=off"

mkdir -p "$WORK"
rm -rf "$WORK/baseline-php"
cp -a "$PHPSTORE" "$WORK/baseline-php"

# a database with every collector entry persisted
cp "$DB" "$WORK/full.sqlite"
$PHP "$HERE/probe-terminate.php" "$ROOT" "$ROUTE" --terminate > "$WORK/fill.json"
cp "$DB" "$WORK/full.sqlite"

run_case() {
	local label="$1" sql="$2"
	cp "$WORK/full.sqlite" "$DB"
	rm -f "$DB-wal" "$DB-shm"
	rm -rf "$PHPSTORE"
	cp -a "$WORK/baseline-php" "$PHPSTORE"
	[ -n "$sql" ] && sqlite3 "$DB" "$sql"
	: > "$WORK/case-$label.tsv"
	for i in $(seq 1 "$K"); do
		# 2 discarded renders per process so the measured ones do not include
		# autoloading and parsing core with opcache off (~110 ms of the ~120)
		$PHP "$HERE/probe-terminate.php" "$ROOT" "$ROUTE" --count --warmup=2 --n=6 > "$WORK/c-$label-$i.json"
		python3 -c "
import json,sys
for r in json.load(open(sys.argv[1]))['renders']:
    print('\t'.join(str(x) for x in [r['handleQueries'], r['handleCpuMs'], r['handleMs'], r['bytes'], r['x-drupal-dynamic-cache']]))
" "$WORK/c-$label-$i.json" >> "$WORK/case-$label.tsv"
	done
	python3 -c "
import statistics,sys
rows=[l.split('\t') for l in open(sys.argv[2]).read().strip().split('\n')]
q=[int(r[0]) for r in rows]; c=[float(r[1]) for r in rows]; w=[float(r[2]) for r in rows]
print('%-34s q=%-4s cpuMs med=%7.2f mean=%7.2f  wallMs med=%7.2f  n=%d  dyn=%s' % (sys.argv[1], sorted(set(q)), statistics.median(c), statistics.mean(c), statistics.median(w), len(c), rows[0][4]))
" "$label" "$WORK/case-$label.tsv"
}

DEL_TRAIL="delete from cache_menu where cid like 'active-trail:%';"
DEL_LIBINFO="delete from cache_discovery where cid like 'library_info:%';"
DEL_LIBPARSE="delete from cache_file_parsing where cid='library.parsing_cache';"
DEL_THEME="delete from cache_bootstrap where cid like 'theme_registry:runtime:%';"
DEL_STATE="delete from cache_bootstrap where cid='state';"

# all-present is run first AND last: the two figures bound how much the machine
# drifted underneath the run, and any single-case delta smaller than that gap is
# not a result
run_case "all-present" ""
run_case "no-active-trail" "$DEL_TRAIL"
run_case "no-library-info" "$DEL_LIBINFO"
run_case "no-library-parsing" "$DEL_LIBPARSE"
run_case "no-library-both" "$DEL_LIBINFO $DEL_LIBPARSE"
run_case "no-theme-runtime" "$DEL_THEME"
run_case "no-state" "$DEL_STATE"
run_case "none-of-the-four" "$DEL_TRAIL $DEL_LIBINFO $DEL_LIBPARSE $DEL_THEME"
run_case "all-present-again" ""

cp "$WORK/full.sqlite" "$DB"
rm -rf "$PHPSTORE"
cp -a "$WORK/baseline-php" "$PHPSTORE"
