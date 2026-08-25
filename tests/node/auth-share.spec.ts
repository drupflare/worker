import { describe, expect, it } from 'vitest';
import {
	classify,
	methodBody,
	patternToRegExp,
	readAggregate,
	readRoutes,
	splitController,
	tally,
	tierOf,
	type AuthIndex,
	type RouteRow
} from '../../scripts/measure/auth-share.js';

/**
 * The classification, driven over a fixture. No real module is in this repo, so what is covered is the
 * transformation: route patterns, method-body extraction, the three tiers and the tally.
 */

const ROUTES = `
example_api.info:
  path: /v2/info
  defaults:
    _controller: '\\Drupal\\example_api\\Controller\\GeneralController::getInfo'
  methods: [GET]
example_api.user:
  path: '/v2/users/{id}'
  defaults:
    _controller: '\\Drupal\\example_api\\Controller\\UsersController::getUser'
  methods: [GET]
example_api.stage:
  path: '/v2/activities/staged'
  defaults:
    _controller: '\\Drupal\\example_api\\Controller\\StagingController::stage'
  methods: [POST]
`;

const CONTROLLERS = `<?php
class Fixture {
	public function getInfo(Request $request) {
		return new JsonResponse(['version' => 2]);
	}
	public function getUser(Request $request, string $id) {
		$requester = UsersHelper::getOwnerOfRequest($request);
		return new JsonResponse(UsersHelper::serializeUser($id, $requester));
	}
	public function stage(Request $request) {
		$user = UsersHelper::findByRequest($request);
		if ($user instanceof JsonResponse) { return $user; }
		return new JsonResponse([], 201);
	}
}
`;

function indexFrom(routes: RouteRow[]): AuthIndex {
	const tier = new Map<string, ReturnType<typeof tierOf>>();
	for (const route of routes) {
		const ref = splitController(route.controller);
		if (ref === null) continue;
		const body = methodBody(CONTROLLERS, ref.method);
		tier.set(`${ref.class}::${ref.method}`, body === null ? 'none' : tierOf(body));
	}
	return { tier, missing: [] };
}

describe('route table', () => {
	it('reads path, methods and controller off every entry', () => {
		const routes = readRoutes(ROUTES);
		expect(routes).toHaveLength(3);
		expect(routes[0]).toMatchObject({ path: '/v2/info', methods: ['GET'] });
		expect(routes[2].controller).toContain('StagingController::stage');
	});

	it('matches a placeholder against exactly one segment', () => {
		const re = patternToRegExp('/v2/users/{id}');
		expect(re.test('/v2/users/000000000000000000000002')).toBe(true);
		expect(re.test('/v2/users/000000000000000000000002/badges')).toBe(false);
		expect(re.test('/v2/users')).toBe(false);
	});

	it('tolerates a trailing slash, which the access log carries on some paths', () => {
		expect(patternToRegExp('/v2/info').test('/v2/info/')).toBe(true);
	});
});

describe('auth tiers', () => {
	// UsersController has 20 auth call sites, so a file-level grep marks /v2/users/login protected
	it('attributes a call to the method that makes it, not to the file', () => {
		expect(tierOf(methodBody(CONTROLLERS, 'getInfo') ?? '')).toBe('none');
		expect(tierOf(methodBody(CONTROLLERS, 'stage') ?? '')).toBe('required');
	});

	it('separates optional auth from required auth', () => {
		// it varies by user without ever answering 401, which a two-way split would lose
		expect(tierOf(methodBody(CONTROLLERS, 'getUser') ?? '')).toBe('optional');
	});

	it('returns null for a method the class does not declare', () => {
		expect(methodBody(CONTROLLERS, 'signupForEvent')).toBeNull();
	});
});

describe('classification', () => {
	const routes = readRoutes(ROUTES);
	const auth = indexFrom(routes);

	const row = (method: string, path: string, status = 200, count = 1, ua = '-') => ({
		count,
		file: 'access.log',
		method,
		path,
		status,
		ua
	});

	it('calls a token-required endpoint authenticated', () => {
		expect(classify(row('POST', '/v2/activities/staged', 201), routes, auth).verdict).toBe(
			'authenticated'
		);
	});

	it('calls an optionally-authenticated endpoint personalisable', () => {
		expect(classify(row('GET', '/v2/users/abc'), routes, auth).verdict).toBe('personalisable');
	});

	it('calls an endpoint that never reads the token anonymous', () => {
		expect(classify(row('GET', '/v2/info'), routes, auth).verdict).toBe('anonymous');
	});

	// a 401 is intent with no session: billed either way, but no user-varying render happens
	it('counts a 401 as anonymous however the route is tiered', () => {
		expect(classify(row('POST', '/v2/activities/staged', 401), routes, auth).verdict).toBe(
			'anonymous'
		);
	});

	it('does not match a path on a route that forbids the method', () => {
		expect(classify(row('POST', '/v2/info', 405), routes, auth).verdict).toBe('unrouted');
	});

	it('calls a path no route claims unrouted', () => {
		expect(classify(row('GET', '/.env', 403), routes, auth).verdict).toBe('unrouted');
	});
});

describe('tally', () => {
	const routes = readRoutes(ROUTES);
	const auth = indexFrom(routes);

	it('reports the required share and the may-vary share separately', () => {
		const rows = readAggregate(
			[
				'  10 access.log|POST|/v2/activities/staged|201|-',
				'  30 access.log|GET|/v2/users/abc|200|-',
				'  60 access.log|GET|/v2/info|200|@earth-app/telescope',
				'   5 access.log|GET|/.env|403|-'
			].join('\n')
		);
		const t = tally(rows, routes, auth);
		expect(t).toMatchObject({
			authenticated: 10,
			personalisable: 30,
			anonymous: 60,
			unrouted: 5
		});
		expect(t.share).toBeCloseTo(0.1, 5);
		expect(t.varyingShare).toBeCloseTo(0.4, 5);
	});

	it('keeps unrouted noise out of both denominators', () => {
		const rows = readAggregate('  99 access.log|GET|/wp-login.php|404|-');
		expect(tally(rows, routes, auth)).toMatchObject({ total: 0, share: 0, varyingShare: 0 });
	});

	it('parses a count-prefixed aggregate line with a pipe in the user agent', () => {
		const [row] = readAggregate('   3 access.log|GET|/v2/info|200|curl|7.0');
		expect(row).toMatchObject({ count: 3, method: 'GET', status: 200, ua: 'curl|7.0' });
	});
});
