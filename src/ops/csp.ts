/** what `CSP_MODE` accepts */
export const CSP_MODES = ['off', 'report-only', 'enforce'] as const;

/** one value of `CSP_MODE` */
export type CspMode = (typeof CSP_MODES)[number];

/** where a browser posts a violation report; answered by the front worker alone */
export const CSP_REPORT_PATH = '/csp-report';

/**
 * The baseline policy: it sets no `default-src`, `script-src` or `style-src`, so core's inline
 * script and style keep working, and it carries no `form-action`. A form that posts to a page and
 * redirects to another origin (a login button that sends the visitor to an identity provider) is
 * blocked by `form-action 'self'` in Chromium, and no site can be checked here for one.
 */
export const CSP_BASELINE = [
	"object-src 'none'",
	"base-uri 'self'",
	"frame-ancestors 'self'",
	`report-uri ${CSP_REPORT_PATH}`
].join('; ');

/** the header a mode sends, or undefined for `off` */
export function cspBaselineHeader(mode: CspMode): { name: string; value: string } | undefined {
	if (mode === 'off') return undefined;
	return {
		name:
			mode === 'enforce' ? 'content-security-policy' : 'content-security-policy-report-only',
		value: CSP_BASELINE
	};
}

// #region the report route

/** the largest report body read; a browser's own report is well under 2 KiB */
export const CSP_REPORT_MAX_BYTES = 8192;

/** the content types a browser posts a report under (legacy `report-uri`, then the Reporting API) */
export const CSP_REPORT_TYPES = ['application/csp-report', 'application/reports+json'] as const;

/** reports one address may send per window before it is answered without a log line */
export const CSP_REPORT_IP_LIMIT = 60;

/** reports one isolate accepts per window from every address together */
export const CSP_REPORT_GLOBAL_LIMIT = 600;

/** the window both limits count over */
export const CSP_REPORT_WINDOW_MS = 60_000;

/** the most report entries one request may carry (the Reporting API batches) */
export const CSP_REPORT_MAX_ENTRIES = 10;

const perAddress = new Map<string, { count: number; first: number }>();
let overall = { count: 0, first: 0 };

/** drops both budgets; tests use it */
export function resetCspReportBudget(): void {
	perAddress.clear();
	overall = { count: 0, first: 0 };
}

/**
 * Counts one report against the address and the isolate, and says whether it may be logged.
 *
 * In memory and per isolate, like the owner failure budget: a durable counter would spend a row
 * per report. The map is bounded because the key is attacker-supplied.
 */
export function cspReportAllowed(address: string, nowMs: number): boolean {
	if (nowMs - overall.first >= CSP_REPORT_WINDOW_MS) overall = { count: 0, first: nowMs };
	if (perAddress.size > 4096) perAddress.clear();
	let held = perAddress.get(address);
	if (!held || nowMs - held.first >= CSP_REPORT_WINDOW_MS) {
		held = { count: 0, first: nowMs };
		perAddress.set(address, held);
	}
	held.count += 1;
	overall.count += 1;
	return held.count <= CSP_REPORT_IP_LIMIT && overall.count <= CSP_REPORT_GLOBAL_LIMIT;
}

/** what one report says, trimmed to what a log line needs */
export type CspReportEntry = {
	blockedUri: string;
	violatedDirective: string;
	documentPath: string;
	sample: string;
};

const FIELD_MAX = 200;
const SAMPLE_MAX = 80;

const text = (value: unknown, max: number) =>
	typeof value === 'string' ? value.replace(/[\r\n\0]/g, ' ').slice(0, max) : '';

/** a URL without its query and fragment, or the keyword (`inline`, `eval`) it already was */
function withoutQuery(value: unknown): string {
	const raw = text(value, 2048);
	const at = raw.search(/[?#]/);
	return (at < 0 ? raw : raw.slice(0, at)).slice(0, FIELD_MAX);
}

/** the path of a document URL: no origin, no query, no fragment */
function pathOf(value: unknown): string {
	const raw = text(value, 2048);
	try {
		return new URL(raw).pathname.slice(0, FIELD_MAX);
	} catch {
		return withoutQuery(raw);
	}
}

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The entries of a report body in either format, or an empty list for anything else.
 *
 * Legacy: `{"csp-report": {"blocked-uri", "violated-directive", "document-uri", "script-sample"}}`.
 * Reporting API: `[{"type": "csp-violation", "body": {"blockedURL", "effectiveDirective",
 * "documentURL", "sample"}}]`.
 */
export function parseCspReport(body: string): CspReportEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return [];
	}
	const entries: CspReportEntry[] = [];
	if (isObject(parsed) && isObject(parsed['csp-report'])) {
		const r = parsed['csp-report'];
		entries.push({
			blockedUri: withoutQuery(r['blocked-uri']),
			violatedDirective: text(r['violated-directive'] ?? r['effective-directive'], FIELD_MAX),
			documentPath: pathOf(r['document-uri']),
			sample: text(r['script-sample'], SAMPLE_MAX)
		});
	} else if (Array.isArray(parsed)) {
		for (const item of parsed.slice(0, CSP_REPORT_MAX_ENTRIES)) {
			if (!isObject(item) || item['type'] !== 'csp-violation' || !isObject(item['body'])) {
				continue;
			}
			const r = item['body'];
			entries.push({
				blockedUri: withoutQuery(r['blockedURL']),
				violatedDirective: text(
					r['effectiveDirective'] ?? r['violatedDirective'],
					FIELD_MAX
				),
				documentPath: pathOf(r['documentURL']),
				sample: text(r['sample'], SAMPLE_MAX)
			});
		}
	}
	return entries;
}

// #endregion
