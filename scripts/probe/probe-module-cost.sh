#!/usr/bin/env bash
# Per-module render cost for the standard profile: uninstall one module (plus its
# dependents), re-warm the caches, then price the same anonymous render.
#
#   probe-module-cost.sh <drupal-root> <route> <work-dir> [module ...]
#
# Bins emptied per measured render: NONE. Every bin is warm; the priming passes
# below refill whatever the uninstall's cache rebuild dropped. The control case
# runs first and last so drift is visible rather than assumed.
set -euo pipefail

ROOT="$1"
ROUTE="${2:-/}"
WORK="$3"
shift 3
MODULES=("$@")
HERE="$(cd "$(dirname "$0")" && pwd)"
DB="$ROOT/sites/default/files/.sqlite"
PHPSTORE="$ROOT/sites/default/files/php"
PHP="php -d opcache.enable_cli=0 -d xdebug.mode=off"

mkdir -p "$WORK"
rm -rf "$WORK/baseline-php"
cp -a "$PHPSTORE" "$WORK/baseline-php"
cp "$DB" "$WORK/baseline.sqlite"

measure() {
	local label="$1"
	# two priming processes with terminate(), so the collector entries and every
	# other bin are populated before anything is timed
	$PHP "$HERE/probe-terminate.php" "$ROOT" "$ROUTE" --terminate > /dev/null 2>&1 || true
	$PHP "$HERE/probe-terminate.php" "$ROOT" "$ROUTE" --terminate > /dev/null 2>&1 || true
	: > "$WORK/m-$label.tsv"
	for i in 1 2 3; do
		$PHP "$HERE/probe-terminate.php" "$ROOT" "$ROUTE" --terminate --count --warmup=2 --n=6 > "$WORK/m-$label-$i.json" 2> "$WORK/m-$label-$i.err" || true
		python3 -c "
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: sys.exit(0)
for r in d['renders']:
    print('\t'.join(str(x) for x in [r['handleQueries'], r['handleCpuMs'], r['handleMs'], r['bytes'], r['status'], r['x-drupal-dynamic-cache']]))
" "$WORK/m-$label-$i.json" >> "$WORK/m-$label.tsv"
	done
	python3 -c "
import statistics,sys
try:
    rows=[l.split('\t') for l in open(sys.argv[2]).read().strip().split('\n') if l]
except Exception:
    rows=[]
if not rows:
    print('%-24s NO DATA' % sys.argv[1]); sys.exit(0)
c=[float(r[1]) for r in rows]; q=[int(r[0]) for r in rows]
print('%-24s cpuMs med=%6.2f mean=%6.2f  q=%-6s bytes=%-7s status=%s n=%d' % (
    sys.argv[1], statistics.median(c), statistics.mean(c), sorted(set(q)),
    sorted(set(r[3] for r in rows)), sorted(set(r[4] for r in rows)), len(c)))
" "$label" "$WORK/m-$label.tsv"
}

reset() {
	cp "$WORK/baseline.sqlite" "$DB"
	rm -f "$DB-wal" "$DB-shm"
	rm -rf "$PHPSTORE"
	cp -a "$WORK/baseline-php" "$PHPSTORE"
}

reset
measure "control-first"

for m in "${MODULES[@]}"; do
	reset
	$PHP "$HERE/probe-uninstall.php" "$ROOT" "$m" > "$WORK/u-$m.json" 2> "$WORK/u-$m.err" || true
	python3 -c "
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception:
    print('%-24s UNINSTALL CRASHED' % sys.argv[2]); sys.exit(0)
print('%-24s removed=%-2d %s%s' % (sys.argv[2], len(d['removed']), ','.join(sorted(d['removed'])) or '-', ('  ERR: '+str(d['error'])[:110]) if d['error'] else ''))
" "$WORK/u-$m.json" "$m"
	measure "$m"
done

reset
measure "control-last"
