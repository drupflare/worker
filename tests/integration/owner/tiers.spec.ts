import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../../src/drupal/php/site';
import {
	claimSite,
	encodeForm,
	formPost,
	hiddenFields,
	loginJar,
	render,
	type FormResult
} from '../../helpers/drupal-forms';
import { freshSite, inObject, type ServeDo } from '../../helpers/serve-do';

/**
 * The three drupflare permissions, driven through real renders.
 *
 * `view drupflare status` reads, `administer drupflare site` changes levers and runs the terminal,
 * `administer drupflare owner` delivers code. The last is granted at claim, and a permission that
 * whoever holds `administer permissions` could tick would not be a tier, so the grant paths are
 * driven as an administrator who lacks it.
 */

const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Owner-7731-pass';
const ORIGIN = 'https://do.local';
const OWNER = 'administer drupflare owner';

type Probe = Record<string, unknown>;

async function probe(site: ServeDo, php: string): Promise<Probe> {
	return (await site.runJson(drupalOp(php))) as Probe;
}

const status = (page: FormResult) => Number(page['status']);

/** the owner role as the claim left it, from a site whose first interpreter came from the given arm */
async function ownerRoleAfterClaim(arm: 'restored' | 'rendered-first') {
	return inObject(freshSite(), async (site: ServeDo) => {
		site.env = { ...site.env, BOOT_IMAGE: arm === 'restored' ? '1' : '0' };
		if (arm === 'rendered-first') {
			await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
			await site.fillOne('/user/login');
		}
		await claimSite(site, PASS, 'Owner');
		const role = await probe(
			site,
			`$role = \\Drupal\\user\\Entity\\Role::load('drupflare_owner');
			$out['perms'] = $role ? $role->getPermissions() : null;
			$out['carrying'] = \\Drupal\\drupflare\\Hook\\OwnerTier::carryingRoles();`
		);
		return { role, used: (site as any).bootImage?.used };
	});
}

describe('the owner role a claim creates', () => {
	it(
		'keeps its owner permission when the claim runs on a restored boot image',
		async () => {
			const seen = await ownerRoleAfterClaim('restored');
			expect(
				seen.used,
				'the claim has to run on a restored image; rerun `bun run assets:bootimage`'
			).toBe(true);
			expect(seen.role['perms']).toContain(OWNER);
			expect(seen.role['carrying']).toContain('drupflare_owner');
		},
		REQUEST_TIMEOUT
	);

	it(
		'keeps its owner permission when a render ran before the claim',
		async () => {
			const seen = await ownerRoleAfterClaim('rendered-first');
			expect(seen.role['perms']).toContain(OWNER);
			expect(seen.role['carrying']).toContain('drupflare_owner');
		},
		REQUEST_TIMEOUT
	);
});

describe('the three drupflare permission tiers', () => {
	it(
		'gives each tier its pages and keeps the owner tier from granting itself',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				site.env = { ...site.env, BOOT_IMAGE: '1' };
				await claimSite(site, PASS, 'Owner');
				site.sql.exec('DELETE FROM cache_container');
				const claimed = await probe(
					site,
					`$u = \\Drupal\\user\\Entity\\User::load(1);
					$out['uid1'] = $u->hasRole('drupflare_owner');
					$out['perm'] = $u->hasPermission('${OWNER}');`
				);
				await probe(
					site,
					`foreach (['status_only' => ['view drupflare status'],
						'deputy' => ['administer drupflare site', 'administer permissions', 'administer users', 'access user profiles']] as $rid => $perms) {
						$role = \\Drupal\\user\\Entity\\Role::create(['id' => $rid, 'label' => $rid]);
						foreach ($perms as $p) { $role->grantPermission($p); }
						$role->save();
						\\Drupal\\user\\Entity\\User::create(['name' => $rid, 'mail' => $rid . '@example.com', 'pass' => '${PASS}', 'status' => 1, 'roles' => [$rid]])->save();
					}
					$out['ok'] = true;`
				);

				const page = async (cookie: string, path: string) =>
					render(site, path, { cookie, origin: ORIGIN });

				const watcher = await loginJar(site, 'status_only', PASS, ORIGIN);
				const watcherStatus = await page(watcher, '/admin/config/drupflare/status');
				const readOnly = {
					status: status(watcherStatus),
					meters: String(watcherStatus['html'] ?? '').includes('Interpreter booted'),
					settings: status(await page(watcher, '/admin/config/drupflare/settings')),
					terminal: status(
						await page(watcher, '/admin/config/development/drupflare-ops')
					),
					delivery: status(await page(watcher, '/admin/modules/drupflare'))
				};

				const deputy = await loginJar(site, 'deputy', PASS, ORIGIN);
				const site_ = {
					settings: status(await page(deputy, '/admin/config/drupflare/settings')),
					delivery: status(await page(deputy, '/admin/modules/drupflare'))
				};

				// the permissions form, with the owner box ticked for the deputy's own role
				const perms = await page(deputy, '/admin/people/permissions/module/drupflare');
				const permsHtml = String(perms['html'] ?? '');
				const ownerBox = new RegExp(`<input[^>]*name="deputy\\[${OWNER}\\]"[^>]*>`).exec(
					permsHtml
				)?.[0];
				await render(site, '/admin/people/permissions/module/drupflare', {
					...formPost(
						encodeForm({
							...hiddenFields(permsHtml),
							[`deputy[${OWNER}]`]: OWNER,
							'deputy[administer drupflare site]': 'administer drupflare site',
							// CONTROL: a box the deputy may tick, so a refused save cannot pass as a guard
							'deputy[view drupflare status]': 'view drupflare status',
							op: 'Save permissions'
						}),
						deputy
					),
					origin: ORIGIN
				});

				// and the account form, giving the deputy the owner role
				const uid = Number(
					(await probe(site, `$out['uid'] = (int) user_load_by_name('deputy')->id();`))[
						'uid'
					]
				);
				const edit = await page(deputy, `/user/${uid}/edit`);
				await render(site, `/user/${uid}/edit`, {
					...formPost(
						encodeForm({
							...hiddenFields(String(edit['html'] ?? '')),
							name: 'deputy',
							mail: 'deputy@example.com',
							'roles[deputy]': 'deputy',
							'roles[drupflare_owner]': 'drupflare_owner',
							// CONTROL, for the same reason
							'roles[status_only]': 'status_only',
							op: 'Save'
						}),
						deputy
					),
					origin: ORIGIN
				});

				const after = await probe(
					site,
					`$out['rolePerm'] = \\Drupal\\user\\Entity\\Role::load('deputy')->hasPermission('${OWNER}');
					$out['controlPerm'] = \\Drupal\\user\\Entity\\Role::load('deputy')->hasPermission('view drupflare status');
					$out['userRole'] = user_load_by_name('deputy')->hasRole('drupflare_owner');
					$out['controlRole'] = user_load_by_name('deputy')->hasRole('status_only');`
				);

				// past the forms: a save made as the deputy inside a routed request is put back
				const direct = await probe(
					site,
					`$deputy = user_load_by_name('deputy');
					\\Drupal::currentUser()->setAccount($deputy);
					$request = \\Symfony\\Component\\HttpFoundation\\Request::create('/admin/people');
					$request->attributes->set('_route', 'entity.user.collection');
					\\Drupal::requestStack()->push($request);
					$role = \\Drupal\\user\\Entity\\Role::load('deputy');
					$role->grantPermission('${OWNER}');
					$role->save();
					$deputy->addRole('drupflare_owner');
					$deputy->save();
					\\Drupal::requestStack()->pop();
					\\Drupal::currentUser()->setAccount(new \\Drupal\\Core\\Session\\AnonymousUserSession());
					$out['rolePerm'] = \\Drupal\\user\\Entity\\Role::load('deputy')->hasPermission('${OWNER}');
					$out['userRole'] = user_load_by_name('deputy')->hasRole('drupflare_owner');`
				);
				return { claimed, readOnly, site: site_, ownerBox, after, direct };
			});

			console.log(`[owner-tiers] ${JSON.stringify(seen)}`);
			expect(seen.claimed).toMatchObject({ uid1: true, perm: true });
			// a 403 rendered as an empty 200 is the failure the status check exists for
			expect(seen.readOnly).toEqual({
				status: 200,
				meters: true,
				settings: 403,
				terminal: 403,
				delivery: 403
			});
			expect(seen.site).toEqual({ settings: 200, delivery: 403 });
			expect(seen.ownerBox, 'the owner checkbox did not render').toBeDefined();
			expect(seen.ownerBox).toContain('disabled');
			expect(seen.after).toMatchObject({
				rolePerm: false,
				controlPerm: true,
				userRole: false,
				controlRole: true
			});
			expect(seen.direct).toMatchObject({ rolePerm: false, userRole: false });
		},
		REQUEST_TIMEOUT
	);
});
