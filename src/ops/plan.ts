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
 * The per-site key for one of the two documents, and why a global one is a tenancy hole.
 *
 * **BOTH DOCUMENTS WERE DEPLOYMENT-WIDE.** `plan` and `settings` were literal keys, so the owner of
 * ONE site could write levers every other site on the deployment reads -- and once the Drupal
 * settings form landed, so could a site administrator holding `administer drupflare settings`, who
 * is a tenancy level below even that. `KV_OVERRIDABLE`'s safety argument is "the worst case is a
 * slow site", which is an argument about the writer's OWN site; applied across tenants it does not
 * hold, and `PLAN` selects an account-wide limits profile on top.
 *
 * The global key is still READ, as the deployment-wide default, so an operator can set a fleet-wide
 * value in the dashboard and an existing deployment keeps the values it already has. A per-site
 * document overlays it. Writes only ever land on the per-site key.
 */
export function siteScopedKey(base: string, site?: string | null): string {
	const name = String(site ?? '').trim();
	return name === '' ? base : `${base}:${name}`;
}

/** the keys to read in order, deployment default first; one entry when there is no site */
function keyChain(base: string, site?: string | null): string[] {
	const scoped = siteScopedKey(base, site);
	return scoped === base ? [base] : [base, scoped];
}

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

/**
 * The write half, which did not exist until v1.0.1.
 *
 * Every lever below was readable from KV and settable only by editing `wrangler.jsonc` and
 * redeploying -- a deploy to change a fact the deploy does not control, which is the exact thing
 * `resolvePlan()`'s docblock says KV is here to avoid. Nothing in `src/` called `put()`.
 */
export type PlanKvWriter = PlanKv & { put(key: string, value: string): Promise<void> };

/** whether a binding can be written, so a caller can refuse rather than throw on a read-only stub */
export function canWriteKv(kv?: PlanKv | null): kv is PlanKvWriter {
	return !!kv && typeof (kv as PlanKvWriter).put === 'function';
}

const memo = new Map<string, { at: number; value: ResolvedPlan }>();

/** drops the isolate's memo; tests use it, and so does an explicit refresh */
export function resetPlanMemo(): void {
	memo.clear();
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
	nowMs: number = Date.now(),
	site?: string | null
): Promise<ResolvedPlan> {
	// MEMOISED PER SITE. One memo for the whole isolate served whichever site asked first to every
	// site after it, which is the same cross-tenant shape the key itself had
	const cacheKey = String(site ?? '');
	const held = memo.get(cacheKey);
	if (held && nowMs - held.at < PLAN_MEMO_MS) return held.value;

	let value: ResolvedPlan = { plan: isPaid(env) ? 'paid' : 'free', source: 'var' };
	if (env?.PLAN === undefined || env.PLAN === null || env.PLAN === '') {
		value = { plan: 'free', source: 'default' };
	}
	if (kv) {
		try {
			// the deployment-wide default first, then this site's own document on top
			for (const key of keyChain(PLAN_KV_KEY, site)) {
				const raw = (await kv.get(key))?.trim().toLowerCase();
				if (raw === 'paid' || raw === 'free') value = { plan: raw, source: 'kv' };
			}
		} catch {
			// a KV read that failed leaves the deployed var in force; never an outage
		}
	}
	memo.set(cacheKey, { at: nowMs, value });
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
 * reads instead of one per lever, and gives an operator one place to see every override in
 * force. Counted nowhere in prose: this docblock said seven while the list held eighteen.
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
	'HTTP_DRAIN_LIMIT',
	'MIRROR_LIMIT',
	'LAZY_FS_BUDGET_BYTES',
	'PREFILL',
	'GEN_BUCKET_MS',
	'MAIL_TRANSPORT',
	'MAIL_DRAIN_LIMIT',
	// the shell assembly branch, default ON. It qualifies for this list rather than for `vars` on the
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
	// how often a warmed site fires, which is the warming cost curve: 8 s holds the object resident
	// on every request, and longer intervals trade firings for a chance of adopting the interpreter.
	// Worst case is a cold boot or a costlier site, never a changed reachability
	'WARM_INTERVAL_MS',
	// the front worker's compiled-plan tier. Same test as the rest: turning it off costs the object
	// hop it always paid, which is a slow site and not a changed reachability
	'EDGE_PLAN',
	// the baked asset aggregates. It met this list's own test and was left off it, so `assets/agg/`
	// shipped built and there was no way to turn it on without a redeploy -- an oversight rather
	// than a decision. A wrong value is a fatter or slower page, never a changed reachability
	'ASSET_AGGREGATES',
	// which cache bins live in the interpreter instead of in the tenant's SQLite, and how large each
	// may grow. Same test: an in-memory bin validates against the same cache-tag checksum the
	// database one does, so a wrong value costs a rebuilt bin after an eviction and never a changed
	// reachability
	'MEMORY_CACHE_BINS',
	'MEMORY_CACHE_MAX_ITEMS'
] as const;

export type KvOverridable = (typeof KV_OVERRIDABLE)[number];

/**
 * What a lever accepts, read off the function that parses it.
 *
 * `int` bounds are the reader's own clamps where it has one; `unit` is for display. `flag` is `0` or
 * `1`, because every flag reader here tests for one of the two and treats anything else as the other.
 */
export type LeverDomain =
	| { kind: 'int'; min: number; max: number; unit?: 'ms' | 'bytes' }
	| { kind: 'flag' }
	| { kind: 'enum'; values: readonly string[] }
	| { kind: 'bins' };

export const LEVER_DOMAINS: Record<KvOverridable, LeverDomain> = {
	RENDER_BUDGET_MS: { kind: 'int', min: 0, max: 60_000, unit: 'ms' },
	FILL_BATCH_SIZE: { kind: 'int', min: 1, max: 50 },
	HTTP_DRAIN_LIMIT: { kind: 'int', min: 1, max: 25 },
	MIRROR_LIMIT: { kind: 'int', min: 1, max: 25 },
	// the reader has no clamp; 16 MiB was measured to take a module install past the JS ceiling
	// (`lazy-fs-budget.spec.ts`), so the writer stops at half of it
	LAZY_FS_BUDGET_BYTES: { kind: 'int', min: 0, max: 8 * 1024 * 1024, unit: 'bytes' },
	PREFILL: { kind: 'flag' },
	GEN_BUCKET_MS: { kind: 'int', min: 1_000, max: 300_000, unit: 'ms' },
	MAIL_TRANSPORT: { kind: 'enum', values: ['auto', 'binding', 'api', 'smtp', 'off'] },
	MAIL_DRAIN_LIMIT: { kind: 'int', min: 1, max: 25 },
	SHELL_ASSEMBLY: { kind: 'flag' },
	OPCACHE_MODE: { kind: 'enum', values: ['file', 'shm', 'off'] },
	ARGON2: { kind: 'flag' },
	SITE_LOCATION_HINT: {
		kind: 'enum',
		values: [
			'wnam',
			'enam',
			'sam',
			'weur',
			'eeur',
			'apac',
			'apac-ne',
			'apac-se',
			'oc',
			'afr',
			'me'
		]
	},
	REPLICA_COUNT: { kind: 'int', min: 0, max: 256 },
	REPLICA_LAG_MS: { kind: 'int', min: 1_000, max: 300_000, unit: 'ms' },
	SITE_WARM: { kind: 'flag' },
	WARM_INTERVAL_MS: { kind: 'int', min: 8_000, max: 600_000, unit: 'ms' },
	EDGE_PLAN: { kind: 'flag' },
	ASSET_AGGREGATES: { kind: 'flag' },
	MEMORY_CACHE_BINS: { kind: 'bins' },
	MEMORY_CACHE_MAX_ITEMS: { kind: 'int', min: 1, max: 4_096 }
};

/**
 * Why a value is outside its lever's domain, or null when it is inside.
 *
 * An empty value is always inside: it clears the override.
 */
export function leverRefusal(name: KvOverridable, value: unknown): string | null {
	const text = value === null || value === undefined ? '' : String(value).trim();
	if (text === '') return null;
	const domain = LEVER_DOMAINS[name];
	switch (domain.kind) {
		case 'int': {
			if (!/^\d+$/.test(text)) return `${name} must be a whole number; got ${text}`;
			const n = Number(text);
			if (n < domain.min || n > domain.max) {
				return `${name} must be between ${domain.min} and ${domain.max}; got ${text}`;
			}
			return null;
		}
		case 'flag':
			return text === '0' || text === '1' ? null : `${name} must be 0 or 1; got ${text}`;
		case 'enum':
			return domain.values.includes(text)
				? null
				: `${name} must be one of ${domain.values.join(', ')}; got ${text}`;
		case 'bins':
			return text === 'none' || /^[a-z0-9_]{1,40}(\s*,\s*[a-z0-9_]{1,40})*$/.test(text)
				? null
				: `${name} must be none or comma-separated bin names; got ${text}`;
	}
}

const settingsMemo = new Map<
	string,
	{ at: number; value: Partial<Record<KvOverridable, string>> }
>();

/** drops the isolate's settings memo; tests use it, and so does an explicit refresh */
export function resetSettingsMemo(): void {
	settingsMemo.clear();
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
	nowMs: number = Date.now(),
	site?: string | null
): Promise<Partial<Record<KvOverridable, string>>> {
	// per site, for the reason `resolvePlan`'s memo is
	const cacheKey = String(site ?? '');
	const held = settingsMemo.get(cacheKey);
	if (held && nowMs - held.at < PLAN_MEMO_MS) return held.value;
	const out: Partial<Record<KvOverridable, string>> = {};
	if (kv) {
		try {
			// deployment-wide defaults first, this site's own document on top
			for (const key of keyChain(SETTINGS_KV_KEY, site)) {
				const raw = await kv.get(key);
				const parsed: unknown = raw ? JSON.parse(raw) : null;
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					for (const name of KV_OVERRIDABLE) {
						const value = (parsed as Record<string, unknown>)[name];
						if (value !== undefined && value !== null && typeof value !== 'object') {
							out[name] = String(value);
						}
					}
				}
			}
		} catch {
			// unparseable or unreachable: the deployed vars stay in force
		}
	}
	settingsMemo.set(cacheKey, { at: nowMs, value: out });
	return out;
}

/** what a write attempt did, so a caller can report the names it refused rather than silently drop */
export type SettingsWrite = {
	written: Partial<Record<KvOverridable, string>>;
	/** names the caller sent that are not on {@link KV_OVERRIDABLE} */
	refused: string[];
	/** names the caller cleared, which fall back to the deployed var */
	cleared: string[];
	/** allow-listed names whose value is outside {@link LEVER_DOMAINS}, left as they were */
	invalid: { name: string; reason: string }[];
};

/**
 * Merges a patch into the KV settings document, keeping only allow-listed names.
 *
 * **THE FILTER IS ENFORCED HERE AND NOT ONLY IN {@link resolveSettings}, and that is a privilege
 * boundary rather than belt-and-braces.** A reader-side filter makes an unlisted name inert; a
 * writer-side filter makes it unstorable. Those differ the moment anything else grows a reader --
 * a future surface reading the raw document would see whatever the last writer put there, and
 * `KV_OVERRIDABLE`'s docblock explains what a `PW_DIAGNOSTICS` in that document would reach.
 *
 * A name mapped to `null` or `''` is REMOVED rather than stored empty, because an empty string is
 * how every reader here spells "defer to the deployed var" and a stored one would be indistinguishable
 * from a deliberate blank.
 *
 * `PLAN` is not accepted at any spelling; it has {@link writePlan}, for the reason the allow-list
 * gives.
 */
export async function writeSettings(
	kv: PlanKvWriter,
	patch: Record<string, unknown>,
	site?: string | null
): Promise<SettingsWrite> {
	// WRITES LAND ON THE CALLER'S OWN SITE ONLY. The credential that reaches this is per site -- an
	// owner token, or a Drupal permission a level below that -- so a write to the deployment-wide
	// document would let one tenant set levers every other tenant reads
	const key = siteScopedKey(SETTINGS_KV_KEY, site);
	const allowed = new Set<string>(KV_OVERRIDABLE);
	// the raw key rather than the memo, which may be up to PLAN_MEMO_MS stale and would silently
	// drop a concurrent operator's change. An unparseable document starts from empty rather than
	// being merged into: it cannot be trusted to say what is in force, and the allow-list rebuild
	// below is what makes discarding it safe
	let current: Record<string, unknown> = {};
	try {
		const raw = await kv.get(key);
		const parsed: unknown = raw ? JSON.parse(raw) : null;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			current = parsed as Record<string, unknown>;
		}
	} catch {
		current = {};
	}

	const refused: string[] = [];
	const cleared: string[] = [];
	const invalid: { name: string; reason: string }[] = [];
	for (const [name, value] of Object.entries(patch)) {
		if (!allowed.has(name)) {
			refused.push(name);
			continue;
		}
		if (value === null || value === undefined || String(value).trim() === '') {
			delete current[name];
			cleared.push(name);
			continue;
		}
		const reason = leverRefusal(name as KvOverridable, value);
		if (reason !== null) {
			invalid.push({ name, reason });
			continue;
		}
		current[name] = String(value).trim();
	}

	// only allow-listed names survive the round trip, so a document that arrived carrying something
	// else cannot be written back out
	const next: Record<string, string> = {};
	for (const name of KV_OVERRIDABLE) {
		const value = current[name];
		if (value !== undefined && value !== null && String(value) !== '') {
			next[name] = String(value);
		}
	}
	await kv.put(key, JSON.stringify(next));
	// the isolate would otherwise serve the old document for up to PLAN_MEMO_MS, which reads as the
	// write having been ignored
	resetSettingsMemo();
	return { written: next as Partial<Record<KvOverridable, string>>, refused, cleared, invalid };
}

/**
 * Sets or clears the plan override.
 *
 * SEPARATE FROM {@link writeSettings} AND DELIBERATELY SO. Every name on {@link KV_OVERRIDABLE}
 * has a worst case of "a slow site", which is what makes that list safe to delegate. `PLAN` selects
 * a whole limits profile, and the quotas it models are ACCOUNT-WIDE while any actor setting it is
 * one tenant. Keeping it on its own function keeps the two authorisations separable.
 *
 * @param plan `null` removes the override, so the deployed var comes back into force.
 */
export async function writePlan(
	kv: PlanKvWriter,
	plan: 'free' | 'paid' | null,
	site?: string | null
): Promise<ResolvedPlan> {
	// per site, like {@link writeSettings}: the account-wide reasoning above is the argument for
	// restricting WHO may set it, and it is also the argument for not letting one tenant set it
	// for every other one
	await kv.put(siteScopedKey(PLAN_KV_KEY, site), plan === null ? '' : plan);
	resetPlanMemo();
	return plan === null ? { plan: 'free', source: 'default' } : { plan, source: 'kv' };
}

/**
 * Overlays KV lever overrides onto an env, leaving anything not on the allow-list untouched.
 *
 * TWO CALLERS, and there have to be two. This one runs in `src/site.ts` against the FRONT worker's
 * env, which is where `GEN_BUCKET_MS` and `SITE_LOCATION_HINT` are read. The Durable Object receives
 * its own copy of the bindings and cannot see this, so it overlays its own in `adoptSettings()` --
 * for the whole life of the convention it did not, and the levers read only inside the object
 * were knobs that configured nothing.
 */
export function withSettings<T extends object>(
	env: T,
	overrides: Partial<Record<KvOverridable, string>>
): T {
	return { ...env, ...overrides };
}
