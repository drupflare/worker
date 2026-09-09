import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	REVISION_RETENTION,
	activeRevision,
	dropRevision,
	ensureRevTables,
	hashManifest,
	hashSource,
	isRevHash,
	listRevisions,
	manifestOf,
	materialise,
	parseManifest,
	planBlobs,
	planDeclared,
	previousRevision,
	recordRevision,
	retain,
	revisionByHash,
	revisionStatus,
	setActive,
	storeBlobs,
	type RevSql
} from '../../src/ops/module-rev';

/**
 * The revision store, against real SQLite rather than a fake.
 *
 * A fake would mean reimplementing the engine, and every function here is mostly its SQL, so the
 * assertions would be about the fake. `node:sqlite` is what the other storage specs in this lane
 * already use.
 *
 * Two properties carry the design. A blob already present costs nothing, which is what makes history
 * affordable against the row meter. And a blob whose bytes do not hash to the name it was sent under
 * is REFUSED, which is what stops a manifest naming content nobody reviewed.
 */

/** the `exec(text, ...params)` shape over a node handle, which is what `RevSql` narrows to */
function open(): RevSql & { close(): void } {
	const db = new DatabaseSync(':memory:');
	return {
		exec(sql: string, ...bindings: unknown[]) {
			const statement = db.prepare(sql);
			if (!/^\s*(SELECT|PRAGMA)/i.test(sql)) {
				statement.run(...(bindings as never[]));
				return { toArray: () => [] };
			}
			const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
			return { toArray: () => rows };
		},
		close: () => db.close()
	};
}

const run = (fn: () => void) => fn();

async function blobsFor(sources: Record<string, string>) {
	const out: { path: string; hash: string; bytes: number; source: string }[] = [];
	for (const [path, source] of Object.entries(sources)) {
		out.push({
			path,
			source,
			hash: await hashSource(source),
			bytes: new TextEncoder().encode(source).length
		});
	}
	return out;
}

async function commit(
	sql: RevSql,
	pkg: string,
	sources: Record<string, string>,
	label = 'a change'
) {
	const files = await blobsFor(sources);
	await storeBlobs(
		sql,
		files.map((f) => ({ hash: f.hash, source: f.source })),
		run
	);
	const manifest = Object.fromEntries(files.map((f) => [f.path, f.hash]));
	const rev = await hashManifest(manifest);
	const recorded = recordRevision(
		sql,
		{
			package: pkg,
			rev,
			kind: 'upload',
			label,
			origin: '/local',
			manifest,
			nowMs: 1_700_000_000_000
		},
		run
	);
	return { rev, ...recorded, manifest };
}

describe('a revision is its manifest', () => {
	it('hashes independently of the order the client walked its directory', async () => {
		const a = await hashManifest({ 'b.php': 'b'.repeat(64), 'a.php': 'a'.repeat(64) });
		const b = await hashManifest({ 'a.php': 'a'.repeat(64), 'b.php': 'b'.repeat(64) });
		expect(a).toBe(b);
		expect(isRevHash(a)).toBe(true);
		// and a different file set is a different revision
		expect(await hashManifest({ 'a.php': 'a'.repeat(64) })).not.toBe(a);
	});

	it('refuses anything that is not a lowercase sha256', () => {
		expect(isRevHash('a'.repeat(64))).toBe(true);
		expect(isRevHash('A'.repeat(64))).toBe(false);
		expect(isRevHash('a'.repeat(63))).toBe(false);
		expect(isRevHash('../etc/passwd')).toBe(false);
		expect(isRevHash(null)).toBe(false);
	});

	/** a throw here would lose the whole listing, so an unreadable manifest is an empty one */
	it('reads an unparseable manifest as empty rather than throwing', () => {
		expect(parseManifest('not json')).toEqual({});
		expect(parseManifest('[1,2]')).toEqual({});
		expect(parseManifest('{"a.php": 3}')).toEqual({});
		expect(parseManifest('{"a.php": "x"}')).toEqual({ 'a.php': 'x' });
	});
});

describe('blobs are content-addressed and verified', () => {
	it('charges nothing for a blob it already holds', async () => {
		const sql = open();
		ensureRevTables(sql);
		const first = await storeBlobs(
			sql,
			[{ hash: await hashSource('one'), source: 'one' }],
			run
		);
		expect(first).toMatchObject({ stored: 1, skipped: 0, rejected: [] });

		const again = await storeBlobs(
			sql,
			[{ hash: await hashSource('one'), source: 'one' }],
			run
		);
		expect(again).toMatchObject({ stored: 0, skipped: 1, bytes: 0 });
		sql.close();
	});

	/**
	 * THE SECURITY PROPERTY, and the reason the digest is worth one per blob.
	 *
	 * A manifest names files by hash. A client able to store chosen bytes under a chosen hash could
	 * make a later `activate` mount content that was never reviewed under a revision that was.
	 */
	it('refuses bytes that do not hash to the name they were sent under', async () => {
		const sql = open();
		ensureRevTables(sql);
		const honest = await hashSource('real');
		const result = await storeBlobs(
			sql,
			[
				{ hash: honest, source: 'real' },
				{ hash: honest, source: 'swapped' },
				{ hash: 'nonsense', source: 'x' }
			],
			run
		);
		expect(result.stored).toBe(1);
		expect(result.rejected).toEqual([honest, 'nonsense']);
		sql.close();
	});

	it('splits what the site holds from what it still needs', async () => {
		const sql = open();
		ensureRevTables(sql);
		const held = await hashSource('held');
		const fresh = await hashSource('fresh');
		await storeBlobs(sql, [{ hash: held, source: 'held' }], run);

		const plan = planBlobs(sql, [
			{ path: 'a.php', hash: held, bytes: 4 },
			{ path: 'b.php', hash: fresh, bytes: 5 },
			{ path: 'c.php', hash: 'bogus', bytes: 9 }
		]);
		expect(plan.have).toEqual([held]);
		expect(plan.want).toEqual([fresh, 'bogus']);
		// bogus contributes no bytes, because a hash that cannot be parsed carries no size either
		expect(plan.wantBytes).toBe(5);
		sql.close();
	});

	/**
	 * A file whose blob has not been uploaded yet is a CHANGE, never a removal.
	 *
	 * The first version of the route ran `planSync()` over only the declared files whose blobs were
	 * already held, because `planSync` compares by source and a file with no uploaded blob has no
	 * source to compare. `planSync` then saw a stored path that was not in its input and called it
	 * REMOVED -- so every modified file in an upload reported as a removal, and the caller was told
	 * its edit would delete the file it had just edited.
	 */
	it('counts an edited file as modified even before its bytes arrive', async () => {
		const sql = open();
		ensureRevTables(sql);
		const stored = new Map([
			['a.php', 'v1'],
			['b.php', 'same'],
			['gone.php', 'old']
		]);
		const unchanged = await hashSource('same');
		await storeBlobs(sql, [{ hash: unchanged, source: 'same' }], run);

		const plan = planDeclared(sql, stored, [
			// edited, and its new bytes are not here yet
			{ path: 'a.php', hash: await hashSource('v2'), bytes: 2 },
			// byte-identical, and the site holds the blob
			{ path: 'b.php', hash: unchanged, bytes: 4 },
			// brand new
			{ path: 'c.php', hash: await hashSource('new'), bytes: 3 }
		]);

		expect(plan.counts).toEqual({ added: 1, modified: 1, removed: 1, unchanged: 1 });
		expect(plan.removed).toEqual(['gone.php']);
		// two writes plus one delete, the way `planSync` charges them
		expect(plan.rowsWritten).toBe(3);
		sql.close();
	});

	/** a blob that IS held but differs from what is mounted is still a modification */
	it('does not call a held blob unchanged when the mounted file differs', async () => {
		const sql = open();
		ensureRevTables(sql);
		const other = await hashSource('different');
		await storeBlobs(sql, [{ hash: other, source: 'different' }], run);

		const plan = planDeclared(sql, new Map([['a.php', 'mounted']]), [
			{ path: 'a.php', hash: other, bytes: 9 }
		]);
		expect(plan.counts).toMatchObject({ modified: 1, unchanged: 0, added: 0, removed: 0 });
		sql.close();
	});

	it('reports a manifest naming a blob it does not hold rather than mounting a partial tree', async () => {
		const sql = open();
		ensureRevTables(sql);
		const here = await hashSource('here');
		await storeBlobs(sql, [{ hash: here, source: 'here' }], run);
		const seen = materialise(sql, { 'a.php': here, 'b.php': 'f'.repeat(64) });
		expect(seen.files).toEqual([{ path: 'a.php', source: 'here', bytes: 4 }]);
		expect(seen.missing).toEqual(['b.php']);
		sql.close();
	});
});

describe('revisions are history', () => {
	it('activates the newest and leaves the previous one reachable', async () => {
		const sql = open();
		ensureRevTables(sql);
		const one = await commit(sql, 'mantle2', { 'a.php': 'v1' }, 'first');
		const two = await commit(sql, 'mantle2', { 'a.php': 'v2' }, 'second');

		expect(activeRevision(sql, 'mantle2')?.rev).toBe(two.rev);
		expect(previousRevision(sql, 'mantle2')?.rev).toBe(one.rev);
		expect(listRevisions(sql, 'mantle2').map((r) => r.rev)).toEqual([two.rev, one.rev]);
		expect(revisionByHash(sql, 'mantle2', one.rev)?.label).toBe('first');
		sql.close();
	});

	/** the same file set uploaded twice is the same revision, not a second row */
	it('reuses a row for an identical manifest', async () => {
		const sql = open();
		ensureRevTables(sql);
		const first = await commit(sql, 'mantle2', { 'a.php': 'v1' });
		await commit(sql, 'mantle2', { 'a.php': 'v2' });
		const again = await commit(sql, 'mantle2', { 'a.php': 'v1' });

		expect(again.rev).toBe(first.rev);
		expect(again.reused).toBe(true);
		expect(listRevisions(sql, 'mantle2')).toHaveLength(2);
		expect(activeRevision(sql, 'mantle2')?.rev).toBe(first.rev);
		sql.close();
	});

	it('has nothing behind the first revision, and says so', async () => {
		const sql = open();
		ensureRevTables(sql);
		await commit(sql, 'mantle2', { 'a.php': 'only' });
		expect(previousRevision(sql, 'mantle2')).toBeNull();
		sql.close();
	});

	it('activates a stored revision without writing a new one', async () => {
		const sql = open();
		ensureRevTables(sql);
		const one = await commit(sql, 'mantle2', { 'a.php': 'v1' });
		await commit(sql, 'mantle2', { 'a.php': 'v2' });
		const target = revisionByHash(sql, 'mantle2', one.rev);

		setActive(sql, 'mantle2', target!.id, run);
		expect(activeRevision(sql, 'mantle2')?.rev).toBe(one.rev);
		expect(listRevisions(sql, 'mantle2')).toHaveLength(2);
		expect(manifestOf(sql, target!.id)).toEqual(one.manifest);
		sql.close();
	});
});

describe('dropping a revision frees only what nothing else names', () => {
	it('keeps a blob two manifests share and deletes one only the dropped revision named', async () => {
		const sql = open();
		ensureRevTables(sql);
		// `shared.php` is byte-identical across both, so both manifests name the same blob
		const one = await commit(sql, 'mantle2', { 'shared.php': 'same', 'gone.php': 'only-here' });
		await commit(sql, 'mantle2', { 'shared.php': 'same', 'kept.php': 'new' });

		const result = dropRevision(sql, 'mantle2', one.rev, run);
		expect(result).toMatchObject({ dropped: true, blobsFreed: 1 });

		const shared = await hashSource('same');
		expect(materialise(sql, { 'shared.php': shared }).missing).toEqual([]);
		expect(materialise(sql, { 'gone.php': await hashSource('only-here') }).missing).toEqual([
			'gone.php'
		]);
		sql.close();
	});

	/** the mounted tree would have no record of where it came from, which is the state to prevent */
	it('refuses to drop the active revision', async () => {
		const sql = open();
		ensureRevTables(sql);
		const only = await commit(sql, 'mantle2', { 'a.php': 'v1' });
		expect(dropRevision(sql, 'mantle2', only.rev, run)).toMatchObject({
			dropped: false,
			reason: 'that revision is active'
		});
		sql.close();
	});

	it('names an unknown revision rather than reporting a successful no-op', () => {
		const sql = open();
		ensureRevTables(sql);
		expect(dropRevision(sql, 'mantle2', 'a'.repeat(64), run)).toMatchObject({
			dropped: false,
			reason: 'no such revision'
		});
		sql.close();
	});

	it('retains the newest and never drops what is active', async () => {
		const sql = open();
		ensureRevTables(sql);
		for (let n = 1; n <= REVISION_RETENTION + 3; n++) {
			await commit(sql, 'mantle2', { 'a.php': `v${n}` }, `rev ${n}`);
		}
		const before = listRevisions(sql, 'mantle2', 200);
		expect(before).toHaveLength(REVISION_RETENTION + 3);

		const pruned = retain(sql, 'mantle2', REVISION_RETENTION, run);
		expect(pruned.dropped).toBe(3);
		const after = listRevisions(sql, 'mantle2', 200);
		expect(after).toHaveLength(REVISION_RETENTION);
		expect(after.some((r) => r.active)).toBe(true);
		sql.close();
	});
});

describe('status reports what is live', () => {
	it('reports every package, its active revision and its size', async () => {
		const sql = open();
		ensureRevTables(sql);
		await commit(sql, 'mantle2', { 'a.php': 'aaaa', 'b.php': 'bb' }, 'landed');
		await commit(sql, 'other', { 'c.php': 'c' });

		const all = revisionStatus(sql);
		expect(all.map((row) => row.package)).toEqual(['mantle2', 'other']);
		const mantle = all.find((row) => row.package === 'mantle2');
		expect(mantle).toMatchObject({ files: 2, bytes: 6, label: 'landed', revisions: 1 });

		expect(revisionStatus(sql, 'other')).toHaveLength(1);
		sql.close();
	});

	/** a package nobody has uploaded is an empty row rather than a missing one */
	it('answers for a package with no revisions at all', () => {
		const sql = open();
		ensureRevTables(sql);
		expect(revisionStatus(sql, 'nothing')).toEqual([
			{
				package: 'nothing',
				rev: null,
				kind: null,
				label: null,
				origin: null,
				files: 0,
				bytes: 0,
				at: null,
				revisions: 0
			}
		]);
		sql.close();
	});
});
