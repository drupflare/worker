/**
 * Getting the owner token back by proving write access to the site's Cloudflare account.
 *
 * The token is shown once at the claim. Whoever can write the deployment's `CONFIG_KV` namespace
 * can also redeploy the worker and read it, so a one-minute record written there is a proof no
 * weaker than the token. The record names the sha256 of a nonce only the writer knows; presenting
 * the nonce spends the record and returns the token. See "Owner Token Recovery" in
 * `docs/configuration.md`.
 * @module
 */
import type { SecretStore } from './site-secrets';

/** the public route a client presents the nonce to */
export const RECOVER_PATH = '/recover-token';

/** the KV key prefix; `drangler recover-token` writes the same string */
export const RECOVER_KEY_PREFIX = 'recover';

/** `cfw_meta` key holding the spent proofs (JSON array of `{h, exp}`) */
export const RECOVER_SPENT_KEY = 'recover_spent';

/** the longest life a record may claim; the client asks for 60 s, KV's minimum TTL */
export const RECOVER_MAX_LIFE_MS = 120_000;

/** the KV binding as recovery uses it; `delete` is optional so a read-only double still fits */
export type RecoverKv = {
	get(key: string): Promise<string | null>;
	delete?(key: string): Promise<void>;
};

/** what a client may send: 32 random bytes in base64url */
const NONCE = /^[A-Za-z0-9_-]{43}$/;

/** whether a presented nonce has the shape a client mints */
export function isNonce(value: unknown): value is string {
	return typeof value === 'string' && NONCE.test(value);
}

/** sha256 of a string, lowercase hex */
export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** the KV key for a nonce: bound to the host, hashed so the namespace never holds the nonce */
export async function recoverKey(host: string, nonce: string): Promise<string> {
	return `${RECOVER_KEY_PREFIX}:${host.toLowerCase()}:${await sha256Hex(nonce)}`;
}

/** why a stored record was refused, or `ok` */
export type ProofVerdict = 'ok' | 'wrong-host' | 'spent' | 'malformed';

/**
 * Judges a stored record against the host the request arrived on and the worker's own clock.
 *
 * `exp` comes from the writer's clock, so it is bounded on both sides: past is `spent`, and more
 * than {@link RECOVER_MAX_LIFE_MS} ahead is `malformed`, since a record that claims a long life
 * would outlast the KV TTL that is meant to be the real limit.
 */
export function judgeProof(
	record: unknown,
	host: string,
	nowMs: number
): { verdict: ProofVerdict; exp: number } {
	if (record === null || typeof record !== 'object') return { verdict: 'malformed', exp: 0 };
	const { host: boundTo, exp } = record as { host?: unknown; exp?: unknown };
	if (typeof boundTo !== 'string' || typeof exp !== 'number' || !Number.isFinite(exp)) {
		return { verdict: 'malformed', exp: 0 };
	}
	if (boundTo.toLowerCase() !== host.toLowerCase()) return { verdict: 'wrong-host', exp };
	if (exp < nowMs) return { verdict: 'spent', exp };
	if (exp - nowMs > RECOVER_MAX_LIFE_MS) return { verdict: 'malformed', exp };
	return { verdict: 'ok', exp };
}

interface Spent {
	h: string;
	exp: number;
}

function readSpent(store: SecretStore, nowMs: number): Spent[] {
	try {
		const parsed: unknown = JSON.parse(store.get(RECOVER_SPENT_KEY) ?? '[]');
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(s): s is Spent =>
				typeof s?.h === 'string' && typeof s?.exp === 'number' && s.exp >= nowMs
		);
	} catch {
		return [];
	}
}

/**
 * Marks a proof spent, and says whether this was its first use.
 *
 * KV is eventually consistent, so a deleted record can be served for another minute somewhere else;
 * this table is the strongly consistent arbiter. It must run with no `await` between the check and
 * the write, which is what makes two racing requests spend a proof once. Entries drop once their
 * `exp` has passed, since an expired record is refused before it gets here.
 */
export function spendProof(store: SecretStore, hash: string, exp: number, nowMs: number): boolean {
	const spent = readSpent(store, nowMs);
	if (spent.some((s) => s.h === hash)) return false;
	spent.push({ h: hash, exp });
	store.set(RECOVER_SPENT_KEY, JSON.stringify(spent));
	return true;
}
