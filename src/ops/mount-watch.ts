import { createHash } from 'node:crypto';
import type { Row } from '../do/types';
import { releaseOwnedBuffer, type GraphNode, type ReleasableFS } from './release-host';

/** what a mount was built from, so a kept mount can be checked against the same inputs */
export type MountStamp = { modules: string; settings: string };

export type MountWatch = {
	stats: { mutations: number; paths: string[]; cacheMutations: number };
	reset(): void;
};

/** why a refreshed interpreter did or did not keep its mount */
export type MountVerdict = { kept: boolean; reason: string };

type StampHost = {
	sql: SqlStorage;
	canonicalOrigin(): string;
	bootSettings(): unknown;
};

type WatchedBinary = { FS: object; mountWatch?: MountWatch; mountStamp?: MountStamp };

const PAGE = 64;

/** the stamp is read only after a restart, so it is taken only when restarts are on too */
export function mountReuseArmed(
	env: { REUSE_MOUNT?: string; REFRESH_INSTANCE?: string } | undefined
): boolean {
	return env?.REUSE_MOUNT === '1' && env.REFRESH_INSTANCE === '1';
}

/** SHA-256 over every `cfw_module_file` row: path, package, version, source and install time */
export function sourceStamp(sql: SqlStorage): string {
	const hash = createHash('sha256');
	const part = (value: unknown) => {
		const text = String(value ?? '');
		hash.update(`${text.length}:`);
		hash.update(text);
	};
	let after = '';
	for (;;) {
		const rows = sql
			.exec<Row<{ path: string; package: string; version: string; installed_at: number }>>(
				'SELECT path, package, version, installed_at FROM cfw_module_file WHERE path>? ORDER BY path LIMIT ?',
				after,
				PAGE
			)
			.toArray();
		if (rows.length === 0) break;
		for (const row of rows) {
			// one row at a time, so no page holds more than one source
			const source = sql
				.exec<Row<{ source: unknown }>>(
					'SELECT source FROM cfw_module_file WHERE path=?',
					row.path
				)
				.toArray()[0]?.source;
			part(row.path);
			part(row.package);
			part(row.version);
			part(source);
			part(row.installed_at);
			after = row.path;
		}
		if (rows.length < PAGE) break;
	}
	return hash.digest('hex');
}

/** SHA-256 over what `settings.php` is written from besides its secrets: origin and boot settings */
export function settingsStamp(site: Omit<StampHost, 'sql'>): string {
	return createHash('sha256')
		.update(JSON.stringify([site.canonicalOrigin(), site.bootSettings()]))
		.digest('hex');
}

const TWIG = '/drupal/sites/default/files/php/twig';
const DEVICES = new Set(['/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/tty1', '/dev/null']);
// the calls that change a file, a name or a mode
const MUTATORS = [
	'writeFile',
	'write',
	'truncate',
	'ftruncate',
	'mkdir',
	'mknod',
	'unlink',
	'rmdir',
	'rename',
	'symlink',
	'chmod',
	'chown',
	'fchmod',
	'fchown',
	'utime',
	'allocate',
	'mount',
	'unmount',
	'msync'
];
const O_CREAT = 64;
const O_TRUNC = 512;
const PROT_WRITE = 2;

type WatchFS = {
	streams: Array<{ node?: object; path?: string } | null | undefined>;
	getPath(node: object): string;
	lookupPath(path: string, opts?: { parent?: boolean; follow?: boolean }): { node: object };
	open(path: unknown, flags: unknown, ...rest: unknown[]): unknown;
	mmap?(stream: unknown, ...rest: unknown[]): unknown;
};

/**
 * Counts the changes made to a mounted filesystem since the last `reset()`, by wrapping the FS
 * calls that make them. Writes to the standard streams are not changes, and writes under the Twig
 * cache count apart: that cache is rebuilt on demand.
 *
 * Installed once per binary; a second call returns the first watch.
 */
export function watchMount(binary: WatchedBinary): MountWatch {
	if (binary.mountWatch) return binary.mountWatch;
	const FS = binary.FS as WatchFS;
	const table = FS as unknown as Record<string, unknown>;
	const stats = { mutations: 0, paths: [] as string[], cacheMutations: 0 };

	const pathOf = (value: unknown): string => {
		const target = typeof value === 'number' ? FS.streams[value] : value;
		if (typeof target === 'string') {
			try {
				return FS.getPath(FS.lookupPath(target, { follow: true }).node);
			} catch {
				try {
					const base = target.split('/').filter(Boolean).at(-1) ?? '';
					return `${FS.getPath(FS.lookupPath(target, { parent: true }).node)}/${base}`;
				} catch {
					return target;
				}
			}
		}
		const held = target as { node?: object; path?: string } | null | undefined;
		return held?.node ? FS.getPath(held.node) : (held?.path ?? '?');
	};
	const changed = (value: unknown, device = false) => {
		const path = pathOf(value);
		if (device && DEVICES.has(path)) return;
		if (path === TWIG || path.startsWith(`${TWIG}/`)) {
			stats.cacheMutations++;
			return;
		}
		stats.mutations++;
		if (stats.paths.length < 12) stats.paths.push(path);
	};

	for (const name of MUTATORS) {
		const original = table[name];
		if (typeof original !== 'function') continue;
		table[name] = function (this: unknown, ...args: unknown[]) {
			changed(args[0], name === 'write' || name === 'writeFile');
			if (name === 'rename' || name === 'symlink') changed(args[1]);
			return original.apply(this, args);
		};
	}
	const open = FS.open;
	FS.open = function (this: unknown, path, flags, ...rest) {
		const writes =
			typeof flags === 'string'
				? /[wa]/.test(flags)
				: Boolean(Number(flags) & (O_CREAT | O_TRUNC));
		if (writes) changed(path);
		return open.call(this, path, flags, ...rest);
	};
	const mmap = FS.mmap;
	if (typeof mmap === 'function') {
		FS.mmap = function (this: unknown, stream, length, position, prot, ...rest) {
			if (Number(prot) & PROT_WRITE) changed(stream);
			return mmap.call(this, stream, length, position, prot, ...rest);
		};
	}
	binary.mountWatch = {
		stats,
		reset() {
			stats.mutations = 0;
			stats.paths.length = 0;
			stats.cacheMutations = 0;
		}
	};
	return binary.mountWatch;
}

/** records what a fresh mount was built from and starts counting changes to it */
export function stampMount(site: StampHost, binary: WatchedBinary): void {
	try {
		binary.mountStamp = { modules: sourceStamp(site.sql), settings: settingsStamp(site) };
	} catch {
		// no stamp, so no later boot keeps this mount
		binary.mountStamp = undefined;
	}
	watchMount(binary).reset();
}

/** whether a mount still holds what it was built from; any doubt is a re-mount */
export function checkMount(site: StampHost, binary: WatchedBinary): MountVerdict {
	const stamp = binary.mountStamp;
	const watch = binary.mountWatch;
	if (!stamp || !watch) return { kept: false, reason: 'no stamp' };
	if (watch.stats.mutations !== 0) return { kept: false, reason: 'mutated' };
	try {
		if (sourceStamp(site.sql) !== stamp.modules)
			return { kept: false, reason: 'modules changed' };
		if (settingsStamp(site) !== stamp.settings)
			return { kept: false, reason: 'settings changed' };
	} catch {
		return { kept: false, reason: 'stamp unreadable' };
	}
	return { kept: true, reason: 'unchanged' };
}

type TwigFS = ReleasableFS & {
	getPath(node: object): string;
	unlink(path: string): void;
};

/**
 * Evicts the oldest compiled Twig files until the cache is under `maximum` bytes. A kept mount
 * carries the cache from every render before it, and each file is a private copy in this isolate.
 */
export function trimTwigCache(
	binary: { FS: object; HEAPU8?: { buffer: ArrayBufferLike } },
	maximum = 8 * 1024 * 1024
): { bytes: number; evicted: number; detachedBytes: number } {
	const FS = binary.FS as TwigFS;
	const result = { bytes: 0, evicted: 0, detachedBytes: 0 };
	let root: GraphNode;
	try {
		root = FS.lookupPath(TWIG).node as GraphNode;
	} catch {
		return result;
	}
	const files: Array<GraphNode & { timestamp?: number }> = [];
	const stack: GraphNode[] = [root];
	for (let node = stack.pop(); node; node = stack.pop()) {
		if (FS.isDir(node.mode)) {
			for (const child of Object.values((node.contents ?? {}) as Record<string, GraphNode>)) {
				stack.push(child);
			}
		} else if (node.contents instanceof Uint8Array) {
			result.bytes += node.contents.byteLength;
			files.push(node);
		}
	}
	files.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
	for (const file of files) {
		if (result.bytes <= maximum) break;
		const path = FS.getPath(file);
		if (!path.startsWith(`${TWIG}/`) || !path.endsWith('.php')) continue;
		const contents = file.contents as Uint8Array;
		FS.unlink(path);
		result.bytes -= contents.byteLength;
		result.evicted++;
		if (
			contents.buffer instanceof ArrayBuffer &&
			contents.buffer !== binary.HEAPU8?.buffer &&
			contents.byteOffset === 0 &&
			contents.byteLength === contents.buffer.byteLength
		) {
			const length = contents.byteLength;
			if (releaseOwnedBuffer(contents.buffer)) result.detachedBytes += length;
		}
	}
	return result;
}
