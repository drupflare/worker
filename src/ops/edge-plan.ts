/**
 * Compiled render plans answered by the front worker, with no Durable Object hop.
 *
 * An authenticated page cannot use `caches.default` or the KV page tier (both are keyed without a
 * user). Every tier outside the isolate costs 5-12 ms (the object hop 12); isolate memory costs 0.
 *
 * Why serving a plan is safe:
 *
 * 1. A plan is compiled from two different sessions of one role set and served only to a session
 *    whose own live render has agreed with it. Anything constant for one user and different for
 *    another varies between the samples, so the compiler names an unknown slot and
 *    {@link unservableSlots} refuses the plan. The per-session agreement in {@link lookupEdgePlan}
 *    is unconditional: the two-session proof cannot see a third user whose shared region differs.
 * 2. The plan must reproduce both renders byte for byte ({@link planExplainsBoth}), hold no slot it
 *    cannot generate and survive {@link generatorAgrees}.
 * 3. The generation is in the key, so a content invalidation drops every plan at once.
 * 4. The structural refusals mirror `putPage()`: GET, 200, HTML, a real render, and no changed
 *    session cookie.
 *
 * Private fallback: a site with one editor never gets two sessions, so two renders of the same
 * session compile a plan under {@link privatePlanKey}, served to that session only. Every other
 * refusal still runs. It is never mirrored to KV and is compiled only while the shared key has no
 * serving plan.
 *
 * Not covered: staleness up to {@link GENERATION_TRUST_MS} for a bump made elsewhere, and a message
 * Drupal queued for the visitor's next page (a plan compiled from renders without it would omit it;
 * {@link forgetWitness} drops that session's agreement on any non-GET).
 *
 * Session lifetime: Drupal can end a session under a cookie the client keeps sending.
 * {@link rememberRoles} records what the object reported per cookie, and {@link PLAN_TTL_MS} stops
 * the plan serving until a live render agrees again (once a minute, not once per request).
 * @module
 */

import { pageKvEnabled, planKvWritesEnabled, type PageKv, type PageStoreEnv } from './page-store';
import {
	compilePlan,
	fillSlots,
	generatorAgrees,
	planExplainsBoth,
	runPlan,
	sessionCsrf,
	unservableSlots,
	type RenderPlan
} from './render-plan';

/** how long an isolate serves plans against a generation it learned, in ms */
export const GENERATION_TRUST_MS = 10_000;

/**
 * How long a compiled plan serves before one live render has to agree with it again, in ms.
 *
 * It bounds how long an ended session keeps being answered from a plan, so it is a security
 * parameter. Revalidation costs one render, not the three a compile costs.
 */
export const PLAN_TTL_MS = 60_000;

/**
 * Whether the tier runs at all: on unless an operator sets `0`, on both plans.
 *
 * It is on `KV_OVERRIDABLE` because turning it off only costs the object hop.
 */
export function edgePlanEnabled(env?: { EDGE_PLAN?: string }): boolean {
	const set = env?.EDGE_PLAN;
	if (set !== undefined && String(set) !== '') return String(set) === '1';
	return true;
}

/**
 * Renders kept for one key before a compile is attempted.
 *
 * Three, because a route's first render warms Drupal's asset library cache and misaligns the
 * regions behind the stylesheet list (8 of 124 routes servable, against 123 from renders 3 and 4).
 * Sample 0 is discarded.
 */
export const SAMPLES_PER_COMPILE = 3;

/**
 * Compiles the proofs may refuse for one key before it stops trying.
 *
 * One unlucky pair of renders can refuse (an `H:i` timestamp crossing a minute, a queue count, a
 * message varies and is not a slot), so a single refusal must not latch for the generation:
 * `/admin/content` on `wrangler dev` is 12.6-17.9 req/s unserved against 221-400 req/s served.
 *
 * It stays bounded, since a page that varies every render would otherwise spend a diff every third
 * render forever.
 */
export const PLAN_COMPILE_ATTEMPTS = 3;

/** how many keys one isolate holds (a clear is cheaper than an LRU, as with `genMemo`) */
export const EDGE_PLAN_ENTRIES = 64;

/** ceiling on the bytes those keys hold, against a 128 MB isolate */
export const EDGE_PLAN_BYTES = 8_388_608;

/** seconds a plan lives in KV; it is generation-keyed, so this is a floor on garbage */
export const EDGE_PLAN_KV_TTL_S = 300;

/** which tier answered, reported on `x-cfw-plan` so a measurement can tell them apart */
export type PlanTier =
	'mem' | 'private' | 'kv' | 'miss' | 'sampling' | 'compiled' | 'refused' | `skip:${string}`;

type Entry = {
	plan?: RenderPlan;
	/** renders seen for this key; cleared once a compile has been attempted */
	samples: string[];
	/** which session produced each sample, positionally; see {@link noteEdgeRender} */
	witnesses: string[];
	/** sessions whose own live render has agreed with the stored plan */
	agreed: Set<string>;
	bytes: number;
	/** compiles the proofs have refused for this key; see {@link PLAN_COMPILE_ATTEMPTS} */
	refusals?: number;
	/** keyed to one session rather than to a role set; see {@link privatePlanKey} */
	owned?: boolean;
	/** whether the cold-isolate tier has already been consulted for this key */
	kvChecked?: boolean;
	/** when the plan stops serving until a live render agrees with it again */
	provenUntil?: number;
};

const store = new Map<string, Entry>();
let heldBytes = 0;

/** what this isolate last learned about a site's generation, and when */
const genSeen = new Map<string, { gen: number; at: number }>();

/** the role set this isolate last saw a Durable Object report for a session, and when */
const roleSeen = new Map<string, { roles: string; at: number }>();

/** the CSRF token this isolate last saw in a render for a session, and when */
const csrfSeen = new Map<string, { token: string; at: number }>();

/** drops everything this isolate holds; tests use it, and so does an explicit refresh */
export function resetEdgePlans(): void {
	store.clear();
	genSeen.clear();
	roleSeen.clear();
	csrfSeen.clear();
	heldBytes = 0;
}

/** how many keys, bytes and compiled plans this isolate holds */
export function edgePlanStats(): { entries: number; bytes: number; plans: number } {
	let plans = 0;
	for (const e of store.values()) if (e.plan) plans++;
	return { entries: store.size, bytes: heldBytes, plans };
}

/**
 * The isolate-local key: site, generation, role set and path.
 *
 * It is the role set, not the cookie: a cookie key held one plan per session per path (200 users
 * over 50 paths is 10,000 keys against about 150) and every first use was a cold KV read (46-140 ms
 * against 4-5 warm). The narrower key is safe because of {@link noteEdgeRender}: two different
 * sessions must produce the plan and each session must agree with it before being served.
 */
export function edgePlanKey(site: string, generation: number, roles: string, path: string): string {
	return `${site} ${generation} ${roles} ${path}`;
}

/**
 * The same key narrowed to one session, for the private fallback.
 *
 * Isolate-local only, never a KV key (`roleSeen` already holds raw cookies here, and
 * {@link writeEdgePlan} takes only a shared key).
 */
export function privatePlanKey(key: string, witness: string): string {
	return `${key} @${witness}`;
}

/** how long this isolate trusts a role set it learned from a Durable Object response */
export const ROLE_TRUST_MS = 60_000;

/**
 * The role set as one key component.
 *
 * The object sorts the roles before they leave, so this only joins. Empty means unknown: do not key
 * a plan yet.
 */
export function roleFingerprint(roles: readonly string[] | null | undefined): string {
	if (!Array.isArray(roles) || roles.length === 0) return '';
	return roles.join(',');
}

/**
 * Records the role set a Durable Object reported for a session.
 *
 * It is read off the object's own response, never the request, so it needs no signature (a client
 * presents a cookie, not a role set). A role change, logout or password change moves what the
 * object reports for that cookie, and the key moves with it.
 */
export function rememberRoles(cookie: string, roles: string, nowMs: number): void {
	if (roles === '') return;
	if (roleSeen.size > 256) roleSeen.clear();
	roleSeen.set(cookie, { roles, at: nowMs });
}

/** the role set this isolate may key on for a session, or undefined when it has not learned one */
export function believedRoles(cookie: string, nowMs: number): string | undefined {
	const seen = roleSeen.get(cookie);
	if (!seen) return undefined;
	return nowMs - seen.at < ROLE_TRUST_MS ? seen.roles : undefined;
}

/**
 * Records the session CSRF token a render carried, so a shared plan can substitute it.
 *
 * The token is the one slot value the front worker cannot generate. Like the role set it is learned
 * from the object's own render for this cookie, never the request. Someone else's token would be
 * inert (Drupal refuses it) but break the logout link, so the value is per session.
 */
export function rememberCsrf(cookie: string, token: string | undefined, nowMs: number): void {
	if (token === undefined || cookie === '') return;
	if (csrfSeen.size > 256) csrfSeen.clear();
	csrfSeen.set(cookie, { token, at: nowMs });
}

/** the token this isolate may fill a slot with for a session, or undefined if none is known */
export function believedCsrf(cookie: string, nowMs: number): string | undefined {
	const seen = csrfSeen.get(cookie);
	if (!seen) return undefined;
	return nowMs - seen.at < ROLE_TRUST_MS ? seen.token : undefined;
}

/**
 * 128 bits of SHA-256 over a key component, so a session token never reaches a listable namespace.
 *
 * It is applied to the role set, which is not a credential; the shared tier is keyed like the
 * isolate-local one so the two cannot disagree about what a plan is for.
 */
export async function cookieFingerprint(cookie: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cookie));
	let out = '';
	for (const b of new Uint8Array(digest).slice(0, 16)) out += b.toString(16).padStart(2, '0');
	return out;
}

/** the shared-tier KV key for a plan, keyed on the hashed role set */
export function edgePlanKvKey(
	site: string,
	generation: number,
	fingerprint: string,
	path: string
): string {
	return `plan:${site}:${generation}:${fingerprint}:${path}`;
}

/** records a generation this isolate learned from a Durable Object response */
export function rememberEdgeGeneration(site: string, generation: number, nowMs: number): void {
	if (genSeen.size > 64) genSeen.clear();
	genSeen.set(site, { gen: generation, at: nowMs });
}

/**
 * The generation this isolate may serve against, or undefined when it does not know one.
 *
 * Undefined past {@link GENERATION_TRUST_MS}, which bounds staleness: the request falls through to
 * the object, whose response teaches this isolate the current generation again.
 */
export function believedGeneration(site: string, nowMs: number): number | undefined {
	const seen = genSeen.get(site);
	if (!seen || nowMs - seen.at >= GENERATION_TRUST_MS) return undefined;
	return seen.gen;
}

function evict(): void {
	while (store.size > EDGE_PLAN_ENTRIES || heldBytes > EDGE_PLAN_BYTES) {
		// private entries go first (one session each; insertion order alone would let a burst of
		// them evict the shared plans carrying the traffic)
		let victim: string | undefined;
		for (const [k, e] of store) {
			if (e.owned) {
				victim = k;
				break;
			}
		}
		if (victim === undefined) {
			const oldest = store.keys().next();
			if (oldest.done) break;
			victim = oldest.value;
		}
		heldBytes -= store.get(victim)?.bytes ?? 0;
		store.delete(victim);
	}
}

function entryFor(key: string, owned = false): Entry {
	let entry = store.get(key);
	if (!entry) {
		entry = { samples: [], witnesses: [], agreed: new Set(), bytes: 0, owned };
		store.set(key, entry);
		evict();
	}
	return entry;
}

/**
 * The plan for this key, or undefined when it has none or has not been proved recently enough.
 *
 * An expired entry keeps its plan: {@link noteEdgeRender} re-proves it against the next live render
 * for one render rather than the three a fresh compile costs.
 */
export function lookupEdgePlan(
	key: string,
	nowMs: number = Date.now(),
	witness?: string
): RenderPlan | undefined {
	const entry = store.get(key);
	if (!entry?.plan) return undefined;
	if (nowMs >= (entry.provenUntil ?? 0)) return undefined;
	// per-session proof, unconditional: the two-session agreement cannot see a third user whose
	// shared region differs (an unread count, a per-user block that is not a placeholder)
	if (witness !== undefined && !entry.agreed.has(witness)) return undefined;
	return entry.plan;
}

/** whether a plan is serving under this key at all, whoever it is for */
export function hasEdgePlan(key: string, nowMs: number = Date.now()): boolean {
	const entry = store.get(key);
	return entry?.plan !== undefined && nowMs < (entry.provenUntil ?? 0);
}

/**
 * Whether this key has spent its compile attempts and will not try again.
 *
 * Reported so a latched refusal differs from sampling on `x-cfw-plan` (an 18x throughput gap).
 */
export function edgePlanRefused(key: string): boolean {
	return (store.get(key)?.refusals ?? 0) >= PLAN_COMPILE_ATTEMPTS;
}

/**
 * Drops what a session has proven, and every plan compiled for it alone.
 *
 * Called on a non-GET (the only thing that queues a Drupal message for the next page): the session
 * owes a live render before any plan answers it again, and that render carries the message. A
 * shared plan survives for everybody else.
 */
export function forgetWitness(cookie: string): void {
	if (cookie === '') return;
	for (const [key, entry] of store) {
		if (entry.owned && key.endsWith(` @${cookie}`)) {
			heldBytes -= entry.bytes;
			store.delete(key);
			continue;
		}
		entry.agreed.delete(cookie);
	}
}

/** whether the cold-isolate tier is worth consulting for this key; true at most once per key */
export function shouldCheckKv(key: string): boolean {
	const entry = entryFor(key);
	if (entry.kvChecked || entry.plan || edgePlanRefused(key)) return false;
	entry.kvChecked = true;
	return true;
}

/** installs a plan that arrived from KV or was compiled here */
export function storeEdgePlan(
	key: string,
	plan: RenderPlan,
	nowMs: number = Date.now(),
	owned = false
): void {
	const entry = entryFor(key, owned);
	heldBytes -= entry.bytes;
	entry.plan = plan;
	entry.samples = [];
	entry.witnesses = [];
	entry.agreed.clear();
	entry.bytes = planBytes(plan);
	entry.provenUntil = nowMs + PLAN_TTL_MS;
	heldBytes += entry.bytes;
	evict();
}

function planBytes(plan: RenderPlan): number {
	let n = 0;
	for (const op of plan.ops) if (op[0] === 't') n += op[1].length;
	return n;
}

/**
 * Whether a live render still agrees with a plan.
 *
 * It re-diffs as {@link generatorAgrees} does: the plan's output for fresh slot values is compiled
 * against Drupal's render and may differ only where the plan has slots. A changed page, or an ended
 * session now rendering as somebody else, moves a constant.
 */
function stillAgrees(plan: RenderPlan, html: string): boolean {
	// the token is from the render being checked (the session's own)
	const values = fillSlots(plan, { csrf: sessionCsrf(html) });
	if (values === undefined) return false;
	const generated = runPlan(plan, values);
	if (generated === html) return true;
	const again = compilePlan(generated, html, plan.path);
	return (
		unservableSlots(again).length === 0 &&
		Object.keys(again.slots).length === Object.keys(plan.slots).length
	);
}

/**
 * Records one render, and compiles or re-proves against it.
 *
 * The proofs run here, not at serve time, so a stored plan has already reproduced both renders. A
 * refusal is remembered (a moved generation gives another go) so a hopeless compile does not spend
 * CPU on every render.
 *
 * A plan past {@link PLAN_TTL_MS} is re-proved against this render (one render, not three); one
 * that stops agreeing is dropped and sampling restarts.
 *
 * `owned` marks a key that names one session ({@link privatePlanKey}); it drops only the
 * two-witness requirement, which has no work to do when nobody else is served from the key.
 *
 * @returns the plan when this render completed a compile, so the caller can mirror it to KV;
 *   undefined for a re-proof (KV already holds it) and for a private plan (never mirrored)
 */
export function noteEdgeRender(
	key: string,
	path: string,
	html: string,
	nowMs: number = Date.now(),
	witness = '',
	owned = false
): RenderPlan | undefined {
	const entry = entryFor(key, owned);
	if (entry.plan) {
		// an agreed session costs nothing inside the proof window (one re-diff a minute); one that
		// has not agreed is worth a diff, since `lookupEdgePlan()` will not serve it until it does
		const owed = witness !== '' && !entry.agreed.has(witness);
		if (!owed && nowMs < (entry.provenUntil ?? 0)) return undefined;
		if (stillAgrees(entry.plan, html)) {
			// the session's own render now agrees, which `lookupEdgePlan()` requires
			if (witness !== '') entry.agreed.add(witness);
			if (nowMs >= (entry.provenUntil ?? 0)) entry.provenUntil = nowMs + PLAN_TTL_MS;
			return undefined;
		}
		// a disagreement drops the plan for everyone (the shared region is not shared)
		heldBytes -= entry.bytes;
		entry.plan = undefined;
		entry.bytes = 0;
		entry.provenUntil = 0;
		entry.agreed.clear();
	}
	if ((entry.refusals ?? 0) >= PLAN_COMPILE_ATTEMPTS) return undefined;
	entry.samples.push(html);
	entry.witnesses.push(witness);
	if (entry.samples.length < SAMPLES_PER_COMPILE) return undefined;

	// sample 0 is the asset-library warm-up and is discarded; see SAMPLES_PER_COMPILE
	const a = entry.samples[SAMPLES_PER_COMPILE - 2] as string;
	const b = entry.samples[SAMPLES_PER_COMPILE - 1] as string;
	const wa = entry.witnesses[SAMPLES_PER_COMPILE - 2] ?? '';
	const wb = entry.witnesses[SAMPLES_PER_COMPILE - 1] ?? '';
	entry.samples = [];
	entry.witnesses = [];
	// two different sessions are required (one session's per-user region, such as the toolbar
	// name, would be a constant served to the whole role set); keep the samples and wait
	if (wa === '' || wb === '' || (wa === wb && !owned)) {
		entry.samples = [a, b];
		entry.witnesses = [wa, wb];
		return undefined;
	}
	const plan = compilePlan(a, b, path);
	if (
		unservableSlots(plan).length > 0 ||
		!planExplainsBoth(plan, a, b) ||
		!generatorAgrees(plan)
	) {
		entry.refusals = (entry.refusals ?? 0) + 1;
		return undefined;
	}
	storeEdgePlan(key, plan, nowMs, owned);
	// both sessions that produced it have agreed with it by construction
	entry.agreed.add(wa);
	entry.agreed.add(wb);
	// a private plan is never mirrored
	return owned ? undefined : plan;
}

/** this request's page, or undefined when the plan holds a slot it cannot fill */
export function runEdgePlan(plan: RenderPlan, csrf?: string): string | undefined {
	const values = fillSlots(plan, { csrf });
	if (values === undefined) return undefined;
	return runPlan(plan, values);
}

/** `name=value` pairs from a `Cookie` header, ignoring anything malformed */
function readCookieJar(header: string): Map<string, string> {
	const jar = new Map<string, string>();
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq <= 0) continue;
		jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
	}
	return jar;
}

/**
 * Whether a response changes any cookie the request arrived with.
 *
 * Mere presence of `Set-Cookie` is the wrong test: PHP re-emits the session cookie on every
 * `session_start()` while `session.cookie_lifetime` is non-zero (Drupal ships 2000000), so every
 * authenticated response carries one equal to the request's. A re-send cannot change whose key this
 * is; a new value or a deletion (login, logout, session regeneration) can, and refuses.
 */
export function rotatesSession(cookie: string, setCookie: readonly string[]): boolean {
	if (setCookie.length === 0) return false;
	const jar = readCookieJar(cookie);
	for (const line of setCookie) {
		const pair = line.split(';', 1)[0] ?? '';
		const eq = pair.indexOf('=');
		if (eq <= 0) return true;
		const name = pair.slice(0, eq).trim();
		if (jar.get(name) !== pair.slice(eq + 1).trim()) return true;
	}
	return false;
}

/**
 * A redirect expressed as the body the plan compiler already knows how to diff.
 *
 * `/user` is a 302 to `/user/<uid>` that rendered on every request (`x-worker-ms` 68.1 / 76.5 /
 * 226.9 at c=1 / 4 / 16 against a localhost VPS's 5 / 6 / 83). Synthesising the redirect into a
 * body reuses every existing guard: disagreeing renders refuse, the generation fences the key, the
 * session must agree, and `forgetWitness()` spends that on a write. A per-user `Location` differs
 * across sessions, so a shared plan refuses it and only the private key serves it.
 *
 * It is NUL-prefixed so no HTML render can be mistaken for it.
 */
export const REDIRECT_PLAN_PREFIX = '\u0000cfw-redirect\n';

/** the statuses a redirect plan may hold; a 304 carries no Location and is not one */
export function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** the plan body for a redirect */
export function redirectPlanBody(status: number, location: string): string {
	return `${REDIRECT_PLAN_PREFIX}${status}\n${location}`;
}

/** the status and target a redirect plan holds, or undefined when the plan is an ordinary page */
export function readRedirectPlan(body: string): { status: number; location: string } | undefined {
	if (!body.startsWith(REDIRECT_PLAN_PREFIX)) return undefined;
	const [status, ...rest] = body.slice(REDIRECT_PLAN_PREFIX.length).split('\n');
	const code = Number(status);
	const location = rest.join('\n');
	if (!isRedirectStatus(code) || location === '') return undefined;
	return { status: code, location };
}

/** what a response has to be before a plan may be compiled from it */
export interface PlanEligibilityInput {
	method: string;
	status: number;
	/** the object's own `x-cfw-cache` verdict */
	doCache: string;
	contentType?: string;
	/** every `Set-Cookie` line the response carries, compared against the request's own jar */
	setCookie: readonly string[];
	personalised: boolean;
	generation?: number;
	cookie: string;
	/** the `Location` header, when the response is a redirect; see {@link REDIRECT_PLAN_PREFIX} */
	location?: string;
}

/**
 * Whether one render may become a plan.
 *
 * The refusals of `putPage()` plus two: a request with no cookie identifies nobody, and an
 * anonymous request is already served by cheaper tiers.
 */
export function planEligibility(
	input: PlanEligibilityInput
): { ok: true } | { ok: false; reason: string } {
	if (input.method !== 'GET') return { ok: false, reason: `skip:${input.method.toLowerCase()}` };
	if (!input.personalised) return { ok: false, reason: 'skip:not-personalised' };
	if (input.cookie === '') return { ok: false, reason: 'skip:no-cookie' };
	const redirect = isRedirectStatus(input.status) && (input.location ?? '') !== '';
	if (input.status !== 200 && !redirect) return { ok: false, reason: `skip:${input.status}` };
	// `VERIFY` and `ASSEMBLED` are the shell tier: compiling them away saves the object hop and
	// the fragment render (the compile needs `x-cfw-roles`, which shell responses carry)
	if (
		input.doCache !== 'HIT' &&
		input.doCache !== 'RENDER' &&
		input.doCache !== 'VERIFY' &&
		input.doCache !== 'ASSEMBLED'
	) {
		return { ok: false, reason: `skip:${input.doCache}` };
	}
	if (input.generation === undefined) return { ok: false, reason: 'skip:no-generation' };
	// a rotated session ends the key's meaning; a re-sent cookie does not
	if (rotatesSession(input.cookie, input.setCookie)) {
		return { ok: false, reason: 'skip:set-cookie' };
	}
	// a redirect has no body to be HTML, and its whole content is the status and the Location
	if (!redirect && !(input.contentType ?? '').toLowerCase().includes('text/html')) {
		return { ok: false, reason: 'skip:not-html' };
	}
	return { ok: true };
}

/** the bindings the shared plan tier reads */
export type EdgePlanEnv = PageStoreEnv & { PAGE_KV?: PageKv };

/**
 * How long a cold-isolate read may sit in front of the object, in ms.
 *
 * A KV get costs 46-140 ms the first time a colo sees a key (hit or miss) and 4-5 ms after
 * (deployed paid, n=20 per arm), and a never-compiled plan key is always new, so an unbounded read
 * would put ~78 ms in front of a 12 ms object hop. 8 ms is above the warm read and far below the
 * cold one.
 */
export const COLD_READ_DEADLINE_MS = 8;

/**
 * Resolves `p`, or undefined once the deadline passes.
 *
 * A KV get cannot be cancelled, so the caller hands the late read to `waitUntil` and its answer
 * still warms this isolate.
 */
export function withDeadline<T>(p: Promise<T>, ms = COLD_READ_DEADLINE_MS): Promise<T | undefined> {
	return Promise.race([
		p,
		new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))
	]);
}

/**
 * Reads a plan compiled by another isolate, or undefined.
 *
 * It serves an isolate that knows the generation and has not seen this page, and is worth having
 * only inside {@link COLD_READ_DEADLINE_MS} (4-5 ms warm against the object's 12). It never throws;
 * an unreadable record is a miss.
 */
export async function readEdgePlan(
	env: EdgePlanEnv | undefined,
	site: string,
	generation: number,
	roles: string,
	path: string
): Promise<RenderPlan | undefined> {
	if (!pageKvEnabled(env) || !env?.PAGE_KV) return undefined;
	try {
		const raw = await env.PAGE_KV.get(
			edgePlanKvKey(site, generation, await cookieFingerprint(roles), path),
			'text'
		);
		if (raw === null) return undefined;
		const parsed = JSON.parse(raw) as RenderPlan;
		if (!Array.isArray(parsed?.ops) || typeof parsed?.slots !== 'object') return undefined;
		// the proofs are re-applied on the way in: a record this isolate did not compile is input
		if (unservableSlots(parsed).length > 0 || !generatorAgrees(parsed)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/**
 * Mirrors a plan so another isolate does not have to compile it.
 *
 * The caller defers it with `ctx.waitUntil` (an awaited 97 KB write costs 12.5 ms before the
 * response leaves; deferred it costs 0).
 */
export async function writeEdgePlan(
	env: EdgePlanEnv | undefined,
	site: string,
	generation: number,
	roles: string,
	path: string,
	plan: RenderPlan
): Promise<boolean> {
	if (!planKvWritesEnabled(env) || !env?.PAGE_KV) return false;
	try {
		await env.PAGE_KV.put(
			edgePlanKvKey(site, generation, await cookieFingerprint(roles), path),
			JSON.stringify(plan),
			{ expirationTtl: EDGE_PLAN_KV_TTL_S }
		);
		return true;
	} catch {
		return false;
	}
}
