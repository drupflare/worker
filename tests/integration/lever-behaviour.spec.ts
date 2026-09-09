import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SiteEnv } from '../../src/env';
import { idleRearmMs, siteWarmEnabled } from '../../src/ops/cron';
import { edgePlanEnabled, resetEdgePlans } from '../../src/ops/edge-plan';
import { imageEngine } from '../../src/ops/image-transform';
import { mailDrainLimit, resolveMailTransport, type MailEnv } from '../../src/ops/mail';
import { KV_OVERRIDABLE } from '../../src/ops/plan';
import {
	chooseTarget,
	DEFAULT_REPLICA_LAG_MS,
	replicaCount,
	replicaLagMs,
	resetLaneBeliefs
} from '../../src/ops/replica-routing';
import { locationHint } from '../../src/ops/site-id';
import { writeForwardEnabled } from '../../src/ops/write-forwarding';
import { opcacheIni, opcacheMode } from '../../src/runtime/opcache';
import worker from '../../src/site';
import { argon2Enabled, shellAssemblyEnabled } from '../../src/site-do';
import {
	freshSite,
	inObject,
	markProvisioned,
	namedSite,
	pageFor,
	queuePath,
	seedPage,
	serveDirect,
	SESSION_COOKIE,
	statsOf,
	stubRender,
	tick,
	type ServeDo
} from '../helpers/serve-do';

/**
 * Every configuration lever, proved to CHANGE something.
 *
 * `tests/unit/ops/plan-kv.spec.ts` proves each name is read out of KV and `kv-levers.spec.ts` proves
 * the value lands on the object's env. Neither says the value reaches a decision, and this project
 * has shipped three settings that read as configuration and did nothing -- `$_SERVER` assignments
 * Symfony never looks at, `setAccessible()` calls PHP stopped honouring in 8.1, and an anchored
 * regex against a string that always carries a query. See TECHNICAL_REPORT.md's decorative
 * configuration class.
 *
 * So every test here is a PAIR: the default produces observable A, the lever set produces observable
 * B, and A differs from B. Asserting B alone passes against a lever that does nothing whenever B
 * happens to be what the default already gives, which is the failure the pairing removes.
 *
 * The levers this file cannot pair on an observable are listed in the coverage test below, with the
 * reason each is there. `LAZY_FS_BUDGET_BYTES` is read by the lazy filesystem at mount time, so its
 * pair is `tests/integration/lazy-fs-budget.spec.ts` in the artifact lane; `ARGON2` and
 * `OPCACHE_MODE` reach PHP through `settings.php` and the interpreter constructor, so what is
 * drivable here is the decision each one feeds.
 *
 * WRITING THIS FOUND A DEAD LEVER. `FILL_BATCH_WALL_MS` was on the allow-list, resolved per plan,
 * copied onto the object env and asserted through the plumbing by `kv-levers.spec.ts` -- and read by
 * nothing in `src/`. It could not have worked: the clock does not advance across a synchronous
 * `php._run()`, so wall clock cannot bound a batch from inside one, and the fill loop says so in a
 * comment. Removed 2026-09-08 rather than wired, because the guard it configured cannot exist.
 */

/**
 * What an alarm has to be told not to do first.
 *
 * The producer takes a heap image once per pack generation and RETURNS from the firing, so a spec
 * asserting on the fill loop or the drain reads a firing that never got there.
 */
const QUIET_ALARM = { HEAP_IMAGE: '0', HEAP_SNAPSHOT: '0' };

/** the object's env carries bindings a spec has no use for; only the levers are being read */
const siteEnv = (vars: Record<string, string>) => vars as unknown as SiteEnv;

/**
 * Pushes this object's next firing an hour out.
 *
 * An alarm left armed at +1 ms fires whenever the runtime likes, including inside a later test in
 * this file, and it mutates the storage that test is reading.
 */
const quiesce = (site: ServeDo) => site.storage.setAlarm(Date.now() + 3_600_000);

type Bag = Record<string, (json: string) => string>;

/** the host bridge as PHP reaches it: one JSON string in, one JSON string out */
function bridgeOf(site: ServeDo): Bag {
	const bag: Bag = {};
	site.installCapabilities(bag);
	return bag;
}

const call = (bag: Bag, name: string, payload: unknown): Record<string, unknown> =>
	JSON.parse(bag[name]!(JSON.stringify(payload))) as Record<string, unknown>;

/** records the object NAME the front worker addressed and the options it passed */
function siteSpy(headers: Record<string, string> = {}) {
	const names: string[] = [];
	const options: Array<Record<string, unknown> | undefined> = [];
	return {
		names,
		options,
		namespace: {
			idFromName: (name: string) => {
				names.push(name);
				return { name, toString: () => name };
			},
			newUniqueId: () => ({ toString: () => 'unique' }),
			get: (_id: unknown, opts?: Record<string, unknown>) => {
				options.push(opts);
				return {
					fetch: async () =>
						new Response('<html><body>rendered</body></html>', {
							status: 200,
							headers: {
								'content-type': 'text/html; charset=UTF-8',
								'x-cfw-cache': 'RENDER',
								'x-cfw-generation': '7',
								...headers
							}
						})
				};
			}
		}
	};
}

/** one request through the real front worker with the namespace replaced */
async function through(
	path: string,
	overrides: Record<string, unknown> = {},
	init: RequestInit = {},
	spyHeaders: Record<string, string> = {}
) {
	const spy = siteSpy(spyHeaders);
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`https://cfw.local${path}`, init),
		{ ...env, SITE: spy.namespace, ...overrides } as unknown as typeof env,
		ctx
	);
	await res.text();
	await waitOnExecutionContext(ctx);
	return { res, names: spy.names, options: spy.options };
}

/** the tier header off the front worker, which is where the plan and edge levers are visible */
const planHeaderOf = (res: Response) => res.headers.get('x-cfw-plan');

/**
 * One `/__serve` against a fresh object, which reports the budget it decided.
 *
 * `render: true` hands it a stubbed interpreter, because paid's profile permits a cold boot and an
 * arm that boots takes a different branch from one that does not -- the budget would then be
 * compared across two response shapes rather than across two values.
 */
async function missWith(
	overrides: Record<string, unknown>,
	path: string,
	{ render = false }: { render?: boolean } = {}
) {
	const stub = freshSite();
	return inObject(stub, async (site) => {
		markProvisioned(site);
		site.env = { ...site.env, ...overrides };
		if (render) stubRender(site, (call) => pageFor(call.path));
		return serveDirect(site, path);
	});
}

describe('the fixture covers the allow-list', () => {
	it('names every lever this file drives or explains', () => {
		// a new entry with no behaviour pair fails here first, which is the same coverage claim
		// `kv-levers.spec.ts` makes about adoption
		const driven = [
			'RENDER_BUDGET_MS',
			'FILL_BATCH_SIZE',
			'HTTP_DRAIN_LIMIT',
			'MIRROR_LIMIT',
			'PREFILL',
			'GEN_BUCKET_MS',
			'MAIL_TRANSPORT',
			'MAIL_DRAIN_LIMIT',
			'SHELL_ASSEMBLY',
			'SITE_LOCATION_HINT',
			'REPLICA_COUNT',
			'REPLICA_LAG_MS',
			'SITE_WARM',
			'EDGE_PLAN',
			'ASSET_AGGREGATES'
		];
		// read by a consumer this lane cannot reach; see the block comment above
		const elsewhere = ['LAZY_FS_BUDGET_BYTES', 'ARGON2', 'OPCACHE_MODE'];
		// on the allow-list, adopted onto the object env, and read by nothing in `src/`
		const unread: string[] = [];
		expect([...driven, ...elsewhere, ...unread].sort()).toEqual([...KV_OVERRIDABLE].sort());
	});
});

/**
 * The plan and the render budget, off the same MISS.
 *
 * `x-cfw-inline-budget-ms` is what `inlineBudgetMs()` decided, and the plan chooses its default --
 * so one response carries both the profile lever and the number that overrides it.
 */
describe('PLAN and RENDER_BUDGET_MS move the inline budget', () => {
	it('gives paid a longer budget than free', async () => {
		const free = await missWith({}, '/lever-plan-free', { render: true });
		const paid = await missWith({ PLAN: 'paid' }, '/lever-plan-paid', { render: true });
		expect(free.budgetMs).toBe(2000);
		expect(paid.budgetMs).toBe(10_000);
		expect(paid.budgetMs).not.toBe(free.budgetMs);
	});

	it('takes an explicit budget over the plan default', async () => {
		const fallback = await missWith({}, '/lever-budget-default');
		const set = await missWith({ RENDER_BUDGET_MS: '7777' }, '/lever-budget-set');
		expect(fallback.budgetMs).toBe(2000);
		expect(set.budgetMs).toBe(7777);
		// the same response names the plan the budget came from, so a free arm cannot read as paid.
		// `x-cfw-account-plan` since header version 2; `x-cfw-plan` is the edge-plan tier and always
		// was on the front worker, which is what made one name carry two answers
		expect(fallback.header('x-cfw-account-plan')).toBe('free');
	});
});

/**
 * The fill batch, counted on the queue the alarm drained.
 *
 * Six paths queued and one firing run by hand, so the observable is how many rows the batch left
 * behind rather than how long it took -- the wall clock does not advance across a render.
 */
describe('FILL_BATCH_SIZE bounds one alarm firing', () => {
	const filled = async (overrides: Record<string, unknown>) => {
		const stub = freshSite();
		return inObject(stub, async (site) => {
			site.env = { ...site.env, ...QUIET_ALARM, HTTP_DRAIN_ON_ALARM: '0', ...overrides };
			markProvisioned(site);
			stubRender(site, ({ path }) => pageFor(path));
			for (let i = 0; i < 6; i++) queuePath(site, `/batch-${i}`, { arm: false });
			await site.alarm();
			const depth = site.queueDepth();
			await quiesce(site);
			return depth;
		});
	};

	it('fills the plan default, and fewer when the lever says fewer', async () => {
		const fallback = await filled({});
		const set = await filled({ FILL_BATCH_SIZE: '2' });
		// free's profile is 5, so one of the six is left; at 2 four are
		expect(fallback).toBe(1);
		expect(set).toBe(4);
	});
});

/**
 * The deferred outbound queue, drained by the alarm rather than by the route.
 *
 * `drainHttpQueue()` takes a limit as an argument and has its own test; what is asserted here is the
 * one call site that reads the lever, which is `alarm()`.
 */
describe('HTTP_DRAIN_LIMIT bounds what one alarm fetches', () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	/**
	 * How many the firing fetched, not what the queue has left.
	 *
	 * The alarm queues its own declared fetches before draining, so a depth reading measures the
	 * limit plus whatever the schedule added.
	 */
	const fetched = async (host: string, overrides: Record<string, unknown>) => {
		globalThis.fetch = (async () => new Response('ok')) as unknown as typeof globalThis.fetch;
		const stub = freshSite();
		const stats = await inObject(stub, async (site) => {
			site.env = { ...site.env, ...QUIET_ALARM, ...overrides };
			markProvisioned(site);
			for (const n of [1, 2, 3, 4, 5]) site.queueHttp(`https://${host}/${n}`);
			await site.alarm();
			const stats = await statsOf(site);
			await quiesce(site);
			return stats;
		});
		return stats.lastHttpDrain?.drained?.length ?? 0;
	};

	it('drains the plan default, and fewer when the lever says fewer', async () => {
		// free's profile is 3
		expect(await fetched('drain-default.test', {})).toBe(3);
		expect(await fetched('drain-set.test', { HTTP_DRAIN_LIMIT: '1' })).toBe(1);
	});
});

/**
 * The R2 offload, counted on what one pass sent.
 *
 * `/__mirror` reads the lever when the caller names no limit of its own, which is the same value the
 * alarm's pass uses.
 */
describe('MIRROR_LIMIT bounds one mirror pass', () => {
	const mirrored = async (prefix: string, overrides: Record<string, unknown>) => {
		const stub = freshSite();
		return inObject(stub, async (site) => {
			site.env = { ...site.env, ...overrides };
			markProvisioned(site);
			const bag = bridgeOf(site);
			for (let n = 0; n < 6; n++) {
				call(bag, 'cfwFileWrite', { uri: `public://${prefix}-${n}.txt`, b64: btoa('x') });
			}
			const res = await site.fetch(new Request('https://do.local/__mirror'));
			return (await res.json()) as { mirrored: number; noBucket?: boolean };
		});
	};

	it('sends the plan default, and more when the lever says more', async () => {
		const fallback = await mirrored('fallback', {});
		const set = await mirrored('set', { MIRROR_LIMIT: '5' });
		expect(fallback.noBucket, 'no FILES bucket, so nothing was measured').toBeUndefined();
		// free's profile is 2
		expect(fallback.mirrored).toBe(2);
		expect(set.mirrored).toBe(5);
	});
});

/**
 * Prefill, which changes what a MISS MEANS rather than how fast one is.
 *
 * The manifest is a stand-in so the assertion holds on a checkout with no `prefill.json`; what is
 * under test is whether the lever reaches the branch that reads one.
 */
describe('PREFILL decides whether a site starts warm', () => {
	const PAGES = {
		'/prefilled': {
			html: '<html><body>seeded</body></html>',
			status: 200,
			contentType: 'text/html; charset=utf-8',
			renderMs: 3
		}
	};

	const prefill = async (overrides: Record<string, unknown>) => {
		const stub = freshSite();
		return inObject(stub, async (site) => {
			site.env = {
				...site.env,
				ASSETS: { fetch: async () => Response.json(PAGES) },
				...overrides
			};
			markProvisioned(site);
			const out = await (
				site as unknown as {
					prefillServingTable(asked: string | null): Promise<Record<string, unknown>>;
				}
			).prefillServingTable(null);
			// the off arm returns before it would have created the table, so the read makes it
			site.ensureServeTables();
			const rows = site.sql
				.exec('SELECT count(*) AS n FROM cfw_page WHERE path = ?', '/prefilled')
				.toArray();
			return { out, rows: Number(rows[0]?.n ?? 0) };
		});
	};

	it('seeds the serving table on free, and seeds nothing when the lever is off', async () => {
		const fallback = await prefill({});
		const off = await prefill({ PREFILL: '0' });
		expect(fallback.out.prefilled).toBe(1);
		expect(fallback.rows).toBe(1);
		expect(off.out.prefilled).toBe(0);
		expect(off.rows).toBe(0);
	});

	it('is off by default on paid, which is the plan branch under the lever', async () => {
		const paid = await prefill({ PLAN: 'paid' });
		expect(paid.out.prefilled).toBe(0);
		expect(paid.rows).toBe(0);
	});
});

/**
 * The generation pointer's window, observed on whether the edge tier can answer at all.
 *
 * The pointer is discovered once per window and the edge tier refuses without one, so a window
 * narrow enough that no two requests share it takes every request to the object. A tick between
 * requests is what makes that deterministic rather than a race against the millisecond.
 */
describe('GEN_BUCKET_MS decides whether the edge tier can be reached', () => {
	const walk = async (site: string, overrides: Record<string, unknown>, tries = 6) => {
		const tiers: (string | null)[] = [];
		for (let i = 0; i < tries; i++) {
			const ctx = createExecutionContext();
			const res = await worker.fetch(
				new Request(`https://cfw.local/serve?site=${site}&path=%2F`),
				{ ...env, ...overrides } as unknown as typeof env,
				ctx
			);
			await res.text();
			await waitOnExecutionContext(ctx);
			tiers.push(res.headers.get('x-cfw-cache'));
			await tick(3);
		}
		return tiers;
	};

	it('reaches EDGE at the configured window and never at a one-millisecond one', async () => {
		await inObject(namedSite('gen-wide'), (site) => {
			markProvisioned(site);
			seedPage(site, '/', '<title>wide</title>');
		});
		await inObject(namedSite('gen-narrow'), (site) => {
			markProvisioned(site);
			seedPage(site, '/', '<title>narrow</title>');
		});

		expect(await walk('gen-wide', {})).toContain('EDGE');
		// same page, same object, same worker: only the window width changed
		expect(await walk('gen-narrow', { GEN_BUCKET_MS: '1' })).not.toContain('EDGE');
	});
});

/**
 * Mail, through the bridge PHP calls rather than through the resolver alone.
 *
 * The site is given an SMTP endpoint so `auto` has something to choose, or both arms would refuse
 * and the pair would be two refusals with different wording.
 */
describe('MAIL_TRANSPORT decides whether a message is queued or refused', () => {
	const SMTP = {
		SMTP_HOST: 'smtp.lever.test',
		SMTP_PORT: '587',
		SMTP_USER: 'sender',
		SMTP_PASS: 'secret',
		MAIL_FROM: 'site@lever.test'
	};

	const send = async (overrides: Record<string, unknown>) => {
		const stub = freshSite();
		return inObject(stub, async (site) => {
			site.env = { ...site.env, ...SMTP, ...overrides };
			markProvisioned(site);
			const bag = bridgeOf(site);
			return call(bag, 'cfwMail', {
				to: 'someone@lever.test',
				from: 'site@lever.test',
				subject: 'lever',
				text: 'body'
			});
		});
	};

	it('queues through the configured transport, and refuses by name when switched off', async () => {
		const fallback = await send({});
		const off = await send({ MAIL_TRANSPORT: 'off' });
		expect(fallback.ok).toBe(true);
		expect(fallback.transport).toBe('smtp');
		expect(off.ok).toBe(false);
		expect(String(off.error)).toContain('MAIL_TRANSPORT=off');
	});

	it('resolves the same way in the function the bridge calls', () => {
		expect(resolveMailTransport(SMTP as MailEnv)).toHaveProperty('transport');
		expect(resolveMailTransport({ ...SMTP, MAIL_TRANSPORT: 'off' } as MailEnv)).toHaveProperty(
			'refusal'
		);
	});
});

describe('MAIL_DRAIN_LIMIT bounds one mail drain', () => {
	it('takes the lever over the default, and clamps a value past the subrequest budget', () => {
		expect(mailDrainLimit({})).toBe(5);
		expect(mailDrainLimit({ MAIL_DRAIN_LIMIT: '2' })).toBe(2);
		expect(mailDrainLimit({ MAIL_DRAIN_LIMIT: '2' })).not.toBe(mailDrainLimit({}));
		expect(mailDrainLimit({ MAIL_DRAIN_LIMIT: '400' })).toBe(25);
	});
});

/** the operator surface reports what the serving path will do, so one read covers both */
describe('SHELL_ASSEMBLY switches fragment assembly', () => {
	const enabled = async (overrides: Record<string, unknown>) => {
		const stub = freshSite();
		return inObject(stub, async (site) => {
			site.env = { ...site.env, ...overrides };
			markProvisioned(site);
			const res = await site.fetch(new Request('https://do.local/__shell?path=%2F'));
			return ((await res.json()) as { enabled: boolean }).enabled;
		});
	};

	it('is on by default and off when the lever says so', async () => {
		expect(await enabled({})).toBe(true);
		expect(await enabled({ SHELL_ASSEMBLY: '0' })).toBe(false);
	});

	it('agrees with the function the serving path calls', () => {
		expect(shellAssemblyEnabled(siteEnv({}))).toBe(true);
		expect(shellAssemblyEnabled(siteEnv({ SHELL_ASSEMBLY: '0' }))).toBe(false);
	});
});

/**
 * Placement, observed on the options the front worker hands `SITE.get()`.
 *
 * It applies at creation only, so there is nothing later to read it off; the argument is the whole
 * of the effect.
 */
describe('SITE_LOCATION_HINT reaches the namespace', () => {
	it('passes no options by default and a hint when one is set', async () => {
		const fallback = await through('/lever-hint');
		const set = await through('/lever-hint', { SITE_LOCATION_HINT: 'weur' });
		expect(fallback.options[0]).toBeUndefined();
		expect(set.options[0]).toEqual({ locationHint: 'weur' });
	});

	it('ignores a region that is not one, rather than passing it through', async () => {
		const nonsense = await through('/lever-hint', { SITE_LOCATION_HINT: 'mars' });
		expect(nonsense.options[0]).toBeUndefined();
		expect(locationHint({ SITE_LOCATION_HINT: 'weur' })).toBe('weur');
		expect(locationHint({ SITE_LOCATION_HINT: 'mars' })).toBeUndefined();
	});
});

/**
 * The read replica pool, observed on the object NAME the front worker addressed.
 *
 * A lane is the site name plus a suffix, so the routing decision is visible without a second object
 * existing. The session value is chosen by asking `chooseTarget()` which one lands off the primary,
 * because an affinity that hashes to lane 0 is a correct answer and would read as the lever failing.
 */
describe('REPLICA_COUNT and WRITE_FORWARD move which object answers', () => {
	beforeEach(() => resetLaneBeliefs());

	const SITE = 'cfw.local';

	/** a session value whose affinity hashes off the primary at this pool size */
	function sessionOffPrimary(replicas: number): string {
		for (let i = 0; i < 64; i++) {
			const value = `lane-probe-${i}`;
			const at = chooseTarget({
				site: SITE,
				method: 'GET',
				affinity: `s:${value}`,
				replicas,
				pathname: '/serve'
			});
			if (at.lane !== 0) return value;
		}
		throw new Error('no session value routed off the primary');
	}

	it('addresses the site itself by default and a lane when a pool is configured', async () => {
		const cookie = { headers: { cookie: `${SESSION_COOKIE}=${sessionOffPrimary(4)}` } };
		const fallback = await through('/lever-replicas', {}, cookie);
		const set = await through('/lever-replicas', { REPLICA_COUNT: '4' }, cookie);
		expect(fallback.names[0]).toBe(SITE);
		expect(set.names[0]).toMatch(/^cfw\.local#r[1-4]$/);
		expect(set.names[0]).not.toBe(fallback.names[0]);
		expect(replicaCount({})).toBe(0);
		expect(replicaCount({ REPLICA_COUNT: '4' })).toBe(4);
	});

	it('sends a write to a lane by default and to the primary when forwarding is off', async () => {
		const post: RequestInit = {
			method: 'POST',
			body: 'title=x',
			headers: {
				cookie: `${SESSION_COOKIE}=${sessionOffPrimary(4)}`,
				'content-type': 'application/x-www-form-urlencoded'
			}
		};
		const fallback = await through('/lever-forward', { REPLICA_COUNT: '4' }, post);
		const off = await through(
			'/lever-forward',
			{ REPLICA_COUNT: '4', WRITE_FORWARD: '0' },
			post
		);
		expect(fallback.names[0]).toMatch(/^cfw\.local#r[1-4]$/);
		expect(off.names[0]).toBe(SITE);
		expect(writeForwardEnabled({})).toBe(true);
		expect(writeForwardEnabled({ WRITE_FORWARD: '0' })).toBe(false);
	});
});

/**
 * The staleness bound a serving lane keeps itself inside.
 *
 * Observed on the alarm the lane armed: `alarmBody()` re-arms an idle lane four minutes out and
 * this pulls the firing in, so the lever IS the distance between now and the next alarm.
 */
describe('REPLICA_LAG_MS pulls in a serving lane firing', () => {
	const armedIn = async (name: string, overrides: Record<string, unknown>) => {
		const stub = namedSite(name);
		return inObject(stub, async (site) => {
			site.env = { ...site.env, ...QUIET_ALARM, ...overrides };
			markProvisioned(site);
			// one step at a time, because `canTransition()` refuses a jump
			for (const stage of ['RESTORING', 'VERIFIED', 'CATCHING_UP', 'ELIGIBLE', 'SERVING']) {
				site.setReplicaStage(stage);
			}
			if (site.replicaStage() !== 'SERVING') return null;
			await site.alarm();
			const at = await site.ctx.storage.getAlarm();
			const gap = at === null ? null : Number(at) - site.nowMs();
			await quiesce(site);
			return gap;
		});
	};

	it('bounds the gap at the default and widens it when the lever widens', async () => {
		const fallback = await armedIn('lag-default#r1', {});
		const set = await armedIn('lag-set#r1', { REPLICA_LAG_MS: '120000' });
		expect(fallback, 'the lane never reached SERVING').not.toBeNull();
		expect(fallback!).toBeLessThanOrEqual(DEFAULT_REPLICA_LAG_MS);
		expect(set!).toBeGreaterThan(DEFAULT_REPLICA_LAG_MS);
		expect(replicaLagMs({})).toBe(DEFAULT_REPLICA_LAG_MS);
		expect(replicaLagMs({ REPLICA_LAG_MS: '120000' })).toBe(120_000);
	});
});

/**
 * Warming, observed on the interval the object re-armed at.
 *
 * An idle object with no arrivals declines to warm itself, so the pair that separates is the default
 * against an explicit `SITE_WARM=1` -- which the predictor is forbidden to overrule.
 */
describe('SITE_WARM decides the idle re-arm', () => {
	const rearm = (overrides: Record<string, unknown>) => {
		const stub = freshSite();
		return inObject(stub, async (site) => {
			site.env = { ...site.env, ...overrides };
			markProvisioned(site);
			return (site as unknown as { thermalRearmMs(): number }).thermalRearmMs();
		});
	};

	it('re-arms inside the hibernation threshold only when warming is asked for', async () => {
		const fallback = await rearm({});
		const on = await rearm({ SITE_WARM: '1' });
		expect(fallback).toBe(240_000);
		expect(on).toBe(8_000);
		// a Durable Object hibernates at 10 s, so the two sit either side of staying resident
		expect(on).toBeLessThan(10_000);
		expect(fallback).toBeGreaterThan(10_000);
	});

	it('agrees with the interval the cron module resolves', () => {
		expect(siteWarmEnabled({})).toBe(true);
		expect(siteWarmEnabled({ SITE_WARM: '0' })).toBe(false);
		expect(idleRearmMs({ SITE_WARM: '1' })).toBe(8_000);
		expect(idleRearmMs({ SITE_WARM: '0' })).toBe(240_000);
	});
});

/**
 * The compiled-plan tier in the front worker.
 *
 * `x-cfw-plan` reports what the tier decided, and `skip:not-wanted` is what it says about a request
 * it was never going to serve -- which is every request once the lever is off.
 */
describe('EDGE_PLAN switches the compiled-plan tier', () => {
	beforeEach(() => resetEdgePlans());

	const verdict = async (path: string, overrides: Record<string, unknown>) => {
		const out = await through(
			path,
			overrides,
			{ headers: { cookie: `${SESSION_COOKIE}=plan-lever` } },
			{ 'x-cfw-roles': 'authenticated,editor' }
		);
		return planHeaderOf(out.res);
	};

	it('samples toward a plan by default and declines every request when off', async () => {
		expect(await verdict('/lever-plan-on', {})).toBe('sampling');
		expect(await verdict('/lever-plan-off', { EDGE_PLAN: '0' })).toBe('skip:not-wanted');
		expect(edgePlanEnabled({})).toBe(true);
		expect(edgePlanEnabled({ EDGE_PLAN: '0' })).toBe(false);
	});
});

/**
 * The baked asset aggregates, applied at store time.
 *
 * The manifest is a stand-in rather than `assets/agg/`, which is a build artifact a clean checkout
 * does not have; the substitution is the same code either way.
 */
describe('ASSET_AGGREGATES rewrites what is stored', () => {
	const INDEX = {
		libraries: { 'test/lever': { js: 'lever-aggregate.js' } },
		files: { 'test/lever': { js: ['/modules/lever-a.js', '/modules/lever-b.js'] } }
	};
	const PAGE =
		'<html><body><script src="/modules/lever-a.js?v=1"></script>' +
		'<script src="/modules/lever-b.js?v=1"></script></body></html>';

	const store = async (overrides: Record<string, unknown>) => {
		const stub = freshSite();
		return inObject(stub, async (site) => {
			site.env = {
				...site.env,
				ASSETS: { fetch: async () => Response.json(INDEX) },
				...overrides
			};
			markProvisioned(site);
			stubRender(site, () => ({
				html: PAGE,
				status: 200,
				contentType: 'text/html; charset=utf-8',
				renderMs: 5,
				bytes: PAGE.length,
				pageCache: 'MISS',
				dynamicCache: 'MISS'
			}));
			queuePath(site, '/aggregated', { arm: false });
			await site.fillOne('/aggregated');
			const row = site.sql
				.exec('SELECT html FROM cfw_page WHERE path = ?', '/aggregated')
				.toArray()[0];
			return String(row?.html ?? '');
		});
	};

	it('stores the page as rendered by default and aggregated when the lever is on', async () => {
		const fallback = await store({});
		const on = await store({ ASSET_AGGREGATES: '1' });
		expect(fallback).toBe(PAGE);
		expect(fallback).toContain('/modules/lever-a.js');
		expect(on).toContain('/agg/lever-aggregate.js');
		expect(on).not.toContain('/modules/lever-a.js');
		expect(on.length).toBeLessThan(fallback.length);
	});
});

/**
 * Which engine answers an image derivative, through the bridge the field formatter calls.
 *
 * PHP names a style and never an engine, so the URL it is handed is the whole of the effect.
 */
describe('IMAGE_ENGINE decides which derivative URL PHP is handed', () => {
	const urlFor = async (overrides: Record<string, unknown>) => {
		const stub = freshSite();
		return inObject(stub, async (site) => {
			site.env = { ...site.env, ...overrides };
			markProvisioned(site);
			const bag = bridgeOf(site);
			return call(bag, 'cfwImageUrl', {
				uri: 'public://lever.jpg',
				transform: { width: 220, height: 220, fit: 'cover' }
			});
		});
	};

	it('builds a worker transform by default and a Cloudflare Images URL when switched', async () => {
		const fallback = await urlFor({});
		const images = await urlFor({ IMAGE_ENGINE: 'images' });
		expect(fallback.engine).toBe('tinyimg');
		expect(images.engine).toBe('images');
		expect(String(images.url)).not.toBe(String(fallback.url));
		expect(imageEngine({})).toBe('tinyimg');
		expect(imageEngine({ IMAGE_ENGINE: 'images' })).toBe('images');
	});
});

/**
 * The two levers whose reader is the interpreter.
 *
 * Both reach PHP through something a spec here cannot construct -- the opcache arm is a constructor
 * argument and argon2 is a `settings.php` assignment -- so what is drivable is the decision each
 * one feeds, and it is asserted in both directions rather than only in the one the lever names.
 */
describe('OPCACHE_MODE and ARGON2 resolve before the interpreter is built', () => {
	it('emits different opcache ini for different arms', () => {
		const fallback = opcacheIni(opcacheMode(undefined));
		const file = opcacheIni(opcacheMode('file'));
		expect(opcacheMode(undefined)).toBe('off');
		expect(opcacheMode('file')).toBe('file');
		expect(file).not.toEqual(fallback);
		// an unrecognised arm falls back rather than passing a name the build cannot honour
		expect(opcacheIni(opcacheMode('nonsense'))).toEqual(fallback);
	});

	it('keeps argon2 off until an operator asks, because enabling it rehashes every login', () => {
		expect(argon2Enabled(siteEnv({}))).toBe(false);
		expect(argon2Enabled(siteEnv({ ARGON2: '1' }))).toBe(true);
		expect(argon2Enabled(siteEnv({ ARGON2: '0' }))).toBe(false);
	});
});
