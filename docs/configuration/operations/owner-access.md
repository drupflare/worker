# Owner Access and Audit

How an owner recovers a lost token and how owner actions are logged.

## Owner Token Recovery

The owner token is shown once, at the claim. `POST /recover-token` gives it back to anyone who can
write the deployment's `CONFIG_KV` namespace, which means anyone who can already redeploy the worker
with `PW_DIAGNOSTICS=1` and read it through `/sql`. The proof is no weaker than the token.

```sh
drangler recover-token https://mysite.example --store
```

`--store` saves the recovered token in the system keychain, or in the global config on a machine
with no keychain.

The client mints a nonce (32 random bytes, base64url, 43 characters) and writes
`recover:<host>:<sha256 hex of the nonce>` to `CONFIG_KV` with a 60-second TTL, KV's minimum. The
value is `{"host": "<host>", "exp": <epoch ms>}`. It then posts `{"nonce": "<nonce>"}` to the site. The
nonce appears only in that body; KV, wrangler's argv and the logs see its hash.

The route is public, since the caller has no token, and it is answered in the front worker like
`/settings`. The front worker reads the failure budget before it touches the object, then hops to
`/__recover-token`, which does the rest:

1. read `recover:<request host>:<sha256(nonce)>` from `CONFIG_KV`; missing is a 404;
2. refuse a record whose `host` is not the request host (403), whose `exp` has passed (410), or whose
   `exp` is more than two minutes ahead (400), since KV's TTL, not the writer's clock, is the limit;
3. add the record to the spent table in `cfw_meta` (`recover_spent`) with no `await` between the check
   and the write, so two racing requests spend it once; a spent record is a 410;
4. delete the KV record, best effort;
5. answer `{ "ok": true, "ownerToken": "..." }` with `cache-control: no-store`, or 409 if the site has
   no token yet.

| status | `reason`     | counts as a failure | the client                         |
| ------ | ------------ | ------------------- | ---------------------------------- |
| 200    |              | clears the budget   | prints the token                   |
| 400    | `malformed`  | yes                 | stops                              |
| 403    | `wrong-host` | yes                 | stops                              |
| 404    | `unknown`    | yes                 | retries; KV may not have it yet    |
| 409    | `unclaimed`  | no                  | stops; run `site claim`            |
| 410    | `spent`      | yes                 | stops; run the command again       |
| 429    | `rate`       | n/a                 | stops; `retry-after` says how long |
| 501    | `no-kv`      | no                  | stops; the deployment has no KV    |

The spent table is in the object, not in KV. A deleted KV key can be served for another minute at a
different colo, so a replay inside that window would find the record. The object is
strongly consistent, which makes it the only place single use can be enforced. The KV delete is
tidiness.

A recovery never mints. The route reads `owner_token` and never calls `ensureOwnerToken()`,
which mints on a miss. A recovery on an unclaimed site would otherwise claim it for whoever holds KV
access. The proof is spent in that case, and the client names `drangler site claim`.

The failure budget is the owner check's. `OWNER_FAIL_LIMIT` in `src/ops/admin-session.ts`: 12
failures per 60 seconds, per isolate, keyed on `cf-connecting-ip`, checked before the hop and shared
with the owner check and the sign-in form. A 404 counts because KV is eventually consistent and a
fresh record can miss, so the client paces its retries (growing pauses, at most eight attempts) to
stay under it. The budget removes the object-request cost of guessing. Guessing a 256-bit nonce was
never the threat.

Limits worth knowing:

- Edit rights on the `CONFIG_KV` namespace are owner-equivalent. A token scoped to "Workers KV
  Storage: Edit" is enough. In a managed deployment the operator owns the namespace and can already
  read every object, so tenants must never hold KV API access.
- A client clock more than about a minute behind the worker's makes `exp` already past (410).
- A recovery rotates the token. The site keeps only a hash, so it cannot return the old token; the
  answer carries a new one with `rotated: true` and the old one stops working. Whatever else holds
  the old token has to store the new one.
- A local `wrangler dev` site has local KV, which the Cloudflare API cannot write; the route is
  meant for a deployed site.

## Rotating the Token

`POST /rotate-token` with the current owner token issues a new one and refuses the old one from then
on. It answers `{"ok": true, "ownerToken": "...", "rotated": true}` once, with `cache-control:
no-store`; the site stores only the hash. Without a valid token it answers 401, a `GET` answers 405,
and a replica answers 409 and changes nothing. The entry in the audit log carries the first 8
characters of the hash of the token that asked, recorded before the old token stops matching.

## Owner Audit Log

The object records every owner call that changes state or reads a secret, and `GET /audit` returns
the log. A call is recorded when it carries the owner token and reaches one of these: `/install`,
`/install-lock` (POST and DELETE), `/enable`, `/modify`, `/restore`, `/restore-parts` (`begin`, `commit` and `abort`), `/export`, `/offloaded` (the
listing, and a read of a `private://` file), `/migrate`, `/bump`, `/invalidate`, `/pitr` (POST),
`/updb` (POST), `/reconcile` (POST), `/recycle` (POST), `/ledger-gc` (POST), `/strata-config` (POST), `/strata-store` (POST), `/uninstall` (POST, except `?dry=1`), `/theme-default` (POST), `/rotate-token`, `/db-console` (POST), `/admin-password` (POST), `/file` (PUT), `/writemark` (POST and DELETE), `/writechanges?body=1`,
`/firstrun?force=1`, `/git` with any action but `list`,
`check`, `branches`, `prs`, `diff` and `status`, `/queue?action=drop`, `/ops` with an `op`, the
`/setup/*` pages when they write, `/health?clear=1`, and a `/settings` write. A token recovery is
recorded with the actor `proof`, since it presents no token. Reads and polling (`/serve-stats`,
`/health`, `/queue?action=list`) are not, and neither is a call with no valid owner token.

An entry is `{seq, at, route, method, status, actor, prev, hash}`. `actor` is the first 8 hex
characters of the SHA-256 of the presented token, and `hash` is the SHA-256 of `prev` followed by
the entry's JSON without its hash, keys in that order. The route carries only `action`, `force`,
`secrets`, `all`, `op`, `clear` and `replace` from the query. A `/strata-store` entry also carries
`bucket` and the first 6 characters of `accessKeyId`, plus `enable=1` when the body asked for it, and
never the secret. The log lives in `ctx.storage` key-value storage,
which the SQL bridge cannot read or write (the platform reserves the `_cf_` tables behind it), as a
ring of the last 1,000 entries, a head pointer, and the hash of the last entry the ring dropped.
Each entry costs two key-value writes, three when it overwrites an older one.

`GET /audit` answers `verified` and, when the chain breaks, `firstBadSeq`. `drangler audit --verify`
recomputes the chain on the caller's machine and does not use that field. Every appended entry also
writes `{"audit":{"seq":N,"hash":"..."}}` to Workers observability, which a site-level attacker
cannot rewrite.

Failed token checks are a count (`failedAttempts`, kept in memory and written with the next entry
or read), never an entry: a row per attempt is the amplification the failure budget removes.

Limits:

- Whoever holds the Cloudflare account can edit Durable Object storage, so the log is evidence
  against an attacker on the site and not against the account holder.
- A point-in-time restore rewinds the key-value table with the database, and the object cannot
  append after the rewind, so no `restore` entry is written for it. Compare the head against the
  anchor in observability: the `/pitr` entry's `seq` and `hash` there are the pre-restore head.
- A call made with `PW_DIAGNOSTICS=1` and no owner token, and the internal calls that carry none
  (provisioning, the claim), are not recorded.
