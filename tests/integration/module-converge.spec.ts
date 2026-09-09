import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../src/drupal/site-php';
import { writeCursor, type StoredCursor } from '../../src/ops/cron';
import { DEFAULT_CRON_BUDGET, driveCron } from '../../src/ops/cron-drive';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The END STATE of a module install, not the mechanism that produces it.
 *
 * Two closed items were closed on the wrong observable. `cron-wire.spec.ts` asserts that cron units
 * RAN; `contrib-verify.spec.ts` asserts that ONE module reaches its observable on a site of its own.
 * Neither says the site an operator is left with is healthy, and both pass against a site whose
 * status report cannot be built.
 *
 * **`system.cron_last` is the last unit in the chain, and that is what separates the two.** The ring
 * is thirteen units against `DEFAULT_CRON_BUDGET.maxUnits` of 6 and one PHP unit a firing, so two
 * firings run the garbage collection and a couple of hooks and never reach the stamp Drupal's status
 * report reads. Measured here: after two firings the chain still reports `more`, and the report shows
 * the timestamp firstrun wrote. Convergence is the chain draining, which takes about ten firings --
 * two and a half hours at the 15-minute interval.
 *
 * **BOTH CASES RUN ON A SITE THAT HAS A HEAP IMAGE**, because that is the state a real site is in and
 * a restored kernel is a different kernel: it brings back the included-files table and the container
 * without every global beside them. A flow that only ever ran on a cold boot has not been run on the
 * shipping configuration.
 *
 * The report is read through `SystemManager::listRequirements()`, which is what `/admin/reports/status`
 * renders, and **with a request on the stack**: `FileRequirements::runtime()` calls
 * `\Drupal::request()->server->get()`, so a fragment that pushes none reports
 * `Call to a member function get() on null` and the whole page is a 500 rather than a bad row. That
 * is an instrument requirement rather than a defect -- a real request always has one -- and it is
 * written down because it looked exactly like the failure this file is for.
 */

const TIMEOUT = 900_000;

type Payload = Record<string, unknown>;

/** severities `listRequirements()` returns; `RequirementSeverity` is an enum in Drupal 11 */
const INFO = -1;
const OK = 0;
const WARNING = 1;
const ERROR = 2;

/**
 * A booted kernel at a request boundary, which is where the status report is actually built.
 *
 * The resetter call is not harness convenience. `cfw_serve()` runs it before `$kernel->handle()`, so
 * a fragment that skips it reads state and cache-tag memos the previous request left behind -- and
 * `State` is a `CacheCollector`, so the value the cron chain wrote into `key_value` is invisible
 * until something clears the collector. `drupalOp()` is not a serve, so the reset is made explicit.
 */
const PREAMBLE = String.raw`
\Drupal::moduleHandler()->loadAll();
\Drupal::service('drupflare.request_resetter')->reset();
$req = \Symfony\Component\HttpFoundation\Request::create('/admin/reports/status', 'GET');
$req->server->set('SERVER_SOFTWARE', 'Cloudflare Workers');
$req->server->set('REQUEST_TIME', time());
\Drupal::service('request_stack')->push($req);
`;

/**
 * Backdates the run cron records, which is what makes the report's own row the observable.
 *
 * Core's threshold is 2 days for a warning and 2 weeks for an error, so 20 days puts `cron` at
 * Error and the convergence claim becomes "that row is gone", not "a timestamp moved". A timestamp
 * comparison cannot work in this lane at all: `Date.now()` does not advance across a synchronous
 * `php._run()`, so firstrun's stamp and the chain's landed in the same second and read equal.
 *
 * Through `State::set()` rather than SQL, because a state write has a cached copy and an edit that
 * leaves it behind is inert -- the same shape as the `cache_config` row that shadowed
 * `page.max_age`.
 */
const STALE_CRON = drupalOp(
	PREAMBLE +
		String.raw`
$stale = time() - (20 * 86400);
\Drupal::state()->set('system.cron_last', $stale);
$out['staleAt'] = $stale;
$out['readBack'] = (int) \Drupal::state()->get('system.cron_last', 0);
$out['ok'] = $out['readBack'] === $stale;`
);

/**
 * The status report, as the page an operator opens builds it.
 *
 * Severities are collapsed to ints so a spec can compare them; the VALUE column comes with them so a
 * failure names what the row said rather than only how bad it was.
 */
const REPORT = drupalOp(
	PREAMBLE +
		String.raw`
$rows = [];
foreach (\Drupal::service('system.manager')->listRequirements() as $key => $row) {
  $severity = $row['severity'] ?? 0;
  if (is_object($severity)) { $severity = (int) ($severity->value ?? 0); }
  // a row's value is a TranslatableMarkup rather than a string, so is_scalar() drops every one of
  // them and a failure message then names an empty row
  $value = $row['value'] ?? null;
  $printable = is_scalar($value) || (is_object($value) && method_exists($value, '__toString'));
  $rows[$key] = [
    'severity' => (int) $severity,
    'value' => $printable ? (string) $value : '',
  ];
}
$out['report'] = $rows;
$out['modules'] = array_keys(\Drupal::moduleHandler()->getModuleList());
$out['cronLast'] = (int) \Drupal::state()->get('system.cron_last', 0);
$out['ok'] = true;`
);

/** the three modules' own services, asked of the container the installs rebuilt */
const THREE_SERVICES: Readonly<Record<string, readonly string[]>> = {
	token: ['token.entity_mapper', 'token.tree_builder'],
	ctools: ['ctools.wizard.factory', 'plugin.manager.ctools.relationship'],
	pathauto: ['pathauto.generator', 'pathauto.alias_cleaner']
};

const SERVICES = drupalOp(
	PREAMBLE +
		String.raw`
$want = json_decode(${JSON.stringify(JSON.stringify(THREE_SERVICES))}, true);
$container = \Drupal::getContainer();
$found = [];
foreach ($want as $module => $ids) {
  foreach ($ids as $id) { $found[$id] = $container->has($id); }
}
$out['services'] = $found;
// the control: a core service the probe must see either way, so an all-false reading reads as a
// broken probe rather than as three modules that did nothing
$out['control'] = $container->has('entity_type.manager');
$out['ok'] = true;`
);

const deps = (site: ServeDo) => ({ sql: site.sql, runJson: (code: string) => site.runJson(code) });

type Drive = { firings: number; units: number; ran: string[]; more: boolean; cursor: unknown };

/** several firings, the way the alarm chain delivers them, stopping when asked or when drained */
async function drive(site: ServeDo, cursor: unknown, firings: number): Promise<Drive> {
	const ran: string[] = [];
	let units = 0;
	let more = true;
	let done = 0;
	for (let i = 0; i < firings; i++) {
		const driven = await driveCron(cursor, deps(site), {}, DEFAULT_CRON_BUDGET);
		cursor = writeCursor(driven.cursor as StoredCursor);
		ran.push(...driven.ran);
		units += driven.units;
		more = driven.more;
		done++;
		if (!more) break;
	}
	return { firings: done, units, ran, more, cursor };
}

/**
 * A provisioned site holding a heap image, with the interpreter dropped so the next boot restores it.
 *
 * `fresh=1` is required by the snapshot route and it re-boots out of the PACK afterwards, so the
 * drop below is what makes the following work restore rather than continue.
 */
async function imagedSite(name: string) {
	const stub = freshSite();
	const image = await inObject(stub, async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		const first = await site.fetch(
			new Request('https://do.local/__firstrun', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ adminPass: `cfw-${name}-9912-pass`, siteName: name })
			})
		);
		if (first.status !== 200) throw new Error(`firstrun ${first.status}`);
		const snapshot = await site.fetch(
			new Request('https://do.local/__heap?op=snapshot&fresh=1', {
				headers: { 'x-cfw-owner': 'test' }
			})
		);
		if (snapshot.status !== 200) throw new Error(`snapshot ${snapshot.status}`);
		const status = (await (
			await site.fetch(
				new Request('https://do.local/__heap', { headers: { 'x-cfw-owner': 'test' } })
			)
		).json()) as { latest: { id?: number } | null };
		(site as unknown as { php: unknown }).php = null;
		return status.latest;
	});
	// the precondition, asserted rather than assumed: a spec that silently ran without an image
	// would be the cold-boot case again under a name that claims otherwise
	expect(image, 'no heap image was taken, so this is not the state under test').not.toBeNull();
	return stub;
}

type Report = {
	report: Record<string, { severity: number; value: string }>;
	modules: string[];
	cronLast: number;
};

const readReport = async (site: ServeDo): Promise<Report> => {
	const out = (await site.runJson(REPORT)) as Payload;
	expect(
		out.ok,
		`the status report could not be built: ${JSON.stringify(out).slice(0, 500)}`
	).toBe(true);
	return out as unknown as Report;
};

const at = (r: Report, severity: number) =>
	Object.entries(r.report)
		.filter(([, row]) => row.severity === severity)
		.map(([key]) => key)
		.sort();

describe('a module install converges, on a site with a heap image', () => {
	it(
		'installs a module, drains the cron chain, and leaves a report that reads healthy',
		async () => {
			const stub = await imagedSite('Conv1');
			const out = await inObject(stub, async (site: ServeDo) => {
				// A REAL SERVE FIRST, and it is what makes the state cache load-bearing. `state`
				// carries `needs_destruction`, so `cfw_serve()`'s destruct pass persists the whole
				// collector into `cache_bootstrap` under the cid `state`; a site that has never
				// rendered has no such row and the boundary reset alone would be enough.
				//
				// Then the interpreter goes, so both readings below are taken on one that has not
				// served. `php_session_samesite` is OK for the rest of an incarnation that ran a
				// serve and warns on one that has not, so comparing across the drop the installs
				// perform would report that flip as a row the install added
				await site.fillOne('/', ['page', 'dynamic_page_cache']);
				(site as unknown as { php: unknown }).php = null;
				const stale = (await site.runJson(STALE_CRON)) as Payload;
				const before = await readReport(site);
				const enabled = (await (
					await site.fetch(new Request('https://do.local/__enable?module=token'))
				).json()) as Payload;

				// TWO FIRINGS, which is what "run cron twice" means and is what the closed item
				// asserted. Kept as its own reading because it is the difference between the
				// mechanism and the end state
				const twice = await drive(site, undefined, 2);
				const afterTwice = await readReport(site);

				// then the rest of the chain, from where the two firings left it
				const rest = await drive(site, twice.cursor, 40);
				const afterAll = await readReport(site);
				return { stale, before, enabled, twice, afterTwice, rest, afterAll };
			});

			expect(
				out.stale.ok,
				`the stale stamp did not read back: ${JSON.stringify(out.stale)}`
			).toBe(true);
			expect(out.enabled.ok, JSON.stringify(out.enabled).slice(0, 400)).toBe(true);
			expect(out.enabled.nowEnabled).toBe(true);

			const cronRow = (r: Report) => r.report['cron'];
			console.log(
				`[converge] ${JSON.stringify({
					cron: {
						before: cronRow(out.before),
						afterTwoFirings: cronRow(out.afterTwice),
						afterDrain: cronRow(out.afterAll)
					},
					firings: { twice: out.twice.firings, toDrain: out.rest.firings },
					units: { twice: out.twice.units, rest: out.rest.units },
					ran: { twice: out.twice.ran, rest: out.rest.ran },
					errors: {
						before: at(out.before, ERROR),
						afterTwoFirings: at(out.afterTwice, ERROR),
						afterDrain: at(out.afterAll, ERROR)
					},
					warnings: at(out.afterAll, WARNING)
				})}`
			);

			// the precondition: a site whose cron has not run for 20 days reads ERROR, so there is
			// something for the flow to converge FROM
			expect(cronRow(out.before)?.severity, 'the report did not start unhealthy').toBe(ERROR);

			// THE DISTINCTION THIS FILE EXISTS FOR. Two firings ran real work and the chain still
			// reported more to do, so the row the operator reads had not changed. Conditional on
			// `more` rather than pinned to a firing count: the claim is that an undrained chain has
			// not converged, and that stays true if the ring gets shorter
			expect(out.twice.units, 'two firings ran no cron unit at all').toBeGreaterThan(0);
			if (out.twice.more) {
				expect(
					cronRow(out.afterTwice)?.severity,
					'the chain had more to do and the report already read healthy'
				).toBe(ERROR);
			}

			// AND THE END STATE ARRIVES. `cron_last` is the last unit in the ring, so a healthy row
			// here is the whole chain having drained rather than a hook having fired
			expect(out.rest.more, 'the cron chain never drained').toBe(false);
			expect(
				cronRow(out.afterAll)?.severity,
				`the chain drained and the report still says ${cronRow(out.afterAll)?.value}`
			).toBe(INFO);

			// the report reads healthy: no row an operator has to act on, and no row that was fine
			// before the install has become one
			expect(at(out.afterAll, ERROR), 'the status report carries an error row').toEqual([]);
			const grew = at(out.afterAll, WARNING).filter(
				(key) => !at(out.before, WARNING).includes(key)
			);
			expect(grew, 'the install added a warning row to the status report').toEqual([]);
			// and the module is on the site rather than merely installed once
			expect(out.afterAll.modules).toContain('token');
		},
		TIMEOUT
	);

	it(
		'installs three contrib modules on one site and all three report',
		async () => {
			const stub = await imagedSite('Conv3');
			const out = await inObject(stub, async (site: ServeDo) => {
				const stale = (await site.runJson(STALE_CRON)) as Payload;
				expect(stale.ok, JSON.stringify(stale)).toBe(true);
				const before = await readReport(site);
				const installs: Payload[] = [];
				for (const module of Object.keys(THREE_SERVICES)) {
					installs.push(
						(await (
							await site.fetch(
								new Request(`https://do.local/__enable?module=${module}`)
							)
						).json()) as Payload
					);
				}
				const drained = await drive(site, undefined, 40);
				const after = await readReport(site);
				const services = (await site.runJson(SERVICES)) as Payload;
				return { before, installs, drained, after, services };
			});

			console.log(
				`[converge] ${JSON.stringify({
					installs: out.installs.map((i) => [i.module, i.ok, i.rowsWritten]),
					firingsToDrain: out.drained.firings,
					errors: at(out.after, ERROR),
					warnings: at(out.after, WARNING),
					services: out.services.services
				})}`
			);

			// each install succeeded, which is the mechanism half and is not the claim
			for (const install of out.installs) {
				expect(install.ok, JSON.stringify(install).slice(0, 400)).toBe(true);
			}

			// THE CLAIM: all three are on the SAME site afterwards, each answering for itself
			expect(out.services.control, 'CONTROL: the probe cannot see the container').toBe(true);
			const found = (out.services.services ?? {}) as Record<string, unknown>;
			for (const [module, ids] of Object.entries(THREE_SERVICES)) {
				expect(out.after.modules, `${module} is not in core.extension`).toContain(module);
				for (const id of ids) {
					expect(found[id], `${module}: ${id} is not in the container`).toBe(true);
				}
			}

			// and the site an operator is left with is one they do not have to act on
			expect(out.before.report['cron']?.severity, 'the report did not start unhealthy').toBe(
				ERROR
			);
			expect(out.drained.more, 'the cron chain never drained').toBe(false);
			expect(out.after.report['cron']?.severity).toBe(INFO);
			expect(at(out.after, ERROR), 'three installs left an error row').toEqual([]);
			const grew = at(out.after, WARNING).filter(
				(key) => !at(out.before, WARNING).includes(key)
			);
			expect(grew, 'three installs added a warning row').toEqual([]);
			// the report is BUILT rather than merely error-free, which is the failure a severity
			// check on an empty list cannot see
			expect(Object.keys(out.after.report).length).toBeGreaterThan(20);
			expect(at(out.after, OK).length).toBeGreaterThan(10);
		},
		TIMEOUT
	);
});
