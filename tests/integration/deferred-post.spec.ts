import { afterEach, describe, expect, it } from 'vitest';
import { driveAlarms, freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The deferred POST.
 *
 * The key being `method + url + body` is what makes two submissions to ONE endpoint two different
 * entries, which is the whole reason a captcha can work here at all.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const SITEVERIFY = 'https://cfw-captcha.test/recaptcha/api/siteverify';

type Seen = { url: string; method: string; body: string };

/**
 * Replaces outbound fetch and records what actually left.
 *
 * The body is recorded rather than the url alone, because "the request was made" and "the request
 * carried its payload" are exactly the two things this file has to tell apart.
 */
function stubFetch(reply: (seen: Seen) => Response) {
	const seen: Seen[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
		const record: Seen = {
			url,
			method: String(init?.method ?? 'GET'),
			body: typeof init?.body === 'string' ? init.body : ''
		};
		seen.push(record);
		return reply(record);
	}) as typeof fetch;
	return seen;
}

const jsonReply = (payload: unknown) =>
	new Response(JSON.stringify(payload), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});

const cacheGet = (site: ServeDo, url: string, method: string, body: string) =>
	site.httpCacheGet?.(url, method, body) ?? null;

describe('a captcha-shaped deferred POST', () => {
	it('carries its body to the endpoint and answers the submission that queued it', async () => {
		const seen = stubFetch(() => jsonReply({ success: true, score: 0.9 }));
		const payload = 'secret=test-secret&response=token-from-the-browser';

		const out = await inObject(freshSite(), async (site) => {
			site.queueHttp(SITEVERIFY, 'POST', payload);
			const drained = await site.drainHttpQueue(5);
			return {
				drained,
				// what the submission that queued it can read back afterwards
				mine: cacheGet(site, SITEVERIFY, 'POST', payload),
				// a DIFFERENT submission to the same endpoint, which must not be answered
				// by somebody else's verification
				other: cacheGet(
					site,
					SITEVERIFY,
					'POST',
					'secret=test-secret&response=someone-else'
				),
				// and neither must a GET of the same url
				asGet: cacheGet(site, SITEVERIFY, 'GET', '')
			};
		});

		const posted = seen.filter((s) => s.url.includes('cfw-captcha.test'));
		expect(posted).toHaveLength(1);
		expect(posted[0]?.method).toBe('POST');
		expect(posted[0]?.body, 'the body is the request; without it siteverify always fails').toBe(
			payload
		);

		expect(out.mine, 'the submission that queued it must be able to read its answer').not.toBe(
			null
		);
		expect(JSON.parse(String(out.mine?.body))).toEqual({ success: true, score: 0.9 });

		expect(out.other, 'another submission to the same url is a different key').toBe(null);
		expect(out.asGet, 'and a GET of that url was never made').toBe(null);
	});

	it('keeps two submissions to one endpoint apart, in one drain', async () => {
		// each answer names its own token, so an answer served to the wrong submission is visible
		// rather than merely suspected
		const seen = stubFetch((s) =>
			jsonReply({ success: true, echo: /response=([^&]*)/.exec(s.body)?.[1] ?? null })
		);
		const first = 'secret=k&response=alpha';
		const second = 'secret=k&response=beta';

		const out = await inObject(freshSite(), async (site) => {
			site.queueHttp(SITEVERIFY, 'POST', first);
			site.queueHttp(SITEVERIFY, 'POST', second);
			const drained = await site.drainHttpQueue(5);
			return {
				drained,
				first: cacheGet(site, SITEVERIFY, 'POST', first),
				second: cacheGet(site, SITEVERIFY, 'POST', second)
			};
		});

		expect(seen.filter((s) => s.url.includes('cfw-captcha.test'))).toHaveLength(2);
		expect(JSON.parse(String(out.first?.body))['echo']).toBe('alpha');
		expect(JSON.parse(String(out.second?.body))['echo']).toBe('beta');
	});

	it('drains unattended, so a submission does not need a second visitor to arrive', async () => {
		const seen = stubFetch(() => jsonReply({ success: true }));
		const payload = 'secret=k&response=unattended';
		const stub = freshSite();

		const queued = await inObject(stub, (site) => {
			site.queueHttp(SITEVERIFY, 'POST', payload);
			return site.countOrNull('cfw_http_queue');
		});
		expect(queued, 'the setup must actually have queued something').toBe(1);

		// the alarm chain is the only thing that runs BETWEEN requests, so it is the only thing that
		// can complete a deferred POST without a second visitor to ride on. Same object, or the
		// assertion would be about a different queue
		await driveAlarms(stub, (site) => (site.countOrNull('cfw_http_queue') ?? 0) === 0);

		const after = await inObject(stub, (site) => ({
			remaining: site.countOrNull('cfw_http_queue'),
			answer: cacheGet(site, SITEVERIFY, 'POST', payload)
		}));

		expect(seen.filter((s) => s.url.includes('cfw-captcha.test'))).toHaveLength(1);
		expect(after.remaining, 'a drained entry leaves the queue').toBe(0);
		expect(after.answer, 'and its answer is waiting for the next submission').not.toBe(null);
	});
});
