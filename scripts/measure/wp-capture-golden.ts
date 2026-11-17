import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { executeMysql, type MysqlReply } from '../../src/db/sql/exec';
import { createState } from '../../src/db/sql/translate';
import { memoryDatabase } from './sql-translate-run';

const FIXTURES = resolve(import.meta.dirname, '../../tests/fixtures');

/** what WordPress sends first on every connection, so strict mode is off for the setup */
export const RELAXED =
	"SET SESSION sql_mode='NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'";

/** the statements of one captured install and one cold front page */
export interface WpCapture {
	setup: string[];
	frontPageCold: string[];
}

/** a reply without the row meters, which differ between engines */
export type GoldenReply = Exclude<MysqlReply, { ok: false }> | Extract<MysqlReply, { ok: false }>;

/** the front page replies executeMysql gives over node:sqlite after the setup */
export function frontPageReplies(capture: WpCapture): MysqlReply[] {
	const { run, atomic } = memoryDatabase();
	const state = createState({ database: 'wp' });
	const send = (sql: string) => executeMysql(sql, run, state, { atomic });
	send(RELAXED);
	for (const sql of capture.setup) {
		const reply = send(sql);
		if (!reply.ok) throw new Error(`setup failed: ${sql.slice(0, 80)} => ${reply.error}`);
	}
	return capture.frontPageCold.map((sql) => {
		const reply = send(sql);
		if (reply.ok) {
			delete reply.rowsRead;
			delete reply.rowsWritten;
		}
		return reply;
	});
}

if (import.meta.main) {
	const capture = JSON.parse(
		readFileSync(resolve(FIXTURES, 'wp-capture.json'), 'utf8')
	) as WpCapture;
	const replies = frontPageReplies(capture);
	writeFileSync(
		resolve(FIXTURES, 'wp-front-page-golden.json'),
		`${JSON.stringify(replies, null, '\t')}\n`
	);
	process.stdout.write(`${replies.length} replies written\n`);
}
