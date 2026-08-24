import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	TABLES,
	diffCase,
	diffInt,
	emitTables,
	expand,
	expandInt,
	jsCasing,
	nativeCorpus,
	readArtifact,
	subjectSweep,
	type Packed
} from '../../scripts/measure/unicode-corpus';

/**
 * P27's corpus, asserted rather than described.
 *
 * The 1,232 hand-chosen cases in `mb-parity.php` sample. They cannot see a wrong TABLE, which is
 * why a one-off sweep of every scalar value found 95 lower, 95 upper and 273 titlecase mappings
 * wrong and `mb_strwidth` wrong on 9,733 -- none of it visible to a suite that was green. This file
 * makes that sweep a permanent artifact with three properties:
 *
 *   1. the artifact is what the real extension answers, re-derived here rather than trusted
 *   2. the shipping tables are what the artifact implies, so a hand-edit fails
 *   3. the shipping stack diverges on ZERO scalars, which is the number the tables exist to move
 *
 * Needs a native php with mbstring, so it follows `php-fragments.spec.ts`: skipped locally when php
 * is absent, hard-failed in CI, because a run that skipped the only oracle it has is
 * indistinguishable from one that passed.
 */

const php = (() => {
	try {
		execFileSync('php', ['-v'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

if (!php && process.env.CI) {
	throw new Error(
		'CI has no php, so the unicode corpus has no oracle; install php or fix the image'
	);
}

const describeIfPhp = php ? describe : describe.skip;

describeIfPhp('the Unicode corpus artifact', () => {
	it('is byte-for-byte what a fresh sweep of the real extension produces', () => {
		const fresh = nativeCorpus();
		const checkedIn = readArtifact();
		// provenance first: a data mismatch under a different mbstring is a stale PIN, and the
		// two failures want different fixes
		expect(
			fresh.provenance.mbstring,
			'the artifact was generated against a different mbstring; re-run `bun run measure:unicode --write`'
		).toBe(checkedIn.provenance.mbstring);
		expect(JSON.stringify(fresh)).toBe(JSON.stringify(checkedIn));
	}, 60_000);

	it('pins the oracle it came from', () => {
		const c = readArtifact();
		expect(c.provenance.php).toMatch(/^\d+\.\d+\.\d+/);
		expect(c.provenance.mbstring).toBeTruthy();
		// every scalar value, not a sample: 0x110000 minus the 2,048 surrogates
		expect(c.provenance.scalars).toBe(0x110000 - 2048);
	});

	it('covers the families a codepoint sweep cannot reach', () => {
		const c = readArtifact();
		// lone bytes, boundary continuations, truncations, overlongs, surrogate and
		// out-of-range encodings, each with the extension's own mb_scrub answer
		expect(c.bytes.length).toBeGreaterThan(2000);
		expect(c.offsets.cases.length).toBeGreaterThan(100);
		for (const [input, scrub, valid] of c.bytes) {
			expect(input).toMatch(/^[0-9a-f]*$/);
			expect(scrub).toMatch(/^[0-9a-f]*$/);
			expect(valid === 0 || valid === 1).toBe(true);
		}
		// a corpus of only well-formed input would prove nothing about the sanitiser
		expect(c.bytes.some(([, , valid]) => valid === 0)).toBe(true);
	});
});

describeIfPhp('the shipping tables', () => {
	it('are exactly what the artifact implies, so a hand-edit fails', () => {
		const c = readArtifact();
		const nat = {
			lower: expand(c.case.lower),
			upper: expand(c.case.upper),
			title: expand(c.case.title)
		};
		const s = subjectSweep();
		const bare = {
			lower: expand(s.bare.case.lower as Packed),
			upper: expand(s.bare.case.upper as Packed),
			title: expand(s.bare.case.title as Packed)
		};
		const entry = (cps: number[], m: Map<number, number[]>) =>
			cps.map((cp) => [cp, m.get(cp) ?? [cp]] as [number, number[]]);
		const fresh = emitTables({
			lower: entry(diffCase(nat.lower, bare.lower), nat.lower),
			upper: entry(diffCase(nat.upper, bare.upper), nat.upper),
			title: entry(diffCase(nat.title, bare.title), nat.title),
			fold: [...nat.lower.entries()]
				.filter(([, res]) => res.length > 1)
				.map(([cp, res]) => [cp, [res[0]]] as [number, number[]]),
			width: c.width,
			titleExtra: c.titleExtra
		});
		expect(fresh, 'run `bun run measure:unicode --write`').toBe(readFileSync(TABLES, 'utf8'));
	}, 60_000);

	it('takes the shipping stack to zero divergent scalars', () => {
		const c = readArtifact();
		const s = subjectSweep();
		const ship = {
			lower: expand(s.ship.case.lower as Packed),
			upper: expand(s.ship.case.upper as Packed),
			title: expand(s.ship.case.title as Packed),
			width: expandInt(s.ship.width)
		};
		// the four numbers the tables exist to move, measured against 1,112,064 scalars each
		expect(diffCase(expand(c.case.lower), ship.lower)).toEqual([]);
		expect(diffCase(expand(c.case.upper), ship.upper)).toEqual([]);
		expect(diffCase(expand(c.case.title), ship.title)).toEqual([]);
		expect(diffInt(expandInt(c.width), ship.width)).toEqual([]);
	}, 60_000);

	/**
	 * The other half of the guard, and the one that is easy to skip.
	 *
	 * The table is not in the bundle; it arrives with `assets/driver.json` and is required from a
	 * mounted path. So "the pack is not there" is a reachable state, and it has to degrade to the
	 * polyfill's own answers rather than fatal on an undefined function or a null pattern. A
	 * fragment that only works when its data is present is a fragment nobody can boot without it.
	 */
	it('degrades to the polyfill, not to a fatal, when the table is not mounted', () => {
		const c = readArtifact();
		const s = subjectSweep({ tables: '/nonexistent/unicode-tables.php' });
		expect(diffCase(expand(c.case.lower), expand(s.ship.case.lower as Packed)).length).toBe(95);
		expect(diffCase(expand(c.case.upper), expand(s.ship.case.upper as Packed)).length).toBe(95);
		// strwidth falls all the way back to the polyfill's frozen ranges rather than to width 1
		expect(diffInt(expandInt(c.width), expandInt(s.ship.width)).length).toBe(9733);
		// title keeps the grammar fix, which needs no table, and loses only the extra class
		const title = diffCase(expand(c.case.title), expand(s.ship.case.title as Packed)).length;
		expect(title).toBeGreaterThan(0);
		expect(title).toBeLessThanOrEqual(273);
	}, 60_000);

	it('reduces the BARE polyfill by the amounts on record', () => {
		const c = readArtifact();
		const s = subjectSweep();
		// the four figures P27 was opened with. They are a property of the pinned polyfill
		// version, so a change here means upstream regenerated its unidata, not that this broke
		expect(diffCase(expand(c.case.lower), expand(s.bare.case.lower as Packed)).length).toBe(95);
		expect(diffCase(expand(c.case.upper), expand(s.bare.case.upper as Packed)).length).toBe(95);
		expect(diffCase(expand(c.case.title), expand(s.bare.case.title as Packed)).length).toBe(
			273
		);
		expect(diffInt(expandInt(c.width), expandInt(s.bare.width)).length).toBe(9733);
	}, 60_000);
});

describeIfPhp('the ICU vintage of this runtime', () => {
	/**
	 * The tables come from mbstring, never from a JavaScript engine, and this is what says so.
	 *
	 * A generator written against `toLowerCase` would bake in whichever ICU the runtime happened
	 * to carry. `tests/unit/drupal/unicode-workerd.spec.ts` runs the same sweep inside workerd;
	 * running it here too is how a disagreement between the two engines becomes visible instead
	 * of becoming a wrong table.
	 */
	it('is recorded against the extension rather than assumed', () => {
		const c = readArtifact();
		const js = jsCasing();
		const lower = diffCase(expand(c.case.lower), js.lower);
		const upper = diffCase(expand(c.case.upper), js.upper);
		const engine = process.versions.bun
			? `bun ${process.versions.bun}`
			: `node ${process.versions.node}`;
		console.log(
			`[unicode] ${engine}: ${lower.length} lower / ${upper.length} upper scalars ` +
				'differ from mbstring'
		);
		// no threshold on purpose -- the point is that the number exists and is not the oracle
		expect(Array.isArray(lower)).toBe(true);
		expect(Array.isArray(upper)).toBe(true);
	}, 60_000);
});
