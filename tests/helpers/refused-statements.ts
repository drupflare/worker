import { CLASS_ROWS } from '../../src/db/sql/classes';

/** one statement that the translator refuses, and the class row that names the refusal */
export interface RefusedStatement {
	id: string;
	sql: string;
}

const long = (n: number, c = 'x') => c.repeat(n);

// the two rows whose example in the table is a description of a size, not a statement
const BUILT: Record<string, string> = {
	'like-pattern-too-long': `SELECT a FROM t WHERE a LIKE '%${long(30)}%${long(30)}%'`,
	'statement-too-large': `INSERT INTO t (a) VALUES ${Array.from({ length: 300 }, (_, i) => `('${long(900, String(i % 10))}')`).join(', ')}`
};

/** an example statement for every refused row of the class table, in table order */
export function refusedStatements(): RefusedStatement[] {
	return CLASS_ROWS.filter((row) => row.kind === 'refused').map((row) => ({
		id: row.id,
		sql: BUILT[row.id] ?? row.example
	}));
}
