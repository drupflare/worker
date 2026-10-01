/**
 * A compatibility oracle in KV, so the common answer costs no subrequest at all.
 *
 * It removes the one Packagist fetch for anything CI pre-checked (a subrequest is a real cost on
 * free), and turns "Packagist is unreachable" from "the feature is down" into "the feature is
 * stale". KV rather than the bundle: verdicts change when Packagist does, with no deploy.
 *
 * A miss falls back to the live check, never fails closed. Entries carry the core version they
 * were computed against and are ignored when it differs.
 * @module
 */
import { tierFor, type RuntimeTier } from './catalog';
import { checkInstallable, type InstallVerdict } from './packagist';

/** the KV surface this reads; narrowed so a test supplies a plain object */
export type OracleKv = {
	get(key: string, type: 'text'): Promise<string | null>;
};

/** the env bindings the oracle reads */
export type OracleEnv = {
	/** optional: absent means every check goes live */
	ORACLE_KV?: OracleKv;
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

/** a verdict plus whether this runtime can run the module */
export type OracleResult = InstallVerdict & {
	/** whether this runtime can run it, independent of whether composer can resolve it */
	tier?: RuntimeTier;
	/** the mechanism, when the tier is not `works-today` */
	reason?: string;
	/** where the answer came from (a cheap answer or a fresh one) */
	source: 'oracle' | 'live' | 'oracle-stale';
};

/** the key a module's verdict lives under (no core version in it, so staleness is visible) */
export function oracleKey(name: string): string {
	return `oracle:${name}`;
}

/**
 * Reads a verdict from the oracle, or `null` to mean "ask Packagist".
 *
 * A parse failure and a missing binding are `undefined`. Never throws: an oracle problem must
 * degrade to a slower answer.
 */
export async function readOracle(
	env: OracleEnv | undefined,
	name: string,
	shippedCore: string
): Promise<{ entry: OracleEntry; stale: boolean } | undefined> {
	if (!env?.ORACLE_KV) return undefined;
	try {
		const raw = await env.ORACLE_KV.get(oracleKey(name), 'text');
		if (raw === null) return undefined;
		const entry = JSON.parse(raw) as Partial<OracleEntry>;
		if (typeof entry.verdict !== 'string' || typeof entry.core !== 'string') return undefined;
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
		return undefined;
	}
}

/**
 * The installability answer: oracle first, live check second.
 *
 * A stale entry is reported but ignored for the decision (it goes live): a wrong yes is worse
 * than a slow answer.
 */
export async function resolveInstallable(
	env: OracleEnv | undefined,
	fetcher: (url: string) => Promise<Response>,
	name: string,
	installed: Record<string, string>,
	shippedCore: string,
	constraint?: string,
	stability?: string
): Promise<OracleResult> {
	const runtime = tierFor(name);

	// the oracle scores the newest release, so a constrained install is always checked live
	const hit = constraint ? undefined : await readOracle(env, name, shippedCore);
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

	const live = await checkInstallable(fetcher, name, installed, undefined, constraint, stability);
	return {
		...live,
		note: hit?.stale
			? `${live.note ?? ''} (oracle entry ignored: built against core ${hit.entry.core}, this site is ${shippedCore})`.trim()
			: live.note,
		source: hit?.stale ? 'oracle-stale' : 'live',
		...runtime
	};
}
