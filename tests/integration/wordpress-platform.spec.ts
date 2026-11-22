import { describe, expect, it } from 'vitest';
import { ACTION_SCHEDULER_TABLES } from '../../scripts/wp/oracle-action-scheduler';
import { wordpressRender } from '../../src/wordpress/site-php';
import { ALPHA_PNG, PHOTO_JPEG } from '../fixtures/wordpress/images';
import { driveAlarms, freshSite, inObject, statsOf } from '../helpers/serve-do';
import { stubFetch } from '../helpers/stub-fetch';
import {
	configureWordpress,
	inWordpress,
	multipartBody,
	overlayHostPlugin,
	type WordpressSite
} from '../helpers/wordpress-php';

/**
 * What a WordPress object does for mail, uploads and cron: real DO SQLite, the real interpreter, the
 * real pack, and the host plugin read from the sibling checkout. The mail relay is a recording
 * stand-in for the Email Sending API, which is the platform boundary.
 *
 * Needs `bun run assets:wordpress`. It is listed in `ARTIFACT_SPECS`, so a clean checkout skips it.
 */

const queued = (site: { sql: { exec(q: string): { toArray(): Record<string, unknown>[] } } }) =>
	site.sql.exec('SELECT recipient, payload, attempts FROM cfw_mail_queue ORDER BY id').toArray();

/** gives the administrator a real address, so WordPress has someone to write to */
const WITH_ADMIN = `
add_filter('send_email_change_email', '__return_false');
wp_update_user(['ID' => 1, 'user_email' => 'owner@example.org']);
`;

describe('WordPress mail leaves through the host', () => {
	it('queues a password reset and sends it to the relay on the alarm', async () => {
		const stub = freshSite();
		const calls = stubFetch();
		const out = await inObject(stub, async (site) => {
			const wp = await configureWordpress(site, {
				CF_EMAIL_ACCOUNT_ID: 'acct-wp-reset',
				CF_EMAIL_TOKEN: 'tok',
				HTTP_DRAIN_ON_ALARM: '0'
			});
			const result = await inWordpress(
				wp,
				`${WITH_ADMIN}
$login = get_userdata(1)->user_login;
$ok = retrieve_password($login);
$out['ok'] = $ok === true;
$out['error'] = is_wp_error($ok) ? $ok->get_error_message() : null;
`
			);
			return { result, rows: queued(site) };
		});
		expect(out.result.fatal).toBeUndefined();
		expect(out.result.ok, String(out.result.error)).toBe(true);
		expect(out.rows).toHaveLength(1);
		expect(String(out.rows[0]!.recipient)).toBe('owner@example.org');

		await driveAlarms(stub, (site) => site.countOrNull('cfw_mail_queue') === 0);
		const sent = calls('acct-wp-reset');
		expect(sent).toHaveLength(1);
		const body = JSON.parse(String(sent[0]!.init?.body)) as Record<string, unknown>;
		expect(body.to).toEqual(['owner@example.org']);
		expect(String(body.subject)).toContain('Password Reset');
		// the link is the point of the message, and it has to name this site
		expect(String(body.text)).toContain('https://wp.example/wp-login.php?login=');
		expect(String(body.text)).toContain('action=rp');
		expect(String(body.from)).toContain('wordpress@wp.example');
	}, 900_000);

	it('queues both new-user notifications, one to the site and one to the user', async () => {
		const stub = freshSite();
		const calls = stubFetch();
		const out = await inObject(stub, async (site) => {
			const wp = await configureWordpress(site, {
				CF_EMAIL_ACCOUNT_ID: 'acct-wp-new',
				CF_EMAIL_TOKEN: 'tok',
				HTTP_DRAIN_ON_ALARM: '0'
			});
			return inWordpress(
				wp,
				`${WITH_ADMIN}
update_option('admin_email', 'owner@example.org');
$id = wp_insert_user(['user_login' => 'newbie', 'user_pass' => wp_generate_password(20), 'user_email' => 'newbie@example.org']);
$out['created'] = is_int($id);
wp_new_user_notification($id, null, 'both');
`
			);
		});
		expect(out.fatal).toBeUndefined();
		expect(out.created).toBe(true);
		await driveAlarms(stub, (site) => site.countOrNull('cfw_mail_queue') === 0);
		const sent = calls('acct-wp-new').map(
			(c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>
		);
		expect(sent.map((s) => (s.to as string[])[0]).sort()).toEqual([
			'newbie@example.org',
			'owner@example.org'
		]);
		const toUser = sent.find((s) => (s.to as string[])[0] === 'newbie@example.org')!;
		expect(String(toUser.text)).toContain('action=rp');
	}, 900_000);

	it('sends html with a text version, a Reply-To and Cc, and carries the attachment bytes', async () => {
		const stub = freshSite();
		const calls = stubFetch();
		const out = await inObject(stub, async (site) => {
			const wp = await configureWordpress(site, {
				CF_EMAIL_ACCOUNT_ID: 'acct-wp-rich',
				CF_EMAIL_TOKEN: 'tok',
				HTTP_DRAIN_ON_ALARM: '0'
			});
			return inWordpress(
				wp,
				`
$file = sys_get_temp_dir() . '/report-' . uniqid() . '.pdf';
file_put_contents($file, '%PDF-1.4 body');
$out['sent'] = wp_mail(
	['a@example.org'],
	'Quarterly report',
	'<p>See <b>attached</b></p>',
	['Content-Type: text/html; charset=UTF-8', 'From: The Site <site@wp.example>', 'Reply-To: help@wp.example', 'Cc: c@example.org'],
	['report.pdf' => $file]
);
`
			);
		});
		expect(out.fatal).toBeUndefined();
		expect(out.sent).toBe(true);
		await driveAlarms(stub, (site) => site.countOrNull('cfw_mail_queue') === 0);
		const body = JSON.parse(String(calls('acct-wp-rich')[0]!.init?.body)) as Record<
			string,
			any
		>;
		expect(body.html).toBe('<p>See <b>attached</b></p>');
		expect(body.text).toBe('See attached');
		expect(body.from).toBe('The Site <site@wp.example>');
		expect(body.replyTo).toBe('help@wp.example');
		expect(body.cc).toEqual(['c@example.org']);
		expect(body.attachments).toEqual([
			{
				content: btoa('%PDF-1.4 body'),
				filename: 'report.pdf',
				type: 'application/pdf',
				disposition: 'attachment'
			}
		]);
	}, 900_000);

	it('refuses when mail is switched off, fires wp_mail_failed with a WP_Error and queues nothing', async () => {
		const calls = stubFetch();
		const out = await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site, {
				CF_EMAIL_ACCOUNT_ID: 'acct-wp-off',
				CF_EMAIL_TOKEN: 'tok',
				MAIL_TRANSPORT: 'off'
			});
			const result = await inWordpress(
				wp,
				`
add_action('wp_mail_failed', static function ($e) use (&$out) {
	$out['failed'][] = [get_class($e), $e->get_error_code(), $e->get_error_message(), $e->get_error_data()['subject'] ?? null];
});
$out['sent'] = wp_mail('a@example.org', 'Hello', 'x');
`
			);
			return { result, depth: site.countOrNull('cfw_mail_queue') };
		});
		expect(out.result.sent).toBe(false);
		expect((out.result.failed as unknown[][])[0]).toEqual([
			'WP_Error',
			'wp_mail_failed',
			'Mail was not accepted: mail is switched off by MAIL_TRANSPORT=off',
			'Hello'
		]);
		expect(out.depth).toBeNull();
		expect(calls('acct-wp-off')).toHaveLength(0);
	}, 900_000);

	it('refuses on a site with no transport at all, the default Drupal has too', async () => {
		const out = await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site);
			return inWordpress(
				wp,
				`
add_action('wp_mail_failed', static function ($e) use (&$out) {
	$out['reason'] = $e->get_error_message();
});
$out['sent'] = wp_mail('a@example.org', 'Hello', 'x');
`
			);
		});
		expect(out.sent).toBe(false);
		expect(String(out.reason)).toContain('no mail transport is configured');
	}, 900_000);

	it('shows a message the relay refused on the status page, in the REST status and in Site Health', async () => {
		const stub = freshSite();
		stubFetch(403, 'domain not onboarded');
		const wp = await inObject(stub, async (site) => {
			const w = await configureWordpress(site, {
				CF_EMAIL_ACCOUNT_ID: 'acct-wp-lost',
				CF_EMAIL_TOKEN: 'tok',
				HTTP_DRAIN_ON_ALARM: '0'
			});
			await inWordpress(w, `wp_mail('a@example.org', 'Lost', 'x');`);
			return true;
		});
		expect(wp).toBe(true);
		await driveAlarms(stub, (site) => site.countOrNull('cfw_mail_queue') === 0);

		const out = await inObject(stub, async (site) => {
			const result = await inWordpress(
				site as never,
				`
$status = drupflare_host_status();
$out['mail'] = $status['mail'];
$test = drupflare_mail_site_health_test();
$out['health'] = [$test['status'], $test['label']];
$out['debug'] = drupflare_mail_debug_value();
`
			);
			return { result, stats: await statsOf(site) };
		});
		const mail = out.result.mail as Record<string, unknown>;
		expect(mail.failed).toBe(1);
		expect(String(mail.last_error)).toContain('403');
		expect(out.result.health).toEqual(['recommended', '1 accepted messages could not be sent']);
		expect(String(out.result.debug)).toContain('1 failed after acceptance');
		expect((out.stats as { mailFailed?: { count: number } }).mailFailed?.count).toBe(1);
	}, 900_000);
});

const bytesOf = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** the stored files; the table does not exist until the first write, which reads as none */
const filesIn = (site: {
	sql: { exec(q: string, ...b: unknown[]): { toArray(): Record<string, unknown>[] } };
}) => {
	try {
		return site.sql
			.exec('SELECT uri, size, mime FROM cfw_file ORDER BY uri')
			.toArray()
			.map((r) => ({
				uri: String(r.uri),
				size: Number(r.size),
				mime: r.mime as string | null
			}));
	} catch {
		return [];
	}
};

const MEDIA = `
require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';
wp_set_current_user(1);
function cfw_tmp(string $b64, string $ext): string {
	$tmp = sys_get_temp_dir() . '/cfw-' . uniqid() . '.' . $ext;
	file_put_contents($tmp, base64_decode($b64));
	return $tmp;
}
`;

describe('WordPress uploads land in the file store', () => {
	it('stores a sideloaded JPEG and PNG under public://wp-content/uploads with every sub-size', async () => {
		const out = await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site);
			const result = await inWordpress(
				wp,
				`${MEDIA}
foreach (['jpg' => '${PHOTO_JPEG}', 'png' => '${ALPHA_PNG}'] as $ext => $b64) {
	$id = media_handle_sideload(['name' => "photo.$ext", 'tmp_name' => cfw_tmp($b64, $ext)], 0);
	$out[$ext] = is_wp_error($id) ? ['error' => $id->get_error_message()] : [
		'id' => $id,
		'url' => wp_get_attachment_url($id),
		'file' => get_attached_file($id),
		'sizes' => array_map(static fn($s) => [$s['file'], $s['width'], $s['height']], wp_get_attachment_metadata($id)['sizes'] ?? []),
	];
}
`
			);
			return { result, files: filesIn(site) };
		});
		expect(out.result.fatal).toBeUndefined();
		const month = new Date().toISOString().slice(0, 7).replace('-', '/');
		const root = `public://wp-content/uploads/${month}`;
		const jpg = out.result.jpg as Record<string, any>;
		expect(jpg.error).toBeUndefined();
		expect(jpg.url).toBe(`https://wp.example/wp-content/uploads/${month}/photo.jpg`);
		expect(jpg.file).toBe(`${root}/photo.jpg`);
		expect(jpg.sizes).toMatchObject({
			thumbnail: ['photo-150x150.jpg', 150, 150],
			medium: ['photo-300x188.jpg', 300, 188],
			large: ['photo-1024x640.jpg', 1024, 640]
		});
		const png = out.result.png as Record<string, any>;
		expect(png.sizes).toMatchObject({
			thumbnail: ['photo-150x150.png', 150, 150],
			medium: ['photo-300x225.png', 300, 225]
		});

		const uris = out.files.map((f) => f.uri);
		for (const name of [
			'photo.jpg',
			'photo-150x150.jpg',
			'photo-300x188.jpg',
			'photo-1024x640.jpg',
			'photo.png',
			'photo-300x225.png'
		]) {
			expect(uris, name).toContain(`${root}/${name}`);
		}
		// nothing else was written, in particular nothing outside the uploads root
		expect(uris.every((u) => u.startsWith('public://wp-content/uploads/'))).toBe(true);
		expect(out.files.find((f) => f.uri.endsWith('photo.jpg'))).toMatchObject({
			mime: 'image/jpeg'
		});
	}, 900_000);

	it('serves a stored original at the URL WordPress gave out, from the same bytes', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			const wp = await configureWordpress(site);
			await inWordpress(
				wp,
				`${MEDIA}
$id = media_handle_sideload(['name' => 'photo.png', 'tmp_name' => cfw_tmp('${ALPHA_PNG}', 'png')], 0);
`
			);
			const uri = filesIn(site).find((f) => f.uri.endsWith('/photo.png'))!.uri;
			const res = await site.fetch(
				new Request(`https://do.local/__filebytes?uri=${encodeURIComponent(uri)}`)
			);
			return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
		});
		expect(out.status).toBe(200);
		expect(out.bytes).toEqual(bytesOf(ALPHA_PNG));
	}, 900_000);

	it('removes the original and every sub-size when the attachment is deleted', async () => {
		const out = await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site);
			await inWordpress(
				wp,
				`${MEDIA}
$id = media_handle_sideload(['name' => 'gone.jpg', 'tmp_name' => cfw_tmp('${PHOTO_JPEG}', 'jpg')], 0);
$GLOBALS['cfw_id'] = $id;
update_option('cfw_id', $id);
`
			);
			const before = filesIn(site).length;
			const deleted = await inWordpress(
				wp,
				`${MEDIA}
$out['deleted'] = wp_delete_attachment((int) get_option('cfw_id'), true) !== false;
`
			);
			return { before, deleted, after: filesIn(site) };
		});
		expect(out.before).toBeGreaterThanOrEqual(5);
		expect(out.deleted.deleted).toBe(true);
		expect(out.after).toEqual([]);
	}, 900_000);

	it('refuses a script, a type WordPress does not allow and a file that is not the image it claims', async () => {
		const out = await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site);
			const result = await inWordpress(
				wp,
				`${MEDIA}
$try = static function (string $name, string $bytes) {
	$tmp = sys_get_temp_dir() . '/cfw-' . uniqid();
	file_put_contents($tmp, $bytes);
	$file = ['name' => $name, 'tmp_name' => $tmp, 'type' => '', 'error' => 0, 'size' => strlen($bytes)];
	$r = wp_handle_sideload($file, ['test_form' => false]);
	return isset($r['error']) ? $r['error'] : 'stored';
};
$out['fileinfo'] = extension_loaded('fileinfo');
$out['php'] = $try('shell.php', '<?php echo 1;');
$out['double'] = $try('photo.jpg.php', '<?php echo 1;');
$out['fake'] = $try('photo.jpg', 'not an image at all');
add_filter('upload_mimes', static function ($m) { unset($m['png']); return $m; });
$out['mimes'] = $try('photo.png', base64_decode('${ALPHA_PNG}'));
`
			);
			return { result, files: filesIn(site) };
		});
		expect(out.result.fatal).toBeUndefined();
		const refused = 'Sorry, you are not allowed to upload this file type.';
		expect(out.result.php).toBe(refused);
		expect(out.result.double).toBe(refused);
		expect(out.result.mimes).toBe(refused);
		// without ext-fileinfo WordPress cannot compare a file's bytes with its extension, so a text
		// file named photo.jpg is accepted; the name and type checks above are what hold either way
		expect(out.result.fake === 'stored').toBe(out.result.fileinfo === false);
		expect(out.files.map((f) => f.uri.split('/').pop())).toEqual(
			out.result.fake === 'stored' ? ['photo.jpg'] : []
		);
	}, 900_000);

	it('keeps a hostile name inside the uploads root and refuses a path that climbs out', async () => {
		const out = await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site);
			const result = await inWordpress(
				wp,
				`${MEDIA}
$tmp = cfw_tmp('${ALPHA_PNG}', 'png');
$file = ['name' => '../../../evil.png', 'tmp_name' => $tmp, 'type' => '', 'error' => 0, 'size' => 1];
$r = wp_handle_sideload($file, ['test_form' => false]);
$out['file'] = $r['file'] ?? null;
$out['climb'] = [
	@file_put_contents('public://wp-content/uploads/../x.txt', 'a'),
	@copy($tmp, 'public://wp-content/uploads/a/../../../b.png'),
	@mkdir('public://wp-content/uploads/../dir'),
];
$out['private'] = [@file_put_contents('private://secret.txt', 'a'), @is_dir('private://')];
`
			);
			return { result, files: filesIn(site) };
		});
		expect(out.result.fatal).toBeUndefined();
		expect(String(out.result.file)).toMatch(
			/^public:\/\/wp-content\/uploads\/\d{4}\/\d{2}\/evil\.png$/
		);
		expect(out.result.climb).toEqual([false, false, false]);
		expect(out.result.private).toEqual([false, false]);
		expect(out.files.every((f) => f.uri.startsWith('public://wp-content/uploads/'))).toBe(true);
		expect(out.files.some((f) => f.uri.includes('secret'))).toBe(false);
	}, 900_000);
});

describe('a real multipart upload through the front controller', () => {
	const upload = async (site: WordpressSite, authed: boolean, name = 'camera.jpg') => {
		await overlayHostPlugin(site);
		const session = await inWordpress(
			site,
			`
$expiration = time() + 3600;
$token = WP_Session_Tokens::get_instance(1)->create($expiration);
$_COOKIE[LOGGED_IN_COOKIE] = wp_generate_auth_cookie(1, $expiration, 'logged_in', $token);
wp_set_current_user(1);
$out['cookie'] = LOGGED_IN_COOKIE . '=' . rawurlencode($_COOKIE[LOGGED_IN_COOKIE]);
$out['nonce'] = wp_create_nonce('media-form');
`
		);
		await overlayHostPlugin(site);
		const body = multipartBody(
			{ action: 'upload-attachment', _wpnonce: String(session.nonce), name },
			{ field: 'async-upload', name, type: 'image/jpeg', bytes: bytesOf(PHOTO_JPEG) }
		);
		const reply = await site.runJsonMaybeParked(
			wordpressRender('/wp-admin/admin-ajax.php', {
				origin: 'https://wp.example',
				method: 'POST',
				contentType: body.contentType,
				bodyBase64: body.bodyBase64,
				cookie: authed ? String(session.cookie) : ''
			})
		);
		site.resetPhp();
		return reply;
	};

	it('parses the body, stores the file and its sub-sizes, and answers with the URL', async () => {
		const out = await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site);
			const reply = await upload(wp, true);
			return { reply, files: filesIn(site) };
		});
		expect(out.reply.error, String(out.reply.at)).toBeUndefined();
		expect(out.reply.status).toBe(200);
		const answer = JSON.parse(String(out.reply.html)) as {
			success: boolean;
			data: Record<string, any>;
		};
		expect(answer.success, String(out.reply.html).slice(0, 300)).toBe(true);
		expect(String(answer.data.url)).toMatch(
			/^https:\/\/wp\.example\/wp-content\/uploads\/\d{4}\/\d{2}\/camera\.jpg$/
		);
		const uris = out.files.map((f) => f.uri);
		expect(uris.some((u) => u.endsWith('/camera.jpg'))).toBe(true);
		expect(uris.some((u) => u.endsWith('/camera-300x188.jpg'))).toBe(true);
		expect(uris.some((u) => u.endsWith('/camera-150x150.jpg'))).toBe(true);
	}, 900_000);

	it('stores nothing for a visitor who is not logged in', async () => {
		const out = await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site);
			const reply = await upload(wp, false);
			return { reply, files: filesIn(site) };
		});
		expect(out.files).toEqual([]);
		expect(String(out.reply.html)).not.toContain('camera.jpg');
	}, 900_000);
});

describe('WordPress cron runs once and costs the alarm nothing per request', () => {
	const serve = (site: WordpressSite, path: string) =>
		site.fetch(new Request(`https://do.local/__serve?path=${encodeURIComponent(path)}`));

	it('fires a due event once when two triggers arrive together', async () => {
		const seen: string[] = [];
		const out = await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site, { CRON_INTERVAL_MS: '0' });
			wp.parkFetchDep = (async (input: string | URL | Request) => {
				seen.push(
					new URL(typeof input === 'string' ? input : (input as Request).url).pathname
				);
				return Response.json({
					offers: [],
					translations: [],
					plugins: {},
					themes: {},
					no_update: {}
				});
			}) as typeof fetch;
			const [a, b] = await Promise.all([
				serve(wp, '/wp-cron.php'),
				serve(wp, '/wp-cron.php')
			]);
			return { a: a.status, b: b.status };
		});
		expect(out).toEqual({ a: 200, b: 200 });
		// the baked schedule holds one due wp_version_check; each run of it asks api.wordpress.org once
		expect(seen.filter((p) => p.startsWith('/core/version-check/'))).toHaveLength(1);
	}, 900_000);

	it('arms no alarm for a request: ten renders move the firing count by at most the first one', async () => {
		const out = await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site, { CRON_INTERVAL_MS: '0' });
			await serve(wp, '/');
			const before = (await statsOf(wp)).alarmFirings;
			for (let i = 0; i < 10; i++) await serve(wp, '/');
			const after = (await statsOf(wp)).alarmFirings;
			return { before, after };
		});
		expect(out.after - out.before).toBeLessThanOrEqual(2);
	}, 900_000);

	it('reports the rows one cron firing spends', async () => {
		const spent: number[] = [];
		await inObject(freshSite(), async (site) => {
			const wp = (await configureWordpress(site, {
				CRON_INTERVAL_MS: '0'
			})) as WordpressSite & {
				alarm(): Promise<void>;
				dailyRows(): number;
				storage: { put(key: string, value: unknown): Promise<void> };
			};
			wp.parkFetchDep = (async () =>
				Response.json({
					offers: [],
					translations: [],
					plugins: {},
					themes: {},
					no_update: {}
				})) as unknown as typeof fetch;
			for (let i = 0; i < 3; i++) {
				await wp.storage.put('cronLastRunMs', 1);
				const before = wp.dailyRows();
				await wp.alarm();
				spent.push(wp.dailyRows() - before);
			}
		});
		console.log(`CRON_ROWS ${JSON.stringify(spent)}`);
		expect(spent.every((n) => n >= 0)).toBe(true);
	}, 900_000);
});

describe('what a persistent object cache could remove from a front-page render', () => {
	it('counts the queries and the cache groups one render fills, three times', async () => {
		const samples: {
			queries: number;
			groups: Record<string, number>;
			hits: number;
			misses: number;
		}[] = [];
		await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site);
			for (let i = 0; i < 3; i++) {
				const out = await inWordpress(
					wp,
					`
$_SERVER['REQUEST_URI'] = '/';
wp();
ob_start();
require ABSPATH . WPINC . '/template-loader.php';
ob_end_clean();
global $wpdb, $wp_object_cache;
$out['queries'] = count($wpdb->queries);
$out['groups'] = array_map('count', $wp_object_cache->cache);
$out['hits'] = $wp_object_cache->cache_hits;
$out['misses'] = $wp_object_cache->cache_misses;
`,
					{ before: "define('SAVEQUERIES', true);" }
				);
				expect(out.fatal).toBeUndefined();
				samples.push(out as never);
			}
		});
		console.log(`OBJCACHE ${JSON.stringify(samples)}`);
		expect(samples.every((s) => s.queries > 0)).toBe(true);
	}, 900_000);
});

/**
 * Action Scheduler 4.2.0 stores, claims, runs and recovers actions with MySQL statements the
 * translator once refused: an insert from FROM DUAL that reads back insert_id, and a claim that is an
 * UPDATE joined to a SELECT ... FOR UPDATE. The statements below follow `ActionScheduler_DBStore`
 * of that release, through the same `$wpdb->prepare()` calls, over the plugin's own table
 * definitions. The plugin itself is not in the pack.
 */
describe('an Action Scheduler queue', () => {
	it('stores, claims, runs, and recovers a dead worker claim with the plugin statements', async () => {
		const tables = Buffer.from(JSON.stringify(ACTION_SCHEDULER_TABLES)).toString('base64');
		const out = await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site);
			return inWordpress(
				wp,
				`
global $wpdb;
$a = $wpdb->prefix . 'actionscheduler_actions';
$c = $wpdb->prefix . 'actionscheduler_claims';
$errors = [];
foreach (json_decode(base64_decode('${tables}'), true) as $ddl) {
	$wpdb->query($ddl);
	$errors[] = $wpdb->last_error;
}
$schedule = static function (string $hook, string $date, bool $unique = false, string $key = '') use ($wpdb, $a): array {
	$data = ['hook' => $hook, 'status' => 'pending', 'scheduled_date_gmt' => $date, 'scheduled_date_local' => $date, 'schedule' => 'O:8:"stdClass":0:{}', 'group_id' => 0, 'priority' => 10, 'args' => '[]'];
	if ($unique) {
		$data['unique_key'] = $key;
	}
	$columns = '\`' . implode('\`, \`', array_keys($data)) . '\`';
	$holders = implode(', ', ['%s', '%s', '%s', '%s', '%s', '%d', '%d', '%s'] + ($unique ? [8 => '%s'] : []));
	$where = 'SELECT NULL FROM DUAL';
	if ($unique) {
		$where = $wpdb->prepare("\\nSELECT action_id FROM $a\\nWHERE status IN ( %s, %s )\\nAND hook = %s\\nAND \`group_id\` = %d\\nAND args = %s\\n", ['pending', 'in-progress', $hook, 0, '[]']) . ' LIMIT 1';
	}
	$conflict = $unique ? 'ON DUPLICATE KEY UPDATE \`unique_key\` = VALUES(\`unique_key\`)' : '';
	$sql = $wpdb->prepare("\\nINSERT INTO $a ( $columns )\\nSELECT $holders FROM DUAL\\nWHERE ( $where ) IS NULL\\n$conflict", array_values($data));
	$rows = $wpdb->query($sql);
	return [$rows, (int) $wpdb->insert_id, $wpdb->last_error];
};
$past = gmdate('Y-m-d H:i:s', time() - 60);
$out['ids'] = [];
foreach (['cfw_job_1', 'cfw_job_2', 'cfw_job_3'] as $hook) {
	$out['ids'][] = $schedule($hook, $past)[1];
}
$out['ids'][] = $schedule('cfw_job_later', gmdate('Y-m-d H:i:s', time() + 3600))[1];
$claim = static function (int $limit) use ($wpdb, $a, $c): array {
	$now = gmdate('Y-m-d H:i:s');
	$wpdb->insert($c, ['date_created_gmt' => $now]);
	$claimId = (int) $wpdb->insert_id;
	$select = $wpdb->prepare("SELECT action_id from $a WHERE claim_id = 0 AND scheduled_date_gmt <= %s AND status=%s ORDER BY priority ASC, attempts ASC, scheduled_date_gmt ASC, action_id ASC LIMIT %d FOR UPDATE", [$now, 'pending', $limit]);
	$rows = $wpdb->query($wpdb->prepare("UPDATE $a t1 JOIN ( $select ) t2 ON t1.action_id = t2.action_id SET claim_id=%d, last_attempt_gmt=%s, last_attempt_local=%s", [$claimId, $now, $now]));
	$GLOBALS['cfwErrors'][] = $wpdb->last_error;
	$held = [];
	foreach ($wpdb->get_results($wpdb->prepare("SELECT action_id, scheduled_date_gmt FROM $a WHERE claim_id = %d ORDER BY priority ASC, attempts ASC, scheduled_date_gmt ASC, action_id ASC", $claimId)) as $row) {
		$held[] = (int) $row->action_id;
	}
	return [$claimId, $rows, $held];
};
[$idA, $rowsA, $heldA] = $claim(2);
[$idB, $rowsB, $heldB] = $claim(3);
[, $rowsN, $heldN] = $claim(3);
$out['a'] = [$rowsA, $heldA];
$out['b'] = [$rowsB, $heldB];
$out['none'] = [$rowsN, $heldN];
$out['claims'] = (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $c c WHERE EXISTS ( SELECT 1 FROM $a a WHERE a.claim_id = c.claim_id AND a.status IN ( %s, %s ) )", ['pending', 'in-progress']));
// worker A died: its claim is older than the timeout and nothing completed
$wpdb->query($wpdb->prepare("UPDATE $a SET last_attempt_gmt = %s WHERE claim_id = %d", [gmdate('Y-m-d H:i:s', time() - 600), $idA]));
$stale = $wpdb->get_col($wpdb->prepare("SELECT a.action_id FROM $a a WHERE 1=1 AND a.status IN (%s) AND a.last_attempt_gmt <= %s AND a.claim_id != 0 LIMIT %d, %d", ['pending', gmdate('Y-m-d H:i:s', time() - 300), 0, 25]));
foreach ($stale as $id) {
	$wpdb->update($a, ['claim_id' => 0], ['action_id' => $id], ['%s'], ['%d']);
}
$out['stale'] = array_map('intval', $stale);
[$idC, $rowsC, $heldC] = $claim(5);
$out['c'] = [$rowsC, $heldC];
foreach ($heldC as $id) {
	$wpdb->query($wpdb->prepare("UPDATE $a SET attempts = attempts+1, status=%s, last_attempt_gmt = %s, last_attempt_local = %s WHERE action_id = %d", ['in-progress', gmdate('Y-m-d H:i:s'), gmdate('Y-m-d H:i:s'), $id]));
	$wpdb->update($a, ['status' => 'complete', 'last_attempt_gmt' => gmdate('Y-m-d H:i:s'), 'last_attempt_local' => gmdate('Y-m-d H:i:s'), 'unique_key' => null], ['action_id' => $id], ['%s', '%s', '%s', '%s'], ['%d']);
}
// release_claim() on the third action's worker clears what it still holds
$pending = $wpdb->get_col($wpdb->prepare("SELECT action_id FROM $a WHERE claim_id = %d AND status = %s", $idB, 'pending'));
$out['released'] = $wpdb->query("UPDATE $a SET claim_id = 0 WHERE action_id IN (" . implode(',', array_map('absint', $pending)) . ')');
$wpdb->delete($c, ['claim_id' => $idB], ['%d']);
$out['status'] = $wpdb->get_results("SELECT action_id, status, attempts, claim_id FROM $a ORDER BY action_id", ARRAY_N);
// a unique action is stored once, a pending twin blocks it, and a finished one that kept its key conflicts quietly
$first = $schedule('cfw_unique', $past, true, 'cfw_unique|0|[]');
$twin = $schedule('cfw_unique', $past, true, 'cfw_unique|0|[]');
$wpdb->query("UPDATE $a SET status = 'complete' WHERE hook = 'cfw_unique'");
$kept = $schedule('cfw_unique', $past, true, 'cfw_unique|0|[]');
$freed = $wpdb->query($wpdb->prepare("UPDATE $a SET unique_key = NULL WHERE unique_key = %s AND status IN (%s, %s, %s)", 'cfw_unique|0|[]', 'complete', 'failed', 'canceled'));
$again = $schedule('cfw_unique', $past, true, 'cfw_unique|0|[]');
$out['unique'] = [[$first[0], $first[1] > 0, $first[2]], [$twin[0], $twin[1], $twin[2]], [$kept[0], $kept[1], $kept[2]], $freed, [$again[0], $again[1] > 0, $again[2]]];
$out['errors'] = array_values(array_filter(array_merge($errors, $GLOBALS['cfwErrors'] ?? [])));
`
			);
		});
		expect(out.fatal).toBeUndefined();
		expect(out.errors).toEqual([]);
		// every store reads insert_id back, which an INSERT from FROM DUAL must report
		expect(out.ids).toEqual([1, 2, 3, 4]);
		expect(out.a).toEqual([2, [1, 2]]);
		// the second worker finds the first two held and takes only the third
		expect(out.b).toEqual([1, [3]]);
		expect(out.none).toEqual([0, []]);
		expect(out.claims).toBe(2);
		expect(out.stale).toEqual([1, 2]);
		// after the release the two are claimable again, and nothing else is
		expect(out.c).toEqual([2, [1, 2]]);
		expect(out.released).toBe(1);
		expect(out.status).toEqual([
			['1', 'complete', '1', '4'],
			['2', 'complete', '1', '4'],
			['3', 'pending', '0', '0'],
			['4', 'pending', '0', '0']
		]);
		expect(out.unique).toEqual([[1, true, ''], [0, 0, ''], [0, 0, ''], 1, [1, true, '']]);
	}, 900_000);
});
