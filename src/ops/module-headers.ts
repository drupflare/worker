/** the browser-facing headers a Drupal module may set, lowercase; every other name is dropped */
export const MODULE_HEADER_NAMES: ReadonlySet<string> = new Set([
	'content-security-policy',
	'content-security-policy-report-only',
	'permissions-policy',
	'x-frame-options',
	'x-content-type-options',
	'referrer-policy',
	'strict-transport-security',
	'cross-origin-opener-policy',
	'cross-origin-embedder-policy',
	'cross-origin-resource-policy',
	'x-permitted-cross-domain-policies'
]);

/** the longest value kept, in bytes (the same cap a `RESPONSE_HEADERS` value has) */
export const MODULE_HEADER_MAX_BYTES = 4096;

// printable ASCII and tab only: CR, LF and NUL split or truncate a response, and a character
// above 255 makes `Headers.set()` throw while a stored page is replayed
const NOT_HEADER_TEXT = /[^\t\x20-\x7e]/;

/** whether a header may be forwarded: an allow-listed name with a short single-line value */
export function acceptModuleHeader(name: string, value: unknown): value is string {
	return (
		MODULE_HEADER_NAMES.has(name.toLowerCase()) &&
		typeof value === 'string' &&
		value !== '' &&
		value.length <= MODULE_HEADER_MAX_BYTES &&
		!NOT_HEADER_TEXT.test(value)
	);
}

/** the accepted headers of an unvalidated record (a render result, a stored row, a KV document) */
export function moduleHeaderRecord(raw: unknown): Record<string, string> {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (acceptModuleHeader(name, value)) out[name.toLowerCase()] = value;
	}
	return out;
}

/** the accepted headers of a response, for a tier that stores the page it answered with */
export function moduleHeadersOf(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of headers) {
		if (acceptModuleHeader(name, value)) out[name] = value;
	}
	return out;
}

/** the value of the `cfw_page.headers` column: JSON, or null when there is nothing to keep */
export function encodeModuleHeaders(raw: unknown): string | null {
	const kept = moduleHeaderRecord(raw);
	return Object.keys(kept).length === 0 ? null : JSON.stringify(kept);
}

/**
 * What a stored column holds, run through the boundary again.
 * A row written by SQL, an old row (null) and unparseable text all read as no headers.
 */
export function decodeModuleHeaders(stored: unknown): Record<string, string> {
	if (typeof stored !== 'string' || stored === '') return {};
	try {
		return moduleHeaderRecord(JSON.parse(stored));
	} catch {
		return {};
	}
}
