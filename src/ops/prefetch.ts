/**
 * Outbound answers the host warms before Drupal asks for them.
 *
 * A Worker cannot fetch synchronously, so the deferred tier refuses the first request for a URL.
 * A URL the host can name from the schedule, without running Drupal and with no side effect at
 * the far end (a GET against a published endpoint), is fetched ahead so the render hits the cache.
 * Not eligible: a login callback (the host owns that route), a search query inside a render, and
 * a cache backend (the object's SQLite replaces it).
 * @module
 */

/** one URL the host warms ahead of the render that wants it */
export type DeclaredFetch = {
	url: string;
	/** how long an answer stays worth having, in ms */
	freshMs: number;
	/** what wants it, so a warm that never gets consumed is attributable */
	consumer: string;
};

/** the release history for one project, which is what `UpdateFetcher` builds */
export function releaseHistoryUrl(project: string, base?: string): string {
	const root = String(base ?? '').trim() || 'https://updates.drupal.org/release-history';
	return `${root}/${project}/current`;
}

/**
 * Everything the host can warm without asking Drupal.
 *
 * `projects` comes from the site's module list when the caller has one; core is always warmed.
 */
export function declaredFetches(projects: readonly string[] = [], base?: string): DeclaredFetch[] {
	const day = 86_400_000;
	const out: DeclaredFetch[] = [
		{
			url: 'https://www.drupal.org/announcements.json',
			freshMs: day,
			consumer: 'announcements_feed'
		}
	];
	const seen = new Set<string>();
	for (const project of ['drupal', ...projects]) {
		const name = String(project).trim();
		if (name === '' || seen.has(name)) continue;
		seen.add(name);
		out.push({ url: releaseHistoryUrl(name, base), freshMs: day, consumer: 'update' });
	}
	return out;
}

/**
 * Which declared URLs are worth queueing right now.
 *
 * `fresh` says whether the fetch cache already holds a usable entry; those are skipped, so a warm
 * round costs nothing and can run on every cron round.
 */
export function pendingDeclared(
	declared: readonly DeclaredFetch[],
	fresh: (url: string) => boolean,
	limit = 6
): string[] {
	const out: string[] = [];
	for (const entry of declared) {
		if (out.length >= limit) break;
		if (fresh(entry.url)) continue;
		out.push(entry.url);
	}
	return out;
}
