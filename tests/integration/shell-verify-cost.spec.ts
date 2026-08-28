import { describe, expect, it } from 'vitest';
import {
	createUser,
	harvestShell,
	renderPage,
	type RenderRequest
} from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What shell assembly and its per-visitor proof cost on the meter that binds.
 *
 * Rows written is the tighter of the two free-plan ceilings, so the whole case for P92 is an
 * arithmetic one and it is pinned here rather than asserted in prose: an assembly writes NOTHING,
 * a render writes a handful, and the verification harvest plus the render that repays its emptied
 * bin is the toll a visitor pays once. If assembly ever stops being free the justification changes,
 * and nothing else in the suite would notice.
 *
 * BANDS RATHER THAN PINS, except for the zero. A row count is deterministic for a fixed code path,
 * but it moves with Drupal's own cache behaviour and a pin turns an unrelated upstream change into
 * a failure here that reads as a regression in this feature.
 */

const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Shell-Pass-7714';
const ORIGIN = 'https://do.local';

type Payload = Record<string, unknown>;

const form = (body: string): RenderRequest => ({
	method: 'POST',
	body,
	contentType: 'application/x-www-form-urlencoded',
	cookie: ''
});

function jarOf(result: Payload): string {
	const lines = Array.isArray(result['setCookie']) ? (result['setCookie'] as string[]) : [];
	const session = lines.find((line) => /^S?SESS/.test(line));
	return session ? (session.split(';')[0] ?? '') : '';
}

describe('P92: the economics of proving a shell per visitor', () => {
	it(
		'prices assembly, render and verification in rows written',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						body: JSON.stringify({ adminPass: PASS, siteName: 'Shell' }),
						headers: { 'content-type': 'application/json' }
					})
				);
				for (const name of ['alice', 'bob', 'carol']) {
					await site.runJson(createUser({ name, pass: PASS }));
				}
				const login = async (name: string) =>
					jarOf(
						(await site.runJson(
							renderPage('/user/login', [], false, {
								...form(
									`name=${name}&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`
								),
								origin: ORIGIN
							})
						)) as Payload
					);
				const jars = {
					alice: await login('alice'),
					bob: await login('bob'),
					carol: await login('carol')
				};
				const stored = await site.harvestShellFor('/', [jars.alice, jars.bob], ORIGIN);

				const meter = async (run: () => Promise<unknown>) => {
					await site.fetch(new Request('https://do.local/__writes?op=off'));
					await site.fetch(new Request('https://do.local/__writes?op=on'));
					const value = await run();
					const t = (await (
						await site.fetch(new Request('https://do.local/__writes'))
					).json()) as { rowsWritten: number };
					return { rows: t.rowsWritten, value };
				};

				const render = () =>
					site.runJson(
						renderPage('/', ['dynamic_page_cache'], false, {
							cookie: jars.carol,
							origin: ORIGIN
						})
					);
				const assembly = () => site.assembleFor('/', jars.carol, ORIGIN);
				const harvest = () =>
					site.runJson(harvestShell('/', { cookie: jars.carol, origin: ORIGIN }));

				// carol's proof is bought first, so the assembly arm below is the CHEAP path rather
				// than a verification wearing its name -- measuring that would read 34 and the whole
				// table would say assembly is the expensive one
				await assembly();
				await render();

				const renderCost = await meter(render);
				const assemblyCost = await meter(assembly);
				const assemblyAgain = await meter(assembly);
				// the toll, measured as the two halves a visitor actually causes
				const verifyCost = await meter(harvest);
				const repayCost = await meter(render);

				// read off the REAL table rather than the DDL string in the source, because the
				// clause is what the platform stored and a typo would silently double the charge
				const proofDdl = String(
					site.sql
						.exec("SELECT sql FROM sqlite_master WHERE name = 'cfw_shell_verified'")
						.toArray()[0]?.['sql'] ?? ''
				);

				return {
					stored,
					proofDdl,
					render: renderCost.rows,
					assembly: assemblyCost.rows,
					assemblyAgain: assemblyAgain.rows,
					assemblyOk: assemblyCost.value !== null,
					verdict: (assemblyCost.value as { verified?: string } | null)?.verified ?? null,
					verify: verifyCost.rows,
					repay: repayCost.rows
				};
			});

			const toll = seen.verify + seen.repay - seen.render;
			const breakEven = Math.ceil(toll / Math.max(1, seen.render - seen.assembly));
			console.log(
				`[p92-econ] render=${seen.render} assembly=${seen.assembly} ` +
					`verify=${seen.verify} repay=${seen.repay} | ` +
					`toll=${toll} rows, break-even=${breakEven} requests`
			);

			expect(seen.stored.stored).toBe(true);
			expect(seen.assemblyOk).toBe(true);
			// a TEXT primary key in a rowid table gets its own unique index and charges 2 rows an
			// insert; the proof table is written once per visitor and path and must charge 1
			expect(seen.proofDdl, 'the platform dropped the WITHOUT ROWID clause').toContain(
				'WITHOUT ROWID'
			);
			// the arm really is the assembly path and not a verification mislabelled
			expect(seen.verdict).toBe('cached');

			// THE PAYOFF: an assembly touches no cache bin, so it writes nothing at all
			expect(seen.assembly).toBe(0);
			expect(seen.assemblyAgain).toBe(0);
			// and the render it stands in for does write, or there would be nothing to save
			expect(seen.render).toBeGreaterThan(0);
			// the toll is real and bounded; 40 rows and 4 requests on this arm, 52 and 13 on a
			// warmer one, which is why the band is wide and the assertion is not a pin
			expect(toll).toBeGreaterThan(seen.render);
			expect(breakEven).toBeLessThanOrEqual(40);
		},
		REQUEST_TIMEOUT
	);
});
