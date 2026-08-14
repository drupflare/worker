/**
 * A6: is `DecompressionStream` billed as CPU?
 *
 * The question cannot be answered from inside a Worker -- `Date.now()` is frozen for the
 * whole synchronous stretch and a codec pass performs no I/O, so `gunzipMs` in
 * `src/probes/heapsize.ts` reads **0** on the edge for work that takes 155-173 ms locally.
 * Only `cpuTime` from a deployed worker can answer it, and a single A/B against a route
 * that also boots PHP cannot: the boot's own variance (6,161-9,164 ms measured) is 50x the
 * quantity under test.
 *
 * So this probe makes the codec the ONLY variable: fetch one blob, then run the same pass
 * over it N times in one invocation. cpuTime against N is a line whose SLOPE is the
 * per-pass cost and whose intercept absorbs the fetch. A slope near zero means the codec is
 * not billed to the invocation; a slope near the local wall clock means it is.
 *
 * `/noop` is the positive control: a pass that is unambiguously JS CPU. If its slope is
 * flat too, the method is broken rather than the codec being free.
 */

/** the one binding this probe reads its blob through */
interface DecompEnv {
	ASSETS: Fetcher;
}

/** the streaming pack's gzip member; 8.2 MB in, 39.9 MB out, and already on the account */
const BLOB = 'https://a.local/drupal/core.bin.gz';

function passCount(url: URL): number {
	const n = Number(url.searchParams.get('n') ?? 1);
	// bounded so one request cannot spend a minute of CPU by typo
	return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 8) : 1;
}

/** the compressed blob, as bytes this isolate can replay without a second subrequest */
async function loadBlob(env: DecompEnv): Promise<Uint8Array> {
	const res = await env.ASSETS.fetch(new URL(BLOB));
	if (!res.ok) throw new Error(`blob not reachable: ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

/**
 * Inflates `bytes` and returns the output length, holding nothing.
 *
 * The reader is drained concurrently with the write because awaiting the whole write first
 * deadlocks on backpressure once the output exceeds the queue -- the same reason
 * `heapsize.ts` streams its gzip.
 */
async function gunzip(bytes: Uint8Array): Promise<number> {
	const ds = new DecompressionStream('gzip');
	const writer = ds.writable.getWriter();
	const reader = ds.readable.getReader();
	let out = 0;
	const draining = (async () => {
		for (;;) {
			const r = await reader.read();
			if (r.done) return;
			out += r.value.byteLength;
		}
	})();
	await writer.write(bytes);
	await writer.close();
	await draining;
	return out;
}

/** inflates `bytes` into one buffer, for the compression side to have real data to chew */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
	const ds = new DecompressionStream('gzip');
	const writer = ds.writable.getWriter();
	const reader = ds.readable.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	const draining = (async () => {
		for (;;) {
			const r = await reader.read();
			if (r.done) return;
			chunks.push(r.value);
			total += r.value.byteLength;
		}
	})();
	await writer.write(bytes);
	await writer.close();
	await draining;
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

/** deflates `bytes` and returns the output length */
async function gzip(bytes: Uint8Array): Promise<number> {
	const cs = new CompressionStream('gzip');
	const writer = cs.writable.getWriter();
	const reader = cs.readable.getReader();
	let out = 0;
	const draining = (async () => {
		for (;;) {
			const r = await reader.read();
			if (r.done) return;
			out += r.value.byteLength;
		}
	})();
	await writer.write(bytes);
	await writer.close();
	await draining;
	return out;
}

/** the control: a byte sum over the same buffer, which is unambiguously billed JS CPU */
function sum(bytes: Uint8Array): number {
	let acc = 0;
	for (let i = 0; i < bytes.length; i++) acc = (acc + bytes[i]!) | 0;
	return acc;
}

export default {
	async fetch(request: Request, env: DecompEnv): Promise<Response> {
		const url = new URL(request.url);
		const n = passCount(url);
		try {
			switch (url.pathname) {
				case '/gunzip': {
					const bytes = await loadBlob(env);
					let out = 0;
					for (let i = 0; i < n; i++) out = await gunzip(bytes);
					return Response.json({
						route: '/gunzip',
						passes: n,
						bytesIn: bytes.byteLength,
						bytesOutPerPass: out,
						// wall clock is reported so its uselessness out here stays on the record
						note: 'cpuTime from the observability API is the only reading of this'
					});
				}

				case '/gzip': {
					// deflate the INFLATED bytes, so the two codecs are compared over the same
					// data rather than over 8 MB of already-compressed input
					const bytes = await loadBlob(env);
					const inflated = await inflate(bytes);
					let out = 0;
					for (let i = 0; i < n; i++) out = await gzip(inflated);
					return Response.json({
						route: '/gzip',
						passes: n,
						bytesIn: inflated.byteLength,
						bytesOutPerPass: out
					});
				}

				case '/noop': {
					const bytes = await loadBlob(env);
					let acc = 0;
					for (let i = 0; i < n; i++) acc = sum(bytes);
					return Response.json({
						route: '/noop',
						passes: n,
						bytesIn: bytes.byteLength,
						checksum: acc
					});
				}

				default:
					return new Response(
						[
							'/gunzip?n=K  K DecompressionStream passes over one 8.2 MB gzip member',
							'/gzip?n=K    K CompressionStream passes over its 39.9 MB inflation',
							'/noop?n=K    K byte-sum passes over the same buffer (the control)',
							'',
							'cpuTime against K is a line; the slope is the per-pass cost.'
						].join('\n'),
						{ status: 404 }
					);
			}
		} catch (e: any) {
			return new Response(`${e?.stack ?? e}`, { status: 500 });
		}
	}
};
