/**
 * Fragment assembly: an anonymous shell from cache, personalised holes filled at the edge.
 *
 * Authenticated HTML is never cached and must not be. What CAN be cached is the part of the page
 * that is identical for everyone, with the per-user parts left as holes -- which is exactly the
 * boundary Drupal already draws for BigPipe. `BigPipeStrategy` wraps every auto-placeholdered
 * element in `<span data-big-pipe-placeholder-id="...">`, so the seams exist in the markup already
 * and nothing here has to invent them.
 *
 * ## The dangerous half is deciding WHEN, not doing it
 *
 * Serving a shell that contains one visitor's content to another is the same defect as the static
 * -state leaks, arriving through a different door. So {@link shellSafety} refuses by default and
 * only permits a page it can positively account for: every personalised region must be inside a
 * placeholder, and anything that looks like identity outside one disqualifies the page.
 *
 * The refusal is cheap -- the page just renders the way it does today. A wrong permit is a
 * disclosure. That asymmetry is why every unknown here resolves to `unsafe`.
 */

/** BigPipe's own placeholder marker; core writes it and core reads it back with this shape */
export const PLACEHOLDER_ATTR = 'data-big-pipe-placeholder-id';

const PLACEHOLDER_RE = /<span data-big-pipe-placeholder-id="([^"]*)">\s*<\/span>/g;

/**
 * Markers that mean a page carries identity OUTSIDE a placeholder.
 *
 * Drupal emits `is-logged-in` / `user-logged-in` body classes and a `uid` in `drupalSettings` on an
 * authenticated render. Any of them in a would-be shell means the shell was built for somebody.
 */
const IDENTITY_MARKERS = [
	'user-logged-in',
	'is-logged-in',
	'"uid":',
	'"user":{"uid"',
	'js-form-item-name'
];

export type ShellSafety =
	| { safe: true; placeholders: string[] }
	| { safe: false; reason: string; placeholders: string[] };

/** every placeholder id in a rendered page, in document order */
export function placeholderIds(html: string): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(PLACEHOLDER_RE)) out.push(decodeEntities(m[1] as string));
	return out;
}

/**
 * Whether a rendered page may be stored as a shared shell.
 *
 * REFUSES BY DEFAULT. A page with no placeholders is not a shell -- it is a fully rendered page, and
 * caching it for everyone is what `cfw_page` already does for anonymous traffic. A page carrying an
 * identity marker outside a placeholder is a page built for one visitor.
 */
export function shellSafety(html: string): ShellSafety {
	const placeholders = placeholderIds(html);
	if (placeholders.length === 0) {
		return {
			safe: false,
			reason: 'no placeholders, so there is nothing personalised to fill and no shell to share',
			placeholders
		};
	}
	// the identity scan runs against the page with its placeholders REMOVED, because a marker
	// inside a hole is exactly what a hole is for
	const outside = html.replace(PLACEHOLDER_RE, '');
	for (const marker of IDENTITY_MARKERS) {
		if (outside.includes(marker)) {
			return {
				safe: false,
				reason: `identity marker ${JSON.stringify(marker)} appears outside a placeholder`,
				placeholders
			};
		}
	}
	return { safe: true, placeholders };
}

/** a filled hole; `html` is trusted markup produced by the same Drupal that produced the shell */
export type Fragment = { id: string; html: string };

export type AssemblyResult = {
	html: string;
	filled: string[];
	/** placeholders the shell has that no fragment answered */
	unfilled: string[];
	/** fragments supplied for a placeholder the shell does not have */
	unmatched: string[];
};

/**
 * Fills a shell's holes, by string replacement rather than by HTMLRewriter.
 *
 * HTMLRewriter is the obvious tool and is the wrong one here. It streams, so it cannot report which
 * placeholders went unfilled until the body is already on the wire -- and an unfilled hole is the
 * case that has to be caught BEFORE anything is sent, because it means the shell and the fragment
 * set disagree. Streaming is worth having later for byte latency; correctness comes first, and a
 * cached shell is a string already in memory.
 *
 * AN UNFILLED PLACEHOLDER IS LEFT IN PLACE, never removed. Removing it would silently drop a
 * region -- a visitor would see a page with their account menu simply absent, and nothing would
 * report it. Left in place, it is an empty span that BigPipe's own JavaScript can still fill.
 */
export function assemble(shell: string, fragments: readonly Fragment[]): AssemblyResult {
	const byId = new Map(fragments.map((f) => [f.id, f.html]));
	const filled: string[] = [];
	const unfilled: string[] = [];
	const seen = new Set<string>();

	const html = shell.replace(PLACEHOLDER_RE, (whole, rawId: string) => {
		const id = decodeEntities(rawId);
		seen.add(id);
		const replacement = byId.get(id);
		if (replacement === undefined) {
			unfilled.push(id);
			return whole;
		}
		filled.push(id);
		return replacement;
	});

	return {
		html,
		filled,
		unfilled,
		unmatched: fragments.map((f) => f.id).filter((id) => !seen.has(id))
	};
}

/**
 * The five entities Drupal's `Html::escape()` produces, reversed.
 *
 * A placeholder id is an escaped callback signature and routinely contains `&quot;` and `&amp;`, so
 * comparing the raw attribute against an unescaped id never matches and every hole reads as
 * unfilled.
 */
export function decodeEntities(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&amp;/g, '&');
}

export type ShellDecision = {
	/** whether the edge may assemble rather than falling through to a full render */
	assemble: boolean;
	reason: string;
};

/**
 * Whether THIS request may be answered by assembly.
 *
 * Separate from {@link shellSafety}, which is about the stored artifact. This is about the request:
 * a shell is only usable for a visitor whose personalisation is confined to the holes it has.
 *
 * A non-GET never assembles. A submission's response is per-submitter and must not come from any
 * shared artifact, which is the same rule `cfw_page` already follows.
 */
export function shellDecision(input: {
	method: string;
	authenticated: boolean;
	shell: ShellSafety | null;
	fragmentsAvailable: boolean;
}): ShellDecision {
	if (input.method !== 'GET' && input.method !== 'HEAD') {
		return { assemble: false, reason: 'a submission is never answered from a shared shell' };
	}
	if (!input.authenticated) {
		// an anonymous visitor has no holes to fill; the ordinary page cache is cheaper
		return { assemble: false, reason: 'anonymous traffic is served by the page cache' };
	}
	if (!input.shell) return { assemble: false, reason: 'no shell stored for this path' };
	if (!input.shell.safe) return { assemble: false, reason: input.shell.reason };
	if (!input.fragmentsAvailable) {
		return { assemble: false, reason: 'no fragment source, so the holes cannot be filled' };
	}
	return { assemble: true, reason: '' };
}
