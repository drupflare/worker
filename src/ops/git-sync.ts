/**
 * Turning a fetched working tree into a set of writes, and saying what changed.
 * Pure: every case here (branch switch deleting files, two remotes claiming a path, a repository
 * holding three modules) is a decision about paths, not storage.
 * @module
 */
import type { WorkingFile } from './git-smart';
import { DROP, KEEP, RECORD_CAP } from './package-install';

// #region layout

/** a module, theme or profile found in a repository */
export interface ModuleRoot {
	/** the machine name, taken from `<name>.info.yml` rather than from the directory */
	name: string;
	/** where in the repository it lives, `''` for the repository root */
	root: string;
	type: 'module' | 'theme' | 'profile';
}

const INFO = /(?:^|\/)([a-z0-9_]+)\.info\.yml$/;

/**
 * Finds the modules a repository contains. The name comes from the info file, as Drupal reads it
 * (`../rom` is checked out as `rom` but provides `cfw_do_sqlite`).
 */
export function moduleRoots(
	paths: readonly string[],
	sources?: ReadonlyMap<string, string>
): ModuleRoot[] {
	const candidates: ModuleRoot[] = [];
	for (const path of paths) {
		const match = INFO.exec(path);
		if (match === null) continue;
		const name = match[1] as string;
		const root = path.slice(0, Math.max(0, path.length - `${name}.info.yml`.length - 1));
		const declared = sources?.get(path) ?? '';
		const type = /^type:\s*(\w+)/m.exec(declared)?.[1];
		candidates.push({
			name,
			root,
			type: type === 'theme' ? 'theme' : type === 'profile' ? 'profile' : 'module'
		});
	}

	// shortest root first, so a parent is always decided before anything nested inside it
	candidates.sort((a, b) => a.root.length - b.root.length || (a.name < b.name ? -1 : 1));
	const kept: ModuleRoot[] = [];
	for (const one of candidates) {
		// Drupal discovers a submodule as part of its parent's tree, so mounting it again would
		// install the same extension at two paths
		const inside = kept.some(
			(k) => k.root === '' || one.root === k.root || one.root.startsWith(`${k.root}/`)
		);
		if (!inside) kept.push(one);
	}
	return kept;
}

const DEST: Record<ModuleRoot['type'], string> = {
	module: 'modules/custom',
	theme: 'themes/custom',
	profile: 'profiles/custom'
};

/** where one repository's files land in the Drupal tree */
export function mountPlan(roots: readonly ModuleRoot[], fallback: string): Map<string, string> {
	const plan = new Map<string, string>();
	if (roots.length === 0) {
		plan.set('', `modules/custom/${safeName(fallback)}`);
		return plan;
	}
	for (const root of roots) plan.set(root.root, `${DEST[root.type]}/${root.name}`);
	return plan;
}

/** a repository name reduced to something Drupal would accept as a directory */
export function safeName(repo: string): string {
	const last = repo.split('/').filter(Boolean).pop() ?? repo;
	return (
		last
			.toLowerCase()
			.replace(/[^a-z0-9_]+/g, '_')
			.replace(/^_+|_+$/g, '') || 'custom'
	);
}

/** maps a repository-relative path onto its mount, or null when nothing claims it */
export function mountFor(plan: ReadonlyMap<string, string>, path: string): string | null {
	let best: { root: string; mount: string } | null = null;
	for (const [root, mount] of plan) {
		if (root === '' || path === root || path.startsWith(`${root}/`)) {
			if (best === null || root.length > best.root.length) best = { root, mount };
		}
	}
	if (best === null) return null;
	const rel = best.root === '' ? path : path.slice(best.root.length + 1);
	return rel === '' ? null : `${best.mount}/${rel}`;
}

// #endregion

// #region selecting

/** a file that will be written into the Drupal tree */
export interface SelectedFile {
	/** the path inside the Drupal tree */
	path: string;
	source: string;
	bytes: number;
}

/** the result of filtering a working tree: what lands, what was skipped and why */
export interface Selection {
	files: SelectedFile[];
	skipped: { path: string; why: string }[];
	roots: ModuleRoot[];
	totalBytes: number;
}

const decoder = new TextDecoder();

/** filters a working tree to what a mounted Drupal tree can use (same allow-list as packages) */
export function selectFiles(tree: readonly WorkingFile[], fallbackName: string): Selection {
	const sources = new Map<string, string>();
	for (const file of tree) {
		if (INFO.test(file.path)) sources.set(file.path, decoder.decode(file.bytes));
	}
	const roots = moduleRoots(
		tree.map((f) => f.path),
		sources
	);
	const plan = mountPlan(roots, fallbackName);

	const files: SelectedFile[] = [];
	const skipped: { path: string; why: string }[] = [];
	let totalBytes = 0;

	for (const file of tree) {
		if (DROP.some((re) => re.test(file.path))) {
			skipped.push({ path: file.path, why: 'not part of a mountable tree' });
			continue;
		}
		if (!KEEP.some((re) => re.test(file.path))) {
			skipped.push({ path: file.path, why: 'extension is not executable or readable here' });
			continue;
		}
		if (file.bytes.length > RECORD_CAP) {
			skipped.push({
				path: file.path,
				why: `${file.bytes.length} bytes exceeds the record cap`
			});
			continue;
		}
		const mounted = mountFor(plan, file.path);
		if (mounted === null) {
			skipped.push({ path: file.path, why: 'no module in this repository claims it' });
			continue;
		}
		files.push({
			path: mounted,
			source: decoder.decode(file.bytes),
			bytes: file.bytes.length
		});
		totalBytes += file.bytes.length;
	}
	files.sort((a, b) => (a.path < b.path ? -1 : 1));
	return { files, skipped, roots, totalBytes };
}

// #endregion

// #region the diff

/** how one path differs between the stored tree and the incoming one */
export type ChangeKind = 'added' | 'modified' | 'removed' | 'unchanged';

/** one path's change, with line counts for a change a person is about to approve */
export interface FileChange {
	path: string;
	kind: ChangeKind;
	/** bytes after the change, 0 for a removal */
	bytes: number;
	/** lines added and removed, for a change a person is about to approve */
	added?: number;
	removed?: number;
}

/** what a sync would do: per-path changes, the writes and deletes, and the rows it charges */
export interface SyncPlan {
	changes: FileChange[];
	writes: SelectedFile[];
	deletes: string[];
	counts: Record<ChangeKind, number>;
	/** rows this plan will charge, which is the meter that binds regeneration */
	rowsWritten: number;
}

/** line counts for a single file, as a reviewer reads them before approving a pull */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
	if (before === after) return { added: 0, removed: 0 };
	const a = before === '' ? [] : before.split('\n');
	const b = after === '' ? [] : after.split('\n');
	const seen = new Map<string, number>();
	for (const line of a) seen.set(line, (seen.get(line) ?? 0) + 1);
	let common = 0;
	for (const line of b) {
		const n = seen.get(line) ?? 0;
		if (n > 0) {
			seen.set(line, n - 1);
			common++;
		}
	}
	return { added: b.length - common, removed: a.length - common };
}

/**
 * What applying `incoming` to `stored` would do. `stored` is only this remote's files, so a branch
 * switch cannot delete another remote's tree.
 */
export function planSync(
	stored: ReadonlyMap<string, string>,
	incoming: readonly SelectedFile[]
): SyncPlan {
	const changes: FileChange[] = [];
	const writes: SelectedFile[] = [];
	const counts: Record<ChangeKind, number> = { added: 0, modified: 0, removed: 0, unchanged: 0 };
	const seen = new Set<string>();

	for (const file of incoming) {
		seen.add(file.path);
		const before = stored.get(file.path);
		if (before === undefined) {
			counts.added++;
			writes.push(file);
			changes.push({
				path: file.path,
				kind: 'added',
				bytes: file.bytes,
				...lineDelta('', file.source)
			});
		} else if (before === file.source) {
			counts.unchanged++;
			changes.push({ path: file.path, kind: 'unchanged', bytes: file.bytes });
		} else {
			counts.modified++;
			writes.push(file);
			changes.push({
				path: file.path,
				kind: 'modified',
				bytes: file.bytes,
				...lineDelta(before, file.source)
			});
		}
	}

	const deletes: string[] = [];
	for (const [path, source] of stored) {
		if (seen.has(path)) continue;
		counts.removed++;
		deletes.push(path);
		changes.push({
			path,
			kind: 'removed',
			bytes: 0,
			added: 0,
			removed: source === '' ? 0 : source.split('\n').length
		});
	}

	changes.sort((a, b) => (a.path < b.path ? -1 : 1));
	return { changes, writes, deletes, counts, rowsWritten: writes.length + deletes.length };
}

// #endregion

// #region conflicts

/** a path a pull would take from another package */
export interface Conflict {
	path: string;
	/** the package that already owns it */
	owner: string;
	claimant: string;
}

/**
 * Paths a pull would take from somebody else (a fork and its upstream both providing `mymodule`;
 * letting the later pull win yields a tree neither repository describes).
 */
export function detectConflicts(
	incoming: readonly SelectedFile[],
	owners: ReadonlyMap<string, string>,
	claimant: string
): Conflict[] {
	const out: Conflict[] = [];
	for (const file of incoming) {
		const owner = owners.get(file.path);
		if (owner !== undefined && owner !== claimant) {
			out.push({ path: file.path, owner, claimant });
		}
	}
	return out;
}

// #endregion

// #region polling cadence

/** the smallest interval offered (below it, polls alone saturate a fleet's DO request meter) */
export const MIN_POLL_MINUTES = 5;
/** the interval a remote polls at unless told otherwise */
export const DEFAULT_POLL_MINUTES = 60;

/** clamps a poll interval to the minimum; 0 means polling is off */
export function clampInterval(minutes: number): number {
	if (!Number.isFinite(minutes) || minutes <= 0) return 0;
	return Math.max(MIN_POLL_MINUTES, Math.floor(minutes));
}

/** one remote's polling schedule */
export interface PollState {
	id: string;
	intervalMinutes: number;
	lastCheckedMs: number;
	/** set by a 429; nothing polls again before it */
	backoffUntilMs: number;
}

/** which remotes are due, oldest first, so one slow remote cannot starve the others */
export function duePolls(states: readonly PollState[], nowMs: number, limit = 3): string[] {
	return states
		.filter((s) => s.intervalMinutes > 0)
		.filter((s) => nowMs >= s.backoffUntilMs)
		.filter((s) => nowMs - s.lastCheckedMs >= s.intervalMinutes * 60_000)
		.sort((a, b) => a.lastCheckedMs - b.lastCheckedMs)
		.slice(0, limit)
		.map((s) => s.id);
}

/** doubles on each refusal and honours `Retry-After` when the provider sends one */
export function backoffMs(attempt: number, retryAfterSeconds?: number | null): number {
	if (retryAfterSeconds !== undefined && retryAfterSeconds !== null && retryAfterSeconds > 0) {
		return Math.min(retryAfterSeconds * 1000, 3_600_000);
	}
	return Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
}

// #endregion
