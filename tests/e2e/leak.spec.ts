import { beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINT, e2eGate } from './helpers/endpoint.js';
import {
	migrate,
	newSiteName,
	prefill,
	provision,
	transportFor,
	type Transport
} from './helpers/lifecycle.js';
import { saveNode, serveAs, sessionCookie, type IdentityShot } from './helpers/operate.js';

/**
 * The identity leak differential: does one identity's content ever reach another's response?
 *
 * **The highest-severity finding available in this project, and it has happened.** The uid-1
 * poisoning is recorded in `saveNode()`'s own docblock in `src/drupal/site-php.ts`: an unrestored
 * `\Drupal::currentUser()` made the alarm chain render `/` as uid 1, the front page went from 12,296
 * to 90,038 bytes, and that ADMIN HTML was stored in the anonymous page cache and served to
 * visitors. One unrestored global.
 *
 * The method is a differential rather than a single check. An interleaved sequence -- anonymous, A,
 * B, admin, anonymous again -- is compared against the SAME sequence run in a fresh object, where
 * no cross-contamination is possible by construction. A response that differs between the two runs
 * changed because of what preceded it, which is the definition of the bug.
 *
 * **WHAT THIS CAN AND CANNOT ESTABLISH, stated up front so a green run is not over-read.** The
 * cookies here satisfy `SESSION_COOKIE_RE` in `src/ops/auth-budget.ts`, so the WORKER classifies
 * these requests as authenticated: the budget is charged, `x-cfw-auth-mode` is set, and the
 * personalised branch is taken. They are not real Drupal session records, so Drupal itself renders
 * every one of them as anonymous. Therefore:
 *
 *   - a leak in the HOST's identity plumbing -- the tier that decides what may be stored in
 *     `cfw_page` and served to everyone -- IS in scope, and that is where the uid-1 bug lived;
 *   - a leak in Drupal's own per-user rendering is NOT in scope and this file must not be cited as
 *     evidence about it.
 *
 * A green run here means the host tier did not mix identities. It does not mean logged-in Drupal is
 * safe, and proving that needs real session records.
 */

const skip = await e2eGate();

/** the interleaving; `anon` appears twice on purpose, before and after the privileged identities */
const SEQUENCE = [
	{ identity: 'anon-before', cookie: null },
	{ identity: 'user-a', cookie: sessionCookie('a') },
	{ identity: 'user-b', cookie: sessionCookie('b') },
	{ identity: 'admin', cookie: sessionCookie('admin') },
	{ identity: 'anon-after', cookie: null }
] as const;

async function runSequence(t: Transport, path: string): Promise<IdentityShot[]> {
	const out: IdentityShot[] = [];
	for (const step of SEQUENCE) {
		out.push(await serveAs(t, step.identity, step.cookie, path));
	}
	return out;
}

const byIdentity = (shots: IdentityShot[]) =>
	Object.fromEntries(shots.map((s) => [s.identity, s])) as Record<string, IdentityShot>;

describe.skipIf(skip)('the identity leak differential', () => {
	const interleaved = newSiteName('leak-mixed');
	const control = newSiteName('leak-control');
	let mixed: Transport;
	let fresh: Transport;
	let shots: IdentityShot[] = [];
	let controlShots: IdentityShot[] = [];

	beforeAll(async () => {
		mixed = transportFor(ENDPOINT, interleaved);
		fresh = transportFor(ENDPOINT, control);
		for (const t of [mixed, fresh]) {
			await provision(t);
			await migrate(t);
			await prefill(t);
		}
		shots = await runSequence(mixed, '/');
		controlShots = await runSequence(fresh, '/');
	}, 1_200_000);

	it('classified the privileged requests as authenticated, or it tested nothing', () => {
		const map = byIdentity(shots);
		// the guard against a vacuous pass: if the Worker did not treat these as logged in, the
		// whole differential is a comparison of five anonymous requests
		for (const identity of ['user-a', 'user-b', 'admin']) {
			expect(
				map[identity]?.authMode,
				`${identity} was not treated as authenticated`
			).not.toBeNull();
		}
		expect(map['anon-before']?.authMode).toBeNull();
		expect(map['anon-after']?.authMode).toBeNull();
	});

	it('every request in the sequence answered', () => {
		for (const shot of shots) {
			expect([200, 503], `${shot.identity} -> ${shot.status}`).toContain(shot.status);
		}
	});

	/**
	 * The core assertion: the interleaved run must match the isolated run, response for response.
	 *
	 * If any identity's output changed because another identity went before it, these digests
	 * diverge. Comparing against a control site rather than against each other is what distinguishes
	 * "these two identities legitimately see the same public page" from "one of them saw the
	 * other's".
	 */
	it('interleaving identities changes nothing about what each receives', () => {
		const mixedMap = byIdentity(shots);
		const controlMap = byIdentity(controlShots);
		for (const { identity } of SEQUENCE) {
			const a = mixedMap[identity];
			const b = controlMap[identity];
			expect(a, identity).toBeDefined();
			expect(b, identity).toBeDefined();
			expect(
				a?.sha1,
				`${identity} differs between the interleaved run and a fresh object: ` +
					`${a?.byteLength} bytes vs ${b?.byteLength}`
			).toBe(b?.sha1);
		}
	});

	/**
	 * The specific shape the uid-1 bug had: the anonymous page grew after a privileged request.
	 *
	 * Asserted separately from the digest comparison because it is the one that says WHAT went
	 * wrong. A size jump on the trailing anonymous request is admin HTML in the shared copy.
	 */
	it('the anonymous page is unchanged by the privileged requests between the two reads', () => {
		const map = byIdentity(shots);
		const before = map['anon-before'];
		const after = map['anon-after'];
		expect(before).toBeDefined();
		expect(after).toBeDefined();
		expect(
			after?.sha1,
			`anonymous output changed after privileged traffic: ${before?.byteLength} -> ${after?.byteLength} bytes`
		).toBe(before?.sha1);
	});

	/**
	 * The content-level differential, now that content can exist.
	 *
	 * Each identity saves a node carrying a marker only it should ever produce, and every response is
	 * then checked for every OTHER identity's marker. This is the check the uid-1 poisoning would
	 * have failed: admin HTML in the anonymous copy would carry the admin marker.
	 */
	it('no identity marker appears in another identity response', async () => {
		const markers: Record<string, string> = {};
		for (const step of SEQUENCE) {
			if (step.cookie === null) continue;
			const marker = `cfw-leak-${step.identity}`;
			markers[step.identity] = marker;
			const saved = await saveNode(mixed, { title: marker, body: marker });
			expect(saved.ok, `${step.identity}: ${JSON.stringify(saved).slice(0, 300)}`).toBe(true);
			// the acting-user restore is what keeps one identity's save out of the next render
			expect(saved.restoredUid, step.identity).toBe(0);
		}
		expect(Object.keys(markers).length).toBeGreaterThan(1);

		const after = await runSequence(mixed, '/');
		for (const shot of after) {
			for (const [owner, marker] of Object.entries(markers)) {
				if (owner === shot.identity) continue;
				expect(
					shot.body.includes(marker),
					`${shot.identity} received ${owner}'s marker ${marker}`
				).toBe(false);
			}
		}
	});

	it('reports what the run could not cover, so a pass is not over-read', () => {
		// a deliberate, asserted statement of scope rather than a comment nobody reads: these
		// cookies are Worker-shaped, not Drupal session records
		const map = byIdentity(shots);
		const authed = ['user-a', 'user-b', 'admin'].map((i) => map[i]?.sha1);
		expect(new Set(authed).size, 'the authenticated identities rendered identically').toBe(1);
		// which is EXPECTED here, and is exactly why this file cannot speak about Drupal's own
		// per-user rendering: Drupal saw no logged-in user for any of them
	});
});
