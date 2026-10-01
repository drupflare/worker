import {
	ADMIN_GIT_EMPTY_HTML,
	ADMIN_GIT_HTML,
	ADMIN_GIT_JS,
	ADMIN_GIT_ROW_HTML,
	ADMIN_GIT_UNPREVIEW_HTML
} from '../../site/generated/assets';
import { escapeHtml, fill, LOGIN_PATH, pill } from './shell';

/** one configured remote, as the page needs to show it */
export interface RemoteRow {
	id: string;
	provider: string;
	repo: string;
	branch: string;
	host?: string;
	/** the sha the last successful check saw */
	head?: string;
	/** the sha whose files are actually mounted, which is not always the head */
	installed?: string;
	/** epoch ms of that check */
	checkedAt?: number;
	pulledAt?: number;
	/** 0 means polling is off and only a webhook moves this remote */
	intervalMinutes?: number;
	backoffUntil?: number;
	/** the pull or merge request being previewed instead of the branch */
	previewOf?: string;
	lastError?: string;
	lastPlan?: { added?: number; modified?: number; removed?: number; unchanged?: number };
	/** how the last delivery was authenticated, or absent if none has arrived */
	proof?: string;
	hookInstalled?: boolean;
	files?: number;
}

const ago = (at: number | undefined, now: number): string => {
	if (!at) return 'never';
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 90) return `${s}s ago`;
	if (s < 5400) return `${Math.round(s / 60)}m ago`;
	return `${Math.round(s / 3600)}h ago`;
};

/** the display name for each provider id */
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

/**
 * Remotes, and what each one last told us.
 *
 * The write-back is a commit status on all three providers: GitHub's Checks API is richer but a
 * pasted token gets 403 on both check-run endpoints (201 on the status one), so it is not offered.
 */
export function renderGit(remotes: readonly RemoteRow[], now: number): string {
	const rows =
		remotes.length === 0
			? ADMIN_GIT_EMPTY_HTML.trimEnd()
			: remotes
					.map((r) => {
						const id = escapeHtml(r.id);
						return fill(ADMIN_GIT_ROW_HTML, {
							REPO: escapeHtml(r.repo),
							PROVIDER: `${escapeHtml(PROVIDER_LABEL[r.provider] ?? r.provider)}${r.host ? ` &middot; ${escapeHtml(r.host)}` : ''}`,
							BRANCH: escapeHtml(r.branch),
							ID: id,
							HEAD: r.head
								? `<code>${escapeHtml(String(r.head).slice(0, 12))}</code>`
								: `<span class="dim">unknown</span>`,
							CHECKED: escapeHtml(ago(r.checkedAt, now)),
							SYNC: syncPill(r),
							PLAN: r.lastPlan
								? `<span class="dim">+${r.lastPlan.added ?? 0} ~${r.lastPlan.modified ?? 0} -${r.lastPlan.removed ?? 0}</span>`
								: '',
							HOOK: r.hookInstalled
								? `${pill('ok')} <span class="dim">${escapeHtml(r.proof ?? 'no delivery yet')}</span>`
								: `${pill('none')} <span class="dim">polling only</span>`,
							INTERVAL: String(r.intervalMinutes ?? 60),
							UNPREVIEW: r.previewOf
								? fill(ADMIN_GIT_UNPREVIEW_HTML, { ID: id })
								: '',
							PROVIDER_ID: escapeHtml(r.provider)
						});
					})
					.join('');

	return fill(ADMIN_GIT_HTML, {
		ROWS: rows,
		SCRIPT: fill(ADMIN_GIT_JS, { LOGIN_PATH })
	});
}
