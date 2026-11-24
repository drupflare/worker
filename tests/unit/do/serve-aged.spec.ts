import { describe, expect, it } from 'vitest';
import { serveFromStorage } from '../../../src/do/serve';
import type { SitePhpDurableObject } from '../../../src/site-do';

type Fake = {
	site: SitePhpDurableObject;
	deleted: string[];
	enqueued: string[];
	answered: string[];
};

/** a site whose one stored page is superseded, with just the surface the fast lane touches */
function supersededSite(env: Record<string, string>): Fake {
	const deleted: string[] = [];
	const enqueued: string[] = [];
	const answered: string[] = [];
	const row = { status: 200, html: 'old', rendered_at: 1, render_ms: 1, stale_at: 1000 };
	const site = {
		env,
		sql: {
			exec: (query: string, ...args: unknown[]) => {
				if (query.startsWith('DELETE')) deleted.push(String(args[0]));
				return { toArray: () => (query.startsWith('SELECT') ? [row] : []) };
			}
		},
		pageStaleness: () => 1000,
		nowMs: () => 2000,
		enqueueRefill: (path: string) => enqueued.push(path),
		pageResponse: (_row: unknown, tier: string) => {
			answered.push(tier);
			return new Response(null);
		},
		gate: { stats: () => ({ active: 0, queued: 0 }) },
		laneHeaders: () => ({}),
		queueDepth: () => 0,
		encounters: { cold: 0, warm: 0, noPhp: 0 },
		pageHits: new Map(),
		flushServeRequests: () => {}
	} as unknown as SitePhpDurableObject;
	return { site, deleted, enqueued, answered };
}

const url = new URL('https://do.local/__serve?path=%2Fa%2F');

describe('the fast lane and a superseded page', () => {
	it('leaves a WordPress page to the gated lane, which renders it', () => {
		const seen = supersededSite({ CMS: 'wordpress' });
		expect(serveFromStorage(seen.site, url)).toBeUndefined();
		expect(seen.deleted).toEqual(['/a/']);
		expect(seen.answered).toEqual([]);
	});

	it('answers the old page on Drupal while it refills', () => {
		const seen = supersededSite({ CMS: 'drupal' });
		expect(serveFromStorage(seen.site, url)).toBeInstanceOf(Response);
		expect(seen.answered).toEqual(['AGED']);
		expect(seen.deleted).toEqual([]);
	});

	it('answers the old page on WordPress when the operator sets a window', () => {
		const seen = supersededSite({ CMS: 'wordpress', AGED_SERVE_MAX_MS: '60000' });
		expect(serveFromStorage(seen.site, url)).toBeInstanceOf(Response);
		expect(seen.answered).toEqual(['AGED']);
	});
});
