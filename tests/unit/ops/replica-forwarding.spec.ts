import { describe, expect, it } from 'vitest';
import { enforceReadOnly, speculative } from '../../../src/ops/replica';

/**
 * The lane half of write forwarding: refusal becomes collection.
 *
 * Without a collector the guard is unchanged and a write throws. With one, a mutating transaction is
 * downgraded to the driver's `commit: false` path, so PHP reads through its own write and the lane's
 * database rolls back to its applied generation, while the statements go to the primary.
 *
 * Only SQL forwards. A `mutating` capability is an outbound effect and there is no rollback for a
 * mail that has been sent.
 */

type Call = { name: string; payload: unknown };

function moduleWith(calls: Call[]): Record<string, unknown> {
	return {
		cfwSqlTxn: (payload: unknown) => {
			calls.push({ name: 'cfwSqlTxn', payload });
			return '{"ok":true}';
		},
		cfwSqlExec: (payload: unknown) => {
			calls.push({ name: 'cfwSqlExec', payload });
			return '{"ok":true}';
		},
		cfwMail: (payload: unknown) => {
			calls.push({ name: 'cfwMail', payload });
			return '{"ok":true}';
		}
	};
}

const WRITE = JSON.stringify({
	statements: [{ sql: 'UPDATE node_field_data SET title = ?', params: ['x'] }],
	commit: true
});

describe('the payload downgrade', () => {
	it('forces commit off and keeps everything else', () => {
		const out = JSON.parse(speculative(WRITE)!) as Record<string, unknown>;
		expect(out.commit).toBe(false);
		expect(out.statements).toHaveLength(1);
	});

	it('refuses a payload it cannot read', () => {
		expect(speculative('not json')).toBeNull();
		expect(speculative(JSON.stringify({ nope: 1 }))).toBeNull();
	});

	it('does not mutate what the caller still holds', () => {
		const held = { statements: [{ sql: 'UPDATE x SET y = 1' }], commit: true };
		speculative(JSON.stringify(held));
		expect(held.commit).toBe(true);
	});
});

describe('with no collector the guard is unchanged', () => {
	it('throws on a write', () => {
		const calls: Call[] = [];
		const binary = moduleWith(calls);
		const guard = enforceReadOnly(binary, undefined);
		expect(() => (binary.cfwSqlTxn as (p: unknown) => unknown)(WRITE)).toThrow();
		// the refusal precedes the inner call, which is what makes a retry on the primary safe
		expect(calls).toHaveLength(0);
		expect(guard.didMutate()).toBe(false);
		expect(guard.refusals).toHaveLength(1);
	});
});

describe('with a collector a write is forwarded instead', () => {
	it('collects the statements and runs the transaction speculatively', () => {
		const calls: Call[] = [];
		const collected: string[][] = [];
		const binary = moduleWith(calls);
		enforceReadOnly(binary, undefined, (statements) => collected.push([...statements]));

		(binary.cfwSqlTxn as (p: unknown) => unknown)(WRITE);

		expect(collected).toHaveLength(1);
		expect(collected[0]?.[0]).toContain('UPDATE node_field_data');
		// the inner call ran, and it ran with commit off
		expect(calls).toHaveLength(1);
		const payload = JSON.parse(String(calls[0]?.payload)) as { commit: boolean };
		expect(payload.commit).toBe(false);
	});

	it('still refuses an outbound effect, because a sent mail has no rollback', () => {
		const calls: Call[] = [];
		const binary = moduleWith(calls);
		const guard = enforceReadOnly(binary, undefined, () => {});

		expect(() => (binary.cfwMail as (p: unknown) => unknown)('{}')).toThrow();
		expect(calls).toHaveLength(0);
		expect(guard.refusals[0]?.capability).toBe('cfwMail');
	});

	it('leaves a read alone', () => {
		const calls: Call[] = [];
		const collected: string[][] = [];
		const binary = moduleWith(calls);
		enforceReadOnly(binary, undefined, (s) => collected.push([...s]));

		(binary.cfwSqlTxn as (p: unknown) => unknown)(
			JSON.stringify({ statements: [{ sql: 'SELECT 1' }] })
		);

		// nothing to forward, and the payload is untouched so the read commits normally
		expect(collected).toHaveLength(0);
		expect(JSON.parse(String(calls[0]?.payload)).commit).toBeUndefined();
	});

	it('refuses a single write, which has no speculative form', () => {
		const calls: Call[] = [];
		const binary = moduleWith(calls);
		const guard = enforceReadOnly(binary, undefined, () => {});

		// `cfwSqlExec` carries one statement rather than a transaction, so there is no `commit` to
		// force off and nothing to roll back. Refusing sends it to the primary, which is the
		// conservative direction. The driver keeps this branch unreached on a partitioned lane by
		// replaying an unbuffered write through `cfwSqlTxn`; arriving here means the two disagree
		// about whether this connection holds a residue class, and a failover is the safe answer
		expect(() =>
			(binary.cfwSqlExec as (p: unknown) => unknown)('{"sql":"DELETE FROM node"}')
		).toThrow();
		expect(calls).toHaveLength(0);
		expect(guard.refusals[0]?.detail).toContain('cannot be rolled back');
	});
});
