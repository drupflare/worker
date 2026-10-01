/**
 * Fragment assembly: a cached shell with the personalised holes filled at the edge.
 *
 * The holes are BigPipe's own `data-big-pipe-placeholder-id` spans. Deciding when to serve a shell
 * is the dangerous half: a wrong permit discloses one visitor's content to another while a refusal
 * only renders the page as usual, so every unknown resolves to `unsafe`.
 * @module
 */

/** BigPipe's own placeholder marker; core writes it and core reads it back with this shape */
export const PLACEHOLDER_ATTR = 'data-big-pipe-placeholder-id';

const PLACEHOLDER_RE = /<span data-big-pipe-placeholder-id="([^"]*)">\s*<\/span>/g;

/**
 * Markers that mean a page carries identity outside a placeholder: the logged-in body classes and
 * a `uid` in `drupalSettings` on an authenticated render.
 */
const IDENTITY_MARKERS = [
	'user-logged-in',
	'is-logged-in',
	'"uid":',
	'"user":{"uid"',
	'js-form-item-name'
];

/** the verdict of {@link shellSafety}; `placeholders` is every id found either way */
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
 * Refuses by default: a page with no placeholders is a fully rendered page (`cfw_page` already
 * shares those for anonymous traffic), and an identity marker outside a placeholder means it was
 * built for one visitor.
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
	// scan with placeholders removed: a marker inside a hole is what a hole is for
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

/** what {@link assemble} produced, with the ids it filled and the ones that did not line up */
export type AssemblyResult = {
	html: string;
	filled: string[];
	/** placeholders the shell has that no fragment answered */
	unfilled: string[];
	/** fragments supplied for a placeholder the shell does not have */
	unmatched: string[];
};

/**
 * Fills a shell's holes by string replacement, not HTMLRewriter: a stream cannot report unfilled
 * holes before the body is on the wire, and an unfilled hole means shell and fragments disagree.
 *
 * An unfilled placeholder is left in place, never removed: removing it would silently drop a
 * region, while the empty span can still be filled by BigPipe's own JavaScript.
 */
export function assemble(shell: string, fragments: readonly Fragment[]): AssemblyResult {
	// decode both sides: BigPipe keys its attachment by the escaped id (`&amp;`) while the span
	// attribute decodes to the raw one, so an undecoded map matches nothing
	const byId = new Map(fragments.map((f) => [decodeEntities(f.id), f.html]));
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
		unmatched: fragments.map((f) => decodeEntities(f.id)).filter((id) => !seen.has(id))
	};
}

/**
 * The five entities Drupal's `Html::escape()` produces, reversed.
 *
 * A placeholder id is an escaped callback signature (`&quot;`, `&amp;`), so comparing the raw
 * attribute against an unescaped id never matches.
 */
export function decodeEntities(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&amp;/g, '&');
}

/** whether a request may be assembled, with the reason when it may not */
export type ShellDecision = {
	/** whether the edge may assemble rather than falling through to a full render */
	assemble: boolean;
	reason: string;
};

/**
 * Whether this request may be answered by assembly (the request, where {@link shellSafety} judges
 * the stored artifact). A non-GET never assembles: a submission's response is per-submitter.
 */
export function shellDecision(input: {
	method: string;
	authenticated: boolean;
	shell?: ShellSafety;
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

/**
 * A value the stored shell must not carry.
 *
 * `nonce` is not identity (views build `js-view-dom-id-<hash>` from `mt_rand()`, per render); it is
 * slotted because the safety property is byte equality, which a nonce breaks.
 */
export type SlotKind = 'uid' | 'permissions-hash' | 'csrf' | 'nonce';

/** one extracted value: the slot name left in the shell, its kind and the harvested value */
export type IdentitySlot = { name: string; kind: SlotKind; value: string };

/**
 * The patterns measured to vary between two users of the same role on a front page, outside every
 * hole (`tests/unit/ops/shell-assembly.spec.ts` diffs two users; these four classes are the
 * whole difference). `permissionsHash` varies by role, not user; slotting it makes a shell
 * harvested for one role set detectably wrong for another.
 */
const SLOT_PATTERNS: ReadonlyArray<{ kind: SlotKind; re: RegExp; group: number }> = [
	{ kind: 'uid', re: /("uid":")(\d+)(")/g, group: 2 },
	{ kind: 'permissions-hash', re: /("permissionsHash":")([0-9a-f]{64})(")/g, group: 2 },
	// the slash before `logout` is not anchored: BigPipe's scripts carry the href JSON-escaped
	// (`\/user\/logout?token=`)
	{ kind: 'csrf', re: /(logout\?token=)([A-Za-z0-9_-]{16,})/g, group: 2 },
	{ kind: 'csrf', re: /(data-contextual-token=(?:\\u0022|\\?"))([A-Za-z0-9_-]{16,})/g, group: 2 },
	{ kind: 'nonce', re: /(js-view-dom-id-)([0-9a-f]{16,})/g, group: 2 }
];

/** what a slot looks like in the stored shell; JSON-safe, URL-safe and attribute-safe at once */
export const SLOT_PREFIX = 'cfw-slot-';

/** the outcome of {@link normaliseShell}: the slotted shell and its slots, or a refusal reason */
export type NormaliseResult =
	{ ok: true; shell: string; slots: IdentitySlot[] } | { ok: false; reason: string };

/**
 * Replaces every measured per-person value in a rendered page with a named slot.
 *
 * The safety property is byte equality, not this pattern list: the harvest normalises the same
 * page for two members of a role set and refuses unless the results are identical
 * ({@link normalisedShellsAgree}). So the list may be incomplete without being unsafe; omitting a
 * pattern costs a shell, never a disclosure.
 */
export function normaliseShell(html: string): NormaliseResult {
	const placeholders = placeholderIds(html);
	if (placeholders.length === 0) {
		return { ok: false, reason: 'no placeholders, so there is nothing personalised to fill' };
	}

	const slots: IdentitySlot[] = [];
	let shell = html;
	for (const { kind, re, group } of SLOT_PATTERNS) {
		shell = shell.replace(re, (whole, ...rest) => {
			const value = String(rest[group - 1]);
			const name = `${SLOT_PREFIX}${slots.length}`;
			slots.push({ name, kind, value });
			return whole.replace(value, name);
		});
	}
	return { ok: true, shell, slots };
}

/**
 * Whether two normalised shells may be stored as one shared artifact.
 *
 * Byte equality after normalisation is the whole authorisation; slot values are expected to differ.
 */
export function normalisedShellsAgree(a: string, b: string): { agree: boolean; reason: string } {
	const left = normaliseShell(a);
	const right = normaliseShell(b);
	if (!left.ok) return { agree: false, reason: `left: ${left.reason}` };
	if (!right.ok) return { agree: false, reason: `right: ${right.reason}` };
	if (left.shell === right.shell) return { agree: true, reason: '' };

	// the first divergent 80 characters make a refusal actionable (a whole-page diff is 27 KB)
	let at = 0;
	while (at < left.shell.length && left.shell[at] === right.shell[at]) at++;
	return {
		agree: false,
		reason: `diverges at ${at}: ${JSON.stringify(left.shell.slice(at, at + 80))} vs ${JSON.stringify(right.shell.slice(at, at + 80))}`
	};
}

/** the per-session values a fragment render reports, the only place they can come from */
export type Identity = {
	uid?: string;
	permissionsHash?: string;
	csrf?: Record<string, string>;
};

/**
 * Reads the role set out of a PHP reply, sorted, or an empty list.
 *
 * A shell response must carry its roles: the edge plan compiles from three agreeing samples of
 * `x-cfw-roles` keyed by cookie, so one `ASSEMBLED` path without them made the whole session read
 * `skip:roles-unknown` and never compile a plan. Anything not a list of strings yields nothing,
 * since a partial role set would compile a plan for the wrong audience.
 */
export function rolesOf(reply: Record<string, unknown> | null | undefined): string[] {
	const raw = reply?.['roles'];
	if (!Array.isArray(raw)) return [];
	const roles = raw.filter((r): r is string => typeof r === 'string' && r !== '');
	return roles.length === raw.length ? [...roles].sort() : [];
}

/**
 * Puts one visitor's own values back into the slots.
 *
 * Refuses on a permissions-hash mismatch, which keeps a role-keyed shell inside its role set: a
 * visitor whose hash differs is entitled to different markup.
 */
export function fillIdentity(
	shell: string,
	slots: readonly IdentitySlot[],
	identity: Identity
): { ok: true; html: string } | { ok: false; reason: string } {
	let html = shell;
	for (const slot of slots) {
		let replacement: string | undefined;
		if (slot.kind === 'uid') replacement = identity.uid;
		else if (slot.kind === 'permissions-hash') {
			if (identity.permissionsHash !== undefined && identity.permissionsHash !== slot.value) {
				return {
					ok: false,
					reason: 'permissions hash differs from the shell, so this visitor is in another role set'
				};
			}
			replacement = slot.value;
		} else if (slot.kind === 'csrf') replacement = identity.csrf?.['user/logout'];
		// a nonce is per-render and belongs to nobody, so the harvested one will do
		else replacement = slot.value;

		if (replacement === undefined) {
			return { ok: false, reason: `no value supplied for ${slot.kind} slot ${slot.name}` };
		}
		html = html.split(slot.name).join(replacement);
	}
	return { ok: true, html };
}
