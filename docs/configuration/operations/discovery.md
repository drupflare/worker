# Discovery Document

A Drupal site answers `GET /.well-known/drupflare` with one JSON document that tells the dashboard what the site can do: its settings, the routes the dashboard may call, its limits and the release it runs. The route takes the owner token. Without it the site answers 401, as every owner route does, and the document is never cached (`cache-control: no-store`).

A site that runs WordPress answers 404, because the format has no kind for it. The dashboard reads a 404 as "this site publishes no document".

## What the Document Holds

| field              | value                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `v`                | `1`, the format version                                                                       |
| `kind`             | `drupal`                                                                                      |
| `version`          | `null`; the dashboard registers a release by id, so the build states no version               |
| `releaseId`        | the platform's version id from `CF_VERSION_METADATA`, or `unknown` when the binding is absent |
| `schemaVersion`    | the `schema.version` field of `package.json`                                                  |
| `capabilities`     | an empty list; the worker holds no capability list                                            |
| `settings`         | `schema`, `values`, `provenance`, `writable` and `etag`, described below                      |
| `routes`           | the owner routes with a stated method and class                                               |
| `redirects`        | an empty list; the dashboard keeps its own                                                    |
| `healthVocabulary` | `ok`, `info`, `warn`, `error`, `critical`                                                     |
| `limits`           | `fillQueueMax`, `edgePlanEntries`, `edgePlanBytes` and `maxUploadBytes`                       |

`maxUploadBytes` is the effective upload ceiling, and `0` means it is off.

## Settings

`settings` carries one entry for each name on `KV_OVERRIDABLE`, and nothing else. No secret, credential or deploy-time variable outside that list can appear in it.

- `schema` is a JSON Schema for each lever, built from its domain: an integer with `minimum`, `maximum`, and where the lever has them `default`, `x-unit` and `x-marks`; a flag as the strings `0` and `1`; an enum with its values; any other lever as a string. Each also carries `title` (the lever name) and an `x-ui` object.
- `values` holds the value in force. An integer lever is a number; a lever with no value is `null`.
- `provenance` is `kv`, `var` or `default` for each lever, as `GET /settings` reports its source.
- `writable` is `kv` for each lever when the site has a writable `CONFIG_KV` binding, and empty when it has not.
- `etag` is the tag `GET /settings` sends, so a write can send it in `If-Match`. It changes when any lever or the plan changes.

`x-ui` always holds `group` and `permission`, which are `security` for a lever on `OWNER_ONLY_LEVERS` and `runtime` for every other. The lever type decides `widget`: an integer with marks is a `lever-slider` and a rules lever is `json`. The only hand-written hint is `danger`, set on `CSP_MODE`. These live in `src/ops/discovery.ts` beside the generator, because one entry does not justify a config file. No lever states a plan gate.

## Routes

Each entry has an `id`, a `method`, a `path`, a `class` and `auth`, which is `owner-token` for all of them. The class follows the repair table on [Operations Settings](index.md): `safe` changes nothing a visitor sees, `rebuild` discards derived state that returns on its own, and `stateful` changes what the site serves. A route whose methods the operations page does not state is left out of the list rather than guessed.

## Release Schema

`package.json` carries `schema: { version, accepts }`. `version` is the data schema a release leaves a site at, and `accepts` is the oldest schema it accepts, which a rollback target must satisfy. Both are whole numbers and `accepts` cannot exceed `version`. `version` must equal the pack version that the reconcile steps end on, and a spec fails when a new step moves one without the other. Both are 7 today, which means a release accepts only sites already at its own schema.
