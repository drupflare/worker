import { describe, expect, it } from 'vitest';
import {
	compilePlan,
	fillSlots,
	generatorAgrees,
	htmlId,
	planExplainsBoth,
	planRoundTrips,
	randomBuildToken,
	runPlan,
	sessionCsrf,
	unknownContext,
	unservableSlots
} from '../../../src/ops/render-plan.js';
import { cacheTagsIn } from '../../../src/site-do.js';

/**
 * The compiled render plan, its slot classifier and its VM.
 *
 * Two load-bearing properties. The round trip: a plan filled with what the compiler saw has to
 * reproduce the render it was compiled from, byte for byte. And the refusal: a slot the worker
 * has no generator for must stop the whole plan rather than be filled with something the right
 * shape. Everything else here exists so neither can pass for the wrong reason -- a compiler
 * that emitted one constant op and no slot would round-trip perfectly and serve a stale
 * `form_build_id` to every visitor.
 */

const A = '<html><body><form><input value="AAAA"></form></body></html>';
const B = '<html><body><form><input value="BBBB"></form></body></html>';

/** the real shape: one build id, twice, the first through `Html::getId()` for the DOM id */
const form = (token: string) =>
	`<html><body><form><input id="${htmlId('form-' + token)}" type="hidden" ` +
	`name="form_build_id" value="form-${token}"></form></body></html>`;

/**
 * The session CSRF token, and the reason a shared role-set plan could not compile an authenticated
 * page.
 *
 * MEASURED on a running site: two sessions of one role set rendering `/` produced 103,697 bytes
 * each and differed in exactly this value, twice, with every `data-contextual-token` identical. With
 * no slot kind for it the compiler named an unnameable region and refused, permanently.
 *
 * It is the one slot that is SUBSTITUTED rather than generated: the value belongs to the visitor
 * being served, so a plan holding one refuses to run without a token for them.
 */
describe('the session csrf token', () => {
	const TOKEN_A = 'ZfJiP3WwMX-B22o3NT9JKZkM6zbM-qFG9xx39L1J5H4';
	const TOKEN_B = 'PsDMvoK05id0cuc2HyG_05lsLP4DcRPnvBQ6yIqrZVM';
	/**
	 * The two places it lands: the toolbar button and the account menu, as core renders them.
	 *
	 * The filler carries NEWLINES because that is what the real page has and what `splitSpan()`
	 * anchors on. Bracketed between two occurrences with no line to align on, the whole span stays
	 * one opaque region -- which is the shape the first version of this fixture had, and it failed.
	 */
	const filler = (c: string) =>
		Array.from({ length: 8 }, (_, i) => `<div>${c.repeat(40)}${i}</div>`).join('\n');
	const page = (token: string) =>
		`<html>\n<body>\n${filler('x')}\n<a href="/user/logout?token=${token}" class="toolbar-button">` +
		`Log out</a>\n${filler('y')}\n<a href="/user/logout?token=${token}">Log out</a>\n</body>\n</html>`;

	it('names both occurrences and survives every proof', () => {
		const plan = compilePlan(page(TOKEN_A), page(TOKEN_B), '/');
		expect(Object.values(plan.slots).map((s) => s.kind)).toEqual(['csrf', 'csrf']);
		expect(unservableSlots(plan)).toEqual([]);
		expect(planExplainsBoth(plan, page(TOKEN_A), page(TOKEN_B))).toBe(true);
		expect(generatorAgrees(plan)).toBe(true);
	});

	it('gives each visitor their own token, which is the whole point of the slot', () => {
		const plan = compilePlan(page(TOKEN_A), page(TOKEN_B), '/');
		for (const token of [TOKEN_A, TOKEN_B, randomBuildToken()]) {
			const values = fillSlots(plan, { csrf: token });
			expect(values).not.toBeNull();
			expect(runPlan(plan, values as Record<string, string>)).toBe(page(token));
		}
	});

	it('refuses to run without one rather than inventing a token Drupal would reject', () => {
		const plan = compilePlan(page(TOKEN_A), page(TOKEN_B), '/');
		expect(fillSlots(plan)).toBeNull();
		expect(fillSlots(plan, { csrf: null })).toBeNull();
		expect(fillSlots(plan, { csrf: 'too-short' })).toBeNull();
	});

	it('reads the token out of a render, which is the only place it may come from', () => {
		expect(sessionCsrf(page(TOKEN_A))).toBe(TOKEN_A);
		expect(sessionCsrf('<html><body>no session here</body></html>')).toBeNull();
	});

	it('leaves a base64url run with no logout marker opaque', () => {
		// the marker is what separates a token from any other pair of differing base64url runs; a
		// value filled from the wrong place would be the right shape and the wrong bytes
		const other = (token: string) => `<html>${'x'.repeat(300)}<meta content="${token}">`;
		const plan = compilePlan(other(TOKEN_A), other(TOKEN_B), '/');
		expect(unservableSlots(plan)).toHaveLength(1);
	});

	it('stays a constant when both renders are the same session', () => {
		// which is what makes a private plan work: one session's token is not a varying value
		const plan = compilePlan(page(TOKEN_A), page(TOKEN_A), '/');
		expect(plan.slots).toEqual({});
		expect(runPlan(plan, {})).toBe(page(TOKEN_A));
	});
});

describe('compilePlan finds the varying bytes by diffing two renders', () => {
	it('emits constant, slot, constant and round-trips its own input', () => {
		const plan = compilePlan(A, B, '/p');
		expect(plan.ops.map((o) => o[0])).toEqual(['t', 's', 't']);
		expect(plan.sample).toEqual({ slot0: 'AAAA' });
		expect(planRoundTrips(plan, A)).toBe(true);
		expect(runPlan(plan, { slot0: 'CCCC' })).toBe(A.replace('AAAA', 'CCCC'));
	});

	it('emits no slot when the two renders are identical', () => {
		const plan = compilePlan(A, A, '/p');
		expect(plan.ops).toEqual([['t', A]]);
		expect(plan.slots).toEqual({});
		expect(planRoundTrips(plan, A)).toBe(true);
	});

	it('does not swallow the varying span into a constant', () => {
		// the failure that would make every other assertion here pass for the wrong reason
		const plan = compilePlan(A, B, '/p');
		expect(plan.ops.some((o) => o[0] === 't' && o[1].includes('AAAA'))).toBe(false);
	});

	it('splits one span carrying two varying runs into two slots', () => {
		const a = randomBuildToken();
		const b = randomBuildToken();
		const plan = compilePlan(form(a), form(b), '/user/login');
		expect(planExplainsBoth(plan, form(a), form(b))).toBe(true);
		expect(Object.keys(plan.slots)).toEqual(['slot0', 'slot1']);
		expect(plan.sample.slot1).toBe(a);
		expect(planRoundTrips(plan, form(a))).toBe(true);
	});

	it('chunking changes the op count and nothing else', () => {
		const plain = compilePlan(A, B, '/p');
		const chunked = compilePlan(A, B, '/p', 8);
		expect(chunked.ops.length).toBeGreaterThan(plain.ops.length);
		expect(planRoundTrips(chunked, A)).toBe(true);
		expect(runPlan(chunked, plain.sample)).toBe(runPlan(plain, plain.sample));
	});
});

describe('a slot with no generator refuses the whole plan', () => {
	it('classifies the form_build_id pair and produces one token for both', () => {
		const plan = compilePlan(form(randomBuildToken()), form(randomBuildToken()), '/user/login');
		expect(plan.slots.slot0!.kind).toBe('build_id');
		expect(plan.slots.slot1).toEqual({ kind: 'build_id', role: 'raw' });
		expect(unservableSlots(plan)).toEqual([]);

		const values = fillSlots(plan)!;
		expect(htmlId('form-' + values.slot1!)).toMatch(new RegExp(`${values.slot0}$`));
		expect(values.slot1).toMatch(/^[A-Za-z0-9_-]{43}$/);
		// a fresh token per request, or every visitor shares one build id
		expect(fillSlots(plan)!.slot1).not.toBe(values.slot1);
	});

	it('refuses a plan whose varying bytes it does not recognise', () => {
		const plan = compilePlan(A, B, '/p');
		expect(plan.slots.slot0).toEqual({ kind: 'unknown', bytes: 4 });
		expect(unservableSlots(plan)).toEqual(['slot0']);
		expect(fillSlots(plan)).toBeNull();
	});

	it('refuses when the two renders differ in length inside the span', () => {
		// the runs cannot line up, so the span stays opaque rather than being split at a guess
		const plan = compilePlan('<p>abc</p>', '<p>abcdef</p>', '/p');
		expect(unservableSlots(plan).length).toBe(1);
		expect(fillSlots(plan)).toBeNull();
	});

	it('refuses a base64url pair that is not a form_build_id', () => {
		const t = randomBuildToken();
		const u = randomBuildToken();
		const shape = (x: string) => `<i>${x.toLowerCase()}</i><b>${x}</b>`;
		expect(fillSlots(compilePlan(shape(t), shape(u), '/p'))).toBeNull();
	});
});

describe('the common suffix can eat the end of the token', () => {
	it('recognises a pair whose tokens share their last characters', () => {
		// two base64url tokens share a last character about one time in 64, and the suffix walk
		// does not know it has crossed into a varying value. Constructed rather than sampled: a
		// random pair reproduces this ~1.6% of the time, which is a flake and not a test
		const a = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaXYZ';
		const b = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbXYZ';
		const plan = compilePlan(form(a + 'Q'), form(b + 'Q'), '/user/login');
		expect(unservableSlots(plan)).toEqual([]);
		expect(planExplainsBoth(plan, form(a + 'Q'), form(b + 'Q'))).toBe(true);
		expect(plan.sample.slot1).toBe(a + 'Q');
	});
});

describe('the generator is checked, not just the recorded samples', () => {
	it('agrees on a real form pair', () => {
		const plan = compilePlan(form(randomBuildToken()), form(randomBuildToken()), '/user/login');
		expect(generatorAgrees(plan)).toBe(true);
	});

	it('agrees on a plan with no slots, which has no generator to disagree with', () => {
		expect(generatorAgrees(compilePlan(A, A, '/p'))).toBe(true);
	});

	it('refuses a plan it cannot fill at all', () => {
		expect(generatorAgrees(compilePlan(A, B, '/p'))).toBe(false);
	});

	it('catches a generator that emits the right length and the wrong bytes', () => {
		// the slot owns the whole id, so a non-zero head drops its first characters and the served
		// page carries a truncated one; both `planRoundTrips` and `planExplainsBoth` read true
		// throughout, which is why neither of them is the check
		const plan = compilePlan(form(randomBuildToken()), form(randomBuildToken()), '/user/login');
		expect(planRoundTrips(plan, runPlan(plan, plan.sample))).toBe(true);
		const truncated = {
			...plan,
			slots: { ...plan.slots, slot0: { kind: 'build_id', role: 'id', head: 6 } as const }
		};
		expect(generatorAgrees(truncated)).toBe(false);
	});

	it('gives the slot the whole value rather than leaving its head in the constants', () => {
		// two ids sharing a leading character put that character in the constant in front, and a
		// fresh id need not start with it -- the page then served a head from one render spliced
		// onto a tail from the generator, and every check but this one passed
		const a = viewPage('a' + hex('111').slice(1), randomBuildToken());
		const b = viewPage('a' + hex('222').slice(1), randomBuildToken());
		const plan = compilePlan(a, b, '/admin/content');
		const [name, slot] = Object.entries(plan.slots).find(([, s]) => s.kind === 'view_dom_id')!;
		expect(slot).toEqual({ kind: 'view_dom_id', head: 0 });
		expect(plan.sample[name]).toHaveLength(64);
		expect(planExplainsBoth(plan, a, b)).toBe(true);
		// and the served id is one value, not a head from the render spliced onto a fresh tail
		const html = runPlan(plan, fillSlots(plan)!);
		const id = /js-view-dom-id-([0-9a-f]{64})"/.exec(html)?.[1];
		expect(id).toBeTruthy();
		expect(id).not.toBe(plan.sample[name]);
		expect(id).not.toBe(plan.sampleB[name]);
	});
});

describe('htmlId is Drupal Html::getId, not toLowerCase', () => {
	it('turns underscores into hyphens and collapses runs of them', () => {
		// the transform that made the first recogniser refuse every real page
		expect(htmlId('form-A_B')).toBe('form-a-b');
		expect(htmlId('form-A__B')).toBe('form-a-b');
		expect(htmlId('form-A-_B')).toBe('form-a-b');
		expect(htmlId('form-AbC')).toBe('form-abc');
	});

	it('produces an id shorter than the token when hyphens collapse', () => {
		const token = 'a_-b'.padEnd(43, 'c');
		expect(htmlId('form-' + token).length).toBeLessThan(('form-' + token).length);
	});

	it('a plan built on a token carrying underscores still explains both renders', () => {
		const a = 'a_b-c'.padEnd(43, 'd');
		const b = 'e__f-'.padEnd(43, 'g');
		const plan = compilePlan(form(a), form(b), '/user/login');
		expect(planExplainsBoth(plan, form(a), form(b))).toBe(true);
		expect(fillSlots(plan)).not.toBeNull();
	});
});

describe('randomBuildToken matches what Crypt::randomBytesBase64 produces', () => {
	it('is 43 base64url characters with no padding', () => {
		for (let i = 0; i < 50; i++) {
			expect(randomBuildToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
		}
	});

	it('does not repeat', () => {
		const seen = new Set(Array.from({ length: 200 }, () => randomBuildToken()));
		expect(seen.size).toBe(200);
	});
});

describe('cacheTagsIn reads the tag out of a cachetags merge', () => {
	it('keeps tag-shaped strings and drops everything else', () => {
		// `Connection::merge('cachetags')` binds the tag, so it is never in the SQL text
		expect(cacheTagsIn(['node:1'])).toEqual(['node:1']);
		expect(cacheTagsIn(['config:system.site', 'rendered'])).toEqual([
			'config:system.site',
			'rendered'
		]);
		expect(cacheTagsIn([1, null, true])).toEqual([]);
		expect(cacheTagsIn(['a b'])).toEqual([]);
		expect(cacheTagsIn(['x'.repeat(41)])).toEqual([]);
	});

	it('accepts a bare parameter and a missing one', () => {
		expect(cacheTagsIn('node:7')).toEqual(['node:7']);
		expect(cacheTagsIn(undefined)).toEqual([]);
	});

	/**
	 * A NAMED BINDING MAP, which is the shape every invalidation after a tag's first arrives in.
	 *
	 * `Connection::merge('cachetags')` SELECTs, then INSERTs when the row is absent and UPDATEs when
	 * it is there. The insert binds positionally and the update binds
	 * `:db_condition_placeholder_0`, so reading arrays only sees a tag's first invalidation ever and
	 * silently drops every later one. Measured on a real site: `config:system.menu.main` went 3 -> 4
	 * -> 5 -> 6 across three menu-item saves while `pendingTags()` recorded nothing, so no page
	 * carrying that tag was purged; a node save moved `node_list` the same way and left the front
	 * page listing stale.
	 */
	it('reads a named binding map, not only a positional list', () => {
		expect(cacheTagsIn({ ':db_condition_placeholder_0': 'config:system.menu.main' })).toEqual([
			'config:system.menu.main'
		]);
		expect(
			cacheTagsIn({
				':db_update_placeholder_0': 'node_list',
				':db_condition_placeholder_1': 'node_list'
			})
		).toEqual(['node_list', 'node_list']);
		// and the same filtering, so a named map cannot smuggle a non-tag through
		expect(cacheTagsIn({ ':db_insert_placeholder_0': 1 })).toEqual([]);
		expect(cacheTagsIn({ ':a': 'has a space' })).toEqual([]);
	});

	it('stays inside the LIKE pattern limit the platform enforces', () => {
		for (const t of cacheTagsIn(['config:system.site', 'node:12345'])) {
			expect(`%"${t}"%`.length).toBeLessThanOrEqual(50);
		}
	});
});

/**
 * A page with a view and a form is the general case, and bracketing gives it ONE opaque region:
 * everything between the dom id near the top and the build id near the bottom, several kilobytes
 * of markup that neither recogniser can name. The split at shared lines is what turns that into
 * one region per value.
 */
const MIDDLE =
	'\n<div class="view-filters">a long constant markup line that both renders share</div>\n' +
	'<table class="views-table cols-7 responsive-enabled position-sticky sticky-header">\n' +
	'<tbody><tr><td colspan="7">No content available.</td></tr></tbody></table>\n';

const viewPage = (dom: string, token: string) =>
	`<html><body><div class="view view-id-content js-view-dom-id-${dom}">` +
	MIDDLE +
	`<input id="${htmlId('form-' + token)}" type="hidden" name="form_build_id" ` +
	`value="form-${token}"></div></body></html>`;

const hex = (seed: string) => (seed + '0'.repeat(64)).slice(0, 64);

describe('a page carrying two dynamic values compiles to two regions, not one', () => {
	it('names the view dom id and the build id separately', () => {
		const a = viewPage(hex('a1b2c3'), randomBuildToken());
		const b = viewPage(hex('d4e5f6'), randomBuildToken());
		const plan = compilePlan(a, b, '/admin/content');

		expect(unservableSlots(plan)).toEqual([]);
		expect(
			Object.values(plan.slots)
				.map((s) => s.kind)
				.sort()
		).toEqual(['build_id', 'build_id', 'view_dom_id']);
		expect(planExplainsBoth(plan, a, b)).toBe(true);
		expect(generatorAgrees(plan)).toBe(true);
	});

	it('keeps the markup between the two values as a constant', () => {
		const a = viewPage(hex('a1b2c3'), randomBuildToken());
		const b = viewPage(hex('d4e5f6'), randomBuildToken());
		const plan = compilePlan(a, b, '/admin/content');
		// without the split this markup is inside an opaque slot
		expect(plan.ops.some((o) => o[0] === 't' && o[1].includes('views-table'))).toBe(true);
	});

	it('reclaims a hex character the bracket took off either end of the id', () => {
		// two ids sharing their first AND last character, which is what made the region 62 bytes
		// long and the naive "all the missing characters are at the front" reading reject it
		const a = viewPage('a' + hex('111').slice(0, 62) + 'f', randomBuildToken());
		const b = viewPage('a' + hex('222').slice(0, 62) + 'f', randomBuildToken());
		const plan = compilePlan(a, b, '/admin/content');
		expect(unservableSlots(plan)).toEqual([]);
		const [name, dom] = Object.entries(plan.slots).find(([, s]) => s.kind === 'view_dom_id')!;
		expect(dom).toEqual({ kind: 'view_dom_id', head: 0 });
		expect(plan.sample[name]).toBe('a' + hex('111').slice(0, 62) + 'f');
		expect(planExplainsBoth(plan, a, b)).toBe(true);
	});

	it('generates a fresh 64-hex id that no render contained', () => {
		const a = viewPage(hex('a1b2c3'), randomBuildToken());
		const b = viewPage(hex('d4e5f6'), randomBuildToken());
		const plan = compilePlan(a, b, '/admin/content');
		const html = runPlan(plan, fillSlots(plan)!);
		const found = /js-view-dom-id-([0-9a-f]{64})/.exec(html)?.[1];
		expect(found).toBeTruthy();
		expect(found).not.toBe(hex('a1b2c3'));
		expect(found).not.toBe(hex('d4e5f6'));
	});

	it('refuses a differing hex run that no view marker precedes', () => {
		// the guard that stops the recogniser naming any pair of hex strings; without it a
		// checksum, a cache key or an id it has never seen is filled with a random value
		const page = (v: string) => `<html><body><span data-hash="${v}">x</span></body></html>`;
		const plan = compilePlan(page(hex('a1b2c3')), page(hex('d4e5f6')), '/p');
		expect(unservableSlots(plan).length).toBe(1);
		expect(fillSlots(plan)).toBeNull();
	});

	it('reports the markup either side of a refusal, and nothing for a named slot', () => {
		const page = (v: string) => `<html><body><span data-hash="${v}">x</span></body></html>`;
		const plan = compilePlan(page(hex('a1b2c3')), page(hex('d4e5f6')), '/p');
		const name = unservableSlots(plan)[0]!;
		const context = unknownContext(plan);
		expect(Object.keys(context)).toEqual([name]);
		expect(context[name]!.before).toContain('data-hash="');
		expect(context[name]!.after).toContain('</span>');
		// a plan whose every slot is named has no refusal to describe
		const named = compilePlan(form(randomBuildToken()), form(randomBuildToken()), '/f');
		expect(unservableSlots(named)).toEqual([]);
		expect(unknownContext(named)).toEqual({});
	});
});
