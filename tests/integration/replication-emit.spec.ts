import { describe, expect, it } from 'vitest';
import { drupalOp, writeWorkload } from '../../src/drupal/site-php';
import type { LogRecord } from '../../src/ops/replication-log';
import { freshSite, inObject, markProvisioned, type ServeDo } from '../helpers/serve-do';

/**
 * The PRIMARY half of replication: a committed authoritative write becomes a record.
 *
 * The consume side shipped first, with a spec and nothing producing a record for it, so a replica
 * could apply a generation nobody could hand it. This is the producer.
 *
 * The property that matters is that a record describes a change a replica can REPLAY to reach the
 * same state. So the assertions are: the statements are captured, they are positional (Drupal binds
 * by name and `exec(sql, ...params)` cannot replay a named form), and the fingerprint on the record
 * is the fingerprint of the state the request actually left.
 */

const TIMEOUT = 900_000;
const PASS = 'cfw-Emit-Pass-7781';

type LogAnswer = { generation: number; records: LogRecord[]; overflowed: number[] };

/**
 * Sets the replica binding EXPLICITLY, every time.
 *
 * `site.env` is the module-scope `env` object shared by every object in the lane, not a per-object
 * copy, so a test that sets `REPLICA_READ_ONLY` and returns leaves it set for whatever runs next.
 * That is how the real-write case below first failed: it ran as a replica and every authoritative
 * write was refused. Setting it explicitly rather than resetting it afterwards means no test depends
 * on what the previous one left.
 */
function role(site: ServeDo, as: 'primary' | 'replica'): void {
	(site.env as Record<string, unknown>).REPLICA_READ_ONLY = as === 'replica' ? '1' : '0';
}

async function log(site: ServeDo, since = 0): Promise<LogAnswer> {
	const res = await site.fetch(
		new Request(`https://do.local/__replica?action=log&since=${since}`)
	);
	expect(res.status, await res.clone().text()).toBe(200);
	return (await res.json()) as LogAnswer;
}

describe('a primary records what a replica would have to replay', () => {
	it(
		'seals one record per invocation, not one per statement',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				role(site, 'primary');
				site.ensureReplicationLog();
				// two authoritative writes inside ONE invocation
				site.bufferForReplication('INSERT INTO key_value VALUES (?, ?, ?)', [
					's',
					'a',
					'1'
				]);
				site.bufferForReplication('INSERT INTO key_value VALUES (?, ?, ?)', [
					's',
					'b',
					'2'
				]);
				site.advanceCommit();
				const sealed = await site.sealGeneration();
				return { sealed, log: await log(site) };
			});

			// ONE record carrying both. Twelve records for a twelve-row request would make eleven
			// intermediate states a replica could stop at, none of which the primary was ever in
			expect(out.log.records).toHaveLength(1);
			expect(out.log.records[0]?.statements).toHaveLength(2);
			expect(out.sealed?.statements).toBe(2);
		},
		TIMEOUT
	);

	it(
		'stores statements positionally, so a replica can replay them',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				role(site, 'primary');
				site.ensureReplicationLog();
				// the named form Drupal's driver actually emits
				site.bufferForReplication('INSERT INTO key_value VALUES (:c, :n, :v)', {
					':c': 'state',
					':n': 'k',
					':v': 'v'
				});
				site.advanceCommit();
				await site.sealGeneration();
				return log(site);
			});

			const stmt = out.records[0]?.statements[0];
			// rewritten to `?` with the values in order; a named record would make the applier
			// re-derive an ordering the producer already knew
			expect(stmt?.sql).not.toContain(':c');
			expect(stmt?.params).toEqual(['state', 'k', 'v']);
		},
		TIMEOUT
	);

	it(
		'marks a change too large to log rather than truncating it',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				role(site, 'primary');
				site.ensureReplicationLog();
				for (let i = 0; i < 600; i++) {
					site.bufferForReplication('INSERT INTO key_value VALUES (?, ?, ?)', [
						's',
						`k${i}`,
						'1'
					]);
				}
				site.advanceCommit();
				await site.sealGeneration();
				return log(site);
			});

			const rec = out.records[0];
			expect(rec?.overflowed).toBe(true);
			// NO statements. A truncated list would apply cleanly and leave the replica
			// silently wrong, which is the one outcome the log exists to prevent
			expect(rec?.statements).toEqual([]);
			expect(out.overflowed).toEqual([rec?.generation]);
		},
		TIMEOUT
	);

	it(
		'seals nothing when the generation did not move',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				role(site, 'primary');
				site.ensureReplicationLog();
				return { sealed: await site.sealGeneration(), log: await log(site) };
			});

			expect(out.sealed).toBeNull();
			expect(out.log.records).toEqual([]);
		},
		TIMEOUT
	);

	it(
		'a REPLICA records nothing, or its own cache fills would replicate back',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				role(site, 'replica');
				site.ensureReplicationLog();
				site.bufferForReplication('INSERT INTO key_value VALUES (?, ?, ?)', [
					's',
					'a',
					'1'
				]);
				site.advanceCommit();
				return { sealed: await site.sealGeneration(), log: await log(site) };
			});

			// the commit sequence moved and nothing was recorded: a replica logging its own writes
			// is a replication loop
			expect(out.sealed).toBeNull();
			expect(out.log.records).toEqual([]);
		},
		TIMEOUT
	);

	it(
		'records a real Drupal write, with the fingerprint of the state it left',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				role(site, 'primary');
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						body: JSON.stringify({ adminPass: PASS, siteName: 'Emit' }),
						headers: { 'content-type': 'application/json' }
					})
				);
				const before = await log(site);
				const ok = (await site.runJson(
					drupalOp(`
\\Drupal::configFactory()->getEditable('system.site')->set('slogan', 'replicated')->save();
$out['slogan'] = \\Drupal::config('system.site')->get('slogan');`)
				)) as Record<string, unknown>;
				// `runJson()` reaches into the object directly, so it passes through neither `fetch()`
				// nor `alarm()` and neither seal hook fires. Sealing by hand here is the fixture
				// matching the harness, not the emitter needing help: the two real entry points both
				// seal, and `alarm()` only started doing so because this case found it missing
				const sealed = await site.sealGeneration();
				return { ok, sealed, before, after: await log(site, before.generation) };
			});

			// THE CONTROL FIRST: a fragment that threw records nothing, which is indistinguishable
			// from a missing emitter unless the op is checked
			expect(
				out.ok?.ok,
				`the write did not run: ${JSON.stringify(out.ok).slice(0, 300)}`
			).toBe(true);
			expect(out.ok?.slogan).toBe('replicated');

			expect(
				out.after.records.length,
				'a real config write produced no record'
			).toBeGreaterThan(0);
			const rec = out.after.records[0];
			expect(rec?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
			expect(rec?.parent).toBeLessThan(rec!.generation);
			expect(rec?.schemaVersion).not.toBe('');
		},
		TIMEOUT
	);

	/**
	 * The replay a record describes has to be the one the primary performed, ONCE.
	 *
	 * A buffered transaction is replayed speculatively to learn an insert id, and every statement in
	 * that pass reached `execSql()` and was buffered again. Measured on one node edit before the
	 * guard: **154 statements recorded for 19 real ones**, with `INSERT INTO node_revision` 23 times
	 * and `INSERT INTO node_field_revision` 14 -- so a replica applying that record would have created
	 * 23 revisions where the primary created one. The pass commits nothing, which is why nothing on
	 * the primary ever looked wrong.
	 */
	it(
		'records a buffered save once, not once per speculative replay',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const first = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ adminPass: PASS, siteName: 'Emit' })
					})
				);
				expect(first.status, await first.clone().text()).toBe(200);
				role(site, 'primary');

				const created = (await site.runJson(
					writeWorkload('node-create', { seq: 1, nid: 0 })
				)) as Record<string, unknown>;
				const nid = Number(created['id'] ?? 0);
				// `runJson()` reaches the object directly, so nothing seals between the workloads;
				// draining here makes the next record describe one save rather than three
				await site.sealGeneration();
				const before = (await log(site)).generation;

				const edited = (await site.runJson(
					writeWorkload('node-revision', { seq: 2, nid })
				)) as Record<string, unknown>;
				await site.sealGeneration();
				return { created, edited, records: (await log(site, before)).records };
			});

			// THE CONTROL: a workload that threw records nothing, which reads the same as a fix
			expect(out.created['ok'], JSON.stringify(out.created).slice(0, 300)).toBe(true);
			expect(out.edited['ok'], JSON.stringify(out.edited).slice(0, 300)).toBe(true);
			expect(out.records.length).toBe(1);

			const counts = new Map<string, number>();
			for (const st of out.records[0]?.statements ?? []) {
				const shape = st.sql.replace(/\s+/g, ' ').trim();
				counts.set(shape, (counts.get(shape) ?? 0) + 1);
			}
			const revisions = [...counts].find(([sql]) =>
				/^INSERT INTO "node_revision"/i.test(sql)
			);
			expect(revisions?.[1], 'one save inserted more than one revision into the log').toBe(1);
			// and nothing else repeated either, which is what makes the assertion above a property
			// rather than one table getting lucky
			const repeated = [...counts].filter(([, n]) => n > 1);
			expect(
				repeated,
				`statements recorded more than once: ${JSON.stringify(repeated)}`
			).toEqual([]);
		},
		TIMEOUT
	);
});
