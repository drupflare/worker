import { describe, expect, it } from 'vitest';
import { FRESH_FIRST_ABORT_REASON, isFreshFirstAbort } from '../../../src/do/fresh/first';
import { ATTEMPT_HEADER, attemptKey } from '../../../src/ops/attempt';
import { objectResetPage, resetRecovery } from '../../../src/site';
import { writesOnGet } from '../../../src/site/guards';
import { sendHop } from '../../../src/site/hop';

/**
 * What the front worker does when the hop to a site's object throws.
 *
 * The routing around it (a fresh stub, the attempt header, the failover hop) is driven in
 * `serve/edge.spec.ts`, which needs the pack; these are the decisions and the page it shows.
 */

// read off a deployed probe: a memory reset carries no `retryable`
const MEMORY_RESET = { overloaded: true, remote: true, durableObjectReset: true };

describe('whether a reset request is sent again', () => {
	it('does not retry an object that is overloaded without having been reset', () => {
		expect(resetRecovery({ retryable: true, overloaded: true }, 'GET')).toBe('refuse');
		expect(resetRecovery(MEMORY_RESET, 'GET')).toBe('retry');
		expect(resetRecovery(MEMORY_RESET, 'POST')).toBe('refuse');
		expect(resetRecovery(MEMORY_RESET, 'POST', true)).toBe('retry');
		expect(resetRecovery({ retryable: true, overloaded: true }, 'POST', true)).toBe('refuse');
		expect(resetRecovery({}, 'POST', true)).toBe('refuse');
		expect(resetRecovery({ retryable: true }, 'HEAD')).toBe('retry');
		expect(resetRecovery(null, 'GET')).toBe('refuse');
	});
});

describe('a GET that runs cron is not sent again on its own', () => {
	it('names the routes that run cron on a GET', () => {
		for (const path of [
			'/cron/ABCDEF123',
			'/cron/ABCDEF123/',
			'/admin/reports/status/run-cron',
			'/wp-cron.php'
		]) {
			expect(writesOnGet(path), path).toBe(true);
		}
		for (const path of [
			'/',
			'/cron',
			'/cron/a/b',
			'/admin/reports/status',
			'/node/1',
			'/crons/x'
		]) {
			expect(writesOnGet(path), path).toBe(false);
		}
	});

	it('refuses a reset GET to such a route unless it carries an attempt id, as a POST is', () => {
		expect(resetRecovery(MEMORY_RESET, 'GET', false, true)).toBe('refuse');
		expect(resetRecovery(MEMORY_RESET, 'HEAD', false, true)).toBe('refuse');
		expect(resetRecovery(MEMORY_RESET, 'GET', true, true)).toBe('retry');
		// every other GET keeps its one retry
		expect(resetRecovery(MEMORY_RESET, 'GET', false, false)).toBe('retry');
		expect(resetRecovery(MEMORY_RESET, 'GET')).toBe('retry');
		// and a refusal still needs a reset, writing route or not
		expect(resetRecovery({}, 'GET', true, true)).toBe('refuse');
	});

	it('shows the "may not have been saved" page for it, since the first try may have run', async () => {
		expect(await objectResetPage('GET', true).text()).toContain('may not have been saved');
		expect(await objectResetPage('GET', false).text()).not.toContain('may not have been saved');
	});
});

describe('the page a visitor gets instead of a 1101', () => {
	it('asks for a retry and is never cached', async () => {
		const res = objectResetPage('GET');
		expect(res.status).toBe(503);
		expect(res.headers.get('retry-after')).toBe('2');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('x-cfw-object-reset')).toBe('1');
		expect(await res.text()).not.toContain('may not have been saved');
	});

	it('warns that a form may not have been saved', async () => {
		expect(await objectResetPage('POST').text()).toContain('may not have been saved');
	});
});

describe('the attempt id a repeated POST carries', () => {
	it('keys only an id the front worker mints', () => {
		const id = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
		expect(ATTEMPT_HEADER).toBe('x-cfw-attempt');
		expect(attemptKey(id)).toBe(`attempt:${id}`);
		expect(attemptKey(id.toUpperCase())).toBeUndefined();
		expect(attemptKey('attempt:../x')).toBeUndefined();
		expect(attemptKey('')).toBeUndefined();
		expect(attemptKey(null)).toBeUndefined();
	});
});

describe('the front worker repeats an aborted flush once, for any method', () => {
	const ABORTED = new Error(`Durable Object reset: ${FRESH_FIRST_ABORT_REASON}`);
	const PLATFORM = Object.assign(new Error('Durable Object reset'), {
		overloaded: true,
		durableObjectReset: true
	});

	/** a front context whose stub answers from a script, recording what it was sent */
	function front(script: Array<Error | Response>) {
		const sent: Request[] = [];
		let forgotten = 0;
		const f = {
			env: {},
			site: 'site',
			visitorPath: '/admin/config/development/performance',
			laneOf: () => ({ role: 'primary', lane: 0 }),
			forgetStub: () => {
				forgotten++;
			},
			stubOf: () => ({
				fetch: async (request: Request) => {
					sent.push(request);
					const next = script.shift();
					if (next instanceof Error) throw next;
					return next ?? new Response('none');
				}
			})
		};
		return { f, sent, forgotten: () => forgotten };
	}

	const flush = () =>
		new Request('https://do.local/__serve?path=%2Fadmin%2Fconfig%2Fdevelopment%2Fperformance', {
			method: 'POST',
			body: 'op=Clear'
		});
	const hopOf = async (method = 'POST') => {
		const innerRequest = method === 'POST' ? flush() : new Request('https://do.local/__serve');
		const buffered = method === 'POST' ? await innerRequest.clone().arrayBuffer() : undefined;
		return { innerRequest, buffered, attempt: undefined };
	};

	it('sends a POST again with the retry header and marks the answer', async () => {
		const { f, sent, forgotten } = front([ABORTED, new Response('done', { status: 303 })]);
		const out = (await sendHop(f as never, await hopOf())) as { res: Response };
		expect(out.res.status).toBe(303);
		expect(out.res.headers.get('x-cfw-retried')).toBe('abort');
		expect(sent).toHaveLength(2);
		expect(sent[0]!.headers.get('x-cfw-retried')).toBeNull();
		expect(sent[1]!.headers.get('x-cfw-retried')).toBe('abort');
		expect(await sent[1]!.text()).toBe('op=Clear');
		expect(forgotten()).toBe(1);
	});

	it('does not loop: a second abort on the repeat answers the reset page', async () => {
		const { f, sent } = front([ABORTED, ABORTED, new Response('never')]);
		const out = (await sendHop(f as never, await hopOf())) as unknown as Response;
		expect(out.status).toBe(503);
		expect(out.headers.get('x-cfw-object-reset')).toBe('1');
		expect(sent).toHaveLength(2);
	});

	it('leaves a platform reset of a POST with no attempt id on the reset page, as before', async () => {
		const { f, sent } = front([PLATFORM, new Response('never')]);
		const out = (await sendHop(f as never, await hopOf())) as unknown as Response;
		expect(out.status).toBe(503);
		expect(sent).toHaveLength(1);
	});

	it('reads the abort off the failure message and nothing else', () => {
		expect(isFreshFirstAbort(ABORTED)).toBe(true);
		expect(isFreshFirstAbort(PLATFORM)).toBe(false);
		expect(isFreshFirstAbort(null)).toBe(false);
	});
});
