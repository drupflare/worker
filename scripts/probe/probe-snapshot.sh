#!/usr/bin/env bash
# Dumps every cache bin's row count and cid list from a Drupal sqlite file.
#   probe-snapshot.sh <sqlite-file> <out-dir>
# Writes <out-dir>/counts.txt and <out-dir>/cids-<bin>.txt
set -euo pipefail

DB="$1"
OUT="$2"
mkdir -p "$OUT"
: > "$OUT/counts.txt"
: > "$OUT/all-cids.txt"

BINS=$(sqlite3 "$DB" "select name from sqlite_master where type='table' and name like 'cache\_%' escape '\\' order by name;")

for t in $BINS; do
	c=$(sqlite3 "$DB" "select count(*) from \"$t\";")
	printf "%-28s %s\n" "$t" "$c" >> "$OUT/counts.txt"
	sqlite3 "$DB" "select cid from \"$t\" order by cid;" > "$OUT/cids-$t.txt"
	sqlite3 "$DB" "select '$t' || '|' || cid from \"$t\" order by cid;" >> "$OUT/all-cids.txt"
done

for t in cachetags semaphore watchdog router key_value; do
	if sqlite3 "$DB" "select name from sqlite_master where type='table' and name='$t';" | grep -q .; then
		c=$(sqlite3 "$DB" "select count(*) from \"$t\";")
		printf "%-28s %s\n" "$t" "$c" >> "$OUT/counts.txt"
	fi
done

sqlite3 "$DB" "select name from key_value where collection='state' order by name;" > "$OUT/state-keys.txt"
