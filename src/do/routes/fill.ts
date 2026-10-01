import { invalidateTags, renderPage } from '../../drupal/site-php';
import {
	compilePlan,
	fillSlots,
	generatorAgrees,
	planExplainsBoth,
	planRoundTrips,
	type RenderPlan,
	runPlan,
	unknownContext,
	unservableSlots
} from '../../ops/render-plan';
import { sweepEnabled, type SweepEnv } from '../../ops/sweep';
import type { SitePhpDurableObject } from '../../site-do';
import { firstRow } from '../../util/sql';
import { shellAssemblyEnabled } from '../levers';
import type { Payload, Row } from '../types';

/** runs `Cache::invalidateTags()` so its cachetags write bumps the generation */
export async function invalidate(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const tags = (url.searchParams.get('tags') ?? 'rendered')
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);
	const before = site.generation();
	const php = await site.runJson(invalidateTags(tags));
	const after = site.generation();
	return Response.json(
		{ ...php, generationBefore: before, generationAfter: after },
		{ headers: { 'x-cfw-generation': String(after) } }
	);
}

/** one integer write invalidates every edge-cached URL for this site (no tag purging) */
export async function bump(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const out = site.bumpGeneration(url.searchParams.get('reason') ?? 'manual');
	return Response.json(
		{ ...out, bumps: site.bumps ?? 0 },
		{ headers: { 'x-cfw-generation': String(out.generation) } }
	);
}

/** drives one fill (or `?max=` of them) synchronously, or queues `?path=` for the alarm chain */
export async function fill(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	// `?path=` enqueues rather than draining; a stale answer has no waiter, so the render
	// belongs on the alarm chain where its rows are budgeted
	const queuePath = url.searchParams.get('path');
	const wantsDrain = url.searchParams.get('max') !== null;
	if (queuePath !== null && queuePath !== '') {
		site.ensureServeTables();
		// comma-separated so a whole batch seats in one invocation (enqueuing arms the fill
		// alarm, which can drain the queue before the caller's next request arrives)
		for (const one of queuePath.split(',')) {
			const trimmed = one.trim();
			if (trimmed === '') continue;
			site.sql.exec(
				'INSERT INTO cfw_fill_queue (path, queued_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING',
				trimmed,
				site.nowMs()
			);
		}
		// only when not draining here; arming behind our own drain hands the batch to the alarm
		if (!wantsDrain) {
			site.armFillAlarm();
			return Response.json({ queued: queuePath, depth: site.queueDepth() });
		}
	}
	// `?max=` drains a batch in one invocation, so boot is paid once for all k
	// call `this.fillOne()`, never `this.gate.run()`: `fetch()` holds the non-reentrant gate
	const asked = Number(url.searchParams.get('max') ?? '1');
	const max = Number.isFinite(asked) && asked > 1 ? Math.floor(asked) : 1;
	if (max === 1) return Response.json(await site.fillOne());
	const fills: Payload[] = [];
	for (let i = 0; i < max; i++) {
		const one = (await site.fillOne()) as Payload;
		fills.push(one);
		// an empty queue ends the batch, so idle invocations do not read as a saving
		if ((one?.['filled'] ?? null) === null) break;
		// same guard as the alarm batch; `recycleIfOversized()` runs between invocations, not
		// inside this loop
		if (site.oversized()) break;
	}
	return Response.json({
		ok: true,
		asked: max,
		fills: fills.length,
		drained: fills.filter((f) => (f['filled'] ?? null) !== null).length,
		remaining: site.queueDepth(),
		oversized: site.oversized(),
		outcomes: fills
	});
}

/**
 * The compiled render plan, and the VM that executes it without entering PHP.
 * `action=compile` renders twice, diffs the bodies and stores the op list; `action=run` executes
 * it; `chunk` splits constant runs so the op count can be swept.
 */
export async function plan(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	site.ensureServeTables();
	const planPath = url.searchParams.get('path') ?? '/';
	const action = url.searchParams.get('action') ?? 'run';
	const chunk = Number(url.searchParams.get('chunk') ?? '0');
	// installs a plan compiled elsewhere; refused unless the generator agrees with it
	if (action === 'seed') {
		if (request.method !== 'POST') {
			return Response.json({ ok: false, reason: 'POST only' }, { status: 405 });
		}
		let seeded: RenderPlan;
		try {
			seeded = (await request.json()) as RenderPlan;
		} catch (e: any) {
			return Response.json(
				{ ok: false, reason: `unparseable: ${e?.message ?? e}` },
				{ status: 400 }
			);
		}
		if (!Array.isArray(seeded?.ops) || !generatorAgrees(seeded)) {
			return Response.json(
				{
					ok: false,
					reason: 'the generator does not agree with this plan'
				},
				{ status: 409 }
			);
		}
		site.sql.exec(
			`INSERT INTO cfw_plan (path, plan, uid, stale, compiled_at) VALUES (?, ?, ?, 0, ?)
               ON CONFLICT(path) DO UPDATE SET plan = excluded.plan, uid = excluded.uid,
                 stale = 0, compiled_at = excluded.compiled_at`,
			planPath,
			JSON.stringify(seeded),
			Number(url.searchParams.get('uid') ?? 0),
			site.nowMs()
		);
		return Response.json({ ok: true, path: planPath, ops: seeded.ops.length });
	}

	// the raw body of one render, since the compiler's own diff is a single span
	if (action === 'agree') {
		const row = firstRow(
			site.sql.exec<Row<{ plan: string }>>(
				'SELECT plan FROM cfw_plan WHERE path = ?',
				planPath
			)
		);
		if (!row) return new Response('no plan', { status: 404 });
		const stored = JSON.parse(String(row.plan)) as RenderPlan;
		const n = Math.min(Math.max(Number(url.searchParams.get('n') ?? 20), 1), 200);
		let agreed = 0;
		for (let i = 0; i < n; i++) if (generatorAgrees(stored)) agreed++;
		// a fresh token every call, so one false does not mean the page is unservable
		return Response.json({
			path: planPath,
			n,
			agreed,
			slots: Object.values(stored.slots).map((s) => s.kind),
			unservable: unservableSlots(stored)
		});
	}

	if (action === 'render') {
		const out = (await site.runJson(
			renderPage(planPath, ['page', 'dynamic_page_cache'], false, {
				origin: site.canonicalOrigin(url.origin),
				...(url.searchParams.get('cookie')
					? { cookie: url.searchParams.get('cookie')! }
					: {})
			})
		)) as unknown as Record<string, unknown>;
		return new Response(String(out.html ?? ''), {
			headers: {
				'content-type': 'text/html; charset=UTF-8',
				'x-cfw-plan-uid': String(out.uid ?? ''),
				'x-cfw-plan-render-ms': String(out.renderMs ?? '')
			}
		});
	}
	if (action === 'compile') {
		// rendered directly, not through `fillOne`: `cfw_page` refuses authenticated responses
		const cookie = url.searchParams.get('cookie') ?? '';
		const bodyOf = async (): Promise<Record<string, unknown>> =>
			(await site.runJson(
				renderPage(planPath, ['page', 'dynamic_page_cache'], false, {
					origin: site.canonicalOrigin(url.origin),
					...(cookie === '' ? {} : { cookie })
				})
			)) as unknown as Record<string, unknown>;
		// the first render of a route warms the asset library cache, so renders 1 and 2 differ in
		// stylesheets (three warm-ups give a servable plan)
		const warmups = Math.max(
			0,
			Math.min(Number(url.searchParams.get('warmups') ?? '2') || 0, 5)
		);
		for (let i = 0; i < warmups; i++) await bodyOf();
		const ra = await bodyOf();
		const rb = await bodyOf();
		const a = String(ra.html ?? '');
		const b = String(rb.html ?? '');
		if (a === '' || b === '') {
			return Response.json(
				{ ok: false, reason: 'the render produced no body', a: ra, b: rb },
				{ status: 409 }
			);
		}
		const plan = compilePlan(a, b, planPath, chunk);
		// the plan carries the session's `form_token`, so the uid is stored with it and
		// `action=run` refuses non-anonymous plans
		const planUid = Number(ra.uid ?? 0);
		site.sql.exec(
			`INSERT INTO cfw_plan (path, plan, uid, tags, stale, compiled_at)
               VALUES (?, ?, ?, ?, 0, ?)
               ON CONFLICT(path) DO UPDATE SET plan = excluded.plan, uid = excluded.uid,
                 tags = excluded.tags, stale = 0, compiled_at = excluded.compiled_at`,
			planPath,
			JSON.stringify(plan),
			planUid,
			JSON.stringify(Array.isArray(ra.cacheTags) ? ra.cacheTags : []),
			site.nowMs()
		);
		return Response.json({
			ok: true,
			path: planPath,
			ops: plan.ops.length,
			slots: plan.slots,
			sample: plan.sample,
			unservable: unservableSlots(plan),
			// the markup either side of each refusal, so a census groups by mechanism
			context: unknownContext(plan),
			// what Drupal answered (an all-403 route would otherwise read as servable)
			status: ra.status ?? null,
			location: ra.location ?? null,
			// who Drupal thought was asking (a census that rendered as uid 0 would look like a
			// result)
			uid: [ra.uid ?? null, rb.uid ?? null],
			renderMs: [ra.renderMs ?? null, rb.renderMs ?? null],
			bytes: a.length,
			// falsification: the plan filled with its learned sample must reproduce the
			// compile-time render byte for byte
			roundTrips: planRoundTrips(plan, a),
			// stronger: a round trip on the first render also passes a compiler that emitted one
			// constant and no slot, so require the second render back from the second's values
			explainsBoth: planExplainsBoth(plan, a, b),
			// and the generator produces bytes of the same shape
			generatorAgrees: generatorAgrees(plan)
		});
	}
	const stored = firstRow(
		site.sql.exec<Row<{ plan: string; uid: number; stale: number }>>(
			'SELECT plan, uid, stale FROM cfw_plan WHERE path = ?',
			planPath
		)
	);
	if (!stored) return new Response('no plan', { status: 404 });
	// flagged at a `cachetags` write, not yet judged against the invocation's full tag set
	// (a dead invocation leaves it flagged, which is the direction that must fail)
	if (Number(stored.stale ?? 0) !== 0) {
		return Response.json(
			{ ok: false, reason: 'plan is stale pending invalidation' },
			{ status: 409 }
		);
	}
	// a signed-in plan holds that session's `form_token`, so serving it to anyone else leaks it
	// (`unsafe=1` exists to measure the authenticated cost)
	if (Number(stored.uid ?? 0) !== 0 && url.searchParams.get('unsafe') !== '1') {
		return Response.json(
			{ ok: false, reason: `plan compiled for uid ${stored.uid}` },
			{ status: 409 }
		);
	}
	const plan = JSON.parse(String(stored.plan)) as RenderPlan;
	// refused rather than filled with a right-sized guess; a plan with an unproducible dynamic
	// value would serve a page that looks right and is wrong
	const values = fillSlots(plan);
	if (values === undefined) {
		return Response.json(
			{ ok: false, unservable: unservableSlots(plan), ops: plan.ops.length },
			{ status: 409 }
		);
	}
	const html = runPlan(plan, values);
	return new Response(html, {
		status: 200,
		headers: {
			'content-type': 'text/html; charset=UTF-8',
			'x-cfw-lane': 'plan',
			'x-cfw-plan-ops': String(plan.ops.length)
		}
	});
}

/**
 * One assembly per invocation: only the `page` bin is emptied, so `dynamic_page_cache` answers
 * and the page is reassembled from cached render arrays. The `cfw_page` row is deleted first;
 * `dynamicCache` is echoed back, and a `HIT` is what makes the timing meaningful.
 */
export async function assembleRoute(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	site.ensureServeTables();
	const path = url.searchParams.get('path') ?? '/';
	const bins = (url.searchParams.get('bins') ?? 'page')
		.split(',')
		.map((b) => b.trim())
		.filter(Boolean);
	site.sql.exec('DELETE FROM cfw_page WHERE path = ?', path);
	// `destruct=0` is the shipped lifecycle (an A/B for collector persistence)
	// absent, empty and "0" mean off, "1" the safe set, anything else an allowlist of service ids
	const destructParam = url.searchParams.get('destruct');
	const destruct =
		destructParam === null || destructParam === '' || destructParam === '0'
			? false
			: destructParam === '1'
				? true
				: destructParam;
	const before = site.queryCount;
	const beforeWritten = site.rowsWritten ?? 0;
	const t0 = Date.now();
	// the origin rides along as on `/serve`; without it the fill rendered `http://localhost` and
	// pages gathered one feed link per origin
	const outcome = await site.fillOne(path, bins, destruct, {
		origin: site.canonicalOrigin(url.origin)
	});
	return Response.json({
		...outcome,
		origin: site.canonicalOrigin(url.origin),
		bins,
		destruct,
		wallMs: Date.now() - t0,
		hostStatements: site.queryCount - before,
		rowsWritten: (site.rowsWritten ?? 0) - beforeWritten,
		phpBooted: !!site.php
	});
}

/** harvests a path under two sessions of one role set; stored only if the bytes normalise equal */
export async function shell(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	site.ensureServeTables();
	const shellPath = url.searchParams.get('path') ?? '/';
	const jars = url.searchParams
		.getAll('cookie')
		.map((c) => c.trim())
		.filter((c) => c !== '');
	if (request.method !== 'POST') {
		site.ensureServeTables();
		const refusal = site.metaGet('shellRefusal');
		return Response.json({
			path: shellPath,
			enabled: shellAssemblyEnabled(site.env),
			stored: site.sql
				.exec<{
					path: string;
					permissions_hash: string;
					harvested_at: number;
				}>('SELECT path, permissions_hash, harvested_at FROM cfw_shell')
				.toArray(),
			// which visitors a stored shell is proven for; none means harvested but never assembled
			// from
			verified: site.sql
				.exec<{
					path: string;
					permissions_hash: string;
					uid: string;
					verified_at: number;
				}>('SELECT path, permissions_hash, uid, verified_at FROM cfw_shell_verified')
				.toArray(),
			// the row is deleted, so without this a refusal leaves an empty `stored` and no reason
			lastRefusal: refusal === null ? null : (JSON.parse(refusal) as unknown)
		});
	}
	await site.ensurePhp();
	const outcome = await site.harvestShellFor(shellPath, jars, site.canonicalOrigin(url.origin));
	return Response.json(outcome, { status: outcome.stored ? 200 : 409 });
}

/**
 * Coverage of the addressable space, and one step of closing it.
 * `?run=1` forces a step off its interval; a bare `GET` reports and spends nothing. It never takes
 * `this.gate`, so calling it from a route cannot hang.
 */
export async function sweep(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	site.ensureServeTables();
	const asked = url.searchParams.get('run') === '1';
	// `ran` separates a step that happened from a stale report left by an earlier firing
	const ran = asked ? site.sweepBeat({ force: true }) : false;
	return Response.json({
		sweep: site.lastSweep ?? null,
		at: site.lastSweepAt ?? null,
		ran,
		enabled: sweepEnabled(site.env as SweepEnv | undefined),
		...(asked && !ran ? { skipped: 'SWEEP is off' } : {})
	});
}

/**
 * Wakes the fill chain from an event of its own (`/__enable` may not arm its own alarm).
 * One `setAlarm()` and nothing else, so the arming event writes no other rows.
 */
export async function armfill(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const queued = site.queueDepth();
	if (queued > 0) await site.setAlarmAt(site.nowMs() + 1);
	return Response.json({ ok: true, queued, armed: queued > 0 });
}
