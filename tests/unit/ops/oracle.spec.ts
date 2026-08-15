import { describe, expect, it } from 'vitest';
import { oracleKey, readOracle, resolveInstallable, type OracleKv } from '../../../src/ops/oracle';

/**
 * The compatibility oracle.
 *
 * The assertions that matter are about STALENESS and FALLBACK, not about the happy path. An oracle is a
 * cache of a correctness decision, so the two ways it can hurt are serving a verdict computed against a
 * core version this site no longer runs, and failing closed when it is simply absent. A wrong yes
 * installs a module nobody checked; a slow answer costs one subrequest.
 */

const CORE = '11.4.5';
const INSTALLED = { 'drupal/core': CORE };

function kv(entries: Record<string, unknown>): OracleKv {
	return {
		async get(key: string) {
			const hit = entries[key];
			return hit === undefined ? null : typeof hit === 'string' ? hit : JSON.stringify(hit);
		}
	};
}

const fresh = { verdict: 'installable', version: '2.0.0', conflicts: [], core: CORE, builtAt: 'T' };

/** a fetcher that records whether it was called, so "did this cost a subrequest" is observable */
function countingFetcher(body: unknown) {
	const state = { calls: 0 };
	const fetcher = async () => {
		state.calls++;
		return new Response(JSON.stringify(body));
	};
	return { state, fetcher };
}

const P2 = { packages: { 'drupal/x': [{ version: '9.9.9', require: { 'drupal/core': '^11' } }] } };

describe('a fresh oracle hit costs no subrequest at all', () => {
	it('answers from the oracle and never fetches', async () => {
		const { state, fetcher } = countingFetcher(P2);
		const out = await resolveInstallable(
			{ ORACLE_KV: kv({ [oracleKey('drupal/x')]: fresh }) },
			fetcher,
			'drupal/x',
			INSTALLED,
			CORE
		);
		expect(out.source).toBe('oracle');
		expect(out.verdict).toBe('installable');
		expect(state.calls).toBe(0);
	});

	it('says where the answer came from and when it was built', async () => {
		const out = await resolveInstallable(
			{ ORACLE_KV: kv({ [oracleKey('drupal/x')]: fresh }) },
			countingFetcher(P2).fetcher,
			'drupal/x',
			INSTALLED,
			CORE
		);
		expect(out.note).toContain('oracle');
		expect(out.note).toContain(CORE);
	});
});

describe('a STALE entry is reported and then ignored, never served', () => {
	it('goes live when the entry was built against a different core', async () => {
		// the failure this prevents: installing a module against a core version nobody checked
		const stale = { ...fresh, core: '11.2.0' };
		const { state, fetcher } = countingFetcher(P2);
		const out = await resolveInstallable(
			{ ORACLE_KV: kv({ [oracleKey('drupal/x')]: stale }) },
			fetcher,
			'drupal/x',
			INSTALLED,
			CORE
		);
		expect(out.source).toBe('oracle-stale');
		expect(state.calls).toBe(1);
		// and it says WHY it ignored the entry, or the next reader assumes the oracle is empty
		expect(out.note).toContain('11.2.0');
	});

	it('flags staleness at the read layer too', async () => {
		const hit = await readOracle(
			{ ORACLE_KV: kv({ [oracleKey('a/b')]: { ...fresh, core: '10.0.0' } }) },
			'a/b',
			CORE
		);
		expect(hit?.stale).toBe(true);
	});
});

describe('and it falls back rather than failing closed', () => {
	it('goes live with no binding at all', async () => {
		const { state, fetcher } = countingFetcher(P2);
		const out = await resolveInstallable({}, fetcher, 'drupal/x', INSTALLED, CORE);
		expect(out.source).toBe('live');
		expect(state.calls).toBe(1);
	});

	it('goes live on a miss, because absent means unknown and not blocked', async () => {
		const { state, fetcher } = countingFetcher(P2);
		const out = await resolveInstallable(
			{ ORACLE_KV: kv({}) },
			fetcher,
			'drupal/x',
			INSTALLED,
			CORE
		);
		expect(out.source).toBe('live');
		expect(state.calls).toBe(1);
	});

	it('treats an unparseable or shapeless entry as a miss', async () => {
		for (const bad of ['not json', { version: '1' }, { verdict: 'installable' }]) {
			const hit = await readOracle({ ORACleKV: null } as never, 'a/b', CORE);
			expect(hit).toBeNull();
			const hit2 = await readOracle(
				{ ORACLE_KV: kv({ [oracleKey('a/b')]: bad }) },
				'a/b',
				CORE
			);
			expect(hit2, JSON.stringify(bad)).toBeNull();
		}
	});

	it('never throws when KV itself is broken', async () => {
		const broken: OracleKv = {
			async get() {
				throw new Error('KV unavailable');
			}
		};
		await expect(readOracle({ ORACLE_KV: broken }, 'a/b', CORE)).resolves.toBeNull();
	});
});

describe('the key', () => {
	it('namespaces by module and leaves the core version OUT', () => {
		// core in the key would make a stale entry invisible instead of detectable: the read would simply
		// miss and go live, and nobody would learn the oracle needed rebuilding
		expect(oracleKey('drupal/webform')).toBe('oracle:drupal/webform');
		expect(oracleKey('drupal/webform')).not.toContain('11.4');
	});
});
