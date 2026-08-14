/** the subset of the environment a plan decision reads */
export type PlanEnv = { PLAN?: string | null };

/**
 * `true` when the site is on the paid plan.
 *
 * Free is the DEFAULT for an absent or unrecognised value, deliberately: every limit in this project
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
