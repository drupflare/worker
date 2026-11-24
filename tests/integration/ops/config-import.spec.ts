import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../../helpers/serve-do';

const REQUEST_TIMEOUT = 600_000;

type Page = {
	ok?: boolean;
	nextOffset?: number | null;
	config?: Record<string, Record<string, unknown>>;
};

async function exported(site: ServeDo): Promise<Record<string, Record<string, unknown>>> {
	const config: Record<string, Record<string, unknown>> = {};
	for (let offset: number | null = 0; offset !== null;) {
		const res = await site.fetch(
			new Request(`https://do.local/__ops?op=cex&offset=${offset}&limit=25`)
		);
		const page = (await res.json()) as Page;
		Object.assign(config, page.config ?? {});
		offset = page.nextOffset ?? null;
	}
	return config;
}

describe('a config import on a real kernel', () => {
	it(
		'saves a config entity through the importer, a beat at a time',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const config = await exported(site);
				// every labelled entity, so the import runs through views, blocks, fields and roles
				const names = Object.keys(config).filter(
					(n) => typeof config[n]?.['label'] === 'string'
				);
				for (const n of names) config[n]!['label'] = `${config[n]!['label']} imported`;
				const beats: Record<string, unknown>[] = [];
				let res = await site.fetch(
					new Request('https://do.local/__ops?op=cim', {
						method: 'POST',
						body: JSON.stringify(config)
					})
				);
				beats.push((await res.json()) as Record<string, unknown>);
				for (
					let i = 0;
					i < 20 && beats.at(-1)!['ok'] !== false && beats.at(-1)!['done'] !== true;
					i++
				) {
					res = await site.fetch(new Request('https://do.local/__ops?op=cim'));
					beats.push((await res.json()) as Record<string, unknown>);
				}
				const after = await exported(site);
				const landed = names.filter((n) =>
					String(after[n]?.['label']).endsWith(' imported')
				);
				return { beats, names: names.length, landed: landed.length };
			});
			expect(out.beats.at(-1)).toMatchObject({ ok: true, done: true, phase: 'done' });
			expect(out.names).toBeGreaterThan(10);
			expect(out.landed).toBe(out.names);
		},
		REQUEST_TIMEOUT
	);
});
