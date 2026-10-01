import { carriesUpload, type RenderRequest, requestBody } from '../../drupal/site-php';
import { ATTEMPT_HEADER, attemptKey } from '../../ops/attempt';
import {
	authAllowance,
	type AuthSpend,
	authSpendHeaders,
	hasSessionCookie,
	ROLES_HEADER,
	secondsUntilUtcReset,
	spendForToday
} from '../../ops/auth-budget';
import { cronIntervalMs, drupalCronEnabled } from '../../ops/cron-drive';
import { readOnlyResponse } from '../../ops/degrade';
import { hibernationEligible } from '../../ops/hibernation';
import { isPaid } from '../../ops/plan';
import { planProfile } from '../../ops/plan-profile';
import { ReplicaRequiresPrimary } from '../../ops/replica';
import { FIRST_RUN_KEY, needsSetup, setupResponse } from '../../ops/setup-page';
import { warmingResponse } from '../../ops/warming-page';
import type { SitePhpDurableObject } from '../../site-do';
import { DIAG_EXEC_COUNTERS_PHP } from '../../site/generated/assets';
import { phpScript } from '../../util/php';
import { jsonError } from '../../util/reply';
import { firstRow } from '../../util/sql';
import { isolateResidency, retainInterpreterEnabled } from '../isolate';
import { fillSettleMs, shellAssemblyEnabled } from '../levers';
import { CFW_HEADER_VERSION, FILL_QUEUE_MAX, SERVE_REQUESTS_FLUSH } from '../limits';
import type { PageRow } from '../types';

/**
 * The serving path; `x-cfw-cache` says which of three outcomes answered.
 *
 * `HIT` answers from SQL without PHP, `RENDER` rendered in this invocation, `MISS` returned a
 * placeholder and left the alarm chain to fill. Inline rendering buys wall time, not CPU, and is
 * skipped unless the estimate fits the budget (in practice, the interpreter is already up).
 */
export async function serve(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	site.ensureServeTables();
	const path = url.searchParams.get('path') ?? '/';
	const t0 = Date.now();

	// a lane refuses until it is `SERVING`, so the router needs no readiness cache
	if (site.isPoolLane() && site.replicaStage() !== 'SERVING') {
		// answered rather than thrown: the one refusal raised before any interpreter exists
		return site.replicaHandoff(
			new ReplicaRequiresPrimary(
				'serve',
				`this replica is ${site.replicaStage()} and is not taking traffic`
			),
			true
		);
	}

	// a stale replica must not answer: a 503 carrying both generations sends the router to the
	// primary (only as strong as the clock advancing on every change; `generation-fence.spec.ts`)
	const fence = site.fenceRefusal(request);
	if (fence.refuse) {
		return Response.json(
			{
				stale: true,
				applied: fence.applied,
				required: fence.required,
				reason: 'this replica has not applied the generation the caller requires'
			},
			{
				status: 503,
				headers: {
					'retry-after': '1',
					'x-cfw-cache': 'STALE',
					'x-cfw-generation': String(site.generation()),
					'x-cfw-applied-generation': String(fence.applied),
					'x-cfw-required-generation': String(fence.required)
				}
			}
		);
	}

	// a half-migrated site must not render (truncated pages would reach the edge): 503 with
	// Retry-After; a page request arms provisioning because `/migrate` is gated
	if (site.neverMigrated()) {
		await site.requestProvision();
		return warmingResponse({
			stage: 'migrating',
			retryAfterSeconds: 2,
			request,
			headers: {
				'x-cfw-migrate': 'starting',
				'x-cfw-migrate-state': 'queued'
			}
		});
	}

	const partial = site.migratePartial();
	if (partial) {
		return warmingResponse({
			stage: 'migrating',
			// seconds, and short: the alarm chain re-arms at +1 ms
			retryAfterSeconds: 1,
			request,
			headers: {
				'x-cfw-migrate': `${partial.chunk}/${partial.chunks}`,
				'x-cfw-migrate-state': partial.state
			}
		});
	}
	site.serveRequestsPending = (site.serveRequestsPending ?? 0) + 1;
	if (site.serveRequestsPending >= SERVE_REQUESTS_FLUSH) site.flushServeRequests();

	// an unclaimed site shows its owner the way in: uid 1 ships with an empty hash, so nothing
	// can sign in until `/firstrun` mints a password; after the migration guards and the counter
	if (needsSetup(request, site.metaGet(FIRST_RUN_KEY) !== null)) {
		return setupResponse(site.canonicalOrigin(url.origin), {
			'x-cfw-serve-ms': String(Date.now() - t0),
			'x-cfw-v': CFW_HEADER_VERSION
		});
	}

	// the read-only rung is checked before the cache read: a non-`GET` must be refused
	// whether or not a cached copy exists, because it would write
	const degraded = site.degradation();
	if (!degraded.writes && request.method !== 'GET' && request.method !== 'HEAD') {
		return readOnlyResponse(secondsUntilUtcReset(Date.now()), degraded);
	}

	// a submission is never answered from `cfw_page` (the row holds an anonymous `GET`, so a `POST`
	// would get the empty form back with a 200 and never run Drupal); sessions likewise
	const authenticated = hasSessionCookie(request.headers.get('cookie'));
	const cacheable = (request.method === 'GET' || request.method === 'HEAD') && !authenticated;
	const hit = cacheable
		? firstRow(
				site.sql.exec<PageRow>(
					'SELECT status, content_type, html, rendered_at, render_ms FROM cfw_page WHERE path = ?',
					path
				)
			)
		: undefined;

	if (hit) {
		return site.pageResponse(hit, 'HIT', Date.now() - t0, {
			// the gated lane answered (tables not ready, or `lane=gate` forced it)
			'x-cfw-lane': 'php-gate'
		});
	}

	// queued before the inline attempt as the safety net; never for a session (the chain would
	// publish an admin's 403); `FILL_QUEUE_MAX` bounds the table
	const queueable = !authenticated && degraded.queue && site.queueDepth() < FILL_QUEUE_MAX;
	if (queueable) {
		// priority 0: a visitor is holding a connection open (a FIFO queue served misses after
		// every prefill: p50 19,004 ms); `DO UPDATE` promotes a queued path
		site.sql.exec(
			`INSERT INTO cfw_fill_queue (path, queued_at, priority) VALUES (?, ?, 0)
               ON CONFLICT(path) DO UPDATE SET priority = 0`,
			path,
			site.nowMs()
		);
	}
	// a pending alarm is not enough: the queue drains and `alarm()` re-arms 240 s out, so pull
	// it in whenever it is further away than the next tick
	const soon = site.nowMs() + 1;
	const existing = await site.storage.getAlarm();
	if (existing === null || existing > soon + 50) {
		await site.setAlarmAt(soon);
	}

	// `fetch()` holds the gate, so `fillOne()` must not re-enter it; `ctx.waitUntil()` would put
	// the CPU on the same budget
	const budgetMs = site.inlineBudgetMs(url);
	const estimateMs = site.estimateRenderMs();
	// a cold object refuses on `!this.php`, not on the budget; a `MISS` at the top rung answers 503
	// rather than spend ~13 rows
	if (!degraded.render) {
		return readOnlyResponse(secondsUntilUtcReset(Date.now()), degraded);
	}
	// `bootInline: false` defers an anonymous `GET` to the chain, which is a dead end for these two
	const submission = request.method !== 'GET' && request.method !== 'HEAD';
	// a path the chain proved it cannot store (Drupal marks `/user/password` `private, no-store`)
	// never converges on an idle object, so lift the refusal for paths observed unstorable
	const unfillable = submission || authenticated || site.isUnstorable(path);
	const mayBoot = planProfile(site.env).bootInline || unfillable;
	const coldBoot = !site.php && mayBoot;
	let inline = '0';
	if (budgetMs <= 0 || url.searchParams.get('inline') === '0') {
		// an explicit lever is honoured even here; it is how a test forces a `MISS`
		inline = 'off';
	} else if (!site.php && !mayBoot) {
		inline = 'cold';
	} else if (estimateMs > budgetMs && !unfillable) {
		// diverting to the chain is the same dead end the boot gate just declined
		inline = 'over-budget';
	} else {
		// charge the authenticated allowance here only (a render is the one thing that costs), on
		// the cookie, not `x-cfw-auth` (a client composes that header)
		if (authenticated) {
			// the memo first: this object is the key's only writer, so it cannot be behind the
			// stored value
			const stored = site.authSpend ?? (await site.storage.get<AuthSpend>('authSpend'));
			// `spendForToday()` discards another UTC day's record, which makes the budget daily
			const today = spendForToday(stored);
			today.renders += 1;
			await site.storage.put('authSpend', today);
			site.authSpend = today;
		}
		// try the stored shell before a render, never for a submission or with the lever off; a
		// fragment render (4-5 ms) beats the page (20-21 ms) even on a cold object
		if (authenticated && !submission && shellAssemblyEnabled(site.env)) {
			const cookieHeader = request.headers.get('cookie') ?? '';
			const shellOrigin = site.canonicalOrigin(url.origin);
			let assembled = await site.assembleFor(path, cookieHeader, shellOrigin);
			// nothing stored for this path, so seed one from this visitor (`assembleFor()` still
			// gates serving on each uid's byte-equality proof)
			if (
				assembled === undefined &&
				!site.degradation().cron &&
				!site.shellSeedFailed.has(path) &&
				site.shellRows(path) === 0
			) {
				assembled = await site.seedShellFrom(path, cookieHeader, shellOrigin);
				// a page whose theme placeholders nothing can never be a shell; retrying would
				// harvest per request
				if (assembled === undefined) site.shellSeedFailed.add(path);
			}
			if (assembled) {
				return new Response(assembled.html, {
					status: 200,
					headers: new Headers({
						'content-type': 'text/html; charset=UTF-8',
						// a shell is shared; the assembled page is one visitor's
						'cache-control': 'private, no-store',
						// only a `cached` verdict assembled anything; the other two answer from the
						// visitor's own harvest
						'x-cfw-cache': assembled.verified === 'cached' ? 'ASSEMBLED' : 'VERIFY',
						'x-cfw-shell-verified': assembled.verified,
						'x-cfw-generation': String(site.generation()),
						'x-cfw-shell-holes': String(assembled.holes),
						'x-cfw-serve-ms': String(Date.now() - t0),
						// see `rolesOf()`: `roleSeen` is keyed by cookie, so omitting this starves
						// the plan tier for the session
						...(assembled.roles && assembled.roles.length > 0
							? { [ROLES_HEADER]: assembled.roles.join(',') }
							: {}),
						// the shell tier runs a real fragment render, so it spends the allowance
						// too
						...(site.authSpend
							? authSpendHeaders(site.authSpend, authAllowance(site.env))
							: {}),
						'x-cfw-v': CFW_HEADER_VERSION
					})
				});
			}
		}
		// a submission renders with the method and body that arrived; the cookie rides on both or
		// Drupal renders uid 0 and denies create routes
		const cookie = request.headers.get('cookie') ?? '';
		// pinned on the way past, so a later forged host cannot change the origin
		const origin = site.canonicalOrigin(url.origin);
		// Drupal's flood control keys on this; without it one bucket locks everyone out of
		// /user/login
		const clientIp = request.headers.get('cf-connecting-ip') ?? '';
		// `Request::create()` defaults the iframe-upload header to a match, which wraps every AJAX
		// response in a textarea
		const accept = request.headers.get('accept') ?? '';
		const posted =
			request.method === 'GET' || request.method === 'HEAD'
				? null
				: new Uint8Array(await request.clone().arrayBuffer());
		const contentType = request.headers.get('content-type') ?? '';
		if (posted !== null && carriesUpload(contentType, posted)) site.uploadSeen = true;
		const inbound: RenderRequest =
			posted === null
				? cookie
					? { origin, cookie, clientIp, accept }
					: { origin, clientIp, accept }
				: {
						origin,
						clientIp,
						accept,
						method: request.method,
						// decoded strictly, so a non-UTF-8 body (a file upload) travels as base64
						...requestBody(posted),
						contentType,
						cookie
					};
		// asked before the render, since a lane without the session hands back anyway;
		// `holdsSession()` chases one catch-up (closes the 20-62 s window)
		if (
			site.isPoolLane() &&
			hasSessionCookie(cookie) &&
			(await site.sessionReach(cookie)) === 'absent'
		) {
			return site.replicaHandoff(
				new ReplicaRequiresPrimary('session', 'the session has not reached this lane')
			);
		}
		// a repeat of an attempt that already started may have landed, so it is refused
		const attempt =
			posted === null ? undefined : attemptKey(request.headers.get(ATTEMPT_HEADER));
		if (attempt !== undefined && site.metaGet(attempt) !== null) {
			return new Response(null, {
				status: 503,
				headers: { [ATTEMPT_HEADER]: 'started' }
			});
		}
		site.pendingAttempt = attempt;
		const outcome = await site
			.fillOne(path, undefined, undefined, inbound)
			.finally(() => (site.pendingAttempt = undefined));
		// a lane without the session hands back rather than serving anonymous (the row arrives by
		// replication: 41 of 240 logged out on a 16-lane pool); a uid 0 `GET` mutated nothing
		if (
			site.isPoolLane() &&
			hasSessionCookie(cookie) &&
			!(outcome.roles ?? []).some((role) => role !== 'anonymous')
		) {
			// returned, never thrown: outside the try that converts `ReplicaRequiresPrimary`, a
			// throw answered 1101 (`replicaHandoff()` still applies `didMutate()`)
			return site.replicaHandoff(
				new ReplicaRequiresPrimary('session', 'the session is not in this lane yet')
			);
		}
		if (outcome.page) {
			// not `pageResponse()`, which hardcodes a cacheable `cache-control`; a submission's
			// response must not be stored
			const headers = new Headers({
				'content-type': outcome.page.contentType,
				'cache-control': 'private, no-store',
				'x-cfw-cache': 'RENDER',
				'x-cfw-generation': String(site.generation()),
				'x-cfw-method': String(request.method),
				'x-cfw-serve-ms': String(Date.now() - t0),
				// report the allowance here, not only on `outcome.filled` (`fillOne()` never stores
				// a cookie'd render, so the spending kind never reached it)
				...(site.authSpend
					? authSpendHeaders(site.authSpend, authAllowance(site.env))
					: {}),
				// what the edge plan is keyed on; a client presents a cookie and is told its role
				// set
				...(outcome.roles && outcome.roles.length > 0
					? { [ROLES_HEADER]: outcome.roles.join(',') }
					: {}),
				'x-cfw-v': CFW_HEADER_VERSION
			});
			// appended, never set: a login can emit more than one, and `set` would drop the session
			for (const line of outcome.page.setCookie) {
				headers.append('set-cookie', line);
			}
			if (outcome.page.location) {
				headers.set('location', outcome.page.location);
			}
			// ajax.js refuses a response with no `X-Drupal-Ajax-Token` unless the URL was declared
			// trusted
			for (const [name, value] of Object.entries(outcome.page.passHeaders ?? {})) {
				headers.set(name, value);
			}
			return new Response(String(outcome.page.html ?? ''), {
				status: outcome.page.status,
				headers
			});
		}
		if (outcome.filled === path) {
			const fresh = firstRow(
				site.sql.exec<PageRow>(
					'SELECT status, content_type, html, rendered_at, render_ms FROM cfw_page WHERE path = ?',
					path
				)
			);
			if (fresh) {
				return site.pageResponse(fresh, 'RENDER', Date.now() - t0, {
					// what the visitor spent and what is left, so the front Worker degrades without
					// a second trip
					...(site.authSpend
						? authSpendHeaders(site.authSpend, authAllowance(site.env))
						: {}),
					'x-cfw-lane': 'php-gate',
					'x-cfw-inline-budget-ms': String(budgetMs),
					'x-cfw-inline-estimate-ms': String(estimateMs),
					// what the fill reported paying for; `coldBoot` is the pre-gate decision and
					// they disagree when an alarm boots the object meanwhile
					'x-cfw-inline-boot': outcome.bootedInFill ? '1' : '0',
					'x-cfw-inline-boot-predicted': coldBoot ? '1' : '0',
					// the edge plan's key component
					...(outcome.roles && outcome.roles.length > 0
						? { [ROLES_HEADER]: outcome.roles.join(',') }
						: {}),
					// the wall clock could not time the render, so an estimate of 0 does not mean
					// it was free
					'x-cfw-render-clock': site.renderClockUnmeasurable ? 'unmeasurable' : 'ok'
				});
			}
		}
		// a render that threw is not a queued page: `warming` would retry the same failing render
		// forever, so it gets the exception (the log line is the only place it is visible)
		if (outcome.failed === path && outcome.error && outcome.notReady !== true) {
			console.error(
				`cfw render failed: ${path}: ${outcome.error}` +
					(outcome.raw ? ` -- ${outcome.raw}` : '')
			);
			return Response.json(
				{ ok: false, error: outcome.error, path },
				{
					status: 500,
					headers: {
						'cache-control': 'private, no-store',
						'x-cfw-cache': 'ERROR',
						'x-cfw-lane': 'php-gate',
						'x-cfw-inline': 'failed',
						'x-cfw-generation': String(site.generation()),
						// still queued against its three strikes, as the warming answer reports
						'x-cfw-queue-depth': String(site.queueDepth()),
						'x-cfw-serve-ms': String(Date.now() - t0),
						'x-cfw-v': CFW_HEADER_VERSION
					}
				}
			);
		}
		// no page, no stored row and nothing thrown: the fill has not happened yet
		inline = 'failed';
	}

	// 503, not 202: a 202 can be indexed with "warming" as the page's content
	// `x-cfw-queued` reports the actual outcome (an authenticated miss queues nothing)
	const shedLanes = site.laneHeaders();
	return warmingResponse({
		stage: 'warming',
		// seconds, short because the fill is queued and the alarm re-arms fast
		retryAfterSeconds: 1,
		request,
		headers: {
			'x-cfw-cache': 'MISS',
			'x-cfw-lane': 'php-gate',
			'x-cfw-generation': String(site.generation()),
			'x-cfw-queued': queueable ? '1' : '0',
			// what the retry is waiting on, so a shed is distinguishable from a fill in progress
			'x-cfw-retry-serves': queueable ? 'fill' : 'inline',
			'x-cfw-queue-depth': String(site.queueDepth()),
			'x-cfw-miss-ms': String(Date.now() - t0),
			'x-cfw-serve-ms': String(Date.now() - t0),
			'x-cfw-php-booted': site.php ? '1' : '0',
			'x-cfw-inline': inline,
			'x-cfw-inline-budget-ms': String(budgetMs),
			'x-cfw-inline-estimate-ms': String(estimateMs),
			// renamed at header version 2: `x-cfw-plan` already carries the edge plan's tier on the
			// front worker
			'x-cfw-account-plan': isPaid(site.env) ? 'paid' : 'free',
			// the pool is advertised from the shed path too, since a shedding primary is when the
			// router most needs to know one exists
			...shedLanes
		}
	});
}

/**
 * The fill queue, and a way to drain it.
 *
 * The recovery lever for a reset loop: a queue deeper than one batch can kill the isolate inside
 * the alarm and the next alarm retries the same batch (103 entries on a deployed free worker);
 * `recycleIfOversized()` runs between invocations and cannot reach it. `drop` takes a count,
 * oldest first (those already failed a batch).
 */
export async function queue(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	site.ensureServeTables();
	const action = url.searchParams.get('action') ?? 'list';
	const depth = site.queueDepth();
	if (action === 'list') {
		return Response.json({
			ok: true,
			depth,
			queue: site.sql
				.exec(
					'SELECT path, attempts, last_error, priority FROM cfw_fill_queue ' +
						'ORDER BY priority, queued_at LIMIT 200'
				)
				.toArray()
		});
	}
	if (action !== 'drop') {
		return jsonError(`unknown action ${action}; use list or drop`, 400);
	}
	// the whole queue unless a count is given; asking an operator to guess a depth they cannot read
	// is useless
	const asked = Number(url.searchParams.get('n') ?? '0');
	const limit = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : depth;
	site.sql.exec(
		'DELETE FROM cfw_fill_queue WHERE path IN (' +
			'SELECT path FROM cfw_fill_queue ORDER BY priority, queued_at LIMIT ?)',
		limit
	);
	const after = site.queueDepth();
	return Response.json({
		ok: true,
		before: depth,
		dropped: depth - after,
		after
	});
}

/** serving counters, residency, retention, fill hold, cron and hibernation state for this object */
export async function serveStats(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	site.ensureServeTables();
	// probed only when an interpreter exists (the probe runs PHP and would boot one: 1,398 ms, 96
	// MiB); `parkProbed` says whether it ran
	if (site.php) await site.parkState();
	const stats = site.serveStatsSync();
	// what the exec router served per program and outcome, on `?exec=1` and only from an
	// existing interpreter (it runs PHP)
	const exec =
		site.php && url.searchParams.get('exec') === '1'
			? await site.runJson(phpScript(DIAG_EXEC_COUNTERS_PHP)).catch(() => null)
			: null;
	return Response.json({
		...stats,
		exec,
		// other objects' interpreters share this isolate's 128 MiB
		isolate: isolateResidency(),
		retention: {
			enabled: retainInterpreterEnabled(site.env),
			adoptions: site.retentionAdoptions,
			last: site.lastRetention ?? null,
			bootBesideResident: site.bootBesideResident ?? null
		},
		fillHold: {
			settleMs: fillSettleMs(site.env),
			holds: site.fillHolds,
			last: site.lastFillHold ?? null,
			until: site.backgroundHold() ?? null
		},
		// the two `ctx.storage` reads are Promises, so they cannot be in the synchronous half PHP
		// calls
		cron: {
			enabled: drupalCronEnabled(site.env),
			lastRunMs: (await site.storage.get<number>('cronLastRunMs')) ?? null,
			intervalMs: cronIntervalMs(site.env)
		},
		hibernation: hibernationEligible({
			pendingAlarm: (await site.storage.getAlarm()) !== null,
			outboundSocket: site.mailSocketOpen === true
		})
	});
}
