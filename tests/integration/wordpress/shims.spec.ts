import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { HOST_HELPERS } from '../../../src/site/shims/host-helpers';
import { ALPHA_PNG, PHOTO_JPEG } from '../../fixtures/wordpress/images';
import { freshSite, inObject, type ServeDo } from '../../helpers/serve-do';

/**
 * What a WordPress object does when a plugin asks for the network or for an image edit: real DO
 * SQLite, the real interpreter, the real pack and the real park, with the network replaced by a
 * function and the image engine left as it ships.
 *
 * Needs `bun run assets:wordpress`. It is listed in `ARTIFACT_SPECS`, so a clean checkout skips it.
 */

const ORIGIN = 'https://wp.example';
const fixture = (name: 'photo.jpg' | 'alpha.png'): string =>
	name === 'photo.jpg' ? PHOTO_JPEG : ALPHA_PNG;

type WordpressSite = ServeDo & {
	migrator(): { runAll(): Promise<{ done: boolean; chunks: number }> };
	resetPhp(): void;
	runJsonMaybeParked(code: string): Promise<Record<string, unknown>>;
};

type Seen = { method: string; url: string; headers: Record<string, string>; body: string };

/** an answer to the core version check in the shape api.wordpress.org documents, written by hand */
const VERSION_OFFER = {
	offers: [
		{
			response: 'upgrade',
			download: 'https://downloads.wordpress.org/release/wordpress-9.9.9.zip',
			locale: 'en_US',
			packages: {
				full: 'https://downloads.wordpress.org/release/wordpress-9.9.9.zip',
				no_content:
					'https://downloads.wordpress.org/release/wordpress-9.9.9-no-content.zip',
				new_bundled:
					'https://downloads.wordpress.org/release/wordpress-9.9.9-new-bundled.zip',
				partial: false,
				rollback: false
			},
			current: '9.9.9',
			version: '9.9.9',
			php_version: '7.4',
			mysql_version: '5.5',
			new_bundled: '7.0',
			partial_version: ''
		}
	],
	translations: []
};

/** a stand-in origin: what each path answers, and what the host sent to it */
function origin(seen: Seen[], mode: { cron?: number | 'down' } = {}): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === 'string' ? input : (input as Request).url);
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
		const body = init?.body ? new TextDecoder().decode(init.body as Uint8Array) : '';
		seen.push({ method: init?.method ?? 'GET', url: url.href, headers, body });
		const path = url.pathname;
		if (path === '/ok') return new Response('hello', { headers: { 'x-origin': 'yes' } });
		if (path === '/echo') {
			return Response.json({
				method: init?.method,
				body,
				type: headers['content-type'] ?? ''
			});
		}
		if (path === '/r1')
			return new Response(null, { status: 302, headers: { location: '/r2' } });
		if (path === '/r2')
			return new Response(null, { status: 301, headers: { location: '/ok' } });
		if (path === '/loop')
			return new Response(null, { status: 302, headers: { location: '/loop' } });
		if (path === '/to-metadata') {
			return new Response(null, {
				status: 302,
				headers: { location: 'http://169.254.169.254/latest/meta-data/' }
			});
		}
		if (path === '/slow') {
			return new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener('abort', () =>
					reject(
						new DOMException('The operation was aborted due to timeout', 'TimeoutError')
					)
				);
			});
		}
		if (path === '/gzip') {
			return new Response(gzipSync(Buffer.from('{"zipped":true}')), {
				headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' }
			});
		}
		if (path === '/big') return new Response(new Uint8Array(6 * 1024 * 1024));
		if (path === '/cookies') {
			const h = new Headers();
			h.append('set-cookie', 'a=1; Path=/');
			h.append('set-cookie', 'b=2; Path=/; HttpOnly');
			return new Response('ok', { headers: h });
		}
		if (path === '/teapot') return new Response('short and stout', { status: 418 });
		if (url.host === 'wp.example' && path === '/wp-cron.php') {
			if (mode.cron === 'down') throw new TypeError('Network connection lost');
			return new Response('', { status: mode.cron ?? 200 });
		}
		if (url.host === 'api.wordpress.org' && path.startsWith('/core/version-check/'))
			return Response.json(VERSION_OFFER);
		return new Response('not found', { status: 404 });
	}) as unknown as typeof fetch;
}

const PRELUDE = `
$_SERVER['HTTP_HOST'] = 'wp.example';
$_SERVER['SERVER_NAME'] = 'wp.example';
$_SERVER['SERVER_PORT'] = '443';
$_SERVER['HTTPS'] = 'on';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/wordpress/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/wordpress';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
chdir('/wordpress');
ob_start();
$GLOBALS['wp_filter']['wp_die_handler'] = [
	0 => [
		[
			'function' => static function () {
				return static function ($message) {
					throw new RuntimeException(
						trim(strip_tags(is_wp_error($message) ? $message->get_error_message() : (string) $message))
					);
				};
			},
			'accepted_args' => 1,
		],
	],
];
require '/wordpress/wp-load.php';
`;

/** runs PHP inside WordPress on a fresh interpreter and returns what it printed as JSON */
async function inWordpress(
	site: WordpressSite,
	body: string,
	fetcher?: typeof fetch
): Promise<Record<string, unknown>> {
	site.resetPhp();
	if (fetcher) site.parkFetchDep = fetcher;
	const out = await site.runJsonMaybeParked(
		`<?php ${HOST_HELPERS}\n$out = [];\ntry {\n${PRELUDE}\n${body}\n} catch (Throwable $e) {\n$out['fatal'] = get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine();\n}\nwhile (ob_get_level() > 0) { ob_end_clean(); }\necho json_encode($out, JSON_INVALID_UTF8_SUBSTITUTE);`
	);
	return out;
}

const configure = async (site: ServeDo): Promise<WordpressSite> => {
	Object.assign(site.env, {
		CMS: 'wordpress',
		SQL_CHUNK_PREFIX: 'wordpress/sql',
		SITE_ORIGIN: ORIGIN,
		HEAP_SNAPSHOT: '0'
	});
	const wp = site as WordpressSite;
	await wp.migrator().runAll();
	return wp;
};

describe('wordpress outbound requests through the host', () => {
	it('sends a GET and a POST, follows redirects and reports what came back', async () => {
		const seen: Seen[] = [];
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await configure(site);
			return inWordpress(
				wp,
				`
$get = wp_remote_get('https://mock.example/ok', ['timeout' => 5]);
$out['get'] = is_wp_error($get)
	? ['error' => $get->get_error_message()]
	: ['status' => wp_remote_retrieve_response_code($get), 'body' => wp_remote_retrieve_body($get),
		'header' => wp_remote_retrieve_header($get, 'X-Origin'), 'message' => wp_remote_retrieve_response_message($get)];
$post = wp_remote_post('https://mock.example/echo', ['body' => ['a' => '1', 'b' => 'two words']]);
$out['post'] = is_wp_error($post) ? ['error' => $post->get_error_message()]
	: json_decode(wp_remote_retrieve_body($post), true);
$json = wp_remote_post('https://mock.example/echo', ['body' => '{"x":1}', 'headers' => ['Content-Type' => 'application/json']]);
$out['json'] = json_decode(wp_remote_retrieve_body($json), true);
$redirect = wp_remote_get('https://mock.example/r1');
$out['redirect'] = is_wp_error($redirect) ? ['error' => $redirect->get_error_message()]
	: ['status' => wp_remote_retrieve_response_code($redirect), 'url' => $redirect['http_response']->get_response_object()->url,
		'hops' => $redirect['http_response']->get_response_object()->redirects];
$loop = wp_remote_get('https://mock.example/loop');
$out['loop'] = is_wp_error($loop) ? $loop->get_error_message() : 'followed';
$none = wp_remote_get('https://mock.example/r1', ['redirection' => 0]);
$out['norediect'] = wp_remote_retrieve_response_code($none);
$teapot = wp_remote_get('https://mock.example/teapot');
$out['teapot'] = [wp_remote_retrieve_response_code($teapot), wp_remote_retrieve_response_message($teapot)];
$cookies = wp_remote_get('https://mock.example/cookies');
$out['cookies'] = array_map(static fn($c) => $c->name . '=' . $c->value, wp_remote_retrieve_cookies($cookies));
$out['spent'] = drupflare_http_state()['spent'];
`,
				origin(seen)
			);
		});
		expect(out['get']).toEqual({
			status: 200,
			body: 'hello',
			header: 'yes',
			message: 'OK'
		});
		expect(out['post']).toEqual({
			method: 'POST',
			body: 'a=1&b=two+words',
			type: 'application/x-www-form-urlencoded; charset=UTF-8'
		});
		expect(out['json']).toEqual({ method: 'POST', body: '{"x":1}', type: 'application/json' });
		expect(out['redirect']).toEqual({ status: 200, url: 'https://mock.example/ok', hops: 2 });
		expect(out['loop']).toBe('drupflare: too many redirects');
		expect(out['norediect']).toBe(302);
		expect(out['teapot']).toEqual([418, "I'm a teapot"]);
		expect(out['cookies']).toEqual(['a=1', 'b=2']);
		// the user agent WordPress builds goes out, and the encodings are left to the runtime
		expect(seen[0]!.headers['user-agent']).toMatch(/^WordPress\//);
		expect(seen[0]!.headers['accept-encoding']).toBeUndefined();
		// every hop is a counted request: 1 + 1 + 1 + 3 + 6 (the loop, five hops and the first) + 1 + 1 + 1
		expect(out['spent']).toBe(seen.length);
	}, 120_000);
});

describe('wordpress outbound refusals and limits', () => {
	it('refuses private, loopback, metadata and malformed addresses before anything is sent', async () => {
		const seen: Seen[] = [];
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await configure(site);
			return inWordpress(
				wp,
				`
$urls = [
	'http://169.254.169.254/latest/meta-data/',
	'http://localhost/',
	'http://10.0.0.5/',
	'http://192.168.1.1/',
	'http://172.16.0.1/',
	'http://[::1]/',
	'http://[::ffff:169.254.169.254]/',
	'http://[fd00::1]/',
	'http://2130706433/',
	'http://0x7f.0.0.1/',
	'http://metadata.google.internal/',
	'http://printer.local/',
	'ftp://mock.example/x',
	'http://user:pw@mock.example/',
];
foreach ($urls as $u) {
	$r = wp_remote_get($u);
	$out['refused'][$u] = is_wp_error($r) ? $r->get_error_message() : 'SENT';
}
$r = wp_remote_get('https://mock.example/to-metadata');
$out['hop'] = is_wp_error($r) ? $r->get_error_message() : 'SENT';
$out['calls'] = drupflare_http_state()['calls'];
`,
				origin(seen)
			);
		});
		const refused = out['refused'] as Record<string, string>;
		expect(Object.keys(refused)).toHaveLength(14);
		for (const [url, message] of Object.entries(refused)) {
			expect(message, url).toMatch(/^drupflare: the request was refused: /);
		}
		expect(refused['http://169.254.169.254/latest/meta-data/']).toContain('link-local');
		expect(refused['http://localhost/']).toContain('names this machine');
		expect(out['hop']).toMatch(/^drupflare: a redirect was refused: .*link-local/);
		// the one request that left was the first hop of the redirect, and nothing private did
		expect(seen.map((s) => s.url)).toEqual(['https://mock.example/to-metadata']);
	}, 120_000);

	it('reports a timeout, decodes gzip, cuts a response at the size cap and streams to a file', async () => {
		const seen: Seen[] = [];
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await configure(site);
			return inWordpress(
				wp,
				`
$slow = wp_remote_get('https://mock.example/slow', ['timeout' => 1]);
$out['slow'] = is_wp_error($slow) ? $slow->get_error_message() : 'answered';
$zip = wp_remote_get('https://mock.example/gzip');
$out['gzip'] = [wp_remote_retrieve_body($zip), wp_remote_retrieve_header($zip, 'content-encoding')];
$big = wp_remote_get('https://mock.example/big');
$out['big'] = is_wp_error($big) ? $big->get_error_message() : strlen(wp_remote_retrieve_body($big));
$part = wp_remote_get('https://mock.example/big', ['limit_response_size' => 1000]);
$out['part'] = is_wp_error($part) ? $part->get_error_message() : strlen(wp_remote_retrieve_body($part));
$file = '/tmp/streamed.txt';
$stream = wp_remote_get('https://mock.example/ok', ['stream' => true, 'filename' => $file]);
$out['stream'] = [is_wp_error($stream) ? 'error' : wp_remote_retrieve_body($stream), @file_get_contents($file)];
$unsafe = wp_safe_remote_get('https://mock.example:9999/ok');
$out['unsafe'] = is_wp_error($unsafe) ? $unsafe->get_error_message() : 'SENT';
$lax = wp_remote_get('https://mock.example/ok', ['sslverify' => false]);
$out['lax'] = is_wp_error($lax) ? 'error' : wp_remote_retrieve_response_code($lax);
$out['degraded'] = array_keys(Drupal\\drupflare\\Degradation::all());
`,
				origin(seen)
			);
		});
		expect(out['slow']).toMatch(/^drupflare: .*timeout/i);
		expect(out['gzip']).toEqual(['{"zipped":true}', '']);
		expect(out['big']).toMatch(/is larger than 5242880 bytes/);
		expect(out['part']).toBe(1000);
		expect(out['stream']).toEqual(['', 'hello']);
		expect(out['unsafe']).toMatch(/port 9999 is not allowed/);
		// a request that asks for no certificate checks is made with them, and the gap is recorded
		expect(out['lax']).toBe(200);
		expect(out['degraded']).toContain('wordpress http sslverify');
	}, 120_000);

	it('stops at the request budget and says what it is', async () => {
		const seen: Seen[] = [];
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await configure(site);
			return inWordpress(
				wp,
				`
$results = [];
for ($i = 0; $i < 33; $i++) {
	$r = wp_remote_get('https://mock.example/ok');
	$results[] = is_wp_error($r) ? $r->get_error_message() : 'ok';
}
$out['ok'] = count(array_filter($results, static fn($r) => $r === 'ok'));
$out['last'] = end($results);
$out['budget'] = drupflare_http_budget();
$out['spent'] = drupflare_http_state()['spent'];
`,
				origin(seen)
			);
		});
		expect(out['budget']).toBe(30);
		expect(out['ok']).toBe(30);
		expect(out['spent']).toBe(30);
		expect(out['last']).toBe(
			'drupflare: this request already made 30 outbound requests, which is the limit for this plan'
		);
		expect(seen).toHaveLength(30);
	}, 120_000);
});

describe('wordpress calls that matter in practice', () => {
	it('runs the core version check through the host and stores the offer', async () => {
		const seen: Seen[] = [];
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await configure(site);
			return inWordpress(
				wp,
				`
require_once ABSPATH . 'wp-admin/includes/update.php';
$out['gd'] = is_array(gd_info()) ? 'array' : gettype(gd_info());
wp_version_check([], true);
$cur = get_site_transient('update_core');
$out['updates'] = is_object($cur) ? array_map(static fn($u) => [$u->response, $u->current], $cur->updates) : null;
$out['last_error'] = is_object($cur) ? ($cur->last_checked ? 'checked' : 'unchecked') : 'none';
`,
				origin(seen)
			);
		});
		expect(out['gd']).toBe('array');
		expect(out['updates']).toEqual([['upgrade', '9.9.9']]);
		expect(seen).toHaveLength(1);
		// the capability test says no ssl, and the host upgrades a wordpress.org URL on its own
		expect(seen[0]!.url).toMatch(/^https:\/\/api\.wordpress\.org\/core\/version-check\/1\.7\//);
		expect(seen[0]!.method).toBe('POST');
	}, 120_000);

	it('answers the site health loopback with what the request did', async () => {
		const run = async (mode: { cron?: number | 'down' }) => {
			const seen: Seen[] = [];
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				const wp = await configure(site);
				return inWordpress(
					wp,
					`
require_once ABSPATH . 'wp-admin/includes/class-wp-site-health.php';
$r = WP_Site_Health::get_instance()->can_perform_loopback();
$out['status'] = $r->status;
$out['message'] = strip_tags($r->message);
`,
					origin(seen, mode)
				);
			});
			return { out, seen };
		};
		const good = await run({});
		expect(good.out['status']).toBe('good');
		expect(good.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
			'POST https://wp.example/wp-cron.php'
		]);
		const odd = await run({ cron: 503 });
		expect(odd.out['status']).toBe('recommended');
		expect(odd.out['message']).toContain('503');
		const down = await run({ cron: 'down' });
		expect(down.out['status']).toBe('critical');
		expect(down.out['message']).toContain('http_request_failed');
	}, 180_000);

	it('answers true for the shim classes the pack carries and false for none that is missing', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await configure(site);
			return inWordpress(
				wp,
				`
$out['classes'] = [];
foreach (array_keys(drupflare_host_lib_classes()) as $c) {
	$out['classes'][$c] = class_exists($c);
}
$out['lib'] = drupflare_host_lib_dir();
$out['image_alias'] = class_exists('GdImage');
$out['http'] = drupflare_http_available();
$out['image'] = drupflare_image_available();
`
			);
		});
		const classes = out['classes'] as Record<string, boolean>;
		expect(Object.keys(classes).length).toBeGreaterThanOrEqual(7);
		for (const [name, loaded] of Object.entries(classes)) expect(loaded, name).toBe(true);
		expect(out['lib']).toBe('/wordpress/wp-content/mu-plugins/drupflare-host/lib');
		expect(out['image_alias']).toBe(true);
		expect(out['http']).toBe(true);
		expect(out['image']).toBe(true);
	}, 120_000);
});

describe('wordpress image editing through the host', () => {
	it('offers only the host editor and builds attachment metadata for a real JPEG and PNG', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await configure(site);
			return inWordpress(
				wp,
				`
require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';
$out['editors'] = apply_filters('wp_image_editors', ['WP_Image_Editor_Imagick', 'WP_Image_Editor_GD']);
$out['gd_loaded'] = extension_loaded('gd') && function_exists('gd_info');
$dir = wp_upload_dir();
wp_mkdir_p($dir['path']);
$fixtures = ['photo.jpg' => [${JSON.stringify(fixture('photo.jpg'))}, 'image/jpeg'],
	'alpha.png' => [${JSON.stringify(fixture('alpha.png'))}, 'image/png']];
foreach ($fixtures as $name => [$data, $mime]) {
	$file = $dir['path'] . '/' . $name;
	file_put_contents($file, base64_decode($data));
	$id = wp_insert_attachment(['post_mime_type' => $mime, 'post_title' => $name, 'post_status' => 'inherit'], $file);
	$meta = wp_generate_attachment_metadata($id, $file);
	$sizes = [];
	foreach ($meta['sizes'] ?? [] as $key => $s) {
		$written = $dir['path'] . '/' . $s['file'];
		$real = @getimagesize($written);
		$sizes[$key] = [$s['width'], $s['height'], $s['mime-type'], $real ? [$real[0], $real[1], $real['mime']] : null];
	}
	$out['meta'][$name] = ['width' => $meta['width'] ?? null, 'height' => $meta['height'] ?? null, 'sizes' => $sizes];
}
$editor = wp_get_image_editor($dir['path'] . '/photo.jpg');
$out['chosen'] = is_wp_error($editor) ? $editor->get_error_message() : get_class($editor);
$out['host_requests'] = drupflare_image_state();
`
			);
		});
		expect(out['editors']).toEqual(['Drupflare_Image_Editor']);
		// the stock editor would claim support here, which is what the filter takes out of reach
		expect(out['gd_loaded']).toBe(true);
		expect(out['chosen']).toBe('Drupflare_Image_Editor');
		const meta = out['meta'] as Record<
			string,
			{ width: number; height: number; sizes: Record<string, unknown[]> }
		>;
		expect(meta['photo.jpg']!.width).toBe(1600);
		expect(meta['photo.jpg']!.height).toBe(1000);
		expect(meta['photo.jpg']!.sizes).toEqual({
			medium: [300, 188, 'image/jpeg', [300, 188, 'image/jpeg']],
			large: [1024, 640, 'image/jpeg', [1024, 640, 'image/jpeg']],
			thumbnail: [150, 150, 'image/jpeg', [150, 150, 'image/jpeg']],
			medium_large: [768, 480, 'image/jpeg', [768, 480, 'image/jpeg']],
			'1536x1536': [1536, 960, 'image/jpeg', [1536, 960, 'image/jpeg']]
		});
		expect(meta['alpha.png']!.sizes).toEqual({
			medium: [300, 225, 'image/png', [300, 225, 'image/png']],
			thumbnail: [150, 150, 'image/png', [150, 150, 'image/png']],
			medium_large: [768, 576, 'image/png', [768, 576, 'image/png']]
		});
	}, 180_000);

	it('rotates, flips, crops and encodes through the host, and refuses what it cannot do', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			const wp = await configure(site);
			return inWordpress(
				wp,
				`
require_once ABSPATH . 'wp-admin/includes/image.php';
$dir = wp_upload_dir();
wp_mkdir_p($dir['path']);
$src = $dir['path'] . '/edit.png';
file_put_contents($src, base64_decode(${JSON.stringify(fixture('alpha.png'))}));
$jpg = $dir['path'] . '/edit.jpg';
file_put_contents($jpg, base64_decode(${JSON.stringify(fixture('photo.jpg'))}));
$describe = static function ($saved) {
	if (is_wp_error($saved)) { return ['error' => $saved->get_error_code() . ': ' . $saved->get_error_message()]; }
	$i = @getimagesize($saved['path']);
	return [$saved['width'], $saved['height'], $saved['mime-type'], $i ? [$i[0], $i[1], $i['mime']] : null, $saved['filesize'] > 0];
};
$e = wp_get_image_editor($src);
$out['rotate90'] = $e->rotate(90) === true ? $describe($e->save($dir['path'] . '/r90.png')) : 'rotate failed';
$e = wp_get_image_editor($src);
$e->flip(true, false);
$e->flip(false, true);
$out['flip'] = $describe($e->save($dir['path'] . '/flip.png'));
$e = wp_get_image_editor($src);
$out['crop'] = $e->crop(100, 50, 400, 300, 200, 150) === true ? $describe($e->save($dir['path'] . '/crop.png')) : 'crop failed';
$e = wp_get_image_editor($src);
$bad = $e->crop(700, 500, 400, 300);
$out['crop_outside'] = is_wp_error($bad) ? [$bad->get_error_code(), $bad->get_error_message()] : 'accepted';
$e = wp_get_image_editor($src);
$out['webp'] = $describe($e->save($dir['path'] . '/out.webp', 'image/webp'));
$e = wp_get_image_editor($src);
$out['jpeg_from_png'] = $describe($e->save($dir['path'] . '/out.jpg', 'image/jpeg'));
$e = wp_get_image_editor($src);
$out['bmp'] = $describe($e->save($dir['path'] . '/out.bmp', 'image/bmp'));
$e = wp_get_image_editor($src);
$out['avif_alpha'] = $describe($e->save($dir['path'] . '/out.avif', 'image/avif'));
$low = wp_get_image_editor($jpg);
$low->set_quality(20);
$a = $low->save($dir['path'] . '/q20.jpg');
$high = wp_get_image_editor($jpg);
$high->set_quality(95);
$b = $high->save($dir['path'] . '/q95.jpg');
$out['quality'] = [is_wp_error($a) ? 'error' : $a['filesize'], is_wp_error($b) ? 'error' : $b['filesize']];
$e = wp_get_image_editor($src);
$out['resize_same'] = $e->resize(800, 600);
$out['resize'] = $e->resize(400, 300) === true ? $describe($e->save($dir['path'] . '/small.png')) : 'resize failed';
$out['no_file'] = (function () use ($dir) { $x = wp_get_image_editor($dir['path'] . '/missing.png'); return is_wp_error($x) ? $x->get_error_code() : 'editor'; })();
$out['not_image'] = (function () use ($dir) {
	file_put_contents($dir['path'] . '/notes.png', 'this is not an image');
	$x = wp_get_image_editor($dir['path'] . '/notes.png');
	return is_wp_error($x) ? $x->get_error_code() : 'editor';
})();
`
			);
		});
		expect(out['rotate90']).toEqual([600, 800, 'image/png', [600, 800, 'image/png'], true]);
		expect(out['flip']).toEqual([800, 600, 'image/png', [800, 600, 'image/png'], true]);
		expect(out['crop']).toEqual([200, 150, 'image/png', [200, 150, 'image/png'], true]);
		expect(out['crop_outside']).toEqual([
			'image_crop_error',
			'The crop 400x300 at 700,500 is outside the 800x600 image.'
		]);
		expect(out['webp']).toEqual([800, 600, 'image/webp', [800, 600, 'image/webp'], true]);
		expect(out['jpeg_from_png']).toEqual([
			800,
			600,
			'image/jpeg',
			[800, 600, 'image/jpeg'],
			true
		]);
		// a type nothing here writes falls back to JPEG, which is WordPress's own rule for any editor
		expect(out['bmp']).toEqual([800, 600, 'image/jpeg', [800, 600, 'image/jpeg'], true]);
		expect((out['avif_alpha'] as { error: string }).error).toBe(
			'image_save_error: Image Editor Save Failed: the AVIF encoder writes no alpha channel'
		);
		const [low, high] = out['quality'] as number[];
		expect(low!).toBeLessThan(high!);
		expect(out['resize_same']).toBe(true);
		expect(out['resize']).toEqual([400, 300, 'image/png', [400, 300, 'image/png'], true]);
		expect(out['no_file']).toBe('error_loading_image');
		expect(out['not_image']).toBe('invalid_image');
	}, 180_000);
});
