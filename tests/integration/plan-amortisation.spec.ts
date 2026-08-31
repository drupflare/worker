import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { renderPage, type RenderRequest } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Which compiled plans a single node save would take out, and what that does to the break-even.
 *
 * A plan costs two renders to compile and saves one render per serve, so it pays for itself only if
 * it survives long enough to be served. Tag-keyed invalidation is what decides that, and it decides
 * it per route: a settings form and a content listing bubble different tags and a content save is
 * not obliged to reach both.
 *
 * The intersection is the whole measurement, so an EMPTY invalidation set makes every plan survive
 * by construction and reads exactly like a plan that survives everything. Every assertion below that
 * looks redundant is there to separate those two: the save has to have produced a node id, the
 * generation has to have moved, and the flush has to have returned tags.
 *
 * `DRUPFLARE_MEASURE=1 bunx vitest run --project=workers tests/integration/plan-amortisation.spec.ts`
 */

const TIMEOUT = 900_000;
const MEASURING = (env as { DRUPFLARE_MEASURE?: string }).DRUPFLARE_MEASURE === '1';
const PASS = 'cfw-Amort-4417-pass';
const ROUTES = ['/admin/config/system/site-information', '/admin/content'];

/**
 * One origin for every render in the probe, because Drupal derives the session cookie NAME from the
 * request host. A login at Symfony's default `http://localhost` and a render at the object's own
 * origin do not share a cookie, so the second one is uid 0 with nothing to say it went wrong -- an
 * admin route then compiles cleanly as the access-denied page.
 */
const ORIGIN = 'https://do.local';

type Payload = Record<string, unknown>;

const render = (site: ServeDo, path: string, request: RenderRequest = {}) =>
	site.runJson(
		renderPage(path, ['page', 'dynamic_page_cache'], false, { origin: ORIGIN, ...request })
	) as Promise<Payload>;

const form = (body: string, cookie: string): RenderRequest => ({
	method: 'POST',
	body,
	contentType: 'application/x-www-form-urlencoded',
	cookie
});

function hiddenFields(html: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const tag of html.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []) {
		const name = /name="([^"]*)"/.exec(tag)?.[1];
		const value = /value="([^"]*)"/.exec(tag)?.[1] ?? '';
		if (name)
			fields[name] = value
				.replace(/&amp;/g, '&')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&quot;/g, '"')
				.replace(/&#0?39;/g, "'");
	}
	return fields;
}

const encodeForm = (fields: Record<string, string>) =>
	Object.entries(fields)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join('&');

/** the session cookie as a browser sends it back, attributes dropped */
function jarOf(result: Payload): string {
	const lines = Array.isArray(result['setCookie']) ? (result['setCookie'] as string[]) : [];
	const session = lines.find((line) => /^S?SESS/.test(line));
	return session ? (session.split(';')[0] ?? '') : '';
}

describe.skipIf(!MEASURING)('what one node save costs the compiled plans', () => {
	it(
		'compiles two authenticated plans, saves a node, and intersects the tags',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const first = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ adminPass: PASS, siteName: 'Amort' })
					})
				);
				expect(first.status, await first.clone().text()).toBe(200);

				const login = await render(
					site,
					'/user/login',
					form(
						`name=admin&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`,
						''
					)
				);
				const jar = jarOf(login);

				// the control that says whether an anonymous plan is the ROUTE's fault or the
				// compiler's: the same path, the same cookie, through the fragment directly
				const direct: Record<string, Payload> = {};
				const compiled: Record<string, Payload> = {};
				for (const route of ROUTES) {
					// the FIRST render of a route warms Drupal's asset caches, so it differs from the
					// second in the stylesheet list rather than in anything dynamic; the compile route
					// never sees that because its own pair runs after this one
					await render(site, route, { cookie: jar });
					const d = await render(site, route, { cookie: jar });
					const e = await render(site, route, { cookie: jar });
					const x = String(d['html'] ?? '');
					const y = String(e['html'] ?? '');
					let at = 0;
					while (at < x.length && at < y.length && x[at] === y[at]) at++;
					direct[route] = {
						uid: d['uid'],
						status: d['status'],
						bytes: d['bytes'],
						// the markup around the FIRST byte that differs, which is what says what an
						// unrecognised region actually is
						firstDiff: x.slice(Math.max(0, at - 90), at + 12)
					};
					const res = await site.fetch(
						new Request(
							`https://do.local/__plan?action=compile&path=${encodeURIComponent(route)}` +
								`&cookie=${encodeURIComponent(jar)}`
						)
					);
					compiled[route] = (await res.json()) as Payload;
					// and serve it, which is the only thing that proves the compiler's verdict is
					// worth anything: `unservable: []` is a claim about slots, this is a page
					const served = await site.fetch(
						new Request(
							`https://do.local/__plan?action=run&unsafe=1&path=${encodeURIComponent(route)}`
						)
					);
					const html = await served.text();
					compiled[route]!.servedStatus = served.status;
					compiled[route]!.servedBytes = html.length;
					compiled[route]!.servedDomId =
						/js-view-dom-id-([0-9a-f]{64})/.exec(html)?.[1] ?? null;
					compiled[route]!.servedBuildId =
						/name="form_build_id"\s+value="(form-[A-Za-z0-9_-]{43})"/.exec(html)?.[1] ??
						null;
				}

				// read BEFORE the save: the bump purges `cfw_plan` wholesale, so after it there is
				// nothing left to intersect against
				const planTags = Object.fromEntries(
					site.sql
						.exec('SELECT path, tags FROM cfw_plan')
						.toArray()
						.map((r) => [
							String(r.path),
							JSON.parse(String(r.tags ?? '[]')) as string[]
						])
				);

				// everything the login and the two compiles left behind, so the post-save set cannot
				// inherit a tag that belongs to another step
				const beforeSave = site.flushTagPurge();
				const generationBefore = site.generation();

				const addForm = await render(site, '/node/add/page', { cookie: jar });
				const fields = hiddenFields(String(addForm['html'] ?? ''));
				const created = await render(
					site,
					'/node/add/page',
					form(
						encodeForm({
							...fields,
							'title[0][value]': 'Amortisation One',
							'body[0][value]': 'body',
							'status[value]': '1',
							op: 'Save'
						}),
						jar
					)
				);
				const nid = Number(
					/\/node\/(\d+)/.exec(String(created['location'] ?? ''))?.[1] ?? '0'
				);

				const invalidated = site.flushTagPurge();
				const plansAfterSave = Number(
					site.sql.exec('SELECT COUNT(*) AS c FROM cfw_plan').toArray()[0]?.c ?? 0
				);
				// flagged at the write and not yet judged, which is the state an invocation that
				// died here would leave behind
				const staleAfterSave = Number(
					site.sql.exec('SELECT COUNT(*) AS c FROM cfw_plan WHERE stale = 1').toArray()[0]
						?.c ?? 0
				);
				// the real end-of-invocation settle, so survival is measured rather than modelled
				const settled = site.settlePlans(invalidated);
				const survivors = site.sql
					.exec('SELECT path FROM cfw_plan ORDER BY path')
					.toArray()
					.map((r) => String(r.path));
				return {
					plansAfterSave,
					staleAfterSave,
					settled,
					survivors,
					bumpCoalesced:
						(site as unknown as { bumpCoalesced?: boolean }).bumpCoalesced ?? false,
					jar: jar !== '',
					uid: login['uid'],
					direct,
					compiled,
					planTags,
					beforeSave,
					invalidated,
					nid,
					createStatus: created['status'],
					generationBefore,
					generationAfter: site.generation()
				};
			});

			const set = new Set(out.invalidated);
			const rows = Object.fromEntries(
				ROUTES.map((route) => {
					const tags = out.planTags[route] ?? [];
					const hit = tags.filter((t) => set.has(t));
					return [
						route,
						{ tags: tags.length, hit, survived: out.survivors.includes(route) }
					];
				})
			);
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						uid: out.uid,
						nid: out.nid,
						createStatus: out.createStatus,
						generation: [out.generationBefore, out.generationAfter],
						bumpCoalesced: out.bumpCoalesced,
						plansAfterSave: out.plansAfterSave,
						staleAfterSave: out.staleAfterSave,
						settled: out.settled,
						survivors: out.survivors,
						directRender: out.direct,
						tagsLeftBySetup: out.beforeSave,
						invalidatedByOneNodeSave: out.invalidated,
						plans: Object.fromEntries(
							Object.entries(out.compiled).map(([k, v]) => [
								k,
								{
									bytes: v.bytes,
									ops: v.ops,
									uid: v.uid,
									renderMs: v.renderMs,
									unservable: v.unservable,
									explainsBoth: v.explainsBoth,
									generatorAgrees: v.generatorAgrees,
									servedStatus: v.servedStatus,
									servedBytes: v.servedBytes,
									servedDomId: v.servedDomId,
									servedBuildId: v.servedBuildId,
									slots: Object.entries(
										(v.slots ?? {}) as Record<string, { kind: string }>
									)
										.map(([n, s]) => `${n}:${s.kind}`)
										.join(' ')
								}
							])
						),
						survival: rows
					},
					null,
					2
				)
			);

			// the probe fired: a real authenticated session, a real node, a real bump
			expect(out.jar).toBe(true);
			expect(out.uid).toBe(1);
			expect(out.nid).toBeGreaterThan(0);
			// without this the intersection is empty for a reason that has nothing to do with plans
			expect(out.invalidated.length).toBeGreaterThan(0);
			// and both plans have to exist, or "survives" is a statement about a missing row
			for (const route of ROUTES) expect(out.planTags[route]?.length ?? 0).toBeGreaterThan(0);
			// an ANONYMOUS plan for an admin route is a plan for the access-denied page, and its
			// tags are not the tags the authenticated tier bubbles
			for (const route of ROUTES) {
				expect((out.direct[route] as Payload).uid, `direct ${route}`).toBe(1);
				expect((out.compiled[route]!.uid as number[])[0], `compiled ${route}`).toBe(1);
				// the authenticated admin tier compiles with every region named, and serves
				expect(out.compiled[route]!.unservable, `unservable ${route}`).toEqual([]);
				expect(out.compiled[route]!.generatorAgrees, `generator ${route}`).toBe(true);
				expect(out.compiled[route]!.servedStatus, `served ${route}`).toBe(200);
			}
			// the view page is the one that needed two regions, and the id it serves is minted here
			const content = out.compiled['/admin/content']!;
			expect(content.servedDomId).toMatch(/^[0-9a-f]{64}$/);
			expect(content.servedBuildId).toBeTruthy();
			// both were flagged at the write, when nothing could be decided; the settle then kept
			// only the plan whose tags the save missed
			expect(out.staleAfterSave).toBe(2);
			expect(out.survivors).toEqual(['/admin/config/system/site-information']);
		},
		TIMEOUT
	);
});

/**
 * The survival rule the measurement reads, on one anonymous plan and one tag.
 *
 * The census above needs an authenticated session and a node save and runs for minutes, so what it
 * actually asserts -- that a compile stores the render's tags and that the settle keeps a plan whose
 * tags the invalidation missed -- is unenforced on every commit. Both directions are here, because
 * an EMPTY tag set survives everything by construction and reads exactly like a plan that survives
 * everything; that is the same trap the measurement's own docblock names.
 *
 * `stalePlans()` is driven directly. It is normally called from `execSql()` at the write, and a
 * write that reaches it costs a node save, which is what this exists not to pay.
 */
describe('a compiled plan against one invalidated tag', () => {
	it(
		'stores the tags it rendered with, and survives an invalidation that misses them',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const compiled = (await (
					await site.fetch(new Request(`${ORIGIN}/__plan?action=compile&path=%2F`))
				).json()) as Payload;
				const tags = JSON.parse(
					String(site.sql.exec('SELECT tags FROM cfw_plan').toArray()[0]?.tags ?? '[]')
				) as string[];

				// an invalidation that names none of them
				site.stalePlans();
				const missed = site.settlePlans(['cfw:no-plan-carries-this']);
				const afterMiss = Number(
					site.sql.exec('SELECT COUNT(*) AS c FROM cfw_plan').toArray()[0]?.c ?? 0
				);

				// and one that names the first
				site.stalePlans();
				const hit = site.settlePlans([tags[0] ?? '']);
				const afterHit = Number(
					site.sql.exec('SELECT COUNT(*) AS c FROM cfw_plan').toArray()[0]?.c ?? 0
				);

				return { compiled, tags, missed, afterMiss, hit, afterHit };
			});

			expect(out.compiled.ok).toBe(true);
			// the anonymous front page renders as uid 0, which is what makes it the cheap arm
			expect((out.compiled.uid as number[])[0]).toBe(0);
			expect(out.compiled.status).toBe(200);
			// without this the intersection below is empty for a reason that is not about plans
			expect(out.tags.length).toBeGreaterThan(0);

			expect(out.missed).toEqual({ purged: 0, cleared: true });
			expect(out.afterMiss).toBe(1);
			expect(out.hit.purged).toBe(1);
			expect(out.afterHit).toBe(0);
		},
		TIMEOUT
	);
});
