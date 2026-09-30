#!/usr/bin/env bun
/**
 * Loads each corpus repository into a fresh local drupflare site and records what worked.
 *
 *   bun scripts/e2e/corpus-lane.ts [--repo=<id>[,<id>]] [--render-only] [--keep]
 *   CORPUS_ORIGIN=https://<worker>.workers.dev bun scripts/e2e/corpus-lane.ts --deployed --plan=free --repo=<id>
 *
 * Every repository is cloned at the commit `config/corpus.yml` pins. A module-shaped one has each
 * of its modules uploaded with `drangler modify upload` and enabled with `/enable`; the site is then
 * driven anonymously and as the administrator, and each capability row is recorded only from an
 * assertion that ran: `inline` when it answered inside the request, `degraded` when it answered with
 * a recorded degradation, `unsupported` with the reason when it was refused, and `unknown` when
 * nothing asserted it. A repository whose install path the lane cannot drive yet is recorded with
 * every row unknown and the reason, never guessed.
 *
 * Results merge into `docs/compatibility.json`, and `docs/compatibility.md` is rendered from that
 * file alone.
 */

import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'yaml';
import { startDevServer, type DevServer } from '../dev-server.js';
import {
	installPath,
	lockedContrib,
	nativePlan,
	projectPlan,
	upgradeNote,
	type ProjectPlan
} from './corpus-project.js';
import {
	encodeForm,
	ERROR_PAGE,
	FREE_DAILY_ROWS,
	hiddenFields,
	sessionFrom,
	textFields
} from './live-deploy.js';

// #region the model, exported for the gate

export type RowState = 'inline' | 'parked' | 'degraded' | 'unsupported' | 'unknown';

export type RepoEntry = {
	id: string;
	repo: string;
	sha: string;
	shape: string;
	core: string;
	install: 'modify' | 'project' | 'profile' | 'none';
	/** the directory of the project inside the repository, when it is not the top */
	root?: string;
	modules?: string[];
	checks?: string[];
	/** `runs`, `needs-runtime`, `degrades` or `structural`: what reading the source predicts */
	assessment: string;
	/** the runtime capabilities the codebase reaches for */
	needs: string[];
	/** a private dependency its owner holds a credential for and the rig does not */
	credential?: string;
	/** packages the site around the codebase supplies, which its own composer.json does not declare */
	requires?: Record<string, string>;
	/** recipes under the clone's `recipes/` a native install applies after site:install */
	recipes?: string[];
	/** recipes a clone's own recipe assumes but does not list, added to its copy before install */
	recipe_requires?: Record<string, string[]>;
	/** install-form answers passed to drush site:install, as `form_id.key=value` */
	install_args?: string[];
	/** packages a credential guards, left out of the native install and named in the note */
	omit?: string[];
	/** the project's composer minimum-stability, which a registry install honours the way composer does */
	stability?: string;
	/** packages installed past the pre-check's conflict, whose conflict the fixture's note names */
	force?: string[];
	/** the distribution a sub-project runs inside, migrated first with the sub-project on top */
	base?: string;
	database?: string;
	/** what is known about a row independently of drupflare, appended to the lane's own note */
	notes?: Record<string, string>;
};

export type Corpus = { rows: string[]; repos: RepoEntry[] };

export type RepoResult = {
	sha: string;
	lane: string;
	run: string;
	date: string;
	rows: Record<string, { state: RowState; note?: string }>;
	/** the modules and themes the site enabled when the run ended */
	enabled?: string[];
	/** composer packages of type drupal-module, drupal-theme or drupal-profile the lane delivered, any vendor */
	packages?: string[];
	/** machine names of the repository's own modules, themes and profiles the lane uploaded */
	custom?: string[];
	/** the same rows driven against a Worker deployed to a Cloudflare account, kept beside the local run */
	deployed?: DeployedRun;
};

/** what a deployed run records; the site page shows Deployed only for 13 passing rows at the pinned sha */
export type DeployedRun = {
	sha: string;
	run: string;
	date: string;
	/** the Cloudflare plan of the account the throwaway ran on: `free`, or `paid` */
	plan: string;
	rows: RepoResult['rows'];
};

export type Compatibility = {
	rows: string[];
	repos: Record<string, RepoResult>;
};

/** every row unknown, which is what a repository nothing has run against reads */
export function unknownRows(rows: string[], note?: string): RepoResult['rows'] {
	return Object.fromEntries(
		rows.map((r) => [
			r,
			note ? { state: 'unknown' as const, note } : { state: 'unknown' as const }
		])
	);
}

/** every row unsupported for one reason, which is what a repository refused before any install reads */
export function unsettled(rows: string[], note: string): RepoResult['rows'] {
	return Object.fromEntries(rows.map((r) => [r, { state: 'unsupported' as const, note }]));
}

/**
 * Rows a run never reached, once the install row says why.
 *
 * An unknown row beside an install that failed is a fact about that repository (nothing was there to
 * drive), so it reads `unsupported` with the install verdict. A lane crash is not settled: it stays
 * unknown because nothing about the repository was learned.
 */
export function settleRows(rows: RepoResult['rows']): RepoResult['rows'] {
	const install = rows['install'];
	if (!install || install.state === 'unknown') return rows;
	const why = (install.note ?? install.state).replace(/\s+/g, ' ').slice(0, 160);
	return Object.fromEntries(
		Object.entries(rows).map(([row, cell]) => [
			row,
			cell.state === 'unknown' && !cell.note && install.state === 'unsupported'
				? { state: 'unsupported' as const, note: `not reached: install ${why}` }
				: cell
		])
	);
}

/** merges one run into the file, replacing only the repositories it ran */
export function mergeResults(
	file: Compatibility,
	rows: string[],
	ran: Record<string, RepoResult>
): Compatibility {
	// a local run does not erase the deployed record; the site page compares its sha with the pinned one
	const kept = Object.fromEntries(
		Object.entries(ran).map(([id, result]) => {
			const deployed = file.repos[id]?.deployed;
			return [id, deployed && !result.deployed ? { ...result, deployed } : result];
		})
	);
	return { rows, repos: { ...file.repos, ...kept } };
}

/** puts deployed runs beside the local record of the same repository, leaving the local rows as they are */
export function recordDeployed(
	file: Compatibility,
	rows: string[],
	runs: Record<string, DeployedRun>
): Compatibility {
	const repos = { ...file.repos };
	for (const [id, deployed] of Object.entries(runs)) {
		const local = repos[id];
		if (!local) throw new Error(`no local record of ${id} to put a deployed run beside`);
		repos[id] = { ...local, deployed };
	}
	return { rows, repos };
}

/** the origin a deployed run drives, or undefined for a local one; `--deployed` needs `CORPUS_ORIGIN` */
export function deployedOrigin(
	argv: readonly string[],
	env: Record<string, string | undefined>
): string | undefined {
	if (!argv.includes('--deployed')) return undefined;
	const origin = env['CORPUS_ORIGIN'];
	if (!origin || !/^https:\/\/[^/\s]+\/?$/.test(origin))
		throw new Error('--deployed needs CORPUS_ORIGIN=https://<worker>.<subdomain>.workers.dev');
	return origin.replace(/\/$/, '');
}

/** a deployed worker in the shape of a dev server: nothing to start, stop or read a log from */
export function remoteServer(origin: string): DevServer {
	return { origin, stateDir: '', logFile: '', stop() {} };
}

const MARK: Record<RowState, string> = {
	inline: 'inline',
	parked: 'parked',
	degraded: 'degraded',
	unsupported: 'unsupported',
	unknown: 'unknown'
};

const PASSING = new Set<RowState>(['inline', 'parked', 'degraded']);

/** the state the website's fixtures page shows for a repository, by the same rule (`sync-fixtures.ts`) */
export function fixtureStatus(result: RepoResult | undefined, sha: string, total: number): string {
	if (!result || result.sha !== sha) return 'pending';
	const rows = Object.values(result.rows);
	if (rows.length === 0) return 'pending';
	if (rows.every((r) => r.note?.startsWith('needs upgrade:'))) return 'needs upgrade';
	const passed = rows.filter((r) => PASSING.has(r.state)).length;
	if (passed === rows.length) {
		const d = result.deployed;
		const deployed =
			d !== undefined &&
			d.sha === sha &&
			Object.keys(d.rows).length === total &&
			Object.values(d.rows).every((r) => PASSING.has(r.state));
		return deployed ? 'deployed' : 'verified';
	}
	return passed === 0 ? 'unsupported' : `${passed} of ${total}`;
}

type Beat = { ran?: boolean; phase?: string };

/** a clean prepare-and-drain in words: the run id, the phase the last beat reached, whether any unit ran */
export function updateNote(prepared: unknown, drained: unknown): string {
	const id = (prepared as { ran?: { run?: { id?: string } } } | null)?.ran?.run?.id ?? 'unknown';
	const beats = (drained as { ran?: { beats?: Beat[] } } | null)?.ran?.beats ?? [];
	const phase = beats.at(-1)?.phase ?? 'unknown';
	return `prepared run ${id}; drained to phase ${phase}${beats.some((b) => b.ran) ? '' : ', with no unit to run'}`;
}

/** a note as the page prints it; runs recorded before `updateNote()` carried the two JSON bodies, cut at 120 */
export function readableNote(note: string): string {
	const flat = note.replace(/\s+/g, ' ').trim();
	const m = flat.match(/^prepare \{.*?"id":"(\w+)".*?; drain \{(.*)$/);
	if (m) {
		const drain = m[2]!;
		const cut = drain.match(/"phase":"(\w*)/)?.[1] ?? 'unknown';
		const phase = cut !== '' && 'complete'.startsWith(cut) ? 'complete' : cut;
		const ran = /"ran":true,"more"/.test(drain);
		return `prepared run ${m[1]}; drained to phase ${phase}${ran ? '' : ', with no unit to run'}`;
	}
	return flat.length > 400 ? `${flat.slice(0, 397)}...` : flat;
}

/** one line per repository when every noted row shares a reason, otherwise one line per reason */
function noteLines(
	id: string,
	rows: RepoResult['rows'],
	all: string[],
	override?: string
): string[] {
	const groups = new Map<string, string[]>();
	for (const row of all) {
		const note = rows[row]?.note;
		if (!note) continue;
		const text = override ?? readableNote(note);
		groups.set(text, [...(groups.get(text) ?? []), row]);
	}
	if (groups.size === 0) return [];
	const [only] = groups;
	if (groups.size === 1 && only![1].length === all.length) return [`- **${id}**: ${only![0]}`];
	return [`- **${id}**`, ...[...groups].map(([text, rs]) => `  - ${rs.join(', ')}: ${text}`)];
}

/** the matrix as Markdown, rendered from the JSON and nothing else */
export function renderMatrix(file: Compatibility, corpus: Corpus): string {
	const total = file.rows.length;
	const statuses = corpus.repos.map((repo) =>
		fixtureStatus(file.repos[repo.id], repo.sha, total)
	);
	const tally = (s: string) => statuses.filter((x) => x === s).length;
	const partial = statuses.filter((s) => / of /.test(s)).length;
	const lines = [
		'# Compatibility',
		'',
		'Generated by `bun scripts/e2e/corpus-lane.ts` from `docs/compatibility.json`. Two lanes write it: the',
		'local lane drives each codebase on a drupflare site in `wrangler dev`, and the deployed lane drives',
		'it on a Worker deployed to a Cloudflare account. **verified** means every capability passed in the',
		'local lane at the pinned commit, and **deployed** means they also passed on a deployed Worker. A pass',
		'is `inline` (answered inside the request), `parked` (answered through the park) or `degraded`',
		'(answered with a recorded degradation); `unsupported` was refused with a reason, and `unknown` means',
		'no run asserted it. The website fixtures page reads the same file by the same rule.',
		'',
		`${corpus.repos.length} codebases: ${tally('deployed')} deployed, ${tally('verified')} verified, ` +
			`${partial} partial, ${tally('unsupported')} unsupported, ${tally('needs upgrade')} need an ` +
			`upgrade to Drupal 11, ${tally('pending')} pending.`,
		'',
		'## Local Runs',
		'',
		`| repository | commit | status | last run | ${file.rows.join(' | ')} |`,
		`| --- | --- | --- | --- | ${file.rows.map(() => '---').join(' | ')} |`
	];
	corpus.repos.forEach((repo, i) => {
		const result = file.repos[repo.id];
		const cells = file.rows.map((row) => MARK[result?.rows[row]?.state ?? 'unknown']);
		const ranAt = result && result.sha === repo.sha ? result.date : 'never';
		lines.push(
			`| [${repo.id}](${repo.repo}) | \`${repo.sha.slice(0, 8)}\` | ${statuses[i]} | ${ranAt} | ${cells.join(' | ')} |`
		);
	});
	const deployed = corpus.repos.filter((repo) => file.repos[repo.id]?.deployed);
	if (deployed.length > 0) {
		lines.push(
			'',
			'## Deployed Runs',
			'',
			`| repository | commit | date | plan | passed | ${file.rows.join(' | ')} |`,
			`| --- | --- | --- | --- | --- | ${file.rows.map(() => '---').join(' | ')} |`
		);
		for (const repo of deployed) {
			const d = file.repos[repo.id]!.deployed!;
			const passed = file.rows.filter((row) =>
				PASSING.has(d.rows[row]?.state ?? 'unknown')
			).length;
			const cells = file.rows.map((row) => MARK[d.rows[row]?.state ?? 'unknown']);
			lines.push(
				`| [${repo.id}](${repo.repo}) | \`${d.sha.slice(0, 8)}\` | ${d.date} | ${d.plan} | ${passed} of ${total} | ${cells.join(' | ')} |`
			);
		}
	}
	const notes: string[] = [];
	corpus.repos.forEach((repo, i) => {
		const result = file.repos[repo.id];
		if (!result) return;
		const upgrade =
			statuses[i] === 'needs upgrade' ? (upgradeNote(repo.core) ?? undefined) : undefined;
		notes.push(...noteLines(repo.id, result.rows, file.rows, upgrade));
	});
	if (notes.length > 0) lines.push('', '## Notes', '', ...notes);
	const failedDeployed = deployed.flatMap((repo) => {
		const d = file.repos[repo.id]!.deployed!;
		const failed = Object.fromEntries(
			Object.entries(d.rows).filter(([, cell]) => !PASSING.has(cell.state))
		);
		return noteLines(repo.id, failed, file.rows);
	});
	if (failedDeployed.length > 0)
		lines.push(
			'',
			'## Deployed Notes',
			'',
			'Rows that did not pass on the deployed Worker.',
			'',
			...failedDeployed
		);
	return `${lines.join('\n')}\n`;
}

// #endregion

// #region driving one site

class Local {
	cookie = '';
	/** restarts the dev server; set once the site has one to restart */
	onLost: (() => Promise<void>) | null = null;
	constructor(
		readonly origin: string,
		readonly owner: string
	) {}

	/**
	 * One request, retried once after a restart when the dev server is gone.
	 *
	 * wrangler 4.127 exits on any request its proxy loses (`Network connection lost.` falls through
	 * `handleErrorEvent` to a fatal `error`), and that ended a whole fixture as `Unable to connect`.
	 */
	private async send(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
		const once = () =>
			fetch(new URL(path, this.origin), { ...init, signal: AbortSignal.timeout(timeoutMs) });
		try {
			const res = await once();
			// the proxy also reports a lost workerd as a plain 500 with this body, not a thrown error
			if (this.onLost === null || res.status !== 500) return res;
			if (!lostServer(new Error(await res.clone().text()))) return res;
		} catch (e) {
			if (this.onLost === null || !lostServer(e)) throw e;
		}
		await this.onLost();
		return once();
	}

	async page(path: string, auth = false) {
		const res = await this.send(
			path,
			{
				headers: auth && this.cookie ? { cookie: this.cookie } : {},
				redirect: 'manual'
			},
			300_000
		);
		return trace('GET', path, res, await res.text());
	}

	/** a GET that follows same-site redirects to an answer; `via` names each hop, in order */
	async reach(path: string, auth = true, hops = 5) {
		const via: string[] = [];
		let got = await this.page(path, auth);
		for (let i = 0; i < hops; i++) {
			const next = redirectTarget(got.res, this.origin);
			if (next === null || next === path || via.includes(next)) break;
			via.push(next);
			path = next;
			got = await this.page(next, auth);
		}
		return { ...got, via };
	}

	async owned(path: string, init: RequestInit = {}) {
		let res: Response;
		let text: string;
		try {
			res = await this.send(
				path,
				{
					...init,
					headers: { authorization: `Bearer ${this.owner}`, ...init.headers }
				},
				600_000
			);
			text = await res.text();
		} catch (e) {
			return {
				status: 0,
				json: {
					error: `no answer: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200)
				} as Record<string, unknown>
			};
		}
		try {
			return { status: res.status, json: JSON.parse(text) as Record<string, unknown> };
		} catch {
			return {
				status: res.status,
				json: { error: text.slice(0, 300) } as Record<string, unknown>
			};
		}
	}

	async upload(
		path: string,
		fields: Record<string, string>,
		file: { field: string; name: string; type: string; bytes: Uint8Array }
	) {
		const form = new FormData();
		for (const [name, value] of Object.entries(fields)) form.append(name, value);
		form.append(file.field, new Blob([file.bytes.slice()], { type: file.type }), file.name);
		const res = await this.send(
			path,
			{
				method: 'POST',
				redirect: 'manual',
				headers: { cookie: this.cookie },
				body: form
			},
			300_000
		);
		return trace('UPLOAD', path, res, await res.text());
	}

	/** runs a Batch API redirect to its end without JavaScript, the way a browser's refresh would */
	async batch(location: string | null): Promise<void> {
		let next = location;
		for (let i = 0; i < 300 && next !== null && next.includes('/batch'); i++) {
			const res = await this.send(
				next,
				{
					headers: { cookie: this.cookie },
					redirect: 'manual'
				},
				300_000
			);
			const body = await res.text();
			const refresh = /http-equiv="Refresh"[^>]*URL=([^"]+)"/i.exec(body)?.[1];
			next = res.headers.get('location') ?? (refresh ? unescapeHtml(refresh) : null);
			if (next !== null && !next.includes('/batch')) return;
		}
	}

	async post(path: string, fields: Record<string, string>) {
		const res = await this.send(
			path,
			{
				method: 'POST',
				redirect: 'manual',
				headers: {
					cookie: this.cookie,
					'content-type': 'application/x-www-form-urlencoded'
				},
				body: encodeForm(fields)
			},
			300_000
		);
		return trace('POST', path, res, await res.text());
	}
}

/** the same-site path a redirect answer points at, or null when it is not a redirect or leaves the site */
export function redirectTarget(
	res: Pick<Response, 'status' | 'headers'>,
	origin: string
): string | null {
	if (![301, 302, 303, 307, 308].includes(res.status)) return null;
	const location = res.headers.get('location');
	if (location === null) return null;
	const url = new URL(location, origin);
	return url.origin === new URL(origin).origin ? url.pathname + url.search : null;
}

/**
 * The form on a page that asks for agreement: one carrying an unchecked checkbox and a submit button.
 * A distribution's terms page (Open Y sends every administrator there until it is accepted) is one.
 */
export function agreementForm(html: string): string | null {
	for (const form of html.match(/<form[\s\S]*?<\/form>/g) ?? [])
		if (/<input[^>]*type="checkbox"/.test(form) && /<input[^>]*type="submit"/.test(form))
			return form;
	return null;
}

/** the post an administrator makes to accept an agreement form: every box ticked, the first button pressed */
export function agreementFields(form: string): Record<string, string> {
	const fields: Record<string, string> = { ...hiddenFields(form) };
	for (const tag of form.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []) {
		const name = /name="([^"]*)"/.exec(tag)?.[1];
		if (name) fields[name] = /value="([^"]*)"/.exec(tag)?.[1] ?? '1';
	}
	const button = /<input[^>]*type="submit"[^>]*>/.exec(form)?.[0] ?? '';
	fields['op'] = /value="([^"]*)"/.exec(button)?.[1] ?? 'Save';
	return fields;
}

/**
 * Accepts the interstitial an installed site puts in front of its administration pages, the way its
 * administrator would on first login, and says what stood in the way when it could not.
 */
export async function acceptInterstitial(
	site: Local
): Promise<{ accepted: string | null; via: string[] }> {
	const first = await site.reach('/admin/modules', true);
	if (first.via.length === 0) return { accepted: null, via: [] };
	const at = first.via[first.via.length - 1] as string;
	const form = first.res.status === 200 ? agreementForm(first.body) : null;
	if (form === null) return { accepted: null, via: first.via };
	await site.post(at.split('?')[0] as string, agreementFields(form));
	const again = await site.reach('/admin/modules', true);
	return again.via.length === 0 && again.res.status === 200
		? { accepted: at, via: [] }
		: { accepted: null, via: again.via.length > 0 ? again.via : first.via };
}

/** creates and deletes a user account, for a site with neither content types nor vocabularies */
async function userCrud(site: Local): Promise<{ ok: boolean; note: string }> {
	const add = await site.page('/admin/people/create', true);
	const name = `corpus${Date.now()}`;
	const created = await site.post('/admin/people/create', {
		...hiddenFields(formHtml(add.body, 'user_register_form') ?? add.body),
		...requiredText(add.body),
		name,
		mail: `${name}@example.com`,
		'pass[pass1]': 'corpus-Pass-7731',
		'pass[pass2]': 'corpus-Pass-7731',
		status: '1',
		op: 'Create new account'
	});
	const people = await site.page(`/admin/people?user=${name}`, true);
	const uid = new RegExp(`href="[^"]*/user/(\\d+)"[^>]*>\\s*${name}\\s*<`).exec(people.body)?.[1];
	if (!uid)
		return {
			ok: false,
			note: `no content type or vocabulary; user create answered ${created.res.status}: ${messagesOf(created.body)}`
		};
	const cancel = await site.page(`/user/${uid}/cancel`, true);
	const gone = await site.post(`/user/${uid}/cancel`, {
		...hiddenFields(cancel.body),
		user_cancel_method: 'user_cancel_delete',
		op: 'Confirm'
	});
	await site.batch(gone.res.headers.get('location'));
	const after = await site.page(`/user/${uid}`, true);
	return after.res.status === 404
		? {
				ok: true,
				note: 'no content type or vocabulary; a user account was created and deleted'
			}
		: {
				ok: false,
				note: `no content type or vocabulary; /user/${uid} answered ${after.res.status} after the delete`
			};
}

/** creates and deletes a term in the first vocabulary, for a site that defines no content type */
async function termCrud(site: Local): Promise<{ ok: boolean; note: string }> {
	const vocabularies = await site.page('/admin/structure/taxonomy', true);
	const vid = /\/admin\/structure\/taxonomy\/manage\/([a-z0-9_]+)\/overview/.exec(
		vocabularies.body
	)?.[1];
	if (!vid) return userCrud(site);
	const path = `/admin/structure/taxonomy/manage/${vid}/add`;
	const add = await site.page(path, true);
	const form = formHtml(add.body, `taxonomy_term_${vid}_form`) ?? add.body;
	const created = await site.post(path, {
		...formValues(form),
		...hiddenFields(form),
		...requiredText(add.body),
		...emptyNumbers(add.body),
		'name[0][value]': 'corpus',
		op: 'Save'
	});
	const saved = await site.page(`/admin/structure/taxonomy/manage/${vid}/overview`, true);
	const id = /href="[^"]*\/taxonomy\/term\/(\d+)"[^>]*>\s*corpus\s*</.exec(saved.body)?.[1];
	if (!id)
		return {
			ok: false,
			note: `term create in ${vid} answered ${created.res.status}: ${messagesOf(created.body)} (the site defines no node type, so a term stands in)`
		};
	const del = await site.page(`/taxonomy/term/${id}/delete`, true);
	const gone = await site.post(`/taxonomy/term/${id}/delete`, {
		...hiddenFields(del.body),
		op: 'Delete'
	});
	return [302, 303].includes(gone.res.status)
		? {
				ok: true,
				note: `a term in ${vid} was created and deleted (the site defines no node type)`
			}
		: {
				ok: false,
				note: `term delete answered ${gone.res.status} (the site defines no node type)`
			};
}

/**
 * What a browser would submit for a form as rendered: every named input with a value, each checked
 * box or radio, each textarea and each select's selected option. A probe that sent only hidden fields
 * dropped a prefilled required value (farmOS's term weight renders as 0) and read the refusal as a gap.
 */
/**
 * The owner token a claim answer hands the lane, setting the lane's password when the site was
 * already claimed.
 *
 * A 409 means an earlier claim committed: an earlier try whose answer was lost to a reset, or an
 * earlier run that sent a different password. The lane runs with diagnostics on, so it sets its own
 * password again rather than logging in with one the site never stored.
 */
export async function claimOwner(
	origin: string,
	status: number,
	text: string,
	pass: string,
	fetcher: typeof fetch = fetch
): Promise<string> {
	try {
		const token = (JSON.parse(text) as { ownerToken?: string }).ownerToken ?? '';
		if (token !== '') return token;
	} catch {
		// the caller names the answer
	}
	if (status !== 409 || !/already configured/.test(text)) return '';
	for (let tries = 0; tries < 5; tries++) {
		const reset = await fetcher(new URL('/firstrun?force=1', origin), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ adminName: 'admin', adminPass: pass })
		});
		const answer = await reset.text();
		if (reset.ok) {
			try {
				return (
					(JSON.parse(answer) as { ownerToken?: string }).ownerToken || 'pw-diagnostics'
				);
			} catch {
				return 'pw-diagnostics';
			}
		}
		// a reset object answers 503 and the next try reaches a fresh one
		if (reset.status !== 503) break;
		await new Promise((r) => setTimeout(r, 2000 * (tries + 1)));
	}
	return '';
}

/** an attribute by its own name; a bare `type="` also matches `data-paragraphs-split-text-type="` */
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

export function formValues(html: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const tag of html.match(/<input[^>]*>/g) ?? []) {
		const name = attr(tag, 'name');
		const type = attr(tag, 'type') ?? 'text';
		if (!name || /^(submit|button|image|file|reset)$/.test(type)) continue;
		if (/^(checkbox|radio)$/.test(type) && !/\bchecked\b/.test(tag)) continue;
		const value = attr(tag, 'value');
		if (value !== undefined) fields[name] = decode(value);
	}
	for (const m of html.matchAll(/<textarea[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
		if (m[2]!.trim() !== '') fields[m[1]!] = decode(m[2]!);
	}
	for (const m of html.matchAll(/<select[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)) {
		const options = m[2]!.match(/<option[^>]*>/g) ?? [];
		const chosen = options.find((o) => /\bselected\b/.test(o)) ?? options[0];
		const value = chosen === undefined ? undefined : /value="([^"]*)"/.exec(chosen)?.[1];
		if (value !== undefined) fields[m[1]!] = decode(value);
	}
	return fields;
}

const decode = (s: string) =>
	s
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');

/** a value for every empty required text input and textarea, so a type with extra required fields saves */
export function requiredText(html: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const tag of html.match(/<(?:input|textarea)[^>]*>/g) ?? []) {
		const type = tag.startsWith('<textarea') ? 'textarea' : (attr(tag, 'type') ?? 'text');
		if (!/^(text|email|url|number|textarea)$/.test(type)) continue;
		if (!/\brequired\b/.test(tag)) continue;
		const name = attr(tag, 'name');
		if (!name || (attr(tag, 'value') ?? '') !== '') continue;
		fields[name] =
			type === 'email'
				? 'corpus@example.com'
				: type === 'url'
					? 'https://example.com'
					: type === 'number'
						? '0'
						: 'corpus';
	}
	return fields;
}

/** a zero for every empty number input, since a term form can demand a weight the browser would show as 0 */
export function emptyNumbers(html: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const tag of html.match(/<input[^>]*>/g) ?? []) {
		if (attr(tag, 'type') !== 'number') continue;
		const name = attr(tag, 'name');
		if (name && (attr(tag, 'value') ?? '') === '') fields[name] = '0';
	}
	return fields;
}

/** the names of the fields a re-rendered form flagged as invalid, from the `error` class Drupal puts on each */
export function errorFieldNames(html: string): string[] {
	const names: string[] = [];
	for (const tag of html.match(/<(?:input|select|textarea)[^>]*>/g) ?? []) {
		if (!/class="[^"]*\berror\b[^"]*"/.test(tag)) continue;
		const name = /name="([^"]*)"/.exec(tag)?.[1];
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/** the first real option of a select, which is what a person would pick to get past a required one */
function firstOption(html: string, name: string): string | null {
	for (const select of html.match(/<select[\s\S]*?<\/select>/g) ?? []) {
		if (!select.includes(`name="${name}"`)) continue;
		for (const m of select.matchAll(/<option[^>]*value="([^"]*)"/g))
			if (m[1] && m[1] !== '_none') return m[1];
	}
	return null;
}

/** a value for each field a form flagged as invalid: a select's first option, a URL for links, else text */
export function filledFlags(html: string): Record<string, string> {
	return Object.fromEntries(
		errorFieldNames(html)
			.filter((n) => !/\[(fids|target_id)\]|_upload/.test(n))
			.map((n) => [
				n,
				firstOption(html, n) ?? (/link|url/i.test(n) ? 'https://example.com' : 'corpus')
			])
	);
}

/** the content type a site offers on /node/add, preferring the stock ones a probe was written for */
export function contentTypeFrom(html: string): string | null {
	const types = [...html.matchAll(/href="[^"]*\/node\/add\/([a-z0-9_]+)"/g)].map(
		(m) => m[1] as string
	);
	return (
		types.find((t) => t === 'page') ?? types.find((t) => t === 'article') ?? types[0] ?? null
	);
}

/**
 * The line that stopped a native install, not the first one that sounds bad.
 *
 * A skipped patch prints "Could not apply patch" and the install carries on, so Open Y's note
 * quoted seven skipped patches and missed the TypeError that ended it.
 */
export function nativeCause(lines: readonly string[]): string {
	const kept = lines.filter((l) => !/Could not apply patch|\[warning\]/i.test(l));
	const at = kept.findIndex((l) =>
		/TypeError|PHP Fatal|Uncaught|\[error\]|^In \S+ line \d+:|^Problem \d/.test(l)
	);
	if (at >= 0) return kept.slice(at, at + 3).join(' | ');
	const cause = kept.filter((l) =>
		/could not|does not exist|fatal:|Exception|\bError\b|not found|blocked/i.test(l)
	);
	return (cause.length > 0 ? cause.slice(0, 4) : kept.slice(-6)).join(' | ');
}

/** a fetch that failed because nothing answered, not because the site did */
export function lostServer(e: unknown): boolean {
	const text =
		e instanceof Error ? `${e.message} ${String((e as { code?: unknown }).code ?? '')}` : '';
	return /Unable to connect|socket connection was closed|Network connection lost|ECONNREFUSED|ECONNRESET|ConnectionRefused/i.test(
		text
	);
}

/** one line per form post when CORPUS_TRACE is set: status, redirect target and printed messages */
function trace(method: string, path: string, res: Response, body: string) {
	if (process.env.CORPUS_TRACE)
		console.error(
			`[trace] ${method} ${path} -> ${res.status} ${res.headers.get('location') ?? ''} [${res.headers.get('x-cfw-cache') ?? '-'} ${res.headers.get('x-cfw-plan') ?? '-'}] | ${messagesOf(body)}`
		);
	return { res, body };
}

/** the directory holding `<module>.info.yml`, searched breadth-first under the clone */
export function moduleDir(root: string, module: string): string | null {
	const queue = [root];
	while (queue.length > 0) {
		const dir = queue.shift() as string;
		if (existsSync(join(dir, `${module}.info.yml`))) return dir;
		for (const name of readdirSync(dir)) {
			if (
				name.startsWith('.') ||
				name === 'node_modules' ||
				name === 'vendor' ||
				name === 'tests'
			)
				continue;
			const full = join(dir, name);
			if (statSync(full).isDirectory()) queue.push(full);
		}
	}
	return null;
}

/**
 * The drupal.org projects the modules' own info files depend on and the repository does not carry.
 *
 * `project:module (>=6.0.3, <7.0)` is how an info file names a contrib dependency; the composer
 * constraint is the parenthesised range with its spaces removed. Core (`drupal:`) is never fetched.
 */
export function infoRequires(root: string, modules: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const module of modules) {
		const at = moduleDir(root, module);
		if (at === null) continue;
		const info = parse(readFileSync(join(at, `${module}.info.yml`), 'utf8')) as {
			dependencies?: string[];
		};
		for (const dep of info.dependencies ?? []) {
			const m = /^([a-z0-9_]+):([a-z0-9_]+)\s*(?:\(([^)]*)\))?/.exec(dep.trim());
			if (!m || m[1] === 'drupal' || moduleDir(root, m[2]!) !== null) continue;
			out[`drupal/${m[1]}`] = (m[3] ?? '').replace(/\s+/g, '');
		}
	}
	return out;
}

/** what the repository's own composer.json requires beyond the platform and core */
/** the names a repository's composer.json says it replaces */
export function composerReplaces(root: string): Set<string> {
	const file = join(root, 'composer.json');
	if (!existsSync(file)) return new Set();
	const doc = JSON.parse(readFileSync(file, 'utf8')) as { replace?: Record<string, string> };
	return new Set(Object.keys(doc.replace ?? {}));
}

export function composerRequires(root: string): Record<string, string> {
	const file = join(root, 'composer.json');
	if (!existsSync(file)) return {};
	const requires =
		(JSON.parse(readFileSync(file, 'utf8')) as { require?: Record<string, string> }).require ??
		{};
	return Object.fromEntries(
		Object.entries(requires).filter(
			([name]) =>
				name.includes('/') &&
				!name.startsWith('drupal/core') &&
				!name.startsWith('composer/')
		)
	);
}

function clone(repo: RepoEntry, into: string): void {
	if (existsSync(join(into, '.git'))) {
		const head = spawnSync('git', ['-C', into, 'rev-parse', 'HEAD'], {
			encoding: 'utf8'
		}).stdout.trim();
		if (head === repo.sha) return;
	}
	mkdirSync(into, { recursive: true });
	const run = (args: string[]) => {
		const r = spawnSync('git', args, { cwd: into, encoding: 'utf8' });
		if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.slice(0, 300)}`);
	};
	run(['init', '-q']);
	spawnSync('git', ['remote', 'remove', 'origin'], { cwd: into });
	run(['remote', 'add', 'origin', repo.repo]);
	run(['fetch', '-q', '--depth', '1', 'origin', repo.sha]);
	run(['checkout', '-q', 'FETCH_HEAD']);
}

// #region module-shaped repositories

/** the row verdict for a repository the lane must not run, or null when it should run */
export function refusalFor(repo: RepoEntry): string | null {
	if (repo.shape === 'composer-plugin')
		return `not a site: ${repo.id} is a composer plugin that patches other packages at install time`;
	return upgradeNote(repo.core);
}

/** the static GET paths a module's routing file declares, which a workflow check can visit */
export function routePaths(routingYml: string, limit = 6): string[] {
	const routes = (parse(routingYml) ?? {}) as Record<
		string,
		{ path?: string; methods?: string[]; defaults?: Record<string, unknown> }
	>;
	const out: string[] = [];
	for (const route of Object.values(routes)) {
		const path = route.path;
		if (typeof path !== 'string' || path.includes('{') || path.includes('.')) continue;
		if (route.methods && !route.methods.includes('GET')) continue;
		const d = route.defaults ?? {};
		if (!('_form' in d) && !('_controller' in d) && !('_entity_list' in d)) continue;
		if (!out.includes(path)) out.push(path);
		if (out.length >= limit) break;
	}
	return out;
}

/** the dependency the installer named in a refusal, or null */
export function missingDependency(message: string): string | null {
	return /missing its dependency module ([a-z0-9_]+)/.exec(message)?.[1] ?? null;
}

/** the last error-looking line of wrangler's log, which is the only account of a 500 the page hides */
export function lastError(logFile: string): string | undefined {
	if (!logFile || !existsSync(logFile)) return undefined;
	const lines = readFileSync(logFile, 'utf8')
		.split('\n')
		.filter((l) => /(Fatal error|Uncaught|Exception|Error:|ERROR)/.test(l));
	const last = lines.at(-1);
	return last ? `log: ${last.replace(/\s+/g, ' ').slice(0, 300)}` : undefined;
}

type Registry = { vendors: string[]; tried: Set<string> };
type Enable = (module: string) => Promise<{ status: number; json: Record<string, unknown> }>;

/** installs the first registry package named after a module no file provides, or reports none */
async function provideFromRegistry(site: Local, module: string, reg: Registry): Promise<boolean> {
	if (reg.tried.has(module)) return false;
	reg.tried.add(module);
	for (const pkg of [`drupal/${module}`, ...reg.vendors.map((v) => `${v}/${module}`)]) {
		const got = await site.owned(`/install?module=${encodeURIComponent(pkg)}&deps=1`, {
			method: 'POST'
		});
		const own = ((got.json['installed'] ?? []) as Record<string, unknown>[]).find(
			(one) => one['name'] === pkg
		);
		if (own?.['ok'] === true) return true;
	}
	return false;
}

/** enables a module, enabling each dependency the installer names first and fetching any no file provides */
async function enableWithDeps(
	enable: Enable,
	site: Local,
	module: string,
	reg: Registry,
	depth = 0
): Promise<{ ok: true } | { ok: false; error: string }> {
	const got = await enable(module);
	if (got.json['ok'] === true || got.json['alreadyEnabled'] === true) return { ok: true };
	const message = String(got.json['throwMessage'] ?? '');
	const dep = missingDependency(message);
	if (dep !== null && depth < 25) {
		const first = await enableWithDeps(enable, site, dep, reg, depth + 1);
		if (!first.ok) return first;
		return enableWithDeps(enable, site, module, reg, depth + 1);
	}
	if (/due to missing modules/.test(message) && (await provideFromRegistry(site, module, reg)))
		return enableWithDeps(enable, site, module, reg, depth + 1);
	const raw = String(got.json['raw'] ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	const why =
		message ||
		`${String(got.json['error'] ?? JSON.stringify(got.json))}${raw ? ` (output: ${raw.slice(0, 240)})` : ''}`;
	return {
		ok: false,
		error: `enabling ${module} was refused: ${why.slice(0, 400)}${got.json['throwAt'] ? ` at ${String(got.json['throwAt'])}` : ''}`
	};
}

const CAPPED = /larger than one install may take/;

/**
 * `/install?deps=1`, resumed past the per-call package cap.
 *
 * Each capped entry names a package the site did not reach; installing it with deps continues the
 * graph, and the site skips everything already installed. Open Y's tree is larger than one call.
 */
async function installWithDeps(
	site: Local,
	pkg: string,
	constraint: string | null | undefined,
	stability?: string,
	replaced: Set<string> = new Set(),
	forced: Set<string> = new Set()
): Promise<Record<string, unknown>> {
	const call = (name: string, want: string | null | undefined) =>
		site.owned(
			`/install?module=${encodeURIComponent(name)}${want ? `&version=${encodeURIComponent(want)}` : ''}&deps=1${stability ? `&stability=${stability}` : ''}${forced.has(name) ? '&force=1' : ''}`,
			{ method: 'POST' }
		);
	let first = await call(pkg, constraint);
	// a registry fetch the local runtime lost is transient; the site keeps what it already installed
	for (let i = 0; i < 2 && /Network connection lost/.test(String(first.json['error'] ?? '')); i++)
		first = await call(pkg, constraint);
	if (!Array.isArray(first.json['installed'])) return first.json;
	let results = first.json['installed'] as Record<string, unknown>[];
	for (let round = 0; round < 10; round++) {
		const capped = results.filter((r) => r['ok'] !== true && CAPPED.test(String(r['error'])));
		if (capped.length === 0) break;
		results = results.filter((r) => !capped.includes(r));
		for (const r of capped) {
			const got = await call(String(r['name']), r['constraint'] as string | null);
			results.push(
				...((got.json['installed'] as Record<string, unknown>[] | undefined) ?? [
					{ ok: false, name: r['name'], error: installFailure(got.json) }
				])
			);
		}
	}
	// a name the repository's own package replaces is satisfied once the repository is uploaded
	results = results.filter((r) => r['ok'] === true || !replaced.has(String(r['name'])));
	return { ok: results.every((r) => r['ok'] === true), name: pkg, installed: results };
}

/**
 * Delivers a module-shaped repository: the registry packages its composer file and info files name,
 * then each module uploaded and enabled with the dependencies the installer asks for. Failures are
 * collected so one verdict can say how many of the suite's modules landed.
 */
async function deliverModules(
	site: Local,
	dir: string,
	modules: string[],
	drangler: string,
	revive: () => Promise<void>,
	supplied: Record<string, string> = {},
	stability?: string,
	forced: string[] = []
): Promise<{ failures: string[]; enabled: string[] }> {
	const failures: string[] = [];
	const wanted = { ...supplied, ...composerRequires(dir), ...infoRequires(dir, modules) };
	for (const [pkg, constraint] of Object.entries(wanted)) {
		console.error(`[${dir}] registry install ${pkg} ${constraint}`);
		const got = await installWithDeps(
			site,
			pkg,
			constraint,
			stability,
			composerReplaces(dir),
			new Set(forced)
		);
		if (got['ok'] !== true)
			failures.push(
				`installing ${pkg} ${constraint} from the registry failed: ${installFailure(got)}`
			);
	}
	if (Object.keys(wanted).length > 0) await revive();
	const enable = enabler(site, revive);
	const enabled: string[] = [];
	const reg: Registry = {
		vendors: [...new Set(Object.keys(wanted).map((n) => n.split('/')[0] as string))],
		tried: new Set()
	};
	for (const module of modules) {
		const at = moduleDir(dir, module);
		if (at === null) {
			failures.push(`${module}.info.yml is not in the repository at this commit`);
			continue;
		}
		const upload = spawnSync(
			'bun',
			[
				drangler,
				'modify',
				'upload',
				'--dir',
				at,
				'--site',
				site.origin,
				'--token',
				site.owner,
				'--yes',
				'--json'
			],
			{ encoding: 'utf8', timeout: 600_000 }
		);
		if (upload.status !== 0) {
			failures.push(
				`drangler modify upload of ${module} failed: ${(upload.stderr || upload.stdout).slice(0, 240)}`
			);
			continue;
		}
		const on = await enableWithDeps(enable, site, module, reg);
		if (on.ok) enabled.push(module);
		else failures.push(on.error);
	}
	return { failures, enabled };
}

/** the routes a module suite declares, for a workflow check when the corpus names none */
function derivedChecks(dir: string, modules: string[]): string[] {
	const out = new Set<string>();
	for (const module of modules) {
		const at = moduleDir(dir, module);
		const file = at && join(at, `${module}.routing.yml`);
		if (file && existsSync(file))
			for (const p of routePaths(readFileSync(file, 'utf8'))) out.add(p);
	}
	return [...out];
}

// #endregion

// #region delivering a project, and the capability rows every repository shares

/** why an `/install` answer was not ok, from the answer alone */
function installFailure(json: Record<string, unknown>): string {
	const failed = ((json['installed'] ?? []) as Record<string, unknown>[]).filter(
		(one) => one['ok'] !== true
	);
	const why = failed
		.map(
			(one) =>
				`${String(one['name'])}: ${String(one['error'] ?? one['refused'] ?? 'refused')}`
		)
		.join('; ');
	const conflicts = ((json['conflicts'] ?? []) as Record<string, unknown>[])
		.map((c) =>
			String(
				c['detail'] ?? `${String(c['package'] ?? c['requires'])}: ${String(c['reason'])}`
			)
		)
		.join('; ');
	const refused =
		json['refused'] !== undefined ? `refused ${String(json['refused'])}: ${conflicts}` : '';
	return (why || refused || String(json['error'] ?? JSON.stringify(json))).slice(0, 2000);
}

/**
 * What is still missing from one install failure once the whole delivery has run, or null.
 *
 * A package capped or refused under one requirer is often delivered later by its own lock entry
 * (Open Y's `twig_tweak`), and a drupal.org module the site never enables cannot break it, so
 * both are dropped. Anything the line does not name as `vendor/package: reason` is kept.
 */
export function unresolvedFailure(
	line: string,
	held: ReadonlySet<string>,
	enabled: ReadonlySet<string> | undefined
): string | null {
	const m = /^(\S+) (\S*): ([\s\S]*)$/.exec(line);
	if (!m) return line;
	const left = m[3]!.split('; ').filter((part) => {
		const name = /^([a-z0-9_.-]+\/[a-z0-9_.-]+): /.exec(part)?.[1];
		if (name === undefined) return true;
		// a drupal-library lands at libraries/<name>, whichever vendor published it
		if (held.has(name) || held.has(`lib:${name.split('/')[1]}`)) return false;
		const module = /^drupal\/([a-z0-9_]+)$/.exec(name)?.[1];
		return !(module !== undefined && enabled !== undefined && !enabled.has(module));
	});
	return left.length === 0 ? null : `${m[1]} ${m[2]}: ${left.join('; ')}`;
}

/** the id of the newest node of a type carrying a title, read through the diagnostics SQL route */
async function newestNode(site: Local, type: string, title: string): Promise<string | undefined> {
	const q = `SELECT nid FROM node_field_data WHERE type = '${type.replace(/[^a-z0-9_]/g, '')}' AND title = '${title.replace(/'/g, "''")}' ORDER BY nid DESC LIMIT 1`;
	const got = await site.owned(`/sql?q=${encodeURIComponent(q)}`);
	const nid = (got.json['rows'] as { nid?: number }[] | undefined)?.[0]?.nid;
	return nid === undefined ? undefined : String(nid);
}

/** every package the site holds code or an autoload root for */
export const HELD_PACKAGES_SQL =
	"SELECT group_concat(package, '|') AS v FROM (SELECT DISTINCT package FROM cfw_module_file UNION SELECT package FROM cfw_package_autoload UNION SELECT DISTINCT 'lib:' || substr(path, 11, instr(substr(path, 11), '/') - 1) FROM cfw_module_file WHERE path LIKE 'libraries/%/%')";

/** `/enable` with the restarts the local worker needs, since it never collects the interpreters a drop leaves */
function enabler(site: Local, revive: () => Promise<void>) {
	let sinceBoot = 0;
	return async (module: string) => {
		let got = await site.owned(`/enable?module=${encodeURIComponent(module)}`, {
			method: 'POST'
		});
		sinceBoot++;
		for (
			let tries = 0;
			tries < 3 && (got.json['retry'] === true || got.status === 0);
			tries++
		) {
			if (got.status === 0) {
				await revive();
				sinceBoot = 0;
			}
			got = await site.owned(`/enable?module=${encodeURIComponent(module)}`, {
				method: 'POST'
			});
			sinceBoot++;
		}
		// after the enable, not before the next one: the renders that follow boot beside the drop too
		if (sinceBoot >= REVIVE_EVERY) {
			await revive();
			sinceBoot = 0;
		}
		return got;
	};
}

/**
 * Registry first: each required package goes through `/install?deps=1` at the version the lock
 * resolved, the modules the repository carries are uploaded, and every module the project's own
 * `core.extension` enables is enabled, in passes so a module can wait for its dependency.
 */
/** each locked package through `/install?deps=1`, in the order the plan lists them */
async function installPackages(
	site: Local,
	plan: ProjectPlan
): Promise<{ packages: number; failures: string[] }> {
	const failures: string[] = [];
	let packages = 0;
	for (const [pkg, version] of Object.entries(plan.packages)) {
		// resumed past the per-call package cap, which a distribution's tree (Open Y) exceeds
		const got = { json: await installWithDeps(site, pkg, version || null) };
		if (got.json['refused'] === 'not-found' || got.json['refused'] === 'unverifiable') {
			const why = await site.owned(
				`/installable?module=${encodeURIComponent(pkg)}${version ? `&version=${encodeURIComponent(version)}` : ''}`
			);
			got.json['conflicts'] = [{ package: pkg, reason: String(why.json['note'] ?? '') }];
		}
		console.log(
			`  install ${pkg} ${version}: ${got.json['ok'] === true ? 'ok' : installFailure(got.json).slice(0, 120)}`
		);
		if (got.json['ok'] === true) packages++;
		else failures.push(`${pkg} ${version}: ${installFailure(got.json)}`);
	}
	return { packages, failures };
}

/** every module and theme a Drupal database's core.extension enables */
/** the module and theme names in a serialized core.extension */
export function extensionNames(serialized: string): Set<string> {
	return new Set(
		[...serialized.matchAll(/s:\d+:"([a-z0-9_]+)";i:-?\d+;/g)].map((m) => m[1] as string)
	);
}

/** the packages a site holds that carry Drupal code, with core, its bundles and its scaffold left out */
export function deliveredPackages(names: readonly string[]): string[] {
	return [
		...new Set(
			names.filter(
				(n) => n.includes('/') && !/^drupal\/core(?:-|$)|recommended|scaffold/.test(n)
			)
		)
	].sort();
}

/** the machine names of the modules, themes and profiles an uploaded tree declares, tests excluded */
export function declaredNames(paths: readonly string[]): string[] {
	return [
		...new Set(
			paths
				.filter((p) => !/(^|\/)tests?\//.test(p))
				.map((p) => /([a-z0-9_]+)\.info\.yml$/.exec(p)?.[1])
				.filter((n): n is string => n !== undefined)
		)
	].sort();
}

/** what the lane delivered, read from the site's own file table rather than inferred from the plan */
export const DELIVERED_PACKAGES_SQL =
	"SELECT group_concat(package, '|') AS v FROM (SELECT DISTINCT package FROM cfw_module_file WHERE package LIKE '%/%' AND (path LIKE 'modules/contrib/%' OR path LIKE 'themes/contrib/%' OR path LIKE 'profiles/contrib/%'))";
export const DELIVERED_CUSTOM_SQL =
	"SELECT group_concat(path, '|') AS v FROM cfw_module_file WHERE package NOT LIKE '%/%' AND path LIKE '%.info.yml'";

async function readDelivered(site: Local): Promise<{ packages: string[]; custom: string[] }> {
	const one = async (q: string) => {
		const got = await site.owned(`/sql?q=${encodeURIComponent(q)}`);
		return String((got.json['rows'] as { v?: string }[] | undefined)?.[0]?.v ?? '');
	};
	return {
		packages: deliveredPackages((await one(DELIVERED_PACKAGES_SQL)).split('|').filter(Boolean)),
		custom: declaredNames((await one(DELIVERED_CUSTOM_SQL)).split('|').filter(Boolean))
	};
}

/** what each driven site was delivered, keyed by fixture */
const deliveredBy = new Map<string, { packages: string[]; custom: string[] }>();

/** what each driven site enabled when its run ended, keyed by fixture */
const enabledBy = new Map<string, string[]>();

export function enabledExtensions(db: string): Set<string> {
	// not readOnly: under bun a read-only open of a WAL database with no -shm file cannot create one
	const conn = new DatabaseSync(db);
	try {
		const row = conn.prepare("SELECT data FROM config WHERE name = 'core.extension'").get() as
			{ data?: Uint8Array | string } | undefined;
		return extensionNames(
			typeof row?.data === 'string'
				? row.data
				: new TextDecoder().decode(row?.data ?? new Uint8Array())
		);
	} finally {
		conn.close();
	}
}

/** sends the plan's profile and custom code with drangler modify upload */
async function uploadCustom(
	site: Local,
	plan: ProjectPlan,
	drangler: string,
	revive?: () => Promise<void>
): Promise<{ uploaded: number; failures: string[] }> {
	const failures: string[] = [];
	let uploaded = 0;
	for (const code of plan.custom) {
		const send = () =>
			spawnSync(
				'bun',
				[
					drangler,
					'modify',
					'upload',
					'--dir',
					code.dir,
					'--site',
					site.origin,
					'--token',
					site.owner || 'pw-diagnostics',
					'--yes',
					'--json'
				],
				{ encoding: 'utf8', timeout: 600_000 }
			);
		let up = send();
		// a 1,030-blob profile (farmOS) can outlast the local runtime; the blobs already sent stay
		if (up.status !== 0 && revive && lostServer(new Error(up.stderr || up.stdout))) {
			await revive();
			up = send();
		}
		if (up.status === 0) uploaded++;
		else
			failures.push(
				`${code.name}: upload failed: ${(up.stderr || up.stdout).replace(/\s+/g, ' ').slice(-420)}`
			);
	}
	return { uploaded, failures };
}

async function deliverProject(
	site: Local,
	plan: ProjectPlan,
	drangler: string,
	revive: () => Promise<void>,
	installed?: { packages: number; failures: string[] },
	uploadedBefore?: { uploaded: number; failures: string[] },
	siteModules?: Set<string>
): Promise<{ state: RowState; note: string; enabled: number; wanted: number }> {
	const done = installed ?? (await installPackages(site, plan));
	// a package whose module the migrated site never enabled cannot break it (drupalx's amazee.io
	// provider needs ext-pgsql), so it is named as skipped rather than counted as a failure
	const unused = siteModules
		? done.failures.filter((f) => {
				const name = /^drupal\/([a-z0-9_]+)/.exec(f)?.[1];
				return name !== undefined && !siteModules.has(name);
			})
		: [];
	const heldRows = await site.owned(`/sql?q=${encodeURIComponent(HELD_PACKAGES_SQL)}`);
	const held = new Set(
		String((heldRows.json['rows'] as { v?: string }[] | undefined)?.[0]?.v ?? '')
			.split('|')
			.filter(Boolean)
	);
	const failures = done.failures
		.filter((f) => !unused.includes(f))
		.map((f) => unresolvedFailure(f, held, siteModules))
		.filter((f): f is string => f !== null);
	const packages = done.packages;
	const sent = uploadedBefore ?? (await uploadCustom(site, plan, drangler, revive));
	const uploaded = sent.uploaded;
	failures.push(...sent.failures);
	const enabled = new Set<string>();
	let pending = [...plan.modules];
	const why = new Map<string, string>();
	const enable = enabler(site, revive);
	for (let pass = 0; pass < 4 && pending.length > 0; pass++) {
		const next: string[] = [];
		for (const module of pending) {
			const got = await enable(module);
			const done = got.json['ok'] === true || got.json['alreadyEnabled'] === true;
			console.log(
				`  enable ${module}: ${done ? 'ok' : String(got.json['throwMessage'] ?? got.json['error'] ?? 'refused').slice(0, 120)}`
			);
			if (done) enabled.add(module);
			else {
				next.push(module);
				why.set(module, String(got.json['throwMessage'] ?? got.json['error'] ?? 'refused'));
			}
		}
		if (next.length === pending.length) {
			// modules whose config each needs the other's (atelier's aincient_audit and aincient_flows)
			// only install together, in one call
			if (next.length > 1 && next.every((m) => /unmet dependencies/.test(why.get(m) ?? ''))) {
				const got = await site.owned(
					`/enable?module=${encodeURIComponent(next[0] as string)}&with=${encodeURIComponent(next.slice(1).join(','))}`,
					{ method: 'POST' }
				);
				console.log(
					`  enable ${next.join(' + ')} together: ${got.json['ok'] === true ? 'ok' : String(got.json['throwMessage'] ?? got.json['error'] ?? 'refused').slice(0, 120)}`
				);
				if (got.json['ok'] === true) {
					for (const m of next) enabled.add(m);
					pending = [];
				}
			}
			break;
		}
		pending = next;
	}
	await revive();
	for (const module of pending) failures.push(`enable ${module}: ${why.get(module)}`);
	const stats = await site.owned('/serve-stats');
	const rows = /"rowsToday":\s*(\d+)/.exec(JSON.stringify(stats.json))?.[1];
	const note = [
		failures.length > 0 ? `${failures.length} failed: ${failures.slice(0, 4).join(' | ')}` : '',
		`${packages}/${Object.keys(plan.packages).length} registry packages`,
		`${uploaded}/${plan.custom.length} custom uploaded`,
		`${enabled.size}/${plan.modules.length} modules enabled`,
		plan.patches > 0 ? `${plan.patches} composer patches not applied` : '',
		unused.length > 0
			? `${unused.length} not enabled on the site, skipped: ${unused.map((f) => f.split(' ')[0]).join(', ')}`
			: '',
		rows
			? `${rows} rows written by the delivery (free allows ${FREE_DAILY_ROWS.toLocaleString('en-US')} a day)`
			: '',
		process.env.CORPUS_PLAN ? `run with PLAN=${process.env.CORPUS_PLAN}` : ''
	]
		.filter(Boolean)
		.join('; ')
		.slice(0, 1500);
	const state: RowState =
		failures.length > 0 ? 'unsupported' : plan.patches > 0 ? 'degraded' : 'inline';
	return { state, note, enabled: enabled.size, wanted: plan.modules.length };
}

/**
 * Enables between restarts of the local worker, which never collects the interpreters it drops. One:
 * a large module's enable leaves a 122 MiB interpreter behind, and the very next boot beside it took
 * wrangler down (mantle2, islandora, atelier, 2026-09-29).
 */
const REVIVE_EVERY = 1;

const TINY_PNG = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
	),
	(c) => c.charCodeAt(0)
);

const unescapeHtml = (text: string) =>
	text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&amp;/g, '&');

/** the status or error messages Drupal printed on a page, as plain text */
function messagesOf(body: string): string {
	const found = [...body.matchAll(/class="messages[^"]*"[\s\S]{0,900}?<\/div>/g)]
		.map((m) =>
			m[0]
				.replace(/<[^>]+>/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
		)
		// update status repeats its notice on every admin page; it says nothing about the form
		.filter((m) => !/There (is a security update|are updates) available/.test(m));
	return found.length > 0 ? found.join(' | ').slice(0, 400) : 'no message on the page';
}

/** whether an updb drain answer says another beat is owed */
/** the halt a drain ended on, which answers 200 with no `error`; null when the last beat ran clean */
export function haltedBeat(json: Record<string, unknown>): string | null {
	const beats = ((json['ran'] as { beats?: Record<string, unknown>[] } | undefined)?.beats ??
		[]) as Record<string, unknown>[];
	const last = beats[beats.length - 1];
	if (last === undefined || last['ok'] !== false) return null;
	return `the run halted: ${String(last['reason'] ?? last['kind'])}${last['detail'] ? `: ${String(last['detail']).slice(0, 240)}` : ''}`;
}

function moreBeats(json: Record<string, unknown>): boolean {
	const beats = ((json['ran'] as { beats?: { more?: boolean }[] } | undefined)?.beats ?? []) as {
		more?: boolean;
	}[];
	return beats.length > 0 && beats[beats.length - 1]?.more === true;
}

/** the markup of the one form on a page whose `form_id` is given, so its hidden fields stand alone */
export function formHtml(body: string, formId: string): string | null {
	for (const form of body.match(/<form[\s\S]*?<\/form>/g) ?? [])
		if (form.includes(`name="form_id" value="${formId}"`)) return form;
	// the whole page would post whichever form comes first, which pressed Save on the performance page
	return null;
}

/** the excerpt of a page a verdict is taken from, with markup and blank runs removed */
const excerpt = (body: string, at: RegExp) => {
	const i = body.search(at);
	return body
		.slice(Math.max(0, i - 40), i + 200)
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
};

/**
 * The rows beyond a render, each taken from something the site did: a multipart upload read back
 * from the file store, cron run from the administration form, the update chain drained, the caches
 * cleared, a single configuration item imported and read back, and the update module's fetch.
 */
async function driveCapabilities(
	site: Local,
	set: (row: string, state: RowState, note?: string) => void
): Promise<void> {
	const guarded = async (row: string, run: () => Promise<void>) => {
		try {
			await run();
		} catch (e) {
			set(
				row,
				'unsupported',
				`the probe threw: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`
			);
		}
	};

	await guarded('file rw', async () => {
		const form = await site.page('/media/add/image', true);
		if (form.res.status !== 200 || !form.body.includes('files[field_media_image_0]')) {
			// no media form on this site: write through public:// and read back from a dropped interpreter
			const tag = crypto.randomUUID();
			const w = await site.owned(`/files?op=write&body=${tag}`);
			const r = await site.owned('/files?op=read&drop=1');
			const same = w.json['ok'] === true && r.json['body'] === tag;
			set(
				'file rw',
				same ? 'inline' : 'unsupported',
				same
					? 'written through public:// and read back after the interpreter was dropped; the site has no media image form'
					: `the site has no media image form (/media/add/image answered ${form.res.status}); the file store probe: write ${w.status}, read ${r.status}`
			);
			return;
		}
		const file = {
			field: 'files[field_media_image_0]',
			name: 'corpus.png',
			type: 'image/png',
			bytes: TINY_PNG
		};
		let sent = await site.upload(
			'/media/add/image',
			{
				...hiddenFields(form.body),
				...requiredText(form.body),
				'field_media_image[0][alt]': 'corpus',
				op: 'Save'
			},
			file
		);
		// fields the site flags as invalid (openculturas asks for a licence source) are filled once, the
		// way the administrator would, and the form is sent again
		const flagged = sent.res.status === 200 ? filledFlags(sent.body) : {};
		if (Object.keys(flagged).length > 0)
			sent = await site.upload(
				'/media/add/image',
				{
					...hiddenFields(sent.body),
					...requiredText(sent.body),
					'field_media_image[0][alt]': 'corpus',
					...flagged,
					op: 'Save'
				},
				file
			);
		// what the site stored, read from its own tables rather than from whichever page links it
		const stored = await site.owned(
			`/sql?q=${encodeURIComponent("SELECT f.uri AS uri FROM media__field_media_image m JOIN file_managed f ON f.fid = m.field_media_image_target_id WHERE f.filename LIKE 'corpus%' ORDER BY f.fid DESC LIMIT 1")}`
		);
		const uri = (stored.json['rows'] as { uri?: string }[] | undefined)?.[0]?.uri;
		const href = uri?.startsWith('public://')
			? `/sites/default/files/${uri.slice('public://'.length)}`
			: null;
		const back = href ? await fetch(new URL(href, site.origin)) : null;
		const bytes = back ? new Uint8Array(await back.arrayBuffer()) : new Uint8Array();
		const same = back?.status === 200 && bytes.length === TINY_PNG.length;
		// a re-rendered form carries its own errors; only a redirect needs the next page fetched
		const after =
			uri || sent.res.status === 200 ? sent : await site.page('/media/add/image', true);
		set(
			'file rw',
			same ? 'inline' : 'unsupported',
			same
				? 'a multipart image upload through the media form was stored and read back byte for byte'
				: uri
					? `the media was saved at ${uri} and ${href} answered ${back?.status} with ${bytes.length} bytes`
					: `upload answered ${sent.res.status} and no media row names the file; ${messagesOf(after.body)}${errorFieldNames(after.body).length > 0 ? `; flagged fields: ${errorFieldNames(after.body).join(', ')}` : ''}`
		);
	});

	await guarded('queue cron', async () => {
		const page = await site.page('/admin/config/system/cron', true);
		const ran = await site.post('/admin/config/system/cron', {
			...hiddenFields(page.body),
			op: 'Run cron'
		});
		const after = await site.page('/admin/config/system/cron', true);
		const redirected = ran.res.status >= 300 && ran.res.status < 400;
		const logged = /Cron run completed/.test(
			(await site.page('/admin/reports/dblog', true)).body
		);
		const ok = /Cron ran successfully/.test(after.body) || logged;
		set(
			'queue cron',
			ok ? 'inline' : 'unsupported',
			ok
				? logged
					? 'cron ran from the administration form and the log records Cron run completed'
					: undefined
				: `the run answered ${ran.res.status}; ${messagesOf(redirected ? after.body : ran.body)}; the log has no Cron run completed entry`
		);
	});

	await guarded('update', async () => {
		// a wrangler restart leaves no resident interpreter, so a halted first run is retried once warm
		let bad: { status: number; json: Record<string, unknown> } | undefined;
		let prepared = { status: 0, json: {} as Record<string, unknown> };
		let drained = prepared;
		for (let attempt = 0; attempt < 2; attempt++) {
			await site.page('/admin/modules', true);
			prepared = await site.owned('/updb?action=prepare', { method: 'POST' });
			drained = await site.owned('/updb?action=drain', { method: 'POST' });
			for (let i = 0; i < 120 && drained.status === 200 && moreBeats(drained.json); i++)
				drained = await site.owned('/updb?action=drain', { method: 'POST' });
			bad = [prepared, drained].find(
				(r) =>
					r.status !== 200 || r.json['error'] !== undefined || haltedBeat(r.json) !== null
			);
			if (!bad) break;
			// abandon needs a written reason, and leaves the site fenced; a run halted by a dev server
			// restart (unit-unverifiable) is retried once on a clean slate
			await site.owned(
				`/updb?action=abandon&reason=${encodeURIComponent('corpus lane retry after a halted run')}`,
				{ method: 'POST' }
			);
			await site.owned('/ops?op=state-set&arg=system.maintenance_mode&arg=0');
		}
		set(
			'update',
			bad ? 'unsupported' : 'inline',
			bad
				? (haltedBeat(bad.json) ?? JSON.stringify(bad.json).slice(0, 300))
				: updateNote(prepared.json, drained.json)
		);
	});

	await guarded('cache rebuild', async () => {
		const page = await site.page('/admin/config/development/performance', true);
		// the page carries two forms; the button belongs to the clear-cache one, and posting the
		// other's form_id runs Save configuration instead
		const form = formHtml(page.body, 'system_clear_cache');
		if (form === null) {
			set(
				'cache rebuild',
				'unknown',
				'the performance page carried no system_clear_cache form'
			);
			return;
		}
		const posted = await site.post('/admin/config/development/performance', {
			...hiddenFields(form),
			op: 'Clear all caches'
		});
		const shown = await site.page('/admin/config/development/performance', true);
		let home = await site.page('/');
		for (let i = 0; i < 20 && home.res.status === 503; i++) {
			await site.owned('/fill');
			await new Promise((r) => setTimeout(r, 2000));
			home = await site.page('/');
		}
		// a front page set to another path (govcms and thunder use /user/login) answers a redirect
		const moved = home.res.headers.get('location');
		if ([301, 302, 303, 307].includes(home.res.status) && moved !== null) {
			const target = new URL(moved, site.origin);
			if (target.origin === site.origin)
				home = await site.page(target.pathname + target.search);
		}
		// a front page for signed-in users (farmOS) refuses anonymous visitors by design
		if (home.res.status === 403 || home.res.status === 404)
			home = await site.page('/user/login');
		const cleared = /Caches cleared/.test(shown.body);
		const ok = cleared && home.res.status === 200 && !ERROR_PAGE.test(home.body);
		set(
			'cache rebuild',
			ok ? 'inline' : 'unsupported',
			ok
				? undefined
				: cleared
					? `/ answered ${home.res.status} after the clear`
					: `the clear answered ${posted.res.status} without the Caches cleared message; ${messagesOf(shown.body)}`
		);
	});

	await guarded('config import', async () => {
		const exportPath =
			'/admin/config/development/configuration/single/export/system.simple/system.site';
		let exported = await site.page(exportPath, true);
		// the config UI is core's config module, which a site that deploys config another way leaves off
		if (exported.res.status === 404) {
			await site.owned('/enable?module=config', { method: 'POST' });
			exported = await site.page(exportPath, true);
		}
		const yaml = /<textarea[^>]*name="export"[^>]*>([\s\S]*?)<\/textarea>/.exec(
			exported.body
		)?.[1];
		if (exported.res.status !== 200 || yaml === undefined) {
			set(
				'config import',
				'unsupported',
				`the single export answered ${exported.res.status} without the item`
			);
			return;
		}
		const changed = unescapeHtml(yaml).replace(
			/^slogan:.*$/m,
			"slogan: 'config-import-corpus'"
		);
		const form = await site.page('/admin/config/development/configuration/single/import', true);
		const asked = await site.post('/admin/config/development/configuration/single/import', {
			// scoped: a page carrying a second form (varbase) posted that form's build id instead
			...hiddenFields(formHtml(form.body, 'config_single_import_form') ?? form.body),
			config_type: 'system.simple',
			config_name: 'system.site',
			import: changed,
			op: 'Import'
		});
		const confirmed = await site.post('/admin/config/development/configuration/single/import', {
			...hiddenFields(formHtml(asked.body, 'config_single_import_form') ?? asked.body),
			op: 'Confirm'
		});
		await site.batch(confirmed.res.headers.get('location'));
		// the last batch hop can take the dev server down, and the read then lands on a restart
		let info = await site.page('/admin/config/system/site-information', true);
		for (let i = 0; i < 6 && info.res.status !== 200; i++) {
			await new Promise((r) => setTimeout(r, 5000));
			info = await site.page('/admin/config/system/site-information', true);
		}
		const ok = info.res.status === 200 && info.body.includes('config-import-corpus');
		set(
			'config import',
			ok ? 'inline' : 'unsupported',
			ok
				? 'system.site was imported from YAML and read back'
				: `import answered ${asked.res.status}, confirm ${confirmed.res.status}, read ${info.res.status}; ${messagesOf(asked.body)} | ${messagesOf(confirmed.body)}; posted ${changed.length} characters into a form with fields ${[...form.body.matchAll(/<(?:input|textarea|select)[^>]*name="([^"]+)"/g)].map((m) => m[1]).join(', ')}`
		);
	});

	await guarded('outbound http', async () => {
		const check = async () => {
			await site.page('/admin/reports/updates/check', true);
			const report = await site.page('/admin/reports/updates', true);
			const failed = /Failed to get available update data|unable to fetch/i.test(report.body);
			return { report, ok: /Last checked/i.test(report.body) && !failed };
		};
		let got = await check();
		if (got.ok) {
			set(
				'outbound http',
				'parked',
				'the update check fetched from the registry through the parked fetch'
			);
			return;
		}
		// a refused park falls back to the deferred queue, which the next drain answers
		for (let i = 0; i < 6; i++) {
			const drained = await site.owned('/httpdrain');
			if (Number(drained.json['remaining'] ?? 0) === 0) break;
		}
		got = await check();
		set(
			'outbound http',
			got.ok ? 'degraded' : 'unsupported',
			got.ok
				? 'the update check needed its fetch drained from the deferred queue before data arrived'
				: excerpt(got.report.body, /Failed to get|Last checked|updates/i)
		);
	});
}

// #endregion

// #region migrating an installed distribution

const nativeDir = () => join(import.meta.dir, 'corpus-native');
const NATIVE_IMAGE = 'corpus-native';

/** the shared box is being timed while this directory exists; heavy steps wait it out */
export function waitForTimingLock(lock = '/tmp/paisley-timing.lock'): void {
	while (existsSync(lock)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
}

/**
 * Installs a repository natively in Docker, the state a customer's server is in.
 *
 * The result is `<out>/site.sqlite` beside the composer tree it was installed from. A failed install
 * is returned with its output tail, because that failure is the repository's row, not the lane's.
 */
export function nativeInstall(
	repo: RepoEntry,
	cloneDir: string,
	out: string
): { ok: true; out: string } | { ok: false; why: string } {
	if (existsSync(join(out, 'site.sqlite'))) return { ok: true, out };
	waitForTimingLock();
	const plan = nativePlan(cloneDir, projectPlan(cloneDir));
	// a failed attempt leaves a tree `create-project` refuses to write into; kept for its log
	if (existsSync(join(out, 'site')))
		renameSync(join(out, 'site'), join(out, `site.failed-${Date.now()}`));
	mkdirSync(out, { recursive: true });
	spawnSync('docker', ['build', '-q', '-t', NATIVE_IMAGE, nativeDir()], { encoding: 'utf8' });
	const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
	const ran = spawnSync(
		'docker',
		[
			'run',
			'--rm',
			'--user',
			uid,
			'--memory',
			'4g',
			'--cpus',
			'4',
			'--cpu-shares',
			'128',
			'-e',
			`KIND=${plan.kind}`,
			'-e',
			`PROFILE=${plan.profile}`,
			'-e',
			`PROFILE_PKG=${plan.pkg ?? ''}`,
			'-e',
			`TEMPLATE=${plan.template ?? ''}`,
			'-e',
			`CORE=${repo.core}`,
			'-e',
			`RECIPES=${(repo.recipes ?? []).join(' ')}`,
			'-e',
			`RECIPE_REQUIRES=${Object.entries(repo.recipe_requires ?? {})
				.flatMap(([recipe, deps]) => deps.map((dep) => `${recipe}:${dep}`))
				.join(' ')}`,
			'-e',
			`INSTALL_ARGS=${(repo.install_args ?? []).join(' ')}`,
			'-e',
			`OMIT=${(repo.omit ?? []).join(' ')}`,
			'-v',
			`${out}:/out`,
			'-v',
			`${cloneDir}:/clone:ro`,
			'-v',
			`${join(nativeDir(), 'install.sh')}:/install.sh:ro`,
			NATIVE_IMAGE,
			'bash',
			'/install.sh'
		],
		{ encoding: 'utf8', timeout: 60 * 60_000, maxBuffer: 64 * 1024 * 1024 }
	);
	if (ran.status === 0 && existsSync(join(out, 'site.sqlite'))) return { ok: true, out };
	const log = join(out, 'install.log');
	const lines = (existsSync(log) ? readFileSync(log, 'utf8') : `${ran.stdout}\n${ran.stderr}`)
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l && !/^-\s+Installing|^\d+ package/.test(l));
	const tail = nativeCause(lines);
	return {
		ok: false,
		why: `native install of ${plan.kind} ${plan.profile}${plan.template ? ` from ${plan.template}` : ''} failed: ${tail}`.slice(
			0,
			700
		)
	};
}

/** what a migrated site needs delivered: its locked contrib, the profile, and any custom code */
function migratedPlan(cloneDir: string, out: string, repo: RepoEntry): ProjectPlan {
	const site = join(out, 'site');
	const own = projectPlan(cloneDir);
	const native = projectPlan(site);
	const profile = nativePlan(cloneDir, own).profile;
	const at = moduleDir(cloneDir, profile);
	return {
		profile,
		packages: lockedContrib(site, profile, Object.keys(repo.requires ?? {})),
		custom: [
			...(at === null ? [] : [{ name: profile, dir: at, kind: 'module' as const }]),
			...native.custom.filter((c) => c.name !== profile)
		],
		modules: [],
		patches: Math.max(own.patches, native.patches)
	};
}

/** files the migrated database replaces in the worker tree, restored when the run ends */
const SWAPPED = ['assets/drupal/site.sqlite', 'assets/.assetsignore'];

/** copies the swapped files aside and returns where each went; the restore removes the copies */
export function setAside(root: string): (file: string) => string {
	const aside = join(root, '.corpus-swap');
	const kept = (f: string) => join(aside, f.replace(/\W/g, '_'));
	mkdirSync(aside, { recursive: true });
	// a copy still aside means a killed run never restored, and the tree holds its database; setting
	// that aside instead handed every later fixture on the tree another site's pack
	for (const f of SWAPPED) if (existsSync(kept(f))) copyFileSync(kept(f), join(root, f));
	for (const f of SWAPPED) copyFileSync(join(root, f), kept(f));
	return kept;
}

/**
 * Lands the installed database through `drangler migrate install --db` and returns the restore.
 *
 * The worker tree is the lane's workspace, so the files the install rewrites are copied aside first
 * and put back, with the chunks rebuilt, once the repository has been driven.
 */
export function landDatabase(root: string, db: string, drangler: string): () => void {
	const aside = join(root, '.corpus-swap');
	const kept = setAside(root);
	// the front-end libraries the native build fetched from the project's own package repositories,
	// which no registry serves; `--code` carries them inside the database the way production does
	const libraries = nativeLibraries(dirname(db));
	const code = libraries === null ? null : join(aside, 'code');
	if (code !== null) {
		mkdirSync(code, { recursive: true });
		const link = join(code, 'libraries');
		if (!existsSync(link)) symlinkSync(libraries!, link);
	}
	const run = (args: string[]) => {
		const r = spawnSync('bun', args, { cwd: root, encoding: 'utf8', timeout: 30 * 60_000 });
		if (r.status !== 0)
			throw new Error(`${args.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout).slice(-300)}`);
	};
	try {
		run([
			drangler,
			'migrate',
			'install',
			'--db',
			db,
			...(code === null ? [] : ['--code', code]),
			'--repack',
			'--resume',
			'--checkpoint',
			join(aside, 'checkpoint.json'),
			'--workspace',
			root
		]);
	} catch (e) {
		restore();
		throw e;
	}
	function restore() {
		for (const f of SWAPPED) {
			copyFileSync(kept(f), join(root, f));
			rmSync(kept(f));
		}
		spawnSync('bun', ['run', 'assets:sql'], {
			cwd: root,
			encoding: 'utf8',
			timeout: 30 * 60_000
		});
	}
	return restore;
}

/** the native build's `libraries/`, under whichever docroot the project uses, or null */
export function nativeLibraries(out: string): string | null {
	for (const docroot of ['web', 'docroot', 'html', 'public']) {
		const dir = join(out, 'site', docroot, 'libraries');
		if (existsSync(dir)) return resolve(dir);
	}
	return null;
}

// #endregion

async function driveRepo(
	repo: RepoEntry,
	corpus: Corpus,
	workRoot: string,
	port: number,
	migrated?: { out: string; base?: RepoEntry }
): Promise<RepoResult['rows']> {
	const rows = unknownRows(corpus.rows);
	const set = (row: string, state: RowState, note?: string) => {
		const known = repo.notes?.[row];
		const cause =
			state === 'unsupported' && /answered 5\d\d/.test(note ?? '')
				? lastError(dev.logFile)
				: undefined;
		const text = [note, cause, state === 'inline' ? undefined : known]
			.filter(Boolean)
			.join('; ');
		rows[row] = text ? { state, note: text } : { state };
	};
	const dir = join(workRoot, repo.id);
	clone(repo, dir);
	const remote = deployedOrigin(process.argv, process.env);
	const boot = (stateDir?: string) =>
		startDevServer({
			label: `corpus-${repo.id}`,
			port,
			vars: {
				PW_DIAGNOSTICS: '1',
				...(process.env.CORPUS_PLAN ? { PLAN: process.env.CORPUS_PLAN } : {})
			},
			keep: true,
			...(stateDir ? { stateDir } : {})
		});
	const drangler =
		process.env.DRANGLER ??
		join(import.meta.dir, '..', '..', '..', 'drangler', 'src', 'cli.ts');
	const workerRoot = join(import.meta.dir, '..', '..');
	// a deployed worker already carries its database (corpus-deploy.ts landed it before the deploy)
	const restoreDb =
		migrated && !remote
			? landDatabase(workerRoot, join(migrated.out, 'site.sqlite'), drangler)
			: () => undefined;
	let dev: DevServer = remote ? remoteServer(remote) : await boot();
	const revive = async () => {
		// a deployed object has no process to restart; the pause lets one the platform reset come back
		if (remote) return void (await new Promise((r) => setTimeout(r, 2000)));
		const { stateDir } = dev;
		dev.stop();
		for (let attempt = 0; ; attempt++) {
			await new Promise((r) => setTimeout(r, 3000));
			try {
				dev = await boot(stateDir);
				return;
			} catch (e) {
				if (attempt >= 2) throw e;
			}
		}
	};
	try {
		for (let i = 0; i < 100; i++) {
			const m = await fetch(new URL('/migrate?all=1', dev.origin));
			const body = (await m.json().catch(() => ({}))) as { done?: boolean };
			if (body.done) break;
		}
		// a migrated database names modules whose code is not delivered yet, and the claim boots a
		// kernel over it (varbase: Class "ctools_views_config_..." does not exist), so the registry
		// packages go in first; `/install` is reachable before the claim here because the lane runs
		// with PW_DIAGNOSTICS
		const migratedPlanned = migrated
			? migrated.base
				? migratedPlan(join(workRoot, migrated.base.id), migrated.out, migrated.base)
				: migratedPlan(dir, migrated.out, repo)
			: null;
		const preinstalled = migratedPlanned
			? await installPackages(
					Object.assign(new Local(dev.origin, ''), { onLost: revive }),
					migratedPlanned
				)
			: undefined;
		// the profile and custom code go in before the claim too: the claim boots Drupal, and a
		// database naming profiles/herbie fails to parse a profile that is not there yet
		const preuploaded = migratedPlanned
			? await uploadCustom(new Local(dev.origin, ''), migratedPlanned, drangler, revive)
			: undefined;
		if (preuploaded) await revive();
		if (preinstalled) await revive();
		const pass = `corpus-${crypto.randomUUID()}`;
		// a large migrated database is still replaying after the polls above, and the claim answers
		// 503 until it is done; an empty token was then passed on silently and every upload refused
		let claim: Response;
		let claimText = '';
		for (let tries = 0; ; tries++) {
			const claimStart = Date.now();
			claim = await fetch(new URL('/firstrun', dev.origin), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					adminName: 'admin',
					adminPass: pass,
					siteName: `corpus ${repo.id}`
				})
			});
			claimText = await claim.text();
			console.log(`  claim answered ${claim.status} in ${Date.now() - claimStart} ms`);
			// wrangler answers a request its proxy lost as a 500 and exits, so the claim is retried on a restart
			if (claim.status === 500 && lostServer(new Error(claimText)) && tries < 3) {
				await revive();
				continue;
			}
			if (claim.status !== 503 || tries >= 150) break;
			await new Promise((r) => setTimeout(r, 2000));
		}
		const owner = await claimOwner(dev.origin, claim.status, claimText, pass);
		if (owner === '') writeFileSync(join(tmpdir(), `cfw-claim-${repo.id}.json`), claimText);
		if (owner === '')
			throw new Error(
				`/firstrun answered ${claim.status} with no owner token: ${claimText.slice(0, 3000)}`
			);
		const site = new Local(dev.origin, owner);
		site.onLost = revive;

		const delivered = migratedPlanned
			? await deliverProject(
					site,
					migratedPlanned,
					drangler,
					revive,
					preinstalled,
					preuploaded,
					migrated ? enabledExtensions(join(migrated.out, 'site.sqlite')) : undefined
				)
			: repo.install === 'project'
				? await deliverProject(
						site,
						projectPlan(join(dir, repo.root ?? '.')),
						drangler,
						revive
					)
				: null;
		const modules = repo.modules ?? [];
		const modular =
			repo.install === 'modify' && (!delivered || migrated?.base !== undefined)
				? await deliverModules(
						site,
						dir,
						modules,
						drangler,
						revive,
						repo.requires,
						repo.stability,
						repo.force
					)
				: null;
		if (modular && modules.length > 0 && modular.enabled.length === 0) {
			const why = modular.failures.join('; ');
			for (const row of corpus.rows)
				set(
					row,
					'unsupported',
					row === 'install' ? why : `blocked by install: ${why.slice(0, 300)}`
				);
			return rows;
		}
		if (delivered && migrated) {
			set(
				'install',
				delivered.state,
				`${delivered.note}; migrated: native install, database landed through migrate install, profile and custom code uploaded`
			);
		} else if (delivered) {
			set('install', delivered.state, delivered.note);
			// a project that enables nothing still boots a container; the renders below score it
			if (delivered.wanted > 0)
				set(
					'container build',
					delivered.enabled > 0 ? 'inline' : 'unsupported',
					delivered.enabled > 0
						? 'the container was rebuilt by the enables'
						: 'no module enabled'
				);
		} else if (modular) {
			const { failures, enabled } = modular;
			if (failures.length === 0) set('install', 'inline');
			else if (enabled.length === modules.length)
				set(
					'install',
					'inline',
					`all ${modules.length} modules enabled; the registry reported ${failures.join('; ')}`
				);
			else
				set(
					'install',
					'unsupported',
					`${failures.join('; ')}; ${enabled.length} of ${modules.length} modules enabled`
				);
			set('container build', 'inline', 'the container was rebuilt by the enable');
		} else {
			set('install', 'inline');
		}

		let anon = await site.page('/');
		// a site whose front page is for signed-in users (farmOS) refuses anonymous visitors on
		// purpose; its login page is the anonymous render then
		// and one set to content the install does not carry (openculturas' /node/100) is a 404 natively
		const front = anon.res.status;
		const refused = front === 403 || front === 404;
		if (refused) anon = await site.page('/user/login');
		const anonOk = anon.res.status === 200 && !ERROR_PAGE.test(anon.body);
		set(
			'anon render',
			anonOk ? 'inline' : 'unsupported',
			anonOk
				? refused
					? `/ answered ${front} (${front === 403 ? 'a front page for signed-in users' : 'a front page set to content this install does not carry'}), so /user/login was rendered anonymously`
					: undefined
				: `${refused ? '/user/login' : '/'} answered ${anon.res.status}`
		);
		if (migrated)
			set(
				'container build',
				anonOk ? 'inline' : 'unsupported',
				'the container was built on the first boot over the migrated database'
			);
		else if (delivered && delivered.wanted === 0)
			set(
				'container build',
				anonOk ? 'inline' : 'unsupported',
				'the project enables no module, so the container is the one the first boot built'
			);

		const form = await site.page('/user/login');
		const login = await site.post('/user/login', {
			// scoped to the login form: a page that also carries another form's build id breaks the post
			...hiddenFields(formHtml(form.body, 'user_login_form') ?? form.body),
			name: 'admin',
			pass,
			op: 'Log in'
		});
		site.cookie = sessionFrom(login.res.headers.getSetCookie()) ?? '';
		// every authenticated row fails after a login that set no session, so say why once
		const noSession =
			site.cookie === ''
				? `the login answered ${login.res.status} with no session cookie; ${messagesOf(login.body)}`
				: undefined;
		const gate = await acceptInterstitial(site);
		const admin = await site.reach('/admin/modules', true);
		const listed = (modular ? modular.enabled : modules).every((m) =>
			admin.body.includes(`edit-modules-${m.replace(/_/g, '-')}-enable`)
		);
		const reached = admin.res.status === 200 && listed;
		// a redirect that keeps the probe from its page is not an incompatibility until its cause is known
		const stopped = !reached && admin.via.length > 0;
		const walled = gate.via.length > 0 ? (gate.via[gate.via.length - 1] as string) : null;
		set(
			'auth render',
			reached ? 'inline' : stopped ? 'unknown' : 'unsupported',
			reached
				? gate.accepted
					? `the administrator accepted ${gate.accepted}, which the site puts in front of every admin page, before the probes`
					: undefined
				: stopped
					? `/admin/modules was redirected to ${admin.via.join(' then ')} and the probe never reached it (${admin.res.status})`
					: [`/admin/modules answered ${admin.res.status}`, noSession]
							.filter(Boolean)
							.join('; ')
		);

		if (modular) await revive();
		const listing = await site.page('/node/add', true);
		const type =
			contentTypeFrom(listing.body) ??
			/\/node\/add\/([a-z0-9_]+)/.exec(listing.res.headers.get('location') ?? '')?.[1] ??
			'page';
		const add = await site.page(`/node/add/${type}`, true);
		const nodeForm = formHtml(add.body, `node_${type}_form`) ?? add.body;
		const created = await site.post(`/node/add/${type}`, {
			...formValues(nodeForm),
			...hiddenFields(add.body),
			...requiredText(add.body),
			'title[0][value]': 'corpus',
			'body[0][value]': 'corpus',
			op: 'Save'
		});
		// a save redirects wherever the site sends it (Open Y's activity goes to its listing), so a
		// redirect that names no node is followed up by finding the node the form just created
		const nid =
			/\/node\/(\d+)/.exec(created.res.headers.get('location') ?? '')?.[1] ??
			([302, 303].includes(created.res.status)
				? await newestNode(site, type, 'corpus')
				: undefined);
		if (nid) {
			const del = await site.page(`/node/${nid}/delete`, true);
			const gone = await site.post(`/node/${nid}/delete`, {
				...hiddenFields(del.body),
				op: 'Delete'
			});
			set(
				'entity crud',
				[302, 303].includes(gone.res.status) ? 'inline' : 'unsupported',
				gone.res.status === 303 || gone.res.status === 302
					? undefined
					: `delete answered ${gone.res.status}`
			);
		} else if (contentTypeFrom(listing.body) === null && created.res.status === 404) {
			// a site with no content type at all (open intranet) is scored on a taxonomy term
			const term = await termCrud(site);
			set('entity crud', term.ok ? 'inline' : 'unsupported', term.note);
		} else {
			set(
				'entity crud',
				'unsupported',
				`node create (${type}) answered ${created.res.status}${created.res.status === 200 ? `: ${messagesOf(created.body)}` : ''}`
			);
		}
		const settings = await site.page('/admin/config/system/site-information', true);
		const saved = await site.post('/admin/config/system/site-information', {
			...textFields(settings.body),
			...hiddenFields(settings.body),
			site_slogan: 'corpus',
			op: 'Save configuration'
		});
		const submitted =
			[200, 302, 303].includes(saved.res.status) && !ERROR_PAGE.test(saved.body);
		set(
			'form submit',
			submitted ? 'inline' : 'unsupported',
			submitted
				? undefined
				: [`the site information save answered ${saved.res.status}`, noSession]
						.filter(Boolean)
						.join('; ')
		);

		if (modular) await revive();
		await driveCapabilities(site, set);

		const own = repo.checks ?? [];
		const derived = own.length === 0 && modular ? derivedChecks(dir, modular.enabled) : [];
		const checks =
			own.length > 0
				? own
				: derived.length > 0
					? derived
					: ['/admin/reports/status', '/admin/config'];
		if (modular && own.length === 0 && derived.length === 0) {
			set(
				'module workflow',
				'inline',
				`${modular.enabled.join(', ')} enabled and listed; the modules declare no static routes`
			);
		} else {
			const failed: string[] = [];
			const blocked: string[] = [];
			for (const path of checks) {
				const got = await site.reach(path, true);
				const appAnswer =
					derived.length > 0 &&
					got.res.status === 404 &&
					/json/.test(got.res.headers.get('content-type') ?? '');
				const accepted =
					derived.length > 0
						? [200, 302, 303, 403].includes(got.res.status)
						: got.res.status === 200;
				if ((!accepted && !appAnswer) || ERROR_PAGE.test(got.body)) {
					const line = `${path} answered ${got.res.status}${ERROR_PAGE.test(got.body) ? `: ${excerpt(got.body, ERROR_PAGE)}` : ''}`;
					failed.push(
						got.via.length > 0
							? `${line} after redirects to ${got.via.join(' then ')}`
							: line
					);
				} else if (walled !== null && got.via[got.via.length - 1] === walled) {
					blocked.push(`${path} was redirected to ${got.via.join(' then ')}`);
				}
			}
			set(
				'module workflow',
				failed.length > 0 ? 'unsupported' : blocked.length > 0 ? 'unknown' : 'inline',
				failed.length > 0
					? failed.join('; ')
					: blocked.length > 0
						? `${blocked.join('; ')}; the probe never reached the page`
						: `${derived.length > 0 ? 'routes from its routing file: ' : ''}${checks.join(', ')}`
			);
		}

		// what the finished site enables, so the fixtures page can say which modules a verified
		// codebase ran; read from the live object rather than inferred from the repository
		const ext = await site.owned(
			`/sql?q=${encodeURIComponent("SELECT CAST(data AS TEXT) AS d FROM config WHERE name = 'core.extension' AND collection = ''")}`
		);
		const text = String((ext.json['rows'] as { d?: string }[] | undefined)?.[0]?.d ?? '');
		enabledBy.set(repo.id, [...extensionNames(text)].sort());
		deliveredBy.set(repo.id, await readDelivered(site));

		if (walled !== null)
			for (const row of corpus.rows) {
				const cell = rows[row];
				if (
					cell?.state === 'unsupported' &&
					/answered 30\d|Redirecting to/.test(cell.note ?? '')
				)
					rows[row] = {
						state: 'unknown',
						note: `${cell.note}; the probe was redirected to ${walled} and never reached its page`
					};
			}
		return rows;
	} catch (e) {
		// the dev server's log is deleted with it, and it is the only account of a crash
		const tail = existsSync(dev.logFile) ? readFileSync(dev.logFile, 'utf8').slice(-600) : '';
		throw new Error(
			`${e instanceof Error ? e.message : String(e)}${tail ? `; wrangler: ${tail.replace(/\s+/g, ' ')}` : ''}`
		);
	} finally {
		dev.stop();
		if (process.env.CORPUS_TRACE && existsSync(dev.logFile))
			copyFileSync(dev.logFile, join(workRoot, '..', 'logs', `wrangler-${repo.id}.log`));
		restoreDb();
		if (!remote && !process.argv.includes('--keep'))
			rmSync(dev.stateDir, { recursive: true, force: true });
	}
}

// #endregion

async function main(): Promise<void> {
	const root = join(import.meta.dir, '..', '..');
	const args = process.argv.slice(2);
	const only = args
		.find((a) => a.startsWith('--repo='))
		?.slice(7)
		.split(',');
	if (args.includes('--deployed') && !args.includes('--render-only')) {
		deployedOrigin(args, process.env);
		if (only?.length !== 1)
			throw new Error('--deployed drives one worker, so it needs exactly one --repo=<id>');
	}
	const corpus = parse(readFileSync(join(root, 'config', 'corpus.yml'), 'utf8')) as Corpus;
	const jsonPath = join(root, 'docs', 'compatibility.json');
	const current = (): Compatibility =>
		existsSync(jsonPath)
			? (JSON.parse(readFileSync(jsonPath, 'utf8')) as Compatibility)
			: { rows: corpus.rows, repos: {} };

	const ran: Record<string, RepoResult> = {};
	if (!args.includes('--render-only')) {
		const work = process.env.CORPUS_DIR ?? join(root, '.corpus');
		const run = process.env.GITHUB_RUN_ID
			? `github:${process.env.GITHUB_RUN_ID}`
			: `local:${new Date().toISOString()}`;
		let port = Number(process.env.CORPUS_PORT ?? 8840);
		for (const repo of corpus.repos) {
			if (only && !only.includes(repo.id)) continue;
			const base = {
				sha: repo.sha,
				lane: 'fixture',
				run,
				date: new Date().toISOString().slice(0, 10)
			};
			waitForTimingLock();
			const upgrade = refusalFor(repo);
			if (upgrade !== null) {
				ran[repo.id] = { ...base, rows: unsettled(corpus.rows, upgrade) };
				continue;
			}
			if (repo.install === 'none') {
				ran[repo.id] = {
					...base,
					rows: unknownRows(corpus.rows, `not loadable: ${repo.assessment}`)
				};
				continue;
			}
			let migrated: { out: string; base?: RepoEntry } | undefined;
			if (repo.install === 'profile' || repo.install === 'project') {
				const dir = join(work, repo.id);
				clone(repo, dir);
				const plan = projectPlan(join(dir, repo.root ?? '.'));
				if (installPath(repo.install, plan) === 'migration') {
					const native = nativeInstall(
						repo,
						join(dir, repo.root ?? '.'),
						join(work, '..', 'native', repo.id)
					);
					if (!native.ok) {
						ran[repo.id] = { ...base, rows: unsettled(corpus.rows, native.why) };
						console.log(`${repo.id}: ${native.why}`);
						continue;
					}
					if (args.includes('--native-only')) continue;
					migrated = native;
				}
			}
			// a sub-project runs inside the distribution it belongs to (open y's activity finder), so
			// the base is installed natively and migrated, and the sub-project's modules go on top
			const baseRepo = repo.base ? corpus.repos.find((r) => r.id === repo.base) : undefined;
			if (baseRepo) {
				const baseDir = join(work, baseRepo.id);
				clone(baseRepo, baseDir);
				const native = nativeInstall(
					baseRepo,
					join(baseDir, baseRepo.root ?? '.'),
					join(work, '..', 'native', baseRepo.id)
				);
				if (!native.ok) {
					const why = `its base ${baseRepo.id} did not install: ${native.why}`;
					ran[repo.id] = { ...base, rows: unsettled(corpus.rows, why) };
					console.log(`${repo.id}: ${why}`);
					continue;
				}
				migrated = { ...native, base: baseRepo };
			}
			try {
				// a lost dev server ends the whole repository, so it gets one more run on a fresh state
				let driven: RepoResult['rows'];
				try {
					driven = await driveRepo(repo, corpus, work, port, migrated);
				} catch (e) {
					if (!lostServer(e)) throw e;
					driven = await driveRepo(repo, corpus, work, port, migrated);
				}
				port++;
				ran[repo.id] = {
					...base,
					rows: settleRows(driven),
					...(enabledBy.has(repo.id) ? { enabled: enabledBy.get(repo.id) } : {}),
					...(deliveredBy.get(repo.id) ?? {})
				};
			} catch (e) {
				ran[repo.id] = {
					...base,
					rows: unknownRows(
						corpus.rows,
						`the lane failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`
					)
				};
			}
			console.log(`${repo.id}: ${JSON.stringify(ran[repo.id]?.rows)}`);
		}
	}
	const deployedRuns: Record<string, DeployedRun> = {};
	if (args.includes('--deployed')) {
		const plan = args.find((a) => a.startsWith('--plan='))?.slice(7);
		if (!plan)
			throw new Error('--deployed needs --plan=free|paid, the account the worker runs on');
		for (const [id, result] of Object.entries(ran))
			deployedRuns[id] = {
				sha: result.sha,
				run: result.run,
				date: result.date,
				plan,
				rows: result.rows
			};
	}
	const merged = args.includes('--deployed')
		? recordDeployed(current(), corpus.rows, deployedRuns)
		: mergeResults(current(), corpus.rows, ran);
	writeFileSync(jsonPath, `${JSON.stringify(merged, null, '\t')}\n`);
	writeFileSync(join(root, 'docs', 'compatibility.md'), renderMatrix(merged, corpus));
}

if (import.meta.main) await main();
