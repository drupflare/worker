import { describe, expect, it } from 'vitest';
import {
	canaryObservations,
	evaluateCanary,
	reduceEvent,
	summarize,
	type TraceException,
	type TraceLog
} from '../../../src/ops/tail-worker';

/** a trace event in the shape `wrangler tail --format json` emits */
function event({
	url,
	model = 'durableObject',
	cpu = 0,
	wall = 0,
	outcome = 'ok',
	logs = [] as TraceLog[],
	exceptions = [] as TraceException[],
	scheduled = false
}: {
	url?: string;
	model?: string;
	cpu?: number;
	wall?: number;
	outcome?: string;
	logs?: TraceLog[];
	exceptions?: TraceException[];
	scheduled?: boolean;
}) {
	return {
		executionModel: model,
		entrypoint: model === 'durableObject' ? 'AttributionDurableObject' : undefined,
		outcome,
		cpuTime: cpu,
		wallTime: wall,
		exceptions,
		logs,
		event: scheduled ? { scheduledTime: 1 } : { request: { url }, response: { status: 200 } }
	};
}

describe('reduceEvent', () => {
	it('keeps cpuTime, which is the only authoritative absolute', () => {
		const r = reduceEvent(
			event({ url: 'https://x.workers.dev/serve?site=a&path=/', cpu: 46, wall: 900 })
		);
		expect(r.cpuTime).toBe(46);
	});

	it('splits the path from the query', () => {
		const r = reduceEvent(event({ url: 'https://x.workers.dev/serve?site=a&path=/', cpu: 46 }));
		expect(r.path).toBe('/serve');
		expect(r.search).toBe('?site=a&path=/');
	});

	it('labels an alarm rather than dropping it, since it has no request', () => {
		expect(reduceEvent(event({ scheduled: true, cpu: 5 })).path).toBe('(alarm)');
	});

	it('does not throw on a malformed url', () => {
		expect(reduceEvent(event({ url: 'not a url', cpu: 1 })).path).toBe('(none)');
	});

	it('picks a CfwLogger line out of the console output', () => {
		const r = reduceEvent(
			event({
				url: 'https://x.workers.dev/serve',
				logs: [
					{ message: ['{"cfw":"php","level":"error","message":"boom"}'] },
					{ message: ['an unrelated console.log'] }
				]
			})
		);
		expect(r.phpLogs).toHaveLength(1);
		expect(r.phpLogs[0]?.message).toBe('boom');
		// the control: an unrelated console.log must not be mistaken for a Drupal log entry
		expect(r.phpLogs.every((l: { cfw?: string }) => l.cfw === 'php')).toBe(true);
	});
});

describe('summarize', () => {
	const batch = [
		event({ url: 'https://x/serve?path=/', model: 'stateless', cpu: 2 }),
		event({ url: 'https://x/__serve?path=/', cpu: 46 }),
		event({ url: 'https://x/__serve?path=/b', cpu: 8 }),
		event({ scheduled: true, cpu: 5 }),
		event({
			url: 'https://x/__serve?path=/c',
			cpu: 3,
			outcome: 'exceededCpu',
			exceptions: [{ name: 'Error', message: 'over' }]
		})
	];

	it('counts every event', () => expect(summarize(batch).events).toBe(5));

	it('separates the stateless hop from the Durable Object', () => {
		const s = summarize(batch);
		expect(s.byModel.stateless?.n).toBe(1);
		expect(s.byModel.durableObject?.n).toBe(4);
	});

	it('reports the worst invocation, which is what a budget breach looks like', () => {
		expect(summarize(batch).worst?.cpuTime).toBe(46);
	});

	it('counts invocations over the 10 ms free ceiling', () => {
		expect(summarize(batch).overFreeCeiling).toBe(1);
	});

	it('surfaces exceptions', () => {
		const s = summarize(batch);
		expect(s.exceptions).toHaveLength(1);
		expect(s.exceptions[0]).toContain('over');
	});

	it('counts non-ok outcomes per model', () => {
		expect(summarize(batch).byModel.durableObject?.notOk).toBe(1);
	});

	it('summarizes an empty batch to nothing rather than throwing', () => {
		expect(summarize([]).events).toBe(0);
	});
});

describe('canaryObservations', () => {
	const canaryBatch = [
		event({ url: 'https://x/park?canary=abc&leg=park', cpu: 2 }),
		event({ url: 'https://x/park?canary=abc&leg=park', model: 'stateless', cpu: 1 }),
		event({ url: 'https://x/resume?canary=abc&leg=resume', cpu: 88 }),
		event({ url: 'https://x/oneshot?canary=abc&leg=oneshot', cpu: 93 }),
		event({ url: 'https://x/__serve?path=/', cpu: 46 })
	];

	it('observes only the tagged legs', () => {
		expect(canaryObservations(canaryBatch)).toHaveLength(3);
	});

	it('excludes the stateless hop, which is not the invocation being charged', () => {
		expect(canaryObservations(canaryBatch).every((o) => o.cpuTime !== 1)).toBe(true);
	});

	it('identifies a leg from the url, not from arrival order', () => {
		const legs = canaryObservations(canaryBatch)
			.map((o) => o.leg)
			.sort()
			.join(',');
		expect(legs).toBe('oneshot,park,resume');
	});

	it('ignores an untagged request', () => {
		expect(canaryObservations(canaryBatch).some((o) => o.cpuTime === 46)).toBe(false);
	});
});

describe('evaluateCanary: the verdict and its control', () => {
	it('passes on the real measured 2/88/93 result', () => {
		const good = evaluateCanary({ park: 2, resume: 88, oneshot: 93 });
		expect(good.ok).toBe(true);
		// and it says WHY, rather than only that it passed
		expect(good.attribution).toBe(true);
		expect(good.reconciles).toBe(true);
	});

	// THE CONTROL. If attribution moved back to the originating invocation, the parker would
	// be charged and the resumer would be cheap -- the shape that kills slicing.
	it('FAILS when attribution moves to the originating invocation', () => {
		const moved = evaluateCanary({ park: 90, resume: 3, oneshot: 93 });
		expect(moved.ok).toBe(false);
		expect(moved.reason).toContain('kills slicing');
	});

	it('fails the reconciliation half when work is double-charged', () => {
		expect(evaluateCanary({ park: 93, resume: 93, oneshot: 93 }).ok).toBe(false);
	});

	it('fails reconciliation when work vanishes', () => {
		expect(evaluateCanary({ park: 2, resume: 10, oneshot: 93 }).ok).toBe(false);
	});

	it('reports an incomplete run as incomplete, not as a failure of the finding', () => {
		expect(evaluateCanary({ park: 2, resume: 88 }).reason).toContain('incomplete');
	});

	it('refuses a control that burned no CPU rather than dividing by it', () => {
		expect(evaluateCanary({ park: 0, resume: 0, oneshot: 0 }).reason).toContain('no CPU');
	});

	// absolute cpuTime varies by colo -- 46 ms on one deploy, 75 on another -- so the
	// thresholds have to be ratios
	it('is scale-free, so a slower colo still passes', () => {
		expect(evaluateCanary({ park: 5, resume: 210, oneshot: 230 }).ok).toBe(true);
	});
});
