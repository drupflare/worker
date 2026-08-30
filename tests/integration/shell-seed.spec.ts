import { describe, expect, it } from 'vitest';
import { createUser, renderPage, type RenderRequest } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * A shell seeds itself from one visitor, which is what makes the lever do anything on a live site.
 *
 * `bumpGeneration()` purges every shell on EVERY invalidation including `cachetags`, because no
 * Drupal cache tag reaches one. That is correct, and with harvesting an operator action it meant
 * assembly stopped at the first content change and never restarted -- so the feature was off in
 * practice rather than in policy, and turning `SHELL_ASSEMBLY` on changed nothing.
 *
 * ONE SAMPLE IS SAFE HERE BECAUSE IT AUTHORISES A STORE AND NOT A SERVE. `assembleFor()` still
 * refuses every visitor whose own uid has not passed `verifyShellFor()`, so a shell seeded from one
 * person and wrong for the next is deleted on that visitor's first request, before it reaches them.
 */

const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Seed-Pass-4412';
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

async function siteWithUsers(site: ServeDo, members: readonly string[]) {
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	await site.fetch(
		new Request('https://do.local/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ adminPass: PASS, siteName: 'Seed' }),
			headers: { 'content-type': 'application/json' }
		})
	);
	for (const name of members) await site.runJson(createUser({ name, pass: PASS }));
	const jars: Record<string, string> = {};
	for (const name of members) {
		jars[name] = jarOf(
			(await site.runJson(
				renderPage('/user/login', [], false, {
					...form(
						`name=${name}&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`
					),
					origin: ORIGIN
				})
			)) as Payload
		);
	}
	return jars;
}

const shellCount = (site: ServeDo) => site.sql.exec('SELECT * FROM cfw_shell').toArray().length;

describe('a shell seeds itself, so assembly survives an invalidation', () => {
	it(
		'stores nothing until an authenticated request, then seeds and assembles',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				const jars = await siteWithUsers(site, ['alice', 'bob']);
				const alice = jars['alice'] as string;

				const beforeAny = shellCount(site);
				// nothing harvested, so this is the state a live site is in after any content change
				const seeded = await site.seedShellFrom('/', alice, ORIGIN);
				const afterSeed = shellCount(site);
				// alice's own normalised render IS the stored shell, so she needs no second harvest
				const aliceNext = await site.assembleFor('/', alice, ORIGIN);
				// bob is not covered by alice's seed and must prove himself first
				const bobFirst = await site.assembleFor('/', jars['bob'] as string, ORIGIN);

				return {
					beforeAny,
					afterSeed,
					seededVerdict: seeded?.verified ?? null,
					seededHoles: seeded?.holes ?? 0,
					aliceVerdict: aliceNext?.verified ?? null,
					bobVerdict: bobFirst?.verified ?? null
				};
			});

			expect(seen.beforeAny).toBe(0);
			expect(seen.afterSeed).toBe(1);
			// the seed answers from the harvest body, which is Drupal's own BigPipe stream
			expect(seen.seededVerdict).toBe('proven');
			expect(seen.seededHoles).toBeGreaterThan(0);
			// no second harvest for the visitor the shell came from
			expect(seen.aliceVerdict).toBe('cached');
			// and a different member is still gated on their own proof
			expect(seen.bobVerdict === 'proven' || seen.bobVerdict === 'refused').toBe(true);
		},
		REQUEST_TIMEOUT
	);

	it(
		'refuses to seed from an anonymous request, which has no holes to seed from',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				await siteWithUsers(site, ['alice']);
				const anon = await site.seedShellFrom('/', '', ORIGIN);
				return { anon, rows: shellCount(site) };
			});
			expect(seen.anon).toBeNull();
			expect(seen.rows).toBe(0);
		},
		REQUEST_TIMEOUT
	);
});
