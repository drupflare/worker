import { describe, expect, it } from 'vitest';
import { CF_AUTH_URL } from '../../src/ops/cf-oauth';
import { freshSite, inObject } from '../helpers/serve-do';

/**
 * The OAuth routes, driven rather than imported.
 *
 * `check:reachability` exists here because a module can be green in CI and imported by nothing that
 * ships -- the health layer was, for the whole life of the project. `cf-oauth.ts` has 28 unit tests
 * and they prove the ALGEBRA; this proves the object answers on the route, which is the half that
 * was missing the last time something looked finished and was not.
 */

const call = (site: ReturnType<typeof freshSite>, query: string) =>
	inObject(site, (obj) =>
		obj.handle(
			new Request(`https://site.example/__cfoauth?${query}`),
			new URL(`https://site.example/__cfoauth?${query}`)
		)
	);

describe('the /__cfoauth route', () => {
	it('reports disconnected before anything is configured', async () => {
		const res = await call(freshSite(), 'action=status');
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.connected).toBe(false);
		expect(body.clientId).toBeNull();
	});

	it('refuses to start without a registered client rather than inventing one', async () => {
		const res = await call(freshSite(), 'action=connect');
		expect(res.status).toBe(400);
		expect(String(((await res.json()) as { error: string }).error)).toContain('OAuth client');
	});

	it('mints an authorize URL carrying S256 and no verifier', async () => {
		const site = freshSite();
		const res = await call(site, 'action=connect&client_id=abc123');
		const body = (await res.json()) as { ok: boolean; authorizeUrl: string };
		expect(body.ok).toBe(true);
		const url = new URL(body.authorizeUrl);
		expect(`${url.origin}${url.pathname}`).toBe(CF_AUTH_URL);
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('client_id')).toBe('abc123');
		expect(url.searchParams.get('redirect_uri')).toContain('/setup/cf/callback');
		// the verifier is in the object, never in the URL the browser follows
		const stored = await inObject(site, (obj) => obj.metaGet('cf_oauth_pending'));
		const verifier = JSON.parse(String(stored)).verifier as string;
		expect(verifier.length).toBeGreaterThan(20);
		expect(body.authorizeUrl).not.toContain(verifier);
	});

	it('remembers the client id, so a second connect needs no repaste', async () => {
		const site = freshSite();
		await call(site, 'action=connect&client_id=abc123');
		const res = await call(site, 'action=status');
		expect(((await res.json()) as { clientId: string }).clientId).toBe('abc123...');
	});

	/**
	 * THE CSRF THE STATE PARAMETER EXISTS FOR.
	 *
	 * An attacker who can make the operator's browser hit the callback with their own code would
	 * otherwise bind the operator's deployment to the attacker's Cloudflare account.
	 */
	it('rejects a callback whose state does not match the flow that was started', async () => {
		const site = freshSite();
		await call(site, 'action=connect&client_id=abc123');
		const res = await call(site, 'action=callback&code=stolen&state=wrong');
		expect(res.status).toBe(400);
		expect(String(((await res.json()) as { error: string }).error)).toContain('state');
	});

	it('rejects a callback when no flow is in progress at all', async () => {
		const res = await call(freshSite(), 'action=callback&code=c&state=s');
		expect(res.status).toBe(400);
	});

	/**
	 * A pending record is single-use, so a leaked `state` cannot be replayed.
	 *
	 * SINGLE-USE MEANS CONSUMED ON A MATCH, which is not what this used to assert. It consumed the
	 * record on EVERY callback, and the stated reason -- anti-replay -- does not need that: a replay
	 * presents the leaked state, so it matches, so it is consumed either way. What consuming on a
	 * MISMATCH added was a way for anyone to cancel an owner's connect mid-flight, on a route that
	 * is public and takes no credential, at one `cfw_meta` write per request.
	 */
	it('consumes the pending record when the state MATCHES, so a replay finds nothing', async () => {
		const site = freshSite();
		await call(site, 'action=connect&client_id=abc123');
		const stored = await inObject(site, (obj) => obj.metaGet('cf_oauth_pending'));
		const state = JSON.parse(String(stored)).state as string;
		// the exchange still fails -- there is no real code -- and the record is gone regardless
		await call(site, `action=callback&code=c&state=${encodeURIComponent(state)}`);
		const left = await inObject(site, (obj) => obj.metaGet('cf_oauth_pending'));
		expect(left === '' || left === null).toBe(true);
	});

	it('keeps it when the state does not, so a stranger cannot cancel a connect', async () => {
		const site = freshSite();
		await call(site, 'action=connect&client_id=abc123');
		await call(site, 'action=callback&code=c&state=wrong');
		const left = await inObject(site, (obj) => obj.metaGet('cf_oauth_pending'));
		expect(left).not.toBe('');
		expect(left).not.toBeNull();
	});

	it('reports a disconnect that could not revoke, rather than claiming success', async () => {
		const site = freshSite();
		const res = await call(site, 'action=disconnect');
		const body = (await res.json()) as { ok: boolean; revoked: boolean };
		expect(body.ok).toBe(true);
		// nothing was stored, so nothing was revoked; `ok` must not imply `revoked`
		expect(body.revoked).toBe(false);
	});
});

/**
 * The onboarding route.
 *
 * `mail-onboard.ts` has 30 unit tests over its algebra and one live run against `gmitch215.xyz`.
 * This is the third thing: that the object answers on the route at all.
 */
describe('the /__mailonboard route', () => {
	const onboard = (site: ReturnType<typeof freshSite>, query: string) =>
		inObject(site, (obj) =>
			obj.handle(
				new Request(`https://site.example/__mailonboard?${query}`),
				new URL(`https://site.example/__mailonboard?${query}`)
			)
		);

	it('refuses before an account is connected, rather than calling the API with an empty token', async () => {
		const res = await onboard(freshSite(), 'action=status');
		expect(res.status).toBe(400);
		expect(String(((await res.json()) as { error: string }).error)).toContain(
			'connect an account'
		);
	});
});
