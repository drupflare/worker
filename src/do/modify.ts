import {
	type AutoloadDeclaration,
	commitStalesContainer,
	parseAutoloadDeclaration
} from '../ops/composer/package-install';
import { detectConflicts, planSync, safeName } from '../ops/git/sync';
import { digestSource } from '../ops/module/integrity';
import {
	activeRevision,
	type Blob,
	commitManifest,
	type DeclaredFile,
	dropRevision,
	hashManifest,
	isRevHash,
	type KeepOptions,
	listRevisions,
	manifestOf,
	materialise,
	planBlobs,
	planDeclared,
	previousRevision,
	recordRevision,
	retain,
	REVISION_RETENTION,
	revisionByHash,
	revisionStatus,
	setActive,
	storeBlobs
} from '../ops/module/rev';
import { addWritten, emptyReport, receiptOf, type ReturnTypeReport } from '../ops/return-types';
import type { SitePhpDurableObject } from '../site-do';
import { jsonError } from '../util/reply';
import { firstRow } from '../util/sql';
import { gitApply, gitRestore, gitVerifyBoot } from './git/delivery';
import { executedFiles, trustedEntries } from './module-files';

/**
 * Eight actions over uploaded module revisions, mirroring `/git`'s single-route shape. Only
 * `commit` and `activate` change what runs, through the same apply-verify-restore path as git.
 */
export async function handleModify(
	site: SitePhpDurableObject,
	url: URL,
	request: Request
): Promise<Response> {
	site.ensureServeTables();
	const action = url.searchParams.get('action') ?? 'status';
	const asked = url.searchParams.get('package') ?? '';
	// checked before safeName(), which maps an empty string to 'custom'
	if (asked === '' && action !== 'status') {
		return jsonError('package is required', 400);
	}
	const pkg = asked === '' ? '' : safeName(asked);

	switch (action) {
		case 'status':
			return Response.json({
				ok: true,
				packages: revisionStatus(site.sql, pkg === '' ? undefined : pkg)
			});

		case 'revisions': {
			const limit = Number(url.searchParams.get('limit') ?? 20);
			return Response.json({
				ok: true,
				revisions: listRevisions(site.sql, pkg, limit),
				active: activeRevision(site.sql, pkg)?.rev ?? null
			});
		}

		// one revision's paths for a client diff (`revisions` reports only a count)
		case 'manifest': {
			const wanted = url.searchParams.get('rev') ?? 'active';
			const target =
				wanted === 'active'
					? activeRevision(site.sql, pkg)
					: wanted === 'previous'
						? previousRevision(site.sql, pkg)
						: revisionByHash(site.sql, pkg, wanted);
			if (!target) {
				return jsonError('no such revision', 404);
			}
			return Response.json({
				ok: true,
				rev: target.rev,
				label: target.label,
				createdAt: target.createdAt,
				active: target.active,
				manifest: manifestOf(site.sql, target.id)
			});
		}

		case 'plan': {
			const body = (await site.readModifyBody(request)) as
				({ files?: DeclaredFile[] } & Record<string, unknown>) | undefined;
			if (!body) return site.modifyBadBody();
			const options = readKeepOptions(body);
			if (options === undefined) return jsonError(KEEP_REFUSAL, 400);
			const declared = Array.isArray(body.files) ? body.files : [];
			const blobs = planBlobs(site.sql, declared);
			// not `planSync`: a declared file with no blob has no source and would read as removed
			const stored = site.gitStoredFiles(pkg);
			const change = planDeclared(site.sql, stored, declared, options, (files) =>
				executedFiles(site.env, stored, files, emptyReport())
			);
			return Response.json({
				ok: true,
				package: pkg,
				have: blobs.have,
				want: blobs.want,
				wantBytes: blobs.wantBytes,
				counts: change.counts,
				rowsWritten: change.rowsWritten,
				removed: change.removed.slice(0, 200),
				kept: change.kept
			});
		}

		case 'blobs': {
			const body = (await site.readModifyBody(request)) as { blobs?: Blob[] } | undefined;
			if (!body) return site.modifyBadBody();
			const result = await storeBlobs(
				site.sql,
				Array.isArray(body.blobs) ? body.blobs : [],
				(fn) => site.storage.transactionSync(fn)
			);
			site.rowsSinceFlush = (site.rowsSinceFlush ?? 0) + result.stored;
			// a rejected blob's bytes did not match its hash
			const status = result.rejected.length > 0 ? 422 : 200;
			return Response.json({ ok: result.rejected.length === 0, ...result }, { status });
		}

		case 'commit': {
			const body = (await site.readModifyBody(request)) as
				| ({ files?: { path: string; hash: string }[] } & Record<string, unknown>)
				| undefined;
			if (!body) return site.modifyBadBody();
			const options = readKeepOptions(body);
			if (options === undefined) return jsonError(KEEP_REFUSAL, 400);
			const entries = Array.isArray(body.files) ? body.files : [];
			if (entries.length === 0 && options.keep !== true) {
				return jsonError('a revision with no files would unmount the package', 400);
			}
			const named: Record<string, string> = {};
			for (const file of entries) {
				if (typeof file?.path === 'string' && isRevHash(file?.hash)) {
					named[file.path] = file.hash;
				}
			}
			if (Object.keys(named).length !== entries.length) {
				return jsonError('every file needs a path and a sha256 hash', 400);
			}
			const prior = activeRevision(site.sql, pkg);
			// checked before anything is written, so a commit built on a revision that has moved lands nowhere
			const base = (body as { base?: unknown }).base;
			if (base !== undefined && !isRevHash(base)) {
				return jsonError('base must be a revision hash', 400);
			}
			if (base !== undefined && base !== prior?.rev) {
				return jsonError('stale_base', 409, {
					code: 'stale_base',
					base,
					active: prior?.rev ?? null
				});
			}
			const resolved = commitManifest(
				named,
				prior ? manifestOf(site.sql, prior.id) : {},
				options
			);
			if (!resolved.ok) return jsonError(resolved.error, 400);
			const manifest = resolved.manifest;
			const sentAutoload = (body as { autoload?: unknown }).autoload;
			const declaredAutoload = (
				Array.isArray(sentAutoload) ? sentAutoload : [sentAutoload]
			).map((one) => parseAutoloadDeclaration(one));
			if (declaredAutoload.includes('invalid')) {
				return jsonError('autoload must name a vendor package and a mount', 400);
			}
			const rev = await hashManifest(manifest);
			// registered before the boot check (a hook extending a vendor class needs it to build
			// the container); rolled back with the revision on refusal
			const autoloads = declaredAutoload.filter(
				(one): one is AutoloadDeclaration => one !== undefined && one !== 'invalid'
			);
			const priorAutoload = autoloads.map((one) =>
				firstRow(
					site.sql.exec('SELECT * FROM cfw_package_autoload WHERE package = ?', one.name)
				)
			);
			if (autoloads.length > 0) {
				const { files } = materialise(site.sql, manifest);
				for (const one of autoloads) site.registerPackageAutoload(one, files);
			}
			const recorded = recordRevision(
				site.sql,
				{
					package: pkg,
					rev,
					kind: 'upload',
					label: (url.searchParams.get('label') ?? '').slice(0, 200),
					origin: (url.searchParams.get('origin') ?? '').slice(0, 200),
					manifest,
					nowMs: site.nowMs()
				},
				(fn) => site.storage.transactionSync(fn)
			);
			// a core yml is read only when the cached container and discovery are rebuilt, and a
			// vendor autoload can carry a service provider that only a rebuilt container holds
			if (commitStalesContainer(Object.keys(manifest), autoloads))
				site.dropCompiledContainer();
			const applied = await applyRevision(site, pkg, manifest, rev);
			if (!applied.ok) {
				// the refused revision stays stored, and the one it replaced is still what serves
				setActive(site.sql, pkg, prior?.id ?? null, (fn) =>
					site.storage.transactionSync(fn)
				);
				autoloads.forEach((one, at) => {
					site.sql.exec('DELETE FROM cfw_package_autoload WHERE package = ?', one.name);
					const before = priorAutoload[at];
					if (before === undefined) return;
					site.sql.exec(
						'INSERT INTO cfw_package_autoload (package, version, mount, autoload, classmap) VALUES (?, ?, ?, ?, ?)',
						before['package'],
						before['version'],
						before['mount'],
						before['autoload'],
						before['classmap']
					);
				});
				return Response.json({ ok: false, rev, ...applied }, { status: 409 });
			}
			const pruned = retain(site.sql, pkg, REVISION_RETENTION, (fn) =>
				site.storage.transactionSync(fn)
			);
			return Response.json({
				ok: true,
				rev,
				reused: recorded.reused,
				...applied,
				pruned,
				...(options.keep === true ? { kept: resolved.kept, removed: resolved.removed } : {})
			});
		}

		case 'activate': {
			const wanted = url.searchParams.get('rev') ?? '';
			const target =
				wanted === 'previous'
					? previousRevision(site.sql, pkg)
					: revisionByHash(site.sql, pkg, wanted);
			if (!target) {
				return jsonError(
					wanted === 'previous'
						? 'nothing is stored behind the active revision'
						: 'no such revision',
					404
				);
			}
			const manifest = manifestOf(site.sql, target.id);
			const applied = await applyRevision(site, pkg, manifest, target.rev);
			if (!applied.ok) {
				return Response.json({ ok: false, rev: target.rev, ...applied }, { status: 409 });
			}
			setActive(site.sql, pkg, target.id, (fn) => site.storage.transactionSync(fn));
			return Response.json({ ok: true, rev: target.rev, ...applied });
		}

		case 'drop': {
			const result = dropRevision(site.sql, pkg, url.searchParams.get('rev') ?? '', (fn) =>
				site.storage.transactionSync(fn)
			);
			return Response.json(
				{ ok: result.dropped, ...result },
				{ status: result.dropped ? 200 : 409 }
			);
		}

		default:
			return jsonError(`unknown action: ${action}`, 400);
	}
}

const KEEP_REFUSAL = 'keep must be true or false and remove a list of paths';

/** `keep` and `remove` from a commit or plan body, or undefined when either is malformed */
function readKeepOptions(body: Record<string, unknown>): KeepOptions | undefined {
	const { keep, remove } = body;
	if (keep !== undefined && typeof keep !== 'boolean') return undefined;
	if (remove === undefined) return { keep: keep === true };
	if (!Array.isArray(remove) || remove.some((one) => typeof one !== 'string' || one === '')) {
		return undefined;
	}
	return { keep: keep === true, remove: remove as string[] };
}

type PreparedRevision =
	| {
			ok: true;
			before: ReturnType<typeof trustedEntries>;
			rewired: boolean;
			counts: ReturnType<typeof planSync>['counts'];
			rowsWritten: number;
			returnTypes: ReturnTypeReport;
	  }
	| { ok: false; [key: string]: unknown };

// lets the incoming source payloads go before the new kernel boots
function prepareRevision(
	site: SitePhpDurableObject,
	pkg: string,
	manifest: Record<string, string>,
	rev: string
): PreparedRevision {
	const { files, missing } = materialise(site.sql, manifest);
	if (missing.length > 0) {
		return {
			ok: false,
			applied: false,
			error: `${missing.length} file(s) name a blob this site does not hold`,
			missing: missing.slice(0, 50)
		};
	}
	// the blob table is SQL, so a stored blob is checked against its name before it is recorded
	const altered = files.filter((file) => digestSource(file.source) !== manifest[file.path]);
	if (altered.length > 0) {
		return {
			ok: false,
			applied: false,
			error: `${altered.length} stored blob(s) do not match their hash`,
			altered: altered.map((file) => file.path).slice(0, 50)
		};
	}
	const conflicts = detectConflicts(files, site.gitOwners(), pkg);
	if (conflicts.length > 0) {
		return {
			ok: false,
			applied: false,
			conflicts,
			error: `${conflicts.length} path(s) belong to another package`
		};
	}
	const stored = site.gitStoredFiles(pkg);
	const before = trustedEntries(site, [...stored.entries()]);
	// planned against the bytes that will be stored, so an identical commit writes nothing
	const done = emptyReport();
	const plan = planSync(stored, executedFiles(site.env, stored, files, done));
	const returnTypes = emptyReport();
	addWritten(returnTypes, done, new Set(plan.writes.map((w) => w.path)));
	const rewired = gitApply(site, pkg, plan, rev);
	return {
		ok: true,
		before,
		rewired,
		counts: plan.counts,
		rowsWritten: plan.rowsWritten,
		returnTypes
	};
}

/**
 * Mounts one revision, verifies the kernel boots against it, and restores the old files if not;
 * a broken module fails when the container is built, not when its files are written.
 */
export async function applyRevision(
	site: SitePhpDurableObject,
	pkg: string,
	manifest: Record<string, string>,
	rev: string
): Promise<Record<string, unknown>> {
	const prepared = prepareRevision(site, pkg, manifest, rev);
	if (!prepared.ok) return prepared;
	const verdict = await gitVerifyBoot(site);
	if (!verdict.ok) {
		gitRestore(site, pkg, prepared.before, rev);
		return {
			ok: false,
			applied: false,
			rolledBack: true,
			counts: prepared.counts,
			error: `rolled back: ${verdict.error ?? 'the kernel refused to boot'}`
		};
	}
	if (prepared.rewired) site.dropCompiledContainer();
	return {
		ok: true,
		applied: true,
		rolledBack: false,
		counts: prepared.counts,
		rowsWritten: prepared.rowsWritten,
		returnTypes: receiptOf(prepared.returnTypes)
	};
}

/** a body that is not JSON is a caller error, and a throw here would read as a server fault */
export async function readModifyBody(request: Request): Promise<unknown> {
	if (request.method !== 'POST') return undefined;
	try {
		return (await request.json()) as unknown;
	} catch {
		return undefined;
	}
}

/** the 400 for a modify action called without a JSON POST */
export function modifyBadBody(): Response {
	return jsonError('this action needs a POST carrying a JSON body', 400);
}
