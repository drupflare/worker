# Oracle Fixtures

Recorded answers of two outside implementations over WordPress 7.1.4 statement logs, replayed by the `the outside oracles` block in `tests/node/sql-translate.spec.ts`.

| file             | holds                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `record.json.gz` | 1,948 statements, then native MySQL and the upstream plugin as digests, and table hashes per scenario |
| `ddl.json`       | the install DDL as drangler `convertDump` and the upstream plugin build it, as table shapes           |

Run of 2026-11-21:

- Upstream: `WordPress/sqlite-database-integration` tag `v3.1.3`, commit `f05c1f9eecf13ff2f387c4be8acf1ae3befaa537`, tree of `packages/mysql-on-sqlite` `9d1f6ad92447d1cbc10a7d2b80d4f90a7b07e2a7`. The tag's GitHub tarball (sha256 `94a33a1895898705bd158549ab979b668b5d08fe5d6cd1c1344ed290635e4aec`) leaves out `packages/`, so the run used a clone. The code is GPL-2.0 and is never copied into this repository; it ran on PHP 8.5.7 with SQLite 3.54.1.
- Native: the MySQL image pinned in `docker/compose.yml` (`sha256:893418c8...`), reporting `26.7.0`.
- Statements: `bun scripts/wp/oracles.ts capture`, which installs WordPress through the translator, runs an activity script and fetches 17 routes, then appends the Action Scheduler scenario (`scripts/wp/oracle-action-scheduler.ts`, 98 statements) and the authored supplement. Password hashes in the file are replaced with a fixed text.
- Action Scheduler scenario of 2026-11-21: recorded from the earlier statements plus the new scenario rather than a new WordPress install. The file grew from 65,140 to 69,928 bytes (99 statements: 98 new, and one supplement statement replaced by two). Of the 1,849 earlier statements, 1,847 kept their native digest and 1,848 their upstream digest; the two that moved are `SHOW TABLES`, which now lists the six new tables, and the cardinality column of `SHOW INDEX`.

The gate runs from these files with no MySQL, PHP or clone. To record again, start the pinned MySQL, clone the plugin at a tag, and run `scripts/wp/oracles.ts` with `capture` and then `record`; `scripts/wp/oracle-ddl.ts` writes `ddl.json` and needs the sibling `../drangler`. The `ddl.json` test also needs `assets/wordpress/sql`, which a clean clone does not have, and skips by name without it.
