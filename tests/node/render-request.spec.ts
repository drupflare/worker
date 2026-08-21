import { describe, expect, it } from 'vitest';
import { renderPage } from '../../src/drupal/site-php';

/**
 * The method and body threading, asserted on the emitted PHP.
 *
 * **The bar is that Drupal SEES the method and the values, not that a POST returns 200.** A form
 * that returns 200 while Drupal treats it as an anonymous GET is the failure this exists to rule
 * out, and it is exactly what happened before: every `Request::create()` passed a literal `"GET"`,
 * so a submission was silently downgraded rather than refused.
 *
 * These are source assertions rather than a live run because the live half belongs in the
 * integration lane; what they pin is the two mistakes that would make the live test pass for the
 * wrong reason -- setting only `$_POST` (which Drupal's form system does not read) and interpolating
 * a body into PHP source (which a quote would close).
 */

describe('renderPage threads the request', () => {
	it('emits NOTHING extra for a plain GET, so every existing call site is byte-identical', () => {
		// stronger than "it passes GET explicitly": three /__assemble specs read the emitted argument
		// list directly, so passing defaults changed what they saw without changing what ran. A GET
		// now produces exactly the source it produced before this parameter existed
		const php = renderPage('/');
		const call = /\$response = cfw_serve\([^;]*\);/.exec(php)?.[0];
		expect(call).toBe('$response = cfw_serve($path, false);');
	});

	it('carries a POST method through to cfw_serve', () => {
		const php = renderPage('/admin', ['page'], false, {
			method: 'POST',
			body: 'site_name=Probe',
			contentType: 'application/x-www-form-urlencoded'
		});
		expect(php).toContain('"\\"POST\\""');
		expect(php).toContain('site_name=Probe');
		expect(php).toContain('application/x-www-form-urlencoded');
	});

	it('upper-cases the method, so a lowercase caller is not treated as unknown', () => {
		expect(renderPage('/', ['page'], false, { method: 'post' })).toContain('"\\"POST\\""');
	});

	/**
	 * The escaping rule this file lives under.
	 *
	 * A body is attacker-shaped input reaching PHP SOURCE. Interpolated, a single quote closes the
	 * literal and the rest of the body executes; JSON-encoding it makes that impossible.
	 */
	it('encodes a body containing quotes rather than interpolating it', () => {
		const php = renderPage('/', ['page'], false, {
			method: 'POST',
			body: `name='; system("id"); $x='`,
			contentType: 'application/x-www-form-urlencoded'
		});
		// the dangerous form would be a bare quote sequence sitting in the source
		expect(php).not.toContain(`name='; system("id")`);
		expect(php).toContain('json_decode(');
	});

	/**
	 * Drupal's form system reads `$request->request`, not `$_POST`.
	 *
	 * Passing the parsed parameters as `Request::create()`'s third argument is what populates it.
	 * Setting only the superglobal produces a request Drupal reads as an empty submission -- a 200
	 * that looks like it worked.
	 */
	it('passes parsed parameters into Request::create, not only $_POST', () => {
		const php = renderPage('/');
		expect(php).toContain(
			'Request::create($url, $method, $parameters, $cookies, [], $server, $body)'
		);
		expect(php).toContain('parse_str($body, $parameters)');
		expect(php).toContain('$_POST = $parameters;');
	});

	/**
	 * The FIRST argument is an absolute URL, and that is the whole of the localhost fix.
	 *
	 * `Request::create()` builds its own server bag from defaults and never reads `$_SERVER`, so the
	 * `$_SERVER['HTTP_HOST'] = 'localhost'` the fragments used to open with set nothing -- the host
	 * came from Symfony's default. Only an absolute URI moves it, which is why `$url` rather than
	 * `$path` is the assertion worth pinning here.
	 */
	it('builds the absolute URL from the origin the host supplied', () => {
		const php = renderPage('/node/1', [], false, { origin: 'https://example.test' });
		expect(php).toContain('$url = $origin === "" ? $path : rtrim($origin, "/") . $path;');
		expect(php).toContain('$origin = json_decode("\\"https://example.test\\"");');
		// the superglobals follow the request, so nothing can read a host the request disagrees with
		expect(php).toContain('$_SERVER["HTTP_HOST"] = $request->getHttpHost();');
		expect(php).not.toContain("$_SERVER['HTTP_HOST'] = 'localhost';");
	});

	// an absent origin has to stay a no-op, or every probe and measurement fragment moves with it
	it('leaves the URL relative when no origin is supplied', () => {
		const php = renderPage('/node/1');
		expect(php).toContain('$origin = json_decode("\\"\\"")');
	});

	it('only parses a body as a form when the content type says so', () => {
		const php = renderPage('/');
		expect(php).toContain('application/x-www-form-urlencoded');
		expect(php).toContain('$isForm');
		// a GET never parses a body, whatever was sent
		expect(php).toContain('if ($method !== "GET" && $body !== "" && $isForm)');
	});

	it('sets the content headers so Symfony sees a real submission', () => {
		const php = renderPage('/');
		expect(php).toContain('CONTENT_TYPE');
		expect(php).toContain('CONTENT_LENGTH');
	});
});
