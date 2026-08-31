import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/** what 64-bit zend_long on 32-bit pointers actually buys; run with DRUPFLARE_ABI=long64 */

declare const __DRUPFLARE_ABI__: string;
const ABI = typeof __DRUPFLARE_ABI__ === 'string' ? __DRUPFLARE_ABI__ : '';
const REQUEST_TIMEOUT = 600_000;

const ABI_PROBE = String.raw`<?php
// a 4-byte build warns on the cast below, and a warning on stdout is not JSON
error_reporting(0);
ini_set('display_errors', '0');
$big = 9007199254740993;
echo json_encode([
  'phpIntSize' => PHP_INT_SIZE,
  'phpIntMax' => (string) PHP_INT_MAX,
  'wideLiteral' => (string) $big,
  'wideIsExact' => ($big + 1 - 1) === $big,
  // the cast that wraps an epoch-millisecond value on a 4-byte build
  'modularCast' => (string) ((int) 1787454172276.0),
]);
`;

describe('64-bit zend_long on 32-bit pointers', () => {
	it(
		'reports PHP_INT_SIZE for whichever binary the seam selected',
		async (ctx) => {
			const stub = freshSite();
			const out = await inObject(stub, async (site: ServeDo) => site.runJson(ABI_PROBE));
			console.log(`[long64-abi] ${JSON.stringify({ abi: ABI || 'wasm32', ...out })}`);

			// long64 is the DEFAULT now, so an unset seam is long64 and `wasm32` is the off arm
			if (ABI !== 'wasm32') {
				// the integer width without the pointer width
				expect(out.phpIntSize).toBe(8);
				expect(out.phpIntMax).toBe('9223372036854775807');
				// 2^53+1 is the value a double cannot hold, so it proves a real 64-bit int
				expect(out.wideIsExact).toBe(true);
				expect(out.wideLiteral).toBe('9007199254740993');
				// the modular cast that wraps epoch milliseconds on a 4-byte build
				expect(out.modularCast).toBe('1787454172276');
			} else {
				expect(out.phpIntSize).toBe(4);
				expect(out.modularCast).toBe('747777140');
			}
		},
		REQUEST_TIMEOUT
	);
});
