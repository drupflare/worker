# Reproducing Panopoly

Build [Panopoly](https://github.com/panopoly/panopoly), a Drupal 7 distribution, the way its packaging does, install it with Drupal 7's own installer, then deliver its modules to the worker through anachron. You need git, bun, Docker, PHP 8.3 or later, and the anachron repository cloned beside the worker (`git clone https://github.com/drupflare/anachron ~/drupflare/anachron`).

## How the Lane Treats a Drupal 7 Fixture

A corpus entry with `install: d7-docker` is a Drupal 7 distribution. `config/corpus-anachron.yml` sets it for Panopoly, so only a run with `--anachron` drives it. A run without that flag records the core refusal.

The lane does three things in order:

1. It builds the site in the `corpus-native-d7` image (PHP 7.4, Drush 8, MariaDB). `drush make` builds core from `drupal-org-core.make`, the profile is copied in, and `drupal-org.make` is built into the profile directory. A download that no longer exists is logged and skipped, and the record names it.
2. It runs `drush site-install` and reads the front page and the admin pages from the installed site. That is the control: a Drupal 7 site the distribution's own installer produced.
3. It copies the profile with an `.info.yml` beside every `.info` file (`anachron/bin/convert-info.php`), then uploads and enables each module the native site had enabled, dependencies first, with the delivery step the other module fixtures use.

A Drupal 7 module whose machine name is also a Drupal 11 core module (`views`, `media`, `link`) is not uploaded, because it would shadow the core module. The record names each one and lists the delivered modules that depend on them. Those modules still run their own hooks; pages they build through the missing Views, media or link API are refused, not mapped.

## Run It

```sh
cd ~/drupflare/worker
bun scripts/e2e/corpus-lane.ts --repo=panopoly --anachron=../anachron
```

The native site lands in `native/panopoly` under `CORPUS_NATIVE_DIR` (the OS temp directory by default). The build downloads about 100 projects, and a rerun reuses the finished install. `--native-only` stops after the control.

The record is written to `docs/compatibility-anachron.json`. The install row carries the control's page statuses, the downloads that failed, and how many modules were delivered.
