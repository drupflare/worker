import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export type Collision = {
	collides: readonly string[];
	plugins?: readonly string[];
	sheds?: readonly string[];
	require?: string;
};

export type Collisions = Readonly<Record<string, Collision>>;

export type Phase = { module: string; remove: string[]; plugins: string[]; require?: string };

export type Plan = { base: string[]; phases: Phase[] };

/** every pair in `packages` where a module and a package it collides with are both present */
export function conflicts(packages: Iterable<string>, collisions: Collisions): string[] {
	const have = new Set(packages);
	return Object.entries(collisions).flatMap(([module, c]) =>
		have.has(module)
			? c.collides.filter((x) => have.has(x)).map((x) => `${module} collides with ${x}`)
			: []
	);
}

/** throws naming each conflict, for the caller that is about to put `packages` in one lock */
export function requireNoConflicts(packages: Iterable<string>, collisions: Collisions): void {
	const found = conflicts(packages, collisions);
	if (found.length > 0) throw new Error(`one composer lock cannot hold: ${found.join('; ')}`);
}

/**
 * The base build and one phase per declared collision.
 *
 * The base holds every census package except the modules that declare a collision, so each
 * collider's own row runs there, before any phase removes it. A phase removes the colliders (and
 * any packages shed to keep the pack under the asset cap) and then requires the module.
 *
 * A collision with `require` pins another branch of a module the base already holds at its locked
 * version: the base keeps the module, and the phase removes it and requires `require` instead.
 */
export function resolvePhases(census: readonly string[], collisions: Collisions): Plan {
	const base = census.filter((name) => !(name in collisions) || collisions[name]?.require);
	const phases: Phase[] = [];
	for (const [module, c] of Object.entries(collisions)) {
		if (!census.includes(module)) {
			throw new Error(`${module} declares collisions and is not in the census`);
		}
		if (c.require !== undefined && !c.require.startsWith(`${module}:`)) {
			throw new Error(`${module} requires ${c.require}, which is not a constraint on it`);
		}
		const remove = [
			...new Set([...(c.require ? [module] : []), ...c.collides, ...(c.sheds ?? [])])
		];
		for (const gone of c.collides) {
			if (!base.includes(gone)) {
				throw new Error(
					`${module} collides with ${gone}, which the base build does not install`
				);
			}
		}
		phases.push({
			module,
			remove,
			plugins: [...(c.plugins ?? [])],
			...(c.require ? { require: c.require } : {})
		});
	}
	requireNoConflicts(base, collisions);
	return { base, phases };
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** `name sha256` lines for each file, in the order given */
export function digestsOf(files: readonly string[]): string[] {
	return files.map((f) => `${basename(f)} ${sha(f)}`);
}

/** copies the files into `dir`, which is what a later restore reads */
export function snapshotFiles(files: readonly string[], dir: string): string[] {
	mkdirSync(dir, { recursive: true });
	for (const f of files) cpSync(f, join(dir, basename(f)));
	return digestsOf(files.map((f) => join(dir, basename(f))));
}

/** the files whose bytes differ from the snapshot, so a skipped restore is a non-empty list */
export function mismatches(files: readonly string[], dir: string): string[] {
	return files.filter(
		(f) => !existsSync(join(dir, basename(f))) || sha(f) !== sha(join(dir, basename(f)))
	);
}

export function restoreFiles(files: readonly string[], dir: string): void {
	for (const f of files) cpSync(join(dir, basename(f)), f);
	const bad = mismatches(files, dir);
	if (bad.length > 0) throw new Error(`restore did not match for ${bad.join(', ')}`);
}

/** the failure for a composer call that exited non-zero, with its own message so a branch that did not resolve is named */
export function composerFailure(args: readonly string[], status: number | null, stderr: string) {
	const message = stderr.trim().split('\n').slice(-12).join('\n');
	return new Error(
		`composer ${args.join(' ')} exited ${status}${message ? `:\n${message}` : ''}`
	);
}

export type Result = { title: string; status: string };

export type Report = { testResults?: { assertionResults?: Result[] }[] };

export type Summary = {
	passed: number;
	failed: number;
	skipped: number;
	failing: string[];
	unreached: string[];
	verified: string[];
	missing: string[];
};

/** the module a row is named for: both specs title a row `<machine name>: <what it asserts>` */
export const subjectOf = (title: string) => /^([a-z0-9_]+): /.exec(title)?.[1];

const resultsOf = (report: Report): Result[] =>
	(report.testResults ?? []).flatMap((file) => file.assertionResults ?? []);

/**
 * Counts one fixture run, base build plus a report per phase (keyed by the module's short name).
 *
 * A base-run skip is unreached unless a phase owns that module or another row of it passed (a
 * generated row that has nothing to assert skips beside the hand row that does), and a phase
 * must pass at least one row of its own module: its filter leaves every other test skipped, so
 * those are not counted.
 * A module in `requiring` has rows that each pin a branch, so each row must pass in the build
 * that carries its branch: a row title that passed in neither build is unreached by name.
 * `strict` is off when the caller filtered the base run itself, where a skip is the caller's doing.
 * `tolerated` names modules whose skip is expected because nothing can install them.
 * `expected` is the modules the registry calls verified; any without a passing row is `missing`,
 * so a run that executed fewer rows than the registry claims fails rather than passing smaller.
 */
export function summarise(
	base: Report | undefined,
	phases: Record<string, Report>,
	strict: boolean,
	expected: readonly string[] = [],
	tolerated: readonly string[] = [],
	requiring: readonly string[] = []
) {
	const out: Summary = {
		passed: 0,
		failed: 0,
		skipped: 0,
		failing: [],
		unreached: [],
		verified: [],
		missing: []
	};
	const seen = new Map<string, { passed: number; failed: number }>();
	const skipped: string[] = [];
	const note = (title: string, status: string) => {
		const name = subjectOf(title);
		if (name === undefined) return;
		const row = seen.get(name) ?? { passed: 0, failed: 0 };
		if (status === 'passed') row.passed++;
		if (status === 'failed') row.failed++;
		seen.set(name, row);
	};
	const count = (r: Result, name: string) => {
		note(r.title, r.status);
		if (r.status === 'passed') out.passed++;
		else if (r.status === 'failed') {
			out.failed++;
			out.failing.push(name);
		} else out.skipped++;
	};
	for (const r of base ? resultsOf(base) : []) {
		const name = subjectOf(r.title) ?? r.title;
		count(r, name);
		if (
			strict &&
			r.status !== 'passed' &&
			r.status !== 'failed' &&
			!(name in phases) &&
			!tolerated.includes(name)
		) {
			skipped.push(name);
		}
	}
	out.unreached = skipped.filter((name) => !seen.get(name)?.passed);
	for (const [module, report] of Object.entries(phases)) {
		const own = resultsOf(report).filter((r) => subjectOf(r.title) === module);
		for (const r of own) count(r, module);
		if (!own.some((r) => r.status === 'passed')) out.unreached.push(module);
		if (requiring.includes(module)) {
			const rows = new Map<string, boolean>();
			for (const r of [...(base ? resultsOf(base) : []), ...own]) {
				if (subjectOf(r.title) !== module) continue;
				rows.set(r.title, (rows.get(r.title) ?? false) || r.status === 'passed');
			}
			for (const [title, passed] of rows) if (!passed) out.unreached.push(title);
		}
	}
	out.failing = [...new Set(out.failing)];
	out.unreached = [...new Set(out.unreached)];
	out.verified = [...seen]
		.filter(([name, row]) => row.passed > 0 && row.failed === 0)
		.map(([name]) => name)
		.sort();
	if (strict && base) out.missing = expected.filter((name) => !out.verified.includes(name));
	return out;
}

/** the share of weekly usage held by the modules that passed, from `{ counts: { name: n } }` */
export function usageShare(counts: Readonly<Record<string, number>>, verified: readonly string[]) {
	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	const have = new Set(verified);
	const held = Object.entries(counts).reduce((a, [name, n]) => a + (have.has(name) ? n : 0), 0);
	return { held, total, share: total === 0 ? 0 : held / total };
}

/** the job summary: counts, each failing module, each unreached one, and the share when known */
export function renderSummary(s: Summary, share?: ReturnType<typeof usageShare>): string {
	const list = (names: string[]) => (names.length > 0 ? names.join(', ') : 'none');
	const lines = [
		'## Contrib lane',
		'',
		`${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped.`,
		'',
		`Failing: ${list(s.failing)}`,
		`Unreached: ${list(s.unreached)}`,
		`Verified in the registry with no passing row: ${list(s.missing)}`
	];
	if (share) {
		const pct = (share.share * 100).toFixed(2);
		lines.push(
			'',
			`Usage-weighted share: ${share.held} of ${share.total} weekly installs, ${pct}%.`
		);
	}
	return `${lines.join('\n')}\n`;
}
