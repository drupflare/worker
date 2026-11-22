import { describe, expect, it } from 'vitest';
import {
	checkMount,
	mountReuseArmed,
	settingsStamp,
	sourceStamp,
	stampMount,
	trimTwigCache,
	watchMount,
	type MountStamp
} from '../../../src/ops/mount-watch';

/**
 * The inputs a kept mount is judged on: the module rows, the settings inputs, and the changes made
 * to the filesystem since the mount.
 */

type ModuleRow = {
	path: string;
	package: string;
	version: string;
	source: string;
	installed_at: number;
};

/** a table of module rows behind the two statements `sourceStamp` runs */
function table(rows: ModuleRow[]) {
	const statements: string[] = [];
	const sql = {
		exec(query: string, ...bindings: unknown[]) {
			statements.push(query);
			const sorted = [...rows].sort((a, b) => (a.path < b.path ? -1 : 1));
			if (query.includes('WHERE path>?')) {
				const [after, limit] = bindings as [string, number];
				const page = sorted
					.filter((r) => r.path > after)
					.slice(0, limit)
					.map(({ source: _source, ...rest }) => rest);
				return { toArray: () => page };
			}
			const found = rows.find((r) => r.path === bindings[0]);
			return { toArray: () => (found ? [{ source: found.source }] : []) };
		}
	};
	return { sql: sql as unknown as SqlStorage, statements, rows };
}

const row = (path: string, patch: Partial<ModuleRow> = {}): ModuleRow => ({
	path,
	package: 'drupal/example',
	version: '1.0.0',
	source: '<?php // body',
	installed_at: 100,
	...patch
});

describe('sourceStamp', () => {
	it('is stable for the same rows in any insertion order', () => {
		const a = table([row('a.php'), row('b.php')]);
		const b = table([row('b.php'), row('a.php')]);
		expect(sourceStamp(a.sql)).toBe(sourceStamp(b.sql));
	});

	it.each([
		['path', { path: 'z.php' }],
		['package', { package: 'drupal/other' }],
		['version', { version: '1.0.1' }],
		['source, with the length unchanged', { source: '<?php // BODY' }],
		['install time', { installed_at: 101 }]
	] as const)('changes with the row %s', (_name, patch) => {
		const before = sourceStamp(table([row('a.php')]).sql);
		expect(sourceStamp(table([row('a.php', patch)]).sql)).not.toBe(before);
	});

	it('changes when a row is added or removed, and is defined for no rows', () => {
		const none = sourceStamp(table([]).sql);
		const one = sourceStamp(table([row('a.php')]).sql);
		expect(none).toMatch(/^[0-9a-f]{64}$/);
		expect(one).not.toBe(none);
	});

	it('does not let a field boundary slide', () => {
		const joined = sourceStamp(table([row('a.php', { package: 'ab', version: 'c' })]).sql);
		const slid = sourceStamp(table([row('a.php', { package: 'a', version: 'bc' })]).sql);
		expect(slid).not.toBe(joined);
	});

	it('reads one source statement per row and pages past the page size', () => {
		const many = table(
			Array.from({ length: 130 }, (_, i) => row(`m/${String(i).padStart(3, '0')}.php`))
		);
		sourceStamp(many.sql);
		expect(many.statements.filter((s) => s.includes('SELECT source')).length).toBe(130);
		expect(many.statements.filter((s) => s.includes('WHERE path>?')).length).toBe(3);
	});
});

describe('settingsStamp', () => {
	const site = (origin: string, settings: unknown) => ({
		canonicalOrigin: () => origin,
		bootSettings: () => settings
	});

	it('changes with the origin and with any boot setting', () => {
		const base = settingsStamp(site('https://a.test', { lane: 1 }));
		expect(settingsStamp(site('https://a.test', { lane: 1 }))).toBe(base);
		expect(settingsStamp(site('https://b.test', { lane: 1 }))).not.toBe(base);
		expect(settingsStamp(site('https://a.test', { lane: 2 }))).not.toBe(base);
	});
});

/** a filesystem with the members the watch wraps, recording each call it forwards */
function fakeFS() {
	const calls: string[] = [];
	const nodes = new Map<string, { path: string }>();
	const node = (path: string) => {
		const made = nodes.get(path) ?? { path };
		nodes.set(path, made);
		return made;
	};
	const streams = [
		null,
		null,
		null,
		{ node: node('/dev/stdout') },
		{ node: node('/drupal/a.txt') }
	];
	const FS = {
		streams,
		getPath: (n: { path: string }) => n.path,
		lookupPath: (path: string) => {
			if (!path.startsWith('/')) throw new Error('ENOENT');
			return { node: node(path) };
		},
		writeFile: (path: string) => void calls.push(`writeFile ${path}`),
		write: (fd: number) => void calls.push(`write ${fd}`),
		mkdir: (path: string) => void calls.push(`mkdir ${path}`),
		rename: (a: string, b: string) => void calls.push(`rename ${a} ${b}`),
		open: (path: string, flags: string | number) => void calls.push(`open ${path} ${flags}`),
		mmap: (_stream: unknown, _length: number, _position: number, prot: number) =>
			void calls.push(`mmap ${prot}`)
	};
	return { FS, calls };
}

describe('watchMount', () => {
	it('counts a write, a mkdir and both ends of a rename', () => {
		const { FS } = fakeFS();
		const binary = { FS };
		const watch = watchMount(binary);
		FS.writeFile('/drupal/sites/default/files/a.txt');
		FS.mkdir('/drupal/sites/default/files/d');
		FS.rename('/drupal/x', '/drupal/y');
		expect(watch.stats.mutations).toBe(4);
		expect(watch.stats.paths[0]).toBe('/drupal/sites/default/files/a.txt');
	});

	it('forwards every call it wraps', () => {
		const { FS, calls } = fakeFS();
		watchMount({ FS });
		FS.writeFile('/drupal/a');
		FS.open('/drupal/a', 'w');
		expect(calls).toEqual(['writeFile /drupal/a', 'open /drupal/a w']);
	});

	it('ignores the standard streams and counts the Twig cache apart', () => {
		const { FS } = fakeFS();
		const watch = watchMount({ FS });
		FS.write(3);
		FS.writeFile('/dev/null');
		FS.writeFile('/drupal/sites/default/files/php/twig/x/a.php');
		expect(watch.stats.mutations).toBe(0);
		expect(watch.stats.cacheMutations).toBe(1);
		FS.write(4);
		expect(watch.stats.mutations).toBe(1);
		expect(watch.stats.paths).toEqual(['/drupal/a.txt']);
	});

	it('counts an open that can write, and a writable mapping', () => {
		const { FS } = fakeFS();
		const watch = watchMount({ FS });
		FS.open('/drupal/r', 'r');
		FS.open('/drupal/n', 0);
		expect(watch.stats.mutations).toBe(0);
		FS.open('/drupal/w', 'w');
		FS.open('/drupal/c', 64);
		FS.mmap(FS.streams[4], 4096, 0, 1);
		expect(watch.stats.mutations).toBe(2);
		FS.mmap(FS.streams[4], 4096, 0, 3);
		expect(watch.stats.mutations).toBe(3);
	});

	it('is installed once per binary and resets to zero', () => {
		const { FS } = fakeFS();
		const binary = { FS };
		const first = watchMount(binary);
		expect(watchMount(binary)).toBe(first);
		FS.writeFile('/drupal/a');
		first.reset();
		expect(first.stats).toEqual({ mutations: 0, paths: [], cacheMutations: 0 });
		FS.writeFile('/drupal/b');
		expect(first.stats.mutations).toBe(1);
	});
});

describe('checkMount', () => {
	const settings = { canonicalOrigin: () => 'https://a.test', bootSettings: () => ({ lane: 1 }) };

	function mounted(rows: ModuleRow[]) {
		const { FS } = fakeFS();
		const binary: { FS: typeof FS; mountStamp?: MountStamp } = { FS };
		const t = table(rows);
		const site = { sql: t.sql, ...settings };
		stampMount(site, binary);
		return { binary, site, t, FS };
	}

	it('keeps a mount nothing has changed', () => {
		const m = mounted([row('a.php')]);
		expect(checkMount(m.site, m.binary)).toEqual({ kept: true, reason: 'unchanged' });
	});

	it('refuses a mount with no stamp', () => {
		const { FS } = fakeFS();
		expect(checkMount({ sql: table([]).sql, ...settings }, { FS })).toEqual({
			kept: false,
			reason: 'no stamp'
		});
	});

	it('refuses after a filesystem change', () => {
		const m = mounted([row('a.php')]);
		m.FS.writeFile('/drupal/a');
		expect(checkMount(m.site, m.binary).reason).toBe('mutated');
	});

	it('refuses when a module row changed, even by one byte of the same length', () => {
		const m = mounted([row('a.php')]);
		m.t.rows[0]!.source = '<?php // BODY';
		expect(checkMount(m.site, m.binary).reason).toBe('modules changed');
	});

	it('refuses when a settings input changed', () => {
		const m = mounted([row('a.php')]);
		const moved = { ...m.site, canonicalOrigin: () => 'https://b.test' };
		expect(checkMount(moved, m.binary).reason).toBe('settings changed');
	});

	it('refuses when the stamp cannot be read', () => {
		const m = mounted([row('a.php')]);
		const broken = {
			...m.site,
			sql: {
				exec: () => {
					throw new Error('no such table: cfw_module_file');
				}
			} as unknown as SqlStorage
		};
		expect(checkMount(broken, m.binary).reason).toBe('stamp unreadable');
	});

	it('takes no stamp, and so keeps nothing, when the rows cannot be read at mount time', () => {
		const { FS } = fakeFS();
		const binary: { FS: typeof FS; mountStamp?: MountStamp } = { FS };
		const broken = {
			...settings,
			sql: {
				exec: () => {
					throw new Error('unreadable');
				}
			} as unknown as SqlStorage
		};
		stampMount(broken, binary);
		expect(binary.mountStamp).toBeUndefined();
		expect(checkMount(broken, binary).reason).toBe('no stamp');
	});
});

describe('mountReuseArmed', () => {
	it('needs both flags at exactly 1', () => {
		expect(mountReuseArmed(undefined)).toBe(false);
		expect(mountReuseArmed({ REUSE_MOUNT: '1' })).toBe(false);
		expect(mountReuseArmed({ REFRESH_INSTANCE: '1' })).toBe(false);
		expect(mountReuseArmed({ REUSE_MOUNT: '1', REFRESH_INSTANCE: '0' })).toBe(false);
		expect(mountReuseArmed({ REUSE_MOUNT: '1', REFRESH_INSTANCE: '1' })).toBe(true);
	});
});

type TwigNode = {
	path: string;
	mode: number;
	name: string;
	contents: unknown;
	timestamp?: number;
};

const DIR = 0o040000;
const FILE = 0o100000;

function twigTree(files: Array<{ name: string; bytes: number; timestamp: number }>) {
	const dir: TwigNode = {
		path: '/drupal/sites/default/files/php/twig',
		mode: DIR,
		name: 'twig',
		contents: Object.create(null)
	};
	const heap = new Uint8Array(8);
	const made = files.map((f) => {
		const n: TwigNode = {
			path: `${dir.path}/${f.name}`,
			mode: FILE,
			name: f.name,
			contents: new Uint8Array(f.bytes),
			timestamp: f.timestamp
		};
		(dir.contents as Record<string, TwigNode>)[f.name] = n;
		return n;
	});
	const FS = {
		lookupPath: (path: string) => {
			if (path !== dir.path) throw new Error('ENOENT');
			return { node: dir };
		},
		isDir: (mode: number) => mode === DIR,
		getPath: (n: TwigNode) => n.path,
		unlink: (path: string) => {
			const name = path.split('/').at(-1)!;
			delete (dir.contents as Record<string, TwigNode>)[name];
		},
		nameTable: [],
		streams: []
	};
	return { binary: { FS, HEAPU8: heap }, made, dir };
}

describe('trimTwigCache', () => {
	it('evicts the oldest files until the cache fits', () => {
		const t = twigTree([
			{ name: 'new.php', bytes: 10, timestamp: 3 },
			{ name: 'old.php', bytes: 10, timestamp: 1 },
			{ name: 'mid.php', bytes: 10, timestamp: 2 }
		]);
		const out = trimTwigCache(t.binary, 15);
		expect(out).toMatchObject({ bytes: 10, evicted: 2, detachedBytes: 20 });
		expect(Object.keys(t.dir.contents as object)).toEqual(['new.php']);
	});

	it('leaves a cache that already fits and a tree that is not there', () => {
		const t = twigTree([{ name: 'a.php', bytes: 10, timestamp: 1 }]);
		expect(trimTwigCache(t.binary, 100)).toEqual({ bytes: 10, evicted: 0, detachedBytes: 0 });
		const bare = {
			FS: {
				lookupPath: () => {
					throw new Error('ENOENT');
				}
			}
		};
		expect(trimTwigCache(bare, 1)).toEqual({ bytes: 0, evicted: 0, detachedBytes: 0 });
	});

	it('only evicts compiled .php files', () => {
		const t = twigTree([
			{ name: 'a.txt', bytes: 50, timestamp: 1 },
			{ name: 'b.php', bytes: 50, timestamp: 2 }
		]);
		expect(trimTwigCache(t.binary, 10).evicted).toBe(1);
		expect(Object.keys(t.dir.contents as object)).toEqual(['a.txt']);
	});
});
