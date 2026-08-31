/** the subset of the environment a plan decision reads */
export type PlanEnv = { PLAN?: string | null };

/**
 * `true` when the site is on the paid plan.
 *
 * Free is the DEFAULT for an absent or unrecognised value: every limit in this project
 * is a free-plan limit, and a typo in `PLAN` must not silently grant a 30 s CPU budget to something
 * that has 10 ms.
 */
export function isPaid(env?: PlanEnv | null): boolean {
	return String(env?.PLAN ?? 'free').toLowerCase() === 'paid';
}

/** `true` when the site is on the free plan; the complement, spelled out so call sites read clearly */
export function isFree(env?: PlanEnv | null): boolean {
	return !isPaid(env);
}

/**
 * Resolves a per-plan boolean through the override chain.
 *
 * @param explicit the most specific signal, usually a request parameter; `undefined`/`null`/`''` defer
 * @param envValue an environment override; same three values defer
 * @param paidDefault what the paid plan gets when nothing overrides
 * @param env the environment carrying `PLAN`
 *
 * A present-but-empty string DEFERS rather than reading as false. That matters because
 * `url.searchParams.get()` returns `''` for `?prefill=`, and treating that as an explicit "off" would
 * make a stray ampersand silently change behaviour.
 */
export function planFlag(
	explicit: string | null | undefined,
	envValue: string | null | undefined,
	paidDefault: boolean,
	env?: PlanEnv | null
): boolean {
	if (explicit !== undefined && explicit !== null && explicit !== '') {
		return explicit !== '0';
	}
	if (envValue !== undefined && envValue !== null && String(envValue) !== '') {
		return String(envValue) !== '0';
	}
	return isPaid(env) ? paidDefault : !paidDefault;
}

/**
 * Where the effective plan came from, so a surface can say WHY it thinks it is on free.
 *
 * `var` is the deployed `PLAN` binding, `kv` is the override an operator can flip without a
 * redeploy, and `default` is the free fallback when neither says anything.
 */
export type PlanSource = 'kv' | 'var' | 'default';

export type ResolvedPlan = { plan: 'free' | 'paid'; source: PlanSource };

/** the KV key the plan override lives under */
export const PLAN_KV_KEY = 'plan';

/**
 * How long an isolate reuses a resolved plan before reading KV again.
 *
 * KV free allows 100,000 reads/day, the same order as the Worker-request ceiling, so a read per
 * request would spend one binding meter to consult another. One read per isolate per minute is
 * nothing, and an upgrade that takes up to a minute to apply everywhere is the right trade for a
 * value that changes about once in a site's life.
 */
export const PLAN_MEMO_MS = 60_000;

/** the minimal KV surface, so the resolver is drivable over a stand-in */
export type PlanKv = { get(key: string): Promise<string | null> };

let memo: { at: number; value: ResolvedPlan } | null = null;

/** drops the isolate's memo; tests use it, and so does an explicit refresh */
export function resetPlanMemo(): void {
	memo = null;
}

/**
 * The effective plan: KV first, then the deployed var, then free.
 *
 * KV WINS. `PLAN` is a `vars` entry, so upgrading an account meant editing the config and
 * redeploying -- a deploy to change a fact the deploy does not control. An operator who upgrades
 * flips one KV key and every isolate picks it up within {@link PLAN_MEMO_MS}.
 *
 * A missing binding, a KV error and an unrecognised value all fall through to the var rather than
 * throwing: this runs on the serving path, and a KV blip must not take a site from paid to broken.
 * The same reason `isPaid()` treats an unrecognised value as free -- every limit here is a free
 * limit, and guessing upward is the failure that costs money.
 */
export async function resolvePlan(
	env?: PlanEnv | null,
	kv?: PlanKv | null,
	nowMs: number = Date.now()
): Promise<ResolvedPlan> {
	if (memo && nowMs - memo.at < PLAN_MEMO_MS) return memo.value;

	let value: ResolvedPlan = { plan: isPaid(env) ? 'paid' : 'free', source: 'var' };
	if (env?.PLAN === undefined || env.PLAN === null || env.PLAN === '') {
		value = { plan: 'free', source: 'default' };
	}
	if (kv) {
		try {
			const raw = (await kv.get(PLAN_KV_KEY))?.trim().toLowerCase();
			if (raw === 'paid' || raw === 'free') value = { plan: raw, source: 'kv' };
		} catch {
			// a KV read that failed leaves the deployed var in force; never an outage
		}
	}
	memo = { at: nowMs, value };
	return value;
}

/** overlays the resolved plan onto an env, so the 16 existing `isPaid(env)` call sites need no change */
export function withPlan<T extends PlanEnv>(env: T, resolved: ResolvedPlan): T {
	return { ...env, PLAN: resolved.plan };
}

/**
 * The KV key holding runtime lever overrides, as one JSON object.
 *
 * One key rather than one per lever: a single read is atomic, costs one of the 100,000 daily KV
 * reads instead of seven, and gives an operator one place to see every override in force.
 */
export const SETTINGS_KV_KEY = 'settings';

/**
 * The ONLY env names KV may override.
 *
 * AN ALLOW-LIST, AND THIS IS A PRIVILEGE BOUNDARY RATHER THAN TIDINESS. KV is operator-writable, so
 * merging an arbitrary object into the environment would let anyone with KV write set
 * `PW_DIAGNOSTICS=1` -- which reaches `/sql` (arbitrary SQL against the site database) and
 * `/restore` (a whole-database overwrite). Every name here is a performance lever whose worst case
 * is a slow site; nothing here changes what is reachable.
 *
 * `PLAN` is absent: it has its own key and its own resolver, because it selects a whole
 * profile rather than one number.
 *
 * THE MAIL CREDENTIALS ARE ABSENT FOR THE SAME REASON `PW_DIAGNOSTICS` IS. `MAIL_TRANSPORT` and
 * `MAIL_DRAIN_LIMIT` are here because their worst case is "no mail" or "slower mail", and both only
 * choose between transports the DEPLOYER already configured. `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`,
 * `CF_EMAIL_TOKEN`, `CF_EMAIL_ACCOUNT_ID` and `MAIL_FROM` must never join them: a KV writer who could
 * set `SMTP_HOST` would receive every password-reset link the site sends, which is a reach rather
 * than a slow site.
 */
export const KV_OVERRIDABLE = [
	'RENDER_BUDGET_MS',
	'FILL_BATCH_SIZE',
	'FILL_BATCH_WALL_MS',
	'HTTP_DRAIN_LIMIT',
	'MIRROR_LIMIT',
	'LAZY_FS_BUDGET_BYTES',
	'PREFILL',
	'GEN_BUCKET_MS',
	'MAIL_TRANSPORT',
	'MAIL_DRAIN_LIMIT',
	// the shell assembly branch, default OFF. It qualifies for this list rather than for `vars` on the
	// list's own test -- its worst case is a slow site, because a shell that does not match refuses
	// and the request falls through to an ordinary render
	'SHELL_ASSEMBLY',
	// the opcache arm. On the list for the same test: every arm boots and renders, so the worst
	// case of a wrong value is a slower or fatter object, never a changed reachability
	'OPCACHE_MODE',
	// the password algorithm. Its worst case is a slow login or a site that keeps bcrypt, never a
	// changed reachability -- an operator who sets it cannot reach anything they could not before
	'ARGON2',
	// placement is the one entry here that is not a number, and it belongs on this list rather than
	// in `vars` for the reason the list exists: an operator who learns where their audience is
	// should not need a redeploy to act on it. Worst case is still a slow site
	'SITE_LOCATION_HINT',
	// the read replica pool. Both qualify on the list's own test: an unfilled lane refuses and the
	// router retries the primary, so the worst case of a wrong value is a wasted hop. Turning the
	// pool on and off is exactly the decision an operator makes after watching traffic, and it must
	// not need a redeploy
	'REPLICA_COUNT',
	'REPLICA_LAG_MS',
	// warming. On by default and on this list so a site sharing a free account with others can be
	// un-warmed without shipping anything
	'SITE_WARM',
	// the front worker's compiled-plan tier. Same test as the rest: turning it off costs the object
	// hop it always paid, which is a slow site and not a changed reachability
	'EDGE_PLAN'
] as const;

export type KvOverridable = (typeof KV_OVERRIDABLE)[number];

let settingsMemo: { at: number; value: Partial<Record<KvOverridable, string>> } | null = null;

/** drops the isolate's settings memo; tests use it, and so does an explicit refresh */
export function resetSettingsMemo(): void {
	settingsMemo = null;
}

/**
 * Reads the lever overrides from KV, keeping only the names on {@link KV_OVERRIDABLE}.
 *
 * Every value is coerced to a string, because that is what a `vars` binding delivers and what every
 * reader already parses. A malformed document, an unknown key and a KV error all yield no overrides
 * rather than throwing: this runs on the serving path.
 */
export async function resolveSettings(
	kv?: PlanKv | null,
	nowMs: number = Date.now()
): Promise<Partial<Record<KvOverridable, string>>> {
	if (settingsMemo && nowMs - settingsMemo.at < PLAN_MEMO_MS) return settingsMemo.value;
	const out: Partial<Record<KvOverridable, string>> = {};
	if (kv) {
		try {
			const raw = await kv.get(SETTINGS_KV_KEY);
			const parsed: unknown = raw ? JSON.parse(raw) : null;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				for (const name of KV_OVERRIDABLE) {
					const value = (parsed as Record<string, unknown>)[name];
					if (value !== undefined && value !== null && typeof value !== 'object') {
						out[name] = String(value);
					}
				}
			}
		} catch {
			// unparseable or unreachable: the deployed vars stay in force
		}
	}
	settingsMemo = { at: nowMs, value: out };
	return out;
}

/**
 * Overlays KV lever overrides onto an env, leaving anything not on the allow-list untouched.
 *
 * TWO CALLERS, and there have to be two. This one runs in `src/site.ts` against the FRONT worker's
 * env, which is where `GEN_BUCKET_MS` and `SITE_LOCATION_HINT` are read. The Durable Object receives
 * its own copy of the bindings and cannot see this, so it overlays its own in `adoptSettings()` --
 * for the whole life of the convention it did not, and the seven levers read only inside the object
 * were knobs that configured nothing.
 */
export function withSettings<T extends object>(
	env: T,
	overrides: Partial<Record<KvOverridable, string>>
): T {
	return { ...env, ...overrides };
}
