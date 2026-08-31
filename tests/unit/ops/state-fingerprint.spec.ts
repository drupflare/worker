import { describe, expect, it } from 'vitest';
import {
	canonicaliseState,
	fingerprintState,
	readStateRows,
	rowsFromSql,
	type StateRow
} from '../../../src/ops/state-fingerprint';

/**
 * The fingerprint's only job is to DISAGREE when the state differs.
 *
 * So the assertions that matter are the ones that try to make two different row sets hash the same:
 * a separator a value can imitate, a field boundary that can be shifted, a NULL that frames like an
 * empty string. A fingerprint that agrees when the state differs admits a replica whose
 * installation-globals are wrong, which is the failure the whole admission path exists to prevent.
 */

const row = (collection: string, name: string, value: string): StateRow => ({
	table: 'key_value',
	collection,
	name,
	value
});

describe('the same state fingerprints the same', () => {
	it('does not depend on the order rows arrive in', async () => {
		const a = [row('state', 'a', '1'), row('state', 'b', '2'), row('state', 'c', '3')];
		const b = [a[2]!, a[0]!, a[1]!];
		expect(await fingerprintState(a)).toBe(await fingerprintState(b));
	});

	it('is stable across calls', async () => {
		const rows = [row('state', 'system.private_key', 'k')];
		expect(await fingerprintState(rows)).toBe(await fingerprintState(rows));
	});
});

describe('different state fingerprints differently', () => {
	it('notices a changed value', async () => {
		expect(await fingerprintState([row('state', 'k', 'one')])).not.toBe(
			await fingerprintState([row('state', 'k', 'two')])
		);
	});

	it('notices a missing row', async () => {
		expect(await fingerprintState([row('state', 'a', '1'), row('state', 'b', '2')])).not.toBe(
			await fingerprintState([row('state', 'a', '1')])
		);
	});

	it('notices the same value under a different name', async () => {
		expect(await fingerprintState([row('state', 'a', 'v')])).not.toBe(
			await fingerprintState([row('state', 'b', 'v')])
		);
	});

	it('notices the same name in a different collection', async () => {
		expect(await fingerprintState([row('state', 'k', 'v')])).not.toBe(
			await fingerprintState([row('post_update', 'k', 'v')])
		);
	});

	it('notices the same row in a different table', async () => {
		const a: StateRow = { table: 'key_value', collection: 'c', name: 'n', value: 'v' };
		const b: StateRow = { ...a, table: 'key_value_expire' };
		expect(await fingerprintState([a])).not.toBe(await fingerprintState([b]));
	});
});

describe('a value cannot forge a field boundary', () => {
	it('keeps a shifted boundary distinct', async () => {
		// with a naive `join(':')` these two would produce the same string
		expect(await fingerprintState([row('state', 'ab', 'c')])).not.toBe(
			await fingerprintState([row('state', 'a', 'bc')])
		);
	});

	it('survives a value containing the framing characters', async () => {
		const sneaky = '3:abc4:defg';
		expect(await fingerprintState([row('state', 'k', sneaky)])).not.toBe(
			await fingerprintState([row('state', 'k', 'abc'), row('state', 'k2', 'defg')])
		);
	});

	it('distinguishes one row from two whose halves concatenate to it', async () => {
		expect(await fingerprintState([row('c', 'n', 'xy')])).not.toBe(
			await fingerprintState([row('c', 'n', 'x'), row('c', 'n', 'y')])
		);
	});
});

describe('the canonical form', () => {
	it('carries a version, so an encoding change moves every fingerprint', () => {
		expect(canonicaliseState([row('state', 'k', 'v')])).toContain('cfw-fp-1');
	});

	it('carries the row count, so a truncated read cannot pass as a short state', () => {
		expect(canonicaliseState([row('a', 'b', 'c'), row('d', 'e', 'f')])).toContain('\n2\n');
	});
});

describe('rows out of SQL', () => {
	it('keeps NULL distinct from the empty string', async () => {
		const nulled = rowsFromSql([{ t: 'key_value', collection: 'c', name: 'n', value: null }]);
		const empty = rowsFromSql([{ t: 'key_value', collection: 'c', name: 'n', value: '' }]);
		expect(await fingerprintState(nulled)).not.toBe(await fingerprintState(empty));
	});

	it('maps the SQL alias onto the table field', () => {
		const mapped = rowsFromSql([
			{ t: 'key_value_expire', collection: 'c', name: 'n', value: 'v' }
		]);
		expect(mapped[0]?.table).toBe('key_value_expire');
	});
});

describe('reading an object that has not been restored', () => {
	/** an exec that has some tables and not others */
	function execWith(present: Record<string, unknown[]>) {
		return (sql: string): readonly unknown[] => {
			const table = /FROM (\w+)/.exec(sql)?.[1] ?? '';
			const rows = present[table];
			if (rows === undefined) throw new Error(`no such table: ${table}: SQLITE_ERROR`);
			return rows;
		};
	}

	it('reports a missing table instead of throwing', () => {
		// the route that reports a replica's state is called MOST OFTEN on a replica that has none,
		// and a single UNION over both tables answered 500 for exactly that object
		const out = readStateRows(execWith({}));
		expect(out.rows).toEqual([]);
		expect(out.absent).toEqual(['key_value', 'key_value_expire']);
	});

	it('reads the table that is there and names the one that is not', () => {
		const out = readStateRows(
			execWith({
				key_value: [{ t: 'key_value', collection: 'state', name: 'n', value: 'v' }]
			})
		);
		expect(out.rows).toHaveLength(1);
		expect(out.absent).toEqual(['key_value_expire']);
	});

	it('rethrows a fault that is not a missing table', () => {
		// a swallowed fault reads as an empty state, which is a fingerprint over nothing that would
		// then be compared against a primary as though it meant something
		const boom = () => {
			throw new Error('database disk image is malformed');
		};
		expect(() => readStateRows(boom)).toThrow(/malformed/);
	});
});
