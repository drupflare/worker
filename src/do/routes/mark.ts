import type { StorageLike } from '../../db/migrate-sql';
import {
	changeManifest,
	changeStatements,
	endMark,
	incompleteReason,
	MARK_ID,
	readMark,
	startMark,
	type Dialect
} from '../../db/write-mark';
import type { SitePhpDurableObject } from '../../site-do';
import { jsonError } from '../../util/reply';

const shown = (row: { mark: string; startedAt: number }) => ({
	mark: row.mark,
	startedAt: row.startedAt
});

/**
 * The accepted-write mark. `POST ?mark=<id>` starts it (`replace=1` to take over a different one),
 * `GET` reads the count, `DELETE ?mark=<id>` ends it and removes its triggers and journal.
 */
export async function writemark(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (site.isReplica()) return jsonError('a replica lane keeps no mark', 409);
	const storage = site.storage as unknown as StorageLike;

	if (request.method === 'POST') {
		const mark = url.searchParams.get('mark') ?? '';
		if (!MARK_ID.test(mark))
			return jsonError('mark must be 1 to 64 letters, digits or _.:-', 400);
		const started = startMark(site.sql, storage, {
			mark,
			now: site.nowMs(),
			replace: url.searchParams.get('replace') === '1'
		});
		site.markState.active = true;
		if (started.status === 'conflict') {
			return jsonError('another mark is active; pass replace=1 to take it over', 409, {
				active: shown(started.mark)
			});
		}
		return Response.json(
			{ ok: true, ...shown(started.mark), status: started.status },
			{ status: started.status === 'existing' ? 200 : 201 }
		);
	}

	if (request.method === 'DELETE') {
		const row = readMark(site.sql);
		if (!row) return Response.json({ ok: true, ended: false });
		if (url.searchParams.get('mark') !== row.mark) {
			return jsonError('mark does not name the active mark', 409, { active: shown(row) });
		}
		endMark(site.sql, storage);
		site.markState.active = false;
		return Response.json({ ok: true, ended: true, mark: row.mark });
	}

	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return jsonError('GET, POST or DELETE', 405);
	}
	const row = readMark(site.sql);
	if (!row) return jsonError('no mark is active', 404);
	const reason = incompleteReason(row);
	return Response.json({
		ok: true,
		...shown(row),
		writes: row.writes,
		cap: row.cap,
		incomplete: reason !== undefined,
		...(reason ? { reason } : {})
	});
}

/**
 * The rows changed since the mark. Without `body=1` it answers a manifest; with it, the changes as
 * SQL for a MySQL source (`dialect=sqlite` for another object), read up to `through` and, with
 * `since`, only the writes after that number, which the `x-cfw-since` header repeats so a caller
 * can tell a site that honors it from one that ignores it.
 */
export async function writechanges(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD') return jsonError('GET only', 405);
	const raw = url.searchParams.get('through');
	const through = raw === null ? undefined : Number(raw);
	if (through !== undefined && (!Number.isSafeInteger(through) || through < 0)) {
		return jsonError('through must be a whole number', 400);
	}
	const rawSince = url.searchParams.get('since');
	const since = rawSince === null ? 0 : Number(rawSince);
	if (!Number.isSafeInteger(since) || since < 0) {
		return jsonError('since must be a whole number', 400);
	}
	if (through !== undefined && since > through) {
		return jsonError('since must not be past through', 400);
	}
	const dialect = (url.searchParams.get('dialect') ?? 'mysql') as Dialect;
	if (dialect !== 'mysql' && dialect !== 'sqlite') {
		return jsonError('dialect is mysql or sqlite', 400);
	}
	const manifest = changeManifest(site.sql, through, since);
	if (!manifest) return jsonError('no mark is active', 404);
	if (url.searchParams.get('body') !== '1') {
		return Response.json({ ok: true, dialect, ...manifest });
	}

	const steps = changeStatements(site.sql, { through: manifest.through, since, dialect });
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			const next = steps.next();
			if (next.done) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(`${next.value.join('\n')}\n`));
		}
	});
	return new Response(body, {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			'x-cfw-through': String(manifest.through),
			'x-cfw-since': String(since),
			'x-cfw-incomplete': manifest.incomplete ? (manifest.reason ?? 'yes') : 'no'
		}
	});
}
