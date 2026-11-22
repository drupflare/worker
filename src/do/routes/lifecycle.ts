import { importStatus, latestImport } from '../../db/import-sql';
import {
	adminPasswordPhp,
	extensionsListPhp,
	MODULE_NAME,
	themeDefaultPhp,
	type ThemeDefaultRequest,
	uninstallModulePhp
} from '../../drupal/extension-php';
import {
	claimWarmRun,
	firstRunConfig,
	MIGRATE_DB,
	OPS_REGISTRY,
	opsRun,
	packConsistencyRun
} from '../../drupal/site-php';
import { strataConfigPhp, strataStorePhp } from '../../drupal/strata-php';
import { CRON_CLAIM_GRACE_MS, cronIntervalMs } from '../../ops/cron-drive';
import { cellOf, type ConsoleCell, readConsole } from '../../ops/db-console';
import { type DeploymentKv, recordClaimed } from '../../ops/deployment-site';
import { extensionRows } from '../../ops/extensions';
import { healthTree, reconcileNode, repairNode, supervisorNode } from '../../ops/health-tree';
import { noteAuditDetail } from '../../ops/owner-audit';
import { enabledModules } from '../../ops/reconcile';
import {
	isQuarantined,
	maySafelyRepair,
	parseState,
	release,
	serialiseState,
	shouldRollback
} from '../../ops/repair';
import { FIRST_RUN_KEY } from '../../ops/setup-page';
import { chooseOrigin, ORIGIN_KEY, pinnable } from '../../ops/site-origin';
import {
	bearerToken,
	mintOwnerToken,
	ownerTokenMatches,
	randomKeyBase64
} from '../../ops/site-secrets';
import {
	capturesStatements,
	parseStoreRequest,
	readStrataStore,
	storeAuditDetail,
	storeMatches,
	strataEnabled,
	strataS3Enabled,
	type StrataStoreRequest
} from '../../ops/strata-config';
import { gcHealthLedger, LEDGER_MAX_ROWS } from '../../ops/supervisor';
import { updbStatus } from '../../ops/updb';
import type { SitePhpDurableObject } from '../../site-do';
import { cmsOf } from '../../util/cms';
import { errorMessage } from '../../util/errors';
import { jsonError } from '../../util/reply';
import { firstRow } from '../../util/sql';
import { wordpressClaim, type WordpressClaim } from '../../wordpress/claim';
import { DEPLOYMENT_RECORDED_KEY } from '../keys';
import { migrateEngine } from '../levers';
import { OPS_DRIVERS } from '../limits';
import { dropHeapImages } from '../reconcile';
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
	const point = latestImport(site.sql);
	return Response.json({
		tree: healthTree([
			repairNode(state),
			reconcileNode(site.reconcileStatus()),
			supervisorNode(site.lastFindings ?? [])
		]),
		repair: state,
		quarantined: isQuarantined(state),
		rollback: shouldRollback(state, point, site.nowMs()),
		import: importStatus(point, site.migrateCursorOrNull() ?? undefined) ?? null,
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
 * Drops the PHP interpreter, so the next request pays a full boot and starts from a clean heap.
 * `POST` only. Refuses while a transaction is open, by the same rule as the repair ladder.
 */
export async function recycle(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'POST') return jsonError('use POST', 405, { allow: 'POST' });
	const before = site.recycles ?? 0;
	const facts = {
		transactionDepth: site.speculating ? 1 : 0,
		gateHeld: site.gate.stats().active > 1
	};
	if (!maySafelyRepair(facts)) {
		return jsonError('a transaction is open', 409, { recycles: before });
	}
	const recycled = site.recycleForOwner();
	return Response.json({
		ok: true,
		recycled,
		recyclesBefore: before,
		recyclesAfter: site.recycles ?? 0
	});
}

/** Trims the health ledger to its row cap, newest kept. `POST` only. */
export async function ledgergc(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'POST') return jsonError('use POST', 405, { allow: 'POST' });
	site.ensureServeTables();
	const rowsBefore = site.countOrNull('cfw_health') ?? 0;
	const rowsDeleted = rowsBefore > 0 ? gcHealthLedger(site.sql) : 0;
	return Response.json({ ok: true, rowsBefore, rowsDeleted, cap: LEDGER_MAX_ROWS });
}

/**
 * Strata's `capture.statements`. `GET` reads the stored value; `POST {captureStatements}` sets it
 * through `ConfigFactory` and drops the interpreter and heap images so the next boot reads it.
 * Answers 409 `strata_not_enabled` when the module is not in `core.extension` or has no config row,
 * and 409 while a transaction is open. Setting the stored value writes nothing.
 */
export async function strataconfig(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'POST') {
		return jsonError('use GET or POST', 405, { allow: 'GET, POST' });
	}
	let wanted: boolean | undefined;
	if (request.method === 'POST') {
		const body = (await request.json().catch(() => null)) as {
			captureStatements?: unknown;
		} | null;
		if (typeof body?.captureStatements !== 'boolean') {
			return jsonError('body must be {"captureStatements": true | false}', 400);
		}
		wanted = body.captureStatements;
		const facts = {
			transactionDepth: site.speculating ? 1 : 0,
			gateHeld: site.gate.stats().active > 1
		};
		if (!maySafelyRepair(facts)) return jsonError('a transaction is open', 409);
	}
	const current = strataEnabled(site.sql) ? capturesStatements(site.sql) : undefined;
	if (current === undefined) return jsonError('strata_not_enabled', 409);
	if (wanted === undefined) return Response.json({ captureStatements: current });
	if (wanted === current) {
		return Response.json({ captureStatements: current, previous: current, applied: true });
	}
	const reply = await site.runJson(strataConfigPhp(wanted, site.canonicalOrigin(url.origin)));
	if (reply?.absent === true) return jsonError('strata_not_enabled', 409);
	// the success condition is the stored row, as in a reconcile step
	const after = capturesStatements(site.sql);
	if (reply?.ok !== true || after !== wanted) {
		return jsonError('strata config write failed', 500, { php: reply ?? null });
	}
	site.dropInterpreter();
	dropHeapImages(site);
	return Response.json({ captureStatements: after, previous: current, applied: true });
}

/**
 * Strata's S3 store. `GET` reads what the row holds, never a key or a secret. `POST` sets
 * `provider: s3` and the `s3.*` keys through `ConfigFactory`, makes the encryption key through
 * Strata's `KeyMaker` when `key` is empty, then drops the interpreter and heap images. A body
 * `enable: true` also sets Strata's `enabled`; false or absent never changes it.
 * Answers 409 `strata_not_enabled`, 409 `strata_s3_not_enabled` and 409 while a transaction is
 * open. Setting what the row already holds writes nothing. No answer or error repeats a body value.
 */
export async function stratastore(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'POST') {
		return jsonError('use GET or POST', 405, { allow: 'GET, POST' });
	}
	let want: StrataStoreRequest | undefined;
	if (request.method === 'POST') {
		const parsed = parseStoreRequest(await request.json().catch(() => null));
		if (!parsed.ok) return jsonError(parsed.code, 400);
		want = parsed.value;
		noteAuditDetail(request, storeAuditDetail(want));
		const facts = {
			transactionDepth: site.speculating ? 1 : 0,
			gateHeld: site.gate.stats().active > 1
		};
		if (!maySafelyRepair(facts)) return jsonError('a transaction is open', 409);
	}
	const before = strataEnabled(site.sql) ? readStrataStore(site.sql) : undefined;
	if (before === undefined) return jsonError('strata_not_enabled', 409);
	if (want === undefined) {
		const { provider, enabled, bucket, endpoint, region, hasKey, hasCredentials } = before;
		return Response.json({
			provider,
			enabled,
			bucket,
			endpoint,
			region,
			hasKey,
			hasCredentials
		});
	}
	if (!strataS3Enabled(site.sql)) return jsonError('strata_s3_not_enabled', 409);
	const wanted: StrataStoreRequest = want;
	const previous = { provider: before.provider, bucket: before.bucket };
	const answer = (keyCreated: boolean) =>
		Response.json({
			provider: 's3',
			bucket: wanted.bucket,
			endpoint: wanted.endpoint,
			region: wanted.region,
			applied: true,
			previous,
			keyCreated,
			enabled: readStrataStore(site.sql)?.enabled === true
		});
	if (storeMatches(site.sql, want)) return answer(false);
	let reply: Payload | undefined;
	try {
		reply = await site.runJson(strataStorePhp(want, site.canonicalOrigin(url.origin)));
	} catch {
		// a thrown message is not forwarded: the fragment text holds the secret
		reply = undefined;
	}
	if (reply?.absent === true) return jsonError('strata_not_enabled', 409);
	if (reply?.s3absent === true) return jsonError('strata_s3_not_enabled', 409);
	// the success condition is the stored row, as in a reconcile step
	if (reply?.ok !== true || !storeMatches(site.sql, want)) {
		const phpClass = typeof reply?.class === 'string' ? reply.class : '';
		return jsonError('strata_store_write_failed', 500, {
			...(/^[A-Za-z0-9_\\]{1,120}$/.test(phpClass) ? { phpClass } : {})
		});
	}
	site.dropInterpreter();
	dropHeapImages(site);
	return answer(reply.keyCreated === true);
}

/**
 * Uninstalls one enabled module through Drupal's installer. `POST ?module=NAME`, owner token only.
 * It lists the enabled modules that require NAME first and refuses while any is enabled (409
 * `module_has_dependents`), then refuses what the installer's own validators refuse (409
 * `uninstall_blocked`, with `reasons`). `?dry=1` answers the same facts and changes nothing, and
 * answers 200 whether or not the uninstall would be allowed. The module's files stay where they are.
 * 404 `module_not_enabled` for a module that is not in `core.extension`; 409 while a transaction is
 * open.
 */
export async function uninstall(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'POST') return jsonError('use POST', 405, { allow: 'POST' });
	const name = (url.searchParams.get('module') ?? '').trim();
	if (!MODULE_NAME.test(name)) return jsonError('name the module to uninstall', 400);
	const dry = url.searchParams.get('dry') === '1';
	const facts = {
		transactionDepth: site.speculating ? 1 : 0,
		gateHeld: site.gate.stats().active > 1
	};
	if (!dry && !maySafelyRepair(facts)) return jsonError('a transaction is open', 409);
	const enabled = enabledModules(site.sql);
	if (enabled === undefined) return jsonError('module_list_unreadable', 409);
	if (!enabled.includes(name)) {
		return jsonError('module_not_enabled', 404, { module: name });
	}
	const reply = await site.runJson(
		uninstallModulePhp(name, dry, site.canonicalOrigin(url.origin))
	);
	if (reply?.absent === true) return jsonError('module_not_enabled', 404, { module: name });
	if (reply?.ok !== true) {
		const phpClass = typeof reply?.error === 'string' ? reply.error : '';
		return jsonError('uninstall_failed', 500, {
			...(/^[A-Za-z0-9_\\]{1,120}$/.test(phpClass) ? { phpClass } : {}),
			...(typeof reply?.message === 'string'
				? { phpMessage: reply.message.slice(0, 300) }
				: {})
		});
	}
	const dependents = Array.isArray(reply.dependents) ? (reply.dependents as string[]) : [];
	const reasons = Array.isArray(reply.reasons) ? (reply.reasons as string[]) : [];
	const wouldDelete = site.sql
		.exec<{ path: string }>(
			'SELECT path FROM cfw_module_file WHERE package IN (?, ?) ORDER BY path LIMIT 500',
			`drupal/${name}`,
			name
		)
		.toArray()
		.map((row) => String(row.path));
	if (dry) {
		return Response.json({
			ok: true,
			module: name,
			dryRun: true,
			enabledModules: reply.enabledModules ?? enabled,
			dependents,
			reasons,
			wouldDelete
		});
	}
	if (dependents.length > 0) {
		return jsonError('module_has_dependents', 409, { module: name, dependents });
	}
	if (reasons.length > 0) return jsonError('uninstall_blocked', 409, { module: name, reasons });
	// the success condition is the stored row, as in a reconcile step
	if (enabledModules(site.sql)?.includes(name) !== false) {
		return jsonError('uninstall_failed', 500, { module: name });
	}
	site.dropInterpreter();
	dropHeapImages(site);
	site.bumpGeneration('uninstall');
	return Response.json({ ok: true, module: name, uninstalled: true, dependents: [] });
}

/**
 * Lists the modules, themes and install profiles Drupal discovers as
 * `[{name, kind, version, enabled}]`, from each info file and `core.extension`. `GET` only, owner
 * token only, and it changes nothing, so it runs on a replica as the other reads do. `version` is
 * null when the info file states none. Answers 501 `drupal_only` on WordPress and 500
 * `extensions_unreadable` when the kernel cannot list them.
 */
export async function extensions(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'GET') return jsonError('use GET', 405, { allow: 'GET' });
	if (cmsOf(site.env) === 'wordpress') return jsonError('drupal_only', 501);
	const reply = await site.runJson(extensionsListPhp(site.canonicalOrigin(url.origin)));
	const rows = reply?.ok === true ? extensionRows(reply) : undefined;
	if (rows === undefined) {
		const phpClass = typeof reply?.error === 'string' ? reply.error : '';
		return jsonError('extensions_unreadable', 500, {
			...(/^[A-Za-z0-9_\\]{1,120}$/.test(phpClass) ? { phpClass } : {})
		});
	}
	return Response.json(rows, { headers: { 'cache-control': 'no-store' } });
}

/**
 * Reads, and with a body sets, Drupal's default or admin theme. `GET` and `POST` with `?dry=1`
 * answer `{default, admin, installed}` and change nothing. `POST` takes
 * `{"project": "<theme>", "target": "default" | "admin"}` and answers
 * `{default, admin, installed, previous, applied: true}`; naming the theme a key already holds
 * writes nothing. 404 `theme_not_installed` for a theme that is not installed (install and enable it
 * first), 400 for a body that is not that shape, 409 while a transaction is open. A write drops the
 * interpreter and heap images and advances the page generation.
 */
export async function themedefault(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'POST') {
		return jsonError('use GET or POST', 405, { allow: 'GET, POST' });
	}
	let want: ThemeDefaultRequest | undefined;
	if (request.method === 'POST' && url.searchParams.get('dry') !== '1') {
		const body = (await request.json().catch(() => null)) as {
			project?: unknown;
			target?: unknown;
		} | null;
		if (
			typeof body?.project !== 'string' ||
			(body.target !== 'default' && body.target !== 'admin') ||
			// an empty admin theme means "the same as the default theme"
			!(MODULE_NAME.test(body.project) || (body.project === '' && body.target === 'admin'))
		) {
			return jsonError(
				'body must be {"project": "<theme>", "target": "default" | "admin"}, and only admin takes an empty project',
				400
			);
		}
		want = { project: body.project, target: body.target };
		const facts = {
			transactionDepth: site.speculating ? 1 : 0,
			gateHeld: site.gate.stats().active > 1
		};
		if (!maySafelyRepair(facts)) return jsonError('a transaction is open', 409);
	}
	const reply = await site.runJson(themeDefaultPhp(want, site.canonicalOrigin(url.origin)));
	if (reply?.notInstalled === true) return jsonError('theme_not_installed', 404);
	if (reply?.ok !== true) {
		const phpClass = typeof reply?.error === 'string' ? reply.error : '';
		return jsonError('theme_write_failed', 500, {
			...(/^[A-Za-z0-9_\\]{1,120}$/.test(phpClass) ? { phpClass } : {})
		});
	}
	const previous = (reply.previous ?? {}) as { default?: string; admin?: string };
	const now = {
		default: String(reply.default ?? previous.default ?? ''),
		admin: String(reply.admin ?? previous.admin ?? '')
	};
	if (want === undefined) {
		return Response.json({ ...now, installed: reply.installed ?? [] });
	}
	if (reply.unchanged !== true) {
		site.dropInterpreter();
		dropHeapImages(site);
		site.bumpGeneration('theme');
	}
	return Response.json({ ...now, installed: reply.installed ?? [], previous, applied: true });
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
 * Creates WordPress's first administrator in a one-shot interpreter.
 *
 * The password is in the PHP this builds and nowhere else: the answer is the fragment's JSON, which
 * carries no password, and a failure reports WordPress's error code, not the input.
 */
async function claimWordpress(
	site: SitePhpDurableObject,
	url: URL,
	claim: Omit<WordpressClaim, 'origin'>
): Promise<Payload | undefined> {
	const origin = site.canonicalOrigin(url.origin);
	try {
		return await site.runJson(wordpressClaim({ ...claim, origin }));
	} finally {
		site.resetPhp();
	}
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
	// WordPress takes the same claim, through its own user API; Drupal's steps below are not run
	const wordpress = cmsOf(site.env) === 'wordpress';

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

	if (doneAt !== null && (!force || wordpress)) {
		// idempotent by default: a retried request would otherwise reset the admin password
		return jsonError('already configured', 409, {
			firstRunAt: Number(doneAt),
			how: wordpress
				? 'WordPress has no reconfigure step here; reset a password with its own screens'
				: 'POST /firstrun?force=1 with the owner token to reconfigure anyway'
		});
	}

	// `force=1` on a provisioned site needs the owner token (checked here, where the secret lives);
	// the claim window is the unprovisioned state
	if (doneAt !== null && force && site.env.PW_DIAGNOSTICS !== '1') {
		const presented = bearerToken(request.headers.get('authorization'));
		if (!(await ownerTokenMatches(site.secretStore(), presented))) {
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
	if (wordpress && migrated) {
		return jsonError('a migrated claim is Drupal only', 400);
	}
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
	if (wordpress && phase !== null) {
		return Response.json({ ok: true, skipped: 'WordPress has no preparatory phase' });
	}
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

	const applied = wordpress
		? await claimWordpress(site, url, {
				adminPass: str('adminPass') ?? (minted as string),
				adminName: str('adminName'),
				adminMail: str('adminMail'),
				siteName: str('siteName'),
				siteMail: str('siteMail')
			})
		: await site.runJson(
				firstRunConfig({
					siteName: str('siteName'),
					siteMail: str('siteMail'),
					adminName: str('adminName'),
					adminMail: str('adminMail'),
					adminPass: str('adminPass') ?? minted,
					timezone: str('timezone'),
					// only on a first claim: `force=1` reconfigures an account that has a real birthday
					claimedAt:
						doneAt === null && !migrated ? Math.floor(site.nowMs() / 1000) : undefined,
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
	// the owner token is handed out only here, once; only its hash is stored, so a repeat claim
	// has none to return. It reaches `/export` without `PW_DIAGNOSTICS=1`
	const ownerToken = applied?.ok ? await mintOwnerToken(site.secretStore()) : undefined;
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
					...(ownerToken === undefined
						? {}
						: {
								ownerToken,
								ownerTokenNote:
									'send as Authorization: Bearer <token> to reach /export without PW_DIAGNOSTICS; shown once, and only its hash is kept'
							})
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

/**
 * Sets a new password for user 1 and returns it once. `POST` only, owner token only. The password
 * is generated here, never accepted, so the caller cannot weaken it; the reply carries it with
 * `cache-control: no-store` and nothing records it. Answers 409 while a transaction is open.
 */
export async function adminpassword(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'POST') return jsonError('use POST', 405, { allow: 'POST' });
	if (cmsOf(site.env) === 'wordpress') return jsonError('drupal_only', 501);
	const facts = {
		transactionDepth: site.speculating ? 1 : 0,
		gateHeld: site.gate.stats().active > 1
	};
	if (!maySafelyRepair(facts)) return jsonError('a transaction is open', 409);
	if (site.isReplica()) return jsonError('a replica cannot write a password', 409);
	const password = newAdminPassword();
	const reply = await site.runJson(adminPasswordPhp(password, site.canonicalOrigin(url.origin)));
	if (reply?.absent === true) return jsonError('admin_not_found', 404);
	if (reply?.ok !== true) {
		const phpClass = typeof reply?.error === 'string' ? reply.error : '';
		return jsonError('admin_password_failed', 500, {
			...(/^[A-Za-z0-9_\\]{1,120}$/.test(phpClass) ? { phpClass } : {})
		});
	}
	dropHeapImages(site);
	return Response.json(
		{
			ok: true,
			uid: 1,
			name: String(reply.name ?? ''),
			blocked: reply.blocked === true,
			password,
			applied: true
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
}

/** 24 random bytes as 32 characters of base64url */
function newAdminPassword(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
}

/** thrown inside the transaction when a statement wrote, so the write is rolled back */
class ConsoleWrote extends Error {}

/**
 * A read-only SQL console over the site database. `POST` only, with `{v, sql, params, limit,
 * timeoutMs}`; answers `{columns, rows, truncated, elapsedMs}`, or `{code, message}` with a status.
 *
 * A statement must be one SELECT or WITH with no write or schema keyword. Whatever the check lets
 * through still runs in a transaction that is rolled back when it wrote a row, so a bypass cannot
 * change the database. Durable Object SQL cannot be interrupted, so `timeoutMs` is advisory: it is
 * read and bounded but never enforced, and `elapsedMs` reports what the statement took. The row
 * limit stops the copy, not the scan, and a cut result answers `truncated: true`.
 */
export async function dbconsole(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'POST') return jsonError('use POST', 405, { allow: 'POST' });
	const refusal = (status: number, code: string, message: string) =>
		Response.json({ code, message }, { status });
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return refusal(400, 'unavailable', 'the body is not JSON');
	}
	const call = readConsole(body);
	if (!call.ok) return refusal(call.status, call.code, call.message);
	if (site.speculating) return refusal(503, 'unavailable', 'a transaction is open');
	site.ensureServeTables();
	const started = Date.now();
	try {
		const out = site.storage.transactionSync(() => {
			const cursor = site.sql.exec(call.sql, ...call.params);
			const columns = [...cursor.columnNames];
			const rows: ConsoleCell[][] = [];
			let truncated = false;
			for (const row of cursor.raw()) {
				if (rows.length >= call.limit) {
					truncated = true;
					break;
				}
				rows.push((row as unknown[]).map(cellOf));
			}
			if (cursor.rowsWritten > 0) throw new ConsoleWrote();
			return { columns, rows, truncated };
		});
		return Response.json({ ...out, elapsedMs: Date.now() - started });
	} catch (e) {
		if (e instanceof ConsoleWrote) {
			return refusal(422, 'not_read_only', 'the statement wrote a row and was rolled back');
		}
		return refusal(400, 'statement_failed', errorMessage(e));
	}
}
