import { describe, expect, it } from 'vitest';
import { artifactGate } from './helpers/artifact-gate';

/**
 * The helper that decides whether an acceptance check is ON, and it had never been exercised.
 *
 * Six specs read it, and what they get from it is not "skip when unbuilt" -- it is the ASYMMETRY: a
 * local checkout skips and a lane that declared it has the artifacts fails, naming each missing one.
 * A skipped acceptance test is indistinguishable from a passing one, so the throw is the whole
 * value, and it was the half nothing ran. `container-cid.spec.ts` demonstrated the cost of getting
 * this wrong twice over: it gated on a bare `existsSync`, so it skipped in every lane including the
 * release one, and the drift it guards shipped.
 */

/** a path no checkout has, so the missing branch is reached without touching a real artifact */
const ABSENT = 'assets/drupal-pf/a-file-no-lane-builds.json';

/** present on every machine and in CI, so the satisfied branch is reached the same way */
const PRESENT = 'package.json';

function withRequire<T>(value: string | undefined, fn: () => T): T {
	const before = process.env.REQUIRE_ARTIFACTS;
	if (value === undefined) delete process.env.REQUIRE_ARTIFACTS;
	else process.env.REQUIRE_ARTIFACTS = value;
	try {
		return fn();
	} finally {
		if (before === undefined) delete process.env.REQUIRE_ARTIFACTS;
		else process.env.REQUIRE_ARTIFACTS = before;
	}
}

describe('the artifact gate', () => {
	it('does not skip when every artifact is present', () => {
		expect(withRequire(undefined, () => artifactGate([PRESENT]))).toBe(false);
		expect(withRequire('1', () => artifactGate([PRESENT]))).toBe(false);
	});

	it('skips rather than throwing in a lane that made no claim', () => {
		expect(withRequire(undefined, () => artifactGate([ABSENT]))).toBe(true);
	});

	it('throws in a lane that says it has them, which is the half that makes a skip safe', () => {
		expect(() => withRequire('1', () => artifactGate([ABSENT]))).toThrow(/REQUIRE_ARTIFACTS/);
	});

	it('names the missing artifact and how to get it, not just that one is missing', () => {
		// a lane that fails without saying which file and which command is a lane nobody can fix
		expect(() => withRequire('1', () => artifactGate([ABSENT, PRESENT]))).toThrow(ABSENT);
		expect(() => withRequire('1', () => artifactGate([ABSENT]))).toThrow(/bun run hydrate/);
	});

	it('refuses one missing artifact among present ones, rather than passing on a majority', () => {
		expect(withRequire(undefined, () => artifactGate([PRESENT, ABSENT]))).toBe(true);
	});

	it('is satisfied by an empty list, so a spec cannot gate on nothing and read as gated', () => {
		expect(withRequire('1', () => artifactGate([]))).toBe(false);
	});
});
