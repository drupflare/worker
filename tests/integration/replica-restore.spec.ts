import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../src/drupal/site-php';
import type { RestoreChunk, TableVerdict } from '../../src/ops/replica-restore';
import { positionTrust, readPosition } from '../../src/ops/replication-log';
import { ORIGIN_KEY } from '../../src/ops/site-origin';
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
 * Mints `system.private_key` if the claim has not already.
 *
 * **`/__firstrun` MINTS IT NOW, and until it did this helper was hiding the defect.** Drupal
 * creates the value on first use, so a migrated-and-claimed site held none and the snapshot route
 * refused to be copied from -- correctly, since two objects each minting their own issue CSRF
 * tokens the other rejects. Every spec here called this helper, so the refusal always had a primary
 * to accept while no real site ever reached that state, and a replica of a genuinely fresh site was
 * refused forever with nothing reporting it. Measured: three lanes sat at `CREATED` through 40
 * provision steps each, then reached `VERIFIED` in 1 step each once a single form render had minted
 * the key.
 *
 * Kept as a no-op-when-present assertion rather than deleted, because it is the precondition a
 * primary has to meet before it can have replicas at all and this is where that is stated.
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

/** the host the deployed pool actually pinned: a load generator's service-binding URL */
const POISON = 'https://arm.invalid';
/** what the primary renders against, and therefore what every lane must */
const INHERITED = 'https://primary.example';

function originOf(site: ServeDo): string | null {
	const row = site.sql.exec(`SELECT v FROM cfw_meta WHERE k = ?`, ORIGIN_KEY).toArray()[0] as
		{ v: string } | undefined;
	return row?.v ?? null;
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
				// CONSTRUCTED, not merely un-minted. The claim mints the key now, so declining to
				// mint no longer produces this state -- and the state is still worth refusing: a
				// site provisioned before that landed, or one restored from a database taken
				// before it, reaches the snapshot route without a key
				site.sql.exec(
					"DELETE FROM key_value WHERE collection = 'state' AND name = 'system.private_key'"
				);
				const res = await site.fetch(
					new Request('https://do.local/__replica?action=snapshot')
				);
				return { status: res.status, body: (await res.json()) as { missing: string[] } };
			});

			// copying a primary without one would hand every replica the same absence, and
			// whichever reached the code path first would mint a key the others reject
			expect(out.status).toBe(409);
			expect(out.body.missing).toEqual(['state:system.private_key']);
		},
		TIMEOUT
	);

	it(
		'refuses to snapshot a table the replica owns itself',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				role(site, 'primary');
				const owned = await site.fetch(
					new Request('https://do.local/__replica?action=snapshot&table=cfw_shell')
				);
				// and the seeded one is NOT refused, which is what makes the refusal mean
				// something rather than reading as "snapshot rejects the cfw_ prefix"
				const seeded = await site.fetch(
					new Request('https://do.local/__replica?action=snapshot&table=cfw_page')
				);
				return { owned: owned.status, seeded: seeded.status };
			});
			expect(out.owned).toBe(409);
			expect(out.seeded).toBe(200);
		},
		TIMEOUT
	);
});

/**
 * The origin a lane renders against, which decides whether it can see a session at all.
 *
 * Drupal builds the session cookie NAME from the request host, so two objects rendering against
 * different hosts look for differently-named cookies. A lane that pinned its own therefore held
 * every replicated session row and still resolved every visitor as uid 0 -- measured on a deployed
 * 32-lane pool, where all 32 pinned the load generator's service-binding host.
 */
describe('a lane inherits the origin rather than pinning one of its own', () => {
	it(
		'lands the primary origin, and a later request on another host cannot overwrite it',
		async () => {
			const src = await primary();
			const out = await inObject(freshSite(), async (site) => {
				role(site, 'primary');
				await install(site, 'Origin Replica');

				// THE CONTROL: a PRIMARY observing this host does pin it, so the assertion below
				// is about lanes rather than about pinning having stopped working
				site.canonicalOrigin(POISON);
				const primaryPinned = originOf(site);

				role(site, 'replica');

				// A LANE PROVISIONED BEFORE THE INHERIT HAS NO PIN AT ALL, which is the only state
				// the guard in `canonicalOrigin()` can be reached in: once a pin exists
				// `chooseOrigin()` answers `pinned` and never reaches the write at all
				site.sql.exec(`DELETE FROM cfw_meta WHERE k = ?`, ORIGIN_KEY);
				const unpinnedRender = site.canonicalOrigin(POISON);
				const unpinnedStored = originOf(site);

				const landings: Landing[] = [];
				for (const [i, page] of src.pages.entries()) {
					landings.push(
						await land(site, {
							...page,
							...(i === 0 ? { origin: INHERITED } : {}),
							done: i === src.pages.length - 1
						})
					);
				}
				const afterCopy = originOf(site);

				// the shape that broke the pool: a request arrives on a host no browser sends
				const rendered = site.canonicalOrigin(POISON);
				return {
					primaryPinned,
					unpinnedRender,
					unpinnedStored,
					afterCopy,
					rendered,
					settled: originOf(site),
					landings
				};
			});

			expect(out.landings.filter((l) => !l.ok).map((l) => l.reason)).toEqual([]);
			expect(out.primaryPinned).toBe(POISON);
			// an unpinned lane renders against what it sees, which is right, and writes down
			// nothing, which is what stops one stray request fixing the host forever
			expect(out.unpinnedRender).toBe(POISON);
			expect(out.unpinnedStored).toBeNull();
			// the copy replaced the lane's own pin with the primary's
			expect(out.afterCopy).toBe(INHERITED);
			// and the stray host neither renders against nor overwrites it
			expect(out.rendered).toBe(INHERITED);
			expect(out.settled).toBe(INHERITED);
		},
		TIMEOUT
	);

	// it signs form tokens, so a lane with its own salt refused every form the primary rendered and
	// the primary refused every form the lane rendered
	it(
		'lands the primary hash salt over one the lane minted for itself',
		async () => {
			const src = await primary();
			const SALT = 'primary-salt-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6_-';
			const out = await inObject(freshSite(), async (site) => {
				role(site, 'primary');
				await install(site, 'Salt Replica');
				role(site, 'replica');
				site.metaSet(
					'hash_salt',
					'lane-own-salt-Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2H1g0F9e8D7c6B5a4'
				);
				const landings: Landing[] = [];
				for (const [i, page] of src.pages.entries()) {
					landings.push(
						await land(site, {
							...page,
							...(i === 0 ? { hashSalt: SALT } : {}),
							done: i === src.pages.length - 1
						})
					);
				}
				return { landings, salt: site.metaGet('hash_salt') };
			});
			expect(out.landings.filter((l) => !l.ok).map((l) => l.reason)).toEqual([]);
			expect(out.salt).toBe(SALT);
		},
		TIMEOUT
	);
});
