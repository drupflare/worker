# Diagnostics

The variables that turn on the diagnostic surfaces and control how much PHP logs. The index of every variable is on [Configuration](index.md).

| var                 | default | what it does                                                              |
| ------------------- | ------- | ------------------------------------------------------------------------- |
| `PW_DIAGNOSTICS`    | off     | exposes `/sql`, `/restore`, `/php` and the rest of the diagnostic surface |
| `PHP_LOG_LEVEL`     | `info`  | RFC 5424 ceiling on what PHP's log mirrors to `console.log`               |
| `PW_SQL_TRACE`      | off     | logs every Drupal statement through `console.log`                         |
| `PW_SQL_TRACE_FROM` | 0       | first statement number to log                                             |
| `MEMORY_TRACE`      | off     | logs memory readings at each boot and invocation end, for a reset         |

## `PW_DIAGNOSTICS`

**One boolean that exposes arbitrary SQL against the site database (`/sql`), a whole-database
overwrite (`/restore`) and arbitrary PHP (`/php`).** Diagnostic routes fail closed without it.
`bun run dev` sets it; a deployed configuration must not. It is not KV-overridable: a KV write that set
it would open `/sql` and `/restore` on a live site.

## `PHP_LOG_LEVEL`

`off | error | warn | log | info | debug`, mapped onto RFC 5424 severities (lower is more severe), the
same scale `CfwLogger` sends and Drupal's own `watchdog` uses. `warning` and `notice` are accepted as
aliases for `warn` and `log`, and `all` for `debug`.

`CfwLogger` ships every Drupal log entry across the host bridge and the object mirrors it to
`console.log`, so the output survives the isolate that produced it. Unfiltered, a single page render
emits several debug-level deprecation notices with stack traces, which fills a terminal. `info` is the
default for that reason.

An unrecognised value falls back to the default and raises no error. A fatal carries `level: "error"`
with no severity and is derived from the name, so a missing field never drops it.

Consumer: `src/ops/log-level.ts`.

## `PW_SQL_TRACE`

Logs every statement Drupal issues. `console.log` survives an object reset, which is what makes it
readable when the object dies mid-run. A `wrangler tail` has a 256 KB budget, so
`PW_SQL_TRACE_FROM=<n>` spends it on the end of a long run instead of the beginning.
