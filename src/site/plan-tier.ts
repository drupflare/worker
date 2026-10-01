import { AUTH_MODE_HEADER, ROLES_HEADER } from '../ops/auth-budget';
import {
	believedCsrf,
	believedGeneration,
	believedRoles,
	edgePlanEnabled,
	edgePlanKey,
	edgePlanRefused,
	forgetWitness,
	hasEdgePlan,
	isRedirectStatus,
	lookupEdgePlan,
	noteEdgeRender,
	planEligibility,
	privatePlanKey,
	readEdgePlan,
	readRedirectPlan,
	redirectPlanBody,
	rememberCsrf,
	rememberRoles,
	runEdgePlan,
	shouldCheckKv,
	storeEdgePlan,
	withDeadline,
	writeEdgePlan,
	type PlanTier
} from '../ops/edge-plan';
import { sessionCsrf } from '../ops/render-plan';
import type { AuthState, FrontContext, Learned, PlanRead } from './types';

/** Answers an authenticated page from a compiled plan with no object hop, or says why not. */
export async function readPlanTier(f: FrontContext, auth: AuthState): Promise<Response | PlanRead> {
	const { request, env, t0, site, path, serving, defer } = f;
	const { personalised, mode: authMode } = auth;
	// #region compiled plans, answered from THIS isolate with no object hop
	// the only tier that answers an authenticated page with no hop (keyed on role set, not cookie)
	const planCookie = request.headers.get('cookie') ?? '';
	// the role set the object last reported for this cookie; unknown skips the tier and the hop
	// teaches it
	const planRoles = planCookie === '' ? undefined : believedRoles(planCookie, t0);
	// a write queues a Drupal message a plan compiled without one would drop, so spend the
	// session's agreement (it costs one render)
	if (request.method !== 'GET' && request.method !== 'HEAD') forgetWitness(planCookie);
	const planWanted = serving && personalised && request.method === 'GET' && edgePlanEnabled(env);
	let planTier: PlanTier = planWanted ? 'miss' : 'skip:not-wanted';
	if (planWanted) {
		const planGeneration = believedGeneration(site, t0);
		if (planGeneration === undefined) {
			// this isolate has not learned a generation recently enough to fence a plan against;
			// the object's answer below teaches it one
			planTier = 'skip:generation-unknown';
		} else if (planRoles === undefined) {
			planTier = 'skip:roles-unknown';
		} else {
			const planKey = edgePlanKey(site, planGeneration, planRoles, path);
			let held = lookupEdgePlan(planKey, Date.now(), planCookie);
			let from: PlanTier = 'mem';
			// the private plan is consulted second so the shared key still sees a second witness
			if (held === undefined) {
				const own = privatePlanKey(planKey, planCookie);
				held = lookupEdgePlan(own, Date.now(), planCookie);
				if (held !== undefined) from = 'private';
			}
			// kv read at most once per key, bounded by `COLD_READ_DEADLINE_MS` (a cold key costs
			// 46-140 ms against 5-6 warm)
			if (held === undefined && shouldCheckKv(planKey)) {
				const read = readEdgePlan(env, site, planGeneration, planRoles, path);
				const arrived = await withDeadline(read);
				if (arrived !== undefined) {
					storeEdgePlan(planKey, arrived);
					// not yet agreed with by this visitor, so store it and still hop (serving it
					// would defeat the per-session proof)
					from = 'kv';
				} else {
					// a read that missed the deadline still warms this isolate for the next request
					const key = planKey;
					defer(read.then((late) => late && storeEdgePlan(key, late)));
				}
			}
			const html =
				held === undefined ? undefined : runEdgePlan(held, believedCsrf(planCookie, t0));
			const jump = html === undefined ? undefined : readRedirectPlan(html);
			// per-user: no shared cache between here and the browser may store it
			const planReply = (body: string | null, status: number, head: Record<string, string>) =>
				new Response(body, {
					status,
					headers: {
						...head,
						'cache-control': 'private, no-store',
						'x-cfw-cache': 'PLAN',
						'x-cfw-plan': from,
						'x-cfw-generation': String(planGeneration),
						[AUTH_MODE_HEADER]: authMode,
						'x-worker-ms': String(Date.now() - t0)
					}
				});
			// `/user` is a 302 to `/user/<uid>` and was the only profile the tier could not
			// answer; see `redirectPlanBody()` for why this is safe under the private key
			if (jump !== undefined)
				return planReply(null, jump.status, { location: jump.location });
			if (html !== undefined) {
				return planReply(html, 200, { 'content-type': 'text/html; charset=UTF-8' });
			}
			// report refused so a path that left the tier reads differently from one about to join
			if (edgePlanRefused(planKey) || edgePlanRefused(privatePlanKey(planKey, planCookie))) {
				planTier = 'refused';
			}
		}
	}
	// #endregion
	return { cookie: planCookie, wanted: planWanted, tier: planTier };
}

/** Compiles a plan out of a personalised render, behind `waitUntil`; returns the tier to report. */
export function compilePlan(
	f: FrontContext,
	auth: AuthState,
	plan: PlanRead,
	res: Response,
	learned: Learned
): PlanTier {
	const { request, env, site, path, defer } = f;
	const { personalised } = auth;
	const { cookie: planCookie, wanted: planWanted } = plan;
	const { doCache, generation: doGeneration } = learned;
	let planTier = plan.tier;
	// #region compiling a plan out of the render that just happened
	// the compile runs behind `waitUntil` so the request does not wait on its CPU
	const eligible = planEligibility({
		method: request.method,
		status: res.status,
		doCache,
		contentType: res.headers.get('content-type') ?? undefined,
		setCookie: res.headers.getSetCookie(),
		personalised,
		generation: doGeneration,
		cookie: planCookie,
		location: res.headers.get('location') ?? undefined
	});
	// roles come from the response so a client cannot present its own (the compile keys on them)
	const reportedRoles = res.headers.get(ROLES_HEADER) ?? '';
	if (planCookie !== '' && reportedRoles !== '') {
		rememberRoles(planCookie, reportedRoles, Date.now());
	}
	if (planWanted && !eligible.ok) planTier = eligible.reason as PlanTier;
	if (planWanted && eligible.ok && doGeneration !== undefined && reportedRoles !== '') {
		// keyed on what the object reported (the beliefs above may be a window behind)
		const key = edgePlanKey(site, doGeneration, reportedRoles, path);
		// cloned now, read later: the body below is returned to the caller and a clone taken after
		// that has been consumed is empty
		const copy = res.clone();
		const generationForPlan = doGeneration;
		const rolesForPlan = reportedRoles;
		const witness = planCookie;
		planTier = 'sampling';
		// a redirect has no body; its whole content is the status and the target, expressed as a
		// body so the compiler's proofs run on it unchanged
		const jump = res.headers.get('location');
		const asPlanBody =
			isRedirectStatus(res.status) && jump !== null
				? Promise.resolve(redirectPlanBody(res.status, jump))
				: copy.text();
		defer(
			asPlanBody
				.then((html) => {
					// the csrf slot value cannot be generated here; keep the session's own
					rememberCsrf(witness, sessionCsrf(html), Date.now());
					// the cookie is the witness (two sessions must agree before a plan is stored)
					const compiled = noteEdgeRender(key, path, html, Date.now(), witness);
					if (compiled === undefined) {
						// a lone session gets a private plan (skipped once a shared one serves)
						if (!hasEdgePlan(key)) {
							noteEdgeRender(
								privatePlanKey(key, witness),
								path,
								html,
								Date.now(),
								witness,
								true
							);
						}
						return undefined;
					}
					return writeEdgePlan(
						env,
						site,
						generationForPlan,
						rolesForPlan,
						path,
						compiled
					);
				})
				.catch(() => undefined)
		);
	}
	// #endregion
	return planTier;
}
