import { describe, expect, it } from 'vitest';
import { wantsHtml, warmingHtml, warmingResponse } from '../../../src/ops/warming-page';

/**
 * The page a visitor gets before the site can answer.
 *
 * Two of these assertions are the module's whole reason for existing and must not be relaxed:
 *
 *   - **THE STATUS STAYS 503.** A 202 is a SUCCESS status, so a crawler may index the placeholder
 *     and "Starting up..." becomes what the site says in search results. The body changed; the code
 *     did not.
 *   - **`Retry-After` AND THE META REFRESH CARRY THE SAME NUMBER.** They are the same instruction to
 *     two different clients, and nothing but a test couples them -- one is a header, one is inside a
 *     string of HTML, and a change to either alone is invisible.
 */

const req = (accept?: string) =>
	new Request('https://site.local/', accept ? { headers: { accept } } : undefined);

describe('the response an unready site returns', () => {
	it('is a 503 with a Retry-After, whatever the stage', () => {
		for (const stage of ['warming', 'migrating'] as const) {
			const res = warmingResponse({ stage, retryAfterSeconds: 3 });
			expect(res.status, stage).toBe(503);
			expect(res.headers.get('retry-after'), stage).toBe('3');
		}
	});

	it('is never cacheable, at the edge or in the browser', () => {
		const res = warmingResponse({ stage: 'warming' });
		expect(res.headers.get('cache-control')).toBe('no-store');
	});

	it('keeps the one-word body for a client that did not ask for html', async () => {
		const res = warmingResponse({ stage: 'migrating', request: req('*/*') });
		expect(await res.text()).toBe('migrating\n');
		expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
	});

	it('keeps it for a caller that passed no request at all', async () => {
		// every pre-existing internal caller is this shape, and a screenful of markup in a log line
		// is worse than the word
		const res = warmingResponse({ stage: 'warming' });
		expect(await res.text()).toBe('warming\n');
	});

	it('answers a browser navigation with the page', async () => {
		const res = warmingResponse({
			stage: 'warming',
			request: req('text/html,application/xhtml+xml,application/xml;q=0.9')
		});
		expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(await res.text()).toContain('<!doctype html>');
	});

	it('preserves the diagnostic headers the callers attach', () => {
		const res = warmingResponse({
			stage: 'migrating',
			headers: { 'x-cfw-migrate': '3/9', 'x-cfw-migrate-state': 'running' }
		});
		expect(res.headers.get('x-cfw-migrate')).toBe('3/9');
		expect(res.headers.get('x-cfw-migrate-state')).toBe('running');
		// and the ones it sets itself are still there
		expect(res.headers.get('retry-after')).toBe('1');
	});

	it('never asks a client to retry in zero seconds', () => {
		// a meta refresh of 0 is a hot loop against an object that is already busy booting
		for (const given of [0, -5, 0.2, undefined]) {
			const res = warmingResponse({ stage: 'warming', retryAfterSeconds: given });
			expect(Number(res.headers.get('retry-after')), String(given)).toBeGreaterThanOrEqual(1);
		}
	});

	it('rounds a fractional retry rather than emitting one', () => {
		const res = warmingResponse({ stage: 'warming', retryAfterSeconds: 2.6 });
		expect(res.headers.get('retry-after')).toBe('3');
	});
});

describe('the html the browser gets', () => {
	it('refreshes itself at exactly the second Retry-After names', async () => {
		// THE COUPLING. A bot obeys the header, a human obeys the meta tag, and they must agree or
		// the page a person sees is stale for as long as the two differ
		const res = warmingResponse({
			stage: 'warming',
			retryAfterSeconds: 4,
			request: req('text/html')
		});
		const body = await res.text();
		expect(res.headers.get('retry-after')).toBe('4');
		expect(body).toContain('<meta http-equiv="refresh" content="4">');
	});

	it('tells a crawler not to index it', () => {
		expect(warmingHtml('warming', 1)).toContain('<meta name="robots" content="noindex">');
	});

	it('references nothing it would have to serve a second request for', () => {
		// this page is served BEFORE the site can render, so a stylesheet or an image would be a
		// request the object cannot answer either
		const html = warmingHtml('migrating', 2);
		expect(html).not.toMatch(/<link\b/);
		expect(html).not.toMatch(/<img\b/);
		expect(html).not.toMatch(/<script\b/);
		expect(html).not.toMatch(/https?:\/\//);
	});

	it('says something different for each stage, so a screenshot is diagnostic', () => {
		const warming = warmingHtml('warming', 1);
		const migrating = warmingHtml('migrating', 1);
		expect(warming).toContain('Starting up');
		expect(migrating).toContain('Setting up');
		expect(warming).not.toBe(migrating);
	});

	it('is a complete document, not a fragment', () => {
		const html = warmingHtml('warming', 1);
		expect(html.startsWith('<!doctype html>')).toBe(true);
		expect(html).toContain('<html lang="en">');
		expect(html).toContain('</html>');
		expect(html).toContain('<meta charset="utf-8">');
		expect(html).toContain('name="viewport"');
	});

	it('holds still for a visitor who asked for no animation', () => {
		expect(warmingHtml('warming', 1)).toContain('prefers-reduced-motion');
	});
});

/**
 * A META REFRESH IS A GET, so on a submission it is not a retry -- it discards the body and
 * navigates to the same URL, which for a form path is the cached anonymous copy of the form that
 * was just submitted.
 *
 * Measured as a login loop on a dev server: `POST /user/login` took the cold path, the interstitial
 * navigated the browser to `GET /user/login`, and that answered from `cfw_page` with a logged-out
 * form. Repeatable indefinitely, with the account never signed in. The header still says when to
 * come back; only the automatic navigation is withheld, because the browser is holding the body and
 * the visitor is not.
 */
describe('a submission is never auto-retried, because the retry would drop it', () => {
	const post = () =>
		new Request('https://site.local/user/login', {
			method: 'POST',
			headers: { accept: 'text/html' },
			body: 'name=admin'
		});

	it('withholds the meta refresh from a POST', async () => {
		const res = warmingResponse({ stage: 'warming', retryAfterSeconds: 2, request: post() });
		const html = await res.text();
		expect(html).not.toContain('http-equiv="refresh"');
		// and says why, so the visitor is not left looking at a page that never moves
		expect(html).toContain('Go back and send it again');
	});

	it('CONTROL: a GET still refreshes itself, and on the same second as Retry-After', async () => {
		const res = warmingResponse({
			stage: 'warming',
			retryAfterSeconds: 2,
			request: new Request('https://site.local/', { headers: { accept: 'text/html' } })
		});
		expect(await res.text()).toContain('<meta http-equiv="refresh" content="2">');
		expect(res.headers.get('retry-after')).toBe('2');
	});

	it('still answers 503 with a Retry-After, since only the navigation was withheld', () => {
		const res = warmingResponse({ stage: 'warming', retryAfterSeconds: 5, request: post() });
		expect(res.status).toBe(503);
		expect(res.headers.get('retry-after')).toBe('5');
	});

	it('leaves the plain-text body alone, which no client auto-follows anyway', async () => {
		const res = warmingResponse({
			stage: 'warming',
			request: new Request('https://site.local/', { method: 'POST', body: 'x' })
		});
		expect(await res.text()).toBe('warming\n');
	});
});

describe('what counts as a browser', () => {
	it('is what the request asked for, not a guess from anything else', () => {
		expect(wantsHtml(req('text/html'))).toBe(true);
		expect(wantsHtml(req('text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'))).toBe(true);
		expect(wantsHtml(req('*/*'))).toBe(false);
		expect(wantsHtml(req('application/json'))).toBe(false);
		expect(wantsHtml(req())).toBe(false);
	});
});
