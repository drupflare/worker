/** the bytes of a binary string, one per char code (what `atob` returns) */
export function binaryToBytes(raw: string): Uint8Array {
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}
