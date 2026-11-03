# Reproducing Thunder

Rebuild the Thunder result on your own machine: install the distribution, land its database in the worker, and score it. [Thunder](https://github.com/thunder/thunder-distribution) is one of the Verified codebases on the [fixtures page](https://drupflare.com/fixtures). You need git, bun, Docker, and PHP 8.3 or later with composer.

## Set Up the Worker

Install drangler, and hydrate the worker so it can run:

```sh
bun add -g @drupflare/drangler
mkdir ~/drupflare && cd ~/drupflare
git clone https://github.com/drupflare/worker
cd worker && bun install && bun run hydrate
```

## Install Thunder

Install Thunder the way a server already runs it. The database is a SQLite file inside the project:

```sh
composer create-project thunder/thunder-project ~/thunder --stability dev --no-interaction
cd ~/thunder
vendor/bin/drush site:install thunder --db-url=sqlite://sites/default/files/.ht.sqlite \
  --account-name=admin --account-pass=change-me -y
```

The fixture pins the profile at commit `50686db`. To match it exactly, check that commit out of `thunder-distribution` and copy it over `~/thunder/docroot/profiles/contrib/thunder` before the install.

## Land the Database and Start the Worker

```sh
cd ~/drupflare/worker
drangler migrate install --db ~/thunder/docroot/sites/default/files/.ht.sqlite --repack
drangler dev --port 8787
```

## Claim the Site and Send the Code

In a second terminal, claim the site, then send the packages and the profile:

```sh
cd ~/drupflare/worker
drangler site claim http://localhost:8787 --title Thunder
export DRUPFLARE_OWNER_TOKEN=<the owner token the claim printed>
drangler build --project ~/thunder --site http://localhost:8787 --yes
drangler modify upload --dir ~/thunder/docroot/profiles/contrib/thunder --site http://localhost:8787 --yes
drangler site updb http://localhost:8787 --steps 200 --no-snapshot --yes
```

Then open `http://localhost:8787/`. Thunder sets its front page to the login form, so you land on `/user/login`; sign in as `admin` with the password the claim printed. `/admin/modules` lists Thunder's modules as enabled, `/node/add/article` creates content, and `/admin/reports/status` shows the site's requirements. `drangler status http://localhost:8787` reports the same site from the command line.

## Run the Fixture

The fixture run does all of this with one command, and scores the 13 capabilities afterwards:

```sh
cd ~/drupflare/worker
CORPUS_PLAN=paid bun scripts/e2e/corpus-lane.ts --repo=thunder --keep
```

It needs Docker running and the drangler repository cloned beside the worker (`git clone https://github.com/drupflare/drangler ~/drupflare/drangler`). The dev server it starts is at `http://localhost:8840`. Thunder's native build lands in `native/thunder`, the scored row is written to `docs/architecture/compatibility.md` and `docs/compatibility.json`, and `--keep` leaves the site's state under `/tmp/cfw-corpus-thunder-*` so you can start it again and look around.
