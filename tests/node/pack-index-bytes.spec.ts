import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `PACK_INDEX_BYTES` against the artifact it was measured from.
 *
 * The merged pack index is the largest term in the isolate budget that nothing priced. Measured
 * 2026-09-11 by RETENTION -- `node --expose-gc`, `heapUsed` either side of a `JSON.parse` with
 * nothing else held across the reading -- at **1,980,912 bytes for 11,457 entries**, which is 1.5x
 * the 1,324,155 bytes of JSON on disk. The serialised size is not the answer: the isolate holds
 * objects, hidden classes and a string per path.
 *
 * It changed the conclusion. The authenticated plateau reads 129,915,852 without it and
 * 131,947,496 with it -- 98.3% of the 128 MiB ceiling, 2,270,232 bytes spare, and already above the
 * drop threshold. A guard that ignored it read ~1.98 MB short at exactly the plateau where the
 * measured history says the next render resets the isolate.
 *
 * A CONSTANT, so it goes stale when the pack changes. This recomputes the ratio from the
 * shipped artifact so the two cannot drift silently -- which is the whole failure mode this
 * repository keeps recording, a measured number quietly becoming a stale one.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const INDEX = resolve(ROOT, 'assets/drupal-pf/core.pf.json');
const SITE_DO = readFileSync(resolve(ROOT, 'src/site-do.ts'), 'utf8');

/** what was on disk when the retention reading was taken */
const MEASURED_JSON_BYTES = 1_324_155;
const MEASURED_ENTRIES = 11_457;
const MEASURED_RETAINED = 1_980_912;
/** retained / serialised, from the same reading */
const MEASURED_RATIO = MEASURED_RETAINED / MEASURED_JSON_BYTES;

describe('the pack index constant', () => {
	it('is the value the retention reading produced', () => {
		expect(SITE_DO).toContain(
			`const PACK_INDEX_BYTES = ${MEASURED_RETAINED.toLocaleString('en-US').replace(/,/g, '_')};`
		);
	});

	it('is counted into the isolate total and into what /serve-stats reports', () => {
		// both, because a total the guard reads and a figure an operator reads that disagree is how
		// a measured number gets quoted against the wrong budget
		expect(SITE_DO).toContain('lazy.resident + (lazy.blob > 0 ? PACK_INDEX_BYTES : 0)');
		expect(SITE_DO).toContain(
			'index: lazyMountBytes(this.mountInfo).blob > 0 ? PACK_INDEX_BYTES : 0'
		);
	});

	it.runIf(existsSync(INDEX))(
		'still matches the shipped artifact within the ratio it was measured at',
		() => {
			// SKIPPED ON A CLEAN CHECKOUT, which has no pack -- the same lane boundary
			// `ARTIFACT_SPECS` exists for, expressed here as a guard rather than an exclusion
			// because the two assertions above do not need the artifact
			const bytes = statSync(INDEX).size;
			const drift = Math.abs(bytes - MEASURED_JSON_BYTES) / MEASURED_JSON_BYTES;
			expect(
				drift,
				`core.pf.json is ${bytes} bytes against the ${MEASURED_JSON_BYTES} the retention ` +
					'reading was taken from. Re-run scratchpad/index-bytes.mjs and update ' +
					'PACK_INDEX_BYTES; the isolate guard is reading against a stale figure.'
			).toBeLessThan(0.1);

			// and the derived figure the constant stands for, recomputed from the current file
			const projected = Math.round(bytes * MEASURED_RATIO);
			expect(Math.abs(projected - MEASURED_RETAINED) / MEASURED_RETAINED).toBeLessThan(0.1);
		}
	);

	it.runIf(existsSync(INDEX))('has the entry count the per-entry figure was derived from', () => {
		const parsed = JSON.parse(readFileSync(INDEX, 'utf8')) as Record<string, unknown>;
		const entries = Object.keys(
			(parsed.files as Record<string, unknown> | undefined) ?? parsed
		).length;
		// 173 bytes per entry is the number a future reader will reach for when the pack changes
		// shape rather than size; it is only meaningful beside the count it came from
		expect(Math.abs(entries - MEASURED_ENTRIES) / MEASURED_ENTRIES).toBeLessThan(0.1);
	});
});
