import { describe, expect, it } from 'vitest';
import { GrowthRefused, syncGrowthCap } from '../../src/do/growth/cap';
import { readGrowthLog, recordGrowthRefusal } from '../../src/do/growth/log';
import {
	EFFECT_CAPABILITIES,
	GROWTH_RETRY_BODY_MAX_BYTES,
	effectBase,
	effectsSince,
	growthRetryEnabled,
	retryCap,
	type EffectHost
} from '../../src/do/growth/retry';
import type { SiteEnv } from '../../src/env';
import { ATTEMPT_HEADER } from '../../src/ops/attempt';
import { buildHop, sendHop } from '../../src/site/hop';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

const MIB = 1_048_576;
const REQUEST_TIMEOUT = 300_000;
const env = (vars: Record<string, string | number>) => vars as unknown as SiteEnv;

describe('the cap a repeat runs under', () => {
	it('is the computed cap plus 8 MiB, never past 104 MiB, never below the computed cap', () => {
		expect(retryCap(env({}), 96 * MIB)).toBe(104 * MIB);
		expect(retryCap(env({}), 100 * MIB)).toBe(104 * MIB);
		expect(retryCap(env({}), 70 * MIB)).toBe(78 * MIB);
		// an explicit cap above the ceiling is left alone, not lowered
		expect(retryCap(env({}), 110 * MIB)).toBe(110 * MIB);
		expect(retryCap(env({ GROWTH_RETRY_ALLOWANCE_BYTES: 2 * MIB }), 96 * MIB)).toBe(98 * MIB);
		expect(retryCap(env({ GROWTH_RETRY_CEILING_BYTES: 100 * MIB }), 96 * MIB)).toBe(100 * MIB);
		expect(retryCap(env({ GROWTH_RETRY_ALLOWANCE_BYTES: 0 }), 96 * MIB)).toBe(96 * MIB);
	});

	it('is on unless GROWTH_RETRY is 0', () => {
		expect(growthRetryEnabled(env({}))).toBe(true);
		expect(growthRetryEnabled(env({ GROWTH_RETRY: '1' }))).toBe(true);
		expect(growthRetryEnabled(env({ GROWTH_RETRY: '0' }))).toBe(false);
	});

	it('applies only while the request is the repeat', () => {
		const site = (retry: boolean, vars: Record<string, string | number> = {}) => {
			const s = {
				env: env({ GROWTH_CAP_BYTES: 96 * MIB, ...vars }),
				growthRetry: retry
			} as never;
			syncGrowthCap(s);
			return (s as { growthCap?: number }).growthCap;
		};
		expect(site(false)).toBe(96 * MIB);
		expect(site(true)).toBe(104 * MIB);
		// the governor off means no cap, so there is nothing to add to
		expect(site(true, { GROWTH_GOVERNOR: '0', GROWTH_CAP_BYTES: 0 })).toBeUndefined();
	});
});

describe('the effects ledger', () => {
	const tally = (counts: Record<string, number> = {}) => ({ total: 0, byName: counts });
	const host = (counts: Record<string, number>, boots = 1, sockets = 0): EffectHost => ({
		crossings: tally(counts),
		bootCount: boots,
		parkSockets: { size: sockets }
	});

	it('says none only when no effect capability ran since the base', () => {
		const h = host({ cfwSqlExec: 40, cfwFetch: 2 });
		const base = effectBase(h);
		h.crossings!.byName['cfwSqlExec'] = 400;
		expect(effectsSince(h, base)).toBe('none');
		for (const name of EFFECT_CAPABILITIES) {
			const g = host({});
			const b = effectBase(g);
			g.crossings!.byName[name] = 1;
			expect(effectsSince(g, b), name).toBe('some');
		}
	});

	it('says some for an open parked socket and unknown when it cannot tell', () => {
		expect(effectsSince(host({}, 1, 1), effectBase(host({}, 1, 0)))).toBe('some');
		expect(effectsSince(host({}), undefined)).toBe('unknown');
		expect(effectsSince({ bootCount: 1 }, { boots: 1, counts: {} })).toBe('unknown');
		// the interpreter was booted again during the request: the counts before it are gone
		expect(effectsSince(host({}, 2), effectBase(host({}, 1)))).toBe('unknown');
		expect(effectBase({ bootCount: 1 })).toBeUndefined();
	});
});

describe('what the object reports on a refusal', () => {
	const post = (headers: Record<string, string> = {}) =>
		new Request('https://do.local/__serve?path=%2Fadmin%2Fx', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
			body: 'op=Save'
		});

	/** a migrated object whose render is replaced by `render`, which runs with the ledger started */
	async function refused(
		render: (site: ServeDo) => void,
		headers: Record<string, string> = {},
		vars: Record<string, string | number> = {}
	) {
		return inObject(freshSite(), async (site: ServeDo) => {
			await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
			await site.ensurePhp();
			site.env = { ...site.env, ...vars };
			let capDuring: number | undefined;
			site.fillOne = (async () => {
				capDuring = site.growthCap;
				render(site);
				throw new GrowthRefused(undefined, new Error('exit(1)'), true);
			}) as never;
			const res = await site.fetch(post(headers));
			return { res, capDuring, retryAfter: (site as { growthRetry?: boolean }).growthRetry };
		});
	}
	const start = (site: ServeDo) => {
		(site as unknown as { effectBase?: unknown }).effectBase = effectBase(
			site as unknown as EffectHost
		);
	};
	const bump = (site: ServeDo, name: string) => {
		const t = (site as unknown as { crossings: { byName: Record<string, number> } }).crossings;
		t.byName[name] = (t.byName[name] ?? 0) + 1;
	};

	it(
		'reports effects none with the rollback header when the ledger shows nothing',
		async () => {
			const out = await refused(start);
			expect(out.res.status).toBe(503);
			expect(out.res.headers.get('x-cfw-rolled-back')).toBe('all');
			expect(out.res.headers.get('x-cfw-effects')).toBe('none');
		},
		REQUEST_TIMEOUT
	);

	it(
		'reports some after an outbound call and unknown with no ledger',
		async () => {
			const some = await refused((site) => {
				start(site);
				bump(site, 'cfwFetch');
			});
			const unknown = await refused(() => {});
			expect(some.res.headers.get('x-cfw-effects')).toBe('some');
			expect(unknown.res.headers.get('x-cfw-effects')).toBe('unknown');
		},
		REQUEST_TIMEOUT
	);

	it(
		'gives the allowance to a request carrying the header and to nothing else, up to the ceiling',
		async () => {
			const cap = { GROWTH_CAP_BYTES: 96 * MIB };
			const plain = await refused(start, {}, cap);
			const repeat = await refused(start, { 'x-cfw-retried': 'growth' }, cap);
			const other = await refused(start, { 'x-cfw-retried': 'reset' }, cap);
			// the repeat of an abort lands on a new isolate with the most room, so it gets it too
			const aborted = await refused(start, { 'x-cfw-retried': 'abort' }, cap);
			const off = await refused(
				start,
				{ 'x-cfw-retried': 'growth' },
				{ ...cap, GROWTH_RETRY: '0' }
			);
			const high = await refused(
				start,
				{ 'x-cfw-retried': 'growth' },
				{ GROWTH_CAP_BYTES: 110 * MIB }
			);
			expect(plain.capDuring).toBe(96 * MIB);
			expect(repeat.capDuring).toBe(104 * MIB);
			expect(other.capDuring).toBe(96 * MIB);
			expect(aborted.capDuring).toBe(104 * MIB);
			expect(off.capDuring).toBe(96 * MIB);
			expect(high.capDuring).toBe(110 * MIB);
		},
		REQUEST_TIMEOUT
	);
});

describe('the refusal log keeps both attempts', () => {
	const log = (retry: boolean) => ({
		growthRetry: retry,
		nowMs: () => 1,
		sql: undefined as unknown as SqlStorage
	});

	it(
		'stores attempt 1 and 2, and adds the column to a table made without it',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const sql = site.sql as never as SqlStorage;
				const host = (retry: boolean) => ({ ...log(retry), sql });
				recordGrowthRefusal(host(false), { fromBytes: 1, toBytes: 2, capBytes: 3 }, true);
				recordGrowthRefusal(host(true), { fromBytes: 4, toBytes: 5, capBytes: 6 }, true);
				const rows = readGrowthLog(sql).map((r) => r.attempt);
				return rows;
			});
			expect(out).toEqual([2, 1]);

			const migrated = await inObject(freshSite(), async (site: ServeDo) => {
				const sql = site.sql as never as SqlStorage;
				sql.exec(
					`CREATE TABLE cfw_growth_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
					 from_bytes INTEGER NOT NULL, to_bytes INTEGER NOT NULL, cap_bytes INTEGER NOT NULL,
					 js_side_bytes INTEGER NOT NULL, route TEXT NOT NULL,
					 rolled_back INTEGER NOT NULL)`
				);
				sql.exec('INSERT INTO cfw_growth_log VALUES (1, 1, 1, 2, 3, 0, ?, 1)', 'old');
				recordGrowthRefusal(
					{ ...log(true), sql },
					{ fromBytes: 7, toBytes: 8, capBytes: 9 },
					true
				);
				const columns = sql
					.exec(
						"SELECT COUNT(*) AS n FROM pragma_table_info('cfw_growth_log') WHERE name = 'attempt'"
					)
					.toArray()[0]!['n'];
				return { columns, attempts: readGrowthLog(sql).map((r) => r.attempt) };
			});
			expect(migrated).toEqual({ columns: 1, attempts: [2, 1] });
		},
		REQUEST_TIMEOUT
	);
});

describe('the front worker repeats a proven-clean refusal, whatever the method', () => {
	const REFUSED = (extra: Record<string, string> = {}) =>
		new Response('no', {
			status: 503,
			headers: {
				'x-cfw-growth-refused': '1',
				'x-cfw-rolled-back': 'all',
				'x-cfw-effects': 'none',
				...extra
			}
		});

	function front(script: Response[], vars: Record<string, string> = {}) {
		const sent: Request[] = [];
		const f = {
			env: env(vars),
			site: 'site',
			visitorPath: '/admin/config/development/performance',
			laneOf: () => ({ role: 'primary', lane: 0 }),
			forgetStub: () => {},
			stubOf: () => ({
				fetch: async (request: Request) => {
					sent.push(request);
					return script.shift() ?? new Response('none');
				}
			})
		};
		return { f, sent };
	}

	async function hop(
		method: string,
		body = 'op=Clear',
		attempt = 'a1111111-1111-4111-8111-111111111111'
	) {
		const bytes =
			method === 'GET' ? undefined : (new TextEncoder().encode(body).buffer as ArrayBuffer);
		const innerRequest = new Request('https://do.local/__serve?path=%2Fx', {
			method,
			headers: bytes ? { [ATTEMPT_HEADER]: attempt } : {},
			body: bytes
		});
		return {
			innerRequest,
			buffered: bytes as ArrayBuffer | undefined,
			attempt: bytes ? attempt : undefined
		};
	}

	it('repeats a POST once with its body, the header and a new attempt id', async () => {
		const { f, sent } = front([REFUSED(), new Response('done', { status: 303 })]);
		const out = (await sendHop(f as never, await hop('POST'))) as { res: Response };
		expect(out.res.status).toBe(303);
		expect(out.res.headers.get('x-cfw-retried')).toBe('growth');
		expect(sent).toHaveLength(2);
		expect(sent[0]!.headers.get('x-cfw-retried')).toBeNull();
		expect(sent[1]!.headers.get('x-cfw-retried')).toBe('growth');
		expect(await sent[1]!.text()).toBe('op=Clear');
		expect(sent[1]!.headers.get(ATTEMPT_HEADER)).not.toBe(sent[0]!.headers.get(ATTEMPT_HEADER));
	});

	it('does not repeat without a full rollback, with an effect, with an unknown ledger or a large body', async () => {
		const cases: Array<[string, Response, string?]> = [
			['slice rollback', REFUSED({ 'x-cfw-rolled-back': 'slice' })],
			['an effect', REFUSED({ 'x-cfw-effects': 'some' })],
			['an unknown ledger', REFUSED({ 'x-cfw-effects': 'unknown' })],
			[
				'no ledger header',
				(() => {
					const r = REFUSED();
					r.headers.delete('x-cfw-effects');
					return r;
				})()
			]
		];
		for (const [label, response] of cases) {
			const { f, sent } = front([response]);
			const out = (await sendHop(f as never, await hop('POST'))) as { res: Response };
			expect(out.res.status, label).toBe(503);
			expect(sent, label).toHaveLength(1);
		}
		const big = front([REFUSED()]);
		await sendHop(
			big.f as never,
			await hop('POST', 'x'.repeat(GROWTH_RETRY_BODY_MAX_BYTES + 1))
		);
		expect(big.sent).toHaveLength(1);
	});

	it('control: GROWTH_RETRY=0 stops the POST repeat and leaves the GET repeat alone', async () => {
		const off = front([REFUSED()], { GROWTH_RETRY: '0' });
		await sendHop(off.f as never, await hop('POST'));
		expect(off.sent).toHaveLength(1);
		const get = front(
			[
				new Response('no', { status: 503, headers: { 'x-cfw-growth-refused': '1' } }),
				new Response('ok')
			],
			{
				GROWTH_RETRY: '0'
			}
		);
		const out = (await sendHop(get.f as never, await hop('GET'))) as { res: Response };
		expect(get.sent).toHaveLength(2);
		expect(out.res.headers.get('x-cfw-retried')).toBe('growth');
	});

	it('answers the second refusal as the 503 it is, after exactly two tries', async () => {
		const { f, sent } = front([REFUSED(), REFUSED(), new Response('never')]);
		const out = (await sendHop(f as never, await hop('POST'))) as { res: Response };
		expect(out.res.status).toBe(503);
		expect(sent).toHaveLength(2);
	});

	it('strips a spoofed header from an inbound request', async () => {
		const request = new Request('https://site.example/serve?path=%2Fx', {
			method: 'POST',
			headers: { 'x-cfw-retried': 'growth' },
			body: 'a=1'
		});
		const f = {
			request,
			url: new URL('https://site.example/serve'),
			site: 'site',
			serving: false,
			laneOf: () => ({ role: 'primary', lane: 0 })
		};
		const built = await buildHop(
			f as never,
			{ personalised: false, authenticated: false } as never
		);
		expect(built.innerRequest.headers.get('x-cfw-retried')).toBeNull();
	});
});
