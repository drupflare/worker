async function probe(request) {
	const url = new URL(request.url);
	const pages = Number(url.searchParams.get('pages') ?? 2400);
	const out = { pages, results: [] };
	let mem;
	try {
		mem = new WebAssembly.Memory({ initial: 1280 });
		const steps = [];
		for (const target of [1447, 1636, 1849, 2090, 2362, pages]) {
			if (target > mem.buffer.byteLength / 65536 && target <= pages) {
				try {
					mem.grow(target - mem.buffer.byteLength / 65536);
					steps.push(target);
				} catch (e) {
					steps.push('fail ' + target + ' ' + e);
					break;
				}
			}
		}
		out.steps = steps;
	} catch (e) {
		return Response.json({ err: String(e) });
	}
	var cfwSafeSubarray = function (v) {
		var n = v.subarray,
			bpe = v.BYTES_PER_ELEMENT;
		v.subarray = function (a, b) {
			var len = this.length;
			a = a === undefined ? 0 : Math.trunc(a) || 0;
			a = a < 0 ? Math.max(len + a, 0) : Math.min(a, len);
			b = b === undefined ? len : Math.trunc(b) || 0;
			b = b < 0 ? Math.max(len + b, 0) : Math.min(b, len);
			var off = this.byteOffset + a * bpe;
			if (off < 134217728) return n.call(this, a, b);
			return new this.constructor(this.buffer, off, Math.max(b - a, 0));
		};
		return v;
	};
	('+');
	const u8 = cfwSafeSubarray(new Uint8Array(mem.buffer));
	out.byteLength = mem.buffer.byteLength;
	const dec = new TextDecoder();
	const offs = [1e6, 100e6, 120e6, 130e6, 134_217_000, 134_218_000, 137_757_516, 145e6];
	const tests = {
		subarray: (o) => u8.subarray(o, o + 2456).length,
		ctor: (o) => new Uint8Array(mem.buffer, o, 2456).length,
		sub2: (o) => u8.subarray(o, o + 4).length,
		sub1m: (o) => u8.subarray(o, o + 1000000).length,
		slice: (o) => u8.slice(o, o + 2456).length,
		decodeSub: (o) => dec.decode(u8.subarray(o, o + 2456)).length,
		set: (o) => {
			new Uint8Array(4096).set(u8.subarray(o, o + 2456));
			return 1;
		},
		setAt: (o) => {
			u8.set(new Uint8Array(100), o);
			return 1;
		},
		copyWithin: (o) => {
			u8.copyWithin(o, 1000, 1100);
			return 1;
		},
		fill: (o) => {
			u8.fill(0, o, o + 100);
			return 1;
		},
		i32sub: (o) => new Int32Array(mem.buffer).subarray(o >> 2, (o >> 2) + 10).length,
		viaCtorPatched: (o) => {
			const v = new Uint8Array(u8.buffer, u8.byteOffset + o, 2456);
			return dec.decode(v).length;
		},
		dataview: (o) => new DataView(mem.buffer, o, 100).byteLength
	};
	for (const o of offs)
		for (const [name, fn] of Object.entries(tests)) {
			try {
				out.results.push([name, o, 'ok', fn(o)]);
			} catch (e) {
				out.results.push([name, o, String(e)]);
			}
		}
	return Response.json(out);
}
export class Probe {
	constructor(s, e) {}
	async fetch(r) {
		return probe(r);
	}
}
export default {
	async fetch(r, env) {
		return env.P.get(env.P.idFromName('x')).fetch(r);
	}
};
