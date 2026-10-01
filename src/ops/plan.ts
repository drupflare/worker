import { ruleDocumentRefusal } from './edge-rules';

/** the subset of the environment a plan decision reads */
export type PlanEnv = { PLAN?: string };

/**
 * True when the site is on the paid plan. An absent or unrecognised value is free: a typo in `PLAN`
 * must not grant a 30 s CPU budget to something that has 10 ms.
 */
export function isPaid(env?: PlanEnv): boolean {
	return String(env?.PLAN ?? 'free').toLowerCase() === 'paid';
}

/** true when the site is on the free plan (the complement of {@link isPaid}) */
export function isFree(env?: PlanEnv): boolean {
	return !isPaid(env);
}

/**
 * Resolves a per-plan boolean through the override chain.
 *
 * An empty string defers rather than reading as false: `url.searchParams.get()` returns `''` for
 * `?prefill=`, and a stray ampersand must not switch behaviour off.
 *
 * @param explicit the most specific signal, usually a request parameter; `''` and null defer
 * @param envValue an environment override; same three values defer
 * @param paidDefault what the paid plan gets when nothing overrides
 * @param env the environment carrying `PLAN`
 */
export function planFlag(
	explicit: string | null | undefined,
	envValue: string | undefined,
	paidDefault: boolean,
	env?: PlanEnv
): boolean {
	if (explicit !== undefined && explicit !== null && explicit !== '') {
		return explicit !== '0';
	}
	if (envValue !== undefined && String(envValue) !== '') {
		return String(envValue) !== '0';
	}
	return isPaid(env) ? paidDefault : !paidDefault;
}

/**
 * Where the effective plan came from: the deployed `PLAN` binding (`var`), an operator override
 * flipped without a redeploy (`kv`), or the free fallback (`default`).
 */
export type PlanSource = 'kv' | 'var' | 'default';

/** the effective plan and where it came from */
export type ResolvedPlan = { plan: 'free' | 'paid'; source: PlanSource };

/** the KV key the plan override lives under */
export const PLAN_KV_KEY = 'plan';

/**
 * The per-site key for `plan` or `settings`. A global key lets one site's owner (or an
 * administrator with `administer drupflare settings`) write levers every other site reads. The
 * global key is still read as a fleet-wide default and the per-site document overlays it; writes
 * land only on the per-site key.
 */
export function siteScopedKey(base: string, site?: string): string {
	const name = String(site ?? '').trim();
	return name === '' ? base : `${base}:${name}`;
}

/** the keys to read in order, deployment default first; one entry when there is no site */
function keyChain(base: string, site?: string): string[] {
	const scoped = siteScopedKey(base, site);
	return scoped === base ? [base] : [base, scoped];
}

/**
 * How long an isolate reuses a resolved plan before reading KV again. Free KV allows 100,000
 * reads/day, the order of the Worker-request ceiling, so a read per request would spend one meter
 * to consult another.
 */
export const PLAN_MEMO_MS = 60_000;

/** the minimal KV surface, so the resolver is drivable over a stand-in */
export type PlanKv = { get(key: string): Promise<string | null> };

/**
 * The KV binding with its write half, so levers change without a redeploy.
 */
export type PlanKvWriter = PlanKv & { put(key: string, value: string): Promise<void> };

/** whether a binding can be written, so a caller can refuse instead of throwing */
export function canWriteKv(kv?: PlanKv): kv is PlanKvWriter {
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
 * KV wins, so an upgrade is one KV key, picked up within {@link PLAN_MEMO_MS}. A missing binding,
 * a KV error or an unrecognised value falls through to the var: this is the serving path, and a KV
 * blip must not take a site from paid to broken.
 */
export async function resolvePlan(
	env?: PlanEnv,
	kv?: PlanKv,
	nowMs: number = Date.now(),
	site?: string
): Promise<ResolvedPlan> {
	// memoised per site: one isolate-wide memo would serve the first site's plan to every other
	const cacheKey = String(site ?? '');
	const held = memo.get(cacheKey);
	if (held && nowMs - held.at < PLAN_MEMO_MS) return held.value;

	let value: ResolvedPlan = { plan: isPaid(env) ? 'paid' : 'free', source: 'var' };
	if (env?.PLAN === undefined || env.PLAN === '') {
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

/** overlays the resolved plan onto an env, so existing `isPaid(env)` call sites need no change */
export function withPlan<T extends PlanEnv>(env: T, resolved: ResolvedPlan): T {
	return { ...env, PLAN: resolved.plan };
}

/**
 * The KV key holding every lever override as one JSON object: one atomic read against the daily
 * KV read budget, and one place to see what is in force.
 */
export const SETTINGS_KV_KEY = 'settings';

/**
 * The only env names KV may override, a privilege boundary: merging an arbitrary object would let
 * a KV writer set `PW_DIAGNOSTICS=1`, which reaches `/sql` and `/restore`. Every name is a lever
 * whose worst case is a slow site. `PLAN` has its own key; the mail credentials (`SMTP_*`,
 * `CF_EMAIL_*`, `MAIL_FROM`) must never join, since `SMTP_HOST` would receive every reset link.
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
	// shell assembly: a non-matching shell refuses and the request renders normally
	'SHELL_ASSEMBLY',
	// every opcache arm boots and renders; a wrong value is a slower or fatter object
	'OPCACHE_MODE',
	// worst case is a slow login or a site that keeps bcrypt
	'ARGON2',
	// not a number; an operator who learns where the audience is should not need a redeploy
	'SITE_LOCATION_HINT',
	// an unfilled lane refuses and the router retries the primary, so a wrong value is a wasted hop
	'REPLICA_COUNT',
	'REPLICA_LAG_MS',
	// on by default; listed so a site on a shared free account can be un-warmed without a deploy
	'SITE_WARM',
	// 8 s holds the object resident; longer intervals trade firings for a chance of adoption
	'WARM_INTERVAL_MS',
	// how long PHP may wait through the park per visitor request (an alarm gets fifteen times it)
	'SLEEP_BUDGET_MS',
	// off costs the object hop it always paid
	'EDGE_PLAN',
	// a wrong value is a fatter or slower page
	'ASSET_AGGREGATES',
	// which cache bins live in the interpreter, and how large each may grow; a wrong value costs a
	// rebuilt bin after an eviction (same cache-tag checksum as the database bin)
	'MEMORY_CACHE_BINS',
	'MEMORY_CACHE_MAX_ITEMS',
	// a migrated project's header and redirect rules; owner routes are exempt from redirects and
	// cookies, and this project's own headers cannot be set
	'RESPONSE_HEADERS',
	'REDIRECTS'
] as const;

/** one name on {@link KV_OVERRIDABLE} */
export type KvOverridable = (typeof KV_OVERRIDABLE)[number];

/**
 * What a lever accepts, read off the function that parses it: `int` bounds are the reader's own
 * clamps, `unit` is for display, `flag` is `0` or `1`.
 */
export type LeverDomain =
	| { kind: 'int'; min: number; max: number; unit?: 'ms' | 'bytes' }
	| { kind: 'flag' }
	| { kind: 'enum'; values: readonly string[] }
	| { kind: 'bins' }
	| { kind: 'rules' };

/** the accepted domain of every overridable lever */
export const LEVER_DOMAINS: Record<KvOverridable, LeverDomain> = {
	RENDER_BUDGET_MS: { kind: 'int', min: 0, max: 60_000, unit: 'ms' },
	FILL_BATCH_SIZE: { kind: 'int', min: 1, max: 50 },
	HTTP_DRAIN_LIMIT: { kind: 'int', min: 1, max: 25 },
	MIRROR_LIMIT: { kind: 'int', min: 1, max: 25 },
	// 16 MiB takes a module install past the JS ceiling (`lazy-fs-budget.spec.ts`); stop at half
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
	SLEEP_BUDGET_MS: { kind: 'int', min: 0, max: 60_000, unit: 'ms' },
	EDGE_PLAN: { kind: 'flag' },
	ASSET_AGGREGATES: { kind: 'flag' },
	MEMORY_CACHE_BINS: { kind: 'bins' },
	MEMORY_CACHE_MAX_ITEMS: { kind: 'int', min: 1, max: 4_096 },
	RESPONSE_HEADERS: { kind: 'rules' },
	REDIRECTS: { kind: 'rules' }
};

/**
 * Why a value is outside its lever's domain, or undefined when inside; an empty value clears the
 * override and is always inside.
 */
export function leverRefusal(name: KvOverridable, value: unknown): string | undefined {
	const text = value === null || value === undefined ? '' : String(value).trim();
	if (text === '') return undefined;
	const domain = LEVER_DOMAINS[name];
	switch (domain.kind) {
		case 'int': {
			if (!/^\d+$/.test(text)) return `${name} must be a whole number; got ${text}`;
			const n = Number(text);
			if (n < domain.min || n > domain.max) {
				return `${name} must be between ${domain.min} and ${domain.max}; got ${text}`;
			}
			return undefined;
		}
		case 'flag':
			return text === '0' || text === '1' ? undefined : `${name} must be 0 or 1; got ${text}`;
		case 'enum':
			return domain.values.includes(text)
				? undefined
				: `${name} must be one of ${domain.values.join(', ')}; got ${text}`;
		case 'bins':
			return text === 'none' || /^[a-z0-9_]{1,40}(\s*,\s*[a-z0-9_]{1,40})*$/.test(text)
				? undefined
				: `${name} must be none or comma-separated bin names; got ${text}`;
		case 'rules':
			return ruleDocumentRefusal(name as 'RESPONSE_HEADERS' | 'REDIRECTS', text);
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
 * Values are coerced to strings (what a `vars` binding delivers). A malformed document, an unknown
 * key or a KV error yields no overrides rather than throwing: this is the serving path.
 */
export async function resolveSettings(
	kv?: PlanKv,
	nowMs: number = Date.now(),
	site?: string
): Promise<Partial<Record<KvOverridable, string>>> {
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

/** what a write attempt did, so a caller can report the names it refused */
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
 * The filter is enforced here as well as in {@link resolveSettings}: a reader-side filter makes an
 * unlisted name inert, a writer-side one makes it unstorable, which matters once another reader
 * exists. A name mapped to `null` or `''` is removed, not stored empty. `PLAN` is never accepted;
 * it has {@link writePlan}.
 */
export async function writeSettings(
	kv: PlanKvWriter,
	patch: Record<string, unknown>,
	site?: string
): Promise<SettingsWrite> {
	// writes land on the caller's own site only (the credential is per site)
	const key = siteScopedKey(SETTINGS_KV_KEY, site);
	const allowed = new Set<string>(KV_OVERRIDABLE);
	// read the raw key, not the memo (up to PLAN_MEMO_MS stale); an unparseable document restarts
	// from empty, which the allow-list rebuild below makes safe
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
	for (const [name, raw] of Object.entries(patch)) {
		// a rule list arrives as an array from a JSON body and is stored as text
		const value = typeof raw === 'object' && raw !== null ? JSON.stringify(raw) : raw;
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
		if (reason !== undefined) {
			invalid.push({ name, reason });
			continue;
		}
		current[name] = String(value).trim();
	}

	// only allow-listed names survive the round trip
	const next: Record<string, string> = {};
	for (const name of KV_OVERRIDABLE) {
		const value = current[name];
		if (value !== undefined && value !== null && String(value) !== '') {
			next[name] = String(value);
		}
	}
	await kv.put(key, JSON.stringify(next));
	// else the old document is served for up to PLAN_MEMO_MS
	resetSettingsMemo();
	return { written: next as Partial<Record<KvOverridable, string>>, refused, cleared, invalid };
}

/**
 * Sets or clears the plan override.
 *
 * Separate from {@link writeSettings} so the two authorisations stay separable: `PLAN` selects a
 * limits profile whose quotas are account-wide, set by one tenant.
 *
 * @param plan `undefined` removes the override, so the deployed var comes back into force.
 */
export async function writePlan(
	kv: PlanKvWriter,
	plan: 'free' | 'paid' | undefined,
	site?: string
): Promise<ResolvedPlan> {
	await kv.put(siteScopedKey(PLAN_KV_KEY, site), plan ?? '');
	resetPlanMemo();
	return plan === undefined ? { plan: 'free', source: 'default' } : { plan, source: 'kv' };
}

/**
 * Overlays KV lever overrides onto an env, leaving anything not on the allow-list untouched.
 *
 * Two callers: `src/site.ts` overlays the front worker's env; the Durable Object has its own copy
 * of the bindings and overlays in `adoptSettings()`.
 */
export function withSettings<T extends object>(
	env: T,
	overrides: Partial<Record<KvOverridable, string>>
): T {
	return { ...env, ...overrides };
}
