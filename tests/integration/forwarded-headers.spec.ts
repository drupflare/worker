import { describe, expect, it } from 'vitest';
import { passThroughHeaders } from '../../src/do/helpers';
import { BOOT_KERNEL, renderPage } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The headers the serve path hands Drupal, through a booted site.
 *
 * `$_SERVER` outlives a request on a persistent interpreter, so the case that matters is the second
 * request: a token set for visitor A must not still be there for visitor B. The first two checks
 * pin that and the third pins that a header reaches the superglobal at all.
 *
 * Needs the pack, so it is in `ARTIFACT_SPECS`.
 */

type Payload = Record<string, unknown>;
const TIMEOUT = 600_000;

const READ = String.raw`<?php
echo json_encode([
  'authorization' => $_SERVER['HTTP_AUTHORIZATION'] ?? null,
  'apiKey' => $_SERVER['HTTP_X_API_KEY'] ?? null,
  'agent' => $_SERVER['HTTP_USER_AGENT'] ?? null,
]);
`;

async function sequence(): Promise<Payload[]> {
	return inObject(freshSite(), async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		const booted = (await site.runJson(BOOT_KERNEL)) as Payload;
		if (booted?.['ok'] === false) throw new Error(`boot failed: ${JSON.stringify(booted)}`);
		const reads: Payload[] = [];
		const render = async (headers?: Record<string, string>) => {
			await site.runJson(
				renderPage('/user/login', ['page'], false, headers === undefined ? {} : { headers })
			);
			reads.push((await site.runJson(READ)) as Payload);
		};
		await render({ authorization: 'Bearer one', 'x-api-key': 'k', 'user-agent': 'probe/1' });
		await render({ authorization: 'Bearer two' });
		await render();
		return reads;
	});
}

describe('request headers in a booted site', () => {
	it(
		'reach $_SERVER under the names PHP gives them',
		async () => {
			const [first] = await sequence();
			expect(first).toEqual({ authorization: 'Bearer one', apiKey: 'k', agent: 'probe/1' });
		},
		TIMEOUT
	);

	it(
		'replace the previous request, so a token never outlives the request that carried it',
		async () => {
			const [, second] = await sequence();
			expect(second?.['authorization']).toBe('Bearer two');
			expect(second?.['apiKey']).toBeNull();
			expect(second?.['agent']).toBeNull();
		},
		TIMEOUT
	);

	it(
		'are gone after a request that carried none',
		async () => {
			const [, , third] = await sequence();
			expect(third).toEqual({ authorization: null, apiKey: null, agent: null });
		},
		TIMEOUT
	);
});

/**
 * What `cfw_page`, `caches.default` and the KV tier key a stored page on: the path and the
 * generation, and nothing about the request. So a stored 200 reaches every visitor, and the only
 * way it can be the wrong representation is a render that varies by something the visitor sent.
 *
 * These are the three inputs the serve path hands Drupal besides the cookie. A real render of the
 * shipped pack, cold in both page bins, is compared byte for byte across them.
 */
describe('the page cache key and the request headers it leaves out', () => {
	const AGENT = 'Googlebot/2.1 (+http://www.google.com/bot.html)';
	const VARIANTS: Record<string, Record<string, unknown>> = {
		plain: {},
		accept: { accept: 'application/json' },
		agent: { headers: { 'user-agent': AGENT } },
		origin: { headers: { origin: 'https://other.example' } },
		all: {
			accept: 'application/json',
			headers: { 'user-agent': AGENT, origin: 'https://other.example' }
		}
	};
	const PATHS = ['/', '/user/login'];
	// a form's build id is minted per render, so it differs between two identical requests; the
	// selector copy of it went through Html::getId(), which collapses hyphens and so is shorter
	const sameRender = (html: unknown) =>
		String(html).replace(/form-[A-Za-z0-9_-]{30,}/gi, 'form-BUILD-ID');

	it(
		'renders the same anonymous page whatever Accept, User-Agent or Origin arrived',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const booted = (await site.runJson(BOOT_KERNEL)) as Payload;
				if (booted?.['ok'] === false)
					throw new Error(`boot failed: ${JSON.stringify(booted)}`);
				const out: Record<string, Record<string, Payload>> = {};
				for (const path of PATHS) {
					out[path] = {};
					for (const [name, request] of Object.entries(VARIANTS)) {
						out[path][name] = (await site.runJson(
							renderPage(path, ['page', 'dynamic_page_cache'], false, request)
						)) as Payload;
					}
				}
				return out;
			});
			for (const path of PATHS) {
				const plain = seen[path]?.['plain'] as Payload;
				expect(plain['status'], path).toBe(200);
				for (const name of Object.keys(VARIANTS)) {
					const variant = seen[path]?.[name] as Payload;
					console.info(
						`[cache-key] ${path} ${name}: status=${variant['status']} bytes=${variant['bytes']} ` +
							`type=${variant['contentType']} cache-control=${variant['cacheControl']} ` +
							`vary=${JSON.stringify(variant['vary'])}`
					);
					expect(sameRender(variant['html']), `${path} ${name}`).toBe(
						sameRender(plain['html'])
					);
					expect(variant['status'], `${path} ${name}`).toBe(plain['status']);
					expect(variant['contentType'], `${path} ${name}`).toBe(plain['contentType']);
					expect(variant['cacheControl'], `${path} ${name}`).toBe(plain['cacheControl']);
					expect(variant['vary'], `${path} ${name}`).toBe(plain['vary']);
				}
			}
		},
		TIMEOUT
	);
});

/**
 * What a real render hands the policy layer.
 *
 * The render fragment reports every response header and the host decides which reach a browser, so
 * a real Drupal response has to show the allow-listed names through the boundary (core sets
 * `X-Frame-Options` and `X-Content-Type-Options` itself) and never `set-cookie`. The markup half
 * is the CSP baseline's compatibility check under this pool: it constrains `<object>`, `<embed>`
 * and `<base>` and nothing else, so a core page carrying none of them raises no violation under it.
 * The admin pages and the media form need a session and are covered by the browser lane only.
 */
describe('the headers and markup a real render hands the CSP baseline', () => {
	const PAGES = ['/', '/user/login', '/user/password'];

	it(
		'reports the allow-listed headers, drops set-cookie, and carries no object, embed or base element',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const booted = (await site.runJson(BOOT_KERNEL)) as Payload;
				if (booted?.['ok'] === false)
					throw new Error(`boot failed: ${JSON.stringify(booted)}`);
				const out: Record<string, Payload> = {};
				for (const path of PAGES) {
					out[path] = (await site.runJson(
						renderPage(path, ['page', 'dynamic_page_cache'], false, {})
					)) as Payload;
				}
				return out;
			});
			for (const path of PAGES) {
				const page = seen[path] as Payload;
				expect(page['status'], path).toBe(200);
				const passed = passThroughHeaders(page['passHeaders']);
				console.info(`[csp-baseline] ${path}: ${JSON.stringify(passed)}`);
				expect(Object.keys(passed), path).toContain('x-frame-options');
				expect(Object.keys(passed), path).not.toContain('set-cookie');
				expect(String(page['html']), path).not.toMatch(/<(object|embed|applet|base)[\s>]/i);
			}
		},
		TIMEOUT
	);
});
