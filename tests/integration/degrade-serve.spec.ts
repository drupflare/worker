import { describe, expect, it } from 'vitest';
import { dailyLimit, READ_ONLY_AT, REDUCE_AT } from '../../src/ops/degrade';
import { freshSite, inObject, markProvisioned, seedPage } from '../helpers/serve-do';

/**
 * The ladder, reached through the object rather than called directly.
 *
 * `degrade.spec.ts` proves the arithmetic. This proves the object CONSULTS it, which is the half
 * that was missing for the whole health layer and for seven of eleven KV levers. A ladder nothing
 * reads is a chart, not a failback.
 */

/** puts today's row counter at a chosen fraction of the daily allowance */
function spendRows(site: { metaSet: (k: string, v: unknown) => void }, fraction: number): void {
	const today = new Date().toISOString().slice(0, 10);
	site.metaSet(`rows_written_${today}`, Math.ceil(dailyLimit('rows-written') * fraction));
}

describe('the object reads its own meters', () => {
	it('reports normal on a fresh site', async () => {
		const d = await inObject(freshSite(), (obj) => obj.degradation());
		expect(d.level).toBe('normal');
		expect(d.cron).toBe(true);
	});

	it('crosses to reduced once the day is 80% spent', async () => {
		const d = await inObject(freshSite(), (obj) => {
			spendRows(obj, REDUCE_AT);
			return obj.degradation();
		});
		expect(d.level).toBe('reduced');
		expect(d.driver).toBe('rows');
		// the rung that matters: background work stops, serving does not
		expect(d.cron).toBe(false);
		expect(d.render).toBe(true);
	});

	it('crosses to read-only at 95%', async () => {
		const d = await inObject(freshSite(), (obj) => {
			spendRows(obj, READ_ONLY_AT);
			return obj.degradation();
		});
		expect(d.level).toBe('read-only');
		expect(d.writes).toBe(false);
	});

	/**
	 * The counter is per UTC day and nothing persists the LEVEL, so recovery needs no flag clear.
	 *
	 * A stored level would have to be reset by something, and whatever reset it would be the thing
	 * that breaks. Reading the day's key directly means midnight does it.
	 */
	it('recovers on its own when the day rolls over', async () => {
		const d = await inObject(freshSite(), (obj) => {
			// yesterday's spend, which must not count toward today
			const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
			obj.metaSet(`rows_written_${yesterday}`, dailyLimit('rows-written'));
			return obj.degradation();
		});
		expect(d.level).toBe('normal');
	});
});

describe('the read-only rung on the serving path', () => {
	const serve = (site: ReturnType<typeof freshSite>, method: string) =>
		inObject(site, async (obj) => {
			// a never-migrated object answers `warming` before any of this, so the rung would
			// never be reached and the test would pass on the wrong 503
			markProvisioned(obj);
			obj.metaSet('first_run_at', String(Date.now()));
			spendRows(obj, 0.99);
			const url = new URL('https://site.example/__serve?path=/');
			return obj.handle(new Request(url, { method }), url);
		});

	/**
	 * THE CASE THAT MAKES THE WRITES GUARD LOAD-BEARING, and it took a failed falsification to find.
	 *
	 * `writes` and `render` both flip at 95%, so on a path with no cached page a POST is refused by
	 * the render guard and the writes guard looks redundant -- removing it left the suite green.
	 * The discriminating case is a POST to a path that DOES have a cached page: the cache read
	 * returns before the render guard is ever reached, so without the writes check a form
	 * submission is answered with a stale GET body and a 200.
	 */
	it('refuses a POST to a path that has a cached page, rather than serving the cache', async () => {
		const res = await inObject(freshSite(), async (obj) => {
			markProvisioned(obj);
			obj.metaSet('first_run_at', String(Date.now()));
			seedPage(obj, '/', '<html><body>cached</body></html>');
			spendRows(obj, 0.99);
			const url = new URL('https://site.example/__serve?path=/');
			return obj.handle(new Request(url, { method: 'POST' }), url);
		});
		expect(res.status, 'a submission must never be answered from the page cache').toBe(503);
		expect(res.headers.get('x-cfw-degrade')).toBe('read-only');
	});

	/**
	 * A NON-GET IS REFUSED BEFORE THE CACHE READ, not after.
	 *
	 * What a POST would do is WRITE, so whether a cached copy of that path happens to exist is
	 * irrelevant to whether it may proceed.
	 */
	it('refuses a POST with 503 and a retry-after', async () => {
		const res = await serve(freshSite(), 'POST');
		expect(res.status).toBe(503);
		expect(res.headers.get('x-cfw-degrade')).toBe('read-only');
		expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
	});

	/**
	 * A CACHED GET STILL SERVES, which is why the rung sits where it does.
	 *
	 * Measured, a cache HIT costs the object 0 ms of cpuTime and writes nothing, so there is no
	 * quota argument for refusing it. Refusing it would take the site dark for the rest of the day
	 * over work that is already paid for.
	 */
	it('still serves a GET that hits the page cache', async () => {
		const res = await inObject(freshSite(), async (obj) => {
			markProvisioned(obj);
			obj.metaSet('first_run_at', String(Date.now()));
			seedPage(obj, '/', '<html><body>cached</body></html>');
			spendRows(obj, 0.99);
			const url = new URL('https://site.example/__serve?path=/');
			return obj.handle(new Request(url), url);
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('cached');
		expect(res.headers.get('x-cfw-cache')).toBe('HIT');
	});

	/**
	 * A GET THAT MISSES IS REFUSED, and that asymmetry is intended.
	 *
	 * A miss would render, and a render costs ~13 rows the quota cannot pay for. The path stays on
	 * the fill queue, so it appears once the day rolls over.
	 */
	it('refuses a GET that would have to render', async () => {
		const res = await serve(freshSite(), 'GET');
		expect(res.status).toBe(503);
		expect(res.headers.get('x-cfw-degrade')).toBe('read-only');
	});

	it('leaves a POST alone while the site is under the rung', async () => {
		const res = await inObject(freshSite(), async (obj) => {
			markProvisioned(obj);
			obj.metaSet('first_run_at', String(Date.now()));
			spendRows(obj, 0.5);
			const url = new URL('https://site.example/__serve?path=/');
			return obj.handle(new Request(url, { method: 'POST' }), url);
		});
		expect(res.headers.get('x-cfw-degrade')).toBeNull();
	});
});

/**
 * Shell candidacy, counted from the pages a site has actually rendered.
 *
 * The measurement that decides whether authenticated caching is worth finishing HERE. A site whose
 * theme auto-placeholders nothing has zero candidates and gains nothing from fragment assembly
 * however well it is built, so this is the input rather than an implementation detail.
 */
describe('shell candidates on the serve-stats surface', () => {
	it('counts a placeholdered page as a candidate and a plain one as not', async () => {
		const out = await inObject(freshSite(), (obj) => {
			markProvisioned(obj);
			seedPage(
				obj,
				'/a',
				'<html><body><span data-big-pipe-placeholder-id="m"></span></body></html>'
			);
			seedPage(obj, '/b', '<html><body>fully rendered</body></html>');
			return obj.shellCandidates();
		});
		expect(out.safe).toBe(1);
		expect(out.unsafe).toBe(1);
		expect(Object.keys(out.reasons)[0]).toContain('no placeholders');
		// the seeded row above cannot occur in production -- fillOne() refuses a session-carrying
		// response and an anonymous render carries no placeholders -- so the count is exercised here
		// and unanswerable on a real site. Stated on the result rather than left as a zero
		expect(out.answerable).toBe(false);
		expect(out.how).toContain('harvest');
	});

	it('reports zero candidates on a site with no pages, rather than dividing by nothing', async () => {
		const out = await inObject(freshSite(), (obj) => {
			markProvisioned(obj);
			return obj.shellCandidates();
		});
		expect(out.safe).toBe(0);
		expect(out.unsafe).toBe(0);
		expect(out.reasons).toEqual({});
		expect(out.answerable).toBe(false);
	});
});

/**
 * The core-version invalidation, reached through the object.
 *
 * Two permanent rows embed the core version in every asset URL. On an upgrade whose diff changes
 * `core/misc/ajax.js` -- which 11.4.4 -> 11.4.5 does -- a site would serve new JavaScript at a URL
 * still advertising the old version, and a browser holding the old copy has no reason to refetch.
 */
describe('invalidating the version-pinned caches', () => {
	const seedPinned = (obj: {
		sql: { exec: (t: string, ...b: unknown[]) => unknown };
		ensureServeTables: () => void;
	}) => {
		obj.sql.exec(
			'CREATE TABLE IF NOT EXISTS cache_discovery (cid TEXT PRIMARY KEY, data BLOB)'
		);
		obj.sql.exec('CREATE TABLE IF NOT EXISTS cache_data (cid TEXT PRIMARY KEY, data BLOB)');
		obj.sql.exec(
			"INSERT OR REPLACE INTO cache_discovery (cid, data) VALUES ('library_info:olivero', 'x')"
		);
		obj.sql.exec("INSERT OR REPLACE INTO cache_discovery (cid, data) VALUES ('keep:me', 'x')");
		obj.sql.exec(
			"INSERT OR REPLACE INTO cache_data (cid, data) VALUES ('fonts:olivero:abc', 'x')"
		);
	};
	const count = (
		obj: { sql: { exec: (t: string) => { toArray(): unknown[] } } },
		t: string,
		p: string
	) => obj.sql.exec(`SELECT cid FROM ${t} WHERE cid LIKE '${p}%'`).toArray().length;

	it('drops the pinned rows when the stored version is older', async () => {
		const out = await inObject(freshSite(), (obj) => {
			markProvisioned(obj);
			seedPinned(obj);
			obj.metaSet('core_version', '11.4.4');
			const before = count(obj, 'cache_discovery', 'library_info');
			obj.invalidateOnCoreUpgrade();
			return {
				before,
				after: count(obj, 'cache_discovery', 'library_info'),
				fonts: count(obj, 'cache_data', 'fonts:'),
				kept: count(obj, 'cache_discovery', 'keep:'),
				recorded: obj.metaGet('core_version')
			};
		});
		expect(out.before).toBe(1);
		expect(out.after).toBe(0);
		expect(out.fonts).toBe(0);
		expect(out.kept, 'only the pinned rows go').toBe(1);
		expect(out.recorded).not.toBe('11.4.4');
	});

	it('leaves them alone on a site whose version has not moved', async () => {
		const out = await inObject(freshSite(), (obj) => {
			markProvisioned(obj);
			seedPinned(obj);
			// no stored version: a database built before the key existed is a baseline, not an upgrade
			obj.invalidateOnCoreUpgrade();
			return count(obj, 'cache_discovery', 'library_info');
		});
		expect(out).toBe(1);
	});

	/**
	 * THE WIRING, not the method.
	 *
	 * The three tests around this one call `invalidateOnCoreUpgrade()` directly, so they prove the
	 * method works and say nothing about whether anything calls it -- removing the call site left
	 * them all green. This one drives `handle()` and is the only one that fails if the object stops
	 * consulting it.
	 */
	it('is reached by a real request, not just by a direct call', async () => {
		const out = await inObject(freshSite(), async (obj) => {
			markProvisioned(obj);
			obj.metaSet('first_run_at', String(Date.now()));
			seedPinned(obj);
			obj.metaSet('core_version', '11.4.4');
			const url = new URL('https://site.example/__serve?path=/');
			await obj.handle(new Request(url), url);
			return {
				pinned: count(obj, 'cache_discovery', 'library_info'),
				recorded: obj.metaGet('core_version')
			};
		});
		expect(out.pinned, 'handle() did not consult the core-version check').toBe(0);
		expect(out.recorded).not.toBe('11.4.4');
	});

	it('checks once per object lifetime, not once per request', async () => {
		const out = await inObject(freshSite(), (obj) => {
			markProvisioned(obj);
			seedPinned(obj);
			obj.metaSet('core_version', '11.4.4');
			const first = obj.invalidateOnCoreUpgrade();
			const second = obj.invalidateOnCoreUpgrade();
			return { first: first?.deleted ?? -1, second };
		});
		expect(out.first).toBe(2);
		expect(out.second, 'a warm object must not re-read meta on every request').toBeNull();
	});
});
