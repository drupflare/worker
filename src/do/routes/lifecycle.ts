import { latestImport } from '../../db/import-sql';
import {
	claimWarmRun,
	firstRunConfig,
	MIGRATE_DB,
	OPS_REGISTRY,
	opsRun,
	packConsistencyRun
} from '../../drupal/site-php';
import { CRON_CLAIM_GRACE_MS, cronIntervalMs } from '../../ops/cron-drive';
import { type DeploymentKv, recordClaimed } from '../../ops/deployment-site';
import { healthTree, reconcileNode, repairNode, supervisorNode } from '../../ops/health-tree';
import {
	isQuarantined,
	parseState,
	release,
	serialiseState,
	shouldRollback
} from '../../ops/repair';
import { FIRST_RUN_KEY } from '../../ops/setup-page';
import { chooseOrigin, ORIGIN_KEY, pinnable } from '../../ops/site-origin';
import {
	bearerToken,
	ensureOwnerToken,
	OWNER_TOKEN_KEY,
	randomKeyBase64,
	tokenMatches
} from '../../ops/site-secrets';
import { updbStatus } from '../../ops/updb';
import type { SitePhpDurableObject } from '../../site-do';
import { jsonError } from '../../util/reply';
import { firstRow } from '../../util/sql';
import { DEPLOYMENT_RECORDED_KEY } from '../keys';
import { migrateEngine } from '../levers';
import { OPS_DRIVERS } from '../limits';
import type { Payload, Row } from '../types';

/**
 * The origin this site renders against, for the front worker re-addressing an alias.
 * Read without observing, so asking never pins anything.
 */
export async function originRoute(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	return Response.json(
		chooseOrigin({
			configured: site.env?.SITE_ORIGIN,
			pinned: site.metaGet(ORIGIN_KEY)
		})
	);
}

/**
 * What this site holds, for the front worker choosing a deployment's primary.
 * Direct SQL, no interpreter; a table that does not exist yet counts as nothing.
 */
export async function deployment(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const claimedAt = Number(site.metaGet(FIRST_RUN_KEY) ?? 0);
	let lastWrite: number | undefined;
	for (const table of ['node_field_data', 'users_field_data']) {
		try {
			const row = firstRow(
				site.sql.exec<Row<{ m: number | null }>>(`SELECT max(changed) AS m FROM ${table}`)
			);
			if (row?.m != null) lastWrite = Math.max(lastWrite ?? 0, Number(row.m));
		} catch {
			// an unmigrated site has neither table
		}
	}
	return Response.json({
		site: site.ctx.id.name ?? null,
		claimedAt: claimedAt > 0 ? claimedAt : null,
		nodes: site.countOrNull('node') ?? 0,
		accounts: site.countOrNull('users', 'uid > 1') ?? 0,
		lastWrite: lastWrite ?? null
	});
}

/**
 * The health ledger, the repair state and what the last alarm found.
 * `?clear=1` releases quarantine (one clean render says nothing about the cause).
 */
export async function health(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	site.ensureServeTables();
	const state = parseState(site.metaGet('repair_state'));
	if (url.searchParams.get('clear') === '1') {
		const released = release(state, site.nowMs());
		site.metaSet('repair_state', serialiseState(released));
		return Response.json({ ok: true, released, was: state });
	}
	return Response.json({
		tree: healthTree([
			repairNode(state),
			reconcileNode(site.reconcileStatus()),
			supervisorNode(site.lastFindings ?? [])
		]),
		repair: state,
		quarantined: isQuarantined(state),
		rollback: shouldRollback(state, latestImport(site.sql), site.nowMs()),
		advisories: site.advisoryVerdict(),
		version: site.workerVersion(),
		lastFindings: site.lastFindings ?? [],
		ledger: site.sql
			.exec(
				'SELECT ts, code, severity, scope, context, action, outcome, attempt FROM cfw_health ORDER BY id DESC LIMIT ?',
				Number(url.searchParams.get('limit') ?? 50)
			)
			.toArray(),
		ledgerRows: site.countOrNull('cfw_health')
	});
}

/**
 * The database-update chain.
 * `GET` is read-only; `POST` advances one beat and re-arms nothing (poll to run it out);
 * `?action=prepare` starts a run.
 */
export async function updb(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	site.ensureServeTables();
	if (request.method !== 'POST') {
		return Response.json(updbStatus(site.sql));
	}
	// not gated: the router already holds the gate, and taking it again deadlocks
	// `run` is the spelling the Operate page sends for a beat; never repurpose an existing verb
	const action = url.searchParams.get('action');
	if (action !== null && action !== 'beat' && action !== 'run') {
		const ran = await site.updbAction(action, url.searchParams);
		return Response.json({ action, ran, status: updbStatus(site.sql) });
	}
	const beat = await site.updbBeat(false);
	return Response.json({ ...beat, status: updbStatus(site.sql) });
}

/**
 * What this site owes the pack that ships today, and the step that pays it.
 * `GET` reports; `POST` drives one step. Not gated: the router already holds the gate.
 */
export async function reconcile(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	site.ensureServeTables();
	if (request.method !== 'POST') {
		return Response.json({
			...site.reconcileStatus(),
			last: site.lastReconcile ?? null
		});
	}
	const step = await site.reconcileStepOnce();
	// `ran` is this call's outcome, null when nothing ran; a stale one makes a no-op look like
	// progress
	return Response.json({
		ran: step ?? null,
		last: site.lastReconcile ?? null,
		...(step === undefined ? { skipped: site.reconcileSkipReason() } : {}),
		...site.reconcileStatus()
	});
}

function drivenReply(site: SitePhpDurableObject, first: Record<string, unknown>): Response {
	return Response.json(
		{ ...first, driven: site.opsJobActive() },
		{ status: first['ok'] === false ? 500 : 200 }
	);
}

/**
 * The `cfw_ops` HTTP surface, which refuses seven of its eight operations.
 * Those are `sliced: true` and cannot finish in one invocation (`cr` alone is 282.9 ms), so a
 * refusal carries the cost and the driver that can run it.
 */
export async function ops(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const registry = await site.runJson(OPS_REGISTRY);
	if (!registry?.ok) {
		return Response.json(registry ?? { ok: false, error: 'no reply' }, {
			status: 500
		});
	}
	const name = url.searchParams.get('op');
	if (!name) {
		// the driver is resolved here; `OPS_DRIVERS` is this object's table to publish
		const listed = Object.fromEntries(
			Object.entries((registry.operations ?? {}) as Record<string, Payload>).map(
				([op, meta]) => [
					op,
					{
						...meta,
						// an unsliced operation needs no driver: it is the driver
						driver:
							meta.sliced === false
								? 'runs in one invocation'
								: (OPS_DRIVERS[op] ?? null)
					}
				]
			)
		);
		return Response.json({
			...registry,
			operations: listed,
			how: 'GET /ops?op=<name> to run one; sliced operations are refused with their driver named'
		});
	}

	const ops = (registry.operations ?? {}) as Record<string, Payload>;
	const op = ops[name];
	if (!op) {
		// fails closed: an unknown name is treated as writing and sliced
		return jsonError(`unknown operation ${name}`, 404, {
			known: Object.keys(ops),
			treatedAs: registry.failsClosed
		});
	}

	// cex and cim are sliced and paged, not chained: a config export is a pure read in a
	// stable order, so the caller holds the cursor and nothing is persisted between calls
	if (name === 'cex' || name === 'cim') {
		const payload =
			name === 'cim' && request.method === 'POST'
				? await request.json().catch(() => null)
				: undefined;
		if (name === 'cim' && payload === null) {
			return jsonError('cim takes a JSON body of config objects', 400);
		}
		const limit = Number(url.searchParams.get('limit') ?? 0);
		const collections = (url.searchParams.get('collections') ?? '')
			.split(',')
			.map((c) => c.trim())
			.filter((c) => c !== '');
		const budget = Number(url.searchParams.get('budget') ?? 0);
		const options = {
			offset: Number(url.searchParams.get('offset') ?? 0) || 0,
			...(limit > 0 ? { limit } : {}),
			...(payload === undefined ? {} : { payload }),
			...(collections.length > 0 ? { collections } : {}),
			...(budget > 0 ? { budget } : {})
		};
		// `drive=1` runs the first step here and leaves the rest to the alarm chain
		if (name === 'cim' && url.searchParams.get('drive') === '1') {
			const first = await site.opsJobStep(name, [], options);
			if (site.opsJobActive()) await site.setAlarmAt(site.nowMs() + 1);
			return drivenReply(site, first);
		}
		const ran = await site.runJson(opsRun(name, [], options));
		return Response.json(ran ?? { ok: false, error: 'no reply' }, {
			status: ran?.ok ? 200 : 500
		});
	}

	if (name === 'queue-drain' && url.searchParams.get('drive') === '1') {
		const limit = Number(url.searchParams.get('limit') ?? 0);
		const first = await site.opsJobStep(
			name,
			url.searchParams.getAll('arg'),
			limit > 0 ? { limit } : {}
		);
		if (site.opsJobActive()) await site.setAlarmAt(site.nowMs() + 1);
		return drivenReply(site, first);
	}

	if (op.sliced === true) {
		return jsonError(`${name} is sliced and cannot run in one invocation`, 501, {
			cost: op.cost,
			writes: op.writes,
			driver:
				OPS_DRIVERS[name] ??
				'no driver exists yet; this operation is declared, not implemented'
		});
	}

	// every unsliced operation except `status`, which reads the object and needs no kernel
	if (name !== 'status') {
		const ran = await site.runJson(opsRun(name, url.searchParams.getAll('arg')));
		return Response.json(ran ?? { ok: false, error: 'no reply' }, {
			status: ran?.ok ? 200 : 400
		});
	}

	// only `status` reaches here (one read)
	return Response.json({
		ok: true,
		op: name,
		cost: op.cost,
		status: {
			generation: site.packGeneration() ?? null,
			// read the cursor, not `this.migrated` (hibernation discards it); `cfw_migrate` does
			// not exist before a migration starts
			migrated: site.migrateCursorOrNull()?.state === 'done',
			migratePartial: site.migratePartial() ?? null,
			bootMs: site.bootMs ?? null,
			firstRunAt: site.metaGet(FIRST_RUN_KEY),
			serveRequests: site.serveRequests(),
			queueDepth: site.queueDepth()
		}
	});
}

/**
 * First-run configuration.
 *
 * The admin password comes from a `POST` body only: a `pass` query string is refused because the
 * request line reaches `wrangler tail`, observability and every intermediary. A bare `GET` reports.
 */
export async function firstrun(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const doneAt = site.metaGet(FIRST_RUN_KEY);
	const force = url.searchParams.get('force') === '1';

	if (url.searchParams.has('pass')) {
		return jsonError(
			'refusing a password in a query string; it is logged by tail, observability and every intermediary',
			400,
			{ how: 'POST /firstrun with a JSON body: {"adminPass":"...","siteName":"..."}' }
		);
	}

	if (request.method !== 'POST') {
		return Response.json({
			ok: true,
			configured: doneAt !== null,
			firstRunAt: doneAt === null ? null : Number(doneAt),
			appliedKeys: site.metaGet('first_run_keys'),
			how: 'POST /firstrun with a JSON body to configure; a bare GET only reports'
		});
	}

	if (doneAt !== null && !force) {
		// idempotent by default: a retried request would otherwise reset the admin password
		return jsonError('already configured', 409, {
			firstRunAt: Number(doneAt),
			how: 'POST /firstrun?force=1 with the owner token to reconfigure anyway'
		});
	}

	// `force=1` on a provisioned site needs the owner token (checked here, where the secret lives);
	// the claim window is the unprovisioned state
	if (doneAt !== null && force && site.env.PW_DIAGNOSTICS !== '1') {
		const presented = bearerToken(request.headers.get('authorization'));
		if (!tokenMatches(presented, site.metaGet(OWNER_TOKEN_KEY))) {
			return jsonError('already configured; reconfiguring needs the owner token', 401, {
				how: 'POST /firstrun?force=1 with Authorization: Bearer <ownerToken>'
			});
		}
	}

	let body: Payload = {};
	try {
		body = (await request.json()) as Payload;
	} catch {
		return jsonError('body is not JSON', 400);
	}
	const str = (k: string): string | undefined =>
		typeof body[k] === 'string' && body[k].length > 0 ? body[k] : undefined;
	const migrated = body.migrated === true;
	if (migrated && (doneAt !== null || str('adminPass') !== undefined)) {
		return Response.json(
			{
				ok: false,
				error:
					doneAt !== null
						? 'already configured; a migrated claim only applies to an unclaimed site'
						: 'a migrated claim keeps the administrator, so it takes no adminPass'
			},
			{ status: doneAt !== null ? 409 : 400 }
		);
	}

	// a claim is PHP against the site's own database, so it waits for the replay (rows written
	// mid-replay collide with a later chunk)
	const unprovisioned = site.neverMigrated();
	const replaying = unprovisioned ? undefined : site.migratePartial();
	if (unprovisioned || replaying !== undefined) {
		if (unprovisioned) await site.requestProvision();
		return Response.json(
			{
				ok: false,
				error: 'migrating',
				how: 'the database is still being unpacked; retry once a page answers 200'
			},
			{
				status: 503,
				headers: {
					'retry-after': '2',
					'x-cfw-migrate':
						replaying === undefined
							? 'starting'
							: `${replaying.chunk}/${replaying.chunks}`,
					'x-cfw-migrate-state': replaying?.state ?? 'queued'
				}
			}
		);
	}

	// the claim's first invocations come from the front worker; the CPU limit is per invocation, so
	// caches fill and the install runs here
	const phase = url.searchParams.get('phase');
	if (phase === 'warm' || phase === 'consistency') {
		// a site on a baked module set claims in 5.5-8.4 s of CPU as one invocation and ~25 s
		// split, so only a migrated one splits
		await site.loadPackedContainer();
		const modules = site.enabledModulesFingerprint();
		if (site.packedContainer?.variants.some((v) => v.modules === modules)) {
			return Response.json({ ok: true, skipped: 'pack module set' });
		}
		const prepared = await site.runJson(
			phase === 'warm' ? claimWarmRun() : packConsistencyRun()
		);
		return Response.json(prepared ?? { ok: false, error: 'no result' }, {
			status: prepared?.ok ? 200 : 500
		});
	}

	// the pack ships uid 1 with an empty hash (`password_verify()` rejects every input), so a
	// password is minted here, returned once and stored nowhere (a lost one means password reset)
	const minted = str('adminPass') === undefined && !migrated ? randomKeyBase64(18) : undefined;

	const applied = await site.runJson(
		firstRunConfig({
			siteName: str('siteName'),
			siteMail: str('siteMail'),
			adminName: str('adminName'),
			adminMail: str('adminMail'),
			adminPass: str('adminPass') ?? minted,
			timezone: str('timezone'),
			// only on a first claim: `force=1` reconfigures an account that has a real birthday
			claimedAt: doneAt === null && !migrated ? Math.floor(site.nowMs() / 1000) : undefined,
			migrated
		})
	);
	if (applied?.ok) {
		// same reason as the drop at the end of `/__migrate`: a claim leaves a heap that puts
		// the first authenticated render past the isolate limit
		site.dropInterpreter();
		site.metaSet(FIRST_RUN_KEY, site.nowMs());
		// the first claim on a deployment is its primary; later claims are only listed
		if (!site.isReplica()) {
			try {
				const recorded = await recordClaimed(
					(site.env as { CONFIG_KV?: DeploymentKv }).CONFIG_KV,
					site.ctx.id.name ?? '',
					doneAt === null
				);
				if (recorded !== undefined) {
					site.metaSet(DEPLOYMENT_RECORDED_KEY, String(site.nowMs()));
				}
			} catch {
				// `recordInDeployment()` lists it on a later request
			}
		}
		// backdate cron so the owner sees a real date within a minute; the first alarm after a
		// claim is the busiest one, so due at +`GRACE` puts cron on the alarm after it
		await site.storage.put(
			'cronLastRunMs',
			site.nowMs() - cronIntervalMs(site.env) + CRON_CLAIM_GRACE_MS
		);
		// claiming fixes the origin, closing the trust-on-first-use window (overwrites a first
		// visitor's pin)
		if (pinnable(url.origin)) site.metaSet(ORIGIN_KEY, url.origin);
		// keys, never values: the row is readable by anything that reads the database, and one
		// value is a password
		site.metaSet(
			'first_run_keys',
			[
				...Object.keys(body).filter((k) => str(k) !== undefined),
				...(migrated ? ['migrated'] : []),
				...(minted === undefined ? [] : ['adminPass:minted'])
			]
				.sort()
				.join(',')
		);
		// config changed, so any cached page is stale
		site.bumpGeneration('firstrun');
	}
	// added after the PHP result so a failed run cannot hand back a password it never set
	// the owner token is handed out only here; it reaches `/export` without `PW_DIAGNOSTICS=1`
	return Response.json(
		applied?.ok
			? {
					...applied,
					...(minted === undefined
						? {}
						: {
								adminPass: minted,
								adminPassNote: 'minted for this site and shown once; store it now'
							}),
					ownerToken: ensureOwnerToken(site.secretStore()),
					ownerTokenNote:
						'send as Authorization: Bearer <token> to reach /export without PW_DIAGNOSTICS; shown once'
				}
			: applied
	);
}

/** replays the packed database (or reports it already done), then seeds the serving table */
export async function migrate(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const force = url.searchParams.get('force') === '1';
	// the cursor decides, not `this.migrated`: hibernation discards the flag, so an evicted
	// migrated object would replay
	const cursor = site.migrateCursorOrNull();
	const alreadyDone = cursor?.state === 'done' || site.migrated === true;
	if (alreadyDone && !force) {
		// `done` is on every response from this route; a caller branching on `done === false` reads
		// `undefined` otherwise
		return Response.json({
			ok: true,
			skipped: true,
			done: true,
			reason: 'already migrated',
			chunk: cursor?.chunk ?? null,
			chunks: cursor?.chunks ?? null,
			engine: migrateEngine(url, site.env)
		});
	}
	// replaying the pack inserts the packed cachetags rows; that is setup, not a content change
	site.suppressBump = true;
	let result: Payload;
	try {
		result =
			migrateEngine(url, site.env) === 'php'
				? await site.runJson(MIGRATE_DB)
				: await site.migrateChunks(url);
		// a partial pass has a half-populated database; seeding pages now would publish ones the
		// site cannot reproduce
		if (result?.done === false) {
			result.prefilled = 0;
			result.prefillNote = 'migration is partial; prefill waits for done';
		} else if (result && typeof result === 'object') {
			// most specific wins: request param, then `PREFILL` env, then the plan
			Object.assign(
				result,
				await site.prefillServingTable(url.searchParams.get('prefill') ?? undefined)
			);
		}
	} finally {
		site.suppressBump = false;
	}
	// `done !== false` rather than `ok === true`: a partial pass answers `ok: true`
	site.migrated = !result.error && result.ok === true && result.done !== false;
	// drop the interpreter: provisioning leaves the heap 12.5 MiB above a booted one, which puts
	// the first authenticated render past the isolate limit
	if (site.migrated) site.dropInterpreter();
	return Response.json({
		...result,
		queryCount: site.queryCount,
		databaseSize: Number(site.sql.databaseSize)
	});
}
