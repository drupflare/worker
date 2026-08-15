import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * How much one Durable Object event may write, and how many rollbacks it may take.
 *
 * Built to price a suspect and used to REFUTE it. A module install completes on the edge and the
 * object is then reset with "Internal error in Durable Object storage caused object to be reset",
 * rolling every row back. The install writes ~4,400 rows and ~970 KB, so an aggregate write-set cap
 * was the obvious candidate -- a third limit in the family that already holds 100 bound parameters,
 * a 50-byte LIKE pattern, a 2,199,995-byte record and 100,000 chars of statement text.
 *
 * Measured on a deployed `cfw-*` worker, 2026-08-15, and there is no such cap anywhere near:
 *
 *   | one event writes           | outcome        |
 *   | 128 MB (32,768 x 4 KB)     | ok, 2,616 ms   |
 *   | 1,000,000 rows x 64 B      | ok, 9,828 ms   |
 *   | 32 MB with a booted kernel | ok             |
 *   | 200 speculative rollbacks  | ok, 223 ms     |
 *
 * The install's write set is three orders of magnitude under the first two, a resident interpreter
 * does not move it, and 200 throw-out-of-`transactionSync()` rollbacks pass where an install does
 * 34. So the reset is not volume, not the interpreter, and not the driver's rollback mechanism.
 *
 * These cases keep the instrument honest rather than re-measuring the platform: this lane's storage
 * is not the edge's, so what is asserted is that the probe WRITES what it claims and ROLLS BACK
 * what it claims. A probe that silently wrote nothing would have "refuted" every hypothesis above.
 */

type Payload = Record<string, unknown>;
const REQUEST_TIMEOUT = 300_000;

const call = (site: ServeDo, path: string) =>
	site.fetch(new Request(`https://do.local${path}`)).then((r) => r.json() as Promise<Payload>);

describe('the event write-set probe', () => {
	it(
		'writes every row it reports and reads them back inside the same event',
		async () => {
			const out = await inObject(freshSite(), (site) =>
				call(site, '/__txnprobe?rows=64&size=512')
			);
			expect(out['ok']).toBe(true);
			expect(out['written']).toBe(64 * 512);
			// read back INSIDE the event: a write the engine dropped would show up here as a
			// shortfall rather than as a clean pass
			expect(out['seen']).toBe(64);
		},
		REQUEST_TIMEOUT
	);

	it(
		'discards a speculative rollback without discarding the committed writes',
		async () => {
			const out = await inObject(freshSite(), (site) =>
				call(site, '/__txnprobe?rows=10&size=16&spec=7')
			);
			expect(out['ok']).toBe(true);
			expect(out['rolledBack']).toBe(7);
			// the 7 speculative inserts threw out of transactionSync and must leave nothing; only
			// the 10 plain inserts survive. An equal count would mean the rollback did not roll back
			expect(out['seen']).toBe(10);
		},
		REQUEST_TIMEOUT
	);

	it(
		'refuses an attempt large enough to be a mistake rather than a measurement',
		async () => {
			const res = await inObject(freshSite(), (site) =>
				site.fetch(new Request('https://do.local/__txnprobe?rows=1000000&size=1024'))
			);
			expect(res.status).toBe(400);
		},
		REQUEST_TIMEOUT
	);
});
