import { isPaid, type PlanEnv, type ResolvedPlan } from '../ops/plan';
import {
	projectImageTransforms,
	thresholdReport,
	type ImagePlan,
	type MeterReading
} from '../ops/thresholds';

/**
 * | surface    | state                                                                        |
 * | ---------- | ---------------------------------------------------------------------------- |
 * | Thresholds | **live**: pure arithmetic over `src/ops/thresholds.ts`, nothing to wire       |
 * | Extend     | **live**: drives `/installable`, which is `catalog.ts` + `packagist.ts` + `oracle.ts` |
 * | Commands   | **partly**: lists what `/__ops` registers, and says which have NO driver      |
 * | Deploy     | **NOT wired**: no provisioning exists; the surface says so instead of lying   |
 *
 * A button that appears to deploy and does not is worse than no button, so the Deploy surface renders
 * the manifest a provisioner would need and refuses to pretend it has one.
 *
 * SECURITY, and this is not optional. These pages drive privileged machinery -- Commands proxies to
 * `/__ops`, which runs cache rebuilds and module installs. There is no administrator authentication
 * in this Worker, so every route that renders these MUST stay behind `PW_DIAGNOSTICS` until one
 * exists. An unauthenticated admin UI over `/__ops` is a remote shell, which is the exact defect
 * `src/site.ts` already had once and fixed.
 */

/** escapes text for HTML text nodes and quoted attributes alike */
export function escapeHtml(value: unknown): string {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** the four surfaces */
export type AdminPage = 'thresholds' | 'extend' | 'commands' | 'deploy';

/**
 * The prefix every product surface lives under.
 *
 * NOT `/admin`, which is Drupal core's own administration dashboard -- these pages used to sit on
 * it, so a site owner who reached for their admin UI got the hosting product's Limits page instead.
 * Every other admin route worked, because only the ones named here are claimed. The underscore is
 * the same reasoning the object's `__` routes already use: Drupal owns the URL space, so anything
 * this Worker claims has to be somewhere Drupal will not generate.
 */
export const SURFACE_PREFIX = '/_cfw';

/** every page, with the path that renders it */
export const ADMIN_PAGES: readonly { page: AdminPage; path: string; label: string }[] = [
	{ page: 'thresholds', path: SURFACE_PREFIX, label: 'Limits' },
	{ page: 'extend', path: `${SURFACE_PREFIX}/extend`, label: 'Extend' },
	{ page: 'commands', path: `${SURFACE_PREFIX}/commands`, label: 'Commands' },
	{ page: 'deploy', path: `${SURFACE_PREFIX}/deploy`, label: 'Deploy' }
] as const;

const STYLE = `:root{color-scheme:light dark;--fg:#111;--bg:#fff;--dim:#666;--line:#d8d8d8;--ok:#1a7f37;--warn:#9a6700;--over:#b42318;--card:#fafafa}
@media(prefers-color-scheme:dark){:root{--fg:#e8e8e8;--bg:#151515;--dim:#9a9a9a;--line:#333;--ok:#3fb950;--warn:#d29922;--over:#f85149;--card:#1d1d1d}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:60rem;margin:0 auto;padding:1.5rem}
nav{display:flex;gap:.25rem;flex-wrap:wrap;border-bottom:1px solid var(--line);padding:0 1.5rem}
nav a{padding:.6rem .9rem;text-decoration:none;color:var(--dim);border-bottom:2px solid transparent}
nav a[aria-current]{color:var(--fg);border-bottom-color:var(--fg);font-weight:600}
h1{font-size:1.3rem;margin:1.2rem 0 .3rem}h2{font-size:1.05rem;margin:1.6rem 0 .4rem}
p.sub{color:var(--dim);margin:.2rem 0 1rem}
table{width:100%;border-collapse:collapse;margin:.5rem 0 1rem;display:block;overflow-x:auto}
th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.03em;color:var(--dim);font-weight:600}
code{font:13px ui-monospace,monospace;background:var(--card);padding:.1rem .3rem;border-radius:3px}
.pill{display:inline-block;font-size:.75rem;font-weight:600;padding:.1rem .45rem;border-radius:999px;border:1px solid currentColor}
.ok{color:var(--ok)}.warn{color:var(--warn)}.over{color:var(--over)}.dim{color:var(--dim)}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:.9rem 1rem;margin:.6rem 0}
.card.bad{border-color:var(--over)}.card.warn{border-color:var(--warn)}
form{display:flex;gap:.5rem;flex-wrap:wrap;margin:.6rem 0}
input[type=text]{flex:1;min-width:16rem;padding:.5rem .6rem;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg);font:13px ui-monospace,monospace}
button{padding:.5rem .9rem;border:1px solid var(--line);border-radius:4px;background:var(--fg);color:var(--bg);font-weight:600;cursor:pointer}
button[disabled]{opacity:.5;cursor:not-allowed;background:var(--card);color:var(--dim)}
ul{margin:.3rem 0 .8rem 1.2rem;padding:0}li{margin:.2rem 0}`;

/**
 * Wraps a page body in the shell.
 *
 * @param page which nav item is current
 * @param body already-escaped HTML
 */
export function renderShell(page: AdminPage, body: string, env?: PlanEnv | null): string {
	const nav = ADMIN_PAGES.map(
		(p) =>
			`<a href="${escapeHtml(p.path)}"${p.page === page ? ' aria-current="page"' : ''}>${escapeHtml(p.label)}</a>`
	).join('');
	const plan = isPaid(env) ? 'paid' : 'free';
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(ADMIN_PAGES.find((p) => p.page === page)?.label ?? 'Admin')}</title>
<style>${STYLE}</style></head><body>
<nav>${nav}<a class="dim" style="margin-left:auto;border:0" href="${SURFACE_PREFIX}">plan: ${escapeHtml(plan)}</a></nav>
<main>${body}</main></body></html>`;
}

const pill = (status: string) => {
	const cls =
		status === 'over' ? 'over' : status === 'warn' ? 'warn' : status === 'ok' ? 'ok' : 'dim';
	return `<span class="pill ${cls}">${escapeHtml(status)}</span>`;
};

// #region Limits -- live, pure arithmetic

/**
 * The per-plan thresholds, with their costs and their failure modes.
 *
 * The failure-mode column matters. A limit that bills is an invoice; a limit that stops working
 * is an outage, and the image cap is the second kind. Surfacing them in one table with the same
 * columns is what makes the difference visible instead of buried.
 */
export function renderThresholds(
	used: Partial<Record<string, number>>,
	imagePlan: ImagePlan | null,
	env?: PlanEnv | null,
	resolved?: ResolvedPlan | null
): string {
	const report = thresholdReport(used, env);
	const rows = report.readings.map((r: MeterReading) => {
		const limit =
			r.limit === null
				? 'not metered'
				: `${r.limit.toLocaleString()} / ${r.threshold.period}`;
		const failure =
			r.threshold.failure === 'hard-cap'
				? '<span class="over">stops working</span>'
				: r.threshold.failure === 'billed'
					? '<span class="warn">costs money</span>'
					: '<span class="dim">refused, site stays up</span>';
		return `<tr><td><strong>${escapeHtml(r.threshold.label)}</strong><br><span class="dim">${escapeHtml(r.threshold.spentBy)}</span></td>
<td>${escapeHtml(limit)}</td><td>${failure}</td><td>${pill(r.status)}<br><span class="dim">${escapeHtml(r.message)}</span></td></tr>`;
	});

	let images = '';
	if (imagePlan) {
		const p = projectImageTransforms(imagePlan, env);
		const cls = p.status === 'over' ? 'card bad' : p.status === 'warn' ? 'card warn' : 'card';
		const remedies = p.remedies.length
			? `<ul>${p.remedies.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
			: '';
		images = `<h2>Image transformations, projected</h2>
<p class="sub">${escapeHtml(imagePlan.images.toLocaleString())} images x ${escapeHtml(String(imagePlan.styles))} styles. A unique is one image plus one parameter set, so this is a function of your CONTENT rather than your traffic -- which is why it can be answered before it bites.</p>
<div class="${cls}"><p>${pill(p.status)} ${escapeHtml(p.message)}</p>${remedies}</div>`;
	} else {
		images = `<h2>Image transformations, projected</h2>
<p class="sub">Add <code>?images=2000&amp;styles=10</code> to project your own configuration against the monthly cap.</p>`;
	}

	return `<h1>Limits</h1>
${
	resolved
		? `<p class="sub">Plan <strong>${escapeHtml(resolved.plan)}</strong>, from ${escapeHtml(
				resolved.source === 'kv'
					? 'the CONFIG_KV override'
					: resolved.source === 'var'
						? 'the deployed PLAN var'
						: 'nothing set, so the free default'
			)}. Set the <code>plan</code> key in CONFIG_KV to change it without a redeploy.</p>`
		: ''
}<p class="sub">Every meter this site can run out of, what spends it, and what happens when it does. ${escapeHtml(String(report.hardCapCount))} of these stops working rather than billing.</p>
<table><thead><tr><th>Meter</th><th>Allowance</th><th>When it runs out</th><th>Now</th></tr></thead><tbody>${rows.join('')}</tbody></table>
${images}
<p class="sub">Anything marked <em>nothing measures this yet</em> has no counter wired to it. That is reported rather than shown as healthy, because an unmeasured meter reading zero is the failure this column exists to prevent.</p>`;
}
// #endregion

// #region Extend -- live over /installable

/** one row in the installable list */
export type ExtendEntry = {
	name: string;
	version?: string | null;
	verdict?: 'installable' | 'blocked' | 'unverifiable' | 'not-found' | null;
	reason?: string | null;
};

/**
 * The Extend page: a `composer require`-shaped field over the machinery that already exists.
 *
 * The field takes a package name because that is what a Drupal user already knows how to type, and it
 * resolves through `/installable` -- `packagist.ts` for versions, `composer-constraint.ts` for the
 * requirement check, `oracle.ts` for the cached verdict.
 */
export function renderExtend(
	query: string | null,
	entries: readonly ExtendEntry[],
	note: string | null,
	env?: PlanEnv | null
): string {
	const rows = entries.length
		? entries
				.map(
					(e) =>
						`<tr><td><code>${escapeHtml(e.name)}</code></td><td>${escapeHtml(e.version ?? '-')}</td>
<td>${pill(e.verdict === 'installable' ? 'ok' : e.verdict === 'blocked' || e.verdict === 'not-found' ? 'over' : 'warn')} ${escapeHtml(e.verdict ?? 'unknown')}</td>
<td><span class="dim">${escapeHtml(e.reason ?? '')}</span></td></tr>`
				)
				.join('')
		: `<tr><td colspan="4" class="dim">Nothing checked yet.</td></tr>`;

	const install = isPaid(env)
		? ''
		: `<div class="card warn"><p><strong>Installing spends the serving ceiling.</strong> A module install runs as a Workflow, and a Workflow invocation is billed against the same 100,000/day quota as a visitor request. On free that is 1,024 steps per instance, so one install is bounded rather than free.</p></div>`;

	return `<h1>Extend</h1>
<p class="sub">Check whether a module can be installed here before trying. Type a package name the way you would to Composer.</p>
<form method="GET" action="${SURFACE_PREFIX}/extend">
<input type="text" name="q" placeholder="drupal/pathauto" value="${escapeHtml(query ?? '')}" spellcheck="false">
<button type="submit">Check</button></form>
${note ? `<div class="card"><p>${escapeHtml(note)}</p></div>` : ''}
${install}
<table><thead><tr><th>Package</th><th>Newest</th><th>Verdict</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table>
<p class="sub"><code>drupal/*</code> resolves against <code>packages.drupal.org/8</code>, not <code>repo.packagist.org</code> -- the latter 404s for every Drupal package, which made this answer <em>not-found</em> for the whole ecosystem until it was fixed.</p>
<p class="sub">A verdict of <em>unverifiable</em> means the requirement could not be read, not that the module is broken. It is reported separately from <em>blocked</em> on purpose.</p>`;
}
// #endregion

// #region Commands -- partly wired, and says which parts are not

/**
 * One operation `/__ops` knows about.
 *
 * `driver` is null where nothing can run it yet. Without that field a command list renders `cex`
 * and `cim` the same as `cr`, implying three working commands where there is one.
 */
export type OpsEntry = { op: string; label: string; driver: string | null; cost?: string | null };

/**
 * A Drush-shaped command field over `/__ops`.
 *
 * The operations are the ones the object registers. Anything with a null driver is rendered
 * DISABLED and says why, rather than being offered and failing.
 */
export function renderCommands(
	entries: readonly OpsEntry[],
	result: string | null,
	submitted: string | null
): string {
	const rows = entries
		.map(
			(e) =>
				`<tr><td><code>drush ${escapeHtml(e.op)}</code></td><td>${escapeHtml(e.label)}</td>
<td>${e.driver ? `${pill('ok')} <span class="dim">${escapeHtml(e.driver)}</span>` : `${pill('none')} <span class="over">no driver exists yet</span>`}</td>
<td><span class="dim">${escapeHtml(e.cost ?? '')}</span></td></tr>`
		)
		.join('');
	const runnable = entries.filter((e) => e.driver !== null).length;

	return `<h1>Commands</h1>
<p class="sub">A Drush-shaped field over the operations this site registers. ${escapeHtml(String(runnable))} of ${escapeHtml(String(entries.length))} have a driver that can actually run here.</p>
<form method="GET" action="${SURFACE_PREFIX}/commands">
<input type="text" name="op" placeholder="cr" value="${escapeHtml(submitted ?? '')}" spellcheck="false">
<button type="submit">Run</button></form>
${result ? `<div class="card"><pre style="margin:0;overflow-x:auto"><code>${escapeHtml(result)}</code></pre></div>` : ''}
<table><thead><tr><th>Command</th><th>What it does</th><th>Driver</th><th>Measured cost</th></tr></thead><tbody>${rows}</tbody></table>
<p class="sub">An operation with no driver is listed rather than hidden, and disabled rather than offered. A 501 with no named alternative is a 501 that gets retried.</p>`;
}
// #endregion

// #region Deploy -- NOT wired, and says so instead of pretending

/** what a provisioner would have to create; rendered as a checklist rather than executed */
export type ProvisionStep = { id: string; label: string; detail: string; automatable: boolean };

/**
 * The steps a one-click deploy would have to perform.
 *
 * Derived from what the shipped `wrangler.jsonc` actually binds, so the list is the real
 * requirement set rather than a guess at one.
 */
export const PROVISION_STEPS: readonly ProvisionStep[] = [
	{
		id: 'worker',
		label: 'Upload the Worker',
		detail: 'the bundle plus the wasm interpreter, which must be a module-scope import because workerd blocks request-time wasm codegen',
		automatable: true
	},
	{
		id: 'do-namespace',
		label: 'Create the Durable Object namespace',
		detail: 'one SQLite-backed class; a fresh namespace needs ~60 s of propagation before stub.fetch() stops answering "Worker not found"',
		automatable: true
	},
	{
		id: 'assets',
		label: 'Upload the packed site',
		detail: 'the per-file pack and the trimmed database; the full assets tree does not upload in one go',
		automatable: true
	},
	{
		id: 'cron',
		label: 'Register the warm-window cron trigger',
		detail: 'the fill window is what amortises one boot across a queue drain, and it costs no visitor request',
		automatable: true
	},
	{
		id: 'token',
		label: 'Obtain an API token',
		detail: 'needs Workers Scripts:Edit and Durable Objects:Edit on the target account, which only the account owner can mint',
		automatable: false
	},
	{
		id: 'admin-auth',
		label: 'Set an administrator credential',
		detail: 'these admin pages drive /__ops, so they cannot be public without one; today they are gated behind PW_DIAGNOSTICS instead',
		automatable: false
	}
];

/**
 * The Deploy surface.
 *
 * Renders the requirement rather than a button that lies. No provisioning mechanism exists in this
 * repository -- there is no API-token flow, no account picker and no `versions.create` call -- so a
 * button labelled Deploy would be the worst thing on this page. What it shows instead is the exact
 * step list a provisioner has to perform, which two of the steps cannot be automated, and the command
 * that does work today.
 */
/** shown so an operator can copy it into their OAuth client's redirect list */
export const CFW_CALLBACK_PATH = 'https://<your-site>/setup/cf/callback';

export function renderDeploy(): string {
	const rows = PROVISION_STEPS.map(
		(s) =>
			`<tr><td><strong>${escapeHtml(s.label)}</strong></td><td><span class="dim">${escapeHtml(s.detail)}</span></td>
<td>${s.automatable ? `${pill('ok')} scriptable` : `${pill('warn')} needs a human`}</td></tr>`
	).join('');

	return `<h1>Deploy</h1>
<div class="card bad"><p><strong>There is no one-click deploy yet, and this page will not pretend otherwise.</strong>
No provisioning exists in this repository: no account picker and no namespace creation. A button here that appeared to work would be worse than no button, so what follows is the requirement a provisioner has to satisfy. Credentials are the one step that is now covered, below.</p></div>
<h2>Connect a Cloudflare Account</h2>
<p class="sub">Two ways in. Pasting an account ID and API token still works and needs no setup. OAuth issues a short-lived scoped grant instead, revocable from your Cloudflare dashboard, and drupflare never stores a long-lived secret.</p>
<div class="card"><p><strong>OAuth needs a client you register once.</strong> Cloudflare registers a redirect URI against the client, and every drupflare deployment answers on a different origin, so there is no shared client that could work for all of them. In your dashboard go to <em>Manage account &rsaquo; OAuth clients</em>, create one with <strong>private</strong> visibility, and register this callback:</p>
<pre style="margin:0;overflow-x:auto"><code>${escapeHtml(CFW_CALLBACK_PATH)}</code></pre>
<p class="sub">Private visibility is enough: you are a member of the account you are authorising. Then paste the client ID here. The client ID is not a secret, but it is stored in this site's own database rather than in KV, because a KV writer who could change it could point the consent screen at an application they control.</p>
<form id="cfoauth"><label>Client ID<input name="client_id" autocomplete="off" spellcheck="false"></label>
<button type="submit">Connect With Cloudflare</button></form>
<p id="cfoauth-out" class="sub"></p></div>
<script>
document.getElementById('cfoauth').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = document.getElementById('cfoauth-out');
  const id = new FormData(e.target).get('client_id');
  if (!id) { out.textContent = 'Enter the client ID from your OAuth client.'; return; }
  const token = window.prompt('Owner token for this site');
  if (!token) return;
  out.textContent = 'Starting...';
  try {
    const res = await fetch('/setup/cf?action=connect&client_id=' + encodeURIComponent(id), {
      headers: { authorization: 'Bearer ' + token }
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'refused');
    window.location.href = data.authorizeUrl;
  } catch (err) {
    out.textContent = 'Could not start: ' + err.message;
  }
});
</script>
<h2>What deploying actually involves</h2>
<table><thead><tr><th>Step</th><th>Detail</th><th>Can it be scripted?</th></tr></thead><tbody>${rows}</tbody></table>
<h2>What works today</h2>
<p class="sub">From a checkout, with wrangler authenticated against your own account:</p>
<div class="card"><pre style="margin:0;overflow-x:auto"><code>bun run deploy</code></pre></div>
<p class="sub">That is the tax this page exists to remove: it needs a terminal, a checkout, and an account already configured. Until the two <em>needs a human</em> steps above have a flow, the button stays absent.</p>`;
}
// #endregion
