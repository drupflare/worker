# Updating a Site

How a deployed worker takes a new release, how an existing site keeps current, and which parts of the site an update does not cover.

## Updating a Deployed Worker

The deploy button creates a repository from this one, so your worker is a copy and not a fork, and
the two share no history. Adding this repository as a remote lets you merge later releases into it.

```bash
# one time
git remote add template https://github.com/drupflare/worker

# to install an update
git switch master
git fetch --all
git merge template --allow-unrelated-histories -m "chore: merge upstream"
```

Pushing the result deploys it, if you connected the repository to Cloudflare when you created it.
Otherwise run `bunx wrangler deploy`, or `drangler update my-site` to update the checkout and deploy
in one step.

- The `git remote add` runs once per clone.
- Switch to the branch you want to update before merging.
- `--allow-unrelated-histories` is what lets two repositories with no common commit merge at all.
- Take a backup branch first, so a merge you dislike costs nothing:

```bash
git switch -c before-template-merge
```

To take a specific release instead of the tip:

```bash
git fetch --tags template
git switch master
git merge v1.0.4 --allow-unrelated-histories -m "chore: merge template v1.0.4"
```

Your own changes are the ones that conflict, and `wrangler.jsonc` is the usual place: it carries the
worker name and the bindings you added. Resolve it in favour of your values and take the template's
side elsewhere. `-X theirs` does that in one pass when you have made no changes worth keeping.

A merge that changes `src/` or the packed modules needs a deploy to take effect. A merge that changes
the pack reaches existing sites through reconciliation, described next.

## Keeping an Existing Site Current

The pack is delivered when a site is provisioned, so a fix that lands inside it reaches new sites on
its own. Reconciliation carries the same fix to sites that already exist. Each step is an
observation of the site's end state, not a script: it is checked before the step runs and again
afterwards, so a site that already matches is marked done without doing any work, and a step that
ran without converging is reported and not assumed.

The alarm chain drives one step per firing. `drangler reconcile` shows where a site stands and which
step is stuck, and `--run` takes a step now instead of at the next firing.

```sh
drangler reconcile my-site.example       # version, every step, and its standing
drangler reconcile my-site.example --all # drive steps until the version stops moving
```

Steps that change configuration or state go through Drupal's own writers, so every cached copy of a
value is invalidated by the code that owns it. A step that changes what the compiled container holds
drops the container and any stored heap image, and the next boot rebuilds it.

## Covering the Rest of the Site

A page is rendered when a visitor asks for it, and that visitor waits. The sweep enumerates the URLs
a site actually has, from its router table and its entity tables, ranks them by observed views then
recency then depth, and queues the top of the list for the same fill batch a visitor's request would
use. It never renders, so it cannot compete with a request for the interpreter.

It runs by default and is bounded: it refuses below a remaining-budget floor, spends at most a
declared share of the day's writes, and resumes the next day when that share is gone. Left unasked it
takes the smaller share; `SWEEP` sets it explicitly in both directions, and `SWEEP=0` turns it off.
The sweep's settings are listed in [The Addressable Sweep](../configuration/operations/updates.md#the-addressable-sweep).

```sh
drangler sweep my-site.example       # coverage, and what bounded the last step
drangler sweep my-site.example --run # take a step now
```
