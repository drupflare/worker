import type { SitePhpDurableObject } from '../../site-do';
import { isolateId, isolateResidency, spareMemoryBytes } from '../isolate';

const MIB = 1 << 20;
const FRAME = 4 * MIB;

// kept for the isolate's life on purpose: the ladder counts how much one holds before it is replaced
const held: Uint8Array[] = [];

/** allocates and touches one 4 MiB buffer per POST and reports the isolate; 404 unless `LADDER_PROBE` is 1 */
export async function ladder(site: SitePhpDurableObject, request: Request): Promise<Response> {
	if (site.env.LADDER_PROBE !== '1') return new Response('not found', { status: 404 });
	if (request.method !== 'POST') {
		return new Response('use POST', { status: 405, headers: { allow: 'POST' } });
	}
	const frame = new Uint8Array(new ArrayBuffer(FRAME));
	// a write per page, or the platform may map the buffer lazily and not charge it
	for (let i = 0; i < frame.length; i += 4096) frame[i] = 1;
	held.push(frame);
	return Response.json({
		id: isolateId(),
		totalMiB: (held.length * FRAME) / MIB,
		linearMiB: isolateResidency().linearBytes / MIB,
		spareMiB: spareMemoryBytes() / MIB
	});
}
