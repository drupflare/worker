import { describe, expect, it } from 'vitest';
import { capabilityVectors } from '../../src/drupal/site-php';
import {
	CAPABILITY_GROUPS,
	VECTORS,
	refusalFor,
	scoreModule,
	vectorFor,
	vectorsIn
} from '../../src/ops/capability-contract';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * P8: every capability vector, executed against the interpreter that ships.
 *
 * ## What this file is FOR
 *
 * `capability-contract.ts` is a table of claims, and a table of claims about a runtime is exactly
 * the thing this project keeps catching itself getting wrong -- [[decorative-configuration]],
 * [[inert-shim-guard]], [[tested-but-never-called]] are all the same shape. So the table is not
 * allowed to be a reading. Every row carries a PROBE, this runs all of them in one boot, and each
 * answer must equal the row's `expected`.
 *
 * **The assertion is two-directional and that is the point.** A capability that quietly APPEARS
 * fails here as loudly as one that quietly disappears, so the contract cannot drift from the runtime
 * in either direction. A row that reads `expected: false` and starts answering `true` is a capability
 * nobody knew they had, and the module table would go on refusing modules that would now work.
 */

const REQUEST_TIMEOUT = 900_000;

type Answers = {
	vectors: Record<string, boolean>;
	/** why a probe answered false, when it threw; a `false` with no entry is a real absence */
	why: Record<string, string>;
	meta: Record<string, unknown>;
};

let cached: Answers | null = null;

async function runVectors(): Promise<Answers> {
	if (cached) return cached;
	const probes = Object.fromEntries(VECTORS.map((v) => [v.id, v.probe]));
	const out = await inObject(freshSite(), async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		return (await site.runJson(capabilityVectors(probes))) as unknown as Answers;
	});
	cached = out;
	return out;
}

describe('P8: the contract is well-formed before it is measured', () => {
	it('has unique ids, a known group and evidence on every vector', () => {
		const ids = VECTORS.map((v) => v.id);
		expect(new Set(ids).size, 'a duplicate id makes one row unreachable').toBe(ids.length);
		for (const v of VECTORS) {
			expect(CAPABILITY_GROUPS, `${v.id} is in an unknown group`).toContain(v.group);
			expect(v.evidence.length, `${v.id} has no evidence`).toBeGreaterThan(20);
			expect(v.claim.length, `${v.id} has no claim`).toBeGreaterThan(10);
			expect(v.id, 'ids are dotted lowercase; a module declares them').toMatch(
				/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
			);
		}
	});

	it('names a blocker for every unsatisfied vector and none for a satisfied one', () => {
		for (const v of VECTORS) {
			if (v.expected) {
				expect(v.blocker, `${v.id} is satisfied but names a blocker`).toBeNull();
			} else {
				// an unsatisfied vector with no blocker is an item nobody can act on: a reader cannot
				// tell "never" from "not yet", which is the distinction that decides a roadmap
				expect(v.blocker, `${v.id} is unsatisfied and names no blocker`).not.toBeNull();
			}
		}
	});

	it('covers all seven groups, so the matrix has no empty column', () => {
		for (const group of CAPABILITY_GROUPS) {
			expect(vectorsIn(group).length, `${group} has no vectors`).toBeGreaterThan(0);
		}
	});

	it('EXECUTES rather than declares, in every group', () => {
		// The gap this closes: 21 of 32 probes were `function_exists` / `class_exists`, and SIX were
		// the literal `true` or `false` -- a probe that cannot fail, asserting what the row it sits
		// in already claims. MEDIA, ASYNC and CACHE had no executed vector at all, so three of the
		// seven columns were a reading of the source dressed as a measurement.
		for (const group of CAPABILITY_GROUPS) {
			const executed = vectorsIn(group).filter((v) => v.kind === 'executed');
			expect(executed.length, `${group} has no EXECUTED vector`).toBeGreaterThan(0);
		}
		// a literal is banned outright, in either kind: it makes the drift check vacuous for its row
		for (const v of VECTORS) {
			expect(v.probe.trim(), `${v.id} probes a constant`).not.toMatch(/^(true|false)$/);
		}
		// the label cannot lie in the cheap direction. Strip the existence calls and require
		// something to be LEFT -- not "contains a call", because `runtime.int64` reads
		// `PHP_INT_SIZE` straight off the interpreter and is as executed as anything here, and not
		// an anchored match, because `runtime.mbstring.core_parity` guards a real comparison with one
		const EXISTENCE =
			/\b(function_exists|class_exists|interface_exists|method_exists|extension_loaded|defined)\s*\([^)]*\)/g;
		for (const v of VECTORS.filter((v) => v.kind === 'executed')) {
			const residue = v.probe.replace(EXISTENCE, '').replace(/[\s&|!]+/g, '');
			expect(
				residue.length,
				`${v.id} says executed but only asks whether symbols exist`
			).toBeGreaterThan(0);
		}
	});

	it('holds the declaration-only count as a ratchet rather than a target', () => {
		// 12 remain, each for a stated reason: the claim IS about a declaration
		// (`runtime.exec.declared`), the negative is structural rather than runnable (`async.cron`
		// cannot be executed without running cron), or the round trip is asserted by a named spec.
		// A new one has to displace an old one rather than be added, which is what this number is for
		const declared = VECTORS.filter((v) => v.kind === 'declared');
		expect(declared.length, declared.map((v) => v.id).join(', ')).toBeLessThanOrEqual(12);
		for (const v of declared) {
			expect(v.evidence.length, `${v.id} is declared and must say why`).toBeGreaterThan(40);
		}
	});
});

describe('P8: every vector, on the interpreter that ships', () => {
	it(
		'answers exactly what the contract says it answers',
		async () => {
			const out = await runVectors();
			const rows = VECTORS.map((v) => ({
				id: v.id,
				expected: v.expected,
				actual: out.vectors[v.id]
			}));
			const drift = rows.filter((r) => r.actual !== r.expected);
			console.log(
				`[p8] ${VECTORS.length} vectors, ${rows.filter((r) => r.actual).length} satisfied` +
					(drift.length
						? `, DRIFT: ${JSON.stringify(drift)} WHY: ${JSON.stringify(out.why)}`
						: '')
			);

			// named individually rather than as a count, so a failure says WHICH capability moved
			for (const v of VECTORS) {
				expect(
					out.vectors[v.id],
					`${v.id} answered ${String(out.vectors[v.id])}, contract says ${String(v.expected)}. ` +
						`${out.why[v.id] ?? 'no throw, so the capability is genuinely absent'}. ${v.evidence}`
				).toBe(v.expected);
			}
		},
		REQUEST_TIMEOUT
	);

	it(
		'ran against the interpreter the rest of the gate runs',
		async () => {
			const out = await runVectors();
			// the control: a probe set answered by a stub, or by 8.3 when 8.5 ships, would be a
			// table of confident wrong answers. CLAUDE.md records that exact divergence
			expect(String(out.meta.php)).toMatch(/^8\.5\./);
			expect(out.meta.intSize).toBe(8);
			expect(out.meta.booted, JSON.stringify(out.meta.bootError ?? '')).toBe(true);
		},
		REQUEST_TIMEOUT
	);
});

describe('P8: scoring a module against the contract', () => {
	it('installs a module whose needs are all satisfied', () => {
		const verdict = scoreModule(['http.outbound.deferred', 'async.queue']);
		expect(verdict.installable).toBe(true);
		expect(verdict.unsatisfied).toEqual([]);
		expect(refusalFor(verdict)).toBe('');
	});

	it('refuses one whose needs are not, and names the VECTOR rather than the module', () => {
		const verdict = scoreModule(['http.outbound.deferred', 'async.suspend']);
		expect(verdict.installable).toBe(false);
		expect(verdict.satisfied).toEqual(['http.outbound.deferred']);
		expect(verdict.unsatisfied.map((v) => v.id)).toEqual(['async.suspend']);
		// the sentence a reader needs is "which capability", because that is also what says what
		// would have to change for the answer to move
		expect(refusalFor(verdict)).toContain('async.suspend');
		expect(refusalFor(verdict)).toContain('platform');
	});

	it('REFUSES an unknown id rather than scoring it as needing nothing', () => {
		// the failure mode of every allow-list keyed on a free-form string: a typo silently becomes
		// "this module needs nothing" and the module installs
		const verdict = scoreModule(['htp.outbound.deferred']);
		expect(verdict.installable).toBe(false);
		expect(verdict.unknown).toEqual(['htp.outbound.deferred']);
		expect(refusalFor(verdict)).toContain('does not define');
		expect(vectorFor('htp.outbound.deferred')).toBeUndefined();
	});

	it('installs a module that declares nothing, which is most of them', () => {
		expect(scoreModule([]).installable).toBe(true);
	});
});
