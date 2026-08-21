/**
 * Whether the Drupal core this repo ships has fallen behind upstream.
 *
 * `SHIPPED_CORE_VERSION` is checked against the tree and against `composer.lock`, and never against
 * drupal.org -- so the first notice of a core advisory was a human happening to read the security
 * page. This closes that: one read-only fetch of the release history, no credential.
 *
 * **There are TWO ways to be stale and only one of them is a version comparison.** A branch can be
 * dropped from `<supported_branches>` while still being the newest release on that branch, which
 * reads as "current" to any check that only compares versions -- and it means no future fix of any
 * kind, security included, will ever be published for it. Both are reported.
 *
 * `bun scripts/qa/core-freshness.ts [--json] [--shipped=<version>] [--offline=<path>]`
 *
 * Exits 1 when a security release is available or the branch is unsupported, 0 otherwise, so it can
 * gate a scheduled job. It cannot join the hermetic gate: it needs the network, which is why
 * `tests/node/core-freshness.spec.ts` drives the parsing and the verdict over a fixture instead.
 */

export const RELEASE_HISTORY_URL = 'https://updates.drupal.org/release-history/drupal/current';

/** the `Release type` term drupal.org puts on a security release */
const SECURITY_TERM = 'Security update';

export type Release = {
	version: string;
	/** every `Release type` term on the release, verbatim */
	types: string[];
	security: boolean;
	/** publication time, epoch seconds; 0 when the feed omitted it */
	date: number;
};

export type Freshness = {
	shipped: string;
	/** the branch prefix, e.g. `11.4.` for `11.4.5` */
	branch: string;
	branchSupported: boolean;
	latestOnBranch: string | null;
	latestOverall: string | null;
	/** releases on the shipped branch newer than what ships, newest first */
	newer: Release[];
	securityBehind: boolean;
	verdict: 'current' | 'behind' | 'security-behind' | 'branch-unsupported';
};

/** the branches upstream still publishes fixes for, as the feed spells them (`11.4.`) */
export function parseSupportedBranches(xml: string): string[] {
	const block = /<supported_branches>([^<]*)<\/supported_branches>/.exec(xml)?.[1] ?? '';
	return block
		.split(',')
		.map((b) => b.trim())
		.filter((b) => b !== '');
}

/**
 * Every published release in the feed.
 *
 * Regex rather than an XML parser: the feed is machine-generated and this repo has no XML parser in
 * its dependency tree. Unpublished releases are skipped -- they are visible in the feed and are not
 * something anyone can upgrade to.
 */
export function parseReleases(xml: string): Release[] {
	const out: Release[] = [];
	for (const match of xml.matchAll(/<release>([\s\S]*?)<\/release>/g)) {
		const body = match[1] ?? '';
		const version = /<version>([^<]*)<\/version>/.exec(body)?.[1]?.trim();
		if (!version) continue;
		const status = /<status>([^<]*)<\/status>/.exec(body)?.[1]?.trim();
		if (status && status !== 'published') continue;
		const types = [...body.matchAll(/<name>Release type<\/name><value>([^<]*)<\/value>/g)].map(
			(t) => (t[1] ?? '').trim()
		);
		out.push({
			version,
			types,
			security: types.includes(SECURITY_TERM),
			date: Number(/<date>(\d+)<\/date>/.exec(body)?.[1] ?? 0)
		});
	}
	return out;
}

/** `11.4.5` -> `11.4.`, matching how `<supported_branches>` spells a branch */
export function branchOf(version: string): string {
	const parts = version.split('.');
	return parts.length >= 2 ? `${parts[0]}.${parts[1]}.` : `${version}.`;
}

/**
 * Numeric-segment comparison, negative when `a` is older.
 *
 * Not semver: drupal.org publishes `11.4.5`, `11.0.0-beta1` and `10.6.x-dev` in one feed. A segment
 * that is not a number sorts BELOW the same numeric prefix, so `11.5.0-beta1` is older than
 * `11.5.0`, which is the answer that keeps a prerelease from reading as an upgrade.
 */
export function compareVersions(a: string, b: string): number {
	const split = (v: string) => v.split(/[.-]/);
	const left = split(a);
	const right = split(b);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const x = left[i];
		const y = right[i];
		if (x === y) continue;
		if (x === undefined) return isNumeric(y) ? -1 : 1;
		if (y === undefined) return isNumeric(x) ? 1 : -1;
		if (isNumeric(x) && isNumeric(y)) {
			if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
			continue;
		}
		// a tagged segment against a numeric one: the tag is the prerelease and sorts lower
		if (isNumeric(x)) return 1;
		if (isNumeric(y)) return -1;
		return x < y ? -1 : 1;
	}
	return 0;
}

function isNumeric(value: string | undefined): boolean {
	return value !== undefined && /^\d+$/.test(value);
}

/**
 * The verdict, and it reports the most urgent ACTION rather than the worst state.
 *
 * `security-behind` outranks `branch-unsupported` because a published fix you have not applied is
 * exploitable today, where an unsupported branch is a migration to plan. Both booleans are on the
 * result, so a caller that disagrees can rank them itself.
 */
export function assess(shipped: string, xml: string): Freshness {
	const branch = branchOf(shipped);
	const branchSupported = parseSupportedBranches(xml).includes(branch);
	const releases = parseReleases(xml);

	const onBranch = releases
		.filter((r) => branchOf(r.version) === branch)
		.sort((a, b) => compareVersions(b.version, a.version));
	const newer = onBranch.filter((r) => compareVersions(r.version, shipped) > 0);
	const securityBehind = newer.some((r) => r.security);

	const latestOverall =
		[...releases].sort((a, b) => compareVersions(b.version, a.version))[0]?.version ?? null;

	const verdict: Freshness['verdict'] = securityBehind
		? 'security-behind'
		: !branchSupported
			? 'branch-unsupported'
			: newer.length > 0
				? 'behind'
				: 'current';

	return {
		shipped,
		branch,
		branchSupported,
		latestOnBranch: onBranch[0]?.version ?? null,
		latestOverall,
		newer,
		securityBehind,
		verdict
	};
}

/** one line per fact, so a scheduled job's log is readable without the JSON */
export function formatFreshness(f: Freshness): string {
	const lines = [
		`shipped           ${f.shipped}`,
		`branch            ${f.branch} (${f.branchSupported ? 'supported' : 'NOT SUPPORTED'})`,
		`latest on branch  ${f.latestOnBranch ?? 'unknown'}`,
		`latest overall    ${f.latestOverall ?? 'unknown'}`,
		`verdict           ${f.verdict}`
	];
	if (f.newer.length > 0) {
		lines.push('', `${f.newer.length} newer on this branch:`);
		for (const r of f.newer) {
			lines.push(`  ${r.version}${r.security ? '  <- SECURITY' : ''}  ${r.types.join(', ')}`);
		}
	}
	return lines.join('\n');
}

async function main(): Promise<void> {
	// annotated because this tsconfig has no node types, so `process.argv` widens to any
	const args: string[] = process.argv.slice(2);
	const flag = (name: string) =>
		args.find((a: string) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

	const { SHIPPED_CORE_VERSION } = await import('../../src/ops/shipped-lock.js');
	const shipped = flag('shipped') ?? SHIPPED_CORE_VERSION;

	const offline = flag('offline');
	const xml = offline
		? await Bun.file(offline).text()
		: await fetch(RELEASE_HISTORY_URL).then((r) => {
				if (!r.ok) throw new Error(`release history returned ${r.status}`);
				return r.text();
			});

	const freshness = assess(shipped, xml);
	console.log(
		args.includes('--json') ? JSON.stringify(freshness, null, 2) : formatFreshness(freshness)
	);

	// a plain `behind` is informational: a bugfix release is not an incident
	if (freshness.verdict === 'security-behind' || freshness.verdict === 'branch-unsupported') {
		process.exitCode = 1;
	}
}

if (import.meta.main) {
	await main();
}
