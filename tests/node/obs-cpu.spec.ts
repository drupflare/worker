import { describe, expect, it } from 'vitest';
import { epochMillis, flattenCalculations, flattenEvents } from '../../scripts/measure/obs-cpu';

/**
 * The timeframe encoding for the one instrument RULE 0 accepts.
 *
 * `scripts/measure/obs-cpu.ts` reads `$workers.cpuTimeMs` out of Workers Observability, and it is
 * the only tool here that produces a CPU figure RULE 0 permits anyone to quote. It sent the
 * `--from` / `--to` values through as ISO-8601 strings; the endpoint wants epoch MILLISECONDS and
 * answers `ZodError: expected number`.
 *
 * That failure was invisible twice over. The rejection surfaced as
 * `observability query failed: undefined`, because the payload carries its validation errors under
 * `_c` rather than `errors` -- so the tool reported nothing useful about why it returned nothing.
 * Found 2026-08-20 while pricing the per-request theme reset, which had to work around it.
 */

describe('the observability timeframe, which the API takes as epoch millis', () => {
	it('converts an ISO-8601 Z string, which is what the usage line documents', () => {
		expect(epochMillis('2026-08-15T01:00:00Z', '--from')).toBe(1786755600000);
	});

	it('passes epoch millis through untouched, so a caller can skip the conversion', () => {
		expect(epochMillis('1786755600000', '--to')).toBe(1786755600000);
		// and not via Date.parse, which would read a bare number as a year
		expect(epochMillis('1786755600000', '--to')).not.toBe(Date.parse('1786755600000'));
	});

	it('tolerates surrounding whitespace, since these arrive from a shell', () => {
		expect(epochMillis('  2026-08-15T01:00:00Z  ', '--from')).toBe(1786755600000);
	});

	it('refuses anything else by name, rather than sending NaN to the endpoint', () => {
		// NaN would serialise as null and come back as the same opaque ZodError this fixed
		expect(() => epochMillis('yesterday', '--from')).toThrow('--from');
		expect(() => epochMillis('', '--to')).toThrow('--to');
	});
});

/**
 * A ZERO-COST INVOCATION IS THE NORMAL CASE HERE, and the calculations view cannot see one.
 *
 * Measured 2026-08-20 against a deployed `cfw-bench`: 360 tagged invocations were driven, 347 cost
 * `cpuTimeMs: 0`, and a `max` calculation grouped by tag returned **13 groups** -- only the 1 ms and
 * 2 ms ones. The query succeeded and reported no error, so the tool would have printed a median of
 * 2 ms built from 3.6% of the data when the true median is 0.
 *
 * That is the same shape as every other moved verdict in this project: the instrument, not the
 * system. A serving path answered by JavaScript out of SQLite is SUPPOSED to be under the meter's
 * 1 ms resolution, so an instrument blind to zero inverts the finding it exists to produce.
 */
describe('reading invocations rather than grouped aggregates', () => {
	const event = (tag: string | undefined, cpuTimeMs: unknown, wallTimeMs = 20) => ({
		$workers: {
			cpuTimeMs,
			wallTimeMs,
			outcome: 'ok',
			event: { request: { search: tag === undefined ? {} : { tag } } }
		}
	});
	const body = (events: unknown[]) => ({ result: { events: { events } } });

	it('keeps a zero-cost invocation, which is the one the calculations view drops', () => {
		const rows = flattenEvents(body([event('a', 0), event('b', 2)]));
		expect(rows.map((r) => r.cpuMs)).toEqual([0, 2]);
	});

	it('proves the two views disagree on exactly the zeros', () => {
		const events = [event('a', 0), event('b', 0), event('c', 2)];
		expect(flattenEvents(body(events))).toHaveLength(3);
		// what the API returns for the same data: the zero groups are simply absent
		const calc = flattenCalculations(
			{
				result: {
					calculations: [
						{ alias: 'cpuMs', aggregates: [{ groups: [{ value: 'c' }], value: 2 }] }
					]
				}
			},
			'cpuMs',
			'$workers.event.request.search.tag'
		);
		expect(calc).toHaveLength(1);
		expect(calc[0]!.value, 'and the survivor is the tail, not the body').toBe(2);
	});

	/**
	 * ABSENT IS NOT ZERO, which is what the fix turns on.
	 *
	 * A dropped or truncated event carries no `cpuTimeMs` field at all. Coercing that to 0 would
	 * reintroduce the same lie from the other direction.
	 */
	it('drops an event with no cpuTimeMs rather than reading it as free', () => {
		const rows = flattenEvents(body([event('a', undefined), event('b', null), event('c', 1)]));
		expect(rows.map((r) => r.tag)).toEqual(['c']);
	});

	it('keeps an untagged invocation but marks it, so alarms are countable', () => {
		const rows = flattenEvents(body([event(undefined, 5), event('a', 1)]));
		expect(rows.map((r) => r.tag)).toEqual([null, 'a']);
	});

	it('reads the group parameter out of the key, so --group stays one flag', () => {
		const rows = flattenEvents(
			{
				result: {
					events: {
						events: [
							{
								$workers: {
									cpuTimeMs: 3,
									event: { request: { search: { arm: 'low' } } }
								}
							}
						]
					}
				}
			},
			'arm'
		);
		expect(rows[0]!.tag).toBe('low');
	});
});
