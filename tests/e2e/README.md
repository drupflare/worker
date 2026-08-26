# e2e specs

**e2e means "needs a worker that is actually running".** That is the only thing that
distinguishes this lane, and it is borrowed from Drupal practice, where the `E2E` PHPUnit suite is
exactly the one that talks to a real external service while `Integration` uses real internals
with the outside mocked.

```bash
bun run dev                                  # in one terminal
curl "localhost:8787/migrate?site=e2e&all=1" # once, to populate the site
curl "localhost:8787/fill?site=e2e&path=/"   # once, to render the front page
CFW_E2E_SITE=e2e bun run test:e2e
```

`CFW_E2E_ENDPOINT` points it somewhere else -- a deployed worker, a preview URL. It defaults to
`http://127.0.0.1:8787`.

## The lifecycle lane

`lifecycle.spec.ts` is the one spec that needs no setup, because it performs the setup: it mints a
site name nothing has used, provisions it, migrates it, prefills it, renders it, configures it,
invalidates it, exports it and then proves a second fresh name shares nothing with it. Run it with
its own worker and its own throwaway state:

```bash
bun run test:e2e:lifecycle # boots wrangler dev on a scratch --persist-to, then deletes it
```

`scripts/e2e-lifecycle.ts` is that runner, and the reason it exists is teardown rather than
convenience. A Durable Object namespace PERSISTS: `.wrangler/state/v3/do/` was measured at 970 MB
for one namespace here, and a lifecycle run writes ~4,900 rows and renders real pages every time.
`--persist-to` puts the run's state somewhere deletable. It never touches `.wrangler/state/`,
`vendor/` or `assets/drupal/site.sqlite`.

**`helpers/lifecycle.ts` is transport-agnostic on purpose.** The same stages run over
`SELF.fetch()` inside the `workers` project, where the wasm interpreter DOES boot -- measured:
`/__migrate?all=1` plus a real `/__assemble` render completed in 766 ms under
`@cloudflare/vitest-pool-workers`, `phpBooted: true`, 12,304 bytes. So "nothing in the other lanes
ever executes PHP" (below) is a description of what `tests/helpers/serve-do.ts` chooses to stub, not
a limit of the pool.

## Why it is its own vitest project

`bun run test` is the commit gate and must be hermetic. If these specs lived in the `node`
project, the gate would depend on whether a server happened to be up, and **a gate that can be
unavailable is not a gate.** So `vitest.config.ts` declares a third project and `bun run test`
does not include it.

## Skip locally, fail in CI

`helpers/endpoint.ts` probes `/stats` first. Unreachable and no `CI` in the environment, it
skips; unreachable **with** `CI` set, it throws and names the endpoint.

That asymmetry is the entire point, and it is the `E2ETestBase` rule. A developer with
no worker running should not see red. But a CI run that quietly skipped this whole lane is
indistinguishable from one that passed it, which is how a lane stops running for months without
anybody noticing. Both directions are verified: no server gives `7 skipped`, and `CI=1` with no
server gives `1 failed` with the endpoint in the message.

There is also a spec asserting `skip === false`, which fails if the suite ever passes because
everything in it was skipped.

## What earns a place here

Only assertions that no other lane can make. `tests/integration/` already drives a **real**
Durable Object through `runInDurableObject`, so "real DO" is not the bar -- but the render is
stubbed there, so nothing in the other lanes ever executes PHP.

Each spec here pins a failure this project has shipped:

| spec                           | the failure                                                     |
| ------------------------------ | --------------------------------------------------------------- |
| never a 200 with an empty body | a zero-byte 200. A cache cannot tell it from a real page        |
| HTML closes its document       | a truncated render, which is the same failure one layer later   |
| the cache tier is named        | otherwise which tier served a response is unknowable afterwards |
| the generation is reported     | an invalidation has to be observable from outside               |
| the second request is not MISS | a cache that fills and then does not answer from itself         |

The tier vocabulary in that third one is read off `src/site.js` and `src/site-do.js`, not
assumed: the first version of the assertion was guessed, allowed five tiers, and failed
immediately against the real worker because the edge front end sets a sixth (`EDGE`) that
overwrites the Durable Object's own value.

## What does NOT belong here

- **Needs Node rather than workerd** -> `tests/node/`. That is a separate vitest project for
  oracles workerd cannot host: `node:child_process` is unimplemented there, and `node:sqlite`
  exists in neither workerd nor bun. This used to be listed as an e2e reason and is not one.
- **Needs a real Durable Object but not a running server** -> `tests/integration/`.
- **Needs a DEPLOYED worker for absolute CPU.** Still unwritten, and it is the one genuine gap.
  Per RULE 0 an absolute CPU figure comes only from `cpuTime` on deployed infrastructure,
  because in-PHP `microtime()` and JS `Date.now()` both return 0 on the edge, and `wrangler
tail` silently omits every `durableObject` event -- so it has to be read through the Workers
  Observability API. Anything added for that MUST tear down what it deploys: the account this
  was developed against carries unrelated production workers, so a probe uses a `cfw-*` name
  and is deleted immediately.

## The mail lane

`mail.spec.ts` needs an SMTP server as well as a worker. It asserts the half no other mail test
reaches: that a message LEAVES. Everything else stops at `cfw_mail_queue`.

```bash
docker compose -f docker/compose.yml up -d # GreenMail on 3025, its API on 8080
MAIL_TRANSPORT=smtp SMTP_HOST=127.0.0.1 SMTP_PORT=3025 SMTP_TLS=off bun run dev
CFW_E2E_SITE=e2e bun run test:e2e
```

`CFW_E2E_MAIL_API` and `CFW_E2E_MAILBOX` point it at a different rig. Without the rig the specs
skip locally and fail in CI, the same asymmetry as the rest of the lane.

## The TCP lane

`tcp.spec.ts` needs a real Redis and a real syslog collector, both in `docker/compose.yml` beside
GreenMail and pinned by digest the same way.

```bash
docker compose -f docker/compose.yml up -d redis syslog
REDIS_URL=redis://:testpass@127.0.0.1:6379/0 SYSLOG_URL=syslog://127.0.0.1:5514 bun run dev
CFW_E2E_SITE=e2e bun run test:e2e
```

The redis assertion is the ROUND TRIP rather than the reply. `/tcp` asks from PHP, drains, and asks
again, because the tier is cached-or-deferred by construction: the first ask must refuse and queue,
the second must carry the value. Checking only the second would pass on a synchronous implementation
that cannot exist here.

`CFW_E2E_SYSLOG_HOST` and `CFW_E2E_SYSLOG_READBACK` point it at a different collector; the readback
port is a second listener that cats the ingest log, which is how the record is read back.

## The identity lane

`oidc.spec.ts` needs a real identity provider. Keycloak is in `docker/compose.yml` beside the rest,
pinned by digest, and imports `docker/keycloak-realm.json` at start.

```bash
docker compose -f docker/compose.yml up -d keycloak
bunx wrangler dev -c wrangler.jsonc --var PW_DIAGNOSTICS:1 --var OIDC_CLIENT_SECRET:drupflare-rig-secret
curl -X POST "localhost:8787/setup/oidc?site=e2e&action=save" \
  -d "issuer=http://127.0.0.1:8081/realms/drupflare&clientId=drupflare-worker"
CFW_E2E_SITE=e2e bun run test:e2e
```

It drives the authorization-code flow the way a browser does: the redirect out, Keycloak's own login
form, the credential POST, the redirect back, and an RS256 signature checked against the JWKS
Keycloak published. Every other test of this tier verifies a token this repo minted, which proves
the checks fire and says nothing about whether the routes are reachable.

The realm carries a **second** client. Two clients of one provider is what makes the audience refusal
a real test: a token Keycloak genuinely signed for `drupflare-other` must not log anyone in here, and
the same token verifying for its own client is the control that proves the refusal is the audience
check rather than the signature failing.

`CFW_E2E_OIDC_ISSUER`, `CFW_E2E_OIDC_CLIENT`, `CFW_E2E_OIDC_OTHER_CLIENT`,
`CFW_E2E_OIDC_OTHER_SECRET`, `CFW_E2E_OIDC_USER` and `CFW_E2E_OIDC_PASSWORD` point it at a different
provider.

**Loopback is why a local provider works at all.** `endpointUsable()` refuses plain http everywhere
except loopback, which a deployed Worker has no way to reach, so the exemption cannot widen anything
in production.

## The git lane

Two files, and the split is which end they drive.

`git.spec.ts` is here because it goes through a **running worker**: it adds a remote at `/git`, pulls
it, and asserts the module was mounted and a commit status written back. That is the route an operator
uses, and nothing covered it against a real server.

```bash
docker compose -f docker/compose.yml up -d gitea forgejo
CFW_E2E_SITE=e2e bun run test:e2e
CFW_E2E_FORGE=forgejo CFW_E2E_FORGE_URL=http://127.0.0.1:3400 CFW_E2E_SITE=e2e bun run test:e2e
```

`tests/node/git-forge.spec.ts` and `tests/node/git-gitlab.spec.ts` drive `src/ops/git-*.ts` straight
at the server with no worker involved, which is what proves the transport and each provider's API.
They live in the `node` project because they need `node:child_process` and a real `git` binary.

## The forge lane

`tests/node/git-forge.spec.ts` takes its server as a parameter, so one file covers both forges.

```bash
docker compose -f docker/compose.yml up -d gitea forgejo
bunx vitest run --project=node tests/node/git-forge.spec.ts
CFW_E2E_FORGE=forgejo CFW_E2E_FORGE_URL=http://127.0.0.1:3400 \
  bunx vitest run --project=node tests/node/git-forge.spec.ts
```

`CFW_E2E_FORGE` names both the compose service and the admin CLI inside it;
`CFW_E2E_FORGE_CONTAINER` overrides the container name when it is not `drupflare-worker-<forge>-1`.
Running it against both is what shows the code is not fitted to one of them.
