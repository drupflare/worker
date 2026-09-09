/**
 * Outbound answers the host warms BEFORE Drupal asks for them.
 *
 * The deferred tier is cached-or-deferred by construction: a Worker cannot fetch synchronously, so
 * the first request for a URL is refused and answered on a later one. That is correct and it is not
 * the whole ladder. Every URL that is decidable from the SCHEDULE rather than from the request can
 * be fetched before the render that wants it, and then the render meets a cache hit and never
 * defers at all.
 *
 * WHAT QUALIFIES. A URL belongs here when the host can name it without running Drupal, and when
 * fetching it has no side effect at the far end. Everything below is a GET against a published
 * endpoint on a schedule this project already drives.
 *
 * WHAT DOES NOT. A login callback (the host owns that route already), a search query inside a
 * render (a GET with no side effects, therefore re-renderable), and a cache backend (the object's
 * own SQLite is the replacement rather than a workaround).
 */

export type DeclaredFetch = {
	url: string;
	/** how long an answer stays worth having, in ms */
	freshMs: number;
	/** what wants it, so a warm that never gets consumed is attributable */
	consumer: string;
};

/** the release history for one project, which is what `UpdateFetcher` builds */
export function releaseHistoryUrl(project: string, base?: string | null): string {
	const root = String(base ?? '').trim() || 'https://updates.drupal.org/release-history';
	return `${root}/${project}/current`;
}

/**
 * Everything the host can warm without asking Drupal.
 *
 * `projects` comes from the site's own module list when the caller has one; with none it still
 * warms core, which is the project every site has.
 */
export function declaredFetches(
	projects: readonly string[] = [],
	base?: string | null
): DeclaredFetch[] {
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
 * `fresh` answers whether the fetch cache already holds a usable entry. Anything it says yes to is
 * skipped, so a warm round costs nothing at all -- which is what makes running this on every cron
 * round affordable rather than a second fetch storm.
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
