import { describe, expect, it } from 'vitest';
import { carriesUpload, drupalOp, phpBodyExpression, requestBody } from '../../src/drupal/site-php';
import { druplicon } from '../fixtures/png';
import { claimSite, hiddenFields, loginJar, render } from '../helpers/drupal-forms';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * A `multipart/form-data` submission has to reach Drupal as a submission.
 *
 * PHP fills `$_POST` and `$_FILES` only for a real POST SAPI and this interpreter has none, so the
 * body was parsed for `application/x-www-form-urlencoded` and DISCARDED for multipart. Drupal then
 * saw no `form_id`, rebuilt the form and answered 200 -- a silent no-op with no error anywhere.
 *
 * The blast radius is every form carrying a file field, because that is what sets the enctype:
 * `/user/register` and `/user/*` + `/edit` both have the Picture field, plus any node type with an
 * image. Found by driving a browser at the registration form; no HTTP-level lane could see it,
 * because the response was a valid 200 either way.
 *
 * The arms are PAIRED on one object: urlencoded is the control that already worked, so a multipart
 * failure cannot be blamed on the fixture.
 */

const TIMEOUT = 900_000;
const BOUNDARY = '----cfwTestBoundary8812';

/** a multipart body, CRLF-delimited exactly as a browser sends it */
function multipart(fields: Record<string, string>): string {
	let out = '';
	for (const [name, value] of Object.entries(fields)) {
		out += `--${BOUNDARY}\r\n`;
		out += `Content-Disposition: form-data; name="${name}"\r\n\r\n`;
		out += `${value}\r\n`;
	}
	// the empty part a browser sends when no file is chosen, which must NOT read as an upload
	out += `--${BOUNDARY}\r\n`;
	out += 'Content-Disposition: form-data; name="files[unchosen]"; filename=""\r\n';
	out += 'Content-Type: application/octet-stream\r\n\r\n';
	out += '\r\n';
	out += `--${BOUNDARY}--\r\n`;
	return out;
}

const urlencoded = (fields: Record<string, string>) =>
	Object.entries(fields)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join('&');

async function provisioned(): Promise<DurableObjectStub> {
	const stub = freshSite();
	await inObject(stub, async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		const r = await site.fetch(
			new Request('https://do.local/__firstrun', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ adminPass: 'cfw-Multi-6621-pass', siteName: 'Multi' })
			})
		);
		expect(r.status, await r.clone().text()).toBe(200);
		// the shipped pack registers admin_only, so a visitor cannot reach the form at all
		// `drupalOp` rather than a bare fragment: provisioning drops the interpreter, so there is no
		// resident container to reach `\Drupal::` through
		await site.runJson(
			drupalOp(`\\Drupal::configFactory()->getEditable("user.settings")
				->set("register", "visitors")->save();
			\\Drupal::service("cache.config")->deleteAll();`)
		);
	});
	return stub;
}

/** registers a user through one encoding and reports whether the row exists */
async function register(
	username: string,
	encode: (f: Record<string, string>) => string,
	contentType: string
): Promise<number> {
	return inObject(await provisioned(), async (site: ServeDo) => {
		site.sql.exec('DELETE FROM cfw_page WHERE path = ?', '/user/register');
		await site.fillOne('/user/register');
		const html = String(
			(
				site.sql
					.exec('SELECT html FROM cfw_page WHERE path = ?', '/user/register')
					.toArray()[0] as { html?: string } | undefined
			)?.html ?? ''
		);
		const formId = /name="form_id"[^>]*value="([^"]+)"/.exec(html)?.[1] ?? '';
		const buildId = /name="form_build_id"[^>]*value="([^"]+)"/.exec(html)?.[1] ?? '';
		expect(formId, 'the registration form did not render its form_id').not.toBe('');

		await site.fillOne('/user/register', undefined, false, {
			method: 'POST',
			contentType,
			body: encode({
				form_id: formId,
				form_build_id: buildId,
				'name[0][value]': username,
				name: username,
				'mail[0][value]': `${username}@example.com`,
				mail: `${username}@example.com`,
				op: 'Create new account'
			})
		});

		return site.sql.exec('SELECT name FROM users_field_data WHERE name = ?', username).toArray()
			.length;
	});
}

// every uploaded image arrived UTF-8 mangled and the render died with no JSON in its output
describe('a binary body reaches PHP byte for byte', () => {
	it(
		'hands PHP the same bytes the request carried, and leaves a text body as text',
		async () => {
			const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
			const sent = requestBody(bytes);
			expect('bodyBase64' in sent).toBe(true);
			expect(requestBody(new TextEncoder().encode('name=é&op=Save'))).toEqual({
				body: 'name=é&op=Save'
			});
			const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('');
			const got = await inObject(freshSite(), (site: ServeDo) =>
				site.runJson(
					`<?php $b = ${phpBodyExpression(sent)}; echo json_encode(["len" => strlen($b), "sha" => hash("sha256", $b)]);`
				)
			);
			expect(got).toEqual({ len: 256, sha: expected });
		},
		TIMEOUT
	);
});

/** a multipart body carrying one binary file part among text fields */
function withFile(fields: Record<string, string>, field: string, name: string, bytes: Uint8Array) {
	const text = (s: string) => new TextEncoder().encode(s);
	let head = '';
	for (const [key, value] of Object.entries(fields)) {
		head += `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
	}
	head += `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\n`;
	head += 'Content-Type: image/png\r\n\r\n';
	const parts = [text(head), bytes, text(`\r\n--${BOUNDARY}--\r\n`)];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

// every upload answered 200 and stored nothing: isValid() and move_uploaded_file() both ask PHP
// for its table of this request's uploads, which only a POST SAPI fills
describe('an uploaded file is stored', () => {
	it(
		'saves a media image through the real form, with the bytes the browser sent',
		async () => {
			const ORIGIN = 'https://do.local';
			const PASS = 'cfw-Upload-4417-pass';
			const png = druplicon();
			const result = await inObject(freshSite(), async (site: ServeDo) => {
				await claimSite(site, PASS, 'Upload');
				// the packed container predates the file_system swap; reconciliation drops it on a
				// real site when the driver digest moves
				site.sql.exec('DELETE FROM cache_container');
				const cookie = await loginJar(site, 'admin', PASS, ORIGIN);
				const form = await render(site, '/media/add/image', { cookie, origin: ORIGIN });
				const hidden = hiddenFields(String(form['html'] ?? ''));
				expect(hidden['form_id'], 'the media form did not render').toBe(
					'media_image_add_form'
				);

				const body = withFile(
					{
						...hidden,
						'field_media_image[0][alt]': 'The Drupal drop',
						op: 'Save'
					},
					'files[field_media_image_0]',
					'druplicon.png',
					png
				);
				const saved = await render(site, '/media/add/image', {
					method: 'POST',
					contentType: `multipart/form-data; boundary=${BOUNDARY}`,
					cookie,
					origin: ORIGIN,
					...requestBody(body)
				});
				const file = site.sql
					.exec("SELECT uri FROM file_managed WHERE filename = 'druplicon.png'")
					.toArray()[0] as { uri?: string } | undefined;
				const chunks = site.sql
					.exec(
						'SELECT bytes FROM cfw_file_chunk WHERE uri = ? ORDER BY seq',
						file?.uri ?? ''
					)
					.toArray()
					.map((row) => new Uint8Array(row['bytes'] as ArrayBuffer));
				const stored = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
				chunks.reduce((at, c) => (stored.set(c, at), at + c.length), 0);
				return {
					status: saved['status'],
					uri: file?.uri ?? null,
					identical: stored.length === png.length && stored.every((b, i) => b === png[i]),
					media: site.sql
						.exec(
							`SELECT COUNT(*) AS n FROM media__field_media_image m
							JOIN file_managed f ON f.fid = m.field_media_image_target_id
							WHERE f.filename = 'druplicon.png'`
						)
						.toArray()[0]?.['n']
				};
			});

			console.log(`[multipart-submit] upload ${JSON.stringify(result)}`);
			expect(result.uri, 'no file_managed row, so the upload was refused').toMatch(
				/^public:\/\/.*druplicon\.png$/
			);
			expect(result.identical, 'the stored file is not the bytes the browser sent').toBe(
				true
			);
			expect(result.media, 'the media entity does not reference the upload').toBe(1);
			expect(result.status, 'a saved form redirects').toBe(303);
		},
		TIMEOUT
	);

	// file_save_upload() caches each upload in a function static keyed on the field name, so the
	// second upload to a field was handed the first file; measured on a deploy, three media saved
	// against one file
	it(
		'gives a second upload to the same field its own file',
		async () => {
			const ORIGIN = 'https://do.local';
			const PASS = 'cfw-Upload-4418-pass';
			const png = druplicon();
			const result = await inObject(freshSite(), async (site: ServeDo) => {
				await claimSite(site, PASS, 'Upload');
				site.sql.exec('DELETE FROM cache_container');
				const cookie = await loginJar(site, 'admin', PASS, ORIGIN);
				const fileOfNewestMedia = () =>
					site.sql
						.exec(
							`SELECT f.filename AS name FROM media__field_media_image m
							JOIN file_managed f ON f.fid = m.field_media_image_target_id
							ORDER BY m.entity_id DESC LIMIT 1`
						)
						.toArray()[0]?.['name'] ?? null;
				const upload = async (name: string, via: 'serve' | 'render') => {
					const form = await render(site, '/media/add/image', { cookie, origin: ORIGIN });
					const body = withFile(
						{
							...hiddenFields(String(form['html'] ?? '')),
							'field_media_image[0][alt]': name,
							op: 'Save'
						},
						'files[field_media_image_0]',
						name,
						png
					);
					const contentType = `multipart/form-data; boundary=${BOUNDARY}`;
					if (via === 'serve') {
						const res = await site.fetch(
							new Request(
								`${ORIGIN}/__serve?path=${encodeURIComponent('/media/add/image')}`,
								{
									method: 'POST',
									headers: { cookie, 'content-type': contentType },
									body
								}
							)
						);
						await res.arrayBuffer();
					} else {
						await render(site, '/media/add/image', {
							method: 'POST',
							contentType,
							cookie,
							origin: ORIGIN,
							...requestBody(body)
						});
					}
					return fileOfNewestMedia();
				};
				return {
					serve: [
						await upload('first.png', 'serve'),
						await upload('second.png', 'serve')
					],
					// straight into the resident interpreter, with no request boundary for the
					// object to act on
					control: [
						await upload('third.png', 'render'),
						await upload('fourth.png', 'render')
					]
				};
			});

			console.log(`[multipart-submit] repeat ${JSON.stringify(result)}`);
			expect(result.serve).toEqual(['first.png', 'second.png']);
			expect(result.control, 'CONTROL: the static no longer survives a render').toEqual([
				'third.png',
				'third.png'
			]);
			expect(
				carriesUpload(
					`multipart/form-data; boundary=${BOUNDARY}`,
					withFile({}, 'f', 'a.png', png)
				)
			).toBe(true);
			expect(
				carriesUpload(
					`multipart/form-data; boundary=${BOUNDARY}`,
					new TextEncoder().encode(multipart({ op: 'Save' }))
				)
			).toBe(false);
			expect(
				carriesUpload(
					'application/x-www-form-urlencoded',
					new TextEncoder().encode('filename="a"')
				)
			).toBe(false);
		},
		TIMEOUT
	);
});

describe('a multipart submission reaches Drupal as a submission', () => {
	it(
		'creates a user row through multipart, exactly as urlencoded already did',
		async () => {
			// ONE OBJECT PER ARM: a completed registration redirects, a 3xx is not stored, and the
			// second arm then reads an empty page row rather than a form
			const control = await register(
				'urlencodeduser',
				urlencoded,
				'application/x-www-form-urlencoded'
			);
			const arm = await register(
				'multipartuser',
				multipart,
				`multipart/form-data; boundary=${BOUNDARY}`
			);

			console.log(
				`[multipart-submit] ${JSON.stringify({ urlencoded: control, multipart: arm })}`
			);

			// the CONTROL first: if urlencoded stopped working the fixture is wrong, not the parser
			expect(control, 'the urlencoded control failed, so the fixture is broken').toBe(1);
			expect(
				arm,
				'a multipart registration created no user row, so the body was discarded'
			).toBe(1);
		},
		TIMEOUT
	);
});
