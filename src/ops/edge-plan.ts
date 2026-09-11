import { pageKvEnabled, type PageKv, type PageStoreEnv } from './page-store.js';
import {
	compilePlan,
	fillSlots,
	generatorAgrees,
	planExplainsBoth,
	runPlan,
	sessionCsrf,
	unservableSlots,
	type RenderPlan
} from './render-plan.js';

/**
 * Compiled render plans answered by the front worker, with no Durable Object hop.
 *
 * ## Why this tier exists at all
 *
 * Measured on deployed paid workers: every tier the front worker can reach outside its own isolate
 * costs 5-12 ms, and the Durable Object hop is 12 of them for a payload-independent round trip.
 * Isolate memory costs 0. An authenticated page cannot use `caches.default` or the KV page tier --
 * both are keyed without a user and this project has already shipped one uid-1 leak into the
 * anonymous cache -- so the DO hop was the whole bill for an authenticated view.
 *
 * ## Why serving one is safe, which is the part that must not be got wrong
 *
 * Four properties, and the first is the load-bearing one:
 *
 * 1. **THE PLAN IS COMPILED FROM TWO DIFFERENT SESSIONS OF THE SAME ROLE SET, AND SERVED ONLY TO A
 *    SESSION THAT HAS SINCE AGREED WITH IT.** This used to be "the key carries the visitor's own
 *    cookie header", which was structurally airtight and also held one plan per session per path --
 *    the combinatorial cache the tier exists to avoid, with every first use paying a 46-140 ms cold
 *    KV read. Compiled across two sessions instead, anything that is constant for one user and
 *    different for another varies between the samples, so the compiler names it an unknown slot and
 *    {@link unservableSlots} refuses the plan rather than baking one user's toolbar into it. The
 *    per-session agreement in {@link lookupEdgePlan} is the other half and is unconditional: the
 *    two-session proof is a statement about two people, and a third whose shared region differs is
 *    exactly what it cannot see. That is the same reasoning `verifyShellFor()` applies in the shell
 *    tier, which has needed it since it shipped.
 * 2. **The plan is a differential proof that nothing else on the page varies.** It must reproduce
 *    both renders byte for byte ({@link planExplainsBoth}), hold no slot it cannot generate
 *    ({@link unservableSlots}) and survive {@link generatorAgrees}. A single-render byte cache has
 *    no such proof; anything that varies and is not a recognised slot makes the compile refuse.
 * 3. **The generation is in the key**, the same fence `pageKey()` and `pageKvKey()` already use, so
 *    a content invalidation drops every plan at once with nothing to enumerate.
 * 4. **The structural refusals mirror `putPage()`**: GET only, 200 only, HTML only, a real render
 *    rather than a warming placeholder, and never a response carrying `Set-Cookie` -- which is both
 *    a session rotation and the marker that the key is about to stop being this visitor's.
 *
 * ## The private fallback, for a site that can never produce a second witness
 *
 * A shared plan needs two DIFFERENT sessions of a role set to agree, so a site with one editor never
 * compiles one and pays the object hop on every authenticated view -- the case where the hop is least
 * amortised gets the least help. Two renders of the SAME session prove nothing about another user and
 * everything about that one, so they compile a plan under {@link privatePlanKey} that is served to
 * that session and to nobody else.
 *
 * The two-session requirement exists to stop one user's toolbar reaching another's page. A key that
 * names the session cannot do that, so dropping the requirement under that key removes no proof. What
 * survives unchanged is every OTHER refusal: {@link unservableSlots}, {@link planExplainsBoth} and
 * {@link generatorAgrees} all still run, so a form build id or an unrecognised varying region refuses
 * the plan exactly as it does for a shared one.
 *
 * Two things bound it. A private plan is never mirrored to KV, so the combinatorial cache the role key
 * exists to avoid stays out of the shared namespace; and it is compiled only while the shared key has
 * no serving plan, so a page two sessions have already agreed on never pays for one.
 *
 * ## What it does NOT protect against
 *
 * Staleness bounded by {@link GENERATION_TRUST_MS}. An isolate serves against the last generation it
 * learned, and it learns one from every Durable Object response, so a bump made by this visitor is
 * seen immediately and a bump made elsewhere within that window.
 *
 * A message Drupal queued for the visitor's NEXT page. A save sets one in the session and it renders
 * once, so a plan compiled from two renders that carried none serves a page missing it. The shared
 * tier has the same exposure and rarely reaches a post-save page; a single editor reaches one every
 * time they save. {@link forgetWitness} is the guard: a non-GET drops that session's agreement, so its
 * next GET renders and the message arrives.
 *
 * ## The session's own lifetime
 *
 * Drupal can end a session under a cookie a client keeps sending -- a logout, an expiry, a blocked
 * account -- and neither the key nor the role set can see that on its own. Two things do.
 * {@link rememberRoles} records what the OBJECT reported for a cookie, so a session Drupal has
 * downgraded keys somewhere else on its next hop; and {@link PLAN_TTL_MS} stops the plan serving
 * until a live render agrees with it again, so a session that has changed costs a render whose
 * output no longer matches and the plan is dropped for everyone rather than only for that visitor.
 * That is the same revalidation the shell tier gets from rendering fragments on every request,
 * taken once per minute instead of once per request.
 */

/** how long an isolate serves plans against a generation it learned, in ms */
export const GENERATION_TRUST_MS = 10_000;

/**
 * How long a compiled plan serves before one live render has to agree with it again, in ms.
 *
 * The bound on how long a session Drupal has ended keeps being answered from a plan, so it is a
 * security parameter rather than a freshness one. Revalidation costs ONE render rather than the
 * three a compile costs, because the plan is kept across it and only re-proved.
 */
export const PLAN_TTL_MS = 60_000;

/**
 * Whether the tier runs at all. ON unless an operator says `0`, on both plans.
 *
 * On `KV_OVERRIDABLE` for the reason that list exists: the worst case of turning it off is a site
 * that pays the object hop it always paid, which is a slow site rather than a changed reachability.
 */
export function edgePlanEnabled(env?: { EDGE_PLAN?: string | null } | null): boolean {
	const set = env?.EDGE_PLAN;
	if (set !== undefined && set !== null && String(set) !== '') return String(set) === '1';
	return true;
}

/**
 * Renders kept for one key before a compile is attempted.
 *
 * THREE, because the first render of a route warms Drupal's asset library cache: renders 1 and 2
 * differ in their stylesheet list and every region behind it misaligns, which measured 8 of 124
 * routes servable against 123 from the third and fourth. Sample 0 is discarded.
 */
export const SAMPLES_PER_COMPILE = 3;

/**
 * Compiles the proofs may refuse for one key before it stops trying.
 *
 * ONE REFUSAL USED TO BE PERMANENT, and a single unlucky pair of renders is enough to produce one:
 * anything that varies between two consecutive renders and is not a recognised slot -- an `H:i`
 * timestamp crossing a minute, a queue count, a message -- makes the compiler name an unknown region
 * and refuse. Nothing cleared the latch until the generation moved, so the path paid a Durable
 * Object render on every authenticated view for the rest of that generation.
 *
 * Measured on `wrangler dev`, `/admin/content` in the two states: 12.6-17.9 req/s at p50 60-939 ms
 * when the tier is not answering, against 221-400 req/s at p50 4-38 ms when it is.
 *
 * Still BOUNDED, because the latch was protecting something real: a page that genuinely varies every
 * render would otherwise spend a diff every third render forever.
 */
export const PLAN_COMPILE_ATTEMPTS = 3;

/** how many keys one isolate holds; a clear is cheaper than an LRU, as with `genMemo` */
export const EDGE_PLAN_ENTRIES = 64;

/** and the ceiling on what they hold, against a 128 MB isolate */
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

export function edgePlanStats(): { entries: number; bytes: number; plans: number } {
	let plans = 0;
	for (const e of store.values()) if (e.plan) plans++;
	return { entries: store.size, bytes: heldBytes, plans };
}

/**
 * The isolate-local key.
 *
 * THE ROLE SET, not the cookie. Keyed on the cookie header this held one plan per session per path:
 * a site with 200 logged-in users over 50 authenticated paths reached 10,000 keys where
 * `role_sets x 50` is about 150, every first use of one was a cold KV read at 46-140 ms against
 * 4-5 warm, and a logout minted a fresh key -- so the widest key maximised the expensive case.
 * What makes the narrower one safe is in {@link noteEdgeRender}: a plan reaches the store only when
 * two DIFFERENT sessions of this role set produced it and the compiler found no region it could not
 * name, and it serves a session only once that session's own render has agreed with it.
 */
export function edgePlanKey(site: string, generation: number, roles: string, path: string): string {
	return `${site} ${generation} ${roles} ${path}`;
}

/**
 * The same key narrowed to one session, for the private fallback.
 *
 * Isolate-local only, and never a KV key: `roleSeen` already holds raw cookies in this isolate for
 * the same reason, and {@link writeEdgePlan} is only ever called with a shared key.
 */
export function privatePlanKey(key: string, witness: string): string {
	return `${key} @${witness}`;
}

/** how long this isolate trusts a role set it learned from a Durable Object response */
export const ROLE_TRUST_MS = 60_000;

/**
 * The role set as one key component.
 *
 * Sorted by the object before it leaves, so this only joins. Empty for a request whose role set is
 * unknown, which the caller treats as "do not key a plan yet" rather than as a role set of its own.
 */
export function roleFingerprint(roles: readonly string[] | null | undefined): string {
	if (!Array.isArray(roles) || roles.length === 0) return '';
	return roles.join(',');
}

/**
 * Records the role set a Durable Object reported for a session.
 *
 * READ OFF THE OBJECT'S OWN RESPONSE, never off the inbound request, which is what makes it
 * trustworthy without a signature: a client cannot present a role set at all, only a cookie, and it
 * is told what that cookie is. A role change, a logout and a password change all move what the
 * object reports for the same cookie, and the key moves with it.
 */
export function rememberRoles(cookie: string, roles: string, nowMs: number): void {
	if (roles === '') return;
	if (roleSeen.size > 256) roleSeen.clear();
	roleSeen.set(cookie, { roles, at: nowMs });
}

/** the role set this isolate may key on for a session, or null when it has not learned one */
export function believedRoles(cookie: string, nowMs: number): string | null {
	const seen = roleSeen.get(cookie);
	if (!seen) return null;
	return nowMs - seen.at < ROLE_TRUST_MS ? seen.roles : null;
}

/**
 * Records the session CSRF token a render carried, so a shared plan can substitute it.
 *
 * The token is what a shared plan holds a slot for, and it is the one slot value the front worker
 * cannot generate. Learned the same way the role set is -- out of the OBJECT'S OWN RENDER for this
 * cookie, never off the request -- so a client cannot present a token, it is told what its own is.
 * Serving a visitor a page carrying someone else's token would be inert rather than dangerous
 * (Drupal refuses it), but it would break their logout link, so the value is per session.
 */
export function rememberCsrf(cookie: string, token: string | null, nowMs: number): void {
	if (token === null || cookie === '') return;
	if (csrfSeen.size > 256) csrfSeen.clear();
	csrfSeen.set(cookie, { token, at: nowMs });
}

/** the token this isolate may fill a slot with for a session, or null when it has not learned one */
export function believedCsrf(cookie: string, nowMs: number): string | null {
	const seen = csrfSeen.get(cookie);
	if (!seen) return null;
	return nowMs - seen.at < ROLE_TRUST_MS ? seen.token : null;
}

/**
 * 128 bits of SHA-256 over a key component, so a session token never reaches a listable namespace.
 *
 * Applied to the ROLE SET now rather than to the cookie. The hash was never there to widen the key
 * -- it was there to keep a credential out of KV -- and the role set is not a credential, but the
 * shared tier is keyed the same way as the isolate-local one so the two cannot disagree about what
 * a plan is for.
 */
export async function cookieFingerprint(cookie: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cookie));
	let out = '';
	for (const b of new Uint8Array(digest).slice(0, 16)) out += b.toString(16).padStart(2, '0');
	return out;
}

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
 * The generation this isolate may serve against, or null when it does not know one.
 *
 * Null past {@link GENERATION_TRUST_MS}, which is what bounds staleness: the request then falls
 * through to the object, whose response teaches this isolate the current generation again.
 */
export function believedGeneration(site: string, nowMs: number): number | null {
	const seen = genSeen.get(site);
	if (!seen || nowMs - seen.at >= GENERATION_TRUST_MS) return null;
	return seen.gen;
}

function evict(): void {
	while (store.size > EDGE_PLAN_ENTRIES || heldBytes > EDGE_PLAN_BYTES) {
		// the oldest PRIVATE entry goes first. One serves a single session and a shared one serves a
		// whole role set, so evicting in insertion order alone lets a burst of one-off private keys
		// drop the plans carrying the traffic
		let victim: string | null = null;
		for (const [k, e] of store) {
			if (e.owned) {
				victim = k;
				break;
			}
		}
		if (victim === null) {
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
 * The plan for this key, or null when it has none or has not been proved recently enough.
 *
 * An expired entry keeps its plan: {@link noteEdgeRender} re-proves it against the next live render
 * for one render rather than the three a fresh compile costs.
 */
export function lookupEdgePlan(
	key: string,
	nowMs: number = Date.now(),
	witness?: string
): RenderPlan | null {
	const entry = store.get(key);
	if (!entry?.plan) return null;
	if (nowMs >= (entry.provenUntil ?? 0)) return null;
	// THE PER-SESSION PROOF, and it is unconditional. The two-session agreement that authorised the
	// store is a statement about two people; a third whose shared region differs -- an unread count,
	// a per-user block core did not placeholder -- is exactly what it cannot see. So a session is
	// served only after one of its OWN live renders has agreed with this plan, which is the same
	// shape `verifyShellFor()` gives the shell tier and the reason that tier needs one at all
	if (witness !== undefined && !entry.agreed.has(witness)) return null;
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
 * REPORTED BECAUSE A LATCHED REFUSAL LOOKED EXACTLY LIKE SAMPLING. `x-cfw-plan` read `sampling` on
 * every render that fed the compiler whether the compile stored a plan or gave up on the key
 * forever, so a path that had permanently left the tier was indistinguishable from one about to
 * join it -- and the two differ by a factor of 18 in throughput.
 */
export function edgePlanRefused(key: string): boolean {
	return (store.get(key)?.refusals ?? 0) >= PLAN_COMPILE_ATTEMPTS;
}

/**
 * Drops what a session has proven, and every plan compiled for it alone.
 *
 * Called on a non-GET, which is the only thing that queues a Drupal message for the next page. The
 * session then owes a live render before any plan may answer it again, and that render carries the
 * message. A shared plan survives for everybody else; only this session's agreement is spent.
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
 * Re-diffs, the same falsification {@link generatorAgrees} makes: the plan's own output for fresh
 * slot values is compiled against what Drupal just produced, and the two have to differ only where
 * the plan already has slots. A page that has changed, or a session Drupal has ended and now renders
 * as somebody else, moves a constant and the compile finds a region it cannot name.
 */
function stillAgrees(plan: RenderPlan, html: string): boolean {
	// the token comes out of the render being checked, which is this session's own
	const values = fillSlots(plan, { csrf: sessionCsrf(html) });
	if (values === null) return false;
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
 * The proofs are applied HERE rather than at serve time, so a plan that reaches the store is one
 * that has already reproduced both renders it came from. A refusal is remembered, because retrying
 * a compile that cannot succeed spends CPU on every later render of the same page; the generation is
 * in the key, so a moved generation gives it another go.
 *
 * A plan past {@link PLAN_TTL_MS} is re-proved against this render instead of being recompiled,
 * which is one render rather than three. One that no longer agrees is dropped and sampling restarts.
 *
 * `owned` marks a key that names one session ({@link privatePlanKey}). It drops the two-witness
 * requirement and nothing else: a key nobody else is served from cannot leak one user's page to
 * another, so the requirement has no work to do there.
 *
 * @returns the plan when this render completed a COMPILE, so the caller can mirror it to KV; a
 *   re-proof returns null, because the record in KV is the one that was already written. A private
 *   plan returns null too, since it is never mirrored
 */
export function noteEdgeRender(
	key: string,
	path: string,
	html: string,
	nowMs: number = Date.now(),
	witness = '',
	owned = false
): RenderPlan | null {
	const entry = entryFor(key, owned);
	if (entry.plan) {
		// a session that has already agreed costs nothing inside the proof window, which is what
		// keeps the re-diff once a minute rather than once a request. A session that has NOT is the
		// one case worth spending it on: until it agrees, `lookupEdgePlan()` will not serve it
		const owed = witness !== '' && !entry.agreed.has(witness);
		if (!owed && nowMs < (entry.provenUntil ?? 0)) return null;
		if (stillAgrees(entry.plan, html)) {
			// this session has now proven the plan against its own render, which is what
			// `lookupEdgePlan()` requires before serving it one
			if (witness !== '') entry.agreed.add(witness);
			if (nowMs >= (entry.provenUntil ?? 0)) entry.provenUntil = nowMs + PLAN_TTL_MS;
			return null;
		}
		// a session that DISAGREES invalidates the plan for everyone, not just for itself: the
		// disagreement is evidence the shared region is not shared after all
		heldBytes -= entry.bytes;
		entry.plan = undefined;
		entry.bytes = 0;
		entry.provenUntil = 0;
		entry.agreed.clear();
	}
	if ((entry.refusals ?? 0) >= PLAN_COMPILE_ATTEMPTS) return null;
	entry.samples.push(html);
	entry.witnesses.push(witness);
	if (entry.samples.length < SAMPLES_PER_COMPILE) return null;

	// sample 0 is the asset-library warm-up and is discarded; see SAMPLES_PER_COMPILE
	const a = entry.samples[SAMPLES_PER_COMPILE - 2] as string;
	const b = entry.samples[SAMPLES_PER_COMPILE - 1] as string;
	const wa = entry.witnesses[SAMPLES_PER_COMPILE - 2] ?? '';
	const wb = entry.witnesses[SAMPLES_PER_COMPILE - 1] ?? '';
	entry.samples = [];
	entry.witnesses = [];
	// TWO DIFFERENT SESSIONS, and this is what replaces the cookie in the key. Compiled from one
	// session's two renders, anything constant for that user and different for another -- their
	// name in the toolbar, their unread count -- is a CONSTANT in the plan and would be served to
	// everyone in the role set. Across two sessions the same region varies, so the compiler names
	// it an unknown slot and `unservableSlots()` refuses the plan outright.
	//
	// Waiting rather than refusing: a page nobody else has loaded yet is not a page that cannot be
	// planned, so the samples are kept and the next session completes the pair
	if (wa === '' || wb === '' || (wa === wb && !owned)) {
		entry.samples = [a, b];
		entry.witnesses = [wa, wb];
		return null;
	}
	const plan = compilePlan(a, b, path);
	if (
		unservableSlots(plan).length > 0 ||
		!planExplainsBoth(plan, a, b) ||
		!generatorAgrees(plan)
	) {
		entry.refusals = (entry.refusals ?? 0) + 1;
		return null;
	}
	storeEdgePlan(key, plan, nowMs, owned);
	// both sessions that produced it have agreed with it by construction
	entry.agreed.add(wa);
	entry.agreed.add(wb);
	// a private plan belongs to this isolate; there is nothing to mirror and nobody to mirror it for
	return owned ? null : plan;
}

/** this request's page, or null when the plan holds a slot it cannot fill */
export function runEdgePlan(plan: RenderPlan, csrf?: string | null): string | null {
	const values = fillSlots(plan, { csrf });
	if (values === null) return null;
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
 * Whether a response CHANGES any cookie the request arrived with.
 *
 * NOT "does the response carry `Set-Cookie`", which is what this used to ask and is why the tier
 * never compiled anything on any site. PHP re-emits the session cookie on every `session_start()`
 * when `session.cookie_lifetime` is non-zero and Drupal ships 2000000, so EVERY authenticated
 * response carries a `Set-Cookie` byte-identical to the cookie the request already held. Measured on
 * a running site: `skip:set-cookie` on every authenticated GET, with the value unchanged across
 * consecutive requests and equal to the jar's.
 *
 * A re-send of a value the client already has cannot make the key stop being this visitor's. A new
 * value, or a deletion, can -- so both still refuse, which is what a login, a logout and a session
 * regeneration all look like.
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
 * `auth-account` (`/user`) is the only profile the tier structurally could not serve, and it was the
 * only one still losing on service time once the isolate page memo landed: measured on a deployed
 * free worker, `x-worker-ms` 68.1 / 76.5 / 226.9 ms at c=1 / 4 / 16 against a localhost VPS's
 * 5 / 6 / 83, because `/user` is a 302 to `/user/<uid>` and every request rendered it.
 *
 * The redirect is SYNTHESISED INTO A BODY rather than given a store of its own, which is what keeps
 * this small: two renders that disagree still refuse, `unservableSlots` still runs, the generation
 * still fences the key, the session still has to agree before it is served, and `forgetWitness()`
 * still spends that agreement on a write. A per-user `Location` is exactly what a shared plan
 * refuses -- two sessions redirect to different uids, the compiler names an unknown region and
 * `unservableSlots` declines -- so it reaches only the private key, which is the correct scope.
 *
 * NUL-prefixed because it must be unmistakable for a page: no HTML render can begin with one.
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

/** the status and target a redirect plan holds, or null when the plan is an ordinary page */
export function readRedirectPlan(body: string): { status: number; location: string } | null {
	if (!body.startsWith(REDIRECT_PLAN_PREFIX)) return null;
	const [status, ...rest] = body.slice(REDIRECT_PLAN_PREFIX.length).split('\n');
	const code = Number(status);
	const location = rest.join('\n');
	if (!isRedirectStatus(code) || location === '') return null;
	return { status: code, location };
}

/** what a response has to be before a plan may be compiled from it */
export interface PlanEligibilityInput {
	method: string;
	status: number;
	/** the object's own `x-cfw-cache` verdict */
	doCache: string;
	contentType: string | null;
	/** every `Set-Cookie` line the response carries, compared against the request's own jar */
	setCookie: readonly string[];
	personalised: boolean;
	generation: number | null;
	cookie: string;
	/** the `Location` header, when the response is a redirect; see {@link REDIRECT_PLAN_PREFIX} */
	location?: string | null;
}

/**
 * Whether one render may become a plan.
 *
 * The same shape and the same refusals as `putPage()`, plus the two this tier adds: a request with
 * no cookie has no key that identifies anybody, and an anonymous request is already answered by
 * cheaper tiers that do not have to be per-visitor.
 */
export function planEligibility(
	input: PlanEligibilityInput
): { ok: true } | { ok: false; reason: string } {
	if (input.method !== 'GET') return { ok: false, reason: `skip:${input.method.toLowerCase()}` };
	if (!input.personalised) return { ok: false, reason: 'skip:not-personalised' };
	if (input.cookie === '') return { ok: false, reason: 'skip:no-cookie' };
	const redirect = isRedirectStatus(input.status) && (input.location ?? '') !== '';
	if (input.status !== 200 && !redirect) return { ok: false, reason: `skip:${input.status}` };
	// `ASSEMBLED` joined `VERIFY` here, and until a shell response carried `x-cfw-roles` the
	// `VERIFY` entry was decorative: the caller cannot reach the compile without a role set, so
	// naming the tier bought nothing. Both are the shell tier and both are worth compiling away --
	// an assembly still costs a Durable Object hop and a real fragment render, where a plan costs
	// neither.
	if (
		input.doCache !== 'HIT' &&
		input.doCache !== 'RENDER' &&
		input.doCache !== 'VERIFY' &&
		input.doCache !== 'ASSEMBLED'
	) {
		return { ok: false, reason: `skip:${input.doCache}` };
	}
	if (input.generation === null) return { ok: false, reason: 'skip:no-generation' };
	// a rotated session means the key is about to stop being this visitor's; a re-send of a value
	// the client already holds does not, and refusing on that refused every authenticated page
	if (rotatesSession(input.cookie, input.setCookie)) {
		return { ok: false, reason: 'skip:set-cookie' };
	}
	// a redirect has no body to be HTML, and its whole content is the status and the Location
	if (!redirect && !(input.contentType ?? '').toLowerCase().includes('text/html')) {
		return { ok: false, reason: 'skip:not-html' };
	}
	return { ok: true };
}

export type EdgePlanEnv = PageStoreEnv & { PAGE_KV?: PageKv | null };

/**
 * How long a cold-isolate read may sit in front of the object, in ms.
 *
 * MEASURED, and the recorded "a KV get costs 5-6 ms" turned out to be a claim about a WARM key.
 * On a deployed paid worker in one colo, n=20 per arm: the first read of a key that colo has not
 * seen costs 46-140 ms whether the key exists or not, and every later read of the same key costs
 * 4-5. A plan key for a session and path nobody has compiled is new by construction, so an unbounded
 * read puts 78 ms at the median in front of a 12 ms object hop on the FIRST visit to every page.
 *
 * 8 ms is above the warm read's 3-5 and far below the cold one, so a hit answers and a miss falls
 * through having spent less than the hop it was trying to avoid.
 */
export const COLD_READ_DEADLINE_MS = 8;

/**
 * Resolves `p`, or null once the deadline passes.
 *
 * The abandoned read is not cancelled -- there is no way to cancel a KV get -- so the caller hands
 * it to `waitUntil` and a late answer still warms this isolate for the next request.
 */
export function withDeadline<T>(p: Promise<T>, ms = COLD_READ_DEADLINE_MS): Promise<T | null> {
	return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/**
 * Reads a plan compiled by another isolate, or null.
 *
 * The tier that answers an isolate which knows the site's generation and has never seen this page.
 * It is worth having only inside {@link COLD_READ_DEADLINE_MS}: a key this colo already holds
 * answers in 4-5 ms against the object's 12, and one it does not costs more than the object would
 * have. Never throws; an unreadable record is a miss and one tier down still answers.
 */
export async function readEdgePlan(
	env: EdgePlanEnv | null | undefined,
	site: string,
	generation: number,
	roles: string,
	path: string
): Promise<RenderPlan | null> {
	if (!pageKvEnabled(env) || !env?.PAGE_KV) return null;
	try {
		const raw = await env.PAGE_KV.get(
			edgePlanKvKey(site, generation, await cookieFingerprint(roles), path),
			'text'
		);
		if (raw === null) return null;
		const parsed = JSON.parse(raw) as RenderPlan;
		if (!Array.isArray(parsed?.ops) || typeof parsed?.slots !== 'object') return null;
		// the proofs are re-applied on the way in: a record this isolate did not compile is input
		if (unservableSlots(parsed).length > 0 || !generatorAgrees(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Mirrors a plan so another isolate does not have to compile it.
 *
 * DEFERRED BY THE CALLER through `ctx.waitUntil`: measured on a deployed worker, an awaited write of
 * a 97 KB body costs 12.5 ms before the response leaves and the same write deferred costs 0.
 */
export async function writeEdgePlan(
	env: EdgePlanEnv | null | undefined,
	site: string,
	generation: number,
	roles: string,
	path: string,
	plan: RenderPlan
): Promise<boolean> {
	if (!pageKvEnabled(env) || !env?.PAGE_KV) return false;
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
