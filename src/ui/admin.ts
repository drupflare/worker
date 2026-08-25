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
/** what a typed command resolved to, or why it did not resolve */
export type DrushCommand =
	| { kind: 'run'; route: string; params: Record<string, string> }
	| { kind: 'error'; message: string };

/**
 * Every Drush spelling, mapped to the operation this site registers.
 *
 * Mirrors `CommandLine::DRUSH_ALIASES` in the sibling module, and
 * `tests/node/drush-aliases.spec.ts` reads that file and fails on any divergence. `/__ops` looks its
 * operations up by exact name and does not canonicalise, so `cache:rebuild` typed here reached it
 * verbatim and came back `unknown operation`.
 */
export const DRUSH_ALIASES: Readonly<Record<string, string>> = {
	cr: 'cr',
	'cache:rebuild': 'cr',
	'cache-rebuild': 'cr',
	rebuild: 'cr',
	cc: 'cr',
	'cache:clear': 'cr',
	updb: 'updb',
	updatedb: 'updb',
	'updatedb:status': 'updb',
	cex: 'cex',
	'config:export': 'cex',
	'config-export': 'cex',
	cim: 'cim',
	'config:import': 'cim',
	'config-import': 'cim',
	en: 'en',
	'pm:install': 'en',
	'pm-enable': 'en',
	'pm:enable': 'en',
	'theme:enable': 'en',
	pmu: 'pmu',
	'pm:uninstall': 'pmu',
	'pm-uninstall': 'pmu',
	'theme:uninstall': 'pmu',
	status: 'status',
	'core:status': 'status',
	'core-status': 'status',
	st: 'status',
	'sql-dump': 'sql-dump',
	'sql:dump': 'sql-dump'
};

/**
 * Turns what an operator typed into the route that already serves it.
 *
 * `/__ops` takes an operation NAME and nothing else, so `en webform` reached it as an operation
 * called "en webform" and came back `unknown operation`. Module installs have their own route, and
 * routing to it is the difference between a field that looks like Drush and one that behaves like
 * it. An operation given arguments it cannot take is refused by name rather than silently truncated
 * to its first word.
 */
export function parseDrush(input: string | null | undefined): DrushCommand | null {
	const words = String(input ?? '')
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	const typed = words[0];
	if (typed === undefined) return null;
	const head = DRUSH_ALIASES[typed] ?? typed;

	const flags = words.filter((w) => w.startsWith('-'));
	const rest = words.slice(1).filter((w) => !w.startsWith('-'));

	// `en` is the one operation with an argument, and it has a route of its own that installs;
	// the registry entry is sliced and refuses
	if (head === 'en') {
		const module = rest[0];
		if (module === undefined) {
			return {
				kind: 'error',
				message: `${typed} needs a module name, as in \`${typed} webform\``
			};
		}
		if (rest.length > 1) {
			return {
				kind: 'error',
				message: `${typed} takes one module at a time; got ${rest.length}`
			};
		}
		return {
			kind: 'run',
			route: '/__enable',
			params: { module, ...(flags.includes('--dry') ? { dry: '1' } : {}) }
		};
	}

	if (rest.length > 0) {
		return {
			kind: 'error',
			message: `${typed} takes no arguments; \`${rest.join(' ')}\` was not understood`
		};
	}
	return { kind: 'run', route: '/__ops', params: { op: head } };
}

export function renderCommands(
	entries: readonly OpsEntry[],
	result: string | null,
	submitted: string | null,
	error: string | null = null
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
<input type="text" name="op" placeholder="cr, or en webform" value="${escapeHtml(submitted ?? '')}" spellcheck="false">
<button type="submit">Run</button></form>
${error ? `<div class="card bad"><strong class="over">Not Understood</strong><p class="sub" style="margin:.3rem 0 0">${escapeHtml(error)}</p></div>` : ''}
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

// #region Git -- live, drives /git over the three providers

/** one configured remote, as the page needs to show it */
export interface RemoteRow {
	id: string;
	provider: string;
	repo: string;
	branch: string;
	host?: string;
	/** the sha the last successful check saw */
	head?: string | null;
	/** the sha whose files are actually mounted, which is not always the head */
	installed?: string | null;
	/** epoch ms of that check */
	checkedAt?: number | null;
	pulledAt?: number | null;
	/** 0 means polling is off and only a webhook moves this remote */
	intervalMinutes?: number;
	backoffUntil?: number | null;
	/** the pull or merge request being previewed instead of the branch */
	previewOf?: string | null;
	lastError?: string | null;
	lastPlan?: { added?: number; modified?: number; removed?: number; unchanged?: number } | null;
	/** how the last delivery was authenticated, or null if none has arrived */
	proof?: string | null;
	hookInstalled?: boolean;
	files?: number;
}

const ago = (at: number | null | undefined, now: number): string => {
	if (!at) return 'never';
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 90) return `${s}s ago`;
	if (s < 5400) return `${Math.round(s / 60)}m ago`;
	return `${Math.round(s / 3600)}h ago`;
};

/**
 * Remotes, and what each one last told us.
 *
 * The write-back is a COMMIT STATUS on all three providers. GitHub's Checks API is richer and a
 * pasted token cannot write it -- measured, 403 `Resource not accessible by personal access token`
 * against both check-run endpoints and 201 against the status one -- so the page does not offer it.
 */
const PROVIDER_LABEL: Record<string, string> = {
	github: 'GitHub',
	gitlab: 'GitLab',
	bitbucket: 'Bitbucket',
	gitea: 'Gitea / Forgejo',
	generic: 'Any Git Remote'
};

/** head against installed, which is the difference between "a push arrived" and "it is live" */
function syncPill(r: RemoteRow): string {
	if (r.lastError) return `${pill('warn')} <span class="dim">${escapeHtml(r.lastError)}</span>`;
	if (r.previewOf)
		return `${pill('warn')} <span class="dim">previewing #${escapeHtml(r.previewOf)}</span>`;
	if (!r.installed) return `${pill('none')} <span class="dim">nothing pulled yet</span>`;
	if (r.head && r.installed !== r.head) return `${pill('warn')} <span class="dim">behind</span>`;
	return `${pill('ok')} <span class="dim">${r.files ?? 0} files</span>`;
}

export function renderGit(remotes: readonly RemoteRow[], now: number): string {
	const rows =
		remotes.length === 0
			? `<tr><td colspan="6"><span class="dim">No remotes yet.</span></td></tr>`
			: remotes
					.map((r) => {
						const id = escapeHtml(r.id);
						const plan = r.lastPlan
							? `<span class="dim">+${r.lastPlan.added ?? 0} ~${r.lastPlan.modified ?? 0} -${r.lastPlan.removed ?? 0}</span>`
							: '';
						return `<tr>
<td><strong>${escapeHtml(r.repo)}</strong><br><span class="dim">${escapeHtml(PROVIDER_LABEL[r.provider] ?? r.provider)}${r.host ? ` &middot; ${escapeHtml(r.host)}` : ''}</span></td>
<td><code>${escapeHtml(r.branch)}</code>
<br><select data-branch="${id}" class="dim"><option value="">switch branch...</option></select></td>
<td>${r.head ? `<code>${escapeHtml(String(r.head).slice(0, 12))}</code>` : `<span class="dim">unknown</span>`}
<br><span class="dim">${escapeHtml(ago(r.checkedAt, now))}</span></td>
<td>${syncPill(r)}<br>${plan}</td>
<td>${
							r.hookInstalled
								? `${pill('ok')} <span class="dim">${escapeHtml(r.proof ?? 'no delivery yet')}</span>`
								: `${pill('none')} <span class="dim">polling only</span>`
						}
<br><input type="number" min="0" step="5" value="${r.intervalMinutes ?? 60}" data-interval="${id}" style="width:5rem"> <span class="dim">min</span></td>
<td><button data-act="check" data-id="${id}">Check</button>
<button data-act="diff" data-id="${id}">Diff</button>
<button data-act="pull" data-id="${id}">Pull</button>
<button data-act="prs" data-id="${id}">Requests</button>
${r.previewOf ? `<button data-act="unpreview" data-id="${id}">Exit Preview</button>` : ''}
<button data-act="hook" data-id="${id}">Webhook</button>
<button data-act="remove" data-id="${id}">Remove</button></td></tr>`;
					})
					.join('');

	return `<h1>Git</h1>
<p class="sub">Connect a repository and this site follows it. A push installs the module; the result is written back as a commit status.</p>
<table><thead><tr><th>Repository</th><th>Branch</th><th>Head</th><th>Installed</th><th>Webhook / Poll</th><th></th></tr></thead>
<tbody>${rows}</tbody></table>
<p id="git-out" class="sub"></p>
<div id="git-detail"></div>

<h2>Add a Remote</h2>
<div class="card">
<p class="sub">Paste a repository URL or <code>owner/repo</code>. Leave the branch empty to follow the repository's default. A public repository over <strong>Any Git Remote</strong> needs no token at all.</p>
<form id="git-add">
<label>Provider <select name="provider">
<option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="bitbucket">Bitbucket</option><option value="gitea">Gitea / Forgejo</option><option value="generic">Any Git Remote</option>
</select></label>
<input type="text" name="repo" placeholder="https://github.com/owner/repo" autocomplete="off" spellcheck="false">
<input type="text" name="branch" placeholder="branch (optional)" autocomplete="off" spellcheck="false" style="min-width:9rem;flex:0">
<input type="number" name="interval" min="0" step="5" value="60" title="Poll interval in minutes; 0 turns polling off" style="width:5rem;flex:0">
<input type="text" name="token" placeholder="access token" autocomplete="off" spellcheck="false">
<input type="text" name="email" placeholder="Atlassian account email (Bitbucket only)" autocomplete="off" spellcheck="false">
<button type="submit">Connect</button>
</form>
<p class="sub">The token is stored in this site's own database, never in KV: KV is operator-writable and nothing there may change what a site can reach.</p>
</div>

<h2>How a Pull Works</h2>
<div class="card">
<p>The transport is git's own smart HTTP, so any host that serves a repository works. A poll is a ref advertisement and costs a few hundred bytes when nothing has moved. A pull asks for one commit at depth 1, reads the packfile, and writes each file as its own row.</p>
<p class="sub">Only mountable files are kept: PHP, YAML, Twig, JS and CSS, with tests, <code>vendor/</code> and <code>node_modules/</code> dropped. Module names come from <code>*.info.yml</code>, so a repository holding several modules installs all of them at their own paths.</p>
<p class="sub">After a pull the Drupal kernel is booted against the new tree. If it fails, the previous files are restored and the site keeps serving.</p>
</div>

<h2>What Gets Written Back</h2>
<div class="card">
<p>A <strong>commit status</strong> on the pushed sha, with a state, a context and a link back to this site. Every provider with an API supports it and an access token can write it.</p>
<p class="sub">GitHub's Checks API carries annotations and per-line output, and only a GitHub App can write one. A pasted token is refused with <code>Resource not accessible by personal access token</code>, so this page does not offer check runs.</p>
</div>

<h2>Scopes</h2>
<table><thead><tr><th>Provider</th><th>Read the tree</th><th>Write a status</th><th>Create a webhook</th></tr></thead><tbody>
<tr><td>GitHub</td><td><code>Contents: read</code></td><td><code>Commit statuses: write</code></td><td><code>Webhooks: write</code></td></tr>
<tr><td>GitLab</td><td><code>read_api</code></td><td><code>api</code></td><td><code>api</code> + Maintainer</td></tr>
<tr><td>Bitbucket</td><td><code>repository:read</code></td><td><code>repository:read</code></td><td><code>webhook</code></td></tr>
<tr><td>Gitea / Forgejo</td><td><code>read:repository</code></td><td><code>write:repository</code></td><td><code>write:repository</code></td></tr>
<tr><td>Any Git Remote</td><td>read access over HTTPS</td><td><span class="dim">no API</span></td><td><span class="dim">register by hand</span></td></tr>
</tbody></table>
<p class="sub">GitLab has no narrower scope than <code>api</code> for writing a status. Bitbucket authenticates with your Atlassian account email as the username and the API token as the password. A plain remote polls only; use <strong>Webhook</strong> to mint a secret and register the delivery URL yourself.</p>

<script>
const out = document.getElementById('git-out');
const detail = document.getElementById('git-detail');
function owner() { return window.prompt('Owner token for this site'); }
function esc(s) { const d = document.createElement('span'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }
async function call(params, token) {
  const res = await fetch('/git?' + new URLSearchParams(params), {
    headers: { authorization: 'Bearer ' + token }
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'refused');
  return data;
}
function showChanges(data) {
  const c = data.counts || {};
  const head = '<h2>' + esc(String(data.sha || '').slice(0, 12)) + '</h2>' +
    '<p class="sub">+' + (c.added || 0) + ' added, ~' + (c.modified || 0) + ' modified, -' +
    (c.removed || 0) + ' removed, ' + (c.unchanged || 0) + ' unchanged. ' +
    (data.rowsWritten || 0) + ' rows would be written.</p>';
  const conflicts = (data.conflicts || []).length
    ? '<p class="sub"><strong>' + data.conflicts.length + ' conflicting path(s):</strong> ' +
      data.conflicts.map(function (x) { return esc(x.path) + ' (owned by ' + esc(x.owner) + ')'; }).join(', ') + '</p>'
    : '';
  const mods = (data.modules || []).length
    ? '<p class="sub">Modules: ' + data.modules.map(function (m) { return '<code>' + esc(m.name) + '</code> (' + esc(m.type) + ')'; }).join(', ') + '</p>'
    : '';
  const rows = (data.changes || []).filter(function (ch) { return ch.kind !== 'unchanged'; }).map(function (ch) {
    return '<tr><td><code>' + esc(ch.path) + '</code></td><td>' + esc(ch.kind) + '</td>' +
      '<td class="dim">+' + (ch.added || 0) + ' / -' + (ch.removed || 0) + '</td></tr>';
  }).join('');
  detail.innerHTML = '<div class="card">' + head + mods + conflicts +
    (rows ? '<table><thead><tr><th>File</th><th>Change</th><th>Lines</th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<p class="sub">No file differs.</p>') + '</div>';
}
function showPulls(data, id) {
  const rows = (data.pulls || []).map(function (p) {
    return '<tr><td>#' + esc(p.id) + '</td><td>' + esc(p.title) + '</td><td><code>' + esc(p.branch) +
      '</code> &rarr; <code>' + esc(p.target) + '</code></td><td>' + esc(p.author) + (p.draft ? ' <em>draft</em>' : '') +
      '</td><td><button data-preview="' + esc(p.id) + '" data-id="' + esc(id) + '">Preview</button></td></tr>';
  }).join('');
  detail.innerHTML = '<div class="card"><h2>Open Requests</h2>' +
    (rows ? '<table><thead><tr><th>#</th><th>Title</th><th>Branch</th><th>Author</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<p class="sub">Nothing open.</p>') +
    '<p class="sub">A preview installs that request\\'s head instead of the branch. Polling and pushes are held until you leave it.</p></div>';
  detail.querySelectorAll('button[data-preview]').forEach(function (b) {
    b.addEventListener('click', async function () {
      const t = owner(); if (!t) return;
      out.textContent = 'Previewing #' + b.dataset.preview + '...';
      try {
        const res = await call({ action: 'preview', id: b.dataset.id, pr: b.dataset.preview }, t);
        out.textContent = 'Previewing #' + b.dataset.preview + '.';
        showChanges(res);
      } catch (err) { out.textContent = 'Failed: ' + err.message; }
    });
  });
}
document.getElementById('git-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (!f.get('repo')) { out.textContent = 'A repository is needed.'; return; }
  if (!f.get('token') && f.get('provider') !== 'generic') { out.textContent = 'That provider needs an access token.'; return; }
  const t = owner(); if (!t) return;
  out.textContent = 'Connecting...';
  try {
    const data = await call({
      action: 'add', provider: f.get('provider'), repo: f.get('repo'),
      branch: f.get('branch') || '', token: f.get('token') || '', email: f.get('email') || '',
      interval: f.get('interval') || '60'
    }, t);
    out.textContent = 'Connected ' + data.repo + ' at ' + (data.head || 'unknown') + '.';
    window.location.reload();
  } catch (err) { out.textContent = 'Could not connect: ' + err.message; }
});
document.querySelectorAll('select[data-branch]').forEach((s) => {
  s.addEventListener('focus', async () => {
    if (s.dataset.loaded) return;
    const t = owner(); if (!t) return;
    try {
      const data = await call({ action: 'branches', id: s.dataset.branch }, t);
      s.dataset.loaded = '1';
      data.branches.forEach(function (b) {
        const o = document.createElement('option');
        o.value = b; o.textContent = b + (b === data.current ? ' (current)' : '');
        s.appendChild(o);
      });
    } catch (err) { out.textContent = 'Could not list branches: ' + err.message; }
  });
  s.addEventListener('change', async () => {
    if (!s.value) return;
    const t = owner(); if (!t) return;
    out.textContent = 'Switching to ' + s.value + '...';
    try {
      const data = await call({ action: 'switch', id: s.dataset.branch, branch: s.value }, t);
      showChanges(data);
      window.location.reload();
    } catch (err) { out.textContent = 'Could not switch: ' + err.message; }
  });
});
document.querySelectorAll('input[data-interval]').forEach((i) => {
  i.addEventListener('change', async () => {
    const t = owner(); if (!t) return;
    try {
      const data = await call({ action: 'interval', id: i.dataset.interval, minutes: i.value }, t);
      out.textContent = data.message;
    } catch (err) { out.textContent = 'Failed: ' + err.message; }
  });
});
document.querySelectorAll('button[data-act]').forEach((b) => {
  b.addEventListener('click', async () => {
    const t = owner(); if (!t) return;
    out.textContent = b.dataset.act + '...';
    try {
      const data = await call({ action: b.dataset.act, id: b.dataset.id }, t);
      if (b.dataset.act === 'diff' || b.dataset.act === 'pull' || b.dataset.act === 'unpreview') {
        showChanges(data);
        out.textContent = data.applied === false && data.rolledBack ? data.error : 'done';
        return;
      }
      if (b.dataset.act === 'prs') { showPulls(data, b.dataset.id); out.textContent = 'done'; return; }
      if (b.dataset.act === 'hook') {
        out.textContent = data.message + ' Delivery URL: ' + data.deliverTo;
        return;
      }
      out.textContent = data.message || 'done';
      if (b.dataset.act === 'remove') window.location.reload();
    } catch (err) { out.textContent = 'Failed: ' + err.message; }
  });
});
</script>`;
}

// #endregion

// #region Access -- the OIDC provider an operator had to set by hand

export interface OidcSetupRow {
	issuer: string;
	clientId: string;
	secretPresent: boolean;
	redirectUri: string;
	saved?: boolean;
	discovery?: {
		ok: boolean;
		error?: string;
		authorization?: string;
		token?: string;
		jwks?: string;
	};
	error?: string | null;
}

/**
 * The single sign-on surface.
 *
 * Writing goes to `/setup/oidc`, which takes the OWNER token rather than this page's weaker gate:
 * whoever sets the issuer decides which provider every login on the site authenticates against, so
 * it is held to the same bar as the client id. The secret stays a binding and is reported present or
 * absent rather than shown.
 */
export function renderAccess(row: OidcSetupRow): string {
	const configured = row.issuer !== '' && row.clientId !== '';
	const d = row.discovery;
	return `<h1>Access</h1>
<p class="sub">Single sign-on through an OpenID Connect provider. The host verifies the <code>id_token</code> signature, because the interpreter is built without OpenSSL and cannot.</p>

<div class="card${configured ? '' : ' warn'}">
<strong>${configured ? `${pill('ok')} Configured` : `${pill('none')} Not Configured`}</strong>
<p class="sub" style="margin:.4rem 0 0">Issuer <code>${escapeHtml(row.issuer || 'not set')}</code><br>
Client ID <code>${escapeHtml(row.clientId || 'not set')}</code><br>
Client secret ${row.secretPresent ? `<span class="ok">present</span>` : `<span class="over">absent</span>`} <span class="dim">(the <code>OIDC_CLIENT_SECRET</code> binding, never read back here)</span></p>
</div>

<h2>Redirect URI</h2>
<p class="sub">Add this to the provider's allowed redirect list before the first login.</p>
<div class="card"><code>${escapeHtml(row.redirectUri)}</code></div>

<h2>Configure</h2>
<p class="sub">Submitting needs the owner token minted at first run; send it as <code>Authorization: Bearer</code>.</p>
<form method="POST" action="/setup/oidc?action=save">
<input type="text" name="issuer" placeholder="https://accounts.example.com" value="${escapeHtml(row.issuer)}" spellcheck="false">
<input type="text" name="clientId" placeholder="client id" value="${escapeHtml(row.clientId)}" spellcheck="false">
<button type="submit">Save</button></form>
${row.error ? `<div class="card bad"><span class="over">${escapeHtml(row.error)}</span></div>` : ''}
${
	d
		? `<div class="card${d.ok ? '' : ' bad'}"><strong>Discovery</strong><p class="sub" style="margin:.3rem 0 0">${
				d.ok
					? `authorization <code>${escapeHtml(d.authorization ?? '')}</code><br>token <code>${escapeHtml(d.token ?? '')}</code><br>jwks <code>${escapeHtml(d.jwks ?? '')}</code>`
					: `<span class="over">${escapeHtml(d.error ?? 'discovery failed')}</span>`
			}</p></div>`
		: ''
}

<h2>What a Login Refuses</h2>
<ul>
<li>a signature from a key outside the provider's JWKS</li>
<li>a token whose <code>iss</code> is not the issuer above</li>
<li>a token whose <code>aud</code> belongs to another client of the same provider</li>
<li>an expired token</li>
<li>a nonce from a different login</li>
</ul>
<p class="sub">The signing algorithm is taken from the key rather than from the token header, and the account is keyed by issuer and subject together, so a subject from a newly configured issuer cannot take over an existing account.</p>`;
}

// #endregion
