import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { drupalOp, renderPage, type RenderRequest } from '../../src/drupal/site-php';
import { claimSite, cookieJar, loginJar, type FormResult } from '../helpers/drupal-forms';
import { freshSite, inObject, probe, type ServeDo } from '../helpers/serve-do';

/**
 * How much of a site's authenticated GET surface a compiled plan can actually serve.
 *
 * Two routes is an existence proof, not a coverage claim. This enumerates the route collection
 * Drupal itself holds, keeps every GET route a signed-in editor can reach, compiles a plan for
 * each and records whether the compiler named every varying region.
 *
 * The route list comes from `router.route_provider`, so it cannot be a favourable hand-picked set;
 * what IS a judgement is the filter, and every rule it applies is reported with the result.
 *
 * `status` is echoed per route. A route censused as servable while every render answered 403 is a
 * measurement of the access-denied page, and 34 of them would look like coverage.
 *
 * `DRUPFLARE_MEASURE=1 bunx vitest run --project=workers tests/integration/plan-coverage.spec.ts`
 */

const TIMEOUT = 3_600_000;
const MEASURING = (env as { DRUPFLARE_MEASURE?: string }).DRUPFLARE_MEASURE === '1';
const LIMIT = Number((env as { DRUPFLARE_PLAN_ROUTES?: string }).DRUPFLARE_PLAN_ROUTES ?? '0');
const TIMING_N = Number(
	(env as { DRUPFLARE_PLAN_TIMING_N?: string }).DRUPFLARE_PLAN_TIMING_N ?? '15'
);
const PASS = 'cfw-Census-4417-pass';
const ORIGIN = 'https://do.local';

/** linear memory never returns under `USE_ZEND_ALLOC=0`, so the census drops on a cadence */
const DROP_EVERY = 25;

/**
 * The editor surfaces, weighted equally.
 *
 * There is no Drupal access log in this repository and none is invented. Equal weight over a named
 * list is a stated assumption; the unweighted route fraction beside it is the measurement.
 */
const EDITOR_SURFACES = [
	'/',
	'/node/1',
	'/node/1/edit',
	'/node/add/page',
	'/admin',
	'/admin/content',
	'/admin/structure',
	'/admin/people',
	'/admin/config',
	'/admin/reports/status',
	'/user/1',
	'/user/1/edit',
	'/admin/config/system/site-information'
];

/** the only placeholders the census fills; anything else leaves the route out of the denominator */
const SUBSTITUTIONS: Record<string, string> = {
	node: '1',
	user: '1',
	node_type: 'page'
};

/**
 * Routes excluded for a reason that is not about plans.
 *
 * `user.logout` ends the session every later route depends on, and `system.php` is phpinfo rather
 * than a Drupal render.
 */
const DENY = ['/user/logout', '/admin/reports/status/php'];

/**
 * Repetitions inside one timed sample, per arm.
 *
 * workerd's clock is 1 ms granular and two of the arms answer under that, so a per-request figure
 * taken directly reads 0 for both a plan and a cache hit and orders them by nothing.
 */
const REPS: Record<string, number> = {
	hitAnon: 50,
	planAnon: 50,
	planAuth: 50,
	renderAnon: 1,
	renderAuth: 1
};

type Payload = Record<string, unknown>;

type RouteSpec = {
	name: string;
	path: string;
	methods: string[];
	format: string | null;
	csrf: number;
	admin: number;
};

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

const jarOf = (result: Payload): string => cookieJar(result as FormResult);

const ROUTE_CENSUS = `
$routes = [];
foreach (\\Drupal::service('router.route_provider')->getAllRoutes() as $name => $route) {
  $req = $route->getRequirements();
  $routes[] = [
    'name' => $name,
    'path' => $route->getPath(),
    'methods' => array_values($route->getMethods()),
    'format' => isset($req['_format']) ? $req['_format'] : null,
    'csrf' => isset($req['_csrf_token']) ? 1 : 0,
    'admin' => $route->getOption('_admin_route') ? 1 : 0,
  ];
}
$out['routes'] = $routes;
$out['total'] = count($routes);
`;

/** the route's path with the placeholders this census can fill substituted, or null */
function concreteOf(path: string): string | null {
	const filled = path.replace(/\{([a-z0-9_]+)\}/gi, (whole, name: string) =>
		SUBSTITUTIONS[name] === undefined ? whole : SUBSTITUTIONS[name]
	);
	return filled.includes('{') ? null : filled;
}

/** why a route is not in the denominator, or null when it is */
function excluded(spec: RouteSpec, concrete: string | null): string | null {
	if (spec.methods.length > 0 && !spec.methods.includes('GET')) return 'not a GET';
	if (spec.format !== null && spec.format !== 'html') return `_format=${spec.format}`;
	if (spec.csrf === 1) return 'needs a CSRF token in the URL';
	// `/<front>`, `/<current>` and friends are internal pseudo-routes, not URLs a browser requests
	if (spec.path.includes('<')) return 'internal pseudo-route';
	if (concrete === null) return 'parameterised beyond the substitution map';
	if (DENY.some((d) => concrete === d || concrete.startsWith(d + '/'))) return 'denied by name';
	return null;
}

/** the shape of a value the compiler could not name, which is what a refusal groups by */
function shapeOf(s: string): string {
	if (s.length === 0) return 'empty';
	if (/^[0-9a-f]{64}$/.test(s)) return 'hex64';
	if (/^[0-9a-f]{128}$/.test(s)) return 'hex128';
	if (/^[0-9a-f]+$/.test(s)) return `hex-${s.length}`;
	if (/^[A-Za-z0-9_-]{43}$/.test(s)) return 'base64url-43';
	if (/^\d{10}$/.test(s)) return 'epoch-seconds';
	if (/^\d+$/.test(s)) return `digits-${s.length}`;
	if (/^[\d\s:.\-a-z]+$/i.test(s) && s.length < 40) return 'short-text';
	return `markup-${s.length < 200 ? 'small' : 'large'}`;
}

function stat(ms: number[]): Record<string, number> {
	const s = [...ms].sort((a, b) => a - b);
	const q = (p: number) => s[Math.floor(p * (s.length - 1))];
	return { n: s.length, min: q(0)!, p25: q(0.25)!, median: q(0.5)! };
}

describe.skipIf(!MEASURING)('how much of the authenticated surface a compiled plan covers', () => {
	it(
		'compiles a plan for every reachable authenticated GET route and prices the three tiers',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const first = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ adminPass: PASS, siteName: 'Census' })
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

				// node 1, so `/node/1` and `/node/1/edit` are pages rather than 404s
				const addForm = await render(site, '/node/add/page', { cookie: jar });
				const created = await render(
					site,
					'/node/add/page',
					form(
						encodeForm({
							...hiddenFields(String(addForm['html'] ?? '')),
							'title[0][value]': 'Census One',
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

				const census = await site.runJson(drupalOp(ROUTE_CENSUS));
				const all = (census['routes'] ?? []) as RouteSpec[];

				const kept: Array<{ spec: RouteSpec; concrete: string }> = [];
				const dropped: Record<string, number> = {};
				const seen = new Set<string>();
				for (const spec of all) {
					const concrete = concreteOf(spec.path);
					const why = excluded(spec, concrete);
					if (why !== null) {
						dropped[why] = (dropped[why] ?? 0) + 1;
						continue;
					}
					// two route names can resolve to one URL; the census is over URLs
					if (seen.has(concrete!)) {
						dropped['duplicate URL'] = (dropped['duplicate URL'] ?? 0) + 1;
						continue;
					}
					seen.add(concrete!);
					kept.push({ spec, concrete: concrete! });
				}
				kept.sort((a, b) => a.concrete.localeCompare(b.concrete));
				const targets = LIMIT > 0 ? kept.slice(0, LIMIT) : kept;

				const rows: Payload[] = [];
				let done = 0;
				for (const { spec, concrete } of targets) {
					if (done > 0 && done % DROP_EVERY === 0) site.php = null;
					done++;
					try {
						const compile = async () =>
							await site.fetch(
								new Request(
									`https://do.local/__plan?action=compile&path=${encodeURIComponent(concrete)}` +
										`&cookie=${encodeURIComponent(jar)}`
								)
							);
						// TWICE, and the pair is the control. The first render of a route in a fresh
						// session warms Drupal's asset library cache, so renders one and two differ in
						// the stylesheet list and every later region is misaligned behind it; renders
						// three and four do not. A one-compile census measures that, not the tier
						const cold = (await (await compile()).json()) as Payload;
						const res = await compile();
						const c = (await res.json()) as Payload;
						const slots = (c.slots ?? {}) as Record<string, { kind: string }>;
						const sample = (c.sample ?? {}) as Record<string, string>;
						const context = (c.context ?? {}) as Record<
							string,
							{ before: string; after: string }
						>;
						const unservable = (c.unservable ?? []) as string[];
						const row: Payload = {
							route: spec.name,
							path: concrete,
							admin: spec.admin,
							compiled: res.status === 200,
							reason: res.status === 200 ? null : String(c.reason ?? res.status),
							status: c.status ?? null,
							location: c.location ?? null,
							uid: Array.isArray(c.uid) ? c.uid[0] : null,
							bytes: c.bytes ?? null,
							ops: c.ops ?? null,
							renderMs: c.renderMs ?? null,
							kinds: Object.values(slots).map((s) => s.kind),
							unservable: unservable.length,
							coldUnservable: ((cold.unservable ?? []) as string[]).length,
							coldAgrees: cold.generatorAgrees ?? null,
							roundTrips: c.roundTrips ?? null,
							explainsBoth: c.explainsBoth ?? null,
							generatorAgrees: c.generatorAgrees ?? null,
							refusals: unservable.map((n) => ({
								shape: shapeOf(sample[n] ?? ''),
								bytes: (sample[n] ?? '').length,
								sample: (sample[n] ?? '').slice(0, 160),
								before: (context[n]?.before ?? '').slice(-80),
								after: (context[n]?.after ?? '').slice(0, 60)
							}))
						};
						// serving it is the only check that turns `unservable: []` into a page
						if (res.status === 200 && unservable.length === 0) {
							const served = await site.fetch(
								new Request(
									`https://do.local/__plan?action=run&unsafe=1&path=${encodeURIComponent(concrete)}`
								)
							);
							row.servedStatus = served.status;
							row.servedBytes = (await served.text()).length;
						}
						// a page whose every region is named and whose generator still disagreed:
						// repeated on the stored plan, so a one-in-N token draw is distinguishable
						// from a page the generator can never reproduce
						if (res.status === 200 && unservable.length === 0 && !c.generatorAgrees) {
							row.agree = await (
								await site.fetch(
									new Request(
										`https://do.local/__plan?action=agree&n=40&path=${encodeURIComponent(concrete)}`
									)
								)
							).json();
						}
						rows.push(row);
					} catch (e: unknown) {
						rows.push({
							route: spec.name,
							path: concrete,
							compiled: false,
							reason: `threw: ${(e as Error)?.message ?? e}`
						});
					}
				}

				// #region the three tiers, one clock
				site.php = null;
				// an anonymous plan for the same path the HIT answers, so the two are comparable
				const fill = await site.fillOne('/', ['page', 'dynamic_page_cache']);
				const anonPlan = () =>
					site.fetch(new Request('https://do.local/__plan?action=compile&path=%2F'));
				await anonPlan();
				const anonCompile = (await (await anonPlan()).json()) as Payload;
				// the compile emptied `cfw_page`'s reason to exist by re-rendering; refill it
				const refill = await site.fillOne('/', ['page', 'dynamic_page_cache']);

				const authPath = '/admin/content';
				const authPlan = () =>
					site.fetch(
						new Request(
							`https://do.local/__plan?action=compile&path=${encodeURIComponent(authPath)}` +
								`&cookie=${encodeURIComponent(jar)}`
						)
					);
				await authPlan();
				const authCompile = (await (await authPlan()).json()) as Payload;

				const arms: Record<string, number[]> = {
					hitAnon: [],
					planAnon: [],
					renderAnon: [],
					planAuth: [],
					renderAuth: []
				};
				const armBytes: Record<string, number> = {};
				const time = async (name: string, run: () => Promise<number>) => {
					const reps = REPS[name] ?? 1;
					const t0 = Date.now();
					let bytes = 0;
					for (let r = 0; r < reps; r++) bytes = await run();
					arms[name]!.push((Date.now() - t0) / reps);
					armBytes[name] = bytes;
				};
				const get = async (u: string) => {
					const r = await site.fetch(new Request(u));
					return (await r.text()).length;
				};
				const names = Object.keys(arms);
				for (let i = 0; i < TIMING_N; i++) {
					const order = i % 2 === 0 ? names : [...names].reverse();
					for (const name of order) {
						if (name === 'hitAnon')
							await time(name, async () => {
								const r = await site.fetch(
									new Request('https://do.local/__serve?path=%2F')
								);
								const p = await probe(r);
								armBytes['hitAnonCache'] = p.cache === 'HIT' ? 1 : 0;
								return p.body.length;
							});
						else if (name === 'planAnon')
							await time(name, () =>
								get('https://do.local/__plan?action=run&path=%2F')
							);
						else if (name === 'renderAnon')
							await time(name, () =>
								get('https://do.local/__plan?action=render&path=%2F')
							);
						else if (name === 'planAuth')
							await time(name, () =>
								get(
									`https://do.local/__plan?action=run&unsafe=1&path=${encodeURIComponent(authPath)}`
								)
							);
						else
							await time(name, () =>
								get(
									`https://do.local/__plan?action=render&path=${encodeURIComponent(authPath)}` +
										`&cookie=${encodeURIComponent(jar)}`
								)
							);
					}
				}
				// #endregion

				const heap = (await (
					await site.fetch(new Request('https://do.local/__heap?op=status'))
				).json()) as Payload;

				return {
					uid: login['uid'],
					nid,
					total: census['total'] ?? 0,
					censusError: census['error'] ?? null,
					dropped,
					kept: kept.length,
					rows,
					arms,
					armBytes,
					anonCompile: {
						unservable: anonCompile.unservable,
						uid: anonCompile.uid,
						bytes: anonCompile.bytes,
						generatorAgrees: anonCompile.generatorAgrees
					},
					authCompile: {
						unservable: authCompile.unservable,
						uid: authCompile.uid,
						bytes: authCompile.bytes,
						generatorAgrees: authCompile.generatorAgrees
					},
					fill,
					refill,
					linearMemoryBytes: heap['linearMemoryBytes'] ?? null
				};
			});

			const ok = out.rows.filter((r) => r.compiled === true && Number(r.status ?? 0) === 200);
			const servable = ok.filter(
				(r) => Number(r.unservable) === 0 && r.generatorAgrees === true
			);
			const byShape: Record<string, { routes: number; example: Payload | null }> = {};
			for (const r of ok) {
				for (const ref of (r.refusals ?? []) as Payload[]) {
					const key = String(ref.shape);
					byShape[key] ??= { routes: 0, example: null };
					byShape[key]!.routes++;
					byShape[key]!.example ??= { path: r.path, ...ref };
				}
			}
			// which generators the servable fraction actually rests on
			const kindTally: Record<string, number> = {};
			for (const r of ok) {
				const kinds = ((r.kinds ?? []) as string[]).slice().sort();
				const key = kinds.length === 0 ? 'no slots at all' : [...new Set(kinds)].join('+');
				kindTally[key] = (kindTally[key] ?? 0) + 1;
			}
			const surfaces = EDITOR_SURFACES.map((path) => {
				const row = out.rows.find((r) => r.path === path);
				return {
					path,
					censused: row !== undefined,
					status: row?.status ?? null,
					servable:
						row !== undefined &&
						Number(row.status ?? 0) === 200 &&
						Number(row.unservable) === 0 &&
						row.generatorAgrees === true
				};
			});
			const statuses: Record<string, number> = {};
			for (const r of out.rows) statuses[String(r.status ?? r.reason ?? '?')] ??= 0;
			for (const r of out.rows) statuses[String(r.status ?? r.reason ?? '?')]!++;

			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						uid: out.uid,
						nid: out.nid,
						routesInCollection: out.total,
						censusError: out.censusError,
						excludedBy: out.dropped,
						kept: out.kept,
						censused: out.rows.length,
						statuses,
						answered200: ok.length,
						servable: servable.length,
						unweightedFraction: ok.length === 0 ? null : servable.length / ok.length,
						// the same census taken from renders one and two, which is the harness
						// control rather than a second result
						servableCold: ok.filter(
							(r) => Number(r.coldUnservable) === 0 && r.coldAgrees === true
						).length,
						editorSurfaces: surfaces,
						weightedFraction:
							surfaces.filter((s) => s.servable).length / EDITOR_SURFACES.length,
						// the 200-only denominator is a judgement, so what it left out is named
						nonOk: out.rows
							.filter((r) => Number(r.status ?? 0) !== 200)
							.map((r) => ({
								path: r.path,
								status: r.status ?? null,
								reason: r.reason ?? null,
								location: r.location ?? null
							})),
						slotKinds: kindTally,
						refusalsByShape: byShape,
						// every region named and the generator still refused, which is a different
						// mechanism from an unnamed region and needs a different fix
						disagreed: ok
							.filter((r) => Number(r.unservable) === 0 && r.generatorAgrees !== true)
							.map((r) => ({
								path: r.path,
								kinds: r.kinds,
								ops: r.ops,
								agree: r.agree ?? null
							})),
						tiers: Object.fromEntries(
							Object.entries(out.arms).map(([k, v]) => [
								k,
								{ ...stat(v), bytes: out.armBytes[k] }
							])
						),
						hitWasAHit: out.armBytes.hitAnonCache === 1,
						anonCompile: out.anonCompile,
						authCompile: out.authCompile,
						fill: out.fill,
						refill: out.refill,
						linearMemoryBytes: out.linearMemoryBytes,
						refused: ok
							.filter((r) => Number(r.unservable) > 0)
							.map((r) => ({
								path: r.path,
								bytes: r.bytes,
								unservable: r.unservable,
								refusals: r.refusals
							}))
					},
					null,
					2
				)
			);

			// the probe fired at all: a real session, a real node, a real route collection
			expect(out.uid).toBe(1);
			expect(out.nid).toBeGreaterThan(0);
			expect(out.censusError).toBeNull();
			expect(Number(out.total)).toBeGreaterThan(100);
			// and rendered as the signed-in user, or the whole census is of the login page
			expect(ok.length).toBeGreaterThan(0);
			for (const r of ok.slice(0, 5)) expect(r.uid, String(r.path)).toBe(1);
			// every plan that claims to serve has to have served
			for (const r of servable) expect(r.servedStatus, String(r.path)).toBe(200);
		},
		TIMEOUT
	);
});

/**
 * The warm-up the census depends on, as a behaviour rather than as a measurement.
 *
 * The census above runs only under `DRUPFLARE_MEASURE` and takes an hour, so the property its whole
 * coverage figure rests on -- that a plan compiled from a route's FIRST two renders cannot serve --
 * is unenforced on every commit. `warmups` is a shipping default with nothing pinning it.
 *
 * One route, two cold sites, and the arms differ in nothing but `warmups`. Two sites rather than
 * two compiles on one, because the first compile is itself what warms the asset library cache.
 *
 * **EVERY ARM ASSERTS ITS OWN UID AND STATUS.** An arm that rendered anonymously compiles Drupal's
 * access-denied page instead, which reports `unservable: []` and `generatorAgrees: true` at ~15 KB
 * and reads as coverage. That is not hypothetical: the origin has to reach the login, because
 * Drupal names the session cookie after the request host and `/__plan` renders at
 * `canonicalOrigin(url.origin)`. A jar minted at `localhost` and spent at `https://do.local` is
 * uid 0 with a 403, and both helpers report success on the way there.
 */
describe('a plan compiled from a cold pair of renders', () => {
	const AUTH_PATH = '/admin/content';

	type Compile = {
		uid: number | null;
		status: number | null;
		unservable: number;
		generatorAgrees: boolean;
		bytes: number;
		ran: number;
	};

	async function compileOn(warmups: number | null): Promise<Compile> {
		return inObject(freshSite(), async (site: ServeDo) => {
			await claimSite(site, PASS, 'Warmup');
			// the SAME origin `/__plan` renders at, or the jar is for another host entirely
			const jar = await loginJar(site, 'admin', PASS, ORIGIN);
			const url =
				`${ORIGIN}/__plan?action=compile&path=${encodeURIComponent(AUTH_PATH)}` +
				`&cookie=${encodeURIComponent(jar)}` +
				(warmups === null ? '' : `&warmups=${warmups}`);
			const c = (await (await site.fetch(new Request(url))).json()) as Payload;
			const ran = await site.fetch(
				new Request(
					`${ORIGIN}/__plan?action=run&unsafe=1&path=${encodeURIComponent(AUTH_PATH)}`
				)
			);
			return {
				uid: Array.isArray(c.uid) ? (c.uid[0] as number) : null,
				status: (c.status ?? null) as number | null,
				unservable: ((c.unservable ?? []) as string[]).length,
				generatorAgrees: c.generatorAgrees === true,
				bytes: Number(c.bytes ?? 0),
				ran: ran.status
			};
		});
	}

	it(
		'cannot serve, while the shipping default can',
		async () => {
			const cold = await compileOn(0);
			const warm = await compileOn(null);

			// the arms are of the authenticated page and not of the 403 that looks like one
			for (const [name, arm] of [
				['cold', cold],
				['warm', warm]
			] as const) {
				expect(arm.uid, `${name} rendered as`).toBe(1);
				expect(arm.status, `${name} answered`).toBe(200);
			}

			// the first render of a route warms Drupal's asset library cache, so renders one and two
			// differ in their stylesheet list and every region behind it misaligns
			expect(cold.unservable, 'a cold pair named every region').toBeGreaterThan(0);
			expect(cold.ran, 'a plan with unnamed regions served anyway').toBe(409);

			expect(warm.unservable, `warm refused ${warm.unservable} region(s)`).toBe(0);
			expect(warm.generatorAgrees).toBe(true);
			expect(warm.ran).toBe(200);

			// and the cold plan is the larger one, because a misaligned region keeps the differing
			// markup as a slot instead of collapsing it into the constant bytes
			expect(cold.bytes).toBeGreaterThan(warm.bytes);
		},
		TIMEOUT
	);
});
