# WordPress Packages

A WordPress site keeps `DISALLOW_FILE_MODS` on, so no dashboard screen installs, updates, deletes or uploads a plugin or theme, and none updates core. The code tree is a packed, read-only layer with nowhere for a request to write. A maintainer still adds, updates and rolls back plugins and themes, and none of it needs an engineer on the day: the host does it as a staged operation behind the owner token.

## What a Maintainer Does

| change                    | what to do                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| add a plugin or theme     | add its slug, version, archive digest, licence and declared PHP version to `config/wp-plugins.yml`, deploy, then `POST /wp-packages?op=install&slug=<slug>` |
| update one                | pin the new version in the same file, deploy, then `POST /wp-packages?op=install&slug=<slug>&version=<version>`                                             |
| undo an update            | `POST /wp-packages?op=rollback&slug=<slug>`; a second call undoes the rollback                                                                              |
| remove one                | deactivate it in the dashboard, then `POST /wp-packages?op=delete&slug=<slug>`; `rollback` brings it back                                                   |
| update WordPress core     | deliver a new WordPress pack (see Core Updates); nothing in the dashboard does it                                                                           |
| see what changed and when | `GET /wp-packages` lists the delivered packages, the receipts and the pinned registry                                                                       |

Activating and deactivating stay in the dashboard, through WordPress's own `activate_plugin()` path. Delivery makes the files available; switching a plugin on is the site owner's decision.

## The Registry

`config/wp-plugins.yml` is the trust anchor. Each package lists its kind, licence and one entry per pinned version with the SHA-256 of its archive and the PHP version it declares. `bun run gen:config` compiles it into `src/wordpress/generated/packages.ts`, and `gen:config:check` fails when the two disagree. Nothing outside the file is ever downloaded, and no request parameter waives the digest.

The archive comes from `downloads.wordpress.org` through the outbound guard, redirects included. Its SHA-256 must equal the pin. The main file's `Version` header must equal the pinned version and its `Requires PHP` header must equal the declared one, so a pin that misdescribes its archive is refused.

WordPress.org publishes no checksum for a plugin archive: a `.sha1` and a `.md5` beside `classic-editor.1.7.0.zip` both answered 404 (measured with HTTP HEAD requests, 2026-11-21). The pin is therefore recorded by whoever adds the version, from an archive they fetched and read.

### What a Mirror Would Change

The default is this registry reading from wordpress.org, with no mirror built. A mirror under our control would store each archive after review and serve it from a stable address, so an update would no longer wait on wordpress.org being reachable or on a deploy: the pin list could live beside the mirror and change at runtime. It would also remove the dependence on wordpress.org keeping an old version online. It costs a reviewed publishing step per release and a store to keep. Which one ships is Gregory's decision.

## Staged Operations and Receipts

An install runs the download, the digest check, the archive rules and the header checks before it writes anything. The write is one Durable Object transaction: the file rows, their sealed integrity records, the manifest and the receipt commit together. A failure at any earlier step, or inside the transaction, leaves the old version mounted and no row of the new one that anything reads. Rows of a generation the manifest does not name are removed by the next delivery, which cleans up after a crash.

A package keeps two generations, the active one and the previous one. The next boot mounts the active generation over the base tree, one file at a time on first open, and drops any folder of the same name from the pack first, so a file the new version no longer ships is gone too. Each file is hashed against its sealed record when it is first opened on a claimed site, and a file that does not match reads as empty.

Every operation leaves a receipt: the operation, the package, the version and archive digest before and after, the file count and a note. Receipts are rows in `cfw_wp_receipt`, newest first on `GET /wp-packages`, and `POST /wp-packages` calls are recorded in the owner audit log.

| operation  | receipt says                                                           |
| ---------- | ---------------------------------------------------------------------- |
| `install`  | no earlier version, the pinned version and digest                      |
| `update`   | the active version and digest replaced, and the new ones               |
| `rollback` | the version it left and the one it restored                            |
| `delete`   | the version removed, and that the package's uninstall hook was not run |

### Uninstall Hooks Are Refused

Delete does not run a package's `uninstall.php` or its `register_uninstall_hook` callback. WordPress runs those only when it deletes the files itself, which this site never lets it do, and the host will not run code a package chooses with write access to every table at removal time. The package's options and tables stay, which also lets `rollback` restore a working package. The receipt carries the note. Delete refuses a package that WordPress still has active, because the next request would fail on a missing file.

## Archive Rules

Every archive is held to these rules before any file is expanded. The directory is read first, so names, types, counts and declared sizes are judged without inflating anything. Each file is then inflated into a buffer one byte over its declared size and compared with it, so a header that understates its data fails instead of growing memory. The limits are chosen values, not measured ones.

| rule                      | refused                                                                  | why                                                   |
| ------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| `path-traversal`          | a `..` segment                                                           | a file written outside the package folder             |
| `absolute-path`           | a name starting with `/`                                                 | the same                                              |
| `drive-letter`            | a name starting with `C:`                                                | the same, on a Windows-made archive                   |
| `backslash`               | a backslash in a name                                                    | some tools read it as a separator                     |
| `invalid-name`            | an empty name, a control character, or a name that is not UTF-8          | names must be unambiguous                             |
| `symlink`                 | a unix symlink entry                                                     | it can point a later read at any file                 |
| `device-entry`            | a device, pipe or socket entry                                           | nothing a plugin ships should be one                  |
| `duplicate-name`          | the same name twice                                                      | which one wins depends on the reader                  |
| `case-collision`          | names that differ only in case                                           | the same file on a case-insensitive reader            |
| `encrypted`               | an encrypted entry                                                       | it cannot be checked                                  |
| `unsupported-compression` | any method except stored and deflate                                     | only those two are read                               |
| `zip64`, `not-a-zip`      | zip64, a multi-disk archive, a truncated or malformed one                | the reader does not trust what it cannot parse        |
| `overlap`                 | two entries sharing bytes                                                | the overlapping-entry bomb                            |
| `archive-too-large`       | more than 20 MiB compressed                                              | a plugin that size will not fit the object's budget   |
| `too-many-entries`        | more than 1,500 entries                                                  | each file is a row written                            |
| `entry-too-large`         | a file over 2,000,000 bytes expanded                                     | a row holds at most 2,199,995 bytes                   |
| `expanded-too-large`      | more than 20 MiB expanded in total                                       | the same budget                                       |
| `ratio`                   | expansion over 100 to 1, per file above 64 KiB and for the whole archive | a bomb; legitimate text and images stay well under it |
| `size-mismatch`           | a header whose size differs from the data                                | the header cannot be trusted to bound the work        |
| `layout`                  | not exactly one top-level folder named for the package                   | the folder is the package's identity                  |
| `php-outside-folder`      | a PHP file beside the folder                                             | it would sit where WordPress loads from               |

Hidden paths and `node_modules` are left out and listed as skipped. The central directory names are the only ones used; a local header that disagrees is ignored.

## Core Updates

Core is part of the packed tree, so a core update is a new WordPress pack delivered by the platform, not a write to the tree. This page does not build that delivery for WordPress. What exists: the pack and its reconciliation for the Drupal path, and the host's pack build for WordPress (`bun run assets:wordpress`). Delivering a new WordPress pack to a running site is not built.

The dashboard says so on every screen that could have offered a write:

- `update-core.php`, `update.php`, `plugin-install.php` and `theme-install.php` answer with 200 and a page that names the running version, says the files are read-only, and points to `/wp-packages`. They carry no form and no button.
- WordPress's own notice for an available update is removed, since it tells a user without the update capability to notify an administrator. An administrator sees one line instead: the available version, and that the platform applies core updates.
- Site Health replaces its core version test with one that reports the same facts, with status `recommended` when a newer version is known.

The version check still runs on WordPress's schedule through the outbound budget, so the offer shown is the real one.

## Multisite Is Refused

WordPress Multisite is not supported. Each site has its own database and one pinned address, so one WordPress install cannot hold a network of sites. Create a separate site for each.

- The boot never defines `MULTISITE`, `WP_ALLOW_MULTISITE` or any network constant.
- `network.php` (Network Setup) answers 501 with the refusal. `wp-signup.php`, `wp-activate.php` and `wp-admin/network/` answer the same.
- The config builder refuses a constant set through its `constants` input if it is `MULTISITE`, `WP_ALLOW_MULTISITE`, `SUBDOMAIN_INSTALL`, `DOMAIN_CURRENT_SITE`, `PATH_CURRENT_SITE`, `SITE_ID_CURRENT_SITE`, `BLOG_ID_CURRENT_SITE`, `NOBLOGREDIRECT` or `SUNRISE`, in any letter case. Nothing passes `constants` yet; the input exists so the refusal is enforced where an owner-set constant would enter.

## Tested With Classic Editor

Classic Editor 1.6.7 and 1.7.0 are pinned in the registry and run through a local `wrangler dev` site in a browser spec (`tests/e2e/browser/wordpress/site.pw.ts`). The spec installs 1.7.0 through `/wp-packages`, activates it from the Plugins screen, and checks that `post-new.php` shows the classic editor in place of the block editor. It then installs 1.6.7 as an update, rolls back to 1.7.0, and deactivates the plugin to bring the block editor back. The archive is fetched from wordpress.org by the site and is not stored in the repository. After an activation the browser lands on the Plugins list without an `activate=true` parameter in the address, so the spec reads the row class and the notice instead; the cause is not yet traced.

## What Is Not Built

- A dashboard button for any of this. The operations exist behind the owner route and are tested.
- Delivering a new WordPress core pack to a running site.
- A mirror of wordpress.org.
- Deployed readings of any of it: the rows and CPU a delivery and a boot with an overlay cost on a deployed object are not measured.
