import { describe, expect, it } from 'vitest';
import { reconcileRouterPhp } from '../../../src/drupal/reconcile-php';
import {
	DRIVER_DIGEST,
	DRIVER_ROUTES,
	DRIVER_ROUTE_PERMISSIONS
} from '../../../src/ops/driver-digest';
import {
	base64Bytes,
	extensionFingerprint,
	packedContainerFor,
	type PackedContainer
} from '../../../src/ops/packed-container';
import {
	CLEAN_RECONCILE,
	DRIVER_DIGEST_KEY,
	PACK_VERSION,
	RECONCILE_STEPS,
	RETIRED_PERMISSIONS,
	SHIPPED_PAGE_MAX_AGE,
	STEP_ATTEMPT_LIMIT,
	configMaxAge,
	parseReconcileState,
	planReconcile,
	reconcileReport,
	reconciled,
	recordStep,
	rolesHoldingRetired,
	serialiseReconcileState,
	serialisedInt,
	staleRoutePermissions,
	versionReached,
	type ReconcileHost,
	type ReconcileSql,
	type ReconcileState,
	type ReconcileStep
} from '../../../src/ops/reconcile';

/**
 * The delivery path for a fix the pack cannot carry backwards.
 *
 * Everything here is about one property: a step's success condition is the site's END STATE, never
 * that the step ran. Two Outstanding Bugs closed on the weaker assertion and neither site converged.
 */

/** a sql seam over plain maps, so a step's observation is drivable without a database */
function fakeSql(tables: Record<string, Record<string, unknown>[]>): ReconcileSql & {
	deleted: string[];
} {
	const deleted: string[] = [];
	return {
		deleted,
		exec(sql: string, ...bindings: unknown[]) {
			const into = /^\s*INSERT INTO\s+([a-z_]+)\s*\(([^)]*)\)/i.exec(sql);
			if (into) {
				const cols = (into[2] ?? '').split(',').map((c) => c.trim());
				const row = Object.fromEntries(cols.map((c, i) => [c, bindings[i]]));
				(tables[into[1] as string] ??= []).push(row);
				return { toArray: () => [] };
			}
			const from = /FROM\s+([a-z_]+)/i.exec(sql)?.[1] ?? '';
			if (/^\s*DELETE/i.test(sql)) {
				const target = /DELETE FROM\s+([a-z_]+)/i.exec(sql)?.[1] ?? '';
				deleted.push(target);
				const rows = tables[target];
				if (rows) {
					const before = Number(bindings[0] ?? Infinity);
					tables[target] = rows.filter((r) => Number(r.timestamp ?? -Infinity) >= before);
				}
				return { toArray: () => [] };
			}
			const rows = tables[from];
			if (rows === undefined) throw new Error(`no such table: ${from}`);
			if (/COUNT\(/i.test(sql)) {
				// `name IN (?, ?, ...)` is the router step's shape; without it a COUNT would answer
				// with the whole table and the step would read satisfied on a site missing every route
				if (/name IN \(/i.test(sql)) {
					const wanted = new Set(bindings.map(String));
					return {
						toArray: () => [
							{ n: rows.filter((r) => wanted.has(String(r.name))).length }
						]
					};
				}
				// `col = ?` pairs, bound in order
				const equal = [...sql.matchAll(/(\w+) = \?/g)].map((m) => m[1] as string);
				if (equal.length > 0) {
					const n = rows.filter((r) =>
						equal.every((col, i) => String(r[col]) === String(bindings[i]))
					).length;
					return { toArray: () => [{ n }] };
				}
				const before = Number(bindings[0] ?? Infinity);
				const n = /timestamp <\s*\?/.test(sql)
					? rows.filter((r) => Number(r.timestamp) < before).length
					: rows.length;
				return { toArray: () => [{ n }] };
			}
			if (/WHERE (name|cid) = \?/.test(sql)) {
				const key = /WHERE (name|cid)/.exec(sql)?.[1] as string;
				const hit = rows.find((r) => r[key] === bindings[0]);
				return { toArray: () => (hit ? [hit] : []) };
			}
			return { toArray: () => rows };
		}
	};
}

function fakeHost(claimedAtMs: number | null, meta: Record<string, string> = {}): ReconcileHost {
	return {
		claimedAtMs: () => claimedAtMs,
		meta: (k) => meta[k] ?? null,
		setMeta: (k, v) => {
			meta[k] = v;
		},
		origin: () => 'https://site.example'
	};
}

/** a serialized `system.performance` carrying one max_age, which is what the row really holds */
function performanceRow(maxAge: number): string {
	return `a:1:{s:5:"cache";a:1:{s:4:"page";a:1:{s:7:"max_age";i:${maxAge};}}}`;
}

describe('reading the two copies of a config object', () => {
	it('reads the row and the cache bin that shadows it', () => {
		const sql = fakeSql({
			config: [{ name: 'system.performance', data: performanceRow(300) }],
			cache_config: [{ cid: 'system.performance', data: performanceRow(0) }]
		});
		expect(configMaxAge(sql)).toEqual({ config: 300, cached: 0 });
	});

	it('reports an absent cache bin as null rather than as zero', () => {
		const sql = fakeSql({
			config: [{ name: 'system.performance', data: performanceRow(300) }],
			cache_config: []
		});
		expect(configMaxAge(sql)).toEqual({ config: 300, cached: null });
	});

	/**
	 * The defect this whole step exists for. `config` said 300 and `cache_config` kept its own 0,
	 * Drupal reads the bin first, so every render on every site answered `no-store` and `cfw_page`
	 * stayed empty while the fix was believed shipped.
	 */
	it('calls a site with disagreeing copies owed, not satisfied', () => {
		const step = RECONCILE_STEPS.find((s) => s.id === 'page-max-age') as ReconcileStep;
		const sql = fakeSql({
			config: [{ name: 'system.performance', data: performanceRow(300) }],
			cache_config: [{ cid: 'system.performance', data: performanceRow(0) }]
		});
		expect(step.verdict(sql, fakeHost(1_000)).state).toBe('owed');
	});

	it('calls a site whose copies agree satisfied', () => {
		const step = RECONCILE_STEPS.find((s) => s.id === 'page-max-age') as ReconcileStep;
		const sql = fakeSql({
			config: [{ name: 'system.performance', data: performanceRow(300) }],
			cache_config: [{ cid: 'system.performance', data: performanceRow(300) }]
		});
		expect(step.verdict(sql, fakeHost(1_000)).state).toBe('satisfied');
	});

	it('emits a fragment that writes the shipped value through the config factory', () => {
		const step = RECONCILE_STEPS.find((s) => s.id === 'page-max-age') as ReconcileStep;
		const php = step.php?.(fakeHost(1_000)) ?? '';
		expect(php).toContain("getEditable('system.performance')");
		expect(php).toContain(`set('cache.page.max_age', ${SHIPPED_PAGE_MAX_AGE})`);
		// a SQL update would be the inert fix again; the whole reason for PHP is that ConfigFactory
		// already clears the bin and invalidates the tag
		expect(php).not.toContain('UPDATE config');
	});
});

describe('a serialized integer is parsed, not cast', () => {
	it('reads an int', () => {
		expect(serialisedInt('i:1786258127;')).toBe(1786258127);
	});

	it('refuses a serialized STRING that a REPLACE-based cast would read as a number', () => {
		expect(serialisedInt('s:10:"1786258127";')).toBeNull();
	});
});

describe("the bake's own history", () => {
	const step = RECONCILE_STEPS.find((s) => s.id === 'bake-watchdog') as ReconcileStep;

	it('defers on an unclaimed site, because no row can be shown to be foreign', () => {
		const sql = fakeSql({ watchdog: [{ timestamp: 1_000 }] });
		expect(step.verdict(sql, fakeHost(null)).state).toBe('deferred');
	});

	it('owes a claimed site whose log predates it', () => {
		const sql = fakeSql({ watchdog: [{ timestamp: 1_000 }, { timestamp: 9_000 }] });
		const verdict = step.verdict(sql, fakeHost(5_000_000));
		expect(verdict.state).toBe('owed');
	});

	it("deletes only what predates the claim, so the site's own log survives", () => {
		const tables = { watchdog: [{ timestamp: 1_000 }, { timestamp: 9_000 }] };
		const sql = fakeSql(tables);
		const host = fakeHost(5_000_000);
		step.sql?.(sql, host);
		expect(tables.watchdog).toEqual([{ timestamp: 9_000 }]);
		expect(step.verdict(sql, host).state).toBe('satisfied');
	});

	it('is satisfied on a pack with no dblog rather than failing on the missing table', () => {
		expect(step.verdict(fakeSql({}), fakeHost(5_000_000)).state).toBe('satisfied');
	});
});

describe('the container step, which is the general close for a hook added after the bake', () => {
	const step = RECONCILE_STEPS.find((s) => s.id === 'container-driver-digest') as ReconcileStep;

	it('owes a site whose recorded digest does not match the pack', () => {
		const sql = fakeSql({ cache_container: [{ cid: 'x' }] });
		expect(step.verdict(sql, fakeHost(1_000, { driver_digest: 'stale' })).state).toBe('owed');
	});

	/**
	 * The apply writes its own marker, and it has to.
	 *
	 * The verdict runs immediately after the apply, so a step whose end state IS a recorded value
	 * would read the old one and be filed as failed on the run that succeeded.
	 */
	it('drops the container and records the digest in the same apply', () => {
		const tables = { cache_container: [{ cid: 'x' }] };
		const sql = fakeSql(tables);
		const meta: Record<string, string> = { driver_digest: 'stale' };
		const host = fakeHost(1_000, meta);
		step.sql?.(sql, host);
		expect(sql.deleted).toContain('cache_container');
		expect(step.verdict(sql, host).state).toBe('satisfied');
	});

	/**
	 * The pack's row instead of a rebuild, when it can be trusted.
	 *
	 * Measured 2026-09-25 on a deployed site: after a driver-pack update the rebuilding fill
	 * completed and the next invocation was reset for the isolate's memory, taking a waiting
	 * visitor with it. A container baked against this driver for this module set needs no rebuild.
	 */
	const bytes = new Uint8Array([0, 1, 2, 250, 0, 7]);
	const packed = (driver: string, modules: string): PackedContainer => ({
		driver,
		variants: [
			{
				modules,
				rows: [
					{
						cid: 'service_container:prod:x',
						data: btoa(String.fromCharCode(...bytes)),
						expire: -1,
						created: 1,
						serialized: 1,
						tags: '',
						checksum: '0.0'
					}
				]
			}
		]
	});
	const withPack = (p: PackedContainer, siteModules: string) => {
		const tables: Record<string, Record<string, unknown>[]> = {
			cache_container: [{ cid: 'stale' }],
			cache_discovery: [{ cid: 'd' }]
		};
		const sql = fakeSql(tables);
		const host: ReconcileHost = {
			...fakeHost(1_000, { driver_digest: 'stale' }),
			packedContainer: () => p,
			modules: () => siteModules
		};
		step.sql?.(sql, host);
		return { tables, sql, host };
	};

	it('writes the packed row when it was baked against this driver for these modules', () => {
		const { tables, sql, host } = withPack(packed(DRIVER_DIGEST, 'm:1'), 'm:1');
		expect(tables.cache_container).toHaveLength(1);
		expect(tables.cache_container?.[0]?.cid).toBe('service_container:prod:x');
		// bytes intact, NULs included, which is why the file carries base64
		expect([...(tables.cache_container?.[0]?.data as Uint8Array)]).toEqual([...bytes]);
		// discovery still goes: tabs are discovery-cached and the new driver may add one
		expect(sql.deleted).toContain('cache_discovery');
		expect(step.verdict(sql, host).state).toBe('satisfied');
	});

	it('rebuilds instead on a different module set, a stale bake, or no bake at all', () => {
		expect(withPack(packed(DRIVER_DIGEST, 'm:1'), 'm:2').tables.cache_container).toHaveLength(
			0
		);
		expect(withPack(packed('older', 'm:1'), 'm:1').tables.cache_container).toHaveLength(0);
		expect(withPack(packed('', 'm:1'), 'm:1').tables.cache_container).toHaveLength(0);
		// an unreadable core.extension is not a match for anything
		expect(withPack(packed(DRIVER_DIGEST, 'm:1'), '').tables.cache_container).toHaveLength(0);
	});
});

describe('the packed container file', () => {
	it('picks the variant for the module set, and the fingerprint is stable', () => {
		const text = 'a:1:{s:6:"module";a:1:{s:4:"node";i:0;}}';
		expect(extensionFingerprint(text)).toBe(extensionFingerprint(text));
		expect(extensionFingerprint(text)).not.toBe(extensionFingerprint(`${text} `));
		expect(extensionFingerprint('')).toBe('');
		const file: PackedContainer = {
			driver: 'd',
			variants: [
				{ modules: 'a', rows: [] },
				{
					modules: 'b',
					rows: [
						{
							cid: 'c',
							data: '',
							expire: -1,
							created: 0,
							serialized: 1,
							tags: '',
							checksum: '0'
						}
					]
				}
			]
		};
		expect(packedContainerFor(file, 'd', 'b')?.[0]?.cid).toBe('c');
		// a variant with no rows is not a container
		expect(packedContainerFor(file, 'd', 'a')).toBeNull();
		expect(packedContainerFor(null, 'd', 'b')).toBeNull();
	});

	it('round-trips bytes through base64', () => {
		const raw = new Uint8Array([0, 255, 128, 0]);
		expect([...base64Bytes(btoa(String.fromCharCode(...raw)))]).toEqual([...raw]);
	});
});

describe('the owner-tier step', () => {
	const step = RECONCILE_STEPS.find((s) => s.id === 'owner-tiers') as ReconcileStep;
	const role = (id: string, perms: string[]) => ({
		name: `user.role.${id}`,
		data: new TextEncoder().encode(
			`a:1:{s:11:"permissions";a:${perms.length}:{${perms
				.map((p, i) => `i:${i};s:${p.length}:"${p}";`)
				.join('')}}}`
		)
	});
	const owned = {
		user__roles: [{ entity_id: 1, roles_target_id: 'drupflare_owner' }]
	};

	it('waits for a claim, since there is no owner before one', () => {
		expect(step.verdict(fakeSql({ config: [] }), fakeHost(null)).state).toBe('deferred');
	});

	it('owes a role still holding a retired name, matched exactly', () => {
		const sql = fakeSql({
			...owned,
			config: [
				role('drupflare_owner', ['administer drupflare owner']),
				role('editor', ['administer drupflare settings']),
				// `administer drupflare` is a prefix of the new names and must not match them
				role('staff', ['administer drupflare site'])
			]
		});
		expect(rolesHoldingRetired(sql)).toEqual(['editor']);
		expect(step.verdict(sql, fakeHost(1_000)).state).toBe('owed');
	});

	it('owes a claimed site with no owner role, or a uid 1 without it', () => {
		const noRole = fakeSql({ ...owned, config: [] });
		expect(step.verdict(noRole, fakeHost(1_000)).state).toBe('owed');
		const unheld = fakeSql({
			user__roles: [],
			config: [role('drupflare_owner', ['administer drupflare owner'])]
		});
		expect(step.verdict(unheld, fakeHost(1_000)).state).toBe('owed');
	});

	it('is satisfied once the role exists, uid 1 holds it and nothing retired remains', () => {
		const sql = fakeSql({
			...owned,
			config: [role('drupflare_owner', ['administer drupflare owner'])]
		});
		expect(step.verdict(sql, fakeHost(1_000)).state).toBe('satisfied');
	});

	it('hands the fragment every retired name and the tier it became', () => {
		const php = step.php?.(fakeHost(1_000)) ?? '';
		for (const [old, now] of Object.entries(RETIRED_PERMISSIONS)) {
			expect(php).toContain(old);
			expect(php).toContain(now);
		}
		expect(php).toContain('OwnerTier::establish');
	});
});

describe('the unread node index step', () => {
	const step = RECONCILE_STEPS.find((s) => s.id === 'node-unread-indexes') as ReconcileStep;

	it('owes a site that still carries any of the three, and drops them by SQL', () => {
		const sql = fakeSql({
			sqlite_master: [
				{ type: 'index', name: 'node_field_data_node__vid' },
				{ type: 'index', name: 'node_field_data_node__status_type' }
			]
		});
		const verdict = step.verdict(sql, fakeHost(null));
		expect(verdict.state).toBe('owed');
		// no claim is needed: an index is schema, not something a birthday decides
		expect(step.php).toBeUndefined();
		expect(step.sql).toBeDefined();
	});

	it('is satisfied when none remains, whatever else the table is indexed on', () => {
		const sql = fakeSql({
			sqlite_master: [{ type: 'index', name: 'node_field_data_node__status_type' }]
		});
		expect(step.verdict(sql, fakeHost(null)).state).toBe('satisfied');
	});
});

describe('the router step, which was 404 on every site', () => {
	const step = RECONCILE_STEPS.find((s) => s.id === 'router-driver-routes') as ReconcileStep;
	const host = fakeHost(1_000);

	/**
	 * The measurement this step exists for.
	 *
	 * Rebuilding the pack database from `install-site-db.php` on 2026-09-09 produced four
	 * `drupflare.*` routes and three menu links; the shipped pack has `drupflare` in
	 * `core.extension` and none of the seven. So the Drupflare admin section, Runtime Status and the
	 * Operations Terminal answered 404 everywhere.
	 */
	it('owes a site whose router has none of the driver routes', () => {
		const sql = fakeSql({ router: [{ name: 'system.admin' }, { name: 'user.login' }] });
		const verdict = step.verdict(sql, host);
		expect(verdict.state).toBe('owed');
		if (verdict.state === 'owed')
			expect(verdict.detail).toContain(`0 of ${DRIVER_ROUTES.length}`);
	});

	it('owes a site that has SOME of them, which a count of rows could not detect', () => {
		const sql = fakeSql({
			router: [{ name: 'user.login' }, { name: DRIVER_ROUTES[0] as string }]
		});
		expect(step.verdict(sql, host).state).toBe('owed');
	});

	it('is satisfied once every declared route is present', () => {
		const sql = fakeSql({ router: DRIVER_ROUTES.map((name) => ({ name })) });
		expect(step.verdict(sql, host).state).toBe('satisfied');
	});

	it('defers rather than failing on a pack with no router table at all', () => {
		expect(step.verdict(fakeSql({}), host).state).toBe('deferred');
	});

	/** a row keeps the requirement it was built with, which the name count cannot see */
	const routeRow = (name: string, permission: string) => ({
		name,
		route: `O:31:"Symfony\\Component\\Routing\\Route":1:{s:12:"requirements";a:1:{s:11:"_permission";s:${permission.length}:"${permission}";}}`
	});

	it('owes a site whose route rows require a permission the pack renamed', () => {
		const rows = DRIVER_ROUTES.map((name) =>
			routeRow(name, DRIVER_ROUTE_PERMISSIONS[name] ?? 'access content')
		);
		rows[rows.findIndex((r) => r.name === 'drupflare.settings')] = routeRow(
			'drupflare.settings',
			'administer drupflare settings'
		);
		const verdict = step.verdict(fakeSql({ router: rows }), host);
		expect(verdict.state).toBe('owed');
		if (verdict.state === 'owed') expect(verdict.detail).toContain('drupflare.settings');
	});

	it('is satisfied when every row requires what the pack declares', () => {
		const rows = DRIVER_ROUTES.map((name) =>
			routeRow(name, DRIVER_ROUTE_PERMISSIONS[name] ?? 'access content')
		);
		expect(staleRoutePermissions(fakeSql({ router: rows }))).toEqual([]);
	});

	/**
	 * NO `sql()`, and that is the correctness property rather than an omission.
	 *
	 * `applyReconcileStep` runs `sql()` before `php()`, so a step that stamped a marker in `sql()`
	 * would stamp it even when the PHP rebuild threw, and the verdict immediately afterwards would
	 * read the marker and file the failure as a success.
	 */
	it('records nothing itself, so a failed rebuild cannot read as done', () => {
		expect(step.sql).toBeUndefined();
		expect(step.php).toBeTypeOf('function');
	});

	it('rebuilds the router and the menu links in one fragment', () => {
		const php = step.php?.(host) ?? '';
		expect(php).toContain('router.builder');
		expect(php).toContain('rebuildIfNeeded');
		expect(php).toContain('plugin.manager.menu.link');
	});
});

describe('planning, which is what makes the chain sliceable', () => {
	const alwaysOwed: ReconcileStep = {
		id: 'owed',
		since: 1,
		describe: 'never converges',
		verdict: () => ({ state: 'owed', detail: 'still owed' }),
		sql: () => {}
	};
	const alwaysSatisfied: ReconcileStep = {
		id: 'fine',
		since: 1,
		describe: 'already true',
		verdict: () => ({ state: 'satisfied' })
	};
	const alwaysDeferred: ReconcileStep = {
		id: 'later',
		since: 1,
		describe: 'not yet',
		verdict: () => ({ state: 'deferred', detail: 'waiting' })
	};

	it('marks a step the site already satisfies without running it', () => {
		const planned = planReconcile(CLEAN_RECONCILE, fakeSql({}), fakeHost(1), [alwaysSatisfied]);
		expect(planned.action).toBe('mark');
	});

	it('waits on a deferred step rather than calling it a failure', () => {
		const planned = planReconcile(CLEAN_RECONCILE, fakeSql({}), fakeHost(null), [
			alwaysDeferred
		]);
		expect(planned).toMatchObject({ action: 'wait', reason: 'waiting' });
	});

	it('reports done once every step is applied', () => {
		const state = { version: 0, applied: ['fine'], failed: {} };
		expect(planReconcile(state, fakeSql({}), fakeHost(1), [alwaysSatisfied]).action).toBe(
			'done'
		);
	});

	it('stops asking a step that has spent its attempts, so it cannot own the chain', () => {
		let state: ReconcileState = { version: 0, applied: [], failed: {} };
		for (let i = 0; i < STEP_ATTEMPT_LIMIT; i++) {
			state = recordStep(state, alwaysOwed, { state: 'owed', detail: 'still owed' }, [
				alwaysOwed
			]);
		}
		expect(state.failed['owed']?.attempts).toBe(STEP_ATTEMPT_LIMIT);
		expect(planReconcile(state, fakeSql({}), fakeHost(1), [alwaysOwed]).action).toBe('done');
	});

	it('resumes exactly where it stopped rather than repeating an applied step', () => {
		const first = planReconcile(CLEAN_RECONCILE, fakeSql({}), fakeHost(1), [
			alwaysSatisfied,
			alwaysOwed
		]);
		expect(first).toMatchObject({ action: 'mark' });
		const after = recordStep(CLEAN_RECONCILE, alwaysSatisfied, { state: 'satisfied' }, [
			alwaysSatisfied,
			alwaysOwed
		]);
		expect(
			planReconcile(after, fakeSql({}), fakeHost(1), [alwaysSatisfied, alwaysOwed])
		).toMatchObject({ action: 'run' });
	});

	it('records a step that ran and did not converge as failed, not applied', () => {
		const state = recordStep(CLEAN_RECONCILE, alwaysOwed, {
			state: 'owed',
			detail: 'still owed'
		});
		expect(state.applied).not.toContain('owed');
		expect(state.failed['owed']).toEqual({ attempts: 1, reason: 'still owed' });
	});
});

describe('the version is monotonic, which is what a rollout counts against', () => {
	const v1a: ReconcileStep = {
		id: 'a',
		since: 1,
		describe: '',
		verdict: () => ({ state: 'satisfied' })
	};
	const v1b: ReconcileStep = {
		id: 'b',
		since: 1,
		describe: '',
		verdict: () => ({ state: 'satisfied' })
	};
	const v2: ReconcileStep = {
		id: 'c',
		since: 2,
		describe: '',
		verdict: () => ({ state: 'satisfied' })
	};
	const steps = [v1a, v1b, v2];

	it('does not claim a version while one of its steps is outstanding', () => {
		expect(versionReached(['a'], steps)).toBe(0);
		expect(versionReached(['a', 'b'], steps)).toBe(1);
	});

	it('does not skip a version even when a later step is done', () => {
		expect(versionReached(['a', 'c'], steps)).toBe(0);
		expect(versionReached(['a', 'b', 'c'], steps)).toBe(2);
	});

	it('is the highest since across the shipping list', () => {
		expect(PACK_VERSION).toBe(Math.max(...RECONCILE_STEPS.map((s) => s.since)));
		expect(PACK_VERSION).toBeGreaterThan(0);
	});
});

describe('state round-trips, and a corrupt row re-reconciles rather than skipping', () => {
	it('survives serialise and parse', () => {
		const state = { version: 2, applied: ['a'], failed: { b: { attempts: 2, reason: 'no' } } };
		expect(parseReconcileState(serialiseReconcileState(state))).toEqual(state);
	});

	it('defaults to clean on unparseable text', () => {
		expect(parseReconcileState('{oh no')).toEqual({ version: 0, applied: [], failed: {} });
	});

	it('defaults to clean on an absent row', () => {
		expect(parseReconcileState(null)).toEqual({ version: 0, applied: [], failed: {} });
	});

	it('reads an old failure recorded before attempts were counted', () => {
		const parsed = parseReconcileState(
			'{"version":1,"applied":[],"failed":{"x":{"reason":"r"}}}'
		);
		expect(parsed.failed['x']).toEqual({ attempts: 1, reason: 'r' });
	});
});

describe('the steady state costs one comparison', () => {
	it('is reconciled at the shipping version with nothing failed', () => {
		expect(reconciled({ version: PACK_VERSION, applied: [], failed: {} })).toBe(true);
	});

	it('is NOT reconciled while a step is failed, even at the right version', () => {
		expect(
			reconciled({
				version: PACK_VERSION,
				applied: [],
				failed: { x: { attempts: 1, reason: '' } }
			})
		).toBe(false);
	});

	it('is not reconciled below the shipping version', () => {
		expect(reconciled(CLEAN_RECONCILE)).toBe(false);
	});
});

describe('the status report', () => {
	it('names every step and what this site owes on it', () => {
		const sql = fakeSql({
			config: [{ name: 'system.performance', data: performanceRow(0) }],
			cache_config: [],
			watchdog: [],
			cache_container: [{ cid: 'x' }]
		});
		const report = reconcileReport(CLEAN_RECONCILE, sql, fakeHost(null));
		expect(report.packVersion).toBe(PACK_VERSION);
		expect(report.steps.map((s) => s.id)).toEqual(RECONCILE_STEPS.map((s) => s.id));
		expect(report.steps.find((s) => s.id === 'page-max-age')?.state).toBe('owed');
		expect(report.steps.find((s) => s.id === 'bake-clock')?.state).toBe('deferred');
	});

	it('shows an attempt count on a failed step rather than only its reason', () => {
		const state = {
			version: 0,
			applied: [],
			failed: { 'page-max-age': { attempts: 2, reason: 'x' } }
		};
		const report = reconcileReport(state, fakeSql({}), fakeHost(null));
		expect(report.steps.find((s) => s.id === 'page-max-age')?.detail).toContain('attempt 2');
	});
});

describe('the list itself', () => {
	it('has no duplicate ids, which the applied set is keyed on', () => {
		const ids = RECONCILE_STEPS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('gives every step something to do', () => {
		for (const step of RECONCILE_STEPS) {
			expect(Boolean(step.sql) || Boolean(step.php), step.id).toBe(true);
		}
	});

	/**
	 * A config or state write goes through PHP, and this is the check that keeps it that way.
	 *
	 * The inert fix was a correct SQL update to `config` with `cache_config` still holding the old
	 * value. Drupal's own writers know about every copy; a host re-deriving that list gets it wrong.
	 */
	it('never writes config or state over SQL', () => {
		for (const step of RECONCILE_STEPS) {
			const source = String(step.sql ?? '');
			expect(source, step.id).not.toMatch(/(UPDATE|INSERT INTO)\s+(config|key_value)/i);
		}
	});
});

describe('the router rebuild reaches the local tasks too', () => {
	/**
	 * A route can exist and resolve while the TAB that leads to it is missing.
	 *
	 * Local tasks are discovery-cached plugins, and rebuilding the router does not clear that cache.
	 * The Code Delivery route landed, `/admin/modules/drupflare` resolved, and `/admin/modules` still
	 * rendered exactly two tabs -- so the page a Drupal administrator would look at was the one place
	 * the feature was invisible.
	 *
	 * Asserted against the emitted PHP rather than a run, because the fragment is what a real site
	 * executes and this spec has no interpreter. `php-fragments.spec.ts` proves it parses.
	 */
	it('clears the local task definitions in the same pass as the router and the menu links', () => {
		const php = reconcileRouterPhp('https://example.test');
		expect(php).toContain("\\Drupal::service('router.builder')");
		expect(php).toContain("\\Drupal::service('plugin.manager.menu.link')->rebuild()");
		// the half that was missing
		expect(php).toContain(
			"\\Drupal::service('plugin.manager.menu.local_task')->clearCachedDefinitions()"
		);
	});

	it('generates the two new admin routes into the list the verdict observes', () => {
		// DRIVER_ROUTES is generated by `bun run assets:driver` from the pack's own routing files,
		// so a route added to a sibling module cannot be missed by the step that repairs it
		expect(DRIVER_ROUTES).toContain('drupflare.settings');
		expect(DRIVER_ROUTES).toContain('drupflare.modules');
	});
});

describe('a pack change re-runs plugin discovery, not only the container', () => {
	const step = RECONCILE_STEPS.find((s) => s.id === 'container-driver-digest') as ReconcileStep;

	/**
	 * A tab is a discovery-cached plugin, and the router step cannot deliver it.
	 *
	 * The Code Delivery route reached deployed sites and its TAB did not: `/admin/modules/drupflare`
	 * resolved while `/admin/modules` still rendered two tabs. The clear was first bolted onto
	 * `router-driver-routes`, which was wrong for a reason worth keeping -- that step's verdict counts
	 * ROUTES, so once the routes land it reads satisfied and never runs again, and a site whose routes
	 * arrived before its tabs is stuck permanently.
	 *
	 * This step is keyed on the driver digest, so it fires whenever the packed modules change at all.
	 */
	it('drops the discovery cache alongside the container', () => {
		const statements: string[] = [];
		const sql = {
			exec(text: string) {
				statements.push(text);
				return { toArray: () => [] };
			}
		};
		const host = fakeHost(1_000);
		step.sql?.(sql as never, host as never);
		expect(statements).toContain('DELETE FROM cache_container');
		expect(statements).toContain('DELETE FROM cache_discovery');
	});

	it('still records the digest, so it converges instead of running every alarm', () => {
		const sql = { exec: () => ({ toArray: () => [] }) };
		const host = fakeHost(1_000);
		step.sql?.(sql as never, host as never);
		expect(host.meta(DRIVER_DIGEST_KEY)).toBe(DRIVER_DIGEST);
	});
});

describe('a step whose answer moves is never retired', () => {
	/**
	 * THE REASON A NEW ROUTE WAS 404 ON EVERY ALREADY-RECONCILED SITE.
	 *
	 * `planReconcile` skipped any step already in `applied` before asking its verdict. That is right
	 * for a step that fixes a defect once. It is wrong for the two keyed on the driver digest: the
	 * packed modules change on every release, and their verdicts exist precisely to compare against
	 * the digest that ships today. A site that reconciled against an older pack marked both applied
	 * and then skipped them forever, so the routes a later pack added never entered its router and
	 * Drupal logged `page not found` for them with no indication why.
	 */
	it('re-asks a recurring step that is already applied', () => {
		const step = RECONCILE_STEPS.find((s) => s.id === 'router-driver-routes') as ReconcileStep;
		expect(step.recurring).toBe(true);
		// the router holds none of the driver routes, which is the owed shape
		const sql = fakeSql({ router: [{ name: 'system.admin' }] });
		const planned = planReconcile(
			{ applied: [step.id], failed: {}, version: 0 } as never,
			sql,
			fakeHost(1_000),
			[step]
		);
		expect(planned.action).toBe('run');
	});

	it('still retires a one-shot step, so the chain converges', () => {
		const once = RECONCILE_STEPS.find((s) => s.id === 'page-max-age') as ReconcileStep;
		expect(once.recurring).toBeUndefined();
		const planned = planReconcile(
			{ applied: [once.id], failed: {}, version: 0 } as never,
			fakeSql({}),
			fakeHost(1_000),
			[once]
		);
		expect(planned.action).toBe('done');
	});

	it('does not re-mark a recurring step that is satisfied, or it never reports done', () => {
		const step = RECONCILE_STEPS.find(
			(s) => s.id === 'container-driver-digest'
		) as ReconcileStep;
		const host = fakeHost(1_000, { [DRIVER_DIGEST_KEY]: DRIVER_DIGEST });
		const planned = planReconcile(
			{ applied: [step.id], failed: {}, version: 0 } as never,
			fakeSql({}),
			host,
			[step]
		);
		expect(planned.action).toBe('done');
	});
});
