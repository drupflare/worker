import { normaliseUri, registerOffloaded } from '../../db/file-store';
import type { SitePhpDurableObject } from '../../site-do';
import { jsonError } from '../../util/reply';

/**
 * `PUT /file?uri=public://path` registers a file held only in R2: the body goes to this site's
 * bucket prefix and the object records an evicted row with no resident chunks.
 *
 * The caller sends `x-file-sha256` (hex) and `content-length`; R2 checks the digest as it receives
 * the bytes and the row is written only after the stored size matches. It needs `FILE_STORE=r2` and
 * the bucket for the scheme, and it spends one R2 write against the month's allowance.
 */
export async function file(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	if (request.method !== 'PUT') return jsonError('use PUT', 405, { allow: 'PUT' });
	if (!site.fileStoreR2()) {
		return jsonError('R2 is not the file store on this site', 501, {
			code: 'no_r2_store',
			how: 'set FILE_STORE=r2 and bind FILES'
		});
	}
	const uri = normaliseUri(url.searchParams.get('uri') ?? '');
	const scheme = uri === undefined ? '' : uri.slice(0, uri.indexOf('://'));
	if (uri === undefined || uri.endsWith('://') || !site.fileSchemes().includes(scheme)) {
		return jsonError('uri must be a public:// or private:// file this site stores', 400, {
			code: 'bad_uri'
		});
	}
	const sha256 = (request.headers.get('x-file-sha256') ?? '').trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(sha256)) {
		return jsonError('x-file-sha256 must be the hex sha256 of the bytes', 400, {
			code: 'sha256_required'
		});
	}
	const declared = request.headers.get('content-length');
	const size = declared === null || !/^\d+$/.test(declared) ? NaN : Number(declared);
	if (!Number.isSafeInteger(size)) {
		return jsonError('content-length is required', 400, { code: 'length_required' });
	}
	if (site.r2Allowance().left <= 0) {
		return jsonError("this month's R2 write allowance is spent", 429, { code: 'r2_budget' });
	}
	const mime = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().slice(0, 255);

	let body: ReadableStream<Uint8Array> | Uint8Array = new Uint8Array(0);
	let piped: Promise<void> | undefined;
	if (size > 0) {
		if (request.body === null)
			return jsonError('the body is empty', 400, { code: 'empty_body' });
		const fixed = new FixedLengthStream(size);
		piped = request.body.pipeTo(fixed.writable).catch(() => undefined);
		body = fixed.readable;
	}
	const result = await registerOffloaded(site.sql, site.fileBuckets(), {
		uri,
		body,
		size,
		sha256,
		...(mime ? { mime } : {}),
		site: site.siteName(),
		nowMs: site.nowMs(),
		schemes: site.fileSchemes()
	});
	await piped;
	site.chargeR2(1);
	if (!result.ok) return jsonError(result.message, result.status, { code: result.code });
	site.rowsSinceFlush = (site.rowsSinceFlush ?? 0) + 3;
	return Response.json({
		ok: true,
		uri: result.uri,
		size: result.size,
		sha256,
		store: 'r2',
		replaced: result.replaced
	});
}
