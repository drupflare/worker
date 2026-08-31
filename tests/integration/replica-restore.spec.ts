import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../src/drupal/site-php';
import type { RestoreChunk, TableVerdict } from '../../src/ops/replica-restore';
import { positionTrust, readPosition } from '../../src/ops/replication-log';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The bulk copy, end to end, on real objects.
 *
 * The log alone cannot start a replica: `planApply()` requires each record to build on the one
 * before it, so an empty object can never reach a primary that is thousands of generations along.
 * This is the other half, and the property that matters is not that rows arrive -- it is that a
 * replica which has NOT finished a copy is never mistaken for one that has.
 *
 * `system.private_key` is the assertion that carries the point. A replica that installed itself
 * minted its own, and two objects each keying CSRF tokens on a different one issue tokens the other
 * rejects, intermittently, for whichever visitors they happened to serve. After a restore the
 * replica must hold the PRIMARY's value, not its own.
 */

const TIMEOUT = 900_000;
const PASS = 'cfw-Restore-Pass-4413';

type Plan = { generation: number; schemaVersion: string; tables: TableVerdict[] };
type Page = { columns: string[]; rows: unknown[][] };

function role(site: ServeDo, as: 'primary' | 'replica'): void {
	// `site.env` is the module-scope env shared by every object in the lane, so the role is set
	// explicitly at every phase rather than reset afterwards
	(site.env as Record<string, unknown>).REPLICA_READ_ONLY = as === 'replica' ? '1' : '0';
}

/**
 * Mints `system.private_key`, which a fresh install does NOT have.
 *
 * Drupal creates it on first use, so a site that has only been provisioned holds no value for it and
 * the snapshot route refuses to be copied from. That is not a fixture detail: it is the precondition
 * a primary has to meet before it can have replicas at all.
 */
async function mintIdentity(site: ServeDo): Promise<void> {
	const out = (await site.runJson(
		drupalOp(`$out['key'] = strlen(\\Drupal::service('private_key')->get());`)
	)) as { ok?: boolean; key?: number };
	expect(out?.ok, `minting failed: ${JSON.stringify(out).slice(0, 300)}`).toBe(true);
	expect(out?.key).toBeGreaterThan(0);
}

async function install(site: ServeDo, name: string): Promise<void> {
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	const res = await site.fetch(
		new Request('https://do.local/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ adminPass: PASS, siteName: name }),
			headers: { 'content-type': 'application/json' }
		})
	);
	expect(res.status, await res.clone().text()).toBeLessThan(400);
}

/** every copyable table of a primary, read through the shipping route */
async function snapshot(site: ServeDo): Promise<{ plan: Plan; pages: RestoreChunk[] }> {
	const res = await site.fetch(new Request('https://do.local/__replica?action=snapshot'));
	expect(res.status, await res.clone().text()).toBe(200);
	const plan = (await res.json()) as Plan;
	const pages: RestoreChunk[] = [];
	for (const table of plan.tables.filter((t) => t.copy)) {
		let offset = 0;
		let first = true;
		for (;;) {
			const page = (await (
				await site.fetch(
					new Request(
						`https://do.local/__replica?action=snapshot&table=${table.table}&offset=${offset}&limit=400`
					)
				)
			).json()) as Page & { generation: number; schemaVersion: string; ddl: string[] };
			// an empty first page still has to land, or the replica keeps whatever it had
			if (page.rows.length === 0 && !first) break;
			pages.push({
				generation: page.generation,
				schemaVersion: page.schemaVersion,
				table: table.table,
				columns: page.columns.length > 0 ? page.columns : ['x'],
				rows: page.rows,
				ddl: page.ddl,
				first
			});
			first = false;
			offset += page.rows.length;
			if (page.rows.length < 400) break;
		}
	}
	// the driver states what the copy will deliver; the replica holds it to that rather than
	// trusting the `done` flag
	if (pages[0] !== undefined) {
		pages[0] = { ...pages[0], expect: plan.tables.filter((t) => t.copy).map((t) => t.table) };
	}
	return { plan, pages };
}

/** `exec` binds varargs, not an array; an array binds as one parameter and matches nothing */
function privateKeyOf(site: ServeDo): unknown {
	const row = site.sql
		.exec(
			`SELECT value FROM key_value WHERE collection = 'state' AND name = ?`,
			'system.private_key'
		)
		.toArray()[0] as { value: unknown } | undefined;
	return row?.value;
}

type Landing = { ok: boolean; reason: string; stage: string; missing: string[] };

async function land(site: ServeDo, chunk: RestoreChunk, restart = false): Promise<Landing> {
	const res = await site.fetch(
		new Request(`https://do.local/__replica?action=restore${restart ? '&restart=1' : ''}`, {
			method: 'POST',
			body: JSON.stringify(chunk),
			headers: { 'content-type': 'application/json' }
		})
	);
	return (await res.json()) as Landing;
}

/** a primary installed and snapshotted; shared by the cases below because installing twice is slow */
async function primary(): Promise<{
	plan: Plan;
	pages: RestoreChunk[];
	privateKey: unknown;
}> {
	return inObject(freshSite(), async (site) => {
		role(site, 'primary');
		await install(site, 'Restore Primary');
		await mintIdentity(site);
		const out = await snapshot(site);
		return { ...out, privateKey: privateKeyOf(site) };
	});
}

describe('a replica reaches VERIFIED only by a whole consistent copy', () => {
	it(
		'copies the primary and lands on its generation, holding the primary key rather than its own',
		async () => {
			const src = await primary();
			expect(src.privateKey, 'the primary minted no private key').toBeTruthy();
			// the copyable set is not everything: the replica owns its own caches and page store
			expect(src.plan.tables.some((t) => !t.copy && t.status === 'LOCAL_EPHEMERAL')).toBe(
				true
			);
			expect(src.pages.length).toBeGreaterThan(0);

			const out = await inObject(freshSite(), async (site) => {
				role(site, 'primary');
				// the replica installs itself first, so it holds a schema AND a private key of its own
				await install(site, 'Restore Replica');
				await mintIdentity(site);
				const ownKey = privateKeyOf(site);

				role(site, 'replica');
				const landings: Landing[] = [];
				for (const [i, page] of src.pages.entries()) {
					landings.push(await land(site, { ...page, done: i === src.pages.length - 1 }));
				}
				return {
					ownKey,
					afterKey: privateKeyOf(site),
					landings,
					stage: site.replicaStage(),
					applied: site.commitSeq(),
					trust: positionTrust(readPosition(site.logStore()))
				};
			});

			const refused = out.landings.filter((l) => !l.ok);
			expect(refused.map((l) => l.reason)).toEqual([]);
			expect(out.stage).toBe('VERIFIED');
			expect(out.applied).toBe(src.plan.generation);
			expect(out.trust.trusted).toBe(true);

			// THE CONTROL: the replica really did have a different key before the copy, so the
			// assertion below is about replication rather than about two installs coinciding
			expect(out.ownKey, 'the replica minted no key of its own').toBeTruthy();
			expect(out.ownKey).not.toBe(src.privateKey);
			expect(out.afterKey).toBe(src.privateKey);
		},
		TIMEOUT
	);

	it(
		'refuses a chunk read at a different generation, and stays untrusted',
		async () => {
			const src = await primary();
			const out = await inObject(freshSite(), async (site) => {
				role(site, 'primary');
				await install(site, 'Torn Replica');
				role(site, 'replica');
				const first = await land(site, src.pages[0]!);
				// the primary committed something between the two reads
				const torn = await land(site, {
					...src.pages[1]!,
					generation: src.plan.generation + 1,
					done: true
				});
				return {
					first,
					torn,
					stage: site.replicaStage(),
					trust: positionTrust(readPosition(site.logStore()))
				};
			});

			expect(out.first.ok).toBe(true);
			expect(out.torn.ok).toBe(false);
			expect(out.torn.reason).toContain('torn copy');
			// RESTORING, never VERIFIED, and the position is not a number anyone may act on
			expect(out.stage).toBe('RESTORING');
			expect(out.trust.trusted).toBe(false);
		},
		TIMEOUT
	);

	it(
		'refuses to finish while a value the replica cannot mint is missing',
		async () => {
			const src = await primary();
			const out = await inObject(freshSite(), async (site) => {
				role(site, 'primary');
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				role(site, 'replica');
				// one table only, marked done: the shape of a copy that stopped early and said it
				// had not
				const only = src.pages.find((p) => p.table === 'config') ?? src.pages[0]!;
				const landed = await land(site, { ...only, first: true, done: true });
				return {
					landed,
					stage: site.replicaStage(),
					trust: positionTrust(readPosition(site.logStore()))
				};
			});

			expect(out.landed.ok).toBe(false);
			expect(out.landed.reason).toContain('restore incomplete');
			expect(out.landed.missing).toContain('state:system.private_key');
			expect(out.stage).toBe('RESTORING');
			expect(out.trust.trusted).toBe(false);
		},
		TIMEOUT
	);

	it(
		'refuses a restore aimed at a primary',
		async () => {
			const src = await primary();
			const status = await inObject(freshSite(), async (site) => {
				role(site, 'primary');
				const res = await site.fetch(
					new Request('https://do.local/__replica?action=restore', {
						method: 'POST',
						body: JSON.stringify(src.pages[0]),
						headers: { 'content-type': 'application/json' }
					})
				);
				return res.status;
			});
			// a restore clears the tables it copies, so aiming one at the object that owns the state
			// is the most destructive thing this route could do
			expect(status).toBe(409);
		},
		TIMEOUT
	);

	it(
		'refuses a done that arrives before every promised table has landed',
		async () => {
			const src = await primary();
			const out = await inObject(freshSite(), async (site) => {
				role(site, 'primary');
				await install(site, 'Early Done Replica');
				await mintIdentity(site);
				role(site, 'replica');
				// the first chunk promises the whole copy; the driver then claims `done` on it
				const landed = await land(site, { ...src.pages[0]!, done: true });
				return { landed, stage: site.replicaStage() };
			});

			// the mandatory set is PRESENT -- this replica installed itself -- so nothing but the
			// promised-table check stands between a partial copy and VERIFIED
			expect(out.landed.missing).not.toContain('state:system.private_key');
			expect(out.landed.ok).toBe(false);
			expect(out.landed.reason).toContain('table:');
			expect(out.stage).toBe('RESTORING');
		},
		TIMEOUT
	);

	it(
		'restarts an abandoned copy instead of refusing every retry as torn',
		async () => {
			const src = await primary();
			const out = await inObject(freshSite(), async (site) => {
				role(site, 'primary');
				await install(site, 'Restart Replica');
				role(site, 'replica');
				// a copy that began and was interrupted
				await land(site, src.pages[0]!);
				// a fresh attempt at a LATER generation is torn against the abandoned one...
				const stuck = await land(site, {
					...src.pages[0]!,
					generation: src.plan.generation + 5
				});
				// ...until the restart clears it
				const after = await land(
					site,
					{ ...src.pages[0]!, generation: src.plan.generation + 5 },
					true
				);
				return { stuck, after };
			});

			expect(out.stuck.ok).toBe(false);
			expect(out.stuck.reason).toContain('torn copy');
			// without this there is no exit short of editing cfw_meta by hand
			expect(out.after.ok, out.after.reason).toBe(true);
		},
		TIMEOUT
	);

	it(
		'refuses to be copied from before the primary has minted its own identity',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				role(site, 'primary');
				await install(site, 'Unminted Primary');
				const res = await site.fetch(
					new Request('https://do.local/__replica?action=snapshot')
				);
				return { status: res.status, body: (await res.json()) as { missing: string[] } };
			});

			// a fresh install has `system.cron_key`, `install_time` and `install_task` but NOT
			// `system.private_key`; copying it would hand every replica the same absence, and
			// whichever reached the code path first would mint a key the others reject
			expect(out.status).toBe(409);
			expect(out.body.missing).toEqual(['state:system.private_key']);
		},
		TIMEOUT
	);

	it(
		'refuses to snapshot a table the replica owns itself',
		async () => {
			const status = await inObject(freshSite(), async (site) => {
				role(site, 'primary');
				const res = await site.fetch(
					new Request('https://do.local/__replica?action=snapshot&table=cfw_page')
				);
				return res.status;
			});
			expect(status).toBe(409);
		},
		TIMEOUT
	);
});
