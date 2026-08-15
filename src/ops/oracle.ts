import { tierFor, type RuntimeTier } from './catalog';
import { checkInstallable, type InstallVerdict } from './packagist';

/**
 * A compatibility oracle in KV, so the common answer costs no subrequest at all.
 *
 * `packagist.ts` already answers "can this module be installed" in ONE cacheable Packagist fetch.
 * This removes even
 * that for anything CI has pre-checked, which matters for two reasons that are about quotas rather than
 * speed:
 *
 *   - a subrequest is a real cost on the free plan, and an install UI that checks a dozen candidates
 *     spends a dozen of them;
 *   - Packagist being unreachable makes the live check answer `unverifiable`, which is correctly not
 *     a yes. An oracle
 *     turns that from "the feature is down" into "the feature is stale", which is a much better failure.
 *
 * KV rather than the bundle. The shipped lock map IS baked (2.4 KB) because it describes the artifact it
 * ships beside and changes only when the artifact does. An oracle is the opposite: its verdicts change
 * when PACKAGIST changes, with no deploy involved, and the bundle has 127,714 B of headroom that PHP 8.4
 * already does not fit inside. So the oracle has to be refreshable without a deploy, which is what KV is.
 *
 * Falls back, never fails closed on a miss. An absent binding or an unknown module goes to the live
 * check. A stale oracle is a correctness risk, so entries carry the core version they were computed
 * against and are ignored when it no longer matches -- a verdict computed against Drupal 11.4.5 says
 * nothing about a site that has moved on.
 */

/** the KV surface this reads; narrowed so a test supplies a plain object */
export type OracleKv = {
	get(key: string, type: 'text'): Promise<string | null>;
};

export type OracleEnv = {
	/** optional: absent means every check goes live, which is the behaviour without an oracle */
	ORACLE_KV?: OracleKv | null;
};

/** one stored verdict, plus what it was computed against */
export type OracleEntry = {
	verdict: InstallVerdict['verdict'];
	version: string | null;
	conflicts: InstallVerdict['conflicts'];
	/** the shipped core version at the time CI computed this */
	core: string;
	/** ISO timestamp, for reporting staleness */
	builtAt: string;
};

export type OracleResult = InstallVerdict & {
	/** whether this runtime can actually run it, independent of whether composer can resolve it */
	tier?: RuntimeTier;
	/** the mechanism, when the tier is not `works-today` */
	reason?: string;
	/** where the answer came from, reported so a caller can tell a cheap answer from a fresh one */
	source: 'oracle' | 'live' | 'oracle-stale';
};

/** the key a module's verdict lives under; the core version is NOT in the key, so staleness is visible */
export function oracleKey(name: string): string {
	return `oracle:${name}`;
}

/**
 * Reads a verdict from the oracle, or `null` to mean "ask Packagist".
 *
 * A parse failure, a missing binding and a core-version mismatch are all `null`. Never throws: the
 * fallback is a working code path, so an oracle problem must degrade to a slower answer rather than an
 * error.
 */
export async function readOracle(
	env: OracleEnv | null | undefined,
	name: string,
	shippedCore: string
): Promise<{ entry: OracleEntry; stale: boolean } | null> {
	if (!env?.ORACLE_KV) return null;
	try {
		const raw = await env.ORACLE_KV.get(oracleKey(name), 'text');
		if (raw === null) return null;
		const entry = JSON.parse(raw) as Partial<OracleEntry>;
		if (typeof entry.verdict !== 'string' || typeof entry.core !== 'string') return null;
		return {
			entry: {
				verdict: entry.verdict as InstallVerdict['verdict'],
				version: typeof entry.version === 'string' ? entry.version : null,
				conflicts: Array.isArray(entry.conflicts) ? entry.conflicts : [],
				core: entry.core,
				builtAt: typeof entry.builtAt === 'string' ? entry.builtAt : 'unknown'
			},
			// a verdict computed against a different core says nothing about this site
			stale: entry.core !== shippedCore
		};
	} catch {
		return null;
	}
}

/**
 * The installability answer: oracle first, live check second.
 *
 * A STALE entry is reported and then IGNORED for the decision -- it goes live. Serving a stale verdict
 * as authoritative is how a module gets installed against a core version nobody checked, and a wrong
 * yes is worse than a slow answer.
 */
export async function resolveInstallable(
	env: OracleEnv | null | undefined,
	fetcher: (url: string) => Promise<Response>,
	name: string,
	installed: Record<string, string>,
	shippedCore: string
): Promise<OracleResult> {
	const runtime = tierFor(name);

	const hit = await readOracle(env, name, shippedCore);
	if (hit && !hit.stale) {
		return {
			name,
			version: hit.entry.version,
			verdict: hit.entry.verdict,
			conflicts: hit.entry.conflicts,
			satisfied: [],
			note: `from the oracle, built ${hit.entry.builtAt} against core ${hit.entry.core}`,
			source: 'oracle',
			...runtime
		};
	}

	const live = await checkInstallable(fetcher, name, installed);
	return {
		...live,
		note: hit?.stale
			? `${live.note ?? ''} (oracle entry ignored: built against core ${hit.entry.core}, this site is ${shippedCore})`.trim()
			: live.note,
		source: hit?.stale ? 'oracle-stale' : 'live',
		...runtime
	};
}
