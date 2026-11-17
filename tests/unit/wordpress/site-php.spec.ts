import { describe, expect, it } from 'vitest';
import { wordpressRender } from '../../../src/wordpress/site-php';

const literal = (code: string): Record<string, unknown> => {
	const match = /\$cfwReq = json_decode\('((?:[^'\\]|\\.)*)', true\);/.exec(code);
	expect(match).not.toBeNull();
	return JSON.parse((match![1] as string).replace(/\\(['\\])/g, '$1'));
};

describe('the WordPress request fragment', () => {
	it('carries the request as one JSON literal, not as interpolated PHP', () => {
		const code = wordpressRender('/?s=$x"\'\\', {
			origin: 'https://wp.example',
			method: 'POST',
			body: "a=b'c",
			contentType: 'application/x-www-form-urlencoded',
			cookie: 'wordpress_test_cookie=WP%20Cookie%20check',
			clientIp: '203.0.113.9',
			accept: 'text/html',
			headers: { 'x-forwarded-proto': 'https' }
		});
		const request = literal(code);
		expect(request).toMatchObject({
			path: '/?s=$x"\'\\',
			origin: 'https://wp.example',
			method: 'POST',
			contentType: 'application/x-www-form-urlencoded',
			cookie: 'wordpress_test_cookie=WP%20Cookie%20check',
			clientIp: '203.0.113.9',
			accept: 'text/html',
			headers: { 'x-forwarded-proto': 'https' }
		});
		expect(atob(String(request['bodyBase64']))).toBe("a=b'c");
	});

	it('defaults to an anonymous GET with an empty body', () => {
		expect(literal(wordpressRender('/'))).toEqual({
			path: '/',
			origin: '',
			method: 'GET',
			bodyBase64: '',
			contentType: '',
			cookie: '',
			clientIp: '',
			accept: '',
			headers: {}
		});
	});

	it('takes a base64 body as it is and leaves no template token behind', () => {
		const code = wordpressRender('/x', { bodyBase64: 'AAEC', body: 'ignored' });
		expect(literal(code)['bodyBase64']).toBe('AAEC');
		expect(code).not.toMatch(/__CFW_[A-Z0-9_]+__/);
		expect(code.startsWith('<?php')).toBe(true);
	});

	it('stops the three exits a GET reaches and keeps the interpreter one-shot', () => {
		const code = wordpressRender('/');
		expect(code).toContain("'x_redirect_by'");
		expect(code).toContain("'wp_die_handler'");
		expect(code).toContain("'parse_request'");
		expect(code).toContain("defined('ABSPATH')");
		expect(code).toContain("remove_action('shutdown', 'wp_ob_end_flush_all', 1)");
	});
});
