import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../src/drupal/site-php';
import { ADVISORY_STATE_KEY } from '../../src/ops/advisories';
import { writeCursor, type StoredCursor } from '../../src/ops/cron';
import { DEFAULT_CRON_BUDGET, driveCron } from '../../src/ops/cron-drive';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * That something READS what the update module found.
 *
 * Detection was the half that did not exist. The update module fetches release data and computes a
 * status per project, `hook_requirements()` renders it on the status report, and nothing else ever
 * looked -- so a known-insecure module sat on a site until a human opened that page for that site.
 *
 * A unit test of the reader passes against a cron chain that never writes the row, which is the
 * original defect exactly. These drive the real hook and then read the real route.
 */

const TIMEOUT = 900_000;

const deps = (site: ServeDo) => ({
	sql: site.sql,
	runJson: (code: string) => site.runJson(code)
});

async function sweep(site: ServeDo, passes: number): Promise<string[]> {
	let cursor: unknown = undefined;
	const ran: string[] = [];
	for (let i = 0; i < passes; i++) {
		const driven = await driveCron(cursor, deps(site), {}, DEFAULT_CRON_BUDGET);
		cursor = writeCursor(driven.cursor as StoredCursor);
		ran.push(...driven.ran);
	}
	return ran;
}

/** the row the module writes and the host reads, straight out of the table */
function advisoryRow(site: ServeDo): string | null {
	const row = site.sql
		.exec(
			`SELECT value FROM key_value WHERE collection = 'state' AND name = ?`,
			ADVISORY_STATE_KEY
		)
		.toArray()[0] as { value: unknown } | undefined;
	if (row === undefined) return null;
	const value = row.value;
	return value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value);
}

describe('the advisory sweep writes a record cron actually produces', () => {
	it(
		'records a verdict on a real cron chain, rather than leaving the row absent',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const ran = await sweep(site, 8);
				return { ran, row: advisoryRow(site), verdict: site.advisoryVerdict() };
			});

			// the unit has to be among what ran, or the rest of this proves nothing
			expect(out.ran.join(','), 'the advisory unit never ran').toContain('advisories');
			expect(out.row, 'no advisory record was written by any firing').not.toBeNull();
			// a fresh site's update module has fetched nothing, so `unknown` is the CORRECT answer
			// here. What this pins is that a record exists at all: the defect was that nothing wrote
			// one, and a site with no record is indistinguishable from a site with no advisories
			expect(out.verdict.state).toBe('unknown');
			expect(out.verdict.detail).toContain('no project data');
			expect(out.verdict.at).toBeGreaterThan(0);
		},
		TIMEOUT
	);

	it(
		'answers the health route with the same verdict, so a fleet can ask',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				await site.runJson(
					drupalOp(`
\\Drupal::keyValue('update')->set('update_project_data', [
  'ctools' => ['status' => 1, 'existing_version' => '4.0.4', 'recommended' => '4.1.0'],
]);
$out['seeded'] = 1;`)
				);
				await sweep(site, 8);
				const res = await site.fetch(new Request('https://do.local/__health'));
				return {
					status: res.status,
					body: (await res.json()) as {
						advisories?: { state: string; at: number; fresh: boolean; detail: string };
					}
				};
			});

			expect(out.status).toBe(200);
			expect(out.body.advisories, '/__health does not report advisories').toBeDefined();
			expect(out.body.advisories?.state).toBe('insecure');
			expect(out.body.advisories?.detail).toContain('ctools');
			// a verdict carries its age, so a caller can tell a fresh all-clear from an old one
			expect(out.body.advisories?.fresh).toBe(true);
		},
		TIMEOUT
	);

	it(
		'reports unknown on a site whose sweep has never run, rather than current',
		async () => {
			// the asymmetry the whole feature turns on: an unchecked site must not read as clean
			const verdict = await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				return site.advisoryVerdict();
			});
			expect(verdict.state).toBe('unknown');
			expect(verdict.fresh).toBe(false);
		},
		TIMEOUT
	);

	it(
		'surfaces an advisory the update module computed, end to end',
		async () => {
			// project data as `update_calculate_project_data()` leaves it, with a status of
			// UPDATE_NOT_SECURE. Written through PHP so the serialization is Drupal's own rather than
			// a shape this test invented
			const out = await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				await site.runJson(
					drupalOp(`
\\Drupal::keyValue('update')->set('update_project_data', [
  'ctools' => ['status' => 1, 'existing_version' => '4.0.4', 'recommended' => '4.1.0'],
  'token' => ['status' => 4, 'existing_version' => '1.13', 'recommended' => '1.15'],
  'node' => ['status' => 5, 'existing_version' => '11.0.0', 'recommended' => '11.0.0'],
]);
$out['seeded'] = 1;`)
				);
				await sweep(site, 8);
				return site.advisoryVerdict();
			});

			expect(out.state).toBe('insecure');
			expect(out.insecure).toBe(1);
			expect(out.detail).toContain('ctools');
			// behind-but-not-insecure is counted separately and does not become the verdict
			expect(out.stale).toBe(1);
		},
		TIMEOUT
	);
});
