import { describe, expect, it } from 'vitest';
import {
	capabilityVectors,
	carriesUpload,
	drupalOp,
	harvestShell,
	memfsCensus,
	renderFragments,
	requestBody,
	submissionProbe
} from '../../../src/drupal/site-php';

const enc = (s: string) => new TextEncoder().encode(s);

describe('a request body as the render takes it', () => {
	it('keeps valid UTF-8 as text', () => {
		expect(requestBody(enc('name=café'))).toEqual({ body: 'name=café' });
	});

	it('sends anything that is not UTF-8 as base64 so no byte is replaced', () => {
		expect(requestBody(new Uint8Array([0xff, 0xfe, 0x41]))).toEqual({ bodyBase64: '//5B' });
	});
});

describe('whether a multipart body carries a chosen file', () => {
	const multipart = 'multipart/form-data; boundary=x';

	it('is true for a part with a filename', () => {
		const body = enc(
			'--x\r\nContent-Disposition: form-data; name="f"; filename="a.png"\r\n\r\n..'
		);
		expect(carriesUpload(multipart, body)).toBe(true);
	});

	it('is false for an empty filename, a non-multipart type and a body with no file part', () => {
		expect(carriesUpload(multipart, enc('x; filename=""\r\n'))).toBe(false);
		expect(carriesUpload('application/json', enc('filename="a.png"'))).toBe(false);
		expect(carriesUpload(multipart, enc('--x\r\nname="title"\r\n\r\nhello'))).toBe(false);
	});

	it('finds a filename that is not the first occurrence of its leading byte', () => {
		const body = enc('f f fil filename="b.txt"');
		expect(carriesUpload(multipart, body)).toBe(true);
	});
});

describe('the PHP the host composes', () => {
	it('submissionProbe carries the method upper-cased and the path', () => {
		const php = submissionProbe({ path: '/node/add/page', method: 'put', body: 'a=1' });
		expect(php).toContain('PUT');
		expect(php).toContain('/node/add/page');
	});

	it('submissionProbe defaults to a POST of the page form', () => {
		const php = submissionProbe({});
		expect(php).toContain('POST');
		expect(php).toContain('/node/add/page');
		expect(php).toContain('application/x-www-form-urlencoded');
	});

	it('drupalOp embeds the body it is given', () => {
		expect(drupalOp('$out["probe"] = 1;')).toContain('$out["probe"] = 1;');
	});

	it('harvestShell carries the path, cookie and origin of the persona', () => {
		const php = harvestShell('/about', { cookie: 'SESSabc=1', origin: 'https://a.test' });
		expect(php).toContain('/about');
		expect(php).toContain('SESSabc=1');
		expect(php).toContain('https://a.test');
	});

	it('harvestShell defaults to the front page with no cookie', () => {
		expect(harvestShell()).toContain('"\\"/\\""');
	});

	it('renderFragments carries the recipes and the persona', () => {
		const php = renderFragments('/', { 'cfw-ph-1': { callback: 'block' } }, { cookie: 'c=1' });
		expect(php).toContain('cfw-ph-1');
		expect(php).toContain('c=1');
	});

	it('memfsCensus strips anything outside a path alphabet from the root', () => {
		const php = memfsCensus('/tmp;rm -rf /');
		expect(php).toContain('/tmprm-rf/');
		expect(php).not.toContain('tmp;rm');
	});

	it('capabilityVectors writes one guarded probe per valid id and drops a malformed id', () => {
		const php = capabilityVectors({
			'cache.kill_switch': 'true',
			'Bad Id': 'phpinfo()'
		});
		expect(php).toContain('$out["cache.kill_switch"] = (function ()');
		expect(php).toContain('catch (Throwable $e)');
		expect(php).not.toContain('Bad Id');
		expect(php).not.toContain('phpinfo()');
	});
});
