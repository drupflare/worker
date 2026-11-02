# Runtime Overrides

The names on `KV_OVERRIDABLE` can be overridden from the `CONFIG_KV` namespace under the key
`settings`, as one JSON object. One key covers them all: a single read is atomic, costs one of the
100,000 daily KV reads instead of one per lever, and gives an operator one place to see every
override in force.

```json
{ "RENDER_BUDGET_MS": 4000, "FILL_BATCH_SIZE": 8, "PREFILL": "0" }
```

## Reading and Writing Overrides

`GET /settings` reports every lever with its value and its source (`kv`, `var` or `default`);
`PUT /settings` merges a JSON patch. Both take the owner token.

```sh
curl -H "authorization: Bearer $OWNER_TOKEN" https://your-site/settings
curl -X PUT -H "authorization: Bearer $OWNER_TOKEN" -H 'content-type: application/json' \
  -d '{"RENDER_BUDGET_MS": 4000, "PREFILL": "0"}' https://your-site/settings
```

An unlisted name is refused and named in the reply rather than dropped in silence. The allow-list is
enforced at the writer as well as the reader: a reader-side filter makes an unlisted name inert, and a
writer-side filter makes it unstorable.

The route is answered by the front Worker with no object hop: `CONFIG_KV` is a front-Worker binding,
so reaching it through the Durable Object would spend a request to get at a namespace the isolate
already holds.

## From Drupal, Without the Owner Token

The same levers are editable at `/admin/config/drupflare/settings`, gated on the
`administer drupflare site` permission. Each field holds the stored override, with the deployed value
beside it and its source named, so an operator can tell an override they chose from a default nobody
has looked at. Only the fields that changed are sent, because a patch carrying every field would turn
a deployed value into a stored override by the act of pressing save.

Every lever has a domain, `LEVER_DOMAINS` in `src/ops/plan.ts`: a flag is `0` or `1`, a number has
the range its reader clamps to, and a fixed choice (`OPCACHE_MODE`, `MAIL_TRANSPORT`,
`SITE_LOCATION_HINT`) is one of its listed values. The form offers a select or a bounded number
field from it, and `writeSettings()` refuses a value outside it and names the reason, so a mistyped
value cannot reach a reader. `LAZY_FS_BUDGET_BYTES` accepts values up to 8 MiB.

## The Three Permissions

| permission                   | reaches                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `view drupflare status`      | the runtime status page, read only                             |
| `administer drupflare site`  | the levers, and the operations terminal's cache and queue work |
| `administer drupflare owner` | code delivery, including the terminal's `en` and package lines |

`administer drupflare owner` is granted at claim, through a `Site Owner` role given to the claimed
account, and only an account that already holds it can grant it. Holding `administer permissions` is
not enough: the permission forms disable its checkboxes, and a role or user save that adds or removes
it is put back when the acting user lacks it. An administrator role carries every permission, so
assigning one is the same grant. The owner token outranks all three and works when Drupal does not.

A site created before the tiers reconciles onto them: the five older names map to the three, and
uid 1 is given the owner role.

**`PLAN` is not on that form and cannot be written through it.** Every lever there has a worst case
of a slower site; `PLAN` selects a limits profile whose quotas are account-wide, while whoever
reaches a Drupal form administers one tenant. It stays on the owner-token route above, and the host
capability behind the form refuses it at every spelling.

`/admin/modules/drupflare` is the matching read-only page for code delivery: it names the three
delivery paths and lists what has been delivered to this site. Delivering code stays an owner action
on `/_cfw/git`, for the same tenancy reason. Within the operations terminal, `en` and any package
line additionally require `administer drupflare owner`, so a site can grant the terminal without
granting the ability to add code to the runtime.

The front Worker and the Durable Object each hold their own copy of the bindings, so the overrides are
applied inside the object too. `adoptSettings()` overlays every name on the allow-list in the object,
and it runs from `alarm()` as well as `handle()`, because several levers are read on the fill chain and
an alarm never passes through `handle()`. The fast storage lane adopts nothing: it is await-free by
construction and reads no lever.

A lever is consulted from KV before its var. An operator can change a setting without a redeploy, and
the var is the fallback.

**The list is an allow-list and it is a privilege boundary.** KV is operator-writable, so merging an
arbitrary object into the environment would let anyone with KV write set `PW_DIAGNOSTICS=1`. Every
name here is a performance lever whose worst case is a slow site; none changes what is reachable.
`PLAN` has its own key, resolver and authorisation for the reason given above. The mail credentials
are absent for the same reason: `MAIL_TRANSPORT` only chooses between transports the deploy already
configured, while a KV writer who could set `SMTP_HOST` would receive every password-reset link the
site sends.

A malformed document, an unknown key and a KV error all yield no overrides, and none of them throws.
Values are read once per isolate per minute.
