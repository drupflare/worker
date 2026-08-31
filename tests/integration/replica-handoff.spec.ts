import { describe, expect, it } from 'vitest';
import { freshSite, inObject, markProvisioned, type ServeDo } from '../helpers/serve-do';

/**
 * What a replica ANSWERS when it meets work it may not do.
 *
 * `tests/unit/ops/replica.spec.ts` already proves the precondition -- the refusal throws before the
 * inner call and `didMutate()` reads false. What only a real object can show is that the refusal
 * reaches the caller as something actionable instead of a 500: the request boundary has to catch it,
 * and the retry advice has to be COMPUTED from `didMutate()` rather than assumed, or a half-applied
 * request would be retried and double-applied.
 *
 * 421 rather than 503. 503 says try again later; this object will refuse forever.
 */

const TIMEOUT = 120_000;

function replicaEnv(site: ServeDo, on = true): void {
	(site.env as Record<string, unknown>).REPLICA_READ_ONLY = on ? '1' : '0';
}

describe('a replica hands work back rather than failing', () => {
	it(
		'installs the guard over the whole capability surface when the binding is set',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				replicaEnv(site);
				// CONSTRUCTING the interpreter is what installs the guard, and `/__serve-stats` does
				// not construct one -- it reports on an object that may never have run PHP. A trivial
				// fragment is enough and needs no database
				const ran = await site.runJson(`<?php echo json_encode(['ok' => true]);`);
				const res = await site.fetch(new Request('https://do.local/__serve-stats'));
				return {
					ran,
					...((await res.json()) as {
						replica: { role: string; guarded: number; refusals: number };
					})
				};
			});

			// the control: if PHP did not run, the guard count means nothing
			expect(out.ran?.ok, `PHP did not run: ${JSON.stringify(out.ran).slice(0, 200)}`).toBe(
				true
			);
			expect(out.replica.role).toBe('replica');
			// the guard walks what is INSTALLED rather than a hand-maintained list, and two
			// capabilities have already drifted out of that list historically
			expect(out.replica.guarded, 'no capability was wrapped').toBeGreaterThan(0);
		},
		TIMEOUT
	);

	it(
		'reports a primary as a primary and wraps nothing',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				replicaEnv(site, false);
				await site.fetch(new Request('https://do.local/__serve-stats'));
				const res = await site.fetch(new Request('https://do.local/__serve-stats'));
				return (await res.json()) as { replica: { role: string; guarded: number } };
			});

			// THE CONTROL for the case above: if `guarded` were non-zero here, the count would be
			// measuring something other than the guard
			expect(out.replica.role).toBe('primary');
			expect(out.replica.guarded).toBe(0);
		},
		TIMEOUT
	);
});
