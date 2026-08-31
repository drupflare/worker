import { describe, expect, it } from 'vitest';
import { freshSite, inObject, markProvisioned, type ServeDo } from '../helpers/serve-do';

/**
 * The generation fence, on the serving path, against a real object.
 *
 * `fenceAllows()` shipped with a unit spec and NO CALLER for its whole life, so the freshness
 * property was decoration: a replica behind the primary served its old view and looked healthy doing
 * it. A unit test cannot fail for that, which is why this drives `/__serve` and reads the status.
 *
 * Every case carries a control, because a 503 is also what a half-migrated site, a warming site and
 * a quarantined site answer -- and "the fence refused" and "something else refused" are the same
 * shape at the status line. The control is `x-cfw-cache: STALE`, which only the fence sets.
 */

const TIMEOUT = 120_000;

/** the object under test believes it is a replica; the binding is the only thing that decides */
function replicaEnv(site: ServeDo, on = true): void {
	(site.env as Record<string, unknown>).REPLICA_READ_ONLY = on ? '1' : '0';
}

async function serve(site: ServeDo, require?: string) {
	const headers: Record<string, string> = {};
	if (require !== undefined) headers['x-cfw-require-generation'] = require;
	const res = await site.fetch(
		new Request('https://do.local/__serve?path=/&lane=gate', { headers })
	);
	return {
		status: res.status,
		fenced: res.headers.get('x-cfw-cache') === 'STALE',
		applied: res.headers.get('x-cfw-applied-generation'),
		required: res.headers.get('x-cfw-required-generation')
	};
}

describe('a replica behind the required generation refuses to answer', () => {
	it(
		'refuses when it has not applied what the caller requires',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				replicaEnv(site);
				// the object is at commit 0; the caller needs 5
				return serve(site, '5');
			});

			expect(out.status).toBe(503);
			// THE CONTROL. A half-migrated or warming site also answers 503, and only the fence
			// stamps STALE, so without this the assertion passes for the wrong reason
			expect(out.fenced, 'a 503 that is not the fence').toBe(true);
			expect(out.required).toBe('5');
			expect(out.applied).toBe('0');
		},
		TIMEOUT
	);

	it(
		'answers when the caller states no requirement',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				replicaEnv(site);
				return serve(site);
			});
			// no header is not an unknown; it is a caller with no freshness requirement
			expect(out.fenced).toBe(false);
		},
		TIMEOUT
	);

	it(
		'refuses a requirement it cannot read, rather than treating it as absent',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				replicaEnv(site);
				return { garbage: await serve(site, 'not-a-number'), empty: await serve(site, '') };
			});
			expect(out.garbage.fenced, 'an unreadable requirement was waved through').toBe(true);
			expect(out.empty.fenced, 'an empty requirement was waved through').toBe(true);
		},
		TIMEOUT
	);

	it(
		'never fences a PRIMARY, however far ahead the caller asks for',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				replicaEnv(site, false);
				return serve(site, '999999');
			});
			// a primary is current by definition; fencing one would refuse the object that owns the
			// state, which is the failure mode that takes a site down rather than making it stale
			expect(out.fenced).toBe(false);
		},
		TIMEOUT
	);

	it(
		'answers once it has caught up, so the fence is not a permanent refusal',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				replicaEnv(site);
				const before = await serve(site, '3');
				// advance the commit sequence past what the caller needs
				for (let i = 0; i < 4; i++) site.advanceCommit();
				return { before, after: await serve(site, '3'), seq: site.commitSeq() };
			});

			expect(out.before.fenced).toBe(true);
			expect(out.seq).toBeGreaterThanOrEqual(3);
			expect(out.after.fenced, 'still fenced after catching up').toBe(false);
		},
		TIMEOUT
	);
});

describe('the stage is written, and only through a legal move', () => {
	async function stage(site: ServeDo, to: string) {
		const res = await site.fetch(
			new Request(`https://do.local/__replica?action=stage&to=${to}`, { method: 'GET' })
		);
		return {
			status: res.status,
			body: (await res.json()) as { stage: string; moved: boolean }
		};
	}

	it(
		'walks the machine forward one step at a time',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				const steps = [];
				for (const to of ['RESTORING', 'VERIFIED', 'CATCHING_UP', 'ELIGIBLE', 'SERVING']) {
					steps.push(await stage(site, to));
				}
				return { steps, final: site.replicaStage() };
			});

			for (const s of out.steps) expect(s.body.moved, JSON.stringify(s.body)).toBe(true);
			// the value is DURABLE, which is the half that was missing: it was read and never written
			expect(out.final).toBe('SERVING');
		},
		TIMEOUT
	);

	it(
		'refuses a skip and leaves the stage where it was',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				const skipped = await stage(site, 'ELIGIBLE');
				return { skipped, stage: site.replicaStage() };
			});

			expect(out.skipped.status).toBe(409);
			expect(out.skipped.body.moved).toBe(false);
			// a replica that skipped VERIFIED would serve state nothing checked
			expect(out.stage).toBe('CREATED');
		},
		TIMEOUT
	);

	it(
		'withdraws from anywhere and re-enters only at CREATED',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				await stage(site, 'RESTORING');
				const withdrawn = await stage(site, 'WITHDRAWN');
				const backToServing = await stage(site, 'SERVING');
				const backToCreated = await stage(site, 'CREATED');
				return { withdrawn, backToServing, backToCreated, stage: site.replicaStage() };
			});

			expect(out.withdrawn.body.moved).toBe(true);
			expect(out.backToServing.body.moved, 'a withdrawn replica re-entered at SERVING').toBe(
				false
			);
			expect(out.backToCreated.body.moved).toBe(true);
			expect(out.stage).toBe('CREATED');
		},
		TIMEOUT
	);
});
