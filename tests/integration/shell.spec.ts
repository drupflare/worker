import { describe, expect, it } from 'vitest';
import {
	createUser,
	harvestShell,
	renderFragments,
	renderPage,
	type RenderRequest
} from '../../src/drupal/site-php';
import {
	assemble,
	fillIdentity,
	normaliseShell,
	normalisedShellsAgree,
	placeholderIds,
	type Identity
} from '../../src/ops/shell-assembly';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * P7's remaining half, measured end to end: what varies between two people, and what a fragment
 * render costs against the render it replaces.
 *
 * ## The holes are gated by the `render` bin, not by how many renders an interpreter has served
 *
 * `shell-derivation.spec.ts` reported that only the FIRST authenticated render in an interpreter
 * carries placeholders. That was an artifact of the arm it ran: it emptied no cache bins, so the
 * second render answered from `dynamic_page_cache`. Measured here, three personas, one object:
 *
 * | bins emptied                     | alice          | bob            | admin           |
 * | -------------------------------- | -------------- | -------------- | --------------- |
 * | none                             | 27,206 B, 5    | 18,234 B, 0    | 122,190 B, 6    |
 * | `dynamic_page_cache`             | 18,234 B, 0    | 18,234 B, 0    | 96,151 B, 0     |
 * | `dynamic_page_cache` + `render`  | 27,206 B, 5    | 27,206 B, 5    | 122,191 B, 6    |
 *
 * So a shell is HARVESTABLE ON DEMAND, which is what the architecture needed and what the earlier
 * reading denied. Emptying `dynamic_page_cache` alone is the trap: it produces a MISS with the
 * placeholders already substituted inline, which reads as "this page has no shell".
 *
 * ## What actually varies between two people
 *
 * Diffed outside every hole, alice against bob, both plain authenticated users. Four classes, and
 * nothing else:
 *
 * | what                                      | class            |
 * | ----------------------------------------- | ---------------- |
 * | `"uid":"2"` in drupalSettings and BigPipe | identity         |
 * | `/user/logout?token=...`                  | per-session CSRF |
 * | `data-contextual-token="..."`             | per-session CSRF |
 * | `js-view-dom-id-<hash>`                   | per-RENDER nonce |
 *
 * `permissionsHash` did NOT vary between them, which is the point: it varies by ROLE, so it is what
 * keys a shell to a role set. admin against alice differs by the navigation module's whole asset
 * set, so shells are not shared across role sets and the hash is what refuses it.
 *
 * ## The authorisation is byte equality, not the marker list
 *
 * A marker list is a guess. Normalising two people's renders and requiring the results to be
 * byte-identical is a proof about THIS page: anything person-varying that the list missed makes
 * them differ, and the harvest refuses. That is the assertion this file exists for.
 */

const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Shell-Pass-7714';

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

const ms = (p: Payload, key: string) => Number(p[key] ?? 0);

type Harvest = {
	anon: Payload;
	alice: Payload;
	bob: Payload;
	admin: Payload;
	recipes: Record<string, unknown>;
	frag: Payload;
	fragAgain: Payload;
	forged: Payload;
	inline: Payload;
	fullMs: number[];
	fragMs: number[];
};

async function harvestRun(): Promise<Harvest> {
	return inObject(freshSite(), async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		await site.fetch(
			new Request('https://do.local/__firstrun', {
				method: 'POST',
				body: JSON.stringify({ adminPass: PASS, siteName: 'Shell' }),
				headers: { 'content-type': 'application/json' }
			})
		);
		await site.runJson(createUser({ name: 'alice', pass: PASS }));
		await site.runJson(createUser({ name: 'bob', pass: PASS }));

		const login = async (name: string) =>
			jarOf(
				(await site.runJson(
					renderPage(
						'/user/login',
						[],
						false,
						form(
							`name=${name}&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`
						)
					)
				)) as Payload
			);
		const jars = {
			alice: await login('alice'),
			bob: await login('bob'),
			admin: await login('admin')
		};

		const anon = (await site.runJson(harvestShell('/'))) as Payload;
		const alice = (await site.runJson(harvestShell('/', { cookie: jars.alice }))) as Payload;
		const bob = (await site.runJson(harvestShell('/', { cookie: jars.bob }))) as Payload;
		const admin = (await site.runJson(harvestShell('/', { cookie: jars.admin }))) as Payload;
		const recipes = (alice['recipes'] ?? {}) as Record<string, unknown>;

		const frag = (await site.runJson(
			renderFragments('/', recipes, { cookie: jars.bob })
		)) as Payload;
		const fragAgain = (await site.runJson(
			renderFragments('/', recipes, { cookie: jars.alice })
		)) as Payload;

		// a recipe naming a callback nobody declared trusted, which is the shape an attacker would
		// need if placeholder ids were ever accepted from a visitor
		const forged = (await site.runJson(
			renderFragments(
				'/',
				{
					'forged=1': {
						'#lazy_builder': ['\\Drupal\\Core\\Site\\Settings::get', ['hash_salt']],
						'#cache': { max_age: 0 }
					}
				},
				{ cookie: jars.bob }
			)
		)) as Payload;

		const inline = (await site.runJson(
			renderPage('/', [], false, { cookie: jars.bob })
		)) as Payload;

		const fullMs: number[] = [];
		const fragMs: number[] = [];
		for (let i = 0; i < 5; i++) {
			fullMs.push(
				ms(
					(await site.runJson(
						renderPage('/', ['dynamic_page_cache'], false, { cookie: jars.bob })
					)) as Payload,
					'renderMs'
				)
			);
			fragMs.push(
				ms(
					(await site.runJson(
						renderFragments('/', recipes, { cookie: jars.bob })
					)) as Payload,
					'totalMs'
				)
			);
		}

		return {
			anon,
			alice,
			bob,
			admin,
			recipes,
			frag,
			fragAgain,
			forged,
			inline,
			fullMs,
			fragMs
		};
	});
}

const html = (p: Payload) => String(p['html'] ?? '');

describe('P7: harvesting and normalising a shared shell', () => {
	it(
		'gives every persona holes once the render bin is empty',
		async () => {
			const r = await harvestRun();
			for (const who of [r.alice, r.bob, r.admin]) {
				expect(who['ok']).toBe(true);
				expect(placeholderIds(html(who)).length).toBeGreaterThan(0);
			}
			// admin carries one MORE hole than a plain member: the navigation toolbar
			expect(placeholderIds(html(r.admin)).length).toBeGreaterThan(
				placeholderIds(html(r.alice)).length
			);
		},
		REQUEST_TIMEOUT
	);

	it(
		'normalises two members of one role set to the SAME bytes',
		async () => {
			const r = await harvestRun();
			expect(r.alice['uid']).not.toBe(r.bob['uid']);
			// the raw renders differ, which is what makes the agreement meaningful rather than
			// a comparison of two copies of one thing
			expect(html(r.alice)).not.toBe(html(r.bob));

			const verdict = normalisedShellsAgree(html(r.alice), html(r.bob));
			expect(verdict.reason).toBe('');
			expect(verdict.agree).toBe(true);
		},
		REQUEST_TIMEOUT
	);

	it(
		'refuses to share one shell across two role sets',
		async () => {
			const r = await harvestRun();
			expect(normalisedShellsAgree(html(r.alice), html(r.admin)).agree).toBe(false);

			// and the mechanism that refuses it at fill time, independent of the byte check
			const shell = normaliseShell(html(r.alice));
			expect(shell.ok).toBe(true);
			if (!shell.ok) return;
			const adminIdentity = (r.admin['recipes'] ? {} : {}) as Identity;
			const filled = fillIdentity(shell.shell, shell.slots, {
				...adminIdentity,
				uid: '1',
				permissionsHash: 'f'.repeat(64),
				csrf: { 'user/logout': 'x'.repeat(43) }
			});
			expect(filled.ok).toBe(false);
			if (!filled.ok) expect(filled.reason).toContain('another role set');
		},
		REQUEST_TIMEOUT
	);

	it(
		'slots exactly the four measured classes and nothing else',
		async () => {
			const r = await harvestRun();
			const shell = normaliseShell(html(r.alice));
			expect(shell.ok).toBe(true);
			if (!shell.ok) return;

			const kinds = new Set(shell.slots.map((s) => s.kind));
			expect([...kinds].sort()).toEqual(['csrf', 'nonce', 'permissions-hash', 'uid']);
			// the shell must not still carry the uid it was harvested with
			expect(shell.shell).not.toContain(`"uid":"${String(r.alice['uid'])}"`);
		},
		REQUEST_TIMEOUT
	);
});

describe('P7: the object stores and serves a shell', () => {
	it(
		'harvests under two sessions, refuses one, and answers an authenticated GET',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						body: JSON.stringify({ adminPass: PASS, siteName: 'Shell' }),
						headers: { 'content-type': 'application/json' }
					})
				);
				await site.runJson(createUser({ name: 'alice', pass: PASS }));
				await site.runJson(createUser({ name: 'bob', pass: PASS }));

				const origin = 'https://do.local';
				// THE ORIGIN IS THREADED INTO THE LOGIN, not just into the harvest. Drupal names the
				// session cookie SSESS on https and SESS on http, so a jar minted by a render with
				// no origin is invisible to a harvest that has one -- measured: the harvest came
				// back uid 0 with 0 placeholders and reported no error at all
				const login = async (name: string) =>
					jarOf(
						(await site.runJson(
							renderPage('/user/login', [], false, {
								...form(
									`name=${name}&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`
								),
								origin
							})
						)) as Payload
					);
				const aliceJar = await login('alice');
				const bobJar = await login('bob');
				const adminJar = await login('admin');
				const uidOf = async (jar: string) =>
					(
						(await site.runJson(
							renderFragments('/', {}, { cookie: jar, origin })
						)) as Payload
					)['uid'];
				const aliceUid = await uidOf(aliceJar);
				const bobUid = await uidOf(bobJar);

				const oneSession = await site.harvestShellFor('/', [aliceJar], origin);
				const twoSessions = await site.harvestShellFor('/', [aliceJar, bobJar], origin);
				// two role sets in one harvest is the case the byte check exists to refuse
				const mixedRoles = await site.harvestShellFor('/', [aliceJar, adminJar], origin);

				site.env.SHELL_ASSEMBLY = '1';
				const served = await site.fetch(
					new Request('https://do.local/__serve?path=/', { headers: { cookie: bobJar } })
				);
				const body = await served.text();

				site.env.SHELL_ASSEMBLY = '0';
				const withLeverOff = await site.fetch(
					new Request('https://do.local/__serve?path=/', { headers: { cookie: bobJar } })
				);

				return {
					oneSession,
					twoSessions,
					mixedRoles,
					status: served.status,
					cache: served.headers.get('x-cfw-cache'),
					holes: served.headers.get('x-cfw-shell-holes'),
					control: served.headers.get('cache-control'),
					// derived here rather than returned whole: the body is 27 KB and the assertions
					// are about what it does and does not carry
					slotsLeft: body.includes('cfw-slot-'),
					holesLeft: placeholderIds(body).length,
					carriesBob: body.includes('"uid":"' + String(bobUid) + '"'),
					carriesAlice: body.includes('"uid":"' + String(aliceUid) + '"'),
					leverOff: withLeverOff.headers.get('x-cfw-cache'),
					rows: site.sql.exec('SELECT path, permissions_hash FROM cfw_shell').toArray()
						.length
				};
			});

			expect(seen.oneSession.stored).toBe(false);
			expect(seen.oneSession.reason).toContain('two sessions');
			expect(seen.twoSessions.stored).toBe(true);
			expect(seen.twoSessions.holes).toBeGreaterThan(0);
			expect(seen.mixedRoles.stored).toBe(false);
			expect(seen.rows).toBe(1);

			expect(seen.cache).toBe('ASSEMBLED');
			expect(seen.status).toBe(200);
			expect(Number(seen.holes)).toBeGreaterThan(0);
			// a shell is shared; the page assembled from it is one visitor's and must never be stored
			expect(seen.control).toBe('private, no-store');
			// every slot filled and every hole closed: what reaches the visitor is a whole page
			expect(seen.slotsLeft).toBe(false);
			expect(seen.holesLeft).toBe(0);
			// and it is THEIR page, not the one the shell was harvested from
			expect(seen.carriesBob).toBe(true);
			expect(seen.carriesAlice).toBe(false);
			// and the lever is real rather than decorative
			expect(seen.leverOff).not.toBe('ASSEMBLED');
		},
		REQUEST_TIMEOUT
	);
});

describe('P7: the authentication boundary', () => {
	it(
		'never lets an anonymous visitor near the authenticated body',
		async () => {
			const r = await harvestRun();
			// the structural fact that moved P7's blocker: BigPipe only placeholders a request that
			// HAS a session, so the anonymous artifact `cfw_page` stores is not a shell and never
			// can be. Harvesting is an authenticated operation by construction
			expect(placeholderIds(html(r.anon))).toEqual([]);
			expect(html(r.anon)).not.toBe(html(r.alice));
			// 17,670 against 27,206 measured; a factor rather than a fraction, because a holed shell
			// is only ~1.5x the anonymous page and an earlier /2 assertion was measuring nothing
			expect(html(r.anon).length).toBeLessThan(html(r.alice).length);
			expect(r.anon['uid']).toBe(0);
			// two members returning near-identical markup is ALSO what a leaking cache looks like,
			// so the anonymous arm is the control that says it is not one
			expect(html(r.anon)).not.toContain('user-logged-in');
		},
		REQUEST_TIMEOUT
	);

	it(
		'derives placeholder ids from CONTENT, which is what makes a shell addressable',
		async () => {
			const r = await harvestRun();
			// `PlaceholderGenerator::createPlaceholder()` builds the token as
			// `Crypt::hashBase64(serialize($placeholder_render_array))` -- no session, no user and
			// no hash salt -- so two different people get the same ids for the same regions. That
			// is the property the whole architecture rests on, and it is asserted rather than read
			expect(placeholderIds(html(r.alice))).toEqual(placeholderIds(html(r.bob)));
			expect(placeholderIds(html(r.alice)).length).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);
});

describe('P7: the fragment source', () => {
	it(
		'replays a harvested recipe for a DIFFERENT session',
		async () => {
			const r = await harvestRun();
			expect(r.frag['ok']).toBe(true);
			expect(r.frag['failed']).toEqual([]);
			expect(r.frag['uid']).toBe(r.bob['uid']);
			expect(Object.keys(r.frag['fragments'] as object)).toHaveLength(
				Number(r.alice['recipeCount'])
			);

			// CORRECTNESS: what the fragment source produced is what the ordinary render produced
			// for the same user, byte for byte. An empty fragment is a real answer -- breadcrumbs
			// and local tasks are empty on the front page -- so only the non-empty ones can be
			// compared, and at least one has to be non-empty for the assertion to mean anything
			const rendered = Object.values(r.frag['fragments'] as Record<string, string>).filter(
				(v) => v !== ''
			);
			expect(rendered.length).toBeGreaterThan(0);
			for (const fragment of rendered) expect(html(r.inline)).toContain(fragment);
		},
		REQUEST_TIMEOUT
	);

	it(
		'reports the per-session identity the edge cannot compute',
		async () => {
			const r = await harvestRun();
			const bobIdentity = r.frag['identity'] as Identity;
			const aliceIdentity = r.fragAgain['identity'] as Identity;

			expect(bobIdentity.uid).toBe(String(r.bob['uid']));
			expect(aliceIdentity.uid).toBe(String(r.alice['uid']));
			// same role set, so the hash matches and a shell may be shared between them
			expect(bobIdentity.permissionsHash).toBe(aliceIdentity.permissionsHash);
			// the logout token is per SESSION and must not
			expect(bobIdentity.csrf?.['user/logout']).not.toBe(aliceIdentity.csrf?.['user/logout']);
		},
		REQUEST_TIMEOUT
	);

	it(
		'assembles a stored shell into the page the visitor should see',
		async () => {
			const r = await harvestRun();
			const shell = normaliseShell(html(r.alice));
			expect(shell.ok).toBe(true);
			if (!shell.ok) return;

			const filled = fillIdentity(shell.shell, shell.slots, r.frag['identity'] as Identity);
			expect(filled.ok).toBe(true);
			if (!filled.ok) return;

			const fragments = Object.entries(r.frag['fragments'] as Record<string, string>).map(
				([id, markup]) => ({ id, html: markup })
			);
			const out = assemble(filled.html, fragments);
			// EVERY HOLE FILLED is the property that matters; an unfilled one is a visitor seeing a
			// region simply absent
			expect(out.unfilled).toEqual([]);
			expect(out.filled).toHaveLength(placeholderIds(html(r.alice)).length);
			// and one recipe with no hole, which is a real state rather than a defect: Drupal
			// ATTACHES a placeholder for `olivero_primary_admin_actions` and the block renders
			// nothing for a plain member, so the span never reaches the body. assemble() reports it
			// instead of silently dropping it, which is what `unmatched` exists for
			expect(out.unmatched.length).toBe(fragments.length - out.filled.length);
			// the assembled page is bob's, not alice's
			expect(out.html).toContain(`"uid":"${String(r.bob['uid'])}"`);
			expect(out.html).not.toContain(`"uid":"${String(r.alice['uid'])}"`);
			expect(placeholderIds(out.html)).toEqual([]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'refuses a recipe naming an untrusted callback',
		async () => {
			const r = await harvestRun();
			// P7's security premise is STRUCTURAL: a recipe never comes from a visitor, it comes
			// from the host's own storage, so a forged placeholder id has nowhere to enter. This is
			// the layer BELOW that, measured rather than assumed -- core enforces
			// TrustedCallbackInterface on #lazy_builder, so even a recipe that did get in cannot
			// name an arbitrary callable
			expect(r.forged['ok']).toBe(false);
			expect(r.forged['failed']).toEqual(['forged=1']);
			expect(String(JSON.stringify(r.forged['failure'] ?? {}))).toContain('Trusted');
		},
		REQUEST_TIMEOUT
	);

	it(
		'costs a fraction of the render it replaces',
		async () => {
			const r = await harvestRun();
			const median = (xs: number[]) =>
				[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
			const full = median(r.fullMs);
			const frag = median(r.fragMs);
			console.log(
				`[p7-cost] n=5 full=${JSON.stringify(r.fullMs)} median=${full} | fragments=${JSON.stringify(r.fragMs)} median=${frag} | harvest=${String(r.alice['harvestMs'])}`
			);
			// GATE-LANE WALL CLOCK, and a RATIO rather than an absolute -- RULE 0 forbids quoting
			// either of these as a CPU cost. Both arms come off the same instrument in the same
			// interpreter, which is what makes the ratio worth having
			expect(frag).toBeLessThan(full / 2);
		},
		REQUEST_TIMEOUT
	);
});
