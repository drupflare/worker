import { describe, expect, it } from 'vitest';
import { forwardedHeaders } from '../../../src/ops/forwarded-headers';

const headers = (init: Record<string, string>) => new Headers(init);

describe('forwardedHeaders', () => {
	it('hands Drupal the bearer token and the other headers an API reads', () => {
		const got = forwardedHeaders(
			headers({
				Authorization: 'Bearer visitor-token',
				'X-Api-Key': 'k1',
				Origin: 'https://app.example.com',
				'User-Agent': 'probe/1'
			}),
			'owner-token'
		);
		expect(got).toEqual({
			authorization: 'Bearer visitor-token',
			'x-api-key': 'k1',
			origin: 'https://app.example.com',
			'user-agent': 'probe/1'
		});
	});

	it('leaves out what the serve path carries by name and what means nothing past the Worker', () => {
		const got = forwardedHeaders(
			headers({
				Cookie: 'SESSabc=1',
				Accept: 'application/json',
				'Content-Type': 'application/json',
				'Content-Length': '2',
				Host: 'a.example',
				Connection: 'keep-alive',
				'Transfer-Encoding': 'chunked',
				'X-Keep': 'yes'
			}),
			null
		);
		expect(got).toEqual({ 'x-keep': 'yes' });
	});

	it('never passes this deployment plumbing, so PHP cannot read or forge it', () => {
		const got = forwardedHeaders(
			headers({
				'CF-Connecting-IP': '1.2.3.4',
				'cf-ray': 'abc',
				'x-cfw-auth': '1',
				'x-cfw-attempt': 'a',
				'x-ok': '1'
			}),
			null
		);
		expect(got).toEqual({ 'x-ok': '1' });
	});

	it('drops an Authorization that is the owner token and keeps one that only resembles it', () => {
		expect(
			forwardedHeaders(headers({ authorization: 'Bearer owner-token' }), 'owner-token')
		).toEqual({});
		expect(
			forwardedHeaders(headers({ authorization: 'bearer   owner-token ' }), 'owner-token')
		).toEqual({});
		expect(
			forwardedHeaders(headers({ authorization: 'Bearer owner-token2' }), 'owner-token')
		).toEqual({ authorization: 'Bearer owner-token2' });
		expect(
			forwardedHeaders(headers({ authorization: 'Basic b3duZXItdG9rZW4=' }), 'owner-token')
		).toEqual({ authorization: 'Basic b3duZXItdG9rZW4=' });
	});

	it('keeps a Basic credential, which is how some sites log in', () => {
		expect(forwardedHeaders(headers({ authorization: 'Basic dTpw' }), null)).toEqual({
			authorization: 'Basic dTpw'
		});
	});

	it('drops a header past the byte ceiling whole rather than cutting its value', () => {
		const got = forwardedHeaders(
			headers({ 'x-small': 'a', 'x-big': 'b'.repeat(20_000), 'x-after': 'c' }),
			null
		);
		expect(got).toEqual({ 'x-small': 'a', 'x-after': 'c' });
	});

	it('caps the count', () => {
		const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`x-h${i}`, 'v']));
		expect(Object.keys(forwardedHeaders(headers(many), null))).toHaveLength(64);
	});

	it('skips an empty value', () => {
		expect(forwardedHeaders(headers({ 'x-empty': ' ' }), null)).toEqual({});
	});
});
