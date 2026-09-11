import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The things that held bytes for the life of an incarnation with nothing to stop them.
 *
 * The JS heap shares the isolate's 128 MiB with wasm linear memory -- measured on a deployed
 * worker, an ordinary serving object is at 87.0% of that ceiling and an authenticated one at 96.8%.
 * An unbounded collection on that heap is not a slow leak to tidy up later; it is the term that
 * decides whether one more workload fits.
 *
 * MOSTLY SOURCE ASSERTIONS, and deliberately. The quantities here are not observable from a reply:
 * a drain that opens 25 connections at once and one that opens 6 return the same body, and a
 * collection that grows forever looks identical to a bounded one until the object dies. The first
 * version of this file drove the bounds by RE-IMPLEMENTING them in the test, which asserts the test
 * rather than the code.
 */

const SOURCE = readFileSync(resolve(import.meta.dirname, '../../src/site-do.ts'), 'utf8');

describe('the mail attempt log', () => {
	// `src/site-do.ts` loads a wasm module at module scope, so the node lane cannot import from it
	// and `trimMails` is asserted through its source rather than called. Exporting it purely to be
	// imported here is the "exported for its unit test" pattern the reachability check flags.
	const trim = /function trimMails\([\s\S]*?\n\}/.exec(SOURCE)?.[0] ?? '';

	it('was found in the source at all, or the rest asserts nothing', () => {
		expect(trim).toBeTruthy();
	});

	it('drops the OLDEST, so the recent sends are the ones kept', () => {
		// `pop()` here would leave a site's first 50 attempts and none of the ones that just
		// failed, which is the opposite of what a diagnostic reader needs
		expect(trim).toContain('mails.shift()');
		expect(trim).not.toContain('mails.pop()');
		expect(trim).toContain('mails.length > MAX_MAIL_ATTEMPTS');
	});

	it('is called at BOTH push sites, the refusal and the success', () => {
		// the refusal path pushes from inside a closure and was the easier one to miss
		const calls = SOURCE.match(/trimMails\(this\.mails/g) ?? [];
		expect(calls.length).toBe(2);
	});
});

describe('the replica refusal window', () => {
	it('bounds the array while reporting the true total', () => {
		// each refusal is an Error WITH A STACK and the array held every one for the incarnation.
		// Only the count and the last message are read, so the window is small -- and the total is
		// carried separately, because bounding the array alone would deflate the figure a failover
		// is counted from
		expect(SOURCE).toContain(
			'if (this.replicaRefusals.length > 20) this.replicaRefusals.shift()'
		);
		expect(SOURCE).toContain('this.replicaRefusalsTotal += 1');
		// and nothing reports the window as if it were the total
		expect(SOURCE).not.toContain('refusals: this.replicaRefusals.length');
	});
});

describe('the outbound drain', () => {
	const drain = /async drainHttpQueue\([\s\S]*?\n\t\}/.exec(SOURCE)?.[0] ?? '';

	it('was found in the source at all, or the rest asserts nothing', () => {
		expect(drain).toBeTruthy();
		expect(drain).toContain('i += 6');
	});

	it('does not start a fetch in the preparation loop', () => {
		// THE COMMENT WAS TRUE AND THE CODE WAS NOT. `run: this.performOutbound(...)` sat in the
		// first loop, so all 25 opened at once and the chunked loop below chunked only the AWAITS,
		// while its own comment said the batch "is chunked rather than opened all at once"
		const prepare = drain.slice(0, drain.indexOf('i += 6'));
		expect(
			prepare.includes('this.performOutbound('),
			'a fetch is started in the preparation loop again, so the whole queue opens at once'
		).toBe(false);
	});

	it('caps a response body instead of buffering whatever arrives', () => {
		// six concurrent unbounded bodies against ~4 MiB of net isolate headroom is the shape that
		// resets an isolate INSIDE one invocation, where the drop guard cannot reach it
		expect(SOURCE).toContain('body: await boundedText(http)');
		expect(SOURCE).toContain('MAX_OUTBOUND_BODY_BYTES = 2 * 1024 * 1024');
		expect(SOURCE).not.toContain('body: await http.text()');
	});
});

describe('the memory tripwire', () => {
	it('samples the whole isolate rather than a sub-term that saturates', () => {
		const observe =
			/observe\(outcomes: \(Payload \| null\)\[\]\): Observation \{[\s\S]*?rowsRing/.exec(
				SOURCE
			)?.[0];
		expect(observe, 'observe() not found').toBeTruthy();
		// it read `lazy.resident`, which `LAZY_FS_BUDGET_BYTES` caps and which saturates -- measured
		// 4,193,165 of 4,194,304 on a deployed object. Four rising readings of THAT cannot happen,
		// which is the same objection the comment there raised against linear memory
		expect(observe).toContain('this.isolateNow()');
		expect(observe).not.toContain('lazy.resident > 0');
	});

	it('labels the finding as the quantity it now watches', () => {
		const supervisor = readFileSync(
			resolve(import.meta.dirname, '../../src/ops/supervisor.ts'),
			'utf8'
		);
		expect(supervisor).not.toContain("scope: 'linear-memory'");
		expect(supervisor).toContain("scope: 'isolate-bytes'");
	});
});
