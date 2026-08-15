#!/usr/bin/env bash
# Prices each terminate()-only cache entry, PAIRED: measure with the entry
# present, delete just that entry, measure again, same database, back to back.
#
# Renders never call terminate() here -- if they did, the deleted entry would be
# written straight back and the second half of every pair would measure nothing.
#
#   probe-collector-paired.sh <drupal-root> <route> <work-dir> <n>
#
# Bins emptied per measured render: NONE. Every bin is warm; a single named cid
# is deleted per case, which is exactly the state a cache pack built without
# terminate() ships in.
set -euo pipefail

ROOT="$1"
ROUTE="${2:-/}"
WORK="$3"
N="${4:-60}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DB="$ROOT/sites/default/files/.sqlite"
PHPSTORE="$ROOT/sites/default/files/php"
PHP="php -d opcache.enable_cli=0 -d xdebug.mode=off"

mkdir -p "$WORK"
rm -rf "$WORK/baseline-php"
cp -a "$PHPSTORE" "$WORK/baseline-php"

# one terminate() render so every collector entry is present
$PHP "$HERE/probe-terminate.php" "$ROOT" "$ROUTE" --terminate > "$WORK/fill.json" 2>&1 || true
cp "$DB" "$WORK/full.sqlite"

sample() {
	$PHP "$HERE/probe-terminate.php" "$ROOT" "$ROUTE" --count --warmup=2 --n="$N" > "$1" 2> "$1.err" || true
	python3 -c "
import json,statistics,sys
try: rs=json.load(open(sys.argv[1]))['renders']
except Exception:
    print('ERR\tERR\tERR'); raise SystemExit
c=[r['handleCpuMs'] for r in rs]
print('%.2f\t%s\t%s' % (statistics.median(c), sorted({r['handleQueries'] for r in rs}), sorted({r['bytes'] for r in rs})))
" "$1"
}

pair() {
	local label="$1" sql="$2"
	cp "$WORK/full.sqlite" "$DB"
	rm -f "$DB-wal" "$DB-shm"
	rm -rf "$PHPSTORE"
	cp -a "$WORK/baseline-php" "$PHPSTORE"
	$PHP "$HERE/probe-terminate.php" "$ROOT" "$ROUTE" > /dev/null 2>&1 || true
	CTRL=$(sample "$WORK/c-$label-ctrl.json")
	sqlite3 "$DB" "$sql"
	$PHP "$HERE/probe-terminate.php" "$ROOT" "$ROUTE" > /dev/null 2>&1 || true
	AFTER=$(sample "$WORK/c-$label-after.json")
	python3 -c "
import sys
l,c,a=sys.argv[1],sys.argv[2].split('\t'),sys.argv[3].split('\t')
try: d='%+.2f' % (float(a[0])-float(c[0]))
except Exception: d='-'
print('%-24s ctrlCpuMs=%-7s missingCpuMs=%-7s delta=%-8s ctrlQ=%-6s missingQ=%-6s bytes=%s' % (l,c[0],a[0],d,c[1],a[1],a[2]))
" "$label" "$CTRL" "$AFTER"
}

pair "state" "delete from cache_bootstrap where cid='state';"
pair "theme_registry_runtime" "delete from cache_bootstrap where cid like 'theme_registry:runtime:%';"
pair "library_info" "delete from cache_discovery where cid like 'library_info:%';"
pair "library_parsing_cache" "delete from cache_file_parsing where cid='library.parsing_cache';"
pair "library_pair" "delete from cache_discovery where cid like 'library_info:%'; delete from cache_file_parsing where cid='library.parsing_cache';"
pair "active_trail" "delete from cache_menu where cid like 'active-trail:%';"
pair "all-four-terminate-only" "delete from cache_bootstrap where cid like 'theme_registry:runtime:%'; delete from cache_discovery where cid like 'library_info:%'; delete from cache_file_parsing where cid='library.parsing_cache'; delete from cache_menu where cid like 'active-trail:%';"

cp "$WORK/full.sqlite" "$DB"
rm -rf "$PHPSTORE"
cp -a "$WORK/baseline-php" "$PHPSTORE"
