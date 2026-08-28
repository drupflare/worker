import { describe, expect, it } from 'vitest';
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
		await site.runJson(
			`<?php
			\\Drupal::configFactory()->getEditable("user.settings")->set("register", "visitors")->save();
			\\Drupal::service("cache.config")->deleteAll();
			echo json_encode(["ok" => true]);`
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
