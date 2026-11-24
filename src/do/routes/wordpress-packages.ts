import { bearerToken, ownerTokenIsSet, ownerTokenMatches } from '../../ops/site/secrets';
import type { SitePhpDurableObject } from '../../site-do';
import { cmsOf } from '../../util/cms';
import { jsonError } from '../../util/reply';
import { GENERATED_WP_PACKAGES } from '../../wordpress/generated/packages';
import { readOverlay, readReceipts } from '../../wordpress/overlay';
import { deletePackage, deliverPackage, rollbackPackage } from '../../wordpress/packages';

/**
 * The owner route for WordPress plugin and theme operations.
 *
 * `GET` lists what the host delivered, the receipts and the pinned registry. `POST ?op=` runs one
 * operation: `install` (also how an update is made: it takes `version`, or the highest pinned one),
 * `rollback` or `delete`, each on `slug`. Owner token only, like `/modify`; an unclaimed
 * diagnostics rig may call it before a claim.
 */
export async function wppackages(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (cmsOf(site.env) !== 'wordpress') return jsonError('this site does not run WordPress', 404);
	const store = site.secretStore();
	const unclaimedRig = site.env.PW_DIAGNOSTICS === '1' && !(await ownerTokenIsSet(store));
	const presented = bearerToken(request.headers.get('authorization'));
	if (!unclaimedRig && !(await ownerTokenMatches(store, presented))) {
		return jsonError('owner token required', 401);
	}
	if (request.method === 'GET') {
		return Response.json({
			ok: true,
			delivered: readOverlay(site).packages,
			receipts: readReceipts(site),
			registry: GENERATED_WP_PACKAGES
		});
	}
	if (request.method !== 'POST') return jsonError('use GET or POST', 405, { allow: 'GET, POST' });
	const op = url.searchParams.get('op') ?? '';
	const slug = url.searchParams.get('slug') ?? '';
	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return jsonError('name the package with slug', 400);
	const outcome =
		op === 'install'
			? await deliverPackage(site, slug, url.searchParams.get('version') ?? undefined)
			: op === 'rollback'
				? rollbackPackage(site, slug)
				: op === 'delete'
					? deletePackage(site, slug)
					: undefined;
	if (outcome === undefined) return jsonError('op is install, rollback or delete', 400);
	return Response.json(outcome, { status: outcome.ok ? 200 : 409 });
}
