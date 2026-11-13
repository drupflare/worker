# Building From Source

Two commands turn a clean clone into a deployable tree, and they are not interchangeable.

| route       | command               | needs                            | takes   |
| ----------- | --------------------- | -------------------------------- | ------- |
| **payload** | `bun run hydrate`     | network                          | seconds |
| **source**  | `bun run build:local` | network, PHP, composer, node 24+ | minutes |

`bun run hydrate` takes the payload route by default and falls back to the source route when no
payload exists. `--payload-only` forbids the fallback; `--from-source` skips straight to it.

## Pages

- [The Steps](steps.md): the seventeen build steps, from the interpreter to the assets.
- [Build Order and Caching](build-order.md): why the order is fixed, what is cached, and partial rebuilds.
- [Upgrading Drupal Core](upgrading-core.md): the sequence for a core bump and what a patch release moves.

## Why Two Routes

`assets/` is generated packs and `.interp/` holds the interpreter. Both are gitignored, so a clean
checkout has neither and `wrangler deploy` has nothing to upload.

The payload route downloads them as one verified tarball. It is a plain HTTPS GET: no Docker, no
`gh` auth, no PHP, no Cloudflare credential. That is what makes the Deploy to Cloudflare button
work. Its build command is `bun run hydrate` (`build.command` in `wrangler.jsonc`), and Workers
Builds has no Docker to build with.

The source route regenerates the same bytes locally. It covers what the payload cannot: a checkout of
a commit no release was cut from, and a repository with no release yet. It produces every artifact
the payload carries, `assets/prefill.json` included.

## Where a Payload Comes From

`hydrate` tries four places and takes the first that answers, and every one of them is verified
against the `SHA256SUMS` published beside it.

| order | source                         | what it is                                    |
| ----- | ------------------------------ | --------------------------------------------- |
| 1     | `--from=<path>` or `dist/`     | a tarball on disk, which outranks the network |
| 2     | `payloads/v<version>/` on R2   | the release, mirrored to the CDN              |
| 3     | the GitHub Release             | the same bytes, canonical                     |
| 4     | `payloads/dev-<branch>/` on R2 | that branch's tip, replaced on every push     |

**The CDN copy is tried before the GitHub Release.** A Workers Builds job once stalled for its whole
timeout on a release asset download, while the same 13.4 MB restored from the CDN in seconds. The Release stays canonical and stays the fallback, so a CDN outage costs a retry
rather than a deploy.

**The dev line is tried last and never displaces a release.** It is keyed by branch: the checkout's
own branch first, then `master`. It lets a checkout on a commit no release was cut from download a
tree in seconds instead of building one with a toolchain the deploy container does not have.
`bun run build:local` is still there when you want the bytes regenerated rather than fetched.

**`--dev[=branch]` takes the dev line directly.** `bun run hydrate -- --dev=master` skips `dist/`
and every release and downloads the tip of that branch, and a bare `--dev` names the checkout's own
branch. It is for a checkout whose `package.json` already carries the next version: without it, a
release of the previous version answers first and lands older bytes under newer code. It refuses to
combine with `--from`, `--tag` or `--from-source`, since each of those names a different payload. The
bytes are a branch tip, so the next push replaces them and the run says so.

Both lines are published by CI from the tarball the release job already built, so nothing is
rebuilt to publish it. The keys come from `scripts/payload-cdn.ts`, which the resolver and the
workflows both read; `tests/node/workflows.spec.ts` fails if a workflow starts spelling a key of its
own.

## The Managed Bundle

A release also builds the bundle that `wrangler.managed.jsonc` deploys, for the dashboard's engine to
read. The release job bundles the hydrated tree with `wrangler deploy --dry-run`, and
`scripts/build-managed-bundle.ts` writes `releases/<tag>/` from that output: `manifest.json`,
`metadata.json`, one file per module, and one file per distinct asset named by the first 32 hex
characters of its sha-256. The asset list is what `assets/.assetsignore` ships, not a walk of
`assets/`. The manifest records the sha-256 and size of every module.

`scripts/publish-bundle.ts` checks the files against the manifest, uploads them to
`payloads/managed/releases/<tag>/` on the CDN, writes the manifest last, then reads every object back
and compares it. A prefix whose manifest is already live is refused. Release prefixes stay published: a
site records the release id it was built from, and an update reads that old manifest too, so nothing
deletes or renames one. With the R2 key pair in
`CLOUDFLARE_R2_KEY_ID` and `CLOUDFLARE_R2_SECRET_ACCESS_KEY` it uses the S3 endpoint: v1.0.5's 4,339
assets took 578 s (n=1). Without them it falls back to `wrangler r2 bulk put`, which reached 1,720 of
those objects in 17 minutes before one failed request ended the run.

The bundle's tarball, `drupflare-managed-bundle-<version>.tar.gz`, goes on the GitHub Release and
its checksum is a second line in `SHA256SUMS`, below the payload's. `hydrate` reads only the first
line. GitHub release assets cannot be added after a release is cut, so v1.0.5's tarball and its own
`drupflare-managed-bundle-1.0.5.SHA256SUMS` sit under `payloads/v1.0.5/` on the CDN instead.

## The Box Bundle

A release also carries `drupflare-box-bundle-<version>.tar.gz`, the Worker a bastion box runs. It is
the output of `wrangler deploy --dry-run --outdir` for `wrangler.jsonc`, with the modules at the
archive root: `site.js`, the three `.wasm` modules and the hashed `composer.lock` text module. A box
lists the top level of the unpacked archive only, so the packer, `scripts/build-box-bundle.ts`,
refuses a nested folder, a file ending the box does not load, and a module that `site.js` imports
but the archive lacks. It leaves out source maps.

The archive also carries the site's static files under `assets/`, the same set the release payload
holds for the edge: the files `assets/.assetsignore` lets through, read from the payload plan and
never from a walk of `assets/`. A box serves static files from its own state directory, and a site
with none answers 503 `pack not reachable`, so `bastion` copies this folder there when it adds the
site. `assets.manifest` at the root lists each file with its size and sha-256, and the box refuses a
tree that differs from it. The packer fails when a required asset is missing, so a short tree never
ships. The box bundle leaves out `assets/bootimage/`: `BOOT_IMAGE` is not in `wrangler.jsonc`, so a
box never opens it. The archive holds about 4,600 files, 39 MB unpacked and 26 MB packed. A baked
boot image would add 80 MB unpacked and 24 MB packed.

`box.vars` at the root holds the `vars` block of `wrangler.jsonc` as a flat json object, read when
the archive is built. A bundle carries no config, so `bastion` writes these values as the site's
bindings when it adds the site, and the site renders PHP pages. Vars that only
`wrangler.managed.jsonc` sets, such as `CACHE_API` and `FILE_STORE`, are not in the canonical block
and never reach a box.

The release job packs it from the dry-run `release:check` already runs, which `release:check` now
keeps at `dist/dry-run/wrangler`, so wrangler builds the canonical config once. Its checksum is the
last line of `SHA256SUMS`. The job that follows publishing downloads the asset and checks its sum and
that `site.js` sits at the root.

## Quick Start

```sh
git clone https://github.com/drupflare/worker.git
cd worker
bun install     # postinstall restores the interpreter from the CDN, verified by sha256
bun run hydrate # payload if there is one, source build if there is not
bun run dev
```

To see what a build would do without doing it:

```sh
bun run build:plan
```

## Prerequisites, Per Route

The payload route needs Bun and a network. Nothing else.

The source route needs each of these, and `bun run build:plan` names any that are missing before it
spends a minute:

| tool       | version | used by                | note                                              |
| ---------- | ------- | ---------------------- | ------------------------------------------------- |
| `bun`      | latest  | everything             |                                                   |
| `node`     | 24+     | `core`, `sql`, `patch` | `node:sqlite`, which Bun does not ship            |
| `php`      | 8.3+    | `site`, `twig`         | with `pdo_sqlite`, `sqlite3`, `mbstring`, `iconv` |
| `composer` | 2       | `tree`                 | the Drupal release tarball is core only           |
| `git`      | any     | `siblings`             |                                                   |
| `tar`      | any     | `tree`                 |                                                   |

Two of these run under `node` rather than `bun`. `pack-sql.ts` needs `node:sqlite`.
`pack-drupal.ts` writes `core.bin.gz` from `gzipSync(blob, { level: 9 })`, and the two runtimes do
not emit the same deflate stream for the same input, so running it under Bun would move a shipped
asset with nothing reporting it.

## Related

- [Configuration](../../configuration/index.md): every variable and binding, and what breaks when one is wrong
- [Repository Layout](../repository-layout/index.md): every path outside `src/` and how it arrives
- [Scripts](../../../scripts/README.md): why each script is in the language it is in
