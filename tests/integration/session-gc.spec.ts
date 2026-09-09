import { describe, expect, it } from 'vitest';
import { emptyTally } from '../../src/db/write-tally';
import { renderPage } from '../../src/drupal/site-php';
import { authoritativeWrites, expiryGcTable } from '../../src/ops/replica';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * PHP's probabilistic session GC, which is what the `replica-invariant` intermittent was.
 *
 * `confines the status report to regenerable tables` failed twice across sessions with
 * `{ table: 'sessions', statements: 1, rows: 0 }`, passed alone, and read as suite contention. It is
 * not contention. `session.gc_probability` is 1 and `gc_divisor` is 100, so PHP runs
 * `SessionHandler::gc()` on ~1% of `session_start()` calls; that is one
 * `DELETE FROM sessions WHERE timestamp < ?`, matching nothing on a site whose only session is
 * minutes old. A full gate gives the coin far more flips than a solo run, which is the whole of
 * "passes alone, fails in the suite".
 *
 * So the reading was real, the table was right, and the conclusion "this is flake" was the error.
 *
 * What absorbs it is a classification rather than a suppression. Turning Drupal's own GC off would
 * be the host substituting its policy for the module's, and the host already runs the IDENTICAL
 * delete from `EXPIRED_ROW_RULES` -- so a replica performing it converges on the same set the
 * primary does and nothing is lost by discarding the replica's copy. Writing a session row is still
 * authoritative; sweeping expired ones is not. Same table, two effects, which is the `key_value`
 * lesson pointed somewhere new.
 *
 * The classification itself is driven in `tests/unit/ops/replica.spec.ts`, which needs no
 * interpreter. What is here is the half only the real binary can answer: that the sweep is armed and
 * that it emits exactly the statement the intermittent reported.
 */

const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Gc-Pass-9931';
const ORIGIN = 'https://do.local';

type Interp = ServeDo & { run: (code: string) => Promise<string> };
type Payload = Record<string, unknown>;

function jarOf(result: Payload): string {
	const lines = Array.isArray(result['setCookie']) ? (result['setCookie'] as string[]) : [];
	const session = lines.find((line) => /^S?SESS/.test(line));
	return session ? (session.split(';')[0] ?? '') : '';
}

async function adminSession(site: ServeDo): Promise<string> {
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	await site.fetch(
		new Request('https://do.local/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ adminPass: PASS, siteName: 'Gc' }),
			headers: { 'content-type': 'application/json' }
		})
	);
	return jarOf(
		(await site.runJson(
			renderPage('/user/login', [], false, {
				method: 'POST',
				body: `name=admin&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`,
				contentType: 'application/x-www-form-urlencoded',
				cookie: '',
				origin: ORIGIN
			})
		)) as Payload
	);
}

const READ_INI = `<?php echo json_encode([
  'probability' => ini_get('session.gc_probability'),
  'divisor' => ini_get('session.gc_divisor'),
  'maxlifetime' => ini_get('session.gc_maxlifetime'),
]);`;

const FORCE_GC = `<?php
$handler = \\Drupal::service('session_handler.storage');
echo json_encode([
  'class' => get_class($handler),
  'deleted' => $handler->gc((int) ini_get('session.gc_maxlifetime')),
]);`;

function parse(text: string): Record<string, unknown> {
	const at = text.indexOf('{');
	if (at < 0) throw new Error(`no JSON printed; PHP said: ${text.slice(0, 600)}`);
	return JSON.parse(text.slice(at)) as Record<string, unknown>;
}

describe('the probabilistic session sweep', () => {
	it(
		'is armed on every render and writes exactly the statement the intermittent reported',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				const cookie = await adminSession(site);
				await site.runJson(
					renderPage('/admin/content', [], false, {
						method: 'GET',
						body: '',
						contentType: '',
						cookie,
						origin: ORIGIN
					})
				);
				const ini = parse(await (site as Interp).run(READ_INI));
				site.writeTally = emptyTally();
				const forced = parse(await (site as Interp).run(FORCE_GC));
				const tally = site.writeTally;
				site.writeTally = undefined;
				return { ini, forced, tally: tally ?? emptyTally() };
			});
			console.log(
				`[session-gc] ini=${JSON.stringify(seen.ini)} forced=${JSON.stringify(seen.forced)} shapes=${JSON.stringify(Object.keys(seen.tally.shapes ?? {}))}`
			);

			// THE TRIGGER, asserted rather than assumed. If a later change turns the sweep off this
			// fails and says the mechanism moved, instead of the spec below passing for a new reason
			expect(seen.ini['probability']).toBe('1');
			expect(seen.ini['divisor']).toBe('100');
			expect(seen.forced['class']).toBe('Drupal\\Core\\Session\\SessionHandler');

			// the signature, matched against what `replica-invariant.spec.ts` reported: one statement,
			// no rows, because the only session on this site is minutes old
			expect(seen.tally.statementsByTable['sessions']).toBe(1);
			expect(seen.tally.byTable['sessions'] ?? 0).toBe(0);
			const sweep = Object.keys(seen.tally.shapes ?? {}).find(
				(shape) => expiryGcTable(shape) === 'sessions'
			);
			expect(sweep, 'no shape in the tally parses as a session sweep').toBeTruthy();

			// and the classification absorbs it, which is what closes the intermittent
			expect(authoritativeWrites(seen.tally)).toEqual([]);
		},
		REQUEST_TIMEOUT
	);
});
