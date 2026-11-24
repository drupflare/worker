import { describe, expect, it } from 'vitest';
import {
	ARMS,
	climb,
	DEFAULT_ADMIN,
	DEFAULT_STEP_CAP,
	LadderCapError,
	parseArgs,
	parseRung,
	parseSettles,
	parseStats,
	permalinkFields,
	prepareArm,
	readStats,
	summarise,
	type LadderDeps
} from '../../scripts/measure/ladder-arms';
import realStats from '../fixtures/serve-stats-real.json';

const TOKEN = 'owner-token-value';
const ORIGIN = 'https://cfw-x.example.workers.dev';

const rung = (id: string, n: number) =>
	JSON.stringify({ id, totalMiB: n * 4, linearMiB: 100, spareMiB: 0 });

/** answers one body per call, in order, then repeats the last; counts the calls */
function script(bodies: (string | Error | { status: number })[]) {
	const state = { calls: 0, seen: [] as { url: string; auth: string | null }[] };
	const fake = (async (url: string, init?: RequestInit) => {
		state.seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
		const next = bodies[Math.min(state.calls, bodies.length - 1)];
		state.calls += 1;
		if (next instanceof Error) throw next;
		if (typeof next === 'object') return new Response('no', { status: next.status });
		return new Response(next, { status: 200 });
	}) as unknown as typeof fetch;
	return { state, deps: { fetch: fake, sleep: async () => {} } satisfies LadderDeps };
}

describe('parseRung', () => {
	it('reads a rung the route would answer', () => {
		expect(parseRung(rung('a', 2))).toEqual({
			id: 'a',
			totalMiB: 8,
			linearMiB: 100,
			spareMiB: 0
		});
	});

	it.each([
		['not json', 'use POST'],
		['null', 'null'],
		['no id', '{"totalMiB":4,"linearMiB":1,"spareMiB":0}'],
		['empty id', '{"id":"","totalMiB":4,"linearMiB":1,"spareMiB":0}'],
		['a string total', '{"id":"a","totalMiB":"4","linearMiB":1,"spareMiB":0}'],
		['a missing field', '{"id":"a","totalMiB":4,"linearMiB":1}']
	])('refuses %s', (_name, text) => {
		expect(parseRung(text)).toBeUndefined();
	});
});

describe('climb', () => {
	it('stops at the first rung with another id and reports the last rung under the first', async () => {
		const { state, deps } = script([rung('a', 1), rung('a', 2), rung('a', 3), rung('b', 1)]);
		const out = await climb(ORIGIN, TOKEN, deps);
		expect(out).toEqual({
			status: 'replaced',
			steps: 3,
			headroomMiB: 12,
			first: { linearMiB: 100, spareMiB: 0 }
		});
		expect(state.calls).toBe(4);
	});

	it('is replaced on the second call when the first rung is already in a new isolate', async () => {
		const { deps } = script([rung('a', 1), rung('b', 1)]);
		expect(await climb(ORIGIN, TOKEN, deps)).toMatchObject({
			status: 'replaced',
			steps: 1,
			headroomMiB: 4
		});
	});

	it('sends the owner token as a bearer header to /ladder and nowhere else', async () => {
		const { state, deps } = script([rung('a', 1), rung('b', 1)]);
		await climb(ORIGIN, TOKEN, deps);
		expect(state.seen.every((s) => s.url === `${ORIGIN}/ladder`)).toBe(true);
		expect(state.seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
	});

	it('throws at the cap instead of returning a short reading', async () => {
		const { state, deps } = script([rung('a', 1)]);
		const caught = await climb(ORIGIN, TOKEN, deps, 5).catch((e: unknown) => e);
		expect(caught).toBeInstanceOf(LadderCapError);
		expect((caught as LadderCapError).steps).toBe(5);
		expect(state.calls).toBe(5);
	});

	it('uses a cap of 80 unless told otherwise', async () => {
		const { state, deps } = script([rung('a', 1)]);
		await expect(climb(ORIGIN, TOKEN, deps)).rejects.toBeInstanceOf(LadderCapError);
		expect(state.calls).toBe(DEFAULT_STEP_CAP);
		expect(DEFAULT_STEP_CAP).toBe(80);
	});

	it('reports a refused call with the rungs it had', async () => {
		const { deps } = script([rung('a', 1), { status: 502 }]);
		expect(await climb(ORIGIN, TOKEN, deps)).toMatchObject({
			status: 'call-failed',
			steps: 1,
			headroomMiB: 4
		});
	});

	it('reports a call that throws as failed', async () => {
		const { deps } = script([new Error('reset')]);
		expect(await climb(ORIGIN, TOKEN, deps)).toMatchObject({
			status: 'call-failed',
			steps: 0,
			headroomMiB: null
		});
	});

	it('reports a body that is not a rung as unparseable, not as a replacement', async () => {
		const { deps } = script([rung('a', 1), 'use POST']);
		expect(await climb(ORIGIN, TOKEN, deps)).toMatchObject({
			status: 'parse-failed',
			steps: 1
		});
	});

	it('logs every raw answer through record', async () => {
		const lines: Record<string, unknown>[] = [];
		const { deps } = script([rung('a', 1), rung('b', 1)]);
		await climb(ORIGIN, TOKEN, { ...deps, record: (e) => void lines.push(e) });
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({ phase: 'step', i: 1, httpStatus: 200 });
		expect(JSON.stringify(lines)).not.toContain(TOKEN);
	});
});

describe('parseArgs', () => {
	it('defaults to three reps of all four arms', () => {
		expect(parseArgs([`--origin=${ORIGIN}`])).toEqual({
			origin: ORIGIN,
			reps: 3,
			arms: [...ARMS],
			cap: 80,
			settle: [0],
			cms: 'drupal'
		});
	});

	it('takes an arm list, a rep count, a cap and an output file', () => {
		expect(
			parseArgs([
				`--origin=${ORIGIN}`,
				'--arms=bare,flush',
				'--reps=5',
				'--cap=120',
				'--out=x.jsonl'
			])
		).toEqual({
			origin: ORIGIN,
			reps: 5,
			arms: ['bare', 'flush'],
			cap: 120,
			settle: [0],
			cms: 'drupal',
			out: 'x.jsonl'
		});
	});

	it('takes a settle list', () => {
		expect(parseArgs([`--origin=${ORIGIN}`, '--settle=0,60,240']).settle).toEqual([0, 60, 240]);
		expect(parseArgs([`--origin=${ORIGIN}`, '--settle=90']).settle).toEqual([90]);
	});

	it.each([
		[[]],
		[['--origin=http://insecure.example']],
		[[`--origin=${ORIGIN}`, '--reps=0']],
		[[`--origin=${ORIGIN}`, '--arms=bare,deep']],
		[[`--origin=${ORIGIN}`, '--token=abc']],
		[[`--origin=${ORIGIN}`, 'stray']]
	])('refuses %j', (argv) => {
		expect(() => parseArgs(argv)).toThrow();
	});
});

describe('summarise', () => {
	it('prints the arm, the rep and the result and nothing else', () => {
		const line = summarise('bare', 2, {
			status: 'replaced',
			steps: 54,
			headroomMiB: 216,
			first: { linearMiB: 1, spareMiB: 0 }
		});
		expect(JSON.parse(line)).toMatchObject({
			arm: 'bare',
			rep: 2,
			steps: 54,
			headroomMiB: 216
		});
	});
});

describe('parseSettles', () => {
	it('reads seconds, fractions included', () => {
		expect(parseSettles('0,60,240')).toEqual([0, 60, 240]);
		expect(parseSettles('1.5')).toEqual([1.5]);
	});

	it.each([[''], ['-5'], ['10,'], ['a'], ['1e3']])('refuses %j', (value) => {
		expect(() => parseSettles(value)).toThrow(/--settle/);
	});
});

describe('stats before the first rung', () => {
	const body = JSON.stringify({
		crossings: {
			total: 9,
			bytes: { in: 120, out: 4096, maxIn: 50, maxOut: 4000, maxName: 'sql' }
		},
		isolateBytes: { linear: 67108864, mount: 0, total: 70000000, ceiling: 134217728 },
		secret: 'ignored'
	});

	it('prefers a live crossings.bytes when a build reports one', () => {
		expect(parseStats(body)).toEqual({
			bridge: { in: 120, out: 4096, maxIn: 50, maxOut: 4000, maxName: 'sql' },
			bridgeField: 'crossings.bytes',
			isolateBytes: { linear: 67108864, mount: 0, total: 70000000, ceiling: 134217728 }
		});
	});

	it('reads the last request tally from a real /serve-stats body, where crossings has no bytes', () => {
		const real = JSON.stringify(realStats);
		expect(realStats.crossings).not.toHaveProperty('bytes');
		const out = parseStats(real);
		expect(out).toEqual({
			bridge: {
				in: 72674,
				out: 28757,
				maxIn: 25344,
				maxOut: 7674,
				maxName: 'cfwSqlExec',
				path: '/',
				method: 'GET',
				renderBytes: 17686
			},
			bridgeField: 'demand[last].bridge',
			crossingsTotal: 56,
			isolateBytes: expect.objectContaining({ linear: 67108864, ceiling: 134217728 })
		});
	});

	it('takes the newest demand entry that has a bridge and skips alarm rows without one', () => {
		const out = parseStats(
			JSON.stringify({
				demand: [
					{ path: '/a', method: 'GET', bridge: { in: 1, out: 2 } },
					{ path: '(alarm fill)', method: 'ALARM' }
				]
			})
		);
		expect(out?.bridge).toEqual({ in: 1, out: 2, path: '/a', method: 'GET' });
	});

	it('says plainly that the object reported no tally instead of dropping the field', () => {
		for (const text of [
			'{}',
			'{"demand":[],"crossings":null}',
			'{"isolateBytes":{"linear":1}}'
		]) {
			const out = parseStats(text);
			expect(out).toMatchObject({ bridge: null, bridgeField: 'none' });
			expect(out?.bridgeNote).toMatch(/reported no bridge byte tally/);
		}
		expect(parseStats('{"isolateBytes":{"linear":1}}')?.isolateBytes).toEqual({ linear: 1 });
	});

	it.each([['not json'], ['null'], ['[]x']])('reads %j as no snapshot', (text) => {
		expect(parseStats(text)).toBeUndefined();
	});

	it('reads /serve-stats with the owner token', async () => {
		const seen: { url: string; auth: string | null }[] = [];
		const fake = (async (url: string, init?: RequestInit) => {
			seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
			return new Response(body);
		}) as unknown as typeof fetch;
		const out = await readStats(ORIGIN, TOKEN, { fetch: fake });
		expect(out?.bridge?.['out']).toBe(4096);
		expect(seen).toEqual([{ url: `${ORIGIN}/serve-stats`, auth: `Bearer ${TOKEN}` }]);
	});

	it('answers undefined for a refusal or a thrown call instead of failing the ladder', async () => {
		const refused = (async () =>
			new Response('no', { status: 401 })) as unknown as typeof fetch;
		const thrown = (async () => {
			throw new Error('reset');
		}) as unknown as typeof fetch;
		expect(await readStats(ORIGIN, TOKEN, { fetch: refused })).toBeUndefined();
		expect(await readStats(ORIGIN, TOKEN, { fetch: thrown })).toBeUndefined();
	});

	it('puts the settle and the snapshot on the result line without the token', () => {
		const line = summarise(
			'admin',
			1,
			{ status: 'replaced', steps: 9, headroomMiB: 36, first: null },
			{
				settleS: 60,
				before: { bridge: { in: 1, out: 2 }, bridgeField: 'demand[last].bridge' }
			}
		);
		expect(JSON.parse(line)).toMatchObject({
			arm: 'admin',
			settleS: 60,
			before: { bridge: { in: 1, out: 2 }, bridgeField: 'demand[last].bridge' },
			headroomMiB: 36
		});
		expect(line).not.toContain(TOKEN);
	});
});

describe('the arms on a fake site', () => {
	const PERMALINK = `<html><body><form name="form" action="options-permalink.php" method="post">
<input type="hidden" id="_wpnonce" name="_wpnonce" value="n0nce" />
<input type="hidden" name="_wp_http_referer" value="/wp-admin/options-permalink.php" />
<input name="selection" type="radio" value="" checked='checked' />
<input id="permalink_structure" name="permalink_structure" type="text" value="/%postname%/" />
<input type="submit" name="submit" value="Save Changes" />
</form></body></html>`;
	const DRUPAL_LOGIN = `<form id="user-login-form"><input type="hidden" name="form_build_id" value="form-1" /><input type="hidden" name="form_id" value="user_login_form" /></form>`;

	type Seen = { method: string; path: string; cookie: string | null; body: string };

	/** answers like a site whose admin pages need the cookie a login hands out */
	function site(cms: 'wordpress' | 'drupal') {
		const seen: Seen[] = [];
		const fake = (async (url: string, init?: RequestInit) => {
			const path = url.slice(ORIGIN.length);
			const method = init?.method ?? 'GET';
			const headers = new Headers(init?.headers);
			seen.push({
				method,
				path,
				cookie: headers.get('cookie'),
				body: String(init?.body ?? '')
			});
			const authed = (headers.get('cookie') ?? '').includes('session=1');
			const login = new Headers({ 'set-cookie': 'session=1; path=/', location: '/' });
			if (method === 'POST' && (path === '/wp-login.php' || path === '/user/login')) {
				return new Response(null, { status: 302, headers: login });
			}
			if (path.startsWith('/wp-admin/admin-ajax.php')) return new Response('nonce9');
			if (path === '/user/login') return new Response(DRUPAL_LOGIN);
			if (path === '/wp-admin/options-permalink.php') {
				if (!authed) return new Response(null, { status: 302 });
				if (method === 'POST') {
					return new Response(null, {
						status: 302,
						headers: { location: 'options-permalink.php?settings-updated=true' }
					});
				}
				return new Response(PERMALINK);
			}
			if (path === '/wp-admin/edit.php' || path === '/admin/content') {
				return new Response('ok', { status: authed ? 200 : 403 });
			}
			return new Response('home');
		}) as unknown as typeof fetch;
		return { seen, fake, cms };
	}

	async function run(cms: 'wordpress' | 'drupal', arm: 'boot' | 'admin' | 'flush') {
		const peaks = await import('../../scripts/measure/route-peaks');
		const fixture = site(cms);
		const session = peaks.newSession(
			ORIGIN,
			cms,
			{ CENSUS_OWNER_TOKEN: TOKEN, CENSUS_ADMIN_PASS: 'pw', CENSUS_ADMIN_USER: 'rigadmin' },
			[],
			fixture.fake,
			() => {}
		);
		const lines: Record<string, unknown>[] = [];
		await prepareArm(arm, 1, cms, session, peaks, {
			sleep: async () => {},
			record: (e) => void lines.push(e)
		});
		return { seen: fixture.seen, lines };
	}

	it('logs in to WordPress and opens the posts list for the admin arm', async () => {
		const { seen, lines } = await run('wordpress', 'admin');
		const paths = seen.map((s) => `${s.method} ${s.path}`);
		expect(paths).toContain('POST /wp-login.php');
		expect(paths.at(-1)).toBe('GET /wp-admin/edit.php');
		expect(seen.at(-1)?.cookie).toContain('session=1');
		expect(lines.at(-1)).toMatchObject({ arm: 'admin', phase: 'prepare', httpStatus: 200 });
	});

	it('saves Settings, Permalinks with the form it was given for the WordPress flush arm', async () => {
		const { seen, lines } = await run('wordpress', 'flush');
		const post = seen.at(-1) as Seen;
		expect([post.method, post.path]).toEqual(['POST', '/wp-admin/options-permalink.php']);
		const body = new URLSearchParams(post.body);
		expect(body.get('_wpnonce')).toBe('n0nce');
		expect(body.get('permalink_structure')).toBe('/%postname%/');
		expect(body.get('selection')).toBe('');
		expect(post.cookie).toContain('session=1');
		expect(lines.at(-1)).toMatchObject({ httpStatus: 302 });
	});

	it('refuses a WordPress flush when the permalink page has no form', async () => {
		expect(permalinkFields('<html>nothing</html>')).toBeUndefined();
		expect(permalinkFields(PERMALINK)).toMatchObject({ _wpnonce: 'n0nce' });
	});

	it('still opens /admin/content for the Drupal admin arm', async () => {
		const { seen } = await run('drupal', 'admin');
		expect(seen.at(-1)).toMatchObject({ method: 'GET', path: '/admin/content' });
	});

	it('waits for the front page to answer 200 for the boot arm on either CMS', async () => {
		for (const cms of ['wordpress', 'drupal'] as const) {
			const { seen } = await run(cms, 'boot');
			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatchObject({ method: 'GET', path: '/' });
		}
	});

	it('reads --cms, defaults to Drupal and refuses another value', () => {
		expect(parseArgs([`--origin=${ORIGIN}`]).cms).toBe('drupal');
		expect(parseArgs([`--origin=${ORIGIN}`, '--cms=wordpress']).cms).toBe('wordpress');
		expect(() => parseArgs([`--origin=${ORIGIN}`, '--cms=joomla'])).toThrow(/--cms/);
		expect(DEFAULT_ADMIN).toEqual({ drupal: 'admin', wordpress: 'rigadmin' });
	});
});
