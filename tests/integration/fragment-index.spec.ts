import { describe, expect, it } from 'vitest';
import {
	createUser,
	harvestShell,
	renderFragments,
	renderPage,
	type RenderRequest
} from '../../src/drupal/site-php';
import {
	dirtyFragments,
	ensureFragmentTables,
	indexFragments,
	purgeShellsForTags,
	storedFragments,
	type DeclaredFragment
} from '../../src/ops/fragment-index';
import { placeholderIds } from '../../src/ops/shell-assembly';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The fragment index against a real render, because the split it indexes is Drupal's and not ours.
 *
 * Two measurements decide whether the index can exist at all, and both are taken here rather than
 * quoted: an anonymous page carries no holes, so the anonymous tier has nothing to address; and an
 * authenticated harvest reports FEWER cache tags than the anonymous render of the same path, because
 * `Renderer::renderPlaceholder()` keeps a placeholdered region's cacheability out of the response.
 * The tags in that gap are the ones a save can spend on a fragment instead of on a whole page.
 *
 * The row count is asserted through the object's own write meter rather than through the return
 * value, because "unchanged" has to mean "wrote nothing" and a counter the module keeps itself could
 * agree with the module while disagreeing with the meter.
 */

const TIMEOUT = 900_000;
const PASS = 'cfw-Fragment-Pass-4412';
const ORIGIN = 'https://do.local';

type Payload = Record<string, unknown>;

const form = (body: string): RenderRequest => ({
	method: 'POST',
	body,
	contentType: 'application/x-www-form-urlencoded',
	cookie: ''
});

function jarOf(result: Payload): string {
	const lines = Array.isArray(result['setCookie']) ? (result['setCookie'] as string[]) : [];
	const session = lines.find((line) => /^S?SESS/.test(line));
	return session ? (session.split(';')[0] ?? '') : '';
}

async function provision(site: ServeDo): Promise<string> {
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	await site.fetch(
		new Request('https://do.local/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ adminPass: PASS, siteName: 'Fragments' }),
			headers: { 'content-type': 'application/json' }
		})
	);
	await site.runJson(createUser({ name: 'alice', pass: PASS }));
	return jarOf(
		(await site.runJson(
			renderPage('/user/login', [], false, {
				...form(
					`name=alice&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`
				),
				origin: ORIGIN
			})
		)) as Payload
	);
}

/** rows the object charged for `work`, from the same meter `rows-per-fill-audit` reads */
async function chargedRows(site: ServeDo, work: () => Promise<void> | void): Promise<number> {
	await site.fetch(new Request('https://do.local/__writes?op=off'));
	await site.fetch(new Request('https://do.local/__writes?op=on'));
	await work();
	const tally = (await (await site.fetch(new Request('https://do.local/__writes'))).json()) as {
		rowsWritten: number;
	};
	return tally.rowsWritten;
}

function declare(
	recipes: Record<string, unknown>,
	tags: Record<string, string[]>
): DeclaredFragment[] {
	return Object.entries(recipes).map(([id, plan]) => ({ id, plan, tags: tags[id] ?? [] }));
}

describe('the fragment index, against the split Drupal already draws', () => {
	it(
		'indexes a real harvest, costs nothing to re-index, and scopes a save to one fragment',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const jar = await provision(site);

				// the anonymous tier first: what a stored page carries, and what it depends on
				await site.fillOne('/');
				const stored = site.sql
					.exec('SELECT html, tags FROM cfw_page WHERE path = ?', '/')
					.toArray()[0] as { html: string; tags: string };
				const anonymous = {
					holes: placeholderIds(String(stored.html)).length,
					tags: JSON.parse(String(stored.tags)) as string[]
				};

				const harvest = await site.runJson(
					harvestShell('/', { cookie: jar, origin: ORIGIN })
				);
				const recipes = (harvest['recipes'] ?? {}) as Record<string, unknown>;
				const shellTags = (harvest['cacheTags'] ?? []) as string[];
				const probe = await site.runJson(
					renderFragments('/', recipes, { cookie: jar, origin: ORIGIN })
				);
				const fragmentTags = (probe['fragmentTags'] ?? {}) as Record<string, string[]>;
				const fragments = declare(recipes, fragmentTags);

				site.ensureServeTables();
				ensureFragmentTables(site.sql);
				const generation = 7;

				let first!: Awaited<ReturnType<typeof indexFragments>>;
				const firstRows = await chargedRows(site, async () => {
					first = await indexFragments(site.sql, {
						path: '/',
						generation,
						fragments,
						nowMs: 1_000
					});
				});

				// the same page, the same generation, the same counters: a re-harvest is what every
				// new visitor to a shelled path costs, and it must not cost a row
				let again!: Awaited<ReturnType<typeof indexFragments>>;
				const againRows = await chargedRows(site, async () => {
					again = await indexFragments(site.sql, {
						path: '/',
						generation,
						fragments,
						nowMs: 2_000
					});
				});

				// one save, reaching one fragment. `config:system.menu.main` belongs to the main menu
				// block and to nothing else on this page
				const menuFragment = Object.keys(fragmentTags).find((id) =>
					(fragmentTags[id] ?? []).includes('config:system.menu.main')
				);
				site.sql.exec(
					`INSERT INTO cachetags (tag, invalidations) VALUES ('config:system.menu.main', 1)
           ON CONFLICT(tag) DO UPDATE SET invalidations = invalidations + 1`
				);
				const dirty = dirtyFragments(site.sql, ['config:system.menu.main']).map(
					(f) => f.id
				);

				let moved!: Awaited<ReturnType<typeof indexFragments>>;
				const movedRows = await chargedRows(site, async () => {
					moved = await indexFragments(site.sql, {
						path: '/',
						generation,
						fragments,
						nowMs: 3_000
					});
				});

				// and the shell around it, stored the way the wiring stores one
				const at = site.nowMs();
				site.sql.exec(
					`INSERT INTO cfw_shell (path, permissions_hash, shell, slots, recipes, harvested_at, tags)
           VALUES (?, ?, ?, '[]', ?, ?, ?)
           ON CONFLICT(path, permissions_hash) DO UPDATE SET tags = excluded.tags`,
					'/',
					'role-hash',
					String(harvest['html'] ?? ''),
					JSON.stringify(recipes),
					at,
					JSON.stringify(shellTags)
				);
				site.sql.exec(
					`INSERT INTO cfw_shell_verified (path, permissions_hash, uid, harvested_at, verified_at)
           VALUES ('/', 'role-hash', '2', ?, ?)`,
					at,
					at
				);
				const onFragment = purgeShellsForTags(site.sql, ['config:system.menu.main']);
				const survived = site.sql.exec('SELECT path FROM cfw_shell').toArray().length;
				const onShell = purgeShellsForTags(site.sql, ['node_list']);
				const remaining = site.sql.exec('SELECT path FROM cfw_shell').toArray().length;
				const verifiedLeft = site.sql
					.exec('SELECT path FROM cfw_shell_verified')
					.toArray().length;

				return {
					anonymous,
					shellTags,
					fragmentTags,
					fragmentsOnly: Object.values(fragmentTags)
						.flat()
						.filter((t) => !shellTags.includes(t)),
					first,
					firstRows,
					again,
					againRows,
					menuFragment,
					dirty,
					moved,
					movedRows,
					indexed: storedFragments(site.sql, '/').length,
					onFragment,
					survived,
					onShell,
					remaining,
					verifiedLeft
				};
			});

			console.log(
				`[fragment-index] ${JSON.stringify({
					anonymousHoles: out.anonymous.holes,
					anonymousTags: out.anonymous.tags.length,
					shellTags: out.shellTags.length,
					fragments: Object.keys(out.fragmentTags).length,
					fragmentsOnly: [...new Set(out.fragmentsOnly)],
					firstIndex: { ...out.first, addresses: undefined, rows: out.firstRows },
					reIndex: { ...out.again, addresses: undefined, rows: out.againRows },
					afterSave: { ...out.moved, addresses: undefined, rows: out.movedRows },
					purge: { onFragment: out.onFragment, onShell: out.onShell }
				})}`
			);

			// THE ANONYMOUS TIER HAS NO SEAM. BigPipe only placeholders a request with a session, and
			// `cfw_page` stores cookieless GETs, so there is nothing on that page to address
			expect(out.anonymous.holes).toBe(0);
			// and it pays for that: the same path depends on more tags anonymously than the shell does
			expect(out.anonymous.tags.length).toBeGreaterThan(out.shellTags.length);

			// the gap between the two is what the index spends on a fragment instead of on a page
			expect(Object.keys(out.fragmentTags).length).toBeGreaterThan(0);
			expect([...new Set(out.fragmentsOnly)].length).toBeGreaterThan(0);

			// every declared fragment reached a row on the first pass
			expect(out.first.written).toBe(Object.keys(out.fragmentTags).length);
			expect(out.firstRows).toBeGreaterThan(0);

			// AND THE RE-INDEX WROTE NOTHING, measured on the meter rather than counted here
			expect(out.again.written).toBe(0);
			expect(out.again.unchanged).toBe(out.first.written);
			expect(out.againRows).toBe(0);

			// one save, one fragment: the main menu is dirty and its siblings on the same page are not
			expect(out.menuFragment).toBeDefined();
			expect(out.dirty).toEqual([out.menuFragment]);
			expect(out.moved.written).toBe(1);
			expect(out.moved.unchanged).toBe(out.first.written - 1);
			expect(out.indexed).toBe(out.first.written);

			// the shell survives a save that only reached a fragment
			expect(out.onFragment.dropped).toBe(0);
			expect(out.onFragment.kept).toBe(1);
			expect(out.survived).toBe(1);
			// and goes when the save reaches its own bytes, taking its proofs with it
			expect(out.onShell.dropped).toBe(1);
			expect(out.remaining).toBe(0);
			expect(out.verifiedLeft).toBe(0);
		},
		TIMEOUT
	);
});
