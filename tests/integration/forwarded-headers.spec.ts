import { describe, expect, it } from 'vitest';
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
