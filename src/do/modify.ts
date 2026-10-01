import { detectConflicts, planSync, safeName } from '../ops/git-sync';
import {
	activeRevision,
	type Blob,
	type DeclaredFile,
	dropRevision,
	hashManifest,
	isRevHash,
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
} from '../ops/module-rev';
import { type AutoloadDeclaration, parseAutoloadDeclaration } from '../ops/package-install';
import type { SitePhpDurableObject } from '../site-do';
import { jsonError } from '../util/reply';
import { firstRow } from '../util/sql';
import { gitApply, gitRestore, gitVerifyBoot } from './git-delivery';

/**
 * Seven actions over uploaded module revisions, mirroring `/git`'s single-route shape. Only
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
				{ files?: DeclaredFile[] } | undefined;
			if (!body) return site.modifyBadBody();
			const declared = Array.isArray(body.files) ? body.files : [];
			const blobs = planBlobs(site.sql, declared);
			// not `planSync`: a declared file with no blob has no source and would read as removed
			const change = planDeclared(site.sql, site.gitStoredFiles(pkg), declared);
			return Response.json({
				ok: true,
				package: pkg,
				have: blobs.have,
				want: blobs.want,
				wantBytes: blobs.wantBytes,
				counts: change.counts,
				rowsWritten: change.rowsWritten,
				removed: change.removed.slice(0, 200)
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
				{ files?: { path: string; hash: string }[] } | undefined;
			if (!body) return site.modifyBadBody();
			const entries = Array.isArray(body.files) ? body.files : [];
			if (entries.length === 0) {
				return jsonError('a revision with no files would unmount the package', 400);
			}
			const manifest: Record<string, string> = {};
			for (const file of entries) {
				if (typeof file?.path === 'string' && isRevHash(file?.hash)) {
					manifest[file.path] = file.hash;
				}
			}
			if (Object.keys(manifest).length !== entries.length) {
				return jsonError('every file needs a path and a sha256 hash', 400);
			}
			const sentAutoload = (body as { autoload?: unknown }).autoload;
			const declaredAutoload = (
				Array.isArray(sentAutoload) ? sentAutoload : [sentAutoload]
			).map((one) => parseAutoloadDeclaration(one));
			if (declaredAutoload.includes('invalid')) {
				return jsonError('autoload must name a vendor package and a mount', 400);
			}
			const rev = await hashManifest(manifest);
			const prior = activeRevision(site.sql, pkg);
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
			// a core yml is read only when the cached container and discovery are rebuilt
			if (Object.keys(manifest).some((path) => /^core\/.*\.yml$/.test(path)))
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
				pruned
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
	const { files, missing } = materialise(site.sql, manifest);
	if (missing.length > 0) {
		return {
			ok: false,
			applied: false,
			error: `${missing.length} file(s) name a blob this site does not hold`,
			missing: missing.slice(0, 50)
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
	const before = [...stored.entries()];
	const plan = planSync(stored, files);
	const rewired = gitApply(site, pkg, plan, rev);
	const verdict = await gitVerifyBoot(site);
	if (!verdict.ok) {
		gitRestore(site, pkg, before, rev);
		return {
			ok: false,
			applied: false,
			rolledBack: true,
			counts: plan.counts,
			error: `rolled back: ${verdict.error ?? 'the kernel refused to boot'}`
		};
	}
	if (rewired) site.dropCompiledContainer();
	return {
		ok: true,
		applied: true,
		rolledBack: false,
		counts: plan.counts,
		rowsWritten: plan.rowsWritten
	};
}
