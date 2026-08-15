#!/usr/bin/env bash
# Stages the asset subset an edge deploy can actually upload, into .edge-assets/.
#
# Uploading the full 48 MB assets/ tree fails with a connectivity error after ~49 s,
# so wrangler.edge.jsonc and wrangler.edge-site.jsonc point at a ~15 MB subset
# instead. That subset was assembled by hand twice; this is the third time, so it is
# a script.
#
#   bash scripts/stage-edge-assets.sh            # standard pack (assets/drupal)
#   bash scripts/stage-edge-assets.sh drupal-min # minimal pack, for the profile gap
#   WITH_SQLITE=1 bash scripts/stage-edge-assets.sh   # also stage the packed .sqlite
#   WITH_PF=1 bash scripts/stage-edge-assets.sh       # also stage the per-file (lazy) pack
#
# WITH_PF is what a deploy of the SHIPPING config needs. wrangler.jsonc sets
# LAZY_MOUNT=1, and the lazy mount reads assets/drupal-pf/core.pf.{json,bin} -- which the
# default subset does not carry, so a LAZY_MOUNT=1 deploy off the default staging throws
# "per-file pack not reachable". It costs 13 MB on top of the streaming pair; pass
# STREAMING=0 to drop the streaming pair the lazy mount will not read.
#
# The packed .sqlite is NO LONGER STAGED by default. Its only consumer was MIGRATE_DB
# opening it through PDO, and src/migrate-sql.js replays the site from assets/drupal-sql/
# in JavaScript instead. Dropping it saves 4-6.5 MB of a ~15 MB upload budget and one of
# the 50 subrequests an invocation gets. WITH_SQLITE=1 restores it for an A/B against the
# PHP engine (`/migrate?engine=php`), which also needs a binary carrying pdo_sqlite.
#
# Run before `bunx wrangler deploy -c wrangler.edge-site.jsonc`, and delete
# .edge-assets/ afterwards -- it is a copy, not a source.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_PACK="${1:-drupal}"
OUT="$ROOT/.edge-assets"

# core.json / core.bin.gz always come from assets/drupal: it is the only pack with a
# code tree, and the other packs are database-only swaps
CODE_PACK=drupal

rm -rf "$OUT"
mkdir -p "$OUT/drupal"
if [ "${STREAMING:-1}" = "1" ]; then
	cp "$ROOT/assets/$CODE_PACK/core.json" "$OUT/drupal/core.json"
	cp "$ROOT/assets/$CODE_PACK/core.bin.gz" "$OUT/drupal/core.bin.gz"
fi
if [ "${WITH_SQLITE:-0}" = "1" ]; then
	cp "$ROOT/assets/$DB_PACK/site.sqlite" "$OUT/drupal/site.sqlite"
fi
# the lazy mount's tree; prefix is fixed at drupal-pf in src/runtime/lazy-fs.ts
if [ "${WITH_PF:-0}" = "1" ]; then
	mkdir -p "$OUT/drupal-pf"
	cp "$ROOT/assets/drupal-pf/core.pf.json" "$OUT/drupal-pf/core.pf.json"
	cp "$ROOT/assets/drupal-pf/core.pf.bin" "$OUT/drupal-pf/core.pf.bin"
fi

# the migration chunks the JS engine replays; manifest.json plus NNNN.json
SQL_SRC="$ROOT/assets/${DB_PACK}-sql"
if [ ! -d "$SQL_SRC" ]; then SQL_SRC="$ROOT/assets/drupal-sql"; fi
if [ -d "$SQL_SRC" ]; then
	mkdir -p "$OUT/drupal-sql"
	cp "$SQL_SRC"/*.json "$OUT/drupal-sql/"
else
	echo "WARNING: no migration chunks at $SQL_SRC -- run scripts/pack-sql.ts first" >&2
fi
# the driver AND drupflare travel in this one file; see gen-driver-assets.ts
cp "$ROOT/assets/driver.json" "$OUT/driver.json"
if [ -f "$ROOT/assets/prefill.json" ]; then
	cp "$ROOT/assets/prefill.json" "$OUT/prefill.json"
fi

du -sh "$OUT"
echo "staged from assets/$CODE_PACK (code) + assets/$DB_PACK (database)"
