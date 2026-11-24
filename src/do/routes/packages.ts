import { fetchOffloaded, getFile, statFile } from '../../db/file-store';
import {
	amplification,
	emptyTally,
	overheadShare,
	rankTally,
	routerRebuilds
} from '../../db/write-tally';
import { ENABLE_MODULE, ENABLE_VERIFY } from '../../drupal/php/enable';
import { FILES_PROBE } from '../../drupal/php/files';
import { BOOT_KERNEL } from '../../drupal/php/site';
import { ignoresCore, type Registry } from '../../ops/composer/package-install';
import { parseRepositories } from '../../ops/composer/repositories';
import { SHIPPED_CORE_VERSION } from '../../ops/composer/shipped-lock';
import { hasApi, readHookEvent, verifyHook } from '../../ops/git/provider';
import { derivativeUri } from '../../ops/image/render-lane';
import { sourceBytes } from '../../ops/module/bytes';
import { maySafelyRepair } from '../../ops/repair';
import { bearerToken, ownerTokenIsSet, ownerTokenMatches } from '../../ops/site/secrets';
import type { SitePhpDurableObject } from '../../site-do';
import { errorMessage } from '../../util/errors';
import { isModuleName, phpSingle, phpSingleList } from '../../util/php';
import { jsonError } from '../../util/reply';
import { firstRow } from '../../util/sql';
import { GIT_TOKEN_HEADER } from '../git/handler';
import { GROWTH_REFUSED_HEADER } from '../growth/cap';
import { installLockPost, installLockRollback } from '../install-lock';
import { lazyMountBytes } from '../lazy-mount';
import {
	ENABLE_PLAN_PHP,
	advanceStepJob,
	clearStepJob,
	plannedOverBudget,
	readStepJob,
	stepMode
} from '../stepper';
import type { Payload, Row } from '../types';

// #region the git tier

/**
 * Owner-gated entry to the git tier.
 * Remotes and tokens live in `cfw_meta`, never KV (KV is operator-writable).
 */
export async function git(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const presented = bearerToken(request.headers.get('authorization'));
	const ownerOk = await ownerTokenMatches(site.secretStore(), presented);
	const diagnostics =
		(site.env as unknown as Record<string, string | undefined>).PW_DIAGNOSTICS === '1';
	if (!ownerOk && !diagnostics) {
		return jsonError('owner token required', 401);
	}
	// the token in this header serves this one call; the finally clears it before anything else runs
	site.gitCallToken = request.headers.get(GIT_TOKEN_HEADER)?.trim() || undefined;
	try {
		return await site.handleGit(url, site.canonicalOrigin(url.origin));
	} finally {
		site.gitCallToken = undefined;
	}
}

/**
 * Uploaded module revisions: `/git` for a tree that is not on a host.
 *
 * Owner only, except an unclaimed `PW_DIAGNOSTICS` site with no owner token yet (a rig delivers
 * a custom profile before the claim); once a token exists it is required.
 */
export async function modify(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const presented = bearerToken(request.headers.get('authorization'));
	const store = site.secretStore();
	const unclaimedRig = site.env.PW_DIAGNOSTICS === '1' && !(await ownerTokenIsSet(store));
	if (!unclaimedRig && !(await ownerTokenMatches(store, presented))) {
		return jsonError('owner token required', 401);
	}
	return site.handleModify(url, request);
}

/**
 * Installs the packages of a composer lock, a window per `POST`; `DELETE ?session=` undoes one.
 *
 * Owner only, by the same rule as `/modify`. Refuses while a transaction is open.
 */
export async function installLock(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'POST' && request.method !== 'DELETE') {
		return jsonError('use POST or DELETE', 405, { allow: 'POST, DELETE' });
	}
	const store = site.secretStore();
	const unclaimedRig = site.env.PW_DIAGNOSTICS === '1' && !(await ownerTokenIsSet(store));
	const presented = bearerToken(request.headers.get('authorization'));
	if (!unclaimedRig && !(await ownerTokenMatches(store, presented))) {
		return jsonError('owner token required', 401);
	}
	const facts = {
		transactionDepth: site.speculating ? 1 : 0,
		gateHeld: site.gate.stats().active > 1
	};
	if (!maySafelyRepair(facts)) return jsonError('a transaction is open', 409);
	if (request.method === 'DELETE') {
		const session = url.searchParams.get('session') ?? '';
		if (!/^[0-9a-f]{16}$/.test(session)) return jsonError('name the session to roll back', 400);
		return installLockRollback(site, session);
	}
	return installLockPost(site, request);
}

/**
 * A delivery from a provider.
 *
 * Public (no header this Worker controls), so it is authenticated by its signature; an
 * unverifiable delivery is refused.
 */
export async function githook(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const id = url.searchParams.get('remote') ?? '';
	const remotes = site.gitRemotes();
	const remote = remotes.find((r) => r.id === id);
	if (remote === undefined) {
		return jsonError('unknown remote', 404);
	}
	const body = await request.text();
	const secret = site.readSecret(`git_hooksecret_${remote.id}`) ?? '';
	const verdict = await verifyHook(remote.provider, request.headers, body, secret);
	if (!verdict.ok) {
		return jsonError(verdict.reason ?? 'refused', 401, { proof: verdict.proof });
	}
	let payload: unknown = null;
	try {
		payload = JSON.parse(body);
	} catch {
		return jsonError('body is not JSON', 400);
	}
	const event = readHookEvent(remote.provider, request.headers, payload);
	site.metaSet(`git_proof_${remote.id}`, verdict.proof);
	if (event.kind !== 'push' || event.branch !== remote.branch || event.deleted) {
		return Response.json({
			ok: true,
			proof: verdict.proof,
			event,
			synced: false
		});
	}
	site.metaSet(`git_head_${remote.id}`, event.after ?? '');
	site.metaSet(`git_checked_${remote.id}`, String(site.nowMs()));
	// a preview holds the site at a request head; a push to the branch must not replace what is
	// under review
	if (event.after === null || site.metaGet(`git_previewof_${remote.id}`)) {
		return Response.json({
			ok: true,
			proof: verdict.proof,
			event,
			synced: false
		});
	}
	let synced: Record<string, unknown>;
	try {
		synced = await site.gitSync(remote, event.after, { apply: true });
	} catch (e) {
		site.metaSet(`git_lasterror_${remote.id}`, errorMessage(e).slice(0, 300));
		synced = { ok: false, error: errorMessage(e) };
	}
	if (hasApi(remote.provider) && site.gitCredential(remote.id).token !== '') {
		await site
			.gitWriteStatus(
				remote,
				event.after,
				synced['applied'] === true ? 'success' : 'failed',
				String(synced['error'] ?? 'installed on drupflare'),
				site.canonicalOrigin(url.origin)
			)
			.catch(() => false);
	}
	return Response.json({ ok: true, proof: verdict.proof, event, synced });
}

// #endregion

/**
 * Can this module be installed? Answered from one metadata fetch against the shipped lock (through
 * `caches.default`, since a p2 payload is immutable per version); a refusal names the conflict.
 */
export async function installable(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const verdict = await site.installableVerdict(url.searchParams.get('module') ?? '');
	return Response.json(
		{ ...verdict, shippedCore: SHIPPED_CORE_VERSION },
		{
			// 200 with a verdict, so a caller reads the named conflict rather than a status code
			status: verdict.verdict === 'not-found' ? 404 : 200
		}
	);
}

/**
 * Installs one package, refusing first if the shipped lock conflicts.
 *
 * `?force=1` skips the check for a package the oracle cannot judge (`unverifiable`). `?accept=a/b,c/d`
 * skips it only when every conflict names one of those packages in `requires`, so a caller that
 * showed the owner one conflict does not also waive another it did not show. A package in `accept`
 * that is not among the current conflicts answers 400, so an old preflight cannot accept more than
 * it showed. `?ignore_core=1` lets version resolution take a release that declares an older core;
 * a site holding the anachron package does so unless `?ignore_core=0` says otherwise. Neither skips the archive
 * digest check, which sits in `installPackage()`. Installing does not enable; both
 * routes are owner-gated because they write code the site did not ship with.
 */
export async function install(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const name = url.searchParams.get('module') ?? '';
	const constraint = url.searchParams.get('version') ?? undefined;
	if (name === '') {
		return jsonError('no module named', 400);
	}
	// `deps=1` also installs what the package requires; a platform or version conflict still
	// refuses
	const withDeps = url.searchParams.get('deps') === '1';
	// the requesting project's minimum-stability, which composer applies to every package
	const stability = ['dev', 'alpha', 'beta', 'rc'].find(
		(s) => s === url.searchParams.get('stability')
	);
	// a site that bypasses core's version gate (anachron) takes a release that declares an older
	// core when none admits this one
	const ignoreCore = ignoresCore(
		url.searchParams.get('ignore_core'),
		site.packageAutoloads().flatMap((p) => (p.name ? [p.name] : []))
	);
	// the project's own composer repositories, as `type|url`
	const repositories = parseRepositories(url.searchParams.getAll('repository'));
	// the packages whose conflicts the owner has seen and accepts; any other conflict still refuses
	const accepted = new Set(
		(url.searchParams.get('accept') ?? '')
			.split(',')
			.map((p) => p.trim())
			.filter((p) => p !== '')
	);
	if (url.searchParams.get('force') !== '1') {
		// the method, not `this.fetch()`: the router already holds the gate
		const verdict = await site.installableVerdict(name, constraint, stability);
		// an accepted package that is not a conflict now was shown from an older preflight
		const unlisted = [...accepted].filter(
			(p) => !(verdict.conflicts ?? []).some((c) => c.requires === p)
		);
		if (unlisted.length > 0 && verdict.verdict !== 'not-found') {
			return jsonError(
				`accept names a package that does not conflict: ${unlisted.join(', ')}`,
				400,
				{
					code: 'accept_not_in_conflicts',
					unlisted,
					conflicts: verdict.conflicts ?? []
				}
			);
		}
		const blocking = (verdict.conflicts ?? []).filter(
			(c) =>
				!accepted.has(c.requires) &&
				!(withDeps && c.reason === 'missing' && c.requires.includes('/'))
		);
		const named = accepted.size > 0 && blocking.length === 0 && verdict.verdict !== 'not-found';
		if (
			verdict.verdict !== 'installable' &&
			!named &&
			(!withDeps || blocking.length > 0 || verdict.verdict === 'not-found')
		) {
			return Response.json(
				{
					ok: false,
					name,
					refused: verdict.verdict ?? 'unknown',
					conflicts: verdict.conflicts ?? [],
					how: 'pass force=1 to install anyway'
				},
				{ status: verdict.verdict === 'not-found' ? 404 : 409 }
			);
		}
	}
	// `composer` unless asked otherwise; `metadataUrl()` routes `drupal/*` to packages.drupal.org
	const registry: Registry = url.searchParams.get('registry') === 'npm' ? 'npm' : 'composer';
	if (withDeps) {
		const installed = await site.installTree(
			registry,
			name,
			constraint,
			undefined,
			stability,
			ignoreCore,
			repositories
		);
		site.php = undefined;
		const ok = installed.every((one) => one['ok'] === true);
		return Response.json({ ok, name, installed }, { status: ok ? 200 : 502 });
	}
	const out = await site.installPackage(
		registry,
		name,
		constraint,
		stability,
		ignoreCore,
		repositories
	);
	// the interpreter mounts new files at boot
	site.php = undefined;
	return Response.json(out, { status: out.ok === false ? 502 : 200 });
}

/**
 * One delivered module asset's source, for the front worker to serve as a static file.
 * Reads `cfw_module_file` only, so it answers no path a site did not install.
 */
export async function moduleasset(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const path = url.searchParams.get('path') ?? '';
	if (path === '' || path.startsWith('/') || path.includes('..')) {
		return new Response('not found\n', { status: 400 });
	}
	site.ensureServeTables();
	const row = firstRow(
		site.sql.exec<{ source: string }>(
			'SELECT source FROM cfw_module_file WHERE path = ? OR path = ?',
			path,
			`/${path}`
		)
	);
	if (row === undefined) return new Response('not found\n', { status: 404 });
	return new Response(sourceBytes(String(row.source)), {
		status: 200,
		headers: { 'cache-control': 'private, no-store' }
	});
}

/**
 * One stored file's bytes, with no kernel (`/__files` boots one, 1,398 ms cold).
 *
 * `private://` is refused: Drupal's access layer authorises it and this route has no kernel to
 * ask, so the image tier falls back to a rendered page that carries the session.
 */
export async function filebytes(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const uri = url.searchParams.get('uri') ?? '';
	if (uri === '' || uri.startsWith('private://')) {
		return new Response('not found\n', { status: uri === '' ? 400 : 403 });
	}
	// a derivative rendered ahead of time answers in place of the source
	const id = url.searchParams.get('derivative') ?? '';
	if (uri.startsWith('public://') && /^[A-Za-z0-9_-]{1,64}$/.test(id)) {
		const stored = await storedBody(site, derivativeUri(id));
		if (stored !== undefined) {
			return new Response(stored.body, {
				status: 200,
				headers: {
					'content-type': stored.mime,
					'cache-control': 'private, no-store',
					'x-cfw-derivative': 'stored'
				}
			});
		}
	}
	const source = await storedBody(site, uri);
	if (source === undefined) return new Response('not found\n', { status: 404 });
	return new Response(source.body, {
		status: 200,
		headers: {
			'content-type': source.mime,
			'cache-control': 'private, no-store',
			'x-cfw-file-bytes': String(source.size),
			...(source.offloaded ? { 'x-cfw-file-store': 'r2' } : {})
		}
	});
}

/**
 * A stored file's body: the object's bytes, or a stream straight from R2 for an evicted file so a
 * large one never sits in the isolate.
 */
async function storedBody(
	site: SitePhpDurableObject,
	uri: string
): Promise<
	| { body: Uint8Array | ReadableStream | null; size: number; mime: string; offloaded: boolean }
	| undefined
> {
	const meta = statFile(site.sql, uri);
	if (meta === undefined) return undefined;
	const mime = String(meta.mime ?? 'application/octet-stream');
	if (!meta.evicted) {
		const bytes = getFile(site.sql, uri);
		return bytes === undefined
			? undefined
			: { body: bytes, size: bytes.length, mime, offloaded: false };
	}
	const object = await fetchOffloaded(site.fileBuckets(), meta, site.siteName(), () =>
		site.trustedFileSources()
	);
	return { body: object.body, size: object.size, mime, offloaded: true };
}

/** Writes or reads one file through Drupal's stream wrappers (`op`, `uri`, `body`); a probe. */
export async function files(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (url.searchParams.get('drop') === '1') {
		site.php = undefined;
	}
	// the kernel boots in a separate run: `BOOT_KERNEL` prints its own JSON, so concatenating
	// the fragments would emit two objects and neither would parse
	const booted = await site.runJson(BOOT_KERNEL);
	if (booted?.ok === false) {
		return jsonError('kernel boot failed', 500, { booted });
	}
	const op = url.searchParams.get('op') ?? 'write';
	const uri = url.searchParams.get('uri') ?? 'public://cfw-probe/note.txt';
	const body = url.searchParams.get('body') ?? 'durable';
	// set through globals, since a quote in a filename would close the PHP literal
	const preamble =
		`<?php $GLOBALS['__cfw_files_op'] = ${phpSingle(op)};` +
		` $GLOBALS['__cfw_files_uri'] = ${phpSingle(uri)};` +
		` $GLOBALS['__cfw_files_body'] = ${phpSingle(body)};`;
	// strip the probe's own `<?php`; no `?>` between them, or the rest of the fragment emits as
	// literal text
	const reply = await site.runJson(`${preamble}\n${FILES_PROBE.replace(/^<\?php\n/, '')}`);
	return Response.json(reply ?? { ok: false, error: 'no reply' }, {
		status: reply?.ok === true ? 200 : 500
	});
}

/**
 * Enables a packed Drupal module, and measures what that costs.
 *
 * `dry=1` reports discoverability and `hook_requirements` without installing. `verify=1` runs
 * `ENABLE_VERIFY` on a dropped interpreter, the only way to see the post-rebuild container.
 * The write tally is armed around the install because rows written binds regeneration.
 */
export async function enable(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const wantVerify = url.searchParams.get('verify') === '1';
	// checked before any PHP runs: these values go into a script
	const name = (url.searchParams.get('module') ?? '').trim();
	const withModules = (url.searchParams.get('with') ?? '').split(',').filter((m) => m !== '');
	const stopAt = url.searchParams.get('stop') ?? '';
	if (!wantVerify && name !== '' && !isModuleName(name)) {
		return jsonError('invalid module name: a machine name is a-z, 0-9 and _, 50 at most', 400);
	}
	if (!wantVerify && !withModules.every(isModuleName)) {
		return jsonError('invalid module name in with', 400);
	}
	if (!wantVerify && !/^[a-z_]*$/.test(stopAt)) {
		return jsonError('invalid stop stage', 400);
	}
	// an install runs on a fresh interpreter: linear memory only grows, and an enable ends at 92.2
	// MB fresh against 110.6 MB after four renders (`keep=1` reproduces the failing order)
	const keepInterpreter = url.searchParams.get('keep') === '1';
	if (wantVerify || !keepInterpreter) {
		// drop and boot cannot share an invocation (memory returns only when collected), so defer
		// the refusal only when the heap is in the way
		if (site.php?.binary && site.oversized()) {
			site.php = undefined;
			return Response.json({
				ok: false,
				retry: true,
				droppedInterpreter: true,
				error: 'dropped the interpreter to free its heap; call again'
			});
		}
		site.php = undefined;
	}
	const booted = await site.runJson(BOOT_KERNEL);
	if (booted?.ok === false) {
		return jsonError('kernel boot failed', 500, { booted });
	}
	if (wantVerify) {
		const verified = await site.runJson(ENABLE_VERIFY);
		return Response.json(verified ?? { ok: false, error: 'no reply' });
	}
	// no default module; every other write route refuses a missing argument
	if (name === '') {
		return jsonError('name the module to enable', 400);
	}
	const dry = url.searchParams.get('dry') === '1';
	// modules installed in the same call, for two whose config each depends on the other
	const preamble =
		`<?php $GLOBALS['__cfw_enable_module'] = ${phpSingle(name)};` +
		` $GLOBALS['__cfw_enable_with'] = ${phpSingleList(withModules)};` +
		` $GLOBALS['__cfw_enable_dry'] = ${dry ? 'true' : 'false'};` +
		` $GLOBALS['__cfw_enable_stop'] = ${phpSingle(stopAt)};`;
	site.writeTally = emptyTally();
	// the wasm heap from the host; `memory_get_peak_usage()` returns 0 in this build
	const heapBefore = site.php ? (site.heapBytes(site.php.binary)?.length ?? 0) : 0;
	const t0 = Date.now();
	// the bump moves to after the install's writes: its `cachetags` write arms an alarm at +1 ms
	// and the reset rolls the install back (0/6 landed inline, 12/12 suppressed)
	const priorSuppress = site.suppressBump;
	site.suppressBump = true;
	const body = ENABLE_MODULE.replace(/^<\?php\n/, '');
	let reply: Payload | undefined;
	const mode = stepMode(site.env);
	let steps: string[] | undefined;
	// a job already stored is finished first; otherwise the planner decides from the module count
	if (mode !== 'off' && !dry && stopAt === '' && !readStepJob(site, name)) {
		const planned = await site.runJson(
			`${preamble}\n${ENABLE_PLAN_PHP.replace(/^<\?php\n/, '')}`
		);
		const plan = Array.isArray(planned?.plan) ? (planned.plan as string[]) : [];
		if (!plan.every(isModuleName)) return jsonError('the plan named an invalid module', 400);
		steps = plan.length > 0 ? plan : [name];
	}
	const stepIt =
		mode !== 'off' &&
		!dry &&
		stopAt === '' &&
		(steps === undefined || mode === 'always' || plannedOverBudget(steps.length, site.env));
	if (stepIt) {
		// a dependency or the module per slice, each with its own checkpoint
		const stepped = await advanceStepJob(
			site,
			name,
			async () => steps ?? [name],
			(m) =>
				`<?php $GLOBALS['__cfw_enable_module'] = ${phpSingle(m)}; $GLOBALS['__cfw_enable_with'] = []; $GLOBALS['__cfw_enable_dry'] = false; $GLOBALS['__cfw_enable_stop'] = '';\n${body}`
		);
		site.suppressBump = priorSuppress;
		if (stepped.state === 'done') {
			clearStepJob(site);
			// the last step reports what it added; the whole job added the union
			// a job whose last step committed before the answer left has no reply to give
			reply = {
				...(stepped.reply ?? { ok: true, module: name, nowEnabled: true, resumed: true }),
				added: stepped.job.added ?? []
			};
		} else {
			site.php = undefined;
			const pollUrl = `/__enable?module=${encodeURIComponent(name)}`;
			if (stepped.state === 'more') {
				return Response.json(
					{
						ok: true,
						done: false,
						job: name,
						next: stepped.job.next,
						total: stepped.job.plan.length,
						why: stepped.why,
						poll: pollUrl
					},
					{ status: 202, headers: { 'retry-after': '1' } }
				);
			}
			if (stepped.state === 'refused') {
				return Response.json(
					{
						ok: false,
						job: name,
						step: stepped.step,
						next: stepped.job.next,
						total: stepped.job.plan.length,
						error: 'the step needs more memory than the site is allowed; nothing it did was saved',
						rolledBack: stepped.error.rolledBack
					},
					{ status: 503, headers: { [GROWTH_REFUSED_HEADER]: '1' } }
				);
			}
			if (stepped.reply?.rolledBack !== undefined) site.dropCompiledContainer();
			return Response.json(
				{
					...stepped.reply,
					job: name,
					next: stepped.job.next,
					total: stepped.job.plan.length
				},
				{ status: 500 }
			);
		}
	} else {
		reply = await site.runJson(`${preamble}\n${body}`);
		site.suppressBump = priorSuppress;
		// the failed install's container named a module the list no longer holds
		if (reply?.rolledBack !== undefined) site.dropCompiledContainer();
	}
	const heapAfter = site.php ? (site.heapBytes(site.php.binary)?.length ?? 0) : 0;
	// dropped again afterwards: the install rebuilt the container, so the resident interpreter
	// holds a stale module list and service graph
	if (!keepInterpreter) {
		site.php = undefined;
	}
	const tally = site.writeTally;
	site.writeTally = undefined;
	// router rebuilds counted from the statement shape (one is 2,095 rows; an enable measured
	// 17,188, so the cost is a repeat)
	const routes = Number(
		firstRow(site.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM router'))?.c ?? 0
	);
	// now the invalidation: an install changes routes, the container and the module list; the armed
	// alarm fires after the event closes
	const bump =
		reply?.ok === true && !dry && stopAt === ''
			? site.bumpGeneration('module-install', { arm: false })
			: null;
	// no `setAlarm()` inside the install (it resets the object and rolls the install back: 0/6
	// landed inline, 6/6 without); `armInstallFill()` wakes the queue from a separate event
	const armFill = bump !== null && bump.requeued > 0;
	return Response.json({
		...(reply ?? { ok: false, error: 'no reply' }),
		localMs: Date.now() - t0,
		bump,
		// the caller's cue to poke `/__armfill`, a second event and therefore safe
		armFill,
		heapBefore,
		heapAfter,
		// both halves: the wasm heap is linear memory, while `MEMFS` contents are JS-side arrays
		// (blob + index + resident cache, which `LAZY_FS_BUDGET_BYTES` bounds)
		mountBytes: lazyMountBytes(site.mountInfo),
		rowsWritten: tally?.rowsWritten ?? 0,
		writeStatements: tally?.statements ?? 0,
		routes,
		routerStatements: tally?.statementsByTable['router'] ?? 0,
		routerRebuilds: (tally ? routerRebuilds(tally, routes) : undefined) ?? null,
		byTable: tally ? rankTally(tally) : [],
		// charged rows per statement per table; a factor above 1 means something other than the row
		// is billed
		amplification: tally ? amplification(tally) : [],
		overheadShare: tally ? overheadShare(tally) : 0,
		// which statements, not just how many
		shapes: tally
			? Object.entries(tally.shapes ?? {})
					.sort((a, b) => b[1] - a[1])
					.slice(0, 8)
			: [],
		containerRows: Number(
			firstRow(site.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cache_container'))
				?.c ?? 0
		),
		// the widest single value written, against the 2,199,995-byte per-record limit (a compiled
		// container is one blob)
		containerBytes: Number(
			firstRow(
				site.sql.exec<Row<{ b: number }>>(
					'SELECT COALESCE(MAX(LENGTH(data)), 0) AS b FROM cache_container'
				)
			)?.b ?? 0
		)
	});
}
