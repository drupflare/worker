import {
	fetchOffloaded,
	getFileChunk,
	listOffloaded,
	normaliseUri,
	recordedHash,
	statFile,
	storedBytes,
	type ByteRange
} from '../../db/file-store';
import type { SitePhpDurableObject } from '../../site-do';
import { jsonError } from '../../util/reply';

/** a page of the listing never exceeds this many files */
export const OFFLOADED_PAGE_MAX = 1000;

/** how many files a page holds when the caller names no limit */
export const OFFLOADED_PAGE_DEFAULT = 500;

/**
 * One `Range: bytes=` header against a file size: the inclusive span, `unsatisfiable`, or
 * undefined when the header is absent, malformed or asks for several spans (the whole file
 * answers those, as RFC 9110 allows).
 */
export function parseRange(
	header: string | null,
	size: number
): { start: number; end: number } | 'unsatisfiable' | undefined {
	if (header === null || size === 0) return undefined;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (match === null || (match[1] === '' && match[2] === '')) return undefined;
	if (match[1] === '') {
		const suffix = Number(match[2]);
		if (suffix === 0) return 'unsatisfiable';
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(match[1]);
	if (start >= size) return 'unsatisfiable';
	const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
	return end < start ? undefined : { start, end };
}

/** a resident file as a stream of its chunk rows, one chunk in memory at a time */
function residentStream(
	site: SitePhpDurableObject,
	uri: string,
	start: number,
	end: number
): ReadableStream<Uint8Array> {
	const sizes = site.sql
		.exec('SELECT seq, length(bytes) AS n FROM cfw_file_chunk WHERE uri = ? ORDER BY seq', uri)
		.toArray() as { seq: number; n: number }[];
	let next = 0;
	let at = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			while (next < sizes.length) {
				const row = sizes[next] as { seq: number; n: number };
				const first = at;
				const length = Number(row.n);
				at += length;
				next += 1;
				if (at <= start) continue;
				if (first > end) break;
				const bytes = getFileChunk(site.sql, uri, Number(row.seq));
				if (bytes === undefined) {
					controller.error(new Error('a chunk of the file is missing'));
					return;
				}
				controller.enqueue(
					bytes.subarray(Math.max(0, start - first), Math.min(length, end + 1 - first))
				);
				return;
			}
			controller.close();
		}
	});
}

/** the listing: files held only in R2, a page at a time, in URI order */
function listing(site: SitePhpDurableObject, url: URL): Response {
	const asked = Number(url.searchParams.get('limit') ?? OFFLOADED_PAGE_DEFAULT);
	const limit = Number.isFinite(asked)
		? Math.min(OFFLOADED_PAGE_MAX, Math.max(1, Math.floor(asked)))
		: OFFLOADED_PAGE_DEFAULT;
	const after = url.searchParams.get('after') ?? undefined;
	if (after !== undefined && after.length > 2048) return jsonError('after is too long', 400);
	const page = listOffloaded(site.sql, { after, limit: limit + 1, site: site.siteName() });
	const more = page.length > limit;
	const files = page.slice(0, limit).map((f) => {
		const [scheme = '', path = ''] = f.uri.split('://');
		return {
			uri: f.uri,
			scheme,
			path,
			size: f.size,
			contentType: f.mime,
			sha256: f.sha256,
			modified: f.modified,
			...(f.foreign ? { foreign: true } : {})
		};
	});
	return Response.json({
		ok: true,
		files,
		next: more ? (files[files.length - 1]?.uri ?? null) : null,
		// the first page carries the totals; counting again per page would scan the table each time
		...(after === undefined ? { total: storedBytes(site.sql).offloaded } : {})
	});
}

/**
 * Files held only in R2, for a caller that must carry them elsewhere: `GET /offloaded` lists them
 * and `GET /offloaded?uri=` streams one file's bytes, with `Range` support. The stream serves any
 * stored file, so a file that came back into the object since the listing still answers: from its
 * chunk rows when it is resident, from R2 when it is evicted.
 */
export async function offloaded(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return jsonError('GET /offloaded to list, GET /offloaded?uri= to read a file', 405);
	}
	const raw = url.searchParams.get('uri');
	if (raw === null) return listing(site, url);

	// only a row of this site's own file table is ever read, and its URI cannot climb out
	const uri = normaliseUri(raw);
	if (uri === undefined) return jsonError('that is not a file URI', 400, { code: 'bad_uri' });
	const meta = statFile(site.sql, uri);
	if (meta === undefined) return jsonError('no such file', 404, { code: 'not_found' });

	const range = parseRange(request.headers.get('range'), meta.size);
	if (range === 'unsatisfiable') {
		return new Response(null, {
			status: 416,
			headers: { 'content-range': `bytes */${meta.size}`, 'cache-control': 'no-store' }
		});
	}
	const span: ByteRange | undefined =
		range === undefined
			? undefined
			: { offset: range.start, length: range.end - range.start + 1 };
	const length = span === undefined ? meta.size : span.length;
	const sha256 = recordedHash(site.sql, uri);
	const headers: Record<string, string> = {
		'content-type': meta.mime ?? 'application/octet-stream',
		'content-length': String(length),
		'accept-ranges': 'bytes',
		'cache-control': 'private, no-store',
		'x-cfw-file-store': meta.evicted ? 'r2' : 'object',
		'x-cfw-file-size': String(meta.size),
		...(sha256 === undefined ? {} : { etag: `"${sha256}"`, 'x-cfw-file-sha256': sha256 }),
		...(range === undefined
			? {}
			: { 'content-range': `bytes ${range.start}-${range.end}/${meta.size}` })
	};
	const status = range === undefined ? 200 : 206;
	if (request.method === 'HEAD') return new Response(null, { status, headers });

	if (!meta.evicted) {
		const stream = residentStream(
			site,
			uri,
			range === undefined ? 0 : range.start,
			range === undefined ? Math.max(0, meta.size - 1) : range.end
		);
		return new Response(meta.size === 0 ? null : stream, { status, headers });
	}

	try {
		const object = await fetchOffloaded(
			site.fileBuckets(),
			meta,
			site.siteName(),
			() => site.trustedFileSources(),
			span
		);
		if (object.body === null) throw new Error('the object came back with no body');
		return new Response(object.body, { status, headers });
	} catch (e) {
		site.noteError('offloaded', e);
		const foreign = String((e as Error)?.message ?? '').includes('not authorized');
		return foreign
			? jsonError('the file belongs to another site that this site may not read', 403, {
					code: 'foreign_prefix'
				})
			: jsonError('the file could not be read from storage', 502, {
					code: 'storage_unavailable'
				});
	}
}
