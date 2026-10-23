import type { SitePhpDurableObject } from '../../site-do';
import { jsonError } from '../../util/reply';

/**
 * `GET /__spool?op=cursor` and `?op=diff&from=N`: the version vector the spool shadow trial syncs
 * from. Internal: the front worker asks it for a `/.spool/sync` and a visitor cannot reach a `__`
 * path. Reads memory and the generation, so it writes no row.
 */
export async function spool(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'GET') return jsonError('GET only', 405, { allow: 'GET' });
	const current = site.generation();
	const op = url.searchParams.get('op');
	if (op === 'cursor') return Response.json({ cursor: current });
	if (op === 'diff') {
		const raw = url.searchParams.get('from') ?? '';
		const from = /^\d{1,15}$/.test(raw) ? Number(raw) : -1;
		return Response.json(site.spoolVector().diff(from, current));
	}
	return jsonError('op must be cursor or diff', 400);
}
