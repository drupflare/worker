import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A module under `src/` that nothing on the edge imports is shipped-looking dead code.
 *
 * This exists because the whole health layer was exactly that: `src/ops/supervisor.ts` -- 11
 * tripwires, the ledger, the circuit breaker, `quarantineDecision` -- was imported by
 * `tests/unit/ops/supervisor.spec.ts` and by nothing in `src/`. Every one of them was green in CI
 * and absent from the running site, and `repair_state` was read by the quarantine branch and
 * written by nobody, which made L4 and L5 unreachable by construction rather than unbuilt.
 *
 * A unit test cannot catch that, because the thing it proves is that the function works.
 */

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * Modules deliberately not on the edge, each with the reason it is allowed to be.
 *
 * This list may SHRINK without ceremony. Adding to it is the thing to think twice about: an entry
 * here is a promise that the module is reached some other way, not a way to silence the check.
 */
const ALLOWED_OFF_EDGE = new Map<string, string>([
	// build-lane tools, which are correct to be off the edge: both produce or check an artifact and
	// neither has anything to do at request time
	['src/ops/dormancy.ts', 'artifact auditor; tests/node/dormancy.spec.ts drives it'],
	[
		'src/ops/module-table.ts',
		'regenerates the README table; tests/node/module-table.spec.ts drives it'
	],
	// alias targets, reached through wrangler `alias` rather than through an import
	['src/runtime/php-binary-jspi.ts', 'alias target for the JSPI probe configs'],
	['src/runtime/php-binary-o2.ts', 'alias target for the -O2 probe configs'],
	['src/runtime/php-binary-zstd.ts', 'alias target for the zstd probe configs'],
	// KNOWN DEAD, listed so the count is honest rather than to excuse them. Both are the same shape
	// the health layer was in: written, tested, and reached by nothing.
	//
	// `tail-worker.ts` is a tail consumer with 17 exports and a unit spec, and NO wrangler config
	// declares `tail_consumers`, so nothing has ever run it.
	// `capabilities.ts` is imported by nothing at all -- not by src, not by a script, not even by a
	// test; only a comment in scripts/qa/modules.ts mentions the concept.
	['src/ops/tail-worker.ts', 'DEAD: no wrangler config declares tail_consumers'],
	['src/drupal/capabilities.ts', 'DEAD: imported by nothing, including tests']
]);

type Scan = {
	scanned: number;
	edge: number;
	offEdge: { file: string; reach: string }[];
	dead: { file: string }[];
};

function scan(): Scan {
	const out = execFileSync('bun', ['scripts/qa/reachability.ts', '--json'], {
		cwd: ROOT,
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024
	});
	return JSON.parse(out) as Scan;
}

describe('every module under src/ is reachable, or is allowed not to be by name', () => {
	it('finds no module off the edge that is not on the allow-list', () => {
		const unexplained = scan()
			.offEdge.map((r) => r.file)
			.filter((f) => !ALLOWED_OFF_EDGE.has(f));
		expect(unexplained).toEqual([]);
	});

	it('keeps the allow-list honest: every entry is still actually off the edge', () => {
		const offEdge = new Set(scan().offEdge.map((r) => r.file));
		// an entry that has since been wired up is a stale exemption, and a stale exemption is how
		// the next dead module gets waved through
		const stale = [...ALLOWED_OFF_EDGE.keys()].filter((f) => !offEdge.has(f));
		expect(stale).toEqual([]);
	});

	it('the health layer is on the edge, which is the regression this file was written for', () => {
		const offEdge = new Set(scan().offEdge.map((r) => r.file));
		expect(offEdge.has('src/ops/supervisor.ts')).toBe(false);
		expect(offEdge.has('src/ops/repair.ts')).toBe(false);
	});
});
