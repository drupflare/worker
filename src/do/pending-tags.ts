import { pageTagList } from './helpers';
import type { PendingTagsHost } from './host';
import { PENDING_TAGS_KEY } from './keys';

/**
 * Runs the tag-scoped purge once the invocation's invalidated tags are complete.
 *
 * Runs at the end, so a death before it leaves a plan alive. The wholesale purge in
 * `bumpGeneration()` runs at the write and has no such window.
 */
export function flushTagPurge(host: PendingTagsHost): string[] {
	const tags = [...host.invalidatedTags];
	host.invalidatedTags.clear();
	if (tags.length > 0) {
		// here the set is complete (a wholesale purge re-queues ~2,750 fills/day at 50 saves;
		// a node save depends on 3 to 10 pages)
		host.lastScopedPurge = host.purgeForTags(tags, 'cachetags', { bump: false });
		clearPendingTags(host);
	}
	return tags;
}

/**
 * Sets a stored page's tag list out of band, for a caller that did not write the row.
 *
 * Tags come from the render's cacheability metadata, never parsed HTML. Replaces rather than
 * merges, so a re-render with fewer dependencies is not purged by a dropped tag.
 */
export function indexPageTags(host: PendingTagsHost, path: string, tags: unknown): void {
	host.sql.exec('UPDATE cfw_page SET tags = ? WHERE path = ?', pageTagList(tags), path);
}

/**
 * Persists the tags this invocation invalidated, at the write, so a crash before
 * `flushTagPurge()` leaves a durable record of what is owed. {@link drainPendingTags} settles
 * it at the end of the invocation and again at boot.
 */
export function notePendingTags(host: PendingTagsHost, tags: readonly string[]): void {
	if (tags.length === 0) return;
	const held = new Set(pendingTags(host));
	for (const tag of tags) held.add(tag);
	// bounded: past this a wholesale purge is correct and cheaper than an unbounded row
	const kept = [...held].slice(0, 256);
	host.metaSet(PENDING_TAGS_KEY, JSON.stringify(kept));
}

/** the durably recorded tag set, empty when there is nothing owed */
export function pendingTags(host: PendingTagsHost): string[] {
	try {
		const raw = JSON.parse(host.metaGet(PENDING_TAGS_KEY) || '[]') as unknown;
		return Array.isArray(raw) ? raw.map((t) => String(t)) : [];
	} catch {
		return [];
	}
}

/** forgets the recorded set, once the purge it describes has happened */
export function clearPendingTags(host: PendingTagsHost): void {
	if ((host.metaGet(PENDING_TAGS_KEY) ?? '') !== '') host.metaSet(PENDING_TAGS_KEY, '');
}

/**
 * Settles a purge a previous invocation recorded and did not finish; runs at boot too, so a
 * dead invocation purges on the next.
 */
export function settlePendingIfOwed(host: PendingTagsHost): void {
	if (host.pendingDrained === true) return;
	host.pendingDrained = true;
	try {
		const drained = drainPendingTags(host);
		if (drained) host.lastPendingDrain = drained;
	} catch {
		// a site with no serving tables owes nothing, and this must never fail a request
	}
}

/** purges the recorded pending tags and clears the record; undefined when none are owed */
export function drainPendingTags(
	host: PendingTagsHost
): { tags: number; purged: number } | undefined {
	const owed = pendingTags(host);
	if (owed.length === 0) return undefined;
	// reason `cachetags`: this is that purge settled late (other reasons take the wholesale
	// path)
	const out = host.purgeForTags(owed, 'cachetags', { bump: false });
	clearPendingTags(host);
	return out;
}
