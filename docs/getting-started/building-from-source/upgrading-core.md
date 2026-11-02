# Upgrading Drupal Core

Changing the core version means replacing the Drupal tree, then rebuilding every artifact made from
it. A plain `DRUPAL_VERSION=<version> bun run build:local` re-runs the `tree` step, which refuses to
replace a tree at another version without `--force`. The steps after `tree` are keyed on their own
outputs, so they keep what is on disk unless `--force` or `--only` says otherwise.

## The Sequence

`DRUPAL_VERSION` must be set on both commands, or on neither. A forced build runs `fetch:drupal`
again, and that script reads the version from its own environment.

```sh
DRUPAL_VERSION=11.4.5 bun scripts/fetch-drupal-tree.ts --force
DRUPAL_VERSION=11.4.5 bun run build:local -- --force \
  --skip=interpreter,frame,siblings,driver,prefill
```

Four of the five skipped steps do not depend on the core version: two are the interpreter, one is
the sibling checkouts and one is the driver pack. The fifth, `prefill`, does; drop it from that list
on a real upgrade, since it re-renders the prefilled pages and a core patch can change them.

Wall clock on one development machine, six core-version swaps (median in the first row):

| measure                                           |  n  | wall clock           |
| ------------------------------------------------- | :-: | -------------------- |
| a core-version swap, end to end                   |  6  | 23-27 s, median 25 s |
| of which: tarball fetch, extract, contrib install |  6  | 8-11 s               |
| of which: reinstall, rebake, repack, recopy       |  6  | 15-16 s              |
| a from-scratch build, same steps plus `driver`    |  1  | 23 s                 |

A swap replaces about 167 MB of tree, reinstalls the build site, rebakes 23 Twig templates, repacks
11,675 files and recopies 4,028 static assets.

**Verified by artifact.** A rebuilt `assets/core/misc/ajax.js` hashed identically to the 11.4.5
reference tree and differently from 11.4.4. `assets/drupal/core.bin.gz` carried `const VERSION = '11.4.5'` and no other version string.

## What A Patch Release Moves

`scripts/tree-diff.mjs` hashes a tree and plans the objects a rollout has to move. Example, 11.4.4
to 11.4.5:

| set                                  | count |
| ------------------------------------ | ----- |
| pack objects to upload               | 209   |
| pack objects to delete               | 0     |
| fraction of the 11,024-file pack set | 1.90% |
| static assets that also change       | 2     |

The 209 are 93 `.info.yml` version stamps, 86 files under `vendor/`, 28 PHP classes under `core/`
and two `core/*.json`. **Zero `*.routing.yml`, zero `.install`, zero `config/schema/*.yml`, zero
`config/{install,optional}/*.yml`, zero `*.post_update.php` and zero `*.services.yml`**, so this
release is the code-only case, and no route, schema or config default moved.

**`tree-diff.mjs` cannot see the static half.** Its `SHIPPED` regex matches the extensions the PHP
packs carry, which leaves out `css` and `js`, because `assets:static` serves those. Diffed
separately, 11 browser-fetchable files changed, of which two match `pack-static.ts`'s own `SERVED`
set and therefore ship: `core/misc/ajax.js` and `core/misc/details.js`. Read `objectsToUpload` as the
pack half of a rollout, with the static half counted separately.

## The Two Rows Nothing Regenerates

`sql` reads `assets/drupal/site.sqlite` verbatim. Two of its prefilled rows embed the core version,
both at `expire = -1`:

| bin               | cid                    | bytes  |
| ----------------- | ---------------------- | ------ |
| `cache_discovery` | `library_info:olivero` | 89,184 |
| `cache_data`      | `fonts:olivero:...`    | 630    |

The version in them is the `?v=` cache-buster Drupal appends to every asset URL. Across repeated
core swaps, `site.sqlite` came out byte-identical to the committed one. **A core upgrade does not
change these rows**, so after a patch that changes `core/misc/ajax.js`, the site serves new bytes at
`/core/misc/ajax.js` while the query string still carries the old version.

The correction is a cache invalidation: delete both rows and Drupal rebuilds them, at the cost of one
discovery pass on the first render. `scripts/bake-collectors.php` produced them, and it is not
wired into `build:local`. It reads `<root>/sites/default/files/.sqlite`, which the `site` step does
not create (that step writes `sites/build/files/build-site.sqlite`), and it writes into the build
database, from which the rows were copied by hand into `site.sqlite`.

`bun run release:payload` builds the payload the fast route downloads and `bun run release:check`
prices the canonical config against the 64 MiB ceiling.
