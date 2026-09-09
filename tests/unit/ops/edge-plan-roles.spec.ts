import { beforeEach, describe, expect, it } from 'vitest';
import {
	ROLE_TRUST_MS,
	believedRoles,
	edgePlanKey,
	lookupEdgePlan,
	noteEdgeRender,
	rememberRoles,
	resetEdgePlans,
	roleFingerprint,
	runEdgePlan
} from '../../../src/ops/edge-plan';
import type { RenderPlan } from '../../../src/ops/render-plan';

/**
 * Keying a plan on the role set instead of the cookie, and the two proofs that make it safe.
 *
 * The cookie key was structurally airtight and held one plan per session per path: 200 logged-in
 * users over 50 authenticated paths reached 10,000 keys where `role_sets x 50` is about 150, and
 * every first use of a key was a cold KV read at 46-140 ms against 4-5 warm. What replaces it is a
 * compile across two DIFFERENT sessions plus a per-session agreement before any of them is served.
 */

const SITE = 'example.test';
const PATH = '/admin/content';
const ROLES = 'authenticated,editor';
const ALICE = 'SSESS0123456789abcdef0123456789ab=alice';
const BOB = 'SSESS0123456789abcdef0123456789ab=bob';
const CAROL = 'SSESS0123456789abcdef0123456789ab=carol';

/** the same page for everyone in the role set */
const shared = (n = 1) => `<html><body><h1>Content</h1><p>page ${n}</p></body></html>`;

/** the same page with the visitor's own name in it, which is what must never be shared */
const personal = (who: string) => `<html><body><h1>Content</h1><p>Hello ${who}</p></body></html>`;

describe('the role set is the key', () => {
	beforeEach(() => resetEdgePlans());

	it('joins a sorted role set and refuses an empty one', () => {
		expect(roleFingerprint(['authenticated', 'editor'])).toBe('authenticated,editor');
		expect(roleFingerprint([])).toBe('');
		expect(roleFingerprint(null)).toBe('');
		expect(roleFingerprint(undefined)).toBe('');
	});

	it('gives two sessions of one role set the same key and two role sets different keys', () => {
		const a = edgePlanKey(SITE, 1, 'authenticated,editor', PATH);
		const b = edgePlanKey(SITE, 1, 'authenticated,editor', PATH);
		const c = edgePlanKey(SITE, 1, 'authenticated', PATH);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	it('keeps the generation in the key, so an invalidation drops every plan at once', () => {
		expect(edgePlanKey(SITE, 1, ROLES, PATH)).not.toBe(edgePlanKey(SITE, 2, ROLES, PATH));
	});

	it('only knows a role set the object reported, and forgets it on a clock', () => {
		const at = 1_000_000;
		expect(believedRoles(ALICE, at)).toBeNull();
		rememberRoles(ALICE, ROLES, at);
		expect(believedRoles(ALICE, at + ROLE_TRUST_MS - 1)).toBe(ROLES);
		expect(believedRoles(ALICE, at + ROLE_TRUST_MS)).toBeNull();
	});

	it('records nothing for a session with no reported role set', () => {
		// an empty value is "the object did not say", not a role set of its own
		rememberRoles(ALICE, '', 1_000_000);
		expect(believedRoles(ALICE, 1_000_000)).toBeNull();
	});
});

describe('a plan is compiled only across two different sessions', () => {
	beforeEach(() => resetEdgePlans());

	it('waits rather than compiling from one session alone', () => {
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		// three renders, all Alice: enough samples and not enough witnesses
		expect(noteEdgeRender(key, PATH, shared(0), 1000, ALICE)).toBeNull();
		expect(noteEdgeRender(key, PATH, shared(1), 1000, ALICE)).toBeNull();
		expect(noteEdgeRender(key, PATH, shared(1), 1000, ALICE)).toBeNull();
		expect(lookupEdgePlan(key, 1000)).toBeNull();
	});

	it('completes on the next session rather than starting over', () => {
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		noteEdgeRender(key, PATH, shared(0), 1000, ALICE);
		noteEdgeRender(key, PATH, shared(1), 1000, ALICE);
		noteEdgeRender(key, PATH, shared(1), 1000, ALICE);
		// Bob's first render is the second witness, and it is the one that completes the pair
		const plan = noteEdgeRender(key, PATH, shared(1), 1000, BOB);
		expect(plan).not.toBeNull();
		expect(runEdgePlan(plan as RenderPlan)).toBe(shared(1));
	});

	/**
	 * THE PROPERTY THE COOKIE KEY USED TO GIVE FOR FREE.
	 *
	 * Compiled from one session's two renders, a region that is constant for that user and different
	 * for another is a CONSTANT in the plan and would be served to everyone in the role set. Across
	 * two sessions the same region varies, the compiler names it an unknown slot, and
	 * `unservableSlots()` refuses the plan outright.
	 */
	it('refuses a plan whose pages differ between the two sessions', () => {
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		noteEdgeRender(key, PATH, personal('Alice'), 1000, ALICE);
		noteEdgeRender(key, PATH, personal('Alice'), 1000, ALICE);
		expect(noteEdgeRender(key, PATH, personal('Bob'), 1000, BOB)).toBeNull();
		expect(lookupEdgePlan(key, 1000)).toBeNull();
	});

	it('never compiles from a render with no witness at all', () => {
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		noteEdgeRender(key, PATH, shared(0), 1000);
		noteEdgeRender(key, PATH, shared(1), 1000);
		expect(noteEdgeRender(key, PATH, shared(1), 1000)).toBeNull();
		expect(lookupEdgePlan(key, 1000)).toBeNull();
	});
});

describe('and served only to a session that has agreed with it', () => {
	beforeEach(() => resetEdgePlans());

	const compiled = (key: string) => {
		noteEdgeRender(key, PATH, shared(0), 1000, ALICE);
		noteEdgeRender(key, PATH, shared(1), 1000, ALICE);
		return noteEdgeRender(key, PATH, shared(1), 1000, BOB);
	};

	it('serves the two sessions that produced it, which agreed by construction', () => {
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		expect(compiled(key)).not.toBeNull();
		expect(lookupEdgePlan(key, 1000, ALICE)).not.toBeNull();
		expect(lookupEdgePlan(key, 1000, BOB)).not.toBeNull();
	});

	/**
	 * A third session is exactly what the two-session proof cannot see.
	 *
	 * This is the same reasoning `verifyShellFor()` applies in the shell tier: a harvest agreed
	 * between two people says nothing about a third whose shared region differs -- an unread count,
	 * a per-user block core did not placeholder.
	 */
	it('refuses a session that has never rendered this page', () => {
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		compiled(key);
		expect(lookupEdgePlan(key, 1000, CAROL)).toBeNull();
	});

	it('serves that session once its own render has agreed', () => {
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		compiled(key);
		expect(noteEdgeRender(key, PATH, shared(1), 1000, CAROL)).toBeNull();
		expect(lookupEdgePlan(key, 1000, CAROL)).not.toBeNull();
	});

	it('drops the plan for EVERYONE when a session disagrees', () => {
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		compiled(key);
		// Carol's page differs, which is evidence the shared region is not shared
		noteEdgeRender(key, PATH, personal('Carol'), 1000, CAROL);
		expect(lookupEdgePlan(key, 1000, CAROL)).toBeNull();
		expect(lookupEdgePlan(key, 1000, ALICE)).toBeNull();
		expect(lookupEdgePlan(key, 1000)).toBeNull();
	});
});
