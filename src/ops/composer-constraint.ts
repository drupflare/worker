/**
 * The subset of Composer version constraints this runtime can decide, and an explicit refusal for
 * the rest.
 *
 * Supported: exact, `^`, `~`, `>=` `>` `<=` `<` `!=` `=`, wildcards, AND (space or comma), OR
 * (`||`). Anything else (`as` aliases, `dev-` branches, inline stability flags) is `unknown`.
 * @module
 */

/** three-valued: `unknown` must not collapse into either boolean */
export type Satisfaction = 'yes' | 'no' | 'unknown';

/** a version parsed into comparable parts; `stability` is anything after the numeric run */
export type ParsedVersion = {
	parts: number[];
	stability: string;
};

/**
 * Parses a Composer version into numeric segments plus a trailing stability string.
 *
 * `v` prefixes are stripped (a lock file mixes both spellings). A `dev-` branch has no ordering, so
 * it parses to nothing and comparisons against it are `unknown`, not false.
 */
export function parseVersion(raw: string): ParsedVersion | undefined {
	const trimmed = String(raw ?? '').trim();
	if (trimmed === '') return undefined;
	if (trimmed.startsWith('dev-') || trimmed.endsWith('-dev')) return undefined;
	const body = trimmed.replace(/^v/i, '');
	const match = /^(\d+(?:\.\d+)*)(.*)$/.exec(body);
	if (!match) return undefined;
	// whitespace in the suffix means two glued tokens, not a stability flag (`1.0 dev-weird`)
	if (/\s/.test(match[2] ?? '')) return undefined;
	const parts = (match[1] as string).split('.').map((n) => Number(n));
	if (parts.some((n) => !Number.isFinite(n))) return undefined;
	return { parts, stability: (match[2] ?? '').toLowerCase() };
}

/** rank of a stability suffix (a release outranks every pre-release, Composer's order) */
function stabilityRank(stability: string): number {
	if (stability === '') return 4;
	if (stability.includes('rc')) return 3;
	if (stability.includes('beta')) return 2;
	if (stability.includes('alpha')) return 1;
	if (stability.includes('dev')) return 0;
	// a patch suffix like `-p1` or `+build` is not a pre-release
	return 4;
}

/** -1, 0 or 1, comparing numerically segment by segment then by stability */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
	const len = Math.max(a.parts.length, b.parts.length);
	for (let i = 0; i < len; i++) {
		// a missing segment is 0, so 1.2 and 1.2.0 compare equal
		const left = a.parts[i] ?? 0;
		const right = b.parts[i] ?? 0;
		if (left !== right) return left < right ? -1 : 1;
	}
	const sa = stabilityRank(a.stability);
	const sb = stabilityRank(b.stability);
	if (sa !== sb) return sa < sb ? -1 : 1;
	return 0;
}

/** the exclusive upper bound `^` implies: bump the left-most non-zero segment */
function caretCeiling(v: ParsedVersion): number[] {
	const parts = [...v.parts];
	const at = parts.findIndex((n) => n > 0);
	if (at === -1) {
		// ^0 or ^0.0: nothing non-zero to pin, so the ceiling is the last stated segment + 1
		const last = Math.max(0, parts.length - 1);
		parts[last] = (parts[last] ?? 0) + 1;
		return parts;
	}
	// Composer pins the left-most non-zero digit (npm agrees for x>=1, diverges for 0.x), so ^0.3
	// allows <0.4 and not <1.0
	return parts.slice(0, at + 1).map((n, i) => (i === at ? n + 1 : n));
}

/** the exclusive upper bound `~` implies: bump the last stated segment, dropping one level */
function tildeCeiling(v: ParsedVersion): number[] {
	const parts = [...v.parts];
	if (parts.length === 1) {
		// ~1 means >=1 <2, same as ^1
		return [(parts[0] ?? 0) + 1];
	}
	const at = parts.length - 2;
	return parts.slice(0, at + 1).map((n, i) => (i === at ? n + 1 : n));
}

function lt(a: ParsedVersion, bound: number[]): boolean {
	return compareVersions(a, { parts: bound, stability: '' }) < 0;
}

/** one clause of a constraint, already split on AND/OR */
function satisfiesClause(version: ParsedVersion, clause: string): Satisfaction {
	const c = clause.trim();
	if (c === '' || c === '*') return 'yes';

	// wildcards: 1.2.* means >=1.2.0 <1.3.0
	const wildcard = /^(\d+(?:\.\d+)*)\.\*$/.exec(c);
	if (wildcard) {
		const base = parseVersion(wildcard[1] as string);
		if (!base) return 'unknown';
		if (compareVersions(version, base) < 0) return 'no';
		const ceiling = [...base.parts];
		ceiling[ceiling.length - 1] = (ceiling[ceiling.length - 1] ?? 0) + 1;
		return lt(version, ceiling) ? 'yes' : 'no';
	}

	const operator = /^(\^|~|>=|<=|!=|>|<|=)?\s*(.+)$/.exec(c);
	if (!operator) return 'unknown';
	const op = operator[1] ?? '=';
	const target = parseVersion(operator[2] as string);
	// a dev-branch or otherwise unparseable target is not judged
	if (!target) return 'unknown';

	switch (op) {
		case '^':
			if (compareVersions(version, target) < 0) return 'no';
			return lt(version, caretCeiling(target)) ? 'yes' : 'no';
		case '~':
			if (compareVersions(version, target) < 0) return 'no';
			return lt(version, tildeCeiling(target)) ? 'yes' : 'no';
		case '>=':
			return compareVersions(version, target) >= 0 ? 'yes' : 'no';
		case '>':
			return compareVersions(version, target) > 0 ? 'yes' : 'no';
		case '<=':
			return compareVersions(version, target) <= 0 ? 'yes' : 'no';
		case '<':
			return compareVersions(version, target) < 0 ? 'yes' : 'no';
		case '!=':
			return compareVersions(version, target) !== 0 ? 'yes' : 'no';
		case '=':
			return compareVersions(version, target) === 0 ? 'yes' : 'no';
		default:
			return 'unknown';
	}
}

/**
 * Whether `version` satisfies a Composer `constraint`.
 *
 * OR beats AND in precedence, matching Composer. An `unknown` clause makes its AND group
 * `unknown` (it could have excluded the version; the conservative answer asks a human).
 */
export function satisfies(rawVersion: string, constraint: string): Satisfaction {
	const version = parseVersion(rawVersion);
	if (!version) return 'unknown';
	const text = String(constraint ?? '').trim();
	if (text === '') return 'unknown';

	let sawUnknown = false;
	for (const group of text.split(/\|\|?/)) {
		// per group: an `as` alias in one OR branch must not stop the other from answering
		if (/\bas\b|@(dev|alpha|beta|rc|stable)/i.test(group)) {
			sawUnknown = true;
			continue;
		}
		let groupResult: Satisfaction = 'yes';
		// split on every separator, then re-join a bare operator with what follows it
		// (`>= 1.0 < 2.0` is two clauses)
		const tokens = group
			.split(/[,\s]+/)
			.map((t) => t.trim())
			.filter((t) => t !== '');
		const clauses: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i] as string;
			if (/^(\^|~|>=|<=|!=|>|<|=)$/.test(token) && i + 1 < tokens.length) {
				clauses.push(token + (tokens[i + 1] as string));
				i++;
				continue;
			}
			clauses.push(token);
		}
		if (clauses.length === 0) continue;
		for (const clause of clauses) {
			const result = satisfiesClause(version, clause);
			if (result === 'no') {
				groupResult = 'no';
				break;
			}
			if (result === 'unknown') groupResult = 'unknown';
		}
		if (groupResult === 'yes') return 'yes';
		if (groupResult === 'unknown') sawUnknown = true;
	}
	return sawUnknown ? 'unknown' : 'no';
}
