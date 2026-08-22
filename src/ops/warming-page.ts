/**
 * What a visitor sees while the site is coming up.
 *
 * A cold Durable Object cannot answer the first request with the page: the interpreter is not booted
 * and a render is a synchronous call into wasm that no invocation budget can hold. It answers "not
 * yet" instead, and until now that answer was the six bytes `warming\n` as `text/plain` -- which a
 * browser renders as the word "warming" on a white page, with no indication that anything is
 * happening or that reloading would help.
 *
 * The HTML carries `<meta http-equiv="refresh">`, so the visitor lands on the real page without
 * touching anything. That is what makes the first visit to a fresh site work rather than merely
 * explain itself: the retry a bot does through `Retry-After`, a human does through the meta refresh,
 * and both point at the same second.
 */

/** how the request wants to be answered, decided by Accept rather than by guessing */
export function wantsHtml(request: Request): boolean {
	const accept = request.headers.get('accept') ?? '';
	// a browser navigation sends `text/html` first; curl sends `*/*`, and a plain body is friendlier
	// there than a screenful of markup
	return accept.includes('text/html');
}

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

/** the one-line explanation each stage gets, so the two cases are distinguishable in a screenshot */
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
 * Inline everything and reference nothing. This page is served BEFORE the site can render, so a
 * stylesheet or an image would be a request the object cannot answer either -- and a broken asset on
 * the "please wait" page is a worse first impression than no styling at all.
 *
 * @param refresh - whether to auto-retry. FALSE for a submission: see {@link warmingResponse}.
 */
export function warmingHtml(
	stage: WarmingOptions['stage'],
	retrySeconds: number,
	refresh = true
): string {
	const { title, detail } = STAGE_TEXT[stage];
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${retrySeconds}">\n` : ''}<meta name="robots" content="noindex">
<title>${title}...</title>
<style>
:root { color-scheme: light dark }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif }
main { max-width: 28rem; padding: 2rem; text-align: center }
h1 { font-size: 1.25rem; margin: 0 0 .5rem }
p { margin: 0; opacity: .75 }
.dot { display: inline-block; width: .5rem; height: .5rem; margin-right: .5rem;
  border-radius: 50%; background: currentColor; animation: pulse 1.2s ease-in-out infinite }
@keyframes pulse { 0%, 100% { opacity: .25 } 50% { opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; opacity: .6 } }
</style>
</head>
<body>
<main>
<h1><span class="dot"></span>${title}...</h1>
<p>${detail}</p>
<p><small>${
		refresh
			? 'This page refreshes itself.'
			: 'Your submission was not accepted. Go back and send it again in a moment.'
	}</small></p>
</main>
</body>
</html>
`;
}

/**
 * Builds the "not yet" response.
 *
 * @returns a 503 carrying an auto-refreshing page for a browser, and the original one-word body for
 *   everything else, with every diagnostic header preserved.
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
