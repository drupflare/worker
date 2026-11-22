import { describe, expect, it } from 'vitest';
import { answerConditional, pageEtag, withValidator } from '../../../src/wordpress/conditional';

const WP = { CMS: 'wordpress' };
const STORED = 'public, max-age=0, must-revalidate';

function stored(init: Record<string, string> = {}, status = 200): Response {
	return new Response('<html></html>', {
		status,
		headers: {
			'cache-control': STORED,
			'content-type': 'text/html; charset=UTF-8',
			'x-cfw-cache': 'HIT',
			'x-cfw-rendered-at': '1795240717609',
			...init
		}
	});
}

const get = (headers: Record<string, string> = {}, method = 'GET') =>
	new Request('https://site.test/hello/', { method, headers });

/** what spool does to a page it changes: the body differs and a strong tag becomes weak */
function decorated(res: Response): Response {
	const headers = new Headers(res.headers);
	headers.set('etag', `W/${headers.get('etag')}`);
	return new Response('<html><script src="/spool"></script></html>', {
		status: res.status,
		headers
	});
}

describe('wordpress page validators', () => {
	it('names a stored page by the time its row was rendered', () => {
		expect(pageEtag(stored())).toBe('"wp-1795240717609"');
		expect(pageEtag(stored({ 'x-cfw-cache': 'EDGE' }))).toBe('"wp-1795240717609"');
		expect(pageEtag(stored({ 'x-cfw-cache': 'MEM' }))).toBe('"wp-1795240717609"');
	});

	it('gives a refill a new validator', () => {
		expect(pageEtag(stored({ 'x-cfw-rendered-at': '1000' }))).not.toBe(
			pageEtag(stored({ 'x-cfw-rendered-at': '2000' }))
		);
	});

	it('leaves a superseded or private answer without one', () => {
		expect(pageEtag(stored({ 'x-cfw-cache': 'AGED' }))).toBeUndefined();
		expect(pageEtag(stored({ 'x-cfw-cache': 'KV', 'x-cfw-edge': 'STALE' }))).toBeUndefined();
		expect(pageEtag(stored({ 'cache-control': 'private, no-store' }))).toBeUndefined();
		expect(pageEtag(stored({ 'set-cookie': 'a=b' }))).toBeUndefined();
		expect(pageEtag(stored({}, 404))).toBeUndefined();
		expect(pageEtag(stored({ 'x-cfw-rendered-at': 'soon' }))).toBeUndefined();
		expect(
			pageEtag(new Response('x', { headers: { 'cache-control': STORED } }))
		).toBeUndefined();
	});

	it('adds a strong validator for WordPress only', async () => {
		const res = withValidator(WP, stored());
		expect(res.headers.get('etag')).toBe('"wp-1795240717609"');
		expect(await res.text()).toBe('<html></html>');
		for (const env of [{ CMS: 'drupal' }, {}, undefined]) {
			expect(withValidator(env, stored()).headers.has('etag')).toBe(false);
		}
	});

	it('answers a matching plain tag with 304 and anything else with the page', async () => {
		const plain = withValidator(WP, stored());
		const etag = plain.headers.get('etag') ?? '';
		const again = answerConditional(
			get({ 'if-none-match': etag }),
			WP,
			withValidator(WP, stored())
		);
		expect(again.status).toBe(304);
		expect(await again.text()).toBe('');
		expect(again.headers.get('etag')).toBe(etag);
		expect(again.headers.get('cache-control')).toBe(STORED);
		expect(again.headers.has('content-type')).toBe(false);
		const listedTag = answerConditional(
			get({ 'if-none-match': `"other", ${etag}` }),
			WP,
			withValidator(WP, stored())
		);
		expect(listedTag.status).toBe(304);
		const old = answerConditional(
			get({ 'if-none-match': '"wp-1"' }),
			WP,
			withValidator(WP, stored({ 'x-cfw-rendered-at': '2000' }))
		);
		expect(old.status).toBe(200);
		expect(await old.text()).toBe('<html></html>');
	});

	it('never lets a copy held in one form validate the other, which is what spool changes', () => {
		const plain = withValidator(WP, stored());
		const plainTag = plain.headers.get('etag') ?? '';
		const spooled = decorated(withValidator(WP, stored()));
		const weakTag = spooled.headers.get('etag') ?? '';
		expect(weakTag).toBe(`W/${plainTag}`);
		// a browser that kept the plain page meets the decorated one
		expect(
			answerConditional(
				get({ 'if-none-match': plainTag }),
				WP,
				decorated(withValidator(WP, stored()))
			).status
		).toBe(200);
		// a browser that kept the decorated page meets the plain one after spool is turned off
		expect(
			answerConditional(get({ 'if-none-match': weakTag }), WP, withValidator(WP, stored()))
				.status
		).toBe(200);
		// each form still validates itself
		expect(
			answerConditional(
				get({ 'if-none-match': weakTag }),
				WP,
				decorated(withValidator(WP, stored()))
			).status
		).toBe(304);
		expect(
			answerConditional(get({ 'if-none-match': plainTag }), WP, withValidator(WP, stored()))
				.status
		).toBe(304);
	});

	it('never answers 304 for a superseded copy, and handles HEAD and POST', () => {
		const aged = withValidator(WP, stored({ 'x-cfw-cache': 'AGED' }));
		const res = answerConditional(get({ 'if-none-match': '"wp-1795240717609"' }), WP, aged);
		expect(res.status).toBe(200);
		expect(res.headers.has('etag')).toBe(false);
		const head = answerConditional(
			get({ 'if-none-match': '"wp-1795240717609"' }, 'HEAD'),
			WP,
			withValidator(WP, stored())
		);
		expect(head.status).toBe(304);
		const post = answerConditional(
			get({ 'if-none-match': '*' }, 'POST'),
			WP,
			withValidator(WP, stored())
		);
		expect(post.status).toBe(200);
	});

	it('does nothing for Drupal', () => {
		const res = answerConditional(get({ 'if-none-match': '*' }), { CMS: 'drupal' }, stored());
		expect(res.status).toBe(200);
	});
});
