import { describe, expect, it } from 'vitest';
import {
	admissionVerdict,
	canTransition,
	MANDATORY_COLLECTIONS,
	MANDATORY_STATE,
	mandatoryStateDisagreements,
	missingMandatory,
	type AdmissionFacts,
	type ReplicaStage
} from '../../../src/ops/replica-admission';

/**
 * Admission, which is the check that a replica is allowed to exist as one.
 *
 * The assertions that carry weight are the REFUSALS. A replica that serves when it should not is a
 * correctness failure a user meets as an intermittent "form has expired"; a replica that refuses
 * when it could have served is capacity nobody notices. So every ambiguous input here asserts the
 * refusal, and a null on either side of a comparison is treated as a disagreement rather than as an
 * absence of one.
 */

/** a replica with everything, which every case below then takes one thing away from */
const ADMISSIBLE: AdmissionFacts = {
	stage: 'CATCHING_UP',
	presentState: MANDATORY_STATE.map((m) => ({ ...m })),
	presentCollections: [...MANDATORY_COLLECTIONS],
	appliedGeneration: 42,
	advertisedGeneration: 42,
	fingerprint: 'abc123',
	primaryFingerprint: 'abc123',
	schemaVersion: '11.4.5',
	primarySchemaVersion: '11.4.5'
};

const without = (over: Partial<AdmissionFacts>): AdmissionFacts => ({ ...ADMISSIBLE, ...over });

describe('a replica is admitted only when nothing is unknown', () => {
	it('admits the complete case, or nothing below can mean anything', () => {
		const verdict = admissionVerdict(ADMISSIBLE);
		expect(verdict.admitted, verdict.refusals.join(' | ')).toBe(true);
		expect(verdict.stage).toBe('ELIGIBLE');
		expect(verdict.refusals).toEqual([]);
	});

	it('refuses a replica missing any single mandatory value', () => {
		for (const dropped of MANDATORY_STATE) {
			const facts = without({
				presentState: MANDATORY_STATE.filter((m) => m.name !== dropped.name)
			});
			const verdict = admissionVerdict(facts);
			expect(verdict.admitted, `admitted without ${dropped.name}`).toBe(false);
			expect(verdict.refusals.join(' ')).toContain(dropped.name);
		}
	});

	it('refuses a replica missing a mandatory collection', () => {
		for (const dropped of MANDATORY_COLLECTIONS) {
			const facts = without({
				presentCollections: MANDATORY_COLLECTIONS.filter((c) => c !== dropped)
			});
			expect(admissionVerdict(facts).admitted, `admitted without ${dropped}`).toBe(false);
		}
	});

	it('names what is missing rather than refusing silently', () => {
		const missing = missingMandatory(without({ presentState: [], presentCollections: [] }));
		expect(missing).toContain('state:system.private_key');
		expect(missing).toContain('system.schema:*');
	});
});

describe('every unknown resolves toward the primary', () => {
	it('refuses when either fingerprint is absent', () => {
		expect(admissionVerdict(without({ fingerprint: null })).admitted).toBe(false);
		// the primary not having published one is NOT the replica being fine
		expect(admissionVerdict(without({ primaryFingerprint: null })).admitted).toBe(false);
	});

	it('refuses when the fingerprints disagree', () => {
		const verdict = admissionVerdict(without({ fingerprint: 'different' }));
		expect(verdict.admitted).toBe(false);
		expect(verdict.refusals.join(' ')).toContain('fingerprint');
	});

	it('refuses when either schema version is absent or they differ', () => {
		expect(admissionVerdict(without({ schemaVersion: null })).admitted).toBe(false);
		expect(admissionVerdict(without({ primarySchemaVersion: null })).admitted).toBe(false);
		expect(admissionVerdict(without({ schemaVersion: '11.4.4' })).admitted).toBe(false);
	});

	it('refuses a replica that is behind', () => {
		const verdict = admissionVerdict(without({ appliedGeneration: 41 }));
		expect(verdict.admitted).toBe(false);
		expect(verdict.stage).toBe('CATCHING_UP');
	});

	it('refuses a replica that is AHEAD, which is worse than behind', () => {
		// a replica cannot legitimately hold a generation the primary has not advertised: the log
		// was applied out of order, or this object used to be a primary
		const verdict = admissionVerdict(without({ appliedGeneration: 43 }));
		expect(verdict.admitted).toBe(false);
		expect(verdict.refusals.join(' ')).toContain('ahead');
	});

	it('refuses a non-finite generation on either side', () => {
		expect(admissionVerdict(without({ appliedGeneration: Number.NaN })).admitted).toBe(false);
		expect(
			admissionVerdict(without({ advertisedGeneration: Number.POSITIVE_INFINITY })).admitted
		).toBe(false);
	});

	it('refuses a withdrawn replica whatever else is true', () => {
		const verdict = admissionVerdict(without({ stage: 'WITHDRAWN' }));
		expect(verdict.admitted).toBe(false);
		expect(verdict.stage).toBe('WITHDRAWN');
	});
});

describe('the stage machine only goes forward', () => {
	const stages: ReplicaStage[] = [
		'CREATED',
		'RESTORING',
		'VERIFIED',
		'CATCHING_UP',
		'ELIGIBLE',
		'SERVING'
	];

	it('allows each step to the next', () => {
		for (let i = 0; i + 1 < stages.length; i++) {
			expect(canTransition(stages[i]!, stages[i + 1]!)).toBe(true);
		}
	});

	it('refuses every skip', () => {
		for (let i = 0; i < stages.length; i++) {
			for (let j = i + 2; j < stages.length; j++) {
				expect(canTransition(stages[i]!, stages[j]!), `${stages[i]} -> ${stages[j]}`).toBe(
					false
				);
			}
		}
	});

	it('refuses every backward step', () => {
		for (let i = 1; i < stages.length; i++) {
			for (let j = 0; j < i; j++) {
				expect(canTransition(stages[i]!, stages[j]!), `${stages[i]} -> ${stages[j]}`).toBe(
					false
				);
			}
		}
	});

	it('withdraws from anywhere and re-enters only at CREATED', () => {
		for (const s of stages) expect(canTransition(s, 'WITHDRAWN')).toBe(true);
		expect(canTransition('WITHDRAWN', 'CREATED')).toBe(true);
		expect(canTransition('WITHDRAWN', 'SERVING')).toBe(false);
		expect(canTransition('WITHDRAWN', 'WITHDRAWN')).toBe(false);
	});
});

describe('the mandatory set agrees with the shared classifier', () => {
	it('classifies every mandatory key as AUTHORITATIVE', () => {
		// a mandatory key the classifier calls derived would be replicated as recomputable and
		// regenerated per replica, which for `system.private_key` is the token-rejection bug
		expect(mandatoryStateDisagreements()).toEqual([]);
	});
});
