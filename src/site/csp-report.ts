import {
	CSP_REPORT_MAX_BYTES,
	CSP_REPORT_PATH,
	CSP_REPORT_TYPES,
	cspReportAllowed,
	parseCspReport
} from '../ops/csp';
import type { FrontEntry } from './types';

const headers = { 'cache-control': 'no-store' };

const refuse = (status: number, extra: HeadersInit = {}) =>
	new Response(null, { status, headers: { ...headers, ...extra } });

/** reads at most `max` bytes, or undefined when the body is longer (a chunked body declares none) */
async function readCapped(request: Request, max: number): Promise<string | undefined> {
	const reader = request.body?.getReader();
	if (!reader) return '';
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	const joined = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		joined.set(chunk, at);
		at += chunk.byteLength;
	}
	return new TextDecoder().decode(joined);
}

/**
 * `POST /csp-report`: a browser's report of what a policy blocked or would have.
 *
 * Public, and it costs a worker request per call, so the budget is read before the body and a
 * client over it is answered 204 with nothing logged. It never addresses the object: the line
 * goes to Workers observability, which is where an operator reads it.
 */
export async function cspReportRoute(f: FrontEntry): Promise<Response | undefined> {
	const { request, url, resolvedSite } = f;
	if (f.internal || url.pathname !== CSP_REPORT_PATH) return undefined;
	if (request.method !== 'POST') return refuse(405, { allow: 'POST' });

	const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
	if (!cspReportAllowed(address, Date.now())) return refuse(204);

	const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
	if (!(CSP_REPORT_TYPES as readonly string[]).includes(type)) return refuse(415);
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (declared > CSP_REPORT_MAX_BYTES) return refuse(413);
	const body = await readCapped(request, CSP_REPORT_MAX_BYTES);
	if (body === undefined) return refuse(413);

	const entries = parseCspReport(body);
	if (entries.length === 0) return refuse(400);
	for (const entry of entries) console.log('cfw-csp-report', { site: resolvedSite, ...entry });
	return refuse(204);
}
