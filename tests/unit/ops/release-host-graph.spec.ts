import { describe, expect, it, vi } from 'vitest';
import {
	releaseHostGraph,
	releaseRetired,
	type GraphNode,
	type ReleasableBinary,
	type ReleasableFS
} from '../../../src/ops/release-host';

/**
 * releaseHostGraph: the host side of a mount is unlinked, and only bytes the mount owned detach.
 *
 * A fake Emscripten tree, shaped like the shipped glue's: nodes keyed by name in a directory's
 * `contents`, a name table whose chains run through `name_next`, and a stream table.
 */

const DIR = 0o040000;
const FILE = 0o100000;

const node = (name: string, mode: number, contents: unknown, parent?: GraphNode): GraphNode => {
	const made: GraphNode = { name, mode, contents, parent };
	if (parent) (parent.contents as Record<string, GraphNode>)[name] = made;
	return made;
};

type Tree = {
	binary: ReleasableBinary & { lookupMemo: { clear(): void } };
	nodes: Record<string, GraphNode>;
	buffers: Record<string, Uint8Array>;
	heap: Uint8Array;
	outside: GraphNode;
	memoCleared: () => number;
};

function tree(): Tree {
	const heap = new Uint8Array(64);
	const buffers = {
		clean: new Uint8Array([1, 2, 3, 4]),
		dirty: new Uint8Array([5, 6, 7, 8]),
		eager: new Uint8Array([9, 10]),
		aliased: heap
	};
	const root = node('drupal', DIR, Object.create(null), node('/', DIR, Object.create(null)));
	const sub = node('core', DIR, Object.create(null), root);
	const nodes: Record<string, GraphNode> = {
		root,
		sub,
		clean: node('clean.php', FILE, buffers.clean, sub),
		dirty: node('dirty.php', FILE, buffers.dirty, sub),
		eager: node('eager.txt', FILE, buffers.eager, root),
		aliased: node('heap.bin', FILE, buffers.aliased, root)
	};
	nodes.clean!.cfwEntry = { p: 'core/clean.php' };
	nodes.dirty!.cfwEntry = { p: 'core/dirty.php' };
	nodes.dirty!.cfwDirty = true;
	nodes.aliased!.cfwEntry = { p: 'heap.bin' };
	const outside = node('tmp', DIR, Object.create(null));

	// one chain holds a node outside the graph between two inside it
	const chain = [nodes.clean!, outside, nodes.dirty!, nodes.eager!];
	chain.forEach((n, i) => (n.name_next = chain[i + 1] ?? null));
	const nameTable: ReleasableFS['nameTable'] = [chain[0], nodes.root, nodes.sub, nodes.aliased];
	const streams: ReleasableFS['streams'] = [
		{ node: nodes.clean },
		{ node: outside },
		null,
		{ node: nodes.eager }
	];

	let cleared = 0;
	const binary = {
		FS: {
			lookupPath: (path: string) => {
				const mounted = (root.parent!.contents as Record<string, GraphNode>)['drupal'];
				if (path !== '/drupal' || !mounted) throw new Error(`ENOENT ${path}`);
				return { node: root };
			},
			isDir: (mode: number) => mode === DIR,
			nameTable,
			streams
		},
		HEAPU8: heap,
		lookupMemo: { clear: () => void cleared++ }
	};
	return { binary, nodes, buffers, heap, outside, memoCleared: () => cleared };
}

describe('releaseHostGraph', () => {
	it('unlinks every node under /drupal from the name table and the parent', () => {
		const t = tree();
		const stats = releaseHostGraph(t.binary);
		expect(stats.nodes).toBe(6);
		const table = t.binary.FS!.nameTable;
		// the chain keeps only the node that was never part of the mount
		expect(table[0]).toBe(t.outside);
		expect(t.outside.name_next).toBe(null);
		expect(table[1]).toBe(null);
		expect(table[2]).toBe(null);
		expect(table[3]).toBe(null);
		expect(Object.keys(t.nodes.root!.parent!.contents as object)).toEqual([]);
	});

	it('detaches the bytes of a clean lazy file and no other', () => {
		const t = tree();
		const stats = releaseHostGraph(t.binary);
		expect(t.buffers.clean!.byteLength).toBe(0);
		expect(stats.detachedBytes).toBe(4);
		expect(t.buffers.dirty!.byteLength, 'a dirty file has an owner outside').toBe(4);
		expect(t.buffers.eager!.byteLength, 'an eager file is not a private copy').toBe(2);
		expect(t.heap.byteLength, 'the wasm heap is never detached').toBe(64);
	});

	it('clears each node of its contents and its lazy bookkeeping', () => {
		const t = tree();
		releaseHostGraph(t.binary);
		expect(t.nodes.clean!.contents).toBe(null);
		expect(t.nodes.clean!.cfwEntry).toBeUndefined();
		expect(t.nodes.sub!.contents).toEqual({});
		expect(t.nodes.root!.contents).toEqual({});
	});

	it('empties the stream slots that hold a mount node and leaves the others', () => {
		const t = tree();
		const stats = releaseHostGraph(t.binary);
		expect(stats.streams).toBe(2);
		const streams = t.binary.FS!.streams;
		expect(streams[0]).toBe(null);
		expect(streams[1]?.node).toBe(t.outside);
		expect(streams[3]).toBe(null);
	});

	it('clears the lookup memo', () => {
		const t = tree();
		releaseHostGraph(t.binary);
		expect(t.memoCleared()).toBe(1);
	});

	it('falls back to a plain drop when the runtime cannot transfer', () => {
		const t = tree();
		Object.defineProperty(t.buffers.clean!.buffer, 'transfer', { value: undefined });
		const stats = releaseHostGraph(t.binary);
		expect(stats.detachedBytes).toBe(0);
		expect(t.buffers.clean!.byteLength).toBe(4);
		expect(t.nodes.clean!.contents).toBe(null);
	});

	it('returns an empty result with no FS or no mount', () => {
		expect(releaseHostGraph({})).toEqual({ nodes: 0, streams: 0, detachedBytes: 0 });
		const t = tree();
		t.binary.FS!.lookupPath = () => {
			throw new Error('ENOENT');
		};
		expect(releaseHostGraph(t.binary)).toEqual({ nodes: 0, streams: 0, detachedBytes: 0 });
		expect(t.buffers.clean!.byteLength).toBe(4);
	});

	it('is safe to run twice', () => {
		const t = tree();
		releaseHostGraph(t.binary);
		expect(releaseHostGraph(t.binary)).toEqual({ nodes: 0, streams: 0, detachedBytes: 0 });
	});
});

describe('releaseRetired', () => {
	it('releases nothing unless the flag is exactly 1', () => {
		for (const env of [
			undefined,
			{},
			{ RELEASE_HOST_GRAPH: '0' },
			{ RELEASE_HOST_GRAPH: 'true' }
		]) {
			const t = tree();
			expect(releaseRetired(env, { binary: t.binary })).toBeUndefined();
			expect(t.buffers.clean!.byteLength).toBe(4);
		}
	});

	it('releases the graph when the flag is 1 and reports what it freed', () => {
		const t = tree();
		const stats = releaseRetired({ RELEASE_HOST_GRAPH: '1' }, { binary: t.binary });
		expect(stats).toMatchObject({ nodes: 6, detachedBytes: 4 });
		expect(t.buffers.clean!.byteLength).toBe(0);
	});

	it('leaves an interpreter with no binary and one with parked sockets alone', () => {
		const env = { RELEASE_HOST_GRAPH: '1' };
		expect(releaseRetired(env, {})).toBeUndefined();
		const t = tree();
		expect(releaseRetired(env, { binary: t.binary }, { size: 1 })).toBeUndefined();
		expect(t.buffers.clean!.byteLength).toBe(4);
		expect(releaseRetired(env, { binary: t.binary }, { size: 0 })).toBeDefined();
	});

	it('logs one line when MEMORY_TRACE is 1', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		try {
			releaseRetired({ RELEASE_HOST_GRAPH: '1' }, { binary: tree().binary });
			expect(log).not.toHaveBeenCalled();
			releaseRetired(
				{ RELEASE_HOST_GRAPH: '1', MEMORY_TRACE: '1' },
				{ binary: tree().binary }
			);
			expect(log).toHaveBeenCalledTimes(1);
			expect(String(log.mock.calls[0]?.[0])).toContain('"cfw":"host-release"');
		} finally {
			log.mockRestore();
		}
	});
});
