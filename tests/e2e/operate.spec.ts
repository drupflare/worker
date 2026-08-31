import { beforeAll, describe, expect, it } from 'vitest';
import { e2eGate, ENDPOINT } from './helpers/endpoint.js';
import {
	invalidate,
	migrate,
	newSiteName,
	prefill,
	provision,
	serve,
	transportFor,
	warm,
	type Transport
} from './helpers/lifecycle.js';
import {
	dropInterpreter,
	enableModule,
	files,
	saveNode,
	type SaveNodeReply
} from './helpers/operate.js';
import {
	ALL_IDS,
	extractAll,
	firstDifference,
	maskNonces,
	PERMISSIONS_HASH,
	twice,
	VIEW_DOM_ID
} from './helpers/twice.js';

/**
 * OPERATING a site, as opposed to provisioning one: content, modules, files, config, and the second
 * lifetime after the interpreter is discarded.
 *
 * `lifecycle.spec.ts` proves a site can be brought into existence. This proves it survives being
 * used, which is a different claim and the one that matters for years rather than minutes.
 *
 *   bun run test:e2e:lifecycle --only=operate
 */

const skip = await e2eGate();

const site = newSiteName('operate');
let t: Transport;

/** carried between stages: a lifecycle assertion is usually a comparison across two of them */
const seen: { node?: SaveNodeReply; homeSha?: string } = {};

beforeAll(async () => {
	t = transportFor(ENDPOINT, site);
	await provision(t);
	await migrate(t);
	await prefill(t);
}, 600_000);

describe.skipIf(skip)(`operating a site at ${ENDPOINT} (site ${site})`, () => {
	// #region content

	/**
	 * Content creation, restored.
	 *
	 * This step asserted the opposite until `node.type.page` was applied into `site.sqlite`: Drupal 11
	 * moved content types out of the `standard` profile into RECIPES, and the install ran the profile
	 * without them. It is INVERTED rather than deleted so a regression that removes the type again
	 * fails here loudly instead of silently reverting the site to one that cannot hold content.
	 */
	it('1. creates a node, and the second identical render is byte-identical', async () => {
		const created = await saveNode(t, { title: 'Operate probe one', body: 'first body' });
		expect(created.ok, JSON.stringify(created).slice(0, 400)).toBe(true);
		expect(created.nid).toBeGreaterThan(0);
		seen.node = created;

		const path = created.url ?? `/node/${created.nid}`;
		const pair = await twice(async () => (await serve(t, path)).body);
		expect(firstDifference(pair.first, pair.second)).toBeNull();
	});

	it('1b. a save bumps the generation, and the acting user is restored afterwards', async () => {
		const created = await saveNode(t, { title: 'Operate probe one-b', body: 'body b' });
		expect(created.ok).toBe(true);
		// a write must invalidate, or the new node is unreachable behind a stored page
		expect(created.generationAfter).toBeGreaterThan(created.generationBefore ?? 0);
		// the uid-1 poisoning fix: saveNode acts as the owner and MUST put the account back, or
		// every later render in this interpreter is admin HTML stored in the anonymous page cache
		expect(created.restoredUid).toBe(0);
	});

	/**
	 * The front-page memoisation bug lived exactly here.
	 *
	 * `PathMatcher::isFrontPage` memoises, so rendering another path first could make `/` stop
	 * believing it was the front page. Rendering `/` AFTER a node view, twice, is the sequence that
	 * exposes it -- and the second `/` must equal the first.
	 */
	it('2. renders / after another path, twice, with no memoised front-page drift', async () => {
		// a real node view first, which is the sequence the front-page memo bug needs
		await serve(t, seen.node?.url ?? '/filter/tips');
		const pair = await twice(async () => (await serve(t, '/')).body);
		expect(firstDifference(pair.first, pair.second)).toBeNull();
		seen.homeSha = pair.first;
		expect(pair.first).toContain('</html>');
	});

	it('3. routes a second unrelated path without inheriting the first', async () => {
		const home = (await serve(t, '/')).body;
		await warm(t, '/user/login');
		const other = await twice(async () => (await serve(t, '/user/login')).body);
		// `/user/login` carries a form, and `form_build_id` plus its `data-drupal-selector` are
		// minted per render by design -- so the comparison is of everything else
		const masked = maskNonces(other);
		expect(firstDifference(masked.first, masked.second)).toBeNull();
		// the two paths must not be the same document; a memoised route would make them equal
		expect(other.first).not.toBe(home);
	});

	it('3b. returning to / after two other paths still yields the original bytes', async () => {
		// the isFrontPage memo is order-sensitive, so the round trip is the assertion
		await serve(t, '/user/login');
		await serve(t, '/filter/tips');
		const home = await serve(t, '/');
		expect(firstDifference(seen.homeSha ?? '', home.body)).toBeNull();
	});

	/**
	 * The `Html::$seenIds` defect, asserted directly.
	 *
	 * A static that `drupal_static_reset()` does not clear makes every generated id come back
	 * suffixed `--2` on the second render in the same interpreter. Comparing the id SETS is a
	 * sharper assertion than comparing bodies: it fails with the actual duplicated ids in the
	 * message rather than a byte offset.
	 */
	it('4. emits the same element ids on both renders, with no --N suffixes appearing', async () => {
		const pair = await twice(async () => (await serve(t, '/')).body);
		const ids = {
			first: extractAll(pair.first, ALL_IDS),
			second: extractAll(pair.second, ALL_IDS)
		};
		const suffixedSecond = ids.second.filter((id) => /--\d+"/.test(id));
		const suffixedFirst = ids.first.filter((id) => /--\d+"/.test(id));
		expect(
			suffixedSecond.length,
			`ids gained a --N suffix on render 2: ${suffixedSecond.join(', ')}`
		).toBe(suffixedFirst.length);
		expect(ids.second).toEqual(ids.first);
	});

	// #endregion

	// #region edit and re-save

	/**
	 * The edit-and-re-save lane, driven through `/invalidate` because no node can be saved.
	 *
	 * The property under test is the one that matters -- a generation bump must make the stored copy
	 * unreachable and the next read must be a fresh render, byte-stable across two reads -- and it
	 * is reachable without content. When a node type is restored this should be re-pointed at a real
	 * edit.
	 */
	it('5. invalidating makes the stored page unreachable and the re-render byte-stable', async () => {
		const before = await warm(t, '/');
		expect(
			before.generation,
			'no generation header, so the comparison below is 0 vs 0'
		).not.toBeNull();
		const bumped = await invalidate(t);
		expect(bumped.generationAfter).toBeGreaterThan(bumped.generationBefore);

		await warm(t, '/');
		const after = await twice(async () => await serve(t, '/'));
		const stable = maskNonces({ first: after.first.body, second: after.second.body });
		expect(firstDifference(stable.first, stable.second)).toBeNull();
		expect(Number(after.first.generation)).toBeGreaterThan(Number(before.generation));

		// FOUND BY THIS ASSERTION: the re-render is NOT byte-identical to the pre-invalidate copy.
		// The only difference is Views' `js-view-dom-id`, which tracks the generation rather than
		// the content -- so the specific difference is named and everything else must still match.
		// Accepting "something changed" here would have hidden it.
		expect(before.byteLength).toBe(after.first.byteLength);
		const masked = maskNonces({ first: before.body, second: after.first.body });
		expect(firstDifference(masked.first, masked.second)).toBeNull();
	});

	/**
	 * The mechanism, isolated: the DOM id follows the GENERATION, not the content.
	 *
	 * Three `/assemble` re-renders at one generation are byte-identical; each `/invalidate` yields a
	 * new id and a new sha1 at an unchanged 12,304 bytes. Consequences worth knowing: a client
	 * revalidating after any invalidation always receives new bytes for identical content, so no
	 * content-addressed layer above `cfw_page` can dedupe across generations.
	 */
	it('5b. the only thing an invalidation changes in the HTML is the view DOM id', async () => {
		const before = await serve(t, '/');
		await invalidate(t);
		const after = await serve(t, '/');

		const idsBefore = extractAll(before.body, VIEW_DOM_ID);
		const idsAfter = extractAll(after.body, VIEW_DOM_ID);
		expect(idsBefore.length).toBeGreaterThan(0);
		expect(idsAfter).not.toEqual(idsBefore);

		const masked = maskNonces({ first: before.body, second: after.body });
		expect(firstDifference(masked.first, masked.second)).toBeNull();
	});

	/**
	 * The second nonce, isolated: `permissionsHash` follows the site's private key.
	 *
	 * `system.private_key` is absent from the shipped database and minted on the first live render,
	 * so the prefilled page carries a hash computed from the build machine's key. This asserts the
	 * key is per site and now stable, which is the correct posture -- not that the bytes match.
	 */
	it('5c. the permissions hash settles once the site has minted its own private key', async () => {
		await invalidate(t);
		const first = await serve(t, '/');
		await invalidate(t);
		const second = await serve(t, '/');
		const hashes = {
			first: extractAll(first.body, PERMISSIONS_HASH),
			second: extractAll(second.body, PERMISSIONS_HASH)
		};
		expect(hashes.first.length).toBeGreaterThan(0);
		// stable across generations once minted; it is the key that is per-site, not per-render
		expect(hashes.second).toEqual(hashes.first);
	});

	it('6. reports a warming window rather than serving a half-rendered page', async () => {
		// a 503 here is the designed refusal, not an outage: the object declines to gamble a
		// visitor on a cold render. What must never happen is a 200 with a truncated body
		const shot = await serve(t, '/');
		expect([200, 503]).toContain(shot.status);
		if (shot.status === 200) {
			expect(shot.body).toContain('</html>');
			expect(shot.byteLength).toBeGreaterThan(1000);
		} else {
			expect(shot.cache).toBe('MISS');
			expect(shot.retryAfter ?? '0').toMatch(/^\d+$/);
		}
	});

	// #endregion

	// #region modules

	it('7. enables a packed module, and enabling it again is a no-op rather than a repeat cost', async () => {
		const first = await enableModule(t, 'token');
		expect(first.discoverable, JSON.stringify(first).slice(0, 300)).toBe(true);
		expect(first.ok || first.alreadyEnabled).toBeTruthy();

		const second = await enableModule(t, 'token');
		expect(second.alreadyEnabled).toBe(true);
		// the second attempt must not pay the install again; rows written is the meter that binds
		expect(second.rowsWritten ?? 0).toBeLessThan(first.rowsWritten ?? Number.MAX_SAFE_INTEGER);
	});

	/**
	 * The refusal is the feature.
	 *
	 * Only four contrib modules are in the pack, so a user asking for anything else hits this path
	 * far more often than they hit a success. The exact text is asserted because "it failed" is
	 * unactionable and gets retried.
	 */
	it('8. refuses an absent module by name, identically on both attempts', async () => {
		const pair = await twice(async () => await enableModule(t, 'webform'));
		expect(pair.first.discoverable).toBe(false);
		// the message lives in `requirementsError`; `error` is unset on this path, and there are
		// THREE fields a failure can arrive in -- see the report note on /enable's error shape
		expect(pair.first.requirementsError).toBe('The module webform does not exist.');
		expect(pair.first.throwMessage).toContain('missing modules webform');
		expect(pair.second.requirementsError).toBe(pair.first.requirementsError);
		expect(pair.second.discoverable).toBe(false);
		// a refusal is not free, and the cost must not grow on a repeat
		expect(pair.second.rowsWritten).toBe(pair.first.rowsWritten);
	});

	it('9. still serves the site after a module enable and a refusal', async () => {
		// the enable bumped the generation, so `/` is unfilled again and a 503 here would be the
		// queue answering rather than the site being broken -- which is the claim under test
		await warm(t, '/');
		const pair = await twice(async () => await serve(t, '/'));
		expect(pair.first.status).toBe(200);
		const masked = maskNonces({ first: pair.first.body, second: pair.second.body });
		expect(firstDifference(masked.first, masked.second)).toBeNull();
		expect(pair.first.body).toContain('</html>');
	});

	// #endregion

	// #region files

	it('10. writes to public:// and reads the same bytes back, twice', async () => {
		const uri = 'public://operate/note.txt';
		const written = await files(t, { op: 'write', uri, body: 'durable-operate' });
		expect(written.ok, JSON.stringify(written).slice(0, 300)).toBe(true);

		const pair = await twice(async () => await files(t, { op: 'read', uri }));
		expect(pair.first.body).toBe('durable-operate');
		expect(pair.second.body).toBe(pair.first.body);
		expect(pair.second.bytes).toBe(pair.first.bytes);
	});

	it('11. survives an interpreter discard and still reads the file back', async () => {
		const uri = 'public://operate/note.txt';
		// `drop=1` discards the interpreter FIRST, so the read proves durability rather than
		// reading back a buffer the same interpreter wrote
		const afterDrop = await files(t, { op: 'read', uri, drop: true });
		expect(afterDrop.ok, JSON.stringify(afterDrop).slice(0, 300)).toBe(true);
		expect(afterDrop.body).toBe('durable-operate');
	});

	/**
	 * **`private://` IS NOT REFUSED**, which contradicts the expectation this step was written to
	 * confirm.
	 *
	 * Measured: a `private://` write returns `ok: true`, and the reply reports `privateClass` as
	 * `CfwFileStreamWrapper` -- the SAME wrapper class as `public://`. Both schemes are registered
	 * and both write to the durable store.
	 *
	 * The protection that does exist is one layer further out: the R2 mirror drain refuses to
	 * offload private files, so they are not published to a bucket. That is a real control and it is
	 * not the same control as refusing the write. Asserted here as what actually happens, so the
	 * behaviour is pinned either way -- if it is later made to refuse, this fails and the decision
	 * gets made explicitly rather than drifting.
	 */
	it('12. accepts a private:// write at the wrapper, identically both times', async () => {
		const pair = await twice(async () =>
			files(t, { op: 'write', uri: 'private://operate/secret.txt', body: 'nope' })
		);
		expect(pair.first.ok).toBe(true);
		expect(pair.second.ok).toBe(true);
		expect(pair.second.bytesWritten).toBe(pair.first.bytesWritten);
		// the same wrapper serves both schemes, which is why the write is not refused
		expect(pair.first.privateClass).toBe(pair.first.publicClass);
	});

	// #endregion

	// #region the second lifetime

	/**
	 * Hibernation's observable consequence, reproduced.
	 *
	 * This project's bugs cluster on the second lifetime because hibernation discards the
	 * interpreter while the database survives, so anything that was memoised into PHP statics is
	 * rebuilt while anything written to SQLite is not. `dropInterpreter()` reproduces exactly that
	 * split; it does NOT evict the Durable Object's own JS fields, and the helper says so.
	 */
	it('13. renders identically before and after an interpreter discard', async () => {
		const before = (await serve(t, '/')).body;
		await dropInterpreter(t);
		const after = await twice(async () => (await serve(t, '/')).body);

		expect(firstDifference(after.first, after.second)).toBeNull();
		// a cold interpreter must reproduce the same document, not merely a similar one
		expect(firstDifference(before, after.first)).toBeNull();
	});

	it('14. repeats the content refusal, module and file steps in the second lifetime', async () => {
		await dropInterpreter(t);

		// a save from a COLD interpreter: the bundle list is read from the database rather than
		// from interpreter state, so this must succeed exactly as the warm one did
		const created = await saveNode(t, { title: 'Second lifetime node', body: 'after drop' });
		expect(created.ok, JSON.stringify(created).slice(0, 400)).toBe(true);
		expect(created.nid).toBeGreaterThan(0);
		expect(created.restoredUid).toBe(0);

		const enabled = await enableModule(t, 'token');
		expect(enabled.alreadyEnabled).toBe(true);

		const read = await files(t, { op: 'read', uri: 'public://operate/note.txt' });
		expect(read.body).toBe('durable-operate');

		const pair = await twice(async () => (await serve(t, '/')).body);
		expect(firstDifference(pair.first, pair.second)).toBeNull();
	});

	it('15. leaves the front page renderable and complete at the end of the run', async () => {
		const pair = await twice(async () => await serve(t, '/'));
		expect(pair.first.status).toBe(200);
		expect(pair.first.byteLength).toBeGreaterThan(1000);
		expect(pair.first.body).toContain('</html>');
		// masked comparison: only the known render nonces may differ, nothing else
		const masked = maskNonces({ first: pair.first.body, second: pair.second.body });
		expect(firstDifference(masked.first, masked.second)).toBeNull();
	});

	// #endregion
});
