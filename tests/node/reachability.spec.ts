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
 * Modules that are not on the edge, each with the reason it is allowed to be.
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
		'the record of what each contrib run asserted; module-table.spec.ts and contrib-verify.spec.ts read it'
	],
	// the discovery half of the replica work, and it must NEVER reach the edge: it RECORDS effects
	// where `src/ops/replica.ts` refuses them, so a replica running this would learn what a request
	// does by letting it happen. effect-census.spec.ts drives it
	[
		'src/ops/mutation-oracle.ts',
		'effect census; records rather than refuses, so it is a measurement instrument and not edge code'
	],
	// alias targets, reached through wrangler `alias` rather than through an import
	['src/runtime/php-binary-jspi.ts', 'alias target for the JSPI probe configs'],
	['src/runtime/php-binary-o2.ts', 'alias target for the -O2 probe configs'],
	[
		'src/runtime/php-binary-raw.ts',
		'the SHIPPING alias target since 2026-09-04, when the compressed bundle limit went; reached through the wrangler alias, so the import scan cannot see it'
	]
	// `src/runtime/php-binary-zstd.ts` was here and is DELETED. Nothing aliased it: the experiment
	// configs name the o2, jspi and 85 seams, and the shipping one is now the raw import. The zstd
	// PACKER survives, because `pack:wasm` still frames the 8.3 binary and the experiment arms.
	// `src/ops/tail-worker.ts` and `src/drupal/capabilities.ts` were listed here as KNOWN DEAD and
	// have since been deleted. The stale-exemption check below is what caught the removal -- it
	// failed with both names the moment the files went, which is the direction that is easy to get
	// wrong: an allow-list nobody prunes is how the next dead module gets waved through.
]);

/**
 * Named exports that must be CALLED from somewhere under `src/`, not merely exported and tested.
 *
 * `unusedExports` has always been reported and asserted on by nothing, which is how a whole
 * lifecycle went missing: `updbPrepare` -- the only thing that can START a database-update run --
 * was exported, covered by its own unit spec, and reached from no shipping code, so `/updb` could
 * advance a run nothing was able to create and an operator saw `{"beat":"none","reason":"no-run"}`.
 * `degradeHeaders` was the same shape one module over.
 *
 * This is deliberately a short NAMED list rather than a blanket "no unused exports" rule. Most
 * entries in that report are the legitimate exported-for-its-unit-test pattern, and a rule that
 * fails on all 785 of them would be turned off within a week. What belongs here is a function
 * whose absence from `src/` means a capability does not exist on a deployed site.
 */
const MUST_BE_CALLED = new Map<string, string>([
	[
		'updbPrepare',
		'nothing else can START an update run; without it /updb only ever reports no-run'
	],
	['updbRollback', 'the operator decision that clears a halted run so a new one may be prepared'],
	['updbAbandon', 'the other half of that decision, and the one that records a written reason'],
	['updbDrain', 'runs several beats in one invocation, which is what a paid plan wants'],
	[
		'degradeHeaders',
		'the only thing that makes the `reduced` band observable on an answered response'
	]
]);

type Scan = {
	scanned: number;
	edge: number;
	offEdge: { file: string; reach: string }[];
	dead: { file: string }[];
	unusedExports: { file: string; name: string; testOnly: boolean }[];
	boundary: {
		importsCms: string[];
		violations: { file: string; imports: string[] }[];
		unclassified: string[];
		stale: string[];
		unclassifiedRoutes: string[];
		staleRoutes: string[];
	};
};

/**
 * MEMOISED. The scan shells out to a bun process that walks every import under `src/`, which is
 * ~9.5 s; five assertions calling it directly spent that five times for one answer that cannot
 * change between them.
 */
let scanned: Scan | null = null;

function scan(): Scan {
	if (scanned) return scanned;
	const out = execFileSync('bun', ['scripts/qa/reachability.ts', '--json'], {
		cwd: ROOT,
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024
	});
	return (scanned = JSON.parse(out) as Scan);
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

	it('leaves nothing dead outside the build-lane tools and the alias targets', () => {
		// the whole finding as one list: everything off the edge now has a reason, and the two
		// modules that did not (tail-worker, capabilities) were deleted rather than exempted.
		// dormancy reads as `dead` rather than `script` because a vitest spec drives it, not a bun
		// entrypoint -- which is accurate, and why it carries a reason above.
		//
		// `module-table.ts` LEFT this list by gaining a producer. `scripts/install-census.ts` reads
		// it to install the census into `drupal-src`, so a bun entrypoint reaches it and the scan
		// classifies it `script`. That is the direction this list is meant to move in.
		const dead = scan().dead.map((r) => r.file);
		expect(dead).toEqual([
			'src/ops/dormancy.ts',
			'src/ops/mutation-oracle.ts',
			'src/runtime/php-binary-jspi.ts',
			'src/runtime/php-binary-o2.ts',
			'src/runtime/php-binary-raw.ts'
		]);
	});
});

/**
 * A module can be on the edge while the FUNCTION that matters in it is not.
 *
 * `src/ops/updb.ts` was reachable the whole time -- `updbStep()` is called from the alarm -- so
 * every check above was green while the four lifecycle calls beside it were exported, unit-tested
 * and called by nothing. Module-level reachability cannot see that; this can.
 */
describe('the exports a capability depends on are called from src/, not only tested', () => {
	it('finds each named export still reached from shipping code', () => {
		const unused = new Set(scan().unusedExports.map((e) => e.name));
		const missing = [...MUST_BE_CALLED.keys()].filter((name) => unused.has(name));
		expect(
			missing.map((name) => `${name}: ${MUST_BE_CALLED.get(name)}`),
			'exported, tested, and reached from nothing under src/'
		).toEqual([]);
	});

	// the list only means anything if the report it reads can actually say "unused", so this is
	// the control: something is on that report, or the assertion above passes vacuously
	it('CONTROL: the report is non-empty, so the check above is not vacuous', () => {
		expect(scan().unusedExports.length).toBeGreaterThan(0);
		expect(scan().unusedExports.some((e) => e.testOnly)).toBe(true);
	});
});

/**
 * The CMS boundary, drawn before a second CMS exists and enforced so it stays drawn.
 *
 * `scripts/qa/cms-boundary.ts` declares every module and object route `host`, `cms` or `mixed`. A
 * declaration nothing checks is a paragraph, so a `host` module that gains an import from a `cms`
 * one fails here: either the import goes, or the module is honestly reclassified.
 */
describe('the CMS boundary holds', () => {
	it('no host module imports a cms module', () => {
		expect(
			scan().boundary.violations.map((v) => `${v.file} -> ${v.imports.join(', ')}`)
		).toEqual([]);
	});

	it('every module and every object route is classified, and no entry is stale', () => {
		const b = scan().boundary;
		expect(b.unclassified, 'add these to scripts/qa/cms-boundary.ts').toEqual([]);
		expect(b.unclassifiedRoutes, 'add these to ROUTE_SIDES').toEqual([]);
		expect(b.stale).toEqual([]);
		expect(b.staleRoutes).toEqual([]);
	});

	// the detector has to see a real cms import, or the violation check passes on an empty scan
	it('CONTROL: the scan finds the object importing src/drupal/', () => {
		expect(scan().boundary.importsCms).toContain('src/site-do.ts');
	});
});
