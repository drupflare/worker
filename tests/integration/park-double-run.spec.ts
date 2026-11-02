import { describe, expect, it } from 'vitest';
import { renderPage, type RenderRequest } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * A request runs its PHP once, however the parked run ends.
 *
 * `runJsonMaybeParked` used to fall through to `site.runJson(code)` whenever the parked run's
 * output was not one parseable object, which re-ran the whole request from the top: a SimpleSAMLphp
 * debug line (`%date{M j H:i:s}`) or a `{closure}` notice before the JSON was enough, and so was a
 * refused park, whose unwind threw the rest of the chain's output away. Everything the first run
 * wrote before that point was already committed, so the second run saw a consumed SAML state or
 * saved a second node. The counter is a global bumped at the entry of the program, read back
 * through an unparked run, so nothing the harness does can add to it.
 */

type Interp = ServeDo & {
	run: (code: string) => Promise<string>;
	runJsonMaybeParked: (code: string) => Promise<Record<string, unknown>>;
	parkState: () => Promise<{ state: string; armed: string[] }>;
};

const entries = async (site: ServeDo): Promise<number> =>
	Number((await site.runJson('<?php echo json_encode(["n" => $GLOBALS["N"] ?? 0]);'))['n']);

const program = (body: string): string =>
	`<?php $GLOBALS["N"] = ($GLOBALS["N"] ?? 0) + 1; ${body} echo json_encode(["ok" => true]);`;

const refuseSocket =
	'if (!function_exists("refuse")) { function refuse() { ' +
	'return @stream_socket_client("tcp://a.invalid:80", $e, $m, 1); } } refuse();';

const shapes: Record<string, string> = {
	control: '',
	'a notice with a brace before the json': 'echo "Deprecated: x {closure} in y\\n";',
	'forty log lines with a brace before the json':
		'echo str_repeat("%date{M j H:i:s} SimpleSAMLphp DEBUG getServerHTTPS()\\n", 40);',
	'a refused park before the json': refuseSocket,
	'a refused park and a brace line': `${refuseSocket} echo "%date{M j} DEBUG\\n";`
};

describe('a parked run answers once and never re-runs the request', () => {
	for (const [name, body] of Object.entries(shapes)) {
		it(`enters the program once for ${name}`, async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				const s = site as Interp;
				expect((await s.parkState()).state).toBe('installed');
				const reply = await s.runJsonMaybeParked(program(body));
				return { reply, entered: await entries(site) };
			});
			expect(seen.reply).toEqual({ ok: true });
			expect(seen.entered).toBe(1);
		});
	}

	it('says no result was printed, and still runs once', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const s = site as Interp;
			await s.parkState();
			const reply = await s.runJsonMaybeParked(
				'<?php $GLOBALS["N"] = ($GLOBALS["N"] ?? 0) + 1; echo "no result {here}";'
			);
			return { reply, entered: await entries(site) };
		});
		expect(seen.entered).toBe(1);
		expect(seen.reply['error']).toBe('no JSON in output');
	});

	it('starts the next request on a clean chain after a refusal', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const s = site as Interp;
			await s.parkState();
			await s.runJsonMaybeParked(program(refuseSocket));
			const next = await s.runJsonMaybeParked(program(''));
			return { next, entered: await entries(site) };
		});
		expect(seen.next).toEqual({ ok: true });
		expect(seen.entered).toBe(2);
	});
});

// #region a real form submit, counted by rows

const PASS = 'cfw-Park-Pass-4417';

const json = async (site: ServeDo, path: string, init?: RequestInit) =>
	(await site.fetch(new Request(`https://do.local${path}`, init))).json() as Promise<
		Record<string, unknown>
	>;

const hiddenFields = (html: string): Record<string, string> => {
	const fields: Record<string, string> = {};
	for (const tag of html.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []) {
		const name = /name="([^"]*)"/.exec(tag)?.[1];
		const value = /value="([^"]*)"/.exec(tag)?.[1] ?? '';
		if (name) fields[name] = value.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
	}
	return fields;
};

const encodeForm = (fields: Record<string, string>): string =>
	Object.entries(fields)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join('&');

const post = (fields: Record<string, string>, cookie: string): RenderRequest => ({
	method: 'POST',
	body: encodeForm(fields),
	contentType: 'application/x-www-form-urlencoded',
	cookie
});

const nodeRows = async (site: ServeDo): Promise<number> => {
	const sql = 'SELECT COUNT(*) AS n FROM node_field_data';
	const out = await json(site, `/__sql?q=${encodeURIComponent(sql)}`);
	const row = (out['rows'] as unknown[])[0];
	return Number(Array.isArray(row) ? row[0] : (row as { n: unknown }).n);
};

describe('a node create POST through the park', () => {
	it('creates one node and runs once, clean and on a refused park', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const s = site as Interp;
			await json(site, '/__migrate?all=1');
			await json(site, '/__firstrun', {
				method: 'POST',
				body: JSON.stringify({ adminPass: PASS, siteName: 'Park' }),
				headers: { 'content-type': 'application/json' }
			});
			const login = await site.runJson(
				renderPage(
					'/user/login',
					[],
					false,
					post(
						{ name: 'admin', pass: PASS, form_id: 'user_login_form', op: 'Log in' },
						''
					)
				)
			);
			const jar =
				((login['setCookie'] as string[] | undefined) ?? [])
					.find((line) => /^S?SESS/.test(line))
					?.split(';')[0] ?? '';

			expect((await s.parkState()).state).toBe('installed');
			// one entry per `cfw_park_run`, and one per unparked render
			const real = s.run.bind(s);
			const counts = { parked: 0, unparked: 0 };
			s.run = async (code: string) => {
				if (code.includes('cfw_park_run(')) counts.parked += 1;
				else if (/=\s*cfw_serve\(\$path/.test(code)) counts.unparked += 1;
				return real(code);
			};

			const arms: Record<string, string> = {
				clean: '',
				'a refused park': refuseSocket
			};
			const out: Record<string, Record<string, unknown>> = {};
			let expectedRows = 0;
			for (const [name, prefix] of Object.entries(arms)) {
				const form = await site.runJson(
					renderPage('/node/add/page', [], false, { cookie: jar })
				);
				const fields = hiddenFields(String(form['html'] ?? ''));
				counts.parked = 0;
				counts.unparked = 0;
				const code = renderPage(
					'/node/add/page',
					[],
					false,
					post(
						{
							...fields,
							'title[0][value]': `Park ${name}`,
							'body[0][value]': 'body',
							'status[value]': '1',
							op: 'Save'
						},
						jar
					)
				).replace(/^<\?php/, `<?php ${prefix}`);
				const created = await s.runJsonMaybeParked(code);
				expectedRows += 1;
				out[name] = {
					location: created['location'],
					error: created['error'],
					parkRuns: counts.parked,
					unparkedRuns: counts.unparked,
					rows: await nodeRows(site),
					expectedRows
				};
			}
			return out;
		});
		for (const arm of Object.values(seen)) {
			expect(arm['error']).toBeUndefined();
			expect(String(arm['location'])).toMatch(/\/node\/\d+/);
			expect(arm['parkRuns']).toBe(1);
			expect(arm['unparkedRuns']).toBe(0);
			expect(arm['rows']).toBe(arm['expectedRows']);
		}
	}, 900_000);
});

// #endregion

describe('a PUT of 1 MiB or more through the parked fetch', () => {
	it('reaches fetch whole, without the Expect header Guzzle adds from 1 MiB', async () => {
		const seen: { size: number; expect: string | null }[] = [];
		for (const size of [786_432, 1_048_576, 2_097_152]) {
			await inObject(freshSite(), async (site: ServeDo) => {
				const s = site as Interp & { parkFetchDep?: typeof fetch };
				await site.runJson(renderPage('/user/login', [], false, {}));
				expect((await s.parkState()).state).toBe('installed');
				s.parkFetchDep = (async (_url: string, init: RequestInit) => {
					seen.push({
						size: (init.body as Uint8Array).length,
						expect: new Headers(init.headers).get('expect')
					});
					return new Response('ok', { status: 200 });
				}) as unknown as typeof fetch;
				const put =
					'<?php $c = new \\GuzzleHttp\\Client(["handler" => \\GuzzleHttp\\HandlerStack::create(' +
					'new \\Drupal\\drupflare\\Http\\ParkFetchHandler())]); ' +
					`$r = $c->request("PUT", "http://store.test/o", ["body" => str_repeat("a", ${size})]); ` +
					'echo json_encode(["status" => $r->getStatusCode()]);';
				expect(await s.runJsonMaybeParked(put)).toEqual({ status: 200 });
			});
		}
		expect(seen).toEqual([
			{ size: 786_432, expect: null },
			{ size: 1_048_576, expect: null },
			{ size: 2_097_152, expect: null }
		]);
	}, 300_000);
});
