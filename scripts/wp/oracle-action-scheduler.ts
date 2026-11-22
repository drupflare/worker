import type { SupplementCase } from '../measure/sql-translate-supplement';

/** the scenario name the statements below are recorded under */
export const ACTION_SCHEDULER_SCENARIO = 'action-scheduler';

const A = 'wp_actionscheduler_actions';
const C = 'wp_actionscheduler_claims';
const G = 'wp_actionscheduler_groups';
const L = 'wp_actionscheduler_logs';
const THREAD = 'as';
const NOW = '2026-11-21 10:00:00';
const DUE = '2026-11-21 09:00:00';
const LATER = '2026-11-22 09:00:00';
const OLD = '2026-11-21 09:30:00';
const CUTOFF = '2026-11-21 09:55:00';
const ORDER = 'ORDER BY priority ASC, attempts ASC, scheduled_date_gmt ASC, action_id ASC';
const RELAXED =
	"SET SESSION sql_mode='NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'";
const CHARSET = 'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci';
const ZERO = "'0000-00-00 00:00:00'";

/** the table definitions Action Scheduler 4.2.0 sends to dbDelta, for a 191 character index */
export const ACTION_SCHEDULER_TABLES = [
	`CREATE TABLE ${A} (
 action_id bigint(20) unsigned NOT NULL auto_increment,
 hook varchar(191) NOT NULL,
 status varchar(20) NOT NULL,
 scheduled_date_gmt datetime NULL default ${ZERO},
 scheduled_date_local datetime NULL default ${ZERO},
 priority tinyint unsigned NOT NULL default '10',
 args varchar(191),
 schedule longtext,
 group_id bigint(20) unsigned NOT NULL default '0',
 attempts int(11) NOT NULL default '0',
 last_attempt_gmt datetime NULL default ${ZERO},
 last_attempt_local datetime NULL default ${ZERO},
 claim_id bigint(20) unsigned NOT NULL default '0',
 extended_args varchar(8000) DEFAULT NULL,
 unique_key varchar(191) DEFAULT NULL,
 PRIMARY KEY  (action_id),
 UNIQUE KEY unique_key (unique_key),
 KEY hook_status_scheduled_date_gmt (hook(163), status, scheduled_date_gmt),
 KEY status_scheduled_date_gmt (status, scheduled_date_gmt),
 KEY scheduled_date_gmt (scheduled_date_gmt),
 KEY args (args(191)),
 KEY group_id (group_id),
 KEY last_attempt_gmt (last_attempt_gmt),
 KEY \`claim_id_status_priority_scheduled_date_gmt\` (\`claim_id\`,\`status\`,\`priority\`,\`scheduled_date_gmt\`),
 KEY \`status_last_attempt_gmt\` (\`status\`,\`last_attempt_gmt\`),
 KEY \`status_claim_id\` (\`status\`,\`claim_id\`)
 ) ${CHARSET}`,
	`CREATE TABLE ${C} (
 claim_id bigint(20) unsigned NOT NULL auto_increment,
 date_created_gmt datetime NULL default ${ZERO},
 PRIMARY KEY  (claim_id),
 KEY date_created_gmt (date_created_gmt)
 ) ${CHARSET}`,
	`CREATE TABLE ${G} (
 group_id bigint(20) unsigned NOT NULL auto_increment,
 slug varchar(255) NOT NULL,
 PRIMARY KEY  (group_id),
 KEY slug (slug(191))
 ) ${CHARSET}`,
	`CREATE TABLE ${L} (
 log_id bigint(20) unsigned NOT NULL auto_increment,
 action_id bigint(20) unsigned NOT NULL,
 message text NOT NULL,
 log_date_gmt datetime NULL default ${ZERO},
 log_date_local datetime NULL default ${ZERO},
 PRIMARY KEY  (log_id),
 KEY action_id (action_id),
 KEY log_date_gmt (log_date_gmt)
 ) ${CHARSET}`
];

/** the insert Action Scheduler sends to store one action, with a gate that never blocks */
const schedule = (
	hook: string,
	opts: { status?: string; date?: string; priority?: number; args?: string } = {}
): string =>
	`\nINSERT INTO ${A} ( \`hook\`, \`status\`, \`scheduled_date_gmt\`, \`scheduled_date_local\`, \`schedule\`, \`group_id\`, \`priority\`, \`args\` )\nSELECT '${hook}', '${opts.status ?? 'pending'}', '${opts.date ?? DUE}', '${opts.date ?? DUE}', 'O:8:"stdClass":0:{}', 1, ${opts.priority ?? 10}, '${opts.args ?? '[]'}' FROM DUAL\nWHERE ( SELECT NULL FROM DUAL ) IS NULL\n`;

/** the same insert for a unique action, gated on a pending action with the same hook, group and args */
const scheduleUnique = (hook: string, key: string, args = '[]'): string =>
	`\nINSERT INTO ${A} ( \`hook\`, \`status\`, \`scheduled_date_gmt\`, \`scheduled_date_local\`, \`schedule\`, \`group_id\`, \`priority\`, \`args\`, \`unique_key\` )\nSELECT '${hook}', 'pending', '${DUE}', '${DUE}', 'O:8:"stdClass":0:{}', 1, 10, '${args}', '${key}' FROM DUAL\nWHERE ( \nSELECT action_id FROM ${A}\nWHERE status IN ( 'pending', 'in-progress' )\nAND hook = '${hook}'\nAND \`group_id\` = 1\nAND args = '${args}'\n LIMIT 1 ) IS NULL\nON DUPLICATE KEY UPDATE \`unique_key\` = VALUES(\`unique_key\`)`;

/** the claim statement of release 4.2.0 */
const claim = (
	claimId: number,
	limit: number,
	opts: { where?: string; order?: string; lock?: string } = {}
): string =>
	`UPDATE ${A} t1 JOIN ( SELECT action_id from ${A} WHERE claim_id = 0 AND scheduled_date_gmt <= '${NOW}' AND status='pending'${opts.where ?? ''} ${opts.order ?? ORDER} LIMIT ${limit} FOR UPDATE${opts.lock ?? ''} ) t2 ON t1.action_id = t2.action_id SET claim_id=${claimId}, last_attempt_gmt='${NOW}', last_attempt_local='${NOW}'`;

/** the statement that reads back a claim */
const claimed = (claimId: number): string =>
	`SELECT action_id, scheduled_date_gmt FROM ${A} WHERE claim_id = ${claimId} ${ORDER}`;

const unclaim = (id: number): string =>
	`UPDATE \`${A}\` SET \`claim_id\` = '0' WHERE \`action_id\` = ${id}`;

const complete = (id: number): string =>
	`UPDATE \`${A}\` SET \`status\` = 'complete', \`last_attempt_gmt\` = '${NOW}', \`last_attempt_local\` = '${NOW}', \`unique_key\` = NULL WHERE \`action_id\` = ${id}`;

const sql = (text: string, extra: Partial<SupplementCase> = {}): SupplementCase => ({
	sql: text,
	thread: THREAD,
	...extra
});

/** what the plugin sends to schedule, claim, run, recover and clean up actions, plus generic joins */
export const ACTION_SCHEDULER: SupplementCase[] = [
	sql('SET NAMES utf8mb4'),
	sql(RELAXED),
	sql("SHOW TABLES LIKE 'wp\\_actionscheduler\\_actions'"),
	...ACTION_SCHEDULER_TABLES.map((t) => sql(t)),
	sql(`SELECT group_id, slug FROM ${G} WHERE slug IN ( 'woocommerce' )`),
	sql(`INSERT INTO \`${G}\` (\`slug\`) VALUES ('woocommerce')`),
	sql(`SELECT group_id, slug FROM ${G} WHERE slug IN ( 'woocommerce' )`),
	// seven actions: four tie on date and priority, one outranks them, one is later, one is done
	sql(schedule('as_a1')),
	sql(schedule('as_a2')),
	sql(schedule('as_a3', { priority: 5 })),
	sql(schedule('as_a4')),
	sql(schedule('as_a5')),
	sql(schedule('as_a6', { date: LATER })),
	sql(schedule('as_a7', { status: 'complete' })),
	// two workers claim in turn; a LIMIT below the due count, then the rest, then nothing
	sql(`INSERT INTO \`${C}\` (\`date_created_gmt\`) VALUES ('${NOW}')`),
	sql(claim(1, 3)),
	sql(claimed(1)),
	sql(`INSERT INTO \`${C}\` (\`date_created_gmt\`) VALUES ('${NOW}')`),
	sql(claim(2, 3)),
	sql(claimed(2)),
	sql(`INSERT INTO \`${C}\` (\`date_created_gmt\`) VALUES ('${NOW}')`),
	sql(claim(3, 3)),
	sql(claimed(3)),
	sql(
		`SELECT COUNT(*)\n\t\t\tFROM ${C} c\n\t\t\tWHERE EXISTS (\n\t\t\t\tSELECT 1\n\t\t\t\tFROM ${A} a\n\t\t\t\tWHERE a.claim_id = c.claim_id\n\t\t\t\tAND a.status IN ( 'pending', 'in-progress' )\n\t\t\t)`
	),
	// the worker that holds claim 1 died: stale claims are found, unclaimed one by one, claimed again
	sql(`UPDATE ${A} SET last_attempt_gmt = '${OLD}' WHERE claim_id = 1`),
	sql(
		`SELECT a.action_id FROM ${A} a WHERE 1=1 AND a.status IN ('pending') AND a.last_attempt_gmt <= '${CUTOFF}' AND a.claim_id != 0 LIMIT 0, 25`
	),
	sql(unclaim(1)),
	sql(unclaim(2)),
	sql(unclaim(3)),
	sql(`SELECT claim_id FROM ${A} WHERE action_id=3`),
	sql(`INSERT INTO \`${C}\` (\`date_created_gmt\`) VALUES ('${NOW}')`),
	sql(claim(4, 3)),
	sql(claimed(4)),
	// claims narrowed by hook and by group
	sql(schedule('as_h1')),
	sql(schedule('as_h2')),
	sql(`INSERT INTO \`${C}\` (\`date_created_gmt\`) VALUES ('${NOW}')`),
	sql(claim(5, 5, { where: " AND hook IN ('as_h1')" })),
	sql(claimed(5)),
	sql(`INSERT INTO \`${C}\` (\`date_created_gmt\`) VALUES ('${NOW}')`),
	sql(claim(6, 5, { where: ' AND group_id IN ( 1 )' })),
	sql(claimed(6)),
	// run one action to the end, fail one, release the claim and clean up
	sql(
		`UPDATE ${A} SET attempts = attempts+1, status='in-progress', last_attempt_gmt = '${NOW}', last_attempt_local = '${NOW}' WHERE action_id = 3`
	),
	sql(`SELECT status FROM ${A} WHERE action_id=3`),
	sql(complete(3)),
	sql(
		`INSERT INTO \`${L}\` (\`action_id\`, \`message\`, \`log_date_gmt\`, \`log_date_local\`) VALUES (3, 'action started via Async Request', '${NOW}', '${NOW}')`
	),
	sql(
		`INSERT INTO \`${L}\` (\`action_id\`, \`message\`, \`log_date_gmt\`, \`log_date_local\`) VALUES (3, 'action complete via Async Request', '${NOW}', '${NOW}')`
	),
	sql(`SELECT * FROM ${L} WHERE action_id=3`),
	sql(
		`UPDATE \`${A}\` SET \`status\` = 'failed', \`last_attempt_gmt\` = '${NOW}', \`last_attempt_local\` = '${NOW}', \`unique_key\` = NULL WHERE \`action_id\` = 1`
	),
	sql(`SELECT action_id FROM ${A} WHERE claim_id = 4 AND status = 'pending'`),
	sql(`UPDATE ${A} SET claim_id = 0 WHERE action_id IN (2)`),
	sql(`DELETE FROM \`${C}\` WHERE \`claim_id\` = 4`),
	sql(`SELECT claim_id FROM ${A} WHERE action_id=2`),
	// ties without the action id in the order: which two of four equal rows a LIMIT 2 keeps
	sql(schedule('as_t1')),
	sql(schedule('as_t2')),
	sql(schedule('as_t3')),
	sql(schedule('as_t4')),
	sql(`INSERT INTO \`${C}\` (\`date_created_gmt\`) VALUES ('${NOW}')`),
	sql(
		claim(7, 2, {
			where: " AND hook LIKE 'as\\_t%'",
			order: 'ORDER BY scheduled_date_gmt ASC'
		}),
		{ known: 'order-ties' }
	),
	sql(claimed(7)),
	// the same claim through the form for a server that has SKIP LOCKED
	sql(`INSERT INTO \`${C}\` (\`date_created_gmt\`) VALUES ('${NOW}')`),
	sql(claim(8, 1, { where: " AND hook LIKE 'as\\_t%'", lock: ' SKIP LOCKED' })),
	sql(claimed(8)),
	// counts, search and cancel
	sql(`SELECT a.status, count(a.status) as 'count' FROM ${A} a GROUP BY a.status`),
	sql(
		`SELECT count(a.action_id) FROM ${A} a LEFT JOIN ${G} g ON g.group_id=a.group_id WHERE 1=1 AND g.slug='woocommerce' AND a.claim_id != 0 AND a.status IN ('pending')`
	),
	sql(
		`SELECT a.action_id FROM ${A} a WHERE 1=1 AND a.status IN ('pending') AND a.scheduled_date_gmt <= '${NOW}' ORDER BY a.scheduled_date_gmt ASC, a.action_id ASC LIMIT 0, 5`
	),
	sql(
		`SELECT a.action_id FROM ${A} a WHERE 1=1 AND (a.hook LIKE '%a4%' OR (a.extended_args IS NULL AND a.args LIKE '%a4%') OR a.extended_args LIKE '%a4%') ORDER BY a.hook ASC LIMIT 0, 5`
	),
	sql(`UPDATE ${A} SET status = 'canceled', unique_key = NULL WHERE action_id IN (6,7)`),
	sql(
		`INSERT ${L} (action_id, message, log_date_gmt, log_date_local) VALUES (6, 'action canceled', '${NOW}', '${NOW}'),(7, 'action canceled', '${NOW}', '${NOW}')`
	),
	sql(`SELECT MAX(log_id) FROM ${L} WHERE action_id = 6`),
	sql(`DELETE FROM ${L} WHERE action_id = 6 AND log_id < 99 LIMIT 100`),
	sql(
		`UPDATE ${A}\n\t\t\t\tSET unique_key = NULL\n\t\t\t\tWHERE status IN ('complete', 'failed', 'canceled') AND unique_key IS NOT NULL\n\t\t\t\tORDER BY action_id\n\t\t\t\tLIMIT 1000`
	),
	sql(`DELETE FROM \`${A}\` WHERE \`action_id\` = 7`),
	// a unique action: a pending twin blocks the insert, a finished one that kept its key conflicts
	sql(scheduleUnique('as_u1', 'as_u1|1|[]')),
	sql(scheduleUnique('as_u1', 'as_u1|1|[]')),
	sql(`UPDATE ${A} SET status = 'complete' WHERE hook = 'as_u1'`),
	sql(scheduleUnique('as_u1', 'as_u1|1|[]')),
	sql(
		`UPDATE ${A} SET unique_key = NULL\n\t\t\t\t\t\tWHERE unique_key = 'as_u1|1|[]' AND status IN ('complete', 'failed', 'canceled')`
	),
	sql(scheduleUnique('as_u1', 'as_u1|1|[]')),
	sql(
		`SELECT action_id, hook, status, unique_key FROM ${A} WHERE hook = 'as_u1' ORDER BY action_id`
	),
	// shapes the plugin does not send: refused by name
	sql(
		`UPDATE ${A} t1 LEFT JOIN ( SELECT action_id FROM ${A} LIMIT 1 ) t2 ON t1.action_id = t2.action_id SET claim_id = 9`,
		{ refused: 'update-multi-table' }
	),
	sql(
		`UPDATE ${A} t1 JOIN ${C} t2 ON t1.claim_id = t2.claim_id SET t2.date_created_gmt = '${NOW}'`,
		{ refused: 'update-multi-table' }
	),
	// joined updates outside the plugin: inner join, comma list, derived table, self join
	sql(
		"CREATE TABLE zz_owner (id bigint(20) unsigned NOT NULL auto_increment, name varchar(20) NOT NULL default '', n int NOT NULL default 0, PRIMARY KEY (id)) DEFAULT CHARACTER SET utf8mb4"
	),
	sql(
		"CREATE TABLE zz_item (id bigint(20) unsigned NOT NULL auto_increment, owner_id bigint(20) unsigned NOT NULL default 0, label varchar(20) NOT NULL default '', flag tinyint NOT NULL default 0, PRIMARY KEY (id), KEY owner_id (owner_id)) DEFAULT CHARACTER SET utf8mb4"
	),
	sql("INSERT INTO zz_owner (name, n) VALUES ('ann', 0), ('bob', 0), ('cy', 0)"),
	sql(
		"INSERT INTO zz_item (owner_id, label, flag) VALUES (1, 'a', 0), (1, 'b', 0), (2, 'c', 0), (2, 'd', 1), (4, 'e', 0)"
	),
	sql(
		"UPDATE zz_item i INNER JOIN zz_owner o ON o.id = i.owner_id SET i.flag = 1 WHERE o.name = 'ann'"
	),
	sql(
		"UPDATE zz_item i INNER JOIN zz_owner o ON o.id = i.owner_id SET i.flag = 1 WHERE o.name = 'ann'"
	),
	sql(
		"UPDATE zz_item i, zz_owner o SET i.label = 'bob item' WHERE i.owner_id = o.id AND o.name = 'bob'"
	),
	sql(
		'UPDATE zz_owner o JOIN (SELECT owner_id, COUNT(*) AS c FROM zz_item GROUP BY owner_id) x ON x.owner_id = o.id SET o.n = x.c'
	),
	sql(
		'UPDATE zz_item a JOIN zz_item b ON a.owner_id = b.owner_id AND b.id < a.id SET a.flag = 2'
	),
	sql(
		"UPDATE zz_item i JOIN zz_owner o ON o.id = i.owner_id SET label = o.name WHERE o.name = 'cy'"
	),
	sql('SELECT id, owner_id, label, flag FROM zz_item ORDER BY id'),
	sql('SELECT id, name, n FROM zz_owner ORDER BY id'),
	sql('UPDATE zz_item i LEFT JOIN zz_owner o ON o.id = i.owner_id SET i.flag = 9', {
		refused: 'update-multi-table'
	}),
	sql('UPDATE zz_item i JOIN zz_owner o USING (id) SET i.flag = 9', {
		refused: 'update-multi-table'
	})
];
