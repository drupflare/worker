import {
	DEFAULT_MAX_BODY_BYTES,
	DEFAULT_MAX_FILE_PUT_BYTES,
	DEFAULT_MAX_RESTORE_BYTES,
	DEFAULT_MAX_UPLOAD_BYTES,
	RESTORE_PART_MAX_BYTES
} from '../ops/body-limit';
import type { Cms } from '../util/cms';
import { renderTemplate } from '../util/template';
import { GUARDS_OBJECT_RESET_HTML, GUARDS_OBJECT_RESET_UNSAVED_HTML } from './generated/assets';

/** one deny pattern and why the path can never be a route */
type Deny = { re: RegExp; why: string };

/** what one CMS refuses beyond the common list, and the only php urls it serves */
type CmsGuards = { deny: readonly Deny[]; php: readonly RegExp[] };

const NEVER_COMMON: readonly Deny[] = [
	{
		re: /\.(?:env|git|sql|bak|old|swp|ini|log|sh|yml~|zip|tar|gz|tgz|rar|7z)$/i,
		why: 'secrets, dumps and archives'
	},
	{ re: /(?:^|\/)\.(?:git|env|aws|ssh|svn|hg|DS_Store)(?:\/|$)/i, why: 'dotfiles and vcs state' },
	{
		re: /(?:^|\/)(?:phpmyadmin|pma|adminer|vendor\/phpunit|\.well-known\/security\.txt\.bak)/i,
		why: 'database tools and test harnesses'
	},
	{
		re: /(?:^|\/)(?:config|backup|dump|db)\.(?:json|xml|txt)$/i,
		why: 'exported settings and dumps'
	}
];

/**
 * Paths each CMS can never serve, refused in JS before any DO hop.
 *
 * `PageCache` writes one permanent `cache_data` row (~215 B) per distinct URL, so scanner probes
 * would grow storage without bound. A deny list, not the router's table: aliases are created at
 * runtime, so only patterns with no route under any configuration are safe to refuse here. Every
 * `.php` url is refused except those in `php`, which is empty for Drupal because its entry point is
 * `/index.php`, which never reaches here as a route.
 */
const NEVER_BY_CMS: Record<Cms, CmsGuards> = {
	drupal: {
		deny: [
			{ re: /(?:^|\/)wp-(?:admin|login|content|includes|config)/i, why: 'wordpress paths' }
		],
		php: []
	},
	wordpress: {
		deny: [
			{ re: /(?:^|\/)wp-config/i, why: 'holds the database credentials and salts' },
			{ re: /(?:^|\/)xmlrpc\.php/i, why: 'pingback and brute force amplifier; not served' },
			{ re: /^\/(?:readme\.html|license\.txt)$/i, why: 'prints the WordPress version' },
			{ re: /(?:^|\/)\.(?:htaccess|htpasswd|user\.ini)$/i, why: 'web server configuration' },
			{
				re: /^\/wp-admin\/(?:install|setup-config|upgrade)\.php$/i,
				why: 'installation and schema upgrade are host-driven'
			}
		],
		php: [
			/^\/(?:index|wp-login|wp-cron|wp-comments-post)\.php$/i,
			// one level only, so wp-admin/includes/*.php stays refused
			/^\/wp-admin\/[\w-]+\.php$/i
		]
	},
	joomla: { deny: [], php: [/^\/(?:administrator\/|api\/)?index\.php$/i] }
};

const PHP_URL = /\.php$/i;

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
 *
 * A GET that writes (`writes`, see {@link writesOnGet}) is treated as a POST: it is retried only
 * with an attempt id, and a GET never has one, so it is not retried.
 */
export function resetRecovery(
	e: unknown,
	method: string,
	attempted = false,
	writes = false
): 'retry' | 'refuse' {
	const err = e as {
		retryable?: unknown;
		overloaded?: unknown;
		durableObjectReset?: unknown;
	} | null;
	const reset = err?.durableObjectReset === true;
	if (!reset && (err?.retryable !== true || err.overloaded === true)) return 'refuse';
	const safe = (method === 'GET' || method === 'HEAD') && !writes;
	return safe || attempted ? 'retry' : 'refuse';
}

/**
 * The GET routes that change state: they run cron, so a repeat after a reset whose first try
 * committed runs every hook twice. Drupal's `system.run_cron` and `system.cron`
 * (`system.routing.yml`) take no method restriction, and WordPress runs cron from `wp-cron.php`.
 */
const WRITING_GETS: readonly RegExp[] = [
	/^\/admin\/reports\/status\/run-cron\/?$/,
	/^\/cron\/[^/]+\/?$/,
	/^\/wp-cron\.php$/i
];

/** whether a GET to `pathname` writes, so the front worker must not retry it on its own */
export function writesOnGet(pathname: string): boolean {
	return WRITING_GETS.some((route) => route.test(pathname));
}

/** a short page with a retry hint, in place of the platform's 1101 */
export function objectResetPage(method: string, writes = false): Response {
	const saved =
		(method === 'GET' || method === 'HEAD') && !writes
			? ''
			: GUARDS_OBJECT_RESET_UNSAVED_HTML.trimEnd();
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
export type BodyLimitEnv = {
	MAX_BODY_BYTES?: string | number;
	MAX_UPLOAD_BYTES?: string | number;
	MAX_RESTORE_BYTES?: string | number;
	MAX_FILE_PUT_BYTES?: string | number;
};

/**
 * The ceiling that applies to a request, or 0 for none: a form body has `MAX_BODY_BYTES`, an
 * upload (`multipart/form-data`) has its own `MAX_UPLOAD_BYTES`, a `/restore` dump has
 * `MAX_RESTORE_BYTES`, and `0` disables any of them.
 */
export function bodyLimitFor(request: Request, env?: BodyLimitEnv): number {
	// a restore part has a fixed size, so no variable lowers or lifts it
	if (new URL(request.url).pathname === '/restore-parts') return RESTORE_PART_MAX_BYTES;
	// a registered file streams to R2 and is never held, so it has its own ceiling
	if (new URL(request.url).pathname === '/file') {
		const raw = Number(env?.MAX_FILE_PUT_BYTES ?? DEFAULT_MAX_FILE_PUT_BYTES);
		return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_MAX_FILE_PUT_BYTES;
	}
	const upload = (request.headers.get('content-type') ?? '')
		.toLowerCase()
		.includes('multipart/form-data');
	const restore = new URL(request.url).pathname === '/restore';
	const [value, fallback] = upload
		? [env?.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES]
		: restore
			? [env?.MAX_RESTORE_BYTES, DEFAULT_MAX_RESTORE_BYTES]
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
 * True when the path cannot be a route of the CMS under any configuration.
 *
 * The query string is stripped first: four patterns are `$`-anchored and the caller passes
 * `pathname + search`, so `/.env?x=1` would otherwise slip through to the object. Drupal when no CMS
 * is given, because the worker has no runtime CMS value yet; a name the table lacks refuses all.
 */
export function isNeverDrupal(pathname: string, cms: Cms = 'drupal'): boolean {
	const guards = NEVER_BY_CMS[cms];
	if (guards === undefined) return true;
	const bare = pathname.split(/[?#]/, 1)[0] ?? pathname;
	if (NEVER_COMMON.some(({ re }) => re.test(bare))) return true;
	if (guards.deny.some(({ re }) => re.test(bare))) return true;
	return PHP_URL.test(bare) && !guards.php.some((re) => re.test(bare));
}
