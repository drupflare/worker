import { deflateSync } from 'fflate';

/** one entry of a hand-built archive; the overrides write headers that disagree with the data */
export interface BuiltEntry {
	name: string;
	data?: string | Uint8Array;
	method?: 0 | 8;
	/** unix mode in the external attributes, with the unix host byte set */
	unixMode?: number;
	flags?: number;
	/** the expanded size the headers claim, when it should differ from the data */
	declaredExpanded?: number;
	/** the compressed bytes to store, when they should differ from the deflated data */
	rawCompressed?: Uint8Array;
}

const TABLE = new Uint32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** builds a zip with a central directory, writing each header from the entry as given */
export function buildZip(entries: BuiltEntry[]): Uint8Array {
	const text = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = text.encode(e.name);
		const data =
			typeof e.data === 'string' ? text.encode(e.data) : (e.data ?? new Uint8Array());
		const method = e.method ?? (e.name.endsWith('/') ? 0 : 8);
		const stored = e.rawCompressed ?? (method === 8 ? deflateSync(data) : data);
		const expanded = e.declaredExpanded ?? data.length;
		const crc = crc32(data);
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true);
		local.setUint16(6, e.flags ?? 0, true);
		local.setUint16(8, method, true);
		local.setUint32(14, crc, true);
		local.setUint32(18, stored.length, true);
		local.setUint32(22, expanded, true);
		local.setUint16(26, name.length, true);
		const entryOffset = offset;
		chunks.push(new Uint8Array(local.buffer), name, stored);
		offset += 30 + name.length + stored.length;

		const dir = new DataView(new ArrayBuffer(46));
		dir.setUint32(0, 0x02014b50, true);
		dir.setUint16(4, e.unixMode === undefined ? 20 : (3 << 8) | 20, true);
		dir.setUint16(6, 20, true);
		dir.setUint16(8, e.flags ?? 0, true);
		dir.setUint16(10, method, true);
		dir.setUint32(16, crc, true);
		dir.setUint32(20, stored.length, true);
		dir.setUint32(24, expanded, true);
		dir.setUint16(28, name.length, true);
		dir.setUint32(38, e.unixMode === undefined ? 0 : (e.unixMode << 16) >>> 0, true);
		dir.setUint32(42, entryOffset, true);
		central.push(new Uint8Array(dir.buffer), name);
	}
	const centralSize = central.reduce((n, c) => n + c.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, centralSize, true);
	end.setUint32(16, offset, true);
	const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** a plugin archive that passes every rule: one folder holding a main file and a script */
export function cleanPluginZip(slug = 'fixture-plugin', extra: BuiltEntry[] = []): Uint8Array {
	return buildZip([
		{ name: `${slug}/` },
		{ name: `${slug}/${slug}.php`, data: `<?php\n/** Plugin Name: Fixture */\n` },
		{ name: `${slug}/js/app.js`, data: 'console.log(1);' },
		...extra
	]);
}
