import { describe, expect, it } from 'vitest';
import { CACHE_TIERS } from '../../src/ops/cache-tiers.js';
import { ENDPOINT, SITE, e2eGate, serve } from './helpers/endpoint';

/**
 * The serving chain against a REAL running worker and a REAL interpreter.
 *
 * What makes this lane worth having, when `tests/integration/` already drives a real Durable
 * Object: nothing in the other lanes ever executes PHP. `runInDurableObject` gives a real
 * `ctx.storage.sql`, but the render is stubbed, so an assertion about what Drupal actually
 * emitted cannot exist there.
 *
 * These are the checks that need the whole stack standing up, and each one corresponds to a
 * failure this project has actually shipped:
 *
 *   - a 200 response with a ZERO-BYTE body. This happened. It is the reason the health design
 *     says "quarantine beats wrong output": a 503 with Retry-After is a better answer than an
 *     empty 200, because an empty 200 is indistinguishable from a real page to a cache.
 *   - a render with no cache-tier header, so which tier served it is unknowable after the fact.
 *   - a second request that renders again instead of hitting the cache it just filled.
 *
 * Run it with `bun run test:e2e` after `bun run dev`. It SKIPS when no worker is reachable,
 * except under CI where the gate throws -- see `helpers/endpoint.ts` for why.
 */

const skip = await e2eGate();

describe.skipIf(skip)(`the serving chain at ${ENDPOINT}`, () => {
	it('answers the diagnostic route with JSON, which proves the site exists', async () => {
		const res = await fetch(`${ENDPOINT}/stats?site=${SITE}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toBeTypeOf('object');
	});

	it('never returns a 200 with an empty body', async () => {
		const res = await serve('/');
		// a 503 is a legitimate answer here: it is what a not-yet-migrated or still-filling site
		// says, and the point of this assertion is the COMBINATION of ok and empty
		if (res.status === 200) {
			const text = await res.text();
			expect(text.length).toBeGreaterThan(0);
			// this is the shipped defect being pinned: 0 bytes with a success status
			expect(text.trim()).not.toBe('');
		} else {
			expect([202, 404, 503]).toContain(res.status);
		}
	});

	it('names the cache tier that served the response', async () => {
		const res = await serve('/');
		if (res.status !== 200) return;
		const tier = res.headers.get('x-cfw-cache');
		expect(tier).not.toBeNull();
		// imported rather than written out: the hand-written list named three tiers the source
		// does not emit and omitted three it does, and `tests/node/cache-tiers.spec.ts` holds
		// the const to what `src/` actually sets
		expect(CACHE_TIERS as readonly string[]).toContain(String(tier).toUpperCase());
	});

	it('reports the generation, so an invalidation is observable from outside', async () => {
		const res = await serve('/');
		if (res.status !== 200) return;
		const gen = res.headers.get('x-cfw-generation');
		expect(gen).not.toBeNull();
		expect(Number.isFinite(Number(gen))).toBe(true);
	});

	it('serves HTML that closes its own document', async () => {
		const res = await serve('/');
		if (res.status !== 200) return;
		const text = await res.text();
		// a truncated render is the other half of the empty-body failure: a body that starts
		// correctly and stops mid-document still looks like a success to a cache
		expect(text).toContain('<html');
		expect(text).toContain('</html>');
	});

	it('serves the second request from cache rather than rendering again', async () => {
		const first = await serve('/');
		if (first.status !== 200) return;
		const second = await serve('/');
		expect(second.status).toBe(200);
		const tier = String(second.headers.get('x-cfw-cache') ?? '').toUpperCase();
		// whichever tier answers, it must not be the one that means "rendered from scratch"
		expect(tier).not.toBe('MISS');
	});
});

describe.skipIf(skip)('the gate itself', () => {
	it('is only running because a worker answered', async () => {
		// guards against the inverse failure: a suite that passes because every assertion was
		// skipped. If this body runs at all, the gate resolved to "reachable"
		expect(skip).toBe(false);
	});
});
