import { bearerToken, ownerTokenMatches } from '../../ops/site-secrets';
import type { SitePhpDurableObject } from '../../site-do';
import { jsonError } from '../../util/reply';

/**
 * Wipes this object for `POST /retire`. The front worker has already refused the primary and
 * written the audit entry; this checks the token again where the secret lives, and the confirm
 * against the object's own name.
 *
 * A caller with no token is accepted only under `force=1` on a deployment with `PW_DIAGNOSTICS`,
 * which already reaches `/sql` and `/restore` on every site.
 */
export async function retire(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'POST') return jsonError('use POST', 405);
	const force = url.searchParams.get('force') === '1';
	const owner = await ownerTokenMatches(
		site.secretStore(),
		bearerToken(request.headers.get('authorization'))
	);
	if (!owner && !(force && site.env.PW_DIAGNOSTICS === '1')) {
		return jsonError('owner token required', 401);
	}
	const name = site.ctx.id.name;
	let confirm: unknown;
	try {
		confirm = ((await request.json()) as { confirm?: unknown } | null)?.confirm;
	} catch {
		// the check below refuses a missing confirm
	}
	if (name === undefined || confirm !== name) {
		return jsonError('confirm must equal the site id', 400);
	}
	const storage = site.ctx.storage;
	const tables = storage.sql
		.exec("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE '_cf_%'")
		.one().n as number;
	const alarm = await storage.getAlarm();
	// a name that holds nothing would only be minted by `idFromName()` and wiped again
	if (tables === 0 && alarm === null) {
		return jsonError(`${name} holds no state, so there is nothing to retire`, 404);
	}
	await site.retire();
	return Response.json({ ok: true, wiped: { tables, alarm: alarm !== null } });
}
