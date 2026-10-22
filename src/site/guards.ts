import { DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_UPLOAD_BYTES } from '../ops/body-limit';
import { renderTemplate } from '../util/template';
import { GUARDS_OBJECT_RESET_HTML, GUARDS_OBJECT_RESET_UNSAVED_HTML } from './generated/assets';

/**
 * Paths Drupal can never serve, refused in JS before any DO hop.
 *
 * `PageCache` writes one permanent `cache_data` row (~215 B) per distinct URL, so scanner probes
 * would grow storage without bound. A deny list, not the router's table: aliases are created at
 * runtime, so only patterns with no route under any configuration are safe to refuse here.
 */
const NEVER_DRUPAL = [
	/\.(?:env|git|sql|bak|old|swp|ini|log|sh|yml~|zip|tar|gz|tgz|rar|7z)$/i,
	/(?:^|\/)\.(?:git|env|aws|ssh|svn|hg|DS_Store)(?:\/|$)/i,
	/(?:^|\/)wp-(?:admin|login|content|includes|config)/i,
	/\.php$/i, // Drupal's own entry point is /index.php, which never reaches here as a route
	/(?:^|\/)(?:phpmyadmin|pma|adminer|vendor\/phpunit|\.well-known\/security\.txt\.bak)/i,
	/(?:^|\/)(?:config|backup|dump|db)\.(?:json|xml|txt)$/i
];

/** what the body guard decided, when the request may not proceed */
export interface BodyTooLarge {
	limit: number;
	declared: number;
	reason: string;
}

/**
 * What to do when the hop to the object threw instead of answering.
 *
 * A safe method is retried once on a fresh stub; an unsafe one only with an attempt id (the object
 * refuses the repeat if the first try started). An `overloaded` object is not retried unless it was
 * reset: a memory reset arrives as `overloaded` plus `durableObjectReset` with no `retryable`
 * (deployed probe, n=8).
 */
export function resetRecovery(e: unknown, method: string, attempted = false): 'retry' | 'refuse' {
	const err = e as {
		retryable?: unknown;
		overloaded?: unknown;
		durableObjectReset?: unknown;
	} | null;
	const reset = err?.durableObjectReset === true;
	if (!reset && (err?.retryable !== true || err.overloaded === true)) return 'refuse';
	return method === 'GET' || method === 'HEAD' || attempted ? 'retry' : 'refuse';
}

/** a short page with a retry hint, in place of the platform's 1101 */
export function objectResetPage(method: string): Response {
	const saved =
		method === 'GET' || method === 'HEAD' ? '' : GUARDS_OBJECT_RESET_UNSAVED_HTML.trimEnd();
	return new Response(renderTemplate(GUARDS_OBJECT_RESET_HTML, { SAVED: saved }), {
		status: 503,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'retry-after': '2',
			'cache-control': 'no-store',
			'x-cfw-object-reset': '1'
		}
	});
}

/** the env vars the body ceilings read */
export type BodyLimitEnv = { MAX_BODY_BYTES?: string | number; MAX_UPLOAD_BYTES?: string | number };

/**
 * The ceiling that applies to a request, or 0 for none: a form body has `MAX_BODY_BYTES`, an
 * upload (`multipart/form-data`) has its own `MAX_UPLOAD_BYTES`, and `0` disables either.
 */
export function bodyLimitFor(request: Request, env?: BodyLimitEnv): number {
	const upload = (request.headers.get('content-type') ?? '')
		.toLowerCase()
		.includes('multipart/form-data');
	const [value, fallback] = upload
		? [env?.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES]
		: [env?.MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES];
	const raw = Number(value ?? fallback);
	return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/**
 * Whether a request body is too large to hand to PHP, by what it declares.
 *
 * Reads `Content-Length`, which the platform holds the body to; a chunked request declares none and
 * is measured while it is read ({@link readBounded}). A form body is capped by `MAX_BODY_BYTES` and
 * an upload by `MAX_UPLOAD_BYTES`.
 *
 * @param env - `0` for either limit disables that guard entirely
 */
export function bodyTooLarge(request: Request, env?: BodyLimitEnv): BodyTooLarge | undefined {
	const method = request.method.toUpperCase();
	if (method === 'GET' || method === 'HEAD') return undefined;

	const limit = bodyLimitFor(request, env);
	if (limit === 0) return undefined;

	const declared = Number(request.headers.get('content-length') ?? '');
	if (!Number.isFinite(declared) || declared <= limit) return undefined;

	return {
		limit,
		declared,
		reason: `request body of ${declared} bytes exceeds the ${limit} byte limit`
	};
}

/** thrown when a body runs past its ceiling while it is being read */
export class BodyLimitExceeded extends Error {
	constructor(
		readonly limit: number,
		readonly read: number
	) {
		super(`request body of at least ${read} bytes exceeds the ${limit} byte limit`);
	}
}

/**
 * Reads a body whole, counting as it arrives, and stops at the first chunk that crosses `limit`.
 * The rest of the stream is cancelled unread, so a chunked or multipart body with no (or a false)
 * length is bounded by what was actually received. `0` means no ceiling.
 */
export async function readBounded(request: Request, limit: number): Promise<ArrayBuffer> {
	if (limit === 0 || request.body === null) return request.arrayBuffer();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw new BodyLimitExceeded(limit, total);
		}
		chunks.push(value);
	}
	const whole = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		whole.set(chunk, at);
		at += chunk.byteLength;
	}
	return whole.buffer;
}

/**
 * Where a core PHP entry point sends a visitor instead of a bare 404.
 *
 * Core's admin UI links to `/update.php`, which the `\.php$` deny would 404. Redirect, not rewrite:
 * installation is provisioning and the update chain is host-driven. Only paths core links are
 * listed; any other `.php` keeps the cheap deny.
 */
const PHP_ENTRY_REDIRECTS: Record<string, string> = {
	'/update.php': '/admin/config/drupflare/status',
	'/core/update.php': '/admin/config/drupflare/status',
	'/install.php': '/',
	'/core/install.php': '/',
	// cron is driven by the alarm chain on a schedule, so there is nothing for a visitor to trigger
	'/cron.php': '/admin/config/drupflare/status',
	'/core/cron.php': '/admin/config/drupflare/status'
};

/** the redirect target for a core entry point, or undefined when the path is an ordinary deny */
export function phpEntryRedirect(pathname: string): string | undefined {
	return PHP_ENTRY_REDIRECTS[pathname.toLowerCase()];
}

/**
 * True when the path cannot be a Drupal route under any configuration.
 *
 * The query string is stripped first: four patterns are `$`-anchored and the caller passes
 * `pathname + search`, so `/.env?x=1` would otherwise slip through to the object.
 */
export function isNeverDrupal(pathname: string): boolean {
	const bare = pathname.split(/[?#]/, 1)[0] ?? pathname;
	return NEVER_DRUPAL.some((re) => re.test(bare));
}
