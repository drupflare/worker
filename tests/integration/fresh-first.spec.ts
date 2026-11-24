import { describe, expect, it } from 'vitest';
import {
	FRESH_FIRST_ABORT_REASON,
	FRESH_FIRST_DEFAULT,
	freshFirstAbortDue,
	freshFirstConfig,
	freshFirstMatch,
	freshFirstRoutes,
	pathForms
} from '../../src/do/fresh/first';
import { readFreshFirst } from '../../src/do/fresh/first-log';
import { GrowthRefused } from '../../src/do/growth/cap';
import { incarnation } from '../../src/do/isolate';
import { serveStatsSync } from '../../src/do/stats';
import type { SiteEnv } from '../../src/env';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

const REQUEST_TIMEOUT = 300_000;
const FLUSH = '/admin/config/development/performance';
const ABORT = { FRESH_FIRST_ROUTES: 'abort' };
const env = (vars: Record<string, string>) => vars as unknown as SiteEnv;

describe('the registry modes', () => {
	it('is abort mode on the built-in route unless turned off, and a list replaces the route', () => {
		const on = { mode: 'abort', routes: FRESH_FIRST_DEFAULT };
		expect(freshFirstConfig(env({}))).toEqual(on);
		expect(freshFirstConfig(env(ABORT))).toEqual(on);
		expect(freshFirstConfig(undefined)).toEqual(on);
		for (const value of ['0', '', ' ', ',']) {
			expect(freshFirstConfig(env({ FRESH_FIRST_ROUTES: value })), value).toEqual({
				mode: 'off',
				routes: []
			});
		}
		expect(freshFirstConfig(env({ FRESH_FIRST_ROUTES: 'abort, POST /a' }))).toEqual({
			mode: 'abort',
			routes: ['POST /a']
		});
		expect(freshFirstConfig(env({ FRESH_FIRST_ROUTES: 'POST /a, GET /b' })).routes).toEqual([
			'POST /a',
			'GET /b'
		]);
		expect(freshFirstRoutes(env({ FRESH_FIRST_ROUTES: '0' }))).toEqual([]);
	});

	it('matches the flush however a site spells the path, and nothing else', () => {
		const m = (path: string, method = 'POST') => freshFirstMatch(env(ABORT), method, path);
		expect(m(FLUSH)).toBe(true);
		expect(m(`${FLUSH}?destination=%2Fadmin`)).toBe(true);
		expect(m(`${FLUSH}/`)).toBe(true);
		expect(m('//admin//config/development/performance')).toBe(true);
		expect(m('/admin%2Fconfig/development/performance')).toBe(true);
		expect(m(`/en${FLUSH}`)).toBe(true);
		expect(m(`/pt-br${FLUSH}`)).toBe(true);
		expect(m('/admin/config/development/performance/extra')).toBe(false);
		expect(m('/en/admin/config/development')).toBe(false);
		expect(m(FLUSH, 'GET')).toBe(false);
		expect(freshFirstMatch(env({}), 'POST', FLUSH)).toBe(true);
		expect(freshFirstMatch(env({ FRESH_FIRST_ROUTES: '0' }), 'POST', FLUSH)).toBe(false);
		// a prefix is dropped for the request only, so a custom entry is not widened by it
		expect(
			freshFirstMatch(env({ FRESH_FIRST_ROUTES: 'abort, POST /cms/x' }), 'POST', '/x')
		).toBe(false);
		expect(pathForms('/en/x/')).toEqual(['/en/x', '/x']);
	});

	it('decides an abort only for a registered route, with an interpreter, and no repeat header', () => {
		const due = (
			vars: Record<string, string>,
			path = FLUSH,
			retry: string | null = null,
			resident = true,
			method = 'POST'
		) => freshFirstAbortDue(env(vars), method, path, retry, resident);
		expect(due(ABORT)).toBe(true);
		expect(due(ABORT, FLUSH, 'abort')).toBe(false);
		expect(due(ABORT, FLUSH, null, false)).toBe(false);
		expect(due(ABORT, '/admin/config/system/site-information')).toBe(false);
		expect(due(ABORT, FLUSH, null, true, 'GET')).toBe(false);
		expect(due({})).toBe(true);
		expect(due({ FRESH_FIRST_ROUTES: '0' })).toBe(false);
	});
});

describe('the abort mode on a real object', () => {
	const post = (headers: Record<string, string> = {}) =>
		new Request(`https://do.local/__serve?path=${encodeURIComponent(FLUSH)}`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
			body: 'op=Save'
		});
	const page = { html: '', status: 200, contentType: 'text/plain', setCookie: [] };

	/** a migrated object with `ctx.abort` recorded instead of called and the render replaced */
	async function object<T>(
		vars: Record<string, string>,
		render: () => Promise<unknown>,
		steps: (site: ServeDo, aborts: unknown[]) => Promise<T>
	): Promise<T> {
		return inObject(freshSite(), async (site: ServeDo) => {
			await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
			await site.ensurePhp();
			site.env = { ...site.env, ...vars };
			const aborts: unknown[] = [];
			const ctx = (site as unknown as { ctx: { abort: (reason?: unknown) => void } }).ctx;
			const realAbort = ctx.abort;
			ctx.abort = (reason?: unknown) => {
				aborts.push(reason);
			};
			site.fillOne = render as never;
			try {
				return await steps(site, aborts);
			} finally {
				ctx.abort = realAbort;
			}
		});
	}
	const ok = async () => ({ filled: null, remaining: 0, page });

	it(
		'writes the record, aborts before anything runs, and the repeat runs without aborting',
		async () => {
			let ran = 0;
			const out = await object(
				ABORT,
				async () => {
					ran++;
					return ok();
				},
				async (site, aborts) => {
					let thrown: unknown;
					try {
						await site.fetch(post());
					} catch (e) {
						thrown = e;
					}
					const afterAbort = {
						ran,
						aborts: [...aborts],
						record: readFreshFirst(site.sql as never)
					};
					const repeat = await site.fetch(post({ 'x-cfw-retried': 'abort' }));
					return {
						thrown,
						afterAbort,
						repeat: repeat.status,
						ran,
						aborts: aborts.length,
						record: readFreshFirst(site.sql as never)
					};
				}
			);
			expect(String((out.thrown as Error | undefined)?.message)).toContain(
				FRESH_FIRST_ABORT_REASON
			);
			expect(out.afterAbort.ran).toBe(0);
			expect(out.afterAbort.aborts).toEqual([FRESH_FIRST_ABORT_REASON]);
			expect(out.afterAbort.record.count).toBe(1);
			expect(out.afterAbort.record.last).toMatchObject({ completedAt: null, end: null });
			expect(out.afterAbort.record.last?.before.totalBytes).toBeGreaterThan(0);
			expect(out.repeat).toBe(200);
			expect(out.ran).toBe(1);
			expect(out.aborts).toBe(1);
			expect(out.record.count).toBe(1);
			expect(out.record.last).toMatchObject({ end: 'ok' });
			expect(out.record.last?.completedAt).not.toBeNull();
		},
		REQUEST_TIMEOUT
	);

	it(
		'completes the record for a repeat the governor refuses, and for any other error',
		async () => {
			const endOf = async (render: () => Promise<unknown>) =>
				object(ABORT, render, async (site) => {
					await site.fetch(post()).catch(() => undefined);
					const res = await site
						.fetch(post({ 'x-cfw-retried': 'abort' }))
						.catch(() => undefined);
					return { status: res?.status, record: readFreshFirst(site.sql as never) };
				});
			const refused = await endOf(async () => {
				throw new GrowthRefused(undefined, new Error('exit(1)'), true);
			});
			const failed = await endOf(async () => {
				throw new Error('boom');
			});
			expect(refused.status).toBe(503);
			expect(refused.record.last).toMatchObject({ end: 'refused' });
			expect(refused.record.last?.completedAt).not.toBeNull();
			expect(refused.record.last?.done).not.toBeNull();
			expect(failed.record.last).toMatchObject({ end: 'error' });
			expect(failed.record.last?.completedAt).not.toBeNull();
		},
		REQUEST_TIMEOUT
	);

	it(
		'is still reported by a stats read once the object restarted, and counts up',
		async () => {
			const out = await object(ABORT, ok, async (site) => {
				await site.fetch(post()).catch(() => undefined);
				await site.fetch(post()).catch(() => undefined);
				const stats = serveStatsSync(site as never);
				return stats.freshFirst as ReturnType<typeof readFreshFirst>;
			});
			expect(out.count).toBe(2);
			expect(out.last?.route).toBe(`POST /__serve ${FLUSH}`);
		},
		REQUEST_TIMEOUT
	);

	it(
		'aborts a registered route with an interpreter resident under a default env',
		async () => {
			const out = await object({}, ok, async (site, aborts) => {
				const thrown = await site.fetch(post()).then(
					() => undefined,
					(e: unknown) => e
				);
				return { thrown, aborts: [...aborts], record: readFreshFirst(site.sql as never) };
			});
			expect(String((out.thrown as Error | undefined)?.message)).toContain(
				FRESH_FIRST_ABORT_REASON
			);
			expect(out.aborts).toEqual([FRESH_FIRST_ABORT_REASON]);
			expect(out.record.count).toBe(1);
		},
		REQUEST_TIMEOUT
	);

	it(
		'control: with the registry off nothing aborts and no record exists, and a route outside it never aborts',
		async () => {
			const off = await object({ FRESH_FIRST_ROUTES: '0' }, ok, async (site, aborts) => {
				const res = await site.fetch(post());
				const tables = site.sql
					.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'cfw_fresh_first'")
					.toArray()[0]!['n'];
				return { status: res.status, aborts: aborts.length, tables };
			});
			expect(off).toEqual({ status: 200, aborts: 0, tables: 0 });
			const outside = await object(ABORT, ok, async (site, aborts) => {
				const res = await site.fetch(
					new Request(
						'https://do.local/__serve?path=%2Fadmin%2Fconfig%2Fsystem%2Fsite-information',
						{
							method: 'POST',
							body: 'op=Save'
						}
					)
				);
				return {
					status: res.status,
					aborts: aborts.length,
					record: readFreshFirst(site.sql as never)
				};
			});
			expect(outside.status).toBe(200);
			expect(outside.aborts).toBe(0);
			expect(outside.record).toEqual({ count: 0, last: null });
		},
		REQUEST_TIMEOUT
	);
});

describe('the incarnation a stats read reports', () => {
	it(
		'changes the instance and interpreter ids with the thing they name, and keeps the isolate',
		async () => {
			const out = await inObject(freshSite(), async (a: ServeDo) => {
				const read = (site: ServeDo) =>
					incarnation(site, (site as unknown as { php?: object }).php, undefined);
				const cold = read(a);
				await a.ensurePhp();
				const first = read(a);
				a.dropInterpreter();
				await a.ensurePhp();
				const second = read(a);
				const again = read(a);
				const other = await inObject(freshSite(), async (b: ServeDo) => read(b));
				return { cold, first, second, again, other };
			});
			expect(out.cold.interpreter).toBeNull();
			expect(out.first.interpreter?.id).toBeTruthy();
			expect(out.second.interpreter?.id).not.toBe(out.first.interpreter?.id);
			expect(out.again.interpreter?.id).toBe(out.second.interpreter?.id);
			expect(out.first.instance).toBe(out.second.instance);
			expect(out.other.instance).not.toBe(out.first.instance);
			expect(out.first.isolate.id).toBe(out.other.isolate.id);
			expect(out.first.isolate.startedAt).toBeGreaterThan(0);
			expect(out.first.isolate.startedAt).toBeLessThanOrEqual(Date.now());
		},
		REQUEST_TIMEOUT
	);
});
