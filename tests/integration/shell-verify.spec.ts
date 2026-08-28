import { describe, expect, it } from 'vitest';
import { createUser, renderPage, type RenderRequest } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * P92: no visitor is served an assembly that was not proven against their own render.
 *
 * ## What the harvest's two-session proof cannot see
 *
 * `harvestShellFor()` stores a shell only when two members of one role set normalise to the same
 * bytes, which refuses anything person-varying that BOTH samples happened to share. A third member
 * whose shared region differs -- an unread count, a per-user block core never placeholdered -- is
 * outside that proof, and the shell would be served to them anyway.
 *
 * So every `(path, permissions_hash, uid)` is proven once before it is ever assembled for. The
 * poisoned-shell case below is the falsification: with the verification skipped it fails, because
 * one visitor really does receive another's bytes.
 *
 * ## The comparison has to be harvest-against-harvest
 *
 * Three comparators were built and measured before this one. All three fail on a CORRECT shell:
 *
 * | comparator                                   | why it refuses a good shell                 |
 * | -------------------------------------------- | ------------------------------------------- |
 * | assembly vs normalised shell                 | `normaliseShell()` needs holes; an assembly has filled them |
 * | visitor's ordinary render, normalised        | an ordinary render never had holes at all   |
 * | assembly vs render, identity neutralised     | different asset sets by construction        |
 *
 * The third is the structural one and is why no amount of neutralising closes this: a shell exists
 * only because harvesting empties the render bin, so its personalised regions are holes whose
 * `#attached` libraries never reach the head, while an ordinary render substitutes them inline and
 * aggregates the libraries in. Measured diverging at offset 3407, `action-links.css` against
 * `block.css`. Harvesting the visitor puts both sides in the same mode.
 */

const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Shell-Pass-7714';
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

async function siteWithShell(site: ServeDo, members: readonly string[]) {
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	await site.fetch(
		new Request('https://do.local/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ adminPass: PASS, siteName: 'Shell' }),
			headers: { 'content-type': 'application/json' }
		})
	);
	for (const name of members) await site.runJson(createUser({ name, pass: PASS }));
	const login = async (name: string) =>
		jarOf(
			(await site.runJson(
				renderPage('/user/login', [], false, {
					...form(
						`name=${name}&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`
					),
					origin: ORIGIN
				})
			)) as Payload
		);
	const jars: Record<string, string> = {};
	for (const name of members) jars[name] = await login(name);
	return jars;
}

describe('P92: a shell is proven per visitor before it is assembled for them', () => {
	it(
		'proves a third member on first use, then assembles for them',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				const jars = await siteWithShell(site, ['alice', 'bob', 'carol']);
				const stored = await site.harvestShellFor(
					'/',
					[jars['alice'] as string, jars['bob'] as string],
					ORIGIN
				);
				const rows = () =>
					site.sql.exec('SELECT * FROM cfw_shell_verified').toArray().length;

				const before = rows();
				const first = await site.assembleFor('/', jars['carol'] as string, ORIGIN);
				const afterFirst = rows();
				const second = await site.assembleFor('/', jars['carol'] as string, ORIGIN);
				// a DIFFERENT member is not covered by carol's proof and pays her toll again
				const otherFirst = await site.assembleFor('/', jars['alice'] as string, ORIGIN);

				return {
					stored,
					before,
					afterFirst,
					afterAll: rows(),
					first: first?.verified ?? null,
					second: second?.verified ?? null,
					otherFirst: otherFirst?.verified ?? null,
					// the proven body is the visitor's own; it must not carry anyone else's uid
					firstHtml: first?.html ?? '',
					secondHtml: second?.html ?? ''
				};
			});

			expect(seen.stored.stored).toBe(true);
			// nothing is trusted until it is proven, and the proof is what the first request buys
			expect(seen.before).toBe(0);
			expect(seen.first).toBe('proven');
			expect(seen.afterFirst).toBe(1);
			// and the proof is durable, so the second request is the cheap path
			expect(seen.second).toBe('cached');
			// per visitor, not per role set: alice's own proof is a separate row
			expect(seen.otherFirst).toBe('proven');
			expect(seen.afterAll).toBe(2);
			expect(seen.firstHtml.length).toBeGreaterThan(0);
			expect(seen.secondHtml.length).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'drops a shell that carries bytes the visitor does not render, and says why',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				const jars = await siteWithShell(site, ['alice', 'bob', 'carol']);
				await site.harvestShellFor(
					'/',
					[jars['alice'] as string, jars['bob'] as string],
					ORIGIN
				);

				// POISONED: a marker outside every hole that no visitor's own render produces. This
				// is the shape of the defect the two-session proof cannot see -- content that both
				// harvest samples shared and a third member does not
				const before = site.sql.exec('SELECT shell FROM cfw_shell').toArray()[0];
				const poisoned = String(before?.['shell'] ?? '').replace(
					'</body>',
					'<p class="cfw-leak">alice has 3 unread messages</p></body>'
				);
				site.sql.exec('UPDATE cfw_shell SET shell = ? WHERE path = ?', poisoned, '/');

				const out = await site.assembleFor('/', jars['carol'] as string, ORIGIN);
				const refusal = site.metaGet('shellRefusal');
				const route = (await (
					await site.fetch(new Request('https://do.local/__shell?path=/'))
				).json()) as Record<string, unknown>;
				return {
					route,
					verdict: out?.verified ?? null,
					// the visitor must NOT receive the poisoned bytes
					leaked: (out?.html ?? '').includes('cfw-leak'),
					body: (out?.html ?? '').length,
					shellsLeft: site.sql.exec('SELECT * FROM cfw_shell').toArray().length,
					verifiedLeft: site.sql.exec('SELECT * FROM cfw_shell_verified').toArray()
						.length,
					refusal:
						refusal === null ? null : (JSON.parse(refusal) as Record<string, unknown>)
				};
			});

			// THE ASSERTION THIS FILE EXISTS FOR, and FIRST rather than after the bookkeeping:
			// with the verification skipped this is what fails, so the failure names the leak
			// instead of an enum mismatch that happens to sit in front of it
			expect(seen.leaked, "the visitor was served another person's bytes").toBe(false);
			expect(seen.verdict).toBe('refused');
			expect(seen.body).toBeGreaterThan(0);
			// the shell is shared, so an unsafe one is dropped rather than skipped for this visitor
			expect(seen.shellsLeft).toBe(0);
			expect(seen.verifiedLeft).toBe(0);
			// the operator surface reports it too, because the row itself is gone
			expect(seen.route.lastRefusal).not.toBeNull();
			expect(seen.route.stored).toEqual([]);
			expect(seen.route.verified).toEqual([]);
			// and an operator who re-harvests can find out why the last one went
			expect(seen.refusal).not.toBeNull();
			expect(String(seen.refusal?.['stored'])).toContain('cfw-leak');
			expect(Number(seen.refusal?.['at'])).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'drops the shell on a generation bump, including a cachetags one',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				const jars = await siteWithShell(site, ['alice', 'bob', 'carol']);
				const harvest = () =>
					site.harvestShellFor(
						'/',
						[jars['alice'] as string, jars['bob'] as string],
						ORIGIN
					);
				const counts = () => ({
					shells: site.sql.exec('SELECT * FROM cfw_shell').toArray().length,
					proofs: site.sql.exec('SELECT * FROM cfw_shell_verified').toArray().length
				});

				await harvest();
				await site.assembleFor('/', jars['carol'] as string, ORIGIN);
				const before = counts();
				// `cachetags` is the reason that SKIPS the dynamic-bin purge, so it is the one a
				// shell would survive if it were treated like the dynamic bin
				const bump = site.bumpGeneration('cachetags');
				const after = counts();

				const empty = site.bumpGeneration('cachetags');
				return { before, bump, after, emptyBump: empty.purgedShells };
			});

			expect(seen.before.shells).toBe(1);
			expect(seen.before.proofs).toBe(1);
			// a shell caches the shared region and no cache tag reaches it, so a bump must drop it
			expect(seen.bump.purgedShells).toBe(1);
			expect(seen.after.shells).toBe(0);
			// the proofs go with it; they were taken against an artifact that no longer exists
			expect(seen.after.proofs).toBe(0);
			// and a bump with nothing to purge reports nothing rather than a fixed number
			expect(seen.emptyBump).toBe(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		're-harvesting voids every proof taken against the old shell',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				const jars = await siteWithShell(site, ['alice', 'bob', 'carol']);
				const harvest = () =>
					site.harvestShellFor(
						'/',
						[jars['alice'] as string, jars['bob'] as string],
						ORIGIN
					);
				await harvest();
				const first = await site.assembleFor('/', jars['carol'] as string, ORIGIN);
				const cached = await site.assembleFor('/', jars['carol'] as string, ORIGIN);

				// the harvest timestamp is what a proof is taken against, so move it and the proof
				// must stop counting even though the row is still there
				site.sql.exec('UPDATE cfw_shell SET harvested_at = harvested_at + 1000');
				const afterReharvest = await site.assembleFor('/', jars['carol'] as string, ORIGIN);
				return {
					first: first?.verified ?? null,
					cached: cached?.verified ?? null,
					afterReharvest: afterReharvest?.verified ?? null,
					rows: site.sql.exec('SELECT * FROM cfw_shell_verified').toArray().length
				};
			});

			expect(seen.first).toBe('proven');
			expect(seen.cached).toBe('cached');
			// a shell harvested again is a different artifact, so it is proven again
			expect(seen.afterReharvest).toBe('proven');
			// re-proven in place rather than accumulating a row per harvest
			expect(seen.rows).toBe(1);
		},
		REQUEST_TIMEOUT
	);
});
