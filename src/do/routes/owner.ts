import {
	DO_MAX_STATEMENT_CHARS,
	DUMP_START,
	dumpChunk,
	type DumpCursor,
	dumpDatabase
} from '../../db/export-sql';
import { storeImport } from '../../db/import-sql';
import { isBookmark } from '../../ops/site-secrets';
import type { SitePhpDurableObject } from '../../site-do';
import { errorMessage } from '../../util/errors';
import { jsonError } from '../../util/reply';

/**
 * Point-in-time recovery, which the platform offers only as a runtime API (no wrangler
 * command, no dashboard button).
 */
export async function pitr(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const storage = site.storage as unknown as {
		getCurrentBookmark?: () => Promise<string>;
		getBookmarkForTime?: (at: Date) => Promise<string>;
		onNextSessionRestoreBookmark?: (b: string) => Promise<string>;
	};
	// 501 rather than 200, so a caller can tell "no change log on this back end" from a taken
	// bookmark
	const refuse = (e: unknown) =>
		Response.json(
			{
				ok: false,
				supported: false,
				error: errorMessage(e)
			},
			{ status: 501 }
		);

	if (request.method === 'POST') {
		const bookmark = url.searchParams.get('bookmark') ?? '';
		if (!isBookmark(bookmark)) {
			return jsonError('a bookmark is required', 400);
		}
		try {
			// the undo is obtainable only from the call that schedules the restore
			const undo = await storage.onNextSessionRestoreBookmark?.(bookmark);
			return Response.json({
				ok: true,
				scheduled: bookmark,
				undo,
				note: 'applied on the next start of this object; keep `undo` to reverse it'
			});
		} catch (e) {
			return refuse(e);
		}
	}

	const at = url.searchParams.get('at');
	if (at !== null) {
		const when = new Date(/^\d+$/.test(at) ? Number(at) : at);
		if (Number.isNaN(when.getTime())) {
			return jsonError('not a time this can read', 400);
		}
		const days = (site.nowMs() - when.getTime()) / 86_400_000;
		if (days > 30 || days < 0) {
			return jsonError('outside the 30-day recovery window', 400);
		}
		try {
			return Response.json({
				ok: true,
				at: when.toISOString(),
				bookmark: await storage.getBookmarkForTime?.(when)
			});
		} catch (e) {
			return refuse(e);
		}
	}

	let current: string;
	try {
		current = (await storage.getCurrentBookmark?.()) ?? '';
	} catch (e) {
		return refuse(e);
	}
	// a back end with no change log answers an all-zero bookmark instead of throwing, so
	// feature-detecting the method passes
	if (!isBookmark(current)) {
		return Response.json(
			{
				ok: false,
				supported: false,
				current,
				error: 'this storage back-end keeps no change log; the bookmark is zero'
			},
			{ status: 501 }
		);
	}
	return Response.json({ ok: true, supported: true, current, windowDays: 30 });
}

/** imports a POSTed SQL dump and arms the alarm to apply it */
export async function restore(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonError('POST a dump body to /restore', 405);
	}
	const stored = storeImport(site.sql, await request.text(), {
		storage: site.storage,
		generation: url.searchParams.get('label') ?? String(site.nowMs()),
		source: '/__restore',
		nowMs: site.nowMs()
	});
	await site.setAlarmAt(site.nowMs() + 1);
	return Response.json({ ok: true, ...stored });
}

/** exports the site database as SQL, in cursor-paged chunks */
export async function exportRoute(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const options = {
		limitPerTable: Number(url.searchParams.get('limit') ?? 0),
		// asked for by name, not implied by `all=1` (that flag widens which tables carry rows)
		...(url.searchParams.get('secrets') === '1' ? { secrets: true } : {}),
		...(url.searchParams.get('all') === '1' ? { includeRows: () => true } : {}),
		...(url.searchParams.get('chunkChars')
			? { maxCharsPerChunk: Number(url.searchParams.get('chunkChars')) }
			: {})
	};

	const rawCursor = url.searchParams.get('cursor');
	if (rawCursor !== null) {
		let cursor: DumpCursor;
		try {
			cursor = rawCursor === 'start' ? DUMP_START : JSON.parse(rawCursor);
		} catch {
			return jsonError('cursor is not JSON; start with ?cursor=start', 400);
		}
		let chunk;
		try {
			chunk = dumpChunk(site.sql, cursor, options);
		} catch (e) {
			// a shape mismatch means two dumps are being spliced into a file that looks whole
			return jsonError(errorMessage(e), 409);
		}
		const { sql: chunkSql, ...chunkMeta } = chunk;
		return Response.json(
			{
				ok: true,
				...chunkMeta,
				// the cursor is opaque to the caller and goes back verbatim
				nextCursor: chunk.done ? null : JSON.stringify(chunk.cursor),
				...(url.searchParams.get('body') === '1'
					? { sql: chunkSql }
					: { sqlOmitted: chunkSql.length })
			},
			{ status: chunk.replayable ? 200 : 409 }
		);
	}

	const { sql, ...meta } = dumpDatabase(site.sql, options);
	// 409 when the dump cannot be replayed, since an unreplayable restore point reads as a backup
	// (`?all=1` emits the whole `cache_container` row: 960,544 chars against a 100,000 ceiling)
	const status = meta.replayable ? 200 : 409;
	const envelope = {
		// the cursor path above answers `ok`, so callers can branch on one field across both shapes
		ok: meta.replayable,
		...meta,
		...(meta.replayable
			? {}
			: {
					error: `widest statement is ${meta.maxStatementChars} chars against the ${DO_MAX_STATEMENT_CHARS} a Durable Object accepts; this dump cannot be restored`,
					how: 'drop ?all=1, or narrow with ?limit='
				})
	};
	return url.searchParams.get('body') === '1'
		? Response.json({ ...envelope, sql }, { status })
		: Response.json({ ...envelope, sqlOmitted: sql.length }, { status });
}
