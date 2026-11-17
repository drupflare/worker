import { bytesToBase64 } from '../db/file-store';
import { WORDPRESS_REQUEST_PHP } from '../site/generated/assets';
import { HOST_HELPERS } from '../site/shims/host-helpers';
import { phpRender } from '../util/php';

/** the request-shaped inputs of {@link wordpressRender}; every field is optional */
export interface WordpressRequest {
	/** the `scheme://host[:port]` the site renders absolute URLs against */
	origin?: string;
	/** HTTP method; absent is GET */
	method?: string;
	/** the raw request body as text */
	body?: string;
	/** the body as base64, for one that is not UTF-8; wins over `body` */
	bodyBase64?: string;
	/** the inbound content type, which decides whether the body is parsed as a form */
	contentType?: string;
	/** the raw `Cookie` header */
	cookie?: string;
	/** the visitor's address */
	clientIp?: string;
	/** the raw `Accept` header */
	accept?: string;
	/** every other inbound header worth handing WordPress, lowercase by name */
	headers?: Record<string, string>;
}

/** a PHP single-quoted string literal: only a backslash and a quote are special in one */
export function phpQuoted(text: string): string {
	return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * The PHP for one WordPress request: it loads the front controller (or the one script a path names),
 * runs to its end or to the exit WordPress would have made, and prints one JSON object with the
 * status, body, headers and cookies.
 *
 * Request fields are JSON-encoded into one literal, never interpolated into the PHP.
 */
export function wordpressRender(path = '/', request: WordpressRequest = {}): string {
	const body =
		request.bodyBase64 ??
		(request.body === undefined ? '' : bytesToBase64(new TextEncoder().encode(request.body)));
	const encoded = JSON.stringify({
		path: String(path),
		origin: String(request.origin ?? ''),
		method: String(request.method ?? 'GET'),
		bodyBase64: body,
		contentType: String(request.contentType ?? ''),
		cookie: String(request.cookie ?? ''),
		clientIp: String(request.clientIp ?? ''),
		accept: String(request.accept ?? ''),
		headers: request.headers ?? {}
	});
	return phpRender(WORDPRESS_REQUEST_PHP, {
		HOST_HELPERS,
		REQUEST: phpQuoted(encoded)
	});
}
