import { BOOT_KERNEL, VERIFY_MODULES } from '../drupal/site-php';
import type { Remote } from '../ops/git-provider';
import { fetchCommit } from '../ops/git-smart';
import { detectConflicts, planSync, safeName, selectFiles, type SyncPlan } from '../ops/git-sync';
import { portFibers } from '../ops/package-install';
import type { SitePhpDurableObject } from '../site-do';
import { errorMessage } from '../util/errors';

/**
 * Fetches one commit, plans it against what is installed, and optionally applies it.
 *
 * Applying is transactional and then verified by booting the kernel; a module that fatals on
 * boot would take the site down, so the previous file set is restored.
 */
export async function gitSync(
	site: SitePhpDurableObject,
	remote: Remote,
	sha: string | undefined,
	opts: { apply: boolean; previewOf?: string } = { apply: true }
): Promise<Record<string, unknown>> {
	site.ensureServeTables();
	if (sha === undefined) {
		return { ok: false, error: `the remote has no branch ${remote.branch}` };
	}
	const tree = await fetchCommit(site.gitSmart(remote), sha);
	const selection = selectFiles(tree, safeName(remote.repo));
	if (selection.files.length === 0) {
		return {
			ok: false,
			error: 'that commit carries no mountable module',
			skipped: selection.skipped.length,
			files: 0
		};
	}

	const stored = site.gitStoredFiles(remote.id);
	const plan = planSync(stored, selection.files);
	const conflicts = detectConflicts(selection.files, site.gitOwners(), remote.id);
	const summary = {
		ok: true,
		sha,
		modules: selection.roots.map((r) => ({ name: r.name, type: r.type, root: r.root })),
		counts: plan.counts,
		rowsWritten: plan.rowsWritten,
		bytes: selection.totalBytes,
		skipped: selection.skipped.length,
		changes: plan.changes.slice(0, 200),
		conflicts
	};
	if (!opts.apply) return { ...summary, applied: false };
	if (conflicts.length > 0) {
		return {
			...summary,
			ok: false,
			applied: false,
			error: `${conflicts.length} path(s) belong to another remote`
		};
	}

	const before = [...stored.entries()];
	const rewired = gitApply(site, remote.id, plan, sha);
	const verdict = await gitVerifyBoot(site);
	if (!verdict.ok) {
		gitRestore(site, remote.id, before, sha);
		site.metaSet(`git_lasterror_${remote.id}`, verdict.error ?? 'the kernel refused to boot');
		return {
			...summary,
			// override the summary's `ok: true` (a rolled-back pull must not read as success)
			ok: false,
			applied: false,
			rolledBack: true,
			error: `rolled back: ${verdict.error ?? 'the kernel refused to boot'}`
		};
	}

	if (rewired) site.dropCompiledContainer();
	site.metaSet(`git_installedsha_${remote.id}`, sha);
	site.metaSet(`git_pulled_${remote.id}`, String(site.nowMs()));
	site.metaSet(`git_lasterror_${remote.id}`, '');
	site.metaSet(`git_previewof_${remote.id}`, opts.previewOf ?? '');
	site.metaSet(`git_lastplan_${remote.id}`, JSON.stringify(plan.counts));
	return { ...summary, applied: true, rolledBack: false };
}

/**
 * Writes a delivery's files in one transaction, and answers whether it changed an extension's
 * wiring.
 *
 * The caller drops the compiled container only after verification: a migrated site enables all its
 * modules before any arrive, so an earlier rebuild would roll back the first of several uploads.
 */
export function gitApply(
	site: SitePhpDurableObject,
	id: string,
	plan: SyncPlan,
	sha: string
): boolean {
	const rewired = [...plan.deletes, ...plan.writes.map((w) => w.path)].some((path) =>
		/\.(info|services|routing)\.yml$/.test(path)
	);
	const now = site.nowMs();
	site.storage.transactionSync(() => {
		for (const path of plan.deletes) {
			site.sql.exec('DELETE FROM cfw_module_file WHERE path = ? AND package = ?', path, id);
		}
		for (const file of plan.writes) {
			site.sql.exec(
				`INSERT INTO cfw_module_file (path, package, version, source, installed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             package = excluded.package,
             version = excluded.version,
             source = excluded.source,
             installed_at = excluded.installed_at`,
				file.path,
				id,
				sha,
				portFibers(file.path, file.source),
				now
			);
		}
	});
	site.rowsSinceFlush = (site.rowsSinceFlush ?? 0) + plan.rowsWritten;
	site.php = undefined;
	return rewired;
}

/** puts back exactly what was there, which is the only safe answer to a boot that failed */
export function gitRestore(
	site: SitePhpDurableObject,
	id: string,
	before: readonly (readonly [string, string])[],
	sha: string
): void {
	const now = site.nowMs();
	site.storage.transactionSync(() => {
		site.sql.exec('DELETE FROM cfw_module_file WHERE package = ?', id);
		for (const [path, source] of before) {
			site.sql.exec(
				`INSERT INTO cfw_module_file (path, package, version, source, installed_at)
           VALUES (?, ?, ?, ?, ?)`,
				path,
				id,
				sha,
				source,
				now
			);
		}
	});
	site.rowsSinceFlush = (site.rowsSinceFlush ?? 0) + before.length + 1;
	site.php = undefined;
}

/**
 * Boots the Drupal kernel against what was just written.
 *
 * `ensurePhp()` only starts the interpreter; a syntax error or missing service fails when the
 * container is built.
 */
export async function gitVerifyBoot(
	site: SitePhpDurableObject
): Promise<{ ok: boolean; error?: string }> {
	try {
		const booted = (await site.runJson(BOOT_KERNEL)) as Record<string, unknown> | undefined;
		// a missing verdict is a failure (a compile error kills the run, so nothing is answered)
		if (booted === undefined) {
			return { ok: false, error: 'the boot produced no verdict, which is a fatal' };
		}
		if (booted['error'] !== undefined && booted['error'] !== null) {
			return { ok: false, error: String(booted['error']).slice(0, 300) };
		}
		// a boot includes no `.module` (the container comes from `cache_container`); `loadAll()`
		// is what reaches the uploaded code
		const loaded = (await site.runJson(VERIFY_MODULES)) as Record<string, unknown> | undefined;
		if (loaded === undefined) {
			return {
				ok: false,
				error: 'loading the module files produced no verdict, which is a fatal'
			};
		}
		if (loaded['ok'] !== true) {
			return {
				ok: false,
				error: String(loaded['error'] ?? 'a module refused to load').slice(0, 300)
			};
		}
		return { ok: true };
	} catch (e) {
		return { ok: false, error: errorMessage(e).slice(0, 300) };
	} finally {
		site.php = undefined;
	}
}
