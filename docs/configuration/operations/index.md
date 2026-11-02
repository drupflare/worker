# Operations Settings

Settings for maintenance, owner access, audit, runtime overrides, database updates and pack reconciliation. The index of every variable is on [Configuration](../index.md).

## Pages

- [Owner Access and Audit](owner-access.md): owner token recovery and the audit log.
- [Updates and Reconciliation](updates.md): database updates, pack reconciliation and the addressable sweep.
- [Runtime Overrides](overrides.md): reading and writing overrides, and the three permissions.

## Site Maintenance

`/armfill`, `/invalidate`, `/bump`, `/migrate` and `/updb` take the owner token. Purging your own page
cache does not expose arbitrary SQL or a whole-database overwrite, which are separate routes.

`/updb` drives a database update run. `GET` reports the run and its units; `POST` advances exactly
one beat and re-arms nothing, so a caller that wants the chain finished polls. The alarm chain drives
the same step.

`POST` takes an `action`, which is what starts a run rather than advancing one. Without it a beat has
nothing to advance and answers `{"beat":"none","reason":"no-run"}`.

| action              | what it does                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| none, `run`, `beat` | advances one beat, which is what the Operate page sends                     |
| `prepare`           | raises the maintenance fence, snapshots the bookkeeping and plans the units |
| `drain`             | runs up to `maxBeats` beats in this invocation; keep it at 1 on free        |
| `rollback`          | restores what the snapshot covers; legal only from a halted run             |
| `abandon`           | accepts a halted run as-is; requires a written `reason`                     |

`abandon` will not take a default reason. The next person reading the run has to see that a human
decided, and a generated string would forge that signature.

### The Repair Surface

What an owner token can fix, and what each one costs. The class decides whether a tool may run it
unattended: `safe` changes nothing a visitor sees, `rebuild` discards derived state that comes back
on its own, and `stateful` changes what the site serves.

| route                   | class    | what it does                                              |
| ----------------------- | -------- | --------------------------------------------------------- |
| `/health`               | safe     | reads the repair state, the ledger and the worker version |
| `/health?clear=1`       | stateful | releases a quarantine, so the site serves again           |
| `/updb`                 | safe     | reads the update run                                      |
| `/updb` (POST)          | stateful | advances one beat of a database update                    |
| `/updb?action=prepare`  | stateful | starts an update run, fence and snapshot included         |
| `/updb?action=rollback` | stateful | restores the bookkeeping a halted run snapshotted         |
| `/armfill`              | rebuild  | queues a fill, so cold paths warm without a visitor       |
| `/invalidate`           | rebuild  | drops stored pages for a path or a tag                    |
| `/bump`                 | rebuild  | advances the generation, retiring every stored page       |
| `/migrate`              | stateful | resumes first-run migration on a site that stalled        |
| `/git?action=unpin`     | stateful | releases a preview pin without reaching the remote        |

`/git?action=unpin` exists because `unpreview` cannot help here: it re-syncs to the branch head, so it
needs the remote to answer, and a pin held against a remote that is down is exactly what an operator
is trying to release. Releasing without a sync leaves the site serving what it already serves and
gives the poller the branch back, so the next successful poll converges it.

A quarantine is released rather than prevented. `/health` reports what tripped it and the ledger
entry that recorded it; clearing without reading that first is how the same fault comes back.

A withdrawn replica lane is not a repair target. It asks the primary for a fresh copy itself, and the
primary queues that copy and arms an alarm to perform it. `/replica` is diagnostic only: it also
carries the path a lane uses to commit a batch it executed speculatively, which belongs to the pool
rather than to the owner token. Read the state through `/health` and `/serve-stats`. The pool itself
is on [Replica Lanes](../../operating/replica-lanes.md).

### The Degradation Band

Once a site leaves `normal`, every response it serves carries these headers:

| header                 | value                                                   |
| ---------------------- | ------------------------------------------------------- |
| `x-cfw-degrade`        | `reduced` or `read-only`                                |
| `x-cfw-degrade-driver` | which meter drove it: `rows` or `do`                    |
| `x-cfw-degrade-at`     | the fraction of that meter's daily budget already spent |

A `normal` site carries none of them, so their presence is the signal and no parsing is needed to
tell the two states apart.

The band is reported on every response from `reduced` onward, not only on a refusal. The level is
not persisted: the counter is keyed per UTC day, so midnight clears it.

`/serve-stats` reports `lastGitPoll`, `lastMirrorDrain` and `lastPageMirrorDrain`, each with its
`*At`. Every alarm unit catches its own error so one failure cannot stop the chain, so these
timestamps are the way to see a unit that has been failing.

## The Admin Surface

The seven `/_cfw` pages take the same owner token. A browser cannot put a header on its own navigation,
so `/_cfw/login` exchanges the token for a cookie: `HttpOnly`, `SameSite=Strict`, twelve hours,
cleared by `/_cfw/logout`. A page reached without it redirects to the sign-in form and returns
afterwards. A bearer header reaches the same pages, so a script needs no browser.

**`PW_DIAGNOSTICS` does not open these pages.** It opens the other owner routes. These pages install
code and run privileged operations, so they take the owner token only.
`SameSite=Strict` is what stands in for a CSRF token: several owner routes act on a GET, so a
cross-site request carrying the cookie would be enough to install a module. Strict means no
cross-site request carries it, including a top-level link.
