import { describe, expect, it } from 'vitest';
import { passThroughHeaders } from '../../../src/do/helpers';
import {
	acceptModuleHeader,
	decodeModuleHeaders,
	encodeModuleHeaders,
	MODULE_HEADER_MAX_BYTES,
	MODULE_HEADER_NAMES,
	moduleHeaderRecord,
	moduleHeadersOf
} from '../../../src/ops/module-headers';

const POLICY = "default-src 'self'; frame-ancestors 'none'";

describe('which headers a module may set', () => {
	it('lists the eleven names and no others', () => {
		expect([...MODULE_HEADER_NAMES].sort()).toEqual([
			'content-security-policy',
			'content-security-policy-report-only',
			'cross-origin-embedder-policy',
			'cross-origin-opener-policy',
			'cross-origin-resource-policy',
			'permissions-policy',
			'referrer-policy',
			'strict-transport-security',
			'x-content-type-options',
			'x-frame-options',
			'x-permitted-cross-domain-policies'
		]);
	});

	it.each([...MODULE_HEADER_NAMES])('accepts %s in any case', (name) => {
		expect(acceptModuleHeader(name, 'x')).toBe(true);
		expect(acceptModuleHeader(name.toUpperCase(), 'x')).toBe(true);
	});

	it.each([
		'set-cookie',
		'location',
		'link',
		'content-type',
		'content-length',
		'content-encoding',
		'access-control-allow-origin',
		'access-control-allow-credentials',
		'x-cfw-cache',
		'x-powered-by'
	])('refuses %s', (name) => {
		expect(acceptModuleHeader(name, 'x')).toBe(false);
	});

	it.each([
		['a newline', "default-src 'self'\nset-cookie: a=b"],
		['a carriage return', "default-src 'self'\rx"],
		['a NUL', 'default-src\0'],
		['a character above 255', "default-src 'self' ☃"],
		['an empty value', ''],
		['a non-string', 42],
		['an oversized value', 'a'.repeat(MODULE_HEADER_MAX_BYTES + 1)]
	])('refuses a value with %s', (_what, value) => {
		expect(acceptModuleHeader('content-security-policy', value)).toBe(false);
	});

	it('keeps a value at the cap, so the boundary is not off by one', () => {
		expect(acceptModuleHeader('content-security-policy', 'a'.repeat(4096))).toBe(true);
		expect(acceptModuleHeader('content-security-policy', 'a'.repeat(4097))).toBe(false);
	});
});

describe('the record forms of the boundary', () => {
	it('lowercases the names it keeps and drops the rest from a render result', () => {
		expect(
			moduleHeaderRecord({
				'Content-Security-Policy': POLICY,
				'Set-Cookie': 'a=b',
				'X-Frame-Options': 'DENY',
				location: 'https://evil.example',
				'Access-Control-Allow-Origin': '*'
			})
		).toEqual({ 'content-security-policy': POLICY, 'x-frame-options': 'DENY' });
	});

	it.each([[null], [undefined], ['text'], [7], [['x-frame-options', 'DENY']]])(
		'reads %j as none',
		(raw) => {
			expect(moduleHeaderRecord(raw)).toEqual({});
		}
	);

	it('reads the allow-listed headers off a response', () => {
		const headers = new Headers({
			'content-type': 'text/html',
			'x-frame-options': 'DENY',
			'permissions-policy': 'camera=()',
			'x-cfw-cache': 'RENDER'
		});
		expect(moduleHeadersOf(headers)).toEqual({
			'x-frame-options': 'DENY',
			'permissions-policy': 'camera=()'
		});
	});

	it('stores nothing, as null, when nothing passed the boundary', () => {
		expect(encodeModuleHeaders({})).toBeNull();
		expect(encodeModuleHeaders({ 'set-cookie': 'a=b' })).toBeNull();
		expect(encodeModuleHeaders(undefined)).toBeNull();
	});

	it('round-trips what it stores', () => {
		const stored = encodeModuleHeaders({ 'content-security-policy': POLICY });
		expect(decodeModuleHeaders(stored)).toEqual({ 'content-security-policy': POLICY });
	});

	it.each([null, undefined, '', 'not json', '[1]', '"x"', '{"set-cookie":"a=b"}', 42])(
		'reads a stored value of %j as none, and does not throw',
		(stored) => {
			expect(decodeModuleHeaders(stored)).toEqual({});
		}
	);

	it('runs a stored document through the boundary again, so SQL cannot plant a cookie', () => {
		const planted = JSON.stringify({
			'set-cookie': 'a=b',
			'x-frame-options': 'DENY',
			'content-security-policy': 'x\r\nset-cookie: a=b'
		});
		expect(decodeModuleHeaders(planted)).toEqual({ 'x-frame-options': 'DENY' });
	});
});

describe('the render boundary, passThroughHeaders', () => {
	it('keeps x-drupal-* and the module names, and nothing else', () => {
		expect(
			passThroughHeaders({
				'X-Drupal-Ajax-Token': '1',
				'X-Drupal-Cache': 'HIT',
				'Content-Security-Policy': POLICY,
				'Set-Cookie': 'a=b',
				Location: '/elsewhere',
				'Content-Length': '1',
				Link: '</a>; rel=preload',
				'Access-Control-Allow-Origin': '*'
			})
		).toEqual({
			'x-drupal-ajax-token': '1',
			'x-drupal-cache': 'HIT',
			'content-security-policy': POLICY
		});
	});

	it('drops a hostile value on either kind of name', () => {
		expect(
			passThroughHeaders({
				'x-drupal-ajax-token': 'a\nb',
				'content-security-policy': 'a\nb',
				'x-frame-options': 'a'.repeat(4097),
				'referrer-policy': 'no-referrer'
			})
		).toEqual({ 'referrer-policy': 'no-referrer' });
	});

	it('reads a non-object as none', () => {
		expect(passThroughHeaders(null)).toEqual({});
		expect(passThroughHeaders('x')).toEqual({});
	});
});
