import { describe, expect, it } from 'vitest';
import { HOST_HELPERS_PHP } from '../../src/site/generated/assets';
import capture from '../fixtures/wp-capture.json';
import golden from '../fixtures/wp-front-page-golden.json';
import { refusedStatements } from '../helpers/refused-statements';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * `cfwMysqlExec` as PHP calls it, on the interpreter that ships.
 *
 * The PHP half is the real `Bridge.php` from the drupflare sibling, evaluated in the interpreter
 * (it is GPL and not packed). The setup is a captured WordPress install, the reads are the 24
 * statements of a captured cold front page, and what they answer is compared with what the same
 * statements answered over `node:sqlite` (`tests/fixtures/wp-front-page-golden.json`, which
 * `tests/node/sql-translate.spec.ts` keeps current).
 *
 * Needs the interpreter, so it is in `ARTIFACT_SPECS`.
 */

const sources = import.meta.glob(
	['../../../drupflare/src/Wp/Bridge.php', '../../.siblings/drupflare/src/Wp/Bridge.php'],
	{ query: '?raw', import: 'default', eager: true }
);
const BRIDGE_PHP = Object.values(sources)[0] as string | undefined;

type Json = Record<string, unknown>;
type Reply = { ok: boolean; kind?: string; columns?: string[]; rows?: unknown[][] } & Json;

const RELAXED =
	"SET SESSION sql_mode='NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'";

const b64 = (text: string) => {
	let binary = '';
	for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
	return btoa(binary);
};

/** PHP that loads Bridge.php and sends each statement through it, printing every reply */
function sendAll(statements: readonly string[]): string {
	return `<?php
if (!function_exists('cfw_host')) {${HOST_HELPERS_PHP}}
if (!class_exists('Drupflare\\\\Wp\\\\Bridge', false)) {
	eval(substr(base64_decode('${b64(BRIDGE_PHP ?? '')}'), 5));
}
$bridge = new Drupflare\\Wp\\Bridge();
$replies = [];
foreach (json_decode(base64_decode('${b64(JSON.stringify(statements))}'), true) as $sql) {
	$replies[] = $bridge->exec($sql);
}
echo json_encode(['available' => $bridge->available(), 'replies' => $replies]);`;
}

const run = async (statements: readonly string[], site?: ServeDo) => {
	const go = async (s: ServeDo) => {
		const out = (await s.runJson(sendAll(statements))) as {
			replies: Reply[];
			available: boolean;
		};
		return out;
	};
	return site
		? go(site)
		: (inObject(freshSite(), go) as Promise<{ replies: Reply[]; available: boolean }>);
};

/** a statement's rows in a comparable order: as sent when it sorts, else as a sorted set */
const comparable = (sql: string, rows: unknown[][]) =>
	/\bORDER BY\b/i.test(sql) ? rows : [...rows].map((r) => JSON.stringify(r)).sort();

describe('cfwMysqlExec, driven from PHP', () => {
	it('finds the real Bridge.php', () => {
		expect(
			BRIDGE_PHP,
			'drupflare/src/Wp/Bridge.php was not found beside this repository'
		).toBeTruthy();
	});

	it('replays a captured install and a cold front page with the contract shapes and the same rows', async () => {
		const result = await inObject(freshSite(), async (site) => {
			const setup = await run([RELAXED, ...capture.setup], site);
			const front = await run(capture.frontPageCold, site);
			return { setup, front };
		});

		expect(result.setup.available).toBe(true);
		expect(result.setup.replies).toHaveLength(capture.setup.length + 1);
		for (const [i, reply] of result.setup.replies.entries()) {
			expect(
				reply.ok,
				`${i}: ${(capture.setup[i - 1] ?? RELAXED).slice(0, 80)} ${JSON.stringify(reply).slice(0, 200)}`
			).toBe(true);
			if (i === 0) expect(reply).toEqual({ ok: true, kind: 'none' });
			else expect(['write', 'none']).toContain(reply.kind);
		}
		// every INSERT and UPDATE of the install is a write reply with integer counts
		const sentWrites = result.setup.replies.filter((r) => r.kind === 'write');
		expect(sentWrites.length).toBeGreaterThan(50);
		for (const w of sentWrites) {
			expect(Number.isInteger(w.affected)).toBe(true);
			expect(Number.isInteger(w.insertId)).toBe(true);
		}

		expect(result.front.replies).toHaveLength(capture.frontPageCold.length);
		for (const [i, reply] of result.front.replies.entries()) {
			const want = golden[i] as unknown as Reply;
			const sql = capture.frontPageCold[i] as string;
			expect(reply.ok, sql.slice(0, 80)).toBe(true);
			expect(reply.kind, sql.slice(0, 80)).toBe('rows');
			expect(reply.columns, sql.slice(0, 80)).toEqual(want.columns);
			expect(comparable(sql, reply.rows!), sql.slice(0, 80)).toEqual(
				comparable(sql, want.rows!)
			);
		}
	}, 900_000);

	it('does not hand one run the FOUND_ROWS count of the run before it', async () => {
		const out = await inObject(freshSite(), async (site) => {
			await run(
				[
					RELAXED,
					'CREATE TABLE t (id int NOT NULL auto_increment, PRIMARY KEY (id))',
					'INSERT INTO t (id) VALUES (1), (2), (3)'
				],
				site
			);
			const first = await run(
				['SELECT SQL_CALC_FOUND_ROWS id FROM t LIMIT 0, 1', 'SELECT FOUND_ROWS()'],
				site
			);
			// a new run that asks without querying: the count from the run before must be gone
			const second = await run(['SELECT SQL_CALC_FOUND_ROWS id FROM t LIMIT 0, 1'], site);
			const third = await run(['SELECT FOUND_ROWS()'], site);
			return { first, second, third };
		});
		expect(out.first.replies[1]?.rows).toEqual([[3]]);
		expect(out.second.replies[0]?.ok).toBe(true);
		expect(out.third.replies[0]?.rows).toEqual([[0]]);
	}, 900_000);

	it('reaches PHP with every refused class named', async () => {
		const statements = refusedStatements();
		const out = await run(statements.map((s) => s.sql));
		expect(out.replies).toHaveLength(statements.length);
		for (const [i, reply] of out.replies.entries()) {
			const want = statements[i]!;
			expect(reply.ok, want.id).toBe(false);
			expect(reply.refused, want.id).toBe(want.id);
			expect(Number.isInteger(reply.errno), want.id).toBe(true);
			expect(typeof reply.sqlstate, want.id).toBe('string');
		}
	}, 900_000);

	it('answers a platform error with the MySQL number and no refusal', async () => {
		const out = await run([
			RELAXED,
			'SELECT * FROM wp_missing',
			'CREATE TABLE u (id int NOT NULL, PRIMARY KEY (id))',
			'INSERT INTO u (id) VALUES (1)',
			'INSERT INTO u (id) VALUES (1)'
		]);
		expect(out.replies[1]).toMatchObject({ ok: false, errno: 1146 });
		expect(out.replies[1]?.refused).toBeUndefined();
		expect(out.replies[4]).toMatchObject({ ok: false, errno: 1062 });
	}, 900_000);
});
