import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../src/drupal/site-php';
import { fenceAllows } from '../../src/ops/replica';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Gate 2: the commit sequence advances on every change a stale replica must not serve.
 *
 * The fence itself is four obvious lines; what decides whether it protects anything is whether the
 * clock moves when authoritative state does. `generation` does not - it is a page-cache purge
 * counter, coalesced per fill, and it stops moving once `cfw_page` is empty. Measured: a permission
 * grant invalidated two cache tags and left it still. `commitSeq()` is the clock this fences on.
 *
 * Each case mutates through Drupal rather than writing the row, so the invalidation machinery under
 * test actually runs.
 */

const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Fence-Pass-4412';
const ORIGIN = 'https://do.local';

type Payload = Record<string, unknown>;

async function provisioned(site: ServeDo): Promise<void> {
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	await site.fetch(
		new Request('https://do.local/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ adminPass: PASS, siteName: 'Fence' }),
			headers: { 'content-type': 'application/json' }
		})
	);
}

/** runs one PHP mutation and reports the commit sequence on either side of it */
async function commitDelta(
	site: ServeDo,
	php: string
): Promise<{ before: number; after: number; moved: boolean; ok: Payload }> {
	const before = site.commitSeq();
	const ok = (await site.runJson(php)) as Payload;
	const after = site.commitSeq();
	return { before, after, moved: after > before, ok };
}

describe('the fence refuses a replica that is behind', () => {
	it('serves only when the applied view covers the required commit', () => {
		expect(fenceAllows(10, 10)).toBe(true);
		expect(fenceAllows(11, 10)).toBe(true);
		expect(fenceAllows(9, 10)).toBe(false);
		expect(fenceAllows(0, 1)).toBe(false);
	});

	it('refuses rather than guessing when either side is not a number', () => {
		expect(fenceAllows(Number.NaN, 1)).toBe(false);
		expect(fenceAllows(1, Number.NaN)).toBe(false);
		expect(fenceAllows(Number.POSITIVE_INFINITY, 1)).toBe(false);
	});
});

describe('the commit sequence advances on the changes a stale replica must not serve', () => {
	it(
		'moves on a permission, role, account and config change',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				await provisioned(site);
				const out: Record<
					string,
					{ moved: boolean; before: number; after: number; ok: Payload }
				> = {};

				// no node case: the default pack ships no node bundles, so a content write throws
				// here and the reading would look exactly like a missing invalidation
				out.grantPermission = await commitDelta(
					site,
					drupalOp(`
$role = \\Drupal::entityTypeManager()->getStorage('user_role')->load('authenticated');
$role->grantPermission('access site reports');
$role->save();
$out['perms'] = count($role->getPermissions());`)
				);

				out.createUser = await commitDelta(
					site,
					drupalOp(`
$user = \\Drupal::entityTypeManager()->getStorage('user')->create([
  'name' => 'fenceprobe', 'pass' => 'cfw-Fence-Pass-4412', 'status' => 1,
]);
$user->save();
$out['uid'] = $user->id();`)
				);

				out.blockUser = await commitDelta(
					site,
					drupalOp(`
$users = \\Drupal::entityTypeManager()->getStorage('user')->loadByProperties(['name' => 'fenceprobe']);
$user = reset($users);
$user->block();
$user->save();
$out['active'] = $user->isActive();`)
				);

				out.changeConfig = await commitDelta(
					site,
					drupalOp(`
\\Drupal::configFactory()->getEditable('system.site')->set('slogan', 'fenced')->save();
$out['slogan'] = \\Drupal::config('system.site')->get('slogan');`)
				);

				return out;
			});

			for (const [name, delta] of Object.entries(seen)) {
				// THE CONTROL FIRST. A fragment that threw moves no generation, which is
				// indistinguishable from a missing invalidation unless the op is checked -- this
				// spec reported two false findings that way before the check existed
				expect(
					(delta.ok as Payload)?.ok,
					`${name} did not run: ${JSON.stringify(delta.ok).slice(0, 300)}`
				).toBe(true);
				expect(
					delta.moved,
					`${name} ran and did not advance the generation (${delta.before} -> ${delta.after}); a replica behind it would still believe it is current`
				).toBe(true);
			}
		},
		REQUEST_TIMEOUT
	);

	/**
	 * Authorization is the case where staleness is a security bug rather than an annoyance, so the
	 * fence is composed with the clock here rather than asserted separately: a replica pinned at the
	 * pre-change commit must refuse, and the same replica caught up must serve.
	 *
	 * Revoke as well as grant. A grant that fences correctly and a revoke that does not would leave
	 * a replica serving a permission the primary has taken away, which is the worse direction.
	 */
	it(
		'fences a replica across both a permission grant and a revoke',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				await provisioned(site);
				const grant = await commitDelta(
					site,
					drupalOp(`
$role = \\Drupal::entityTypeManager()->getStorage('user_role')->load('authenticated');
$role->grantPermission('access site reports');
$role->save();
$out['has'] = $role->hasPermission('access site reports');`)
				);
				const revoke = await commitDelta(
					site,
					drupalOp(`
$role = \\Drupal::entityTypeManager()->getStorage('user_role')->load('authenticated');
$role->revokePermission('access site reports');
$role->save();
$out['has'] = $role->hasPermission('access site reports');`)
				);
				return { grant, revoke };
			});

			expect(seen.grant.ok?.ok, JSON.stringify(seen.grant.ok).slice(0, 200)).toBe(true);
			expect(seen.grant.ok?.has).toBe(true);
			expect(seen.revoke.ok?.ok, JSON.stringify(seen.revoke.ok).slice(0, 200)).toBe(true);
			expect(seen.revoke.ok?.has).toBe(false);

			for (const [name, delta] of Object.entries(seen)) {
				// a replica pinned before the change cannot answer, and caught up it can
				expect(fenceAllows(delta.before, delta.after), `${name} did not fence`).toBe(false);
				expect(fenceAllows(delta.after, delta.after)).toBe(true);
			}
		},
		REQUEST_TIMEOUT
	);

	/**
	 * Rotating `system.private_key` changes what every CSRF token validates against, and it is a
	 * `state:` write rather than a config entity - so Drupal invalidates no cache tag for it. If the
	 * clock does not move, a replica holding the old key passes the fence and issues tokens the
	 * primary rejects.
	 */
	it(
		'reports whether rotating the private key advances the commit sequence',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				await provisioned(site);
				const before = site.commitSeq();
				const rotated = (await site.runJson(
					drupalOp(`
$old = \\Drupal::service('private_key')->get();
\\Drupal::state()->set('system.private_key', \\Drupal\\Component\\Utility\\Crypt::randomBytesBase64(55));
$new = \\Drupal::service('private_key')->get();
$out['changed'] = $old !== $new;
$out['len'] = strlen($new);`)
				)) as Payload;
				return { before, after: site.commitSeq(), rotated };
			});

			// the control: if the key did not change, the clock reading means nothing
			expect(
				seen.rotated.ok,
				`the rotation did not run: ${JSON.stringify(seen.rotated).slice(0, 300)}`
			).toBe(true);
			expect(seen.rotated.changed, 'the private key did not rotate').toBe(true);

			expect(
				seen.after,
				`rotating system.private_key left the commit sequence at ${seen.before}, so the ` +
					`fence cannot protect a key rotation and replication must carry the key explicitly`
			).toBeGreaterThan(seen.before);
		},
		REQUEST_TIMEOUT
	);
});
