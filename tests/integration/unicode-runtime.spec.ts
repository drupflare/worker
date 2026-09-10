import { describe, expect, it } from 'vitest';
import { expandInt } from '../../scripts/measure/unicode-corpus';
// imported rather than read: workerd has no filesystem, so `readArtifact()` cannot run here
import corpus from '../fixtures/unicode-corpus.json';
import { freshSite, inObject } from '../helpers/serve-do';

/**
 * `titleExtra`, asserted against the engine that actually uses it.
 *
 * The table lists characters mbstring titlecases that PCRE's `\pL` does not call a letter, so the
 * polyfill's `(\pL)(\pL*+)` word pattern never offers them to its callback. That makes it a
 * property of the PAIR, and the pair that ships is the wasm interpreter's mbstring and the wasm
 * interpreter's PCRE -- NOT the build machine's.
 *
 * `unicode-corpus.spec.ts` used to compare it against a native sweep. When homebrew's pcre2 reached
 * 10.48 on 2026-08-31 that comparison went red, and regenerating to satisfy it deleted U+A7CF and
 * the Medefaidrin range from the shipping table. Both are still needed: measured here, the
 * interpreter answers `\pL` = 0 for each. A build machine cannot answer this question.
 */

const TIMEOUT = 900_000;

/** what the interpreter says about a codepoint: does `\pL` match, and does titlecasing move it */
async function ask(
	codepoints: number[]
): Promise<Record<string, { letter: number; title: number }>> {
	const list = JSON.stringify(codepoints);
	return (await inObject(freshSite(), (site) =>
		site.runJson(
			`<?php
			 $out = [];
			 foreach (json_decode('${list}') as $cp) {
				$ch = mb_chr($cp, 'UTF-8');
				$out[(string) $cp] = [
					'letter' => preg_match('/\\pL/u', $ch),
					'title' => mb_convert_case($ch, MB_CASE_TITLE, 'UTF-8') === $ch ? 0 : 1,
				];
			 }
			 echo json_encode($out);`
		)
	)) as Record<string, { letter: number; title: number }>;
}

describe('the titlecase escape list belongs to the shipping interpreter', () => {
	it(
		'lists only characters this PCRE does not call a letter',
		async () => {
			const listed = [...expandInt(corpus.titleExtra as [number, number, number][]).keys()];
			expect(listed.length, 'the artifact carries no titleExtra at all').toBeGreaterThan(0);

			// a sample rather than all of them: one `_run()` per batch, and the property is uniform
			const sample = listed.filter((_, i) => i % Math.ceil(listed.length / 24) === 0);
			const answers = await ask(sample);

			for (const cp of sample) {
				const seen = answers[String(cp)];
				expect(
					seen,
					`the interpreter said nothing about U+${cp.toString(16)}`
				).toBeDefined();
				// both halves, because an entry earns its place only when BOTH hold: the polyfill
				// skips it (not a letter) AND mbstring would have changed it
				expect(
					seen?.letter,
					`U+${cp.toString(16)} IS a letter here, so the polyfill already reaches it`
				).toBe(0);
				expect(
					seen?.title,
					`U+${cp.toString(16)} does not titlecase, so it does not belong in the list`
				).toBe(1);
			}
		},
		TIMEOUT
	);

	it(
		'still needs the two ranges a newer build-machine PCRE would have dropped',
		async () => {
			// the exact regression: U+A7CF and the head of Medefaidrin. pcre2 10.48 calls both
			// letters, the interpreter does not, and a table regenerated natively loses them
			const answers = await ask([0xa7cf, 0x16ebb]);
			expect(answers['42959']?.letter).toBe(0);
			expect(answers['93883']?.letter).toBe(0);

			const listed = expandInt(corpus.titleExtra as [number, number, number][]);
			expect(listed.has(0xa7cf), 'U+A7CF left the shipping table').toBe(true);
			expect(listed.has(0x16ebb), 'Medefaidrin left the shipping table').toBe(true);
		},
		TIMEOUT
	);
});
