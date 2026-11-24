import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RetentionHost } from '../../src/do/host';
import { adoptRetained, resetPhp, retainInterpreter, retire } from '../../src/do/retention';
import { freshSite, inObject } from '../helpers/serve-do';

/**
 * An interpreter dropped for good has its filesystem graph released, at every place that forgets
 * one, and never while another object still runs it. `RELEASE_HOST_GRAPH=0` turns it off.
 *
 * The mount is a one-file fake; its file's byte length going to 0 is the release.
 */

const DIR = 0o040000;
const FILE = 0o100000;

type Node = {
	name: string;
	mode: number;
	contents: unknown;
	parent?: Node;
	cfwEntry?: unknown;
	name_next?: Node | null;
};

function mount() {
	const bytes = new Uint8Array([1, 2, 3, 4]);
	const top: Node = { name: '/', mode: DIR, contents: Object.create(null) };
	const root: Node = { name: 'drupal', mode: DIR, contents: Object.create(null), parent: top };
	(top.contents as Record<string, Node>)['drupal'] = root;
	const file: Node = { name: 'a.php', mode: FILE, contents: bytes, parent: root, cfwEntry: {} };
	(root.contents as Record<string, Node>)['a.php'] = file;
	const binary = {
		FS: {
			lookupPath: () => ({ node: root }),
			isDir: (mode: number) => mode === DIR,
			nameTable: [root, file],
			streams: []
		}
	};
	return {
		instance: { php: {}, binary, out: [] as string[] },
		released: () => bytes.byteLength === 0
	};
}

describe('the setter', () => {
	it('releases the graph of the sole owner with no variable set', async () => {
		const m = mount();
		await inObject(freshSite(), (site) => {
			site.php = m.instance;
			site.phpOwner = { current: site };
			site.php = undefined;
		});
		expect(m.released()).toBe(true);
	});

	it('releases nothing when the variable is 0', async () => {
		const m = mount();
		await inObject(freshSite(), (site) => {
			site.env['RELEASE_HOST_GRAPH'] = '0';
			try {
				site.php = m.instance;
				site.phpOwner = { current: site };
				site.php = undefined;
			} finally {
				delete site.env['RELEASE_HOST_GRAPH'];
			}
		});
		expect(m.released()).toBe(false);
	});

	it('leaves an instance another object adopted, until that object drops it', async () => {
		const m = mount();
		const outcome = await inObject(freshSite(), (site) => {
			const owner = { current: site as unknown };
			site.php = m.instance;
			site.phpOwner = owner;
			owner.current = {};
			site.php = undefined;
			const afterStale = m.released();
			owner.current = site;
			site.php = m.instance;
			site.php = undefined;
			return { afterStale, afterOwner: m.released() };
		});
		expect(outcome).toEqual({ afterStale: false, afterOwner: true });
	});

	it('leaves an instance that still holds parked sockets', async () => {
		const m = mount();
		await inObject(freshSite(), (site) => {
			site.php = m.instance;
			site.phpOwner = { current: site };
			site.parkSockets = { size: 1 };
			site.php = undefined;
		});
		expect(m.released()).toBe(false);
	});

	it('drops an interpreter whose filesystem lacks the members the release walks', async () => {
		const bare = { php: {}, binary: { FS: { lookupPath: () => ({ node: {} }) } }, out: [] };
		const dropped = await inObject(freshSite(), (site) => {
			site.php = bare as never;
			site.phpOwner = { current: site };
			site.php = undefined;
			return site.php === undefined;
		});
		expect(dropped).toBe(true);
	});
});

/** the parts of an object the retention helpers read, which a spec can supply without a boot */
function fakeHost(id: string, env: Record<string, string>, commitSeq = 1) {
	const host = {
		ctx: { id: { toString: () => id } },
		env,
		php: undefined as unknown,
		phpOwner: undefined as { current: unknown } | undefined,
		parkSockets: undefined as { size: number } | undefined,
		retired: false,
		retentionAdoptions: 0,
		lastRetention: undefined as unknown,
		nowMs: () => 0,
		commitSeq: () => commitSeq,
		dropInterpreter: () => {
			host.php = undefined;
		},
		sql: { exec: () => ({ toArray: () => [{ v: String(commitSeq) }] }) },
		storage: { deleteAlarm: async () => undefined, deleteAll: async () => undefined }
	};
	return host;
}

const asHost = (host: ReturnType<typeof fakeHost>) => host as unknown as RetentionHost;

/** an earlier object instance that retained an interpreter under `id` */
function retainedBy(id: string, env: Record<string, string>) {
	const m = mount();
	const earlier = fakeHost(id, env, 1);
	earlier.php = m.instance;
	earlier.phpOwner = { current: earlier };
	retainInterpreter(asHost(earlier));
	return { m, earlier };
}

describe('the retained copy', () => {
	const on = { MEMORY_TRACE: '1' };
	const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
	const releases = () =>
		logged.mock.calls.filter((c) => String(c[0]).includes('host-release')).length;

	afterEach(() => logged.mockClear());

	it('is released once when adoption finds it stale', () => {
		const { m } = retainedBy('stale-id', on);
		const adopter = fakeHost('stale-id', on, 2);
		adoptRetained(asHost(adopter));
		expect(adopter.lastRetention).toMatchObject({ adopted: false, reason: 'stale' });
		expect(m.released()).toBe(true);
		expect(releases()).toBe(1);
	});

	it('is kept when the earlier instance still holds parked sockets', () => {
		const { m, earlier } = retainedBy('socket-id', on);
		earlier.parkSockets = { size: 1 };
		const adopter = fakeHost('socket-id', on, 1);
		adoptRetained(asHost(adopter));
		expect(adopter.lastRetention).toMatchObject({ adopted: false, reason: 'sockets' });
		expect(m.released()).toBe(false);
	});

	it('is kept when adoption succeeds', () => {
		const { m } = retainedBy('adopt-id', on);
		const adopter = fakeHost('adopt-id', on, 1);
		adoptRetained(asHost(adopter));
		expect(adopter.lastRetention).toMatchObject({ adopted: true });
		expect(m.released()).toBe(false);
	});

	it('is released once by resetPhp', () => {
		const { m } = retainedBy('reset-id', on);
		resetPhp(asHost(fakeHost('reset-id', on)));
		expect(m.released()).toBe(true);
		expect(releases()).toBe(1);
	});

	it('is released once by retire, and the object is wiped', async () => {
		const { m } = retainedBy('retire-id', on);
		const host = fakeHost('retire-id', on);
		await retire(asHost(host));
		expect(host.retired).toBe(true);
		expect(m.released()).toBe(true);
		expect(releases()).toBe(1);
	});

	it('is released by none of the three when the variable is 0', async () => {
		const off = { RELEASE_HOST_GRAPH: '0', MEMORY_TRACE: '1' };
		const stale = retainedBy('off-stale-id', off);
		adoptRetained(asHost(fakeHost('off-stale-id', off, 2)));
		const reset = retainedBy('off-reset-id', off);
		resetPhp(asHost(fakeHost('off-reset-id', off)));
		const wiped = retainedBy('off-retire-id', off);
		await retire(asHost(fakeHost('off-retire-id', off)));
		expect([stale.m.released(), reset.m.released(), wiped.m.released()]).toEqual([
			false,
			false,
			false
		]);
		expect(releases()).toBe(0);
	});
});
