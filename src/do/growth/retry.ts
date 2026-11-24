import type { SiteEnv } from '../../env';
import type { CrossingTally } from '../../ops/crossings';

const MIB = 1_048_576;

/** the value of `x-cfw-retried` the front worker sets on its repeat of a refused request */
export const GROWTH_RETRY_VALUE = 'growth';

/** the response header that says whether anything left the object during the refused request */
export const EFFECTS_HEADER = 'x-cfw-effects';

/**
 * The most body the front worker replays on a repeat. The hop already holds the whole body as one
 * buffer (`buildHop()` reads it before sending), so a replay costs no stream and no second read;
 * 1 MiB covers a Drupal form post, a config import form and a JSON API call, and a larger upload is
 * not repeated.
 */
export const GROWTH_RETRY_BODY_MAX_BYTES = MIB;

/**
 * What a repeat is allowed to grow past the computed cap: 8 MiB by default.
 *
 * The cap holds the 128 MiB isolate away from the platform's memory kill with 4 MiB of margin, and
 * the notes record the kill's cliff at 108 MiB of linear memory with the JS side resident. A run
 * that was refused started from a warm interpreter; a fresh boot has the most room (E2 measured
 * 16 to 48 MiB of headroom right after a render against 36 steady), and a deployed Thunder config
 * export that the 104 MiB cap still refused at 108.9 to 109.2 MiB ran without a platform kill at
 * 128 MB total. Stock Drupal never reaches 96 MiB, so the allowance only engages for heavy routes.
 */
export const GROWTH_RETRY_ALLOWANCE_DEFAULT_BYTES = 8 * MIB;

/** the cap a repeat never passes: the 108 MiB cliff minus the 4 MiB margin the cap already carries */
export const GROWTH_RETRY_CEILING_DEFAULT_BYTES = 104 * MIB;

function bytes(value: unknown, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** whether a refused request that is safe to repeat is repeated; `GROWTH_RETRY=0` turns it off */
export function growthRetryEnabled(env?: SiteEnv): boolean {
	return String(env?.GROWTH_RETRY ?? '') !== '0';
}

/**
 * The cap in force for a repeat: the computed cap plus the allowance, never above the ceiling and
 * never below the computed cap (an explicit cap above the ceiling is left as it is).
 */
export function retryCap(env: SiteEnv | undefined, cap: number): number {
	const allowance = bytes(
		env?.GROWTH_RETRY_ALLOWANCE_BYTES,
		GROWTH_RETRY_ALLOWANCE_DEFAULT_BYTES
	);
	const ceiling = bytes(env?.GROWTH_RETRY_CEILING_BYTES, GROWTH_RETRY_CEILING_DEFAULT_BYTES);
	return Math.max(cap, Math.min(cap + allowance, ceiling));
}

/**
 * The capabilities whose call can leave the object, so a run that made one is never repeated.
 *
 * Covered: an outbound HTTP call (`cfwFetch`), an outbound socket (`cfwTcp`: Redis, an external
 * database, a mail relay), mail (`cfwMail`), the file store's writes, deletes and renames
 * (`cfwFileWrite`, `cfwFileDelete`, `cfwFileRename`: R2 write-behind), the identity claims
 * (`cfwOidcClaims`) and the runtime settings (`cfwSettings`, a KV write). Not covered, because they
 * stay inside the object's SQLite and roll back with the slice: every SQL capability, the queue
 * insert (`cfwQueueFetch`), the cache read, logging and the file reads. Anything the object cannot
 * count (no tally, a second boot in the request, a parked socket) reads as unknown.
 */
export const EFFECT_CAPABILITIES = [
	'cfwFetch',
	'cfwTcp',
	'cfwMail',
	'cfwFileWrite',
	'cfwFileDelete',
	'cfwFileRename',
	'cfwOidcClaims',
	'cfwSettings'
] as const;

/** the ledger's starting point for one request */
export interface EffectBase {
	boots: number;
	counts: Record<string, number>;
}

/** what the ledger reads off the object */
export interface EffectHost {
	crossings?: CrossingTally;
	bootCount?: number;
	parkSockets?: { size: number };
}

function effectCounts(tally: CrossingTally): Record<string, number> {
	return Object.fromEntries(EFFECT_CAPABILITIES.map((name) => [name, tally.byName[name] ?? 0]));
}

/** the starting point, taken once the request's interpreter is booted; undefined with no tally */
export function effectBase(host: EffectHost): EffectBase | undefined {
	if (!host.crossings) return undefined;
	return { boots: host.bootCount ?? 0, counts: effectCounts(host.crossings) };
}

/**
 * Whether anything left the object since the base: `none` only when the ledger proves it,
 * `some` when an effect capability ran or a parked socket is open, `unknown` when the ledger
 * cannot tell (no base, no tally, or the interpreter was booted again during the request).
 */
export function effectsSince(
	host: EffectHost,
	base: EffectBase | undefined
): 'none' | 'some' | 'unknown' {
	if (base === undefined || !host.crossings) return 'unknown';
	if ((host.bootCount ?? 0) !== base.boots) return 'unknown';
	if ((host.parkSockets?.size ?? 0) > 0) return 'some';
	const now = effectCounts(host.crossings);
	return EFFECT_CAPABILITIES.some((name) => now[name]! > (base.counts[name] ?? 0))
		? 'some'
		: 'none';
}
