/**
 * Every image style of one upload, rendered on a separate Durable Object class rather than in turn.
 *
 *   POST /?lanes=4  body: the source image
 *
 * A trial of the rendering lane: pure work, bytes in and bytes out, no Drupal state and nothing
 * shared with the replica pool. Each arm is a `LanePool` job, one lane against `lanes`, so both
 * wall clocks span I/O and read true on a deployed worker. The answer compares every derivative
 * across the two arms byte for byte.
 */
import { defineLane, LanePool, type LaneResult } from '@drupflare/burrow/parallel';
import wasm3 from '@drupflare/burrow/vendor/wasm3.wasm';
import { runImageTransform, type Transform } from '../ops/image-runtime.js';

/** the four shipped styles, all `image_scale` plus the AVIF convert */
const STYLES: Record<string, Transform> = {
	thumbnail: { width: 100, height: 100, fit: 'scale-down', format: 'avif' },
	medium: { width: 220, height: 220, fit: 'scale-down', format: 'avif' },
	large: { width: 480, height: 480, fit: 'scale-down', format: 'avif' },
	wide: { width: 1090, fit: 'scale-down', format: 'avif' }
};

/** a slice is the style as a JSON header, then the source bytes */
function frame(transform: Transform, source: Uint8Array): Uint8Array {
	const header = new TextEncoder().encode(JSON.stringify(transform));
	const out = new Uint8Array(4 + header.length + source.length);
	new DataView(out.buffer).setUint32(0, header.length, true);
	out.set(header, 4);
	out.set(source, 4 + header.length);
	return out;
}

export const RenderLane = defineLane({
	interpreter: wasm3,
	tasks: {
		derive: async (input: Uint8Array) => {
			const size = new DataView(input.buffer, input.byteOffset, 4).getUint32(0, true);
			const transform = JSON.parse(
				new TextDecoder().decode(input.subarray(4, 4 + size))
			) as Transform;
			return (await runImageTransform(input.subarray(4 + size), transform)).bytes;
		}
	}
});

type Env = { RENDER_LANES: DurableObjectNamespace };

async function arm(env: Env, size: number, source: Uint8Array) {
	// the coordinator object finds the lanes by binding name, which defaults to BURROW_LANES
	const pool = new LanePool(env.RENDER_LANES, { size, binding: 'RENDER_LANES' });
	const t = Date.now();
	const results: LaneResult[] = await pool.map(
		{ task: 'derive' },
		Object.values(STYLES).map((style) => frame(style, source))
	);
	return {
		ms: Date.now() - t,
		stats: pool.lastStats,
		bytes: results.map((r) => r.bytes),
		lanes: [...new Set(results.map((r) => r.lane))].length
	};
}

const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
	a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== 'POST') return new Response('POST an image', { status: 405 });
		const source = new Uint8Array(await request.arrayBuffer());
		const lanes = Math.max(1, Number(new URL(request.url).searchParams.get('lanes') ?? 4));
		const serial = await arm(env, 1, source);
		const parallel = await arm(env, lanes, source);
		const names = Object.keys(STYLES);
		return Response.json({
			sourceBytes: source.length,
			serialMs: serial.ms,
			parallelMs: parallel.ms,
			lanesUsed: { serial: serial.lanes, parallel: parallel.lanes },
			serialStats: serial.stats,
			parallelStats: parallel.stats,
			styles: names.map((name, i) => ({
				name,
				bytes: parallel.bytes[i]?.length ?? 0,
				identical: same(serial.bytes[i], parallel.bytes[i])
			}))
		});
	}
};
