import { createHash } from 'node:crypto';

/**
 * Run a step twice in the same object and compare the two results.
 *
 * **This is the whole point of the operation lane.** Five of this project's most expensive defects
 * were the same class and all of them were invisible on the first request, because the first request
 * is the one that populates whatever static, memo or cache then lies to the second:
 *
 *   - `Html::$seenIds` -- a static that `drupal_static_reset()` does not clear, so every block id
 *     came back suffixed `--2` on render 2
 *   - `PathMatcher::isFrontPage` -- memoised, so `/` stopped being the front page after another
 *     path was rendered first
 *   - `PageCache::$cid` -- computed once, reused for a different request
 *   - `drupal_static` generally
 *   - the uid-1 poisoning, where an unrestored `currentUser` leaked admin HTML into `cfw_page`
 *
 * A single-request assertion cannot see any of them. Neither can a two-request assertion that only
 * checks both were 200.
 *
 * **A test that permits "something changed" catches nothing**, so this module offers exactly two
 * verdicts: identical, or different in a named way. There is no "roughly the same".
 */

export interface Pair<T> {
	first: T;
	second: T;
}

/** Runs `step` twice, in order, against the same object. */
export async function twice<T>(step: () => Promise<T>): Promise<Pair<T>> {
	const first = await step();
	const second = await step();
	return { first, second };
}

export const sha1 = (value: string | Uint8Array): string =>
	createHash('sha1')
		.update(typeof value === 'string' ? Buffer.from(value, 'utf8') : value)
		.digest('hex');

/**
 * The first difference between two strings, as a readable excerpt.
 *
 * Byte offsets alone are unreadable in a 12 KB page, and a full diff buries the one line that
 * matters. This reports the offset plus a window either side, which is what makes a failure
 * actionable rather than merely red.
 */
export function firstDifference(a: string, b: string, window = 90): string | null {
	if (a === b) return null;
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a[i] === b[i]) i++;
	const from = Math.max(0, i - window);
	const to = i + window;
	return (
		`first difference at offset ${i} (lengths ${a.length} vs ${b.length})\n` +
		`  run 1: ...${a.slice(from, to).replace(/\n/g, '\\n')}...\n` +
		`  run 2: ...${b.slice(from, to).replace(/\n/g, '\\n')}...`
	);
}

/**
 * Every substring matching `pattern`, so a difference can be attributed to a known cause.
 *
 * Used to assert the SPECIFIC difference when identity is not expected -- a generation counter that
 * legitimately moved, for instance -- rather than accepting any difference at all.
 */
export function extractAll(text: string, pattern: RegExp): string[] {
	const re = new RegExp(
		pattern.source,
		pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
	);
	return [...text.matchAll(re)].map((m) => m[0]);
}

/**
 * Renders the two bodies with every occurrence of `pattern` masked.
 *
 * The honest way to compare two pages that differ only in a known, expected way: mask the known
 * difference and require the REST to be byte-identical. Dropping the assertion entirely, or
 * loosening it to a length check, is what lets a real change hide behind an expected one.
 */
export function maskedPair(pair: Pair<string>, pattern: RegExp, mask = '<masked>'): Pair<string> {
	const re = new RegExp(
		pattern.source,
		pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
	);
	return {
		first: pair.first.replace(re, mask),
		second: pair.second.replace(re, mask)
	};
}

/** the `--2`, `--3` id suffixes Drupal appends when `Html::$seenIds` was not reset */
export const DUPLICATE_ID_SUFFIX = /\bid="[^"]*--\d+"/g;

/** every `id="..."` in a document, which is where the seenIds defect shows first */
export const ALL_IDS = /\bid="[^"]*"/g;

/**
 * Views' per-render DOM id, which is a function of the site GENERATION rather than of the content.
 *
 * Measured: three `/assemble` re-renders at one generation are byte-identical, and each
 * `/invalidate` produces a new `js-view-dom-id` and therefore a new sha1 while the byte LENGTH stays
 * at 12,304. So a page's bytes change every time the generation moves even though nothing about the
 * content did.
 *
 * Masked rather than ignored. A comparison that dropped the whole assertion would stop seeing every
 * other difference too, and this token is exactly 64 hex characters in a known prefix, so it can be
 * removed precisely.
 */
export const VIEW_DOM_ID = /js-view-dom-id-[0-9a-f]{64}/g;

/**
 * `drupalSettings.user.permissionsHash`, which is derived from the site's PRIVATE KEY.
 *
 * Measured: `system.private_key` is ABSENT from the shipped `site.sqlite` and is minted on the
 * first live render -- `SELECT COUNT(*) FROM key_value WHERE name='system.private_key'` returns 0
 * after migrate, 0 after a prefill-served read, and 1 after the first inline render. The key is
 * therefore per site, which is the correct posture and matches how `hash_salt` is handled.
 *
 * The consequence for comparison is the point: the prefilled page carries a `permissionsHash`
 * computed on the BUILD machine from a key no deployed site has, so a live re-render can never
 * reproduce the packed bytes. Any byte-identity assertion that spans the prefill/live boundary has
 * to mask this or it is asserting that two different sites share a secret.
 */
export const PERMISSIONS_HASH = /"permissionsHash":"[0-9a-f]{64}"/g;

/**
 * Everything that legitimately varies between two renders of identical content.
 *
 * Kept as one list so a comparison masks the known set and nothing else. Adding to it is a
 * deliberate act that should come with a measurement, because every entry is a thing this suite can
 * no longer see.
 */
export const RENDER_NONCES = [VIEW_DOM_ID, PERMISSIONS_HASH];

/** Masks every known render nonce, leaving all other differences visible. */
export function maskNonces(pair: Pair<string>): Pair<string> {
	let out = pair;
	for (const pattern of RENDER_NONCES) out = maskedPair(out, pattern);
	return out;
}
