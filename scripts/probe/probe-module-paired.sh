#!/usr/bin/env bash
# Per-module render cost, measured PAIRED: the control render and the
# module-removed render are taken back to back on the same database lineage, so
# a slow machine drift cannot masquerade as a module's cost. The first sweep of
# this measurement drifted 57% between its first and last control and every
# per-module figure in it was inside that band.
#
#   probe-module-paired.sh <drupal-root> <route> <work-dir> <n> [module ...]
#
# Bins emptied per measured render: NONE. All bins warm; two priming renders
# with terminate() refill whatever the uninstall's cache rebuild dropped.
set -euo pipefail

ROOT="$1"
ROUTE="${2:-/}"
WORK="$3"
N="${4:-25}"
shift 4
MODULES=("$@")
HERE="$(cd "$(dirname "$0")" && pwd)"
DB="$ROOT/sites/default/files/.sqlite"
PHPSTORE="$ROOT/sites/default/files/php"
PHP="php -d opcache.enable_cli=0 -d xdebug.mode=off"

mkdir -p "$WORK"
rm -rf "$WORK/baseline-php"
cp -a "$PHPSTORE" "$WORK/baseline-php"
cp "$DB" "$WORK/baseline.sqlite"

prime() {
	$PHP "$HERE/probe-terminate.php" "$ROOT" "$ROUTE" --terminate > /dev/null 2>&1 || true
	$PHP "$HERE/probe-terminate.php" "$ROOT" "$ROUTE" --terminate > /dev/null 2>&1 || true
}

# one process, N fresh-kernel renders after 2 discarded ones; prints
# medianCpuMs<TAB>queries<TAB>bytes<TAB>status
sample() {
	$PHP "$HERE/probe-terminate.php" "$ROOT" "$ROUTE" --terminate --count --warmup=2 --n="$N" > "$1" 2> "$1.err" || true
	python3 -c "
import json,statistics,sys
try: rs=json.load(open(sys.argv[1]))['renders']
except Exception:
    print('ERR\tERR\tERR\tERR'); raise SystemExit
c=[r['handleCpuMs'] for r in rs]
print('%.2f\t%s\t%s\t%s' % (statistics.median(c), sorted({r['handleQueries'] for r in rs}), sorted({r['bytes'] for r in rs}), sorted({r['status'] for r in rs})))
" "$1"
}

printf "%-22s %9s %9s %9s   %-8s %-8s %s\n" module ctrlCpuMs afterCpuMs deltaCpuMs ctrlQ afterQ removed
for m in "${MODULES[@]}"; do
	cp "$WORK/baseline.sqlite" "$DB"
	rm -f "$DB-wal" "$DB-shm"
	rm -rf "$PHPSTORE"
	cp -a "$WORK/baseline-php" "$PHPSTORE"
	prime
	CTRL=$(sample "$WORK/p-$m-ctrl.json")
	$PHP "$HERE/probe-uninstall.php" "$ROOT" "$m" > "$WORK/pu-$m.json" 2> "$WORK/pu-$m.err" || true
	prime
	AFTER=$(sample "$WORK/p-$m-after.json")
	python3 -c "
import json,sys
m,ctrl,after,wk=sys.argv[1],sys.argv[2].split('\t'),sys.argv[3].split('\t'),sys.argv[4]
try:
    u=json.load(open(wk)); rem=','.join(sorted(u['removed'])) or ('BLOCKED' if u['error'] else 'NONE')
except Exception: rem='?'
try: d='%+.2f' % (float(after[0])-float(ctrl[0]))
except Exception: d='-'
print('%-22s %9s %9s %9s   %-8s %-8s %s' % (m, ctrl[0], after[0], d, ctrl[1], after[1], rem))
" "$m" "$CTRL" "$AFTER" "$WORK/pu-$m.json"
done

cp "$WORK/baseline.sqlite" "$DB"
rm -rf "$PHPSTORE"
cp -a "$WORK/baseline-php" "$PHPSTORE"
