# Credentials and Persistence

Drupal's database connection reaches `cfwSqlExec`, which applies no table filter, so any code that
can run SQL can read and write every table in the object. These changes move authority out of SQL.

**Sealed storage.** `ctx.storage.kv` is a separate table in the object's SQLite file that the SQL
bridge cannot read or write. Measured on a local `workerd` 1.20261012.1 (`owner-recovery.spec.ts`):
`SELECT`, `INSERT`, `UPDATE`, `DELETE` and `DROP` on `_cf_KV` all answer `SQLITE_AUTH`, from the SQL
bridge and from PHP's `cfw_sql()`; `ATTACH` and `DETACH` are denied; a view, a subquery, a table
copy and a trigger over `_cf_KV` read nothing; and a table renamed onto the name `_cf_KV` does not
become the key-value table. `sqlite_master` and `pragma_table_list` still reveal that the table
exists. The rename case is tested because Check Point reported a rename-based authorizer bypass in
2026 that Cloudflare says it fixed in production, with no date given
([Check Point](https://research.checkpoint.com/2026/when-agentic-glue-melts/), extract). The local
build refuses the rename, and the hosted fix is not independently dated, so the sealed-storage
claim on the platform is `contained` and not `removed`.

**The owner token.** Only its SHA-256 is stored, in sealed storage, and the check compares hashes
in constant time. A claim returns the token once. Recovery rotates the token, returns
`rotated: true` and the new value, and `drangler recover-token` stores the new value and lists every
place that still holds the old one. A site upgraded from a version that kept a plaintext
`owner_token` row adopts it at wake and at every alarm: the row is hashed into sealed storage and
deleted, and a sealed value always wins over a row. The git tokens, webhook secrets and Cloudflare
OAuth grant follow the same path. A restore point from before the upgrade brings the old row back
and the next wake adopts it again, so rotate through recovery after restoring to one. Verdict:
contained (Measured, `site-secrets.spec.ts`, `owner-recovery.spec.ts`, `git-remotes.spec.ts`,
falsified by mirroring the hash into `cfw_meta` and by removing rotation). Residual: a Cloudflare
account holder can read the object's storage. The keys that moved are `SEALED_META_KEYS` in `src/ops/site-secrets.ts`, and a legacy row is adopted on wake and at each alarm. The deployed check (a `SELECT` on `cfw_meta` of a live site, and a point-in-time restore) has not run.

**Export and import.** A default export carries none of these values. `/export?secrets=1` carries
the sealed values as ordinary `cfw_meta` rows (`owner_token_hash`, `cf_oauth_token`, `git_token_*`,
`git_hooksecret_*`), and an import adopts them on the next wake, so a demo or a migration keeps
working without a manual step (`serve-restore.spec.ts`, 7 cases). A dump from a pre-sealed worker
still carries the owner token in the clear.

**Module files.** `mountInstalledModules()` mounts every row of `cfw_module_file` into the
interpreter's file system on every boot, and PHP's SQL connection can write that table, so a planted
row used to survive a restart, a Drupal patch and a redeploy. On a claimed site each row is now
checked, when the file is first opened, against a SHA-256 record in sealed storage. One function,
`changeModuleFiles` in `src/do/module-files.ts`, writes records and rows together for installs,
git pulls, `/modify`, rollbacks, removals and branch switches. A row with no record or other bytes
mounts as an empty file, is counted under `moduleIntegrity` in `/__serve-stats`, and is logged once
per path. Measured on a local `workerd`: hashing 1,040 files and 6.1 MB costs 4 to 10 ms with
`node:crypto` (550 ms with the pure-JavaScript SHA-256, which is why it is not used), and first open
of every file read 42 to 46 ms claimed against 41 to 49 unclaimed (`modify-upload.spec.ts`,
falsified). Verdict: `contained`. It stays `contained` for these reasons:

- **Unclaimed sites.** Not held, because a migrated site's code arrives as rows before the claim.
  The first mount after the claim adopts the rows as they stand, so a site compromised before the
  upgrade stays compromised.
- **Replica lanes.** Not checked. A planted row on the primary still reaches them (`L`).
- **Other database-resident paths.** The compiled container row in `cache_container`,
  `unserialize` of stored data, `cfw_package_autoload`, `cfw_module_blob` until a revision applies
  it, and `/__moduleasset`, which serves a stored text file to a browser without a record check.
- **Imports.** An import brings module rows with no records, so they are refused until the owner
  redelivers the package through `/modify`, `/install` or `/git`.

**Heap images.** A boot restores a stored interpreter heap from `cfw_heap_snapshot` and
`cfw_heap_chunk` instead of booting PHP. The restore is gated by `HEAP_SNAPSHOT`, which is on unless
it is `0` or a deployment environment is set, and not by `HEAP_IMAGE`, which gates only the
producer. The digests sat in the same tables as the bytes, so code with SQL write could plant a
snapshot with matching digests and have its memory restored on the next boot. That was `open` on a
default site: with the new check bypassed, a planted row restored on the shipping configuration
(Measured, `heap-restore-autoload.spec.ts`). A SHA-256 root over the stored rows and over the
metadata that steers a restore (page index, fd table, handle table, generation, sizes) is now sealed
and verified before any byte, handle or descriptor reaches the instance, and per chunk on a sliced
restore. A planted, altered or unsealed image is refused and deleted, the site boots from the pack,
and `heapIntegrity` in `/__serve-stats` counts it. Verified restore cost: 2 to 3 ms against 71 to
72 ms of copying, local `workerd`. Verdict: `contained`. SQL write can still delete images, which
costs a boot and nothing more, and the survival of a sealed record across a point-in-time restore is
Inferred.

**Authority keys.** `git_remotes` (a remote pointed at another repository installs that tree on the
next pull), `recover_spent`, `first_run_at` and `first_run_keys` (a missing claim stamp reopens the
claim window), and the four OIDC keys (issuer, client id, login in flight, claims ticket) are in
sealed storage, and `cfw_meta` holds none of them. `metaGet` and `metaSet` route them, so a caller
cannot write one back to SQL. A row from an earlier build is copied over on the first read or at
wake, read back, then deleted; a run cut off between the copy and the delete repeats with the
sealed value winning. A dump with `secrets=1` carries the six that are worth restoring and a plain
dump carries none (`serve-restore.spec.ts`). A point-in-time restore has not been run against it:
the local runtime has no change log, and sealed storage shares the database file the restore
rewinds, which is Inferred.

**The owner audit log.** Owner calls that change something append to a hash chain held in sealed
storage: sequence, time, route label, method, status, a token fingerprint, and the previous hash,
in a ring of 1,000. Each append also writes `{seq, hash}` to Workers observability, so a rewrite of
the ring is checkable against a copy outside the object. `GET /audit` and `drangler audit --verify`
recompute the chain. It is evidence against a site-level attacker and none against the account
holder, who can edit the object's storage. Two gaps: a point-in-time restore rewinds the log and
nothing in the object can append after it, and the first claim is not an entry. A refused token adds
no row.
