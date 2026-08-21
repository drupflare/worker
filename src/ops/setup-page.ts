/**
 * What a site that nobody has claimed yet serves instead of its front page.
 *
 * The pack ships an INSTALLED database, so Drupal's `install.php` never runs and never asks anyone
 * to choose a password. `/firstrun` is what does that, and until it has, uid 1 carries an empty hash
 * that `password_verify()` rejects for every input -- so a freshly deployed site looks finished,
 * serves its front page, and has no way in. The only thing that said otherwise was a caveat in the
 * README.
 *
 * Worse than a documentation gap: the claim window is exactly the unprovisioned state, so a site
 * that looks finished and is not claimed is a site anyone who finds the URL can claim. Showing the
 * owner a page that says "claim this now" is what closes that window, rather than explaining it.
 *
 * Same shape as {@link ../ops/warming-page.ts}: inline everything, reference nothing. This page is
 * served in place of the site, so a stylesheet or an image would be a request that returns the
 * setup page too.
 */

import { wantsHtml } from './warming-page.js';

/** the `cfw_meta` key `/firstrun` stamps once a site has been configured */
export const FIRST_RUN_KEY = 'first_run_at';

/**
 * Whether this request should be answered with the setup page.
 *
 * HTML navigations only, and only reads. A `curl`, an asset fetch and a POST all fall through to
 * the normal path -- the page is a signpost for a human, and turning it into a site-wide block
 * would break every non-browser client for a state that is meant to last minutes.
 *
 * @param configured - whether `first_run_at` is set; a configured site never sees this page
 */
export function needsSetup(request: Request, configured: boolean): boolean {
	if (configured) return false;
	const method = request.method.toUpperCase();
	if (method !== 'GET' && method !== 'HEAD') return false;
	return wantsHtml(request);
}

/**
 * The page itself.
 *
 * The button is the whole point -- one POST, the credentials come back, and the site is claimed. It
 * is `fetch()` rather than a plain form because `/firstrun` takes a JSON body, and the curl command
 * is printed underneath so the page still works with scripting off.
 */
export function setupHtml(origin: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Set Up This Site</title>
<style>
:root { color-scheme: light dark }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif }
main { max-width: 34rem; padding: 2rem }
h1 { font-size: 1.4rem; margin: 0 0 .5rem }
p { margin: 0 0 1rem; opacity: .8 }
label { display: block; margin: 0 0 .75rem; font-size: .9rem }
input { display: block; width: 100%; box-sizing: border-box; margin-top: .25rem;
  padding: .5rem; font: inherit; border: 1px solid currentColor; border-radius: .25rem;
  background: transparent; color: inherit }
button { padding: .6rem 1.2rem; font: inherit; font-weight: 600; cursor: pointer;
  border: 1px solid currentColor; border-radius: .25rem; background: transparent; color: inherit }
button[disabled] { opacity: .5; cursor: progress }
pre { overflow-x: auto; padding: .75rem; border-radius: .25rem; font-size: .8rem;
  background: rgba(127,127,127,.15) }
.out:empty { display: none }
.warn { font-size: .85rem; opacity: .7 }
</style>
</head>
<body>
<main>
<h1>Set Up This Site</h1>
<p>Drupal is installed and serving, but nobody has claimed it yet. Claiming it sets the
administrator password and issues the owner token. Until then, anyone who reaches this URL can
claim it.</p>
<form id="f">
<label>Site Name<input name="siteName" value="My Site" autocomplete="off"></label>
<label>Administrator Email<input name="adminMail" type="email" autocomplete="off"></label>
<label>Administrator Password <span class="warn">(leave blank and one is generated)</span>
<input name="adminPass" type="password" autocomplete="new-password"></label>
<button type="submit">Claim This Site</button>
</form>
<div class="out" id="o"></div>
<p class="warn">Or from a terminal:</p>
<pre>curl -X POST "${origin}/firstrun" \\
  -H 'content-type: application/json' \\
  -d '{"siteName":"My Site","adminMail":"you@example.com"}'</pre>
</main>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const button = form.querySelector('button');
  const out = document.getElementById('o');
  const body = {};
  for (const [k, v] of new FormData(form)) if (v) body[k] = v;
  button.disabled = true;
  out.textContent = 'Claiming...';
  try {
    const res = await fetch('/firstrun', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'refused');
    const lines = ['Claimed. Store these now, they are shown once.'];
    if (data.adminPass) lines.push('admin password: ' + data.adminPass);
    if (data.ownerToken) lines.push('owner token: ' + data.ownerToken);
    lines.push('Log in at /user/login as admin.');
    out.innerHTML = '<pre></pre>';
    out.firstChild.textContent = lines.join('\\n');
  } catch (err) {
    button.disabled = false;
    out.textContent = 'Could not claim this site: ' + err.message;
  }
});
</script>
</body>
</html>
`;
}

/**
 * The response.
 *
 * 200 rather than 503: the site is not broken and not starting up, it is waiting for its owner, and
 * a 503 would tell a monitor the deploy failed. Never stored anywhere, by anyone -- the page stops
 * being correct the moment somebody claims the site.
 */
export function setupResponse(origin: string, headers: Record<string, string> = {}): Response {
	return new Response(setupHtml(origin), {
		status: 200,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'x-robots-tag': 'noindex',
			'x-cfw-setup': 'required',
			...headers
		}
	});
}
