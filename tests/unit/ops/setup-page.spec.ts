import { describe, expect, it } from 'vitest';
import { needsSetup, setupHtml, setupResponse } from '../../../src/ops/setup-page';

/**
 * The page an unclaimed site shows instead of its front page.
 *
 * The interesting half is {@link needsSetup}: it decides for every request on a site nobody has
 * claimed, so being too eager breaks machine clients and being too shy leaves the hole the page
 * exists to close.
 */

const get = (accept = 'text/html,application/xhtml+xml') =>
	new Request('https://site.example/', { headers: { accept } });

describe('when the page applies', () => {
	it('never applies to a site that has been claimed', () => {
		expect(needsSetup(get(), true)).toBe(false);
	});

	it('applies to a browser navigation on a site that has not', () => {
		expect(needsSetup(get(), false)).toBe(true);
	});

	// the page is a signpost for a human; blocking every client would break curl, assets and bots
	// for a state that is meant to last minutes
	it('leaves a non-HTML request alone', () => {
		expect(needsSetup(get('*/*'), false)).toBe(false);
		expect(needsSetup(get('application/json'), false)).toBe(false);
		expect(needsSetup(new Request('https://site.example/'), false)).toBe(false);
	});

	it('leaves a submission alone, so a POST is never answered with a page', () => {
		const post = new Request('https://site.example/', {
			method: 'POST',
			body: 'a=1',
			headers: { accept: 'text/html' }
		});
		expect(needsSetup(post, false)).toBe(false);
	});

	it('applies to HEAD, which is how a browser preflights a navigation', () => {
		const head = new Request('https://site.example/', {
			method: 'HEAD',
			headers: { accept: 'text/html' }
		});
		expect(needsSetup(head, false)).toBe(true);
	});
});

describe('the page itself', () => {
	const html = setupHtml('https://site.example');

	it('carries the claim action and the terminal equivalent', () => {
		expect(html).toContain('/firstrun');
		expect(html).toContain('curl -X POST "https://site.example/firstrun"');
		expect(html).toContain('Claim This Site');
	});

	// served BEFORE the site can be trusted to render, so a stylesheet or an image would be a
	// request that gets answered with this same page
	it('references nothing external', () => {
		expect(html).not.toMatch(/<(?:link|img|script)[^>]+(?:src|href)="(?:https?:)?\/\//);
	});

	/**
	 * A GENERATED password is shown once and nowhere else, so the page must not navigate away from
	 * it on a timer. One the visitor typed is one they already have, so it may.
	 */
	it('sends the owner to the login page only when they chose the password', () => {
		expect(html).toContain('const chose = Boolean(body.adminPass)');
		expect(html).toContain("location.href = '/user/login'");
		// the redirect sits inside the branch rather than beside it
		const branch = html.slice(html.indexOf('if (chose) {'));
		expect(branch).toContain("location.href = '/user/login'");
		// and a link is always offered, so the no-timer case is not a dead end
		expect(html).toContain('Log in as admin');
	});

	it('names the account, not just the password', () => {
		expect(html).toContain("lines.push('username: admin')");
	});

	it('tells a crawler to stay away, in the markup and in the headers', () => {
		expect(html).toContain('name="robots" content="noindex"');
		const res = setupResponse('https://site.example');
		expect(res.headers.get('x-robots-tag')).toBe('noindex');
	});

	/**
	 * 200 rather than 503: the site is not broken and not starting up, it is waiting for its owner,
	 * and a 503 would tell a monitor the deploy failed.
	 */
	it('answers 200, uncacheable, and says why it is here', () => {
		const res = setupResponse('https://site.example');
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('x-cfw-setup')).toBe('required');
		expect(res.headers.get('content-type')).toContain('text/html');
	});

	it('keeps the diagnostic headers a caller passes', () => {
		const res = setupResponse('https://site.example', { 'x-cfw-serve-ms': '4' });
		expect(res.headers.get('x-cfw-serve-ms')).toBe('4');
		expect(res.headers.get('x-cfw-setup')).toBe('required');
	});
});
