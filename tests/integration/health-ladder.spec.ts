import { describe, expect, it } from 'vitest';
import { LADDER } from '../../src/ops/supervisor';
import { type ServeDo, freshSite, inObject, pageFor, stubRender } from '../helpers/serve-do';

/**
 * The health layer, driven through a REAL Durable Object rather than as pure functions.
 */

/** the supervisor surface on the instance; `ServeDo` predates it */
type HealthDo = ServeDo & {
	alarm: () => Promise<unknown>;
	supervise: (outcomes: unknown[]) => { code: string; severity: string; context: string }[];
	medianRenderBytes: (path: string) => number | null;
	noteRenderBytes: (path: string, bytes: number) => void;
	metaGet: (key: string, fallback?: string | null) => string | null;
	metaSet: (key: string, value: unknown) => void;
	ensureServeTables: () => void;
	queueDepth: () => number;
	lastFindings?: { code: string; severity: string }[];
};

function health(site: ServeDo): HealthDo {
	return site as HealthDo;
}

/** queues a path so an alarm has something to fill */
function queue(site: HealthDo, path: string): void {
	site.ensureServeTables();
	site.sql.exec(
		'INSERT INTO cfw_fill_queue (path, queued_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING',
		path,
		Date.now()
	);
}

describe('the health layer is reachable from the object, not only from its own spec', () => {
	it('creates the ledger with the serve tables, so the first finding is recordable', async () => {
		await inObject(freshSite(), (site) => {
			const h = health(site);
			h.ensureServeTables();
			// would throw "no such table" if the ledger were created lazily on first write
			const rows = h.sql.exec('SELECT count(*) AS n FROM cfw_health').toArray();
			expect(Number(rows[0]?.n)).toBe(0);
		});
	});

	it('writes NO repair_state on a clean pass, so a healthy site costs zero rows', async () => {
		await inObject(freshSite(), (site) => {
			const h = health(site);
			h.ensureServeTables();
			expect(h.metaGet('repair_state')).toBe(null);
			const found = h.supervise([{ filled: '/a', bytes: 4096, remaining: 0 }]);
			expect(found).toEqual([]);
			// the meter that binds the regeneration ceiling is rows written; an unchanged state must
			// not be rewritten every 60 s for the life of the site
			expect(h.metaGet('repair_state')).toBe(null);
			expect(Number(h.sql.exec('SELECT count(*) AS n FROM cfw_health').toArray()[0]?.n)).toBe(
				0
			);
		});
	});

	it('records a finding and moves the ladder to quarantine on a critical one', async () => {
		await inObject(freshSite(), (site) => {
			const h = health(site);
			h.ensureServeTables();
			// a 200 with a zero-byte body: the failure this whole layer was built for, and one this
			// project has shipped, cached, and served from the edge
			const found = h.supervise([{ filled: '/', bytes: 0, remaining: 0 }]);
			expect(found.map((f) => f.code)).toContain('render.empty');

			const state = JSON.parse(String(h.metaGet('repair_state')));
			// three strikes is the threshold, so ONE critical finding must not quarantine yet --
			// the lower rungs own a single bad render
			expect(state.strikes).toBe(1);
			expect(state.rung).toBe('observe');

			const ledger = h.sql
				.exec('SELECT code, severity, action FROM cfw_health ORDER BY id')
				.toArray();
			expect(ledger).toHaveLength(1);
			expect(String(ledger[0]?.code)).toBe('render.empty');
			expect(Number(ledger[0]?.severity)).toBe(3);
		});
	});

	it('quarantines on the third consecutive finding of the same code', async () => {
		await inObject(freshSite(), (site) => {
			const h = health(site);
			h.ensureServeTables();
			for (let i = 0; i < 3; i++) h.supervise([{ filled: '/', bytes: 0, remaining: 0 }]);
			const state = JSON.parse(String(h.metaGet('repair_state')));
			expect(state.rung).toBe('quarantine');
			expect(state.quarantinedAt).toBeGreaterThan(0);
			expect(LADDER.indexOf(state.rung)).toBe(4);
		});
	});

	it('a DIFFERENT code resets the strikes rather than adding to them', async () => {
		await inObject(freshSite(), (site) => {
			const h = health(site);
			h.ensureServeTables();
			// a median for /a first, so the anomaly below has something to be measured against
			for (let i = 0; i < 4; i++) h.supervise([{ filled: '/a', bytes: 4096, remaining: 0 }]);
			h.supervise([{ filled: '/a', bytes: 90038, remaining: 0 }]);
			h.supervise([{ filled: '/a', bytes: 90038, remaining: 0 }]);
			expect(JSON.parse(String(h.metaGet('repair_state'))).strikes).toBe(2);

			// a different condition entirely: a 200 with a zero-byte body. Two unrelated faults are
			// not evidence of one durable condition, and summing them is how a site gets
			// quarantined for two different bad days
			const found = h.supervise([{ filled: '/', bytes: 0, remaining: 0 }]);
			expect(found.map((f) => f.code)).toContain('render.empty');

			const state = JSON.parse(String(h.metaGet('repair_state')));
			// back to 1 rather than on to 3, so this second condition did NOT quarantine the site
			expect(state.strikes).toBe(1);
			expect(state.code).toBe('render.empty');
			expect(state.rung).toBe('observe');
		});
	});

	it('an ERROR-severity finding drives the ladder, not only a critical one', async () => {
		await inObject(freshSite(), (site) => {
			const h = health(site);
			h.ensureServeTables();
			// a stable median for /a first, or there is nothing for the anomaly to be measured against
			for (let i = 0; i < 4; i++) h.supervise([{ filled: '/a', bytes: 4096, remaining: 0 }]);
			// then the same path an order of magnitude larger, three rounds running
			for (let i = 0; i < 3; i++) h.supervise([{ filled: '/a', bytes: 90038, remaining: 0 }]);
			const state = JSON.parse(String(h.metaGet('repair_state')));
			// three of these is a durable condition whatever the severity label says
			expect(state.code).toBe('render.size_anomaly');
			expect(state.rung).toBe('quarantine');
		});
	});

	// measured: with the three outbound-HTTPS cron hooks on and a cold fetch cache, the first cron
	// round trips the stub 10 times. At `error` that reached quarantine in three rounds and every
	// page answered 503, so a fresh site took itself down over a feed fetch that had already fallen
	// back correctly
	it('the Asyncify stub NEVER quarantines, however many rounds reach it', async () => {
		await inObject(freshSite(), (site) => {
			const h = health(site);
			h.ensureServeTables();
			(globalThis as { __cfwAsyncifyCalls?: number }).__cfwAsyncifyCalls = 10;
			try {
				for (let i = 0; i < 5; i++)
					h.supervise([{ filled: '/a', bytes: 4096, remaining: 0 }]);
				expect((h.lastFindings ?? []).map((f) => f.code)).toContain(
					'bridge.asyncify_called'
				);
				const state = JSON.parse(String(h.metaGet('repair_state') ?? '{}'));
				expect(state.rung ?? 'observe').toBe('observe');
				expect(state.strikes ?? 0).toBe(0);
				expect(state.quarantinedAt ?? null).toBeNull();
			} finally {
				(globalThis as { __cfwAsyncifyCalls?: number }).__cfwAsyncifyCalls = 0;
			}
		});
	});

	it('a WARN-severity finding never strikes, so a busy healthy site is not quarantined', async () => {
		await inObject(freshSite(), (site) => {
			const h = health(site);
			h.ensureServeTables();
			// budget pressure at 80% of the daily allowance is a warning to act on, not a fault:
			// striking on it would quarantine exactly the sites that are working hardest
			h.env.PLAN = 'free';
			for (let i = 0; i < 5; i++) {
				h.metaSet(`rows_written_${new Date().toISOString().slice(0, 10)}`, 95_000 + i);
				h.supervise([{ filled: '/a', bytes: 4096, remaining: 0 }]);
			}
			const found = h.lastFindings ?? [];
			expect(found.map((f) => f.code)).toContain('budget.rows_written');
			const state = JSON.parse(String(h.metaGet('repair_state') ?? '{}'));
			expect(state.rung ?? 'observe').toBe('observe');
			expect(state.strikes ?? 0).toBe(0);
		});
	});

	it('a quarantined alarm stops filling and re-arms slowly, instead of spinning at +1 ms', async () => {
		const stub = freshSite();
		await inObject(stub, (site) => {
			const h = health(site);
			h.ensureServeTables();
			stubRender(site, (call) => pageFor(call.path));
			queue(h, '/one');
			queue(h, '/two');
			// straight to the rung, so this asserts the ENFORCEMENT rather than the escalation the
			// case above already covers
			h.metaSet(
				'repair_state',
				JSON.stringify({
					rung: 'quarantine',
					code: 'render.empty',
					strikes: 3,
					quarantinedAt: Date.now(),
					lastRollbackAt: null
				})
			);
		});

		const before = await inObject(stub, (site) => health(site).queueDepth());
		const outcome = await inObject(stub, (site) => health(site).alarm());
		const after = await inObject(stub, (site) => health(site).queueDepth());

		// the queue is untouched: quarantine stops the lane that MUTATES and nothing else
		expect(before).toBe(2);
		expect(after).toBe(2);
		expect(outcome).toMatchObject({ skipped: 'quarantined', rung: 'quarantine' });

		const armed = await inObject(stub, (site) => site.ctx.storage.getAlarm());
		// the slow tick, not the +1 ms fill chain; a quarantined site is still serving so nothing is
		// urgent, and spinning would burn the DO request meter it cannot spend
		expect(armed).not.toBeNull();
		expect(Number(armed) - Date.now()).toBeGreaterThan(30_000);
	});

	it('refuses to roll back with no restore point, and says so by name', async () => {
		const stub = freshSite();
		await inObject(stub, (site) => {
			const h = health(site);
			h.ensureServeTables();
			h.metaSet(
				'repair_state',
				JSON.stringify({
					rung: 'quarantine',
					code: 'render.empty',
					// quarantined long enough that only the missing restore point can refuse it; the
					// dwell is TIME now, because strikes freeze the moment quarantine begins
					strikes: 3,
					quarantinedAt: Date.now() - 24 * 60 * 60 * 1000,
					lastRollbackAt: null
				})
			);
		});
		const outcome = (await inObject(stub, (site) => health(site).alarm())) as {
			rollback: { rollback: boolean; reason: string };
		};
		expect(outcome.rollback.rollback).toBe(false);
		// reverting to nothing is strictly worse than the fault; a quarantined site still serves
		expect(outcome.rollback.reason).toContain('no restore point');
	});

	it('serves the site the whole time it is quarantined', async () => {
		const stub = freshSite();
		await inObject(stub, (site) => {
			const h = health(site);
			h.ensureServeTables();
			h.sql.exec(
				`INSERT INTO cfw_page (path, status, content_type, html, rendered_at, render_ms)
				 VALUES ('/', 200, 'text/html; charset=utf-8', '<html>cached</html>', ?, 12)`,
				Date.now()
			);
			h.metaSet(
				'repair_state',
				JSON.stringify({
					rung: 'quarantine',
					code: 'render.empty',
					strikes: 3,
					quarantinedAt: Date.now(),
					lastRollbackAt: null
				})
			);
		});
		const res = await stub.fetch(new Request('https://x/__serve?path=/'));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('cached');
	});
});

describe('the size-anomaly baseline is previous renders, not the row just written', () => {
	it('returns null below three samples, so the second render is never an anomaly', async () => {
		await inObject(freshSite(), (site) => {
			const h = health(site);
			expect(h.medianRenderBytes('/a')).toBe(null);
			h.noteRenderBytes('/a', 1000);
			expect(h.medianRenderBytes('/a')).toBe(null);
			h.noteRenderBytes('/a', 1000);
			expect(h.medianRenderBytes('/a')).toBe(null);
			h.noteRenderBytes('/a', 1000);
			expect(h.medianRenderBytes('/a')).toBe(1000);
		});
	});

	it('fires on a render far outside its own history', async () => {
		await inObject(freshSite(), (site) => {
			const h = health(site);
			h.ensureServeTables();
			for (let i = 0; i < 3; i++) h.supervise([{ filled: '/', bytes: 12_296, remaining: 0 }]);
			// 12,296 -> 90,038 is the measured incident: one unrestored `currentUser()` rendered the
			// front page as uid 1 and it was written to the ANONYMOUS page cache
			const found = h.supervise([{ filled: '/', bytes: 90_038, remaining: 0 }]);
			expect(found.map((f) => f.code)).toContain('render.size_anomaly');
		});
	});

	it('does not fire when the baseline is the render itself', async () => {
		await inObject(freshSite(), (site) => {
			const h = health(site);
			h.ensureServeTables();
			// the bug this replaced: reading `cfw_page` gave a ratio of exactly 1.00 every time, so
			// the tripwire could not fire at all. Four identical renders must stay quiet
			for (let i = 0; i < 4; i++) {
				const found = h.supervise([{ filled: '/', bytes: 12_296, remaining: 0 }]);
				expect(found.map((f) => f.code)).not.toContain('render.size_anomaly');
			}
		});
	});
});

describe('the image-transformation cap is projected, not waited for', () => {
	/** the two counts the projection multiplies; `countOrNull` reads these tables directly */
	function seedImages(h: HealthDo, styles: number, images: number): void {
		h.sql.exec('CREATE TABLE IF NOT EXISTS config (name TEXT)');
		h.sql.exec('CREATE TABLE IF NOT EXISTS file_managed (fid INTEGER, filemime TEXT)');
		for (let i = 0; i < styles; i++) {
			h.sql.exec('INSERT INTO config (name) VALUES (?)', `image.style.s${i}`);
		}
		for (let i = 0; i < images; i++) {
			h.sql.exec('INSERT INTO file_managed (fid, filemime) VALUES (?, ?)', i, 'image/jpeg');
		}
	}

	it('fires on ten styles over 2,000 images, which is 4x over and silent today', async () => {
		await inObject(freshSite(), (site) => {
			const h = health(site);
			h.ensureServeTables();
			h.env.PLAN = 'free';
			// the worked example from the cost model: 10 x 2,000 = 20,000 against a 5,000/month cap
			seedImages(h, 10, 2000);
			const found = h.supervise([{ filled: '/a', bytes: 4096, remaining: 0 }]);
			const hit = found.find((f) => f.code === 'budget.image_transforms');
			expect(hit).toBeDefined();
			expect(hit?.severity).toBe('warn');
			expect(hit?.context).toContain('4.00x over');
		});
	});

	it('stays quiet on a configuration that fits', async () => {
		await inObject(freshSite(), (site) => {
			const h = health(site);
			h.ensureServeTables();
			h.env.PLAN = 'free';
			seedImages(h, 2, 100);
			const found = h.supervise([{ filled: '/a', bytes: 4096, remaining: 0 }]);
			expect(found.map((f) => f.code)).not.toContain('budget.image_transforms');
		});
	});

	it('never quarantines on it: the fix is a human configuration decision', async () => {
		await inObject(freshSite(), (site) => {
			const h = health(site);
			h.ensureServeTables();
			h.env.PLAN = 'free';
			seedImages(h, 10, 2000);
			for (let i = 0; i < 5; i++) h.supervise([{ filled: '/a', bytes: 4096, remaining: 0 }]);
			const state = JSON.parse(String(h.metaGet('repair_state') ?? '{}'));
			expect(state.rung ?? 'observe').toBe('observe');
		});
	});

	it('says nothing on an unmigrated site, where null is not zero', async () => {
		await inObject(freshSite(), (site) => {
			const h = health(site);
			h.ensureServeTables();
			h.env.PLAN = 'free';
			// no `config` and no `file_managed`: reporting 0 would read as a verified "nothing to
			// worry about" on precisely the sites nobody has configured yet
			const found = h.supervise([{ filled: '/a', bytes: 4096, remaining: 0 }]);
			expect(found.map((f) => f.code)).not.toContain('budget.image_transforms');
		});
	});
});

describe('/__health exposes the ledger and releases quarantine', () => {
	it('reports the repair state, the rollback decision and the ledger', async () => {
		const stub = freshSite();
		await inObject(stub, (site) => {
			const h = health(site);
			h.ensureServeTables();
			for (let i = 0; i < 3; i++) h.supervise([{ filled: '/', bytes: 0, remaining: 0 }]);
		});
		const res = await stub.fetch(new Request('https://x/__health'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			repair: { rung: string; strikes: number };
			quarantined: boolean;
			rollback: { rollback: boolean; reason: string };
			ledger: { code: string }[];
			ledgerRows: number;
		};
		expect(body.quarantined).toBe(true);
		expect(body.repair.rung).toBe('quarantine');
		expect(body.ledgerRows).toBe(3);
		expect(body.ledger.every((r) => r.code === 'render.empty')).toBe(true);
		expect(body.rollback.rollback).toBe(false);
	});

	it('?clear=1 releases, and releasing is the only way out', async () => {
		const stub = freshSite();
		await inObject(stub, (site) => {
			const h = health(site);
			h.ensureServeTables();
			for (let i = 0; i < 3; i++) h.supervise([{ filled: '/', bytes: 0, remaining: 0 }]);
			// a clean pass clears the STRIKES and deliberately does not un-quarantine: one good
			// render says nothing about the condition that caused it
			h.supervise([{ filled: '/', bytes: 4096, remaining: 0 }]);
			const still = JSON.parse(String(h.metaGet('repair_state')));
			expect(still.rung).toBe('quarantine');
			expect(still.strikes).toBe(0);
		});

		const res = await stub.fetch(new Request('https://x/__health?clear=1'));
		const body = (await res.json()) as { ok: boolean; released: { rung: string } };
		expect(body.ok).toBe(true);
		expect(body.released.rung).toBe('observe');

		await inObject(stub, (site) => {
			const state = JSON.parse(String(health(site).metaGet('repair_state')));
			expect(state.rung).toBe('observe');
			expect(state.quarantinedAt).toBe(null);
		});
	});
});
