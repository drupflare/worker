/**
 * What a visitor sees while the site is coming up.
 *
 * A cold object cannot render the first request, so it answers 503 "not yet". A browser gets an
 * HTML page with a meta refresh and everything else gets `warming\n`; both retry after the same
 * second.
 * @module
 */

import {
	WARMING_PAGE_CSS,
	WARMING_PAGE_HTML,
	WARMING_REFRESH_HTML
} from '../site/generated/assets';
import { renderTemplate } from '../util/template';

/** how the request wants to be answered, decided by Accept rather than by guessing */
export function wantsHtml(request: Request): boolean {
	const accept = request.headers.get('accept') ?? '';
	// a browser navigation sends `text/html` first; curl sends `*/*` and prefers a plain body
	// there than a screenful of markup
	return accept.includes('text/html');
}

/** what to answer with and how to word it */
export interface WarmingOptions {
	/** what the site is doing, in the visitor's words */
	stage: 'warming' | 'migrating';
	/** seconds until the page is worth asking for again; drives Retry-After AND the meta refresh */
	retryAfterSeconds?: number;
	/** extra response headers, which is where every `x-cfw-*` diagnostic already goes */
	headers?: Record<string, string>;
	/** the request, so the body matches what the caller can read */
	request?: Request;
}

/** the one-line explanation each stage gets, so a screenshot tells the two apart */
const STAGE_TEXT: Record<WarmingOptions['stage'], { title: string; detail: string }> = {
	warming: {
		title: 'Starting up',
		detail: 'The site is booting its PHP runtime. This happens once, and takes a few seconds.'
	},
	migrating: {
		title: 'Setting up',
		detail: 'The site is loading its database for the first time. This happens once.'
	}
};

/**
 * The HTML a browser gets.
 *
 * Inline everything and reference nothing: the site cannot render yet, so it could not answer an
 * asset request either.
 *
 * @param refresh - whether to auto-retry; false for a submission (see {@link warmingResponse})
 */
export function warmingHtml(
	stage: WarmingOptions['stage'],
	retrySeconds: number,
	refresh = true
): string {
	const { title, detail } = STAGE_TEXT[stage];
	return renderTemplate(WARMING_PAGE_HTML, {
		REFRESH: refresh
			? renderTemplate(WARMING_REFRESH_HTML, { SECONDS: `${retrySeconds}` })
			: '',
		TITLE: title,
		STYLE: WARMING_PAGE_CSS.trimEnd(),
		DETAIL: detail,
		NOTE: refresh
			? 'This page refreshes itself.'
			: 'Your submission was not accepted. Go back and send it again in a moment.'
	});
}

/**
 * Builds the "not yet" response: a 503 with a refreshing page for a browser and the one-word body
 * for everything else, diagnostic headers preserved.
 */
export function warmingResponse(opts: WarmingOptions): Response {
	const retry = Math.max(1, Math.round(opts.retryAfterSeconds ?? 1));
	const html = opts.request !== undefined && wantsHtml(opts.request);
	// a meta refresh is a GET, so on a submission it discards the body and lands on the cached
	// anonymous copy of the form; `Retry-After` still says when to come back
	const method = (opts.request?.method ?? 'GET').toUpperCase();
	const refresh = method === 'GET' || method === 'HEAD';
	return new Response(html ? warmingHtml(opts.stage, retry, refresh) : `${opts.stage}\n`, {
		status: 503,
		headers: {
			'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
			'retry-after': String(retry),
			'cache-control': 'no-store',
			...(opts.headers ?? {})
		}
	});
}
