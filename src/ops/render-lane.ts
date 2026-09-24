/**
 * Image derivatives rendered ahead of the first view, on Durable Objects of their own.
 *
 * A rendering lane is not a replica lane: it holds no Drupal state, never catches up and serves no
 * request. It takes a source image and a transform and answers the bytes, so every configured style
 * of one upload can render at once. Measured on a deployed pool of four with a 261,638-byte JPEG and
 * the four shipped styles: 342 ms p50 against 497 ms on one lane (n=8), output byte-identical. The
 * widest style bounds the job, which is why four styles do not reach four times.
 */
import { defineLane, LanePool, type LaneResult } from '@drupflare/burrow/parallel';
import wasm3 from '@drupflare/burrow/vendor/wasm3.wasm';
import { runImageTransform, type Transform } from './image-runtime.js';

/** the binding name the coordinator object reaches the lanes by */
export const RENDER_LANES_BINDING = 'RENDER_LANES';

/** a slice is the transform as a JSON header, then the source bytes */
export function frameDerive(transform: Transform, source: Uint8Array): Uint8Array {
	const header = new TextEncoder().encode(JSON.stringify(transform));
	const out = new Uint8Array(4 + header.length + source.length);
	new DataView(out.buffer).setUint32(0, header.length, true);
	out.set(header, 4);
	out.set(source, 4 + header.length);
	return out;
}

/** the inverse of {@link frameDerive} */
export function unframeDerive(input: Uint8Array): { transform: Transform; source: Uint8Array } {
	const size = new DataView(input.buffer, input.byteOffset, 4).getUint32(0, true);
	const transform = JSON.parse(
		new TextDecoder().decode(input.subarray(4, 4 + size))
	) as Transform;
	return { transform, source: input.subarray(4 + size) };
}

export const RenderLane = defineLane({
	interpreter: wasm3,
	tasks: {
		derive: async (input: Uint8Array) => {
			const { transform, source } = unframeDerive(input);
			return (await runImageTransform(source, transform)).bytes;
		}
	}
});

/** renders every transform of one source, one slice each; the seam a test replaces */
export type DeriveTransport = (
	source: Uint8Array,
	transforms: readonly Transform[]
) => Promise<{ bytes: Uint8Array[]; requests: number; lanes: number }>;

/** the shipping transport: one `LanePool` job over the rendering lanes */
export function laneTransport(ns: DurableObjectNamespace, size = 4): DeriveTransport {
	return async (source, transforms) => {
		const pool = new LanePool(ns, { size, binding: RENDER_LANES_BINDING });
		const results: LaneResult[] = await pool.map(
			{ task: 'derive' },
			transforms.map((t) => frameDerive(t, source))
		);
		return {
			bytes: results.map((r) => r.bytes),
			requests: pool.lastStats?.requests ?? results.length,
			lanes: new Set(results.map((r) => r.lane)).size
		};
	};
}

/** whether uploads render their styles ahead of the first view; on wherever the binding is */
export function eagerDerivativesEnabled(env?: {
	RENDER_LANES?: unknown;
	EAGER_DERIVATIVES?: string | null;
}): boolean {
	if (!env?.RENDER_LANES) return false;
	return String(env.EAGER_DERIVATIVES ?? '1') !== '0';
}

/** where a stored derivative lives in the file store, keyed by the delivery identity */
export function derivativeUri(id: string): string {
	return `public://cfw-derivatives/${id}`;
}
