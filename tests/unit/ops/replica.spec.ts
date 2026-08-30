import { describe, expect, it } from 'vitest';
import {
	ReplicaRequiresPrimary,
	authoritativeWrites,
	classifyCapability,
	enforceReadOnly,
	isProvenRead,
	isReplicaLocalTable,
	statementAllowedOnReplica
} from '../../../src/ops/replica';

/**
 * The guard that makes a replica unable to commit an authoritative side effect.
 *
 * Every assertion here is about the FAIL-CLOSED direction. A test that only proves the known
 * mutating capabilities are refused would pass against a deny-list, and a deny-list is the thing
 * this module exists not to be.
 */

type Fake = Record<string, unknown>;

/** a module carrying one capability plus the boolean flag the service provider probes */
function fakeBinary(over: Fake = {}): Fake {
	return {
		cfwCanSuspend: false,
		cfwStats: () => '{"queryCount":3}',
		cfwSqlExec: (json: string) => `exec:${json}`,
		cfwSqlTxn: (json: string) => `txn:${json}`,
		cfwMail: () => '{"ok":true}',
		notACapability: () => 'untouched',
		...over
	};
}

const exec = (sql: string) => JSON.stringify({ sql, params: [] });
const txn = (statements: string[], read?: string) =>
	JSON.stringify({
		statements: statements.map((sql) => ({ sql })),
		commit: true,
		...(read === undefined ? {} : { read: { sql: read } })
	});

describe('a table is authoritative unless it is named local', () => {
	it('treats the derived tiers and the host bookkeeping as replica-local', () => {
		for (const table of [
			'cache_render',
			'cache_default',
			'?storage.setAlarm',
			'cfw_page',
			'cfw_shell',
			'cfw_meta',
			'cfw_health'
		]) {
			expect(isReplicaLocalTable(table), table).toBe(true);
		}
	});

	/**
	 * The three that a `cfw_` prefix rule would have swept in, each holding committed state: a
	 * queued message, durable file bytes, and an outbound request nobody has made yet.
	 */
	it('does not extend the local set to the host prefix', () => {
		for (const table of ['cfw_mail_queue', 'cfw_file', 'cfw_http_queue']) {
			expect(isReplicaLocalTable(table), table).toBe(false);
		}
	});

	it('treats an unknown table as authoritative', () => {
		expect(isReplicaLocalTable('some_module_state')).toBe(false);
		expect(isReplicaLocalTable('')).toBe(false);
	});

	it('reports rows and statements separately, so an attempt that wrote nothing is still visible', () => {
		const found = authoritativeWrites({
			byTable: { cache_render: 40, key_value: 2 },
			statementsByTable: { cache_render: 12, key_value: 2, flood: 1 }
		});
		expect(found).toEqual([
			{ table: 'key_value', rows: 2, statements: 2 },
			// a DELETE that matched nothing here would match on an object whose state differs
			{ table: 'flood', rows: 0, statements: 1 }
		]);
	});
});

describe('a statement is a write unless it is proven a read', () => {
	it('accepts the read forms Drupal issues', () => {
		expect(isProvenRead('SELECT * FROM node')).toBe(true);
		expect(isProvenRead('  select 1')).toBe(true);
		expect(isProvenRead('PRAGMA table_info("node")')).toBe(true);
		expect(isProvenRead('PRAGMA index_list(node)')).toBe(true);
		expect(isProvenRead('EXPLAIN QUERY PLAN SELECT 1')).toBe(true);
	});

	it('refuses every mutating form', () => {
		for (const sql of [
			'INSERT INTO key_value VALUES (1)',
			'UPDATE users SET name = "x"',
			'DELETE FROM sessions',
			'REPLACE INTO cache_render VALUES (1)',
			'CREATE TABLE x (a INT)',
			'DROP TABLE x',
			'ALTER TABLE x ADD COLUMN b INT',
			'VACUUM',
			'BEGIN',
			'COMMIT'
		]) {
			expect(isProvenRead(sql), sql).toBe(false);
		}
	});

	/** SQLite accepts a CTE in front of INSERT/UPDATE/DELETE, so telling them apart needs a parser */
	it('refuses a CTE rather than guessing what follows it', () => {
		expect(isProvenRead('WITH t AS (SELECT 1) SELECT * FROM t')).toBe(false);
		expect(isProvenRead('WITH t AS (SELECT 1) INSERT INTO x SELECT * FROM t')).toBe(false);
	});

	/** `PRAGMA x = y` sets; only the call form introspects */
	it('refuses a PRAGMA that assigns', () => {
		expect(isProvenRead('PRAGMA journal_mode = WAL')).toBe(false);
	});

	it('refuses an empty or unrecognised statement', () => {
		expect(isProvenRead('')).toBe(false);
		expect(isProvenRead('ATTACH DATABASE ":memory:" AS other')).toBe(false);
	});
});

/**
 * The reconciliation between the two allow-lists, and it is the half that was wrong first.
 *
 * `isProvenRead()` alone refuses `INSERT INTO cache_render`, so a replica could not fill its own
 * cache bins and would re-render every request -- the thing the topology exists to avoid.
 */
describe('a replica may write the tables it is allowed to own', () => {
	it('lets a write through when its target is replica-local', () => {
		for (const sql of [
			'INSERT INTO cache_render (cid, data) VALUES (?, ?)',
			'INSERT OR REPLACE INTO cache_default (cid) VALUES (?)',
			'DELETE FROM cache_discovery WHERE cid = ?',
			'UPDATE cfw_page SET html = ? WHERE path = ?',
			'CREATE TABLE IF NOT EXISTS cfw_shell (path TEXT)'
		]) {
			expect(statementAllowedOnReplica(sql), sql).toBe(true);
		}
	});

	it('still refuses a write to an authoritative table', () => {
		for (const sql of [
			'INSERT INTO key_value (name) VALUES (?)',
			'UPDATE users_field_data SET access = ?',
			'DELETE FROM sessions WHERE sid = ?',
			'INSERT INTO cfw_mail_queue (id) VALUES (?)'
		]) {
			expect(statementAllowedOnReplica(sql), sql).toBe(false);
		}
	});

	/** `writeTargetTable()` answers null for a read AND for a write it cannot parse; null refuses */
	it('refuses a write whose target cannot be parsed', () => {
		expect(
			statementAllowedOnReplica(
				'WITH t AS (SELECT 1) INSERT INTO cache_render SELECT * FROM t'
			)
		).toBe(false);
		expect(statementAllowedOnReplica('VACUUM')).toBe(false);
	});
});

describe('the guard walks what is installed, not a list', () => {
	it('refuses a capability nobody has classified', () => {
		const binary = fakeBinary({ cfwSomethingNew: () => 'reached' });
		enforceReadOnly(binary);
		expect(() => (binary.cfwSomethingNew as () => unknown)()).toThrow(ReplicaRequiresPrimary);
	});

	/**
	 * `cfwOidcClaims` deletes a durable ticket and `cfwTcp` queues an outbound exchange. Both are
	 * installed on the module and NEITHER is in `CROSSING_NAMES`, which is the drift this guard is
	 * built not to inherit.
	 */
	it('refuses the two installed capabilities the crossings census does not name', () => {
		const binary = fakeBinary({ cfwOidcClaims: () => 'reached', cfwTcp: () => 'reached' });
		enforceReadOnly(binary);
		expect(classifyCapability('cfwOidcClaims')).toBe('mutating');
		expect(classifyCapability('cfwTcp')).toBe('mutating');
		expect(() => (binary.cfwOidcClaims as () => unknown)()).toThrow(ReplicaRequiresPrimary);
		expect(() => (binary.cfwTcp as () => unknown)()).toThrow(ReplicaRequiresPrimary);
	});

	it('leaves the suspension flag a boolean and leaves non-capabilities alone', () => {
		const binary = fakeBinary();
		enforceReadOnly(binary);
		expect(binary.cfwCanSuspend).toBe(false);
		expect((binary.notACapability as () => string)()).toBe('untouched');
	});

	it('reports a verdict for every capability it wrapped', () => {
		const binary = fakeBinary();
		const guard = enforceReadOnly(binary);
		expect(guard.wrapped).toEqual({
			cfwStats: 'safe',
			cfwSqlExec: 'per-call',
			cfwSqlTxn: 'per-call',
			cfwMail: 'mutating'
		});
	});
});

describe('a refusal happens before the inner call, which is what makes the retry safe', () => {
	it('never reaches a mutating capability', () => {
		let reached = 0;
		const binary = fakeBinary({
			cfwMail: () => {
				reached += 1;
				return 'sent';
			}
		});
		const guard = enforceReadOnly(binary);
		expect(() => (binary.cfwMail as () => unknown)()).toThrow(/requires the primary/);
		expect(reached).toBe(0);
		expect(guard.didMutate()).toBe(false);
	});

	it('never reaches the driver for a write statement', () => {
		let reached = 0;
		const binary = fakeBinary({
			cfwSqlExec: (json: string) => {
				reached += 1;
				return json;
			}
		});
		const guard = enforceReadOnly(binary);
		expect(() =>
			(binary.cfwSqlExec as (j: string) => unknown)(exec('DELETE FROM sessions'))
		).toThrow(ReplicaRequiresPrimary);
		expect(reached).toBe(0);
		expect(guard.didMutate()).toBe(false);
	});

	it('hands each refusal to the caller with the statement that caused it', () => {
		const seen: ReplicaRequiresPrimary[] = [];
		const binary = fakeBinary();
		enforceReadOnly(binary, (refusal) => seen.push(refusal));
		expect(() =>
			(binary.cfwSqlExec as (j: string) => unknown)(exec('INSERT INTO key_value VALUES (1)'))
		).toThrow();
		expect(seen).toHaveLength(1);
		expect(seen[0]?.capability).toBe('cfwSqlExec');
		expect(seen[0]?.detail).toContain('INSERT INTO key_value');
	});
});

describe('the SQL capabilities are classified per call', () => {
	it('lets a read through to the driver unchanged', () => {
		const binary = fakeBinary();
		enforceReadOnly(binary);
		const payload = exec('SELECT nid FROM node WHERE nid = 1');
		expect((binary.cfwSqlExec as (j: string) => unknown)(payload)).toBe(`exec:${payload}`);
	});

	it('lets an all-read transaction through, including its speculative read', () => {
		const binary = fakeBinary();
		enforceReadOnly(binary);
		const payload = txn(['SELECT 1', 'PRAGMA table_info("node")'], 'SELECT 2');
		expect((binary.cfwSqlTxn as (j: string) => unknown)(payload)).toBe(`txn:${payload}`);
	});

	it('refuses a transaction where a single statement writes', () => {
		const binary = fakeBinary();
		enforceReadOnly(binary);
		expect(() =>
			(binary.cfwSqlTxn as (j: string) => unknown)(
				txn(['SELECT 1', 'UPDATE users SET name = "x"', 'SELECT 2'])
			)
		).toThrow(/not a read and not replica-local: UPDATE users/);
	});

	/** the speculative read rides alongside the buffer and is a read BY CONSTRUCTION, so it is checked */
	it('refuses a transaction whose speculative read is not a read', () => {
		const binary = fakeBinary();
		enforceReadOnly(binary);
		expect(() =>
			(binary.cfwSqlTxn as (j: string) => unknown)(txn(['SELECT 1'], 'DELETE FROM flood'))
		).toThrow(/not a read and not replica-local: DELETE FROM flood/);
	});

	it('refuses a payload it cannot read rather than passing it through', () => {
		const binary = fakeBinary();
		enforceReadOnly(binary);
		for (const payload of ['not json', JSON.stringify({ noSql: true }), '']) {
			expect(() => (binary.cfwSqlExec as (j: string) => unknown)(payload)).toThrow(
				/statement payload could not be read/
			);
		}
		expect(() =>
			(binary.cfwSqlTxn as (j: string) => unknown)(
				JSON.stringify({ statements: [{ no: 1 }] })
			)
		).toThrow(/statement payload could not be read/);
	});
});
