import { getFile, statFile } from '../../db/file-store';
import {
	amplification,
	emptyTally,
	overheadShare,
	rankTally,
	routerRebuilds
} from '../../db/write-tally';
import { ENABLE_MODULE, ENABLE_VERIFY } from '../../drupal/enable-php';
import { FILES_PROBE } from '../../drupal/files-php';
import { BOOT_KERNEL } from '../../drupal/site-php';
import { hasApi, readHookEvent, verifyHook } from '../../ops/git-provider';
import type { Registry } from '../../ops/package-install';
import { derivativeUri } from '../../ops/render-lane';
import { SHIPPED_CORE_VERSION } from '../../ops/shipped-lock';
import { bearerToken, OWNER_TOKEN_KEY, tokenMatches } from '../../ops/site-secrets';
import type { SitePhpDurableObject } from '../../site-do';
import { errorMessage } from '../../util/errors';
import { jsonError } from '../../util/reply';
import { firstRow } from '../../util/sql';
import { lazyMountBytes } from '../lazy-mount';
import type { Row } from '../types';

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
	const ownerOk = tokenMatches(presented, site.metaGet(OWNER_TOKEN_KEY));
	const diagnostics =
		(site.env as unknown as Record<string, string | undefined>).PW_DIAGNOSTICS === '1';
	if (!ownerOk && !diagnostics) {
		return jsonError('owner token required', 401);
	}
	return site.handleGit(url, site.canonicalOrigin(url.origin));
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
	const owner = site.metaGet(OWNER_TOKEN_KEY);
	const unclaimedRig = site.env.PW_DIAGNOSTICS === '1' && owner === null;
	if (!unclaimedRig && !tokenMatches(presented, owner)) {
		return jsonError('owner token required', 401);
	}
	return site.handleModify(url, request);
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
	const secret = site.metaGet(`git_hooksecret_${remote.id}`) ?? '';
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
 * `?force=1` skips the check for a package the oracle cannot judge (`unverifiable`). Installing
 * does not enable; both routes are owner-gated because they write code the site did not ship with.
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
	if (url.searchParams.get('force') !== '1') {
		// the method, not `this.fetch()`: the router already holds the gate
		const verdict = await site.installableVerdict(name, constraint, stability);
		const blocking = (verdict.conflicts ?? []).filter(
			(c) => !(withDeps && c.reason === 'missing' && c.requires.includes('/'))
		);
		if (
			verdict.verdict !== 'installable' &&
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
		const installed = await site.installTree(registry, name, constraint, undefined, stability);
		site.php = undefined;
		const ok = installed.every((one) => one['ok'] === true);
		return Response.json({ ok, name, installed }, { status: ok ? 200 : 502 });
	}
	const out = await site.installPackage(registry, name, constraint, stability);
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
	return new Response(String(row.source), {
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
		const stored = getFile(site.sql, derivativeUri(id));
		if (stored !== undefined) {
			return new Response(stored, {
				status: 200,
				headers: {
					'content-type': String(
						statFile(site.sql, derivativeUri(id))?.mime ?? 'application/octet-stream'
					),
					'cache-control': 'private, no-store',
					'x-cfw-derivative': 'stored'
				}
			});
		}
	}
	const bytes = getFile(site.sql, uri);
	if (bytes === undefined) return new Response('not found\n', { status: 404 });
	const meta = statFile(site.sql, uri);
	return new Response(bytes, {
		status: 200,
		headers: {
			'content-type': String(meta?.mime ?? 'application/octet-stream'),
			'cache-control': 'private, no-store',
			'x-cfw-file-bytes': String(bytes.length)
		}
	});
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
		`<?php $GLOBALS['__cfw_files_op'] = ${JSON.stringify(op)};` +
		` $GLOBALS['__cfw_files_uri'] = ${JSON.stringify(uri)};` +
		` $GLOBALS['__cfw_files_body'] = ${JSON.stringify(body)};`;
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
	const name = (url.searchParams.get('module') ?? '').trim();
	if (name === '') {
		return jsonError('name the module to enable', 400);
	}
	const dry = url.searchParams.get('dry') === '1';
	const stopAt = url.searchParams.get('stop') ?? '';
	// modules installed in the same call, for two whose config each depends on the other
	const withModules = (url.searchParams.get('with') ?? '')
		.split(',')
		.filter((m) => /^[a-z][a-z0-9_]*$/.test(m));
	const preamble =
		`<?php $GLOBALS['__cfw_enable_module'] = ${JSON.stringify(name)};` +
		` $GLOBALS['__cfw_enable_with'] = ${JSON.stringify(withModules)};` +
		` $GLOBALS['__cfw_enable_dry'] = ${dry ? 'true' : 'false'};` +
		` $GLOBALS['__cfw_enable_stop'] = ${JSON.stringify(stopAt)};`;
	site.writeTally = emptyTally();
	// the wasm heap from the host; `memory_get_peak_usage()` returns 0 in this build
	const heapBefore = site.php ? (site.heapBytes(site.php.binary)?.length ?? 0) : 0;
	const t0 = Date.now();
	// the bump moves to after the install's writes: its `cachetags` write arms an alarm at +1 ms
	// and the reset rolls the install back (0/6 landed inline, 12/12 suppressed)
	const priorSuppress = site.suppressBump;
	site.suppressBump = true;
	const reply = await site.runJson(`${preamble}\n${ENABLE_MODULE.replace(/^<\?php\n/, '')}`);
	site.suppressBump = priorSuppress;
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
