import { type Credential, type Remote } from '../ops/git-provider';
import { backoffMs, clampInterval, DEFAULT_POLL_MINUTES, type PollState } from '../ops/git-sync';

import type { GitHost, SiteStore } from './host';

/** every configured remote; the list is one meta row so an add is one write */
export function gitRemotes(host: SiteStore): Remote[] {
	try {
		const raw = JSON.parse(host.metaGet('git_remotes') || '[]') as unknown;
		return Array.isArray(raw) ? (raw as Remote[]) : [];
	} catch {
		return [];
	}
}

/** stores the remote list as one meta row */
export function gitSaveRemotes(host: SiteStore, remotes: readonly Remote[]): void {
	host.metaSet('git_remotes', JSON.stringify(remotes));
}

/**
 * The token, email and username for a remote (empty strings when unset). A token sent with this
 * call wins over a stored one and is never written anywhere.
 */
export function gitCredential(host: GitHost, id: string): Credential {
	return {
		token: host.gitCallToken || (host.readSecret(`git_token_${id}`) ?? ''),
		email: host.metaGet(`git_email_${id}`) ?? '',
		username: host.metaGet(`git_username_${id}`) ?? ''
	};
}

/** records a refusal so nothing polls this remote again until the window passes */
export function gitBackoff(host: SiteStore, id: string, retryAfter?: string): number {
	const attempts = Number(host.metaGet(`git_attempts_${id}`, '0') ?? 0) + 1;
	const seconds = retryAfter === undefined ? undefined : Number(retryAfter);
	const wait = backoffMs(attempts, Number.isFinite(seconds) ? seconds : undefined);
	host.metaSet(`git_attempts_${id}`, String(attempts));
	host.metaSet(`git_backoff_${id}`, String(host.nowMs() + wait));
	return wait;
}

/** clears a remote's backoff after a good poll */
export function gitClearBackoff(host: SiteStore, id: string): void {
	host.metaSet(`git_attempts_${id}`, '0');
	host.metaSet(`git_backoff_${id}`, '0');
}

/** every file this remote has installed, so a plan can tell a change from an addition */
export function gitStoredFiles(host: SiteStore, id: string): Map<string, string> {
	host.ensureServeTables();
	const rows = host.sql
		.exec<{
			path: string;
			source: string;
		}>('SELECT path, source FROM cfw_module_file WHERE package = ?', id)
		.toArray();
	return new Map(rows.map((r) => [String(r.path), String(r.source)]));
}

/** who owns each installed path, which is what turns an overwrite into a refusal */
export function gitOwners(host: SiteStore): Map<string, string> {
	host.ensureServeTables();
	const rows = host.sql
		.exec<{
			path: string;
			package: string;
		}>('SELECT path, package FROM cfw_module_file')
		.toArray();
	return new Map(rows.map((r) => [String(r.path), String(r.package)]));
}

/** the poll cadence for every remote, which is what the alarm reads */
export function gitPollStates(host: SiteStore, remotes: readonly Remote[]): PollState[] {
	return remotes.map((r) => ({
		id: r.id,
		intervalMinutes: clampInterval(
			Number(host.metaGet(`git_interval_${r.id}`, String(DEFAULT_POLL_MINUTES)) ?? 0)
		),
		lastCheckedMs: Number(host.metaGet(`git_checked_${r.id}`, '0') ?? 0),
		backoffUntilMs: Number(host.metaGet(`git_backoff_${r.id}`, '0') ?? 0)
	}));
}
