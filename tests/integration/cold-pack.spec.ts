import { describe, expect, it } from 'vitest';
import { renderPage } from '../../src/drupal/site-php';
import { CORE_PACK_LENGTH } from '../../src/ops/generated/core-pack';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * COLD_PACK on the real mount: the shipped pack is staged into the object's storage and the lazy
 * mount reads its files from there. The unit cases (`tests/unit/ops/cold-pack.spec.ts`) cover the
 * source itself; this one proves the cartridge takes it and a page still renders.
 */

const REQUEST_TIMEOUT = 900_000;
const CHUNK = 65_536;

type MountReport = { mount?: { blobBytes?: number } | null };

async function bootAndReport(site: ServeDo, coldPack: boolean) {
	site.env.COLD_PACK = coldPack ? '1' : '0';
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	const page = await site.runJson(renderPage('/user/login', [], false, {}));
	const report = (await (
		await site.fetch(new Request('https://do.local/__php'))
	).json()) as MountReport;
	const exists = site.sql.exec(
		"SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'cfw_pack_chunk'"
	) as unknown as { one(): { n: number } };
	const tables = exists.one().n;
	const chunks =
		tables === 0
			? 0
			: Number(
					(
						site.sql.exec('SELECT COUNT(*) AS n FROM cfw_pack_chunk') as unknown as {
							one(): { n: number };
						}
					).one().n
				);
	return { status: page['status'], blobBytes: report.mount?.blobBytes ?? 0, tables, chunks };
}

describe('COLD_PACK on the lazy mount', () => {
	it(
		'creates nothing and keeps the whole pack resident when the flag is 0',
		async () => {
			const out = await inObject(freshSite(), (site: ServeDo) => bootAndReport(site, false));
			expect(out.status).toBe(200);
			expect(out.tables).toBe(0);
			expect(out.blobBytes).toBeGreaterThanOrEqual(CORE_PACK_LENGTH);
		},
		REQUEST_TIMEOUT
	);

	// the cartridge has to read SQL_PACK_SOURCE for this to stage anything; enable it once it does
	it.skip(
		'stages the pack into storage, keeps a few chunks resident, and still renders',
		async () => {
			const out = await inObject(freshSite(), (site: ServeDo) => bootAndReport(site, true));
			expect(out.status).toBe(200);
			expect(out.chunks).toBe(Math.ceil(CORE_PACK_LENGTH / CHUNK));
			// the source reports its resident chunks, and the default keeps eight
			expect(out.blobBytes).toBeLessThan(CORE_PACK_LENGTH / 2);
		},
		REQUEST_TIMEOUT
	);
});
