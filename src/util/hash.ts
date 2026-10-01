/** FNV-1a over UTF-16 code units, unsigned; for change detection and spread, not secrecy */
export function fnv1a32(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}
