import { describe, expect, it } from 'vitest';
import { emptyTally } from '../../src/db/write-tally';
import { renderPage } from '../../src/drupal/site-php';
import {
	buildProfile,
	effectCensus,
	eligibilityRate,
	recordCapabilities,
	type EffectProfile
} from '../../src/ops/mutation-oracle';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What fraction of authenticated GETs is provably free of authoritative effects.
 *
 * The replica invariant spec asserts a handful of paths write no authoritative ROWS. This measures
 * the wider question over more surface and over every effect class -- SQL, files, mail, outbound
 * HTTP, queues, alarms, sequences, session and security state -- because a request that writes no
 * row and sends one mail is not replica-safe and the row count alone calls it clean.
 *
 * An UNARMED oracle observes nothing and reports nothing, which is indistinguishable from a clean
 * request, so `eligibilityRate()` scores only profiles whose instrumentation was installed and the
 * spec asserts none were dropped.
 */

const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Census-Pass-4412';
const ORIGIN = 'https://do.local';

type Payload = Record<string, unknown>;

/** paths a logged-in admin reaches on a site with no content of its own */
const PATHS = [
	'/',
	'/user/1',
	'/user/1/edit',
	'/admin/content',
	'/admin/people',
	'/admin/structure/types',
	'/admin/config',
	'/admin/modules',
	'/admin/reports/status',
	'/admin/reports/dblog'
] as const;

async function adminSession(site: ServeDo): Promise<string> {
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	await site.fetch(
		new Request('https://do.local/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ adminPass: PASS, siteName: 'Census' }),
			headers: { 'content-type': 'application/json' }
		})
	);
	const login = (await site.runJson(
		renderPage('/user/login', [], false, {
			method: 'POST',
			body: `name=admin&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`,
			contentType: 'application/x-www-form-urlencoded',
			cookie: '',
			origin: ORIGIN
		})
	)) as Payload;
	const lines = Array.isArray(login['setCookie']) ? (login['setCookie'] as string[]) : [];
	return (lines.find((l) => /^S?SESS/.test(l)) ?? '').split(';')[0] ?? '';
}

const get = (cookie: string) =>
	({ method: 'GET', body: '', contentType: '', cookie, origin: ORIGIN }) as const;

describe('how much authenticated traffic is provably replica-safe', () => {
	it(
		'profiles every effect class over a real authenticated sweep',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				const cookie = await adminSession(site);
				// warmed first: a first render populates caches and the question is about the
				// steady-state request a replica would actually serve
				for (const path of PATHS) {
					await site.runJson(renderPage(path, [], false, get(cookie)));
				}

				const calls = new Map<string, number>();
				const wrapped = recordEffectSurface(site, calls);

				const out: { path: string; status: number; profile: EffectProfile }[] = [];
				for (const path of PATHS) {
					calls.clear();
					site.writeTally = emptyTally();
					const result = (await site.runJson(
						renderPage(path, [], false, get(cookie))
					)) as Payload;
					const tally = site.writeTally ?? emptyTally();
					site.writeTally = undefined;
					out.push({
						path,
						status: Number(result['status'] ?? 0),
						profile: buildProfile(tally, new Map(calls), wrapped)
					});
				}
				return out;
			});

			for (const row of seen) {
				expect(row.status, `${row.path} did not render`).toBe(200);
			}

			const profiles = seen.map((row) => row.profile);
			const rate = eligibilityRate(profiles);

			// the control: a profile the oracle never armed reads as clean and must not be scored
			expect(
				rate.untrustworthy,
				'some profiles were built without instrumentation and cannot be scored'
			).toBe(0);
			expect(rate.total).toBe(PATHS.length);

			// the finding, reported by name so a regression says WHICH path became stateful
			const ineligible = seen
				.filter((row) => !row.profile.replicaEligible)
				.map((row) => `${row.path} -> ${row.profile.reasons.join('; ')}`);

			// a majority must be eligible or the topology is not worth building; the exact rate is
			// reported rather than pinned, because it moves with what the update machinery has
			// already fetched and pinning it would make this spec flaky by construction
			expect(
				rate.eligible,
				`only ${rate.eligible}/${rate.total} authenticated GETs are replica-safe: ${ineligible.join(' | ')}`
			).toBeGreaterThan(rate.total / 2);

			// and the census must have seen SOMETHING, or the sweep proved nothing
			const census = effectCensus(profiles);
			expect(
				Object.keys(census).length + rate.eligible,
				'the census observed no effects and no eligible paths'
			).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);
});

/**
 * Installs the counting wrappers on the live PHP module.
 *
 * The module is reachable only through `installCapabilities()`, which the object calls at boot, so
 * the wrappers go on afterwards -- the same ordering `wrapCrossings()` needs and for the same
 * reason: a wrapper applied before an installer is silently overwritten by it.
 */
function recordEffectSurface(site: ServeDo, calls: Map<string, number>): string[] {
	// `this.php` is `{ php, binary, out }`; the capabilities live on `binary`, and reaching for
	// `php` instead wraps nothing and reports every request clean
	const held = (site as unknown as { php?: { binary?: Record<string, unknown> } | null }).php;
	const binary = held?.binary;
	if (binary === undefined || binary === null) return [];
	return recordCapabilities(binary, calls);
}
