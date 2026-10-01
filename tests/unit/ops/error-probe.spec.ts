import { describe, expect, it } from 'vitest';
import { chunkStack, flatFields, isLengthError } from '../../../src/ops/error-probe';
import type { SitePhpDurableObject } from '../../../src/site-do';
import { freshSite, inObject, type ServeDo } from '../../helpers/serve-do';

describe('the RangeError probe', () => {
	it('recognises a length error and nothing else', () => {
		expect(isLengthError(new RangeError('Invalid array buffer length'))).toBe(true);
		expect(isLengthError(new Error('Invalid array buffer length'))).toBe(true);
		expect(isLengthError(new Error('boom'))).toBe(false);
	});

	it('splits a long stack into pieces and flattens them to fields', () => {
		const pieces = chunkStack('x'.repeat(1000), 400);
		expect(pieces.map((p) => p.length)).toEqual([400, 400, 200]);
		const fields = flatFields({
			at: 1,
			where: 'fetch',
			method: 'GET',
			path: '/a',
			message: 'm',
			stack: pieces,
			linear: 5,
			isolate: 6,
			reused: 0,
			bootMs: null,
			grow: [{ size: 1 }],
			sub: []
		});
		expect(fields['stack2']).toBe('x'.repeat(200));
		expect(fields['grow']).toBe('[{"size":1}]');
	});

	it('keeps the report on the object, with the last growth attempts, and ignores other errors', async () => {
		const seen = await inObject(freshSite(), async (handle: ServeDo) => {
			const site = handle as unknown as SitePhpDurableObject;
			(globalThis as { __cfwGrow?: unknown[] }).__cfwGrow = [{ size: 7, ok: 0 }];
			site.noteRangeError(new Error('unrelated'), 'fetch');
			site.noteRangeError(
				new RangeError('Invalid array buffer length'),
				'fetch',
				new Request('https://do.local/__serve?path=%2Fnode%2F1', { method: 'POST' })
			);
			delete (globalThis as { __cfwGrow?: unknown }).__cfwGrow;
			return site.rangeErrors;
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			where: 'fetch',
			method: 'POST',
			path: '/node/1',
			message: 'Invalid array buffer length',
			grow: [{ size: 7, ok: 0 }]
		});
		expect(seen[0]!.stack.join('')).toContain('Invalid array buffer length');
	});
});

type Noted = { at: number; where: string; message: string; stack?: string };

/** makes `site.sql` throw `message` for any statement containing `needle`; the result undoes it */
function failSql(site: SitePhpDurableObject, needle: string, message: string): () => void {
	const holder = site as unknown as { sql: { exec: (text: string, ...p: unknown[]) => unknown } };
	const real = holder.sql;
	holder.sql = new Proxy(real, {
		get(target, prop) {
			const value = Reflect.get(target, prop);
			if (prop !== 'exec') return typeof value === 'function' ? value.bind(target) : value;
			return (text: string, ...params: unknown[]) => {
				if (text.includes(needle)) throw new Error(message);
				return target.exec(text, ...params);
			};
		}
	});
	return () => {
		holder.sql = real;
	};
}

/** the ring as a caller of `/serve-stats` reads it */
async function ringOf(site: SitePhpDurableObject): Promise<Noted[]> {
	const res = await site.fetch(new Request('https://do.local/__serve-stats'));
	return ((await res.json()) as { recentErrors: Noted[] }).recentErrors;
}

describe('the recent error ring', () => {
	it('starts empty and reports through /serve-stats', async () => {
		const ring = await inObject(freshSite(), (handle: ServeDo) =>
			ringOf(handle as unknown as SitePhpDurableObject)
		);
		expect(ring).toEqual([]);
	});

	it('keeps the newest 20 when 21 are noted', async () => {
		const ring = await inObject(freshSite(), async (handle: ServeDo) => {
			const site = handle as unknown as SitePhpDurableObject;
			for (let i = 0; i < 21; i++) site.noteError('bound', new Error(`n${i}`));
			return ringOf(site);
		});
		expect(ring).toHaveLength(20);
		expect(ring[0]!.message).toBe('n1');
		expect(ring[19]!.message).toBe('n20');
	});

	it('records where, the message and the start of the stack', async () => {
		const ring = await inObject(freshSite(), async (handle: ServeDo) => {
			const site = handle as unknown as SitePhpDurableObject;
			site.noteError('somewhere', new Error('boom'));
			site.noteError('plain', 'just text');
			return ringOf(site);
		});
		expect(ring[0]).toMatchObject({ where: 'somewhere', message: 'boom' });
		expect(ring[0]!.stack).toContain('boom');
		expect(ring[0]!.stack!.length).toBeLessThanOrEqual(1_500);
		expect(ring[1]).toMatchObject({ where: 'plain', message: 'just text' });
		expect(ring[1]!.stack).toBeUndefined();
	});

	// each catch keeps its fallback and also records; a missing table is a state, not a fault
	const sqlCases: Array<{
		where: string;
		needle: string;
		fallback: (site: any) => unknown;
		expected: unknown;
	}> = [
		{
			where: 'packGeneration',
			needle: 'cfw_migrate',
			fallback: (site) => site.packGeneration(),
			expected: undefined
		},
		{
			where: 'enabledModulesFingerprint',
			needle: 'FROM config WHERE',
			fallback: (site) => site.enabledModulesFingerprint(),
			expected: ''
		},
		{
			where: 'packageAutoloads',
			needle: 'cfw_package_autoload',
			fallback: (site) => site.packageAutoloads(),
			expected: []
		},
		{
			where: 'purgeDynamicPageCache',
			needle: 'cache_dynamic_page_cache',
			fallback: (site) => site.purgeDynamicPageCache(),
			expected: -1
		},
		{
			where: 'carriedServeTotal',
			needle: 'GLOB',
			fallback: (site) => typeof site.carriedServeTotal(),
			expected: 'number'
		},
		{
			where: 'containerMissing',
			needle: 'cache_container',
			fallback: (site) => site.containerMissing(),
			expected: false
		}
	];

	for (const c of sqlCases) {
		it(`records ${c.where} and keeps its fallback`, async () => {
			const seen = await inObject(freshSite(), async (handle: ServeDo) => {
				const site = handle as unknown as SitePhpDurableObject;
				site.ensureServeTables();
				const undo = failSql(site, c.needle, 'disk I/O error');
				const value = c.fallback(site);
				undo();
				return { value, ring: await ringOf(site) };
			});
			expect(seen.value).toEqual(c.expected);
			expect(seen.ring).toHaveLength(1);
			expect(seen.ring[0]).toMatchObject({ where: c.where, message: 'disk I/O error' });
		});

		it(`does not record ${c.where} when the table is absent`, async () => {
			const seen = await inObject(freshSite(), async (handle: ServeDo) => {
				const site = handle as unknown as SitePhpDurableObject;
				site.ensureServeTables();
				const undo = failSql(site, c.needle, 'no such table: probe');
				const value = c.fallback(site);
				undo();
				return { value, ring: await ringOf(site) };
			});
			expect(seen.value).toEqual(c.expected);
			expect(seen.ring).toEqual([]);
		});
	}

	it('records a corrupt stepped-job row', async () => {
		const ring = await inObject(freshSite(), async (handle: ServeDo) => {
			const site = handle as unknown as SitePhpDurableObject;
			site.metaSet('ops_job', '{not json');
			expect(site.opsJobActive()).toBe(false);
			return ringOf(site);
		});
		expect(ring).toHaveLength(1);
		expect(ring[0]).toMatchObject({ where: 'readOpsJob' });
	});

	it('records a migration manifest the asset store could not serve', async () => {
		const seen = await inObject(freshSite(), async (handle: ServeDo) => {
			const site = handle as unknown as SitePhpDurableObject;
			const holder = site as unknown as { env: Record<string, unknown> };
			holder.env = {
				...holder.env,
				ASSETS: { fetch: async () => new Response('gone', { status: 404 }) }
			};
			const present = await site.hasMigrationManifest();
			return { present, ring: await ringOf(site) };
		});
		expect(seen.present).toBe(false);
		expect(seen.ring[0]).toMatchObject({ where: 'hasMigrationManifest' });
		expect(seen.ring[0]!.message).toContain('404');
	});

	it('records a forwarded write payload that is not JSON and buffers nothing', async () => {
		const seen = await inObject(freshSite(), async (handle: ServeDo) => {
			const site = handle as unknown as SitePhpDurableObject;
			site.collectForward([], '{not json');
			return { buffered: site.forwardBuffer?.length ?? 0, ring: await ringOf(site) };
		});
		expect(seen.buffered).toBe(0);
		expect(seen.ring[0]).toMatchObject({ where: 'collectForward' });
	});
});

describe('the demand record', () => {
	it('names the page that raised linear memory, keeps the highest per path, and caps the table', async () => {
		const seen = await inObject(freshSite(), async (handle: ServeDo) => {
			const site = handle as unknown as Pick<
				SitePhpDurableObject,
				'noteDemand' | 'demandLog' | 'demandByPath'
			> & { heapNow: () => number };
			let linear = 0;
			site.heapNow = () => linear;
			const at = (path: string) =>
				new Request(`https://do.local/__serve?path=${encodeURIComponent(path)}`);
			site.noteDemand(at('/cold'), 0, 0);
			linear = 100;
			site.noteDemand(at('/a'), 90, 0);
			linear = 150;
			site.noteDemand(at('/admin/reports/status?x=1'), 100, 0);
			linear = 120;
			site.noteDemand(at('/admin/reports/status'), 150, 0);
			for (let i = 0; i < 60; i++) site.noteDemand(at(`/scan/${i}`), 120, 0);
			return { log: site.demandLog, byPath: site.demandByPath };
		});
		expect(seen.byPath['/admin/reports/status']).toBe(150);
		expect(seen.byPath['/a']).toBe(100);
		expect(seen.byPath['/cold']).toBeUndefined();
		expect(Object.keys(seen.byPath).length).toBeLessThanOrEqual(40);
		expect(seen.log).toHaveLength(60);
	});
});
