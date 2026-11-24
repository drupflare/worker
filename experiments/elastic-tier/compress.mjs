import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
const file = process.argv[2];
const raw = readFileSync(file);
const rss = () => Math.round(process.memoryUsage().rss / 1048576);
const out = [];
const arms = {
	'brotli-q5': () => zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
	'brotli-q9': () => zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
	'brotli-q11': () => zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
	'zstd-3': () => zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3, [zlib.constants.ZSTD_c_contentSizeFlag]: 1 } }),
	'zstd-19': () => zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19, [zlib.constants.ZSTD_c_contentSizeFlag]: 1 } }),
	'zstd-22': () => zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 22, [zlib.constants.ZSTD_c_contentSizeFlag]: 1 } })
};
const only = process.argv[3];
for (const [name, fn] of Object.entries(arms)) {
	if (only && !only.split(',').includes(name)) continue;
	const t0 = performance.now();
	const packed = fn();
	const packMs = performance.now() - t0;
	const times = [];
	let peak = 0;
	for (let i = 0; i < 5; i++) {
		const t = performance.now();
		const back = name.startsWith('brotli') ? zlib.brotliDecompressSync(packed) : zlib.zstdDecompressSync(packed);
		times.push(performance.now() - t);
		peak = Math.max(peak, rss());
		if (i === 0 && !back.equals(raw)) throw new Error('round trip differs');
	}
	times.sort((a, b) => a - b);
	out.push({ name, packed: packed.length, ratio: +(packed.length / raw.length).toFixed(4), packMs: Math.round(packMs), inflateMsMedian: +times[2].toFixed(1), inflateMsMin: +times[0].toFixed(1), inflateMsMax: +times[4].toFixed(1), rssMiBAfter: peak });
}
const comp = [];
for (let i = 0; i < 5; i++) {
	const t = performance.now();
	const m = new WebAssembly.Module(raw);
	comp.push(performance.now() - t);
	void m;
}
comp.sort((a, b) => a - b);
console.log(JSON.stringify({ file, raw: raw.length, results: out, compileMs: { median: +comp[2].toFixed(1), min: +comp[0].toFixed(1), max: +comp[4].toFixed(1) } }, null, 1));
