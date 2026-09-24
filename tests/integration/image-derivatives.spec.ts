import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '../../src/db/file-store';
import { runImageTransform } from '../../src/ops/image-runtime';
import type { DeriveTransport } from '../../src/ops/render-lane';
import { druplicon } from '../fixtures/png';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * An upload's image styles, rendered on the rendering lanes and stored before anyone asks.
 *
 * The lanes themselves are replaced by an in-process transport running the same transform, so the
 * gate stays hermetic; `tests/unit/ops/render-lane.spec.ts` covers the slice framing the real
 * transport sends, and a deployed run covers the hop.
 */

const TIMEOUT = 900_000;
const URI = 'public://2026-09/druplicon.png';

type Bag = Record<string, (json: string) => string>;

const local: DeriveTransport = async (source, transforms) => ({
	bytes: await Promise.all(
		transforms.map(async (t) => (await runImageTransform(source, t)).bytes)
	),
	requests: transforms.length,
	lanes: 1
});

async function uploaded(site: ServeDo): Promise<void> {
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	// a hook reaches a site through a container rebuild, which reconciliation performs
	site.sql.exec('DELETE FROM cache_container');
	const bag: Bag = {};
	site.installCapabilities(bag);
	bag.cfwFileWrite!(
		JSON.stringify({ uri: URI, b64: bytesToBase64(druplicon()), mime: 'image/png' })
	);
}

describe('an uploaded image is queued for its styles', () => {
	it(
		'queues a public image and not a derivative or a private file',
		async () => {
			const rows = await inObject(freshSite(), async (site: ServeDo) => {
				await uploaded(site);
				site.queueDerivatives('public://cfw-derivatives/abc');
				site.queueDerivatives('private://secret.png');
				site.queueDerivatives('public://notes.txt');
				return site.sql.exec('SELECT uri FROM cfw_derive_queue').toArray();
			});
			expect(rows).toEqual([{ uri: URI }]);
		},
		TIMEOUT
	);
});

describe('the derive step stores every style the page will ask for', () => {
	it(
		'renders each style URL Drupal emits and answers it in place of the source',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await uploaded(site);
				await site.deriveStep(local);
				const stats = (await (
					await site.fetch(new Request('https://do.local/__serve-stats'))
				).json()) as { lastDerive?: { styles?: number } };
				const stored = site.sql
					.exec(
						"SELECT uri, mime FROM cfw_file WHERE uri LIKE 'public://cfw-derivatives/%'"
					)
					.toArray() as { uri: string; mime: string }[];
				const id =
					String(stored[0]?.uri ?? '')
						.split('/')
						.pop() ?? '';
				const hit = await site.fetch(
					new Request(
						`https://do.local/__filebytes?uri=${encodeURIComponent(URI)}&derivative=${id}`
					)
				);
				const miss = await site.fetch(
					new Request(
						`https://do.local/__filebytes?uri=${encodeURIComponent(URI)}&derivative=nothing`
					)
				);
				return {
					styles: stats.lastDerive?.styles ?? 0,
					stored: stored.length,
					mimes: [...new Set(stored.map((s) => s.mime))],
					hit: hit.headers.get('x-cfw-derivative'),
					miss: miss.headers.get('x-cfw-derivative'),
					missBytes: (await miss.arrayBuffer()).byteLength,
					queued: site.sql.exec('SELECT count(*) AS n FROM cfw_derive_queue').toArray()[0]
				};
			});
			// the shipped pack carries four styles and the delivery path expresses all of them
			expect(out.styles).toBe(4);
			expect(out.stored).toBe(4);
			expect(out.mimes).toEqual(['image/avif']);
			expect(out.hit).toBe('stored');
			// an identity with no stored copy falls back to the source bytes
			expect(out.miss).toBeNull();
			expect(out.missBytes).toBe(druplicon().length);
			expect(out.queued).toEqual({ n: 0 });
		},
		TIMEOUT
	);
});
