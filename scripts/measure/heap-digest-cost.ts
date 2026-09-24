/**
 * What verifying a heap image costs, on the engine workerd runs.
 *
 *   node scripts/measure/heap-digest-cost.ts [bytes]
 *
 * Times `digestBytes()` over a whole cold image (37,158,912 bytes by default) and over the same
 * bytes as 200,000-byte chunks, which is what a restore checks. Run it under node rather than bun:
 * bun is JavaScriptCore, and its first pass over the image reads ~10x slower than V8's.
 */
import { digestBytes } from '../../src/db/heap-store.ts';

const bytes = Number(process.argv[2] ?? 37_158_912);
const chunk = 200_000;
const heap = new Uint8Array(bytes);
for (let i = 0; i < bytes; i += 4096) heap[i] = i & 255;

const time = (fn: () => void) => {
	const t = performance.now();
	fn();
	return +(performance.now() - t).toFixed(1);
};

const whole = Array.from({ length: 7 }, () => time(() => digestBytes(heap)));
const chunked = time(() => {
	for (let at = 0; at < bytes; at += chunk) digestBytes(heap.subarray(at, at + chunk));
});
console.log(JSON.stringify({ bytes, wholeMs: whole, chunkedMs: chunked }));
