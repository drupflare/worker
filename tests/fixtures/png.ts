/**
 * A real PNG, for tests that need the image decoder to succeed rather than to refuse.
 *
 * This is `assets/core/misc/druplicon.png`, 3,905 bytes, inlined because the workers test lane
 * has no filesystem and wrangler declares no module rule for `.png`. A hand-rolled 1x1 or 4x2 PNG is
 * NOT a substitute: tinyimg's probe rejects both with `corrupt data`, so a spec built on one asserts
 * the refusal path while reading as the success path.
 */
export const DRUPLICON_PNG_BASE64 =
	'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' +
	'XUUR7bgAAAAASUVORK5CYII=';

/** the same image as bytes */
export function druplicon(): Uint8Array {
	return Uint8Array.from(atob(DRUPLICON_PNG_BASE64), (c) => c.charCodeAt(0));
}
