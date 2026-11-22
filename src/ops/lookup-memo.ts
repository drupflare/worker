/** the Emscripten FS surface the memo wraps */
export type MemoFS = {
	lookupPath(path: string, opts?: Record<string, unknown>): { path?: string; node: unknown };
	ErrnoError: new (errno: number) => Error;
	ignorePermissions?: boolean;
};

export type LookupMemo = { clear: () => void };

type Entry = { key: string; mask: number; path?: string; node?: unknown; errno?: number };

const LOOKUP_BUDGET = 2048;
// the calls that change which names resolve or who may reach them
const STRUCTURAL = [
	'createNode',
	'destroyNode',
	'rename',
	'unlink',
	'rmdir',
	'mkdir',
	'mknod',
	'symlink',
	'mount',
	'unmount',
	'chmod',
	'chown',
	'fchmod',
	'fchown',
	'chdir'
];
const BOOLEAN_OPTIONS = ['parent', 'follow', 'follow_mount'];

/** the memo for a fresh interpreter when LOOKUP_MEMO is 1, or undefined when it is off */
export function lookupMemoFor(env: { LOOKUP_MEMO?: string }, fs: MemoFS): LookupMemo | undefined {
	if (env.LOOKUP_MEMO !== '1') return undefined;
	return installLookupMemo(fs);
}

export function installLookupMemo(fs: MemoFS, maximum = LOOKUP_BUDGET): LookupMemo {
	// one map per option mask, so a lookup with other options never shares an answer
	const variants = Array.from({ length: 16 }, () => new Map<string, Entry>());
	const cache = new Set<Entry>();
	const clear = () => {
		cache.clear();
		for (const map of variants) map.clear();
	};
	const lookup = fs.lookupPath;
	fs.lookupPath = function (this: MemoFS, path: string, opts: Record<string, unknown> = {}) {
		if (!memoable(path, opts)) return lookup.call(this, path, opts);
		const mask = maskOf(fs, opts);
		const map = variants[mask]!;
		const found = map.get(path);
		if (found) return answer(fs, found);
		let entry: Entry;
		try {
			const result = lookup.call(this, path, opts);
			entry = { key: path, mask, path: result.path, node: result.node };
		} catch (error) {
			const errno = errnoOf(error);
			if (errno === undefined) throw error;
			entry = { key: path, mask, errno };
		}
		if (cache.size >= maximum) {
			const oldest = cache.values().next().value!;
			variants[oldest.mask]!.delete(oldest.key);
			cache.delete(oldest);
		}
		cache.add(entry);
		map.set(path, entry);
		return answer(fs, entry);
	};
	const table = fs as unknown as Record<string, unknown>;
	for (const name of STRUCTURAL) {
		const original = table[name];
		if (typeof original !== 'function') continue;
		table[name] = function (this: unknown, ...args: unknown[]) {
			clear();
			try {
				return original.apply(this, args);
			} finally {
				clear();
			}
		};
	}
	return { clear };
}

/** absolute lookups under /drupal, with no recursion and only the boolean options the mask reads */
function memoable(path: unknown, opts: unknown): boolean {
	if (typeof path !== 'string' || !path.startsWith('/drupal/') || path.length > 1024)
		return false;
	if (typeof opts !== 'object' || opts === null) return false;
	const flags = opts as Record<string, unknown>;
	if (Number(flags.recurse_count ?? 0) !== 0) return false;
	for (const key in flags) {
		if (!Object.hasOwn(flags, key)) return false;
		if (key === 'recurse_count') continue;
		if (!BOOLEAN_OPTIONS.includes(key) || typeof flags[key] !== 'boolean') return false;
	}
	return true;
}

function maskOf(fs: MemoFS, opts: Record<string, unknown>): number {
	const followMount = Object.hasOwn(opts, 'follow_mount') ? (opts.follow_mount ? 4 : 0) : 4;
	return (
		(opts.parent ? 1 : 0) | (opts.follow ? 2 : 0) | followMount | (fs.ignorePermissions ? 8 : 0)
	);
}

function answer(fs: MemoFS, entry: Entry): { path: string; node: unknown } {
	if (entry.errno !== undefined) throw new fs.ErrnoError(entry.errno);
	return { path: entry.path!, node: entry.node };
}

function errnoOf(error: unknown): number | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	const { name, errno } = error as { name?: unknown; errno?: unknown };
	return name === 'ErrnoError' && Number.isInteger(errno) ? (errno as number) : undefined;
}
